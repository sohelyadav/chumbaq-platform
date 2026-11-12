import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository, In, LessThan } from 'typeorm';
import { MixpanelCohortEntity } from '../../modules/mixpanel-cohorts/entities/mixpanel-cohort.entity';
import {
  QUEUE_COHORT_SYNC,
  JOB_SYNC_COHORT,
  CohortSyncJobData,
} from '../queue.constants';
import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';

/**
 * How long a cohort may sit in `syncing` before the scheduler treats it as
 * abandoned and re-enqueues it. A worker killed mid-sync leaves the row in
 * `syncing` with nothing left to move it on, so without this bound that cohort
 * would never sync again. The window has to comfortably exceed a legitimate
 * Mixpanel import so a genuinely in-flight sync is never enqueued twice.
 */
const STALE_SYNCING_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class CohortSyncScheduler {
  private readonly logger = new Logger(CohortSyncScheduler.name);

  constructor(
    @InjectRepository(MixpanelCohortEntity)
    private readonly cohortRepository: Repository<MixpanelCohortEntity>,
    @InjectQueue(QUEUE_COHORT_SYNC)
    private readonly cohortQueue: Queue<CohortSyncJobData>,
    private readonly suspension: ProjectSuspensionService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleHourlySync(): Promise<void> {
    const count = await this.enqueueDueCohorts();
    this.logger.log(`Enqueued ${count} cohort sync job(s)`);
  }

  /**
   * Split out from the cron handler so it can be tested and triggered manually.
   *
   * Jobs are added with BullMQ's generated id, deliberately: a deterministic
   * `jobId` is dropped by `handleDuplicatedJob` for as long as the previous
   * job's hash exists in Redis, and `removeOnComplete: 100` keeps a *completed*
   * job's hash alive — so with few enough cohorts every later tick was silently
   * discarded and the sync self-disabled after hour one. The status filter
   * below already excludes cohorts that are in flight, which is the job the
   * jobId was doing badly; with `concurrency: 1` on the processor, a rare
   * double-enqueue costs one redundant sync rather than a stampede.
   */
  async enqueueDueCohorts(): Promise<number> {
    const staleBefore = new Date(Date.now() - STALE_SYNCING_MS);

    const cohorts = await this.cohortRepository.find({
      where: [
        { status: In(['synced', 'error']) },
        // Stranded mid-sync: no worker owns it any more, so re-enqueue it.
        { status: 'syncing', updatedAt: LessThan(staleBefore) },
      ],
      select: ['id', 'projectId'],
    });

    // A sync calls Mixpanel with the tenant's own credentials, against their
    // quota, which the tenant can see. Skipping loses nothing: the cohort stays
    // due, so the first tick after reactivation refreshes it.
    const suspended = await this.suspension.suspendedProjectIds();
    const syncable = cohorts.filter((cohort) => !suspended.has(cohort.projectId));

    for (const cohort of syncable) {
      await this.cohortQueue.add(JOB_SYNC_COHORT, { cohortId: cohort.id });
    }

    return syncable.length;
  }
}

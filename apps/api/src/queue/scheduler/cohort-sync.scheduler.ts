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

/**
 * Cohort syncs queued per project per hourly tick, stalest first. The rest stay due and
 * go first next tick. With the per-sync deadline this bounds how much of the shared
 * lane one tenant takes in an hour, whatever number of cohorts it imports.
 */
export const COHORT_SYNCS_PER_PROJECT_PER_TICK = 3;

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
   * jobId was doing badly; a rare double-enqueue is refused by the sync's own
   * claim (a cohort already syncing is not synced again).
   */
  async enqueueDueCohorts(): Promise<number> {
    const staleBefore = new Date(Date.now() - STALE_SYNCING_MS);

    const cohorts = await this.cohortRepository.find({
      where: [
        { status: In(['synced', 'error']) },
        // Stranded mid-sync: no worker owns it any more, so re-enqueue it.
        { status: 'syncing', updatedAt: LessThan(staleBefore) },
      ],
      select: ['id', 'projectId', 'lastSyncedAt'],
    });

    // A sync calls Mixpanel with the tenant's own credentials, against their
    // quota, which the tenant can see. Skipping loses nothing: the cohort stays
    // due, so the first tick after reactivation refreshes it.
    const suspended = await this.suspension.suspendedProjectIds();
    const syncable = cohorts.filter((cohort) => !suspended.has(cohort.projectId));

    // Not for a cohort that already has a job waiting or running. One lane serves every
    // tenant, so while one large cohort holds it, every other cohort's job waits, and
    // each hour would otherwise add another copy of each (a live sync never touches
    // updated_at, so after two hours it also looks stranded).
    const queued = new Set(
      (await this.cohortQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized']))
        .map((job) => job?.data?.cohortId)
        .filter((id): id is string => typeof id === 'string'),
    );
    // A project's jobs still waiting from earlier ticks count against its allowance, so a
    // backed-up queue never holds more than the allowance of any one project's syncs.
    const waiting = new Map<string, number>();
    for (const cohort of syncable) {
      if (queued.has(cohort.id)) waiting.set(cohort.projectId, (waiting.get(cohort.projectId) ?? 0) + 1);
    }
    const due = interleaveByProject(
      syncable.filter((cohort) => !queued.has(cohort.id)),
      (projectId) => COHORT_SYNCS_PER_PROJECT_PER_TICK - (waiting.get(projectId) ?? 0),
    );

    // Jobs run in the order added, so one project's cohorts never queue as a block.
    for (const cohort of due) {
      await this.cohortQueue.add(JOB_SYNC_COHORT, { cohortId: cohort.id });
    }

    return due.length;
  }
}

/**
 * Each project's cohorts stalest first (never synced before any), at most
 * `allowance(projectId)` of them, taken one per project in turn.
 */
export function interleaveByProject<T extends { projectId: string; lastSyncedAt?: Date | null }>(
  cohorts: T[],
  allowance: (projectId: string) => number,
): T[] {
  const byProject = new Map<string, T[]>();
  for (const cohort of cohorts) {
    const list = byProject.get(cohort.projectId) ?? [];
    list.push(cohort);
    byProject.set(cohort.projectId, list);
  }
  const lists = Array.from(byProject.entries()).map(([projectId, list]) =>
    list
      .sort((a, b) => (a.lastSyncedAt?.getTime() ?? -Infinity) - (b.lastSyncedAt?.getTime() ?? -Infinity))
      .slice(0, Math.max(0, allowance(projectId))),
  );
  const out: T[] = [];
  const rounds = Math.max(0, ...lists.map((list) => list.length));
  for (let round = 0; round < rounds; round++) {
    for (const list of lists) {
      if (round < list.length) out.push(list[round]);
    }
  }
  return out;
}

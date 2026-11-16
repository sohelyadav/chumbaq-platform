import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { MixpanelCohortEntity } from '../../modules/mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { MixpanelCohortSyncService } from '../../modules/mixpanel-cohorts/mixpanel-cohort-sync.service';
import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';
import { QUEUE_COHORT_SYNC, CohortSyncJobData } from '../queue.constants';

/**
 * Two slots for every tenant's syncs. Each sync is bounded (cohort-sync-limits.ts) and
 * the scheduler interleaves projects, so one tenant's cohorts cannot hold the lane for long.
 */
@Processor(QUEUE_COHORT_SYNC, { concurrency: 2 })
export class CohortSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(CohortSyncProcessor.name);

  constructor(
    @InjectRepository(MixpanelCohortEntity)
    private readonly cohortRepository: Repository<MixpanelCohortEntity>,
    private readonly syncService: MixpanelCohortSyncService,
    private readonly suspension: ProjectSuspensionService,
  ) {
    super();
  }

  async process(job: Job<CohortSyncJobData>): Promise<void> {
    const cohort = await this.cohortRepository.findOne({
      where: { id: job.data.cohortId },
    });

    if (!cohort) {
      throw new UnrecoverableError(`Cohort ${job.data.cohortId} no longer exists`);
    }

    // The scheduler skips suspended tenants, but a job queued just before the
    // suspension would still call Mixpanel with their credentials.
    if (await this.suspension.isSuspended(cohort.projectId)) {
      this.logger.log(`Skipping cohort ${cohort.id}: tenant is suspended`);
      return;
    }

    const outcome = await this.syncService.syncForJob(cohort.projectId, cohort.mixpanelCohortId);
    if (outcome.kind === 'busy') {
      this.logger.log(`Cohort ${cohort.id} is already syncing`);
      return;
    }
    if (outcome.kind === 'failed') {
      // A cohort past the member cap or the deadline would fail the same way again, and
      // each try holds a slot every tenant shares; the next hourly tick tries it anyway.
      if (!outcome.retryable) throw new UnrecoverableError(outcome.message);
      throw new Error(outcome.message);
    }

    this.logger.log(`Re-synced cohort ${cohort.id} (${cohort.name})`);
  }
}

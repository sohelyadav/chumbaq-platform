import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { MixpanelCohortEntity } from '../../modules/mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { MixpanelCohortSyncService } from '../../modules/mixpanel-cohorts/mixpanel-cohort-sync.service';
import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';
import { QUEUE_COHORT_SYNC, CohortSyncJobData } from '../queue.constants';

@Processor(QUEUE_COHORT_SYNC, { concurrency: 1 })
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

    // awaitSync: true makes the queue job actually wait for the sync rather
    // than reporting success the instant it's kicked off (importCohort's
    // default fire-and-forget behaviour, kept for the HTTP controller path).
    await this.syncService.importCohort(cohort.projectId, cohort.mixpanelCohortId, {
      awaitSync: true,
    });

    // importCohort awaits runSync but swallows its errors internally (it sets
    // status='error' rather than rejecting), so re-read the row to see the
    // real outcome and throw a retryable error on failure — otherwise BullMQ
    // would never retry a genuine sync failure.
    const synced = await this.cohortRepository.findOne({ where: { id: cohort.id } });
    if (synced?.status === 'error') {
      throw new Error(synced.errorMessage ?? `Sync failed for cohort ${cohort.id}`);
    }

    this.logger.log(`Re-synced cohort ${cohort.id} (${cohort.name})`);
  }
}

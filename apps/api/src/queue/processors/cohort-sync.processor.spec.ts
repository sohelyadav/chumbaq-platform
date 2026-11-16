import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { CohortSyncProcessor } from './cohort-sync.processor';
import { MixpanelCohortEntity } from '../../modules/mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { MixpanelCohortSyncService } from '../../modules/mixpanel-cohorts/mixpanel-cohort-sync.service';
import { CohortSyncJobData } from '../queue.constants';
import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';

describe('CohortSyncProcessor', () => {
  let processor: CohortSyncProcessor;

  const cohortRepository = { findOne: jest.fn() };
  const syncService = { syncForJob: jest.fn() };
  const suspension = { isSuspended: jest.fn() };

  const makeJob = (data: CohortSyncJobData) =>
    ({ data }) as unknown as Job<CohortSyncJobData>;

  const makeCohort = (
    overrides: Partial<MixpanelCohortEntity> = {},
  ): MixpanelCohortEntity =>
    ({
      id: 'cohort-1',
      projectId: 'proj-1',
      mixpanelCohortId: 42,
      name: 'Alpha Cohort',
      status: 'syncing',
      errorMessage: null,
      ...overrides,
    }) as MixpanelCohortEntity;

  beforeEach(async () => {
    jest.clearAllMocks();
    suspension.isSuspended.mockResolvedValue(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CohortSyncProcessor,
        { provide: getRepositoryToken(MixpanelCohortEntity), useValue: cohortRepository },
        { provide: MixpanelCohortSyncService, useValue: syncService },
        { provide: ProjectSuspensionService, useValue: suspension },
      ],
    }).compile();

    processor = module.get<CohortSyncProcessor>(CohortSyncProcessor);
  });

  it('throws UnrecoverableError when the cohort no longer exists', async () => {
    cohortRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      processor.process(makeJob({ cohortId: 'gone' })),
    ).rejects.toThrow(UnrecoverableError);

    expect(syncService.syncForJob).not.toHaveBeenCalled();
  });

  it('waits for the sync and does not throw when it synced', async () => {
    cohortRepository.findOne.mockResolvedValueOnce(makeCohort());
    syncService.syncForJob.mockResolvedValueOnce({ kind: 'synced' });

    await expect(processor.process(makeJob({ cohortId: 'cohort-1' }))).resolves.toBeUndefined();

    expect(syncService.syncForJob).toHaveBeenCalledWith('proj-1', 42);
  });

  it('does nothing when another sync of the cohort holds it', async () => {
    cohortRepository.findOne.mockResolvedValueOnce(makeCohort());
    syncService.syncForJob.mockResolvedValueOnce({ kind: 'busy' });

    await expect(processor.process(makeJob({ cohortId: 'cohort-1' }))).resolves.toBeUndefined();
  });

  it('throws a retryable (non-Unrecoverable) error carrying the message when the sync can go differently next time', async () => {
    cohortRepository.findOne.mockResolvedValueOnce(makeCohort());
    syncService.syncForJob.mockResolvedValueOnce({ kind: 'failed', message: 'Mixpanel 503', retryable: true });

    let caught: unknown;
    try {
      await processor.process(makeJob({ cohortId: 'cohort-1' }));
    } catch (err) {
      caught = err;
    }

    // Must be an ordinary (retryable) Error, not UnrecoverableError — a sync
    // failure like a Mixpanel 5xx or network blip is exactly what BullMQ's
    // retry/backoff should get a chance at.
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnrecoverableError);
    expect((caught as Error).message).toBe('Mixpanel 503');
  });

  it('does not retry a sync that hit the member cap or the deadline: each try holds a shared slot', async () => {
    cohortRepository.findOne.mockResolvedValueOnce(makeCohort());
    syncService.syncForJob.mockResolvedValueOnce({ kind: 'failed', message: 'too large', retryable: false });

    await expect(processor.process(makeJob({ cohortId: 'cohort-1' }))).rejects.toThrow(UnrecoverableError);
  });

  it('does not call Mixpanel for a job queued before its tenant was suspended', async () => {
    cohortRepository.findOne.mockResolvedValue(makeCohort());
    suspension.isSuspended.mockResolvedValue(true);

    await processor.process(makeJob({ cohortId: 'cohort-1' } as CohortSyncJobData));

    expect(suspension.isSuspended).toHaveBeenCalledWith('proj-1');
    expect(syncService.syncForJob).not.toHaveBeenCalled();
  });
});

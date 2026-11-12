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
  const syncService = { importCohort: jest.fn() };
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

    expect(syncService.importCohort).not.toHaveBeenCalled();
  });

  it('awaits the sync to completion and does not throw when it lands in status "synced"', async () => {
    const cohort = makeCohort();
    cohortRepository.findOne
      .mockResolvedValueOnce(cohort) // initial lookup
      .mockResolvedValueOnce({ ...cohort, status: 'synced' }); // re-read after sync
    syncService.importCohort.mockResolvedValueOnce(cohort);

    await expect(processor.process(makeJob({ cohortId: 'cohort-1' }))).resolves.toBeUndefined();

    expect(syncService.importCohort).toHaveBeenCalledWith('proj-1', 42, { awaitSync: true });
    expect(cohortRepository.findOne).toHaveBeenCalledTimes(2);
  });

  it('throws a retryable (non-Unrecoverable) error carrying the message when the cohort lands in status "error"', async () => {
    const cohort = makeCohort();
    cohortRepository.findOne
      .mockResolvedValueOnce(cohort) // initial lookup
      .mockResolvedValueOnce({ ...cohort, status: 'error', errorMessage: 'Mixpanel 503' }); // re-read
    syncService.importCohort.mockResolvedValueOnce(cohort);

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

  it('does not call Mixpanel for a job queued before its tenant was suspended', async () => {
    cohortRepository.findOne.mockResolvedValue(makeCohort());
    suspension.isSuspended.mockResolvedValue(true);

    await processor.process(makeJob({ cohortId: 'cohort-1' } as CohortSyncJobData));

    expect(suspension.isSuspended).toHaveBeenCalledWith('proj-1');
    expect(syncService.importCohort).not.toHaveBeenCalled();
  });
});

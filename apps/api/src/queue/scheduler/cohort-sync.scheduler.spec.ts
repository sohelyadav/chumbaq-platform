import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { In, FindOperator } from 'typeorm';
import { CohortSyncScheduler } from './cohort-sync.scheduler';
import { MixpanelCohortEntity } from '../../modules/mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { QUEUE_COHORT_SYNC } from '../queue.constants';

const HOUR_MS = 60 * 60 * 1000;

describe('CohortSyncScheduler', () => {
  let scheduler: CohortSyncScheduler;

  const cohortRepo = { find: jest.fn() };
  const cohortQueue = { add: jest.fn() };
  let suspendedProjects = new Set<string>();
  const suspension = { suspendedProjectIds: jest.fn(async () => suspendedProjects) };

  beforeEach(async () => {
    jest.clearAllMocks();
    suspendedProjects = new Set<string>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CohortSyncScheduler,
        { provide: getRepositoryToken(MixpanelCohortEntity), useValue: cohortRepo },
        { provide: getQueueToken(QUEUE_COHORT_SYNC), useValue: cohortQueue },
        { provide: ProjectSuspensionService, useValue: suspension },
      ],
    }).compile();

    scheduler = module.get<CohortSyncScheduler>(CohortSyncScheduler);
  });

  it('enqueues one job per cohort and reports the count', async () => {
    cohortRepo.find.mockResolvedValueOnce([{ id: 'c-1' }, { id: 'c-2' }]);

    await expect(scheduler.enqueueDueCohorts()).resolves.toBe(2);

    expect(cohortQueue.add).toHaveBeenCalledTimes(2);
    expect(cohortQueue.add).toHaveBeenCalledWith('sync-cohort', { cohortId: 'c-1' });
    expect(cohortQueue.add).toHaveBeenCalledWith('sync-cohort', { cohortId: 'c-2' });
  });

  it('does not call Mixpanel for a suspended tenant, and does for everyone else', async () => {
    suspendedProjects = new Set(['suspended']);
    cohortRepo.find.mockResolvedValueOnce([
      { id: 'c-1', projectId: 'suspended' },
      { id: 'c-2', projectId: 'active' },
    ]);

    await expect(scheduler.enqueueDueCohorts()).resolves.toBe(1);

    expect(cohortQueue.add).toHaveBeenCalledTimes(1);
    expect(cohortQueue.add).toHaveBeenCalledWith('sync-cohort', { cohortId: 'c-2' });
  });

  it('passes no custom jobId, so a completed job cannot block the next tick', async () => {
    cohortRepo.find.mockResolvedValueOnce([{ id: 'c-1' }]);

    await scheduler.enqueueDueCohorts();

    // A deterministic jobId is dropped by BullMQ's handleDuplicatedJob for as
    // long as the previous job's hash survives, and removeOnComplete:100 keeps
    // a completed job's hash alive — which permanently disabled the schedule.
    expect(cohortQueue.add).toHaveBeenCalledWith('sync-cohort', { cohortId: 'c-1' });
    expect(cohortQueue.add.mock.calls[0]).toHaveLength(2);
  });

  it('enqueues the same cohort again on a second consecutive run', async () => {
    cohortRepo.find
      .mockResolvedValueOnce([{ id: 'c-1' }])
      .mockResolvedValueOnce([{ id: 'c-1' }]);

    await scheduler.enqueueDueCohorts();
    await scheduler.enqueueDueCohorts();

    expect(cohortQueue.add).toHaveBeenCalledTimes(2);
    expect(cohortQueue.add).toHaveBeenNthCalledWith(1, 'sync-cohort', { cohortId: 'c-1' });
    expect(cohortQueue.add).toHaveBeenNthCalledWith(2, 'sync-cohort', { cohortId: 'c-1' });
  });

  it('enqueues nothing when there are no cohorts', async () => {
    cohortRepo.find.mockResolvedValueOnce([]);

    await expect(scheduler.enqueueDueCohorts()).resolves.toBe(0);
    expect(cohortQueue.add).not.toHaveBeenCalled();
  });

  describe('due-cohort selection', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(now);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('selects settled cohorts, plus syncing ones stranded past the staleness bound', async () => {
      cohortRepo.find.mockResolvedValueOnce([]);

      await scheduler.enqueueDueCohorts();

      const where = cohortRepo.find.mock.calls[0][0].where as Array<
        Record<string, unknown>
      >;
      expect(where).toHaveLength(2);
      expect(where[0]).toEqual({ status: In(['synced', 'error']) });
      expect(where[1].status).toBe('syncing');

      const updatedAt = where[1].updatedAt as FindOperator<Date>;
      expect(updatedAt.type).toBe('lessThan');
      // The bound is two hours of no progress.
      expect(updatedAt.value.getTime()).toBe(now.getTime() - 2 * HOUR_MS);
    });

    it('places the bound so a stale syncing cohort qualifies and a fresh one does not', async () => {
      cohortRepo.find.mockResolvedValueOnce([]);

      await scheduler.enqueueDueCohorts();

      const where = cohortRepo.find.mock.calls[0][0].where as Array<
        Record<string, unknown>
      >;
      const cutoff = (where[1].updatedAt as FindOperator<Date>).value;

      const strandedThreeHoursAgo = new Date(now.getTime() - 3 * HOUR_MS);
      const activeFiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

      expect(strandedThreeHoursAgo.getTime()).toBeLessThan(cutoff.getTime());
      expect(activeFiveMinutesAgo.getTime()).toBeGreaterThan(cutoff.getTime());
    });
  });
});

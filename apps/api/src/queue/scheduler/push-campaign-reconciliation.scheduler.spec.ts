import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { In, FindOperator } from 'typeorm';
import { PushCampaignReconciliationScheduler } from './push-campaign-reconciliation.scheduler';
import { PushNotificationLogEntity } from '../../modules/push-notifications/entities/push-notification-log.entity';
import { PushCampaignStateService } from '../../modules/push-notifications/push-campaign-state.service';
import { QUEUE_PUSH_CAMPAIGN } from '../queue.constants';

describe('PushCampaignReconciliationScheduler', () => {
  let scheduler: PushCampaignReconciliationScheduler;

  const logRepo = { find: jest.fn() };
  const pushQueue = { getJob: jest.fn() };
  const state = { markFailed: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    state.markFailed.mockResolvedValue('failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushCampaignReconciliationScheduler,
        { provide: getRepositoryToken(PushNotificationLogEntity), useValue: logRepo },
        { provide: getQueueToken(QUEUE_PUSH_CAMPAIGN), useValue: pushQueue },
        { provide: PushCampaignStateService, useValue: state },
      ],
    }).compile();

    scheduler = module.get<PushCampaignReconciliationScheduler>(
      PushCampaignReconciliationScheduler,
    );
  });

  it('ends a campaign whose delivery job no longer exists', async () => {
    logRepo.find.mockResolvedValueOnce([{ id: 'log-1' }]);
    pushQueue.getJob.mockResolvedValueOnce(undefined);

    await expect(scheduler.reconcileStrandedCampaigns()).resolves.toBe(1);

    // The job id is the log id, so this is an exact lookup.
    expect(pushQueue.getJob).toHaveBeenCalledWith('log-1');
    expect(state.markFailed).toHaveBeenCalledTimes(1);
    const [logId, message] = state.markFailed.mock.calls[0];
    expect(logId).toBe('log-1');
    expect(message).toMatch(/abandoned/i);
  });

  it('leaves a campaign alone while a job still exists for it', async () => {
    logRepo.find.mockResolvedValueOnce([{ id: 'log-1' }]);
    // Waiting, delayed between retries, or active — BullMQ still owns it.
    pushQueue.getJob.mockResolvedValueOnce({ id: 'log-1' });

    await expect(scheduler.reconcileStrandedCampaigns()).resolves.toBe(0);
    expect(state.markFailed).not.toHaveBeenCalled();
  });

  it('sweeps a campaign whose delivery job exists but already finished', async () => {
    logRepo.find.mockResolvedValueOnce([{ id: 'log-1' }]);
    // removeOnFail: 500 / removeOnComplete: 100 retain the hash after the job
    // reaches a terminal state, so a hash existing is not proof BullMQ is
    // still working the campaign — e.g. a repeat stall under
    // maxStalledCount: 1 fails the job outright and leaves its hash behind.
    pushQueue.getJob.mockResolvedValueOnce({ id: 'log-1', finishedOn: Date.now() });

    await expect(scheduler.reconcileStrandedCampaigns()).resolves.toBe(1);
    expect(state.markFailed).toHaveBeenCalledTimes(1);
    expect(state.markFailed.mock.calls[0][0]).toBe('log-1');
  });

  it('sweeps only the jobless rows in a mixed batch', async () => {
    logRepo.find.mockResolvedValueOnce([
      { id: 'live' },
      { id: 'stranded' },
    ]);
    pushQueue.getJob
      .mockResolvedValueOnce({ id: 'live' })
      .mockResolvedValueOnce(null);

    await expect(scheduler.reconcileStrandedCampaigns()).resolves.toBe(1);
    expect(state.markFailed).toHaveBeenCalledTimes(1);
    expect(state.markFailed.mock.calls[0][0]).toBe('stranded');
  });

  it('does nothing when no campaign is stale', async () => {
    logRepo.find.mockResolvedValueOnce([]);

    await expect(scheduler.reconcileStrandedCampaigns()).resolves.toBe(0);
    expect(pushQueue.getJob).not.toHaveBeenCalled();
    expect(state.markFailed).not.toHaveBeenCalled();
  });

  describe('candidate selection', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(now);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('considers only non-terminal campaigns that have gone quiet', async () => {
      logRepo.find.mockResolvedValueOnce([]);

      await scheduler.reconcileStrandedCampaigns();

      const where = logRepo.find.mock.calls[0][0].where as Record<string, unknown>;
      expect(where.status).toEqual(In(['queued', 'sending']));

      const updatedAt = where.updatedAt as FindOperator<Date>;
      expect(updatedAt.type).toBe('lessThan');
      // Fifteen minutes without a checkpoint.
      expect(updatedAt.value.getTime()).toBe(now.getTime() - 15 * 60 * 1000);
    });

    it('excludes a campaign that checkpointed recently', async () => {
      logRepo.find.mockResolvedValueOnce([]);

      await scheduler.reconcileStrandedCampaigns();

      const where = logRepo.find.mock.calls[0][0].where as Record<string, unknown>;
      const cutoff = (where.updatedAt as FindOperator<Date>).value;

      const progressingOneMinuteAgo = new Date(now.getTime() - 60 * 1000);
      const silentForAnHour = new Date(now.getTime() - 60 * 60 * 1000);

      expect(progressingOneMinuteAgo.getTime()).toBeGreaterThan(cutoff.getTime());
      expect(silentForAnHour.getTime()).toBeLessThan(cutoff.getTime());
    });
  });
});

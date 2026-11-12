import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { APPEND_FAILURE_DETAILS, PushCampaignStateService } from './push-campaign-state.service';
import { PushNotificationEventEntity } from './entities/push-notification-event.entity';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import { MAX_FAILURE_DETAILS } from '../../queue/queue.constants';

describe('PushCampaignStateService', () => {
  let service: PushCampaignStateService;

  const eventRepo = { createQueryBuilder: jest.fn() };
  const logRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    setParameters: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    logRepo.createQueryBuilder.mockReturnValue(queryBuilder);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushCampaignStateService,
        { provide: getRepositoryToken(PushNotificationLogEntity), useValue: logRepo },
        { provide: getRepositoryToken(PushNotificationEventEntity), useValue: eventRepo },
      ],
    }).compile();

    service = module.get<PushCampaignStateService>(PushCampaignStateService);
  });

  describe('markSending', () => {
    it('sets status to sending', async () => {
      await service.markSending('log-1');

      expect(logRepo.update).toHaveBeenCalledWith('log-1', { status: 'sending' });
    });
  });

  describe('recordBatch', () => {
    it('applies counters and failure details as SQL against the live row, reading nothing first', async () => {
      await service.recordBatch('log-1', {
        successCount: 5,
        failureCount: 1,
        failures: [{ token: 't99', error: 'UNREGISTERED' }],
        lastTokenId: 'tok-500',
        processedInBatch: 6,
      });

      expect(queryBuilder.update).toHaveBeenCalledWith(PushNotificationLogEntity);
      // Never a value computed from an earlier read: concurrent writers, and a
      // person erasure scrubbing failure_details, must not be overwritten.
      expect(logRepo.findOne).not.toHaveBeenCalled();
      const setPayload = queryBuilder.set.mock.calls[0][0];
      expect(setPayload.successCount()).toBe('success_count + :successDelta');
      expect(setPayload.failureCount()).toBe('failure_count + :failureDelta');
      expect(setPayload.processedTokens()).toBe('processed_tokens + :processedDelta');
      expect(setPayload.failureDetails()).toBe(APPEND_FAILURE_DETAILS);
      expect(setPayload.lastTokenId).toBe('tok-500');

      expect(queryBuilder.setParameters).toHaveBeenCalledWith({
        successDelta: 5,
        failureDelta: 1,
        processedDelta: 6,
        newFailures: JSON.stringify([{ token: 't99', error: 'UNREGISTERED' }]),
        maxFailures: MAX_FAILURE_DETAILS,
      });
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', { id: 'log-1' });
      expect(queryBuilder.execute).toHaveBeenCalled();
    });

    it('binds the exact failure delta however many details the cap keeps', async () => {
      await service.recordBatch('log-1', {
        successCount: 0,
        failureCount: MAX_FAILURE_DETAILS + 10,
        failures: Array.from({ length: MAX_FAILURE_DETAILS + 10 }, (_, i) => ({ token: `new-${i}`, error: 'boom' })),
        lastTokenId: 'tok-900',
        processedInBatch: 10,
      });
      const params = queryBuilder.setParameters.mock.calls[0][0];
      expect(params.failureDelta).toBe(MAX_FAILURE_DETAILS + 10);
      expect(JSON.parse(params.newFailures)).toHaveLength(MAX_FAILURE_DETAILS);
    });
  });

  describe('finalize', () => {
    it('returns sent when there are no failures', async () => {
      logRepo.findOne.mockResolvedValueOnce({ successCount: 10, failureCount: 0 });

      await expect(service.finalize('log-1')).resolves.toBe('sent');
      expect(logRepo.update).toHaveBeenCalledWith(
        'log-1',
        expect.objectContaining({ status: 'sent' }),
      );
    });

    it('returns failed when nothing succeeded', async () => {
      logRepo.findOne.mockResolvedValueOnce({ successCount: 0, failureCount: 7 });

      await expect(service.finalize('log-1')).resolves.toBe('failed');
    });

    it('returns partial on a mix', async () => {
      logRepo.findOne.mockResolvedValueOnce({ successCount: 3, failureCount: 4 });

      await expect(service.finalize('log-1')).resolves.toBe('partial');
    });

    it('returns failed, not sent, when the campaign delivered nothing at all', async () => {
      // Every token deactivated between enqueue and dispatch: page 1 comes back
      // empty, the walk ends, and no failure is ever recorded. Reading that as
      // 'sent' reports 0/N delivered as a success.
      logRepo.findOne.mockResolvedValueOnce({ successCount: 0, failureCount: 0 });

      await expect(service.finalize('log-1')).resolves.toBe('failed');

      const [, payload] = logRepo.update.mock.calls[0];
      expect(payload.status).toBe('failed');
      expect(payload.errorMessage).toMatch(/Nothing was delivered/);
    });

    it('names unconfigured channels, not expired tokens, when the audience was not empty', async () => {
      // The failure that prompted this: a project with 26 active FCM tokens and
      // no credentials. Nothing is selectable, page 1 is empty, and the old
      // single message told the operator their tokens had run out — a
      // confident, checkable, wrong statement that sends them to the one place
      // the problem is not.
      logRepo.findOne.mockResolvedValueOnce({
        successCount: 0,
        failureCount: 0,
        totalTokens: 26,
        processedTokens: 0,
      });

      await service.finalize('log-1');

      const [, payload] = logRepo.update.mock.calls[0];
      expect(payload.errorMessage).toMatch(/26 target token/);
      expect(payload.errorMessage).toMatch(/configured channel/);
      expect(payload.errorMessage).not.toMatch(/no active push tokens remained/);
    });

    it('still blames missing tokens when the audience really was empty', async () => {
      // The original case this message was written for, which must not regress:
      // every token deactivated between enqueue and dispatch, so there was
      // genuinely nothing to send to.
      logRepo.findOne.mockResolvedValueOnce({
        successCount: 0,
        failureCount: 0,
        totalTokens: 0,
        processedTokens: 0,
      });

      await service.finalize('log-1');

      const [, payload] = logRepo.update.mock.calls[0];
      expect(payload.errorMessage).toMatch(/no active push tokens remained/);
    });

    it('does not blame channels for a campaign that got partway and then stalled', async () => {
      // processedTokens > 0 means tokens were selectable, so whatever went
      // wrong is not a credential gap. Guards the predicate from being
      // loosened to "audience was not empty" alone.
      logRepo.findOne.mockResolvedValueOnce({
        successCount: 0,
        failureCount: 0,
        totalTokens: 26,
        processedTokens: 10,
      });

      await service.finalize('log-1');

      const [, payload] = logRepo.update.mock.calls[0];
      expect(payload.errorMessage).toMatch(/no active push tokens remained/);
    });

    it('leaves errorMessage untouched on any outcome that did deliver', async () => {
      logRepo.findOne.mockResolvedValueOnce({ successCount: 3, failureCount: 4 });

      await service.finalize('log-1');

      const [, payload] = logRepo.update.mock.calls[0];
      expect(payload).not.toHaveProperty('errorMessage');
    });
  });

  describe('markFailed', () => {
    it('records the error and a terminal status', async () => {
      logRepo.findOne.mockResolvedValueOnce({ successCount: 0, failureCount: 12 });

      await expect(
        service.markFailed('log-1', 'FCM credentials rejected'),
      ).resolves.toBe('failed');

      expect(logRepo.update).toHaveBeenCalledWith(
        'log-1',
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'FCM credentials rejected',
        }),
      );
    });

    it('records partial when the campaign had already delivered to some tokens', async () => {
      // 900 of 1000 delivered before the job died is not a failed campaign.
      logRepo.findOne.mockResolvedValueOnce({ successCount: 900, failureCount: 0 });

      await expect(
        service.markFailed('log-1', 'job stalled more than allowable limit'),
      ).resolves.toBe('partial');

      expect(logRepo.update).toHaveBeenCalledWith(
        'log-1',
        expect.objectContaining({
          status: 'partial',
          errorMessage: 'job stalled more than allowable limit',
        }),
      );
    });

    it('falls back to failed when the row cannot be read', async () => {
      logRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.markFailed('log-1', 'gone')).resolves.toBe('failed');
    });
  });
});

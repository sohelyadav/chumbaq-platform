import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { MixpanelCampaignService } from './mixpanel-campaign.service';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { PushTokenEntity } from '../push-tokens/entities/push-token.entity';
import { PushNotificationsService } from '../push-notifications/push-notifications.service';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { PushCohortDto } from './dto/push-cohort.dto';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { MessageDeliveryService } from '../in-app-messages/message-delivery.service';

import { TrackingConsentService } from '../consent/tracking-consent.service';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { InAppMessagesService } from '../in-app-messages/in-app-messages.service';

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

/** Nobody is do-not-track unless a test says so. */
const trackingConsent = {
  isDoNotTrack: jest.fn(async (_subject: unknown) => false),
  withoutDoNotTrack: jest.fn(async (_projectId: string, ids: string[]) => ids),
  recordDrop: jest.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeMember(
  deviceIdentityId: string | null,
): Pick<MixpanelCohortMemberEntity, 'deviceIdentityId'> {
  return { deviceIdentityId };
}

function makePushToken(
  deviceIdentityId: string,
  token = 'fcm-token-abc',
): Pick<PushTokenEntity, 'token' | 'deviceIdentityId'> {
  return { token, deviceIdentityId };
}

function makeLog(overrides: Partial<PushNotificationLogEntity> = {}): PushNotificationLogEntity {
  return {
    id: 'log-uuid-1',
    projectId: 'proj-1',
    successCount: 5,
    failureCount: 0,
    ...overrides,
  } as PushNotificationLogEntity;
}

function makeMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    remove: jest.fn(),
    update: jest.fn(),
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

function makeDto(overrides: Partial<PushCohortDto> = {}): PushCohortDto {
  return {
    title: 'Hello World',
    body: 'Check this out',
    platforms: ['android', 'ios'],
    ...overrides,
  } as PushCohortDto;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('MixpanelCampaignService', () => {
  let service: MixpanelCampaignService;

  let memberRepo: ReturnType<typeof makeMockRepo>;
  let pushTokenRepo: ReturnType<typeof makeMockRepo>;
  let identityRepo: ReturnType<typeof makeMockRepo>;
  let pushNotificationsService: jest.Mocked<PushNotificationsService>;
  let messageDeliveryService: jest.Mocked<MessageDeliveryService>;
  const cohortRepo = { findOne: jest.fn().mockResolvedValue({ id: 'cohort-1', name: 'Big spenders' }) };
  const activity = { record: jest.fn() };
  const pushConfigRepo = { findOne: jest.fn().mockResolvedValue({ projectId: 'proj-1', isActive: true }) };
  const messagesService = { findOne: jest.fn().mockResolvedValue({ id: 'msg-1' }) };

  beforeEach(async () => {
    memberRepo = makeMockRepo();
    pushTokenRepo = makeMockRepo();
    identityRepo = makeMockRepo();
    activity.record.mockReset();
    // Nobody has opted out of push unless a test says so.
    identityRepo.find.mockResolvedValue([]);

    messageDeliveryService = {
      queueMessageForDevices: jest.fn(),
    } as unknown as jest.Mocked<MessageDeliveryService>;

    pushNotificationsService = {
      send: jest.fn(),
      // Everyone in a batch is reachable unless a test says otherwise.
      countReachableDevices: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<PushNotificationsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: TrackingConsentService, useValue: trackingConsent },
        MixpanelCampaignService,
        { provide: getRepositoryToken(MixpanelCohortMemberEntity), useValue: memberRepo },
        { provide: getRepositoryToken(PushTokenEntity), useValue: pushTokenRepo },
        { provide: getRepositoryToken(DeviceIdentityEntity), useValue: identityRepo },
        { provide: PushNotificationsService, useValue: pushNotificationsService },
        { provide: MessageDeliveryService, useValue: messageDeliveryService },
        { provide: getRepositoryToken(MixpanelCohortEntity), useValue: cohortRepo },
        { provide: ProjectActivityService, useValue: activity },
        { provide: getRepositoryToken(PushConfigEntity), useValue: pushConfigRepo },
        { provide: InAppMessagesService, useValue: messagesService },
      ],
    }).compile();

    service = module.get<MixpanelCampaignService>(MixpanelCampaignService);
  });

  // ---------------------------------------------------------------------------
  // getPushStats
  // ---------------------------------------------------------------------------
  describe('getPushStats', () => {
    it('returns correct total, resolved, unresolved counts', async () => {
      memberRepo.count
        .mockResolvedValueOnce(10)  // total
        .mockResolvedValueOnce(7)   // resolved
        .mockResolvedValueOnce(3);  // unresolved

      memberRepo.find.mockResolvedValueOnce([]); // no resolved members => pushEnabled = 0

      const result = await service.getPushStats('proj-1', 'cohort-1');

      expect(result.total).toBe(10);
      expect(result.resolved).toBe(7);
      expect(result.unresolved).toBe(3);
    });

    it('returns pushEnabled = 0 when there are no resolved members', async () => {
      memberRepo.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(5);

      memberRepo.find.mockResolvedValueOnce([]); // empty resolved list

      const result = await service.getPushStats('proj-1', 'cohort-1');

      expect(result.pushEnabled).toBe(0);
      expect(pushTokenRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('returns pushEnabled from the query builder distinct count', async () => {
      memberRepo.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(6);

      memberRepo.find.mockResolvedValueOnce([
        makeMember('id-1'),
        makeMember('id-2'),
        makeMember(null), // null should be filtered out
      ]);

      const qbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValueOnce({ count: '2' }),
      };
      pushTokenRepo.createQueryBuilder.mockReturnValueOnce(qbMock);

      const result = await service.getPushStats('proj-1', 'cohort-1');

      expect(result.pushEnabled).toBe(2);
    });

    it('counts only the members a cohort push would reach: not do-not-track, not opted out', async () => {
      memberRepo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(3).mockResolvedValueOnce(0);
      memberRepo.find.mockResolvedValueOnce([makeMember('id-1'), makeMember('id-dnt'), makeMember('id-optout')]);
      trackingConsent.withoutDoNotTrack.mockImplementationOnce(async (_p: string, ids: string[]) =>
        ids.filter((id) => id !== 'id-dnt'),
      );
      identityRepo.find.mockResolvedValueOnce([{ id: 'id-optout' }]);
      const qbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValueOnce({ count: '1' }),
      };
      pushTokenRepo.createQueryBuilder.mockReturnValueOnce(qbMock);

      await service.getPushStats('proj-1', 'cohort-1');

      expect(qbMock.andWhere).toHaveBeenCalledWith('pt.deviceIdentityId IN (:...ids)', { ids: ['id-1'] });
    });

    it('handles a null count row from getRawOne by defaulting to 0', async () => {
      memberRepo.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3);

      memberRepo.find.mockResolvedValueOnce([makeMember('id-1')]);

      const qbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValueOnce(null), // null row
      };
      pushTokenRepo.createQueryBuilder.mockReturnValueOnce(qbMock);

      const result = await service.getPushStats('proj-1', 'cohort-1');

      expect(result.pushEnabled).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // sendPushToCohort
  // ---------------------------------------------------------------------------
  describe('sendPushToCohort', () => {
    it('throws BadRequestException when there are no resolved members', async () => {
      memberRepo.find.mockResolvedValueOnce([]); // no resolved members

      await expect(
        service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException with message about no eligible push tokens when resolved is empty', async () => {
      memberRepo.find.mockResolvedValueOnce([]);

      await expect(
        service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER),
      ).rejects.toThrow('No eligible push tokens found for this cohort');
    });

    it('throws BadRequestException when resolved members exist but no push tokens match', async () => {
      memberRepo.find.mockResolvedValueOnce([makeMember('id-1'), makeMember('id-2')]);
      pushTokenRepo.find.mockResolvedValueOnce([]); // no matching tokens

      await expect(
        service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException with message about no eligible push tokens when tokens are empty', async () => {
      memberRepo.find.mockResolvedValueOnce([makeMember('id-1')]);
      pushTokenRepo.find.mockResolvedValueOnce([]);

      await expect(
        service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER),
      ).rejects.toThrow('No eligible push tokens found for this cohort');
    });

    it('calls pushNotificationsService.send with correct parameters', async () => {
      memberRepo.find.mockResolvedValueOnce([makeMember('id-1'), makeMember('id-2')]);
      pushTokenRepo.find.mockResolvedValueOnce([
        makePushToken('id-1', 'token-1'),
        makePushToken('id-2', 'token-2'),
      ]);

      const log = makeLog();
      pushNotificationsService.send.mockResolvedValueOnce(log);

      await service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER);

      expect(pushNotificationsService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          title: 'Hello World',
          body: 'Check this out',
          deviceIdentityIds: expect.arrayContaining(['id-1', 'id-2']),
        }),
        // Each batch is one campaign; the cohort entry stands for the request.
        null,
      );
      expect(activity.record).toHaveBeenCalledTimes(1);
      expect(activity.record).toHaveBeenCalledWith(
        {
          projectId: 'proj-1',
          actor: { kind: 'user', userId: 'user-1' },
          action: 'cohort.push_sent',
          target: { type: 'cohort', id: 'cohort-1', label: 'Big spenders' },
        },
        REQUESTER.context,
        undefined,
      );
    });

    it('returns what was enqueued, not a delivery result', async () => {
      memberRepo.find.mockResolvedValueOnce([makeMember('id-1')]);
      pushTokenRepo.find.mockResolvedValueOnce([makePushToken('id-1')]);
      pushNotificationsService.send.mockResolvedValueOnce(makeLog({ id: 'log-uuid-1' }));

      const result = await service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER);

      // The worker sends; this call only queues. Returning a success count
      // here would report an outcome that has not happened yet.
      expect(result).toEqual({
        campaignIds: ['log-uuid-1'],
        devicesTargeted: 1,
        tokensTargeted: 1,
      });
    });

    it('leaves out do-not-track and push-opted-out members before counting tokens', async () => {
      memberRepo.find.mockResolvedValueOnce([
        makeMember('id-1'),
        makeMember('id-dnt'),
        makeMember('id-optout'),
      ]);
      trackingConsent.withoutDoNotTrack.mockImplementationOnce(async (_p: string, ids: string[]) =>
        ids.filter((id) => id !== 'id-dnt'),
      );
      identityRepo.find.mockResolvedValueOnce([{ id: 'id-optout' }]);
      pushTokenRepo.find.mockResolvedValueOnce([makePushToken('id-1')]);
      pushNotificationsService.send.mockResolvedValueOnce(makeLog());

      await service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER);

      expect(trackingConsent.withoutDoNotTrack).toHaveBeenCalledWith('proj-1', [
        'id-1',
        'id-dnt',
        'id-optout',
      ]);
      expect(identityRepo.find).toHaveBeenCalledWith({
        where: { projectId: 'proj-1', id: In(['id-1', 'id-optout']), pushOptIn: false },
        select: ['id'],
      });
      expect(pushTokenRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deviceIdentityId: In(['id-1']) }),
        }),
      );
      expect(pushNotificationsService.send).toHaveBeenCalledWith(
        expect.objectContaining({ deviceIdentityIds: ['id-1'] }),
        // Each batch is one campaign; the cohort entry stands for the request.
        null,
      );
    });

    it('filters out null deviceIdentityIds before querying push tokens', async () => {
      memberRepo.find.mockResolvedValueOnce([
        makeMember('id-1'),
        makeMember(null), // should be filtered
      ]);
      pushTokenRepo.find.mockResolvedValueOnce([makePushToken('id-1')]);
      pushNotificationsService.send.mockResolvedValueOnce(makeLog());

      await service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER);

      // Asserted as a whole In(...) rather than `not.arrayContaining([null])`:
      // that form compares against a FindOperator, never an array, so it
      // passed no matter what the query contained.
      expect(pushTokenRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deviceIdentityId: In(['id-1']),
          }),
        }),
      );
    });

    it('includes deep_link_url in the data payload when provided', async () => {
      memberRepo.find.mockResolvedValueOnce([makeMember('id-1')]);
      pushTokenRepo.find.mockResolvedValueOnce([makePushToken('id-1')]);
      pushNotificationsService.send.mockResolvedValueOnce(makeLog());

      const dto = makeDto({ deepLinkUrl: 'https://app.example.com/page' });
      await service.sendPushToCohort('proj-1', 'cohort-1', dto, REQUESTER);

      expect(pushNotificationsService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deep_link_url: 'https://app.example.com/page' }),
        }),
        // Each batch is one campaign; the cohort entry stands for the request.
        null,
      );
    });

    it('reports every batch it enqueued when members exceed BATCH_SIZE', async () => {
      // Create 501 unique device identity IDs to trigger two batches
      const identityIds = Array.from({ length: 501 }, (_, i) => `id-${i}`);
      memberRepo.find.mockResolvedValueOnce(identityIds.map((id) => makeMember(id)));
      pushTokenRepo.find.mockResolvedValueOnce(
        identityIds.map((id) => makePushToken(id, `token-${id}`)),
      );

      const firstLog = makeLog({ id: 'log-1', successCount: 500 });
      const secondLog = makeLog({ id: 'log-2', successCount: 1 });
      pushNotificationsService.send
        .mockResolvedValueOnce(firstLog)
        .mockResolvedValueOnce(secondLog);

      const result = await service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER);

      expect(pushNotificationsService.send).toHaveBeenCalledTimes(2);
      // Both ids, in enqueue order: returning only the last would leave the
      // first batch's campaign untrackable by the caller.
      expect(result).toEqual({
        campaignIds: ['log-1', 'log-2'],
        devicesTargeted: 501,
        tokensTargeted: 501,
      });
      expect(secondLog.id).toBe('log-2');
    });

    it('leaves out a batch nobody in which can be reached, before logging or sending', async () => {
      const identityIds = Array.from({ length: 501 }, (_, i) => `id-${i}`);
      memberRepo.find.mockResolvedValueOnce(identityIds.map((id) => makeMember(id)));
      pushTokenRepo.find.mockResolvedValueOnce(identityIds.map((id) => makePushToken(id, `token-${id}`)));
      pushNotificationsService.countReachableDevices.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      pushNotificationsService.send.mockResolvedValueOnce(makeLog({ id: 'log-2' }));

      const result = await service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER);

      expect(pushNotificationsService.send).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ campaignIds: ['log-2'], devicesTargeted: 1, tokensTargeted: 1 });
      expect(activity.record).toHaveBeenCalledTimes(1);
    });

    it('refuses, logging and sending nothing, when nobody in the cohort can be reached', async () => {
      memberRepo.find.mockResolvedValueOnce([makeMember('id-1')]);
      pushTokenRepo.find.mockResolvedValueOnce([makePushToken('id-1')]);
      pushNotificationsService.countReachableDevices.mockResolvedValueOnce(0);

      await expect(service.sendPushToCohort('proj-1', 'cohort-1', makeDto(), REQUESTER)).rejects.toThrow(
        /No reachable push tokens/,
      );
      expect(pushNotificationsService.send).not.toHaveBeenCalled();
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('uses default platforms ["android", "ios"] when dto.platforms is not provided', async () => {
      memberRepo.find.mockResolvedValueOnce([makeMember('id-1')]);
      pushTokenRepo.find.mockResolvedValueOnce([makePushToken('id-1')]);
      pushNotificationsService.send.mockResolvedValueOnce(makeLog());

      const dto = makeDto({ platforms: undefined });
      await service.sendPushToCohort('proj-1', 'cohort-1', dto, REQUESTER);

      expect(pushTokenRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // Compared against In(...) rather than a bare array: the query
            // builds a FindOperator, and arrayContaining would pass against
            // one vacuously without checking a single platform.
            platform: In(['android', 'ios']),
          }),
        }),
      );
    });
  });
});

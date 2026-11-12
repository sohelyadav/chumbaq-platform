import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessageDeliveryService } from './message-delivery.service';
import { InAppMessageEntity } from './entities/in-app-message.entity';
import { InAppMessageImpressionEntity } from './entities/in-app-message-impression.entity';
import { PendingMessageEntity } from './entities/pending-message.entity';
import { MixpanelCohortMemberEntity } from '../mixpanel-cohorts/entities/mixpanel-cohort-member.entity';
import { InAppMessagesService } from './in-app-messages.service';
import { IdentityService } from '../identity/identity.service';
import { SegmentsService } from '../segments/segments.service';
import { SegmentEvaluationService } from '../segments/segment-evaluation.service';

import { TrackingConsentService } from '../consent/tracking-consent.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const activity = { record: jest.fn() };

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

/** Nobody is do-not-track unless a test says so. */
const trackingConsent = {
  isDoNotTrack: jest.fn(async (_subject: unknown) => false),
  withoutDoNotTrack: jest.fn(async (_projectId: string, ids: string[]) => ids),
  recordDrop: jest.fn(),
};

// A tiny factory for message fixtures so every test doesn't repeat the boilerplate.
const buildMessage = (overrides: Partial<InAppMessageEntity> = {}): InAppMessageEntity => ({
  id: 'msg-1',
  projectId: 'proj-1',
  name: 'Test',
  messageType: 'modal',
  status: 'active',
  title: 'Hello',
  body: 'Body',
  imageUrl: null,
  imagePosition: 'top',
  buttons: null,
  theme: null,
  dismissOnTapOutside: true,
  autoDismissSeconds: null,
  triggerType: 'on_app_open',
  triggerEvent: null,
  triggerScreen: null,
  triggerDelaySeconds: 0,
  triggerConditions: null,
  userType: 'all',
  mixpanelCohortId: null,
  segmentId: null,
  userFilters: null,
  startsAt: null,
  endsAt: null,
  priority: 0,
  maxImpressionsPerUser: null,
  minIntervalSeconds: null,
  maxImpressionsTotal: null,
  totalImpressions: 0,
  totalClicks: 0,
  totalDismissals: 0,
  tags: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  project: undefined as any,
  ...overrides,
});

describe('MessageDeliveryService', () => {
  let service: MessageDeliveryService;

  const impressionQb: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };

  const mockMessageRepo: any = {
    find: jest.fn(),
    findOne: jest.fn(),
    manager: {
      getRepository: jest.fn(),
    },
  };

  const mockImpressionRepo: any = {
    create: jest.fn((v) => v),
    save: jest.fn(),
    createQueryBuilder: jest.fn(() => impressionQb),
  };

  const mockPendingRepo: any = {
    find: jest.fn(),
    create: jest.fn((v) => v),
    save: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };

  const mockCohortMemberRepo = {
    findOne: jest.fn(),
  };

  const mockMessagesService = {
    findOne: jest.fn(),
    incrementCounter: jest.fn().mockResolvedValue(undefined),
  };

  const mockIdentityService: any = {
    findByFingerprintAndProject: jest.fn(),
    findByDistinctId: jest.fn(),
    getDevicesByDistinctId: jest.fn(),
  };

  const segmentsService = {
    findOne: jest.fn(),
  };

  const segmentEvaluation = {
    isMember: jest.fn(),
  };

  let suspendedProject: string | null = null;
  const suspension = {
    isSuspended: jest.fn(async (id: string) => id === suspendedProject),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    suspendedProject = null;
    impressionQb.getRawMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectActivityService, useValue: activity },
        { provide: TrackingConsentService, useValue: trackingConsent },
        MessageDeliveryService,
        { provide: getRepositoryToken(InAppMessageEntity), useValue: mockMessageRepo },
        { provide: getRepositoryToken(InAppMessageImpressionEntity), useValue: mockImpressionRepo },
        { provide: getRepositoryToken(PendingMessageEntity), useValue: mockPendingRepo },
        { provide: getRepositoryToken(MixpanelCohortMemberEntity), useValue: mockCohortMemberRepo },
        { provide: InAppMessagesService, useValue: mockMessagesService },
        { provide: IdentityService, useValue: mockIdentityService },
        { provide: SegmentsService, useValue: segmentsService },
        { provide: SegmentEvaluationService, useValue: segmentEvaluation },
        { provide: ProjectSuspensionService, useValue: suspension },
      ],
    }).compile();

    service = module.get<MessageDeliveryService>(MessageDeliveryService);
  });

  // ---------------------------------------------------------------------------
  // checkMessages — the core eligibility engine
  // ---------------------------------------------------------------------------
  describe('checkMessages', () => {
    const baseDto = {
      projectId: 'proj-1',
      deviceFingerprint: 'fp-1',
      context: { platform: 'ios' } as any,
    };

    beforeEach(() => {
      mockPendingRepo.find.mockResolvedValue([]);
    });

    it('delivers active campaign messages matching on_app_open trigger', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', triggerType: 'on_app_open' }),
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe('m1');
    });

    it('limits output to the top 3 messages sorted by priority', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', priority: 1 }),
        buildMessage({ id: 'm2', priority: 5 }),
        buildMessage({ id: 'm3', priority: 3 }),
        buildMessage({ id: 'm4', priority: 10 }),
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(3);
      expect(result.messages.map((m) => m.id)).toEqual(['m4', 'm2', 'm3']);
    });

    it('filters out messages whose trigger event does not match context', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', triggerType: 'on_event', triggerEvent: 'checkout' }),
        buildMessage({ id: 'm2', triggerType: 'on_event', triggerEvent: 'signup' }),
      ]);

      const result = await service.checkMessages({
        ...baseDto,
        context: { platform: 'ios', event: 'signup' } as any,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe('m2');
    });

    it('filters out messages whose trigger screen does not match context', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', triggerType: 'on_screen', triggerScreen: 'home' }),
        buildMessage({ id: 'm2', triggerType: 'on_screen', triggerScreen: 'settings' }),
      ]);

      const result = await service.checkMessages({
        ...baseDto,
        context: { platform: 'ios', screen: 'home' } as any,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe('m1');
    });

    it('excludes "immediate" trigger messages from the campaign path', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', triggerType: 'immediate' }),
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
    });

    it('returns empty for unknown trigger types', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', triggerType: 'garbage' as any }),
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
    });

    // ── User filters ──
    it('excludes messages whose platform filter does not match', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({
          id: 'm1',
          userType: 'all',
          userFilters: { platforms: ['android'] },
        }),
      ]);

      const result = await service.checkMessages({
        ...baseDto,
        context: { platform: 'ios' } as any,
      });

      expect(result.messages).toHaveLength(0);
    });

    it('includes messages whose platform filter matches', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({
          id: 'm1',
          userType: 'all',
          userFilters: { platforms: ['ios', 'android'] },
        }),
      ]);

      const result = await service.checkMessages({
        ...baseDto,
        context: { platform: 'ios' } as any,
      });

      expect(result.messages).toHaveLength(1);
    });

    it('excludes messages whose country filter does not match', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', userFilters: { countries: ['US'] } }),
      ]);

      const result = await service.checkMessages({
        ...baseDto,
        context: { platform: 'ios', country: 'CA' } as any,
      });

      expect(result.messages).toHaveLength(0);
    });

    it('excludes messages whose appVersion filter does not match', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', userFilters: { appVersions: ['2.0.0'] } }),
      ]);

      const result = await service.checkMessages({
        ...baseDto,
        context: { platform: 'ios', appVersion: '1.5.0' } as any,
      });

      expect(result.messages).toHaveLength(0);
    });

    it('passes when user filter is empty (no restrictions)', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', userType: 'all', userFilters: null }),
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(1);
    });

    // ── Cohort membership ──
    it('includes a cohort-targeted message when user is a resolved cohort member', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', userType: 'cohort', mixpanelCohortId: 'cohort-1' }),
      ]);
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'ident-1' });
      mockCohortMemberRepo.findOne.mockResolvedValueOnce({ id: 'member-1' });

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(1);
      expect(mockCohortMemberRepo.findOne).toHaveBeenCalledWith({
        where: {
          cohortId: 'cohort-1',
          projectId: 'proj-1',
          deviceIdentityId: 'ident-1',
          isResolved: true,
        },
      });
    });

    it('withholds a cohort-targeted message from a do-not-track person', async () => {
      // A cohort is built from behaviour, so it must not pick someone who
      // refused profiling, even if Mixpanel still lists them.
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', userType: 'cohort', mixpanelCohortId: 'cohort-1' }),
      ]);
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'ident-1' });
      trackingConsent.isDoNotTrack.mockResolvedValueOnce(true);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
      // Refused before membership is even looked up.
      expect(mockCohortMemberRepo.findOne).not.toHaveBeenCalled();
      expect(trackingConsent.isDoNotTrack).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceIdentityId: 'ident-1',
      });
    });

    it('still shows a message targeted at everyone to a do-not-track person', async () => {
      // In-app is not suppressed by do-not-track (nor by push_opt_in): only
      // targeting that reads behaviour is.
      mockMessageRepo.find.mockResolvedValueOnce([buildMessage({ id: 'm1', userType: 'all' })]);
      trackingConsent.isDoNotTrack.mockResolvedValue(true);
      try {
        const result = await service.checkMessages(baseDto);
        expect(result.messages).toHaveLength(1);
      } finally {
        trackingConsent.isDoNotTrack.mockImplementation(async () => false);
      }
    });

    it('excludes cohort-targeted messages when device has no identity', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', userType: 'cohort', mixpanelCohortId: 'cohort-1' }),
      ]);
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce(null);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
      expect(mockCohortMemberRepo.findOne).not.toHaveBeenCalled();
    });

    it('excludes cohort-targeted messages when identity is not a resolved member', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', userType: 'cohort', mixpanelCohortId: 'cohort-1' }),
      ]);
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'ident-1' });
      mockCohortMemberRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
    });

    it('skips cohort messages with no mixpanelCohortId set', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', userType: 'cohort', mixpanelCohortId: null }),
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
      expect(mockIdentityService.findByFingerprintAndProject).not.toHaveBeenCalled();
    });

    // ── Frequency capping ──
    it('excludes messages whose per-user impression cap is reached', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', maxImpressionsPerUser: 3 }),
      ]);
      impressionQb.getRawMany.mockResolvedValueOnce([
        { messageId: 'm1', count: '3', lastShown: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
    });

    it('includes messages whose per-user cap has not been reached', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', maxImpressionsPerUser: 3 }),
      ]);
      impressionQb.getRawMany.mockResolvedValueOnce([
        { messageId: 'm1', count: '1', lastShown: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(1);
    });

    it('excludes messages still inside their minIntervalSeconds cooldown', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', minIntervalSeconds: 3600 }),
      ]);
      impressionQb.getRawMany.mockResolvedValueOnce([
        {
          messageId: 'm1',
          count: '1',
          lastShown: new Date(Date.now() - 10 * 1000).toISOString(), // 10s ago
        },
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
    });

    it('includes messages whose cooldown has elapsed', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', minIntervalSeconds: 60 }),
      ]);
      impressionQb.getRawMany.mockResolvedValueOnce([
        {
          messageId: 'm1',
          count: '1',
          lastShown: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
        },
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(1);
    });

    it('excludes messages that have reached their global total cap', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', maxImpressionsTotal: 1000, totalImpressions: 1000 }),
      ]);
      impressionQb.getRawMany.mockResolvedValueOnce([
        {
          messageId: 'm1',
          count: '1',
          lastShown: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      ]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(0);
    });

    it('passes frequency cap when user has never been shown the message', async () => {
      mockMessageRepo.find.mockResolvedValueOnce([
        buildMessage({ id: 'm1', maxImpressionsPerUser: 1 }),
      ]);
      impressionQb.getRawMany.mockResolvedValueOnce([]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(1);
    });

    // ── Pending messages ──
    it('surfaces pending messages alongside campaigns', async () => {
      const pendingMsg = buildMessage({ id: 'pending-1', priority: 100 });
      mockPendingRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          messageId: 'pending-1',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          message: pendingMsg,
        },
      ]);
      mockMessageRepo.find.mockResolvedValueOnce([]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe('pending-1');
    });

    it('filters out expired pending messages and triggers the expiry update', async () => {
      const expiredPending = {
        id: 'p1',
        messageId: 'pending-1',
        expiresAt: new Date(Date.now() - 1000),
        message: buildMessage({ id: 'pending-1' }),
      };
      const validPending = {
        id: 'p2',
        messageId: 'pending-2',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        message: buildMessage({ id: 'pending-2' }),
      };
      mockPendingRepo.find.mockResolvedValueOnce([expiredPending, validPending]);
      mockMessageRepo.find.mockResolvedValueOnce([]);

      const result = await service.checkMessages(baseDto);

      expect(result.messages.map((m) => m.id)).toEqual(['pending-2']);
      expect(mockPendingRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.anything() }),
        { status: 'expired' },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // recordEvent
  // ---------------------------------------------------------------------------
  describe('recordEvent', () => {
    const dto = {
      messageId: 'm1',
      projectId: 'proj-1',
      deviceFingerprint: 'fp-1',
      eventType: 'impression' as const,
    };

    /**
     * An unknown messageId used to reach the insert and surface as a raw 500
     * `QueryFailedError` naming the foreign key constraint. The class is the
     * real problem: a client queue retries a 5xx with backoff indefinitely,
     * so a stale id after a campaign was deleted became a permanent retry
     * loop, where a 404 is terminal and the event is dropped.
     */
    it('rejects an unknown messageId before touching the table', async () => {
      mockMessagesService.findOne.mockRejectedValueOnce(
        new NotFoundException('In-app message not found'),
      );

      await expect(service.recordEvent(dto as any)).rejects.toThrow(
        NotFoundException,
      );

      expect(mockImpressionRepo.save).not.toHaveBeenCalled();
    });

    it.each(['paused', 'completed', 'archived'])(
      'still records an event for a %s campaign',
      async (status) => {
        // Deliberate, not incidental: a message already on screen when its
        // campaign stops can still be dismissed or tapped, and that event is
        // an honest report about a message the server did serve. Refusing it
        // would drop the last impressions of every campaign ever run. If
        // someone later adds a status filter to this path, this test is what
        // should stop them.
        mockMessagesService.findOne.mockResolvedValueOnce({ id: 'm1', status });
        mockImpressionRepo.save.mockResolvedValueOnce({});

        await service.recordEvent({ ...dto, eventType: 'dismiss' } as any);

        expect(mockImpressionRepo.save).toHaveBeenCalled();
      },
    );

    it('scopes the message to the reporting project', async () => {
      // The controller checks the API key against dto.projectId; this is what
      // checks the message against it, so one project's key cannot write
      // impressions onto another project's campaign.
      mockMessagesService.findOne.mockResolvedValueOnce({ id: 'm1' });
      mockImpressionRepo.save.mockResolvedValueOnce({});

      await service.recordEvent(dto as any);

      expect(mockMessagesService.findOne).toHaveBeenCalledWith('m1', 'proj-1');
    });

    it('resolves device identity and creates an impression row', async () => {
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'ident-1' });
      mockImpressionRepo.save.mockResolvedValueOnce({});

      await service.recordEvent(dto as any);

      expect(mockImpressionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'm1',
          projectId: 'proj-1',
          deviceIdentityId: 'ident-1',
          deviceFingerprint: 'fp-1',
          eventType: 'impression',
        }),
      );
      expect(mockImpressionRepo.save).toHaveBeenCalled();
    });

    it('sets deviceIdentityId to null when no identity exists', async () => {
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce(null);
      mockImpressionRepo.save.mockResolvedValueOnce({});

      await service.recordEvent(dto as any);

      expect(mockImpressionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ deviceIdentityId: null }),
      );
    });

    it('increments the impression counter for impression events', async () => {
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce(null);
      mockImpressionRepo.save.mockResolvedValueOnce({});

      await service.recordEvent({ ...dto, eventType: 'impression' } as any);

      expect(mockMessagesService.incrementCounter).toHaveBeenCalledWith('m1', 'totalImpressions');
    });

    it('increments the click counter for click and cta_click events', async () => {
      mockIdentityService.findByFingerprintAndProject.mockResolvedValue(null);
      mockImpressionRepo.save.mockResolvedValue({});

      await service.recordEvent({ ...dto, eventType: 'click' } as any);
      await service.recordEvent({ ...dto, eventType: 'cta_click' } as any);

      expect(mockMessagesService.incrementCounter).toHaveBeenNthCalledWith(1, 'm1', 'totalClicks');
      expect(mockMessagesService.incrementCounter).toHaveBeenNthCalledWith(2, 'm1', 'totalClicks');
    });

    it('increments the dismissal counter for dismiss events', async () => {
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce(null);
      mockImpressionRepo.save.mockResolvedValueOnce({});

      await service.recordEvent({ ...dto, eventType: 'dismiss' } as any);

      expect(mockMessagesService.incrementCounter).toHaveBeenCalledWith('m1', 'totalDismissals');
    });

    describe('for a do-not-track person', () => {
      beforeEach(() => {
        mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'ident-1' });
        trackingConsent.isDoNotTrack.mockResolvedValueOnce(true);
        mockImpressionRepo.save.mockResolvedValueOnce({});
      });
      const context = { ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0' };

      it.each(['click', 'cta_click', 'dismiss'])(
        'stores no %s row, but still counts it on the message',
        async (eventType) => {
          await service.recordEvent({ ...dto, eventType, distinctId: 'user-1' } as any, context);

          expect(mockImpressionRepo.save).not.toHaveBeenCalled();
          expect(mockMessagesService.incrementCounter).toHaveBeenCalled();
          expect(trackingConsent.recordDrop).toHaveBeenCalledWith('in_app_event');
        },
      );

      it.each(['impression', 'delivered'])(
        'keeps a %s row, without the person, address or browser, so the cap still works',
        async (eventType) => {
          await service.recordEvent(
            { ...dto, eventType, distinctId: 'user-1', buttonId: 'b1' } as any,
            context,
          );

          expect(mockImpressionRepo.create).toHaveBeenCalledWith({
            messageId: 'm1',
            projectId: 'proj-1',
            deviceIdentityId: null,
            distinctId: null,
            deviceFingerprint: 'fp-1',
            eventType,
            buttonId: null,
            ipAddress: null,
            userAgent: null,
          });
          expect(mockImpressionRepo.save).toHaveBeenCalledTimes(1);
          expect(mockPendingRepo.update).toHaveBeenCalled();
          // Kept, so not counted as dropped.
          expect(trackingConsent.recordDrop).not.toHaveBeenCalled();
        },
      );
    });

    it('stores the address and browser for someone who is not do-not-track', async () => {
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'ident-1' });
      mockImpressionRepo.save.mockResolvedValueOnce({});

      await service.recordEvent({ ...dto, eventType: 'click' } as any, {
        ipAddress: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
      });

      expect(mockImpressionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ deviceIdentityId: 'ident-1', ipAddress: '203.0.113.9' }),
      );
    });

    it('marks pending messages as delivered on impression', async () => {
      mockIdentityService.findByFingerprintAndProject.mockResolvedValueOnce(null);
      mockImpressionRepo.save.mockResolvedValueOnce({});

      await service.recordEvent({ ...dto, eventType: 'impression' } as any);

      expect(mockPendingRepo.update).toHaveBeenCalledWith(
        { messageId: 'm1', deviceFingerprint: 'fp-1', status: 'pending' },
        { status: 'delivered' },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // triggerMessage
  // ---------------------------------------------------------------------------
  describe('triggerMessage', () => {
    const message = buildMessage({ id: 'msg-1' });

    beforeEach(() => {
      mockMessagesService.findOne.mockResolvedValue(message);
    });

    it('returns queued=0 when there are no device fingerprints', async () => {
      const result = await service.triggerMessage('proj-1', {
        messageId: 'msg-1',
        targetType: 'users',
        deviceFingerprints: [],
      } as any, REQUESTER);

      expect(result.queued).toBe(0);
      expect(mockPendingRepo.save).not.toHaveBeenCalled();
    });

    it('queues one pending row per unique device fingerprint', async () => {
      mockPendingRepo.save.mockResolvedValue([]);

      const result = await service.triggerMessage('proj-1', {
        messageId: 'msg-1',
        targetType: 'users',
        deviceFingerprints: ['fp-1', 'fp-2', 'fp-1'], // duplicate should collapse
      } as any, REQUESTER);

      expect(result.queued).toBe(2);
      const savedBatch = mockPendingRepo.save.mock.calls[0][0];
      expect(savedBatch).toHaveLength(2);
    });

    it('resolves distinctIds to device fingerprints', async () => {
      mockIdentityService.findByDistinctId
        .mockResolvedValueOnce([{ deviceFingerprint: 'fp-from-did' }]);
      mockPendingRepo.save.mockResolvedValue([]);

      const result = await service.triggerMessage('proj-1', {
        messageId: 'msg-1',
        targetType: 'users',
        distinctIds: ['user-1'],
      } as any, REQUESTER);

      expect(result.queued).toBe(1);
      expect(mockIdentityService.findByDistinctId).toHaveBeenCalledWith('user-1', 'proj-1');
    });

    it('returns queued=0 when cohort target has no pre-resolved fingerprints', async () => {
      const result = await service.triggerMessage('proj-1', {
        messageId: 'msg-1',
        targetType: 'cohort',
      } as any, REQUESTER);

      expect(result.queued).toBe(0);
    });

    it('uses pre-resolved fingerprints for cohort targets', async () => {
      mockPendingRepo.save.mockResolvedValue([]);

      const result = await service.triggerMessage('proj-1', {
        messageId: 'msg-1',
        targetType: 'cohort',
        deviceFingerprints: ['fp-a', 'fp-b'],
      } as any, REQUESTER);

      expect(result.queued).toBe(2);
    });

    it('sets an expiry of 24 hours on each queued row', async () => {
      mockPendingRepo.save.mockResolvedValue([]);

      const before = Date.now();
      await service.triggerMessage('proj-1', {
        messageId: 'msg-1',
        targetType: 'users',
        deviceFingerprints: ['fp-1'],
      } as any, REQUESTER);

      const saved = mockPendingRepo.save.mock.calls[0][0][0];
      const expiryMs = saved.expiresAt.getTime();
      const expected = before + 24 * 60 * 60 * 1000;
      expect(expiryMs).toBeGreaterThanOrEqual(expected - 1000);
      expect(expiryMs).toBeLessThanOrEqual(expected + 60 * 1000);
    });
  });

  // ---------------------------------------------------------------------------
  // filterByUsers — segment-targeted messages
  // ---------------------------------------------------------------------------
  describe('segment-targeted messages', () => {
    const msg = {
      id: 'msg-1', projectId: 'proj-1', userType: 'segment',
      segmentId: 'seg-1', status: 'active', triggerType: 'on_app_open',
    };

    it('delivers when the requesting person is a member', async () => {
      segmentsService.findOne.mockResolvedValueOnce({ id: 'seg-1', projectId: 'proj-1' });
      segmentEvaluation.isMember.mockResolvedValueOnce(true);

      const kept = await service.filterByUsers([msg], {
        deviceFingerprint: 'fp-1', externalUserId: 'user-1', deviceIdentityId: 'dev-1',
      } as never);

      expect(kept).toHaveLength(1);
      expect(segmentEvaluation.isMember).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'seg-1' }),
        'user-1',
      );
    });

    it('withholds when the person is not a member', async () => {
      segmentsService.findOne.mockResolvedValueOnce({ id: 'seg-1', projectId: 'proj-1' });
      segmentEvaluation.isMember.mockResolvedValueOnce(false);

      const kept = await service.filterByUsers([msg], {
        deviceFingerprint: 'fp-1', externalUserId: 'user-1', deviceIdentityId: 'dev-1',
      } as never);

      expect(kept).toHaveLength(0);
    });

    it('keys an anonymous device by device: prefix', async () => {
      segmentsService.findOne.mockResolvedValueOnce({ id: 'seg-1', projectId: 'proj-1' });
      segmentEvaluation.isMember.mockResolvedValueOnce(true);

      await service.filterByUsers([msg], {
        deviceFingerprint: 'fp-2', externalUserId: null, deviceIdentityId: 'dev-2',
      } as never);

      expect(segmentEvaluation.isMember).toHaveBeenCalledWith(
        expect.anything(), 'device:dev-2',
      );
    });

    it('withholds rather than throwing when the segment is gone', async () => {
      segmentsService.findOne.mockRejectedValueOnce(new NotFoundException('gone'));

      const kept = await service.filterByUsers([msg], {
        deviceFingerprint: 'fp-1', externalUserId: 'user-1', deviceIdentityId: 'dev-1',
      } as never);

      expect(kept).toHaveLength(0);
    });

    it('withholds when a message names no segment, rather than delivering to everyone', async () => {
      const kept = await service.filterByUsers(
        [{ ...msg, segmentId: null }],
        { deviceFingerprint: 'fp-1', externalUserId: 'user-1', deviceIdentityId: 'dev-1' } as never,
      );

      expect(kept).toHaveLength(0);
      expect(segmentEvaluation.isMember).not.toHaveBeenCalled();
    });
  });

  describe('checkMessages for a suspended tenant', () => {
    const dto = {
      projectId: 'proj-1',
      deviceFingerprint: 'fp-1',
      context: { platform: 'ios' } as any,
    };

    beforeEach(() => {
      mockPendingRepo.find.mockReset();
      mockPendingRepo.find.mockResolvedValue([]);
      mockMessageRepo.find.mockReset();
      mockMessageRepo.find.mockResolvedValue([buildMessage({ id: 'm1', triggerType: 'on_app_open' })]);
    });

    it('returns the ordinary empty response without touching the pending queue', async () => {
      suspendedProject = 'proj-1';

      await expect(service.checkMessages(dto)).resolves.toEqual({ messages: [] });

      expect(mockPendingRepo.find).not.toHaveBeenCalled();
    });

    it('still delivers to an active tenant', async () => {
      suspendedProject = 'other';

      const result = await service.checkMessages(dto);

      expect(result.messages.map((message) => message.id)).toEqual(['m1']);
    });
  });
});

import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getMetadataArgsStorage } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { PushCampaignScheduleScheduler } from './push-campaign-schedule.scheduler';
import {
  PushNotificationLogEntity,
  NON_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
} from '../../modules/push-notifications/entities/push-notification-log.entity';
import {
  QUEUE_PUSH_CAMPAIGN,
  JOB_DISPATCH_CAMPAIGN,
} from '../queue.constants';
import { PushTokensService } from '../../modules/push-tokens/push-tokens.service';
import { PushConfigEntity } from '../../modules/push-notifications/entities/push-config.entity';
import { PushAnalyticsService } from '../../modules/push-notifications/push-analytics.service';
import { EmailAudienceService } from '../../modules/email/email-audience.service';
import { EmailSettingsService } from '../../modules/email/email-settings.service';
import { SmsAudienceService } from '../../modules/sms/sms-audience.service';
import { SmsSettingsService } from '../../modules/sms/sms-settings.service';
import { WhatsAppAudienceService } from '../../modules/whatsapp/whatsapp-audience.service';
import { WhatsAppSettingsService } from '../../modules/whatsapp/whatsapp-settings.service';

describe('PushCampaignScheduleScheduler', () => {
  let scheduler: PushCampaignScheduleScheduler;
  let qb: any;

  const logRepository = {
    createQueryBuilder: jest.fn(),
    update: jest.fn(),
    create: jest.fn((o) => o),
    save: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    // Used by the expansion path to map a RETURNING * row back onto the entity.
    metadata: { columns: [] as Array<{ propertyName: string; databaseName: string }> },
  };
  const pushQueue = { add: jest.fn() };
  const configRepository = { findOne: jest.fn().mockResolvedValue(null) };
  const pushTokensService = {
    groupDeviceIdentitiesByTimezone: jest.fn(),
    listDeviceIdentityIds: jest.fn(),
  };
  const pushAnalytics = { clickHoursForDevices: jest.fn().mockResolvedValue([]) };
  const emailAudience = {
    listRecipientIds: jest.fn(),
    groupByTimezone: jest.fn(),
  };
  const emailSettings = { find: jest.fn().mockResolvedValue({ requireOptIn: true }) };
  const smsAudience = {
    listRecipientIds: jest.fn(),
    groupByTimezone: jest.fn(),
  };
  const smsSettings = { find: jest.fn().mockResolvedValue({ requireOptIn: false }) };
  const whatsappAudience = { listRecipientIds: jest.fn(), groupByTimezone: jest.fn() };
  const whatsappSettings = { find: jest.fn().mockResolvedValue({ requireOptIn: true }) };

  const suspension = { suspendedProjectIds: jest.fn(async () => new Set<string>()) };

  /** Order of calls across the repository and the queue, for the claim-first test. */
  let callOrder: string[];

  beforeEach(async () => {
    jest.clearAllMocks();
    callOrder = [];

    qb = {};
    for (const m of ['update', 'set', 'where', 'andWhere', 'returning']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.execute = jest.fn(async () => {
      callOrder.push('claim');
      return { raw: [] };
    });
    logRepository.createQueryBuilder.mockReturnValue(qb);
    logRepository.update.mockResolvedValue({ affected: 1 });
    logRepository.find.mockResolvedValue([]);
    configRepository.findOne.mockResolvedValue(null);
    pushAnalytics.clickHoursForDevices.mockResolvedValue([]);
    pushQueue.add.mockImplementation(async () => {
      callOrder.push('enqueue');
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushCampaignScheduleScheduler,
        {
          provide: getRepositoryToken(PushNotificationLogEntity),
          useValue: logRepository,
        },
        {
          provide: getRepositoryToken(PushConfigEntity),
          useValue: configRepository,
        },
        { provide: getQueueToken(QUEUE_PUSH_CAMPAIGN), useValue: pushQueue },
        { provide: PushTokensService, useValue: pushTokensService },
        { provide: PushAnalyticsService, useValue: pushAnalytics },
        { provide: EmailAudienceService, useValue: emailAudience },
        { provide: EmailSettingsService, useValue: emailSettings },
        { provide: SmsAudienceService, useValue: smsAudience },
        { provide: SmsSettingsService, useValue: smsSettings },
        { provide: WhatsAppAudienceService, useValue: whatsappAudience },
        { provide: WhatsAppSettingsService, useValue: whatsappSettings },
        { provide: ProjectSuspensionService, useValue: suspension },
      ],
    }).compile();

    scheduler = module.get(PushCampaignScheduleScheduler);
  });

  const claimReturns = (rows: unknown[]) => {
    qb.execute.mockImplementationOnce(async () => {
      callOrder.push('claim');
      return { raw: rows };
    });
  };

  it('claims only scheduled campaigns whose time has come', async () => {
    await scheduler.promoteDueCampaigns();

    expect(qb.set).toHaveBeenCalledWith({ status: 'queued' });
    expect(qb.where).toHaveBeenCalledWith('status = :status', {
      status: 'scheduled',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'scheduled_at <= :now',
      expect.objectContaining({ now: expect.any(Date) }),
    );
  });

  it('enqueues each claimed campaign with the log id as the job id', async () => {
    claimReturns([{ id: 'log-1', project_id: 'proj-1' }]);

    await expect(scheduler.promoteDueCampaigns()).resolves.toBe(1);

    expect(pushQueue.add).toHaveBeenCalledWith(
      JOB_DISPATCH_CAMPAIGN,
      { logId: 'log-1', projectId: 'proj-1' },
      { jobId: 'log-1' },
    );
  });

  it('claims before enqueuing, never the other way round', async () => {
    claimReturns([{ id: 'log-1', project_id: 'proj-1' }]);

    await scheduler.promoteDueCampaigns();

    // removeOnComplete evicts finished jobs, so jobId dedup is not durable and
    // a re-add after eviction would create a second job. Claiming first makes
    // the worst case a campaign stuck in `queued` with no job — which the
    // reconciliation sweep reports — rather than one audience blasted twice.
    expect(callOrder).toEqual(['claim', 'enqueue']);
  });

  it('returns a campaign to scheduled when the enqueue fails', async () => {
    claimReturns([{ id: 'log-1', project_id: 'proj-1' }]);
    pushQueue.add.mockRejectedValueOnce(new Error('redis down'));

    await expect(scheduler.promoteDueCampaigns()).resolves.toBe(0);

    // Handing it back means the next tick retries, rather than leaving it
    // stranded in `queued` for the reconciliation sweep to fail.
    expect(logRepository.update).toHaveBeenCalledWith(
      { id: 'log-1', status: 'queued' },
      { status: 'scheduled' },
    );
  });

  it('does nothing when no campaign is due', async () => {
    await expect(scheduler.promoteDueCampaigns()).resolves.toBe(0);
    expect(pushQueue.add).not.toHaveBeenCalled();
  });

  describe('recurring campaigns', () => {
    const template = (over: Record<string, unknown> = {}) => ({
      id: 'rec-1',
      projectId: 'proj-1',
      title: 'Weekly digest',
      targetType: 'project',
      targetDeviceIds: null,
      variants: null,
      controlPercentage: null,
      deliverInRecipientTimezone: false,
      localSendTime: null,
      scheduledAt: new Date('2026-06-15T03:30:00Z'),
      recurrence: {
        frequency: 'daily',
        interval: 1,
        atTime: '09:00',
        timezone: 'Asia/Kolkata',
      },
      ...over,
    });

    it('spawns an occurrence and advances the template', async () => {
      logRepository.find.mockResolvedValueOnce([template()]);

      await expect(scheduler.spawnRecurringOccurrences()).resolves.toBe(1);

      // The template moves on to the next slot...
      const advance = logRepository.update.mock.calls.find(
        (c) => 'scheduledAt' in (c[1] as object),
      );
      expect(advance).toBeDefined();
      // ...and the occurrence fires at the slot that just came due.
      const [occurrence] = logRepository.save.mock.calls[0];
      expect(occurrence.parentCampaignId).toBe('rec-1');
      expect(occurrence.recurrence).toBeNull();
      expect(occurrence.status).toBe('scheduled');
    });

    it('carries the whole message onto every occurrence', async () => {
      const actions = [{ id: 'view', title: 'View' }];
      const translations = { hi: { title: 'नमस्ते' } };
      logRepository.find.mockResolvedValueOnce([
        template({
          actions,
          iosCategory: 'PROMO',
          translations,
          sendTimeOptimised: true,
        }),
      ]);

      await scheduler.spawnRecurringOccurrences();

      // The template itself never sends — an occurrence is the only thing that
      // does. A field missed here is dropped from every send in the series,
      // not from one of them, so a recurring campaign with action buttons
      // would never have delivered a single button.
      const [occurrence] = logRepository.save.mock.calls[0];
      expect(occurrence.actions).toEqual(actions);
      expect(occurrence.iosCategory).toBe('PROMO');
      expect(occurrence.translations).toEqual(translations);
      expect(occurrence.sendTimeOptimised).toBe(true);
    });

    it('claims optimistically on the timestamp it read', async () => {
      logRepository.find.mockResolvedValueOnce([template()]);

      await scheduler.spawnRecurringOccurrences();

      // A template stays `scheduled` forever, so it cannot be claimed by
      // flipping status. Two instances racing must not both spawn a send.
      const advance = logRepository.update.mock.calls.find(
        (c) => 'scheduledAt' in (c[1] as object),
      );
      expect(advance![0]).toEqual({
        id: 'rec-1',
        scheduledAt: new Date('2026-06-15T03:30:00Z'),
      });
    });

    it('spawns nothing when it loses the race', async () => {
      logRepository.find.mockResolvedValueOnce([template()]);
      logRepository.update.mockResolvedValue({ affected: 0 });

      await expect(scheduler.spawnRecurringOccurrences()).resolves.toBe(0);
      expect(logRepository.save).not.toHaveBeenCalled();
    });

    it('ends the series once past its end date', async () => {
      logRepository.find.mockResolvedValueOnce([
        template({
          recurrence: {
            frequency: 'daily',
            interval: 1,
            atTime: '09:00',
            timezone: 'Asia/Kolkata',
            endsAt: '2026-06-15T04:00:00Z',
          },
        }),
      ]);

      await expect(scheduler.spawnRecurringOccurrences()).resolves.toBe(0);
      expect(logRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rec-1' }),
        expect.objectContaining({ status: 'expanded' }),
      );
      expect(logRepository.save).not.toHaveBeenCalled();
    });

    it('carries variants and local-time settings onto the occurrence', async () => {
      logRepository.find.mockResolvedValueOnce([
        template({
          variants: [{ key: 'A', title: 'A', weight: 100 }],
          deliverInRecipientTimezone: true,
          localSendTime: '09:00',
        }),
      ]);

      await scheduler.spawnRecurringOccurrences();

      const [occurrence] = logRepository.save.mock.calls[0];
      // So a recurring campaign can also be an experiment or a local-time
      // send: the later sweeps pick the occurrence up on the same tick.
      expect(occurrence.variants).toHaveLength(1);
      expect(occurrence.deliverInRecipientTimezone).toBe(true);
    });

    it('never sends or expands the template itself', async () => {
      await scheduler.promoteDueCampaigns();
      expect(qb.andWhere).toHaveBeenCalledWith('recurrence IS NULL');
    });
  });

  describe('experiment expansion', () => {
    const variants = [
      { key: 'A', title: 'First copy', weight: 50 },
      { key: 'B', title: 'Second copy', weight: 50 },
    ];

    const claimExperiment = (overrides: Record<string, unknown> = {}) => {
      logRepository.metadata.columns = [
        'id', 'projectId', 'title', 'body', 'targetType', 'targetDeviceIds',
        'variants', 'controlPercentage', 'deliverInRecipientTimezone',
        'localSendTime', 'scheduledAt', 'silent', 'actions', 'iosCategory',
        'sendTimeOptimised',
      ].map((propertyName) => ({ propertyName, databaseName: propertyName })) as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'exp-1',
            projectId: 'proj-1',
            title: 'Parent',
            body: 'Parent body',
            targetType: 'project',
            targetDeviceIds: null,
            variants,
            controlPercentage: 0,
            deliverInRecipientTimezone: false,
            localSendTime: null,
            scheduledAt: new Date(),
            silent: false,
            ...overrides,
          },
        ],
      }));
    };

    it('gives every arm the campaign\'s buttons and send-time setting', async () => {
      const actions = [{ id: 'view', title: 'View' }];
      claimExperiment({
        actions,
        iosCategory: 'PROMO',
        sendTimeOptimised: true,
      });
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => `d${i}`),
      );

      await scheduler.expandVariantCampaigns();

      // Buttons are campaign-level furniture, not the thing under test, so
      // both arms carry the same set — an arm that silently lost them would
      // be a different message, which is exactly what an experiment must not
      // introduce.
      const children = logRepository.save.mock.calls[0][0];
      for (const child of children) {
        expect(child.actions).toEqual(actions);
        expect(child.iosCategory).toBe('PROMO');
        expect(child.sendTimeOptimised).toBe(true);
      }
    });

    it('splits a device-targeted experiment only over its own project\'s devices', async () => {
      // targetDeviceIds is stored, and a campaign saved before ids were checked
      // at creation can name another tenant's devices. The reader filters by
      // project, so the project has to travel with the ids.
      claimExperiment({ targetType: 'devices', targetDeviceIds: ['d1', 'foreign'] });
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(['d1']);

      await scheduler.expandVariantCampaigns();

      expect(pushTokensService.listDeviceIdentityIds).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceIdentityIds: ['d1', 'foreign'],
      });
    });

    it('creates one child per arm, each carrying that arm\'s copy', async () => {
      claimExperiment();
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => `d${i}`),
      );

      await expect(scheduler.expandVariantCampaigns()).resolves.toBe(1);

      const children = logRepository.save.mock.calls[0][0];
      expect(children).toHaveLength(2);
      expect(children.map((c: any) => c.variantKey).sort()).toEqual(['A', 'B']);
      expect(children.find((c: any) => c.variantKey === 'A').title).toBe('First copy');
      expect(children.find((c: any) => c.variantKey === 'B').title).toBe('Second copy');
    });

    it('gives the arms disjoint audiences that together cover everyone', async () => {
      claimExperiment();
      const audience = Array.from({ length: 200 }, (_, i) => `d${i}`);
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(audience);

      await scheduler.expandVariantCampaigns();

      const children = logRepository.save.mock.calls[0][0];
      const assigned = children.flatMap((c: any) => c.targetDeviceIds);
      // Overlap would double-message someone; a gap would silently drop them.
      expect(new Set(assigned).size).toBe(assigned.length);
      expect(assigned).toHaveLength(audience.length);
    });

    it('records the control slice on the parent and sends it nothing', async () => {
      claimExperiment({ controlPercentage: 20 });
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => `d${i}`),
      );

      await scheduler.expandVariantCampaigns();

      const controlUpdate = logRepository.update.mock.calls.find(
        (c) => 'controlDeviceIds' in (c[1] as object),
      );
      expect(controlUpdate).toBeDefined();
      const held = (controlUpdate![1] as any).controlDeviceIds as string[];
      expect(held.length).toBeGreaterThan(0);

      // No child exists for control — withholding is the whole point.
      const children = logRepository.save.mock.calls[0][0];
      const sentTo = children.flatMap((c: any) => c.targetDeviceIds);
      expect(sentTo.some((id: string) => held.includes(id))).toBe(false);
    });

    it('passes local-time delivery down so each arm splits by timezone too', async () => {
      claimExperiment({ deliverInRecipientTimezone: true, localSendTime: '09:00' });
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(['d1', 'd2']);

      await scheduler.expandVariantCampaigns();

      const children = logRepository.save.mock.calls[0][0];
      // Inherited, so the timezone sweep claims them next and produces
      // variants x timezones with no extra machinery.
      expect(children.every((c: any) => c.deliverInRecipientTimezone)).toBe(true);
      expect(children.every((c: any) => c.localSendTime === '09:00')).toBe(true);
    });

    it('marks the parent expanded, never queued', async () => {
      claimExperiment();
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(['d1', 'd2']);

      await scheduler.expandVariantCampaigns();

      // Sending the parent would deliver one arm's copy to everyone and record
      // no variant at all.
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'expanded' }),
      );
    });

    it('skips an arm that drew nobody rather than creating an empty send', async () => {
      claimExperiment({
        variants: [
          { key: 'A', title: 'A', weight: 99.9 },
          { key: 'B', title: 'B', weight: 0.1 },
        ],
      });
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(['d1']);

      await scheduler.expandVariantCampaigns();

      const children = logRepository.save.mock.calls[0][0];
      expect(children.every((c: any) => c.targetDeviceIds.length > 0)).toBe(true);
    });

    it('gives each arm its own languages, never the campaign\'s', async () => {
      claimExperiment({
        variants: [
          {
            key: 'A',
            title: 'First copy',
            weight: 50,
            translations: { hi: { title: 'पहला' } },
          },
          { key: 'B', title: 'Second copy', weight: 50 },
        ],
      });
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, i) => `d${i}`),
      );

      await scheduler.expandVariantCampaigns();

      const children = logRepository.save.mock.calls[0][0];
      const a = children.find((c: any) => c.variantKey === 'A');
      const b = children.find((c: any) => c.variantKey === 'B');

      // Per-arm, because a campaign-level translation would replace the copy
      // the arm is testing — the one thing an experiment must not do.
      expect(a.translations).toEqual({ hi: { title: 'पहला' } });
      expect(b.translations).toBeNull();
    });

    it('marks the parent failed if the split breaks', async () => {
      claimExperiment();
      pushTokensService.listDeviceIdentityIds.mockRejectedValueOnce(
        new Error('db down'),
      );

      await expect(scheduler.expandVariantCampaigns()).resolves.toBe(0);
      expect(logRepository.update).toHaveBeenCalledWith(
        { id: 'exp-1' },
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('never lets an experiment parent reach the ordinary promotion sweep', async () => {
      await scheduler.promoteDueCampaigns();
      expect(qb.andWhere).toHaveBeenCalledWith('variants IS NULL');
    });
  });

  describe('per-timezone expansion', () => {
    const parentColumns = [
      'id', 'projectId', 'title', 'body', 'targetType', 'targetDeviceIds',
      'localSendTime', 'silent', 'deepLinkUrl', 'sendTimeOptimised',
      'actions', 'iosCategory', 'translations', 'variantKey',
    ].map((propertyName) => ({
      propertyName,
      databaseName: propertyName,
    }));

    const claimParent = (overrides: Record<string, unknown> = {}) => {
      logRepository.metadata.columns = parentColumns as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'parent-1',
            projectId: 'proj-1',
            title: 'Morning offer',
            body: 'Open the app',
            targetType: 'project',
            targetDeviceIds: null,
            localSendTime: '09:00',
            silent: false,
            deepLinkUrl: null,
            ...overrides,
          },
        ],
      }));
    };

    it('carries the message and the arm it belongs to onto every wave', async () => {
      const actions = [{ id: 'view', title: 'View' }];
      const translations = { hi: { title: 'नमस्ते' } };
      claimParent({
        actions,
        iosCategory: 'PROMO',
        translations,
        // This parent is itself an experiment arm being split by timezone.
        variantKey: 'A',
      });
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([
          ['Asia/Kolkata', ['d1', 'd2']],
          ['America/New_York', ['d3']],
        ]),
      );

      await scheduler.expandLocalTimeCampaigns();

      const children = logRepository.save.mock.calls[0][0];
      for (const child of children) {
        expect(child.actions).toEqual(actions);
        expect(child.iosCategory).toBe('PROMO');
        expect(child.translations).toEqual(translations);
        // Without this the wave is unattributable, and an experiment run in
        // local time reports nothing for the arm that actually sent.
        expect(child.variantKey).toBe('A');
        // The wave's hour is already resolved; re-flagging it would ask the
        // sweep to split an already-split campaign again.
        expect(child.sendTimeOptimised).toBeUndefined();
      }
    });

    it('groups a device-targeted parent only over its own project\'s devices', async () => {
      claimParent({ targetType: 'segment', targetDeviceIds: ['d1', 'foreign'] });
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['Asia/Kolkata', ['d1']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      expect(pushTokensService.groupDeviceIdentitiesByTimezone).toHaveBeenCalledWith(
        { projectId: 'proj-1', deviceIdentityIds: ['d1', 'foreign'] },
        expect.any(String),
      );
    });

    it('creates one child per timezone, each with its own send time', async () => {
      claimParent();
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([
          ['Asia/Kolkata', ['d1', 'd2']],
          ['America/New_York', ['d3']],
        ]),
      );

      await expect(scheduler.expandLocalTimeCampaigns()).resolves.toBe(1);

      const children = logRepository.save.mock.calls[0][0];
      expect(children).toHaveLength(2);
      expect(children.every((c: any) => c.parentCampaignId === 'parent-1')).toBe(true);
      // The whole point: one campaign becomes several sends at different
      // instants, each 09:00 on its own recipients' clocks.
      const times = children.map((c: any) => c.scheduledAt.toISOString());
      expect(new Set(times).size).toBe(2);
    });

    it('marks the parent expanded, never queued', async () => {
      claimParent();
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['UTC', ['d1']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      // Sending the parent would deliver at one instant to everybody, which is
      // exactly what the feature exists to avoid.
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'expanded' }),
      );
    });

    it('gives children an explicit device list so they never re-resolve the audience', async () => {
      claimParent();
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['Asia/Tokyo', ['d1', 'd2', 'd3']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      const [child] = logRepository.save.mock.calls[0][0];
      expect(child.targetType).toBe('devices');
      expect(child.targetDeviceIds).toEqual(['d1', 'd2', 'd3']);
      // A child re-resolving "everyone in the project" would send to every
      // timezone, defeating the split entirely.
      expect(child.totalTokens).toBe(3);
    });

    it('carries the parent content onto every child', async () => {
      claimParent({ silent: true, deepLinkUrl: '/offers/1' });
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['UTC', ['d1']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      const [child] = logRepository.save.mock.calls[0][0];
      expect(child).toMatchObject({
        title: 'Morning offer',
        body: 'Open the app',
        silent: true,
        deepLinkUrl: '/offers/1',
        status: 'scheduled',
      });
    });

    it('falls back for a device reporting a timezone that does not exist', async () => {
      claimParent();
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['Mars/Olympus', ['d1']]]),
      );

      // A device can report any string. Throwing would strand the whole
      // campaign because of one bad row.
      await expect(scheduler.expandLocalTimeCampaigns()).resolves.toBe(1);
      const [child] = logRepository.save.mock.calls[0][0];
      expect(child.scheduledAt).toBeInstanceOf(Date);
    });

    it('saves nothing when the audience has no reachable devices', async () => {
      claimParent();
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map(),
      );

      await scheduler.expandLocalTimeCampaigns();

      expect(logRepository.save).not.toHaveBeenCalled();
    });

    it('pushes a wave out of the project quiet window, per zone', async () => {
      claimParent({ localSendTime: '23:30' });
      configRepository.findOne.mockResolvedValueOnce({
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
      });
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['Asia/Kolkata', ['d1']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      const [child] = logRepository.save.mock.calls[0][0];
      const localHour = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }).format(child.scheduledAt);
      // 23:30 falls inside 22:00-08:00, so the wave moves to the window's end
      // rather than waking that zone's recipients in the middle of the night.
      expect(localHour).toBe('08:00');
    });

    it('splits a zone again by each recipient\'s own best hour', async () => {
      claimParent({ sendTimeOptimised: true, localSendTime: '09:00' });
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['Asia/Kolkata', ['d1', 'd2', 'd3']]]),
      );
      pushAnalytics.clickHoursForDevices.mockResolvedValueOnce([
        { deviceIdentityId: 'd1', hour: 7, clicks: 5 },
        { deviceIdentityId: 'd2', hour: 20, clicks: 6 },
        // d3 has no history and falls to the default hour.
      ]);

      await scheduler.expandLocalTimeCampaigns();

      const children = logRepository.save.mock.calls[0][0];
      // One timezone, three habits: 07:00, 20:00, and the 09:00 default.
      expect(children).toHaveLength(3);
      const assigned = children.flatMap((c: any) => c.targetDeviceIds).sort();
      // Optimisation changes *when*, never *who* — nobody is dropped for
      // having no click history.
      expect(assigned).toEqual(['d1', 'd2', 'd3']);
    });

    it('does not consult click history for an unoptimised campaign', async () => {
      claimParent();
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['UTC', ['d1']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      expect(pushAnalytics.clickHoursForDevices).not.toHaveBeenCalled();
    });

    it('marks the parent failed if the split itself breaks', async () => {
      claimParent();
      pushTokensService.groupDeviceIdentitiesByTimezone.mockRejectedValueOnce(
        new Error('db down'),
      );

      await expect(scheduler.expandLocalTimeCampaigns()).resolves.toBe(0);

      // The parent is already claimed out of `scheduled`, so leaving it as
      // `expanded` with no children would silently send nothing.
      expect(logRepository.update).toHaveBeenCalledWith(
        { id: 'parent-1' },
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  describe('email campaigns', () => {
    const emailContent = {
      subject: 'Parent subject',
      html: '<p>Parent html</p>',
      text: 'Parent text',
      preheader: 'Parent preheader',
    };

    it('splits an email experiment over email recipients, not push tokens', async () => {
      logRepository.metadata.columns = [
        'id', 'projectId', 'channel', 'emailContent', 'title', 'body',
        'targetType', 'targetDeviceIds', 'variants', 'controlPercentage',
        'deliverInRecipientTimezone', 'localSendTime', 'scheduledAt',
      ].map((propertyName) => ({ propertyName, databaseName: propertyName })) as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'exp-1',
            projectId: 'proj-1',
            channel: 'email',
            emailContent,
            title: 'Parent subject',
            body: 'Parent text',
            targetType: 'segment',
            targetDeviceIds: ['d1', 'd2'],
            variants: [
              { key: 'A', title: 'Subject A', html: '<p>A</p>', weight: 50 },
              { key: 'B', title: 'Subject B', weight: 50 },
            ],
            controlPercentage: 0,
            deliverInRecipientTimezone: false,
            localSendTime: null,
            scheduledAt: new Date(),
          },
        ],
      }));
      emailAudience.listRecipientIds.mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => `d${i}`),
      );

      await scheduler.expandVariantCampaigns();

      expect(pushTokensService.listDeviceIdentityIds).not.toHaveBeenCalled();
      expect(emailAudience.listRecipientIds).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceIdentityIds: ['d1', 'd2'],
        requireOptIn: true,
      });

      const [children] = logRepository.save.mock.calls[0];
      const byKey = Object.fromEntries(children.map((c: any) => [c.variantKey, c]));
      expect(byKey.A).toMatchObject({
        channel: 'email',
        emailContent: {
          subject: 'Subject A',
          html: '<p>A</p>',
          text: 'Parent text',
          preheader: 'Parent preheader',
        },
      });
      // An arm without its own HTML sends the campaign's, under its own subject.
      expect(byKey.B.emailContent).toMatchObject({
        subject: 'Subject B',
        html: '<p>Parent html</p>',
      });
    });

    it('splits an email campaign by timezone over email recipients', async () => {
      logRepository.metadata.columns = [
        'id', 'projectId', 'channel', 'emailContent', 'title', 'targetType',
        'targetDeviceIds', 'localSendTime',
      ].map((propertyName) => ({ propertyName, databaseName: propertyName })) as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'parent-1',
            projectId: 'proj-1',
            channel: 'email',
            emailContent,
            title: 'Parent subject',
            targetType: 'project',
            targetDeviceIds: null,
            localSendTime: '09:00',
          },
        ],
      }));
      emailAudience.groupByTimezone.mockResolvedValueOnce(
        new Map([['Asia/Kolkata', ['d1']], ['Europe/London', ['d2']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      expect(pushTokensService.groupDeviceIdentitiesByTimezone).not.toHaveBeenCalled();
      expect(emailAudience.groupByTimezone).toHaveBeenCalledWith(
        { projectId: 'proj-1', deviceIdentityIds: null, requireOptIn: true },
        expect.any(String),
      );
      const [children] = logRepository.save.mock.calls[0];
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child).toMatchObject({ channel: 'email', emailContent });
      }
    });
  });

  describe('WhatsApp campaigns', () => {
    const parentContent = {
      template: { id: 'promo', name: 'promo', language: 'en' },
      bodyParams: ['{{firstName|there}}'],
    };

    it('splits a WhatsApp experiment over WhatsApp recipients, each arm with its own template', async () => {
      logRepository.metadata.columns = [
        'id', 'projectId', 'channel', 'whatsappContent', 'title', 'body',
        'targetType', 'targetDeviceIds', 'variants', 'controlPercentage',
        'deliverInRecipientTimezone', 'localSendTime', 'scheduledAt',
      ].map((propertyName) => ({ propertyName, databaseName: propertyName })) as never;
      const armB = { template: { id: 'promo_v2', name: 'promo_v2', language: 'en' }, bodyParams: ['x'] };
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'exp-wa',
            projectId: 'proj-1',
            channel: 'whatsapp',
            whatsappContent: parentContent,
            title: 'Promo',
            body: 'Hi',
            targetType: 'project',
            targetDeviceIds: null,
            variants: [
              { key: 'A', title: 'A', weight: 50 },
              { key: 'B', title: 'B', weight: 50, whatsapp: armB },
            ],
            controlPercentage: 0,
            deliverInRecipientTimezone: false,
            localSendTime: null,
            scheduledAt: new Date(),
          },
        ],
      }));
      whatsappAudience.listRecipientIds.mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => `d${i}`),
      );

      await scheduler.expandVariantCampaigns();

      expect(smsAudience.listRecipientIds).not.toHaveBeenCalled();
      expect(whatsappAudience.listRecipientIds).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceIdentityIds: null,
        requireOptIn: true,
      });
      const [children] = logRepository.save.mock.calls[0];
      const byKey = Object.fromEntries(children.map((c: any) => [c.variantKey, c]));
      // An arm without its own template sends the campaign's.
      expect(byKey.A).toMatchObject({ channel: 'whatsapp', whatsappContent: parentContent });
      expect(byKey.B).toMatchObject({ channel: 'whatsapp', whatsappContent: armB });
    });

    it('splits a WhatsApp campaign by timezone over WhatsApp recipients', async () => {
      logRepository.metadata.columns = [
        'id', 'projectId', 'channel', 'whatsappContent', 'title', 'targetType',
        'targetDeviceIds', 'localSendTime',
      ].map((propertyName) => ({ propertyName, databaseName: propertyName })) as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'parent-wa',
            projectId: 'proj-1',
            channel: 'whatsapp',
            whatsappContent: parentContent,
            title: 'Promo',
            targetType: 'project',
            targetDeviceIds: null,
            localSendTime: '10:00',
          },
        ],
      }));
      whatsappAudience.groupByTimezone.mockResolvedValueOnce(
        new Map([['Asia/Kolkata', ['d1']], ['Asia/Dubai', ['d2']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      expect(whatsappAudience.groupByTimezone).toHaveBeenCalled();
      const [children] = logRepository.save.mock.calls[0];
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child).toMatchObject({ channel: 'whatsapp', whatsappContent: parentContent });
      }
    });
  });

  describe('SMS campaigns', () => {
    it('splits an SMS experiment over SMS recipients under the SMS consent policy', async () => {
      logRepository.metadata.columns = [
        'id', 'projectId', 'channel', 'emailContent', 'title', 'body',
        'targetType', 'targetDeviceIds', 'variants', 'controlPercentage',
        'deliverInRecipientTimezone', 'localSendTime', 'scheduledAt',
      ].map((propertyName) => ({ propertyName, databaseName: propertyName })) as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'exp-sms',
            projectId: 'proj-1',
            channel: 'sms',
            emailContent: null,
            title: 'Sale',
            body: 'Parent text',
            targetType: 'project',
            targetDeviceIds: null,
            variants: [
              { key: 'A', title: 'Short', body: '20% off today', weight: 50 },
              { key: 'B', title: 'Long', body: '20% off everything, today only', weight: 50 },
            ],
            controlPercentage: 0,
            deliverInRecipientTimezone: false,
            localSendTime: null,
            scheduledAt: new Date(),
          },
        ],
      }));
      smsAudience.listRecipientIds.mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => `d${i}`),
      );

      await scheduler.expandVariantCampaigns();

      expect(pushTokensService.listDeviceIdentityIds).not.toHaveBeenCalled();
      expect(emailAudience.listRecipientIds).not.toHaveBeenCalled();
      // The SMS setting, not the email one: they are separate consents.
      expect(smsAudience.listRecipientIds).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceIdentityIds: null,
        requireOptIn: false,
      });

      const [children] = logRepository.save.mock.calls[0];
      const byKey = Object.fromEntries(children.map((c: any) => [c.variantKey, c]));
      expect(byKey.A).toMatchObject({ channel: 'sms', body: '20% off today', emailContent: null });
      expect(byKey.B).toMatchObject({ channel: 'sms', body: '20% off everything, today only' });
    });

    it('splits an SMS campaign by timezone over SMS recipients', async () => {
      logRepository.metadata.columns = [
        'id', 'projectId', 'channel', 'title', 'body', 'targetType',
        'targetDeviceIds', 'localSendTime',
      ].map((propertyName) => ({ propertyName, databaseName: propertyName })) as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'parent-sms',
            projectId: 'proj-1',
            channel: 'sms',
            title: 'Sale',
            body: 'Hi {{firstName|there}}',
            targetType: 'segment',
            targetDeviceIds: ['d1', 'd2'],
            localSendTime: '10:00',
          },
        ],
      }));
      smsAudience.groupByTimezone.mockResolvedValueOnce(
        new Map([['Asia/Kolkata', ['d1']], ['America/New_York', ['d2']]]),
      );

      await scheduler.expandLocalTimeCampaigns();

      expect(pushTokensService.groupDeviceIdentitiesByTimezone).not.toHaveBeenCalled();
      expect(smsAudience.groupByTimezone).toHaveBeenCalledWith(
        { projectId: 'proj-1', deviceIdentityIds: ['d1', 'd2'], requireOptIn: false },
        expect.any(String),
      );
      const [children] = logRepository.save.mock.calls[0];
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child).toMatchObject({ channel: 'sms', body: 'Hi {{firstName|there}}' });
      }
    });
  });

  it('skips a claimed row with no project id rather than enqueuing a broken job', async () => {
    claimReturns([{ id: 'log-1' }]);

    await expect(scheduler.promoteDueCampaigns()).resolves.toBe(0);
    expect(pushQueue.add).not.toHaveBeenCalled();
  });

  describe('content carried onto child campaigns', () => {
    /** What the message says. A child must send the same message. */
    const CONTENT = [
      'title', 'body', 'data', 'imageUrl', 'deepLinkUrl', 'silent',
      'deliveryOptions', 'actions', 'iosCategory', 'translations',
      // Rendered by the client, but still part of what the message says, so a
      // child campaign has to carry them like any other copy.
      'carousel', 'timer',
      // A child of an email campaign must itself be an email campaign, or it
      // is delivered as a push with the subject for a title.
      'channel', 'emailContent', 'whatsappContent',
    ];
    /** Who it goes to. Deliberately re-derived per child. */
    const AUDIENCE = [
      'targetType', 'targetDeviceIds', 'segmentId', 'totalTokens',
      'controlDeviceIds',
    ];
    /** When it goes out. Each child computes its own. */
    const SCHEDULE = [
      'scheduledAt', 'deliverInRecipientTimezone', 'sendTimeOptimised',
      'localSendTime', 'recurrence',
    ];
    /** Set by the send itself, never inherited. */
    const RUNTIME = [
      'status', 'processedTokens', 'successCount', 'failureCount',
      'failureDetails', 'lastTokenId', 'completedAt', 'errorMessage', 'sentAt',
      'updatedAt',
    ];
    /** Which campaign this is and where it sits in the tree. */
    const IDENTITY = [
      'id', 'projectId', 'parentCampaignId', 'variants', 'controlPercentage',
      'variantKey',
    ];

    it('accounts for every column the entity declares', () => {
      const declared = getMetadataArgsStorage()
        .columns.filter((c) => c.target === PushNotificationLogEntity)
        .map((c) => c.propertyName);
      const classified = [
        ...CONTENT, ...AUDIENCE, ...SCHEDULE, ...RUNTIME, ...IDENTITY,
      ];

      // A new column is a decision — is it part of the message a child must
      // carry? Failing here is the prompt to make that decision on purpose.
      expect(declared.filter((c) => !classified.includes(c))).toEqual([]);
      expect(classified.filter((c) => !declared.includes(c))).toEqual([]);
    });

    /** Every content field set to something recognisable. */
    const populated = {
      title: 'Parent title',
      body: 'Parent body',
      data: { k: 'v' },
      imageUrl: 'https://x.test/i.png',
      deepLinkUrl: 'https://x.test/go',
      silent: false,
      deliveryOptions: { priority: 'high' },
      actions: [{ id: 'view', title: 'View' }],
      iosCategory: 'PROMO',
      translations: { hi: { title: 'नमस्ते' } },
      channel: 'push',
      emailContent: { subject: 'Parent subject', html: '<p>Parent</p>' },
    };

    const columnsFor = (extra: string[]) =>
      [...Object.keys(populated), 'id', 'projectId', ...extra].map(
        (propertyName) => ({ propertyName, databaseName: propertyName }),
      );

    it('carries all of it onto a recurring occurrence', async () => {
      logRepository.find.mockResolvedValueOnce([
        {
          id: 'rec-1',
          projectId: 'proj-1',
          targetType: 'project',
          scheduledAt: new Date('2026-06-15T03:30:00Z'),
          recurrence: { frequency: 'daily', interval: 1, atTime: '09:00' },
          ...populated,
        },
      ]);

      await scheduler.spawnRecurringOccurrences();
      const [occurrence] = logRepository.save.mock.calls[0];

      // The template never sends; an occurrence is the only thing that does.
      for (const field of CONTENT) {
        expect({ field, value: occurrence[field] }).toEqual({
          field,
          value: populated[field as keyof typeof populated],
        });
      }
    });

    it('carries all of it onto a timezone wave', async () => {
      logRepository.metadata.columns = columnsFor([
        'targetType', 'targetDeviceIds', 'localSendTime', 'variantKey',
      ]) as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'parent-1',
            projectId: 'proj-1',
            targetType: 'project',
            targetDeviceIds: null,
            localSendTime: '09:00',
            variantKey: null,
            ...populated,
          },
        ],
      }));
      pushTokensService.groupDeviceIdentitiesByTimezone.mockResolvedValueOnce(
        new Map([['Asia/Kolkata', ['d1']]]),
      );

      await scheduler.expandLocalTimeCampaigns();
      const [children] = logRepository.save.mock.calls[0];

      for (const field of CONTENT) {
        expect({ field, value: children[0][field] }).toEqual({
          field,
          value: populated[field as keyof typeof populated],
        });
      }
    });

    it('carries all of it onto an experiment arm, bar what the arm overrides', async () => {
      // An arm replaces the copy under test and brings its own languages —
      // that is the experiment, not an oversight.
      const OVERRIDDEN = [
        'title', 'body', 'imageUrl', 'deepLinkUrl', 'translations',
        // An email arm's subject and HTML, and a WhatsApp arm's template,
        // are the copy under test (covered in their own describe blocks).
        'emailContent', 'whatsappContent',
      ];

      logRepository.metadata.columns = columnsFor([
        'targetType', 'targetDeviceIds', 'variants', 'controlPercentage',
        'deliverInRecipientTimezone', 'localSendTime', 'scheduledAt',
      ]) as never;
      qb.execute.mockImplementationOnce(async () => ({
        raw: [
          {
            id: 'exp-1',
            projectId: 'proj-1',
            targetType: 'project',
            targetDeviceIds: null,
            variants: [
              { key: 'A', title: 'First', weight: 50 },
              { key: 'B', title: 'Second', weight: 50 },
            ],
            controlPercentage: 0,
            deliverInRecipientTimezone: false,
            localSendTime: null,
            scheduledAt: new Date(),
            ...populated,
          },
        ],
      }));
      pushTokensService.listDeviceIdentityIds.mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => `d${i}`),
      );

      await scheduler.expandVariantCampaigns();
      const [children] = logRepository.save.mock.calls[0];

      for (const field of CONTENT.filter((f) => !OVERRIDDEN.includes(f))) {
        expect({ field, value: children[0][field] }).toEqual({
          field,
          value: populated[field as keyof typeof populated],
        });
      }
    });
  });

  describe('suspended tenants', () => {
    it('does nothing extra when nobody is suspended', async () => {
      await scheduler.retireDueCampaignsOfSuspendedTenants();

      expect(logRepository.update).not.toHaveBeenCalled();
      expect(logRepository.find).not.toHaveBeenCalled();
    });

    it('retires before any sweep can claim, and a failed read stops the whole tick', async () => {
      suspension.suspendedProjectIds.mockRejectedValueOnce(new Error('connection lost'));

      await expect(scheduler.handleTick()).rejects.toThrow('connection lost');

      expect(logRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(pushQueue.add).not.toHaveBeenCalled();
    });
  });
});

describe('scheduled campaigns and the reconciliation sweep', () => {
  it('keeps `scheduled` out of NON_TERMINAL_STATUSES', () => {
    // PushCampaignReconciliationScheduler sweeps exactly this list for rows
    // whose updatedAt has not moved in 15 minutes and marks them abandoned. A
    // campaign scheduled for next week has no job by design, so including it
    // here would kill every scheduled campaign a quarter of an hour after it
    // was created.
    expect(NON_TERMINAL_STATUSES).not.toContain('scheduled');
    expect(NON_TERMINAL_STATUSES).toEqual(['queued', 'sending']);
  });

  it('treats `cancelled` as terminal so nothing resumes it', () => {
    expect(TERMINAL_STATUSES).toContain('cancelled');
  });


});

/**
 * A structural guard against the way these bugs happened.
 *
 * Every expansion path builds its child by listing fields by hand, and each
 * campaign feature added since — deep links, silent push, delivery options,
 * translations, action buttons — had to be added to three separate lists.
 * `actions` and `iosCategory` were missed by all three, so buttons never
 * survived any expansion.
 *
 * The column list is read from the entity rather than restated here, so a new
 * column fails this suite until someone classifies it. Classifying it as
 * content then makes the carry-over tests below apply to it automatically.
 */

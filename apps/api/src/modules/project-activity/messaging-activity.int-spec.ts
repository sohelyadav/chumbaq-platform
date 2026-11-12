import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import type { ProjectActivityAction } from '@chumbaq/shared';
import { TRUST_PROXY } from '../../common/client-ip';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp, insertRow } from '../../test-support/sweep-fixtures';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { PushTokenEntity } from '../push-tokens/entities/push-token.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { PushTemplateEntity } from '../push-notifications/entities/push-template.entity';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { SegmentEntity } from '../segments/entities/segment.entity';
import { JourneyEntity } from '../journeys/entities/journey.entity';
import { InAppMessageEntity } from '../in-app-messages/entities/in-app-message.entity';
import { BannerCategoryEntity } from '../in-app-banners/entities/banner-category.entity';
import { InAppBannerEntity } from '../in-app-banners/entities/in-app-banner.entity';
import { LinkEntity } from '../links/entities/link.entity';
import { LinkVariantEntity } from '../links/entities/link-variant.entity';
import { MixpanelCohortEntity } from '../mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from '../mixpanel-cohorts/entities/mixpanel-cohort-member.entity';
import { PendingMessageEntity } from '../in-app-messages/entities/pending-message.entity';
import { EmailSettingsService } from '../email/email-settings.service';
import { SmsSettingsService } from '../sms/sms-settings.service';
import { WhatsAppSettingsService } from '../whatsapp/whatsapp-settings.service';
import { PushNotificationsService } from '../push-notifications/push-notifications.service';
import { EmailCampaignsService } from '../email/email-campaigns.service';
import { SmsCampaignsService } from '../sms/sms-campaigns.service';
import { WhatsAppCampaignsService } from '../whatsapp/whatsapp-campaigns.service';
import { ProjectActivityService } from './project-activity.service';

/**
 * The Messaging group of the activity log, written by the real routes against the real
 * database: each send, schedule, cancel, trigger, status change and delete writes
 * exactly one entry with the right actor, target, address and details (the audience
 * size where the send path counted one); test sends, previews, draft edits and no-ops
 * write none; a failed log write takes the action down with it; and
 * `push.sent_to_person` names the person by internal id only.
 *
 * Channel settings are stubbed as connected (so no provider is called) and the
 * campaign queue's `add` is stubbed, so nothing is delivered.
 *
 * `project_activity` is append-only and the int database is shared, so every assertion
 * reads only the rows of a project made in that test.
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@messaging-activity-int.test';
/** Sent as X-Forwarded-For from loopback, which `TRUST_PROXY` believes. */
const IP = '203.0.113.79';
const AGENT = 'messaging-activity-int/1';
const LATER = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

interface Person {
  id: string;
  token: string;
  label: string;
}

interface Row {
  action: ProjectActivityAction;
  actor_kind: string;
  actor_user_id: string | null;
  actor_label: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
}

/** One reachable person on every channel, and what identifies them outside Chumbaq. */
interface Audience {
  identityId: string;
  distinctId: string;
  externalUserId: string;
  fingerprint: string;
  email: string;
  phone: string;
  pushToken: string;
}

describe('Messaging activity (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let activity: ProjectActivityService;
  let queueAdd: jest.Mock;
  let restoreEnv: () => void = () => undefined;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  let seq = 0;
  let owner: Person;
  let member: Person;

  const cleanup = async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  const person = async (label: string): Promise<Person> => {
    const email = `${label}-${++seq}${DOMAIN}`;
    const name = `Name ${label}`;
    const id = (
      await ds.getRepository(UserEntity).save({ email, name, passwordHash: 'x', emailVerifiedAt: new Date() })
    ).id;
    const token = await jwt.signAsync({ sub: id, email, type: 'access', auth_time: Math.floor(Date.now() / 1000) });
    return { id, token, label: `${name} (${email})` };
  };

  /** A project billed to the owner, with the member as a `member`, and push switched on. */
  const project = async (): Promise<string> => {
    const id = (await ds.getRepository(ProjectEntity).save({ name: 'messaging', ownerId: owner.id })).id;
    await addOwnerMember(ds, id, owner.id);
    await addOwnerMember(ds, id, member.id, 'member');
    await insertRow(ds, PushConfigEntity, { projectId: id, isActive: true });
    return id;
  };

  const audience = async (projectId: string): Promise<Audience> => {
    const tag = randomUUID().slice(0, 8);
    const a = {
      distinctId: `distinct-${tag}`,
      externalUserId: `external-${tag}`,
      fingerprint: `fp-${tag}`,
      email: `person-${tag}@example.com`,
      phone: '+919812345678',
      pushToken: `push-token-${tag}`,
    };
    const identityId = await insertRow(ds, DeviceIdentityEntity, {
      projectId,
      distinctId: a.distinctId,
      externalUserId: a.externalUserId,
      deviceFingerprint: a.fingerprint,
      platform: 'ios',
      email: a.email,
      phone: a.phone,
      phoneE164: a.phone,
      emailOptIn: true,
      smsOptIn: true,
      whatsappOptIn: true,
      lastSeenAt: new Date(),
    });
    await insertRow(ds, PushTokenEntity, {
      projectId,
      deviceIdentityId: identityId,
      token: a.pushToken,
      platform: 'ios',
      provider: 'fcm',
      isActive: true,
    });
    return { identityId, ...a };
  };

  const call = async (method: string, path: string, who: Person, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${who.token}`,
        'content-type': 'application/json',
        'x-forwarded-for': IP,
        'user-agent': AGENT,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };

  /** A call that must succeed; its body is shown when it does not. */
  const ok = async (method: string, path: string, who: Person, body?: unknown) => {
    const res = await call(method, path, who, body);
    expect({ ok: res.status < 300, text: res.status < 300 ? '' : res.text }).toEqual({ ok: true, text: '' });
    return res.json?.data;
  };

  const rows = async (projectId: string): Promise<Row[]> =>
    ds.query(
      `SELECT action, actor_kind, actor_user_id, actor_label, target_type, target_id, target_label, details,
              ip_address, user_agent
         FROM project_activity WHERE project_id = $1 ORDER BY occurred_at, id`,
      [projectId],
    );

  /** The one row the action wrote, after `before` rows. */
  const onlyNew = async (projectId: string, before: number): Promise<Row> => {
    const all = await rows(projectId);
    expect(all.map((r) => r.action)).toHaveLength(before + 1);
    return all[all.length - 1];
  };

  const noneNew = async (projectId: string, before: number) => {
    expect((await rows(projectId)).map((r) => r.action)).toHaveLength(before);
  };

  /**
   * Holds every entry write for a moment before it goes ahead, inside the change's own
   * transaction, so a second request racing the first reads the row before the first
   * commits and then waits on its lock: the race a double click makes, every time.
   */
  const slowEntries = () => {
    const record = activity.record.bind(activity);
    jest.spyOn(activity, 'record').mockImplementation(async (...args: Parameters<typeof activity.record>) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return record(...args);
    });
  };

  const by = (who: Person) => ({
    actor_kind: 'user',
    actor_user_id: who.id,
    actor_label: who.label,
    ip_address: IP,
    user_agent: AGENT,
  });

  const campaign = (id: string, label: string) => ({ target_type: 'campaign', target_id: id, target_label: label });

  beforeAll(async () => {
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
    app.getHttpAdapter().getInstance().set('trust proxy', TRUST_PROXY);
    activity = app.get(ProjectActivityService);
    owner = await person('owner');
    member = await person('member');
  }, 120000);

  beforeEach(() => {
    // Nothing is delivered: each channel's handle on the campaign queue (modules
    // register it separately, so they are separate instances) only records that a job
    // was asked for.
    queueAdd = jest.fn().mockResolvedValue({});
    const queues = [
      (app.get(PushNotificationsService) as unknown as { pushQueue: Queue }).pushQueue,
      ...[EmailCampaignsService, SmsCampaignsService, WhatsAppCampaignsService].map(
        (service) => (app.get(service as never) as { queue: Queue }).queue,
      ),
    ];
    for (const queue of new Set(queues)) jest.spyOn(queue, 'add').mockImplementation(queueAdd);
    // Each channel is connected, with consent not required, so the audience counts
    // run for real without a provider account. Interakt cannot list templates, so
    // WhatsApp content is not checked against one.
    const connected = (provider: string) => async () => ({
      settings: { provider, requireOptIn: false } as never,
      credentials: {},
    });
    jest.spyOn(app.get(EmailSettingsService), 'requireSendable').mockImplementation(connected('resend'));
    jest.spyOn(app.get(SmsSettingsService), 'requireSendable').mockImplementation(connected('twilio'));
    jest.spyOn(app.get(WhatsAppSettingsService), 'requireSendable').mockImplementation(connected('interakt'));
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
  });

  describe('campaigns', () => {
    it('logs a push send with its channel and audience size, once', async () => {
      const p = await project();
      const a = await audience(p);
      const sent = await ok('POST', '/push-notifications/send', owner, {
        projectId: p,
        title: 'Diwali sale',
        deviceIdentityIds: [a.identityId],
      });
      expect(queueAdd).toHaveBeenCalledTimes(1);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'campaign.sent',
        ...by(owner),
        ...campaign(sent.id, 'Diwali sale'),
        details: { channel: 'push', audienceSize: 1 },
      });
    });

    it('logs a send with a future time as scheduled, and its cancel, and nothing for a second cancel', async () => {
      const p = await project();
      const a = await audience(p);
      const held = await ok('POST', '/push-notifications/send', owner, {
        projectId: p,
        title: 'Next week',
        deviceIdentityIds: [a.identityId],
        scheduledAt: LATER(),
      });
      expect(queueAdd).not.toHaveBeenCalled();
      expect(await onlyNew(p, 0)).toEqual({
        action: 'campaign.scheduled',
        ...by(owner),
        ...campaign(held.id, 'Next week'),
        details: { channel: 'push', audienceSize: 1 },
      });

      await ok('POST', `/push-notifications/cancel/${p}/${held.id}`, owner);
      expect(await onlyNew(p, 1)).toEqual({
        action: 'campaign.cancelled',
        ...by(owner),
        ...campaign(held.id, 'Next week'),
        details: { channel: 'push', audienceSize: 1 },
      });

      // Nothing left to cancel: refused, and no entry.
      expect((await call('POST', `/push-notifications/cancel/${p}/${held.id}`, owner)).status).toBe(400);
      expect((await call('POST', `/push-notifications/cancel/${p}/${randomUUID()}`, owner)).status).toBe(404);
      await noneNew(p, 2);
    });

    it('logs email, SMS and WhatsApp sends and schedules under their own channel', async () => {
      const p = await project();
      const a = await audience(p);
      const email = await ok('POST', '/email/send', owner, {
        projectId: p,
        subject: 'Weekly digest',
        html: '<p>Hello</p>',
        deviceIdentityIds: [a.identityId],
      });
      expect(await onlyNew(p, 0)).toEqual({
        action: 'campaign.sent',
        ...by(owner),
        ...campaign(email.id, 'Weekly digest'),
        details: { channel: 'email', audienceSize: 1 },
      });

      const sms = await ok('POST', '/sms/send', owner, {
        projectId: p,
        name: 'Flash sale text',
        body: 'Sale ends tonight',
        deviceIdentityIds: [a.identityId],
        scheduledAt: LATER(),
      });
      expect(await onlyNew(p, 1)).toEqual({
        action: 'campaign.scheduled',
        ...by(owner),
        ...campaign(sms.id, 'Flash sale text'),
        details: { channel: 'sms', audienceSize: 1 },
      });

      const wa = await ok('POST', '/whatsapp/send', owner, {
        projectId: p,
        name: 'Order update',
        content: { template: { id: 'order', name: 'order', language: 'en' }, bodyParams: [] },
        deviceIdentityIds: [a.identityId],
      });
      expect(await onlyNew(p, 2)).toEqual({
        action: 'campaign.sent',
        ...by(owner),
        ...campaign(wa.id, 'Order update'),
        details: { channel: 'whatsapp', audienceSize: 1 },
      });

      // The two immediate sends were enqueued; the held text was not.
      expect(queueAdd).toHaveBeenCalledTimes(2);

      // A cancel of an email campaign goes through the shared route and names its channel.
      const held = await ok('POST', '/email/send', owner, {
        projectId: p,
        subject: 'Held email',
        html: '<p>Later</p>',
        deviceIdentityIds: [a.identityId],
        scheduledAt: LATER(),
      });
      await ok('POST', `/push-notifications/cancel/${p}/${held.id}`, owner);
      const [scheduled, cancelled] = (await rows(p)).slice(3);
      expect([scheduled.action, scheduled.details]).toEqual(['campaign.scheduled', { channel: 'email', audienceSize: 1 }]);
      expect([cancelled.action, cancelled.target_id, cancelled.details]).toEqual([
        'campaign.cancelled',
        held.id,
        { channel: 'email', audienceSize: 1 },
      ]);
    });

    it('logs a member who sends as that member', async () => {
      const p = await project();
      const a = await audience(p);
      const sent = await ok('POST', '/push-notifications/send', member, {
        projectId: p,
        title: 'From a member',
        deviceIdentityIds: [a.identityId],
      });
      expect(await onlyNew(p, 0)).toEqual({
        action: 'campaign.sent',
        ...by(member),
        ...campaign(sent.id, 'From a member'),
        details: { channel: 'push', audienceSize: 1 },
      });
    });

    it('creates no campaign and enqueues nothing when the entry cannot be written', async () => {
      const p = await project();
      const a = await audience(p);
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      const res = await call('POST', '/push-notifications/send', owner, {
        projectId: p,
        title: 'Never sent',
        deviceIdentityIds: [a.identityId],
      });
      expect(res.status).toBe(500);
      expect(queueAdd).not.toHaveBeenCalled();
      expect(await ds.getRepository(PushNotificationLogEntity).count({ where: { projectId: p } })).toBe(0);
      await noneNew(p, 0);
    });

    it('writes nothing for a test send, an audience preview or a refused send', async () => {
      const p = await project();
      const a = await audience(p);
      await ok('POST', '/push-notifications/test-send', owner, { projectId: p, token: a.pushToken, dryRun: true });
      await ok('POST', '/push-notifications/audience-preview', owner, { projectId: p, deviceIdentityIds: [a.identityId] });
      await ok('POST', '/email/audience-preview', owner, { projectId: p, deviceIdentityIds: [a.identityId] });
      // Nobody reachable: a 400, and nothing was sent.
      expect(
        (await call('POST', '/push-notifications/send', owner, { projectId: p, title: 't', deviceIdentityIds: [randomUUID()] }))
          .status,
      ).toBe(400);
      await noneNew(p, 0);
    });
  });

  describe('held sends', () => {
    const daily = { frequency: 'daily', interval: 1, atTime: '09:00' };
    const arms = [
      { key: 'a', title: 'Arm A', weight: 50 },
      { key: 'b', title: 'Arm B', weight: 50 },
    ];

    it.each([
      ['a recurring push', { recurrence: daily }],
      ['an experiment', { variants: arms }],
      ['a local-time push', { deliverInRecipientTimezone: true }],
    ])('logs %s with no send time as scheduled, and enqueues nothing', async (_name, extra) => {
      const p = await project();
      const a = await audience(p);
      const held = await ok('POST', '/push-notifications/send', owner, {
        projectId: p,
        title: 'Held push',
        deviceIdentityIds: [a.identityId],
        ...extra,
      });
      expect(held.status).toBe('scheduled');
      expect(queueAdd).not.toHaveBeenCalled();
      expect(await onlyNew(p, 0)).toEqual({
        action: 'campaign.scheduled',
        ...by(owner),
        ...campaign(held.id, 'Held push'),
        details: { channel: 'push', audienceSize: 1 },
      });
    });

    it('logs held email and SMS sends as scheduled too', async () => {
      const p = await project();
      const a = await audience(p);
      const email = await ok('POST', '/email/send', owner, {
        projectId: p,
        subject: 'Every morning',
        html: '<p>Hello</p>',
        deviceIdentityIds: [a.identityId],
        recurrence: daily,
      });
      const sms = await ok('POST', '/sms/send', owner, {
        projectId: p,
        name: 'Local morning text',
        body: 'Good morning',
        deviceIdentityIds: [a.identityId],
        deliverInRecipientTimezone: true,
      });
      expect(queueAdd).not.toHaveBeenCalled();
      expect((await rows(p)).map((r) => [r.action, r.target_id, r.details])).toEqual([
        ['campaign.scheduled', email.id, { channel: 'email', audienceSize: 1 }],
        ['campaign.scheduled', sms.id, { channel: 'sms', audienceSize: 1 }],
      ]);
    });

    it('calls an unnamed SMS campaign "SMS campaign", never by its text, sent or cancelled', async () => {
      const p = await project();
      const a = await audience(p);
      const body = 'Ravi, your code is 482913';
      const held = await ok('POST', '/sms/send', owner, {
        projectId: p,
        body,
        deviceIdentityIds: [a.identityId],
        scheduledAt: LATER(),
      });
      await ok('POST', `/push-notifications/cancel/${p}/${held.id}`, owner);
      const all = await rows(p);
      expect(all.map((r) => [r.action, r.target_label])).toEqual([
        ['campaign.scheduled', 'SMS campaign'],
        ['campaign.cancelled', 'SMS campaign'],
      ]);
      const stored = JSON.stringify(all);
      for (const part of [body, '482913', 'Ravi']) expect(stored).not.toContain(part);
    });
  });

  describe('push to one person', () => {
    it('names the person by internal id only: no external id, distinct id, address or token', async () => {
      const p = await project();
      const a = await audience(p);
      await ok('POST', '/push-notifications/send-to-user', member, { projectId: p, distinctId: a.distinctId, title: 'Just you' });
      const row = await onlyNew(p, 0);
      expect(row).toEqual({
        action: 'push.sent_to_person',
        ...by(member),
        target_type: 'person',
        target_id: a.identityId,
        target_label: null,
        details: null,
      });
      const stored = JSON.stringify(row);
      for (const value of [a.distinctId, a.externalUserId, a.fingerprint, a.email, a.phone, a.pushToken]) {
        expect(stored).not.toContain(value);
      }
      // And it is that entry alone, not a campaign.sent beside it.
      expect((await rows(p)).map((r) => r.action)).toEqual(['push.sent_to_person']);
    });
  });

  describe('cohorts', () => {
    it('logs a cohort push and an in-app trigger once each, naming the cohort', async () => {
      const p = await project();
      const a = await audience(p);
      const cohortId = await insertRow(ds, MixpanelCohortEntity, { projectId: p, mixpanelCohortId: 77, name: 'Big spenders' });
      await insertRow(ds, MixpanelCohortMemberEntity, {
        cohortId,
        projectId: p,
        mixpanelDistinctId: a.distinctId,
        deviceIdentityId: a.identityId,
        resolvedBy: 'distinct_id',
        isResolved: true,
      });
      const cohortTarget = { target_type: 'cohort', target_id: cohortId, target_label: 'Big spenders' };

      await ok('POST', `/projects/${p}/mixpanel/cohorts/${cohortId}/push`, owner, { title: 'Cohort push' });
      expect(await onlyNew(p, 0)).toEqual({ action: 'cohort.push_sent', ...by(owner), ...cohortTarget, details: null });

      const messageId = await insertRow(ds, InAppMessageEntity, { projectId: p, name: 'Welcome card', messageType: 'modal', title: 'Hi' });
      const triggered = await ok('POST', `/projects/${p}/mixpanel/cohorts/${cohortId}/iam-trigger`, owner, { messageId });
      expect(triggered.queued).toBe(1);
      expect(await onlyNew(p, 1)).toEqual({ action: 'cohort.in_app_triggered', ...by(owner), ...cohortTarget, details: null });
    });

    /** A project whose one person is in a cohort, and a message to show them. */
    const cohortProject = async () => {
      const p = await project();
      const a = await audience(p);
      const cohortId = await insertRow(ds, MixpanelCohortEntity, { projectId: p, mixpanelCohortId: 78, name: 'Lapsed' });
      await insertRow(ds, MixpanelCohortMemberEntity, {
        cohortId,
        projectId: p,
        mixpanelDistinctId: a.distinctId,
        deviceIdentityId: a.identityId,
        resolvedBy: 'distinct_id',
        isResolved: true,
      });
      const messageId = await insertRow(ds, InAppMessageEntity, { projectId: p, name: 'Come back', messageType: 'modal', title: 'Hi' });
      return { p, a, cohortId, messageId };
    };

    const nothingMade = async (p: string) => {
      expect(queueAdd).not.toHaveBeenCalled();
      expect(await ds.getRepository(PushNotificationLogEntity).count({ where: { projectId: p } })).toBe(0);
      expect(await ds.getRepository(PendingMessageEntity).count({ where: { projectId: p } })).toBe(0);
      await noneNew(p, 0);
    };

    it('refuses a cohort in-app trigger for an unknown or another project\'s message, writing nothing', async () => {
      const { p, cohortId } = await cohortProject();
      const other = await cohortProject();
      for (const messageId of [randomUUID(), other.messageId]) {
        const res = await call('POST', `/projects/${p}/mixpanel/cohorts/${cohortId}/iam-trigger`, owner, { messageId });
        expect(res.status).toBe(404);
      }
      await nothingMade(p);
      await nothingMade(other.p);
    });

    it('refuses a cohort push with push switched off with the usual error, writing nothing', async () => {
      const { p, cohortId } = await cohortProject();
      await ds.getRepository(PushConfigEntity).update({ projectId: p }, { isActive: false });
      const res = await call('POST', `/projects/${p}/mixpanel/cohorts/${cohortId}/push`, owner, { title: 'x' });
      expect([res.status, res.json?.message]).toEqual([
        404,
        'Push notifications not configured for this project. Call configure first.',
      ]);
      await nothingMade(p);
    });

    it('makes no campaign when the cohort push entry cannot be written', async () => {
      const { p, cohortId } = await cohortProject();
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('POST', `/projects/${p}/mixpanel/cohorts/${cohortId}/push`, owner, { title: 'x' })).status).toBe(500);
      await nothingMade(p);
    });

    it('queues no message when the cohort in-app entry cannot be written', async () => {
      const { p, cohortId, messageId } = await cohortProject();
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('POST', `/projects/${p}/mixpanel/cohorts/${cohortId}/iam-trigger`, owner, { messageId })).status).toBe(500);
      await nothingMade(p);
    });

    it('queues no message when the in-app trigger entry cannot be written', async () => {
      const { p, a, messageId } = await cohortProject();
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      const res = await call('POST', `/projects/${p}/in-app-messages/trigger`, owner, {
        messageId,
        targetType: 'users',
        deviceFingerprints: [a.fingerprint],
      });
      expect(res.status).toBe(500);
      await nothingMade(p);
    });
  });

  describe('in-app messages', () => {
    it('logs a trigger, an activate and a pause, and nothing for a repeat, an empty trigger or a draft edit', async () => {
      const p = await project();
      const a = await audience(p);
      const id = await insertRow(ds, InAppMessageEntity, { projectId: p, name: 'Spring banner', messageType: 'modal', title: 'Spring' });
      const target = { target_type: 'in_app_message', target_id: id, target_label: 'Spring banner' };

      await ok('POST', `/projects/${p}/in-app-messages/trigger`, owner, {
        messageId: id,
        targetType: 'users',
        deviceFingerprints: [a.fingerprint],
      });
      expect(await onlyNew(p, 0)).toEqual({ action: 'in_app.triggered', ...by(owner), ...target, details: null });

      // Nobody to queue for: nothing happened.
      await ok('POST', `/projects/${p}/in-app-messages/trigger`, owner, { messageId: id, targetType: 'users', deviceFingerprints: [] });
      await noneNew(p, 1);

      // A draft edit is not logged.
      await ok('PATCH', `/projects/${p}/in-app-messages/${id}`, owner, { title: 'Spring, edited' });
      await noneNew(p, 1);

      await ok('POST', `/projects/${p}/in-app-messages/${id}/activate`, member);
      expect(await onlyNew(p, 1)).toEqual({ action: 'in_app_message.activated', ...by(member), ...target, details: null });
      await ok('POST', `/projects/${p}/in-app-messages/${id}/activate`, member);
      await noneNew(p, 2);

      await ok('POST', `/projects/${p}/in-app-messages/${id}/pause`, owner);
      expect(await onlyNew(p, 2)).toEqual({ action: 'in_app_message.paused', ...by(owner), ...target, details: null });

      // Activating through the edit route is still an activation.
      await ok('PATCH', `/projects/${p}/in-app-messages/${id}`, owner, { status: 'active' });
      expect((await onlyNew(p, 3)).action).toBe('in_app_message.activated');
    });

    it('logs an edit that moves an active message to any other status as paused, saying where it went', async () => {
      const p = await project();
      const target = (id: string) => ({ target_type: 'in_app_message', target_id: id, target_label: 'Summer modal' });
      let n = 0;
      for (const to of ['archived', 'completed', 'draft', 'scheduled'] as const) {
        const id = await insertRow(ds, InAppMessageEntity, {
          projectId: p,
          name: 'Summer modal',
          messageType: 'modal',
          title: 'Summer',
          status: 'active',
        });
        await ok('PATCH', `/projects/${p}/in-app-messages/${id}`, member, { status: to });
        expect(await onlyNew(p, n++)).toEqual({ action: 'in_app_message.paused', ...by(member), ...target(id), details: { to } });
        // Off active already: a second edit to the same status, or another off-air one, writes nothing.
        await ok('PATCH', `/projects/${p}/in-app-messages/${id}`, member, { status: to });
        await noneNew(p, n);
      }
      const archived = await insertRow(ds, InAppMessageEntity, { projectId: p, name: 'Old', messageType: 'modal', title: 't', status: 'draft' });
      await ok('PATCH', `/projects/${p}/in-app-messages/${archived}`, member, { status: 'archived' });
      await noneNew(p, n);
    });

    it('logs two activations racing on one message (a double click) once', async () => {
      const p = await project();
      const id = await insertRow(ds, InAppMessageEntity, { projectId: p, name: 'Twice', messageType: 'modal', title: 't', status: 'draft' });
      slowEntries();
      const both = await Promise.all([
        call('POST', `/projects/${p}/in-app-messages/${id}/activate`, owner),
        call('POST', `/projects/${p}/in-app-messages/${id}/activate`, owner),
      ]);
      expect(both.map((r) => r.status < 300)).toEqual([true, true]);
      expect((await rows(p)).map((r) => r.action)).toEqual(['in_app_message.activated']);
    });

    it('never lets an activation and an archive racing on one message leave a change unlogged', async () => {
      const p = await project();
      const id = await insertRow(ds, InAppMessageEntity, { projectId: p, name: 'Contested', messageType: 'modal', title: 't', status: 'draft' });
      slowEntries();
      const both = await Promise.all([
        call('POST', `/projects/${p}/in-app-messages/${id}/activate`, owner),
        call('PATCH', `/projects/${p}/in-app-messages/${id}`, member, { status: 'archived' }),
      ]);
      expect(both.map((r) => r.status < 300)).toEqual([true, true]);
      const [{ status }] = await ds.query('SELECT status FROM in_app_messages WHERE id = $1', [id]);
      // Both transactions start together, so entry time does not show which ran first.
      const actions = (await rows(p)).map((r) => r.action).sort();
      // The two take turns. Activate first: active, then archived off the air (logged
      // as paused, to archived). Archive first: archived quietly, then activated.
      if (status === 'archived') {
        expect(actions).toEqual(['in_app_message.activated', 'in_app_message.paused']);
      } else {
        expect(status).toBe('active');
        expect(actions).toEqual(['in_app_message.activated']);
      }
    });
  });

  describe('journeys', () => {
    it('logs a status change with from and to, and nothing for the same status or a draft edit', async () => {
      const p = await project();
      const segmentId = await insertRow(ds, SegmentEntity, {
        projectId: p,
        name: 'Indians',
        definition: { type: 'attribute', field: 'country', op: 'eq', value: 'IN' },
      });
      const id = await insertRow(ds, JourneyEntity, {
        projectId: p,
        name: 'Onboarding',
        trigger: { type: 'segment_entry', segmentId },
        steps: [{ type: 'send_push', title: 'Welcome' }],
      });
      const target = { target_type: 'journey', target_id: id, target_label: 'Onboarding' };

      await ok('PATCH', `/projects/${p}/journeys/${id}`, owner, { description: 'first week' });
      await noneNew(p, 0);

      await ok('POST', `/projects/${p}/journeys/${id}/status`, member, { status: 'active' });
      expect(await onlyNew(p, 0)).toEqual({
        action: 'journey.status_changed',
        ...by(member),
        ...target,
        details: { from: 'draft', to: 'active' },
      });
      await ok('POST', `/projects/${p}/journeys/${id}/status`, member, { status: 'active' });
      await noneNew(p, 1);

      await ok('POST', `/projects/${p}/journeys/${id}/status`, owner, { status: 'paused' });
      expect((await onlyNew(p, 1)).details).toEqual({ from: 'active', to: 'paused' });
    });

    it('logs two activations racing on one journey (a double click) once', async () => {
      const p = await project();
      const segmentId = await insertRow(ds, SegmentEntity, {
        projectId: p,
        name: 'Indians',
        definition: { type: 'attribute', field: 'country', op: 'eq', value: 'IN' },
      });
      const id = await insertRow(ds, JourneyEntity, {
        projectId: p,
        name: 'Double click',
        trigger: { type: 'segment_entry', segmentId },
        steps: [{ type: 'send_push', title: 'Welcome' }],
      });
      slowEntries();
      const both = await Promise.all([
        call('POST', `/projects/${p}/journeys/${id}/status`, owner, { status: 'active' }),
        call('POST', `/projects/${p}/journeys/${id}/status`, owner, { status: 'active' }),
      ]);
      expect(both.map((r) => r.status < 300)).toEqual([true, true]);
      expect(both.map((r) => r.json?.data?.status)).toEqual(['active', 'active']);
      const all = await rows(p);
      expect(all.map((r) => r.action)).toEqual(['journey.status_changed']);
      expect(all[0].details).toEqual({ from: 'draft', to: 'active' });
    });
  });

  describe('live short links', () => {
    /** A destination no row may ever hold. */
    const SENTINEL = 'https://sentinel-destination.example/never-in-the-log';

    const link = async (p: string, title: string | null = 'Diwali') =>
      insertRow(ds, LinkEntity, {
        projectId: p,
        shortCode: `l${randomUUID().slice(0, 8)}`,
        longUrl: 'https://example.com/before',
        title,
      });

    it('logs an edit with the changed field names, nothing for the same values, and never a URL', async () => {
      const p = await project();
      const id = await link(p);
      const target = { target_type: 'link', target_id: id, target_label: 'Diwali' };

      await ok('PATCH', `/links/${id}`, member, { longUrl: SENTINEL, isActive: false, title: 'Diwali' });
      expect(await onlyNew(p, 0)).toEqual({
        action: 'link.changed',
        ...by(member),
        ...target,
        details: { fields: ['longUrl', 'isActive'] },
      });

      // The same values again change nothing.
      await ok('PATCH', `/links/${id}`, member, { longUrl: SENTINEL, isActive: false, title: 'Diwali' });
      await noneNew(p, 1);

      expect(JSON.stringify(await rows(p))).not.toContain('sentinel-destination');
    });

    it('names a link with no name by its short code', async () => {
      const p = await project();
      const id = await link(p, null);
      const { shortCode } = await ds.getRepository(LinkEntity).findOneByOrFail({ id });
      await ok('PATCH', `/links/${id}`, owner, { expiresAt: '2027-01-01T00:00:00.000Z' });
      expect(await onlyNew(p, 0)).toMatchObject({ target_label: shortCode, details: { fields: ['expiresAt'] } });
    });

    it('logs adding, changing and removing a variant by its name, never its URL', async () => {
      const p = await project();
      const id = await link(p);
      const target = { target_type: 'link', target_id: id, target_label: 'Diwali' };

      const variant = await ok('POST', `/links/${id}/variants`, member, { name: 'B', longUrl: SENTINEL, weight: 30 });
      expect(await onlyNew(p, 0)).toEqual({
        action: 'link.changed',
        ...by(member),
        ...target,
        details: { change: 'added', fields: ['name', 'longUrl', 'weight'], variant: 'B' },
      });

      await ok('PATCH', `/links/${id}/variants/${variant.id}`, owner, { longUrl: `${SENTINEL}/2`, weight: 30 });
      expect(await onlyNew(p, 1)).toEqual({
        action: 'link.changed',
        ...by(owner),
        ...target,
        details: { change: 'changed', fields: ['longUrl'], variant: 'B' },
      });

      await ok('PATCH', `/links/${id}/variants/${variant.id}`, owner, { weight: 30 });
      await noneNew(p, 2);

      await ok('DELETE', `/links/${id}/variants/${variant.id}`, owner);
      expect(await onlyNew(p, 2)).toEqual({ action: 'link.changed', ...by(owner), ...target, details: { change: 'removed', variant: 'B' } });

      expect((await call('DELETE', `/links/${id}/variants/${variant.id}`, owner)).status).toBe(404);
      await noneNew(p, 3);
      expect(JSON.stringify(await rows(p))).not.toContain('sentinel-destination');
    });

    it('refuses a variant edit that names another tenant\'s link or its counters, changing nothing', async () => {
      const p = await project();
      const id = await link(p);
      const variantId = await insertRow(ds, LinkVariantEntity, { linkId: id, name: 'B', longUrl: 'https://example.com/b' });
      // Another tenant's project and link.
      const stranger = await person('stranger');
      const theirs = (await ds.getRepository(ProjectEntity).save({ name: 'theirs', ownerId: stranger.id })).id;
      await addOwnerMember(ds, theirs, stranger.id);
      const theirLink = await link(theirs, 'Their link');
      const before = await ds.getRepository(LinkVariantEntity).findOneByOrFail({ id: variantId });

      for (const body of [{ linkId: theirLink }, { clicks: 999 }, { id: randomUUID() }, { name: 'C', clicks: 999 }]) {
        const res = await call('PATCH', `/links/${id}/variants/${variantId}`, member, body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      }
      const after = await ds.getRepository(LinkVariantEntity).findOneByOrFail({ id: variantId });
      expect([after.linkId, after.clicks, after.name]).toEqual([before.linkId, before.clicks, 'B']);
      expect(await ds.getRepository(LinkVariantEntity).count({ where: { linkId: theirLink } })).toBe(0);
      await noneNew(p, 0);
      await noneNew(theirs, 0);

      // A valid partial edit still works, and is logged.
      const edited = await ok('PATCH', `/links/${id}/variants/${variantId}`, member, { weight: 70 });
      expect(edited.weight).toBe(70);
      expect((await onlyNew(p, 0)).details).toEqual({ change: 'changed', fields: ['weight'], variant: 'B' });
    });

    it('keeps the old destination when the entry cannot be written', async () => {
      const p = await project();
      const id = await link(p);
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('PATCH', `/links/${id}`, owner, { longUrl: SENTINEL })).status).toBe(500);
      expect((await ds.getRepository(LinkEntity).findOneByOrFail({ id })).longUrl).toBe('https://example.com/before');
      await noneNew(p, 0);
    });
  });

  describe('deleting content', () => {
    const cases: Array<{
      kind: string;
      make: (p: string) => Promise<string>;
      path: (p: string, id: string) => string;
      label: string;
    }> = [
      {
        kind: 'journey',
        label: 'Old journey',
        make: async (p) => {
          const segmentId = await insertRow(ds, SegmentEntity, {
            projectId: p,
            name: 's',
            definition: { type: 'attribute', field: 'country', op: 'eq', value: 'IN' },
          });
          return insertRow(ds, JourneyEntity, {
            projectId: p,
            name: 'Old journey',
            trigger: { type: 'segment_entry', segmentId },
            steps: [{ type: 'send_push', title: 't' }],
          });
        },
        path: (p, id) => `/projects/${p}/journeys/${id}`,
      },
      {
        kind: 'segment',
        label: 'Lapsed buyers',
        make: (p) =>
          insertRow(ds, SegmentEntity, {
            projectId: p,
            name: 'Lapsed buyers',
            definition: { type: 'attribute', field: 'country', op: 'eq', value: 'IN' },
          }),
        path: (p, id) => `/projects/${p}/segments/${id}`,
      },
      {
        kind: 'in_app_message',
        label: 'Old modal',
        make: (p) => insertRow(ds, InAppMessageEntity, { projectId: p, name: 'Old modal', messageType: 'modal', title: 't' }),
        path: (p, id) => `/projects/${p}/in-app-messages/${id}`,
      },
      {
        kind: 'banner',
        label: 'Hero banner',
        make: async (p) => {
          const categoryId = await insertRow(ds, BannerCategoryEntity, { projectId: p, name: 'Home' });
          return insertRow(ds, InAppBannerEntity, { categoryId, title: 'Hero banner' });
        },
        path: (_p, id) => `/in-app-banners/${id}`,
      },
      {
        kind: 'banner_category',
        label: 'Home rail',
        make: (p) => insertRow(ds, BannerCategoryEntity, { projectId: p, name: 'Home rail' }),
        path: (_p, id) => `/banner-categories/${id}`,
      },
      {
        kind: 'template',
        label: 'Restock alert',
        make: (p) => insertRow(ds, PushTemplateEntity, { projectId: p, name: 'Restock alert', title: 't' }),
        path: (p, id) => `/projects/${p}/push-templates/${id}`,
      },
      {
        kind: 'link',
        label: 'Spring promo',
        make: (p) =>
          insertRow(ds, LinkEntity, {
            projectId: p,
            shortCode: `m${randomUUID().slice(0, 8)}`,
            longUrl: 'https://example.com/spring',
            title: 'Spring promo',
          }),
        path: (_p, id) => `/links/${id}`,
      },
      {
        kind: 'cohort',
        label: 'Churn risk',
        make: (p) => insertRow(ds, MixpanelCohortEntity, { projectId: p, mixpanelCohortId: 91, name: 'Churn risk' }),
        path: (p, id) => `/projects/${p}/mixpanel/cohorts/${id}`,
      },
    ];

    it.each(cases)('logs deleting a $kind with its name, by a member, and nothing for a missing one', async (c) => {
      const p = await project();
      const id = await c.make(p);
      await ok('DELETE', c.path(p, id), member);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'content.deleted',
        ...by(member),
        target_type: c.kind,
        target_id: id,
        target_label: c.label,
        details: { kind: c.kind },
      });

      expect((await call('DELETE', c.path(p, id), member)).status).toBe(404);
      expect((await call('DELETE', c.path(p, randomUUID()), member)).status).toBe(404);
      await noneNew(p, 1);
    });

    it('logs two deletes racing on one item (a double click) once, and the second gets 404', async () => {
      const p = await project();
      const id = await insertRow(ds, InAppMessageEntity, { projectId: p, name: 'Clicked twice', messageType: 'modal', title: 't' });
      slowEntries();
      const both = await Promise.all([
        call('DELETE', `/projects/${p}/in-app-messages/${id}`, member),
        call('DELETE', `/projects/${p}/in-app-messages/${id}`, member),
      ]);
      expect((await rows(p)).map((r) => r.action)).toEqual(['content.deleted']);
      expect(both.map((r) => (r.status < 300 ? 'ok' : r.status)).sort()).toEqual([404, 'ok']);
      expect(await ds.getRepository(InAppMessageEntity).count({ where: { id } })).toBe(0);
    });

    it('keeps the item when the entry cannot be written', async () => {
      const p = await project();
      const id = await insertRow(ds, SegmentEntity, {
        projectId: p,
        name: 'Kept',
        definition: { type: 'attribute', field: 'country', op: 'eq', value: 'IN' },
      });
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('DELETE', `/projects/${p}/segments/${id}`, owner)).status).toBe(500);
      expect(await ds.getRepository(SegmentEntity).count({ where: { id } })).toBe(1);
      await noneNew(p, 0);
    });
  });
});

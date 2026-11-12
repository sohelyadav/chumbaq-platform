import { randomBytes } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import type { ProjectActivityAction } from '@chumbaq/shared';

// Every Resolver the webhook guard makes answers with one public address, so a
// hooks.slack.com URL is accepted without the suite touching real DNS. The rest of
// dns/promises is the real thing.
jest.mock('dns/promises', () => {
  const actual = jest.requireActual('dns/promises');
  const resolver = {
    resolve4: async () => ['93.184.215.14'],
    resolve6: async () => Promise.reject(Object.assign(new Error('queryAaaa ENODATA'), { code: 'ENODATA' })),
  };
  return { ...actual, Resolver: jest.fn(() => resolver) };
});

import { TRUST_PROXY } from '../../common/client-ip';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp } from '../../test-support/sweep-fixtures';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { FcmProvider } from '../push-notifications/services/fcm.provider';
import { ApnsProvider } from '../push-notifications/services/apns.provider';
import { EmailProviderRegistry } from '../email/email-provider.registry';
import { SmsProviderRegistry } from '../sms/sms-provider.registry';
import { WhatsAppProviderRegistry } from '../whatsapp/whatsapp-provider.registry';
import { ProjectActivityService } from './project-activity.service';

/**
 * The API keys and Channels groups of the activity log, written by the real routes
 * against the real database: each action writes exactly one entry, one that changes
 * nothing writes none, a failed log write takes a key create or revoke down with it,
 * and no secret, webhook URL or webhook host ever reaches a row.
 *
 * Provider checks are stubbed (they would call Google, Apple, Resend, Twilio and Meta),
 * and DNS answers every name with one public address.
 *
 * `project_activity` is append-only and the int database is shared, so every assertion
 * reads only the rows of projects made in this run.
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@config-activity-int.test';
const IP = '203.0.113.78';
const AGENT = 'config-activity-int/1';
/** As the brief gives it: the token is in the path, and the host says whose it is. */
const SLACK_URL = 'https://hooks.slack.com/services/T0/B0/SENTINEL';
const SLACK_URL_2 = 'https://hooks.slack.com/services/T0/B0/SENTINEL-second';
const RUN = randomBytes(6).toString('hex');
/** A unique value per secret-bearing field, so a leak names where it came from. */
const S = (field: string) => `SENTINEL-${field}-${RUN}`;

interface Row {
  action: ProjectActivityAction;
  actor_kind: string;
  actor_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
}

const fcmJson = (privateKey: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'config-activity',
    private_key: privateKey,
    client_email: 'push@config-activity.iam.gserviceaccount.com',
    ...extra,
  });

describe('API key and channel activity (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let activity: ProjectActivityService;
  let restoreEnv: () => void = () => undefined;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  let seq = 0;
  /** Every project this run made: the only rows any assertion reads. */
  const made: string[] = [];
  const savedMixpanelKey = process.env.MIXPANEL_ENCRYPTION_KEY;

  const cleanup = async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  let owner: { id: string; token: string };

  const project = async (): Promise<string> => {
    const id = (await ds.getRepository(ProjectEntity).save({ name: 'config', ownerId: owner.id })).id;
    await addOwnerMember(ds, id, owner.id);
    made.push(id);
    return id;
  };

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${owner.token}`,
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
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    expect({ status: res.status < 300, text: res.status < 300 ? '' : res.text }).toEqual({ status: true, text: '' });
    return res.json?.data;
  };

  const rows = async (projectId: string): Promise<Row[]> =>
    ds.query(
      `SELECT action, actor_kind, actor_user_id, target_type, target_id, target_label, details,
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

  const byOwner = () => ({ actor_kind: 'user', actor_user_id: owner.id, ip_address: IP, user_agent: AGENT });

  beforeAll(async () => {
    // Pinned when missing, so the suite does not depend on whoever's .env runs it.
    process.env.MIXPANEL_ENCRYPTION_KEY ||= 'config-activity-int-mixpanel-key-0123456789';
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
    app.getHttpAdapter().getInstance().set('trust proxy', TRUST_PROXY);
    activity = app.get(ProjectActivityService);
    const email = `owner-${++seq}${DOMAIN}`;
    const id = (
      await ds.getRepository(UserEntity).save({ email, name: 'Owner', passwordHash: 'x', emailVerifiedAt: new Date() })
    ).id;
    owner = { id, token: await jwt.signAsync({ sub: id, email, type: 'access', auth_time: Math.floor(Date.now() / 1000) }) };
  }, 120000);

  beforeEach(() => {
    const accept = async () => undefined;
    jest.spyOn(app.get(FcmProvider), 'validateCredentials').mockImplementation(accept);
    jest.spyOn(app.get(ApnsProvider), 'validateCredentials').mockImplementation(accept);
    for (const registry of [EmailProviderRegistry, SmsProviderRegistry, WhatsAppProviderRegistry] as const) {
      jest.spyOn(app.get(registry as never) as { get: () => unknown }, 'get').mockReturnValue({ validateCredentials: accept });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
    if (savedMixpanelKey === undefined) delete process.env.MIXPANEL_ENCRYPTION_KEY;
    else process.env.MIXPANEL_ENCRYPTION_KEY = savedMixpanelKey;
  });

  describe('API keys', () => {
    it('logs a create (name and permissions) and a revoke, once each', async () => {
      const p = await project();
      const created = await ok('POST', `/projects/${p}/api-keys`, { name: 'Server key' });
      expect(created.fullKey).toMatch(/^chumbaq_/);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'api_key.created',
        ...byOwner(),
        target_type: 'api_key',
        target_id: created.apiKey.id,
        target_label: 'Server key',
        details: { name: 'Server key', permissions: ['read', 'write'] },
      });

      await ok('DELETE', `/projects/${p}/api-keys/${created.apiKey.id}`);
      expect(await onlyNew(p, 1)).toEqual({
        action: 'api_key.revoked',
        ...byOwner(),
        target_type: 'api_key',
        target_id: created.apiKey.id,
        target_label: 'Server key',
        details: null,
      });

      // Revoking it again still answers 200, and changes nothing.
      await ok('DELETE', `/projects/${p}/api-keys/${created.apiKey.id}`);
      await noneNew(p, 2);
    });

    it('a failed log write makes no key and revokes nothing', async () => {
      const p = await project();
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('POST', `/projects/${p}/api-keys`, { name: 'Lost' })).status).toBe(500);
      expect(await ds.query(`SELECT 1 FROM api_keys WHERE project_id = $1`, [p])).toHaveLength(0);

      const key = await ok('POST', `/projects/${p}/api-keys`, { name: 'Kept' });
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('DELETE', `/projects/${p}/api-keys/${key.apiKey.id}`)).status).toBe(500);
      const [row] = await ds.query(`SELECT is_active FROM api_keys WHERE id = $1`, [key.apiKey.id]);
      expect(row.is_active).toBe(true);
      expect((await rows(p)).map((r) => r.action)).toEqual(['api_key.created']);
    });
  });

  describe('webhooks', () => {
    it('logs create, change, rotate and delete by id, and a PATCH with identical values logs nothing', async () => {
      const p = await project();
      const hook = await ok('POST', `/projects/${p}/webhooks`, { url: SLACK_URL, events: ['click', 'conversion'] });
      const target = { target_type: 'webhook', target_id: hook.id, target_label: hook.id };
      expect(await onlyNew(p, 0)).toEqual({
        action: 'webhook.created',
        ...byOwner(),
        ...target,
        details: { events: ['click', 'conversion'] },
      });

      // Identical values, every field: nothing written, nothing logged.
      await ok('PATCH', `/projects/${p}/webhooks/${hook.id}`, {
        url: SLACK_URL,
        events: ['click', 'conversion'],
        isActive: true,
      });
      // The same events in another order are the same events.
      await ok('PATCH', `/projects/${p}/webhooks/${hook.id}`, { events: ['conversion', 'click'] });
      await noneNew(p, 1);

      await ok('PATCH', `/projects/${p}/webhooks/${hook.id}`, { url: SLACK_URL_2, events: ['click', 'conversion'] });
      expect(await onlyNew(p, 1)).toEqual({
        action: 'webhook.changed',
        ...byOwner(),
        ...target,
        details: { events: ['click', 'conversion'], fields: ['url'] },
      });

      await ok('PATCH', `/projects/${p}/webhooks/${hook.id}`, { events: ['click'], isActive: false });
      expect((await onlyNew(p, 2)).details).toEqual({ events: ['click'], fields: ['events', 'isActive'] });

      await ok('POST', `/projects/${p}/webhooks/${hook.id}/rotate-secret`);
      expect(await onlyNew(p, 3)).toEqual({ action: 'webhook.secret_rotated', ...byOwner(), ...target, details: null });

      await ok('DELETE', `/projects/${p}/webhooks/${hook.id}`);
      expect(await onlyNew(p, 4)).toEqual({ action: 'webhook.deleted', ...byOwner(), ...target, details: null });
    });

    it('a failed log write leaves the webhook as it was', async () => {
      const p = await project();
      const hook = await ok('POST', `/projects/${p}/webhooks`, { url: SLACK_URL, events: ['click'] });
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('PATCH', `/projects/${p}/webhooks/${hook.id}`, { url: SLACK_URL_2 })).status).toBe(500);
      const [row] = await ds.query(`SELECT url FROM webhooks WHERE id = $1`, [hook.id]);
      expect(row.url).toBe(SLACK_URL);
    });
  });

  describe('push', () => {
    it('logs an FCM upload and a credentials upload once, and not the same credentials again', async () => {
      const p = await project();
      await ok('POST', '/push-notifications/configure', { projectId: p, fcmServiceAccountJson: fcmJson(S('fcm-key')) });
      expect(await onlyNew(p, 0)).toEqual({
        action: 'channel.credentials_uploaded',
        ...byOwner(),
        target_type: 'channel_provider',
        target_id: 'fcm',
        target_label: 'Firebase Cloud Messaging',
        details: { channel: 'push', fields: ['credentials'] },
      });

      // The dashboard shows push_configs.updated_at as "Last updated".
      const updatedAt = async (): Promise<number> =>
        new Date((await ds.query(`SELECT updated_at FROM push_configs WHERE project_id = $1`, [p]))[0].updated_at).getTime();
      const first = await updatedAt();

      // The same service account, re-pasted with its keys in another order.
      const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(fcmJson(S('fcm-key')))).reverse()));
      await ok('POST', '/push-notifications/configure', { projectId: p, fcmServiceAccountJson: reordered });
      await noneNew(p, 1);
      expect(await updatedAt()).toBe(first);

      await ok('POST', '/push-notifications/configure', { projectId: p, fcmServiceAccountJson: fcmJson(S('fcm-key-2')) });
      expect((await onlyNew(p, 1)).action).toBe('channel.credentials_uploaded');
      expect(await updatedAt()).toBeGreaterThan(first);

      const apns = JSON.stringify({ keyId: 'K', teamId: 'T', bundleId: 'b', privateKey: S('apns-key') });
      await ok('POST', '/push-notifications/channels/credentials', { projectId: p, provider: 'apns', credentials: apns });
      expect(await onlyNew(p, 2)).toMatchObject({
        action: 'channel.credentials_uploaded',
        target_type: 'channel_provider',
        target_id: 'apns',
        details: { channel: 'push', fields: ['credentials'] },
      });
      await ok('POST', '/push-notifications/channels/credentials', { projectId: p, provider: 'apns', credentials: apns });
      await noneNew(p, 3);
    });

    it('logs the policy fields a save changes, and nothing for a save that changes none', async () => {
      const p = await project();
      await ok('POST', '/push-notifications/configure', { projectId: p, fcmServiceAccountJson: fcmJson(S('fcm')) });
      await ok('POST', '/push-notifications/settings', { projectId: p, frequencyCapPerDay: 3 });
      expect(await onlyNew(p, 1)).toEqual({
        action: 'channel.settings_changed',
        ...byOwner(),
        target_type: 'channel',
        target_id: 'push',
        target_label: 'Push',
        details: { channel: 'push', fields: ['frequencyCapPerDay'] },
      });
      await ok('POST', '/push-notifications/settings', { projectId: p, frequencyCapPerDay: 3 });
      await noneNew(p, 2);
      await ok('POST', '/push-notifications/settings', {
        projectId: p,
        frequencyCapPerDay: 3,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
      });
      expect((await onlyNew(p, 2)).details).toEqual({ channel: 'push', fields: ['quietHoursStart', 'quietHoursEnd'] });
    });
  });

  describe('email', () => {
    it('logs sender changes by field, provider switches, credential changes, token rotation and topic reset', async () => {
      const p = await project();
      const sender = { projectId: p, fromEmail: 'news@example.com', fromName: 'Shop', postalAddress: '1 Main St' };
      await ok('POST', '/email/settings', sender);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'channel.settings_changed',
        ...byOwner(),
        target_type: 'channel',
        target_id: 'email',
        target_label: 'Email',
        details: { channel: 'email', fields: ['fromEmail', 'fromName', 'replyTo', 'postalAddress'] },
      });
      await ok('POST', '/email/settings', { ...sender, fromEmail: 'NEWS@example.com' });
      await noneNew(p, 1);
      await ok('POST', '/email/settings', { ...sender, postalAddress: '2 High St', requireOptIn: false });
      expect((await onlyNew(p, 1)).details).toEqual({ channel: 'email', fields: ['postalAddress', 'requireOptIn'] });

      const resend = JSON.stringify({ apiKey: S('resend-key'), webhookSecret: S('resend-whsec') });
      await ok('POST', '/email/providers', { projectId: p, provider: 'resend', credentials: resend });
      expect(await onlyNew(p, 2)).toEqual({
        action: 'channel.provider_changed',
        ...byOwner(),
        target_type: 'channel_provider',
        target_id: 'resend',
        target_label: 'Resend',
        details: { channel: 'email', fields: ['provider', 'credentials'] },
      });
      await ok('POST', '/email/providers', { projectId: p, provider: 'resend', credentials: resend });
      await noneNew(p, 3);

      const resend2 = JSON.stringify({ apiKey: S('resend-key-2'), webhookSecret: S('resend-whsec') });
      await ok('POST', '/email/providers', { projectId: p, provider: 'resend', credentials: resend2 });
      expect(await onlyNew(p, 3)).toMatchObject({
        action: 'channel.credentials_uploaded',
        details: { channel: 'email', fields: ['credentials'] },
      });

      await ok('POST', '/email/providers', { projectId: p, provider: 'brevo', credentials: JSON.stringify({ apiKey: S('brevo-key') }) });
      expect((await onlyNew(p, 4)).details).toEqual({ channel: 'email', fields: ['provider', 'credentials'] });
      // Back to Resend with the credentials it still holds: only the provider changed.
      await ok('POST', '/email/providers', { projectId: p, provider: 'resend', credentials: resend2 });
      expect(await onlyNew(p, 5)).toMatchObject({
        action: 'channel.provider_changed',
        details: { channel: 'email', fields: ['provider'] },
      });

      await ok('POST', `/email/settings/${p}/rotate-webhook-token`);
      expect(await onlyNew(p, 6)).toEqual({
        action: 'email.webhook_token_rotated',
        ...byOwner(),
        target_type: 'channel',
        target_id: 'email',
        target_label: 'Email',
        details: null,
      });

      // No topic pinned: nothing to reset, nothing logged.
      await ok('POST', `/email/settings/${p}/reset-ses-topic`);
      await noneNew(p, 7);
      await ds.query(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [
        p,
        'arn:aws:sns:ap-south-1:123456789012:events',
      ]);
      await ok('POST', `/email/settings/${p}/reset-ses-topic`);
      expect((await onlyNew(p, 7)).action).toBe('email.ses_topic_reset');
    });
  });

  describe('SMS and WhatsApp', () => {
    it('logs SMS sender changes and a Twilio connect, and not a repeat of either', async () => {
      const p = await project();
      await ok('POST', '/sms/settings', { projectId: p, sender: '+14155550123' });
      expect(await onlyNew(p, 0)).toMatchObject({
        action: 'channel.settings_changed',
        target_id: 'sms',
        details: { channel: 'sms', fields: ['sender'] },
      });
      await ok('POST', '/sms/settings', { projectId: p, sender: '+14155550123' });
      await noneNew(p, 1);
      await ok('POST', '/sms/settings', { projectId: p, sender: '+14155550123', optOutText: 'Text STOP to stop' });
      expect((await onlyNew(p, 1)).details).toEqual({ channel: 'sms', fields: ['optOutText'] });

      const twilio = JSON.stringify({ accountSid: 'AC123', authToken: S('twilio-token') });
      await ok('POST', '/sms/providers', { projectId: p, provider: 'twilio', credentials: twilio });
      expect(await onlyNew(p, 2)).toMatchObject({
        action: 'channel.provider_changed',
        target_id: 'twilio',
        target_label: 'Twilio',
        details: { channel: 'sms', fields: ['provider', 'credentials'] },
      });
      await ok('POST', '/sms/providers', { projectId: p, provider: 'twilio', credentials: twilio });
      await noneNew(p, 3);
    });

    it('logs a WhatsApp opt-in change and a Meta connect, and not a repeat of either', async () => {
      const p = await project();
      await ok('POST', '/whatsapp/settings', { projectId: p, requireOptIn: false });
      expect(await onlyNew(p, 0)).toMatchObject({
        action: 'channel.settings_changed',
        target_id: 'whatsapp',
        details: { channel: 'whatsapp', fields: ['requireOptIn'] },
      });
      await ok('POST', '/whatsapp/settings', { projectId: p, requireOptIn: false });
      await noneNew(p, 1);

      const meta = JSON.stringify({ accessToken: S('meta-token'), appSecret: S('meta-app-secret'), phoneNumberId: '1' });
      await ok('POST', '/whatsapp/providers', { projectId: p, provider: 'meta', credentials: meta });
      expect(await onlyNew(p, 1)).toMatchObject({
        action: 'channel.provider_changed',
        target_id: 'meta',
        details: { channel: 'whatsapp', fields: ['provider', 'credentials'] },
      });
      await ok('POST', '/whatsapp/providers', { projectId: p, provider: 'meta', credentials: meta });
      await noneNew(p, 2);
    });
  });

  describe('Mixpanel', () => {
    it('logs a configure with no details, and not the same account again', async () => {
      const p = await project();
      const account = {
        serviceAccountUsername: S('mixpanel-user'),
        serviceAccountPassword: S('mixpanel-password'),
        mixpanelProjectId: '42',
      };
      await ok('POST', `/projects/${p}/mixpanel/configure`, account);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'mixpanel.configured',
        ...byOwner(),
        target_type: 'integration',
        target_id: 'mixpanel',
        target_label: 'Mixpanel',
        details: null,
      });
      await ok('POST', `/projects/${p}/mixpanel/configure`, account);
      await noneNew(p, 1);
      await ok('POST', `/projects/${p}/mixpanel/configure`, { ...account, serviceAccountPassword: S('mixpanel-password-2') });
      expect((await onlyNew(p, 1)).action).toBe('mixpanel.configured');
    });
  });

  it('no row holds a secret, a webhook URL or a webhook host', async () => {
    // Every route in this task, with a sentinel in every secret-bearing field, in one
    // project of its own; then every row of every project this run made is searched.
    const p = await project();
    const key = await ok('POST', `/projects/${p}/api-keys`, { name: 'k', permissions: ['read'] });
    await ok('DELETE', `/projects/${p}/api-keys/${key.apiKey.id}`);

    const hook = await ok('POST', `/projects/${p}/webhooks`, { url: SLACK_URL, events: ['click'] });
    await ok('PATCH', `/projects/${p}/webhooks/${hook.id}`, { url: SLACK_URL_2 });
    const rotated = await ok('POST', `/projects/${p}/webhooks/${hook.id}/rotate-secret`);
    await ok('DELETE', `/projects/${p}/webhooks/${hook.id}`);

    await ok('POST', '/push-notifications/configure', { projectId: p, fcmServiceAccountJson: fcmJson(S('sweep-fcm')) });
    await ok('POST', '/push-notifications/settings', { projectId: p, frequencyCapPerDay: 2 });
    await ok('POST', '/push-notifications/channels/credentials', {
      projectId: p,
      provider: 'apns',
      credentials: JSON.stringify({ keyId: 'K', teamId: 'T', bundleId: 'b', privateKey: S('sweep-apns') }),
    });

    await ok('POST', '/email/settings', { projectId: p, fromEmail: 'a@example.com', postalAddress: '1 Main St' });
    await ok('POST', '/email/providers', {
      projectId: p,
      provider: 'ses',
      credentials: JSON.stringify({ accessKeyId: S('sweep-ses-id'), secretAccessKey: S('sweep-ses-secret'), region: 'ap-south-1' }),
    });
    await ok('POST', '/email/providers', {
      projectId: p,
      provider: 'resend',
      credentials: JSON.stringify({ apiKey: S('sweep-resend'), webhookSecret: S('sweep-resend-whsec') }),
    });
    const status = await ok('POST', `/email/settings/${p}/rotate-webhook-token`);
    await ok('POST', `/email/settings/${p}/reset-ses-topic`);

    await ok('POST', '/sms/settings', { projectId: p, sender: '+14155550123' });
    await ok('POST', '/sms/providers', {
      projectId: p,
      provider: 'twilio',
      credentials: JSON.stringify({ accountSid: S('sweep-twilio-sid'), authToken: S('sweep-twilio-token') }),
    });
    await ok('POST', '/whatsapp/settings', { projectId: p, requireOptIn: false });
    await ok('POST', '/whatsapp/providers', {
      projectId: p,
      provider: 'meta',
      credentials: JSON.stringify({ accessToken: S('sweep-meta'), appSecret: S('sweep-meta-secret'), phoneNumberId: '1' }),
    });
    await ok('POST', `/projects/${p}/mixpanel/configure`, {
      serviceAccountUsername: S('sweep-mixpanel-user'),
      serviceAccountPassword: S('sweep-mixpanel-password'),
      mixpanelProjectId: '7',
    });

    // Values the server made that are as secret as anything sent.
    const generated = [
      key.fullKey as string,
      (key.fullKey as string).slice(0, 12),
      rotated.secret as string,
      hook.secret as string,
      (status.webhookUrls.ses as string).split('/').pop() as string,
    ];

    const stored: string[] = (
      await ds.query(`SELECT row_to_json(a)::text AS row FROM project_activity a WHERE project_id = ANY($1)`, [made])
    ).map((r: { row: string }) => r.row);
    // The sweep project logged every action it took, so the search had something to search.
    expect((await rows(p)).length).toBe(18);
    const leaks = stored.filter(
      (row) => /SENTINEL|hooks\.slack\.com/i.test(row) || generated.some((value) => row.includes(value)),
    );
    expect(leaks).toEqual([]);
  });
});

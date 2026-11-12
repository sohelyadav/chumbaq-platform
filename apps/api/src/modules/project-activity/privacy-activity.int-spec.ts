import { createHash, randomBytes, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import type { ProjectActivityAction } from '@chumbaq/shared';
import { TRUST_PROXY } from '../../common/client-ip';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp, insertRow } from '../../test-support/sweep-fixtures';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { PushTokenEntity } from '../push-tokens/entities/push-token.entity';
import { ApiKeyEntity } from '../api-keys/entities/api-key.entity';
import { ProjectActivityService } from './project-activity.service';

/**
 * The Privacy group of the activity log, written by the real routes against the real
 * database: erasure and export from the dashboard and through a server API key,
 * consent changes, tracking objections, and suppression add and remove on email, SMS
 * and WhatsApp. Each writes exactly one entry; a change that changes nothing writes
 * none; a failed erasure writes none, and a retried one writes one.
 *
 * The point of the group is that the log is about the team, not the end user: a
 * person is named by internal id only, an address is masked, and the person's email,
 * phone, external id, fingerprint and push token never appear in any column of any
 * row (checked on the row as JSON, so a new column cannot hide one).
 *
 * `project_activity` is append-only and the int database is shared, so every assertion
 * reads only the rows of a project made in that test.
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@privacy-activity-int.test';
/** Sent as X-Forwarded-For from loopback, which `TRUST_PROXY` believes. */
const IP = '203.0.113.80';
const AGENT = 'privacy-activity-int/1';
const KEY_NAME = 'Backend privacy';

const SENTINEL = {
  email: 'privacy-sentinel@x.com',
  phone: '+919999900001',
  externalUserId: 'ext-sentinel-1',
};
const MASKED_EMAIL = 'p***@x.com';
const MASKED_PHONE = '+91******01';

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

/** The sentinel person's device and everything that identifies them outside Chumbaq. */
interface Sentinel {
  identityId: string;
  fingerprint: string;
  distinctId: string;
  pushToken: string;
}

describe('Privacy activity (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let activity: ProjectActivityService;
  let restoreEnv: () => void = () => undefined;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  let seq = 0;
  let owner: Person;

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
    // auth_time now: erasure needs a recent sign-in.
    const token = await jwt.signAsync({ sub: id, email, type: 'access', auth_time: Math.floor(Date.now() / 1000) });
    return { id, token, label: `${name} (${email})` };
  };

  const project = async (): Promise<string> => {
    const id = (await ds.getRepository(ProjectEntity).save({ name: 'privacy', ownerId: owner.id })).id;
    await addOwnerMember(ds, id, owner.id);
    return id;
  };

  /** The sentinel, signed in on one device, reachable on every channel. */
  const sentinel = async (projectId: string): Promise<Sentinel> => {
    const tag = randomUUID().slice(0, 8);
    const s = { fingerprint: `fp-sentinel-${tag}`, distinctId: `distinct-sentinel-${tag}`, pushToken: `push-sentinel-${tag}` };
    const identityId = await insertRow(ds, DeviceIdentityEntity, {
      projectId,
      distinctId: s.distinctId,
      externalUserId: SENTINEL.externalUserId,
      deviceFingerprint: s.fingerprint,
      platform: 'ios',
      email: SENTINEL.email,
      phone: SENTINEL.phone,
      phoneE164: SENTINEL.phone,
      emailOptIn: true,
      smsOptIn: true,
      whatsappOptIn: true,
      lastSeenAt: new Date(),
    });
    await insertRow(ds, PushTokenEntity, {
      projectId,
      deviceIdentityId: identityId,
      token: s.pushToken,
      platform: 'ios',
      provider: 'fcm',
      isActive: true,
    });
    return { identityId, ...s };
  };

  /** A server-only key with the `privacy` permission, made directly so it writes no entry of its own. */
  const privacyKey = async (projectId: string): Promise<string> => {
    const raw = `chumbaq_${randomBytes(32).toString('hex')}`;
    await insertRow(ds, ApiKeyEntity, {
      projectId,
      name: KEY_NAME,
      keyHash: createHash('sha256').update(raw).digest('hex'),
      prefix: raw.slice(0, 12),
      permissions: ['privacy'],
      isActive: true,
    });
    return raw;
  };

  const send = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, 'user-agent': AGENT, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };

  const call = (method: string, path: string, who: Person, body?: unknown) =>
    send(method, path, { authorization: `Bearer ${who.token}` }, body);

  const withKey = (path: string, key: string, body: unknown) => send('POST', path, { 'x-api-key': key }, body);

  /** A call that must succeed; its body is shown when it does not. */
  const ok = async (res: Promise<{ status: number; text: string; json: unknown }>) => {
    const r = await res;
    expect({ ok: r.status < 300, text: r.status < 300 ? '' : r.text }).toEqual({ ok: true, text: '' });
    return (r.json as { data: unknown }).data as Record<string, unknown>;
  };

  const rows = async (projectId: string): Promise<Row[]> =>
    ds.query(
      `SELECT action, actor_kind, actor_user_id, actor_label, target_type, target_id, target_label, details,
              ip_address, user_agent
         FROM project_activity WHERE project_id = $1 ORDER BY occurred_at, id`,
      [projectId],
    );

  /** Every column of every row, as Postgres renders the row to JSON. */
  const rowsAsJson = async (projectId: string): Promise<string> =>
    (
      await ds.query(
        `SELECT row_to_json(a)::text AS j FROM project_activity a WHERE project_id = $1 ORDER BY occurred_at, id`,
        [projectId],
      )
    )
      .map((r: { j: string }) => r.j)
      .join('\n');

  const onlyNew = async (projectId: string, before: number): Promise<Row> => {
    const all = await rows(projectId);
    expect(all.map((r) => r.action)).toHaveLength(before + 1);
    return all[all.length - 1];
  };

  const noneNew = async (projectId: string, before: number) => {
    expect((await rows(projectId)).map((r) => r.action)).toHaveLength(before);
  };

  const by = (who: Person) => ({
    actor_kind: 'user',
    actor_user_id: who.id,
    actor_label: who.label,
    ip_address: IP,
    user_agent: AGENT,
  });

  const byKey = {
    actor_kind: 'api_key',
    actor_user_id: null,
    actor_label: `API key "${KEY_NAME}"`,
    ip_address: IP,
    user_agent: AGENT,
  };

  const personTarget = (id: string | null) => ({ target_type: 'person', target_id: id, target_label: null });

  const identityCount = async (projectId: string) =>
    (await ds.query('SELECT COUNT(*)::int AS n FROM device_identities WHERE project_id = $1', [projectId]))[0].n;

  const requestLogCount = async (projectId: string) =>
    (await ds.query('SELECT COUNT(*)::int AS n FROM privacy_request_logs WHERE project_id = $1', [projectId]))[0].n;

  beforeAll(async () => {
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
    app.getHttpAdapter().getInstance().set('trust proxy', TRUST_PROXY);
    activity = app.get(ProjectActivityService);
    owner = await person('owner');
  }, 120000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
  });

  describe('erasure', () => {
    it('logs a dashboard erasure once, naming the person by internal id', async () => {
      const p = await project();
      const s = await sentinel(p);
      const result = await ok(call('DELETE', `/projects/${p}/users/${s.identityId}`, owner));
      expect(result.result).toBe('erased');
      expect(await onlyNew(p, 0)).toEqual({
        action: 'person.erased',
        ...by(owner),
        ...personTarget(s.identityId),
        details: null,
      });
    });

    it('logs an erasure through a server API key with the key as the actor', async () => {
      const p = await project();
      const s = await sentinel(p);
      const key = await privacyKey(p);
      const result = await ok(withKey('/privacy/erasures', key, { externalUserId: SENTINEL.externalUserId }));
      expect(result.result).toBe('erased');
      expect(await onlyNew(p, 0)).toEqual({
        action: 'person.erased',
        ...byKey,
        ...personTarget(s.identityId),
        details: null,
      });
    });

    it('logs a request that found nobody as the privacy log does, with no person id', async () => {
      const p = await project();
      const key = await privacyKey(p);
      const unknown = randomUUID();
      const byDashboard = await ok(call('DELETE', `/projects/${p}/users/${unknown}`, owner));
      expect(byDashboard.result).toBe('nothing_to_erase');
      expect(await onlyNew(p, 0)).toEqual({ action: 'person.erased', ...by(owner), ...personTarget(null), details: null });

      const byApi = await ok(withKey('/privacy/erasures', key, { externalUserId: 'ext-nobody' }));
      expect(byApi.result).toBe('nothing_to_erase');
      expect(await onlyNew(p, 1)).toEqual({ action: 'person.erased', ...byKey, ...personTarget(null), details: null });
      expect(await requestLogCount(p)).toBe(2);
    });

    it('writes nothing for an erasure that is refused', async () => {
      const p = await project();
      const s = await sentinel(p);
      const key = await privacyKey(p);
      // A signed-in device cannot be named by fingerprint: 409, nothing erased.
      const res = await withKey('/privacy/erasures', key, { deviceFingerprint: s.fingerprint });
      expect(res.status).toBe(409);
      await noneNew(p, 0);
    });

    it('writes nothing when the erasure fails after its entry was written, and erases nothing', async () => {
      const p = await project();
      const s = await sentinel(p);
      const real = activity.record.bind(activity);
      jest.spyOn(activity, 'record').mockImplementation(async (...args: Parameters<ProjectActivityService['record']>) => {
        await real(...args);
        throw Object.assign(new Error('after the entry'), { code: '23505' });
      });
      const res = await call('DELETE', `/projects/${p}/users/${s.identityId}`, owner);
      expect(res.status).toBe(500);
      await noneNew(p, 0);
      expect(await identityCount(p)).toBe(1);
      expect(await requestLogCount(p)).toBe(0);
    });

    it('writes one entry when an attempt is retried after a deadlock', async () => {
      const p = await project();
      const s = await sentinel(p);
      const real = activity.record.bind(activity);
      let calls = 0;
      jest.spyOn(activity, 'record').mockImplementation(async (...args: Parameters<ProjectActivityService['record']>) => {
        await real(...args);
        // The first attempt's entry is written, then its transaction dies.
        if (++calls === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      });
      const result = await ok(call('DELETE', `/projects/${p}/users/${s.identityId}`, owner));
      expect(calls).toBe(2);
      expect(result.result).toBe('erased');
      expect(await onlyNew(p, 0)).toMatchObject({ action: 'person.erased', ...personTarget(s.identityId) });
      expect(await requestLogCount(p)).toBe(1);
    });

    it('erases nothing when the entry cannot be written', async () => {
      const p = await project();
      const s = await sentinel(p);
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('DELETE', `/projects/${p}/users/${s.identityId}`, owner)).status).toBe(500);
      expect(await identityCount(p)).toBe(1);
      expect(await requestLogCount(p)).toBe(0);
      await noneNew(p, 0);
    });
  });

  describe('export', () => {
    it('logs a dashboard export, a GET, before the document is sent', async () => {
      const p = await project();
      const s = await sentinel(p);
      const doc = await ok(call('GET', `/projects/${p}/users/${s.identityId}/export`, owner));
      expect(doc.projectId).toBe(p);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'person.exported',
        ...by(owner),
        ...personTarget(s.identityId),
        details: null,
      });
    });

    it('logs an export through a server API key with the key as the actor', async () => {
      const p = await project();
      const s = await sentinel(p);
      const key = await privacyKey(p);
      await ok(withKey('/privacy/exports', key, { externalUserId: SENTINEL.externalUserId }));
      expect(await onlyNew(p, 0)).toEqual({
        action: 'person.exported',
        ...byKey,
        ...personTarget(s.identityId),
        details: null,
      });
    });

    it('sends no document when the entry cannot be written', async () => {
      const p = await project();
      const s = await sentinel(p);
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      const res = await call('GET', `/projects/${p}/users/${s.identityId}/export`, owner);
      expect(res.status).toBe(500);
      expect(res.text).not.toContain(SENTINEL.email);
      await noneNew(p, 0);
      // Nor a privacy request saying it was exported.
      expect(await requestLogCount(p)).toBe(0);
    });
  });

  describe('consent', () => {
    it('logs only the consents that changed, with their new values, and nothing for no change', async () => {
      const p = await project();
      const s = await sentinel(p);
      const path = `/identity/projects/${p}/users/${s.identityId}/consent`;
      // emailOptIn is already true: only smsOptIn and doNotTrack change.
      await ok(call('PATCH', path, owner, { emailOptIn: true, smsOptIn: false, doNotTrack: true }));
      expect(await onlyNew(p, 0)).toEqual({
        action: 'person.consent_changed',
        ...by(owner),
        ...personTarget(s.identityId),
        details: { consents: { smsOptIn: false, doNotTrack: true } },
      });

      await ok(call('PATCH', path, owner, { emailOptIn: true, smsOptIn: false }));
      await noneNew(p, 1);
    });

    it('changes no consent when the entry cannot be written', async () => {
      const p = await project();
      const s = await sentinel(p);
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      const res = await call('PATCH', `/identity/projects/${p}/users/${s.identityId}/consent`, owner, { smsOptIn: false });
      expect(res.status).toBe(500);
      const [row] = await ds.query('SELECT sms_opt_in FROM device_identities WHERE id = $1', [s.identityId]);
      expect(row.sms_opt_in).toBe(true);
      await noneNew(p, 0);
    });
  });

  describe('tracking objections', () => {
    it('logs a new objection with no target and no details, and nothing for a repeat', async () => {
      const p = await project();
      const s = await sentinel(p);
      const path = `/identity/projects/${p}/tracking-objections`;
      await ok(call('POST', path, owner, { externalUserId: SENTINEL.externalUserId, sourceIdentityId: s.identityId }));
      expect(await onlyNew(p, 0)).toEqual({
        action: 'tracking.objection_recorded',
        ...by(owner),
        target_type: null,
        target_id: null,
        target_label: null,
        details: null,
      });

      await ok(call('POST', path, owner, { externalUserId: SENTINEL.externalUserId }));
      await noneNew(p, 1);
    });

    it('logs a lift with no target and no details, and nothing when there was no objection', async () => {
      const p = await project();
      await sentinel(p);
      const lift = `/identity/projects/${p}/tracking-objections/lift`;
      // Nothing to lift: the same answer as before, no entry.
      await ok(call('POST', lift, owner, { externalUserId: SENTINEL.externalUserId }));
      await noneNew(p, 0);

      await ok(call('POST', `/identity/projects/${p}/tracking-objections`, owner, { externalUserId: SENTINEL.externalUserId }));
      await ok(call('POST', lift, owner, { externalUserId: SENTINEL.externalUserId }));
      expect(await onlyNew(p, 1)).toEqual({
        action: 'tracking.objection_lifted',
        ...by(owner),
        target_type: null,
        target_id: null,
        target_label: null,
        details: null,
      });

      await ok(call('POST', lift, owner, { externalUserId: SENTINEL.externalUserId }));
      await noneNew(p, 2);
    });

    it('lifts nothing when the entry cannot be written', async () => {
      const p = await project();
      await sentinel(p);
      await ok(call('POST', `/identity/projects/${p}/tracking-objections`, owner, { externalUserId: SENTINEL.externalUserId }));
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      const res = await call('POST', `/identity/projects/${p}/tracking-objections/lift`, owner, {
        externalUserId: SENTINEL.externalUserId,
      });
      expect(res.status).toBe(500);
      const [{ n }] = await ds.query('SELECT COUNT(*)::int AS n FROM tracking_objections WHERE project_id = $1', [p]);
      expect(n).toBe(1);
      await noneNew(p, 1);
    });
  });

  describe('suppressions', () => {
    const cases = [
      { channel: 'email', address: SENTINEL.email, masked: MASKED_EMAIL },
      { channel: 'sms', address: SENTINEL.phone, masked: MASKED_PHONE },
      { channel: 'whatsapp', address: SENTINEL.phone, masked: MASKED_PHONE },
    ] as const;

    it.each(cases)('logs $channel add and remove with the address masked, and nothing for no change', async ({ channel, address, masked }) => {
      const p = await project();
      await sentinel(p);
      await ok(call('POST', `/${channel}/suppressions`, owner, { projectId: p, address }));
      expect(await onlyNew(p, 0)).toEqual({
        action: 'suppression.added',
        ...by(owner),
        target_type: null,
        target_id: null,
        target_label: null,
        details: { channel, address: masked },
      });

      // Already suppressed: the same answer, no entry.
      await ok(call('POST', `/${channel}/suppressions`, owner, { projectId: p, address }));
      await noneNew(p, 1);

      const removePath = `/${channel}/suppressions/${p}/${encodeURIComponent(address)}`;
      await ok(call('DELETE', removePath, owner));
      expect(await onlyNew(p, 1)).toEqual({
        action: 'suppression.removed',
        ...by(owner),
        target_type: null,
        target_id: null,
        target_label: null,
        details: { channel, address: masked },
      });

      // Not suppressed any more: 404 as before, no entry.
      expect((await call('DELETE', removePath, owner)).status).toBe(404);
      await noneNew(p, 2);
    });

    it('adds no suppression when the entry cannot be written', async () => {
      const p = await project();
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('POST', '/email/suppressions', owner, { projectId: p, address: SENTINEL.email })).status).toBe(500);
      const [{ n }] = await ds.query('SELECT COUNT(*)::int AS n FROM channel_suppressions WHERE project_id = $1', [p]);
      expect(n).toBe(0);
      await noneNew(p, 0);
    });
  });

  it('never stores the person’s email, phone, external id, fingerprint, distinct id or push token, nor the key', async () => {
    const p = await project();
    const s = await sentinel(p);
    const key = await privacyKey(p);

    await ok(call('PATCH', `/identity/projects/${p}/users/${s.identityId}/consent`, owner, { pushOptIn: false }));
    await ok(call('POST', `/identity/projects/${p}/tracking-objections`, owner, {
      externalUserId: SENTINEL.externalUserId,
      sourceIdentityId: s.identityId,
    }));
    await ok(call('POST', `/identity/projects/${p}/tracking-objections/lift`, owner, {
      externalUserId: SENTINEL.externalUserId,
    }));
    for (const [channel, address] of [['email', SENTINEL.email], ['sms', SENTINEL.phone], ['whatsapp', SENTINEL.phone]]) {
      await ok(call('POST', `/${channel}/suppressions`, owner, { projectId: p, address }));
      await ok(call('DELETE', `/${channel}/suppressions/${p}/${encodeURIComponent(address)}`, owner));
    }
    await ok(call('GET', `/projects/${p}/users/${s.identityId}/export`, owner));
    await ok(withKey('/privacy/exports', key, { externalUserId: SENTINEL.externalUserId }));
    await ok(withKey('/privacy/erasures', key, { externalUserId: SENTINEL.externalUserId }));

    expect((await rows(p)).map((r) => r.action)).toEqual([
      'person.consent_changed',
      'tracking.objection_recorded',
      'tracking.objection_lifted',
      'suppression.added',
      'suppression.removed',
      'suppression.added',
      'suppression.removed',
      'suppression.added',
      'suppression.removed',
      'person.exported',
      'person.exported',
      'person.erased',
    ]);

    const everything = (await rowsAsJson(p)).toLowerCase();
    const leaks = [
      SENTINEL.email,
      'privacy-sentinel',
      SENTINEL.phone,
      SENTINEL.phone.slice(1),
      '9999900001',
      SENTINEL.externalUserId,
      s.fingerprint,
      s.distinctId,
      s.pushToken,
      // The server key that made the erasure and export, and the part of it the keys page shows.
      key,
      key.slice(0, 12),
    ].filter((value) => everything.includes(value.toLowerCase()));
    expect(leaks).toEqual([]);
  });
});

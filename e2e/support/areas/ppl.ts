import { createHmac, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import type { Browser, Locator, Page, Route } from '@playwright/test';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff, grantSuperAdmin } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { newPersonContext } from '../fixtures';
import { deriveCredentialsKey } from '../signing';
import { LOG_DIR, assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the people, identity and consent specs (PPL): SDK identify with a
 * verified external id, raw requests that keep the status, role accounts in a project,
 * a sign-in that is no longer recent, a view-as token, and SQL reads of the rows the
 * API writes.
 */

// ---- SQL against the lane's e2e database (the name is checked as in reset.ts)

export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const env = stackEnv();
  const client = new Client({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT || 5432),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: assertE2eDatabase(env),
  });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** The device_identities row, every column, or undefined. */
export async function deviceRow(id: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM device_identities WHERE id = $1`, [id]);
  return row;
}

export async function deviceByFingerprint(projectId: string, fingerprint: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM device_identities WHERE project_id = $1 AND device_fingerprint = $2`, [projectId, fingerprint]);
  return row;
}

export async function consentEvents(deviceIdentityId: string): Promise<Array<{ channel: string; granted: boolean; source: string }>> {
  return sql(
    `SELECT channel, granted, source FROM consent_events WHERE device_identity_id = $1 ORDER BY occurred_at, id`,
    [deviceIdentityId],
  );
}

export async function activityRows(projectId: string, action: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM project_activity WHERE project_id = $1 AND action = $2 ORDER BY occurred_at`, [projectId, action]);
}

export async function objectionRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM tracking_objections WHERE project_id = $1`, [projectId]);
}

// ---- Requests that answer the status and body instead of throwing

export interface RawResponse {
  status: number;
  body: any;
}

export interface RawOptions {
  ip: string;
  token?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export async function raw(method: string, path: string, body: unknown, { ip, token, apiKey, headers }: RawOptions): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body: parsed };
}

/** The API's error message as one string (validation errors come as a list). */
export function messageOf(response: RawResponse): string {
  const message = response.body?.message;
  return Array.isArray(message) ? message.join('; ') : String(message);
}

// ---- A project with an SDK key and its identity secret

export interface PeopleProject {
  owner: Account;
  project: Project;
  sdkKey: string;
  secret: string;
}

export async function identitySecret(owner: Account, projectId: string, ip: string): Promise<string> {
  const { secret } = await api<{ secret: string }>('GET', `/api/projects/${projectId}/identity-secret`, undefined, {
    token: owner.accessToken,
    ip,
  });
  return secret;
}

/** HMAC-SHA256 of the external id under the project's identity secret, as hex. */
export function userHash(secret: string, externalUserId: string): string {
  return createHmac('sha256', secret).update(externalUserId, 'utf8').digest('hex');
}

export async function peopleProject(ip: string, label = 'ppl-owner', owner?: Account): Promise<PeopleProject> {
  const account = owner ?? (await createAccount(ip, label, 'Pia People'));
  const project = await createProject(account, ip);
  const sdkKey = await createApiKey(account, project.id, ip);
  return { owner: account, project, sdkKey, secret: await identitySecret(account, project.id, ip) };
}

export function fingerprint(label: string): string {
  return `${label}-${randomBytes(6).toString('hex')}`;
}

export type IdentifyBody = Record<string, unknown> & { deviceFingerprint: string; platform?: string };

/**
 * The SDK's identify, through the real route, with the project's key. An external id
 * gets its userHash unless the body names one.
 */
export async function identify(p: PeopleProject, ip: string, body: IdentifyBody): Promise<Record<string, any>> {
  const withHash =
    typeof body.externalUserId === 'string' && body.userHash === undefined
      ? { ...body, userHash: userHash(p.secret, body.externalUserId) }
      : body;
  return api('POST', '/api/identity/identify', { projectId: p.project.id, platform: 'web', ...withHash }, { apiKey: p.sdkKey, ip });
}

export async function trackEvent(p: PeopleProject, ip: string, body: Record<string, unknown>): Promise<RawResponse> {
  return raw('POST', '/api/events/track', { projectId: p.project.id, ...body }, { apiKey: p.sdkKey, ip });
}

// ---- Teammates

/** A new account invited to the project with this role, and accepted. */
export async function addTeammate(owner: Account, projectId: string, role: 'admin' | 'member' | 'owner', ip: string, label = role): Promise<Account> {
  const teammate = await createAccount(ip, `ppl-${label}`, `Pat ${role}`);
  const created = await api<{ inviteUrl: string }>(
    'POST',
    `/api/projects/${projectId}/invitations`,
    { email: teammate.email, role },
    { token: owner.accessToken, ip },
  );
  const token = new URL(created.inviteUrl).hash.replace(/^#token=/, '');
  await api('POST', '/api/invitations/accept', { token }, { token: teammate.accessToken, ip });
  return teammate;
}

// ---- A sign-in that is no longer recent

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/**
 * An access token whose sign-in is 16 minutes old: signs in, moves the session's
 * `authenticated_at` back (where refresh reads `auth_time` from), and refreshes with
 * the session's cookie.
 */
export async function staleAccessToken(account: Account, ip: string): Promise<string> {
  const headers = { 'Content-Type': 'application/json', 'X-Chumbaq-Client': 'web', 'X-Forwarded-For': ip };
  const login = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (!login.ok) throw new Error(`login answered ${login.status}: ${await login.text()}`);
  const cookie = cookiesFrom(login);
  const updated = await sql(
    `UPDATE auth_sessions SET authenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
    [account.userId],
  );
  if (updated.length === 0) throw new Error('No live session to age');
  const refresh = await fetch(apiUrl('/api/auth/refresh'), { method: 'POST', headers: { ...headers, Cookie: cookie } });
  const text = await refresh.text();
  if (!refresh.ok) throw new Error(`refresh answered ${refresh.status}: ${text}`);
  return (JSON.parse(text) as { data: { accessToken: string } }).data.accessToken;
}

// ---- View-as

/**
 * Staff view-as of `tenant`, the real way: a super admin granted by the CLI enrols a
 * passkey and signs in to the admin app in a browser of their own, and starts view-as
 * with a reason. Answers the one-time handoff link (`APP_URL/impersonate#code=`).
 */
export async function viewAsHandoff(browser: Browser, baseURL: string | undefined, tenant: Account): Promise<string> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'ppl-staff', 'Sid Staff');
  await grantSuperAdmin(staff.email);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const page = await context.newPage();
    const staffToken = await enrolAndSignInStaff(page, staff);
    const handoff = await adminApi<{ url: string }>(
      'POST',
      `/api/admin/tenants/${tenant.userId}/impersonate`,
      { reason: 'E2E: checking people pages read-only' },
      staffToken,
      ip,
    );
    return handoff.url;
  } finally {
    await context.close();
  }
}

/** A view-as access token for `tenant`, exchanged from a fresh handoff. */
export async function viewAsToken(browser: Browser, baseURL: string | undefined, tenant: Account, ip: string): Promise<string> {
  const url = await viewAsHandoff(browser, baseURL, tenant);
  const code = new URL(url).hash.replace(/^#code=/, '');
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip });
  return session.accessToken;
}

/** Opens a view-as handoff link in this tab and waits for the read-only banner. */
export async function openViewAs(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
}

// ---- API keys of a project

export interface ProjectKey {
  id: string;
  fullKey: string;
  name: string;
}

/** A new API key: an ordinary SDK key, or with `permissions: ['privacy']` a server-only privacy key. */
export async function createKey(
  owner: Account,
  projectId: string,
  ip: string,
  { name = `E2E key ${randomBytes(2).toString('hex')}`, permissions, expiresAt }: { name?: string; permissions?: string[]; expiresAt?: string } = {},
): Promise<ProjectKey> {
  const created = await api<{ fullKey: string; apiKey: { id: string; name: string } }>(
    'POST',
    `/api/projects/${projectId}/api-keys`,
    { name, ...(permissions ? { permissions } : {}), ...(expiresAt ? { expiresAt } : {}) },
    { token: owner.accessToken, ip },
  );
  return { id: created.apiKey.id, fullKey: created.fullKey, name: created.apiKey.name };
}

export async function revokeKey(owner: Account, projectId: string, keyId: string, ip: string): Promise<void> {
  await api('DELETE', `/api/projects/${projectId}/api-keys/${keyId}`, undefined, { token: owner.accessToken, ip });
}

// ---- Privacy rows

export async function privacyLogRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM privacy_request_logs WHERE project_id = $1 ORDER BY created_at`, [projectId]);
}

export async function devicesOf(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM device_identities WHERE project_id = $1 ORDER BY id`, [projectId]);
}

/** Rows of `table` naming any of these device rows (`device_identity_id`). */
export async function rowsNamingDevices(table: string, ids: string[]): Promise<number> {
  const [row] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE device_identity_id = ANY($1::uuid[])`, [ids]);
  return row.n;
}

/** The keyed hash erasure stores for a suppressed address (`erased_suppressions`, `erased_addresses`). */
export function addressHash(projectId: string, channel: string, address: string): string {
  return createHmac('sha256', deriveCredentialsKey('erased-suppression-v1')).update([projectId, channel, address].join('\n')).digest('hex');
}

/** The keyed hash the privacy log stores for a subject. */
export function subjectHash(projectId: string, type: 'externalUserId' | 'personId' | 'deviceFingerprint', value: string): string {
  return createHmac('sha256', deriveCredentialsKey('privacy-subject-v1')).update([projectId, type, value].join('\n')).digest('hex');
}

/** An active push token row for a device, as a token registration leaves it. */
export async function seedPushToken(projectId: string, deviceIdentityId: string, platform = 'ios'): Promise<string> {
  const token = `e2e-push-token-${randomBytes(16).toString('hex')}`;
  await sql(
    `INSERT INTO push_tokens (project_id, device_identity_id, token, platform, provider) VALUES ($1, $2, $3, $4, 'fcm')`,
    [projectId, deviceIdentityId, token, platform],
  );
  return token;
}

/** A link-click touchpoint keyed by the device's fingerprint, as the redirect records one. */
export async function seedTouchpoint(projectId: string, deviceFingerprint: string | null, distinctId: string | null = null): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO touchpoints (project_id, device_fingerprint, distinct_id, touchpoint_type, channel, utm_source)
     VALUES ($1, $2, $3, 'link_click', 'link', 'e2e') RETURNING id`,
    [projectId, deviceFingerprint, distinctId],
  );
  return row.id;
}

/** A clear suppression row for an address, as an unsubscribe or STOP leaves it. */
export async function seedSuppression(projectId: string, channel: string, address: string, reason = 'unsubscribed'): Promise<void> {
  await sql(
    `INSERT INTO channel_suppressions (project_id, channel, address, reason, source) VALUES ($1, $2, $3, $4, 'dashboard')`,
    [projectId, channel, address, reason],
  );
}

/** A segment with these person keys as members. */
export async function seedSegmentMembers(projectId: string, personKeys: string[]): Promise<string> {
  const [segment] = await sql<{ id: string }>(
    `INSERT INTO segments (project_id, name, definition) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
    [projectId, `E2E segment ${randomBytes(2).toString('hex')}`],
  );
  for (const key of personKeys) {
    await sql(`INSERT INTO segment_members (segment_id, project_id, person_key) VALUES ($1, $2, $3)`, [segment.id, projectId, key]);
  }
  return segment.id;
}

/**
 * A campaign row of this channel and a per-recipient `delivered` event of it for a
 * device. Email, SMS and WhatsApp events are address history; push events are the
 * device's own.
 */
export async function seedCampaignEvent(projectId: string, deviceIdentityId: string, channel: 'push' | 'email' | 'sms' | 'whatsapp'): Promise<string> {
  const [campaign] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs (project_id, title, channel, status) VALUES ($1, $2, $3, 'sent') RETURNING id`,
    [projectId, `E2E ${channel}`, channel],
  );
  const [event] = await sql<{ id: string }>(
    `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, occurred_at)
     VALUES ($1, $2, $3, 'delivered', now()) RETURNING id`,
    [projectId, campaign.id, deviceIdentityId],
  );
  return event.id;
}

/** Moves every live session's sign-in 16 minutes back, so the next refresh is no longer recent. */
export async function ageSignIn(userId: string): Promise<void> {
  const updated = await sql(
    `UPDATE auth_sessions SET authenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
    [userId],
  );
  if (updated.length === 0) throw new Error('No live session to age');
}

/** What the lane's customer API has written to its log so far. */
export function apiLogText(): string {
  return readFileSync(path.join(LOG_DIR, 'api.log'), 'utf8');
}

// ---- Page

/**
 * A toast in the notification list (not its screen-reader copy), by its exact title.
 * Found by the toast's own element: while a modal dialog is open the region is hidden
 * from the accessibility tree, though the toast is shown.
 */
export function toast(page: Page, title: string): Locator {
  return page.locator('li[data-swipe-direction]').filter({ has: page.getByText(title, { exact: true }) });
}

/**
 * Holds matching requests until the returned function is called, so a pending state
 * can be seen.
 */
export async function holdRequests(page: Page, method: string, pathPart: string): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname.includes(pathPart),
    async (route: Route) => {
      if (route.request().method() === method) await released;
      await route.fallback();
    },
  );
  return release;
}

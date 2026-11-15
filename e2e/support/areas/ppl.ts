import { createHmac, randomBytes } from 'crypto';
import type { Browser, Page } from '@playwright/test';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff, grantSuperAdmin } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { newPersonContext } from '../fixtures';
import { assertE2eDatabase, stackEnv } from '../stack';

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

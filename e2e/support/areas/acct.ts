import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import type { Browser, BrowserContext, Locator, Page, Response } from '@playwright/test';
import { Client } from 'pg';
import { adminApi } from '../admin';
import { apiUrl, newClientIp, type Account } from '../api';
import { totpCode, totpStep, type TotpEnrolment } from '../factors';
import { assertE2eDatabase, LOG_DIR, stackEnv } from '../stack';

/**
 * Helpers for the ACCT specs (the signed-in person's /settings): raw API calls that keep
 * status and headers, the rows a factor change leaves, a staff authenticator app made
 * through the admin API, and a few page locators.
 */

// ---- Raw API calls

export interface RawResponse<T = any> {
  status: number;
  /** The `data` of the envelope on success, or the error body. */
  body: T;
  /** The error message, when the body has one. */
  message?: string;
  headers: Headers;
  text: string;
}

export interface RawOptions {
  ip: string;
  token?: string;
}

/** Any JSON request to the customer API; never throws. */
export async function call<T = any>(method: string, path: string, body: unknown, { ip, token }: RawOptions): Promise<RawResponse<T>> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  const ok = response.status >= 200 && response.status < 300;
  const data = ok && parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  const message = !ok && parsed && typeof parsed === 'object' ? (parsed.message as string | undefined) : undefined;
  return { status: response.status, body: data, message, headers: response.headers, text };
}

/** Throws unless the call answered 2xx; answers the `data`. */
export async function ok<T = any>(method: string, path: string, body: unknown, options: RawOptions): Promise<T> {
  const answer = await call<T>(method, path, body, options);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`${method} ${path} answered ${answer.status}: ${answer.text.slice(0, 300)}`);
  }
  return answer.body;
}

/** A password sign-in through the API (account with no second factor): a new session's access token. */
export async function passwordSession(account: Pick<Account, 'email' | 'password'>, ip: string, password = account.password): Promise<string> {
  const signedIn = await ok<{ tokens: { accessToken: string } }>('POST', '/api/auth/login', { email: account.email, password }, { ip });
  return signedIn.tokens.accessToken;
}

/**
 * A new session for an account with a second factor: the password, then one of its
 * recovery codes (spent), through the API. Answers the session's access token.
 */
export async function recoveryCodeSession(account: Pick<Account, 'email' | 'password'>, code: string, ip: string): Promise<string> {
  const first = await ok<{ requiresSecondFactor?: boolean; handle?: string }>(
    'POST',
    '/api/auth/login',
    { email: account.email, password: account.password },
    { ip },
  );
  if (!first.requiresSecondFactor || !first.handle) throw new Error(`login asked for no second factor: ${JSON.stringify(first)}`);
  const signedIn = await ok<{ tokens: { accessToken: string } }>('POST', '/api/auth/login/recovery-code', { handle: first.handle, code }, { ip });
  return signedIn.tokens.accessToken;
}

/** Re-authenticates a session with its password; answers the new access token (and leaves a proof). */
export async function reauthWithPassword(token: string, password: string, ip: string): Promise<string> {
  return (await ok<{ accessToken: string }>('POST', '/api/auth/reauth', { password }, { token, ip })).accessToken;
}

/**
 * An access token for the page's own session, from its refresh cookie (the request
 * context shares the browser's cookies, so the rotated cookie stays with the page).
 */
export async function pageAccessToken(page: Page, ip: string): Promise<string> {
  const response = await page.request.post('/api/auth/refresh', {
    headers: { 'X-Chumbaq-Client': 'web', 'X-Forwarded-For': ip },
    data: {},
  });
  if (!response.ok()) throw new Error(`refresh answered ${response.status()}: ${await response.text()}`);
  return ((await response.json()) as { data: { accessToken: string } }).data.accessToken;
}

// ---- Database

export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
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

/** The database's clock now, to scope later reads to what the test caused. */
export async function dbNow(): Promise<Date> {
  const [row] = await sql<{ now: Date }>('SELECT clock_timestamp() AS now');
  return row.now;
}

/** auth_events types (and reasons) for a user since `since`, oldest first. */
export function authEvents(userId: string, since: Date, type?: string): Promise<Array<{ type: string; reason: string | null }>> {
  const params: unknown[] = [userId, since];
  const extra = type ? ` AND type = $${params.push(type)}` : '';
  return sql(`SELECT type, reason FROM auth_events WHERE user_id = $1 AND created_at >= $2${extra} ORDER BY created_at, id`, params);
}

export function authEventsByEmail(email: string, since: Date, type: string): Promise<Array<{ type: string }>> {
  return sql(`SELECT type FROM auth_events WHERE lower(email) = lower($1) AND created_at >= $2 AND type = $3`, [email, since, type]);
}

export async function userRow(userId: string): Promise<{ session_version: number; password_hash: string }> {
  const [row] = await sql('SELECT session_version, password_hash FROM users WHERE id = $1', [userId]);
  return row;
}

export function totpRow(userId: string): Promise<Array<{ secret_ciphertext: string; confirmed_at: Date | null; last_used_step: string }>> {
  return sql('SELECT secret_ciphertext, confirmed_at, last_used_step FROM totp_secrets WHERE user_id = $1', [userId]);
}

export function recoveryCodeRows(userId: string): Promise<Array<{ code_hash: string; used_at: Date | null }>> {
  return sql('SELECT code_hash, used_at FROM recovery_codes WHERE user_id = $1', [userId]);
}

export async function makeSuperAdmin(userId: string): Promise<void> {
  await sql('UPDATE users SET is_super_admin = true WHERE id = $1', [userId]);
}

export async function markUnverified(userId: string): Promise<void> {
  await sql('UPDATE users SET email_verified_at = NULL WHERE id = $1', [userId]);
}

// ---- TOTP

/** `nextTotpCode`, waiting for the next 30-second step when this one's two are used up. */
export async function freshTotpCode(enrolment: TotpEnrolment): Promise<string> {
  while (enrolment.lastStep + 1 > totpStep() + 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const step = Math.max(totpStep(), enrolment.lastStep + 1);
  enrolment.lastStep = step;
  return totpCode(enrolment.secret, 0, step * 30_000);
}

// ---- Staff, through the admin API

async function staffCall(method: string, path: string, body: unknown, token?: string): Promise<any> {
  const base = process.env.E2E_ADMIN_API_URL;
  if (!base) throw new Error('E2E_ADMIN_API_URL is not set: run the specs through playwright.config.ts');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'admin',
      'X-Forwarded-For': newClientIp(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
  const parsed = text ? JSON.parse(text) : undefined;
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
}

/**
 * A super admin with no factor at all turns on an authenticator app in the admin app's
 * enrolment-only session (the e2e stack does not require staff passkeys): the staff
 * TOTP the customer app then shows as on.
 */
export async function enrolStaffTotp(staff: Pick<Account, 'email' | 'password'>): Promise<TotpEnrolment> {
  const login = await staffCall('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password });
  if (login?.step !== 'enrol') throw new Error(`staff login answered ${JSON.stringify(login)}`);
  const setup = await staffCall('POST', '/api/staff/auth/totp/setup', {}, login.accessToken);
  const enrolment: TotpEnrolment = { secret: setup.secret, uri: setup.uri, recoveryCodes: [], lastStep: -1 };
  await staffCall('POST', '/api/staff/auth/totp/confirm', { code: await freshTotpCode(enrolment) }, login.accessToken);
  return enrolment;
}

// ---- Page

/** A toast, by its title, in the notifications region. */
export function toastTitled(page: Page, title: string): Locator {
  return page.getByRole('region', { name: /Notifications/ }).locator('li').filter({ hasText: title });
}

/** Records the status of every response to `method path` on the page. */
export function recordResponses(page: Page, method: string, path: string): Response[] {
  const seen: Response[] = [];
  page.on('response', (response) => {
    if (response.request().method() === method && new URL(response.url()).pathname === path) seen.push(response);
  });
  return seen;
}

/** Holds `method` requests to `path` until the returned function is called. */
export async function holdRequests(page: Page, method: string, path: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === method && new URL(route.request().url()).pathname === path) await gate;
    await route.continue();
  });
  return release;
}

/** The change-password form's fields (their labels have no htmlFor). */
export function passwordField(page: Page, name: 'currentPassword' | 'newPassword' | 'confirmPassword'): Locator {
  return page.locator(`input[name="${name}"]`);
}

// ---- Seeded rows (ACCT chunk 2)

/**
 * A customer-scope passkey row with placeholder key material: it is listed, counted and
 * offered like any key, but can never verify. For a second key a test only lists or
 * removes, since a tab's virtual authenticator refuses to make two for one account.
 */
export async function seedPasskeyRow(userId: string, name: string, scope: 'customer' | 'staff' = 'customer'): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, scope)
     VALUES ($1, $2, $3, 0, '[]', 'singleDevice', false, $4, $5) RETURNING id`,
    [userId, `e2e-placeholder-${randomUUID()}`, Buffer.from('not-a-key'), name, scope],
  );
  return row.id;
}

export function passkeyRows(userId: string): Promise<Array<{ id: string; name: string; scope: string }>> {
  return sql('SELECT id, name, scope FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at, id', [userId]);
}

/**
 * A pending staff reset of the account's factors, as `request()` leaves it once the
 * owner's warning went out: due 72 hours from now.
 */
export async function seedPendingFactorReset(userId: string): Promise<{ id: string; executeAfter: Date; requestedAt: Date }> {
  const [row] = await sql<{ id: string; execute_after: Date; requested_at: Date }>(
    `INSERT INTO factor_resets (user_id, status, requested_by_email, reason, execute_after, notice_sent_at, verification_method, verification_notes)
     VALUES ($1, 'pending', 'staff@example.com', 'Lost phone', now() + interval '72 hours', now(), 'video_call', 'Checked on a video call')
     RETURNING id, execute_after, requested_at`,
    [userId],
  );
  return { id: row.id, executeAfter: row.execute_after, requestedAt: row.requested_at };
}

export async function factorResetRow(id: string): Promise<{ status: string; cancelled_by: string | null; cancelled_at: Date | null }> {
  const [row] = await sql('SELECT status, cancelled_by, cancelled_at FROM factor_resets WHERE id = $1', [id]);
  return row;
}

/** Moves every live sign-in of the account 20 minutes back, past the 15-minute recent window. */
export async function ageSignIns(userId: string): Promise<void> {
  await sql(`UPDATE auth_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1`, [userId]);
}

export function sessionRows(userId: string): Promise<Array<{ id: string; revoked_at: Date | null; user_agent: string | null }>> {
  return sql('SELECT id, revoked_at, user_agent FROM auth_sessions WHERE user_id = $1 ORDER BY created_at, id', [userId]);
}

/** The factors' rows, to compare before and after something that must not touch them. */
export async function factorSnapshot(userId: string) {
  const [user] = await sql<{ password_reset_at: Date | null; factors_reset_at: Date | null }>(
    'SELECT password_reset_at, factors_reset_at FROM users WHERE id = $1',
    [userId],
  );
  return {
    totp: await sql('SELECT secret_ciphertext, confirmed_at FROM totp_secrets WHERE user_id = $1', [userId]),
    passkeys: await sql('SELECT id, credential_id, name, scope FROM webauthn_credentials WHERE user_id = $1 ORDER BY id', [userId]),
    recoveryCodes: await sql('SELECT code_hash, used_at FROM recovery_codes WHERE user_id = $1 ORDER BY code_hash', [userId]),
    passwordResetAt: user.password_reset_at,
    factorsResetAt: user.factors_reset_at,
  };
}

/** Adds someone to a project with a role, as an accepted invite leaves it. */
export async function addProjectMember(projectId: string, userId: string, role: 'owner' | 'admin' | 'member', addedBy: string): Promise<void> {
  await sql(
    `INSERT INTO project_members (project_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, clock_timestamp())`,
    [projectId, userId, role, addedBy],
  );
}

// ---- View-as

/** A staff member's one-time view-as link for the tenant (the admin API's handoff). */
export async function viewAsHandoffUrl(staffToken: string, tenantId: string, ip: string): Promise<string> {
  const handoff = await adminApi<{ url: string }>(
    'POST',
    `/api/admin/tenants/${tenantId}/impersonate`,
    { reason: 'E2E: checking account settings while viewing as' },
    staffToken,
    ip,
  );
  return handoff.url;
}

/** Spends a view-as link on the customer API, as the /impersonate page does; answers the view-as token. */
export async function exchangeViewAsUrl(url: string, ip: string): Promise<string> {
  const code = new URL(url).hash.replace(/^#code=/, '');
  return (await ok<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip })).accessToken;
}

/**
 * Opens a view-as link in `page` (a tab of its own: the session is kept per tab) and
 * waits for the tenant's project list.
 */
export async function openViewAs(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForURL(/\/projects$/);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
}

/** Every account route the settings page uses, with a body each would accept. */
export function accountRoutes(ids: { sessionId: string; passkeyId: string }): Array<{ method: string; path: string; body?: unknown }> {
  return [
    { method: 'GET', path: '/api/auth/sessions' },
    { method: 'DELETE', path: '/api/auth/sessions' },
    { method: 'DELETE', path: `/api/auth/sessions/${ids.sessionId}` },
    { method: 'GET', path: '/api/auth/activity' },
    { method: 'GET', path: '/api/auth/passkeys' },
    { method: 'POST', path: '/api/auth/passkeys/options' },
    { method: 'POST', path: '/api/auth/passkeys', body: { response: {}, name: 'E2E' } },
    { method: 'DELETE', path: `/api/auth/passkeys/${ids.passkeyId}` },
    { method: 'GET', path: '/api/auth/factors' },
    { method: 'POST', path: '/api/auth/totp/setup' },
    { method: 'POST', path: '/api/auth/totp/confirm', body: { code: '123456' } },
    { method: 'DELETE', path: '/api/auth/totp' },
    { method: 'POST', path: '/api/auth/recovery-codes' },
    { method: 'GET', path: '/api/auth/factor-reset' },
    { method: 'DELETE', path: '/api/auth/factor-reset' },
    { method: 'PATCH', path: '/api/users/me/password', body: { currentPassword: 'e2e-Password-123!', newPassword: 'Another-Passw0rd!' } },
  ];
}

/** A request with any Authorization header (or none); never throws. */
export async function callWithAuthorization(method: string, path: string, body: unknown, ip: string, authorization?: string): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip,
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, message: parsed?.message, headers: response.headers, text };
}

// ---- Browsers

export const CHROME_ON_MACOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const FIREFOX_ON_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
export const SAFARI_ON_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** A separate browser (another device) with its own client address and user agent. */
export async function deviceContext(browser: Browser, baseURL: string | undefined, userAgent: string): Promise<{ context: BrowserContext; ip: string }> {
  const ip = newClientIp();
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, userAgent, extraHTTPHeaders: { 'X-Forwarded-For': ip } });
  return { context, ip };
}

/** Answers the customer app's "Confirm it is you" dialog with an authenticator-app code. */
export async function confirmWithTotpCode(page: Page, code: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await dialog.getByLabel('Code from your authenticator app').fill(code);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** Answers the customer app's "Confirm it is you" dialog with the tab's passkey. */
export async function confirmWithPasskey(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** What the API process has logged since `mark` (a byte offset from `apiLogMark`). */
export function apiLogMark(): number {
  const file = path.join(LOG_DIR, 'api.log');
  return existsSync(file) ? statSync(file).size : 0;
}

export function apiLogSince(mark: number): string {
  const file = path.join(LOG_DIR, 'api.log');
  return readFileSync(file).subarray(mark).toString('utf8');
}

/** The claims of a JWT, unverified. */
export function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

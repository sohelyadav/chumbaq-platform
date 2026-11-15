import type { Locator, Page, Response } from '@playwright/test';
import { Client } from 'pg';
import { apiUrl, newClientIp, type Account } from '../api';
import { totpCode, totpStep, type TotpEnrolment } from '../factors';
import { assertE2eDatabase, stackEnv } from '../stack';

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

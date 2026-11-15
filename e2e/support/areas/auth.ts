import { createHash, createHmac, randomBytes } from 'crypto';
import path from 'path';
import type { Locator, Page } from '@playwright/test';
import Redis from 'ioredis';
import { Client } from 'pg';
import { adminApi, adminUrl, enrolAndSignInStaff } from '../admin';
import { api, apiUrl, createAccount, newClientIp, uniqueEmail, type Account } from '../api';
import { extractLink, waitForMail } from '../mailbox';
import { nextTotpCode, recoveryCodeItems, settingsCard, totpCode, totpSetupKey, totpStep, type TotpEnrolment } from '../factors';
import { portInUse, run, stopAll, waitForUrl } from '../processes';
import { appEnvironment, assertE2eDatabase, assertE2eRedisDb, REPO_ROOT, runSecrets, stackEnv, stackPorts } from '../stack';

/**
 * Helpers for the AUTH specs: raw API calls that keep the status and headers, the
 * database and Redis rows sign-in leaves behind, and the browser steps the sign-in
 * page needs (the login form, signing out, a WebAuthn assertion made in the page).
 */

// ---- Raw API calls

export interface RawResponse<T = any> {
  status: number;
  /** The `data` of the envelope on success, or the error body. */
  body: T;
  /** The unparsed body, for byte comparisons. */
  text: string;
  setCookie: string | null;
}

export interface RawOptions {
  ip: string;
  token?: string;
  /** Send X-Chumbaq-Client (default true). */
  clientHeader?: boolean;
  /** A Cookie header to send as is (`chumbaq_refresh=<token>`). */
  cookie?: string;
}

/** A JSON request that never throws: status, body and Set-Cookie for the test to check. */
export async function call<T = any>(
  method: string,
  path: string,
  body: unknown,
  { ip, token, clientHeader = true, cookie }: RawOptions,
): Promise<RawResponse<T>> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Forwarded-For': ip,
      ...(clientHeader ? { 'X-Chumbaq-Client': 'web' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
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
  return {
    status: response.status,
    body: ok && parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed,
    text,
    setCookie: response.headers.get('set-cookie'),
  };
}

/** A JSON POST that never throws: status, body and Set-Cookie for the test to check. */
export function post<T = any>(path: string, body: unknown, options: RawOptions): Promise<RawResponse<T>> {
  return call<T>('POST', path, body, options);
}

/** The refresh token a Set-Cookie header sets, or null (none, or one that clears it). */
export function refreshTokenIn(setCookie: string | null): string | null {
  const match = /(?:^|,\s*)chumbaq_refresh=([^;]*)/.exec(setCookie ?? '');
  return match && match[1] ? match[1] : null;
}

/** Whether a Set-Cookie header clears the refresh cookie (empty value, expired at the epoch). */
export function clearsRefreshCookie(setCookie: string | null): boolean {
  return /(?:^|,\s*)chumbaq_refresh=;/.test(setCookie ?? '') && /Expires=Thu, 01 Jan 1970/.test(setCookie ?? '');
}

/** `POST /api/auth/refresh` as the dashboard sends it, with the given refresh token as the cookie. */
export function refreshWith(refreshToken: string | null, ip: string, body: unknown = {}) {
  return post<any>('/api/auth/refresh', body, {
    ip,
    ...(refreshToken ? { cookie: `chumbaq_refresh=${refreshToken}` } : {}),
  });
}

export function passwordStep(account: Pick<Account, 'email' | 'password'>, ip: string, password = account.password) {
  return post<{ requiresSecondFactor?: true; handle: string; methods: string[]; tokens?: { accessToken: string }; message?: string }>(
    '/api/auth/login',
    { email: account.email, password },
    { ip },
  );
}

/** The password step of an account with a second factor: answers the handle. */
export async function handleFor(account: Pick<Account, 'email' | 'password'>, ip: string): Promise<string> {
  const answer = await passwordStep(account, ip);
  if (answer.status !== 200 || !answer.body?.handle) {
    throw new Error(`Expected a second-factor handle, got ${answer.status}: ${answer.text.slice(0, 300)}`);
  }
  return answer.body.handle;
}

// ---- Database

export async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
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
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return withDb(async (db) => (await db.query(text, params)).rows as T[]);
}

/** The database's clock now, to scope later reads to what the test caused. */
export async function dbNow(): Promise<Date> {
  const [row] = await sql<{ now: Date }>('SELECT clock_timestamp() AS now');
  return row.now;
}

export interface AuthEventRow {
  type: string;
  reason: string | null;
  email: string | null;
  user_id: string | null;
  session_id: string | null;
}

/** auth_events for an address since `since`, oldest first. */
export function authEventsFor(email: string, since: Date): Promise<AuthEventRow[]> {
  return sql<AuthEventRow>(
    `SELECT type, reason, email, user_id, session_id FROM auth_events
      WHERE lower(email) = lower($1) AND created_at >= $2 ORDER BY created_at, id`,
    [email, since],
  );
}

export interface SessionRow {
  id: string;
  amr: string[];
  authenticated_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export function sessionsSince(userId: string, since: Date): Promise<SessionRow[]> {
  return sql<SessionRow>(
    `SELECT id, amr, authenticated_at, revoked_at, created_at FROM auth_sessions
      WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at`,
    [userId, since],
  );
}

export async function suspendAccount(userId: string): Promise<void> {
  await sql('UPDATE users SET suspended_at = now() WHERE id = $1', [userId]);
}

export async function makeSuperAdmin(userId: string): Promise<void> {
  await sql('UPDATE users SET is_super_admin = true WHERE id = $1', [userId]);
}

/**
 * A staff-scope passkey row for the account, as the admin app's enrolment leaves one.
 * The customer API only asks whether one exists; its key material is never used here.
 */
export async function insertStaffPasskeyRow(userId: string): Promise<void> {
  await sql(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, scope)
     VALUES ($1, $2, $3, 0, '["internal"]', 'singleDevice', false, 'E2E staff key', 'staff')`,
    [userId, randomBytes(32).toString('base64url'), randomBytes(77)],
  );
}

/** The account's customer passkeys' credential ids (base64url, as the browser reports them). */
export async function customerCredentialIds(userId: string): Promise<string[]> {
  const rows = await sql<{ credential_id: string }>(
    `SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 AND scope = 'customer' ORDER BY created_at`,
    [userId],
  );
  return rows.map((row) => row.credential_id);
}

/**
 * A password reset link's token, stored as the API stores one it mailed (only its
 * SHA-256), good for 30 minutes. For tests about what a reset does, not the mail.
 */
export async function seedResetToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql(
    `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, 'reset_password', $2, now() + interval '30 minutes')`,
    [userId, createHash('sha256').update(token).digest('hex')],
  );
  return token;
}

export interface AccountTokenSeed {
  purpose?: 'reset_password' | 'verify_email';
  /** Postgres interval from now until it expires (negative: already expired). Default by purpose. */
  expiresIn?: string;
  /** A link support issued through the CLI (`staff_issued`). */
  staffIssued?: boolean;
  /** Postgres interval from now until a staff link becomes usable (`usable_after`). */
  usableIn?: string;
}

/**
 * An account link's token, stored as the API stores one (only its SHA-256): a mailed
 * reset (30 minutes) or verify link (24 hours), or a staff-issued reset link with its
 * wait. For tests about what the page and the route do with it, not the mail.
 */
export async function seedAccountToken(userId: string, seed: AccountTokenSeed = {}): Promise<string> {
  const purpose = seed.purpose ?? 'reset_password';
  const token = randomBytes(32).toString('base64url');
  const expiresIn = seed.expiresIn ?? (purpose === 'reset_password' ? '30 minutes' : '24 hours');
  await sql(
    `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at, staff_issued, usable_after)
     VALUES ($1, $2, $3, now() + $4::interval, $5, CASE WHEN $6::text IS NULL THEN NULL ELSE now() + $6::interval END)`,
    [userId, purpose, createHash('sha256').update(token).digest('hex'), expiresIn, seed.staffIssued ?? false, seed.usableIn ?? null],
  );
  return token;
}

export interface AccountTokenRow {
  purpose: string;
  used_at: Date | null;
  usable_after: Date | null;
  expires_at: Date;
}

/** The stored row of a raw account token. */
export async function tokenRow(token: string): Promise<AccountTokenRow> {
  const [row] = await sql<AccountTokenRow>(
    'SELECT purpose, used_at, usable_after, expires_at FROM account_tokens WHERE token_hash = $1',
    [createHash('sha256').update(token).digest('hex')],
  );
  if (!row) throw new Error('No account_tokens row for that token');
  return row;
}

export interface UserState {
  name: string;
  email: string;
  password_hash: string;
  session_version: number;
  email_verified_at: Date | null;
  password_reset_at: Date | null;
  suspended_at: Date | null;
}

export async function userState(userId: string): Promise<UserState> {
  const [row] = await sql<UserState>(
    `SELECT name, email, password_hash, session_version, email_verified_at, password_reset_at, suspended_at
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!row) throw new Error(`No users row ${userId}`);
  return row;
}

export function usersWithEmail(email: string): Promise<Array<{ id: string }>> {
  return sql<{ id: string }>('SELECT id FROM users WHERE email = lower($1)', [email]);
}

export async function markUnverified(userId: string): Promise<void> {
  await sql('UPDATE users SET email_verified_at = NULL WHERE id = $1', [userId]);
}

/** As a staff factor reset `ago` (a Postgres interval) leaves the account. */
export async function setFactorsResetAgo(userId: string, ago: string): Promise<void> {
  await sql('UPDATE users SET factors_reset_at = now() - $2::interval WHERE id = $1', [userId, ago]);
}

export interface SessionState {
  id: string;
  current_jti: string;
  revoked_at: Date | null;
  created_at: Date;
}

/** Every auth_sessions row of the account, oldest first. */
export function allSessions(userId: string): Promise<SessionState[]> {
  return sql<SessionState>(
    'SELECT id, current_jti, revoked_at, created_at FROM auth_sessions WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
}

/** Polls auth_events until one of `type` for the address appears since `since`; answers it. */
export async function waitForAuthEvent(email: string, since: Date, type: string, timeoutMs = 10_000): Promise<AuthEventRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await authEventsFor(email, since)).find((event) => event.type === type);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`No ${type} auth event for ${email} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export interface AuditLogRow {
  actor_id: string | null;
  actor_email: string;
  action: string;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
}

export function auditLogsFor(targetId: string, action: string): Promise<AuditLogRow[]> {
  return sql<AuditLogRow>(
    'SELECT actor_id, actor_email, action, target_id, metadata FROM admin_audit_logs WHERE target_id = $1 AND action = $2 ORDER BY created_at',
    [targetId, action],
  );
}

// ---- Sign-up links and view-as

/**
 * Registers a new address through the API and answers the sign-up link it mailed,
 * without completing it.
 */
export async function mailedSignupLink(ip: string, label: string, name: string): Promise<{ email: string; name: string; link: string }> {
  const email = uniqueEmail(label);
  await api('POST', '/api/auth/register', { email, name }, { ip });
  const mail = await waitForMail(email, { subjectIncludes: 'Finish creating your Chumbaq account' });
  return { email, name, link: extractLink(mail, '/complete-signup') };
}

/**
 * A view-as access token for the tenant: a new super admin enrols a passkey and signs
 * in to the admin app in `page` (its own tab), starts view-as, and the one-time code is
 * spent on the customer API, as the /impersonate page would.
 */
export async function viewAsToken(page: Page, tenantId: string, ip: string): Promise<string> {
  const staff = await createAccount(ip, 'staff', 'Sam Staff');
  await makeSuperAdmin(staff.userId);
  const staffToken = await enrolAndSignInStaff(page, staff);
  const handoff = await adminApi<{ url: string }>(
    'POST',
    `/api/admin/tenants/${tenantId}/impersonate`,
    { reason: 'E2E: checking a view-as session' },
    staffToken,
    ip,
  );
  const code = new URL(handoff.url).hash.replace(/^#code=/, '');
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip: newClientIp() });
  return session.accessToken;
}

// ---- Redis

/**
 * Records `failures` failed first-step sign-ins for the address from `ip`'s network,
 * as that many wrong passwords from there would (the API's attempt counter in Redis).
 * The route throttle allows only five a minute, so this stands in for minutes of waiting.
 */
export async function seedSignInFailures(email: string, ip: string, failures = 10): Promise<void> {
  const env = stackEnv();
  const redis = new Redis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    db: assertE2eRedisDb(env),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
  try {
    const key = `chumbaq:signin-attempts:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
    await redis.hincrby(key, `net:${ip}`, failures);
    await redis.hincrby(key, 'total', failures);
    await redis.expire(key, 15 * 60);
  } finally {
    redis.disconnect();
  }
}

// ---- TOTP

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `nextTotpCode`, waiting for the next 30-second step when this one's two are used up. */
export async function freshTotpCode(enrolment: TotpEnrolment): Promise<string> {
  for (;;) {
    try {
      return nextTotpCode(enrolment);
    } catch {
      await sleep((totpStep() + 1) * 30_000 - Date.now() + 200);
    }
  }
}

/** Six digits that are none of the codes the API would take now (one step either side). */
export function wrongTotpCode(secret: string): string {
  const valid = new Set([-1, 0, 1, 2].map((offset) => totpCode(secret, offset)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

/**
 * Turns on an authenticator app in /settings for a signed-in account that already has a
 * customer passkey: "Confirm it is you" then offers the passkey, which the tab's virtual
 * authenticator answers. Answers the secret and the recovery codes it replaced the
 * passkey's with.
 */
export async function enrolTotpConfirmingWithPasskey(page: Page): Promise<TotpEnrolment> {
  await page.goto('/settings');
  const card = settingsCard(page, 'Authenticator app');
  await card.getByRole('button', { name: 'Set up an authenticator app' }).click();
  const key = totpSetupKey(card);
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await dialog.or(key).first().waitFor();
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await key.waitFor();
  const secret = ((await key.textContent()) ?? '').trim();
  const enrolment: TotpEnrolment = { secret, recoveryCodes: [], lastStep: -1 };
  await card.getByLabel('Code from your authenticator app').fill(nextTotpCode(enrolment));
  await card.getByRole('button', { name: 'Turn on' }).click();
  const codes = recoveryCodeItems(card);
  await codes.first().waitFor();
  enrolment.recoveryCodes = await codes.allTextContents();
  await card.getByRole('button', { name: 'I have saved them' }).click();
  return enrolment;
}

// ---- Browser

/** Holds every request to `path` until `release` is called, so a waiting state can be seen. */
export async function holdRequests(page: Page, path: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${path}`, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

export interface CapturedResponse {
  status: number;
  text: string;
  json: any;
  setCookie: string | null;
}

/**
 * Passes every request to `path` through and keeps each answer, body included. For
 * answers the page navigates away from at once (a redirect after a refusal), whose body
 * the browser would otherwise have dropped by the time a test reads it. With `holdUntil`,
 * each request waits for it first, so a waiting state can be seen.
 */
export async function captureResponses(
  page: Page,
  path: string,
  { holdUntil }: { holdUntil?: Promise<void> } = {},
): Promise<CapturedResponse[]> {
  const captured: CapturedResponse[] = [];
  await page.route(`**${path}`, async (route) => {
    if (holdUntil) await holdUntil;
    const response = await route.fetch();
    const text = await response.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    captured.push({ status: response.status(), text, json, setCookie: response.headers()['set-cookie'] ?? null });
    await route.fulfill({ response });
  });
  return captured;
}

/** The Bearer token of the next API request the page sends with one. */
export function nextBearer(page: Page): Promise<string> {
  return page
    .waitForRequest((request) => new URL(request.url()).pathname.startsWith('/api/') && Boolean(request.headers()['authorization']))
    .then((request) => request.headers()['authorization'].replace(/^Bearer /, ''));
}

/** Fills the login form and clicks "Login". */
export async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
}

/** "Log out" from the account menu (the button named after the person). */
export async function signOutFromMenu(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.getByRole('heading', { name: 'Login to your account' }).waitFor();
}

/** The sign-in form's message line (it has no role). */
export function formMessage(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true });
}

/** The refresh cookie the API sets on sign-in, in this browser context, if any. */
export async function refreshCookie(page: Page) {
  return (await page.context().cookies()).find((cookie) => cookie.name.endsWith('chumbaq_refresh'));
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string;
}

/**
 * Answers WebAuthn request options (as the API gives them) with the tab's virtual
 * authenticator, in the page's own origin, and returns the assertion in the JSON shape
 * the API takes. `credentialId` (base64url) picks the credential; by default the options'
 * own allow list, or a discoverable one when it is empty.
 */
export async function assertionInPage(
  page: Page,
  options: { challenge: string; rpId?: string; userVerification?: string; allowCredentials?: Array<{ id: string }> },
  credentialId?: string,
): Promise<AuthenticationResponseJSON> {
  const allow = credentialId ? [credentialId] : (options.allowCredentials ?? []).map((c) => c.id);
  return page.evaluate(
    async ({ challenge, rpId, userVerification, allow }) => {
      const fromB64url = (value: string) => {
        const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      };
      const toB64url = (buffer: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const credential = (await navigator.credentials.get({
        publicKey: {
          challenge: fromB64url(challenge),
          rpId,
          userVerification: userVerification as UserVerificationRequirement,
          allowCredentials: allow.map((id) => ({ type: 'public-key' as const, id: fromB64url(id) })),
          timeout: 30_000,
        },
      })) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;
      return {
        id: credential.id,
        rawId: toB64url(credential.rawId),
        type: 'public-key' as const,
        response: {
          clientDataJSON: toB64url(response.clientDataJSON),
          authenticatorData: toB64url(response.authenticatorData),
          signature: toB64url(response.signature),
          ...(response.userHandle ? { userHandle: toB64url(response.userHandle) } : {}),
        },
        clientExtensionResults: {},
        authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      };
    },
    { challenge: options.challenge, rpId: options.rpId, userVerification: options.userVerification ?? 'preferred', allow },
  );
}

/** What a passkey's userHandle is for an account: its id as UTF-8, base64url. */
export const userHandleOf = (userId: string) => Buffer.from(userId, 'utf8').toString('base64url');

// ---- Staff-issued reset links, stale sign-ins and view-as in the browser (chunk 3)

/**
 * A reset link support issued through the CLI, live and still waiting out its delay,
 * as `admin:password-reset-link` leaves one (`staff_issued`, usable in a day). Seed it
 * after the browser signs in: a complete sign-in voids every such link.
 */
export function seedStaffLink(userId: string): Promise<string> {
  return seedAccountToken(userId, { staffIssued: true, usableIn: '24 hours', expiresIn: '48 hours' });
}

/**
 * Moves every one of the account's sign-ins 20 minutes back, past the 15 minutes a recent
 * sign-in lasts. The next access token (a refresh: a page load) carries the old time.
 */
export async function makeSignInStale(userId: string): Promise<void> {
  await sql(`UPDATE auth_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1`, [userId]);
}

/** The staff-link banner (an alert) on dashboard pages. */
export function staffLinkBanner(page: Page): Locator {
  return page.getByRole('alert').filter({ hasText: 'Support issued a link to reset your password.' });
}

/** A toast in the customer app's notifications region, by its title. */
export function toastTitled(page: Page, title: string): Locator {
  return page
    .getByRole('region', { name: /^Notifications/ })
    .getByRole('listitem')
    .filter({ has: page.getByText(title, { exact: true }) });
}

/** The re-authentication dialog. */
export function reauthDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Confirm it is you' });
}

/**
 * A new password sign-in through the API whose session is then made stale, and the
 * access token a refresh issues for it (carrying the old sign-in time). Answers the
 * token and the session id.
 */
export async function staleSession(account: Pick<Account, 'email' | 'password' | 'userId'>, ip: string): Promise<{ accessToken: string; sessionId: string }> {
  const login = await passwordStep(account, ip);
  const refreshToken = refreshTokenIn(login.setCookie);
  if (login.status !== 200 || !refreshToken) throw new Error(`Sign-in answered ${login.status}: ${login.text.slice(0, 300)}`);
  const sessionId = String(jwtClaimsOf(login.body.tokens!.accessToken).sid);
  await sql(`UPDATE auth_sessions SET authenticated_at = now() - interval '20 minutes' WHERE id = $1`, [sessionId]);
  const refreshed = await refreshWith(refreshToken, ip);
  if (refreshed.status !== 200) throw new Error(`Refresh answered ${refreshed.status}: ${refreshed.text.slice(0, 300)}`);
  return { accessToken: refreshed.body.accessToken, sessionId };
}

/** A JWT's claims, unverified. */
export function jwtClaimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * A view-as session for the tenant in this browser tab, as the admin app's "Open
 * view-as" link starts one: a new super admin signs in to the admin app in a second tab
 * of the same browser, starts view-as, and this tab opens the handoff link, landing on
 * /projects. Answers the staff member's access token.
 */
export async function viewAsInBrowser(page: Page, tenantId: string, ip: string): Promise<string> {
  const staff = await createAccount(ip, 'staff', 'Sam Staff');
  await makeSuperAdmin(staff.userId);
  const staffPage = await page.context().newPage();
  const staffToken = await enrolAndSignInStaff(staffPage, staff);
  await staffPage.close();
  const handoff = await adminApi<{ url: string }>(
    'POST',
    `/api/admin/tenants/${tenantId}/impersonate`,
    { reason: 'E2E: checking the cancel page in view-as' },
    staffToken,
    ip,
  );
  await page.goto(handoff.url);
  await page.waitForURL(/\/projects$/);
  return staffToken;
}

/** How many of the account's recovery codes are unused. */
export async function unusedRecoveryCodes(userId: string): Promise<number> {
  const [row] = await sql<{ n: string }>('SELECT count(*) AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
  return Number(row.n);
}

export interface PasskeyRow {
  id: string;
  counter: string;
  last_used_at: Date | null;
}

/** The account's customer passkey rows, oldest first. */
export function customerPasskeyRows(userId: string): Promise<PasskeyRow[]> {
  return sql<PasskeyRow>(
    `SELECT id, counter::text AS counter, last_used_at FROM webauthn_credentials WHERE user_id = $1 AND scope = 'customer' ORDER BY created_at`,
    [userId],
  );
}

/**
 * Rewrites the JSON answer of every request to `path` (its `data`), keeping everything
 * else, for a client that changes what the API asked for.
 */
export async function rewriteResponses(page: Page, path: string, change: (data: any) => void): Promise<void> {
  await page.route(`**${path}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json && typeof json === 'object' && json.data) change(json.data);
    await route.fulfill({ response, json });
  });
}

// ---- Redis state of a sign-in (P1 chunk 1)

async function withRedis<T>(work: (redis: Redis) => Promise<T>): Promise<T> {
  const env = stackEnv();
  const redis = new Redis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    db: assertE2eRedisDb(env),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
  try {
    return await work(redis);
  } finally {
    redis.disconnect();
  }
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** The address's sign-in attempt counters (`net:<ip>`, `total`, ...); empty when it has none. */
export function signInAttemptCounts(email: string): Promise<Record<string, string>> {
  return withRedis((redis) => redis.hgetall(`chumbaq:signin-attempts:${sha256Hex(email.trim().toLowerCase())}`));
}

/** Forgets a second-factor handle, as its five minutes running out would. */
export async function expireHandle(handle: string): Promise<void> {
  const removed = await withRedis((redis) => redis.del(`chumbaq:preauth:${sha256Hex(handle)}`));
  if (removed !== 1) throw new Error('No stored handle to expire');
}

/** Forgets a WebAuthn ceremony's challenge (`passwordless` by flow id, ...), as its expiry would. */
export async function expireChallenge(ceremony: string, id: string): Promise<void> {
  const removed = await withRedis((redis) => redis.del(`chumbaq:webauthn:${ceremony}:${sha256Hex(id)}`));
  if (removed !== 1) throw new Error(`No stored ${ceremony} challenge to expire`);
}

// ---- Staff side, for the audience of handles and factor resets

/** A request to the admin API as the admin app sends it, never throwing. */
export async function staffPost<T = any>(pathname: string, body: unknown, ip: string): Promise<RawResponse<T>> {
  const base = process.env.E2E_ADMIN_API_URL;
  if (!base) throw new Error('E2E_ADMIN_API_URL is not set: run the specs through playwright.config.ts');
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chumbaq-Client': 'admin', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  const ok = response.status >= 200 && response.status < 300;
  return {
    status: response.status,
    body: ok && parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed,
    text,
    setCookie: response.headers.get('set-cookie'),
  };
}

/**
 * A staff passkey for a super admin, made in the admin app's enrolment with the tab's
 * virtual authenticator (add one first). Leaves the tab on the admin sign-in page.
 */
export async function enrolStaffKeyInAdminApp(page: Page, staff: Pick<Account, 'email' | 'password'>): Promise<void> {
  await page.goto(adminUrl('/sign-in'));
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password', { exact: true }).fill(staff.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Passkey name').fill('E2E staff key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.getByText('Done. Sign in with your new passkey.').waitFor();
}

/**
 * A pending factor reset as a staff request leaves it once its warning went out, 72
 * hours ahead. Answers the row id.
 */
export async function seedPendingFactorReset(userId: string, requestedBy: Pick<Account, 'userId' | 'email'>): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO factor_resets
       (user_id, status, requested_by_id, requested_by_email, reason, execute_after, notice_sent_at,
        verification_method, verification_notes)
     VALUES ($1, 'pending', $2, $3, 'E2E: owner lost their phone', now() + interval '72 hours', now(),
             'video_call', 'E2E: saw the owner on a video call')
     RETURNING id`,
    [userId, requestedBy.userId, requestedBy.email],
  );
  return row.id;
}

export function factorResetRows(userId: string) {
  return sql<{ id: string; status: string; cancelled_at: Date | null; cancelled_by: string | null }>(
    'SELECT id, status, cancelled_at, cancelled_by FROM factor_resets WHERE user_id = $1 ORDER BY requested_at',
    [userId],
  );
}

/** The admin app's "Second factors" card on a tenant's page. */
export function secondFactorsCard(page: Page): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Second factors' }) });
}

// ---- A customer API with tenants' passkeys off

export interface ExtraApi {
  url: string;
  stop(): Promise<void>;
}

/**
 * A second customer API on the lane's database, Redis and secrets, with
 * PASSKEYS_FOR_TENANTS=false: an install where only staff hold passkeys. On a free port
 * at the API port + 92..96 (the mock and stub take + 90 and + 91, billing's + 97, + 98).
 */
export function startTenantPasskeysOffApi(): Promise<ExtraApi> {
  return startCustomerApiWith('tenant-passkeys-off', { PASSKEYS_FOR_TENANTS: 'false' });
}

/** Sends the page's requests under `prefix` (an API path) to another API, unchanged otherwise. */
export async function forwardToApi(page: Page, base: string, prefix: string): Promise<void> {
  await page.route(`**${prefix}**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

// ---- Instrumented WebAuthn in the page

export interface CredentialCall {
  conditional: boolean;
  /** Held back from the authenticator (`holdConditional`). */
  held?: boolean;
  settled: 'pending' | 'resolved' | 'rejected';
  error?: string;
  aborted: boolean;
}

/**
 * Records every navigator.credentials.get in the page's documents from the next
 * navigation (`window.__credentialGets`), passing each through untouched.
 *
 * With `holdConditional`, a conditional request (the email field's autofill) never
 * reaches the authenticator and waits, as it does in a browser until someone picks a
 * passkey from the list: Chromium's virtual authenticator answers or refuses one at once.
 * It ends only when its signal aborts (an AbortError, as the browser gives), and while it
 * waits another request is refused as the browser refuses it ("A request is already
 * pending.").
 */
export async function recordCredentialGets(page: Page, { holdConditional = false } = {}): Promise<void> {
  await page.addInitScript((hold: boolean) => {
    const container = navigator.credentials;
    if (!container) return;
    const original = container.get.bind(container);
    const calls: Array<Record<string, unknown>> = [];
    (window as unknown as { __credentialGets: unknown }).__credentialGets = calls;
    const settle = (call: Record<string, unknown>, promise: Promise<Credential | null>) =>
      promise.then(
        (value) => {
          call.settled = 'resolved';
          return value;
        },
        (error: unknown) => {
          call.settled = 'rejected';
          call.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          throw error;
        },
      );
    container.get = ((options?: CredentialRequestOptions) => {
      const conditional = (options as { mediation?: string } | undefined)?.mediation === 'conditional';
      const call: Record<string, unknown> = { conditional, settled: 'pending', aborted: false };
      const waiting = calls.some((c) => c.held && c.settled === 'pending');
      calls.push(call);
      options?.signal?.addEventListener('abort', () => (call.aborted = true));
      if (hold && waiting) {
        return settle(call, Promise.reject(new DOMException('A request is already pending.', 'InvalidStateError')));
      }
      if (hold && conditional) {
        call.held = true;
        return settle(
          call,
          new Promise<Credential | null>((_resolve, reject) => {
            const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
            if (options?.signal?.aborted) abort();
            options?.signal?.addEventListener('abort', abort);
          }),
        );
      }
      return settle(call, original(options));
    }) as typeof container.get;
  }, holdConditional);
}

export function credentialGets(page: Page): Promise<CredentialCall[]> {
  return page.evaluate(() => ((window as unknown as { __credentialGets?: CredentialCall[] }).__credentialGets ?? []).map((c) => ({ ...c })));
}

/** An assertion with one byte of its signature changed, so it can never verify. */
export function withBrokenSignature<T extends { response: { signature: string } }>(assertion: T): T {
  const bytes = Buffer.from(assertion.response.signature, 'base64url');
  bytes[bytes.length - 1] ^= 0xff;
  return { ...assertion, response: { ...assertion.response, signature: bytes.toString('base64url') } };
}

// ---- Sign-up, session restore, verify email and reset (P1, chunk 2)

/**
 * A second customer API on the lane's database, Redis and secrets, with `overrides` on
 * top of the stack's environment (an empty value unsets a setting the stack gives). On a
 * free port at the API port + 92..96, like `startTenantPasskeysOffApi`.
 */
export async function startCustomerApiWith(label: string, overrides: Record<string, string>): Promise<ExtraApi> {
  const ports = stackPorts();
  const taken = new Set(Object.values(ports));
  let port = 0;
  for (let candidate = ports.api + 92; candidate <= ports.api + 96; candidate++) {
    if (!taken.has(candidate) && !(await portInUse(candidate))) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error('No free port for the extra customer API');
  const env = { ...process.env, ...appEnvironment(runSecrets(), ports), ...overrides, API_PORT: String(port) };
  const started = run(`api-${label}-${port}`, 'node', ['dist/main'], { cwd: path.join(REPO_ROOT, 'apps/api'), env });
  try {
    await waitForUrl(started, `http://127.0.0.1:${port}/api/health`);
  } catch (error) {
    await stopAll([started]);
    throw error;
  }
  return { url: `http://localhost:${port}`, stop: () => stopAll([started]) };
}

/**
 * An access token with the same claims as `token` and `changes` applied, signed with the
 * run's JWT secret the way the API signs one (HS256). For a token that has expired
 * (`{ exp: <past> }`) without waiting for one to.
 */
export function resignedAccessToken(token: string, changes: Record<string, unknown>): string {
  const [header] = token.split('.');
  const payload = Buffer.from(JSON.stringify({ ...jwtClaimsOf(token), ...changes })).toString('base64url');
  const signature = createHmac('sha256', runSecrets().jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The view-as access token this tab holds (the customer app keeps it in sessionStorage). */
export async function viewAsAccessTokenIn(page: Page): Promise<string> {
  const raw = await page.evaluate(() => sessionStorage.getItem('chumbaq_impersonation'));
  const token = raw ? (JSON.parse(raw) as { accessToken?: string }).accessToken : undefined;
  if (!token) throw new Error('This tab holds no view-as session');
  return token;
}

/** The email-verification banner (a region named after what it asks). */
export function verificationBanner(page: Page): Locator {
  return page.getByRole('region', { name: 'Confirm your email address' });
}

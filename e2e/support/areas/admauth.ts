import { execFile } from 'child_process';
import { createHash, createHmac, hkdfSync, randomUUID } from 'crypto';
import path from 'path';
import { promisify } from 'util';
import Redis from 'ioredis';
import { Client } from 'pg';
import type { Page } from '@playwright/test';
import { issueStaffEnrolmentAllowance } from '../../../apps/api/src/modules/auth/staff-enrolment-allowances';
import { createAccount, newClientIp, type Account } from '../api';
import { adminUrl } from '../admin';
import { addAuthenticator, totpCode, totpStep, type TotpEnrolment, type VirtualAuthenticator } from '../factors';
import { claimPort, portRange, run, stopAll, waitForUrl, type Started } from '../processes';
import { appEnvironment, assertE2eDatabase, REPO_ROOT, runSecrets, stackEnv, stackPorts } from '../stack';

/**
 * Helpers for the ADMAUTH specs: staff sign-in on the admin app and its API.
 *
 * Staff are made with a direct `is_super_admin` update (the grant CLI is covered by the
 * admin spec and takes seconds per run); everything about signing in goes through the
 * real admin API or the admin app.
 */

const execFileAsync = promisify(execFile);

// ---- Database and Redis

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

async function withRedis<T>(work: (redis: Redis) => Promise<T>): Promise<T> {
  const env = stackEnv();
  const redis = new Redis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    db: Number(env.REDIS_DB),
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

/** The address's sign-in attempt counters (the API's `chumbaq:signin-attempts:<sha256>` hash). */
export function signInAttempts(email: string): Promise<Record<string, string>> {
  const key = `chumbaq:signin-attempts:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
  return withRedis((redis) => redis.hgetall(key));
}

/** auth_events rows of one type for a user or address since `since`. */
export async function authEvents(
  where: { userId?: string; email?: string },
  since: Date,
  type?: string,
): Promise<Array<{ type: string; reason: string | null; user_id: string | null; session_id: string | null }>> {
  const params: unknown[] = [since];
  const filters: string[] = ['created_at >= $1'];
  if (where.userId) filters.push(`user_id = $${params.push(where.userId)}`);
  if (where.email) filters.push(`lower(email) = lower($${params.push(where.email)})`);
  if (type) filters.push(`type = $${params.push(type)}`);
  return sql(`SELECT type, reason, user_id, session_id FROM auth_events WHERE ${filters.join(' AND ')} ORDER BY created_at`, params);
}

/** admin_audit_logs rows targeting a user since `since`, optionally of one action. */
export async function auditRows(
  userId: string,
  since: Date,
  action?: string,
): Promise<Array<{ action: string; actor_email: string; metadata: Record<string, unknown> | null }>> {
  const params: unknown[] = [userId, since];
  const extra = action ? ` AND action = $${params.push(action)}` : '';
  return sql(
    `SELECT action, actor_email, metadata FROM admin_audit_logs WHERE target_id = $1 AND created_at >= $2${extra} ORDER BY created_at`,
    params,
  );
}

export interface StaffSessionRow {
  id: string;
  amr: string[];
  enrolment_only: boolean;
  current_token_hash: string | null;
  revoked_at: Date | null;
  last_active_at: Date;
}

export function staffSessions(userId: string): Promise<StaffSessionRow[]> {
  return sql<StaffSessionRow>(
    `SELECT id, amr, enrolment_only, current_token_hash, revoked_at, last_active_at FROM staff_sessions WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
}

// ---- Staff members

/** A new account made staff (`users.is_super_admin`), with no staff factor yet. */
export async function makeStaff(ip: string, label = 'staff'): Promise<Account> {
  const account = await createAccount(ip, label, 'Sam Staff');
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [account.userId]);
  return account;
}

/**
 * A customer-scope passkey row for the account. Only its existence matters to staff
 * sign-in (a staff member holding any passkey needs an operator's code), so the key
 * material is a placeholder that can never verify.
 */
export async function seedCustomerPasskeyRow(userId: string): Promise<void> {
  await sql(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, scope)
     VALUES ($1, $2, $3, 0, '[]', 'singleDevice', false, 'Customer key', 'customer')`,
    [userId, `e2e-placeholder-${userId}`, Buffer.from('not-a-key')],
  );
}

/** An operator's enrolment code, made by the API's own function (the CLI's, minus its audit row). */
export async function issueEnrolmentCode(userId: string): Promise<{ id: string; code: string }> {
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
    const queryable = { query: async (text: string, params?: unknown[]) => (await client.query(text, params)).rows };
    const issued = await issueStaffEnrolmentAllowance(queryable, userId);
    return { id: issued.id, code: issued.code };
  } finally {
    await client.end();
  }
}

/** `npm run admin:staff-enrolment -- <email>` against the lane's database: answers the code it printed. */
export async function enrolmentCodeFromCli(email: string): Promise<{ code: string; stdout: string }> {
  const { stdout } = await execFileAsync('npm', ['run', 'admin:staff-enrolment', '--', email], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env: process.env,
    timeout: 120_000,
  });
  const lines = stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  return { code: lines[lines.length - 1], stdout };
}

export function allowance(id: string): Promise<{ used_at: Date | null; used_ip: string | null; voided_at: Date | null; voided_reason: string | null }> {
  return sql<{ used_at: Date | null; used_ip: string | null; voided_at: Date | null; voided_reason: string | null }>(
    `SELECT used_at, used_ip, voided_at, voided_reason FROM staff_enrolment_allowances WHERE id = $1`,
    [id],
  ).then((rows) => rows[0]);
}

// ---- The admin API, directly

export interface StaffResponse<T = any> {
  status: number;
  body: T;
  /** The `data` of the envelope, or the body when there is none. */
  data: T;
  setCookies: string[];
}

export interface StaffApiOptions {
  ip?: string;
  token?: string;
  cookie?: string;
  /** Send X-Chumbaq-Client: admin (default true). */
  client?: boolean;
  /** Another admin API (default the lane's, E2E_ADMIN_API_URL). */
  base?: string;
  headers?: Record<string, string>;
}

export function adminApiBase(): string {
  const base = process.env.E2E_ADMIN_API_URL;
  if (!base) throw new Error('E2E_ADMIN_API_URL is not set: run the specs through playwright.config.ts');
  return base;
}

/** Any request to an admin API (or, with `base`, any API), answering status, body and cookies. */
export async function staffApi<T = any>(method: string, pathname: string, body?: unknown, options: StaffApiOptions = {}): Promise<StaffResponse<T>> {
  const response = await fetch(`${options.base ?? adminApiBase()}${pathname}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.client === false ? {} : { 'X-Chumbaq-Client': 'admin' }),
      'X-Forwarded-For': options.ip ?? newClientIp(),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON (an HTML 404 page, say): keep the text.
  }
  const data = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  return { status: response.status, body: parsed, data, setCookies: response.headers.getSetCookie() };
}

/** The `name=value` of the staff refresh cookie in a set of Set-Cookie headers. */
export function staffCookiePair(setCookies: string[]): string {
  const header = setCookies.find((value) => /^(__Host-)?chumbaq_staff_refresh=/.test(value));
  if (!header) throw new Error(`No staff refresh cookie in ${JSON.stringify(setCookies)}`);
  return header.split(';')[0];
}

// ---- WebAuthn in the page, for API-level cases

interface AssertionOptions {
  challenge: string;
  rpId?: string;
  allowCredentials?: Array<{ id: string; type?: string; transports?: string[] }>;
  userVerification?: string;
  timeout?: number;
}

/**
 * An assertion (AuthenticationResponseJSON) from the tab's virtual authenticator for
 * options the API gave, made by navigator.credentials.get in the page's own origin, as
 * @simplewebauthn/browser would. `allowCredentials` can be overridden (an empty list lets
 * the authenticator answer with whichever key it holds).
 */
export async function browserAssertion(page: Page, options: AssertionOptions): Promise<any> {
  return page.evaluate(async (o) => {
    const fromB64u = (value: string) => {
      const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer;
    };
    const toB64u = (buffer: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: fromB64u(o.challenge),
        rpId: o.rpId,
        allowCredentials: (o.allowCredentials ?? []).map((c) => ({
          type: 'public-key' as const,
          id: fromB64u(c.id),
          transports: c.transports as AuthenticatorTransport[] | undefined,
        })),
        userVerification: (o.userVerification ?? 'required') as UserVerificationRequirement,
        timeout: o.timeout,
      },
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      id: credential.id,
      rawId: toB64u(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toB64u(response.clientDataJSON),
        authenticatorData: toB64u(response.authenticatorData),
        signature: toB64u(response.signature),
        userHandle: response.userHandle ? toB64u(response.userHandle) : undefined,
      },
    };
  }, options);
}

// ---- Enrolling and signing in

/**
 * A staff member's first passkey, through the admin app: the password opens an
 * enrolment-only session (no staff factor and no passkey at all, with passkeys not
 * required), the passkey is added on /enrol with a fresh virtual authenticator in the
 * tab, and the page is left on /sign-in, signed out, with the key in the authenticator.
 */
export async function enrolStaffPasskey(page: Page, staff: Pick<Account, 'email' | 'password'>, name = 'E2E staff key'): Promise<VirtualAuthenticator> {
  const authenticator = await addAuthenticator(page);
  await page.goto(adminUrl('/sign-in'));
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password', { exact: true }).fill(staff.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Passkey name').fill(name);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.getByText('Done. Sign in with your new passkey.').waitFor();
  return authenticator;
}

export interface StaffSignedIn {
  accessToken: string;
  session: { id: string; enrolmentOnly: boolean; expiresAt: string };
  cookie: string;
}

/**
 * A full staff session through the admin API with the tab's key (passkey first, no
 * email), the browser making the assertion. The page must be on the admin app (any
 * page; it stays as it is). Answers the token and the refresh cookie's `name=value`.
 */
export async function staffPasskeySignIn(page: Page, ip = newClientIp(), base?: string): Promise<StaffSignedIn> {
  const started = await staffApi('POST', '/api/staff/auth/passkey/options', {}, { ip, base });
  if (started.status !== 200) throw new Error(`passkey/options answered ${started.status}`);
  const response = await browserAssertion(page, started.data.options);
  const verified = await staffApi('POST', '/api/staff/auth/passkey/verify', { ceremonyId: started.data.ceremonyId, response }, { ip, base });
  if (verified.status !== 200) throw new Error(`passkey/verify answered ${verified.status}: ${JSON.stringify(verified.body)}`);
  return { accessToken: verified.data.accessToken, session: verified.data.session, cookie: staffCookiePair(verified.setCookies) };
}

/** The password step through the API; throws unless it answers `second_factor`. */
export async function staffHandle(staff: Pick<Account, 'email' | 'password'>, ip = newClientIp(), base?: string): Promise<{ handle: string; methods: string[] }> {
  const login = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip, base });
  if (login.status !== 200 || login.data.step !== 'second_factor') {
    throw new Error(`login answered ${login.status}: ${JSON.stringify(login.body)}`);
  }
  return { handle: login.data.handle, methods: login.data.methods };
}

/**
 * A code the API will take now that has not been used: like `nextTotpCode`, but waits
 * for the next 30-second step when the current and next ones are both used.
 */
export async function freshTotpCode(enrolment: TotpEnrolment): Promise<string> {
  while (enrolment.lastStep + 1 > totpStep() + 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const step = Math.max(totpStep(), enrolment.lastStep + 1);
  enrolment.lastStep = step;
  return totpCode(enrolment.secret, 0, step * 30_000);
}

/**
 * Turns on a staff authenticator app in a full session that has shown a passkey: a
 * passkey re-authentication (the browser makes the assertion), then setup and confirm.
 * The page must be on the admin app with the staff key in its authenticator.
 */
export async function enrolStaffTotpInFullSession(page: Page, accessToken: string, ip = newClientIp()): Promise<TotpEnrolment> {
  const options = await staffApi('POST', '/api/staff/auth/reauth/passkey/options', {}, { token: accessToken, ip });
  if (options.status !== 200) throw new Error(`reauth options answered ${options.status}`);
  const response = await browserAssertion(page, options.data.options);
  const reauth = await staffApi('POST', '/api/staff/auth/reauth/passkey/verify', { response }, { token: accessToken, ip });
  if (reauth.status !== 200) throw new Error(`reauth verify answered ${reauth.status}: ${JSON.stringify(reauth.body)}`);
  return confirmStaffTotp(reauth.data.accessToken, ip);
}

/** Setup and confirm with a token that may add a factor (an enrolment session, or one with a fresh proof). */
export async function confirmStaffTotp(accessToken: string, ip = newClientIp()): Promise<TotpEnrolment> {
  const setup = await staffApi('POST', '/api/staff/auth/totp/setup', {}, { token: accessToken, ip });
  if (setup.status !== 200) throw new Error(`totp/setup answered ${setup.status}: ${JSON.stringify(setup.body)}`);
  const enrolment: TotpEnrolment = { secret: setup.data.secret, uri: setup.data.uri, recoveryCodes: [], lastStep: -1 };
  const confirmed = await staffApi('POST', '/api/staff/auth/totp/confirm', { code: await freshTotpCode(enrolment) }, { token: accessToken, ip });
  if (confirmed.status !== 200) throw new Error(`totp/confirm answered ${confirmed.status}: ${JSON.stringify(confirmed.body)}`);
  return enrolment;
}

/**
 * A staff member with no passkey of any scope turns on an authenticator app as their
 * only staff factor, from a password-only enrolment session (passkeys not required).
 */
export async function enrolStaffTotpOnly(staff: Pick<Account, 'email' | 'password'>): Promise<TotpEnrolment> {
  const login = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password });
  if (login.status !== 200 || login.data.step !== 'enrol') throw new Error(`login answered ${login.status}: ${JSON.stringify(login.body)}`);
  return confirmStaffTotp(login.data.accessToken);
}

// ---- A second admin API with passkeys required

export interface ExtraAdminApi {
  url: string;
  stop(): Promise<void>;
}

/**
 * Another admin API process on the lane's database and Redis, started with
 * SUPER_ADMIN_PASSKEY_REQUIRED=true (as production always is), on a free port of its
 * own. The lane's admin app still talks to the usual one; `forwardToAdminApi` sends
 * chosen requests of a page here instead.
 */
export async function startPasskeyRequiredAdminApi(): Promise<ExtraAdminApi> {
  const ports = stackPorts();
  const claim = await claimPort(portRange(ports.adminApi + 40, ports.adminApi + 49));
  const port = claim.port;
  const env = {
    ...process.env,
    ...appEnvironment(runSecrets(), ports),
    ADMIN_API_PORT: String(port),
    SUPER_ADMIN_PASSKEY_REQUIRED: 'true',
  };
  const started: Started = run(`admin-api-passkey-required-${port}`, 'node', ['dist/main-admin'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env,
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForUrl(started, `${url}/api/health`);
  } catch (error) {
    await stopAll([started]);
    claim.release();
    throw error;
  }
  return {
    url,
    stop: async () => {
      await stopAll([started]);
      claim.release();
    },
  };
}

/** Sends a page's requests for these admin API paths to another admin API, as the admin app's proxy would. */
export async function forwardToAdminApi(page: Page, base: string, paths: string[]): Promise<void> {
  for (const pathname of paths) {
    await page.route(adminUrl(pathname), async (route) => {
      const response = await route.fetch({ url: `${base}${pathname}` });
      await route.fulfill({ response });
    });
  }
}

// ---- Session lifecycle, factors and tokens (admauth-p0-02)

export interface StaffSessionDetail {
  id: string;
  user_id: string;
  amr: string[];
  enrolment_only: boolean;
  current_token_hash: string | null;
  previous_token_hash: string | null;
  rotated_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  authenticated_at: Date | null;
  last_active_at: Date;
  created_at: Date;
}

/** One staff session row, everything a lifecycle case reads. */
export async function staffSession(id: string): Promise<StaffSessionDetail> {
  const [row] = await sql<StaffSessionDetail>(
    `SELECT id, user_id, amr, enrolment_only, current_token_hash, previous_token_hash, rotated_at,
            revoked_at, revoked_reason, authenticated_at, last_active_at, created_at
       FROM staff_sessions WHERE id = $1`,
    [id],
  );
  if (!row) throw new Error(`No staff session ${id}`);
  return row;
}

/** The sha256 the API stores for a refresh token. */
export function tokenHash(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

/** The value of a `name=value` cookie pair. */
export function cookieValue(pair: string): string {
  return pair.slice(pair.indexOf('=') + 1);
}

/**
 * A staff-scope passkey row with placeholder key material: it can be listed, counted and
 * removed, never used to sign in. Answers its id.
 */
export async function seedStaffPasskeyRow(userId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, scope)
     VALUES ($1, $2, $3, 0, '[]', 'singleDevice', false, $4, 'staff') RETURNING id`,
    [userId, `e2e-placeholder-${randomUUID()}`, Buffer.from('not-a-key'), name],
  );
  return row.id;
}

/** `npm run admin:revoke -- <email>` against the lane's database. */
export async function revokeStaffWithCli(email: string): Promise<void> {
  await execFileAsync('npm', ['run', 'admin:revoke', '--', email], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env: process.env,
    timeout: 120_000,
  });
}

/**
 * Another admin API process on the lane's database and Redis with extra environment (as
 * `startPasskeyRequiredAdminApi`, which sets one value of this kind), on a free port.
 */
export async function startAdminApiWith(extra: Record<string, string>, label: string): Promise<ExtraAdminApi> {
  const ports = stackPorts();
  const claim = await claimPort(portRange(ports.adminApi + 50, ports.adminApi + 69));
  const port = claim.port;
  const env = { ...process.env, ...appEnvironment(runSecrets(), ports), ADMIN_API_PORT: String(port), ...extra };
  const started: Started = run(`admin-api-${label}-${port}`, 'node', ['dist/main-admin'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env,
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForUrl(started, `${url}/api/health`);
  } catch (error) {
    await stopAll([started]);
    claim.release();
    throw error;
  }
  return {
    url,
    stop: async () => {
      await stopAll([started]);
      claim.release();
    },
  };
}

/** Sends every request of a page under an admin API path prefix to another admin API. */
export async function forwardPrefixToAdminApi(page: Page, base: string, prefix: string): Promise<void> {
  await page.route(
    (url) => url.origin === new URL(adminUrl('/')).origin && url.pathname.startsWith(prefix),
    async (route) => {
      const target = new URL(route.request().url());
      const response = await route.fetch({ url: `${base}${target.pathname}${target.search}` });
      await route.fulfill({ response });
    },
  );
}

/**
 * The tab's authenticator holds the account's keys, which registration lists in
 * `excludeCredentials`, so it would refuse to make another. This holds them aside for
 * the registration only: when a successful `POST /passkeys/options` answer reaches the
 * page, every credential is saved and cleared, so the authenticator makes a fresh key;
 * `restore()` puts the saved ones back beside it (usable when asked for by id, not for
 * passkey-first sign-in, where the new key answers). Re-authentication before that (the
 * options call refused with "Confirm it is you to continue.") still finds the old key.
 */
export async function setAsideKeysForRegistration(page: Page, authenticator: VirtualAuthenticator): Promise<{ restore(): Promise<void> }> {
  const saved: any[] = [];
  const pathname = '/api/staff/auth/passkeys/options';
  await page.route(adminUrl(pathname), async (route) => {
    const response = await route.fetch();
    if (response.ok() && saved.length === 0) {
      saved.push(...(await authenticator.cdp.send('WebAuthn.getCredentials', { authenticatorId: authenticator.authenticatorId })).credentials);
      await authenticator.clearCredentials();
    }
    await route.fulfill({ response });
  });
  return {
    restore: async () => {
      await page.unroute(adminUrl(pathname));
      // Back as non-discoverable: a discoverable one would clash with the new key, which
      // has the same relying party and user handle. Asked for by id, it still answers.
      for (const credential of saved.splice(0)) {
        await authenticator.cdp.send('WebAuthn.addCredential', {
          authenticatorId: authenticator.authenticatorId,
          credential: { ...credential, isResidentCredential: false },
        });
      }
    },
  };
}

/** Copies every credential of one virtual authenticator into another (another tab, the same keys). */
export async function copyCredentials(from: VirtualAuthenticator, to: VirtualAuthenticator): Promise<void> {
  const { credentials } = await from.cdp.send('WebAuthn.getCredentials', { authenticatorId: from.authenticatorId });
  for (const credential of credentials) {
    await to.cdp.send('WebAuthn.addCredential', { authenticatorId: to.authenticatorId, credential });
  }
}

/**
 * "Sign in with a passkey" on the admin app's /sign-in (the page must be there), waiting
 * for Overview. Answers the session the API made.
 */
export async function signInStaffInPage(page: Page): Promise<{ accessToken: string; session: { id: string; expiresAt: string; idleTimeoutSeconds: number } }> {
  const [verified] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/staff/auth/passkey/verify'),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  if (!verified.ok()) throw new Error(`Staff passkey sign-in answered ${verified.status()}`);
  await page.waitForURL(adminUrl('/'));
  return ((await verified.json()) as { data: any }).data;
}

/** A passkey re-authentication through the API for a session; answers the new access token. */
export async function reauthWithPasskey(page: Page, accessToken: string, ip = newClientIp(), base?: string): Promise<string> {
  const options = await staffApi('POST', '/api/staff/auth/reauth/passkey/options', {}, { token: accessToken, ip, base });
  if (options.status !== 200) throw new Error(`reauth options answered ${options.status}: ${JSON.stringify(options.body)}`);
  const response = await browserAssertion(page, options.data.options);
  const verified = await staffApi('POST', '/api/staff/auth/reauth/passkey/verify', { response }, { token: accessToken, ip, base });
  if (verified.status !== 200) throw new Error(`reauth verify answered ${verified.status}: ${JSON.stringify(verified.body)}`);
  return verified.data.accessToken;
}

// ---- Staff access tokens made by hand

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/** An HS256 JWT over any claims with any key. */
export function signHs256(claims: Record<string, unknown>, key: Buffer | string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const signature = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

/** The claims of a JWT, unverified. */
export function jwtClaims(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/**
 * The admin API's staff signing key for this run: HKDF-SHA256 of the run's JWT secret
 * with the salt and info `staffAccessKey` in staff-tokens.service.ts uses.
 */
export function runStaffKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', runSecrets().jwtSecret, 'chumbaq-staff-session', 'staff-access-token-v1', 32));
}

// ---- P1 chunk 1: Redis keys, registrations in the page, CLIs, alerts

/** Deletes Redis keys (a handle or a challenge running out). Answers how many existed. */
export function redisDel(...keys: string[]): Promise<number> {
  return withRedis((redis) => redis.del(...keys));
}

export function redisExists(key: string): Promise<number> {
  return withRedis((redis) => redis.exists(key));
}

/** The Redis key of a sign-in handle (`PreAuthService`). */
export function preAuthKey(handle: string): string {
  return `chumbaq:preauth:${createHash('sha256').update(handle).digest('hex')}`;
}

/** The Redis key of a WebAuthn challenge: `staff-passwordless` by ceremony id, `staff-register` by session id, and so on. */
export function challengeKey(ceremony: string, id: string): string {
  return `chumbaq:webauthn:${ceremony}:${createHash('sha256').update(id).digest('hex')}`;
}

/**
 * A registration (RegistrationResponseJSON) from the tab's virtual authenticator for
 * options the API gave, made by navigator.credentials.create in the page's own origin,
 * as @simplewebauthn/browser would. The origin is whichever app the page is on.
 */
export async function browserAttestation(page: Page, options: any): Promise<any> {
  return page.evaluate(async (o) => {
    const fromB64u = (value: string) => {
      const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer;
    };
    const toB64u = (buffer: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: fromB64u(o.challenge),
        rp: o.rp,
        user: { id: fromB64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams,
        timeout: o.timeout,
        attestation: o.attestation,
        authenticatorSelection: o.authenticatorSelection,
        excludeCredentials: (o.excludeCredentials ?? []).map((c: { id: string; transports?: string[] }) => ({
          type: 'public-key' as const,
          id: fromB64u(c.id),
          transports: c.transports as AuthenticatorTransport[] | undefined,
        })),
      },
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      id: credential.id,
      rawId: toB64u(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toB64u(response.clientDataJSON),
        attestationObject: toB64u(response.attestationObject),
        transports: response.getTransports ? response.getTransports() : [],
      },
    };
  }, options);
}

export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `npm run <script> -- <args>` from apps/api against the lane's database; never throws on a failing exit. */
export async function runApiCli(script: string, args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', script, '--', ...args], {
      cwd: path.join(REPO_ROOT, 'apps/api'),
      env: process.env,
      timeout: 120_000,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

/** auth_events rows sent from one client address since `since`. */
export function authEventsFromIp(
  ip: string,
  since: Date,
): Promise<Array<{ type: string; reason: string | null; user_id: string | null; session_id: string | null }>> {
  return sql(
    `SELECT type, reason, user_id, session_id FROM auth_events WHERE ip_address = $1 AND created_at >= $2 ORDER BY created_at`,
    [ip, since],
  );
}

export interface AlertRow {
  kind: string;
  dedupe_key: string;
  count: number;
  details: Record<string, unknown>;
}

/** `staff.new_device` alerts for one user (dedupe key `<userId>:<device>`). */
export function newDeviceAlerts(userId: string): Promise<AlertRow[]> {
  return sql<AlertRow>(
    `SELECT kind, dedupe_key, count, details FROM security_alerts
      WHERE kind = 'staff.new_device' AND dedupe_key LIKE $1 ORDER BY first_at`,
    [`${userId}:%`],
  );
}

/**
 * A passkey-first staff sign-in through the admin API with a chosen User-Agent (the
 * device the new-device check compares), the tab's authenticator answering.
 */
export async function staffPasskeySignInAs(page: Page, userAgent: string, ip = newClientIp()): Promise<StaffSignedIn> {
  const started = await staffApi('POST', '/api/staff/auth/passkey/options', {}, { ip, headers: { 'User-Agent': userAgent } });
  if (started.status !== 200) throw new Error(`passkey/options answered ${started.status}`);
  const response = await browserAssertion(page, started.data.options);
  const verified = await staffApi(
    'POST',
    '/api/staff/auth/passkey/verify',
    { ceremonyId: started.data.ceremonyId, response },
    { ip, headers: { 'User-Agent': userAgent } },
  );
  if (verified.status !== 200) throw new Error(`passkey/verify answered ${verified.status}: ${JSON.stringify(verified.body)}`);
  return { accessToken: verified.data.accessToken, session: verified.data.session, cookie: staffCookiePair(verified.setCookies) };
}

/**
 * A staff passkey added through the admin API by an enrolment session's token, the tab's
 * authenticator making the key (the page must be on the admin app).
 */
export async function enrolPasskeyByApi(page: Page, token: string, name = 'E2E staff key', ip = newClientIp()): Promise<StaffResponse> {
  const options = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token, ip });
  if (options.status !== 200) throw new Error(`passkeys/options answered ${options.status}: ${JSON.stringify(options.body)}`);
  const response = await browserAttestation(page, options.data.options);
  return staffApi('POST', '/api/staff/auth/passkeys', { response, name }, { token, ip });
}

// ---- P1 chunk 2: support links, attempt counters, audit trails, second keys by API

/**
 * A reset link support issued through the CLI, unused and still waiting out its delay,
 * stored as the API stores one (only its SHA-256). Answers the row's id.
 */
export async function seedStaffResetLink(userId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at, staff_issued, usable_after)
     VALUES ($1, 'reset_password', $2, now() + interval '48 hours', true, now() + interval '24 hours') RETURNING id`,
    [userId, createHash('sha256').update(randomUUID()).digest('hex')],
  );
  return row.id;
}

export async function accountTokenUsedAt(id: string): Promise<Date | null> {
  const [row] = await sql<{ used_at: Date | null }>(`SELECT used_at FROM account_tokens WHERE id = $1`, [id]);
  return row.used_at;
}

/** Sets the account's second-factor attempt count (`second-factor` in the address's sign-in attempts hash) for 15 minutes. */
export function seedSecondFactorAttempts(email: string, count: number): Promise<unknown> {
  const key = `chumbaq:signin-attempts:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
  return withRedis(async (redis) => {
    await redis.hset(key, 'second-factor', String(count));
    await redis.expire(key, 900);
  });
}

export interface AuditTrailRow {
  action: string;
  actor_id: string | null;
  actor_email: string;
  ip_address: string | null;
  metadata: Record<string, unknown> | null;
}

/** Every admin_audit_logs row targeting a user since `since`, oldest first, with actor and address. */
export function auditTrail(userId: string, since: Date): Promise<AuditTrailRow[]> {
  return sql<AuditTrailRow>(
    `SELECT action, actor_id, actor_email, ip_address, metadata FROM admin_audit_logs
      WHERE target_id = $1 AND created_at >= $2 ORDER BY created_at, id`,
    [userId, since],
  );
}

export async function recoveryCodeCount(userId: string): Promise<number> {
  const [row] = await sql<{ n: string }>(`SELECT count(*) AS n FROM recovery_codes WHERE user_id = $1`, [userId]);
  return Number(row.n);
}

/** A recovery code row with a placeholder hash (it can never be used), to see it removed. */
export async function seedRecoveryCodeRow(userId: string): Promise<void> {
  await sql(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, createHash('sha256').update(randomUUID()).digest('hex')]);
}

/**
 * A staff member with one staff passkey (held by the tab's authenticator) and a confirmed
 * authenticator app, both added through the real routes. The page is left on /sign-in,
 * signed out of the admin app (the app's confirm ended the API session it used).
 */
export async function staffWithPasskeyAndApp(
  page: Page,
  ip: string,
): Promise<{ staff: Account; authenticator: VirtualAuthenticator; enrolment: TotpEnrolment }> {
  const staff = await makeStaff(ip);
  const authenticator = await enrolStaffPasskey(page, staff);
  const signedIn = await staffPasskeySignIn(page);
  const enrolment = await enrolStaffTotpInFullSession(page, signedIn.accessToken);
  return { staff, authenticator, enrolment };
}

/**
 * Another staff passkey through the admin API for a session holding a fresh proof: the
 * tab's authenticator sets its keys aside (registration lists them in
 * `excludeCredentials`), makes the new one, and gets the old ones back (non-discoverable,
 * still answering when asked for by id).
 */
export async function addPasskeyByApi(
  page: Page,
  authenticator: VirtualAuthenticator,
  token: string,
  name: string,
  ip = newClientIp(),
): Promise<StaffResponse> {
  const options = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token, ip });
  if (options.status !== 200) throw new Error(`passkeys/options answered ${options.status}: ${JSON.stringify(options.body)}`);
  const response = await attestWithKeysAside(page, authenticator, options.data.options);
  return staffApi('POST', '/api/staff/auth/passkeys', { response, name }, { token, ip });
}

/**
 * A registration from the tab's authenticator for options listing its own keys in
 * `excludeCredentials`: the keys are set aside while the new one is made, then put back
 * (non-discoverable, still answering when asked for by id).
 */
export async function attestWithKeysAside(page: Page, authenticator: VirtualAuthenticator, options: any): Promise<any> {
  const saved = (await authenticator.cdp.send('WebAuthn.getCredentials', { authenticatorId: authenticator.authenticatorId })).credentials;
  await authenticator.clearCredentials();
  try {
    return await browserAttestation(page, options);
  } finally {
    for (const credential of saved) {
      await authenticator.cdp.send('WebAuthn.addCredential', {
        authenticatorId: authenticator.authenticatorId,
        credential: { ...credential, isResidentCredential: false },
      });
    }
  }
}

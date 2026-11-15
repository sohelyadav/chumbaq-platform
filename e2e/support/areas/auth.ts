import { createHash, randomBytes } from 'crypto';
import type { Locator, Page } from '@playwright/test';
import Redis from 'ioredis';
import { Client } from 'pg';
import { apiUrl, type Account } from '../api';
import { nextTotpCode, recoveryCodeItems, settingsCard, totpCode, totpSetupKey, totpStep, type TotpEnrolment } from '../factors';
import { assertE2eDatabase, assertE2eRedisDb, stackEnv } from '../stack';

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
}

/** A JSON POST that never throws: status, body and Set-Cookie for the test to check. */
export async function post<T = any>(path: string, body: unknown, { ip, token, clientHeader = true }: RawOptions): Promise<RawResponse<T>> {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
      ...(clientHeader ? { 'X-Chumbaq-Client': 'web' } : {}),
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
  return {
    status: response.status,
    body: ok && parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed,
    text,
    setCookie: response.headers.get('set-cookie'),
  };
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

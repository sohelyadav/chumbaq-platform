import { execFile } from 'child_process';
import { createHash, createHmac, randomUUID } from 'crypto';
import path from 'path';
import { promisify } from 'util';
import { expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { api, apiUrl, createAccount, type Account } from '../api';
import { adminUrl, enrolAndSignInStaff } from '../admin';
import { assertE2eDatabase, REPO_ROOT, runSecrets, stackEnv } from '../stack';

/**
 * Helpers for the admin tenant specs (ADMTEN): staff set-up, raw admin API requests,
 * the view-as exchange, SQL reads and seeds, and a small CSV reader.
 */

// ---- Database

function dbClient(): Client {
  const env = stackEnv();
  return new Client({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT || 5432),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: assertE2eDatabase(env),
  });
}

/** A query against the lane's e2e database (the name is checked as in support/seed.ts). */
export async function withDb<T>(work: (db: Client) => Promise<T>): Promise<T> {
  const client = dbClient();
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function sql<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withDb(async (db) => (await db.query(text, params)).rows as T[]);
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  suspended_at: Date | null;
  suspended_reason: string | null;
  session_version: number;
  project_limit: number | null;
  seat_limit: number | null;
  is_super_admin: boolean;
  password_hash: string;
}

export async function userRow(id: string): Promise<UserRow> {
  const [row] = await sql<Record<string, unknown>>(
    `SELECT id, email, name, suspended_at, suspended_reason, session_version, project_limit, seat_limit,
            is_super_admin, password_hash
       FROM users WHERE id = $1`,
    [id],
  );
  if (!row) throw new Error(`No users row ${id}`);
  return row as unknown as UserRow;
}

export interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string | null;
  target_label: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: Date;
}

/** Audit rows matching every given column, oldest first. */
export async function auditRows(where: { action?: string; actorId?: string; targetId?: string }): Promise<AuditRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (where.action) clauses.push(`action = $${params.push(where.action)}`);
  if (where.actorId) clauses.push(`actor_id = $${params.push(where.actorId)}`);
  if (where.targetId) clauses.push(`target_id = $${params.push(where.targetId)}`);
  return sql<AuditRow & Record<string, unknown>>(
    `SELECT * FROM admin_audit_logs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at, id`,
    params,
  );
}

export async function handoffRows(where: { actorId?: string; targetId?: string }) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (where.actorId) clauses.push(`actor_id = $${params.push(where.actorId)}`);
  if (where.targetId) clauses.push(`target_id = $${params.push(where.targetId)}`);
  return sql<{
    id: string;
    code_hash: string;
    actor_id: string;
    staff_session_id: string;
    target_id: string;
    reason: string;
    expires_at: Date;
    used_at: Date | null;
  }>(`SELECT * FROM impersonation_handoffs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at`, params);
}

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

// ---- Staff

export interface Staff {
  account: Account;
  /** A staff access token from a passkey sign-in a moment ago (so a recent sign-in). */
  token: string;
  /** The staff session the token belongs to (its `sid` claim). */
  sessionId: string;
}

/** The claims of a JWT, unverified. */
export function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * Makes `account` a super admin. The CLI (`grantSuperAdmin` in support/admin.ts) is the
 * real path and is covered by admin.spec.ts; this sets the same flag directly, which is
 * all the guards read, without a ts-node start per test.
 */
export async function makeSuperAdmin(userId: string): Promise<void> {
  const [row] = await sql(`UPDATE users SET is_super_admin = true WHERE id = $1 RETURNING id`, [userId]);
  if (!row) throw new Error(`No users row ${userId}`);
}

/** A new super admin, signed in to the admin app in `page` with a passkey. */
export async function signedInStaff(page: Page, ip: string, name = 'Sam Staff'): Promise<Staff> {
  const account = await createAccount(ip, 'staff', name);
  await makeSuperAdmin(account.userId);
  const token = await enrolAndSignInStaff(page, account);
  return { account, token, sessionId: String(jwtClaims(token).sid) };
}

/**
 * Moves the staff member's sign-in 20 minutes into the past, past the 15 minutes a
 * recent sign-in lasts. A token issued from then on (the next refresh: a page load in
 * the admin app) carries the old `auth_time`.
 */
export async function makeStaffSignInStale(userId: string): Promise<void> {
  await sql(
    `UPDATE staff_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

// ---- Raw requests

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  /** The parsed body, or null when it is not JSON. */
  json: { data?: unknown; message?: unknown; [key: string]: unknown } | null;
}

function adminBase(): string {
  const base = process.env.E2E_ADMIN_API_URL;
  if (!base) throw new Error('E2E_ADMIN_API_URL is not set: run the specs through playwright.config.ts');
  return base;
}

async function raw(url: string, method: string, body: unknown, headers: Record<string, string>): Promise<RawResponse> {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Decoded by hand: Response.text() drops a leading byte order mark, which exports carry.
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let json: RawResponse['json'] = null;
  try {
    json = JSON.parse(text) as RawResponse['json'];
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** A request to the admin API, answered whatever its status. */
export function adminRequest(
  method: string,
  path: string,
  { token, ip, body }: { token?: string; ip: string; body?: unknown },
): Promise<RawResponse> {
  return raw(`${adminBase()}${path}`, method, body, {
    'X-Forwarded-For': ip,
    'X-Chumbaq-Client': 'admin',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
}

/** A request to the customer API, answered whatever its status. */
export function customerRequest(
  method: string,
  path: string,
  { token, ip, body }: { token?: string; ip: string; body?: unknown },
): Promise<RawResponse> {
  return raw(apiUrl(path), method, body, {
    'X-Forwarded-For': ip,
    'X-Chumbaq-Client': 'web',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
}

/** Every ADMTEN admin route for tenant `id`, with a body each would accept. */
export function admtenRoutes(id: string): { method: string; path: string; body?: unknown }[] {
  const reason = 'E2E: checking access to this route';
  return [
    { method: 'GET', path: '/api/admin/overview' },
    { method: 'GET', path: '/api/admin/tenants' },
    { method: 'GET', path: '/api/admin/tenants/export' },
    { method: 'GET', path: `/api/admin/tenants/${id}` },
    { method: 'GET', path: `/api/admin/tenants/${id}/usage` },
    { method: 'POST', path: `/api/admin/tenants/${id}/suspend`, body: { reason } },
    { method: 'POST', path: `/api/admin/tenants/${id}/reactivate`, body: { reason } },
    { method: 'PATCH', path: `/api/admin/tenants/${id}/project-limit`, body: { projectLimit: 50, reason } },
    { method: 'PATCH', path: `/api/admin/tenants/${id}/seat-limit`, body: { seatLimit: 50, reason } },
    { method: 'POST', path: `/api/admin/tenants/${id}/impersonate`, body: { reason } },
    { method: 'GET', path: `/api/admin/tenants/${id}/factor-reset` },
    {
      method: 'POST',
      path: `/api/admin/tenants/${id}/factor-reset`,
      body: { reason, verificationMethod: 'video_call', verificationNotes: 'E2E: saw them on a video call' },
    },
    { method: 'DELETE', path: `/api/admin/tenants/${id}/factor-reset` },
  ];
}

/** What the routes could change about a tenant, to compare before and after. */
export async function tenantState(id: string) {
  const user = await userRow(id);
  const [{ audit }] = await sql<{ audit: string }>(`SELECT count(*)::text AS audit FROM admin_audit_logs WHERE target_id = $1`, [id]);
  const [{ handoffs }] = await sql<{ handoffs: string }>(
    `SELECT count(*)::text AS handoffs FROM impersonation_handoffs WHERE target_id = $1`,
    [id],
  );
  const [{ resets }] = await sql<{ resets: string }>(`SELECT count(*)::text AS resets FROM factor_resets WHERE user_id = $1`, [id]);
  return {
    suspendedAt: user.suspended_at,
    suspendedReason: user.suspended_reason,
    sessionVersion: user.session_version,
    projectLimit: user.project_limit,
    seatLimit: user.seat_limit,
    audit,
    handoffs,
    resets,
  };
}

// ---- View-as

/** Starts view-as through the admin API; answers the handoff (`url` carries `#code=`). */
export async function startViewAs(staff: Staff, tenantId: string, ip: string, reason = 'E2E: checking a view-as token') {
  const response = await adminRequest('POST', `/api/admin/tenants/${tenantId}/impersonate`, {
    token: staff.token,
    ip,
    body: { reason },
  });
  if (response.status !== 200) throw new Error(`impersonate answered ${response.status}: ${response.text.slice(0, 300)}`);
  return (response.json as { data: { url: string; expiresAt: string; tenant: { id: string; email: string; name: string } } }).data;
}

export function codeFromViewAsUrl(url: string): string {
  const code = new URL(url).hash.replace(/^#code=/, '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error(`No view-as code in ${url}`);
  return code;
}

/** Spends a view-as code on the customer API, as the /impersonate page does; answers the view-as token. */
export async function exchangeViewAs(url: string, ip: string): Promise<string> {
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code: codeFromViewAsUrl(url) }, { ip });
  return session.accessToken;
}

// ---- Usage roll-up

/** Yesterday as a UTC day, the latest day the roll-up can have closed. */
export function utcDay(offsetDays = 0): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/**
 * The roll-up state is one row for the whole database, and specs in other workers set it
 * too. Whoever changes it holds this session lock (its own connection) until it has put
 * the row back, so two tests never see each other's state. The key is not the worker's
 * own roll-up lock, so the job specs can still run a tick meanwhile.
 */
async function holdRollupStateLock(): Promise<() => Promise<void>> {
  const client = dbClient();
  await client.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('e2e_usage_rollup_state'))`);
  } catch (error) {
    await client.end();
    throw error;
  }
  return async () => {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext('e2e_usage_rollup_state'))`);
    } finally {
      await client.end();
    }
  };
}

/** Runs `change` under the state lock; the restore it answers releases the lock after it. */
async function lockedStateChange(change: () => Promise<() => Promise<void>>): Promise<() => Promise<void>> {
  const release = await holdRollupStateLock();
  let restore: () => Promise<void>;
  try {
    restore = await change();
  } catch (error) {
    await release();
    throw error;
  }
  return async () => {
    try {
      await restore();
    } finally {
      await release();
    }
  };
}

interface RollupState {
  started_on: string;
  first_day: string;
  last_closed_day: string;
  devices_through: Date | null;
}

/**
 * Makes the roll-up's state say it has counted through yesterday (UTC), so the worker's
 * hourly tick has no day left to close and seeded `usage_daily` rows are what the admin
 * routes read. Answers a function that puts the state back as it was.
 */
export function seedRollupThroughYesterday(): Promise<() => Promise<void>> {
  return lockedStateChange(seedRollupThroughYesterdayUnlocked);
}

async function seedRollupThroughYesterdayUnlocked(): Promise<() => Promise<void>> {
  const [before] = await sql<RollupState & Record<string, unknown>>(
    `SELECT to_char(started_on, 'YYYY-MM-DD') AS started_on, to_char(first_day, 'YYYY-MM-DD') AS first_day,
            to_char(last_closed_day, 'YYYY-MM-DD') AS last_closed_day, devices_through
       FROM usage_rollup_state WHERE id = 1`,
  );
  const yesterday = utcDay(-1);
  await sql(
    `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day, devices_through)
     VALUES (1, $1::date, $2::date, $3::date, now())
     ON CONFLICT (id) DO UPDATE SET last_closed_day = EXCLUDED.last_closed_day`,
    [utcDay(-60), utcDay(-90), yesterday],
  );
  return async () => {
    if (!before) {
      await sql(`DELETE FROM usage_rollup_state WHERE id = 1`);
    } else {
      await sql(`UPDATE usage_rollup_state SET last_closed_day = $1::date WHERE id = 1`, [before.last_closed_day]);
    }
  };
}

export interface UsageSeed {
  projectId: string;
  ownerId: string;
  day: string;
  metric: string;
  value: number;
}

export async function seedUsage(rows: UsageSeed[]): Promise<() => Promise<void>> {
  for (const row of rows) {
    await sql(
      `INSERT INTO usage_daily (project_id, day, metric, owner_id, value) VALUES ($1, $2::date, $3, $4, $5)
       ON CONFLICT (project_id, day, metric) DO UPDATE SET value = EXCLUDED.value, owner_id = EXCLUDED.owner_id`,
      [row.projectId, row.day, row.metric, row.ownerId, row.value],
    );
  }
  return async () => {
    for (const row of rows) {
      await sql(`DELETE FROM usage_daily WHERE project_id = $1 AND day = $2::date AND metric = $3`, [row.projectId, row.day, row.metric]);
    }
  };
}

// ---- CSV

/** RFC 4180: quoted cells may hold commas, CR, LF and doubled quotes. Answers rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The raw text of each record (line) of a CSV whose cells hold no line breaks. */
export function csvLines(text: string): string[] {
  return text.split('\r\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
}

// ---- Staff sessions (view-as chunk)

const runCli = promisify(execFile);

/**
 * Takes super admin away the real way, with the CLI from apps/api against the lane's
 * database (as `grantSuperAdmin` in support/admin.ts grants it).
 */
export async function revokeSuperAdminCli(email: string): Promise<void> {
  await runCli('npm', ['run', 'admin:revoke', '--', email], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env: process.env,
    timeout: 120_000,
  });
}

/**
 * A fresh staff passkey sign-in in a tab whose virtual authenticator already holds the
 * staff member's passkey (after `signedInStaff` there and a sign-out). Answers the new
 * staff access token.
 */
export async function staffPasskeySignIn(page: Page): Promise<string> {
  await page.goto(adminUrl('/sign-in'));
  const [verified] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/staff/auth/passkey/verify')),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  if (!verified.ok()) throw new Error(`Staff passkey sign-in answered ${verified.status()}`);
  return ((await verified.json()) as { data: { accessToken: string } }).data.accessToken;
}

/**
 * Refreshes the staff session with the tab's cookie, as the admin app does on a page
 * load, and answers the new access token (it carries the session's sign-in time).
 */
export async function refreshStaffToken(page: Page): Promise<string> {
  const response = await page.request.post(adminUrl('/api/staff/auth/session/refresh'), {
    headers: { 'X-Chumbaq-Client': 'admin' },
  });
  if (!response.ok()) throw new Error(`Staff refresh answered ${response.status()}: ${await response.text()}`);
  return ((await response.json()) as { data: { accessToken: string } }).data.accessToken;
}

// ---- Admin app and customer app pages (view-as chunk)

/** Opens a tenant's page in the admin app and waits for its header. */
export async function openTenantPage(page: Page, tenant: Pick<Account, 'userId' | 'email'>): Promise<void> {
  await page.goto(adminUrl(`/tenants/${tenant.userId}`));
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
}

/**
 * View-as from the tenant page through to the customer app's new tab, which has landed
 * on /projects with the banner.
 */
export async function openViewAsTab(page: Page, tenant: Account, reason = 'E2E: checking the view-as session'): Promise<Page> {
  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'View as tenant' }).click();
  const start = page.getByRole('dialog', { name: 'View as this tenant?' });
  await start.getByLabel('Reason').fill(reason);
  await start.getByRole('button', { name: 'Start read-only session' }).click();
  const ready = page.getByRole('dialog', { name: `View as ${tenant.email}` });
  const [viewAs] = await Promise.all([
    page.context().waitForEvent('page'),
    ready.getByRole('link', { name: 'Open view-as' }).click(),
  ]);
  await expect(viewAs).toHaveURL(/\/projects$/);
  await expect(viewAsBanner(viewAs)).toBeVisible();
  return viewAs;
}

export function viewAsBanner(page: Page) {
  return page.getByRole('region', { name: 'Impersonation session' });
}

/** The tab's stored view-as record (sessionStorage, customer app origin), parsed. */
export async function storedViewAs(page: Page): Promise<Record<string, unknown> | null> {
  const raw = await page.evaluate(() => sessionStorage.getItem('chumbaq_impersonation'));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** A toast in the customer app's notifications region, by its title. */
export function customerToast(page: Page, title: string) {
  return page
    .getByRole('region', { name: /^Notifications/ })
    .getByRole('listitem')
    .filter({ has: page.getByText(title, { exact: true }) });
}

/** The link detail page's actions menu button (an icon button beside the tabs). */
export function linkActionsButton(page: Page) {
  return page.getByRole('tablist').locator('xpath=..').locator('button[aria-haspopup="menu"]');
}

/**
 * Records the status and message of every API answer the tab receives with a status of
 * 400 or more, read on the way in (a view-as tab navigates away as soon as a refusal
 * arrives, so its body cannot be read afterwards).
 */
export async function recordRefusals(page: Page): Promise<{ url: string; status: number; message: unknown }[]> {
  const refusals: { url: string; status: number; message: unknown }[] = [];
  await page.route('**/api/**', async (route) => {
    const response = await route.fetch();
    if (response.status() >= 400) {
      let message: unknown = null;
      try {
        message = ((await response.json()) as { message?: unknown }).message;
      } catch {
        message = null;
      }
      refusals.push({ url: route.request().url(), status: response.status(), message });
    }
    await route.fulfill({ response });
  });
  return refusals;
}

// ---- Factor resets (view-as chunk)

export interface PendingResetSeed {
  userId: string;
  requestedBy: { userId: string; email: string };
  reason?: string;
  noticeSent?: boolean;
  verificationMethod?: string | null;
  verificationNotes?: string | null;
  /** The second justification kept when the password had been reset recently. */
  passwordResetOverride?: string | null;
}

/**
 * A pending factor reset as a request leaves it once its warning has gone (or, with
 * `noticeSent: false`, before), 72 hours ahead. Answers the row id.
 */
export async function seedPendingFactorReset(seed: PendingResetSeed): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO factor_resets
       (user_id, status, requested_by_id, requested_by_email, reason, execute_after, notice_sent_at,
        verification_method, verification_notes, password_reset_override)
     VALUES ($1, 'pending', $2, $3, $4, now() + interval '72 hours', CASE WHEN $5 THEN now() ELSE NULL END, $6, $7, $8)
     RETURNING id`,
    [
      seed.userId,
      seed.requestedBy.userId,
      seed.requestedBy.email,
      seed.reason ?? 'E2E: owner lost their phone and recovery codes',
      seed.noticeSent ?? true,
      seed.verificationMethod === undefined ? 'video_call' : seed.verificationMethod,
      seed.verificationNotes === undefined ? 'E2E: saw the owner on a video call' : seed.verificationNotes,
      seed.passwordResetOverride ?? null,
    ],
  );
  return row.id;
}

export async function factorResetRows(userId: string) {
  return sql<{
    id: string;
    status: string;
    cancelled_at: Date | null;
    cancelled_by: string | null;
    requested_by_id: string | null;
  }>(`SELECT id, status, cancelled_at, cancelled_by, requested_by_id FROM factor_resets WHERE user_id = $1 ORDER BY requested_at`, [
    userId,
  ]);
}

// ---- Overview and tenants list (P1 chunk)

export interface RollupStateSeed {
  startedOn: string;
  firstDay: string;
  lastClosedDay: string;
}

/**
 * Puts the roll-up's state row exactly as given (or removes it, for `null`), and answers
 * a function that puts back the row that was there before, every column of it.
 */
export function setRollupState(state: RollupStateSeed | null): Promise<() => Promise<void>> {
  return lockedStateChange(() => setRollupStateUnlocked(state));
}

async function setRollupStateUnlocked(state: RollupStateSeed | null): Promise<() => Promise<void>> {
  const [before] = await sql<{ started_on: string; first_day: string; last_closed_day: string; devices_through: Date | null }>(
    `SELECT to_char(started_on, 'YYYY-MM-DD') AS started_on, to_char(first_day, 'YYYY-MM-DD') AS first_day,
            to_char(last_closed_day, 'YYYY-MM-DD') AS last_closed_day, devices_through
       FROM usage_rollup_state WHERE id = 1`,
  );
  if (state === null) {
    await sql(`DELETE FROM usage_rollup_state WHERE id = 1`);
  } else {
    await sql(
      `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day, devices_through)
       VALUES (1, $1::date, $2::date, $3::date, now())
       ON CONFLICT (id) DO UPDATE SET started_on = EXCLUDED.started_on, first_day = EXCLUDED.first_day,
                                      last_closed_day = EXCLUDED.last_closed_day`,
      [state.startedOn, state.firstDay, state.lastClosedDay],
    );
  }
  return async () => {
    if (!before) {
      await sql(`DELETE FROM usage_rollup_state WHERE id = 1`);
      return;
    }
    await sql(
      `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day, devices_through)
       VALUES (1, $1::date, $2::date, $3::date, $4)
       ON CONFLICT (id) DO UPDATE SET started_on = EXCLUDED.started_on, first_day = EXCLUDED.first_day,
                                      last_closed_day = EXCLUDED.last_closed_day, devices_through = EXCLUDED.devices_through`,
      [before.started_on, before.first_day, before.last_closed_day, before.devices_through],
    );
  };
}

/** The roll-up counted through yesterday, 90 days back, started in an earlier month than yesterday's. */
export const COUNTED_STATE = (): RollupStateSeed => ({ startedOn: utcDay(-75), firstDay: utcDay(-90), lastClosedDay: utcDay(-1) });

/** As COUNTED_STATE, but counting started in the month of the last counted day. */
export const FIRST_MONTH_STATE = (): RollupStateSeed => ({ startedOn: utcDay(-1), firstDay: utcDay(-90), lastClosedDay: utcDay(-1) });

export interface InsertedTenant {
  id: string;
  email: string;
  name: string;
}

/**
 * Accounts written straight into `users`, for lists that need many of them or exact
 * names, newest first in the order given (each a second older than the one before).
 * They have no usable password: nothing signs in as them.
 */
export async function insertTenants(specs: { label: string; name: string; ageSeconds?: number }[]): Promise<InsertedTenant[]> {
  const out: InsertedTenant[] = [];
  for (const [index, spec] of specs.entries()) {
    const email = `${spec.label}-${randomUUID().slice(0, 8)}@e2e.example.test`.toLowerCase();
    const [row] = await sql<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, created_at)
       VALUES ($1, $2, 'e2e-no-password', now() - make_interval(secs => $3::int))
       RETURNING id`,
      [email, spec.name, spec.ageSeconds ?? index],
    );
    out.push({ id: row.id, email, name: spec.name });
  }
  return out;
}

const WINDOW_START_SQL = `((date_trunc('day', now() AT TIME ZONE 'UTC') - INTERVAL '29 days') AT TIME ZONE 'UTC')::timestamp`;

export interface TenantCounts {
  total: number;
  suspended: number;
  new30d: number;
  today: number;
}

/** The overview's tenant figures counted in SQL, leaving out the given accounts. */
export async function tenantCounts(exclude: string[] = []): Promise<TenantCounts> {
  const [row] = await sql<{ total: number; suspended: number; new30d: number; today: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE suspended_at IS NOT NULL)::int AS suspended,
            count(*) FILTER (WHERE created_at >= ${WINDOW_START_SQL})::int AS new30d,
            count(*) FILTER (WHERE (created_at::timestamptz AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date)::int AS today
       FROM users WHERE NOT (id = ANY($1::uuid[]))`,
    [exclude],
  );
  return row;
}

export interface OverviewBody {
  tenants: { total: number; active: number; suspended: number; newLast30d: number };
  projects: number;
  links: number;
  identities: number;
  clicksLast30d: number;
  signupsByDay: { date: string; count: number }[];
  usageCoverage: { startedOn: string; countedFrom: string; countedThrough: string | null; mauFrom: string } | null;
  usage30d: Record<string, number | null> | null;
  usageTrend: { date: string; values: Record<string, number | null> }[];
  topTenants: { id: string; email: string; name: string; mauThisMonth: number; messagesSent30d: number; lastUsageDay: string | null }[];
  quietTenants: { count: number; tenants: OverviewBody['topTenants'] };
}

const overviewCaptures = new WeakMap<Page, OverviewBody[]>();

/**
 * Every overview body the page receives from now on, read as it passes through
 * `page.route` (a body read from the response itself is lost when the page navigates
 * away first, and a request already in flight when this starts is never counted).
 */
async function overviewBodies(page: Page): Promise<OverviewBody[]> {
  let bodies = overviewCaptures.get(page);
  if (!bodies) {
    const list: OverviewBody[] = [];
    bodies = list;
    overviewCaptures.set(page, list);
    await page.route(
      (url) => url.pathname === '/api/admin/overview',
      async (route) => {
        const response = await route.fetch();
        if (route.request().method() === 'GET' && response.status() === 200) {
          list.push(((await response.json()) as { data: OverviewBody }).data);
        }
        await route.fulfill({ response });
      },
    );
  }
  return bodies;
}

/** Runs `trigger` and answers the first overview body the page receives after it. */
async function nextOverview(page: Page, trigger: () => Promise<unknown>): Promise<OverviewBody> {
  const bodies = await overviewBodies(page);
  const seen = bodies.length;
  await trigger();
  await expect.poll(() => bodies.length, { message: 'the page fetched the overview' }).toBeGreaterThan(seen);
  return bodies[seen];
}

/**
 * Loads the overview by `open` and answers the body the page received, together with
 * what `measure` read just before and just after. Other tests share the database, so
 * when the two readings differ the page is reloaded and read again, until a body was
 * served while nothing measured moved.
 */
export async function stableOverview<T>(
  page: Page,
  open: () => Promise<unknown>,
  measure: () => Promise<T>,
): Promise<{ body: OverviewBody; measured: T }> {
  let trigger = open;
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await measure();
    const body = await nextOverview(page, trigger);
    const after = await measure();
    if (JSON.stringify(before) === JSON.stringify(after)) {
      await expect(page.getByText('Signups per day', { exact: true })).toBeVisible();
      return { body, measured: before };
    }
    trigger = () => page.reload();
  }
  throw new Error('The shared database kept changing while the overview loaded');
}

/** Opens the overview and answers the body the page painted. */
export async function openOverview(page: Page): Promise<OverviewBody> {
  const body = await nextOverview(page, () => page.goto(adminUrl('/')));
  await expect(page.getByText('Signups per day', { exact: true })).toBeVisible();
  return body;
}

/** A card on an admin page by its exact title. */
export function cardTitled(page: Page, title: string) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]').getByText(title, { exact: true }) });
}

/** The big number of a stat card on the overview. */
export function statValue(page: Page, title: string) {
  return cardTitled(page, title).locator('[data-slot="card-content"] > div').first();
}

/** The caption under a stat card's number. */
export function statCaption(page: Page, title: string) {
  return cardTitled(page, title).locator('[data-slot="card-content"] > p').first();
}

/** Sums of `usage_daily` per metric over `[from, through]`, leaving out the given owners. */
export async function usageSums(from: string, through: string, excludeOwners: string[]): Promise<Record<string, number>> {
  const rows = await sql<{ metric: string; total: string }>(
    `SELECT metric, sum(value)::text AS total FROM usage_daily
      WHERE day >= $1::date AND day <= $2::date AND NOT (owner_id = ANY($3::uuid[]))
      GROUP BY metric`,
    [from, through, excludeOwners],
  );
  return Object.fromEntries(rows.map((row) => [row.metric, Number(row.total)]));
}

/** `'2026-11-13'` as the admin app writes a usage day: "13 Nov 2026". */
export function usageDay(day: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, month, date] = day.split('-');
  return `${Number(date)} ${months[Number(month) - 1]} ${year}`;
}

/** `'2026-11-13'` as "13 Nov". */
export function usageShortDay(day: string): string {
  return usageDay(day).split(' ').slice(0, 2).join(' ');
}

/** The tenants list's requests, as their query parameters, recorded from now on. */
export function recordTenantListRequests(page: Page): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/admin/tenants' && request.method() === 'GET') seen.push(url.searchParams);
  });
  return seen;
}

/** The rows of the tenants table (not its header). */
export function tenantRows(page: Page) {
  return page.getByRole('main').locator('tbody tr');
}

/** The email shown in each row of the tenants table, in order. */
export async function listedEmails(page: Page): Promise<string[]> {
  return tenantRows(page).locator('td:first-child a').allInnerTexts();
}

/** A plan staff make on the Plans page (no price: enough to comp). */
export async function createCompPlan(staffToken: string, ip: string, label: string): Promise<{ code: string; name: string }> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  const plan = { code: `e2e_${label}_${suffix}`, name: `E2E ${label} ${suffix}` };
  const response = await adminRequest('POST', '/api/admin/plans', {
    token: staffToken,
    ip,
    body: { ...plan, mauLimit: 1000, projectLimit: 20, seatLimit: 10, sortOrder: 20, reason: 'E2E: a plan to comp' },
  });
  if (response.status !== 201 && response.status !== 200) throw new Error(`create plan answered ${response.status}: ${response.text}`);
  return plan;
}

export async function compTenant(staffToken: string, ip: string, tenantId: string, planCode: string): Promise<void> {
  const response = await adminRequest('POST', `/api/admin/tenants/${tenantId}/billing/comp`, {
    token: staffToken,
    ip,
    body: { planCode, reason: 'E2E: comped for the list' },
  });
  if (response.status !== 201 && response.status !== 200) throw new Error(`comp answered ${response.status}: ${response.text}`);
}

/** One SDK identify with a verified external id (its userHash made with the project's identity secret). */
export async function identifyKnownPerson(
  owner: Account,
  projectId: string,
  sdkKey: string,
  ip: string,
  person: { externalUserId: string; email: string },
): Promise<void> {
  const { secret } = await api<{ secret: string }>('GET', `/api/projects/${projectId}/identity-secret`, undefined, {
    token: owner.accessToken,
    ip,
  });
  await api(
    'POST',
    '/api/identity/identify',
    {
      projectId,
      platform: 'web',
      deviceFingerprint: `admten-device-${randomUUID()}`,
      externalUserId: person.externalUserId,
      distinctId: person.externalUserId,
      userHash: createHmac('sha256', secret).update(person.externalUserId, 'utf8').digest('hex'),
      email: person.email,
    },
    { apiKey: sdkKey, ip },
  );
}

// ---- Tenant page, usage, limits and suspension (P1 chunk 2)

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * An instant as the admin app writes it with date-fns (`MMM d, yyyy` and, with
 * `withTime`, ` HH:mm`), in this machine's time zone, which the browser shares.
 */
export function adminDate(value: string | Date, withTime = false): string {
  const date = new Date(value);
  const day = `${SHORT_MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  return withTime ? `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}` : day;
}

/** `'2026-11-13'` moved by `days` (UTC days). */
export function addUtcDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** `'2026-11'` as "Nov 2026". */
export function usageMonth(month: string): string {
  const [year, index] = month.split('-');
  return `${SHORT_MONTHS[Number(index) - 1]} ${year}`;
}

/** One fact of the tenant page's Account card (its `dd`), by its label. */
export function accountFact(page: Page, label: string) {
  return cardTitled(page, 'Account')
    .locator('dl > div')
    .filter({ has: page.locator('dt').getByText(label, { exact: true }) })
    .locator('dd');
}

/** A desktop click on a short link, as `GET /api/<code>` (the redirect writes its click row after answering). */
export async function clickShortLink(code: string, ip: string): Promise<number> {
  const response = await fetch(apiUrl(`/api/${code}`), {
    redirect: 'manual',
    headers: {
      'X-Forwarded-For': ip,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  await response.arrayBuffer();
  return response.status;
}

/** `person` joins `projectId` with `role`: invited by `owner` through the API and accepted with the link's token. */
export async function inviteAndAccept(
  owner: Account,
  projectId: string,
  person: Account,
  role: 'member' | 'admin',
  ip: string,
): Promise<void> {
  const invite = await api<{ inviteUrl: string }>(
    'POST',
    `/api/projects/${projectId}/invitations`,
    { email: person.email, role },
    { token: owner.accessToken, ip },
  );
  const token = new URL(invite.inviteUrl).hash.replace(/^#token=/, '');
  await api('POST', '/api/invitations/accept', { token }, { token: person.accessToken, ip });
}

/** A pending invitation from `owner` to a new address; answers the address. */
export async function inviteAddress(owner: Account, projectId: string, ip: string, label = 'invitee'): Promise<string> {
  const email = `${label}-${randomUUID().slice(0, 8)}@e2e.example.test`;
  await api('POST', `/api/projects/${projectId}/invitations`, { email, role: 'member' }, { token: owner.accessToken, ip });
  return email;
}

/** A draft journey in `projectId` (the worker's tick leaves it alone), written in SQL. */
export async function insertDraftJourney(projectId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO journeys (project_id, name, trigger, steps) VALUES ($1, $2, '{}', '[]') RETURNING id`,
    [projectId, `E2E journey ${randomUUID().slice(0, 6)}`],
  );
  return row.id;
}

/** A journey run in SQL; `dueInSeconds` null leaves `next_due_at` empty. Answers its id. */
export async function insertJourneyRun(
  projectId: string,
  journeyId: string,
  status: 'active' | 'completed' | 'exited' | 'failed',
  dueInSeconds: number | null,
): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO journey_runs (project_id, journey_id, person_key, status, next_due_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(secs => $5::int) END)
     RETURNING id`,
    [projectId, journeyId, `e2e-person-${randomUUID().slice(0, 8)}`, status, dueInSeconds],
  );
  return row.id;
}

export async function runDueAt(runId: string): Promise<Date | null> {
  const [row] = await sql<{ next_due_at: Date | null }>(`SELECT next_due_at FROM journey_runs WHERE id = $1`, [runId]);
  return row.next_due_at;
}

// ---- View-as session and factor reset card (P1 chunk 3)

/**
 * An HS256 token signed with the run's JWT secret (the customer API's access token key),
 * for copies of a view-as token with one claim changed.
 */
export function signCustomerJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}`;
  const signature = createHmac('sha256', runSecrets().jwtSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

/** Writes `value` as the tab's stored view-as record, from a static file of the dashboard (no app code runs there). */
export async function writeStoredViewAs(page: Page, value: string): Promise<void> {
  await page.goto('/logo.svg');
  await page.evaluate((raw) => sessionStorage.setItem('chumbaq_impersonation', raw), value);
}

/** The Authorization header of every customer API request the context sends from now on. */
export function recordAuthorizations(page: Page): string[] {
  const seen: string[] = [];
  page.context().on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      const header = request.headers()['authorization'];
      if (header) seen.push(header);
    }
  });
  return seen;
}

/** The tenant page's "Second factors" card. */
export function secondFactorsCard(page: Page) {
  return page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Second factors' }) });
}

/** Audit rows written from one client address (each test has its own). */
export async function auditCountFromIp(ip: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_logs WHERE ip_address = $1`, [ip]);
  return n;
}

import { createHash } from 'crypto';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import { api, apiUrl, createAccount, type Account } from '../api';
import { enrolAndSignInStaff } from '../admin';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the admin tenant specs (ADMTEN): staff set-up, raw admin API requests,
 * the view-as exchange, SQL reads and seeds, and a small CSV reader.
 */

// ---- Database

/** A query against the lane's e2e database (the name is checked as in support/seed.ts). */
export async function withDb<T>(work: (db: Client) => Promise<T>): Promise<T> {
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
export async function seedRollupThroughYesterday(): Promise<() => Promise<void>> {
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

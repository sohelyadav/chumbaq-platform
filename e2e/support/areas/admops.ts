import { createHash, randomBytes, randomUUID } from 'crypto';
import path from 'path';
import { Client } from 'pg';
import type { Locator, Page } from '@playwright/test';
import { adminUrl, enrolAndSignInStaff } from '../admin';
import { api, apiUrl, createAccount, newClientIp, type Account } from '../api';
import { portInUse, run, stopAll, waitForUrl, type Started } from '../processes';
import { appEnvironment, assertE2eDatabase, REPO_ROOT, runSecrets, stackEnv, stackPorts } from '../stack';

/**
 * Helpers for the ADMOPS specs: the admin audit log, platform health, incidents, alarms,
 * the localhost alarm route and traps. SQL reads and seeds go to the lane's e2e
 * database only (the name is checked as in support/seed.ts).
 */

// ---- Database

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

export async function sql<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withDb(async (db) => (await db.query(text, params)).rows as T[]);
}

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export const hex = (bytes = 4) => randomBytes(bytes).toString('hex');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until `done` holds for its value, or throws with the last value after `timeoutMs`. */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T = await read();
  while (!done(last)) {
    if (Date.now() > until) throw new Error(`Timed out waiting; last value: ${JSON.stringify(last)}`);
    await sleep(250);
    last = await read();
  }
  return last;
}

// ---- Staff

export interface Staff {
  account: Account;
  /** A staff access token from a passkey sign-in a moment ago (so a recent sign-in). */
  token: string;
}

/** A new account with the super admin flag (all the guards read; the CLI is the admin spec's). */
export async function makeSuperAdminAccount(ip: string, label = 'staff', name = 'Opal Ops'): Promise<Account> {
  const account = await createAccount(ip, label, name);
  const rows = await sql(`UPDATE users SET is_super_admin = true WHERE id = $1 RETURNING id`, [account.userId]);
  if (!rows.length) throw new Error(`No users row ${account.userId}`);
  return account;
}

/** A new super admin, signed in to the admin app in `page` with a passkey (the tab keeps the key). */
export async function signedInStaff(page: Page, ip: string, name = 'Opal Ops'): Promise<Staff> {
  const account = await makeSuperAdminAccount(ip, 'ops', name);
  const token = await enrolAndSignInStaff(page, account);
  return { account, token };
}

/**
 * Moves the staff member's sign-in 20 minutes into the past, past the 15 minutes a recent
 * sign-in lasts. The next token (a page load in the admin app refreshes) carries it.
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
  json: any;
}

export async function rawRequest(url: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Decoded by hand: Response.text() drops a leading byte order mark, which exports carry.
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

export function adminApiBase(): string {
  const base = process.env.E2E_ADMIN_API_URL;
  if (!base) throw new Error('E2E_ADMIN_API_URL is not set: run the specs through playwright.config.ts');
  return base;
}

export function customerApiBase(): string {
  const base = process.env.E2E_API_URL;
  if (!base) throw new Error('E2E_API_URL is not set: run the specs through playwright.config.ts');
  return base;
}

/** A request to the admin API with the test's address, answered whatever its status. */
export function adminRequest(
  method: string,
  pathname: string,
  { token, ip, body, headers }: { token?: string; ip: string; body?: unknown; headers?: Record<string, string> },
): Promise<RawResponse> {
  return rawRequest(`${adminApiBase()}${pathname}`, method, body, {
    'X-Forwarded-For': ip,
    'X-Chumbaq-Client': 'admin',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(headers ?? {}),
  });
}

/** A request to the customer API with the test's address, answered whatever its status. */
export function customerRequest(
  method: string,
  pathname: string,
  { token, ip, body, headers }: { token?: string; ip: string; body?: unknown; headers?: Record<string, string> },
): Promise<RawResponse> {
  return rawRequest(apiUrl(pathname), method, body, {
    'X-Forwarded-For': ip,
    'X-Chumbaq-Client': 'web',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(headers ?? {}),
  });
}

/** An error body without the parts that differ per request (time and path). */
export function comparableError(json: any): Record<string, unknown> {
  const { timestamp: _t, path: _p, requestId: _r, ...rest } = json ?? {};
  return rest;
}

// ---- Routes

/** Every ADMOPS admin route, with a body each would accept; `marker` goes into what would be stored. */
export function admopsRoutes(marker: string): { method: string; path: string; body?: unknown }[] {
  const id = randomUUID();
  return [
    { method: 'GET', path: '/api/admin/audit-logs' },
    { method: 'GET', path: '/api/admin/audit-logs/export' },
    { method: 'GET', path: '/api/admin/health' },
    { method: 'POST', path: '/api/admin/platform-email/test', body: {} },
    { method: 'GET', path: '/api/admin/incidents' },
    { method: 'POST', path: '/api/admin/incidents', body: { types: ['iii'], title: marker } },
    { method: 'GET', path: `/api/admin/incidents/${id}` },
    { method: 'GET', path: `/api/admin/incidents/${id}/report-draft` },
    { method: 'POST', path: `/api/admin/incidents/${id}/report`, body: { method: 'email' } },
    { method: 'POST', path: `/api/admin/incidents/${id}/notes`, body: { note: marker } },
    { method: 'POST', path: `/api/admin/incidents/${id}/close`, body: { note: marker } },
    { method: 'GET', path: '/api/admin/security-contact' },
    { method: 'PUT', path: '/api/admin/security-contact', body: { orgName: marker } },
    { method: 'GET', path: '/api/admin/security-alerts' },
    { method: 'GET', path: '/api/admin/tripwires' },
    { method: 'POST', path: '/api/admin/tripwires/api-key', body: { label: marker } },
    { method: 'POST', path: '/api/admin/tripwires/account', body: { label: marker, email: `trap-${marker}@e2e.example.test` } },
    { method: 'POST', path: `/api/admin/tripwires/${id}/revoke` },
  ];
}

/** What the ADMOPS write routes could leave behind for `marker` or the given addresses. */
export async function writesFor(marker: string, ips: string[]) {
  const [{ incidents }] = await sql<{ incidents: string }>(
    `SELECT count(*)::text AS incidents FROM security_incidents WHERE title = $1`,
    [marker],
  );
  const [{ traps }] = await sql<{ traps: string }>(`SELECT count(*)::text AS traps FROM security_tripwires WHERE label = $1`, [marker]);
  const [{ audit }] = await sql<{ audit: string }>(
    `SELECT count(*)::text AS audit FROM admin_audit_logs WHERE ip_address = ANY($1) OR target_label = $2`,
    [ips, marker],
  );
  const contact = await sql(`SELECT org_name, updated_at FROM security_contact`);
  return { incidents, traps, audit, contact: JSON.stringify(contact) };
}

// ---- Audit rows

export interface SeedAuditRow {
  actorEmail: string;
  action?: string;
  createdAt?: Date | string;
  targetType?: string;
  targetId?: string | null;
  targetLabel?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/** Inserts audit rows directly (the table has no trigger); answers their ids in order. */
export async function seedAuditRows(rows: SeedAuditRow[]): Promise<string[]> {
  const ids: string[] = [];
  await withDb(async (db) => {
    for (const row of rows) {
      const result = await db.query(
        `INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_type, target_id, target_label, reason, metadata, ip_address, created_at)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now())) RETURNING id`,
        [
          row.actorEmail,
          row.action ?? 'tenant.suspended',
          row.targetType ?? 'user',
          row.targetId ?? null,
          row.targetLabel ?? null,
          row.reason ?? null,
          row.metadata ? JSON.stringify(row.metadata) : null,
          row.ipAddress ?? null,
          row.createdAt ? new Date(row.createdAt).toISOString() : null,
        ],
      );
      ids.push(result.rows[0].id);
    }
  });
  return ids;
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

export function auditRowsWhere(where: { actorEmail?: string; action?: string; targetId?: string; targetLabel?: string }): Promise<AuditRow[]> {
  const params: unknown[] = [];
  const filters: string[] = ['true'];
  if (where.actorEmail) filters.push(`actor_email = $${params.push(where.actorEmail)}`);
  if (where.action) filters.push(`action = $${params.push(where.action)}`);
  if (where.targetId) filters.push(`target_id = $${params.push(where.targetId)}`);
  if (where.targetLabel) filters.push(`target_label = $${params.push(where.targetLabel)}`);
  return sql<AuditRow>(`SELECT * FROM admin_audit_logs WHERE ${filters.join(' AND ')} ORDER BY created_at DESC, id DESC`, params);
}

// ---- Alarms and traps

export interface AlarmRow {
  id: string;
  kind: string;
  dedupe_key: string;
  details: Record<string, unknown>;
  ip_address: string | null;
  count: number;
  first_at: Date;
}

export function alarms(where: { kind?: string; key?: string; keyLike?: string }): Promise<AlarmRow[]> {
  const params: unknown[] = [];
  const filters: string[] = ['true'];
  if (where.kind) filters.push(`kind = $${params.push(where.kind)}`);
  if (where.key) filters.push(`dedupe_key = $${params.push(where.key)}`);
  if (where.keyLike) filters.push(`dedupe_key LIKE $${params.push(where.keyLike)}`);
  return sql<AlarmRow>(`SELECT * FROM security_alerts WHERE ${filters.join(' AND ')} ORDER BY first_at`, params);
}

/** A trap key row as making one leaves it: only the key's sha256 is stored. */
export async function seedTrapKey(label: string, revoked = false): Promise<{ id: string; key: string }> {
  const key = `chumbaq_${randomBytes(32).toString('hex')}`;
  const [row] = await sql<{ id: string }>(
    `INSERT INTO security_tripwires (kind, value_hash, label, revoked_at) VALUES ('api_key', $1, $2, ${revoked ? 'now()' : 'NULL'}) RETURNING id`,
    [sha256Hex(key), label],
  );
  return { id: row.id, key };
}

/** A trap account row: the sha256 of the lower-cased, trimmed address. */
export async function seedTrapAccount(label: string, email: string): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO security_tripwires (kind, value_hash, label) VALUES ('account', $1, $2) RETURNING id`,
    [sha256Hex(email.trim().toLowerCase()), label],
  );
  return { id: row.id };
}

// ---- Incidents

export interface IncidentRow {
  id: string;
  noticed_at: Date;
  recorded_by: string | null;
  how_noticed: string;
  types: string[];
  title: string;
  summary: string;
  systems: string;
  tenant_ids: string[];
  alert_id: string | null;
  status: string;
  reported_at: Date | null;
  reported_by: string | null;
  report_method: string | null;
  certin_reference: string | null;
  closed_at: Date | null;
  closed_by: string | null;
}

export async function incidentRow(id: string): Promise<IncidentRow> {
  const [row] = await sql<IncidentRow>(`SELECT * FROM security_incidents WHERE id = $1`, [id]);
  if (!row) throw new Error(`No incident ${id}`);
  return row;
}

export async function incidentByTitle(title: string): Promise<IncidentRow | undefined> {
  const [row] = await sql<IncidentRow>(`SELECT * FROM security_incidents WHERE title = $1`, [title]);
  return row;
}

/** Records an incident through the admin API; answers its detail. */
export async function recordIncident(
  token: string,
  ip: string,
  body: { title: string; types?: string[]; noticedAt?: string; howNoticed?: string; summary?: string; systems?: string; tenantIds?: string[] },
): Promise<{ id: string; title: string; noticedAt: string; deadline: string }> {
  const response = await adminRequest('POST', '/api/admin/incidents', { token, ip, body: { types: ['iii'], ...body } });
  if (response.status !== 201) throw new Error(`POST /api/admin/incidents answered ${response.status}: ${response.text.slice(0, 300)}`);
  return response.json.data;
}

/** `11 Nov 2026, 14:05 IST (08:35 UTC)`, as the admin app and the report draft write a time. */
export function istAndUtc(at: Date | string): string {
  const date = new Date(at);
  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${ist} IST (${date.toISOString().slice(11, 16)} UTC)`;
}

/** The start of the minute `at` is in. */
export function floorMinute(at: Date | number): number {
  const ms = typeof at === 'number' ? at : at.getTime();
  return ms - (ms % 60_000);
}

// ---- View-as

/** A view-as token for `tenantId`: the handoff from the admin API, spent on the customer API. */
export async function viewAsToken(staffToken: string, tenantId: string, ip: string): Promise<string> {
  const started = await adminRequest('POST', `/api/admin/tenants/${tenantId}/impersonate`, {
    token: staffToken,
    ip,
    body: { reason: 'E2E: a view-as token for the access checks' },
  });
  if (started.status !== 200) throw new Error(`impersonate answered ${started.status}: ${started.text.slice(0, 300)}`);
  const code = new URL(started.json.data.url as string).hash.replace(/^#code=/, '');
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip });
  return session.accessToken;
}

// ---- A second admin API with the alarm token set

export interface ExtraAdminApi {
  url: string;
  token: string;
  stop(): Promise<void>;
}

/**
 * Another admin API process on the lane's database and Redis, started with
 * SECURITY_ALERT_TOKEN set (the lane's own admin API runs without it), on a free port of
 * its own, for the cases about the localhost alarm route server scripts call.
 */
export async function startAlarmTokenAdminApi(): Promise<ExtraAdminApi> {
  const ports = stackPorts();
  let port = 0;
  for (let candidate = ports.adminApi + 60; candidate < ports.adminApi + 70; candidate++) {
    if (!(await portInUse(candidate))) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error('No free port for the alarm-token admin API');
  const token = `e2e-alarm-${randomBytes(16).toString('hex')}`;
  const env = {
    ...process.env,
    ...appEnvironment(runSecrets(), ports),
    ADMIN_API_PORT: String(port),
    SECURITY_ALERT_TOKEN: token,
  };
  const started: Started = run(`admin-api-alarm-token-${port}`, 'node', ['dist/main-admin'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env,
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForUrl(started, `${url}/api/health`);
  } catch (error) {
    await stopAll([started]);
    throw error;
  }
  return { url, token, stop: () => stopAll([started]) };
}

/**
 * A POST to an alarm route as a server script sends it: straight to the address, with no
 * X-Forwarded-For unless given in `headers`.
 */
export function postAlarm(base: string, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return rawRequest(`${base}/api/internal/security-alerts`, 'POST', body, headers);
}

// ---- Admin app locators

/** A toast in the admin app's notification list, by its title. */
export function toastItem(page: Page, title: string): Locator {
  return page.getByRole('region', { name: /Notifications/ }).locator('li').filter({ hasText: title });
}

/** The audit log table's body rows. */
export function auditTableRows(page: Page): Locator {
  return page.locator('table tbody tr');
}

/** Opens a page of the admin app and waits for its heading. */
export async function openAdminPage(page: Page, pathname: string, heading: string): Promise<void> {
  await page.goto(adminUrl(pathname));
  await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
}

// ---- CSV

/** RFC 4180: quoted cells may hold commas, doubled quotes and line breaks; records end in CRLF. */
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

/** A CSV (BOM dropped) as objects keyed by its header. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  return rows.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
}

export { newClientIp, adminUrl };

// ---- P1 helpers

/**
 * `count` audit rows for one actor, one statement (`generate_series`), created one
 * second apart ending at `endAt` (row `n` is the newest), each with the reason
 * `<reasonPrefix> <n>`. Answers nothing: read them back by the actor.
 */
export async function seedBulkAuditRows(
  actorEmail: string,
  count: number,
  { endAt = new Date(), reasonPrefix = 'bulk row', action = 'tenant.suspended' }: { endAt?: Date; reasonPrefix?: string; action?: string } = {},
): Promise<void> {
  await sql(
    `INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_type, reason, created_at)
     SELECT NULL, $1, $2, 'user', $3 || ' ' || n, $4::timestamptz - (($5 - n) * interval '1 second')
     FROM generate_series(1, $5::int) AS n`,
    [actorEmail, action, reasonPrefix, endAt.toISOString(), count],
  );
}

/**
 * Another admin API process on the lane's database and Redis with extra environment, on
 * a free port of its own, from `firstOffset` to `firstOffset + 4` above the lane's admin
 * API (70..79 is no other ADMOPS helper's). Tests that run at the same time pass ranges
 * that do not overlap, so neither can find the other's process at "its" port.
 */
export async function startAdminApiWith(
  extra: Record<string, string>,
  label: string,
  firstOffset = 70,
): Promise<{ url: string; stop(): Promise<void> }> {
  if (firstOffset < 70 || firstOffset + 5 > 80) throw new Error(`Offset ${firstOffset} is outside 70..79`);
  const ports = stackPorts();
  let port = 0;
  for (let candidate = ports.adminApi + firstOffset; candidate < ports.adminApi + firstOffset + 5; candidate++) {
    if (!(await portInUse(candidate))) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error(`No free port for the ${label} admin API`);
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
    throw error;
  }
  return { url, stop: () => stopAll([started]) };
}

/** Sends every request of a page under an admin API path prefix to another admin API. */
export async function forwardAdminPrefix(page: Page, base: string, prefix: string): Promise<void> {
  const origin = new URL(adminUrl('/')).origin;
  await page.route(
    (url) => url.origin === origin && url.pathname.startsWith(prefix),
    async (route) => {
      const target = new URL(route.request().url());
      const response = await route.fetch({ url: `${base}${target.pathname}${target.search}` });
      await route.fulfill({ response });
    },
  );
}

/** An `AdminHealth` body of a working stack, with `overrides` laid over it. */
export function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    checkedAt: new Date().toISOString(),
    database: { ok: true, latencyMs: 3 },
    redis: { ok: true, latencyMs: 1 },
    platformEmail: { configured: true, from: 'no-reply@e2e.example.test' },
    clock: { state: 'unknown', source: null, stratum: null, offsetMs: null },
    queues: [
      { name: 'push-campaign', waiting: 0, active: 0, delayed: 0, failed: 0 },
      { name: 'cohort-sync', waiting: 0, active: 0, delayed: 0, failed: 0 },
      { name: 'segment-materialize', waiting: 0, active: 0, delayed: 0, failed: 0 },
    ],
    ...overrides,
  };
}

/** Answers the page's `GET /api/admin/health` with `body` (in the API's `{ data }` envelope) until replaced. */
export async function serveHealth(page: Page, body: Record<string, unknown>): Promise<void> {
  await page.unroute(/\/api\/admin\/health$/);
  await page.route(/\/api\/admin\/health$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: body }) }),
  );
}

/** A link in the admin app's sidebar. */
export function sidebarItem(page: Page, name: string): Locator {
  return page.locator('[data-sidebar="sidebar"]').getByRole('link', { name, exact: true });
}

/** The section name in the admin app's header breadcrumb. */
export function breadcrumbSection(page: Page): Locator {
  return page.locator('header [data-slot="breadcrumb-page"]').first();
}

/** A card of the page, by its title. */
export function cardTitled(page: Page, title: string): Locator {
  return page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^${title}$`) }) });
}

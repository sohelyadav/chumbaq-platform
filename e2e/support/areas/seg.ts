import { createHmac, randomBytes } from 'crypto';
import type { Browser, Locator, Page } from '@playwright/test';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { newPersonContext } from '../fixtures';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the audiences (segments) and journeys specs (SEG): a project with an
 * SDK key and its identity secret, people through the SDK's identify route, events
 * written straight to user_events (so they can be back-dated, and stored for a
 * do-not-track row the ingest route would drop), segments and journeys made through
 * the API, teammates, a view-as session, and SQL reads of what the API writes.
 */

// ---- SQL against the lane's e2e database (the name is checked as in reset.ts)

export async function sql<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
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

export async function segmentRow(id: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM segments WHERE id = $1`, [id]);
  return row;
}

export async function memberKeys(segmentId: string): Promise<string[]> {
  const rows = await sql<{ person_key: string }>(
    `SELECT person_key FROM segment_members WHERE segment_id = $1 ORDER BY person_key`,
    [segmentId],
  );
  return rows.map((row) => row.person_key);
}

export async function journeyRow(id: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM journeys WHERE id = $1`, [id]);
  return row;
}

export async function runCount(journeyId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM journey_runs WHERE journey_id = $1`, [journeyId]);
  return row.n;
}

/** Journey runs as the runner leaves them, for counts and cascades. */
export async function insertRuns(projectId: string, journeyId: string, status: 'active' | 'completed' | 'exited' | 'failed', count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await sql(
      `INSERT INTO journey_runs (project_id, journey_id, person_key, current_step_index, steps_taken, status, completed_at)
       VALUES ($1, $2, $3, 1, 1, $4::varchar, CASE WHEN $4::varchar = 'active' THEN NULL ELSE now() END)`,
      [projectId, journeyId, `e2e-person-${randomBytes(4).toString('hex')}`, status],
    );
  }
}

export async function activityRows(projectId: string, action: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM project_activity WHERE project_id = $1 AND action = $2 ORDER BY occurred_at`, [projectId, action]);
}

export async function allActivity(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM project_activity WHERE project_id = $1 ORDER BY occurred_at`, [projectId]);
}

// ---- Requests that answer the status and body instead of throwing

export interface RawResponse {
  status: number;
  body: any;
}

export async function raw(
  method: string,
  path: string,
  body: unknown,
  { ip, token, apiKey }: { ip: string; token?: string; apiKey?: string },
): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
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

export interface SegProject {
  owner: Account;
  project: Project;
  sdkKey: string;
  secret: string;
}

export function userHash(secret: string, externalUserId: string): string {
  return createHmac('sha256', secret).update(externalUserId, 'utf8').digest('hex');
}

export async function segProject(ip: string, label = 'seg-owner', owner?: Account): Promise<SegProject> {
  const account = owner ?? (await createAccount(ip, label, 'Sena Segments'));
  const project = await createProject(account, ip);
  const sdkKey = await createApiKey(account, project.id, ip);
  const { secret } = await api<{ secret: string }>('GET', `/api/projects/${project.id}/identity-secret`, undefined, {
    token: account.accessToken,
    ip,
  });
  return { owner: account, project, sdkKey, secret };
}

export function uniqueId(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}`;
}

export interface PersonSpec {
  externalUserId?: string;
  traits?: Record<string, unknown>;
  emailOptIn?: boolean;
  platform?: string;
  /** Written to the device row after identify (the SDK has no field for them). */
  row?: { country?: string | null; city?: string | null; total_sessions?: number; do_not_track?: boolean; last_event_at?: null };
}

/**
 * One device through the SDK's identify route (an external id gets its userHash),
 * then the columns identify cannot set written to its row. Answers the device row id.
 */
export async function addDevice(p: SegProject, ip: string, spec: PersonSpec = {}): Promise<string> {
  const body: Record<string, unknown> = {
    projectId: p.project.id,
    platform: spec.platform ?? 'web',
    deviceFingerprint: `seg-device-${randomBytes(8).toString('hex')}`,
  };
  if (spec.externalUserId) {
    body.externalUserId = spec.externalUserId;
    body.distinctId = spec.externalUserId;
    body.userHash = userHash(p.secret, spec.externalUserId);
  }
  if (spec.traits) body.traits = spec.traits;
  if (spec.emailOptIn !== undefined) body.emailOptIn = spec.emailOptIn;
  const identity = await api<{ id: string }>('POST', '/api/identity/identify', body, { apiKey: p.sdkKey, ip });
  const row = spec.row ?? {};
  const columns = Object.keys(row);
  if (columns.length > 0) {
    const sets = columns.map((column, i) => `${column} = $${i + 2}`).join(', ');
    await sql(`UPDATE device_identities SET ${sets} WHERE id = $1`, [identity.id, ...columns.map((c) => (row as Record<string, unknown>)[c])]);
  }
  return identity.id;
}

/**
 * An event row as the ingest route stores it, `daysAgo` in the past. Written directly
 * so it can be back-dated, and stored for a do-not-track device too (as an event sent
 * before the switch would be).
 */
export async function insertEvent(
  projectId: string,
  deviceIdentityId: string,
  eventName: string,
  properties: Record<string, unknown> | null = null,
  daysAgo = 1,
): Promise<void> {
  await sql(
    `INSERT INTO user_events (project_id, device_identity_id, event_name, properties, source_type, timestamp)
     VALUES ($1, $2, $3, $4, 'sdk', now() - ($5::int * interval '1 day'))`,
    [projectId, deviceIdentityId, eventName, properties === null ? null : JSON.stringify(properties), daysAgo],
  );
}

// ---- Segments and journeys through the API

export type Node = Record<string, unknown>;

export function group(children: Node[], operator: 'and' | 'or' = 'and', extra: Node = {}): Node {
  return { type: 'group', operator, children, ...extra };
}

export function attribute(field: string, op: string, value: unknown = null): Node {
  return { type: 'attribute', field, op, value };
}

export function behaviour(eventName: string, extra: Node = {}): Node {
  return { type: 'behaviour', eventName, occurrence: 'at_least', count: 1, withinDays: 30, ...extra };
}

export interface SegmentRecord {
  id: string;
  name: string;
  description: string | null;
  definition: Node;
  evaluationMode: 'live' | 'materialized';
  status: string;
  lastMemberCount: number | null;
  lastMaterializedAt: string | null;
}

export async function createSegment(account: Account, projectId: string, ip: string, body: Record<string, unknown>): Promise<SegmentRecord> {
  return api<SegmentRecord>('POST', `/api/projects/${projectId}/segments`, body, { token: account.accessToken, ip });
}

export async function previewCount(account: Account, projectId: string, ip: string, definition: Node): Promise<number> {
  const { count } = await api<{ count: number }>('POST', `/api/projects/${projectId}/segments/preview`, { definition }, {
    token: account.accessToken,
    ip,
  });
  return count;
}

/** Saves a live audience for `definition` and answers its members' person keys. */
export async function liveMembers(account: Account, projectId: string, ip: string, definition: Node): Promise<string[]> {
  const segment = await createSegment(account, projectId, ip, {
    name: uniqueId('live'),
    definition,
    evaluationMode: 'live',
    status: 'active',
  });
  const page = await api<{ personKeys: string[]; nextCursor: string | null }>(
    'GET',
    `/api/projects/${projectId}/segments/${segment.id}/members`,
    undefined,
    { token: account.accessToken, ip },
  );
  return page.personKeys;
}

/**
 * Stands in for a refresh run: membership rows for `personKeys` and the stamps a run
 * leaves (count and time). A fresh stamp keeps the worker from refreshing it again
 * within its interval.
 */
export async function markMaterialised(segmentId: string, projectId: string, personKeys: string[]): Promise<void> {
  for (const key of personKeys) {
    await sql(`INSERT INTO segment_members (segment_id, project_id, person_key) VALUES ($1, $2, $3)`, [segmentId, projectId, key]);
  }
  await sql(`UPDATE segments SET last_materialized_at = now(), last_member_count = $2 WHERE id = $1`, [segmentId, personKeys.length]);
}

export interface JourneyRecord {
  id: string;
  name: string;
  status: string;
  enrolledThrough: string | null;
}

export const WELCOME_STEPS = [
  { type: 'wait', durationSeconds: 86_400 },
  { type: 'send_push', title: 'Hi' },
];

export async function createJourney(account: Account, projectId: string, ip: string, body: Record<string, unknown>): Promise<JourneyRecord> {
  return api<JourneyRecord>(
    'POST',
    `/api/projects/${projectId}/journeys`,
    { trigger: { type: 'event', eventName: 'signup' }, steps: WELCOME_STEPS, ...body },
    { token: account.accessToken, ip },
  );
}

export async function setJourneyStatus(account: Account, projectId: string, ip: string, id: string, status: string): Promise<JourneyRecord> {
  return api<JourneyRecord>('POST', `/api/projects/${projectId}/journeys/${id}/status`, { status }, { token: account.accessToken, ip });
}

// ---- Teammates

/** A new account invited to the project with this role, and accepted. */
export async function addTeammate(owner: Account, projectId: string, role: 'admin' | 'member', ip: string): Promise<Account> {
  const teammate = await createAccount(ip, `seg-${role}`, `Sam ${role}`);
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

// ---- View-as

/**
 * Staff view-as of `tenant`: a super admin (the flag set directly, which is all the
 * guards read) enrols a passkey and signs in to the admin app in a browser of their
 * own, and starts view-as with a reason. Answers the one-time handoff link.
 */
export async function viewAsHandoff(browser: Browser, baseURL: string | undefined, tenant: Account): Promise<string> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'seg-staff', 'Sid Staff');
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [staff.userId]);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const page = await context.newPage();
    const staffToken = await enrolAndSignInStaff(page, staff);
    const handoff = await adminApi<{ url: string }>(
      'POST',
      `/api/admin/tenants/${tenant.userId}/impersonate`,
      { reason: 'E2E: checking audiences read-only' },
      staffToken,
      ip,
    );
    return handoff.url;
  } finally {
    await context.close();
  }
}

/** Spends a handoff link's code on the customer API; answers the view-as token. */
export async function exchangeHandoff(url: string, ip: string): Promise<string> {
  const code = new URL(url).hash.replace(/^#code=/, '');
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip });
  return session.accessToken;
}

/** Opens a view-as handoff link in this tab and waits for the read-only banner. */
export async function openViewAs(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
}

// ---- Page

/**
 * A toast, by its title, in the notifications region. Located by its label rather
 * than its role: an open modal dialog hides the rest of the page from the
 * accessibility tree, toasts included.
 */
export function toastTitled(page: Page, title: string): Locator {
  return page.locator('[aria-label^="Notifications"] li').filter({ hasText: title });
}

/** Records every browser dialog (alert, confirm) the page opens. */
export function recordDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
}

/** Records requests whose method matches and whose path ends with `suffix`. */
export function recordRequests(page: Page, method: string, suffix: string | RegExp): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    const matches = typeof suffix === 'string' ? path.endsWith(suffix) : suffix.test(path);
    if (request.method() === method && matches) seen.push(path);
  });
  return seen;
}

/** The audience editor's inputs (their labels have no htmlFor). */
export function audienceName(page: Page): Locator {
  return page.getByPlaceholder('e.g. Lapsed high-value buyers');
}

export function audienceDescription(page: Page): Locator {
  return page.getByPlaceholder('Who this is, and why you would message them.');
}

/** Picks an option of a Radix select. */
export async function choose(trigger: Locator, option: string): Promise<void> {
  await trigger.click();
  await trigger.page().getByRole('option', { name: option, exact: true }).click();
}

/** The live count in the editor's header: the number and the line under it. */
export function countFigure(page: Page): Locator {
  return page.locator('div.min-w-\\[110px\\] > div').first();
}

export function countCaption(page: Page): Locator {
  return page.locator('div.min-w-\\[110px\\] > div').nth(1);
}

/** A table row of a list page, by the name link it holds. */
export function rowNamed(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
}

/** The view-as access token the customer app keeps for this tab. */
export async function viewAsTokenOf(page: Page): Promise<string> {
  const stored = await page.evaluate(() => sessionStorage.getItem('chumbaq_impersonation'));
  if (!stored) throw new Error('No view-as session in this tab');
  return (JSON.parse(stored) as { accessToken: string }).accessToken;
}

/** Holds `method` requests whose path ends with `suffix` until the returned function is called. */
export async function holdRequests(page: Page, method: string, suffix: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname.endsWith(suffix),
    async (route) => {
      if (route.request().method() === method) await gate;
      await route.continue();
    },
  );
  return release;
}

/** Waits for a preview response whose request's definition satisfies `matches`. */
export function previewResponse(page: Page, matches: (definition: any) => boolean = () => true) {
  return page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== 'POST' || !new URL(response.url()).pathname.endsWith('/segments/preview')) return false;
    return matches((request.postDataJSON() as { definition: unknown }).definition);
  });
}

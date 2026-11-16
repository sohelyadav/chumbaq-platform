import { createHmac, randomBytes } from 'crypto';
import type { Browser, Locator, Page } from '@playwright/test';
import { Queue } from 'bullmq';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { newPersonContext } from '../fixtures';
import { runJobNow } from '../jobs';
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

// ---- Journeys: editor, runtime and staff (seg-p0-02)

/** The journey editor's inputs (their labels have no htmlFor). */
export function journeyName(page: Page): Locator {
  return page.getByPlaceholder('e.g. Abandoned cart follow-up');
}

export function journeyDescription(page: Page): Locator {
  return page.getByPlaceholder('Optional — what this journey does and why.');
}

export function journeyEventName(page: Page): Locator {
  return page.getByPlaceholder('e.g. cart_abandoned');
}

/** The sentence in the editor's sticky bar naming the first problem, or what saving does. */
export function journeyActionBar(page: Page): Locator {
  return page.locator('div.sticky.bottom-0 p');
}

/** One step's card in the journey editor, by its "Step N" badge. */
export function stepCard(page: Page, n: number): Locator {
  return page.locator('div.rounded-lg.border.p-4').filter({ has: page.getByText(`Step ${n}`, { exact: true }) });
}

/** A step card's icon buttons, in order: up, down, delete. */
export function stepButtons(card: Locator): { up: Locator; down: Locator; remove: Locator } {
  const buttons = card.getByRole('button');
  return { up: buttons.nth(0), down: buttons.nth(1), remove: buttons.nth(2) };
}

/** The "add a step" buttons under the list ("Wait", "Send push", "Branch", ...). */
export function addStepButton(page: Page, label: string): Locator {
  return page.getByRole('button', { name: label, exact: true });
}

/** A branch step's three selects: segment, member path, non-member path. */
export function branchSelects(card: Locator): { segment: Locator; member: Locator; nonMember: Locator } {
  const selects = card.getByRole('combobox');
  return { segment: selects.nth(0), member: selects.nth(1), nonMember: selects.nth(2) };
}

export async function deviceFingerprint(deviceId: string): Promise<string> {
  const [row] = await sql<{ device_fingerprint: string }>(`SELECT device_fingerprint FROM device_identities WHERE id = $1`, [deviceId]);
  if (!row) throw new Error(`No device row ${deviceId}`);
  return row.device_fingerprint;
}

/** An event through the SDK's track route, from that device. Answers the stored timestamp. */
export async function trackEvent(p: SegProject, ip: string, deviceId: string, eventName: string, timestamp?: Date): Promise<Date> {
  const body: Record<string, unknown> = {
    projectId: p.project.id,
    eventName,
    deviceFingerprint: await deviceFingerprint(deviceId),
  };
  if (timestamp) body.timestamp = timestamp.toISOString();
  const event = await api<{ id: string; timestamp: string }>('POST', '/api/events/track', body, { apiKey: p.sdkKey, ip });
  if (!event?.id) throw new Error('The track route stored nothing');
  return new Date(event.timestamp);
}

export interface RunRow {
  id: string;
  person_key: string;
  status: string;
  current_step_index: number;
  next_due_at: Date | null;
  completed_at: Date | null;
  last_error: string | null;
}

export async function runsOf(journeyId: string): Promise<RunRow[]> {
  return sql<RunRow>(
    `SELECT id, person_key, status, current_step_index, next_due_at, completed_at, last_error
       FROM journey_runs WHERE journey_id = $1 ORDER BY created_at, person_key`,
    [journeyId],
  );
}

/** A run as the runner leaves it, for a person and step of the test's choosing. */
export async function insertRun(
  projectId: string,
  journeyId: string,
  personKey: string,
  { status = 'active', stepIndex = 1, dueInSeconds = 3600 }: { status?: string; stepIndex?: number; dueInSeconds?: number | null } = {},
): Promise<RunRow> {
  const [row] = await sql<RunRow>(
    `INSERT INTO journey_runs (project_id, journey_id, person_key, current_step_index, steps_taken, status, next_due_at, completed_at)
     VALUES ($1, $2, $3, $4, $4, $5::varchar,
             CASE WHEN $5::varchar = 'active' AND $6::int IS NOT NULL THEN now() + ($6::int * interval '1 second') END,
             CASE WHEN $5::varchar = 'active' THEN NULL ELSE now() END)
     RETURNING id, person_key, status, current_step_index, next_due_at, completed_at, last_error`,
    [projectId, journeyId, personKey, stepIndex, status, dueInSeconds],
  );
  return row;
}

export async function watermarkOf(journeyId: string): Promise<Date | null> {
  const row = await journeyRow(journeyId);
  return row?.enrolled_through ? new Date(row.enrolled_through) : null;
}

/**
 * Waits until the worker's minute tick has run for this active journey after
 * `after`: every tick moves an active journey's watermark on to its own now (or,
 * for a suspended tenant, holds it at now), whether or not anyone enrolled.
 * The tick advances runs after enrolling, so a short pause follows.
 */
export async function waitForTickAfter(journeyId: string, after: Date, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const watermark = await watermarkOf(journeyId);
    if (watermark && watermark.getTime() > after.getTime()) break;
    if (Date.now() > deadline) throw new Error(`No journey tick for ${journeyId} after ${after.toISOString()}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
}

/**
 * Returns once the clock is clear of the worker's minute boundary (ticks run at
 * second 0, segment refreshes every fifth minute at second 0), so a short sequence of
 * requests cannot be interleaved with a tick.
 */
export async function clearOfTick(): Promise<void> {
  for (;;) {
    const second = new Date().getSeconds();
    if (second >= 4 && second <= 40) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Runs the segment refresh now: the same job the five-minute refresh scheduler
 * enqueues, on its queue, for the worker's processor to run. Waits until the run has
 * stamped `last_materialized_at` later than when it was asked for.
 */
export async function materialiseNow(segmentId: string, projectId: string, timeoutMs = 60_000): Promise<Date> {
  const env = stackEnv();
  const asked = new Date();
  const queue = new Queue('segment-materialize', {
    connection: {
      host: env.REDIS_HOST || '127.0.0.1',
      port: Number(env.REDIS_PORT || 6379),
      password: env.REDIS_PASSWORD || undefined,
      db: Number(env.REDIS_DB),
    },
  });
  try {
    await sql(`UPDATE segments SET materializing_at = now() WHERE id = $1`, [segmentId]);
    await queue.add('materialize-segment', { segmentId, projectId });
  } finally {
    await queue.close();
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await segmentRow(segmentId);
    const at = row?.last_materialized_at ? new Date(row.last_materialized_at) : null;
    if (at && at.getTime() >= asked.getTime() - 1000 && row?.materializing_at === null) return at;
    if (Date.now() > deadline) throw new Error(`Segment ${segmentId} was not materialised`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * A super admin signed in to the admin app in a browser of their own (the flag set
 * directly, a passkey enrolled). Answers a staff token fresh enough for suspend.
 */
export async function staffSession(browser: Browser, baseURL: string | undefined): Promise<{ token: string; ip: string }> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'seg-staff', 'Sid Staff');
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [staff.userId]);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const page = await context.newPage();
    return { token: await enrolAndSignInStaff(page, staff), ip };
  } finally {
    await context.close();
  }
}

export async function suspendTenant(staff: { token: string; ip: string }, tenant: Account): Promise<void> {
  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { reason: 'E2E: journey suspension check' }, staff.token, staff.ip);
}

export async function reactivateTenant(staff: { token: string; ip: string }, tenant: Account): Promise<void> {
  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/reactivate`, { reason: 'E2E: journey suspension over' }, staff.token, staff.ip);
}

// ---- Audience editor and list (seg-p1-01)

/** A card of the project's pages, by its title. */
export function cardTitled(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]').getByText(title, { exact: true }) });
}

/** The editor's rule cards (event and profile rules, inside groups too), in page order. */
export function ruleCards(page: Page | Locator): Locator {
  return page.locator('div.space-y-3.rounded-lg.border.bg-card.p-4');
}

/** The dashed box of a rule group, in page order. */
export function groupBoxes(page: Page): Locator {
  return page.locator('div.rounded-lg.border.border-dashed');
}

/** A rule card's bin (the first button: selects are comboboxes, not buttons). */
export function ruleBin(card: Locator): Locator {
  return card.getByRole('button').first();
}

/** The red line under the rules naming the first problem (or the count's error). */
export function problemLine(page: Page): Locator {
  return page.locator('p.text-destructive').filter({ has: page.locator('svg') });
}

/** The rule counter under the rules ("N of 50 rules"). */
export function ruleCounter(page: Page): Locator {
  return page.getByText(/^\d+ of 50 rules$/);
}

/** An event rule's select of event names (placeholder until one is chosen). */
export function eventSelect(scope: Page | Locator, current = 'choose an event'): Locator {
  return scope.getByRole('combobox').filter({ hasText: current });
}

/** The editor's breadcrumb trail. */
export function breadcrumb(page: Page): Locator {
  return page.locator('nav[aria-label="breadcrumb"]');
}

export interface AudiencePeople {
  alice: string;
  bob: string;
  dnt: string;
  /** The anonymous device's person key, `device:<row id>`. */
  anon: string;
  devices: { alice: string; bob: string; dnt: string; anon: string };
}

/**
 * A fixed cast for audience counts: alice (IN, plan pro, score 99, three purchases of 50, 150
 * and 250 in the last week, a signup), bob (US, plan free, score "100", one purchase
 * 40 days ago, a signup), an anonymous device with no country, and a do-not-track
 * person in IN with two purchases.
 */
export async function seedAudiencePeople(p: SegProject, ip: string): Promise<AudiencePeople> {
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  const dnt = uniqueId('u-dnt');
  const pid = p.project.id;
  const aliceDevice = await addDevice(p, ip, { externalUserId: alice, traits: { plan: 'pro', score: 99 }, emailOptIn: true, row: { country: 'IN' } });
  const bobDevice = await addDevice(p, ip, { externalUserId: bob, traits: { plan: 'free', score: '100' }, emailOptIn: false, row: { country: 'US' } });
  const anonDevice = await addDevice(p, ip, { row: { country: null } });
  const dntDevice = await addDevice(p, ip, { externalUserId: dnt, row: { country: 'IN', do_not_track: true } });
  for (const amount of [50, 150, 250]) await insertEvent(pid, aliceDevice, 'purchase', { amount }, 3);
  await insertEvent(pid, bobDevice, 'purchase', { amount: 75 }, 40);
  await insertEvent(pid, aliceDevice, 'signup', null, 5);
  await insertEvent(pid, bobDevice, 'signup', null, 45);
  await insertEvent(pid, dntDevice, 'purchase', { amount: 10 }, 2);
  await insertEvent(pid, dntDevice, 'purchase', { amount: 20 }, 2);
  return {
    alice,
    bob,
    dnt,
    anon: `device:${anonDevice}`,
    devices: { alice: aliceDevice, bob: bobDevice, dnt: dntDevice, anon: anonDevice },
  };
}

/** Members of a live audience for `definition`, sorted. */
export async function sortedMembers(account: Account, projectId: string, ip: string, definition: Node): Promise<string[]> {
  return (await liveMembers(account, projectId, ip, definition)).sort();
}

// ---- Audience edit, members, materialisation, journeys list and editor (seg-p1-02)

/**
 * Runs the worker's segment refresh job now (the five-minute cron's own method), which
 * enqueues every materialised audience that is due, and waits until this one's run has
 * stamped `last_materialized_at` later than `after` and released its claim. The stack's
 * worker processes the job; its own cron may get there first, which is the same outcome.
 */
export async function refreshThroughScheduler(segmentId: string, after: Date | null = null, timeoutMs = 90_000): Promise<Date> {
  await runJobNow('segment-refresh');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await segmentRow(segmentId);
    const at = row?.last_materialized_at ? new Date(row.last_materialized_at) : null;
    if (at && (!after || at.getTime() > after.getTime()) && row?.materializing_at === null) return at;
    if (Date.now() > deadline) throw new Error(`Segment ${segmentId} was not refreshed by the scheduler`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Moves an audience's last refresh back, so its interval has passed. */
export async function ageRefresh(segmentId: string, minutes: number): Promise<void> {
  await sql(`UPDATE segments SET last_materialized_at = last_materialized_at - ($2::int * interval '1 minute') WHERE id = $1`, [segmentId, minutes]);
}

export interface MemberRow {
  person_key: string;
  entered_at: Date;
  materialized_at: Date;
}

export async function memberRows(segmentId: string): Promise<MemberRow[]> {
  return sql<MemberRow>(
    `SELECT person_key, entered_at, materialized_at FROM segment_members WHERE segment_id = $1 ORDER BY person_key`,
    [segmentId],
  );
}

/** The option names of a Radix select, then closes it. */
export async function selectOptions(trigger: Locator): Promise<string[]> {
  await trigger.click();
  const page = trigger.page();
  await page.getByRole('option').first().waitFor();
  const names = await page.getByRole('option').allInnerTexts();
  await page.keyboard.press('Escape');
  await page.getByRole('option').first().waitFor({ state: 'detached' });
  return names.map((name) => name.trim());
}

// ---- Journeys API, journey runtime and coverage additions (seg-p1-03)

/** A connection of its own to the lane's e2e database, for locks held across calls. */
async function openClient(): Promise<Client> {
  const env = stackEnv();
  const client = new Client({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT || 5432),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: assertE2eDatabase(env),
  });
  await client.connect();
  return client;
}

/**
 * Runs the worker's journey tick now (enrol, then advance due runs), as its minute cron
 * does. Other specs' runs fail on purpose and log errors in the same tick, so the run's
 * own errors are not refused here: callers assert the outcome on their own rows.
 *
 * One at a time across the spec's workers (a session advisory lock), and clear of the
 * stack's own minute tick: two ticks reading the same watermark both enrol from it, so a
 * run that ended in the first could be started again by the second, which is not what a
 * single worker does.
 */
export async function tickNow(): Promise<string> {
  const client = await openClient();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('e2e:seg:journey-tick'))`);
    await clearOfTick();
    const { output } = await runJobNow('journey-tick', { allowErrors: true, timeoutMs: 90_000 });
    return output;
  } finally {
    // Ending the session releases the lock.
    await client.end();
  }
}

/**
 * The journey scheduler's five-minute sweep of stranded runs, now (`runJobNow`). Answers
 * what it printed; an error line from another test's journey is allowed.
 */
export async function sweepStrandedRunsNow(): Promise<string> {
  return (await runJobNow('journey-stranded-sweep', { allowErrors: true, timeoutMs: 90_000 })).output;
}

/** Makes every active run of the journey due now, as if its wait had run out. */
export async function makeRunsDue(journeyId: string): Promise<void> {
  await sql(
    `UPDATE journey_runs SET next_due_at = now() - interval '1 second' WHERE journey_id = $1 AND status = 'active'`,
    [journeyId],
  );
}

export interface PushDevice {
  id: string;
  fingerprint: string;
  token: string | null;
}

/**
 * One Android device through the SDK's identify route (an external id gets its userHash),
 * with a push token registered through the SDK's register route unless `token` is false.
 */
export async function addPushDevice(
  p: SegProject,
  ip: string,
  { externalUserId, pushOptIn, token = true }: { externalUserId?: string; pushOptIn?: boolean; token?: boolean } = {},
): Promise<PushDevice> {
  const fingerprint = `seg-push-${randomBytes(8).toString('hex')}`;
  const body: Record<string, unknown> = { projectId: p.project.id, platform: 'android', deviceFingerprint: fingerprint };
  if (externalUserId) {
    body.externalUserId = externalUserId;
    body.distinctId = externalUserId;
    body.userHash = userHash(p.secret, externalUserId);
  }
  if (pushOptIn !== undefined) body.pushOptIn = pushOptIn;
  const identity = await api<{ id: string }>('POST', '/api/identity/identify', body, { apiKey: p.sdkKey, ip });
  let registered: string | null = null;
  if (token) {
    registered = `seg-fcm-${randomBytes(16).toString('hex')}`;
    await api(
      'POST',
      '/api/push-tokens/register',
      { projectId: p.project.id, deviceFingerprint: fingerprint, token: registered, platform: 'android' },
      { apiKey: p.sdkKey, ip },
    );
  }
  return { id: identity.id, fingerprint, token: registered };
}

/** Identify again from a device already known by its fingerprint, now naming a signed-in person. */
export async function identifyAs(p: SegProject, ip: string, fingerprint: string, externalUserId: string): Promise<string> {
  const identity = await api<{ id: string }>(
    'POST',
    '/api/identity/identify',
    {
      projectId: p.project.id,
      platform: 'web',
      deviceFingerprint: fingerprint,
      externalUserId,
      distinctId: externalUserId,
      userHash: userHash(p.secret, externalUserId),
    },
    { apiKey: p.sdkKey, ip },
  );
  return identity.id;
}

export interface CampaignRow {
  id: string;
  channel: string;
  title: string;
  target_type: string;
  target_device_ids: string[] | null;
  data: Record<string, string> | null;
}

/** The project's push campaign rows, oldest first. */
export async function campaignsOf(projectId: string): Promise<CampaignRow[]> {
  return sql<CampaignRow>(
    `SELECT id, channel, title, target_type, target_device_ids, data FROM push_notification_logs WHERE project_id = $1 ORDER BY sent_at, id`,
    [projectId],
  );
}

/**
 * Queues one materialisation of the audience for the worker, as the refresh scheduler
 * does (claim stamped, job added), without waiting for it to finish.
 */
export async function enqueueMaterialise(segmentId: string, projectId: string): Promise<void> {
  const env = stackEnv();
  const queue = new Queue('segment-materialize', {
    connection: {
      host: env.REDIS_HOST || '127.0.0.1',
      port: Number(env.REDIS_PORT || 6379),
      password: env.REDIS_PASSWORD || undefined,
      db: Number(env.REDIS_DB),
    },
  });
  try {
    await sql(`UPDATE segments SET materializing_at = now() WHERE id = $1`, [segmentId]);
    await queue.add('materialize-segment', { segmentId, projectId });
  } finally {
    await queue.close();
  }
}

/**
 * Holds `LOCK TABLE <table> IN ACCESS EXCLUSIVE MODE` in an open transaction on a
 * connection of its own, so the next statement that reads the table waits. Answers the
 * release (commit). The API's lock timeout is 10 s: release well before that.
 */
export async function lockTable(table: 'segments' | 'device_identities'): Promise<() => Promise<void>> {
  const client = await openClient();
  await client.query('BEGIN');
  await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  };
}

/**
 * Waits until some other session is waiting for a lock on `table`, and, given `queryLike`
 * (an ILIKE pattern), one whose statement matches it: other specs reading the same table
 * at that moment would otherwise pass for the statement the caller is waiting on.
 */
export async function waitForLockWaiter(table: string, queryLike?: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.relation = $1::regclass AND NOT l.granted AND ($2::text IS NULL OR a.query ILIKE $2)`,
      [table, queryLike ?? null],
    );
    if (row.n > 0) return;
    if (Date.now() > deadline) {
      const waiting = await sql<{ query: string }>(
        `SELECT a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.relation = $1::regclass AND NOT l.granted`,
        [table],
      );
      throw new Error(`Nothing${queryLike ? ` like ${queryLike}` : ''} waited on ${table}; waiting: ${JSON.stringify(waiting.map((w) => w.query))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Activity rows of the project, as a count, for "this wrote nothing". */
export async function activityCount(projectId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM project_activity WHERE project_id = $1`, [projectId]);
  return row.n;
}

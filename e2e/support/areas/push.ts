import { randomBytes, randomUUID } from 'crypto';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { seedFcmConfig, type FakeServiceAccount } from '../channels';
import { newPersonContext } from '../fixtures';
import { stubCalls } from '../provider-stub';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the push specs (PUSH): projects with a seeded FCM connection, devices
 * through the SDK's identify and token routes, teammates with a role, staff view-as,
 * campaign and event rows read or seeded in SQL, and the provider stub's FCM and
 * Google token calls filtered by what one test owns.
 */

export const PROJECT_NOT_FOUND = 'Project not found';
export const ROLE_REFUSAL = 'Your role in this project does not allow this.';
export const READ_ONLY = 'Impersonation sessions are read-only';
export const HIDDEN = 'hidden while viewing as tenant';
export const HIDDEN_FROM_ROLE = 'Only owners and admins can see this.';
export const NOT_CONFIGURED = 'Push notifications not configured for this project. Call configure first.';
export const NO_REACHABLE_TOKENS =
  'No reachable push tokens for the target users (none registered, opted out of push, or at the frequency cap)';
export const TOKEN_URI_REFUSED = "The service account's token_uri must be Google's token endpoint.";
export const TEST_SEND_SUSPENDED = "This project's account is suspended.";
export const STOPPED_BY_SUSPENSION =
  'Stopped because this account was suspended. Anyone not yet reached did not receive this campaign, and it will not resume automatically.';
export const MISSED_DURING_SUSPENSION =
  'Not sent: this account was suspended when the campaign was due. It will not be sent automatically; schedule it again if it is still wanted.';

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

export async function campaignRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_notification_logs WHERE project_id = $1 ORDER BY sent_at, id`, [projectId]);
}

export async function campaignRow(id: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM push_notification_logs WHERE id = $1`, [id]);
  return row;
}

export async function pushConfigRow(projectId: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM push_configs WHERE project_id = $1`, [projectId]);
  return row;
}

export async function credentialRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT provider, updated_at FROM push_channel_credentials WHERE project_id = $1 ORDER BY provider`, [projectId]);
}

export async function activityRows(projectId: string, action: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM project_activity WHERE project_id = $1 AND action = $2 ORDER BY occurred_at`, [projectId, action]);
}

/**
 * A finished push campaign row, as the worker leaves one, for list and cap cases that
 * need history rather than a send.
 */
export async function seedSentCampaign(projectId: string, title = 'Earlier campaign'): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs (project_id, title, status, total_tokens, success_count, processed_tokens, completed_at)
     VALUES ($1, $2, 'sent', 1, 1, 1, now()) RETURNING id`,
    [projectId, title],
  );
  return row.id;
}

/**
 * A `sent` event for a device, as the worker writes one when a frequency cap is on:
 * what the cap counts. Defaults to an hour ago (inside the 24-hour window).
 */
export async function seedSentEvent(projectId: string, campaignId: string, deviceIdentityId: string, hoursAgo = 1): Promise<void> {
  await sql(
    `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, platform, occurred_at)
     VALUES ($1, $2, $3, 'sent', 'android', now() - make_interval(hours => $4))`,
    [projectId, campaignId, deviceIdentityId, hoursAgo],
  );
}

/** Marks the account suspended as staff suspending it leaves it (see SMSWA). */
export async function suspendAccount(userId: string): Promise<void> {
  const rows = await sql(
    `UPDATE users SET suspended_at = now(), session_version = session_version + 1 WHERE id = $1 RETURNING id`,
    [userId],
  );
  if (rows.length !== 1) throw new Error(`No users row ${userId}`);
}

export async function reactivateAccount(userId: string): Promise<void> {
  const rows = await sql(`UPDATE users SET suspended_at = NULL WHERE id = $1 RETURNING id`, [userId]);
  if (rows.length !== 1) throw new Error(`No users row ${userId}`);
}

// ---- Requests that answer the status and body instead of throwing

export interface RawResponse {
  status: number;
  text: string;
  body: any;
}

export interface Caller {
  accessToken: string;
  ip: string;
}

export async function call(method: string, path: string, as: Caller | null, body?: unknown): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': as?.ip ?? newClientIp(),
      ...(as ? { Authorization: `Bearer ${as.accessToken}` } : {}),
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
  return { status: response.status, text, body: parsed };
}

/** The API's error message as one string (validation errors come as a list). */
export function messageOf(response: RawResponse): string {
  const message = response.body?.message;
  return Array.isArray(message) ? message.join('; ') : String(message);
}

/** The `data` of a successful call, or throws with the body. */
export function dataOf<T = any>(response: RawResponse): T {
  if (response.status >= 300) throw new Error(`Answered ${response.status}: ${response.text.slice(0, 400)}`);
  return response.body?.data as T;
}

// ---- People with a role in a project

export interface Person extends Account {
  ip: string;
}

export async function newPerson(label: string, name = 'Pat Push'): Promise<Person> {
  const ip = newClientIp();
  return { ...(await createAccount(ip, label, name)), ip };
}

/** Adds someone to a project with a role, as an accepted invite leaves it. */
export async function addMember(projectId: string, person: Pick<Account, 'userId'>, role: 'owner' | 'admin' | 'member', addedBy: Pick<Account, 'userId'>): Promise<void> {
  await sql(
    `INSERT INTO project_members (project_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, clock_timestamp())`,
    [projectId, person.userId, role, addedBy.userId],
  );
}

export async function teammate(projectId: string, role: 'admin' | 'member', owner: Pick<Account, 'userId'>): Promise<Person> {
  const person = await newPerson(`push-${role}`, `Tia ${role}`);
  await addMember(projectId, person, role, owner);
  return person;
}

// ---- Projects and devices

export interface PushProject {
  owner: Person;
  project: Project;
  sdkKey: string;
  /** The seeded service account, when FCM was seeded. */
  fcm?: FakeServiceAccount;
}

/** An owner with a project and an SDK key; FCM seeded (configured and active) when `fcm`. */
export async function pushProject(label: string, options: { fcm?: boolean; owner?: Person } = {}): Promise<PushProject> {
  const owner = options.owner ?? (await newPerson(label));
  const project = await createProject(owner, owner.ip, `PUSH ${label} ${randomBytes(2).toString('hex')}`);
  const sdkKey = await createApiKey(owner, project.id, owner.ip);
  const fcm = options.fcm ? await seedFcmConfig(project.id) : undefined;
  return { owner, project, sdkKey, fcm };
}

export interface Device {
  id: string;
  fingerprint: string;
  tokens: string[];
}

export interface DeviceOptions {
  /** Push tokens to register (FCM); 0 leaves the device with none. */
  tokens?: number;
  pushOptIn?: boolean;
  distinctId?: string;
}

/** A fresh FCM-looking registration token. */
export function newToken(): string {
  return `e2e-fcm-${randomBytes(20).toString('hex')}`;
}

/** One device through the SDK's identify route, then its tokens through the register route. */
export async function addDevice(p: Pick<PushProject, 'project' | 'sdkKey'>, ip: string, options: DeviceOptions = {}): Promise<Device> {
  const fingerprint = `push-${randomBytes(8).toString('hex')}`;
  const identity = await api<{ id: string }>(
    'POST',
    '/api/identity/identify',
    {
      projectId: p.project.id,
      deviceFingerprint: fingerprint,
      platform: 'android',
      ...(options.pushOptIn === undefined ? {} : { pushOptIn: options.pushOptIn }),
      ...(options.distinctId ? { distinctId: options.distinctId } : {}),
    },
    { apiKey: p.sdkKey, ip },
  );
  const tokens: string[] = [];
  for (let i = 0; i < (options.tokens ?? 1); i++) {
    const token = newToken();
    await api(
      'POST',
      '/api/push-tokens/register',
      { projectId: p.project.id, deviceFingerprint: fingerprint, token, platform: 'android' },
      { apiKey: p.sdkKey, ip },
    );
    tokens.push(token);
  }
  return { id: identity.id, fingerprint, tokens };
}

/** The SDK's logout path: the token is deactivated (`app_requested`). */
export async function unregisterToken(p: Pick<PushProject, 'project' | 'sdkKey'>, ip: string, token: string): Promise<void> {
  const query = new URLSearchParams({ projectId: p.project.id, token });
  await api('DELETE', `/api/push-tokens/unregister?${query}`, undefined, { apiKey: p.sdkKey, ip });
}

/** A live segment (attribute rule), through the dashboard route. */
export async function createSegment(as: Caller, projectId: string, name = `Seg ${randomBytes(2).toString('hex')}`): Promise<string> {
  const created = await call('POST', `/api/projects/${projectId}/segments`, as, {
    name,
    definition: { type: 'attribute', field: 'country', op: 'eq', value: 'US' },
  });
  return dataOf<{ id: string }>(created).id;
}

export const randomId = () => randomUUID();

// ---- Provider stub: calls one test owns

/** FCM send calls for one Firebase project (its id is in the path). */
export async function fcmSendsFor(firebaseProjectId: string) {
  return (await stubCalls('fcm')).filter((c) => c.path.includes(`/projects/${firebaseProjectId}/messages:send`));
}

/** The `iss` claim of a JWT-bearer assertion, or null. */
function assertionIssuer(body: unknown): string | null {
  const assertion = (body as { assertion?: unknown } | null)?.assertion;
  if (typeof assertion !== 'string') return null;
  try {
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8')) as { iss?: string };
    return claims.iss ?? null;
  } catch {
    return null;
  }
}

/** Google token exchanges made with a service account's key (by its client_email). */
export async function tokenExchangesFor(clientEmail: string) {
  return (await stubCalls('google-oauth')).filter((c) => assertionIssuer(c.body) === clientEmail);
}

// ---- Pages

/** Opens the push page on a tab. */
export async function openPush(page: Page, projectId: string, tab: 'Campaigns' | 'Templates' | 'Settings' = 'Campaigns'): Promise<void> {
  await page.goto(`/projects/${projectId}/push-notifications`);
  await page.getByRole('heading', { name: 'Push Notifications', exact: true }).waitFor();
  if (tab !== 'Campaigns') {
    const trigger = page.getByRole('tab', { name: tab, exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-selected', 'true');
  }
}

/** The card whose title is `title` (shadcn cards carry data-slot). */
export function card(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^\\s*${title}\\s*$`) }) });
}

/**
 * The block holding a field whose shadcn Label has no htmlFor: the label's parent.
 * `nth` picks among repeated labels (variant rows).
 */
export function field(scope: Page | Locator, label: string, nth = 0): Locator {
  return scope.getByText(label, { exact: true }).nth(nth).locator('..');
}

/** The value of a `dt`/`dd` pair in the connection status card. */
export function statusValue(page: Page, term: string): Locator {
  return page.locator('dt', { hasText: new RegExp(`^${term}$`) }).locator('xpath=following-sibling::dd[1]');
}

/** A toast (its Radix root) by its exact title. */
export function toastTitled(page: Page, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .getByRole('region', { name: /Notifications/ })
    .locator('li')
    .filter({ has: page.locator('div.text-sm.font-semibold', { hasText: new RegExp(`^${escaped}$`) }) });
}

/** The composer's reach figure on the Audience step. */
export function reachFigure(page: Page): Locator {
  return page.locator('p.text-3xl.font-semibold');
}

// ---- View-as

export interface StaffSession {
  token: string;
  ip: string;
}

/**
 * A new super admin (the flag set as `admin:grant` sets it) who enrols a passkey and
 * signs in to the admin app in a browser of their own. Its token starts view-as.
 */
export async function signedInStaff(browser: Browser, baseURL: string | undefined): Promise<StaffSession> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'push-staff', 'Sid Staff');
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [staff.userId]);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const token = await enrolAndSignInStaff(await context.newPage(), staff);
    return { token, ip };
  } finally {
    await context.close();
  }
}

/** A one-time view-as link (`APP_URL/impersonate#code=`) for `tenant`. */
export async function viewAsLink(staff: StaffSession, tenant: Pick<Account, 'userId'>): Promise<string> {
  const handoff = await adminApi<{ url: string }>(
    'POST',
    `/api/admin/tenants/${tenant.userId}/impersonate`,
    { reason: 'E2E: checking push pages read-only' },
    staff.token,
    staff.ip,
  );
  return handoff.url;
}

/** A view-as access token, spent from a fresh link as the /impersonate page spends it. */
export async function viewAsCaller(staff: StaffSession, tenant: Pick<Account, 'userId'>): Promise<Caller> {
  const url = await viewAsLink(staff, tenant);
  const code = new URL(url).hash.replace(/^#code=/, '');
  const ip = newClientIp();
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip });
  return { accessToken: session.accessToken, ip };
}

/** Opens a view-as link in this tab and waits for the read-only banner. */
export async function openViewAs(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
}

// ---- SDK routes (X-API-Key) and seeded rows for the detail, template and token cases

/** An SDK request with an API key (or none), answering the status and body. */
export async function sdkCall(method: string, path: string, apiKey: string | null, body?: unknown, ip = newClientIp()): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
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
  return { status: response.status, text, body: parsed };
}

/** A server-only privacy key (needs the owner's recent sign-in, which a new account has). */
export async function privacyKey(owner: Person, projectId: string): Promise<string> {
  const created = await api<{ fullKey: string }>(
    'POST',
    `/api/projects/${projectId}/api-keys`,
    { name: 'E2E privacy key', permissions: ['privacy'] },
    { token: owner.accessToken, ip: owner.ip },
  );
  return created.fullKey;
}

export interface SeedCampaign {
  title?: string;
  body?: string | null;
  status?: string;
  scheduledAt?: Date | null;
  errorMessage?: string | null;
  failureDetails?: Array<{ token: string; error: string }> | null;
  totalTokens?: number;
  successCount?: number;
  failureCount?: number;
}

/** A push campaign row in a chosen final state, as the worker leaves one. */
export async function seedCampaign(projectId: string, c: SeedCampaign = {}): Promise<string> {
  const status = c.status ?? 'sent';
  const [row] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs
       (project_id, title, body, status, scheduled_at, error_message, failure_details,
        total_tokens, success_count, failure_count, processed_tokens, completed_at)
     VALUES ($1, $2, $3, $4::varchar, $5::timestamptz, $6, $7::jsonb, $8, $9, $10, $11, CASE WHEN $4::varchar IN ('scheduled', 'queued', 'sending') THEN NULL ELSE now() END)
     RETURNING id`,
    [
      projectId,
      c.title ?? 'Seeded campaign',
      c.body ?? null,
      status,
      c.scheduledAt ?? null,
      c.errorMessage ?? null,
      c.failureDetails ? JSON.stringify(c.failureDetails) : null,
      c.totalTokens ?? 1,
      c.successCount ?? 0,
      c.failureCount ?? 0,
      status === 'scheduled' ? 0 : c.totalTokens ?? 1,
    ],
  );
  return row.id;
}

export async function tokenRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_tokens WHERE project_id = $1 ORDER BY created_at, id`, [projectId]);
}

export async function tokenRowsByValue(token: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_tokens WHERE token = $1 ORDER BY created_at, id`, [token]);
}

export async function eventRows(campaignId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_notification_events WHERE campaign_id = $1 ORDER BY occurred_at, id`, [campaignId]);
}

export async function touchpointRows(projectId: string, deviceFingerprint: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM touchpoints WHERE project_id = $1 AND device_fingerprint = $2`, [projectId, deviceFingerprint]);
}

export async function templateRow(id: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM push_templates WHERE id = $1`, [id]);
  return row;
}

export async function templateRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_templates WHERE project_id = $1 ORDER BY name`, [projectId]);
}

/** A template through the dashboard route. */
export async function createTemplate(as: Caller, projectId: string, body: Record<string, unknown>): Promise<{ id: string; name: string }> {
  return dataOf(await call('POST', `/api/projects/${projectId}/push-templates`, as, { title: 'Template title', ...body }));
}

/** The composer's reach for the whole project (`totalTokens`). */
export async function projectReach(as: Caller, projectId: string): Promise<number> {
  return dataOf<{ totalTokens: number }>(await call('POST', '/api/push-notifications/audience-preview', as, { projectId })).totalTokens;
}

/** One figure tile of the campaign detail's Engagement or Delivery card (its value line). */
export function figureTile(page: Page, cardTitle: string, label: string): Locator {
  return card(page, cardTitle)
    .locator('div.rounded-lg.border')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('p')
    .first();
}

/**
 * A toast by its exact title, found by CSS rather than by role: while a dialog is open
 * Radix hides the rest of the page from the accessibility tree, the toast viewport too.
 */
export function toastBehindDialog(page: Page, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .locator('[role="region"][aria-label^="Notifications"] li')
    .filter({ has: page.locator('div.text-sm.font-semibold', { hasText: new RegExp(`^${escaped}$`) }) });
}

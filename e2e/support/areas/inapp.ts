import { createHmac, randomBytes, randomInt, randomUUID } from 'crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the in-app message specs (INAPP): projects with an SDK key, messages
 * created and moved through the dashboard routes, devices through the SDK's identify,
 * the SDK's check and event routes answering status and body, and the rows the API
 * writes (messages, impressions, the pending queue, activity) read in SQL.
 */

export const PROJECT_NOT_FOUND = 'Project not found';
export const MESSAGE_NOT_FOUND = 'In-app message not found';
export const PROJECT_MISMATCH = 'Project mismatch';
export const API_KEY_REQUIRED = 'API key is required';
export const INVALID_API_KEY = 'Invalid or expired API key';
export const PRIVACY_KEY_REFUSED =
  'This is a server-only privacy key and cannot be used by an app or SDK. Use an ordinary API key in your app.';
export const IMAGE_URL_REFUSED = 'imageUrl must be a URL address';
export const BACKGROUND_REFUSED = 'theme.backgroundColor must be a hex, rgb() or rgba() colour';

/** The theme the campaign editor's blank form posts. */
export const EDITOR_DEFAULT_THEME = {
  backgroundColor: '#ffffff',
  textColor: '#374151',
  titleColor: '#111827',
  buttonPrimaryColor: '#6366f1',
  buttonSecondaryColor: '#e5e7eb',
  overlayColor: 'rgba(0,0,0,0.5)',
  borderRadius: 16,
  animation: 'fade',
};

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

export async function messageRow(id: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM in_app_messages WHERE id = $1`, [id]);
  return row;
}

export async function messageRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM in_app_messages WHERE project_id = $1 ORDER BY created_at`, [projectId]);
}

export async function impressionRows(messageId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM in_app_message_impressions WHERE message_id = $1 ORDER BY created_at`, [messageId]);
}

export async function pendingRows(messageId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM pending_in_app_messages WHERE message_id = $1 ORDER BY created_at`, [messageId]);
}

export async function activityRows(projectId: string, action?: string): Promise<Array<Record<string, any>>> {
  return action
    ? sql(`SELECT * FROM project_activity WHERE project_id = $1 AND action = $2 ORDER BY occurred_at, id`, [projectId, action])
    : sql(`SELECT * FROM project_activity WHERE project_id = $1 ORDER BY occurred_at, id`, [projectId]);
}

/** Activity entries about in-app messages (every action whose target is one). */
export async function messageActivity(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(
    `SELECT * FROM project_activity WHERE project_id = $1 AND target_type = 'in_app_message' ORDER BY occurred_at, id`,
    [projectId],
  );
}

/** Marks the account suspended as staff suspending it leaves it. */
export async function suspendAccount(userId: string): Promise<void> {
  const rows = await sql(`UPDATE users SET suspended_at = now(), session_version = session_version + 1 WHERE id = $1 RETURNING id`, [userId]);
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

async function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Chumbaq-Client': 'web', ...headers },
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

/** A dashboard request as `as` (JWT). */
export function call(method: string, path: string, as: Caller, body?: unknown): Promise<RawResponse> {
  return send(method, path, { 'X-Forwarded-For': as.ip, Authorization: `Bearer ${as.accessToken}` }, body);
}

/** An SDK request with `apiKey` as X-API-Key, or with no key at all when it is undefined. */
export function sdkCall(path: string, apiKey: string | undefined, body: unknown, ip = newClientIp()): Promise<RawResponse> {
  return send('POST', path, { 'X-Forwarded-For': ip, ...(apiKey === undefined ? {} : { 'X-API-Key': apiKey }) }, body);
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

// ---- People, projects and keys

export interface Person extends Account {
  ip: string;
}

export async function newPerson(label: string, name = 'Ina Inapp'): Promise<Person> {
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
  const person = await newPerson(`inapp-${role}`, `Ira ${role}`);
  await addMember(projectId, person, role, owner);
  return person;
}

export interface InAppProject {
  owner: Person;
  project: Project;
  /** An ordinary SDK key of the project. */
  sdkKey: string;
}

/** An owner (new unless given) with a project and an SDK key. */
export async function inAppProject(label: string, owner?: Person): Promise<InAppProject> {
  const person = owner ?? (await newPerson(label));
  const project = await createProject(person, person.ip, `INAPP ${label} ${randomBytes(2).toString('hex')}`);
  const sdkKey = await createApiKey(person, project.id, person.ip);
  return { owner: person, project, sdkKey };
}

/** A privacy (server-only) key of the project. */
export async function createPrivacyKey(p: InAppProject): Promise<string> {
  const created = await api<{ fullKey: string }>(
    'POST',
    `/api/projects/${p.project.id}/api-keys`,
    { name: 'Privacy', permissions: ['privacy'] },
    { token: p.owner.accessToken, ip: p.owner.ip },
  );
  return created.fullKey;
}

/** An ordinary key made and then revoked. */
export async function createRevokedKey(p: InAppProject): Promise<string> {
  const created = await api<{ fullKey: string; apiKey: { id: string } }>(
    'POST',
    `/api/projects/${p.project.id}/api-keys`,
    { name: 'Revoked' },
    { token: p.owner.accessToken, ip: p.owner.ip },
  );
  await api('DELETE', `/api/projects/${p.project.id}/api-keys/${created.apiKey.id}`, undefined, { token: p.owner.accessToken, ip: p.owner.ip });
  return created.fullKey;
}

export async function identitySecret(p: InAppProject): Promise<string> {
  const { secret } = await api<{ secret: string }>('GET', `/api/projects/${p.project.id}/identity-secret`, undefined, {
    token: p.owner.accessToken,
    ip: p.owner.ip,
  });
  return secret;
}

export function userHash(secret: string, externalUserId: string): string {
  return createHmac('sha256', secret).update(externalUserId, 'utf8').digest('hex');
}

// ---- Messages

export interface InAppMessage {
  id: string;
  name: string;
  status: string;
  [key: string]: any;
}

/** A message through the dashboard's create route (`modal`, a title), plus overrides. */
export async function createInAppMessage(as: Caller, projectId: string, overrides: Record<string, unknown> = {}): Promise<InAppMessage> {
  return dataOf<InAppMessage>(
    await call('POST', `/api/projects/${projectId}/in-app-messages`, as, {
      name: `Message ${randomBytes(3).toString('hex')}`,
      messageType: 'modal',
      title: 'Hello there',
      ...overrides,
    }),
  );
}

/** Moves a message to `status` with PATCH. */
export async function setMessageStatus(as: Caller, projectId: string, id: string, status: string): Promise<InAppMessage> {
  return dataOf<InAppMessage>(await call('PATCH', `/api/projects/${projectId}/in-app-messages/${id}`, as, { status }));
}

/** A message created and then moved to `status` (left as a draft for 'draft'). */
export async function messageIn(as: Caller, projectId: string, status: string, overrides: Record<string, unknown> = {}): Promise<InAppMessage> {
  const message = await createInAppMessage(as, projectId, overrides);
  return status === 'draft' ? message : setMessageStatus(as, projectId, message.id, status);
}

// ---- Devices and the SDK routes

export function fingerprint(label: string): string {
  return `${label}-${randomBytes(6).toString('hex')}`;
}

/** A device through the SDK's identify; answers its device identity id and fingerprint. */
export async function identifyDevice(
  p: InAppProject,
  body: Record<string, unknown> = {},
  label = 'inapp-fp',
): Promise<{ id: string; fingerprint: string }> {
  const fp = (body.deviceFingerprint as string | undefined) ?? fingerprint(label);
  const identity = await api<{ id: string }>(
    'POST',
    '/api/identity/identify',
    { projectId: p.project.id, platform: 'ios', ...body, deviceFingerprint: fp },
    { apiKey: p.sdkKey, ip: p.owner.ip },
  );
  return { id: identity.id, fingerprint: fp };
}

/** `POST /api/messages/check` for a device, with the project's own key unless another is given. */
export function checkMessages(
  p: InAppProject,
  deviceFingerprint: string,
  options: { apiKey?: string | null; projectId?: string; context?: Record<string, unknown>; distinctId?: string } = {},
): Promise<RawResponse> {
  const apiKey = options.apiKey === null ? undefined : (options.apiKey ?? p.sdkKey);
  return sdkCall(
    '/api/messages/check',
    apiKey,
    {
      projectId: options.projectId ?? p.project.id,
      deviceFingerprint,
      ...(options.distinctId ? { distinctId: options.distinctId } : {}),
      context: options.context ?? { platform: 'ios' },
    },
  );
}

/** The ids of the messages a check delivers (throws unless it answered 2xx). */
export async function deliveredIds(p: InAppProject, deviceFingerprint: string): Promise<string[]> {
  const result = dataOf<{ messages: Array<{ id: string }> }>(await checkMessages(p, deviceFingerprint));
  return result.messages.map((m) => m.id);
}

/** `POST /api/messages/event`, with the project's own key unless another is given. */
export function recordInAppEvent(
  p: InAppProject,
  body: { messageId: string; deviceFingerprint: string; eventType: string; buttonId?: string; distinctId?: string; projectId?: string },
  options: { apiKey?: string | null } = {},
): Promise<RawResponse> {
  const apiKey = options.apiKey === null ? undefined : (options.apiKey ?? p.sdkKey);
  return sdkCall('/api/messages/event', apiKey, { projectId: p.project.id, ...body });
}

/** Queues a message for devices through the dashboard's trigger route. */
export async function triggerFor(as: Caller, projectId: string, messageId: string, deviceFingerprints: string[]): Promise<number> {
  const { queued } = dataOf<{ queued: number }>(
    await call('POST', `/api/projects/${projectId}/in-app-messages/trigger`, as, { messageId, targetType: 'users', deviceFingerprints }),
  );
  return queued;
}

// ---- Mixpanel cohorts and segments

/**
 * An imported Mixpanel cohort as a finished sync leaves it. Each member names the device
 * identity it was matched to (or null) and whether the sync resolved it.
 */
export async function seedCohort(
  projectId: string,
  name: string,
  members: Array<{ deviceIdentityId: string | null; resolved: boolean }>,
): Promise<string> {
  const resolved = members.filter((m) => m.resolved).length;
  const [cohort] = await sql<{ id: string }>(
    `INSERT INTO mixpanel_cohorts ("projectId", "mixpanelCohortId", name, "mixpanelUserCount", "resolvedCount", "unresolvedCount", status, "lastSyncedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'synced', now()) RETURNING id`,
    [projectId, randomInt(100_000, 2_000_000_000), name, members.length, resolved, members.length - resolved],
  );
  for (const member of members) {
    await sql(
      `INSERT INTO mixpanel_cohort_members ("cohortId", "projectId", "mixpanelDistinctId", "deviceIdentityId", "resolvedBy", "isResolved", "mixpanelProfile")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        cohort.id,
        projectId,
        `mp-${randomUUID()}`,
        member.deviceIdentityId,
        member.resolved ? 'distinct_id' : null,
        member.resolved,
        JSON.stringify({ $name: 'E2E profile' }),
      ],
    );
  }
  return cohort.id;
}

/** A live, active segment of people whose trait `key` equals `value`. */
export async function traitSegment(as: Caller, projectId: string, key: string, value: string): Promise<string> {
  const segment = dataOf<{ id: string }>(
    await call('POST', `/api/projects/${projectId}/segments`, as, {
      name: `Trait ${key} ${randomBytes(2).toString('hex')}`,
      definition: { type: 'group', operator: 'and', children: [{ type: 'attribute', field: `traits.${key}`, op: 'eq', value }] },
      evaluationMode: 'live',
      status: 'active',
    }),
  );
  return segment.id;
}

// ---- Pages

export async function openInAppList(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/in-app-messages`);
  await expect(page.getByRole('heading', { name: 'In-App Messages', exact: true })).toBeVisible();
}

/** The list row of a campaign, by its name. */
export function campaignRow(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
}

/** Opens a row's menu (its only button: an icon with no name) and clicks `item`. */
export async function rowMenuItem(page: Page, name: string, item: 'Edit' | 'Activate' | 'Pause' | 'Duplicate' | 'Delete'): Promise<void> {
  await campaignRow(page, name).getByRole('button').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/**
 * A text field of the campaign editor by its label. The editor's shadcn Labels have no
 * htmlFor, so the field is found inside the label's parent block (colour fields pair a
 * colour picker, which Chromium also calls a textbox, with the text field: the picker
 * is left out).
 */
export function editorField(page: Page, label: string): Locator {
  return page
    .locator('label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .locator('..')
    .getByRole('textbox')
    .and(page.locator(':not([type="color"])'));
}

/** A toast (its Radix root) by its exact title. */
export function toastTitled(page: Page, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .getByRole('region', { name: /Notifications/ })
    .locator('li')
    .filter({ has: page.locator('div.text-sm.font-semibold', { hasText: new RegExp(`^${escaped}$`) }) });
}

/**
 * Closes every toast on screen and waits until none is left, so a toast seen afterwards
 * was raised by what the test does next, not left over from an earlier step.
 */
export async function dismissToasts(page: Page): Promise<void> {
  const toasts = page.getByRole('region', { name: /Notifications/ }).locator('li');
  for (let tries = 0; tries < 10 && (await toasts.count()) > 0; tries++) {
    // A toast can close on its own between the count and the click.
    await toasts.first().locator('[toast-close]').click({ timeout: 2_000 }).catch(() => {});
  }
  await expect(toasts).toHaveCount(0);
}

/** The status badge beside the detail page's heading. */
export function detailBadge(page: Page, name: string): Locator {
  return page.getByRole('heading', { level: 1, name, exact: true }).locator('..');
}

/** Fails the test on any native dialog (alert, confirm, prompt) the page opens. */
export function refuseDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', async (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });
  return seen;
}

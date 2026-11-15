import { createHmac, randomBytes, randomInt, randomUUID } from 'crypto';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { newPersonContext } from '../fixtures';
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

// ---- Widgets (banner categories, their banners and widget events)

export const WIDGET_NOT_ACTIVE = 'Widget not found or not active';
export const BANNER_NOT_FOUND = 'In-app banner not found';
export const UUID_EXPECTED = 'Validation failed (uuid is expected)';
export const READ_ONLY = 'Impersonation sessions are read-only';

export const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
export const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

/** A banner category through the dashboard's create route. */
export async function createWidget(as: Caller, projectId: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  return dataOf(await call('POST', `/api/projects/${projectId}/banner-categories`, as, body));
}

/** A banner (widget item) through the dashboard's create route. */
export async function createWidgetItem(as: Caller, categoryId: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  return dataOf(await call('POST', `/api/banner-categories/${categoryId}/banners`, as, body));
}

export async function setWidgetStatus(as: Caller, categoryId: string, status: string): Promise<void> {
  dataOf(await call('PATCH', `/api/banner-categories/${categoryId}/status`, as, { status }));
}

export async function widgetRow(id: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM banner_categories WHERE id = $1`, [id]);
  return row;
}

export async function widgetRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM banner_categories WHERE project_id = $1 ORDER BY created_at`, [projectId]);
}

export async function widgetItemRows(categoryId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM in_app_banners WHERE category_id = $1 ORDER BY sort_order, created_at`, [categoryId]);
}

export async function widgetItemRow(id: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM in_app_banners WHERE id = $1`, [id]);
  return row;
}

export async function widgetEventRows(categoryId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM widget_events WHERE category_id = $1 ORDER BY created_at, id`, [categoryId]);
}

/** Every widget row of a project (categories, items, events), for "nothing changed" checks. */
export async function widgetSnapshot(projectId: string): Promise<unknown> {
  const categories = await widgetRows(projectId);
  const items = await sql(
    `SELECT b.* FROM in_app_banners b JOIN banner_categories c ON c.id = b.category_id WHERE c.project_id = $1 ORDER BY b.id`,
    [projectId],
  );
  const events = await sql(
    `SELECT e.* FROM widget_events e JOIN banner_categories c ON c.id = e.category_id WHERE c.project_id = $1 ORDER BY e.id`,
    [projectId],
  );
  return { categories, items, events };
}

/** An SDK request with an optional key and user agent, answering status and body. */
export async function sdkRequest(
  method: string,
  path: string,
  options: { apiKey?: string; userAgent?: string; body?: unknown; ip?: string } = {},
): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'X-Forwarded-For': options.ip ?? newClientIp(),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.apiKey === undefined ? {} : { 'X-API-Key': options.apiKey }),
      ...(options.userAgent === undefined ? {} : { 'User-Agent': options.userAgent }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

/** `GET /api/in-app-banners/serve/:categoryId`, as the SDK asks for a widget. */
export function serveWidget(categoryId: string, apiKey: string | undefined, userAgent = ANDROID_CHROME_UA): Promise<RawResponse> {
  return sdkRequest('GET', `/api/in-app-banners/serve/${categoryId}`, { apiKey, userAgent });
}

/** `POST /api/in-app-banners/:bannerId/click`, as the SDK reports a tap. */
export function clickWidgetItem(bannerId: string, apiKey: string | undefined, userAgent = IPHONE_SAFARI_UA): Promise<RawResponse> {
  return sdkRequest('POST', `/api/in-app-banners/${bannerId}/click`, { apiKey, userAgent });
}

/** The widgets list row of a category, by its name. */
export function widgetListRow(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
}

/**
 * A text field of the widget detail's dialogs by its label (the labels have no
 * htmlFor): the field inside the label's parent block, colour pickers left out.
 */
export function dialogField(scope: Locator, label: string): Locator {
  return scope
    .locator('label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .locator('..')
    .getByRole('textbox')
    .and(scope.page().locator(':not([type="color"])'));
}

/** A multi-item widget's item card on the detail page, by its title. */
export function widgetItemCard(page: Page, title: string): Locator {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(title, { exact: true }) });
}

/** Picks an option of a Radix select. */
export async function chooseOption(trigger: Locator, option: string): Promise<void> {
  await trigger.click();
  await trigger.page().getByRole('option', { name: option, exact: true }).click();
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

/** Collects the page's uncaught errors and unhandled rejections. */
export function collectPageErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on('pageerror', (error) => seen.push(error.message));
  return seen;
}

// ---- View-as

/**
 * Staff view-as of `tenant`: a super admin (the flag set directly, which is all the
 * guards read) enrols a passkey and signs in to the admin app in a browser of their
 * own, and starts view-as with a reason. Answers the one-time handoff link.
 */
export async function viewAsHandoff(browser: Browser, baseURL: string | undefined, tenant: Pick<Account, 'userId'>): Promise<string> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'inapp-staff', 'Ivo Staff');
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [staff.userId]);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const page = await context.newPage();
    const staffToken = await enrolAndSignInStaff(page, staff);
    const handoff = await adminApi<{ url: string }>(
      'POST',
      `/api/admin/tenants/${tenant.userId}/impersonate`,
      { reason: 'E2E: checking in-app pages read-only' },
      staffToken,
      ip,
    );
    return handoff.url;
  } finally {
    await context.close();
  }
}

/** Opens a view-as handoff link in this tab and waits for the read-only banner. */
export async function openViewAs(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
}

/** The view-as access token the customer app keeps for this tab. */
export async function viewAsTokenOf(page: Page): Promise<string> {
  const stored = await page.evaluate(() => sessionStorage.getItem('chumbaq_impersonation'));
  if (!stored) throw new Error('No view-as session in this tab');
  return (JSON.parse(stored) as { accessToken: string }).accessToken;
}

// ---- Toasts, located by CSS rather than role: an open modal dialog hides the rest of
// the page, toasts included, from the accessibility tree.

function toastItems(page: Page): Locator {
  return page.locator('[aria-label^="Notifications"] li');
}

/** A toast by its exact title, whether or not a dialog is open. */
export function toastWithTitle(page: Page, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return toastItems(page).filter({ has: page.locator('div.text-sm.font-semibold', { hasText: new RegExp(`^${escaped}$`) }) });
}

/** The titles of every toast on screen. */
export async function toastTitles(page: Page): Promise<string[]> {
  return toastItems(page).locator('div.text-sm.font-semibold').allTextContents();
}

/** Closes every toast (with no dialog open) and waits until none is left. */
export async function clearToasts(page: Page): Promise<void> {
  const toasts = toastItems(page);
  for (let tries = 0; tries < 10 && (await toasts.count()) > 0; tries++) {
    await toasts.first().locator('[toast-close]').click({ timeout: 2_000 }).catch(() => {});
  }
  await expect(toasts).toHaveCount(0);
}

// ---- Campaign list and editor (P1: list, layout, templates, content step)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Records `times` SDK events of one type for a device, through the real event route. */
export async function recordEvents(
  p: InAppProject,
  messageId: string,
  deviceFingerprint: string,
  eventType: string,
  times: number,
  buttonId?: string,
): Promise<void> {
  for (let i = 0; i < times; i++) {
    dataOf(await recordInAppEvent(p, { messageId, deviceFingerprint, eventType, ...(buttonId ? { buttonId } : {}) }));
  }
}

/** Waits for a message's denormalised counters (updated after the event route answers). */
export async function waitForCounters(messageId: string, impressions: number, clicks: number): Promise<void> {
  await expect
    .poll(async () => {
      const row = await messageRow(messageId);
      return [Number(row?.total_impressions), Number(row?.total_clicks)];
    })
    .toEqual([impressions, clicks]);
}

/** The value of one of the list's stat cards, by its label. */
export function statValue(page: Page, label: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('p', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) })
    .locator('p.text-2xl');
}

/** A number field of the campaign editor by its label (labels have no htmlFor). */
export function editorNumber(page: Page, label: string): Locator {
  return page
    .locator('label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) })
    .locator('..')
    .getByRole('spinbutton');
}

/** A Radix select of the campaign editor by its label. */
export function editorSelect(page: Page, label: string): Locator {
  return page
    .locator('label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) })
    .locator('..')
    .getByRole('combobox');
}

/** The editor's step pills ("1 Content & Design", ...), by number and label. */
export function stepPill(page: Page, num: number, label: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^${num}\\s*${escapeRegExp(label)}$`) });
}

/** The message-type badge beside the editor's heading. */
export function editorTypeBadge(page: Page): Locator {
  return page.getByRole('heading', { level: 1 }).locator('xpath=following-sibling::*[1]');
}

/** The editor's icon-only back arrow, left of the heading. */
export function editorBackArrow(page: Page): Locator {
  return page.getByRole('heading', { level: 1 }).locator('xpath=ancestor::div[2]/preceding-sibling::button[1]');
}

/** The rows of the CTA Buttons card. */
export function ctaRows(page: Page): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText('CTA Buttons', { exact: true }) })
    .locator('div.rounded-md.border');
}

/** A template gallery card, by the preset's name. */
export function presetCard(page: Page, name: string): Locator {
  return page
    .locator('button[aria-pressed]')
    .filter({ has: page.locator('span.text-sm.font-medium', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) });
}

/** The gallery header's link: "Starting blank" or "Start blank instead". */
export function blankToggle(page: Page): Locator {
  return page.getByRole('button', { name: /^(Starting blank|Start blank instead)$/ });
}

/** Waits for the editor's create POST and answers it. */
export function createPosted(page: Page, projectId: string) {
  return page.waitForResponse((r) => r.url().endsWith(`/api/projects/${projectId}/in-app-messages`) && r.request().method() === 'POST');
}

// ---- Editor steps 2 to 4, editing, detail page (P1)

/** A date-and-time field of the editor's step 4 by its label (no htmlFor, no role). */
export function editorDate(page: Page, label: string): Locator {
  return page
    .locator('label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) })
    .locator('..')
    .locator('input[type="datetime-local"]');
}

/** One of the option cards of steps 2 and 3 ("On Event", "Mixpanel Cohort", ...), by its label. */
export function editorChoice(page: Page, label: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}(\\s|$)`) });
}

/** The editor's scrolling left panel (the steps' fields, not the top bar or the preview). */
export function editorPanel(page: Page): Locator {
  return page.locator('div.overflow-y-auto.p-5');
}

/** The value of one of the detail page's stat cards, by its label. */
export function detailStat(page: Page, label: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('p', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) })
    .locator('p.text-lg');
}

/** A card of the detail page by its title. */
export function cardTitled(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }) });
}

/** Waits for the editor's update PATCH and answers it. */
export function updatePatched(page: Page, projectId: string, id: string) {
  return page.waitForResponse(
    (r) => r.url().endsWith(`/api/projects/${projectId}/in-app-messages/${id}`) && r.request().method() === 'PATCH',
  );
}

// ---- SDK check and events, widgets list (P1)

/** The ids `POST /api/messages/check` delivers for a device with this context (throws unless 2xx). */
export async function deliveredIdsWith(p: InAppProject, deviceFingerprint: string, context: Record<string, unknown>): Promise<string[]> {
  const result = dataOf<{ messages: Array<{ id: string }> }>(await checkMessages(p, deviceFingerprint, { context }));
  return result.messages.map((m) => m.id);
}

/** Waits for a message's three denormalised counters (updated after the event route answers). */
export async function waitForAllCounters(messageId: string, impressions: number, clicks: number, dismissals: number): Promise<void> {
  await expect
    .poll(async () => {
      const row = await messageRow(messageId);
      return [Number(row?.total_impressions), Number(row?.total_clicks), Number(row?.total_dismissals)];
    })
    .toEqual([impressions, clicks, dismissals]);
}

/** The value of one of an expanded widgets-list row's stat cards, by its label. */
export function widgetRowStat(scope: Locator, label: string): Locator {
  return scope
    .locator('div.rounded-lg.border')
    .filter({ has: scope.page().locator('p', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) })
    .locator('p.text-xl');
}

// ---- Widget editor, widget detail and item report (P1)

/** Waits for the next response to `method` on a path ending with `suffix` (or matching it). */
export function apiResponse(page: Page, method: string, suffix: string | RegExp) {
  return page.waitForResponse((r) => {
    const path = new URL(r.url()).pathname;
    return r.request().method() === method && (typeof suffix === 'string' ? path.endsWith(suffix) : suffix.test(path));
  });
}

/** True for the POST that adds an item to a widget (`/banner-categories/:id/banners`). */
export function isItemPost(r: { url(): string; request(): { method(): string } }): boolean {
  return /\/api\/banner-categories\/[0-9a-f-]{36}\/banners$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST';
}

/** A number field by its label, inside `scope` (labels without htmlFor). */
export function labelledNumber(scope: Locator, label: string): Locator {
  return scope
    .locator('label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) })
    .locator('..')
    .getByRole('spinbutton');
}

/** Sets the time of a date-and-time picker (today's date when it had none) and closes it. */
export async function setPickerTime(page: Page, trigger: Locator, time: string): Promise<void> {
  await trigger.click();
  const input = page.locator('[data-slot="popover-content"] input[type="time"]');
  await input.fill(time);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
}

/** Serves a widget `serves` times and records each click in `clicks` (wait with waitForItemCounters). */
export async function widgetTraffic(
  p: InAppProject,
  categoryId: string,
  serves: number,
  clicks: Array<{ bannerId: string; ip?: string }>,
  ips: string[] = [],
): Promise<void> {
  for (let i = 0; i < serves; i++) {
    dataOf(await sdkRequest('GET', `/api/in-app-banners/serve/${categoryId}`, { apiKey: p.sdkKey, ip: ips[i] }));
  }
  for (const click of clicks) {
    dataOf(await sdkRequest('POST', `/api/in-app-banners/${click.bannerId}/click`, { apiKey: p.sdkKey, ip: click.ip }));
  }
}

/** Waits for a widget item's denormalised impression and click counters. */
export async function waitForItemCounters(bannerId: string, impressions: number, clicks: number): Promise<void> {
  await expect
    .poll(async () => {
      const row = await widgetItemRow(bannerId);
      return [Number(row?.impressions), Number(row?.clicks)];
    })
    .toEqual([impressions, clicks]);
}

/** The item titles of a multi-item widget's detail page, in the order shown. */
export function itemTitlesShown(page: Page): Locator {
  return page.getByRole('tabpanel').locator('[data-slot="card"] p.font-medium.truncate');
}

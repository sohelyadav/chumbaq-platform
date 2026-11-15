import { randomBytes } from 'crypto';
import type { Browser, Page } from '@playwright/test';
import { Client } from 'pg';
import { api, apiUrl, createAccount, newClientIp, type Account, type Project } from '../api';
import { newPersonContext } from '../fixtures';
import { adminApi, enrolAndSignInStaff, grantSuperAdmin } from '../admin';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the PROJ specs (projects, selector, shell, dashboard stats). Seeding that
 * the spec is not about goes straight to the e2e database (the name is checked as in
 * seed.ts); everything under test goes through the API or the browser.
 */

export async function withDatabase<T>(work: (client: Client) => Promise<T>): Promise<T> {
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

export async function dbRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withDatabase(async (db) => (await db.query(sql, params)).rows as T[]);
}

export type Role = 'owner' | 'admin' | 'member';

/** A membership as the invite flow would leave it, written directly. */
export async function addMember(projectId: string, userId: string, role: Role, addedBy: string | null = null): Promise<void> {
  await withDatabase((db) =>
    db.query(`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)`, [
      projectId,
      userId,
      role,
      addedBy,
    ]),
  );
}

/** The staff override of an account's project limit (null: the default). */
export async function setProjectLimit(userId: string, limit: number | null): Promise<void> {
  await withDatabase((db) => db.query(`UPDATE users SET project_limit = $2 WHERE id = $1`, [userId, limit]));
}

export async function ownedProjectCount(userId: string): Promise<number> {
  const [row] = await dbRows<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE owner_id = $1`, [userId]);
  return row.n;
}

export interface RawResponse<T = unknown> {
  status: number;
  /** The parsed body (the whole envelope, not only `data`), or null when empty. */
  body: T;
}

/** A request that answers its status and body whatever the status, for refusal cases. */
export async function rawApi<T = any>(
  method: string,
  path: string,
  { token, ip, body, headers }: { token?: string; ip: string; body?: unknown; headers?: Record<string, string> },
): Promise<RawResponse<T>> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/** A project created through the API with any of the create fields. */
export async function createProjectWith(
  account: Account,
  ip: string,
  fields: Record<string, unknown> = {},
): Promise<Project & Record<string, unknown>> {
  return api('POST', '/api/projects', { name: `PROJ ${randomBytes(3).toString('hex')}`, domain: 'e2e.example.test', ...fields }, {
    token: account.accessToken,
    ip,
  });
}

export interface Link {
  id: string;
  shortCode: string;
  title: string | null;
}

export function newShortCode(label = 'pj'): string {
  return `${label}-${randomBytes(5).toString('hex')}`;
}

export async function createLink(
  account: Account,
  ip: string,
  projectId: string,
  { title, shortCode = newShortCode() }: { title?: string; shortCode?: string } = {},
): Promise<Link> {
  return api<Link>(
    'POST',
    `/api/projects/${projectId}/links`,
    { longUrl: 'https://landing.e2e.example.test/welcome', shortCode, ...(title === undefined ? {} : { title }) },
    { token: account.accessToken, ip },
  );
}

/**
 * Click rows for a link, `age` ago (a Postgres interval, '1 hour', '3 days'), shaped as
 * the redirect writes them for a desktop browser. Inserted rather than clicked so their
 * age is exact.
 */
export async function insertClicks(linkId: string, count: number, age: string): Promise<void> {
  await withDatabase(async (db) => {
    for (let i = 0; i < count; i += 1) {
      await db.query(
        `INSERT INTO click_events (link_id, clicked_at, platform, device_type, redirect_type, ip_address, user_agent)
         VALUES ($1, now() - $2::interval, 'desktop', 'desktop', 'web', '10.0.0.1', 'Mozilla/5.0 (Macintosh) e2e')`,
        [linkId, age],
      );
    }
  });
}

/** Whether this install takes payments, as the dashboard learns it. */
export async function billingEnabled(account: Account, ip: string): Promise<boolean> {
  const me = await api<{ billingEnabled?: boolean }>('GET', '/api/auth/me', undefined, { token: account.accessToken, ip });
  return me.billingEnabled === true;
}

/** The API's project-limit refusal (`projectLimitMessage`), and the selector's at-limit line. */
export function projectLimitMessage(limit: number, billingOn: boolean): string {
  return billingOn
    ? `You can have up to ${limit} projects on your plan. Upgrade your plan or delete one.`
    : `You can have up to ${limit} projects. Delete one or contact support to raise the limit.`;
}

export interface ProjectListMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  projectLimit: number;
  billedProjects: number;
  seats?: unknown;
}

export async function listProjects(account: Account, ip: string): Promise<{ data: any[]; meta: ProjectListMeta }> {
  const response = await rawApi<{ data: any[]; meta: ProjectListMeta }>('GET', '/api/projects', { token: account.accessToken, ip });
  if (response.status !== 200) throw new Error(`GET /api/projects answered ${response.status}`);
  return response.body;
}

export const MEMBER_PERMISSIONS = ['project.read', 'messaging.write', 'people.read'];
export const ADMIN_PERMISSIONS = [...MEMBER_PERMISSIONS, 'channels.manage', 'keys.manage', 'members.manage', 'activity.view'];
export const OWNER_PERMISSIONS = [...ADMIN_PERMISSIONS, 'privacy', 'project.admin'];

/**
 * A super admin signed in to the admin app in `page` (granted by the CLI, passkey
 * enrolled on the tab's virtual authenticator). Answers the staff access token.
 */
export async function newStaffSession(page: Page, ip: string): Promise<{ staff: Account; staffToken: string }> {
  const staff = await createAccount(ip, 'proj-staff', 'Pat Staff');
  await grantSuperAdmin(staff.email);
  const staffToken = await enrolAndSignInStaff(page, staff);
  return { staff, staffToken };
}

/**
 * A view-as access token for `tenantId`: the admin API's one-time handoff, exchanged on
 * the customer API as the customer app's /impersonate page does.
 */
export async function viewAsToken(staffToken: string, tenantId: string, ip: string): Promise<string> {
  const handoff = await adminApi<{ url: string }>(
    'POST',
    `/api/admin/tenants/${tenantId}/impersonate`,
    { reason: 'E2E: checking project stats while viewing as' },
    staffToken,
    ip,
  );
  const code = new URL(handoff.url).hash.replace(/^#code=/, '');
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip });
  return session.accessToken;
}

// ---- Project settings page

/**
 * An input on the settings page by its label. The page's labels have no `htmlFor`, so
 * the label is matched inside the field's own `div.space-y-2`.
 */
export function settingsInput(page: Page, label: string) {
  return page
    .locator('div.space-y-2')
    .filter({ has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input');
}

/** A card by its title (shadcn `data-slot="card"`). */
export function cardTitled(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(title, { exact: true }) });
}

/** Toasts (or any live status) containing this text. */
export function toastWith(page: Page, text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

export interface ActivityRow {
  action: string;
  target_label: string | null;
  details: Record<string, unknown> | null;
  actor_user_id: string | null;
}

export async function activityRows(projectId: string): Promise<ActivityRow[]> {
  return dbRows<ActivityRow>(
    `SELECT action, target_label, details, actor_user_id FROM project_activity WHERE project_id = $1 ORDER BY occurred_at, id`,
    [projectId],
  );
}

export interface ProjectRow {
  name: string;
  domain: string | null;
  domain_verified_at: Date | null;
  domain_verification_token: string | null;
  owner_id: string;
  updated_at: Date;
}

export async function projectRow(projectId: string): Promise<ProjectRow | undefined> {
  const [row] = await dbRows<ProjectRow>(
    `SELECT name, domain, domain_verified_at, domain_verification_token, owner_id, updated_at FROM projects WHERE id = $1`,
    [projectId],
  );
  return row;
}

const SEEDABLE_PROJECT_COLUMNS = new Set(['domain', 'domain_verified_at', 'domain_verification_token']);

/** Writes project columns directly, for states the DTO refuses (a platform host) or DNS must give (a proof). */
export async function setProjectColumns(projectId: string, columns: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(columns);
  for (const key of keys) if (!SEEDABLE_PROJECT_COLUMNS.has(key)) throw new Error(`Not a seedable column: ${key}`);
  const assignments = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  await withDatabase((db) => db.query(`UPDATE projects SET ${assignments} WHERE id = $1`, [projectId, ...keys.map((k) => columns[k])]));
}

// ---- Sign-in age and suspension

/** Moves every one of the user's sign-ins back 20 minutes, past the 15-minute recent sign-in window. */
export async function ageSignIn(userId: string): Promise<void> {
  await withDatabase((db) =>
    db.query(`UPDATE auth_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1`, [userId]),
  );
}

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/**
 * An access token whose sign-in is 20 minutes old: signs in, moves the session's
 * `authenticated_at` back (where refresh reads `auth_time` from), and refreshes with the
 * session's cookie.
 */
export async function staleAccessToken(account: Account, ip: string): Promise<string> {
  const headers = { 'Content-Type': 'application/json', 'X-Chumbaq-Client': 'web', 'X-Forwarded-For': ip };
  const login = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (!login.ok) throw new Error(`login answered ${login.status}: ${await login.text()}`);
  const cookie = cookiesFrom(login);
  await ageSignIn(account.userId);
  const refresh = await fetch(apiUrl('/api/auth/refresh'), { method: 'POST', headers: { ...headers, Cookie: cookie } });
  const text = await refresh.text();
  if (!refresh.ok) throw new Error(`refresh answered ${refresh.status}: ${text}`);
  return (JSON.parse(text) as { data: { accessToken: string } }).data.accessToken;
}

/** Suspends an account as far as `JwtStrategy` reads it (on every request). */
export async function suspendAccount(userId: string): Promise<void> {
  await withDatabase((db) => db.query(`UPDATE users SET suspended_at = now(), suspended_reason = 'e2e' WHERE id = $1`, [userId]));
}

// ---- View-as in a customer tab

export interface ViewAs {
  staff: Account;
  staffToken: string;
  /** A fresh one-time handoff link (`APP_URL/impersonate#code=`) for the tenant. */
  handoff(): Promise<string>;
  /** A fresh view-as access token for the tenant, exchanged as the /impersonate page does. */
  token(): Promise<string>;
}

/**
 * A super admin (granted by the CLI) signed in to the admin app in a browser context of
 * their own, ready to start view-as of `tenant` as often as a test needs.
 */
export async function staffForViewAs(browser: Browser, baseURL: string | undefined, tenant: Account): Promise<ViewAs> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'proj-staff', 'Pat Staff');
  await grantSuperAdmin(staff.email);
  const { context } = await newPersonContext(browser, baseURL);
  let staffToken: string;
  try {
    staffToken = await enrolAndSignInStaff(await context.newPage(), staff);
  } finally {
    await context.close();
  }
  const handoff = async () =>
    (
      await adminApi<{ url: string }>(
        'POST',
        `/api/admin/tenants/${tenant.userId}/impersonate`,
        { reason: 'E2E: checking project pages read-only' },
        staffToken,
        ip,
      )
    ).url;
  const token = async () => {
    const code = new URL(await handoff()).hash.replace(/^#code=/, '');
    return (await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip })).accessToken;
  };
  return { staff, staffToken, handoff, token };
}

/** Opens a view-as session of `tenant` in `page` and waits for the selector under the banner. */
export async function openViewAs(page: Page, viewAs: ViewAs, tenant: Account): Promise<void> {
  await page.goto(await viewAs.handoff());
  await page.waitForURL(/\/projects$/);
  await page
    .getByRole('region', { name: 'Impersonation session' })
    .getByText(`Viewing ${tenant.email} as Super Admin · read-only`)
    .waitFor();
}

// ---- Selector, shell and dashboard (P1)

/** A card on the project selector, by the project's name. */
export function projectCard(page: Page, name: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) });
}

/** A stat card on the project dashboard, by the line under its number. */
export function statCard(page: Page, description: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(description, { exact: true }) });
}

/** The project switcher's trigger, the first menu button in the sidebar header. */
export function switcherTrigger(page: Page) {
  return page.locator('[data-sidebar="header"] [data-sidebar="menu-button"]').first();
}

/** Opens the project switcher and answers its menu. */
export async function openSwitcher(page: Page) {
  await switcherTrigger(page).click();
  const menu = page.getByRole('menu');
  await menu.waitFor();
  return menu;
}

/** The selector's create dialog. */
export function createDialog(page: Page) {
  return page.getByRole('dialog', { name: 'New Project' });
}

/** Counts the page's `POST /api/projects` requests from now on. */
export function countProjectCreates(page: Page): { count(): number } {
  let n = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects') n += 1;
  });
  return { count: () => n };
}

export interface ProjectStats {
  totalLinks: number;
  clicks24h: number;
  clicks7d: number;
  clicks30d: number;
  totalConversions: number;
  topLinks: { id: string; title: string | null; shortCode: string; clicks: number }[];
}

export async function projectStats(account: Pick<Account, 'accessToken'>, ip: string, projectId: string): Promise<RawResponse<{ data: ProjectStats }>> {
  return rawApi<{ data: ProjectStats }>('GET', `/api/projects/${projectId}/stats`, { token: account.accessToken, ip });
}

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** A desktop browser opening a short link on the API's root redirect; redirects are not followed. */
export async function openShortLink(shortCode: string, ip: string): Promise<{ status: number; contentType: string; body: string }> {
  const response = await fetch(apiUrl(`/${shortCode}`), {
    redirect: 'manual',
    headers: { 'User-Agent': DESKTOP_UA, 'X-Forwarded-For': ip, Accept: 'text/html' },
  });
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: await response.text() };
}

/** Sets an account's display name directly, for the header's fallbacks. */
export async function setUserName(userId: string, name: string): Promise<void> {
  await withDatabase((db) => db.query(`UPDATE users SET name = $2 WHERE id = $1`, [userId, name]));
}

import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import { api, apiUrl, createAccount, type Account, type Project } from '../api';
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

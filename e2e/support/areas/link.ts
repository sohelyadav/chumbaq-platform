import { randomBytes } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { Client } from 'pg';
import type { Browser, Page } from '@playwright/test';
import { api, apiUrl, createAccount, newClientIp, type Account } from '../api';
import { adminApi, enrolAndSignInStaff, grantSuperAdmin } from '../admin';
import { tokenFromLink } from '../mailbox';
import { assertE2eDatabase, REPO_ROOT, stackEnv } from '../stack';

/**
 * Helpers for the LINK specs: links seeded through the real API, raw requests that
 * answer status and body instead of throwing, SQL reads of the e2e database, project
 * members by invitation, view-as sessions started by a real staff member, and the
 * dashboard's toasts.
 */

// ---- Database

/** Runs `work` on a connection to the lane's e2e database (the name is checked as in reset.ts). */
export async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
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

/** One query, its rows. */
export async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withDb(async (db) => (await db.query(text, params)).rows as T[]);
}

export async function countLinks(projectId: string): Promise<number> {
  const [row] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM links WHERE project_id = $1', [projectId]);
  return Number(row.n);
}

/** Click rows written for a link; the redirect writes them after it has answered, so poll this. */
export async function countClicks(linkId: string): Promise<number> {
  const [row] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM click_events WHERE link_id = $1', [linkId]);
  return Number(row.n);
}

export async function waitForClicks(linkId: string, expected: number, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let seen = -1;
  while (Date.now() < until) {
    seen = await countClicks(linkId);
    if (seen >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Expected ${expected} click rows for link ${linkId}, saw ${seen}`);
}

// ---- Requests

export interface RawResponse<T = any> {
  status: number;
  /** The parsed JSON body (the `{ data }` envelope left as it is), or the text when not JSON. */
  body: T;
  headers: Headers;
}

export interface RawOptions {
  token?: string;
  apiKey?: string;
  ip: string;
  headers?: Record<string, string>;
}

/** A JSON request that answers its status and body whatever the status. */
export async function rawApi<T = any>(method: string, urlPath: string, body: unknown, { token, apiKey, ip, headers }: RawOptions): Promise<RawResponse<T>> {
  const response = await fetch(apiUrl(urlPath), {
    method,
    redirect: 'manual',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, body: parsed as T, headers: response.headers };
}

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** `GET /api/<code>` as a desktop browser would, without following the redirect. */
export async function openShortLink(code: string, ip: string, userAgent = DESKTOP_UA): Promise<RawResponse & { location: string | null }> {
  const response = await rawApi('GET', `/api/${code}`, undefined, { ip, headers: { 'User-Agent': userAgent } });
  return { ...response, location: response.headers.get('location') };
}

/** A short code nobody else in the run will draw: `base` plus four hex characters. */
export function uniqueCode(base: string): string {
  return `${base}-${randomBytes(2).toString('hex')}`.slice(0, 30);
}

export interface SeededLink {
  id: string;
  shortCode: string;
  longUrl: string;
  title: string | null;
  tags: string[] | null;
  iosUrl: string | null;
  androidUrl: string | null;
  deepLinkParams: Record<string, unknown> | null;
  projectId: string;
}

export async function seedLink(account: Account, projectId: string, ip: string, body: Record<string, unknown>): Promise<SeededLink> {
  return api<SeededLink>('POST', `/api/projects/${projectId}/links`, body, { token: account.accessToken, ip });
}

export async function seedVariant(
  account: Account,
  linkId: string,
  ip: string,
  body: { name: string; longUrl: string; weight?: number },
): Promise<{ id: string; name: string; weight: number }> {
  return api('POST', `/api/links/${linkId}/variants`, body, { token: account.accessToken, ip });
}

// ---- Members

/**
 * A new account that joins `projectId` with `role`: invited by the owner through the
 * API and accepted with the link's token, as the mailed link would.
 */
export async function addProjectMember(owner: Account, projectId: string, role: 'member' | 'admin', ip: string): Promise<Account> {
  const person = await createAccount(ip, role, `E2E ${role}`);
  const invite = await api<{ inviteUrl: string }>(
    'POST',
    `/api/projects/${projectId}/invitations`,
    { email: person.email, role },
    { token: owner.accessToken, ip },
  );
  await api('POST', '/api/invitations/accept', { token: tokenFromLink(invite.inviteUrl) }, { token: person.accessToken, ip });
  return person;
}

// ---- View-as

/**
 * A new super admin (granted by the CLI) signs in to the admin app in a context of its
 * own and starts view-as of `tenant`. Answers the one-time handoff link into the
 * customer app.
 */
export async function startViewAs(browser: Browser, baseURL: string | undefined, tenant: Account): Promise<string> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'staff', 'Sam Staff');
  await grantSuperAdmin(staff.email);
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': ip } });
  try {
    const staffToken = await enrolAndSignInStaff(await context.newPage(), staff);
    const handoff = await adminApi<{ url: string }>(
      'POST',
      `/api/admin/tenants/${tenant.userId}/impersonate`,
      { reason: 'E2E: checking links in a read-only session' },
      staffToken,
      ip,
    );
    return handoff.url;
  } finally {
    await context.close();
  }
}

/** A view-as access token for `tenant`, from a handoff spent through the customer API. */
export async function viewAsToken(browser: Browser, baseURL: string | undefined, tenant: Account): Promise<string> {
  const url = await startViewAs(browser, baseURL, tenant);
  const code = /#code=([A-Za-z0-9_-]{43})$/.exec(url)?.[1];
  if (!code) throw new Error('The handoff link carried no code');
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip: newClientIp() });
  return session.accessToken;
}

/**
 * Follows a handoff link in a new tab of a context of its own, as the staff member's
 * click would, and waits for the tenant's project list. The view-as session lives in
 * that tab's sessionStorage, so navigate within the returned page.
 */
export async function openViewAs(browser: Browser, baseURL: string | undefined, handoffUrl: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'X-Forwarded-For': newClientIp() },
  });
  const page = await context.newPage();
  await page.goto(handoffUrl);
  await page.waitForURL(/\/projects$/);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
  return page;
}

// ---- Dashboard

/** A toast in the dashboard's notification list (not its screen-reader copy). */
export function toast(page: Page, title: string) {
  return page
    .getByRole('region', { name: /^Notifications/ })
    .getByRole('listitem')
    .filter({ has: page.getByText(title, { exact: true }) });
}

/** The link detail page's actions menu button (an icon button beside the tabs). */
export function linkActionsButton(page: Page) {
  return page.getByRole('tablist').locator('xpath=..').locator('button[aria-haspopup="menu"]');
}

/** The value next to a label on the link detail page ("Total Clicks", "Platforms", ...). */
export function labelledBlock(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator('xpath=..');
}

// ---- Routes

/**
 * Every single-segment GET route of the API (`/api/<word>`), read from the controllers'
 * source: `main.ts` rewrites a GET of `/<word>` to `/api/<word>`, where the real route
 * wins over the short-link redirect, so each such word must be a reserved short code.
 */
export function singleSegmentGetRoutes(): string[] {
  const root = path.join(REPO_ROOT, 'apps/api/src');
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith('.controller.ts'));
  const words = new Set<string>();
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const part of source.split(/(?=@Controller\()/)) {
      const controller = /^@Controller\(\s*(?:['"]([^'"]*)['"]|\{[^}]*path:\s*['"]([^'"]*)['"][^}]*\})?\s*\)/.exec(part);
      if (!controller) continue;
      const base = controller[1] ?? controller[2] ?? '';
      for (const get of part.matchAll(/@Get\(\s*(?:['"]([^'"]*)['"])?\s*\)/g)) {
        const segments = [...base.split('/'), ...(get[1] ?? '').split('/')].filter(Boolean);
        if (segments.length === 1 && !/[:*]/.test(segments[0])) words.add(segments[0]);
      }
    }
  }
  return [...words].sort();
}

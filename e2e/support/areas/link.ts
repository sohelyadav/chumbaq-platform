import { randomBytes } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { request as httpRequest } from 'http';
import path from 'path';
import { Client } from 'pg';
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
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

// ---- Redirect and analytics (link-p0-02)

/** Windows Chrome, as a desktop visitor's browser sends it. */
export const WINDOWS_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** iPhone Safari and Pixel Chrome, the user agents mobileContext gives its phones. */
export const IPHONE_UA = devices['iPhone 15'].userAgent;
export const PIXEL_UA = devices['Pixel 7'].userAgent;

/** Polls `read` until `done` holds for its answer, or throws with the last answer. */
export async function waitUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T = await read();
  while (!done(last)) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
  }
  return last;
}

export async function countTouchpoints(linkId: string): Promise<number> {
  const [row] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM touchpoints WHERE link_id = $1', [linkId]);
  return Number(row.n);
}

export async function waitForTouchpoints(linkId: string, expected: number): Promise<void> {
  await waitUntil(() => countTouchpoints(linkId), (n) => n >= expected, `${expected} touchpoints of link ${linkId}`);
}

/** A conversion as the SDK records it (`POST /api/conversions` with the project's key). */
export async function recordConversion(apiKey: string, linkId: string, eventType: string, ip: string): Promise<void> {
  await api('POST', '/api/conversions', { eventType, linkId }, { apiKey, ip });
}

/** Suspends or reactivates an account the way the staff action leaves it: `users.suspended_at`. */
export async function setSuspended(userId: string, suspended: boolean): Promise<void> {
  await sql(`UPDATE users SET suspended_at = ${suspended ? 'now()' : 'NULL'} WHERE id = $1`, [userId]);
}

/** `link.changed` / `content.deleted` entries of a project, oldest first. */
export async function activityEntries(projectId: string, action: string): Promise<{ target_label: string | null; details: Record<string, unknown> | null }[]> {
  return sql('SELECT target_label, details FROM project_activity WHERE project_id = $1 AND action = $2 ORDER BY occurred_at, id', [projectId, action]);
}

/**
 * Answers every request to the given hosts in the browser (deep links, stores, the
 * destination) with `status`, so nothing leaves the machine: 204 keeps the current
 * page, as an app that is not installed does; 200 serves a stand-in page.
 */
export async function stubHosts(target: Page | BrowserContext, hosts: string[], status: 200 | 204 = 204): Promise<string[]> {
  const seen: string[] = [];
  for (const host of hosts) {
    await target.route(`https://${host}/**`, async (route) => {
      seen.push(route.request().url());
      await route.fulfill(status === 204 ? { status: 204 } : { status: 200, contentType: 'text/html', body: '<!doctype html><title>Stand-in</title><p>Stand-in page</p>' });
    });
  }
  return seen;
}

/** RFC 4180 rows: quoted cells with doubled quotes, commas and newlines inside quotes. */
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
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** One error body without its per-request fields, for comparing refusals. */
export function refusalShape(body: Record<string, unknown>): Record<string, unknown> {
  const { timestamp: _t, path: _p, ...rest } = body;
  return rest;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
}

/**
 * Serves the dashboard host's `/redirect/<code>` hop from the test: the real response
 * is fetched without following it and recorded; a redirect is then handed to the page
 * as a tiny page that navigates to its Location, so `stubHosts` can answer the
 * destination. (Chromium follows a redirect, even a fulfilled one, without routing it,
 * which would reach the real destination host.) Anything else is passed on as it is.
 */
export async function routeRedirectHop(target: Page | BrowserContext): Promise<RedirectHop[]> {
  const hops: RedirectHop[] = [];
  await target.route('**/redirect/**', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()['location'] ?? null;
    hops.push({ url: route.request().url(), status: response.status(), location });
    if (response.status() >= 300 && response.status() < 400 && location) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><script>location.replace(${JSON.stringify(location)})</script>`,
      });
    } else {
      await route.fulfill({ response });
    }
  });
  return hops;
}

// ---- Preview, association files, deferred match, conversions (link-p0-03)

/** A new API key of the project: `{ id, fullKey }`. `permissions: ['privacy']` makes a server-only privacy key. */
export async function newApiKey(
  account: Account,
  projectId: string,
  ip: string,
  body: { name?: string; permissions?: string[] } = {},
): Promise<{ id: string; fullKey: string }> {
  const created = await api<{ apiKey: { id: string }; fullKey: string }>(
    'POST',
    `/api/projects/${projectId}/api-keys`,
    { name: 'E2E link key', ...body },
    { token: account.accessToken, ip },
  );
  return { id: created.apiKey.id, fullKey: created.fullKey };
}

export interface AppFields {
  domain?: string | null;
  verified?: boolean;
  iosTeamId?: string | null;
  iosBundleId?: string | null;
  iosAppStoreUrl?: string | null;
  androidPackageName?: string | null;
  androidSha256Fingerprints?: string | null;
}

const APP_COLUMNS: Record<Exclude<keyof AppFields, 'verified'>, string> = {
  domain: 'domain',
  iosTeamId: 'ios_team_id',
  iosBundleId: 'ios_bundle_id',
  iosAppStoreUrl: 'ios_app_store_url',
  androidPackageName: 'android_package_name',
  androidSha256Fingerprints: 'android_sha256_fingerprints',
};

/**
 * Sets a project's app and domain fields in SQL, as a proved domain leaves them
 * (`verified: true` stamps `domain_verified_at`, false clears it). Proving a domain needs
 * a DNS record, and the API refuses the platform's own hosts as a domain.
 */
export async function setProjectApp(projectId: string, fields: AppFields): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [projectId];
  for (const [key, column] of Object.entries(APP_COLUMNS)) {
    const value = fields[key as keyof typeof APP_COLUMNS];
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (fields.verified !== undefined) sets.push(`domain_verified_at = ${fields.verified ? 'now()' : 'NULL'}`);
  if (!sets.length) return;
  await sql(`UPDATE projects SET ${sets.join(', ')} WHERE id = $1`, values);
}

/** A host name nobody else in the run uses, under example.test. */
export function uniqueHost(label: string): string {
  return `${label}-${randomBytes(3).toString('hex')}.example.test`;
}

export interface WellKnownAnswer {
  status: number;
  contentType: string | undefined;
  body: unknown;
  text: string;
}

/**
 * `GET /.well-known/<file>` on the API with the given Host header (fetch will not send
 * one of its own choosing), as a phone checking the domain would. Answers the status,
 * the content type and the parsed body.
 */
export async function wellKnown(file: 'apple-app-site-association' | 'assetlinks.json', host: string, ip: string): Promise<WellKnownAnswer> {
  // The stack's API listens on plain http (E2E_API_URL).
  const url = new URL(apiUrl(`/.well-known/${file}`));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: { Host: host, 'X-Forwarded-For': ip },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // not JSON: keep the text
          }
          resolve({ status: response.statusCode ?? 0, contentType: response.headers['content-type'], body, text });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

export interface ClickRow {
  id: string;
  matched: boolean;
  platform: string;
  redirect_type: string;
  ip_address: string;
}

/** The click rows of a link, oldest first. */
export async function clicksOf(linkId: string): Promise<ClickRow[]> {
  return sql<ClickRow & Record<string, unknown>>(
    'SELECT id, matched, platform, redirect_type, ip_address FROM click_events WHERE link_id = $1 ORDER BY clicked_at, id',
    [linkId],
  );
}

/** Opens the link once from `ip` and waits for its click row; answers that row's id. */
export async function clickFrom(link: { id: string; shortCode: string }, ip: string, userAgent = DESKTOP_UA): Promise<string> {
  const before = (await clicksOf(link.id)).map((row) => row.id);
  const response = await openShortLink(link.shortCode, ip, userAgent);
  if (response.status !== 200 && response.status !== 302) throw new Error(`Opening ${link.shortCode} answered ${response.status}`);
  const rows = await waitUntil(() => clicksOf(link.id), (all) => all.length > before.length, `a click on ${link.shortCode}`);
  return rows.find((row) => !before.includes(row.id))!.id;
}

/** Moves a click back in time, as if it had been made `minutes` ago. */
export async function backdateClick(clickId: string, minutes: number): Promise<void> {
  await sql('UPDATE click_events SET clicked_at = now() - make_interval(mins => $2) WHERE id = $1', [clickId, minutes]);
}

/** `POST /api/deferred/match` as an SDK sends it, from `ip`. */
export async function deferredMatch(apiKey: string | undefined, ip: string, body: unknown): Promise<RawResponse> {
  return rawApi('POST', '/api/deferred/match', body, { apiKey, ip });
}

/** The conversion rows of a link, oldest first. */
export async function conversionRows(linkId: string): Promise<Record<string, unknown>[]> {
  return sql(
    'SELECT id, link_id, click_event_id, event_type, external_user_id, metadata FROM conversion_events WHERE link_id = $1 ORDER BY converted_at, id',
    [linkId],
  );
}

/** A whole-person objection, as the owner's dashboard action leaves it. */
export async function seedObjection(projectId: string, externalUserId: string): Promise<void> {
  await sql('INSERT INTO tracking_objections (project_id, external_user_id) VALUES ($1, $2)', [projectId, externalUserId]);
}

export interface BulkResult {
  total: number;
  created: number;
  errors: { row: number; error: string }[];
}

/** Uploads a CSV to the bulk import route as the page does (one `file` part, text/csv). */
export async function bulkImport(account: Account, projectId: string, ip: string, csv: string): Promise<BulkResult> {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'links.csv');
  const response = await fetch(apiUrl(`/api/projects/${projectId}/links/bulk`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}`, 'X-Forwarded-For': ip, 'X-Chumbaq-Client': 'web' },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bulk import answered ${response.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { data: BulkResult }).data;
}

/** The project's links as stored, by destination. */
export async function storedLinks(projectId: string): Promise<{ id: string; short_code: string; long_url: string; ios_url: string | null }[]> {
  return sql('SELECT id, short_code, long_url, ios_url FROM links WHERE project_id = $1 ORDER BY long_url', [projectId]);
}

// ---- Links list, create and bulk import (link-p1-01)

/**
 * Uploads to the bulk import route and answers status and body whatever the status.
 * `file: null` sends a multipart body with no file part.
 */
export async function rawBulkImport(
  token: string | undefined,
  projectId: string,
  ip: string,
  file: { content: string | Buffer; mimeType?: string; name?: string } | null,
): Promise<RawResponse> {
  const form = new FormData();
  if (file) {
    const bytes = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
    form.append('file', new Blob([new Uint8Array(bytes)], { type: file.mimeType ?? 'text/csv' }), file.name ?? 'links.csv');
  } else {
    form.append('note', 'no file here');
  }
  const response = await fetch(apiUrl(`/api/projects/${projectId}/links/bulk`), {
    method: 'POST',
    headers: { 'X-Forwarded-For': ip, 'X-Chumbaq-Client': 'web', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, body, headers: response.headers };
}

/** An existing account joins `projectId` with `role`: invited by the owner and accepted with the link's token. */
export async function joinProject(owner: Account, projectId: string, person: Account, role: 'member' | 'admin', ip: string): Promise<void> {
  const invite = await api<{ inviteUrl: string }>(
    'POST',
    `/api/projects/${projectId}/invitations`,
    { email: person.email, role },
    { token: owner.accessToken, ip },
  );
  await api('POST', '/api/invitations/accept', { token: tokenFromLink(invite.inviteUrl) }, { token: person.accessToken, ip });
}

/** `n` links seeded one after another, titled `<prefix> 1` .. `<prefix> n`. */
export async function seedLinks(account: Account, projectId: string, ip: string, n: number, prefix = 'Bulk'): Promise<SeededLink[]> {
  const links: SeededLink[] = [];
  for (let i = 1; i <= n; i++) {
    links.push(await seedLink(account, projectId, ip, { longUrl: `https://example.com/${prefix.toLowerCase().replace(/\W+/g, '-')}/${i}`, title: `${prefix} ${i}` }));
  }
  return links;
}

/** The body rows of the dashboard's links table. */
export function linkRows(page: Page) {
  return page.getByRole('table').locator('tbody').getByRole('row');
}

/** The access token of the view-as session a tab holds (its sessionStorage record). */
export async function viewAsTokenFrom(page: Page): Promise<string> {
  const raw = await page.evaluate(() => sessionStorage.getItem('chumbaq_impersonation'));
  const token = raw ? (JSON.parse(raw) as { accessToken?: string }).accessToken : undefined;
  if (!token) throw new Error('The tab holds no view-as session');
  return token;
}

// ---- Detail page, variants, edit, delete and the analytics API (link-p1-02)

/** `GET /api/<code>` with extra request headers (a Referer, a User-Agent), without following the redirect. */
export async function openShortLinkWith(code: string, ip: string, headers: Record<string, string>): Promise<RawResponse & { location: string | null }> {
  const response = await rawApi('GET', `/api/${code}`, undefined, { ip, headers: { 'User-Agent': DESKTOP_UA, ...headers } });
  return { ...response, location: response.headers.get('location') };
}

/** One stat tile of the link detail page ("Total Clicks", "Installs", ...): the bordered box around label and value. */
export function statTile(page: Page, label: string) {
  return labelledBlock(page, label).locator('xpath=..');
}

/** The rows of one bar list of the Devices & Browsers card ("Operating System", "Browser"). */
export function barListRows(page: Page, heading: string) {
  return page.getByRole('heading', { name: heading, exact: true }).locator('xpath=..').locator('div.space-y-3 > div');
}

/** The width in pixels of a PNG given as a `data:image/png;base64,` URL (its IHDR chunk). */
export function pngWidth(dataUrl: string): number {
  const bytes = pngBytes(dataUrl);
  return bytes.readUInt32BE(16);
}

/** The bytes of a `data:image/png;base64,` URL. */
export function pngBytes(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error(`Not a PNG data URL: ${dataUrl.slice(0, 40)}`);
  return Buffer.from(match[1], 'base64');
}

/** Answers the map's tile requests in the browser with an empty response, so nothing leaves the machine. */
export async function stubMapTiles(target: Page | BrowserContext): Promise<void> {
  await target.route('https://tiles.stadiamaps.com/**', (route) => route.fulfill({ status: 204 }));
}

/** The variant rows of the A/B Testing tab, each named by its variant's name. */
export function variantRow(page: Page, name: string) {
  return page.locator('div.rounded-lg.border').filter({ has: page.locator('p.font-medium', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

/** A `datetime-local` input value (local time, minutes) for a moment. */
export function datetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---- Redirect edges, deferred match races, suspension and expiry zones (link-p1-03)

/** Touchpoints for a person, as the SDK's touchpoint ingest leaves them, `minutesAgo` each. */
export async function seedTouchpoints(projectId: string, distinctId: string, minutesAgo: number[]): Promise<void> {
  for (const minutes of minutesAgo) {
    await sql(
      `INSERT INTO touchpoints (project_id, distinct_id, touchpoint_type, channel, utm_source, touched_at)
       VALUES ($1, $2, 'link_click', 'newsletter', 'newsletter', now() - make_interval(mins => $3))`,
      [projectId, distinctId, minutes],
    );
  }
}

/** A click row written straight to the table, for fields no real request produces (a city without coordinates). */
export async function seedClickRow(linkId: string, fields: Record<string, string | number | null>): Promise<void> {
  const row: Record<string, string | number | null> = { platform: 'windows', device_type: 'desktop', redirect_type: 'web_fallback', ...fields };
  const columns = Object.keys(row);
  await sql(
    `INSERT INTO click_events (link_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})`,
    [linkId, ...columns.map((column) => row[column])],
  );
}

export interface ExtraApi {
  url: string;
  stop(): Promise<void>;
}

/**
 * A second customer API on the lane's database and secrets with `TZ` set, for the cases
 * about how a zone-less expiry is read. On the first free port from the API port + 20 to
 * + 29 (nothing else in the harness uses that range); a process that could not bind its
 * port is not taken for the answer of another.
 */
export async function startApiInZone(timeZone: string): Promise<ExtraApi> {
  const { portInUse, run, stopAll, waitForUrl } = await import('../processes');
  const { appEnvironment, runSecrets, stackPorts } = await import('../stack');
  const ports = stackPorts();
  for (let port = ports.api + 20; port <= ports.api + 29; port++) {
    if (await portInUse(port)) continue;
    const env = { ...process.env, ...appEnvironment(runSecrets(), ports), API_PORT: String(port), TZ: timeZone };
    const started = run(`api-tz-${timeZone.replace(/\W+/g, '-')}-${port}`, 'node', ['dist/main'], { cwd: path.join(REPO_ROOT, 'apps/api'), env });
    try {
      await waitForUrl(started, `http://127.0.0.1:${port}/api/health`);
    } catch {
      await stopAll([started]);
      continue;
    }
    if (started.child.exitCode !== null || started.child.signalCode !== null) continue;
    return { url: `http://localhost:${port}`, stop: () => stopAll([started]) };
  }
  throw new Error(`No free port for an API in ${timeZone}`);
}

/** Sends every API request the page makes to another API, as the dev server's proxy would. */
export async function routeApiTo(target: Page | BrowserContext, base: string): Promise<void> {
  await target.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${base}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    },
  );
}

/** `GET <base>/api/<code>` on another API, as a desktop browser, without following the redirect. */
export async function openShortLinkOn(base: string, code: string, ip: string): Promise<{ status: number; location: string | null; body: any }> {
  const response = await fetch(`${base}/api/${code}`, { redirect: 'manual', headers: { 'User-Agent': DESKTOP_UA, 'X-Forwarded-For': ip } });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, location: response.headers.get('location'), body };
}

/**
 * Creates a link with a custom code another spec may hold for a moment (a word it also
 * tries, then gives back): retries while the code is taken, for up to `timeoutMs`.
 */
export async function claimCustomCode(account: Account, projectId: string, ip: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<RawResponse> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const answer = await rawApi('POST', `/api/projects/${projectId}/links`, body, { token: account.accessToken, ip });
    const taken = answer.status === 409 && /is already taken$/.test(String(answer.body?.message));
    if (!taken || Date.now() > until) return answer;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Removes a project's links and their released codes, so a shared word is free again for other specs. */
export async function giveBackCodes(projectId: string): Promise<void> {
  await sql('DELETE FROM links WHERE project_id = $1', [projectId]);
  await sql('DELETE FROM released_short_codes WHERE project_id = $1', [projectId]);
}

import { createHmac, randomBytes } from 'crypto';
import { devices, type Browser, type Locator, type Page, type Response as PageResponse } from '@playwright/test';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff, grantSuperAdmin } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { newPersonContext } from '../fixtures';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the analytics specs (ANLY): the Analytics, Attribution, Touchpoints and
 * Events pages and their read routes, SDK event ingest, and do-not-track around it.
 * Clicks go through the real redirect; touchpoints that name a person are seeded with
 * SQL (no API path writes a distinct id on one), and attribution comes from a real
 * conversion posted with the project's SDK key.
 */

export const PROJECT_NOT_FOUND = 'Project not found';
export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---- Database (the lane's e2e database; the name is checked as in reset.ts)

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

export async function sql<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withDb(async (db) => (await db.query(text, params)).rows as T[]);
}

export async function countEvents(projectId: string): Promise<number> {
  const [row] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM user_events WHERE project_id = $1', [projectId]);
  return Number(row.n);
}

export async function deviceByFingerprint(projectId: string, fingerprint: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM device_identities WHERE project_id = $1 AND device_fingerprint = $2`, [projectId, fingerprint]);
  return row;
}

// ---- Requests that answer the status and body whatever the status

export interface RawResponse {
  status: number;
  body: any;
}

export interface RawOptions {
  ip?: string;
  token?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export async function raw(method: string, path: string, body: unknown, { ip, token, apiKey, headers }: RawOptions = {}): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    redirect: 'manual',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip ?? newClientIp(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      ...headers,
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

/** A GET as a person (their token and their own client address). */
export function getAs(person: Person | null, path: string): Promise<RawResponse> {
  return raw('GET', path, undefined, person ? { token: person.accessToken, ip: person.ip } : {});
}

// ---- People and projects

export interface Person extends Account {
  ip: string;
}

export async function newPerson(label: string, name = 'Ana Lytics'): Promise<Person> {
  const ip = newClientIp();
  return { ...(await createAccount(ip, label, name)), ip };
}

/** Adds someone to a project with a role, as an accepted invitation leaves it. */
export async function addMember(projectId: string, person: Pick<Account, 'userId'>, role: 'owner' | 'admin' | 'member', addedBy: Pick<Account, 'userId'>): Promise<void> {
  await sql(
    `INSERT INTO project_members (project_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, clock_timestamp())`,
    [projectId, person.userId, role, addedBy.userId],
  );
}

export interface RoleSet {
  owner: Person;
  admin: Person;
  member: Person;
  outsider: Person;
  project: Project;
  /** A project of the outsider's, which none of the others may name. */
  foreign: Project;
}

/** A project with an owner, an admin and a member, plus an outsider with a project of their own. */
export async function roleSet(label: string): Promise<RoleSet> {
  const [owner, admin, member, outsider] = await Promise.all([
    newPerson(`${label}-owner`, 'Oona Owner'),
    newPerson(`${label}-admin`, 'Adi Admin'),
    newPerson(`${label}-member`, 'Mo Member'),
    newPerson(`${label}-outsider`, 'Xan Outsider'),
  ]);
  const project = await createProject(owner, owner.ip, `${label} project`);
  const foreign = await createProject(outsider, outsider.ip, `${label} foreign`);
  await addMember(project.id, admin, 'admin', owner);
  await addMember(project.id, member, 'member', owner);
  return { owner, admin, member, outsider, project, foreign };
}

export interface SdkProject {
  owner: Person;
  project: Project;
  sdkKey: string;
}

export async function sdkProject(label: string, owner?: Person): Promise<SdkProject> {
  const who = owner ?? (await newPerson(label));
  const project = await createProject(who, who.ip, `${label} ${randomBytes(2).toString('hex')}`);
  return { owner: who, project, sdkKey: await createApiKey(who, project.id, who.ip) };
}

export function uniqueId(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}`;
}

// ---- Links and clicks

export interface SeededLink {
  id: string;
  shortCode: string;
  title: string | null;
}

export async function seedLink(owner: Person, projectId: string, label: string): Promise<SeededLink> {
  const shortCode = `${label}-${randomBytes(3).toString('hex')}`.slice(0, 30);
  return api<SeededLink>(
    'POST',
    `/api/projects/${projectId}/links`,
    { longUrl: `https://example.com/${label}`, title: `Link ${label}`, shortCode },
    { token: owner.accessToken, ip: owner.ip },
  );
}

/** Opens a short link on the API's root redirect as a browser would, without following it. */
export async function click(code: string, ip: string, extra: { userAgent?: string; referer?: string; query?: string } = {}): Promise<number> {
  const response = await fetch(apiUrl(`/${code}${extra.query ?? ''}`), {
    redirect: 'manual',
    headers: {
      'User-Agent': extra.userAgent ?? DESKTOP_UA,
      'X-Forwarded-For': ip,
      ...(extra.referer ? { Referer: extra.referer } : {}),
    },
  });
  await response.text();
  return response.status;
}

/** Clicks are written after the redirect answers: waits until the link has `expected` of them. */
export async function waitForLinkClicks(linkId: string, expected: number, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let seen = -1;
  while (Date.now() < until) {
    const [row] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM click_events WHERE link_id = $1', [linkId]);
    seen = Number(row.n);
    if (seen >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Expected ${expected} clicks on link ${linkId}, saw ${seen}`);
}

// ---- Touchpoints and attribution

export interface TouchpointSeed {
  distinctId: string;
  touchpointType?: string;
  channel?: string | null;
  campaign?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  platform?: string | null;
  /** When it happened; the column has no time zone, so the API's local time is what it holds. */
  touchedAt: Date;
}

/** Inserts touchpoints naming a person (no API route writes a distinct id on one). Answers their ids. */
export async function seedTouchpoints(projectId: string, seeds: TouchpointSeed[]): Promise<string[]> {
  return withDb(async (db) => {
    const ids: string[] = [];
    for (const seed of seeds) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO touchpoints (project_id, distinct_id, touchpoint_type, channel, campaign, utm_source, utm_medium, platform, touched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          projectId,
          seed.distinctId,
          seed.touchpointType ?? 'link_click',
          seed.channel ?? null,
          seed.campaign ?? null,
          seed.utmSource ?? null,
          seed.utmMedium ?? null,
          seed.platform ?? null,
          seed.touchedAt,
        ],
      );
      ids.push(rows[0].id);
    }
    return ids;
  });
}

export function daysAgo(days: number, at = new Date()): Date {
  return new Date(at.getTime() - days * 24 * 60 * 60 * 1000);
}

/** A conversion through the SDK route, which runs every attribution model in the background. */
export async function postConversion(p: SdkProject, shortCode: string, externalUserId: string, eventType = 'signup'): Promise<string> {
  const conversion = await api<{ id: string }>(
    'POST',
    '/api/conversions',
    { projectId: p.project.id, shortCode, eventType, externalUserId },
    { apiKey: p.sdkKey, ip: p.owner.ip },
  );
  return conversion.id;
}

export interface AttributionRow {
  model: string;
  distinctId: string;
  touchpointCount: number;
  lookbackDays: number;
  creditSplits: Array<{ touchpointId: string; channel: string; campaign: string; credit: number; touchedAt: string }>;
}

/** Polls the conversion's attribution until the four models are stored. */
export async function waitForAttribution(p: SdkProject, conversionId: string, timeoutMs = 20_000): Promise<AttributionRow[]> {
  const until = Date.now() + timeoutMs;
  let rows: AttributionRow[] = [];
  while (Date.now() < until) {
    rows = await api<AttributionRow[]>('GET', `/api/projects/${p.project.id}/conversions/${conversionId}/attribution`, undefined, {
      token: p.owner.accessToken,
      ip: p.owner.ip,
    });
    if (rows.length >= 4) return rows;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Attribution for ${conversionId} has ${rows.length} of 4 models`);
}

// ---- SDK ingest and identify

export function trackEvent(p: SdkProject, body: Record<string, unknown>, apiKey = p.sdkKey): Promise<RawResponse> {
  return raw('POST', '/api/events/track', { projectId: p.project.id, ...body }, { apiKey, ip: p.owner.ip });
}

export async function identitySecret(p: SdkProject): Promise<string> {
  const { secret } = await api<{ secret: string }>('GET', `/api/projects/${p.project.id}/identity-secret`, undefined, {
    token: p.owner.accessToken,
    ip: p.owner.ip,
  });
  return secret;
}

export function userHash(secret: string, externalUserId: string): string {
  return createHmac('sha256', secret).update(externalUserId, 'utf8').digest('hex');
}

/** The SDK's identify through the real route; answers the stored device row. */
export async function identify(p: SdkProject, body: Record<string, unknown>): Promise<Record<string, any>> {
  return api('POST', '/api/identity/identify', { projectId: p.project.id, platform: 'web', ...body }, { apiKey: p.sdkKey, ip: p.owner.ip });
}

// ---- View-as

/**
 * Staff view-as of `tenant`, the real way: a super admin granted by the CLI enrols a
 * passkey in the admin app in a browser of their own and starts view-as with a
 * reason. Answers the one-time handoff link (`APP_URL/impersonate#code=`).
 */
export async function viewAsHandoff(browser: Browser, baseURL: string | undefined, tenant: Account): Promise<string> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'anly-staff', 'Sid Staff');
  await grantSuperAdmin(staff.email);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const page = await context.newPage();
    const staffToken = await enrolAndSignInStaff(page, staff);
    const handoff = await adminApi<{ url: string }>(
      'POST',
      `/api/admin/tenants/${tenant.userId}/impersonate`,
      { reason: 'E2E: checking analytics pages' },
      staffToken,
      ip,
    );
    return handoff.url;
  } finally {
    await context.close();
  }
}

/** Opens a handoff link in this tab, waits for the read-only banner, and answers the view-as access token. */
export async function openViewAs(page: Page, url: string): Promise<string> {
  // The page reloads as soon as the exchange answers, so the body is read on the way
  // through rather than from the finished response.
  let token: string | undefined;
  await page.route('**/api/auth/impersonation/exchange', async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    if (response.ok()) token = (JSON.parse(text) as { data: { accessToken: string } }).data.accessToken;
    await route.fulfill({ response, body: text });
  });
  await page.goto(url);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
  await page.unroute('**/api/auth/impersonation/exchange');
  if (!token) throw new Error('The view-as exchange did not answer a token');
  return token;
}

// ---- Page helpers

/** Records every dialog (an injected alert running) and dismisses it. */
export function collectDialogs(page: Page): string[] {
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  return dialogs;
}

/** The number under a stat card's label on the Analytics page. */
export function statValue(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=following-sibling::p[1]');
}

/** A card whose title starts with `title` (shadcn cards carry data-slot). */
export function cardTitled(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }) });
}

/** The cells of each body row of a table, as text. */
export async function bodyRows(table: Locator): Promise<string[][]> {
  return table.locator('tbody tr').evaluateAll((rows) =>
    rows.map((row) => Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent ?? '').trim())),
  );
}

/** Script elements in the page whose text names `needle` (an injected script would). */
export async function scriptsContaining(page: Page, needle: string): Promise<number> {
  return page.evaluate((text) => Array.from(document.querySelectorAll('script')).filter((s) => (s.textContent ?? '').includes(text)).length, needle);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** date-fns `MMM d, HH:mm:ss` in this machine's zone (the browser's, here). */
export function eventTimeLabel(at: Date): string {
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Waits for a page response whose URL path is exactly `path` (query ignored). */
export function responseFor(page: Page, path: string): Promise<PageResponse> {
  return page.waitForResponse((response) => new URL(response.url()).pathname === path);
}

// ---- P1 helpers (anly-p1-01): links, clicks and conversions set up for one page

/** iPhone Safari and Pixel Chrome, as Playwright's device profiles report them. */
export const IPHONE_UA = devices['iPhone 15'].userAgent;
export const ANDROID_UA = devices['Pixel 7'].userAgent;

/** A link with or without a title (`seedLink` always sets one). */
export async function createLink(owner: Person, projectId: string, label: string, title: string | null): Promise<SeededLink> {
  const shortCode = `${label}-${randomBytes(3).toString('hex')}`.slice(0, 30);
  return api<SeededLink>(
    'POST',
    `/api/projects/${projectId}/links`,
    { longUrl: `https://example.com/${label}`, shortCode, ...(title === null ? {} : { title }) },
    { token: owner.accessToken, ip: owner.ip },
  );
}

/** `n` desktop clicks, each from an address of its own, and waits until all are stored. */
export async function clickTimes(link: SeededLink, n: number, extra: { userAgent?: string; referer?: string; query?: string } = {}): Promise<void> {
  for (let i = 0; i < n; i += 1) await click(link.shortCode, newClientIp(), extra);
}

/** Moves a link's clicks to the given times, oldest stored first; answers the ids moved. */
export async function backdateClicks(linkId: string, times: Date[]): Promise<string[]> {
  const rows = await sql<{ id: string }>('SELECT id FROM click_events WHERE link_id = $1 ORDER BY clicked_at, id', [linkId]);
  if (rows.length < times.length) throw new Error(`Link ${linkId} has ${rows.length} clicks, ${times.length} to move`);
  for (let i = 0; i < times.length; i += 1) {
    await sql('UPDATE click_events SET clicked_at = $2 WHERE id = $1', [rows[i].id, times[i]]);
  }
  return rows.slice(0, times.length).map((row) => row.id);
}

/** Waits until the project has `expected` touchpoints (the redirect writes them after answering). */
export async function waitForTouchpoints(projectId: string, expected: number, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let seen = -1;
  while (Date.now() < until) {
    const [row] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM touchpoints WHERE project_id = $1', [projectId]);
    seen = Number(row.n);
    if (seen >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Expected ${expected} touchpoints in ${projectId}, saw ${seen}`);
}

/** `POST /api/conversions` with the SDK key, any body, answering status and body. */
export function conversionRaw(p: SdkProject, body: Record<string, unknown>): Promise<RawResponse> {
  return raw('POST', '/api/conversions', { projectId: p.project.id, ...body }, { apiKey: p.sdkKey, ip: p.owner.ip });
}

/** The Click Trends card (its title is a plain paragraph, not a card title). */
export function clickTrendsCard(page: Page): Locator {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText('Click Trends', { exact: true }) });
}

/** The x-axis labels a Recharts chart drew inside `scope`. */
export function xAxisLabels(scope: Locator): Locator {
  return scope.locator('.recharts-xAxis .recharts-cartesian-axis-tick-value');
}

/** date-fns `MMM d` in this machine's zone (the browser's, here). */
export function dayLabel(at: Date): string {
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** Local midnight `days` days ago, plus `hour` hours. */
export function localDay(days: number, hour = 12): Date {
  const at = daysAgo(days);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), hour, 0, 0);
}

/** The bars under a heading in Devices & Browsers ("Operating System", "Browser") as [name, "count (pct%)"]. */
export async function barRows(page: Page, heading: string): Promise<string[][]> {
  const list = cardTitled(page, 'Devices & Browsers').locator('h4', { hasText: heading }).locator('xpath=following-sibling::div[1]');
  return list.locator(':scope > div').evaluateAll((rows) =>
    rows.map((row) => Array.from(row.querySelectorAll(':scope > div:first-child > span')).map((span) => (span.textContent ?? '').trim())),
  );
}

/** Whether a range or model button is the selected one (the selected one is filled). */
export async function isSelected(button: Locator): Promise<boolean> {
  return (await button.getAttribute('class'))?.split(/\s+/).includes('bg-primary') ?? false;
}

/** The query of a request, as an object. */
export function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

/** Back-dates every attribution result of a conversion. */
export async function backdateAttribution(conversionId: string, at: Date): Promise<void> {
  await sql('UPDATE attribution_results SET created_at = $2 WHERE conversion_id = $1', [conversionId, at]);
}

/** The time-decay credit the API gives each touchpoint: weights 2^(-Δt / 7 days) from the last one, rounded as it rounds. */
export function timeDecayCredits(times: Date[]): number[] {
  const last = Math.max(...times.map((t) => t.getTime()));
  const halfLife = 7 * 24 * 60 * 60 * 1000;
  const weights = times.map((t) => Math.pow(2, -(last - t.getTime()) / halfLife));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => Math.round((w / total) * 10000) / 10000);
}

/** A channel's credit as the attribution tables show it: rounded to 2 decimals server-side, then shown as a percent. */
export function creditLabel(credit: number): string {
  return `${((Math.round(credit * 100) / 100) * 100).toFixed(1)}%`;
}

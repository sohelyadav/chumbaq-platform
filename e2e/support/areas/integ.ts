import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'crypto';
import { connect } from 'net';
import { Client } from 'pg';
import { expect, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import { answerStub, failStub } from '../provider-stub';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { adminApi, enrolAndSignInStaff, grantSuperAdmin } from '../admin';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the INTEG specs: project API keys, the identity secret, outbound webhooks
 * and the Mixpanel cohorts. What a case is about goes through the browser or the API;
 * seeding it is not about (memberships, cohorts and their members, a stale sign-in) is
 * written straight to the e2e database (the name is checked as in seed.ts).
 */

export const ROLE_REFUSAL = 'Your role in this project does not allow this.';
export const PROJECT_NOT_FOUND = 'Project not found';
export const READ_ONLY = 'Impersonation sessions are read-only';
export const REAUTH_REQUIRED = 'Confirm it is you to continue.';
export const HIDDEN = 'hidden while viewing as tenant';
export const HIDDEN_FROM_ROLE = 'Only owners and admins can see this.';
export const WEBHOOK_CAP = 'A project can have at most 10 active webhooks. Turn one off or delete one first.';
export const PUBLIC_ADDRESS = 'Webhook URL must resolve to a public address';
export const NO_ELIGIBLE_TOKENS = 'No eligible push tokens found for this cohort';

// ---- Database

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

export async function sql<T = Record<string, any>>(query: string, params: unknown[] = []): Promise<T[]> {
  return withDb(async (db) => (await db.query(query, params)).rows as T[]);
}

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** The project's activity rows for one action, oldest first. */
export async function activityRows(projectId: string, action: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM project_activity WHERE project_id = $1 AND action = $2 ORDER BY occurred_at`, [projectId, action]);
}

export async function allActivity(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM project_activity WHERE project_id = $1 ORDER BY occurred_at`, [projectId]);
}

// ---- People and requests

export interface Person extends Account {
  ip: string;
}

/** A new account with a client address of its own. */
export async function newPerson(label: string, name: string): Promise<Person> {
  const ip = newClientIp();
  return { ...(await createAccount(ip, label, name)), ip };
}

export interface OwnedProject {
  owner: Person;
  project: Project;
}

export async function ownerWithProject(label = 'integ-owner', name = 'Olga Owner'): Promise<OwnedProject> {
  const owner = await newPerson(label, name);
  const project = await createProject(owner, owner.ip);
  return { owner, project };
}

/** A membership as an accepted invite leaves it. */
export async function addMember(projectId: string, person: Pick<Account, 'userId'>, role: 'owner' | 'admin' | 'member', addedBy: Pick<Account, 'userId'>): Promise<void> {
  await sql(
    `INSERT INTO project_members (project_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, clock_timestamp())`,
    [projectId, person.userId, role, addedBy.userId],
  );
}

/** A new person added to the project with `role`. */
export async function teammate(p: OwnedProject, role: 'owner' | 'admin' | 'member', name: string): Promise<Person> {
  const person = await newPerson(`integ-${role}`, name);
  await addMember(p.project.id, person, role, p.owner);
  return person;
}

/** Moves every one of the user's sign-ins back 20 minutes, past the 15-minute window. */
export async function ageSignIn(person: Pick<Account, 'userId'>): Promise<void> {
  await sql(`UPDATE auth_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1`, [person.userId]);
}

export interface Raw<T = any> {
  status: number;
  body: T;
  text: string;
}

/** A request that answers its status, parsed body and raw text, whatever the status. */
export async function raw<T = any>(
  method: string,
  path: string,
  { token, apiKey, ip, body }: { token?: string; apiKey?: string; ip: string; body?: unknown },
): Promise<Raw<T>> {
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
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (a CSV): keep the text.
  }
  return { status: response.status, body: parsed as T, text };
}

/** `raw` as a person. */
export function as<T = any>(person: Pick<Person, 'accessToken' | 'ip'>, method: string, path: string, body?: unknown): Promise<Raw<T>> {
  return raw<T>(method, path, { token: person.accessToken, ip: person.ip, body });
}

/** The `message` of an error body, as one string (a validation list joined). */
export function messageOf(response: Raw): string {
  const message = (response.body as { message?: unknown } | null)?.message;
  return Array.isArray(message) ? message.join(' | ') : String(message);
}

// ---- API keys and the identity secret

export async function apiKeyRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM api_keys WHERE project_id = $1 ORDER BY created_at`, [projectId]);
}

export async function identityKeyVersion(projectId: string): Promise<number> {
  const [row] = await sql<{ identity_key_version: number }>(`SELECT identity_key_version FROM projects WHERE id = $1`, [projectId]);
  return Number(row.identity_key_version);
}

export function userHash(secret: string, externalUserId: string): string {
  return createHmac('sha256', secret).update(externalUserId, 'utf8').digest('hex');
}

export async function identitySecretOf(owner: Person, projectId: string): Promise<string> {
  return (await api<{ secret: string }>('GET', `/api/projects/${projectId}/identity-secret`, undefined, { token: owner.accessToken, ip: owner.ip })).secret;
}

// ---- Webhooks

/** A public IPv4 literal URL: passes every address check with no DNS, and nothing listens for it here. */
export function literalHookUrl(label = 'hook'): string {
  return `https://1.1.1.1/chumbaq-e2e/${label}-${randomBytes(4).toString('hex')}`;
}

export interface CreatedWebhook {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  secret: string;
  secretHint: string;
}

export async function createWebhook(
  person: Pick<Person, 'accessToken' | 'ip'>,
  projectId: string,
  fields: { url?: string; events?: string[]; isActive?: boolean } = {},
): Promise<CreatedWebhook> {
  return api<CreatedWebhook>(
    'POST',
    `/api/projects/${projectId}/webhooks`,
    { url: fields.url ?? literalHookUrl(), events: fields.events ?? ['click'], ...(fields.isActive === undefined ? {} : { isActive: fields.isActive }) },
    { token: person.accessToken, ip: person.ip },
  );
}

export async function webhookRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM webhooks WHERE project_id = $1 ORDER BY created_at`, [projectId]);
}

/** A webhook's card on the Webhooks page, by text it shows (its URL, or its hint). */
export function webhookCard(page: Page, text: string): Locator {
  return page.locator('[data-slot="card"]').filter({ hasText: text });
}

// ---- Mixpanel

export const MIXPANEL_ACCOUNT = { username: 'svc.e2e@mixpanel.com', password: 's3cret-pass', projectId: '123456' };

/**
 * Mixpanel connected for a case about what comes after, through the real configure route
 * (the stack sets a per-run MIXPANEL_ENCRYPTION_KEY, so credentials can be stored).
 */
export async function connectMixpanel(person: Pick<Person, 'accessToken' | 'ip'>, projectId: string): Promise<void> {
  return configureMixpanel(person, projectId);
}

/** Connects Mixpanel through the real configure route, as an owner or admin. */
export async function configureMixpanel(person: Pick<Person, 'accessToken' | 'ip'>, projectId: string, mixpanelProjectId = MIXPANEL_ACCOUNT.projectId): Promise<void> {
  await api(
    'POST',
    `/api/projects/${projectId}/mixpanel/configure`,
    {
      serviceAccountUsername: MIXPANEL_ACCOUNT.username,
      serviceAccountPassword: MIXPANEL_ACCOUNT.password,
      mixpanelProjectId,
    },
    { token: person.accessToken, ip: person.ip },
  );
}

export interface SeededMember {
  /** Null for an unresolved member. */
  deviceIdentityId: string | null;
  distinctId?: string;
}

export interface SeededCohort {
  id: string;
  name: string;
  mixpanelCohortId: number;
}

/**
 * An imported cohort as a finished sync leaves it, with its members: the import itself
 * needs Mixpanel's own cohort data, which no case here is about.
 */
export async function seedCohort(projectId: string, name: string, members: SeededMember[] = []): Promise<SeededCohort> {
  const mixpanelCohortId = randomInt(100_000, 2_000_000_000);
  return withDb(async (db) => {
    const resolved = members.filter((m) => m.deviceIdentityId).length;
    const {
      rows: [cohort],
    } = await db.query(
      `INSERT INTO mixpanel_cohorts ("projectId", "mixpanelCohortId", name, "mixpanelUserCount", "resolvedCount", "unresolvedCount", status, "lastSyncedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'synced', now()) RETURNING id`,
      [projectId, mixpanelCohortId, name, members.length, resolved, members.length - resolved],
    );
    for (const member of members) {
      await db.query(
        `INSERT INTO mixpanel_cohort_members ("cohortId", "projectId", "mixpanelDistinctId", "deviceIdentityId", "resolvedBy", "isResolved", "mixpanelProfile")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          cohort.id,
          projectId,
          member.distinctId ?? `mp-${randomUUID()}`,
          member.deviceIdentityId,
          member.deviceIdentityId ? 'distinct_id' : null,
          member.deviceIdentityId !== null,
          JSON.stringify({ $name: 'E2E profile' }),
        ],
      );
    }
    return { id: cohort.id as string, name, mixpanelCohortId };
  });
}

export async function cohortSnapshot(cohortId: string): Promise<{ cohort: Record<string, any> | undefined; members: Array<Record<string, any>> }> {
  const [cohort] = await sql(`SELECT * FROM mixpanel_cohorts WHERE id = $1`, [cohortId]);
  const members = await sql(`SELECT * FROM mixpanel_cohort_members WHERE "cohortId" = $1 ORDER BY id`, [cohortId]);
  return { cohort, members };
}

/** A project with an SDK key, for people and push tokens through the real SDK routes. */
export interface SdkProject extends OwnedProject {
  sdkKey: string;
}

export async function sdkProject(p: OwnedProject): Promise<SdkProject> {
  return { ...p, sdkKey: await createApiKey(p.owner, p.project.id, p.owner.ip) };
}

/** A person through the SDK's identify; answers their device identity id. */
export async function identifyDevice(p: SdkProject, body: Record<string, unknown> = {}): Promise<{ id: string; fingerprint: string }> {
  const fingerprint = `integ-device-${randomBytes(6).toString('hex')}`;
  await api(
    'POST',
    '/api/identity/identify',
    { projectId: p.project.id, deviceFingerprint: fingerprint, platform: 'web', ...body },
    { apiKey: p.sdkKey, ip: p.owner.ip },
  );
  const [row] = await sql<{ id: string }>(`SELECT id FROM device_identities WHERE project_id = $1 AND device_fingerprint = $2`, [
    p.project.id,
    fingerprint,
  ]);
  return { id: row.id, fingerprint };
}

/** A push token for a device, through the SDK's register route. */
export async function registerToken(p: SdkProject, fingerprint: string, platform: 'ios' | 'android' | 'web'): Promise<string> {
  const token = `integ-token-${randomBytes(12).toString('hex')}`;
  await api('POST', '/api/push-tokens/register', { projectId: p.project.id, deviceFingerprint: fingerprint, token, platform }, { apiKey: p.sdkKey, ip: p.owner.ip });
  return token;
}

/** An in-app message through the dashboard's create route. */
export async function createInAppMessage(person: Pick<Person, 'accessToken' | 'ip'>, projectId: string, name = 'Cohort welcome'): Promise<string> {
  const message = await api<{ id: string }>(
    'POST',
    `/api/projects/${projectId}/in-app-messages`,
    { name, messageType: 'modal', title: 'Welcome back' },
    { token: person.accessToken, ip: person.ip },
  );
  return message.id;
}

export async function campaignRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_notification_logs WHERE project_id = $1 ORDER BY sent_at`, [projectId]);
}

export async function pendingInAppRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM pending_in_app_messages WHERE project_id = $1 ORDER BY created_at`, [projectId]);
}

/**
 * Puts a device at a frequency cap of one push a day: the project's cap set to 1 and a
 * `sent` event for it from an earlier campaign an hour ago.
 */
export async function atFrequencyCap(projectId: string, deviceIdentityId: string): Promise<void> {
  await withDb(async (db) => {
    await db.query(`UPDATE push_configs SET frequency_cap_per_day = 1 WHERE project_id = $1`, [projectId]);
    const {
      rows: [campaign],
    } = await db.query(
      `INSERT INTO push_notification_logs (project_id, title, body, status, total_tokens, success_count)
       VALUES ($1, 'Earlier push', 'Sent before', 'sent', 1, 1) RETURNING id`,
      [projectId],
    );
    await db.query(
      `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, occurred_at)
       VALUES ($1, $2, $3, 'sent', now() - interval '1 hour')`,
      [projectId, campaign.id, deviceIdentityId],
    );
  });
}

// ---- View-as

/**
 * Staff view-as of `tenant`, the real way: a super admin granted by the CLI enrols a
 * passkey and signs in to the admin app in a browser of their own, and starts view-as
 * with a reason. Answers the one-time handoff link (`APP_URL/impersonate#code=`).
 */
export async function viewAsHandoff(browser: Browser, baseURL: string | undefined, tenant: Pick<Account, 'userId'>): Promise<string> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'integ-staff', 'Sol Staff');
  await grantSuperAdmin(staff.email);
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': ip } });
  try {
    const staffToken = await enrolAndSignInStaff(await context.newPage(), staff);
    const handoff = await adminApi<{ url: string }>(
      'POST',
      `/api/admin/tenants/${tenant.userId}/impersonate`,
      { reason: 'E2E: checking integrations read-only' },
      staffToken,
      ip,
    );
    return handoff.url;
  } finally {
    await context.close();
  }
}

/** A view-as access token for `tenant`, spent from a fresh handoff on the customer API. */
export async function viewAsToken(browser: Browser, baseURL: string | undefined, tenant: Pick<Account, 'userId'>): Promise<string> {
  const url = await viewAsHandoff(browser, baseURL, tenant);
  const code = new URL(url).hash.replace(/^#code=/, '');
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip: newClientIp() });
  return session.accessToken;
}

/** Opens a handoff link in this tab and waits for the read-only banner. */
export async function openViewAs(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForURL(/\/projects$/);
  await page.getByRole('region', { name: 'Impersonation session' }).waitFor();
}

// ---- Page

/**
 * A toast in the notification list (not its screen-reader copy), by its exact title.
 * Found by the toast's own element rather than the region's role: while a modal dialog
 * is open the region is hidden from the accessibility tree, though the toast is shown.
 */
export function toast(page: Page, title: string): Locator {
  return page.locator('li[data-swipe-direction]').filter({ has: page.getByText(title, { exact: true }) });
}

/** Holds matching requests for a moment, so a button's pending label can be seen. */
export async function slowDown(page: Page, urlPart: string, method: string, ms = 1000): Promise<void> {
  await page.route(
    (url) => url.pathname.includes(urlPart),
    async (route: Route) => {
      if (route.request().method() === method) await new Promise((resolve) => setTimeout(resolve, ms));
      await route.fallback();
    },
  );
}

/** Date the way the dashboard shows it (date-fns `MMM d, yyyy`), in this machine's zone. */
export function shortDate(at: Date): string {
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---- Short links and clicks (for webhook delivery cases)

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function seedShortLink(owner: Pick<Person, 'accessToken' | 'ip'>, projectId: string, label: string): Promise<{ id: string; shortCode: string }> {
  const shortCode = `${label}-${randomBytes(3).toString('hex')}`.slice(0, 30);
  return api<{ id: string; shortCode: string }>(
    'POST',
    `/api/projects/${projectId}/links`,
    { longUrl: `https://example.com/${label}`, title: `Link ${label}`, shortCode },
    { token: owner.accessToken, ip: owner.ip },
  );
}

/** Opens a short link on the API's root redirect as a desktop browser would, without following it. */
export async function openShortCode(code: string, ip: string): Promise<{ status: number; location: string | null; ms: number }> {
  const started = Date.now();
  const response = await fetch(apiUrl(`/${code}`), { redirect: 'manual', headers: { 'User-Agent': DESKTOP_UA, 'X-Forwarded-For': ip } });
  await response.text();
  return { status: response.status, location: response.headers.get('location'), ms: Date.now() - started };
}

/** True when a TCP connection from this machine to `host:port` neither opens nor fails within `ms`. */
export function connectHangs(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (hangs: boolean) => {
      socket.destroy();
      resolve(hangs);
    };
    socket.setTimeout(ms, () => done(true));
    socket.once('connect', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Clicks are written after the redirect answers: waits until the link has `expected` of them. */
export async function waitForClickRows(linkId: string, expected: number, timeoutMs = 20_000): Promise<number> {
  const until = Date.now() + timeoutMs;
  let seen = -1;
  while (Date.now() < until) {
    const [row] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM click_events WHERE link_id = $1', [linkId]);
    seen = Number(row.n);
    if (seen >= expected) return seen;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return seen;
}

// ---- Mixpanel config rows

export async function mixpanelConfigRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM mixpanel_configs WHERE "projectId" = $1`, [projectId]);
}

// ---- Request recording

/** Records the dashboard's API requests (method and path) whose path contains `part`. */
export function recordApiRequests(page: Page, part: string): Array<{ method: string; path: string }> {
  const seen: Array<{ method: string; path: string }> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && path.includes(part)) seen.push({ method: request.method(), path });
  });
  return seen;
}

// ---- Mixpanel: the provider stub, per test

/**
 * A Mixpanel project id of the test's own (eight digits, as the other INTEG specs use),
 * so what the stub is told to answer for it reaches no other test.
 */
export function ownMixpanelProjectId(): string {
  return String(randomInt(10_000_000, 99_999_999));
}

/** The cohorts Mixpanel lists for `mixpanelProjectId`, in its own `cohorts/list` shape. */
export async function stubMixpanelCohortList(mixpanelProjectId: string, cohorts: Array<{ id: number; name: string; count: number }>): Promise<void> {
  await answerStub('mixpanel', {
    method: 'GET',
    path: `/api/2.0/cohorts/list?project_id=${mixpanelProjectId}`,
    body: cohorts.map((c) => ({
      id: c.id,
      name: c.name,
      count: c.count,
      description: '',
      created: '2026-01-01 00:00:00',
      project_id: Number(mixpanelProjectId),
      is_visible: 1,
    })),
  });
}

export interface StubProfile {
  distinctId: string;
  properties?: Record<string, unknown>;
}

/**
 * The profiles Mixpanel's `engage` answers for `mixpanelProjectId` (one page). The
 * stub's answers are keyed by path only and `engage` carries the project in its form
 * body, so this uses the stub's matched answer (`fail` with a 200 and a body), scoped
 * to that project's form field.
 */
export async function stubMixpanelMembers(mixpanelProjectId: string, profiles: StubProfile[]): Promise<void> {
  await failStub('mixpanel', {
    status: 200,
    match: `project_id=${mixpanelProjectId}&page=`,
    body: {
      page: 0,
      page_size: 1000,
      session_id: `e2e-${mixpanelProjectId}`,
      status: 'ok',
      total: profiles.length,
      results: profiles.map((p) => ({ $distinct_id: p.distinctId, $properties: p.properties ?? {} })),
    },
  });
}

/** Mixpanel answers 401 to every request made for `mixpanelProjectId` from now on. */
export async function refuseMixpanelCredentials(mixpanelProjectId: string): Promise<void> {
  await failStub('mixpanel', { status: 401, match: `project_id=${mixpanelProjectId}` });
}

export interface MemberSeed {
  /** Null for an unresolved member. */
  deviceIdentityId: string | null;
  distinctId?: string;
  resolvedBy?: 'external_user_id' | 'distinct_id' | 'email' | null;
  addedAt?: Date;
  profile?: Record<string, unknown>;
}

export interface CohortSeed {
  name: string;
  mixpanelCohortId?: number;
  status?: 'pending' | 'syncing' | 'synced' | 'error';
  /** Defaults to what the members add up to. */
  counts?: { mixpanel: number; resolved: number; unresolved: number };
  lastSyncedAt?: Date | null;
  errorMessage?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  members?: MemberSeed[];
}

/** An imported cohort in any state a sync can leave it, with its members. */
export async function seedCohortWith(projectId: string, seed: CohortSeed): Promise<SeededCohort> {
  const mixpanelCohortId = seed.mixpanelCohortId ?? randomInt(100_000, 2_000_000_000);
  const members = seed.members ?? [];
  const resolved = members.filter((m) => m.deviceIdentityId).length;
  const counts = seed.counts ?? { mixpanel: members.length, resolved, unresolved: members.length - resolved };
  return withDb(async (db) => {
    const {
      rows: [cohort],
    } = await db.query(
      `INSERT INTO mixpanel_cohorts ("projectId", "mixpanelCohortId", name, "mixpanelUserCount", "resolvedCount", "unresolvedCount", status, "lastSyncedAt", "errorMessage", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()), COALESCE($11, now())) RETURNING id`,
      [
        projectId,
        mixpanelCohortId,
        seed.name,
        counts.mixpanel,
        counts.resolved,
        counts.unresolved,
        seed.status ?? 'synced',
        seed.lastSyncedAt === undefined ? new Date() : seed.lastSyncedAt,
        seed.errorMessage ?? null,
        seed.createdAt ?? null,
        seed.updatedAt ?? null,
      ],
    );
    for (const member of members) {
      await db.query(
        `INSERT INTO mixpanel_cohort_members ("cohortId", "projectId", "mixpanelDistinctId", "deviceIdentityId", "resolvedBy", "isResolved", "mixpanelProfile", "addedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()))`,
        [
          cohort.id,
          projectId,
          member.distinctId ?? `mp-${randomUUID()}`,
          member.deviceIdentityId,
          member.deviceIdentityId ? (member.resolvedBy === undefined ? 'distinct_id' : member.resolvedBy) : null,
          member.deviceIdentityId !== null,
          JSON.stringify(member.profile ?? { $name: 'E2E profile' }),
          member.addedAt ?? null,
        ],
      );
    }
    return { id: cohort.id as string, name: seed.name, mixpanelCohortId };
  });
}

/** A person named by an external id through identify, with the project's `userHash`. */
export async function identifyPerson(
  p: SdkProject,
  externalUserId: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; fingerprint: string }> {
  const secret = await identitySecretOf(p.owner, p.project.id);
  return identifyDevice(p, { externalUserId, userHash: userHash(secret, externalUserId), ...body });
}

/**
 * A view-as write refused as read-only, with its own toast: earlier read-only toasts are
 * waited out first (they go after 4 s), so the one seen afterwards is this write's.
 */
export async function refusedAsReadOnly(page: Page, urlPart: string, method: string, action: () => Promise<void>): Promise<void> {
  const readOnly = toast(page, 'Read-only session').filter({ hasText: READ_ONLY });
  await expect(readOnly).toHaveCount(0, { timeout: 10_000 });
  const refused = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(urlPart) && r.request().method() === method);
  await action();
  const response = await refused;
  expect(response.status(), `${method} ${urlPart}`).toBe(403);
  expect((await response.json()).message, `${method} ${urlPart}`).toBe(READ_ONLY);
  await expect(readOnly).toHaveCount(1);
}

/** A stat card's figure on the cohort page ("Mixpanel Count", "Resolved", ...). */
export function cohortStat(page: Page, label: string): Locator {
  return page.locator('p').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=preceding-sibling::p[1]');
}

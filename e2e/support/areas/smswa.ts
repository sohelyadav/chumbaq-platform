import { randomBytes } from 'crypto';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import { connectFakeSmsProvider, smsWebhookPath, type SeededSms } from '../channels';
import { newPersonContext } from '../fixtures';
import { stubCalls } from '../provider-stub';
import { publicApiUrl, twilioSignature } from '../signing';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the SMS and WhatsApp specs (SMSWA): projects with a sender and a seeded
 * Twilio connection, people with phone numbers through the SDK's identify route,
 * teammates with a role, signed Twilio webhooks, view-as, and SQL reads of the rows the
 * API writes.
 */

export const PROJECT_NOT_FOUND = 'Project not found';
export const ROLE_REFUSAL = 'Your role in this project does not allow this.';
export const READ_ONLY = 'Impersonation sessions are read-only';
export const HIDDEN = 'hidden while viewing as tenant';
export const DEFAULT_SENDER = '+14155550123';

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

export async function smsSettingsRow(projectId: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM sms_settings WHERE project_id = $1`, [projectId]);
  return row;
}

export async function suppressionRows(projectId: string, channel: 'sms' | 'whatsapp' | 'email' = 'sms'): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM channel_suppressions WHERE project_id = $1 AND channel = $2 ORDER BY address`, [projectId, channel]);
}

export async function consentRows(deviceIdentityId: string): Promise<Array<{ channel: string; granted: boolean; source: string }>> {
  return sql(
    `SELECT channel, granted, source FROM consent_events WHERE device_identity_id = $1 ORDER BY occurred_at, id`,
    [deviceIdentityId],
  );
}

export async function projectConsentRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM consent_events WHERE project_id = $1 ORDER BY occurred_at, id`, [projectId]);
}

export async function activityRows(projectId: string, action: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM project_activity WHERE project_id = $1 AND action = $2 ORDER BY occurred_at`, [projectId, action]);
}

export async function campaignRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_notification_logs WHERE project_id = $1 ORDER BY sent_at`, [projectId]);
}

export async function eventRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_notification_events WHERE project_id = $1 ORDER BY created_at`, [projectId]);
}

/**
 * Marks the account suspended the way staff suspending it leaves it: `suspended_at`
 * set, which is all ProjectSuspensionService and the JWT checks read. The admin route
 * that does this is ADMTEN's.
 */
export async function suspendAccount(userId: string): Promise<void> {
  const rows = await sql(
    `UPDATE users SET suspended_at = now(), session_version = session_version + 1 WHERE id = $1 RETURNING id`,
    [userId],
  );
  if (rows.length !== 1) throw new Error(`No users row ${userId}`);
}

// ---- Requests that answer the status and body instead of throwing

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  body: any;
}

export interface Caller {
  accessToken: string;
  ip: string;
}

export async function call(method: string, path: string, as: Caller | null, body?: unknown, ip?: string): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': as?.ip ?? ip ?? newClientIp(),
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
  return { status: response.status, headers: response.headers, text, body: parsed };
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

export async function newPerson(label: string, name = 'Sam Sms'): Promise<Person> {
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

/** A new account added to the project with `role`. */
export async function teammate(projectId: string, role: 'admin' | 'member', owner: Pick<Account, 'userId'>): Promise<Person> {
  const person = await newPerson(`smswa-${role}`, `Tia ${role}`);
  await addMember(projectId, person, role, owner);
  return person;
}

// ---- Projects

export interface SmsProject {
  owner: Person;
  project: Project;
  sdkKey: string;
  /** Present once Twilio is seeded (`withTwilio`). */
  sms?: SeededSms;
}

export interface SenderOptions {
  sender?: string;
  requireOptIn?: boolean;
  optOutText?: string;
}

/** Saves the SMS sender through the API, as the Settings form does. */
export async function saveSender(as: Caller, projectId: string, options: SenderOptions = {}): Promise<any> {
  return dataOf(
    await call('POST', '/api/sms/settings', as, {
      projectId,
      sender: options.sender ?? DEFAULT_SENDER,
      ...(options.requireOptIn !== undefined ? { requireOptIn: options.requireOptIn } : {}),
      ...(options.optOutText !== undefined ? { optOutText: options.optOutText } : {}),
    }),
  );
}

/**
 * A project of a new owner with an SDK key. `sender` saves the SMS sender through the
 * API; `twilio` (implies the sender) also seeds a Twilio connection with fresh fake
 * credentials of this test's own.
 */
export async function smsProject(
  label: string,
  { sender = false, twilio = false, requireOptIn }: { sender?: boolean; twilio?: boolean; requireOptIn?: boolean } = {},
  owner?: Person,
): Promise<SmsProject> {
  const person = owner ?? (await newPerson(label, 'Owen Owner'));
  const project = await createProject(person, person.ip);
  const sdkKey = await createApiKey(person, project.id, person.ip);
  const made: SmsProject = { owner: person, project, sdkKey };
  if (sender || twilio) await saveSender(person, project.id, { requireOptIn });
  if (twilio) made.sms = await connectFakeSmsProvider(project.id);
  return made;
}

export interface PhonePerson {
  phone?: string;
  smsOptIn?: boolean;
  whatsappOptIn?: boolean;
  firstName?: string;
}

/** One device through the SDK's identify route; answers its device identity id. */
export async function identifyPhone(p: Pick<SmsProject, 'project' | 'sdkKey'>, ip: string, person: PhonePerson): Promise<string> {
  const identity = await api<{ id: string }>(
    'POST',
    '/api/identity/identify',
    {
      projectId: p.project.id,
      deviceFingerprint: `smswa-${randomBytes(8).toString('hex')}`,
      platform: 'web',
      ...person,
    },
    { apiKey: p.sdkKey, ip },
  );
  return identity.id;
}

/** The catalogue's people S1 to S9, by key. */
export const PEOPLE: Record<string, PhonePerson> = {
  S1: { phone: '+919876543210', smsOptIn: true, whatsappOptIn: true, firstName: 'Asha' },
  S2: { phone: '+14155550111', smsOptIn: true },
  S3: { phone: '+447700900123', smsOptIn: false, whatsappOptIn: false },
  S4: { phone: '+33612345678' },
  S5: { phone: '9876543210' },
  S6: { firstName: 'Nophone' },
  S7: { phone: '+919811111111', smsOptIn: true },
  S8: { phone: '+919811111111', smsOptIn: true },
  S9: { phone: '+919876543210', smsOptIn: false },
};

/** Identifies the named people (in the order given); answers their identity ids by key. */
export async function seedPeople(p: Pick<SmsProject, 'project' | 'sdkKey'>, ip: string, keys: string[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const key of keys) ids[key] = await identifyPhone(p, ip, PEOPLE[key]);
  return ids;
}

/** An SMS campaign through the API, scheduled a month ahead so nothing is ever sent. */
export async function scheduleSmsCampaign(as: Caller, projectId: string, body = 'Scheduled for later'): Promise<{ id: string }> {
  const scheduledAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  return dataOf(await call('POST', '/api/sms/send', as, { projectId, body, scheduledAt }));
}

export async function smsPreview(as: Caller, projectId: string): Promise<{ targetType: string; recipients: number; requireOptIn: boolean }> {
  return dataOf(await call('POST', '/api/sms/audience-preview', as, { projectId }));
}

export async function smsSuppressionList(as: Caller, projectId: string): Promise<{ data: Array<Record<string, any>>; total: number }> {
  return dataOf(await call('GET', `/api/sms/suppressions/${projectId}`, as));
}

/** The calls the provider stub's Twilio received for this account. */
export async function twilioCallsFor(accountSid: string) {
  return (await stubCalls('twilio')).filter((entry) => entry.path.includes(accountSid));
}

// ---- Twilio webhooks

export interface TwilioPost {
  /** Sign with this Auth Token (omit for no signature header). */
  authToken?: string;
  /** Sign this path instead of the one posted to. */
  signPath?: string;
  /** Parameters added to the body after signing. */
  extra?: Record<string, string>;
}

/**
 * Posts a Twilio webhook (form body) to `path` on the API, signed as Twilio signs it:
 * over the public URL the API checks against and the parameters.
 */
export async function postTwilio(path: string, params: Record<string, string>, { authToken, signPath, extra }: TwilioPost = {}): Promise<RawResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Forwarded-For': newClientIp(),
  };
  if (authToken) headers['X-Twilio-Signature'] = twilioSignature(authToken, publicApiUrl(signPath ?? path), params);
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers,
    body: new URLSearchParams({ ...params, ...extra }).toString(),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // TwiML or empty.
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

/** A signed status report for the seeded connection. */
export function twilioStatus(sms: SeededSms, params: Record<string, string>, query: { campaignId?: string; identityId?: string } = {}) {
  return postTwilio(smsWebhookPath(sms.webhookToken, 'status', query), { AccountSid: sms.credentials.accountSid, ...params }, { authToken: sms.credentials.authToken });
}

/** A signed reply (STOP, START, ...) from `from` to the seeded connection. */
export function twilioReply(sms: SeededSms, from: string, body: string) {
  return postTwilio(
    smsWebhookPath(sms.webhookToken, 'inbound'),
    { AccountSid: sms.credentials.accountSid, From: from, To: sms.sender, Body: body, MessageSid: `SM${randomBytes(16).toString('hex')}` },
    { authToken: sms.credentials.authToken },
  );
}

// ---- Pages

/** Opens the SMS page on a tab ('Campaigns', 'Suppressions' or 'Settings'). */
export async function openSms(page: Page, projectId: string, tab: 'Campaigns' | 'Suppressions' | 'Settings'): Promise<void> {
  await page.goto(`/projects/${projectId}/sms`);
  await page.getByRole('heading', { name: 'SMS', exact: true }).waitFor();
  const trigger = page.getByRole('tab', { name: tab, exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-selected', 'true');
}

/** The card whose title is `title` (shadcn cards carry data-slot). */
export function card(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^\\s*${title}\\s*$`) }) });
}

/** The "STOP and START replies" block of the Twilio card. */
export function repliesBlock(page: Page): Locator {
  return page.locator('div.rounded-md.border').filter({ has: page.getByText('STOP and START replies', { exact: true }) });
}

/** The reach line of the SMS composer. */
export function reachLine(page: Page): Locator {
  return page.locator('p').filter({ has: page.locator('svg.lucide-users') });
}

/** Date as the suppression list shows it (date-fns `MMM d, yyyy`), in this machine's zone. */
export function sinceLabel(at: string | Date): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---- View-as

/**
 * Staff view-as of `tenant`: a new super admin (the flag set as `admin:grant` sets it)
 * enrols a passkey and signs in to the admin app in a browser of their own, and starts
 * view-as with a reason. Answers the one-time handoff link (`APP_URL/impersonate#code=`).
 */
export async function viewAsHandoff(browser: Browser, baseURL: string | undefined, tenant: Account): Promise<string> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'smswa-staff', 'Sid Staff');
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [staff.userId]);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const staffPage = await context.newPage();
    const staffToken = await enrolAndSignInStaff(staffPage, staff);
    const handoff = await adminApi<{ url: string }>(
      'POST',
      `/api/admin/tenants/${tenant.userId}/impersonate`,
      { reason: 'E2E: checking SMS pages read-only' },
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

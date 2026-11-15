import { createHmac, randomBytes } from 'crypto';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';
import { adminApi, enrolAndSignInStaff } from '../admin';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import {
  connectFakeSmsProvider,
  connectFakeWhatsAppProvider,
  smsWebhookPath,
  whatsappWebhookPath,
  type SeededSms,
  type SeededWhatsApp,
  type WhatsAppProviderChoice,
  type WhatsAppProviderName,
} from '../channels';
import { newPersonContext } from '../fixtures';
import { stubCalls, type StubProvider } from '../provider-stub';
import { hubSignature, interaktSignature, publicApiUrl, twilioSignature } from '../signing';
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
  traits?: Record<string, unknown>;
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

// ---- WhatsApp

export const ONLY_OWNERS = 'Only owners and admins can see this.';

/** A WhatsApp provider seeded into an `SmsProject` (optionally alongside Twilio for SMS). */
export interface WaProject<P extends WhatsAppProviderName = WhatsAppProviderName> extends SmsProject {
  wa: SeededWhatsApp<P>;
}

type StoredName<P extends WhatsAppProviderChoice> = P extends 'twilio' ? 'twilio_whatsapp' : P;

/**
 * A project of a new owner (or `owner`) with an SDK key and `provider` connected for
 * WhatsApp (seeded). `signed: false` leaves out Meta's app secret or Interakt's webhook
 * secret; `twilio` also seeds Twilio for SMS.
 */
export async function waProject<P extends WhatsAppProviderChoice>(
  label: string,
  provider: P,
  { signed, requireOptIn, twilio = false }: { signed?: boolean; requireOptIn?: boolean; twilio?: boolean } = {},
  owner?: Person,
): Promise<WaProject<StoredName<P>>> {
  const base = await smsProject(label, { twilio }, owner);
  const wa = await connectFakeWhatsAppProvider(base.project.id, provider, { signed, requireOptIn });
  return { ...base, wa } as WaProject<StoredName<P>>;
}

export async function waSettingsRow(projectId: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM whatsapp_settings WHERE project_id = $1`, [projectId]);
  return row;
}

export async function waPreview(as: Caller, projectId: string, extra: Record<string, unknown> = {}): Promise<number> {
  return dataOf(await call('POST', '/api/whatsapp/audience-preview', as, { projectId, ...extra })).recipients;
}

export async function waSuppressionList(as: Caller, projectId: string): Promise<{ data: Array<Record<string, any>>; total: number }> {
  return dataOf(await call('GET', `/api/whatsapp/suppressions/${projectId}`, as));
}

/** A hand-typed template as the composer sends it for a provider that cannot list templates. */
export function handTyped(id = 'order_update', bodyParams: string[] = []): Record<string, unknown> {
  return { template: { id, name: id, language: 'en' }, bodyParams, buttonParams: [], previewText: null };
}

/** A WhatsApp campaign through the API, scheduled a month ahead. */
export async function scheduleWhatsAppCampaign(as: Caller, projectId: string, extra: Record<string, unknown> = {}) {
  return call('POST', '/api/whatsapp/send', as, {
    projectId,
    content: handTyped(),
    scheduledAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    ...extra,
  });
}

/** A campaign row of `channel` written straight into the table (as a finished send leaves one). */
export async function seedCampaignRow(projectId: string, channel: 'sms' | 'whatsapp' | 'push', title = 'E2E seeded'): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs (project_id, title, channel, status, total_tokens, success_count, processed_tokens)
     VALUES ($1, $2, $3, 'sent', 1, 1, 1) RETURNING id`,
    [projectId, title, channel],
  );
  return row.id;
}

/** A `sent` event for (campaign, identity), `daysAgo` days back, as the worker records one. */
export async function seedSentEvent(projectId: string, campaignId: string, identityId: string, daysAgo: number): Promise<void> {
  await sql(
    `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, platform, occurred_at)
     VALUES ($1, $2, $3, 'sent', 'whatsapp', now() - make_interval(days => $4::int))`,
    [projectId, campaignId, identityId, daysAgo],
  );
}

/** POSTs a JSON body, sent byte for byte as `raw`, with `headers`. */
export async function postJson(path: string, raw: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': newClientIp(), ...headers },
    body: raw,
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON.
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

export interface MetaValue {
  statuses?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  user_preferences?: Array<Record<string, unknown>>;
}

/** Meta's webhook body around one change value. */
export function metaBody(value: MetaValue): string {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '0', changes: [{ field: 'messages', value }] }] });
}

/**
 * Posts a Meta webhook to the project's Meta URL, signed with the stored app secret
 * unless `signature` says otherwise (`null`: no header; a string: that header).
 */
export function metaPost(wa: SeededWhatsApp<'meta'>, value: MetaValue, signature?: string | null): Promise<RawResponse> {
  const raw = metaBody(value);
  const secret = wa.credentials.appSecret;
  const header = signature === undefined ? (secret ? hubSignature(secret, raw) : null) : signature;
  return postJson(whatsappWebhookPath('meta', wa.webhookToken), raw, header ? { 'X-Hub-Signature-256': header } : {});
}

/** A Meta status for `number` (digits, no plus), tagged with campaign and identity when given. */
export function metaStatus(number: string, status: string, tags: { c?: string; i?: string } = {}, extra: Record<string, unknown> = {}) {
  return {
    id: `wamid.${randomBytes(8).toString('hex')}`,
    status,
    recipient_id: number,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...(tags.c || tags.i ? { biz_opaque_callback_data: JSON.stringify(tags) } : {}),
    ...extra,
  };
}

/** A Meta text reply from `number`; no timestamp means the API's own time. */
export function metaReply(number: string, text: string, timestamp?: number) {
  return { from: number, id: `wamid.${randomBytes(8).toString('hex')}`, type: 'text', text: { body: text }, ...(timestamp ? { timestamp: String(timestamp) } : {}) };
}

/** Posts an Interakt webhook, signed with the stored webhook secret unless `signature` says otherwise. */
export function interaktPost(wa: SeededWhatsApp<'interakt'>, body: Record<string, unknown>, signature?: string | null): Promise<RawResponse> {
  const raw = JSON.stringify(body);
  const secret = wa.credentials.webhookSecret;
  const header = signature === undefined ? (secret ? interaktSignature(secret, raw) : null) : signature;
  return postJson(whatsappWebhookPath('interakt', wa.webhookToken), raw, header ? { 'Interakt-Signature': header } : {});
}

export function interaktReceived(number: string, text: string) {
  return { type: 'message_received', data: { customer: { channel_phone_number: number }, message: { message: text } } };
}

export function gupshupPost(webhookToken: string, body: Record<string, unknown>): Promise<RawResponse> {
  return postJson(whatsappWebhookPath('gupshup', webhookToken), JSON.stringify(body));
}

/** A Twilio WhatsApp webhook (form body) to the project's URL, signed with `authToken`. */
export function twilioWhatsAppPost(
  wa: SeededWhatsApp<'twilio_whatsapp'>,
  params: Record<string, string>,
  query: { c?: string; i?: string } = {},
  options: TwilioPost = { authToken: wa.credentials.authToken },
): Promise<RawResponse> {
  const search = new URLSearchParams(query as Record<string, string>).toString();
  return postTwilio(`${whatsappWebhookPath('twilio_whatsapp', wa.webhookToken)}${search ? `?${search}` : ''}`, params, options);
}

/** The provider stub's calls to `provider` whose path or body mentions `needle`. */
export async function providerCallsMentioning(provider: StubProvider, needle: string) {
  return (await stubCalls(provider)).filter((entry) => `${entry.path} ${JSON.stringify(entry.body)}`.includes(needle));
}

/** Opens the WhatsApp page on a tab. */
export async function openWhatsApp(page: Page, projectId: string, tab: 'Campaigns' | 'Suppressions' | 'Settings'): Promise<void> {
  await page.goto(`/projects/${projectId}/whatsapp`);
  await page.getByRole('heading', { name: 'WhatsApp', exact: true }).waitFor();
  const trigger = page.getByRole('tab', { name: tab, exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-selected', 'true');
}

/** The WhatsApp Consent card's switch (its label has no htmlFor). */
export function waConsentSwitch(page: Page): Locator {
  return page.getByText('Only message people who opted in to WhatsApp', { exact: true }).locator('../..').getByRole('switch');
}

/** The Webhook block of the WhatsApp Provider card. */
export function waWebhookBlock(page: Page): Locator {
  return page.locator('div.rounded-md.border').filter({ has: page.getByText('Webhook', { exact: true }) });
}

/** A toast (its Radix root) by its exact title, so its description is read from that toast only. */
export function toastTitled(page: Page, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .getByRole('region', { name: /Notifications/ })
    .locator('li')
    .filter({ has: page.locator('div.text-sm.font-semibold', { hasText: new RegExp(`^${escaped}$`) }) });
}

/** The green summary line of a provider tab with stored credentials. */
export function waSummaryLine(page: Page): Locator {
  return page.locator('p').filter({ hasText: 'secret ending' });
}

/** Erases one person (device identity) through the dashboard route, as the owner. */
export async function erasePerson(as: Caller, projectId: string, identityId: string): Promise<void> {
  const answered = await call('DELETE', `/api/projects/${projectId}/users/${identityId}`, as);
  if (answered.status !== 200) throw new Error(`Erasure answered ${answered.status}: ${answered.text.slice(0, 300)}`);
}

/** A live segment (anyone with a country) in a project, through the API. */
export async function createSegmentIn(as: Caller, projectId: string): Promise<string> {
  const created = dataOf(
    await call('POST', `/api/projects/${projectId}/segments`, as, {
      name: `smswa-${randomBytes(3).toString('hex')}`,
      definition: { type: 'group', operator: 'and', children: [{ type: 'attribute', field: 'country', op: 'exists', value: null }] },
      evaluationMode: 'live',
    }),
  );
  return created.id;
}

export async function identitySecretOf(as: Caller, projectId: string): Promise<string> {
  return dataOf(await call('GET', `/api/projects/${projectId}/identity-secret`, as)).secret;
}

/** HMAC-SHA256 of the external id under the project's identity secret, as hex. */
export function userHashOf(secret: string, externalUserId: string): string {
  return createHmac('sha256', secret).update(externalUserId, 'utf8').digest('hex');
}

/** A phone number no other test draws: +91 98 and eight random digits. */
export function uniquePhone(): string {
  return `+9198${Array.from(randomBytes(8), (b) => String(b % 10)).join('')}`;
}

// ---- P1: campaign list, sender and Twilio cards, suppressions

export interface ListRowSeed {
  title?: string;
  status?: string;
  totalTokens?: number;
  successCount?: number;
  processedTokens?: number;
}

/**
 * A campaign row of any channel written straight into the table, with the counters the
 * campaign lists read, as a send of that channel leaves one.
 */
export async function seedListRow(
  projectId: string,
  channel: 'sms' | 'whatsapp' | 'push' | 'email',
  { title = `E2E ${channel} ${randomBytes(3).toString('hex')}`, status = 'sent', totalTokens = 1, successCount = 1, processedTokens }: ListRowSeed = {},
): Promise<{ id: string; title: string }> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs (project_id, title, channel, status, total_tokens, success_count, processed_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [projectId, title, channel, status, totalTokens, successCount, processedTokens ?? totalTokens],
  );
  return { id: row.id, title };
}

/** Switches the project's stored credential for `provider` off, as a connection the API can no longer read. */
export async function deactivateCredential(projectId: string, provider: string): Promise<void> {
  const rows = await sql(
    `UPDATE push_channel_credentials SET is_active = false WHERE project_id = $1 AND provider = $2 RETURNING id`,
    [projectId, provider],
  );
  if (rows.length !== 1) throw new Error(`No ${provider} credential row for ${projectId}`);
}

/** The Sender card's opt-in switch (its label has no htmlFor). */
export function smsOptInSwitch(page: Page): Locator {
  return page.getByText('Only text people who opted in', { exact: true }).locator('../..').getByRole('switch');
}

/** Records the requests the page makes whose method and URL match. */
export function recordRequests(page: Page, method: string, url: RegExp): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.method() === method && url.test(request.url())) seen.push(request.url());
  });
  return seen;
}

/** A campaign row of the SMS list by its title (exact cell text). */
export function campaignRow(page: Page, title: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: title, exact: true }) });
}

/** The project's activity rows of `action` as (actor id, details) pairs. */
export async function activityOf(projectId: string, action: string): Promise<Array<{ actor: string | null; details: any }>> {
  const rows = await activityRows(projectId, action);
  return rows.map((row) => ({ actor: row.actor_user_id, details: row.details }));
}

// ---- P1: SMS composer, WhatsApp page and provider settings

/** A live segment of the people whose trait `group` equals `value`, through the API. */
export async function traitSegment(as: Caller, projectId: string, value: string, name = `smswa-${value}-${randomBytes(3).toString('hex')}`): Promise<{ id: string; name: string }> {
  const created = dataOf(
    await call('POST', `/api/projects/${projectId}/segments`, as, {
      name,
      definition: { type: 'group', operator: 'and', children: [{ type: 'attribute', field: 'traits.group', op: 'eq', value }] },
      evaluationMode: 'live',
    }),
  );
  return { id: created.id, name };
}

/** Opens the SMS composer and waits for the project's SMS settings to have loaded. */
export async function openSmsComposer(page: Page, projectId: string, sender = DEFAULT_SENDER): Promise<void> {
  await page.goto(`/projects/${projectId}/sms/new`);
  await expect(page.getByRole('heading', { name: 'New text', exact: true })).toBeVisible();
  await expect(card(page, 'Preview').getByText(`From ${sender}. Tokens are filled in per person.`, { exact: true })).toBeVisible();
}

/** The segment counter under a text box (`scope`: the Message card or an A/B arm). */
export function segmentMeter(scope: Locator): Locator {
  return scope.locator('p').filter({ hasText: /left in this segment/ });
}

/** The text bubble of the SMS composer's Preview card. */
export function smsBubble(page: Page): Locator {
  return card(page, 'Preview').locator('div.whitespace-pre-wrap');
}

/** One A/B arm box of the SMS composer, by its key. */
export function armBox(page: Page, key: string): Locator {
  return card(page, 'A/B test')
    .locator('div.rounded-md.border')
    .filter({ has: page.getByText(`Arm ${key}`, { exact: true }) });
}

/** The switch beside a label of the composer's When or A/B card (labels have no htmlFor). */
export function labelledSwitch(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=ancestor::div[contains(@class,"justify-between")][1]').getByRole('switch');
}

/** A toast by title and description (several toasts can show at once). */
export function toastWith(page: Page, title: string, description: string): Locator {
  return toastTitled(page, title).filter({ hasText: description });
}

/** Records the JSON bodies the page posts to URLs matching `url`. */
export function recordBodies(page: Page, url: RegExp): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && url.test(request.url())) seen.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
  });
  return seen;
}

/** A tab of the WhatsApp Provider card by the provider's label. */
export function waProviderTab(page: Page, label: string): Locator {
  return card(page, 'Provider').getByRole('tab', { name: new RegExp(`^${label}`) });
}

/** The project's whatsapp credential rows (provider names), oldest first. */
export async function credentialProviders(projectId: string): Promise<string[]> {
  const rows = await sql<{ provider: string }>(`SELECT provider FROM push_channel_credentials WHERE project_id = $1 ORDER BY created_at`, [projectId]);
  return rows.map((row) => row.provider);
}

// ---- P1: WhatsApp composer, webhooks, campaign detail, cross-cutting

export type MockTemplate = {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  bodyText: string;
  bodyParamCount: number;
  paramNames: string[] | null;
  header: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION'; text: string | null; paramCount: number } | null;
  buttons: Array<{ type: string; text: string; dynamic: boolean }>;
};

/** Templates in the shape the API's template list answers, for a provider that lists them. */
export const MOCK_TEMPLATES: Record<'T1' | 'T2' | 'T3' | 'T4', MockTemplate> = {
  T1: {
    id: 'T1', name: 'T1', language: 'en', category: 'UTILITY', status: 'APPROVED',
    bodyText: 'Hi {{1}}, your order {{2}} shipped', bodyParamCount: 2, paramNames: null, header: null, buttons: [],
  },
  T2: {
    id: 'T2', name: 'T2', language: 'en', category: null, status: 'APPROVED',
    bodyText: 'Our summer sale is on', bodyParamCount: 0, paramNames: null,
    header: { format: 'IMAGE', text: null, paramCount: 0 },
    buttons: [{ type: 'URL', text: 'Track', dynamic: true }],
  },
  T3: {
    id: 'T3', name: 'T3', language: 'en', category: 'MARKETING', status: 'PENDING',
    bodyText: 'Not yet approved', bodyParamCount: 0, paramNames: null, header: null, buttons: [],
  },
  T4: {
    id: 'T4', name: 'T4', language: 'en', category: null, status: 'APPROVED',
    bodyText: 'Hello {{name}}', bodyParamCount: 1, paramNames: ['name'],
    header: { format: 'TEXT', text: 'Order {{1}}', paramCount: 1 }, buttons: [],
  },
};

/**
 * Answers the composer's template list (`GET /api/whatsapp/templates/<id>`) with
 * `templates`, in the API's envelope; answers how many times it was asked.
 */
export async function mockTemplateList(page: Page, templates: MockTemplate[], canList = true): Promise<{ requests: () => number }> {
  let requests = 0;
  await page.route('**/api/whatsapp/templates/**', async (route) => {
    requests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { canList, templates } }) });
  });
  return { requests: () => requests };
}

/** The input under a label of the WhatsApp composer's template fields (those labels have no htmlFor). */
export function labelledInput(scope: Page | Locator, label: string): Locator {
  return scope.getByText(label, { exact: true }).locator('xpath=..').locator('input');
}

/** The red problem line of the WhatsApp composer's Message card. */
export function waProblem(page: Page): Locator {
  return card(page, 'Message').locator('p.text-destructive');
}

/** The message bubble of the WhatsApp composer's Preview card. */
export function waBubble(page: Page): Locator {
  return card(page, 'Preview').locator('div.whitespace-pre-wrap');
}

/** Opens the WhatsApp composer and waits for its settings to have loaded. */
export async function openWaComposer(page: Page, projectId: string): Promise<void> {
  const settings = page.waitForResponse((r) => r.url().includes(`/api/whatsapp/settings/${projectId}`) && r.request().method() === 'GET');
  await page.goto(`/projects/${projectId}/whatsapp/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'New WhatsApp campaign', exact: true })).toBeVisible();
  await settings;
}

/**
 * Holds the page's requests matching `url` until `release` is called (for states shown
 * while a request is in flight).
 */
export async function holdRequests(page: Page, url: string): Promise<{ release: () => void; held: () => number }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let held = 0;
  await page.route(url, async (route) => {
    held += 1;
    await gate;
    await route.continue();
  });
  return { release: () => open(), held: () => held };
}

/** A live segment of the people whose trait `field` equals `value`, through the API. */
export async function traitFieldSegment(as: Caller, projectId: string, field: string, value: string): Promise<{ id: string; name: string }> {
  const name = `smswa-${field}-${value}-${randomBytes(3).toString('hex')}`;
  const created = dataOf(
    await call('POST', `/api/projects/${projectId}/segments`, as, {
      name,
      definition: { type: 'group', operator: 'and', children: [{ type: 'attribute', field: `traits.${field}`, op: 'eq', value }] },
      evaluationMode: 'live',
    }),
  );
  return { id: created.id, name };
}

/** Merges `traits` into a device row's traits, as a later identify with them would. */
export async function setTraits(identityId: string, traits: Record<string, unknown>): Promise<void> {
  const rows = await sql(`UPDATE device_identities SET traits = coalesce(traits, '{}'::jsonb) || $2::jsonb WHERE id = $1 RETURNING id`, [identityId, JSON.stringify(traits)]);
  if (rows.length !== 1) throw new Error(`No device row ${identityId}`);
}

/** The SDK's identify route, answering the status and body instead of throwing. */
export async function identifyRaw(p: Pick<SmsProject, 'project' | 'sdkKey'>, ip: string, person: Record<string, unknown>): Promise<RawResponse> {
  const response = await fetch(apiUrl('/api/identity/identify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': p.sdkKey, 'X-Forwarded-For': ip },
    body: JSON.stringify({ projectId: p.project.id, deviceFingerprint: `smswa-${randomBytes(8).toString('hex')}`, platform: 'web', ...person }),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON.
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

/**
 * A Twilio form post whose parameters may repeat (`Tag=b&Tag=a`), signed over
 * `signParams` (the posted ones unless given) as Twilio signs repeated parameters.
 */
export async function postTwilioForm(
  path: string,
  params: Record<string, string | string[]>,
  { authToken, signParams }: { authToken: string; signParams?: Record<string, string | string[]> },
): Promise<RawResponse> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) form.append(key, item);
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': newClientIp(),
      'X-Twilio-Signature': twilioSignature(authToken, publicApiUrl(path), signParams ?? params),
    },
    body: form.toString(),
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

/** One `push_notification_events` row, as a provider report leaves one. */
export async function seedEventRow(projectId: string, campaignId: string, identityId: string, type: string, platform: string): Promise<void> {
  await sql(
    `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, platform, occurred_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [projectId, campaignId, identityId, type, platform],
  );
}

export interface DetailRowSeed {
  title: string;
  status?: string;
  body?: string | null;
  totalTokens?: number;
  successCount?: number;
  failureCount?: number;
  failureDetails?: Array<{ token: string; error: string }> | null;
  whatsappContent?: Record<string, unknown> | null;
}

/** A finished campaign row of `channel` with the fields the detail page reads. */
export async function seedDetailRow(projectId: string, channel: 'sms' | 'whatsapp', seed: DetailRowSeed): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs
       (project_id, title, body, channel, status, total_tokens, success_count, failure_count, processed_tokens,
        failure_details, whatsapp_content, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6, $9::jsonb, $10::jsonb, now())
     RETURNING id`,
    [
      projectId,
      seed.title,
      seed.body ?? null,
      channel,
      seed.status ?? 'sent',
      seed.totalTokens ?? 1,
      seed.successCount ?? 1,
      seed.failureCount ?? 0,
      seed.failureDetails ? JSON.stringify(seed.failureDetails) : null,
      seed.whatsappContent ? JSON.stringify(seed.whatsappContent) : null,
    ],
  );
  return row.id;
}

/** An engagement card of the campaign detail page by its label (`Delivered`, `Read`, ...). */
export function engagementValue(page: Page, label: string): Locator {
  return card(page, 'Engagement')
    .locator('div.rounded-lg.border')
    .filter({ has: page.locator('div.text-xs', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) })
    .locator('p.text-2xl');
}

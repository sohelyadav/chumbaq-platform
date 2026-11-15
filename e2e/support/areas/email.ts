import { randomBytes } from 'crypto';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../api';
import {
  DEFAULT_EMAIL_SENDER,
  seedEmailCredentials,
  type EmailProviderName,
  type EmailSender,
  type SeededEmail,
} from '../channels';
import { adminApi, enrolAndSignInStaff } from '../admin';
import { newPersonContext } from '../fixtures';
import { stubCalls } from '../provider-stub';
import { signSvix } from '../signing';
import { assertE2eDatabase, stackEnv } from '../stack';

/**
 * Helpers for the email specs (EMAIL): projects with a sender saved through the API and
 * a provider seeded (the real connect checks the key with the provider), people with
 * addresses through the SDK's identify route, teammates with a role, raw requests that
 * answer status and body, and SQL reads of the rows the API writes.
 */

export const PROJECT_NOT_FOUND = 'Project not found';
export const NOT_SET_UP = 'Email is not set up for this project. Add a sender in Email settings.';
export const CONNECT_FIRST = 'Connect Amazon SES, Resend or Brevo in Email settings before sending.';
export const NOBODY_OPT_IN =
  'Nobody in this audience can be emailed. Email needs an address and, because this project requires opt-in, email_opt_in set to true.';
export const NOBODY_NO_OPT_IN = 'Nobody in this audience has an email address that is not unsubscribed or bounced.';
export const SUPPRESSED = 'This address is on the project’s suppression list.';
export const OPTED_OUT = 'This person has opted out of these messages.';
export const STOPPED_BY_SUSPENSION =
  'Stopped because this account was suspended. Anyone not yet reached did not receive this campaign, and it will not resume automatically.';
export const MISSED_DURING_SUSPENSION =
  'Not sent: this account was suspended when the campaign was due. It will not be sent automatically; schedule it again if it is still wanted.';

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

export async function emailSettingsRow(projectId: string): Promise<Record<string, any> | undefined> {
  const [row] = await sql(`SELECT * FROM email_settings WHERE project_id = $1`, [projectId]);
  return row;
}

export async function suppressionRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM channel_suppressions WHERE project_id = $1 AND channel = 'email' ORDER BY address`, [projectId]);
}

export async function consentRows(deviceIdentityId: string): Promise<Array<{ channel: string; granted: boolean; source: string }>> {
  return sql(
    `SELECT channel, granted, source FROM consent_events WHERE device_identity_id = $1 ORDER BY occurred_at, id`,
    [deviceIdentityId],
  );
}

export async function activityRows(projectId: string, action: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM project_activity WHERE project_id = $1 AND action = $2 ORDER BY occurred_at`, [projectId, action]);
}

export async function campaignRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_notification_logs WHERE project_id = $1 ORDER BY sent_at`, [projectId]);
}

/** Marks an address as confirmed (double opt-in), as the confirmation link leaves it. */
export async function confirmEmail(deviceIdentityId: string): Promise<void> {
  const rows = await sql(`UPDATE device_identities SET email_confirmed_at = now() WHERE id = $1 RETURNING id`, [deviceIdentityId]);
  if (rows.length !== 1) throw new Error(`No device_identities row ${deviceIdentityId}`);
}

/**
 * Marks the account suspended the way staff suspending it leaves it: `suspended_at`
 * set (all ProjectSuspensionService and the JWT checks read), sessions ended.
 */
export async function suspendAccount(userId: string): Promise<void> {
  const rows = await sql(
    `UPDATE users SET suspended_at = now(), session_version = session_version + 1 WHERE id = $1 RETURNING id`,
    [userId],
  );
  if (rows.length !== 1) throw new Error(`No users row ${userId}`);
}

export async function reactivateAccount(userId: string): Promise<void> {
  const rows = await sql(`UPDATE users SET suspended_at = NULL WHERE id = $1 RETURNING id`, [userId]);
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

export async function call(method: string, path: string, as: Caller | null, body?: unknown): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': as?.ip ?? newClientIp(),
      ...(as ? { Authorization: `Bearer ${as.accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return rawOf(response);
}

/** A request with no session and a body as given (a form, a mail client's one-click POST). */
export async function publicRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: { contentType: string; text: string },
): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'X-Forwarded-For': newClientIp(),
      ...(body ? { 'Content-Type': body.contentType } : {}),
    },
    body: body?.text,
    redirect: 'manual',
  });
  return rawOf(response);
}

async function rawOf(response: Response): Promise<RawResponse> {
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

export async function newPerson(label: string, name = 'Em Email'): Promise<Person> {
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
  const person = await newPerson(`email-${role}`, `Tia ${role}`);
  await addMember(projectId, person, role, owner);
  return person;
}

// ---- Projects

export interface EmailProject {
  owner: Person;
  project: Project;
  sdkKey: string;
  /** Present once a provider is seeded. */
  email?: SeededEmail<EmailProviderName>;
}

/** Saves the email sender through the API, as the Settings form does. */
export async function saveSender(as: Caller, projectId: string, sender: Partial<EmailSender> = {}): Promise<any> {
  const merged = { ...DEFAULT_EMAIL_SENDER, ...sender };
  return dataOf(
    await call('POST', '/api/email/settings', as, {
      projectId,
      fromEmail: merged.fromEmail,
      ...(merged.fromName ? { fromName: merged.fromName } : {}),
      ...(merged.replyTo ? { replyTo: merged.replyTo } : {}),
      postalAddress: merged.postalAddress,
      ...(merged.requireOptIn !== undefined ? { requireOptIn: merged.requireOptIn } : {}),
    }),
  );
}

/**
 * A project of a new owner with an SDK key. `sender` saves the sender through the API;
 * `provider` (implies the sender) also seeds that provider's credentials, made active.
 */
export async function emailProject(
  label: string,
  { sender = false, provider, requireOptIn }: { sender?: boolean; provider?: EmailProviderName; requireOptIn?: boolean } = {},
  owner?: Person,
): Promise<EmailProject> {
  const person = owner ?? (await newPerson(label, 'Owen Owner'));
  const project = await createProject(person, person.ip);
  const sdkKey = await createApiKey(person, project.id, person.ip);
  const made: EmailProject = { owner: person, project, sdkKey };
  if (sender || provider) await saveSender(person, project.id, { requireOptIn });
  if (provider) made.email = await seedEmailCredentials(project.id, provider);
  return made;
}

export interface EmailPerson {
  email?: string;
  emailOptIn?: boolean;
  firstName?: string;
  traits?: Record<string, unknown>;
}

/** One device through the SDK's identify route; answers its device identity id. */
export async function identifyEmail(p: Pick<EmailProject, 'project' | 'sdkKey'>, ip: string, person: EmailPerson): Promise<string> {
  const identity = await api<{ id: string }>(
    'POST',
    '/api/identity/identify',
    {
      projectId: p.project.id,
      deviceFingerprint: `email-${randomBytes(8).toString('hex')}`,
      platform: 'web',
      ...person,
    },
    { apiKey: p.sdkKey, ip },
  );
  return identity.id;
}

/** The catalogue's people E1 to E8, by key. */
export const PEOPLE: Record<string, EmailPerson> = {
  E1: { email: 'e1@example.test', emailOptIn: true, firstName: 'Asha' },
  E2: { email: 'e2@example.test', emailOptIn: true, firstName: 'Bela' },
  E3: { email: 'e3@example.test', emailOptIn: false, firstName: 'Chen' },
  E4: { firstName: 'Noaddress' },
  E5: { email: 'e5@example.test', firstName: 'Esha' },
  E6: { email: 'shared@example.test', emailOptIn: true },
  E7: { email: 'shared@example.test', emailOptIn: true },
  E8: { email: 'shared@example.test', emailOptIn: false },
};

/** Identifies the named people (in the order given); answers their identity ids by key. */
export async function seedPeople(p: Pick<EmailProject, 'project' | 'sdkKey'>, ip: string, keys: string[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const key of keys) ids[key] = await identifyEmail(p, ip, PEOPLE[key]);
  return ids;
}

export async function emailPreview(as: Caller, projectId: string): Promise<{ targetType: string; recipients: number; requireOptIn: boolean }> {
  return dataOf(await call('POST', '/api/email/audience-preview', as, { projectId }));
}

export async function suppress(as: Caller, projectId: string, address: string): Promise<void> {
  dataOf(await call('POST', '/api/email/suppressions', as, { projectId, address }));
}

export async function emailSuppressionList(as: Caller, projectId: string): Promise<{ data: Array<Record<string, any>>; total: number }> {
  return dataOf(await call('GET', `/api/email/suppressions/${projectId}`, as));
}

/** An email campaign through the API; a month ahead unless `scheduledAt` says otherwise. */
export async function scheduleEmailCampaign(
  as: Caller,
  projectId: string,
  subject = 'Scheduled for later',
  scheduledAt: string | null = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
): Promise<Record<string, any>> {
  return dataOf(
    await call('POST', '/api/email/send', as, {
      projectId,
      subject,
      html: `<p>${subject}</p>`,
      ...(scheduledAt ? { scheduledAt } : {}),
    }),
  );
}

/** The calls the provider stub's Brevo received for one recipient address. */
export async function brevoCallsTo(address: string) {
  const wanted = address.trim().toLowerCase();
  return (await stubCalls('brevo')).filter(
    (entry) =>
      entry.method === 'POST' &&
      Array.isArray((entry.body as { to?: Array<{ email?: string }> } | null)?.to) &&
      (entry.body as { to: Array<{ email?: string }> }).to.some((to) => to.email?.toLowerCase() === wanted),
  );
}

// ---- Pages

/** Opens the Email page on a tab ('Campaigns', 'Suppressions' or 'Settings'). */
export async function openEmail(page: Page, projectId: string, tab: 'Campaigns' | 'Suppressions' | 'Settings'): Promise<void> {
  await page.goto(`/projects/${projectId}/email`);
  await page.getByRole('heading', { name: 'Email', exact: true }).waitFor();
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

/** The composer's reach line. */
export function reachLine(page: Page): Locator {
  return page.locator('p').filter({ has: page.locator('svg.lucide-users') });
}

/** "Only email people who opted in" (its Switch has no label of its own). */
export function optInSwitch(page: Page): Locator {
  return page.getByText('Only email people who opted in', { exact: true }).locator('../..').getByRole('switch');
}

/** Date as the suppression list shows it (date-fns `MMM d, yyyy`), in this machine's zone. */
export function sinceLabel(at: string | Date): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Date as the campaign list shows a scheduled time (date-fns `MMM d, HH:mm`). */
export function whenLabel(at: Date): string {
  const month = at.toLocaleString('en-US', { month: 'short' });
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${month} ${at.getDate()}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// ---- Second chunk: double opt-in, provider webhooks, view-as

export const ROLE_REFUSAL = 'Your role in this project does not allow this.';
export const READ_ONLY = 'Impersonation sessions are read-only';
export const HIDDEN_VALUE = 'hidden while viewing as tenant';
export const HIDDEN_FROM_ROLE = 'Only owners and admins can see this.';
export const NOTHING_DELIVERED =
  'Nothing was delivered: by the time this campaign ran, nobody in its audience could be emailed. People may have unsubscribed, bounced, withdrawn consent or reached the frequency cap since it was created.';

/** One device through the SDK's identify route under a fingerprint the caller keeps (to report it again). */
export async function identifyDevice(
  p: Pick<EmailProject, 'project' | 'sdkKey'>,
  ip: string,
  fingerprint: string,
  person: EmailPerson,
): Promise<string> {
  const identity = await api<{ id: string }>(
    'POST',
    '/api/identity/identify',
    { projectId: p.project.id, deviceFingerprint: fingerprint, platform: 'web', ...person },
    { apiKey: p.sdkKey, ip },
  );
  return identity.id;
}

/**
 * Records a confirmation mail as sent to `address` at `at` (to the millisecond), on every
 * row holding it, as the confirmation mailer's claim leaves them.
 */
export async function markConfirmSent(projectId: string, address: string, at: Date): Promise<void> {
  const rows = await sql(
    `UPDATE device_identities SET email_confirm_sent_at = $3 WHERE project_id = $1 AND email = $2 RETURNING id`,
    [projectId, address, at],
  );
  if (rows.length === 0) throw new Error(`Nobody in ${projectId} holds ${address}`);
}

export async function identityRows(projectId: string, address: string): Promise<Array<Record<string, any>>> {
  return sql(
    `SELECT id, email, email_opt_in, email_confirmed_at, email_confirm_sent_at FROM device_identities
      WHERE project_id = $1 AND email = $2 ORDER BY id`,
    [projectId, address],
  );
}

export async function eventRows(projectId: string): Promise<Array<Record<string, any>>> {
  return sql(
    `SELECT campaign_id, device_identity_id, type, platform, occurred_at FROM push_notification_events
      WHERE project_id = $1 ORDER BY created_at, type`,
    [projectId],
  );
}

export async function projectActivity(projectId: string): Promise<string[]> {
  return (await sql<{ action: string }>(`SELECT action FROM project_activity WHERE project_id = $1 ORDER BY occurred_at`, [projectId])).map(
    (row) => row.action,
  );
}

/** A copy of a campaign row under a new id in another channel (a push or SMS campaign of the same project). */
export async function cloneCampaign(id: string, channel: 'push' | 'sms'): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs
     SELECT (jsonb_populate_record(NULL::push_notification_logs,
               to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'channel', $2::text, 'email_content', NULL))).*
       FROM push_notification_logs l WHERE l.id = $1
     RETURNING id`,
    [id, channel],
  );
  if (!row) throw new Error(`No campaign ${id}`);
  return row.id;
}

/** The email campaign list as the Email page reads it. */
export async function emailLogs(as: Caller, projectId: string): Promise<Array<Record<string, any>>> {
  return dataOf<{ data: Array<Record<string, any>> }>(await call('GET', `/api/push-notifications/logs/${projectId}?channel=email`, as)).data;
}

/** A raw POST with no session, from an address of its own (a provider's webhook call). */
export async function webhookPost(
  path: string,
  text: string,
  { contentType = 'application/json', headers = {} }: { contentType?: string | null; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      'X-Forwarded-For': newClientIp(),
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...headers,
    },
    body: text,
  });
  return rawOf(response);
}

/** A Resend event body: `type`, now, and `data` with recipients and tags. */
export function resendEvent(
  type: string,
  to: string | string[],
  tags: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, created_at: new Date().toISOString(), data: { to: Array.isArray(to) ? to : [to], tags, ...extra } };
}

export function chumbaqTags(campaignId?: string, identityId?: string): Record<string, string> {
  return {
    ...(campaignId ? { chumbaq_campaign_id: campaignId } : {}),
    ...(identityId ? { chumbaq_identity_id: identityId } : {}),
  };
}

/** A Resend webhook post signed with `secret` (Svix), as Resend sends it. */
export async function postResend(
  webhookToken: string,
  secret: string,
  body: unknown,
  sign: { id?: string; timestamp?: number } = {},
): Promise<RawResponse> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return webhookPost(`/api/email/webhooks/resend/${webhookToken}`, raw, { headers: { ...signSvix(secret, raw, sign) } });
}

/** A Brevo event (Brevo signs nothing) with its tags as Chumbaq writes them. */
export function brevoEvent(event: string, email: string, campaignId?: string, identityId?: string, extra: Record<string, unknown> = {}) {
  return {
    event,
    email,
    tags: [
      ...(campaignId ? [`chumbaq_campaign_id:${campaignId}`] : []),
      ...(identityId ? [`chumbaq_identity_id:${identityId}`] : []),
    ],
    ts_event: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

export async function postBrevo(webhookToken: string, body: unknown): Promise<RawResponse> {
  return webhookPost(`/api/email/webhooks/brevo/${webhookToken}`, JSON.stringify(body));
}

/** SNS's certificate URL form for a region. */
export function snsCertUrl(region = 'ap-south-1', file = 'SimpleNotificationService-abc123.pem'): string {
  return `https://sns.${region}.amazonaws.com/${file}`;
}

/** An SNS message in the shape SNS posts (the signature itself is made up). */
export function snsMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Type: 'SubscriptionConfirmation',
    MessageId: `e2e-${randomBytes(8).toString('hex')}`,
    TopicArn: 'arn:aws:sns:ap-south-1:123456789012:t',
    Message: 'You have chosen to subscribe to the topic.',
    Timestamp: new Date().toISOString(),
    SignatureVersion: '1',
    Signature: Buffer.from('not a real signature').toString('base64'),
    SigningCertURL: snsCertUrl(),
    SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=y',
    Token: 'e2e-token',
    ...overrides,
  };
}

/** Posts to the SES route as SNS does: the JSON as `text/plain`. */
export async function postSes(webhookToken: string, body: unknown): Promise<RawResponse> {
  return webhookPost(`/api/email/webhooks/ses/${webhookToken}`, typeof body === 'string' ? body : JSON.stringify(body), {
    contentType: 'text/plain; charset=UTF-8',
  });
}

/**
 * Staff view-as of `tenant`: a new super admin (the flag set as `admin:grant` sets it)
 * enrols a passkey and signs in to the admin app in a browser of their own, and starts
 * view-as with a reason. Answers the one-time handoff link (`APP_URL/impersonate#code=`).
 */
export async function viewAsHandoff(browser: Browser, baseURL: string | undefined, tenant: Account): Promise<string> {
  const ip = newClientIp();
  const staff = await createAccount(ip, 'email-staff', 'Sid Staff');
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [staff.userId]);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const staffPage = await context.newPage();
    const staffToken = await enrolAndSignInStaff(staffPage, staff);
    const handoff = await adminApi<{ url: string }>(
      'POST',
      `/api/admin/tenants/${tenant.userId}/impersonate`,
      { reason: 'E2E: checking email pages read-only' },
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

// ---- P1 chunk: page shell, campaign list, suppressions, sender and provider settings

export type CampaignStatus = 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed' | 'partial' | 'expanded' | 'cancelled';

export interface SeedCampaign {
  subject: string;
  status?: CampaignStatus;
  channel?: 'email' | 'push' | 'sms';
  totalTokens?: number;
  successCount?: number;
  processedTokens?: number;
  scheduledAt?: Date | null;
  failureCount?: number;
  failureDetails?: Array<{ token: string; error: string }> | null;
  errorMessage?: string | null;
  preheader?: string | null;
  html?: string;
}

/**
 * A campaign row written straight into the table, as the worker or the scheduler leaves
 * one (no queue job, so nothing picks it up). Email rows carry their content, with the
 * title mirroring the subject as the send route writes it.
 */
export async function seedCampaign(projectId: string, c: SeedCampaign): Promise<string> {
  const channel = c.channel ?? 'email';
  const [row] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs
       (project_id, title, channel, status, total_tokens, success_count, processed_tokens, scheduled_at, email_content,
        failure_count, failure_details, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      projectId,
      c.subject,
      channel,
      c.status ?? 'sent',
      c.totalTokens ?? 1,
      c.successCount ?? 1,
      c.processedTokens ?? c.totalTokens ?? 1,
      c.scheduledAt ?? null,
      channel === 'email'
        ? JSON.stringify({ subject: c.subject, html: c.html ?? `<p>${c.subject}</p>`, text: null, preheader: c.preheader ?? null })
        : null,
      c.failureCount ?? 0,
      c.failureDetails ? JSON.stringify(c.failureDetails) : null,
      c.errorMessage ?? null,
    ],
  );
  return row.id;
}

/** A provider event for (campaign, identity), as the webhook ingest stores one. */
export async function seedCampaignEvent(
  projectId: string,
  campaignId: string,
  identityId: string,
  type: 'delivered' | 'impression' | 'click' | 'bounced',
): Promise<void> {
  await sql(
    `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, platform, occurred_at)
     VALUES ($1, $2, $3, $4, 'email', now())`,
    [projectId, campaignId, identityId, type],
  );
}

/** The row of the campaign list whose subject is `subject`. */
export function campaignRow(page: Page, subject: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: subject, exact: true }) });
}

/** The cells of a table row, as text. */
export async function cellTexts(row: Locator): Promise<string[]> {
  return (await row.getByRole('cell').allInnerTexts()).map((text) => text.trim());
}

/** The webhook URL shown in the Provider card's Delivery events box. */
export function webhookCode(page: Page): Locator {
  return page.locator('code').filter({ hasText: '/api/email/webhooks/' });
}

/** A tab of the Provider card (its name may carry an `Active` badge). */
export function providerTab(page: Page, label: 'Resend' | 'Amazon SES' | 'Brevo'): Locator {
  return page.getByRole('tab', { name: new RegExp(`^${label}(\\s*Active)?$`) });
}

/** Credential rows stored for a project, by provider. */
export async function credentialProviders(projectId: string): Promise<string[]> {
  return (
    await sql<{ provider: string }>(`SELECT provider FROM push_channel_credentials WHERE project_id = $1 ORDER BY provider`, [projectId])
  ).map((row) => row.provider);
}

/** The toast with this title and description (shadcn toasts stack, so match on both). */
export function toastWith(page: Page, title: string, description: string): Locator {
  return page
    .locator('li')
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.getByText(description, { exact: true }) });
}

// ---- Second P1 chunk: composer, campaign page, delivery, unsubscribe and confirmation pages

/** A live segment through the API, answering its id. */
export async function createLiveSegment(as: Caller, projectId: string, name: string, definition: Record<string, unknown>): Promise<string> {
  return dataOf<{ id: string }>(
    await call('POST', `/api/projects/${projectId}/segments`, as, { name, definition, evaluationMode: 'live', status: 'active' }),
  ).id;
}

/** A segment definition matching people whose `traits.plan` equals `plan`. */
export function planIs(plan: string): Record<string, unknown> {
  return { type: 'group', operator: 'and', children: [{ type: 'attribute', field: 'traits.plan', op: 'eq', value: plan }] };
}

/** One arm's box in the composer's A/B test card. */
export function armBox(page: Page, key: string): Locator {
  return page.locator('div.rounded-md.border.p-3').filter({ has: page.getByText(`Arm ${key}`, { exact: true }) });
}

/** The figure of a stat tile ("Delivered", "Failed", ...) inside a card of the campaign page. */
export function statTile(container: Locator, label: string): Locator {
  return container
    .locator('div.rounded-lg.border.p-4')
    .filter({ has: container.page().locator('div.text-xs', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) })
    .locator('p.text-2xl');
}

/** Holds POSTs whose path ends with `suffix` until the returned function is called. */
export async function holdPosts(page: Page, suffix: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname.endsWith(suffix),
    async (route) => {
      if (route.request().method() === 'POST') await gate;
      await route.continue();
    },
  );
  return release;
}

/** The bodies of the POSTs the page sends to a path ending with `suffix`. */
export function recordPosts(page: Page, suffix: string): Array<Record<string, any>> {
  const seen: Array<Record<string, any>> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(suffix)) {
      seen.push((request.postDataJSON() ?? {}) as Record<string, any>);
    }
  });
  return seen;
}

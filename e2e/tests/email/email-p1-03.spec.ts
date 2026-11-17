import { randomBytes } from 'crypto';
import { apiUrl, newClientIp, uniqueEmail } from '../../support/api';
import { fakeSvixSecret, seedEmailCredentials } from '../../support/channels';
import { allowClipboard, readClipboard } from '../../support/browser-tools';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { failStub } from '../../support/provider-stub';
import { pathAndQuery, publicApiUrl, signConfirmLink, signUnsubscribeLink } from '../../support/signing';
import {
  activityRows,
  allActivity,
  appUrl,
  armBox,
  brevoCallsTo,
  brevoEvent,
  call,
  campaignRow,
  campaignRows,
  card,
  cellTexts,
  chumbaqTags,
  consentRows,
  createLiveSegment,
  dataOf,
  emailPreview,
  emailProject,
  emailSettingsRow,
  eventRows,
  HIDDEN_FROM_ROLE,
  HIDDEN_VALUE,
  identifyEmail,
  identityRows,
  linkRows,
  messageOf,
  openEmail,
  openViewAs,
  pickNextMonth,
  planIs,
  postBrevo,
  postResend,
  postSes,
  projectActivity,
  providerTab,
  publicRequest,
  reachLine,
  READ_ONLY,
  holdPosts,
  resendEvent,
  rewriteLinks,
  saveSender,
  scheduleEmailCampaign,
  seedCampaignRow,
  seedManyPeople,
  seedPeople,
  snsMessage,
  sql,
  STOPPED_BY_SUSPENSION,
  suppress,
  suppressionRows,
  suspendAccount,
  svixParts,
  teammate,
  toasts,
  toastWith,
  traitIs,
  viewAsHandoff,
  viewAsToken,
  webhookCode,
  webhookPost,
  whenLabel,
} from '../../support/areas/email';

/**
 * Email, P1: every Resend and Brevo event type, transient bounces, repeated events,
 * Resend refusals (no signing secret, unknown or rotated tokens, Svix timestamps,
 * versions and several signatures), SES refusals before any certificate fetch (unknown
 * token, a switched topic, fields the signature covers), the link rewrite route, what
 * members and admins can do, the activity log entries, a suspended billing owner, the
 * composer when its preview fails, a segment over 25,000 members, replaced Resend and SES
 * credentials, the campaign list with child campaigns, Settings that fail to load,
 * schedules combined with timezones and experiments, the confirmation mailer, an
 * unsubscribe link the suppression store refuses, and view-as on Settings. Providers are
 * seeded or reach the provider stub; campaign rows and their events are written as the
 * worker and the webhook ingest leave them; SES messages are refused before any request
 * to AWS.
 */

test.describe.configure({ mode: 'parallel' });

const FORM = { contentType: 'application/x-www-form-urlencoded', text: '' };
const TOPIC = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events';
const NO_TOPIC_YET =
  'No SNS topic is confirmed for this webhook yet. Subscribe the topic to this URL again so SNS sends a confirmation.';
const NO_RESEND_SECRET = 'Add the Resend webhook signing secret in Email settings to receive events.';
const NOT_SET_UP_CARD = 'Email is not set up yet. Add a sender and connect a provider under Settings.';
const SUSPENDED = "This project's account is suspended.";

const sendButton = (page: import('@playwright/test').Page, name = 'Send email') =>
  card(page, 'Preview').getByRole('button', { name, exact: true });

const scheduleSwitch = (page: import('@playwright/test').Page) =>
  page.getByText('Schedule for later', { exact: true }).locator('..').getByRole('switch');

const localTimeSwitch = (page: import('@playwright/test').Page) =>
  page.getByText("Deliver in each recipient's timezone", { exact: true }).locator('../..').getByRole('switch');

async function resendProject(label: string) {
  const p = await emailProject(label, { provider: 'resend', requireOptIn: false });
  const ids = await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  const campaign = await scheduleEmailCampaign(p.owner, p.project.id, `Resend campaign ${label}`);
  const email = p.email!;
  const secret = (email.credentials as { webhookSecret: string }).webhookSecret;
  return { ...p, ids, campaignId: campaign.id as string, token: email.webhookToken, secret };
}

async function brevoProject(label: string) {
  const p = await emailProject(label, { provider: 'brevo', requireOptIn: false });
  const ids = await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  const campaign = await scheduleEmailCampaign(p.owner, p.project.id, `Brevo campaign ${label}`);
  return { ...p, ids, campaignId: campaign.id as string, token: p.email!.webhookToken };
}

async function sesProject(label: string, topic: string | null = null) {
  const p = await emailProject(label, { provider: 'ses', requireOptIn: false });
  if (topic) await sql(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [p.project.id, topic]);
  return { ...p, token: p.email!.webhookToken };
}

/** Event rows as `type:identity`, sorted. */
const eventKeys = async (projectId: string) =>
  (await eventRows(projectId)).map((row) => `${row.type}:${row.device_identity_id}`).sort();

// ------------------------------------------------------------ L. Resend webhook ---

test('EMAIL-154 every Resend event type', async () => {
  const p = await resendProject('email-154');
  const e1 = chumbaqTags(p.campaignId, p.ids.E1);
  const e2 = chumbaqTags(p.campaignId, p.ids.E2);
  const outcomes: Array<[string, unknown, number]> = [
    ['opened', resendEvent('email.opened', 'e1@example.test', e1), 1],
    ['clicked', resendEvent('email.clicked', 'e1@example.test', e1), 1],
    [
      'permanent bounce',
      resendEvent('email.bounced', 'e1@example.test', e1, { bounce: { type: 'Permanent', subType: 'General', message: 'Mailbox does not exist' } }),
      1,
    ],
    ['complained', resendEvent('email.complained', 'e2@example.test', e2), 1],
    ['sent (not recorded)', resendEvent('email.sent', 'e2@example.test', e2), 0],
  ];
  for (const [label, body, recorded] of outcomes) {
    const answered = await postResend(p.token, p.secret, body);
    expect(answered.status, label).toBe(200);
    expect(answered.body, label).toEqual({ data: { recorded } });
  }

  expect(await eventKeys(p.project.id)).toEqual(
    [`impression:${p.ids.E1}`, `click:${p.ids.E1}`, `bounced:${p.ids.E1}`, `complained:${p.ids.E2}`].sort(),
  );
  for (const row of await eventRows(p.project.id)) {
    expect(row).toMatchObject({ campaign_id: p.campaignId, platform: 'email' });
  }
  expect((await suppressionRows(p.project.id)).map((row) => [row.address, row.reason, row.detail])).toEqual([
    ['e1@example.test', 'bounced', 'General: Mailbox does not exist'],
    ['e2@example.test', 'complained', null],
  ]);
  // A signed complaint is the person saying no; a bounce is not consent.
  expect(await consentRows(p.ids.E2)).toContainEqual({ channel: 'email', granted: false, source: 'complaint' });
  expect(await consentRows(p.ids.E1)).not.toContainEqual(expect.objectContaining({ granted: false }));
});

test('EMAIL-155 transient bounce does not suppress', async () => {
  const p = await resendProject('email-155');
  const tags = chumbaqTags(p.campaignId, p.ids.E1);

  const transient = await postResend(
    p.token,
    p.secret,
    resendEvent('email.bounced', 'e1@example.test', tags, { bounce: { type: 'Transient', subType: 'MailboxFull', message: 'Mailbox full' } }),
  );
  expect(transient.status).toBe(200);
  expect(transient.body).toEqual({ data: { recorded: 1 } });
  expect(await eventKeys(p.project.id)).toEqual([`bounced:${p.ids.E1}`]);
  expect(await suppressionRows(p.project.id)).toEqual([]);

  // The same bounce reported as permanent does suppress, so the difference is the type.
  await postResend(
    p.token,
    p.secret,
    resendEvent('email.bounced', 'e1@example.test', tags, { bounce: { type: 'Permanent', subType: 'General', message: 'Gone' } }),
  );
  expect((await suppressionRows(p.project.id)).map((row) => [row.address, row.reason])).toEqual([['e1@example.test', 'bounced']]);
});

test('EMAIL-157 repeated event stored once', async () => {
  const p = await resendProject('email-157');
  const body = JSON.stringify(resendEvent('email.opened', 'e1@example.test', chumbaqTags(p.campaignId, p.ids.E1)));

  const first = await postResend(p.token, p.secret, body, { id: `msg_${randomBytes(6).toString('hex')}` });
  const second = await postResend(p.token, p.secret, body, { id: `msg_${randomBytes(6).toString('hex')}` });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.body).toEqual({ data: { recorded: 1 } });
  expect(await eventKeys(p.project.id)).toEqual([`impression:${p.ids.E1}`]);
});

test('EMAIL-159 no signing secret stored', async () => {
  const p = await emailProject('email-159', { sender: true });
  const apiKey = `re_e2e_nosecret${randomBytes(4).toString('hex')}`;
  const seeded = await seedEmailCredentials(p.project.id, 'resend', { credentials: { apiKey } });
  const people = await seedPeople(p, p.owner.ip, ['E1']);
  const body = resendEvent('email.bounced', 'e1@example.test', chumbaqTags(undefined, people.E1), {
    bounce: { type: 'Permanent', subType: 'General', message: 'Gone' },
  });

  for (const [label, response] of [
    ['unsigned', await webhookPost(`/api/email/webhooks/resend/${seeded.webhookToken}`, JSON.stringify(body))],
    ['signed with some secret', await postResend(seeded.webhookToken, fakeSvixSecret(), body)],
  ] as const) {
    expect(response.status, label).toBe(400);
    expect(messageOf(response), label).toBe(NO_RESEND_SECRET);
  }
  expect(await suppressionRows(p.project.id)).toEqual([]);
  expect(await eventRows(p.project.id)).toEqual([]);
});

test('EMAIL-160 Resend: unknown, malformed or rotated-away token', async () => {
  const p = await resendProject('email-160');
  const body = resendEvent('email.opened', 'e1@example.test', chumbaqTags(p.campaignId, p.ids.E1));

  for (const [label, token] of [
    ['abc', 'abc'],
    ['48 hex matching nothing', randomBytes(24).toString('hex')],
  ] as const) {
    const refused = await postResend(token, p.secret, body);
    expect(refused.status, label).toBe(404);
  }

  const rotated = await call('POST', `/api/email/settings/${p.project.id}/rotate-webhook-token`, p.owner);
  expect(rotated.status).toBe(201);
  const fresh = (await emailSettingsRow(p.project.id))!.webhook_token as string;
  expect(fresh).not.toBe(p.token);
  const old = await postResend(p.token, p.secret, body);
  expect(old.status).toBe(404);
  expect(await eventRows(p.project.id)).toEqual([]);

  // The new token takes the same event.
  const accepted = await postResend(fresh, p.secret, body);
  expect(accepted.body).toEqual({ data: { recorded: 1 } });
});

test('EMAIL-210 Svix header with several signatures (secret rotation) is accepted', async () => {
  const p = await resendProject('email-210');
  const raw = JSON.stringify(resendEvent('email.opened', 'e1@example.test', chumbaqTags(p.campaignId, p.ids.E1)));
  const path = `/api/email/webhooks/resend/${p.token}`;
  const wrong = Buffer.from(randomBytes(32)).toString('base64');

  const headerSets: Array<[string, (right: string) => string]> = [
    ['wrong then right', (right) => `v1,${wrong} v1,${right}`],
    ['right then wrong', (right) => `v1,${right} v1,${wrong}`],
    ['v2 then v1', (right) => `v2,${right} v1,${right}`],
  ];
  for (const [label, signature] of headerSets) {
    const id = `msg_${randomBytes(6).toString('hex')}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const { sign } = svixParts(p.secret, raw, id, timestamp);
    const answered = await webhookPost(path, raw, {
      headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature(sign) },
    });
    expect(answered.status, label).toBe(200);
    expect(answered.body, label).toEqual({ data: { recorded: 1 } });
  }
  expect(await eventKeys(p.project.id)).toEqual([`impression:${p.ids.E1}`]);
});

test('EMAIL-211 Svix timestamp and version refusals', async () => {
  const p = await resendProject('email-211');
  const raw = JSON.stringify(
    resendEvent('email.bounced', 'e1@example.test', chumbaqTags(p.campaignId, p.ids.E1), {
      bounce: { type: 'Permanent', subType: 'General', message: 'Gone' },
    }),
  );
  const path = `/api/email/webhooks/resend/${p.token}`;
  const now = Math.floor(Date.now() / 1000);
  const post = (id: string, timestamp: string, signature: (right: string) => string) =>
    webhookPost(path, raw, {
      headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature(svixParts(p.secret, raw, id, timestamp).sign) },
    });
  const newId = () => `msg_${randomBytes(6).toString('hex')}`;

  const refusals: Array<[string, () => Promise<Awaited<ReturnType<typeof post>>>]> = [
    ['6 minutes in the future', () => post(newId(), String(now + 6 * 60), (right) => `v1,${right}`)],
    ['v2 only', () => post(newId(), String(now), (right) => `v2,${right}`)],
    ['timestamp abc', () => post(newId(), 'abc', (right) => `v1,${right}`)],
    ['empty svix-id', () => post('', String(now), (right) => `v1,${right}`)],
    ['v1 with an empty value', () => post(newId(), String(now), () => 'v1,')],
  ];
  for (const [label, send] of refusals) {
    const refused = await send();
    expect(refused.status, label).toBe(401);
    expect(messageOf(refused), label).toBe('Signature did not verify.');
  }
  expect(await eventRows(p.project.id)).toEqual([]);
  expect(await suppressionRows(p.project.id)).toEqual([]);

  // 4 minutes in the future is inside the tolerance.
  const accepted = await post(newId(), String(now + 4 * 60), (right) => `v1,${right}`);
  expect(accepted.status).toBe(200);
  expect(accepted.body).toEqual({ data: { recorded: 1 } });
  expect((await suppressionRows(p.project.id)).map((row) => row.address)).toEqual(['e1@example.test']);
});

// ------------------------------------------------------------ M. Brevo webhook ---

test('EMAIL-165 every Brevo event type', async () => {
  const p = await brevoProject('email-165');
  const reason = { reason: 'mailbox gone' };
  // One person per inbox event, so each suppression keeps its own reason.
  const inboxEvents = ['hard_bounce', 'invalid_email', 'blocked', 'soft_bounce', 'spam', 'complaint', 'unsubscribed'] as const;
  const people: Record<string, { id: string; address: string }> = {};
  for (const event of inboxEvents) {
    const address = `${event.replace('_', '-')}@example.test`;
    people[event] = { id: await identifyEmail(p, p.owner.ip, { email: address, emailOptIn: true }), address };
  }

  const outcomes: Array<[string, string, string, number]> = [
    ['opened', 'e1@example.test', p.ids.E1, 1],
    ['unique_opened', 'e1@example.test', p.ids.E1, 1],
    ['proxy_open', 'e1@example.test', p.ids.E1, 1],
    ['click', 'e1@example.test', p.ids.E1, 1],
    ...inboxEvents.map((event): [string, string, string, number] => [event, people[event].address, people[event].id, event === 'unsubscribed' ? 0 : 1]),
    ['request', 'e1@example.test', p.ids.E1, 0],
  ];
  for (const [event, address, identity, recorded] of outcomes) {
    const answered = await postBrevo(p.token, brevoEvent(event, address, p.campaignId, identity, reason));
    expect(answered.status, event).toBe(200);
    expect(answered.body, event).toEqual({ data: { recorded } });
  }

  expect(await eventKeys(p.project.id)).toEqual(
    [
      `impression:${p.ids.E1}`,
      `click:${p.ids.E1}`,
      `bounced:${people.hard_bounce.id}`,
      `bounced:${people.invalid_email.id}`,
      `bounced:${people.blocked.id}`,
      `bounced:${people.soft_bounce.id}`,
      `complained:${people.spam.id}`,
      `complained:${people.complaint.id}`,
    ].sort(),
  );
  expect((await suppressionRows(p.project.id)).map((row) => [row.address, row.reason, row.detail])).toEqual([
    ['blocked@example.test', 'bounced', 'blocked: mailbox gone'],
    ['complaint@example.test', 'complained', null],
    ['hard-bounce@example.test', 'bounced', 'hard_bounce: mailbox gone'],
    ['invalid-email@example.test', 'bounced', 'invalid_email: mailbox gone'],
    ['spam@example.test', 'complained', null],
    ['unsubscribed@example.test', 'unsubscribed', null],
  ]);
  // Unsigned statements are honoured, recorded as unconfirmed.
  expect(await consentRows(people.unsubscribed.id)).toContainEqual({
    channel: 'email',
    granted: false,
    source: 'provider_unsubscribe_unsigned',
  });
  expect(await consentRows(people.spam.id)).toContainEqual({ channel: 'email', granted: false, source: 'complaint_unsigned' });
});

// ------------------------------------------------------------ N. SES webhook ---

test('EMAIL-173 SES: unknown token', async () => {
  const p = await sesProject('email-173');
  for (const token of [randomBytes(24).toString('hex'), 'short']) {
    const refused = await postSes(token, 'not json');
    expect(refused.status, token).toBe(404);
  }
  // The project's own token reaches the route, which refuses the body itself.
  const own = await postSes(p.token, 'not json');
  expect(own.status).toBe(400);
  expect(messageOf(own)).toBe('Body is not an SNS message.');
});

test('EMAIL-180 after Switch topic, only a new confirmation is accepted', async () => {
  const p = await sesProject('email-180', TOPIC);
  const fromOldTopic = () => snsMessage({ Type: 'Notification', TopicArn: TOPIC, Subject: 'Amazon SES Email Event Notification' });

  // Pinned: another topic is refused as foreign.
  const foreign = await postSes(p.token, snsMessage({ Type: 'Notification', TopicArn: 'arn:aws:sns:ap-south-1:123456789012:other' }));
  expect(foreign.status).toBe(403);
  expect(messageOf(foreign)).toBe('Events from this topic are not accepted. Reset the SES topic in Email settings to switch topics.');

  const reset = await call('POST', `/api/email/settings/${p.project.id}/reset-ses-topic`, p.owner);
  expect(reset.status).toBe(201);
  expect((await emailSettingsRow(p.project.id))!.ses_topic_arn).toBeNull();
  expect(await activityRows(p.project.id, 'email.ses_topic_reset')).toHaveLength(1);

  const old = await postSes(p.token, fromOldTopic());
  expect(old.status).toBe(403);
  expect(messageOf(old)).toBe(NO_TOPIC_YET);
  expect((await emailSettingsRow(p.project.id))!.ses_topic_arn).toBeNull();
  expect(await suppressionRows(p.project.id)).toEqual([]);
});

test('EMAIL-213 SES messages missing what the signature covers', async () => {
  const p = await sesProject('email-213');
  const cases: Array<[string, Record<string, unknown>]> = [
    ['SignatureVersion 3', { SignatureVersion: '3' }],
    ['no SignatureVersion', { SignatureVersion: undefined }],
    ['SignatureVersion as a number', { SignatureVersion: 1 }],
    ['no MessageId', { MessageId: undefined }],
    ['empty Signature', { Signature: '' }],
    ['Message as an object', { Message: { hello: 'world' } }],
    ['Timestamp as a number', { Timestamp: Date.now() }],
    ['account not 12 digits', { TopicArn: 'arn:aws:sns:ap-south-1:12345:t' }],
    ['no TopicArn', { TopicArn: undefined }],
  ];
  for (const [label, overrides] of cases) {
    const refused = await postSes(p.token, snsMessage(overrides));
    expect(refused.status, label).toBe(401);
    expect(messageOf(refused), label).toBe('Body is not a signed SNS message.');
  }
  // The same message whole passes this check and meets the next one (its age), so the
  // refusals above were the missing fields'.
  const whole = await postSes(p.token, snsMessage({ Timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }));
  expect(messageOf(whole)).toBe('Message is too old to accept.');
  expect((await emailSettingsRow(p.project.id))!.ses_topic_arn).toBeNull();
});

// ------------------------------------------------------------ O. Link rewrite ---

test('EMAIL-181 links in the HTML become short links', async () => {
  const p = await emailProject('email-181', { provider: 'brevo' });
  const before = await projectActivity(p.project.id);
  const html = `<a href="https://shop.example/a">A</a> <a href='http://shop.example/b?x=1'>B</a>`;

  const answered = await rewriteLinks(p.owner, p.project.id, html);
  expect(answered.status).toBe(201);
  const links = await linkRows(p.project.id);
  expect(links.map((link) => [link.long_url, link.title])).toEqual([
    ['https://shop.example/a', 'Email link: https://shop.example/a'],
    ['http://shop.example/b?x=1', 'Email link: http://shop.example/b?x=1'],
  ]);
  const [a, b] = links;
  expect(dataOf(answered)).toEqual({ html: `<a href="${appUrl()}/${a.short_code}">A</a> <a href="${appUrl()}/${b.short_code}">B</a>` });
  expect(await projectActivity(p.project.id)).toEqual(before);

  // Each code redirects a desktop browser to its URL.
  for (const link of links) {
    const response = await fetch(apiUrl(`/${link.short_code}`), {
      redirect: 'manual',
      headers: {
        'X-Forwarded-For': newClientIp(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    expect(response.status, link.long_url).toBe(302);
    expect(response.headers.get('location'), link.long_url).toBe(link.long_url);
  }
});

test('EMAIL-230 link rewrite refused in view-as', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const p = await emailProject('email-230', { provider: 'brevo' });
  const html = '<a href="https://shop.example/one">1</a> <a href="https://shop.example/two">2</a>';
  const viewAs = await viewAsToken(browser, baseURL, p.owner);

  const refused = await rewriteLinks(viewAs, p.project.id, html);
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe(READ_ONLY);
  expect(await linkRows(p.project.id)).toEqual([]);

  // The owner's own request with the same body creates both.
  expect((await rewriteLinks(p.owner, p.project.id, html)).status).toBe(201);
  expect(await linkRows(p.project.id)).toHaveLength(2);
});

// ------------------------------------------------------------ P. Roles and suspension ---

test('EMAIL-187 member can compose, send, suppress and lift', async ({ page }) => {
  const p = await emailProject('email-187', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  const member = await teammate(p.project.id, 'member', p.owner);
  const address = `lift-${randomBytes(3).toString('hex')}@example.test`;

  await signIn(page, member);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await page.getByLabel('Subject').fill('From a member');
  await scheduleSwitch(page).click();
  await pickNextMonth(page);
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
    sendButton(page, 'Schedule email').click(),
  ]);
  expect(created.status()).toBe(201);
  await expect(toastWith(page, 'Email scheduled', '2 recipient(s).')).toBeVisible();
  await expect(campaignRow(page, 'From a member')).toContainText('Scheduled');

  await openEmail(page, p.project.id, 'Suppressions');
  await page.getByPlaceholder('someone@example.com').fill(address);
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: address });
  await expect(row).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  const [lifted] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/email/suppressions/')),
    row.getByTitle('Resubscribe').click(),
  ]);
  expect(lifted.status()).toBe(200);
  await expect(row).toHaveCount(0);

  const rewritten = await rewriteLinks(member, p.project.id, '<a href="https://shop.example/member">M</a>');
  expect(rewritten.status).toBe(201);
  expect(await linkRows(p.project.id)).toHaveLength(1);

  const logged = (await allActivity(p.project.id)).filter((entry) =>
    ['campaign.scheduled', 'suppression.added', 'suppression.removed'].includes(entry.action),
  );
  expect(logged.map((entry) => [entry.action, entry.actor_user_id])).toEqual([
    ['campaign.scheduled', member.userId],
    ['suppression.added', member.userId],
    ['suppression.removed', member.userId],
  ]);
});

test("EMAIL-188 admin has the owner's email powers", async ({ page }) => {
  const p = await emailProject('email-188', { provider: 'brevo' });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const token = p.email!.webhookToken;
  const earlier = (await allActivity(p.project.id)).length;

  const read = dataOf(await call('GET', `/api/email/settings/${p.project.id}`, admin));
  expect(read.webhookUrls).toEqual({
    ses: publicApiUrl(`/api/email/webhooks/ses/${token}`),
    resend: publicApiUrl(`/api/email/webhooks/resend/${token}`),
    brevo: publicApiUrl(`/api/email/webhooks/brevo/${token}`),
  });

  await signIn(page, admin);
  await openEmail(page, p.project.id, 'Settings');
  await page.getByLabel('From name').fill('Admin News');
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(page.getByText('Sender saved', { exact: true })).toBeVisible();
  expect((await emailSettingsRow(p.project.id))!.from_name).toBe('Admin News');

  await expect(webhookCode(page)).toHaveText(publicApiUrl(`/api/email/webhooks/brevo/${token}`));
  const box = page.locator('div.rounded-md.border').filter({ has: page.getByText('Delivery events', { exact: true }) });
  await expect(box.getByRole('button').filter({ has: page.locator('svg.lucide-copy') })).toBeVisible();
  await expect(page.getByText(HIDDEN_FROM_ROLE)).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Replace URL' }).click();
  await expect(toastWith(page, 'Webhook URL replaced', 'Give your provider the new URL.')).toBeVisible();
  const fresh = (await emailSettingsRow(p.project.id))!.webhook_token as string;
  expect(fresh).not.toBe(token);
  await expect(webhookCode(page)).toHaveText(publicApiUrl(`/api/email/webhooks/brevo/${fresh}`));

  const logged = (await allActivity(p.project.id)).slice(earlier);
  expect(logged.map((entry) => [entry.action, entry.actor_user_id])).toEqual([
    ['channel.settings_changed', admin.userId],
    ['email.webhook_token_rotated', admin.userId],
  ]);
});

test('EMAIL-194 suspended billing owner: campaign creation still stored, never sent', async () => {
  test.setTimeout(120_000);
  const p = await emailProject('email-194', { provider: 'brevo', requireOptIn: false });
  const address = uniqueEmail('email-194');
  await identifyEmail(p, p.owner.ip, { email: address, emailOptIn: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);

  await suspendAccount(p.owner.userId);
  // Expected (current code): creating is not refused; the worker stops it.
  const queued = await call('POST', '/api/email/send', admin, { projectId: p.project.id, subject: 'While suspended', html: '<p>Hi</p>' });
  expect(queued.status).toBe(201);
  expect(dataOf(queued)).toMatchObject({ status: 'queued', channel: 'email' });

  const row = async () => (await sql(`SELECT status, error_message, success_count FROM push_notification_logs WHERE id = $1`, [dataOf(queued).id]))[0];
  await expect.poll(async () => (await row()).status, { timeout: 90_000, intervals: [1_000] }).toBe('failed');
  expect(await row()).toMatchObject({ error_message: STOPPED_BY_SUSPENSION, success_count: 0 });
  expect(await brevoCallsTo(address)).toHaveLength(0);
});

test('EMAIL-221 test send while the billing owner is suspended, in the UI', async ({ page }) => {
  const p = await emailProject('email-221', { provider: 'brevo', requireOptIn: false });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const to = uniqueEmail('email-221-qa');
  await suspendAccount(p.owner.userId);

  await signIn(page, admin);
  await openEmail(page, p.project.id, 'Settings');
  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('you@yourapp.com').fill(to);
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/test-send') && r.request().method() === 'POST'),
    testCard.getByRole('button', { name: 'Send test' }).click(),
  ]);
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { message: string }).message).toBe(SUSPENDED);
  await expect(testCard.locator('p.text-destructive')).toHaveText(SUSPENDED);

  await page.goto(`/projects/${p.project.id}/email/new`);
  await page.getByPlaceholder('Send a test to…').fill(to);
  await card(page, 'Preview').getByRole('button', { name: 'Test', exact: true }).click();
  await expect(toastWith(page, 'Test failed', SUSPENDED)).toBeVisible();
  // Still signed in: only "Account suspended" signs a person out.
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email/new$`));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'New email', exact: true })).toBeVisible();
  expect(await brevoCallsTo(to)).toHaveLength(0);
});

// ------------------------------------------------------------ Q. Activity log ---

test('EMAIL-198 each email action writes its entry', async () => {
  test.setTimeout(120_000);
  const p = await emailProject('email-198');
  const keys = [`xkeysib-e2e-${randomBytes(8).toString('hex')}`, `xkeysib-e2e-${randomBytes(8).toString('hex')}`];
  // Creating the project and its SDK key are logged too; only what follows is email's.
  const earlier = (await allActivity(p.project.id)).length;
  await saveSender(p.owner, p.project.id, { requireOptIn: false });
  await saveSender(p.owner, p.project.id, { requireOptIn: false, fromName: 'Renamed News' });
  for (const apiKey of keys) {
    const connected = await call('POST', '/api/email/providers', p.owner, {
      projectId: p.project.id,
      provider: 'brevo',
      credentials: JSON.stringify({ apiKey }),
    });
    expect(connected.status, messageOf(connected)).toBe(201);
  }
  const firstToken = (await emailSettingsRow(p.project.id))!.webhook_token as string;
  expect((await call('POST', `/api/email/settings/${p.project.id}/rotate-webhook-token`, p.owner)).status).toBe(201);
  const secondToken = (await emailSettingsRow(p.project.id))!.webhook_token as string;
  await sql(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [p.project.id, TOPIC]);
  expect((await call('POST', `/api/email/settings/${p.project.id}/reset-ses-topic`, p.owner)).status).toBe(201);
  await seedPeople(p, p.owner.ip, ['E1']);
  await scheduleEmailCampaign(p.owner, p.project.id, 'Later on');
  expect((await call('POST', '/api/email/send', p.owner, { projectId: p.project.id, subject: 'Right now', html: '<p>Now</p>' })).status).toBe(201);
  await suppress(p.owner, p.project.id, 'sam@example.test');
  expect((await call('DELETE', `/api/email/suppressions/${p.project.id}/sam%40example.test`, p.owner)).status).toBe(200);

  const rows = (await allActivity(p.project.id)).slice(earlier);
  expect(rows.map((row) => [row.action, row.details])).toEqual([
    ['channel.settings_changed', { channel: 'email', fields: ['fromEmail', 'fromName', 'replyTo', 'postalAddress', 'requireOptIn'] }],
    ['channel.settings_changed', { channel: 'email', fields: ['fromName'] }],
    ['channel.provider_changed', { channel: 'email', fields: ['provider', 'credentials'] }],
    ['channel.credentials_uploaded', { channel: 'email', fields: ['credentials'] }],
    ['email.webhook_token_rotated', null],
    ['email.ses_topic_reset', null],
    ['campaign.scheduled', { channel: 'email', audienceSize: 1 }],
    ['campaign.sent', { channel: 'email', audienceSize: 1 }],
    ['suppression.added', { channel: 'email', address: 's***@example.test' }],
    ['suppression.removed', { channel: 'email', address: 's***@example.test' }],
  ]);
  expect(rows.every((row) => row.actor_user_id === p.owner.userId)).toBe(true);
  const text = JSON.stringify(rows);
  for (const secret of [firstToken, secondToken, ...keys, 'sam@example.test', '/api/email/webhooks', TOPIC]) {
    expect(text, secret).not.toContain(secret);
  }
});

// ------------------------------------------------------------ R. Coverage additions ---

test('EMAIL-200 composer reach is unknown when the preview fails, and Send stays enabled', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await emailProject('email-200', { provider: 'brevo', requireOptIn: false });
  await identifyEmail(p, p.owner.ip, { email: 'e1@example.test', emailOptIn: true, traits: { plan: 'pro' } });
  await identifyEmail(p, p.owner.ip, { email: 'e2@example.test', emailOptIn: true, traits: { plan: 'pro' } });
  const name = `S-two ${randomBytes(2).toString('hex')}`;
  const segmentId = await createLiveSegment(p.owner, p.project.id, name, planIs('pro'));
  const gone = `Segment ${segmentId} not found`;

  await signIn(page, p.owner);
  const release = await holdPosts(page, '/api/email/audience-preview');
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('Counting…');
  release();
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await page.getByLabel('Subject').fill('Hi');
  // The segment list is loaded; now the segment goes.
  expect((await call('DELETE', `/api/projects/${p.project.id}/segments/${segmentId}`, p.owner)).status).toBe(200);

  const selects = card(page, 'Audience').getByRole('combobox');
  await selects.first().click();
  await page.getByRole('option', { name: 'A segment', exact: true }).click();
  await selects.nth(1).click();
  const [preview] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/audience-preview') && r.request().postDataJSON()?.segmentId === segmentId),
    page.getByRole('option', { name, exact: true }).click(),
  ]);
  expect(preview.status()).toBe(404);
  expect(((await preview.json()) as { message: string }).message).toBe(gone);
  await expect(reachLine(page)).toHaveText('Choose an audience to see its reach.');
  await expect(toasts(page)).toHaveCount(0);
  await expect(sendButton(page)).toBeEnabled();

  await sendButton(page).click();
  await expect(toastWith(page, 'Could not create email', gone)).toBeVisible();
  expect(await campaignRows(p.project.id)).toHaveLength(0);

  // View-as: the preview is a POST, refused read-only as the composer opens.
  const url = await viewAsHandoff(browser, baseURL, p.owner);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const viewAs = await context.newPage();
    await openViewAs(viewAs, url);
    const [refused] = await Promise.all([
      viewAs.waitForResponse((r) => r.url().endsWith('/api/email/audience-preview')),
      viewAs.goto(`/projects/${p.project.id}/email/new`),
    ]);
    expect(refused.status()).toBe(403);
    await expect(toasts(viewAs).filter({ hasText: 'Read-only session' }).first()).toContainText(READ_ONLY);
    await expect(reachLine(viewAs)).toHaveText('Choose an audience to see its reach.');
    await expect(sendButton(viewAs)).toBeDisabled();
    await viewAs.getByLabel('Subject').fill('From view-as');
    await expect(sendButton(viewAs)).toBeEnabled();
  } finally {
    await context.close();
  }
});

test('EMAIL-201 segment with more than 25,000 members is accepted for preview and send', async ({ page }) => {
  test.setTimeout(240_000);
  const p = await emailProject('email-201', { provider: 'brevo', requireOptIn: false });
  // S-big: 25,001 people in group "all" with an address, and one more member with none.
  // One person outside it, with an address.
  const tag = randomBytes(3).toString('hex');
  await seedManyPeople(p.project.id, `big-${tag}`, 25_001, { group: 'all' });
  const [noAddress] = await sql(
    `INSERT INTO device_identities (project_id, device_fingerprint, platform, traits)
     VALUES ($1, $2, 'web', '{"group":"all"}'::jsonb) RETURNING id`,
    [p.project.id, `big-${tag}-no-address`],
  );
  await seedManyPeople(p.project.id, `outside-${tag}`, 1, { group: 'other' });
  const [outside] = await sql(`SELECT id FROM device_identities WHERE project_id = $1 AND device_fingerprint = $2`, [
    p.project.id,
    `outside-${tag}-1`,
  ]);
  const big = { name: `S-big ${tag}`, id: await createLiveSegment(p.owner, p.project.id, `S-big ${tag}`, traitIs('group', 'all')) };

  const preview = await call('POST', '/api/email/audience-preview', p.owner, { projectId: p.project.id, segmentId: big.id });
  expect(preview.status, messageOf(preview)).toBe(201);
  expect(dataOf(preview)).toMatchObject({ targetType: 'segment', recipients: 25_001 });

  const sent = await call('POST', '/api/email/send', p.owner, {
    projectId: p.project.id,
    segmentId: big.id,
    subject: 'Everyone in it',
    html: '<p>x</p>',
    scheduledAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
  });
  expect(sent.status, messageOf(sent)).toBe(201);
  const apiId = dataOf<{ id: string }>(sent).id;

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('25002 recipient(s)', { timeout: 30_000 });
  await page.getByLabel('Subject').fill('From the composer');
  const selects = card(page, 'Audience').getByRole('combobox');
  await selects.first().click();
  await page.getByRole('option', { name: 'A segment', exact: true }).click();
  await selects.nth(1).click();
  const [previewed] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/audience-preview') && r.request().postDataJSON()?.segmentId === big.id, {
      timeout: 60_000,
    }),
    page.getByRole('option', { name: big.name, exact: true }).click(),
  ]);
  expect(previewed.status()).toBe(201);
  await expect(reachLine(page)).toHaveText('25001 recipient(s)');
  await scheduleSwitch(page).click();
  await pickNextMonth(page);
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST', { timeout: 60_000 }),
    sendButton(page, 'Schedule email').click(),
  ]);
  expect(created.status()).toBe(201);
  await expect(toastWith(page, 'Email scheduled', '25001 recipient(s).')).toBeVisible();
  const uiId = ((await created.json()) as { data: { id: string } }).data.id;

  const rows = await campaignRows(p.project.id);
  expect(rows.map((row) => row.id).sort()).toEqual([apiId, uiId].sort());
  for (const row of rows) {
    expect(row).toMatchObject({ target_type: 'segment', segment_id: big.id, total_tokens: 25_001, status: 'scheduled' });
    // Every member is a stored recipient, the one with no address too; nobody outside it is.
    const [stored] = await sql(
      `SELECT count(*)::int AS members,
              count(*) FILTER (WHERE device_identity_id = $2)::int AS no_address,
              count(*) FILTER (WHERE device_identity_id = $3)::int AS outside,
              count(*) FILTER (WHERE role <> 'target')::int AS other_roles
         FROM campaign_recipients WHERE campaign_id = $1`,
      [row.id, noAddress.id, outside.id],
    );
    expect(stored).toEqual({ members: 25_002, no_address: 1, outside: 0, other_roles: 0 });
  }
});

test('EMAIL-202 replacing Resend credentials without the secret drops the stored signing secret', async ({ page }) => {
  const p = await resendProject('email-202');
  const oldKey = (p.email!.credentials as { apiKey: string }).apiKey;
  const newKey = `re_e2e_new${randomBytes(6).toString('hex')}`;

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await expect(providerTab(page, 'Resend')).toHaveAttribute('aria-selected', 'true');
  const stored = card(page, 'Provider').locator('p').filter({ hasText: /^Key ending/ });
  await expect(stored).toHaveText(`Key ending ${oldKey.slice(-4)} is stored.`);
  await page.getByLabel('API key').fill(newKey);
  await expect(page.getByLabel('Webhook signing secret')).toHaveValue('');
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/email/providers') && r.method() === 'POST'),
    page.getByRole('button', { name: 'Replace and use Resend' }).click(),
  ]);
  expect(JSON.parse(request.postDataJSON().credentials)).toEqual({ apiKey: newKey });
  await expect(page.getByText('Resend connected', { exact: true })).toBeVisible();
  // Expected (current code): the stored JSON is replaced whole, secret and all.
  await expect(stored).toContainText(`Key ending ${newKey.slice(-4)} is stored.`);
  await expect(stored).toContainText('No webhook secret: bounces and opens will not be recorded.');
  await page.reload();
  await openEmail(page, p.project.id, 'Settings');
  await expect(stored).toContainText('No webhook secret: bounces and opens will not be recorded.');

  const refused = await postResend(p.token, p.secret, resendEvent('email.opened', 'e1@example.test', chumbaqTags(p.campaignId, p.ids.E1)));
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toBe(NO_RESEND_SECRET);
  expect((await activityRows(p.project.id, 'channel.credentials_uploaded')).map((row) => row.details)).toEqual([
    { channel: 'email', fields: ['credentials'] },
  ]);
});

test('EMAIL-203 re-connecting SES after a reload drops the configuration set', async ({ page }) => {
  const p = await emailProject('email-203', { sender: true });
  await seedEmailCredentials(p.project.id, 'ses', {
    credentials: { region: 'ap-south-1', accessKeyId: 'AKIAE2EFAKE00001234', secretAccessKey: 'e2e-fake-secret-access-key-0000000000000', configurationSetName: 'chumbaq-events' },
  });
  const typedKey = `AKIAE2E${randomBytes(6).toString('hex').toUpperCase()}`.slice(0, 20);

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await expect(providerTab(page, 'Amazon SES')).toHaveAttribute('aria-selected', 'true');
  const stored = card(page, 'Provider').locator('p').filter({ hasText: /^Access key ending/ });
  await expect(stored).toHaveText('Access key ending 1234 in ap-south-1, configuration set chumbaq-events');
  await expect(page.getByLabel('Region')).toHaveValue('ap-south-1');
  await expect(page.getByLabel('Configuration set')).toHaveValue('');
  await expect(page.getByLabel('Access key ID')).toHaveValue('');
  await expect(page.getByLabel('Secret access key')).toHaveValue('');
  const replace = page.getByRole('button', { name: 'Replace and use SES', exact: true });
  await expect(replace).toBeVisible();
  await expect(page.getByRole('button', { name: /Amazon SES$/ })).toHaveCount(0);

  // The connect checks the keys with AWS; the request it sends is what matters here.
  const sent: Array<Record<string, unknown>> = [];
  await page.route('**/api/email/providers', async (route) => {
    sent.push(JSON.parse(route.request().postDataJSON().credentials));
    await route.abort();
  });
  const typedSecret = 'e2e-typed-secret-access-key-00000000000';
  // Only the two key fields typed: the stored configuration set is not sent.
  await page.getByLabel('Access key ID').fill(typedKey);
  await page.getByLabel('Secret access key').fill(typedSecret);
  await replace.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ region: 'ap-south-1', accessKeyId: typedKey, secretAccessKey: typedSecret });
  await expect(toasts(page).filter({ hasText: 'Could not connect' })).toBeVisible();

  // A region other than the stored one is taken as typed.
  await page.getByLabel('Region').fill('eu-west-1');
  await replace.click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual({ region: 'eu-west-1', accessKeyId: typedKey, secretAccessKey: typedSecret });

  // What an accepted connect stores is exactly what was sent.
  await page.unroute('**/api/email/providers');
  await seedEmailCredentials(p.project.id, 'ses', { credentials: sent[0] as never });
  await page.reload();
  await openEmail(page, p.project.id, 'Settings');
  await expect(stored).toHaveText(
    `Access key ending ${typedKey.slice(-4)} in ap-south-1 (no configuration set: delivery events will not be recorded)`,
  );
});

test('EMAIL-206 child campaigns appear in the list next to their parent, newest created first', async ({ page }) => {
  const p = await emailProject('email-206', { provider: 'brevo' });
  const hours = (n: number) => new Date(Date.now() - n * 3600 * 1000);
  const nextMonday = (() => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return d;
  })();
  const nextMonth = (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 10, 11, 0, 0, 0);
  })();

  await seedCampaignRow(p.project.id, { subject: 'Later', status: 'scheduled', successCount: 0, processedTokens: 0, scheduledAt: nextMonth, createdAt: hours(26) });
  const experiment = await seedCampaignRow(p.project.id, {
    subject: 'Test',
    status: 'expanded',
    successCount: 0,
    createdAt: hours(10),
    variants: [{ key: 'A', title: 'Subject A', weight: 50 }, { key: 'B', title: 'Subject B', weight: 50 }],
  });
  await seedCampaignRow(p.project.id, { subject: 'Subject A', createdAt: hours(9), parentCampaignId: experiment, variantKey: 'A' });
  await seedCampaignRow(p.project.id, { subject: 'Subject B', createdAt: hours(8), parentCampaignId: experiment, variantKey: 'B' });
  const weekly = await seedCampaignRow(p.project.id, {
    subject: 'Weekly',
    status: 'scheduled',
    successCount: 0,
    processedTokens: 0,
    scheduledAt: nextMonday,
    createdAt: hours(7),
    recurrence: { frequency: 'weekly', interval: 1, atTime: '09:00', daysOfWeek: [1] },
  });
  await seedCampaignRow(p.project.id, { subject: 'Weekly', createdAt: hours(6), parentCampaignId: weekly });
  await seedCampaignRow(p.project.id, { subject: 'Weekly', createdAt: hours(5), parentCampaignId: weekly });
  const waves = await seedCampaignRow(p.project.id, { subject: 'Waves', status: 'expanded', successCount: 0, createdAt: hours(4) });
  await seedCampaignRow(p.project.id, { subject: 'Waves', createdAt: hours(3), parentCampaignId: waves });
  const newestWave = await seedCampaignRow(p.project.id, { subject: 'Waves', createdAt: hours(2), parentCampaignId: waves });
  await seedCampaignRow(p.project.id, { subject: 'Today', createdAt: hours(1) });

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Campaigns');
  const rows = page.locator('tbody tr');
  const expected: Array<[string, string]> = [
    ['Today', 'Sent'],
    ['Waves', 'Sent'],
    ['Waves', 'Sent'],
    ['Waves', 'Split'],
    ['Weekly', 'Sent'],
    ['Weekly', 'Sent'],
    ['Weekly', 'Scheduled'],
    ['Subject B', 'Sent'],
    ['Subject A', 'Sent'],
    ['Test', 'Split'],
    ['Later', 'Scheduled'],
  ];
  await expect(rows).toHaveCount(expected.length);
  for (const [i, [subject, status]] of expected.entries()) {
    const cells = await cellTexts(rows.nth(i));
    expect([cells[0], cells[1]], `row ${i}`).toEqual([subject, status]);
  }
  await expect(rows.nth(6).locator('span.text-blue-600')).toHaveText(whenLabel(nextMonday));
  await expect(rows.nth(10).locator('span.text-blue-600')).toHaveText(whenLabel(nextMonth));

  await rows.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/${newestWave}$`));
});

test('EMAIL-216 settings that fail to load look like "not set up"', async ({ page, browser, baseURL }) => {
  const p = await emailProject('email-216', { provider: 'brevo', requireOptIn: false });
  const member = await teammate(p.project.id, 'member', p.owner);
  let attempts = 0;
  const failSettings = async (target: import('@playwright/test').Page) =>
    target.route('**/api/email/settings/**', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      attempts++;
      await route.fulfill({ status: 500, json: { message: 'boom' } });
    });

  await signIn(page, p.owner);
  await failSettings(page);
  await page.goto(`/projects/${p.project.id}/email`);
  await expect(page.getByText(NOT_SET_UP_CARD, { exact: true })).toBeVisible();
  // Retried once before the page treats it as failed.
  expect(attempts).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('link', { name: 'New email' })).toHaveAttribute('disabled');
  await expect(toasts(page)).toHaveCount(0);

  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('From address')).toHaveValue('');
  await expect(page.getByLabel('Postal address')).toHaveValue('');
  await expect(page.getByText('Only email people who opted in', { exact: true }).locator('../..').getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(card(page, 'Provider')).toContainText('Save the sender first, then connect Amazon SES, Resend or Brevo.');
  await expect(card(page, 'Send a test')).toHaveCount(0);
  await expect(toasts(page)).toHaveCount(0);
  await expect(page.getByText('boom')).toHaveCount(0);

  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(page.getByRole('heading', { name: 'New email', exact: true })).toBeVisible();
  await page.getByLabel('Subject').fill('Hello');
  await page.getByPlaceholder('Send a test to…').fill('qa@example.test');
  await expect(page.getByText(/^Email is not set up yet/)).toHaveCount(0);
  await expect(card(page, 'Audience').locator('[data-slot="card-description"]')).toHaveText(
    'People with an email address who have not unsubscribed or bounced.',
  );
  await expect(sendButton(page)).toBeDisabled();
  await expect(card(page, 'Preview').getByRole('button', { name: 'Test', exact: true })).toBeDisabled();
  await expect(toasts(page)).toHaveCount(0);

  const { context } = await newPersonContext(browser, baseURL);
  try {
    const memberPage = await context.newPage();
    await signIn(memberPage, member);
    await failSettings(memberPage);
    await memberPage.goto(`/projects/${p.project.id}/email`);
    await expect(memberPage.getByText(NOT_SET_UP_CARD, { exact: true })).toBeVisible();
    await memberPage.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(card(memberPage, 'Provider')).toContainText('Not set up yet. An owner or admin connects a provider.');
  } finally {
    await context.close();
  }
});

test("EMAIL-222 schedule for later together with each recipient's timezone", async ({ page }) => {
  const p = await emailProject('email-222', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await page.getByLabel('Subject').fill('Both');
  await scheduleSwitch(page).click();
  const schedule = sendButton(page, 'Schedule email');
  await expect(schedule).toBeDisabled();
  const picked = await pickNextMonth(page, 15, '10:30');
  await expect(schedule).toBeEnabled();
  await localTimeSwitch(page).click();
  await card(page, 'When').locator('input[type="time"]').fill('18:45');
  await expect(schedule).toBeEnabled();

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
    schedule.click(),
  ]);
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    scheduledAt: picked.toISOString(),
    deliverInRecipientTimezone: true,
    localSendTime: '18:45',
  });
  await expect(toastWith(page, 'Email scheduled', '2 recipient(s).')).toBeVisible();
  const [row] = await campaignRows(p.project.id);
  expect(row).toMatchObject({ status: 'scheduled', deliver_in_recipient_timezone: true });
  expect(new Date(row.scheduled_at).toISOString()).toBe(picked.toISOString());
  expect(String(row.local_send_time)).toMatch(/^18:45/);
  const listed = campaignRow(page, 'Both');
  await expect(listed.getByRole('cell').nth(1)).toHaveText('Scheduled');
  await expect(listed.locator('span.text-blue-600')).toHaveText(whenLabel(picked));
});

test('EMAIL-223 A/B test with a schedule or with local time', async ({ page }) => {
  const p = await emailProject('email-223', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  await signIn(page, p.owner);

  const startArms = async () => {
    await page.goto(`/projects/${p.project.id}/email/new`);
    await expect(reachLine(page)).toHaveText('2 recipient(s)');
    await page.getByLabel('Subject').fill('Subject A');
    await card(page, 'A/B test').getByRole('switch').click();
    await armBox(page, 'B').getByPlaceholder('Subject for this arm').fill('Subject B');
  };
  const start = async () => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
      sendButton(page, 'Start experiment').click(),
    ]);
    expect(response.status()).toBe(201);
    await expect(toastWith(page, 'Experiment created', '2 recipient(s).')).toBeVisible();
    return ((await response.json()) as { data: { id: string } }).data.id;
  };

  await startArms();
  await scheduleSwitch(page).click();
  await expect(sendButton(page, 'Start experiment')).toBeDisabled();
  await expect(sendButton(page, 'Schedule email')).toHaveCount(0);
  const picked = await pickNextMonth(page, 12, '08:15');
  await expect(sendButton(page, 'Start experiment')).toBeEnabled();
  const scheduledId = await start();
  const scheduled = (await campaignRows(p.project.id)).find((row) => row.id === scheduledId)!;
  expect(scheduled).toMatchObject({ status: 'scheduled' });
  expect(new Date(scheduled.scheduled_at).toISOString()).toBe(picked.toISOString());
  expect(scheduled.variants.map((v: { key: string; title: string }) => [v.key, v.title])).toEqual([
    ['A', 'Subject A'],
    ['B', 'Subject B'],
  ]);

  await startArms();
  await localTimeSwitch(page).click();
  await expect(sendButton(page, 'Start experiment')).toBeEnabled();
  const localId = await start();
  const local = (await campaignRows(p.project.id)).find((row) => row.id === localId)!;
  expect(local).toMatchObject({ deliver_in_recipient_timezone: true });
  expect(String(local.local_send_time)).toMatch(/^09:00/);
  expect(Math.abs(new Date(local.scheduled_at).getTime() - Date.now())).toBeLessThan(120_000);
  // The worker's sweep may already have split it.
  expect(['scheduled', 'expanded']).toContain(local.status);
});

test('EMAIL-231 confirmation mailer claims the send even when the provider refuses it', async () => {
  test.setTimeout(300_000);
  const p = await emailProject('email-231', { sender: true });
  const address = uniqueEmail('email-231-confirm');
  const suppressed = uniqueEmail('email-231-suppressed');
  // The provider refuses every send to this address (as a dead key would).
  await failStub('brevo', { status: 401, match: address });
  const person = await identifyEmail(p, p.owner.ip, { email: address, emailOptIn: true });
  await suppress(p.owner, p.project.id, suppressed);
  await identifyEmail(p, p.owner.ip, { email: suppressed, emailOptIn: true });
  const off = await emailProject('email-231-off', { sender: true, requireOptIn: false });
  const offAddress = uniqueEmail('email-231-off');
  await identifyEmail(off, off.owner.ip, { email: offAddress, emailOptIn: true });
  // Providers last, so the mailer only ever sees these rows in their final state.
  await seedEmailCredentials(off.project.id, 'brevo');
  await seedEmailCredentials(p.project.id, 'brevo');

  const sentAt = async () => (await identityRows(p.project.id, address))[0].email_confirm_sent_at as Date | null;
  await expect.poll(sentAt, { timeout: 100_000, intervals: [2_000] }).not.toBeNull();
  const claimedAt = (await sentAt())!;
  const sends = async (projectId: string) =>
    sql(`SELECT address_hash, last_sent_at FROM email_confirmation_sends WHERE project_id = $1`, [projectId]);
  const [claim, ...others] = await sends(p.project.id);
  expect(others).toEqual([]);
  expect(claim.address_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(new Date(claim.last_sent_at).getTime()).toBe(new Date(claimedAt).getTime());
  const refused = await brevoCallsTo(address);
  expect(refused).toHaveLength(1);
  expect((refused[0].body as { subject: string }).subject).toBe('Confirm you want emails from E2E News');
  expect((await identityRows(p.project.id, address))[0].email_confirmed_at).toBeNull();

  // Another tick claims nothing new. An address reported after the claim can only be
  // claimed by a later tick, so once it is, that tick has passed over the first one.
  const marker = uniqueEmail('email-231-marker');
  await identifyEmail(p, p.owner.ip, { email: marker, emailOptIn: true });
  await expect
    .poll(async () => (await identityRows(p.project.id, marker))[0].email_confirm_sent_at, { timeout: 100_000, intervals: [2_000] })
    .not.toBeNull();
  expect(new Date((await sentAt())!).getTime()).toBe(new Date(claimedAt).getTime());
  expect(await brevoCallsTo(address)).toHaveLength(1);
  expect((await sends(p.project.id)).filter((row) => row.address_hash === claim.address_hash)).toEqual([claim]);
  expect(await sends(p.project.id)).toHaveLength(2);
  // Neither a suppressed address nor a project not requiring opt-in is claimed.
  expect((await identityRows(p.project.id, suppressed))[0].email_confirm_sent_at).toBeNull();
  expect(await brevoCallsTo(suppressed)).toHaveLength(0);
  expect((await identityRows(off.project.id, offAddress))[0].email_confirm_sent_at).toBeNull();
  expect(await sends(off.project.id)).toEqual([]);

  // The link for that send confirms, though the mail never went out, and the person
  // becomes reachable (nobody else here is confirmed or unsuppressed).
  expect((await emailPreview(p.owner, p.project.id)).recipients).toBe(0);
  const confirmed = await publicRequest('POST', pathAndQuery(signConfirmLink(p.project.id, address, new Date(claimedAt))), FORM);
  expect(confirmed.status).toBe(200);
  expect(confirmed.text).toContain('<title>Confirmed</title>');
  expect((await identityRows(p.project.id, address))[0].email_confirmed_at).not.toBeNull();
  expect(await consentRows(person)).toContainEqual({ channel: 'email', granted: true, source: 'email_confirmation' });
  expect((await emailPreview(p.owner, p.project.id)).recipients).toBe(1);
});

test('EMAIL-234 unsubscribe link for an address the suppression store refuses', async ({ page }) => {
  const p = await emailProject('email-234', { provider: 'brevo' });

  // Expected (current code): the page confirms, and nothing is stored.
  for (const address of ['"<img src=x onerror=alert(1)>"@example.test', 'no-dot@localhost']) {
    await page.goto(apiUrl(pathAndQuery(signUnsubscribeLink(p.project.id, address))));
    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page).toHaveTitle('Unsubscribed');
    await expect(page.getByRole('heading', { name: "You're unsubscribed" })).toBeVisible();
    await expect(page.getByText(`${address} will not receive marketing email from this sender again.`, { exact: true })).toBeVisible();
    expect(await sql(`SELECT 1 FROM channel_suppressions WHERE project_id = $1`, [p.project.id]), address).toHaveLength(0);
  }

  // An ordinary address through the same page is stored.
  await page.goto(apiUrl(pathAndQuery(signUnsubscribeLink(p.project.id, 'plain@example.test'))));
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page).toHaveTitle('Unsubscribed');
  expect((await suppressionRows(p.project.id)).map((row) => row.address)).toEqual(['plain@example.test']);
});

// ------------------------------------------------------------ View-as on Settings ---

async function viewAsSesProject(label: string) {
  const p = await emailProject(label, { provider: 'ses' });
  const resend = await seedEmailCredentials(p.project.id, 'resend', { activate: false });
  await sql(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [p.project.id, TOPIC]);
  return { ...p, resendKey: (resend.credentials as { apiKey: string }).apiKey };
}

test("EMAIL-237 view-as Settings offers the owner's controls", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const p = await viewAsSesProject('email-237');
  const sesKey = (p.email!.credentials as { accessKeyId: string }).accessKeyId;
  const url = await viewAsHandoff(browser, baseURL, p.owner);

  await openViewAs(page, url);
  await openEmail(page, p.project.id, 'Settings');
  const sender = card(page, 'Sender');
  await expect(sender.getByLabel('From address')).toBeEditable();
  await expect(page.getByRole('button', { name: 'Save sender' })).toBeVisible();

  const provider = card(page, 'Provider');
  await expect(providerTab(page, 'Amazon SES')).toHaveAttribute('aria-selected', 'true');
  await expect(provider.locator('p').filter({ hasText: /^Access key ending/ })).toHaveText(
    `Access key ending ${sesKey.slice(-4)} in ap-south-1, configuration set e2e-events`,
  );
  for (const label of ['Region', 'Configuration set', 'Access key ID', 'Secret access key']) {
    await expect(provider.getByLabel(label), label).toBeEditable();
  }
  await expect(provider.getByRole('button', { name: 'Replace and use SES', exact: true })).toBeVisible();
  await expect(webhookCode(page)).toHaveCount(0);
  const box = page.locator('div.rounded-md.border').filter({ has: page.getByText('Delivery events', { exact: true }) });
  await expect(box.locator('code')).toHaveText(HIDDEN_VALUE);
  await expect(box.getByRole('button').filter({ has: page.locator('svg.lucide-copy') })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Replace URL' })).toBeVisible();
  await expect(box.getByText(`Accepting events from ${TOPIC}`, { exact: true })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Switch topic' })).toBeVisible();
  await expect(page.getByText(HIDDEN_FROM_ROLE)).toHaveCount(0);

  await providerTab(page, 'Resend').click();
  await expect(provider.getByText(`Key ending ${p.resendKey.slice(-4)} is stored.`)).toBeVisible();
  await expect(provider.getByLabel('API key')).toBeEditable();
  await expect(provider.getByLabel('Webhook signing secret')).toBeEditable();
  await expect(provider.getByRole('button', { name: 'Replace and use Resend' })).toBeVisible();
  await expect(box.locator('code')).toHaveText(HIDDEN_VALUE);

  await providerTab(page, 'Brevo').click();
  await expect(provider.getByLabel('API key')).toBeEditable();
  await expect(provider.getByRole('button', { name: 'Connect Brevo' })).toBeVisible();
  await expect(box.locator('code')).toHaveText(HIDDEN_VALUE);
});

test('EMAIL-238 view-as: Copy, Switch topic and Replace URL', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const p = await viewAsSesProject('email-238');
  const before = await emailSettingsRow(p.project.id);
  const activity = await projectActivity(p.project.id);
  const url = await viewAsHandoff(browser, baseURL, p.owner);

  await openViewAs(page, url);
  await allowClipboard(page);
  await openEmail(page, p.project.id, 'Settings');
  const box = page.locator('div.rounded-md.border').filter({ has: page.getByText('Delivery events', { exact: true }) });
  await box.getByRole('button').filter({ has: page.locator('svg.lucide-copy') }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await readClipboard(page)).toBe(HIDDEN_VALUE);
  await expect(toasts(page)).toHaveCount(0, { timeout: 10_000 });

  const [switched] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/reset-ses-topic') && r.request().method() === 'POST'),
    box.getByRole('button', { name: 'Switch topic' }).click(),
  ]);
  expect(switched.status()).toBe(403);
  await expect(toasts(page).filter({ hasText: 'Read-only session' })).toContainText(READ_ONLY);
  await expect(toasts(page)).toHaveCount(1);
  await expect(box.getByText(`Accepting events from ${TOPIC}`, { exact: true })).toBeVisible();
  await expect(toasts(page)).toHaveCount(0, { timeout: 10_000 });

  page.once('dialog', (dialog) => dialog.accept());
  const [replaced] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/rotate-webhook-token') && r.request().method() === 'POST'),
    box.getByRole('button', { name: 'Replace URL' }).click(),
  ]);
  expect(replaced.status()).toBe(403);
  await expect(toasts(page).filter({ hasText: 'Read-only session' })).toContainText(READ_ONLY);
  await expect(toasts(page).filter({ hasText: 'Could not replace the URL' })).toContainText(READ_ONLY);
  await expect(toasts(page)).toHaveCount(2);

  expect(await emailSettingsRow(p.project.id)).toEqual(before);
  expect(await projectActivity(p.project.id)).toEqual([...activity, 'staff.viewed_as']);
});

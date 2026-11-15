import { randomBytes } from 'crypto';
import { apiUrl, uniqueEmail } from '../../support/api';
import { fakeSvixSecret } from '../../support/channels';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { pathAndQuery, signConfirmLink, signSvix, signUnsubscribeLink } from '../../support/signing';
import {
  brevoCallsTo,
  brevoEvent,
  call,
  card,
  chumbaqTags,
  cloneCampaign,
  confirmEmail,
  consentRows,
  dataOf,
  emailLogs,
  emailPreview,
  emailProject,
  emailSettingsRow,
  eventRows,
  HIDDEN_FROM_ROLE,
  HIDDEN_VALUE,
  identifyDevice,
  identifyEmail,
  identityRows,
  markConfirmSent,
  messageOf,
  NOTHING_DELIVERED,
  openEmail,
  openViewAs,
  PEOPLE,
  postBrevo,
  postResend,
  postSes,
  PROJECT_NOT_FOUND,
  projectActivity,
  publicRequest,
  reachLine,
  READ_ONLY,
  resendEvent,
  ROLE_REFUSAL,
  saveSender,
  scheduleEmailCampaign,
  seedPeople,
  snsCertUrl,
  snsMessage,
  sql,
  suppress,
  suppressionRows,
  suspendAccount,
  teammate,
  viewAsHandoff,
  webhookPost,
  addMember,
} from '../../support/areas/email';
import { seedEmailCredentials } from '../../support/channels';

/**
 * Email: the double opt-in confirmation page, the Resend, Brevo and SES webhooks, what
 * members, outsiders and view-as sessions can do, a suspended billing owner, and a
 * campaign whose whole audience dropped out. Confirmation links are signed with the
 * run's key as the API signs them; Resend events are signed with the stored Svix secret;
 * SES messages are built in SNS's shape and are refused before any certificate fetch.
 */

test.describe.configure({ mode: 'parallel' });

const E2 = PEOPLE.E2.email!;

/**
 * A project requiring opt-in with E2 opted in but unconfirmed and a confirmation mailed
 * at `sentAt`. The provider is seeded only after the send time is set, so the worker's
 * confirmation mailer never takes the address (it mails only projects with a provider,
 * and only addresses not mailed in the last week).
 */
async function confirmProject(label: string, { extraE2Device = false, confirmedE1 = false } = {}) {
  const p = await emailProject(label, { sender: true });
  const ids: string[] = [];
  let e1: string | undefined;
  if (confirmedE1) {
    e1 = await identifyEmail(p, p.owner.ip, PEOPLE.E1);
    await confirmEmail(e1);
  }
  const fingerprint = `email-${randomBytes(8).toString('hex')}`;
  ids.push(await identifyDevice(p, p.owner.ip, fingerprint, PEOPLE.E2));
  if (extraE2Device) ids.push(await identifyEmail(p, p.owner.ip, { email: E2, firstName: 'Bela tablet' }));
  const sentAt = new Date(Date.now() - 60_000);
  await markConfirmSent(p.project.id, E2, sentAt);
  await seedEmailCredentials(p.project.id, 'brevo');
  return { ...p, e2Ids: ids, e1, fingerprint, sentAt, link: signConfirmLink(p.project.id, E2, sentAt) };
}

// ------------------------------------------------------------ K. Confirmation ---

test('EMAIL-146 opening the confirmation link confirms nothing', async ({ page }) => {
  const p = await confirmProject('email-146');

  const response = await page.goto(apiUrl(pathAndQuery(p.link)));
  expect(response!.status()).toBe(200);
  expect(response!.headers()['cache-control']).toBe('no-store');
  await expect(page).toHaveTitle('Confirm');
  await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
  await expect(page.getByText(`Receive this sender's email at ${E2}.`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yes, send me emails' })).toBeVisible();

  const rows = await identityRows(p.project.id, E2);
  expect(rows).toHaveLength(1);
  expect(rows[0].email_confirmed_at).toBeNull();
  expect(await consentRows(p.e2Ids[0])).not.toContainEqual(expect.objectContaining({ source: 'email_confirmation' }));
});

test('EMAIL-147 confirming makes the person reachable', async ({ page, browser, baseURL }) => {
  const p = await confirmProject('email-147', { extraE2Device: true, confirmedE1: true });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('1 recipient(s)');

  const { context } = await newPersonContext(browser, baseURL);
  try {
    const inbox = await context.newPage();
    await inbox.goto(apiUrl(pathAndQuery(p.link)));
    await inbox.getByRole('button', { name: 'Yes, send me emails' }).click();
    await expect(inbox).toHaveTitle('Confirmed');
    await expect(inbox.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    await expect(inbox.getByText(`${E2} will receive this sender's email.`, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }

  const rows = await identityRows(p.project.id, E2);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.email_confirmed_at).not.toBeNull();
    expect(row.email_opt_in).toBe(true);
    expect(await consentRows(row.id)).toContainEqual({ channel: 'email', granted: true, source: 'email_confirmation' });
  }

  await page.reload();
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 2, requireOptIn: true });
});

test('EMAIL-149 a later refusal beats an older link', async () => {
  const p = await confirmProject('email-149');
  // After the mail went out, the app reports that the person refused.
  await identifyDevice(p, p.owner.ip, p.fingerprint, { email: E2, emailOptIn: false });

  const answered = await publicRequest('POST', pathAndQuery(p.link), { contentType: 'application/x-www-form-urlencoded', text: '' });
  expect(answered.status).toBe(200);
  expect(answered.headers.get('content-type')).toMatch(/^text\/html/);
  expect(answered.text).toContain('<title>Link not current</title>');
  expect(answered.text).toContain('<h1>This link is no longer current</h1><p>Use the latest confirmation email you received.</p>');

  const [row] = await identityRows(p.project.id, E2);
  expect(row.email_opt_in).toBe(false);
  expect(row.email_confirmed_at).toBeNull();
  expect(await consentRows(row.id)).not.toContainEqual(expect.objectContaining({ source: 'email_confirmation' }));
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 0 });
  // Out of every audience: with opt-in no longer required the refusal still keeps it out.
  await saveSender(p.owner, p.project.id, { requireOptIn: false });
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 0, requireOptIn: false });
});

test('EMAIL-150 expired, tampered and cross-purpose confirmation links', async () => {
  const p = await confirmProject('email-150');
  const other = await confirmProject('email-150-other');
  // The same address with the same send time in the other project.
  await markConfirmSent(other.project.id, E2, p.sentAt);

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  await markConfirmSent(p.project.id, E2, eightDaysAgo);
  const expired = new URL(signConfirmLink(p.project.id, E2, eightDaysAgo));
  const good = new URL(p.link);
  const s = good.searchParams.get('s')!;
  const tampered = new URLSearchParams(good.search);
  tampered.set('s', `${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`);
  const unsubscribe = new URL(signUnsubscribeLink(p.project.id, E2));
  const swapped = new URLSearchParams(good.search);
  swapped.set('p', other.project.id);

  const variants: Array<[string, string]> = [
    ['send time 8 days ago', `/api/email/confirm${expired.search}`],
    ['signature altered', `/api/email/confirm?${tampered}`],
    ['an unsubscribe link on the confirm route', `/api/email/confirm${unsubscribe.search}`],
    ['another project', `/api/email/confirm?${swapped}`],
  ];
  for (const [label, path] of variants) {
    const shown = await publicRequest('GET', path);
    expect(shown.status, label).toBe(400);
    expect(shown.headers.get('content-type'), label).toMatch(/^text\/html/);
    expect(shown.text, label).toContain('<title>Link not valid</title>');

    const posted = await publicRequest('POST', path, { contentType: 'application/x-www-form-urlencoded', text: '' });
    expect(posted.status, label).toBe(400);
    expect(posted.headers.get('content-type'), label).toMatch(/^text\/plain/);
    expect(posted.text, label).toBe('This confirmation link is not valid or has expired.');
  }

  for (const projectId of [p.project.id, other.project.id]) {
    const rows = await identityRows(projectId, E2);
    expect(rows.map((row) => row.email_confirmed_at)).toEqual([null]);
  }
  // The untouched link of the other project still works, so the rows were confirmable.
  const ok = await publicRequest('POST', pathAndQuery(signConfirmLink(other.project.id, E2, p.sentAt)), { contentType: 'application/x-www-form-urlencoded', text: '' });
  expect(ok.text).toContain('<title>Confirmed</title>');
});

// ------------------------------------------------------------ L. Resend webhook ---

async function resendProject(label: string) {
  const p = await emailProject(label, { provider: 'resend', requireOptIn: false });
  const ids = await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  const campaign = await scheduleEmailCampaign(p.owner, p.project.id, `Resend campaign ${label}`);
  const email = p.email!;
  const secret = (email.credentials as { webhookSecret: string }).webhookSecret;
  return { ...p, ids, campaignId: campaign.id as string, token: email.webhookToken, secret };
}

test('EMAIL-153 signed delivery event recorded against the campaign', async () => {
  const p = await resendProject('email-153');

  const answered = await postResend(p.token, p.secret, resendEvent('email.delivered', 'e1@example.test', chumbaqTags(p.campaignId, p.ids.E1)));
  expect(answered.status).toBe(200);
  expect(answered.body).toEqual({ data: { recorded: 1 } });

  expect(await eventRows(p.project.id)).toEqual([
    expect.objectContaining({ campaign_id: p.campaignId, device_identity_id: p.ids.E1, type: 'delivered', platform: 'email' }),
  ]);
  const [listed] = (await emailLogs(p.owner, p.project.id)).filter((log) => log.id === p.campaignId);
  expect(listed.engagement).toMatchObject({ delivered: 1 });
});

test('EMAIL-158 Resend signature refusals', async () => {
  const p = await resendProject('email-158');
  const body = JSON.stringify(
    resendEvent('email.bounced', 'e1@example.test', chumbaqTags(p.campaignId, p.ids.E1), {
      bounce: { type: 'Permanent', subType: 'General', message: 'No such mailbox' },
    }),
  );
  const path = `/api/email/webhooks/resend/${p.token}`;
  const other = signSvix(p.secret, body.replace('e1@example.test', 'e2@example.test'));
  const stale = signSvix(p.secret, body, { timestamp: Math.floor(Date.now() / 1000) - 6 * 60 });
  const foreign = signSvix(fakeSvixSecret(), body);

  const refusals: Array<[string, Record<string, string>]> = [
    ['no svix headers', {}],
    ['signature over a different body', { ...other }],
    ['timestamp 6 minutes old', { ...stale }],
    ['signed with another secret', { ...foreign }],
  ];
  for (const [label, headers] of refusals) {
    const refused = await webhookPost(path, body, { headers });
    expect(refused.status, label).toBe(401);
    expect(messageOf(refused), label).toBe('Signature did not verify.');
  }

  // A correctly signed body that is not JSON. Resend sends JSON, so as JSON it is refused
  // by the body parser before the route; sent as text the route sees no JSON body.
  const notJson = await webhookPost(path, 'not json', { headers: { ...signSvix(p.secret, 'not json') } });
  expect(notJson.status).toBe(400);
  expect(messageOf(notJson)).toMatch(/is not valid JSON/);
  const empty = await webhookPost(path, '', { contentType: 'text/plain', headers: { ...signSvix(p.secret, '') } });
  expect(empty.status).toBe(400);
  expect(messageOf(empty)).toBe('Body is not JSON.');

  expect(await eventRows(p.project.id)).toEqual([]);
  expect(await suppressionRows(p.project.id)).toEqual([]);
  // The same body correctly signed is accepted, so the refusals were the signature's.
  const accepted = await postResend(p.token, p.secret, body);
  expect(accepted.body).toEqual({ data: { recorded: 1 } });
});

test("EMAIL-161 Resend tags naming another project's campaign", async () => {
  const p = await resendProject('email-161');
  const other = await emailProject('email-161-other', { provider: 'brevo', requireOptIn: false });
  const { E1: otherE1 } = await seedPeople(other, other.owner.ip, ['E1']);
  const foreign = await scheduleEmailCampaign(other.owner, other.project.id, 'The other tenant');

  const delivered = await postResend(p.token, p.secret, resendEvent('email.delivered', 'e1@example.test', chumbaqTags(foreign.id, p.ids.E1)));
  expect(delivered.status).toBe(200);
  expect(delivered.body).toEqual({ data: { recorded: 0 } });
  const crossed = await postResend(p.token, p.secret, resendEvent('email.delivered', 'e1@example.test', chumbaqTags(foreign.id, otherE1)));
  expect(crossed.body).toEqual({ data: { recorded: 0 } });

  const bounced = await postResend(
    p.token,
    p.secret,
    resendEvent('email.bounced', 'x@example.test', chumbaqTags(foreign.id, otherE1), {
      bounce: { type: 'Permanent', subType: 'Suppressed', message: 'Gone' },
    }),
  );
  expect(bounced.status).toBe(200);
  expect(bounced.body).toEqual({ data: { recorded: 0 } });

  expect(await eventRows(p.project.id)).toEqual([]);
  expect(await eventRows(other.project.id)).toEqual([]);
  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ address: 'x@example.test', reason: 'bounced', detail: 'Suppressed: Gone' }),
  ]);
  expect(await suppressionRows(other.project.id)).toEqual([]);
});

test('EMAIL-208 Resend events: identity and campaign must belong to this project', async () => {
  const p = await resendProject('email-208');
  const pushCampaign = await cloneCampaign(p.campaignId, 'push');
  const smsCampaign = await cloneCampaign(p.campaignId, 'sms');
  const other = await emailProject('email-208-other', { provider: 'brevo', requireOptIn: false });
  const otherPerson = await identifyEmail(other, other.owner.ip, { email: 'eo@example.test', emailOptIn: true });
  const permanent = { bounce: { type: 'Permanent', subType: 'General', message: 'Unknown user' } };

  const send = (body: unknown) => postResend(p.token, p.secret, body);
  const outcomes: Array<[string, unknown, number]> = [
    ['identity of another project', resendEvent('email.delivered', 'eo@example.test', chumbaqTags(p.campaignId, otherPerson)), 0],
    ['push campaign', resendEvent('email.opened', 'e1@example.test', chumbaqTags(pushCampaign, p.ids.E1)), 0],
    ['SMS campaign', resendEvent('email.opened', 'e1@example.test', chumbaqTags(smsCampaign, p.ids.E1)), 0],
    ['bounce tagged with the push campaign', resendEvent('email.bounced', 'e1@example.test', chumbaqTags(pushCampaign, p.ids.E1), permanent), 0],
    ['bounce tagged with a stranger', resendEvent('email.bounced', 'x@example.test', chumbaqTags(p.campaignId, otherPerson), permanent), 0],
    // Signed events are not corroborated against the address: the tag decides.
    ['click tagged with E2 for E1 address', resendEvent('email.clicked', 'e1@example.test', chumbaqTags(p.campaignId, p.ids.E2)), 1],
  ];
  for (const [label, body, recorded] of outcomes) {
    const answered = await send(body);
    expect(answered.status, label).toBe(200);
    expect(answered.body, label).toEqual({ data: { recorded } });
  }

  expect(await eventRows(p.project.id)).toEqual([
    expect.objectContaining({ campaign_id: p.campaignId, device_identity_id: p.ids.E2, type: 'click', platform: 'email' }),
  ]);
  expect(await eventRows(other.project.id)).toEqual([]);
  expect((await suppressionRows(p.project.id)).map((row) => [row.address, row.reason])).toEqual([
    ['e1@example.test', 'bounced'],
    ['x@example.test', 'bounced'],
  ]);
  expect(await suppressionRows(other.project.id)).toEqual([]);
});

// ------------------------------------------------------------ M. Brevo webhook ---

async function brevoProject(label: string) {
  const p = await emailProject(label, { provider: 'brevo', requireOptIn: false });
  const ids = await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  const campaign = await scheduleEmailCampaign(p.owner, p.project.id, `Brevo campaign ${label}`);
  return { ...p, ids, campaignId: campaign.id as string, token: p.email!.webhookToken };
}

test('EMAIL-164 Brevo delivered event from a person in the project', async () => {
  const p = await brevoProject('email-164');
  const at = Math.floor(Date.now() / 1000) - 120;

  const answered = await postBrevo(p.token, brevoEvent('delivered', 'E1@example.test', p.campaignId, p.ids.E1, { ts_event: at }));
  expect(answered.status).toBe(200);
  expect(answered.body).toEqual({ data: { recorded: 1 } });

  const events = await eventRows(p.project.id);
  expect(events).toEqual([
    expect.objectContaining({ campaign_id: p.campaignId, device_identity_id: p.ids.E1, type: 'delivered', platform: 'email' }),
  ]);
  expect(new Date(events[0].occurred_at).getTime()).toBe(at * 1000);
});

test('EMAIL-167 Brevo event for an unknown address is ignored', async () => {
  const p = await brevoProject('email-167');

  for (const event of ['hard_bounce', 'spam']) {
    const answered = await postBrevo(p.token, brevoEvent(event, 'stranger@example.test', p.campaignId, p.ids.E1));
    expect(answered.status, event).toBe(200);
    expect(answered.body, event).toEqual({ data: { recorded: 0 } });
  }
  expect(await suppressionRows(p.project.id)).toEqual([]);
  expect(await eventRows(p.project.id)).toEqual([]);
});

test('EMAIL-168 Brevo tags that do not match the address', async () => {
  const p = await brevoProject('email-168');

  const click = await postBrevo(p.token, brevoEvent('click', 'e1@example.test', p.campaignId, p.ids.E2));
  expect(click.status).toBe(200);
  expect(click.body).toEqual({ data: { recorded: 0 } });
  expect(await suppressionRows(p.project.id)).toEqual([]);

  const bounce = await postBrevo(p.token, brevoEvent('hard_bounce', 'e1@example.test', p.campaignId, p.ids.E2, { reason: 'mailbox gone' }));
  expect(bounce.status).toBe(200);
  expect(bounce.body).toEqual({ data: { recorded: 0 } });
  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ address: 'e1@example.test', reason: 'bounced', detail: 'hard_bounce: mailbox gone' }),
  ]);
  expect(await eventRows(p.project.id)).toEqual([]);
});

test('EMAIL-169 Brevo URL refused when Brevo is not the active provider', async () => {
  const p = await resendProject('email-169');

  const refused = await postBrevo(p.token, brevoEvent('hard_bounce', 'e1@example.test', p.campaignId, p.ids.E1));
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe('Connect Brevo in Email settings to receive its events.');
  expect(await suppressionRows(p.project.id)).toEqual([]);
  expect(await eventRows(p.project.id)).toEqual([]);
});

// ------------------------------------------------------------ N. SES webhook ---

async function sesProject(label: string, topic: string | null = null) {
  const p = await emailProject(label, { provider: 'ses', requireOptIn: false });
  if (topic) await sql(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [p.project.id, topic]);
  return { ...p, token: p.email!.webhookToken };
}

test('EMAIL-171 SES refusals before any certificate fetch', async () => {
  const p = await sesProject('email-171');
  const cases: Array<[string, unknown, number, string]> = [
    ['not JSON', 'not json', 400, 'Body is not an SNS message.'],
    ['certificate elsewhere', snsMessage({ SigningCertURL: 'https://evil.example/cert.pem' }), 401, 'Certificate is not from SNS.'],
    ['unknown type', snsMessage({ Type: 'Other' }), 401, 'Body is not a signed SNS message.'],
    ['no signature', snsMessage({ Signature: undefined }), 401, 'Body is not a signed SNS message.'],
    ['2 hours old', snsMessage({ Timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }), 401, 'Message is too old to accept.'],
    [
      'notification with no topic pinned',
      snsMessage({ Type: 'Notification', Subject: 'Amazon SES Email Event Notification' }),
      403,
      'No SNS topic is confirmed for this webhook yet. Subscribe the topic to this URL again so SNS sends a confirmation.',
    ],
    [
      "certificate outside the topic's region",
      snsMessage({ TopicArn: 'arn:aws:sns:us-east-1:123456789012:t' }),
      401,
      "Certificate is not from the topic's region.",
    ],
  ];
  for (const [label, body, status, message] of cases) {
    const refused = await postSes(p.token, body);
    expect(refused.status, label).toBe(status);
    expect(messageOf(refused), label).toBe(message);
  }
  expect((await emailSettingsRow(p.project.id))!.ses_topic_arn).toBeNull();
  expect(await suppressionRows(p.project.id)).toEqual([]);
});

test('EMAIL-172 SES topic other than the pinned one', async () => {
  const pinned = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events';
  const p = await sesProject('email-172', pinned);

  const refused = await postSes(
    p.token,
    snsMessage({ Type: 'Notification', TopicArn: 'arn:aws:sns:ap-south-1:123456789012:another-topic' }),
  );
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe('Events from this topic are not accepted. Reset the SES topic in Email settings to switch topics.');
  expect((await emailSettingsRow(p.project.id))!.ses_topic_arn).toBe(pinned);
});

test("EMAIL-212 SES certificate URLs that are not SNS's exact form", async () => {
  const p = await sesProject('email-212');
  const host = 'https://sns.ap-south-1.amazonaws.com';
  const file = 'SimpleNotificationService-abc123.pem';
  const urls: Array<[string, string | undefined]> = [
    ['http', `http://sns.ap-south-1.amazonaws.com/${file}`],
    ['query', `${host}/${file}?x=1`],
    ['fragment', `${host}/${file}#frag`],
    ['empty query', `${host}/${file}?`],
    ['explicit port', `https://sns.ap-south-1.amazonaws.com:443/${file}`],
    ['user info', `https://user@sns.ap-south-1.amazonaws.com/${file}`],
    ['made-up region', snsCertUrl('xx-fake-9')],
    ['look-alike host', `https://sns.ap-south-1.amazonaws.com.evil.example/${file}`],
    ['other file name', `${host}/cert.pem`],
    ['upper-case hex', `${host}/SimpleNotificationService-ABC123.pem`],
    ['65 hex characters', `${host}/SimpleNotificationService-${'a'.repeat(65)}.pem`],
    ['dot segment', `${host}/./${file}`],
    ['percent-encoded', `${host}/%53impleNotificationService-abc123.pem`],
    ['no certificate URL', undefined],
  ];
  for (const [label, url] of urls) {
    const refused = await postSes(p.token, snsMessage({ SigningCertURL: url }));
    expect(refused.status, label).toBe(401);
    expect(messageOf(refused), label).toBe('Certificate is not from SNS.');
  }
  // The URL is checked before any other field.
  const first = await postSes(
    p.token,
    snsMessage({ SigningCertURL: `${host}/${file}?x=1`, Type: 'Other', Timestamp: '2000-01-01T00:00:00.000Z' }),
  );
  expect(messageOf(first)).toBe('Certificate is not from SNS.');
  // The exact form passes the URL check and meets the next one.
  const exact = await postSes(p.token, snsMessage({ Type: 'Other' }));
  expect(messageOf(exact)).toBe('Body is not a signed SNS message.');
});

// ------------------------------------------- P. Roles, view-as, suspension ---

test('EMAIL-185 member sees Settings read-only with secrets hidden', async ({ page }) => {
  const p = await emailProject('email-185', { provider: 'brevo', requireOptIn: false });
  await sql(`UPDATE email_settings SET ses_topic_arn = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events' WHERE project_id = $1`, [p.project.id]);
  const member = await teammate(p.project.id, 'member', p.owner);
  const keyHint = (p.email!.credentials as { apiKey: string }).apiKey.slice(-4);

  const settings = dataOf(await call('GET', `/api/email/settings/${p.project.id}`, member));
  expect(settings.webhookUrls).toEqual({ ses: HIDDEN_VALUE, resend: HIDDEN_VALUE, brevo: HIDDEN_VALUE });

  await signIn(page, member);
  await openEmail(page, p.project.id, 'Settings');
  const sender = card(page, 'Sender');
  await expect(sender.getByLabel('From address')).toBeDisabled();
  await expect(sender.getByLabel('Postal address')).toBeDisabled();
  await expect(sender.getByRole('switch')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save sender' })).toHaveCount(0);

  const provider = card(page, 'Provider');
  await expect(provider.getByRole('tab', { name: /Brevo/ })).toHaveAttribute('aria-selected', 'true');
  await expect(provider.getByText(`Key ending ${keyHint} is stored.`)).toBeVisible();
  await expect(provider.getByText(HIDDEN_FROM_ROLE, { exact: true })).toBeVisible();
  await expect(provider.getByText(p.email!.webhookToken)).toHaveCount(0);
  await expect(provider.getByLabel('API key')).toHaveCount(0);
  // No copy, Replace URL or connect button: the card holds no button at all.
  await expect(provider.getByRole('button')).toHaveCount(0);
  for (const tab of ['Resend', 'Amazon SES']) {
    await provider.getByRole('tab', { name: new RegExp(tab) }).click();
    await expect(provider.getByText(HIDDEN_FROM_ROLE, { exact: true })).toBeVisible();
    await expect(provider.getByRole('textbox')).toHaveCount(0);
    await expect(provider.getByRole('button')).toHaveCount(0);
  }
  await expect(provider.getByText(/Accepting events from/)).toHaveCount(0);

  const address = uniqueEmail('email-185-test');
  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('you@yourapp.com').fill(address);
  await testCard.getByRole('button', { name: 'Send test' }).click();
  await expect(testCard.getByText('Accepted by the provider. Check the inbox.')).toBeVisible();
  await expect.poll(async () => (await brevoCallsTo(address)).length).toBe(1);
});

test('EMAIL-186 member refused on channel settings routes', async () => {
  const p = await emailProject('email-186', { provider: 'brevo', requireOptIn: false });
  await sql(`UPDATE email_settings SET ses_topic_arn = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events' WHERE project_id = $1`, [p.project.id]);
  const member = await teammate(p.project.id, 'member', p.owner);
  const before = await emailSettingsRow(p.project.id);
  const activity = await projectActivity(p.project.id);

  const routes: Array<[string, string, unknown?]> = [
    ['POST', '/api/email/settings', { projectId: p.project.id, fromEmail: 'member@e2e.example.test', postalAddress: '1 Member Road, Town' }],
    ['POST', '/api/email/providers', { projectId: p.project.id, provider: 'brevo', credentials: JSON.stringify({ apiKey: 'xkeysib-member' }) }],
    ['POST', `/api/email/settings/${p.project.id}/reset-ses-topic`],
    ['POST', `/api/email/settings/${p.project.id}/rotate-webhook-token`],
  ];
  for (const [method, path, body] of routes) {
    const refused = await call(method, path, member, body);
    expect(refused.status, path).toBe(403);
    expect(messageOf(refused), path).toBe(ROLE_REFUSAL);
  }
  expect(await emailSettingsRow(p.project.id)).toEqual(before);
  expect(await projectActivity(p.project.id)).toEqual(activity);
});

test('EMAIL-189 outsider refused everywhere', async () => {
  const p = await emailProject('email-189', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1']);
  await suppress(p.owner, p.project.id, 'kept@example.test');
  const outsider = await emailProject('email-189-outsider', { provider: 'brevo' });
  const id = p.project.id;
  const before = await emailSettingsRow(id);
  const activity = await projectActivity(id);
  const content = { subject: 'From outside', html: '<p>Hi</p>' };

  const routes: Array<[string, string, unknown?]> = [
    ['GET', `/api/email/settings/${id}`],
    ['POST', '/api/email/settings', { projectId: id, fromEmail: 'out@e2e.example.test', postalAddress: '1 Outside Road' }],
    ['POST', '/api/email/providers', { projectId: id, provider: 'brevo', credentials: JSON.stringify({ apiKey: 'xkeysib-outside' }) }],
    ['POST', `/api/email/settings/${id}/reset-ses-topic`],
    ['POST', `/api/email/settings/${id}/rotate-webhook-token`],
    ['POST', '/api/email/audience-preview', { projectId: id }],
    ['POST', '/api/email/send', { projectId: id, ...content }],
    ['POST', '/api/email/test-send', { projectId: id, to: 'out@example.test', ...content }],
    ['GET', `/api/email/suppressions/${id}`],
    ['POST', '/api/email/suppressions', { projectId: id, address: 'victim@example.test' }],
    ['DELETE', `/api/email/suppressions/${id}/kept%40example.test`],
    ['POST', `/api/projects/${id}/email-links/rewrite`, { html: '<a href="https://shop.example/a">A</a>' }],
  ];
  for (const [method, path, body] of routes) {
    const refused = await call(method, path, outsider.owner, body);
    expect(refused.status, `${method} ${path}`).toBe(404);
    expect(messageOf(refused), `${method} ${path}`).toBe(PROJECT_NOT_FOUND);
    for (const secret of [before!.webhook_token, before!.from_email, 'kept@example.test', 'e1@example.test']) {
      expect(refused.text, `${method} ${path}`).not.toContain(secret);
    }
  }

  expect(await emailSettingsRow(id)).toEqual(before);
  expect(await projectActivity(id)).toEqual(activity);
  expect((await suppressionRows(id)).map((row) => row.address)).toEqual(['kept@example.test']);
  expect(await sql(`SELECT 1 FROM push_notification_logs WHERE project_id = $1`, [id])).toHaveLength(0);
  expect(await sql(`SELECT 1 FROM links WHERE project_id = $1`, [id])).toHaveLength(0);
  expect(await brevoCallsTo('out@example.test')).toHaveLength(0);
});

test('EMAIL-190 body project differs from the checked project', async () => {
  const p = await emailProject('email-190', { provider: 'brevo', requireOptIn: false });
  const shared = await emailProject('email-190-shared', { sender: true });
  const other = await emailProject('email-190-other', { sender: true });
  await addMember(shared.project.id, p.owner, 'member', shared.owner);
  const sharedBefore = await emailSettingsRow(shared.project.id);

  const settings = await call('POST', '/api/email/settings', p.owner, {
    projectId: shared.project.id,
    fromEmail: 'takeover@e2e.example.test',
    postalAddress: '1 Takeover Road, Town',
  });
  expect(settings.status).toBe(403);
  expect(messageOf(settings)).toBe(ROLE_REFUSAL);
  // A route checked on the owner's own project still checks the body's project too.
  const rotate = await call('POST', `/api/email/settings/${p.project.id}/rotate-webhook-token`, p.owner, { projectId: shared.project.id });
  expect(rotate.status).toBe(403);
  expect(messageOf(rotate)).toBe(ROLE_REFUSAL);
  expect((await emailSettingsRow(p.project.id))!.webhook_token).toBe(p.email!.webhookToken);
  expect(await emailSettingsRow(shared.project.id)).toEqual(sharedBefore);

  const suppressed = await call('POST', '/api/email/suppressions', p.owner, { projectId: other.project.id, address: 'victim@example.test' });
  expect(suppressed.status).toBe(404);
  expect(messageOf(suppressed)).toBe(PROJECT_NOT_FOUND);
  expect(await suppressionRows(other.project.id)).toEqual([]);
  expect(await suppressionRows(p.project.id)).toEqual([]);
});

test('EMAIL-191 view-as reads, with webhook URLs hidden', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const p = await emailProject('email-191', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1']);
  const subject = `Viewed campaign ${Date.now()}`;
  await scheduleEmailCampaign(p.owner, p.project.id, subject);
  await suppress(p.owner, p.project.id, 'viewed@example.test');
  const apiKey = (p.email!.credentials as { apiKey: string }).apiKey;
  const url = await viewAsHandoff(browser, baseURL, p.owner);

  const bodies: string[] = [];
  page.on('response', async (response) => {
    if (!response.url().includes('/api/')) return;
    bodies.push(await response.text().catch(() => ''));
  });
  await openViewAs(page, url);
  await openEmail(page, p.project.id, 'Campaigns');
  await expect(page.getByRole('row').filter({ hasText: subject })).toBeVisible();
  await openEmail(page, p.project.id, 'Suppressions');
  await expect(page.getByRole('row').filter({ hasText: 'viewed@example.test' })).toBeVisible();

  await openEmail(page, p.project.id, 'Settings');
  const provider = card(page, 'Provider');
  await expect(provider.getByText(`Key ending ${apiKey.slice(-4)} is stored.`)).toBeVisible();
  await expect(provider.locator('code')).toHaveText(HIDDEN_VALUE);
  const settings = bodies.map((body) => { try { return JSON.parse(body); } catch { return null; } }).find((body) => body?.data?.webhookUrls);
  expect(settings.data.webhookUrls).toEqual({ ses: HIDDEN_VALUE, resend: HIDDEN_VALUE, brevo: HIDDEN_VALUE });

  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(body).not.toContain(p.email!.webhookToken);
    expect(body).not.toContain(apiKey);
  }
});

test('EMAIL-192 view-as writes are refused', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const p = await emailProject('email-192', { provider: 'brevo', requireOptIn: false });
  await sql(`UPDATE email_settings SET ses_topic_arn = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events' WHERE project_id = $1`, [p.project.id]);
  await seedPeople(p, p.owner.ip, ['E1']);
  await suppress(p.owner, p.project.id, 'lift@example.test');
  const before = await emailSettingsRow(p.project.id);
  const credentialsBefore = await sql(`SELECT * FROM push_channel_credentials WHERE project_id = $1 ORDER BY provider`, [p.project.id]);
  const activity = await projectActivity(p.project.id);
  const testAddress = uniqueEmail('email-192-test');
  const url = await viewAsHandoff(browser, baseURL, p.owner);

  const refusals: string[] = [];
  page.on('response', async (response) => {
    const method = response.request().method();
    if (!new URL(response.url()).pathname.startsWith('/api/email/') || method === 'GET') return;
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    refusals.push(`${method} ${new URL(response.url()).pathname} ${response.status()} ${body?.message}`);
  });
  const readOnlyToast = page.getByText('Read-only session', { exact: true });
  const expectRefused = async (method: string, pathPart: string, action: () => Promise<unknown>) => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === method && new URL(r.url()).pathname.includes(pathPart)),
      action(),
    ]);
    expect(response.status(), pathPart).toBe(403);
    expect(((await response.json()) as { message: string }).message, pathPart).toBe(READ_ONLY);
    await expect(readOnlyToast.first()).toBeVisible();
  };

  await openViewAs(page, url);
  await openEmail(page, p.project.id, 'Settings');
  const sender = card(page, 'Sender');
  await sender.getByLabel('From name').fill('Changed in view-as');
  await expectRefused('POST', '/api/email/settings', () => page.getByRole('button', { name: 'Save sender' }).click());
  await expect(page.getByText('Could not save', { exact: true })).toBeVisible();

  const provider = card(page, 'Provider');
  await provider.getByLabel('API key').fill('xkeysib-x');
  await expectRefused('POST', '/api/email/providers', () => provider.getByRole('button', { name: 'Replace and use Brevo' }).click());
  await expect(page.getByText('Could not connect', { exact: true })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await expectRefused('POST', '/rotate-webhook-token', () => provider.getByRole('button', { name: 'Replace URL' }).click());
  await expect(page.getByText('Could not replace the URL', { exact: true })).toBeVisible();

  await provider.getByRole('tab', { name: /Amazon SES/ }).click();
  await expectRefused('POST', '/reset-ses-topic', () => provider.getByRole('button', { name: 'Switch topic' }).click());

  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('you@yourapp.com').fill(testAddress);
  await expectRefused('POST', '/api/email/test-send', () => testCard.getByRole('button', { name: 'Send test' }).click());
  await expect(testCard.getByText(READ_ONLY, { exact: true })).toBeVisible();

  await openEmail(page, p.project.id, 'Suppressions');
  await page.getByPlaceholder('someone@example.com').fill('new@example.test');
  await expectRefused('POST', '/api/email/suppressions', () => page.getByRole('button', { name: 'Suppress', exact: true }).click());
  await expect(page.getByText('That is not a valid address', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await expectRefused('DELETE', '/api/email/suppressions/', () =>
    page.getByRole('row').filter({ hasText: 'lift@example.test' }).getByTitle('Resubscribe').click(),
  );
  await expect(page.getByRole('row').filter({ hasText: 'lift@example.test' })).toBeVisible();

  await expectRefused('POST', '/api/email/audience-preview', () => page.goto(`/projects/${p.project.id}/email/new`));
  await expect(reachLine(page)).toHaveText('Choose an audience to see its reach.');
  await page.getByLabel('Subject').fill('From view-as');
  await page.getByLabel('HTML', { exact: true }).fill('<p>Hi</p>');
  await expectRefused('POST', '/api/email/send', () => page.getByRole('button', { name: 'Send email' }).click());
  await expect(page.getByText('Could not create email', { exact: true })).toBeVisible();

  expect(refusals.every((line) => line.endsWith(`403 ${READ_ONLY}`)), refusals.join('\n')).toBe(true);
  expect(refusals.length).toBeGreaterThanOrEqual(9);
  expect(await emailSettingsRow(p.project.id)).toEqual(before);
  expect(await sql(`SELECT * FROM push_channel_credentials WHERE project_id = $1 ORDER BY provider`, [p.project.id])).toEqual(credentialsBefore);
  expect((await suppressionRows(p.project.id)).map((row) => row.address)).toEqual(['lift@example.test']);
  expect(await sql(`SELECT 1 FROM push_notification_logs WHERE project_id = $1`, [p.project.id])).toHaveLength(0);
  // The view-as itself is the only entry (staff.viewed_as, written when the code is spent).
  expect(await projectActivity(p.project.id)).toEqual([...activity, 'staff.viewed_as']);
  expect(await brevoCallsTo(testAddress)).toHaveLength(0);
});

test('EMAIL-193 suspended billing owner: test sends refused', async () => {
  const p = await emailProject('email-193', { provider: 'brevo', requireOptIn: false });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const address = uniqueEmail('email-193-test');
  const body = { projectId: p.project.id, to: address, subject: 'Suspended test', html: '<p>Hi</p>' };

  await suspendAccount(p.owner.userId);
  const refused = await call('POST', '/api/email/test-send', admin, body);
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe("This project's account is suspended.");
  expect(await brevoCallsTo(address)).toHaveLength(0);
});

test("EMAIL-196 an owner cannot read or lift another project's suppressions by id", async () => {
  const p = await emailProject('email-196', { provider: 'brevo' });
  const other = await emailProject('email-196-other', { provider: 'brevo' });
  await suppress(other.owner, other.project.id, 'theirs@example.test');

  const list = await call('GET', `/api/email/suppressions/${other.project.id}`, p.owner);
  expect(list.status).toBe(404);
  expect(messageOf(list)).toBe(PROJECT_NOT_FOUND);
  expect(list.text).not.toContain('theirs@example.test');

  const lift = await call('DELETE', `/api/email/suppressions/${other.project.id}/theirs%40example.test`, p.owner);
  expect(lift.status).toBe(404);
  expect(messageOf(lift)).toBe(PROJECT_NOT_FOUND);
  expect(await suppressionRows(other.project.id)).toEqual([
    expect.objectContaining({ address: 'theirs@example.test', reason: 'manual', source: 'dashboard' }),
  ]);
});

// ------------------------------------------------------------ R. Worker ---

test('EMAIL-204 a campaign whose whole audience dropped out ends "Nothing was delivered"', async ({ page }) => {
  test.setTimeout(240_000);
  const p = await emailProject('email-204', { provider: 'brevo', requireOptIn: false });
  const first = uniqueEmail('email-204-a');
  const second = uniqueEmail('email-204-b');
  await identifyEmail(p, p.owner.ip, { email: first, emailOptIn: true });
  await identifyEmail(p, p.owner.ip, { email: second, emailOptIn: true });
  const subject = `Everyone left ${Date.now()}`;
  const campaign = await scheduleEmailCampaign(p.owner, p.project.id, subject);
  expect(campaign.totalTokens).toBe(2);

  await suppress(p.owner, p.project.id, first);
  await suppress(p.owner, p.project.id, second);
  // Its time comes (as if scheduled a minute ahead and the minute passed).
  await sql(`UPDATE push_notification_logs SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [campaign.id]);

  const row = async () => (await sql(`SELECT * FROM push_notification_logs WHERE id = $1`, [campaign.id]))[0];
  await expect.poll(async () => (await row()).status, { timeout: 180_000, intervals: [2_000] }).toBe('failed');
  const ended = await row();
  expect(ended).toMatchObject({ success_count: 0, failure_count: 0, error_message: NOTHING_DELIVERED });
  expect(ended.completed_at).not.toBeNull();
  expect(await brevoCallsTo(first)).toHaveLength(0);
  expect(await brevoCallsTo(second)).toHaveLength(0);

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Campaigns');
  const listed = page.getByRole('row').filter({ hasText: subject });
  await expect(listed.getByRole('cell').nth(1)).toHaveText('Failed');
  await expect(listed.getByRole('cell').nth(2)).toHaveText('0/2');
  await listed.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/${campaign.id}$`));
  await expect(page.getByText(NOTHING_DELIVERED, { exact: true })).toBeVisible();
});


import { randomBytes } from 'crypto';
import { connectFakeWhatsAppProvider, smsWebhookPath } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import { publicApiUrl } from '../../support/signing';
import {
  activityRows,
  call,
  campaignRows,
  card,
  consentRows,
  dataOf,
  DEFAULT_SENDER,
  eventRows,
  HIDDEN,
  identifyPhone,
  messageOf,
  openSms,
  openViewAs,
  PEOPLE,
  postTwilio,
  PROJECT_NOT_FOUND,
  projectConsentRows,
  READ_ONLY,
  repliesBlock,
  ROLE_REFUSAL,
  saveSender,
  scheduleSmsCampaign,
  seedPeople,
  sinceLabel,
  smsPreview,
  smsProject,
  smsSettingsRow,
  smsSuppressionList,
  sql,
  suppressionRows,
  suspendAccount,
  teammate,
  twilioCallsFor,
  twilioReply,
  twilioStatus,
  viewAsHandoff,
} from '../../support/areas/smswa';

/**
 * SMS: the Sender and Twilio cards, test sends, suppressions, the composer's reach and
 * sending, access by role and in view-as, a suspended tenant's campaigns, and Twilio's
 * status and inbound webhooks. Twilio connections are seeded (the real connect checks
 * the credentials with Twilio); people arrive through the SDK's identify route;
 * webhooks are signed with the seeded Auth Token over the API's public URL.
 */

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const SIGNATURE_REFUSED = 'Signature did not verify.';
const SUPPRESSED = 'This address is on the project’s suppression list.';
const OPTED_OUT = 'This person has opted out of these messages.';
const SUSPENDED_TEST_SEND = "This project's account is suspended.";
const NOBODY_OPT_IN =
  'Nobody in this audience can be texted. SMS needs a phone number with a country code (+...) and, because this project requires opt-in, sms_opt_in set to true.';
const NOBODY_NO_OPT_IN = 'Nobody in this audience has a phone number with a country code that has not opted out.';
const STOPPED_BY_SUSPENSION =
  'Stopped because this account was suspended. Anyone not yet reached did not receive this campaign, and it will not resume automatically.';
const MISSED_DURING_SUSPENSION =
  'Not sent: this account was suspended when the campaign was due. It will not be sent automatically; schedule it again if it is still wanted.';

// ------------------------------------------------------------ B. Sender card ---

test('SMSWA-018 first save creates the settings and reveals the Twilio form', async ({ page }) => {
  const p = await smsProject('smswa-018');
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  await expect(card(page, 'Twilio')).toContainText('Save the sender first, then connect your Twilio account.');

  await page.getByLabel('From', { exact: true }).fill(DEFAULT_SENDER);
  await expect(page.getByLabel('Opt-out line')).toHaveValue('Reply STOP to opt out.');
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(page.getByText('Sender saved', { exact: true })).toBeVisible();

  const twilio = card(page, 'Twilio');
  const sid = twilio.getByLabel('Account SID');
  const token = twilio.getByLabel('Auth token');
  await expect(sid).toHaveAttribute('placeholder', 'AC…');
  await expect(token).toHaveAttribute('type', 'password');
  await expect(
    twilio.getByText(
      "The auth token, not an API key: it is also what proves Twilio's delivery reports and STOP replies are genuine.",
    ),
  ).toBeVisible();
  const connect = twilio.getByRole('button', { name: 'Connect Twilio' });
  await expect(connect).toBeDisabled();
  await sid.fill(`AC${randomBytes(16).toString('hex')}`);
  await expect(connect).toBeDisabled();
  await token.fill(randomBytes(16).toString('hex'));
  await expect(connect).toBeEnabled();
  await expect(repliesBlock(page).locator('code')).toHaveText(
    new RegExp(`^${escapeRegExp(publicApiUrl('/api/sms/webhooks/twilio/'))}[0-9a-f]{48}/inbound$`),
  );

  const row = await smsSettingsRow(p.project.id);
  expect(row).toMatchObject({ sender: DEFAULT_SENDER, require_opt_in: true, opt_out_text: 'Reply STOP to opt out.', provider: null });
  expect(row?.webhook_token).toMatch(/^[0-9a-f]{48}$/);

  await page.getByRole('tab', { name: 'Campaigns' }).click();
  await expect(page.getByText('SMS is not set up yet. Add a sender and connect Twilio under Settings.')).toBeVisible();

  const status = await call('GET', `/api/sms/settings/${p.project.id}`, p.owner);
  expect(dataOf(status)).toMatchObject({ configured: true, readyToSend: false, providers: [] });
  expect(status.text).not.toContain('webhookToken');
  expect(dataOf(status).inboundWebhookUrl).toBe(publicApiUrl(`/api/sms/webhooks/twilio/${row?.webhook_token}/inbound`));
});

test('SMSWA-027 member and admin through the API: save sender', async () => {
  const p = await smsProject('smswa-027', { twilio: true });
  const member = await teammate(p.project.id, 'member', p.owner);
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const before = await smsSettingsRow(p.project.id);

  const refused = await call('POST', '/api/sms/settings', member, { projectId: p.project.id, sender: '+14155550124' });
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe(ROLE_REFUSAL);
  const unchanged = await smsSettingsRow(p.project.id);
  expect(unchanged?.sender).toBe(DEFAULT_SENDER);
  expect(unchanged?.updated_at).toEqual(before?.updated_at);

  const saved = await call('POST', '/api/sms/settings', admin, { projectId: p.project.id, sender: '+14155550124' });
  expect(saved.status).toBe(201);
  expect(dataOf(saved)).toMatchObject({ configured: true, readyToSend: true, settings: { sender: '+14155550124' } });
  expect((await smsSettingsRow(p.project.id))?.sender).toBe('+14155550124');
});

// ------------------------------------------------------------ C. Twilio card ---

test('SMSWA-041 member sees the connection without its secrets', async ({ page }) => {
  const p = await smsProject('smswa-041', { twilio: true });
  const member = await teammate(p.project.id, 'member', p.owner);
  const sms = p.sms!;

  await signIn(page, member);
  await openSms(page, p.project.id, 'Settings');
  const twilio = card(page, 'Twilio');
  await expect(twilio.getByText('Connected. Only owners and admins can see the account details.')).toBeVisible();
  await expect(page.getByLabel('Account SID')).toHaveCount(0);
  await expect(page.getByLabel('Auth token')).toHaveCount(0);
  await expect(twilio.getByRole('button', { name: /Connect Twilio|Replace credentials/ })).toHaveCount(0);
  const block = repliesBlock(page);
  await expect(block.locator('code')).toHaveText('Only owners and admins can see this.');
  await expect(block.getByRole('button')).toHaveCount(0);
  await expect(page.getByText(sms.credentials.accountSid)).toHaveCount(0);
  await expect(page.getByText(sms.webhookToken)).toHaveCount(0);

  const status = await call('GET', `/api/sms/settings/${p.project.id}`, member);
  expect(status.status).toBe(200);
  expect(dataOf(status).inboundWebhookUrl).toBe(HIDDEN);
  expect(dataOf(status).providers[0].accountSid).toBe(HIDDEN);
  expect(status.text).not.toContain(sms.webhookToken);
  expect(status.text).not.toContain(sms.credentials.accountSid);
});

test('SMSWA-043 member cannot connect a provider through the API', async () => {
  const p = await smsProject('smswa-043', { sender: true });
  const member = await teammate(p.project.id, 'member', p.owner);
  const accountSid = `AC${randomBytes(16).toString('hex')}`;

  const refused = await call('POST', '/api/sms/providers', member, {
    projectId: p.project.id,
    provider: 'twilio',
    credentials: JSON.stringify({ accountSid, authToken: randomBytes(16).toString('hex') }),
  });
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe(ROLE_REFUSAL);
  expect(await sql(`SELECT 1 FROM push_channel_credentials WHERE project_id = $1`, [p.project.id])).toHaveLength(0);
  expect((await smsSettingsRow(p.project.id))?.provider).toBeNull();
  expect(await twilioCallsFor(accountSid)).toHaveLength(0);
});

// ------------------------------------------------------------ D. Test send ---

test('SMSWA-047 test send to a suppressed number is refused without sending', async ({ page }) => {
  const p = await smsProject('smswa-047', { twilio: true });
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+14155550199' })).status).toBe(201);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('+919876543210').fill('+1 415 555 0199');
  await testCard.getByRole('button', { name: 'Send test' }).click();
  const line = testCard.getByText(SUPPRESSED, { exact: true });
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-destructive/);

  const answered = await call('POST', '/api/sms/test-send', p.owner, { projectId: p.project.id, to: '+1 415 555 0199', body: 'Test' });
  expect(answered.status).toBe(201);
  expect(dataOf(answered)).toEqual({ delivered: false, error: SUPPRESSED });
  expect((await twilioCallsFor(p.sms!.credentials.accountSid)).filter((c) => c.method === 'POST')).toHaveLength(0);
});

test('SMSWA-048 test send to a person who opted out of SMS is refused', async ({ page }) => {
  const p = await smsProject('smswa-048', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S3']);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('+919876543210').fill('+447700900123');
  await testCard.getByRole('button', { name: 'Send test' }).click();
  const line = testCard.getByText(OPTED_OUT, { exact: true });
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-destructive/);
  expect((await twilioCallsFor(p.sms!.credentials.accountSid)).filter((c) => c.method === 'POST')).toHaveLength(0);
});

test('SMSWA-051 test send while the billing owner is suspended', async ({ page }) => {
  const p = await smsProject('smswa-051', { twilio: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  // Suppressed too, so the refusal proves the suspension is checked first.
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: DEFAULT_SENDER })).status).toBe(201);
  await suspendAccount(p.owner.userId);

  await signIn(page, admin);
  await openSms(page, p.project.id, 'Settings');
  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('+919876543210').fill(DEFAULT_SENDER);
  await testCard.getByRole('button', { name: 'Send test' }).click();
  const line = testCard.getByText(SUSPENDED_TEST_SEND, { exact: true });
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-destructive/);

  const refused = await call('POST', '/api/sms/test-send', admin, { projectId: p.project.id, to: DEFAULT_SENDER, body: 'Test' });
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe(SUSPENDED_TEST_SEND);
  expect((await twilioCallsFor(p.sms!.credentials.accountSid)).filter((c) => c.method === 'POST')).toHaveLength(0);
});

// ------------------------------------------------------------ E. Suppressions ---

test('SMSWA-054 add a number by hand', async ({ page }) => {
  const p = await smsProject('smswa-054', { twilio: true });
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Suppressions');
  await expect(page.getByText('Nobody is suppressed.')).toBeVisible();
  const input = page.getByPlaceholder('+14155550123');
  await input.fill('+91 98765-43210');
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  await expect(input).toHaveValue('');

  const listed = (await smsSuppressionList(p.owner, p.project.id)).data;
  expect(listed).toHaveLength(1);
  const row = page.getByRole('row').filter({ hasText: '+919876543210' });
  await expect(row.getByRole('cell').nth(0)).toHaveText('+919876543210');
  await expect(row.getByRole('cell').nth(1)).toHaveText('Added by hand');
  await expect(row.getByRole('cell').nth(2)).toHaveText(sinceLabel(listed[0].createdAt));

  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ channel: 'sms', address: '+919876543210', reason: 'manual', source: 'dashboard' }),
  ]);
  const added = await activityRows(p.project.id, 'suppression.added');
  expect(added).toHaveLength(1);
  expect(added[0].details).toEqual({ channel: 'sms', address: '+91******10' });
  expect(await consentRows(S1)).toContainEqual({ channel: 'sms', granted: false, source: 'dashboard' });
});

test('SMSWA-059 lift a suppression after confirming', async ({ page }) => {
  const p = await smsProject('smswa-059', { twilio: true });
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+919876543210' })).status).toBe(201);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Suppressions');
  const row = page.getByRole('row').filter({ hasText: '+919876543210' });
  await expect(row).toBeVisible();
  let message = '';
  page.once('dialog', async (dialog) => {
    message = dialog.message();
    await dialog.accept();
  });
  await row.getByTitle('Resubscribe').click();
  await expect(page.getByText('Nobody is suppressed.')).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(message).toBe('Text +919876543210 again? Only do this if they asked to be resubscribed.');

  expect(await suppressionRows(p.project.id)).toHaveLength(0);
  const removed = await activityRows(p.project.id, 'suppression.removed');
  expect(removed).toHaveLength(1);
  expect(removed[0].details).toEqual({ channel: 'sms', address: '+91******10' });
  const history = await consentRows(S1);
  expect(history[history.length - 1]).toEqual({ channel: 'sms', granted: true, source: 'dashboard' });
});

test('SMSWA-065 suppressions are per channel and per project', async () => {
  const p = await smsProject('smswa-065', { twilio: true });
  const other = await smsProject('smswa-065-other', {}, p.owner);
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+14155550199' })).status).toBe(201);

  const mine = await smsSuppressionList(p.owner, p.project.id);
  expect(mine.total).toBe(1);
  expect(mine.data[0]).toMatchObject({ address: '+14155550199', channel: 'sms' });
  expect(await smsSuppressionList(p.owner, other.project.id)).toEqual({ data: [], total: 0 });
  const whatsapp = await call('GET', `/api/whatsapp/suppressions/${p.project.id}`, p.owner);
  expect(dataOf(whatsapp)).toEqual({ data: [], total: 0 });
});

test('SMSWA-067 suppressed numbers drop out of the reach count', async ({ page }) => {
  const p = await smsProject('smswa-067', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S1', 'S2']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/sms/new`);
  await expect(page.getByText('2 recipient(s)', { exact: true })).toBeVisible();
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: PEOPLE.S1.phone })).status).toBe(201);
  await page.reload();
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
});

// ------------------------------------------------------------ F. Composer ---

test('SMSWA-077 reach count for everyone respects consent, phone form, suppressions and duplicates', async ({ page }) => {
  const p = await smsProject('smswa-077', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/sms/new`);
  await expect(
    page.getByText('People with a phone number in international form who have not replied STOP, and who opted in.', { exact: true }),
  ).toBeVisible();
  // S2 and one of S7/S8: S1's number is refused by S9, S3 opted out, S4 never opted in.
  await expect(page.getByText('2 recipient(s)', { exact: true })).toBeVisible();
  expect(await smsPreview(p.owner, p.project.id)).toEqual({ targetType: 'project', recipients: 2, requireOptIn: true });
});

test('SMSWA-078 reach count with opt-in not required', async ({ page }) => {
  const p = await smsProject('smswa-078', { twilio: true, requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/sms/new`);
  await expect(
    page.getByText('People with a phone number in international form who have not replied STOP.', { exact: true }),
  ).toBeVisible();
  // S2, S4 and one of S7/S8; S1 (refused by S9), S3, S5 and S6 stay out.
  await expect(page.getByText('3 recipient(s)', { exact: true })).toBeVisible();
  expect(await smsPreview(p.owner, p.project.id)).toEqual({ targetType: 'project', recipients: 3, requireOptIn: false });
});

test('SMSWA-084 send now', async ({ page }) => {
  const p = await smsProject('smswa-084', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/sms/new`);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Text', { exact: true }).fill('Flash sale today');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/sms/send') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Send text' }).click(),
  ]);
  expect(response.status()).toBe(201);
  const created = ((await response.json()) as { data: Record<string, any> }).data;
  expect(created).toMatchObject({
    channel: 'sms',
    body: 'Flash sale today',
    title: 'Flash sale today',
    targetType: 'project',
    totalTokens: 1,
    status: 'queued',
    scheduledAt: null,
  });
  await expect(page.getByText('Text queued', { exact: true })).toBeVisible();
  await expect(page.getByText('1 recipient(s).', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/sms$`));
  await expect(page.getByRole('row').filter({ hasText: 'Flash sale today' })).toBeVisible();

  const rows = await campaignRows(p.project.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: created.id, channel: 'sms', body: 'Flash sale today', target_type: 'project', total_tokens: 1, scheduled_at: null });
  expect(await activityRows(p.project.id, 'campaign.sent')).toHaveLength(1);
});

test('SMSWA-086 schedule for later', async ({ page }) => {
  const p = await smsProject('smswa-086', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/sms/new`);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Text', { exact: true }).fill('Weekend offer');
  await page.getByText('Schedule for later', { exact: true }).locator('..').getByRole('switch').click();
  const schedule = page.getByRole('button', { name: 'Schedule text' });
  await expect(schedule).toBeDisabled();
  await page.getByRole('button', { name: 'Pick date & time' }).click();
  await page.getByRole('button', { name: /next month/i }).click();
  await page.getByRole('gridcell', { name: '15' }).getByRole('button').click();
  await page.locator('input[type="time"]').fill('10:30');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /10:30$/ })).toBeVisible();

  const now = new Date();
  const expected = new Date(now.getFullYear(), now.getMonth() + 1, 15, 10, 30, 0, 0);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/sms/send') && r.request().method() === 'POST'),
    schedule.click(),
  ]);
  expect(response.status()).toBe(201);
  const created = ((await response.json()) as { data: Record<string, any> }).data;
  expect(created.status).toBe('scheduled');
  expect(new Date(created.scheduledAt).toISOString()).toBe(expected.toISOString());
  await expect(page.getByText('Text scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('1 recipient(s).', { exact: true })).toBeVisible();

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/sms$`));
  const row = page.getByRole('row').filter({ hasText: 'Weekend offer' });
  await expect(row).toContainText('Scheduled');
  const month = expected.toLocaleString('en-US', { month: 'short' });
  await expect(row.locator('span.text-blue-600')).toHaveText(`${month} 15, 10:30`);

  const [stored] = await campaignRows(p.project.id);
  expect(stored.status).toBe('scheduled');
  expect(new Date(stored.scheduled_at).toISOString()).toBe(expected.toISOString());
  expect(await activityRows(p.project.id, 'campaign.scheduled')).toHaveLength(1);
});

test('SMSWA-095 send refused when nobody can be texted', async () => {
  const p = await smsProject('smswa-095', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S3']);

  const optInRequired = await call('POST', '/api/sms/send', p.owner, { projectId: p.project.id, body: 'Hello' });
  expect(optInRequired.status).toBe(400);
  expect(messageOf(optInRequired)).toBe(NOBODY_OPT_IN);

  await saveSender(p.owner, p.project.id, { requireOptIn: false });
  const optInOff = await call('POST', '/api/sms/send', p.owner, { projectId: p.project.id, body: 'Hello' });
  expect(optInOff.status).toBe(400);
  expect(messageOf(optInOff)).toBe(NOBODY_NO_OPT_IN);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('SMSWA-096 send refused when SMS is not set up', async () => {
  const blank = await smsProject('smswa-096');
  const notSetUp = await call('POST', '/api/sms/send', blank.owner, { projectId: blank.project.id, body: 'Hello' });
  expect(notSetUp.status).toBe(404);
  expect(messageOf(notSetUp)).toBe('SMS is not set up for this project. Add a sender in SMS settings.');

  const senderOnly = await smsProject('smswa-096-sender', { sender: true }, blank.owner);
  const noTwilio = await call('POST', '/api/sms/send', blank.owner, { projectId: senderOnly.project.id, body: 'Hello' });
  expect(noTwilio.status).toBe(400);
  expect(messageOf(noTwilio)).toBe('Connect Twilio in SMS settings before sending.');
  expect(await campaignRows(blank.project.id)).toHaveLength(0);
  expect(await campaignRows(senderOnly.project.id)).toHaveLength(0);
});

// ------------------------------------------------------------ G. Access ---

test('SMSWA-103 outsider and malformed ids get 404 on every SMS route', async () => {
  const p = await smsProject('smswa-103', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+14155550199' })).status).toBe(201);
  const outsider = await smsProject('smswa-103-outsider');
  const before = await smsSettingsRow(p.project.id);
  const id = p.project.id;

  const routes: Array<[string, string, unknown?]> = [
    ['GET', `/api/sms/settings/${id}`],
    ['POST', '/api/sms/settings', { projectId: id, sender: '+14155550124' }],
    ['POST', '/api/sms/providers', { projectId: id, provider: 'twilio', credentials: JSON.stringify({ accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32) }) }],
    ['POST', '/api/sms/audience-preview', { projectId: id }],
    ['POST', '/api/sms/send', { projectId: id, body: 'Hello', scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }],
    ['POST', '/api/sms/test-send', { projectId: id, body: 'Hello', to: '+14155550111' }],
    ['GET', `/api/sms/suppressions/${id}`],
    ['POST', '/api/sms/suppressions', { projectId: id, address: '+14155550177' }],
    ['DELETE', `/api/sms/suppressions/${id}/${encodeURIComponent('+14155550199')}`],
    ['GET', '/api/sms/settings/abc'],
  ];
  for (const [method, path, body] of routes) {
    const answered = await call(method, path, outsider.owner, body);
    expect(`${method} ${path} ${answered.status} ${messageOf(answered)}`).toBe(`${method} ${path} 404 ${PROJECT_NOT_FOUND}`);
  }

  const after = await smsSettingsRow(id);
  expect(after?.sender).toBe(DEFAULT_SENDER);
  expect(after?.updated_at).toEqual(before?.updated_at);
  expect((await suppressionRows(id)).map((row) => row.address)).toEqual(['+14155550199']);
  expect(await campaignRows(id)).toHaveLength(0);
  expect((await twilioCallsFor(p.sms!.credentials.accountSid)).filter((c) => c.method === 'POST')).toHaveLength(0);
});

test('SMSWA-105 member refused channel settings, allowed messaging', async () => {
  const p = await smsProject('smswa-105', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  const member = await teammate(p.project.id, 'member', p.owner);
  const id = p.project.id;
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: id, address: '+14155550199' })).status).toBe(201);

  const settings = await call('POST', '/api/sms/settings', member, { projectId: id, sender: '+14155550124' });
  expect([settings.status, messageOf(settings)]).toEqual([403, ROLE_REFUSAL]);
  const providers = await call('POST', '/api/sms/providers', member, {
    projectId: id,
    provider: 'twilio',
    credentials: JSON.stringify({ accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32) }),
  });
  expect([providers.status, messageOf(providers)]).toEqual([403, ROLE_REFUSAL]);

  const preview = await call('POST', '/api/sms/audience-preview', member, { projectId: id });
  expect(preview.status).toBe(201);
  expect(dataOf(preview)).toMatchObject({ recipients: 1 });
  const testSend = await call('POST', '/api/sms/test-send', member, { projectId: id, body: 'Hello', to: '+14155550199' });
  expect(testSend.status).toBe(201);
  expect(dataOf(testSend)).toEqual({ delivered: false, error: SUPPRESSED });
  const add = await call('POST', '/api/sms/suppressions', member, { projectId: id, address: '+14155550177' });
  expect(add.status).toBe(201);
  const lift = await call('DELETE', `/api/sms/suppressions/${id}/${encodeURIComponent('+14155550177')}`, member);
  expect(lift.status).toBe(200);
  expect(dataOf(lift)).toEqual({ removed: true });
  const send = await call('POST', '/api/sms/send', member, {
    projectId: id,
    body: 'Member text',
    scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  expect(send.status).toBe(201);
  expect(dataOf(send)).toMatchObject({ status: 'scheduled', channel: 'sms' });
  expect((await smsSettingsRow(id))?.sender).toBe(DEFAULT_SENDER);
});

test('SMSWA-106 view-as: SMS pages read-only with secrets hidden', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await smsProject('smswa-106', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+14155550188' })).status).toBe(201);
  const before = await smsSettingsRow(p.project.id);
  const url = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, url);

  // 1. Settings: the inbound URL and account are withheld.
  await openSms(page, p.project.id, 'Settings');
  await expect(repliesBlock(page).locator('code')).toHaveText(HIDDEN);
  await expect(page.getByText(`Account ${HIDDEN}, auth token ending ${p.sms!.credentials.authToken.slice(-4)}.`)).toBeVisible();

  // 2. Save sender is refused.
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(page.getByText('Read-only session', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Could not save', { exact: true })).toBeVisible();
  await expect(page.getByText(READ_ONLY, { exact: true }).first()).toBeVisible();

  // 3. Adding a suppression is refused (with the component's own toast too).
  await openSms(page, p.project.id, 'Suppressions');
  await page.getByPlaceholder('+14155550123').fill('+14155550177');
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  await expect(page.getByText('That is not a valid number', { exact: true })).toBeVisible();
  await expect(page.getByText('Read-only session', { exact: true }).first()).toBeVisible();

  // 4. Lifting one is refused; the row stays.
  const row = page.getByRole('row').filter({ hasText: '+14155550188' });
  page.once('dialog', (dialog) => dialog.accept());
  const [lift] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/sms/suppressions/')),
    row.getByTitle('Resubscribe').click(),
  ]);
  expect(lift.status()).toBe(403);
  await expect(row).toBeVisible();

  // 5. The composer's reach count (a POST) and the send are refused.
  const [previewAnswer] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/sms/audience-preview')),
    page.goto(`/projects/${p.project.id}/sms/new`),
  ]);
  expect(previewAnswer.status()).toBe(403);
  await expect(page.getByText('Read-only session', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Choose an audience to see its reach.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send text' }).click();
  await expect(page.getByText('Could not create text', { exact: true })).toBeVisible();

  const after = await smsSettingsRow(p.project.id);
  expect(after?.updated_at).toEqual(before?.updated_at);
  expect((await suppressionRows(p.project.id)).map((r) => r.address)).toEqual(['+14155550188']);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('SMSWA-108 campaign stopped when the tenant is suspended', async () => {
  test.setTimeout(180_000);
  const p = await smsProject('smswa-108', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const due = await scheduleSmsCampaign(p.owner, p.project.id, 'Due during the suspension');

  await suspendAccount(p.owner.userId);
  // Its moment passes while the account is suspended.
  await sql(`UPDATE push_notification_logs SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [due.id]);
  // Creating one is not refused while suspended; the worker stops it.
  const queued = await call('POST', '/api/sms/send', admin, { projectId: p.project.id, body: 'Sent while suspended' });
  expect(queued.status).toBe(201);
  expect(dataOf(queued).status).toBe('queued');

  const campaign = async (id: string) => dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${id}`, admin));
  await expect
    .poll(async () => (await campaign(dataOf(queued).id)).status, { timeout: 60_000 })
    .toBe('failed');
  expect((await campaign(dataOf(queued).id)).errorMessage).toBe(STOPPED_BY_SUSPENSION);
  await expect.poll(async () => (await campaign(due.id)).status, { timeout: 100_000, intervals: [2_000] }).toBe('cancelled');
  expect((await campaign(due.id)).errorMessage).toBe(MISSED_DURING_SUSPENSION);
  expect((await twilioCallsFor(p.sms!.credentials.accountSid)).filter((c) => c.method === 'POST')).toHaveLength(0);
});

// ------------------------------------------------------------ H. Twilio webhooks ---

test('SMSWA-109 unknown or malformed token', async () => {
  const p = await smsProject('smswa-109', { twilio: true });
  const sms = p.sms!;
  const tokens = ['abc', randomBytes(24).toString('hex'), sms.webhookToken.toUpperCase()];
  for (const token of tokens) {
    for (const kind of ['status', 'inbound'] as const) {
      const params: Record<string, string> =
        kind === 'status'
          ? { AccountSid: sms.credentials.accountSid, MessageStatus: 'failed', ErrorCode: '21211', To: '+14155550111' }
          : { AccountSid: sms.credentials.accountSid, From: '+14155550111', Body: 'STOP' };
      const answered = await postTwilio(smsWebhookPath(token, kind), params, { authToken: sms.credentials.authToken });
      expect(`${token} ${kind} ${answered.status}`).toBe(`${token} ${kind} 404`);
    }
  }
  expect(await suppressionRows(p.project.id)).toHaveLength(0);
});

test('SMSWA-111 missing, wrong or replayed-to-another-URL signature', async () => {
  const p = await smsProject('smswa-111', { twilio: true });
  const sms = p.sms!;
  const inbound = smsWebhookPath(sms.webhookToken, 'inbound');
  const params = { AccountSid: sms.credentials.accountSid, From: '+14155550111', Body: 'STOP' };

  const attempts = [
    await postTwilio(inbound, params),
    await postTwilio(inbound, params, { authToken: randomBytes(16).toString('hex') }),
    await postTwilio(inbound, params, { authToken: sms.credentials.authToken, signPath: smsWebhookPath(sms.webhookToken, 'status') }),
    await postTwilio(inbound, params, { authToken: sms.credentials.authToken, extra: { NumMedia: '0' } }),
  ];
  expect(attempts.map((a) => [a.status, messageOf(a)])).toEqual(Array(4).fill([401, SIGNATURE_REFUSED]));
  expect(await suppressionRows(p.project.id)).toHaveLength(0);
  // The same request, signed as Twilio signs it, is accepted.
  expect((await postTwilio(inbound, params, { authToken: sms.credentials.authToken })).status).toBe(200);
  expect(await suppressionRows(p.project.id)).toHaveLength(1);
});

test('SMSWA-112 delivered report recorded against the campaign', async () => {
  const p = await smsProject('smswa-112', { twilio: true });
  const { S2 } = await seedPeople(p, p.owner.ip, ['S2']);
  const campaign = await scheduleSmsCampaign(p.owner, p.project.id);
  const report = { MessageStatus: 'delivered', To: '+14155550111' };

  const first = await twilioStatus(p.sms!, report, { campaignId: campaign.id, identityId: S2 });
  const repeat = await twilioStatus(p.sms!, report, { campaignId: campaign.id, identityId: S2 });
  expect([first.status, repeat.status]).toEqual([204, 204]);
  const events = await eventRows(p.project.id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'delivered', platform: 'sms', campaign_id: campaign.id, device_identity_id: S2 });
  const shown = dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${campaign.id}`, p.owner));
  expect(shown.engagement.delivered).toBe(1);
});

test('SMSWA-115 dead-number codes suppress the number', async ({ page }) => {
  const p = await smsProject('smswa-115', { twilio: true });
  const numbers: Record<string, string> = { '21211': '+14155550201', '21614': '+14155550202', '30005': '+14155550203', '30006': '+14155550204' };
  const ids: Record<string, string> = {};
  for (const [code, phone] of Object.entries(numbers)) ids[code] = await identifyPhone(p, p.owner.ip, { phone, smsOptIn: true });
  const campaign = await scheduleSmsCampaign(p.owner, p.project.id);
  const consentBefore = await projectConsentRows(p.project.id);

  for (const [code, phone] of Object.entries(numbers)) {
    // 30006 names no campaign: a dead number found by a test send counts too.
    const query = code === '30006' ? {} : { campaignId: campaign.id, identityId: ids[code] };
    const answered = await twilioStatus(p.sms!, { MessageStatus: 'failed', ErrorCode: code, To: phone }, query);
    expect(answered.status).toBe(204);
  }
  const rows = await suppressionRows(p.project.id);
  expect(rows.map((row) => [row.address, row.reason, row.source, row.detail])).toEqual(
    Object.entries(numbers).map(([code, phone]) => [phone, 'bounced', 'twilio', `Twilio error ${code}`]),
  );
  expect(await projectConsentRows(p.project.id)).toHaveLength(consentBefore.length);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Suppressions');
  const cell = page.getByRole('row').filter({ hasText: numbers['21211'] }).getByRole('cell').nth(1);
  await expect(cell).toHaveText('Number not reachable');
  await expect(cell).toHaveAttribute('title', 'Twilio error 21211');
});

test('SMSWA-116 error 21610 in a status report records an unsubscribe', async () => {
  const p = await smsProject('smswa-116', { twilio: true });
  const { S2 } = await seedPeople(p, p.owner.ip, ['S2']);
  const campaign = await scheduleSmsCampaign(p.owner, p.project.id);

  const answered = await twilioStatus(
    p.sms!,
    { MessageStatus: 'undelivered', ErrorCode: '21610', To: '+14155550111' },
    { campaignId: campaign.id, identityId: S2 },
  );
  expect(answered.status).toBe(204);
  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ address: '+14155550111', reason: 'unsubscribed', source: 'twilio', detail: 'Twilio error 21610' }),
  ]);
  const history = await consentRows(S2);
  expect(history[history.length - 1]).toEqual({ channel: 'sms', granted: false, source: 'stop_reply' });
  expect((await eventRows(p.project.id)).filter((event) => event.type === 'bounced')).toHaveLength(0);
});

test("SMSWA-118 report for another project's campaign or identity is not recorded", async () => {
  const p = await smsProject('smswa-118', { twilio: true });
  const { S2: mine } = await seedPeople(p, p.owner.ip, ['S2']);
  const myCampaign = await scheduleSmsCampaign(p.owner, p.project.id);
  const other = await smsProject('smswa-118-other', { twilio: true });
  const { S2: theirs } = await seedPeople(other, other.owner.ip, ['S2']);
  const theirCampaign = await scheduleSmsCampaign(other.owner, other.project.id);
  const report = { MessageStatus: 'delivered', To: '+14155550111' };

  const foreignCampaign = await twilioStatus(p.sms!, report, { campaignId: theirCampaign.id, identityId: mine });
  const foreignIdentity = await twilioStatus(p.sms!, report, { campaignId: myCampaign.id, identityId: theirs });
  expect([foreignCampaign.status, foreignIdentity.status]).toEqual([204, 204]);
  expect(await eventRows(p.project.id)).toHaveLength(0);
  expect(await eventRows(other.project.id)).toHaveLength(0);
});

test('SMSWA-121 STOP reply suppresses the number', async ({ page }) => {
  const p = await smsProject('smswa-121', { twilio: true });
  const { S2 } = await seedPeople(p, p.owner.ip, ['S2']);
  expect((await smsPreview(p.owner, p.project.id)).recipients).toBe(1);

  const answered = await twilioReply(p.sms!, '+14155550111', 'STOP');
  expect(answered.status).toBe(200);
  expect(answered.headers.get('content-type')).toMatch(/^text\/xml/);
  expect(answered.text).toBe(EMPTY_TWIML);
  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ address: '+14155550111', reason: 'unsubscribed', source: 'twilio', detail: 'Replied STOP' }),
  ]);
  const history = await consentRows(S2);
  expect(history[history.length - 1]).toEqual({ channel: 'sms', granted: false, source: 'stop_reply' });
  expect((await smsPreview(p.owner, p.project.id)).recipients).toBe(0);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Suppressions');
  await expect(page.getByRole('row').filter({ hasText: '+14155550111' }).getByRole('cell').nth(1)).toHaveText('Unsubscribed');
});

test('SMSWA-123 START lifts a STOP only', async () => {
  const p = await smsProject('smswa-123', { twilio: true });
  const { S2 } = await seedPeople(p, p.owner.ip, ['S2']);
  const add = (address: string, reason: string) =>
    call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address, reason });
  for (const from of ['+14155550111', '+14155550144', '+14155550155']) {
    expect((await twilioReply(p.sms!, from, 'STOP')).status).toBe(200);
  }
  expect((await add('+14155550122', 'manual')).status).toBe(201);
  expect((await add('+14155550133', 'bounced')).status).toBe(201);
  expect((await suppressionRows(p.project.id)).map((r) => [r.address, r.reason])).toEqual([
    ['+14155550111', 'unsubscribed'],
    ['+14155550122', 'manual'],
    ['+14155550133', 'bounced'],
    ['+14155550144', 'unsubscribed'],
    ['+14155550155', 'unsubscribed'],
  ]);

  for (const [from, body] of [
    ['+14155550111', 'START'],
    ['+14155550122', 'START'],
    ['+14155550133', 'START'],
    ['+14155550144', 'YES'],
    ['+14155550155', 'unstop'],
  ]) {
    expect((await twilioReply(p.sms!, from, body)).status).toBe(200);
  }
  expect((await suppressionRows(p.project.id)).map((r) => [r.address, r.reason])).toEqual([
    ['+14155550122', 'manual'],
    ['+14155550133', 'bounced'],
  ]);
  const history = await consentRows(S2);
  expect(history[history.length - 1]).toEqual({ channel: 'sms', granted: true, source: 'start_reply' });
});

test('SMSWA-125 SMS STOP does not stop WhatsApp', async () => {
  const p = await smsProject('smswa-125', { twilio: true });
  await connectFakeWhatsAppProvider(p.project.id, 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  const whatsappReach = async () => dataOf(await call('POST', '/api/whatsapp/audience-preview', p.owner, { projectId: p.project.id })).recipients;
  expect(await whatsappReach()).toBe(1);

  expect((await twilioReply(p.sms!, PEOPLE.S1.phone!, 'STOP')).status).toBe(200);
  expect((await smsSuppressionList(p.owner, p.project.id)).data.map((row) => row.address)).toEqual([PEOPLE.S1.phone]);
  expect((await smsPreview(p.owner, p.project.id)).recipients).toBe(0);
  expect(await whatsappReach()).toBe(1);
  expect(dataOf(await call('GET', `/api/whatsapp/suppressions/${p.project.id}`, p.owner))).toEqual({ data: [], total: 0 });
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
});

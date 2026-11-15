import { randomBytes } from 'crypto';
import { allowClipboard, readClipboard } from '../../support/browser-tools';
import { expect, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import { publicApiUrl } from '../../support/signing';
import {
  activityOf,
  activityRows,
  call,
  campaignRow,
  card,
  dataOf,
  deactivateCredential,
  DEFAULT_SENDER,
  messageOf,
  newPerson,
  openSms,
  PROJECT_NOT_FOUND,
  recordRequests,
  repliesBlock,
  saveSender,
  seedListRow,
  seedPeople,
  smsOptInSwitch,
  smsProject,
  smsSettingsRow,
  smsSuppressionList,
  sql,
  suppressionRows,
  teammate,
  toastTitled,
  twilioCallsFor,
  twilioStatus,
  waSettingsRow,
} from '../../support/areas/smswa';
import { createProject } from '../../support/api';

/**
 * SMS, second round: the SMS page and its campaign list, the Sender card's checks and
 * saves, the Twilio card (format refusals, connected state, the inbound URL), the test
 * card's refusals and the suppression list's add, lift and roles. Twilio connections are
 * seeded; people arrive through the SDK's identify route.
 */

test.describe.configure({ mode: 'parallel' });

const SENDER_INVALID = 'Not a number with a country code, an MG… SID, or a sender ID.';
const SENDER_REFUSED =
  'The sender must be a number in international form (+14155550123), a Messaging Service SID (MG...), or a sender ID of up to 11 letters and digits.';
const NOT_SET_UP = 'SMS is not set up yet. Add a sender and connect Twilio under Settings.';
const SID_FORMAT = 'A Twilio Account SID starts with "AC" followed by 32 characters. Find it on the Twilio Console home page.';
const TOKEN_FORMAT = 'The Twilio Auth Token is 32 characters, shown under Account Info on the Console home page.';
const SENDER_FIRST = 'Set the sender before connecting a provider.';
const BAD_JSON = 'Credentials must be valid JSON.';
const UNREADABLE = 'The twilio credentials for this project are missing or unreadable. Reconnect the provider.';
const BAD_TEST_NUMBER = 'Enter the number in international form, with its country code: +14155550123.';
const BAD_SUPPRESS_NUMBER = 'Enter the number in international form, with its country code.';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const fakeSid = () => `AC${hex(16)}`;

// ------------------------------------------------------- A. Page and campaign list ---

test('SMSWA-001 open the SMS page from the sidebar', async ({ page }) => {
  test.info().annotations.push({ type: 'issue', description: 'SMSWA-001' });
  test.fail();
  const p = await smsProject('smswa-001', { twilio: true });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}`);
  await openSidebarGroup(page, 'Engagement');
  await expect(sidebarLink(page, 'Push Notifications')).toBeVisible();
  await expect(sidebarLink(page, 'SMS')).toBeVisible({ timeout: 5000 });
  await sidebarLink(page, 'SMS').click();

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/sms$`));
  await expect(page.getByRole('heading', { name: 'SMS', exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Text campaigns sent through your own Twilio account, with the same audiences, schedules and experiments as push and email.',
    ),
  ).toBeVisible();
  for (const tab of ['Campaigns', 'Suppressions', 'Settings']) {
    await expect(page.getByRole('tab', { name: tab, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: 'New text' })).toHaveAttribute('href', `/projects/${p.project.id}/sms/new`);
});

test('SMSWA-002 not set up: warning on the Campaigns tab, no create button', async ({ page }) => {
  const p = await smsProject('smswa-002');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/sms`);

  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(NOT_SET_UP)).toBeVisible();
  await expect(card(page, 'Campaigns')).toContainText(
    'Sent is what Twilio accepted. Delivered and undelivered come from its delivery reports, which need the API to be reachable from the internet.',
  );
  await expect(page.getByText('No SMS campaigns yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first text' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New text' })).toHaveAttribute('disabled', '');
});

test('SMSWA-004 ready project with no campaigns shows the create button', async ({ page }) => {
  const p = await smsProject('smswa-004', { twilio: true });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/sms`);

  await expect(page.getByText('No SMS campaigns yet.')).toBeVisible();
  await expect(page.getByText(NOT_SET_UP)).toHaveCount(0);
  const newText = page.getByRole('link', { name: 'New text' });
  await expect(newText).toBeEnabled();
  await expect(newText).not.toHaveAttribute('disabled');
  const create = page.getByRole('link', { name: 'Create your first text' });
  await expect(create).toHaveAttribute('href', `/projects/${p.project.id}/sms/new`);
  await create.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/sms/new$`));
  await expect(page.getByRole('heading', { name: 'New text', exact: true })).toBeVisible();
});

test('SMSWA-007 campaign list columns and only SMS rows', async ({ page }) => {
  const p = await smsProject('smswa-007', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  const scheduledTitle = `Later ${hex(3)}`;
  dataOf(
    await call('POST', '/api/sms/send', p.owner, {
      projectId: p.project.id,
      name: scheduledTitle,
      body: 'Scheduled for later',
      scheduledAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    }),
  );
  const sent = await seedListRow(p.project.id, 'sms', { title: `Sent ${hex(3)}`, successCount: 3, totalTokens: 4 });
  const push = await seedListRow(p.project.id, 'push', { title: `Push ${hex(3)}` });
  const email = await seedListRow(p.project.id, 'email', { title: `Email ${hex(3)}` });

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Campaigns');
  const table = card(page, 'Campaigns').getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Campaign', 'Status', 'Sent', 'Delivered', 'Undelivered', 'When']);
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(campaignRow(page, scheduledTitle)).toHaveCount(1);
  await expect(page.getByText(push.title)).toHaveCount(0);
  await expect(page.getByText(email.title)).toHaveCount(0);

  const cells = campaignRow(page, sent.title).getByRole('cell');
  await expect(cells.nth(1)).toHaveText('Sent');
  await expect(cells.nth(2)).toHaveText('3/4');
  await expect(cells.nth(3)).toHaveText('—');
  await expect(cells.nth(4)).toHaveText('—');
});

test('SMSWA-011 delivered and undelivered counts come from delivery reports', async ({ page }) => {
  const p = await smsProject('smswa-011', { twilio: true });
  const { S1, S2 } = await seedPeople(p, p.owner.ip, ['S1', 'S2']);
  const title = `Reports ${hex(3)}`;
  const campaign = dataOf(
    await call('POST', '/api/sms/send', p.owner, {
      projectId: p.project.id,
      name: title,
      body: 'Reports please',
      scheduledAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    }),
  );
  const delivered = await twilioStatus(p.sms!, { MessageStatus: 'delivered', To: '+919876543210' }, { campaignId: campaign.id, identityId: S1 });
  const undelivered = await twilioStatus(
    p.sms!,
    { MessageStatus: 'undelivered', ErrorCode: '30003', To: '+14155550111' },
    { campaignId: campaign.id, identityId: S2 },
  );
  expect([delivered.status, undelivered.status]).toEqual([204, 204]);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Campaigns');
  const cells = campaignRow(page, title).getByRole('cell');
  await expect(cells.nth(3)).toHaveText('1');
  await expect(cells.nth(4)).toHaveText('1');
});

test('SMSWA-012 clicking a row opens the shared campaign detail', async ({ page }) => {
  const p = await smsProject('smswa-012', { twilio: true });
  const c = await seedListRow(p.project.id, 'sms', { title: `Detail ${hex(3)}` });

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Campaigns');
  await campaignRow(page, c.title).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/${c.id}$`));
  const heading = page.getByRole('heading', { level: 1, name: c.title, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading.locator('..').locator('[data-slot="badge"]').filter({ hasText: /^\s*SMS\s*$/ })).toBeVisible();
});

test('SMSWA-014 campaign title with HTML is shown as text', async ({ page }) => {
  const p = await smsProject('smswa-014', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  const name = '<img src=x onerror="window.__xss=1">Promo';
  const campaign = dataOf(
    await call('POST', '/api/sms/send', p.owner, {
      projectId: p.project.id,
      name,
      body: 'Promo text',
      scheduledAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    }),
  );

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Campaigns');
  await expect(campaignRow(page, name)).toHaveCount(1);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();

  await campaignRow(page, name).click();
  await expect(page).toHaveURL(new RegExp(`/push-notifications/${campaign.id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
});

// ------------------------------------------------------------ B. Sender card ---

test('SMSWA-015 sender card for an owner on a fresh project', async ({ page }) => {
  const p = await smsProject('smswa-015');
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');

  const sender = card(page, 'Sender');
  await expect(sender.locator('[data-slot="card-description"]')).toHaveText('Who your texts come from, and who may receive them.');
  const from = page.getByLabel('From', { exact: true });
  await expect(from).toHaveValue('');
  await expect(from).toHaveAttribute('placeholder', '+14155550123');
  await expect(
    sender.getByText(/^A Twilio number in international form, a Messaging Service SID \(MG…\), or an alphanumeric sender ID of up to 11 characters/),
  ).toBeVisible();
  await expect(page.getByLabel('Opt-out line')).toHaveValue('Reply STOP to opt out.');
  await expect(smsOptInSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Save sender' })).toBeDisabled();
  await expect(card(page, 'Twilio')).toContainText('Save the sender first, then connect your Twilio account.');
  await expect(card(page, 'Send a test')).toHaveCount(0);
});

test('SMSWA-016 sender validation message for an invalid value', async ({ page }) => {
  const p = await smsProject('smswa-016');
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  const from = page.getByLabel('From', { exact: true });
  const save = page.getByRole('button', { name: 'Save sender' });

  for (const value of ['abc!', '12345', '+0123456789', '+1234567', 'ChumbaqShop1', '12 34']) {
    await from.fill(value);
    await expect(page.getByText(SENDER_INVALID, { exact: true }), value).toBeVisible();
    await expect(save, value).toBeDisabled();
  }
  // `MG123` is not refused: five letters and digits are a valid alphanumeric sender ID.
  await from.fill('MG123');
  await expect(page.getByText(SENDER_INVALID, { exact: true })).toHaveCount(0);
  await expect(save).toBeEnabled();
});

test('SMSWA-017 accepted sender forms', async ({ page }) => {
  const p = await smsProject('smswa-017');
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  const from = page.getByLabel('From', { exact: true });
  const save = page.getByRole('button', { name: 'Save sender' });

  for (const value of ['+14155550123', `MG${hex(16)}`, 'Chumbaq', 'Shop 24', ' +14155550123 ']) {
    // An invalid value first, so each accepted one is seen clearing the message.
    await from.fill('abc!');
    await expect(page.getByText(SENDER_INVALID, { exact: true })).toBeVisible();
    await from.fill(value);
    await expect(page.getByText(SENDER_INVALID, { exact: true }), value).toHaveCount(0);
    await expect(save, value).toBeEnabled();
  }
});

test('SMSWA-019 saving changes logs one activity entry naming the changed fields', async ({ page }) => {
  const p = await smsProject('smswa-019', { sender: true });
  const before = (await activityOf(p.project.id, 'channel.settings_changed')).length;

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  await expect(page.getByLabel('From', { exact: true })).toHaveValue(DEFAULT_SENDER);
  await page.getByLabel('Opt-out line').fill('Text STOP to end');
  await smsOptInSwitch(page).click();
  await expect(smsOptInSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(toastTitled(page, 'Sender saved')).toHaveCount(1);

  const afterFirst = await activityOf(p.project.id, 'channel.settings_changed');
  expect(afterFirst).toHaveLength(before + 1);
  expect(afterFirst.at(-1)!.details).toMatchObject({ channel: 'sms', fields: ['requireOptIn', 'optOutText'] });
  expect(afterFirst.at(-1)!.actor).toBe(p.owner.userId);

  const second = page.waitForResponse((r) => r.url().endsWith('/api/sms/settings') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save sender' }).click();
  expect((await second).status()).toBe(201);
  await expect(toastTitled(page, 'Sender saved')).toHaveCount(2);
  expect(await activityOf(p.project.id, 'channel.settings_changed')).toHaveLength(before + 1);
  expect(await smsSettingsRow(p.project.id)).toMatchObject({ require_opt_in: false, opt_out_text: 'Text STOP to end' });
});

test('SMSWA-020 empty opt-out line stores none', async ({ page }) => {
  const p = await smsProject('smswa-020', { sender: true });
  await signIn(page, p.owner);
  const description = card(page, 'Message').locator('[data-slot="card-description"]');
  const bubble = card(page, 'Preview').locator('div.whitespace-pre-wrap');
  // With the default line the composer names it and the preview appends it.
  await page.goto(`/projects/${p.project.id}/sms/new`);
  await expect(description).toContainText('“Reply STOP to opt out.” is added at the end.');
  await page.getByLabel('Text', { exact: true }).fill('Hello there');
  await expect(bubble).toContainText('Reply STOP to opt out.');

  await openSms(page, p.project.id, 'Settings');
  await expect(page.getByLabel('Opt-out line')).toHaveValue('Reply STOP to opt out.');
  await page.getByLabel('Opt-out line').fill('');
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(toastTitled(page, 'Sender saved')).toHaveCount(1);

  expect(dataOf(await call('GET', `/api/sms/settings/${p.project.id}`, p.owner)).settings.optOutText).toBeNull();
  await page.reload();
  const settingsTab = page.getByRole('tab', { name: 'Settings', exact: true });
  await settingsTab.click();
  await expect(page.getByLabel('From', { exact: true })).toHaveValue(DEFAULT_SENDER);
  await expect(page.getByLabel('Opt-out line')).toHaveValue('');

  await page.goto(`/projects/${p.project.id}/sms/new`);
  await expect(page.getByRole('heading', { name: 'New text', exact: true })).toBeVisible();
  // Shown only once the settings have loaded (this project has a sender, no Twilio), so the
  // checks below read the stored line rather than the page before it arrives.
  await expect(page.getByRole('link', { name: 'Finish setup' })).toBeVisible();
  await expect(description).toContainText('Personalise with');
  await expect(description).not.toContainText('is added at the end');
  await page.getByLabel('Text', { exact: true }).fill('Hello there');
  await expect(bubble).toHaveText('Hello there');
});

test('SMSWA-022 server-side sender validation, and how string booleans are read', async () => {
  const owner = await newPerson('smswa-022', 'Owen Owner');
  const sms = await createProject(owner, owner.ip);
  const wa = await createProject(owner, owner.ip);

  // 1. Refusals, none of which makes a row.
  const pattern = await call('POST', '/api/sms/settings', owner, { projectId: sms.id, sender: 'Not!Valid' });
  expect(pattern.status).toBe(400);
  expect(messageOf(pattern)).toBe(SENDER_REFUSED);
  const missing = await call('POST', '/api/sms/settings', owner, { projectId: sms.id });
  expect(missing.status).toBe(400);
  expect(missing.body.message).toEqual(expect.arrayContaining([SENDER_REFUSED, 'sender must be a string']));
  const extra = await call('POST', '/api/sms/settings', owner, { projectId: sms.id, sender: DEFAULT_SENDER, foo: 1 });
  expect(extra.status).toBe(400);
  expect(messageOf(extra)).toBe('property foo should not exist');
  const malformed = await call('POST', '/api/sms/settings', owner, { projectId: 'not-a-uuid', sender: DEFAULT_SENDER });
  expect(malformed.status).toBe(404);
  expect(messageOf(malformed)).toBe(PROJECT_NOT_FOUND);
  expect(await smsSettingsRow(sms.id)).toBeUndefined();

  const smsOptIn = async () => dataOf(await call('GET', `/api/sms/settings/${sms.id}`, owner)).settings.requireOptIn;
  const smsLogged = async () => (await activityOf(sms.id, 'channel.settings_changed')).length;

  // 2. 'yes' is read as true (implicit conversion runs before @IsBoolean).
  expect((await call('POST', '/api/sms/settings', owner, { projectId: sms.id, sender: DEFAULT_SENDER, requireOptIn: 'yes' })).status).toBe(201);
  expect(await smsOptIn()).toBe(true);
  const afterCreate = await smsLogged();

  // 3. 'false' is also read as true: nothing changes, nothing is logged.
  expect((await call('POST', '/api/sms/settings', owner, { projectId: sms.id, sender: DEFAULT_SENDER, requireOptIn: 'false' })).status).toBe(201);
  expect(await smsOptIn()).toBe(true);
  expect(await smsLogged()).toBe(afterCreate);

  // 4. '' is read as false: opt-in turned off, logged by name.
  expect((await call('POST', '/api/sms/settings', owner, { projectId: sms.id, sender: DEFAULT_SENDER, requireOptIn: '' })).status).toBe(201);
  expect(await smsOptIn()).toBe(false);
  const smsRows = await activityOf(sms.id, 'channel.settings_changed');
  expect(smsRows).toHaveLength(afterCreate + 1);
  expect(smsRows.at(-1)!.details).toMatchObject({ channel: 'sms', fields: ['requireOptIn'] });

  // 5. WhatsApp reads the same way.
  const waOptIn = async () => dataOf(await call('GET', `/api/whatsapp/settings/${wa.id}`, owner)).settings.requireOptIn;
  const waLogged = async () => activityOf(wa.id, 'channel.settings_changed');
  expect((await call('POST', '/api/whatsapp/settings', owner, { projectId: wa.id, requireOptIn: '' })).status).toBe(201);
  expect(await waSettingsRow(wa.id)).toBeDefined();
  expect(await waOptIn()).toBe(false);
  expect(await waLogged()).toHaveLength(1);
  expect((await waLogged())[0].details).toMatchObject({ channel: 'whatsapp', fields: ['requireOptIn'] });
  expect((await call('POST', '/api/whatsapp/settings', owner, { projectId: wa.id, requireOptIn: 'false' })).status).toBe(201);
  expect(await waOptIn()).toBe(true);
  expect(await waLogged()).toHaveLength(2);
  expect((await call('POST', '/api/whatsapp/settings', owner, { projectId: wa.id, requireOptIn: 'yes' })).status).toBe(201);
  expect(await waOptIn()).toBe(true);
  expect(await waLogged()).toHaveLength(2);
});

test('SMSWA-026 member sees the sender read-only', async ({ page }) => {
  const p = await smsProject('smswa-026', { twilio: true });
  await saveSender(p.owner, p.project.id, { sender: 'Chumbaq', optOutText: 'Stop? Reply STOP', requireOptIn: false });
  const member = await teammate(p.project.id, 'member', p.owner);

  await signIn(page, member);
  await openSms(page, p.project.id, 'Settings');
  const from = page.getByLabel('From', { exact: true });
  await expect(from).toHaveValue('Chumbaq');
  await expect(from).toBeDisabled();
  await expect(page.getByLabel('Opt-out line')).toHaveValue('Stop? Reply STOP');
  await expect(page.getByLabel('Opt-out line')).toBeDisabled();
  await expect(smsOptInSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(smsOptInSwitch(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save sender' })).toHaveCount(0);
});

// ------------------------------------------------------------ C. Twilio card ---

test('SMSWA-030 account SID format refused before any request', async ({ page }) => {
  const p = await smsProject('smswa-030', { sender: true });
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  const token = hex(16);
  const twilio = card(page, 'Twilio');
  await twilio.getByLabel('Account SID').fill('ACxyz');
  await twilio.getByLabel('Auth token').fill(token);
  await twilio.getByRole('button', { name: 'Connect Twilio' }).click();

  const toast = toastTitled(page, 'Could not connect');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveClass(/\bdestructive\b/);
  await expect(toast).toContainText(SID_FORMAT);
  await expect(twilio.getByLabel('Account SID')).toHaveValue('ACxyz');
  await expect(twilio.getByLabel('Auth token')).toHaveValue(token);
  expect(await sql(`SELECT 1 FROM push_channel_credentials WHERE project_id = $1`, [p.project.id])).toHaveLength(0);
  expect((await smsSettingsRow(p.project.id))?.provider).toBeNull();
  expect(await twilioCallsFor('ACxyz')).toHaveLength(0);
});

test('SMSWA-031 auth token format refused before any request', async ({ page }) => {
  const p = await smsProject('smswa-031', { sender: true });
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  const sid = fakeSid();
  const twilio = card(page, 'Twilio');
  await twilio.getByLabel('Account SID').fill(sid);
  await twilio.getByLabel('Auth token').fill('short-token');
  await twilio.getByRole('button', { name: 'Connect Twilio' }).click();

  const toast = toastTitled(page, 'Could not connect');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(TOKEN_FORMAT);
  expect(await sql(`SELECT 1 FROM push_channel_credentials WHERE project_id = $1`, [p.project.id])).toHaveLength(0);
  expect(await twilioCallsFor(sid)).toHaveLength(0);
});

test('SMSWA-032 connect through the API: validation errors', async () => {
  const p = await smsProject('smswa-032', { sender: true });
  const blank = await createProject(p.owner, p.owner.ip);
  const sid = fakeSid();
  const valid = { accountSid: sid, authToken: hex(16) };
  const connect = (projectId: string, body: Record<string, unknown>) =>
    call('POST', '/api/sms/providers', p.owner, { projectId, provider: 'twilio', ...body });

  const badJson = await connect(p.project.id, { credentials: '{bad json' });
  expect([badJson.status, messageOf(badJson)]).toEqual([400, BAD_JSON]);
  const vonage = await connect(p.project.id, { provider: 'vonage', credentials: JSON.stringify(valid) });
  expect([vonage.status, messageOf(vonage)]).toEqual([400, 'provider must be one of the following values: twilio']);
  const long = await connect(p.project.id, { credentials: 'x'.repeat(10_001) });
  expect([long.status, messageOf(long)]).toEqual([400, 'credentials must be shorter than or equal to 10000 characters']);
  // An object becomes the string "[object Object]" by implicit conversion, so it fails as JSON.
  const object = await connect(p.project.id, { credentials: valid });
  expect([object.status, messageOf(object)]).toEqual([400, BAD_JSON]);

  const noSender = await connect(blank.id, { credentials: valid });
  expect([noSender.status, messageOf(noSender)]).toEqual([400, SENDER_FIRST]);

  const waObject = await call('POST', '/api/whatsapp/providers', p.owner, { projectId: blank.id, provider: 'interakt', credentials: { apiKey: 'k' } });
  expect([waObject.status, messageOf(waObject)]).toEqual([400, BAD_JSON]);

  for (const projectId of [p.project.id, blank.id]) {
    expect(await sql(`SELECT 1 FROM push_channel_credentials WHERE project_id = $1`, [projectId])).toHaveLength(0);
    expect(await activityRows(projectId, 'channel.provider_changed')).toHaveLength(0);
    expect(await activityRows(projectId, 'channel.credentials_uploaded')).toHaveLength(0);
  }
  expect((await smsSettingsRow(p.project.id))?.provider).toBeNull();
  expect(await smsSettingsRow(blank.id)).toBeUndefined();
  expect(await waSettingsRow(blank.id)).toBeUndefined();
  expect(await twilioCallsFor(sid)).toHaveLength(0);
});

test('SMSWA-033 connecting before the sender is saved is refused', async () => {
  const p = await smsProject('smswa-033');
  const sid = fakeSid();
  const refused = await call('POST', '/api/sms/providers', p.owner, {
    projectId: p.project.id,
    provider: 'twilio',
    credentials: JSON.stringify({ accountSid: sid, authToken: hex(16) }),
  });
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toBe(SENDER_FIRST);
  expect(await twilioCallsFor(sid)).toHaveLength(0);
  expect(await smsSettingsRow(p.project.id)).toBeUndefined();
  expect(await sql(`SELECT 1 FROM push_channel_credentials WHERE project_id = $1`, [p.project.id])).toHaveLength(0);
});

test('SMSWA-037 connected state shown from seeded credentials', async ({ page }) => {
  const p = await smsProject('smswa-037', { twilio: true });
  const { accountSid, authToken } = p.sms!.credentials;
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');

  const twilio = card(page, 'Twilio');
  await expect(twilio.getByText(`Account ${accountSid}, auth token ending ${authToken.slice(-4)}.`, { exact: true })).toBeVisible();
  await expect(twilio.getByRole('button', { name: 'Replace credentials' })).toBeVisible();
  await expect(twilio.getByRole('button', { name: 'Connect Twilio' })).toHaveCount(0);
  await expect(card(page, 'Send a test')).toBeVisible();
});

test('SMSWA-038 inbound webhook URL block and copy', async ({ page }) => {
  const p = await smsProject('smswa-038', { sender: true });
  const token = (await smsSettingsRow(p.project.id))!.webhook_token as string;
  expect(token).toMatch(/^[0-9a-f]{48}$/);
  const url = publicApiUrl(`/api/sms/webhooks/twilio/${token}/inbound`);

  await signIn(page, p.owner);
  await allowClipboard(page);
  await openSms(page, p.project.id, 'Settings');
  const block = repliesBlock(page);
  await expect(block.getByText('STOP and START replies', { exact: true })).toBeVisible();
  await expect(block.getByText(/^In Twilio, open your number \(or Messaging Service\) and set A message comes in to this URL, method POST\./)).toBeVisible();
  await expect(block.locator('code')).toHaveText(url);
  await block.getByRole('button').click();
  await expect(toastTitled(page, 'Copied')).toBeVisible();
  expect(await readClipboard(page)).toBe(url);
});

test('SMSWA-042 admin sees and manages the connection like the owner', async ({ page }) => {
  const p = await smsProject('smswa-042', { twilio: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const { accountSid, authToken } = p.sms!.credentials;
  const url = publicApiUrl(`/api/sms/webhooks/twilio/${p.sms!.webhookToken}/inbound`);

  await signIn(page, admin);
  await allowClipboard(page);
  await openSms(page, p.project.id, 'Settings');
  const twilio = card(page, 'Twilio');
  await expect(twilio.getByText(`Account ${accountSid}, auth token ending ${authToken.slice(-4)}.`, { exact: true })).toBeVisible();
  await expect(twilio.getByRole('button', { name: 'Replace credentials' })).toBeVisible();
  await expect(twilio.getByLabel('Account SID')).toBeEditable();
  const block = repliesBlock(page);
  await expect(block.locator('code')).toHaveText(url);
  await block.getByRole('button').click();
  await expect(toastTitled(page, 'Copied')).toBeVisible();
  expect(await readClipboard(page)).toBe(url);
  await expect(page.getByRole('button', { name: 'Save sender' })).toBeVisible();
  await expect(page.getByLabel('From', { exact: true })).toBeEditable();
});

test('SMSWA-044 missing or unreadable stored credentials', async ({ page }) => {
  const p = await smsProject('smswa-044', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  // A positive control: with the credential on, the project can send.
  expect(dataOf(await call('GET', `/api/sms/settings/${p.project.id}`, p.owner)).readyToSend).toBe(true);
  await deactivateCredential(p.project.id, 'twilio');

  const status = dataOf(await call('GET', `/api/sms/settings/${p.project.id}`, p.owner));
  expect(status).toMatchObject({ readyToSend: false, providers: [] });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/sms`);
  await expect(page.getByText(NOT_SET_UP)).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const twilio = card(page, 'Twilio');
  await expect(twilio.getByRole('button', { name: 'Connect Twilio' })).toBeVisible();
  await expect(twilio.getByText(/auth token ending/)).toHaveCount(0);

  const send = await call('POST', '/api/sms/send', p.owner, {
    projectId: p.project.id,
    body: 'Hello',
    scheduledAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  expect([send.status, messageOf(send)]).toEqual([400, UNREADABLE]);
  const testSend = await call('POST', '/api/sms/test-send', p.owner, { projectId: p.project.id, to: '+14155550123', body: 'Test' });
  expect([testSend.status, messageOf(testSend)]).toEqual([400, UNREADABLE]);
  expect(await twilioCallsFor(p.sms!.credentials.accountSid)).toHaveLength(0);
});

// ------------------------------------------------------------ D. Test send ---

test('SMSWA-046 test send to an invalid number', async ({ page }) => {
  const p = await smsProject('smswa-046', { twilio: true });
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('+919876543210').fill('+12');
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/sms/test-send'));
  await testCard.getByRole('button', { name: 'Send test' }).click();
  expect((await answered).status()).toBe(400);
  const line = testCard.getByText(BAD_TEST_NUMBER, { exact: true });
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-destructive/);
  expect(await twilioCallsFor(p.sms!.credentials.accountSid)).toHaveLength(0);
});

// ------------------------------------------------------------ E. Suppressions ---

test('SMSWA-055 invalid number toast', async ({ page }) => {
  const p = await smsProject('smswa-055', { twilio: true });
  const api = await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+123' });
  expect([api.status, messageOf(api)]).toEqual([400, BAD_SUPPRESS_NUMBER]);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Suppressions');
  const input = card(page, 'Suppressed numbers').getByPlaceholder('+14155550123');
  await input.fill('+123');
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  const toast = toastTitled(page, 'That is not a valid number');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveClass(/\bdestructive\b/);
  await expect(toast).toContainText('Use international form with the country code: +14155550123.');
  await expect(input).toHaveValue('+123');
  expect(await suppressionRows(p.project.id)).toHaveLength(0);
});

test('SMSWA-056 adding an already-suppressed number changes nothing', async () => {
  const p = await smsProject('smswa-056', { twilio: true });
  const first = await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+14155550199', reason: 'unsubscribed' });
  expect(first.status).toBe(201);
  expect(await activityRows(p.project.id, 'suppression.added')).toHaveLength(1);

  const again = await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+14155550199', reason: 'manual' });
  expect(again.status).toBe(201);
  expect(dataOf(again)).toEqual({ suppressed: true });
  const rows = await suppressionRows(p.project.id);
  expect(rows.map((row) => [row.address, row.reason])).toEqual([['+14155550199', 'unsubscribed']]);
  expect(await activityRows(p.project.id, 'suppression.added')).toHaveLength(1);
});

test('SMSWA-060 dismissing the confirm keeps the suppression', async ({ page }) => {
  const p = await smsProject('smswa-060', { twilio: true });
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+14155550199' })).status).toBe(201);

  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Suppressions');
  const deletes = recordRequests(page, 'DELETE', /\/api\/sms\/suppressions\//);
  const row = page.getByRole('row').filter({ hasText: '+14155550199' });
  await expect(row).toHaveCount(1);
  let asked = '';
  page.once('dialog', async (dialog) => {
    asked = dialog.message();
    await dialog.dismiss();
  });
  await row.getByRole('button', { name: 'Resubscribe' }).click();
  await expect.poll(() => asked).toBe('Text +14155550199 again? Only do this if they asked to be resubscribed.');
  await expect(row).toHaveCount(1);
  await page.reload();
  await page.getByRole('tab', { name: 'Suppressions', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '+14155550199' })).toHaveCount(1);
  expect(deletes).toHaveLength(0);
  expect(await suppressionRows(p.project.id)).toHaveLength(1);
});

test('SMSWA-066 member can add and lift suppressions', async ({ page }) => {
  const p = await smsProject('smswa-066', { twilio: true });
  const member = await teammate(p.project.id, 'member', p.owner);

  await signIn(page, member);
  await openSms(page, p.project.id, 'Suppressions');
  const input = card(page, 'Suppressed numbers').getByPlaceholder('+14155550123');
  await input.fill('+14155550188');
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: '+14155550188' });
  await expect(row).toHaveCount(1);
  await expect(input).toHaveValue('');
  await expect(row.getByRole('cell').nth(1)).toHaveText('Added by hand');
  expect((await suppressionRows(p.project.id)).map((r) => [r.address, r.reason, r.source])).toEqual([['+14155550188', 'manual', 'dashboard']]);

  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Resubscribe' }).click();
  await expect(page.getByText('Nobody is suppressed.')).toBeVisible();
  expect(await suppressionRows(p.project.id)).toHaveLength(0);
  expect((await smsSuppressionList(member, p.project.id)).total).toBe(0);

  const added = await activityOf(p.project.id, 'suppression.added');
  const removed = await activityOf(p.project.id, 'suppression.removed');
  expect(added.map((row) => [row.actor, row.details?.channel])).toEqual([[member.userId, 'sms']]);
  expect(removed.map((row) => [row.actor, row.details?.channel])).toEqual([[member.userId, 'sms']]);
});


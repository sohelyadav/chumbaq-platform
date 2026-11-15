import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { fakeServiceAccount, seedFcmConfig, seedUnreadableFcmConfig } from '../../support/channels';
import { expect, newPersonContext, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addDevice,
  addMember,
  call,
  campaignRows,
  card,
  credentialRows,
  dataOf,
  deactivateToken,
  fcmSendsFor,
  field,
  formatUtc,
  holdRequests,
  localClock,
  messageOf,
  NOT_CONFIGURED,
  openPush,
  pushConfigRow,
  pushProject,
  refuseTokenExchange,
  reportEvent,
  seedLogRow,
  sql,
  statusValue,
  teammate,
  toastTitled,
  tokenExchangesFor,
  unregisterToken,
  type Person,
} from '../../support/areas/push';

/**
 * Push, P1: the campaign list (columns, status badges, filters, row links, channel
 * scoping, members), the Settings tab (connection status, FCM upload refusals, delivery
 * channels and Mi Push, guardrails, reachability, test send) and quiet hours applied to
 * timezone waves. FCM is seeded; Google's token exchange and FCM are the provider stub.
 * Pages run in UTC so formatted times can be compared.
 */

test.use({ timezoneId: 'UTC' });

const CONFIG_STATUS = (projectId: string) => `/api/push-notifications/config-status/${projectId}`;
const SETTINGS = '/api/push-notifications/settings';
const CHANNEL_CREDENTIALS = '/api/push-notifications/channels/credentials';
const NOT_CONFIGURED_STATUS = 'FCM not configured. Upload your Firebase service account JSON below to enable push notifications.';
const TEST_SEND_HELP =
  'Validate only asks Firebase to check the credentials and message without delivering anything to the device. Deliver actually sends it.';
const MI_PUSH_TOAST = 'Devices that support Mi Push will now receive it instead of FCM — never both.';
const MAX_SENDS_INVALID = 'Enter a whole number of at least 1, or leave it empty for no limit.';
const QUIET_INCOMPLETE = 'Quiet hours need both a start and an end, or neither.';

const endsWith = (suffix: string) => (url: string) => new URL(url).pathname.endsWith(suffix);

function campaignsCard(page: Page) {
  return card(page, 'Campaigns');
}

function filterTab(page: Page, name: string) {
  return campaignsCard(page).getByRole('tab', { name, exact: true });
}

/** Titles of the campaign rows shown, top to bottom. */
async function rowTitles(page: Page): Promise<string[]> {
  return campaignsCard(page).locator('tbody tr td:first-child p.font-medium').allInnerTexts();
}

function uploadTextarea(page: Page, title: 'Upload credentials' | 'Replace credentials' = 'Upload credentials') {
  return field(card(page, title), 'Service account JSON').getByRole('textbox');
}

async function submitUpload(page: Page, json: string, title: 'Upload credentials' | 'Replace credentials' = 'Upload credentials') {
  const upload = card(page, title);
  await uploadTextarea(page, title).fill(json);
  const [answer] = await Promise.all([
    page.waitForResponse((r) => endsWith('/api/push-notifications/configure')(r.url())),
    upload.getByRole('button', { name: title === 'Upload credentials' ? 'Save configuration' : 'Save and replace' }).click(),
  ]);
  return answer;
}

function guardrailInputs(page: Page) {
  const guardrails = card(page, 'Delivery guardrails');
  return {
    guardrails,
    cap: field(guardrails, 'Maximum campaigns per device, per day').getByRole('spinbutton'),
    quietStart: field(guardrails, 'Quiet hours').locator('input[type="time"]').nth(0),
    quietEnd: field(guardrails, 'Quiet hours').locator('input[type="time"]').nth(1),
    maxSends: field(guardrails, 'Maximum sends per minute').getByRole('spinbutton'),
    save: guardrails.getByRole('button', { name: 'Save', exact: true }),
    clear: guardrails.getByRole('button', { name: 'Clear', exact: true }),
  };
}

function testSendCard(page: Page) {
  const testSend = card(page, 'Test send');
  return {
    testSend,
    token: field(testSend, 'Device registration token').getByRole('textbox'),
    validate: testSend.getByRole('button', { name: 'Validate only' }),
    deliver: testSend.getByRole('button', { name: 'Deliver' }),
  };
}

function channelItem(page: Page, label: string) {
  return card(page, 'Delivery channels').locator('li').filter({ has: page.getByText(label, { exact: true }) });
}

// ------------------------------------------------------------ A. Campaign list ---

test('PUSH-001 open the push page from the sidebar', async ({ page }) => {
  const p = await pushProject('push-001', { fcm: true });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}`);
  await openSidebarGroup(page, 'Engagement');
  await sidebarLink(page, 'Push Notifications').click();

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Push Notifications', exact: true })).toBeVisible();
  await expect(page.getByText('Send campaigns to your app users and track how they perform.', { exact: true })).toBeVisible();
  const outerTabs = page.getByRole('tablist').first().getByRole('tab');
  await expect(outerTabs).toHaveText(['Campaigns', 'Templates', 'Settings']);
  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'false');
  const newCampaign = page.getByRole('link', { name: 'New campaign' });
  await expect(newCampaign).toBeVisible();
  await expect(newCampaign).toHaveAttribute('href', `/projects/${p.project.id}/push-notifications/new`);
});

test('PUSH-002 unconfigured project shows the FCM warning and an empty list', async ({ page }) => {
  const p = await pushProject('push-002');

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await expect(page.getByText('FCM is not configured, so nothing can be sent. Set it up under Settings.', { exact: true })).toBeVisible();
  await expect(
    campaignsCard(page).getByText(
      'Accepted is what Firebase took from us; Delivered is what a handset confirmed. They are different numbers.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(campaignsCard(page).getByText('No campaigns yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first campaign' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New campaign' })).toHaveAttribute('disabled', '');
});

test('PUSH-005 configured, no campaigns: first-campaign call to action', async ({ page }) => {
  const p = await pushProject('push-005', { fcm: true });

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await expect(campaignsCard(page).getByText('No campaigns yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('FCM is not configured, so nothing can be sent. Set it up under Settings.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New campaign' })).not.toHaveAttribute('disabled', /.*/);

  await page.getByRole('link', { name: 'Create your first campaign' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/new$`));
  await expect(page.getByRole('heading', { name: 'New push campaign' })).toBeVisible();
});

test('PUSH-007 table columns and row content', async ({ page }) => {
  const p = await pushProject('push-007', { fcm: true });
  const sentAt = new Date('2026-03-04T05:06:00Z');
  const id = await seedLogRow(p.project.id, {
    title: 'Order shipped',
    body: 'Track it in the app',
    status: 'sent',
    target_type: 'project',
    total_tokens: 10,
    success_count: 9,
    failure_count: 1,
    processed_tokens: 10,
    sent_at: sentAt,
  });
  const devices = [];
  for (let i = 0; i < 4; i++) devices.push(await addDevice(p, p.owner.ip));
  for (const device of devices) await reportEvent(p, id, device, 'delivered', p.owner.ip);
  await reportEvent(p, id, devices[0], 'click', p.owner.ip);

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await expect(campaignsCard(page).getByRole('columnheader')).toHaveText(['Title', 'Status', 'Audience', 'Accepted', 'Delivered', 'CTR', 'When']);
  const row = page.getByRole('row', { name: /Order shipped/ });
  await expect(row.getByRole('cell')).toHaveText([
    'Order shippedTrack it in the app',
    'Sent',
    'Everyone',
    '9/10',
    '4',
    '25%',
    formatUtc(sentAt),
  ]);
  await expect(row.getByText('Track it in the app', { exact: true })).toBeVisible();
});

test('PUSH-008 status badge labels for every status', async ({ page }) => {
  const p = await pushProject('push-008', { fcm: true });
  const nextMonth = new Date(Date.now() + 30 * 86_400_000);
  const labels: Record<string, string> = {
    scheduled: 'Scheduled',
    queued: 'Queued',
    sending: 'Sending',
    sent: 'Sent',
    failed: 'Failed',
    partial: 'Partial',
    expanded: 'By timezone',
    cancelled: 'Cancelled',
  };
  for (const status of Object.keys(labels)) {
    await seedLogRow(p.project.id, {
      title: `Row ${status}`,
      status,
      ...(status === 'scheduled' ? { scheduled_at: nextMonth, processed_tokens: 0 } : {}),
    });
  }

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await expect(filterTab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  for (const [status, label] of Object.entries(labels)) {
    const row = page.getByRole('row', { name: new RegExp(`^Row ${status}\\b`) });
    await expect(row.getByRole('cell').nth(1), status).toHaveText(label);
  }
});

test('PUSH-013 status filter tabs', async ({ page }) => {
  const p = await pushProject('push-013', { fcm: true });
  const statuses = ['scheduled', 'queued', 'sending', 'sent', 'failed', 'partial', 'expanded', 'cancelled'];
  for (const status of statuses) {
    await seedLogRow(p.project.id, {
      title: `Row ${status}`,
      status,
      ...(status === 'scheduled' ? { scheduled_at: new Date(Date.now() + 30 * 86_400_000), processed_tokens: 0 } : {}),
    });
  }
  const shown = async () => (await rowTitles(page)).map((t) => t.replace('Row ', '')).sort();

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await expect.poll(shown).toEqual([...statuses].sort());

  await filterTab(page, 'Scheduled').click();
  await expect(filterTab(page, 'Scheduled')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(shown).toEqual(['queued', 'scheduled']);
  await filterTab(page, 'Sent').click();
  await expect.poll(shown).toEqual(['partial', 'sent']);
  await filterTab(page, 'Failed').click();
  await expect.poll(shown).toEqual(['cancelled', 'failed']);
  await filterTab(page, 'All').click();
  await expect.poll(shown).toEqual([...statuses].sort());
  // The outer tab stays on Campaigns throughout.
  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('PUSH-015 row click opens the campaign report', async ({ page }) => {
  const p = await pushProject('push-015', { fcm: true });
  const title = `Report row ${randomBytes(3).toString('hex')}`;
  const id = await seedLogRow(p.project.id, { title, body: 'Body line' });

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await filterTab(page, 'Sent').click();
  await expect(filterTab(page, 'Sent')).toHaveAttribute('aria-selected', 'true');
  // Click the row away from the title text.
  await page.getByRole('row', { name: new RegExp(title) }).getByRole('cell').nth(3).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/${id}$`));
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications$`));
  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(filterTab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeVisible();
});

test('PUSH-017 only push campaigns are listed', async ({ page }) => {
  const p = await pushProject('push-017', { fcm: true });
  await seedLogRow(p.project.id, { title: 'A push campaign' });
  await seedLogRow(p.project.id, { title: 'An email campaign', channel: 'email' });
  await seedLogRow(p.project.id, { title: 'An SMS campaign', channel: 'sms' });

  await signIn(page, p.owner);
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(`/api/push-notifications/logs/${p.project.id}`)),
    openPush(page, p.project.id),
  ]);
  const url = new URL(request.url());
  expect(url.pathname).toBe(`/api/push-notifications/logs/${p.project.id}`);
  expect(url.searchParams.get('channel')).toBe('push');
  await expect.poll(() => rowTitles(page)).toEqual(['A push campaign']);
  await expect(page.getByText('An email campaign')).toHaveCount(0);
  await expect(page.getByText('An SMS campaign')).toHaveCount(0);

  // The API itself still holds all three: the page asked for push only.
  const all = dataOf(await call('GET', `/api/push-notifications/logs/${p.project.id}`, p.owner));
  expect(all.total).toBe(3);
});

test('PUSH-022 member sees the list and can start a campaign', async ({ page }) => {
  const p = await pushProject('push-022', { fcm: true });
  const member = await teammate(p.project.id, 'member', p.owner);
  await seedLogRow(p.project.id, { title: 'Visible to members' });

  await signIn(page, member);
  await openPush(page, p.project.id);
  await expect(page.getByRole('row', { name: /Visible to members/ })).toBeVisible();
  const newCampaign = page.getByRole('link', { name: 'New campaign' });
  await expect(newCampaign).not.toHaveAttribute('disabled', /.*/);
  await newCampaign.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/new$`));
  await expect(page.getByRole('heading', { name: 'New push campaign' })).toBeVisible();
  await expect(page.getByText('FCM is not configured for this project', { exact: false })).toHaveCount(0);
});

// --------------------------------------------- B. Settings: status and FCM upload ---

test('PUSH-026 not configured status', async ({ page }) => {
  const p = await pushProject('push-026');

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  await expect(card(page, 'Connection status').getByText(NOT_CONFIGURED_STATUS, { exact: true })).toBeVisible();
  for (const title of ['Delivery channels', 'Delivery guardrails', 'Reachability']) {
    await expect(card(page, title), title).toHaveCount(0);
  }
  const upload = card(page, 'Upload credentials');
  await expect(upload).toBeVisible();
  await expect(upload.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  await uploadTextarea(page).fill('{}');
  await expect(upload.getByRole('button', { name: 'Save configuration' })).toBeEnabled();
  await expect(card(page, 'Replace credentials')).toHaveCount(0);
  await expect(card(page, 'Test send')).toBeVisible();
});

test('PUSH-027 configured and active status', async ({ page }) => {
  const p = await pushProject('push-027');
  const account = await seedFcmConfig(p.project.id, fakeServiceAccount(`e2e-fcm-${randomBytes(3).toString('hex')}`));
  const config = await pushConfigRow(p.project.id);

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const status = card(page, 'Connection status');
  const headline = status.getByText('FCM is configured and active', { exact: true });
  await expect(headline).toBeVisible();
  await expect(headline.locator('..')).toHaveClass(/text-green-600/);
  await expect(statusValue(page, 'Firebase project')).toHaveText(account.project_id);
  await expect(statusValue(page, 'Service account')).toHaveText(account.client_email);
  await expect(statusValue(page, 'Last updated')).toHaveText(formatUtc(config!.updated_at, true));
  const replace = card(page, 'Replace credentials');
  await expect(replace).toBeVisible();
  await expect(replace.getByRole('button', { name: 'Save and replace' })).toBeVisible();
  await expect(card(page, 'Upload credentials')).toHaveCount(0);
});

test('PUSH-028 unreadable stored credentials', async ({ page }) => {
  const first = await pushProject('push-028');
  const projects = {
    'bad-ciphertext': first,
    'not-json': await pushProject('push-028-n', { owner: first.owner }),
  };

  await signIn(page, first.owner);
  for (const [kind, p] of Object.entries(projects) as Array<['bad-ciphertext' | 'not-json', typeof first]>) {
    await seedUnreadableFcmConfig(p.project.id, kind);
    await openPush(page, p.project.id, 'Settings');
    const status = card(page, 'Connection status');
    await expect(status.getByText('Stored credentials could not be decrypted', { exact: true }), kind).toBeVisible();
    await expect(
      status.getByText(
        'A service account is on file, but it can no longer be read back — this is not the same as nothing being configured. Re-upload the service account JSON below to fix it.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(status.getByText(NOT_CONFIGURED_STATUS)).toHaveCount(0);
    await expect(status.getByText('FCM is configured and active')).toHaveCount(0);

    const body = dataOf(await call('GET', CONFIG_STATUS(p.project.id), p.owner));
    expect(body, kind).toMatchObject({ configured: true, isActive: true, firebaseProjectId: null, clientEmail: null });
  }
});

test('PUSH-032 admin sees the service account and every settings control', async ({ page }) => {
  const p = await pushProject('push-032', { fcm: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);

  await signIn(page, admin);
  await openPush(page, p.project.id, 'Settings');
  await expect(card(page, 'Connection status').getByText('FCM is configured and active', { exact: true })).toBeVisible();
  await expect(statusValue(page, 'Firebase project')).toHaveText(p.fcm!.project_id);
  await expect(statusValue(page, 'Service account')).toHaveText(p.fcm!.client_email);

  const channels = card(page, 'Delivery channels');
  await expect(channels.getByText('Mi Push credentials', { exact: true })).toBeVisible();
  await expect(channels.getByRole('button', { name: 'Save Mi Push credentials' })).toBeVisible();

  const g = guardrailInputs(page);
  await expect(g.guardrails.locator('fieldset')).not.toHaveAttribute('disabled', /.*/);
  for (const input of [g.cap, g.quietStart, g.quietEnd, g.maxSends]) await expect(input).toBeEnabled();
  await expect(g.save).toBeEnabled();

  const replace = card(page, 'Replace credentials');
  await expect(replace.getByRole('button', { name: 'Save and replace' })).toBeVisible();
  await expect(card(page, 'Reachability')).toBeVisible();
  await expect(card(page, 'Test send')).toBeVisible();

  const asAdmin = dataOf(await call('GET', CONFIG_STATUS(p.project.id), admin));
  expect(asAdmin.clientEmail).toBe(p.fcm!.client_email);
});

test('PUSH-035 upload refuses text that is not JSON', async ({ page }) => {
  const p = await pushProject('push-035');

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const upload = card(page, 'Upload credentials');
  await uploadTextarea(page).fill('not json');
  const hold = await holdRequests(page, endsWith('/api/push-notifications/configure'));
  const answered = page.waitForResponse((r) => endsWith('/api/push-notifications/configure')(r.url()));
  await upload.getByRole('button', { name: 'Save configuration' }).click();
  await expect(upload.getByRole('button', { name: 'Validating…' })).toBeDisabled();
  hold.release();
  expect((await answered).status()).toBe(400);
  await expect(upload.getByText('Invalid JSON for FCM service account', { exact: true })).toBeVisible();
  await expect(upload.getByRole('button', { name: 'Save configuration' })).toBeEnabled();

  expect(dataOf(await call('GET', CONFIG_STATUS(p.project.id), p.owner)).configured).toBe(false);
  expect(await pushConfigRow(p.project.id)).toBeUndefined();
  expect(await credentialRows(p.project.id)).toHaveLength(0);
});

test('PUSH-036 upload refuses JSON missing required fields', async ({ page }) => {
  const p = await pushProject('push-036');

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const answer = await submitUpload(page, '{"project_id":"x"}');
  expect(answer.status()).toBe(400);
  await expect(
    card(page, 'Upload credentials').getByText('FCM service account must include project_id, private_key, and client_email', { exact: true }),
  ).toBeVisible();
  expect(await pushConfigRow(p.project.id)).toBeUndefined();
  expect(await credentialRows(p.project.id)).toHaveLength(0);
});

test('PUSH-038 upload refuses a client_email that is not an address', async ({ page }) => {
  const p = await pushProject('push-038');
  const forged = `not an email\nforged ${randomBytes(3).toString('hex')}`;

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const answer = await submitUpload(page, JSON.stringify({ ...fakeServiceAccount(), client_email: forged }));
  expect(answer.status()).toBe(400);
  await expect(
    card(page, 'Upload credentials').getByText("The service account's client_email is not an email address.", { exact: true }),
  ).toBeVisible();
  expect(await pushConfigRow(p.project.id)).toBeUndefined();
  expect(await tokenExchangesFor(forged)).toHaveLength(0);
});

test('PUSH-039 upload with an unreadable private key', async ({ page }) => {
  const p = await pushProject('push-039');
  const email = `a-${randomBytes(4).toString('hex')}@x.iam.gserviceaccount.com`;

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const answer = await submitUpload(page, JSON.stringify({ project_id: 'x', client_email: email, private_key: 'garbage' }));
  expect(answer.status()).toBe(400);
  const message = String((await answer.json()).message);
  expect(message).toMatch(/^Firebase rejected this service account: \S/);
  const upload = card(page, 'Upload credentials');
  await expect(upload.getByText(message, { exact: true })).toBeVisible();
  expect(await pushConfigRow(p.project.id)).toBeUndefined();
  expect(await credentialRows(p.project.id)).toHaveLength(0);
  // Refused while signing, before anything was sent anywhere.
  expect(await tokenExchangesFor(email)).toHaveLength(0);

  await uploadTextarea(page).press('End');
  await uploadTextarea(page).pressSequentially(' ');
  await expect(upload.getByText(message, { exact: true })).toHaveCount(0);
});

// ------------------------------------------------- C. Delivery channels, Mi Push ---

test('PUSH-045 delivery channels card lists supported providers', async ({ page }) => {
  const p = await pushProject('push-045', { fcm: true });

  const channels = dataOf(await call('GET', `/api/push-notifications/channels/${p.project.id}`, p.owner));
  expect(channels).toEqual({ configured: ['fcm'], supported: ['fcm', 'apns', 'mi_push'] });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const items = card(page, 'Delivery channels').locator('li');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText(/^Firebase Cloud Messaging \(FCM\)\s*Configured$/);
  await expect(items.nth(1)).toHaveText(/^Apple Push \(APNs\)\s*Not configured$/);
  await expect(items.nth(2)).toHaveText(/^Mi Push \(Xiaomi\/MIUI\)\s*Not configured$/);
  for (const absent of ['Huawei Push Kit', 'OPPO Push', 'Vivo Push', 'Honor Push']) {
    await expect(card(page, 'Delivery channels').getByText(absent)).toHaveCount(0);
  }
});

test('PUSH-050 save Mi Push credentials', async ({ page }) => {
  const p = await pushProject('push-050', { fcm: true });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const channels = card(page, 'Delivery channels');
  const secret = channels.locator('input[type="password"]');
  const packageName = field(channels, 'Package name').getByRole('textbox');
  const region = field(channels, 'Region').getByRole('combobox');
  await expect(secret).toHaveAttribute('placeholder', 'From the Xiaomi developer console');
  await secret.fill('s3cret');
  await packageName.fill('com.e2e.app');
  await region.click();
  await page.getByRole('option', { name: 'India', exact: true }).click();
  await expect(region).toHaveText('India');

  const hold = await holdRequests(page, endsWith(CHANNEL_CREDENTIALS));
  const requested = page.waitForRequest((r) => endsWith(CHANNEL_CREDENTIALS)(r.url()));
  const answered = page.waitForResponse((r) => endsWith(CHANNEL_CREDENTIALS)(r.url()));
  await channels.getByRole('button', { name: 'Save Mi Push credentials' }).click();
  await expect(channels.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  hold.release();
  const body = (await requested).postDataJSON();
  expect(body).toEqual({
    projectId: p.project.id,
    provider: 'mi_push',
    credentials: '{"appSecret":"s3cret","packageName":"com.e2e.app","region":"india"}',
  });
  const answer = await answered;
  expect(answer.status()).toBe(201);
  expect((await answer.json()).data).toEqual({ provider: 'mi_push', configured: true });

  await expect(toastTitled(page, 'Mi Push configured')).toContainText(MI_PUSH_TOAST);
  await expect(secret).toHaveValue('');
  await expect(packageName).toHaveValue('');
  await expect(region).toHaveText('Global');
  await expect(channelItem(page, 'Mi Push (Xiaomi/MIUI)').getByText('Configured', { exact: true })).toBeVisible();
  await expect(channels.getByRole('button', { name: 'Replace Mi Push credentials' })).toBeVisible();
  await expect(secret).toHaveAttribute('placeholder', '••••••••••••');

  expect((await credentialRows(p.project.id)).map((r) => r.provider)).toEqual(['fcm', 'mi_push']);
  const logged = await activityRows(p.project.id, 'channel.credentials_uploaded');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ target_type: 'channel_provider', target_id: 'mi_push', target_label: 'Mi Push' });
  expect(logged[0].details).toEqual({ channel: 'push', fields: ['credentials'] });
  expect(JSON.stringify(logged[0])).not.toContain('s3cret');
});

test('PUSH-053 channel credentials API: unsupported or unknown provider', async () => {
  const p = await pushProject('push-053', { fcm: true });
  const credentials = JSON.stringify({ appSecret: 's3cret', packageName: 'com.e2e.app', region: 'india' });

  const huawei = await call('POST', CHANNEL_CREDENTIALS, p.owner, { projectId: p.project.id, provider: 'huawei', credentials });
  expect([huawei.status, messageOf(huawei)]).toEqual([
    400,
    'This deployment cannot deliver on the "huawei" channel. Supported: fcm, apns, mi_push.',
  ]);
  const pigeon = await call('POST', CHANNEL_CREDENTIALS, p.owner, { projectId: p.project.id, provider: 'pigeon', credentials });
  expect([pigeon.status, messageOf(pigeon)]).toEqual([
    400,
    'provider must be one of the following values: fcm, apns, mi_push, huawei, oppo, vivo, honor',
  ]);
  expect((await credentialRows(p.project.id)).map((r) => r.provider)).toEqual(['fcm']);

  // The same body for a supported provider is stored.
  const miPush = await call('POST', CHANNEL_CREDENTIALS, p.owner, { projectId: p.project.id, provider: 'mi_push', credentials });
  expect(miPush.status).toBe(201);
  expect((await credentialRows(p.project.id)).map((r) => r.provider)).toEqual(['fcm', 'mi_push']);
});

// --------------------------------------------------------- D. Delivery guardrails ---

test('PUSH-059 guardrails card shows stored values', async ({ page }) => {
  const p = await pushProject('push-059', { fcm: true });
  const saved = await call('POST', SETTINGS, p.owner, {
    projectId: p.project.id,
    frequencyCapPerDay: 3,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    maxSendsPerMinute: 600,
  });
  expect(saved.status).toBe(201);

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  let g = guardrailInputs(page);
  await expect(g.cap).toHaveValue('3');
  await expect(g.quietStart).toHaveValue('22:00');
  await expect(g.quietEnd).toHaveValue('07:00');
  await expect(g.maxSends).toHaveValue('600');
  await expect(g.clear).toBeVisible();

  // Nothing stored: empty fields with the "No limit" placeholder, and no Clear.
  expect((await call('POST', SETTINGS, p.owner, { projectId: p.project.id })).status).toBe(201);
  await page.reload();
  await openPush(page, p.project.id, 'Settings');
  g = guardrailInputs(page);
  await expect(card(page, 'Connection status').getByText('FCM is configured and active')).toBeVisible();
  await expect(g.cap).toHaveValue('');
  await expect(g.maxSends).toHaveValue('');
  await expect(g.cap).toHaveAttribute('placeholder', 'No limit');
  await expect(g.maxSends).toHaveAttribute('placeholder', 'No limit');
  await expect(g.quietStart).toHaveValue('');
  await expect(g.quietEnd).toHaveValue('');
  await expect(g.clear).toHaveCount(0);
});

test('PUSH-060 save guardrails', async ({ page }) => {
  const p = await pushProject('push-060', { fcm: true });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const g = guardrailInputs(page);
  await g.cap.fill('2');
  await g.quietStart.fill('22:00');
  await g.quietEnd.fill('07:00');
  await g.maxSends.fill('100');

  const hold = await holdRequests(page, endsWith(SETTINGS));
  const requested = page.waitForRequest((r) => endsWith(SETTINGS)(r.url()));
  const answered = page.waitForResponse((r) => endsWith(SETTINGS)(r.url()));
  await g.save.click();
  await expect(g.guardrails.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  hold.release();
  const policy = { frequencyCapPerDay: 2, quietHoursStart: '22:00', quietHoursEnd: '07:00', maxSendsPerMinute: 100 };
  expect((await requested).postDataJSON()).toEqual({ projectId: p.project.id, ...policy });
  expect((await answered).status()).toBe(201);
  await expect(toastTitled(page, 'Guardrails saved')).toContainText('Delivery limits for this project have been updated.');
  await expect(g.save).toHaveText('Save');

  expect(dataOf(await call('GET', CONFIG_STATUS(p.project.id), p.owner))).toMatchObject(policy);
  const logged = await activityRows(p.project.id, 'channel.settings_changed');
  expect(logged).toHaveLength(1);
  expect(logged[0].details.channel).toBe('push');
  expect([...logged[0].details.fields].sort()).toEqual(['frequencyCapPerDay', 'maxSendsPerMinute', 'quietHoursEnd', 'quietHoursStart']);
});

test('PUSH-062 only one end of quiet hours', async ({ page }) => {
  const p = await pushProject('push-062', { fcm: true });
  const requests: string[] = [];
  page.on('request', (r) => {
    if (endsWith(SETTINGS)(r.url())) requests.push(r.url());
  });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const g = guardrailInputs(page);
  await expect(g.guardrails.getByText(QUIET_INCOMPLETE)).toHaveCount(0);
  await g.quietStart.fill('22:00');
  await expect(g.guardrails.getByText(QUIET_INCOMPLETE, { exact: true })).toBeVisible();
  await expect(g.save).toBeDisabled();

  // Both ends: valid again.
  await g.quietEnd.fill('07:00');
  await expect(g.guardrails.getByText(QUIET_INCOMPLETE)).toHaveCount(0);
  await expect(g.save).toBeEnabled();
  // Only the end: refused the same way.
  await g.quietStart.fill('');
  await expect(g.guardrails.getByText(QUIET_INCOMPLETE, { exact: true })).toBeVisible();
  await expect(g.save).toBeDisabled();
  expect(requests).toEqual([]);
});

test('PUSH-064 invalid maximum sends per minute', async ({ page }) => {
  const p = await pushProject('push-064', { fcm: true });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const g = guardrailInputs(page);
  for (const value of ['0', '1.5', '-3']) {
    await g.maxSends.fill(value);
    await expect(g.guardrails.getByText(MAX_SENDS_INVALID, { exact: true }), value).toBeVisible();
    await expect(g.save, value).toBeDisabled();
  }
  await g.maxSends.fill('5');
  await expect(g.guardrails.getByText(MAX_SENDS_INVALID)).toHaveCount(0);
  await expect(g.save).toBeEnabled();
  await g.maxSends.fill('');
  await expect(g.guardrails.getByText(MAX_SENDS_INVALID)).toHaveCount(0);
  await expect(g.save).toBeEnabled();
});

test('PUSH-067 saving replaces the whole policy', async () => {
  const p = await pushProject('push-067', { fcm: true });
  const first = await call('POST', SETTINGS, p.owner, {
    projectId: p.project.id,
    frequencyCapPerDay: 3,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    maxSendsPerMinute: 600,
  });
  expect(first.status).toBe(201);
  expect(dataOf(await call('GET', CONFIG_STATUS(p.project.id), p.owner))).toMatchObject({ frequencyCapPerDay: 3, quietHoursStart: '22:00' });

  const partial = await call('POST', SETTINGS, p.owner, { projectId: p.project.id, frequencyCapPerDay: 5 });
  expect(partial.status).toBe(201);
  const cleared = { frequencyCapPerDay: 5, quietHoursStart: null, quietHoursEnd: null, maxSendsPerMinute: null };
  expect(dataOf(partial)).toEqual(cleared);
  expect(dataOf(await call('GET', CONFIG_STATUS(p.project.id), p.owner))).toMatchObject(cleared);
  const row = await pushConfigRow(p.project.id);
  expect(row).toMatchObject({ frequency_cap_per_day: 5, quiet_hours_start: null, quiet_hours_end: null, max_sends_per_minute: null });
});

test('PUSH-073 quiet hours move timezone waves', async () => {
  test.setTimeout(240_000);
  const quiet = await pushProject('push-073', { fcm: true });
  const plain = await pushProject('push-073-c', { fcm: true, owner: quiet.owner });
  expect(
    (await call('POST', SETTINGS, quiet.owner, { projectId: quiet.project.id, quietHoursStart: '08:00', quietHoursEnd: '10:00' })).status,
  ).toBe(201);
  // The control project has no quiet hours: the same waves stay at 09:00.
  for (const p of [quiet, plain]) {
    await addDevice(p, quiet.owner.ip, { timezone: 'Asia/Kolkata' });
    await addDevice(p, quiet.owner.ip, { timezone: 'Europe/London' });
  }

  const parents: Record<string, string> = {};
  for (const p of [quiet, plain]) {
    const sent = await call('POST', '/api/push-notifications/send', quiet.owner, {
      projectId: p.project.id,
      title: 'Morning wave',
      deliverInRecipientTimezone: true,
      localSendTime: '09:00',
    });
    expect(sent.status).toBe(201);
    expect(dataOf(sent).status).toBe('scheduled');
    parents[p.project.id] = dataOf(sent).id;
  }

  const waves = async (projectId: string) => {
    const logs = dataOf<{ data: Array<Record<string, any>> }>(await call('GET', `/api/push-notifications/logs/${projectId}`, quiet.owner));
    return logs.data.filter((row) => row.parentCampaignId === parents[projectId]);
  };
  const parentStatus = async (projectId: string) =>
    dataOf<{ data: Array<Record<string, any>> }>(await call('GET', `/api/push-notifications/logs/${projectId}`, quiet.owner)).data.find(
      (row) => row.id === parents[projectId],
    )?.status;
  for (const p of [quiet, plain]) {
    await expect.poll(() => parentStatus(p.project.id), { timeout: 150_000, intervals: [2_000] }).toBe('expanded');
    await expect.poll(async () => (await waves(p.project.id)).length, { timeout: 30_000 }).toBe(2);
  }

  const zoneOf = async (row: Record<string, any>) => {
    const [identity] = await campaignDeviceZone(row.targetDeviceIds[0]);
    return identity;
  };
  for (const [p, expected] of [
    [quiet, '10:00'],
    [plain, '09:00'],
  ] as const) {
    for (const wave of await waves(p.project.id)) {
      const zone = await zoneOf(wave);
      expect(['Asia/Kolkata', 'Europe/London']).toContain(zone);
      expect(wave.status).toBe('scheduled');
      expect(localClock(wave.scheduledAt, zone), `${p === quiet ? 'quiet' : 'control'} ${zone}`).toBe(expected);
      expect(new Date(wave.scheduledAt).getTime()).toBeGreaterThan(Date.now());
    }
  }

  // An ordinary scheduled send is not moved: quiet hours apply to timezone waves only.
  const tomorrowNine = new Date(Date.now() + 86_400_000);
  tomorrowNine.setUTCHours(3, 30, 0, 0); // 09:00 in Kolkata
  const ordinary = await call('POST', '/api/push-notifications/send', quiet.owner, {
    projectId: quiet.project.id,
    title: 'Ordinary send',
    scheduledAt: tomorrowNine.toISOString(),
  });
  expect(ordinary.status).toBe(201);
  expect(dataOf(ordinary).status).toBe('scheduled');
  expect(new Date(dataOf(ordinary).scheduledAt).toISOString()).toBe(tomorrowNine.toISOString());
  expect(localClock(dataOf(ordinary).scheduledAt, 'Asia/Kolkata')).toBe('09:00');
  expect((await campaignRows(quiet.project.id)).filter((row) => row.parent_campaign_id === dataOf(ordinary).id)).toHaveLength(0);
});

/** The reported timezone of a device identity. */
async function campaignDeviceZone(deviceIdentityId: string): Promise<string[]> {
  const rows = await sql<{ timezone: string }>(`SELECT timezone FROM device_identities WHERE id = $1`, [deviceIdentityId]);
  return rows.map((r) => r.timezone);
}

// ---------------------------------------------------------- E. Reachability ---

test('PUSH-075 reachability figures and window buttons', async ({ page }) => {
  const p = await pushProject('push-075', { fcm: true });
  const ip = p.owner.ip;
  // Five live tokens on five devices; the first also holds a rejected older token.
  const rotated = await addDevice(p, ip, { tokens: 2 });
  for (let i = 0; i < 4; i++) await addDevice(p, ip);
  await deactivateToken(rotated.tokens[1], 'provider_rejected', 2);
  // A device whose only token was rejected: a likely uninstall.
  const lost = await addDevice(p, ip);
  await deactivateToken(lost.tokens[0], 'provider_rejected', 3);
  // A logout through the SDK, yesterday; and an older one, outside 7 and 30 days.
  const loggedOut = await addDevice(p, ip);
  await unregisterToken(p, ip, loggedOut.tokens[0]);
  await deactivateToken(loggedOut.tokens[0], 'app_requested', 1);
  const oldLogout = await addDevice(p, ip);
  await unregisterToken(p, ip, oldLogout.tokens[0]);
  await deactivateToken(oldLogout.tokens[0], 'app_requested', 45);

  await signIn(page, p.owner);
  const firstLoad = page.waitForRequest((r) => r.url().includes(`/api/push-notifications/reachability/${p.project.id}`));
  await openPush(page, p.project.id, 'Settings');
  expect(new URL((await firstLoad).url()).searchParams.get('days')).toBe('30');
  const reach = card(page, 'Reachability');
  const headline = reach.locator('p.text-3xl');
  const expectFigures = async (days: number, uninstalls: number, active: number, rejected: number, logouts: number) => {
    await expect(reach.getByText(`in the last ${days} days`, { exact: true })).toBeVisible();
    await expect(headline).toHaveText(String(uninstalls));
    await expect(statusValue(page, 'Active tokens')).toHaveText(String(active));
    await expect(statusValue(page, 'Provider-rejected')).toHaveText(String(rejected));
    await expect(statusValue(page, 'Logouts / opt-outs')).toHaveText(String(logouts));
    for (const d of [7, 30, 90]) {
      const button = reach.getByRole('button', { name: `${d}d`, exact: true });
      if (d === days) await expect(button).toHaveClass(/bg-primary/);
      else await expect(button).not.toHaveClass(/bg-primary/);
    }
  };
  await expect(reach.getByText('Likely uninstalls', { exact: true })).toBeVisible();
  await expectFigures(30, 1, 5, 2, 1);

  for (const [days, logouts] of [
    [7, 1],
    [90, 2],
  ] as const) {
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/push-notifications/reachability/${p.project.id}?days=${days}`)),
      reach.getByRole('button', { name: `${days}d`, exact: true }).click(),
    ]);
    expect(new URL(request.url()).searchParams.get('days')).toBe(String(days));
    await expectFigures(days, 1, 5, 2, logouts);
  }
  // Back to the default window (already fetched, so answered from the page's cache).
  await reach.getByRole('button', { name: '30d', exact: true }).click();
  await expectFigures(30, 1, 5, 2, 1);
});

// ---------------------------------------------------------------- F. Test send ---

test('PUSH-080 test send card for every role', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const configured = await pushProject('push-080', { fcm: true });
  const unconfigured = await pushProject('push-080-u', { owner: configured.owner });
  const admin = await teammate(configured.project.id, 'admin', configured.owner);
  const member = await teammate(configured.project.id, 'member', configured.owner);
  await addMember(unconfigured.project.id, admin, 'admin', configured.owner);
  await addMember(unconfigured.project.id, member, 'member', configured.owner);

  const people: Array<[string, Person]> = [
    ['owner', configured.owner],
    ['admin', admin],
    ['member', member],
  ];
  for (const [role, person] of people) {
    const { context } = await newPersonContext(browser, baseURL);
    const page = await context.newPage();
    try {
      await signIn(page, person);
      for (const project of [configured.project, unconfigured.project]) {
        const label = `${role} on ${project === configured.project ? 'configured' : 'unconfigured'}`;
        await openPush(page, project.id, 'Settings');
        const t = testSendCard(page);
        await expect(t.testSend, label).toBeVisible();
        await expect(t.token, label).toBeVisible();
        await expect(t.testSend.getByText(TEST_SEND_HELP, { exact: true }), label).toBeVisible();
        await expect(t.validate, label).toBeDisabled();
        await expect(t.deliver, label).toBeDisabled();
        await t.token.fill('   ');
        await expect(t.deliver, label).toBeDisabled();
        await t.token.fill('some-token');
        await expect(t.validate, label).toBeEnabled();
        await expect(t.deliver, label).toBeEnabled();
      }
    } finally {
      await context.close();
    }
  }
});

test('PUSH-081 test send before configure', async ({ page }) => {
  const p = await pushProject('push-081');

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const t = testSendCard(page);
  await t.token.fill('abc');
  const [answer] = await Promise.all([
    page.waitForResponse((r) => endsWith('/api/push-notifications/test-send')(r.url())),
    t.deliver.click(),
  ]);
  expect(answer.status()).toBe(404);
  expect((await answer.json()).message).toBe(NOT_CONFIGURED);
  await expect(t.testSend.getByText(NOT_CONFIGURED, { exact: true })).toBeVisible();
  await expect(t.testSend.getByText('Rejected by Firebase')).toHaveCount(0);
});

test('PUSH-084 provider failure is reported, not thrown', async ({ page }) => {
  const p = await pushProject('push-084', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  await refuseTokenExchange(p.fcm!);

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const t = testSendCard(page);
  await t.token.fill(device.tokens[0]);
  const [answer] = await Promise.all([
    page.waitForResponse((r) => endsWith('/api/push-notifications/test-send')(r.url())),
    t.validate.click(),
  ]);
  expect(answer.status()).toBe(201);
  const result = (await answer.json()).data;
  expect(result).toEqual({ delivered: false, dryRun: true, error: 'Token exchange failed (HTTP 400, invalid_grant)' });
  await expect(t.testSend.getByText('Rejected by Firebase', { exact: true })).toBeVisible();
  await expect(t.testSend.getByText(result.error, { exact: true })).toBeVisible();
  await expect(t.testSend.locator('code')).toHaveCount(0);
  await expect(toastTitled(page, 'Rejected by Firebase')).toContainText(result.error);
  // The exchange was tried (and refused); nothing reached FCM's send endpoint.
  expect(await tokenExchangesFor(p.fcm!.client_email)).toHaveLength(1);
  expect(await fcmSendsFor(p.fcm!.project_id)).toHaveLength(0);
});

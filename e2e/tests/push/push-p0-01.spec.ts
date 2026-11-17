import { randomBytes } from 'crypto';
import { fakeServiceAccount } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addDevice,
  call,
  campaignRecipients,
  campaignRow,
  campaignRows,
  card,
  createSegment,
  credentialRows,
  dataOf,
  fcmSendsFor,
  field,
  HIDDEN,
  HIDDEN_FROM_ROLE,
  messageOf,
  MISSED_DURING_SUSPENSION,
  NO_REACHABLE_TOKENS,
  NOT_CONFIGURED,
  openPush,
  openViewAs,
  PROJECT_NOT_FOUND,
  pushConfigRow,
  pushProject,
  randomId,
  reachFigure,
  reactivateAccount,
  READ_ONLY,
  ROLE_REFUSAL,
  seedSentCampaign,
  seedSentEvent,
  signedInStaff,
  sql,
  statusValue,
  STOPPED_BY_SUSPENSION,
  suspendAccount,
  teammate,
  TEST_SEND_SUSPENDED,
  toastTitled,
  TOKEN_URI_REFUSED,
  tokenExchangesFor,
  unregisterToken,
  viewAsCaller,
  viewAsLink,
} from '../../support/areas/push';

/**
 * Push: the campaign list, the Settings tab (connection status, FCM upload, delivery
 * channels, guardrails, test send) and the composer's reach, review and send, by role
 * and in view-as. FCM is seeded (the real upload is checked against Google, which here
 * is the provider stub); devices arrive through the SDK's identify and token routes.
 */

const LOGS = (projectId: string) => `/api/push-notifications/logs/${projectId}`;
const CONFIG_STATUS = (projectId: string) => `/api/push-notifications/config-status/${projectId}`;
const MI_PUSH = (projectId: string, secret = `s3cret-${randomBytes(6).toString('hex')}`) => ({
  projectId,
  provider: 'mi_push',
  credentials: JSON.stringify({ appSecret: secret, packageName: 'com.example.e2e', region: 'india' }),
});

// ------------------------------------------------------------ A. Campaign list ---

test('PUSH-020 campaign copy is shown as text, never as HTML', async ({ page }) => {
  const p = await pushProject('push-020', { fcm: true });
  await addDevice(p, p.owner.ip);
  const title = '<img src=x onerror=alert(1)>';
  const body = '<b>bold</b>';
  const sent = dataOf(await call('POST', '/api/push-notifications/send', p.owner, { projectId: p.project.id, title, body }));

  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row.getByText(title, { exact: true })).toBeVisible();
  await expect(row.getByText(body, { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('main b', { hasText: 'bold' })).toHaveCount(0);

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/push-notifications/${sent.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('main b', { hasText: 'bold' })).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('PUSH-025 logs API: another tenant’s project', async () => {
  const p = await pushProject('push-025', { fcm: true });
  const marker = `PUSH-025 campaign ${randomBytes(4).toString('hex')}`;
  await seedSentCampaign(p.project.id, marker);
  const outsider = await pushProject('push-025-o');

  const own = await call('GET', LOGS(p.project.id), p.owner);
  expect(own.status).toBe(200);
  expect(own.text).toContain(marker);

  for (const projectId of [p.project.id, 'abc']) {
    const refused = await call('GET', LOGS(projectId), outsider.owner);
    expect(refused.status).toBe(404);
    expect(messageOf(refused)).toBe(PROJECT_NOT_FOUND);
    expect(refused.body.data).toBeUndefined();
    expect(refused.text).not.toContain(marker);
  }
});

// --------------------------------------------- B. Settings: status and FCM upload ---

test('PUSH-030 service account email hidden from members', async ({ page }) => {
  const p = await pushProject('push-030', { fcm: true });
  const member = await teammate(p.project.id, 'member', p.owner);

  await signIn(page, member);
  await openPush(page, p.project.id, 'Settings');
  await expect(page.getByText('FCM is configured and active', { exact: true })).toBeVisible();
  await expect(statusValue(page, 'Firebase project')).toHaveText(p.fcm!.project_id);
  await expect(statusValue(page, 'Service account')).toHaveText(HIDDEN_FROM_ROLE);
  await expect(page.getByText(p.fcm!.client_email)).toHaveCount(0);

  const asMember = dataOf(await call('GET', CONFIG_STATUS(p.project.id), member));
  expect(asMember).toMatchObject({ configured: true, isActive: true, firebaseProjectId: p.fcm!.project_id, clientEmail: HIDDEN });
  const asOwner = dataOf(await call('GET', CONFIG_STATUS(p.project.id), p.owner));
  expect(asOwner.clientEmail).toBe(p.fcm!.client_email);
});

test('PUSH-031 service account email hidden in view-as', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-031', { fcm: true });
  const staff = await signedInStaff(browser, baseURL);

  await openViewAs(page, await viewAsLink(staff, p.owner));
  await openPush(page, p.project.id, 'Settings');
  await expect(statusValue(page, 'Firebase project')).toHaveText(p.fcm!.project_id);
  await expect(statusValue(page, 'Service account')).toHaveText(HIDDEN);
  await expect(page.getByText(p.fcm!.client_email)).toHaveCount(0);

  const viewAs = await viewAsCaller(staff, p.owner);
  const status = await call('GET', CONFIG_STATUS(p.project.id), viewAs);
  expect(dataOf(status)).toMatchObject({ firebaseProjectId: p.fcm!.project_id, clientEmail: HIDDEN });
  expect(status.text).not.toContain(p.fcm!.client_email);
});

test('PUSH-033 member sees no credential forms and read-only guardrails', async ({ page }) => {
  const p = await pushProject('push-033', { fcm: true });
  const member = await teammate(p.project.id, 'member', p.owner);

  await signIn(page, member);
  await openPush(page, p.project.id, 'Settings');
  await expect(card(page, 'Connection status')).toBeVisible();
  await expect(card(page, 'Replace credentials')).toHaveCount(0);
  await expect(card(page, 'Upload credentials')).toHaveCount(0);
  await expect(page.getByText('Service account JSON', { exact: true })).toHaveCount(0);

  const channels = card(page, 'Delivery channels');
  await expect(channels.getByText('Firebase Cloud Messaging (FCM)', { exact: true })).toBeVisible();
  await expect(channels.getByText('Mi Push credentials', { exact: true })).toHaveCount(0);
  await expect(channels.getByRole('button')).toHaveCount(0);

  const guardrails = card(page, 'Delivery guardrails');
  await expect(guardrails.locator('fieldset')).toHaveAttribute('disabled', '');
  const inputs = guardrails.locator('input');
  await expect(inputs).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expect(inputs.nth(i)).toBeDisabled();
  await expect(guardrails.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);

  await expect(card(page, 'Reachability')).toBeVisible();
  await expect(card(page, 'Test send')).toBeVisible();
  await expect(card(page, 'Test send').getByRole('button', { name: 'Deliver' })).toBeVisible();
});

test('PUSH-037 upload refuses a token_uri that is not Google’s', async ({ page }) => {
  const p = await pushProject('push-037');
  const account = fakeServiceAccount();

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const upload = card(page, 'Upload credentials');
  await field(upload, 'Service account JSON').getByRole('textbox').fill(JSON.stringify({ ...account, token_uri: 'https://internal.example/token' }));
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/push-notifications/configure')),
    upload.getByRole('button', { name: 'Save configuration' }).click(),
  ]);
  expect(answer.status()).toBe(400);
  await expect(upload.getByText(TOKEN_URI_REFUSED, { exact: true })).toBeVisible();
  expect(await pushConfigRow(p.project.id)).toBeUndefined();
  expect(await credentialRows(p.project.id)).toHaveLength(0);
  // Refused before any token exchange: nothing went anywhere with this key.
  expect(await tokenExchangesFor(account.client_email)).toHaveLength(0);

  // Google's own endpoints pass this check; the exchange then goes to Google's fixed
  // token host (the stub here), never to the value in the file.
  const accepted = [
    'https://oauth2.googleapis.com/token',
    'https://www.googleapis.com/oauth2/v4/token',
    'https://accounts.google.com/o/oauth2/token',
  ];
  for (const tokenUri of accepted) {
    const configured = await call('POST', '/api/push-notifications/configure', p.owner, {
      projectId: p.project.id,
      fcmServiceAccountJson: JSON.stringify({ ...account, token_uri: tokenUri }),
    });
    expect(configured.status, tokenUri).toBe(201);
    expect(dataOf(configured).firebaseProjectId).toBe(account.project_id);
  }
  const exchanges = await tokenExchangesFor(account.client_email);
  expect(exchanges).toHaveLength(accepted.length);
  expect(exchanges.every((c) => c.method === 'POST' && c.path === '/token')).toBe(true);
});

test('PUSH-043 configure API: role and body checks', async () => {
  const p = await pushProject('push-043');
  const member = await teammate(p.project.id, 'member', p.owner);
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const outsider = await pushProject('push-043-o');
  const path = '/api/push-notifications/configure';
  const body = { projectId: p.project.id, fcmServiceAccountJson: 'x' };

  const asMember = await call('POST', path, member, body);
  expect([asMember.status, messageOf(asMember)]).toEqual([403, ROLE_REFUSAL]);
  const asOutsider = await call('POST', path, outsider.owner, body);
  expect([asOutsider.status, messageOf(asOutsider)]).toEqual([404, PROJECT_NOT_FOUND]);
  const asAdmin = await call('POST', path, admin, body);
  expect([asAdmin.status, messageOf(asAdmin)]).toEqual([400, 'Invalid JSON for FCM service account']);

  const missing = await call('POST', path, admin, { projectId: p.project.id });
  expect([missing.status, messageOf(missing)]).toEqual([400, 'fcmServiceAccountJson must be a string']);
  const extra = await call('POST', path, admin, { ...body, foo: 1 });
  expect([extra.status, messageOf(extra)]).toEqual([400, 'property foo should not exist']);
  const malformed = await call('POST', path, admin, { projectId: 'abc', fcmServiceAccountJson: 'x' });
  expect([malformed.status, messageOf(malformed)]).toEqual([404, PROJECT_NOT_FOUND]);

  expect(await pushConfigRow(p.project.id)).toBeUndefined();
  expect(await credentialRows(p.project.id)).toHaveLength(0);
});

test('PUSH-044 configure in view-as is refused', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-044');
  const staff = await signedInStaff(browser, baseURL);
  const account = fakeServiceAccount();

  await openViewAs(page, await viewAsLink(staff, p.owner));
  await openPush(page, p.project.id, 'Settings');
  const upload = card(page, 'Upload credentials');
  await field(upload, 'Service account JSON').getByRole('textbox').fill(JSON.stringify(account));
  await upload.getByRole('button', { name: 'Save configuration' }).click();
  await expect(toastTitled(page, 'Read-only session')).toContainText(READ_ONLY);
  await expect(upload.getByText(READ_ONLY, { exact: true })).toBeVisible();

  expect(await pushConfigRow(p.project.id)).toBeUndefined();
  expect(await credentialRows(p.project.id)).toHaveLength(0);
  expect(await tokenExchangesFor(account.client_email)).toHaveLength(0);
});

// ------------------------------------------------- C. Delivery channels, Mi Push ---

test('PUSH-052 stored secrets are never returned', async () => {
  const p = await pushProject('push-052', { fcm: true });
  const secret = `s3cret-${randomBytes(6).toString('hex')}`;
  const saved = await call('POST', '/api/push-notifications/channels/credentials', p.owner, MI_PUSH(p.project.id, secret));
  expect(saved.status).toBe(201);
  expect(dataOf(saved)).toEqual({ provider: 'mi_push', configured: true });

  const channels = await call('GET', `/api/push-notifications/channels/${p.project.id}`, p.owner);
  expect(Object.keys(dataOf(channels)).sort()).toEqual(['configured', 'supported']);
  expect(dataOf(channels).configured).toEqual(expect.arrayContaining(['fcm', 'mi_push']));
  const status = await call('GET', CONFIG_STATUS(p.project.id), p.owner);
  expect(Object.keys(dataOf(status)).sort()).toEqual(
    [
      'clientEmail',
      'configured',
      'firebaseProjectId',
      'frequencyCapPerDay',
      'isActive',
      'maxSendsPerMinute',
      'quietHoursEnd',
      'quietHoursStart',
      'updatedAt',
    ].sort(),
  );
  for (const response of [channels, status]) {
    for (const leaked of ['s3cret', secret, 'private_key', 'PRIVATE KEY', 'appSecret', 'com.example.e2e', p.fcm!.private_key_id]) {
      expect(response.text).not.toContain(leaked);
    }
  }
});

test('PUSH-058 channel credentials API: roles and view-as', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-058', { fcm: true });
  const member = await teammate(p.project.id, 'member', p.owner);
  const outsider = await pushProject('push-058-o');
  const staff = await signedInStaff(browser, baseURL);
  const viewAs = await viewAsCaller(staff, p.owner);
  const path = '/api/push-notifications/channels/credentials';

  const asMember = await call('POST', path, member, MI_PUSH(p.project.id));
  expect([asMember.status, messageOf(asMember)]).toEqual([403, ROLE_REFUSAL]);
  const asViewAs = await call('POST', path, viewAs, MI_PUSH(p.project.id));
  expect([asViewAs.status, messageOf(asViewAs)]).toEqual([403, READ_ONLY]);
  const asOutsider = await call('POST', path, outsider.owner, MI_PUSH(p.project.id));
  expect([asOutsider.status, messageOf(asOutsider)]).toEqual([404, PROJECT_NOT_FOUND]);

  expect((await credentialRows(p.project.id)).map((r) => r.provider)).toEqual(['fcm']);
  expect(await activityRows(p.project.id, 'channel.credentials_uploaded')).toHaveLength(0);
});

// --------------------------------------------------------- D. Delivery guardrails ---

test('PUSH-070 guardrails: member and view-as refusals', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-070', { fcm: true });
  const member = await teammate(p.project.id, 'member', p.owner);
  const policy = { frequencyCapPerDay: 2, quietHoursStart: null, quietHoursEnd: null, maxSendsPerMinute: null };
  expect((await call('POST', '/api/push-notifications/settings', p.owner, { projectId: p.project.id, ...policy })).status).toBe(201);

  const asMember = await call('POST', '/api/push-notifications/settings', member, { projectId: p.project.id, frequencyCapPerDay: 7 });
  expect([asMember.status, messageOf(asMember)]).toEqual([403, ROLE_REFUSAL]);

  const staff = await signedInStaff(browser, baseURL);
  await openViewAs(page, await viewAsLink(staff, p.owner));
  await openPush(page, p.project.id, 'Settings');
  const guardrails = card(page, 'Delivery guardrails');
  const cap = field(guardrails, 'Maximum campaigns per device, per day').getByRole('spinbutton');
  await expect(cap).toHaveValue('2');
  await cap.fill('5');
  await guardrails.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toastTitled(page, 'Read-only session')).toContainText(READ_ONLY);
  await expect(toastTitled(page, 'Could not save')).toContainText(READ_ONLY);

  expect(dataOf(await call('GET', CONFIG_STATUS(p.project.id), p.owner))).toMatchObject(policy);
  expect(await activityRows(p.project.id, 'channel.settings_changed')).toHaveLength(1);
});

test('PUSH-072 frequency cap shrinks reach', async ({ page }) => {
  const p = await pushProject('push-072', { fcm: true });
  const d1 = await addDevice(p, p.owner.ip);
  await addDevice(p, p.owner.ip);
  const settings = (frequencyCapPerDay: number | null) =>
    call('POST', '/api/push-notifications/settings', p.owner, { projectId: p.project.id, frequencyCapPerDay });
  expect((await settings(1)).status).toBe(201);
  // D1 was already sent one campaign in the last 24 hours.
  await seedSentEvent(p.project.id, await seedSentCampaign(p.project.id), d1.id);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/new`);
  await expect(reachFigure(page)).toHaveText('1');

  const capped = await call('POST', '/api/push-notifications/send', p.owner, {
    projectId: p.project.id,
    title: 'Only capped devices',
    deviceIdentityIds: [d1.id],
  });
  expect([capped.status, messageOf(capped)]).toEqual([400, NO_REACHABLE_TOKENS]);

  expect((await settings(null)).status).toBe(201);
  await page.reload();
  await expect(reachFigure(page)).toHaveText('2');
});

// ---------------------------------------------------------------- F. Test send ---

test('PUSH-082 test send to an opted-out device is refused without calling Firebase', async ({ page }) => {
  const p = await pushProject('push-082', { fcm: true });
  const d3 = await addDevice(p, p.owner.ip, { pushOptIn: false });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const testSend = card(page, 'Test send');
  await field(testSend, 'Device registration token').getByRole('textbox').fill(d3.tokens[0]);
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/push-notifications/test-send')),
    testSend.getByRole('button', { name: 'Deliver' }).click(),
  ]);
  expect((await answer.json()).data).toEqual({
    delivered: false,
    dryRun: false,
    error: 'This device has opted out of push notifications.',
    errorCode: 'opted_out',
  });
  await expect(testSend.getByText('Rejected by Firebase')).toBeVisible();
  await expect(testSend.locator('code')).toHaveText('opted_out');
  await expect(testSend.getByText('This device has opted out of push notifications.', { exact: true })).toBeVisible();
  await expect(toastTitled(page, 'opted_out')).toContainText('This device has opted out of push notifications.');
  expect(await fcmSendsFor(p.fcm!.project_id)).toHaveLength(0);
});

test('PUSH-089 test send while the billing owner is suspended', async ({ page }) => {
  const p = await pushProject('push-089', { fcm: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const device = await addDevice(p, p.owner.ip);
  await suspendAccount(p.owner.userId);

  await signIn(page, admin);
  await openPush(page, p.project.id, 'Settings');
  const testSend = card(page, 'Test send');
  await field(testSend, 'Device registration token').getByRole('textbox').fill(device.tokens[0]);
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/push-notifications/test-send')),
    testSend.getByRole('button', { name: 'Deliver' }).click(),
  ]);
  expect(answer.status()).toBe(403);
  await expect(testSend.getByText(TEST_SEND_SUSPENDED, { exact: true })).toBeVisible();
  await expect(testSend.getByText('Rejected by Firebase')).toHaveCount(0);
  expect(await fcmSendsFor(p.fcm!.project_id)).toHaveLength(0);
});

test('PUSH-090 test send in view-as is refused', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-090', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const staff = await signedInStaff(browser, baseURL);

  await openViewAs(page, await viewAsLink(staff, p.owner));
  await openPush(page, p.project.id, 'Settings');
  const testSend = card(page, 'Test send');
  await field(testSend, 'Device registration token').getByRole('textbox').fill(device.tokens[0]);
  await testSend.getByRole('button', { name: 'Deliver' }).click();
  await expect(toastTitled(page, 'Read-only session')).toContainText(READ_ONLY);
  await expect(testSend.getByText(READ_ONLY, { exact: true })).toBeVisible();
  expect(await fcmSendsFor(p.fcm!.project_id)).toHaveLength(0);
});

// ------------------------------------------------------- G. Composer: audience ---

test('PUSH-097 reach for everyone excludes opted-out, tokenless and inactive devices', async ({ page }) => {
  const p = await pushProject('push-097', { fcm: true });
  const ip = p.owner.ip;
  await addDevice(p, ip); // D1
  await addDevice(p, ip); // D2
  await addDevice(p, ip, { pushOptIn: false }); // D3, opted out
  await addDevice(p, ip, { tokens: 0 }); // D4, no token
  await addDevice(p, ip, { tokens: 2 }); // D5, two tokens
  const gone = await addDevice(p, ip); // D6, its only token unregistered
  await unregisterToken(p, ip, gone.tokens[0]);

  await signIn(page, p.owner);
  const [preview] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/push-notifications/audience-preview')),
    page.goto(`/projects/${p.project.id}/push-notifications/new`),
  ]);
  expect((await preview.json()).data).toEqual({ targetType: 'project', totalTokens: 4, deviceCount: null });
  await expect(reachFigure(page)).toHaveText('4');
  await expect(page.getByText('devices will be reached.', { exact: true })).toBeVisible();

  const direct = await call('POST', '/api/push-notifications/audience-preview', p.owner, { projectId: p.project.id });
  expect(dataOf(direct)).toEqual({ targetType: 'project', totalTokens: 4, deviceCount: null });
});

// ----------------------------------------------------- I. Composer: experiment ---

test('PUSH-137 start an experiment', async ({ page }) => {
  test.setTimeout(180_000);
  const p = await pushProject('push-137', { fcm: true });
  const devices = [];
  for (let i = 0; i < 10; i++) devices.push(await addDevice(p, p.owner.ip));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/new`);
  await expect(reachFigure(page)).toHaveText('10');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByText('A/B experiment', { exact: true }).locator('../..').getByRole('switch').click();
  await field(page, 'Campaign name *').getByRole('textbox').fill('Headline test');
  await field(page, 'Title *', 0).getByRole('textbox').fill('Free shipping today');
  await field(page, 'Title *', 1).getByRole('textbox').fill('Twenty percent off');
  await page.getByText('Control group', { exact: true }).locator('../..').getByRole('spinbutton').fill('20');
  await expect(page.getByText('~2 of 10 people will receive nothing.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();

  const experimentRow = page.locator('dl div').filter({ has: page.locator('dt', { hasText: /^Experiment$/ }) });
  await expect(experimentRow.locator('dd')).toContainText('2 variants, 20% held back as control');
  await expect(experimentRow.locator('dd')).toContainText('about 2 in control, 8 treated');
  await expect(page.getByText('Starting an experiment across 2 variants (20% control), reaching 10 devices.', { exact: true })).toBeVisible();

  const [sent] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/push-notifications/send')),
    page.getByRole('button', { name: 'Start experiment' }).click(),
  ]);
  expect(sent.status()).toBe(201);
  const parentId = (await sent.json()).data.id as string;
  await expect(toastTitled(page, 'Experiment started')).toContainText('Splitting 10 device(s) across 2 variant(s) and control.');
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications$`));

  const parent = await campaignRow(parentId);
  expect(parent).toMatchObject({ status: 'scheduled', control_percentage: 20, title: 'Headline test' });
  expect((parent!.variants as Array<{ key: string; title: string }>).map((v) => [v.key, v.title])).toEqual([
    ['A', 'Free shipping today'],
    ['B', 'Twenty percent off'],
  ]);
  expect(Math.abs(new Date(parent!.scheduled_at).getTime() - Date.now())).toBeLessThan(60_000);
  expect(await activityRows(p.project.id, 'campaign.scheduled')).toHaveLength(1);

  // The worker's next tick splits it into arms.
  await expect.poll(async () => (await campaignRow(parentId))?.status, { timeout: 100_000, intervals: [2_000] }).toBe('expanded');
  const children = (await campaignRows(p.project.id)).filter((row) => row.parent_campaign_id === parentId);
  expect(children.length).toBeGreaterThan(0);
  const control = await campaignRecipients(parentId, 'control');
  const armed = (await Promise.all(children.map((child) => campaignRecipients(child.id)))).flat();
  const titles: Record<string, string> = { A: 'Free shipping today', B: 'Twenty percent off' };
  for (const child of children) {
    expect(['A', 'B']).toContain(child.variant_key);
    expect(child.title).toBe(titles[child.variant_key]);
  }
  expect(new Set(children.map((c) => c.variant_key)).size).toBe(children.length);
  expect(new Set(armed).size).toBe(armed.length);
  expect(armed.filter((id) => control.includes(id))).toEqual([]);
  expect([...armed, ...control].sort()).toEqual(devices.map((d) => d.id).sort());
});

// ------------------------------------------------- L. Composer: review and send ---

test('PUSH-169 send API: configuration and audience errors', async () => {
  test.setTimeout(120_000);
  const p = await pushProject('push-169', { fcm: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const member = await teammate(p.project.id, 'member', p.owner);
  const unconfigured = await pushProject('push-169-u', { owner: p.owner });
  const other = await pushProject('push-169-o', { fcm: true });
  const own = await addDevice(p, p.owner.ip, { tokens: 2 });
  await addDevice(p, p.owner.ip);
  const foreign = await addDevice(other, other.owner.ip);
  const otherSegment = await createSegment(other.owner, other.project.id);
  const send = (as: typeof p.owner, body: Record<string, unknown>) =>
    call('POST', '/api/push-notifications/send', as, { title: 'PUSH-169', ...body });

  const noConfig = await send(p.owner, { projectId: unconfigured.project.id });
  expect([noConfig.status, messageOf(noConfig)]).toEqual([404, NOT_CONFIGURED]);
  await sql(`UPDATE push_configs SET is_active = false WHERE project_id = $1`, [p.project.id]);
  const inactive = await send(p.owner, { projectId: p.project.id });
  expect([inactive.status, messageOf(inactive)]).toEqual([404, NOT_CONFIGURED]);
  await sql(`UPDATE push_configs SET is_active = true WHERE project_id = $1`, [p.project.id]);

  for (const segmentId of [otherSegment, randomId()]) {
    const missing = await send(p.owner, { projectId: p.project.id, segmentId });
    expect([missing.status, messageOf(missing)]).toEqual([404, `Segment ${segmentId} not found`]);
  }
  const allForeign = await send(p.owner, { projectId: p.project.id, deviceIdentityIds: [foreign.id] });
  expect([allForeign.status, messageOf(allForeign)]).toEqual([400, 'None of these devices belong to this project.']);
  const badSegment = await send(p.owner, { projectId: p.project.id, segmentId: 'abc' });
  expect([badSegment.status, messageOf(badSegment)]).toEqual([400, 'segmentId must be a UUID']);

  const mixed = await send(p.owner, { projectId: p.project.id, deviceIdentityIds: [own.id, foreign.id, own.id] });
  expect(mixed.status).toBe(201);
  expect(dataOf(mixed)).toMatchObject({ targetType: 'devices', totalTokens: 2 });
  expect(await campaignRecipients(dataOf(mixed).id)).toEqual([own.id]);

  // Every role may send (messaging.write).
  for (const as of [p.owner, admin, member]) {
    const everyone = await send(as, { projectId: p.project.id });
    expect(everyone.status).toBe(201);
    expect(dataOf(everyone)).toMatchObject({ targetType: 'project', totalTokens: 3 });
  }
  expect(await campaignRows(unconfigured.project.id)).toHaveLength(0);
  expect((await campaignRows(other.project.id)).length).toBe(0);
});

test('PUSH-176 send while the billing owner is suspended', async ({ page }) => {
  test.setTimeout(300_000);
  const p = await pushProject('push-176', { fcm: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  await addDevice(p, p.owner.ip);
  const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const due = dataOf(await call('POST', '/api/push-notifications/send', p.owner, { projectId: p.project.id, title: 'Due during the suspension', scheduledAt: later }));
  const series = dataOf(
    await call('POST', '/api/push-notifications/send', p.owner, {
      projectId: p.project.id,
      title: 'Daily series',
      recurrence: { frequency: 'daily', interval: 1, atTime: '09:00', timezone: 'UTC' },
    }),
  );
  expect([due.status, series.status]).toEqual(['scheduled', 'scheduled']);

  await suspendAccount(p.owner.userId);
  // Their moments pass while the account is suspended. Whole milliseconds, as the API
  // writes them: the sweeps claim a template by comparing the time they read.
  await sql(`UPDATE push_notification_logs SET scheduled_at = date_trunc('milliseconds', now() - interval '1 minute') WHERE id = ANY($1)`, [
    [due.id, series.id],
  ]);
  // The admin composes and sends now: the API accepts it, the worker stops it.
  await signIn(page, admin);
  await page.goto(`/projects/${p.project.id}/push-notifications/new`);
  await expect(reachFigure(page)).toHaveText('1');
  await page.getByRole('button', { name: 'Next' }).click();
  await field(page, 'Title *').getByRole('textbox').fill('Sent while suspended');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  const [sent] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/push-notifications/send')),
    page.getByRole('button', { name: 'Send campaign' }).click(),
  ]);
  expect(sent.status()).toBe(201);
  const queued = (await sent.json()).data as { id: string; status: string };
  expect(queued.status).toBe('queued');
  await expect(toastTitled(page, 'Campaign queued')).toContainText('Sending to 1 device(s).');

  await expect.poll(async () => (await campaignRow(queued.id))?.status, { timeout: 60_000 }).toBe('failed');
  expect((await campaignRow(queued.id))?.error_message).toBe(STOPPED_BY_SUSPENSION);
  await expect.poll(async () => (await campaignRow(due.id))?.status, { timeout: 100_000, intervals: [2_000] }).toBe('cancelled');
  expect((await campaignRow(due.id))?.error_message).toBe(MISSED_DURING_SUSPENSION);
  const template = await campaignRow(series.id);
  expect(template?.status).toBe('scheduled');
  expect(new Date(template!.scheduled_at).getTime()).toBeGreaterThan(Date.now());
  const occurrences = async () => (await campaignRows(p.project.id)).filter((row) => row.parent_campaign_id === series.id);
  expect(await occurrences()).toHaveLength(0);
  expect(await fcmSendsFor(p.fcm!.project_id)).toHaveLength(0);

  // After reactivation the series fires at its next slot (brought forward here, not waited for).
  await reactivateAccount(p.owner.userId);
  await sql(`UPDATE push_notification_logs SET scheduled_at = date_trunc('milliseconds', now() - interval '1 minute') WHERE id = $1`, [series.id]);
  await expect.poll(async () => (await occurrences()).length, { timeout: 100_000, intervals: [2_000] }).toBe(1);
  expect((await campaignRow(queued.id))?.status).toBe('failed');
  expect((await campaignRow(due.id))?.status).toBe('cancelled');
});

test('PUSH-177 send in view-as is refused', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-177', { fcm: true });
  await addDevice(p, p.owner.ip);
  const staff = await signedInStaff(browser, baseURL);

  await openViewAs(page, await viewAsLink(staff, p.owner));
  const [preview] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/push-notifications/audience-preview')),
    page.goto(`/projects/${p.project.id}/push-notifications/new`),
  ]);
  expect(preview.status()).toBe(403);
  await expect(toastTitled(page, 'Read-only session').first()).toContainText(READ_ONLY);
  await expect(
    page.getByText('Couldn’t calculate reach for this audience. Try changing the audience or reloading the page.', { exact: true }),
  ).toBeVisible();
  await expect(reachFigure(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

  const viewAs = await viewAsCaller(staff, p.owner);
  const direct = await call('POST', '/api/push-notifications/send', viewAs, { projectId: p.project.id, title: 'From view-as' });
  expect([direct.status, messageOf(direct)]).toEqual([403, READ_ONLY]);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-179 composer on another tenant’s project', async ({ page }) => {
  const p = await pushProject('push-179', { fcm: true });
  await addDevice(p, p.owner.ip);
  const outsider = await pushProject('push-179-o');

  const previews: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/push-notifications/audience-preview')) previews.push(request.postData() ?? '');
  });
  await signIn(page, outsider.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/new`);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New push campaign' })).toHaveCount(0);
  expect(previews).toEqual([]);

  const direct = await call('POST', '/api/push-notifications/audience-preview', outsider.owner, { projectId: p.project.id });
  expect([direct.status, messageOf(direct)]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(direct.body.data).toBeUndefined();
});

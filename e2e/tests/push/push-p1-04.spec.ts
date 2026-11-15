import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { seedUnreadableFcmConfig } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addDevice,
  apnsCredentials,
  call,
  campaignRow,
  campaignRows,
  card,
  dataOf,
  eventRows,
  fcmSendsFor,
  field,
  figureTile,
  MISSED_DURING_SUSPENSION,
  messageOf,
  miPushCredentials,
  newToken,
  nextButton,
  NOT_CONFIGURED,
  openComposer,
  openPush,
  PROJECT_NOT_FOUND,
  projectReach,
  pushProject,
  reachability,
  reachFigure,
  reactivateAccount,
  runPushJob,
  sdkCall,
  seedLogRow,
  seedSentCampaign,
  sql,
  statusValue,
  suspendAccount,
  teammate,
  TEST_SEND_SUSPENDED,
  toastTitled,
  tokenRows,
  tokenRowsByValue,
  touchpointRows,
  unregisterPath,
  unregisterToken,
  workerLog,
  type Device,
  type PushProject,
} from '../../support/areas/push';

/**
 * Push, P1: the SDK's token and engagement routes (unknown devices, body checks,
 * re-registering, unregistering, suspension, duplicates, attribution touchpoints,
 * events outside the audience or channel, the route throttle), the activity log, upper
 * case project ids, recurrence calendars, the stranded-campaign sweep, concurrent
 * cancels, unreadable credentials, vendor credentials before FCM, reach across
 * channels, free-form values on the detail page, fetch failures and suspension of due
 * parents. FCM is seeded; Google and FCM are the provider stub. The worker's push
 * schedulers are also run on demand (`runPushJob`). Pages run in UTC with an en-US locale.
 */

test.describe.configure({ mode: 'parallel' });
test.use({ timezoneId: 'UTC', locale: 'en-US' });

const MINUTE = 60_000;
const DAY = 86_400_000;
const REGISTER = '/api/push-tokens/register';
const EVENTS = '/api/push-notifications/events';
const SEND = '/api/push-notifications/send';
const CHANNEL_CREDENTIALS = '/api/push-notifications/channels/credentials';
const DEVICE_NOT_FOUND = 'Device identity not found. Call identify() first.';
const NOT_CONFIGURED_STATUS = 'FCM not configured. Upload your Firebase service account JSON below to enable push notifications.';
const NOT_CONFIGURED_LIST = 'FCM is not configured, so nothing can be sent. Set it up under Settings.';
const NOT_CONFIGURED_COMPOSER =
  'FCM is not configured for this project, so nothing can be sent yet. Set it up under Settings on the push notifications page.';
const ABANDONED = 'Campaign abandoned: no delivery job remains and no progress was recorded for over 15 minutes.';
const hex = () => randomBytes(3).toString('hex');
const inAMonth = () => new Date(Date.now() + 30 * DAY);
const endsWith = (suffix: string) => (url: string) => new URL(url).pathname.endsWith(suffix);

// ----------------------------------------------------------------- helpers ---

/** A token registration through the SDK route, answering the status and body. */
function register(p: PushProject, body: Record<string, unknown>, apiKey: string | null = p.sdkKey) {
  return sdkCall('POST', REGISTER, apiKey, { projectId: p.project.id, platform: 'android', ...body }, p.owner.ip);
}

/** An engagement report through the SDK route, answering the status and body. */
function event(p: PushProject, campaignId: string, device: Pick<Device, 'fingerprint'>, type: string, ip = p.owner.ip) {
  return sdkCall('POST', EVENTS, p.sdkKey, { projectId: p.project.id, campaignId, deviceFingerprint: device.fingerprint, type, platform: 'android' }, ip);
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

/** The campaign row on the list page, by its title. */
function listRow(page: Page, title: string) {
  return card(page, 'Campaigns').getByRole('row').filter({ hasText: title });
}

/** Occurrences (children) of a campaign, oldest scheduled first. */
async function childRows(parentId: string): Promise<Array<Record<string, any>>> {
  return sql(`SELECT * FROM push_notification_logs WHERE parent_campaign_id = $1 ORDER BY scheduled_at, id`, [parentId]);
}

/** Runs the schedule tick until `done` holds (the stack's worker may also tick). */
async function tickUntil(done: () => Promise<boolean>, maxTicks = 8): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (await done()) return;
    await runPushJob('push-schedule-tick');
  }
  expect(await done()).toBe(true);
}

const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const daysIn = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** One calendar month on from a UTC instant, clamped to the end of a shorter month. */
function addMonthClamped(ms: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + 1) / 12);
  const m0 = (d.getUTCMonth() + 1) % 12;
  return Date.UTC(y, m0, Math.min(d.getUTCDate(), daysIn(y, m0)), d.getUTCHours(), d.getUTCMinutes());
}

// ---------------------------------------------- O. SDK token and event routes ---

test('PUSH-229 register: unknown device', async () => {
  const p = await pushProject('push-229', { fcm: true });
  const known = await addDevice(p, p.owner.ip, { tokens: 0 });
  const token = newToken();

  const unknown = await register(p, { deviceFingerprint: `never-identified-${hex()}`, token });
  expect([unknown.status, messageOf(unknown)]).toEqual([404, DEVICE_NOT_FOUND]);
  expect(await tokenRowsByValue(token)).toHaveLength(0);

  // The same token for an identified device is stored.
  expect((await register(p, { deviceFingerprint: known.fingerprint, token })).status).toBe(201);
  expect((await tokenRowsByValue(token)).map((r) => r.device_identity_id)).toEqual([known.id]);
});

test('PUSH-230 register: body validation', async () => {
  const p = await pushProject('push-230', { fcm: true });
  const device = await addDevice(p, p.owner.ip, { tokens: 0 });
  const token = newToken();
  const base = { deviceFingerprint: device.fingerprint, token };

  const cases: Array<[Record<string, unknown>, string]> = [
    [{ platform: 'windows' }, 'platform must be one of the following values: ios, android, web'],
    [{ provider: 'pigeon' }, 'provider must be one of the following values: fcm, apns, mi_push, huawei, oppo, vivo, honor'],
    [{ provider: 'huawei' }, 'This deployment cannot deliver on the "huawei" channel. Supported: fcm, apns, mi_push.'],
    [{ projectId: 'x' }, 'projectId must be a UUID'],
    [{ token: undefined }, 'token must be a string'],
    [{ appVersion: '1.2.3' }, 'property appVersion should not exist'],
  ];
  for (const [change, message] of cases) {
    const refused = await register(p, { ...base, ...change });
    expect([refused.status, messageOf(refused)], JSON.stringify(change)).toEqual([400, message]);
  }
  expect(await tokenRows(p.project.id)).toHaveLength(0);

  const accepted = await register(p, { ...base, provider: 'mi_push' });
  expect(accepted.status).toBe(201);
  expect((await tokenRows(p.project.id)).map((r) => [r.token, r.provider])).toEqual([[token, 'mi_push']]);
});

test('PUSH-231 re-register brings a token back', async () => {
  const p = await pushProject('push-231', { fcm: true });
  const first = await addDevice(p, p.owner.ip);
  const second = await addDevice(p, p.owner.ip, { tokens: 0 });
  const token = first.tokens[0];
  const [original] = await tokenRowsByValue(token);

  await unregisterToken(p, p.owner.ip, token);
  expect(await reachability(p.owner, p.project.id)).toMatchObject({ activeTokens: 0, appRequested: 1 });

  const again = await register(p, { deviceFingerprint: first.fingerprint, token });
  expect(again.status).toBe(201);
  expect(dataOf(again)).toMatchObject({
    id: original.id,
    deviceIdentityId: first.id,
    provider: 'fcm',
    isActive: true,
    deactivatedAt: null,
    deactivationReason: null,
  });
  expect(await reachability(p.owner, p.project.id)).toMatchObject({ activeTokens: 1, appRequested: 0 });

  const moved = await register(p, { deviceFingerprint: second.fingerprint, token, provider: 'apns', platform: 'ios' });
  expect(moved.status).toBe(201);
  expect(dataOf(moved)).toMatchObject({ id: original.id, deviceIdentityId: second.id, provider: 'apns', platform: 'ios', isActive: true });
  const rows = await tokenRowsByValue(token);
  expect(rows.map((r) => [r.id, r.device_identity_id, r.provider, r.platform, r.is_active])).toEqual([
    [original.id, second.id, 'apns', 'ios', true],
  ]);
});

test('PUSH-232 unregister a token', async ({ page }) => {
  const p = await pushProject('push-232', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const other = await pushProject('push-232-x', { fcm: true });
  const token = device.tokens[0];

  const unregistered = await sdkCall('DELETE', unregisterPath(p.project.id, token), p.sdkKey, undefined, p.owner.ip);
  expect([unregistered.status, dataOf(unregistered)]).toEqual([200, { success: true }]);
  const [row] = await tokenRowsByValue(token);
  expect([row.is_active, row.deactivation_reason]).toEqual([false, 'app_requested']);
  expect(row.deactivated_at).not.toBeNull();

  const unknown = await sdkCall('DELETE', unregisterPath(p.project.id, newToken()), p.sdkKey, undefined, p.owner.ip);
  expect([unknown.status, dataOf(unknown)]).toEqual([200, { success: true }]);
  const mismatch = await sdkCall('DELETE', unregisterPath(other.project.id, token), p.sdkKey, undefined, p.owner.ip);
  expect([mismatch.status, messageOf(mismatch)]).toEqual([403, 'Project mismatch']);
  const noKey = await sdkCall('DELETE', unregisterPath(p.project.id, token), null, undefined, p.owner.ip);
  expect([noKey.status, messageOf(noKey)]).toEqual([401, 'API key is required']);

  expect(await reachability(p.owner, p.project.id)).toMatchObject({ activeTokens: 0, appRequested: 1, providerRejected: 0, likelyUninstalls: 0 });
  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  await expect(statusValue(page, 'Logouts / opt-outs')).toHaveText('1');
  await expect(statusValue(page, 'Provider-rejected')).toHaveText('0');
  await expect(card(page, 'Reachability').getByText('Likely uninstalls', { exact: true }).locator('xpath=following-sibling::p[1]')).toHaveText('0');
});

test('PUSH-233 SDK routes keep working while suspended', async () => {
  const p = await pushProject('push-233', { fcm: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const device = await addDevice(p, p.owner.ip, { tokens: 0 });
  const campaignId = await seedSentCampaign(p.project.id);
  const token = newToken();

  await suspendAccount(p.owner.userId);
  try {
    // The suspension is in force: an outbound test send is refused.
    const testSend = await call('POST', '/api/push-notifications/test-send', admin, { projectId: p.project.id, token });
    expect([testSend.status, messageOf(testSend)]).toEqual([403, TEST_SEND_SUSPENDED]);

    const registered = await register(p, { deviceFingerprint: device.fingerprint, token });
    expect(registered.status).toBe(201);
    expect(dataOf(registered)).toMatchObject({ token, isActive: true });
    const reported = await event(p, campaignId, device, 'delivered');
    expect([reported.status, dataOf(reported)]).toEqual([201, { recorded: true }]);
    expect((await eventRows(campaignId)).map((e) => e.type)).toEqual(['delivered']);
  } finally {
    await reactivateAccount(p.owner.userId);
  }
});

test('PUSH-235 duplicate events are absorbed', async () => {
  const p = await pushProject('push-235', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const campaignId = await seedSentCampaign(p.project.id, `Spring sale ${hex()}`);

  for (const type of ['delivered', 'click']) {
    const once = await event(p, campaignId, device, type);
    expect([once.status, dataOf(once)], type).toEqual([201, { recorded: true }]);
    const twice = await event(p, campaignId, device, type);
    expect([twice.status, dataOf(twice)], type).toEqual([201, { recorded: false }]);
  }
  expect((await eventRows(campaignId)).map((e) => e.type).sort()).toEqual(['click', 'delivered']);
  const report = dataOf(await call('GET', `/api/push-notifications/report/${p.project.id}/${campaignId}`, p.owner));
  expect(report).toMatchObject({ delivered: 1, clicks: 1, clickThroughRate: 100 });
  const touchpoints = await touchpointRows(p.project.id, device.fingerprint);
  expect(touchpoints.map((t) => t.touchpoint_type)).toEqual(['push_click']);
});

test('PUSH-238 push click creates an attribution touchpoint', async () => {
  const p = await pushProject('push-238', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const title = `Spring sale ${hex()}`;
  const campaignId = await seedSentCampaign(p.project.id, title);
  // A delivery report is not a touchpoint.
  expect(dataOf(await event(p, campaignId, device, 'delivered'))).toEqual({ recorded: true });
  expect(await touchpointRows(p.project.id, device.fingerprint)).toHaveLength(0);

  const clicked = await event(p, campaignId, device, 'click');
  expect([clicked.status, dataOf(clicked)]).toEqual([201, { recorded: true }]);
  const touchpoints = await touchpointRows(p.project.id, device.fingerprint);
  expect(touchpoints.map((t) => [t.touchpoint_type, t.channel, t.campaign, t.metadata])).toEqual([
    ['push_click', 'push', title, { campaignId }],
  ]);
  const channels = dataOf<Array<{ channel: string; count: number }>>(
    await call('GET', `/api/projects/${p.project.id}/touchpoints/channels`, p.owner),
  );
  expect(channels.map((c) => [c.channel, c.count])).toEqual([['push', 1]]);
});

// --------------------------------------------------------- P. Cross-cutting ---

test('PUSH-245 activity log entries for push', async ({ page }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-245', { fcm: true });
  const distinctId = `push-245-${hex()}`;
  const device = await addDevice(p, p.owner.ip, { distinctId });
  await addDevice(p, p.owner.ip);
  const pid = p.project.id;
  const miSecret = `mi-secret-${hex()}`;
  const body = `Body text ${hex()}`;
  // The project's own setup (its API key) is logged before anything here.
  const before = new Set((await sql<{ id: string }>(`SELECT id FROM project_activity WHERE project_id = $1`, [pid])).map((r) => r.id));

  expect((await call('POST', CHANNEL_CREDENTIALS, p.owner, {
    projectId: pid,
    provider: 'mi_push',
    credentials: JSON.stringify({ appSecret: miSecret, packageName: 'com.e2e.app', region: 'global' }),
  })).status).toBe(201);
  expect((await call('POST', '/api/push-notifications/settings', p.owner, { projectId: pid, frequencyCapPerDay: 3 })).status).toBe(201);
  const sentNow = dataOf(await call('POST', SEND, p.owner, { projectId: pid, title: 'Sent now', body }));
  const scheduled = dataOf(await call('POST', SEND, p.owner, { projectId: pid, title: 'Sent later', body, scheduledAt: inAMonth().toISOString() }));
  expect((await call('POST', `/api/push-notifications/cancel/${pid}/${scheduled.id}`, p.owner)).status).toBe(201);
  const doomed = dataOf(await call('POST', `/api/projects/${pid}/push-templates`, p.owner, { name: 'Doomed template', title: 'Doomed' }));
  expect((await call('DELETE', `/api/projects/${pid}/push-templates/${doomed.id}`, p.owner)).status).toBe(200);
  const toPerson = await call('POST', '/api/push-notifications/send-to-user', p.owner, { projectId: pid, distinctId, title: 'Just you', body });
  expect(toPerson.status).toBe(201);

  const logged = (await sql(`SELECT * FROM project_activity WHERE project_id = $1 ORDER BY occurred_at, id`, [pid])).filter(
    (row) => !before.has(row.id),
  );
  const byAction = (action: string) => logged.filter((row) => row.action === action);
  expect(logged.map((row) => row.action)).toEqual([
    'channel.credentials_uploaded',
    'channel.settings_changed',
    'campaign.sent',
    'campaign.scheduled',
    'campaign.cancelled',
    'content.deleted',
    'push.sent_to_person',
  ]);
  for (const row of logged) {
    expect([row.actor_kind, row.actor_user_id], row.action).toEqual(['user', p.owner.userId]);
    const text = JSON.stringify(row);
    for (const secret of [body, miSecret, distinctId, ...device.tokens]) expect(text, row.action).not.toContain(secret);
  }
  expect(byAction('channel.credentials_uploaded')[0]).toMatchObject({ target_id: 'mi_push', details: { channel: 'push', fields: ['credentials'] } });
  expect(byAction('channel.settings_changed')[0].details).toEqual({ channel: 'push', fields: ['frequencyCapPerDay'] });
  expect(byAction('campaign.sent')[0]).toMatchObject({ target_id: sentNow.id, target_label: 'Sent now', details: { channel: 'push', audienceSize: 2 } });
  expect(byAction('campaign.scheduled')[0]).toMatchObject({ target_id: scheduled.id, details: { channel: 'push', audienceSize: 2 } });
  expect(byAction('campaign.cancelled')[0]).toMatchObject({ target_id: scheduled.id, details: { channel: 'push', audienceSize: 2 } });
  expect(byAction('content.deleted')[0]).toMatchObject({ target_label: 'Doomed template', details: { kind: 'template' } });
  expect(byAction('push.sent_to_person')[0]).toMatchObject({ target_type: 'person', target_id: device.id, details: {} });

  // Creating and editing a template, an audience preview and a test send log nothing.
  const kept = dataOf(await call('POST', `/api/projects/${pid}/push-templates`, p.owner, { name: 'Kept template', title: 'Kept' }));
  expect((await call('PATCH', `/api/projects/${pid}/push-templates/${kept.id}`, p.owner, { title: 'Kept, edited' })).status).toBe(200);
  expect((await call('POST', '/api/push-notifications/audience-preview', p.owner, { projectId: pid })).status).toBe(201);
  expect((await call('POST', '/api/push-notifications/test-send', p.owner, { projectId: pid, token: device.tokens[0], dryRun: true })).status).toBe(201);
  const [{ n }] = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM project_activity WHERE project_id = $1`, [pid]);
  expect(Number(n)).toBe(before.size + logged.length);

  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/activity`);
  await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  const who = p.owner.name;
  for (const sentence of [
    `${who} updated the push credentials for Mi Push`,
    `${who} changed the push settings`,
    `${who} sent the push campaign "Sent now" to 2 devices`,
    `${who} scheduled the push campaign "Sent later" for 2 devices`,
    `${who} cancelled the push campaign "Sent later" (2 devices)`,
    `${who} deleted the template "Doomed template"`,
    `${who} sent a push to one person`,
  ]) {
    await expect(page.getByRole('cell', { name: sentence, exact: true }), sentence).toBeVisible();
  }
  await expect(page.getByText(body)).toHaveCount(0);
});

// ---------------------------------------------------- Q. Coverage additions ---

test('PUSH-248 unregister with an empty token, and an empty token can be registered', async () => {
  const p = await pushProject('push-248', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const [kept] = device.tokens;
  try {
    const first = await sdkCall('DELETE', unregisterPath(p.project.id, ''), p.sdkKey, undefined, p.owner.ip);
    expect([first.status, dataOf(first)]).toEqual([200, { success: true }]);
    expect((await tokenRows(p.project.id)).map((r) => [r.token, r.is_active])).toEqual([[kept, true]]);

    // Current behaviour: an empty token is stored as an active FCM token and counted.
    const empty = await register(p, { deviceFingerprint: device.fingerprint, token: '' });
    expect(empty.status).toBe(201);
    expect(dataOf(empty)).toMatchObject({ token: '', provider: 'fcm', isActive: true });
    expect(await projectReach(p.owner, p.project.id)).toBe(2);

    const again = await sdkCall('DELETE', unregisterPath(p.project.id, ''), p.sdkKey, undefined, p.owner.ip);
    expect([again.status, dataOf(again)]).toEqual([200, { success: true }]);
    const rows = Object.fromEntries((await tokenRows(p.project.id)).map((r) => [r.token, [r.is_active, r.deactivation_reason]]));
    expect(rows).toEqual({ [kept]: [true, null], '': [false, 'app_requested'] });
    expect(await projectReach(p.owner, p.project.id)).toBe(1);
  } finally {
    await sql(`DELETE FROM push_tokens WHERE project_id = $1 AND token = ''`, [p.project.id]);
  }
});

test('PUSH-249 two registrations of the same new token at once', async () => {
  test.setTimeout(120_000);
  const p = await pushProject('push-249', { fcm: true });
  const device = await addDevice(p, p.owner.ip, { tokens: 0 });
  const outcomes: number[][] = [];
  let sawServerError = false;
  for (let run = 0; run < 10 && !sawServerError; run++) {
    const token = newToken();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => register(p, { deviceFingerprint: device.fingerprint, token })),
    );
    const statuses = answers.map((a) => a.status).sort();
    outcomes.push(statuses);
    expect(statuses.every((s) => s === 201 || s === 500), JSON.stringify(statuses)).toBe(true);
    expect(statuses).toContain(201);
    for (const failed of answers.filter((a) => a.status === 500)) {
      expect(messageOf(failed)).toBe('Internal server error');
      expect(failed.text).not.toMatch(/duplicate key|push_tokens|constraint/i);
    }
    // However the requests land, the token has one row.
    expect(await tokenRowsByValue(token)).toHaveLength(1);
    sawServerError = statuses.includes(500);
  }
  test.info().annotations.push({ type: 'outcomes', description: JSON.stringify(outcomes) });
  // Current behaviour: the losing inserts answer 500.
  expect(sawServerError, JSON.stringify(outcomes)).toBe(true);
});

test('PUSH-252 event for a device outside the campaign’s audience is counted', async ({ page }) => {
  const p = await pushProject('push-252', { fcm: true });
  const inside = await addDevice(p, p.owner.ip);
  const outside = await addDevice(p, p.owner.ip);
  const title = `Only D1 ${hex()}`;
  const campaignId = await seedLogRow(p.project.id, { title, status: 'sent', target_type: 'devices', target_device_ids: [inside.id] });

  // Current behaviour: the report is not checked against the campaign's audience.
  for (const type of ['delivered', 'click']) {
    const reported = await event(p, campaignId, outside, type);
    expect([reported.status, dataOf(reported)], type).toEqual([201, { recorded: true }]);
  }
  expect((await eventRows(campaignId)).map((e) => e.device_identity_id)).toEqual([outside.id, outside.id]);
  expect((await touchpointRows(p.project.id, outside.fingerprint)).map((t) => t.touchpoint_type)).toEqual(['push_click']);

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await expect(listRow(page, title).getByRole('cell').nth(4)).toHaveText('1');
  await listRow(page, title).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(figureTile(page, 'Engagement', 'Delivered')).toHaveText('1');
  await expect(figureTile(page, 'Engagement', 'Clicks')).toHaveText('1');
  await expect(figureTile(page, 'Engagement', 'Click-through rate')).toHaveText('100%');
});

test('PUSH-253 event naming an email or SMS campaign is accepted', async ({ page }) => {
  const p = await pushProject('push-253', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const email = await seedLogRow(p.project.id, {
    title: 'Email E',
    channel: 'email',
    email_content: { subject: 'Email E', html: '<p>Hello</p>', text: 'Hello' },
  });
  const sms = await seedLogRow(p.project.id, { title: 'SMS S', channel: 'sms', body: 'Hello by text' });

  // Current behaviour: the push event route takes a campaign of any channel.
  for (const campaignId of [email, sms]) {
    for (const type of ['delivered', 'click']) {
      const reported = await event(p, campaignId, device, type);
      expect([reported.status, dataOf(reported)], `${campaignId} ${type}`).toEqual([201, { recorded: true }]);
    }
    const report = dataOf(await call('GET', `/api/push-notifications/report/${p.project.id}/${campaignId}`, p.owner));
    expect(report).toMatchObject({ delivered: 1, clicks: 1 });
  }
  const touchpoints = await touchpointRows(p.project.id, device.fingerprint);
  expect(touchpoints.map((t) => [t.touchpoint_type, t.campaign, t.metadata.campaignId]).sort()).toEqual([
    ['push_click', 'Email E', email],
    ['push_click', 'SMS S', sms],
  ]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${email}`);
  await expect(card(page, 'Engagement').locator('[data-slot="card-description"]')).toHaveText(
    'Reported by your email provider through its delivery webhook.',
  );
  await expect(figureTile(page, 'Engagement', 'Delivered')).toHaveText('1');
  await expect(figureTile(page, 'Engagement', 'Clicks')).toHaveText('1');
  await page.goto(`/projects/${p.project.id}/push-notifications/${sms}`);
  await expect(card(page, 'Engagement').locator('[data-slot="card-description"]')).toHaveText(
    "Reported by Twilio's delivery callbacks. Texts have no opens or clicks to report.",
  );
  await expect(figureTile(page, 'Engagement', 'Delivered')).toHaveText('1');
});

test('PUSH-256 the global throttle reaches SDK event reports', async () => {
  test.setTimeout(180_000);
  const p = await pushProject('push-256', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const campaignId = await seedSentCampaign(p.project.id);
  const ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

  const first = await event(p, campaignId, device, 'delivered', ip);
  expect([first.status, dataOf(first)]).toEqual([201, { recorded: true }]);
  const repeats: Array<{ status: number; body: any }> = [];
  for (let batch = 0; batch < 9; batch++) {
    repeats.push(...(await Promise.all(Array.from({ length: 11 }, () => event(p, campaignId, device, 'delivered', ip)))));
  }
  expect(repeats).toHaveLength(99);
  for (const repeat of repeats) expect([repeat.status, repeat.body?.data]).toEqual([201, { recorded: false }]);

  // The 101st request in the minute, a click this time, is refused and not stored.
  const response = await fetch(`${process.env.E2E_API_URL}${EVENTS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, 'X-API-Key': p.sdkKey },
    body: JSON.stringify({ projectId: p.project.id, campaignId, deviceFingerprint: device.fingerprint, type: 'click', platform: 'android' }),
  });
  expect(response.status).toBe(429);
  expect((await response.json()).message).toBe('ThrottlerException: Too Many Requests');
  const retryAfter = Number(response.headers.get('retry-after'));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect((await eventRows(campaignId)).map((e) => e.type)).toEqual(['delivered']);

  await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
  const later = await event(p, campaignId, device, 'click', ip);
  expect([later.status, dataOf(later)]).toEqual([201, { recorded: true }]);
  expect((await eventRows(campaignId)).map((e) => e.type).sort()).toEqual(['click', 'delivered']);
});

test('PUSH-259 upper-case project ids are refused', async ({ page }) => {
  const p = await pushProject('push-259', { fcm: true });
  await addDevice(p, p.owner.ip);
  const lower = p.project.id;
  const upper = lower.toUpperCase();
  expect(upper).not.toBe(lower);
  const reads = (id: string) => [
    `/api/push-notifications/logs/${id}`,
    `/api/push-notifications/config-status/${id}`,
    `/api/push-notifications/channels/${id}`,
    `/api/projects/${id}/push-templates`,
  ];
  for (const path of reads(lower)) expect((await call('GET', path, p.owner)).status, path).toBe(200);
  for (const path of reads(upper)) {
    const refused = await call('GET', path, p.owner);
    expect([refused.status, messageOf(refused)], path).toEqual([404, PROJECT_NOT_FOUND]);
  }

  const send = (projectId: string) => call('POST', SEND, p.owner, { projectId, title: 'Case check', scheduledAt: inAMonth().toISOString() });
  const refused = await send(upper);
  expect([refused.status, messageOf(refused)]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(await campaignRows(lower)).toHaveLength(0);
  expect((await send(lower)).status).toBe(201);
  expect(await campaignRows(lower)).toHaveLength(1);

  await signIn(page, p.owner);
  await page.goto(`/projects/${upper}/push-notifications`);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
});

test('PUSH-261 weekly, every 2 weeks, on chosen days fires every week', async ({ page }) => {
  const p = await pushProject('push-261', { fcm: true });
  await addDevice(p, p.owner.ip);
  // T: a slot a minute ago, so the first occurrence is already due.
  const T = floorMinute(Date.now() - MINUTE);
  const weekday = new Date(T).getUTCDay();
  const recurrence = { frequency: 'weekly', interval: 2, daysOfWeek: [weekday], atTime: hhmm(T), timezone: 'UTC' };
  const created = dataOf(
    await call('POST', SEND, p.owner, { projectId: p.project.id, title: 'Fortnightly', scheduledAt: new Date(T - 29 * MINUTE).toISOString(), recurrence }),
  );
  expect(created.status).toBe('scheduled');
  expect(new Date(created.scheduledAt).getTime()).toBe(T);

  await tickUntil(async () => (await childRows(created.id)).length > 0);
  const occurrences = await childRows(created.id);
  expect(occurrences).toHaveLength(1);
  expect(new Date(occurrences[0].scheduled_at).getTime()).toBe(T);
  const template = dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${created.id}`, p.owner));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${created.id}`);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday];
  await expect(page.getByText(`Every 2 weeks on ${day} at ${hhmm(T)} UTC, until cancelled`, { exact: true })).toBeVisible();

  // The next occurrence should be two weeks on; only this is expected to fail.
  test.fail(true, 'PUSH-261');
  test.info().annotations.push({ type: 'issue', description: 'PUSH-261' });
  expect(new Date(template.scheduledAt).getTime()).toBe(T + 14 * DAY);
});

test('PUSH-263 monthly on the 31st clamps, then stays on the clamped day', async () => {
  test.setTimeout(150_000);
  const p = await pushProject('push-263', { fcm: true });
  await addDevice(p, p.owner.ip);
  // D: the latest 31st at least two months back whose next month is shorter and the
  // month after that has 31 days again (Aug 31: September, then October).
  const now = new Date();
  let D = 0;
  for (let back = 2; back < 15 && D === 0; back++) {
    const y = now.getUTCFullYear() + Math.floor((now.getUTCMonth() - back) / 12);
    const m0 = (((now.getUTCMonth() - back) % 12) + 12) % 12;
    const next = new Date(Date.UTC(y, m0 + 1, 1));
    const after = new Date(Date.UTC(y, m0 + 2, 1));
    if (daysIn(y, m0) === 31 && daysIn(next.getUTCFullYear(), next.getUTCMonth()) < 31 && daysIn(after.getUTCFullYear(), after.getUTCMonth()) === 31) {
      D = Date.UTC(y, m0, 31, 9, 0);
    }
  }
  expect(D).toBeGreaterThan(0);
  const created = dataOf(
    await call('POST', SEND, p.owner, {
      projectId: p.project.id,
      title: 'Month end',
      scheduledAt: new Date(D - MINUTE).toISOString(),
      recurrence: { frequency: 'monthly', interval: 1, atTime: '09:00', timezone: 'UTC' },
    }),
  );
  expect(new Date(created.scheduledAt).getTime()).toBe(D);

  await tickUntil(async () => new Date((await campaignRow(created.id))!.scheduled_at).getTime() > Date.now(), 12);
  // Current behaviour: each step clamps from the previous occurrence.
  const chain = [D];
  while (addMonthClamped(chain[chain.length - 1]) <= Date.now()) chain.push(addMonthClamped(chain[chain.length - 1]));
  const occurrences = (await childRows(created.id)).map((row) => new Date(row.scheduled_at).toISOString());
  expect(occurrences).toEqual(chain.map((ms) => new Date(ms).toISOString()));
  expect(occurrences.length).toBeGreaterThanOrEqual(3);
  expect(new Date(occurrences[1]).getUTCDate()).toBeLessThan(31);
  // The month after the short one has a 31st, and the series is still on the clamped day.
  expect(new Date(occurrences[2]).getUTCDate()).toBe(new Date(occurrences[1]).getUTCDate());
  expect(new Date((await campaignRow(created.id))!.scheduled_at).getTime()).toBe(addMonthClamped(chain[chain.length - 1]));
});

test('PUSH-264 a recurring campaign behind its schedule sends every missed occurrence, one a minute', async () => {
  test.setTimeout(150_000);
  const p = await pushProject('push-264', { fcm: true });
  await addDevice(p, p.owner.ip);
  const S = floorMinute(Date.now() + 2 * MINUTE);
  const created = dataOf(
    await call('POST', SEND, p.owner, {
      projectId: p.project.id,
      title: 'Daily catch-up',
      scheduledAt: new Date(Date.now() - 3 * DAY).toISOString(),
      recurrence: { frequency: 'daily', interval: 1, atTime: hhmm(S), timezone: 'UTC' },
    }),
  );
  expect(new Date(created.scheduledAt).getTime()).toBe(S - 3 * DAY);

  // One tick spawns one occurrence and steps the template one day on.
  await runPushJob('push-schedule-tick');
  const afterOne = await childRows(created.id);
  expect(afterOne.length).toBeGreaterThanOrEqual(1);
  expect(new Date(afterOne[0].scheduled_at).getTime()).toBe(S - 3 * DAY);
  await tickUntil(async () => new Date((await campaignRow(created.id))!.scheduled_at).getTime() > Date.now());

  // Current behaviour: every missed day is sent, back to back.
  const occurrences = await childRows(created.id);
  expect(occurrences.map((row) => new Date(row.scheduled_at).getTime())).toEqual([S - 3 * DAY, S - 2 * DAY, S - DAY]);
  expect(new Date((await campaignRow(created.id))!.scheduled_at).getTime()).toBe(S);
  await expect
    .poll(async () => (await childRows(created.id)).map((row) => row.status).filter((s) => s === 'scheduled').length, { timeout: 30_000 })
    .toBe(0);
});

test('PUSH-265 a queued campaign with no job is failed after 15 minutes', async ({ page }) => {
  const p = await pushProject('push-265', { fcm: true });
  const title = `Stranded ${hex()}`;
  const id = await seedLogRow(p.project.id, {
    title,
    status: 'queued',
    total_tokens: 10,
    success_count: 0,
    processed_tokens: 0,
    updated_at: new Date(Date.now() - 20 * MINUTE),
  });

  const output = await runPushJob('push-reconcile');
  const row = await campaignRow(id);
  expect([row?.status, row?.error_message]).toEqual(['failed', ABANDONED]);
  expect(row?.completed_at).not.toBeNull();
  // Whichever process swept it (this run or the stack's worker) logged it.
  const logs = `${output}\n${workerLog()}`;
  expect(logs).toContain(`Stranded campaign ${id} reconciled to failed`);
  expect(logs).toMatch(/Reconciled \d+ stranded push campaign\(s\)/);

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await expect(listRow(page, title).getByRole('cell').nth(1)).toHaveText('Failed');
  await expect(listRow(page, title).getByRole('cell').nth(3)).toHaveText('0/10');
  const reads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(`/api/push-notifications/campaign/${p.project.id}/${id}`)) reads.push(r.url());
  });
  await listRow(page, title).click();
  const errorCard = page.locator('[data-slot="card"].border-destructive\\/40');
  await expect(errorCard).toHaveText(ABANDONED);
  const seen = reads.length;
  await page.waitForTimeout(7_000);
  expect(reads.length).toBe(seen);
});

test('PUSH-266 stranded sweep: partial, and what it leaves alone', async () => {
  const p = await pushProject('push-266', { fcm: true });
  const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);
  const r1 = await seedLogRow(p.project.id, { title: 'R1', status: 'sending', total_tokens: 10, success_count: 4, processed_tokens: 4, updated_at: ago(20) });
  const r2 = await seedLogRow(p.project.id, {
    title: 'R2',
    status: 'scheduled',
    scheduled_at: new Date(Date.now() + 7 * DAY),
    processed_tokens: 0,
    success_count: 0,
    updated_at: ago(20),
  });
  const r3 = await seedLogRow(p.project.id, { title: 'R3', status: 'queued', success_count: 0, processed_tokens: 0, updated_at: ago(5) });
  const r4 = await seedLogRow(p.project.id, { title: 'R4', status: 'sent', updated_at: ago(20) });
  const state = async (id: string) => {
    const row = (await campaignRow(id))!;
    return [row.status, row.error_message];
  };

  await runPushJob('push-reconcile');
  expect(await state(r1)).toEqual(['partial', ABANDONED]);
  expect((await campaignRow(r1))!.completed_at).not.toBeNull();
  expect(await state(r2)).toEqual(['scheduled', null]);
  expect(await state(r3)).toEqual(['queued', null]);
  expect(await state(r4)).toEqual(['sent', null]);

  // R3 once it has gone 15 minutes without progress.
  await sql(`UPDATE push_notification_logs SET updated_at = now() - interval '16 minutes' WHERE id = $1`, [r3]);
  await runPushJob('push-reconcile');
  expect(await state(r3)).toEqual(['failed', ABANDONED]);
  expect(await state(r2)).toEqual(['scheduled', null]);
  expect(await state(r4)).toEqual(['sent', null]);
});

test('PUSH-267 two cancels at once', async () => {
  test.setTimeout(150_000);
  const p = await pushProject('push-267', { fcm: true });
  await addDevice(p, p.owner.ip);
  const runs: Array<{ statuses: number[]; activity: number }> = [];
  const refusal = 'Only a scheduled campaign can be cancelled; this one is cancelled.';
  for (let run = 0; run < 10; run++) {
    const created = dataOf(await call('POST', SEND, p.owner, { projectId: p.project.id, title: `Cancel race ${run}`, scheduledAt: inAMonth().toISOString() }));
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => call('POST', `/api/push-notifications/cancel/${p.project.id}/${created.id}`, p.owner)),
    );
    for (const refused of answers.filter((a) => a.status !== 201)) expect([refused.status, messageOf(refused)]).toEqual([400, refusal]);
    expect((await campaignRow(created.id))?.status).toBe('cancelled');
    const activity = (await activityRows(p.project.id, 'campaign.cancelled')).filter((row) => row.target_id === created.id).length;
    runs.push({ statuses: answers.map((a) => a.status).sort(), activity });
  }
  test.info().annotations.push({ type: 'outcomes', description: JSON.stringify(runs) });

  // One cancel wins and is logged once; only this is expected to fail.
  test.fail(true, 'PUSH-267');
  test.info().annotations.push({ type: 'issue', description: 'PUSH-267' });
  for (const run of runs) {
    expect(run.statuses.filter((s) => s === 201), JSON.stringify(runs)).toHaveLength(1);
    expect(run.activity, JSON.stringify(runs)).toBe(1);
  }
});

test('PUSH-269 test send with credentials that fail decryption', async ({ page }) => {
  const p = await pushProject('push-269');
  await seedUnreadableFcmConfig(p.project.id, 'bad-ciphertext');
  const error = 'Unsupported state or unable to authenticate data';

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  const t = testSendCard(page);
  await t.token.fill('any-token');
  for (const [button, dryRun] of [[t.deliver, false], [t.validate, true]] as const) {
    const [answer] = await Promise.all([
      page.waitForResponse((r) => endsWith('/api/push-notifications/test-send')(r.url())),
      button.click(),
    ]);
    expect(answer.status()).toBe(201);
    // Current behaviour: Node's decryption error, shown under the Firebase heading.
    expect((await answer.json()).data).toEqual({ delivered: false, dryRun, error });
    await expect(t.testSend.getByText('Rejected by Firebase', { exact: true })).toBeVisible();
    const line = t.testSend.getByText(error, { exact: true });
    await expect(line).toBeVisible();
    await expect(line.locator('..')).toHaveClass(/border-destructive/);
    await expect(t.testSend.locator('code')).toHaveCount(0);
    await expect(toastTitled(page, 'Rejected by Firebase').first()).toContainText(error);
  }
});

test('PUSH-273 Mi Push or APNs credentials saved before FCM exists', async ({ page }) => {
  const mi = await pushProject('push-273');
  const apns = await pushProject('push-273-a', { owner: mi.owner });
  const cases: Array<[PushProject, 'mi_push' | 'apns', string]> = [
    [mi, 'mi_push', miPushCredentials()],
    [apns, 'apns', apnsCredentials()],
  ];
  for (const [p, provider, credentials] of cases) {
    await addDevice(p, p.owner.ip);
    const stored = await call('POST', CHANNEL_CREDENTIALS, p.owner, { projectId: p.project.id, provider, credentials });
    expect([stored.status, dataOf(stored)], provider).toEqual([201, { provider, configured: true }]);
    const logged = await activityRows(p.project.id, 'channel.credentials_uploaded');
    expect(logged.map((row) => row.target_id), provider).toEqual([provider]);

    const channels = dataOf(await call('GET', `/api/push-notifications/channels/${p.project.id}`, p.owner));
    expect(channels.configured, provider).toEqual([provider]);
    const status = dataOf(await call('GET', `/api/push-notifications/config-status/${p.project.id}`, p.owner));
    expect(status.configured, provider).toBe(false);
    const send = await call('POST', SEND, p.owner, { projectId: p.project.id, title: 'Hi' });
    expect([send.status, messageOf(send)], provider).toEqual([404, NOT_CONFIGURED]);
    expect(await campaignRows(p.project.id)).toHaveLength(0);
  }

  await signIn(page, mi.owner);
  for (const p of [mi, apns]) {
    await openPush(page, p.project.id, 'Settings');
    await expect(card(page, 'Connection status').getByText(NOT_CONFIGURED_STATUS, { exact: true })).toBeVisible();
    await expect(card(page, 'Upload credentials')).toBeVisible();
    // The stored credentials cannot be seen or replaced from here.
    await expect(card(page, 'Delivery channels')).toHaveCount(0);
  }
});

test('PUSH-274 reach counts tokens on channels the project cannot send through', async ({ page }) => {
  const p = await pushProject('push-274', { fcm: true });
  const da = await addDevice(p, p.owner.ip);
  const db = await addDevice(p, p.owner.ip, { tokens: 0 });
  const apnsToken = `e2e-apns-${hex()}`;
  expect((await register(p, { deviceFingerprint: db.fingerprint, token: apnsToken, provider: 'apns', platform: 'ios' })).status).toBe(201);
  const dc = await addDevice(p, p.owner.ip);
  const miToken = `e2e-mi-${hex()}`;
  expect((await register(p, { deviceFingerprint: dc.fingerprint, token: miToken, provider: 'mi_push' })).status).toBe(201);
  expect((await call('POST', CHANNEL_CREDENTIALS, p.owner, { projectId: p.project.id, provider: 'mi_push', credentials: miPushCredentials() })).status).toBe(201);

  // Every active token counts: DB's APNs one and both of DC's.
  expect(await projectReach(p.owner, p.project.id)).toBe(4);
  await signIn(page, p.owner);
  await openComposer(page, p.project.id);
  await expect(reachFigure(page)).toHaveText('4');

  // Mi Push has no local stand-in, so its credentials go before the send; DC is then
  // reached through its FCM token.
  await sql(`DELETE FROM push_channel_credentials WHERE project_id = $1 AND provider = 'mi_push'`, [p.project.id]);
  const sent = dataOf(await call('POST', SEND, p.owner, { projectId: p.project.id, title: 'Across channels' }));
  expect(sent.totalTokens).toBe(4);
  await expect
    .poll(async () => (await campaignRow(sent.id))?.status, { timeout: 45_000 })
    .toMatch(/^(sent|partial|failed)$/);
  const row = (await campaignRow(sent.id))!;
  expect(row.total_tokens).toBe(4);
  expect(row.success_count + row.failure_count).toBeLessThanOrEqual(2);
  expect(JSON.stringify(row.failure_details ?? [])).not.toContain(apnsToken);
  const addressed = (await fcmSendsFor(p.fcm!.project_id)).map((c) => (c.body as any)?.message?.token).sort();
  expect(addressed).toEqual([da.tokens[0], dc.tokens[0]].sort());

  await openPush(page, p.project.id);
  await expect(listRow(page, 'Across channels').getByRole('cell').nth(3)).toHaveText(`${row.success_count}/4`);
});

test('PUSH-279 free-form values that are not text break the detail page', async ({ page }) => {
  const p = await pushProject('push-279', { fcm: true });
  await addDevice(p, p.owner.ip);
  const member = await teammate(p.project.id, 'member', p.owner);
  const scheduled = (extra: Record<string, unknown>, title: string) =>
    call('POST', SEND, p.owner, { projectId: p.project.id, title, scheduledAt: inAMonth().toISOString(), ...extra });

  const priority = await scheduled({ deliveryOptions: { priority: { a: 1 } } }, 'Object priority');
  expect(priority.status).toBe(201);
  const translated = await scheduled({ translations: { hi: { title: { a: 1 } } } }, 'Object translation');
  expect(translated.status).toBe(201);
  const plain = await scheduled({}, 'Plain one');
  expect(plain.status).toBe(201);

  await signIn(page, member);
  await page.goto(`/projects/${p.project.id}/push-notifications/${dataOf(plain).id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Plain one' })).toBeVisible();
  // Current behaviour: the page does not render.
  for (const id of [dataOf(priority).id, dataOf(translated).id]) {
    await page.goto(`/projects/${p.project.id}/push-notifications/${id}`);
    await expect(page.getByText('Unexpected Application Error!')).toBeVisible();
    await expect(page.getByText(/Objects are not valid as a React child/).first()).toBeVisible();
  }
  await openPush(page, p.project.id);
  await expect(listRow(page, 'Object priority')).toBeVisible();
  await expect(listRow(page, 'Object translation')).toBeVisible();
});

test('PUSH-286 a failed campaign list looks like an empty list', async ({ page }) => {
  const p = await pushProject('push-286', { fcm: true });
  await seedSentCampaign(p.project.id, 'Exists but unseen');
  let refused = 0;
  await page.route(
    (url) => url.pathname.startsWith('/api/push-notifications/logs/'),
    async (route) => {
      refused += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) });
    },
  );

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  // Current behaviour: after the retry the card reads as if there were no campaigns.
  await expect(card(page, 'Campaigns').getByText('No campaigns yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first campaign' })).toBeVisible();
  expect(refused).toBeGreaterThanOrEqual(2);
  await expect(card(page, 'Campaigns').getByText(/error|could not|unable/i)).toHaveCount(0);
  await expect(page.getByText('Exists but unseen')).toHaveCount(0);
});

test('PUSH-287 a failed config status reads as "not configured"', async ({ page }) => {
  const p = await pushProject('push-287', { fcm: true });
  await addDevice(p, p.owner.ip);
  await page.route(
    (url) => url.pathname.startsWith('/api/push-notifications/config-status/'),
    (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) }),
  );

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  // Current behaviour: nothing says the status could not be loaded.
  await expect(page.getByText(NOT_CONFIGURED_LIST, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New campaign' })).toHaveAttribute('disabled', '');

  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(card(page, 'Connection status').getByText(NOT_CONFIGURED_STATUS, { exact: true })).toBeVisible();
  for (const title of ['Delivery channels', 'Delivery guardrails', 'Reachability']) await expect(card(page, title), title).toHaveCount(0);
  await expect(card(page, 'Upload credentials')).toBeVisible();
  await expect(card(page, 'Replace credentials')).toHaveCount(0);

  await openComposer(page, p.project.id);
  await expect(reachFigure(page)).toHaveText('1');
  await expect(page.getByText(NOT_CONFIGURED_COMPOSER, { exact: true })).toBeVisible();
  await nextButton(page).click();
  await field(card(page, 'Message'), 'Title *').getByRole('textbox').fill('Status unknown');
  await nextButton(page).click();
  await nextButton(page).click();
  await expect(page.getByText('Step 4 of 4 · Check, then send', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send campaign', exact: true })).toBeDisabled();
});

test('PUSH-293 due experiment and timezone parents are cancelled during a suspension', async () => {
  const p = await pushProject('push-293', { fcm: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  await addDevice(p, p.owner.ip, { timezone: 'Asia/Kolkata' });
  await addDevice(p, p.owner.ip, { timezone: 'Europe/London' });
  const at = new Date(Date.now() + 70_000).toISOString();
  const create = async (extra: Record<string, unknown>, title: string) =>
    dataOf(await call('POST', SEND, p.owner, { projectId: p.project.id, title, scheduledAt: at, ...extra })).id as string;
  const ids = [
    await create({ variants: [{ key: 'A', title: 'Arm A', weight: 50 }, { key: 'B', title: 'Arm B', weight: 50 }] }, 'Experiment'),
    await create({ deliverInRecipientTimezone: true, localSendTime: '09:00' }, 'Local time'),
    await create({}, 'Plain'),
  ];
  for (const id of ids) expect((await campaignRow(id))?.status).toBe('scheduled');

  await suspendAccount(p.owner.userId);
  try {
    // Their time passes during the suspension.
    await sql(`UPDATE push_notification_logs SET scheduled_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`, [ids]);
    await tickUntil(async () => {
      const rows = await Promise.all(ids.map((id) => campaignRow(id)));
      return rows.every((row) => row?.status === 'cancelled');
    }, 3);
    for (const id of ids) {
      const read = dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${id}`, admin));
      expect([read.status, read.errorMessage], id).toEqual(['cancelled', MISSED_DURING_SUSPENSION]);
      expect(read.completedAt, id).not.toBeNull();
    }
    const children = await sql(`SELECT id FROM push_notification_logs WHERE parent_campaign_id = ANY($1::uuid[])`, [ids]);
    expect(children).toHaveLength(0);
  } finally {
    await reactivateAccount(p.owner.userId);
  }

  await runPushJob('push-schedule-tick');
  for (const id of ids) expect((await campaignRow(id))?.status).toBe('cancelled');
  expect(await sql(`SELECT id FROM push_notification_logs WHERE parent_campaign_id = ANY($1::uuid[])`, [ids])).toHaveLength(0);
  expect((await campaignRows(p.project.id)).map((row) => row.id).sort()).toEqual([...ids].sort());
});

import { createHmac, randomBytes } from 'crypto';
import { api, apiUrl, newClientIp } from '../../support/api';
import { allowClipboard, readClipboard } from '../../support/browser-tools';
import { connectFakeWhatsAppProvider, fakeTwilioCredentials, fakeWhatsAppCredentials } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import { hubSignature, interaktSignature, publicApiUrl } from '../../support/signing';
import {
  activityRows,
  addMember,
  call,
  campaignRows,
  card,
  consentRows,
  createSegmentIn,
  dataOf,
  erasePerson,
  eventRows,
  gupshupPost,
  handTyped,
  HIDDEN,
  identifyPhone,
  identitySecretOf,
  interaktPost,
  interaktReceived,
  messageOf,
  metaBody,
  metaPost,
  metaReply,
  metaStatus,
  ONLY_OWNERS,
  openSms,
  openViewAs,
  openWhatsApp,
  PEOPLE,
  postJson,
  projectConsentRows,
  PROJECT_NOT_FOUND,
  providerCallsMentioning,
  READ_ONLY,
  ROLE_REFUSAL,
  scheduleSmsCampaign,
  scheduleWhatsAppCampaign,
  seedCampaignRow,
  seedPeople,
  seedSentEvent,
  smsPreview,
  smsProject,
  smsSuppressionList,
  sql,
  suppressionRows,
  suspendAccount,
  teammate,
  toastTitled,
  twilioCallsFor,
  twilioReply,
  twilioStatus,
  twilioWhatsAppPost,
  uniquePhone,
  userHashOf,
  viewAsHandoff,
  waConsentSwitch,
  waPreview,
  waProject,
  waSettingsRow,
  waSummaryLine,
  waSuppressionList,
  waWebhookBlock,
  type WaProject,
} from '../../support/areas/smswa';

/**
 * WhatsApp: the Provider and Consent cards by role and in view-as, suppressions, the
 * composer's reach and a scheduled Interakt campaign, access to every dashboard route, a
 * suspended tenant's campaigns, and the providers' webhooks (Meta's handshake and signed
 * reports, Twilio, Gupshup, Interakt), plus the shared campaign page, the activity log,
 * erasure and device handover across SMS and WhatsApp. Provider connections are seeded;
 * webhooks are signed with the seeded secrets over the exact bytes sent.
 */

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const SIGNATURE_REFUSED = 'Signature did not verify.';
const SUPPRESSED = 'This address is on the project’s suppression list.';
const WA_NOBODY_OPT_IN =
  'Nobody in this audience can be messaged on WhatsApp. It needs a phone number with a country code and, because this project requires opt-in, whatsapp_opt_in set to true.';
const WA_NOBODY_NO_OPT_IN = 'Nobody in this audience has a phone number with a country code that has not opted out.';
const SMS_NOBODY_OPT_IN =
  'Nobody in this audience can be texted. SMS needs a phone number with a country code (+...) and, because this project requires opt-in, sms_opt_in set to true.';
const STOPPED_BY_SUSPENSION =
  'Stopped because this account was suspended. Anyone not yet reached did not receive this campaign, and it will not resume automatically.';
const MISSED_DURING_SUSPENSION =
  'Not sent: this account was suspended when the campaign was due. It will not be sent automatically; schedule it again if it is still wanted.';
const NOT_CONNECTED = 'Not connected. An owner or admin connects providers.';
const AUDIENCE_OPT_IN = 'People with a phone number in international form who have not opted out of WhatsApp, and who opted in.';
const AUDIENCE_NO_OPT_IN = 'People with a phone number in international form who have not opted out of WhatsApp.';
const S1_WA = '919876543210';
const later = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

// ------------------------------------------------------------ J. Provider card ---

test('SMSWA-147 member: no secrets, no forms', async ({ page }) => {
  const p = await waProject('smswa-147', 'twilio');
  const blank = await smsProject('smswa-147-blank', {}, p.owner);
  const member = await teammate(p.project.id, 'member', p.owner);
  await addMember(blank.project.id, member, 'member', p.owner);
  const { accountSid, authToken, sender } = p.wa.credentials;

  await signIn(page, member);
  await openWhatsApp(page, p.project.id, 'Settings');
  await expect(page.getByRole('tab', { name: /^Twilio/ })).toHaveAttribute('aria-selected', 'true');
  await expect(waSummaryLine(page)).toHaveText(`accountSid ${ONLY_OWNERS}, sender ${sender} · secret ending ${authToken.slice(-4)}`);
  for (const label of ['Account SID', 'Auth token', 'WhatsApp sender']) await expect(page.getByLabel(label)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Connect|Replace and use) / })).toHaveCount(0);
  const block = waWebhookBlock(page);
  await expect(block.locator('code')).toHaveText([ONLY_OWNERS]);
  await expect(block.getByRole('button')).toHaveCount(0);
  await expect(waConsentSwitch(page)).toBeDisabled();
  expect(await page.content()).not.toContain(p.wa.webhookToken);
  expect(await page.content()).not.toContain(accountSid);

  await page.getByRole('tab', { name: /^Meta Cloud API/ }).click();
  await expect(page.getByText(NOT_CONNECTED, { exact: true })).toBeVisible();
  await expect(block.getByText('Verify token', { exact: true })).toBeVisible();
  await expect(block.locator('code')).toHaveText([ONLY_OWNERS, ONLY_OWNERS]);
  await expect(page.getByLabel('Phone number ID')).toHaveCount(0);

  const status = await call('GET', `/api/whatsapp/settings/${p.project.id}`, member);
  expect(status.status).toBe(200);
  const body = dataOf(status);
  expect(body.webhookUrls).toEqual({ meta: HIDDEN, twilio_whatsapp: HIDDEN, gupshup: HIDDEN, interakt: HIDDEN });
  expect(body.verifyToken).toBe(HIDDEN);
  expect(body.providers).toEqual([
    expect.objectContaining({ provider: 'twilio_whatsapp', identifiers: { accountSid: HIDDEN, sender }, webhooksSigned: true }),
  ]);
  expect(status.text).not.toContain(p.wa.webhookToken);
  expect(status.text).not.toContain(accountSid);

  await openWhatsApp(page, blank.project.id, 'Settings');
  await expect(page.getByText(NOT_CONNECTED, { exact: true })).toBeVisible();
  await expect(waWebhookBlock(page)).toHaveCount(0);
});

test('SMSWA-149 member cannot connect or change consent through the API', async () => {
  const p = await waProject('smswa-149', 'interakt', { signed: false });
  const member = await teammate(p.project.id, 'member', p.owner);
  const id = p.project.id;
  const before = await waSettingsRow(id);
  const credentials = () => sql(`SELECT provider, credentials_encrypted, updated_at FROM push_channel_credentials WHERE project_id = $1 ORDER BY provider`, [id]);
  const storedBefore = await credentials();
  const meta = fakeWhatsAppCredentials('meta');

  const connect = await call('POST', '/api/whatsapp/providers', member, { projectId: id, provider: 'meta', credentials: JSON.stringify(meta) });
  const consent = await call('POST', '/api/whatsapp/settings', member, { projectId: id, requireOptIn: false });
  expect([connect.status, messageOf(connect)]).toEqual([403, ROLE_REFUSAL]);
  expect([consent.status, messageOf(consent)]).toEqual([403, ROLE_REFUSAL]);

  const after = await waSettingsRow(id);
  expect(after).toMatchObject({ provider: 'interakt', require_opt_in: true });
  expect(after?.updated_at).toEqual(before?.updated_at);
  expect(await credentials()).toEqual(storedBefore);
  expect(await providerCallsMentioning('meta', meta.phoneNumberId)).toHaveLength(0);
  expect(await sql(`SELECT 1 FROM project_activity WHERE project_id = $1 AND action LIKE 'channel.%'`, [id])).toHaveLength(0);
});

test("SMSWA-150 unsigned events only at the current provider's URL", async () => {
  const p = await waProject('smswa-150', 'gupshup');
  await seedPeople(p, p.owner.ip, ['S1', 'S2']);
  const optedOut = (phone: string) => ({ type: 'user-event', payload: { phone, type: 'opted-out' } });

  // While Gupshup is the provider its unsigned opt-out is taken.
  const accepted = await gupshupPost(p.wa.webhookToken, optedOut('14155550111'));
  expect([accepted.status, accepted.body]).toEqual([200, { recorded: 0 }]);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => row.address)).toEqual(['+14155550111']);

  // Switched to Interakt (no webhook secret); Gupshup's credentials stay stored.
  await connectFakeWhatsAppProvider(p.project.id, 'interakt', { signed: false });
  expect(await sql(`SELECT provider FROM push_channel_credentials WHERE project_id = $1 ORDER BY provider`, [p.project.id])).toEqual([
    { provider: 'gupshup' },
    { provider: 'interakt' },
  ]);
  const refused = await gupshupPost(p.wa.webhookToken, optedOut(S1_WA));
  expect([refused.status, messageOf(refused)]).toEqual([403, 'This project no longer sends WhatsApp through gupshup.']);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => row.address)).toEqual(['+14155550111']);
});

// ------------------------------------------------------------ K. Consent card ---

test('SMSWA-152 turning opt-in off on a fresh project creates the settings', async ({ page }) => {
  const p = await smsProject('smswa-152');
  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Settings');
  const toggle = waConsentSwitch(page);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(waWebhookBlock(page)).toHaveCount(0);
  expect(await waSettingsRow(p.project.id)).toBeUndefined();

  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/whatsapp/settings')),
    toggle.click(),
  ]);
  expect(saved.status()).toBe(201);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Could not save', { exact: true })).toHaveCount(0);

  const row = await waSettingsRow(p.project.id);
  expect(row).toMatchObject({ require_opt_in: false, provider: null });
  expect(row?.webhook_token).toMatch(/^[0-9a-f]{48}$/);
  const block = waWebhookBlock(page);
  await expect(block.getByText('Verify token', { exact: true })).toBeVisible();
  await expect(block.locator('code')).toHaveText([publicApiUrl(`/api/whatsapp/webhooks/meta/${row?.webhook_token}`), row?.webhook_token]);

  const logged = await activityRows(p.project.id, 'channel.settings_changed');
  expect(logged.map((entry) => entry.details)).toEqual([{ channel: 'whatsapp', fields: ['requireOptIn'] }]);
  expect(dataOf(await call('GET', `/api/whatsapp/settings/${p.project.id}`, p.owner))).toMatchObject({ configured: true, readyToSend: false });

  await page.getByRole('tab', { name: 'Campaigns', exact: true }).click();
  await expect(page.getByText('WhatsApp is not set up yet. Connect a provider under Settings.', { exact: true })).toBeVisible();
});

test('SMSWA-155 opt-in setting changes reach and wording', async ({ page }) => {
  const p = await waProject('smswa-155', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1', 'S2', 'S3']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/whatsapp/new`);
  await expect(page.getByText(AUDIENCE_OPT_IN, { exact: true })).toBeVisible();
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();

  await openWhatsApp(page, p.project.id, 'Settings');
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/whatsapp/settings')),
    waConsentSwitch(page).click(),
  ]);
  expect(saved.status()).toBe(201);
  await expect(waConsentSwitch(page)).toHaveAttribute('aria-checked', 'false');

  await page.goto(`/projects/${p.project.id}/whatsapp/new`);
  await expect(page.getByText(AUDIENCE_NO_OPT_IN, { exact: true })).toBeVisible();
  // S1 and S2; S3 said no to WhatsApp.
  await expect(page.getByText('2 recipient(s)', { exact: true })).toBeVisible();
  expect(await waPreview(p.owner, p.project.id)).toBe(2);
});

// ------------------------------------------------------------ L. Suppressions ---

test('SMSWA-157 add, invalid and lift a WhatsApp suppression', async ({ page }) => {
  const p = await waProject('smswa-157', 'interakt', { signed: false });
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);

  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Suppressions');
  await expect(page.getByText('Nobody is suppressed.', { exact: true })).toBeVisible();
  const input = page.getByPlaceholder('+14155550123');
  await input.fill('+91 98765 43210');
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  await expect(input).toHaveValue('');
  const row = page.getByRole('row').filter({ hasText: '+919876543210' });
  await expect(row.getByRole('cell').nth(0)).toHaveText('+919876543210');
  await expect(row.getByRole('cell').nth(1)).toHaveText('Added by hand');
  expect(await suppressionRows(p.project.id, 'whatsapp')).toEqual([
    expect.objectContaining({ address: '+919876543210', reason: 'manual', source: 'dashboard' }),
  ]);
  expect((await activityRows(p.project.id, 'suppression.added')).map((entry) => entry.details)).toEqual([
    { channel: 'whatsapp', address: '+91******10' },
  ]);
  expect((await consentRows(S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'dashboard' });

  // 2. A number too short to be one.
  await input.fill('+12');
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/whatsapp/suppressions')),
    page.getByRole('button', { name: 'Suppress', exact: true }).click(),
  ]);
  expect(refused.status()).toBe(400);
  await expect(page.getByText('That is not a valid number', { exact: true })).toBeVisible();
  await expect(page.getByText('Use international form with the country code: +14155550123.', { exact: true })).toBeVisible();
  const api400 = await call('POST', '/api/whatsapp/suppressions', p.owner, { projectId: p.project.id, address: '+12' });
  expect([api400.status, messageOf(api400)]).toEqual([400, 'Enter the number in international form, with its country code.']);

  // 3. Lift it after confirming.
  let message = '';
  page.once('dialog', async (dialog) => {
    message = dialog.message();
    await dialog.accept();
  });
  await row.getByTitle('Resubscribe').click();
  await expect(page.getByText('Nobody is suppressed.', { exact: true })).toBeVisible();
  expect(message).toBe('Message +919876543210 on WhatsApp again? Only do this if they asked to be resubscribed.');
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
  expect((await activityRows(p.project.id, 'suppression.removed')).map((entry) => entry.details)).toEqual([
    { channel: 'whatsapp', address: '+91******10' },
  ]);
  expect((await consentRows(S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: true, source: 'dashboard' });
});

test('SMSWA-161 WhatsApp suppression does not affect SMS', async () => {
  const p = await waProject('smswa-161', 'interakt', { signed: false, twilio: true });
  await seedPeople(p, p.owner.ip, ['S1']);
  expect((await smsPreview(p.owner, p.project.id)).recipients).toBe(1);
  expect(await waPreview(p.owner, p.project.id)).toBe(1);

  const added = await call('POST', '/api/whatsapp/suppressions', p.owner, { projectId: p.project.id, address: PEOPLE.S1.phone });
  expect(added.status).toBe(201);
  expect((await smsPreview(p.owner, p.project.id)).recipients).toBe(1);
  expect(await waPreview(p.owner, p.project.id)).toBe(0);
  expect(await smsSuppressionList(p.owner, p.project.id)).toEqual({ data: [], total: 0 });
  expect((await waSuppressionList(p.owner, p.project.id)).data.map((row) => row.address)).toEqual([PEOPLE.S1.phone]);
});

// ------------------------------------------------------------ M. Composer ---

test('SMSWA-165 send an Interakt campaign scheduled ahead', async ({ page }) => {
  const p = await waProject('smswa-165', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/whatsapp/new`);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByPlaceholder('order_update', { exact: true }).fill('order_update');
  await expect(page.getByPlaceholder('en', { exact: true })).toHaveValue('en');
  await page.getByText('Number of values', { exact: true }).locator('..').locator('input').fill('1');
  await page.getByPlaceholder('{{firstName|there}}', { exact: true }).fill('{{firstName|there}}');

  await page.getByText('Schedule for later', { exact: true }).locator('..').getByRole('switch').click();
  const schedule = page.getByRole('button', { name: 'Schedule campaign' });
  await expect(schedule).toBeDisabled();
  await page.getByRole('button', { name: 'Pick date & time' }).click();
  await page.getByRole('button', { name: /next month/i }).click();
  await page.getByRole('gridcell', { name: '15' }).getByRole('button').click();
  await page.locator('input[type="time"]').first().fill('10:30');
  await page.keyboard.press('Escape');
  await expect(schedule).toBeEnabled();

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/whatsapp/send') && r.request().method() === 'POST'),
    schedule.click(),
  ]);
  expect(response.status()).toBe(201);
  await expect(page.getByText('Campaign scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('1 recipient(s).', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/whatsapp$`));
  await expect(page.getByRole('row').filter({ hasText: 'order_update' })).toContainText('Scheduled');

  const rows = await campaignRows(p.project.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ channel: 'whatsapp', title: 'order_update', body: 'Template order_update (en)', status: 'scheduled', total_tokens: 1 });
  expect(rows[0].whatsapp_content).toMatchObject({
    template: { id: 'order_update', name: 'order_update', language: 'en', category: null, paramNames: null },
    bodyParams: ['{{firstName|there}}'],
  });
  expect(await activityRows(p.project.id, 'campaign.scheduled')).toHaveLength(1);
});

test('SMSWA-182 send refused when nobody can be messaged or nothing is set up', async () => {
  const p = await waProject('smswa-182', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S3']);
  const send = (projectId: string) => call('POST', '/api/whatsapp/send', p.owner, { projectId, content: handTyped() });

  const optIn = await send(p.project.id);
  expect([optIn.status, messageOf(optIn)]).toEqual([400, WA_NOBODY_OPT_IN]);
  expect((await call('POST', '/api/whatsapp/settings', p.owner, { projectId: p.project.id, requireOptIn: false })).status).toBe(201);
  const noOptIn = await send(p.project.id);
  expect([noOptIn.status, messageOf(noOptIn)]).toEqual([400, WA_NOBODY_NO_OPT_IN]);

  const blank = await smsProject('smswa-182-blank', {}, p.owner);
  const notSetUp = await send(blank.project.id);
  expect([notSetUp.status, messageOf(notSetUp)]).toEqual([404, 'WhatsApp is not set up for this project. Connect a provider in WhatsApp settings.']);

  const rowOnly = await smsProject('smswa-182-row', {}, p.owner);
  expect((await call('POST', '/api/whatsapp/settings', p.owner, { projectId: rowOnly.project.id })).status).toBe(201);
  const noProvider = await send(rowOnly.project.id);
  expect([noProvider.status, messageOf(noProvider)]).toEqual([400, 'Connect a WhatsApp provider in WhatsApp settings before sending.']);

  for (const id of [p.project.id, blank.project.id, rowOnly.project.id]) expect(await campaignRows(id)).toHaveLength(0);
});

// ------------------------------------------------------------ N. Access ---

test('SMSWA-189 outsider, malformed id and anonymous', async () => {
  const p = await waProject('smswa-189', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  const id = p.project.id;
  expect((await call('POST', '/api/whatsapp/suppressions', p.owner, { projectId: id, address: '+14155550199' })).status).toBe(201);
  const outsider = await smsProject('smswa-189-outsider');
  const before = await waSettingsRow(id);

  const routes: Array<[string, string, unknown?]> = [
    ['GET', `/api/whatsapp/settings/${id}`],
    ['POST', '/api/whatsapp/settings', { projectId: id, requireOptIn: false }],
    ['POST', '/api/whatsapp/providers', { projectId: id, provider: 'interakt', credentials: JSON.stringify(fakeWhatsAppCredentials('interakt')) }],
    ['GET', `/api/whatsapp/templates/${id}`],
    ['POST', '/api/whatsapp/audience-preview', { projectId: id }],
    ['POST', '/api/whatsapp/send', { projectId: id, content: handTyped(), scheduledAt: later() }],
    ['POST', '/api/whatsapp/test-send', { projectId: id, to: '+14155550111', content: handTyped() }],
    ['GET', `/api/whatsapp/suppressions/${id}`],
    ['POST', '/api/whatsapp/suppressions', { projectId: id, address: '+14155550177' }],
    ['DELETE', `/api/whatsapp/suppressions/${id}/${encodeURIComponent('+14155550199')}`],
    ['GET', '/api/whatsapp/settings/abc'],
  ];
  for (const [method, path, body] of routes) {
    const answered = await call(method, path, outsider.owner, body);
    expect(`${method} ${path} ${answered.status} ${messageOf(answered)}`).toBe(`${method} ${path} 404 ${PROJECT_NOT_FOUND}`);
  }
  const anonymous = await call('GET', `/api/whatsapp/settings/${id}`, null);
  expect(anonymous.status).toBe(401);

  const after = await waSettingsRow(id);
  expect(after).toMatchObject({ require_opt_in: true, provider: 'interakt' });
  expect(after?.updated_at).toEqual(before?.updated_at);
  expect((await suppressionRows(id, 'whatsapp')).map((row) => row.address)).toEqual(['+14155550199']);
  expect(await campaignRows(id)).toHaveLength(0);
});

test('SMSWA-190 member allowed to message, refused channel settings', async () => {
  const p = await waProject('smswa-190', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  const member = await teammate(p.project.id, 'member', p.owner);
  const id = p.project.id;
  expect((await call('POST', '/api/whatsapp/suppressions', p.owner, { projectId: id, address: '+14155550199' })).status).toBe(201);

  const preview = await call('POST', '/api/whatsapp/audience-preview', member, { projectId: id });
  expect([preview.status, dataOf(preview).recipients]).toEqual([201, 1]);
  const send = await scheduleWhatsAppCampaign(member, id);
  expect(send.status).toBe(201);
  expect(dataOf(send)).toMatchObject({ channel: 'whatsapp', status: 'scheduled' });
  const testSend = await call('POST', '/api/whatsapp/test-send', member, { projectId: id, to: '+14155550199', content: handTyped() });
  expect([testSend.status, dataOf(testSend)]).toEqual([201, { delivered: false, error: SUPPRESSED }]);
  const add = await call('POST', '/api/whatsapp/suppressions', member, { projectId: id, address: '+14155550177' });
  expect([add.status, dataOf(add)]).toEqual([201, { suppressed: true }]);
  const lift = await call('DELETE', `/api/whatsapp/suppressions/${id}/${encodeURIComponent('+14155550177')}`, member);
  expect([lift.status, dataOf(lift)]).toEqual([200, { removed: true }]);
  const templates = await call('GET', `/api/whatsapp/templates/${id}`, member);
  expect([templates.status, dataOf(templates)]).toEqual([200, { canList: false, templates: [] }]);

  const settings = await call('POST', '/api/whatsapp/settings', member, { projectId: id, requireOptIn: false });
  expect([settings.status, messageOf(settings)]).toEqual([403, ROLE_REFUSAL]);
  const providers = await call('POST', '/api/whatsapp/providers', member, {
    projectId: id,
    provider: 'interakt',
    credentials: JSON.stringify(fakeWhatsAppCredentials('interakt')),
  });
  expect([providers.status, messageOf(providers)]).toEqual([403, ROLE_REFUSAL]);
  expect((await waSettingsRow(id))?.require_opt_in).toBe(true);
});

test('SMSWA-191 view-as on the WhatsApp pages', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await waProject('smswa-191', 'meta');
  await seedPeople(p, p.owner.ip, ['S1']);
  const id = p.project.id;
  const before = await waSettingsRow(id);
  const credentials = () => sql(`SELECT provider, credentials_encrypted, updated_at FROM push_channel_credentials WHERE project_id = $1`, [id]);
  const storedBefore = await credentials();
  const url = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, url);
  await allowClipboard(page);

  // 1. Settings: URL and verify token withheld, Meta's identifiers shown.
  await openWhatsApp(page, id, 'Settings');
  await expect(page.getByRole('tab', { name: /^Meta Cloud API/ })).toHaveAttribute('aria-selected', 'true');
  const block = waWebhookBlock(page);
  await expect(block.locator('code')).toHaveText([HIDDEN, HIDDEN]);
  const { phoneNumberId, businessAccountId, accessToken } = p.wa.credentials;
  await expect(waSummaryLine(page)).toHaveText(`phoneNumberId ${phoneNumberId}, businessAccountId ${businessAccountId} · secret ending ${accessToken.slice(-4)}`);
  await block.getByRole('button').first().click();
  await expect.poll(() => readClipboard(page)).toBe(HIDDEN);
  expect(await page.content()).not.toContain(p.wa.webhookToken);

  // 2. Consent toggle refused.
  const [toggled] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/whatsapp/settings')),
    waConsentSwitch(page).click(),
  ]);
  expect(toggled.status()).toBe(403);
  await expect(toastTitled(page, 'Read-only session').first()).toBeVisible();
  await expect(toastTitled(page, 'Could not save')).toContainText(READ_ONLY);
  await expect(waConsentSwitch(page)).toHaveAttribute('aria-checked', 'true');

  // 3. Connect refused whatever was typed.
  await page.getByLabel('Phone number ID', { exact: true }).fill('not a number');
  await page.getByLabel('WhatsApp Business Account ID', { exact: true }).fill('x');
  await page.getByLabel('Access token', { exact: true }).fill('y');
  const [connect] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/whatsapp/providers')),
    page.getByRole('button', { name: 'Replace and use Meta Cloud API' }).click(),
  ]);
  expect(connect.status()).toBe(403);
  await expect(toastTitled(page, 'Could not connect')).toContainText(READ_ONLY);

  // 4. Adding a suppression refused.
  await openWhatsApp(page, id, 'Suppressions');
  await page.getByPlaceholder('+14155550123').fill('+14155550177');
  const [suppress] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/whatsapp/suppressions')),
    page.getByRole('button', { name: 'Suppress', exact: true }).click(),
  ]);
  expect(suppress.status()).toBe(403);
  await expect(page.getByText('That is not a valid number', { exact: true })).toBeVisible();
  await expect(page.getByText('Read-only session', { exact: true }).first()).toBeVisible();

  // 5. The composer reads templates but its reach count (a POST) is refused.
  const templatesAnswer = page.waitForResponse((r) => r.url().includes(`/api/whatsapp/templates/${id}`));
  const previewAnswer = page.waitForResponse((r) => r.url().endsWith('/api/whatsapp/audience-preview'));
  await page.goto(`/projects/${id}/whatsapp/new`);
  expect((await templatesAnswer).status()).toBe(200);
  expect((await previewAnswer).status()).toBe(403);
  await expect(page.getByText('Read-only session', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Choose an audience to see its reach.', { exact: true })).toBeVisible();

  const after = await waSettingsRow(id);
  expect(after?.updated_at).toEqual(before?.updated_at);
  expect(after?.require_opt_in).toBe(true);
  expect(await credentials()).toEqual(storedBefore);
  expect(await suppressionRows(id, 'whatsapp')).toHaveLength(0);
  expect(await campaignRows(id)).toHaveLength(0);
});

test('SMSWA-192 WhatsApp campaign stopped by suspension', async () => {
  test.setTimeout(180_000);
  const p = await waProject('smswa-192', 'interakt', { signed: false });
  const phone = uniquePhone();
  await identifyPhone(p, p.owner.ip, { phone, whatsappOptIn: true });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const due = dataOf(await scheduleWhatsAppCampaign(p.owner, p.project.id));

  await suspendAccount(p.owner.userId);
  await sql(`UPDATE push_notification_logs SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [due.id]);
  const queued = await call('POST', '/api/whatsapp/send', admin, { projectId: p.project.id, content: handTyped() });
  expect(queued.status).toBe(201);
  expect(dataOf(queued).status).toBe('queued');

  const campaign = async (campaignId: string) => dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${campaignId}`, admin));
  await expect.poll(async () => (await campaign(dataOf(queued).id)).status, { timeout: 60_000 }).toBe('failed');
  expect((await campaign(dataOf(queued).id)).errorMessage).toBe(STOPPED_BY_SUSPENSION);
  await expect.poll(async () => (await campaign(due.id)).status, { timeout: 100_000, intervals: [2_000] }).toBe('cancelled');
  expect((await campaign(due.id)).errorMessage).toBe(MISSED_DURING_SUSPENSION);
  expect(await providerCallsMentioning('interakt', phone.slice(3))).toHaveLength(0);
});

// ------------------------------------------------------------ O. Webhooks ---

test('SMSWA-193 Meta handshake succeeds with the verify token', async () => {
  const p = await waProject('smswa-193', 'meta');
  const t = p.wa.webhookToken;
  const answered = await call('GET', `/api/whatsapp/webhooks/meta/${t}?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=1158201444`, null);
  expect(answered.status).toBe(200);
  expect(answered.headers.get('content-type')).toMatch(/^text\/plain/);
  expect(answered.text).toBe('1158201444');
});

test('SMSWA-194 Meta handshake refusals', async () => {
  const p = await waProject('smswa-194', 'meta');
  const t = p.wa.webhookToken;
  const handshake = (token: string, query: string) => call('GET', `/api/whatsapp/webhooks/meta/${token}?${query}`, null);
  const unknown = randomBytes(24).toString('hex');
  const refused = [
    await handshake(t, `hub.mode=unsubscribe&hub.verify_token=${t}&hub.challenge=1`),
    await handshake(t, `hub.mode=subscribe&hub.verify_token=${unknown}&hub.challenge=1`),
    await handshake(unknown, `hub.mode=subscribe&hub.verify_token=${unknown}&hub.challenge=1`),
    await handshake('abc', 'hub.mode=subscribe&hub.verify_token=abc&hub.challenge=1'),
  ];
  expect(refused.map((r) => r.status)).toEqual([403, 403, 403, 403]);
  const noChallenge = await handshake(t, `hub.mode=subscribe&hub.verify_token=${t}`);
  expect([noChallenge.status, noChallenge.text]).toEqual([200, '']);
});

test('SMSWA-195 unknown provider or token', async () => {
  const p = await waProject('smswa-195', 'meta');
  const raw = JSON.stringify({ entry: [] });
  const paths = [
    `/api/whatsapp/webhooks/telegram/${p.wa.webhookToken}`,
    `/api/whatsapp/webhooks/meta/${randomBytes(24).toString('hex')}`,
    '/api/whatsapp/webhooks/meta/abc',
  ];
  for (const path of paths) {
    const answered = await postJson(path, raw, { 'X-Hub-Signature-256': hubSignature(p.wa.credentials.appSecret!, raw) });
    expect(`${path} ${answered.status}`).toBe(`${path} 404`);
  }
});

test('SMSWA-197 Meta signed delivery report', async () => {
  const p = await waProject('smswa-197', 'meta');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const c = await seedCampaignRow(p.project.id, 'whatsapp');
  const at = Math.floor(Date.now() / 1000) - 120;
  const value = { statuses: [metaStatus(S1_WA, 'delivered', { c, i: S1 }, { timestamp: String(at) })] };

  const first = await metaPost(p.wa, value);
  const repeat = await metaPost(p.wa, value);
  expect([first.status, first.body]).toEqual([200, { recorded: 1 }]);
  expect([repeat.status, repeat.body]).toEqual([200, { recorded: 1 }]);
  const events = await eventRows(p.project.id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'delivered', platform: 'whatsapp', campaign_id: c, device_identity_id: S1 });
  expect(new Date(events[0].occurred_at).getTime()).toBe(at * 1000);
});

test('SMSWA-198 Meta bad signature', async () => {
  const p = await waProject('smswa-198', 'meta');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const c = await seedCampaignRow(p.project.id, 'whatsapp');
  const value = {
    statuses: [metaStatus(S1_WA, 'failed', { c, i: S1 }, { errors: [{ code: 131026, title: 'Undeliverable' }] })],
    messages: [metaReply(S1_WA, 'STOP')],
  };
  const secret = p.wa.credentials.appSecret!;
  const right = hubSignature(secret, metaBody(value));
  const attempts = [
    await metaPost(p.wa, value, null),
    await metaPost(p.wa, value, hubSignature(secret, JSON.stringify({ entry: [] }))),
    // The right digest of the exact body, under another scheme's name.
    await metaPost(p.wa, value, right.replace('sha256=', 'sha1=')),
    await metaPost(p.wa, value, `sha1=${createHmac('sha1', secret).update(metaBody(value), 'utf8').digest('hex')}`),
  ];
  expect(attempts.map((a) => [a.status, messageOf(a)])).toEqual(Array(4).fill([401, SIGNATURE_REFUSED]));
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
  expect(await eventRows(p.project.id)).toHaveLength(0);
  // Signed over the bytes sent, the same body is taken.
  expect((await metaPost(p.wa, value)).status).toBe(200);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(1);
});

test('SMSWA-200 Meta failure codes that suppress', async () => {
  const p = await waProject('smswa-200', 'meta');
  const people: Record<string, string> = { '131050': '+14155550211', '130403': '+14155550212', '131026': '+14155550213' };
  const ids: Record<string, string> = {};
  for (const [code, phone] of Object.entries(people)) ids[code] = await identifyPhone(p, p.owner.ip, { phone, whatsappOptIn: true });
  const before = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([code, id]) => [code, (await consentRows(id)).length])));

  const answered = await metaPost(p.wa, {
    statuses: Object.entries(people).map(([code, phone]) => metaStatus(phone.slice(1), 'failed', {}, { errors: [{ code: Number(code), title: `Meta ${code}` }] })),
  });
  expect([answered.status, answered.body]).toEqual([200, { recorded: 0 }]);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => [row.address, row.reason, row.source, row.detail])).toEqual([
    ['+14155550211', 'unsubscribed', 'meta', 'Meta 131050'],
    ['+14155550212', 'unsubscribed', 'meta', 'Meta 130403'],
    ['+14155550213', 'bounced', 'meta', 'Meta 131026'],
  ]);
  for (const code of ['131050', '130403']) {
    const history = await consentRows(ids[code]);
    expect(history.slice(before[code])).toEqual([{ channel: 'whatsapp', granted: false, source: 'stop_reply' }]);
  }
  expect((await consentRows(ids['131026'])).length).toBe(before['131026']);
});

test('SMSWA-201 Meta replies: STOP and START (signed)', async () => {
  const p = await waProject('smswa-201', 'meta');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);

  const stop = await metaPost(p.wa, { messages: [metaReply(S1_WA, 'Stop', Math.floor(Date.now() / 1000))] });
  expect([stop.status, stop.body]).toEqual([200, { recorded: 0 }]);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toEqual([
    expect.objectContaining({ address: '+919876543210', reason: 'unsubscribed', source: 'meta', detail: 'Replied "Stop"' }),
  ]);
  expect((await consentRows(S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply' });
  expect(await waPreview(p.owner, p.project.id)).toBe(0);

  // No timestamp: the START is read at the API's own time, after the STOP was stored.
  const start = await metaPost(p.wa, { messages: [metaReply(S1_WA, 'START')] });
  expect(start.status).toBe(200);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
  expect((await consentRows(S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: true, source: 'start_reply' });
  expect(await waPreview(p.owner, p.project.id)).toBe(1);
});

test('SMSWA-205 Meta without app secret: unsigned and corroborated', async () => {
  const p = await waProject('smswa-205', 'meta', { signed: false });
  const { S1, S2 } = await seedPeople(p, p.owner.ip, ['S1', 'S2']);
  const c = await seedCampaignRow(p.project.id, 'whatsapp');

  const unknown = await metaPost(p.wa, { messages: [metaReply('15550000000', 'STOP')] });
  expect([unknown.status, unknown.body]).toEqual([200, { recorded: 0 }]);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);

  expect((await metaPost(p.wa, { messages: [metaReply(S1_WA, 'STOP')] })).status).toBe(200);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => [row.address, row.reason])).toEqual([['+919876543210', 'unsubscribed']]);
  expect((await consentRows(S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply_unsigned' });

  expect((await metaPost(p.wa, { messages: [metaReply(S1_WA, 'START')] })).status).toBe(200);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => row.address)).toEqual(['+919876543210']);

  const mismatched = await metaPost(p.wa, { statuses: [metaStatus(S1_WA, 'delivered', { c, i: S2 })] });
  expect([mismatched.status, mismatched.body]).toEqual([200, { recorded: 0 }]);
  expect(await eventRows(p.project.id)).toHaveLength(0);
  // Tagged with S1's own identity the same report counts.
  const matched = await metaPost(p.wa, { statuses: [metaStatus(S1_WA, 'delivered', { c, i: S1 })] });
  expect(matched.body).toEqual({ recorded: 1 });
});

test('SMSWA-206 Twilio WhatsApp signed status and reply', async () => {
  const p = await waProject('smswa-206', 'twilio');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const c = await seedCampaignRow(p.project.id, 'whatsapp');
  const sid = p.wa.credentials.accountSid;

  const read = await twilioWhatsAppPost(p.wa, { MessageStatus: 'read', To: 'whatsapp:+919876543210', AccountSid: sid }, { c, i: S1 });
  expect(read.status).toBe(200);
  expect(read.headers.get('content-type')).toMatch(/^text\/xml/);
  expect(read.text).toBe(EMPTY_TWIML);
  expect((await eventRows(p.project.id)).map((e) => [e.type, e.campaign_id, e.device_identity_id])).toEqual([['impression', c, S1]]);

  const stop = await twilioWhatsAppPost(p.wa, { From: 'whatsapp:+919876543210', Body: 'STOP', AccountSid: sid });
  expect([stop.status, stop.text]).toEqual([200, EMPTY_TWIML]);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => [row.address, row.reason])).toEqual([['+919876543210', 'unsubscribed']]);

  const other = { From: 'whatsapp:+14155550111', Body: 'STOP', AccountSid: sid };
  const badSignature = await twilioWhatsAppPost(p.wa, other, {}, { authToken: randomBytes(16).toString('hex') });
  const foreignAccount = await twilioWhatsAppPost(p.wa, { ...other, AccountSid: fakeTwilioCredentials().accountSid });
  expect([badSignature.status, messageOf(badSignature)]).toEqual([401, SIGNATURE_REFUSED]);
  expect([foreignAccount.status, messageOf(foreignAccount)]).toEqual([401, SIGNATURE_REFUSED]);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => row.address)).toEqual(['+919876543210']);
});

test('SMSWA-208 Gupshup: unsigned, corroborated, attributed by recency', async () => {
  const p = await waProject('smswa-208', 'gupshup');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const c = await seedCampaignRow(p.project.id, 'whatsapp', 'C');
  const cOld = await seedCampaignRow(p.project.id, 'whatsapp', 'C-old');
  await seedSentEvent(p.project.id, c, S1, 2);
  await seedSentEvent(p.project.id, cOld, S1, 10);

  const delivered = await gupshupPost(p.wa.webhookToken, { type: 'message-event', payload: { type: 'delivered', destination: S1_WA } });
  expect([delivered.status, delivered.body]).toEqual([200, { recorded: 1 }]);
  expect((await eventRows(p.project.id)).filter((e) => e.type === 'delivered').map((e) => [e.campaign_id, e.device_identity_id])).toEqual([[c, S1]]);

  const optedOut = await gupshupPost(p.wa.webhookToken, { type: 'user-event', payload: { phone: S1_WA, type: 'opted-out' } });
  expect(optedOut.status).toBe(200);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => [row.address, row.reason])).toEqual([['+919876543210', 'unsubscribed']]);
  expect((await consentRows(S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply_unsigned' });

  const start = await gupshupPost(p.wa.webhookToken, { type: 'message', payload: { sender: { phone: S1_WA }, payload: { text: 'START' } } });
  expect(start.status).toBe(200);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => row.address)).toEqual(['+919876543210']);

  const stranger = await gupshupPost(p.wa.webhookToken, { type: 'message', payload: { sender: { phone: '15550000000' }, payload: { text: 'STOP' } } });
  expect([stranger.status, stranger.body]).toEqual([200, { recorded: 0 }]);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => row.address)).toEqual(['+919876543210']);
});

test('SMSWA-210 Interakt signed and unsigned', async () => {
  const p = await waProject('smswa-210', 'interakt');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1', 'S2']);
  const c = await seedCampaignRow(p.project.id, 'whatsapp');
  const deliveredBody = {
    type: 'message_api_delivered',
    timestamp: '2026-11-15T10:00:00',
    data: { customer: { channel_phone_number: S1_WA }, message: { meta_data: { source_data: { callback_data: JSON.stringify({ c, i: S1 }) } } } },
  };

  const delivered = await interaktPost(p.wa, deliveredBody);
  expect([delivered.status, delivered.body]).toEqual([200, { recorded: 1 }]);
  const [event] = await eventRows(p.project.id);
  expect(event).toMatchObject({ type: 'delivered', campaign_id: c, device_identity_id: S1 });
  expect(new Date(event.occurred_at).toISOString()).toBe('2026-11-15T10:00:00.000Z');

  // A bad signature: the exact bytes sent, under a secret that is not the stored one.
  const stopBody = interaktReceived(S1_WA, 'STOP');
  const forged = await interaktPost(p.wa, stopBody, interaktSignature(randomBytes(16).toString('hex'), JSON.stringify(stopBody)));
  const unsignedAtSigned = await interaktPost(p.wa, stopBody, null);
  expect([forged.status, messageOf(forged)]).toEqual([401, SIGNATURE_REFUSED]);
  expect([unsignedAtSigned.status, messageOf(unsignedAtSigned)]).toEqual([401, SIGNATURE_REFUSED]);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
  expect(await eventRows(p.project.id)).toHaveLength(1);

  expect((await interaktPost(p.wa, interaktReceived(S1_WA, 'STOP'))).status).toBe(200);
  const failed = await interaktPost(p.wa, {
    type: 'message_api_failed',
    data: { customer: { channel_phone_number: '14155550111' }, message: { channel_error_code: 1013, channel_failure_reason: 'not on WhatsApp' } },
  });
  expect(failed.status).toBe(200);
  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => [row.address, row.reason, row.source, row.detail])).toEqual([
    ['+14155550111', 'bounced', 'interakt', 'not on WhatsApp'],
    ['+919876543210', 'unsubscribed', 'interakt', 'Replied "STOP"'],
  ]);

  const unsigned = await waProject('smswa-210-unsigned', 'interakt', { signed: false }, p.owner);
  await seedPeople(unsigned, p.owner.ip, ['S1']);
  expect((await interaktPost(unsigned.wa, interaktReceived(S1_WA, 'STOP'))).status).toBe(200);
  expect((await interaktPost(unsigned.wa, interaktReceived(S1_WA, 'START'))).status).toBe(200);
  expect((await suppressionRows(unsigned.project.id, 'whatsapp')).map((row) => [row.address, row.reason])).toEqual([['+919876543210', 'unsubscribed']]);
});

test("SMSWA-211 reports for another project's campaign", async () => {
  const p = await waProject('smswa-211', 'meta');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const other = await waProject('smswa-211-other', 'meta');
  const c2 = await seedCampaignRow(other.project.id, 'whatsapp');

  const foreign = await metaPost(p.wa, { statuses: [metaStatus(S1_WA, 'delivered', { c: c2, i: S1 })] });
  expect([foreign.status, foreign.body]).toEqual([200, { recorded: 0 }]);
  expect(await eventRows(p.project.id)).toHaveLength(0);
  expect(await eventRows(other.project.id)).toHaveLength(0);

  const mine = await seedCampaignRow(p.project.id, 'whatsapp');
  const own = await metaPost(p.wa, { statuses: [metaStatus(S1_WA, 'delivered', { c: mine, i: S1 })] });
  expect(own.body).toEqual({ recorded: 1 });
  expect(await eventRows(other.project.id)).toHaveLength(0);
});

// ------------------------------------------------------------ P. Campaign detail ---

test("SMSWA-220 detail of another project's campaign", async ({ page }) => {
  const p = await smsProject('smswa-220', { twilio: true });
  const other = await smsProject('smswa-220-other', { twilio: true });
  await seedPeople(other, other.owner.ip, ['S2']);
  const theirs = await scheduleSmsCampaign(other.owner, other.project.id, 'Their campaign');

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${theirs.id}`);
  await expect(page.getByText(/^Campaign not found\. It may have been deleted/)).toBeVisible();
  await expect(page.getByText('Their campaign')).toHaveCount(0);

  const underMine = await call('GET', `/api/push-notifications/campaign/${p.project.id}/${theirs.id}`, p.owner);
  expect([underMine.status, messageOf(underMine)]).toEqual([404, 'Campaign not found for this project']);
  const underTheirs = await call('GET', `/api/push-notifications/campaign/${other.project.id}/${theirs.id}`, p.owner);
  expect([underTheirs.status, messageOf(underTheirs)]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(underTheirs.text).not.toContain('Their campaign');
});

// ------------------------------------------------------------ Q. Cross-cutting ---

test('SMSWA-224 activity entries never carry secrets or full numbers', async () => {
  const p = await smsProject('smswa-224', { sender: true });
  const id = p.project.id;
  await seedPeople(p, p.owner.ip, ['S2']);
  const twilio = fakeTwilioCredentials();
  const interakt = fakeWhatsAppCredentials('interakt');
  const ok = async (method: string, path: string, body?: unknown) => {
    const answered = await call(method, path, p.owner, body);
    expect(`${method} ${path} ${answered.status}`).toMatch(/ 20[01]$/);
    return answered;
  };

  // SMS: settings, Twilio, a suppression added and lifted, a text scheduled and one sent now.
  await ok('POST', '/api/sms/settings', { projectId: id, sender: '+14155550123', optOutText: 'Text STOP to end.' });
  await ok('POST', '/api/sms/providers', { projectId: id, provider: 'twilio', credentials: JSON.stringify(twilio) });
  await ok('POST', '/api/sms/suppressions', { projectId: id, address: '+919876543210' });
  await ok('DELETE', `/api/sms/suppressions/${id}/${encodeURIComponent('+919876543210')}`);
  await ok('POST', '/api/sms/send', { projectId: id, body: 'Secret sale text for later', scheduledAt: later() });
  await ok('POST', '/api/sms/send', { projectId: id, body: 'Secret sale text right now' });
  // WhatsApp: consent off, Interakt connected, a suppression added and lifted, a campaign scheduled.
  await ok('POST', '/api/whatsapp/settings', { projectId: id, requireOptIn: false });
  await ok('POST', '/api/whatsapp/providers', { projectId: id, provider: 'interakt', credentials: JSON.stringify(interakt) });
  await ok('POST', '/api/whatsapp/suppressions', { projectId: id, address: '+447700900123' });
  await ok('DELETE', `/api/whatsapp/suppressions/${id}/${encodeURIComponent('+447700900123')}`);
  await ok('POST', '/api/whatsapp/send', { projectId: id, content: handTyped('secret_offer', ['Secret value text']), scheduledAt: later() });

  const page = dataOf(await call('GET', `/api/projects/${id}/activity`, p.owner));
  const actions = new Set((page.entries as Array<{ action: string }>).map((entry) => entry.action));
  for (const action of [
    'channel.settings_changed',
    'channel.provider_changed',
    'suppression.added',
    'suppression.removed',
    'campaign.sent',
    'campaign.scheduled',
  ]) {
    expect(actions.has(action), action).toBe(true);
  }
  const text = JSON.stringify(page);
  const smsToken = (await sql(`SELECT webhook_token FROM sms_settings WHERE project_id = $1`, [id]))[0].webhook_token;
  const waToken = (await waSettingsRow(id))?.webhook_token;
  const forbidden = [
    twilio.authToken,
    twilio.accountSid,
    interakt.apiKey,
    interakt.webhookSecret!,
    smsToken,
    waToken,
    '/webhooks/',
    '+919876543210',
    '9876543210',
    '+447700900123',
    '7700900123',
    PEOPLE.S2.phone!,
    'Secret sale text',
    'Secret value text',
  ];
  for (const value of forbidden) expect(text.includes(value), `activity carries ${value}`).toBe(false);
  expect(text).toContain('+91******10');
  expect(text).toContain('+44******23');
});

// ------------------------------------------------------------ R. Second pass ---

test('SMSWA-226 signed START lifts a WhatsApp STOP on Twilio WhatsApp and Interakt', async () => {
  const people = async (p: WaProject) => {
    const ids: Record<string, string> = {};
    ids.S1 = await identifyPhone(p, p.owner.ip, PEOPLE.S1);
    ids.manual = await identifyPhone(p, p.owner.ip, { phone: '+14155550122', whatsappOptIn: true });
    ids.bounced = await identifyPhone(p, p.owner.ip, { phone: '+14155550133', whatsappOptIn: true });
    for (const [address, reason] of [['+14155550122', 'manual'], ['+14155550133', 'bounced']]) {
      const added = await call('POST', '/api/whatsapp/suppressions', p.owner, { projectId: p.project.id, address, reason });
      expect(added.status).toBe(201);
    }
    return ids;
  };
  const kept = [
    ['+14155550122', 'manual'],
    ['+14155550133', 'bounced'],
  ];

  // Twilio WhatsApp.
  const tw = await waProject('smswa-226-twilio', 'twilio', { twilio: true });
  const twIds = await people(tw);
  const sid = tw.wa.credentials.accountSid;
  const stop = await twilioWhatsAppPost(tw.wa, { From: 'whatsapp:+919876543210', Body: 'STOP', AccountSid: sid });
  expect([stop.status, stop.text]).toEqual([200, EMPTY_TWIML]);
  expect(await suppressionRows(tw.project.id, 'whatsapp')).toContainEqual(
    expect.objectContaining({ address: '+919876543210', reason: 'unsubscribed', source: 'twilio_whatsapp', detail: 'Replied "STOP"' }),
  );
  expect((await consentRows(twIds.S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply' });
  expect(await waPreview(tw.owner, tw.project.id)).toBe(0);
  const otherHistory = { manual: (await consentRows(twIds.manual)).length, bounced: (await consentRows(twIds.bounced)).length };

  const start = await twilioWhatsAppPost(tw.wa, { From: 'whatsapp:+919876543210', Body: 'START', AccountSid: sid });
  expect([start.status, start.text]).toEqual([200, EMPTY_TWIML]);
  for (const from of ['+14155550122', '+14155550133']) {
    expect((await twilioWhatsAppPost(tw.wa, { From: `whatsapp:${from}`, Body: 'START', AccountSid: sid })).status).toBe(200);
  }
  expect((await suppressionRows(tw.project.id, 'whatsapp')).map((row) => [row.address, row.reason])).toEqual(kept);
  expect((await consentRows(twIds.S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: true, source: 'start_reply' });
  expect((await consentRows(twIds.manual)).length).toBe(otherHistory.manual);
  expect((await consentRows(twIds.bounced)).length).toBe(otherHistory.bounced);
  expect(await waPreview(tw.owner, tw.project.id)).toBe(1);
  expect(await suppressionRows(tw.project.id, 'sms')).toHaveLength(0);

  // Interakt, signed.
  const ik = await waProject('smswa-226-interakt', 'interakt', {}, tw.owner);
  const ikIds = await people(ik);
  const ikStop = await interaktPost(ik.wa, interaktReceived(S1_WA, 'STOP'));
  expect([ikStop.status, ikStop.body]).toEqual([200, { recorded: 0 }]);
  expect(await suppressionRows(ik.project.id, 'whatsapp')).toContainEqual(
    expect.objectContaining({ address: '+919876543210', reason: 'unsubscribed', source: 'interakt', detail: 'Replied "STOP"' }),
  );
  expect((await consentRows(ikIds.S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply' });
  expect(await waPreview(ik.owner, ik.project.id)).toBe(0);
  const ikOtherHistory = { manual: (await consentRows(ikIds.manual)).length, bounced: (await consentRows(ikIds.bounced)).length };

  // No timestamp: the START is read at the API's own time, after the STOP was stored.
  const ikStart = await interaktPost(ik.wa, interaktReceived(S1_WA, 'START'));
  expect([ikStart.status, ikStart.body]).toEqual([200, { recorded: 0 }]);
  for (const number of ['14155550122', '14155550133']) {
    expect((await interaktPost(ik.wa, interaktReceived(number, 'START'))).status).toBe(200);
  }
  expect((await suppressionRows(ik.project.id, 'whatsapp')).map((row) => [row.address, row.reason])).toEqual(kept);
  expect((await consentRows(ikIds.S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: true, source: 'start_reply' });
  expect((await consentRows(ikIds.manual)).length).toBe(ikOtherHistory.manual);
  expect((await consentRows(ikIds.bounced)).length).toBe(ikOtherHistory.bounced);
  expect(await waPreview(ik.owner, ik.project.id)).toBe(1);
  expect(await suppressionRows(ik.project.id, 'sms')).toHaveLength(0);
});

test('SMSWA-230 send with people from another project in deviceIdentityIds', async () => {
  const sms = await smsProject('smswa-230-sms', { twilio: true });
  const { S2 } = await seedPeople(sms, sms.owner.ip, ['S2']);
  const wa = await waProject('smswa-230-wa', 'interakt', { signed: false }, sms.owner);
  const { S1 } = await seedPeople(wa, sms.owner.ip, ['S1']);
  const other = await smsProject('smswa-230-other');
  const x = await identifyPhone(other, other.owner.ip, { phone: '+14155550166', smsOptIn: true, whatsappOptIn: true });
  const segOther = await createSegmentIn(other.owner, other.project.id);

  const smsSend = (extra: Record<string, unknown>) =>
    call('POST', '/api/sms/send', sms.owner, { projectId: sms.project.id, body: 'Cross-project check', scheduledAt: later(), ...extra });
  const both = await smsSend({ deviceIdentityIds: [S2, x] });
  expect(both.status).toBe(201);
  const smsOnly = await smsSend({ deviceIdentityIds: [x] });
  expect([smsOnly.status, messageOf(smsOnly)]).toEqual([400, SMS_NOBODY_OPT_IN]);
  const smsSeg = await smsSend({ segmentId: segOther });
  expect([smsSeg.status, messageOf(smsSeg)]).toEqual([404, `Segment ${segOther} not found`]);
  const smsRows = await campaignRows(sms.project.id);
  expect(smsRows).toHaveLength(1);
  expect(smsRows[0]).toMatchObject({ id: dataOf(both).id, target_type: 'devices', total_tokens: 1 });
  // The ids are stored as given; the worker reads them through the project-scoped audience.
  expect(smsRows[0].target_device_ids).toEqual([S2, x]);

  const waSend = (extra: Record<string, unknown>) => scheduleWhatsAppCampaign(sms.owner, wa.project.id, extra);
  const waBoth = await waSend({ deviceIdentityIds: [S1, x] });
  expect(waBoth.status).toBe(201);
  const waOnly = await waSend({ deviceIdentityIds: [x] });
  expect([waOnly.status, messageOf(waOnly)]).toEqual([400, WA_NOBODY_OPT_IN]);
  const waSeg = await waSend({ segmentId: segOther });
  expect([waSeg.status, messageOf(waSeg)]).toEqual([404, `Segment ${segOther} not found`]);
  const waRows = await campaignRows(wa.project.id);
  expect(waRows).toHaveLength(1);
  expect(waRows[0]).toMatchObject({ target_type: 'devices', total_tokens: 1 });

  expect(await activityRows(sms.project.id, 'campaign.scheduled')).toHaveLength(1);
  expect(await activityRows(wa.project.id, 'campaign.scheduled')).toHaveLength(1);
  expect(await campaignRows(other.project.id)).toHaveLength(0);
});

test('SMSWA-232 delivery reports for an erased person are dropped', async () => {
  const sms = await smsProject('smswa-232-sms', { twilio: true });
  const { S2, S1 } = await seedPeople(sms, sms.owner.ip, ['S2', 'S1']);
  const c = await scheduleSmsCampaign(sms.owner, sms.project.id);
  const wa = await waProject('smswa-232-wa', 'meta', {}, sms.owner);
  const person = await identifyPhone(wa, sms.owner.ip, { phone: '+14155550177', whatsappOptIn: true });
  const live = await identifyPhone(wa, sms.owner.ip, { phone: '+14155550178', whatsappOptIn: true });
  const cw = await seedCampaignRow(wa.project.id, 'whatsapp');
  const counters = () => sql(`SELECT id, success_count, failure_count FROM push_notification_logs WHERE id = ANY($1::uuid[]) ORDER BY id`, [[c.id, cw]]);
  const before = await counters();

  await erasePerson(sms.owner, sms.project.id, S2);
  await erasePerson(sms.owner, wa.project.id, person);

  const report = await twilioStatus(sms.sms!, { MessageStatus: 'delivered', To: '+14155550111' }, { campaignId: c.id, identityId: S2 });
  expect(report.status).toBe(204);
  expect(await eventRows(sms.project.id)).toHaveLength(0);

  const delivered = await metaPost(wa.wa, { statuses: [metaStatus('14155550177', 'delivered', { c: cw, i: person })] });
  expect([delivered.status, delivered.body]).toEqual([200, { recorded: 0 }]);
  const failed = await metaPost(wa.wa, {
    statuses: [
      metaStatus('14155550177', 'failed', { c: cw, i: person }, {
        errors: [{ code: 131049, title: 'Ecosystem', error_data: { details: 'Not delivered to +14155550177 for now' } }],
      }),
    ],
  });
  expect([failed.status, failed.body]).toEqual([200, { recorded: 0 }]);
  expect(await eventRows(wa.project.id)).toHaveLength(0);
  expect(await sql(`SELECT 1 FROM push_notification_events WHERE metadata::text LIKE '%14155550177%' AND project_id = $1`, [wa.project.id])).toHaveLength(0);
  expect(await counters()).toEqual(before);

  // The same reports for someone not erased are taken, so the drops above are the erasure's.
  const liveSms = await twilioStatus(sms.sms!, { MessageStatus: 'delivered', To: '+919876543210' }, { campaignId: c.id, identityId: S1 });
  expect(liveSms.status).toBe(204);
  expect((await eventRows(sms.project.id)).map((e) => [e.type, e.device_identity_id])).toEqual([['delivered', S1]]);
  const liveWa = await metaPost(wa.wa, { statuses: [metaStatus('14155550178', 'delivered', { c: cw, i: live })] });
  expect([liveWa.status, liveWa.body]).toEqual([200, { recorded: 1 }]);
});

test("SMSWA-233 a STOP for an erased person's number that nobody holds is kept only as a hash", async ({ page }) => {
  const p = await smsProject('smswa-233', { twilio: true });
  const { S2, S4 } = await seedPeople(p, p.owner.ip, ['S2', 'S4']);
  await erasePerson(p.owner, p.project.id, S2);
  await erasePerson(p.owner, p.project.id, S4);
  const consentBefore = (await projectConsentRows(p.project.id)).length;

  // 1. The STOP: no clear row, a hashed one.
  const stop = await twilioReply(p.sms!, '+14155550111', 'STOP');
  expect([stop.status, stop.text]).toEqual([200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>']);
  expect(await suppressionRows(p.project.id)).toHaveLength(0);
  expect(await sql(`SELECT channel, reason FROM erased_suppressions WHERE project_id = $1`, [p.project.id])).toEqual([
    { channel: 'sms', reason: 'unsubscribed' },
  ]);
  expect((await projectConsentRows(p.project.id)).length).toBe(consentBefore);

  // 2. Not listed.
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Suppressions');
  await expect(page.getByText('Nobody is suppressed.', { exact: true })).toBeVisible();
  expect(await smsSuppressionList(p.owner, p.project.id)).toEqual({ data: [], total: 0 });

  // 3. A test send to it is refused without calling Twilio.
  await openSms(page, p.project.id, 'Settings');
  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('+919876543210').fill('+14155550111');
  await testCard.getByRole('button', { name: 'Send test' }).click();
  const line = testCard.getByText(SUPPRESSED, { exact: true });
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-destructive/);
  expect((await twilioCallsFor(p.sms!.credentials.accountSid)).filter((entry) => entry.method === 'POST')).toHaveLength(0);

  // 4. A team member's own entry for the other erased number is kept in clear.
  await openSms(page, p.project.id, 'Suppressions');
  await page.getByPlaceholder('+14155550123').fill('+33612345678');
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '+33612345678' }).getByRole('cell').nth(1)).toHaveText('Added by hand');

  // 5. A new holder of the hashed number turns it back into a clear row.
  await identifyPhone(p, p.owner.ip, { phone: '+14155550111', smsOptIn: true });
  await page.reload();
  await page.getByRole('tab', { name: 'Suppressions', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '+14155550111' }).getByRole('cell').nth(1)).toHaveText('Unsubscribed');
  expect((await smsPreview(p.owner, p.project.id)).recipients).toBe(0);
});

test('SMSWA-252 a device handover removes the earlier person from SMS and WhatsApp reach', async () => {
  const p = await smsProject('smswa-252', { twilio: true });
  const secret = await identitySecretOf(p.owner, p.project.id);
  const fingerprint = `fp-handover-${randomBytes(6).toString('hex')}`;
  const identify = (body: Record<string, unknown>) =>
    api<{ id: string }>('POST', '/api/identity/identify', { projectId: p.project.id, deviceFingerprint: fingerprint, platform: 'web', ...body }, { apiKey: p.sdkKey, ip: p.owner.ip });

  // An external id without its hash is refused.
  const unsigned = await fetch(apiUrl('/api/identity/identify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': p.sdkKey, 'X-Forwarded-For': newClientIp() },
    body: JSON.stringify({ projectId: p.project.id, deviceFingerprint: fingerprint, platform: 'web', externalUserId: 'U1' }),
  });
  expect(unsigned.status).toBe(401);
  expect((await unsigned.json()).message).toBe(
    'externalUserId needs a userHash: HMAC-SHA256 of the id under the project identity secret, made on your server.',
  );

  const { id } = await identify({
    externalUserId: 'U1',
    userHash: userHashOf(secret, 'U1'),
    phone: '+14155550155',
    smsOptIn: true,
    whatsappOptIn: true,
  });
  const smsBefore = (await smsPreview(p.owner, p.project.id)).recipients;
  const waBefore = await waPreview(p.owner, p.project.id);
  expect([smsBefore, waBefore]).toEqual([1, 1]);

  const handed = await identify({ externalUserId: 'U2', userHash: userHashOf(secret, 'U2') });
  expect(handed.id).toBe(id);
  const [row] = await sql(`SELECT phone, phone_e164, sms_opt_in, whatsapp_opt_in FROM device_identities WHERE id = $1`, [id]);
  expect(row).toEqual({ phone: null, phone_e164: null, sms_opt_in: null, whatsapp_opt_in: null });
  const handover = (await consentRows(id)).filter((entry) => entry.source === 'device_handover');
  expect(handover).toEqual(
    expect.arrayContaining([
      { channel: 'sms', granted: false, source: 'device_handover' },
      { channel: 'whatsapp', granted: false, source: 'device_handover' },
    ]),
  );
  expect(handover.filter((entry) => entry.channel === 'sms' || entry.channel === 'whatsapp')).toHaveLength(2);

  expect((await smsPreview(p.owner, p.project.id)).recipients).toBe(smsBefore - 1);
  expect(await waPreview(p.owner, p.project.id)).toBe(waBefore - 1);
});

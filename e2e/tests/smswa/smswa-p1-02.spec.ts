import { randomBytes } from 'crypto';
import { allowClipboard, readClipboard } from '../../support/browser-tools';
import { expect, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import { stubCalls } from '../../support/provider-stub';
import { publicApiUrl } from '../../support/signing';
import { smsWebhookPath } from '../../support/channels';
import {
  activityOf,
  armBox,
  call,
  campaignRow,
  campaignRows,
  card,
  createSegmentIn,
  credentialProviders,
  dataOf,
  eventRows,
  identifyPhone,
  interaktPost,
  labelledSwitch,
  messageOf,
  openSmsComposer,
  openWhatsApp,
  PEOPLE,
  postTwilio,
  recordBodies,
  reachLine,
  saveSender,
  scheduleSmsCampaign,
  scheduleWhatsAppCampaign,
  seedListRow,
  seedPeople,
  segmentMeter,
  smsBubble,
  smsProject,
  smsSettingsRow,
  suppressionRows,
  teammate,
  toastTitled,
  toastWith,
  traitSegment,
  twilioCallsFor,
  twilioReply,
  twilioStatus,
  uniquePhone,
  waConsentSwitch,
  waProject,
  waProviderTab,
  waSettingsRow,
  waSummaryLine,
  waWebhookBlock,
} from '../../support/areas/smswa';

/**
 * SMS and WhatsApp, third round: the SMS composer (initial state, the segment counter,
 * reach, segments, timezone delivery, A/B arms and their API checks, test sends, a
 * member's send), the SMS API's refusals and Twilio's webhooks (missing credentials,
 * temporary errors, another account, every keyword), the WhatsApp page and its campaign
 * list, and the WhatsApp Provider card (format refusals, connected summaries, webhook
 * URLs, the admin's view). Provider connections are seeded; people arrive through the
 * SDK's identify route; the provider stub answers every outbound call.
 */

test.describe.configure({ mode: 'parallel' });

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const BAD_TEST_NUMBER = 'Enter the number in international form, with its country code: +14155550123.';
const SUPPRESSED_TEST = 'This address is on the project’s suppression list.';
const UNSIGNED_NOTE =
  '· webhooks unsigned: events are checked against your users before they count, and a START reply cannot undo a STOP';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const monthAhead = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --------------------------------------------------------------- F. SMS composer ---

test('SMSWA-068 composer initial state', async ({ page }) => {
  const p = await smsProject('smswa-068', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);

  const back = page.getByRole('link', { name: 'SMS', exact: true }).first();
  await expect(back).toHaveAttribute('href', `/projects/${p.project.id}/sms`);
  await expect(page.getByRole('heading', { level: 1, name: 'New text', exact: true })).toBeVisible();
  const message = card(page, 'Message');
  await expect(message.locator('[data-slot="card-description"]')).toHaveText(
    'Personalise with {{firstName}} or {{trait.plan|free}}. “Reply STOP to opt out.” is added at the end.',
  );
  const name = page.getByLabel('Campaign name (optional)');
  await expect(name).toHaveValue('');
  await expect(name).toHaveAttribute('placeholder', 'Shown in your campaign list; defaults to the start of the text');
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue('Hi {{firstName|there}}, ');
  await expect(segmentMeter(message)).toHaveText('51 characters · 1 segment per text · 109 left in this segment');

  const audience = card(page, 'Audience');
  await expect(audience.getByRole('combobox')).toHaveText('Everyone');
  await expect(audience.locator('[data-slot="card-description"]')).toHaveText(
    'People with a phone number in international form who have not replied STOP, and who opted in.',
  );
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  const when = card(page, 'When').getByRole('switch');
  await expect(when).toHaveCount(2);
  for (const toggle of await when.all()) await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(labelledSwitch(page, 'A/B test')).toHaveAttribute('aria-checked', 'false');

  expect(await smsBubble(page).innerText()).toBe('Hi {{firstName|there}},\nReply STOP to opt out.');
  await expect(page.getByRole('button', { name: 'Send text' })).toBeEnabled();
});

test('SMSWA-069 segment counter: GSM-7 boundaries with the opt-out line', async ({ page }) => {
  const p = await smsProject('smswa-069', { twilio: true });
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  await expect(card(page, 'Message').getByText('“Reply STOP to opt out.” is added at the end.', { exact: false })).toBeVisible();
  const text = page.getByLabel('Text', { exact: true });
  const meter = segmentMeter(card(page, 'Message'));

  await text.fill('a'.repeat(137));
  await expect(meter).toHaveText('160 characters · 1 segment per text · 0 left in this segment');
  await text.fill('a'.repeat(138));
  await expect(meter).toHaveText('161 characters · 2 segments per text · 145 left in this segment');
});

test('SMSWA-070 segment counter: GSM-7 boundaries without an opt-out line', async ({ page }) => {
  const p = await smsProject('smswa-070', { twilio: true });
  await saveSender(p.owner, p.project.id, { optOutText: '' });
  expect((await smsSettingsRow(p.project.id))!.opt_out_text).toBeNull();
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  await expect(card(page, 'Message').locator('[data-slot="card-description"]')).toHaveText(
    'Personalise with {{firstName}} or {{trait.plan|free}}.',
  );
  const text = page.getByLabel('Text', { exact: true });
  const meter = segmentMeter(card(page, 'Message'));
  const segments = meter.locator('span');

  const cases: Array<[number, string, boolean]> = [
    [160, '160 characters · 1 segment per text · 0 left in this segment', false],
    [161, '161 characters · 2 segments per text · 145 left in this segment', false],
    [306, '306 characters · 2 segments per text · 0 left in this segment', false],
    [307, '307 characters · 3 segments per text · 152 left in this segment', true],
  ];
  for (const [length, expected, emphasised] of cases) {
    await text.fill('a'.repeat(length));
    await expect(meter).toHaveText(expected);
    if (emphasised) await expect(segments).toHaveClass(/text-yellow-700/);
    else await expect(segments).not.toHaveClass(/text-yellow-700/);
  }
  expect(await smsBubble(page).innerText()).toBe('a'.repeat(307));
});

test('SMSWA-072 segment counter: a Unicode character switches to UCS-2 and is named', async ({ page }) => {
  const p = await smsProject('smswa-072', { twilio: true });
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  await page.getByLabel('Text', { exact: true }).fill('Sale today 🎉');
  await expect(segmentMeter(card(page, 'Message'))).toHaveText(
    '36 UCS-2 units · 1 segment per text · 34 left in this segment · “🎉” switches the whole text to Unicode, which fits 70 characters per segment instead of 160',
  );
});

test('SMSWA-074 opt-out line not appended when the text already says it', async ({ page }) => {
  const p = await smsProject('smswa-074', { twilio: true });
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  // A positive control: another text gets the line.
  await page.getByLabel('Text', { exact: true }).fill('Hello');
  await expect.poll(() => smsBubble(page).innerText()).toBe('Hello\nReply STOP to opt out.');

  await page.getByLabel('Text', { exact: true }).fill('Hello reply stop to opt out.');
  await expect.poll(() => smsBubble(page).innerText()).toBe('Hello reply stop to opt out.');
  await expect(segmentMeter(card(page, 'Message'))).toHaveText('28 characters · 1 segment per text · 132 left in this segment');
});

test('SMSWA-079 nobody reachable', async ({ page }) => {
  const required = await smsProject('smswa-079', { twilio: true });
  await seedPeople(required, required.owner.ip, ['S3', 'S4', 'S5', 'S6']);
  const notRequired = await smsProject('smswa-079-off', { twilio: true, requireOptIn: false }, required.owner);
  await seedPeople(notRequired, required.owner.ip, ['S3', 'S5', 'S6']);

  await signIn(page, required.owner);
  await openSmsComposer(page, required.project.id);
  const nobody = reachLine(page).locator('span.text-destructive');
  await expect(nobody).toHaveText('Nobody here can be texted (no one has opted in yet).');
  await expect(page.getByRole('button', { name: 'Send text' })).toBeDisabled();

  await openSmsComposer(page, notRequired.project.id);
  await expect(card(page, 'Audience').locator('[data-slot="card-description"]')).toHaveText(
    'People with a phone number in international form who have not replied STOP.',
  );
  await expect(nobody).toHaveText('Nobody here can be texted.');
  await expect(page.getByRole('button', { name: 'Send text' })).toBeDisabled();
});

test('SMSWA-081 choose a segment', async ({ page }) => {
  const p = await smsProject('smswa-081', { twilio: true });
  for (const key of ['S1', 'S2', 'S3', 'S4']) await identifyPhone(p, p.owner.ip, { ...PEOPLE[key], traits: { group: 'some' } });
  await identifyPhone(p, p.owner.ip, PEOPLE.S7);
  const some = await traitSegment(p.owner, p.project.id, 'some', `SEG-some ${hex(2)}`);
  const empty = await traitSegment(p.owner, p.project.id, 'nobody', `SEG-empty ${hex(2)}`);
  const previews = recordBodies(page, /\/api\/sms\/audience-preview$/);

  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  // Everyone: S1, S2 and S7 (S3 opted out, S4 never opted in).
  await expect(page.getByText('3 recipient(s)', { exact: true })).toBeVisible();
  const send = page.getByRole('button', { name: 'Send text' });
  await expect(send).toBeEnabled();

  const audience = card(page, 'Audience');
  await audience.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'A segment', exact: true }).click();
  const segmentSelect = audience.getByRole('combobox').nth(1);
  await expect(segmentSelect).toHaveText('Choose a segment');
  await expect(page.getByText('3 recipient(s)', { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();

  await segmentSelect.click();
  await page.getByRole('option', { name: some.name, exact: true }).click();
  await expect(page.getByText('2 recipient(s)', { exact: true })).toBeVisible();
  await expect(send).toBeEnabled();

  await segmentSelect.click();
  await page.getByRole('option', { name: empty.name, exact: true }).click();
  await expect(reachLine(page)).toHaveText('Nobody here can be texted (no one has opted in yet).');
  await expect(send).toBeDisabled();

  // Nothing was asked between choosing "A segment" and picking one.
  expect(previews.filter((body) => 'segmentId' in body).map((body) => body.segmentId)).toEqual([some.id, empty.id]);
  expect(previews.length).toBeGreaterThanOrEqual(3);
});

test('SMSWA-082 audience preview API validation and cross-tenant segment', async () => {
  const p = await smsProject('smswa-082', { twilio: true });
  const { S2 } = await seedPeople(p, p.owner.ip, ['S2']);
  const other = await smsProject('smswa-082-other', { twilio: true });
  const { S2: otherS2, S7: otherS7 } = await seedPeople(other, other.owner.ip, ['S2', 'S7']);
  const otherSegment = await createSegmentIn(other.owner, other.project.id);
  const preview = (extra: Record<string, unknown>) => call('POST', '/api/sms/audience-preview', p.owner, { projectId: p.project.id, ...extra });

  const bad = await preview({ segmentId: 'nope' });
  expect([bad.status, messageOf(bad)]).toEqual([400, 'segmentId must be a UUID']);
  const foreign = await preview({ segmentId: otherSegment });
  expect([foreign.status, messageOf(foreign)]).toEqual([404, `Segment ${otherSegment} not found`]);

  // A positive control: the project's own device counts.
  expect(dataOf(await preview({ deviceIdentityIds: [S2] }))).toEqual({ targetType: 'devices', recipients: 1, requireOptIn: true });
  expect(dataOf(await preview({ deviceIdentityIds: [otherS2, otherS7] }))).toEqual({ targetType: 'devices', recipients: 0, requireOptIn: true });
  expect(dataOf(await preview({ deviceIdentityIds: [] }))).toEqual({ targetType: 'project', recipients: 1, requireOptIn: true });
});

test("SMSWA-088 deliver in each recipient's timezone", async ({ page }) => {
  const p = await smsProject('smswa-088', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Text', { exact: true }).fill('Morning note');

  await expect(page.locator('input[type="time"]')).toHaveCount(0);
  await labelledSwitch(page, "Deliver in each recipient's timezone").click();
  await expect(
    page.getByText('At this local time, one wave per timezone. Texts at night get complaints, and some countries forbid them.', { exact: true }),
  ).toBeVisible();
  const time = card(page, 'When').locator('input[type="time"]');
  await expect(time).toHaveValue('10:00');
  await time.fill('09:15');

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/sms/send') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Schedule text' }).click(),
  ]);
  expect(response.status()).toBe(201);
  await expect(toastWith(page, 'Text scheduled', '1 recipient(s).')).toBeVisible();
  const [row] = await campaignRows(p.project.id);
  expect(row).toMatchObject({ deliver_in_recipient_timezone: true, local_send_time: '09:15', status: 'scheduled', body: 'Morning note' });
});

test('SMSWA-090 A/B test: start, arms and weights', async ({ page }) => {
  const p = await smsProject('smswa-090', { twilio: true });
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  await page.getByLabel('Text', { exact: true }).fill('Offer A');
  const ab = card(page, 'A/B test');
  await expect(ab.locator('[data-slot="card-description"]')).toHaveText(
    'Compare wordings. Scored on conversions attributed to each arm, with an optional hold-out to measure lift.',
  );
  await labelledSwitch(page, 'A/B test').click();

  const arms = ab.locator('div.rounded-md.border');
  await expect(arms).toHaveCount(2);
  await expect(armBox(page, 'A').getByPlaceholder('Text for this arm')).toHaveValue('Offer A');
  await expect(armBox(page, 'A').locator('input[type="number"]')).toHaveValue('50');
  await expect(armBox(page, 'B').getByPlaceholder('Text for this arm')).toHaveValue('');
  await expect(armBox(page, 'B').locator('input[type="number"]')).toHaveValue('50');
  await expect(arms.getByRole('button')).toHaveCount(0);
  await armBox(page, 'B').getByPlaceholder('Text for this arm').fill('Offer B');

  const addArm = ab.getByRole('button', { name: 'Add arm' });
  for (const key of ['C', 'D', 'E']) {
    await addArm.click();
    await armBox(page, key).getByPlaceholder('Text for this arm').fill(`Offer ${key}`);
  }
  await expect(arms).toHaveCount(5);
  for (const key of ['A', 'B', 'C', 'D', 'E']) await expect(armBox(page, key).locator('input[type="number"]')).toHaveValue('20');
  await expect(addArm).toHaveCount(0);
  await expect(arms.getByRole('button')).toHaveCount(5);

  await armBox(page, 'C').getByRole('button').click();
  await expect(arms).toHaveCount(4);
  await expect(arms.locator('span.text-sm.font-medium')).toHaveText(['Arm A', 'Arm B', 'Arm C', 'Arm D']);
  for (const [key, body] of [['A', 'Offer A'], ['B', 'Offer B'], ['C', 'Offer D'], ['D', 'Offer E']]) {
    await expect(armBox(page, key).getByPlaceholder('Text for this arm')).toHaveValue(body);
    await expect(armBox(page, key).locator('input[type="number"]')).toHaveValue('25');
  }
  await expect(addArm).toBeVisible();
});

test('SMSWA-091 A/B test: weights must total 100 and every arm needs text', async ({ page }) => {
  const p = await smsProject('smswa-091', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Text', { exact: true }).fill('Offer A');
  await labelledSwitch(page, 'A/B test').click();
  const start = page.getByRole('button', { name: 'Start experiment' });
  const weightsMessage = card(page, 'A/B test').locator('p.text-destructive');

  await armBox(page, 'A').locator('input[type="number"]').fill('60');
  await expect(weightsMessage).toHaveText('Weights add up to 110%, not 100%.');
  await expect(start).toBeDisabled();

  await armBox(page, 'B').locator('input[type="number"]').fill('40');
  await expect(weightsMessage).toHaveCount(0);
  await expect(armBox(page, 'B').getByPlaceholder('Text for this arm')).toHaveValue('');
  await expect(start).toBeDisabled();

  await armBox(page, 'B').getByPlaceholder('Text for this arm').fill('Offer B');
  await expect(start).toBeEnabled();
  await expect(segmentMeter(armBox(page, 'A'))).toHaveText('30 characters · 1 segment per text · 130 left in this segment');
  await expect(segmentMeter(armBox(page, 'B'))).toHaveText('30 characters · 1 segment per text · 130 left in this segment');
});

test('SMSWA-092 start an experiment with a control group', async ({ page }) => {
  const p = await smsProject('smswa-092', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2', 'S7']);
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  await expect(page.getByText('2 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Text', { exact: true }).fill('Offer A');
  await labelledSwitch(page, 'A/B test').click();
  await armBox(page, 'B').getByPlaceholder('Text for this arm').fill('Offer B');
  await page.getByText('Hold back as control', { exact: true }).locator('..').locator('input[type="number"]').fill('10');

  const before = Date.now();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/sms/send') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Start experiment' }).click(),
  ]);
  expect(response.status()).toBe(201);
  await expect(toastWith(page, 'Experiment created', '2 recipient(s).')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/sms$`));
  await expect(campaignRow(page, 'Offer A')).toContainText('Scheduled');

  const [row] = await campaignRows(p.project.id);
  expect(row.variants).toEqual([
    { key: 'A', title: 'A', body: 'Offer A', weight: 50 },
    { key: 'B', title: 'B', body: 'Offer B', weight: 50 },
  ]);
  expect(row).toMatchObject({ control_percentage: 10, status: 'scheduled' });
  const at = new Date(row.scheduled_at).getTime();
  expect(at).toBeGreaterThanOrEqual(before - 5_000);
  expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
});

test('SMSWA-093 experiment validation in the API', async ({ page }) => {
  const p = await smsProject('smswa-093', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  const arm = (key: string, weight: number, body = `Text ${key}`) => ({ key, title: key, body, weight });
  const send = (extra: Record<string, unknown>) =>
    call('POST', '/api/sms/send', p.owner, { projectId: p.project.id, body: 'Hello', scheduledAt: monthAhead(), ...extra });

  const cases: Array<[Record<string, unknown>, string]> = [
    [{ variants: [arm('A', 100)] }, 'An experiment needs at least two variants.'],
    [{ variants: ['A', 'B', 'C', 'D', 'E', 'F'].map((key, i) => arm(key, i < 4 ? 17 : 16)) }, 'An experiment supports at most five variants.'],
    [{ variants: [arm('A', 50), arm('A', 50)] }, 'Variant keys must be unique.'],
    [{ variants: [arm('A', 100), arm('B', 0)] }, 'Every variant needs a weight above zero.'],
    [{ variants: [arm('A', 60), arm('B', 30)] }, 'Variant weights must total 100, got 90.'],
    [{ variants: [arm('A', 50), arm('B', 50)], controlPercentage: 60 }, 'controlPercentage must not be greater than 50'],
    [{ variants: [arm('A', 50), arm('B', 50, '')] }, 'variants.1.body must be longer than or equal to 1 characters'],
  ];
  for (const [extra, message] of cases) {
    const answered = await send(extra);
    expect([answered.status, messageOf(answered)]).toEqual([400, message]);
  }
  expect(await campaignRows(p.project.id)).toHaveLength(0);
  // A positive control: the same request with valid arms is created.
  expect((await send({ variants: [arm('A', 50), arm('B', 50)], controlPercentage: 10 })).status).toBe(201);

  // The composer lets 100/0 through (the total is 100); the API's refusal is the toast.
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Text', { exact: true }).fill('Offer A');
  await labelledSwitch(page, 'A/B test').click();
  await armBox(page, 'B').getByPlaceholder('Text for this arm').fill('Offer B');
  await armBox(page, 'A').locator('input[type="number"]').fill('100');
  await armBox(page, 'B').locator('input[type="number"]').fill('0');
  await page.getByRole('button', { name: 'Start experiment' }).click();
  await expect(toastWith(page, 'Could not create text', 'Every variant needs a weight above zero.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/sms/new$`));
  expect(await campaignRows(p.project.id)).toHaveLength(1);
});

test('SMSWA-097 composer on a project that is not ready', async ({ page }) => {
  const p = await smsProject('smswa-097', { sender: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);

  await expect(page.getByText('SMS is not set up yet. Finish setup first.', { exact: true })).toBeVisible();
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Text', { exact: true }).fill('Ready when you are');
  await page.getByPlaceholder('Send a test to +…').fill('+14155550123');
  await expect(page.getByRole('button', { name: 'Send text' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Test', exact: true })).toBeDisabled();

  await page.getByRole('link', { name: 'Finish setup', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/sms$`));
});

test('SMSWA-099 composer test send', async ({ page }) => {
  const p = await smsProject('smswa-099', { twilio: true });
  const suppressed = uniquePhone();
  expect((await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: suppressed })).status).toBe(201);

  await signIn(page, p.owner);
  await openSmsComposer(page, p.project.id);
  const to = page.getByPlaceholder('Send a test to +…');
  const testButton = page.getByRole('button', { name: 'Test', exact: true });
  await expect(testButton).toBeDisabled();
  await to.fill('1415');
  await expect(testButton).toBeDisabled();
  await to.fill('+1415');
  await expect(testButton).toBeEnabled();
  await page.getByLabel('Text', { exact: true }).fill('');
  await expect(testButton).toBeDisabled();
  await page.getByLabel('Text', { exact: true }).fill('Test text');
  await expect(testButton).toBeEnabled();

  await to.fill(suppressed);
  await testButton.click();
  await expect(toastWith(page, 'Test failed', SUPPRESSED_TEST)).toBeVisible();

  await to.fill('+12');
  await testButton.click();
  await expect(toastWith(page, 'Test failed', BAD_TEST_NUMBER)).toBeVisible();
  expect(await twilioCallsFor(p.sms!.credentials.accountSid)).toHaveLength(0);

  // Through the provider stub, a test that Twilio accepts.
  const good = uniquePhone();
  await to.fill(good);
  await testButton.click();
  await expect(toastWith(page, 'Test sent', `Check ${good}.`)).toBeVisible();
  const sent = (await twilioCallsFor(p.sms!.credentials.accountSid)).filter((c) => c.method === 'POST' && c.path.endsWith('/Messages.json'));
  expect(sent.map((c) => (c.body as Record<string, string>).To)).toEqual([good]);
});

test('SMSWA-101 member composes and sends', async ({ page }) => {
  const p = await smsProject('smswa-101', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  const member = await teammate(p.project.id, 'member', p.owner);

  await signIn(page, member);
  await openSmsComposer(page, p.project.id);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Text', { exact: true }).fill('From the member');
  await labelledSwitch(page, 'Schedule for later').click();
  await page.getByRole('button', { name: 'Pick date & time' }).click();
  await page.getByRole('button', { name: /next month/i }).click();
  await page.getByRole('gridcell', { name: '15' }).getByRole('button').click();
  await page.locator('input[type="time"]').fill('10:30');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Schedule text' }).click();

  await expect(toastWith(page, 'Text scheduled', '1 recipient(s).')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/sms$`));
  const [row] = await campaignRows(p.project.id);
  expect(row).toMatchObject({ status: 'scheduled', body: 'From the member' });
  const entries = await activityOf(p.project.id, 'campaign.scheduled');
  expect(entries.map((entry) => entry.actor)).toEqual([member.userId]);
});

// ------------------------------------------------------------ G. SMS API access ---

test('SMSWA-104 signed-out calls are refused', async () => {
  const p = await smsProject('smswa-104', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  const settings = await call('GET', `/api/sms/settings/${p.project.id}`, null);
  const send = await call('POST', '/api/sms/send', null, { projectId: p.project.id, body: 'Hello', scheduledAt: monthAhead() });
  expect([settings.status, send.status]).toEqual([401, 401]);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
  // A positive control: the owner's token is let through.
  expect((await call('GET', `/api/sms/settings/${p.project.id}`, p.owner)).status).toBe(200);
});

// ------------------------------------------------------------- H. Twilio webhooks ---

test('SMSWA-110 no Twilio credentials stored', async () => {
  const p = await smsProject('smswa-110', { sender: true });
  const token = (await smsSettingsRow(p.project.id))!.webhook_token as string;
  const authToken = hex(16);
  for (const kind of ['inbound', 'status'] as const) {
    const answered = await postTwilio(smsWebhookPath(token, kind), { From: '+14155550111', To: '+14155550111', Body: 'STOP', MessageStatus: 'delivered' }, { authToken });
    expect([answered.status, messageOf(answered)]).toEqual([403, 'Connect Twilio in SMS settings to receive its webhooks.']);
  }
  expect(await suppressionRows(p.project.id)).toHaveLength(0);
});

test('SMSWA-114 undelivered with a temporary error: event only', async () => {
  const p = await smsProject('smswa-114', { twilio: true });
  const { S2 } = await seedPeople(p, p.owner.ip, ['S2']);
  const c = await scheduleSmsCampaign(p.owner, p.project.id);

  const answered = await twilioStatus(p.sms!, { MessageStatus: 'undelivered', ErrorCode: '30003', To: PEOPLE.S2.phone! }, { campaignId: c.id, identityId: S2 });
  expect(answered.status).toBe(204);
  const events = await eventRows(p.project.id);
  expect(events.map((e) => [e.type, e.platform, e.campaign_id, e.device_identity_id, e.metadata])).toEqual([
    ['bounced', 'sms', c.id, S2, { detail: 'Twilio error 30003' }],
  ]);
  expect(await suppressionRows(p.project.id)).toHaveLength(0);

  // A positive control: a dead-number code on the same route does suppress.
  const dead = uniquePhone();
  expect((await twilioStatus(p.sms!, { MessageStatus: 'failed', ErrorCode: '30005', To: dead })).status).toBe(204);
  expect((await suppressionRows(p.project.id)).map((row) => row.address)).toEqual([dead]);
});

test('SMSWA-120 AccountSid from another Twilio account', async () => {
  const p = await smsProject('smswa-120', { twilio: true });
  const sms = p.sms!;
  const from = uniquePhone();
  const params = { AccountSid: `AC${hex(16)}`, From: from, To: sms.sender, Body: 'STOP' };
  const answered = await postTwilio(smsWebhookPath(sms.webhookToken, 'inbound'), params, { authToken: sms.credentials.authToken });
  expect([answered.status, messageOf(answered)]).toEqual([403, 'This request is for a different Twilio account.']);
  expect(await suppressionRows(p.project.id)).toHaveLength(0);

  // A positive control: the same reply naming the stored account is taken.
  const own = await twilioReply(sms, from, 'STOP');
  expect(own.status).toBe(200);
  expect((await suppressionRows(p.project.id)).map((row) => row.address)).toEqual([from]);
});

test("SMSWA-122 every STOP keyword and Twilio's matching rule", async () => {
  const p = await smsProject('smswa-122', { twilio: true });
  const bodies: Array<[string, boolean]> = [
    ['stopall', true],
    ['UNSUBSCRIBE', true],
    ['Cancel', true],
    ['end', true],
    ['QUIT', true],
    ['revoke', true],
    ['OPTOUT', true],
    [' Stop. ', true],
    ['stop sending me these', false],
    ['STOP!!', true],
    ['Hello', false],
  ];
  const expected: string[] = [];
  for (const [body, suppresses] of bodies) {
    const from = uniquePhone();
    const answered = await twilioReply(p.sms!, from, body);
    expect([body, answered.status, answered.headers.get('content-type'), answered.text]).toEqual([
      body,
      200,
      expect.stringContaining('text/xml'),
      EMPTY_TWIML,
    ]);
    if (suppresses) expected.push(from);
  }
  const rows = await suppressionRows(p.project.id);
  expect(rows.map((row) => row.address).sort()).toEqual(expected.sort());
  expect(rows.every((row) => row.reason === 'unsubscribed' && row.source === 'twilio')).toBe(true);
});

// ------------------------------------------------- I. WhatsApp page and campaigns ---

test('SMSWA-128 open the WhatsApp page from the sidebar', async ({ page }) => {
  test.info().annotations.push({ type: 'issue', description: 'SMSWA-128' });
  test.fail();
  const p = await waProject('smswa-128', 'interakt');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}`);
  await openSidebarGroup(page, 'Engagement');
  await expect(sidebarLink(page, 'Push Notifications')).toBeVisible();
  await expect(sidebarLink(page, 'WhatsApp')).toBeVisible({ timeout: 5000 });
  await sidebarLink(page, 'WhatsApp').click();

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/whatsapp$`));
  await expect(page.getByRole('heading', { name: 'WhatsApp', exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Approved-template campaigns through your own Meta, Twilio, Gupshup or Interakt account, with the same audiences, schedules and experiments as every other channel.',
    ),
  ).toBeVisible();
  for (const tab of ['Campaigns', 'Suppressions', 'Settings']) await expect(page.getByRole('tab', { name: tab, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New campaign' })).toHaveAttribute('href', `/projects/${p.project.id}/whatsapp/new`);
});

test('SMSWA-129 not set up: warning and no create button', async ({ page }) => {
  const p = await smsProject('smswa-129');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/whatsapp`);

  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('WhatsApp is not set up yet. Connect a provider under Settings.', { exact: true })).toBeVisible();
  await expect(card(page, 'Campaigns').locator('[data-slot="card-description"]')).toHaveText(
    'Sent is what your provider accepted. Delivered, read and failed come from its webhook, which needs the API to be reachable from the internet.',
  );
  await expect(page.getByText('No WhatsApp campaigns yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first WhatsApp campaign' })).toHaveCount(0);
});

test('SMSWA-130 ready project with no campaigns', async ({ page }) => {
  const p = await waProject('smswa-130', 'interakt');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/whatsapp`);

  await expect(page.getByText('No WhatsApp campaigns yet.', { exact: true })).toBeVisible();
  const create = page.getByRole('link', { name: 'Create your first WhatsApp campaign' });
  await expect(create).toHaveAttribute('href', `/projects/${p.project.id}/whatsapp/new`);
  // The link needs the settings to have loaded, so the warning's absence is now meaningful.
  await expect(page.getByText('WhatsApp is not set up yet. Connect a provider under Settings.')).toHaveCount(0);
  await create.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/whatsapp/new$`));
  await expect(page.getByRole('heading', { name: 'New WhatsApp campaign', exact: true })).toBeVisible();
});

test('SMSWA-131 campaign list columns, only WhatsApp rows', async ({ page }) => {
  const p = await waProject('smswa-131', 'interakt');
  await seedPeople(p, p.owner.ip, ['S1']);
  const scheduledName = `Later ${hex(3)}`;
  const scheduled = dataOf(await scheduleWhatsAppCampaign(p.owner, p.project.id, { name: scheduledName }));
  const seeded: Record<string, { id: string; title: string }> = {};
  for (const status of ['queued', 'sending', 'sent', 'failed', 'partial', 'expanded', 'cancelled']) {
    seeded[status] = await seedListRow(p.project.id, 'whatsapp', { title: `WA ${status} ${hex(2)}`, status, totalTokens: 5, successCount: 3, processedTokens: 2 });
  }
  const sms = await seedListRow(p.project.id, 'sms', { title: `SMS ${hex(3)}` });
  const push = await seedListRow(p.project.id, 'push', { title: `Push ${hex(3)}` });
  const logRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(`/push-notifications/logs/${p.project.id}`)) logRequests.push(r.url());
  });

  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Campaigns');
  const table = card(page, 'Campaigns').getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Campaign', 'Status', 'Sent', 'Delivered', 'Read', 'Failed', 'When']);
  await expect(table.locator('tbody tr')).toHaveCount(8);
  await expect(page.getByText(sms.title)).toHaveCount(0);
  await expect(page.getByText(push.title)).toHaveCount(0);

  const cells = (title: string) => campaignRow(page, title).getByRole('cell');
  await expect(cells(scheduledName).nth(1)).toHaveText('Scheduled');
  await expect(cells(scheduledName).nth(2)).toHaveText(`0/${scheduled.totalTokens}`);
  await expect(cells(scheduledName).nth(6).locator('span.text-blue-600')).toBeVisible();
  const labels: Record<string, string> = {
    queued: 'Queued',
    sending: 'Sending',
    sent: 'Sent',
    failed: 'Failed',
    partial: 'Partial',
    expanded: 'Split',
    cancelled: 'Cancelled',
  };
  for (const [status, row] of Object.entries(seeded)) {
    await expect(cells(row.title).nth(1)).toHaveText(labels[status]);
    await expect(cells(row.title).nth(2)).toHaveText(status === 'queued' || status === 'sending' ? '2/5' : '3/5');
    await expect(cells(row.title).nth(6).locator('span.text-blue-600')).toHaveCount(0);
  }
  expect(logRequests.some((url) => url.includes('channel=whatsapp'))).toBe(true);
});

test('SMSWA-132 delivered, read and failed counts', async ({ page }) => {
  const p = await waProject('smswa-132', 'interakt', { requireOptIn: false });
  const ids = await seedPeople(p, p.owner.ip, ['S1', 'S2', 'S4']);
  const name = `Counts ${hex(3)}`;
  const c = dataOf(await scheduleWhatsAppCampaign(p.owner, p.project.id, { name }));
  const report = (type: string, number: string, identity: string) =>
    interaktPost(p.wa, {
      type,
      data: {
        customer: { channel_phone_number: number },
        message: { meta_data: { source_data: { callback_data: JSON.stringify({ c: c.id, i: identity }) } } },
      },
    });

  for (const [type, key] of [['message_api_delivered', 'S1'], ['message_api_read', 'S2'], ['message_api_failed', 'S4']] as const) {
    const answered = await report(type, PEOPLE[key].phone!.slice(1), ids[key]);
    expect([type, answered.status, answered.body]).toEqual([type, 200, { recorded: 1 }]);
  }
  const events = await eventRows(p.project.id);
  expect(events.map((e) => [e.type, e.device_identity_id]).sort()).toEqual(
    [['delivered', ids.S1], ['impression', ids.S2], ['bounced', ids.S4]].sort(),
  );

  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Campaigns');
  const cells = campaignRow(page, name).getByRole('cell');
  await expect(cells.nth(3)).toHaveText('1');
  await expect(cells.nth(4)).toHaveText('1');
  await expect(cells.nth(5)).toHaveText('1');
});

test('SMSWA-133 row click opens the shared detail page', async ({ page }) => {
  const p = await waProject('smswa-133', 'interakt');
  const c = await seedListRow(p.project.id, 'whatsapp', { title: `Detail ${hex(3)}` });

  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Campaigns');
  await campaignRow(page, c.title).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/${c.id}$`));
  const heading = page.getByRole('heading', { level: 1, name: c.title, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading.locator('..').locator('[data-slot="badge"]').filter({ hasText: /^\s*WhatsApp\s*$/ })).toBeVisible();
});

// ---------------------------------------------- J. WhatsApp settings: Provider card ---

test('SMSWA-135 fresh project: provider tabs and Meta form', async ({ page }) => {
  const p = await smsProject('smswa-135');
  const status = dataOf(await call('GET', `/api/whatsapp/settings/${p.project.id}`, p.owner));
  expect(status).toMatchObject({ configured: false, webhookUrls: null, verifyToken: null, providers: [] });

  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Settings');
  const provider = card(page, 'Provider');
  await expect(provider.locator('[data-slot="card-description"]')).toHaveText(
    'Messages go out through your own WhatsApp Business account. Meta bills the conversations; Chumbaq never sends from a shared number.',
  );
  await expect(provider.getByRole('tab')).toHaveText(['Meta Cloud API', 'Twilio', 'Gupshup', 'Interakt']);
  await expect(waProviderTab(page, 'Meta Cloud API')).toHaveAttribute('aria-selected', 'true');
  await expect(provider.getByText('Active', { exact: true })).toHaveCount(0);

  const phoneId = page.getByLabel('Phone number ID', { exact: true });
  await expect(phoneId).toHaveAttribute('placeholder', '1059545589544');
  await expect(provider.getByText('Under WhatsApp → API Setup in your Meta app. Not the phone number itself.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('WhatsApp Business Account ID', { exact: true })).toHaveAttribute('placeholder', '2059545589544');
  await expect(page.getByLabel('Access token', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('App secret (optional)', { exact: true })).toHaveAttribute('type', 'password');
  await expect(provider.getByRole('button', { name: 'Connect Meta Cloud API' })).toBeDisabled();
  await expect(waWebhookBlock(page)).toHaveCount(0);

  await expect(card(page, 'Consent')).toBeVisible();
  await expect(waConsentSwitch(page)).toHaveAttribute('aria-checked', 'true');
  expect(await waSettingsRow(p.project.id)).toBeUndefined();
});

test('SMSWA-138 Meta credential format refusals (offline)', async ({ page }) => {
  const p = await smsProject('smswa-138');
  const phoneNumberId = `9${Date.now()}`;
  const businessAccountId = `8${Date.now()}`;
  const metaCalls = async () => (await stubCalls('meta')).filter((c) => c.path.includes(phoneNumberId) || c.path.includes(businessAccountId));

  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Settings');
  const connect = card(page, 'Provider').getByRole('button', { name: 'Connect Meta Cloud API' });
  await page.getByLabel('Phone number ID', { exact: true }).fill('+919876543210');
  await page.getByLabel('WhatsApp Business Account ID', { exact: true }).fill(businessAccountId);
  await page.getByLabel('Access token', { exact: true }).fill(`EAAG${hex(12)}`);
  await connect.click();
  await expect(
    toastWith(page, 'Could not connect', 'The phone number ID is a long number shown under API Setup in your Meta app — not the phone number itself.'),
  ).toBeVisible();

  await page.getByLabel('Phone number ID', { exact: true }).fill(phoneNumberId);
  await page.getByLabel('WhatsApp Business Account ID', { exact: true }).fill('12345');
  await connect.click();
  await expect(toastWith(page, 'Could not connect', 'The WhatsApp Business Account ID is a long number shown under API Setup.')).toBeVisible();

  await page.getByLabel('WhatsApp Business Account ID', { exact: true }).fill(businessAccountId);
  await page.getByLabel('Access token', { exact: true }).fill('EAAG abc');
  await connect.click();
  await expect(toastWith(page, 'Could not connect', 'Paste a system user access token for the WhatsApp Business Account.')).toBeVisible();

  expect(await waSettingsRow(p.project.id)).toBeUndefined();
  expect(await credentialProviders(p.project.id)).toEqual([]);
  expect(await metaCalls()).toHaveLength(0);

  // A positive control: a well-formed token reaches Meta (the stub) and connects.
  await page.getByLabel('Access token', { exact: true }).fill(`EAAG${hex(12)}`);
  await connect.click();
  await expect(toastTitled(page, 'Meta Cloud API connected')).toBeVisible();
  expect((await metaCalls()).length).toBeGreaterThan(0);
  expect((await waSettingsRow(p.project.id))!.provider).toBe('meta');
});

test('SMSWA-139 Twilio (WhatsApp) credential format refusals (offline)', async ({ page }) => {
  const p = await smsProject('smswa-139');
  const sid = `AC${hex(16)}`;
  const token = hex(16);

  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Settings');
  await waProviderTab(page, 'Twilio').click();
  const connect = card(page, 'Provider').getByRole('button', { name: 'Connect Twilio' });
  const fill = async (accountSid: string, authToken: string, sender: string) => {
    await page.getByLabel('Account SID', { exact: true }).fill(accountSid);
    await page.getByLabel('Auth token', { exact: true }).fill(authToken);
    await page.getByLabel('WhatsApp sender', { exact: true }).fill(sender);
    await connect.click();
  };

  await fill('AC123', token, '+14155550123');
  await expect(toastWith(page, 'Could not connect', 'A Twilio Account SID starts with "AC" followed by 32 characters.')).toBeVisible();
  await fill(sid, 'abc', '+14155550123');
  await expect(toastWith(page, 'Could not connect', 'The Twilio Auth Token is 32 characters, under Account Info in the Console.')).toBeVisible();
  await fill(sid, token, '4155550123');
  await expect(
    toastWith(
      page,
      'Could not connect',
      'The sender is your WhatsApp-enabled Twilio number in international form (+14155550123), or a Messaging Service SID (MG...).',
    ),
  ).toBeVisible();
  expect(await twilioCallsFor(sid)).toHaveLength(0);
  expect(await waSettingsRow(p.project.id)).toBeUndefined();

  // The whatsapp: prefix passes the format check, so the request goes to Twilio (here the stub).
  await fill(sid, token, 'whatsapp:+14155550123');
  await expect(toastTitled(page, 'Twilio connected')).toBeVisible();
  expect((await twilioCallsFor(sid)).map((c) => `${c.method} ${c.path}`)).toEqual([`GET /2010-04-01/Accounts/${sid}.json`]);
});

test('SMSWA-140 Gupshup credential format refusals (offline)', async ({ page }) => {
  const p = await smsProject('smswa-140');
  const appId = `${hex(4)}-${hex(2)}-${hex(2)}`;

  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Settings');
  await waProviderTab(page, 'Gupshup').click();
  const connect = card(page, 'Provider').getByRole('button', { name: 'Connect Gupshup' });
  await page.getByLabel('API key', { exact: true }).fill(`gs${hex(10)}`);
  await page.getByLabel('App name', { exact: true }).fill('shop');
  await page.getByLabel('App ID', { exact: true }).fill(appId);
  await page.getByLabel('Source number', { exact: true }).fill('+919000000000');
  await connect.click();
  await expect(toastWith(page, 'Could not connect', 'The Gupshup app name is the one shown on your app (letters and digits, at least 6).')).toBeVisible();

  await page.getByLabel('App name', { exact: true }).fill('myshopapp');
  await page.getByLabel('App ID', { exact: true }).fill('xyz');
  await connect.click();
  await expect(toastWith(page, 'Could not connect', 'The Gupshup app id is shown on the app overview page.')).toBeVisible();

  await page.getByLabel('App ID', { exact: true }).fill(appId);
  await page.getByLabel('Source number', { exact: true }).fill('9000000000');
  await connect.click();
  await expect(toastWith(page, 'Could not connect', "The source number is your app's WhatsApp number with its country code: +919876543210.")).toBeVisible();

  // A blank required field keeps the button disabled, so the API case is sent directly.
  await page.getByLabel('API key', { exact: true }).fill('   ');
  await expect(connect).toBeDisabled();
  const blankKey = await call('POST', '/api/whatsapp/providers', p.owner, {
    projectId: p.project.id,
    provider: 'gupshup',
    credentials: JSON.stringify({ apiKey: '   ', appName: 'myshopapp', appId, sourceNumber: '+919000000000' }),
  });
  expect([blankKey.status, messageOf(blankKey)]).toEqual([400, 'Paste your Gupshup API key.']);
  expect((await stubCalls('gupshup')).filter((c) => c.path.includes(appId))).toHaveLength(0);
  expect(await waSettingsRow(p.project.id)).toBeUndefined();
});

test('SMSWA-141 Interakt key format refusal (offline)', async ({ page }) => {
  const p = await smsProject('smswa-141');
  await signIn(page, p.owner);
  await openWhatsApp(page, p.project.id, 'Settings');
  await waProviderTab(page, 'Interakt').click();
  await page.getByLabel('Secret key', { exact: true }).fill('abc def');
  await card(page, 'Provider').getByRole('button', { name: 'Connect Interakt' }).click();
  await expect(toastWith(page, 'Could not connect', 'Paste the Secret Key from Interakt → Settings → Developer Setting.')).toBeVisible();
  expect(await waSettingsRow(p.project.id)).toBeUndefined();
  expect(await credentialProviders(p.project.id)).toEqual([]);
});

test('SMSWA-142 connect API validation', async () => {
  const p = await smsProject('smswa-142');
  const connect = (provider: string, credentials: string) =>
    call('POST', '/api/whatsapp/providers', p.owner, { projectId: p.project.id, provider, credentials });

  const telegram = await connect('telegram', '{}');
  expect([telegram.status, messageOf(telegram)]).toEqual([400, 'provider must be one of the following values: meta, twilio_whatsapp, gupshup, interakt']);
  const notJson = await connect('interakt', 'not json');
  expect([notJson.status, messageOf(notJson)]).toEqual([400, 'Credentials must be valid JSON.']);
  const long = await connect('interakt', JSON.stringify({ apiKey: 'k'.repeat(10_000) }));
  expect([long.status, messageOf(long)]).toEqual([400, 'credentials must be shorter than or equal to 10000 characters']);
  expect(await waSettingsRow(p.project.id)).toBeUndefined();
});

test('SMSWA-144 connected summary lines from seeded credentials', async ({ page }) => {
  const meta = await waProject('smswa-144', 'meta');
  const owner = meta.owner;
  const metaUnsigned = await waProject('smswa-144-mu', 'meta', { signed: false }, owner);
  const twilio = await waProject('smswa-144-tw', 'twilio', {}, owner);
  const gupshup = await waProject('smswa-144-gs', 'gupshup', {}, owner);
  const interakt = await waProject('smswa-144-ia', 'interakt', { signed: false }, owner);
  const interaktSigned = await waProject('smswa-144-is', 'interakt', {}, owner);
  const unsigned = `\\s*${escape(UNSIGNED_NOTE)}`;

  const cases: Array<[string, string, RegExp, string]> = [
    [
      meta.project.id,
      'Meta Cloud API',
      new RegExp(
        `^phoneNumberId ${meta.wa.credentials.phoneNumberId}, businessAccountId ${meta.wa.credentials.businessAccountId} · secret ending ${meta.wa.credentials.accessToken.slice(-4)}$`,
      ),
      'Replace and use Meta Cloud API',
    ],
    [
      metaUnsigned.project.id,
      'Meta Cloud API',
      new RegExp(
        `^phoneNumberId ${metaUnsigned.wa.credentials.phoneNumberId}, businessAccountId ${metaUnsigned.wa.credentials.businessAccountId} · secret ending ${metaUnsigned.wa.credentials.accessToken.slice(-4)}${unsigned}$`,
      ),
      'Replace and use Meta Cloud API',
    ],
    [
      twilio.project.id,
      'Twilio',
      new RegExp(`^accountSid ${twilio.wa.credentials.accountSid}, sender ${escape(twilio.wa.credentials.sender)} · secret ending ${twilio.wa.credentials.authToken.slice(-4)}$`),
      'Replace and use Twilio',
    ],
    [
      gupshup.project.id,
      'Gupshup',
      new RegExp(
        `^appName ${gupshup.wa.credentials.appName}, appId ${gupshup.wa.credentials.appId}, sourceNumber ${escape(gupshup.wa.credentials.sourceNumber)} · secret ending ${gupshup.wa.credentials.apiKey.slice(-4)}${unsigned}$`,
      ),
      'Replace and use Gupshup',
    ],
    [interakt.project.id, 'Interakt', new RegExp(`^\\s*· secret ending ${interakt.wa.credentials.apiKey.slice(-4)}${unsigned}$`), 'Replace and use Interakt'],
    [interaktSigned.project.id, 'Interakt', new RegExp(`^\\s*· secret ending ${interaktSigned.wa.credentials.apiKey.slice(-4)}$`), 'Replace and use Interakt'],
  ];

  await signIn(page, owner);
  for (const [projectId, label, line, button] of cases) {
    await openWhatsApp(page, projectId, 'Settings');
    const tab = waProviderTab(page, label);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab.getByText('Active', { exact: true })).toBeVisible();
    await expect(card(page, 'Provider').getByText('Active', { exact: true })).toHaveCount(1);
    await expect(waSummaryLine(page)).toHaveText(line);
    await expect(card(page, 'Provider').getByRole('button', { name: button })).toBeVisible();
  }
});

test('SMSWA-145 webhook block, URLs per provider and Meta verify token', async ({ page }) => {
  const p = await waProject('smswa-145', 'meta');
  const token = p.wa.webhookToken;
  const url = (provider: string) => publicApiUrl(`/api/whatsapp/webhooks/${provider}/${token}`);

  await signIn(page, p.owner);
  await allowClipboard(page);
  await openWhatsApp(page, p.project.id, 'Settings');
  const block = waWebhookBlock(page);
  await expect(block.getByText('Webhook', { exact: true })).toBeVisible();
  await expect(
    block.getByText(
      'In your Meta app, WhatsApp → Configuration → Webhook: paste this URL and the verify token below, then subscribe to the messages and user_preferences fields.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(block.locator('code')).toHaveText([url('meta'), token]);
  expect(token).toMatch(/^[0-9a-f]{48}$/);
  await expect(block.getByText('Verify token', { exact: true })).toBeVisible();

  const copyButtons = block.getByRole('button');
  await expect(copyButtons).toHaveCount(2);
  await copyButtons.nth(0).click();
  await expect(toastTitled(page, 'Copied').first()).toBeVisible();
  expect(await readClipboard(page)).toBe(url('meta'));
  await copyButtons.nth(1).click();
  await expect.poll(() => readClipboard(page)).toBe(token);

  const others: Array<[string, string, string]> = [
    [
      'Twilio',
      'twilio_whatsapp',
      'Delivery reports need no setup — every message asks Twilio to report back. For STOP replies, set this URL as "A message comes in" on your WhatsApp sender, method POST.',
    ],
    [
      'Gupshup',
      'gupshup',
      'On your Gupshup app’s Webhooks page, set this as the callback URL and enable sent, delivered, read and failed events. Gupshup does not sign webhooks, so keep this URL private.',
    ],
    [
      'Interakt',
      'interakt',
      'In Settings → Developer Setting, paste this webhook URL, set a secret key (paste it above too), and tick message sent, delivered, read, failed and received.',
    ],
  ];
  for (const [label, provider, help] of others) {
    await waProviderTab(page, label).click();
    await expect(block.getByText(help, { exact: true })).toBeVisible();
    await expect(block.locator('code')).toHaveText([url(provider)]);
    await expect(block.getByText('Verify token', { exact: true })).toHaveCount(0);
    await block.getByRole('button').click();
    await expect.poll(() => readClipboard(page)).toBe(url(provider));
  }
});

test('SMSWA-148 admin manages providers like the owner', async ({ page }) => {
  const p = await waProject('smswa-148', 'meta');
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const { phoneNumberId, businessAccountId, accessToken } = p.wa.credentials;
  const token = p.wa.webhookToken;

  await signIn(page, admin);
  await allowClipboard(page);
  await openWhatsApp(page, p.project.id, 'Settings');
  await expect(waProviderTab(page, 'Meta Cloud API')).toHaveAttribute('aria-selected', 'true');
  await expect(waSummaryLine(page)).toHaveText(
    `phoneNumberId ${phoneNumberId}, businessAccountId ${businessAccountId} · secret ending ${accessToken.slice(-4)}`,
  );
  const block = waWebhookBlock(page);
  await expect(block.locator('code')).toHaveText([publicApiUrl(`/api/whatsapp/webhooks/meta/${token}`), token]);
  await expect(block.getByRole('button')).toHaveCount(2);
  await block.getByRole('button').nth(1).click();
  await expect.poll(() => readClipboard(page)).toBe(token);
  for (const label of ['Phone number ID', 'WhatsApp Business Account ID', 'Access token', 'App secret (optional)']) {
    await expect(page.getByLabel(label, { exact: true })).toBeEditable();
  }
  await expect(card(page, 'Provider').getByRole('button', { name: 'Replace and use Meta Cloud API' })).toBeVisible();
  await expect(waConsentSwitch(page)).toBeEnabled();

  const status = dataOf(await call('GET', `/api/whatsapp/settings/${p.project.id}`, admin));
  expect(status.verifyToken).toBe(token);
  expect(status.webhookUrls.meta).toBe(publicApiUrl(`/api/whatsapp/webhooks/meta/${token}`));
});

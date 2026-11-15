import { randomBytes } from 'crypto';
import { connectFakeWhatsAppProvider, smsWebhookPath } from '../../support/channels';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  activityOf,
  addMember,
  armBox,
  call,
  campaignRow,
  campaignRows,
  card,
  consentRows,
  dataOf,
  deactivateCredential,
  engagementValue,
  eventRows,
  gupshupPost,
  handTyped,
  holdRequests,
  identifyPhone,
  identifyRaw,
  interaktPost,
  labelledInput,
  labelledSwitch,
  messageOf,
  metaPost,
  metaReply,
  metaStatus,
  mockTemplateList,
  MOCK_TEMPLATES,
  ONLY_OWNERS,
  openSms,
  openWaComposer,
  openWhatsApp,
  PEOPLE,
  postJson,
  postTwilio,
  postTwilioForm,
  PROJECT_NOT_FOUND,
  providerCallsMentioning,
  reachLine,
  recordRequests,
  repliesBlock,
  scheduleWhatsAppCampaign,
  seedCampaignRow,
  seedDetailRow,
  seedEventRow,
  seedPeople,
  setTraits,
  smsPreview,
  smsProject,
  smsSettingsRow,
  sql,
  suppressionRows,
  suspendAccount,
  teammate,
  toastTitled,
  toastWith,
  traitFieldSegment,
  traitSegment,
  twilioCallsFor,
  twilioReply,
  twilioStatus,
  twilioWhatsAppPost,
  uniquePhone,
  waBubble,
  waProblem,
  waProject,
  waProviderTab,
  waSummaryLine,
} from '../../support/areas/smswa';

/**
 * SMS and WhatsApp, fourth round: the WhatsApp composer (hand-typed Interakt templates,
 * a listing provider's templates answered by a page route, media headers and link
 * buttons, reach, A/B arms, the send and test-send refusals), the WhatsApp webhooks
 * (statuses, replies, preferences, keywords and error codes per provider, a provider
 * switch, a suspended tenant), the shared campaign detail page for SMS and WhatsApp rows,
 * and the cross-cutting and second-pass cases (phone normalisation, replayed START,
 * another channel's campaign in a report, consent history per holder, provider error
 * text, sender activity, suppression normalisation, Twilio parsing, test-send order,
 * member settings, reach de-duplication). Provider connections are seeded; the provider
 * stub answers every outbound call.
 */

test.describe.configure({ mode: 'parallel' });

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const SIGNATURE_REFUSED = 'Signature did not verify.';
const SUPPRESSED = 'This address is on the project’s suppression list.';
const OPTED_OUT = 'This person has opted out of these messages.';
const WA_BAD_TEST_NUMBER = 'Enter the number in international form, with its country code: +919876543210.';
const SMS_BAD_TEST_NUMBER = 'Enter the number in international form, with its country code: +14155550123.';
const EMPTY_VALUE = 'Every template value needs something in it; WhatsApp refuses empty ones.';
const WA_NOT_SET_UP = 'WhatsApp is not set up for this project. Connect a provider in WhatsApp settings.';
const WA_NO_PROVIDER = 'Connect a WhatsApp provider in WhatsApp settings before sending.';
const COMPOSER_NOT_SET_UP = 'WhatsApp is not set up yet. Connect a provider first.';
const NO_APPROVED = "No approved templates yet. Create one in your provider's console and wait for Meta to approve it, then refresh.";
const S1_WA = '919876543210';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const later = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const digits = (phone: string) => phone.replace(/^\+/, '');

/** The project's WhatsApp suppressions as address → [reason, detail]. */
async function waSuppressed(projectId: string): Promise<Record<string, [string, string | null]>> {
  const rows = await suppressionRows(projectId, 'whatsapp');
  return Object.fromEntries(rows.map((row) => [row.address, [row.reason, row.detail]]));
}

// ------------------------------------------------------------ M. WhatsApp composer ---

test('SMSWA-162 composer with a provider that cannot list templates (Interakt)', async ({ page }) => {
  const p = await waProject('smswa-162', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  await signIn(page, p.owner);
  const templates = page.waitForResponse((r) => r.url().includes(`/api/whatsapp/templates/${p.project.id}`));
  await openWaComposer(page, p.project.id);
  const answered = await templates;
  expect(answered.status()).toBe(200);
  expect((await answered.json()).data).toEqual({ canList: false, templates: [] });

  const back = page.getByRole('link', { name: 'WhatsApp', exact: true }).filter({ has: page.locator('svg.lucide-arrow-left') });
  await expect(back).toHaveAttribute('href', `/projects/${p.project.id}/whatsapp`);
  const message = card(page, 'Message');
  await expect(message.locator('[data-slot="card-description"]')).toHaveText(
    'Business-started WhatsApp messages must be templates Meta has approved. Fill each value with text or personalisation such as {{firstName|there}}.',
  );
  await expect(page.getByTitle('Refresh templates')).toHaveCount(0);
  await expect(page.getByLabel('Campaign name (optional)')).toHaveAttribute('placeholder', 'Defaults to the template name');
  const code = labelledInput(message, 'Template code name');
  await expect(code).toHaveValue('');
  await expect(code).toHaveAttribute('placeholder', 'order_update');
  await expect(labelledInput(message, 'Language')).toHaveValue('en');
  await expect(labelledInput(message, 'Number of values')).toHaveValue('0');
  await expect(labelledInput(message, 'Header media URL (only if the template has a media header)')).toHaveAttribute(
    'placeholder',
    'https://cdn.yourapp.com/banner.jpg',
  );
  await expect(message.getByRole('combobox')).toHaveCount(0);
  await expect(card(page, 'Preview').getByText('Interakt templates cannot be previewed here; test-send to see it.', { exact: true })).toBeVisible();
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send campaign' })).toBeDisabled();
  // Typing the code name is all that was missing.
  await code.fill('order_update');
  await expect(page.getByRole('button', { name: 'Send campaign' })).toBeEnabled();
});

test('SMSWA-163 hand-typed template: problems shown in order', async ({ page }) => {
  const p = await waProject('smswa-163', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  const message = card(page, 'Message');
  const send = page.getByRole('button', { name: 'Send campaign' });
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();

  // No code name: the "Choose a template." problem is not shown, but it holds the button.
  await expect(waProblem(page)).toHaveCount(0);
  await expect(page.getByText('Choose a template.', { exact: true })).toHaveCount(0);
  await expect(send).toBeDisabled();

  await labelledInput(message, 'Template code name').fill('order_update');
  await expect(waProblem(page)).toHaveCount(0);
  await expect(send).toBeEnabled();

  const language = labelledInput(message, 'Language');
  await language.fill('e');
  await expect(waProblem(page)).toHaveText('The language is a code such as en or en_US.');
  await expect(send).toBeDisabled();

  await language.fill('en_US');
  await labelledInput(message, 'Number of values').fill('2');
  const one = labelledInput(message, '{{1}}');
  const two = labelledInput(message, '{{2}}');
  await expect(one).toHaveAttribute('placeholder', '{{firstName|there}}');
  await expect(two).toHaveAttribute('placeholder', '{{firstName|there}}');
  await expect(waProblem(page)).toHaveText('Fill in every value.');

  await one.fill('{{firstName|there}}');
  await expect(waProblem(page)).toHaveText('Fill in every value.');
  await expect(send).toBeDisabled();

  await two.fill('ORD-1');
  await expect(waProblem(page)).toHaveCount(0);
  await expect(send).toBeEnabled();
});

test('SMSWA-166 send now through Interakt', async ({ page }) => {
  const p = await waProject('smswa-166', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  const name = `Now ${hex(3)}`;
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await page.getByLabel('Campaign name (optional)').fill(name);
  await labelledInput(card(page, 'Message'), 'Template code name').fill('order_update');

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/whatsapp/send') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Send campaign' }).click(),
  ]);
  expect(response.status()).toBe(201);
  expect((await response.json()).data).toMatchObject({ channel: 'whatsapp', status: 'queued', title: name, totalTokens: 1 });
  await expect(toastWith(page, 'Campaign queued', '1 recipient(s).')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/whatsapp$`));
  // The worker may already have taken it from the queue (the provider stub answers at once).
  await expect(campaignRow(page, name)).toContainText(/Queued|Sending|Sent/);

  const rows = await campaignRows(p.project.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ scheduled_at: null, total_tokens: 1 });
  expect(await activityOf(p.project.id, 'campaign.sent')).toHaveLength(1);
  expect(await activityOf(p.project.id, 'campaign.scheduled')).toHaveLength(0);
});

test('SMSWA-167 Interakt header media URL must be https (API check)', async ({ page }) => {
  const p = await waProject('smswa-167', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  const message = card(page, 'Message');
  await labelledInput(message, 'Template code name').fill('order_update');
  await labelledInput(message, 'Header media URL (only if the template has a media header)').fill('http://cdn.example.com/a.jpg');
  await expect(waProblem(page)).toHaveCount(0);

  const send = page.getByRole('button', { name: 'Send campaign' });
  await expect(send).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/whatsapp/send') && r.request().method() === 'POST'),
    send.click(),
  ]);
  expect(response.status()).toBe(400);
  await expect(toastWith(page, 'Could not create campaign', 'content.headerMediaUrl must be a public https URL')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/whatsapp/new$`));
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('SMSWA-168 template list from a listing provider (mocked)', async ({ page }) => {
  const p = await waProject('smswa-168', 'meta');
  await seedPeople(p, p.owner.ip, ['S1']);
  const list = await mockTemplateList(page, Object.values(MOCK_TEMPLATES));
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  await expect.poll(list.requests).toBeGreaterThan(0);

  const message = card(page, 'Message');
  await expect(message.getByTitle('Refresh templates')).toBeVisible();
  const select = message.getByRole('combobox');
  await expect(select).toHaveText('Choose an approved template');
  await expect(message.getByText('Template code name', { exact: true })).toHaveCount(0);
  await expect(card(page, 'Preview').getByText('Choose a template to see it here.', { exact: true })).toBeVisible();

  await select.click();
  await expect(page.getByRole('option')).toHaveText(['T1 · en · utility', 'T2 · en', 'T4 · en']);
  await expect(page.getByRole('option', { name: /^T3/ })).toHaveCount(0);
});

test('SMSWA-170 picking a template builds the value fields and preview', async ({ page }) => {
  const p = await waProject('smswa-170', 'meta');
  await seedPeople(p, p.owner.ip, ['S1']);
  await mockTemplateList(page, [MOCK_TEMPLATES.T1]);
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  const message = card(page, 'Message');
  await message.getByRole('combobox').click();
  await page.getByRole('option', { name: 'T1 · en · utility', exact: true }).click();

  const one = labelledInput(message, '{{1}}');
  const two = labelledInput(message, '{{2}}');
  await expect(one).toHaveValue('');
  await expect(two).toHaveValue('');
  await one.fill('Asha');
  await expect(waProblem(page)).toHaveText('Fill in every value.');
  await expect(waBubble(page)).toHaveText('Hi Asha, your order {{2}} shipped');

  const preview = card(page, 'Preview');
  await preview.getByPlaceholder('Send a test to +…').fill('+14155550111');
  await expect(preview.getByRole('button', { name: 'Test', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send campaign' })).toBeDisabled();
  // Filling the last value clears the problem and the test button.
  await two.fill('ORD-9');
  await expect(waProblem(page)).toHaveCount(0);
  await expect(waBubble(page)).toHaveText('Hi Asha, your order ORD-9 shipped');
  await expect(preview.getByRole('button', { name: 'Test', exact: true })).toBeEnabled();
});

test('SMSWA-172 media header and link buttons', async ({ page }) => {
  const p = await waProject('smswa-172', 'meta');
  await seedPeople(p, p.owner.ip, ['S1']);
  await mockTemplateList(page, [MOCK_TEMPLATES.T2]);
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  const message = card(page, 'Message');
  await message.getByRole('combobox').click();
  await page.getByRole('option', { name: 'T2 · en', exact: true }).click();

  const image = labelledInput(message, 'Header image URL');
  await expect(image).toHaveAttribute('placeholder', 'https://cdn.yourapp.com/banner.jpg');
  await expect(waProblem(page)).toHaveText("Give the header image's public https URL.");
  await image.fill('http://x/y.jpg');
  await expect(waProblem(page)).toHaveText("Give the header image's public https URL.");
  await image.fill('https://cdn.example.com/y.jpg');

  const button = labelledInput(message, 'Link button 1: end of the URL');
  await expect(button).toHaveAttribute('placeholder', 'summer-sale');
  await expect(waProblem(page)).toHaveText('Fill in every link button.');
  await expect(page.getByRole('button', { name: 'Send campaign' })).toBeDisabled();
  await button.fill('summer-sale');
  await expect(waProblem(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send campaign' })).toBeEnabled();

  const lines = waBubble(page).locator('p');
  await expect(lines).toHaveText(['[image]', 'Track']);
  expect((await waBubble(page).innerText()).split(/\n+/)).toEqual(['[image]', 'Our summer sale is on', 'Track']);
});

test('SMSWA-175 templates API outcomes', async () => {
  const p = await waProject('smswa-175', 'interakt', { signed: false });
  const member = await teammate(p.project.id, 'member', p.owner);
  const blank = await smsProject('smswa-175-blank', {}, p.owner);
  const rowOnly = await smsProject('smswa-175-row', {}, p.owner);
  expect((await call('POST', '/api/whatsapp/settings', p.owner, { projectId: rowOnly.project.id })).status).toBe(201);
  const outsider = await smsProject('smswa-175-outsider');
  const templates = (projectId: string, as = p.owner) => call('GET', `/api/whatsapp/templates/${projectId}`, as);

  const notSetUp = await templates(blank.project.id);
  expect([notSetUp.status, messageOf(notSetUp)]).toEqual([404, WA_NOT_SET_UP]);
  const noProvider = await templates(rowOnly.project.id);
  expect([noProvider.status, messageOf(noProvider)]).toEqual([400, WA_NO_PROVIDER]);
  const interakt = await templates(p.project.id, member);
  expect([interakt.status, dataOf(interakt)]).toEqual([200, { canList: false, templates: [] }]);
  const foreign = await templates(p.project.id, outsider.owner);
  expect([foreign.status, messageOf(foreign)]).toEqual([404, PROJECT_NOT_FOUND]);
});

test('SMSWA-177 audience, reach and opt-in wording', async ({ page }) => {
  const p = await waProject('smswa-177', 'interakt', { signed: false });
  for (const key of ['S1', 'S2', 'S3', 'S5']) await identifyPhone(p, p.owner.ip, { ...PEOPLE[key], traits: { group: 'some' } });
  const some = await traitSegment(p.owner, p.project.id, 'some', `SEG-some ${hex(2)}`);
  const empty = await traitSegment(p.owner, p.project.id, 'nobody', `SEG-empty ${hex(2)}`);
  await signIn(page, p.owner);

  // The count is "Counting…" while the preview runs.
  const hold = await holdRequests(page, '**/api/whatsapp/audience-preview');
  await openWaComposer(page, p.project.id);
  await expect.poll(hold.held).toBeGreaterThan(0);
  await expect(reachLine(page)).toHaveText('Counting…');
  hold.release();
  await expect(reachLine(page)).toHaveText('1 recipient(s)');

  await labelledInput(card(page, 'Message'), 'Template code name').fill('order_update');
  const send = page.getByRole('button', { name: 'Send campaign' });
  await expect(send).toBeEnabled();

  const audience = card(page, 'Audience');
  await audience.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'A segment', exact: true }).click();
  const segment = audience.getByRole('combobox').nth(1);
  await expect(segment).toHaveText('Choose a segment');
  await expect(send).toBeDisabled();

  await segment.click();
  await page.getByRole('option', { name: some.name, exact: true }).click();
  await expect(reachLine(page)).toHaveText('1 recipient(s)');
  await expect(send).toBeEnabled();
  await segment.click();
  await page.getByRole('option', { name: empty.name, exact: true }).click();
  await expect(reachLine(page)).toHaveText('Nobody here can be messaged (no one has opted in to WhatsApp yet).');
  await expect(send).toBeDisabled();

  // Opt-in off: the same empty segment, worded without the opt-in clause.
  expect((await call('POST', '/api/whatsapp/settings', p.owner, { projectId: p.project.id, requireOptIn: false })).status).toBe(201);
  await page.reload();
  // S1 and S2 now; S3 opted out and S5 has no country code.
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await audience.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'A segment', exact: true }).click();
  await audience.getByRole('combobox').nth(1).click();
  await page.getByRole('option', { name: empty.name, exact: true }).click();
  await expect(reachLine(page)).toHaveText('Nobody here can be messaged.');
});

test('SMSWA-179 A/B test with template arms', async ({ page }) => {
  const p = await waProject('smswa-179', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await labelledInput(card(page, 'Message'), 'Template code name').fill('order_update');

  const ab = card(page, 'A/B test');
  await expect(ab.locator('[data-slot="card-description"]')).toHaveText('Compare templates or values. Scored on reads and attributed conversions.');
  await labelledSwitch(page, 'A/B test').click();
  const weight = (key: string) => armBox(page, key).locator('input[type="number"]').first();
  const codeOf = (key: string) => labelledInput(armBox(page, key), 'Template code name');
  await expect(ab.locator('div.rounded-md.border')).toHaveCount(2);
  await expect(codeOf('A')).toHaveValue('order_update');
  await expect(codeOf('B')).toHaveValue('');
  await expect(weight('A')).toHaveValue('50');
  await expect(weight('B')).toHaveValue('50');

  await codeOf('B').fill('offer_b');
  await ab.getByRole('button', { name: 'Add arm' }).click();
  await expect(ab.locator('div.rounded-md.border')).toHaveCount(3);
  expect(await Promise.all(['A', 'B', 'C'].map((key) => weight(key).inputValue()))).toEqual(['34', '33', '33']);

  await armBox(page, 'B').getByRole('button').click();
  await expect(ab.locator('div.rounded-md.border')).toHaveCount(2);
  await expect(page.getByText('Arm C', { exact: true })).toHaveCount(0);
  // The old C is now B, empty, and the weights are even again.
  await expect(codeOf('A')).toHaveValue('order_update');
  await expect(codeOf('B')).toHaveValue('');
  await expect(weight('A')).toHaveValue('50');
  await expect(weight('B')).toHaveValue('50');

  await codeOf('B').fill('offer_c');
  await weight('A').fill('60');
  await weight('B').fill('40');
  await expect(ab.getByText(/^Weights add up to/)).toHaveCount(0);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/whatsapp/send') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Start experiment' }).click(),
  ]);
  expect(response.status()).toBe(201);
  await expect(toastWith(page, 'Experiment created', '1 recipient(s).')).toBeVisible();

  const [row] = await campaignRows(p.project.id);
  expect(row.status).toBe('scheduled');
  expect(row.variants).toHaveLength(2);
  expect(row.variants.map((v: any) => [v.key, v.title, v.weight, v.body, v.whatsapp.template.id])).toEqual([
    ['A', 'A', 60, 'Template order_update (en)', 'order_update'],
    ['B', 'B', 40, 'Template offer_c (en)', 'offer_c'],
  ]);
});

test('SMSWA-180 A/B arms must each be valid', async ({ page }) => {
  const p = await waProject('smswa-180', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  await expect(page.getByText('1 recipient(s)', { exact: true })).toBeVisible();
  await labelledInput(card(page, 'Message'), 'Template code name').fill('order_update');
  await labelledSwitch(page, 'A/B test').click();
  const start = page.getByRole('button', { name: 'Start experiment' });

  await expect(start).toBeDisabled();
  await expect(page.locator('p.text-destructive')).toHaveCount(0);
  await expect(page.getByText('Choose a template.', { exact: true })).toHaveCount(0);

  await labelledInput(armBox(page, 'B'), 'Template code name').fill('offer_b');
  await expect(start).toBeEnabled();

  await armBox(page, 'A').locator('input[type="number"]').first().fill('70');
  await armBox(page, 'B').locator('input[type="number"]').first().fill('40');
  await expect(card(page, 'A/B test').getByText('Weights add up to 110%, not 100%.', { exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
});

test('SMSWA-181 experiment and content validation in the API', async () => {
  const p = await waProject('smswa-181', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1']);
  const send = (content: Record<string, any>, extra: Record<string, unknown> = {}) =>
    call('POST', '/api/whatsapp/send', p.owner, { projectId: p.project.id, content, scheduledAt: later(), ...extra });
  const valid = handTyped('order_update', ['Asha']);
  const arm = (key: string, weight: number, content: Record<string, unknown> = valid) => ({ key, title: key, weight, content });

  const blank = await send(handTyped('order_update', [' ']));
  expect([blank.status, blank.body.message]).toEqual([400, EMPTY_VALUE]);
  const language = await send({ ...valid, template: { id: 'order_update', name: 'order_update', language: 'english' } });
  expect([language.status, language.body.message]).toEqual([400, ['content.template.language must be a code such as en or en_US']]);
  const many = await send(handTyped('order_update', Array(51).fill('x')));
  expect([many.status, many.body.message]).toEqual([400, ['content.bodyParams must contain no more than 50 elements']]);
  const buttons = await send({ ...valid, buttonParams: ['a', 'b', 'c'] });
  expect([buttons.status, buttons.body.message]).toEqual([400, ['content.buttonParams must contain no more than 2 elements']]);
  const audio = await send({ ...valid, headerMediaType: 'audio' });
  expect([audio.status, audio.body.message]).toEqual([400, ['content.headerMediaType must be one of the following values: image, video, document']]);
  const one = await send(valid, { variants: [arm('A', 100)] });
  expect([one.status, one.body.message]).toEqual([400, 'An experiment needs at least two variants.']);
  const zero = await send(valid, { variants: [arm('A', 100), arm('B', 0)] });
  expect([zero.status, zero.body.message]).toEqual([400, 'Every variant needs a weight above zero.']);
  const emptyArm = await send(valid, { variants: [arm('A', 50), arm('B', 50, handTyped('order_update', ['']))] });
  expect([emptyArm.status, emptyArm.body.message]).toEqual([400, EMPTY_VALUE]);
  expect(await campaignRows(p.project.id)).toHaveLength(0);

  // The same experiment with a value in every arm is taken.
  const accepted = await send(valid, { variants: [arm('A', 50), arm('B', 50)] });
  expect(accepted.status).toBe(201);
  expect(await campaignRows(p.project.id)).toHaveLength(1);
});

test('SMSWA-184 composer on a project without a provider', async ({ page }) => {
  const p = await smsProject('smswa-184');
  expect((await call('POST', '/api/whatsapp/settings', p.owner, { projectId: p.project.id })).status).toBe(201);
  const templateRequests = recordRequests(page, 'GET', /\/api\/whatsapp\/templates\//);
  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);

  const notice = page.locator('[data-slot="card"]').filter({ hasText: COMPOSER_NOT_SET_UP });
  await expect(notice).toHaveText(COMPOSER_NOT_SET_UP);
  const message = card(page, 'Message');
  await expect(message.getByRole('combobox')).toHaveText('Choose an approved template');
  await expect(message.getByText(NO_APPROVED, { exact: true })).toBeVisible();
  await expect(message.getByTitle('Refresh templates')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send campaign' })).toBeDisabled();
  await card(page, 'Preview').getByPlaceholder('Send a test to +…').fill('+14155550111');
  await expect(card(page, 'Preview').getByRole('button', { name: 'Test', exact: true })).toBeDisabled();
  expect(templateRequests).toHaveLength(0);

  await notice.getByRole('link', { name: 'Connect a provider' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/whatsapp$`));
  await expect(page.getByRole('heading', { level: 1, name: 'WhatsApp', exact: true })).toBeVisible();
  expect(templateRequests).toHaveLength(0);
});

test('SMSWA-185 composer test send refusals', async ({ page, browser, baseURL }) => {
  const p = await waProject('smswa-185', 'interakt', { signed: false });
  await seedPeople(p, p.owner.ip, ['S1', 'S3']);
  expect((await call('POST', '/api/whatsapp/suppressions', p.owner, { projectId: p.project.id, address: '+14155550199' })).status).toBe(201);
  const admin = await teammate(p.project.id, 'admin', p.owner);

  await signIn(page, p.owner);
  await openWaComposer(page, p.project.id);
  const message = card(page, 'Message');
  const preview = card(page, 'Preview');
  const to = preview.getByPlaceholder('Send a test to +…');
  const testButton = preview.getByRole('button', { name: 'Test', exact: true });
  await to.fill('+14155550199');
  // A problem in the content holds the button, and so does a number without a plus.
  await expect(testButton).toBeDisabled();
  await labelledInput(message, 'Template code name').fill('order_update');
  await expect(testButton).toBeEnabled();
  await to.fill('14155550199');
  await expect(testButton).toBeDisabled();

  const cases: Array<[string, string]> = [
    ['+14155550199', SUPPRESSED],
    [PEOPLE.S3.phone!, OPTED_OUT],
    ['+12', WA_BAD_TEST_NUMBER],
  ];
  for (const [number, error] of cases) {
    await to.fill(number);
    await testButton.click();
    await expect(toastWith(page, 'Test failed', error), number).toBeVisible();
  }
  expect(await providerCallsMentioning('interakt', '4155550199')).toHaveLength(0);
  expect(await providerCallsMentioning('interakt', '7700900123')).toHaveLength(0);

  // An admin of a project whose billing owner is suspended.
  await suspendAccount(p.owner.userId);
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const adminPage = await context.newPage();
    await signIn(adminPage, admin);
    await openWaComposer(adminPage, p.project.id);
    await labelledInput(card(adminPage, 'Message'), 'Template code name').fill('order_update');
    await card(adminPage, 'Preview').getByPlaceholder('Send a test to +…').fill('+14155550111');
    const [answered] = await Promise.all([
      adminPage.waitForResponse((r) => r.url().endsWith('/api/whatsapp/test-send')),
      card(adminPage, 'Preview').getByRole('button', { name: 'Test', exact: true }).click(),
    ]);
    expect(answered.status()).toBe(403);
    await expect(toastWith(adminPage, 'Test failed', "This project's account is suspended.")).toBeVisible();
  } finally {
    await context.close();
  }
  expect(await providerCallsMentioning('interakt', '4155550111')).toHaveLength(0);
});

// ------------------------------------------------------------ O. WhatsApp webhooks ---

test('SMSWA-196 provider URL without stored credentials', async () => {
  const p = await waProject('smswa-196', 'meta');
  const raw = JSON.stringify({ type: 'message_received', data: {} });
  for (const provider of ['interakt', 'twilio_whatsapp']) {
    const answered = await postJson(`/api/whatsapp/webhooks/${provider}/${p.wa.webhookToken}`, raw);
    expect([answered.status, messageOf(answered)]).toEqual([403, `Connect ${provider} in WhatsApp settings to receive its webhooks.`]);
  }
  // The provider that is stored takes its own URL.
  expect((await metaPost(p.wa, { statuses: [] })).status).toBe(200);
});

test('SMSWA-199 Meta read and failed statuses, sent ignored', async () => {
  const p = await waProject('smswa-199', 'meta');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const c = await seedCampaignRow(p.project.id, 'whatsapp');

  const read = await metaPost(p.wa, { statuses: [metaStatus(S1_WA, 'read', { c, i: S1 })] });
  expect([read.status, read.body]).toEqual([200, { recorded: 1 }]);
  const failed = await metaPost(p.wa, {
    statuses: [metaStatus(S1_WA, 'failed', { c, i: S1 }, { errors: [{ code: 131049, title: 'Ecosystem' }] })],
  });
  expect([failed.status, failed.body]).toEqual([200, { recorded: 1 }]);
  const sent = await metaPost(p.wa, { statuses: [metaStatus(S1_WA, 'sent', { c, i: S1 })] });
  expect([sent.status, sent.body]).toEqual([200, { recorded: 0 }]);

  const events = await eventRows(p.project.id);
  expect(events.map((e) => [e.type, e.campaign_id, e.device_identity_id, e.platform, e.metadata])).toEqual([
    ['impression', c, S1, 'whatsapp', null],
    ['bounced', c, S1, 'whatsapp', { detail: 'Ecosystem' }],
  ]);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
});

test('SMSWA-202 Meta START older than the STOP does not lift it', async () => {
  const p = await waProject('smswa-202', 'meta');
  await seedPeople(p, p.owner.ip, ['S1']);
  const stop = await metaPost(p.wa, { messages: [metaReply(S1_WA, 'STOP')] });
  expect(stop.status).toBe(200);
  expect(Object.keys(await waSuppressed(p.project.id))).toEqual(['+919876543210']);

  // A redelivered reply from an hour before the STOP arrived.
  const old = await metaPost(p.wa, { messages: [metaReply(S1_WA, 'START', Math.floor(Date.now() / 1000) - 3600)] });
  expect([old.status, old.body]).toEqual([200, { recorded: 0 }]);
  expect(Object.keys(await waSuppressed(p.project.id))).toEqual(['+919876543210']);

  // A START at the API's own time lifts it.
  expect((await metaPost(p.wa, { messages: [metaReply(S1_WA, 'START')] })).status).toBe(200);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
});

test('SMSWA-203 Meta user_preferences stop and resume', async () => {
  const p = await waProject('smswa-203', 'meta');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const other = uniquePhone();
  await identifyPhone(p, p.owner.ip, { phone: other, whatsappOptIn: true });
  const preference = (waId: string, category: string, value: string) => ({ user_preferences: [{ wa_id: waId, category, value }] });

  expect((await metaPost(p.wa, preference(S1_WA, 'marketing_messages', 'stop'))).status).toBe(200);
  expect(await waSuppressed(p.project.id)).toEqual({ '+919876543210': ['unsubscribed', 'Replied "STOP"'] });
  expect((await consentRows(S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply' });

  expect((await metaPost(p.wa, preference(S1_WA, 'marketing_messages', 'resume'))).status).toBe(200);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
  expect((await consentRows(S1)).at(-1)).toEqual({ channel: 'whatsapp', granted: true, source: 'start_reply' });

  const ignored = await metaPost(p.wa, preference(digits(other), 'other', 'stop'));
  expect([ignored.status, ignored.body]).toEqual([200, { recorded: 0 }]);
  expect(await suppressionRows(p.project.id, 'whatsapp')).toHaveLength(0);
});

test('SMSWA-204 keyword rules for WhatsApp replies', async () => {
  const p = await waProject('smswa-204', 'meta');
  const n: Record<string, string> = {};
  for (const key of ['optOut', 'optout', 'unsubscribe', 'stopPlease', 'subscribe', 'optIn', 'yes', 'interactive', 'button']) {
    n[key] = uniquePhone();
    await identifyPhone(p, p.owner.ip, { phone: n[key], whatsappOptIn: true });
  }
  const reply = (key: string, text: string) => metaPost(p.wa, { messages: [metaReply(digits(n[key]), text)] });
  const message = (key: string, extra: Record<string, unknown>) =>
    metaPost(p.wa, { messages: [{ from: digits(n[key]), id: `wamid.${hex(8)}`, ...extra }] });

  for (const [key, text] of [['optOut', 'opt out'], ['optout', 'OPTOUT'], ['unsubscribe', 'Unsubscribe!'], ['stopPlease', 'stop please']]) {
    expect((await reply(key, text)).status).toBe(200);
  }
  expect((await message('interactive', { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'STOP' } } })).status).toBe(200);
  expect((await message('button', { type: 'button', button: { payload: 'STOP' } })).status).toBe(200);
  for (const key of ['subscribe', 'optIn', 'yes']) expect((await reply(key, 'STOP')).status).toBe(200);
  for (const [key, text] of [['subscribe', 'SUBSCRIBE'], ['optIn', 'opt in'], ['yes', 'YES']]) {
    expect((await reply(key, text)).status).toBe(200);
  }

  const suppressed = await waSuppressed(p.project.id);
  expect(Object.keys(suppressed).sort()).toEqual([n.optOut, n.optout, n.unsubscribe, n.interactive, n.button, n.yes].sort());
  expect(suppressed[n.optOut]).toEqual(['unsubscribed', 'Replied "opt out"']);
  expect(suppressed[n.unsubscribe]).toEqual(['unsubscribed', 'Replied "Unsubscribe!"']);
  expect(suppressed[n.yes]).toEqual(['unsubscribed', 'Replied "STOP"']);
});

test('SMSWA-207 Twilio WhatsApp error codes', async () => {
  const p = await waProject('smswa-207', 'twilio');
  const c = await seedCampaignRow(p.project.id, 'whatsapp');
  const codes = ['21610', '63024', '63003', '21211', '63016'];
  const phones: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const code of codes) {
    phones[code] = uniquePhone();
    ids[code] = await identifyPhone(p, p.owner.ip, { phone: phones[code], whatsappOptIn: true });
  }
  for (const code of codes) {
    const answered = await twilioWhatsAppPost(
      p.wa,
      {
        MessageStatus: 'undelivered',
        To: `whatsapp:${phones[code]}`,
        ErrorCode: code,
        AccountSid: p.wa.credentials.accountSid,
        ...(code === '63024' ? { ChannelStatusMessage: 'Recipient is not a WhatsApp user' } : {}),
      },
      { c, i: ids[code] },
    );
    expect([code, answered.status, answered.text]).toEqual([code, 200, EMPTY_TWIML]);
  }

  expect(await waSuppressed(p.project.id)).toEqual({
    [phones['21610']]: ['unsubscribed', 'Error 21610'],
    [phones['63024']]: ['bounced', 'Recipient is not a WhatsApp user'],
    [phones['63003']]: ['bounced', 'Error 63003'],
    [phones['21211']]: ['bounced', 'Error 21211'],
  });
  const events = await eventRows(p.project.id);
  expect(events).toHaveLength(5);
  expect(events.every((e) => e.type === 'bounced' && e.campaign_id === c)).toBe(true);
  expect(events.find((e) => e.device_identity_id === ids['63016'])?.metadata).toEqual({ detail: '63016' });
  // The 21610 holder's history records the STOP; the bounces record nothing.
  expect((await consentRows(ids['21610'])).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply' });
  expect((await consentRows(ids['63024'])).filter((row) => row.channel === 'whatsapp' && !row.granted)).toHaveLength(0);
});

test('SMSWA-209 Gupshup failure codes', async () => {
  const p = await waProject('smswa-209', 'gupshup');
  const codes = ['1002', '1012', '131026', '131050', '9999'];
  const phones: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const code of codes) {
    phones[code] = uniquePhone();
    ids[code] = await identifyPhone(p, p.owner.ip, { phone: phones[code], whatsappOptIn: true });
  }
  for (const code of codes) {
    const answered = await gupshupPost(p.wa.webhookToken, {
      type: 'message-event',
      payload: { type: 'failed', destination: digits(phones[code]), payload: { code: Number(code), reason: `Gupshup says ${code}` } },
    });
    expect([code, answered.status]).toEqual([code, 200]);
  }

  expect(await waSuppressed(p.project.id)).toEqual({
    [phones['1002']]: ['bounced', 'Gupshup says 1002'],
    [phones['1012']]: ['unsubscribed', 'Gupshup says 1012'],
    [phones['131026']]: ['bounced', 'Gupshup says 131026'],
    [phones['131050']]: ['unsubscribed', 'Gupshup says 131050'],
  });
  for (const code of ['1012', '131050']) {
    expect((await consentRows(ids[code])).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply_unsigned' });
  }
});

test('SMSWA-212 webhooks keep working while the tenant is suspended', async () => {
  const p = await waProject('smswa-212', 'meta', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S1', 'S2']);
  await suspendAccount(p.owner.userId);

  const wa = await metaPost(p.wa, { messages: [metaReply(S1_WA, 'STOP')] });
  expect([wa.status, wa.body]).toEqual([200, { recorded: 0 }]);
  const sms = await twilioReply(p.sms!, PEOPLE.S2.phone!, 'STOP');
  expect([sms.status, sms.text]).toEqual([200, EMPTY_TWIML]);

  expect((await suppressionRows(p.project.id, 'whatsapp')).map((row) => [row.address, row.reason])).toEqual([['+919876543210', 'unsubscribed']]);
  expect((await suppressionRows(p.project.id, 'sms')).map((row) => [row.address, row.reason])).toEqual([['+14155550111', 'unsubscribed']]);
});

// ------------------------------------------------------------ P. Campaign detail ---

test('SMSWA-215 SMS campaign detail', async ({ page }) => {
  const p = await smsProject('smswa-215', { twilio: true });
  const id = await seedDetailRow(p.project.id, 'sms', {
    title: 'Promo',
    body: 'Hi {{firstName}}',
    totalTokens: 4,
    successCount: 3,
    failureCount: 1,
    failureDetails: [{ token: '+14155550111', error: '21211 not a valid phone number' }],
  });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${id}`);

  const heading = page.getByRole('heading', { level: 1, name: 'Promo', exact: true });
  await expect(heading).toBeVisible();
  await expect(heading.locator('..').locator('[data-slot="badge"]')).toHaveText(['SMS', 'Sent']);
  const text = card(page, 'Text');
  await expect(text.locator('[data-slot="card-description"]')).toHaveText('As written; personalised and given the opt-out line per person.');
  await expect(text.locator('div.whitespace-pre-wrap')).toHaveText('Hi {{firstName}}');

  const engagement = card(page, 'Engagement');
  await expect(engagement.locator('[data-slot="card-description"]')).toHaveText(
    "Reported by Twilio's delivery callbacks. Texts have no opens or clicks to report.",
  );
  await expect(engagement.locator('div.rounded-lg.border div.text-xs')).toHaveText(['Delivered', 'Undelivered']);
  await expect(engagement.getByText('Click-through rate')).toHaveCount(0);
  await expect(engagement.getByText('Nothing reported yet. Twilio reports deliveries to this API, which it can only reach on a public URL.', { exact: true })).toBeVisible();

  const delivery = card(page, 'Delivery');
  await expect(delivery.locator('[data-slot="card-description"]')).toHaveText(
    'Accepted is what Twilio took from us; Delivered above is what the carrier confirmed reached the phone.',
  );
  const accepted = delivery.locator('div.rounded-lg.border').filter({ hasText: 'Accepted by Twilio' });
  await expect(accepted.locator('p.text-2xl')).toHaveText('3 / 4');
  await expect(delivery.locator('div.rounded-lg.border').filter({ hasText: /^\s*Failed/ }).locator('p.text-2xl')).toHaveText('1');
  await expect(delivery.getByRole('columnheader')).toHaveText(['Number', 'Twilio error']);
  await expect(delivery.getByRole('cell').first()).toHaveText('…4155550111');
});

test('SMSWA-216 WhatsApp campaign detail', async ({ page }) => {
  const p = await waProject('smswa-216', 'meta');
  const id = await seedDetailRow(p.project.id, 'whatsapp', {
    title: `Order news ${hex(2)}`,
    body: 'Hi Asha',
    totalTokens: 2,
    successCount: 1,
    failureCount: 1,
    failureDetails: [{ token: '+14155550111', error: '131026 undeliverable' }],
    whatsappContent: {
      template: { id: 'order_update', name: 'order_update', language: 'en', category: 'UTILITY', paramNames: null },
      bodyParams: [],
      headerText: null,
      headerMediaUrl: 'https://cdn.example.com/a.jpg',
      headerMediaType: 'image',
      buttonParams: [],
      previewText: null,
    },
  });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${id}`);

  await expect(page.getByRole('heading', { level: 1 }).locator('..').locator('[data-slot="badge"]')).toHaveText(['WhatsApp', 'Sent']);
  const template = card(page, 'Template');
  await expect(template.locator('[data-slot="card-description"]')).toHaveText('order_update · en · utility');
  await expect(template.locator('div.whitespace-pre-wrap')).toHaveText('Hi Asha');
  await expect(template.getByText('Header: https://cdn.example.com/a.jpg', { exact: true })).toBeVisible();

  const engagement = card(page, 'Engagement');
  await expect(engagement.locator('[data-slot="card-description"]')).toHaveText(
    "Reported by your WhatsApp provider's webhook. Read needs the person's read receipts on.",
  );
  await expect(engagement.locator('div.rounded-lg.border div.text-xs')).toHaveText(['Delivered', 'Read', 'Failed']);
  await expect(
    engagement.getByText('Nothing reported yet. Your provider reports deliveries to this API, which it can only reach on a public URL.', { exact: true }),
  ).toBeVisible();
  const delivery = card(page, 'Delivery');
  await expect(delivery.locator('[data-slot="card-description"]')).toHaveText(
    'Accepted is what your provider took from us; Delivered above is what WhatsApp confirmed reached the phone.',
  );
  await expect(delivery.getByText('Accepted by provider', { exact: true })).toBeVisible();
  await expect(delivery.getByRole('columnheader')).toHaveText(['Number', 'Provider error']);
  await expect(page.getByRole('link').filter({ has: page.locator('svg.lucide-arrow-left') })).toHaveAttribute('href', `/projects/${p.project.id}/whatsapp`);
});

test('SMSWA-218 engagement numbers on the detail page', async ({ page }) => {
  const sms = await smsProject('smswa-218-sms', { twilio: true });
  const s = await seedPeople(sms, sms.owner.ip, ['S1', 'S2', 'S4']);
  const smsId = await seedDetailRow(sms.project.id, 'sms', { title: `Texts ${hex(2)}`, body: 'Hello', totalTokens: 3, successCount: 3 });
  await seedEventRow(sms.project.id, smsId, s.S1, 'delivered', 'sms');
  await seedEventRow(sms.project.id, smsId, s.S2, 'delivered', 'sms');
  await seedEventRow(sms.project.id, smsId, s.S4, 'bounced', 'sms');

  const wa = await waProject('smswa-218-wa', 'interakt', {}, sms.owner);
  const w = await seedPeople(wa, sms.owner.ip, ['S1', 'S2', 'S4']);
  const waId = await seedDetailRow(wa.project.id, 'whatsapp', {
    title: `Templates ${hex(2)}`,
    body: 'Template order_update (en)',
    totalTokens: 3,
    successCount: 3,
    whatsappContent: { template: { id: 'order_update', name: 'order_update', language: 'en' }, bodyParams: [], buttonParams: [] },
  });
  await seedEventRow(wa.project.id, waId, w.S1, 'delivered', 'whatsapp');
  await seedEventRow(wa.project.id, waId, w.S1, 'impression', 'whatsapp');
  await seedEventRow(wa.project.id, waId, w.S2, 'impression', 'whatsapp');
  await seedEventRow(wa.project.id, waId, w.S4, 'bounced', 'whatsapp');

  await signIn(page, sms.owner);
  await page.goto(`/projects/${sms.project.id}/push-notifications/${smsId}`);
  await expect(engagementValue(page, 'Delivered')).toHaveText('2');
  await expect(engagementValue(page, 'Undelivered')).toHaveText('1');
  await expect(page.getByText(/^Nothing reported yet/)).toHaveCount(0);

  await page.goto(`/projects/${wa.project.id}/push-notifications/${waId}`);
  await expect(engagementValue(page, 'Delivered')).toHaveText('1');
  await expect(engagementValue(page, 'Read')).toHaveText('2');
  await expect(engagementValue(page, 'Failed')).toHaveText('1');
  await expect(page.getByText(/^Nothing reported yet/)).toHaveCount(0);
});

test('SMSWA-219 cancel a scheduled SMS or WhatsApp campaign', async ({ page }) => {
  const p = await waProject('smswa-219', 'interakt', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S1']);
  const smsName = `Later text ${hex(2)}`;
  const waName = `Later template ${hex(2)}`;
  const smsCampaign = dataOf(await call('POST', '/api/sms/send', p.owner, { projectId: p.project.id, name: smsName, body: 'See you', scheduledAt: later() }));
  const waCampaign = dataOf(await scheduleWhatsAppCampaign(p.owner, p.project.id, { name: waName }));
  await signIn(page, p.owner);

  for (const [campaign, name, channel] of [[smsCampaign, smsName, 'sms'], [waCampaign, waName, 'whatsapp']] as const) {
    await page.goto(`/projects/${p.project.id}/push-notifications/${campaign.id}`);
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel campaign' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this campaign?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel campaign' }).click();
    await expect(toastTitled(page, 'Campaign cancelled')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    const viaApi = dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${campaign.id}`, p.owner));
    expect([channel, viaApi.status]).toEqual([channel, 'cancelled']);

    if (channel === 'sms') await openSms(page, p.project.id, 'Campaigns');
    else await openWhatsApp(page, p.project.id, 'Campaigns');
    await expect(campaignRow(page, name)).toContainText('Cancelled');
  }
  const cancelled = await activityOf(p.project.id, 'campaign.cancelled');
  expect(cancelled.map((entry) => entry.details.channel).sort()).toEqual(['sms', 'whatsapp']);
});

// ------------------------------------------------------------ Q. Cross-cutting ---

test('SMSWA-221 phone normalisation from identify decides who is reachable', async () => {
  const p = await smsProject('smswa-221', { twilio: true, requireOptIn: false });
  const stored = async (id: string) => (await sql(`SELECT phone, phone_e164 FROM device_identities WHERE id = $1`, [id]))[0];
  const cases: Array<[string, string | null]> = [
    ['+1 (415) 555-0123', '+14155550123'],
    ['0044 7700 900123', '+447700900123'],
    ['9876543210', null],
    ['+0123456789', null],
  ];
  for (const [phone, e164] of cases) {
    const id = await identifyPhone(p, p.owner.ip, { phone });
    expect(await stored(id)).toEqual({ phone, phone_e164: e164 });
  }
  const long = await identifyRaw(p, p.owner.ip, { phone: '+1'.padEnd(21, '5') });
  expect([long.status, messageOf(long)]).toEqual([400, 'phone must be shorter than or equal to 20 characters']);
  expect((await smsPreview(p.owner, p.project.id)).recipients).toBe(2);
});

test('SMSWA-225 a replayed SMS START after a later STOP', async () => {
  test.info().annotations.push({ type: 'issue', description: 'SMSWA-225' });
  const p = await smsProject('smswa-225', { twilio: true });
  await seedPeople(p, p.owner.ip, ['S2']);
  const sms = p.sms!;
  const start = { AccountSid: sms.credentials.accountSid, From: PEOPLE.S2.phone!, To: sms.sender, Body: 'START', MessageSid: `SM${hex(16)}` };
  const post = () => postTwilio(smsWebhookPath(sms.webhookToken, 'inbound'), start, { authToken: sms.credentials.authToken });

  expect((await post()).status).toBe(200);
  expect((await twilioReply(sms, PEOPLE.S2.phone!, 'STOP')).status).toBe(200);
  expect((await suppressionRows(p.project.id)).map((row) => row.address)).toEqual([PEOPLE.S2.phone]);

  // As the case is written: the result recorded for the request sent again byte for byte.
  const replay = await post();
  expect([replay.status, replay.text]).toEqual([200, EMPTY_TWIML]);
  expect(await suppressionRows(p.project.id)).toHaveLength(0);
});

// ------------------------------------------------------------ R. Second pass ---

test('SMSWA-227 after a provider switch, a signed report from the earlier provider is still taken', async () => {
  const p = await waProject('smswa-227', 'meta');
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const c = await seedCampaignRow(p.project.id, 'whatsapp');
  await connectFakeWhatsAppProvider(p.project.id, 'interakt');
  expect((await sql(`SELECT provider FROM whatsapp_settings WHERE project_id = $1`, [p.project.id]))[0].provider).toBe('interakt');
  const value = { statuses: [metaStatus(S1_WA, 'delivered', { c, i: S1 })] };

  const signed = await metaPost(p.wa, value);
  expect([signed.status, signed.body]).toEqual([200, { recorded: 1 }]);
  expect((await eventRows(p.project.id)).map((e) => [e.type, e.platform, e.campaign_id, e.device_identity_id])).toEqual([['delivered', 'whatsapp', c, S1]]);
  for (const signature of [null, 'sha256=00']) {
    const refused = await metaPost(p.wa, value, signature);
    expect([refused.status, messageOf(refused)]).toEqual([401, SIGNATURE_REFUSED]);
  }

  const unsigned = await waProject('smswa-227-unsigned', 'meta', { signed: false }, p.owner);
  const { S1: U1 } = await seedPeople(unsigned, p.owner.ip, ['S1']);
  const cu = await seedCampaignRow(unsigned.project.id, 'whatsapp');
  const unsignedValue = { statuses: [metaStatus(S1_WA, 'delivered', { c: cu, i: U1 })] };
  // Before the switch the same unsigned report counts.
  expect((await metaPost(unsigned.wa, unsignedValue)).body).toEqual({ recorded: 1 });
  await connectFakeWhatsAppProvider(unsigned.project.id, 'interakt');
  const read = { statuses: [metaStatus(S1_WA, 'read', { c: cu, i: U1 })] };
  const refused = await metaPost(unsigned.wa, read);
  expect([refused.status, messageOf(refused)]).toEqual([403, 'This project no longer sends WhatsApp through meta.']);
  expect((await eventRows(unsigned.project.id)).map((e) => e.type)).toEqual(['delivered']);
});

test('SMSWA-228 WhatsApp stored credentials missing or unreadable', async ({ page }) => {
  const p = await waProject('smswa-228', 'interakt');
  await seedPeople(p, p.owner.ip, ['S1']);
  const id = p.project.id;
  expect(dataOf(await call('GET', `/api/whatsapp/settings/${id}`, p.owner)).readyToSend).toBe(true);
  await deactivateCredential(id, 'interakt');
  const unreadable = 'The interakt credentials for this project are missing or unreadable. Reconnect the provider.';

  // 1. Status.
  expect(dataOf(await call('GET', `/api/whatsapp/settings/${id}`, p.owner))).toMatchObject({ configured: true, readyToSend: false, providers: [] });

  // 2. The page and its Settings tab.
  await signIn(page, p.owner);
  await page.goto(`/projects/${id}/whatsapp`);
  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('WhatsApp is not set up yet. Connect a provider under Settings.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const interakt = waProviderTab(page, 'Interakt');
  await expect(interakt).toHaveAttribute('aria-selected', 'true');
  await expect(interakt).toHaveText('Interakt Active');
  await expect(waSummaryLine(page)).toHaveCount(0);
  await expect(card(page, 'Provider').getByRole('button', { name: 'Connect Interakt', exact: true })).toBeVisible();

  // 3. The composer.
  const templateRequests = recordRequests(page, 'GET', /\/api\/whatsapp\/templates\//);
  await openWaComposer(page, id);
  await expect(page.getByText(COMPOSER_NOT_SET_UP, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send campaign' })).toBeDisabled();
  await card(page, 'Preview').getByPlaceholder('Send a test to +…').fill('+919876543210');
  await expect(card(page, 'Preview').getByRole('button', { name: 'Test', exact: true })).toBeDisabled();
  expect(templateRequests).toHaveLength(0);

  // 4. The API.
  const answers = [
    await scheduleWhatsAppCampaign(p.owner, id),
    await call('POST', '/api/whatsapp/test-send', p.owner, { projectId: id, to: '+919876543210', content: handTyped() }),
    await call('GET', `/api/whatsapp/templates/${id}`, p.owner),
  ];
  expect(answers.map((a) => [a.status, messageOf(a)])).toEqual(Array(3).fill([400, unreadable]));
  expect(await campaignRows(id)).toHaveLength(0);

  // 5. Its webhook.
  const hook = await interaktPost(p.wa, { type: 'message_received', data: { customer: { channel_phone_number: S1_WA }, message: { message: 'STOP' } } });
  expect([hook.status, messageOf(hook)]).toEqual([403, 'Connect interakt in WhatsApp settings to receive its webhooks.']);
  expect(await suppressionRows(id, 'whatsapp')).toHaveLength(0);
});

test("SMSWA-231 a delivery report naming another channel's campaign in the same project", async () => {
  const p = await smsProject('smswa-231', { twilio: true });
  const { S1 } = await seedPeople(p, p.owner.ip, ['S1']);
  const cp = await seedCampaignRow(p.project.id, 'push');
  const cw = await seedCampaignRow(p.project.id, 'whatsapp');
  const delivered = { MessageStatus: 'delivered', To: '+919876543210' };

  for (const campaignId of [cp, cw]) {
    const answered = await twilioStatus(p.sms!, delivered, { campaignId, identityId: S1 });
    expect(answered.status).toBe(204);
  }
  expect(await eventRows(p.project.id)).toHaveLength(0);
  // A real SMS campaign of the project records the same report.
  const cs = await seedCampaignRow(p.project.id, 'sms');
  expect((await twilioStatus(p.sms!, delivered, { campaignId: cs, identityId: S1 })).status).toBe(204);
  expect((await eventRows(p.project.id)).map((e) => [e.type, e.campaign_id])).toEqual([['delivered', cs]]);

  const wa = await waProject('smswa-231-wa', 'meta', {}, p.owner);
  const { S1: W1 } = await seedPeople(wa, p.owner.ip, ['S1']);
  const smsInWa = await seedCampaignRow(wa.project.id, 'sms');
  const report = await metaPost(wa.wa, { statuses: [metaStatus(S1_WA, 'delivered', { c: smsInWa, i: W1 })] });
  expect([report.status, report.body]).toEqual([200, { recorded: 0 }]);
  expect(await eventRows(wa.project.id)).toHaveLength(0);
});

test('SMSWA-234 STOP consent history: one row per holder, none for a repeat', async () => {
  const p = await smsProject('smswa-234', { twilio: true });
  const { S7, S8 } = await seedPeople(p, p.owner.ip, ['S7', 'S8']);
  const smsHistory = async (id: string) => (await consentRows(id)).filter((row) => row.channel === 'sms');
  const base = { S7: (await smsHistory(S7)).length, S8: (await smsHistory(S8)).length };
  const since = async (id: string, key: 'S7' | 'S8') => (await smsHistory(id)).slice(base[key]);
  const stop = { channel: 'sms', granted: false, source: 'stop_reply' };
  const start = { channel: 'sms', granted: true, source: 'start_reply' };

  // 1 and 2: the STOP and its repeat.
  expect((await twilioReply(p.sms!, '+919811111111', 'STOP')).status).toBe(200);
  expect(await suppressionRows(p.project.id)).toHaveLength(1);
  expect(await since(S7, 'S7')).toEqual([stop]);
  expect(await since(S8, 'S8')).toEqual([stop]);
  expect((await twilioReply(p.sms!, '+919811111111', 'STOP')).status).toBe(200);
  expect(await suppressionRows(p.project.id)).toHaveLength(1);
  expect(await since(S7, 'S7')).toEqual([stop]);
  expect(await since(S8, 'S8')).toEqual([stop]);

  // 3: WhatsApp, the same.
  const wa = await waProject('smswa-234-wa', 'meta', {}, p.owner);
  const w1 = await identifyPhone(wa, p.owner.ip, { phone: '+919811111112', whatsappOptIn: true });
  const w2 = await identifyPhone(wa, p.owner.ip, { phone: '+919811111112', whatsappOptIn: true });
  const waHistory = async (id: string) => (await consentRows(id)).filter((row) => row.channel === 'whatsapp' && row.source === 'stop_reply');
  for (let i = 0; i < 2; i += 1) {
    expect((await metaPost(wa.wa, { messages: [metaReply('919811111112', 'STOP')] })).status).toBe(200);
    expect(await waHistory(w1)).toHaveLength(1);
    expect(await waHistory(w2)).toHaveLength(1);
  }

  // 4: a START and a STOP again write one row per holder each.
  expect((await twilioReply(p.sms!, '+919811111111', 'START')).status).toBe(200);
  expect(await suppressionRows(p.project.id)).toHaveLength(0);
  expect((await twilioReply(p.sms!, '+919811111111', 'STOP')).status).toBe(200);
  expect(await since(S7, 'S7')).toEqual([stop, start, stop]);
  expect(await since(S8, 'S8')).toEqual([stop, start, stop]);
});

test('SMSWA-235 provider error text in the Reason tooltip is shown as text', async ({ page }) => {
  const meta = await waProject('smswa-235-meta', 'meta');
  const gupshup = await waProject('smswa-235-gupshup', 'gupshup', {}, meta.owner);
  const interakt = await waProject('smswa-235-interakt', 'interakt', {}, meta.owner);
  for (const p of [meta, gupshup, interakt]) await seedPeople(p, meta.owner.ip, ['S4']);
  const payload = (name: string) => `<img src=x onerror="window.${name}=1">`;

  const m = await metaPost(meta.wa, {
    statuses: [metaStatus('33612345678', 'failed', {}, { errors: [{ code: 131026, error_data: { details: payload('__x') } }] })],
  });
  const g = await gupshupPost(gupshup.wa.webhookToken, {
    type: 'message-event',
    payload: { type: 'failed', destination: '33612345678', payload: { code: 1002, reason: payload('__y') } },
  });
  const i = await interaktPost(interakt.wa, {
    type: 'message_api_failed',
    data: { customer: { channel_phone_number: '33612345678' }, message: { channel_error_code: 1013, channel_failure_reason: payload('__z') } },
  });
  expect([m.status, g.status, i.status]).toEqual([200, 200, 200]);

  await signIn(page, meta.owner);
  for (const [p, name] of [[meta, '__x'], [gupshup, '__y'], [interakt, '__z']] as const) {
    const [row] = await suppressionRows(p.project.id, 'whatsapp');
    expect([row.address, row.reason, row.detail]).toEqual(['+33612345678', 'bounced', payload(name)]);
    await openWhatsApp(page, p.project.id, 'Suppressions');
    const reason = page.getByRole('row').filter({ hasText: '+33612345678' }).getByRole('cell').nth(1);
    await expect(reason).toHaveText('Not on WhatsApp');
    await expect(reason).toHaveAttribute('title', payload(name));
    await expect(page.locator('table img')).toHaveCount(0);
    expect(await page.evaluate(() => [(window as any).__x, (window as any).__y, (window as any).__z])).toEqual([undefined, undefined, undefined]);
  }
});

test('SMSWA-239 the first SMS sender save logs every field', async ({ page }) => {
  const p = await smsProject('smswa-239');
  await signIn(page, p.owner);
  await openSms(page, p.project.id, 'Settings');
  const from = page.getByLabel('From', { exact: true });
  await from.fill('+14155550123');
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(toastTitled(page, 'Sender saved')).toHaveCount(1);

  const first = await activityOf(p.project.id, 'channel.settings_changed');
  expect(first.map((entry) => entry.details)).toEqual([{ channel: 'sms', fields: ['sender', 'requireOptIn', 'optOutText'] }]);

  await from.fill('+14155550124');
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(toastTitled(page, 'Sender saved')).toHaveCount(2);
  await expect.poll(async () => (await activityOf(p.project.id, 'channel.settings_changed')).length).toBe(2);
  const both = await activityOf(p.project.id, 'channel.settings_changed');
  expect(both.map((entry) => entry.details)).toEqual([
    { channel: 'sms', fields: ['sender', 'requireOptIn', 'optOutText'] },
    { channel: 'sms', fields: ['sender'] },
  ]);
  expect(JSON.stringify(both)).not.toContain('4155550');
  expect((await smsSettingsRow(p.project.id))?.sender).toBe('+14155550124');
});

test('SMSWA-242 suppression API address normalisation', async ({ page }) => {
  const p = await smsProject('smswa-242', { twilio: true });
  const { S3 } = await seedPeople(p, p.owner.ip, ['S3']);
  const history = async () => (await consentRows(S3)).filter((row) => row.channel === 'sms');
  const before = (await history()).length;
  const id = p.project.id;

  // 1. The page needs a leading plus.
  await signIn(page, p.owner);
  await openSms(page, id, 'Suppressions');
  await page.getByPlaceholder('+14155550123').fill('0044 7700 900123');
  await expect(page.getByRole('button', { name: 'Suppress', exact: true })).toBeDisabled();

  // 2. The API normalises it.
  const added = await call('POST', '/api/sms/suppressions', p.owner, { projectId: id, address: '0044 7700 900123' });
  expect([added.status, dataOf(added)]).toEqual([201, { suppressed: true }]);
  expect((await suppressionRows(id)).map((row) => [row.address, row.reason])).toEqual([['+447700900123', 'manual']]);
  await page.reload();
  await page.getByRole('tab', { name: 'Suppressions', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '+447700900123' })).toHaveCount(1);
  expect((await history()).slice(before)).toEqual([{ channel: 'sms', granted: false, source: 'dashboard' }]);
  expect((await activityOf(id, 'suppression.added')).map((entry) => entry.details.address)).toEqual(['+44******23']);

  // 3. The path value is normalised the same way.
  const lifted = await call('DELETE', `/api/sms/suppressions/${id}/%2B44%207700%20900123`, p.owner);
  expect([lifted.status, dataOf(lifted)]).toEqual([200, { removed: true }]);
  expect(await suppressionRows(id)).toHaveLength(0);
  expect((await history()).slice(before)).toEqual([
    { channel: 'sms', granted: false, source: 'dashboard' },
    { channel: 'sms', granted: true, source: 'dashboard' },
  ]);
  expect((await activityOf(id, 'suppression.removed')).map((entry) => entry.details.address)).toEqual(['+44******23']);

  // 4. A complaint by hand records the same.
  const complained = await call('POST', '/api/sms/suppressions', p.owner, { projectId: id, address: '+44 7700 900123', reason: 'complained' });
  expect(complained.status).toBe(201);
  expect((await suppressionRows(id)).map((row) => [row.address, row.reason])).toEqual([['+447700900123', 'complained']]);
  expect((await call('DELETE', `/api/sms/suppressions/${id}/%2B44%207700%20900123`, p.owner)).status).toBe(200);
  expect(await suppressionRows(id)).toHaveLength(0);
  expect((await history()).slice(before)).toEqual([
    { channel: 'sms', granted: false, source: 'dashboard' },
    { channel: 'sms', granted: true, source: 'dashboard' },
    { channel: 'sms', granted: false, source: 'dashboard' },
    { channel: 'sms', granted: true, source: 'dashboard' },
  ]);
  expect(await activityOf(id, 'suppression.added')).toHaveLength(2);
  expect(await activityOf(id, 'suppression.removed')).toHaveLength(2);
});

test('SMSWA-245 more Twilio SMS webhook parsing', async () => {
  const p = await smsProject('smswa-245', { twilio: true });
  const { S1, S2 } = await seedPeople(p, p.owner.ip, ['S2', 'S1']);
  const c = await seedCampaignRow(p.project.id, 'sms');
  const sms = p.sms!;
  const sid = sms.credentials.accountSid;

  const legacy = await twilioStatus(sms, { SmsStatus: 'delivered', To: '+14155550111' }, { campaignId: c, identityId: S2 });
  expect(legacy.status).toBe(204);
  expect((await eventRows(p.project.id)).map((e) => [e.type, e.device_identity_id])).toEqual([['delivered', S2]]);

  const path = smsWebhookPath(sms.webhookToken, 'status', { campaignId: c, identityId: S1 });
  const params = { AccountSid: sid, MessageStatus: 'delivered', To: '+919876543210', Tag: ['b', 'a'] };
  const oneTag = await postTwilioForm(path, params, { authToken: sms.credentials.authToken, signParams: { ...params, Tag: 'a' } });
  expect([oneTag.status, messageOf(oneTag)]).toEqual([401, SIGNATURE_REFUSED]);
  expect(await eventRows(p.project.id)).toHaveLength(1);

  const repeated = await postTwilioForm(path, params, { authToken: sms.credentials.authToken });
  expect(repeated.status).toBe(204);
  expect((await eventRows(p.project.id)).map((e) => [e.type, e.device_identity_id])).toEqual([
    ['delivered', S2],
    ['delivered', S1],
  ]);
});

test('SMSWA-246 WhatsApp quick replies and the WhatsApp keyword list', async () => {
  const tw = await waProject('smswa-246-twilio', 'twilio');
  const n = [uniquePhone(), uniquePhone(), uniquePhone()];
  for (const phone of n) await identifyPhone(tw, tw.owner.ip, { phone, whatsappOptIn: true });
  const sid = tw.wa.credentials.accountSid;
  const forms: Array<Record<string, string>> = [
    { From: `whatsapp:${n[0]}`, ButtonText: 'STOP', AccountSid: sid },
    { From: `whatsapp:${n[1]}`, Body: ' ', ButtonPayload: 'STOP', AccountSid: sid },
    { From: `whatsapp:${n[2]}`, MessageStatus: 'received', Body: 'STOP', AccountSid: sid },
  ];
  for (const form of forms) {
    const answered = await twilioWhatsAppPost(tw.wa, form);
    expect([answered.status, answered.text]).toEqual([200, EMPTY_TWIML]);
  }
  const twRows = await waSuppressed(tw.project.id);
  expect(Object.keys(twRows).sort()).toEqual([...n].sort());
  expect(Object.values(twRows).map(([reason]) => reason)).toEqual(['unsubscribed', 'unsubscribed', 'unsubscribed']);

  const meta = await waProject('smswa-246-meta', 'meta', { twilio: true }, tw.owner);
  const known = uniquePhone();
  await identifyPhone(meta, tw.owner.ip, { phone: known, smsOptIn: true, whatsappOptIn: true });
  expect((await metaPost(meta.wa, { messages: [metaReply(digits(known), 'REVOKE')] })).status).toBe(200);
  expect(await suppressionRows(meta.project.id, 'whatsapp')).toHaveLength(0);
  expect((await twilioReply(meta.sms!, known, 'REVOKE')).status).toBe(200);
  expect((await suppressionRows(meta.project.id, 'sms')).map((row) => [row.address, row.reason])).toEqual([[known, 'unsubscribed']]);

  const gs = await waProject('smswa-246-gupshup', 'gupshup', {}, tw.owner);
  const n4 = uniquePhone();
  const n4Id = await identifyPhone(gs, tw.owner.ip, { phone: n4, whatsappOptIn: true });
  const quick = await gupshupPost(gs.wa.webhookToken, { type: 'message', payload: { sender: { phone: digits(n4) }, payload: { title: 'STOP' } } });
  expect(quick.status).toBe(200);
  expect((await suppressionRows(gs.project.id, 'whatsapp')).map((row) => [row.address, row.reason])).toEqual([[n4, 'unsubscribed']]);
  expect((await consentRows(n4Id)).at(-1)).toEqual({ channel: 'whatsapp', granted: false, source: 'stop_reply_unsigned' });
});

test('SMSWA-247 test send ordering and refusals through the API', async () => {
  const sms = await smsProject('smswa-247-sms', { twilio: true });
  const owner = sms.owner;
  const wa = await waProject('smswa-247-wa', 'interakt', { signed: false }, owner);
  const blank = await smsProject('smswa-247-blank', {}, owner);
  const rowOnly = await smsProject('smswa-247-row', {}, owner);
  expect((await call('POST', '/api/whatsapp/settings', owner, { projectId: rowOnly.project.id })).status).toBe(201);
  const number = '+14155550188';
  expect((await call('POST', '/api/whatsapp/suppressions', owner, { projectId: sms.project.id, address: number })).status).toBe(201);
  expect((await call('POST', '/api/sms/suppressions', owner, { projectId: wa.project.id, address: number })).status).toBe(201);
  const smsTest = (projectId: string, to: string, body = 'Test') => call('POST', '/api/sms/test-send', owner, { projectId, to, body });
  const waTest = (projectId: string, to: string, content: Record<string, unknown> = handTyped()) =>
    call('POST', '/api/whatsapp/test-send', owner, { projectId, to, content });

  // 1. The number's form is checked before the set-up.
  const notSetUp = await smsTest(blank.project.id, '+14155550123');
  expect([notSetUp.status, messageOf(notSetUp)]).toEqual([404, 'SMS is not set up for this project. Add a sender in SMS settings.']);
  const badNumber = await smsTest(blank.project.id, '+12');
  expect([badNumber.status, messageOf(badNumber)]).toEqual([400, SMS_BAD_TEST_NUMBER]);

  // 2. Suppressions are per channel: each test goes on to its provider.
  const smsSent = await smsTest(sms.project.id, number);
  expect(smsSent.status).toBe(201);
  expect(dataOf(smsSent).error).not.toBe(SUPPRESSED);
  expect((await twilioCallsFor(sms.sms!.credentials.accountSid)).filter((entry) => JSON.stringify(entry.body).includes(number))).toHaveLength(1);
  const waSent = await waTest(wa.project.id, number);
  expect(waSent.status).toBe(201);
  expect(dataOf(waSent).error).not.toBe(SUPPRESSED);
  expect(await providerCallsMentioning('interakt', '4155550188')).not.toHaveLength(0);

  // 3 and 4. The content is checked before anything is sent.
  const emptyBody = await smsTest(sms.project.id, '+14155550111', '');
  expect([emptyBody.status, messageOf(emptyBody)]).toEqual([400, 'body must be longer than or equal to 1 characters']);
  const emptyValue = await waTest(wa.project.id, '+14155550111', handTyped('order_update', [' ']));
  expect([emptyValue.status, messageOf(emptyValue)]).toEqual([400, EMPTY_VALUE]);
  expect(await providerCallsMentioning('interakt', '4155550111')).toHaveLength(0);

  // 5. WhatsApp set-up refusals, and the number checked first.
  const noProvider = await waTest(rowOnly.project.id, '+919876543210');
  expect([noProvider.status, messageOf(noProvider)]).toEqual([400, WA_NO_PROVIDER]);
  const waBlank = await waTest(blank.project.id, '+919876543210');
  expect([waBlank.status, messageOf(waBlank)]).toEqual([404, WA_NOT_SET_UP]);
  const waBad = await waTest(blank.project.id, '+12');
  expect([waBad.status, messageOf(waBad)]).toEqual([400, WA_BAD_TEST_NUMBER]);
});

test('SMSWA-248 SMS settings states not covered elsewhere', async ({ page }) => {
  const senderOnly = await smsProject('smswa-248-sender', { sender: true });
  const ready = await smsProject('smswa-248-ready', { twilio: true }, senderOnly.owner);
  const blank = await smsProject('smswa-248-blank', {}, senderOnly.owner);
  const member = await teammate(senderOnly.project.id, 'member', senderOnly.owner);
  await call('POST', '/api/sms/suppressions', senderOnly.owner, { projectId: ready.project.id, address: '+14155550199' }).then((r) => expect(r.status).toBe(201));
  await addMember(ready.project.id, member, 'member', senderOnly.owner);

  // 1. Sender saved, no Twilio, as a member.
  await signIn(page, member);
  await openSms(page, senderOnly.project.id, 'Settings');
  const twilio = card(page, 'Twilio');
  await expect(twilio.locator('[data-slot="card-description"]')).toHaveText(
    'Texts go out through your own Twilio account, billed by Twilio. Both values are on the Twilio Console home page, under Account Info.',
  );
  await expect(twilio.locator('svg.lucide-circle-check-big, svg.lucide-check-circle-2, svg.lucide-circle-check')).toHaveCount(0);
  await expect(twilio.getByText(/Connected\./)).toHaveCount(0);
  await expect(twilio.locator('input')).toHaveCount(0);
  await expect(twilio.getByRole('button')).toHaveCount(0);
  const block = repliesBlock(page);
  await expect(block.locator('code')).toHaveText(ONLY_OWNERS);
  await expect(block.getByText(/^This API's public URL is a local address/)).toBeVisible();
  await expect(card(page, 'Send a test')).toHaveCount(0);

  // 2. A ready project: the member's test send is refused for the suppressed number.
  await openSms(page, ready.project.id, 'Settings');
  const testCard = card(page, 'Send a test');
  await testCard.getByPlaceholder('+919876543210').fill('+14155550199');
  await testCard.getByRole('button', { name: 'Send test' }).click();
  const line = testCard.getByText(SUPPRESSED, { exact: true });
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-destructive/);
  expect((await twilioCallsFor(ready.sms!.credentials.accountSid)).filter((entry) => entry.method === 'POST')).toHaveLength(0);

  // 3. The owner's Sender card help texts on a fresh project.
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await signIn(page, senderOnly.owner);
  await openSms(page, blank.project.id, 'Settings');
  const sender = card(page, 'Sender');
  await expect(sender.locator('p.text-xs.text-muted-foreground')).toHaveText([
    'A Twilio number in international form, a Messaging Service SID (MG…), or an alphanumeric sender ID of up to 11 characters where the destination country allows one. India needs a DLT-registered sender ID.',
    'Added to the end of every campaign text that does not already say it. US carriers expect it on marketing texts. Leave empty to send without one.',
    'On: only people whose app sent smsOptIn: true. Off: everyone with a number who has not opted out. Marketing texts need prior consent in the US, UK, EU and India, so leave this on unless you collect consent some other way.',
  ]);
});

test('SMSWA-251 reach de-duplication when the audience is narrowed', async () => {
  const p = await smsProject('smswa-251', { twilio: true });
  const { S7: a, S8: b } = await seedPeople(p, p.owner.ip, ['S7', 'S8']);
  // "S7" is the lower id, "S8" the higher, whichever order identify made them in.
  const [low, high] = [a, b].sort();
  await setTraits(high, { pair: 'yes', solo: 'yes' });
  await setTraits(low, { pair: 'yes' });
  const segS8 = await traitFieldSegment(p.owner, p.project.id, 'solo', 'yes');
  const segS78 = await traitFieldSegment(p.owner, p.project.id, 'pair', 'yes');
  const preview = async (extra: Record<string, unknown>) =>
    dataOf(await call('POST', '/api/sms/audience-preview', p.owner, { projectId: p.project.id, ...extra })).recipients;

  expect(await preview({ segmentId: segS8.id })).toBe(1);
  expect(await preview({ segmentId: segS78.id })).toBe(1);
  expect(await preview({ deviceIdentityIds: [high] })).toBe(1);
  expect(await preview({ deviceIdentityIds: [low] })).toBe(1);

  const sent = await call('POST', '/api/sms/send', p.owner, { projectId: p.project.id, body: 'Pair check', segmentId: segS8.id, scheduledAt: later() });
  expect(sent.status).toBe(201);
  const [row] = await campaignRows(p.project.id);
  expect(row).toMatchObject({ target_type: 'segment', total_tokens: 1 });
});

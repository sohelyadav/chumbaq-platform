import type { Locator, Page } from '@playwright/test';
import { deleteFcmCredentialRow } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import {
  actionBar,
  activityRows,
  addDevice,
  backArrow,
  call,
  campaignRecipients,
  campaignRow,
  campaignRows,
  card,
  createTemplate,
  dataOf,
  field,
  figureTile,
  formatUtc,
  headingBadges,
  insertDeviceRows,
  insertEvents,
  messageOf,
  NO_REACHABLE_TOKENS,
  nextButton,
  openComposer,
  openPush,
  pickDateTime,
  pushProject,
  randomId,
  reachFigure,
  READ_ONLY,
  reportEvent,
  reviewValue,
  seedCampaign,
  seedLogRow,
  signedInStaff,
  sql,
  stepButton,
  submitCampaign,
  switchFor,
  teammate,
  templateRow,
  templateRows,
  timingLine,
  toastBehindDialog,
  toastTitled,
  unregisterToken,
  viewAsCaller,
  zonedInstant,
  zonedParts,
  type Device,
  type PushProject,
} from '../../support/areas/push';

/**
 * Push, P1: the composer's Review step and the send (restated campaign, outstanding
 * problems, a single request while pending, refusals), the send, preview and
 * send-to-person APIs, the campaign detail page (header, error card, engagement,
 * delivery and failures, experiment results, cancel), and the Templates tab and
 * template API. FCM is seeded; Google and FCM are the provider stub. Pages run in UTC
 * with an en-US locale, so formatted times can be compared.
 */

test.describe.configure({ mode: 'parallel' });

const TZ = 'UTC';
test.use({ timezoneId: TZ, locale: 'en-US' });

const DAY = 86_400_000;
const CAMPAIGN_NOT_FOUND = 'Campaign not found for this project';
const NOT_FOUND_PAGE =
  'Campaign not found. It may have been deleted, or it may simply be older than the most recent campaigns shown on the list page.';
const NO_CHANNEL =
  'No push channel is configured for this project, so nothing could be sent. Add channel credentials in Settings and send again.';
const BAD_EVERY = 'Repeat every must be a whole number of periods between 1 and 52.';
const TEMPLATES = (projectId: string) => `/api/projects/${projectId}/push-templates`;
const SEND = '/api/push-notifications/send';
const PREVIEW = '/api/push-notifications/audience-preview';
const isSend = (url: string) => new URL(url).pathname.endsWith(SEND);

// ----------------------------------------------------------------- helpers ---

/** Opens the composer and waits for the project-wide reach to be counted. */
async function composer(page: Page, p: PushProject, reach: number): Promise<void> {
  await openComposer(page, p.project.id);
  await expect(reachFigure(page)).toHaveText(String(reach));
}

function messageCard(page: Page): Locator {
  return card(page, 'Message');
}

function titleInput(page: Page): Locator {
  return field(messageCard(page), 'Title *').getByRole('textbox');
}

function subtitle(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true });
}

/** Audience → Message, with a title typed. */
async function toMessage(page: Page, title?: string): Promise<void> {
  await nextButton(page).click();
  await expect(subtitle(page, 'Step 2 of 4 · What it says')).toBeVisible();
  if (title !== undefined) await titleInput(page).fill(title);
}

/** From Message to Review (two clicks of Next). */
async function messageToReview(page: Page): Promise<void> {
  await nextButton(page).click();
  await expect(subtitle(page, 'Step 3 of 4 · When and how')).toBeVisible();
  await nextButton(page).click();
  await expect(subtitle(page, 'Step 4 of 4 · Check, then send')).toBeVisible();
}

function sendAtTrigger(page: Page): Locator {
  return field(page, 'Send at').getByRole('button');
}

/** Day `day` of next month at `time`, in the page's zone. */
function nextMonthAt(day: number, time: string): { day: Date; at: Date } {
  const now = zonedParts(new Date(), TZ);
  const m = now.m === 12 ? 1 : now.m + 1;
  const y = now.m === 12 ? now.y + 1 : now.y;
  return { day: new Date(Date.UTC(y, m - 1, day, 12)), at: zonedInstant(y, m, day, time, TZ) };
}

/** Picks a Radix select option. */
async function choose(page: Page, trigger: Locator, option: string): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** The collapsible trigger in a card's header. */
function sectionToggle(scope: Locator): Locator {
  return scope.locator('[data-slot="card-header"] button').first();
}

/** A device picker results row, by the device's distinct id. */
function deviceRow(page: Page, distinctId: string): Locator {
  return page.locator('div.divide-y > div').filter({ has: page.getByText(distinctId, { exact: true }).first() });
}

/** A segment matching `traits.plan = <plan>`, through the dashboard route. */
async function planSegment(p: PushProject, name: string, plan: string): Promise<string> {
  const created = await call('POST', `/api/projects/${p.project.id}/segments`, p.owner, {
    name,
    definition: { type: 'group', operator: 'and', children: [{ type: 'attribute', field: 'traits.plan', op: 'eq', value: plan }] },
  });
  return dataOf<{ id: string }>(created).id;
}

/** A campaign scheduled a month ahead through the real send route. */
async function scheduleCampaign(p: PushProject, title: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const sent = dataOf(
    await call('POST', SEND, p.owner, {
      projectId: p.project.id,
      title,
      scheduledAt: new Date(Date.now() + 30 * DAY).toISOString(),
      ...extra,
    }),
  );
  expect(sent.status).toBe('scheduled');
  return sent;
}

async function openCampaign(page: Page, projectId: string, campaignId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/push-notifications/${campaignId}`);
}

/** The Templates tab's row for a template, by its name cell. */
function templateRowOnPage(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
}

/** A template dialog's text field by its label. */
function dialogField(dialog: Locator, label: string): Locator {
  return field(dialog, label).getByRole('textbox');
}

// --------------------------------------------------- L. Review and send ---

test('PUSH-165 review restates the campaign', async ({ page }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-165', { fcm: true });
  await addDevice(p, p.owner.ip, { distinctId: 'd165-one', traits: { plan: 'pro' } });
  await addDevice(p, p.owner.ip, { distinctId: 'd165-two', traits: { plan: 'pro' } });
  await addDevice(p, p.owner.ip, { distinctId: 'd165-three', traits: { plan: 'free' } });
  await planSegment(p, 'Pro plan 165', 'pro');

  await signIn(page, p.owner);
  await composer(page, p, 3);
  await choose(page, field(page, 'Send to').getByRole('combobox'), 'A segment');
  await choose(page, field(page, 'Segment').getByRole('combobox'), 'Pro plan 165');
  await expect(reachFigure(page)).toHaveText('2');

  await toMessage(page, 'Big sale');
  const message = messageCard(page);
  await field(message, 'Body').getByRole('textbox').fill('Everything half off');
  await field(message, 'Image URL').getByRole('textbox').fill('https://example.com/sale.png');
  await field(message, 'Deep link').getByRole('textbox').fill('myapp://sale');
  const tag = field(message, 'Language tag').getByRole('textbox');
  await tag.fill('hi');
  await tag.press('Enter');
  await message.getByPlaceholder('Leave blank to use the title above').first().fill('बड़ी सेल');

  const actions = card(page, 'Action buttons');
  await sectionToggle(actions).click();
  await actions.getByRole('button', { name: 'Add button' }).click();
  await field(actions, 'Id *').getByRole('textbox').fill('shop');
  await field(actions, 'Title *').getByRole('textbox').fill('Shop now');
  await field(actions, 'iOS category').getByRole('textbox').fill('SALE');

  const rich = card(page, 'Carousel & countdown');
  await sectionToggle(rich).click();
  await rich.getByRole('button', { name: 'Add a carousel' }).click();
  await rich.getByRole('button', { name: 'Add slide' }).click();
  for (const i of [0, 1, 2]) await field(rich, 'Image URL *', i).getByRole('textbox').fill(`https://example.com/slide-${i}.png`);
  await pickDateTime(page, field(rich, 'Ends at').getByRole('button'), nextMonthAt(20, '12:00').day, TZ, '12:00');

  await nextButton(page).click();
  const send = nextMonthAt(15, '10:30');
  await pickDateTime(page, sendAtTrigger(page), send.day, TZ, '10:30');
  await nextButton(page).click();
  await expect(subtitle(page, 'Step 4 of 4 · Check, then send')).toBeVisible();

  await expect(page.locator('dl dt')).toHaveText(['Audience', 'Message', 'Extras', 'Opens', 'Languages', 'When']);
  await expect(reviewValue(page, 'Audience')).toContainText('Pro plan 165');
  await expect(reviewValue(page, 'Audience').locator('span.block')).toHaveText('2 reachable devices');
  await expect(reviewValue(page, 'Message').locator('span.font-medium')).toHaveText('Big sale');
  await expect(reviewValue(page, 'Message').locator('span.block')).toHaveText('Everything half off');
  await expect(reviewValue(page, 'Extras').locator('[data-slot="badge"]')).toHaveText([
    'Image',
    '1 action button',
    'iOS category',
    '3-slide carousel',
    'Countdown',
  ]);
  await expect(reviewValue(page, 'Opens')).toHaveText('myapp://sale');
  await expect(reviewValue(page, 'Languages')).toHaveText('1 translation');
  await expect(reviewValue(page, 'When')).toHaveText(send.at.toLocaleString('en-US', { timeZone: TZ }));
  await expect(reviewValue(page, 'When').locator('svg.lucide-calendar-clock')).toHaveCount(1);
  await expect(actionBar(page)).toHaveText('Scheduling to 2 devices.');
  await expect(page.getByRole('button', { name: 'Schedule campaign', exact: true })).toBeEnabled();

  // Chosen devices and no schedule.
  await composer(page, p, 3);
  await choose(page, field(page, 'Send to').getByRole('combobox'), 'Specific devices');
  await deviceRow(page, 'd165-one').getByRole('button', { name: 'Add', exact: true }).click();
  await deviceRow(page, 'd165-three').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(reachFigure(page)).toHaveText('2');
  await toMessage(page, 'Just two');
  await messageToReview(page);
  await expect(page.locator('dl dt')).toHaveText(['Audience', 'Message', 'When']);
  await expect(reviewValue(page, 'Audience')).toContainText('2 chosen people');
  await expect(reviewValue(page, 'Audience').locator('span.block')).toHaveText('2 reachable devices');
  await expect(reviewValue(page, 'When')).toHaveText('As soon as you send');
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-166 review lists outstanding problems with links back', async ({ page }) => {
  const p = await pushProject('push-166', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Fine at first');
  await messageToReview(page);
  const problems = page.locator('div.rounded-md.border-destructive\\/40');
  await expect(problems).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send campaign', exact: true })).toBeEnabled();

  await stepButton(page, 'Message').click();
  await titleInput(page).fill('');
  await stepButton(page, 'Delivery').click();
  await switchFor(page, 'Repeat').click();
  await field(page, 'Repeat every').getByRole('spinbutton').fill('0');
  await stepButton(page, 'Review').click();
  await expect(subtitle(page, 'Step 4 of 4 · Check, then send')).toBeVisible();

  const lines = problems.getByRole('button');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toHaveText(/^Message:\s*A title is required\.$/);
  await expect(lines.nth(1)).toHaveText(new RegExp(`^Delivery:\\s*${BAD_EVERY.replace(/\./g, '\\.')}$`));
  await expect(problems).toHaveClass(/bg-destructive\/5/);
  await expect(page.getByRole('button', { name: 'Schedule repeating campaign', exact: true })).toBeDisabled();
  await expect(actionBar(page)).toHaveText('A title is required.');

  await lines.nth(0).click();
  await expect(subtitle(page, 'Step 2 of 4 · What it says')).toBeVisible();
  await expect(stepButton(page, 'Message')).toHaveAttribute('aria-current', 'step');
  await stepButton(page, 'Review').click();
  await problems.getByRole('button', { name: /^Delivery:/ }).click();
  await expect(subtitle(page, 'Step 3 of 4 · When and how')).toBeVisible();
  await expect(field(page, 'Repeat every').getByRole('spinbutton')).toHaveValue('0');
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-167 send is single-shot while pending', async ({ page }) => {
  const p = await pushProject('push-167', { fcm: true });
  await addDevice(p, p.owner.ip);

  const sends: string[] = [];
  page.on('request', (r) => {
    if (isSend(r.url()) && r.method() === 'POST') sends.push(r.url());
  });
  await page.route((url) => isSend(url.toString()), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
  });

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Only once');
  await messageToReview(page);
  const button = page.getByRole('button', { name: 'Send campaign', exact: true });
  await button.dblclick();
  await expect(button).toBeDisabled();
  await expect(button.locator('svg.animate-spin')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications$`));
  await expect(toastTitled(page, 'Campaign queued').first()).toBeVisible();
  // Only what follows is expected to fail; the pending state above must hold.
  test.fail(true, 'PUSH-167');
  test.info().annotations.push({ type: 'issue', description: 'PUSH-167' });
  expect(sends).toHaveLength(1);
  const rows = await campaignRows(p.project.id);
  expect(rows.map((row) => row.title)).toEqual(['Only once']);
  await expect(toastTitled(page, 'Campaign queued')).toHaveCount(1);
});

test('PUSH-168 server refusal is shown as a toast', async ({ page }) => {
  const p = await pushProject('push-168', { fcm: true });
  const d1 = await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  // The token goes after the reach was counted.
  await unregisterToken(p, p.owner.ip, d1.tokens[0]);
  await toMessage(page, 'Nobody left');
  await messageToReview(page);
  await expect(actionBar(page)).toHaveText('Sending to 1 device.');
  const sent = await submitCampaign(page, 'Send campaign');
  expect([sent.status]).toEqual([400]);

  const toast = toastTitled(page, 'Could not create campaign');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(NO_REACHABLE_TOKENS);
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/new$`));
  await expect(page.getByRole('heading', { name: 'New push campaign' })).toBeVisible();
  await expect(subtitle(page, 'Step 4 of 4 · Check, then send')).toBeVisible();
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-170 send API: an empty device list means the whole project', async () => {
  const p = await pushProject('push-170', { fcm: true });
  const one = await addDevice(p, p.owner.ip);
  await addDevice(p, p.owner.ip);
  await addDevice(p, p.owner.ip);

  // A one-device list is the positive control: a list does narrow the audience.
  const narrowed = await call('POST', SEND, p.owner, { projectId: p.project.id, title: 'One', deviceIdentityIds: [one.id] });
  expect(narrowed.status).toBe(201);
  expect(dataOf(narrowed)).toMatchObject({ targetType: 'devices', totalTokens: 1 });
  expect(await campaignRecipients(dataOf(narrowed).id)).toEqual([one.id]);

  // Current behaviour: an empty list is no filter at all.
  const empty = await call('POST', SEND, p.owner, { projectId: p.project.id, title: 'Everyone', deviceIdentityIds: [] });
  expect(empty.status).toBe(201);
  expect(dataOf(empty)).toMatchObject({ targetType: 'project', totalTokens: 3 });
  const row = await campaignRow(dataOf(empty).id);
  expect([row?.target_type, row?.total_tokens]).toEqual(['project', 3]);
  expect(await campaignRecipients(dataOf(empty).id)).toEqual([]);
});

test('PUSH-175 campaign with no configured channel fails with a reason', async ({ page }) => {
  const p = await pushProject('push-175', { fcm: true });
  await addDevice(p, p.owner.ip);
  await deleteFcmCredentialRow(p.project.id);

  const sent = await call('POST', SEND, p.owner, { projectId: p.project.id, title: 'No channel' });
  expect(sent.status).toBe(201);
  const id = dataOf(sent).id as string;
  expect(dataOf(sent).status).toBe('queued');
  await expect.poll(async () => (await campaignRow(id))?.status, { timeout: 60_000, intervals: [1_000] }).toBe('failed');
  const row = await campaignRow(id);
  expect([row?.error_message, row?.success_count]).toEqual([NO_CHANNEL, 0]);

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, id);
  await expect(headingBadges(page)).toHaveText(['Failed']);
  await expect(page.locator('div.border-destructive\\/40')).toHaveText(NO_CHANNEL);
});

test('PUSH-178 composer for a member', async ({ page }) => {
  const p = await pushProject('push-178', { fcm: true });
  await addDevice(p, p.owner.ip);
  const member = await teammate(p.project.id, 'member', p.owner);

  await signIn(page, member);
  await composer(page, p, 1);
  await toMessage(page, 'From a member');
  await nextButton(page).click();
  const later = nextMonthAt(15, '09:00');
  await pickDateTime(page, sendAtTrigger(page), later.day, TZ, '09:00');
  await nextButton(page).click();
  const sent = await submitCampaign(page, 'Schedule campaign');
  expect(sent.status).toBe(201);
  expect(sent.data.status).toBe('scheduled');
  await expect(toastTitled(page, 'Campaign scheduled')).toBeVisible();

  const entries = await activityRows(p.project.id, 'campaign.scheduled');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    actor_kind: 'user',
    actor_user_id: member.userId,
    actor_label: `${member.name} (${member.email})`,
    target_type: 'campaign',
    target_id: sent.data.id,
  });
});

test('PUSH-180 audience preview API checks', async () => {
  const p = await pushProject('push-180', { fcm: true });
  await addDevice(p, p.owner.ip, { traits: { plan: 'pro' } });
  await addDevice(p, p.owner.ip, { traits: { plan: 'pro' }, tokens: 2 });
  const outside = await addDevice(p, p.owner.ip, { traits: { plan: 'free' } });
  const other = await pushProject('push-180-x', { fcm: true });
  const foreign = await addDevice(other, other.owner.ip);
  const segmentId = await planSegment(p, 'Pro plan 180', 'pro');
  const preview = (body: Record<string, unknown>) => call('POST', PREVIEW, p.owner, { projectId: p.project.id, ...body });

  const everyone = await preview({});
  expect(everyone.status).toBe(201);
  expect(dataOf(everyone)).toEqual({ targetType: 'project', totalTokens: 4, deviceCount: null });

  const segment = await preview({ segmentId });
  expect(dataOf(segment)).toEqual({ targetType: 'segment', totalTokens: 3, deviceCount: 2 });

  const devices = await preview({ deviceIdentityIds: [outside.id] });
  expect(dataOf(devices)).toEqual({ targetType: 'devices', totalTokens: 1, deviceCount: 1 });

  const foreignOnly = await preview({ deviceIdentityIds: [foreign.id] });
  expect([foreignOnly.status, messageOf(foreignOnly)]).toEqual([400, 'None of these devices belong to this project.']);

  const both = await preview({ segmentId, deviceIdentityIds: [outside.id] });
  expect(dataOf(both)).toEqual({ targetType: 'segment', totalTokens: 3, deviceCount: 2 });
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-181 send to one person by distinct id', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-181', { fcm: true });
  const d6 = await addDevice(p, p.owner.ip, { distinctId: 'user-42' });
  const d7 = await addDevice(p, p.owner.ip, { distinctId: 'user-42' });
  await addDevice(p, p.owner.ip, { distinctId: 'someone-else' });
  // The later-created device is the one seen most recently, so picking the first row
  // found would name the wrong one.
  await sql(`UPDATE device_identities SET last_seen_at = now() - interval '1 day' WHERE id = $1`, [d6.id]);
  await sql(`UPDATE device_identities SET last_seen_at = now() WHERE id = $1`, [d7.id]);
  const member = await teammate(p.project.id, 'member', p.owner);
  const sendToUser = (as: Parameters<typeof call>[2], body: Record<string, unknown>) =>
    call('POST', '/api/push-notifications/send-to-user', as, { projectId: p.project.id, ...body });

  const sent = await sendToUser(p.owner, { distinctId: 'user-42', title: 'Hi' });
  expect(sent.status).toBe(201);
  const campaign = dataOf(sent);
  expect(campaign).toMatchObject({ targetType: 'devices', totalTokens: 2 });
  expect(await campaignRecipients(campaign.id)).toEqual([d6.id, d7.id].sort());

  const entries = await activityRows(p.project.id, 'push.sent_to_person');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ actor_user_id: p.owner.userId, target_type: 'person', target_id: d7.id });
  const logged = JSON.stringify(entries[0]);
  for (const secret of ['user-42', ...d6.tokens, ...d7.tokens]) expect(logged).not.toContain(secret);

  const unknown = await sendToUser(p.owner, { distinctId: 'nobody', title: 'Hi' });
  expect([unknown.status, messageOf(unknown)]).toEqual([404, 'No devices found for distinctId: nobody']);

  const byMember = await sendToUser(member, { distinctId: 'user-42', title: 'From a member' });
  expect(byMember.status).toBe(201);

  const staff = await signedInStaff(browser, baseURL);
  const viewAs = await viewAsCaller(staff, p.owner);
  const refused = await sendToUser(viewAs, { distinctId: 'user-42', title: 'Read-only' });
  expect([refused.status, messageOf(refused)]).toEqual([403, READ_ONLY]);

  expect((await campaignRows(p.project.id)).map((row) => row.title).sort()).toEqual(['From a member', 'Hi']);
  expect(await activityRows(p.project.id, 'push.sent_to_person')).toHaveLength(2);
});

// ---------------------------------------------------- M. Campaign detail ---

test('PUSH-183 campaign not found', async ({ page }) => {
  const p = await pushProject('push-183', { fcm: true });
  const other = await pushProject('push-183-x', { fcm: true });
  const own = await seedCampaign(p.project.id, { title: 'Ours 183' });
  const theirs = await seedCampaign(other.project.id, { title: 'Theirs 183' });
  const random = randomId();

  for (const id of [random, theirs]) {
    const answer = await call('GET', `/api/push-notifications/campaign/${p.project.id}/${id}`, p.owner);
    expect([answer.status, messageOf(answer)]).toEqual([404, CAMPAIGN_NOT_FOUND]);
    expect(answer.text).not.toContain('Theirs 183');
  }
  // Current behaviour: an id that is not a uuid gets a generic 500 with no detail.
  const malformed = await call('GET', `/api/push-notifications/campaign/${p.project.id}/abc`, p.owner);
  expect([malformed.status, messageOf(malformed)]).toEqual([500, 'Internal server error']);
  expect(malformed.text).not.toMatch(/uuid|syntax|postgres|query/i);

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, own);
  await expect(page.getByRole('heading', { level: 1, name: 'Ours 183' })).toBeVisible();
  for (const id of [random, theirs, 'abc']) {
    await openCampaign(page, p.project.id, id);
    await expect(page.getByText(NOT_FOUND_PAGE, { exact: true })).toBeVisible();
    await expect(page.getByText('Theirs 183')).toHaveCount(0);
    const back = page.getByRole('link', { name: 'Back to campaigns' });
    await expect(back).toHaveAttribute('href', `/projects/${p.project.id}/push-notifications`);
  }
  await page.getByRole('link', { name: 'Back to campaigns' }).click();
  await expect(page.getByRole('heading', { name: 'Push Notifications', exact: true })).toBeVisible();
});

test('PUSH-184 header of a sent campaign', async ({ page }) => {
  const p = await pushProject('push-184', { fcm: true });
  const id = await seedLogRow(p.project.id, {
    title: 'Weekend deals',
    status: 'sent',
    deep_link_url: 'myapp://deals/7',
    sent_at: new Date('2026-11-10T08:15:00Z'),
    completed_at: new Date('2026-11-10T08:17:00Z'),
  });
  const stored = dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${id}`, p.owner));

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, id);
  await expect(page.getByRole('heading', { level: 1, name: 'Weekend deals', exact: true })).toBeVisible();
  await expect(headingBadges(page)).toHaveText(['Sent']);
  await expect(timingLine(page)).toHaveText(
    `Sent ${formatUtc(stored.sentAt, true)} · completed ${formatUtc(stored.completedAt, true)}`,
  );
  await expect(timingLine(page)).toHaveText('Sent Nov 10, 2026 08:15 · completed Nov 10, 2026 08:17');
  await expect(page.getByText(/^Opens /)).toHaveText('Opens myapp://deals/7');
  await expect(page.getByRole('button', { name: 'Cancel campaign' })).toHaveCount(0);

  await backArrow(page).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications$`));
  await expect(page.getByRole('heading', { name: 'Push Notifications', exact: true })).toBeVisible();
});

test('PUSH-185 header of a scheduled campaign', async ({ page }) => {
  const p = await pushProject('push-185', { fcm: true });
  await addDevice(p, p.owner.ip);
  const scheduled = await scheduleCampaign(p, 'Next month');

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, scheduled.id);
  await expect(page.getByRole('heading', { level: 1, name: 'Next month', exact: true })).toBeVisible();
  await expect(headingBadges(page)).toHaveText(['Scheduled']);
  await expect(timingLine(page)).toHaveText(`Scheduled for ${formatUtc(scheduled.scheduledAt, true)}`);
  await expect(timingLine(page)).not.toContainText('completed');
  await expect(page.getByRole('button', { name: 'Cancel campaign' })).toBeVisible();
});

test('PUSH-187 error message card', async ({ page }) => {
  const p = await pushProject('push-187', { fcm: true });
  const text = 'Rejected: <b>credentials</b> & <i>key</i> refused';
  const id = await seedCampaign(p.project.id, { title: 'Broken send', status: 'failed', errorMessage: text });
  const fine = await seedCampaign(p.project.id, { title: 'Fine send', status: 'sent' });

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, fine);
  await expect(page.getByRole('heading', { level: 1, name: 'Fine send' })).toBeVisible();
  await expect(page.locator('div.border-destructive\\/40')).toHaveCount(0);

  await openCampaign(page, p.project.id, id);
  const errorCard = page.locator('[data-slot="card"].border-destructive\\/40');
  await expect(errorCard).toHaveCount(1);
  await expect(errorCard).toHaveText(text);
  await expect(errorCard.locator('svg.text-destructive')).toHaveCount(1);
  await expect(errorCard.locator('b, i')).toHaveCount(0);
});

test('PUSH-188 engagement figures', async ({ page }) => {
  const p = await pushProject('push-188', { fcm: true });
  const id = await seedCampaign(p.project.id, { title: 'Engaged', status: 'sent', totalTokens: 10, successCount: 10 });
  const devices: Device[] = [];
  for (let i = 0; i < 10; i++) devices.push(await addDevice(p, p.owner.ip, { tokens: 0 }));
  const report = async (type: 'delivered' | 'impression' | 'click' | 'dismissed', count: number) => {
    for (const device of devices.slice(0, count)) await reportEvent(p, id, device, type);
  };
  await report('delivered', 10);
  await report('impression', 6);
  await report('click', 3);
  await report('dismissed', 1);

  const api = dataOf(await call('GET', `/api/push-notifications/report/${p.project.id}/${id}`, p.owner));
  expect(api).toMatchObject({ delivered: 10, impressions: 6, clicks: 3, dismissed: 1, clickThroughRate: 30 });

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, id);
  const engagement = card(page, 'Engagement');
  await expect(engagement.locator('[data-slot="card-description"]')).toHaveText(
    'Reported by the Chumbaq SDK running in your app — not by Firebase.',
  );
  const tiles: Array<[string, string]> = [
    ['Delivered', '10'],
    ['Impressions', '6'],
    ['Clicks', '3'],
    ['Dismissed', '1'],
    ['Click-through rate', '30%'],
  ];
  for (const [label, value] of tiles) await expect(figureTile(page, 'Engagement', label), label).toHaveText(value);
  await expect(engagement.getByText(/^Nothing reported yet\./)).toHaveCount(0);
});

test('PUSH-190 delivery card', async ({ page }) => {
  const p = await pushProject('push-190', { fcm: true });
  const sent = await seedLogRow(p.project.id, { title: 'Nine of ten', status: 'sent', total_tokens: 10, success_count: 9, failure_count: 1, processed_tokens: 10 });
  const sending = await seedLogRow(p.project.id, { title: 'Under way', status: 'sending', total_tokens: 10, success_count: 4, failure_count: 0, processed_tokens: 4 });

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, sent);
  const delivery = card(page, 'Delivery');
  await expect(delivery.locator('[data-slot="card-description"]')).toHaveText(
    'Accepted is what Firebase took from us; Delivered above is what a handset confirmed. A campaign can score full marks here and still reach nobody.',
  );
  await expect(figureTile(page, 'Delivery', 'Accepted by Firebase')).toHaveText('9 / 10');
  await expect(figureTile(page, 'Delivery', 'Failed')).toHaveText('1');
  await expect(delivery.getByText(/^Still delivering/)).toHaveCount(0);

  await openCampaign(page, p.project.id, sending);
  await expect(page.getByRole('heading', { level: 1, name: 'Under way' })).toBeVisible();
  await expect(figureTile(page, 'Delivery', 'Accepted by Firebase')).toHaveText('4 / 10');
  await expect(card(page, 'Delivery').getByText('Still delivering — 4/10 processed so far.', { exact: true })).toBeVisible();
});

test('PUSH-191 failure breakdown', async ({ page }) => {
  const p = await pushProject('push-191', { fcm: true });
  const unregistered =
    'FCM error 404: {"error":{"status":"NOT_FOUND","message":"Requested entity was not found.","details":[{"errorCode":"UNREGISTERED"}]}}';
  const token = (n: number) => `e2e-failed-token-${n}-${'x'.repeat(20)}-${String(n).padStart(10, '0')}`;
  // Seeded out of order, so the badges are seen to be sorted by count.
  const failures = [
    { token: token(1), error: 'SENDER_ID_MISMATCH' },
    { token: token(2), error: unregistered },
    { token: token(3), error: 'weird' },
    { token: token(4), error: unregistered },
    { token: token(5), error: unregistered },
  ];
  const id = await seedCampaign(p.project.id, {
    title: 'Mostly failed',
    status: 'partial',
    failureDetails: failures,
    totalTokens: 300,
    successCount: 50,
    failureCount: 250,
  });

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, id);
  const delivery = card(page, 'Delivery');
  // Each badge is a tooltip trigger, which takes over its data-slot.
  const badges = delivery.locator('[data-slot="tooltip-trigger"]');
  await expect(badges).toHaveText(['UNREGISTERED × 3', 'SENDER_ID_MISMATCH × 1', 'weird × 1']);
  const tips: Array<[string, string]> = [
    ['UNREGISTERED × 3', 'Requested entity was not found.'],
    ['SENDER_ID_MISMATCH × 1', 'Token belongs to a different Firebase project'],
    ['weird × 1', 'Reported by Firebase'],
  ];
  for (const [badge, tip] of tips) {
    await badges.filter({ hasText: badge }).hover();
    await expect(page.getByRole('tooltip')).toHaveText(tip);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  }

  await expect(delivery.getByRole('columnheader')).toHaveText(['Token', 'FCM error']);
  const rows = delivery.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  const expected: Array<[string, string | null]> = [
    ['SENDER_ID_MISMATCH', '— Token belongs to a different Firebase project'],
    ['UNREGISTERED', '— Requested entity was not found.'],
    ['weird', null],
    ['UNREGISTERED', '— Requested entity was not found.'],
    ['UNREGISTERED', '— Requested entity was not found.'],
  ];
  for (const [i, [code, gloss]] of expected.entries()) {
    const cells = rows.nth(i).getByRole('cell');
    await expect(cells.nth(0)).toHaveText(`…${failures[i].token.slice(-10)}`);
    await expect(cells.nth(0)).toHaveAttribute('title', failures[i].token);
    await expect(cells.nth(1).locator('span.font-mono')).toHaveText(code);
    if (gloss) await expect(cells.nth(1).locator('span.text-muted-foreground')).toHaveText(gloss);
    else await expect(cells.nth(1).locator('span')).toHaveCount(1);
    await expect(cells.nth(1)).toHaveAttribute('title', failures[i].error);
  }
  await expect(delivery.getByText('Showing 5 of 250 failures — the rest were not sampled.', { exact: true })).toBeVisible();
});

test('PUSH-193 experiment results: not split yet and no control', async ({ page }) => {
  const p = await pushProject('push-193', { fcm: true });
  for (let i = 0; i < 4; i++) await addDevice(p, p.owner.ip);
  const parent = await scheduleCampaign(p, 'Which headline', {
    variants: [
      { key: 'A', title: 'Headline A', weight: 50 },
      { key: 'B', title: 'Headline B', weight: 50 },
    ],
    controlPercentage: 0,
  });

  const api = dataOf(await call('GET', `/api/push-notifications/experiment/${p.project.id}/${parent.id}`, p.owner));
  expect(api).toEqual({
    isExperiment: true,
    controlSize: 0,
    arms: [],
    leader: null,
    verdict: 'This experiment has not been split into arms yet.',
  });

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, parent.id);
  const results = card(page, 'Experiment results');
  await expect(results).toBeVisible();
  await expect(results.locator('div.rounded-lg.border.p-4').first()).toHaveText('This experiment has not been split into arms yet.');
  await expect(results.locator('svg.lucide-trophy')).toHaveCount(0);
  await expect(results.getByText('No control group was held back for this experiment.', { exact: true })).toBeVisible();
  await expect(results.getByText("The variant arms haven't been created yet.", { exact: true })).toBeVisible();
  await expect(results.getByRole('table')).toHaveCount(0);
});

test('PUSH-194 experiment results: verdict ladder', async ({ page }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-194', { fcm: true });
  const deviceIds = await insertDeviceRows(p.project.id, 200);

  /** A split experiment: a parent and two sent arms, with events per arm. */
  const experiment = async (
    title: string,
    a: { delivered: number; clicks: number },
    b: { delivered: number; clicks: number },
  ) => {
    const parent = await seedLogRow(p.project.id, {
      title,
      status: 'expanded',
      variants: [
        { key: 'A', title: 'Arm A', weight: 50 },
        { key: 'B', title: 'Arm B', weight: 50 },
      ],
      control_percentage: 0,
      total_tokens: 400,
      success_count: 0,
      processed_tokens: 0,
    });
    const arms: Record<string, string> = {};
    for (const [key, figures] of [['A', a], ['B', b]] as const) {
      arms[key] = await seedLogRow(p.project.id, {
        title: `${title} ${key}`,
        status: 'sent',
        parent_campaign_id: parent,
        variant_key: key,
        total_tokens: 200,
        success_count: 190,
        processed_tokens: 200,
      });
      await insertEvents(p.project.id, arms[key], deviceIds.slice(0, figures.delivered), 'delivered');
      await insertEvents(p.project.id, arms[key], deviceIds.slice(0, figures.clicks), 'click');
    }
    return { parent, arms };
  };
  const verdictBox = () => card(page, 'Experiment results').locator('div.rounded-lg.border.p-4').first();

  const none = await experiment('No data yet', { delivered: 0, clicks: 0 }, { delivered: 0, clicks: 0 });
  const early = await experiment('Too early', { delivered: 50, clicks: 5 }, { delivered: 120, clicks: 12 });
  const close = await experiment('Close call', { delivered: 200, clicks: 20 }, { delivered: 200, clicks: 21 });
  const clear = await experiment('Clear winner', { delivered: 200, clicks: 24 }, { delivered: 200, clicks: 18 });

  await signIn(page, p.owner);
  const ladder: Array<[typeof none, string]> = [
    [none, 'No results yet. Delivery and clicks are reported by the SDK in your app.'],
    [early, 'Too early to call — each arm needs at least 100 delivered messages.'],
    [close, 'No clear difference between the arms.'],
  ];
  for (const [run, verdict] of ladder) {
    await openCampaign(page, p.project.id, run.parent);
    await expect(verdictBox()).toHaveText(verdict);
    await expect(verdictBox()).not.toHaveClass(/border-green-600/);
    await expect(card(page, 'Experiment results').locator('svg.lucide-trophy')).toHaveCount(0);
    await expect(card(page, 'Experiment results').getByText('Leading', { exact: true })).toHaveCount(0);
  }
  // No delivery reported: the CTR cells are dashes.
  await openCampaign(page, p.project.id, none.parent);
  await expect(card(page, 'Experiment results').locator('tbody tr td:last-child')).toHaveText(['—', '—']);

  const api = dataOf(await call('GET', `/api/push-notifications/experiment/${p.project.id}/${clear.parent}`, p.owner));
  expect(api).toMatchObject({ isExperiment: true, leader: 'A', verdict: 'A is ahead by 3.0 percentage points.' });
  expect(api.arms.map((arm: any) => [arm.variantKey, arm.recipients, arm.accepted, arm.engagement.delivered, arm.engagement.clicks])).toEqual([
    ['A', 200, 190, 200, 24],
    ['B', 200, 190, 200, 18],
  ]);

  await openCampaign(page, p.project.id, clear.parent);
  const results = card(page, 'Experiment results');
  await expect(verdictBox()).toHaveText('A is ahead by 3.0 percentage points.');
  await expect(verdictBox()).toHaveClass(/border-green-600\/30/);
  await expect(verdictBox().locator('svg.lucide-trophy')).toHaveCount(1);
  await expect(results.getByRole('columnheader')).toHaveText(['Variant', 'Recipients', 'Accepted', 'Delivered', 'Clicks', 'CTR']);
  const rows = results.locator('tbody tr');
  await expect(rows.nth(0).getByRole('cell')).toHaveText([/^A\s*Leading$/, '200', '190', '200', '24', '12%']);
  await expect(rows.nth(1).getByRole('cell')).toHaveText(['B', '200', '190', '200', '18', '9%']);
  await expect(rows.nth(0)).toHaveClass(/bg-green-50/);
  await expect(rows.nth(1)).not.toHaveClass(/bg-green-50/);
  await expect(rows.nth(0).locator('[data-slot="badge"]')).toHaveText('Leading');
  await expect(rows.nth(1).locator('[data-slot="badge"]')).toHaveCount(0);
  await expect(rows.nth(1).getByRole('link', { name: 'B', exact: true })).toHaveAttribute(
    'href',
    `/projects/${p.project.id}/push-notifications/${clear.arms.B}`,
  );
  await rows.nth(0).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/push-notifications/${clear.arms.A}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Clear winner A' })).toBeVisible();
});

test('PUSH-201 cancel refused once dispatched', async ({ page }) => {
  const p = await pushProject('push-201', { fcm: true });
  await addDevice(p, p.owner.ip);
  const scheduled = await scheduleCampaign(p, 'Dispatched meanwhile');

  await signIn(page, p.owner);
  await openCampaign(page, p.project.id, scheduled.id);
  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Cancel this campaign?' })).toBeVisible();
  // Promoted by the worker after the page loaded.
  await sql(`UPDATE push_notification_logs SET status = 'queued' WHERE id = $1`, [scheduled.id]);
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/push-notifications/cancel/${p.project.id}/${scheduled.id}`)),
    dialog.getByRole('button', { name: 'Cancel campaign' }).click(),
  ]);
  expect(answer.status()).toBe(400);
  const toast = toastBehindDialog(page, 'Error');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Only a scheduled campaign can be cancelled; this one is queued.');
  await expect(toastBehindDialog(page, 'Campaign cancelled')).toHaveCount(0);

  expect((await campaignRow(scheduled.id))?.status).toBe('queued');
  expect(await activityRows(p.project.id, 'campaign.cancelled')).toHaveLength(0);
  expect(await activityRows(p.project.id, 'campaign.scheduled')).toHaveLength(1);
});

test('PUSH-202 cancel a repeating campaign', async () => {
  test.setTimeout(180_000);
  const p = await pushProject('push-202', { fcm: true });
  await addDevice(p, p.owner.ip);
  const rule = { frequency: 'daily', interval: 1, atTime: '09:00', timezone: 'UTC' };
  const repeat = async (title: string) => {
    const created = await call('POST', SEND, p.owner, { projectId: p.project.id, title, recurrence: rule });
    expect(created.status).toBe(201);
    expect(dataOf(created).status).toBe('scheduled');
    return dataOf(created).id as string;
  };
  const cancelled = await repeat('Daily, then cancelled');
  const control = await repeat('Daily, kept');
  // Occurrences spawned before the cancel: one sent, one still waiting.
  const sentBefore = await seedLogRow(p.project.id, { title: 'Daily, then cancelled', status: 'sent', parent_campaign_id: cancelled });
  const waiting = await seedLogRow(p.project.id, {
    title: 'Daily, then cancelled',
    status: 'scheduled',
    parent_campaign_id: cancelled,
    scheduled_at: new Date(Date.now() + 10 * DAY),
    processed_tokens: 0,
    success_count: 0,
  });

  const answer = await call('POST', `/api/push-notifications/cancel/${p.project.id}/${cancelled}`, p.owner);
  expect(answer.status).toBe(201);
  expect(dataOf(answer).status).toBe('cancelled');
  expect(await activityRows(p.project.id, 'campaign.cancelled')).toHaveLength(1);

  // Both series come due now; only the one still scheduled spawns.
  await sql(`UPDATE push_notification_logs SET scheduled_at = date_trunc('milliseconds', now() - interval '1 minute') WHERE id = ANY($1::uuid[])`, [[cancelled, control]]);
  const dueAt = (await campaignRow(cancelled))?.scheduled_at;
  const children = async (parentId: string) => (await campaignRows(p.project.id)).filter((row) => row.parent_campaign_id === parentId);
  await expect.poll(async () => (await children(control)).length, { timeout: 120_000, intervals: [2_000] }).toBe(1);

  const template = await campaignRow(cancelled);
  expect(template?.status).toBe('cancelled');
  expect(new Date(template?.scheduled_at).getTime()).toBe(new Date(dueAt).getTime());
  const spawned = await children(cancelled);
  expect(spawned.map((row) => [row.id, row.status]).sort()).toEqual(
    [
      [sentBefore, 'sent'],
      [waiting, 'scheduled'],
    ].sort(),
  );
  expect((await campaignRow(control))?.status).toBe('scheduled');
});

// ------------------------------------------------------------ N. Templates ---

test('PUSH-207 templates empty state', async ({ page }) => {
  const p = await pushProject('push-207', { fcm: true });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Templates');
  await expect(page.getByRole('button', { name: 'New template' })).toBeVisible();
  const templates = card(page, 'Templates');
  await expect(templates.locator('[data-slot="card-description"]')).toHaveText(
    'Reusable notification content — title, body, image, deep link. A template never holds an audience or a schedule; those are chosen fresh each time you send.',
  );
  await expect(templates.getByText('No templates yet', { exact: true })).toBeVisible();
  await expect(
    templates.getByText(
      "A template saves a notification's content so it can be reused across campaigns. It holds content only — no audience and no schedule — since those are decisions about a particular send, not something worth freezing into a saved template.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(templates.getByRole('table')).toHaveCount(0);
  await templates.getByRole('button', { name: 'Create your first template' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'New template' })).toBeVisible();
});

test('PUSH-209 create a template', async ({ page }) => {
  const p = await pushProject('push-209', { fcm: true });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Templates');
  await page.getByRole('button', { name: 'New template' }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByRole('heading', { name: 'New template' })).toBeVisible();
  await expect(editor.getByText('Content only — audience and schedule are chosen when you send a campaign, not saved here.', { exact: true })).toBeVisible();
  const create = editor.getByRole('button', { name: 'Create template' });
  await expect(create).toBeDisabled();
  await dialogField(editor, 'Name *').fill('  Weekly promo ');
  await expect(create).toBeDisabled();
  await dialogField(editor, 'Title *').fill('   ');
  await expect(create).toBeDisabled();
  await dialogField(editor, 'Title *').fill(' This week ');
  await expect(create).toBeEnabled();
  await dialogField(editor, 'Name *').fill('   ');
  await expect(create).toBeDisabled();
  await dialogField(editor, 'Name *').fill('  Weekly promo ');
  await dialogField(editor, 'Description').fill('Fridays');
  await dialogField(editor, 'Body').fill('Deals');
  await dialogField(editor, 'Image URL').fill('https://example.com/promo.png');
  await dialogField(editor, 'Deep link URL').fill(' myapp://deals ');

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let posted: Record<string, any> | undefined;
  await page.route(`**${TEMPLATES(p.project.id)}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted = route.request().postDataJSON();
    await held;
    await route.continue();
  });
  await create.click();
  await expect(editor.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  release();
  await expect(toastBehindDialog(page, 'Template created')).toBeVisible();
  await expect(editor).toHaveCount(0);
  expect(posted).toEqual({
    name: 'Weekly promo',
    title: 'This week',
    description: 'Fridays',
    body: 'Deals',
    imageUrl: 'https://example.com/promo.png',
    deepLinkUrl: 'myapp://deals',
    silent: false,
    data: null,
    deliveryOptions: null,
    translations: null,
  });

  const row = templateRowOnPage(page, 'Weekly promo');
  for (const [i, text] of ['Weekly promo', 'Fridays', 'This week', '0'].entries()) await expect(row.getByRole('cell').nth(i)).toHaveText(text);
  await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible();

  // Blank optional fields are stored as null.
  await page.getByRole('button', { name: 'New template' }).click();
  await dialogField(editor, 'Name *').fill('Bare');
  await dialogField(editor, 'Title *').fill('Only a title');
  await dialogField(editor, 'Description').fill('   ');
  await editor.getByRole('button', { name: 'Create template' }).click();
  await expect(editor).toHaveCount(0);
  await expect(templateRowOnPage(page, 'Bare').getByRole('cell').nth(1)).toHaveText('—');

  const [bare, weekly] = await templateRows(p.project.id);
  expect(weekly).toMatchObject({
    name: 'Weekly promo',
    description: 'Fridays',
    title: 'This week',
    body: 'Deals',
    image_url: 'https://example.com/promo.png',
    deep_link_url: 'myapp://deals',
    silent: false,
    data: null,
    delivery_options: null,
    translations: null,
    use_count: 0,
  });
  expect(bare).toMatchObject({ name: 'Bare', title: 'Only a title', description: null, body: null, image_url: null, deep_link_url: null });
});

test('PUSH-211 duplicate template name', async ({ page }) => {
  const p = await pushProject('push-211', { fcm: true });
  await createTemplate(p.owner, p.project.id, { name: 'Weekly promo', title: 'This week' });
  const message = 'A template named "Weekly promo" already exists.';

  const viaApi = await call('POST', TEMPLATES(p.project.id), p.owner, { name: 'Weekly promo', title: 'Again' });
  expect([viaApi.status, messageOf(viaApi)]).toEqual([409, message]);

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Templates');
  await page.getByRole('button', { name: 'New template' }).click();
  const editor = page.getByRole('dialog');
  await dialogField(editor, 'Name *').fill('Weekly promo');
  await dialogField(editor, 'Title *').fill('Again');
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(TEMPLATES(p.project.id)) && r.request().method() === 'POST'),
    editor.getByRole('button', { name: 'Create template' }).click(),
  ]);
  expect(answer.status()).toBe(409);
  const inline = field(editor, 'Name *').locator('p.text-destructive');
  await expect(inline).toHaveText(message);
  await expect(editor.getByRole('heading', { name: 'New template' })).toBeVisible();
  await expect(toastBehindDialog(page, 'Could not create template')).toHaveCount(0);

  await dialogField(editor, 'Name *').fill('weekly promo');
  await expect(inline).toHaveCount(0);
  await editor.getByRole('button', { name: 'Create template' }).click();
  await expect(editor).toHaveCount(0);
  await expect(toastTitled(page, 'Template created')).toBeVisible();
  expect((await templateRows(p.project.id)).map((row) => row.name).sort()).toEqual(['Weekly promo', 'weekly promo']);
});

test('PUSH-215 edit a template', async ({ page }) => {
  const p = await pushProject('push-215', { fcm: true });
  const actions = [{ id: 'open', title: 'Open' }];
  const carousel = [{ imageUrl: 'https://example.com/a.png' }, { imageUrl: 'https://example.com/b.png' }];
  const timer = { durationSeconds: 3600 };
  const template = await createTemplate(p.owner, p.project.id, {
    name: 'Weekly promo',
    description: 'Fridays',
    title: 'This week',
    body: 'Deals',
    actions,
    carousel,
    timer,
  });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Templates');
  await templateRowOnPage(page, 'Weekly promo').getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByRole('heading', { name: 'Edit template' })).toBeVisible();
  await expect(dialogField(editor, 'Name *')).toHaveValue('Weekly promo');
  await expect(dialogField(editor, 'Description')).toHaveValue('Fridays');
  await expect(dialogField(editor, 'Title *')).toHaveValue('This week');
  await expect(dialogField(editor, 'Body')).toHaveValue('Deals');
  await dialogField(editor, 'Title *').fill('Next week');

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith(`${TEMPLATES(p.project.id)}/${template.id}`) && r.method() === 'PATCH'),
    editor.getByRole('button', { name: 'Save changes' }).click(),
  ]);
  await expect(toastBehindDialog(page, 'Template updated')).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(templateRowOnPage(page, 'Weekly promo').getByRole('cell').nth(2)).toHaveText('Next week');

  const patch = request.postDataJSON();
  expect(Object.keys(patch).sort()).toEqual(
    ['body', 'data', 'deepLinkUrl', 'deliveryOptions', 'description', 'imageUrl', 'name', 'silent', 'title', 'translations'].sort(),
  );
  expect(patch).toMatchObject({ name: 'Weekly promo', title: 'Next week', description: 'Fridays', body: 'Deals' });
  const stored = await templateRow(template.id);
  expect(stored).toMatchObject({ title: 'Next week', actions, carousel, timer });
});

test('PUSH-218 delete a template', async ({ page }) => {
  const p = await pushProject('push-218', { fcm: true });
  const template = await createTemplate(p.owner, p.project.id, { name: 'Weekly promo', title: 'This week' });
  await createTemplate(p.owner, p.project.id, { name: 'Stays', title: 'Kept' });

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Templates');
  const row = templateRowOnPage(page, 'Weekly promo');
  const messages: string[] = [];
  page.once('dialog', (dialog) => {
    messages.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => messages).toEqual(['confirm: Delete the template "Weekly promo"? This cannot be undone.']);
  await expect(row).toHaveCount(1);
  expect(await templateRow(template.id)).toBeDefined();

  page.once('dialog', (dialog) => void dialog.accept());
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`${TEMPLATES(p.project.id)}/${template.id}`) && r.request().method() === 'DELETE'),
    row.getByRole('button', { name: 'Delete' }).click(),
  ]);
  expect(answer.status()).toBe(200);
  await expect(row).toHaveCount(0);
  await expect(templateRowOnPage(page, 'Stays')).toHaveCount(1);
  const toasts = page.getByRole('region', { name: /Notifications/ });
  await expect(toasts).toHaveCount(1);
  await expect(toasts.locator('li')).toHaveCount(0);

  expect(await templateRow(template.id)).toBeUndefined();
  const entries = await activityRows(p.project.id, 'content.deleted');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    actor_user_id: p.owner.userId,
    target_type: 'template',
    target_id: template.id,
    target_label: 'Weekly promo',
    details: { kind: 'template' },
  });
});

test('PUSH-223 template API: rich content rules', async ({ page }) => {
  const p = await pushProject('push-223', { fcm: true });
  await addDevice(p, p.owner.ip);
  const create = (name: string, body: Record<string, unknown>) =>
    call('POST', TEMPLATES(p.project.id), p.owner, { name, title: 'Rich', ...body });
  const slide = (n: number) => ({ imageUrl: `https://example.com/${n}.png` });

  const refusals: Array<[Record<string, unknown>, string]> = [
    [
      { timer: { endsAt: new Date(Date.now() + 7 * DAY).toISOString() } },
      'A template countdown has to be a duration rather than a fixed end time — a fixed moment would pass, and every campaign started from this template afterwards would arrive already expired.',
    ],
    [{ timer: { durationSeconds: 30 } }, 'A countdown must run for at least 60 seconds.'],
    [{ carousel: [slide(1)] }, 'A carousel needs at least 2 slides.'],
  ];
  for (const [i, [body, message]] of refusals.entries()) {
    const refused = await create(`Refused ${i}`, body);
    expect([refused.status, messageOf(refused)], message).toEqual([400, message]);
  }
  expect(await templateRows(p.project.id)).toHaveLength(0);

  const rich = await create('Rich template', {
    actions: [
      { id: 'buy', title: 'Buy' },
      { id: 'later', title: 'Later' },
    ],
    carousel: [slide(1), slide(2)],
    timer: { durationSeconds: 86400 },
  });
  expect(rich.status).toBe(201);
  expect(await templateRow(dataOf(rich).id)).toMatchObject({ timer: { durationSeconds: 86400 }, carousel: [slide(1), slide(2)] });

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  const tile = card(page, 'Template')
    .locator('button[aria-pressed]')
    .filter({ has: page.locator('span.text-sm.font-medium', { hasText: /^Rich template$/ }) });
  await expect(tile.locator('[data-slot="badge"]')).toHaveText(['Carousel', '2 buttons', 'Countdown']);
});

test('PUSH-224 template API: records cannot be written', async () => {
  const p = await pushProject('push-224');
  const template = await createTemplate(p.owner, p.project.id, { name: 'Counted', title: 'Count me' });
  const path = `${TEMPLATES(p.project.id)}/${template.id}`;
  const before = await templateRow(template.id);

  const refusals: Array<[string, string, Record<string, unknown>, string]> = [
    ['PATCH', path, { useCount: 99 }, 'property useCount should not exist'],
    ['PATCH', path, { lastUsedAt: new Date().toISOString() }, 'property lastUsedAt should not exist'],
    ['PATCH', path, { title: 'Sneaky', useCount: 99 }, 'property useCount should not exist'],
    ['POST', TEMPLATES(p.project.id), { name: 'Other', title: 'Other', projectId: p.project.id }, 'property projectId should not exist'],
  ];
  for (const [method, url, body, message] of refusals) {
    const refused = await call(method, url, p.owner, body);
    expect([refused.status, messageOf(refused)], message).toEqual([400, message]);
  }
  expect(await templateRow(template.id)).toEqual(before);
  expect((await templateRows(p.project.id)).map((row) => row.name)).toEqual(['Counted']);

  // The same edit without the record field goes through.
  const allowed = await call('PATCH', path, p.owner, { title: 'Renamed' });
  expect(allowed.status).toBe(200);
  expect(await templateRow(template.id)).toMatchObject({ title: 'Renamed', use_count: 0, last_used_at: null });
});

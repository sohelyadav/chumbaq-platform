import type { Locator, Page } from '@playwright/test';
import { expect, signIn, test } from '../../support/fixtures';
import {
  actionBar,
  activityRows,
  addDevice,
  call,
  campaignRecipients,
  campaignRow,
  campaignRows,
  captureRefusedSend,
  card,
  composerSteps,
  createTemplate,
  dataOf,
  field,
  localClock,
  messageOf,
  nextButton,
  openComposer,
  openPush,
  pickDateTime,
  pushProject,
  reachFigure,
  reviewValue,
  sql,
  stepButton,
  submitCampaign,
  switchFor,
  templateRow,
  toastTitled,
  unregisterToken,
  zonedInstant,
  zonedParts,
  type PushProject,
} from '../../support/areas/push';

/**
 * Push, P1: the composer. Its steps and stepper, the audience (everyone, a segment,
 * chosen devices), the message step (built-in presets and saved templates, silent
 * pushes, translations), the A/B experiment form, action buttons, carousel and
 * countdown, and the delivery step (send time, local-time delivery, repeat). FCM is
 * seeded; sends are scheduled in the future where the worker is not under test.
 * Pages run in UTC with an en-US locale, so formatted times can be compared.
 */

const TZ = 'UTC';
test.use({ timezoneId: TZ, locale: 'en-US' });

const DAY = 86_400_000;
const NOT_CONFIGURED_WARNING =
  'FCM is not configured for this project, so nothing can be sent yet. Set it up under Settings on the push notifications page.';
const REACH_ERROR = 'Couldn’t calculate reach for this audience. Try changing the audience or reloading the page.';

/** Opens the composer and waits for the project-wide reach to be counted. */
async function composer(page: Page, p: PushProject, reach: number): Promise<void> {
  await openComposer(page, p.project.id);
  await expect(reachFigure(page)).toHaveText(String(reach));
}

function messageCard(page: Page) {
  return card(page, 'Message');
}

function titleInput(page: Page) {
  return field(messageCard(page), 'Title *').getByRole('textbox');
}

/** Audience → Message, with a title typed. */
async function toMessage(page: Page, title?: string): Promise<void> {
  await nextButton(page).click();
  await expect(page.getByText('Step 2 of 4 · What it says', { exact: true })).toBeVisible();
  if (title !== undefined) await titleInput(page).fill(title);
}

/** From Message to Review (two clicks of Next). */
async function messageToReview(page: Page): Promise<void> {
  await nextButton(page).click();
  await expect(page.getByText('Step 3 of 4 · When and how', { exact: true })).toBeVisible();
  await nextButton(page).click();
  await expect(page.getByText('Step 4 of 4 · Check, then send', { exact: true })).toBeVisible();
}

/** The `Send at` picker's trigger on the Delivery step. */
function sendAtTrigger(page: Page): Locator {
  return field(page, 'Send at').getByRole('button');
}

/** A day next month (the 15th), at `time`, in the page's zone. */
function nextMonthAt(time: string): { day: Date; at: Date } {
  const now = zonedParts(new Date(), TZ);
  const m = now.m === 12 ? 1 : now.m + 1;
  const y = now.m === 12 ? now.y + 1 : now.y;
  return { day: new Date(Date.UTC(y, m - 1, 15, 12)), at: zonedInstant(y, m, 15, time, TZ) };
}

/** Picks a Radix select option. */
async function choose(page: Page, trigger: Locator, option: string): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** A preset or saved-template tile in the gallery. */
function tile(page: Page, name: string): Locator {
  return card(page, 'Template').locator('button[aria-pressed]').filter({
    has: page.locator('span.text-sm.font-medium', { hasText: new RegExp(`^${name}$`) }),
  });
}

function actionsCard(page: Page) {
  return card(page, 'Action buttons');
}

function richCard(page: Page) {
  return card(page, 'Carousel & countdown');
}

/** The collapsible trigger in a card's header. */
function sectionToggle(scope: Locator): Locator {
  return scope.locator('[data-slot="card-header"] button').first();
}

/** A variant's bordered box, by its key badge. */
function variantBox(page: Page, key: string): Locator {
  return messageCard(page)
    .locator('div.rounded-lg.border.p-4')
    .filter({ has: page.locator('[data-slot="badge"]', { hasText: new RegExp(`^Variant ${key.replace(/[?]/g, '\\?')}$`) }) });
}

/** A device picker results row, by the device's distinct id. */
function deviceRow(page: Page, distinctId: string): Locator {
  return page.locator('div.divide-y > div').filter({ has: page.getByText(distinctId, { exact: true }).first() });
}

/** The red line under a section (small destructive text, not the action bar's). */
function errorLine(scope: Page | Locator, text: string): Locator {
  return scope.locator('p.text-xs.text-destructive', { hasText: text });
}

// ------------------------------------------------------ G. Composer: audience ---

test('PUSH-092 composer opens on the Audience step', async ({ page }) => {
  const p = await pushProject('push-092', { fcm: true });
  await addDevice(p, p.owner.ip);
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  await page.getByRole('link', { name: 'New campaign' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/new$`));
  await expect(page.getByRole('heading', { level: 1, name: 'New push campaign' })).toBeVisible();
  await expect(page.getByText('Step 1 of 4 · Who receives it', { exact: true })).toBeVisible();

  const steps = composerSteps(page).getByRole('button');
  await expect(steps).toHaveCount(4);
  await expect(stepButton(page, 'Audience')).toHaveAttribute('aria-current', 'step');
  await expect(stepButton(page, 'Audience')).toBeEnabled();
  for (const later of ['Message', 'Delivery', 'Review'] as const) {
    await expect(stepButton(page, later)).toBeDisabled();
    await expect(stepButton(page, later)).not.toHaveAttribute('aria-current', /.*/);
  }
  await expect(field(page, 'Send to').getByRole('combobox')).toHaveText('Everyone in this project');
  await expect(reachFigure(page)).toHaveText('2');
  await expect(page.getByText('devices will be reached.', { exact: true })).toBeVisible();
  await expect(actionBar(page)).toHaveText('Who receives it');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(nextButton(page)).toBeEnabled();
});

test('PUSH-093 next and back walk the steps; later steps cannot be skipped to', async ({ page }) => {
  const p = await pushProject('push-093', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  const subtitle = (text: string) => page.getByText(text, { exact: true });

  // A disabled step does nothing.
  await stepButton(page, 'Review').click({ force: true });
  await expect(subtitle('Step 1 of 4 · Who receives it')).toBeVisible();

  await toMessage(page, 'Walk the steps');
  await messageToReview(page);
  await expect(nextButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send campaign', exact: true })).toBeEnabled();
  await expect(stepButton(page, 'Review')).toHaveAttribute('aria-current', 'step');
  // Past steps carry a check instead of their number.
  for (const past of ['Audience', 'Message', 'Delivery'] as const) {
    await expect(stepButton(page, past).locator('svg.lucide-check')).toHaveCount(1);
  }
  await expect(stepButton(page, 'Review').locator('svg.lucide-check')).toHaveCount(0);

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(subtitle('Step 3 of 4 · When and how')).toBeVisible();
  await expect(stepButton(page, 'Delivery')).toHaveAttribute('aria-current', 'step');

  // Once reached, a step stays selectable from the stepper.
  await stepButton(page, 'Audience').click();
  await expect(subtitle('Step 1 of 4 · Who receives it')).toBeVisible();
  await expect(stepButton(page, 'Review')).toBeEnabled();
  await stepButton(page, 'Review').click();
  await expect(subtitle('Step 4 of 4 · Check, then send')).toBeVisible();
  await expect(reviewValue(page, 'Message')).toContainText('Walk the steps');
});

test('PUSH-096 unconfigured project: drafting allowed, sending not', async ({ page }) => {
  const p = await pushProject('push-096');
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await expect(page.getByText(NOT_CONFIGURED_WARNING, { exact: true })).toBeVisible();
  await expect(nextButton(page)).toBeEnabled();
  await toMessage(page, 'Drafted without FCM');
  await expect(nextButton(page)).toBeEnabled();
  await messageToReview(page);

  await expect(page.getByRole('button', { name: 'Send campaign', exact: true })).toBeDisabled();
  await expect(actionBar(page)).toHaveText('Sending to 1 device.');
  await expect(page.getByText(NOT_CONFIGURED_WARNING, { exact: true })).toBeVisible();
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-099 audience with no reachable devices', async ({ page }) => {
  const p = await pushProject('push-099', { fcm: true });

  await signIn(page, p.owner);
  await composer(page, p, 0);
  await expect(page.getByText('devices will be reached.', { exact: true })).toBeVisible();
  await expect(actionBar(page)).toHaveText('No reachable devices.');
  await expect(stepButton(page, 'Audience')).toContainText('No reachable devices.');
  await expect(stepButton(page, 'Audience').locator('svg.lucide-circle-alert, svg.lucide-alert-circle')).toHaveCount(1);
  await expect(nextButton(page)).toBeDisabled();

  // A token arrives; switching the audience away and back counts again.
  const device = await addDevice(p, p.owner.ip);
  const sendTo = field(page, 'Send to').getByRole('combobox');
  await choose(page, sendTo, 'Specific devices');
  await choose(page, sendTo, 'Everyone in this project');
  await expect(reachFigure(page)).toHaveText('1');
  await toMessage(page, 'Reach gone by review');
  await messageToReview(page);
  await expect(page.getByRole('button', { name: 'Send campaign', exact: true })).toBeEnabled();

  // Then it goes again, and Review (reached earlier) says so.
  await unregisterToken(p, p.owner.ip, device.tokens[0]);
  await stepButton(page, 'Audience').click();
  await choose(page, sendTo, 'Specific devices');
  await choose(page, sendTo, 'Everyone in this project');
  await expect(reachFigure(page)).toHaveText('0');
  await stepButton(page, 'Review').click();
  await expect(actionBar(page)).toHaveText('This audience has no reachable devices.');
  await expect(page.getByRole('button', { name: 'Send campaign', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Audience:\s*No reachable devices\./ })).toBeVisible();
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-101 choose a segment', async ({ page }) => {
  const p = await pushProject('push-101', { fcm: true });
  const pro = { plan: 'pro' };
  await addDevice(p, p.owner.ip, { traits: pro }); // D1
  await addDevice(p, p.owner.ip, { traits: pro }); // D2
  await addDevice(p, p.owner.ip, { traits: pro, pushOptIn: false }); // D3, opted out
  await addDevice(p, p.owner.ip, { traits: pro, tokens: 0 }); // D4, no token
  await addDevice(p, p.owner.ip, { traits: { plan: 'free' } }); // not in the segment
  const created = await call('POST', `/api/projects/${p.project.id}/segments`, p.owner, {
    name: 'Pro plan',
    definition: { type: 'group', operator: 'and', children: [{ type: 'attribute', field: 'traits.plan', op: 'eq', value: 'pro' }] },
  });
  const segmentId = dataOf<{ id: string }>(created).id;

  await signIn(page, p.owner);
  await composer(page, p, 3);
  await choose(page, field(page, 'Send to').getByRole('combobox'), 'A segment');
  await expect(page.getByText('Pick a segment to see its reach.', { exact: true })).toBeVisible();
  await expect(actionBar(page)).toHaveText('Choose a segment.');
  await expect(stepButton(page, 'Audience')).toContainText('Choose a segment.');
  await expect(nextButton(page)).toBeDisabled();

  const [preview] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/push-notifications/audience-preview') && (r.postData() ?? '').includes(segmentId)),
    choose(page, field(page, 'Segment').getByRole('combobox'), 'Pro plan'),
  ]);
  expect(preview.postDataJSON()).toEqual({ projectId: p.project.id, segmentId });
  await expect(reachFigure(page)).toHaveText('2');
  await expect(page.getByText('devices will be reached — the segment matches 4, the rest have no push token.', { exact: true })).toBeVisible();
  await expect(nextButton(page)).toBeEnabled();
  await expect(actionBar(page)).toHaveText('Who receives it');
});

test('PUSH-103 device picker: results and reachability labels', async ({ page }) => {
  const p = await pushProject('push-103', { fcm: true });
  const ip = p.owner.ip;
  await addDevice(p, ip, { distinctId: 'd103-one' });
  await addDevice(p, ip, { distinctId: 'd103-two' });
  await addDevice(p, ip, { distinctId: 'd103-none', tokens: 0 });
  await addDevice(p, ip, { distinctId: 'd103-pair' });
  await addDevice(p, ip, { distinctId: 'd103-pair' });

  await signIn(page, p.owner);
  await composer(page, p, 4);
  await choose(page, field(page, 'Send to').getByRole('combobox'), 'Specific devices');

  await expect(page.getByText(/^Each row is a single device identity\. Someone using more than one device appears once per device/)).toBeVisible();
  await expect(field(page, 'Search').getByRole('textbox')).toHaveAttribute('placeholder', 'Name, email or distinct id');
  await expect(switchFor(page, 'Show unreachable')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Selected (0)', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Nothing selected yet. Add devices from the results below — what you pick here stays selected while you keep searching.',
      { exact: true },
    ),
  ).toBeVisible();

  for (const id of ['d103-one', 'd103-two']) {
    const row = deviceRow(page, id);
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Reachable', { exact: true })).toBeVisible();
    await expect(row.getByText('android', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    await expect(row.getByText(/of \d+ devices/)).toHaveCount(0);
  }
  const pair = deviceRow(page, 'd103-pair');
  await expect(pair).toHaveCount(2);
  for (const row of await pair.all()) await expect(row.getByText('1 of 2 devices', { exact: true })).toBeVisible();
  await expect(deviceRow(page, 'd103-none')).toHaveCount(0);
  await expect(page.getByText('No push token', { exact: true })).toHaveCount(0);

  await expect(page.getByText('Select at least one device to see its reach.', { exact: true })).toBeVisible();
  await expect(reachFigure(page)).toHaveCount(0);
  await expect(actionBar(page)).toHaveText('Choose at least one device to send to.');
  await expect(nextButton(page)).toBeDisabled();
});

test('PUSH-104 device picker: add, remove, clear all', async ({ page }) => {
  const p = await pushProject('push-104', { fcm: true });
  const one = await addDevice(p, p.owner.ip, { distinctId: 'd104-one' });
  const two = await addDevice(p, p.owner.ip, { distinctId: 'd104-two', tokens: 2 });

  const previews: Array<Record<string, any>> = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/push-notifications/audience-preview')) previews.push(r.postDataJSON());
  });
  await signIn(page, p.owner);
  await composer(page, p, 3);
  await choose(page, field(page, 'Send to').getByRole('combobox'), 'Specific devices');
  const selected = page.getByText(/^Selected \(\d+\)$/);
  const chip = (name: string) => page.locator('[data-slot="badge"]').filter({ has: page.getByRole('button', { name: `Remove ${name}` }) });

  await deviceRow(page, 'd104-one').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(reachFigure(page)).toHaveText('1');
  await deviceRow(page, 'd104-two').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(selected).toHaveText('Selected (2)');
  await expect(chip('d104-one')).toBeVisible();
  await expect(chip('d104-two')).toBeVisible();
  await expect(deviceRow(page, 'd104-one').getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await expect(reachFigure(page)).toHaveText('3');
  await expect(nextButton(page)).toBeEnabled();

  // Removing by the chip.
  await page.getByRole('button', { name: 'Remove d104-two', exact: true }).click();
  await expect(selected).toHaveText('Selected (1)');
  await expect(deviceRow(page, 'd104-two').getByRole('button', { name: 'Add', exact: true })).toBeVisible();
  await expect(reachFigure(page)).toHaveText('1');
  // Adding back, then removing by the row button.
  await deviceRow(page, 'd104-two').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(reachFigure(page)).toHaveText('3');
  await deviceRow(page, 'd104-one').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(selected).toHaveText('Selected (1)');
  await expect(chip('d104-one')).toHaveCount(0);
  await expect(reachFigure(page)).toHaveText('2');
  await deviceRow(page, 'd104-one').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(reachFigure(page)).toHaveText('3');

  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(selected).toHaveText('Selected (0)');
  await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toHaveCount(0);
  await expect(page.getByText('Select at least one device to see its reach.', { exact: true })).toBeVisible();

  const withDevices = previews.filter((b) => Array.isArray(b.deviceIdentityIds)).map((b) => b.deviceIdentityIds);
  expect(withDevices).toEqual([[one.id], [one.id, two.id], [one.id], [one.id, two.id], [two.id], [two.id, one.id]]);
  for (const body of previews) expect(body.projectId).toBe(p.project.id);
});

// ------------------------------------------------------- H. Composer: message ---

const PRESETS: Array<[string, string, string[]]> = [
  ['Announcement', 'Text', ['Works everywhere']],
  ['Promo with image', 'Image', ['Deep link']],
  ['Flash sale', 'Image', ['Countdown', '2 buttons']],
  ['Product carousel', 'Carousel', ['3 slides', 'Per-slide links']],
  ['Cart reminder', 'Image', ['1 button', 'Personalised']],
  ['Win-back', 'Text', ['Personalised', 'Works everywhere']],
  ['Background sync', 'Silent', ['Custom data']],
];

test('PUSH-109 template gallery shows the built-in presets', async ({ page }) => {
  const p = await pushProject('push-109', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  const gallery = card(page, 'Template');
  await expect(gallery).toBeVisible();
  await expect(gallery.getByText('Start from a template', { exact: true })).toBeVisible();
  await expect(gallery.getByRole('button', { name: 'Starting blank', exact: true })).toBeVisible();

  const tiles = gallery.locator('button[aria-pressed]');
  await expect(tiles).toHaveCount(PRESETS.length);
  await expect(tiles.locator('span.text-sm.font-medium')).toHaveText(PRESETS.map(([name]) => name));
  for (const [name, layout, highlights] of PRESETS) {
    await expect(tile(page, name).locator('[data-slot="badge"]'), name).toHaveText([layout, ...highlights]);
    await expect(tile(page, name)).toHaveAttribute('aria-pressed', 'false');
  }
  await expect(gallery.getByText('Saved in this project', { exact: true })).toHaveCount(0);
});

test('PUSH-110 apply a preset to an empty form', async ({ page }) => {
  const p = await pushProject('push-110', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  await tile(page, 'Flash sale').click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tile(page, 'Flash sale')).toHaveAttribute('aria-pressed', 'true');
  await expect(tile(page, 'Flash sale').locator('svg.lucide-check')).toHaveCount(1);
  await expect(card(page, 'Template').getByRole('button', { name: 'Start blank instead', exact: true })).toBeVisible();

  const message = messageCard(page);
  await expect(titleInput(page)).toHaveValue('24 hours only — 30% off');
  await expect(field(message, 'Body').getByRole('textbox')).toHaveValue('Ends when the timer does.');
  await expect(field(message, 'Image URL').getByRole('textbox')).toHaveValue('https://example.com/sale.png');
  await expect(field(message, 'Deep link').getByRole('textbox')).toHaveValue('myapp://sale');

  const actions = actionsCard(page);
  await expect(sectionToggle(actions)).toHaveAttribute('aria-expanded', 'true');
  await expect(field(actions, 'Id *', 0).getByRole('textbox')).toHaveValue('shop');
  await expect(field(actions, 'Title *', 0).getByRole('textbox')).toHaveValue('Shop now');
  await expect(field(actions, 'Id *', 1).getByRole('textbox')).toHaveValue('later');
  await expect(field(actions, 'Title *', 1).getByRole('textbox')).toHaveValue('Remind me');
  await expect(field(actions, 'iOS category').getByRole('textbox')).toHaveValue('SALE');

  const rich = richCard(page);
  await expect(sectionToggle(rich)).toHaveAttribute('aria-expanded', 'true');
  await expect(field(rich, 'Countdown type').getByRole('combobox')).toHaveText('Duration — ends a set time after each send');
  await expect(field(rich, 'Ends after each send').getByRole('spinbutton')).toHaveValue('1');
  await expect(field(rich, 'Ends after each send').getByRole('combobox')).toHaveText('Days');

  await messageToReview(page);
  const sent = await submitCampaign(page, 'Send campaign');
  expect(sent.status).toBe(201);
  expect(sent.body).not.toHaveProperty('templateId');
  expect(sent.body).toMatchObject({
    title: '24 hours only — 30% off',
    iosCategory: 'SALE',
    timer: { durationSeconds: 86400 },
    actions: [
      { id: 'shop', title: 'Shop now', deepLinkUrl: 'myapp://sale' },
      { id: 'later', title: 'Remind me' },
    ],
  });
});

test('PUSH-112 replacing typed content asks first', async ({ page }) => {
  const p = await pushProject('push-112', { fcm: true });
  await addDevice(p, p.owner.ip, { distinctId: 'd112' });

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Mine');
  await tile(page, 'Announcement').click();

  const dialog = page.getByRole('dialog', { name: 'Replace what you’ve written?' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      'Applying “Announcement” overwrites the title, body, image, deep link, custom data, translations, action buttons, carousel and countdown in this campaign. That can’t be undone.',
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep what I have' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(titleInput(page)).toHaveValue('Mine');
  await expect(tile(page, 'Announcement')).toHaveAttribute('aria-pressed', 'false');

  await tile(page, 'Announcement').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Replace content' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(titleInput(page)).toHaveValue('We have something new for you');
  await expect(field(messageCard(page), 'Body').getByRole('textbox')).toHaveValue('Open the app to take a look.');
  await expect(tile(page, 'Announcement')).toHaveAttribute('aria-pressed', 'true');

  // Audience, schedule and action buttons are not content: a preset applies straight away.
  await openComposer(page, p.project.id);
  await choose(page, field(page, 'Send to').getByRole('combobox'), 'Specific devices');
  await deviceRow(page, 'd112').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(reachFigure(page)).toHaveText('1');
  await toMessage(page, 'Passing through');
  await nextButton(page).click();
  await pickDateTime(page, sendAtTrigger(page), nextMonthAt('10:30').day, TZ, '10:30');
  await stepButton(page, 'Message').click();
  await titleInput(page).fill('');
  await sectionToggle(actionsCard(page)).click();
  await actionsCard(page).getByRole('button', { name: 'Add button' }).click();
  await field(actionsCard(page), 'Id *').getByRole('textbox').fill('open');
  await field(actionsCard(page), 'Title *').getByRole('textbox').fill('Open');
  await tile(page, 'Win-back').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(titleInput(page)).toHaveValue('We miss you, {{firstName|there}}');
  await expect(tile(page, 'Win-back')).toHaveAttribute('aria-pressed', 'true');
  // The schedule picked before it is kept.
  await stepButton(page, 'Delivery').click();
  await expect(sendAtTrigger(page)).toHaveText(/ 10:30$/);
});

test('PUSH-114 saved templates in the gallery', async ({ page }) => {
  const p = await pushProject('push-114', { fcm: true });
  await addDevice(p, p.owner.ip);
  const t1 = await createTemplate(p.owner, p.project.id, { name: 'T1 weekly digest', description: 'Weekly', title: 'This week' });
  const t2 = await createTemplate(p.owner, p.project.id, { name: 'T2 quiet sync', title: 'Sync', silent: true });
  const t3 = await createTemplate(p.owner, p.project.id, {
    name: 'T3 order update',
    title: 'Your order',
    actions: [
      { id: 'track', title: 'Track' },
      { id: 'help', title: 'Help' },
    ],
    timer: { durationSeconds: 7200 },
    translations: { hi: { title: 'आपका ऑर्डर' } },
  });
  await sql(`UPDATE push_templates SET use_count = $2 WHERE id = $1`, [t1.id, 3]);
  await sql(`UPDATE push_templates SET use_count = $2 WHERE id = $1`, [t3.id, 1]);
  expect((await templateRow(t2.id))?.use_count).toBe(0);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  const saved = card(page, 'Template').getByText('Saved in this project', { exact: true }).locator('..');
  await expect(saved).toBeVisible();
  const savedTiles = saved.locator('button[aria-pressed]');
  await expect(savedTiles.locator('span.text-sm.font-medium')).toHaveText(['T1 weekly digest', 'T3 order update', 'T2 quiet sync']);

  await expect(tile(page, 'T1 weekly digest')).toContainText('Weekly');
  await expect(tile(page, 'T1 weekly digest').locator('[data-slot="badge"]')).toHaveText(['Text']);
  await expect(tile(page, 'T2 quiet sync')).toContainText('Not used yet');
  await expect(tile(page, 'T2 quiet sync').locator('[data-slot="badge"]')).toHaveText(['Silent']);
  await expect(tile(page, 'T3 order update')).toContainText('Used 1 time');
  await expect(tile(page, 'T3 order update').locator('[data-slot="badge"]')).toHaveText(['Text', '2 buttons', 'Countdown', 'Translated']);
});

test('PUSH-115 apply a saved template, detach, and use counting', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await pushProject('push-115', { fcm: true });
  await addDevice(p, p.owner.ip);
  const t3 = await createTemplate(p.owner, p.project.id, {
    name: 'T3 order update',
    title: 'Your order is on its way',
    body: 'Arrives tomorrow',
    actions: [
      { id: 'track', title: 'Track', deepLinkUrl: 'myapp://track' },
      { id: 'help', title: 'Help' },
    ],
    iosCategory: 'ORDER',
    timer: { durationSeconds: 172800 },
    translations: { hi: { title: 'आपका ऑर्डर रास्ते में है' } },
  });
  await sql(`UPDATE push_templates SET use_count = 1 WHERE id = $1`, [t3.id]);
  const when = nextMonthAt('10:30');

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  await tile(page, 'T3 order update').click();
  await expect(tile(page, 'T3 order update')).toHaveAttribute('aria-pressed', 'true');
  const copyNote = messageCard(page).getByText(/^These fields hold a copy you can edit freely/);
  await expect(copyNote).toBeVisible();
  await expect(messageCard(page).getByRole('button', { name: 'Detach', exact: true })).toBeVisible();
  await expect(titleInput(page)).toHaveValue('Your order is on its way');
  await expect(field(messageCard(page), 'Body').getByRole('textbox')).toHaveValue('Arrives tomorrow');
  await expect(field(actionsCard(page), 'Id *', 0).getByRole('textbox')).toHaveValue('track');
  await expect(field(actionsCard(page), 'Deep link', 0).getByRole('textbox')).toHaveValue('myapp://track');
  await expect(field(actionsCard(page), 'Title *', 1).getByRole('textbox')).toHaveValue('Help');
  await expect(field(actionsCard(page), 'iOS category').getByRole('textbox')).toHaveValue('ORDER');
  await expect(field(richCard(page), 'Countdown type').getByRole('combobox')).toHaveText('Duration — ends a set time after each send');
  await expect(field(richCard(page), 'Ends after each send').getByRole('spinbutton')).toHaveValue('2');
  await expect(field(richCard(page), 'Ends after each send').getByRole('combobox')).toHaveText('Days');
  await expect(messageCard(page).locator('[data-slot="badge"]', { hasText: /^hi$/ })).toBeVisible();
  await expect(messageCard(page).getByPlaceholder('Leave blank to use the title above')).toHaveValue('आपका ऑर्डर रास्ते में है');

  await nextButton(page).click();
  await pickDateTime(page, sendAtTrigger(page), when.day, TZ, '10:30');
  await nextButton(page).click();
  const first = await submitCampaign(page, 'Schedule campaign');
  expect(first.status).toBe(201);
  expect(first.body.templateId).toBe(t3.id);
  expect(first.body).toMatchObject({ timer: { durationSeconds: 172800 }, translations: { hi: { title: 'आपका ऑर्डर रास्ते में है' } } });
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications$`));
  expect((await templateRow(t3.id))?.use_count).toBe(2);

  await page.reload();
  await openPush(page, p.project.id, 'Templates');
  await expect(page.getByRole('columnheader').nth(3)).toHaveText('Uses');
  const templateLine = page.getByRole('row', { name: /T3 order update/ });
  await expect(templateLine.getByRole('cell').nth(3)).toHaveText('2');

  // Detached: no templateId, and the count stays.
  await composer(page, p, 1);
  await toMessage(page);
  await tile(page, 'T3 order update').click();
  await messageCard(page).getByRole('button', { name: 'Detach', exact: true }).click();
  await expect(copyNote).toHaveCount(0);
  await expect(tile(page, 'T3 order update')).toHaveAttribute('aria-pressed', 'false');
  await expect(titleInput(page)).toHaveValue('Your order is on its way');
  await nextButton(page).click();
  await pickDateTime(page, sendAtTrigger(page), when.day, TZ, '10:30');
  await nextButton(page).click();
  const second = await submitCampaign(page, 'Schedule campaign');
  expect(second.status).toBe(201);
  expect(second.body).not.toHaveProperty('templateId');
  expect(second.body.title).toBe('Your order is on its way');
  expect((await templateRow(t3.id))?.use_count).toBe(2);

  // Editing the template later leaves the campaign as it was sent.
  const edited = await call('PATCH', `/api/projects/${p.project.id}/push-templates/${t3.id}`, p.owner, { title: 'Edited later' });
  expect(edited.status).toBe(200);
  expect((await campaignRow(first.data.id))?.title).toBe('Your order is on its way');
});

test('PUSH-115 the Templates tab counts the use without a reload', async ({ page }) => {
  test.info().annotations.push({ type: 'issue', description: 'PUSH-115' });
  test.fail();
  const p = await pushProject('push-115-t', { fcm: true });
  await addDevice(p, p.owner.ip);
  const template = await createTemplate(p.owner, p.project.id, { name: 'Counted template', title: 'Counted' });

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  await tile(page, 'Counted template').click();
  await messageToReview(page);
  const sent = await submitCampaign(page, 'Send campaign');
  expect(sent.body.templateId).toBe(template.id);
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications$`));
  expect((await templateRow(template.id))?.use_count).toBe(1);

  await page.getByRole('tab', { name: 'Templates', exact: true }).click();
  await expect(page.getByRole('row', { name: /Counted template/ }).getByRole('cell').nth(3)).toHaveText('1', { timeout: 5_000 });
});

test('PUSH-118 title is required unless silent', async ({ page }) => {
  const p = await pushProject('push-118', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  await expect(actionBar(page)).toHaveText('A title is required.');
  await expect(stepButton(page, 'Message')).toContainText('A title is required.');
  await expect(stepButton(page, 'Message').locator('svg.lucide-circle-alert, svg.lucide-alert-circle')).toHaveCount(1);
  await expect(nextButton(page)).toBeDisabled();

  await titleInput(page).fill('   ');
  await expect(actionBar(page)).toHaveText('A title is required.');
  await expect(nextButton(page)).toBeDisabled();
  await titleInput(page).fill('Now titled');
  await expect(actionBar(page)).toHaveText('What it says');
  await expect(nextButton(page)).toBeEnabled();
  await titleInput(page).fill('');
  await expect(nextButton(page)).toBeDisabled();

  await switchFor(messageCard(page), 'Silent push').click();
  for (const label of ['Title *', 'Body', 'Image URL']) {
    await expect(messageCard(page).getByText(label, { exact: true })).toHaveCount(0);
  }
  await expect(actionBar(page)).toHaveText('What it says');
  await expect(stepButton(page, 'Message')).not.toContainText('A title is required.');
  await expect(nextButton(page)).toBeEnabled();
});

test('PUSH-120 silent push sends a data-only campaign', async ({ page }) => {
  const p = await pushProject('push-120', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  await switchFor(messageCard(page), 'Silent push').click();
  await expect(page.getByText('Nothing is shown. The app is woken with data only.', { exact: true })).toBeVisible();
  await nextButton(page).click();
  await pickDateTime(page, sendAtTrigger(page), nextMonthAt('10:30').day, TZ, '10:30');
  await nextButton(page).click();
  await expect(reviewValue(page, 'Payload')).toHaveText('Silent — nothing is shown; the app is woken with data only.');
  await expect(reviewValue(page, 'Message')).toHaveCount(0);

  const sent = await submitCampaign(page, 'Schedule campaign');
  expect(sent.status).toBe(201);
  expect(sent.body).toMatchObject({ title: '(silent)', silent: true });
  expect(sent.body).not.toHaveProperty('body');
  expect(sent.body).not.toHaveProperty('imageUrl');
  expect(await campaignRow(sent.data.id)).toMatchObject({ title: '(silent)', silent: true, body: null, image_url: null, status: 'scheduled' });

  await page.goto(`/projects/${p.project.id}/push-notifications/${sent.data.id}`);
  const badge = page.getByRole('heading', { level: 1 }).locator('..').getByText('Silent', { exact: true });
  await expect(badge).toBeVisible();
  await badge.hover();
  await expect(page.getByRole('tooltip')).toHaveText(
    'Data-only push — nothing was shown to the user directly; the app handled it in the background.',
  );
});

test('PUSH-124 add translations', async ({ page }) => {
  const p = await pushProject('push-124', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Hello everyone');
  const tag = field(messageCard(page), 'Language tag').getByRole('textbox');
  await tag.fill('PT_br');
  await tag.press('Enter');
  await expect(tag).toHaveValue('');
  await tag.fill('hi');
  await messageCard(page).getByRole('button', { name: 'Add language' }).click();
  const langBadges = messageCard(page).locator('div.space-y-3.rounded-lg.border [data-slot="badge"]');
  await expect(langBadges).toHaveText(['pt-BR', 'hi']);
  await messageCard(page).getByPlaceholder('Leave blank to use the title above').first().fill('Olá a todos');

  await nextButton(page).click();
  await pickDateTime(page, sendAtTrigger(page), nextMonthAt('10:30').day, TZ, '10:30');
  await nextButton(page).click();
  await expect(reviewValue(page, 'Languages')).toHaveText('2 translations');
  const sent = await submitCampaign(page, 'Schedule campaign');
  expect(sent.status).toBe(201);
  expect(sent.body.translations).toEqual({ 'pt-BR': { title: 'Olá a todos' } });
  expect((await campaignRow(sent.data.id))?.translations).toEqual({ 'pt-BR': { title: 'Olá a todos' } });

  await page.goto(`/projects/${p.project.id}/push-notifications/${sent.data.id}`);
  const section = card(page, 'Configuration').getByText('Translations', { exact: true }).locator('..');
  await expect(section.locator('p.font-mono')).toHaveText(['pt-BR']);
  await expect(section.getByText('Olá a todos', { exact: true })).toBeVisible();
});

// ---------------------------------------------------- I. Composer: experiment ---

test('PUSH-132 turn on an experiment', async ({ page }) => {
  const p = await pushProject('push-132', { fcm: true });
  for (let i = 0; i < 10; i++) await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 10);
  await toMessage(page);
  const message = messageCard(page);
  await switchFor(message, 'Silent push').click();
  await expect(switchFor(message, 'Silent push')).toHaveAttribute('aria-checked', 'true');
  await switchFor(message, 'A/B experiment').click();

  await expect(message.getByText('Silent push', { exact: true })).toHaveCount(0);
  await expect(field(message, 'Campaign name *').getByRole('textbox')).toHaveAttribute('placeholder', 'e.g. Weekend sale headline test');
  await expect(message.getByText(/^Silent push isn’t available for experiments/)).toBeVisible();
  for (const label of ['Default body', 'Default image URL', 'Default deep link']) {
    await expect(message.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(field(message, 'Control group').locator('xpath=../..').getByRole('spinbutton')).toHaveValue('0');
  await expect(message.locator('[data-slot="badge"]', { hasText: /^Variant [A-Z]$/ })).toHaveText(['Variant A', 'Variant B']);
  for (const key of ['A', 'B']) {
    await expect(field(variantBox(page, key), 'Key').getByRole('textbox')).toHaveValue(key);
    await expect(field(variantBox(page, key), 'Weight').getByRole('spinbutton')).toHaveValue('50');
    await expect(variantBox(page, key).getByText('~5 people', { exact: true })).toBeVisible();
  }
  await expect(message.getByText('Total weight: 100%', { exact: true })).toBeVisible();
  await expect(message.getByText(/^Translations live on each variant below, not on the campaign/)).toBeVisible();
  await expect(message.getByText('Translations for variant A', { exact: true })).toBeVisible();
  await expect(message.getByPlaceholder('Leave blank to use the title above')).toHaveCount(0);

  // Off again: the silent switch is back, and off.
  await switchFor(message, 'A/B experiment').click();
  await expect(switchFor(message, 'Silent push')).toHaveAttribute('aria-checked', 'false');
});

test('PUSH-133 experiment validation messages', async ({ page }) => {
  const p = await pushProject('push-133', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  const message = messageCard(page);
  await switchFor(message, 'A/B experiment').click();

  const expectProblem = async (text: string) => {
    await expect(actionBar(page)).toHaveText(text);
    await expect(stepButton(page, 'Message')).toContainText(text);
    await expect(errorLine(message, text)).toBeVisible();
    await expect(nextButton(page)).toBeDisabled();
  };
  const key = (k: string) => field(variantBox(page, k), 'Key').getByRole('textbox');

  await expectProblem('Name this experiment.');
  await field(message, 'Campaign name *').getByRole('textbox').fill('Headline test');
  await expectProblem('Every variant needs a title.');

  await key('A').fill('');
  await expectProblem('Every variant needs a key.');
  await key('?').fill('B');
  await expectProblem('Variant keys must be unique.');
  await message.getByText('Key', { exact: true }).first().locator('..').getByRole('textbox').fill('A');
  await expectProblem('Every variant needs a title.');
  await field(variantBox(page, 'B'), 'Title *').getByRole('textbox').fill('Title B');
  await expectProblem('Every variant needs a title.');
  await field(variantBox(page, 'A'), 'Title *').getByRole('textbox').fill('Title A');
  await expect(actionBar(page)).toHaveText('What it says');
  await expect(nextButton(page)).toBeEnabled();

  await field(variantBox(page, 'A'), 'Weight').getByRole('spinbutton').fill('0');
  await expectProblem('Every variant needs a weight above zero.');
  await field(variantBox(page, 'A'), 'Weight').getByRole('spinbutton').fill('40');
  await expectProblem('Variant weights must total 100% — currently 90%.');
  const total = message.getByText('Total weight: 90% — must total 100%', { exact: true });
  await expect(total).toBeVisible();
  await expect(total).toHaveClass(/text-destructive/);

  await field(variantBox(page, 'A'), 'Weight').getByRole('spinbutton').fill('50');
  await expect(message.getByText('Total weight: 100%', { exact: true })).not.toHaveClass(/text-destructive/);
  await expect(nextButton(page)).toBeEnabled();
});

test('PUSH-134 add, remove and even-split variants', async ({ page }) => {
  const p = await pushProject('push-134', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page);
  const message = messageCard(page);
  await switchFor(message, 'A/B experiment').click();
  const badges = message.locator('[data-slot="badge"]', { hasText: /^Variant [A-Z?]+$/ });
  const weights = async () => {
    const out: string[] = [];
    const anyBadge = page.locator('[data-slot="badge"]', { hasText: /^Variant [A-Z?]+$/ });
    for (const box of await message.locator('div.rounded-lg.border.p-4').filter({ has: anyBadge }).all()) {
      out.push(await field(box, 'Weight').getByRole('spinbutton').inputValue());
    }
    return out;
  };
  const bin = (k: string) => variantBox(page, k).getByRole('button').first();
  const add = message.getByRole('button', { name: 'Add variant' });

  // Two variants: neither can be removed.
  await expect(bin('A')).toBeDisabled();
  await expect(bin('B')).toBeDisabled();

  await add.click();
  await expect(badges).toHaveText(['Variant A', 'Variant B', 'Variant C']);
  expect(await weights()).toEqual(['34', '33', '33']);
  await expect(bin('A')).toBeEnabled();
  await add.click();
  expect(await weights()).toEqual(['25', '25', '25', '25']);
  await add.click();
  await expect(badges).toHaveText(['Variant A', 'Variant B', 'Variant C', 'Variant D', 'Variant E']);
  expect(await weights()).toEqual(['20', '20', '20', '20', '20']);
  await expect(add).toBeDisabled();

  await bin('C').click();
  await expect(badges).toHaveText(['Variant A', 'Variant B', 'Variant D', 'Variant E']);
  expect(await weights()).toEqual(['25', '25', '25', '25']);
  await expect(add).toBeEnabled();

  await field(variantBox(page, 'A'), 'Weight').getByRole('spinbutton').fill('70');
  await field(variantBox(page, 'B'), 'Weight').getByRole('spinbutton').fill('5');
  await expect(message.getByText('Total weight: 125% — must total 100%', { exact: true })).toBeVisible();
  await message.getByRole('button', { name: 'Even split', exact: true }).click();
  expect(await weights()).toEqual(['25', '25', '25', '25']);
  await expect(message.getByText('Total weight: 100%', { exact: true })).toBeVisible();
});

test('PUSH-139 experiment API validation', async () => {
  const p = await pushProject('push-139', { fcm: true });
  await addDevice(p, p.owner.ip);
  const arm = (key: string, weight: number, extra: Record<string, unknown> = {}) => ({ key, title: `Arm ${key}`, weight, ...extra });
  const send = (body: Record<string, unknown>) =>
    call('POST', '/api/push-notifications/send', p.owner, { projectId: p.project.id, title: 'PUSH-139', ...body });

  const refusals: Array<[Record<string, unknown>, string]> = [
    [{ variants: [arm('A', 100)] }, 'An experiment needs at least two variants.'],
    [{ variants: ['A', 'B', 'C', 'D', 'E', 'F'].map((k, i) => arm(k, i < 4 ? 17 : 16)) }, 'An experiment supports at most five variants.'],
    [{ variants: [arm('A', 50), arm('A', 50)] }, 'Variant keys must be unique.'],
    [{ variants: [arm('A', 50), arm('B', 50, { title: '   ' })] }, 'Every variant needs a title.'],
    [{ variants: [arm('A', 0), arm('B', 100)] }, 'Every variant needs a weight above zero.'],
    [{ variants: [arm('A', 60), arm('B', 50)] }, 'Variant weights must total 100, got 110.'],
    [{ variants: [arm('A', 50), arm('B', 50)], controlPercentage: 51 }, 'controlPercentage must not be greater than 50'],
    [{ variants: [arm('A', 101), arm('B', 50)] }, 'variants.0.weight must not be greater than 100'],
    [{ variants: [arm('A', 50, { colour: 'red' }), arm('B', 50)] }, 'variants.0.property colour should not exist'],
  ];
  for (const [body, message] of refusals) {
    const refused = await send(body);
    expect([refused.status, messageOf(refused)], message).toEqual([400, message]);
  }
  expect(await campaignRows(p.project.id)).toHaveLength(0);

  const thirds = await send({ variants: [arm('A', 33.33), arm('B', 33.33), arm('C', 33.34)] });
  expect(thirds.status).toBe(201);
  expect(dataOf(thirds)).toMatchObject({ status: 'scheduled', controlPercentage: 0 });
  expect((await campaignRows(p.project.id)).map((row) => row.id)).toEqual([dataOf(thirds).id]);
});

// ------------------------------------- J. Composer: buttons, carousel, countdown ---

test('PUSH-141 action buttons section', async ({ page }) => {
  const p = await pushProject('push-141', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Order update');
  const actions = actionsCard(page);
  const toggle = sectionToggle(actions);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('Show');
  await toggle.click();
  await expect(toggle).toContainText('Hide');
  await expect(actions.getByText(/Android\s+builds these buttons from the message itself/)).toBeVisible();
  await expect(actions.getByText(/iOS\s+can only show buttons the app registered at launch/)).toBeVisible();

  await actions.getByRole('button', { name: 'Add button' }).click();
  await actions.getByRole('button', { name: 'Add button' }).click();
  await expect(actions.locator('[data-slot="badge"]')).toHaveText(['Button 1', 'Button 2']);
  for (const i of [0, 1]) {
    for (const label of ['Id *', 'Title *', 'Deep link']) await expect(field(actions, label, i).getByRole('textbox')).toBeVisible();
  }
  await field(actions, 'Id *', 0).getByRole('textbox').fill('  track_order ');
  await field(actions, 'Title *', 0).getByRole('textbox').fill(' Track package  ');
  await field(actions, 'Id *', 1).getByRole('textbox').fill('open');
  await field(actions, 'Title *', 1).getByRole('textbox').fill('Open');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('2 buttons');

  await messageToReview(page);
  await expect(reviewValue(page, 'Extras').locator('[data-slot="badge"]')).toHaveText(['2 action buttons']);
  const body = await captureRefusedSend(page, 'Send campaign');
  expect(body.actions).toEqual([
    { id: 'track_order', title: 'Track package' },
    { id: 'open', title: 'Open' },
  ]);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-142 action button validation', async ({ page }) => {
  const p = await pushProject('push-142', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Buttons');
  const actions = actionsCard(page);
  await sectionToggle(actions).click();
  await actions.getByRole('button', { name: 'Add button' }).click();
  const expectProblem = async (text: string) => {
    await expect(actionBar(page)).toHaveText(text);
    await expect(errorLine(actions, text)).toBeVisible();
    await expect(nextButton(page)).toBeDisabled();
  };

  await expectProblem('Every action button needs an id.');
  await field(actions, 'Id *').getByRole('textbox').fill('open');
  await expectProblem('Every action button needs a title.');
  await field(actions, 'Title *').getByRole('textbox').fill('Open');
  await expect(nextButton(page)).toBeEnabled();
  await actions.getByRole('button', { name: 'Add button' }).click();
  await field(actions, 'Id *', 1).getByRole('textbox').fill('open');
  await field(actions, 'Title *', 1).getByRole('textbox').fill('Open again');
  await expectProblem('Action button ids must be unique.');
  await field(actions, 'Id *', 1).getByRole('textbox').fill('Open');
  await expect(actions.locator('p.text-destructive')).toHaveCount(0);
  await expect(actionBar(page)).toHaveText('What it says');
  await expect(nextButton(page)).toBeEnabled();

  for (const label of ['Id *', 'Title *']) await expect(field(actions, label).getByRole('textbox')).toHaveAttribute('maxlength', '64');
  await field(actions, 'Id *').getByRole('textbox').fill('x'.repeat(70));
  await expect(field(actions, 'Id *').getByRole('textbox')).toHaveValue('x'.repeat(64));

  const tooLong = await call('POST', '/api/push-notifications/send', p.owner, {
    projectId: p.project.id,
    title: 'PUSH-142',
    actions: [{ id: 'y'.repeat(65), title: 'Long' }],
  });
  expect([tooLong.status, messageOf(tooLong)]).toEqual([400, 'actions.0.id must be shorter than or equal to 64 characters']);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

test('PUSH-144 add a carousel', async ({ page }) => {
  const p = await pushProject('push-144', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Swipe');
  const rich = richCard(page);
  const toggle = sectionToggle(rich);
  await toggle.click();
  await rich.getByRole('button', { name: 'Add a carousel' }).click();

  const slides = rich.locator('[data-slot="badge"]', { hasText: /^Slide \d+$/ });
  await expect(slides).toHaveText(['Slide 1', 'Slide 2']);
  for (const i of [0, 1]) {
    for (const label of ['Image URL *', 'Caption', 'Deep link']) await expect(field(rich, label, i).getByRole('textbox')).toBeVisible();
  }
  await expect(rich.getByRole('button', { name: 'Add a carousel' })).toHaveCount(0);
  await expect(rich.getByRole('button', { name: 'Add slide' })).toBeVisible();
  const missing = 'Every carousel slide needs an image.';
  await expect(errorLine(rich, missing)).toBeVisible();
  await expect(actionBar(page)).toHaveText(missing);
  await expect(nextButton(page)).toBeDisabled();

  await field(rich, 'Image URL *', 0).getByRole('textbox').fill('https://example.com/one.png');
  await expect(errorLine(rich, missing)).toBeVisible();
  await field(rich, 'Image URL *', 1).getByRole('textbox').fill('https://example.com/two.png');
  await expect(errorLine(rich, missing)).toHaveCount(0);
  await expect(nextButton(page)).toBeEnabled();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('2 slides');
});

test('PUSH-148 fixed countdown checks', async ({ page }) => {
  const p = await pushProject('push-148', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Sale ends');
  const rich = richCard(page);
  await sectionToggle(rich).click();
  await choose(page, field(rich, 'Countdown type').getByRole('combobox'), 'Fixed end time — a deadline everyone shares');
  await expect(rich.getByText('Title once it has ended', { exact: true })).toHaveCount(0);
  const endsAt = field(rich, 'Ends at').getByRole('button');

  // Today at 00:00 has already passed.
  await pickDateTime(page, endsAt, new Date(), TZ);
  const expired = 'The countdown has already ended, so it would arrive expired.';
  await expect(errorLine(rich, expired)).toBeVisible();
  await expect(stepButton(page, 'Message')).toContainText(expired);
  await expect(nextButton(page)).toBeDisabled();
  await expect(rich.getByText('Title once it has ended', { exact: true })).toBeVisible();
  await expect(rich.getByText('Body once it has ended', { exact: true })).toBeVisible();

  // Tomorrow passes, checked against now.
  await pickDateTime(page, endsAt, new Date(Date.now() + DAY), TZ, '12:00');
  await expect(errorLine(rich, expired)).toHaveCount(0);
  await expect(rich.getByText('This campaign goes out as soon as you submit, so the countdown is checked against now.', { exact: true })).toBeVisible();
  await expect(nextButton(page)).toBeEnabled();

  // A send in two days is after the end: the Message step behind shows it.
  await nextButton(page).click();
  const sendDay = new Date(Date.now() + 2 * DAY);
  await pickDateTime(page, sendAtTrigger(page), sendDay, TZ, '10:00');
  const { y, m, d } = zonedParts(sendDay, TZ);
  const sendsAt = zonedInstant(y, m, d, '10:00', TZ).toLocaleString('en-US', { timeZone: TZ });
  const late = `The countdown ends before this campaign sends on ${sendsAt}, so it would arrive already expired.`;
  await expect(stepButton(page, 'Message')).toContainText(late);
  await expect(stepButton(page, 'Message').locator('svg.lucide-circle-alert, svg.lucide-alert-circle')).toHaveCount(1);
  await nextButton(page).click();
  await expect(actionBar(page)).toHaveText(late);
  await expect(page.getByRole('button', { name: 'Schedule campaign', exact: true })).toBeDisabled();
  await stepButton(page, 'Message').click();
  await expect(errorLine(richCard(page), late)).toBeVisible();
});

test('PUSH-149 duration countdown checks', async ({ page }) => {
  const p = await pushProject('push-149', { fcm: true });
  await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 1);
  await toMessage(page, 'Hurry');
  const rich = richCard(page);
  await sectionToggle(rich).click();
  await choose(page, field(rich, 'Countdown type').getByRole('combobox'), 'Duration — ends a set time after each send');
  const amount = field(rich, 'Ends after each send').getByRole('spinbutton');
  const unit = field(rich, 'Ends after each send').getByRole('combobox');
  await expect(unit).toHaveText('Hours');

  await amount.fill('0.01');
  const tooShort = 'A countdown must last at least 1 minute — any shorter and it is over before anyone reads it.';
  await expect(errorLine(rich, tooShort)).toBeVisible();
  await expect(actionBar(page)).toHaveText(tooShort);
  await expect(nextButton(page)).toBeDisabled();

  await amount.fill('24');
  await expect(errorLine(rich, tooShort)).toHaveCount(0);
  await expect(rich.getByText('Counted from the moment each send goes out, so it is never checked against the schedule.', { exact: true })).toBeVisible();
  await messageToReview(page);
  await expect(reviewValue(page, 'Extras').locator('[data-slot="badge"]')).toHaveText(['Relative countdown']);
  const day = await captureRefusedSend(page, 'Send campaign');
  expect(day.timer).toEqual({ durationSeconds: 86400 });

  await stepButton(page, 'Message').click();
  await amount.fill('2');
  await choose(page, unit, 'Days');
  await stepButton(page, 'Review').click();
  const twoDays = await captureRefusedSend(page, 'Send campaign');
  expect(twoDays.timer).toEqual({ durationSeconds: 172800 });
  expect(await campaignRows(p.project.id)).toHaveLength(0);
});

// ---------------------------------------------- K. Composer: delivery step ---

test('PUSH-154 send at in the future, in the past, or empty', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await pushProject('push-154', { fcm: true });
  await addDevice(p, p.owner.ip);
  await signIn(page, p.owner);

  // (a) Empty: sent now.
  await composer(page, p, 1);
  await toMessage(page, 'Right away');
  await nextButton(page).click();
  await expect(sendAtTrigger(page)).toHaveText('Immediately');
  await expect(page.getByText('Leave empty to send as soon as you submit.', { exact: true })).toBeVisible();
  await nextButton(page).click();
  await expect(reviewValue(page, 'When')).toHaveText('As soon as you send');
  const now = await submitCampaign(page, 'Send campaign');
  expect(now.status).toBe(201);
  expect(now.body).not.toHaveProperty('scheduledAt');
  expect(now.data.status).toBe('queued');
  await expect(toastTitled(page, 'Campaign queued')).toContainText('Sending to 1 device(s).');

  // (b) Next month at 10:30: held.
  const later = nextMonthAt('10:30');
  const shown = later.at.toLocaleString('en-US', { timeZone: TZ });
  await composer(page, p, 1);
  await toMessage(page, 'Next month');
  await nextButton(page).click();
  await pickDateTime(page, sendAtTrigger(page), later.day, TZ, '10:30');
  await expect(page.getByText(`Held until ${shown}. You can cancel it any time before then.`, { exact: true })).toBeVisible();
  await nextButton(page).click();
  const held = await submitCampaign(page, 'Schedule campaign');
  expect(held.status).toBe(201);
  expect(held.body.scheduledAt).toBe(later.at.toISOString());
  expect(held.data.status).toBe('scheduled');
  await expect(toastTitled(page, 'Campaign scheduled')).toContainText(`Will send to 1 device(s) at ${shown}.`);

  // (c) Today at 00:00, already past: treated as now.
  await composer(page, p, 1);
  await toMessage(page, 'Already past');
  await nextButton(page).click();
  await pickDateTime(page, sendAtTrigger(page), new Date(), TZ, '00:00');
  await expect(sendAtTrigger(page)).toHaveText(/ 00:00$/);
  await expect(page.getByText('Leave empty to send as soon as you submit.', { exact: true })).toBeVisible();
  await nextButton(page).click();
  await expect(page.getByRole('button', { name: 'Schedule campaign', exact: true })).toHaveCount(0);
  const past = await submitCampaign(page, 'Send campaign');
  expect(past.status).toBe(201);
  expect(past.body).not.toHaveProperty('scheduledAt');
  expect(past.data.status).toBe('queued');

  expect((await campaignRow(held.data.id))?.status).toBe('scheduled');
  const targets = async (action: string) => (await activityRows(p.project.id, action)).map((row) => row.target_id).sort();
  expect(await targets('campaign.sent')).toEqual([now.data.id, past.data.id].sort());
  expect(await targets('campaign.scheduled')).toEqual([held.data.id]);
});

test('PUSH-155 deliver in each recipient’s local time', async ({ page }) => {
  test.setTimeout(240_000);
  const p = await pushProject('push-155', { fcm: true });
  const kolkata = await addDevice(p, p.owner.ip, { timezone: 'Asia/Kolkata' });
  const london = await addDevice(p, p.owner.ip, { timezone: 'Europe/London' });
  const unset = await addDevice(p, p.owner.ip);

  await signIn(page, p.owner);
  await composer(page, p, 3);
  await toMessage(page, 'Good morning');
  await nextButton(page).click();
  await expect(sendAtTrigger(page)).toBeVisible();
  await switchFor(page, "Deliver in each recipient's local time").click();
  await expect(page.getByText('Send at', { exact: true })).toHaveCount(0);
  await field(page, 'Local time').locator('input[type="time"]').fill('08:30');
  await expect(page.getByText(/^Each recipient receives it at 08:30 on their own clock, at the next occurrence\./)).toBeVisible();
  await nextButton(page).click();
  await expect(reviewValue(page, 'When')).toContainText('At 08:30 on each recipient’s own clock');

  const sent = await submitCampaign(page, 'Schedule by timezone');
  expect(sent.status).toBe(201);
  expect(sent.body).toMatchObject({ deliverInRecipientTimezone: true, localSendTime: '08:30' });
  expect(sent.body).not.toHaveProperty('scheduledAt');
  expect(sent.data.status).toBe('scheduled');
  const parentId = sent.data.id as string;

  await expect.poll(async () => (await campaignRow(parentId))?.status, { timeout: 150_000, intervals: [2_000] }).toBe('expanded');
  const zones: Record<string, string> = { [kolkata.id]: 'Asia/Kolkata', [london.id]: 'Europe/London', [unset.id]: 'UTC' };
  const children = (await campaignRows(p.project.id)).filter((row) => row.parent_campaign_id === parentId);
  expect(children).toHaveLength(3);
  const seen = new Set<string>();
  for (const child of children) {
    const ids = await campaignRecipients(child.id);
    expect(ids).toHaveLength(1);
    const zone = zones[ids[0]];
    seen.add(zone);
    expect(child.status).toBe('scheduled');
    expect(localClock(child.scheduled_at, zone), zone).toBe('08:30');
    expect(new Date(child.scheduled_at).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(child.scheduled_at).getTime()).toBeLessThanOrEqual(Date.now() + DAY + 60_000);
  }
  expect([...seen].sort()).toEqual(['Asia/Kolkata', 'Europe/London', 'UTC']);

  await page.goto(`/projects/${p.project.id}/push-notifications/${parentId}`);
  await expect(page.locator('[data-slot="badge"]', { hasText: /^By timezone$/ })).toBeVisible();
  const timing = card(page, 'Configuration').getByText('Send timing', { exact: true }).locator('..');
  await expect(timing).toContainText("Delivered at 08:30 on each recipient's own clock, not one fixed instant.");
});

test.describe('in Europe/London', () => {
  const LONDON = 'Europe/London';
  test.use({ timezoneId: LONDON });

  test('PUSH-158 repeat: defaults, summary and send', async ({ page }) => {
    const p = await pushProject('push-158', { fcm: true });
    await addDevice(p, p.owner.ip);
    await addDevice(p, p.owner.ip);

    await signIn(page, p.owner);
    await composer(page, p, 2);
    await toMessage(page, 'Twice a week');
    await nextButton(page).click();
    await switchFor(page, 'Repeat').click();

    await expect(field(page, 'Frequency').getByRole('combobox')).toHaveText('Weekly');
    await field(page, 'Frequency').getByRole('combobox').click();
    await expect(page.getByRole('option')).toHaveText(['Daily', 'Weekly', 'Monthly']);
    await page.keyboard.press('Escape');
    await expect(field(page, 'Repeat every').getByRole('spinbutton')).toHaveValue('1');
    await expect(field(page, 'Repeat every').getByText('week', { exact: true })).toBeVisible();
    await expect(field(page, 'At').locator('input[type="time"]')).toHaveValue('09:00');
    await expect(page.getByText('On these days', { exact: true })).toBeVisible();
    const timezone = field(page, 'Timezone').getByRole('combobox');
    await expect(timezone).toHaveText(LONDON);
    await timezone.click();
    const options = page.getByRole('option');
    await expect(options.nth(0)).toHaveText('UTC');
    await expect(options.nth(1)).toHaveText(LONDON);
    await page.keyboard.press('Escape');
    await expect(field(page, 'Ends').getByRole('button')).toHaveText('Never — runs until cancelled');
    await expect(page.getByText('First occurrence', { exact: true })).toBeVisible();
    await expect(field(page, 'First occurrence').getByRole('button')).toHaveText('The next slot the rule allows');

    await page.getByRole('button', { name: 'Mon', exact: true }).click();
    await page.getByRole('button', { name: 'Thu', exact: true }).click();
    const rule = `every week on Mon, Thu at 09:00 ${LONDON} until you cancel it`;
    await expect(page.getByText(`Repeats ${rule}.`, { exact: true })).toBeVisible();
    await nextButton(page).click();
    await expect(actionBar(page)).toHaveText(`Repeating ${rule}, reaching about 2 devices each time.`);

    const sent = await submitCampaign(page, 'Schedule repeating campaign');
    expect(sent.status).toBe(201);
    await expect(toastTitled(page, 'Repeating campaign scheduled')).toContainText(`Repeats ${rule}, reaching about 2 device(s) each time.`);
    expect(sent.body.recurrence).toEqual({ frequency: 'weekly', interval: 1, atTime: '09:00', daysOfWeek: [1, 4], timezone: LONDON });
    const row = await campaignRow(sent.data.id);
    expect(row?.status).toBe('scheduled');
    expect(row?.recurrence).toEqual({ frequency: 'weekly', interval: 1, atTime: '09:00', daysOfWeek: [1, 4], timezone: LONDON });

    // The next Monday or Thursday at 09:00 in London, after now.
    let expected: Date | undefined;
    for (let i = 0; i < 8 && !expected; i++) {
      const parts = zonedParts(new Date(Date.now() + i * DAY), LONDON);
      if (parts.weekday !== 1 && parts.weekday !== 4) continue;
      const slot = zonedInstant(parts.y, parts.m, parts.d, '09:00', LONDON);
      if (slot.getTime() > Date.now()) expected = slot;
    }
    expect(new Date(row!.scheduled_at).toISOString()).toBe(expected!.toISOString());

    await page.goto(`/projects/${p.project.id}/push-notifications/${sent.data.id}`);
    const recurrence = card(page, 'Configuration').getByText('Recurrence', { exact: true }).locator('..');
    await expect(recurrence).toContainText(`Every week on Mon, Thu at 09:00 ${LONDON}, until cancelled`);
  });

  test('PUSH-159 repeat validation in the form', async ({ page }) => {
    const p = await pushProject('push-159', { fcm: true });
    await addDevice(p, p.owner.ip);

    await signIn(page, p.owner);
    await composer(page, p, 1);
    await toMessage(page, 'Series');
    await nextButton(page).click();
    await switchFor(page, 'Repeat').click();
    const every = field(page, 'Repeat every').getByRole('spinbutton');
    const badEvery = 'Repeat every must be a whole number of periods between 1 and 52.';
    const expectProblem = async (text: string) => {
      await expect(errorLine(page, text)).toBeVisible();
      await expect(actionBar(page)).toHaveText(text);
      await expect(stepButton(page, 'Delivery')).toContainText(text);
      await expect(nextButton(page)).toBeDisabled();
    };

    for (const value of ['0', '53', '1.5', '']) {
      await every.fill(value);
      await expectProblem(badEvery);
    }
    await every.fill('2');
    await expect(errorLine(page, badEvery)).toHaveCount(0);
    await expect(nextButton(page)).toBeEnabled();

    await pickDateTime(page, field(page, 'Ends').getByRole('button'), new Date(Date.now() - DAY), LONDON);
    await expectProblem('The end date has already passed, so no occurrence would ever fire.');

    await pickDateTime(page, field(page, 'First occurrence').getByRole('button'), new Date(Date.now() + 7 * DAY), LONDON, '09:00');
    await pickDateTime(page, field(page, 'Ends').getByRole('button'), new Date(Date.now() + DAY), LONDON);
    await expectProblem('The end date is on or before the first occurrence, so nothing would be sent.');

    await pickDateTime(page, field(page, 'Ends').getByRole('button'), new Date(Date.now() + 30 * DAY), LONDON);
    await expect(page.locator('p.text-xs.text-destructive')).toHaveCount(0);
    await expect(nextButton(page)).toBeEnabled();
  });
});

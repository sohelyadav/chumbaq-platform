import { expect, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  call,
  campaignRow,
  cardTitled,
  checkMessages,
  chooseOption,
  createInAppMessage,
  createPosted,
  ctaRows,
  dataOf,
  deliveredIds,
  detailBadge,
  detailStat,
  dismissToasts,
  editorChoice,
  editorDate,
  editorField,
  editorNumber,
  editorPanel,
  editorSelect,
  editorTypeBadge,
  identifyDevice,
  impressionRows,
  inAppProject,
  messageActivity,
  messageIn,
  messageRows,
  openInAppList,
  pendingRows,
  recordEvents,
  seedCohort,
  sql,
  stepPill,
  toastTitled,
  updatePatched,
  type InAppProject,
} from '../../support/areas/inapp';
import type { Page } from '@playwright/test';

/**
 * In-app messages (P1): the editor's trigger, audience and schedule steps, editing a
 * saved campaign, the campaign detail page (header, stats, time ranges, button
 * breakdown, loading and not-found), Trigger Now, and the trigger and create routes'
 * validation.
 */

test.describe.configure({ mode: 'parallel' });

const MESSAGES = (projectId: string) => `/api/projects/${projectId}/in-app-messages`;
const TRIGGER = (projectId: string) => `/api/projects/${projectId}/in-app-messages/trigger`;
/** The filled look of a selected range button. */
const FILLED = /(^|\s)bg-primary(\s|$)/;

async function openNewEditor(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/in-app-messages/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'New Campaign', exact: true })).toBeVisible();
}

async function openEditEditor(page: Page, projectId: string, id: string): Promise<void> {
  await page.goto(`/projects/${projectId}/in-app-messages/${id}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Campaign', exact: true })).toBeVisible();
}

async function nameAndTitle(page: Page, name: string, title: string): Promise<void> {
  await editorField(page, 'Campaign Name').fill(name);
  await editorField(page, 'Title *').fill(title);
}

async function saveCampaign(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save Campaign', exact: true }).first().click();
}

/** Saves and answers the id the editor navigated to. */
async function saveAndGetId(page: Page, projectId: string): Promise<string> {
  const posted = createPosted(page, projectId);
  await saveCampaign(page);
  const response = await posted;
  expect(response.status(), await response.text()).toBe(201);
  await page.waitForURL(new RegExp(`/projects/${projectId}/in-app-messages/[0-9a-f-]{36}$`));
  return page.url().split('/').pop()!;
}

/** Saves, expects the API's 400 naming `message`, and the editor's failure toast. */
async function saveRefused(page: Page, projectId: string, message: string): Promise<void> {
  await dismissToasts(page);
  const posted = createPosted(page, projectId);
  await saveCampaign(page);
  const response = await posted;
  expect(response.status(), message).toBe(400);
  expect((await response.json()).message, message).toContain(message);
  await expect(toastTitled(page, 'Failed to save'), message).toBeVisible();
  await expect(page).toHaveURL(/\/in-app-messages\/new$/);
}

async function getMessage(p: InAppProject, id: string): Promise<Record<string, any>> {
  return dataOf(await call('GET', `${MESSAGES(p.project.id)}/${id}`, p.owner));
}

async function openDetail(page: Page, projectId: string, id: string, name: string): Promise<void> {
  await page.goto(`/projects/${projectId}/in-app-messages/${id}`);
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

// ------------------------------------------------------------ D. Editor steps 2 to 4 ---

test('INAPP-069 On Event saves the event name', async ({ page }) => {
  const p = await inAppProject('inapp-069');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Bought something', 'Thanks!');
  await stepPill(page, 2, 'Trigger').click();
  await editorChoice(page, 'On Event').click();
  const eventName = editorField(page, 'Event Name');
  await expect(eventName).toHaveAttribute('placeholder', 'e.g. purchase_completed');
  await eventName.fill('purchase_completed');

  const id = await saveAndGetId(page, p.project.id);
  expect(await getMessage(p, id)).toMatchObject({ triggerType: 'on_event', triggerEvent: 'purchase_completed' });

  await openInAppList(page, p.project.id);
  await expect(campaignRow(page, 'Bought something').getByRole('cell').nth(2)).toHaveText('On Event');
});

test('INAPP-070 On Screen saves the screen name', async ({ page }) => {
  const p = await inAppProject('inapp-070');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Home screen', 'Hi on home');
  await stepPill(page, 2, 'Trigger').click();
  await editorChoice(page, 'On Screen').click();
  const screenName = editorField(page, 'Screen Name');
  await expect(screenName).toHaveAttribute('placeholder', 'e.g. home, product_detail');
  await screenName.fill('home');

  const id = await saveAndGetId(page, p.project.id);
  expect(await getMessage(p, id)).toMatchObject({ triggerType: 'on_screen', triggerScreen: 'home' });

  await openInAppList(page, p.project.id);
  await expect(campaignRow(page, 'Home screen').getByRole('cell').nth(2)).toHaveText('On Screen');
});

test('INAPP-073 Server Push and Scheduled triggers', async ({ page }) => {
  const p = await inAppProject('inapp-073');
  await signIn(page, p.owner);
  const ids: Record<string, string> = {};
  for (const [label, name] of [
    ['Server Push', 'Pushed one'],
    ['Scheduled', 'Timed one'],
  ]) {
    await openNewEditor(page, p.project.id);
    await nameAndTitle(page, name, 'Trigger kinds');
    await stepPill(page, 2, 'Trigger').click();
    await editorChoice(page, label).click();
    await expect(editorChoice(page, label), label).toHaveClass(/border-primary/);
    ids[label] = await saveAndGetId(page, p.project.id);
  }
  expect((await getMessage(p, ids['Server Push'])).triggerType).toBe('immediate');
  expect((await getMessage(p, ids['Scheduled'])).triggerType).toBe('scheduled');

  await openInAppList(page, p.project.id);
  await expect(campaignRow(page, 'Pushed one').getByRole('cell').nth(2)).toHaveText('Immediate (Push)');
  await expect(campaignRow(page, 'Timed one').getByRole('cell').nth(2)).toHaveText('Scheduled');
});

test('INAPP-074 delay and priority numbers', async ({ page }) => {
  const p = await inAppProject('inapp-074');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Numbers', 'Counting');
  await stepPill(page, 2, 'Trigger').click();
  const delay = editorNumber(page, 'Delay before showing (seconds)');
  const priority = editorNumber(page, 'Priority');
  await expect(page.getByText('Higher = shown first when multiple messages match', { exact: true })).toBeVisible();

  await delay.fill('-1');
  await saveRefused(page, p.project.id, 'triggerDelaySeconds must not be less than 0');

  await delay.fill('3');
  await priority.fill('-5');
  await saveRefused(page, p.project.id, 'priority must not be less than 0');
  expect(await messageRows(p.project.id)).toEqual([]);

  // Cleared fields become 0, which is what they show.
  await delay.fill('');
  await priority.fill('');
  await expect(delay).toHaveValue('0');
  await expect(priority).toHaveValue('0');

  await delay.fill('3');
  await priority.fill('10');
  const id = await saveAndGetId(page, p.project.id);
  expect(await getMessage(p, id)).toMatchObject({ triggerDelaySeconds: 3, priority: 10 });
});

test('INAPP-076 Mixpanel cohort needs a UUID', async ({ page }) => {
  const p = await inAppProject('inapp-076');
  const device = await identifyDevice(p, {}, 'fp-d1');
  const cohortId = await seedCohort(p.project.id, 'C1 buyers', [{ deviceIdentityId: device.id, resolved: true }]);

  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Cohort only', 'For the cohort');
  await stepPill(page, 3, 'Users').click();
  await editorChoice(page, 'Mixpanel Cohort').click();
  const cohortField = editorField(page, 'Mixpanel Cohort ID');
  await expect(cohortField).toHaveAttribute('placeholder', 'Paste cohort ID');

  await cohortField.fill('abc');
  await saveRefused(page, p.project.id, 'mixpanelCohortId must be a UUID');
  expect(await messageRows(p.project.id)).toEqual([]);

  await cohortField.fill(cohortId);
  const id = await saveAndGetId(page, p.project.id);
  expect(await getMessage(p, id)).toMatchObject({ userType: 'cohort', mixpanelCohortId: cohortId });
});

test('INAPP-077 Custom Segment has no segment picker', async ({ page }) => {
  const p = await inAppProject('inapp-077');
  const device = await identifyDevice(p, {}, 'fp-d4');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Segment only', 'For a segment');
  await stepPill(page, 3, 'Users').click();
  const panel = editorPanel(page);
  // Positive control: the cohort choice does bring up a field.
  await editorChoice(page, 'Mixpanel Cohort').click();
  await expect(panel.getByRole('textbox')).toHaveCount(1);

  await editorChoice(page, 'Custom Segment').click();
  await expect(editorChoice(page, 'Custom Segment')).toHaveClass(/border-primary/);
  // Expected (current code): nothing to choose a segment with.
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await expect(panel.getByRole('listbox')).toHaveCount(0);

  const id = await saveAndGetId(page, p.project.id);
  const stored = await getMessage(p, id);
  expect(stored).toMatchObject({ userType: 'segment', segmentId: null });

  // Withheld from everyone once active; an all-users message in the same check is delivered.
  dataOf(await call('POST', `${MESSAGES(p.project.id)}/${id}/activate`, p.owner));
  const everyone = await messageIn(p.owner, p.project.id, 'active', { name: 'For all' });
  expect(await deliveredIds(p, device.fingerprint)).toEqual([everyone.id]);
});

test.describe('schedule window in Asia/Kolkata', () => {
  test.use({ timezoneId: 'Asia/Kolkata' });

  test('INAPP-078 schedule window saves ISO timestamps', async ({ page }) => {
    const p = await inAppProject('inapp-078');
    await signIn(page, p.owner);
    await openNewEditor(page, p.project.id);
    await nameAndTitle(page, 'December window', 'In December');
    await stepPill(page, 4, 'Schedule & Limits').click();
    await editorDate(page, 'Start Date').fill('2026-12-01T10:00');
    await editorDate(page, 'End Date').fill('2026-12-31T18:00');

    const posted = createPosted(page, p.project.id);
    await saveCampaign(page);
    const response = await posted;
    expect(response.request().postDataJSON()).toMatchObject({
      startsAt: '2026-12-01T04:30:00.000Z',
      endsAt: '2026-12-31T12:30:00.000Z',
    });
    expect(response.status()).toBe(201);
    const id = (await response.json()).data.id as string;
    expect(await getMessage(p, id)).toMatchObject({ startsAt: '2026-12-01T04:30:00.000Z', endsAt: '2026-12-31T12:30:00.000Z' });
  });

  test('INAPP-079 reopening the editor shifts schedule times by the timezone offset', async ({ page }) => {
    const p = await inAppProject('inapp-079');
    const message = await createInAppMessage(p.owner, p.project.id, {
      name: 'Shifted window',
      startsAt: '2026-12-01T04:30:00.000Z',
      endsAt: '2026-12-31T12:30:00.000Z',
    });
    await signIn(page, p.owner);
    await openEditEditor(page, p.project.id, message.id);
    await expect(editorField(page, 'Campaign Name')).toHaveValue('Shifted window');
    await stepPill(page, 4, 'Schedule & Limits').click();

    // Expected (current code): the UTC value cut to 16 characters, not the 10:00 entered.
    const start = editorDate(page, 'Start Date');
    await expect(start).toHaveValue('2026-12-01T04:30');
    await expect(editorDate(page, 'End Date')).toHaveValue('2026-12-31T12:30');

    // Untouched, the stored value goes back as it was.
    let patched = updatePatched(page, p.project.id, message.id);
    // The editor reloads the message after an update and refills the form from it.
    const reloaded = page.waitForResponse(
      (r) => r.url().endsWith(`${MESSAGES(p.project.id)}/${message.id}`) && r.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    expect((await patched).request().postDataJSON().startsAt).toBe('2026-12-01T04:30:00.000Z');
    await reloaded;
    await expect(start).toHaveValue('2026-12-01T04:30');
    expect((await getMessage(p, message.id)).startsAt).toBe('2026-12-01T04:30:00.000Z');

    // Touched, the shown value is read as local time and saved shifted.
    await start.fill('2026-12-01T04:31');
    await start.fill('2026-12-01T04:30');
    patched = updatePatched(page, p.project.id, message.id);
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    expect((await patched).status()).toBe(200);
    expect((await getMessage(p, message.id)).startsAt).toBe('2026-11-30T23:00:00.000Z');
  });
});

test('INAPP-081 clearing a saved schedule date does not clear it', async ({ page }) => {
  const p = await inAppProject('inapp-081');
  const message = await createInAppMessage(p.owner, p.project.id, {
    name: 'Dated',
    startsAt: '2026-12-01T00:00:00.000Z',
    endsAt: '2026-12-31T00:00:00.000Z',
  });
  await signIn(page, p.owner);
  await openEditEditor(page, p.project.id, message.id);
  await expect(editorField(page, 'Campaign Name')).toHaveValue('Dated');
  await stepPill(page, 4, 'Schedule & Limits').click();
  await expect(editorDate(page, 'Start Date')).toHaveValue('2026-12-01T00:00');
  await editorDate(page, 'Start Date').fill('');
  await editorDate(page, 'End Date').fill('');
  await expect(editorDate(page, 'Start Date')).toHaveValue('');
  await expect(editorDate(page, 'End Date')).toHaveValue('');

  const patched = updatePatched(page, p.project.id, message.id);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  const response = await patched;
  expect(response.status()).toBe(200);
  const sent = response.request().postDataJSON();
  expect(sent).not.toHaveProperty('startsAt');
  expect(sent).not.toHaveProperty('endsAt');
  await expect(toastTitled(page, 'Campaign updated')).toBeVisible();

  // Expected (current code): the server keeps the old dates.
  expect(await getMessage(p, message.id)).toMatchObject({ startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-12-31T00:00:00.000Z' });
});

test('INAPP-082 frequency caps', async ({ page }) => {
  const p = await inAppProject('inapp-082');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Capped', 'Not too often');
  await stepPill(page, 4, 'Schedule & Limits').click();
  const maxShows = editorNumber(page, 'Max shows per user');
  const minInterval = editorNumber(page, 'Min interval (seconds)');
  await expect(maxShows).toHaveAttribute('placeholder', 'Unlimited');
  await expect(minInterval).toHaveAttribute('placeholder', 'No limit');

  await maxShows.fill('0');
  await saveRefused(page, p.project.id, 'maxImpressionsPerUser must not be less than 1');
  await maxShows.fill('3');
  await minInterval.fill('-1');
  await saveRefused(page, p.project.id, 'minIntervalSeconds must not be less than 0');
  expect(await messageRows(p.project.id)).toEqual([]);

  await minInterval.fill('600');
  const id = await saveAndGetId(page, p.project.id);
  expect(await getMessage(p, id)).toMatchObject({ maxImpressionsPerUser: 3, minIntervalSeconds: 600 });

  // Left empty, both are saved as null.
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Uncapped', 'As often as you like');
  const posted = createPosted(page, p.project.id);
  await saveCampaign(page);
  const response = await posted;
  expect(response.request().postDataJSON()).toMatchObject({ maxImpressionsPerUser: null, minIntervalSeconds: null });
  expect(response.status()).toBe(201);
  const emptyId = (await response.json()).data.id as string;
  expect(await getMessage(p, emptyId)).toMatchObject({ maxImpressionsPerUser: null, minIntervalSeconds: null });
});

// ------------------------------------------------------------ E. Editing ---

test('INAPP-086 edit page loads the saved values', async ({ page }) => {
  const p = await inAppProject('inapp-086');
  const cohortId = await seedCohort(p.project.id, 'C1 loaded', []);
  const message = await createInAppMessage(p.owner, p.project.id, {
    name: 'Everything set',
    messageType: 'bottom_sheet',
    title: 'All the fields',
    body: 'A body worth reading',
    imageUrl: 'https://example.com/sheet.png',
    imagePosition: 'center',
    buttons: [
      { id: 'yes', text: 'Yes please', action: 'url', actionUrl: 'https://example.com/yes', style: 'primary' },
      { id: 'no', text: 'Not now', action: 'dismiss', style: 'text' },
    ],
    theme: {
      backgroundColor: '#0f172a',
      textColor: '#e2e8f0',
      titleColor: '#f8fafc',
      buttonPrimaryColor: '#22c55e',
      buttonSecondaryColor: '#334155',
      overlayColor: 'rgba(0,0,0,0.7)',
      borderRadius: 24,
      animation: 'slide_up',
    },
    dismissOnTapOutside: false,
    autoDismissSeconds: 5,
    triggerType: 'on_event',
    triggerEvent: 'checkout',
    triggerDelaySeconds: 2,
    priority: 7,
    userType: 'cohort',
    mixpanelCohortId: cohortId,
    startsAt: '2026-12-01T09:15:00.000Z',
    endsAt: '2026-12-20T17:45:00.000Z',
    maxImpressionsPerUser: 4,
    minIntervalSeconds: 900,
    tags: ['onboarding', 'promo'],
  });

  await signIn(page, p.owner);
  await openEditEditor(page, p.project.id, message.id);
  await expect(editorTypeBadge(page)).toHaveText('Bottom Sheet');
  await expect(page.getByRole('heading', { level: 1 }).locator('xpath=../following-sibling::p[1]')).toHaveText('Everything set');
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeVisible();

  // Step 1
  await expect(editorField(page, 'Campaign Name')).toHaveValue('Everything set');
  await expect(editorField(page, 'Title *')).toHaveValue('All the fields');
  await expect(editorField(page, 'Body')).toHaveValue('A body worth reading');
  await expect(editorField(page, 'Image URL')).toHaveValue('https://example.com/sheet.png');
  await expect(editorSelect(page, 'Position')).toHaveText('Center');
  const rows = ctaRows(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByPlaceholder('Label')).toHaveValue('Yes please');
  await expect(rows.nth(0).getByRole('combobox')).toHaveText(['Open URL', 'Primary']);
  await expect(rows.nth(1).getByPlaceholder('Label')).toHaveValue('Not now');
  await expect(rows.nth(1).getByRole('combobox')).toHaveText(['Dismiss', 'Text']);
  await expect(editorField(page, 'Background')).toHaveValue('#0f172a');
  await expect(editorField(page, 'Title')).toHaveValue('#f8fafc');
  await expect(editorField(page, 'Body Text')).toHaveValue('#e2e8f0');
  await expect(editorField(page, 'Button Color')).toHaveValue('#22c55e');
  await expect(editorNumber(page, 'Corner Radius')).toHaveValue('24');
  await expect(editorSelect(page, 'Animation')).toHaveText('Slide Up');
  await expect(page.getByText('Dismiss on Tap Outside', { exact: true }).locator('../..').getByRole('switch')).not.toBeChecked();
  await expect(editorNumber(page, 'Auto-dismiss (seconds)')).toHaveValue('5');

  // Step 2
  await stepPill(page, 2, 'Trigger').click();
  await expect(editorChoice(page, 'On Event')).toHaveClass(/border-primary/);
  await expect(editorChoice(page, 'App Open')).not.toHaveClass(/border-primary/);
  await expect(editorField(page, 'Event Name')).toHaveValue('checkout');
  await expect(editorNumber(page, 'Delay before showing (seconds)')).toHaveValue('2');
  await expect(editorNumber(page, 'Priority')).toHaveValue('7');

  // Step 3
  await stepPill(page, 3, 'Users').click();
  await expect(editorChoice(page, 'Mixpanel Cohort')).toHaveClass(/border-primary/);
  await expect(editorChoice(page, 'All Users')).not.toHaveClass(/border-primary/);
  await expect(editorField(page, 'Mixpanel Cohort ID')).toHaveValue(cohortId);

  // Step 4
  await stepPill(page, 4, 'Schedule & Limits').click();
  await expect(editorDate(page, 'Start Date')).toHaveValue('2026-12-01T09:15');
  await expect(editorDate(page, 'End Date')).toHaveValue('2026-12-20T17:45');
  await expect(editorNumber(page, 'Max shows per user')).toHaveValue('4');
  await expect(editorNumber(page, 'Min interval (seconds)')).toHaveValue('900');
  await expect(page.getByPlaceholder('onboarding, promo, seasonal')).toHaveValue('onboarding, promo');
  await expect(editorPanel(page).getByRole('button', { name: 'Save Campaign', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
});

test('INAPP-087 update a campaign', async ({ page }) => {
  const p = await inAppProject('inapp-087');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Draft to edit', title: 'Old title' });
  await signIn(page, p.owner);
  await openEditEditor(page, p.project.id, message.id);
  await expect(editorField(page, 'Title *')).toHaveValue('Old title');
  await editorField(page, 'Title *').fill('New title');

  const patched = updatePatched(page, p.project.id, message.id);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  expect((await patched).status()).toBe(200);
  await expect(toastTitled(page, 'Campaign updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/in-app-messages/${message.id}/edit$`));

  expect(await getMessage(p, message.id)).toMatchObject({ title: 'New title', status: 'draft', name: 'Draft to edit' });
  expect(await messageActivity(p.project.id)).toEqual([]);
});

test('INAPP-088 editing an active campaign changes it live', async ({ page }) => {
  const p = await inAppProject('inapp-088');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Live one', title: 'Before', triggerType: 'on_app_open' });
  const device = await identifyDevice(p, {}, 'fp-d5');
  const before = dataOf(await checkMessages(p, device.fingerprint));
  expect(before.messages.map((m: { id: string; title: string }) => [m.id, m.title])).toEqual([[message.id, 'Before']]);

  await signIn(page, p.owner);
  await openEditEditor(page, p.project.id, message.id);
  await expect(editorField(page, 'Title *')).toHaveValue('Before');
  await editorField(page, 'Title *').fill('Changed');
  const patched = updatePatched(page, p.project.id, message.id);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  expect((await patched).status()).toBe(200);
  await expect(toastTitled(page, 'Campaign updated')).toBeVisible();

  expect((await getMessage(p, message.id)).status).toBe('active');
  const after = dataOf(await checkMessages(p, device.fingerprint));
  expect(after.messages.map((m: { id: string; title: string }) => [m.id, m.title])).toEqual([[message.id, 'Changed']]);
});

// ------------------------------------------------------------ F. Campaign detail ---

test('INAPP-092 detail header and actions for a draft', async ({ page }) => {
  const p = await inAppProject('inapp-092');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Welcome modal', messageType: 'modal' });
  await signIn(page, p.owner);
  await openDetail(page, p.project.id, message.id, 'Welcome modal');

  await expect(detailBadge(page, 'Welcome modal')).toContainText('Draft');
  const localDate = await page.evaluate((iso) => new Date(iso).toLocaleDateString(), message.createdAt as string);
  await expect(page.getByText(`💬 Modal · Created ${localDate}`, { exact: true })).toBeVisible();
  for (const name of ['Trigger Now', 'Activate', 'Edit']) {
    await expect(page.getByRole('button', { name, exact: true }), name).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
});

test('INAPP-096 activating twice writes one log entry', async () => {
  const p = await inAppProject('inapp-096');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Double click' });
  const activate = () => call('POST', `${MESSAGES(p.project.id)}/${message.id}/activate`, p.owner);
  const [first, second] = await Promise.all([activate(), activate()]);
  for (const response of [first, second]) {
    expect(response.status, response.text).toBe(201);
    expect(response.body.data.status).toBe('active');
  }
  const entries = await activityRows(p.project.id, 'in_app_message.activated');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ target_id: message.id });
});

test('INAPP-098 stats grid from analytics', async ({ page }) => {
  const p = await inAppProject('inapp-098');
  const message = await messageIn(p.owner, p.project.id, 'active', {
    name: 'Counted',
    buttons: [{ id: 'start', text: 'Start', action: 'dismiss', style: 'primary' }],
  });
  const [a, b, c, d] = [
    await identifyDevice(p, {}, 'fp-a'),
    await identifyDevice(p, {}, 'fp-b'),
    await identifyDevice(p, {}, 'fp-c'),
    await identifyDevice(p, {}, 'fp-d'),
  ];
  // 5 delivered (one of them to a device that never saw it), 4 impressions on 3 devices.
  await recordEvents(p, message.id, a.fingerprint, 'delivered', 2);
  await recordEvents(p, message.id, b.fingerprint, 'delivered', 1);
  await recordEvents(p, message.id, c.fingerprint, 'delivered', 1);
  await recordEvents(p, message.id, d.fingerprint, 'delivered', 1);
  await recordEvents(p, message.id, a.fingerprint, 'impression', 2);
  await recordEvents(p, message.id, b.fingerprint, 'impression', 1);
  await recordEvents(p, message.id, c.fingerprint, 'impression', 1);
  await recordEvents(p, message.id, a.fingerprint, 'click', 1);
  await recordEvents(p, message.id, b.fingerprint, 'cta_click', 1, 'start');
  await recordEvents(p, message.id, c.fingerprint, 'dismiss', 1);
  await recordEvents(p, message.id, c.fingerprint, 'auto_dismiss', 1);
  expect(await impressionRows(message.id)).toHaveLength(13);

  await signIn(page, p.owner);
  await openDetail(page, p.project.id, message.id, 'Counted');
  const expected: Array<[string, string]> = [
    ['Delivered', '5'],
    ['Impressions', '4'],
    ['Clicks', '2'],
    ['CTR', '50.0%'],
    ['Dismissed', '1'],
    ['Unique Users', '4'],
  ];
  for (const [label, value] of expected) {
    await expect(detailStat(page, label), label).toHaveText(value);
  }
  // The labels are upper-cased by CSS only.
  await expect(page.locator('p', { hasText: /^Unique Users$/ })).toHaveCSS('text-transform', 'uppercase');
});

test('INAPP-099 stats with no events', async ({ page }) => {
  const p = await inAppProject('inapp-099');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Quiet draft' });
  await signIn(page, p.owner);
  await openDetail(page, p.project.id, message.id, 'Quiet draft');

  for (const label of ['Delivered', 'Impressions', 'Clicks', 'Dismissed', 'Unique Users']) {
    await expect(detailStat(page, label), label).toHaveText('0');
  }
  await expect(detailStat(page, 'CTR')).toHaveText('0.0%');
  await expect(cardTitled(page, 'Performance Over Time').getByText('No data available for this period', { exact: true })).toBeVisible();

  const funnel = cardTitled(page, 'Conversion Funnel');
  for (const label of ['Delivered', 'Impressions', 'Clicks', 'Dismissed']) {
    await expect(funnel.locator('.recharts-yAxis .recharts-cartesian-axis-tick-value', { hasText: new RegExp(`^${label}$`) }), label).toHaveCount(1);
  }
  await expect(funnel.getByText('No analytics data yet', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Message Preview', { exact: true })).toBeVisible();
  await expect(page.getByText('Button Click Breakdown', { exact: true })).toHaveCount(0);
});

test('INAPP-101 time range buttons', async ({ page }) => {
  test.info().annotations.push({ type: 'issue', description: 'INAPP-101' });
  test.fail();
  const p = await inAppProject('inapp-101');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Over time' });
  const device = await identifyDevice(p);
  await recordEvents(p, message.id, device.fingerprint, 'impression', 3);
  const rows = await impressionRows(message.id);
  expect(rows).toHaveLength(3);
  await sql(`UPDATE in_app_message_impressions SET created_at = now() - interval '20 days' WHERE id = $1`, [rows[1].id]);
  await sql(`UPDATE in_app_message_impressions SET created_at = now() - interval '60 days' WHERE id = $1`, [rows[2].id]);

  await signIn(page, p.owner);
  const timeseriesPath = `${MESSAGES(p.project.id)}/${message.id}/analytics/timeseries`;
  /** The next timeseries answer for a range of `days` (0: no start or end), with its row count. */
  const nextAnswer = (days: number) =>
    page.waitForResponse((r) => {
      const url = new URL(r.url());
      if (url.pathname !== timeseriesPath || r.request().method() !== 'GET') return false;
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      if (days === 0) return start === null && end === null;
      if (!start || !end) return false;
      const span = new Date(end).getTime() - new Date(start).getTime();
      return Math.abs(span - days * 86_400_000) < 60_000;
    });

  const card = cardTitled(page, 'Performance Over Time');
  const rangeButton = (label: string) => card.getByRole('button', { name: label, exact: true });
  const ticks = card.locator('.recharts-xAxis .recharts-cartesian-axis-tick');

  const first = nextAnswer(30);
  await openDetail(page, p.project.id, message.id, 'Over time');
  expect(((await (await first).json()).data as unknown[]).length).toBe(2);
  await expect(rangeButton('30d')).toHaveClass(FILLED);
  await expect(rangeButton('7d')).not.toHaveClass(FILLED);

  for (const [label, days, buckets] of [
    ['7d', 7, 1],
    ['90d', 90, 3],
    ['30d', 30, 2],
  ] as const) {
    const answer = nextAnswer(days);
    await rangeButton(label).click();
    const response = await answer;
    expect(((await response.json()).data as unknown[]).length, label).toBe(buckets);
    await expect(rangeButton(label), label).toHaveClass(FILLED);
    await expect(ticks, label).toHaveCount(buckets, { timeout: 5_000 });
  }

  const all = nextAnswer(0);
  await rangeButton('All').click();
  const allResponse = await all;
  expect(new URL(allResponse.url()).search).toBe('');
  await expect(rangeButton('All')).toHaveClass(FILLED);
});

test('INAPP-105 Button Click Breakdown', async ({ page }) => {
  const p = await inAppProject('inapp-105');
  const message = await messageIn(p.owner, p.project.id, 'active', {
    name: 'Two buttons',
    buttons: [
      { id: 'start', text: 'Get started', action: 'dismiss', style: 'primary' },
      { id: 'later', text: 'Maybe later', action: 'dismiss', style: 'text' },
    ],
  });
  const device = await identifyDevice(p);
  await recordEvents(p, message.id, device.fingerprint, 'cta_click', 3, 'start');
  await recordEvents(p, message.id, device.fingerprint, 'cta_click', 1, 'later');
  await recordEvents(p, message.id, device.fingerprint, 'click', 2);

  await signIn(page, p.owner);
  await openDetail(page, p.project.id, message.id, 'Two buttons');
  const card = cardTitled(page, 'Button Click Breakdown');
  const rows = card.locator('div.rounded-lg.border');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('span').first()).toHaveText('start');
  await expect(rows.nth(0).getByText('3 (75%)', { exact: true })).toBeVisible();
  await expect(rows.nth(1).locator('span').first()).toHaveText('later');
  await expect(rows.nth(1).getByText('1 (25%)', { exact: true })).toBeVisible();
  await expect(card.getByText('Get started')).toHaveCount(0);
  await expect(card.getByText('Maybe later')).toHaveCount(0);
  // The plain clicks count in the stats, not here.
  await expect(detailStat(page, 'Clicks')).toHaveText('6');
});

test('INAPP-107 detail loading and not-found states', async ({ page }) => {
  const p = await inAppProject('inapp-107');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Slow to load' });
  await signIn(page, p.owner);

  let released = false;
  await page.route(`**${MESSAGES(p.project.id)}/${message.id}`, async (route) => {
    if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 2_000));
    released = true;
    await route.continue();
  });
  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  const pulsing = page.locator('main main .animate-pulse');
  await expect(pulsing).toHaveCount(5);
  await expect(page.locator('main main [data-slot="card"] .animate-pulse')).toHaveCount(4);
  expect(released).toBe(false);
  await expect(page.getByRole('heading', { level: 1, name: 'Slow to load', exact: true })).toBeVisible();
  await expect(pulsing).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });

  const missing = '0b7e4a1c-3f52-4d2e-9a61-7c8d9e0f1a2b';
  const gets: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === `${MESSAGES(p.project.id)}/${missing}`) gets.push(r.url());
  });
  await page.goto(`/projects/${p.project.id}/in-app-messages/${missing}`);
  await expect(page.getByText('Campaign not found.', { exact: true })).toBeVisible({ timeout: 15_000 });
  // One retry after the first 404.
  expect(gets).toHaveLength(2);
});

// ------------------------------------------------------------ G. Trigger Now ---

test('INAPP-110 trigger dialog content', async ({ page }) => {
  const p = await inAppProject('inapp-110');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Flash sale' });
  await signIn(page, p.owner);
  await openDetail(page, p.project.id, message.id, 'Flash sale');
  await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Trigger Message Now' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Push "Flash sale" to users immediately. Select target:', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'All Users', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  // One target, Cancel and the corner close button: nothing else to pick.
  await expect(dialog.getByRole('button')).toHaveCount(3);
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1);
});

test('INAPP-112 trigger with no devices', async ({ page }) => {
  const p = await inAppProject('inapp-112');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Nobody here', triggerType: 'immediate' });
  await signIn(page, p.owner);
  await openDetail(page, p.project.id, message.id, 'Nobody here');
  await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Trigger Message Now' });
  const posted = page.waitForResponse((r) => r.url().endsWith(TRIGGER(p.project.id)) && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'All Users', exact: true }).click();
  const response = await posted;
  expect(response.status()).toBe(201);
  expect((await response.json()).data).toEqual({ queued: 0 });

  await expect(toastTitled(page, 'Queued for 0 devices')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(await pendingRows(message.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'in_app.triggered')).toEqual([]);
});

test('INAPP-115 trigger works on a draft message', async ({ page }) => {
  const p = await inAppProject('inapp-115');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Never activated' });
  const device = await identifyDevice(p, {}, 'fp-d1');
  // A draft is not delivered on its own.
  expect(await deliveredIds(p, device.fingerprint)).toEqual([]);

  await signIn(page, p.owner);
  await openDetail(page, p.project.id, message.id, 'Never activated');
  await expect(detailBadge(page, 'Never activated')).toContainText('Draft');
  await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();
  await page.getByRole('dialog', { name: 'Trigger Message Now' }).getByRole('button', { name: 'All Users', exact: true }).click();
  await expect(toastTitled(page, 'Queued for 1 devices')).toBeVisible();
  expect((await pendingRows(message.id)).map((r) => r.device_fingerprint)).toEqual([device.fingerprint]);

  // Expected (current code): the queued copy is delivered though the message is a draft.
  expect(await deliveredIds(p, device.fingerprint)).toEqual([message.id]);
  expect((await getMessage(p, message.id)).status).toBe('draft');
});

test('INAPP-116 trigger by users through the API', async () => {
  const p = await inAppProject('inapp-116');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'For user 42', triggerType: 'immediate' });
  const d1 = await identifyDevice(p, { distinctId: 'user-42', platform: 'ios' }, 'fp-d1');
  const d2 = await identifyDevice(p, { distinctId: 'user-42', platform: 'android' }, 'fp-d2');
  await identifyDevice(p, { distinctId: 'user-43' }, 'fp-other');

  const response = await call('POST', TRIGGER(p.project.id), p.owner, {
    messageId: message.id,
    targetType: 'users',
    distinctIds: ['user-42'],
    deviceFingerprints: [d1.fingerprint, 'fp-extra'],
  });
  expect(response.status, response.text).toBe(201);
  expect(response.body.data).toEqual({ queued: 3 });
  const rows = await pendingRows(message.id);
  expect(rows.map((r) => r.device_fingerprint).sort()).toEqual([d1.fingerprint, d2.fingerprint, 'fp-extra'].sort());
  expect(await activityRows(p.project.id, 'in_app.triggered')).toHaveLength(1);
});

test('INAPP-119 trigger validation', async () => {
  const p = await inAppProject('inapp-119');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Validated trigger', triggerType: 'immediate' });
  const valid = { messageId: message.id, targetType: 'users', deviceFingerprints: ['fp-valid'] };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['messageId', { ...valid, messageId: 'x' }, 'messageId must be a UUID'],
    ['targetType', { ...valid, targetType: 'everyone' }, 'targetType must be one of the following values: all, cohort, users'],
    ['cohortId', { ...valid, cohortId: 'x' }, 'cohortId must be a UUID'],
    ['distinctIds', { ...valid, distinctIds: 'user-42' }, 'distinctIds must be an array'],
    ['extra key', { ...valid, projectId: p.project.id }, 'property projectId should not exist'],
  ];
  for (const [label, body, message_] of cases) {
    const response = await call('POST', TRIGGER(p.project.id), p.owner, body);
    expect(response.status, label).toBe(400);
    expect(response.body.message, label).toContain(message_);
  }
  expect(await pendingRows(message.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'in_app.triggered')).toEqual([]);

  // The same body within the rules is accepted.
  const accepted = await call('POST', TRIGGER(p.project.id), p.owner, valid);
  expect(accepted.status, accepted.text).toBe(201);
  expect(accepted.body.data).toEqual({ queued: 1 });
});

// ------------------------------------------------------------ H. Messages API ---

test('INAPP-122 create validation for required fields', async () => {
  const p = await inAppProject('inapp-122');
  const empty = await call('POST', MESSAGES(p.project.id), p.owner, {});
  expect(empty.status).toBe(400);
  expect(empty.body.message).toEqual(
    expect.arrayContaining([
      'name must be a string',
      'messageType must be one of the following values: modal, bottom_sheet, banner_top, banner_bottom, fullscreen',
      'title must be a string',
    ]),
  );

  const badType = await call('POST', MESSAGES(p.project.id), p.owner, { name: 'x', title: 'y', messageType: 'popup' });
  expect(badType.status).toBe(400);
  expect(badType.body.message).toEqual([
    'messageType must be one of the following values: modal, bottom_sheet, banner_top, banner_bottom, fullscreen',
  ]);
  expect(await messageRows(p.project.id)).toEqual([]);

  const accepted = await call('POST', MESSAGES(p.project.id), p.owner, { name: 'x', title: 'y', messageType: 'modal' });
  expect(accepted.status, accepted.text).toBe(201);
});

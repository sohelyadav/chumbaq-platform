import { expect, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  blankToggle,
  call,
  campaignRow,
  createInAppMessage,
  createPosted,
  ctaRows,
  dataOf,
  dismissToasts,
  editorBackArrow,
  editorField,
  editorNumber,
  editorSelect,
  editorTypeBadge,
  identifyDevice,
  inAppProject,
  messageIn,
  messageRow,
  messageRows,
  openInAppList,
  presetCard,
  recordEvents,
  recordRequests,
  refuseDialogs,
  rowMenuItem,
  statValue,
  stepPill,
  toastTitled,
  waitForCounters,
  chooseOption,
  type InAppProject,
} from '../../support/areas/inapp';
import type { Page } from '@playwright/test';

/**
 * In-app messages (P1): the campaign list (stat cards, filters, search, row menu,
 * duplicate and delete), the editor's layout and steps, the template gallery and its
 * replace prompt, and the content step's fields and their validation.
 */

test.describe.configure({ mode: 'parallel' });

const MESSAGES = (projectId: string) => `/api/projects/${projectId}/in-app-messages`;
/** The filled look of a selected filter button or step pill. */
const FILLED = /(^|\s)bg-primary(\s|$)/;

const STATUSES = ['draft', 'scheduled', 'active', 'paused', 'completed', 'archived'] as const;
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
};

/** The button the SDK clicks reports (its id is the click's buttonId). */
const GO_BUTTON = { id: 'go', text: 'Go', action: 'dismiss', style: 'primary' };

/** One message in each status, named `S-<status>`. */
async function oneOfEach(p: InAppProject): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const status of STATUSES) {
    ids[status] = (await messageIn(p.owner, p.project.id, status, { name: `S-${status}` })).id;
  }
  return ids;
}

async function openNewEditor(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/in-app-messages/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'New Campaign', exact: true })).toBeVisible();
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

async function nameAndTitle(page: Page, name: string, title: string): Promise<void> {
  await editorField(page, 'Campaign Name').fill(name);
  await editorField(page, 'Title *').fill(title);
}

// ------------------------------------------------------------ A. Campaign list ---

test('INAPP-001 open In-App Messages from the sidebar', async ({ page }) => {
  const p = await inAppProject('inapp-001');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}`);
  await openSidebarGroup(page, 'Engagement');
  await sidebarLink(page, 'In-App Messages').click();

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages$`));
  await expect(page.getByRole('heading', { level: 1, name: 'In-App Messages', exact: true })).toBeVisible();
  await expect(page.getByText('Create and manage in-app messaging campaigns', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Campaign', exact: true })).toBeVisible();
  for (const label of ['Total Campaigns', 'Active', 'Total Impressions', 'Total Clicks']) {
    await expect(statValue(page, label), label).toHaveText('0');
  }
});

test('INAPP-002 empty list shows the empty state and its button', async ({ page }) => {
  const p = await inAppProject('inapp-002');
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);

  const bodyRows = page.locator('tbody tr');
  await expect(bodyRows).toHaveCount(1);
  await expect(bodyRows.first().getByText('No campaigns yet', { exact: true })).toBeVisible();
  await bodyRows.first().getByRole('button', { name: 'Create your first campaign' }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages/new$`));
  await expect(page.getByRole('heading', { level: 1, name: 'New Campaign', exact: true })).toBeVisible();
});

test('INAPP-004 rows show name, title, type, trigger, status, counters and CTR', async ({ page }) => {
  const p = await inAppProject('inapp-004');
  const message = await messageIn(p.owner, p.project.id, 'active', {
    name: 'Welcome modal',
    title: 'Welcome',
    messageType: 'modal',
    triggerType: 'on_app_open',
    buttons: [GO_BUTTON],
  });
  const device = await identifyDevice(p);
  await recordEvents(p, message.id, device.fingerprint, 'impression', 4);
  await recordEvents(p, message.id, device.fingerprint, 'click', 1, 'go');
  await waitForCounters(message.id, 4, 1);

  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  const cells = campaignRow(page, 'Welcome modal').getByRole('cell');
  await expect(cells.nth(0).getByText('Welcome modal', { exact: true })).toBeVisible();
  await expect(cells.nth(0).getByText('Welcome', { exact: true })).toBeVisible();
  await expect(cells.nth(1)).toHaveText('💬 Modal');
  await expect(cells.nth(2)).toHaveText('App Open');
  await expect(cells.nth(3)).toHaveText('Active');
  await expect(cells.nth(4)).toHaveText('4');
  await expect(cells.nth(5)).toHaveText('1');
  await expect(cells.nth(6)).toHaveText('25.0%');
});

test('INAPP-008 stat cards sum the loaded rows', async ({ page }) => {
  const p = await inAppProject('inapp-008');
  const a = await messageIn(p.owner, p.project.id, 'active', { name: 'Stats A', buttons: [GO_BUTTON] });
  const b = await messageIn(p.owner, p.project.id, 'active', { name: 'Stats B', buttons: [GO_BUTTON] });
  await messageIn(p.owner, p.project.id, 'draft', { name: 'Stats C' });
  const device = await identifyDevice(p);
  await recordEvents(p, a.id, device.fingerprint, 'impression', 10);
  await recordEvents(p, a.id, device.fingerprint, 'click', 2, 'go');
  await recordEvents(p, b.id, device.fingerprint, 'impression', 5);
  await recordEvents(p, b.id, device.fingerprint, 'click', 1, 'go');
  await waitForCounters(a.id, 10, 2);
  await waitForCounters(b.id, 5, 1);

  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  await expect(campaignRow(page, 'Stats C')).toBeVisible();
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveClass(FILLED);
  await expect(statValue(page, 'Total Campaigns')).toHaveText('3');
  await expect(statValue(page, 'Active')).toHaveText('2');
  await expect(statValue(page, 'Total Impressions')).toHaveText('15');
  await expect(statValue(page, 'Total Clicks')).toHaveText('3');
});

test('INAPP-009 status filter buttons query the API', async ({ page }) => {
  const p = await inAppProject('inapp-009');
  await oneOfEach(p);
  await signIn(page, p.owner);

  const listRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === MESSAGES(p.project.id)) listRequests.push(url.search);
  });
  await openInAppList(page, p.project.id);
  for (const status of STATUSES) await expect(campaignRow(page, `S-${status}`)).toBeVisible();
  // The first load (the All filter) sends no status.
  expect(listRequests[0]).toBe('');

  for (const status of ['active', 'draft', 'paused', 'scheduled', 'completed'] as const) {
    const label = STATUS_LABEL[status];
    const requested = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).searchParams.get('status') === status);
    await page.getByRole('button', { name: label, exact: true }).click();
    await requested;
    await expect(campaignRow(page, `S-${status}`), status).toBeVisible();
    await expect(page.locator('tbody tr'), status).toHaveCount(1);
    await expect(campaignRow(page, `S-${status}`).getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveClass(FILLED);
    await expect(page.getByRole('button', { name: 'All', exact: true })).not.toHaveClass(FILLED);
  }

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveClass(FILLED);
  // Every request the filters sent carried exactly the status clicked, and All none.
  expect(listRequests.every((q) => q === '' || /^\?status=(active|draft|paused|scheduled|completed)$/.test(q))).toBe(true);
  await expect(page.getByRole('button', { name: 'Archived', exact: true })).toHaveCount(0);
});

test('INAPP-011 search filters by name, case-insensitively, in the browser', async ({ page }) => {
  const p = await inAppProject('inapp-011');
  for (const name of ['Welcome modal', 'Spring Sale', 'welcome back']) await createInAppMessage(p.owner, p.project.id, { name });
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect(statValue(page, 'Total Campaigns')).toHaveText('3');

  const requests = recordRequests(page, 'GET', MESSAGES(p.project.id));
  await page.getByPlaceholder('Search campaigns...').fill('WELCOME');

  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(campaignRow(page, 'Welcome modal')).toBeVisible();
  await expect(campaignRow(page, 'welcome back')).toBeVisible();
  await expect(campaignRow(page, 'Spring Sale')).toHaveCount(0);
  await expect(statValue(page, 'Total Campaigns')).toHaveText('3');
  expect(requests).toEqual([]);

  // Positive control: a filter click is a list request the same recorder sees.
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
});

test('INAPP-016 clicking a row opens the detail page', async ({ page }) => {
  const p = await inAppProject('inapp-016');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Welcome modal' });
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);

  await campaignRow(page, 'Welcome modal').getByText('Welcome modal', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages/${message.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome modal', exact: true })).toBeVisible();
});

test('INAPP-018 row menu items per status', async ({ page }) => {
  const p = await inAppProject('inapp-018');
  await oneOfEach(p);
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);

  const expected: Record<string, string[]> = {
    draft: ['Edit', 'Activate', 'Duplicate', 'Delete'],
    paused: ['Edit', 'Activate', 'Duplicate', 'Delete'],
    active: ['Edit', 'Pause', 'Duplicate', 'Delete'],
    scheduled: ['Edit', 'Duplicate', 'Delete'],
    completed: ['Edit', 'Duplicate', 'Delete'],
    archived: ['Edit', 'Duplicate', 'Delete'],
  };
  for (const status of STATUSES) {
    await campaignRow(page, `S-${status}`).getByRole('button').click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem'), status).toHaveText(expected[status]);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
  // Opening the menus did not leave the list.
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages$`));
});

test('INAPP-023 duplicate from the list', async ({ page }) => {
  const p = await inAppProject('inapp-023');
  const theme = {
    backgroundColor: '#000000',
    textColor: '#eeeeee',
    titleColor: '#ffffff',
    buttonPrimaryColor: '#ff0000',
    buttonSecondaryColor: '#00ff00',
    overlayColor: 'rgba(0,0,0,0.7)',
    borderRadius: 8,
    animation: 'slide_up',
  };
  const buttons = [
    { id: 'buy', text: 'Buy now', action: 'deep_link', actionUrl: 'myapp://buy', style: 'primary' },
    { id: 'later', text: 'Later', action: 'dismiss', style: 'text' },
  ];
  const original = await messageIn(p.owner, p.project.id, 'active', {
    name: 'Welcome modal',
    title: 'Welcome',
    body: 'A body',
    imageUrl: 'https://example.com/hero.png',
    imagePosition: 'center',
    buttons,
    theme,
    dismissOnTapOutside: false,
    autoDismissSeconds: 9,
    triggerType: 'on_event',
    triggerEvent: 'purchase_completed',
    triggerDelaySeconds: 3,
    startsAt: '2030-01-01T10:00:00.000Z',
    endsAt: '2030-02-01T10:00:00.000Z',
    priority: 4,
    maxImpressionsPerUser: 2,
    minIntervalSeconds: 60,
    tags: ['promo', 'spring'],
  });
  const device = await identifyDevice(p);
  await recordEvents(p, original.id, device.fingerprint, 'impression', 4);
  await recordEvents(p, original.id, device.fingerprint, 'click', 1, 'buy');
  await waitForCounters(original.id, 4, 1);
  const before = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${original.id}`, p.owner));
  const activityBefore = (await activityRows(p.project.id)).length;

  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  const duplicated = page.waitForResponse((r) => r.url().endsWith(`/in-app-messages/${original.id}/duplicate`) && r.request().method() === 'POST');
  await rowMenuItem(page, 'Welcome modal', 'Duplicate');
  const response = await duplicated;
  expect(response.status()).toBe(201);
  const copyId = (await response.json()).data.id as string;

  await expect(toastTitled(page, 'Campaign duplicated')).toBeVisible();
  const copyCells = campaignRow(page, 'Welcome modal (Copy)').getByRole('cell');
  await expect(copyCells.nth(3)).toHaveText('Draft');
  await expect(copyCells.nth(4)).toHaveText('0');
  await expect(copyCells.nth(5)).toHaveText('0');

  const copy = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${copyId}`, p.owner));
  expect(copy.id).not.toBe(original.id);
  expect(copy).toMatchObject({ name: 'Welcome modal (Copy)', status: 'draft', totalImpressions: 0, totalClicks: 0, totalDismissals: 0 });
  const copied = [
    'messageType', 'title', 'body', 'imageUrl', 'imagePosition', 'buttons', 'theme', 'dismissOnTapOutside',
    'autoDismissSeconds', 'triggerType', 'triggerEvent', 'triggerScreen', 'triggerDelaySeconds', 'triggerConditions',
    'userType', 'mixpanelCohortId', 'segmentId', 'userFilters', 'startsAt', 'endsAt', 'priority',
    'maxImpressionsPerUser', 'minIntervalSeconds', 'maxImpressionsTotal', 'tags',
  ];
  for (const key of copied) expect(copy[key], key).toEqual(before[key]);
  expect(copy.buttons).toEqual(buttons);
  expect(copy.theme).toEqual(theme);

  const after = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${original.id}`, p.owner));
  expect(after).toEqual(before);
  expect(await activityRows(p.project.id)).toHaveLength(activityBefore);
});

test('INAPP-026 cancelling the delete prompt keeps the campaign', async ({ page }) => {
  const p = await inAppProject('inapp-026');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Keep me' });
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);

  const deletes = recordRequests(page, 'DELETE', `/in-app-messages/${message.id}`);
  const prompts: string[] = [];
  page.once('dialog', async (dialog) => {
    prompts.push(dialog.message());
    await dialog.dismiss();
  });
  await rowMenuItem(page, 'Keep me', 'Delete');
  await expect.poll(() => prompts).toEqual(['Are you sure you want to delete this campaign?']);
  await expect(page.getByRole('menu')).toHaveCount(0);

  // A request the page sends after the prompt is answered: any DELETE the prompt had let
  // through would have been sent, and recorded, before it.
  const listed = recordRequests(page, 'GET', MESSAGES(p.project.id));
  const filtered = page.waitForResponse((r) => new URL(r.url()).searchParams.get('status') === 'draft');
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  expect((await filtered).status()).toBe(200);
  expect(listed).toHaveLength(1);

  expect(deletes).toEqual([]);
  await expect(campaignRow(page, 'Keep me')).toBeVisible();
  await expect(page.getByRole('region', { name: /Notifications/ }).locator('li')).toHaveCount(0);
  expect(await messageRow(message.id)).toBeDefined();
});

test('INAPP-027 deleting an active campaign is refused', async ({ page }) => {
  const p = await inAppProject('inapp-027');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Live one' });
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);

  page.once('dialog', (dialog) => dialog.accept());
  const deleted = page.waitForResponse((r) => r.url().endsWith(`/in-app-messages/${message.id}`) && r.request().method() === 'DELETE');
  await rowMenuItem(page, 'Live one', 'Delete');
  const response = await deleted;
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toBe('Cannot delete an active message. Pause it first.');

  // Expected (current code): the toast shows the client's own error text, not the server's.
  await expect(toastTitled(page, 'Request failed with status code 400')).toBeVisible();
  await expect(campaignRow(page, 'Live one')).toBeVisible();
  expect((await messageRow(message.id))?.status).toBe('active');
  expect(await activityRows(p.project.id, 'content.deleted')).toHaveLength(0);
});

// ------------------------------------------------------------ B. Editor layout and templates ---

test('INAPP-030 new campaign editor opens with defaults', async ({ page }) => {
  const p = await inAppProject('inapp-030');
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  await page.getByRole('button', { name: 'New Campaign', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages/new$`));
  await expect(page.getByRole('heading', { level: 1, name: 'New Campaign', exact: true })).toBeVisible();
  await expect(editorTypeBadge(page)).toHaveText('Modal');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Campaign', exact: true })).toHaveCount(1);

  const pills = [stepPill(page, 1, 'Content & Design'), stepPill(page, 2, 'Trigger'), stepPill(page, 3, 'Users'), stepPill(page, 4, 'Schedule & Limits')];
  for (const pill of pills) await expect(pill).toBeVisible();
  await expect(pills[0]).toHaveClass(FILLED);
  for (const pill of pills.slice(1)) await expect(pill).not.toHaveClass(FILLED);

  await expect(page.getByRole('button', { name: '← Previous', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next →', exact: true })).toBeEnabled();
  await expect(page.getByText('Live Preview', { exact: true })).toBeVisible();
  await expect(page.getByText('Message Title', { exact: true })).toBeVisible();
  // The modal preview draws a close mark.
  await expect(page.getByRole('button', { name: '✕', exact: true })).toBeVisible();
  await expect(page.getByText('Start from a template', { exact: true })).toBeVisible();
  await expect(blankToggle(page)).toHaveText('Starting blank');
});

test('INAPP-031 Next and Previous walk the four steps', async ({ page }) => {
  const p = await inAppProject('inapp-031');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  const next = page.getByRole('button', { name: 'Next →', exact: true });
  const previous = page.getByRole('button', { name: '← Previous', exact: true });

  await next.click();
  await expect(page.getByText('When to show', { exact: true })).toBeVisible();
  await expect(stepPill(page, 2, 'Trigger')).toHaveClass(FILLED);
  await next.click();
  await expect(page.getByText('Target Users', { exact: true })).toBeVisible();
  await next.click();
  await expect(page.getByText('Schedule Window', { exact: true })).toBeVisible();
  await expect(next).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save Campaign', exact: true })).toHaveCount(2);

  await previous.click();
  await expect(page.getByText('Target Users', { exact: true })).toBeVisible();
  await previous.click();
  await expect(page.getByText('When to show', { exact: true })).toBeVisible();
  await previous.click();
  await expect(editorField(page, 'Campaign Name')).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeVisible();
});

test('INAPP-033 form state survives switching steps', async ({ page }) => {
  const p = await inAppProject('inapp-033');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Kept name', 'Kept title');

  await stepPill(page, 2, 'Trigger').click();
  const onEvent = page.getByRole('button', { name: /^On Event/ });
  await onEvent.click();
  await editorField(page, 'Event Name').fill('purchase_completed');

  await page.getByRole('button', { name: '← Previous', exact: true }).click();
  await expect(editorField(page, 'Campaign Name')).toHaveValue('Kept name');
  await expect(editorField(page, 'Title *')).toHaveValue('Kept title');

  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await expect(onEvent).toHaveClass(/border-primary/);
  await expect(page.getByRole('button', { name: /^App Open/ })).not.toHaveClass(/border-primary/);
  await expect(editorField(page, 'Event Name')).toHaveValue('purchase_completed');
});

test('INAPP-034 Cancel and back arrow leave without saving', async ({ page }) => {
  const p = await inAppProject('inapp-034');
  const dialogs = refuseDialogs(page);
  await signIn(page, p.owner);
  const posts = recordRequests(page, 'POST', MESSAGES(p.project.id));

  await openInAppList(page, p.project.id);
  await page.getByRole('button', { name: 'New Campaign', exact: true }).click();
  await editorField(page, 'Campaign Name').fill('Never saved');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages$`));
  await expect(page.getByText('No campaigns yet', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New Campaign', exact: true }).click();
  await editorField(page, 'Campaign Name').fill('Never saved either');
  await editorBackArrow(page).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages$`));
  await expect(page.getByText('No campaigns yet', { exact: true })).toBeVisible();

  expect(posts).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(await messageRows(p.project.id)).toEqual([]);
});

test('INAPP-035 template gallery lists the seven presets', async ({ page }) => {
  const p = await inAppProject('inapp-035');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);

  const presets = [
    { name: 'Welcome', description: 'A first-run greeting with one clear thing to do next.', badges: ['Modal', 'Image', '1 button'] },
    { name: 'Rating prompt', description: 'Asks for a review, with a graceful way to say not now.', badges: ['Modal', '2 buttons', 'No image'] },
    { name: 'Full-screen promo', description: 'An offer that takes the whole screen, over a background image.', badges: ['Fullscreen', 'Background image', '2 buttons'] },
    { name: 'Feature spotlight', description: 'Introduces something new without taking over the screen.', badges: ['Bottom sheet', 'Image', '1 button'] },
    { name: 'Survey invite', description: 'A short ask for feedback, from the bottom of the screen.', badges: ['Bottom sheet', '2 buttons', 'Custom event'] },
    { name: 'Update nudge', description: 'A thin bar at the top, out of the way of whatever they were doing.', badges: ['Top banner', '1 button'] },
    { name: 'Announcement bar', description: 'A note along the bottom that clears itself after a few seconds.', badges: ['Bottom banner', 'Auto-dismiss'] },
  ];
  const cards = page.locator('button[aria-pressed]');
  await expect(cards).toHaveCount(7);
  await expect(cards.locator('span.text-sm.font-medium')).toHaveText(presets.map((x) => x.name));
  for (const preset of presets) {
    const card = presetCard(page, preset.name);
    await expect(card, preset.name).toHaveAttribute('aria-pressed', 'false');
    await expect(card.getByText(preset.description, { exact: true })).toBeVisible();
    await expect(card.locator('[data-slot="badge"]'), preset.name).toHaveText(preset.badges);
  }
});

test('INAPP-036 applying a preset to a blank form fills the content', async ({ page }) => {
  const p = await inAppProject('inapp-036');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await editorField(page, 'Campaign Name').fill('Onboarding');
  // A preset that changes the type shows it changing: start from another type.
  await page.getByRole('button', { name: /Full Screen/ }).click();
  await expect(editorTypeBadge(page)).toHaveText('Full Screen');

  await presetCard(page, 'Welcome').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(editorTypeBadge(page)).toHaveText('Modal');
  await expect(editorField(page, 'Title *')).toHaveValue('Welcome aboard');
  await expect(editorField(page, 'Body')).toHaveValue('Here is the quickest way to get started.');
  await expect(editorField(page, 'Image URL')).toHaveValue('https://example.com/welcome.png');
  await expect(editorSelect(page, 'Position')).toHaveText('Top');
  const rows = ctaRows(page);
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByPlaceholder('Label')).toHaveValue('Get started');
  await expect(rows.first().getByRole('combobox')).toHaveText(['Deep Link', 'Primary']);
  await expect(presetCard(page, 'Welcome')).toHaveAttribute('aria-pressed', 'true');
  await expect(presetCard(page, 'Welcome').locator('span.absolute svg')).toHaveCount(1);
  await expect(blankToggle(page)).toHaveText('Start blank instead');
  await expect(editorField(page, 'Campaign Name')).toHaveValue('Onboarding');
});

test('INAPP-038 preset over existing content asks first; Keep what I have', async ({ page }) => {
  const p = await inAppProject('inapp-038');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await editorField(page, 'Title *').fill('My title');

  await presetCard(page, 'Rating prompt').click();
  const dialog = page.getByRole('dialog', { name: 'Replace what you’ve written?' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      'Applying “Rating prompt” overwrites the layout, title, body, image and buttons of this message. The name, trigger, audience and schedule are left as they are.',
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep what I have', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(editorField(page, 'Title *')).toHaveValue('My title');
  await expect(ctaRows(page)).toHaveCount(0);
  await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(0);
  await expect(blankToggle(page)).toHaveText('Starting blank');
});

test('INAPP-039 preset over existing content; Replace content', async ({ page }) => {
  const p = await inAppProject('inapp-039');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await editorField(page, 'Body').fill('Something I wrote');
  await page.getByRole('button', { name: 'Add Button' }).click();
  await expect(ctaRows(page)).toHaveCount(1);

  await presetCard(page, 'Survey invite').click();
  const dialog = page.getByRole('dialog', { name: 'Replace what you’ve written?' });
  await expect(dialog.getByText(/Applying “Survey invite” overwrites/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Replace content', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(editorTypeBadge(page)).toHaveText('Bottom Sheet');
  await expect(editorField(page, 'Title *')).toHaveValue('Got a minute?');
  await expect(editorField(page, 'Body')).toHaveValue('Tell us what would make this better.');
  const rows = ctaRows(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByPlaceholder('Label')).toHaveValue('Start survey');
  await expect(rows.nth(0).getByRole('combobox')).toHaveText(['Open URL', 'Primary']);
  await expect(rows.nth(1).getByPlaceholder('Label')).toHaveValue('Not now');
  await expect(rows.nth(1).getByRole('combobox')).toHaveText(['Event', 'Secondary']);
  await expect(presetCard(page, 'Survey invite')).toHaveAttribute('aria-pressed', 'true');
});

test('INAPP-042 Start blank instead resets the content', async ({ page }) => {
  const p = await inAppProject('inapp-042');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await presetCard(page, 'Announcement bar').click();
  await editorField(page, 'Campaign Name').fill('Bar');
  await expect(editorTypeBadge(page)).toHaveText('Bottom Banner');
  await expect(editorNumber(page, 'Auto-dismiss (seconds)')).toHaveValue('6');
  // Change some appearance too, so the reset of the colours is visible.
  await editorField(page, 'Background').fill('#123456');
  await page.getByText('Dismiss on Tap Outside', { exact: true }).locator('../..').getByRole('switch').click();
  await expect(page.getByText('Dismiss on Tap Outside', { exact: true }).locator('../..').getByRole('switch')).not.toBeChecked();

  await blankToggle(page).click();

  await expect(editorTypeBadge(page)).toHaveText('Modal');
  await expect(editorField(page, 'Title *')).toHaveValue('');
  await expect(editorField(page, 'Body')).toHaveValue('');
  await expect(editorField(page, 'Image URL')).toHaveValue('');
  await expect(editorSelect(page, 'Position')).toHaveText('Top');
  await expect(ctaRows(page)).toHaveCount(0);
  await expect(page.getByText('No buttons — message will have a close/dismiss button only', { exact: true })).toBeVisible();
  await expect(editorField(page, 'Background')).toHaveValue('#ffffff');
  await expect(editorField(page, 'Title')).toHaveValue('#111827');
  await expect(editorField(page, 'Body Text')).toHaveValue('#374151');
  await expect(editorField(page, 'Button Color')).toHaveValue('#6366f1');
  await expect(editorNumber(page, 'Corner Radius')).toHaveValue('16');
  await expect(page.getByText('Dismiss on Tap Outside', { exact: true }).locator('../..').getByRole('switch')).toBeChecked();
  await expect(editorNumber(page, 'Auto-dismiss (seconds)')).toHaveValue('');
  await expect(blankToggle(page)).toHaveText('Starting blank');
  await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(0);
  await expect(editorField(page, 'Campaign Name')).toHaveValue('Bar');
});

// ------------------------------------------------------------ C. Editor step 1 ---

test('INAPP-048 required name and title on save', async ({ page }) => {
  const p = await inAppProject('inapp-048');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  const posts = recordRequests(page, 'POST', MESSAGES(p.project.id));

  const expectRefused = async (step: string) => {
    await saveCampaign(page);
    await expect(toastTitled(page, 'Name and title are required'), step).toBeVisible();
    await dismissToasts(page);
  };
  await expectRefused('both empty');
  await editorField(page, 'Campaign Name').fill('Only a name');
  await expectRefused('name only');
  await editorField(page, 'Campaign Name').fill('');
  await editorField(page, 'Title *').fill('Only a title');
  await expectRefused('title only');

  expect(posts).toEqual([]);
  await expect(page).toHaveURL(/\/in-app-messages\/new$/);
  expect(await messageRows(p.project.id)).toEqual([]);

  // Positive control: with both filled, the same button sends the POST the recorder sees.
  await editorField(page, 'Campaign Name').fill('Both now');
  const id = await saveAndGetId(page, p.project.id);
  expect(posts).toHaveLength(1);
  expect((await messageRows(p.project.id)).map((row) => row.id)).toEqual([id]);
});

test('INAPP-051 server refusal shows Failed to save', async ({ page }) => {
  const p = await inAppProject('inapp-051');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Refused one', 'Refused title');
  await editorField(page, 'Body').fill('Kept body');

  await page.route(`**${MESSAGES(p.project.id)}`, (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { statusCode: 400, message: ['x'] } }) : route.continue(),
  );
  await saveCampaign(page);

  await expect(toastTitled(page, 'Failed to save')).toBeVisible();
  // The server's message is not shown.
  await expect(page.getByText('x', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages/new$`));
  await expect(editorField(page, 'Campaign Name')).toHaveValue('Refused one');
  await expect(editorField(page, 'Title *')).toHaveValue('Refused title');
  await expect(editorField(page, 'Body')).toHaveValue('Kept body');
  expect(await messageRows(p.project.id)).toEqual([]);
});

test('INAPP-052 body, image URL and position are saved', async ({ page }) => {
  const p = await inAppProject('inapp-052');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'With content', 'Content title');
  await editorField(page, 'Body').fill('Line one');
  await editorField(page, 'Image URL').fill('https://example.com/hero.png');
  await chooseOption(editorSelect(page, 'Position'), 'Center');

  const id = await saveAndGetId(page, p.project.id);
  const stored = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${id}`, p.owner));
  expect(stored).toMatchObject({ body: 'Line one', imageUrl: 'https://example.com/hero.png', imagePosition: 'center' });
});

test('INAPP-056 add up to three buttons', async ({ page }) => {
  const p = await inAppProject('inapp-056');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  const add = page.getByRole('button', { name: 'Add Button' });
  const emptyNote = page.getByText('No buttons — message will have a close/dismiss button only', { exact: true });
  await expect(emptyNote).toBeVisible();

  await add.click();
  await expect(ctaRows(page)).toHaveCount(1);
  await expect(emptyNote).toHaveCount(0);
  await add.click();
  await expect(ctaRows(page)).toHaveCount(2);
  await add.click();
  const rows = ctaRows(page);
  await expect(rows).toHaveCount(3);

  const styles = ['Primary', 'Secondary', 'Secondary'];
  for (let i = 0; i < 3; i++) {
    await expect(rows.nth(i).getByPlaceholder('Label')).toHaveValue('Click Me');
    await expect(rows.nth(i).getByRole('combobox')).toHaveText(['Dismiss', styles[i]]);
  }
  await expect(add).toBeDisabled();
});

test('INAPP-057 edit and remove buttons', async ({ page }) => {
  const p = await inAppProject('inapp-057');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Buttons edited', 'Pick one');
  const add = page.getByRole('button', { name: 'Add Button' });
  await add.click();
  await expect(ctaRows(page)).toHaveCount(1);
  await add.click();
  const rows = ctaRows(page);
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByPlaceholder('Label').fill('Second');

  const first = rows.nth(0);
  await first.getByPlaceholder('Label').fill('Buy');
  await chooseOption(first.getByRole('combobox').nth(0), 'Event');
  await chooseOption(first.getByRole('combobox').nth(1), 'Text');
  await rows.nth(1).getByRole('button').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByPlaceholder('Label')).toHaveValue('Buy');

  const id = await saveAndGetId(page, p.project.id);
  const stored = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${id}`, p.owner));
  expect(stored.buttons).toHaveLength(1);
  expect(stored.buttons[0]).toEqual({ id: expect.stringMatching(/^btn_\d+$/), text: 'Buy', action: 'custom_event', style: 'text' });
});

test('INAPP-058 buttons with Open URL, Deep Link and Event have no target field', async ({ page }) => {
  const p = await inAppProject('inapp-058');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Open a page', 'Go somewhere');
  await page.getByRole('button', { name: 'Add Button' }).click();
  const row = ctaRows(page).first();
  for (const action of ['Deep Link', 'Event', 'Open URL']) {
    await chooseOption(row.getByRole('combobox').nth(0), action);
    await expect(row.getByRole('combobox').nth(0)).toHaveText(action);
    // Expected (current code): the row keeps only its label field; nothing asks for a target.
    await expect(row.getByRole('textbox'), action).toHaveCount(1);
  }
  await expect(page.getByPlaceholder(/https?:\/\//)).toHaveCount(1); // the Image URL field only

  const id = await saveAndGetId(page, p.project.id);
  const stored = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${id}`, p.owner));
  expect(stored.buttons).toHaveLength(1);
  expect(stored.buttons[0].action).toBe('url');
  expect(stored.buttons[0]).not.toHaveProperty('actionUrl');
  expect(stored.buttons[0]).not.toHaveProperty('actionEvent');

  // Only a preset carries a target.
  await openNewEditor(page, p.project.id);
  await presetCard(page, 'Rating prompt').click();
  await editorField(page, 'Campaign Name').fill('From the preset');
  const presetId = await saveAndGetId(page, p.project.id);
  const fromPreset = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${presetId}`, p.owner));
  expect(fromPreset.buttons[0]).toMatchObject({ action: 'url', actionUrl: 'https://example.com/review' });
});

test('INAPP-059 button label rules on the API', async () => {
  const p = await inAppProject('inapp-059');
  const valid = { id: 'b1', text: 'Go', action: 'dismiss', style: 'primary' };
  const post = (button: Record<string, unknown>) =>
    call('POST', MESSAGES(p.project.id), p.owner, { name: 'Button rules', messageType: 'modal', title: 'T', buttons: [button] });

  const { text: _text, ...noText } = valid;
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['no text', noText, 'buttons.0.text must be a string'],
    ['long text', { ...valid, text: 'x'.repeat(65) }, 'buttons.0.text must be shorter than or equal to 64 characters'],
    ['bad action', { ...valid, action: 'teleport' }, 'buttons.0.action must be one of the following values: dismiss, deep_link, url, custom_event'],
    ['bad style', { ...valid, style: 'huge' }, 'buttons.0.style must be one of the following values: primary, secondary, text'],
    ['long actionUrl', { ...valid, actionUrl: 'u'.repeat(2049) }, 'buttons.0.actionUrl must be shorter than or equal to 2048 characters'],
    ['long actionEvent', { ...valid, actionEvent: 'e'.repeat(256) }, 'buttons.0.actionEvent must be shorter than or equal to 255 characters'],
    ['long id', { ...valid, id: 'i'.repeat(65) }, 'buttons.0.id must be shorter than or equal to 64 characters'],
    ['extra key', { ...valid, color: 'red' }, 'buttons.0.property color should not exist'],
  ];
  for (const [label, button, message] of cases) {
    const response = await post(button);
    expect(response.status, label).toBe(400);
    expect(response.body.message, label).toContain(message);
  }
  expect(await messageRows(p.project.id)).toEqual([]);

  // The same button within the rules (at the limits) is accepted.
  const accepted = await post({ ...valid, text: 'x'.repeat(64), id: 'i'.repeat(64), actionUrl: 'u'.repeat(2048), actionEvent: 'e'.repeat(255) });
  expect(accepted.status, accepted.text).toBe(201);
});

test('INAPP-061 theme colours accept hex, rgb and rgba', async ({ page }) => {
  const p = await inAppProject('inapp-061');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Colours', 'Colourful');
  await editorField(page, 'Background').fill('#ECFDF5');
  await editorField(page, 'Title').fill('#fff');
  await editorField(page, 'Body Text').fill('rgb(10, 20, 30)');
  await editorField(page, 'Button Color').fill('#6366f1ff');

  const id = await saveAndGetId(page, p.project.id);
  await expect(toastTitled(page, 'Campaign created')).toBeVisible();
  const stored = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${id}`, p.owner));
  expect(stored.theme).toMatchObject({
    backgroundColor: '#ECFDF5',
    titleColor: '#fff',
    textColor: 'rgb(10, 20, 30)',
    buttonPrimaryColor: '#6366f1ff',
    overlayColor: 'rgba(0,0,0,0.5)',
  });
});

test('INAPP-064 corner radius bounds', async ({ page }) => {
  const p = await inAppProject('inapp-064');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Radius', 'Round');

  for (const [value, message] of [
    ['101', 'theme.borderRadius must not be greater than 100'],
    ['-1', 'theme.borderRadius must not be less than 0'],
  ]) {
    await dismissToasts(page);
    await editorNumber(page, 'Corner Radius').fill(value);
    const posted = createPosted(page, p.project.id);
    await saveCampaign(page);
    const response = await posted;
    expect(response.status(), value).toBe(400);
    expect((await response.json()).message, value).toContain(message);
    await expect(toastTitled(page, 'Failed to save'), value).toHaveCount(1);
  }
  expect(await messageRows(p.project.id)).toEqual([]);

  await editorNumber(page, 'Corner Radius').fill('0');
  const zeroId = await saveAndGetId(page, p.project.id);
  expect(dataOf(await call('GET', `${MESSAGES(p.project.id)}/${zeroId}`, p.owner)).theme.borderRadius).toBe(0);

  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Radius empty', 'Square');
  await editorNumber(page, 'Corner Radius').fill('');
  const posted = createPosted(page, p.project.id);
  await saveCampaign(page);
  const response = await posted;
  expect(response.request().postDataJSON().theme.borderRadius).toBeNull();
  expect(response.status()).toBe(201);
  const emptyId = (await response.json()).data.id as string;
  const stored = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${emptyId}`, p.owner));
  expect(stored.theme.borderRadius).toBeNull();
});

test('INAPP-065 theme rejects unknown keys and bad animation', async () => {
  const p = await inAppProject('inapp-065');
  const post = (theme: Record<string, unknown>) =>
    call('POST', MESSAGES(p.project.id), p.owner, { name: 'Theme rules', messageType: 'modal', title: 'T', theme });

  const cases: Array<[Record<string, unknown>, string]> = [
    [{ fontFamily: 'x' }, 'theme.property fontFamily should not exist'],
    [{ animation: 'explode' }, 'theme.animation must be one of the following values: fade, slide_up, slide_down, scale, none'],
    [{ borderRadius: '16px; position: fixed' }, 'theme.borderRadius must be an integer number'],
  ];
  for (const [theme, message] of cases) {
    const response = await post(theme);
    expect(response.status, JSON.stringify(theme)).toBe(400);
    expect(response.body.message, JSON.stringify(theme)).toContain(message);
  }
  expect(await messageRows(p.project.id)).toEqual([]);

  const accepted = await post({ animation: 'scale', borderRadius: 16 });
  expect(accepted.status, accepted.text).toBe(201);
  expect(accepted.body.data.theme).toEqual({ animation: 'scale', borderRadius: 16 });
});

test('INAPP-067 dismiss on tap outside and auto-dismiss', async ({ page }) => {
  const p = await inAppProject('inapp-067');
  await signIn(page, p.owner);
  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Self closing', 'Goes away');
  const dismissSwitch = page.getByText('Dismiss on Tap Outside', { exact: true }).locator('../..').getByRole('switch');
  await expect(dismissSwitch).toBeChecked();
  await dismissSwitch.click();
  await expect(dismissSwitch).not.toBeChecked();
  await editorNumber(page, 'Auto-dismiss (seconds)').fill('8');

  const id = await saveAndGetId(page, p.project.id);
  const stored = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${id}`, p.owner));
  expect(stored).toMatchObject({ dismissOnTapOutside: false, autoDismissSeconds: 8 });

  await openNewEditor(page, p.project.id);
  await nameAndTitle(page, 'Negative close', 'Never');
  await editorNumber(page, 'Auto-dismiss (seconds)').fill('-1');
  const posted = createPosted(page, p.project.id);
  await saveCampaign(page);
  const refused = await posted;
  expect(refused.status()).toBe(400);
  expect((await refused.json()).message).toContain('autoDismissSeconds must not be less than 0');
  await expect(toastTitled(page, 'Failed to save')).toBeVisible();

  await editorNumber(page, 'Auto-dismiss (seconds)').fill('');
  const emptyId = await saveAndGetId(page, p.project.id);
  const empty = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${emptyId}`, p.owner));
  expect(empty).toMatchObject({ dismissOnTapOutside: true, autoDismissSeconds: null });
});

import { randomUUID } from 'crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, signIn, test } from '../../support/fixtures';
import { newClientIp } from '../../support/api';
import {
  activityRows,
  apiLogText,
  apiResponse,
  call,
  campaignRow,
  cardTitled,
  clearPickedDate,
  collectPageErrors,
  createInAppMessage,
  createPosted,
  createWidget,
  createWidgetItem,
  dataOf,
  deliveredIds,
  deliveredIdsWith,
  detailBadge,
  dialogField,
  editorChoice,
  editorField,
  failRequests,
  fingerprint,
  identifyDevice,
  inAppProject,
  insertDevices,
  isItemPost,
  itemTitlesShown,
  messageIn,
  messageOf,
  messageRow,
  openInAppList,
  pendingRows,
  PROJECT_NOT_FOUND,
  recordInAppEvent,
  rowMenuItem,
  sdkCall,
  sdkRequest,
  sdkRequestWithHeaders,
  seedCohort,
  serveWidget,
  setWidgetStatus,
  sql,
  stepPill,
  toastTitles,
  toastWithTitle,
  traitSegment,
  updatePatched,
  WIDGET_NOT_ACTIVE,
  widgetEventRows,
  widgetItemCard,
  widgetItemRow,
  widgetItemRows,
  widgetListRow,
  widgetRow,
  widgetRows,
  widgetRowStat,
  IPHONE_SAFARI_UA,
  type InAppProject,
  type RawResponse,
} from '../../support/areas/inapp';

/**
 * In-app messages and widgets (P1, review round): the widgets list's totals, stories
 * with a CTA and no click URL, status changes by PATCH, edits that clear fields, cohort,
 * specific-users and segment audiences, frequency caps per device, the trigger queue
 * (duplicates, long fingerprints, large audiences, double clicks), silent failures on
 * the detail pages, the row menu's Edit, widget item order, edits and failures, single
 * and stories widgets holding several items, the category PATCH routes, and what widget
 * serve and click store.
 */

test.describe.configure({ mode: 'parallel' });

const MESSAGES = (projectId: string) => `/api/projects/${projectId}/in-app-messages`;
const IMAGE = 'https://example.com/banner.jpg';
const MINUTE = 60_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** A widget with items (title, sortOrder and any overrides), made through the API. */
async function widgetWith(
  p: InAppProject,
  category: Record<string, unknown> & { name: string },
  items: Array<Record<string, unknown> & { title: string }>,
  status?: 'active' | 'paused',
) {
  const widget = await createWidget(p.owner, p.project.id, { layout: 'carousel', ...category });
  const created = [];
  for (const [index, item] of items.entries()) {
    created.push(
      await createWidgetItem(p.owner, widget.id, {
        imageUrl: `https://example.com/${index}.png`,
        clickUrl: `https://example.com/offer/${index}`,
        sortOrder: index,
        ...item,
      }),
    );
  }
  if (status) await setWidgetStatus(p.owner, widget.id, status);
  return { widget, items: created };
}

async function getMessage(p: InAppProject, id: string): Promise<Record<string, any>> {
  return dataOf(await call('GET', `${MESSAGES(p.project.id)}/${id}`, p.owner));
}

async function getItem(p: InAppProject, id: string): Promise<Record<string, any>> {
  return dataOf(await call('GET', `/api/in-app-banners/${id}`, p.owner));
}

async function openWidgets(page: Page, projectId: string, type: string, heading: string): Promise<void> {
  await page.goto(`/projects/${projectId}/widgets/${type}`);
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
}

/** The expanded part of a widgets-list row (the row under it holding the footer). */
function expandedPart(page: Page, widgetId: string) {
  return page.getByRole('row').filter({ hasText: `Widget ID: ${widgetId}` });
}

async function openEditEditor(page: Page, projectId: string, id: string): Promise<void> {
  await page.goto(`/projects/${projectId}/in-app-messages/${id}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Campaign', exact: true })).toBeVisible();
}

/** The ids a check delivers, repeats kept. */
async function deliveredWithRepeats(p: InAppProject, deviceFingerprint: string): Promise<string[]> {
  const result = dataOf<{ messages: Array<{ id: string }> }>(
    await sdkCall('/api/messages/check', p.sdkKey, { projectId: p.project.id, deviceFingerprint, context: { platform: 'ios' } }),
  );
  return result.messages.map((m) => m.id);
}

/** The date pickers of a widget item dialog, by their label. */
function picker(scope: Locator, label: string) {
  return scope.locator('label', { hasText: new RegExp(`^${label}$`) }).locator('..').getByRole('button');
}

// ------------------------------------------------------------ Counting ---

test('INAPP-296 widget list totals are multiplied by the number of items', async ({ page }) => {
  const p = await inAppProject('inapp-296');
  const { widget, items } = await widgetWith(p, { name: 'Hero' }, [{ title: 'Slide 1' }, { title: 'Slide 2' }, { title: 'Slide 3' }], 'active');
  const ip = newClientIp();
  for (let i = 0; i < 2; i++) dataOf(await sdkRequest('GET', `/api/in-app-banners/serve/${widget.id}`, { apiKey: p.sdkKey, ip }));
  await expect.poll(async () => (await widgetEventRows(widget.id)).filter((e) => e.event_type === 'impression').length).toBe(6);
  for (let i = 0; i < 2; i++) dataOf(await sdkRequest('POST', `/api/in-app-banners/${items[0].id}/click`, { apiKey: p.sdkKey, ip }));
  await expect.poll(async () => (await widgetEventRows(widget.id)).filter((e) => e.event_type === 'click').length).toBe(2);

  // The summary counts the events themselves.
  const summary = dataOf(await call('GET', `/api/banner-categories/${widget.id}/analytics`, p.owner));
  expect(summary).toMatchObject({ totalImpressions: 6, totalClicks: 2, uniqueVisitors: 1 });
  expect(summary.ctr).toBeCloseTo(2 / 6, 6);

  // Expected (current code): the list multiplies every event by the number of items.
  const listOf = async () => dataOf<Array<Record<string, any>>>(await call('GET', `/api/projects/${p.project.id}/banner-categories`, p.owner));
  expect((await listOf()).find((c) => c.id === widget.id)).toMatchObject({ totalImpressions: 18, totalClicks: 6, bannerCount: 3 });

  // Variant: one of three slides off; two serves make 4 events for the 2 live slides.
  const { widget: partly } = await widgetWith(
    p,
    { name: 'Hero partly off' },
    [{ title: 'Live 1' }, { title: 'Live 2' }, { title: 'Off', isActive: false }],
    'active',
  );
  for (let i = 0; i < 2; i++) dataOf(await sdkRequest('GET', `/api/in-app-banners/serve/${partly.id}`, { apiKey: p.sdkKey, ip }));
  await expect.poll(async () => (await widgetEventRows(partly.id)).length).toBe(4);
  expect((await listOf()).find((c) => c.id === partly.id)).toMatchObject({ totalImpressions: 12, totalClicks: 0, bannerCount: 3 });

  await signIn(page, p.owner);
  await openWidgets(page, p.project.id, 'carousels', 'Carousels');
  const row = widgetListRow(page, 'Hero');
  await expect(row.getByRole('cell').nth(2)).toHaveText('3 slides');
  await expect(row.getByRole('cell').nth(4)).toHaveText('18');
  await expect(row.getByRole('cell').nth(5)).toHaveText('6');
  await row.click();
  const expanded = expandedPart(page, widget.id);
  await expect(widgetRowStat(expanded, 'Impressions')).toHaveText('18');
  await expect(widgetRowStat(expanded, 'Clicks')).toHaveText('6');
  // The CTR comes from the summary (2 of 6), so it does not match the cards beside it.
  await expect(widgetRowStat(expanded, 'CTR')).toHaveText('33.3%');
  await expect(widgetRowStat(expanded, 'Unique Visitors')).toHaveText('1');

  const partlyRow = widgetListRow(page, 'Hero partly off');
  await expect(partlyRow.getByRole('cell').nth(4)).toHaveText('12');
  await expect(partlyRow.getByRole('cell').nth(5)).toHaveText('0');
});

test('INAPP-297 image story saves a CTA with no click URL', async ({ page }) => {
  const p = await inAppProject('inapp-297');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/stories/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'New Story', exact: true })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await page.getByLabel('Name').fill('CTA only');
  await page.getByLabel('Image URL').fill('https://example.com/s.png');
  await page.getByLabel('CTA Text').fill('Shop Now');
  await expect(page.locator('label[for="click-url"]')).toHaveText('Click URL *');
  await expect(page.getByLabel('Click URL')).toHaveValue('');

  // Expected (current code): Create is enabled although the label marks Click URL required.
  await expect(create).toBeEnabled();
  const posted = page.waitForResponse(isItemPost);
  await create.click();
  const response = await posted;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).not.toHaveProperty('clickUrl');
  await expect(toastWithTitle(page, 'Story created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/stories$`));

  const [category] = await widgetRows(p.project.id);
  expect(category).toMatchObject({ name: 'CTA only', layout: 'stories', status: 'draft' });
  const banners = dataOf<Array<Record<string, any>>>(await call('GET', `/api/banner-categories/${category.id}/banners`, p.owner));
  expect(banners).toHaveLength(1);
  expect(banners[0]).toMatchObject({ title: 'CTA only', ctaText: 'Shop Now', clickUrl: null });

  await setWidgetStatus(p.owner, category.id, 'active');
  const served = dataOf(await serveWidget(category.id, p.sdkKey));
  expect(served.banners).toHaveLength(1);
  expect(served.banners[0]).toMatchObject({ ctaText: 'Shop Now', clickUrl: null });
});

// ------------------------------------------------------------ Status, edits and audiences ---

test('INAPP-298 PATCH to active skips the title check that /activate has', async () => {
  const p = await inAppProject('inapp-298');
  const device = await identifyDevice(p, {}, 'fp-d1');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'No title', messageType: 'modal', title: '' });

  // Expected (current code): PATCH moves it to active with no title.
  const patched = await call('PATCH', `${MESSAGES(p.project.id)}/${message.id}`, p.owner, { status: 'active' });
  expect(patched.status).toBe(200);
  expect(dataOf(patched)).toMatchObject({ status: 'active', title: '' });
  const entries = await activityRows(p.project.id, 'in_app_message.activated');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ target_id: message.id, target_label: 'No title', actor_user_id: p.owner.userId });

  const checked = dataOf(await sdkCall('/api/messages/check', p.sdkKey, {
    projectId: p.project.id,
    deviceFingerprint: device.fingerprint,
    context: { platform: 'ios' },
  }));
  expect(checked.messages.map((m: { id: string; title: string }) => [m.id, m.title])).toEqual([[message.id, '']]);

  // The activate route refuses the same thing.
  const other = await createInAppMessage(p.owner, p.project.id, { name: 'No title either', title: '' });
  const refused = await call('POST', `${MESSAGES(p.project.id)}/${other.id}/activate`, p.owner);
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toBe('Message must have a title before activation');
  expect((await messageRow(other.id))?.status).toBe('draft');
  expect(await activityRows(p.project.id, 'in_app_message.activated')).toHaveLength(1);
});

test('INAPP-300 clearing body, image, event, cohort and tags on edit does not clear them', async ({ page }) => {
  const p = await inAppProject('inapp-300');
  const device = await identifyDevice(p, {}, 'fp-d1');
  const cohortId = await seedCohort(p.project.id, 'C1', [{ deviceIdentityId: device.id, resolved: true }]);
  const image = 'https://example.com/a.png';
  const message = await createInAppMessage(p.owner, p.project.id, {
    name: 'Full message',
    body: 'Save 20%',
    imageUrl: image,
    triggerType: 'on_event',
    triggerEvent: 'checkout',
    userType: 'cohort',
    mixpanelCohortId: cohortId,
    tags: ['promo'],
  });
  const kept = { body: 'Save 20%', imageUrl: image, triggerEvent: 'checkout', mixpanelCohortId: cohortId, tags: ['promo'] };

  await signIn(page, p.owner);
  await openEditEditor(page, p.project.id, message.id);
  await expect(editorField(page, 'Body')).toHaveValue('Save 20%');
  await editorField(page, 'Body').fill('');
  await editorField(page, 'Image URL').fill('');
  await stepPill(page, 2, 'Trigger').click();
  await expect(editorField(page, 'Event Name')).toHaveValue('checkout');
  await editorField(page, 'Event Name').fill('');
  await stepPill(page, 3, 'Users').click();
  await expect(editorField(page, 'Mixpanel Cohort ID')).toHaveValue(cohortId);
  await editorField(page, 'Mixpanel Cohort ID').fill('');
  await stepPill(page, 4, 'Schedule & Limits').click();
  const tags = page.getByPlaceholder('onboarding, promo, seasonal');
  await expect(tags).toHaveValue('promo');
  await tags.fill('');

  const patched = updatePatched(page, p.project.id, message.id);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  const response = await patched;
  expect(response.status()).toBe(200);
  const sent = response.request().postDataJSON();
  for (const key of Object.keys(kept)) expect(sent, key).not.toHaveProperty(key);
  await expect(toastWithTitle(page, 'Campaign updated')).toBeVisible();

  // Expected (current code): every cleared value is still stored.
  expect(await getMessage(p, message.id)).toMatchObject(kept);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Campaign', exact: true })).toBeVisible();
  await expect(editorField(page, 'Body')).toHaveValue('Save 20%');
  await expect(editorField(page, 'Image URL')).toHaveValue(image);
  // The live preview still holds the image.
  await expect(page.locator(`img[src="${image}"]`).first()).toBeAttached();
  await stepPill(page, 2, 'Trigger').click();
  await expect(editorField(page, 'Event Name')).toHaveValue('checkout');
  await stepPill(page, 3, 'Users').click();
  await expect(editorField(page, 'Mixpanel Cohort ID')).toHaveValue(cohortId);
  await stepPill(page, 4, 'Schedule & Limits').click();
  await expect(tags).toHaveValue('promo');

  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  const preview = cardTitled(page, 'Message Preview');
  await expect(preview.locator(`img[src="${image}"]`)).toHaveCount(1);
  await expect(preview.getByText('Save 20%', { exact: true })).toBeVisible();
});

test('INAPP-302 cohort audience with no cohort ID reaches nobody', async ({ page }) => {
  const p = await inAppProject('inapp-302');
  const d1 = await identifyDevice(p, {}, 'fp-d1');
  const d5 = await identifyDevice(p, {}, 'fp-d5');
  const cohortId = await seedCohort(p.project.id, 'C1', [{ deviceIdentityId: d1.id, resolved: true }]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'New Campaign', exact: true })).toBeVisible();
  await editorField(page, 'Campaign Name').fill('Empty cohort');
  await editorField(page, 'Title *').fill('For a cohort');
  await stepPill(page, 3, 'Users').click();
  await editorChoice(page, 'Mixpanel Cohort').click();
  await expect(editorField(page, 'Mixpanel Cohort ID')).toHaveValue('');
  const posted = createPosted(page, p.project.id);
  await page.getByRole('button', { name: 'Save Campaign', exact: true }).first().click();
  const created = await posted;
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id as string;
  await page.waitForURL(new RegExp(`/in-app-messages/${id}$`));
  // Expected (current code): saved with no cohort and no warning.
  expect(await getMessage(p, id)).toMatchObject({ userType: 'cohort', mixpanelCohortId: null, status: 'draft' });

  await openInAppList(page, p.project.id);
  const activated = apiResponse(page, 'POST', `/in-app-messages/${id}/activate`);
  await rowMenuItem(page, 'Empty cohort', 'Activate');
  expect((await activated).status()).toBe(201);
  await expect(campaignRow(page, 'Empty cohort').getByText('Active', { exact: true })).toBeVisible();

  // Positive control: the same audience with the cohort's id reaches its member.
  const control = await messageIn(p.owner, p.project.id, 'active', { name: 'With cohort', userType: 'cohort', mixpanelCohortId: cohortId });
  expect(await deliveredIds(p, d1.fingerprint)).toEqual([control.id]);
  expect(await deliveredIds(p, d5.fingerprint)).toEqual([]);
});

test('INAPP-303 cohort ID that is not a cohort of this project is accepted and withholds the message', async () => {
  const p = await inAppProject('inapp-303');
  const other = await inAppProject('inapp-303-other', p.owner);
  const fp = fingerprint('fp-d1');
  const d1 = await identifyDevice(p, { deviceFingerprint: fp });
  const d1Other = await identifyDevice(other, { deviceFingerprint: fp });
  const c1 = await seedCohort(p.project.id, 'C1', [{ deviceIdentityId: d1.id, resolved: true }]);
  const cOther = await seedCohort(other.project.id, 'C-other', [{ deviceIdentityId: d1Other.id, resolved: true }]);

  const made = [];
  for (const mixpanelCohortId of [randomUUID(), cOther]) {
    const created = await call('POST', MESSAGES(p.project.id), p.owner, {
      name: `Cohort ${mixpanelCohortId.slice(0, 8)}`,
      messageType: 'modal',
      title: 'Hello',
      userType: 'cohort',
      mixpanelCohortId,
    });
    expect(created.status, mixpanelCohortId).toBe(201);
    made.push(dataOf(await call('POST', `${MESSAGES(p.project.id)}/${created.body.data.id}/activate`, p.owner)).id as string);
  }

  // Controls: the project's own cohort reaches D1 in P, and C-other reaches D1 in its own project.
  const control = await messageIn(p.owner, p.project.id, 'active', { name: 'Own cohort', userType: 'cohort', mixpanelCohortId: c1 });
  const otherControl = await messageIn(p.owner, other.project.id, 'active', { name: 'Other cohort', userType: 'cohort', mixpanelCohortId: cOther });
  const delivered = await deliveredIds(p, fp);
  expect(delivered).toEqual([control.id]);
  for (const id of made) expect(delivered).not.toContain(id);
  expect(await deliveredIds(other, fp)).toEqual([otherControl.id]);
  expect(await deliveredIds(p, fingerprint('fp-d5'))).toEqual([]);
});

test('INAPP-304 a specific_users message reaches everyone', async () => {
  const p = await inAppProject('inapp-304');
  const d1 = await identifyDevice(p, {}, 'fp-d1');
  const d5 = await identifyDevice(p, {}, 'fp-d5');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Specific nobody', userType: 'specific_users' });
  expect((await messageRow(message.id))?.user_filters).toBeNull();

  // Expected (current code): everyone gets it, as with `all`.
  for (const fp of [fingerprint('fp-unknown'), d1.fingerprint, d5.fingerprint]) {
    expect(await deliveredIds(p, fp), fp).toEqual([message.id]);
  }

  const android = await messageIn(p.owner, p.project.id, 'active', {
    name: 'Specific android',
    userType: 'specific_users',
    userFilters: { platforms: ['android'] },
  });
  expect(await deliveredIdsWith(p, d1.fingerprint, { platform: 'android' })).toContain(android.id);
  expect(await deliveredIdsWith(p, d1.fingerprint, { platform: 'ios' })).not.toContain(android.id);
  expect(await deliveredIdsWith(p, d1.fingerprint, { platform: 'ios' })).toContain(message.id);
});

test('INAPP-305 frequency caps count per device fingerprint, not per person', async () => {
  const p = await inAppProject('inapp-305');
  const d1 = await identifyDevice(p, { distinctId: 'user-42' }, 'fp-d1');
  const d2 = await identifyDevice(p, { distinctId: 'user-42' }, 'fp-d2');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Once per user', maxImpressionsPerUser: 1 });
  const check = (fp: string) =>
    sdkCall('/api/messages/check', p.sdkKey, { projectId: p.project.id, deviceFingerprint: fp, distinctId: 'user-42', context: { platform: 'ios' } });
  const ids = async (fp: string) => dataOf(await check(fp)).messages.map((m: { id: string }) => m.id);
  expect(await ids(d1.fingerprint)).toEqual([message.id]);

  dataOf(await recordInAppEvent(p, { messageId: message.id, deviceFingerprint: d1.fingerprint, distinctId: 'user-42', eventType: 'impression' }));
  expect(await ids(d1.fingerprint)).toEqual([]);
  // Expected (current code): the same person on another device sees it again.
  expect(await ids(d2.fingerprint)).toEqual([message.id]);

  const noDevice = await sdkCall('/api/messages/check', p.sdkKey, { projectId: p.project.id, distinctId: 'user-42', context: { platform: 'ios' } });
  expect(noDevice.status).toBe(400);
  expect(messageOf(noDevice)).toContain('deviceFingerprint must be a string');
});

test('INAPP-306 segment targeting of an anonymous identified device', async () => {
  const p = await inAppProject('inapp-306');
  const d6 = await identifyDevice(p, { traits: { plan: 'gold' } }, 'fp-d6');
  const d5 = await identifyDevice(p, { traits: { plan: 'free' } }, 'fp-d5');
  const segmentId = await traitSegment(p.owner, p.project.id, 'plan', 'gold');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Gold offer' });
  dataOf(await call('PATCH', `${MESSAGES(p.project.id)}/${message.id}`, p.owner, { userType: 'segment', segmentId, status: 'active' }));
  const [row] = await sql(`SELECT external_user_id FROM device_identities WHERE id = $1`, [d6.id]);
  expect(row.external_user_id).toBeNull();

  expect(await deliveredIds(p, d6.fingerprint)).toEqual([message.id]);
  expect(await deliveredIds(p, d5.fingerprint)).toEqual([]);
  const line = `No identity resolved for segment-targeted message ${message.id}`;
  expect(apiLogText()).not.toContain(line);
  expect(await deliveredIds(p, fingerprint('fp-never'))).toEqual([]);
  await expect.poll(() => apiLogText().includes(line)).toBe(true);
});

// ------------------------------------------------------------ Trigger queue ---

test('INAPP-308 a campaign that is also queued is returned twice', async () => {
  const p = await inAppProject('inapp-308');
  const d1 = await identifyDevice(p, {}, 'fp-d1');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Twice' });
  expect((await messageRow(message.id))?.trigger_type).toBe('on_app_open');
  expect(await deliveredWithRepeats(p, d1.fingerprint)).toEqual([message.id]);

  const { queued } = dataOf(await call('POST', `${MESSAGES(p.project.id)}/trigger`, p.owner, { messageId: message.id, targetType: 'all' }));
  expect(queued).toBe(1);
  // Expected (current code): once from the queue and once from the campaign.
  expect(await deliveredWithRepeats(p, d1.fingerprint)).toEqual([message.id, message.id]);

  dataOf(await recordInAppEvent(p, { messageId: message.id, deviceFingerprint: d1.fingerprint, eventType: 'impression' }));
  expect((await pendingRows(message.id)).map((r) => r.status)).toEqual(['delivered']);
  expect(await deliveredWithRepeats(p, d1.fingerprint)).toEqual([message.id]);
});

test('INAPP-309 trigger with an over-long fingerprint fails after logging', async () => {
  const p = await inAppProject('inapp-309');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Long print' });
  const trigger = (deviceFingerprints: string[]) =>
    call('POST', `${MESSAGES(p.project.id)}/trigger`, p.owner, { messageId: message.id, targetType: 'users', deviceFingerprints });
  const triggered = async () => (await activityRows(p.project.id, 'in_app.triggered')).filter((e) => e.target_id === message.id);
  expect(await triggered()).toHaveLength(0);

  // Expected (current code): a 500, no pending row, and the entry already written.
  const failed = await trigger(['a'.repeat(256)]);
  expect(failed.status).toBe(500);
  expect(messageOf(failed)).toBe('Internal server error');
  expect(await pendingRows(message.id)).toHaveLength(0);
  expect(await triggered()).toHaveLength(1);

  const ok = await trigger(['a'.repeat(255)]);
  expect(dataOf(ok)).toEqual({ queued: 1 });
  expect(await pendingRows(message.id)).toHaveLength(1);
  expect(await triggered()).toHaveLength(2);
});

test('INAPP-311 trigger to more than 500 devices', async ({ page }) => {
  const p = await inAppProject('inapp-311');
  const fingerprints = await insertDevices(p.project.id, 1201);
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Big audience', triggerType: 'immediate' });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Trigger Message Now' });
  await dialog.getByRole('button', { name: 'All Users', exact: true }).click();
  await expect(toastWithTitle(page, 'Queued for 1201 devices')).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toHaveCount(0);

  const rows = await pendingRows(message.id);
  expect(rows).toHaveLength(1201);
  expect(new Set(rows.map((r) => r.device_fingerprint))).toEqual(new Set(fingerprints));
  const entries = await activityRows(p.project.id, 'in_app.triggered');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ target_id: message.id });
});

test('INAPP-313 double click on All Users triggers twice', async ({ page }) => {
  const p = await inAppProject('inapp-313');
  for (const label of ['fp-d1', 'fp-d2', 'fp-d3']) await identifyDevice(p, {}, label);
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Double trigger', triggerType: 'immediate' });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  const posts: string[] = [];
  await page.route('**/in-app-messages/trigger', async (route) => {
    posts.push(route.request().method());
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Trigger Message Now' });
  await dialog.getByRole('button', { name: 'All Users', exact: true }).dblclick();

  // Expected (current code): two requests, two toasts, six queued rows, two entries.
  await expect(toastWithTitle(page, 'Queued for 3 devices')).toHaveCount(2, { timeout: 10_000 });
  expect(posts).toEqual(['POST', 'POST']);
  await expect(dialog).toHaveCount(0);
  expect(await pendingRows(message.id)).toHaveLength(6);
  expect(await activityRows(p.project.id, 'in_app.triggered')).toHaveLength(2);
});

// ------------------------------------------------------------ Detail page and list ---

test('INAPP-314 activate failure on the detail page is silent', async ({ page }) => {
  const p = await inAppProject('inapp-314');
  const draft = await createInAppMessage(p.owner, p.project.id, { name: 'Untitled draft', title: '' });
  const live = await messageIn(p.owner, p.project.id, 'active', { name: 'Live campaign' });
  await signIn(page, p.owner);
  const errors = collectPageErrors(page);
  const triggerFailed = await failRequests(page, (method, pathname) => method === 'POST' && pathname.endsWith('/in-app-messages/trigger'));
  // The control: a trigger that fails, which the page does report. Its toast, shown
  // after the failure under test, is then the only one on screen.
  const failTrigger = async () => {
    const before = triggerFailed.length;
    await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Trigger Message Now' });
    await dialog.getByRole('button', { name: 'All Users', exact: true }).click();
    await expect.poll(() => triggerFailed.length).toBe(before + 1);
    await expect(toastWithTitle(page, 'Failed to trigger')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };

  await page.goto(`/projects/${p.project.id}/in-app-messages/${draft.id}`);
  await expect(detailBadge(page, 'Untitled draft').getByText('Draft', { exact: true })).toBeVisible();
  const refused = apiResponse(page, 'POST', `/in-app-messages/${draft.id}/activate`);
  await page.getByRole('button', { name: 'Activate', exact: true }).click();
  const response = await refused;
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toBe('Message must have a title before activation');
  // Expected (current code): an unhandled rejection and nothing on the page.
  await expect.poll(() => errors.length).toBeGreaterThan(0);
  expect(errors.join('\n')).toContain('status code 400');
  await failTrigger();
  await expect(toastTitles(page)).resolves.toEqual(['Failed to trigger']);
  await expect(detailBadge(page, 'Untitled draft').getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate', exact: true })).toBeVisible();
  expect((await messageRow(draft.id))?.status).toBe('draft');

  // The same for Pause when its request fails.
  errors.length = 0;
  const failed = await failRequests(page, (method, pathname) => method === 'POST' && pathname.endsWith(`/in-app-messages/${live.id}/pause`));
  await page.goto(`/projects/${p.project.id}/in-app-messages/${live.id}`);
  await expect(detailBadge(page, 'Live campaign').getByText('Active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => failed.length).toBe(1);
  await expect.poll(() => errors.length).toBeGreaterThan(0);
  expect(errors.join('\n')).toContain('status code 500');
  await failTrigger();
  await expect(toastTitles(page)).resolves.toEqual(['Failed to trigger']);
  await expect(detailBadge(page, 'Live campaign').getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect((await messageRow(live.id))?.status).toBe('active');
  expect(errors).toHaveLength(1);
  expect(await pendingRows(draft.id)).toHaveLength(0);
});

test('INAPP-317 list row menu Edit opens the editor', async ({ page }) => {
  const p = await inAppProject('inapp-317');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Spring sale' });
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  const listUrl = page.url();
  const visits: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visits.push(new URL(frame.url()).pathname);
  });

  await campaignRow(page, 'Spring sale').getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages/${message.id}/edit$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Campaign', exact: true })).toBeVisible();
  await expect(editorField(page, 'Campaign Name')).toHaveValue('Spring sale');
  expect(visits).not.toContain(`/projects/${p.project.id}/in-app-messages/${message.id}`);

  await page.goBack();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByRole('heading', { name: 'In-App Messages', exact: true })).toBeVisible();
});

// ------------------------------------------------------------ Widget items ---

test('INAPP-322 a new item collides on sort order after a delete', async ({ page }) => {
  const p = await inAppProject('inapp-322');
  const { widget, items } = await widgetWith(p, { name: 'Gapped carousel' }, [{ title: 'Item A' }, { title: 'Item B' }, { title: 'Item C' }], 'active');
  const [a, , c] = items.map((i) => i.id);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await expect(itemTitlesShown(page)).toHaveText(['Item A', 'Item B', 'Item C']);

  page.once('dialog', (dialog) => dialog.accept());
  const deleted = apiResponse(page, 'DELETE', `/api/in-app-banners/${items[1].id}`);
  await widgetItemCard(page, 'Item B').getByRole('button').nth(4).click();
  expect((await deleted).status()).toBe(200);
  await expect(page.getByRole('tab', { name: 'Items (2)' })).toBeVisible();

  await page.getByRole('button', { name: 'Add Item', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Item' });
  await dialogField(dialog, 'Title *').fill('Item D');
  await dialogField(dialog, 'Image URL *').fill('https://example.com/d.png');
  await dialogField(dialog, 'Click URL *').fill('https://example.com/d');
  const posted = page.waitForResponse(isItemPost);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  const response = await posted;
  expect(response.status()).toBe(201);
  // Expected (current code): the next sort order is the item count, which C already holds.
  expect(response.request().postDataJSON().sortOrder).toBe(2);
  const d = (await response.json()).data.id as string;
  await expect(page.getByRole('tab', { name: 'Items (3)' })).toBeVisible();

  const banners = dataOf<Array<{ id: string; sortOrder: number }>>(await call('GET', `/api/banner-categories/${widget.id}/banners`, p.owner));
  expect(banners.map((b) => [b.id, b.sortOrder])).toEqual([[a, 0], [d, 2], [c, 2]]);
  await expect(itemTitlesShown(page)).toHaveText(['Item A', 'Item D', 'Item C']);
  const served = dataOf(await serveWidget(widget.id, p.sdkKey));
  expect(served.banners[0].title).toBe('Item A');
  expect(served.banners.slice(1).map((b: { title: string }) => b.title).sort()).toEqual(['Item C', 'Item D']);

  const reorderPath = `/api/banner-categories/${widget.id}/banners/reorder`;
  const sortOf = (json: { items: Array<{ id: string; sortOrder: number }> }) => Object.fromEntries(json.items.map((i) => [i.id, i.sortOrder]));
  let sent = apiResponse(page, 'PATCH', reorderPath);
  await widgetItemCard(page, 'Item D').getByRole('button', { name: 'Move down' }).click();
  expect(sortOf((await sent).request().postDataJSON())).toEqual({ [a]: 0, [d]: 2, [c]: 2 });
  await expect(itemTitlesShown(page)).toHaveText(['Item A', 'Item D', 'Item C']);
  sent = apiResponse(page, 'PATCH', reorderPath);
  await widgetItemCard(page, 'Item C').getByRole('button', { name: 'Move up' }).click();
  expect(sortOf((await sent).request().postDataJSON())).toEqual({ [a]: 0, [d]: 2, [c]: 2 });
  await expect(itemTitlesShown(page)).toHaveText(['Item A', 'Item D', 'Item C']);
  expect((await widgetItemRows(widget.id)).map((r) => [r.title, r.sort_order])).toEqual(
    expect.arrayContaining([['Item A', 0], ['Item C', 2], ['Item D', 2]]),
  );
});

test('INAPP-323 item edit: clearing CTA or dates keeps the old values', async ({ page }) => {
  const p = await inAppProject('inapp-323');
  // Both dates today, so the pickers open on their month.
  const startsAt = iso(-MINUTE);
  const expiresAt = iso(2 * MINUTE);
  const { widget, items } = await widgetWith(p, { name: 'Dated carousel' }, [{ title: 'Dated slide', ctaText: 'Buy', startsAt, expiresAt }]);
  const stories = await widgetWith(p, { name: 'Linked stories', layout: 'stories' }, [
    { title: 'Linked story', ctaText: 'Go', clickUrl: 'https://example.com/story-offer', metadata: { storyType: 'image' } },
  ]);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  const card = widgetItemCard(page, 'Dated slide');
  await expect(card.getByText(/^From: .* · Until: .*$/)).toBeVisible();
  await card.getByRole('button').nth(3).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Banner' });
  await expect(dialogField(dialog, 'CTA Text')).toHaveValue('Buy');
  await dialogField(dialog, 'CTA Text').fill('');
  await clearPickedDate(page, picker(dialog, 'Start Date'));
  await clearPickedDate(page, picker(dialog, 'End Date'));
  await expect(picker(dialog, 'Start Date')).toHaveText('Select start');
  await expect(picker(dialog, 'End Date')).toHaveText('Select end');

  const patched = apiResponse(page, 'PATCH', `/api/in-app-banners/${items[0].id}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await patched;
  expect(response.status()).toBe(200);
  const sent = response.request().postDataJSON();
  for (const key of ['ctaText', 'startsAt', 'expiresAt']) expect(sent, key).not.toHaveProperty(key);
  await expect(toastWithTitle(page, 'Banner updated')).toBeVisible();

  // Expected (current code): the old values stay.
  const stored = await getItem(p, items[0].id);
  expect(stored.ctaText).toBe('Buy');
  expect(new Date(stored.startsAt).getTime()).toBe(new Date(startsAt).getTime());
  expect(new Date(stored.expiresAt).getTime()).toBe(new Date(expiresAt).getTime());
  await expect(card.getByText(/^From: .* · Until: .*$/)).toBeVisible();

  // A story's Click URL: cleared (then its CTA, which the Click URL needs), still kept.
  await page.goto(`/projects/${p.project.id}/widgets/stories/${stories.widget.id}`);
  await widgetItemCard(page, 'Linked story').getByRole('button').nth(3).click();
  const storyDialog = page.getByRole('dialog', { name: 'Image Story' });
  await expect(dialogField(storyDialog, 'Click URL *')).toHaveValue('https://example.com/story-offer');
  await dialogField(storyDialog, 'Click URL *').fill('');
  await dialogField(storyDialog, 'CTA Text (optional)').fill('');
  const storyPatched = apiResponse(page, 'PATCH', `/api/in-app-banners/${stories.items[0].id}`);
  await storyDialog.getByRole('button', { name: 'Save', exact: true }).click();
  const storyResponse = await storyPatched;
  expect(storyResponse.status()).toBe(200);
  expect(storyResponse.request().postDataJSON()).not.toHaveProperty('clickUrl');
  await expect(toastWithTitle(page, 'Story updated')).toBeVisible();
  expect(await getItem(p, stories.items[0].id)).toMatchObject({ clickUrl: 'https://example.com/story-offer', ctaText: 'Go' });
});

test('INAPP-324 item edit: clearing one UTM value removes it, clearing all keeps all', async ({ page }) => {
  const p = await inAppProject('inapp-324');
  const both = { utm_source: 'app', utm_medium: 'banner' };
  const { widget, items } = await widgetWith(p, { name: 'Tagged carousel' }, [{ title: 'Tagged slide', metadata: both }]);
  const stories = await widgetWith(p, { name: 'Tagged stories', layout: 'stories' }, [
    { title: 'Tagged story', metadata: { storyType: 'image', ...both } },
  ]);
  await signIn(page, p.owner);
  // A story's edit dialog is titled by its story type.
  const editAndSave = async (title: string, id: string, clear: string[], dialogTitle = 'Edit Banner') => {
    await widgetItemCard(page, title).getByRole('button').nth(3).click();
    const dialog = page.getByRole('dialog', { name: dialogTitle });
    await expect(dialogField(dialog, 'Source')).toHaveValue('app');
    for (const label of clear) await dialogField(dialog, label).fill('');
    const patched = apiResponse(page, 'PATCH', `/api/in-app-banners/${id}`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await patched;
    expect(response.status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    return response.request().postDataJSON();
  };

  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  const one = await editAndSave('Tagged slide', items[0].id, ['Source']);
  expect(one.metadata).toEqual({ utm_medium: 'banner' });
  expect((await getItem(p, items[0].id)).metadata).toEqual({ utm_medium: 'banner' });

  dataOf(await call('PATCH', `/api/in-app-banners/${items[0].id}`, p.owner, { metadata: both }));
  await page.reload();
  const all = await editAndSave('Tagged slide', items[0].id, ['Source', 'Medium']);
  // Expected (current code): no metadata is sent, so both values stay.
  expect(all).not.toHaveProperty('metadata');
  expect((await getItem(p, items[0].id)).metadata).toEqual(both);

  // A story always sends its metadata, so clearing every UTM value removes them.
  await page.goto(`/projects/${p.project.id}/widgets/stories/${stories.widget.id}`);
  const story = await editAndSave('Tagged story', stories.items[0].id, ['Source', 'Medium'], 'Image Story');
  expect(story.metadata).toEqual({ storyType: 'image' });
  expect((await getItem(p, stories.items[0].id)).metadata).toEqual({ storyType: 'image' });
});

test('INAPP-327 item toggle, delete and reorder failures are silent', async ({ page }) => {
  const p = await inAppProject('inapp-327');
  const { widget, items } = await widgetWith(p, { name: 'Fragile carousel' }, [{ title: 'Item A' }, { title: 'Item B' }]);
  const single = await widgetWith(p, { name: 'Fragile banner', layout: 'single' }, [{ title: 'Only banner' }]);
  const before = { carousel: await widgetItemRows(widget.id), single: await widgetItemRows(single.widget.id) };
  await signIn(page, p.owner);
  const errors = collectPageErrors(page);
  const failed = await failRequests(
    page,
    (method, pathname) =>
      (['PATCH', 'DELETE'].includes(method) && /^\/api\/in-app-banners\/[0-9a-f-]{36}$/.test(pathname)) ||
      (method === 'PATCH' && /^\/api\/banner-categories\/[0-9a-f-]{36}\/banners\/reorder$/.test(pathname)),
  );
  const statusFailed = await failRequests(page, (method, pathname) => method === 'PATCH' && /^\/api\/banner-categories\/[0-9a-f-]{36}\/status$/.test(pathname));
  // The control: a status change that fails, which the page does report.
  const failStatusChange = async (widgetId: string) => {
    const before = statusFailed.length;
    await page.getByRole('combobox').filter({ hasText: 'Draft' }).click();
    await page.getByRole('option', { name: 'Active', exact: true }).click();
    await expect.poll(() => statusFailed.length).toBe(before + 1);
    expect(statusFailed.at(-1)).toBe(`PATCH /api/banner-categories/${widgetId}/status`);
    await expect(toastWithTitle(page, 'Failed to update status')).toBeVisible();
  };

  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await expect(itemTitlesShown(page)).toHaveText(['Item A', 'Item B']);
  const switchA = widgetItemCard(page, 'Item A').getByRole('switch');
  await expect(switchA).toBeChecked();
  await switchA.click();
  await expect.poll(() => failed.length).toBe(1);
  await widgetItemCard(page, 'Item A').getByRole('button', { name: 'Move down' }).click();
  await expect.poll(() => failed.length).toBe(2);
  page.once('dialog', (dialog) => dialog.accept());
  await widgetItemCard(page, 'Item B').getByRole('button').nth(4).click();
  await expect.poll(() => failed.length).toBe(3);
  // Expected (current code): nothing says any of them failed. Only the status select
  // reports its failure, so its toast, shown after the three, is the only one on screen.
  await failStatusChange(widget.id);
  await expect(toastTitles(page)).resolves.toEqual(['Failed to update status']);
  await expect(switchA).toBeChecked();
  await expect(itemTitlesShown(page)).toHaveText(['Item A', 'Item B']);

  await page.goto(`/projects/${p.project.id}/widgets/banners/${single.widget.id}`);
  await expect(page.getByRole('heading', { level: 3, name: 'Only banner', exact: true })).toBeVisible();
  const toggle = page.getByRole('switch');
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect.poll(() => failed.length).toBe(4);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => failed.length).toBe(5);
  await failStatusChange(single.widget.id);
  await expect(toastTitles(page)).resolves.toEqual(['Failed to update status']);
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('heading', { level: 3, name: 'Only banner', exact: true })).toBeVisible();

  expect(errors).toEqual([]);
  expect(failed.map((f) => f.split(' ')[0])).toEqual(['PATCH', 'PATCH', 'DELETE', 'PATCH', 'DELETE']);
  expect(await widgetItemRows(widget.id)).toEqual(before.carousel);
  expect(await widgetItemRows(single.widget.id)).toEqual(before.single);
  for (const id of [widget.id, single.widget.id]) expect((await widgetRow(id))?.status).toBe('draft');
});

test('INAPP-329 a single-layout widget with more than one banner', async ({ page }) => {
  const p = await inAppProject('inapp-329');
  const { widget, items } = await widgetWith(p, { name: 'Two banner widget', layout: 'single', aspectRatio: '16:9' }, [
    { title: 'Banner B1', imageUrl: 'https://example.com/b1.png' },
  ], 'active');
  const b2 = await createWidgetItem(p.owner, widget.id, { title: 'Banner B2', imageUrl: 'https://example.com/b2.png', clickUrl: 'https://example.com/b2', sortOrder: 1 });
  const b2Before = await widgetItemRow(b2.id);
  const carousel = await widgetWith(p, { name: 'Former carousel', aspectRatio: '4:3' }, [{ title: 'First slide' }, { title: 'Second slide' }]);
  dataOf(await call('PATCH', `/api/banner-categories/${carousel.widget.id}`, p.owner, { layout: 'single' }));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/${widget.id}`);
  await expect(page.getByRole('heading', { level: 3, name: 'Banner B1', exact: true })).toBeVisible();
  await expect(page.getByText('Banner B2')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);

  await page.goto(`/projects/${p.project.id}/widgets/banners/${widget.id}/edit`);
  await expect(page.getByLabel('Image URL')).toHaveValue('https://example.com/b1.png');
  await page.getByLabel('Image URL').fill('https://example.com/b1-new.png');
  const patched = apiResponse(page, 'PATCH', /^\/api\/in-app-banners\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await patched;
  expect(new URL(response.url()).pathname).toBe(`/api/in-app-banners/${items[0].id}`);
  await expect(toastWithTitle(page, 'Banner updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/widgets/banners$`));
  // The editor's Name is the category's, so the first banner also takes it as its title.
  expect(await widgetItemRow(items[0].id)).toMatchObject({ image_url: 'https://example.com/b1-new.png', title: 'Two banner widget' });
  expect(await widgetItemRow(b2.id)).toEqual(b2Before);

  const served = dataOf(await serveWidget(widget.id, p.sdkKey));
  expect(served.banners.map((b: { id: string }) => b.id)).toEqual([items[0].id, b2.id]);

  // The former carousel is listed with the banners, with its ratio, and shows one slide.
  await expect(widgetListRow(page, 'Former carousel').getByRole('cell').nth(2)).toHaveText('4:3');
  await openWidgets(page, p.project.id, 'carousels', 'Carousels');
  await expect(page.getByText('Former carousel', { exact: true })).toHaveCount(0);
  await page.goto(`/projects/${p.project.id}/widgets/banners/${carousel.widget.id}`);
  await expect(page.getByRole('heading', { level: 3, name: 'First slide', exact: true })).toBeVisible();
  await expect(page.getByText('Second slide')).toHaveCount(0);
});

test('INAPP-330 editing a stories widget that holds several stories', async ({ page }) => {
  const p = await inAppProject('inapp-330');
  const textMeta = { storyType: 'text', storyText: 'Big news today', backgroundColor: '#6366f1', textColor: '#ffffff', duration: 7 };
  const week = await widgetWith(p, { name: 'Week stories', layout: 'stories', aspectRatio: '9:16' }, [
    { title: 'Big news today', imageUrl: undefined, clickUrl: undefined, metadata: textMeta },
    { title: 'Story two', metadata: { storyType: 'image' } },
    { title: 'Story three', metadata: { storyType: 'image' } },
  ]);
  const othersBefore = await Promise.all(week.items.slice(1).map((i) => widgetItemRow(i.id)));

  await signIn(page, p.owner);
  await openWidgets(page, p.project.id, 'stories', 'Stories');
  await widgetListRow(page, 'Week stories').click();
  await expandedPart(page, week.widget.id).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Story', exact: true })).toBeVisible();
  await expect(page.getByLabel('Story Text')).toHaveValue('Big news today');
  await page.getByLabel('Story Text').fill('Bigger news');
  const categoryPatched = apiResponse(page, 'PATCH', `/api/banner-categories/${week.widget.id}`);
  const itemPatched = apiResponse(page, 'PATCH', /^\/api\/in-app-banners\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await categoryPatched).request().postDataJSON()).toMatchObject({ name: 'Bigger news', aspectRatio: '9:16' });
  expect(new URL((await itemPatched).url()).pathname).toBe(`/api/in-app-banners/${week.items[0].id}`);
  await expect(toastWithTitle(page, 'Story updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/widgets/stories$`));

  expect(await widgetRow(week.widget.id)).toMatchObject({ name: 'Bigger news', aspect_ratio: '9:16' });
  const first = await getItem(p, week.items[0].id);
  expect(first.title).toBe('Bigger news');
  expect(first.metadata).toEqual({ storyType: 'text', storyText: 'Bigger news', backgroundColor: '#6366f1', textColor: '#ffffff' });
  expect(await Promise.all(week.items.slice(1).map((i) => widgetItemRow(i.id)))).toEqual(othersBefore);

  // An image story first: only its image changes in the form, and its title becomes the category's name.
  const cover = await widgetWith(p, { name: 'Image week', layout: 'stories', aspectRatio: '9:16' }, [
    { title: 'Cover', imageUrl: 'https://example.com/cover.png', metadata: { storyType: 'image', duration: 7 } },
    { title: 'Image two', metadata: { storyType: 'image' } },
    { title: 'Image three', metadata: { storyType: 'image' } },
  ]);
  const coverOthers = await Promise.all(cover.items.slice(1).map((i) => widgetItemRow(i.id)));
  await page.goto(`/projects/${p.project.id}/widgets/stories/${cover.widget.id}/edit`);
  await expect(page.getByLabel('Name')).toHaveValue('Image week');
  await expect(page.getByLabel('Image URL')).toHaveValue('https://example.com/cover.png');
  await page.getByLabel('Image URL').fill('https://example.com/cover-new.png');
  const coverPatched = apiResponse(page, 'PATCH', `/api/in-app-banners/${cover.items[0].id}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await coverPatched).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/widgets/stories$`));
  expect((await widgetRow(cover.widget.id))?.name).toBe('Image week');
  expect(await getItem(p, cover.items[0].id)).toMatchObject({
    title: 'Image week',
    imageUrl: 'https://example.com/cover-new.png',
    metadata: { storyType: 'image' },
  });
  expect((await getItem(p, cover.items[0].id)).metadata).not.toHaveProperty('duration');
  expect(await Promise.all(cover.items.slice(1).map((i) => widgetItemRow(i.id)))).toEqual(coverOthers);
});

test('INAPP-331 stories cannot be activated from any page the list links to', async ({ page }) => {
  const p = await inAppProject('inapp-331');
  // The two requests the editor's Create makes for an image story.
  const widget = await createWidget(p.owner, p.project.id, { name: 'Draft stories', layout: 'stories', aspectRatio: '9:16' });
  await createWidgetItem(p.owner, widget.id, { title: 'Draft stories', imageUrl: IMAGE, sortOrder: 0, metadata: { storyType: 'image' } });
  expect((await widgetRow(widget.id))?.status).toBe('draft');

  await signIn(page, p.owner);
  await openWidgets(page, p.project.id, 'stories', 'Stories');
  await widgetListRow(page, 'Draft stories').click();
  const expanded = expandedPart(page, widget.id);
  await expect(expanded.getByRole('button')).toHaveText(['7d', '30d', '90d', 'All time', 'Copy ID', 'Edit', 'Delete']);
  await expect(page.getByRole('combobox')).toHaveCount(0);

  await expanded.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Story', exact: true })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('Draft stories');
  // The editor's only select is the aspect ratio.
  await expect(page.getByRole('combobox')).toHaveCount(1);
  await expect(page.getByText('Status', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/widgets/stories$`));
  expect((await widgetRow(widget.id))?.status).toBe('draft');

  const refused = await serveWidget(widget.id, p.sdkKey);
  expect(refused.status).toBe(404);
  expect(messageOf(refused)).toBe(WIDGET_NOT_ACTIVE);

  await page.goto(`/projects/${p.project.id}/widgets/stories/${widget.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Draft stories', exact: true })).toBeVisible();
  const status = page.getByRole('combobox');
  await expect(status).toHaveText('Draft');
  const changed = apiResponse(page, 'PATCH', `/api/banner-categories/${widget.id}/status`);
  await status.click();
  await page.getByRole('option', { name: 'Active', exact: true }).click();
  expect((await changed).status()).toBe(200);
  await expect(status).toHaveText('Active');
  const served = dataOf(await serveWidget(widget.id, p.sdkKey));
  expect(served.banners.map((b: { title: string }) => b.title)).toEqual(['Draft stories']);
});

// ------------------------------------------------------------ Category API ---

test('INAPP-335 category update validation', async () => {
  const p = await inAppProject('inapp-335');
  const outsider = await inAppProject('inapp-335-other');
  const { widget } = await widgetWith(p, { name: 'Strict carousel' }, [{ title: 'Slide' }]);
  const before = await widgetRow(widget.id);
  const cases: Array<[Record<string, unknown>, number, string]> = [
    [{ layout: 'list' }, 400, 'layout must be one of the following values: carousel, grid, single, stories, swipe_strip'],
    [{ status: 'archived' }, 400, 'status must be one of the following values: draft, active, paused'],
    [{ name: 'x'.repeat(256) }, 400, 'name must be shorter than or equal to 255 characters'],
    [{ rotationInterval: 0 }, 400, 'rotationInterval must not be less than 1'],
    [{ padding: -1 }, 400, 'padding must not be less than 0'],
    [{ backgroundColor: 'red' }, 400, 'backgroundColor must be a hex, rgb() or rgba() colour'],
    [{ heading: 'x'.repeat(256) }, 400, 'heading must be shorter than or equal to 255 characters'],
    [{ aspectRatio: 'x'.repeat(51) }, 400, 'aspectRatio must be shorter than or equal to 50 characters'],
    [{ config: 'x' }, 400, 'config must be an object'],
    [{ projectId: p.project.id }, 400, 'property projectId should not exist'],
    [{ projectId: outsider.project.id }, 404, PROJECT_NOT_FOUND],
  ];
  for (const [body, status, message] of cases) {
    const label = JSON.stringify(body).slice(0, 60);
    const result = await call('PATCH', `/api/banner-categories/${widget.id}`, p.owner, body);
    expect(result.status, label).toBe(status);
    if (status === 404) expect(messageOf(result), label).toBe(message);
    else expect(result.body.message, label).toEqual([message]);
  }
  expect(await widgetRow(widget.id)).toEqual(before);

  // The string values are sent before the expected failure is declared, so an error
  // (a 500, a refused request) still fails the test outright.
  const strings: Array<[string, RawResponse]> = [];
  for (const autoRotate of ['yes', 'false']) {
    const result = await call('PATCH', `/api/banner-categories/${widget.id}`, p.owner, { autoRotate });
    expect([200, 400], autoRotate).toContain(result.status);
    strings.push([autoRotate, result]);
  }

  // Only the boolean check below is expected to fail; everything above must hold.
  test.fail(true, 'INAPP-335');
  test.info().annotations.push({ type: 'issue', description: 'INAPP-335' });
  for (const [autoRotate, result] of strings) {
    expect(result.status, autoRotate).toBe(400);
    expect(result.body.message, autoRotate).toEqual(['autoRotate must be a boolean value']);
  }
  expect(await widgetRow(widget.id)).toEqual(before);
});

test('INAPP-336 the generic category PATCH changes status and layout', async ({ page }) => {
  const p = await inAppProject('inapp-336');
  const { widget } = await widgetWith(p, { name: 'Patched carousel' }, [{ title: 'Live slide' }]);
  const activityBefore = await activityRows(p.project.id);
  const refusedFirst = await serveWidget(widget.id, p.sdkKey);
  expect(refusedFirst.status).toBe(404);

  const activated = await call('PATCH', `/api/banner-categories/${widget.id}`, p.owner, { status: 'active' });
  expect(activated.status).toBe(200);
  expect(dataOf(activated).status).toBe('active');
  const served = dataOf(await serveWidget(widget.id, p.sdkKey));
  expect(served.banners.map((b: { title: string }) => b.title)).toEqual(['Live slide']);

  dataOf(await call('PATCH', `/api/banner-categories/${widget.id}`, p.owner, { layout: 'grid' }));
  await signIn(page, p.owner);
  await openWidgets(page, p.project.id, 'carousels', 'Carousels');
  await expect(page.getByText('Patched carousel', { exact: true })).toHaveCount(0);
  await openWidgets(page, p.project.id, 'grids', 'Grids');
  await expect(widgetListRow(page, 'Patched carousel')).toBeVisible();

  const paused = await call('PATCH', `/api/banner-categories/${widget.id}/status`, p.owner, { status: 'paused', foo: 1 });
  expect(paused.status).toBe(200);
  expect(dataOf(paused).status).toBe('paused');
  expect(await widgetRow(widget.id)).toMatchObject({ status: 'paused', layout: 'grid' });
  // Neither status change is in the activity log.
  expect(await activityRows(p.project.id)).toEqual(activityBefore);
});

test('INAPP-340 widget serve and click store referrer and user agent for everyone', async () => {
  const p = await inAppProject('inapp-340');
  await identifyDevice(p, { doNotTrack: true }, 'fp-d3');
  const { widget, items } = await widgetWith(p, { name: 'Tracked widget' }, [{ title: 'Tracked slide' }], 'active');
  const ip = newClientIp();
  const referer = 'https://shop.example.com/cart?coupon=SAVE10&email=a%40b.com';
  const headers = { Referer: referer, 'User-Agent': IPHONE_SAFARI_UA };

  dataOf(await sdkRequestWithHeaders('GET', `/api/in-app-banners/serve/${widget.id}`, { apiKey: p.sdkKey, ip, headers }));
  dataOf(await sdkRequestWithHeaders('POST', `/api/in-app-banners/${items[0].id}/click`, { apiKey: p.sdkKey, ip, headers }));
  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(2);

  // Expected (current code): both rows keep the whole referrer, the user agent and the address.
  const rows = await widgetEventRows(widget.id);
  expect(rows.map((r) => r.event_type).sort()).toEqual(['click', 'impression']);
  for (const row of rows) {
    expect(row, row.event_type).toMatchObject({ referrer: referer, user_agent: IPHONE_SAFARI_UA, ip_address: ip });
  }
});

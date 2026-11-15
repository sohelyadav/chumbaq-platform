import { randomUUID } from 'crypto';
import type { Page, Response } from '@playwright/test';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  ANDROID_CHROME_UA,
  API_KEY_REQUIRED,
  BANNER_NOT_FOUND,
  call,
  campaignRow,
  chooseOption,
  clearToasts,
  clickWidgetItem,
  collectPageErrors,
  createInAppMessage,
  createPrivacyKey,
  createWidget,
  createWidgetItem,
  dataOf,
  detailBadge,
  dialogField,
  editorField,
  identifyDevice,
  IMAGE_URL_REFUSED,
  inAppProject,
  IPHONE_SAFARI_UA,
  messageActivity,
  messageIn,
  messageOf,
  messageRows,
  newPerson,
  openInAppList,
  openViewAs,
  PRIVACY_KEY_REFUSED,
  PROJECT_NOT_FOUND,
  pendingRows,
  READ_ONLY,
  reactivateAccount,
  recordRequests,
  refuseDialogs,
  rowMenuItem,
  serveWidget,
  setWidgetStatus,
  sql,
  suspendAccount,
  teammate,
  toastTitles,
  toastWithTitle,
  UUID_EXPECTED,
  viewAsHandoff,
  WIDGET_NOT_ACTIVE,
  widgetEventRows,
  widgetItemCard,
  widgetItemRow,
  widgetItemRows,
  widgetListRow,
  widgetRow,
  widgetRows,
  widgetSnapshot,
} from '../../support/areas/inapp';

/**
 * Widgets (banner categories and their items): the list's delete, the editor's create
 * for banners and carousels, the detail page's status, add and toggle, and the SDK's
 * serve and click routes. Then access: a member using in-app messages end to end, an
 * outsider on every message and widget route, staff view-as refused on every write,
 * and stored markup shown as text.
 */

const MESSAGES = (projectId: string) => `/api/projects/${projectId}/in-app-messages`;
const IMAGE = 'https://example.com/banner.jpg';
/** The user agent of calls that must record nothing, so their rows would stand out. */
const REFUSED_UA = 'E2E refused call';
const isBannerPost = (r: Response) => /\/api\/banner-categories\/[0-9a-f-]{36}\/banners$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST';

function waitFor(page: Page, method: string, suffix: string | RegExp): Promise<Response> {
  return page.waitForResponse((r) => {
    const path = new URL(r.url()).pathname;
    return r.request().method() === method && (typeof suffix === 'string' ? path.endsWith(suffix) : suffix.test(path));
  });
}

/** A carousel with items (title, sortOrder and any overrides), made through the API. */
async function carouselWith(
  p: Awaited<ReturnType<typeof inAppProject>>,
  name: string,
  items: Array<Record<string, unknown> & { title: string }>,
  status?: 'active' | 'paused',
) {
  const widget = await createWidget(p.owner, p.project.id, { name, layout: 'carousel' });
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

// ------------------------------------------------------------ K. Widgets list ---

test('INAPP-195 delete a widget from the list', async ({ page }) => {
  const p = await inAppProject('inapp-195');
  const { widget, items } = await carouselWith(p, 'Home hero', [{ title: 'Slide 1' }, { title: 'Slide 2' }], 'active');
  dataOf(await serveWidget(widget.id, p.sdkKey));
  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(2);
  dataOf(await clickWidgetItem(items[0].id, p.sdkKey));
  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(3);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels`);
  const row = widgetListRow(page, 'Home hero');
  await expect(row.getByText('2 slides', { exact: true })).toBeVisible();
  await row.click();

  const prompts: string[] = [];
  page.once('dialog', async (dialog) => {
    prompts.push(dialog.message());
    await dialog.accept();
  });
  const deleted = waitFor(page, 'DELETE', `/api/banner-categories/${widget.id}`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const response = await deleted;

  expect(prompts).toEqual(['Delete this slide and all its data?']);
  expect(response.status()).toBe(200);
  expect((await response.json()).data).toEqual({ message: 'Banner category deleted successfully' });
  await expect(row).toHaveCount(0);
  await expect(page.getByText('No carousels yet. Create one to get started.')).toBeVisible();
  expect(await toastTitles(page)).toEqual([]);

  expect(await widgetRow(widget.id)).toBeUndefined();
  expect(await widgetItemRows(widget.id)).toEqual([]);
  expect(await widgetEventRows(widget.id)).toEqual([]);
  const entries = await activityRows(p.project.id, 'content.deleted');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    actor_user_id: p.owner.userId,
    target_type: 'banner_category',
    target_id: widget.id,
    target_label: 'Home hero',
    details: { kind: 'banner_category' },
  });

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText('deleted the banner category "Home hero"')).toBeVisible();
});

// ------------------------------------------------------------ L. Widget editor ---

test('INAPP-202 create a banner', async ({ page }) => {
  const p = await inAppProject('inapp-202');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners`);
  await page.getByRole('button', { name: 'New Banner', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/banners/new$`));
  await expect(page.getByRole('heading', { name: 'New Banner', exact: true })).toBeVisible();

  await page.getByLabel('Name').fill('Summer Sale');
  await page.getByLabel('Image URL').fill(IMAGE);
  await page.getByLabel('Click URL').fill('https://example.com/offer');
  await chooseOption(page.getByRole('combobox'), '4:3');
  await page.getByLabel('Source', { exact: true }).fill('app');
  await page.getByLabel('Campaign', { exact: true }).fill('summer');
  const activityBefore = (await activityRows(p.project.id)).length;

  const banner = page.waitForResponse(isBannerPost);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await banner).status()).toBe(201);
  await expect(toastWithTitle(page, 'Banner created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/banners$`));
  const row = widgetListRow(page, 'Summer Sale');
  await expect(row.getByText('Draft', { exact: true })).toBeVisible();
  await expect(row.getByText('4:3', { exact: true })).toBeVisible();

  const categories = dataOf<Array<Record<string, any>>>(await call('GET', `/api/projects/${p.project.id}/banner-categories`, p.owner));
  expect(categories).toHaveLength(1);
  expect(categories[0]).toMatchObject({ name: 'Summer Sale', layout: 'single', aspectRatio: '4:3', status: 'draft', bannerCount: 1 });
  const items = dataOf<Array<Record<string, any>>>(await call('GET', `/api/banner-categories/${categories[0].id}/banners`, p.owner));
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    title: 'Summer Sale',
    imageUrl: IMAGE,
    clickUrl: 'https://example.com/offer',
    sortOrder: 0,
    isActive: true,
    metadata: { utm_source: 'app', utm_campaign: 'summer' },
  });
  expect(Object.keys(items[0].metadata).sort()).toEqual(['utm_campaign', 'utm_source']);
  // Creating is not logged.
  expect(await activityRows(p.project.id)).toHaveLength(activityBefore);
});

test('INAPP-210 image URL must be http(s)', async ({ page }) => {
  const p = await inAppProject('inapp-210');
  const dialogs = refuseDialogs(page);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/new`);
  await page.getByLabel('Name').fill('Promo');
  await page.getByLabel('Click URL').fill('https://example.com/offer');

  const create = async (imageUrl: string) => {
    await clearToasts(page);
    await page.getByLabel('Image URL').fill(imageUrl);
    const answered = page.waitForResponse(isBannerPost);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    return answered;
  };

  for (const bad of ['example.com/promo.png', 'javascript:alert(1)', 'x" onerror="alert(1)']) {
    const response = await create(bad);
    expect(response.status(), bad).toBe(400);
    expect((await response.json()).message, bad).toContain(IMAGE_URL_REFUSED);
    await expect(toastWithTitle(page, 'Failed to create banner'), bad).toHaveCount(1);
    await expect(page).toHaveURL(/\/widgets\/banners\/new$/);
  }
  const banners = await sql(
    `SELECT b.id FROM in_app_banners b JOIN banner_categories c ON c.id = b.category_id WHERE c.project_id = $1`,
    [p.project.id],
  );
  expect(banners).toEqual([]);

  // Control: an https address goes through.
  const accepted = await create(IMAGE);
  expect(accepted.status()).toBe(201);
  await expect(toastWithTitle(page, 'Banner created')).toBeVisible();
  expect(dialogs).toEqual([]);
});

test('INAPP-220 create a carousel', async ({ page }) => {
  const p = await inAppProject('inapp-220');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels`);
  await page.getByRole('button', { name: 'New Carousel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Carousel', exact: true })).toBeVisible();

  await page.getByLabel('Name').fill('Home hero');
  await page.getByLabel('Description').fill('Top of the home screen');
  await expect(page.getByLabel('Show Arrows')).toBeChecked();
  await page.getByLabel('Show Arrows').click();
  await expect(page.getByLabel('Show Arrows')).not.toBeChecked();
  await page.getByLabel('Rotation Interval (seconds)').fill('8');
  await page.getByLabel('Heading').fill('Featured');
  await page.getByLabel('Padding').fill('12');

  const created = waitFor(page, 'POST', `/api/projects/${p.project.id}/banner-categories`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Carousel created')).toBeVisible();
  await page.waitForURL(new RegExp(`/projects/${p.project.id}/widgets/carousels/[0-9a-f-]{36}$`));
  const id = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { level: 1, name: 'Home hero', exact: true })).toBeVisible();

  const stored = dataOf(await call('GET', `/api/banner-categories/${id}`, p.owner));
  expect(stored).toMatchObject({
    name: 'Home hero',
    description: 'Top of the home screen',
    layout: 'carousel',
    autoRotate: true,
    rotationInterval: 8,
    heading: 'Featured',
    padding: 12,
    status: 'draft',
    banners: [],
  });
  // Only the toggled key is stored.
  expect(stored.config).toEqual({ showArrows: false });
});

// ------------------------------------------------------------ M. Widget detail ---

test('INAPP-232 change widget status', async ({ page }) => {
  const p = await inAppProject('inapp-232');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Spring banner', layout: 'single', aspectRatio: '16:9' });
  const item = await createWidgetItem(p.owner, widget.id, { title: 'Spring', imageUrl: IMAGE, clickUrl: 'https://example.com/spring', sortOrder: 0 });
  const refused = await serveWidget(widget.id, p.sdkKey);
  expect(refused.status).toBe(404);
  const activityBefore = (await activityRows(p.project.id)).length;

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/${widget.id}`);
  const badge = detailBadge(page, 'Spring banner');
  await expect(badge.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const toActive = waitFor(page, 'PATCH', `/api/banner-categories/${widget.id}/status`);
  await chooseOption(page.getByRole('combobox'), 'Active');
  expect((await toActive).status()).toBe(200);
  await expect(badge.getByText('Active', { exact: true })).toBeVisible();
  const served = await serveWidget(widget.id, p.sdkKey);
  expect(served.status).toBe(200);
  expect(dataOf(served).category).toMatchObject({ id: widget.id, status: 'active' });
  expect(dataOf(served).banners.map((b: { id: string }) => b.id)).toEqual([item.id]);

  const toPaused = waitFor(page, 'PATCH', `/api/banner-categories/${widget.id}/status`);
  await chooseOption(page.getByRole('combobox'), 'Paused');
  expect((await toPaused).status()).toBe(200);
  await expect(badge.getByText('Paused', { exact: true })).toBeVisible();
  const paused = await serveWidget(widget.id, p.sdkKey);
  expect(paused.status).toBe(404);
  expect(messageOf(paused)).toBe(WIDGET_NOT_ACTIVE);

  expect((await widgetRow(widget.id))?.status).toBe('paused');
  expect(await activityRows(p.project.id)).toHaveLength(activityBefore);
});

test('INAPP-240 add an item', async ({ page }) => {
  const p = await inAppProject('inapp-240');
  const { widget } = await carouselWith(p, 'Deals', [{ title: 'Slide 1' }, { title: 'Slide 2' }]);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await expect(page.getByRole('tab', { name: 'Items (2)' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Add Item', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Item' });
  const add = dialog.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeDisabled();
  await dialogField(dialog, 'Title *').fill('Slide 3');
  await expect(add).toBeDisabled();
  await dialogField(dialog, 'Image URL *').fill('https://example.com/3.png');
  await expect(add).toBeDisabled();
  await dialogField(dialog, 'Click URL *').fill('https://example.com/offer/3');
  await expect(add).toBeEnabled();
  await dialogField(dialog, 'CTA Text').fill('Buy');
  await dialogField(dialog, 'Medium').fill('banner');

  const created = page.waitForResponse(isBannerPost);
  await add.click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Banner added')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Items (3)' })).toBeVisible();
  await expect(widgetItemCard(page, 'Slide 3')).toBeVisible();

  const items = dataOf<Array<Record<string, any>>>(await call('GET', `/api/banner-categories/${widget.id}/banners`, p.owner));
  expect(items.map((i) => i.title)).toEqual(['Slide 1', 'Slide 2', 'Slide 3']);
  expect(items[2]).toMatchObject({
    title: 'Slide 3',
    imageUrl: 'https://example.com/3.png',
    clickUrl: 'https://example.com/offer/3',
    ctaText: 'Buy',
    sortOrder: 2,
    isActive: true,
    metadata: { utm_medium: 'banner' },
  });
  expect(Object.keys(items[2].metadata)).toEqual(['utm_medium']);
});

test('INAPP-244 toggle an item off stops serving it', async ({ page }) => {
  const p = await inAppProject('inapp-244');
  const { widget, items } = await carouselWith(p, 'Picks', [{ title: 'Slide A' }, { title: 'Slide B' }], 'active');
  const ids = (r: Awaited<ReturnType<typeof serveWidget>>) => dataOf(r).banners.map((b: { id: string }) => b.id);
  expect(ids(await serveWidget(widget.id, p.sdkKey))).toEqual([items[0].id, items[1].id]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  const toggle = widgetItemCard(page, 'Slide B').getByRole('switch');
  await expect(toggle).toBeChecked();
  const patched = waitFor(page, 'PATCH', `/api/in-app-banners/${items[1].id}`);
  await toggle.click();
  const response = await patched;
  expect(response.status()).toBe(200);
  expect((await response.json()).data.isActive).toBe(false);
  await expect(toggle).not.toBeChecked();
  await expect(widgetItemCard(page, 'Slide A').getByRole('switch')).toBeChecked();

  expect((await widgetItemRow(items[1].id))?.is_active).toBe(false);
  expect((await widgetItemRow(items[0].id))?.is_active).toBe(true);
  expect(ids(await serveWidget(widget.id, p.sdkKey))).toEqual([items[0].id]);
});

// ------------------------------------------------------------ P. SDK serve and click ---

test('INAPP-271 serve an active widget', async () => {
  const p = await inAppProject('inapp-271');
  const day = 24 * 60 * 60 * 1000;
  const widget = await createWidget(p.owner, p.project.id, { name: 'Served', layout: 'carousel' });
  const item = (title: string, extra: Record<string, unknown>) =>
    createWidgetItem(p.owner, widget.id, { title, imageUrl: IMAGE, clickUrl: 'https://example.com/x', ...extra });
  const second = await item('Second', { sortOrder: 1 });
  const first = await item('First', { sortOrder: 0 });
  const off = await item('Off', { sortOrder: 2, isActive: false });
  const later = await item('Later', { sortOrder: 3, startsAt: new Date(Date.now() + day).toISOString() });
  const gone = await item('Gone', { sortOrder: 4, expiresAt: new Date(Date.now() - day).toISOString() });
  await setWidgetStatus(p.owner, widget.id, 'active');

  const served = await serveWidget(widget.id, p.sdkKey, ANDROID_CHROME_UA);
  expect(served.status).toBe(200);
  const body = dataOf(served);
  expect(body.category).toMatchObject({ id: widget.id, name: 'Served', layout: 'carousel', status: 'active' });
  expect(body.banners.map((b: { id: string }) => b.id)).toEqual([first.id, second.id]);
  expect(body.banners[0]).toMatchObject({ title: 'First', imageUrl: IMAGE, sortOrder: 0, isActive: true });

  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(2);
  const events = await widgetEventRows(widget.id);
  expect(events.map((e) => e.banner_id).sort()).toEqual([first.id, second.id].sort());
  for (const event of events) {
    expect(event).toMatchObject({ event_type: 'impression', platform: 'mobile', os: 'Android', browser: 'Chrome', user_agent: ANDROID_CHROME_UA });
  }
  await expect
    .poll(async () => {
      const rows = await widgetItemRows(widget.id);
      return Object.fromEntries(rows.map((r) => [r.title, r.impressions]));
    })
    .toEqual({ First: 1, Second: 1, Off: 0, Later: 0, Gone: 0 });
  expect([off.id, later.id, gone.id]).not.toContain(events[0].banner_id);
});

test('INAPP-272 serve key and scope errors', async () => {
  const p = await inAppProject('inapp-272');
  const other = await inAppProject('inapp-272-other');
  const privacyKey = await createPrivacyKey(p);
  const { widget } = await carouselWith(p, 'Guarded', [{ title: 'Only' }], 'active');

  const none = await serveWidget(widget.id, undefined, REFUSED_UA);
  expect(none.status).toBe(401);
  expect(messageOf(none)).toBe(API_KEY_REQUIRED);
  const foreign = await serveWidget(widget.id, other.sdkKey, REFUSED_UA);
  expect(foreign.status).toBe(404);
  expect(messageOf(foreign)).toBe(WIDGET_NOT_ACTIVE);
  expect(foreign.text).not.toContain('Guarded');
  const privacy = await serveWidget(widget.id, privacyKey, REFUSED_UA);
  expect(privacy.status).toBe(403);
  expect(messageOf(privacy)).toBe(PRIVACY_KEY_REFUSED);
  const malformed = await serveWidget('not-a-uuid', p.sdkKey, REFUSED_UA);
  expect(malformed.status).toBe(400);
  expect(messageOf(malformed)).toBe(UUID_EXPECTED);
  expect(await widgetEventRows(widget.id)).toEqual([]);

  // Control: the project's own key is served and counted. Impressions are written
  // after the answer, so once the control's has landed, any from the refused calls
  // (made earlier, with their own user agent) would have too.
  expect((await serveWidget(widget.id, p.sdkKey)).status).toBe(200);
  await expect.poll(async () => (await widgetEventRows(widget.id)).filter((e) => e.user_agent === ANDROID_CHROME_UA).length).toBe(1);
  expect((await widgetEventRows(widget.id)).map((e) => e.user_agent)).toEqual([ANDROID_CHROME_UA]);
  await expect.poll(async () => (await widgetItemRows(widget.id))[0].impressions).toBe(1);
});

test('INAPP-275 serve during suspension', async () => {
  const p = await inAppProject('inapp-275');
  const { widget, items } = await carouselWith(p, 'Suspended widget', [{ title: 'Live one' }], 'active');

  await suspendAccount(p.owner.userId);
  try {
    const served = await serveWidget(widget.id, p.sdkKey, REFUSED_UA);
    expect(served.status).toBe(200);
    expect(dataOf(served).category).toMatchObject({ id: widget.id, status: 'active' });
    expect(dataOf(served).banners).toEqual([]);
    expect(await widgetEventRows(widget.id)).toEqual([]);
  } finally {
    await reactivateAccount(p.owner.userId);
  }

  const after = await serveWidget(widget.id, p.sdkKey);
  expect(after.status).toBe(200);
  expect(dataOf(after).banners.map((b: { id: string }) => b.id)).toEqual([items[0].id]);
  // Once the later serve's impression has landed, one from the suspended serve would have too.
  await expect.poll(async () => (await widgetEventRows(widget.id)).filter((e) => e.user_agent === ANDROID_CHROME_UA).length).toBe(1);
  expect((await widgetEventRows(widget.id)).map((e) => e.user_agent)).toEqual([ANDROID_CHROME_UA]);
  expect((await widgetItemRow(items[0].id))?.impressions).toBe(1);
});

test('INAPP-276 record a click', async () => {
  const p = await inAppProject('inapp-276');
  const { widget, items } = await carouselWith(p, 'Clickable', [{ title: 'Tap me' }]);

  const clicked = await clickWidgetItem(items[0].id, p.sdkKey, IPHONE_SAFARI_UA);
  expect(clicked.status).toBe(201);
  expect(dataOf(clicked)).toEqual({ message: 'Click recorded' });
  expect((await widgetItemRow(items[0].id))?.clicks).toBe(1);

  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(1);
  const [event] = await widgetEventRows(widget.id);
  expect(event).toMatchObject({
    banner_id: items[0].id,
    event_type: 'click',
    os: 'iOS',
    platform: 'mobile',
    browser: 'Safari',
    user_agent: IPHONE_SAFARI_UA,
  });
});

test('INAPP-277 click scope and errors', async () => {
  const p = await inAppProject('inapp-277');
  const other = await inAppProject('inapp-277-other');
  const { widget, items } = await carouselWith(p, 'Counted', [{ title: 'Mine' }]);

  const foreign = await clickWidgetItem(items[0].id, other.sdkKey, REFUSED_UA);
  expect(foreign.status).toBe(404);
  expect(messageOf(foreign)).toBe(BANNER_NOT_FOUND);
  const none = await clickWidgetItem(items[0].id, undefined, REFUSED_UA);
  expect(none.status).toBe(401);
  expect(messageOf(none)).toBe(API_KEY_REQUIRED);
  const unknown = await clickWidgetItem(randomUUID(), p.sdkKey, REFUSED_UA);
  expect(unknown.status).toBe(404);
  expect(messageOf(unknown)).toBe(BANNER_NOT_FOUND);
  const malformed = await clickWidgetItem('not-a-uuid', p.sdkKey, REFUSED_UA);
  expect(malformed.status).toBe(400);
  expect(messageOf(malformed)).toBe(UUID_EXPECTED);

  // The counter is written before the answer.
  expect((await widgetItemRow(items[0].id))?.clicks).toBe(0);
  expect(await widgetEventRows(widget.id)).toEqual([]);

  // Control: the project's own key counts the click. Its event is written after the
  // answer; once it has landed, one from the refused calls (made earlier) would have too.
  expect((await clickWidgetItem(items[0].id, p.sdkKey)).status).toBe(201);
  expect((await widgetItemRow(items[0].id))?.clicks).toBe(1);
  await expect.poll(async () => (await widgetEventRows(widget.id)).filter((e) => e.user_agent === IPHONE_SAFARI_UA).length).toBe(1);
  expect((await widgetEventRows(widget.id)).map((e) => e.user_agent)).toEqual([IPHONE_SAFARI_UA]);
});

// ------------------------------------------------------------ R. Permissions, tenancy, view-as ---

test('INAPP-283 member can create, activate, trigger and delete messages', async ({ page }) => {
  const p = await inAppProject('inapp-283');
  const member = await teammate(p.project.id, 'member', p.owner);
  await identifyDevice(p, {}, 'fp-d1');
  await identifyDevice(p, {}, 'fp-d2');

  await signIn(page, member);
  await page.goto(`/projects/${p.project.id}/in-app-messages/new`);
  await editorField(page, 'Campaign Name').fill('Member promo');
  await editorField(page, 'Title *').fill('From a member');
  await page.getByRole('button', { name: 'Save Campaign', exact: true }).click();
  await expect(toastWithTitle(page, 'Campaign created')).toBeVisible();
  await page.waitForURL(new RegExp(`/projects/${p.project.id}/in-app-messages/[0-9a-f-]{36}$`));
  const id = page.url().split('/').pop()!;
  expect((await sql(`SELECT created_by FROM in_app_messages WHERE id = $1`, [id]))[0].created_by).toBe(member.userId);

  await openInAppList(page, p.project.id);
  await rowMenuItem(page, 'Member promo', 'Activate');
  await expect(toastWithTitle(page, 'Campaign activated')).toBeVisible();
  await expect(campaignRow(page, 'Member promo').getByText('Active', { exact: true })).toBeVisible();

  await page.goto(`/projects/${p.project.id}/in-app-messages/${id}`);
  await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();
  await page.getByRole('dialog', { name: 'Trigger Message Now' }).getByRole('button', { name: 'All Users', exact: true }).click();
  await expect(toastWithTitle(page, 'Queued for 2 devices')).toBeVisible();
  expect(await pendingRows(id)).toHaveLength(2);

  await openInAppList(page, p.project.id);
  await rowMenuItem(page, 'Member promo', 'Pause');
  await expect(toastWithTitle(page, 'Campaign paused')).toBeVisible();
  await expect(campaignRow(page, 'Member promo').getByText('Paused', { exact: true })).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await rowMenuItem(page, 'Member promo', 'Delete');
  await expect(toastWithTitle(page, 'Campaign deleted')).toBeVisible();
  await expect(campaignRow(page, 'Member promo')).toHaveCount(0);
  expect(await messageRows(p.project.id)).toEqual([]);

  const entries = await messageActivity(p.project.id);
  expect(entries.map((e) => e.action)).toEqual(['in_app_message.activated', 'in_app.triggered', 'in_app_message.paused', 'content.deleted']);
  for (const entry of entries) {
    expect(entry).toMatchObject({ actor_user_id: member.userId, target_id: id, target_label: 'Member promo' });
  }
});

test('INAPP-285 outsider gets 404 on every in-app message route', async () => {
  const p = await inAppProject('inapp-285');
  const outsider = await newPerson('inapp-285-outsider');
  await inAppProject('inapp-285-own', outsider);
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Not yours', triggerType: 'immediate' });
  await identifyDevice(p);
  const before = await messageRows(p.project.id);
  const activityBefore = await activityRows(p.project.id);

  const base = MESSAGES(p.project.id);
  const one = `${base}/${message.id}`;
  const routes: Array<[string, string, unknown?]> = [
    ['GET', base],
    ['POST', base, { name: 'Planted', messageType: 'modal', title: 'Planted' }],
    ['GET', one],
    ['PATCH', one, { name: 'Taken over' }],
    ['DELETE', one],
    ['POST', `${one}/activate`],
    ['POST', `${one}/pause`],
    ['POST', `${one}/duplicate`],
    ['POST', `${base}/trigger`, { messageId: message.id, targetType: 'all' }],
    ['GET', `${one}/analytics`],
    ['GET', `${one}/analytics/funnel`],
    ['GET', `${one}/analytics/buttons`],
    ['GET', `${one}/analytics/timeseries`],
    ['GET', `${one}/analytics/platforms`],
  ];
  for (const [method, path, body] of routes) {
    const result = await call(method, path, outsider, body);
    expect(result.status, `${method} ${path}`).toBe(404);
    expect(messageOf(result), `${method} ${path}`).toBe(PROJECT_NOT_FOUND);
    expect(result.text, `${method} ${path}`).not.toContain('Not yours');
  }

  expect(await messageRows(p.project.id)).toEqual(before);
  expect(await pendingRows(message.id)).toEqual([]);
  expect(await activityRows(p.project.id)).toEqual(activityBefore);
});

test('INAPP-286 outsider gets 404 on every widget route', async () => {
  const p = await inAppProject('inapp-286');
  const outsider = await newPerson('inapp-286-outsider');
  await inAppProject('inapp-286-own', outsider);
  const { widget, items } = await carouselWith(p, 'Private widget', [{ title: 'Private item' }]);
  const before = await widgetSnapshot(p.project.id);
  const activityBefore = await activityRows(p.project.id);

  const routes = (projectId: string, categoryId: string, bannerId: string): Array<[string, string, unknown?]> => [
    ['POST', `/api/projects/${projectId}/banner-categories`, { name: 'Planted' }],
    ['GET', `/api/projects/${projectId}/banner-categories`],
    ['GET', `/api/banner-categories/${categoryId}`],
    ['PATCH', `/api/banner-categories/${categoryId}`, { name: 'Taken over' }],
    ['PATCH', `/api/banner-categories/${categoryId}/status`, { status: 'active' }],
    ['DELETE', `/api/banner-categories/${categoryId}`],
    ['POST', `/api/banner-categories/${categoryId}/banners`, { title: 'Planted' }],
    ['GET', `/api/banner-categories/${categoryId}/banners`],
    ['PATCH', `/api/banner-categories/${categoryId}/banners/reorder`, { items: [{ id: bannerId, sortOrder: 3 }] }],
    ['GET', `/api/in-app-banners/${bannerId}`],
    ['PATCH', `/api/in-app-banners/${bannerId}`, { title: 'Taken over' }],
    ['DELETE', `/api/in-app-banners/${bannerId}`],
    ['GET', `/api/banner-categories/${categoryId}/analytics`],
    ['GET', `/api/banner-categories/${categoryId}/analytics/timeseries`],
    ['GET', `/api/banner-categories/${categoryId}/analytics/devices`],
    ['GET', `/api/banner-categories/${categoryId}/analytics/geo`],
    ['GET', `/api/banner-categories/${categoryId}/analytics/items`],
  ];
  const real = routes(p.project.id, widget.id, items[0].id);
  const made = routes(randomUUID(), randomUUID(), randomUUID());
  const shape = (r: Awaited<ReturnType<typeof call>>) => ({ status: r.status, statusCode: r.body?.statusCode, error: r.body?.error, message: r.body?.message });
  for (const [index, [method, path, body]] of real.entries()) {
    const result = await call(method, path, outsider, body);
    expect(result.status, `${method} ${path}`).toBe(404);
    expect(messageOf(result), `${method} ${path}`).toBe(PROJECT_NOT_FOUND);
    expect(result.text, `${method} ${path}`).not.toContain('Private');
    // The same answer as for ids that exist nowhere.
    const [madeMethod, madePath, madeBody] = made[index];
    expect(shape(result), `${method} ${path}`).toEqual(shape(await call(madeMethod, madePath, outsider, madeBody)));
  }

  expect(await widgetSnapshot(p.project.id)).toEqual(before);
  expect(await activityRows(p.project.id)).toEqual(activityBefore);
});

test('INAPP-290 view-as cannot change messages', async ({ page, browser, baseURL }) => {
  const p = await inAppProject('inapp-290');
  const draft = await createInAppMessage(p.owner, p.project.id, { name: 'VA draft' });
  const active = await messageIn(p.owner, p.project.id, 'active', { name: 'VA active', triggerType: 'immediate' });
  await identifyDevice(p);
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  const before = await messageRows(p.project.id);

  await openViewAs(page, handoff);
  // Spending the view-as link logs staff.viewed_as; nothing after it may add an entry.
  const activityBefore = await activityRows(p.project.id);
  const refused = async (response: Response, pageToast: string) => {
    expect(response.status(), pageToast).toBe(403);
    expect((await response.json()).message, pageToast).toBe(READ_ONLY);
    await expect(toastWithTitle(page, 'Read-only session'), pageToast).toContainText(READ_ONLY);
    await expect(toastWithTitle(page, pageToast)).toBeVisible();
  };

  await openInAppList(page, p.project.id);
  let answered = waitFor(page, 'POST', `/in-app-messages/${draft.id}/activate`);
  await rowMenuItem(page, 'VA draft', 'Activate');
  await refused(await answered, 'Failed to activate');

  await clearToasts(page);
  answered = waitFor(page, 'POST', `/in-app-messages/${active.id}/pause`);
  await rowMenuItem(page, 'VA active', 'Pause');
  await refused(await answered, 'Failed to pause');

  await clearToasts(page);
  answered = waitFor(page, 'POST', `/in-app-messages/${draft.id}/duplicate`);
  await rowMenuItem(page, 'VA draft', 'Duplicate');
  await refused(await answered, 'Failed to duplicate');

  await clearToasts(page);
  page.once('dialog', (dialog) => void dialog.accept());
  answered = waitFor(page, 'DELETE', `/in-app-messages/${draft.id}`);
  await rowMenuItem(page, 'VA draft', 'Delete');
  await refused(await answered, 'Request failed with status code 403');

  await clearToasts(page);
  await page.goto(`/projects/${p.project.id}/in-app-messages/new`);
  await editorField(page, 'Campaign Name').fill('VA planted');
  await editorField(page, 'Title *').fill('Planted');
  answered = waitFor(page, 'POST', MESSAGES(p.project.id));
  await page.getByRole('button', { name: 'Save Campaign', exact: true }).click();
  await refused(await answered, 'Failed to save');

  await page.goto(`/projects/${p.project.id}/in-app-messages/${active.id}`);
  await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();
  answered = waitFor(page, 'POST', `${MESSAGES(p.project.id)}/trigger`);
  await page.getByRole('dialog', { name: 'Trigger Message Now' }).getByRole('button', { name: 'All Users', exact: true }).click();
  await refused(await answered, 'Failed to trigger');

  expect(await messageRows(p.project.id)).toEqual(before);
  expect(await pendingRows(active.id)).toEqual([]);
  expect(await activityRows(p.project.id)).toEqual(activityBefore);
});

test('INAPP-291 view-as cannot change widgets', async ({ page, browser, baseURL }) => {
  const p = await inAppProject('inapp-291');
  const { widget } = await carouselWith(p, 'VA carousel', [{ title: 'Item A' }, { title: 'Item B' }]);
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  const before = await widgetSnapshot(p.project.id);

  await openViewAs(page, handoff);
  // Spending the view-as link logs staff.viewed_as; nothing after it may add an entry.
  const activityBefore = await activityRows(p.project.id);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  const refused = async (response: Response, pageToast: string | null) => {
    const label = `${response.request().method()} ${new URL(response.url()).pathname}`;
    expect(response.status(), label).toBe(403);
    expect((await response.json()).message, label).toBe(READ_ONLY);
    await expect(toastWithTitle(page, 'Read-only session'), label).toContainText(READ_ONLY);
    if (pageToast) await expect(toastWithTitle(page, pageToast), label).toBeVisible();
  };
  const closeDialogAndClear = async (dialog: ReturnType<Page['getByRole']>) => {
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await clearToasts(page);
  };

  // Create a widget in the editor.
  await page.goto(`/projects/${p.project.id}/widgets/carousels/new`);
  await page.getByLabel('Name').fill('VA planted');
  let answered = waitFor(page, 'POST', `/api/projects/${p.project.id}/banner-categories`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await refused(await answered, 'Failed to create slide');
  await clearToasts(page);

  // The detail page: add, edit, toggle, delete an item, reorder, status, settings.
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await page.getByRole('button', { name: 'Add Item', exact: true }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add Item' });
  await dialogField(addDialog, 'Title *').fill('Planted');
  await dialogField(addDialog, 'Image URL *').fill('https://example.com/p.png');
  await dialogField(addDialog, 'Click URL *').fill('https://example.com/p');
  answered = page.waitForResponse(isBannerPost);
  await addDialog.getByRole('button', { name: 'Add', exact: true }).click();
  await refused(await answered, 'Failed to add banner');
  await closeDialogAndClear(addDialog);

  const itemA = widgetItemCard(page, 'Item A');
  // Buttons on an item: Move up, Move down, Toggle analytics, edit (pencil), delete (trash).
  await itemA.getByRole('button').nth(3).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit Banner' });
  await dialogField(editDialog, 'Title *').fill('Item A renamed');
  answered = waitFor(page, 'PATCH', /\/api\/in-app-banners\/[0-9a-f-]{36}$/);
  await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await refused(await answered, 'Failed to update banner');
  await closeDialogAndClear(editDialog);

  answered = waitFor(page, 'PATCH', /\/api\/in-app-banners\/[0-9a-f-]{36}$/);
  await itemA.getByRole('switch').click();
  await refused(await answered, null);
  await clearToasts(page);

  answered = waitFor(page, 'DELETE', /\/api\/in-app-banners\/[0-9a-f-]{36}$/);
  await itemA.getByRole('button').nth(4).click();
  await refused(await answered, null);
  expect(dialogs).toEqual(['Delete this item? This cannot be undone.']);
  await clearToasts(page);

  answered = waitFor(page, 'PATCH', `/api/banner-categories/${widget.id}/banners/reorder`);
  await itemA.getByRole('button', { name: 'Move down' }).click();
  await refused(await answered, null);
  await clearToasts(page);

  answered = waitFor(page, 'PATCH', `/api/banner-categories/${widget.id}/status`);
  await chooseOption(page.getByRole('combobox'), 'Active');
  await refused(await answered, 'Failed to update status');
  await expect(detailBadge(page, 'VA carousel').getByText('Draft', { exact: true })).toBeVisible();
  await clearToasts(page);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Edit Widget Settings' });
  await dialogField(settings, 'Heading').fill('Planted heading');
  answered = waitFor(page, 'PATCH', `/api/banner-categories/${widget.id}`);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await refused(await answered, 'Failed to update settings');
  await closeDialogAndClear(settings);

  // The list: delete the category.
  await page.goto(`/projects/${p.project.id}/widgets/carousels`);
  await widgetListRow(page, 'VA carousel').click();
  answered = waitFor(page, 'DELETE', `/api/banner-categories/${widget.id}`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await refused(await answered, null);
  expect(dialogs).toEqual(['Delete this item? This cannot be undone.', 'Delete this slide and all its data?']);

  expect(await widgetSnapshot(p.project.id)).toEqual(before);
  expect(await widgetRows(p.project.id)).toHaveLength(1);
  expect(await activityRows(p.project.id)).toEqual(activityBefore);
});

// ------------------------------------------------------------ S. Security display ---

test('INAPP-293 message preview renders stored text safely', async ({ page }) => {
  const p = await inAppProject('inapp-293');
  const body = '<script>alert(1)</script>';
  const buttonText = '<img src=x onerror=alert(2)>';
  const message = await createInAppMessage(p.owner, p.project.id, {
    name: 'Markup body',
    title: 'Plain title',
    body,
    buttons: [{ id: 'b1', text: buttonText, action: 'dismiss', style: 'primary' }],
  });
  const dialogs = refuseDialogs(page);
  await signIn(page, p.owner);

  const noMarkup = async () => {
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator('script', { hasText: 'alert(1)' })).toHaveCount(0);
    await expect(page.locator('[onerror]')).toHaveCount(0);
  };

  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  const preview = page.locator('[data-slot="card"]').filter({ hasText: 'Message Preview' });
  await expect(preview.getByText(body, { exact: true })).toBeVisible();
  await expect(preview.getByText(buttonText, { exact: true })).toBeVisible();
  await noMarkup();

  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}/edit`);
  await expect(editorField(page, 'Campaign Name')).toHaveValue('Markup body');
  const live = page.getByText('Live Preview', { exact: true }).locator('xpath=../..');
  await expect(live.getByText(body, { exact: true })).toBeVisible();
  await expect(live.getByText(buttonText, { exact: true })).toBeVisible();
  await noMarkup();

  expect(dialogs).toEqual([]);
});

test('INAPP-294 widget names, headings, UTM values and URLs render as text', async ({ page }) => {
  const p = await inAppProject('inapp-294');
  const name = '<b onmouseover=alert(1)>x</b>';
  const heading = '"><svg onload=alert(1)>';
  const clickUrl = 'https://e.com/"><script>';
  const utm = '<img src=x onerror=alert(3)>';
  const widget = await createWidget(p.owner, p.project.id, { name, heading, layout: 'carousel' });
  const item = await createWidgetItem(p.owner, widget.id, {
    title: 'Plain item',
    imageUrl: IMAGE,
    clickUrl: 'https://example.com/offer',
    metadata: { utm_campaign: utm },
  });
  // The API refuses this click URL; a stored one is written directly to check that
  // the pages would still show it as text.
  const refused = await call('PATCH', `/api/in-app-banners/${item.id}`, p.owner, { clickUrl });
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toContain('clickUrl must be a URL address');
  await sql(`UPDATE in_app_banners SET click_url = $2 WHERE id = $1`, [item.id, clickUrl]);
  // A quote-bearing click URL the API does accept.
  const quotedUrl = 'https://e.com/"onmouseover="alert(4)';
  const quoted = await createWidgetItem(p.owner, widget.id, { title: 'Quoted item', imageUrl: IMAGE, clickUrl: quotedUrl, sortOrder: 1 });
  expect(quoted.clickUrl).toBe(quotedUrl);

  const dialogs = refuseDialogs(page);
  await signIn(page, p.owner);
  const noMarkup = async () => {
    await expect(page.locator('b', { hasText: /^x$/ })).toHaveCount(0);
    await expect(page.locator('svg[onload]')).toHaveCount(0);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator('[onmouseover], [onerror]')).toHaveCount(0);
  };

  await page.goto(`/projects/${p.project.id}/widgets/carousels`);
  const nameText = page.getByText(name, { exact: true });
  await expect(nameText).toBeVisible();
  await nameText.hover();
  await widgetListRow(page, name).click();
  await expect(page.getByText(`Widget ID: ${widget.id}`)).toBeVisible();
  await noMarkup();

  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  await expect(widgetItemCard(page, 'Plain item').getByText(clickUrl, { exact: true })).toBeVisible();
  await expect(widgetItemCard(page, 'Quoted item').getByText(quotedUrl, { exact: true })).toBeVisible();
  await noMarkup();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByText(heading, { exact: true })).toBeVisible();
  await noMarkup();

  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}/items/${item.id}/report`);
  await expect(page.getByRole('heading', { level: 1, name: 'Plain item', exact: true })).toBeVisible();
  await expect(page.getByText(clickUrl, { exact: true })).toBeVisible();
  await expect(page.getByText(utm, { exact: true })).toBeVisible();
  await noMarkup();

  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}/items/${quoted.id}/report`);
  await expect(page.getByRole('heading', { level: 1, name: 'Quoted item', exact: true })).toBeVisible();
  await expect(page.getByText(quotedUrl, { exact: true })).toBeVisible();
  await noMarkup();

  expect(dialogs).toEqual([]);
});

// ------------------------------------------------------------ T. Review round ---

test('INAPP-315 detail-page Activate and Pause in view-as', async ({ page, browser, baseURL }) => {
  const p = await inAppProject('inapp-315');
  const draft = await createInAppMessage(p.owner, p.project.id, { name: 'VA detail draft' });
  const active = await messageIn(p.owner, p.project.id, 'active', { name: 'VA detail active' });
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  const before = await messageRows(p.project.id);

  await openViewAs(page, handoff);
  // Spending the view-as link logs staff.viewed_as; nothing after it may add an entry.
  const activityBefore = await activityRows(p.project.id);
  const errors = collectPageErrors(page);
  const posts = recordRequests(page, 'POST', /\/in-app-messages\/[0-9a-f-]{36}\/(activate|pause)$/);

  // The refusal ends as an uncaught rejection, so once it is raised the page has done
  // all it does about it: then only the read-only toast may be on screen.
  const onlyReadOnlyToast = async (errorsBefore: number) => {
    await expect(toastWithTitle(page, 'Read-only session')).toContainText(READ_ONLY);
    await expect.poll(() => errors.length).toBeGreaterThan(errorsBefore);
    expect(errors.slice(errorsBefore).join('\n')).toContain('Request failed with status code 403');
    expect(await toastTitles(page)).toEqual(['Read-only session']);
  };

  await page.goto(`/projects/${p.project.id}/in-app-messages/${draft.id}`);
  let answered = waitFor(page, 'POST', `/in-app-messages/${draft.id}/activate`);
  await page.getByRole('button', { name: 'Activate', exact: true }).click();
  let response = await answered;
  expect(response.status()).toBe(403);
  expect((await response.json()).message).toBe(READ_ONLY);
  await onlyReadOnlyToast(0);
  await expect(detailBadge(page, 'VA detail draft').getByText('Draft', { exact: true })).toBeVisible();
  const afterActivate = errors.length;

  await clearToasts(page);
  await page.goto(`/projects/${p.project.id}/in-app-messages/${active.id}`);
  answered = waitFor(page, 'POST', `/in-app-messages/${active.id}/pause`);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  response = await answered;
  expect(response.status()).toBe(403);
  expect((await response.json()).message).toBe(READ_ONLY);
  await onlyReadOnlyToast(afterActivate);
  await expect(detailBadge(page, 'VA detail active').getByText('Active', { exact: true })).toBeVisible();

  expect(posts).toHaveLength(2);
  expect(await messageRows(p.project.id)).toEqual(before);
  expect(await activityRows(p.project.id)).toEqual(activityBefore);
});

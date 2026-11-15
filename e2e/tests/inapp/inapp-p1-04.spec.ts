import { randomBytes, randomUUID } from 'crypto';
import type { Browser, Page } from '@playwright/test';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { newClientIp } from '../../support/api';
import {
  activityRows,
  apiResponse,
  call,
  cardTitled,
  chooseOption,
  clearToasts,
  createInAppMessage,
  createWidget,
  createWidgetItem,
  dataOf,
  detailBadge,
  dialogField,
  inAppProject,
  isItemPost,
  itemTitlesShown,
  labelledNumber,
  messageOf,
  newPerson,
  openViewAs,
  PROJECT_NOT_FOUND,
  refuseDialogs,
  sdkRequest,
  serveWidget,
  setPickerTime,
  setWidgetStatus,
  sql,
  teammate,
  toastWithTitle,
  viewAsHandoff,
  viewAsTokenOf,
  WIDGET_NOT_ACTIVE,
  waitForItemCounters,
  widgetEventRows,
  widgetItemCard,
  widgetItemRow,
  widgetItemRows,
  widgetListRow,
  widgetRow,
  widgetRows,
  widgetTraffic,
  type InAppProject,
} from '../../support/areas/inapp';

/**
 * Widgets (P1): the editor for banners, stories and carousels (layout, enabling Create,
 * custom ratios, dates, click URLs, edits, colours), the detail page (single banner,
 * items, order, analytics row, settings dialog, stories, loading), the item report, the
 * category, banner, reorder, serve and analytics APIs, and access: members and admins,
 * outsiders and staff view-as.
 */

test.describe.configure({ mode: 'parallel' });

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const IMAGE = 'https://example.com/banner.jpg';
/** The filled look of a selected range button. */
const FILLED = /(^|\s)bg-primary(\s|$)/;
/** The look of the selected half of the story type toggle. */
const SELECTED = /(^|\s)bg-background(\s|$)/;
const BACKGROUND_REFUSED = 'backgroundColor must be a hex, rgb() or rgba() colour';
const NOT_IN_CATEGORY = 'Some banner IDs do not belong to this category';

/** The whole page, for the label-based field helpers. */
const body = (page: Page) => page.locator('body');

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

/** The banners of a project's widgets, joined to their category. */
function projectItems(projectId: string) {
  return sql(
    `SELECT b.* FROM in_app_banners b JOIN banner_categories c ON c.id = b.category_id WHERE c.project_id = $1 ORDER BY b.created_at`,
    [projectId],
  );
}

/** A date as the browser shows it with toLocaleString / toLocaleDateString. */
function localString(page: Page, at: string, dateOnly = false): Promise<string> {
  return page.evaluate(([value, only]) => (only ? new Date(value).toLocaleDateString() : new Date(value).toLocaleString()), [at, dateOnly] as const);
}

// ------------------------------------------------------------ L. Widget editor ---

test('INAPP-200 new banner editor layout', async ({ page }) => {
  const p = await inAppProject('inapp-200');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners`);
  await page.getByRole('button', { name: 'New Banner', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/widgets/banners/new$`));

  await expect(page.getByRole('heading', { level: 1, name: 'New Banner', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();

  const details = cardTitled(page, 'Banner Details');
  await expect(details.locator('label[for="banner-name"]')).toHaveText('Name *');
  await expect(details.locator('label[for="image-url"]')).toHaveText('Image URL *');
  await expect(details.locator('label[for="click-url"]')).toHaveText('Click URL *');
  await expect(details.getByText('Aspect Ratio', { exact: true })).toBeVisible();
  await expect(details.getByRole('combobox')).toHaveText('16:9');
  await expect(details.getByText('Start Date (optional)', { exact: true })).toBeVisible();
  await expect(details.getByText('End Date (optional)', { exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Select start' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Select end' })).toBeVisible();
  await expect(details.getByText('UTM Tracking (optional)', { exact: true })).toBeVisible();
  for (const label of ['Source', 'Medium', 'Campaign', 'Content', 'Term']) {
    await expect(details.getByLabel(label, { exact: true }), label).toHaveValue('');
  }

  const preview = cardTitled(page, 'Preview');
  await expect(preview.getByText('Banner preview', { exact: true })).toBeVisible();
  await expect(preview.getByText('16:9 aspect ratio', { exact: true })).toBeVisible();
});

test('INAPP-201 Create is enabled only with name, image and click URL', async ({ page }) => {
  const p = await inAppProject('inapp-201');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/new`);
  const create = page.getByRole('button', { name: 'Create', exact: true });

  await expect(create).toBeDisabled();
  await page.getByLabel('Name').fill('Promo');
  await expect(create).toBeDisabled();
  await page.getByLabel('Image URL').fill(IMAGE);
  await expect(create).toBeDisabled();
  await page.getByLabel('Click URL').fill('https://example.com/offer');
  await expect(create).toBeEnabled();
  // Emptying any one of the three disables it again.
  await page.getByLabel('Name').fill('');
  await expect(create).toBeDisabled();
});

test('INAPP-203 a new banner is a draft that serve refuses', async ({ page }) => {
  const p = await inAppProject('inapp-203');
  // The two requests the editor's Create makes.
  const widget = await createWidget(p.owner, p.project.id, { name: 'Draft banner', layout: 'single', aspectRatio: '16:9' });
  await createWidgetItem(p.owner, widget.id, { title: 'Draft banner', imageUrl: IMAGE, clickUrl: 'https://example.com/offer', sortOrder: 0 });
  expect((await widgetRow(widget.id))?.status).toBe('draft');

  const served = await serveWidget(widget.id, p.sdkKey);
  expect(served.status).toBe(404);
  expect(messageOf(served)).toBe(WIDGET_NOT_ACTIVE);
  expect(await widgetEventRows(widget.id)).toEqual([]);

  // Neither the list nor the editor offers a status control.
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners`);
  const row = widgetListRow(page, 'Draft banner');
  await expect(row.getByText('Draft', { exact: true })).toBeVisible();
  await row.click();
  await expect(page.getByText(`Widget ID: ${widget.id}`)).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Activate|Active)$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/widgets/banners/${widget.id}/edit$`));
  await expect(page.getByLabel('Name')).toHaveValue('Draft banner');
  // The editor's only select is the aspect ratio.
  await expect(page.getByRole('combobox')).toHaveCount(1);
  await expect(page.getByRole('combobox')).toHaveText('16:9');
  await expect(page.getByText('Status', { exact: true })).toHaveCount(0);
  expect((await widgetRow(widget.id))?.status).toBe('draft');
});

test('INAPP-206 custom ratio must be N:N', async ({ page }) => {
  const p = await inAppProject('inapp-206');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/new`);
  await page.getByLabel('Name').fill('Custom ratio');
  await page.getByLabel('Image URL').fill(IMAGE);
  await page.getByLabel('Click URL').fill('https://example.com/offer');
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeEnabled();

  await chooseOption(page.getByRole('combobox'), 'Custom');
  await expect(page.getByLabel('Custom Ratio')).toHaveAttribute('placeholder', 'e.g. 5:4');
  await page.getByLabel('Custom Ratio').fill('5x4');
  await expect(create).toBeDisabled();
  await page.getByLabel('Custom Ratio').fill('5:4');
  await expect(create).toBeEnabled();
  await expect(cardTitled(page, 'Preview').getByText('5:4 aspect ratio', { exact: true })).toBeVisible();

  const posted = apiResponse(page, 'POST', `/api/projects/${p.project.id}/banner-categories`);
  await create.click();
  const response = await posted;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().aspectRatio).toBe('5:4');
  await expect(toastWithTitle(page, 'Banner created')).toBeVisible();
  const [stored] = await widgetRows(p.project.id);
  expect(stored).toMatchObject({ name: 'Custom ratio', layout: 'single', aspect_ratio: '5:4' });
});

test('INAPP-208 end date before start date', async ({ page }) => {
  const p = await inAppProject('inapp-208');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/new`);
  await page.getByLabel('Name').fill('Dated banner');
  await page.getByLabel('Image URL').fill(IMAGE);
  await page.getByLabel('Click URL').fill('https://example.com/offer');
  // Both on today's date: the start late in the day, the end early in it.
  await setPickerTime(page, page.getByRole('button', { name: 'Select start' }), '23:59');
  await setPickerTime(page, page.getByRole('button', { name: 'Select end' }), '00:01');

  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.includes('banner')) posts.push(r.url());
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(toastWithTitle(page, 'End date must be after start date')).toBeVisible();
  await expect(page).toHaveURL(/\/widgets\/banners\/new$/);
  expect(posts).toEqual([]);
  expect(await widgetRows(p.project.id)).toEqual([]);

  // Control: with the end after the start the banner is created.
  await clearToasts(page);
  await setPickerTime(page, page.getByRole('button', { name: /00:01/ }), '23:59');
  await setPickerTime(page, page.getByRole('button', { name: /23:59/ }).first(), '00:01');
  const created = page.waitForResponse(isItemPost);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Banner created')).toBeVisible();
});

test('INAPP-209 click URL forms', async ({ page }) => {
  const p = await inAppProject('inapp-209');
  await signIn(page, p.owner);
  const openEditor = async () => {
    await page.goto(`/projects/${p.project.id}/widgets/banners/new`);
    await page.getByLabel('Name').fill('Click forms');
    await page.getByLabel('Image URL').fill(IMAGE);
  };
  const create = async (clickUrl: string) => {
    await page.getByLabel('Click URL').fill(clickUrl);
    const answered = page.waitForResponse(isItemPost);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    return answered;
  };

  await openEditor();
  for (const bad of ['not a url', 'javascript:alert(1)']) {
    await clearToasts(page);
    const response = await create(bad);
    expect(response.status(), bad).toBe(400);
    expect((await response.json()).message, bad).toContain('clickUrl must be a URL address');
    await expect(toastWithTitle(page, 'Failed to create banner'), bad).toBeVisible();
    await expect(page).toHaveURL(/\/widgets\/banners\/new$/);
  }
  expect(await projectItems(p.project.id)).toEqual([]);

  for (const accepted of ['example.com/offer', 'ftp://files.example.com/a']) {
    await openEditor();
    const response = await create(accepted);
    expect(response.status(), accepted).toBe(201);
    await expect(toastWithTitle(page, 'Banner created'), accepted).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/banners$`));
  }
  expect((await projectItems(p.project.id)).map((b) => b.click_url)).toEqual(['example.com/offer', 'ftp://files.example.com/a']);
});

test('INAPP-211 a refused banner leaves an empty category', async ({ page }) => {
  const p = await inAppProject('inapp-211');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/new`);
  await page.getByLabel('Name').fill('Half made');
  await page.getByLabel('Image URL').fill('example.com/promo.png');
  await page.getByLabel('Click URL').fill('https://example.com/offer');

  for (const attempt of [1, 2]) {
    await clearToasts(page);
    const refused = page.waitForResponse(isItemPost);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    expect((await refused).status(), `attempt ${attempt}`).toBe(400);
    await expect(toastWithTitle(page, 'Failed to create banner')).toBeVisible();
    await expect(page).toHaveURL(/\/widgets\/banners\/new$/);
  }

  // Expected (current code): each Create made its category before the banner was
  // refused, so two empty categories of that name are left.
  const categories = await widgetRows(p.project.id);
  expect(categories.map((c) => [c.name, c.layout])).toEqual([
    ['Half made', 'single'],
    ['Half made', 'single'],
  ]);
  expect(await projectItems(p.project.id)).toEqual([]);

  await page.goto(`/projects/${p.project.id}/widgets/banners`);
  const rows = widgetListRow(page, 'Half made');
  await expect(rows).toHaveCount(2);
  // No thumbnail: there is no banner to take an image from.
  await expect(rows.locator('img')).toHaveCount(0);
});

test('INAPP-212 edit a banner', async ({ page }) => {
  const p = await inAppProject('inapp-212');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Summer Sale', layout: 'single', aspectRatio: '4:3' });
  const item = await createWidgetItem(p.owner, widget.id, {
    title: 'Summer Sale',
    imageUrl: IMAGE,
    clickUrl: 'https://example.com/offer',
    sortOrder: 0,
    metadata: { utm_source: 'app', utm_campaign: 'summer' },
  });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/${widget.id}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Banner', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
  // Loaded from the category and its first banner.
  await expect(page.getByLabel('Image URL')).toHaveValue(IMAGE);
  await expect(page.getByLabel('Name')).toHaveValue('Summer Sale');
  await expect(page.getByLabel('Click URL')).toHaveValue('https://example.com/offer');
  await expect(page.getByRole('combobox')).toHaveText('4:3');
  await expect(page.getByLabel('Source', { exact: true })).toHaveValue('app');
  await expect(page.getByLabel('Campaign', { exact: true })).toHaveValue('summer');
  await expect(page.getByLabel('Medium', { exact: true })).toHaveValue('');

  await page.getByLabel('Name').fill('Summer Sale 2');
  await page.getByLabel('Click URL').fill('https://example.com/new');
  const patched = apiResponse(page, 'PATCH', `/api/in-app-banners/${item.id}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patched).status()).toBe(200);
  await expect(toastWithTitle(page, 'Banner updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/banners$`));
  await expect(widgetListRow(page, 'Summer Sale 2')).toBeVisible();

  const stored = dataOf(await call('GET', `/api/banner-categories/${widget.id}`, p.owner));
  expect(stored).toMatchObject({ name: 'Summer Sale 2', aspectRatio: '4:3' });
  expect(stored.banners).toHaveLength(1);
  expect(stored.banners[0]).toMatchObject({
    id: item.id,
    title: 'Summer Sale 2',
    clickUrl: 'https://example.com/new',
    imageUrl: IMAGE,
    metadata: { utm_source: 'app', utm_campaign: 'summer' },
  });
});

test('INAPP-215 new image story', async ({ page }) => {
  const p = await inAppProject('inapp-215');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/stories/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'New Story', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Image', exact: true })).toHaveClass(SELECTED);
  await expect(page.getByRole('button', { name: 'Text', exact: true })).not.toHaveClass(SELECTED);

  await page.getByLabel('Name').fill('Promo story');
  await page.getByLabel('Image URL').fill('https://example.com/story.jpg');
  const clickLabel = page.locator('label[for="click-url"]');
  await expect(clickLabel).toHaveText('Click URL (optional)');
  await page.getByLabel('CTA Text').fill('Shop Now');
  await expect(clickLabel).toHaveText('Click URL *');
  // The asterisk is only a hint: Create stays enabled without a click URL.
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeEnabled();
  await page.getByLabel('Click URL').fill('https://example.com/shop');

  const created = page.waitForResponse(isItemPost);
  await create.click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Story created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/stories$`));

  const [category] = await widgetRows(p.project.id);
  expect(category).toMatchObject({ name: 'Promo story', layout: 'stories' });
  const [item] = await widgetItemRows(category.id);
  expect(item).toMatchObject({
    title: 'Promo story',
    image_url: 'https://example.com/story.jpg',
    click_url: 'https://example.com/shop',
    cta_text: 'Shop Now',
  });
  expect(item.metadata).toEqual({ storyType: 'image' });
});

test('INAPP-216 new text story', async ({ page }) => {
  const p = await inAppProject('inapp-216');
  const text = 'Big savings this weekend on every pair of running shoes!!!';
  expect(text.length).toBeGreaterThanOrEqual(55);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/stories/new`);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveClass(SELECTED);
  await page.getByLabel('Story Text').fill(text);
  await dialogField(body(page), 'Background Color *').fill('#112233');
  await dialogField(body(page), 'Text Color').fill('#ffffff');

  const preview = cardTitled(page, 'Preview');
  const shown = preview.getByText(text, { exact: true });
  await expect(shown).toBeVisible();
  await expect(shown).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(shown.locator('..')).toHaveCSS('background-color', 'rgb(17, 34, 51)');
  await expect(preview.getByText('9:16 aspect ratio', { exact: true })).toBeVisible();

  const created = page.waitForResponse(isItemPost);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Story created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/stories$`));

  const [category] = await widgetRows(p.project.id);
  expect(category).toMatchObject({ name: text.slice(0, 50), layout: 'stories', aspect_ratio: '9:16' });
  const [item] = await widgetItemRows(category.id);
  expect(item).toMatchObject({ title: text.slice(0, 50), image_url: null });
  expect(item.metadata).toEqual({ storyType: 'text', storyText: text, backgroundColor: '#112233', textColor: '#ffffff' });
});

test('INAPP-217 text story validation', async ({ page }) => {
  const p = await inAppProject('inapp-217');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/stories/new`);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const create = page.getByRole('button', { name: 'Create', exact: true });
  const background = dialogField(body(page), 'Background Color *');

  // 1. No story text.
  await expect(page.getByLabel('Story Text')).toHaveValue('');
  await expect(create).toBeDisabled();
  // 2. Text, but the background colour cleared.
  await page.getByLabel('Story Text').fill('Hello');
  await expect(create).toBeEnabled();
  await background.fill('');
  await expect(create).toBeDisabled();
  // 3. Colour back, a CTA but no click URL.
  await background.fill('#6366f1');
  await expect(create).toBeEnabled();
  await page.getByLabel('CTA Text').fill('Go');
  await expect(create).toBeDisabled();
  // Control: the click URL makes it complete.
  await page.getByLabel('Click URL').fill('https://example.com/go');
  await expect(create).toBeEnabled();
  expect(await widgetRows(p.project.id)).toEqual([]);
});

test('INAPP-218 story colours are not validated', async ({ page }) => {
  const p = await inAppProject('inapp-218');
  const background = 'red; background-image: url(//evil)';
  const textColour = '"><img src=x onerror=alert(1)>';
  const dialogs = refuseDialogs(page);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/stories/new`);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByLabel('Story Text').fill('Colour check');
  await dialogField(body(page), 'Background Color *').fill(background);
  await dialogField(body(page), 'Text Color').fill(textColour);

  const created = page.waitForResponse(isItemPost);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Story created')).toBeVisible();

  // Expected (current code): both stored as typed, inside the item's metadata.
  const [category] = await widgetRows(p.project.id);
  const [item] = await widgetItemRows(category.id);
  expect(item.metadata).toMatchObject({ storyType: 'text', backgroundColor: background, textColor: textColour });
  // The category's own background colour is checked; the same value there is refused.
  const refused = await call('PATCH', `/api/banner-categories/${category.id}`, p.owner, { backgroundColor: background });
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toContain(BACKGROUND_REFUSED);
  // ...and serve hands both to the SDK as stored.
  await setWidgetStatus(p.owner, category.id, 'active');
  const served = dataOf(await serveWidget(category.id, p.sdkKey));
  expect(served.banners[0].metadata).toMatchObject({ backgroundColor: background, textColor: textColour });

  // The dashboard shows them only as style values and text.
  await page.goto(`/projects/${p.project.id}/widgets/stories/${category.id}`);
  const card = widgetItemCard(page, 'Colour check');
  await expect(card).toBeVisible();
  await expect(card.getByText('Text', { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('[onerror]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('INAPP-219 new carousel editor', async ({ page }) => {
  const p = await inAppProject('inapp-219');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels`);
  await page.getByRole('button', { name: 'New Carousel', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New Carousel', exact: true })).toBeVisible();

  const details = cardTitled(page, 'Carousel Details');
  await expect(details.locator('label[for="banner-name"]')).toHaveText('Name *');
  await expect(details.locator('label[for="description"]')).toHaveText('Description (optional)');
  await expect(details.getByText('Aspect Ratio', { exact: true })).toBeVisible();
  await expect(details.getByRole('combobox')).toHaveText('16:9');

  await expect(details.getByText('Carousel Settings', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Auto Rotate')).toBeChecked();
  await expect(page.getByLabel('Rotation Interval (seconds)')).toHaveValue('5');
  for (const toggle of ['Show Dots', 'Show Arrows', 'Infinite Loop']) {
    await expect(page.getByLabel(toggle), toggle).toBeChecked();
  }

  await expect(details.getByText('Appearance', { exact: true })).toBeVisible();
  await expect(details.locator('label[for="heading"]')).toHaveText('Heading (optional)');
  await expect(page.getByLabel('Heading')).toHaveValue('');
  await expect(details.locator('label[for="bg-color"]')).toHaveText('Background Color (optional)');
  await expect(page.getByLabel('Background Color')).toHaveValue('#ffffff');
  await expect(details.getByPlaceholder('#ffffff')).toHaveValue('#ffffff');
  await expect(details.locator('label[for="padding"]')).toHaveText('Padding (px) (optional)');
  await expect(page.getByLabel('Padding')).toHaveValue('0');

  await expect(cardTitled(page, 'Preview')).toHaveCount(0);
  await expect(page.getByText(/^\S+ aspect ratio$/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
});

test('INAPP-224 background colour and padding validation', async ({ page }) => {
  const p = await inAppProject('inapp-224');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/new`);
  await page.getByLabel('Name').fill('Colour carousel');
  const backgroundText = cardTitled(page, 'Carousel Details').getByPlaceholder('#ffffff');
  const create = async () => {
    const posted = apiResponse(page, 'POST', `/api/projects/${p.project.id}/banner-categories`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    return posted;
  };

  // 1. A named colour.
  await backgroundText.fill('red');
  let response = await create();
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toContain(BACKGROUND_REFUSED);
  // The failure toast names the item ("slide"), not the widget.
  await expect(toastWithTitle(page, 'Failed to create slide')).toBeVisible();

  // 2. A spaced rgba() colour with a negative padding.
  await clearToasts(page);
  await backgroundText.fill('rgba(255, 255, 255, 0.5)');
  await page.getByLabel('Padding').fill('-5');
  response = await create();
  expect(response.status()).toBe(400);
  const messages: string[] = (await response.json()).message;
  expect(messages).toContain('padding must not be less than 0');
  expect(messages.join('; ')).not.toContain('backgroundColor');
  await expect(toastWithTitle(page, 'Failed to create slide')).toBeVisible();
  expect(await widgetRows(p.project.id)).toEqual([]);

  // 3. Padding 0: saved, spaced colour included.
  await clearToasts(page);
  await page.getByLabel('Padding').fill('0');
  response = await create();
  expect(response.status()).toBe(201);
  await expect(toastWithTitle(page, 'Carousel created')).toBeVisible();
  const [stored] = await widgetRows(p.project.id);
  expect(stored).toMatchObject({ name: 'Colour carousel', background_color: 'rgba(255, 255, 255, 0.5)', padding: 0 });
});

test('INAPP-226 edit a carousel', async ({ page }) => {
  const p = await inAppProject('inapp-226');
  const widget = await createWidget(p.owner, p.project.id, {
    name: 'Ratio carousel',
    layout: 'carousel',
    aspectRatio: '5:4',
    heading: 'Old heading',
    config: { showDots: false },
  });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Carousel', exact: true })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('Ratio carousel');
  await expect(page.getByRole('combobox')).toHaveText('Custom');
  await expect(page.getByLabel('Custom Ratio')).toHaveValue('5:4');
  await expect(page.getByLabel('Show Dots')).not.toBeChecked();
  await expect(page.getByLabel('Show Arrows')).toBeChecked();
  await expect(page.getByLabel('Heading')).toHaveValue('Old heading');

  await page.getByLabel('Heading').fill('New heading');
  const patched = apiResponse(page, 'PATCH', `/api/banner-categories/${widget.id}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patched).status()).toBe(200);
  await expect(toastWithTitle(page, 'Carousel updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/carousels/${widget.id}$`));

  const stored = dataOf(await call('GET', `/api/banner-categories/${widget.id}`, p.owner));
  expect(stored).toMatchObject({ name: 'Ratio carousel', heading: 'New heading', aspectRatio: '5:4', layout: 'carousel' });
  expect(stored.config).toEqual({ showDots: false });
});

// ------------------------------------------------------------ M. Widget detail ---

test('INAPP-231 banner (single layout) detail by URL', async ({ page }) => {
  const p = await inAppProject('inapp-231');
  const startsAt = iso(-DAY);
  const expiresAt = iso(DAY);
  const { widget, items } = await widgetWith(
    p,
    { name: 'Spring banner', layout: 'single', aspectRatio: '16:9' },
    [{ title: 'Spring', imageUrl: IMAGE, clickUrl: 'https://example.com/spring', ctaText: 'Shop', startsAt, expiresAt }],
    'active',
  );
  await widgetTraffic(p, widget.id, 2, [{ bannerId: items[0].id }, { bannerId: items[0].id }, { bannerId: items[0].id }]);
  await waitForItemCounters(items[0].id, 2, 3);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/${widget.id}`);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await expect(detailBadge(page, 'Spring banner').getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy ID', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveText('Active');
  await expect(page.getByRole('tab')).toHaveCount(0);

  const card = widgetItemCard(page, 'Spring');
  await expect(card.locator('img')).toHaveAttribute('src', IMAGE);
  await expect(card.getByText('Live', { exact: true })).toBeVisible();
  await expect(card.getByText('https://example.com/spring', { exact: true })).toBeVisible();
  await expect(card.getByText('CTA: Shop', { exact: true })).toBeVisible();
  const window = `From: ${await localString(page, startsAt)} · Until: ${await localString(page, expiresAt)}`;
  await expect(card.getByText(window, { exact: true })).toBeVisible();
  await expect(card.getByText('2 impressions', { exact: true })).toBeVisible();
  await expect(card.getByText('3 clicks', { exact: true })).toBeVisible();
  await expect(card.getByRole('switch')).toBeChecked();
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
});

test('INAPP-235 single banner: no banner yet', async ({ page }) => {
  const p = await inAppProject('inapp-235');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Empty banner', layout: 'single' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/${widget.id}`);
  await expect(page.getByText('No banner set yet.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Set Banner', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set Banner' });
  await expect(dialog.getByText('Image preview will appear here', { exact: true })).toBeVisible();
  for (const label of ['Start Date', 'End Date', 'UTM Tracking (optional)', 'Source', 'Medium', 'Campaign', 'Content', 'Term']) {
    await expect(dialog.getByText(label, { exact: true }), label).toBeVisible();
  }
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await dialogField(dialog, 'Title *').fill('Autumn');
  await expect(save).toBeDisabled();
  await dialogField(dialog, 'Image URL *').fill(IMAGE);
  await expect(save).toBeDisabled();
  await dialogField(dialog, 'Click URL *').fill('https://example.com/autumn');
  await expect(save).toBeEnabled();
  await dialogField(dialog, 'CTA Text').fill('Shop');

  const created = page.waitForResponse(isItemPost);
  await save.click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Banner added')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  const card = widgetItemCard(page, 'Autumn');
  await expect(card.getByText('CTA: Shop', { exact: true })).toBeVisible();
  await expect(page.getByText('No banner set yet.', { exact: true })).toHaveCount(0);
  const [item] = await widgetItemRows(widget.id);
  expect(item).toMatchObject({ title: 'Autumn', image_url: IMAGE, click_url: 'https://example.com/autumn', cta_text: 'Shop', sort_order: 0 });
});

test('INAPP-236 single banner: edit, toggle, delete', async ({ page }) => {
  const p = await inAppProject('inapp-236');
  const { widget, items } = await widgetWith(p, { name: 'Sale banner', layout: 'single' }, [{ title: 'Sale old', imageUrl: IMAGE }]);
  const dialogs = refuseDialogs(page);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/banners/${widget.id}`);

  let card = widgetItemCard(page, 'Sale old');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Banner' });
  await expect(dialogField(dialog, 'Title *')).toHaveValue('Sale old');
  await dialogField(dialog, 'Title *').fill('Sale');
  const patched = apiResponse(page, 'PATCH', `/api/in-app-banners/${items[0].id}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patched).status()).toBe(200);
  await expect(toastWithTitle(page, 'Banner updated')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  card = widgetItemCard(page, 'Sale');
  await expect(card.getByText('Live', { exact: true })).toBeVisible();

  const toggled = apiResponse(page, 'PATCH', `/api/in-app-banners/${items[0].id}`);
  await card.getByRole('switch').click();
  expect((await toggled).status()).toBe(200);
  await expect(card.getByRole('switch')).not.toBeChecked();
  await expect(card.getByText('Live', { exact: true })).toHaveCount(0);
  expect((await widgetItemRow(items[0].id))?.is_active).toBe(false);

  const deleted = apiResponse(page, 'DELETE', `/api/in-app-banners/${items[0].id}`);
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await deleted).status()).toBe(200);
  await expect(page.getByText('No banner set yet.', { exact: true })).toBeVisible();
  // No confirmation prompt on this delete.
  expect(dialogs).toEqual([]);
  expect(await widgetItemRows(widget.id)).toEqual([]);

  const entries = await activityRows(p.project.id, 'content.deleted');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ actor_user_id: p.owner.userId, target_type: 'banner', target_label: 'Sale', details: { kind: 'banner' } });
  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText('deleted the banner "Sale"')).toBeVisible();
});

test('INAPP-238 multi-item detail with tabs', async ({ page }) => {
  const p = await inAppProject('inapp-238');
  // Created out of order: the page lists them by sortOrder.
  const widget = await createWidget(p.owner, p.project.id, { name: 'Three slides', layout: 'carousel' });
  const third = await createWidgetItem(p.owner, widget.id, { title: 'Slide C', imageUrl: 'https://example.com/c.png', clickUrl: 'https://example.com/c', sortOrder: 2 });
  await createWidgetItem(p.owner, widget.id, { title: 'Slide A', imageUrl: 'https://example.com/a.png', clickUrl: 'https://example.com/a', sortOrder: 0 });
  await createWidgetItem(p.owner, widget.id, { title: 'Slide B', imageUrl: 'https://example.com/b.png', clickUrl: 'https://example.com/b', sortOrder: 1 });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await expect(page.getByRole('tab', { name: 'Items (3)' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('button', { name: 'Add Item', exact: true })).toBeVisible();
  await expect(itemTitlesShown(page)).toHaveText(['Slide A', 'Slide B', 'Slide C']);

  const card = widgetItemCard(page, 'Slide C');
  await expect(card.getByRole('button', { name: 'Move up' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Move down' })).toBeDisabled();
  await expect(card.locator('svg.lucide-grip-vertical')).toBeVisible();
  await expect(card.locator('img')).toHaveAttribute('src', 'https://example.com/c.png');
  await expect(card.getByText('https://example.com/c', { exact: true })).toBeVisible();
  await expect(card.getByTitle('Impressions')).toHaveText('0');
  await expect(card.getByTitle('Clicks')).toHaveText('0');
  await expect(card.getByTitle('Toggle analytics')).toBeVisible();
  await expect(card.getByRole('switch')).toBeChecked();
  // Move up, Move down, Toggle analytics, edit (pencil), delete (trash).
  await expect(card.getByRole('button')).toHaveCount(5);
  await expect(card.locator('svg.lucide-pencil')).toBeVisible();
  await expect(card.locator('svg.lucide-trash2, svg.lucide-trash-2')).toBeVisible();
  expect(third.sortOrder).toBe(2);
});

test('INAPP-239 multi-item empty state', async ({ page }) => {
  const p = await inAppProject('inapp-239');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Empty carousel', layout: 'carousel' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await expect(page.getByRole('tab', { name: 'Items (0)' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('No items yet. Add one to get started.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Item', exact: true })).toBeVisible();
});

test('INAPP-241 add item validation', async ({ page }) => {
  const p = await inAppProject('inapp-241');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Checked carousel', layout: 'carousel' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await page.getByRole('button', { name: 'Add Item', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Item' });
  await dialogField(dialog, 'Title *').fill('Bad image');
  await dialogField(dialog, 'Image URL *').fill('example.com/x.png');
  await dialogField(dialog, 'Click URL *').fill('https://example.com/x');

  const refused = page.waitForResponse(isItemPost);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  const response = await refused;
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toContain('imageUrl must be a URL address');
  await expect(toastWithTitle(page, 'Failed to add banner')).toBeVisible();
  await expect(dialog).toBeVisible();

  // 2. A good image but the end before the start: refused in the page.
  await dialogField(dialog, 'Image URL *').fill('https://example.com/x.png');
  await setPickerTime(page, dialog.getByRole('button', { name: 'Select start' }), '23:59');
  await expect(dialog).toBeVisible();
  await setPickerTime(page, dialog.getByRole('button', { name: 'Select end' }), '00:01');
  await expect(dialog).toBeVisible();
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/banners')) posts.push(r.url());
  });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(toastWithTitle(page, 'End date must be after start date')).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(posts).toEqual([]);
  expect(await widgetItemRows(widget.id)).toEqual([]);
});

test('INAPP-242 edit an item', async ({ page }) => {
  const p = await inAppProject('inapp-242');
  const startsAt = iso(-DAY);
  const expiresAt = iso(7 * DAY);
  const { widget, items } = await widgetWith(p, { name: 'Editable carousel' }, [
    { title: 'Slide one', ctaText: 'Buy', startsAt, expiresAt, metadata: { utm_source: 'app', utm_medium: 'banner', utm_term: 'shoes' } },
  ]);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  const card = widgetItemCard(page, 'Slide one');
  await card.getByRole('button').nth(3).click();

  const dialog = page.getByRole('dialog', { name: 'Edit Banner' });
  await expect(dialogField(dialog, 'Title *')).toHaveValue('Slide one');
  await expect(dialogField(dialog, 'Image URL *')).toHaveValue('https://example.com/0.png');
  await expect(dialogField(dialog, 'Click URL *')).toHaveValue('https://example.com/offer/0');
  await expect(dialogField(dialog, 'CTA Text')).toHaveValue('Buy');
  await expect(dialogField(dialog, 'Source')).toHaveValue('app');
  await expect(dialogField(dialog, 'Medium')).toHaveValue('banner');
  await expect(dialogField(dialog, 'Term')).toHaveValue('shoes');
  await expect(dialogField(dialog, 'Campaign')).toHaveValue('');
  // The two date pickers show the stored times instead of their placeholders.
  const hhmm = (at: string) => page.evaluate((v) => {
    const d = new Date(v);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, at);
  const pickers = (label: string) => dialog.locator('label', { hasText: new RegExp(`^${label}$`) }).locator('..').getByRole('button');
  await expect(pickers('Start Date')).toContainText(await hhmm(startsAt));
  await expect(pickers('Start Date')).not.toContainText('Select start');
  await expect(pickers('End Date')).toContainText(await hhmm(expiresAt));
  await expect(pickers('End Date')).not.toContainText('Select end');

  await dialogField(dialog, 'Click URL *').fill('https://example.com/changed');
  const patched = apiResponse(page, 'PATCH', `/api/in-app-banners/${items[0].id}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patched).status()).toBe(200);
  await expect(toastWithTitle(page, 'Banner updated')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByText('https://example.com/changed', { exact: true })).toBeVisible();

  const stored = dataOf(await call('GET', `/api/in-app-banners/${items[0].id}`, p.owner));
  expect(stored).toMatchObject({
    clickUrl: 'https://example.com/changed',
    ctaText: 'Buy',
    metadata: { utm_source: 'app', utm_medium: 'banner', utm_term: 'shoes' },
  });
  expect(new Date(stored.startsAt).getTime()).toBe(new Date(startsAt).getTime());
  expect(new Date(stored.expiresAt).getTime()).toBe(new Date(expiresAt).getTime());
});

test('INAPP-245 delete an item', async ({ page }) => {
  const p = await inAppProject('inapp-245');
  const { widget, items } = await widgetWith(p, { name: 'Trim carousel' }, [{ title: 'Slide 1' }, { title: 'Slide 2' }]);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  const card = widgetItemCard(page, 'Slide 2');
  const prompts: string[] = [];

  // Dismissing the prompt keeps the item.
  page.once('dialog', async (dialog) => {
    prompts.push(dialog.message());
    await dialog.dismiss();
  });
  await card.getByRole('button').nth(4).click();
  await expect.poll(() => prompts.length).toBe(1);
  await expect(card).toBeVisible();
  expect(await widgetItemRows(widget.id)).toHaveLength(2);

  page.once('dialog', async (dialog) => {
    prompts.push(dialog.message());
    await dialog.accept();
  });
  const deleted = apiResponse(page, 'DELETE', `/api/in-app-banners/${items[1].id}`);
  await card.getByRole('button').nth(4).click();
  const response = await deleted;
  expect(prompts).toEqual(['Delete this item? This cannot be undone.', 'Delete this item? This cannot be undone.']);
  expect(response.status()).toBe(200);
  expect((await response.json()).data).toEqual({ message: 'In-app banner deleted successfully' });
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Items (1)' })).toBeVisible();
  expect((await widgetItemRows(widget.id)).map((r) => r.title)).toEqual(['Slide 1']);

  const entries = await activityRows(p.project.id, 'content.deleted');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ target_type: 'banner', target_id: items[1].id, target_label: 'Slide 2' });
  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText('deleted the banner "Slide 2"')).toBeVisible();
});

test('INAPP-246 move items up and down', async ({ page }) => {
  const p = await inAppProject('inapp-246');
  const { widget, items } = await widgetWith(p, { name: 'Ordered carousel' }, [{ title: 'Item A' }, { title: 'Item B' }, { title: 'Item C' }], 'active');
  const [a, b, c] = items.map((i) => i.id);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await expect(itemTitlesShown(page)).toHaveText(['Item A', 'Item B', 'Item C']);
  await expect(widgetItemCard(page, 'Item A').getByRole('button', { name: 'Move up' })).toBeDisabled();
  await expect(widgetItemCard(page, 'Item C').getByRole('button', { name: 'Move down' })).toBeDisabled();
  await expect(widgetItemCard(page, 'Item B').getByRole('button', { name: 'Move up' })).toBeEnabled();
  await expect(widgetItemCard(page, 'Item B').getByRole('button', { name: 'Move down' })).toBeEnabled();
  const reorderPath = `/api/banner-categories/${widget.id}/banners/reorder`;
  const sortOf = (json: { items: Array<{ id: string; sortOrder: number }> }) =>
    Object.fromEntries(json.items.map((i) => [i.id, i.sortOrder]));

  let sent = apiResponse(page, 'PATCH', reorderPath);
  await widgetItemCard(page, 'Item A').getByRole('button', { name: 'Move down' }).click();
  let response = await sent;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().items).toHaveLength(3);
  expect(sortOf(response.request().postDataJSON())).toEqual({ [a]: 1, [b]: 0, [c]: 2 });
  await expect(itemTitlesShown(page)).toHaveText(['Item B', 'Item A', 'Item C']);

  sent = apiResponse(page, 'PATCH', reorderPath);
  await widgetItemCard(page, 'Item C').getByRole('button', { name: 'Move up' }).click();
  response = await sent;
  expect(response.status()).toBe(200);
  expect(sortOf(response.request().postDataJSON())).toEqual({ [b]: 0, [a]: 2, [c]: 1 });
  await expect(itemTitlesShown(page)).toHaveText(['Item B', 'Item C', 'Item A']);

  expect((await widgetItemRows(widget.id)).map((r) => r.title)).toEqual(['Item B', 'Item C', 'Item A']);
  const served = dataOf(await serveWidget(widget.id, p.sdkKey));
  expect(served.banners.map((x: { title: string }) => x.title)).toEqual(['Item B', 'Item C', 'Item A']);
});

test('INAPP-249 item analytics row and full report link', async ({ page }) => {
  const p = await inAppProject('inapp-249');
  const { widget, items } = await widgetWith(p, { name: 'Measured carousel' }, [{ title: 'Measured slide' }], 'active');
  await widgetTraffic(p, widget.id, 10, Array.from({ length: 3 }, () => ({ bannerId: items[0].id })));
  await waitForItemCounters(items[0].id, 10, 3);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  const card = widgetItemCard(page, 'Measured slide');
  await expect(card.getByTitle('Impressions')).toHaveText('10');
  await expect(page.getByRole('button', { name: /View full report/ })).toHaveCount(0);
  await card.getByTitle('Toggle analytics').click();

  const report = page.getByRole('button', { name: 'View full report →', exact: true });
  await expect(report).toBeVisible();
  const row = report.locator('xpath=ancestor::div[contains(@class, "rounded-b-lg")]');
  const stat = (text: RegExp) => row.locator('div.flex.items-center.gap-2').filter({ hasText: text });
  await expect(stat(/impressions$/)).toHaveText(/^10\s*impressions$/);
  await expect(stat(/clicks$/)).toHaveText(/^3\s*clicks$/);
  await expect(stat(/CTR$/)).toHaveText(/^30\.0%\s*CTR$/);

  await report.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/carousels/${widget.id}/items/${items[0].id}/report$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Measured slide', exact: true })).toBeVisible();
});

test('INAPP-251 edit widget settings dialog', async ({ page }) => {
  const p = await inAppProject('inapp-251');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Settings carousel', layout: 'carousel', aspectRatio: '16:9' });
  const banner = await createWidget(p.owner, p.project.id, { name: 'Settings banner', layout: 'single' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);

  // The Settings tab's Edit opens the same dialog.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('tabpanel').getByRole('button', { name: 'Edit', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit Widget Settings' });
  await expect(dialogField(dialog, 'Name')).toHaveValue('Settings carousel');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Widget Settings' });
  await dialogField(dialog, 'Name').fill('Renamed carousel');
  await dialogField(dialog, 'Description').fill('Shown on home');
  await chooseOption(dialog.getByRole('combobox'), '1:1');
  await dialogField(dialog, 'Heading').fill('Top picks');
  await dialogField(dialog, 'Background Color').fill('#000000');
  await labelledNumber(dialog, 'Padding (px)').fill('2');
  await expect(dialog.getByText('Rotation Interval (seconds)', { exact: true })).toBeVisible();
  await dialog.getByRole('switch').click();
  await expect(dialog.getByRole('switch')).not.toBeChecked();
  await expect(dialog.getByText('Rotation Interval (seconds)', { exact: true })).toHaveCount(0);

  const patched = apiResponse(page, 'PATCH', `/api/banner-categories/${widget.id}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patched).status()).toBe(200);
  await expect(toastWithTitle(page, 'Settings updated')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Renamed carousel', exact: true })).toBeVisible();
  const stored = dataOf(await call('GET', `/api/banner-categories/${widget.id}`, p.owner));
  expect(stored).toMatchObject({
    name: 'Renamed carousel',
    description: 'Shown on home',
    aspectRatio: '1:1',
    heading: 'Top picks',
    backgroundColor: '#000000',
    padding: 2,
    autoRotate: false,
  });

  // A banner (single layout) has no Auto Rotate in the dialog.
  await page.goto(`/projects/${p.project.id}/widgets/banners/${banner.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Widget Settings' });
  await expect(dialogField(dialog, 'Name')).toHaveValue('Settings banner');
  await expect(dialog.getByText('Auto Rotate', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('switch')).toHaveCount(0);
});

test('INAPP-252 settings validation and failure', async ({ page }) => {
  const p = await inAppProject('inapp-252');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Strict carousel', layout: 'carousel' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Widget Settings' });
  await dialogField(dialog, 'Background Color').fill('blue');
  let patched = apiResponse(page, 'PATCH', `/api/banner-categories/${widget.id}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  let response = await patched;
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toContain(BACKGROUND_REFUSED);
  await expect(toastWithTitle(page, 'Failed to update settings')).toBeVisible();
  await expect(dialog).toBeVisible();
  expect((await widgetRow(widget.id))?.background_color).toBe('#ffffff');

  // Expected (current code): an empty name is saved; neither side checks it.
  await dialogField(dialog, 'Background Color').fill('#ffffff');
  await dialogField(dialog, 'Name').fill('');
  patched = apiResponse(page, 'PATCH', `/api/banner-categories/${widget.id}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  response = await patched;
  expect(response.status()).toBe(200);
  await expect(toastWithTitle(page, 'Settings updated')).toBeVisible();
  expect((await widgetRow(widget.id))?.name).toBe('');
});

test('INAPP-254 stories detail dialog', async ({ page }) => {
  const p = await inAppProject('inapp-254');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Story reel', layout: 'stories' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/stories/${widget.id}`);
  await expect(page.getByRole('tab', { name: 'Items (0)' })).toBeVisible();

  // An image story, the default.
  await page.getByRole('button', { name: 'Add Item', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Image Story' });
  await expect(dialog.getByText('Preview', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Add image URL', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Image', exact: true })).toHaveClass(SELECTED);
  await dialogField(dialog, 'Image URL *').fill('https://example.com/story-1.jpg');
  await labelledNumber(dialog, 'Duration (seconds, optional)').fill('7');
  let created = page.waitForResponse(isItemPost);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Story added')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // A text story.
  await clearToasts(page);
  await page.getByRole('button', { name: 'Add Item', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Text', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Text Story' });
  await dialogField(dialog, 'Story Text *').fill('Weekend deals');
  await dialogField(dialog, 'Background Color').fill('#112233');
  await dialogField(dialog, 'Text Color').fill('#fafafa');
  await expect(dialog.getByText('Click URL *', { exact: true })).toHaveCount(0);
  await dialogField(dialog, 'CTA Text (optional)').fill('Go');
  await expect(dialog.getByText('Click URL *', { exact: true })).toBeVisible();
  const add = dialog.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeDisabled();
  await dialogField(dialog, 'Click URL *').fill('https://example.com/deals');
  await expect(add).toBeEnabled();
  created = page.waitForResponse(isItemPost);
  await add.click();
  expect((await created).status()).toBe(201);
  await expect(toastWithTitle(page, 'Story added')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Items (2)' })).toBeVisible();

  const imageCard = widgetItemCard(page, 'Image Story');
  const textCard = widgetItemCard(page, 'Weekend deals');
  await expect(imageCard.getByText('Image', { exact: true })).toBeVisible();
  await expect(textCard.getByText('Text', { exact: true })).toBeVisible();
  await expect(textCard.locator('div[style*="background-color"]')).toHaveCSS('background-color', 'rgb(17, 34, 51)');
  await expect(textCard.locator('svg.lucide-type')).toHaveCSS('color', 'rgb(250, 250, 250)');

  const [image, text] = await widgetItemRows(widget.id);
  expect(image).toMatchObject({ title: 'Image Story', image_url: 'https://example.com/story-1.jpg', sort_order: 0 });
  expect(image.metadata).toEqual({ storyType: 'image', duration: 7 });
  expect(text).toMatchObject({ title: 'Weekend deals', image_url: null, cta_text: 'Go', click_url: 'https://example.com/deals', sort_order: 1 });
  expect(text.metadata).toEqual({ storyType: 'text', storyText: 'Weekend deals', backgroundColor: '#112233', textColor: '#fafafa' });
});

test('INAPP-256 detail loading and not-found', async ({ page }) => {
  const p = await inAppProject('inapp-256');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Slow carousel', layout: 'carousel' });
  await signIn(page, p.owner);

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === `/api/banner-categories/${widget.id}`,
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  const bars = page.locator('main .animate-pulse');
  await expect(bars).toHaveCount(2);
  await expect(page.getByRole('heading', { level: 1, name: 'Slow carousel' })).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { level: 1, name: 'Slow carousel', exact: true })).toBeVisible();
  await expect(bars).toHaveCount(0);
  await page.unroute((url) => url.pathname === `/api/banner-categories/${widget.id}`);

  await page.goto(`/projects/${p.project.id}/widgets/carousels/${randomUUID()}`);
  await expect(page.getByText('Category not found.', { exact: true })).toBeVisible();
});

// ------------------------------------------------------------ N. Item report ---

test('INAPP-258 item report content', async ({ page }) => {
  const p = await inAppProject('inapp-258');
  const startsAt = iso(-DAY);
  const expiresAt = iso(3 * DAY);
  const { widget, items } = await widgetWith(
    p,
    { name: 'Report carousel' },
    [
      {
        title: 'Reported slide',
        imageUrl: IMAGE,
        clickUrl: 'https://example.com/reported',
        startsAt,
        expiresAt,
        metadata: { utm_source: 'app', utm_medium: 'banner', utm_campaign: 'autumn' },
      },
    ],
    'active',
  );
  await widgetTraffic(p, widget.id, 20, Array.from({ length: 5 }, () => ({ bannerId: items[0].id })));
  await waitForItemCounters(items[0].id, 20, 5);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}/items/${items[0].id}/report`);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  const heading = page.getByRole('heading', { level: 1, name: 'Reported slide', exact: true });
  await expect(heading).toBeVisible();
  const header = heading.locator('xpath=../..');
  await expect(header.getByText('https://example.com/reported', { exact: true })).toBeVisible();
  await expect(header.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.locator('main img')).toHaveAttribute('src', IMAGE);

  const stat = (label: string) =>
    page.locator('[data-slot="card"]').filter({ has: page.locator('p', { hasText: new RegExp(`^${label}$`) }) }).locator('p.text-2xl');
  await expect(stat('Impressions')).toHaveText('20');
  await expect(stat('Clicks')).toHaveText('5');
  await expect(stat('CTR')).toHaveText('25.0%');

  const chart = cardTitled(page, 'Widget Performance');
  await expect(chart.getByText('Aggregate traffic for the entire widget', { exact: true })).toBeVisible();
  for (const label of ['7d', '30d', '90d']) {
    const button = chart.getByRole('button', { name: label, exact: true });
    if (label === '30d') await expect(button).toHaveClass(FILLED);
    else await expect(button, label).not.toHaveClass(FILLED);
  }

  const utm = page.getByText('UTM Parameters', { exact: true }).locator('xpath=ancestor::*[@data-slot="card"][1]');
  const box = (label: string) => utm.locator('div.rounded-lg.border').filter({ has: page.locator('p', { hasText: new RegExp(`^${label}$`) }) });
  await expect(box('source')).toContainText('app');
  await expect(box('medium')).toContainText('banner');
  await expect(box('campaign')).toContainText('autumn');
  await expect(box('source').locator('p').first()).toHaveCSS('text-transform', 'capitalize');
  await expect(utm.locator('div.rounded-lg.border')).toHaveCount(3);

  const starts = page.getByText('Starts:', { exact: true }).locator('..');
  await expect(starts).toHaveText(`Starts: ${await localString(page, startsAt)}`);
  const expires = page.getByText('Expires:', { exact: true }).locator('..');
  await expect(expires).toHaveText(`Expires: ${await localString(page, expiresAt)}`);
});

// ------------------------------------------------------------ O. Categories and banners API ---

test('INAPP-262 category create validation', async () => {
  const p = await inAppProject('inapp-262');
  const path = `/api/projects/${p.project.id}/banner-categories`;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, 'name must be a string'],
    [{ name: 'X', layout: 'list' }, 'layout must be one of the following values: carousel, grid, single, stories, swipe_strip'],
    [{ name: 'n'.repeat(256) }, 'name must be shorter than or equal to 255 characters'],
    [{ name: 'X', rotationInterval: 0 }, 'rotationInterval must not be less than 1'],
    [{ name: 'X', padding: -1 }, 'padding must not be less than 0'],
    [{ name: 'X', aspectRatio: '1'.repeat(49) + ':1' }, 'aspectRatio must be shorter than or equal to 50 characters'],
    [{ name: 'X', backgroundColor: '#fff" onload="x' }, BACKGROUND_REFUSED],
    [{ name: 'X', backgroundColor: 'rgba(255, 255, 255, 0.123456789)x' }, BACKGROUND_REFUSED],
    [{ name: 'X', status: 'archived' }, 'status must be one of the following values: draft, active, paused'],
    [{ name: 'X', config: 'x' }, 'config must be an object'],
    [{ name: 'X', projectId: p.project.id }, 'property projectId should not exist'],
  ];
  for (const [payload, expected] of cases) {
    const label = JSON.stringify(payload).slice(0, 80);
    const result = await call('POST', path, p.owner, payload);
    expect(result.status, label).toBe(400);
    expect(messageOf(result), label).toContain(expected);
  }
  expect('1'.repeat(49) + ':1').toHaveLength(51);
  expect('rgba(255, 255, 255, 0.123456789)x').toHaveLength(33);
  const tooLong = await call('POST', path, p.owner, { name: 'X', backgroundColor: 'rgba(255, 255, 255, 0.123456789)x' });
  expect(messageOf(tooLong)).toContain('backgroundColor must be shorter than or equal to 32 characters');
  expect(await widgetRows(p.project.id)).toEqual([]);

  // Control: the bare minimum is accepted.
  const created = await call('POST', path, p.owner, { name: 'X' });
  expect(created.status).toBe(201);
  expect(await widgetRows(p.project.id)).toHaveLength(1);
});

test('INAPP-266 banner create and update validation', async () => {
  const p = await inAppProject('inapp-266');
  const widget = await createWidget(p.owner, p.project.id, { name: 'Validated carousel' });
  const path = `/api/banner-categories/${widget.id}/banners`;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ imageUrl: IMAGE }, 'title must be a string'],
    [{ title: 't'.repeat(256) }, 'title must be shorter than or equal to 255 characters'],
    [{ title: 'T', ctaText: 'c'.repeat(101) }, 'ctaText must be shorter than or equal to 100 characters'],
    [{ title: 'T', sortOrder: -1 }, 'sortOrder must not be less than 0'],
    [{ title: 'T', startsAt: 'soon' }, 'startsAt must be a valid ISO 8601 date string'],
    [{ title: 'T', metadata: [] }, 'metadata must be an object'],
    [{ title: 'T', categoryId: widget.id }, 'property categoryId should not exist'],
  ];
  for (const [payload, expected] of cases) {
    const label = JSON.stringify(payload).slice(0, 80);
    const result = await call('POST', path, p.owner, payload);
    expect(result.status, label).toBe(400);
    expect(messageOf(result), label).toContain(expected);
  }
  expect(await widgetItemRows(widget.id)).toEqual([]);

  const item = await createWidgetItem(p.owner, widget.id, { title: 'Valid', imageUrl: IMAGE });
  const refused = await call('PATCH', `/api/in-app-banners/${item.id}`, p.owner, { imageUrl: 'javascript:alert(1)' });
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toContain('imageUrl must be a URL address');
  expect((await widgetItemRow(item.id))?.image_url).toBe(IMAGE);
  // Control: a valid update goes through.
  const updated = await call('PATCH', `/api/in-app-banners/${item.id}`, p.owner, { imageUrl: 'https://example.com/new.png' });
  expect(updated.status).toBe(200);
  expect((await widgetItemRow(item.id))?.image_url).toBe('https://example.com/new.png');

  // Only the boolean check below is expected to fail; everything above must hold.
  test.fail(true, 'INAPP-266');
  test.info().annotations.push({ type: 'issue', description: 'INAPP-266' });
  const before = (await widgetItemRows(widget.id)).length;
  for (const isActive of ['yes', 'false']) {
    const result = await call('POST', path, p.owner, { title: `Flag ${isActive}`, isActive });
    expect(result.status, isActive).toBe(400);
    expect(messageOf(result), isActive).toContain('isActive must be a boolean value');
  }
  expect(await widgetItemRows(widget.id)).toHaveLength(before);
});

test('INAPP-267 reorder validation', async () => {
  const p = await inAppProject('inapp-267');
  const { widget: a, items: aItems } = await widgetWith(p, { name: 'Carousel A' }, [{ title: 'a1' }, { title: 'a2' }]);
  const { widget: b, items: bItems } = await widgetWith(p, { name: 'Carousel B' }, [{ title: 'b1' }]);
  const [a1, a2] = aItems.map((i) => i.id);
  const b1 = bItems[0].id;
  const path = `/api/banner-categories/${a.id}/banners/reorder`;
  const orders = async () => Object.fromEntries((await sql(`SELECT id, sort_order FROM in_app_banners WHERE id = ANY($1)`, [[a1, a2, b1]])).map((r) => [r.id, r.sort_order]));
  const before = await orders();

  const cases: Array<[unknown, number, string]> = [
    [{ items: [{ id: b1, sortOrder: 0 }] }, 404, NOT_IN_CATEGORY],
    [{ items: [{ id: a1, sortOrder: 0 }, { id: a1, sortOrder: 1 }] }, 404, NOT_IN_CATEGORY],
    [{ items: [{ id: 'x', sortOrder: 0 }] }, 400, 'items.0.id must be a UUID'],
    [{ items: [{ id: a1, sortOrder: -1 }] }, 400, 'items.0.sortOrder must not be less than 0'],
    [{ items: 'x' }, 400, 'items must be an array'],
  ];
  for (const [payload, status, expected] of cases) {
    const label = JSON.stringify(payload).slice(0, 80);
    const result = await call('PATCH', path, p.owner, payload);
    expect(result.status, label).toBe(status);
    expect(messageOf(result), label).toContain(expected);
  }
  expect(await orders()).toEqual(before);

  const valid = await call('PATCH', path, p.owner, { items: [{ id: a1, sortOrder: 1 }, { id: a2, sortOrder: 0 }] });
  expect(valid.status).toBe(200);
  expect(dataOf(valid)).toEqual({ message: 'Banners reordered successfully' });
  expect(await orders()).toEqual({ [a1]: 1, [a2]: 0, [b1]: 0 });
  expect((await widgetItemRow(b1))?.category_id).toBe(b.id);
});

// ------------------------------------------------------------ P. SDK serve ---

test('INAPP-273 serve a draft or paused widget', async () => {
  const p = await inAppProject('inapp-273');
  const { widget: draft } = await widgetWith(p, { name: 'Draft widget' }, [{ title: 'Draft item' }]);
  const { widget: paused } = await widgetWith(p, { name: 'Paused widget' }, [{ title: 'Paused item' }], 'paused');
  const { widget: active } = await widgetWith(p, { name: 'Active widget' }, [{ title: 'Active item' }], 'active');

  for (const widget of [draft, paused]) {
    const served = await serveWidget(widget.id, p.sdkKey);
    expect(served.status, widget.name).toBe(404);
    expect(messageOf(served), widget.name).toBe(WIDGET_NOT_ACTIVE);
  }
  // Control: the active one is served and records its impression.
  const served = await serveWidget(active.id, p.sdkKey);
  expect(served.status).toBe(200);
  expect(dataOf(served).banners.map((x: { title: string }) => x.title)).toEqual(['Active item']);
  await expect.poll(async () => (await widgetEventRows(active.id)).length).toBe(1);
  expect(await widgetEventRows(draft.id)).toEqual([]);
  expect(await widgetEventRows(paused.id)).toEqual([]);
});

// ------------------------------------------------------------ Q. Widget analytics API ---

test('INAPP-280 summary', async () => {
  const p = await inAppProject('inapp-280');
  const member = await teammate(p.project.id, 'member', p.owner);
  const { widget, items } = await widgetWith(p, { name: 'Counted carousel' }, [{ title: 'c1' }, { title: 'c2' }, { title: 'c3' }], 'active');
  const [ipA, ipB] = [newClientIp(), newClientIp()];
  await widgetTraffic(p, widget.id, 2, [{ bannerId: items[0].id, ip: ipA }, { bannerId: items[1].id, ip: ipB }], [ipA, ipB]);
  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(8);

  const summary = await call('GET', `/api/banner-categories/${widget.id}/analytics`, member);
  expect(summary.status).toBe(200);
  const data = dataOf(summary);
  expect(data).toMatchObject({ totalImpressions: 6, totalClicks: 2, uniqueVisitors: 2 });
  expect(data.ctr).toBeCloseTo(1 / 3, 10);
  expect(Object.keys(data).sort()).toEqual(['ctr', 'totalClicks', 'totalImpressions', 'uniqueVisitors']);
});

// ------------------------------------------------------------ R. Permissions, tenancy, view-as ---

/** One role's pass over the widget flows, in a browser of its own. */
async function manageWidgets(browser: Browser, baseURL: string | undefined, p: InAppProject, person: { email: string; password: string; userId: string }, label: string) {
  const { context } = await newPersonContext(browser, baseURL);
  const page = await context.newPage();
  try {
    await signIn(page, person);
    const name = `${label} carousel`;
    await page.goto(`/projects/${p.project.id}/widgets/carousels/new`);
    await page.getByLabel('Name').fill(name);
    const created = apiResponse(page, 'POST', `/api/projects/${p.project.id}/banner-categories`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    expect((await created).status(), label).toBe(201);
    await expect(toastWithTitle(page, 'Carousel created')).toBeVisible();
    await page.waitForURL(new RegExp(`/widgets/carousels/[0-9a-f-]{36}$`));
    const id = page.url().split('/').pop()!;

    for (const title of [`${label} one`, `${label} two`]) {
      await clearToasts(page);
      await page.getByRole('button', { name: 'Add Item', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add Item' });
      await dialogField(dialog, 'Title *').fill(title);
      await dialogField(dialog, 'Image URL *').fill('https://example.com/item.png');
      await dialogField(dialog, 'Click URL *').fill('https://example.com/item');
      const added = page.waitForResponse(isItemPost);
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      expect((await added).status(), `${label}: ${title}`).toBe(201);
      await expect(toastWithTitle(page, 'Banner added')).toBeVisible();
    }
    await expect(itemTitlesShown(page)).toHaveText([`${label} one`, `${label} two`]);

    const reordered = apiResponse(page, 'PATCH', `/api/banner-categories/${id}/banners/reorder`);
    await widgetItemCard(page, `${label} one`).getByRole('button', { name: 'Move down' }).click();
    expect((await reordered).status(), label).toBe(200);
    await expect(itemTitlesShown(page)).toHaveText([`${label} two`, `${label} one`]);

    const status = apiResponse(page, 'PATCH', `/api/banner-categories/${id}/status`);
    await chooseOption(page.getByRole('combobox'), 'Active');
    expect((await status).status(), label).toBe(200);
    await expect(detailBadge(page, name).getByText('Active', { exact: true })).toBeVisible();

    await clearToasts(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Edit Widget Settings' });
    await dialogField(settings, 'Heading').fill(`${label} heading`);
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toastWithTitle(page, 'Settings updated')).toBeVisible();

    expect(await widgetRow(id), label).toMatchObject({ name, status: 'active', heading: `${label} heading` });
    expect((await widgetItemRows(id)).map((r) => r.title), label).toEqual([`${label} two`, `${label} one`]);

    await page.goto(`/projects/${p.project.id}/widgets/carousels`);
    await widgetListRow(page, name).click();
    page.once('dialog', (dialog) => void dialog.accept());
    const deleted = apiResponse(page, 'DELETE', `/api/banner-categories/${id}`);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await deleted).status(), label).toBe(200);
    await expect(widgetListRow(page, name)).toHaveCount(0);
    expect(await widgetRow(id), label).toBeUndefined();
    const entries = (await activityRows(p.project.id, 'content.deleted')).filter((e) => e.target_id === id);
    expect(entries, label).toHaveLength(1);
    expect(entries[0].actor_user_id, label).toBe(person.userId);
  } finally {
    await context.close();
  }
}

test('INAPP-284 member and admin can manage widgets', async ({ browser, baseURL }) => {
  test.slow();
  const p = await inAppProject('inapp-284');
  const member = await teammate(p.project.id, 'member', p.owner);
  const admin = await teammate(p.project.id, 'admin', p.owner);
  await manageWidgets(browser, baseURL, p, member, 'Member');
  await manageWidgets(browser, baseURL, p, admin, 'Admin');
});

test('INAPP-287 outsider opening the pages', async ({ page }) => {
  const p = await inAppProject('inapp-287');
  const secret = `Private ${randomBytes(3).toString('hex')}`;
  await createInAppMessage(p.owner, p.project.id, { name: `${secret} message` });
  const { widget, items } = await widgetWith(p, { name: `${secret} widget` }, [{ title: `${secret} item` }]);
  const outsider = await newPerson('inapp-287-outsider');
  await inAppProject('inapp-287-own', outsider);

  await signIn(page, outsider);
  // Every request the pages make for P's own data (the project itself, messages, widgets).
  const forP: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/') && (path.includes(p.project.id) || path.includes(widget.id))) forP.push(`${r.method()} ${path}`);
  });
  const projectAnswers: number[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === `/api/projects/${p.project.id}`) projectAnswers.push(r.status());
  });

  // The project shell finds no such project for this account and sends them to the selector.
  for (const path of ['in-app-messages', `widgets/carousels`, `widgets/carousels/${widget.id}`, `widgets/carousels/${widget.id}/items/${items[0].id}/report`]) {
    await page.goto(`/projects/${p.project.id}/${path}`);
    await expect(page, path).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { name: 'Your Projects' }), path).toBeVisible();
    await expect(page.getByText(secret), path).toHaveCount(0);
    expect(await page.locator('body').innerText(), path).not.toContain(secret);
  }
  // Only the project lookup was asked for, and it was refused; no message or widget data was requested.
  expect(projectAnswers.length).toBeGreaterThan(0);
  expect(projectAnswers.every((status) => status === 404)).toBe(true);
  expect(forP.filter((r) => r !== `GET /api/projects/${p.project.id}`)).toEqual([]);
});

test('INAPP-289 view-as can read in-app pages', async ({ page, browser, baseURL }) => {
  const p = await inAppProject('inapp-289');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'VA readable message', title: 'Readable title' });
  const { widget, items } = await widgetWith(p, { name: 'VA readable carousel' }, [{ title: 'VA readable item', clickUrl: 'https://example.com/readable' }]);
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);

  await page.goto(`/projects/${p.project.id}/in-app-messages`);
  await expect(page.getByText('VA readable message', { exact: true })).toBeVisible();
  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'VA readable message', exact: true })).toBeVisible();
  await page.goto(`/projects/${p.project.id}/widgets/carousels`);
  await expect(widgetListRow(page, 'VA readable carousel').getByText('1 slide', { exact: true })).toBeVisible();
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'VA readable carousel', exact: true })).toBeVisible();
  await expect(widgetItemCard(page, 'VA readable item')).toBeVisible();
  await page.goto(`/projects/${p.project.id}/widgets/carousels/${widget.id}/items/${items[0].id}/report`);
  await expect(page.getByRole('heading', { level: 1, name: 'VA readable item', exact: true })).toBeVisible();
  await expect(page.getByText('https://example.com/readable', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Impersonation session' })).toBeVisible();
});

test('INAPP-292 view-as sees only the tenant\'s billed projects', async ({ page, browser, baseURL }) => {
  const p = await inAppProject('inapp-292');
  const joined = await inAppProject('inapp-292-joined');
  await sql(
    `INSERT INTO project_members (project_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'member', $3, clock_timestamp())`,
    [joined.project.id, p.owner.userId, joined.owner.userId],
  );
  await createInAppMessage(joined.owner, joined.project.id, { name: 'Joined message' });
  await createWidget(joined.owner, joined.project.id, { name: 'Joined widget' });
  // Control: the tenant's own session reads the joined project as a member.
  expect((await call('GET', `/api/projects/${joined.project.id}/in-app-messages`, p.owner)).status).toBe(200);
  expect((await call('GET', `/api/projects/${joined.project.id}/banner-categories`, p.owner)).status).toBe(200);

  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);
  const viewAs = { accessToken: await viewAsTokenOf(page), ip: newClientIp() };
  // Control: view-as reads the tenant's own billed project.
  expect((await call('GET', `/api/projects/${p.project.id}/in-app-messages`, viewAs)).status).toBe(200);
  expect((await call('GET', `/api/projects/${p.project.id}/banner-categories`, viewAs)).status).toBe(200);

  for (const path of [`/api/projects/${joined.project.id}/in-app-messages`, `/api/projects/${joined.project.id}/banner-categories`]) {
    const result = await call('GET', path, viewAs);
    expect(result.status, path).toBe(404);
    expect(messageOf(result), path).toBe(PROJECT_NOT_FOUND);
    expect(result.text, path).not.toContain('Joined');
  }
});

import type { Page, Request, Response } from '@playwright/test';
import { api, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../../support/api';
import { allowClipboard, decodeQr, readClipboard } from '../../support/browser-tools';
import { expect, signIn, test } from '../../support/fixtures';
import { stackEnv } from '../../support/stack';
import {
  activityEntries,
  addProjectMember,
  barListRows,
  clickFrom,
  datetimeLocal,
  deferredMatch,
  IPHONE_UA,
  labelledBlock,
  linkActionsButton,
  openShortLink,
  openShortLinkWith,
  openViewAs,
  PIXEL_UA,
  pngBytes,
  pngWidth,
  rawApi,
  recordConversion,
  seedLink,
  seedVariant,
  sql,
  startViewAs,
  statTile,
  stubMapTiles,
  toast,
  uniqueCode,
  variantRow,
  waitForClicks,
  WINDOWS_CHROME_UA,
  type SeededLink,
} from '../../support/areas/link';

/**
 * Links, second pass of the detail page and the API: stat tiles on a web-only link, the
 * click trend ranges, copy and QR, devices, geography, referrers and the funnel, the
 * actions menu, view-as, A/B variants (refused adds, delete, API validation and
 * updates, deep-link overrides), the edit page (prefill, validation, extending an
 * expired link), deleting twice, the link and QR routes, the activity entries, and the
 * link analytics routes.
 */

test.describe.configure({ mode: 'parallel' });

const PROJECT_NOT_FOUND = 'Project not found';
const DAY_MS = 24 * 60 * 60 * 1000;

async function ownerWithProject(ip: string, label = 'links'): Promise<{ owner: Account; project: Project }> {
  const owner = await createAccount(ip, label, 'Lina Links');
  const project = await createProject(owner, ip);
  return { owner, project };
}

/** 'MMM d' as date-fns writes it for the dashboard's chart axis. */
function axisLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The page's next timeseries response for `granularity`, with its request's query. */
function nextTimeseries(page: Page, linkId: string, granularity: string): Promise<Response> {
  return page.waitForResponse((r) => {
    const url = new URL(r.url());
    return url.pathname.endsWith(`/api/links/${linkId}/analytics/timeseries`) && url.searchParams.get('granularity') === granularity;
  });
}

/** Opens the link's detail page and waits for its tiles. */
async function openDetail(page: Page, projectId: string, linkId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/links/${linkId}`);
  await expect(page.getByText('Total Clicks', { exact: true })).toBeVisible();
}

/** The edit page once its form holds the link's stored values. */
async function openEdit(page: Page, projectId: string, link: { id: string; longUrl: string }): Promise<void> {
  await page.goto(`/projects/${projectId}/links/${link.id}/edit`);
  await expect(page.getByRole('heading', { name: 'Edit Link' })).toBeVisible();
  await expect(page.getByPlaceholder('https://example.com/page')).toHaveValue(link.longUrl);
}

/** The edit page's textarea or input in the block labelled `label` (its labels are not associated). */
function editField(page: Page, label: string, tag: 'input' | 'textarea' = 'input') {
  return page.locator('div.space-y-2', { has: page.getByText(label, { exact: true }) }).locator(tag);
}

function recordPatches(page: Page, linkId: string): Request[] {
  const patches: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/links/${linkId}`) patches.push(request);
  });
  return patches;
}

/** A card of the detail page by its title. */
function card(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: new RegExp(`^${title}$`) }) });
}

function textOf(rows: string[]): string[] {
  return rows.map((row) => row.replace(/\s+/g, ' ').trim());
}

// ---- E. Link detail

test('LINK-087 deep-link tiles read "Not configured" on a web-only link', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const apiKey = await createApiKey(owner, project.id, clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/web-only', shortCode: uniqueCode('webonly') });
  for (const ip of [newClientIp(), newClientIp()]) expect((await openShortLink(link.shortCode, ip)).status).toBe(302);
  await waitForClicks(link.id, 2);

  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await expect(labelledBlock(page, 'Total Clicks')).toHaveText(/^Total Clicks\s*2$/);
  await expect(labelledBlock(page, 'Unique Visitors')).toHaveText(/^Unique Visitors\s*2$/);
  await expect(statTile(page, 'Total Clicks')).not.toHaveClass(/opacity-40/);
  for (const label of ['Store Redirects', 'Installs', 'Conversion']) {
    await expect(labelledBlock(page, label)).toHaveText(new RegExp(`^${label}\\s*Not configured$`));
    await expect(statTile(page, label)).toHaveClass(/opacity-40/);
  }

  // A tile dims only while its value is zero: one signup gives the conversion a value.
  await recordConversion(apiKey, link.id, 'signup', clientIp);
  await page.reload();
  await expect(labelledBlock(page, 'Conversion')).toHaveText(/^Conversion\s*50\.0%$/);
  await expect(statTile(page, 'Conversion')).not.toHaveClass(/opacity-40/);
  await expect(labelledBlock(page, 'Installs')).toHaveText(/^Installs\s*Not configured$/);
  await expect(statTile(page, 'Store Redirects')).toHaveClass(/opacity-40/);
});

test('LINK-088 Click Trends ranges and their requests', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/trends', shortCode: uniqueCode('trends') });
  await clickFrom(link, newClientIp());
  const old = await clickFrom(link, newClientIp());
  await sql(`UPDATE click_events SET clicked_at = clicked_at - interval '20 days' WHERE id = $1`, [old]);

  await signIn(page, owner);
  const weekly = nextTimeseries(page, link.id, 'day');
  await page.goto(`/projects/${project.id}/links/${link.id}`);
  const seven = await weekly;
  const sevenQuery = new URL(seven.url()).searchParams;
  const span = (q: URLSearchParams) => (Date.parse(q.get('end')!) - Date.parse(q.get('start')!)) / DAY_MS;
  expect(span(sevenQuery)).toBeCloseTo(7, 3);
  expect(Math.abs(Date.parse(sevenQuery.get('end')!) - Date.now())).toBeLessThan(60_000);
  const sevenPoints = ((await seven.json()) as { data: { date: string; clicks: number }[] }).data;
  expect(sevenPoints.map((p) => p.clicks)).toEqual([1]);

  const trends = page.locator('[data-slot="card"]', { has: page.getByText('Click Trends', { exact: true }) });
  const ticks = trends.locator('.recharts-xAxis .recharts-cartesian-axis-tick-value');
  await expect(ticks).toHaveText([axisLabel(new Date(sevenPoints[0].date))]);
  await expect(page.getByRole('button', { name: '7d', exact: true })).toHaveAttribute('data-variant', 'default');
  await expect(page.getByRole('button', { name: '30d', exact: true })).toHaveAttribute('data-variant', 'outline');

  const monthly = nextTimeseries(page, link.id, 'day');
  await page.getByRole('button', { name: '30d', exact: true }).click();
  const thirty = await monthly;
  expect(span(new URL(thirty.url()).searchParams)).toBeCloseTo(30, 3);
  const thirtyPoints = ((await thirty.json()) as { data: { date: string; clicks: number }[] }).data;
  expect(thirtyPoints.map((p) => p.clicks)).toEqual([1, 1]);
  await expect(ticks).toHaveText(thirtyPoints.map((p) => axisLabel(new Date(p.date))));
  await expect(page.getByRole('button', { name: '30d', exact: true })).toHaveAttribute('data-variant', 'default');
  await expect(page.getByRole('button', { name: '7d', exact: true })).toHaveAttribute('data-variant', 'outline');

  const quarterly = nextTimeseries(page, link.id, 'week');
  await page.getByRole('button', { name: '90d', exact: true }).click();
  const ninety = await quarterly;
  expect(span(new URL(ninety.url()).searchParams)).toBeCloseTo(90, 3);
  await expect(page.getByRole('button', { name: '90d', exact: true })).toHaveAttribute('data-variant', 'default');
});

test('LINK-090 copy the short URL from the detail page', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('copy-detail');
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/copy', shortCode: code });
  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await allowClipboard(page);

  const copy = labelledBlock(page, 'Short URL').getByRole('button').first();
  await expect(copy.locator('svg.lucide-copy')).toBeVisible();
  const clickedAt = Date.now();
  await copy.click();
  await expect(copy.locator('svg.text-green-600')).toBeVisible();
  expect(await readClipboard(page)).toBe(`${new URL(page.url()).origin}/${code}`);
  // Back to the copy icon after about two seconds.
  await expect(copy.locator('svg.text-green-600')).toHaveCount(0, { timeout: 5000 });
  const shownFor = Date.now() - clickedAt;
  expect(shownFor).toBeGreaterThanOrEqual(1500);
  expect(shownFor).toBeLessThan(4000);
  await expect(copy.locator('svg.lucide-copy')).toBeVisible();
});

test('LINK-092 QR code dialog shows a scannable code for the short link', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('qr-me');
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/qr', shortCode: code });
  await signIn(page, owner);

  // Hold the QR request (made when the page loads) until the dialog is open.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/links/${link.id}/qr**`, async (route) => {
    await released;
    await route.continue();
  });
  await openDetail(page, project.id, link.id);
  await labelledBlock(page, 'Short URL').getByRole('button').nth(1).click();
  const dialog = page.getByRole('dialog', { name: 'QR Code' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('div.animate-pulse')).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'QR Code' })).toHaveCount(0);
  release();

  const origin = new URL(page.url()).origin;
  await expect(dialog).toHaveAccessibleDescription(`${origin}/${code}`);
  const image = dialog.getByRole('img', { name: 'QR Code' });
  await expect(image).toBeVisible();
  const src = (await image.getAttribute('src'))!;
  expect(decodeQr(pngBytes(src))).toBe(`${stackEnv().APP_URL}/${code}`);
  await expect(dialog.getByRole('button', { name: 'PNG' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'SVG' })).toBeVisible();
  await expect(dialog.locator('div.animate-pulse')).toHaveCount(0);
});

test('LINK-094 Devices & Browsers breakdown', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/devices', shortCode: uniqueCode('devices') });
  // Two iPhones, a Pixel, a Windows PC, and a client whose user agent names no OS or browser.
  for (const ua of [IPHONE_UA, IPHONE_UA, PIXEL_UA, WINDOWS_CHROME_UA, 'curl/8.4.0']) {
    expect((await openShortLink(link.shortCode, newClientIp(), ua)).status).toBe(302);
  }
  await waitForClicks(link.id, 5);

  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await expect(page.getByRole('heading', { name: 'Device Type', exact: true })).toBeVisible();
  await expect(page.locator('.recharts-legend-item-text')).toHaveText(['mobile', 'desktop']);
  // The client with no OS is left out of the OS list, so the shares are of four.
  await expect(barListRows(page, 'Operating System')).toHaveCount(3);
  expect(textOf(await barListRows(page, 'Operating System').allTextContents())).toEqual(['iOS250%', 'Android125%', 'Windows125%']);
  await expect(barListRows(page, 'Browser')).toHaveCount(2);
  expect(textOf(await barListRows(page, 'Browser').allTextContents()).sort()).toEqual(['Chrome250%', 'Mobile Safari250%']);
});

test('LINK-096 Geography tab with local clicks', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/geo', shortCode: uniqueCode('geo') });
  for (let i = 0; i < 3; i++) expect((await openShortLink(link.shortCode, '127.0.0.1')).status).toBe(302);
  await waitForClicks(link.id, 3);

  await stubMapTiles(page);
  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'Geography' }).click();
  await expect(page.getByText('Geographic Distribution', { exact: true })).toBeVisible();
  await expect(page.getByText('Where your clicks are coming from', { exact: true })).toBeVisible();

  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['#', 'State', 'Clicks', 'Share']);
  const rows = table.locator('tbody').getByRole('row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByRole('cell')).toHaveText(['1', /^Maharashtra\s*MH • IN$/, '3', '100.0%']);
  await expect(page.getByText('Sample data')).toHaveCount(0);

  const markers = page.locator('path.leaflet-interactive');
  await expect(markers).toHaveCount(1);
  await markers.first().hover();
  const tooltip = page.locator('.geo-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/Mumbai\s*India\s*3 clicks/);
});

test('LINK-100 Referrers table', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/refs', shortCode: uniqueCode('refs') });
  for (const referer of ['https://news.example.com/a', 'https://news.example.com/a', 'https://t.co/x']) {
    expect((await openShortLinkWith(link.shortCode, newClientIp(), { Referer: referer })).status).toBe(302);
  }
  expect((await openShortLink(link.shortCode, newClientIp())).status).toBe(302);
  await waitForClicks(link.id, 4);

  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'Referrers & Conversions' }).click();
  const referrers = card(page, 'Referrers');
  await expect(referrers.getByText('Where people are finding your link', { exact: true })).toBeVisible();
  await expect(referrers.getByRole('columnheader')).toHaveText(['Referrer', 'Clicks', 'Share']);
  const rows = referrers.locator('tbody').getByRole('row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole('cell')).toHaveText(['https://news.example.com/a', '2', '66.7%']);
  await expect(rows.nth(1).getByRole('cell')).toHaveText(['https://t.co/x', '1', '33.3%']);
  await expect(referrers.getByText('Direct / Unknown')).toHaveCount(0);
});

test('LINK-101 referrer with HTML is shown as text', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/xss', shortCode: uniqueCode('xss-ref') });
  const referer = 'https://x.example/"><img src=x onerror=alert(1)>';
  expect((await openShortLinkWith(link.shortCode, newClientIp(), { Referer: referer })).status).toBe(302);
  await waitForClicks(link.id, 1);

  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'Referrers & Conversions' }).click();
  const referrers = card(page, 'Referrers');
  const cell = referrers.locator('tbody').getByRole('row').first().getByRole('cell').first();
  await expect(cell).toHaveText(referer);
  // The cell holds one text node and nothing the browser could run.
  expect(await cell.evaluate((el) => Array.from(el.childNodes, (n) => n.nodeName))).toEqual(['#text']);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('LINK-103 conversion funnel', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const apiKey = await createApiKey(owner, project.id, clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/funnel', shortCode: uniqueCode('funnel') });
  const visitors = Array.from({ length: 10 }, () => newClientIp());
  for (const ip of visitors) expect((await openShortLink(link.shortCode, ip)).status).toBe(302);
  await waitForClicks(link.id, 10);
  for (const ip of visitors.slice(0, 2)) {
    const match = await deferredMatch(apiKey, ip, { cookieRef: link.shortCode });
    expect(match.body.data.matched).toBe(true);
  }
  for (const eventType of ['signup', 'purchase', 'purchase']) await recordConversion(apiKey, link.id, eventType, clientIp);

  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'Referrers & Conversions' }).click();
  const funnel = card(page, 'Conversion Funnel');
  await expect(funnel.getByText('From click to install to conversion', { exact: true })).toBeVisible();
  const rate = (label: string) => funnel.getByText(label, { exact: true }).locator('xpath=..');
  await expect(rate('Store Redirect Rate')).toHaveText(/^Store Redirect Rate\s*0\.0%$/);
  await expect(rate('Install Rate')).toHaveText(/^Install Rate\s*20\.0%$/);
  // The bar counts every conversion; the rate counts signups only.
  await expect(rate('Conversion Rate')).toHaveText(/^Conversion Rate\s*10\.0%$/);

  // Each bar's value, read from the chart's tooltip over its row.
  const stages = funnel.locator('.recharts-yAxis .recharts-cartesian-axis-tick-value');
  await expect(stages).toHaveText(['Clicks', 'Store Redirects', 'Installs', 'Conversions']);
  await funnel.locator('.recharts-wrapper').scrollIntoViewIfNeeded();
  const plot = (await funnel.locator('.recharts-cartesian-grid').boundingBox())!;
  const tooltip = funnel.locator('.recharts-tooltip-wrapper');
  const expected: Record<string, number> = { Clicks: 10, 'Store Redirects': 0, Installs: 2, Conversions: 3 };
  for (const [i, stage] of Object.keys(expected).entries()) {
    const tick = (await stages.nth(i).boundingBox())!;
    await page.mouse.move(plot.x + plot.width / 2, tick.y + tick.height / 2);
    await expect(tooltip).toHaveText(new RegExp(`^${stage}\\s*value\\s*:\\s*${expected[stage]}$`));
  }
});

test('LINK-107 actions menu items', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/menu', shortCode: uniqueCode('menu') });
  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await linkActionsButton(page).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Edit Link', 'Export CSV', 'Delete Link']);
  // The separator sits between Export CSV and Delete Link.
  const order = await menu.locator(':scope > *').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('role') === 'separator' ? '---' : n.textContent?.trim()));
  expect(order).toEqual(['Edit Link', 'Export CSV', '---', 'Delete Link']);
  await expect(menu.getByRole('menuitem', { name: 'Delete Link' })).toHaveClass(/(^|\s)text-destructive(\s|$)/);
  await expect(menu.getByRole('menuitem', { name: 'Edit Link' })).not.toHaveClass(/(^|\s)text-destructive(\s|$)/);

  await menu.getByRole('menuitem', { name: 'Edit Link' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}/edit$`));
  await expect(page.getByRole('heading', { name: 'Edit Link' })).toBeVisible();
});

test('LINK-110 detail page in view-as is readable', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('viewas');
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/view', shortCode: code, title: 'Viewed link' });
  await seedVariant(owner, link.id, clientIp, { name: 'Variant V', longUrl: 'https://example.com/view-v', weight: 40 });
  expect((await openShortLinkWith(link.shortCode, newClientIp(), { Referer: 'https://ref.example.com/p' })).status).toBe(302);
  expect((await openShortLink(link.shortCode, newClientIp(), IPHONE_UA)).status).toBe(302);
  await waitForClicks(link.id, 2);

  const viewAs = await openViewAs(browser, baseURL, await startViewAs(browser, baseURL, owner));
  const failures: string[] = [];
  viewAs.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  await stubMapTiles(viewAs);
  await openDetail(viewAs, project.id, link.id);
  await expect(labelledBlock(viewAs, 'Total Clicks')).toHaveText(/^Total Clicks\s*2$/);
  await expect(barListRows(viewAs, 'Operating System')).toHaveCount(2);
  await expect(labelledBlock(viewAs, 'Destination').getByRole('link')).toHaveText('https://example.com/view');

  await viewAs.getByRole('tab', { name: 'Geography' }).click();
  await expect(viewAs.getByRole('table').locator('tbody').getByRole('row').first()).toContainText('Maharashtra');

  await viewAs.getByRole('tab', { name: 'Referrers & Conversions' }).click();
  await expect(card(viewAs, 'Referrers').locator('tbody').getByRole('row').first()).toContainText('https://ref.example.com/p');
  await expect(card(viewAs, 'Conversion Funnel').getByText('Install Rate', { exact: true })).toBeVisible();

  await viewAs.getByRole('tab', { name: 'A/B Testing' }).click();
  await expect(variantRow(viewAs, 'Variant V')).toContainText('40% traffic');

  await viewAs.getByRole('tab', { name: 'Overview' }).click();
  await labelledBlock(viewAs, 'Short URL').getByRole('button').nth(1).click();
  const image = viewAs.getByRole('dialog', { name: 'QR Code' }).getByRole('img', { name: 'QR Code' });
  await expect(image).toBeVisible();
  expect(decodeQr(pngBytes((await image.getAttribute('src'))!))).toBe(`${stackEnv().APP_URL}/${code}`);

  await expect(toast(viewAs, 'Read-only session')).toHaveCount(0);
  expect(failures).toEqual([]);
  await viewAs.context().close();
});

// ---- F. A/B variants

async function openAddVariant(page: Page, projectId: string, link: SeededLink) {
  await openDetail(page, projectId, link.id);
  await page.getByRole('tab', { name: 'A/B Testing' }).click();
  await page.getByRole('button', { name: 'Add First Variant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add A/B Test Variant' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function submitVariant(page: Page, dialog: ReturnType<Page['getByRole']>, linkId: string, fields: { name: string; url: string; weight: string }) {
  await dialog.getByPlaceholder('e.g., Variant B').fill(fields.name);
  await dialog.getByPlaceholder('https://example.com/page-b').fill(fields.url);
  await dialog.locator('input[type=number]').fill(fields.weight);
  const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/links/${linkId}/variants`);
  await dialog.getByRole('button', { name: 'Add Variant' }).click();
  return answered;
}

test('LINK-114 variant refused by the API leaves the dialog open', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/v', shortCode: uniqueCode('badvar') });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await signIn(page, owner);
  const dialog = await openAddVariant(page, project.id, link);

  const badUrl = await submitVariant(page, dialog, link.id, { name: 'Bad', url: 'not a url', weight: '50' });
  expect(badUrl.status()).toBe(400);
  expect(((await badUrl.json()) as { message: string[] }).message).toContain('longUrl must be a URL address');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add Variant' })).toBeEnabled();

  const heavy = await submitVariant(page, dialog, link.id, { name: 'Bad', url: 'https://example.com/heavy', weight: '150' });
  expect(heavy.status()).toBe(400);
  expect(((await heavy.json()) as { message: string[] }).message).toContain('weight must not be greater than 100');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder('e.g., Variant B')).toHaveValue('Bad');
  await expect.poll(() => pageErrors).toEqual(['Request failed with status code 400', 'Request failed with status code 400']);
  // The open dialog hides the rest of the page from the accessibility tree, so look for the toast list by markup.
  const notifications = page.locator('[role="region"][aria-label^="Notifications"]');
  await expect(notifications).toHaveCount(1);
  await expect(notifications.locator('li')).toHaveCount(0);
  await expect(dialog.getByText(/must be a URL|must not be greater/)).toHaveCount(0);
  const [rows] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM link_variants WHERE link_id = $1', [link.id]);
  expect(rows.n).toBe('0');
});

test('LINK-114 variant refused by the API shows the reason', async ({ page, clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-114' });
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/v', shortCode: uniqueCode('badvar') });
  await signIn(page, owner);
  const dialog = await openAddVariant(page, project.id, link);
  const response = await submitVariant(page, dialog, link.id, { name: 'Bad', url: 'not a url', weight: '50' });
  expect(response.status()).toBe(400);
  await expect(page.getByText(/longUrl must be a URL address/)).toBeVisible({ timeout: 5000 });
});

test('LINK-116 delete a variant', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/del-var', shortCode: uniqueCode('delvar'), title: 'Variant host' });
  const a = await seedVariant(owner, link.id, clientIp, { name: 'A', longUrl: 'https://example.com/a', weight: 50 });
  const b = await seedVariant(owner, link.id, clientIp, { name: 'B', longUrl: 'https://example.com/b', weight: 50 });
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });

  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'A/B Testing' }).click();
  await expect(variantRow(page, 'A')).toHaveCount(1);
  await expect(variantRow(page, 'B')).toHaveCount(1);

  const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/variants/${b.id}`));
  await variantRow(page, 'B').getByRole('button').click();
  expect((await removed).status()).toBe(200);
  await expect(variantRow(page, 'B')).toHaveCount(0);
  await expect(variantRow(page, 'A')).toHaveCount(1);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(dialogs).toBe(0);
  const left = await sql<{ id: string }>('SELECT id FROM link_variants WHERE link_id = $1', [link.id]);
  expect(left).toEqual([{ id: a.id }]);
  const entries = await activityEntries(project.id, 'link.changed');
  expect(entries.at(-1)).toEqual({ target_label: 'Variant host', details: { change: 'removed', variant: 'B' } });

  // Deleting the last one brings back the empty state.
  await variantRow(page, 'A').getByRole('button').click();
  await expect(page.getByText('No variants configured', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add First Variant' })).toBeVisible();
});

test('LINK-117 variants API validation', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/validate' });
  const auth = { token: owner.accessToken, ip: clientIp };
  const url = `/api/links/${link.id}/variants`;
  const good = { name: 'Valid', longUrl: 'https://example.com/valid' };
  const cases: [Record<string, unknown>, string][] = [
    [{ longUrl: good.longUrl }, 'name must be a string'],
    [{ ...good, name: 'n'.repeat(256) }, 'name must be shorter than or equal to 255 characters'],
    [{ ...good, longUrl: 'x' }, 'longUrl must be a URL address'],
    [{ ...good, iosUrl: 'myapp://x' }, 'iosUrl must be a URL address'],
    [{ ...good, weight: 1.5 }, 'weight must be an integer number'],
    [{ ...good, weight: -1 }, 'weight must not be less than 0'],
    [{ ...good, clicks: 99 }, 'property clicks should not exist'],
    [{ ...good, linkId: link.id }, 'property linkId should not exist'],
  ];
  for (const [body, message] of cases) {
    const response = await rawApi<{ message: string[] }>('POST', url, body, auth);
    expect([message, response.status]).toEqual([message, 400]);
    expect(response.body.message).toContain(message);
  }
  const [none] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM link_variants WHERE link_id = $1', [link.id]);
  expect(none.n).toBe('0');

  const created = await rawApi<{ data: { id: string; weight: number } }>('POST', url, good, auth);
  expect(created.status).toBe(201);
  expect(created.body.data.weight).toBe(50);
  const stored = await sql<{ weight: number }>('SELECT weight FROM link_variants WHERE id = $1', [created.body.data.id]);
  expect(stored).toEqual([{ weight: 50 }]);
});

test('LINK-118 update a variant through the API', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/update-var', title: 'Update host' });
  const variant = await seedVariant(owner, link.id, clientIp, { name: 'B', longUrl: 'https://example.com/b', weight: 50 });
  const auth = { token: owner.accessToken, ip: clientIp };
  const url = `/api/links/${link.id}/variants/${variant.id}`;
  expect(await activityEntries(project.id, 'link.changed')).toHaveLength(1); // the add

  const updated = await rawApi('PATCH', url, { weight: 80, name: 'B2' }, auth);
  expect(updated.status).toBe(200);
  expect(updated.body.data).toMatchObject({ id: variant.id, name: 'B2', weight: 80 });
  expect(await sql('SELECT name, weight, long_url FROM link_variants WHERE id = $1', [variant.id])).toEqual([
    { name: 'B2', weight: 80, long_url: 'https://example.com/b' },
  ]);
  let entries = await activityEntries(project.id, 'link.changed');
  expect(entries).toHaveLength(2);
  expect(entries[1]).toEqual({ target_label: 'Update host', details: { change: 'changed', fields: ['name', 'weight'], variant: 'B2' } });

  const clicks = await rawApi('PATCH', url, { clicks: 0 }, auth);
  expect([clicks.status, clicks.body.message]).toEqual([400, ['property clicks should not exist']]);

  const empty = await rawApi('PATCH', url, {}, auth);
  expect(empty.status).toBe(200);
  entries = await activityEntries(project.id, 'link.changed');
  expect(entries).toHaveLength(2);
  expect(await sql('SELECT name, weight FROM link_variants WHERE id = $1', [variant.id])).toEqual([{ name: 'B2', weight: 80 }]);
});

test('LINK-123 variant overrides deep links only where set', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/main',
    shortCode: uniqueCode('override'),
    iosUrl: 'https://example.com/ios-main',
    androidUrl: 'https://example.com/and-main',
  });
  await api(
    'POST',
    `/api/links/${link.id}/variants`,
    { name: 'V', longUrl: 'https://example.com/v', iosUrl: 'https://example.com/ios-v', weight: 100 },
    { token: owner.accessToken, ip: clientIp },
  );
  const deepLink = (html: string) => JSON.parse(/var deepLink = ("(?:[^"\\]|\\.)*");/.exec(html)?.[1] ?? 'null') as string | null;

  const iphone = await openShortLink(link.shortCode, newClientIp(), IPHONE_UA);
  expect(iphone.status).toBe(200);
  expect(deepLink(iphone.body as string)).toBe('https://example.com/ios-v');
  const android = await openShortLink(link.shortCode, newClientIp(), PIXEL_UA);
  expect(android.status).toBe(200);
  expect(deepLink(android.body as string)).toBe('https://example.com/and-main');
  const desktop = await openShortLink(link.shortCode, newClientIp());
  expect([desktop.status, desktop.location]).toEqual([302, 'https://example.com/v']);
});

// ---- G. Edit link

test('LINK-126 edit page is prefilled', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('prefill');
  const created = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/full',
    shortCode: code,
    title: 'Everything set',
    tags: ['a', 'b'],
    iosUrl: 'https://example.com/app/ios',
    androidUrl: 'https://example.com/app/android',
    iosFallbackUrl: 'https://example.com/ios-fallback',
    androidFallbackUrl: 'https://example.com/android-fallback',
    ogTitle: 'OG title',
    ogDescription: 'OG description',
    ogImageUrl: 'https://example.com/og.png',
    deepLinkParams: { screen: 'p' },
    expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    isActive: false,
  });
  const stored = await api<{ expiresAt: string; isActive: boolean }>('GET', `/api/links/${created.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(stored.isActive).toBe(false);

  await signIn(page, owner);
  await openDetail(page, project.id, created.id);
  await linkActionsButton(page).click();
  await page.getByRole('menuitem', { name: 'Edit Link' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Link' })).toBeVisible();
  await expect(page.getByText('Short code:')).toHaveText(`Short code: ${code}`);
  await expect(page.getByPlaceholder('https://example.com/page')).toHaveValue('https://example.com/full');
  await expect(page.getByPlaceholder('My awesome link')).toHaveValue('Everything set');
  await expect(page.getByPlaceholder('marketing, summer-campaign')).toHaveValue('a, b');
  // No field holds the short code: it cannot be changed here.
  const values = await page.locator('input, textarea').evaluateAll((nodes) => nodes.map((n) => (n as HTMLInputElement).value));
  expect(values).not.toContain(code);

  await page.getByRole('tab', { name: 'Deep Linking' }).click();
  await expect(page.getByPlaceholder('myapp://path').nth(0)).toHaveValue('https://example.com/app/ios');
  await expect(page.getByPlaceholder('myapp://path').nth(1)).toHaveValue('https://example.com/app/android');
  await expect(page.getByPlaceholder('https://apps.apple.com/...')).toHaveValue('https://example.com/ios-fallback');
  await expect(page.getByPlaceholder('https://play.google.com/...')).toHaveValue('https://example.com/android-fallback');
  await expect(editField(page, 'Deep Link Parameters (JSON)', 'textarea')).toHaveValue('{\n  "screen": "p"\n}');

  await page.getByRole('tab', { name: 'Social Preview' }).click();
  await expect(editField(page, 'OG Title')).toHaveValue('OG title');
  await expect(editField(page, 'OG Description', 'textarea')).toHaveValue('OG description');
  await expect(editField(page, 'OG Image URL')).toHaveValue('https://example.com/og.png');

  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('input[type=datetime-local]')).toHaveValue(stored.expiresAt.slice(0, 16));
  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
});

test('LINK-128 edit validation messages', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/valid', shortCode: uniqueCode('editval') });
  await signIn(page, owner);
  const patches = recordPatches(page, link.id);
  await openEdit(page, project.id, link);

  await page.getByPlaceholder('https://example.com/page').fill('');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Must be a valid URL', { exact: true })).toBeVisible();

  await page.getByPlaceholder('https://example.com/page').fill('https://example.com/valid');
  await page.getByRole('tab', { name: 'Deep Linking' }).click();
  await editField(page, 'Deep Link Parameters (JSON)', 'textarea').fill('{bad');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  const invalid = toast(page, 'Invalid JSON');
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('Deep link params must be valid JSON');
  await expect(page).toHaveURL(new RegExp(`/links/${link.id}/edit$`));

  // A valid save sends its PATCH, so the two refusals above sent none.
  await editField(page, 'Deep Link Parameters (JSON)', 'textarea').fill('{"ok": true}');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(toast(page, 'Link updated')).toBeVisible();
  expect(patches).toHaveLength(1);
});

test('LINK-133 extend an expired link', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/extended',
    shortCode: uniqueCode('extend'),
    title: 'Extend me',
    expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
  });
  const before = await openShortLink(link.shortCode, newClientIp());
  expect([before.status, before.body.message]).toEqual([404, 'Link has expired']);

  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await expect(page.getByRole('link', { name: 'Extend me Expired' })).toBeVisible();
  await openEdit(page, project.id, link);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const expiry = page.locator('input[type=datetime-local]');
  await expect(expiry).not.toHaveValue('');
  await expiry.fill(datetimeLocal(new Date(Date.now() + 7 * DAY_MS)));
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(toast(page, 'Link updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));
  await expect(page.getByRole('link', { name: 'Extend me Active' })).toBeVisible();
  const after = await openShortLink(link.shortCode, newClientIp());
  expect([after.status, after.location]).toEqual([302, 'https://example.com/extended']);

  await openEdit(page, project.id, link);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(expiry).not.toHaveValue('');
  await expiry.fill('');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(toast(page, 'Link updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));
  await expect(labelledBlock(page, 'Expires')).toHaveText(/^Expires\s*Never$/);
  const stored = await api<{ expiresAt: string | null }>('GET', `/api/links/${link.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(stored.expiresAt).toBeNull();
});

// ---- H. Delete link

test('LINK-141 deleting twice writes one entry', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const admin = await addProjectMember(owner, project.id, 'admin', clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/twice', title: 'Twice' });
  const url = `/api/links/${link.id}`;

  const answers = await Promise.all([
    rawApi('DELETE', url, undefined, { token: owner.accessToken, ip: clientIp }),
    rawApi('DELETE', url, undefined, { token: admin.accessToken, ip: newClientIp() }),
  ]);
  const sorted = [...answers].sort((a, b) => a.status - b.status);
  expect(sorted.map((a) => a.status)).toEqual([200, 404]);
  expect(sorted[0].body).toEqual({ data: { message: 'Link deleted successfully' } });
  expect(['Link not found', PROJECT_NOT_FOUND]).toContain(sorted[1].body.message);

  const third = await rawApi('DELETE', url, undefined, { token: owner.accessToken, ip: clientIp });
  expect([third.status, third.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const entries = await activityEntries(project.id, 'content.deleted');
  expect(entries).toEqual([expect.objectContaining({ target_label: 'Twice', details: expect.objectContaining({ kind: 'link' }) })]);
});

// ---- I. Links API: access, QR and activity

test('LINK-147 get one link through the API', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const member = await addProjectMember(owner, project.id, 'member', clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/one',
    shortCode: uniqueCode('get-one'),
    title: 'One link',
    tags: ['x'],
    iosUrl: 'https://example.com/app/one',
    deepLinkParams: { k: 'v' },
  });

  const response = await rawApi('GET', `/api/links/${link.id}`, undefined, { token: member.accessToken, ip: clientIp });
  expect(response.status).toBe(200);
  expect(Object.keys(response.body)).toEqual(['data']);
  const data = response.body.data as Record<string, unknown>;
  expect(Object.keys(data).sort()).toEqual(
    [
      'id', 'shortCode', 'longUrl', 'title', 'tags', 'isActive', 'expiresAt', 'iosUrl', 'androidUrl', 'iosFallbackUrl',
      'androidFallbackUrl', 'ogTitle', 'ogDescription', 'ogImageUrl', 'deepLinkParams', 'projectId', 'createdAt', 'updatedAt', 'project',
    ].sort(),
  );
  expect(data).toMatchObject({
    id: link.id,
    shortCode: link.shortCode,
    longUrl: 'https://example.com/one',
    title: 'One link',
    tags: ['x'],
    isActive: true,
    expiresAt: null,
    iosUrl: 'https://example.com/app/one',
    androidUrl: null,
    deepLinkParams: { k: 'v' },
    projectId: project.id,
    project: { id: project.id, name: project.name },
  });
});

test('LINK-148 QR code API formats and sizes', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('qr-api');
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/qr-api', shortCode: code });
  const auth = { token: owner.accessToken, ip: clientIp };
  const qr = async (query: string) => {
    const response = await rawApi<{ data: { qrCode: string; format: string; shortUrl: string } }>('GET', `/api/links/${link.id}/qr${query}`, undefined, auth);
    expect([query, response.status]).toEqual([query, 200]);
    return response.body.data;
  };
  const shortUrl = `${stackEnv().APP_URL}/${code}`;

  const png = await qr('');
  expect(png).toMatchObject({ format: 'png', shortUrl });
  expect(png.qrCode.startsWith('data:image/png;base64,')).toBe(true);
  expect(pngWidth(png.qrCode)).toBe(300);
  expect(decodeQr(pngBytes(png.qrCode))).toBe(shortUrl);

  const svg = await qr('?format=svg');
  expect(svg.format).toBe('svg');
  expect(svg.qrCode.startsWith('<svg')).toBe(true);

  const gif = await qr('?format=gif');
  expect(gif.format).toBe('png');
  expect(pngWidth(gif.qrCode)).toBe(300);

  expect(pngWidth((await qr('?size=10')).qrCode)).toBe(64);
  expect(pngWidth((await qr('?size=5000')).qrCode)).toBe(1024);
  expect(pngWidth((await qr('?size=abc')).qrCode)).toBe(300);

  const sized = await qr('?size=500&format=svg');
  expect(sized.format).toBe('svg');
  expect(sized.qrCode).toMatch(/^<svg[^>]*\swidth="500"/);
});

test('LINK-149 link changes are logged without URLs', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/promo', title: 'Promo' });
  const auth = { token: owner.accessToken, ip: clientIp };
  const linkRows = () => sql('SELECT action FROM project_activity WHERE project_id = $1 AND target_id = $2', [project.id, link.id]);
  expect(await linkRows()).toEqual([]); // creating the link wrote nothing

  await api('PATCH', `/api/links/${link.id}`, { longUrl: 'https://example.com/x', deepLinkParams: { a: 1 } }, auth);
  await api('POST', `/api/links/${link.id}/variants`, { name: 'VB', longUrl: 'https://example.com/vb', weight: 30 }, auth);

  const rows = await sql<{ action: string; target_type: string; target_label: string; details: unknown }>(
    'SELECT action, target_type, target_label, details FROM project_activity WHERE project_id = $1 AND target_id = $2 ORDER BY occurred_at, id',
    [project.id, link.id],
  );
  expect(rows).toEqual([
    { action: 'link.changed', target_type: 'link', target_label: 'Promo', details: { fields: ['longUrl', 'deepLinkParams'] } },
    { action: 'link.changed', target_type: 'link', target_label: 'Promo', details: { change: 'added', fields: ['name', 'longUrl', 'weight'], variant: 'VB' } },
  ]);

  const page = await api<{ entries: { action: string; targetId: string | null }[] }>('GET', `/api/projects/${project.id}/activity`, undefined, auth);
  const ours = page.entries.filter((entry) => entry.targetId === link.id);
  expect(ours.map((entry) => entry.action)).toEqual(['link.changed', 'link.changed']);
  const text = JSON.stringify([ours, rows]);
  expect(text).not.toContain('example.com');
  expect(text).not.toMatch(/"a":1/);
});

// ---- J. Link analytics API

test('LINK-152 timeseries defaults and granularity', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/series', shortCode: uniqueCode('series') });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(await clickFrom(link, newClientIp()));
  // Two at the start of this hour, one 10 days and one 40 days before it.
  await sql(`UPDATE click_events SET clicked_at = date_trunc('hour', now()) WHERE id = ANY($1)`, [ids.slice(0, 2)]);
  await sql(`UPDATE click_events SET clicked_at = date_trunc('hour', now()) - interval '10 days' WHERE id = $1`, [ids[2]]);
  await sql(`UPDATE click_events SET clicked_at = date_trunc('hour', now()) - interval '40 days' WHERE id = $1`, [ids[3]]);
  const auth = { token: owner.accessToken, ip: clientIp };
  const series = async (query: string) => {
    const response = await rawApi<{ data: { date: string; clicks: number }[] }>('GET', `/api/links/${link.id}/analytics/timeseries${query}`, undefined, auth);
    expect([query, response.status]).toEqual([query, 200]);
    return response.body.data.map((point) => ({ date: new Date(point.date).toISOString(), clicks: point.clicks }));
  };
  /** The buckets the database itself makes of the link's clicks newer than `since`. */
  const buckets = async (unit: 'hour' | 'day' | 'week', since: string) =>
    (
      await sql<{ date: Date; clicks: number }>(
        `SELECT date_trunc('${unit}', clicked_at) AS date, count(*)::int AS clicks FROM click_events
          WHERE link_id = $1 AND clicked_at >= now() - $2::interval GROUP BY 1 ORDER BY 1`,
        [link.id, since],
      )
    ).map((row) => ({ date: row.date.toISOString(), clicks: row.clicks }));

  const byDefault = await series('');
  expect(byDefault).toHaveLength(2);
  expect(Object.keys((await rawApi('GET', `/api/links/${link.id}/analytics/timeseries`, undefined, auth)).body.data[0]).sort()).toEqual(['clicks', 'date']);
  expect(byDefault.map((p) => p.clicks)).toEqual([1, 2]);
  expect(byDefault).toEqual(await buckets('day', '30 days'));

  const start60 = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const weekly = await series(`?start=${encodeURIComponent(start60)}&granularity=week`);
  expect(weekly).toEqual(await buckets('week', '60 days'));
  expect(weekly.reduce((sum, p) => sum + p.clicks, 0)).toBe(4);
  expect(weekly).toHaveLength(3);

  const start3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const hourly = await series(`?granularity=hour&start=${encodeURIComponent(start3h)}`);
  expect(hourly).toEqual(await buckets('hour', '3 hours'));
  expect(hourly.map((p) => p.clicks)).toEqual([2]);

  // Only hour, day and week reach the query; anything else is a day.
  expect(await series('?granularity=month')).toEqual(byDefault);
  expect(await series(`?granularity=${encodeURIComponent('day;DROP')}`)).toEqual(byDefault);
});

test('LINK-154 devices, geo and referrers shapes', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/shapes', shortCode: uniqueCode('shapes') });
  const visits: [string, string, string | undefined][] = [
    [IPHONE_UA, '8.8.8.8', 'https://news.example.com/a'],
    [IPHONE_UA, newClientIp(), 'https://news.example.com/a'],
    [PIXEL_UA, '127.0.0.1', undefined],
    [WINDOWS_CHROME_UA, newClientIp(), 'https://t.co/x'],
    ['curl/8.4.0', '172.16.0.5', ''],
  ];
  for (const [ua, ip, referer] of visits) {
    const headers: Record<string, string> = { 'User-Agent': ua };
    if (referer !== undefined) headers.Referer = referer;
    expect((await openShortLinkWith(link.shortCode, ip, headers)).status).toBe(302);
  }
  await waitForClicks(link.id, visits.length);
  const auth = { token: owner.accessToken, ip: clientIp };
  const get = async (part: string) => {
    const response = await rawApi('GET', `/api/links/${link.id}/analytics/${part}`, undefined, auth);
    expect([part, response.status]).toEqual([part, 200]);
    return response.body.data;
  };
  const byCount = <T extends { count: number }>(rows: T[]) => [...rows].sort((a, b) => b.count - a.count || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const isSortedDesc = (rows: { count: number }[]) => rows.every((row, i) => i === 0 || rows[i - 1].count >= row.count);
  const counted = (column: string) =>
    sql<{ name: string; count: number }>(
      `SELECT ${column} AS name, count(*)::int AS count FROM click_events WHERE link_id = $1 AND ${column} IS NOT NULL GROUP BY 1`,
      [link.id],
    );

  const devices = await get('devices');
  expect(Object.keys(devices).sort()).toEqual(['browsers', 'deviceTypes', 'operatingSystems']);
  for (const [key, column] of [['deviceTypes', 'device_type'], ['operatingSystems', 'os'], ['browsers', 'browser']] as const) {
    expect(isSortedDesc(devices[key])).toBe(true);
    expect(byCount(devices[key])).toEqual(byCount(await counted(column)));
  }
  expect(byCount(devices.deviceTypes)).toEqual([{ name: 'mobile', count: 3 }, { name: 'desktop', count: 2 }]);
  expect(devices.operatingSystems.map((row: { name: string | null }) => row.name)).not.toContain(null);
  expect(devices.operatingSystems.reduce((sum: number, row: { count: number }) => sum + row.count, 0)).toBe(4);

  const geo = await get('geo');
  expect(Object.keys(geo).sort()).toEqual(['cities', 'countries', 'points']);
  for (const key of ['countries', 'cities', 'points']) expect(isSortedDesc(geo[key])).toBe(true);
  const countries = await sql<{ name: string; code: string; count: number }>(
    'SELECT country AS name, country_code AS code, count(*)::int AS count FROM click_events WHERE link_id = $1 AND country IS NOT NULL GROUP BY 1, 2',
    [link.id],
  );
  expect(byCount(geo.countries)).toEqual(byCount(countries));
  const cities = await sql<{ name: string; region: string; country: string; count: number }>(
    'SELECT city AS name, region, country, count(*)::int AS count FROM click_events WHERE link_id = $1 AND city IS NOT NULL GROUP BY 1, 2, 3',
    [link.id],
  );
  expect(byCount(geo.cities)).toEqual(byCount(cities));
  const points = await sql<{ lat: number; lng: number; city: string; country: string; count: number }>(
    `SELECT latitude AS lat, longitude AS lng, coalesce(city, '') AS city, coalesce(country, '') AS country, count(*)::int AS count
       FROM click_events WHERE link_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL GROUP BY 1, 2, 3, 4`,
    [link.id],
  );
  expect(byCount(geo.points)).toEqual(byCount(points));
  // The three local visits are Mumbai; 172.16.0.5 has no place at all.
  expect(geo.cities).toContainEqual({ name: 'Mumbai', region: 'MH', country: 'India', count: 3 });
  expect(geo.points.reduce((sum: number, row: { count: number }) => sum + row.count, 0)).toBe(points.reduce((sum, row) => sum + row.count, 0));
  expect(geo.points.every((p: Record<string, unknown>) => Object.keys(p).sort().join() === 'city,count,country,lat,lng')).toBe(true);

  const referrers = await get('referrers');
  expect(byCount(referrers)).toEqual([
    { referrer: 'https://news.example.com/a', count: 2 },
    { referrer: 'https://t.co/x', count: 1 },
  ]);
  expect(isSortedDesc(referrers)).toBe(true);
});

import { randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { api, createAccount, createApiKey, createProject, newClientIp } from '../../support/api';
import { expect, newPersonContext, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  ANDROID_UA,
  DESKTOP_UA,
  IPHONE_UA,
  backdateAttribution,
  backdateClicks,
  barRows,
  bodyRows,
  cardTitled,
  click,
  clickTimes,
  clickTrendsCard,
  conversionRaw,
  createLink,
  creditLabel,
  daysAgo,
  dayLabel,
  getAs,
  identify,
  identitySecret,
  isSelected,
  localDay,
  postConversion,
  queryOf,
  raw,
  responseFor,
  roleSet,
  sdkProject,
  seedLink,
  seedTouchpoints,
  sql,
  statValue,
  timeDecayCredits,
  trackEvent,
  userHash,
  waitForAttribution,
  waitForLinkClicks,
  waitForTouchpoints,
  xAxisLabels,
  type SdkProject,
  type SeededLink,
} from '../../support/areas/anly';

/**
 * Navigation to the four analytics pages, the Analytics page's cards from real clicks
 * and conversions, and the Attribution page's models, ranges and tables from seeded
 * touchpoints credited by real conversions.
 */

const SECTIONS = [
  ['Analytics', 'analytics'],
  ['Attribution', 'attribution'],
  ['Touchpoints', 'touchpoints'],
  ['Events', 'events'],
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One click, one event and one attributed conversion, so each of the four pages has something to show. */
async function seedEveryPage(p: SdkProject, label: string): Promise<SeededLink> {
  const link = await seedLink(p.owner, p.project.id, label);
  expect(await click(link.shortCode, newClientIp())).toBe(302);
  await waitForLinkClicks(link.id, 1);
  await waitForTouchpoints(p.project.id, 1);
  await seedTouchpoints(p.project.id, [{ distinctId: `${label}-user`, channel: 'google', touchedAt: daysAgo(1) }]);
  await waitForAttribution(p, await postConversion(p, link.shortCode, `${label}-user`));
  expect((await trackEvent(p, { eventName: 'signed_in', distinctId: `${label}-user` })).status).toBe(201);
  return link;
}

/** Checks each page shows the data `seedEveryPage` made. */
async function expectEveryPageHasData(page: Page, projectId: string, label: string): Promise<void> {
  await page.goto(`/projects/${projectId}/analytics`);
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  await expect(statValue(page, 'Total Clicks'), label).toHaveText('1');

  await page.goto(`/projects/${projectId}/attribution`);
  await expect(page.getByRole('heading', { level: 1, name: 'Attribution' })).toBeVisible();
  const channels = cardTitled(page, 'Channel Attribution');
  await expect(channels.locator('tbody tr'), label).toHaveCount(1);
  expect(await bodyRows(channels), label).toEqual([['google', '100.0%', '1']]);

  await page.goto(`/projects/${projectId}/touchpoints`);
  await expect(page.getByRole('heading', { level: 1, name: 'Touchpoints' })).toBeVisible();
  const distribution = cardTitled(page, 'Channel Distribution');
  await expect(distribution.locator('tbody tr'), label).toHaveCount(2);
  expect((await bodyRows(distribution)).sort(), label).toEqual([
    ['direct', '1', '50.0%'],
    ['google', '1', '50.0%'],
  ]);

  await page.goto(`/projects/${projectId}/events`);
  await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();
  const top = cardTitled(page, 'Top Events');
  await expect(top.getByText('signed_in', { exact: true }), label).toBeVisible();
  await expect(top.getByText('1', { exact: true }), label).toBeVisible();
}

/** Picks an attribution model in the page's select. */
async function chooseModel(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('combobox')).toHaveText(name);
}

/** Waits for the page's channel attribution request for `model` and answers its query. */
function channelRequestFor(page: Page, projectId: string, model: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/projects/${projectId}/attribution/channels` && url.searchParams.get('model') === model;
  });
}

/** Touchpoints for one person ten, five and one day before now: google, facebook, newsletter. */
async function threeTouchProject(label: string, distinctId: string): Promise<{ p: SdkProject; conversionId: string; times: Date[] }> {
  const p = await sdkProject(label);
  const link = await seedLink(p.owner, p.project.id, label);
  const now = new Date();
  const times = [daysAgo(10, now), daysAgo(5, now), daysAgo(1, now)];
  await seedTouchpoints(p.project.id, [
    { distinctId, channel: 'google', touchedAt: times[0] },
    { distinctId, channel: 'facebook', touchedAt: times[1] },
    { distinctId, channel: 'newsletter', touchedAt: times[2] },
  ]);
  const conversionId = await postConversion(p, link.shortCode, distinctId);
  await waitForAttribution(p, conversionId);
  return { p, conversionId, times };
}

function withinAMinute(iso: string, expected: number): void {
  expect(Math.abs(new Date(iso).getTime() - expected)).toBeLessThan(60_000);
}

/** Local midnight of the Monday of the week `at` falls in. */
function mondayOf(at: Date): Date {
  const monday = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test('ANLY-001 sidebar entries open each page', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'anly001');
  const project = await createProject(owner, clientIp, `ANLY-001 ${randomUUID().slice(0, 6)}`);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}`);
  for (const [name] of SECTIONS) await expect(sidebarLink(page, name)).toHaveAttribute('data-active', 'false');

  for (const [name, path] of SECTIONS) {
    await sidebarLink(page, name).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/${path}$`));
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.locator('[data-slot="breadcrumb-link"]')).toHaveText(name);
    await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveCount(0);
    for (const [other] of SECTIONS) {
      await expect(sidebarLink(page, other), `${other} on ${path}`).toHaveAttribute('data-active', other === name ? 'true' : 'false');
    }
  }
});

test('ANLY-002 admin and member see the same entries, with data', async ({ browser, baseURL }) => {
  const set = await roleSet('anly002');
  const p: SdkProject = { owner: set.owner, project: set.project, sdkKey: await createApiKey(set.owner, set.project.id, set.owner.ip) };
  await seedEveryPage(p, 'anly002');

  for (const role of ['admin', 'member'] as const) {
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const page = await context.newPage();
      await signIn(page, set[role]);
      await page.goto(`/projects/${set.project.id}`);
      for (const [name, path] of SECTIONS) {
        await expect(sidebarLink(page, name), `${role}: ${name}`).toHaveAttribute('href', `/projects/${set.project.id}/${path}`);
      }
      await expectEveryPageHasData(page, set.project.id, role);
    } finally {
      await context.close();
    }
  }
});

test('ANLY-003 deep link to each page while signed in', async ({ page }) => {
  const p = await sdkProject('anly003');
  await seedEveryPage(p, 'anly003');
  await signIn(page, p.owner);

  for (const [name, path] of SECTIONS) {
    // The project request is held so the spinner it shows can be seen, then let go.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/projects/${p.project.id}`, async (route) => {
      await held;
      await route.continue();
    });
    const projectRequest = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/projects/${p.project.id}`);
    await page.goto(`/projects/${p.project.id}/${path}`);
    await projectRequest;
    await expect(page.locator('.animate-spin'), name).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name })).toHaveCount(0);
    release();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/${path}$`));
    await page.unroute(`**/api/projects/${p.project.id}`);
  }
  await expectEveryPageHasData(page, p.project.id, 'owner');
});

// ---------------------------------------------------------------------------
// Analytics page
// ---------------------------------------------------------------------------

test('ANLY-011 an empty project shows zeros and empty states', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'anly011');
  const project = await createProject(owner, clientIp, 'ANLY-011');
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/analytics`);
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  for (const [label, value] of [
    ['Total Clicks', '0'],
    ['Unique Visitors', '0'],
    ['Store Redirects', '0'],
    ['Installs', '0'],
    ['Conversion Rate', '0.0%'],
  ]) {
    await expect(statValue(page, label), label).toHaveText(value);
  }
  for (const text of ['No click data for this period', 'No device data', 'No geographic data', 'No referrer data', 'No links yet']) {
    await expect(page.getByText(text, { exact: true }), text).toBeVisible();
  }
});

test('ANLY-013 Conversion Rate counts signups only', async ({ page }) => {
  const p = await sdkProject('anly013');
  const link = await seedLink(p.owner, p.project.id, 'anly013');
  await clickTimes(link, 8);
  await waitForLinkClicks(link.id, 8);
  for (const eventType of ['signup', 'signup', 'purchase', 'purchase', 'purchase']) {
    expect((await conversionRaw(p, { shortCode: link.shortCode, eventType })).status).toBe(201);
  }

  const summary = await api<{ totalClicks: number; conversionsByType: Array<{ eventType: string; count: number }>; conversionRate: number }>(
    'GET',
    `/api/projects/${p.project.id}/analytics/summary`,
    undefined,
    { token: p.owner.accessToken, ip: p.owner.ip },
  );
  expect(summary.totalClicks).toBe(8);
  expect([...summary.conversionsByType].sort((a, b) => a.eventType.localeCompare(b.eventType))).toEqual([
    { eventType: 'purchase', count: 3 },
    { eventType: 'signup', count: 2 },
  ]);
  expect(summary.conversionRate).toBe(0.25);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  await expect(statValue(page, 'Total Clicks')).toHaveText('8');
  await expect(statValue(page, 'Conversion Rate')).toHaveText('25.0%');
});

test('ANLY-015 Installs counts matched clicks', async ({ page }) => {
  const p = await sdkProject('anly015');
  const link = await seedLink(p.owner, p.project.id, 'anly015');
  const [first, second] = [newClientIp(), newClientIp()];
  await click(link.shortCode, first, { userAgent: IPHONE_UA });
  await click(link.shortCode, second, { userAgent: IPHONE_UA });
  await waitForLinkClicks(link.id, 2);
  const summaryPath = `/api/projects/${p.project.id}/analytics/summary`;
  expect((await getAs(p.owner, summaryPath)).body.data.matchedInstalls).toBe(0);

  const match = await raw('POST', '/api/deferred/match', { cookieRef: link.shortCode }, { apiKey: p.sdkKey, ip: first });
  expect(match.status).toBe(201);
  expect(match.body.data).toMatchObject({ matched: true, linkId: link.id, shortCode: link.shortCode });
  const rows = await sql<{ ip_address: string; matched: boolean }>('SELECT ip_address, matched FROM click_events WHERE link_id = $1', [link.id]);
  expect(rows.filter((r) => r.matched).map((r) => r.ip_address)).toEqual([first]);
  expect((await getAs(p.owner, summaryPath)).body.data.matchedInstalls).toBe(1);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  await expect(statValue(page, 'Total Clicks')).toHaveText('2');
  await expect(statValue(page, 'Installs')).toHaveText('1');
});

test('ANLY-022 Click Trends asks for the last 30 days by day', async ({ page }) => {
  const p = await sdkProject('anly022');
  const link = await seedLink(p.owner, p.project.id, 'anly022');
  await clickTimes(link, 2);
  await waitForLinkClicks(link.id, 2);
  const tenDaysAgo = localDay(10);
  await backdateClicks(link.id, [tenDaysAgo]);

  await signIn(page, p.owner);
  const timeseries = responseFor(page, `/api/projects/${p.project.id}/analytics/timeseries`);
  await page.goto(`/projects/${p.project.id}/analytics`);
  const response = await timeseries;
  const asked = Date.now();
  const query = queryOf(response.url());
  expect(query.granularity).toBe('day');
  withinAMinute(query.start, asked - 30 * DAY_MS);
  withinAMinute(query.end, asked);
  const points = (await response.json()).data as Array<{ date: string; clicks: number }>;
  expect(points.map((point) => point.clicks)).toEqual([1, 1]);

  const card = clickTrendsCard(page);
  expect(await isSelected(card.getByRole('button', { name: '30d', exact: true }))).toBe(true);
  expect(await isSelected(card.getByRole('button', { name: '7d', exact: true }))).toBe(false);
  expect(await isSelected(card.getByRole('button', { name: '90d', exact: true }))).toBe(false);
  await expect(card.locator('.recharts-area')).toHaveCount(1);
  await expect(xAxisLabels(card)).toHaveText([dayLabel(tenDaysAgo), dayLabel(new Date())]);
});

test('ANLY-023 the 7d range plots only the last week', async ({ page }) => {
  const p = await sdkProject('anly023');
  const link = await seedLink(p.owner, p.project.id, 'anly023');
  await clickTimes(link, 2);
  await waitForLinkClicks(link.id, 2);
  const [twoDaysAgo, tenDaysAgo] = [localDay(2), localDay(10)];
  await backdateClicks(link.id, [twoDaysAgo, tenDaysAgo]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  const card = clickTrendsCard(page);
  await expect(xAxisLabels(card)).toHaveText([dayLabel(tenDaysAgo), dayLabel(twoDaysAgo)]);

  const week = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith('/analytics/timeseries') && Date.now() - new Date(queryOf(response.url()).start).getTime() < 8 * DAY_MS,
  );
  await card.getByRole('button', { name: '7d', exact: true }).click();
  const response = await week;
  const asked = Date.now();
  const query = queryOf(response.url());
  expect(query.granularity).toBe('day');
  withinAMinute(query.start, asked - 7 * DAY_MS);
  withinAMinute(query.end, asked);
  const points = (await response.json()).data as Array<{ date: string; clicks: number }>;
  expect(points).toHaveLength(1);
  expect(new Date(points[0].date).getTime()).toBe(new Date(twoDaysAgo.getFullYear(), twoDaysAgo.getMonth(), twoDaysAgo.getDate()).getTime());
  await expect(xAxisLabels(card)).toHaveText([dayLabel(twoDaysAgo)]);
  expect(await isSelected(card.getByRole('button', { name: '7d', exact: true }))).toBe(true);
  expect(await isSelected(card.getByRole('button', { name: '30d', exact: true }))).toBe(false);
});

test('ANLY-024 the 90d range uses weekly buckets', async ({ page }) => {
  const p = await sdkProject('anly024');
  const link = await seedLink(p.owner, p.project.id, 'anly024');
  await clickTimes(link, 3);
  await waitForLinkClicks(link.id, 3);
  const times = [localDay(80), localDay(40), localDay(5)];
  await backdateClicks(link.id, times);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  const card = clickTrendsCard(page);
  await expect(xAxisLabels(card)).toHaveText([dayLabel(times[2])]);

  const quarter = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith('/analytics/timeseries') && queryOf(response.url()).granularity === 'week',
  );
  await card.getByRole('button', { name: '90d', exact: true }).click();
  const response = await quarter;
  const asked = Date.now();
  withinAMinute(queryOf(response.url()).start, asked - 90 * DAY_MS);
  const points = (await response.json()).data as Array<{ date: string; clicks: number }>;
  const mondays = times.map(mondayOf);
  expect(points.map((point) => [new Date(point.date).getTime(), point.clicks])).toEqual(mondays.map((m) => [m.getTime(), 1]));
  for (const point of points) {
    const at = new Date(point.date);
    expect([at.getDay(), at.getHours(), at.getMinutes()]).toEqual([1, 0, 0]);
  }
  await expect(xAxisLabels(card)).toHaveText(mondays.map(dayLabel));
  expect(await isSelected(card.getByRole('button', { name: '90d', exact: true }))).toBe(true);
});

test('ANLY-026 the range only changes Click Trends', async ({ page }) => {
  const p = await sdkProject('anly026');
  const link = await seedLink(p.owner, p.project.id, 'anly026');
  await clickTimes(link, 5);
  await waitForLinkClicks(link.id, 5);
  await backdateClicks(link.id, [localDay(60), localDay(60, 13)]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  const card = clickTrendsCard(page);
  await expect(xAxisLabels(card)).toHaveText([dayLabel(new Date())]);

  const figures = async () => {
    await expect(statValue(page, 'Total Clicks')).toHaveText('5');
    await expect(statValue(page, 'Unique Visitors')).toHaveText('5');
    await expect.poll(() => bodyRows(cardTitled(page, 'Geographic Distribution'))).toEqual([['IndiaIN', '5', '100.0%']]);
    await expect(cardTitled(page, 'Devices & Browsers').locator('.recharts-legend-item-text')).toHaveText(['desktop']);
    await expect.poll(() => barRows(page, 'Operating System')).toEqual([['Mac OS', '5 (100%)']]);
    await expect.poll(() => barRows(page, 'Browser')).toEqual([['Chrome', '5 (100%)']]);
    await expect(cardTitled(page, 'Top Referrers').getByText('No referrer data')).toBeVisible();
    await expect.poll(() => bodyRows(cardTitled(page, 'Top Performing Links'))).toEqual([[`Link anly026${link.shortCode}`, '5']]);
  };
  await figures();

  const requested: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(`/api/projects/${p.project.id}`)) requested.push(path);
  });
  const sums: number[] = [];
  for (const [range, expectedLabels] of [
    ['7d', [dayLabel(new Date())]],
    ['90d', [dayLabel(mondayOf(localDay(60))), dayLabel(mondayOf(new Date()))]],
  ] as const) {
    const answer = responseFor(page, `/api/projects/${p.project.id}/analytics/timeseries`);
    await card.getByRole('button', { name: range, exact: true }).click();
    const points = (await (await answer).json()).data as Array<{ clicks: number }>;
    sums.push(points.reduce((sum, point) => sum + point.clicks, 0));
    await expect(xAxisLabels(card), range).toHaveText([...expectedLabels]);
    await figures();
  }
  expect(sums).toEqual([3, 5]);
  expect(requested).toEqual([`/api/projects/${p.project.id}/analytics/timeseries`, `/api/projects/${p.project.id}/analytics/timeseries`]);
});

test('ANLY-029 Devices & Browsers breakdown', async ({ page }) => {
  const p = await sdkProject('anly029');
  const link = await seedLink(p.owner, p.project.id, 'anly029');
  await clickTimes(link, 3, { userAgent: DESKTOP_UA });
  await clickTimes(link, 2, { userAgent: IPHONE_UA });
  await clickTimes(link, 1, { userAgent: ANDROID_UA });
  await waitForLinkClicks(link.id, 6);

  const devices = (await getAs(p.owner, `/api/projects/${p.project.id}/analytics/devices`)).body.data as Record<
    'deviceTypes' | 'operatingSystems' | 'browsers',
    Array<{ name: string; count: number }>
  >;
  expect(devices.deviceTypes).toEqual([
    { name: 'desktop', count: 3 },
    { name: 'mobile', count: 3 },
  ]);
  expect(devices.operatingSystems).toEqual([
    { name: 'Mac OS', count: 3 },
    { name: 'iOS', count: 2 },
    { name: 'Android', count: 1 },
  ]);
  expect(devices.browsers).toEqual([
    { name: 'Chrome', count: 4 },
    { name: 'Mobile Safari', count: 2 },
  ]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  const card = cardTitled(page, 'Devices & Browsers');
  await expect(card.locator('.recharts-legend-item-text')).toHaveText(['desktop', 'mobile']);
  expect(await barRows(page, 'Operating System')).toEqual([
    ['Mac OS', '3 (50%)'],
    ['iOS', '2 (33%)'],
    ['Android', '1 (17%)'],
  ]);
  expect(await barRows(page, 'Browser')).toEqual([
    ['Chrome', '4 (67%)'],
    ['Mobile Safari', '2 (33%)'],
  ]);
});

test('ANLY-031 Geographic Distribution table', async ({ page }) => {
  const p = await sdkProject('anly031');
  const link = await seedLink(p.owner, p.project.id, 'anly031');
  await clickTimes(link, 3);
  expect(await click(link.shortCode, '172.16.0.5')).toBe(302);
  await waitForLinkClicks(link.id, 4);
  const stored = await sql<{ ip_address: string; country: string | null; country_code: string | null }>(
    'SELECT ip_address, country, country_code FROM click_events WHERE link_id = $1',
    [link.id],
  );
  expect(stored.find((row) => row.ip_address === '172.16.0.5')).toMatchObject({ country: null, country_code: null });
  expect(stored.filter((row) => row.country === 'India' && row.country_code === 'IN')).toHaveLength(3);

  const geo = (await getAs(p.owner, `/api/projects/${p.project.id}/analytics/geo`)).body.data;
  expect(geo.countries).toEqual([{ name: 'India', code: 'IN', count: 3 }]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  await expect(statValue(page, 'Total Clicks')).toHaveText('4');
  const card = cardTitled(page, 'Geographic Distribution');
  await expect(card.locator('tbody tr')).toHaveCount(1);
  expect(await bodyRows(card)).toEqual([['IndiaIN', '3', '100.0%']]);
  await expect(card.getByRole('cell', { name: 'India' }).getByText('IN', { exact: true })).toBeVisible();
});

test('ANLY-034 Top Referrers', async ({ page }) => {
  const p = await sdkProject('anly034');
  const link = await seedLink(p.owner, p.project.id, 'anly034');
  await clickTimes(link, 3, { referer: 'https://news.ycombinator.com/' });
  await clickTimes(link, 1, { referer: 'https://t.co/x' });
  await clickTimes(link, 2);
  await waitForLinkClicks(link.id, 6);

  const referrers = (await getAs(p.owner, `/api/projects/${p.project.id}/analytics/referrers`)).body.data;
  expect(referrers).toEqual([
    { referrer: 'https://news.ycombinator.com/', count: 3 },
    { referrer: 'https://t.co/x', count: 1 },
  ]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  await expect(statValue(page, 'Total Clicks')).toHaveText('6');
  const card = cardTitled(page, 'Top Referrers');
  await expect(card.getByText('Where your traffic is coming from')).toBeVisible();
  await expect(card.locator('tbody tr')).toHaveCount(2);
  expect(await bodyRows(card)).toEqual([
    ['https://news.ycombinator.com/', '3', '75.0%'],
    ['https://t.co/x', '1', '25.0%'],
  ]);
  await expect(card.getByText('Direct', { exact: true })).toHaveCount(0);
});

test('ANLY-037 Top Performing Links', async ({ page }) => {
  const p = await sdkProject('anly037');
  const links: Array<{ link: SeededLink; clicks: number }> = [];
  for (const clicks of [0, 1, 2, 3, 4, 5]) {
    const link = await createLink(p.owner, p.project.id, `anly037-${clicks}`, clicks === 3 ? null : `Link with ${clicks}`);
    await clickTimes(link, clicks);
    links.push({ link, clicks });
  }
  for (const { link, clicks } of links) await waitForLinkClicks(link.id, clicks);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  const card = cardTitled(page, 'Top Performing Links');
  await expect(card.getByText('By total clicks')).toBeVisible();
  await expect(card.locator('tbody tr')).toHaveCount(5);
  const rows = await card.locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => [
      tr.querySelector('a')?.textContent?.trim() ?? '',
      tr.querySelector('p.font-mono')?.textContent?.trim() ?? '',
      tr.querySelectorAll('td')[1]?.textContent?.trim() ?? '',
    ]),
  );
  const expected = [5, 4, 3, 2, 1].map((clicks) => {
    const { link } = links[clicks];
    return [clicks === 3 ? link.shortCode : `Link with ${clicks}`, link.shortCode, String(clicks)];
  });
  expect(rows).toEqual(expected);
  await expect(card.getByText(links[0].link.shortCode, { exact: true })).toHaveCount(0);
  await expect(card.getByRole('link', { name: links[3].link.shortCode, exact: true })).toHaveAttribute(
    'href',
    `/projects/${p.project.id}/links/${links[3].link.id}`,
  );
});

test('ANLY-042 timeseries granularity values', async () => {
  const p = await sdkProject('anly042');
  const link = await seedLink(p.owner, p.project.id, 'anly042');
  await clickTimes(link, 3);
  await waitForLinkClicks(link.id, 3);
  const [morning, afternoon] = [localDay(1, 10), localDay(1, 14)];
  await backdateClicks(link.id, [morning, afternoon]);
  const now = new Date();
  const base = `/api/projects/${p.project.id}/analytics/timeseries`;

  const read = async (query: string) => {
    const answer = await getAs(p.owner, `${base}${query}`);
    expect(answer.status, query).toBe(200);
    for (const point of answer.body.data) expect(Object.keys(point).sort(), query).toEqual(['clicks', 'date']);
    return answer.body.data as Array<{ date: string; clicks: number }>;
  };
  const at = (point: { date: string }) => new Date(point.date).getTime();
  const hourStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const hourly = await read('?granularity=hour');
  expect(hourly.map((point) => [at(point), point.clicks])).toEqual([morning, afternoon, now].map((d) => [hourStart(d), 1]));

  const weekly = await read('?granularity=week');
  const weeks = new Map<number, number>();
  for (const d of [morning, afternoon, now]) weeks.set(mondayOf(d).getTime(), (weeks.get(mondayOf(d).getTime()) ?? 0) + 1);
  expect(weekly.map((point) => [at(point), point.clicks])).toEqual([...weeks.entries()]);

  const daily = await read('?granularity=day');
  expect(daily.map((point) => [at(point), point.clicks])).toEqual([
    [dayStart(morning), 2],
    [dayStart(now), 1],
  ]);
  expect(await read('')).toEqual(daily);
});

// ---------------------------------------------------------------------------
// Attribution page
// ---------------------------------------------------------------------------

test('ANLY-049 attribution empty states', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'anly049');
  const project = await createProject(owner, clientIp, 'ANLY-049');
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/attribution`);
  await expect(page.getByRole('heading', { level: 1, name: 'Attribution' })).toBeVisible();
  await expect(cardTitled(page, 'Channel Attribution').getByText('No channel attribution data', { exact: true })).toBeVisible();
  await expect(cardTitled(page, 'Campaign Attribution').getByText('No campaign attribution data', { exact: true })).toBeVisible();
  await expect(cardTitled(page, 'Model Comparison').getByText('No comparison data available', { exact: true })).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);
});

test('ANLY-050 real traffic produces no channel credit', async ({ page }) => {
  // Current behaviour as the case states it: the redirect's touchpoint names no person.
  const p = await sdkProject('anly050');
  const link = await seedLink(p.owner, p.project.id, 'anly050');
  expect(await click(link.shortCode, newClientIp(), { query: '?utm_source=newsletter&utm_campaign=launch' })).toBe(302);
  await waitForLinkClicks(link.id, 1);
  await waitForTouchpoints(p.project.id, 1);
  const touchpoints = await sql('SELECT distinct_id, channel, campaign, utm_source FROM touchpoints WHERE project_id = $1', [p.project.id]);
  expect(touchpoints).toEqual([{ distinct_id: null, channel: 'newsletter', campaign: 'launch', utm_source: 'newsletter' }]);

  const conversionId = await postConversion(p, link.shortCode, 'u-1');
  const results = await waitForAttribution(p, conversionId);
  expect(results.map((r) => r.model)).toEqual(['first_touch', 'last_touch', 'linear', 'time_decay']);
  for (const result of results) expect(result, result.model).toMatchObject({ distinctId: 'u-1', touchpointCount: 0, creditSplits: [] });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  await expect(page.getByText('No channel attribution data', { exact: true })).toBeVisible();
  await expect(page.getByText('No campaign attribution data', { exact: true })).toBeVisible();
  await expect(page.getByText('No comparison data available', { exact: true })).toBeVisible();
});

test('ANLY-052 attribution results for one conversion', async () => {
  const { p, conversionId, times } = await threeTouchProject('anly052', 'u-3');
  const results = await waitForAttribution(p, conversionId);
  expect(results.map((r) => r.model)).toEqual(['first_touch', 'last_touch', 'linear', 'time_decay']);
  for (const result of results) expect(result, result.model).toMatchObject({ touchpointCount: 3, lookbackDays: 30, distinctId: 'u-3' });
  const byModel = Object.fromEntries(results.map((r) => [r.model, r.creditSplits]));
  const splits = (model: string) => byModel[model].map((s) => [s.channel, s.credit, new Date(s.touchedAt).getTime()]);
  const [google, facebook, newsletter] = times.map((t) => t.getTime());
  expect(splits('last_touch')).toEqual([
    ['newsletter', 1, newsletter],
    ['facebook', 0, facebook],
    ['google', 0, google],
  ]);
  expect(splits('first_touch')).toEqual([
    ['google', 1, google],
    ['facebook', 0, facebook],
    ['newsletter', 0, newsletter],
  ]);
  expect(splits('linear')).toEqual([
    ['google', 0.3333, google],
    ['facebook', 0.3333, facebook],
    ['newsletter', 0.3333, newsletter],
  ]);
  const decay = timeDecayCredits(times);
  expect(splits('time_decay')).toEqual([
    ['google', decay[0], google],
    ['facebook', decay[1], facebook],
    ['newsletter', decay[2], newsletter],
  ]);
});

test('ANLY-054 First Touch model', async ({ page }) => {
  const { p } = await threeTouchProject('anly054', 'u-3');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const card = cardTitled(page, 'Channel Attribution');
  await expect(card.locator('tbody tr').first()).toContainText('newsletter');

  const request = channelRequestFor(page, p.project.id, 'first_touch');
  await chooseModel(page, 'First Touch');
  expect(queryOf((await request).url()).model).toBe('first_touch');
  await expect(card.getByText('Credit distribution across channels using First Touch model')).toBeVisible();
  await expect(card.locator('tbody tr').first()).toContainText('google');
  expect(await bodyRows(card)).toEqual([
    ['google', '100.0%', '1'],
    ['facebook', '0.0%', '1'],
    ['newsletter', '0.0%', '1'],
  ]);
});

test('ANLY-055 Linear model rounding', async ({ page }) => {
  // Current behaviour as the case states it: credit is rounded to 2 decimals before display.
  const { p } = await threeTouchProject('anly055', 'u-3');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const request = channelRequestFor(page, p.project.id, 'linear');
  await chooseModel(page, 'Linear');
  expect((await (await request).json()).data).toEqual([
    { channel: 'google', credit: 0.33, conversions: 1 },
    { channel: 'facebook', credit: 0.33, conversions: 1 },
    { channel: 'newsletter', credit: 0.33, conversions: 1 },
  ]);
  const card = cardTitled(page, 'Channel Attribution');
  await expect(card.getByText('using Linear model')).toBeVisible();
  await expect.poll(() => bodyRows(card)).toEqual([
    ['google', '33.0%', '1'],
    ['facebook', '33.0%', '1'],
    ['newsletter', '33.0%', '1'],
  ]);
  const rows = await bodyRows(card);
  expect(rows.reduce((sum, row) => sum + parseFloat(row[1]), 0)).toBeCloseTo(99, 5);
});

test('ANLY-056 Time Decay model', async ({ page }) => {
  const p = await sdkProject('anly056');
  const link = await seedLink(p.owner, p.project.id, 'anly056');
  const now = new Date();
  await seedTouchpoints(p.project.id, [
    { distinctId: 'u-4', channel: 'email', touchedAt: daysAgo(8, now) },
    { distinctId: 'u-4', channel: 'push', touchedAt: daysAgo(1, now) },
  ]);
  await waitForAttribution(p, await postConversion(p, link.shortCode, 'u-4'));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const request = channelRequestFor(page, p.project.id, 'time_decay');
  await chooseModel(page, 'Time Decay');
  expect((await (await request).json()).data).toEqual([
    { channel: 'push', credit: 0.67, conversions: 1 },
    { channel: 'email', credit: 0.33, conversions: 1 },
  ]);
  const card = cardTitled(page, 'Channel Attribution');
  await expect(card.getByText('using Time Decay model')).toBeVisible();
  await expect.poll(() => bodyRows(card)).toEqual([
    ['push', '67.0%', '1'],
    ['email', '33.0%', '1'],
  ]);
});

test('ANLY-058 credit summed across conversions shows over 100%', async ({ page }) => {
  // Current behaviour as the case states it: the column is the sum of fractional conversions.
  const p = await sdkProject('anly058');
  const link = await seedLink(p.owner, p.project.id, 'anly058');
  await seedTouchpoints(p.project.id, [
    { distinctId: 'u-6', channel: 'google', touchedAt: daysAgo(2) },
    { distinctId: 'u-7', channel: 'google', touchedAt: daysAgo(1) },
  ]);
  for (const distinctId of ['u-6', 'u-7']) await waitForAttribution(p, await postConversion(p, link.shortCode, distinctId));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const card = cardTitled(page, 'Channel Attribution');
  await expect(card.locator('tbody tr')).toHaveCount(1);
  expect(await bodyRows(card)).toEqual([['google', '200.0%', '2']]);
});

test('ANLY-059 lookback window of 30 days before the conversion', async () => {
  const p = await sdkProject('anly059');
  const link = await seedLink(p.owner, p.project.id, 'anly059');
  const [, email] = await seedTouchpoints(p.project.id, [
    { distinctId: 'u-8', channel: 'google', touchedAt: daysAgo(31) },
    { distinctId: 'u-8', channel: 'email', touchedAt: daysAgo(2) },
  ]);
  const results = await waitForAttribution(p, await postConversion(p, link.shortCode, 'u-8'));
  for (const result of results) {
    expect(result.touchpointCount, result.model).toBe(1);
    expect(result.creditSplits.map((s) => [s.touchpointId, s.channel, s.credit]), result.model).toEqual([[email, 'email', 1]]);
  }
});

test('ANLY-062 the model select changes the channel and campaign tables only', async ({ page }) => {
  const { p, times } = await threeTouchProject('anly062', 'u-3');
  const decay = timeDecayCredits(times).map(creditLabel);
  const comparePath = `/api/projects/${p.project.id}/attribution/compare`;
  const compareRequests: string[] = [];
  const campaignModels: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === comparePath) compareRequests.push(request.url());
    if (url.pathname === `/api/projects/${p.project.id}/attribution/campaigns`) campaignModels.push(url.searchParams.get('model') ?? '');
  });
  await signIn(page, p.owner);
  const compared = responseFor(page, comparePath);
  await page.goto(`/projects/${p.project.id}/attribution`);
  await compared;
  const comparison = cardTitled(page, 'Model Comparison');
  await expect(comparison.locator('tbody tr')).toHaveCount(3);
  const comparisonBefore = await bodyRows(comparison);
  const channels = cardTitled(page, 'Channel Attribution');
  const campaigns = cardTitled(page, 'Campaign Attribution');
  await expect(channels.locator('tbody tr').first()).toContainText('newsletter');
  const baseline = compareRequests.length;
  expect(baseline).toBeGreaterThanOrEqual(1);

  // [channel, credit] in the order each model's tables list them.
  const steps: Array<[string, string, string[][]]> = [
    ['First Touch', 'first_touch', [['google', '100.0%'], ['facebook', '0.0%'], ['newsletter', '0.0%']]],
    ['Linear', 'linear', [['google', '33.0%'], ['facebook', '33.0%'], ['newsletter', '33.0%']]],
    ['Time Decay', 'time_decay', [['newsletter', decay[2]], ['facebook', decay[1]], ['google', decay[0]]]],
  ];
  for (const [name, model, credits] of steps) {
    const request = channelRequestFor(page, p.project.id, model);
    await chooseModel(page, name);
    await request;
    await expect(channels.getByText(`using ${name} model`)).toBeVisible();
    await expect.poll(() => bodyRows(channels), name).toEqual(credits.map(([channel, credit]) => [channel, credit, '1']));
    await expect.poll(() => bodyRows(campaigns), name).toEqual(credits.map(([channel, credit]) => ['none', channel, credit, '1']));
    expect(await bodyRows(comparison), name).toEqual(comparisonBefore);
  }
  expect(campaignModels).toEqual(expect.arrayContaining(['last_touch', 'first_touch', 'linear', 'time_decay']));
  expect(compareRequests).toHaveLength(baseline);
});

test('ANLY-063 the range filters by when attribution was computed', async ({ page }) => {
  // The filter is on the result's own time, as the case states it.
  const p = await sdkProject('anly063');
  const link = await seedLink(p.owner, p.project.id, 'anly063');
  await seedTouchpoints(p.project.id, [{ distinctId: 'u-63', channel: 'google', campaign: 'autumn', touchedAt: daysAgo(1) }]);
  const conversionId = await postConversion(p, link.shortCode, 'u-63');
  await waitForAttribution(p, conversionId);
  await backdateAttribution(conversionId, daysAgo(40));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const empty = async (range: string) => {
    await expect(page.getByText('No channel attribution data', { exact: true }), range).toBeVisible();
    await expect(page.getByText('No campaign attribution data', { exact: true }), range).toBeVisible();
    await expect(page.getByText('No comparison data available', { exact: true }), range).toBeVisible();
  };
  await empty('30d');

  await page.getByRole('button', { name: '90d', exact: true }).click();
  expect(await isSelected(page.getByRole('button', { name: '90d', exact: true }))).toBe(true);
  await expect.poll(() => bodyRows(cardTitled(page, 'Channel Attribution'))).toEqual([['google', '100.0%', '1']]);
  await expect.poll(() => bodyRows(cardTitled(page, 'Campaign Attribution'))).toEqual([['autumn', 'google', '100.0%', '1']]);
  await expect.poll(() => bodyRows(cardTitled(page, 'Model Comparison'))).toEqual([['google', '100.0%', '100.0%', '100.0%', '100.0%']]);

  await page.getByRole('button', { name: '7d', exact: true }).click();
  await empty('7d');
});

test('ANLY-064 Campaign Attribution table', async ({ page }) => {
  const p = await sdkProject('anly064');
  const link = await seedLink(p.owner, p.project.id, 'anly064');
  await seedTouchpoints(p.project.id, [
    { distinctId: 'u-12', channel: 'google', campaign: 'spring', touchedAt: daysAgo(3) },
    { distinctId: 'u-12', channel: 'newsletter', campaign: 'spring', touchedAt: daysAgo(2) },
    { distinctId: 'u-12', channel: 'facebook', campaign: null, touchedAt: daysAgo(1) },
  ]);
  await waitForAttribution(p, await postConversion(p, link.shortCode, 'u-12'));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const request = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith('/attribution/campaigns') && queryOf(response.url()).model === 'linear',
  );
  await chooseModel(page, 'Linear');
  await request;
  const card = cardTitled(page, 'Campaign Attribution');
  await expect(card.getByText('Per-campaign credit and conversion breakdown')).toBeVisible();
  await expect(card.locator('tbody tr').first()).toContainText('google');
  expect(await bodyRows(card)).toEqual([
    ['spring', 'google', '33.0%', '1'],
    ['spring', 'newsletter', '33.0%', '1'],
    ['none', 'facebook', '33.0%', '1'],
  ]);
  for (const channel of ['google', 'newsletter', 'facebook']) {
    await expect(card.locator('[data-slot="badge"]', { hasText: channel })).toHaveCount(1);
  }
});

test('ANLY-066 Model Comparison table', async ({ page }) => {
  const { p, times } = await threeTouchProject('anly066', 'u-3');
  const decay = timeDecayCredits(times);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const card = cardTitled(page, 'Model Comparison');
  await expect(card.getByText('Side-by-side credit per channel across all attribution models')).toBeVisible();
  await expect(card.getByRole('columnheader')).toHaveText(['Channel', 'Last Touch', 'First Touch', 'Linear', 'Time Decay']);
  await expect(card.locator('tbody tr')).toHaveCount(3);
  expect(await bodyRows(card)).toEqual([
    ['newsletter', '100.0%', '0.0%', '33.0%', creditLabel(decay[2])],
    ['facebook', '0.0%', '0.0%', '33.0%', creditLabel(decay[1])],
    ['google', '0.0%', '100.0%', '33.0%', creditLabel(decay[0])],
  ]);
  // The decay figures for 9, 4 and 0 days before the last touch.
  expect([creditLabel(decay[0]), creditLabel(decay[1]), creditLabel(decay[2])]).toEqual(['20.0%', '32.0%', '48.0%']);
});

test('ANLY-070 conversion attribution route edge cases', async () => {
  const p = await sdkProject('anly070');
  const q = await sdkProject('anly070-q');
  const qLink = await seedLink(q.owner, q.project.id, 'anly070');
  await seedTouchpoints(q.project.id, [{ distinctId: 'u-70', channel: 'google', touchedAt: daysAgo(1) }]);
  const conversionId = await postConversion(q, qLink.shortCode, 'u-70');
  // Q's owner reads its four results, so the empty answer below is the project scope.
  expect(await waitForAttribution(q, conversionId)).toHaveLength(4);

  const base = `/api/projects/${p.project.id}/conversions`;
  const crossed = await getAs(p.owner, `${base}/${conversionId}/attribution`);
  expect(crossed.status).toBe(200);
  expect(crossed.body.data).toEqual([]);

  // Current behaviour as the case states it.
  const malformed = await getAs(p.owner, `${base}/not-a-uuid/attribution`);
  expect(malformed.status).toBe(500);
  expect(malformed.body).toMatchObject({ statusCode: 500, error: 'Internal Server Error', message: 'Internal server error' });
  expect(Object.keys(malformed.body).sort()).toEqual(['error', 'message', 'path', 'statusCode', 'timestamp']);
  expect(JSON.stringify(malformed.body)).not.toMatch(/syntax|QueryFailed|invalid input|attribution_results/i);

  const unknown = await getAs(p.owner, `${base}/${randomUUID()}/attribution`);
  expect(unknown.status).toBe(200);
  expect(unknown.body.data).toEqual([]);
});

test('ANLY-072 a do-not-track person\'s conversion makes no attribution', async ({ page }) => {
  const p = await sdkProject('anly072');
  const link = await seedLink(p.owner, p.project.id, 'anly072');
  const secret = await identitySecret(p);
  await identify(p, { deviceFingerprint: `fp-${randomUUID()}`, externalUserId: 'u-14', userHash: userHash(secret, 'u-14') });
  const objection = await raw(
    'POST',
    `/api/identity/projects/${p.project.id}/tracking-objections`,
    { externalUserId: 'u-14' },
    { token: p.owner.accessToken, ip: p.owner.ip },
  );
  expect(objection.status).toBe(201);
  await seedTouchpoints(p.project.id, [
    { distinctId: 'u-14', channel: 'objected-channel', touchedAt: daysAgo(1) },
    { distinctId: 'u-15', channel: 'google', touchedAt: daysAgo(1) },
  ]);

  const dropped = await conversionRaw(p, { shortCode: link.shortCode, eventType: 'signup', externalUserId: 'u-14' });
  expect(dropped.status).toBe(201);
  expect(dropped.body).toEqual({ data: { recorded: false } });
  // Someone with no objection is attributed, so the absence below is the objection.
  await waitForAttribution(p, await postConversion(p, link.shortCode, 'u-15'));

  const results = await sql<{ distinct_id: string; n: string }>(
    'SELECT distinct_id, count(*)::text AS n FROM attribution_results WHERE project_id = $1 GROUP BY distinct_id',
    [p.project.id],
  );
  expect(results).toEqual([{ distinct_id: 'u-15', n: '4' }]);
  const conversions = await sql<{ external_user_id: string }>(
    'SELECT c.external_user_id FROM conversion_events c JOIN links l ON l.id = c.link_id WHERE l.project_id = $1',
    [p.project.id],
  );
  expect(conversions).toEqual([{ external_user_id: 'u-15' }]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const card = cardTitled(page, 'Channel Attribution');
  await expect(card.locator('tbody tr')).toHaveCount(1);
  expect(await bodyRows(card)).toEqual([['google', '100.0%', '1']]);
  await expect(page.getByText('objected-channel')).toHaveCount(0);
});


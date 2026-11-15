import { randomBytes } from 'crypto';
import { format, subDays } from 'date-fns';
import type { Page } from '@playwright/test';
import { api, createAccount, createProject } from '../../support/api';
import { allowClipboard, readClipboard } from '../../support/browser-tools';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { createLink } from '../../support/areas/proj';
import {
  addTeammate,
  ageDevice,
  bodyRows,
  chooseFilter,
  consentEvents,
  deviceByFingerprint,
  deviceRow,
  fingerprint,
  identify,
  insertCampaign,
  insertCampaignEvent,
  insertDevices,
  insertEvents,
  listFilters,
  messageOf,
  openViewAs,
  peopleProject,
  profileProperties,
  profileSection,
  raw,
  seedPushToken,
  seedTouchpoint,
  sql,
  statValue,
  trackEvent,
  userHash,
  viewAsHandoff,
  viewAsToken,
  waitForList,
  type PeopleProject,
} from '../../support/areas/ppl';

/**
 * People list (stats, rows, search, filters, pages), the person profile (identity block,
 * properties, consent, events, push history), trait edits, and the SDK's identify,
 * link-device, merge and revenue routes. People arrive through identify with the
 * project's key, or as rows written with SQL where a count, an order or a time must be
 * exact; external ids carry the userHash the tenant's server would make.
 */

const PROJECT_NOT_FOUND = 'Project not found';
const PERSON_NOT_FOUND = 'Person not found';
const USER_HASH_REQUIRED =
  'externalUserId needs a userHash: HMAC-SHA256 of the id under the project identity secret, made on your server.';
const EMPTY_LIST = 'No users found. Users appear here once they interact via the SDK.';
const STAT_TITLES = ['Total Users', 'Active (30d)', 'Identified', 'Push-Enabled', 'With Revenue', 'Total Revenue'];

function uniqueId(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}`;
}

/** Asha: one person on an iOS and a web device, sharing a distinct id and an external id. */
async function seedAsha(p: PeopleProject, ip: string, extra: Record<string, unknown> = {}, externalUserId = uniqueId('user-asha')) {
  const common = {
    distinctId: externalUserId,
    externalUserId,
    firstName: 'Asha',
    lastName: 'Rao',
    phone: '+919800000001',
    traits: { $name: 'Asha Rao', $email: 'asha@example.com', plan: 'pro' },
  };
  const ios = await identify(p, ip, { ...common, deviceFingerprint: fingerprint('fp-asha-ios'), platform: 'ios', ...extra });
  const web = await identify(p, ip, { ...common, deviceFingerprint: fingerprint('fp-asha-web'), platform: 'web' });
  return { externalUserId, ios, web };
}

async function revenue(p: PeopleProject, ip: string, deviceFingerprint: string, amount: number, currency?: string) {
  return raw(
    'POST',
    '/api/identity/revenue',
    { projectId: p.project.id, deviceFingerprint, amount, ...(currency ? { currency } : {}) },
    { ip, apiKey: p.sdkKey },
  );
}

/** The display names of the table's rows, in order. */
async function rowNames(page: Page): Promise<string[]> {
  return bodyRows(page).locator('[data-slot="table-cell"]:first-child p.font-medium').allTextContents();
}

async function openList(page: Page, p: PeopleProject): Promise<void> {
  await Promise.all([waitForList(page, p.project.id, { page: '1' }), page.goto(`/projects/${p.project.id}/users`)]);
}

/** A local wall-clock time as Postgres `timestamp` text. */
function local(date: Date): string {
  return format(date, 'yyyy-MM-dd HH:mm:ss');
}

// ---- People list page

test('PPL-001 People list loads with heading, stats and table', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  // 22 devices, one a minute apart: fp-00 the most recently seen.
  const devices = Array.from({ length: 22 }, (_, i) => ({
    fingerprint: `fp-bulk-${String(i).padStart(2, '0')}-${randomBytes(3).toString('hex')}`,
    lastSeenAgo: `${i} minutes`,
  }));
  await insertDevices(p.project.id, devices);

  await signIn(page, p.owner);
  const [stats, list] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/api/projects/${p.project.id}/users/stats`),
    waitForList(page, p.project.id, { page: '1', limit: '20' }),
    page.goto(`/projects/${p.project.id}/users`),
  ]);
  expect(stats.status()).toBe(200);
  expect(list.status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'Users', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Users identified in your project via the SDK.')).toBeVisible();
  await expect(page.locator('[data-slot="card-title"]')).toHaveText(STAT_TITLES);
  await expect(page.getByRole('columnheader')).toHaveText(['User', 'Platform', 'Location', 'Status', 'Sessions', 'Events', 'Revenue', 'Source', 'Last Seen']);
  await expect(page.getByRole('row')).toHaveCount(21);
  // Newest first: the first 20 of the 22, in last-seen order.
  expect(await rowNames(page)).toEqual(devices.slice(0, 20).map((d) => d.fingerprint));
});

test('PPL-003 Stat values match the device rows of the project', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const raviFp = fingerprint('fp-ravi');
  const raviId = uniqueId('user-ravi');
  await identify(p, clientIp, { deviceFingerprint: raviFp, platform: 'android', externalUserId: raviId, firstName: 'Ravi', lastName: 'Kumar' });
  const anonFp = fingerprint('fp-anon-1');
  await identify(p, clientIp, { deviceFingerprint: anonFp });
  const old = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-old') });
  expect((await revenue(p, clientIp, raviFp, 49.5, 'INR')).status).toBe(201);
  expect((await revenue(p, clientIp, anonFp, 1200)).status).toBe(201);
  await seedPushToken(p.project.id, asha.ios.id);
  // A token that is no longer active does not make a device push-enabled.
  const inactiveToken = await seedPushToken(p.project.id, asha.web.id, 'web');
  await sql(`UPDATE push_tokens SET is_active = false WHERE token = $1`, [inactiveToken]);
  await ageDevice(old.id, '40 days');

  const [counts] = await sql<Record<string, number>>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE last_seen_at >= now() - interval '30 days')::int AS active,
            count(*) FILTER (WHERE external_user_id IS NOT NULL)::int AS identified,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM push_tokens pt WHERE pt.device_identity_id = di.id AND pt.is_active))::int AS push,
            count(*) FILTER (WHERE total_revenue > 0)::int AS with_revenue,
            sum(total_revenue)::float AS revenue
       FROM device_identities di WHERE project_id = $1`,
    [p.project.id],
  );
  expect(counts).toEqual({ total: 5, active: 4, identified: 3, push: 1, with_revenue: 2, revenue: 1249.5 });

  const stats = await api<Record<string, any>>('GET', `/api/projects/${p.project.id}/users/stats`, undefined, { token: p.owner.accessToken, ip: clientIp });
  expect(stats).toMatchObject({ total: 5, active30d: 4, identified: 3, pushEnabled: 1, withRevenue: 2, totalRevenue: 1249.5, newThisWeek: 4 });
  expect(stats.topCountries).toEqual([{ country: 'India', count: 5 }]);
  expect(stats.topCountries.length).toBeLessThanOrEqual(10);
  expect(new Map(stats.topPlatforms.map((row: { platform: string; count: number }) => [row.platform, row.count]))).toEqual(
    new Map([['web', 3], ['ios', 1], ['android', 1]]),
  );

  await signIn(page, p.owner);
  await openList(page, p);
  await expect(statValue(page, 'Total Users')).toHaveText('5');
  await expect(statValue(page, 'Active (30d)')).toHaveText('4');
  await expect(statValue(page, 'Identified')).toHaveText('3');
  await expect(statValue(page, 'Push-Enabled')).toHaveText('1');
  await expect(statValue(page, 'With Revenue')).toHaveText('2');
  await expect(statValue(page, 'Total Revenue')).toHaveText('$1,249.5');
});

test('PPL-006 Empty project shows the empty state', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);

  await signIn(page, p.owner);
  await openList(page, p);
  for (const title of STAT_TITLES.slice(0, 5)) await expect(statValue(page, title)).toHaveText('0');
  await expect(statValue(page, 'Total Revenue')).toHaveText('$0');
  await expect(page.getByText(EMPTY_LIST)).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByText(/^Showing /)).toHaveCount(0);
});

test('PPL-008 Row rendering: name, email, platform, location, status, numbers, source, last seen', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp, { os: 'iOS', utmSource: 'newsletter' });
  await seedPushToken(p.project.id, asha.ios.id);
  for (const name of ['opened_app', 'viewed_item']) {
    expect((await trackEvent(p, clientIp, { deviceFingerprint: asha.ios.deviceFingerprint, eventName: name })).status).toBe(201);
  }
  const raviFp = fingerprint('fp-ravi');
  await identify(p, clientIp, { deviceFingerprint: raviFp, platform: 'android', firstName: 'Ravi', lastName: 'Kumar', phone: '+919800000002' });
  expect((await revenue(p, clientIp, raviFp, 49.5, 'INR')).status).toBe(201);
  const miraDistinct = uniqueId('user-mira-long-distinct');
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-mira'), firstName: 'Mira', lastName: 'Shah', distinctId: miraDistinct });
  const anonFp = fingerprint('fp-anon-1');
  const anon = await identify(p, clientIp, { deviceFingerprint: anonFp });
  await sql(`UPDATE device_identities SET country = NULL, city = NULL WHERE id = $1`, [anon.id]);
  await ageDevice(anon.id, '40 days');
  const today = format(new Date(), 'MMM d, yyyy');

  await signIn(page, p.owner);
  await openList(page, p);
  const cells = (row: ReturnType<typeof bodyRows>) => row.locator('[data-slot="table-cell"]');

  const ashaIos = bodyRows(page).filter({ hasText: 'Asha Rao' }).filter({ hasText: 'ios' });
  await expect(cells(ashaIos)).toHaveText(['AAsha Raoasha@example.com', 'iosiOS', 'IndiaMumbai', 'active', '1', '2', '-', 'newsletter', today]);
  await expect(cells(ashaIos).nth(3).locator('svg.lucide-bell')).toHaveCount(1);
  // The other device of the same person shares the distinct id, so the same events.
  const ashaWeb = bodyRows(page).filter({ hasText: 'Asha Rao' }).filter({ hasText: 'web' });
  await expect(cells(ashaWeb).nth(5)).toHaveText('2');
  await expect(cells(ashaWeb).nth(3).locator('svg.lucide-bell')).toHaveCount(0);
  await expect(cells(ashaWeb).nth(7)).toHaveText('organic');

  const ravi = bodyRows(page).filter({ hasText: 'Ravi Kumar' });
  await expect(cells(ravi)).toHaveText(['RRavi Kumar+919800000002', 'android', 'IndiaMumbai', 'active', '1', '0', '$49.50', 'organic', today]);
  await expect(cells(ravi).nth(6).locator('span.text-green-600')).toHaveText('$49.50');

  const mira = bodyRows(page).filter({ hasText: 'Mira Shah' });
  await expect(cells(mira).first()).toHaveText(`MMira Shah${miraDistinct.slice(0, 16)}...`);

  // The fingerprint is both name and distinct id, so no second line; no location.
  const anonRow = bodyRows(page).filter({ hasText: anonFp });
  await expect(cells(anonRow)).toHaveText([`F${anonFp}`, 'web', '-', 'inactive', '1', '0', '-', 'organic', format(subDays(new Date(), 40), 'MMM d, yyyy')]);
});

test('PPL-011 Search by name, email, phone, external id, distinct id and fingerprint', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const raviId = uniqueId('user-ravi');
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-r'), platform: 'android', externalUserId: raviId, firstName: 'Ravi', lastName: 'Kumar' });
  const anonFp = fingerprint('fp-anon-1');
  await identify(p, clientIp, { deviceFingerprint: anonFp });
  const didFp = fingerprint('fp-d');
  const distinctId = uniqueId('anon-did');
  await identify(p, clientIp, { deviceFingerprint: didFp, distinctId });
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-z'), firstName: 'Zoe', lastName: 'Bell' });

  await signIn(page, p.owner);
  await openList(page, p);
  await expect(bodyRows(page)).toHaveCount(6);
  const search = page.getByPlaceholder('Search by name, email, or ID...');

  const cases: Array<[string, string[]]> = [
    ['asha', ['Asha Rao', 'Asha Rao']],
    ['ASHA@EXAMPLE', ['Asha Rao', 'Asha Rao']],
    ['+91980', ['Asha Rao', 'Asha Rao']],
    ['user-ravi', ['Ravi Kumar']],
    ['anon-did', [distinctId]],
    ['fp-anon', [anonFp]],
    ['Rao', ['Asha Rao', 'Asha Rao']],
  ];
  for (const [term, names] of cases) {
    const [response] = await Promise.all([waitForList(page, p.project.id, { search: term, page: '1' }), search.fill(term)]);
    expect(response.status()).toBe(200);
    await expect.poll(() => rowNames(page), { message: `search ${term}` }).toEqual(names);
  }
  expect(asha.ios.id).not.toBe(asha.web.id);
});

test('PPL-015 Status filter', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  // 21 seen lately and one 40 days ago, so the active rows span two pages.
  const active = Array.from({ length: 21 }, (_, i) => ({ fingerprint: `fp-act-${String(i).padStart(2, '0')}-${randomBytes(3).toString('hex')}`, lastSeenAgo: `${i} minutes` }));
  const oldFp = fingerprint('fp-old');
  await insertDevices(p.project.id, [...active, { fingerprint: oldFp, lastSeenAgo: '40 days' }]);

  await signIn(page, p.owner);
  await openList(page, p);
  await expect(listFilters(page).getByRole('combobox').nth(0)).toHaveText('All statuses');
  await expect(page.getByText('Showing 1–20 of 22')).toBeVisible();
  await Promise.all([waitForList(page, p.project.id, { page: '2', status: null }), page.getByText(/^Showing /).locator('..').getByRole('button').nth(1).click()]);
  await expect(page.getByText('Showing 21–22 of 22')).toBeVisible();

  // Each change goes back to page 1.
  await Promise.all([waitForList(page, p.project.id, { status: 'inactive', page: '1' }), chooseFilter(page, 0, 'Inactive')]);
  await expect.poll(() => rowNames(page)).toEqual([oldFp]);
  await expect(bodyRows(page).first().locator('[data-slot="badge"]', { hasText: 'inactive' })).toBeVisible();

  await Promise.all([waitForList(page, p.project.id, { status: 'active', page: '1' }), chooseFilter(page, 0, 'Active')]);
  await expect(page.getByText('Showing 1–20 of 21')).toBeVisible();
  expect(await rowNames(page)).toEqual(active.slice(0, 20).map((d) => d.fingerprint));
  await expect(bodyRows(page).locator('[data-slot="badge"]', { hasText: 'inactive' })).toHaveCount(0);

  // A search every row matches makes "All statuses" a query the page has not loaded
  // yet, so its request can be seen: no status, and back to page 1 from page 2.
  const search = page.getByPlaceholder('Search by name, email, or ID...');
  await Promise.all([waitForList(page, p.project.id, { search: 'fp-', status: 'active', page: '1' }), search.fill('fp-')]);
  await expect(page.getByText('Showing 1–20 of 21')).toBeVisible();
  await Promise.all([waitForList(page, p.project.id, { search: 'fp-', status: 'active', page: '2' }), page.getByText(/^Showing /).locator('..').getByRole('button').nth(1).click()]);
  await expect(page.getByText('Showing 21–21 of 21')).toBeVisible();
  await Promise.all([waitForList(page, p.project.id, { search: 'fp-', status: null, page: '1' }), chooseFilter(page, 0, 'All statuses')]);
  await expect(page.getByText('Showing 1–20 of 22')).toBeVisible();
  await expect(listFilters(page).getByRole('combobox').nth(0)).toHaveText('All statuses');
});

test('PPL-016 Push status filter', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const [withToken, inactiveOnly, none] = await insertDevices(p.project.id, [
    { fingerprint: fingerprint('fp-push-on') },
    { fingerprint: fingerprint('fp-push-off') },
    { fingerprint: fingerprint('fp-push-none') },
  ]);
  await seedPushToken(p.project.id, withToken);
  const stale = await seedPushToken(p.project.id, inactiveOnly);
  await sql(`UPDATE push_tokens SET is_active = false WHERE token = $1`, [stale]);
  const names = async (ids: string[]) => (await sql<{ device_fingerprint: string }>(`SELECT device_fingerprint FROM device_identities WHERE id = ANY($1::uuid[])`, [ids])).map((r) => r.device_fingerprint).sort();

  await signIn(page, p.owner);
  await openList(page, p);
  const pushSelect = listFilters(page).getByRole('combobox').nth(1);
  await expect(pushSelect).toHaveText('Push status');

  await Promise.all([waitForList(page, p.project.id, { pushEnabled: 'true', page: '1' }), chooseFilter(page, 1, 'Push enabled')]);
  await expect.poll(async () => (await rowNames(page)).sort()).toEqual(await names([withToken]));
  await expect(bodyRows(page).locator('svg.lucide-bell')).toHaveCount(1);

  await Promise.all([waitForList(page, p.project.id, { pushEnabled: 'false', page: '1' }), chooseFilter(page, 1, 'Push disabled')]);
  await expect.poll(async () => (await rowNames(page)).sort()).toEqual(await names([inactiveOnly, none]));
  await expect(bodyRows(page).locator('svg.lucide-bell')).toHaveCount(0);

  // A search every row matches makes "All push status" a query not loaded yet, so its
  // request (no pushEnabled) can be seen.
  const search = page.getByPlaceholder('Search by name, email, or ID...');
  await Promise.all([waitForList(page, p.project.id, { search: 'fp-push', pushEnabled: 'false', page: '1' }), search.fill('fp-push')]);
  await expect(bodyRows(page)).toHaveCount(2);
  await Promise.all([waitForList(page, p.project.id, { search: 'fp-push', pushEnabled: null, page: '1' }), chooseFilter(page, 1, 'All push status')]);
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(pushSelect).toHaveText('Push status');
});

test('PPL-017 Platform filter', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const fps = { web: fingerprint('fp-web'), ios: fingerprint('fp-ios'), android: fingerprint('fp-android') };
  await insertDevices(p.project.id, Object.entries(fps).map(([platform, fp]) => ({ fingerprint: fp, platform })));

  await signIn(page, p.owner);
  await openList(page, p);
  await expect(listFilters(page).getByRole('combobox').nth(2)).toHaveText('Platform');
  for (const [option, platform] of [['Web', 'web'], ['iOS', 'ios'], ['Android', 'android']] as const) {
    await Promise.all([waitForList(page, p.project.id, { platform, page: '1' }), chooseFilter(page, 2, option)]);
    await expect.poll(() => rowNames(page)).toEqual([fps[platform]]);
    await expect(bodyRows(page).locator('[data-slot="table-cell"]').nth(1)).toHaveText(platform);
  }
  // A search every row matches makes "All platforms" a query not loaded yet, so its
  // request (no platform) can be seen.
  const search = page.getByPlaceholder('Search by name, email, or ID...');
  await Promise.all([waitForList(page, p.project.id, { search: 'fp-', platform: 'android', page: '1' }), search.fill('fp-')]);
  await expect(bodyRows(page)).toHaveCount(1);
  await Promise.all([waitForList(page, p.project.id, { search: 'fp-', platform: null, page: '1' }), chooseFilter(page, 2, 'All platforms')]);
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(listFilters(page).getByRole('combobox').nth(2)).toHaveText('Platform');
});

test('PPL-019 Pagination controls and range text', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  await insertDevices(p.project.id, Array.from({ length: 48 }, (_, i) => ({ fingerprint: `fp-page-${String(i).padStart(2, '0')}-${randomBytes(3).toString('hex')}`, lastSeenAgo: `${i} minutes` })));

  await signIn(page, p.owner);
  await openList(page, p);
  const bar = page.getByText(/^Showing /).locator('..');
  const previous = bar.getByRole('button').nth(0);
  const next = bar.getByRole('button').nth(1);

  await expect(page.getByText('Showing 1–20 of 48')).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await Promise.all([waitForList(page, p.project.id, { page: '2' }), next.click()]);
  await expect(page.getByText('Showing 21–40 of 48')).toBeVisible();
  await expect(bodyRows(page)).toHaveCount(20);
  await Promise.all([waitForList(page, p.project.id, { page: '3' }), next.click()]);
  await expect(page.getByText('Showing 41–48 of 48')).toBeVisible();
  await expect(bodyRows(page)).toHaveCount(8);
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  // Page 2 again, from what the page already holds.
  await previous.click();
  await expect(page.getByText('Showing 21–40 of 48')).toBeVisible();
  await expect(bodyRows(page)).toHaveCount(20);
});

test('PPL-025 Member and admin can see the list', async ({ page, browser, baseURL, clientIp }) => {
  const p = await peopleProject(clientIp);
  await seedAsha(p, clientIp);
  const ravi = fingerprint('fp-ravi');
  await identify(p, clientIp, { deviceFingerprint: ravi, platform: 'android', firstName: 'Ravi', lastName: 'Kumar' });
  expect((await revenue(p, clientIp, ravi, 49.5)).status).toBe(201);

  await signIn(page, p.owner);
  await openList(page, p);
  await expect(statValue(page, 'Total Users')).toHaveText('3');
  const ownerNames = await rowNames(page);
  const ownerStats = await page.locator('[data-slot="card-content"]').allTextContents();

  for (const role of ['member', 'admin'] as const) {
    const teammate = await addTeammate(p.owner, p.project.id, role, clientIp);
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const other = await context.newPage();
      await signIn(other, teammate);
      await openList(other, p);
      await expect(statValue(other, 'Total Users')).toHaveText('3');
      expect(await other.locator('[data-slot="card-content"]').allTextContents()).toEqual(ownerStats);
      expect(await rowNames(other)).toEqual(ownerNames);
    } finally {
      await context.close();
    }
  }
});

test('PPL-026 View-as can see the list', async ({ page, browser, baseURL, clientIp }) => {
  test.slow(); // The super admin grant runs the CLI through ts-node.
  const p = await peopleProject(clientIp);
  await seedAsha(p, clientIp);
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);

  await openViewAs(page, handoff);
  const [stats, list] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/api/projects/${p.project.id}/users/stats`),
    waitForList(page, p.project.id, { page: '1' }),
    page.goto(`/projects/${p.project.id}/users`),
  ]);
  expect(stats.status()).toBe(200);
  expect(list.status()).toBe(200);
  await expect(page.getByRole('region', { name: 'Impersonation session' })).toBeVisible();
  await expect(statValue(page, 'Total Users')).toHaveText('2');
  await expect(statValue(page, 'Identified')).toHaveText('2');
  expect(await rowNames(page)).toEqual(['Asha Rao', 'Asha Rao']);
});

test('PPL-030 People list API: one row per device and deviceCount', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const anon = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-anon') });
  const auth = { token: p.owner.accessToken, ip: clientIp };

  const shared = await raw('GET', `/api/projects/${p.project.id}/users?search=${asha.externalUserId}`, undefined, auth);
  expect(shared.status).toBe(200);
  const rows = shared.body.data as Array<{ id: string; deviceCount: number; distinctId: string }>;
  expect(rows.map((r) => r.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
  expect(rows.map((r) => r.deviceCount)).toEqual([2, 2]);
  expect(rows.map((r) => r.distinctId)).toEqual([asha.externalUserId, asha.externalUserId]);

  const lone = await raw('GET', `/api/projects/${p.project.id}/users?search=${anon.deviceFingerprint}`, undefined, auth);
  expect(lone.body.data).toEqual([expect.objectContaining({ id: anon.id, deviceCount: 1, distinctId: anon.deviceFingerprint })]);
});

// ---- Person profile page

test('PPL-035 Deep link and refresh', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  await signIn(page, p.owner);

  const tab = await page.context().newPage();
  await tab.goto(`/projects/${p.project.id}/users/${asha.ios.id}`);
  await expect(tab.getByRole('heading', { level: 1 })).toHaveText('asha@example.com');
  await expect(tab.getByText(asha.ios.deviceFingerprint)).toHaveCount(0);
  await tab.reload();
  await expect(tab).toHaveURL(new RegExp(`/projects/${p.project.id}/users/${asha.ios.id}$`));
  await expect(tab.getByRole('heading', { level: 1 })).toHaveText('asha@example.com');
  await expect(tab.getByRole('heading', { name: 'User Profile' })).toBeVisible();
});

test('PPL-037 Unknown person id shows "Person not found"', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const unknown = '00000000-0000-4000-8000-000000000000';
  await signIn(page, p.owner);

  const answers: Array<{ status: number; message: string }> = [];
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === `/api/projects/${p.project.id}/users/${unknown}`) {
      answers.push({ status: response.status(), message: (await response.json()).message });
    }
  });
  await page.goto(`/projects/${p.project.id}/users/${unknown}`);
  await expect(page.getByText('Person not found', { exact: true })).toBeVisible();
  // One retry, then the page gives up (the handler reads each body after it arrives).
  await expect.poll(() => answers).toEqual([
    { status: 404, message: PERSON_NOT_FOUND },
    { status: 404, message: PERSON_NOT_FOUND },
  ]);
  const back = page.getByRole('link', { name: 'Back to Users' });
  await expect(back).toHaveAttribute('href', `/projects/${p.project.id}/users`);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users$`));
  await expect(page.getByRole('heading', { name: 'Users', exact: true, level: 1 })).toBeVisible();
});

test('PPL-040 Sidebar identity block and copy buttons', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const anonFp = fingerprint('fp-anon-1');
  const anon = await identify(p, clientIp, { deviceFingerprint: anonFp });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${asha.ios.id}`);
  await allowClipboard(page);
  const sidebar = page.locator('aside');
  const block = (label: string) => sidebar.locator('div.flex-1').filter({ has: page.getByText(label, { exact: true }) });
  await expect(block('Distinct ID')).toHaveText(`Distinct ID${asha.externalUserId}`);
  await expect(block('External User ID')).toHaveText(`External User ID${asha.externalUserId}`);

  for (const label of ['Distinct ID', 'External User ID']) {
    await page.evaluate(() => navigator.clipboard.writeText('before'));
    const button = page.getByRole('button', { name: `Copy ${label}` });
    await button.click();
    await expect.poll(() => readClipboard(page)).toBe(asha.externalUserId);
    await expect(button.locator('svg.lucide-check')).toHaveCount(1);
    // Back to the copy icon after about a second and a half.
    await expect(button.locator('svg.lucide-copy')).toHaveCount(1, { timeout: 4000 });
    await expect(button.locator('svg.lucide-check')).toHaveCount(0);
  }

  await page.goto(`/projects/${p.project.id}/users/${anon.id}`);
  await expect(block('Distinct ID')).toHaveText(`Distinct ID${anonFp}`);
  await expect(page.getByText('External User ID', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy External User ID' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy Distinct ID' }).click();
  await expect.poll(() => readClipboard(page)).toBe(anonFp);
});

test('PPL-044 Profile Properties list and ordering', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-props');
  const person = await identify(p, clientIp, {
    deviceFingerprint: fp,
    platform: 'ios',
    traits: { $name: 'Asha Rao', $email: 'asha@example.com', plan: 'pro', prefs: { a: 1 }, zero: 0, off: false, empty: '' },
    firstName: 'Asha',
    lastName: 'Rao',
    phone: '+919800000001',
    locale: 'en-IN',
    language: 'en',
    timezone: 'Asia/Kolkata',
    os: 'iOS',
    osVersion: '17.1',
    browser: 'Safari',
    browserVersion: '17.0',
    appVersion: '2.3.0',
    appBuild: '230',
    manufacturer: 'Apple',
    brand: 'Apple',
    model: 'iPhone15,2',
    screenWidth: 1179,
    screenHeight: 2556,
    carrier: 'Jio',
    referrer: 'https://news.example.com/a',
    utmSource: 'google',
    utmMedium: 'cpc',
    utmCampaign: 'launch',
    utmContent: 'banner',
    utmTerm: 'deeplinks',
    installSource: 'app_store',
    installCampaign: 'spring',
    emailOptIn: true,
  });
  expect((await revenue(p, clientIp, fp, 10, 'INR')).status).toBe(201);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${person.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('asha@example.com');
  expect(await profileProperties(page)).toEqual([
    ['plan', 'pro'],
    ['prefs', '{"a":1}'],
    ['City', 'Mumbai'],
    ['Country', 'India'],
    ['Country Code', 'IN'],
    ['Email', 'asha@example.com'],
    ['Phone', '+919800000001'],
    ['First Name', 'Asha'],
    ['Last Name', 'Rao'],
    ['Locale', 'en-IN'],
    ['Language', 'en'],
    ['Region', 'MH'],
    ['Timezone', 'Asia/Kolkata'],
    ['Operating System', 'iOS'],
    ['OS Version', '17.1'],
    ['Browser', 'Safari'],
    ['Browser Version', '17.0'],
    ['App Version', '2.3.0'],
    ['App Build Number', '230'],
    ['Manufacturer', 'Apple'],
    ['Brand', 'Apple'],
    ['Model', 'iPhone15,2'],
    ['Screen Width', '1179'],
    ['Screen Height', '2556'],
    ['Carrier', 'Jio'],
    ['Platform', 'ios'],
    ['Total Sessions', '1'],
    ['Total Revenue', 'INR10.00'],
    ['Initial Referrer', 'https://news.example.com/a'],
    ['Initial UTM Source', 'google'],
    ['Initial UTM Medium', 'cpc'],
    ['Initial UTM Campaign', 'launch'],
    ['Initial UTM Content', 'banner'],
    ['Initial UTM Term', 'deeplinks'],
    ['Install Source', 'app_store'],
    ['Install Campaign', 'spring'],
    ['Latest UTM Source', 'google'],
    ['Latest UTM Medium', 'cpc'],
    ['Latest UTM Campaign', 'launch'],
    ['Email Opt-in', 'true'],
  ]);
});

test('PPL-045 Consent shown on the profile hides "false"', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const flags = ['emailOptIn', 'smsOptIn', 'whatsappOptIn', 'pushOptIn', 'gdprConsent', 'doNotTrack'];
  const allOn = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-consent-on'), ...Object.fromEntries(flags.map((f) => [f, true])) });
  const allOff = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-consent-off'), ...Object.fromEntries(flags.map((f) => [f, false])) });
  expect(await deviceRow(allOff.id)).toMatchObject({ email_opt_in: false, sms_opt_in: false, push_opt_in: false, do_not_track: false });
  const consentLabels = ['Email Opt-in', 'SMS Opt-in', 'WhatsApp Opt-in', 'Push Opt-in', 'GDPR Consent', 'Do Not Track'];

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${allOn.id}`);
  await expect(page.getByRole('heading', { name: 'Profile Properties' })).toBeVisible();
  const on = (await profileProperties(page)).filter(([label]) => consentLabels.includes(label));
  expect(on).toEqual(consentLabels.map((label) => [label, 'true']));

  await page.goto(`/projects/${p.project.id}/users/${allOff.id}`);
  await expect(page.getByText('Platform', { exact: true })).toBeVisible();
  // False values are dropped, so an opt-out does not show.
  const off = (await profileProperties(page)).filter(([label]) => consentLabels.includes(label));
  expect(off).toEqual([]);
});

test('PPL-049 Events timeline grouped by day', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  // 30 views two days ago and 25 purchases yesterday: the 50 newest are every
  // purchase and the 25 latest views.
  const twoDaysAgo = subDays(new Date(), 2);
  twoDaysAgo.setHours(9, 0, 0, 0);
  const yesterday = subDays(new Date(), 1);
  yesterday.setHours(9, 0, 0, 0);
  const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);
  const views = Array.from({ length: 30 }, (_, i) => ({ name: 'viewed_item', at: local(at(twoDaysAgo, i)) }));
  const purchases = Array.from({ length: 25 }, (_, i) => ({ name: 'purchase', at: local(at(yesterday, i)) }));
  await insertEvents(p.project.id, asha.externalUserId, asha.ios.id, [...views, ...purchases]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${asha.ios.id}`);
  const events = profileSection(page, 'Events');
  await expect(events.locator('[data-slot="badge"]')).toHaveText(['viewed_item30', 'purchase25']);
  await expect(events.getByRole('heading', { level: 3 })).toHaveText([
    format(yesterday, 'EEEE · MMMM d, yyyy'),
    format(twoDaysAgo, 'EEEE · MMMM d, yyyy'),
  ]);
  const rows = events.getByRole('button');
  await expect(rows).toHaveCount(50);
  // Each row: time, name, and its one system property (the source type).
  await expect(rows.first()).toHaveText(`${format(at(yesterday, 24), 'h:mm:ss a')}purchase1 properties`);
  await expect(rows.nth(24)).toHaveText(`${format(yesterday, 'h:mm:ss a')}purchase1 properties`);
  await expect(rows.nth(25)).toHaveText(`${format(at(twoDaysAgo, 29), 'h:mm:ss a')}viewed_item1 properties`);
  // The oldest kept is the 25th latest view; the five before it are left out.
  await expect(rows.last()).toHaveText(`${format(at(twoDaysAgo, 5), 'h:mm:ss a')}viewed_item1 properties`);
});

test('PPL-050 Event row expands into property tabs', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-ev') });
  const tracked = await trackEvent(p, clientIp, {
    deviceFingerprint: person.deviceFingerprint,
    eventName: 'added_to_cart',
    properties: { sku: 'A1', price: 10, nested: { a: 1 }, platform: 'web' },
  });
  expect(tracked.status).toBe(201);
  const [stored] = await sql(`SELECT source_type, platform, country, city, ip_address, user_agent FROM user_events WHERE project_id = $1`, [p.project.id]);
  // The track route sets only the source type among the system fields.
  expect(stored).toEqual({ source_type: 'sdk', platform: null, country: null, city: null, ip_address: null, user_agent: null });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${person.id}`);
  const row = profileSection(page, 'Events').getByRole('button', { name: /added_to_cart/ });
  const count = row.getByText('5 properties');
  await expect(count).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(count).toHaveCSS('opacity', '1');

  await row.click();
  const panelRows = (name: RegExp) => page.getByRole('tabpanel', { name }).locator('div.grid');
  const pairs = async (name: RegExp) =>
    (await panelRows(name).all()).length === 0 ? [] : Promise.all((await panelRows(name).all()).map(async (r) => (await r.locator('div').allTextContents()) as string[]));
  await expect(page.getByRole('tab')).toHaveText(['All Event Properties (5)', 'Event Properties (3)', 'System Properties (2)']);
  await expect(panelRows(/All Event Properties/)).toHaveCount(5);
  expect(await pairs(/All Event Properties/)).toEqual([
    ['Source Type', 'sdk'],
    ['sku', 'A1'],
    ['price', '10'],
    ['nested', '{"a":1}'],
    ['platform', 'web'],
  ]);
  await page.getByRole('tab', { name: /^Event Properties/ }).click();
  await expect(panelRows(/^Event Properties/)).toHaveCount(3);
  expect(await pairs(/^Event Properties/)).toEqual([
    ['sku', 'A1'],
    ['price', '10'],
    ['nested', '{"a":1}'],
  ]);
  await page.getByRole('tab', { name: /System Properties/ }).click();
  await expect(panelRows(/System Properties/)).toHaveCount(2);
  expect(await pairs(/System Properties/)).toEqual([
    ['Source Type', 'sdk'],
    ['platform', 'web'],
  ]);

  await row.click();
  await expect(page.getByRole('tab')).toHaveCount(0);
});

test('PPL-053 Events are matched by distinct id (shared ids)', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const shared = uniqueId('shared-1');
  const first = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-one'), distinctId: shared, firstName: 'One' });
  const second = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-two'), distinctId: shared, firstName: 'Two' });
  for (const name of ['opened', 'opened', 'paid']) {
    expect((await trackEvent(p, clientIp, { distinctId: shared, eventName: name })).status).toBe(201);
  }
  const auth = { token: p.owner.accessToken, ip: clientIp };

  const [a, b] = await Promise.all([first, second].map((person) => api<Record<string, any>>('GET', `/api/projects/${p.project.id}/users/${person.id}`, undefined, auth)));
  expect(a.firstName).toBe('One');
  expect(b.firstName).toBe('Two');
  const ids = (detail: Record<string, any>) => detail.recentEvents.map((e: { id: string }) => e.id).sort();
  expect(ids(a)).toHaveLength(3);
  expect(ids(a)).toEqual(ids(b));
  expect(a.eventCounts).toEqual([{ eventName: 'opened', count: 2 }, { eventName: 'paid', count: 1 }]);
  expect(b.eventCounts).toEqual(a.eventCounts);
  for (const person of [first, second]) {
    const events = await api<{ total: number }>('GET', `/api/projects/${p.project.id}/users/${person.id}/events`, undefined, auth);
    expect(events.total).toBe(3);
  }
});

test('PPL-056 Push history: loading, empty and error states', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const anon = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-anon-1') });
  const url = `/projects/${p.project.id}/users/${anon.id}`;
  const history = `/api/push-notifications/history/${p.project.id}/${anon.id}`;
  await signIn(page, p.owner);

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route((u) => u.pathname === history, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(url);
  const push = profileSection(page, 'Push Notifications');
  await expect(push.locator('.animate-pulse')).toHaveCount(2);
  release();
  await expect(push.getByText('No campaigns have reached this person yet')).toBeVisible();
  await expect(push.getByText('Push notifications sent to their devices will appear here.')).toBeVisible();
  await expect(push.locator('.animate-pulse')).toHaveCount(0);
  await page.unroute((u) => u.pathname === history);

  let failures = 0;
  await page.route((u) => u.pathname === history, async (route) => {
    failures += 1;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) });
  });
  await page.goto(url);
  await expect(push.getByText("Couldn't load push history right now.")).toBeVisible();
  expect(failures).toBe(2);
  // The rest of the page still renders.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(anon.deviceFingerprint);
  await expect(page.getByText('No events recorded yet')).toBeVisible();
});

test('PPL-057 Push history funnel rows', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-push'), distinctId: uniqueId('d-push'), platform: 'ios' });
  const day = subDays(new Date(), 5);
  const t = (hour: number, minute = 0) => {
    const d = new Date(day);
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  const campaigns = [
    { title: 'C1 full funnel', sent: t(10), events: { delivered: t(10, 5), impression: t(10, 6), click: t(10, 7) } },
    { title: 'C2 delivered only', sent: t(9), events: { delivered: t(9, 5) } },
    { title: 'C3 click only', sent: t(8), events: { click: t(8, 7) } },
    { title: 'C4 dismissed', sent: t(7), events: { impression: t(7, 6), dismissed: t(7, 8) } },
    { title: 'C5 sent only', sent: t(6), events: { sent: t(6, 1) } },
  ];
  // Inserted oldest first, so the order shown comes from the sent times.
  for (const c of [...campaigns].reverse()) {
    const id = await insertCampaign(p.project.id, c.title, local(c.sent));
    for (const [type, when] of Object.entries(c.events)) await insertCampaignEvent(p.project.id, id, person.id, type, local(when));
  }
  const step = (d: Date) => format(d, 'MMM d, h:mm a');
  const sent = (d: Date) => format(d, 'MMM d, yyyy · h:mm a');

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${person.id}`);
  const rows = profileSection(page, 'Push Notifications').locator('div.divide-y > div');
  await expect(rows).toHaveCount(5);
  await expect(rows.locator('p.font-medium')).toHaveText(campaigns.map((c) => c.title));
  const steps = (i: number) => rows.nth(i).locator('div.mt-2 > div');
  const dimmed = async (i: number) => Promise.all((await steps(i).all()).map(async (s) => (await s.getAttribute('class'))!.includes('opacity-40')));

  const [c1, c2, c3, c4, c5] = campaigns;
  await expect(rows.nth(0)).toContainText(sent(c1.sent));
  await expect(steps(0)).toHaveText([`Delivered${step(c1.events.delivered!)}`, `Shown${step(c1.events.impression!)}`, `Clicked${step(c1.events.click!)}`]);
  expect(await dimmed(0)).toEqual([false, false, false]);

  await expect(steps(1)).toHaveText([`Delivered${step(c2.events.delivered!)}`, 'Shown', 'No action yet']);
  expect(await dimmed(1)).toEqual([false, true, true]);

  await expect(steps(2)).toHaveText(['Delivered', 'Shown', `Clicked${step(c3.events.click!)}`]);
  expect(await dimmed(2)).toEqual([true, true, false]);
  await expect(rows.nth(2).getByText('Never arrived')).toHaveCount(0);

  await expect(steps(3)).toHaveText(['Delivered', `Shown${step(c4.events.impression!)}`, `Dismissed${step(c4.events.dismissed!)}`]);
  expect(await dimmed(3)).toEqual([true, false, false]);

  await expect(rows.nth(4)).toHaveText(`${c5.title}Sent ${sent(c5.sent)} Never arrived`);
  await expect(steps(4)).toHaveCount(0);
});

test('PPL-061 Push history API permissions', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // The super admin grant runs the CLI through ts-node.
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const campaign = await insertCampaign(p.project.id, 'Reached Asha', local(subDays(new Date(), 1)));
  await insertCampaignEvent(p.project.id, campaign, asha.ios.id, 'delivered', local(new Date()));
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const outsider = await createAccount(clientIp, 'ppl-outsider', 'Olu Outsider');
  await createProject(outsider, clientIp);
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);
  const path = `/api/push-notifications/history/${p.project.id}/${asha.ios.id}`;

  for (const token of [member.accessToken, admin.accessToken, p.owner.accessToken, viewAs]) {
    const answer = await raw('GET', path, undefined, { ip: clientIp, token });
    expect(answer.status).toBe(200);
    expect(answer.body.data.deviceCount).toBe(2);
    expect(answer.body.data.campaigns).toEqual([expect.objectContaining({ campaignId: campaign, title: 'Reached Asha' })]);
  }
  const refused = await raw('GET', path, undefined, { ip: clientIp, token: outsider.accessToken });
  expect(refused.status).toBe(404);
  expect(refused.body.message).toBe(PROJECT_NOT_FOUND);
  expect(JSON.stringify(refused.body)).not.toContain('Reached Asha');
  expect((await raw('GET', path, undefined, { ip: clientIp })).status).toBe(401);
});

test('PPL-062 Member and admin can open a profile', async ({ browser, baseURL, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  expect((await trackEvent(p, clientIp, { deviceFingerprint: asha.ios.deviceFingerprint, eventName: 'viewed_pricing' })).status).toBe(201);
  const campaign = await insertCampaign(p.project.id, 'Spring sale', local(subDays(new Date(), 1)));
  await insertCampaignEvent(p.project.id, campaign, asha.ios.id, 'delivered', local(new Date()));

  for (const role of ['member', 'admin'] as const) {
    const teammate = await addTeammate(p.owner, p.project.id, role, clientIp);
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const page = await context.newPage();
      await signIn(page, teammate);
      const [detail, history] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === `/api/projects/${p.project.id}/users/${asha.ios.id}`),
        page.waitForResponse((r) => new URL(r.url()).pathname === `/api/push-notifications/history/${p.project.id}/${asha.ios.id}`),
        page.goto(`/projects/${p.project.id}/users/${asha.ios.id}`),
      ]);
      expect(detail.status()).toBe(200);
      expect(history.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('asha@example.com');
      await expect(profileSection(page, 'Events').getByRole('button', { name: /viewed_pricing/ })).toBeVisible();
      await expect(profileSection(page, 'Push Notifications').getByText('Spring sale')).toBeVisible();
      // Shown, though refused on use.
      await expect(page.getByRole('button', { name: 'Export data' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Delete person' })).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

// ---- Trait edit API

test('PPL-065 Trait merge succeeds for member, admin and owner', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-traits'), traits: { plan: 'pro', $name: 'Asha Rao' } });
  await sql(`UPDATE device_identities SET last_seen_at = now() - interval '2 hours' WHERE id = $1`, [person.id]);
  const seenBefore = (await deviceRow(person.id))!.last_seen_at.getTime();
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const [{ n: activityBefore }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM project_activity WHERE project_id = $1`, [p.project.id]);
  const path = `/api/projects/${p.project.id}/users/${person.id}/traits`;

  const edits: Array<[string, string, number]> = [
    [member.accessToken, 'enterprise-m', 1],
    [admin.accessToken, 'enterprise-a', 2],
    [p.owner.accessToken, 'enterprise', 2],
  ];
  for (const [token, plan, tier] of edits) {
    const answer = await raw('PATCH', path, { plan, tier }, { ip: clientIp, token });
    expect(answer.status).toBe(200);
    expect(answer.body.data.traits).toEqual({ plan, tier, $name: 'Asha Rao' });
  }
  const after = await deviceRow(person.id);
  expect(after!.traits).toEqual({ plan: 'enterprise', tier: 2, $name: 'Asha Rao' });
  expect(after!.last_seen_at.getTime()).toBe(seenBefore);
  const [{ n: activityAfter }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM project_activity WHERE project_id = $1`, [p.project.id]);
  expect(activityAfter).toBe(activityBefore);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${person.id}`);
  const props = await (async () => {
    await expect(page.getByRole('heading', { name: 'Profile Properties' })).toBeVisible();
    return profileProperties(page);
  })();
  expect(props.slice(0, 2)).toEqual([
    ['plan', 'enterprise'],
    ['tier', '2'],
  ]);
});

test('PPL-067 Trait edit on unknown, other-project or non-UUID person', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const q = await peopleProject(clientIp, 'ppl-other');
  const qPerson = await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q1'), traits: { plan: 'free' } });
  const own = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-p1') });
  const auth = { ip: clientIp, token: p.owner.accessToken };
  // A positive control: the same edit on the project's own person lands.
  expect((await raw('PATCH', `/api/projects/${p.project.id}/users/${own.id}/traits`, { plan: 'x' }, auth)).status).toBe(200);

  for (const id of ['00000000-0000-4000-8000-000000000000', qPerson.id, 'abc']) {
    const answer = await raw('PATCH', `/api/projects/${p.project.id}/users/${id}/traits`, { plan: 'hacked' }, auth);
    expect(answer.status).toBe(404);
    expect(answer.body.message).toBe(PERSON_NOT_FOUND);
  }
  expect((await deviceRow(qPerson.id))!.traits).toEqual({ plan: 'free' });
});

test('PPL-070 Trait edit racing an erasure does not bring the row back', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-erase');
  const person = await identify(p, clientIp, { deviceFingerprint: fp, traits: { plan: 'pro' } });
  const auth = { ip: clientIp, token: p.owner.accessToken };
  const path = `/api/projects/${p.project.id}/users/${person.id}/traits`;
  expect((await raw('PATCH', path, { plan: 'before' }, auth)).status).toBe(200);

  const erased = await raw('DELETE', `/api/projects/${p.project.id}/users/${person.id}`, undefined, auth);
  expect(erased.status).toBe(200);
  const answer = await raw('PATCH', path, { plan: 'after' }, auth);
  expect(answer.status).toBe(404);
  expect(answer.body.message).toBe(PERSON_NOT_FOUND);
  expect(await deviceRow(person.id)).toBeUndefined();
  expect(await deviceByFingerprint(p.project.id, fp)).toBeUndefined();
});

// ---- SDK identify

test('PPL-072 Repeat identify updates the same row', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-new');
  const first = await identify(p, clientIp, { deviceFingerprint: fp, traits: { plan: 'free' }, utmSource: 'google', firstName: 'Nia', model: 'Pixel 8' });
  await sql(`UPDATE device_identities SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, [first.id]);
  const seenBefore = (await deviceRow(first.id))!.last_seen_at.getTime();

  const second = await identify(p, clientIp, { deviceFingerprint: fp, traits: { seen: true }, utmSource: 'bing', os: 'macOS' });
  expect(second.id).toBe(first.id);
  const row = await deviceRow(first.id);
  expect(row).toMatchObject({
    total_sessions: 2,
    traits: { plan: 'free', seen: true },
    initial_utm_source: 'google',
    latest_utm_source: 'bing',
    os: 'macOS',
    first_name: 'Nia',
    model: 'Pixel 8',
  });
  expect(row!.last_seen_at.getTime()).toBeGreaterThan(seenBefore);
  expect(await sql(`SELECT id FROM device_identities WHERE project_id = $1`, [p.project.id])).toHaveLength(1);
});

test('PPL-075 Identify body validation', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const base = { projectId: p.project.id, deviceFingerprint: fingerprint('fp-valid'), platform: 'web' };
  const omit = (key: keyof typeof base) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['projectId', { ...base, projectId: 'abc' }, 'projectId must be a UUID'],
    ['no deviceFingerprint', omit('deviceFingerprint'), 'deviceFingerprint must be a string'],
    ['no platform', omit('platform'), 'platform must be a string'],
    ['platform 51', { ...base, platform: 'p'.repeat(51) }, 'platform must be shorter than or equal to 50 characters'],
    ['fingerprint 256', { ...base, deviceFingerprint: 'f'.repeat(256) }, 'deviceFingerprint must be shorter than or equal to 255 characters'],
    ['locale 36', { ...base, locale: 'l'.repeat(36) }, 'locale must be shorter than or equal to 35 characters'],
    ['traits string', { ...base, traits: 'x' }, 'traits must be an object'],
    ['screenWidth', { ...base, screenWidth: 'wide' }, 'screenWidth must be a number conforming to the specified constraints'],
    ['email 321', { ...base, email: `${'e'.repeat(309)}@example.com` }, 'email must be shorter than or equal to 320 characters'],
    ['phone 21', { ...base, phone: '+'.padEnd(21, '9') }, 'phone must be shorter than or equal to 20 characters'],
    ['avatar 2049', { ...base, avatar: `https://a.example/${'a'.repeat(2049 - 18)}` }, 'avatar must be shorter than or equal to 2048 characters'],
    ['userHash 129', { ...base, externalUserId: 'user-x', userHash: 'a'.repeat(129) }, 'userHash must be shorter than or equal to 128 characters'],
  ];
  for (const [label, body, message] of cases) {
    const answer = await raw('POST', '/api/identity/identify', body, { ip: clientIp, apiKey: p.sdkKey });
    expect(answer.status, label).toBe(400);
    expect(Array.isArray(answer.body.message), label).toBe(true);
    expect(answer.body.message, label).toContain(message);
  }
  expect(await sql(`SELECT id FROM device_identities WHERE project_id = $1`, [p.project.id])).toEqual([]);
  // The base body itself is accepted, so each refusal above is the one field's.
  expect((await raw('POST', '/api/identity/identify', base, { ip: clientIp, apiKey: p.sdkKey })).status).toBe(201);
});

test('PPL-079 Rotating the identity secret stops old hashes', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const externalUserId = uniqueId('user-rot');
  const oldHash = userHash(p.secret, externalUserId);
  const body = (hash: string) => ({ projectId: p.project.id, deviceFingerprint: fingerprint('fp-rot'), platform: 'web', externalUserId, userHash: hash });
  // The old hash works before the rotation.
  expect((await raw('POST', '/api/identity/identify', body(oldHash), { ip: clientIp, apiKey: p.sdkKey })).status).toBe(201);

  const rotated = await api<{ secret: string; version: number }>('POST', `/api/projects/${p.project.id}/identity-secret/rotate`, undefined, { token: p.owner.accessToken, ip: clientIp });
  expect(rotated.secret).not.toBe(p.secret);

  const stale = await raw('POST', '/api/identity/identify', body(oldHash), { ip: clientIp, apiKey: p.sdkKey });
  expect(stale.status).toBe(401);
  expect(stale.body.message).toBe(USER_HASH_REQUIRED);
  const fresh = await raw('POST', '/api/identity/identify', body(userHash(rotated.secret, externalUserId)), { ip: clientIp, apiKey: p.sdkKey });
  expect(fresh.status).toBe(201);
  expect(fresh.body.data.externalUserId).toBe(externalUserId);
});

test('PPL-080 Email and phone normalisation on identify', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const one = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-1'), email: ' Mixed@Example.COM ' });
  const two = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-2'), traits: { $email: 't@example.com' } });
  const three = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-3'), phone: '9800000001' });
  const four = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-4'), phone: '+91 98000 00002' });

  expect(await deviceRow(one.id)).toMatchObject({ email: 'mixed@example.com' });
  expect(await deviceRow(two.id)).toMatchObject({ email: 't@example.com' });
  // No country code, so no number is guessed.
  expect(await deviceRow(three.id)).toMatchObject({ phone: '9800000001', phone_e164: null });
  expect(await deviceRow(four.id)).toMatchObject({ phone: '+91 98000 00002', phone_e164: '+919800000002' });

  // A value that is not an address never clears a good one.
  await identify(p, clientIp, { deviceFingerprint: one.deviceFingerprint, traits: { email: 'not-an-address' } });
  expect(await deviceRow(one.id)).toMatchObject({ email: 'mixed@example.com', traits: { email: 'not-an-address' } });
});

test('PPL-083 Consent changes from the SDK are recorded once', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-consent');
  const body = { deviceFingerprint: fp, pushOptIn: true, emailOptIn: false, doNotTrack: false };
  const person = await identify(p, clientIp, body);
  const sorted = async () => (await consentEvents(person.id)).map((e) => `${e.channel}:${e.granted}:${e.source}`).sort();
  expect(await sorted()).toEqual(['email:false:sdk', 'push:true:sdk', 'tracking:true:sdk']);
  expect((await deviceRow(person.id))!.consent_updated_at).not.toBeNull();

  await identify(p, clientIp, body);
  expect(await consentEvents(person.id)).toHaveLength(3);

  await identify(p, clientIp, { deviceFingerprint: fp, emailOptIn: true });
  const afterGrant = await consentEvents(person.id);
  expect(afterGrant).toHaveLength(4);
  expect(afterGrant[3]).toEqual({ channel: 'email', granted: true, source: 'sdk' });

  await identify(p, clientIp, { deviceFingerprint: fp, emailOptIn: null });
  expect(await consentEvents(person.id)).toHaveLength(4);
  expect(await deviceRow(person.id)).toMatchObject({ email_opt_in: true, push_opt_in: true, do_not_track: false });
});

test('PPL-085 SDK can lift its own do-not-track', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-dnt');
  const person = await identify(p, clientIp, { deviceFingerprint: fp, doNotTrack: true });
  expect(await deviceRow(person.id)).toMatchObject({ do_not_track: true, do_not_track_source: 'sdk', total_sessions: 0 });

  await identify(p, clientIp, { deviceFingerprint: fp, doNotTrack: false });
  expect(await deviceRow(person.id)).toMatchObject({ do_not_track: false, do_not_track_source: 'sdk' });
  expect((await consentEvents(person.id)).filter((e) => e.channel === 'tracking')).toEqual([
    { channel: 'tracking', granted: false, source: 'sdk' },
    { channel: 'tracking', granted: true, source: 'sdk' },
  ]);

  // The next identify is tracked again: a session, the address and geo.
  await identify(p, clientIp, { deviceFingerprint: fp, utmSource: 'back' });
  expect(await deviceRow(person.id)).toMatchObject({ total_sessions: 1, ip_address: clientIp, country: 'India', latest_utm_source: 'back' });
});

test('PPL-088 A stranger claiming a do-not-track device\'s id is still tracked', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const distinctId = uniqueId('d-1');
  const dnt = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-dnt'), doNotTrack: true, distinctId, utmSource: 'x' });
  expect(await deviceRow(dnt.id)).toMatchObject({ do_not_track: true, total_sessions: 0, ip_address: null, initial_utm_source: null });

  const other = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-other'), distinctId, utmSource: 'y' });
  expect(await deviceRow(other.id)).toMatchObject({
    do_not_track: false,
    total_sessions: 1,
    ip_address: clientIp,
    country: 'India',
    initial_utm_source: 'y',
    distinct_id: distinctId,
  });
});

test('PPL-091 Identify with string booleans is refused or stored as sent',{ annotation: { type: 'issue', description: 'PPL-091' } }, async ({ clientIp }) => {
  test.fail();
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-strings');
  const answer = await raw(
    'POST',
    '/api/identity/identify',
    { projectId: p.project.id, deviceFingerprint: fp, platform: 'web', emailOptIn: 'false', doNotTrack: 'false' },
    { ip: clientIp, apiKey: p.sdkKey },
  );
  if (answer.status === 400) {
    expect(messageOf(answer)).toContain('emailOptIn must be a boolean value');
    expect(await deviceByFingerprint(p.project.id, fp)).toBeUndefined();
  } else {
    expect(answer.status).toBe(201);
    expect(await deviceByFingerprint(p.project.id, fp)).toMatchObject({ email_opt_in: false, do_not_track: false });
  }
});

// ---- link-device, merge and revenue

test('PPL-092 Link device with a verified external id', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const externalUserId = uniqueId('user-ld');
  const fp = fingerprint('fp-ld');
  const answer = await raw(
    'POST',
    '/api/identity/link-device',
    { projectId: p.project.id, deviceFingerprint: fp, platform: 'ios', externalUserId, userHash: userHash(p.secret, externalUserId) },
    { ip: clientIp, apiKey: p.sdkKey },
  );
  expect(answer.status).toBe(201);
  expect(answer.body.data).toMatchObject({ deviceFingerprint: fp, externalUserId, platform: 'ios' });
  expect(await deviceByFingerprint(p.project.id, fp)).toMatchObject({ external_user_id: externalUserId, platform: 'ios', total_sessions: 1 });
});

test('PPL-093 Link device validation', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const q = await peopleProject(clientIp, 'ppl-other');
  const externalUserId = uniqueId('user-ld');
  const base = { projectId: p.project.id, deviceFingerprint: fingerprint('fp-ld'), platform: 'ios', externalUserId, userHash: userHash(p.secret, externalUserId) };
  const without = (key: string) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ['platform', { ...base, platform: 'windows' }, 400, 'platform must be one of the following values: ios, android, web'],
    ['empty externalUserId', { ...base, externalUserId: '' }, 400, 'externalUserId should not be empty'],
    ['no externalUserId', without('externalUserId'), 400, 'externalUserId should not be empty'],
    ['no userHash', without('userHash'), 401, USER_HASH_REQUIRED],
    ['ipAddress', { ...base, ipAddress: '1.1.1.1' }, 400, 'property ipAddress should not exist'],
    ['other project', { ...base, projectId: q.project.id }, 403, 'Project mismatch'],
    ['empty fingerprint', { ...base, deviceFingerprint: '' }, 400, 'deviceFingerprint should not be empty'],
  ];
  for (const [label, body, status, message] of cases) {
    const answer = await raw('POST', '/api/identity/link-device', body, { ip: clientIp, apiKey: p.sdkKey });
    expect(answer.status, label).toBe(status);
    expect(messageOf(answer), label).toContain(message);
  }
  expect(await sql(`SELECT id FROM device_identities WHERE project_id = ANY($1::uuid[])`, [[p.project.id, q.project.id]])).toEqual([]);
  expect((await raw('POST', '/api/identity/link-device', base, { ip: clientIp, apiKey: p.sdkKey })).status).toBe(201);
});

test('PPL-094 Merge relabels the anonymous id within the project only', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const q = await peopleProject(clientIp, 'ppl-other', p.owner);
  const anonymousId = uniqueId('anon-m');
  const identifiedId = uniqueId('user-m');
  const device = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-m'), distinctId: anonymousId });
  await sql(`UPDATE device_identities SET last_seen_at = now() - interval '3 hours' WHERE id = $1`, [device.id]);
  const seenBefore = (await deviceRow(device.id))!.last_seen_at.getTime();
  expect((await trackEvent(p, clientIp, { distinctId: anonymousId, eventName: 'browsed' })).status).toBe(201);
  expect((await trackEvent(q, clientIp, { distinctId: anonymousId, eventName: 'browsed' })).status).toBe(201);
  await seedTouchpoint(p.project.id, null, anonymousId);
  await seedTouchpoint(q.project.id, null, anonymousId);
  for (const project of [p, q]) {
    const link = await createLink(p.owner, clientIp, project.project.id);
    await sql(
      `INSERT INTO click_events (link_id, platform, device_type, redirect_type, distinct_id) VALUES ($1, 'desktop', 'desktop', 'web', $2)`,
      [link.id, anonymousId],
    );
    await sql(`INSERT INTO conversion_events (link_id, event_type, distinct_id) VALUES ($1, 'signup', $2)`, [link.id, anonymousId]);
  }
  const heldBy = async (projectId: string, id: string) =>
    (
      await sql<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM user_events WHERE project_id = $1 AND distinct_id = $2) AS events,
                (SELECT count(*)::int FROM touchpoints WHERE project_id = $1 AND distinct_id = $2) AS touchpoints,
                (SELECT count(*)::int FROM click_events c JOIN links l ON l.id = c.link_id WHERE l.project_id = $1 AND c.distinct_id = $2) AS clicks,
                (SELECT count(*)::int FROM conversion_events c JOIN links l ON l.id = c.link_id WHERE l.project_id = $1 AND c.distinct_id = $2) AS conversions`,
        [projectId, id],
      )
    )[0];
  expect(await heldBy(p.project.id, anonymousId)).toEqual({ events: 1, touchpoints: 1, clicks: 1, conversions: 1 });

  const merged = await raw('POST', '/api/identity/merge', { projectId: p.project.id, anonymousId, identifiedId }, { ip: clientIp, apiKey: p.sdkKey });
  expect(merged.status).toBe(201);
  expect(merged.body.data).toEqual({ success: true });

  expect(await sql(`SELECT anonymous_id, identified_id FROM identity_aliases WHERE project_id = $1`, [p.project.id])).toEqual([
    { anonymous_id: anonymousId, identified_id: identifiedId },
  ]);
  const row = await deviceRow(device.id);
  expect(row!.distinct_id).toBe(identifiedId);
  expect(row!.last_seen_at.getTime()).toBe(seenBefore);
  expect(await heldBy(p.project.id, identifiedId)).toEqual({ events: 1, touchpoints: 1, clicks: 1, conversions: 1 });
  expect(await heldBy(p.project.id, anonymousId)).toEqual({ events: 0, touchpoints: 0, clicks: 0, conversions: 0 });
  // The other project keeps its rows under the anonymous id.
  expect(await heldBy(q.project.id, anonymousId)).toEqual({ events: 1, touchpoints: 1, clicks: 1, conversions: 1 });
  expect(await heldBy(q.project.id, identifiedId)).toEqual({ events: 0, touchpoints: 0, clicks: 0, conversions: 0 });
  expect(await sql(`SELECT id FROM identity_aliases WHERE project_id = $1`, [q.project.id])).toEqual([]);
});

test('PPL-096 Revenue adds to the device\'s total', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-ravi');
  const ravi = await identify(p, clientIp, { deviceFingerprint: fp, platform: 'android', firstName: 'Ravi', lastName: 'Kumar' });
  expect((await revenue(p, clientIp, fp, 49.5, 'INR')).status).toBe(201);
  expect(Number((await deviceRow(ravi.id))!.total_revenue)).toBe(49.5);

  const answer = await revenue(p, clientIp, fp, 10.25, 'INR');
  expect(answer.status).toBe(201);
  expect(answer.body.data).toEqual({ success: true });
  const row = await deviceRow(ravi.id);
  expect(Number(row!.total_revenue)).toBe(59.75);
  expect(row!.currency).toBe('INR');
  expect(row!.last_event_at).not.toBeNull();

  await signIn(page, p.owner);
  await openList(page, p);
  await expect(bodyRows(page).filter({ hasText: 'Ravi Kumar' }).locator('[data-slot="table-cell"]').nth(6)).toHaveText('$59.75');
  await expect(statValue(page, 'With Revenue')).toHaveText('1');
  await expect(statValue(page, 'Total Revenue')).toHaveText('$59.75');
});

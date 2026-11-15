import { randomBytes, randomUUID } from 'crypto';
import { api, createApiKey, newClientIp } from '../../support/api';
import { expect, signIn, test } from '../../support/fixtures';
import {
  PROJECT_NOT_FOUND,
  apiLogFailures,
  bodyRows,
  cardTitled,
  channelCounts,
  chooseAttributionModel,
  click,
  clickResponse,
  collectDialogs,
  countEvents,
  creditLabel,
  daysAgo,
  deviceByFingerprint,
  eventSelectOptions,
  eventTimeLabel,
  getAs,
  identify,
  identitySecret,
  insertEvents,
  journeyCard,
  journeyEntries,
  journeyTimeLabel,
  logEventNames,
  openViewAs,
  postConversion,
  queryOf,
  raw,
  recordRequests,
  responseFor,
  roleSet,
  scriptsContaining,
  sdkProject,
  searchJourney,
  seedLink,
  seedTouchpoints,
  seedTrapKey,
  sleep,
  sql,
  statValue,
  suspendAccount,
  timeDecayCredits,
  topEvents,
  trackEvent,
  uniqueId,
  userHash,
  viewAsHandoff,
  waitForAttribution,
  waitForLinkClicks,
  waitForTouchpoints,
  wholeSecond,
  type SdkProject,
} from '../../support/areas/anly';

/**
 * The Touchpoints page (journey search and Channel Distribution), the event explorer
 * (log, filter, ranges, list parameters), SDK event ingest (identity, validation,
 * suspension, keys), view-as across the four pages, and what erasure leaves on them.
 */

test.describe.configure({ mode: 'parallel' });

const HOUR_MS = 60 * 60 * 1000;

/** The Channel Distribution table's rows as [channel, count, share]. */
async function distributionRows(page: import('@playwright/test').Page): Promise<string[][]> {
  return bodyRows(cardTitled(page, 'Channel Distribution'));
}

async function openTouchpoints(page: import('@playwright/test').Page, p: SdkProject): Promise<void> {
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/touchpoints`);
  await expect(page.getByRole('heading', { level: 1, name: 'Touchpoints' })).toBeVisible();
}

async function openEvents(page: import('@playwright/test').Page, p: SdkProject): Promise<void> {
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/events`);
  await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Touchpoints page
// ---------------------------------------------------------------------------

test('ANLY-075 journey search by button and by Enter, trimmed', async ({ page }) => {
  const p = await sdkProject('anly075');
  await seedTouchpoints(p.project.id, [{ distinctId: 'user-42', channel: 'google', touchedAt: daysAgo(1) }]);
  await openTouchpoints(page, p);
  const journeyPath = `/api/projects/${p.project.id}/touchpoints/journey/user-42`;

  const byButton = page.waitForRequest((request) => new URL(request.url()).pathname === journeyPath);
  await searchJourney(page, '  user-42  ');
  expect(queryOf((await byButton).url())).toEqual({ lookbackDays: '30' });
  await expect(journeyEntries(page)).toHaveCount(1);
  await expect(journeyEntries(page).first()).toContainText('link_click');

  await page.reload();
  await expect(journeyCard(page).getByText('Enter a distinct ID to view the user journey')).toBeVisible();
  const byEnter = page.waitForRequest((request) => new URL(request.url()).pathname === journeyPath);
  await searchJourney(page, 'user-42', 'enter');
  expect(queryOf((await byEnter).url())).toEqual({ lookbackDays: '30' });
  await expect(journeyEntries(page)).toHaveCount(1);
  await expect(journeyEntries(page).first()).toContainText('google');
});

test('ANLY-076 an unknown distinct id has no journey', async ({ page }) => {
  const p = await sdkProject('anly076');
  await seedTouchpoints(p.project.id, [{ distinctId: 'somebody', channel: 'google', touchedAt: daysAgo(1) }]);
  await openTouchpoints(page, p);
  const answered = responseFor(page, `/api/projects/${p.project.id}/touchpoints/journey/nobody-here`);
  await searchJourney(page, 'nobody-here');
  expect((await (await answered).json()).data).toEqual([]);
  await expect(journeyCard(page).getByText('No touchpoints found for this user', { exact: true })).toBeVisible();
  await expect(journeyEntries(page)).toHaveCount(0);
});

test('ANLY-077 journey timeline content', async ({ page }) => {
  const p = await sdkProject('anly077');
  const now = new Date();
  const [linkAt, pushAt, emailAt] = [3, 1, 2].map((days) => wholeSecond(daysAgo(days, now)));
  await seedTouchpoints(p.project.id, [
    { distinctId: 'user-43', touchpointType: 'link_click', channel: 'google', utmSource: 'google', utmMedium: 'cpc', campaign: 'spring', platform: 'ios', touchedAt: linkAt },
    { distinctId: 'user-43', touchpointType: 'push_click', channel: 'push', campaign: 'Weekly', touchedAt: pushAt },
    { distinctId: 'user-43', touchpointType: 'email_open', channel: 'email', touchedAt: emailAt },
  ]);
  await openTouchpoints(page, p);
  await searchJourney(page, 'user-43');
  const entries = journeyEntries(page);
  await expect(entries).toHaveCount(3);

  // Oldest first: link_click (T-3d), email_open (T-2d), push_click (T-1d).
  const [first, second, third] = [entries.nth(0), entries.nth(1), entries.nth(2)];
  await expect(first.locator('[data-slot="badge"]')).toHaveText(['link_click', 'google']);
  await expect(first.getByText('ios', { exact: true })).toBeVisible();
  await expect(first.getByText('Campaign: spring', { exact: true })).toBeVisible();
  await expect(first.getByText('utm_source: google', { exact: true })).toBeVisible();
  await expect(first.getByText('utm_medium: cpc', { exact: true })).toBeVisible();
  await expect(first.getByText(journeyTimeLabel(linkAt), { exact: true })).toBeVisible();

  await expect(second.locator('[data-slot="badge"]')).toHaveText(['email_open', 'email']);
  await expect(second.getByText(journeyTimeLabel(emailAt), { exact: true })).toBeVisible();
  await expect(second.getByText(/Campaign:|utm_source:|utm_medium:/)).toHaveCount(0);

  await expect(third.locator('[data-slot="badge"]')).toHaveText(['push_click', 'push']);
  await expect(third.getByText('Campaign: Weekly', { exact: true })).toBeVisible();
  await expect(third.getByText(/utm_source:|utm_medium:/)).toHaveCount(0);
  await expect(third.getByText(journeyTimeLabel(pushAt), { exact: true })).toBeVisible();
  // No platform on the last two: only the badges sit on their first line.
  for (const entry of [second, third]) {
    await expect(entry.locator('div.flex.items-center.gap-2 > span:not([data-slot="badge"])')).toHaveCount(0);
  }
  await expect(first.locator('div.flex.items-center.gap-2 > span:not([data-slot="badge"])')).toHaveText(['ios']);
});

test('ANLY-078 the journey shows only the last 30 days', async ({ page }) => {
  // The page has no control for the lookback the API accepts.
  const p = await sdkProject('anly078');
  const recent = wholeSecond(daysAgo(10));
  await seedTouchpoints(p.project.id, [
    { distinctId: 'user-44', channel: 'recent', touchedAt: recent },
    { distinctId: 'user-44', channel: 'old', touchedAt: daysAgo(31) },
  ]);
  // Both rows exist: a wider lookback on the API returns the older one too.
  const wide = await getAs(p.owner, `/api/projects/${p.project.id}/touchpoints/journey/user-44?lookbackDays=90`);
  expect(wide.body.data.map((tp: { channel: string }) => tp.channel)).toEqual(['old', 'recent']);

  await openTouchpoints(page, p);
  await searchJourney(page, 'user-44');
  await expect(journeyEntries(page)).toHaveCount(1);
  await expect(journeyEntries(page).first().locator('[data-slot="badge"]')).toHaveText(['link_click', 'recent']);
  await expect(journeyEntries(page).first().getByText(journeyTimeLabel(recent), { exact: true })).toBeVisible();
  await expect(journeyCard(page).getByRole('combobox')).toHaveCount(0);
  await expect(journeyCard(page).getByRole('textbox')).toHaveCount(1);
  await expect(journeyCard(page).getByRole('button')).toHaveText(['Search']);
});

test('ANLY-079 a journey from real traffic is empty', async ({ page }) => {
  // Current behaviour as the case states it: the redirect's touchpoint names no person.
  const p = await sdkProject('anly079');
  const secret = await identitySecret(p);
  const fp = uniqueId('fp-real');
  await identify(p, { deviceFingerprint: fp, distinctId: 'anon-1', externalUserId: 'u-15', userHash: userHash(secret, 'u-15') });
  const link = await seedLink(p.owner, p.project.id, 'anly079');
  expect(await click(link.shortCode, newClientIp(), { cookie: `chumbaq_did=${fp}`, query: '?utm_source=realtraffic&utm_campaign=autumn' })).toBe(302);
  await waitForLinkClicks(link.id, 1);
  await waitForTouchpoints(p.project.id, 1);
  const [stored] = await sql('SELECT distinct_id, device_fingerprint, channel FROM touchpoints WHERE project_id = $1', [p.project.id]);
  expect(stored).toEqual({ distinct_id: null, device_fingerprint: fp, channel: 'realtraffic' });

  await openTouchpoints(page, p);
  for (const id of ['anon-1', 'u-15', fp]) {
    const answered = responseFor(page, `/api/projects/${p.project.id}/touchpoints/journey/${id}`);
    await searchJourney(page, id);
    expect((await (await answered).json()).data, id).toEqual([]);
    await expect(journeyCard(page).getByText('No touchpoints found for this user', { exact: true }), id).toBeVisible();
  }
  expect(await distributionRows(page)).toEqual([['realtraffic', '1', '100.0%']]);
});

test('ANLY-085 Channel Distribution from real clicks', async ({ page }) => {
  const p = await sdkProject('anly085');
  const link = await seedLink(p.owner, p.project.id, 'anly085');
  for (const extra of [
    { query: '?utm_source=newsletter' },
    { query: '?utm_source=newsletter' },
    { referer: 'https://www.facebook.com/' },
    { referer: 'https://www.google.com/' },
    {},
  ]) {
    expect(await click(link.shortCode, newClientIp(), extra)).toBe(302);
  }
  await waitForTouchpoints(p.project.id, 5);

  await openTouchpoints(page, p);
  const card = cardTitled(page, 'Channel Distribution');
  await expect(card.getByText('Touchpoint volume by channel')).toBeVisible();
  await expect(card.locator('tbody tr')).toHaveCount(4);
  const [top, ...rest] = await distributionRows(page);
  expect(top).toEqual(['newsletter', '2', '40.0%']);
  expect(rest.sort()).toEqual([
    ['direct', '1', '20.0%'],
    ['facebook', '1', '20.0%'],
    ['google', '1', '20.0%'],
  ]);
});

test('ANLY-091 a do-not-track device writes no touchpoint', async () => {
  const p = await sdkProject('anly091');
  const fp = uniqueId('fp-dnt');
  await identify(p, { deviceFingerprint: fp, doNotTrack: true });
  const link = await seedLink(p.owner, p.project.id, 'anly091');
  expect(await click(link.shortCode, newClientIp(), { cookie: `chumbaq_did=${fp}`, query: '?utm_source=dnt-test' })).toBe(302);
  await waitForLinkClicks(link.id, 1);
  // Control, sent only once the first click is stored: the same click from a device
  // without the flag writes one. Its touchpoint goes through the same check and then an
  // insert, so once it is stored the first click's touchpoint has long been decided.
  expect(await click(link.shortCode, newClientIp(), { cookie: `chumbaq_did=${uniqueId('fp-ok')}`, query: '?utm_source=dnt-control' })).toBe(302);
  await waitForLinkClicks(link.id, 2);
  await waitForTouchpoints(p.project.id, 1);

  expect(await channelCounts(p.owner, p.project.id)).toEqual([['dnt-control', 1]]);
  const summary = await getAs(p.owner, `/api/projects/${p.project.id}/analytics/summary`);
  expect(summary.body.data.totalClicks).toBe(2);
});

test('ANLY-092 Channel Distribution ranges', async ({ page }) => {
  const p = await sdkProject('anly092');
  await seedTouchpoints(p.project.id, [
    { distinctId: 'r-1', channel: 'google', touchedAt: daysAgo(3) },
    { distinctId: 'r-2', channel: 'email', touchedAt: daysAgo(20) },
    { distinctId: 'r-3', channel: 'push', touchedAt: daysAgo(60) },
  ]);
  const channelsPath = `/api/projects/${p.project.id}/touchpoints/channels`;
  const requests = recordRequests(page, channelsPath);
  await openTouchpoints(page, p);
  const card = cardTitled(page, 'Channel Distribution');
  const span = (url: string) => {
    const { start, end } = queryOf(url);
    return Math.round((new Date(end).getTime() - new Date(start).getTime()) / (24 * HOUR_MS));
  };

  await expect(card.locator('tbody tr')).toHaveCount(2);
  expect((await distributionRows(page)).sort()).toEqual([
    ['email', '1', '50.0%'],
    ['google', '1', '50.0%'],
  ]);
  expect(span(requests[requests.length - 1])).toBe(30);

  const week = responseFor(page, channelsPath);
  await card.getByRole('button', { name: '7d', exact: true }).click();
  expect(span((await week).url())).toBe(7);
  await expect.poll(() => distributionRows(page)).toEqual([['google', '1', '100.0%']]);

  const quarter = responseFor(page, channelsPath);
  await card.getByRole('button', { name: '90d', exact: true }).click();
  expect(span((await quarter).url())).toBe(90);
  await expect(card.locator('tbody tr')).toHaveCount(3);
  expect((await distributionRows(page)).sort()).toEqual([
    ['email', '1', '33.3%'],
    ['google', '1', '33.3%'],
    ['push', '1', '33.3%'],
  ]);
});

// ---------------------------------------------------------------------------
// Event explorer
// ---------------------------------------------------------------------------

test('ANLY-097 event explorer empty states', async ({ page }) => {
  const p = await sdkProject('anly097');
  await openEvents(page, p);
  const volume = page.locator('[data-slot="card"]').filter({ hasText: 'Event Volume' });
  await expect(volume.getByText('No events in this period', { exact: true })).toBeVisible();
  await expect(cardTitled(page, 'Top Events').getByText('No data', { exact: true })).toBeVisible();
  const log = cardTitled(page, 'Event Log');
  await expect(log.getByText('No events found.', { exact: true })).toBeVisible();
  await expect(log.locator('svg.lucide-activity')).toHaveCount(1);
  await expect(log.locator('table')).toHaveCount(0);
  expect(await eventSelectOptions(page)).toEqual(['All events']);
});

test('ANLY-099 expand and collapse event properties', async ({ page }) => {
  const p = await sdkProject('anly099');
  const props = { cart: 3, items: ['x'] };
  expect((await trackEvent(p, { eventName: 'with_props', distinctId: 'u-a', properties: props, timestamp: new Date(Date.now() - 2 * 60_000).toISOString() })).status).toBe(201);
  expect((await trackEvent(p, { eventName: 'no_props', distinctId: 'u-b', timestamp: new Date(Date.now() - 60_000).toISOString() })).status).toBe(201);
  await openEvents(page, p);
  const log = cardTitled(page, 'Event Log');
  const rowA = log.locator('tbody tr').filter({ hasText: 'with_props' });
  const rowB = log.locator('tbody tr').filter({ hasText: 'no_props' });
  await expect(rowA).toHaveCount(1);
  await expect(rowA.locator('td').first().locator('svg.lucide-chevron-right')).toHaveCount(1);
  await expect(rowB.locator('td').first().locator('svg')).toHaveCount(0);
  await expect(log.locator('pre')).toHaveCount(0);

  await rowA.click();
  await expect(log.locator('pre')).toHaveText(JSON.stringify(props, null, 2));
  await expect(log.locator('tbody tr')).toHaveCount(3);
  await expect(log.locator('pre').locator('xpath=ancestor::td[1]')).toHaveAttribute('colspan', '5');
  await expect(rowA.locator('td').first().locator('svg.lucide-chevron-down')).toHaveCount(1);
  await expect(rowA.locator('td').first().locator('svg.lucide-chevron-right')).toHaveCount(0);

  // One row open at a time; B has nothing to open.
  await rowB.click();
  await expect(log.locator('pre')).toHaveCount(0);
  await expect(log.locator('tbody tr')).toHaveCount(2);
  await expect(rowA.locator('td').first().locator('svg.lucide-chevron-right')).toHaveCount(1);
  await rowB.click();
  await expect(log.locator('pre')).toHaveCount(0);
  await expect(log.locator('tbody tr')).toHaveCount(2);

  // A toggles open and closed.
  await rowA.click();
  await expect(log.locator('pre')).toHaveCount(1);
  await rowA.click();
  await expect(log.locator('pre')).toHaveCount(0);
});

test('ANLY-102 events newest first, by their own timestamp', async ({ page }) => {
  const p = await sdkProject('anly102');
  const now = Date.now();
  for (const [name, hours] of [['one_hour_ago', 1], ['three_hours_ago', 3], ['two_hours_ago', 2]] as const) {
    const tracked = await trackEvent(p, { eventName: name, distinctId: 'u-102', timestamp: new Date(now - hours * HOUR_MS).toISOString() });
    expect(tracked.status).toBe(201);
  }
  await openEvents(page, p);
  const log = cardTitled(page, 'Event Log');
  await expect(log.locator('tbody tr')).toHaveCount(3);
  expect(await logEventNames(page)).toEqual(['one_hour_ago', 'two_hours_ago', 'three_hours_ago']);
  const times = (await bodyRows(log)).map((row) => row[4]);
  expect(times).toEqual([1, 2, 3].map((hours) => eventTimeLabel(new Date(now - hours * HOUR_MS))));
});

test('ANLY-103 only the first 30 events are reachable', async ({ page }) => {
  // Current behaviour as the case states it: the page renders no paging control.
  const p = await sdkProject('anly103');
  const now = Date.now();
  await insertEvents(
    p.project.id,
    Array.from({ length: 45 }, (_, i) => ({ eventName: `ev_${String(i + 1).padStart(2, '0')}`, distinctId: 'u-103', timestamp: wholeSecond(new Date(now - (i + 1) * 60_000)) })),
  );
  const eventsPath = `/api/projects/${p.project.id}/events`;
  const listed = page.waitForResponse((response) => new URL(response.url()).pathname === eventsPath);
  await openEvents(page, p);
  const response = await listed;
  expect(queryOf(response.url())).toMatchObject({ limit: '30', offset: '0' });
  expect((await response.json()).data.total).toBe(45);

  const log = cardTitled(page, 'Event Log');
  await expect(log.locator('tbody tr')).toHaveCount(30);
  const names = await logEventNames(page);
  expect(names[0]).toBe('ev_01');
  expect(names[29]).toBe('ev_30');
  await expect(log.getByText('ev_31', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /next|previous|prev|more|page/i })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: /pagination/i })).toHaveCount(0);
  await expect(page.getByText(/\b45\b (events|total|results)|of 45/)).toHaveCount(0);
});

test('ANLY-104 filter by event name', async ({ page }) => {
  const p = await sdkProject('anly104');
  for (let i = 0; i < 3; i += 1) expect((await trackEvent(p, { eventName: 'signup', distinctId: `s-${i}` })).status).toBe(201);
  for (let i = 0; i < 5; i += 1) expect((await trackEvent(p, { eventName: 'purchase', distinctId: `b-${i}` })).status).toBe(201);
  const withName: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith(`/api/projects/${p.project.id}/events`) && url.searchParams.has('eventName')) withName.push(request.url());
  });
  await openEvents(page, p);
  const log = cardTitled(page, 'Event Log');
  await expect(log.locator('tbody tr')).toHaveCount(8);
  expect(await eventSelectOptions(page)).toEqual(['All events', 'purchase (5)', 'signup (3)']);
  expect(withName).toEqual([]);

  const volumePath = `/api/projects/${p.project.id}/events/volume`;
  const filteredVolume = page.waitForRequest((request) => new URL(request.url()).pathname === volumePath && queryOf(request.url()).eventName === 'purchase');
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'purchase (5)', exact: true }).click();
  await filteredVolume;
  await expect(page.getByRole('combobox')).toHaveText('purchase (5)');
  await expect(log.locator('tbody tr')).toHaveCount(5);
  expect(new Set(await logEventNames(page))).toEqual(new Set(['purchase']));
  // Top Events ignores the filter.
  expect(await topEvents(page)).toEqual([
    ['purchase', '5'],
    ['signup', '3'],
  ]);
  const filtered = withName.map((url) => new URL(url).pathname).sort();
  expect(filtered).toEqual([`/api/projects/${p.project.id}/events`, volumePath].sort());

  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'All events', exact: true }).click();
  await expect(log.locator('tbody tr')).toHaveCount(8);
  expect((await logEventNames(page)).sort()).toEqual([...Array(5).fill('purchase'), ...Array(3).fill('signup')].sort());
  expect(withName).toHaveLength(2);
});

test('ANLY-106 event explorer range buttons', async ({ page }) => {
  const p = await sdkProject('anly106');
  for (const [name, days] of [['two_days', 2], ['twenty_days', 20], ['sixty_days', 60]] as const) {
    expect((await trackEvent(p, { eventName: name, distinctId: 'u-106', timestamp: daysAgo(days).toISOString() })).status).toBe(201);
  }
  const base = `/api/projects/${p.project.id}/events`;
  const volume = recordRequests(page, `${base}/volume`);
  const lists = recordRequests(page, base);
  await openEvents(page, p);
  const log = cardTitled(page, 'Event Log');

  await expect(log.locator('tbody tr')).toHaveCount(2);
  expect(await logEventNames(page)).toEqual(['two_days', 'twenty_days']);
  expect(queryOf(volume[volume.length - 1]).granularity).toBe('day');
  await expect.poll(() => topEvents(page)).toEqual(expect.arrayContaining([['two_days', '1'], ['twenty_days', '1']]));
  expect(await topEvents(page)).toHaveLength(2);

  const weekVolume = page.waitForRequest((request) => new URL(request.url()).pathname === `${base}/volume` && queryOf(request.url()).granularity === 'day' && request.url() !== volume[0]);
  await page.getByRole('button', { name: '7d', exact: true }).click();
  await weekVolume;
  await expect(log.locator('tbody tr')).toHaveCount(1);
  expect(await logEventNames(page)).toEqual(['two_days']);
  await expect.poll(() => topEvents(page)).toEqual([['two_days', '1']]);

  const quarterVolume = page.waitForRequest((request) => new URL(request.url()).pathname === `${base}/volume` && queryOf(request.url()).granularity === 'week');
  await page.getByRole('button', { name: '90d', exact: true }).click();
  await quarterVolume;
  await expect(log.locator('tbody tr')).toHaveCount(3);
  expect(await logEventNames(page)).toEqual(['two_days', 'twenty_days', 'sixty_days']);
  await expect.poll(async () => (await topEvents(page)).length).toBe(3);
  // Every list request starts at the first page.
  expect(lists.length).toBeGreaterThanOrEqual(3);
  for (const url of lists) expect(queryOf(url).offset).toBe('0');
});

test('ANLY-112 an event named with an empty string', async ({ page }) => {
  test.fail(true, 'ANLY-112');
  test.info().annotations.push({ type: 'issue', description: 'ANLY-112' });
  const p = await sdkProject('anly112');
  // Accepted today (ANLY-125). Not asserted, so only the page can make this test fail:
  // were the API to refuse the name, the page would have one event and this would pass.
  const tracked = await trackEvent(p, { eventName: '', distinctId: 'u-112' });
  const stored = tracked.status === 201 ? 2 : 1;
  expect((await trackEvent(p, { eventName: 'named', distinctId: 'u-112' })).status).toBe(201);
  expect(await countEvents(p.project.id)).toBe(stored);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/events`);
  await expect(cardTitled(page, 'Event Log').locator('tbody tr')).toHaveCount(stored, { timeout: 5_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();
  const options = await eventSelectOptions(page);
  expect(options).toContain('named (1)');
  await expect(page.getByText('Unexpected Application Error!')).toHaveCount(0);
});

test('ANLY-116 events list parameters', async () => {
  const p = await sdkProject('anly116');
  const now = Date.now();
  // Newest first: index i is i minutes before now; every fifth is a signup.
  const seeds = Array.from({ length: 250 }, (_, i) => ({
    eventName: i % 5 === 0 ? 'signup' : 'other',
    distinctId: `u-${i}`,
    timestamp: wholeSecond(new Date(now - (i + 1) * 60_000)),
  }));
  const ids = await insertEvents(p.project.id, seeds);
  const list = async (query: string) => {
    const answer = await getAs(p.owner, `/api/projects/${p.project.id}/events${query}`);
    expect(answer.status, query).toBe(200);
    return answer.body.data as { data: Array<{ id: string; eventName: string; timestamp: string }>; total: number };
  };

  const plain = await list('');
  expect([plain.data.length, plain.total]).toEqual([50, 250]);
  expect(plain.data.map((e) => e.id)).toEqual(ids.slice(0, 50));
  const capped = await list('?limit=1000');
  expect([capped.data.length, capped.total]).toEqual([200, 250]);
  for (const bad of ['0', '-1', 'abc']) {
    const answer = await list(`?limit=${bad}`);
    expect([answer.data.length, answer.total], bad).toEqual([50, 250]);
  }
  const second = await list('?limit=10&offset=10');
  expect(second.data.map((e) => e.id)).toEqual(ids.slice(10, 20));
  expect(second.total).toBe(250);
  const signups = await list('?eventName=signup');
  expect(signups.total).toBe(50);
  expect(new Set(signups.data.map((e) => e.eventName))).toEqual(new Set(['signup']));
  // Inclusive at both ends: events 10 to 20 (newest first).
  const start = seeds[20].timestamp.toISOString();
  const end = seeds[10].timestamp.toISOString();
  const window = await list(`?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  expect(window.total).toBe(11);
  expect(window.data.map((e) => e.id)).toEqual(ids.slice(10, 21));
});

// ---------------------------------------------------------------------------
// SDK event ingest
// ---------------------------------------------------------------------------

test('ANLY-124 a known device fills in identity', async () => {
  const p = await sdkProject('anly124');
  const fp = uniqueId('fp-k');
  const device = await identify(p, { deviceFingerprint: fp, distinctId: 'known-1' });
  const longAgo = daysAgo(1);
  await sql('UPDATE device_identities SET last_seen_at = $2, last_event_at = $2 WHERE id = $1', [device.id, longAgo]);

  const tracked = await trackEvent(p, { eventName: 'opened', deviceFingerprint: fp });
  expect(tracked.status).toBe(201);
  expect(tracked.body.data).toMatchObject({ deviceIdentityId: device.id, distinctId: 'known-1', eventName: 'opened' });
  const [stored] = await sql('SELECT device_identity_id, distinct_id FROM user_events WHERE id = $1', [tracked.body.data.id]);
  expect(stored).toEqual({ device_identity_id: device.id, distinct_id: 'known-1' });
  await expect
    .poll(async () => {
      const row = await deviceByFingerprint(p.project.id, fp);
      return [row?.last_seen_at > longAgo, row?.last_event_at > longAgo];
    })
    .toEqual([true, true]);

  // An unknown fingerprint fills in nothing.
  const unknown = await trackEvent(p, { eventName: 'opened', deviceFingerprint: uniqueId('fp-unknown') });
  expect(unknown.body.data).toMatchObject({ deviceIdentityId: null, distinctId: null });
});

test('ANLY-125 ingest validation errors', async () => {
  const p = await sdkProject('anly125');
  const valid = { projectId: p.project.id, eventName: 'valid_event', distinctId: 'u-125' };
  const post = (body: Record<string, unknown>) => raw('POST', '/api/events/track', body, { apiKey: p.sdkKey, ip: p.owner.ip });
  const without = (key: string) => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));
  const long = 'x'.repeat(256);
  const refusals: Array<[string, Record<string, unknown>, string[]]> = [
    ['no eventName', without('eventName'), ['eventName must be a string', 'eventName must be shorter than or equal to 255 characters']],
    ['eventName 256', { ...valid, eventName: long }, ['eventName must be shorter than or equal to 255 characters']],
    ['projectId abc', { ...valid, projectId: 'abc' }, ['projectId must be a UUID']],
    ['no projectId', without('projectId'), ['projectId must be a UUID']],
    ['distinctId 256', { ...valid, distinctId: long }, ['distinctId must be shorter than or equal to 255 characters']],
    ['deviceFingerprint 256', { ...valid, deviceFingerprint: long }, ['deviceFingerprint must be shorter than or equal to 255 characters']],
    ['properties string', { ...valid, properties: 'x' }, ['properties must be an object']],
    ['properties array', { ...valid, properties: [1, 2] }, ['properties must be an object']],
    ['timestamp yesterday', { ...valid, timestamp: 'yesterday' }, ['timestamp must be a valid ISO 8601 date string']],
    ['extra platform', { ...valid, platform: 'ios' }, ['property platform should not exist']],
  ];
  for (const [label, body, messages] of refusals) {
    const answer = await post(body);
    expect(answer.status, label).toBe(400);
    expect(answer.body.error, label).toBe('Bad Request');
    expect(answer.body.message, label).toEqual(expect.arrayContaining(messages));
  }
  expect(await countEvents(p.project.id)).toBe(0);

  const numeric = await post({ ...valid, eventName: 123 });
  expect(numeric.status).toBe(201);
  expect(numeric.body.data.eventName).toBe('123');
  const empty = await post({ ...valid, eventName: '' });
  expect(empty.status).toBe(201);
  expect(empty.body.data.eventName).toBe('');
  const exact = await post({ ...valid, eventName: 'y'.repeat(255) });
  expect(exact.status).toBe(201);
  const stored = await sql<{ event_name: string }>('SELECT event_name FROM user_events WHERE project_id = $1', [p.project.id]);
  expect(stored.map((row) => row.event_name).sort()).toEqual(['', '123', 'y'.repeat(255)].sort());
});

test('ANLY-131 events keep flowing for a suspended account', async ({ page }) => {
  const p = await sdkProject('anly131');
  await openEvents(page, p);
  await expect(cardTitled(page, 'Event Log').getByText('No events found.', { exact: true })).toBeVisible();
  const reactivate = await suspendAccount(p.owner.userId);
  try {
    const tracked = await trackEvent(p, { eventName: 'while_suspended', distinctId: 'u-131' });
    expect(tracked.status).toBe(201);
    expect(typeof tracked.body.data.id).toBe('string');
    const [row] = await sql('SELECT event_name FROM user_events WHERE id = $1 AND project_id = $2', [tracked.body.data.id, p.project.id]);
    expect(row).toEqual({ event_name: 'while_suspended' });

    const refused = await getAs(p.owner, `/api/projects/${p.project.id}/events`);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe('Account suspended');
    // The signed-in dashboard is sent to the suspended notice instead of showing it.
    await page.reload();
    await expect(page).toHaveURL(/\/login\?suspended=1$/);
  } finally {
    await reactivate();
  }
  const listed = await getAs(p.owner, `/api/projects/${p.project.id}/events`);
  expect(listed.status).toBe(200);
  expect(listed.body.data.data.map((e: { eventName: string }) => e.eventName)).toEqual(['while_suspended']);
});

test('ANLY-134 a dashboard token is not an SDK key, and an SDK key is not a dashboard token', async () => {
  const set = await roleSet('anly134');
  const sdkKey = await createApiKey(set.owner, set.project.id, set.owner.ip);
  const p: SdkProject = { owner: set.owner, project: set.project, sdkKey };

  const keyOnly = await raw('GET', `/api/projects/${set.project.id}/events`, undefined, { apiKey: sdkKey, ip: set.owner.ip });
  expect(keyOnly.status).toBe(401);
  expect(keyOnly.body.message).toBe('Unauthorized');

  const crossed = await getAs(set.member, `/api/projects/${set.project.id}/events?projectId=${set.foreign.id}`);
  expect(crossed.status).toBe(404);
  expect(crossed.body.message).toBe(PROJECT_NOT_FOUND);
  // Control: the member reads the project's events without the second id.
  expect((await getAs(set.member, `/api/projects/${set.project.id}/events`)).status).toBe(200);

  const tokenOnly = await raw('POST', '/api/events/track', { projectId: set.project.id, eventName: 'by_token' }, { token: set.owner.accessToken, ip: set.owner.ip });
  expect(tokenOnly.status).toBe(401);
  expect(tokenOnly.body.message).toBe('API key is required');
  expect(await countEvents(set.project.id)).toBe(0);
  expect((await trackEvent(p, { eventName: 'by_key' })).status).toBe(201);
});

// ---------------------------------------------------------------------------
// View-as
// ---------------------------------------------------------------------------

test('ANLY-135 view-as reads all four pages', async ({ page, browser, baseURL }) => {
  test.slow(); // The super admin grant runs the CLI.
  const p = await sdkProject('anly135');
  const link = await seedLink(p.owner, p.project.id, 'anly135');
  expect(await click(link.shortCode, newClientIp())).toBe(302);
  await waitForLinkClicks(link.id, 1);
  await waitForTouchpoints(p.project.id, 1);
  await seedTouchpoints(p.project.id, [{ distinctId: 'va-user', channel: 'google', campaign: 'viewas', touchedAt: daysAgo(1) }]);
  await waitForAttribution(p, await postConversion(p, link.shortCode, 'va-user'));
  const props = { plan: 'pro' };
  expect((await trackEvent(p, { eventName: 'viewed_plan', distinctId: 'va-user', properties: props })).status).toBe(201);

  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);
  const refusals: number[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) refusals.push(response.status());
  });

  await page.goto(`/projects/${p.project.id}/analytics`);
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  await expect(statValue(page, 'Total Clicks')).toHaveText('1');

  await page.goto(`/projects/${p.project.id}/attribution`);
  await expect.poll(() => bodyRows(cardTitled(page, 'Channel Attribution'))).toEqual([['google', '100.0%', '1']]);

  await page.goto(`/projects/${p.project.id}/touchpoints`);
  await expect.poll(() => distributionRows(page)).toEqual(expect.arrayContaining([['google', '1', '50.0%']]));
  await searchJourney(page, 'va-user');
  await expect(journeyEntries(page)).toHaveCount(1);
  await expect(journeyEntries(page).getByText('Campaign: viewas', { exact: true })).toBeVisible();

  await page.goto(`/projects/${p.project.id}/events`);
  const log = cardTitled(page, 'Event Log');
  await log.getByText('viewed_plan', { exact: true }).click();
  await expect(log.locator('pre')).toHaveText(JSON.stringify(props, null, 2));

  await expect(page.getByRole('region', { name: 'Impersonation session' })).toBeVisible();
  await expect(page.getByText('Read-only session', { exact: true })).toHaveCount(0);
  expect(refusals).toEqual([]);
});

// ---------------------------------------------------------------------------
// Additions: Analytics, Attribution and Touchpoints
// ---------------------------------------------------------------------------

test('ANLY-142 a long Referer loses the click and the touchpoint', async () => {
  // Current behaviour as the case states it: a referrer over the column's 2048 characters is not stored.
  const p = await sdkProject('anly142');
  const link = await seedLink(p.owner, p.project.id, 'anly142');
  const target = 'https://example.com/anly142';
  const summary = async () => (await getAs(p.owner, `/api/projects/${p.project.id}/analytics/summary`)).body.data.totalClicks as number;
  const referrers = async () => (await getAs(p.owner, `/api/projects/${p.project.id}/analytics/referrers`)).body.data as Array<{ referrer: string; count: number }>;
  expect(await summary()).toBe(0);
  expect(await channelCounts(p.owner, p.project.id)).toEqual([]);
  const referer = (length: number) => `https://example.com/?q=${'a'.repeat(length - 'https://example.com/?q='.length)}`;
  // Failures caused by this column's length, so another test's long utm_source does not count here.
  const tooLong = 'value too long for type character varying(2048)';
  const clickFailures = () => apiLogFailures('Failed to record click event', tooLong);
  const touchpointFailures = () => apiLogFailures('Failed to record touchpoint', tooLong);
  const clicksBefore = clickFailures();
  const touchpointsBefore = touchpointFailures();

  const fits = await clickResponse(link.shortCode, newClientIp(), { referer: referer(2048) });
  expect(fits).toEqual({ status: 302, location: target });
  await waitForLinkClicks(link.id, 1);
  await waitForTouchpoints(p.project.id, 1);
  expect(await summary()).toBe(1);
  expect(await referrers()).toEqual([{ referrer: referer(2048), count: 1 }]);
  expect(await channelCounts(p.owner, p.project.id)).toEqual([['referral', 1]]);

  for (const length of [2049, 3000]) {
    expect(await clickResponse(link.shortCode, newClientIp(), { referer: referer(length) }), String(length)).toEqual({ status: 302, location: target });
  }
  // Both inserts of both clicks have ended once their failures are logged, so the counts below are final.
  await expect.poll(() => clickFailures() - clicksBefore, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => touchpointFailures() - touchpointsBefore, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  // The case's "no click webhook fires" needs a public receiver, which the local stack has not.
  expect(await summary()).toBe(1);
  expect(await referrers()).toHaveLength(1);
  expect(await channelCounts(p.owner, p.project.id)).toEqual([['referral', 1]]);
});

test('ANLY-145 link titles are shown as text in Top Performing Links', async ({ page }) => {
  const p = await sdkProject('anly145');
  const title = '<img src=x onerror=alert(5)>';
  const shortA = `anly145a-${randomBytes(3).toString('hex')}`;
  const shortB = `anly145b-${randomBytes(3).toString('hex')}`;
  const auth = { token: p.owner.accessToken, ip: p.owner.ip };
  const a = await api<{ id: string; shortCode: string; title: string }>('POST', `/api/projects/${p.project.id}/links`, { longUrl: 'https://example.com/a', title, shortCode: shortA }, auth);
  const b = await api<{ id: string; shortCode: string }>('POST', `/api/projects/${p.project.id}/links`, { longUrl: 'https://example.com/b', shortCode: shortB }, auth);
  expect(a.title).toBe(title);
  for (const link of [a, b]) {
    expect(await click(link.shortCode, newClientIp())).toBe(302);
    await waitForLinkClicks(link.id, 1);
  }

  const dialogs = collectDialogs(page);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/analytics`);
  const card = cardTitled(page, 'Top Performing Links');
  await expect(card.locator('tbody tr')).toHaveCount(2);
  const linkA = card.getByRole('link', { name: title, exact: true });
  await expect(linkA).toHaveAttribute('href', `/projects/${p.project.id}/links/${a.id}`);
  await expect(card.locator('tbody tr').filter({ has: page.getByRole('link', { name: title, exact: true }) }).locator('p.font-mono')).toHaveText(a.shortCode);
  await expect(card.getByRole('link', { name: b.shortCode, exact: true })).toHaveAttribute('href', `/projects/${p.project.id}/links/${b.id}`);
  await expect(card.locator('img')).toHaveCount(0);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('ANLY-146 one channel on several touchpoints of the same conversion', async ({ page }) => {
  const p = await sdkProject('anly146');
  const link = await seedLink(p.owner, p.project.id, 'anly146');
  const now = new Date();
  const times = [daysAgo(10, now), daysAgo(5, now), daysAgo(1, now)];
  await seedTouchpoints(p.project.id, [
    { distinctId: 'u-multi', channel: 'google', campaign: 'spring', touchedAt: times[0] },
    { distinctId: 'u-multi', channel: 'email', campaign: null, touchedAt: times[1] },
    { distinctId: 'u-multi', channel: 'google', campaign: 'spring', touchedAt: times[2] },
  ]);
  await waitForAttribution(p, await postConversion(p, link.shortCode, 'u-multi'));
  const decay = timeDecayCredits(times);
  expect(decay).toEqual([0.1969, 0.323, 0.48]);
  const googleDecay = creditLabel(decay[0] + decay[2]);
  const emailDecay = creditLabel(decay[1]);
  expect([googleDecay, emailDecay]).toEqual(['68.0%', '32.0%']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const channels = cardTitled(page, 'Channel Attribution');
  const campaigns = cardTitled(page, 'Campaign Attribution');
  // Last Touch is the default.
  await expect.poll(() => bodyRows(channels)).toEqual([
    ['google', '100.0%', '1'],
    ['email', '0.0%', '1'],
  ]);
  await expect.poll(() => bodyRows(cardTitled(page, 'Model Comparison'))).toEqual([
    ['google', '100.0%', '100.0%', '67.0%', googleDecay],
    ['email', '0.0%', '0.0%', '33.0%', emailDecay],
  ]);

  for (const [model, rows, campaignRows] of [
    ['First Touch', [['google', '100.0%', '1'], ['email', '0.0%', '1']], [['spring', 'google', '100.0%', '1'], ['none', 'email', '0.0%', '1']]],
    ['Linear', [['google', '67.0%', '1'], ['email', '33.0%', '1']], [['spring', 'google', '67.0%', '1'], ['none', 'email', '33.0%', '1']]],
    ['Time Decay', [['google', googleDecay, '1'], ['email', emailDecay, '1']], [['spring', 'google', googleDecay, '1'], ['none', 'email', emailDecay, '1']]],
  ] as const) {
    await chooseAttributionModel(page, model);
    await expect(channels.getByText(`using ${model} model`)).toBeVisible();
    await expect.poll(() => bodyRows(channels), model).toEqual(rows);
    await expect.poll(() => bodyRows(campaigns), model).toEqual(campaignRows);
  }
});

test('ANLY-156 touchpoint fields are shown as text in the journey', async ({ page }) => {
  const p = await sdkProject('anly156');
  const fields = {
    touchpointType: '<b>t</b>_click',
    channel: '<u>c</u>',
    platform: '<i>p</i>',
    utmSource: '<img src=x onerror=alert(3)>',
    utmMedium: '<svg onload=alert(4)>',
    campaign: '<a href=//x>k</a>',
  };
  await seedTouchpoints(p.project.id, [{ distinctId: 'user-xss', ...fields, touchedAt: daysAgo(1) }]);
  const dialogs = collectDialogs(page);
  await openTouchpoints(page, p);
  await searchJourney(page, 'user-xss');
  const entry = journeyEntries(page);
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('[data-slot="badge"]')).toHaveText([fields.touchpointType, fields.channel]);
  for (const text of [fields.platform, `Campaign: ${fields.campaign}`, `utm_source: ${fields.utmSource}`, `utm_medium: ${fields.utmMedium}`]) {
    await expect(entry.getByText(text, { exact: true }), text).toBeVisible();
  }
  for (const tag of ['b', 'i', 'u', 'a', 'img']) await expect(entry.locator(tag), tag).toHaveCount(0);
  // The only svgs are the timeline icon and the clock.
  await expect(entry.locator('svg')).toHaveCount(2);
  await expect(entry.locator('svg.lucide-mouse-pointer-click')).toHaveCount(1);
  expect(await scriptsContaining(page, 'alert(3)')).toBe(0);
  expect(dialogs).toEqual([]);
});

test('ANLY-158 an event user id with markup is shown as text', async ({ page }) => {
  const p = await sdkProject('anly158');
  const now = Date.now();
  for (const [distinctId, ago] of [['<img src=x onerror=alert(1)>', 2], ['"><svg onload=alert(2)>', 1]] as const) {
    expect((await trackEvent(p, { eventName: 'markup_user', distinctId, timestamp: new Date(now - ago * 60_000).toISOString() })).status).toBe(201);
  }
  const dialogs = collectDialogs(page);
  await openEvents(page, p);
  const log = cardTitled(page, 'Event Log');
  await expect(log.locator('tbody tr')).toHaveCount(2);
  expect((await bodyRows(log)).map((row) => row[2])).toEqual(['"><svg onloa', '<img src=x o']);
  await expect(log.locator('tbody img')).toHaveCount(0);
  await expect(log.locator('tbody svg')).toHaveCount(0);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// ---------------------------------------------------------------------------
// Additions: erasure on these pages
// ---------------------------------------------------------------------------

test('ANLY-162 person erasure removes their events, clicks and touchpoints', async ({ page }) => {
  const p = await sdkProject('anly162');
  const secret = await identitySecret(p);
  const fp = uniqueId('fp-erase');
  const device = await identify(p, { deviceFingerprint: fp, distinctId: 'anon-erase', externalUserId: 'u-erase', userHash: userHash(secret, 'u-erase') });
  const other = uniqueId('fp-other');
  await identify(p, { deviceFingerprint: other, distinctId: 'someone-else' });
  for (let i = 0; i < 3; i += 1) expect((await trackEvent(p, { eventName: 'erase_me', deviceFingerprint: fp })).status).toBe(201);
  expect((await trackEvent(p, { eventName: 'orphan_ext', distinctId: 'u-erase' })).status).toBe(201);
  expect((await trackEvent(p, { eventName: 'orphan_anon', distinctId: 'anon-erase' })).status).toBe(201);
  expect((await trackEvent(p, { eventName: 'keep_me', deviceFingerprint: other })).status).toBe(201);
  const link = await seedLink(p.owner, p.project.id, 'anly162');
  expect(await click(link.shortCode, newClientIp(), { cookie: `chumbaq_did=${fp}`, query: '?utm_source=erasetest' })).toBe(302);
  expect(await click(link.shortCode, newClientIp(), { query: '?utm_source=keeptest' })).toBe(302);
  await waitForLinkClicks(link.id, 2);
  await waitForTouchpoints(p.project.id, 2);
  await expect.poll(async () => (await sql('SELECT device_identity_id FROM click_events WHERE link_id = $1 AND device_identity_id IS NOT NULL', [link.id])).length).toBe(1);
  await seedTouchpoints(p.project.id, [{ distinctId: 'u-erase', channel: 'orphantp', touchedAt: daysAgo(1) }]);

  // Before: everything is there.
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/events`);
  await expect(cardTitled(page, 'Event Log').locator('tbody tr')).toHaveCount(6);
  await page.goto(`/projects/${p.project.id}/analytics`);
  await expect(statValue(page, 'Total Clicks')).toHaveText('2');
  await page.goto(`/projects/${p.project.id}/touchpoints`);
  await expect(cardTitled(page, 'Channel Distribution').locator('tbody tr')).toHaveCount(3);

  const erasePath = `/api/projects/${p.project.id}/users/${device.id}`;
  const erased = await raw('DELETE', erasePath, undefined, { token: p.owner.accessToken, ip: p.owner.ip });
  expect(erased.status).toBe(200);
  expect(erased.body.data.result).toBe('erased');
  expect(erased.body.data.counts).toMatchObject({ user_events: 4, click_events: 1, touchpoints: 2 });

  await page.goto(`/projects/${p.project.id}/events`);
  const log = cardTitled(page, 'Event Log');
  await expect(log.locator('tbody tr')).toHaveCount(2);
  expect((await logEventNames(page)).sort()).toEqual(['keep_me', 'orphan_anon']);
  expect((await eventSelectOptions(page)).sort()).toEqual(['All events', 'keep_me (1)', 'orphan_anon (1)']);

  await page.goto(`/projects/${p.project.id}/analytics`);
  await expect(statValue(page, 'Total Clicks')).toHaveText('1');

  await page.goto(`/projects/${p.project.id}/touchpoints`);
  await expect.poll(() => distributionRows(page)).toEqual([['keeptest', '1', '100.0%']]);
  await searchJourney(page, 'u-erase');
  await expect(journeyCard(page).getByText('No touchpoints found for this user', { exact: true })).toBeVisible();

  const again = await raw('DELETE', erasePath, undefined, { token: p.owner.accessToken, ip: p.owner.ip });
  expect(again.status).toBe(200);
  expect(again.body.data.result).toBe('nothing_to_erase');
});

test('ANLY-163 person erasure removes and rewrites attribution', async ({ page }) => {
  const p = await sdkProject('anly163');
  const secret = await identitySecret(p);
  const f2 = uniqueId('fp-a');
  const f3 = uniqueId('fp-b');
  const deviceA = await identify(p, { deviceFingerprint: f2, externalUserId: 'u-erase2', userHash: userHash(secret, 'u-erase2') });
  const link = await seedLink(p.owner, p.project.id, 'anly163');
  await seedTouchpoints(p.project.id, [
    { distinctId: 'u-erase2', deviceFingerprint: f2, channel: 'google', touchedAt: daysAgo(3) },
    { distinctId: 'u-keep', deviceFingerprint: f2, channel: 'facebook', touchedAt: daysAgo(2) },
    { distinctId: 'u-keep', deviceFingerprint: f3, channel: 'email', touchedAt: daysAgo(1) },
  ]);
  const conversionA = await postConversion(p, link.shortCode, 'u-erase2');
  await waitForAttribution(p, conversionA);
  const conversionB = await postConversion(p, link.shortCode, 'u-keep');
  const beforeB = await waitForAttribution(p, conversionB);
  const linearOf = (rows: typeof beforeB) => rows.find((r) => r.model === 'linear')!;
  expect(linearOf(beforeB).creditSplits.map((s) => [s.channel, s.credit])).toEqual([['facebook', 0.5], ['email', 0.5]]);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  await chooseAttributionModel(page, 'Linear');
  const channels = cardTitled(page, 'Channel Attribution');
  await expect.poll(() => bodyRows(channels)).toEqual([
    ['google', '100.0%', '1'],
    ['facebook', '50.0%', '1'],
    ['email', '50.0%', '1'],
  ]);

  const erased = await raw('DELETE', `/api/projects/${p.project.id}/users/${deviceA.id}`, undefined, { token: p.owner.accessToken, ip: p.owner.ip });
  expect(erased.status).toBe(200);
  expect(erased.body.data.result).toBe('erased');

  const afterA = await getAs(p.owner, `/api/projects/${p.project.id}/conversions/${conversionA}/attribution`);
  expect(afterA.body.data).toEqual([]);
  const afterB = (await getAs(p.owner, `/api/projects/${p.project.id}/conversions/${conversionB}/attribution`)).body.data as typeof beforeB;
  expect(afterB).toHaveLength(4);
  for (const result of afterB) {
    expect(result.creditSplits.map((s) => s.channel), result.model).toEqual(['email']);
    expect(result.touchpointCount, result.model).toBe(2);
  }

  await page.reload();
  await chooseAttributionModel(page, 'Linear');
  await expect.poll(() => bodyRows(channels)).toEqual([['email', '50.0%', '1']]);
  await expect.poll(() => bodyRows(cardTitled(page, 'Campaign Attribution'))).toEqual([['none', 'email', '50.0%', '1']]);
  await expect.poll(async () => (await bodyRows(cardTitled(page, 'Model Comparison'))).map((row) => row[0])).toEqual(['email']);
});

// ---------------------------------------------------------------------------
// Additions: trap keys on ingest
// ---------------------------------------------------------------------------

test('ANLY-171 a trap API key on ingest answers like any wrong key', async () => {
  const p = await sdkProject('anly171');
  const trap = await seedTrapKey(`anly171-${randomUUID().slice(0, 8)}`);
  const ip = newClientIp();
  const body = { projectId: p.project.id, eventName: 'trap_probe', distinctId: 'u-171' };
  const answers: Record<'trap' | 'madeUp', Array<{ status: number; body: Record<string, unknown>; ms: number }>> = { trap: [], madeUp: [] };
  for (let i = 0; i < 20; i += 1) {
    for (const kind of ['trap', 'madeUp'] as const) {
      const key = kind === 'trap' ? trap.key : `chumbaq_${randomBytes(32).toString('hex')}`;
      const started = performance.now();
      const answer = await raw('POST', '/api/events/track', body, { apiKey: key, ip });
      answers[kind].push({ status: answer.status, body: answer.body, ms: performance.now() - started });
    }
  }
  const shape = (b: Record<string, unknown>) => ({ ...b, timestamp: undefined });
  const expected = shape(answers.madeUp[0].body);
  expect(expected).toMatchObject({ statusCode: 401, message: 'Invalid or expired API key' });
  for (const kind of ['trap', 'madeUp'] as const) {
    for (const answer of answers[kind]) {
      expect(answer.status, kind).toBe(401);
      expect(shape(answer.body), kind).toEqual(expected);
    }
  }
  expect(await countEvents(p.project.id)).toBe(0);

  // Timing is reported, not asserted: the trap lookup runs after the refusal is sent.
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  test.info().annotations.push({
    type: 'timing',
    description: `median ms: trap ${median(answers.trap.map((a) => a.ms)).toFixed(1)}, made-up ${median(answers.madeUp.map((a) => a.ms)).toFixed(1)}`,
  });

  // One alarm row for the trap, counting all 20 uses; the 20 made-up keys from the same
  // address raise none.
  await expect
    .poll(async () => sql('SELECT kind, dedupe_key, details->>\'route\' AS route, count FROM security_alerts WHERE ip_address = $1', [ip]))
    .toEqual([{ kind: 'tripwire.api_key', dedupe_key: trap.id, route: 'POST /api/events/track', count: 20 }]);
  // Control: the project's own key is accepted on the same route.
  expect((await trackEvent(p, { eventName: 'real' })).status).toBe(201);
});

import { randomUUID } from 'crypto';
import { api, createAccount, createApiKey, createProject } from '../../support/api';
import { expect, signIn, test } from '../../support/fixtures';
import {
  PROJECT_NOT_FOUND,
  addMember,
  bodyRows,
  cardTitled,
  click,
  collectDialogs,
  countEvents,
  daysAgo,
  deviceByFingerprint,
  eventTimeLabel,
  getAs,
  identify,
  identitySecret,
  newPerson,
  openViewAs,
  postConversion,
  raw,
  responseFor,
  roleSet,
  scriptsContaining,
  sdkProject,
  seedLink,
  seedTouchpoints,
  sql,
  statValue,
  trackEvent,
  uniqueId,
  userHash,
  viewAsHandoff,
  waitForAttribution,
  waitForLinkClicks,
  type Person,
  type RoleSet,
} from '../../support/areas/anly';

/**
 * Project analytics, attribution, touchpoints and the event explorer: what each page
 * shows from real clicks, seeded touchpoints and SDK events, that markup in tenant or
 * SDK data is shown as text, the role matrix and tenant isolation of every read route,
 * SDK event ingest, and do-not-track around it.
 */

const SERVER_ONLY_KEY =
  'This is a server-only privacy key and cannot be used by an app or SDK. Use an ordinary API key in your app.';

/** Calls `path` as every role and as nobody, and checks the access rules every read route here shares. */
async function checkRoleMatrix(set: RoleSet, path: string): Promise<void> {
  for (const role of ['owner', 'admin', 'member'] as const) {
    const answer = await getAs(set[role], path);
    expect(answer.status, `${role} ${path}`).toBe(200);
  }
  const outsider = await getAs(set.outsider, path);
  expect(outsider.status, `outsider ${path}`).toBe(404);
  expect(outsider.body.message).toBe(PROJECT_NOT_FOUND);
  const anonymous = await getAs(null, path);
  expect(anonymous.status, `anonymous ${path}`).toBe(401);
  expect(anonymous.body.message).toBe('Unauthorized');
}

/** The member names another tenant's project, or a malformed one, in the query. */
async function checkSecondProjectId(set: RoleSet, path: string): Promise<void> {
  const join = path.includes('?') ? '&' : '?';
  const own = await getAs(set.member, `${path}${join}projectId=${set.project.id}`);
  expect(own.status, `own project id on ${path}`).toBe(200);
  for (const projectId of [set.foreign.id, 'abc']) {
    const answer = await getAs(set.member, `${path}${join}projectId=${projectId}`);
    expect(answer.status, `projectId=${projectId} on ${path}`).toBe(404);
    expect(answer.body.message).toBe(PROJECT_NOT_FOUND);
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test('ANLY-005 project the user cannot see sends them back to the selector', async ({ page, clientIp }) => {
  const a = await newPerson('anly005-a');
  const project = await createProject(a, a.ip, `ANLY-005 ${randomUUID().slice(0, 6)}`);
  const b = await createAccount(clientIp, 'anly005-b');

  const dataRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/api/projects/${project.id}/`)) dataRequests.push(request.url());
  });

  await signIn(page, b);
  for (const section of ['analytics', 'attribution', 'touchpoints', 'events']) {
    const [answer] = await Promise.all([responseFor(page, `/api/projects/${project.id}`), page.goto(`/projects/${project.id}/${section}`)]);
    expect(answer.status(), section).toBe(404);
    expect((await answer.json()).message).toBe(PROJECT_NOT_FOUND);
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(page.getByText(project.name)).toHaveCount(0);
  }
  expect(dataRequests).toEqual([]);
});

// ---------------------------------------------------------------------------
// Analytics page
// ---------------------------------------------------------------------------

test('ANLY-012 stat cards count real clicks', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'anly012');
  const ownerPerson: Person = { ...owner, ip: clientIp };
  const project = await createProject(owner, clientIp, 'ANLY-012');
  const link = await seedLink(ownerPerson, project.id, 'anly012');
  const [first, second] = ['10.0.0.1', '10.0.0.2'];
  for (const ip of [first, first, first, second]) expect(await click(link.shortCode, ip)).toBe(302);
  await waitForLinkClicks(link.id, 4);

  const summary = await api('GET', `/api/projects/${project.id}/analytics/summary`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(summary).toEqual({
    totalClicks: 4,
    uniqueVisitors: 2,
    appOpens: 0,
    storeRedirects: 0,
    matchedInstalls: 0,
    conversionsByType: [],
    conversionRate: 0,
  });

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/analytics`);
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  await expect(statValue(page, 'Total Clicks')).toHaveText('4');
  await expect(statValue(page, 'Unique Visitors')).toHaveText('2');
  await expect(statValue(page, 'Store Redirects')).toHaveText('0');
  await expect(statValue(page, 'Installs')).toHaveText('0');
  await expect(statValue(page, 'Conversion Rate')).toHaveText('0.0%');
});

test('ANLY-036 a referrer containing markup is shown as text', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'anly036');
  const project = await createProject(owner, clientIp, 'ANLY-036');
  const link = await seedLink({ ...owner, ip: clientIp }, project.id, 'anly036');
  const referer = 'https://x.test/<img src=x onerror=alert(1)>';
  expect(await click(link.shortCode, '10.0.36.1', { referer })).toBe(302);
  await waitForLinkClicks(link.id, 1);
  const referrers = await api('GET', `/api/projects/${project.id}/analytics/referrers`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(referrers).toEqual([{ referrer: referer, count: 1 }]);

  const dialogs = collectDialogs(page);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/analytics`);
  const card = cardTitled(page, 'Top Referrers');
  await expect(card.getByRole('cell', { name: referer, exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('ANLY-040 only this project\'s clicks are counted', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'anly040');
  const ownerPerson: Person = { ...owner, ip: clientIp };
  const p1 = await createProject(owner, clientIp, 'ANLY-040 one');
  const p2 = await createProject(owner, clientIp, 'ANLY-040 two');
  const link = await seedLink(ownerPerson, p2.id, 'anly040');
  const marker = `https://p2-only-${randomUUID().slice(0, 8)}.example.test/`;
  expect(await click(link.shortCode, '10.0.40.1', { referer: marker })).toBe(302);
  expect(await click(link.shortCode, '10.0.40.2', { referer: marker })).toBe(302);
  await waitForLinkClicks(link.id, 2);

  // The control: the clicks are there, on P2.
  const p2Referrers = await api('GET', `/api/projects/${p2.id}/analytics/referrers`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(p2Referrers).toEqual([{ referrer: marker, count: 2 }]);

  const p1Bodies: string[] = [];
  page.on('response', async (response) => {
    if (response.url().includes(`/api/projects/${p1.id}/`)) p1Bodies.push(await response.text().catch(() => ''));
  });
  await signIn(page, owner);
  await page.goto(`/projects/${p1.id}/analytics`);
  await expect(statValue(page, 'Total Clicks')).toHaveText('0');
  await expect(statValue(page, 'Unique Visitors')).toHaveText('0');
  await expect(statValue(page, 'Conversion Rate')).toHaveText('0.0%');
  await expect(page.getByText('No click data for this period')).toBeVisible();
  await expect(page.getByText('No device data')).toBeVisible();
  await expect(page.getByText('No geographic data')).toBeVisible();
  await expect(page.getByText('No referrer data')).toBeVisible();
  await expect(page.getByText('No links yet')).toBeVisible();

  const as = { token: owner.accessToken, ip: clientIp };
  const base = `/api/projects/${p1.id}/analytics`;
  expect(await api('GET', `${base}/summary`, undefined, as)).toMatchObject({ totalClicks: 0, uniqueVisitors: 0 });
  expect(await api('GET', `${base}/timeseries`, undefined, as)).toEqual([]);
  expect(await api('GET', `${base}/devices`, undefined, as)).toEqual({ deviceTypes: [], operatingSystems: [], browsers: [] });
  expect(await api('GET', `${base}/geo`, undefined, as)).toEqual({ countries: [], cities: [], points: [] });
  expect(await api('GET', `${base}/referrers`, undefined, as)).toEqual([]);
  expect(p1Bodies.length).toBeGreaterThanOrEqual(5);
  for (const body of p1Bodies) {
    expect(body).not.toContain(marker);
    expect(body).not.toContain(link.shortCode);
  }
});

test('ANLY-043 timeseries granularity cannot inject SQL', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'anly043');
  const project = await createProject(owner, clientIp, 'ANLY-043');
  const link = await seedLink({ ...owner, ip: clientIp }, project.id, 'anly043');
  for (const ip of ['10.0.43.1', '10.0.43.2', '10.0.43.3']) expect(await click(link.shortCode, ip)).toBe(302);
  await waitForLinkClicks(link.id, 3);
  // Two clicks yesterday, four hours apart, and one now: two days, three hours.
  const yesterday = daysAgo(1);
  const at = (hour: number) => new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), hour, 0, 0);
  const ids = await sql<{ id: string }>('SELECT id FROM click_events WHERE link_id = $1 ORDER BY id', [link.id]);
  await sql('UPDATE click_events SET clicked_at = $2 WHERE id = $1', [ids[0].id, at(10)]);
  await sql('UPDATE click_events SET clicked_at = $2 WHERE id = $1', [ids[1].id, at(14)]);

  const base = `/api/projects/${project.id}/analytics/timeseries`;
  const as = { token: owner.accessToken, ip: clientIp };
  const daily = await raw('GET', `${base}?granularity=day`, undefined, as);
  expect(daily.status).toBe(200);
  expect(daily.body.data.map((point: { clicks: number }) => point.clicks)).toEqual([2, 1]);
  const hourly = await raw('GET', `${base}?granularity=hour`, undefined, as);
  expect(hourly.body.data).toHaveLength(3);

  for (const query of [
    `granularity=${encodeURIComponent("day', NOW()) --")}`,
    'granularity=month',
    'granularity=hour&granularity=week',
  ]) {
    const answer = await raw('GET', `${base}?${query}`, undefined, as);
    expect(answer.status, query).toBe(200);
    expect(answer.body.data, query).toEqual(daily.body.data);
  }
});

test('ANLY-046 analytics routes: role matrix and refusals', async () => {
  const set = await roleSet('anly046');
  for (const route of ['summary', 'timeseries', 'devices', 'geo', 'referrers']) {
    await checkRoleMatrix(set, `/api/projects/${set.project.id}/analytics/${route}`);
  }
  for (const id of ['not-a-uuid', set.project.id.toUpperCase()]) {
    const answer = await getAs(set.owner, `/api/projects/${id}/analytics/summary`);
    expect(answer.status, id).toBe(404);
    expect(answer.body.message).toBe(PROJECT_NOT_FOUND);
  }
});

test('ANLY-047 a second project id in the query is checked', async () => {
  const set = await roleSet('anly047');
  await checkSecondProjectId(set, `/api/projects/${set.project.id}/analytics/summary`);
});

// ---------------------------------------------------------------------------
// Attribution page
// ---------------------------------------------------------------------------

test('ANLY-053 Last Touch gives the newest touchpoint all the credit', async ({ page }) => {
  const p = await sdkProject('anly053');
  const link = await seedLink(p.owner, p.project.id, 'anly053');
  await seedTouchpoints(p.project.id, [
    { distinctId: 'u-3', channel: 'google', touchedAt: daysAgo(10) },
    { distinctId: 'u-3', channel: 'facebook', touchedAt: daysAgo(5) },
    { distinctId: 'u-3', channel: 'newsletter', touchedAt: daysAgo(1) },
  ]);
  const conversionId = await postConversion(p, link.shortCode, 'u-3');
  const results = await waitForAttribution(p, conversionId);
  expect(results.map((r) => r.model)).toEqual(['first_touch', 'last_touch', 'linear', 'time_decay']);
  for (const result of results) expect(result).toMatchObject({ touchpointCount: 3, lookbackDays: 30, distinctId: 'u-3' });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  await expect(page.getByRole('heading', { level: 1, name: 'Attribution' })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveText('Last Touch');
  const card = cardTitled(page, 'Channel Attribution');
  await expect(card.getByText('Credit distribution across channels using Last Touch model')).toBeVisible();
  await expect(card.locator('tbody tr')).toHaveCount(3);
  // Sorted by credit; the two with none keep the order the model listed them (newest first).
  expect(await bodyRows(card)).toEqual([
    ['newsletter', '100.0%', '1'],
    ['facebook', '0.0%', '1'],
    ['google', '0.0%', '1'],
  ]);
});

test('ANLY-061 other people\'s and other projects\' touchpoints are ignored', async () => {
  const p = await sdkProject('anly061');
  const q = await sdkProject('anly061-q', p.owner);
  const link = await seedLink(p.owner, p.project.id, 'anly061');
  const [google] = await seedTouchpoints(p.project.id, [
    { distinctId: 'u-10', channel: 'google', touchedAt: daysAgo(2) },
    { distinctId: 'u-11', channel: 'email', touchedAt: daysAgo(2) },
  ]);
  await seedTouchpoints(q.project.id, [{ distinctId: 'u-10', channel: 'facebook', touchedAt: daysAgo(1) }]);

  const conversionId = await postConversion(p, link.shortCode, 'u-10');
  const results = await waitForAttribution(p, conversionId);
  expect(results).toHaveLength(4);
  for (const result of results) {
    expect(result.touchpointCount, result.model).toBe(1);
    expect(result.creditSplits.map((s) => [s.touchpointId, s.channel, s.credit]), result.model).toEqual([[google, 'google', 1]]);
  }
  const channels = await api('GET', `/api/projects/${p.project.id}/attribution/channels?model=linear`, undefined, {
    token: p.owner.accessToken,
    ip: p.owner.ip,
  });
  expect(channels).toEqual([{ channel: 'google', credit: 1, conversions: 1 }]);
});

test('ANLY-067 channel and campaign names are shown as text', async ({ page }) => {
  const p = await sdkProject('anly067');
  const link = await seedLink(p.owner, p.project.id, 'anly067');
  const channel = '<script>alert(1)</script>';
  const campaign = '<img src=x onerror=alert(2)>';
  await seedTouchpoints(p.project.id, [{ distinctId: 'u-xss', channel, campaign, touchedAt: daysAgo(1) }]);
  await waitForAttribution(p, await postConversion(p, link.shortCode, 'u-xss'));

  const dialogs = collectDialogs(page);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/attribution`);
  const channels = cardTitled(page, 'Channel Attribution');
  await expect(channels.getByText(channel, { exact: true })).toBeVisible();
  const campaigns = cardTitled(page, 'Campaign Attribution');
  await expect(campaigns.getByRole('cell', { name: campaign, exact: true })).toBeVisible();
  await expect(campaigns.getByText(channel, { exact: true })).toBeVisible();
  await expect(cardTitled(page, 'Model Comparison').getByText(channel, { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await scriptsContaining(page, 'alert(1)')).toBe(0);

  await page.goto(`/projects/${p.project.id}/touchpoints`);
  await expect(cardTitled(page, 'Channel Distribution').getByText(channel, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Enter distinct ID...').fill('u-xss');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const journey = cardTitled(page, 'User Journey');
  await expect(journey.getByText(`Campaign: ${campaign}`, { exact: true })).toBeVisible();
  await expect(journey.getByText(channel, { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await scriptsContaining(page, 'alert(1)')).toBe(0);
  expect(dialogs).toEqual([]);
});

test('ANLY-071 attribution routes: role matrix and refusals', async () => {
  const set = await roleSet('anly071');
  const base = `/api/projects/${set.project.id}`;
  // A real conversion with attribution, so a 200 carries its rows rather than an empty list.
  const p = { owner: set.owner, project: set.project, sdkKey: await createApiKey(set.owner, set.project.id, set.owner.ip) };
  const link = await seedLink(set.owner, set.project.id, 'anly071');
  await seedTouchpoints(set.project.id, [{ distinctId: 'u-71', channel: 'google', touchedAt: daysAgo(1) }]);
  const conversionId = await postConversion(p, link.shortCode, 'u-71');
  await waitForAttribution(p, conversionId);
  const conversion = `${base}/conversions/${conversionId}/attribution`;
  for (const path of [`${base}/attribution/channels`, `${base}/attribution/campaigns`, `${base}/attribution/compare`, conversion]) {
    await checkRoleMatrix(set, path);
  }
  for (const role of ['admin', 'member'] as const) {
    expect((await getAs(set[role], conversion)).body.data, role).toHaveLength(4);
    expect((await getAs(set[role], `${base}/attribution/channels`)).body.data, role).toEqual([{ channel: 'google', credit: 1, conversions: 1 }]);
  }
  for (const path of [`${base}/attribution/channels`, `${base}/attribution/campaigns`, `${base}/attribution/compare`, conversion]) {
    await checkSecondProjectId(set, path);
  }
});

// ---------------------------------------------------------------------------
// Touchpoints page
// ---------------------------------------------------------------------------

test('ANLY-082 a journey never crosses projects', async () => {
  const set = await roleSet('anly082');
  await seedTouchpoints(set.foreign.id, [{ distinctId: 'user-47', channel: 'google', touchedAt: daysAgo(1) }]);

  const inForeign = await getAs(set.outsider, `/api/projects/${set.foreign.id}/touchpoints/journey/user-47`);
  expect(inForeign.status).toBe(200);
  expect(inForeign.body.data).toHaveLength(1);

  const inP = await getAs(set.member, `/api/projects/${set.project.id}/touchpoints/journey/user-47`);
  expect(inP.status).toBe(200);
  expect(inP.body.data).toEqual([]);
});

test('ANLY-095 touchpoint routes: role matrix and refusals', async () => {
  const set = await roleSet('anly095');
  const base = `/api/projects/${set.project.id}/touchpoints`;
  for (const path of [`${base}/journey/user-1`, `${base}/channels`]) {
    await checkRoleMatrix(set, path);
    await checkSecondProjectId(set, path);
  }
});

// ---------------------------------------------------------------------------
// Event explorer
// ---------------------------------------------------------------------------

test('ANLY-098 a tracked event appears in the log', async ({ page }) => {
  const p = await sdkProject('anly098');
  const tracked = await trackEvent(p, {
    eventName: 'checkout_started',
    distinctId: 'user-abcdefghijklmnop',
    deviceFingerprint: 'fp-1',
    properties: { cart: 3 },
  });
  expect(tracked.status).toBe(201);
  const at = new Date(tracked.body.data.timestamp);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/events`);
  await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();

  const log = cardTitled(page, 'Event Log');
  await expect(log.locator('tbody tr')).toHaveCount(1);
  expect(await bodyRows(log)).toEqual([['', 'checkout_started', 'user-abcdefg', '—', eventTimeLabel(at)]]);

  const top = cardTitled(page, 'Top Events');
  await expect(top.getByText('checkout_started', { exact: true })).toBeVisible();
  await expect(top.getByText('1', { exact: true })).toBeVisible();

  const volume = page.locator('[data-slot="card"]').filter({ hasText: 'Event Volume' });
  await expect(volume.getByText('No events in this period')).toHaveCount(0);
  await expect(volume.locator('.recharts-area')).toHaveCount(1);
  const points = await api<Array<{ date: string; count: number }>>('GET', `/api/projects/${p.project.id}/events/volume`, undefined, {
    token: p.owner.accessToken,
    ip: p.owner.ip,
  });
  expect(points.map((point) => point.count)).toEqual([1]);
  // The one point is today's: its bucket starts at or before the event, less than a day
  // ago (a minute of slack for a run that crosses midnight).
  const bucket = new Date(points[0].date).getTime();
  expect(bucket).toBeLessThanOrEqual(at.getTime());
  expect(Date.now() - bucket).toBeLessThan(24 * 60 * 60 * 1000 + 60_000);

  await page.getByRole('combobox').click();
  await expect(page.getByRole('option', { name: 'checkout_started (1)', exact: true })).toBeVisible();
});

test('ANLY-110 event names and properties with markup are shown as text', async ({ page }) => {
  const p = await sdkProject('anly110');
  const name = '<img src=x onerror=alert(1)>';
  const note = '<script>alert(2)</script>';
  const tracked = await trackEvent(p, { eventName: name, distinctId: 'u-xss', properties: { note } });
  expect(tracked.status).toBe(201);

  const dialogs = collectDialogs(page);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/events`);
  const log = cardTitled(page, 'Event Log');
  await expect(log.getByText(name, { exact: true })).toBeVisible();
  await expect(cardTitled(page, 'Top Events').getByText(name, { exact: true })).toBeVisible();

  await page.getByRole('combobox').click();
  await expect(page.getByRole('option', { name: `${name} (1)`, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);

  await log.getByText(name, { exact: true }).click();
  await expect(log.locator('pre')).toHaveText(JSON.stringify({ note }, null, 2));
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await scriptsContaining(page, 'alert(2)')).toBe(0);
  expect(dialogs).toEqual([]);
});

test('ANLY-115 events from another project never show', async () => {
  const set = await roleSet('anly115');
  const qKey = await createApiKey(set.outsider, set.foreign.id, set.outsider.ip);
  const q = { owner: set.outsider, project: set.foreign, sdkKey: qKey };
  expect((await trackEvent(q, { eventName: 'q_only', distinctId: 'q-user' })).status).toBe(201);

  const qList = await getAs(set.outsider, `/api/projects/${set.foreign.id}/events`);
  expect(qList.body.data.total).toBe(1);

  const base = `/api/projects/${set.project.id}/events`;
  const list = await getAs(set.member, base);
  expect(list.status).toBe(200);
  expect(list.body.data).toEqual({ data: [], total: 0 });
  for (const route of ['names', 'volume', 'breakdown']) {
    const answer = await getAs(set.member, `${base}/${route}`);
    expect(answer.status, route).toBe(200);
    expect(answer.body.data, route).toEqual([]);
  }
});

test('ANLY-118 the event filter cannot inject SQL', async () => {
  const p = await sdkProject('anly118');
  expect((await trackEvent(p, { eventName: 'real_event', distinctId: 'u-1' })).status).toBe(201);
  const base = `/api/projects/${p.project.id}/events`;
  const injected = encodeURIComponent("' OR '1'='1");

  const all = await getAs(p.owner, base);
  expect(all.body.data.total).toBe(1);
  const allVolume = await getAs(p.owner, `${base}/volume`);
  expect(allVolume.body.data.map((point: { count: number }) => point.count)).toEqual([1]);
  const list = await getAs(p.owner, `${base}?eventName=${injected}`);
  expect(list.status).toBe(200);
  expect(list.body.data).toEqual({ data: [], total: 0 });
  const volume = await getAs(p.owner, `${base}/volume?eventName=${injected}`);
  expect(volume.status).toBe(200);
  expect(volume.body.data).toEqual([]);
});

test('ANLY-119 volume granularity cannot inject SQL', async () => {
  const p = await sdkProject('anly119');
  const yesterday = daysAgo(1);
  const at = (hour: number) => new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), hour, 0, 0).toISOString();
  for (const timestamp of [at(10), at(14), undefined]) {
    expect((await trackEvent(p, { eventName: 'tick', distinctId: 'u-1', ...(timestamp ? { timestamp } : {}) })).status).toBe(201);
  }
  const base = `/api/projects/${p.project.id}/events/volume`;
  const daily = await getAs(p.owner, `${base}?granularity=day`);
  expect(daily.body.data.map((point: { count: number }) => point.count)).toEqual([2, 1]);
  expect((await getAs(p.owner, `${base}?granularity=hour`)).body.data).toHaveLength(3);

  for (const granularity of [encodeURIComponent("day', created_at) --"), 'month']) {
    const answer = await getAs(p.owner, `${base}?granularity=${granularity}`);
    expect(answer.status, granularity).toBe(200);
    expect(answer.body.data, granularity).toEqual(daily.body.data);
  }
});

test('ANLY-121 events routes: role matrix and refusals', async () => {
  const set = await roleSet('anly121');
  const base = `/api/projects/${set.project.id}/events`;
  for (const path of [base, `${base}/names`, `${base}/volume`, `${base}/breakdown`]) {
    await checkRoleMatrix(set, path);
    await checkSecondProjectId(set, path);
  }
});

// ---------------------------------------------------------------------------
// SDK event ingest
// ---------------------------------------------------------------------------

test('ANLY-122 the JS SDK body is accepted', async () => {
  const p = await sdkProject('anly122');
  const before = Date.now();
  const answer = await trackEvent(p, { eventName: 'page_view', distinctId: 'd-1', deviceFingerprint: 'fp-js', properties: { path: '/' } });
  expect(answer.status).toBe(201);
  const event = answer.body.data;
  expect(event).toMatchObject({ projectId: p.project.id, eventName: 'page_view', distinctId: 'd-1', sourceType: 'sdk', properties: { path: '/' } });
  expect(typeof event.id).toBe('string');
  expect(Math.abs(new Date(event.timestamp).getTime() - before)).toBeLessThan(60_000);

  const rows = await sql('SELECT event_name, distinct_id, source_type, properties FROM user_events WHERE id = $1', [event.id]);
  expect(rows).toEqual([{ event_name: 'page_view', distinct_id: 'd-1', source_type: 'sdk', properties: { path: '/' } }]);
});

test('ANLY-123 the iOS and Android body keeps the client\'s timestamp', async () => {
  const p = await sdkProject('anly123');
  const timestamp = '2026-11-14T10:00:00.123Z';
  const answer = await trackEvent(p, {
    projectId: p.project.id,
    eventName: 'button_click',
    distinctId: 'native-1',
    deviceFingerprint: 'fp-native',
    timestamp,
    properties: { id: 7 },
  });
  expect(answer.status).toBe(201);
  expect(new Date(answer.body.data.timestamp).toISOString()).toBe(timestamp);

  const [row] = await sql<{ timestamp: Date; created_at: Date }>('SELECT timestamp, created_at FROM user_events WHERE id = $1', [answer.body.data.id]);
  expect(row.timestamp.toISOString()).toBe(timestamp);
  expect(Math.abs(row.created_at.getTime() - Date.now())).toBeLessThan(60_000);
  const listed = await getAs(p.owner, `/api/projects/${p.project.id}/events`);
  expect(listed.body.data.data.map((e: { timestamp: string }) => new Date(e.timestamp).toISOString())).toEqual([timestamp]);
});

test('ANLY-126 API key missing, wrong or not an SDK key', async () => {
  const p = await sdkProject('anly126');
  const owner = { token: p.owner.accessToken, ip: p.owner.ip };
  const keyPath = `/api/projects/${p.project.id}/api-keys`;
  const revoked = await api<{ apiKey: { id: string }; fullKey: string }>('POST', keyPath, { name: 'Revoked' }, owner);
  await api('DELETE', `${keyPath}/${revoked.apiKey.id}`, undefined, owner);
  const expired = await api<{ apiKey: { id: string }; fullKey: string }>('POST', keyPath, { name: 'Expired' }, owner);
  await sql(`UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE id = $1`, [expired.apiKey.id]);
  const privacy = await api<{ fullKey: string }>('POST', keyPath, { name: 'Privacy', permissions: ['privacy'] }, owner);
  // Each key is refused for its own reason: the revoked one is off, the expired one still on.
  const states = await sql<{ id: string; is_active: boolean; expired: boolean }>(
    'SELECT id, is_active, expires_at < now() AS expired FROM api_keys WHERE id = ANY($1)',
    [[revoked.apiKey.id, expired.apiKey.id]],
  );
  expect(states.find((s) => s.id === revoked.apiKey.id)).toMatchObject({ is_active: false });
  expect(states.find((s) => s.id === expired.apiKey.id)).toMatchObject({ is_active: true, expired: true });

  const body = { projectId: p.project.id, eventName: 'refused', distinctId: 'u-1' };
  const post = (headers: { apiKey?: string; token?: string }) => raw('POST', '/api/events/track', body, { ip: p.owner.ip, ...headers });

  const missing = await post({});
  expect([missing.status, missing.body.message]).toEqual([401, 'API key is required']);
  for (const [label, apiKey] of [
    ['made up', `ck_live_${randomUUID().replace(/-/g, '')}`],
    ['revoked', revoked.fullKey],
    ['expired', expired.fullKey],
  ]) {
    const answer = await post({ apiKey });
    expect([answer.status, answer.body.message], label).toEqual([401, 'Invalid or expired API key']);
  }
  const serverOnly = await post({ apiKey: privacy.fullKey });
  expect([serverOnly.status, serverOnly.body.message]).toEqual([403, SERVER_ONLY_KEY]);
  const jwtOnly = await post({ token: p.owner.accessToken });
  expect([jwtOnly.status, jwtOnly.body.message]).toEqual([401, 'API key is required']);
  // The guard runs before validation: a bad body with no key is still refused for the key.
  const badBody = await raw('POST', '/api/events/track', { nonsense: true }, { ip: p.owner.ip });
  expect([badBody.status, badBody.body.message]).toEqual([401, 'API key is required']);
  expect(await countEvents(p.project.id)).toBe(0);

  // The same body with the live key is stored, so the refusals above were about the key.
  expect((await post({ apiKey: p.sdkKey })).status).toBe(201);
  expect(await countEvents(p.project.id)).toBe(1);
});

test('ANLY-127 a key of one project cannot name another', async () => {
  const p = await sdkProject('anly127');
  const q = await sdkProject('anly127-q');
  const answer = await raw('POST', '/api/events/track', { projectId: q.project.id, eventName: 'crossed', distinctId: 'u-1' }, { apiKey: p.sdkKey, ip: p.owner.ip });
  expect(answer.status).toBe(403);
  expect(answer.body.message).toBe('Project mismatch');
  expect(await countEvents(p.project.id)).toBe(0);
  expect(await countEvents(q.project.id)).toBe(0);
});

// ---------------------------------------------------------------------------
// Do-not-track around ingest
// ---------------------------------------------------------------------------

test('ANLY-128 a do-not-track device\'s event is dropped with a 2xx', async () => {
  const p = await sdkProject('anly128');
  const fp = uniqueId('fp-dnt');
  await identify(p, { deviceFingerprint: fp, doNotTrack: true });
  expect((await deviceByFingerprint(p.project.id, fp))?.do_not_track).toBe(true);
  const before = await countEvents(p.project.id);

  const dropped = await trackEvent(p, { eventName: 'dnt_event', deviceFingerprint: fp });
  expect(dropped.status).toBe(201);
  expect(dropped.body).toEqual({ data: { recorded: false } });
  expect(await countEvents(p.project.id)).toBe(before);
  const listed = await getAs(p.owner, `/api/projects/${p.project.id}/events`);
  expect(listed.body.data).toEqual({ data: [], total: 0 });

  // A tracked device's event is stored, so the drop above was the flag.
  const tracked = await trackEvent(p, { eventName: 'dnt_event', deviceFingerprint: uniqueId('fp-tracked') });
  expect(typeof tracked.body.data.id).toBe('string');
  expect(await countEvents(p.project.id)).toBe(before + 1);
});

test('ANLY-129 a person objection drops events claiming that id', async () => {
  const p = await sdkProject('anly129');
  const secret = await identitySecret(p);
  const fp = uniqueId('fp-obj');
  await identify(p, { deviceFingerprint: fp, externalUserId: 'u-obj', userHash: userHash(secret, 'u-obj') });
  const objection = await raw(
    'POST',
    `/api/identity/projects/${p.project.id}/tracking-objections`,
    { externalUserId: 'u-obj' },
    { token: p.owner.accessToken, ip: p.owner.ip },
  );
  expect(objection.status).toBe(201);

  const byDistinctId = await trackEvent(p, { eventName: 'objected', distinctId: 'u-obj', deviceFingerprint: uniqueId('fp-unknown') });
  expect([byDistinctId.status, byDistinctId.body]).toEqual([201, { data: { recorded: false } }]);
  const byDevice = await trackEvent(p, { eventName: 'objected', distinctId: 'other', deviceFingerprint: fp });
  expect([byDevice.status, byDevice.body]).toEqual([201, { data: { recorded: false } }]);
  expect(await countEvents(p.project.id)).toBe(0);

  const someoneElse = await trackEvent(p, { eventName: 'objected', distinctId: 'u-other', deviceFingerprint: uniqueId('fp-other') });
  expect(typeof someoneElse.body.data.id).toBe('string');
  expect(await countEvents(p.project.id)).toBe(1);
});

test('ANLY-130 a distinct id cannot borrow another device\'s do-not-track', async () => {
  const p = await sdkProject('anly130');
  const q = await sdkProject('anly130-q');
  const victim = uniqueId('fp-victim');
  await identify(p, { deviceFingerprint: victim, doNotTrack: true });
  const elsewhere = uniqueId('fp-q');
  await identify(q, { deviceFingerprint: elsewhere, doNotTrack: true });

  const claimed = await trackEvent(p, { eventName: 'borrowed', distinctId: victim });
  expect(claimed.status).toBe(201);
  expect(typeof claimed.body.data.id).toBe('string');
  const otherProject = await trackEvent(p, { eventName: 'borrowed', deviceFingerprint: elsewhere });
  expect(otherProject.status).toBe(201);
  expect(typeof otherProject.body.data.id).toBe('string');
  expect(await countEvents(p.project.id)).toBe(2);

  // The flags themselves hold where they were set.
  expect((await trackEvent(p, { eventName: 'own', deviceFingerprint: victim })).body).toEqual({ data: { recorded: false } });
  expect((await trackEvent(q, { eventName: 'own', deviceFingerprint: elsewhere })).body).toEqual({ data: { recorded: false } });
});

// ---------------------------------------------------------------------------
// View-as
// ---------------------------------------------------------------------------

test('ANLY-136 view-as cannot open a project the tenant only joined', async ({ page, browser, baseURL }) => {
  test.slow(); // The super admin grant runs the CLI.
  const billingOwner = await newPerson('anly136-billing');
  const joined = await createProject(billingOwner, billingOwner.ip, `ANLY-136 joined ${randomUUID().slice(0, 6)}`);
  const tenant = await newPerson('anly136-tenant');
  const own = await createProject(tenant, tenant.ip, `ANLY-136 own ${randomUUID().slice(0, 6)}`);
  await addMember(joined.id, tenant, 'member', billingOwner);
  // As themselves, the tenant reads the joined project's events.
  expect((await getAs(tenant, `/api/projects/${joined.id}/events`)).status).toBe(200);

  const handoff = await viewAsHandoff(browser, baseURL, tenant);
  const viewAsToken = await openViewAs(page, handoff);
  const dataRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/api/projects/${joined.id}/`)) dataRequests.push(request.url());
  });
  const [answer] = await Promise.all([responseFor(page, `/api/projects/${joined.id}`), page.goto(`/projects/${joined.id}/analytics`)]);
  expect(answer.status()).toBe(404);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByText(joined.name)).toHaveCount(0);
  expect(dataRequests).toEqual([]);

  const refused = await raw('GET', `/api/projects/${joined.id}/events`, undefined, { token: viewAsToken, ip: tenant.ip });
  expect(refused.status).toBe(404);
  expect(refused.body.message).toBe(PROJECT_NOT_FOUND);
  const allowed = await raw('GET', `/api/projects/${own.id}/events`, undefined, { token: viewAsToken, ip: tenant.ip });
  expect(allowed.status).toBe(200);
});

// ---------------------------------------------------------------------------
// Dashboard do-not-track and the SDK
// ---------------------------------------------------------------------------

test('ANLY-164 a dashboard do-not-track cannot be lifted by the SDK', async () => {
  const p = await sdkProject('anly164');
  const member = await newPerson('anly164-member', 'Mo Member');
  await addMember(p.project.id, member, 'member', p.owner);
  const fpDash = uniqueId('fp-dash');
  const fpSdk = uniqueId('fp-sdk');
  const dash = await identify(p, { deviceFingerprint: fpDash });
  await identify(p, { deviceFingerprint: fpSdk });
  const consentPath = `/api/identity/projects/${p.project.id}/users/${dash.id}/consent`;
  const flags = async (fp: string) => {
    const row = await deviceByFingerprint(p.project.id, fp);
    return { doNotTrack: row?.do_not_track, source: row?.do_not_track_source };
  };
  const dropped = { data: { recorded: false } };

  // 1. A member sets it from the dashboard.
  const set = await raw('PATCH', consentPath, { doNotTrack: true }, { token: member.accessToken, ip: member.ip });
  expect(set.status).toBe(200);
  expect(set.body.data).toMatchObject({ doNotTrack: true, doNotTrackSource: 'dashboard' });
  // 2. Events from that device are dropped.
  expect((await trackEvent(p, { eventName: 'e', deviceFingerprint: fpDash })).body).toEqual(dropped);
  // 3. The SDK's false is dropped while the dashboard holds the flag.
  await identify(p, { deviceFingerprint: fpDash, doNotTrack: false });
  expect(await flags(fpDash)).toEqual({ doNotTrack: true, source: 'dashboard' });
  // 4. Still dropped.
  expect((await trackEvent(p, { eventName: 'e', deviceFingerprint: fpDash })).body).toEqual(dropped);
  expect(await countEvents(p.project.id)).toBe(0);

  // 5. Control: the SDK can lift a flag it set itself.
  await identify(p, { deviceFingerprint: fpSdk, doNotTrack: true });
  expect(await flags(fpSdk)).toEqual({ doNotTrack: true, source: 'sdk' });
  expect((await trackEvent(p, { eventName: 'e', deviceFingerprint: fpSdk })).body).toEqual(dropped);
  await identify(p, { deviceFingerprint: fpSdk, doNotTrack: false });
  expect((await flags(fpSdk)).doNotTrack).toBe(false);
  const lifted = await trackEvent(p, { eventName: 'e', deviceFingerprint: fpSdk });
  expect(lifted.status).toBe(201);
  expect(typeof lifted.body.data.id).toBe('string');

  // 6. The dashboard can lift its own flag.
  const cleared = await raw('PATCH', consentPath, { doNotTrack: false }, { token: member.accessToken, ip: member.ip });
  expect(cleared.status).toBe(200);
  expect(cleared.body.data.doNotTrack).toBe(false);
  const afterClear = await trackEvent(p, { eventName: 'e', deviceFingerprint: fpDash });
  expect(afterClear.status).toBe(201);
  expect(typeof afterClear.body.data.id).toBe('string');
  expect(await countEvents(p.project.id)).toBe(2);
});

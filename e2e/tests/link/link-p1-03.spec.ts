import { randomBytes, randomUUID } from 'crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { api, apiUrl, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../../support/api';
import { expect, signIn, test } from '../../support/fixtures';
import { stackEnv } from '../../support/stack';
import {
  activityEntries,
  addProjectMember,
  backdateClick,
  bulkImport,
  claimCustomCode,
  clickFrom,
  clicksOf,
  countClicks,
  countLinks,
  countTouchpoints,
  deferredMatch,
  DESKTOP_UA,
  giveBackCodes,
  IPHONE_UA,
  labelledBlock,
  linkActionsButton,
  linkRows,
  newApiKey,
  openShortLink,
  openShortLinkOn,
  openShortLinkWith,
  openViewAs,
  parseCsv,
  PIXEL_UA,
  rawApi,
  rawBulkImport,
  refusalShape,
  routeApiTo,
  routeRedirectHop,
  seedClickRow,
  seedLink,
  seedTouchpoints,
  seedVariant,
  setProjectApp,
  setSuspended,
  sql,
  startApiInZone,
  startViewAs,
  stubHosts,
  stubMapTiles,
  toast,
  uniqueCode,
  uniqueHost,
  variantRow,
  viewAsToken,
  waitForClicks,
  waitForTouchpoints,
  waitUntil,
  wellKnown,
  WINDOWS_CHROME_UA,
  type ExtraApi,
  type SeededLink,
} from '../../support/areas/link';

/**
 * Links, third pass: the redirect's referrer and UTM values, interstitial fallbacks and
 * policy, unknown codes, device cookies, crawlers, the preview, deferred matching (age,
 * validation, suspension, envelope, races, codes that name no click), conversions
 * (validation, suspension, attribution), the links list API's refused filters, upper-case
 * project ids, email tracking links, a shadowed `billing` code, bulk-import edges, the
 * link API's embedded project, variant weights and text, failed variant deletes, the
 * sample map, expiry and time zones, the click export's addresses, over-long input,
 * association hosts, and members' work while the billing owner is suspended.
 */

test.describe.configure({ mode: 'parallel' });

const PROJECT_NOT_FOUND = 'Project not found';
const READ_ONLY = 'Impersonation sessions are read-only';
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_AASA = { applinks: { details: [] }, webcredentials: { apps: [] } };

async function ownerWithProject(ip: string, label = 'links'): Promise<{ owner: Account; project: Project }> {
  const owner = await createAccount(ip, label, 'Lina Links');
  const project = await createProject(owner, ip);
  return { owner, project };
}

/** An owner, a project and an ordinary SDK key for it. */
async function sdkProject(ip: string, label = 'sdk'): Promise<{ owner: Account; project: Project; key: string }> {
  const { owner, project } = await ownerWithProject(ip, label);
  const { fullKey } = await newApiKey(owner, project.id, ip);
  return { owner, project, key: fullKey };
}

function messages(body: { message?: string | string[] }): string[] {
  return Array.isArray(body?.message) ? body.message : [String(body?.message)];
}

/** A string assigned in the interstitial's script (`var <name> = "...";`). */
function scriptValue(html: string, name: string): string | null {
  return JSON.parse(new RegExp(`var ${name} = ("(?:[^"\\\\]|\\\\.)*");`).exec(html)?.[1] ?? 'null') as string | null;
}

function fallbackHref(html: string): string | null {
  return /<a id="fallback-link" href="([^"]*)">/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? null;
}

async function matchedOf(clickId: string): Promise<boolean> {
  const [row] = await sql<{ matched: boolean }>('SELECT matched FROM click_events WHERE id = $1', [clickId]);
  return row.matched;
}

function shortDate(date: Date): string {
  // date-fns 'MMM d, yyyy', as the dashboard formats it (in the browser's zone).
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The detail page once its tiles are there. */
async function openDetail(page: Page, projectId: string, linkId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/links/${linkId}`);
  await expect(page.getByText('Total Clicks', { exact: true })).toBeVisible();
}

/** The edit page once its form holds the link's stored destination. */
async function openEdit(page: Page, projectId: string, link: { id: string; longUrl: string }): Promise<void> {
  await page.goto(`/projects/${projectId}/links/${link.id}/edit`);
  await expect(page.getByRole('heading', { name: 'Edit Link' })).toBeVisible();
  await expect(page.getByPlaceholder('https://example.com/page')).toHaveValue(link.longUrl);
}

/** The toasts on screen (not their screen-reader copies). */
function toasts(page: Page) {
  return page.getByRole('region', { name: /^Notifications/ }).getByRole('listitem');
}

/** Opens "Add A/B Test Variant" from the A/B Testing tab, by whichever button the tab offers. */
async function openVariantDialog(page: Page) {
  const first = page.getByRole('button', { name: 'Add First Variant' });
  if (await first.isVisible()) await first.click();
  else await page.getByRole('button', { name: 'Add Variant', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add A/B Test Variant' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function addVariantInPage(page: Page, linkId: string, fields: { name: string; url: string; weight: string }): Promise<number> {
  const dialog = await openVariantDialog(page);
  await dialog.getByPlaceholder('e.g., Variant B').fill(fields.name);
  await dialog.getByPlaceholder('https://example.com/page-b').fill(fields.url);
  await dialog.locator('input[type=number]').fill(fields.weight);
  const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/links/${linkId}/variants`);
  await dialog.getByRole('button', { name: 'Add Variant' }).click();
  const status = (await answered).status();
  if (status === 201) await expect(dialog).toBeHidden();
  return status;
}

// ---- K. Redirect

test('LINK-162 a direct API request keeps the Referer it was sent', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/ref', shortCode: uniqueCode('ref-api') });
  const opened = await openShortLinkWith(link.shortCode, newClientIp(), { Referer: 'https://news.example.com/story' });
  expect([opened.status, opened.location]).toEqual([302, 'https://example.com/ref']);
  await waitForClicks(link.id, 1);
  expect(await sql('SELECT referrer FROM click_events WHERE link_id = $1', [link.id])).toEqual([{ referrer: 'https://news.example.com/story' }]);
});

test('LINK-162 referrer of a link opened through the dashboard host', async ({ page, baseURL, clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-162' });
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/ref', shortCode: uniqueCode('ref-app') });
  await page.route('https://news.example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><title>News</title><a href="${new URL(baseURL!).origin}/${link.shortCode}">Read the story</a>`,
    }),
  );
  await stubHosts(page, ['example.com'], 200);
  await routeRedirectHop(page);

  await page.goto('https://news.example.com/story');
  await page.getByRole('link', { name: 'Read the story' }).click();
  await expect(page).toHaveURL('https://example.com/ref');
  await waitForClicks(link.id, 1);
  expect(await sql('SELECT referrer FROM click_events WHERE link_id = $1', [link.id])).toEqual([{ referrer: 'https://news.example.com/' }]);
});

test('LINK-163 UTM parameters on a direct API redirect create a touchpoint', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/utm', shortCode: uniqueCode('utm-api') });
  const visitor = newClientIp();
  const opened = await openShortLinkWith(`${link.shortCode}?utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e`, visitor, {
    'User-Agent': WINDOWS_CHROME_UA,
    Referer: 'https://ref.example/',
  });
  expect([opened.status, opened.location]).toEqual([302, 'https://example.com/utm']);
  await waitForTouchpoints(link.id, 1);
  const rows = await sql(
    `SELECT project_id, touchpoint_type, link_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content, channel, campaign,
            referrer, platform, device_type, ip_address, distinct_id, device_fingerprint
       FROM touchpoints WHERE link_id = $1`,
    [link.id],
  );
  expect(rows).toEqual([
    {
      project_id: project.id,
      touchpoint_type: 'link_click',
      link_id: link.id,
      utm_source: 'a',
      utm_medium: 'b',
      utm_campaign: 'c',
      utm_term: 'd',
      utm_content: 'e',
      channel: 'a',
      campaign: 'c',
      referrer: 'https://ref.example/',
      platform: 'windows',
      device_type: 'desktop',
      ip_address: visitor,
      distinct_id: null,
      device_fingerprint: null,
    },
  ]);
});

test('LINK-166 iOS fallback order', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await api('PATCH', `/api/projects/${project.id}`, { iosAppStoreUrl: 'https://apps.apple.com/app/id123' }, { token: owner.accessToken, ip: clientIp });
  const bare = await createProject(owner, clientIp);
  const a = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/a',
    iosUrl: 'https://example.com/app/a',
    iosFallbackUrl: 'https://example.com/ios-fallback',
  });
  const b = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/b', iosUrl: 'https://example.com/app/b' });
  const c = await seedLink(owner, bare.id, clientIp, { longUrl: 'https://example.com/c', iosUrl: 'https://example.com/app/c' });

  const fallbacks: Record<string, [string | null, string | null, string | null]> = {};
  for (const [name, link] of Object.entries({ a, b, c })) {
    const response = await openShortLink(link.shortCode, newClientIp(), IPHONE_UA);
    expect(response.status).toBe(200);
    const html = response.body as string;
    fallbacks[name] = [scriptValue(html, 'deepLink'), fallbackHref(html), scriptValue(html, 'fallback')];
  }
  expect(fallbacks).toEqual({
    a: ['https://example.com/app/a', 'https://example.com/ios-fallback', 'https://example.com/ios-fallback'],
    b: ['https://example.com/app/b', 'https://apps.apple.com/app/id123', 'https://apps.apple.com/app/id123'],
    c: ['https://example.com/app/c', 'https://example.com/c', 'https://example.com/c'],
  });
});

test('LINK-168 Android interstitial without a package name', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/web', androidUrl: 'https://example.com/app/x' });
  const response = await openShortLink(link.shortCode, newClientIp(), PIXEL_UA);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(scriptValue(response.body, 'deepLink')).toBe('https://example.com/app/x');
  expect(response.body).not.toContain('intent://');

  // The control: with a package name the same link is wrapped in an intent URL.
  await setProjectApp(project.id, { androidPackageName: 'com.example.app' });
  const wrapped = await openShortLink(link.shortCode, newClientIp(), PIXEL_UA);
  expect(scriptValue(wrapped.body, 'deepLink')).toBe('intent://example.com/app/x#Intent;scheme=https;package=com.example.app;end');
});

test('LINK-169 mobile without a deep link goes straight to the destination', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/plain', shortCode: uniqueCode('plain') });
  for (const [index, ua] of [IPHONE_UA, PIXEL_UA].entries()) {
    const response = await openShortLink(link.shortCode, newClientIp(), ua);
    expect([response.status, response.location]).toEqual([302, 'https://example.com/plain']);
    await waitForClicks(link.id, index + 1);
  }
  const rows = await sql('SELECT platform, device_type, redirect_type, is_deferred FROM click_events WHERE link_id = $1 ORDER BY clicked_at', [link.id]);
  expect(rows).toEqual([
    { platform: 'ios', device_type: 'mobile', redirect_type: 'web_fallback', is_deferred: false },
    { platform: 'android', device_type: 'mobile', redirect_type: 'web_fallback', is_deferred: false },
  ]);
});

test('LINK-173 interstitial Content-Security-Policy and nonce', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/csp',
    iosUrl: 'https://example.com/app/csp',
    deepLinkParams: { screen: 'csp' },
  });
  const nonces: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await openShortLink(link.shortCode, newClientIp(), IPHONE_UA);
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy') ?? '';
    const match = /^default-src 'none'; script-src 'nonce-([A-Za-z0-9+/=]+)'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/.exec(policy);
    expect(match, policy).not.toBeNull();
    const nonce = match![1];
    const html = response.body as string;
    expect([...html.matchAll(/<script nonce="([^"]+)">/g)].map((m) => m[1])).toEqual([nonce]);
    expect(html).toContain('<script type="application/json" id="chumbaq-params">{"screen":"csp"}</script>');
    expect(html.match(/<script/g)).toHaveLength(2);
    nonces.push(nonce);
  }
  expect(nonces[0]).not.toBe(nonces[1]);
});

test('LINK-174 unknown short code', async ({ page, clientIp }) => {
  const code = uniqueCode('no-such-code');
  const answer = await openShortLink(code, clientIp);
  expect(answer.status).toBe(404);
  expect(answer.headers.get('content-type')).toMatch(/^application\/json/);
  expect(refusalShape(answer.body)).toEqual({ statusCode: 404, error: 'Not Found', message: 'Link not found' });

  await page.goto(`/${code}`);
  await expect(page).toHaveURL(new RegExp(`/redirect/${code}$`));
  await expect(page.locator('body')).toContainText('"message":"Link not found"');
  await expect(page.locator('body')).toContainText('"statusCode":404');
});

test('LINK-178 click is tied to the JS SDK device cookie', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const apiKey = await createApiKey(owner, project.id, clientIp);
  const suffix = randomUUID().slice(0, 8);
  const fingerprint = `fp_abc123_${suffix}`;
  await api(
    'POST',
    '/api/identity/identify',
    { projectId: project.id, deviceFingerprint: fingerprint, platform: 'web', distinctId: `user-1-${suffix}` },
    { apiKey, ip: clientIp },
  );
  const [identity] = await sql<{ id: string; do_not_track: boolean }>('SELECT id, do_not_track FROM device_identities WHERE device_fingerprint = $1', [fingerprint]);
  expect(identity.do_not_track).toBe(false);

  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/did', shortCode: uniqueCode('did') });
  const opened = await rawApi('GET', `/api/${link.shortCode}`, undefined, { ip: newClientIp(), headers: { Cookie: `chumbaq_did=${fingerprint}`, 'User-Agent': DESKTOP_UA } });
  expect(opened.status).toBe(302);
  await waitForClicks(link.id, 1);
  await waitForTouchpoints(link.id, 1);
  expect(await sql('SELECT device_identity_id, distinct_id FROM click_events WHERE link_id = $1', [link.id])).toEqual([
    { device_identity_id: identity.id, distinct_id: `user-1-${suffix}` },
  ]);
  expect(await sql('SELECT device_fingerprint FROM touchpoints WHERE link_id = $1', [link.id])).toEqual([{ device_fingerprint: fingerprint }]);
});

test('LINK-182 a crawler fetching a short link on the dashboard host gets the dashboard page', async ({ request, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/og', shortCode: uniqueCode('og') });
  const response = await request.get(`/${link.shortCode}`, { headers: { 'User-Agent': 'facebookexternalhit/1.1' }, maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/html/);
  expect(await response.text()).toContain('<div id="root">');
});

test('LINK-182 social previews of short links carry the link\'s OG tags', async ({ request, clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-182' });
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/og',
    shortCode: uniqueCode('og'),
    ogTitle: 'Great shoes',
    ogDescription: 'Buy now',
    ogImageUrl: 'https://example.com/og.png',
  });
  const response = await request.get(`/${link.shortCode}`, { headers: { 'User-Agent': 'facebookexternalhit/1.1' }, maxRedirects: 0 });
  const html = await response.text();
  expect(html).toContain('<meta property="og:title" content="Great shoes">');
  expect(html).toContain('<meta property="og:description" content="Buy now">');
  expect(html).toContain('<meta property="og:image" content="https://example.com/og.png">');
});

// ---- L. Link preview

test('LINK-184 preview returns public metadata only', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const full = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/full',
    shortCode: uniqueCode('pv-full'),
    title: 'Preview me',
    ogTitle: 'OG title',
    ogDescription: 'OG description',
    ogImageUrl: 'https://example.com/og.png',
    iosUrl: 'https://example.com/app/full',
    androidUrl: 'https://example.com/app/full-a',
    deepLinkParams: { secret: 'params' },
  });
  const bare = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/bare', shortCode: uniqueCode('pv-bare') });

  for (const urlPath of [`/api/${full.shortCode}/preview`, `/${full.shortCode}/preview`]) {
    const answer = await rawApi('GET', urlPath, undefined, { ip: clientIp });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      data: {
        title: 'Preview me',
        ogTitle: 'OG title',
        ogDescription: 'OG description',
        ogImageUrl: 'https://example.com/og.png',
        longUrl: 'https://example.com/full',
        shortCode: full.shortCode,
      },
    });
  }
  const empty = await rawApi('GET', `/api/${bare.shortCode}/preview`, undefined, { ip: clientIp });
  expect(empty.body).toEqual({
    data: { title: '', ogTitle: '', ogDescription: '', ogImageUrl: '', longUrl: 'https://example.com/bare', shortCode: bare.shortCode },
  });

  // No click from the previews: the one redirect afterwards is the only one counted.
  expect((await openShortLink(full.shortCode, newClientIp())).status).toBe(302);
  await waitForClicks(full.id, 1);
  expect([await countClicks(full.id), await countClicks(bare.id)]).toEqual([1, 0]);
});

// ---- N. Deferred match

test('LINK-196 clicks older than 48 hours are not claimed', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/old',
    shortCode: uniqueCode('dm-old'),
    iosUrl: 'https://example.com/app/old',
    deepLinkParams: { screen: 'old' },
  });
  const [oldIp, recentIp] = [newClientIp(), newClientIp()];
  const oldClick = await clickFrom(link, oldIp, IPHONE_UA);
  await backdateClick(oldClick, 49 * 60);
  const recentClick = await clickFrom(link, recentIp, IPHONE_UA);
  await backdateClick(recentClick, 47 * 60);

  const byCode = await deferredMatch(key, oldIp, { cookieRef: link.shortCode });
  expect([byCode.status, byCode.body]).toEqual([201, { data: { matched: false } }]);
  const byFingerprint = await deferredMatch(key, oldIp, { fingerprint: { os: 'iOS' } });
  expect(byFingerprint.body).toEqual({ data: { matched: false } });
  expect(await matchedOf(oldClick)).toBe(false);

  const recent = await deferredMatch(key, recentIp, { fingerprint: { os: 'iOS' } });
  expect([recent.status, recent.body]).toEqual([201, { data: { matched: true, linkId: link.id, shortCode: link.shortCode, params: { screen: 'old' } } }]);
  expect([await matchedOf(oldClick), await matchedOf(recentClick)]).toEqual([false, true]);
});

test('LINK-201 deferred match body validation', async ({ clientIp }) => {
  const { key } = await sdkProject(clientIp);
  const call = (body: unknown) => deferredMatch(key, newClientIp(), body);

  const noOs = await call({ fingerprint: {} });
  expect(noOs.status).toBe(400);
  expect(messages(noOs.body)).toEqual(['fingerprint.os must be a string']);
  const unknown = await call({ foo: 1 });
  expect([unknown.status, messages(unknown.body)]).toEqual([400, ['property foo should not exist']]);
  const notNumber = await call({ fingerprint: { os: 'iOS', screenWidth: 'wide' } });
  expect([notNumber.status, messages(notNumber.body)]).toEqual([400, ['fingerprint.screenWidth must be a number conforming to the specified constraints']]);
  // The global pipe converts by the declared type: a numeric string is a number, and
  // anything is a string, so cookieRef is never refused for its type.
  const numericString = await call({ fingerprint: { os: 'iOS', screenWidth: '390' } });
  expect([numericString.status, numericString.body]).toEqual([201, { data: { matched: false } }]);
  for (const cookieRef of [5, { code: 'x' }]) {
    const converted = await call({ cookieRef });
    expect([converted.status, converted.body]).toEqual([201, { data: { matched: false } }]);
  }
  const empty = await call({});
  expect([empty.status, empty.body]).toEqual([201, { data: { matched: false } }]);
});

test('LINK-202 deferred match keeps working for a suspended tenant', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/susp', shortCode: uniqueCode('dm-susp'), deepLinkParams: { screen: 'susp' } });
  const phone = newClientIp();
  const clickId = await clickFrom(link, phone, IPHONE_UA);
  await setSuspended(owner.userId, true);
  try {
    // The suspension is in force: the link itself is unavailable.
    expect((await openShortLink(link.shortCode, newClientIp())).status).toBe(404);
    const answer = await deferredMatch(key, phone, { cookieRef: link.shortCode });
    expect([answer.status, answer.body]).toEqual([201, { data: { matched: true, linkId: link.id, shortCode: link.shortCode, params: { screen: 'susp' } } }]);
    expect(await matchedOf(clickId)).toBe(true);
  } finally {
    await setSuspended(owner.userId, false);
  }
});

test('LINK-203 deferred match response is enveloped', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/env', shortCode: uniqueCode('dm-env'), deepLinkParams: { screen: 'env' } });
  const phone = newClientIp();
  await clickFrom(link, phone, IPHONE_UA);
  for (const expected of [true, false]) {
    const answer = await deferredMatch(key, phone, { cookieRef: link.shortCode });
    expect(answer.status).toBe(201);
    expect(Object.keys(answer.body)).toEqual(['data']);
    expect(answer.body.matched).toBeUndefined();
    expect(answer.body.data.matched).toBe(expected);
  }
});

test('LINK-259 racing installs never count one click twice', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/race',
    shortCode: uniqueCode('race-dm'),
    iosUrl: 'https://example.com/app/race',
    deepLinkParams: { screen: 'promo' },
  });
  const phone = newClientIp();
  const clickId = await clickFrom(link, phone, IPHONE_UA);
  const answers = await Promise.all(Array.from({ length: 5 }, () => deferredMatch(key, phone, { cookieRef: link.shortCode })));
  const matched = answers.filter((answer) => answer.body.data?.matched);
  expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201, 201]);
  expect(matched.length).toBeGreaterThanOrEqual(1);
  for (const answer of matched) expect(answer.body.data).toEqual({ matched: true, linkId: link.id, shortCode: link.shortCode, params: { screen: 'promo' } });
  expect(await matchedOf(clickId)).toBe(true);
  const summary = await api<{ matchedInstalls: number }>('GET', `/api/links/${link.id}/analytics`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(summary.matchedInstalls).toBe(1);
});

test('LINK-259 two installs racing for one click: only one gets it', async ({ clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-259' });
  test.slow();
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/race',
    shortCode: uniqueCode('race-dm'),
    iosUrl: 'https://example.com/app/race',
    deepLinkParams: { screen: 'promo' },
  });
  const winners: number[] = [];
  for (let round = 0; round < 10; round++) {
    for (const body of [{ cookieRef: link.shortCode }, { fingerprint: { os: 'iOS 17' } }]) {
      const phone = newClientIp();
      await clickFrom(link, phone, IPHONE_UA);
      const answers = await Promise.all(Array.from({ length: 5 }, () => deferredMatch(key, phone, body)));
      winners.push(answers.filter((answer) => answer.body.data?.matched).length);
    }
  }
  expect(winners).toEqual(Array(20).fill(1));
});

test('LINK-260 a short code naming no link falls through to fingerprint matching', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/other',
    shortCode: uniqueCode('fp-other'),
    iosUrl: 'https://example.com/app/other',
    deepLinkParams: { screen: 'other' },
  });
  const nope = uniqueCode('nope');
  const first = newClientIp();
  const firstClick = await clickFrom(link, first, IPHONE_UA);
  const withFingerprint = await deferredMatch(key, first, { cookieRef: nope, fingerprint: { os: 'iOS' } });
  expect([withFingerprint.status, withFingerprint.body]).toEqual([
    201,
    { data: { matched: true, linkId: link.id, shortCode: link.shortCode, params: { screen: 'other' } } },
  ]);
  expect(await matchedOf(firstClick)).toBe(true);

  const second = newClientIp();
  const secondClick = await clickFrom(link, second, IPHONE_UA);
  const codeOnly = await deferredMatch(key, second, { cookieRef: nope });
  expect([codeOnly.status, codeOnly.body]).toEqual([201, { data: { matched: false } }]);
  expect(await matchedOf(secondClick)).toBe(false);
});

test('LINK-261 an own-project code with no click from this address falls through too', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const a = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/a', shortCode: uniqueCode('dm-a'), iosUrl: 'https://example.com/app/a', deepLinkParams: { screen: 'a' } });
  const b = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/b', shortCode: uniqueCode('dm-b'), iosUrl: 'https://example.com/app/b', deepLinkParams: { screen: 'b' } });
  const aClick = await clickFrom(a, newClientIp(), IPHONE_UA);
  const phone = newClientIp();
  const bClick = await clickFrom(b, phone, IPHONE_UA);

  const answer = await deferredMatch(key, phone, { cookieRef: a.shortCode, fingerprint: { os: 'iOS' } });
  expect([answer.status, answer.body]).toEqual([201, { data: { matched: true, linkId: b.id, shortCode: b.shortCode, params: { screen: 'b' } } }]);
  expect([await matchedOf(aClick), await matchedOf(bClick)]).toEqual([false, true]);
});

// ---- O. Conversions

test('LINK-207 conversion validation', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/conv', shortCode: uniqueCode('conv-1') });
  const shortCode = link.shortCode;
  const cases: [string, Record<string, unknown>, number, string[]][] = [
    ['no link', { eventType: 'signup' }, 400, ['Either shortCode or linkId must be provided']],
    ['no event type', { shortCode }, 400, ['eventType should not be empty', 'eventType must be a string']],
    ['empty event type', { shortCode, eventType: '' }, 400, ['eventType should not be empty']],
    ['long event type', { shortCode, eventType: 'e'.repeat(101) }, 400, ['eventType must be shorter than or equal to 100 characters']],
    ['long external id', { shortCode, eventType: 'signup', externalUserId: 'u'.repeat(256) }, 400, ['externalUserId must be shorter than or equal to 255 characters']],
    ['bad link id', { linkId: 'abc', eventType: 'signup' }, 400, ['linkId must be a UUID']],
    ['bad project id', { shortCode, eventType: 'signup', projectId: 'abc' }, 400, ['projectId must be a UUID']],
    ['metadata not an object', { shortCode, eventType: 'signup', metadata: 'x' }, 400, ['metadata must be an object']],
    ['unknown field', { shortCode, eventType: 'signup', revenue: 5 }, 400, ['property revenue should not exist']],
    ['unknown code', { shortCode: uniqueCode('nope-404'), eventType: 'signup' }, 404, ['Link not found']],
    ['unknown link id', { linkId: randomUUID(), eventType: 'signup' }, 404, ['Link not found']],
  ];
  const seen: [string, number, string[]][] = [];
  for (const [name, body] of cases) {
    const answer = await rawApi('POST', '/api/conversions', body, { apiKey: key, ip: clientIp });
    seen.push([name, answer.status, messages(answer.body)]);
  }
  expect(seen.map(([name, status]) => [name, status])).toEqual(cases.map(([name, , status]) => [name, status]));
  for (const [index, [name, , , expected]] of cases.entries()) {
    expect(seen[index][2], name).toEqual(expect.arrayContaining(expected));
  }
  expect(await sql('SELECT id FROM conversion_events WHERE link_id = $1', [link.id])).toEqual([]);

  // The control: the same link and event type are recorded.
  expect((await rawApi('POST', '/api/conversions', { shortCode, eventType: 'signup' }, { apiKey: key, ip: clientIp })).status).toBe(201);
  expect(await sql('SELECT event_type FROM conversion_events WHERE link_id = $1', [link.id])).toEqual([{ event_type: 'signup' }]);
});

test('LINK-210 conversions keep working for a suspended tenant', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/susp-conv', shortCode: uniqueCode('conv-susp') });
  await setSuspended(owner.userId, true);
  try {
    expect((await openShortLink(link.shortCode, newClientIp())).status).toBe(404);
    const answer = await rawApi('POST', '/api/conversions', { shortCode: link.shortCode, eventType: 'purchase' }, { apiKey: key, ip: clientIp });
    expect(answer.status).toBe(201);
    expect(answer.body.data).toMatchObject({ linkId: link.id, eventType: 'purchase' });
    expect(await sql('SELECT id, event_type FROM conversion_events WHERE link_id = $1', [link.id])).toEqual([{ id: answer.body.data.id, event_type: 'purchase' }]);
  } finally {
    await setSuspended(owner.userId, false);
  }
});

test('LINK-265 conversions start multi-touch attribution only with an external user id', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/att', shortCode: uniqueCode('conv-att') });
  const person = `u-att-${randomBytes(3).toString('hex')}`;
  // Three inside the 30-day window, one outside it.
  await seedTouchpoints(project.id, person, [60, 24 * 60, 10 * 24 * 60, 40 * 24 * 60]);
  const post = (body: Record<string, unknown>) =>
    rawApi('POST', '/api/conversions', { eventType: 'purchase', shortCode: link.shortCode, ...body }, { apiKey: key, ip: clientIp });

  const anonymous = await post({});
  expect(anonymous.status).toBe(201);
  const named = await post({ externalUserId: person });
  expect(named.status).toBe(201);

  const resultsOf = (conversionId: string) =>
    sql<{ model: string; distinct_id: string; touchpoint_count: number; lookback_days: number }>(
      'SELECT model, distinct_id, touchpoint_count, lookback_days FROM attribution_results WHERE conversion_id = $1 ORDER BY model',
      [conversionId],
    );
  const results = await waitUntil(() => resultsOf(named.body.data.id), (rows) => rows.length >= 4, 'the attribution of the named conversion');
  expect(results).toEqual(
    ['first_touch', 'last_touch', 'linear', 'time_decay'].map((model) => ({ model, distinct_id: person, touchpoint_count: 3, lookback_days: 30 })),
  );
  // The anonymous conversion came first, so its results would be there by now had it any.
  expect(await resultsOf(anonymous.body.data.id)).toEqual([]);
});

// ---- P. Webhooks

test('LINK-211 clicks and conversions fire project webhooks', async () => {
  test.skip(true, 'Webhook deliveries need a public receiver, which the local stack does not have');
});

// ---- Q. Review additions

test('LINK-212 links list API refuses search and tags today', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  for (const title of ['Summer sale', 'Winter coats', 'Summer camp']) {
    await seedLink(owner, project.id, clientIp, { longUrl: `https://example.com/${title.replace(/\W+/g, '-').toLowerCase()}`, title, tags: ['marketing'] });
  }
  const list = (query: string) => rawApi('GET', `/api/projects/${project.id}/links?${query}`, undefined, { token: owner.accessToken, ip: clientIp });

  const all = await list('page=1&limit=20');
  expect(all.status).toBe(200);
  expect((all.body.data as { title: string }[]).map((link) => link.title)).toEqual(['Summer camp', 'Winter coats', 'Summer sale']);
  expect(all.body.meta).toEqual({ total: 3, page: 1, limit: 20, totalPages: 1 });

  for (const [query, message] of [
    ['page=1&limit=20&search=summer', 'property search should not exist'],
    ['tags=marketing', 'property tags should not exist'],
    ['search=', 'property search should not exist'],
    ['foo=1', 'property foo should not exist'],
  ]) {
    const refused = await list(query);
    expect([query, refused.status, refused.body.message]).toEqual([query, 400, [message]]);
  }
});

test('LINK-212 links list API filters by search and tags', async ({ clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-212' });
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/s1', title: 'Summer sale', tags: ['marketing'] });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/w1', title: 'Winter coats' });
  const list = (query: string) => rawApi('GET', `/api/projects/${project.id}/links?${query}`, undefined, { token: owner.accessToken, ip: clientIp });
  const searched = await list('page=1&limit=20&search=summer');
  expect([searched.status, (searched.body.data ?? []).map((link: { title: string }) => link.title)]).toEqual([200, ['Summer sale']]);
  const tagged = await list('tags=marketing');
  expect([tagged.status, (tagged.body.data ?? []).map((link: { title: string }) => link.title)]).toEqual([200, ['Summer sale']]);
});

test('LINK-214 upper-cased project id in a links URL', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/case', title: 'Lower-case only' });
  const upper = project.id.toUpperCase();
  expect(upper).not.toBe(project.id);

  const listed = await rawApi('GET', `/api/projects/${upper}/links`, undefined, { token: owner.accessToken, ip: clientIp });
  expect([listed.status, listed.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const created = await rawApi('POST', `/api/projects/${upper}/links`, { longUrl: 'https://example.com/upper' }, { token: owner.accessToken, ip: clientIp });
  expect([created.status, created.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(await countLinks(project.id)).toBe(1);

  // The project itself is not found under that spelling, so the layout sends the person
  // back to the project list before the links page asks for anything.
  await signIn(page, owner);
  const asked: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(`/api/projects/${upper}`)) asked.push(new URL(request.url()).pathname);
  });
  await page.goto(`/projects/${upper}/links`);
  await expect(page).toHaveURL(/\/projects$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByText('Lower-case only')).toHaveCount(0);
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.filter((p) => p.endsWith('/links'))).toEqual([]);

  // The control: the canonical id lists it.
  await page.goto(`/projects/${project.id}/links`);
  await expect(linkRows(page).filter({ hasText: 'Lower-case only' })).toHaveCount(1);
});

/** Rewrites the case's two tracked links (and a mailto: link) through the email-links route. */
async function rewriteEmail(owner: Account, projectId: string, ip: string) {
  const html = `<a href="https://shop.example.com/sale?utm_source=mail&x=1">Sale</a> <a href='http://example.org/a'>A</a> <a href="mailto:a@b.c">m</a>`;
  const answer = await rawApi('POST', `/api/projects/${projectId}/email-links/rewrite`, { html }, { token: owner.accessToken, ip });
  const appUrl = stackEnv().APP_URL;
  const escaped = appUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const codes = [...String(answer.body?.data?.html ?? '').matchAll(new RegExp(`href="${escaped}/([A-Za-z0-9_-]+)"`, 'g'))].map((m) => m[1]);
  return { answer, appUrl, codes };
}

async function linkByCode(code: string): Promise<{ id: string; long_url: string; title: string }> {
  const [row] = await sql<{ id: string; long_url: string; title: string }>('SELECT id, long_url, title FROM links WHERE short_code = $1', [code]);
  return row;
}

test('LINK-218 email tracking links appear in the Links list', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const { answer, appUrl, codes } = await rewriteEmail(owner, project.id, clientIp);
  expect(answer.status).toBe(201);
  expect(codes).toHaveLength(2);
  expect(answer.body).toEqual({
    data: { html: `<a href="${appUrl}/${codes[0]}">Sale</a> <a href="${appUrl}/${codes[1]}">A</a> <a href="mailto:a@b.c">m</a>` },
  });

  const expected = [
    { url: 'https://shop.example.com/sale?utm_source=mail&x=1', title: 'Email link: https://shop.example.com/sale?utm_source=mail&x=1' },
    { url: 'http://example.org/a', title: 'Email link: http://example.org/a' },
  ];
  for (const [index, code] of codes.entries()) {
    const row = await linkByCode(code);
    const link = await api<Record<string, unknown>>('GET', `/api/links/${row.id}`, undefined, { token: owner.accessToken, ip: clientIp });
    expect(link).toMatchObject({ shortCode: code, longUrl: expected[index].url, title: expected[index].title, tags: null, isActive: true, expiresAt: null, projectId: project.id });
  }
  expect(await sql('SELECT action FROM project_activity WHERE project_id = $1', [project.id])).toEqual([]);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await expect(linkRows(page)).toHaveCount(2);
  for (const [index, code] of codes.entries()) {
    const row = linkRows(page).filter({ hasText: code });
    await expect(row).toContainText(expected[index].title);
    await expect(row).toContainText('Active');
  }
});

test('LINK-219 deleting or deactivating an email tracking link breaks the sent email', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const { codes } = await rewriteEmail(owner, project.id, clientIp);
  const [e1, e2] = [await linkByCode(codes[0]), await linkByCode(codes[1])];
  for (const code of codes) expect((await openShortLink(code, newClientIp())).status).toBe(302);

  await signIn(page, owner);
  await openDetail(page, project.id, e1.id);
  await linkActionsButton(page).click();
  await page.getByRole('menuitem', { name: 'Delete Link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Link' });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(toast(page, 'Link deleted')).toBeVisible();
  const deleted = await openShortLink(codes[0], newClientIp());
  expect([deleted.status, deleted.body.message]).toEqual([404, 'Link not found']);

  await openEdit(page, project.id, { id: e2.id, longUrl: e2.long_url });
  await page.getByRole('tab', { name: 'Settings' }).click();
  const active = page.getByRole('switch');
  await expect(active).toHaveAttribute('aria-checked', 'true');
  await active.click();
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(toast(page, 'Link updated')).toBeVisible();
  const off = await openShortLink(codes[1], newClientIp());
  expect([off.status, off.body.message]).toEqual([404, 'Link is no longer active']);

  const entries = await sql<{ action: string; target_id: string }>('SELECT action, target_id FROM project_activity WHERE project_id = $1 ORDER BY occurred_at', [project.id]);
  expect(entries).toEqual([
    { action: 'content.deleted', target_id: e1.id },
    { action: 'link.changed', target_id: e2.id },
  ]);
});

test('LINK-219 activity entries of email tracking links hold no URL', async ({ clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-219' });
  const { owner, project } = await ownerWithProject(clientIp);
  const { codes } = await rewriteEmail(owner, project.id, clientIp);
  const [e1, e2] = [await linkByCode(codes[0]), await linkByCode(codes[1])];
  await api('DELETE', `/api/links/${e1.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  await api('PATCH', `/api/links/${e2.id}`, { isActive: false }, { token: owner.accessToken, ip: clientIp });
  const entries = await sql<{ action: string; target_label: string }>('SELECT action, target_label, details FROM project_activity WHERE project_id = $1', [project.id]);
  expect(entries.map((entry) => entry.action).sort()).toEqual(['content.deleted', 'link.changed']);
  expect(JSON.stringify(entries)).not.toContain('example.com');
  expect(JSON.stringify(entries)).not.toContain('example.org');
});

test('LINK-220 a billing short code is shadowed by the billing API', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  try {
    const lower = await claimCustomCode(owner, project.id, clientIp, { longUrl: 'https://example.com/b', shortCode: 'billing' });
    expect([lower.status, lower.body.data?.shortCode]).toEqual([201, 'billing']);
    const mixed = await claimCustomCode(owner, project.id, clientIp, { longUrl: 'https://example.com/b2', shortCode: 'Billing' });
    expect([mixed.status, mixed.body.data?.shortCode]).toEqual([201, 'Billing']);

    // Billing is on in this stack, so the billing route asks for a session; never a redirect.
    for (const urlPath of ['/billing', '/api/billing', '/Billing']) {
      const response = await fetch(apiUrl(urlPath), { redirect: 'manual', headers: { 'User-Agent': DESKTOP_UA, 'X-Forwarded-For': newClientIp() } });
      const body = (await response.json()) as { statusCode: number; message: string };
      expect([urlPath, response.status, response.headers.get('location'), body.message]).toEqual([urlPath, 401, null, 'Unauthorized']);
    }

    await page.goto('/billing');
    await expect(page).toHaveURL(/\/redirect\/billing$/);
    await expect(page.locator('body')).toContainText('"statusCode":401');

    const preview = await rawApi('GET', '/billing/preview', undefined, { ip: clientIp });
    expect([preview.status, preview.body.data]).toEqual([
      200,
      { title: '', ogTitle: '', ogDescription: '', ogImageUrl: '', longUrl: 'https://example.com/b', shortCode: 'billing' },
    ]);

    // A normal link's click lands, so the shadowed ones would have by now.
    const control = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/control' });
    expect((await openShortLink(control.shortCode, newClientIp())).status).toBe(302);
    await waitForClicks(control.id, 1);
    expect([await countClicks(lower.body.data.id), await countClicks(mixed.body.data.id)]).toEqual([0, 0]);
  } finally {
    await giveBackCodes(project.id);
  }
});

test('LINK-220 custom code billing is a reserved word', async ({ clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-220' });
  const { owner, project } = await ownerWithProject(clientIp);
  try {
    const answer = await claimCustomCode(owner, project.id, clientIp, { longUrl: 'https://example.com/b', shortCode: 'BILLING' });
    expect([answer.status, answer.body.message]).toEqual([409, '"BILLING" is a reserved word and cannot be used as a short code']);
  } finally {
    await giveBackCodes(project.id);
  }
});

test('LINK-222 clicking "Import Links" twice imports the file twice', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/bulk-import`);
  const csv = ['longUrl,title', 'https://example.com/r1,Row one', 'https://example.com/r2,Row two', 'https://example.com/r3,Row three'].join('\n');
  await page.locator('input[type=file]').setInputFiles({ name: 'links.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const importButton = page.getByRole('button', { name: 'Import Links' });

  for (let round = 1; round <= 2; round++) {
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/projects/${project.id}/links/bulk`);
    await importButton.click();
    expect((await answered).status()).toBe(201);
    await expect(toast(page, 'Created 3 of 3 links')).toHaveCount(round);
    await expect(page.locator('[data-slot="card"]', { hasText: 'Import Results' })).toContainText('3 created');
    await expect(importButton).toBeEnabled();
  }

  const listed = await rawApi('GET', `/api/projects/${project.id}/links?limit=100`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(listed.body.meta.total).toBe(6);
  const links = listed.body.data as { title: string; longUrl: string; shortCode: string }[];
  for (const title of ['Row one', 'Row two', 'Row three']) {
    const pair = links.filter((link) => link.title === title);
    expect(pair).toHaveLength(2);
    expect(pair[0].longUrl).toBe(pair[1].longUrl);
    expect(pair[0].shortCode).not.toBe(pair[1].shortCode);
  }
});

async function importBrokenAndroidLink(owner: Account, projectId: string, ip: string): Promise<{ id: string; short_code: string }> {
  const result = await bulkImport(owner, projectId, ip, 'longUrl,iosUrl,androidUrl\nhttps://example.com/ok,,not a url');
  expect(result).toEqual({ total: 1, created: 1, errors: [] });
  const [row] = await sql<{ id: string; short_code: string; android_url: string; ios_url: string | null }>(
    'SELECT id, short_code, android_url, ios_url FROM links WHERE project_id = $1',
    [projectId],
  );
  expect([row.android_url, row.ios_url]).toEqual(['not a url', null]);
  return row;
}

test('LINK-229 a bulk-imported invalid Android deep link breaks the Android redirect', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await setProjectApp(project.id, { androidPackageName: 'com.example.app' });
  const link = await importBrokenAndroidLink(owner, project.id, clientIp);

  const android = await openShortLink(link.short_code, newClientIp(), PIXEL_UA);
  expect([android.status, android.body.message]).toEqual([500, 'Internal server error']);
  for (const ua of [IPHONE_UA, DESKTOP_UA]) {
    const other = await openShortLink(link.short_code, newClientIp(), ua);
    expect([other.status, other.location]).toEqual([302, 'https://example.com/ok']);
  }
  await waitForClicks(link.id, 2);
  expect((await clicksOf(link.id)).map((row) => row.platform).sort()).toEqual(['ios', 'macos']);

  await setProjectApp(project.id, { androidPackageName: null });
  const unwrapped = await openShortLink(link.short_code, newClientIp(), PIXEL_UA);
  expect(unwrapped.status).toBe(200);
  expect(scriptValue(unwrapped.body, 'deepLink')).toBe('not a url');
  await waitForClicks(link.id, 3);
});

test('LINK-229 an Android visitor of a bulk-imported link reaches the destination', async ({ clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-229' });
  const { owner, project } = await ownerWithProject(clientIp);
  await setProjectApp(project.id, { androidPackageName: 'com.example.app' });
  const link = await importBrokenAndroidLink(owner, project.id, clientIp);
  const android = await openShortLink(link.short_code, newClientIp(), PIXEL_UA);
  expect([200, 302]).toContain(android.status);
});

const PROJECT_KEYS = [
  'androidPackageName',
  'androidPlayStoreUrl',
  'androidSha256Fingerprints',
  'createdAt',
  'domain',
  'domainVerificationToken',
  'domainVerifiedAt',
  'id',
  'identityKeyVersion',
  'iosAppStoreId',
  'iosAppStoreUrl',
  'iosBundleId',
  'iosTeamId',
  'name',
  'ownerId',
  'pendingBillingOfferedAt',
  'pendingBillingOwnerId',
  'updatedAt',
  'webFallbackUrl',
];

test('LINK-230 GET /api/links/:id embeds the whole project row', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project } = await ownerWithProject(clientIp);
  const member = await addProjectMember(owner, project.id, 'member', clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/embed', title: 'Embedded' });

  const read = await api<{ project: Record<string, unknown> }>('GET', `/api/links/${link.id}`, undefined, { token: member.accessToken, ip: clientIp });
  expect(Object.keys(read.project).sort()).toEqual(PROJECT_KEYS);
  expect(read.project).toMatchObject({ id: project.id, ownerId: owner.userId });
  const patched = await api<{ project: Record<string, unknown> }>('PATCH', `/api/links/${link.id}`, { title: 'x' }, { token: member.accessToken, ip: clientIp });
  expect(Object.keys(patched.project).sort()).toEqual(PROJECT_KEYS);
  const viewAs = await viewAsToken(browser, baseURL, owner);
  const seen = await api<{ project: Record<string, unknown> }>('GET', `/api/links/${link.id}`, undefined, { token: viewAs, ip: clientIp });
  expect(Object.keys(seen.project).sort()).toEqual(PROJECT_KEYS);
  for (const body of [read, patched, seen]) expect(Object.keys(body.project).filter((key) => /secret/i.test(key))).toEqual([]);
});

test('LINK-230 the link API names only the project\'s id and name', async ({ clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-230' });
  const { owner, project } = await ownerWithProject(clientIp);
  const member = await addProjectMember(owner, project.id, 'member', clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/embed' });
  const read = await api<{ project: Record<string, unknown> }>('GET', `/api/links/${link.id}`, undefined, { token: member.accessToken, ip: clientIp });
  expect(Object.keys(read.project).sort()).toEqual(['id', 'name']);
});

test('LINK-231 variant weights are relative, not percentages', async ({ page, clientIp }) => {
  test.slow();
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/orig', shortCode: uniqueCode('ab-rel') });
  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'A/B Testing' }).click();
  expect(await addVariantInPage(page, link.id, { name: 'A', url: 'https://example.com/a', weight: '80' })).toBe(201);
  expect(await addVariantInPage(page, link.id, { name: 'B', url: 'https://example.com/b', weight: '80' })).toBe(201);
  await expect(variantRow(page, 'A')).toContainText('80% traffic');
  await expect(variantRow(page, 'B')).toContainText('80% traffic');
  await expect(page.getByText('Traffic Weight (%)')).toHaveCount(0);

  const counts: Record<string, number> = {};
  for (let batch = 0; batch < 10; batch++) {
    const answers = await Promise.all(Array.from({ length: 20 }, () => openShortLink(link.shortCode, newClientIp())));
    for (const answer of answers) {
      expect(answer.status).toBe(302);
      counts[answer.location!] = (counts[answer.location!] ?? 0) + 1;
    }
  }
  expect(Object.keys(counts).sort()).toEqual(['https://example.com/a', 'https://example.com/b']);
  for (const url of ['https://example.com/a', 'https://example.com/b']) {
    expect(counts[url]).toBeGreaterThanOrEqual(70);
    expect(counts[url]).toBeLessThanOrEqual(130);
  }
  await waitUntil(
    async () => Number((await sql<{ n: string }>('SELECT coalesce(sum(clicks), 0)::text AS n FROM link_variants WHERE link_id = $1', [link.id]))[0].n),
    (n) => n >= 200,
    'the variant counters',
  );
  const stored = await sql<{ name: string; clicks: number }>('SELECT name, clicks FROM link_variants WHERE link_id = $1 ORDER BY name', [link.id]);
  expect(stored).toEqual([
    { name: 'A', clicks: counts['https://example.com/a'] },
    { name: 'B', clicks: counts['https://example.com/b'] },
  ]);
});

test('LINK-232 variant name with HTML is shown as text', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/xss', title: 'Variant text' });
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const name = '<img src=x onerror=alert(1)>';

  // A URL with raw markup is not a URL to the API.
  const refused = await rawApi('POST', `/api/links/${link.id}/variants`, { name, longUrl: 'https://example.com/"><b>x</b>' }, { token: owner.accessToken, ip: clientIp });
  expect([refused.status, refused.body.message]).toEqual([400, ['longUrl must be a URL address']]);

  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'A/B Testing' }).click();
  const url = 'https://example.com/%22%3E%3Cb%3Ex%3C/b%3E';
  expect(await addVariantInPage(page, link.id, { name, url, weight: '50' })).toBe(201);
  const row = variantRow(page, name);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(url);
  await expect(row.locator('img')).toHaveCount(0);
  await expect(row.locator('b')).toHaveCount(0);
  expect(dialogs).toEqual([]);
  const entries = await activityEntries(project.id, 'link.changed');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ target_label: 'Variant text', details: { change: 'added', variant: name } });
});

async function trashOf(page: Page, name: string) {
  return variantRow(page, name).getByRole('button');
}

test('LINK-234 deleting a variant that fails shows nothing', async ({ page, browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/fail-del', title: 'Failing delete' });
  const variant = await seedVariant(owner, link.id, clientIp, { name: 'B', longUrl: 'https://example.com/b', weight: 50 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await signIn(page, owner);
  await page.route('**/api/links/*/variants/*', (route) =>
    route.request().method() === 'DELETE' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"statusCode":500,"message":"Internal server error"}' }) : route.continue(),
  );
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'A/B Testing' }).click();
  const failed = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/variants/${variant.id}`));
  await (await trashOf(page, 'B')).click();
  expect((await failed).status()).toBe(500);
  await page.waitForTimeout(1000);
  await expect(toasts(page)).toHaveCount(0);
  await expect(variantRow(page, 'B')).toHaveCount(1);
  expect(errors).toEqual([]);

  const viewAs = await openViewAs(browser, baseURL, await startViewAs(browser, baseURL, owner));
  await openDetail(viewAs, project.id, link.id);
  await viewAs.getByRole('tab', { name: 'A/B Testing' }).click();
  const refused = viewAs.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/variants/${variant.id}`));
  await (await trashOf(viewAs, 'B')).click();
  const answer = await refused;
  expect([answer.status(), ((await answer.json()) as { message: string }).message]).toEqual([403, READ_ONLY]);
  await expect(toast(viewAs, 'Read-only session')).toBeVisible();
  await expect(toasts(viewAs)).toHaveCount(1);
  await expect(variantRow(viewAs, 'B')).toHaveCount(1);
  await viewAs.context().close();
  expect(await sql('SELECT id FROM link_variants WHERE link_id = $1', [link.id])).toEqual([{ id: variant.id }]);
});

test('LINK-234 a failed variant delete says so', async ({ page, clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-234' });
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/fail-del' });
  const variant = await seedVariant(owner, link.id, clientIp, { name: 'B', longUrl: 'https://example.com/b', weight: 50 });
  await signIn(page, owner);
  await page.route('**/api/links/*/variants/*', (route) =>
    route.request().method() === 'DELETE' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"statusCode":500,"message":"Internal server error"}' }) : route.continue(),
  );
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'A/B Testing' }).click();
  const failed = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/variants/${variant.id}`));
  await (await trashOf(page, 'B')).click();
  await failed;
  await expect(toasts(page)).toHaveCount(1, { timeout: 5000 });
});

test('LINK-242 map shows sample markers when there are no points', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/pune', shortCode: uniqueCode('pune') });
  for (let i = 0; i < 3; i++) await seedClickRow(link.id, { city: 'Pune', region: 'MH', country: 'IN', country_code: 'IN', ip_address: newClientIp() });

  await stubMapTiles(page);
  await signIn(page, owner);
  await openDetail(page, project.id, link.id);
  await page.getByRole('tab', { name: 'Geography' }).click();
  const rows = page.getByRole('table').locator('tbody').getByRole('row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByRole('cell')).toHaveText(['1', /^Maharashtra\s*MH • IN$/, '3', '100.0%']);

  const markers = page.locator('path.leaflet-interactive');
  await expect(markers).toHaveCount(12);
  await expect(page.getByText('Sample data', { exact: true })).toBeVisible();
  // Moscow (the ninth sample point) stands apart from its neighbours near the map's centre.
  await markers.nth(8).hover();
  await expect(page.locator('.geo-tooltip')).toHaveText(/Moscow\s*RU\s*8 clicks/);
});

// ---- Q5. Expiry and time zones

test.describe('API on UTC', () => {
  let utc: ExtraApi;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    utc = await startApiInZone('UTC');
  });
  test.afterAll(async () => {
    await utc?.stop();
  });

  test('LINK-243 expiry set in a non-UTC browser, API in UTC', async ({ browser, baseURL }) => {
    const ip = newClientIp();
    const context: BrowserContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, timezoneId: 'Asia/Kolkata', extraHTTPHeaders: { 'X-Forwarded-For': ip } });
    const page = await context.newPage();
    await routeApiTo(page, utc.url);
    const { owner, project } = await ownerWithProject(ip);

    // Tomorrow as the person in India reads the calendar.
    const tomorrowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000 + DAY_MS).toISOString().slice(0, 10);
    const value = `${tomorrowIst}T10:00`;
    await signIn(page, owner);
    await page.goto(`/projects/${project.id}/links/new`);
    await page.getByLabel('Destination URL').fill('https://example.com/zone');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('input[type=datetime-local]').fill(value);
    const sent = page.waitForRequest((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.method() === 'POST');
    const created = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create Link' }).click();
    expect(((await sent).postDataJSON() as { expiresAt: string }).expiresAt).toBe(value);
    const link = ((await (await created).json()) as { data: { id: string; shortCode: string } }).data;

    const [stored] = await sql<{ at: string }>(`SELECT to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS at FROM links WHERE id = $1`, [link.id]);
    expect(stored.at).toBe(`${value}:00`);
    const read = await fetch(`${utc.url}/api/links/${link.id}`, { headers: { Authorization: `Bearer ${owner.accessToken}`, 'X-Forwarded-For': ip } });
    expect(((await read.json()) as { data: { expiresAt: string } }).data.expiresAt).toBe(`${value}:00.000Z`);

    await expect(labelledBlock(page, 'Expires')).toContainText(shortDate(new Date(`${value}:00.000Z`)));
    await page.goto(`/projects/${project.id}/links/${link.id}/edit`);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('input[type=datetime-local]')).toHaveValue(value);

    // An hour before "now" on an Indian wall clock is still hours away to an API on UTC.
    await sql(`UPDATE links SET expires_at = (now() AT TIME ZONE 'Asia/Kolkata') - interval '60 minutes' WHERE id = $1`, [link.id]);
    const live = await openShortLinkOn(utc.url, link.shortCode, newClientIp());
    expect([live.status, live.location]).toEqual([302, 'https://example.com/zone']);
    await page.goto(`/projects/${project.id}/links`);
    await expect(linkRows(page).first()).toContainText('Active');

    // A minute before "now" on a UTC wall clock is past.
    await sql(`UPDATE links SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [link.id]);
    const gone = await openShortLinkOn(utc.url, link.shortCode, newClientIp());
    expect([gone.status, gone.body.message]).toEqual([404, 'Link has expired']);
    await page.reload();
    await expect(linkRows(page).first()).toContainText('Expired');
    await context.close();
  });
});

test.describe('API on Indian time', () => {
  test.describe.configure({ mode: 'default' });
  let ist: ExtraApi;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    ist = await startApiInZone('Asia/Kolkata');
  });
  test.afterAll(async () => {
    await ist?.stop();
  });

  /** A link whose stored expiry is `<date> 10:00:00`, ten days out. */
  async function zonedLink(ip: string) {
    const { owner, project } = await ownerWithProject(ip);
    const link = await seedLink(owner, project.id, ip, { longUrl: 'https://example.com/ist', shortCode: uniqueCode('ist') });
    const date = new Date(Date.now() + 10 * DAY_MS).toISOString().slice(0, 10);
    await sql(`UPDATE links SET expires_at = $2::timestamp WHERE id = $1`, [link.id, `${date} 10:00:00`]);
    return { owner, project, link, date };
  }

  async function storedExpiry(linkId: string): Promise<string> {
    const [row] = await sql<{ at: string }>(`SELECT to_char(expires_at, 'YYYY-MM-DD HH24:MI:SS') AS at FROM links WHERE id = $1`, [linkId]);
    return row.at;
  }

  test('LINK-244 the link API reads a stored expiry in its own zone', async ({ clientIp }) => {
    const { owner, link, date } = await zonedLink(clientIp);
    const read = await fetch(`${ist.url}/api/links/${link.id}`, { headers: { Authorization: `Bearer ${owner.accessToken}`, 'X-Forwarded-For': clientIp } });
    expect(((await read.json()) as { data: { expiresAt: string } }).data.expiresAt).toBe(`${date}T04:30:00.000Z`);
    expect(await storedExpiry(link.id)).toBe(`${date} 10:00:00`);
  });

  test('LINK-244 saving an untouched edit form keeps the expiry', async ({ page, clientIp }) => {
    test.fail();
    test.info().annotations.push({ type: 'issue', description: 'LINK-244' });
    const { owner, project, link, date } = await zonedLink(clientIp);
    await routeApiTo(page, ist.url);
    await signIn(page, owner);
    await openEdit(page, project.id, link);
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/links/${link.id}`);
    await page.getByRole('button', { name: 'Save Changes' }).click();
    expect((await saved).status()).toBe(200);
    expect(await storedExpiry(link.id)).toBe(`${date} 10:00:00`);
    const fields = (await activityEntries(project.id, 'link.changed')).flatMap((entry) => (entry.details?.fields as string[] | undefined) ?? []);
    expect(fields).not.toContain('expiresAt');
  });
});

// ---- Q6. Click export

test('LINK-249 export gives client IP addresses to every role', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const member = await addProjectMember(owner, project.id, 'member', clientIp);
  const admin = await addProjectMember(owner, project.id, 'admin', clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/ips', shortCode: uniqueCode('ips') });
  for (const ip of ['203.0.113.7', '2001:db8::7']) expect((await openShortLink(link.shortCode, ip)).status).toBe(302);
  await waitForClicks(link.id, 2);

  for (const person of [member, admin]) {
    const answer = await rawApi('GET', `/api/links/${link.id}/analytics/export`, undefined, { token: person.accessToken, ip: clientIp });
    expect(answer.status).toBe(200);
    const [header, ...rows] = parseCsv(String(answer.body));
    const column = header.indexOf('ip_address');
    expect(column).toBe(2);
    expect(rows.map((row) => row[column]).sort()).toEqual(['2001:db8::7', '203.0.113.7']);
  }
});

// ---- Q7. Redirect input edges

function referer(length: number): string {
  const base = 'https://r.example/';
  return base + 'p'.repeat(length - base.length);
}

test('LINK-250 an over-long Referer loses the click', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/long-ref', shortCode: uniqueCode('long-ref') });
  const tooLong = await openShortLinkWith(link.shortCode, newClientIp(), { Referer: referer(2049) });
  expect([tooLong.status, tooLong.location]).toEqual([302, 'https://example.com/long-ref']);
  const fits = await openShortLinkWith(link.shortCode, newClientIp(), { Referer: referer(2048) });
  expect([fits.status, fits.location]).toEqual([302, 'https://example.com/long-ref']);

  await waitForClicks(link.id, 1);
  await waitForTouchpoints(link.id, 1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect([await countClicks(link.id), await countTouchpoints(link.id)]).toEqual([1, 1]);
  const [click] = await sql<{ referrer: string }>('SELECT referrer FROM click_events WHERE link_id = $1', [link.id]);
  expect(click.referrer).toBe(referer(2048));
  const summary = await api<{ totalClicks: number }>('GET', `/api/links/${link.id}/analytics`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(summary.totalClicks).toBe(1);
});

test('LINK-250 an over-long Referer keeps the click', async ({ clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-250' });
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/long-ref', shortCode: uniqueCode('long-ref') });
  expect((await openShortLinkWith(link.shortCode, newClientIp(), { Referer: referer(2049) })).status).toBe(302);
  await waitForClicks(link.id, 1, 5000);
  await waitForTouchpoints(link.id, 1);
});

async function utmLinks(owner: Account, projectId: string, ip: string) {
  const make = (name: string) => seedLink(owner, projectId, ip, { longUrl: `https://example.com/${name}`, shortCode: uniqueCode(`utm-${name}`) });
  return {
    source100: await make('s100'),
    source101: await make('s101'),
    medium256: await make('m256'),
    campaign256: await make('c256'),
    term256: await make('t256'),
    content256: await make('ct256'),
  };
}

test('LINK-251 over-long UTM values lose the touchpoint but keep the click', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const links = await utmLinks(owner, project.id, clientIp);
  const queries: [SeededLink, string][] = [
    [links.source101, `utm_source=${'s'.repeat(101)}`],
    [links.medium256, `utm_medium=${'m'.repeat(256)}`],
    [links.campaign256, `utm_campaign=${'c'.repeat(256)}`],
    [links.term256, `utm_term=${'t'.repeat(256)}`],
    [links.content256, `utm_content=${'n'.repeat(256)}`],
    [links.source100, `utm_source=${'s'.repeat(100)}`],
  ];
  for (const [link, query] of queries) {
    const answer = await openShortLink(`${link.shortCode}?${query}`, newClientIp());
    expect([answer.status, answer.location]).toEqual([302, link.longUrl]);
  }
  for (const [link] of queries) await waitForClicks(link.id, 1);
  await waitForTouchpoints(links.source100.id, 1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await sql('SELECT utm_source, channel FROM touchpoints WHERE link_id = $1', [links.source100.id])).toEqual([
    { utm_source: 's'.repeat(100), channel: 's'.repeat(100) },
  ]);
  for (const [link] of queries.slice(0, 5)) expect([link.shortCode, await countTouchpoints(link.id)]).toEqual([link.shortCode, 0]);
  for (const [link] of queries) expect(await countClicks(link.id)).toBe(1);
});

test('LINK-251 over-long UTM values keep the touchpoint', async ({ clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-251' });
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/s101', shortCode: uniqueCode('utm-s101') });
  expect((await openShortLink(`${link.shortCode}?utm_source=${'s'.repeat(101)}`, newClientIp())).status).toBe(302);
  await waitForClicks(link.id, 1);
  await waitUntil(() => countTouchpoints(link.id), (n) => n >= 1, 'the touchpoint', 5000);
});

test('LINK-255 association files with an upper-case or trailing-dot Host', async ({ clientIp }) => {
  const { project } = await ownerWithProject(clientIp);
  const host = uniqueHost('links');
  await setProjectApp(project.id, {
    domain: host,
    verified: true,
    iosTeamId: 'ABCDE12345',
    iosBundleId: 'com.example.app',
    androidPackageName: 'com.example.app',
    androidSha256Fingerprints: 'AA:BB, CC:DD',
  });

  // The control: the host as stored names the app in both files.
  const aasa = await wellKnown('apple-app-site-association', host, clientIp);
  expect((aasa.body as { applinks: { details: unknown[] } }).applinks.details).toHaveLength(1);
  const assets = await wellKnown('assetlinks.json', host, clientIp);
  expect(assets.body).toHaveLength(1);

  const upper = host.replace(/^links/, 'Links').replace(/example\.test$/, 'Example.Test');
  for (const variant of [upper, `${host}.`, upper.toUpperCase()]) {
    const apple = await wellKnown('apple-app-site-association', variant, clientIp);
    expect([variant, apple.status, apple.body]).toEqual([variant, 200, EMPTY_AASA]);
    const android = await wellKnown('assetlinks.json', variant, clientIp);
    expect([variant, android.status, android.body]).toEqual([variant, 200, []]);
  }

  const platformHost = new URL(stackEnv().APP_URL).hostname.toUpperCase();
  expect((await wellKnown('apple-app-site-association', platformHost, clientIp)).body).toEqual(EMPTY_AASA);
  expect((await wellKnown('assetlinks.json', platformHost, clientIp)).body).toEqual([]);
});

// ---- Q8. Suspension and link management

test('LINK-257 members keep managing links while the billing owner is suspended', async ({ page, clientIp }) => {
  test.slow();
  const { owner, project } = await ownerWithProject(clientIp);
  const member = await addProjectMember(owner, project.id, 'member', clientIp);
  const admin = await addProjectMember(owner, project.id, 'admin', clientIp);
  const l1 = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/l1', shortCode: uniqueCode('l1'), title: 'L1' });
  const l2 = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/l2', shortCode: uniqueCode('l2'), title: 'L2', isActive: false });
  const doomedByMember = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/d1', title: 'Doomed one' });
  const doomedByAdmin = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/d2', title: 'Doomed two' });
  expect((await openShortLink(l1.shortCode, newClientIp())).status).toBe(302);
  await waitForClicks(l1.id, 1);
  await setSuspended(owner.userId, true);

  try {
    // As the member, in the dashboard: the list, a new link and an edit.
    await signIn(page, member);
    await page.goto(`/projects/${project.id}/links`);
    await expect(linkRows(page).filter({ hasText: 'L1' })).toHaveCount(1);
    await page.goto(`/projects/${project.id}/links/new`);
    const duringCode = uniqueCode('during');
    await page.getByLabel('Destination URL').fill('https://example.com/during');
    await page.getByLabel('Title').fill('During');
    await page.getByLabel('Custom short link').fill(duringCode);
    await page.getByRole('button', { name: 'Create Link' }).click();
    await expect(toast(page, 'Link created')).toBeVisible();
    await openEdit(page, project.id, l1);
    await page.getByPlaceholder('https://example.com/page').fill('https://example.com/l1-member');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(toast(page, 'Link updated')).toBeVisible();

    // The rest as the member and as the admin, through the API.
    const steps = async (person: Account, label: string, doomed: SeededLink) => {
      const as = (method: string, urlPath: string, body?: unknown) => rawApi(method, urlPath, body, { token: person.accessToken, ip: clientIp });
      const statuses = [
        (await as('POST', `/api/projects/${project.id}/links`, { longUrl: `https://example.com/${label}-new`, title: `${label} new` })).status,
        (await as('PATCH', `/api/links/${l1.id}`, { longUrl: `https://example.com/l1-${label}-api` })).status,
        (await as('POST', `/api/links/${l1.id}/variants`, { name: `${label} variant`, longUrl: `https://example.com/l1-${label}-v`, weight: 50 })).status,
        (await as('GET', `/api/links/${l1.id}/analytics/export`)).status,
        (await rawBulkImport(person.accessToken, project.id, clientIp, { content: `longUrl,title\nhttps://example.com/${label}-bulk,${label} bulk` })).status,
        (await as('DELETE', `/api/links/${doomed.id}`)).status,
      ];
      expect([label, statuses]).toEqual([label, [201, 200, 201, 200, 201, 200]]);
    };
    await steps(member, 'member', doomedByMember);
    await steps(admin, 'admin', doomedByAdmin);

    const changed = await sql<{ actor_user_id: string; target_id: string }>(
      `SELECT actor_user_id, target_id FROM project_activity WHERE project_id = $1 AND action = 'link.changed' ORDER BY occurred_at`,
      [project.id],
    );
    expect(changed.filter((row) => row.actor_user_id === member.userId).map((row) => row.target_id)).toEqual([l1.id, l1.id, l1.id]);
    expect(changed.filter((row) => row.actor_user_id === admin.userId).map((row) => row.target_id)).toEqual([l1.id, l1.id]);
    const deletions = await sql<{ actor_user_id: string; target_id: string }>(
      `SELECT actor_user_id, target_id FROM project_activity WHERE project_id = $1 AND action = 'content.deleted' ORDER BY occurred_at`,
      [project.id],
    );
    expect(deletions).toEqual([
      { actor_user_id: member.userId, target_id: doomedByMember.id },
      { actor_user_id: admin.userId, target_id: doomedByAdmin.id },
    ]);

    // The billing owner is refused.
    const own = await rawApi('GET', `/api/projects/${project.id}/links`, undefined, { token: owner.accessToken, ip: clientIp });
    expect([own.status, own.body.message]).toEqual([403, 'Account suspended']);

    // Visitors.
    for (const code of [l1.shortCode, duringCode]) {
      const unavailable = await openShortLink(code, newClientIp());
      expect([code, unavailable.status, unavailable.headers.get('content-type')]).toEqual([code, 404, 'text/html; charset=utf-8']);
      expect(String(unavailable.body)).toContain('<title>Link unavailable</title>');
    }
    const inactive = await openShortLink(l2.shortCode, newClientIp());
    expect([inactive.status, inactive.body.message]).toEqual([404, 'Link is no longer active']);
    const preview = await rawApi('GET', `/api/${l1.shortCode}/preview`, undefined, { ip: newClientIp() });
    expect([preview.status, preview.body.message]).toEqual([404, 'Link is no longer active']);
    expect(await countClicks(l1.id)).toBe(1);
  } finally {
    await setSuspended(owner.userId, false);
  }
});

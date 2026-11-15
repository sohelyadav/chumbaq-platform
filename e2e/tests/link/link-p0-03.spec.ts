import { hostOf } from '../../../apps/api/src/common/platform-hosts';
import { api, apiUrl, createAccount, createProject, newClientIp, type Account, type Project } from '../../support/api';
import { mobileContext } from '../../support/browser-tools';
import { expect, test } from '../../support/fixtures';
import { stackEnv } from '../../support/stack';
import {
  backdateClick,
  bulkImport,
  clickFrom,
  clicksOf,
  conversionRows,
  deferredMatch,
  IPHONE_UA,
  newApiKey,
  openShortLink,
  PIXEL_UA,
  rawApi,
  seedLink,
  seedObjection,
  setProjectApp,
  setSuspended,
  sql,
  storedLinks,
  stubHosts,
  uniqueCode,
  uniqueHost,
  waitForClicks,
  waitUntil,
  wellKnown,
} from '../../support/areas/link';

/**
 * Links: the public preview, the app association files, deferred deep-link matching,
 * conversions recorded by the SDK, the dashboard's catch-all short-code page with odd
 * paths, and bulk-imported links whose URLs are not web addresses.
 */

const SERVER_ONLY_KEY =
  'This is a server-only privacy key and cannot be used by an app or SDK. Use an ordinary API key in your app.';
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

const IOS_APP = { iosTeamId: 'ABCDE12345', iosBundleId: 'com.example.app' };
const ANDROID_APP = { androidPackageName: 'com.example.app', androidSha256Fingerprints: 'AA:BB, CC:DD' };

function aasaFor(teamId: string, bundleId: string) {
  return {
    applinks: { details: [{ appIDs: [`${teamId}.${bundleId}`], components: [{ '/': '/*', comment: 'Match all short links' }] }] },
    webcredentials: { apps: [] },
  };
}

async function matchedOf(clickId: string): Promise<boolean> {
  const [row] = await sql<{ matched: boolean }>('SELECT matched FROM click_events WHERE id = $1', [clickId]);
  return row.matched;
}

function messages(body: { message?: string | string[] }): string[] {
  return Array.isArray(body.message) ? body.message : [String(body.message)];
}

// ---- L. Link preview

test('LINK-185 preview refused like the redirect', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const live = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/live-preview', shortCode: uniqueCode('pv-live') });
  const inactive = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/off-preview', shortCode: uniqueCode('pv-off'), isActive: false });
  const expired = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/expired-preview',
    shortCode: uniqueCode('pv-exp'),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const tenant = await ownerWithProject(clientIp, 'suspended');
  const suspended = await seedLink(tenant.owner, tenant.project.id, clientIp, { longUrl: 'https://example.com/susp-preview', shortCode: uniqueCode('pv-susp') });
  const preview = (code: string) => rawApi('GET', `/${code}/preview`, undefined, { ip: newClientIp() });

  // The control: a live link's preview carries its destination.
  const ok = await preview(live.shortCode);
  expect([ok.status, ok.body.data?.longUrl]).toEqual([200, 'https://example.com/live-preview']);

  await setSuspended(tenant.owner.userId, true);
  try {
    const unknown = await preview(uniqueCode('pv-none'));
    expect([unknown.status, unknown.body.message]).toEqual([404, 'Link not found']);
    for (const link of [inactive, expired, suspended]) {
      const refused = await preview(link.shortCode);
      expect([link.shortCode, refused.status, refused.body.message]).toEqual([link.shortCode, 404, 'Link is no longer active']);
      expect(JSON.stringify(refused.body)).not.toContain(link.longUrl);
    }
  } finally {
    await setSuspended(tenant.owner.userId, false);
  }
});

// ---- M. App association files

test('LINK-186 Apple app site association for a verified domain', async ({ clientIp }) => {
  const { project } = await ownerWithProject(clientIp);
  const host = uniqueHost('links');
  await setProjectApp(project.id, { domain: host, verified: true, ...IOS_APP });

  const expected = aasaFor('ABCDE12345', 'com.example.app');
  for (const header of [host, `${host}:443`]) {
    const answer = await wellKnown('apple-app-site-association', header, clientIp);
    expect(answer.status).toBe(200);
    expect(answer.contentType).toMatch(/^application\/json\b/);
    // Not wrapped in the API's { data } envelope, and in the exact form Apple reads.
    expect(answer.text).toBe(JSON.stringify(expected));
    expect(answer.body).toEqual(expected);
  }
  // Another host names nobody.
  expect((await wellKnown('apple-app-site-association', uniqueHost('other'), clientIp)).body).toEqual(EMPTY_AASA);
});

test('LINK-187 association files name nobody for the platform\'s own hosts', async ({ clientIp }) => {
  const env = stackEnv();
  const variables = ['APP_URL', 'API_BASE_URL', 'SHORT_LINK_DOMAIN', 'ADMIN_APP_URL'];
  const headers = new Map<string, string[]>();
  for (const name of variables) {
    const value = env[name];
    expect(value, `${name} is set for the stack`).toBeTruthy();
    const host = hostOf(value)!;
    const withPort = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? new URL(value).host : value;
    headers.set(host, [...new Set([...(headers.get(host) ?? [host]), withPort])]);
  }

  const owner = await createAccount(clientIp, 'platform-host', 'Pat Platform');
  const seeded: string[] = [];
  try {
    for (const [host, hostHeaders] of headers) {
      const project = await createProject(owner, clientIp);
      seeded.push(project.id);
      // The control: the same project, on a domain of its own, is named.
      const own = uniqueHost('own');
      await setProjectApp(project.id, { domain: own, verified: true, ...IOS_APP, ...ANDROID_APP });
      expect((await wellKnown('apple-app-site-association', own, clientIp)).body).toEqual(aasaFor('ABCDE12345', 'com.example.app'));
      expect(await wellKnown('assetlinks.json', own, clientIp)).toMatchObject({ status: 200, body: [expect.objectContaining({ relation: ['delegate_permission/common.handle_all_urls'] })] });

      // The platform's host, proved, as only SQL can leave it.
      await setProjectApp(project.id, { domain: host, verified: true });
      // The claim the files must ignore is really there: without the platform-host rule it would be named.
      expect(await sql('SELECT domain, domain_verified_at IS NOT NULL AS verified FROM projects WHERE id = $1', [project.id])).toEqual([{ domain: host, verified: true }]);
      for (const header of hostHeaders) {
        const aasa = await wellKnown('apple-app-site-association', header, clientIp);
        expect([header, aasa.status, aasa.body]).toEqual([header, 200, EMPTY_AASA]);
        const assetLinks = await wellKnown('assetlinks.json', header, clientIp);
        expect([header, assetLinks.status, assetLinks.body]).toEqual([header, 200, []]);
      }
    }
  } finally {
    for (const id of seeded) await setProjectApp(id, { domain: 'e2e.example.test', verified: false });
  }
});

test('LINK-188 association files need a proved, live domain', async ({ clientIp }) => {
  const unproved = await ownerWithProject(clientIp, 'unproved');
  const unprovedHost = uniqueHost('unproved');
  await setProjectApp(unproved.project.id, { domain: unprovedHost, verified: false, ...IOS_APP, ...ANDROID_APP });
  const proved = await ownerWithProject(clientIp, 'proved');
  const provedHost = uniqueHost('links');
  await setProjectApp(proved.project.id, { domain: provedHost, verified: true, ...IOS_APP, ...ANDROID_APP });

  const both = async (host: string) => [
    (await wellKnown('apple-app-site-association', host, clientIp)).body,
    (await wellKnown('assetlinks.json', host, clientIp)).body,
  ];
  expect(await both(unprovedHost)).toEqual([EMPTY_AASA, []]);

  // The control: the proved domain is named while its owner is active.
  const [aasa, assetLinks] = await both(provedHost);
  expect(aasa).toEqual(aasaFor('ABCDE12345', 'com.example.app'));
  expect(assetLinks).toHaveLength(1);

  await setSuspended(proved.owner.userId, true);
  try {
    expect(await both(provedHost)).toEqual([EMPTY_AASA, []]);
  } finally {
    await setSuspended(proved.owner.userId, false);
  }
  expect(await both(uniqueHost('unknown'))).toEqual([EMPTY_AASA, []]);
});

test('LINK-190 Android asset links', async ({ clientIp }) => {
  const { project } = await ownerWithProject(clientIp);
  const host = uniqueHost('links');
  await setProjectApp(project.id, { domain: host, verified: true, androidPackageName: 'com.example.app', androidSha256Fingerprints: 'AA:BB, CC:DD,' });

  const answer = await wellKnown('assetlinks.json', host, clientIp);
  expect(answer.status).toBe(200);
  expect(answer.contentType).toMatch(/^application\/json\b/);
  expect(answer.text).toBe(
    JSON.stringify([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'com.example.app', sha256_cert_fingerprints: ['AA:BB', 'CC:DD'] },
      },
    ]),
  );

  await setProjectApp(project.id, { androidPackageName: null });
  expect(await wellKnown('assetlinks.json', host, clientIp)).toMatchObject({ status: 200, body: [] });
});

// ---- N. Deferred deep-link match

test('LINK-191 deferred match needs a valid ordinary API key', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const revoked = await newApiKey(owner, project.id, clientIp, { name: 'Old key' });
  await api('DELETE', `/api/projects/${project.id}/api-keys/${revoked.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  const privacy = await newApiKey(owner, project.id, clientIp, { name: 'Backend privacy', permissions: ['privacy'] });
  const body = { cookieRef: uniqueCode('nothing') };

  const ok = await deferredMatch(key, clientIp, body);
  expect([ok.status, ok.body]).toEqual([201, { data: { matched: false } }]);
  const none = await deferredMatch(undefined, clientIp, body);
  expect([none.status, none.body.message]).toEqual([401, 'API key is required']);
  const wrong = await deferredMatch('wrong', clientIp, body);
  expect([wrong.status, wrong.body.message]).toEqual([401, 'Invalid or expired API key']);
  const gone = await deferredMatch(revoked.fullKey, clientIp, body);
  expect([gone.status, gone.body.message]).toEqual([401, 'Invalid or expired API key']);
  const server = await deferredMatch(privacy.fullKey, clientIp, body);
  expect([server.status, server.body.message]).toEqual([403, SERVER_ONLY_KEY]);
});

test('LINK-192 match by short code from the clicking address', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/promo', shortCode: uniqueCode('dm-1'), deepLinkParams: { screen: 'promo' } });
  const phone = newClientIp();
  const clickId = await clickFrom(link, phone, IPHONE_UA);
  await backdateClick(clickId, 10);

  const first = await deferredMatch(key, phone, { cookieRef: link.shortCode });
  expect(first.status).toBe(201);
  expect(first.body).toEqual({ data: { matched: true, linkId: link.id, shortCode: link.shortCode, params: { screen: 'promo' } } });
  expect(await matchedOf(clickId)).toBe(true);
  const summary = await api<{ matchedInstalls: number }>('GET', `/api/links/${link.id}/analytics`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(summary.matchedInstalls).toBe(1);

  // The click is spent.
  const again = await deferredMatch(key, phone, { cookieRef: link.shortCode });
  expect([again.status, again.body]).toEqual([201, { data: { matched: false } }]);
});

test('LINK-193 short code alone from another address does not match', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/dm2', shortCode: uniqueCode('dm-2'), deepLinkParams: { screen: 'two' } });
  const clicker = newClientIp();
  const clickId = await clickFrom(link, clicker, IPHONE_UA);

  const stranger = await deferredMatch(key, newClientIp(), { cookieRef: link.shortCode });
  expect([stranger.status, stranger.body]).toEqual([201, { data: { matched: false } }]);
  expect(await matchedOf(clickId)).toBe(false);

  // The control: the clicking address itself still claims it.
  const own = await deferredMatch(key, clicker, { cookieRef: link.shortCode });
  expect(own.body.data).toMatchObject({ matched: true, linkId: link.id });
});

test('LINK-194 an IP in the body is refused', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/ip', shortCode: uniqueCode('dm-ip'), iosUrl: 'https://example.com/app/ip' });
  const victim = newClientIp();
  const clickId = await clickFrom(link, victim, IPHONE_UA);

  for (const body of [{ fingerprint: { os: 'iOS 17', ip: victim } }, { ip: victim, cookieRef: link.shortCode }]) {
    const refused = await deferredMatch(key, newClientIp(), body);
    expect(refused.status).toBe(400);
    expect(messages(refused.body).some((message) => message.includes('property ip should not exist'))).toBe(true);
  }
  expect(await matchedOf(clickId)).toBe(false);
});

test('LINK-195 short code of another project\'s link', async ({ clientIp }) => {
  const p1 = await sdkProject(clientIp, 'p1');
  const p2 = await ownerWithProject(clientIp, 'p2');
  const foreign = await seedLink(p2.owner, p2.project.id, clientIp, { longUrl: 'https://example.com/p2', shortCode: uniqueCode('p2-link'), iosUrl: 'https://example.com/app/p2', deepLinkParams: { secret: 'p2' } });
  const own = await seedLink(p1.owner, p1.project.id, clientIp, { longUrl: 'https://example.com/p1', shortCode: uniqueCode('p1-link'), iosUrl: 'https://example.com/app/p1' });
  const phone = newClientIp();
  const foreignClick = await clickFrom(foreign, phone, IPHONE_UA);
  // A click of P1's own the fingerprint path would claim, were it tried.
  const ownClick = await clickFrom(own, phone, IPHONE_UA);

  const answer = await deferredMatch(p1.key, phone, { cookieRef: foreign.shortCode, fingerprint: { os: 'iOS' } });
  expect([answer.status, answer.body]).toEqual([201, { data: { matched: false } }]);
  expect(await matchedOf(foreignClick)).toBe(false);
  expect(await matchedOf(ownClick)).toBe(false);

  // The control: the fingerprint alone does claim P1's click.
  const fingerprintOnly = await deferredMatch(p1.key, phone, { fingerprint: { os: 'iOS' } });
  expect(fingerprintOnly.body.data).toMatchObject({ matched: true, linkId: own.id });
  expect(await matchedOf(foreignClick)).toBe(false);
});

test('LINK-197 match by fingerprint and platform', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const ios = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/ios', shortCode: uniqueCode('fp-ios'), iosUrl: 'https://example.com/app/ios', deepLinkParams: { screen: 'ios' } });
  const android = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/and', shortCode: uniqueCode('fp-and'), androidUrl: 'https://example.com/app/and', deepLinkParams: { screen: 'android' } });
  const address = newClientIp();
  const iosClick = await clickFrom(ios, address, IPHONE_UA);
  await backdateClick(iosClick, 2);
  const androidClick = await clickFrom(android, address, PIXEL_UA);
  await backdateClick(androidClick, 1);
  expect([(await clicksOf(ios.id))[0].redirect_type, (await clicksOf(android.id))[0].redirect_type]).toEqual(['app_deeplink', 'app_deeplink']);

  const answer = await deferredMatch(key, address, { fingerprint: { os: 'iOS 17.2', model: 'iPhone15,2', screenWidth: 390, screenHeight: 844 } });
  expect([answer.status, answer.body]).toEqual([201, { data: { matched: true, linkId: ios.id, shortCode: ios.shortCode, params: { screen: 'ios' } } }]);
  expect(await matchedOf(iosClick)).toBe(true);
  expect(await matchedOf(androidClick)).toBe(false);
});

test('LINK-198 fingerprint match ignores desktop clicks and other projects', async ({ clientIp }) => {
  const p1 = await sdkProject(clientIp, 'p1');
  const p2 = await sdkProject(clientIp, 'p2');
  const desktop = await seedLink(p1.owner, p1.project.id, clientIp, { longUrl: 'https://example.com/desk', shortCode: uniqueCode('fp-desk') });
  const foreign = await seedLink(p2.owner, p2.project.id, clientIp, { longUrl: 'https://example.com/p2', shortCode: uniqueCode('fp-p2'), iosUrl: 'https://example.com/app/p2' });
  const address = newClientIp();
  const desktopClick = await clickFrom(desktop, address);
  const foreignClick = await clickFrom(foreign, address, IPHONE_UA);
  expect((await clicksOf(desktop.id))[0].redirect_type).toBe('web_fallback');

  const answer = await deferredMatch(p1.key, address, { fingerprint: { os: 'iOS' } });
  expect([answer.status, answer.body]).toEqual([201, { data: { matched: false } }]);
  expect(await matchedOf(desktopClick)).toBe(false);
  expect(await matchedOf(foreignClick)).toBe(false);

  // The control: P2's own key does claim its click.
  const p2Answer = await deferredMatch(p2.key, address, { fingerprint: { os: 'iOS' } });
  expect(p2Answer.body.data).toMatchObject({ matched: true, linkId: foreign.id });
});

// ---- O. Conversions

test('LINK-204 record a conversion by short code', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/conv', shortCode: uniqueCode('conv-1') });
  const older = await clickFrom(link, newClientIp());
  await backdateClick(older, 5);
  const newest = await clickFrom(link, newClientIp());

  const answer = await rawApi(
    'POST',
    '/api/conversions',
    { shortCode: link.shortCode, eventType: 'signup', externalUserId: 'u-1', metadata: { plan: 'pro' } },
    { apiKey: key, ip: clientIp },
  );
  expect(answer.status).toBe(201);
  expect(answer.body.data).toMatchObject({
    id: expect.any(String),
    linkId: link.id,
    clickEventId: newest,
    eventType: 'signup',
    externalUserId: 'u-1',
    metadata: { plan: 'pro' },
  });
  expect(await conversionRows(link.id)).toEqual([
    { id: answer.body.data.id, link_id: link.id, click_event_id: newest, event_type: 'signup', external_user_id: 'u-1', metadata: { plan: 'pro' } },
  ]);
  const summary = await api<{ conversionsByType: unknown[] }>('GET', `/api/links/${link.id}/analytics`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(summary.conversionsByType).toEqual([{ eventType: 'signup', count: 1 }]);
});

test('LINK-205 record a conversion by link id with the native SDKs\' projectId', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/buy', shortCode: uniqueCode('conv-id') });

  const answer = await rawApi('POST', '/api/conversions', { projectId: project.id, linkId: link.id, eventType: 'purchase' }, { apiKey: key, ip: clientIp });
  expect(answer.status).toBe(201);
  expect(answer.body.data).toMatchObject({ linkId: link.id, clickEventId: null, eventType: 'purchase', externalUserId: null });
  expect(await conversionRows(link.id)).toEqual([
    { id: answer.body.data.id, link_id: link.id, click_event_id: null, event_type: 'purchase', external_user_id: null, metadata: null },
  ]);
});

test('LINK-206 conversion project mismatch and foreign links', async ({ clientIp }) => {
  const p1 = await sdkProject(clientIp, 'p1');
  const p2 = await ownerWithProject(clientIp, 'p2');
  const l1 = await seedLink(p1.owner, p1.project.id, clientIp, { longUrl: 'https://example.com/l1', shortCode: uniqueCode('conv-l1') });
  const l2 = await seedLink(p2.owner, p2.project.id, clientIp, { longUrl: 'https://example.com/l2', shortCode: uniqueCode('conv-l2') });
  const post = (body: unknown) => rawApi('POST', '/api/conversions', body, { apiKey: p1.key, ip: clientIp });

  const mismatch = await post({ projectId: p2.project.id, linkId: l1.id, eventType: 'signup' });
  expect([mismatch.status, mismatch.body.message]).toEqual([403, 'Project mismatch']);
  const byId = await post({ linkId: l2.id, eventType: 'signup' });
  expect([byId.status, byId.body.message]).toEqual([400, 'Link does not belong to your project']);
  const byCode = await post({ shortCode: l2.shortCode, eventType: 'signup' });
  expect([byCode.status, byCode.body.message]).toEqual([400, 'Link does not belong to your project']);
  expect([await conversionRows(l1.id), await conversionRows(l2.id)]).toEqual([[], []]);
});

test('LINK-208 conversions need an ordinary API key', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/keys', shortCode: uniqueCode('conv-key') });
  const privacy = await newApiKey(owner, project.id, clientIp, { name: 'Backend privacy', permissions: ['privacy'] });
  const body = { linkId: link.id, eventType: 'signup' };
  const post = (options: { apiKey?: string; token?: string }) => rawApi('POST', '/api/conversions', body, { ...options, ip: clientIp });

  const none = await post({});
  expect([none.status, none.body.message]).toEqual([401, 'API key is required']);
  const wrong = await post({ apiKey: 'wrong' });
  expect([wrong.status, wrong.body.message]).toEqual([401, 'Invalid or expired API key']);
  const server = await post({ apiKey: privacy.fullKey });
  expect([server.status, server.body.message]).toEqual([403, SERVER_ONLY_KEY]);
  const bearer = await post({ token: owner.accessToken });
  expect([bearer.status, bearer.body.message]).toEqual([401, 'API key is required']);
  expect(await conversionRows(link.id)).toEqual([]);

  // The control: the ordinary key records it.
  expect((await post({ apiKey: key })).status).toBe(201);
  expect(await conversionRows(link.id)).toHaveLength(1);
});

test('LINK-209 conversion of a do-not-track person is dropped with 2xx', async ({ clientIp }) => {
  const { owner, project, key } = await sdkProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/dnt', shortCode: uniqueCode('conv-dnt') });
  await seedObjection(project.id, 'u-dnt');
  const post = (body: Record<string, unknown>) => rawApi('POST', '/api/conversions', { shortCode: link.shortCode, eventType: 'signup', ...body }, { apiKey: key, ip: clientIp });

  const dropped = await post({ externalUserId: 'u-dnt' });
  expect([dropped.status, dropped.body]).toEqual([201, { data: { recorded: false } }]);
  expect(await conversionRows(link.id)).toEqual([]);

  const nobody = await post({});
  expect(nobody.status).toBe(201);
  expect(nobody.body.data).toMatchObject({ id: expect.any(String), linkId: link.id, externalUserId: null });
  expect(await conversionRows(link.id)).toEqual([expect.objectContaining({ id: nobody.body.data.id, external_user_id: null })]);
  const [attribution] = await sql<{ n: string }>(
    "SELECT count(*)::text AS n FROM conversion_events WHERE link_id = $1 AND external_user_id = 'u-dnt'",
    [link.id],
  );
  expect(attribution.n).toBe('0');
});

// ---- Q. Review additions

test('LINK-217 catch-all short-code page keeps odd paths on the dashboard origin', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  // Navigations off the dashboard origin, and any request at all for the planted host.
  const elsewhere: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/evil\.example/i.test(new URL(url).host) || (request.isNavigationRequest() && new URL(url).origin !== origin)) elsewhere.push(url);
  });

  const cases: { visit: string; lands: string; status: number; message: string }[] = [
    // The browser resolves the dot segments: the API's own route, refused without a session.
    { visit: '/..%2F..%2Fapi%2Fprojects', lands: '/api/projects', status: 401, message: 'Unauthorized' },
    // A path of the dashboard host, not a protocol-relative URL.
    { visit: '/%2F%2Fevil.example', lands: '/redirect///evil.example', status: 404, message: 'Cannot GET /api///evil.example' },
    // The decoded "/" of "</script>" splits the path, so no route takes it.
    { visit: '/%3Cscript%3Ealert(1)%3C%2Fscript%3E', lands: '/redirect/%3Cscript%3Ealert(1)%3C/script%3E', status: 404, message: 'Cannot GET /api/%3Cscript%3Ealert(1)%3C/script%3E' },
    // A relative path, looked up as a short code.
    { visit: '/javascript:alert(1)', lands: '/redirect/javascript:alert(1)', status: 404, message: 'Link not found' },
  ];
  for (const { visit, lands, status, message } of cases) {
    const answer = page.waitForResponse((response) => response.request().isNavigationRequest() && new URL(response.url()).pathname === lands);
    await page.goto(visit);
    const response = await answer;
    expect([visit, new URL(response.url()).origin, response.status(), response.headers()['content-type']]).toEqual([
      visit,
      origin,
      status,
      'application/json; charset=utf-8',
    ]);
    expect((await response.json()).message).toBe(message);
    await page.waitForLoadState();
    expect(new URL(page.url()).origin).toBe(origin);
    expect(new URL(page.url()).pathname).toBe(lands);
  }
  expect(dialogs).toEqual([]);
  expect(elsewhere).toEqual([]);
});

test('LINK-227 bulk-imported javascript: and data: iOS deep links are blocked by the interstitial CSP', async ({ browser, baseURL, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await setProjectApp(project.id, { iosAppStoreUrl: 'https://apps.apple.com/app/id123' });
  const jsUrl = 'javascript:alert(document.domain)';
  const dataUrl = 'data:text/html,<script>alert(document.domain)</script>';
  // The data: URL holds a comma, so it is quoted as any CSV cell with one must be.
  const csv = ['longUrl,iosUrl', `https://example.com/1,${jsUrl}`, `https://example.com/2,"${dataUrl}"`].join('\n');
  expect(await bulkImport(owner, project.id, clientIp, csv)).toEqual({ total: 2, created: 2, errors: [] });
  const [js, data] = await storedLinks(project.id);
  expect([js.long_url, js.ios_url, data.long_url, data.ios_url]).toEqual(['https://example.com/1', jsUrl, 'https://example.com/2', dataUrl]);

  const { context } = await mobileContext(browser, 'ios', { baseURL });
  const dialogs: string[] = [];
  const consoleLines: string[] = [];
  const watch = async () => {
    const tab = await context.newPage();
    tab.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    tab.on('console', (message) => consoleLines.push(message.text()));
    await stubHosts(tab, ['apps.apple.com', 'example.com']);
    return tab;
  };

  const jsTab = await watch();
  const jsStore = jsTab.waitForRequest('https://apps.apple.com/app/id123');
  const jsResponse = await jsTab.goto(`/api/${js.short_code}`, { waitUntil: 'commit' });
  expect(jsResponse?.status()).toBe(200);
  expect(jsResponse?.headers()['content-type']).toBe('text/html; charset=utf-8');
  const policy = jsResponse?.headers()['content-security-policy'] ?? '';
  expect(policy).toMatch(/(^|; )script-src 'nonce-[A-Za-z0-9+/=]+'(;|$)/);
  expect(/script-src[^;]*'unsafe-inline'/.test(policy)).toBe(false);
  await expect(jsTab.getByRole('heading', { name: 'Opening app...' })).toBeVisible();
  await expect(jsTab.getByRole('link', { name: 'Click here if nothing happens' })).toHaveAttribute('href', 'https://apps.apple.com/app/id123');
  await jsStore;
  await waitUntil(async () => consoleLines.join('\n'), (text) => /(Refused to run|Running) the JavaScript URL (because it )?violates the following Content Security Policy directive:? .script-src 'nonce-/.test(text), 'the CSP refusal of the javascript: URL', 5000);

  const dataTab = await watch();
  const dataStore = dataTab.waitForRequest('https://apps.apple.com/app/id123');
  const dataResponse = await dataTab.goto(`/api/${data.short_code}`, { waitUntil: 'commit' });
  expect(dataResponse?.status()).toBe(200);
  await dataStore;
  await waitUntil(async () => consoleLines.join('\n'), (text) => /Not allowed to navigate top frame to data URL/.test(text), 'the refusal of the data: URL', 5000);
  expect(new URL(dataTab.url()).origin).toBe(new URL(baseURL!).origin);
  expect(dialogs).toEqual([]);
  await context.close();

  for (const link of [js, data]) {
    await waitForClicks(link.id, 1);
    expect((await clicksOf(link.id)).map((row) => row.redirect_type)).toEqual(['app_deeplink']);
  }
});

test('LINK-228 bulk-imported javascript: destination on desktop', async ({ page, baseURL, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const jsUrl = 'javascript:alert(document.domain)';
  expect(await bulkImport(owner, project.id, clientIp, `longUrl,title\n${jsUrl},JS\n`)).toEqual({ total: 1, created: 1, errors: [] });
  const [link] = await storedLinks(project.id);
  expect(link.long_url).toBe(jsUrl);
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  const raw = await openShortLink(link.short_code, newClientIp());
  expect([raw.status, raw.location]).toEqual([302, jsUrl]);
  await waitForClicks(link.id, 1);

  // Straight on the API's host: the browser drops the redirect and runs nothing.
  const direct = await page.goto(apiUrl(`/api/${link.short_code}`)).then(() => 'loaded', (error: Error) => error.message);
  expect(direct).toMatch(/net::ERR_(UNSAFE_REDIRECT|ABORTED)/);
  expect(page.url().startsWith('javascript:')).toBe(false);

  // Through the dashboard host: its hop answers the same redirect...
  const hop = await page.request.get(`/redirect/${link.short_code}`, { maxRedirects: 0 });
  expect([hop.status(), hop.headers()['location']]).toEqual([302, jsUrl]);
  // ...and the catch-all page's navigation to it fails, leaving the dashboard page in place.
  const failed: string[] = [];
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === `/redirect/${link.short_code}`) failed.push(request.failure()?.errorText ?? '');
  });
  await page.goto(`/${link.short_code}`, { waitUntil: 'commit' });
  await waitUntil(async () => failed, (all) => all.length > 0, 'the refused redirect', 10_000);
  expect(failed[0]).toMatch(/net::ERR_(UNSAFE_REDIRECT|ABORTED)/);
  await page.waitForTimeout(500);
  expect(page.url()).toBe(new URL(`/${link.short_code}`, baseURL).href);
  expect(dialogs).toEqual([]);
  // The raw request, the API host, the hop and the page's own each recorded a click.
  await waitForClicks(link.id, 4);
});

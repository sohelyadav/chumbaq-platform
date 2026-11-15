import { randomUUID } from 'crypto';
import { api, createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../../support/api';
import { mobileContext } from '../../support/browser-tools';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activityEntries,
  addProjectMember,
  countClicks,
  countTouchpoints,
  IPHONE_UA,
  linkActionsButton,
  openShortLink,
  openViewAs,
  parseCsv,
  routeRedirectHop,
  PIXEL_UA,
  rawApi,
  recordConversion,
  refusalShape,
  seedLink,
  seedVariant,
  setSuspended,
  sql,
  startViewAs,
  stubHosts,
  toast,
  uniqueCode,
  viewAsToken,
  waitForClicks,
  waitForTouchpoints,
  waitUntil,
  WINDOWS_CHROME_UA,
  type SeededLink,
} from '../../support/areas/link';

/**
 * Links: editing and deleting a link, who may call the link routes, the link analytics
 * API and its export, and the public short-link redirect (desktop, the dashboard host,
 * the mobile interstitial, inactive, expired and suspended links, do-not-track devices).
 */

const PROJECT_NOT_FOUND = 'Project not found';
const READ_ONLY = 'Impersonation sessions are read-only';
const CSV_HEADER = 'id,clicked_at,ip_address,platform,device_type,os,browser,country,city,referrer,redirect_type';

async function ownerWithProject(ip: string, label = 'links'): Promise<{ owner: Account; project: Project }> {
  const owner = await createAccount(ip, label, 'Lina Links');
  const project = await createProject(owner, ip);
  return { owner, project };
}

/** Holds matching requests for a moment, so the button's sending state can be seen. */
async function slowDown(page: import('@playwright/test').Page, pattern: string, method: string, ms = 800): Promise<void> {
  await page.route(pattern, async (route) => {
    if (route.request().method() === method) await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

/** The edit page once its form holds the link's stored values. */
async function openEdit(page: import('@playwright/test').Page, projectId: string, link: SeededLink): Promise<void> {
  await page.goto(`/projects/${projectId}/links/${link.id}/edit`);
  await expect(page.getByRole('heading', { name: 'Edit Link' })).toBeVisible();
  await expect(page.getByPlaceholder('https://example.com/page')).toHaveValue(link.longUrl);
}

/** Flips the edit page's Active switch to `on` and saves. */
async function toggleActive(page: import('@playwright/test').Page, projectId: string, link: SeededLink, on: boolean): Promise<void> {
  await openEdit(page, projectId, link);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const active = page.getByRole('switch');
  await expect(active).toHaveAttribute('aria-checked', String(!on));
  await active.click();
  await expect(active).toHaveAttribute('aria-checked', String(on));
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(toast(page, 'Link updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/links/${link.id}$`));
}

async function linkRow(id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await sql('SELECT short_code, project_id, title, long_url, is_active FROM links WHERE id = $1', [id]);
  return row;
}

async function clickRows(linkId: string) {
  return sql<Record<string, unknown>>(
    `SELECT platform, device_type, os, browser, redirect_type, is_deferred, matched, ip_address, device_identity_id, distinct_id
       FROM click_events WHERE link_id = $1 ORDER BY clicked_at`,
    [linkId],
  );
}

/** Every route of links.controller and the link routes of analytics.controller, for a link id and a variant id. */
function linkRoutes(linkId: string, variantId: string, projectId: string): [string, string, unknown][] {
  return [
    ['POST', `/api/projects/${projectId}/links`, { longUrl: 'https://example.com/x' }],
    ['GET', `/api/projects/${projectId}/links`, undefined],
    ['POST', `/api/projects/${projectId}/links/bulk`, {}],
    ['GET', `/api/links/${linkId}`, undefined],
    ['GET', `/api/links/${linkId}/qr`, undefined],
    ['PATCH', `/api/links/${linkId}`, { title: 'Hijacked' }],
    ['DELETE', `/api/links/${linkId}`, undefined],
    ['GET', `/api/links/${linkId}/variants`, undefined],
    ['POST', `/api/links/${linkId}/variants`, { name: 'Hijack', longUrl: 'https://example.com/hijack' }],
    ['PATCH', `/api/links/${linkId}/variants/${variantId}`, { name: 'Hijacked' }],
    ['DELETE', `/api/links/${linkId}/variants/${variantId}`, undefined],
    ...analyticsRoutes(linkId).map((urlPath): [string, string, unknown] => ['GET', urlPath, undefined]),
  ];
}

function analyticsRoutes(linkId: string): string[] {
  const base = `/api/links/${linkId}/analytics`;
  return [base, `${base}/timeseries`, `${base}/devices`, `${base}/geo`, `${base}/referrers`, `${base}/export`];
}

// ---- G. Edit link

test('LINK-127 save changes to a link', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/old', title: 'Original', shortCode: uniqueCode('edit-me') });

  await signIn(page, owner);
  await openEdit(page, project.id, link);
  await page.getByPlaceholder('https://example.com/page').fill('https://example.com/new');
  await page.getByPlaceholder('My awesome link').fill('Renamed');
  await slowDown(page, `**/api/links/${link.id}`, 'PATCH');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeVisible();
  await expect(toast(page, 'Link updated')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));
  await expect(page.getByRole('link', { name: 'https://example.com/new' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Renamed Active' })).toBeVisible();

  const redirect = await openShortLink(link.shortCode, newClientIp());
  expect([redirect.status, redirect.location]).toEqual([302, 'https://example.com/new']);

  const entries = await activityEntries(project.id, 'link.changed');
  expect(entries).toHaveLength(1);
  expect(entries[0].target_label).toBe('Renamed');
  expect(entries[0].details?.fields).toEqual(expect.arrayContaining(['longUrl', 'title']));
  expect(JSON.stringify(entries[0].details)).not.toContain('example.com');
});

test('LINK-132 deactivate and reactivate a link from edit', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/toggle', shortCode: uniqueCode('toggle-me'), tags: ['promo'] });
  await signIn(page, owner);
  const toggle = (on: boolean) => toggleActive(page, project.id, link, on);

  const visitor = newClientIp();
  await toggle(false);
  const off = await openShortLink(link.shortCode, visitor);
  expect([off.status, off.body.message]).toEqual([404, 'Link is no longer active']);
  expect(off.headers.get('content-type')).toMatch(/application\/json/);

  await toggle(true);
  const on = await openShortLink(link.shortCode, visitor);
  expect([on.status, on.location]).toEqual([302, 'https://example.com/toggle']);
  // The live click lands; it is the only one, so the refused request wrote none.
  await waitForClicks(link.id, 1);
  expect(await countClicks(link.id)).toBe(1);

  const entries = await activityEntries(project.id, 'link.changed');
  expect(entries.map((entry) => entry.details?.fields)).toEqual([['isActive'], ['isActive']]);
});

test('LINK-132 switching an untagged link off logs only the active flag', async ({ page, clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-132' });
  const { owner, project } = await ownerWithProject(clientIp);
  // As the create form leaves a link: no title, no tags.
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/untagged', shortCode: uniqueCode('untagged') });
  await signIn(page, owner);
  await toggleActive(page, project.id, link, false);
  expect((await activityEntries(project.id, 'link.changed')).map((entry) => entry.details?.fields)).toEqual([['isActive']]);
  const [row] = await sql<{ tags: string[] | null }>('SELECT tags FROM links WHERE id = $1', [link.id]);
  expect(row.tags).toBeNull();
});

test('LINK-135 short code cannot be changed', async ({ clientIp }) => {
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const link = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/fixed', shortCode: uniqueCode('fixed') });
  const auth = { token: owner.accessToken, ip: clientIp };
  const before = await linkRow(link.id);

  const code = await rawApi('PATCH', `/api/links/${link.id}`, { shortCode: 'new-code' }, auth);
  expect(code.status).toBe(400);
  expect(code.body.message).toEqual(['property shortCode should not exist']);
  expect(await linkRow(link.id)).toEqual(before);

  const moved = await rawApi('PATCH', `/api/links/${link.id}`, { projectId: p2.id }, auth);
  expect([moved.status, moved.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(await linkRow(link.id)).toEqual(before);
  expect((await linkRow(link.id))?.project_id).toBe(p1.id);

  const counter = await rawApi('PATCH', `/api/links/${link.id}`, { clickCount: 1 }, auth);
  expect(counter.status).toBe(400);
  expect(counter.body.message).toEqual(['property clickCount should not exist']);
  expect(await linkRow(link.id)).toEqual(before);
  const read = await rawApi('GET', `/api/links/${link.id}`, undefined, auth);
  expect(read.body.data.shortCode).toBe(link.shortCode);
});

test('LINK-138 edit by role, other tenants and view-as', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const link = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/l', title: 'Start' });
  const foreign = await seedLink(x, p2.id, clientIp, { longUrl: 'https://example.com/l2', title: 'Theirs' });

  for (const role of ['admin', 'member'] as const) {
    const person = await addProjectMember(owner, p1.id, role, clientIp);
    const response = await rawApi('PATCH', `/api/links/${link.id}`, { title: `By ${role}` }, { token: person.accessToken, ip: newClientIp() });
    expect([role, response.status, response.body.data?.title]).toEqual([role, 200, `By ${role}`]);
  }

  const n = await createAccount(clientIp, 'nobody', 'Nora Nobody');
  const byN = await rawApi('PATCH', `/api/links/${link.id}`, { title: 'By N' }, { token: n.accessToken, ip: newClientIp() });
  expect([byN.status, byN.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const byO = await rawApi('PATCH', `/api/links/${foreign.id}`, { title: 'By O' }, { token: owner.accessToken, ip: clientIp });
  expect([byO.status, byO.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const anonymous = await rawApi('PATCH', `/api/links/${link.id}`, { title: 'Anyone' }, { ip: newClientIp() });
  expect(anonymous.status).toBe(401);

  const viewAs = await openViewAs(browser, baseURL, await startViewAs(browser, baseURL, owner));
  await viewAs.goto(`/projects/${p1.id}/links/${link.id}/edit`);
  await expect(viewAs.getByPlaceholder('My awesome link')).toHaveValue('By member');
  await viewAs.getByPlaceholder('My awesome link').fill('By staff');
  const answered = viewAs.waitForResponse((r) => r.url().endsWith(`/api/links/${link.id}`) && r.request().method() === 'PATCH');
  await viewAs.getByRole('button', { name: 'Save Changes' }).click();
  const response = await answered;
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(toast(viewAs, 'Read-only session')).toContainText(READ_ONLY);
  await expect(toast(viewAs, 'Error')).toContainText('Failed to update link');
  await expect(viewAs).toHaveURL(new RegExp(`/links/${link.id}/edit$`));
  await viewAs.context().close();

  expect((await linkRow(link.id))?.title).toBe('By member');
  expect((await linkRow(foreign.id))?.title).toBe('Theirs');
});

// ---- H. Delete link

test('LINK-139 delete a link from the detail page', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const apiKey = await createApiKey(owner, project.id, clientIp);
  const code = uniqueCode('del-me');
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/del', title: 'Delete me', shortCode: code });
  for (let i = 0; i < 2; i++) expect((await openShortLink(code, newClientIp())).status).toBe(302);
  await waitForClicks(link.id, 2);
  await waitForTouchpoints(link.id, 2);
  const touchpoints = (await sql<{ id: string }>('SELECT id FROM touchpoints WHERE link_id = $1', [link.id])).map((row) => row.id);
  await seedVariant(owner, link.id, clientIp, { name: 'B', longUrl: 'https://example.com/del-b', weight: 50 });
  await recordConversion(apiKey, link.id, 'signup', clientIp);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/${link.id}`);
  await linkActionsButton(page).click();
  await page.getByRole('menuitem', { name: 'Delete Link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Link' });
  await expect(dialog).toContainText('This will permanently delete this link and all its analytics data.');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await slowDown(page, `**/api/links/${link.id}`, 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Deleting...' })).toBeVisible();
  await expect(toast(page, 'Link deleted')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links$`));
  await expect(page.getByText('No links found.')).toBeVisible();

  const [left] = await sql<{ links: number; clicks: number; conversions: number; variants: number }>(
    `SELECT (SELECT count(*)::int FROM links WHERE id = $1) AS links,
            (SELECT count(*)::int FROM click_events WHERE link_id = $1) AS clicks,
            (SELECT count(*)::int FROM conversion_events WHERE link_id = $1) AS conversions,
            (SELECT count(*)::int FROM link_variants WHERE link_id = $1) AS variants`,
    [link.id],
  );
  expect(left).toEqual({ links: 0, clicks: 0, conversions: 0, variants: 0 });
  const released = await sql('SELECT project_id FROM released_short_codes WHERE short_code = $1', [code]);
  expect(released).toEqual([{ project_id: project.id }]);
  const kept = await sql<{ link_id: string | null }>('SELECT link_id FROM touchpoints WHERE id = ANY($1)', [touchpoints]);
  expect(kept).toEqual([{ link_id: null }, { link_id: null }]);
  expect(await activityEntries(project.id, 'content.deleted')).toEqual([{ target_label: 'Delete me', details: { kind: 'link' } }]);

  const gone = await openShortLink(code, newClientIp());
  expect([gone.status, gone.body.message]).toEqual([404, 'Link not found']);
});

test('LINK-144 delete by role, other tenants and view-as', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const byMember = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/m' });
  const kept = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/kept' });
  const foreign = await seedLink(x, p2.id, clientIp, { longUrl: 'https://example.com/theirs' });

  const m = await addProjectMember(owner, p1.id, 'member', clientIp);
  const removed = await rawApi('DELETE', `/api/links/${byMember.id}`, undefined, { token: m.accessToken, ip: newClientIp() });
  expect([removed.status, removed.body.data?.message]).toEqual([200, 'Link deleted successfully']);
  expect(await linkRow(byMember.id)).toBeUndefined();

  const n = await createAccount(clientIp, 'nobody', 'Nora Nobody');
  const byN = await rawApi('DELETE', `/api/links/${kept.id}`, undefined, { token: n.accessToken, ip: newClientIp() });
  expect([byN.status, byN.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const byO = await rawApi('DELETE', `/api/links/${foreign.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect([byO.status, byO.body.message]).toEqual([404, PROJECT_NOT_FOUND]);

  const viewAs = await openViewAs(browser, baseURL, await startViewAs(browser, baseURL, owner));
  await viewAs.goto(`/projects/${p1.id}/links/${kept.id}`);
  await linkActionsButton(viewAs).click();
  await viewAs.getByRole('menuitem', { name: 'Delete Link' }).click();
  const answered = viewAs.waitForResponse((r) => r.url().endsWith(`/api/links/${kept.id}`) && r.request().method() === 'DELETE');
  await viewAs.getByRole('dialog', { name: 'Delete Link' }).getByRole('button', { name: 'Delete', exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(toast(viewAs, 'Read-only session')).toContainText(READ_ONLY);
  await expect(toast(viewAs, 'Error')).toContainText('Failed to delete link');
  await expect(viewAs).toHaveURL(new RegExp(`/links/${kept.id}$`));
  await viewAs.context().close();

  expect(await linkRow(kept.id)).toBeDefined();
  expect(await linkRow(foreign.id)).toBeDefined();
});

// ---- I. Links API access

test('LINK-145 every link route refuses outsiders with the same 404', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/private', title: 'Private' });
  const variant = await seedVariant(owner, link.id, clientIp, { name: 'V', longUrl: 'https://example.com/v', weight: 40 });
  const n = await createAccount(clientIp, 'nobody', 'Nora Nobody');
  const asN = { token: n.accessToken, ip: newClientIp() };

  const shapes = new Set<string>();
  for (const id of [link.id, randomUUID(), 'abc']) {
    // The routes keyed by link (the project-scoped ones belong to LINK-023 and LINK-059).
    for (const [method, urlPath, body] of linkRoutes(id, variant.id, project.id).filter(([, p]) => p.startsWith('/api/links/') && !p.includes('/analytics'))) {
      const response = await rawApi(method, urlPath, body, asN);
      expect([method, urlPath, response.status, response.body.message]).toEqual([method, urlPath, 404, PROJECT_NOT_FOUND]);
      shapes.add(JSON.stringify(refusalShape(response.body)));
    }
  }
  expect([...shapes]).toEqual([JSON.stringify({ statusCode: 404, error: 'Not Found', message: PROJECT_NOT_FOUND })]);

  expect(await linkRow(link.id)).toMatchObject({ title: 'Private', long_url: 'https://example.com/private' });
  const variants = await sql('SELECT name, long_url, weight FROM link_variants WHERE link_id = $1', [link.id]);
  expect(variants).toEqual([{ name: 'V', long_url: 'https://example.com/v', weight: 40 }]);
});

test('LINK-146 every link route needs a signed-in user', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const apiKey = await createApiKey(owner, project.id, clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/locked', title: 'Locked' });
  const variant = await seedVariant(owner, link.id, clientIp, { name: 'V', longUrl: 'https://example.com/v' });
  const routes = linkRoutes(link.id, variant.id, project.id);
  expect(routes).toHaveLength(17);

  for (const credentials of [{}, { apiKey }]) {
    const ip = newClientIp();
    for (const [method, urlPath, body] of routes) {
      const response = await rawApi(method, urlPath, body, { ...credentials, ip });
      expect([Object.keys(credentials).join() || 'none', method, urlPath, response.status]).toEqual([
        Object.keys(credentials).join() || 'none',
        method,
        urlPath,
        401,
      ]);
    }
  }
  expect(await linkRow(link.id)).toMatchObject({ title: 'Locked' });
  expect(await sql('SELECT name FROM link_variants WHERE link_id = $1', [link.id])).toEqual([{ name: 'V' }]);
});

// ---- J. Link analytics API

test('LINK-151 analytics summary fields', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const apiKey = await createApiKey(owner, project.id, clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/sum', iosUrl: 'https://example.com/app/sum', shortCode: uniqueCode('sum') });
  const phoneA = newClientIp();
  const phoneB = newClientIp();
  const desk = newClientIp();
  expect((await openShortLink(link.shortCode, phoneA, IPHONE_UA)).status).toBe(200);
  expect((await openShortLink(link.shortCode, phoneB, IPHONE_UA)).status).toBe(200);
  expect((await openShortLink(link.shortCode, desk)).status).toBe(302);
  expect((await openShortLink(link.shortCode, desk)).status).toBe(302);
  await waitForClicks(link.id, 4);
  // One install matched to a phone click, as a deferred match leaves it.
  await sql(`UPDATE click_events SET matched = true WHERE id = (SELECT id FROM click_events WHERE link_id = $1 AND ip_address = $2)`, [link.id, phoneA]);
  for (const type of ['signup', 'signup', 'purchase']) await recordConversion(apiKey, link.id, type, clientIp);

  const m = await addProjectMember(owner, project.id, 'member', clientIp);
  const summary = await rawApi('GET', `/api/links/${link.id}/analytics`, undefined, { token: m.accessToken, ip: newClientIp() });
  expect(summary.status).toBe(200);
  const { conversionsByType, ...rest } = summary.body.data;
  expect(rest).toEqual({ totalClicks: 4, uniqueVisitors: 3, appOpens: 2, storeRedirects: 0, matchedInstalls: 1, conversionRate: 0.5 });
  expect(conversionsByType).toHaveLength(2);
  expect(conversionsByType).toEqual(
    expect.arrayContaining([
      { eventType: 'signup', count: 2 },
      { eventType: 'purchase', count: 1 },
    ]),
  );
});

test('LINK-155 analytics routes for roles and outsiders', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const link = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/an', shortCode: uniqueCode('an') });
  const foreign = await seedLink(x, p2.id, clientIp, { longUrl: 'https://example.com/an2' });
  expect((await openShortLink(link.shortCode, newClientIp())).status).toBe(302);
  await waitForClicks(link.id, 1);

  const admin = await addProjectMember(owner, p1.id, 'admin', clientIp);
  const member = await addProjectMember(owner, p1.id, 'member', clientIp);
  const n = await createAccount(clientIp, 'nobody', 'Nora Nobody');
  const staffToken = await viewAsToken(browser, baseURL, owner);
  const routes = analyticsRoutes(link.id);

  for (const [who, token] of [['owner', owner.accessToken], ['admin', admin.accessToken], ['member', member.accessToken], ['view-as', staffToken]] as const) {
    const ip = newClientIp();
    for (const urlPath of routes) {
      const response = await rawApi('GET', urlPath, undefined, { token, ip });
      const refused = who === 'view-as' && urlPath.endsWith('/export');
      expect([who, urlPath, response.status]).toEqual([who, urlPath, refused ? 403 : 200]);
      if (refused) expect(response.body.message).toBe(READ_ONLY);
    }
  }

  const outsiders: [string, string, string[]][] = [
    ['non-member', n.accessToken, routes],
    ['owner, other project', owner.accessToken, analyticsRoutes(foreign.id)],
    ['owner, malformed id', owner.accessToken, analyticsRoutes('abc')],
  ];
  for (const [who, token, paths] of outsiders) {
    const ip = newClientIp();
    for (const urlPath of paths) {
      const response = await rawApi('GET', urlPath, undefined, { token, ip });
      expect([who, urlPath, response.status, response.body.message]).toEqual([who, urlPath, 404, PROJECT_NOT_FOUND]);
    }
  }
});

test('LINK-156 click export file contents and headers', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/csv', shortCode: uniqueCode('csv') });
  const visitors = [newClientIp(), newClientIp(), newClientIp()];
  for (const [i, ip] of visitors.entries()) {
    expect((await openShortLink(link.shortCode, ip)).status).toBe(302);
    await waitForClicks(link.id, i + 1);
  }
  // Clicks an hour apart, oldest first in the order they were made.
  for (const [i, ip] of visitors.entries()) {
    await sql(`UPDATE click_events SET clicked_at = now() - make_interval(hours => $3) WHERE link_id = $1 AND ip_address = $2`, [link.id, ip, 3 - i]);
  }

  const m = await addProjectMember(owner, project.id, 'member', clientIp);
  const auth = { token: m.accessToken, ip: newClientIp() };
  const response = await rawApi('GET', `/api/links/${link.id}/analytics/export`, undefined, auth);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/csv/);
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="analytics-${link.id}.csv"`);
  expect(response.headers.get('x-export-row-cap')).toBe('50000');
  expect(response.headers.get('x-export-truncated')).toBe('false');
  const text = response.body as string;
  expect(typeof text).toBe('string');
  expect(text).not.toContain('\r');
  expect(text.startsWith('{')).toBe(false);
  const lines = text.split('\n');
  expect(lines[0]).toBe(CSV_HEADER);
  expect(lines).toHaveLength(4);
  const cells = lines.slice(1).map((line) => line.split(','));
  expect(cells.map((row) => row[2])).toEqual([...visitors].reverse());
  expect(cells.map((row) => row[10])).toEqual(['web_fallback', 'web_fallback', 'web_fallback']);

  const oldest = cells[2][1];
  const start = new Date(Date.parse(oldest) + 1).toISOString();
  const windowed = await rawApi('GET', `/api/links/${link.id}/analytics/export?start=${encodeURIComponent(start)}`, undefined, auth);
  expect(windowed.status).toBe(200);
  const windowLines = (windowed.body as string).split('\n');
  expect(windowLines[0]).toBe(CSV_HEADER);
  expect(windowLines.slice(1).map((line) => line.split(',')[2])).toEqual([visitors[2], visitors[1]]);
});

test('LINK-157 click export neutralises spreadsheet formulas', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/formula', shortCode: uniqueCode('formula') });
  const referrers = ['=HYPERLINK("http://evil.example","x")', '+1+1', '-2', '@SUM(A1)', 'a,b"c'];
  for (const [i, referer] of referrers.entries()) {
    const response = await rawApi('GET', `/api/${link.shortCode}`, undefined, { ip: newClientIp(), headers: { 'User-Agent': WINDOWS_CHROME_UA, Referer: referer } });
    expect(response.status).toBe(302);
    await waitForClicks(link.id, i + 1);
  }
  const stored = await sql<{ referrer: string }>('SELECT referrer FROM click_events WHERE link_id = $1', [link.id]);
  expect(stored.map((row) => row.referrer).sort()).toEqual([...referrers].sort());

  const response = await rawApi('GET', `/api/links/${link.id}/analytics/export`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(response.status).toBe(200);
  const text = response.body as string;
  expect(text).toContain(`,"'=HYPERLINK(""http://evil.example"",""x"")",`);
  expect(text).toContain(",'+1+1,");
  expect(text).toContain(",'-2,");
  expect(text).toContain(",'@SUM(A1),");
  expect(text).toContain(',"a,b""c",');

  const rows = parseCsv(text);
  expect(rows[0].join(',')).toBe(CSV_HEADER);
  const exported = rows.slice(1).map((row) => {
    expect(row).toHaveLength(11);
    return row[9];
  });
  expect(exported.sort()).toEqual([`'=HYPERLINK("http://evil.example","x")`, "'+1+1", "'-2", "'@SUM(A1)", 'a,b"c'].sort());
});

// ---- K. Redirect

test('LINK-159 desktop browser is redirected to the destination', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/landing',
    shortCode: uniqueCode('go-desk'),
    iosUrl: 'https://example.com/app/ios',
    androidUrl: 'https://example.com/app/android',
  });
  const visitor = newClientIp();
  for (const [i, urlPath] of [`/${link.shortCode}`, `/api/${link.shortCode}`].entries()) {
    const response = await rawApi('GET', urlPath, undefined, { ip: visitor, headers: { 'User-Agent': WINDOWS_CHROME_UA } });
    expect([urlPath, response.status, response.headers.get('location')]).toEqual([urlPath, 302, 'https://example.com/landing']);
    await waitForClicks(link.id, i + 1);
  }
  const expected = {
    platform: 'windows',
    device_type: 'desktop',
    os: 'Windows',
    browser: 'Chrome',
    redirect_type: 'web_fallback',
    is_deferred: false,
    matched: false,
    ip_address: visitor,
    device_identity_id: null,
    distinct_id: null,
  };
  expect(await clickRows(link.id)).toEqual([expected, expected]);
});

test('LINK-160 short link through the dashboard host', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/landing', shortCode: uniqueCode('via-app') });
  const seen = await stubHosts(page, ['example.com'], 200);
  const hops = await routeRedirectHop(page);

  await page.goto(`/${link.shortCode}`, { waitUntil: 'commit' });
  // Two navigations follow the first (the hop, then the destination): poll the URL.
  await expect(page).toHaveURL('https://example.com/landing');
  await expect(page.getByText('Stand-in page')).toBeVisible();
  expect(hops).toEqual([{ url: expect.stringMatching(new RegExp(`/redirect/${link.shortCode}$`)), status: 302, location: 'https://example.com/landing' }]);
  expect(seen).toEqual(['https://example.com/landing']);
  await waitForClicks(link.id, 1);
  expect(await countClicks(link.id)).toBe(1);
});

test('LINK-161 UTM parameters on a link opened through the dashboard host', async ({ page, clientIp }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'LINK-161' });
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/utm', shortCode: uniqueCode('utm-app') });
  await stubHosts(page, ['example.com'], 200);
  await routeRedirectHop(page);

  await page.goto(`/${link.shortCode}?utm_source=news&utm_medium=email&utm_campaign=launch`);
  await expect(page).toHaveURL(/^https:\/\/example\.com\/utm/);
  await waitForTouchpoints(link.id, 1);
  const touchpoints = await sql('SELECT utm_source, utm_medium, utm_campaign FROM touchpoints WHERE link_id = $1', [link.id]);
  expect(touchpoints).toEqual([{ utm_source: 'news', utm_medium: 'email', utm_campaign: 'launch' }]);
});

test('LINK-164 iPhone gets the interstitial page', async ({ browser, baseURL, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await api(
    'PATCH',
    `/api/projects/${project.id}`,
    { iosAppStoreUrl: 'https://apps.apple.com/app/id123', androidPlayStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.app' },
    { token: owner.accessToken, ip: clientIp },
  );
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/shoes',
    shortCode: uniqueCode('go-ios'),
    title: 'Shoes',
    ogTitle: 'Great shoes',
    ogDescription: 'Buy now',
    ogImageUrl: 'https://example.com/og.png',
    iosUrl: 'https://example.com/app/shoes',
    deepLinkParams: { screen: 'shoes' },
  });

  const { context } = await mobileContext(browser, 'ios', { baseURL });
  const page = await context.newPage();
  await stubHosts(page, ['example.com', 'apps.apple.com']);
  const deepLink = page.waitForRequest('https://example.com/app/shoes');
  const response = await page.goto(`/redirect/${link.shortCode}`, { waitUntil: 'commit' });
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toBe('text/html; charset=utf-8');
  await deepLink;

  await expect(page).toHaveTitle('Great shoes');
  const meta = (property: string) => page.locator(`meta[property="${property}"]`);
  await expect(meta('og:title')).toHaveAttribute('content', 'Great shoes');
  await expect(meta('og:description')).toHaveAttribute('content', 'Buy now');
  await expect(meta('og:image')).toHaveAttribute('content', 'https://example.com/og.png');
  await expect(meta('og:type')).toHaveAttribute('content', 'website');
  await expect(page.getByRole('heading', { name: 'Opening app...' })).toBeVisible();
  await expect(page.getByText('You will be redirected automatically.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Click here if nothing happens' })).toHaveAttribute('href', 'https://apps.apple.com/app/id123');
  await context.close();

  await waitForClicks(link.id, 1);
  expect(await clickRows(link.id)).toEqual([
    expect.objectContaining({ platform: 'ios', device_type: 'mobile', os: 'iOS', redirect_type: 'app_deeplink', is_deferred: true, matched: false }),
  ]);
});

test('LINK-165 interstitial falls back after 1.5 seconds', async ({ browser, baseURL, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/web',
    shortCode: uniqueCode('fallback'),
    iosUrl: 'https://example.com/app/open',
    iosFallbackUrl: 'https://example.com/ios-fallback',
  });
  const { context } = await mobileContext(browser, 'ios', { baseURL });
  const page = await context.newPage();
  const times: Record<string, number> = {};
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.com/')) times[request.url()] ??= Date.now();
  });
  await stubHosts(page, ['example.com']);
  await page.goto(`/redirect/${link.shortCode}`, { waitUntil: 'commit' });
  await expect(page.getByRole('link', { name: 'Click here if nothing happens' })).toHaveAttribute('href', 'https://example.com/ios-fallback');
  await waitUntil(async () => times['https://example.com/ios-fallback'], (t) => t !== undefined, 'the fallback request', 5000);
  const elapsed = times['https://example.com/ios-fallback'] - times['https://example.com/app/open'];
  expect(elapsed).toBeGreaterThanOrEqual(1400);
  expect(elapsed).toBeLessThanOrEqual(2500);
  await context.close();
});

test('LINK-167 Android interstitial with an intent URL', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await api(
    'PATCH',
    `/api/projects/${project.id}`,
    { androidPackageName: 'com.example.app', androidPlayStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.app' },
    { token: owner.accessToken, ip: clientIp },
  );
  const bare = await createProject(owner, clientIp);
  await api('PATCH', `/api/projects/${bare.id}`, { androidPackageName: 'com.example.app' }, { token: owner.accessToken, ip: clientIp });

  const script = (html: string, name: string) => JSON.parse(new RegExp(`var ${name} = ("(?:[^"\\\\]|\\\\.)*");`).exec(html)?.[1] ?? 'null') as string | null;
  const open = async (link: SeededLink) => {
    const response = await openShortLink(link.shortCode, newClientIp(), PIXEL_UA);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    return response.body as string;
  };

  const withFallback = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/web',
    shortCode: uniqueCode('go-and'),
    androidUrl: 'https://example.com/app/item?id=7#top',
    androidFallbackUrl: 'https://example.com/and-fallback',
  });
  const html = await open(withFallback);
  expect(script(html, 'deepLink')).toBe('intent://example.com/app/item?id=7#top#Intent;scheme=https;package=com.example.app;end');
  expect(script(html, 'fallback')).toBe('https://example.com/and-fallback');

  const toStore = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/web', androidUrl: 'https://example.com/app/item' });
  expect(script(await open(toStore), 'fallback')).toBe('https://play.google.com/store/apps/details?id=com.example.app');
  const toWeb = await seedLink(owner, bare.id, clientIp, { longUrl: 'https://example.com/web-only', androidUrl: 'https://example.com/app/item' });
  expect(script(await open(toWeb), 'fallback')).toBe('https://example.com/web-only');

  await waitForClicks(withFallback.id, 1);
  expect(await clickRows(withFallback.id)).toEqual([
    expect.objectContaining({ platform: 'android', device_type: 'mobile', redirect_type: 'app_deeplink', is_deferred: true }),
  ]);
});

test('LINK-171 interstitial sets the deferred deep-link cookies', async ({ browser, baseURL, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const params = { screen: 'p', id: '9' };
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/ck',
    shortCode: uniqueCode('ck-1'),
    iosUrl: 'https://example.com/app/ck',
    deepLinkParams: params,
  });
  const { context } = await mobileContext(browser, 'ios', { baseURL });
  const page = await context.newPage();
  await stubHosts(page, ['example.com']);
  const opened = Date.now();
  await page.goto(`/redirect/${link.shortCode}`, { waitUntil: 'commit' });
  await expect(page.getByRole('heading', { name: 'Opening app...' })).toBeVisible();

  const cookies = await waitUntil(
    () => context.cookies(baseURL),
    (all) => all.some((c) => c.name === 'chumbaq_params'),
    'the interstitial cookies',
    5000,
  );
  const ref = cookies.find((c) => c.name === 'chumbaq_ref');
  const stored = cookies.find((c) => c.name === 'chumbaq_params');
  expect(ref).toMatchObject({ value: link.shortCode, path: '/', sameSite: 'Lax' });
  expect(stored).toMatchObject({ path: '/', sameSite: 'Lax' });
  // The params as the link stores them (jsonb keeps its own key order), URL-encoded.
  const saved = await api<{ deepLinkParams: Record<string, unknown> }>('GET', `/api/links/${link.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(stored?.value).toBe(encodeURIComponent(JSON.stringify(saved.deepLinkParams)));
  expect(stored?.value).toBe('%7B%22id%22%3A%229%22%2C%22screen%22%3A%22p%22%7D');
  expect(JSON.parse(decodeURIComponent(stored!.value))).toEqual(params);
  for (const cookie of [ref!, stored!]) {
    const days = (cookie.expires * 1000 - opened) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  }
  await context.close();
});

test('LINK-172 interstitial escapes link fields', async ({ browser, baseURL, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const ogTitle = '"><script>alert(1)</script>';
  const ogDescription = '<img src=x onerror=alert(2)>';
  const params = { x: '</script><script>alert(3)</script>' };
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/xss',
    shortCode: uniqueCode('xss'),
    ogTitle,
    ogDescription,
    deepLinkParams: params,
    iosUrl: 'https://example.com/a',
  });
  const { context } = await mobileContext(browser, 'ios', { baseURL });
  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await stubHosts(page, ['example.com']);
  // No store URL or iOS fallback: the page falls back to the destination.
  const fellBack = page.waitForRequest('https://example.com/xss');
  const response = await page.goto(`/redirect/${link.shortCode}`, { waitUntil: 'commit' });
  const html = await response!.text();

  await expect(page).toHaveTitle(ogTitle);
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', ogDescription);
  expect(html).toContain('<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
  expect(html).toContain('<meta property="og:title" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
  expect(html).toContain('<meta property="og:description" content="&lt;img src=x onerror=alert(2)&gt;">');
  expect(html).toContain('<script type="application/json" id="chumbaq-params">{"x":"\\u003c/script>\\u003cscript>alert(3)\\u003c/script>"}</script>');
  expect(JSON.parse((await page.locator('#chumbaq-params').textContent()) ?? '')).toEqual(params);
  expect(await page.locator('script').count()).toBe(2);
  expect(await page.locator('img').count()).toBe(0);

  const cookies = await waitUntil(() => context.cookies(baseURL), (all) => all.some((c) => c.name === 'chumbaq_params'), 'the params cookie', 5000);
  expect(JSON.parse(decodeURIComponent(cookies.find((c) => c.name === 'chumbaq_params')!.value))).toEqual(params);
  // The page's own script has run to its fallback, so any planted script would have run too.
  await fellBack;
  expect(dialogs).toEqual([]);
  await context.close();
});

test('LINK-175 inactive and expired links', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const inactive = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/a', shortCode: uniqueCode('off'), isActive: false });
  const expired = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/b',
    shortCode: uniqueCode('expired'),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const live = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/c',
    shortCode: uniqueCode('live'),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const visitor = newClientIp();

  const a = await openShortLink(inactive.shortCode, visitor);
  expect([a.status, a.body.message]).toEqual([404, 'Link is no longer active']);
  const b = await openShortLink(expired.shortCode, visitor);
  expect([b.status, b.body.message]).toEqual([404, 'Link has expired']);
  const c = await openShortLink(live.shortCode, visitor);
  expect([c.status, c.location]).toEqual([302, 'https://example.com/c']);

  // C's writes landing show the refused requests' would have too.
  await waitForClicks(live.id, 1);
  await waitForTouchpoints(live.id, 1);
  for (const link of [inactive, expired]) {
    expect([link.shortCode, await countClicks(link.id), await countTouchpoints(link.id)]).toEqual([link.shortCode, 0, 0]);
  }
});

test('LINK-176 a suspended tenant\'s links show an unavailable page', async ({ page, browser, baseURL, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/susp',
    shortCode: uniqueCode('susp-1'),
    iosUrl: 'https://example.com/app/susp',
  });
  const variant = await seedVariant(owner, link.id, clientIp, { name: 'Only', longUrl: 'https://example.com/susp-variant', weight: 100 });
  await setSuspended(owner.userId, true);

  try {
    const { context: phone } = await mobileContext(browser, 'ios', { baseURL });
    for (const tab of [page, await phone.newPage()]) {
      await stubHosts(tab, ['example.com']);
      await routeRedirectHop(tab);
      const hop = tab.waitForResponse((r) => new URL(r.url()).pathname === `/redirect/${link.shortCode}`);
      await tab.goto(`/${link.shortCode}`);
      const response = await hop;
      expect(response.status()).toBe(404);
      expect(response.headers()['content-type']).toMatch(/^text\/html/);
      expect(response.headers()['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      await expect(tab).toHaveTitle('Link unavailable');
      await expect(tab.getByRole('heading', { name: 'This link is unavailable' })).toBeVisible();
      await expect(tab.getByText('It may have been turned off by its owner.')).toBeVisible();
      await expect(tab.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    }
    await phone.close();
  } finally {
    await setSuspended(owner.userId, false);
  }

  // Reactivated: the next visit redirects, and its click is the only one recorded.
  const landed = page.waitForRequest('https://example.com/susp-variant');
  await page.goto(`/${link.shortCode}`, { waitUntil: 'commit' });
  await landed;
  await waitForClicks(link.id, 1);
  await waitForTouchpoints(link.id, 1);
  expect(await countClicks(link.id)).toBe(1);
  expect(await countTouchpoints(link.id)).toBe(1);
  const [counter] = await sql<{ clicks: number }>('SELECT clicks FROM link_variants WHERE id = $1', [variant.id]);
  expect(counter.clicks).toBe(1);
});

test('LINK-179 device cookie of a do-not-track device is not linked', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const apiKey = await createApiKey(owner, project.id, clientIp);
  const suffix = randomUUID().slice(0, 8);
  const devices = { dnt: `fp_dnt_${suffix}`, tracked: `fp_ok_${suffix}` };
  for (const [kind, fingerprint] of Object.entries(devices)) {
    await api(
      'POST',
      '/api/identity/identify',
      { projectId: project.id, deviceFingerprint: fingerprint, platform: 'web', distinctId: `person-${kind}-${suffix}`, ...(kind === 'dnt' ? { doNotTrack: true } : {}) },
      { apiKey, ip: clientIp },
    );
  }
  const [dntRow] = await sql<{ do_not_track: boolean }>('SELECT do_not_track FROM device_identities WHERE device_fingerprint = $1', [devices.dnt]);
  expect(dntRow.do_not_track).toBe(true);

  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/dnt', shortCode: uniqueCode('dnt') });
  for (const fingerprint of [devices.dnt, devices.tracked]) {
    const response = await rawApi('GET', `/api/${link.shortCode}`, undefined, { ip: newClientIp(), headers: { Cookie: `chumbaq_did=${fingerprint}` } });
    expect(response.status).toBe(302);
  }
  await waitForClicks(link.id, 2);
  await waitForTouchpoints(link.id, 1);

  const [tracked] = await sql<{ id: string }>('SELECT id FROM device_identities WHERE device_fingerprint = $1', [devices.tracked]);
  const clicks = await sql('SELECT device_identity_id, distinct_id FROM click_events WHERE link_id = $1 ORDER BY clicked_at', [link.id]);
  expect(clicks).toEqual([
    { device_identity_id: null, distinct_id: null },
    { device_identity_id: tracked.id, distinct_id: `person-tracked-${suffix}` },
  ]);
  const touchpoints = await sql('SELECT device_fingerprint FROM touchpoints WHERE link_id = $1', [link.id]);
  expect(touchpoints).toEqual([{ device_fingerprint: devices.tracked }]);

  const summary = await api<{ totalClicks: number }>('GET', `/api/links/${link.id}/analytics`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(summary.totalClicks).toBe(2);
});

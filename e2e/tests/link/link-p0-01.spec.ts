import { randomUUID } from 'crypto';
import { createAccount, createApiKey, createProject, newClientIp, type Account, type Project } from '../../support/api';
import { readDownload } from '../../support/browser-tools';
import { expect, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  addProjectMember,
  countLinks,
  labelledBlock,
  linkActionsButton,
  openShortLink,
  openViewAs,
  rawApi,
  seedLink,
  seedVariant,
  singleSegmentGetRoutes,
  sql,
  startViewAs,
  toast,
  uniqueCode,
  viewAsToken,
  waitForClicks,
} from '../../support/areas/link';

/**
 * Links: the list, creating a link (custom, taken and reserved codes, deep links and
 * their parameters), released short codes, bulk import, the detail page (overview,
 * stats, export) and A/B variants with the redirect that follows their weights.
 */

const PROJECT_NOT_FOUND = 'Project not found';
const READ_ONLY = 'Impersonation sessions are read-only';

async function ownerWithProject(ip: string, label = 'links'): Promise<{ owner: Account; project: Project }> {
  const owner = await createAccount(ip, label, 'Lina Links');
  const project = await createProject(owner, ip);
  return { owner, project };
}

function shortDate(date: Date): string {
  // date-fns 'MMM d, yyyy', as the dashboard formats it.
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Holds matching requests for a moment, so the button's sending state can be seen. */
async function slowDown(page: import('@playwright/test').Page, pattern: string, method: string, ms = 800): Promise<void> {
  await page.route(pattern, async (route) => {
    if (route.request().method() === method) await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

// ---- A. Links list

test('LINK-001 links list shows the project links newest first', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const codes: string[] = [];
  for (const title of ['First', 'Second', 'Third']) {
    const link = await seedLink(owner, project.id, clientIp, { longUrl: `https://example.com/${title.toLowerCase()}`, title, shortCode: uniqueCode(title.toLowerCase()) });
    codes.push(link.shortCode);
  }

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/settings`);
  await sidebarLink(page, 'Links').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links$`));
  await expect(page.getByRole('heading', { name: 'Links', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Link' })).toBeVisible();

  const headers = page.getByRole('columnheader');
  await expect(headers).toHaveText(['Title', 'Short Code', 'Clicks', 'Created', 'Status', '']);

  const rows = page.getByRole('table').locator('tbody').getByRole('row');
  await expect(rows).toHaveCount(3);
  const today = shortDate(new Date());
  const expected = [
    { title: 'Third', code: codes[2] },
    { title: 'Second', code: codes[1] },
    { title: 'First', code: codes[0] },
  ];
  for (const [i, { title, code }] of expected.entries()) {
    const cells = rows.nth(i).getByRole('cell');
    await expect(cells.nth(0)).toHaveText(title);
    const codeCell = cells.nth(1).locator('code');
    await expect(codeCell).toHaveText(code);
    await expect(codeCell).toHaveClass(/font-mono/);
    await expect(cells.nth(2)).toHaveText('0');
    await expect(cells.nth(3)).toHaveText(today);
    await expect(cells.nth(4)).toHaveText('Active');
  }
});

test('LINK-021 link title with HTML is shown as text in the list', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const title = '<img src=x onerror=alert(1)>';
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/xss', title, tags: ['<b>bold</b>'] });

  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  const row = page.getByRole('table').locator('tbody').getByRole('row');
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell').first()).toContainText(title);
  await expect(row.locator('[data-slot="badge"]', { hasText: '<b>bold</b>' })).toBeVisible();
  await expect(row.locator('img')).toHaveCount(0);
  await expect(row.locator('b')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(dialogs).toBe(0);
});

test('LINK-023 links of another project are never listed', async ({ clientIp }) => {
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const mine = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/mine' });
  const theirs = await seedLink(x, p2.id, clientIp, { longUrl: 'https://example.com/theirs' });

  const foreign = await rawApi('GET', `/api/projects/${p2.id}/links`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(foreign.status).toBe(404);
  expect(foreign.body.message).toBe(PROJECT_NOT_FOUND);

  const own = await rawApi('GET', `/api/projects/${p1.id}/links`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(own.status).toBe(200);
  const ids = (own.body.data as { id: string }[]).map((link) => link.id);
  expect(ids).toEqual([mine.id]);
  expect(ids).not.toContain(theirs.id);
});

// ---- B. Create link

test('LINK-025 create a link with only a destination URL', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await page.getByRole('button', { name: 'Create Link' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
  await page.getByLabel('Destination URL').fill('https://example.com/page');

  await slowDown(page, `**/api/projects/${project.id}/links`, 'POST');
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Link' }).click();
  await expect(page.getByRole('button', { name: 'Creating...' })).toBeVisible();
  const response = await created;
  expect(response.status()).toBe(201);
  const link = ((await response.json()) as { data: { id: string; shortCode: string } }).data;
  expect(link.shortCode).toMatch(/^[A-Za-z0-9_-]{7}$/);

  const done = toast(page, 'Link created');
  await expect(done).toBeVisible();
  await expect(done).toContainText(`Short code: ${link.shortCode}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));

  const [row] = await sql(
    `SELECT short_code, is_active, long_url, title, tags, ios_url, android_url, ios_fallback_url, android_fallback_url,
            og_title, og_description, og_image_url, deep_link_params, expires_at
       FROM links WHERE id = $1`,
    [link.id],
  );
  expect(row).toEqual({
    short_code: link.shortCode,
    is_active: true,
    long_url: 'https://example.com/page',
    title: null,
    tags: null,
    ios_url: null,
    android_url: null,
    ios_fallback_url: null,
    android_fallback_url: null,
    og_title: null,
    og_description: null,
    og_image_url: null,
    deep_link_params: null,
    expires_at: null,
  });
});

test('LINK-030 custom short code is created and used', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('spring-sale_26');
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('https://example.com/spring');
  await page.getByLabel('Custom short link').fill(code);
  await page.getByRole('button', { name: 'Create Link' }).click();

  await expect(toast(page, 'Link created')).toContainText(`Short code: ${code}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/[0-9a-f-]{36}$`));
  const origin = new URL(page.url()).origin;
  await expect(labelledBlock(page, 'Short URL').locator('xpath=..').locator('code')).toHaveText(`${origin}/${code}`);

  const redirect = await openShortLink(code, newClientIp());
  expect(redirect.status).toBe(302);
  expect(redirect.location).toBe('https://example.com/spring');
});

test('LINK-033 custom short code already taken', async ({ page, clientIp }) => {
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const inOwnProject = uniqueCode('taken-code');
  const inOtherTenant = uniqueCode('taken-code');
  await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/holder', shortCode: inOwnProject });
  await seedLink(x, p2.id, clientIp, { longUrl: 'https://example.com/holder', shortCode: inOtherTenant });
  const before = await countLinks(p1.id);

  await signIn(page, owner);
  for (const code of [inOwnProject, inOtherTenant]) {
    const message = `Short code "${code}" is already taken`;
    const direct = await rawApi('POST', `/api/projects/${p1.id}/links`, { longUrl: 'https://example.com/again', shortCode: code }, { token: owner.accessToken, ip: clientIp });
    expect(direct.status).toBe(409);
    expect(direct.body.message).toBe(message);

    await page.goto(`/projects/${p1.id}/links/new`);
    await page.getByLabel('Destination URL').fill('https://example.com/again');
    await page.getByLabel('Custom short link').fill(code);
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p1.id}/links`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create Link' }).click();
    expect((await answered).status()).toBe(409);
    const error = toast(page, 'Error').filter({ hasText: message });
    await expect(error).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${p1.id}/links/new$`));
  }
  expect(await countLinks(p1.id)).toBe(before);
});

const RESERVED = [
  'api', 'health', 'admin', 'impersonate', 'invite', 'www', 'app', 'auth', 'login', 'logout', 'signup', 'register',
  'dashboard', 'settings', 'help', 'support', 'about', 'terms', 'privacy', 'contact', 'docs', 'static', 'assets',
  'public', 'projects', 'links', 'well-known', 'verify-email', 'forgot-password', 'reset-password', 'complete-signup',
  'account',
];

async function expectReserved(owner: Account, projectId: string, words: string[]): Promise<string[]> {
  const accepted: string[] = [];
  let ip = newClientIp();
  for (const [i, word] of words.entries()) {
    if (i % 25 === 0) ip = newClientIp(); // stay well under the per-address throttle
    const response = await rawApi('POST', `/api/projects/${projectId}/links`, { longUrl: 'https://example.com/reserved', shortCode: word }, { token: owner.accessToken, ip });
    if (response.status !== 409 || response.body.message !== `"${word}" is a reserved word and cannot be used as a short code`) {
      accepted.push(`${word}: ${response.status} ${JSON.stringify(response.body?.message ?? response.body)}`);
    }
  }
  return accepted;
}

test('LINK-035 reserved words cannot be short codes', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  expect(await expectReserved(owner, project.id, RESERVED)).toEqual([]);
  expect(await countLinks(project.id)).toBe(0);
});

test('LINK-035 every single-segment GET route of the API is a reserved word', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'LINK-035' });
  test.fail();
  const words = singleSegmentGetRoutes();
  // The reader must see the routes it is meant to guard, or this proves nothing.
  expect(words).toEqual(expect.arrayContaining(['health', 'projects']));
  const { owner, project } = await ownerWithProject(clientIp);
  expect(await expectReserved(owner, project.id, words)).toEqual([]);
  expect(await countLinks(project.id)).toBe(0);
});

test('LINK-044 deep link URLs with http(s) are saved', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('https://example.com/web');
  await page.getByRole('tab', { name: 'Deep Linking' }).click();
  await page.getByPlaceholder('myapp://path').nth(0).fill('https://example.com/app/item/1');
  await page.getByPlaceholder('myapp://path').nth(1).fill('https://example.com/app/item/1');
  await page.getByPlaceholder('https://apps.apple.com/...').fill('https://apps.apple.com/app/id999');
  await page.getByPlaceholder('https://play.google.com/...').fill('https://play.google.com/store/apps/details?id=com.x');
  await page.getByRole('button', { name: 'Create Link' }).click();

  await expect(toast(page, 'Link created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/[0-9a-f-]{36}$`));
  const linkId = page.url().split('/').pop()!;
  const stored = await rawApi('GET', `/api/links/${linkId}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(stored.body.data).toMatchObject({
    longUrl: 'https://example.com/web',
    iosUrl: 'https://example.com/app/item/1',
    androidUrl: 'https://example.com/app/item/1',
    iosFallbackUrl: 'https://apps.apple.com/app/id999',
    androidFallbackUrl: 'https://play.google.com/store/apps/details?id=com.x',
  });
  const platforms = labelledBlock(page, 'Platforms');
  await expect(platforms.locator('[data-slot="badge"]', { hasText: 'iOS' })).toHaveAttribute('data-variant', 'default');
  await expect(platforms.locator('[data-slot="badge"]', { hasText: 'Android' })).toHaveAttribute('data-variant', 'default');
});

test('LINK-045 custom-scheme deep links are saved', async ({ page, clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'LINK-045' });
  test.fail();
  const { owner, project } = await ownerWithProject(clientIp);

  const direct = await rawApi('POST', `/api/projects/${project.id}/links`, { longUrl: 'https://example.com', androidUrl: 'myapp://x' }, { token: owner.accessToken, ip: clientIp });
  expect(direct.status).toBe(201);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('https://example.com');
  await page.getByRole('tab', { name: 'Deep Linking' }).click();
  await page.getByPlaceholder('myapp://path').nth(0).fill('myapp://product/123');
  await page.getByRole('button', { name: 'Create Link' }).click();
  await expect(toast(page, 'Link created')).toBeVisible({ timeout: 5000 });
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/[0-9a-f-]{36}$`));
});

test('LINK-048 deep link parameters: a JSON object is saved', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('https://example.com/product');
  await page.getByRole('tab', { name: 'Deep Linking' }).click();
  await page.getByPlaceholder('{"screen": "product", "id": "123"}').fill('{"screen": "product", "id": "123"}');
  await page.getByRole('button', { name: 'Create Link' }).click();
  await expect(toast(page, 'Link created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/[0-9a-f-]{36}$`));
  const linkId = page.url().split('/').pop()!;

  const params = { screen: 'product', id: '123' };
  const stored = await rawApi('GET', `/api/links/${linkId}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(stored.body.data.deepLinkParams).toEqual(params);
  const [row] = await sql<{ deep_link_params: unknown }>('SELECT deep_link_params FROM links WHERE id = $1', [linkId]);
  expect(row.deep_link_params).toEqual(params);

  await page.goto(`/projects/${project.id}/links/${linkId}/edit`);
  await expect(page.getByRole('heading', { name: 'Edit Link' })).toBeVisible();
  await page.getByRole('tab', { name: 'Deep Linking' }).click();
  const textarea = page.locator('div.space-y-2', { hasText: 'Deep Link Parameters (JSON)' }).locator('textarea');
  // Pretty-printed, two spaces; jsonb keeps its own key order (shorter keys first).
  await expect(textarea).toHaveValue(/^\{\n {2}"/);
  const shown = await textarea.inputValue();
  expect(JSON.parse(shown)).toEqual(params);
  expect(shown).toBe(JSON.stringify(JSON.parse(shown), null, 2));
});

test('LINK-059 a non-member cannot create a link in someone else\'s project', async ({ clientIp }) => {
  const { project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: o2 } = await ownerWithProject(clientIp, 'owner-o2');
  const { project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const n = await createAccount(clientIp, 'nobody', 'Nora Nobody');
  const body = { longUrl: 'https://example.com/intruder' };

  const asN = await rawApi('POST', `/api/projects/${p1.id}/links`, body, { token: n.accessToken, ip: clientIp });
  expect([asN.status, asN.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const asO = await rawApi('POST', `/api/projects/${p2.id}/links`, body, { token: o2.accessToken, ip: clientIp });
  expect([asO.status, asO.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const malformed = await rawApi('POST', '/api/projects/not-a-uuid/links', body, { token: n.accessToken, ip: clientIp });
  expect([malformed.status, malformed.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const anonymous = await rawApi('POST', `/api/projects/${p1.id}/links`, body, { ip: clientIp });
  expect(anonymous.status).toBe(401);

  expect(await countLinks(p1.id)).toBe(0);
  expect(await countLinks(p2.id)).toBe(0);
});

test('LINK-060 view-as cannot create a link', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/existing' });
  const before = await countLinks(project.id);

  const viewAs = await openViewAs(browser, baseURL, await startViewAs(browser, baseURL, owner));
  await viewAs.goto(`/projects/${project.id}/links/new`);
  await viewAs.getByLabel('Destination URL').fill('https://example.com/while-viewing');
  const answered = viewAs.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.request().method() === 'POST');
  await viewAs.getByRole('button', { name: 'Create Link' }).click();
  const response = await answered;
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(toast(viewAs, 'Read-only session')).toContainText(READ_ONLY);
  await expect(toast(viewAs, 'Error')).toContainText(READ_ONLY);
  await expect(viewAs).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
  expect(await countLinks(project.id)).toBe(before);
  await viewAs.context().close();
});

// ---- C. Released short codes

test('LINK-061 deleting a link releases its code to its own project only', async ({ clientIp }) => {
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const code = uniqueCode('gone-soon');
  const link = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/soon', shortCode: code });
  const deleted = await rawApi('DELETE', `/api/links/${link.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(deleted.status).toBe(200);

  const released = await sql<{ short_code: string; project_id: string }>('SELECT short_code, project_id FROM released_short_codes WHERE short_code = $1', [code]);
  expect(released).toEqual([{ short_code: code, project_id: p1.id }]);

  const byOther = await rawApi('POST', `/api/projects/${p2.id}/links`, { longUrl: 'https://example.com/steal', shortCode: code }, { token: x.accessToken, ip: clientIp });
  expect(byOther.status).toBe(409);
  expect(byOther.body.message).toBe(`Short code "${code}" is already taken`);
  expect(await countLinks(p2.id)).toBe(0);

  const back = await rawApi('POST', `/api/projects/${p1.id}/links`, { longUrl: 'https://example.com/back', shortCode: code }, { token: owner.accessToken, ip: clientIp });
  expect(back.status).toBe(201);
  expect(back.body.data.shortCode).toBe(code);
});

test('LINK-062 a released code no longer redirects', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('old-promo');
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/promo', shortCode: code });
  await rawApi('DELETE', `/api/links/${link.id}`, undefined, { token: owner.accessToken, ip: clientIp });

  const visitor = newClientIp();
  const redirect = await openShortLink(code, visitor);
  expect(redirect.status).toBe(404);
  expect(redirect.headers.get('content-type')).toMatch(/application\/json/);
  expect(redirect.body.message).toBe('Link not found');
  const preview = await rawApi('GET', `/api/${code}/preview`, undefined, { ip: visitor });
  expect(preview.status).toBe(404);
  expect(preview.body.message).toBe('Link not found');

  await new Promise((resolve) => setTimeout(resolve, 500));
  const [clicks] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM click_events WHERE ip_address = $1', [visitor]);
  expect(clicks.n).toBe('0');
});

// ---- D. Bulk import

test('LINK-066 bulk import creates links from a CSV', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/bulk-import`);
  await expect(page.getByRole('heading', { name: 'Bulk Import Links' })).toBeVisible();
  const csv = [
    'longUrl,title,tags,iosUrl,androidUrl,ogTitle,ogDescription',
    'https://example.com/1,One,a;b,https://example.com/i,https://example.com/a,OG1,D1',
    'https://example.com/2,Two,,,,,',
  ].join('\n');
  await page.locator('input[type=file]').setInputFiles({ name: 'links.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('links.csv')).toBeVisible();

  await slowDown(page, `**/api/projects/${project.id}/links/bulk`, 'POST');
  await page.getByRole('button', { name: 'Import Links' }).click();
  await expect(page.getByRole('button', { name: 'Uploading...' })).toBeVisible();
  await expect(toast(page, 'Created 2 of 2 links')).toBeVisible();
  const results = page.locator('[data-slot="card"]', { hasText: 'Import Results' });
  await expect(results).toContainText('2 created');
  await expect(results).not.toContainText('errors');
  await expect(results).not.toContainText('Row ');

  const listed = await rawApi('GET', `/api/projects/${project.id}/links`, undefined, { token: owner.accessToken, ip: clientIp });
  const links = listed.body.data as { title: string; shortCode: string; tags: string[] | null; longUrl: string; iosUrl: string | null; androidUrl: string | null; ogTitle: string | null; ogDescription: string | null }[];
  expect(links).toHaveLength(2);
  const one = links.find((link) => link.title === 'One')!;
  const two = links.find((link) => link.title === 'Two')!;
  expect(one).toMatchObject({ longUrl: 'https://example.com/1', tags: ['a', 'b'], iosUrl: 'https://example.com/i', androidUrl: 'https://example.com/a', ogTitle: 'OG1', ogDescription: 'D1' });
  expect(two).toMatchObject({ longUrl: 'https://example.com/2', tags: null, iosUrl: null, androidUrl: null, ogTitle: null, ogDescription: null });
  for (const link of links) expect(link.shortCode).toMatch(/^[A-Za-z0-9_-]{7}$/);

  await page.goto(`/projects/${project.id}/links`);
  const rows = page.getByRole('table').locator('tbody').getByRole('row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'One' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Two' })).toHaveCount(1);
});

test('LINK-070 bulk import validates URLs like the single create', async ({ page, clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'LINK-070' });
  test.fail();
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/bulk-import`);
  const csv = ['longUrl,title,tags,iosUrl', 'not a url,,,', 'javascript:alert(document.domain),,,', 'https://example.com,,,javascript:alert(1)'].join('\n');
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Import Links' }).click();
  const results = page.locator('[data-slot="card"]', { hasText: 'Import Results' });
  await expect(results).toBeVisible();
  expect(await countLinks(project.id)).toBe(0);
  await expect(results).toContainText('0 created');
  await expect(results).toContainText('3 errors');
  await expect(results).toContainText('Row 1: longUrl must be a URL address');
});

// ---- E. Link detail

test('LINK-081 detail page loads with the Overview tab', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('launch-1');
  await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/launch',
    title: 'Launch',
    shortCode: code,
    iosUrl: 'https://example.com/app/launch',
    androidUrl: 'https://example.com/app/launch',
    tags: ['a', 'b'],
  });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await page.getByRole('row', { name: /Launch/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/[0-9a-f-]{36}$`));

  await expect(page.getByRole('tab')).toHaveText(['Overview', 'Geography', 'Referrers & Conversions', 'A/B Testing']);
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await expect(linkActionsButton(page)).toBeVisible();
  for (const tile of ['Total Clicks', 'Unique Visitors', 'Store Redirects', 'Installs', 'Conversion']) {
    await expect(page.getByText(tile, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Click Trends', { exact: true })).toBeVisible();
  for (const range of ['7d', '30d', '90d']) await expect(page.getByRole('button', { name: range, exact: true })).toBeVisible();

  const origin = new URL(page.url()).origin;
  await expect(labelledBlock(page, 'Short URL').locator('xpath=..').locator('code')).toHaveText(`${origin}/${code}`);
  await expect(labelledBlock(page, 'Destination').getByRole('link')).toHaveText('https://example.com/launch');
  await expect(labelledBlock(page, 'Destination').getByRole('link')).toHaveAttribute('href', 'https://example.com/launch');
  await expect(labelledBlock(page, 'Created')).toContainText(shortDate(new Date()));
  await expect(labelledBlock(page, 'Expires')).toHaveText(/Expires\s*Never/);
  const platforms = labelledBlock(page, 'Platforms');
  await expect(platforms.locator('[data-slot="badge"]', { hasText: 'iOS' })).toHaveAttribute('data-variant', 'default');
  await expect(platforms.locator('[data-slot="badge"]', { hasText: 'Android' })).toHaveAttribute('data-variant', 'default');
  await expect(labelledBlock(page, 'Project')).toHaveText(new RegExp(`Project\\s*${project.name}`));
  const tags = page.locator('[data-slot="badge"][data-variant="secondary"]');
  await expect(tags.filter({ hasText: /^a$/ })).toBeVisible();
  await expect(tags.filter({ hasText: /^b$/ })).toBeVisible();
  await expect(page.getByText('Devices & Browsers', { exact: true })).toBeVisible();
});

test('LINK-084 unknown, foreign or malformed link id shows "Link not found"', async ({ page, clientIp }) => {
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const foreign = await seedLink(x, p2.id, clientIp, { longUrl: 'https://example.com/foreign-secret', title: 'Foreign secret title' });
  await signIn(page, owner);

  for (const id of [randomUUID(), foreign.id, 'abc']) {
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/links/${id}`) && r.request().method() === 'GET');
    await page.goto(`/projects/${p1.id}/links/${id}`);
    const response = await answered;
    expect(response.status()).toBe(404);
    expect(((await response.json()) as { message: string }).message).toBe(PROJECT_NOT_FOUND);
    await expect(page.getByText('Link not found', { exact: true })).toBeVisible();
    await expect(page.getByText('Foreign secret title')).toHaveCount(0);
    await expect(page.getByText('foreign-secret')).toHaveCount(0);
    await expect(page.getByText(foreign.shortCode)).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Back to links' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p1.id}/links$`));
});

test('LINK-086 stat tiles show the link summary', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const apiKey = await createApiKey(owner, project.id, clientIp);
  const link = await seedLink(owner, project.id, clientIp, {
    longUrl: 'https://example.com/stats',
    shortCode: uniqueCode('stats'),
    iosUrl: 'https://example.com/app/stats',
  });
  const repeat = '203.0.113.1';
  for (const ip of [repeat, repeat, newClientIp(), newClientIp()]) {
    expect((await openShortLink(link.shortCode, ip)).status).toBe(302);
  }
  await waitForClicks(link.id, 4);

  const match = await rawApi<{ data: { matched: boolean } }>('POST', '/api/deferred/match', { cookieRef: link.shortCode }, { apiKey, ip: repeat });
  expect(match.body.data.matched).toBe(true);
  for (const eventType of ['signup', 'purchase', 'purchase']) {
    const conversion = await rawApi('POST', '/api/conversions', { shortCode: link.shortCode, eventType }, { apiKey, ip: clientIp });
    expect(conversion.status).toBe(201);
  }

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/${link.id}`);
  await expect(labelledBlock(page, 'Total Clicks')).toHaveText(/^Total Clicks\s*4$/);
  await expect(labelledBlock(page, 'Unique Visitors')).toHaveText(/^Unique Visitors\s*3$/);
  await expect(labelledBlock(page, 'Store Redirects')).toHaveText(/^Store Redirects\s*0$/);
  await expect(labelledBlock(page, 'Installs')).toHaveText(/^Installs\s*1$/);
  await expect(labelledBlock(page, 'Conversion')).toHaveText(/^Conversion\s*25\.0%$/);
});

test('LINK-108 export CSV from the detail page', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/export', shortCode: uniqueCode('export') });
  const visitors = ['198.51.100.11', '198.51.100.12', '198.51.100.13'];
  for (const [i, ip] of visitors.entries()) {
    expect((await openShortLink(link.shortCode, ip)).status).toBe(302);
    await waitForClicks(link.id, i + 1); // one at a time, so the click times are in this order
  }
  const ordered = await sql<{ id: string }>('SELECT id FROM click_events WHERE link_id = $1 ORDER BY clicked_at DESC', [link.id]);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/${link.id}`);
  await linkActionsButton(page).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export CSV' }).click()]);
  const file = await readDownload(download);
  expect(file.filename).toBe(`analytics-${link.id}.csv`);
  expect(file.lines[0]).toBe('id,clicked_at,ip_address,platform,device_type,os,browser,country,city,referrer,redirect_type');
  const rows = file.lines.slice(1);
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.split(',')[0])).toEqual(ordered.map((row) => row.id));
  expect(rows.map((row) => row.split(',')[2])).toEqual([...visitors].reverse());
});

test('LINK-109 export CSV refused in view-as', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/export', shortCode: uniqueCode('noexport') });
  expect((await openShortLink(link.shortCode, newClientIp())).status).toBe(302);

  const viewAs = await openViewAs(browser, baseURL, await startViewAs(browser, baseURL, owner));
  await viewAs.goto(`/projects/${project.id}/links/${link.id}`);
  await expect(viewAs.getByRole('tab', { name: 'Overview' })).toBeVisible();
  let downloads = 0;
  viewAs.on('download', () => downloads++);
  const answered = viewAs.waitForResponse((r) => r.url().includes(`/api/links/${link.id}/analytics/export`));
  await linkActionsButton(viewAs).click();
  await viewAs.getByRole('menuitem', { name: 'Export CSV' }).click();
  const response = await answered;
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(toast(viewAs, 'Export failed')).toBeVisible();
  await expect(toast(viewAs, 'Read-only session')).toHaveCount(0);
  await viewAs.waitForTimeout(3000);
  expect(downloads).toBe(0);
  await viewAs.context().close();
});

// ---- F. A/B variants

test('LINK-112 add a variant', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/a', shortCode: uniqueCode('ab') });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/${link.id}`);
  await page.getByRole('tab', { name: 'A/B Testing' }).click();
  await page.getByRole('button', { name: 'Add First Variant' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add A/B Test Variant' });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('e.g., Variant B').fill('Variant B');
  await dialog.getByPlaceholder('https://example.com/page-b').fill('https://example.com/b');
  await dialog.locator('input[type=number]').fill('30');
  await slowDown(page, `**/api/links/${link.id}/variants`, 'POST');
  await dialog.getByRole('button', { name: 'Add Variant' }).click();
  await expect(dialog.getByRole('button', { name: 'Adding...' })).toBeVisible();
  await expect(dialog).toBeHidden();

  const row = page.locator('div.rounded-lg.border', { hasText: 'Variant B' });
  await expect(row).toContainText('https://example.com/b');
  await expect(row).toContainText('30% traffic');
  await expect(row).toContainText('0 clicks');
  const stored = await sql<{ name: string; long_url: string; weight: number }>('SELECT name, long_url, weight FROM link_variants WHERE link_id = $1', [link.id]);
  expect(stored).toEqual([{ name: 'Variant B', long_url: 'https://example.com/b', weight: 30 }]);

  // The form starts afresh next time.
  await page.getByRole('button', { name: 'Add Variant', exact: true }).click();
  await expect(dialog.getByPlaceholder('e.g., Variant B')).toHaveValue('');
  await expect(dialog.getByPlaceholder('https://example.com/page-b')).toHaveValue('');
  await expect(dialog.locator('input[type=number]')).toHaveValue('50');
});

test('LINK-119 a variant id must belong to the link in the URL', async ({ clientIp }) => {
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const l1 = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/l1' });
  const l2 = await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/l2' });
  const foreignLink = await seedLink(x, p2.id, clientIp, { longUrl: 'https://example.com/l9' });
  const v2 = await seedVariant(owner, l2.id, clientIp, { name: 'V2', longUrl: 'https://example.com/v2', weight: 40 });
  const v9 = await seedVariant(x, foreignLink.id, clientIp, { name: 'V9', longUrl: 'https://example.com/v9', weight: 60 });
  const auth = { token: owner.accessToken, ip: clientIp };

  const patch = await rawApi('PATCH', `/api/links/${l1.id}/variants/${v2.id}`, { name: 'moved' }, auth);
  expect([patch.status, patch.body.message]).toEqual([404, 'Variant not found']);
  const remove = await rawApi('DELETE', `/api/links/${l1.id}/variants/${v2.id}`, undefined, auth);
  expect([remove.status, remove.body.message]).toEqual([404, 'Variant not found']);
  const foreign = await rawApi('PATCH', `/api/links/${l1.id}/variants/${v9.id}`, { name: 'taken' }, auth);
  expect([foreign.status, foreign.body.message]).toEqual([404, 'Variant not found']);
  const malformed = await rawApi('PATCH', `/api/links/${l1.id}/variants/not-a-uuid`, { name: 'x' }, auth);
  expect([malformed.status, malformed.body.message]).toEqual([400, 'Validation failed (uuid is expected)']);

  const rows = await sql<{ id: string; link_id: string; name: string; weight: number }>(
    'SELECT id, link_id, name, weight FROM link_variants WHERE id = ANY($1) ORDER BY name',
    [[v2.id, v9.id]],
  );
  expect(rows).toEqual([
    { id: v2.id, link_id: l2.id, name: 'V2', weight: 40 },
    { id: v9.id, link_id: foreignLink.id, name: 'V9', weight: 60 },
  ]);
});

test('LINK-120 variant routes for other projects and roles', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/roles' });
  const existing = await seedVariant(owner, link.id, clientIp, { name: 'Existing', longUrl: 'https://example.com/existing' });
  const variants = `/api/links/${link.id}/variants`;
  const variantBody = { name: 'By someone', longUrl: 'https://example.com/someone' };

  const n = await createAccount(clientIp, 'nobody', 'Nora Nobody');
  const asN = { token: n.accessToken, ip: clientIp };
  for (const [method, urlPath, body] of [
    ['GET', variants, undefined],
    ['POST', variants, variantBody],
    ['PATCH', `${variants}/${existing.id}`, { name: 'Hijacked' }],
    ['DELETE', `${variants}/${existing.id}`, undefined],
  ] as const) {
    const response = await rawApi(method, urlPath, body, asN);
    expect([method, response.status, response.body.message]).toEqual([method, 404, PROJECT_NOT_FOUND]);
  }

  for (const role of ['member', 'admin'] as const) {
    const person = await addProjectMember(owner, project.id, role, clientIp);
    const auth = { token: person.accessToken, ip: clientIp };
    const created = await rawApi('POST', variants, { ...variantBody, name: `By ${role}` }, auth);
    expect([role, created.status]).toEqual([role, 201]);
    const removed = await rawApi('DELETE', `${variants}/${created.body.data.id}`, undefined, auth);
    expect([role, removed.status]).toEqual([role, 200]);
  }

  const token = await viewAsToken(browser, baseURL, owner);
  const asStaff = { token, ip: newClientIp() };
  const read = await rawApi('GET', variants, undefined, asStaff);
  expect(read.status).toBe(200);
  expect((read.body.data as { id: string }[]).map((variant) => variant.id)).toEqual([existing.id]);
  const write = await rawApi('POST', variants, variantBody, asStaff);
  expect([write.status, write.body.message]).toEqual([403, READ_ONLY]);

  const [left] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM link_variants WHERE link_id = $1', [link.id]);
  expect(left.n).toBe('1');
});

test('LINK-121 redirect follows variant weights', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/original', shortCode: uniqueCode('ab-link') });
  const a = await seedVariant(owner, link.id, clientIp, { name: 'A', longUrl: 'https://example.com/a', weight: 100 });
  const b = await seedVariant(owner, link.id, clientIp, { name: 'B', longUrl: 'https://example.com/b', weight: 0 });

  const locations: (string | null)[] = [];
  for (let i = 0; i < 20; i++) {
    const response = await openShortLink(link.shortCode, newClientIp());
    expect(response.status).toBe(302);
    locations.push(response.location);
  }
  expect(new Set(locations)).toEqual(new Set(['https://example.com/a']));
  const clicks = await sql<{ id: string; clicks: number }>('SELECT id, clicks FROM link_variants WHERE link_id = $1', [link.id]);
  expect(Object.fromEntries(clicks.map((row) => [row.id, row.clicks]))).toEqual({ [a.id]: 20, [b.id]: 0 });

  // Even weights: over 200 requests both destinations appear.
  const even = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/original', shortCode: uniqueCode('ab-even') });
  await seedVariant(owner, even.id, clientIp, { name: 'A', longUrl: 'https://example.com/even-a', weight: 50 });
  await seedVariant(owner, even.id, clientIp, { name: 'B', longUrl: 'https://example.com/even-b', weight: 50 });
  const seen = new Set<string | null>();
  for (let i = 0; i < 200; i++) seen.add((await openShortLink(even.shortCode, newClientIp())).location);
  expect(seen).toEqual(new Set(['https://example.com/even-a', 'https://example.com/even-b']));
});


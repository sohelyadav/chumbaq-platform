import type { Page, Request } from '@playwright/test';
import { createAccount, createProject, newClientIp, type Account, type Project } from '../../support/api';
import { allowClipboard, readClipboard } from '../../support/browser-tools';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  addProjectMember,
  countLinks,
  DESKTOP_UA,
  joinProject,
  labelledBlock,
  linkRows,
  openShortLink,
  openViewAs,
  rawApi,
  rawBulkImport,
  seedLink,
  seedLinks,
  sql,
  startViewAs,
  storedLinks,
  toast,
  uniqueCode,
  viewAsTokenFrom,
  waitUntil,
} from '../../support/areas/link';

/**
 * Links, second pass: the list (empty state, navigation, copy, status badges, click
 * counts, search, tag filter, pagination, roles, view-as), creating a link (form and
 * API validation, reserved codes, races, title and tags, inactive and expiring links,
 * roles), released codes when a project is deleted, and bulk import (missing URLs,
 * byte-order marks, malformed and refused files, roles and view-as).
 */

test.describe.configure({ mode: 'parallel' });

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

/** Records the link-create POSTs of a page, to show that a refused form sent nothing. */
function recordCreates(page: Page, projectId: string): Request[] {
  const posts: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/api/projects/${projectId}/links`)) posts.push(request);
  });
  return posts;
}

function isListRequest(url: string, projectId: string): boolean {
  return new URL(url).pathname === `/api/projects/${projectId}/links`;
}

// ---- A. Links list

test('LINK-004 empty state links to creating the first link', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await expect(page.getByText('No links found.')).toContainText('No links found. Create your first link');
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('link', { name: 'Create your first link' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
  await expect(page.getByRole('heading', { name: 'Create Link' })).toBeVisible();
});

test('LINK-005 Create Link button opens the create page', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/one', title: 'One' });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await expect(linkRows(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Create Link' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
  await expect(page.getByRole('heading', { name: 'Create Link' })).toBeVisible();
});

test('LINK-006 row click opens the link detail page', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/other', title: 'Other link' });
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/l1', title: 'L1 title' });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await page.getByRole('row', { name: /L1 title/ }).getByRole('cell').first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
});

test('LINK-008 copy short URL from a list row', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const code = uniqueCode('copy-me');
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/copy', title: 'Copy target', shortCode: code });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await allowClipboard(page);
  const listUrl = page.url();
  const row = page.getByRole('row', { name: /Copy target/ });
  const button = row.locator('button').first();
  await expect(button.locator('svg.lucide-copy')).toBeVisible();

  await button.click();
  await expect(button.locator('svg.text-green-600')).toBeVisible();
  expect(await readClipboard(page)).toBe(`${new URL(page.url()).origin}/${code}`);
  expect(page.url()).toBe(listUrl);
  // The check mark goes back to the copy icon after about two seconds.
  await expect(button.locator('svg.text-green-600')).toHaveCount(0, { timeout: 5000 });
  await expect(button.locator('svg.lucide-copy')).toBeVisible();
  expect(page.url()).toBe(listUrl);
});

test('LINK-010 status badges: Active, Inactive, Expired', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const past = '2020-01-01T00:00:00Z';
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/a', title: 'Status active' });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/b', title: 'Status inactive', isActive: false });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/c', title: 'Status expired', isActive: true, expiresAt: past });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/d', title: 'Status both', isActive: false, expiresAt: past });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await expect(linkRows(page)).toHaveCount(4);
  const statusOf = (title: string) => page.getByRole('row', { name: new RegExp(title) }).getByRole('cell').nth(4);
  await expect(statusOf('Status active')).toHaveText('Active');
  await expect(statusOf('Status inactive')).toHaveText('Inactive');
  await expect(statusOf('Status expired')).toHaveText('Expired');
  await expect(statusOf('Status both')).toHaveText('Inactive');
});

test('LINK-012 clicks column counts the link click events', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const link = await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/count', title: 'Counted', shortCode: uniqueCode('cnt-link') });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/quiet', title: 'Not clicked' });
  const visitor = newClientIp();
  for (let i = 0; i < 3; i++) expect((await openShortLink(link.shortCode, visitor)).status).toBe(302);
  await waitUntil(
    async () => {
      const listed = await rawApi('GET', `/api/projects/${project.id}/links`, undefined, { token: owner.accessToken, ip: clientIp });
      return (listed.body.data as { id: string; clickCount: number }[]).find((l) => l.id === link.id)?.clickCount;
    },
    (count) => count === 3,
    'three counted clicks',
  );

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await expect(page.getByRole('row', { name: /Counted/ }).getByRole('cell').nth(2)).toHaveText('3');
  await expect(page.getByRole('row', { name: /Not clicked/ }).getByRole('cell').nth(2)).toHaveText('0');
});

test('LINK-013 search today: the API refuses the search parameter', async ({ page, clientIp }) => {
  // Today's behaviour as the case states it; the intended behaviour is the next test.
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLinks(owner, project.id, newClientIp(), 24, 'Bulk');
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/summer', title: 'Summer Sale' });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await expect(linkRows(page)).toHaveCount(20);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(linkRows(page)).toHaveCount(5);

  const refused: { status: number; body: unknown; page: string | null; limit: string | null }[] = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (isListRequest(response.url(), project.id) && url.searchParams.get('search') === 'summer') {
      refused.push({ status: response.status(), body: await response.json().catch(() => null), page: url.searchParams.get('page'), limit: url.searchParams.get('limit') });
    }
  });
  await page.getByPlaceholder('Search links...').fill('summer');
  await expect(page.getByText('Failed to load links.')).toBeVisible();
  await expect(page.getByText('Failed to load links.')).toHaveClass(/text-destructive/);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
  // The first request and the query's one retry, both refused.
  await expect.poll(() => refused.length).toBeGreaterThanOrEqual(2);
  for (const answer of refused) {
    expect(answer).toMatchObject({ status: 400, page: '1', limit: '20', body: { message: ['property search should not exist'] } });
  }

  await page.getByPlaceholder('Search links...').fill('');
  await expect(linkRows(page)).toHaveCount(20);
});

test('LINK-013 search filters by title, case-insensitively, and resets to page 1', async ({ page, clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'LINK-013' });
  test.fail();
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLinks(owner, project.id, newClientIp(), 24, 'Bulk');
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/summer', title: 'Summer Sale' });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(linkRows(page)).toHaveCount(5);
  for (const term of ['summer', 'SUMMER', 'Summer']) {
    await page.getByPlaceholder('Search links...').fill(term);
    await expect(linkRows(page)).toHaveCount(1, { timeout: 5000 });
    await expect(linkRows(page).first()).toContainText('Summer Sale');
    await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
  }
});

test('LINK-016 tag filter today: the API refuses the tags parameter', async ({ page, clientIp }) => {
  // Today's behaviour as the case states it; the intended behaviour is the next test.
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/a', title: 'L-a', tags: ['marketing', 'summer'] });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/b', title: 'L-b', tags: ['marketing'] });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/c', title: 'L-c', tags: ['winter'] });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await expect(linkRows(page)).toHaveCount(3);

  const tagged: { status: number; tags: string | null; body: unknown }[] = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (isListRequest(response.url(), project.id) && url.searchParams.has('tags')) {
      tagged.push({ status: response.status(), tags: url.searchParams.get('tags'), body: await response.json().catch(() => null) });
    }
  });
  const full = page.waitForResponse((r) => isListRequest(r.url(), project.id) && new URL(r.url()).searchParams.get('tags') === 'marketing,summer');
  await page.getByPlaceholder('Filter by tags (comma-separated)').pressSequentially('marketing, summer');
  expect((await full).status()).toBe(400);
  await expect(page.getByText('Failed to load links.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  // Refused from the first character typed, and the page sends the tags trimmed.
  expect(tagged.map((answer) => answer.tags)).toContain('m');
  for (const answer of tagged) {
    expect(answer).toMatchObject({ status: 400, body: { message: ['property tags should not exist'] } });
    expect(answer.tags).not.toMatch(/\s|,,|,$/);
  }
});

test('LINK-016 tag filter: comma-separated tags must all match', async ({ page, clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'LINK-016' });
  test.fail();
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/a', title: 'L-a', tags: ['marketing', 'summer'] });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/b', title: 'L-b', tags: ['marketing'] });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/c', title: 'L-c', tags: ['winter'] });
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  await expect(linkRows(page)).toHaveCount(3);
  await page.getByPlaceholder('Filter by tags (comma-separated)').fill('marketing, summer');
  await expect(linkRows(page)).toHaveCount(1, { timeout: 5000 });
  await expect(linkRows(page).first()).toContainText('L-a');
});

test('LINK-018 pagination: 20 per page, Previous and Next', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const links = await seedLinks(owner, project.id, newClientIp(), 25, 'Paged');
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links`);
  const previous = page.getByRole('button', { name: 'Previous' });
  const next = page.getByRole('button', { name: 'Next' });

  await expect(linkRows(page)).toHaveCount(20);
  await expect(page.getByText('Showing 1-20 of 25')).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(linkRows(page).first()).toContainText('Paged 25');

  await next.click();
  await expect(linkRows(page)).toHaveCount(5);
  await expect(page.getByText('Showing 21-25 of 25')).toBeVisible();
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  await expect(linkRows(page).last()).toContainText('Paged 1');

  await previous.click();
  await expect(linkRows(page)).toHaveCount(20);
  await expect(page.getByText('Showing 1-20 of 25')).toBeVisible();

  // With 20 links or fewer there is no pagination bar.
  for (const link of links.slice(0, 5)) {
    expect((await rawApi('DELETE', `/api/links/${link.id}`, undefined, { token: owner.accessToken, ip: clientIp })).status).toBe(200);
  }
  await page.reload();
  await expect(linkRows(page)).toHaveCount(20);
  await expect(next).toHaveCount(0);
  await expect(previous).toHaveCount(0);
  await expect(page.getByText(/^Showing /)).toHaveCount(0);
});

test('LINK-022 member and admin see and use the links list', async ({ browser, baseURL, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/first', title: 'Team first' });
  await seedLink(owner, project.id, clientIp, { longUrl: 'https://example.com/second', title: 'Team second' });
  const admin = await addProjectMember(owner, project.id, 'admin', clientIp);
  const member = await addProjectMember(owner, project.id, 'member', clientIp);

  for (const person of [admin, member]) {
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const page = await context.newPage();
      await signIn(page, person);
      await page.goto(`/projects/${project.id}/links`);
      await expect(linkRows(page)).toHaveCount(2);
      await expect(linkRows(page).nth(0)).toContainText('Team second');
      await expect(linkRows(page).nth(1)).toContainText('Team first');
      await page.getByRole('button', { name: 'Create Link' }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
      await expect(page.getByRole('heading', { name: 'Create Link' })).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test('LINK-024 links list in view-as', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  await seedLink(owner, p1.id, clientIp, { longUrl: 'https://example.com/billed', title: 'Billed to O' });
  const { owner: x, project: p3 } = await ownerWithProject(clientIp, 'owner-x');
  await seedLink(x, p3.id, clientIp, { longUrl: 'https://example.com/joined', title: 'Billed to X' });
  await joinProject(x, p3.id, owner, 'member', clientIp);
  // O does see P3's links in their own session.
  const ownView = await rawApi('GET', `/api/projects/${p3.id}/links`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(ownView.status).toBe(200);

  const viewAs = await openViewAs(browser, baseURL, await startViewAs(browser, baseURL, owner));
  try {
    await viewAs.goto(`/projects/${p1.id}/links`);
    await expect(linkRows(viewAs)).toHaveCount(1);
    await expect(linkRows(viewAs).first()).toContainText('Billed to O');

    // View-as sees only projects billed to the tenant: the project itself is refused,
    // so the layout sends the tab back to the project list before any link is asked for.
    const linkRequests: string[] = [];
    viewAs.on('request', (request) => {
      if (isListRequest(request.url(), p3.id)) linkRequests.push(request.url());
    });
    const refused = viewAs.waitForResponse((r) => new URL(r.url()).pathname === `/api/projects/${p3.id}`);
    await viewAs.goto(`/projects/${p3.id}/links`);
    const answer = await refused;
    expect(answer.status()).toBe(404);
    expect(((await answer.json()) as { message: string }).message).toBe(PROJECT_NOT_FOUND);
    await expect(viewAs).toHaveURL(/\/projects$/);
    await expect(viewAs.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(viewAs.getByText(p1.name)).toBeVisible();
    await expect(viewAs.getByText(p3.name)).toHaveCount(0);
    await expect(viewAs.getByText('Billed to X')).toHaveCount(0);
    expect(linkRequests).toEqual([]);
    const direct = await rawApi('GET', `/api/projects/${p3.id}/links`, undefined, { token: await viewAsTokenFrom(viewAs), ip: clientIp });
    expect([direct.status, direct.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  } finally {
    await viewAs.context().close();
  }
});

// ---- B. Create link

test('LINK-028 destination URL required and must be a URL', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  const posts = recordCreates(page, project.id);
  const field = page.getByLabel('Destination URL');
  const error = page.locator('div.space-y-2', { has: field }).getByText('Must be a valid URL');

  await page.getByRole('button', { name: 'Create Link' }).click();
  await expect(error).toBeVisible();
  for (const value of ['not a url', 'example.com']) {
    await field.fill(value);
    await page.getByRole('button', { name: 'Create Link' }).click();
    await expect(error).toBeVisible();
  }
  // A real URL clears the message: the check is the form's, not a stuck state.
  await field.fill('https://example.com/ok');
  await expect(error).toHaveCount(0);
  expect(posts).toHaveLength(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
  expect(await countLinks(project.id)).toBe(0);
});

test('LINK-029 destination URL accepted by the browser but refused by the API', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('http://localhost:3000/page');
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Link' }).click();
  const response = await answered;
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { message: string[] }).message).toContain('longUrl must be a URL address');
  await expect(toast(page, 'Error').filter({ hasText: 'longUrl must be a URL address' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
  await expect(page.getByText('Must be a valid URL')).toHaveCount(0);
  expect(await countLinks(project.id)).toBe(0);
});

test('LINK-031 custom short code format errors in the form', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  const posts = recordCreates(page, project.id);
  await page.getByLabel('Destination URL').fill('https://example.com/codes');
  const code = page.getByLabel(/Custom short link/);
  const messages = page.locator('div.space-y-2', { has: code }).locator('p.text-destructive');
  const cases: [string, string][] = [
    ['ab', 'Must be at least 3 characters'],
    ['a'.repeat(31), 'Must be at most 30 characters'],
    ['bad code!', 'Only letters, numbers, hyphens, and underscores are allowed'],
    ['a!', 'Only letters, numbers, hyphens, and underscores are allowed'],
  ];
  for (const [value, message] of cases) {
    await code.fill(value);
    await page.getByRole('button', { name: 'Create Link' }).click();
    await expect(messages).toHaveText(message);
  }
  expect(posts).toHaveLength(0);
  expect(await countLinks(project.id)).toBe(0);
});

test('LINK-032 custom short code format errors from the API', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const cases: [unknown, string][] = [
    ['ab', 'shortCode must be longer than or equal to 3 characters'],
    ['a'.repeat(31), 'shortCode must be shorter than or equal to 30 characters'],
    ['a b c', 'shortCode must contain only letters, numbers, hyphens, or underscores'],
  ];
  for (const [shortCode, message] of cases) {
    const response = await rawApi('POST', `/api/projects/${project.id}/links`, { longUrl: 'https://example.com/api-codes', shortCode }, { token: owner.accessToken, ip: clientIp });
    expect(response.status, `shortCode ${JSON.stringify(shortCode)}`).toBe(400);
    expect(response.body.message).toContain(message);
  }
  expect(await countLinks(project.id)).toBe(0);
  // A number is converted to its digits (the pipe converts to the declared type) and
  // then checked as a code like any other.
  const digits = 100_000_000 + Math.floor(Math.random() * 899_999_999);
  const numeric = await rawApi('POST', `/api/projects/${project.id}/links`, { longUrl: 'https://example.com/api-codes', shortCode: digits }, { token: owner.accessToken, ip: clientIp });
  expect(numeric.status).toBe(201);
  expect(numeric.body.data.shortCode).toBe(String(digits));
  const tooShort = await rawApi('POST', `/api/projects/${project.id}/links`, { longUrl: 'https://example.com/api-codes', shortCode: 12 }, { token: owner.accessToken, ip: clientIp });
  expect(tooShort.status).toBe(400);
  expect(tooShort.body.message).toContain('shortCode must be longer than or equal to 3 characters');
  expect(await countLinks(project.id)).toBe(1);
});

test('LINK-036 reserved word check ignores case', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('https://example.com');
  await page.getByLabel('Custom short link').fill('Login');
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Link' }).click();
  expect((await answered).status()).toBe(409);
  const message = '"Login" is a reserved word and cannot be used as a short code';
  await expect(toast(page, 'Error')).toContainText(message);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));

  for (const word of ['ADMIN', 'Well-Known']) {
    const response = await rawApi('POST', `/api/projects/${project.id}/links`, { longUrl: 'https://example.com', shortCode: word }, { token: owner.accessToken, ip: clientIp });
    expect(response.status).toBe(409);
    expect(response.body.message).toBe(`"${word}" is a reserved word and cannot be used as a short code`);
  }
  expect(await countLinks(project.id)).toBe(0);
});

test('LINK-037 reserved words protect the dashboard pages', async ({ page, clientIp }) => {
  const redirects: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/redirect/')) redirects.push(request.url());
  });
  await page.route('**/redirect/**', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'stand-in' }));

  // Positive control: a word that is no page goes to the short-link redirect.
  const unknown = uniqueCode('not-a-page');
  await page.goto(`/${unknown}`);
  await expect.poll(() => redirects.length).toBeGreaterThanOrEqual(1);
  for (const url of redirects) expect(new URL(url).pathname).toBe(`/redirect/${unknown}`);
  redirects.length = 0;

  const pages = ['/login', '/register', '/invite', '/impersonate', '/settings', '/projects', '/account/billing', '/complete-signup', '/verify-email', '/reset-password', '/forgot-password'];
  for (const path of pages) {
    await page.goto(path);
    // A dashboard page renders text or controls of its own; the short-link page renders only a spinner.
    await expect(page.locator('#root').locator('h1, h2, h3, p, form, button, input, a').first(), `${path} rendered a page`).toBeVisible();
    const landed = new URL(page.url()).pathname;
    expect(landed.startsWith('/redirect/'), `${path} landed on ${landed}`).toBe(false);
    // Signed out, the protected pages send to the sign-in page; the rest stay.
    expect([path, '/login']).toContain(landed);
  }
  expect(redirects).toEqual([]);

  // The API host: these words reach the real API routes, never the redirect.
  const health = await rawApi('GET', '/health', undefined, { ip: clientIp, headers: { 'User-Agent': DESKTOP_UA } });
  expect(health.status).toBe(200);
  const projects = await rawApi('GET', '/projects', undefined, { ip: clientIp, headers: { 'User-Agent': DESKTOP_UA } });
  expect(projects.status).toBe(401);
  // Billing is on in this stack.
  const billing = await rawApi('GET', '/billing', undefined, { ip: clientIp, headers: { 'User-Agent': DESKTOP_UA } });
  expect(billing.status).toBe(401);
  for (const answer of [health, projects, billing]) expect(answer.headers.get('location')).toBeNull();
});

test('LINK-039 two creates racing for one custom code', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const admin = await addProjectMember(owner, project.id, 'admin', clientIp);
  const code = uniqueCode('race-code');
  const [a, b] = await Promise.all(
    [owner, admin].map((person) =>
      rawApi('POST', `/api/projects/${project.id}/links`, { longUrl: `https://example.com/${person.name.replace(/\W+/g, '-')}`, shortCode: code }, { token: person.accessToken, ip: newClientIp() }),
    ),
  );
  expect([a.status, b.status].sort()).toEqual([201, 409]);
  const loser = a.status === 409 ? a : b;
  expect(loser.body.message).toBe(`Short code "${code}" is already taken`);
  const rows = await sql('SELECT id FROM links WHERE short_code = $1', [code]);
  expect(rows).toHaveLength(1);
});

test('LINK-040 title and tags are saved', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('https://example.com');
  await page.getByLabel('Title').fill('Launch');
  await page.getByLabel('Tags (comma-separated)').fill('marketing, summer-campaign , ,x');
  const sent = page.waitForRequest((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.method() === 'POST');
  await page.getByRole('button', { name: 'Create Link' }).click();
  const body = (await sent).postDataJSON() as { title: string; tags: string[] };
  expect(body.title).toBe('Launch');
  expect(body.tags).toEqual(['marketing', 'summer-campaign', 'x']);

  await expect(toast(page, 'Link created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/[0-9a-f-]{36}$`));
  for (const tag of ['marketing', 'summer-campaign', 'x']) {
    await expect(page.locator('[data-slot="badge"][data-variant="secondary"]').getByText(tag, { exact: true })).toBeVisible();
  }
  // `tags` is a simple-array column: stored comma-joined.
  const [row] = await sql<{ title: string; tags: string }>('SELECT title, tags FROM links WHERE project_id = $1', [project.id]);
  expect(row).toEqual({ title: 'Launch', tags: 'marketing,summer-campaign,x' });
});

test('LINK-043 unknown body fields are refused', async ({ clientIp }) => {
  const { owner, project: p1 } = await ownerWithProject(clientIp, 'owner-o');
  const { project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const post = (body: Record<string, unknown>) =>
    rawApi('POST', `/api/projects/${p1.id}/links`, { longUrl: 'https://example.com/extra', ...body }, { token: owner.accessToken, ip: clientIp });

  const foreign = await post({ projectId: p2.id });
  expect([foreign.status, foreign.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  const own = await post({ projectId: p1.id });
  expect(own.status).toBe(400);
  expect(own.body.message).toContain('property projectId should not exist');
  const clicks = await post({ clickCount: 5 });
  expect(clicks.status).toBe(400);
  expect(clicks.body.message).toContain('property clickCount should not exist');
  const id = await post({ id: '00000000-0000-4000-8000-000000000001' });
  expect(id.status).toBe(400);
  expect(id.body.message).toContain('property id should not exist');

  expect(await countLinks(p1.id)).toBe(0);
  expect(await countLinks(p2.id)).toBe(0);
  // Positive control: the same body without the extra field is created.
  expect((await post({})).status).toBe(201);
  expect(await countLinks(p1.id)).toBe(1);
});

test('LINK-049 deep link parameters: invalid JSON', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  const posts = recordCreates(page, project.id);
  await page.getByLabel('Destination URL').fill('https://example.com/json');
  await page.getByRole('tab', { name: 'Deep Linking' }).click();
  await page.getByPlaceholder('{"screen": "product", "id": "123"}').fill('{screen: product}');
  await page.getByRole('button', { name: 'Create Link' }).click();
  const invalid = toast(page, 'Invalid JSON');
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('Deep link params must be valid JSON');
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
  // The JSON check returns before the mutation runs, so the toast means nothing was sent.
  expect(posts).toHaveLength(0);
  expect(await countLinks(project.id)).toBe(0);
});

test('LINK-053 create an inactive link', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('https://example.com/off');
  await page.getByLabel('Title').fill('Switched off');
  await page.getByRole('tab', { name: 'Settings' }).click();
  const active = page.getByRole('switch');
  await expect(active).toBeChecked();
  await active.click();
  await expect(active).not.toBeChecked();
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Link' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const link = ((await response.json()) as { data: { id: string; shortCode: string } }).data;
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));

  const [row] = await sql<{ is_active: boolean }>('SELECT is_active FROM links WHERE id = $1', [link.id]);
  expect(row.is_active).toBe(false);
  await page.goto(`/projects/${project.id}/links`);
  await expect(page.getByRole('row', { name: /Switched off/ }).getByRole('cell').nth(4)).toHaveText('Inactive');

  const redirect = await openShortLink(link.shortCode, newClientIp());
  expect(redirect.status).toBe(404);
  expect(redirect.headers.get('content-type')).toMatch(/application\/json/);
  expect(redirect.body.message).toBe('Link is no longer active');
});

test('LINK-054 create a link with an expiry date', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  const value = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T10:00`;

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/new`);
  await page.getByLabel('Destination URL').fill('https://example.com/soon');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('input[type=datetime-local]').fill(value);
  const sent = page.waitForRequest((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.method() === 'POST');
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Link' }).click();
  expect(((await sent).postDataJSON() as { expiresAt: string }).expiresAt).toBe(value);
  const link = ((await (await created).json()) as { data: { id: string; shortCode: string } }).data;

  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));
  await expect(labelledBlock(page, 'Expires')).toContainText(shortDate(tomorrow));
  const redirect = await openShortLink(link.shortCode, newClientIp());
  expect(redirect.status).toBe(302);
  expect(redirect.location).toBe('https://example.com/soon');
});

test('LINK-058 admin and member can create links', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const admin = await addProjectMember(owner, project.id, 'admin', clientIp);
  const member = await addProjectMember(owner, project.id, 'member', clientIp);
  for (const [person, path] of [[admin, 'by-admin'], [member, 'by-member']] as const) {
    const response = await rawApi('POST', `/api/projects/${project.id}/links`, { longUrl: `https://example.com/${path}` }, { token: person.accessToken, ip: clientIp });
    expect(response.status, path).toBe(201);
    expect(response.body.data.projectId).toBe(project.id);
  }
  expect((await storedLinks(project.id)).map((link) => link.long_url)).toEqual(['https://example.com/by-admin', 'https://example.com/by-member']);
});

// ---- C. Released short codes

test('LINK-063 deleting a project retires all its codes', async ({ clientIp }) => {
  const { owner, project: p4 } = await ownerWithProject(clientIp, 'owner-o');
  const { owner: x, project: p2 } = await ownerWithProject(clientIp, 'owner-x');
  const codes = [uniqueCode('p4-a'), uniqueCode('p4-b')];
  for (const code of codes) await seedLink(owner, p4.id, clientIp, { longUrl: `https://example.com/${code}`, shortCode: code });

  const deleted = await rawApi('DELETE', `/api/projects/${p4.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(deleted.status).toBe(200);
  expect(await sql('SELECT id FROM projects WHERE id = $1', [p4.id])).toEqual([]);
  const released = await sql<{ short_code: string; project_id: string }>(
    'SELECT short_code, project_id FROM released_short_codes WHERE short_code = ANY($1) ORDER BY short_code',
    [codes],
  );
  expect(released).toEqual([...codes].sort().map((code) => ({ short_code: code, project_id: p4.id })));

  const taken = await rawApi('POST', `/api/projects/${p2.id}/links`, { longUrl: 'https://example.com/reuse', shortCode: codes[0] }, { token: x.accessToken, ip: clientIp });
  expect(taken.status).toBe(409);
  expect(taken.body.message).toBe(`Short code "${codes[0]}" is already taken`);
  expect(await countLinks(p2.id)).toBe(0);
});

// ---- D. Bulk import

test('LINK-068 bulk import reports rows with no URL', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/bulk-import`);
  const csv = ['longUrl,title', 'https://example.com/ok,Ok', ',Missing'].join('\n');
  await page.locator('input[type=file]').setInputFiles({ name: 'links.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Import Links' }).click();
  await expect(toast(page, 'Created 1 of 2 links')).toBeVisible();
  const results = page.locator('[data-slot="card"]', { hasText: 'Import Results' });
  await expect(results).toContainText('1 created');
  await expect(results).toContainText('1 errors');
  await expect(results.getByText('Row 2: Missing longUrl')).toBeVisible();
  expect((await storedLinks(project.id)).map((link) => link.long_url)).toEqual(['https://example.com/ok']);
});

test('LINK-073 bulk import of an Excel CSV with a byte-order mark', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'LINK-073' });
  test.fail();
  const { owner, project } = await ownerWithProject(clientIp);
  const csv = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(['longUrl,title', 'https://example.com/bom-1,One', 'https://example.com/bom-2,Two'].join('\r\n')),
  ]);
  const response = await rawBulkImport(owner.accessToken, project.id, clientIp, { content: csv });
  expect(response.status).toBe(201);
  expect(response.body.data).toEqual({ total: 2, created: 2, errors: [] });
  expect((await storedLinks(project.id)).map((link) => link.long_url)).toEqual(['https://example.com/bom-1', 'https://example.com/bom-2']);
});

test('LINK-074 bulk import refuses malformed CSV', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const unclosed = 'longUrl,title\n"https://example.com,unclosed';
  const ragged = ['longUrl,title', 'https://example.com/fine,Fine', 'https://example.com/ragged,Ragged,extra'].join('\n');
  for (const content of [unclosed, ragged]) {
    const response = await rawBulkImport(owner.accessToken, project.id, clientIp, { content });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid CSV format');
  }
  expect(await countLinks(project.id)).toBe(0);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/bulk-import`);
  await page.locator('input[type=file]').setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from(unclosed) });
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links/bulk`));
  await page.getByRole('button', { name: 'Import Links' }).click();
  expect((await answered).status()).toBe(400);
  const failed = toast(page, 'Upload failed');
  await expect(failed).toBeVisible();
  await expect(failed).not.toContainText('Invalid CSV format');
  await expect(page.getByText('Import Results')).toHaveCount(0);
  expect(await countLinks(project.id)).toBe(0);
});

test('LINK-077 bulk import refuses non-CSV files and a missing file', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp);
  const csv = ['longUrl,title', 'https://example.com/typed,Typed'].join('\n');

  const missing = await rawBulkImport(owner.accessToken, project.id, clientIp, null);
  expect([missing.status, missing.body.message]).toEqual([403, 'Missing file']);
  const text = await rawBulkImport(owner.accessToken, project.id, clientIp, { content: csv, mimeType: 'text/plain', name: 'links.txt' });
  expect([text.status, text.body.message]).toEqual([403, 'Only CSV files are allowed']);
  expect(await countLinks(project.id)).toBe(0);
  // The other two allowed types are taken.
  for (const mimeType of ['application/vnd.ms-excel', 'application/csv']) {
    const allowed = await rawBulkImport(owner.accessToken, project.id, clientIp, { content: csv, mimeType });
    expect(allowed.status, mimeType).toBe(201);
  }
  expect(await countLinks(project.id)).toBe(2);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/links/bulk-import`);
  await page.locator('input[type=file]').setInputFiles({ name: 'renamed.csv', mimeType: 'application/octet-stream', buffer: Buffer.from(csv) });
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links/bulk`));
  await page.getByRole('button', { name: 'Import Links' }).click();
  const response = await answered;
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe('Only CSV files are allowed');
  await expect(toast(page, 'Upload failed')).toBeVisible();
  expect(await countLinks(project.id)).toBe(2);
});

test('LINK-079 bulk import roles and view-as', async ({ browser, baseURL, clientIp }) => {
  test.slow(); // a super admin is granted through the CLI
  const { owner, project } = await ownerWithProject(clientIp);
  const admin = await addProjectMember(owner, project.id, 'admin', clientIp);
  const member = await addProjectMember(owner, project.id, 'member', clientIp);
  const outsider = await createAccount(clientIp, 'nobody', 'Nora Nobody');

  for (const [person, label] of [[admin, 'admin'], [member, 'member']] as const) {
    const response = await rawBulkImport(person.accessToken, project.id, clientIp, { content: `longUrl,title\nhttps://example.com/${label},By ${label}` });
    expect(response.status, label).toBe(201);
    expect(response.body.data).toEqual({ total: 1, created: 1, errors: [] });
  }
  const refused = await rawBulkImport(outsider.accessToken, project.id, clientIp, { content: 'longUrl,title\nhttps://example.com/outsider,Outsider' });
  expect([refused.status, refused.body.message]).toEqual([404, PROJECT_NOT_FOUND]);
  expect((await storedLinks(project.id)).map((link) => link.long_url)).toEqual(['https://example.com/admin', 'https://example.com/member']);

  const viewAs = await openViewAs(browser, baseURL, await startViewAs(browser, baseURL, owner));
  try {
    await viewAs.goto(`/projects/${project.id}/links/bulk-import`);
    await viewAs.locator('input[type=file]').setInputFiles({ name: 'links.csv', mimeType: 'text/csv', buffer: Buffer.from('longUrl,title\nhttps://example.com/viewer,Viewer') });
    const answered = viewAs.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/links/bulk`));
    await viewAs.getByRole('button', { name: 'Import Links' }).click();
    const response = await answered;
    expect(response.status()).toBe(403);
    expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
    await expect(toast(viewAs, 'Read-only session')).toContainText(READ_ONLY);
    await expect(toast(viewAs, 'Upload failed')).toBeVisible();
  } finally {
    await viewAs.context().close();
  }
  expect(await countLinks(project.id)).toBe(2);
});

import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { createAccount, createProject } from '../../support/api';
import { adminApi } from '../../support/admin';
import { expect, newPersonContext, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  addMember,
  billingEnabled,
  cardTitled,
  countProjectCreates,
  createDialog,
  createLink,
  createProjectWith,
  dbRows,
  insertClicks,
  listProjects,
  newStaffSession,
  openShortLink,
  openSwitcher,
  ownedProjectCount,
  projectCard,
  projectLimitMessage,
  projectStats,
  rawApi,
  setProjectLimit,
  settingsInput,
  setUserName,
  statCard,
  suspendAccount,
  switcherTrigger,
  toastWith,
} from '../../support/areas/proj';

/**
 * Projects (P1): the list for a new account, the selector's empty and joined states,
 * names shown as text, the create dialog's checks and the project limit (deleting,
 * staff overrides, the plan wording, per account), opening projects (removed while open,
 * deep links), the sidebar for owners and admins, the project switcher, the selector's
 * header and account menu, and the dashboard (empty, its links, titles as text, every
 * role, a suspended billing owner's clicks). Every test makes its own accounts and
 * projects.
 */

const hex = () => randomBytes(3).toString('hex');

/** Fails the test if any dialog (alert, confirm) opens in the page. */
function failOnDialog(page: Page, seen: string[]): void {
  page.on('dialog', async (dialog) => {
    seen.push(dialog.message());
    await dialog.dismiss();
  });
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// A. Project list API
// ---------------------------------------------------------------------------

test('PROJ-002 list for an account with no projects', async ({ clientIp }) => {
  const fresh = await createAccount(clientIp, 'proj002');
  // A project someone else owns, so an empty list is the account's own and not an empty database.
  const other = await createAccount(clientIp, 'proj002-o');
  await createProject(other, clientIp, `PROJ-002 other ${hex()}`);
  const { meta: otherMeta } = await listProjects(other, clientIp);
  expect(otherMeta.total).toBe(1);

  const response = await rawApi<{ data: unknown[]; meta: Record<string, any> }>('GET', '/api/projects', {
    token: fresh.accessToken,
    ip: clientIp,
  });
  expect(response.status).toBe(200);
  expect(response.body.data).toEqual([]);
  expect(response.body.meta).toMatchObject({ total: 0, page: 1, totalPages: 0, billedProjects: 0 });
  // The default limit: the same number an account with no override of its own gets.
  expect(response.body.meta.projectLimit).toBe(otherMeta.projectLimit);
  expect(response.body.meta.projectLimit).toBeGreaterThan(0);
  expect(response.body.meta).toHaveProperty('seats');
  expect(response.body.meta.seats).toHaveProperty('used');
});

// ---------------------------------------------------------------------------
// B. Project selector page
// ---------------------------------------------------------------------------

test('PROJ-011 empty state for an account with no projects', async ({ page, clientIp }) => {
  const fresh = await createAccount(clientIp, 'proj011');
  const { meta } = await listProjects(fresh, clientIp);
  await signIn(page, fresh);

  await expect(page.getByText(`0 of ${meta.projectLimit} projects`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(page.getByText('Create your first project to start managing dynamic links.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Project' })).toBeEnabled();
  await expect(page.locator('span', { hasText: /^New Project$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Project' })).toBeEnabled();
});

test('PROJ-012 the count shows billed projects, not every project listed', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'proj012-a');
  const b = await createAccount(clientIp, 'proj012-b');
  const c = await createAccount(clientIp, 'proj012-c');
  const administered = await createProject(b, clientIp, `PROJ-012 administered ${hex()}`);
  const joined = await createProject(c, clientIp, `PROJ-012 joined ${hex()}`);
  await addMember(administered.id, a.userId, 'admin', b.userId);
  await addMember(joined.id, a.userId, 'member', c.userId);
  const { meta } = await listProjects(a, clientIp);

  await signIn(page, a);
  // Exactly the two joined projects, and no third card of the account's own.
  await expect(page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="badge"]') })).toHaveCount(2);
  const adminCard = projectCard(page, administered.name);
  const memberCard = projectCard(page, joined.name);
  await expect(adminCard.getByText('Admin', { exact: true })).toBeVisible();
  await expect(memberCard.getByText('Member', { exact: true })).toBeVisible();
  // Owner and admin badges are the secondary variant, member the outline one.
  await expect(adminCard.locator('[data-slot="badge"]')).toHaveAttribute('data-variant', 'secondary');
  await expect(memberCard.locator('[data-slot="badge"]')).toHaveAttribute('data-variant', 'outline');
  await expect(page.getByText(`0 of ${meta.projectLimit} projects`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Project' })).toBeEnabled();
});

test('PROJ-014 the selector, switcher and settings show names and domains as text', async ({ page, clientIp }) => {
  const dialogs: string[] = [];
  failOnDialog(page, dialogs);
  const owner = await createAccount(clientIp, 'proj014');
  const name = '<img src=x onerror=alert(1)>';
  const domain = '"><script>alert(2)</script>';
  const project = await createProjectWith(owner, clientIp, { name, domain });
  expect(project).toMatchObject({ name, domain });

  const injected = async () =>
    page.evaluate(() => ({
      images: document.querySelectorAll('img[src="x"]').length,
      scripts: Array.from(document.querySelectorAll('script')).filter((s) => (s.textContent ?? '').includes('alert(')).length,
    }));

  await signIn(page, owner);
  const card = projectCard(page, name);
  await expect(card).toBeVisible();
  await expect(card).toContainText(domain);
  expect(await injected()).toEqual({ images: 0, scripts: 0 });

  await page.getByText(name, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  await expect(switcherTrigger(page)).toContainText(name);
  await expect(switcherTrigger(page)).toContainText(`Owner · ${domain}`);
  const menu = await openSwitcher(page);
  await expect(menu.getByRole('menuitem').filter({ hasText: name })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await injected()).toEqual({ images: 0, scripts: 0 });

  await page.goto(`/projects/${project.id}/settings`);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(settingsInput(page, 'Domain')).toHaveValue(domain);
  expect(await injected()).toEqual({ images: 0, scripts: 0 });
  expect(dialogs).toEqual([]);
});

// ---------------------------------------------------------------------------
// C. Create project and the project limit
// ---------------------------------------------------------------------------

test('PROJ-018 create from the empty-state card and from the dashed card', async ({ page, clientIp }) => {
  // (a) No projects: the empty state's button.
  const fresh = await createAccount(clientIp, 'proj018-a');
  await signIn(page, fresh);
  await page.getByRole('button', { name: 'Create Project' }).click();
  let dialog = createDialog(page);
  await expect(dialog).toBeVisible();
  const first = `PROJ-018 first ${hex()}`;
  await dialog.getByPlaceholder('My App').fill(first);
  await dialog.getByPlaceholder('example.com').fill('first.proj018.example.test');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(toastWith(page, 'Project created').first()).toContainText(first);
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
  await expect(page.getByRole('heading', { name: first, level: 1 })).toBeVisible();
  expect(await ownedProjectCount(fresh.userId)).toBe(1);

  // (b) One project: the dashed card at the end of the grid.
  await page.goto('/projects');
  await expect(projectCard(page, first)).toBeVisible();
  await page.locator('span', { hasText: /^New Project$/ }).click();
  dialog = createDialog(page);
  await expect(dialog).toBeVisible();
  const second = `PROJ-018 second ${hex()}`;
  await dialog.getByPlaceholder('My App').fill(second);
  await dialog.getByPlaceholder('example.com').fill('second.proj018.example.test');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(toastWith(page, 'Project created').first()).toContainText(second);
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
  await expect(page.getByRole('heading', { name: second, level: 1 })).toBeVisible();
  const projectId = /\/projects\/([0-9a-f-]{36})\//.exec(page.url())![1];
  const [row] = await dbRows<{ owner_id: string; domain: string }>(`SELECT owner_id, domain FROM projects WHERE id = $1`, [projectId]);
  expect(row).toEqual({ owner_id: fresh.userId, domain: 'second.proj018.example.test' });
  expect(await ownedProjectCount(fresh.userId)).toBe(2);
});

test('PROJ-019 required fields in the create dialog', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj019');
  await signIn(page, owner);
  const creates = countProjectCreates(page);
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = createDialog(page);
  const submit = dialog.getByRole('button', { name: 'Create Project' });
  const nameInput = dialog.getByPlaceholder('My App');
  const domainInput = dialog.getByPlaceholder('example.com');

  await submit.click();
  await expect(dialog.getByText('Name is required', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Domain is required', { exact: true })).toBeVisible();

  await nameInput.fill('PROJ-019 only a name');
  await submit.click();
  await expect(dialog.getByText('Domain is required', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Name is required', { exact: true })).toHaveCount(0);

  await nameInput.fill('');
  await domainInput.fill('only-domain.proj019.example.test');
  await submit.click();
  await expect(dialog.getByText('Name is required', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Domain is required', { exact: true })).toHaveCount(0);

  await expect(dialog).toBeVisible();
  expect(creates.count()).toBe(0);
  expect(await ownedProjectCount(owner.userId)).toBe(0);

  // The same dialog does send once both are filled.
  await nameInput.fill(`PROJ-019 both ${hex()}`);
  await submit.click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
  expect(creates.count()).toBe(1);
});

test('PROJ-021 a server validation error in the create dialog falls back to a generic message', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj021');
  await signIn(page, owner);
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = createDialog(page);
  await dialog.getByPlaceholder('My App').fill('n'.repeat(256));
  await dialog.getByPlaceholder('example.com').fill('ok.example.test');
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Create Project' }).click(),
  ]);
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toEqual(['name must be shorter than or equal to 255 characters']);

  await expect(dialog.getByRole('alert')).toHaveText('Failed to create project');
  const toast = toastWith(page, 'Project not created').first();
  await expect(toast).toContainText('Failed to create project');
  await expect(dialog).toBeVisible();
  expect(await ownedProjectCount(owner.userId)).toBe(0);
});

test('PROJ-024 create API field validation', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj024');
  const post = (body: unknown) =>
    rawApi<{ data?: Record<string, any>; message?: string[] }>('POST', '/api/projects', { token: owner.accessToken, ip: clientIp, body });

  const empty = await post({});
  expect(empty.status).toBe(400);
  expect([...(empty.body.message ?? [])].sort()).toEqual(
    ['name must be a string', 'name must be shorter than or equal to 255 characters'].sort(),
  );

  // The pipe converts implicitly to the declared type (`enableImplicitConversion`, kept
  // on deliberately), so a number arrives as its string and is stored as such.
  const numeric = await post({ name: 123 });
  expect(numeric.status).toBe(201);
  expect(numeric.body.data).toMatchObject({ name: '123' });

  for (const field of ['iosAppStoreUrl', 'androidPlayStoreUrl', 'webFallbackUrl']) {
    for (const value of ['not a url', 'javascript:alert(1)']) {
      const response = await post({ name: 'x', [field]: value });
      expect(response.status, `${field}=${value}`).toBe(400);
      expect(response.body.message, `${field}=${value}`).toEqual([`${field} must be a URL address`]);
    }
  }

  const longBundle = await post({ name: 'x', iosBundleId: 'b'.repeat(256) });
  expect(longBundle.status).toBe(400);
  expect(longBundle.body.message).toEqual(['iosBundleId must be shorter than or equal to 255 characters']);
  const longUrl = `https://example.test/${'p'.repeat(513 - 'https://example.test/'.length)}`;
  expect(longUrl).toHaveLength(513);
  const longFallback = await post({ name: 'x', webFallbackUrl: longUrl });
  expect(longFallback.status).toBe(400);
  expect(longFallback.body.message).toEqual(['webFallbackUrl must be shorter than or equal to 512 characters']);
  // One character shorter is accepted, so the refusal above is the length rule.
  const atLimit = await post({ name: 'x', webFallbackUrl: longUrl.slice(0, 512) });
  expect(atLimit.status).toBe(201);
  expect(await ownedProjectCount(owner.userId)).toBe(2);

  // The API itself requires no domain and no non-empty name; only the dialog does.
  const noDomain = await post({ name: 'x' });
  expect(noDomain.status).toBe(201);
  expect(noDomain.body.data).toMatchObject({ name: 'x', domain: null });
  const emptyName = await post({ name: '' });
  expect(emptyName.status).toBe(201);
  expect(emptyName.body.data).toMatchObject({ name: '' });
  expect(await ownedProjectCount(owner.userId)).toBe(4);

  // Clean up what was created (the token is from a fresh sign-in).
  for (const created of [numeric, atLimit, noDomain, emptyName]) {
    const deleted = await rawApi('DELETE', `/api/projects/${created.body.data!.id}`, { token: owner.accessToken, ip: clientIp });
    expect(deleted.status).toBe(200);
  }
  expect(await ownedProjectCount(owner.userId)).toBe(0);
});

test('PROJ-029 deleting a project frees a place', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj029');
  await setProjectLimit(owner.userId, 2);
  const keep = await createProject(owner, clientIp, `PROJ-029 keep ${hex()}`);
  const doomed = await createProject(owner, clientIp, `PROJ-029 doomed ${hex()}`);
  const billingOn = await billingEnabled(owner, clientIp);

  await signIn(page, owner);
  await expect(page.getByText('2 of 2 projects')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Project' })).toBeDisabled();
  const status = page.getByRole('status').filter({ hasText: 'You can have up to' });
  await expect(status).toContainText(projectLimitMessage(2, billingOn));

  await page.goto(`/projects/${doomed.id}/settings`);
  await cardTitled(page, 'Danger Zone').getByRole('button', { name: 'Delete Project' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Project' });
  await confirm.getByRole('button', { name: 'Delete Project' }).click();
  await expect(page).toHaveURL(/\/projects$/);

  await expect(page.getByText('1 of 2 projects')).toBeVisible();
  await expect(page.getByText(doomed.name, { exact: true })).toHaveCount(0);
  await expect(projectCard(page, keep.name)).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Project' })).toBeEnabled();
  await expect(status).toHaveCount(0);

  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = createDialog(page);
  const replacement = `PROJ-029 replacement ${hex()}`;
  await dialog.getByPlaceholder('My App').fill(replacement);
  await dialog.getByPlaceholder('example.com').fill('replacement.proj029.example.test');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
  await expect(page.getByRole('heading', { name: replacement, level: 1 })).toBeVisible();
  expect(await ownedProjectCount(owner.userId)).toBe(2);
});

test('PROJ-030 staff overrides raise and lower the limit', async ({ page, browser, baseURL, clientIp }) => {
  test.slow(); // The staff grant runs the CLI.
  const owner = await createAccount(clientIp, 'proj030');
  const names = [`PROJ-030 one ${hex()}`, `PROJ-030 two ${hex()}`, `PROJ-030 three ${hex()}`];
  const projects = [];
  for (const name of names) projects.push(await createProject(owner, clientIp, name));
  const { meta } = await listProjects(owner, clientIp);
  const defaultLimit = meta.projectLimit;
  expect(defaultLimit).toBeGreaterThan(3);
  const billingOn = await billingEnabled(owner, clientIp);

  const { context: staffContext } = await newPersonContext(browser, baseURL);
  let staffToken: string;
  try {
    ({ staffToken } = await newStaffSession(await staffContext.newPage(), clientIp));
  } finally {
    await staffContext.close();
  }
  const setLimit = (projectLimit: number | null) =>
    adminApi('PATCH', `/api/admin/tenants/${owner.userId}/project-limit`, { projectLimit, reason: 'E2E: testing the project limit override' }, staffToken, clientIp);

  // 1. Raised.
  await setLimit(12);
  await signIn(page, owner);
  await expect(page.getByText('3 of 12 projects')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Project' })).toBeEnabled();
  await expect(page.locator('span', { hasText: /^New Project$/ })).toBeVisible();

  // 2. Lowered below what the account owns: nothing is taken away, only create is refused.
  await setLimit(1);
  await page.reload();
  await expect(page.getByText('3 of 1 project', { exact: false })).toBeVisible();
  await expect(page.getByText('3 of 1 projects')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Project' })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'You can have up to' })).toContainText(projectLimitMessage(1, billingOn));
  for (const project of projects) {
    await expect(projectCard(page, project.name)).toBeVisible();
    const opened = await rawApi('GET', `/api/projects/${project.id}`, { token: owner.accessToken, ip: clientIp });
    expect(opened.status).toBe(200);
  }
  await page.getByText(names[2], { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const refused = await rawApi<{ message: string }>('POST', '/api/projects', {
    token: owner.accessToken,
    ip: clientIp,
    body: { name: 'PROJ-030 over', domain: 'over.proj030.example.test' },
  });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(projectLimitMessage(1, billingOn));
  expect(await ownedProjectCount(owner.userId)).toBe(3);

  // 3. Cleared: back to the default.
  await setLimit(null);
  await page.goto('/projects');
  await expect(page.getByText(`3 of ${defaultLimit} projects`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Project' })).toBeEnabled();
});

test('PROJ-031 billing on: the limit wording and the "See plans" link', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj031');
  test.skip(!(await billingEnabled(owner, clientIp)), 'Needs billing on.');
  // At the free plan's limit, through the override the free plan takes.
  await setProjectLimit(owner.userId, 2);
  await createProject(owner, clientIp, `PROJ-031 one ${hex()}`);
  await createProject(owner, clientIp, `PROJ-031 two ${hex()}`);

  await signIn(page, owner);
  const countLine = page.locator('p', { hasText: /^2 of 2 projects/ });
  await expect(countLine).toHaveText('2 of 2 projects See plans');
  const status = page.getByRole('status').filter({ hasText: 'You can have up to' });
  await expect(status).toHaveText('You can have up to 2 projects on your plan. Upgrade your plan or delete one. See plans');
  await expect(page.getByRole('button', { name: 'New Project' })).toBeDisabled();
  const links = page.getByRole('link', { name: 'See plans' });
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', '/account/billing');

  await status.getByRole('link', { name: 'See plans' }).click();
  await expect(page).toHaveURL(/\/account\/billing$/);
});

test('PROJ-033 the limit counts per account', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj033-a');
  const b = await createAccount(clientIp, 'proj033-b');
  await setProjectLimit(a.userId, 1);
  await setProjectLimit(b.userId, 1);
  const aProject = await createProject(a, clientIp, `PROJ-033 A ${hex()}`);
  await addMember(aProject.id, b.userId, 'owner', a.userId);
  // A is at its limit.
  const aRefused = await rawApi('POST', '/api/projects', { token: a.accessToken, ip: clientIp, body: { name: 'PROJ-033 A over' } });
  expect(aRefused.status).toBe(403);

  const before = await listProjects(b, clientIp);
  expect(before.meta.billedProjects).toBe(0);
  expect(before.data.map((p) => p.id)).toEqual([aProject.id]);

  const created = await rawApi<{ data: { id: string } }>('POST', '/api/projects', {
    token: b.accessToken,
    ip: clientIp,
    body: { name: `PROJ-033 B ${hex()}`, domain: 'b.proj033.example.test' },
  });
  expect(created.status).toBe(201);

  const after = await listProjects(b, clientIp);
  expect(after.meta.billedProjects).toBe(1);
  expect(after.meta.total).toBe(2);
  expect(after.data.find((p) => p.id === aProject.id)).toMatchObject({ role: 'owner', isBillingOwner: false });
  expect(after.data.find((p) => p.id === created.body.data.id)).toMatchObject({ role: 'owner', isBillingOwner: true });
  const aAfter = await listProjects(a, clientIp);
  expect(aAfter.meta.billedProjects).toBe(1);
  expect(await ownedProjectCount(a.userId)).toBe(1);
  expect(await ownedProjectCount(b.userId)).toBe(1);
});

// ---------------------------------------------------------------------------
// D. Opening a project
// ---------------------------------------------------------------------------

test('PROJ-039 a project removed while it is open sends the member back to the selector', async ({ browser, baseURL, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj039-a');
  const member = await createAccount(clientIp, 'proj039-d');
  const doomed = await createProject(owner, clientIp, `PROJ-039 doomed ${hex()}`);
  const other = await createProject(owner, clientIp, `PROJ-039 other ${hex()}`);
  await addMember(doomed.id, member.userId, 'member', owner.userId);
  await addMember(other.id, member.userId, 'member', owner.userId);

  const { context } = await newPersonContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await signIn(page, member);
    await openProject(page, doomed.id);
    await expect(switcherTrigger(page)).toContainText(doomed.name);

    const deleted = await rawApi('DELETE', `/api/projects/${doomed.id}`, { token: owner.accessToken, ip: clientIp });
    expect(deleted.status).toBe(200);
    const gone = await rawApi('GET', `/api/projects/${doomed.id}`, { token: member.accessToken, ip: clientIp });
    expect(gone.status).toBe(404);

    await page.reload();
    await expect(page).toHaveURL(/\/projects$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(projectCard(page, other.name)).toBeVisible();
    await expect(page.getByText(doomed.name, { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('PROJ-040 a deep link into a project page loads the shell around it', async ({ page, context, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj040');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-040 deep ${hex()}`, domain: 'deep.proj040.example.test' });
  await signIn(page, owner);

  const tab = await context.newPage();
  // Hold the project's own request so the loading state can be seen.
  await tab.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await tab.goto(`/projects/${project.id}/settings`);
  await expect(tab.locator('.animate-spin')).toBeVisible();
  await expect(tab.getByRole('heading', { name: project.name, level: 1 })).toBeVisible();
  await expect(tab.locator('.animate-spin')).toHaveCount(0);
  await expect(switcherTrigger(tab)).toContainText(project.name);
  await expect(switcherTrigger(tab)).toContainText('Owner · deep.proj040.example.test');
  const settingsItem = tab.locator('[data-sidebar="content"] [data-sidebar="menu-button"]').filter({ hasText: 'Project Settings' });
  await expect(settingsItem).toHaveAttribute('data-active', 'true');

  await tab.goto(`/projects/${project.id}/links`);
  await tab.reload();
  await expect(tab).toHaveURL(new RegExp(`/projects/${project.id}/links$`));
  await expect(switcherTrigger(tab)).toContainText(project.name);
  const mainGroup = tab.locator('[data-sidebar="sidebar"]').getByRole('button', { name: 'Main', exact: true });
  await expect(mainGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebarLink(tab, 'Links')).toHaveAttribute('data-active', 'true');
  await expect(settingsItem).toHaveAttribute('data-active', 'false');
  // Groups without the active page stay collapsed.
  await expect(tab.locator('[data-sidebar="sidebar"]').getByRole('button', { name: 'Configure', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

// ---------------------------------------------------------------------------
// E. App shell
// ---------------------------------------------------------------------------

const SIDEBAR_GROUPS = ['Main', 'Widgets', 'Engagement', 'Configure', 'Project Settings'];

function ownerSidebarItems(base: string): [string, string][] {
  return [
    ['Dashboard', base],
    ['Analytics', `${base}/analytics`],
    ['Attribution', `${base}/attribution`],
    ['Touchpoints', `${base}/touchpoints`],
    ['Users', `${base}/users`],
    ['Events', `${base}/events`],
    ['Links', `${base}/links`],
    ['Banners', `${base}/widgets/banners`],
    ['Carousels', `${base}/widgets/carousels`],
    ['Stories', `${base}/widgets/stories`],
    ['Grids', `${base}/widgets/grids`],
    ['Swipe Strips', `${base}/widgets/swipe-strips`],
    ['In-App Messages', `${base}/in-app-messages`],
    ['Push Notifications', `${base}/push-notifications`],
    ['Mixpanel Cohorts', `${base}/mixpanel/cohorts`],
    ['API Keys', `${base}/api-keys`],
    ['Webhooks', `${base}/webhooks`],
    ['Members', `${base}/team`],
    ['Activity', `${base}/activity`],
  ];
}

async function expectOwnerSidebar(page: Page, projectId: string): Promise<void> {
  const base = `/projects/${projectId}`;
  const content = page.locator('[data-sidebar="content"]');
  await expect(content.locator('[data-sidebar="menu-button"]')).toHaveText(SIDEBAR_GROUPS);
  for (const group of SIDEBAR_GROUPS.slice(0, 4)) await openSidebarGroup(page, group);
  const items = content.locator('[data-sidebar="menu-sub-button"]');
  await expect(items).toHaveCount(19);
  const seen = await items.evaluateAll((links) => links.map((link) => [link.textContent?.trim(), link.getAttribute('href')]));
  expect(seen).toEqual(ownerSidebarItems(base));
  await expect(sidebarLink(page, 'Project Settings')).toHaveAttribute('href', `${base}/settings`);
}

test('PROJ-041 sidebar items for an owner', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj041');
  const project = await createProject(owner, clientIp, `PROJ-041 ${hex()}`);
  await signIn(page, owner);
  await openProject(page, project.id);
  await expectOwnerSidebar(page, project.id);
});

test('PROJ-042 sidebar items for an admin', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj042-o');
  const admin = await createAccount(clientIp, 'proj042-a');
  const project = await createProject(owner, clientIp, `PROJ-042 ${hex()}`);
  await addMember(project.id, admin.userId, 'admin', owner.userId);
  await signIn(page, admin);
  await openProject(page, project.id);
  await expect(switcherTrigger(page)).toContainText('Admin · ');
  await expectOwnerSidebar(page, project.id);
});

test('PROJ-049 the project switcher shows the current project and role', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'proj049-a');
  const b = await createAccount(clientIp, 'proj049-b');
  const p1 = await createProjectWith(a, clientIp, { name: `PROJ-049 own ${hex()}`, domain: 'a.example.test' });
  const p2 = await createProjectWith(b, clientIp, { name: `PROJ-049 joined ${hex()}`, domain: 'joined.proj049.example.test' });
  await addMember(p2.id, a.userId, 'member', b.userId);
  await signIn(page, a);

  await openProject(page, p1.id);
  const trigger = switcherTrigger(page);
  await expect(trigger.locator('span.font-semibold')).toHaveText(p1.name);
  await expect(trigger.locator('span.text-xs')).toHaveText('Owner · a.example.test');

  await openProject(page, p2.id);
  await expect(trigger.locator('span.font-semibold')).toHaveText(p2.name);
  await expect(trigger.locator('span.text-xs')).toHaveText('Member · joined.proj049.example.test');
});

test('PROJ-050 switching projects from the switcher', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'proj050');
  const b = await createAccount(clientIp, 'proj050-b');
  const p1 = await createProject(a, clientIp, `Alpha PROJ-050 ${hex()}`);
  const p2 = await createProject(a, clientIp, `Bravo PROJ-050 ${hex()}`);
  const p3 = await createProject(b, clientIp, `Charlie PROJ-050 ${hex()}`);
  await addMember(p3.id, a.userId, 'admin', b.userId);
  // P2 has two links, so its dashboard is told apart from P1's (none).
  const l1 = await createLink(a, clientIp, p2.id, { title: 'PROJ-050 one' });
  await createLink(a, clientIp, p2.id, { title: 'PROJ-050 two' });
  await insertClicks(l1.id, 3, '1 hour');

  await signIn(page, a);
  await page.goto(`/projects/${p1.id}/links`);
  await expect(switcherTrigger(page)).toContainText(p1.name);
  const menu = await openSwitcher(page);
  await expect(menu.getByText('Projects', { exact: true })).toBeVisible();
  const item = (name: string) => menu.getByRole('menuitem').filter({ hasText: name });
  for (const [project, role, initial] of [
    [p1, 'Owner', 'A'],
    [p2, 'Owner', 'B'],
    [p3, 'Admin', 'C'],
  ] as const) {
    await expect(item(project.name)).toHaveText(`${initial}${project.name}${role}`);
  }
  await expect(item(p1.name).locator('svg.lucide-check')).toHaveCount(1);
  await expect(item(p2.name).locator('svg.lucide-check')).toHaveCount(0);
  await expect(item(p3.name).locator('svg.lucide-check')).toHaveCount(0);
  await expect(menu.getByRole('menuitem')).toHaveCount(4); // three projects and All Projects

  await item(p2.name).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p2.id}$`));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(switcherTrigger(page)).toContainText(p2.name);
  await expect(statCard(page, 'This project')).toHaveText(/Total Links\s*2\s*This project/);
  await expect(statCard(page, 'Last 24 hours')).toHaveText(/Clicks \(24h\)\s*3\s*Last 24 hours/);
});

test('PROJ-051 "All Projects" returns to the selector', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj051');
  const project = await createProject(owner, clientIp, `PROJ-051 ${hex()}`);
  await signIn(page, owner);
  await openProject(page, project.id);
  await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();
  const menu = await openSwitcher(page);
  await menu.getByRole('menuitem', { name: 'All Projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  await expect(page.locator('header').getByText('Chumbaq', { exact: true })).toBeVisible();
});

test('PROJ-055 the selector header and account menu', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj055', 'Mira Shell');
  const billingOn = await billingEnabled(owner, clientIp);
  await signIn(page, owner);
  const header = page.locator('header');
  const brand = header.getByText('Chumbaq', { exact: true });
  await expect(brand).toBeVisible();
  await expect(header.getByRole('link')).toHaveCount(0);
  const trigger = header.getByRole('button', { name: /Mira Shell/ });
  await expect(trigger).toHaveText(/^M\s*Mira Shell$/);

  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Mira Shell', { exact: true })).toBeVisible();
  await expect(menu.getByText(owner.email, { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Light Active', 'Dark', 'System', ...(billingOn ? ['Billing'] : []), 'Log out'], {
    useInnerText: true,
  });
  await expect(menu.getByText('Accent', { exact: true })).toBeVisible();
  const swatches = await menu.locator('button[title]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('title')));
  expect(swatches).toEqual(['Zinc', 'Blue', 'Green', 'Orange', 'Red', 'Violet']);
  await expect(menu.getByRole('menuitem', { name: 'Admin app' })).toHaveCount(0);
  await expect(menu.getByText('Account Settings')).toHaveCount(0);

  await menu.getByRole('menuitem', { name: /^Dark/ }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: /^Dark/ })).toContainText('Active');
  await page.getByRole('menuitem', { name: /^System/ }).click();
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await trigger.click();
  await page.getByRole('menu').locator('button[title="Blue"]').click();
  const primary = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--primary'));
  await expect.poll(primary).toBe('hsl(221.2 83.2% 53.3%)');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem('chumbaq_theme'), localStorage.getItem('chumbaq_accent')])).toEqual([
    'system',
    'blue',
  ]);
  await expect.poll(primary).toBe('hsl(221.2 83.2% 53.3%)');
  await page.locator('header').getByRole('button', { name: /Mira Shell/ }).click();
  await expect(page.getByRole('menuitem', { name: /^System/ })).toContainText('Active');
  await expect(page.getByRole('menuitem', { name: /^Light/ })).not.toContainText('Active');
  await page.keyboard.press('Escape');

  // With no name, the initial and the label fall back.
  await setUserName(owner.userId, '');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.locator('header').getByRole('button', { name: /User/ })).toHaveText(/^U\s*User$/);
});

test('PROJ-057 log out from the selector', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj057');
  const project = await createProject(owner, clientIp, `PROJ-057 ${hex()}`);
  // Notes, in each document, whether the project list was ever drawn.
  await page.addInitScript((name) => {
    const w = window as unknown as { __sawProjects?: boolean };
    new MutationObserver(() => {
      if (document.body?.innerText.includes(name)) w.__sawProjects = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  }, project.name);

  await signIn(page, owner);
  await expect(projectCard(page, project.name)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sawProjects?: boolean }).__sawProjects)).toBe(true);

  await page.locator('header').getByRole('button', { name: owner.name }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Email')).toBeVisible();

  const sawProjects = () => page.evaluate(() => (window as unknown as { __sawProjects?: boolean }).__sawProjects ?? false);
  // Signing out replaces the selector's history entry with /login, so Back stays there.
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Email')).toBeVisible();
  expect(await sawProjects()).toBe(false);
  await expect(page.getByText(project.name)).toHaveCount(0);

  // The selector's own address, loaded signed out, sends to /login without drawing the list.
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Email')).toBeVisible();
  expect(visited[0]).toBe('/projects');
  expect(await sawProjects()).toBe(false);
  await expect(page.getByText(project.name)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// F. Project dashboard
// ---------------------------------------------------------------------------

test('PROJ-058 dashboard for an empty project', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj058');
  const project = await createProject(owner, clientIp, `PROJ-058 ${hex()}`);
  await signIn(page, owner);
  await openProject(page, project.id);

  await expect(page.getByRole('link', { name: 'Create Link' })).toBeVisible();
  await expect(statCard(page, 'This project')).toHaveText(/^Total Links\s*0\s*This project$/);
  await expect(statCard(page, 'Last 24 hours')).toHaveText(/^Clicks \(24h\)\s*0\s*Last 24 hours$/);
  await expect(statCard(page, 'Last 7 days')).toHaveText(/^Clicks \(7d\)\s*0\s*Last 7 days$/);
  await expect(statCard(page, 'Total conversions')).toHaveText(/^Conversions\s*0\s*Total conversions$/);

  const topLinks = cardTitled(page, 'Top Links');
  await expect(topLinks.getByRole('link', { name: /View all/ })).toBeVisible();
  await expect(topLinks).toContainText('No links yet. Create your first link');
  await expect(topLinks.getByRole('table')).toHaveCount(0);

  const overview = cardTitled(page, 'Overview');
  const rows = overview.locator('div.space-y-1');
  await expect(rows).toHaveCount(4);
  for (const [index, label] of ['Clicks (30d)', 'Clicks (7d)', 'Clicks (24h)', 'Total Conversions'].entries()) {
    await expect(rows.nth(index)).toHaveText(new RegExp(`^${label.replace(/[()]/g, '\\$&')}\\s*0$`));
    await expect(rows.nth(index).locator('div.bg-primary')).toHaveAttribute('style', /width: 1%/);
  }
});

test('PROJ-060 dashboard links navigate', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj060');
  const project = await createProject(owner, clientIp, `PROJ-060 ${hex()}`);
  const empty = await createProject(owner, clientIp, `PROJ-060 empty ${hex()}`);
  const link = await createLink(owner, clientIp, project.id, { title: 'PROJ-060 clicked link' });
  await insertClicks(link.id, 1, '1 hour');
  const dashboard = new RegExp(`/projects/${project.id}$`);

  await signIn(page, owner);
  await openProject(page, project.id);

  await page.getByRole('link', { name: 'Create Link' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/new$`));
  await page.goBack();
  await expect(page).toHaveURL(dashboard);

  await cardTitled(page, 'Top Links').getByRole('link', { name: /View all/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links$`));
  await page.goBack();
  await expect(page).toHaveURL(dashboard);

  await cardTitled(page, 'Top Links').getByRole('link', { name: 'PROJ-060 clicked link' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));
  await page.goBack();
  await expect(page).toHaveURL(dashboard);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await openProject(page, empty.id);
  await page.getByRole('link', { name: 'Create your first link' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${empty.id}/links/new$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${empty.id}$`));
});

test('PROJ-062 link titles in Top Links render as text', async ({ page, clientIp }) => {
  const dialogs: string[] = [];
  failOnDialog(page, dialogs);
  const owner = await createAccount(clientIp, 'proj062');
  const project = await createProject(owner, clientIp, `PROJ-062 ${hex()}`);
  const title = '<b onmouseover=alert(1)>bold</b>';
  const link = await createLink(owner, clientIp, project.id, { title });
  await insertClicks(link.id, 2, '1 hour');

  await signIn(page, owner);
  await openProject(page, project.id);
  const topLinks = cardTitled(page, 'Top Links');
  const titleLink = topLinks.getByRole('link', { name: title, exact: true });
  await expect(titleLink).toBeVisible();
  await expect(titleLink).toHaveText(title);
  await topLinks.getByRole('row').nth(1).hover();
  await titleLink.hover();
  await expect(topLinks.locator('b')).toHaveCount(0);
  await expect(page.locator('b[onmouseover]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('PROJ-063 every role can read the dashboard stats', async ({ browser, baseURL, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj063-o');
  const admin = await createAccount(clientIp, 'proj063-a');
  const member = await createAccount(clientIp, 'proj063-m');
  const project = await createProject(owner, clientIp, `PROJ-063 ${hex()}`);
  await addMember(project.id, admin.userId, 'admin', owner.userId);
  await addMember(project.id, member.userId, 'member', owner.userId);
  const l1 = await createLink(owner, clientIp, project.id, { title: 'PROJ-063 one' });
  const l2 = await createLink(owner, clientIp, project.id, { title: 'PROJ-063 two' });
  await insertClicks(l1.id, 2, '2 hours');
  await insertClicks(l2.id, 1, '3 days');

  const expected = { totalLinks: 2, clicks24h: 2, clicks7d: 3, clicks30d: 3, totalConversions: 0 };
  const seen = [];
  for (const who of [owner, admin, member]) {
    const response = await projectStats(who, clientIp, project.id);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject(expected);
    seen.push(response.body.data);
  }
  expect(seen[1]).toEqual(seen[0]);
  expect(seen[2]).toEqual(seen[0]);

  for (const who of [owner, admin, member]) {
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const page = await context.newPage();
      await signIn(page, who);
      await openProject(page, project.id);
      await expect(statCard(page, 'This project')).toHaveText(/Total Links\s*2\s*This project/);
      await expect(statCard(page, 'Last 24 hours')).toHaveText(/Clicks \(24h\)\s*2\s*Last 24 hours/);
      await expect(statCard(page, 'Last 7 days')).toHaveText(/Clicks \(7d\)\s*3\s*Last 7 days/);
      await expect(statCard(page, 'Total conversions')).toHaveText(/Conversions\s*0\s*Total conversions/);
    } finally {
      await context.close();
    }
  }
});

test('PROJ-065 clicks on a suspended billing owner\'s link do not move the dashboard', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'proj065-a');
  const b = await createAccount(clientIp, 'proj065-b');
  const project = await createProject(a, clientIp, `PROJ-065 ${hex()}`);
  await addMember(project.id, b.userId, 'owner', a.userId);
  const link = await createLink(a, clientIp, project.id, { title: 'PROJ-065 link' });

  // Before the suspension a click is recorded, so the later silence is the suspension's.
  const live = await openShortLink(link.shortCode, clientIp);
  expect(live.status).toBe(302);
  const clicks24h = async () => (await projectStats(b, clientIp, project.id)).body.data.clicks24h;
  await expect.poll(clicks24h, { timeout: 15_000 }).toBe(1);

  await suspendAccount(a.userId);
  const refused = await openShortLink(link.shortCode, clientIp);
  expect(refused.status).toBe(404);
  expect(refused.contentType).toContain('text/html');
  expect(refused.body).toContain('This link is unavailable');

  // Clicks are written after the answer, so a later click on a live link (B's own
  // project, not suspended) is waited for: once it is stored, the refused request has
  // had every chance to write one too.
  const control = await createProject(b, clientIp, `PROJ-065 control ${hex()}`);
  const controlLink = await createLink(b, clientIp, control.id, { title: 'PROJ-065 control link' });
  expect((await openShortLink(controlLink.shortCode, clientIp)).status).toBe(302);
  await expect.poll(async () => (await projectStats(b, clientIp, control.id)).body.data.clicks24h, { timeout: 15_000 }).toBe(1);
  const after = await projectStats(b, clientIp, project.id);
  expect(after.status).toBe(200);
  expect(after.body.data.clicks24h).toBe(1);
  const [row] = await dbRows<{ n: number }>(`SELECT count(*)::int AS n FROM click_events WHERE link_id = $1`, [link.id]);
  expect(row.n).toBe(1);

  await signIn(page, b);
  await openProject(page, project.id);
  await expect(statCard(page, 'Last 24 hours')).toHaveText(/Clicks \(24h\)\s*1\s*Last 24 hours/);
});


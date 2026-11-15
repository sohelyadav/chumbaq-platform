import { randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { api, createAccount, createApiKey, createProject } from '../../support/api';
import { expect, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import { stackEnv } from '../../support/stack';
import {
  addMember,
  ADMIN_PERMISSIONS,
  billingEnabled,
  createLink,
  createProjectWith,
  dbRows,
  insertClicks,
  listProjects,
  MEMBER_PERMISSIONS,
  newStaffSession,
  OWNER_PERMISSIONS,
  ownedProjectCount,
  projectLimitMessage,
  rawApi,
  setProjectLimit,
  viewAsToken,
} from '../../support/areas/proj';

/**
 * Projects: the list API, the selector, creating a project and the project limit,
 * opening projects by id, the sidebar for a member, and the dashboard stats APIs.
 * Every test makes its own accounts and projects.
 */

const PLATFORM_HOST_MESSAGE =
  'This domain is where this platform serves its own dashboard and short links. Enter your own domain.';
const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'Project not found' };

const sorted = (values: string[]) => [...values].sort();

/** A card on the project selector, by the project's name. */
function projectCard(page: Page, name: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) });
}

/** A stat card on the project dashboard, by the line under its number. */
function statCard(page: Page, description: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(description, { exact: true }) });
}

function withoutRequestFields(body: Record<string, unknown>) {
  const { timestamp: _timestamp, path: _path, ...rest } = body;
  return rest;
}

// ---------------------------------------------------------------------------
// A. Project list API
// ---------------------------------------------------------------------------

test('PROJ-001 list returns the caller\'s projects with role, billing flag and permissions', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj001-a');
  const b = await createAccount(clientIp, 'proj001-b');
  const outsider = await createAccount(clientIp, 'proj001-o');
  await setProjectLimit(a.userId, 7);

  const p1 = await createProject(a, clientIp, 'PROJ-001 P1');
  const p2 = await createProject(a, clientIp, 'PROJ-001 P2');
  const p3 = await createProject(b, clientIp, 'PROJ-001 P3');
  await addMember(p3.id, a.userId, 'member', b.userId);
  const p4 = await createProject(outsider, clientIp, 'PROJ-001 P4');

  const { data, meta } = await listProjects(a, clientIp);
  const ids = data.map((p) => p.id);
  expect(sorted(ids)).toEqual(sorted([p1.id, p2.id, p3.id]));
  expect(ids).not.toContain(p4.id);
  // Newest first.
  expect(ids).toEqual([p3.id, p2.id, p1.id]);
  const created = data.map((p) => new Date(p.createdAt).getTime());
  expect(created).toEqual([...created].sort((x, y) => y - x));

  for (const own of data.filter((p) => p.id !== p3.id)) {
    expect(own.role).toBe('owner');
    expect(own.isBillingOwner).toBe(true);
    expect(sorted(own.permissions)).toEqual(sorted(OWNER_PERMISSIONS));
  }
  const joined = data.find((p) => p.id === p3.id);
  expect(joined.role).toBe('member');
  expect(joined.isBillingOwner).toBe(false);
  expect(joined.permissions).toEqual(MEMBER_PERMISSIONS);

  expect(meta).toMatchObject({ total: 3, page: 1, limit: 20, totalPages: 1, billedProjects: 2, projectLimit: 7 });
});

test('PROJ-003 billedProjects counts only projects billed to the caller', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj003-a');
  const b = await createAccount(clientIp, 'proj003-b');
  const c = await createAccount(clientIp, 'proj003-c');
  const p1 = await createProject(b, clientIp, 'PROJ-003 co-owned');
  const p2 = await createProject(c, clientIp, 'PROJ-003 administered');
  await addMember(p1.id, a.userId, 'owner', b.userId);
  await addMember(p2.id, a.userId, 'admin', c.userId);

  const { data, meta } = await listProjects(a, clientIp);
  expect(data).toHaveLength(2);
  expect(meta.billedProjects).toBe(0);
  const coOwned = data.find((p) => p.id === p1.id);
  expect(coOwned).toMatchObject({ role: 'owner', isBillingOwner: false });
  expect(sorted(coOwned.permissions)).toEqual(sorted(OWNER_PERMISSIONS));
  const administered = data.find((p) => p.id === p2.id);
  expect(administered).toMatchObject({ role: 'admin', isBillingOwner: false });
  expect(sorted(administered.permissions)).toEqual(sorted(ADMIN_PERMISSIONS));
});

test('PROJ-006 anonymous, garbage and staff tokens are refused on project APIs', async ({ page, clientIp }) => {
  test.slow(); // The staff grant runs the CLI.
  const owner = await createAccount(clientIp, 'proj006');
  const project = await createProject(owner, clientIp, 'PROJ-006 untouched');
  const { staffToken } = await newStaffSession(page, clientIp);
  const [before] = await dbRows<{ n: number }>('SELECT count(*)::int AS n FROM projects');

  const routes: [string, string, unknown?][] = [
    ['GET', '/api/projects'],
    ['POST', '/api/projects', { name: 'Anonymous project', domain: 'anon.e2e.example.test' }],
    ['GET', `/api/projects/${project.id}`],
    ['PATCH', `/api/projects/${project.id}`, { name: 'Renamed anonymously' }],
    ['POST', `/api/projects/${project.id}/domain/verify`],
    ['DELETE', `/api/projects/${project.id}`],
    ['GET', '/api/dashboard/stats'],
    ['GET', `/api/projects/${project.id}/stats`],
  ];
  const callers: [string, string | undefined][] = [
    ['no token', undefined],
    ['garbage token', 'not.a.jwt'],
    ['staff token', staffToken],
  ];
  for (const [caller, token] of callers) {
    for (const [method, path, body] of routes) {
      const response = await rawApi(method, path, { token, ip: clientIp, body });
      expect(response.status, `${caller}: ${method} ${path}`).toBe(401);
    }
  }

  const [after] = await dbRows<{ n: number }>('SELECT count(*)::int AS n FROM projects');
  expect(after.n).toBe(before.n);
  const [row] = await dbRows<{ name: string }>('SELECT name FROM projects WHERE id = $1', [project.id]);
  expect(row.name).toBe('PROJ-006 untouched');
});

// ---------------------------------------------------------------------------
// B. Project selector page
// ---------------------------------------------------------------------------

test('PROJ-007 selector renders the account\'s projects', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'proj007-a', 'Sel Owner');
  const b = await createAccount(clientIp, 'proj007-b');
  await createProjectWith(a, clientIp, {
    name: 'PROJ-007 Apps',
    domain: 'apps.proj007.example.test',
    iosBundleId: 'com.example.proj007',
    androidPackageName: 'com.example.proj007',
  });
  await createProjectWith(a, clientIp, { name: 'PROJ-007 Web', domain: 'web.proj007.example.test' });
  const p3 = await createProjectWith(b, clientIp, { name: 'PROJ-007 Joined', domain: 'joined.proj007.example.test' });
  await addMember(p3.id, a.userId, 'member', b.userId);
  const { meta } = await listProjects(a, clientIp);

  await signIn(page, a);
  await expect(page).toHaveURL(/\/projects$/);
  const header = page.locator('header');
  await expect(header.getByText('Chumbaq', { exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: a.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByText('Every project you belong to, with your role in it.')).toBeVisible();
  await expect(page.getByText(`2 of ${meta.projectLimit} projects`)).toBeVisible();

  const apps = projectCard(page, 'PROJ-007 Apps');
  const web = projectCard(page, 'PROJ-007 Web');
  const joined = projectCard(page, 'PROJ-007 Joined');
  await expect(apps).toContainText('apps.proj007.example.test');
  await expect(apps.getByText('Owner', { exact: true })).toBeVisible();
  await expect(apps.getByText('iOS', { exact: true })).toBeVisible();
  await expect(apps.getByText('Android', { exact: true })).toBeVisible();
  await expect(web).toContainText('web.proj007.example.test');
  await expect(web.getByText('Owner', { exact: true })).toBeVisible();
  await expect(web.getByText('iOS', { exact: true })).toHaveCount(0);
  await expect(web.getByText('Android', { exact: true })).toHaveCount(0);
  await expect(joined).toContainText('joined.proj007.example.test');
  await expect(joined.getByText('Member', { exact: true })).toBeVisible();
  for (const card of [apps, web, joined]) await expect(card.locator('svg.lucide-globe')).toHaveCount(1);

  // The dashed "New Project" card ends the grid; no link counts are shown.
  await expect(page.locator('span', { hasText: /^New Project$/ })).toBeVisible();
  await expect(page.getByText(/\d+ links?$/)).toHaveCount(0);
});

test('PROJ-008 clicking a project card opens its dashboard', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj008');
  const project = await createProject(owner, clientIp, 'PROJ-008 Open me');
  await signIn(page, owner);
  await page.getByText(project.name, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText(project.name, { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// C. Create project and the project limit
// ---------------------------------------------------------------------------

test('PROJ-017 create a project from the header button', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj017');
  await createProject(owner, clientIp, 'PROJ-017 first');
  const { meta } = await listProjects(owner, clientIp);
  await signIn(page, owner);
  await expect(page.getByText(`1 of ${meta.projectLimit} projects`)).toBeVisible();

  // Hold the create long enough to see the pending label.
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await dialog.getByPlaceholder('My App').fill('Checkout App');
  await dialog.getByPlaceholder('example.com').fill('links.checkout.example.test');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(dialog.getByRole('button', { name: 'Creating...' })).toBeDisabled();

  await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Checkout App', { exact: true }).first()).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
  const projectId = /\/projects\/([0-9a-f-]{36})\//.exec(page.url())![1];
  await expect(page.getByRole('heading', { name: 'Checkout App', level: 1 })).toBeVisible();
  await expect(page.getByText('_chumbaq-verify.links.checkout.example.test', { exact: true })).toBeVisible();
  await expect(page.getByText(/^chumbaq-verify=[0-9a-f]{32}$/)).toBeVisible();

  const [row] = await dbRows<{ owner_id: string; token: string; verified: Date | null; name: string; domain: string }>(
    `SELECT owner_id, domain_verification_token AS token, domain_verified_at AS verified, name, domain FROM projects WHERE id = $1`,
    [projectId],
  );
  expect(row).toMatchObject({ owner_id: owner.userId, verified: null, name: 'Checkout App', domain: 'links.checkout.example.test' });
  expect(row.token).toMatch(/^[0-9a-f]{32}$/);
  await expect(page.getByText(`chumbaq-verify=${row.token}`, { exact: true })).toBeVisible();
  const members = await dbRows<{ user_id: string; role: string; added_by: string | null }>(
    `SELECT user_id, role, added_by FROM project_members WHERE project_id = $1`,
    [projectId],
  );
  expect(members).toEqual([{ user_id: owner.userId, role: 'owner', added_by: null }]);
  const [activity] = await dbRows<{ n: number }>(`SELECT count(*)::int AS n FROM project_activity WHERE project_id = $1`, [projectId]);
  expect(activity.n).toBe(0);

  await page.goto('/projects');
  await expect(page.getByText(`2 of ${meta.projectLimit} projects`)).toBeVisible();
});

test('PROJ-022 a platform host is refused as a project domain', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj022');
  const env = stackEnv();
  const domains = [
    'localhost',
    'LOCALHOST.',
    'https://localhost:5173/x',
    'localhost:443',
    ...(['API_BASE_URL', 'SHORT_LINK_DOMAIN', 'ADMIN_APP_URL'] as const).map((name) => env[name]).filter(Boolean),
  ];
  for (const [index, domain] of domains.entries()) {
    const response = await rawApi<{ message: string[] }>('POST', '/api/projects', {
      token: owner.accessToken,
      ip: clientIp,
      body: { name: 'Platform host', domain },
    });
    expect(response.status, `domain #${index}`).toBe(400);
    expect(response.body.message, `domain #${index}`).toContain(PLATFORM_HOST_MESSAGE);
  }
  expect(await ownedProjectCount(owner.userId)).toBe(0);

  await signIn(page, owner);
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await dialog.getByPlaceholder('My App').fill('Platform host app');
  await dialog.getByPlaceholder('example.com').fill('localhost');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Failed to create project');
  await expect(page.getByText('Project not created', { exact: true }).first()).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await ownedProjectCount(owner.userId)).toBe(0);
});

test('PROJ-023 create refuses fields that set ownership or verification', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj023-a');
  const b = await createAccount(clientIp, 'proj023-b');
  const extras: Record<string, unknown> = {
    ownerId: b.userId,
    domainVerifiedAt: '2026-01-01T00:00:00Z',
    domainVerificationToken: 'x',
    id: randomUUID(),
    pendingBillingOwnerId: b.userId,
    identityKeyVersion: 9,
  };
  for (const [field, value] of Object.entries(extras)) {
    const response = await rawApi<{ message: string[] }>('POST', '/api/projects', {
      token: a.accessToken,
      ip: clientIp,
      body: { name: 'Mass assignment', domain: 'mass.e2e.example.test', [field]: value },
    });
    expect(response.status, field).toBe(400);
    expect(response.body.message, field).toContain(`property ${field} should not exist`);
  }
  expect(await ownedProjectCount(a.userId)).toBe(0);
  expect(await ownedProjectCount(b.userId)).toBe(0);
});

test('PROJ-025 at the project limit the selector stops offering create', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj025');
  await setProjectLimit(owner.userId, 2);
  await createProject(owner, clientIp, 'PROJ-025 one');
  await createProject(owner, clientIp, 'PROJ-025 two');
  const billingOn = await billingEnabled(owner, clientIp);

  await signIn(page, owner);
  await expect(page.getByText('2 of 2 projects')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Project' })).toBeDisabled();
  await expect(page.getByText('PROJ-025 two', { exact: true })).toBeVisible();
  await expect(page.locator('span', { hasText: /^New Project$/ })).toHaveCount(0);
  const status = page.getByRole('status').filter({ hasText: 'You can have up to' });
  await expect(status).toContainText(projectLimitMessage(2, billingOn));
  if (billingOn) await expect(status.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/account/billing');
});

test('PROJ-026 the API refuses the project after the default limit', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj026');
  const { meta } = await listProjects(owner, clientIp);
  const limit = meta.projectLimit;
  expect(limit).toBeGreaterThan(0);
  for (let i = 0; i < limit; i += 1) await createProject(owner, clientIp, `PROJ-026 #${i + 1}`);

  const refused = await rawApi<{ message: string }>('POST', '/api/projects', {
    token: owner.accessToken,
    ip: clientIp,
    body: { name: 'One too many', domain: 'too-many.e2e.example.test' },
  });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(projectLimitMessage(limit, await billingEnabled(owner, clientIp)));
  expect(await ownedProjectCount(owner.userId)).toBe(limit);
});

test('PROJ-027 limit reached in another tab: the refusal is shown in the dialog', async ({ page, context, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj027');
  await setProjectLimit(owner.userId, 2);
  await createProject(owner, clientIp, 'PROJ-027 existing');
  const message = projectLimitMessage(2, await billingEnabled(owner, clientIp));

  await signIn(page, owner);
  await expect(page.getByText('1 of 2 projects')).toBeVisible();
  const tabB = await context.newPage();
  await tabB.goto('/projects');
  await expect(tabB.getByText('1 of 2 projects')).toBeVisible();

  // Tab B starts its create while it still sees room.
  await tabB.getByRole('button', { name: 'New Project' }).click();
  const dialogB = tabB.getByRole('dialog', { name: 'New Project' });
  await dialogB.getByPlaceholder('My App').fill('Tab B project');
  await dialogB.getByPlaceholder('example.com').fill('tab-b.e2e.example.test');

  // Tab A takes the last place.
  await page.bringToFront();
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialogA = page.getByRole('dialog', { name: 'New Project' });
  await dialogA.getByPlaceholder('My App').fill('Tab A project');
  await dialogA.getByPlaceholder('example.com').fill('tab-a.e2e.example.test');
  await dialogA.getByRole('button', { name: 'Create Project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/settings$/);

  await tabB.bringToFront();
  await dialogB.getByRole('button', { name: 'Create Project' }).click();
  await expect(dialogB.getByRole('alert')).toHaveText(message);
  const toast = tabB.getByRole('status').filter({ hasText: 'Project not created' });
  await expect(toast.first()).toContainText(message);
  await expect(dialogB).toBeVisible();
  expect(await ownedProjectCount(owner.userId)).toBe(2);

  await tabB.reload();
  await expect(tabB.getByText('2 of 2 projects')).toBeVisible();
  await expect(tabB.getByRole('button', { name: 'New Project' })).toBeDisabled();
});

test('PROJ-028 concurrent creates cannot pass the limit', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj028');
  await setProjectLimit(owner.userId, 3);
  await createProject(owner, clientIp, 'PROJ-028 one');
  await createProject(owner, clientIp, 'PROJ-028 two');
  const message = projectLimitMessage(3, await billingEnabled(owner, clientIp));

  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      rawApi<{ message?: string }>('POST', '/api/projects', {
        token: owner.accessToken,
        ip: clientIp,
        body: { name: `PROJ-028 race ${i}`, domain: 'race.e2e.example.test' },
      }),
    ),
  );
  const statuses = responses.map((r) => r.status).sort();
  expect(statuses).toEqual([201, 403, 403, 403, 403]);
  for (const refused of responses.filter((r) => r.status === 403)) expect(refused.body.message).toBe(message);
  expect(await ownedProjectCount(owner.userId)).toBe(3);
});

// ---------------------------------------------------------------------------
// D. Opening a project by id
// ---------------------------------------------------------------------------

test('PROJ-035 GET a project as each role', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj035-a');
  const b = await createAccount(clientIp, 'proj035-b');
  const c = await createAccount(clientIp, 'proj035-c');
  const d = await createAccount(clientIp, 'proj035-d');
  const project = await createProject(a, clientIp, 'PROJ-035 roles');
  await addMember(project.id, b.userId, 'owner', a.userId);
  await addMember(project.id, c.userId, 'admin', a.userId);
  await addMember(project.id, d.userId, 'member', a.userId);

  const cases = [
    { who: a, role: 'owner', billing: true, permissions: OWNER_PERMISSIONS },
    { who: b, role: 'owner', billing: false, permissions: OWNER_PERMISSIONS },
    { who: c, role: 'admin', billing: false, permissions: ADMIN_PERMISSIONS },
    { who: d, role: 'member', billing: false, permissions: MEMBER_PERMISSIONS },
  ];
  for (const { who, role, billing, permissions } of cases) {
    const response = await rawApi<{ data: Record<string, any> }>('GET', `/api/projects/${project.id}`, {
      token: who.accessToken,
      ip: clientIp,
    });
    expect(response.status, role).toBe(200);
    const body = response.body.data;
    expect(body.id).toBe(project.id);
    expect(body.role).toBe(role);
    expect(body.isBillingOwner).toBe(billing);
    expect(sorted(body.permissions)).toEqual(sorted(permissions));
    expect(body).toHaveProperty('domainVerifiedAt', null);
    expect(body.domainVerificationToken).toMatch(/^[0-9a-f]{32}$/);
  }
});

test('PROJ-036 foreign, unknown and malformed project ids answer 404 alike', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj036-a');
  const b = await createAccount(clientIp, 'proj036-b');
  const own = await createProject(a, clientIp, 'PROJ-036 own');
  const foreign = await createProject(b, clientIp, 'PROJ-036 foreign');

  const ids = [foreign.id, randomUUID(), 'not-a-uuid', own.id.toUpperCase()];
  const requests = (id: string): [string, string, unknown?][] => [
    ['GET', `/api/projects/${id}`],
    ['PATCH', `/api/projects/${id}`, { name: 'Taken over' }],
    ['POST', `/api/projects/${id}/domain/verify`],
    ['DELETE', `/api/projects/${id}`],
    ['GET', `/api/projects/${id}/stats`],
  ];
  for (const [index, id] of ids.entries()) {
    for (const [method, path, body] of requests(id)) {
      const response = await rawApi<Record<string, unknown>>(method, path, { token: a.accessToken, ip: clientIp, body });
      expect(response.status, `id #${index}: ${method}`).toBe(404);
      expect(withoutRequestFields(response.body), `id #${index}: ${method}`).toEqual(NOT_FOUND);
    }
  }

  const rows = await dbRows<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id = ANY($1) ORDER BY name`, [
    [own.id, foreign.id],
  ]);
  expect(rows).toEqual([
    { id: foreign.id, name: 'PROJ-036 foreign' },
    { id: own.id, name: 'PROJ-036 own' },
  ]);
});

test('PROJ-037 unknown or foreign project URLs return to the selector', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'proj037-a');
  const b = await createAccount(clientIp, 'proj037-b');
  const foreign = await createProject(b, clientIp, `PROJ-037 foreign ${randomUUID().slice(0, 8)}`);

  const leaked: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes(`/api/projects/${foreign.id}`) && response.ok()) leaked.push(response.url());
  });

  await signIn(page, a);
  for (const path of [`/projects/${foreign.id}`, `/projects/${randomUUID()}/settings`, '/projects/not-a-uuid/links']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/projects$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
    await expect(page.getByText(foreign.name)).toHaveCount(0);
  }
  expect(leaked).toEqual([]);
});

test('PROJ-038 other project ids in the body or query are checked too', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj038-a');
  const b = await createAccount(clientIp, 'proj038-b');
  const pa = await createProject(a, clientIp, 'PROJ-038 A');
  const pb = await createProject(b, clientIp, 'PROJ-038 B');
  const as = { token: a.accessToken, ip: clientIp };

  const viaQuery = await rawApi('GET', `/api/projects/${pa.id}?projectId=${pb.id}`, as);
  expect(viaQuery.status).toBe(404);
  expect(withoutRequestFields(viaQuery.body)).toEqual(NOT_FOUND);

  for (const projectId of [pb.id, 'not-a-uuid']) {
    const response = await rawApi('PATCH', `/api/projects/${pa.id}`, { ...as, body: { name: 'x', projectId } });
    expect(response.status).toBe(404);
    expect(withoutRequestFields(response.body)).toEqual(NOT_FOUND);
  }

  const own = await rawApi<{ message: string[] }>('PATCH', `/api/projects/${pa.id}`, { ...as, body: { name: 'x', projectId: pa.id } });
  expect(own.status).toBe(400);
  expect(own.body.message).toContain('property projectId should not exist');

  const rows = await dbRows<{ name: string }>(`SELECT name FROM projects WHERE id = ANY($1) ORDER BY name`, [[pa.id, pb.id]]);
  expect(rows.map((r) => r.name)).toEqual(['PROJ-038 A', 'PROJ-038 B']);
});

// ---------------------------------------------------------------------------
// E. App shell
// ---------------------------------------------------------------------------

test('PROJ-043 the sidebar hides Activity from a member', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj043-o');
  const member = await createAccount(clientIp, 'proj043-m');
  const project = await createProject(owner, clientIp, 'PROJ-043 project');
  await addMember(project.id, member.userId, 'member', owner.userId);

  await signIn(page, member);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const base = `/projects/${project.id}`;

  await openSidebarGroup(page, 'Configure');
  for (const [name, href] of [
    ['Mixpanel Cohorts', `${base}/mixpanel/cohorts`],
    ['API Keys', `${base}/api-keys`],
    ['Webhooks', `${base}/webhooks`],
    ['Members', `${base}/team`],
  ]) {
    await expect(sidebarLink(page, name)).toHaveAttribute('href', href);
  }
  await expect(sidebarLink(page, 'Activity')).toHaveCount(0);

  // Everything else as an owner has it.
  await openSidebarGroup(page, 'Main');
  for (const name of ['Dashboard', 'Analytics', 'Attribution', 'Touchpoints', 'Users', 'Events', 'Links']) {
    await expect(sidebarLink(page, name)).toBeVisible();
  }
  await openSidebarGroup(page, 'Widgets');
  for (const name of ['Banners', 'Carousels', 'Stories', 'Grids', 'Swipe Strips']) await expect(sidebarLink(page, name)).toBeVisible();
  await openSidebarGroup(page, 'Engagement');
  for (const name of ['In-App Messages', 'Push Notifications']) await expect(sidebarLink(page, name)).toBeVisible();
  await expect(sidebarLink(page, 'Project Settings')).toHaveAttribute('href', `${base}/settings`);

  // An owner of the same project does see it (so the member's view is the role, not the page).
  const ownerView = await rawApi<{ data: { permissions: string[] } }>('GET', `/api/projects/${project.id}`, {
    token: owner.accessToken,
    ip: clientIp,
  });
  expect(ownerView.body.data.permissions).toContain('activity.view');

  // The API refuses the member the log itself.
  const refused = await rawApi<{ message: string }>('GET', `/api/projects/${project.id}/activity`, {
    token: member.accessToken,
    ip: clientIp,
  });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe('Your role in this project does not allow this.');
});

// ---------------------------------------------------------------------------
// F. Project dashboard and its stats API
// ---------------------------------------------------------------------------

test('PROJ-059 dashboard with links, clicks and conversions', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj059');
  const project = await createProject(owner, clientIp, 'PROJ-059 stats');
  const l1 = await createLink(owner, clientIp, project.id, { title: 'PROJ-059 hot link' });
  const l2 = await createLink(owner, clientIp, project.id); // no title
  const l3 = await createLink(owner, clientIp, project.id, { title: 'PROJ-059 twenty days' });
  const l4 = await createLink(owner, clientIp, project.id, { title: 'PROJ-059 forty days' });
  const l5 = await createLink(owner, clientIp, project.id, { title: 'PROJ-059 quiet five' });
  const l6 = await createLink(owner, clientIp, project.id, { title: 'PROJ-059 quiet six' });
  await insertClicks(l1.id, 3, '1 hour');
  await insertClicks(l2.id, 2, '3 days');
  await insertClicks(l3.id, 1, '20 days');
  await insertClicks(l4.id, 1, '40 days');
  const apiKey = await createApiKey(owner, project.id, clientIp);
  for (const eventType of ['signup', 'purchase']) {
    await api('POST', '/api/conversions', { linkId: l1.id, eventType }, { apiKey, ip: clientIp });
  }

  const stats = await api<{
    totalLinks: number;
    clicks24h: number;
    clicks7d: number;
    clicks30d: number;
    totalConversions: number;
    topLinks: { id: string; title: string | null; shortCode: string; clicks: number }[];
  }>('GET', `/api/projects/${project.id}/stats`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(stats).toMatchObject({ totalLinks: 6, clicks24h: 3, clicks7d: 5, clicks30d: 6, totalConversions: 2 });
  expect(stats.topLinks).toHaveLength(5);
  expect(stats.topLinks.map((l) => l.clicks)).toEqual([3, 2, 1, 1, 0]);
  expect(stats.topLinks[0]).toMatchObject({ id: l1.id, shortCode: l1.shortCode, title: 'PROJ-059 hot link' });
  expect(stats.topLinks[1]).toMatchObject({ id: l2.id, shortCode: l2.shortCode });
  expect(sorted(stats.topLinks.slice(2, 4).map((l) => l.id))).toEqual(sorted([l3.id, l4.id]));
  expect([l5.id, l6.id]).toContain(stats.topLinks[4].id);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(statCard(page, 'This project')).toHaveText(/Total Links\s*6\s*This project/);
  await expect(statCard(page, 'Last 24 hours')).toHaveText(/Clicks \(24h\)\s*3\s*Last 24 hours/);
  await expect(statCard(page, 'Last 7 days')).toHaveText(/Clicks \(7d\)\s*5\s*Last 7 days/);
  await expect(statCard(page, 'Total conversions')).toHaveText(/Conversions\s*2\s*Total conversions/);

  const topLinks = page.locator('[data-slot="card"]').filter({ has: page.getByText('Top Links', { exact: true }) });
  await expect(topLinks.getByRole('columnheader')).toHaveText(['Title', 'Short Code', 'Clicks']);
  const rows = topLinks.getByRole('row');
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(1)).toHaveText(new RegExp(`PROJ-059 hot link\\s*${l1.shortCode}\\s*3`));
  // The untitled link shows its short code as its title.
  await expect(rows.nth(2).getByRole('link', { name: l2.shortCode, exact: true })).toBeVisible();
  await expect(rows.nth(2)).toHaveText(new RegExp(`${l2.shortCode}\\s*${l2.shortCode}\\s*2`));

  const overview = page.locator('[data-slot="card"]').filter({ has: page.getByText('Overview', { exact: true }) });
  const bar = (label: string) => overview.locator('div.space-y-1').filter({ hasText: label }).locator('div.bg-primary');
  await expect(overview.locator('div.space-y-1').filter({ hasText: 'Clicks (30d)' })).toContainText('6');
  await expect(bar('Clicks (30d)')).toHaveAttribute('style', /width: 100%/);
  await expect(bar('Clicks (24h)')).toHaveAttribute('style', /width: 50%/);
  await expect(bar('Total Conversions')).toHaveAttribute('style', /width: 33\.3/);
});

test('PROJ-064 stats are scoped to the project', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj064');
  const pa = await createProject(owner, clientIp, 'PROJ-064 A');
  const pb = await createProject(owner, clientIp, 'PROJ-064 B');
  const a1 = await createLink(owner, clientIp, pa.id, { title: 'PROJ-064 A1' });
  const a2 = await createLink(owner, clientIp, pa.id, { title: 'PROJ-064 A2' });
  const b1 = await createLink(owner, clientIp, pb.id, { title: 'PROJ-064 B1' });
  await insertClicks(a1.id, 2, '2 hours');
  await insertClicks(a2.id, 1, '2 days');
  await insertClicks(b1.id, 4, '1 hour');
  const keyB = await createApiKey(owner, pb.id, clientIp);
  await api('POST', '/api/conversions', { linkId: b1.id, eventType: 'signup' }, { apiKey: keyB, ip: clientIp });

  const statsOf = (projectId: string) =>
    api<{ totalLinks: number; clicks24h: number; clicks7d: number; clicks30d: number; totalConversions: number; topLinks: { id: string }[] }>(
      'GET',
      `/api/projects/${projectId}/stats`,
      undefined,
      { token: owner.accessToken, ip: clientIp },
    );
  const a = await statsOf(pa.id);
  expect(a).toMatchObject({ totalLinks: 2, clicks24h: 2, clicks7d: 3, clicks30d: 3, totalConversions: 0 });
  expect(sorted(a.topLinks.map((l) => l.id))).toEqual(sorted([a1.id, a2.id]));
  const b = await statsOf(pb.id);
  expect(b).toMatchObject({ totalLinks: 1, clicks24h: 4, clicks7d: 4, clicks30d: 4, totalConversions: 1 });
  expect(b.topLinks.map((l) => l.id)).toEqual([b1.id]);
});

// ---------------------------------------------------------------------------
// G. Account-wide stats
// ---------------------------------------------------------------------------

test('PROJ-068 account stats in view-as count only the tenant\'s billed projects', async ({ page, clientIp }) => {
  test.slow(); // The staff grant runs the CLI.
  const tenant = await createAccount(clientIp, 'proj068-t');
  const other = await createAccount(clientIp, 'proj068-o');
  const billed = await createProject(tenant, clientIp, 'PROJ-068 billed');
  const joined = await createProject(other, clientIp, 'PROJ-068 joined');
  await addMember(joined.id, tenant.userId, 'member', other.userId);
  const billedLink = await createLink(tenant, clientIp, billed.id, { title: 'PROJ-068 billed link' });
  const joinedLink = await createLink(other, clientIp, joined.id, { title: 'PROJ-068 joined link' });
  await insertClicks(billedLink.id, 2, '1 hour');
  await insertClicks(joinedLink.id, 5, '1 hour');
  const joinedKey = await createApiKey(other, joined.id, clientIp);
  await api('POST', '/api/conversions', { linkId: joinedLink.id, eventType: 'signup' }, { apiKey: joinedKey, ip: clientIp });

  type Stats = { totalLinks: number; clicks24h: number; clicks7d: number; clicks30d: number; totalConversions: number; topLinks: { id: string }[] };
  // The tenant's own view counts both, so the view-as numbers below are a real narrowing.
  const own = await api<Stats>('GET', '/api/dashboard/stats', undefined, { token: tenant.accessToken, ip: clientIp });
  expect(own).toMatchObject({ totalLinks: 2, clicks24h: 7, totalConversions: 1 });

  const { staffToken } = await newStaffSession(page, clientIp);
  const token = await viewAsToken(staffToken, tenant.userId, clientIp);
  const viewed = await api<Stats>('GET', '/api/dashboard/stats', undefined, { token, ip: clientIp });
  expect(viewed).toMatchObject({ totalLinks: 1, clicks24h: 2, clicks7d: 2, clicks30d: 2, totalConversions: 0 });
  expect(viewed.topLinks.map((l) => l.id)).toEqual([billedLink.id]);
});

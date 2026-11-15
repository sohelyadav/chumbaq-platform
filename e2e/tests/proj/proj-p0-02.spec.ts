import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { createAccount, createApiKey, createProject, type Account } from '../../support/api';
import { confirmWithPassword } from '../../support/factors';
import { expect, newPersonContext, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addMember,
  ageSignIn,
  billingEnabled,
  cardTitled,
  createLink,
  createProjectWith,
  dbRows,
  insertClicks,
  listProjects,
  openViewAs,
  ownedProjectCount,
  projectRow,
  rawApi,
  setProjectColumns,
  settingsInput,
  staffForViewAs,
  staleAccessToken,
  suspendAccount,
  toastWith,
  type Role,
} from '../../support/areas/proj';

/**
 * Projects: the settings page, domain proof refusals, deleting a project, view-as and
 * suspension at the project level, and what project responses carry. Every test makes
 * its own accounts and projects.
 */

const ROLE_REFUSAL = 'Your role in this project does not allow this.';
const READ_ONLY = 'Impersonation sessions are read-only';
const REAUTH_REQUIRED = 'Confirm it is you to continue.';
const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'Project not found' };

const hex = () => randomBytes(4).toString('hex');
/** A domain no other test uses, since only one project may hold a proof per domain. */
const uniqueDomain = (label: string, tld = 'example.test') => `${label}-${hex()}.${tld}`;

function withoutRequestFields(body: Record<string, unknown>) {
  const { timestamp: _timestamp, path: _path, ...rest } = body;
  return rest;
}

/** Holds matching requests for a moment, so a pending label can be seen. */
async function holdRequests(page: Page, glob: string, method: string, ms = 1500): Promise<void> {
  await page.route(glob, async (route) => {
    if (route.request().method() === method) await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

function proofBox(page: Page) {
  return page.locator('p').filter({ hasText: 'To open app links on' });
}

function proofText(domain: string, token: string): string {
  return (
    `To open app links on ${domain}, prove you control it: add a TXT record named _chumbaq-verify.${domain} ` +
    `with the value chumbaq-verify=${token}, then verify.`
  );
}

/** The project's activity, less the `staff.viewed_as` entry a view-as session writes when it starts. */
async function activityApartFromViewAs(projectId: string) {
  return (await activityRows(projectId)).filter((row) => row.action !== 'staff.viewed_as');
}

async function openSettings(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByRole('button', { name: /^Save Changes$|^Saving\.\.\.$/ }).or(page.getByText('Only owners can change these settings.'))).toBeVisible();
}

// ---------------------------------------------------------------------------
// H. Project settings
// ---------------------------------------------------------------------------

test('PROJ-069 settings page loads the project for an owner', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj069');
  const domain = uniqueDomain('links-069');
  const fields = {
    name: `PROJ-069 ${hex()}`,
    domain,
    webFallbackUrl: 'https://example.test/home',
    iosBundleId: 'com.example.proj069',
    iosTeamId: 'ABCDE12345',
    iosAppStoreUrl: 'https://apps.apple.com/app/id123',
    iosAppStoreId: '123',
    androidPackageName: 'com.example.proj069.android',
    androidPlayStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.proj069',
    androidSha256Fingerprints: 'AA:BB:CC',
  };
  const project = await createProjectWith(owner, clientIp, fields);
  const token = (await projectRow(project.id))!.domain_verification_token!;

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await sidebarLink(page, 'Project Settings').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/settings$`));

  await expect(page.locator('button:has(svg.lucide-arrow-left)')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fields.name);
  await expect(page.getByText('Only owners can change these settings.')).toHaveCount(0);

  const general = cardTitled(page, 'General');
  await expect(general).toContainText('Basic project settings');
  await expect(settingsInput(page, 'Project Name')).toHaveValue(fields.name);
  await expect(settingsInput(page, 'Domain')).toHaveValue(domain);
  await expect(proofBox(page)).toHaveText(proofText(domain, token));
  await expect(general.getByRole('button', { name: 'Verify domain' })).toBeEnabled();
  await expect(settingsInput(page, 'Web Fallback URL')).toHaveValue(fields.webFallbackUrl);

  const ios = cardTitled(page, 'iOS Configuration');
  await expect(ios).toContainText('Configure iOS app settings for deep linking');
  await expect(settingsInput(page, 'Bundle ID')).toHaveValue(fields.iosBundleId);
  await expect(settingsInput(page, 'Team ID')).toHaveValue(fields.iosTeamId);
  await expect(settingsInput(page, 'App Store URL')).toHaveValue(fields.iosAppStoreUrl);
  await expect(settingsInput(page, 'App Store ID')).toHaveValue(fields.iosAppStoreId);

  const android = cardTitled(page, 'Android Configuration');
  await expect(android).toContainText('Configure Android app settings for deep linking');
  await expect(settingsInput(page, 'Package Name')).toHaveValue(fields.androidPackageName);
  await expect(settingsInput(page, 'Play Store URL')).toHaveValue(fields.androidPlayStoreUrl);
  await expect(settingsInput(page, 'SHA-256 Fingerprints')).toHaveValue(fields.androidSha256Fingerprints);
  await expect(android).toContainText('Used for Android App Links verification (assetlinks.json)');

  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  await expect(cardTitled(page, 'Billing owner')).toBeVisible();
  const leave = cardTitled(page, 'Leave project');
  await expect(leave).toContainText('This project is billed to you, so you cannot leave it. Move billing to another owner first.');
  await expect(leave.getByRole('button', { name: 'Leave project' })).toHaveCount(0);
  const danger = cardTitled(page, 'Danger Zone');
  await expect(danger).toContainText('Deleting a project will also delete all its links and analytics data.');
  await expect(danger.getByRole('button', { name: 'Delete Project' })).toBeVisible();
});

async function expectReadOnlySettings(page: Page, domain: string, token: string): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Only owners can change these settings.' })).toBeVisible();
  const name = settingsInput(page, 'Project Name');
  await expect(name).toBeDisabled();
  await expect(page.locator('fieldset')).toHaveAttribute('disabled', '');
  const inputs = page.locator('fieldset input');
  await expect(inputs).toHaveCount(10);
  for (const input of await inputs.all()) await expect(input).toBeDisabled();
  // Typing does nothing.
  await name.click({ force: true });
  await page.keyboard.type('typed');
  await expect(name).not.toHaveValue(/typed/);

  await expect(page.getByRole('button', { name: 'Save Changes' })).toHaveCount(0);
  await expect(cardTitled(page, 'Danger Zone')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete Project' })).toHaveCount(0);
  await expect(cardTitled(page, 'Billing owner')).toHaveCount(0);
  await expect(proofBox(page)).toHaveText(proofText(domain, token));
  await expect(page.getByRole('button', { name: 'Verify domain' })).toHaveCount(0);
  const leave = cardTitled(page, 'Leave project');
  await expect(leave).toContainText('You lose access to this project. Pending invites you sent are cancelled.');
  await expect(leave.getByRole('button', { name: 'Leave project' })).toBeVisible();
}

for (const [id, role] of [
  ['PROJ-071', 'admin'],
  ['PROJ-072', 'member'],
] as [string, Role][]) {
  test(`${id} settings are read-only for ${role === 'admin' ? 'an admin' : 'a member'}`, async ({ page, clientIp }) => {
    const owner = await createAccount(clientIp, `${id.toLowerCase()}-o`);
    const person = await createAccount(clientIp, `${id.toLowerCase()}-${role}`);
    const domain = uniqueDomain(`ro-${role}`);
    const project = await createProjectWith(owner, clientIp, { name: `${id} ${hex()}`, domain });
    await addMember(project.id, person.userId, role, owner.userId);
    const token = (await projectRow(project.id))!.domain_verification_token!;

    await signIn(page, person);
    await openSettings(page, project.id);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(project.name);
    await expectReadOnlySettings(page, domain, token);
    expect((await projectRow(project.id))!.name).toBe(project.name);
  });
}

test('PROJ-073 admin and member cannot change, verify or delete through the API', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj073-o');
  const admin = await createAccount(clientIp, 'proj073-c');
  const member = await createAccount(clientIp, 'proj073-d');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-073 ${hex()}`, domain: uniqueDomain('p073') });
  await addMember(project.id, admin.userId, 'admin', owner.userId);
  await addMember(project.id, member.userId, 'member', owner.userId);
  const before = await projectRow(project.id);

  for (const person of [admin, member]) {
    // Both tokens are from a sign-up a moment ago, so a refusal here is the role, not the sign-in age.
    const requests: [string, string, unknown?][] = [
      ['PATCH', `/api/projects/${project.id}`, { name: 'x' }],
      ['POST', `/api/projects/${project.id}/domain/verify`],
      ['DELETE', `/api/projects/${project.id}`],
    ];
    for (const [method, path, body] of requests) {
      const response = await rawApi<{ message: string }>(method, path, { token: person.accessToken, ip: clientIp, body });
      expect(response.status, `${person.email}: ${method}`).toBe(403);
      expect(response.body.message, `${person.email}: ${method}`).toBe(ROLE_REFUSAL);
    }
  }
  // Even with a sign-in that is no longer recent, the role is what DELETE answers first.
  const stale = await staleAccessToken(admin, clientIp);
  const staleDelete = await rawApi<{ message: string }>('DELETE', `/api/projects/${project.id}`, { token: stale, ip: clientIp });
  expect(staleDelete.status).toBe(403);
  expect(staleDelete.body.message).toBe(ROLE_REFUSAL);

  expect(await projectRow(project.id)).toEqual(before);
  expect(await activityRows(project.id)).toEqual([]);
  // The owner is allowed the same rename, so the refusals above are the roles'.
  const allowed = await rawApi('PATCH', `/api/projects/${project.id}`, { token: owner.accessToken, ip: clientIp, body: { name: 'x' } });
  expect(allowed.status).toBe(200);
});

test('PROJ-075 rename a project', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj075');
  const alpha = `PROJ-075 Alpha ${hex()}`;
  const beta = `PROJ-075 Beta ${hex()}`;
  const project = await createProjectWith(owner, clientIp, { name: alpha, domain: uniqueDomain('p075') });
  // A proof in place, to see the rename leaves it alone.
  await setProjectColumns(project.id, { domain_verified_at: new Date('2026-11-01T00:00:00Z') });
  const before = (await projectRow(project.id))!;

  await signIn(page, owner);
  await openSettings(page, project.id);
  await expect(settingsInput(page, 'Project Name')).toHaveValue(alpha);
  await holdRequests(page, `**/api/projects/${project.id}`, 'PATCH');
  await settingsInput(page, 'Project Name').fill(beta);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  await expect(toastWith(page, 'Project updated').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(beta);
  const switcher = page.locator('[data-sidebar="header"] [data-sidebar="menu-button"]');
  await expect(switcher).toContainText(beta);

  const after = (await projectRow(project.id))!;
  expect(after.name).toBe(beta);
  expect(after.domain_verified_at).toEqual(before.domain_verified_at);
  expect(after.domain_verification_token).toBe(before.domain_verification_token);
  const activity = await activityRows(project.id);
  expect(activity).toEqual([
    { action: 'project.renamed', target_label: beta, details: { from: alpha, to: beta }, actor_user_id: owner.userId },
  ]);

  await page.goto('/projects');
  await expect(page.locator('[data-slot="card"]').filter({ hasText: beta })).toBeVisible();
  await expect(page.getByText(alpha, { exact: true })).toHaveCount(0);
});

test('PROJ-080 PATCH validation and mass assignment', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj080-a');
  const other = await createAccount(clientIp, 'proj080-b');
  const name = `PROJ-080 ${hex()}`;
  const project = await createProjectWith(owner, clientIp, { name, domain: uniqueDomain('p080') });
  const as = { token: owner.accessToken, ip: clientIp };
  const before = (await projectRow(project.id))!;

  // 1. Columns the settings never write.
  const extras: Record<string, unknown> = {
    ownerId: other.userId,
    domainVerifiedAt: '2026-01-01T00:00:00Z',
    domainVerificationToken: 'x',
    pendingBillingOwnerId: other.userId,
    identityKeyVersion: 2,
  };
  for (const [field, value] of Object.entries(extras)) {
    const response = await rawApi<{ message: string[] }>('PATCH', `/api/projects/${project.id}`, { ...as, body: { [field]: value } });
    expect(response.status, field).toBe(400);
    expect(response.body.message, field).toContain(`property ${field} should not exist`);
  }
  const [identity] = await dbRows<{ v: number; pending: string | null }>(
    `SELECT identity_key_version AS v, pending_billing_owner_id AS pending FROM projects WHERE id = $1`,
    [project.id],
  );
  expect(identity).toEqual({ v: 1, pending: null });
  expect(await projectRow(project.id)).toEqual(before);

  // 2. An empty body changes nothing.
  const empty = await rawApi<{ data: { id: string; name: string } }>('PATCH', `/api/projects/${project.id}`, { ...as, body: {} });
  expect(empty.status).toBe(200);
  expect(empty.body.data).toMatchObject({ id: project.id, name });
  expect(await projectRow(project.id)).toEqual(before);
  expect(await activityRows(project.id)).toEqual([]);

  // 3. An empty name is accepted (no not-empty rule on the API).
  const blank = await rawApi<{ data: { name: string } }>('PATCH', `/api/projects/${project.id}`, { ...as, body: { name: '' } });
  expect(blank.status).toBe(200);
  expect(blank.body.data.name).toBe('');
  expect((await projectRow(project.id))!.name).toBe('');

  // 5. Clearing a verified domain drops the proof and issues a new token.
  await setProjectColumns(project.id, { domain_verified_at: new Date() });
  const withProof = (await projectRow(project.id))!;
  expect(withProof.domain_verified_at).not.toBeNull();
  const cleared = await rawApi<{ data: { domain: string | null } }>('PATCH', `/api/projects/${project.id}`, { ...as, body: { domain: null } });
  expect(cleared.status).toBe(200);
  expect(cleared.body.data.domain).toBeNull();
  const after = (await projectRow(project.id))!;
  expect(after.domain).toBeNull();
  expect(after.domain_verified_at).toBeNull();
  expect(after.domain_verification_token).toMatch(/^[0-9a-f]{32}$/);
  expect(after.domain_verification_token).not.toBe(withProof.domain_verification_token);
  const activity = await activityRows(project.id);
  expect(activity.map((row) => [row.action, row.details])).toEqual([
    ['project.renamed', { from: name, to: '' }],
    ['project.app_links_changed', { fields: ['domain'] }],
  ]);
});

test('PROJ-080 PATCH with a null name is refused as a bad request', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'PROJ-080' });
  test.fail();
  const owner = await createAccount(clientIp, 'proj080-null');
  const name = `PROJ-080 null ${hex()}`;
  const project = await createProjectWith(owner, clientIp, { name, domain: uniqueDomain('p080n') });
  const response = await rawApi<{ message: unknown }>('PATCH', `/api/projects/${project.id}`, {
    token: owner.accessToken,
    ip: clientIp,
    body: { name: null },
  });
  expect((await projectRow(project.id))!.name).toBe(name);
  expect(response.status).toBe(400);
});

// ---------------------------------------------------------------------------
// I. Domain proof
// ---------------------------------------------------------------------------

test('PROJ-084 an unverified domain shows the TXT instructions', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj084');
  const domain = 'links.example.invalid';
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-084 ${hex()}`, domain });
  const fetched = await rawApi<{ data: { domainVerificationToken: string; domainVerifiedAt: string | null } }>(
    'GET',
    `/api/projects/${project.id}`,
    { token: owner.accessToken, ip: clientIp },
  );
  const token = fetched.body.data.domainVerificationToken;
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  expect(fetched.body.data.domainVerifiedAt).toBeNull();

  await signIn(page, owner);
  await openSettings(page, project.id);
  await expect(proofBox(page)).toHaveText(proofText(domain, token));
  await expect(page.getByRole('button', { name: 'Verify domain' })).toBeEnabled();
  await expect(page.getByText(`${domain} is verified for app links.`)).toHaveCount(0);
});

test('PROJ-085 verify fails when the record is missing', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj085');
  const domain = 'links.example.invalid';
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-085 ${hex()}`, domain });
  const token = (await projectRow(project.id))!.domain_verification_token!;
  const message = `No TXT record at _chumbaq-verify.${domain} with the value chumbaq-verify=${token}. DNS changes can take a while to appear.`;

  await signIn(page, owner);
  await openSettings(page, project.id);
  await holdRequests(page, `**/api/projects/${project.id}/domain/verify`, 'POST');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/domain/verify`), { timeout: 30_000 }),
    page.getByRole('button', { name: 'Verify domain' }).click(),
    expect(page.getByRole('button', { name: 'Checking...' })).toBeDisabled(),
  ]);
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { message: string }).message).toBe(message);
  const toast = toastWith(page, 'Not verified yet').first();
  await expect(toast).toContainText(message);
  await expect(page.getByRole('button', { name: 'Verify domain' })).toBeEnabled();

  expect((await projectRow(project.id))!.domain_verified_at).toBeNull();
  expect(await activityRows(project.id)).toEqual([]);
});

test('PROJ-088 changing the domain drops the proof and issues a new token', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj088');
  const first = uniqueDomain('a');
  const second = uniqueDomain('b', 'example.invalid');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-088 ${hex()}`, domain: first });
  await setProjectColumns(project.id, { domain_verified_at: new Date() });
  const t1 = (await projectRow(project.id))!.domain_verification_token!;

  await signIn(page, owner);
  await openSettings(page, project.id);
  await expect(page.getByText(`${first} is verified for app links.`)).toBeVisible();
  await settingsInput(page, 'Domain').fill(second);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(toastWith(page, 'Project updated').first()).toBeVisible();

  const after = (await projectRow(project.id))!;
  expect(after.domain).toBe(second);
  expect(after.domain_verified_at).toBeNull();
  const t2 = after.domain_verification_token!;
  expect(t2).toMatch(/^[0-9a-f]{32}$/);
  expect(t2).not.toBe(t1);
  await expect(proofBox(page)).toHaveText(proofText(second, t2));
  await expect(page.getByText(`${first} is verified for app links.`)).toHaveCount(0);
  expect((await activityRows(project.id)).map((row) => [row.action, row.details])).toEqual([
    ['project.app_links_changed', { fields: ['domain'] }],
  ]);

  // A change of case alone is a change too.
  const third = uniqueDomain('c');
  await setProjectColumns(project.id, { domain: third, domain_verified_at: new Date() });
  const t3 = (await projectRow(project.id))!.domain_verification_token!;
  const upper = await rawApi('PATCH', `/api/projects/${project.id}`, {
    token: owner.accessToken,
    ip: clientIp,
    body: { domain: third.toUpperCase() },
  });
  expect(upper.status).toBe(200);
  const recased = (await projectRow(project.id))!;
  expect(recased.domain).toBe(third.toUpperCase());
  expect(recased.domain_verified_at).toBeNull();
  expect(recased.domain_verification_token).not.toBe(t3);
});

test('PROJ-091 a platform host cannot be verified', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj091');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-091 ${hex()}`, domain: uniqueDomain('p091') });
  // The DTO refuses a platform host, so it is written directly.
  await setProjectColumns(project.id, { domain: 'localhost' });
  const response = await rawApi<{ message: string }>('POST', `/api/projects/${project.id}/domain/verify`, {
    token: owner.accessToken,
    ip: clientIp,
  });
  expect(response.status).toBe(400);
  expect(response.body.message).toBe('This domain is where this platform serves its own pages, so it cannot be verified.');
  const row = (await projectRow(project.id))!;
  expect(row.domain).toBe('localhost');
  expect(row.domain_verified_at).toBeNull();
  expect(await activityRows(project.id)).toEqual([]);
});

// ---------------------------------------------------------------------------
// J. Delete a project
// ---------------------------------------------------------------------------

async function openDeleteDialog(page: Page) {
  await cardTitled(page, 'Danger Zone').getByRole('button', { name: 'Delete Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Project' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('PROJ-096 delete a project with a recent sign-in', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj096');
  const survivor = await createProject(owner, clientIp, `PROJ-096 Survivor ${hex()}`);
  const doomed = `PROJ-096 Doomed ${hex()}`;
  const project = await createProject(owner, clientIp, doomed);
  const link = await createLink(owner, clientIp, project.id, { title: 'PROJ-096 link' });
  await insertClicks(link.id, 2, '1 hour');
  await createApiKey(owner, project.id, clientIp);
  const { meta } = await listProjects(owner, clientIp);

  await signIn(page, owner);
  await expect(page.getByText(`2 of ${meta.projectLimit} projects`)).toBeVisible();
  await openSettings(page, project.id);
  const dialog = await openDeleteDialog(page);
  await expect(dialog).toContainText(
    `Are you sure you want to delete "${doomed}"? This will permanently delete all links and analytics data. This action cannot be undone.`,
  );
  await holdRequests(page, `**/api/projects/${project.id}`, 'DELETE');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === 'DELETE'),
    dialog.getByRole('button', { name: 'Delete Project' }).click(),
    expect(dialog.getByRole('button', { name: 'Deleting...' })).toBeDisabled(),
  ]);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ data: { message: 'Project deleted successfully' } });
  await expect(toastWith(page, 'Project deleted').first()).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText(`1 of ${meta.projectLimit} projects`)).toBeVisible();
  await expect(page.getByText(doomed, { exact: true })).toHaveCount(0);
  await expect(page.getByText(survivor.name, { exact: true })).toBeVisible();

  // The switcher of the remaining project no longer offers it.
  await page.getByText(survivor.name, { exact: true }).click();
  await page.locator('[data-sidebar="header"] [data-sidebar="menu-button"]').click();
  await expect(page.getByRole('menuitem').filter({ hasText: survivor.name })).toBeVisible();
  await expect(page.getByRole('menuitem').filter({ hasText: doomed })).toHaveCount(0);

  for (const table of ['links', 'api_keys', 'project_members']) {
    const rows = await dbRows(`SELECT 1 FROM ${table} WHERE project_id = $1`, [project.id]);
    expect(rows, table).toEqual([]);
  }
  expect(await dbRows('SELECT 1 FROM click_events WHERE link_id = $1', [link.id])).toEqual([]);
  expect(await projectRow(project.id)).toBeUndefined();
  // The log outlives the project; the delete is its last entry.
  expect((await activityRows(project.id)).at(-1)).toEqual({
    action: 'project.deleted',
    target_label: doomed,
    details: null,
    actor_user_id: owner.userId,
  });
  const gone = await rawApi<Record<string, unknown>>('GET', `/api/projects/${project.id}`, { token: owner.accessToken, ip: clientIp });
  expect(gone.status).toBe(404);
  expect(withoutRequestFields(gone.body)).toEqual(NOT_FOUND);
});

/** Signs in, then makes the sign-in 20 minutes old; the reload's refresh carries the old `auth_time`. */
async function signInLongAgo(page: Page, account: Account): Promise<void> {
  await signIn(page, account);
  await ageSignIn(account.userId);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
}

test('PROJ-097 delete without a recent sign-in asks to confirm it is you', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj097');
  const project = await createProject(owner, clientIp, `PROJ-097 ${hex()}`);
  await signInLongAgo(page, owner);
  await openSettings(page, project.id);

  const deletes: number[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === 'DELETE') deletes.push(r.status());
  });
  const dialog = await openDeleteDialog(page);
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === 'DELETE'),
    dialog.getByRole('button', { name: 'Delete Project' }).click(),
  ]);
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { message: string }).message).toBe(REAUTH_REQUIRED);
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(reauth).toContainText('This is a sensitive action, so we need to check it is still you.');
  expect(await projectRow(project.id)).toBeDefined();

  await confirmWithPassword(page, owner.password);
  await expect(toastWith(page, 'Project deleted').first()).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  expect(deletes).toEqual([403, 200]);
  expect(await projectRow(project.id)).toBeUndefined();
});

test('PROJ-098 cancelling the confirmation keeps the project', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj098');
  const project = await createProject(owner, clientIp, `PROJ-098 ${hex()}`);
  await signInLongAgo(page, owner);
  await openSettings(page, project.id);

  const dialog = await openDeleteDialog(page);
  await dialog.getByRole('button', { name: 'Delete Project' }).click();
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Delete Project' })).toHaveCount(0);
  await expect(toastWith(page, 'Project not deleted')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/settings$`));

  expect(await projectRow(project.id)).toBeDefined();
  const kept = await rawApi('GET', `/api/projects/${project.id}`, { token: owner.accessToken, ip: clientIp });
  expect(kept.status).toBe(200);
  const { data } = await listProjects(owner, clientIp);
  expect(data.map((p) => p.id)).toContain(project.id);
  expect(await activityRows(project.id)).toEqual([]);
});

test('PROJ-099 DELETE refuses a stale sign-in', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj099');
  const project = await createProject(owner, clientIp, `PROJ-099 ${hex()}`);
  const before = await projectRow(project.id);
  const stale = await staleAccessToken(owner, clientIp);
  // The stale token is otherwise good.
  expect((await rawApi('GET', `/api/projects/${project.id}`, { token: stale, ip: clientIp })).status).toBe(200);

  const response = await rawApi<{ message: string }>('DELETE', `/api/projects/${project.id}`, { token: stale, ip: clientIp });
  expect(response.status).toBe(403);
  expect(response.body.message).toBe(REAUTH_REQUIRED);
  expect(await projectRow(project.id)).toEqual(before);
  expect(await activityRows(project.id)).toEqual([]);
});

test('PROJ-103 delete is refused in view-as before any sign-in check', async ({ page, browser, baseURL, clientIp }) => {
  test.slow(); // The staff grant runs the CLI.
  const tenant = await createAccount(clientIp, 'proj103');
  const project = await createProject(tenant, clientIp, `PROJ-103 ${hex()}`);
  const viewAs = await staffForViewAs(browser, baseURL, tenant);
  await openViewAs(page, viewAs, tenant);
  await openSettings(page, project.id);

  const dialog = await openDeleteDialog(page);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === 'DELETE'),
    dialog.getByRole('button', { name: 'Delete Project' }).click(),
  ]);
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(toastWith(page, 'Read-only session').first()).toContainText(READ_ONLY);
  await expect(toastWith(page, 'Project not deleted').first()).toContainText(READ_ONLY);
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);
  expect(await projectRow(project.id)).toBeDefined();
  expect(await activityApartFromViewAs(project.id)).toEqual([]);
});

// ---------------------------------------------------------------------------
// K. View-as at the project level
// ---------------------------------------------------------------------------

async function tenantWithJoinedProject(clientIp: string, label: string) {
  const tenant = await createAccount(clientIp, `${label}-t`);
  const other = await createAccount(clientIp, `${label}-o`);
  const pt1 = await createProject(tenant, clientIp, `${label.toUpperCase()} PT1 ${hex()}`);
  const pt2 = await createProject(tenant, clientIp, `${label.toUpperCase()} PT2 ${hex()}`);
  const po = await createProject(other, clientIp, `${label.toUpperCase()} PO ${hex()}`);
  await addMember(po.id, tenant.userId, 'admin', other.userId);
  return { tenant, other, pt1, pt2, po };
}

test('PROJ-104 the selector in view-as lists only the tenant\'s billed projects', async ({ page, browser, baseURL, clientIp }) => {
  test.slow();
  const { tenant, pt1, pt2, po } = await tenantWithJoinedProject(clientIp, 'proj104');
  // The tenant's own list has all three, so the view-as list below is a real narrowing.
  const own = await listProjects(tenant, clientIp);
  expect(own.data.map((p) => p.id)).toEqual([po.id, pt2.id, pt1.id]);

  const viewAs = await staffForViewAs(browser, baseURL, tenant);
  await openViewAs(page, viewAs, tenant);
  await expect(page.getByRole('region', { name: 'Impersonation session' })).toContainText(
    new RegExp(`Viewing ${tenant.email.replace(/[.+]/g, '\\$&')} as Super Admin · read-only · ends in \\d+ min`),
  );
  for (const project of [pt1, pt2]) {
    const card = page.locator('[data-slot="card"]').filter({ has: page.getByText(project.name, { exact: true }) });
    await expect(card.getByText('Owner', { exact: true })).toBeVisible();
  }
  await expect(page.getByText(po.name, { exact: true })).toHaveCount(0);
  await expect(page.getByText(`2 of ${own.meta.projectLimit} projects`)).toBeVisible();

  const token = await viewAs.token();
  const viewed = await rawApi<{ data: { id: string }[] }>('GET', '/api/projects', { token, ip: clientIp });
  expect(viewed.status).toBe(200);
  expect(viewed.body.data.map((p) => p.id)).toEqual([pt2.id, pt1.id]);
});

test('PROJ-105 view-as cannot open a project the tenant only joined', async ({ page, browser, baseURL, clientIp }) => {
  test.slow();
  const { tenant, pt1, po } = await tenantWithJoinedProject(clientIp, 'proj105');
  // The tenant itself can open it.
  expect((await rawApi('GET', `/api/projects/${po.id}`, { token: tenant.accessToken, ip: clientIp })).status).toBe(200);

  const viewAs = await staffForViewAs(browser, baseURL, tenant);
  await openViewAs(page, viewAs, tenant);
  await page.goto(`/projects/${po.id}`);
  await expect(page).toHaveURL(/\/projects$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByText(po.name)).toHaveCount(0);

  const token = await viewAs.token();
  for (const path of [`/api/projects/${po.id}`, `/api/projects/${po.id}/stats`]) {
    const response = await rawApi<Record<string, unknown>>('GET', path, { token, ip: clientIp });
    expect(response.status, path).toBe(404);
    expect(withoutRequestFields(response.body), path).toEqual(NOT_FOUND);
  }
  // A billed project opens in the same session.
  expect((await rawApi('GET', `/api/projects/${pt1.id}`, { token, ip: clientIp })).status).toBe(200);
});

test('PROJ-106 creating a project in view-as is refused', async ({ page, browser, baseURL, clientIp }) => {
  test.slow();
  const tenant = await createAccount(clientIp, 'proj106');
  await createProject(tenant, clientIp, `PROJ-106 existing ${hex()}`);
  const billingOn = await billingEnabled(tenant, clientIp);
  const { meta } = await listProjects(tenant, clientIp);

  // The tenant's own selector offers plans when billing is on; view-as must not.
  if (billingOn) {
    const { context } = await newPersonContext(browser, baseURL);
    const own = await context.newPage();
    await signIn(own, tenant);
    await expect(own.getByRole('link', { name: 'See plans' })).toBeVisible();
    await context.close();
  }

  const viewAs = await staffForViewAs(browser, baseURL, tenant);
  await openViewAs(page, viewAs, tenant);
  await expect(page.getByText(`1 of ${meta.projectLimit} projects`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'See plans' })).toHaveCount(0);

  const name = `PROJ-106 view-as ${hex()}`;
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await dialog.getByPlaceholder('My App').fill(name);
  await dialog.getByPlaceholder('example.com').fill(uniqueDomain('p106'));
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/projects') && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Create Project' }).click(),
  ]);
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(dialog.getByRole('alert')).toHaveText(READ_ONLY);
  await expect(toastWith(page, 'Read-only session').first()).toContainText(READ_ONLY);
  await expect(toastWith(page, 'Project not created').first()).toContainText(READ_ONLY);
  expect(await ownedProjectCount(tenant.userId)).toBe(1);
  expect(await dbRows('SELECT 1 FROM projects WHERE name = $1', [name])).toEqual([]);
});

test('PROJ-107 a settings save in view-as is refused', async ({ page, browser, baseURL, clientIp }) => {
  test.slow();
  const tenant = await createAccount(clientIp, 'proj107');
  const name = `PROJ-107 ${hex()}`;
  const project = await createProjectWith(tenant, clientIp, { name, domain: uniqueDomain('p107') });
  const viewAs = await staffForViewAs(browser, baseURL, tenant);
  await openViewAs(page, viewAs, tenant);
  await openSettings(page, project.id);

  // View-as reads as the owner, so the form is editable.
  const nameInput = settingsInput(page, 'Project Name');
  await expect(nameInput).toBeEnabled();
  await nameInput.fill(`${name} renamed`);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === 'PATCH'),
    page.getByRole('button', { name: 'Save Changes' }).click(),
  ]);
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(toastWith(page, 'Read-only session').first()).toContainText(READ_ONLY);
  await expect(toastWith(page, 'Failed to update project').first()).toContainText('Error');
  expect((await projectRow(project.id))!.name).toBe(name);
  expect(await activityApartFromViewAs(project.id)).toEqual([]);
});

test('PROJ-109 every write route of this area refuses a view-as token', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const tenant = await createAccount(clientIp, 'proj109');
  const project = await createProjectWith(tenant, clientIp, { name: `PROJ-109 ${hex()}`, domain: uniqueDomain('p109') });
  const before = await projectRow(project.id);
  const viewAs = await staffForViewAs(browser, baseURL, tenant);
  const token = await viewAs.token();
  // The token reads.
  expect((await rawApi('GET', `/api/projects/${project.id}`, { token, ip: clientIp })).status).toBe(200);

  const requests: [string, string, unknown?][] = [
    ['POST', '/api/projects', { name: 'PROJ-109 made in view-as', domain: uniqueDomain('p109n') }],
    ['PATCH', `/api/projects/${project.id}`, { name: 'PROJ-109 renamed in view-as' }],
    ['POST', `/api/projects/${project.id}/domain/verify`],
    ['DELETE', `/api/projects/${project.id}`],
  ];
  for (const [method, path, body] of requests) {
    const response = await rawApi<{ message: string }>(method, path, { token, ip: clientIp, body });
    expect(response.status, `${method} ${path}`).toBe(403);
    expect(response.body.message, `${method} ${path}`).toBe(READ_ONLY);
  }
  expect(await projectRow(project.id)).toEqual(before);
  expect(await ownedProjectCount(tenant.userId)).toBe(1);
  expect(await activityApartFromViewAs(project.id)).toEqual([]);
});

// ---------------------------------------------------------------------------
// L. Suspension
// ---------------------------------------------------------------------------

test('PROJ-110 a suspended account is signed out of its projects', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj110');
  const project = await createProject(owner, clientIp, `PROJ-110 ${hex()}`);
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await suspendAccount(owner.userId);
  await openSidebarGroup(page, 'Main');
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/') && r.status() === 403),
    sidebarLink(page, 'Links').click(),
  ]);
  await expect(page).toHaveURL(/\/login\?suspended=1$/);
  // The page left before its body could be read; the same request with the old token says why.
  const again = await rawApi<{ message: string }>(refused.request().method(), new URL(refused.url()).pathname + new URL(refused.url()).search, {
    token: owner.accessToken,
    ip: clientIp,
  });
  expect(again.status).toBe(403);
  expect(again.body.message).toBe('Account suspended');

  const list = await rawApi<{ message: string }>('GET', '/api/projects', { token: owner.accessToken, ip: clientIp });
  expect(list.status).toBe(403);
  expect(list.body.message).toBe('Account suspended');
});

// ---------------------------------------------------------------------------
// M. Cross-cutting
// ---------------------------------------------------------------------------

test('PROJ-113 the project list never carries another tenant\'s projects', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj113-a');
  const b = await createAccount(clientIp, 'proj113-b');
  const own = [await createProject(a, clientIp, `PROJ-113 A1 ${hex()}`), await createProject(a, clientIp, `PROJ-113 A2 ${hex()}`)];
  const foreign = [await createProject(b, clientIp, `PROJ-113 B1 ${hex()}`), await createProject(b, clientIp, `PROJ-113 B2 ${hex()}`)];

  const response = await rawApi<{ data: { id: string }[]; meta: { total: number } }>('GET', '/api/projects?page=1&limit=100', {
    token: a.accessToken,
    ip: clientIp,
  });
  expect(response.status).toBe(200);
  const text = JSON.stringify(response.body);
  for (const project of foreign) {
    expect(text).not.toContain(project.id);
    expect(text).not.toContain(project.name);
  }
  expect(text).not.toContain(b.userId);
  expect(text).not.toContain(b.email);
  expect(response.body.meta.total).toBe(2);
  expect(response.body.data.map((p) => p.id).sort()).toEqual(own.map((p) => p.id).sort());
});

// ---------------------------------------------------------------------------
// Q. Response shape
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = ['owner', 'pendingBillingOwner', 'passwordHash', 'password', 'email', 'sessionVersion'];

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) allKeys(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      allKeys(inner, out);
    }
  }
  return out;
}

test('PROJ-130 project responses carry no owner object or user fields', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj130-a', `Ava Owner ${hex()}`);
  const b = await createAccount(clientIp, 'proj130-b', `Ben Coowner ${hex()}`);
  const project = await createProjectWith(a, clientIp, { name: `PROJ-130 ${hex()}`, domain: uniqueDomain('p130') });
  await addMember(project.id, b.userId, 'owner', a.userId);
  await setProjectColumns(project.id, { domain_verified_at: new Date() });
  const throwaway = await createProject(a, clientIp, `PROJ-130 throwaway ${hex()}`);

  const asA = { token: a.accessToken, ip: clientIp };
  const asB = { token: b.accessToken, ip: clientIp };
  const calls: [string, string, string, typeof asA, unknown?][] = [
    ['A', 'GET', '/api/projects', asA],
    ['A', 'GET', `/api/projects/${project.id}`, asA],
    ['A', 'POST', '/api/projects', asA, { name: `PROJ-130 created ${hex()}`, domain: uniqueDomain('p130c') }],
    ['A', 'PATCH', `/api/projects/${project.id}`, asA, { name: 'x' }],
    ['A', 'POST', `/api/projects/${project.id}/domain/verify`, asA],
    ['A', 'DELETE', `/api/projects/${throwaway.id}`, asA],
    ['A', 'GET', `/api/projects/${project.id}/stats`, asA],
    ['B', 'GET', '/api/projects', asB],
    ['B', 'GET', `/api/projects/${project.id}`, asB],
    ['B', 'GET', `/api/projects/${project.id}/stats`, asB],
  ];
  for (const [who, method, path, as, body] of calls) {
    const label = `${who}: ${method} ${path}`;
    const response = await rawApi<Record<string, unknown>>(method, path, { ...as, body });
    expect(response.status, label).toBeLessThan(300);
    const keys = allKeys(response.body);
    for (const key of FORBIDDEN_KEYS) expect(keys, `${label} has ${key}`).not.toContain(key);
    expect(keys.filter((key) => /totp/i.test(key)), label).toEqual([]);
    const text = JSON.stringify(response.body);
    for (const value of [a.email, a.name, b.email, b.name]) expect(text, label).not.toContain(value);
    if (method === 'DELETE') expect(response.body, label).toEqual({ data: { message: 'Project deleted successfully' } });
  }
});

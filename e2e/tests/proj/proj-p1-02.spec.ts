import { randomBytes } from 'crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { api, createAccount, createApiKey, createProject } from '../../support/api';
import { expect, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addMember,
  cardTitled,
  countRequests,
  createDialog,
  createLink,
  createLinkWith,
  createProjectWith,
  dbRows,
  fullProjectRow,
  insertClicks,
  IPHONE_UA,
  listProjects,
  openShortLinkAs,
  openViewAs,
  projectCard,
  projectRow,
  projectStats,
  rawApi,
  reactivateAccount,
  setProjectColumns,
  settingsInput,
  staffForViewAs,
  statCard,
  suspendAccount,
  toastWith,
  watchForText,
} from '../../support/areas/proj';

/**
 * Projects (P1): account-wide stats, the settings page (co-owners, saving nothing, the
 * app-link fields, the form's checks and the server's refusals, a concurrent billing
 * move), domain proof (verified display, hosts that are not bare, view-as, the saved
 * domain being the one checked, domains typed as URLs), deleting (as a co-owner, twice),
 * view-as reads, a suspended billing owner, foreign project ids, what a member reads and
 * the app-link formats the API takes, and a failing project load. Every test makes its
 * own accounts and projects.
 */

const READ_ONLY = 'Impersonation sessions are read-only';
const BARE_HOST = 'Set the project domain to a bare host name, such as links.example.com, first.';
const PLATFORM_HOST_MESSAGE =
  'This domain is where this platform serves its own dashboard and short links. Enter your own domain.';

const hex = () => randomBytes(4).toString('hex');
/** A domain no other test uses, since only one project may hold a proof per domain. */
const uniqueDomain = (label: string, tld = 'example.test') => `${label}-${hex()}.${tld}`;

function proofBox(page: Page) {
  return page.locator('p').filter({ hasText: 'To open app links on' });
}

function proofText(domain: string, token: string): string {
  return (
    `To open app links on ${domain}, prove you control it: add a TXT record named _chumbaq-verify.${domain} ` +
    `with the value chumbaq-verify=${token}, then verify.`
  );
}

function noRecordMessage(domain: string, token: string): string {
  return `No TXT record at _chumbaq-verify.${domain} with the value chumbaq-verify=${token}. DNS changes can take a while to appear.`;
}

/** The proof box's text exactly as rendered, spaces included (toHaveText collapses them). */
async function proofBoxText(page: Page): Promise<string | null> {
  await expect(proofBox(page)).toBeVisible();
  return proofBox(page).evaluate((el) => el.textContent);
}

async function openSettings(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/settings`);
  await expect(
    page.getByRole('button', { name: /^Save Changes$|^Saving\.\.\.$/ }).or(page.getByText('Only owners can change these settings.')),
  ).toBeVisible();
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

function isPatchOf(projectId: string) {
  return (r: { url(): string; request(): { method(): string } }) =>
    new URL(r.url()).pathname === `/api/projects/${projectId}` && r.request().method() === 'PATCH';
}

function isVerifyOf(projectId: string) {
  return (r: { url(): string; request(): { method(): string } }) =>
    new URL(r.url()).pathname === `/api/projects/${projectId}/domain/verify` && r.request().method() === 'POST';
}

function isDeleteOf(projectId: string) {
  return (r: { url(): string; request(): { method(): string } }) =>
    new URL(r.url()).pathname === `/api/projects/${projectId}` && r.request().method() === 'DELETE';
}

/** Saves the settings form and answers the PATCH response. */
async function saveSettings(page: Page, projectId: string) {
  const [response] = await Promise.all([
    page.waitForResponse(isPatchOf(projectId)),
    page.getByRole('button', { name: 'Save Changes' }).click(),
  ]);
  return response;
}

/** Clicks "Verify domain" and answers the verify response. */
async function clickVerify(page: Page, projectId: string) {
  const [response] = await Promise.all([
    page.waitForResponse(isVerifyOf(projectId), { timeout: 30_000 }),
    page.getByRole('button', { name: 'Verify domain' }).click(),
  ]);
  return response;
}

/** The project's activity, less the `staff.viewed_as` entry a view-as session writes when it starts. */
async function activityApartFromViewAs(projectId: string) {
  return (await activityRows(projectId)).filter((row) => row.action !== 'staff.viewed_as');
}

/** A project billed to `a` with `b` as a second owner. */
async function coOwnedProject(clientIp: string, label: string) {
  const a = await createAccount(clientIp, `${label}-a`);
  const b = await createAccount(clientIp, `${label}-b`);
  const project = await createProjectWith(a, clientIp, { name: `${label.toUpperCase()} ${hex()}`, domain: uniqueDomain(label) });
  await addMember(project.id, b.userId, 'owner', a.userId);
  return { a, b, project };
}

async function openDeleteDialog(page: Page) {
  await cardTitled(page, 'Danger Zone').getByRole('button', { name: 'Delete Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Project' });
  await expect(dialog).toBeVisible();
  return dialog;
}

// ---------------------------------------------------------------------------
// G. Account-wide stats
// ---------------------------------------------------------------------------

test('PROJ-066 account stats total every project the caller belongs to', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'proj066-a');
  const b = await createAccount(clientIp, 'proj066-b');
  const c = await createAccount(clientIp, 'proj066-c');
  const pa = await createProject(a, clientIp, `PROJ-066 PA ${hex()}`);
  const pb = await createProject(b, clientIp, `PROJ-066 PB ${hex()}`);
  const pc = await createProject(c, clientIp, `PROJ-066 PC ${hex()}`);
  await addMember(pb.id, a.userId, 'member', b.userId);

  const a1 = await createLink(a, clientIp, pa.id, { title: 'PROJ-066 a1' });
  const a2 = await createLink(a, clientIp, pa.id, { title: 'PROJ-066 a2' });
  const b1 = await createLink(b, clientIp, pb.id, { title: 'PROJ-066 b1' });
  const c1 = await createLink(c, clientIp, pc.id, { title: 'PROJ-066 c1' });
  await insertClicks(a1.id, 2, '1 hour');
  await insertClicks(a2.id, 1, '2 hours');
  await insertClicks(b1.id, 4, '3 hours');
  await insertClicks(c1.id, 9, '1 hour');
  const keyA = await createApiKey(a, pa.id, clientIp);
  const keyB = await createApiKey(b, pb.id, clientIp);
  const keyC = await createApiKey(c, pc.id, clientIp);
  await api('POST', '/api/conversions', { linkId: a1.id, eventType: 'signup' }, { apiKey: keyA, ip: clientIp });
  for (const eventType of ['signup', 'purchase']) {
    await api('POST', '/api/conversions', { linkId: b1.id, eventType }, { apiKey: keyB, ip: clientIp });
  }
  await api('POST', '/api/conversions', { linkId: c1.id, eventType: 'signup' }, { apiKey: keyC, ip: clientIp });

  type Stats = {
    totalLinks: number;
    clicks24h: number;
    clicks7d: number;
    clicks30d: number;
    totalConversions: number;
    topLinks: { id: string; title: string | null; shortCode: string; clicks: number }[];
  };
  const response = await rawApi<{ data: Stats }>('GET', '/api/dashboard/stats', { token: a.accessToken, ip: clientIp });
  expect(response.status).toBe(200);
  const stats = response.body.data;
  expect(stats).toMatchObject({ totalLinks: 3, clicks24h: 7, clicks7d: 7, clicks30d: 7, totalConversions: 3 });
  expect(stats.topLinks).toEqual([
    { id: b1.id, title: 'PROJ-066 b1', shortCode: b1.shortCode, clicks: 4 },
    { id: a1.id, title: 'PROJ-066 a1', shortCode: a1.shortCode, clicks: 2 },
    { id: a2.id, title: 'PROJ-066 a2', shortCode: a2.shortCode, clicks: 1 },
  ]);
  expect(JSON.stringify(response.body)).not.toContain(c1.id);

  // C's own view counts PC, so leaving it out above is the membership, not the data.
  const own = await api<Stats>('GET', '/api/dashboard/stats', undefined, { token: c.accessToken, ip: clientIp });
  expect(own).toMatchObject({ totalLinks: 1, clicks24h: 9, totalConversions: 1 });
});

// ---------------------------------------------------------------------------
// H. Project settings
// ---------------------------------------------------------------------------

test('PROJ-074 a co-owner who is not the billing owner can edit settings', async ({ page, clientIp }) => {
  const { a, b, project } = await coOwnedProject(clientIp, 'proj074');
  const renamed = `PROJ-074 renamed ${hex()}`;

  await signIn(page, b);
  await openSettings(page, project.id);
  await expect(page.getByText('Only owners can change these settings.')).toHaveCount(0);
  for (const label of ['Project Name', 'Domain', 'Web Fallback URL', 'Bundle ID', 'Package Name']) {
    await expect(settingsInput(page, label), label).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible();
  await expect(cardTitled(page, 'Danger Zone').getByRole('button', { name: 'Delete Project' })).toBeVisible();
  await expect(cardTitled(page, 'Billing owner')).toHaveCount(0);
  const leave = cardTitled(page, 'Leave project');
  await expect(leave).toContainText('You lose access to this project. Pending invites you sent are cancelled.');
  await expect(leave.getByRole('button', { name: 'Leave project' })).toBeVisible();

  await settingsInput(page, 'Project Name').fill(renamed);
  const response = await saveSettings(page, project.id);
  expect(response.status()).toBe(200);
  await expect(toastWith(page, 'Project updated').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);
  const row = (await projectRow(project.id))!;
  expect(row.name).toBe(renamed);
  expect(row.owner_id).toBe(a.userId);
  expect((await activityRows(project.id)).map((r) => [r.action, r.actor_user_id])).toEqual([['project.renamed', b.userId]]);
});

test('PROJ-076 saving with no changes writes and logs nothing', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj076');
  const name = `PROJ-076 ${hex()}`;
  await signIn(page, owner);
  // Created through the dialog, so only the name and domain are set.
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = createDialog(page);
  await dialog.getByPlaceholder('My App').fill(name);
  await dialog.getByPlaceholder('example.com').fill(uniqueDomain('p076'));
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
  const projectId = page.url().match(/\/projects\/([0-9a-f-]{36})\/settings$/)![1];
  await expect(settingsInput(page, 'Project Name')).toHaveValue(name);
  const before = await fullProjectRow(projectId);
  expect(before).toMatchObject({ ios_bundle_id: null, web_fallback_url: null, android_sha256_fingerprints: null });

  const response = await saveSettings(page, projectId);
  expect(response.status()).toBe(200);
  // The form sends null for every empty optional field, which is what is stored.
  const sent = response.request().postDataJSON() as Record<string, unknown>;
  expect(sent).toMatchObject({ name, iosBundleId: null, webFallbackUrl: null, androidSha256Fingerprints: null });
  await expect(toastWith(page, 'Project updated').first()).toBeVisible();
  expect(await fullProjectRow(projectId)).toEqual(before);
  expect(await activityRows(projectId)).toEqual([]);
});

test('PROJ-077 edit the app-link fields', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj077');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-077 ${hex()}`, domain: uniqueDomain('p077') });
  const values: Record<string, string> = {
    'Web Fallback URL': 'https://example.test/home',
    'Bundle ID': 'com.example.app',
    'Team ID': 'ABCDE12345',
    'App Store URL': 'https://apps.apple.com/app/id123',
    'App Store ID': '123',
    'Package Name': 'com.example.app',
    'Play Store URL': 'https://play.google.com/store/apps/details?id=com.example.app',
    'SHA-256 Fingerprints': 'AA:BB',
  };

  await signIn(page, owner);
  await openSettings(page, project.id);
  for (const [label, value] of Object.entries(values)) await settingsInput(page, label).fill(value);
  expect((await saveSettings(page, project.id)).status()).toBe(200);
  await expect(toastWith(page, 'Project updated').first()).toBeVisible();
  expect(await activityRows(project.id)).toEqual([
    {
      action: 'project.app_links_changed',
      target_label: project.name,
      // Field names only, in the settings' own order: no values are logged.
      details: {
        fields: [
          'iosBundleId',
          'iosAppStoreUrl',
          'iosTeamId',
          'iosAppStoreId',
          'androidPackageName',
          'androidPlayStoreUrl',
          'androidSha256Fingerprints',
          'webFallbackUrl',
        ],
      },
      actor_user_id: owner.userId,
    },
  ]);

  await page.reload();
  for (const [label, value] of Object.entries(values)) await expect(settingsInput(page, label), label).toHaveValue(value);
  await page.goto('/projects');
  const card = projectCard(page, project.name);
  await expect(card.getByText('iOS', { exact: true })).toBeVisible();
  await expect(card.getByText('Android', { exact: true })).toBeVisible();

  await openSettings(page, project.id);
  await settingsInput(page, 'Team ID').fill('');
  expect((await saveSettings(page, project.id)).status()).toBe(200);
  await expect(toastWith(page, 'Project updated').first()).toBeVisible();
  const [row] = await dbRows<{ ios_team_id: string | null; ios_bundle_id: string | null }>(
    'SELECT ios_team_id, ios_bundle_id FROM projects WHERE id = $1',
    [project.id],
  );
  expect(row).toEqual({ ios_team_id: null, ios_bundle_id: 'com.example.app' });
  const activity = await activityRows(project.id);
  expect(activity).toHaveLength(2);
  expect(activity[1]).toMatchObject({ action: 'project.app_links_changed', details: { fields: ['iosTeamId'] } });
});

test('PROJ-078 settings form validation', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj078');
  const name = `PROJ-078 ${hex()}`;
  const domain = uniqueDomain('p078');
  const project = await createProjectWith(owner, clientIp, { name, domain });
  await signIn(page, owner);
  await openSettings(page, project.id);
  const patches = countRequests(page, 'PATCH', `/api/projects/${project.id}`);
  const save = page.getByRole('button', { name: 'Save Changes' });
  const errors = page.locator('form p.text-destructive');
  /** A field's own error line, inside its `div.space-y-2`. */
  const fieldError = (label: string) =>
    page
      .locator('div.space-y-2')
      .filter({ has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) })
      .locator('p.text-destructive');

  // 1. No name.
  await settingsInput(page, 'Project Name').fill('');
  await save.click();
  await expect(fieldError('Project Name')).toHaveText('Name is required');
  await settingsInput(page, 'Project Name').fill(name);

  // 2. No domain.
  await settingsInput(page, 'Domain').fill('');
  await save.click();
  await expect(fieldError('Domain')).toHaveText('Domain is required');
  await settingsInput(page, 'Domain').fill(domain);

  // 3. A fallback that is not a URL.
  await settingsInput(page, 'Web Fallback URL').fill('not a url');
  await save.click();
  await expect(fieldError('Web Fallback URL')).toHaveText('Invalid url');
  await settingsInput(page, 'Web Fallback URL').fill('');

  // 4 and 5. The store URLs are checked, but their errors are never rendered: the form
  // focuses the field it refused, and shows nothing (current behaviour).
  for (const label of ['App Store URL', 'Play Store URL']) {
    await settingsInput(page, label).fill('not a url');
    await save.click();
    await expect(settingsInput(page, label), label).toBeFocused();
    await expect(errors, label).toHaveCount(0);
    await expect(page.getByText('Invalid url'), label).toHaveCount(0);
    await expect(page.getByRole('status'), label).toHaveCount(0);
    await settingsInput(page, label).fill('');
  }
  expect(patches.count()).toBe(0);

  // The same form with valid values does send, so the count above is the checks'.
  expect((await saveSettings(page, project.id)).status()).toBe(200);
  expect(patches.count()).toBe(1);
  expect((await projectRow(project.id))!.name).toBe(name);
});

test('PROJ-079 server refusals on save show a generic toast', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj079');
  const name = `PROJ-079 ${hex()}`;
  const domain = uniqueDomain('p079');
  const project = await createProjectWith(owner, clientIp, { name, domain });
  const before = await fullProjectRow(project.id);
  await signIn(page, owner);
  await openSettings(page, project.id);

  const cases: [string, string, string, string][] = [
    ['Domain', 'localhost', domain, PLATFORM_HOST_MESSAGE],
    ['Web Fallback URL', 'javascript:alert(1)', '', 'webFallbackUrl must be a URL address'],
    ['Project Name', 'n'.repeat(256), name, 'name must be shorter than or equal to 255 characters'],
  ];
  for (const [label, value, restore, message] of cases) {
    // The previous case's toast is gone, so the one asserted below is this case's.
    await expect(toastWith(page, 'Failed to update project'), label).toHaveCount(0);
    await settingsInput(page, label).fill(value);
    const response = await saveSettings(page, project.id);
    expect(response.status(), label).toBe(400);
    expect(((await response.json()) as { message: string[] }).message, label).toEqual([message]);
    const toast = toastWith(page, 'Failed to update project').first();
    await expect(toast, label).toContainText('Error');
    // The server's words are not shown.
    await expect(page.getByText(message), label).toHaveCount(0);
    await settingsInput(page, label).fill(restore);
  }
  expect(await fullProjectRow(project.id)).toEqual(before);
  expect(await activityRows(project.id)).toEqual([]);
});

test('PROJ-081 a settings update never undoes a concurrent billing change', async ({ clientIp }) => {
  const { a, b, project } = await coOwnedProject(clientIp, 'proj081');
  await api('POST', `/api/projects/${project.id}/billing-transfer`, { toUserId: b.userId }, { token: a.accessToken, ip: clientIp });
  const offered = (await fullProjectRow(project.id))!;
  expect(offered.pending_billing_owner_id).toBe(b.userId);
  expect(offered.pending_billing_offered_at).not.toBeNull();

  await api('POST', `/api/projects/${project.id}/billing-transfer/accept`, undefined, { token: b.accessToken, ip: clientIp });
  const moved = (await fullProjectRow(project.id))!;
  expect(moved).toMatchObject({ owner_id: b.userId, pending_billing_owner_id: null, pending_billing_offered_at: null });

  // A is still an owner, and renames.
  const renamed = `PROJ-081 New ${hex()}`;
  const response = await rawApi<{ data: { ownerId: string; name: string } }>('PATCH', `/api/projects/${project.id}`, {
    token: a.accessToken,
    ip: clientIp,
    body: { name: renamed },
  });
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ name: renamed, ownerId: b.userId });
  const after = (await fullProjectRow(project.id))!;
  const { name: _n1, updated_at: _u1, ...restBefore } = moved;
  const { name, updated_at: _u2, ...restAfter } = after;
  expect(name).toBe(renamed);
  expect(restAfter).toEqual(restBefore);
});

// ---------------------------------------------------------------------------
// I. Domain proof
// ---------------------------------------------------------------------------

test('PROJ-087 a verified domain is shown as verified, and verifying again changes nothing', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj087');
  const domain = uniqueDomain('p087');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-087 ${hex()}`, domain });
  const verifiedAt = new Date('2026-11-01T10:00:00Z');
  await setProjectColumns(project.id, { domain_verified_at: verifiedAt });

  await signIn(page, owner);
  await openSettings(page, project.id);
  await expect(page.getByText(`${domain} is verified for app links.`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify domain' })).toHaveCount(0);
  await expect(proofBox(page)).toHaveCount(0);

  const response = await rawApi<{ data: { id: string; domain: string; domainVerifiedAt: string } }>(
    'POST',
    `/api/projects/${project.id}/domain/verify`,
    { token: owner.accessToken, ip: clientIp },
  );
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ id: project.id, domain, domainVerifiedAt: verifiedAt.toISOString() });
  expect((await projectRow(project.id))!.domain_verified_at).toEqual(verifiedAt);
  expect(await activityRows(project.id)).toEqual([]);
});

test('PROJ-089 domains that are not a bare host cannot be verified', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj089');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-089 ${hex()}`, domain: uniqueDomain('p089') });
  const verify = () =>
    rawApi<{ message: string }>('POST', `/api/projects/${project.id}/domain/verify`, { token: owner.accessToken, ip: clientIp });
  const setDomain = async (domain: string) => {
    const patched = await rawApi('PATCH', `/api/projects/${project.id}`, { token: owner.accessToken, ip: clientIp, body: { domain } });
    expect(patched.status, domain).toBe(200);
    expect((await projectRow(project.id))!.domain, domain).toBe(domain);
  };

  for (const domain of [
    'Links.Example.test',
    'https://links.example.test',
    'links.example.test:443',
    'links.example.test.',
    ' links.example.test',
    'links.example.test/path',
  ]) {
    await setDomain(domain);
    const response = await verify();
    expect(response.status, domain).toBe(400);
    expect(response.body.message, domain).toBe(BARE_HOST);
    expect((await projectRow(project.id))!.domain_verified_at, domain).toBeNull();
  }

  // A bare host goes on to DNS, so the refusal above is the shape check.
  const bare = uniqueDomain('p089', 'example.invalid');
  await setDomain(bare);
  const token = (await projectRow(project.id))!.domain_verification_token!;
  const looked = await verify();
  expect(looked.status).toBe(400);
  expect(looked.body.message).toBe(noRecordMessage(bare, token));
  expect((await activityRows(project.id)).every((row) => row.action === 'project.app_links_changed')).toBe(true);
});

test('PROJ-095 verify domain in view-as is refused as read-only', async ({ page, browser, baseURL, clientIp }) => {
  test.slow(); // The staff grant runs the CLI.
  const tenant = await createAccount(clientIp, 'proj095');
  const domain = uniqueDomain('p095', 'example.invalid');
  const project = await createProjectWith(tenant, clientIp, { name: `PROJ-095 ${hex()}`, domain });
  const before = await fullProjectRow(project.id);
  const viewAs = await staffForViewAs(browser, baseURL, tenant);
  await openViewAs(page, viewAs, tenant);
  await openSettings(page, project.id);

  // View-as reads as the owner, so the button is offered.
  await expect(page.getByRole('button', { name: 'Verify domain' })).toBeEnabled();
  const response = await clickVerify(page, project.id);
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(toastWith(page, 'Read-only session').first()).toContainText(READ_ONLY);
  await expect(toastWith(page, 'Not verified yet').first()).toContainText(READ_ONLY);
  expect(await fullProjectRow(project.id)).toEqual(before);
  expect(await activityApartFromViewAs(project.id)).toEqual([]);
});

// ---------------------------------------------------------------------------
// J. Delete a project
// ---------------------------------------------------------------------------

test('PROJ-101 a co-owner can delete a project billed to someone else', async ({ page, clientIp }) => {
  const { a, b, project } = await coOwnedProject(clientIp, 'proj101');
  const keep = await createProject(a, clientIp, `PROJ-101 keep ${hex()}`);
  const billedBefore = (await listProjects(a, clientIp)).meta.billedProjects;
  expect(billedBefore).toBe(2);

  await signIn(page, b);
  await openSettings(page, project.id);
  const dialog = await openDeleteDialog(page);
  const [response] = await Promise.all([
    page.waitForResponse(isDeleteOf(project.id)),
    dialog.getByRole('button', { name: 'Delete Project' }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(toastWith(page, 'Project deleted').first()).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);

  expect(await projectRow(project.id)).toBeUndefined();
  const after = await listProjects(a, clientIp);
  expect(after.meta.billedProjects).toBe(billedBefore - 1);
  expect(after.data.map((p) => p.id)).toEqual([keep.id]);
  expect((await activityRows(project.id)).at(-1)).toMatchObject({ action: 'project.deleted', actor_user_id: b.userId });
});

/** Signs in, opens the project's settings in two tabs of one browser, and deletes it from the first. */
async function deletedWhileOpenInTwoTabs(page: Page, context: BrowserContext, clientIp: string) {
  const owner = await createAccount(clientIp, 'proj102');
  const project = await createProject(owner, clientIp, `PROJ-102 ${hex()}`);
  await signIn(page, owner);
  await openSettings(page, project.id);
  const tab2 = await context.newPage();
  await openSettings(tab2, project.id);

  const first = await openDeleteDialog(page);
  const [deleted] = await Promise.all([
    page.waitForResponse(isDeleteOf(project.id)),
    first.getByRole('button', { name: 'Delete Project' }).click(),
  ]);
  expect(deleted.status()).toBe(200);
  await expect(toastWith(page, 'Project deleted').first()).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText(project.name, { exact: true })).toHaveCount(0);
  return { owner, project, tab2 };
}

test('PROJ-102 deleting a project a second time from a stale tab is refused as not found', async ({ page, context, clientIp }) => {
  const { project, tab2 } = await deletedWhileOpenInTwoTabs(page, context, clientIp);

  // Tab 2 still shows the project and tries again.
  await tab2.bringToFront();
  await expect(tab2.getByRole('heading', { level: 1 })).toHaveText(project.name);
  const second = await openDeleteDialog(tab2);
  const [again] = await Promise.all([
    tab2.waitForResponse(isDeleteOf(project.id)),
    second.getByRole('button', { name: 'Delete Project' }).click(),
  ]);
  expect(again.status()).toBe(404);
  expect(((await again.json()) as { message: string }).message).toBe('Project not found');
  await expect(toastWith(tab2, 'Project not deleted').first()).toContainText('Project not found');
  expect(await projectRow(project.id)).toBeUndefined();
});

test('PROJ-102 going back to a deleted project\'s settings returns to the selector', async ({ page, context, clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'PROJ-102' });
  test.fail();
  const { project } = await deletedWhileOpenInTwoTabs(page, context, clientIp);
  await page.goBack();
  await expect(page).toHaveURL(/\/projects$/, { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByText(project.name, { exact: true })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// K. View-as
// ---------------------------------------------------------------------------

test('PROJ-108 view-as can read the dashboard and settings', async ({ page, browser, baseURL, clientIp }) => {
  test.slow();
  const tenant = await createAccount(clientIp, 'proj108');
  const domain = uniqueDomain('p108');
  const fields = {
    name: `PROJ-108 ${hex()}`,
    domain,
    webFallbackUrl: 'https://example.test/home',
    iosBundleId: 'com.example.proj108',
    iosTeamId: 'ABCDE12345',
    iosAppStoreUrl: 'https://apps.apple.com/app/id108',
    iosAppStoreId: '108',
    androidPackageName: 'com.example.proj108',
    androidPlayStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.proj108',
    androidSha256Fingerprints: 'AA:BB:CC',
  };
  const project = await createProjectWith(tenant, clientIp, fields);
  const token = (await projectRow(project.id))!.domain_verification_token!;
  const l1 = await createLink(tenant, clientIp, project.id, { title: 'PROJ-108 one' });
  const l2 = await createLink(tenant, clientIp, project.id, { title: 'PROJ-108 two' });
  await insertClicks(l1.id, 3, '1 hour');
  await insertClicks(l2.id, 2, '3 days');
  const key = await createApiKey(tenant, project.id, clientIp);
  await api('POST', '/api/conversions', { linkId: l1.id, eventType: 'signup' }, { apiKey: key, ip: clientIp });
  const own = (await projectStats(tenant, clientIp, project.id)).body.data;
  expect(own).toMatchObject({ totalLinks: 2, clicks24h: 3, clicks7d: 5, totalConversions: 1 });

  const viewAs = await staffForViewAs(browser, baseURL, tenant);
  await openViewAs(page, viewAs, tenant);
  await openProject(page, project.id);
  await expect(statCard(page, 'This project')).toHaveText(new RegExp(`Total Links\\s*${own.totalLinks}\\s*This project`));
  await expect(statCard(page, 'Last 24 hours')).toHaveText(new RegExp(`Clicks \\(24h\\)\\s*${own.clicks24h}\\s*Last 24 hours`));
  await expect(statCard(page, 'Last 7 days')).toHaveText(new RegExp(`Clicks \\(7d\\)\\s*${own.clicks7d}\\s*Last 7 days`));
  await expect(statCard(page, 'Total conversions')).toHaveText(new RegExp(`Conversions\\s*${own.totalConversions}\\s*Total conversions`));

  await openSidebarGroup(page, 'Configure');
  await expect(sidebarLink(page, 'Activity')).toHaveAttribute('href', `/projects/${project.id}/activity`);

  await openSettings(page, project.id);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fields.name);
  for (const [label, value] of [
    ['Project Name', fields.name],
    ['Domain', domain],
    ['Web Fallback URL', fields.webFallbackUrl],
    ['Bundle ID', fields.iosBundleId],
    ['Team ID', fields.iosTeamId],
    ['App Store URL', fields.iosAppStoreUrl],
    ['App Store ID', fields.iosAppStoreId],
    ['Package Name', fields.androidPackageName],
    ['Play Store URL', fields.androidPlayStoreUrl],
    ['SHA-256 Fingerprints', fields.androidSha256Fingerprints],
  ]) {
    await expect(settingsInput(page, label), label).toHaveValue(value);
  }
  await expect(proofBox(page)).toHaveText(proofText(domain, token));
});

// ---------------------------------------------------------------------------
// L. Suspension
// ---------------------------------------------------------------------------

test('PROJ-111 members of a suspended account\'s project keep dashboard access', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'proj111-a');
  const b = await createAccount(clientIp, 'proj111-b');
  const project = await createProject(a, clientIp, `PROJ-111 ${hex()}`);
  await addMember(project.id, b.userId, 'member', a.userId);
  await suspendAccount(a.userId);
  // The billing owner is refused, so the suspension is in force.
  expect((await rawApi('GET', '/api/projects', { token: a.accessToken, ip: clientIp })).status).toBe(403);

  await signIn(page, b);
  const card = projectCard(page, project.name);
  await expect(card.getByText('Member', { exact: true })).toBeVisible();
  await expect(page.getByText(/suspend/i)).toHaveCount(0);

  await card.getByText(project.name, { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(statCard(page, 'This project')).toBeVisible();
  await expect(page.getByText(/suspend/i)).toHaveCount(0);

  await openSettings(page, project.id);
  await expect(page.getByText('Only owners can change these settings.')).toBeVisible();
  await expect(settingsInput(page, 'Project Name')).toHaveValue(project.name);
  await expect(page.getByText(/suspend/i)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// M. Cross-cutting
// ---------------------------------------------------------------------------

test('PROJ-115 another tenant\'s project id in the URL does not leak its name', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'proj115-a');
  const b = await createAccount(clientIp, 'proj115-b');
  const secret = `Secret Launch ${hex()}`;
  const pb = await createProject(b, clientIp, secret);
  const own = await createProject(a, clientIp, `PROJ-115 own ${hex()}`);

  await signIn(page, a);
  const seen = await watchForText(page, secret);
  const statuses: { url: string; status: number; body: string }[] = [];
  page.on('response', async (response) => {
    if (!response.url().includes(pb.id)) return;
    statuses.push({ url: response.url(), status: response.status(), body: await response.text().catch(() => '') });
  });
  await page.goto(`/projects/${pb.id}/settings`);
  await expect(page).toHaveURL(/\/projects$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByText(own.name, { exact: true })).toBeVisible();

  // The document itself is the app's page (200 for any path); every API answer about PB is a refusal.
  const apiCalls = statuses.filter((s) => new URL(s.url).pathname.startsWith('/api/'));
  expect(apiCalls.length).toBeGreaterThan(0);
  for (const call of statuses) expect(call.body, call.url).not.toContain(secret);
  for (const call of apiCalls) {
    expect(call.status, call.url).toBe(404);
  }
  expect(await seen()).toBe(false);
  expect(await page.title()).not.toContain(secret);

  // The same watcher sees the name where the person may see it, so `false` above is real.
  const bSeen = await watchForText(page, secret);
  await page.goto('/login');
  await page.evaluate((text) => {
    const marker = document.createElement('span');
    marker.textContent = text;
    document.body.appendChild(marker);
  }, secret);
  expect(await bSeen()).toBe(true);
});

// ---------------------------------------------------------------------------
// N. Domains stored as typed
// ---------------------------------------------------------------------------

test('PROJ-119 domains saved from the UI as a URL, with a port or with a leading space', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj119');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-119 ${hex()}`, domain: 'e2e.example.test' });
  await signIn(page, owner);
  await openSettings(page, project.id);

  let previousToken = (await projectRow(project.id))!.domain_verification_token!;
  let rows = 0;
  for (const domain of ['https://links.example.test/app', 'links.example.test:8443', ' links.example.test']) {
    // The previous round's toasts are gone, so the ones asserted below are this round's.
    await expect(page.getByRole('status'), domain).toHaveCount(0);
    await settingsInput(page, 'Domain').fill(domain);
    const saved = await saveSettings(page, project.id);
    expect(saved.status(), domain).toBe(200);
    await expect(toastWith(page, 'Project updated').first()).toBeVisible();
    const row = (await projectRow(project.id))!;
    // Stored as typed, untrimmed, with a new token.
    expect(row.domain, domain).toBe(domain);
    expect(row.domain_verification_token, domain).toMatch(/^[0-9a-f]{32}$/);
    expect(row.domain_verification_token, domain).not.toBe(previousToken);
    previousToken = row.domain_verification_token!;
    rows += 1;
    const activity = await activityRows(project.id);
    expect(activity, domain).toHaveLength(rows);
    expect(activity.at(-1), domain).toMatchObject({ action: 'project.app_links_changed', details: { fields: ['domain'] } });
    await expect.poll(() => proofBoxText(page), { message: domain }).toBe(proofText(domain, previousToken));

    const verified = await clickVerify(page, project.id);
    expect(verified.status(), domain).toBe(400);
    expect(((await verified.json()) as { message: string }).message, domain).toBe(BARE_HOST);
    await expect(toastWith(page, 'Not verified yet').first()).toContainText(BARE_HOST);
    expect((await projectRow(project.id))!.domain_verified_at, domain).toBeNull();
  }

  // 4. The create dialog takes the same.
  const created = `PROJ-119 created ${hex()}`;
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = createDialog(page);
  await dialog.getByPlaceholder('My App').fill(created);
  await dialog.getByPlaceholder('example.com').fill('https://links.example.test/app');
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Create Project' }).click(),
  ]);
  expect(response.status()).toBe(201);
  const newId = ((await response.json()) as { data: { id: string } }).data.id;
  await expect(page).toHaveURL(new RegExp(`/projects/${newId}/settings$`));
  const newToken = (await projectRow(newId))!.domain_verification_token!;
  await expect.poll(() => proofBoxText(page)).toBe(proofText('https://links.example.test/app', newToken));
});

// ---------------------------------------------------------------------------
// O. Domain proof box
// ---------------------------------------------------------------------------

test('PROJ-124 "Verify domain" checks the saved domain, not the one being typed', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj124');
  const saved = uniqueDomain('old', 'example.invalid');
  const typed = uniqueDomain('new', 'example.invalid');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-124 ${hex()}`, domain: saved });
  const token = (await projectRow(project.id))!.domain_verification_token!;
  await signIn(page, owner);
  await openSettings(page, project.id);

  await settingsInput(page, 'Domain').fill(typed);
  await expect(proofBox(page)).toHaveText(proofText(saved, token));
  const response = await clickVerify(page, project.id);
  expect(response.request().postData() ?? '').toBe('');
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { message: string }).message).toBe(noRecordMessage(saved, token));
  await expect(toastWith(page, 'Not verified yet').first()).toContainText(noRecordMessage(saved, token));
  await expect(settingsInput(page, 'Domain')).toHaveValue(typed);
  await expect(proofBox(page)).toHaveText(proofText(saved, token));
  expect((await projectRow(project.id))!.domain).toBe(saved);
});

// ---------------------------------------------------------------------------
// P. App-link field formats
// ---------------------------------------------------------------------------

const STORE_FIELDS = ['webFallbackUrl', 'iosAppStoreUrl', 'androidPlayStoreUrl'] as const;

test('PROJ-127 the API stores store and fallback URLs the settings form would refuse', async ({ clientIp }) => {
  const owner = await createAccount(clientIp, 'proj127');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-127 ${hex()}`, domain: uniqueDomain('p127') });
  const link = await createLinkWith(owner, clientIp, project.id, { iosUrl: 'https://example.test/app/open' });
  const patch = (body: Record<string, unknown>) =>
    rawApi<{ data?: Record<string, unknown>; message?: string[] }>('PATCH', `/api/projects/${project.id}`, {
      token: owner.accessToken,
      ip: clientIp,
      body,
    });

  // Current behaviour: class-validator's defaults need no scheme, and take ftp.
  const accepted: [(typeof STORE_FIELDS)[number], string, string][] = [
    ['webFallbackUrl', 'example.test/home', 'web_fallback_url'],
    ['iosAppStoreUrl', 'apps.example.test', 'ios_app_store_url'],
    ['androidPlayStoreUrl', 'ftp://files.example.test/a', 'android_play_store_url'],
  ];
  for (const [field, value, column] of accepted) {
    const response = await patch({ [field]: value });
    expect(response.status, field).toBe(200);
    expect(response.body.data?.[field], field).toBe(value);
    const [row] = await dbRows<Record<string, string>>(`SELECT ${column} AS v FROM projects WHERE id = $1`, [project.id]);
    expect(row.v, field).toBe(value);
    expect((await activityRows(project.id)).at(-1), field).toMatchObject({
      action: 'project.app_links_changed',
      details: { fields: [field] },
    });
  }
  expect(await activityRows(project.id)).toHaveLength(3);

  // The phone's fallback is the stored value, a relative URL.
  const opened = await openShortLinkAs(link.shortCode, IPHONE_UA, clientIp);
  expect(opened.status).toBe(200);
  expect(opened.contentType).toContain('text/html');
  expect(opened.body).toContain('var fallback = "apps.example.test";');
  expect(opened.body).toContain('<a id="fallback-link" href="apps.example.test">');

  // A value with no top-level domain is still refused.
  for (const field of STORE_FIELDS) {
    for (const value of ['localhost:3000/x', 'http://intranet/x']) {
      const response = await patch({ [field]: value });
      expect(response.status, `${field}=${value}`).toBe(400);
      expect(response.body.message, `${field}=${value}`).toEqual([`${field} must be a URL address`]);
    }
  }
  expect(await activityRows(project.id)).toHaveLength(3);

  const removed = await rawApi('DELETE', `/api/links/${link.id}`, { token: owner.accessToken, ip: clientIp });
  expect(removed.status).toBe(200);
});

test('PROJ-127 the API refuses store and fallback URLs without an http or https scheme', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'PROJ-127' });
  test.fail();
  const owner = await createAccount(clientIp, 'proj127f');
  const project = await createProjectWith(owner, clientIp, { name: `PROJ-127 ${hex()}`, domain: uniqueDomain('p127f') });
  const before = await fullProjectRow(project.id);
  for (const [field, value] of [
    ['webFallbackUrl', 'example.test/home'],
    ['iosAppStoreUrl', 'apps.example.test'],
    ['androidPlayStoreUrl', 'ftp://files.example.test/a'],
  ]) {
    const response = await rawApi('PATCH', `/api/projects/${project.id}`, {
      token: owner.accessToken,
      ip: clientIp,
      body: { [field]: value },
    });
    expect(response.status, `${field}=${value}`).toBe(400);
  }
  expect(await fullProjectRow(project.id)).toEqual(before);
});

// ---------------------------------------------------------------------------
// Q. What a member reads
// ---------------------------------------------------------------------------

test('PROJ-132 what a member reads in a project response', async ({ clientIp }) => {
  const { a, b, project } = await coOwnedProject(clientIp, 'proj132');
  const d = await createAccount(clientIp, 'proj132-d');
  await addMember(project.id, d.userId, 'member', a.userId);
  await api('POST', `/api/projects/${project.id}/billing-transfer`, { toUserId: b.userId }, { token: a.accessToken, ip: clientIp });
  const row = (await fullProjectRow(project.id))!;
  expect(row.pending_billing_owner_id).toBe(b.userId);

  type Read = {
    ownerId: string;
    pendingBillingOwnerId: string | null;
    pendingBillingOfferedAt: string | null;
    identityKeyVersion: number;
    domainVerificationToken: string | null;
    role: string;
  };
  const expected = {
    ownerId: a.userId,
    pendingBillingOwnerId: b.userId,
    pendingBillingOfferedAt: (row.pending_billing_offered_at as Date).toISOString(),
    identityKeyVersion: 1,
    domainVerificationToken: row.domain_verification_token,
  };

  const one = await rawApi<{ data: Read }>('GET', `/api/projects/${project.id}`, { token: d.accessToken, ip: clientIp });
  expect(one.status).toBe(200);
  expect(one.body.data).toMatchObject({ ...expected, role: 'member' });

  const list = await listProjects(d, clientIp);
  const listed = list.data.find((p) => p.id === project.id);
  expect(listed).toMatchObject({ ...expected, role: 'member' });

  // The owner reads the same fields.
  const ownerRead = await rawApi<{ data: Read }>('GET', `/api/projects/${project.id}`, { token: a.accessToken, ip: clientIp });
  expect(ownerRead.body.data).toMatchObject({ ...expected, role: 'owner' });
});

// ---------------------------------------------------------------------------
// R. Edge states
// ---------------------------------------------------------------------------

test('PROJ-135 a failing project load sends the person to the selector without a message', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'proj135');
  const project = await createProject(owner, clientIp, `PROJ-135 ${hex()}`);
  const path = `/api/projects/${project.id}`;
  await signIn(page, owner);
  const gets = countRequests(page, 'GET', path);

  // 1 and 2. A 500, then a network failure.
  for (const failure of ['500', 'abort'] as const) {
    const before = gets.count();
    await page.route(`**${path}`, (route) =>
      route.request().method() !== 'GET'
        ? route.continue()
        : failure === '500'
          ? route.fulfill({ status: 500, json: { statusCode: 500, message: 'Internal server error' } })
          : route.abort(),
    );
    await page.goto(`/projects/${project.id}/links`);
    await expect(page).toHaveURL(/\/projects$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    // The first try and the one retry.
    expect(gets.count() - before, failure).toBe(2);
    await expect(page.getByRole('status'), failure).toHaveCount(0);
    await expect(page.getByText(/error|failed|try again/i), failure).toHaveCount(0);
    await expect(projectCard(page, project.name), failure).toBeVisible();
    await page.unroute(`**${path}`);
  }

  // The project opens once the failures stop.
  await openProject(page, project.id);

  // 3. A save whose follow-up read fails.
  await openSettings(page, project.id);
  let failNext = true;
  await page.route(`**${path}`, (route) => {
    if (route.request().method() === 'GET' && failNext) {
      return route.fulfill({ status: 500, json: { statusCode: 500, message: 'Internal server error' } });
    }
    return route.continue();
  });
  await settingsInput(page, 'Project Name').fill(`${project.name} renamed`);
  const saved = await saveSettings(page, project.id);
  expect(saved.status()).toBe(200);
  await expect(toastWith(page, 'Project updated').first()).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/, { timeout: 15_000 });
  failNext = false;
  expect((await projectRow(project.id))!.name).toBe(`${project.name} renamed`);
});

test('PROJ-141 a co-owner keeps write access while the billing owner is suspended', async ({ page, clientIp }) => {
  const { a, b, project } = await coOwnedProject(clientIp, 'proj141');
  const billedBefore = (await listProjects(a, clientIp)).meta.billedProjects;
  await suspendAccount(a.userId);
  expect((await rawApi('GET', '/api/projects', { token: a.accessToken, ip: clientIp })).status).toBe(403);

  await signIn(page, b);
  // 1. The pages load, with no word of the suspension.
  await openProject(page, project.id);
  await expect(page.getByText(/suspend/i)).toHaveCount(0);
  await openSettings(page, project.id);
  await expect(page.getByText(/suspend/i)).toHaveCount(0);

  // 2. Rename.
  const renamed = `PROJ-141 renamed ${hex()}`;
  await settingsInput(page, 'Project Name').fill(renamed);
  expect((await saveSettings(page, project.id)).status()).toBe(200);
  await expect(toastWith(page, 'Project updated').first()).toBeVisible();
  expect((await activityRows(project.id)).at(-1)).toMatchObject({ action: 'project.renamed', actor_user_id: b.userId });

  // 3. A new domain, then verify: DNS is asked, no suspension refusal.
  const domain = uniqueDomain('b', 'example.invalid');
  await settingsInput(page, 'Domain').fill(domain);
  expect((await saveSettings(page, project.id)).status()).toBe(200);
  const token = (await projectRow(project.id))!.domain_verification_token!;
  await expect(proofBox(page)).toHaveText(proofText(domain, token));
  const verified = await clickVerify(page, project.id);
  expect(verified.status()).toBe(400);
  expect(((await verified.json()) as { message: string }).message).toBe(noRecordMessage(domain, token));

  // 4. Delete.
  const dialog = await openDeleteDialog(page);
  const [deleted] = await Promise.all([
    page.waitForResponse(isDeleteOf(project.id)),
    dialog.getByRole('button', { name: 'Delete Project' }).click(),
  ]);
  expect(deleted.status()).toBe(200);
  await expect(toastWith(page, 'Project deleted').first()).toBeVisible();
  expect(await projectRow(project.id)).toBeUndefined();
  expect((await activityRows(project.id)).at(-1)).toMatchObject({ action: 'project.deleted', actor_user_id: b.userId });

  await reactivateAccount(a.userId);
  expect((await listProjects(a, clientIp)).meta.billedProjects).toBe(billedBefore - 1);
});


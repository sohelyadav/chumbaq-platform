import { randomBytes, randomUUID } from 'crypto';
import type { Page, Request } from '@playwright/test';
import { adminUrl, enrolAndSignInStaff } from '../../support/admin';
import { api, createAccount, createProject, newClientIp } from '../../support/api';
import { enrolTotp } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  adminRequest,
  auditRows,
  codeFromViewAsUrl,
  customerRequest,
  customerToast,
  exchangeViewAs,
  factorResetRows,
  handoffRows,
  jwtClaims,
  linkActionsButton,
  makeStaffSignInStale,
  makeSuperAdmin,
  openTenantPage,
  openViewAsTab,
  recordRefusals,
  refreshStaffToken,
  revokeSuperAdminCli,
  seedPendingFactorReset,
  signedInStaff,
  sql,
  staffPasskeySignIn,
  startViewAs,
  storedViewAs,
  userRow,
  viewAsBanner,
  type Staff,
} from '../../support/areas/admten';

/**
 * View-as from the exchange onwards: the /impersonate page, the exchange and its
 * recheck, the read-only session in the customer app and what ends it, and the staff
 * side of a second factor reset.
 */

const LINK_INVALID = 'This view-as link has expired or was already used.';
const NO_LONGER_VALID = 'Impersonation session is no longer valid';
const READ_ONLY = 'Impersonation sessions are read-only';
const REAUTH = 'Confirm it is you to continue.';
const STAFF_ENDED = 'Your staff session has ended. Sign in again.';
const EXCHANGE = '/api/auth/impersonation/exchange';
const CUSTOMER_REFRESH_COOKIE = /^(__Host-)?chumbaq_refresh$/;

const hex = () => randomBytes(2).toString('hex');
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function exchange(code: string, ip: string) {
  return customerRequest('POST', EXCHANGE, { ip, body: { code } });
}

/** Every row the exchange writes to the staff log for this tenant. */
async function exchangeAudit(tenantId: string) {
  const rows = await auditRows({ targetId: tenantId });
  return rows.filter((row) => row.action === 'tenant.impersonation_exchanged' || row.action === 'tenant.impersonation_refused');
}

function adminToast(page: Page, title: string) {
  return page.getByText(title, { exact: true }).first();
}

function secondFactorsCard(page: Page) {
  return page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Second factors' }) });
}

/** A navigation of `page` to the tenant's page in the admin app. */
function leavingFor(page: Page, tenantId: string, timeout?: number) {
  return page.waitForRequest(
    (request) => request.isNavigationRequest() && request.url() === adminUrl(`/tenants/${tenantId}`),
    timeout ? { timeout } : undefined,
  );
}

// ---- J. The exchange and the /impersonate page

test('ADMTEN-167 opening the link lands read-only in the tenant dashboard', async ({ page, context, baseURL, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  // Held a moment, so the page's waiting state can be seen.
  await context.route(`**${EXCHANGE}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  const documents: string[] = [];
  context.on('request', (request) => {
    if (request.isNavigationRequest()) documents.push(request.url());
  });

  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'View as tenant' }).click();
  const start = page.getByRole('dialog', { name: 'View as this tenant?' });
  await start.getByLabel('Reason').fill('Ticket 167: checking the landing');
  await start.getByRole('button', { name: 'Start read-only session' }).click();
  const ready = page.getByRole('dialog', { name: `View as ${tenant.email}` });
  const [viewAs] = await Promise.all([context.waitForEvent('page'), ready.getByRole('link', { name: 'Open view-as' }).click()]);

  await expect(viewAs.getByText('Opening view-as...')).toBeVisible();
  await expect(viewAs).toHaveURL(`${baseURL}/projects`);
  // A full page load into the dashboard, not a client-side route change.
  expect(documents).toContain(`${baseURL}/projects`);
  await expect(viewAsBanner(viewAs)).toHaveText(
    new RegExp(`^Viewing ${escapeRegExp(tenant.email)} as Super Admin · read-only · ends in 30 min\\s*Exit$`),
  );
  await expect(viewAs.getByText(project.name)).toBeVisible();

  const stored = await storedViewAs(viewAs);
  expect(Object.keys(stored ?? {}).sort()).toEqual(['accessToken', 'expiresAt', 'tenant']);
  expect(stored?.tenant).toEqual({ id: tenant.userId, email: tenant.email, name: tenant.name });
  const claims = jwtClaims(String(stored?.accessToken));
  expect(claims).toMatchObject({ sub: tenant.userId, imp: staff.account.userId, impSid: staff.sessionId });
  expect(new Date(Number(claims.exp) * 1000).toISOString()).toBe(stored?.expiresAt);

  // Nothing of the session outlives the tab: no localStorage entry, no refresh cookie.
  const local = await viewAs.evaluate(() => Object.entries(localStorage));
  expect(local.map(([key]) => key)).not.toContain('chumbaq_signed_in');
  for (const [, value] of local) expect(value).not.toContain(String(stored?.accessToken));
  // Every cookie of the context (a URL filter would leave out the refresh cookie's path).
  const cookies = await context.cookies();
  expect(cookies.filter((cookie) => CUSTOMER_REFRESH_COOKIE.test(cookie.name))).toEqual([]);
});

test('ADMTEN-168 the code leaves the address bar before the request', async ({ page, context, baseURL, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const handoff = await startViewAs(staff, tenant.userId, clientIp);
  const code = codeFromViewAsUrl(handoff.url);

  const tab = await context.newPage();
  const exchanges: Request[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await tab.route(`**${EXCHANGE}`, async (route) => {
    exchanges.push(route.request());
    await held;
    await route.continue();
  });

  await tab.goto(handoff.url);
  await expect.poll(() => exchanges.length).toBe(1);
  // While the exchange is held, the address bar no longer holds the code.
  expect(await tab.evaluate(() => location.href)).toBe(`${baseURL}/impersonate`);
  expect(tab.url()).not.toContain(code);
  expect(exchanges[0].postDataJSON()).toEqual({ code });
  expect(exchanges[0].url()).toBe(`${baseURL}${EXCHANGE}`);
  expect(exchanges[0].method()).toBe('POST');

  release();
  await expect(tab).toHaveURL(`${baseURL}/projects`);
  await expect(viewAsBanner(tab)).toBeVisible();
  // History holds no entry with the code: Back leaves the app instead.
  expect(await tab.evaluate(() => history.length)).toBe(2);
  await tab.goBack();
  expect(tab.url()).not.toContain('code=');
  expect(tab.url()).not.toContain(code);
});

test('ADMTEN-170 the exchange spends the code and records it', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const p1 = await createProject(tenant, clientIp, `Billed one ${hex()}`);
  const p2 = await createProject(tenant, clientIp, `Billed two ${hex()}`);
  const other = await createAccount(newClientIp(), 'tenant', 'Otto Other');
  const joined = await createProject(other, clientIp, `Joined ${hex()}`);
  await sql(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')`, [joined.id, tenant.userId]);

  const handoff = await startViewAs(staff, tenant.userId, clientIp);
  const [row] = await handoffRows({ targetId: tenant.userId });
  const before = Date.now();
  const response = await exchange(codeFromViewAsUrl(handoff.url), clientIp);

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const data = (response.json as { data: { accessToken: string; expiresAt: string; tenant: unknown } }).data;
  expect(Object.keys(data).sort()).toEqual(['accessToken', 'expiresAt', 'tenant']);
  expect(data.tenant).toEqual({ id: tenant.userId, email: tenant.email, name: tenant.name });
  const minutesAhead = (Date.parse(data.expiresAt) - before) / 60_000;
  expect(minutesAhead).toBeGreaterThan(29.5);
  expect(minutesAhead).toBeLessThanOrEqual(30.1);
  const claims = jwtClaims(data.accessToken);
  expect(claims).toMatchObject({ sub: tenant.userId, imp: staff.account.userId, impSid: staff.sessionId, type: 'access' });

  const [spent] = (await sql<{ used_at: Date | null; used_ip: string | null }>(
    `SELECT used_at, used_ip FROM impersonation_handoffs WHERE id = $1`,
    [row.id],
  )) as { used_at: Date | null; used_ip: string | null }[];
  expect(spent.used_at).not.toBeNull();
  expect(spent.used_ip).toBe(clientIp);

  const audit = await auditRows({ action: 'tenant.impersonation_exchanged', targetId: tenant.userId });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_id: staff.account.userId,
    target_type: 'tenant',
    target_label: tenant.email,
    ip_address: clientIp,
    metadata: { handoffId: row.id, expiresAt: data.expiresAt },
  });

  const activity = await sql<{
    project_id: string;
    actor_kind: string;
    actor_user_id: string | null;
    actor_label: string;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT project_id, actor_kind, actor_user_id, actor_label, ip_address, user_agent
       FROM project_activity WHERE action = 'staff.viewed_as' AND project_id = ANY($1::uuid[])`,
    [[p1.id, p2.id, joined.id]],
  );
  expect(activity.map((entry) => entry.project_id).sort()).toEqual([p1.id, p2.id].sort());
  for (const entry of activity) {
    expect(entry).toMatchObject({ actor_kind: 'staff', actor_user_id: null, ip_address: null, user_agent: null });
    expect(entry.actor_label).not.toContain(staff.account.email);
    expect(entry.actor_label).not.toContain(staff.account.name);
  }
});

test('ADMTEN-171 a code works once', async ({ page, context, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const handoff = await startViewAs(staff, tenant.userId, clientIp);
  await exchangeViewAs(handoff.url, clientIp);
  const auditBefore = await exchangeAudit(tenant.userId);
  expect(auditBefore).toHaveLength(1);

  const again = await exchange(codeFromViewAsUrl(handoff.url), clientIp);
  expect(again.status).toBe(400);
  expect(again.json?.message).toBe(LINK_INVALID);

  const tab = await context.newPage();
  await tab.goto(handoff.url);
  const failure = tab.getByRole('alert');
  await expect(failure).toContainText(LINK_INVALID);
  await expect(failure.getByRole('link', { name: 'Back to the admin app' })).toHaveAttribute('href', adminUrl(''));
  await expect(viewAsBanner(tab)).toHaveCount(0);
  expect(await storedViewAs(tab)).toBeNull();

  expect(await exchangeAudit(tenant.userId)).toEqual(auditBefore);
});

test('ADMTEN-173 an expired code is refused', async ({ page, context, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const handoff = await startViewAs(staff, tenant.userId, clientIp);
  const [row] = await handoffRows({ targetId: tenant.userId });
  await sql(`UPDATE impersonation_handoffs SET expires_at = now() - interval '1 second' WHERE id = $1`, [row.id]);

  const tab = await context.newPage();
  const answered = tab.waitForResponse((response) => response.url().endsWith(EXCHANGE));
  await tab.goto(handoff.url);
  expect((await answered).status()).toBe(400);
  const failure = tab.getByRole('alert');
  await expect(failure).toContainText(LINK_INVALID);
  await expect(failure.getByRole('link', { name: 'Back to the admin app' })).toHaveAttribute('href', adminUrl(''));
  expect(await storedViewAs(tab)).toBeNull();

  const [after] = await handoffRows({ targetId: tenant.userId });
  expect(after.used_at).toBeNull();
  expect(await exchangeAudit(tenant.userId)).toEqual([]);
});

test('ADMTEN-178 the recheck refuses a code whose staff member stopped being staff', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const handoff = await startViewAs(staff, tenant.userId, clientIp);
  const [row] = await handoffRows({ targetId: tenant.userId });
  // Not the CLI, which also deletes unused codes.
  await sql(`UPDATE users SET is_super_admin = false WHERE id = $1`, [staff.account.userId]);

  const response = await exchange(codeFromViewAsUrl(handoff.url), clientIp);
  expect(response.status).toBe(400);
  expect(response.json?.message).toBe(LINK_INVALID);
  expect(response.text).not.toContain('accessToken');

  const [after] = await handoffRows({ targetId: tenant.userId });
  expect(after.used_at).not.toBeNull();
  const audit = await exchangeAudit(tenant.userId);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: 'tenant.impersonation_refused',
    actor_id: staff.account.userId,
    target_id: tenant.userId,
    ip_address: clientIp,
    metadata: { handoffId: row.id, reason: 'actor_not_staff' },
  });
});

test('ADMTEN-179 the recheck: staff signed out, version changed, suspended', async ({ page, browser, baseURL, clientIp }) => {
  test.slow(); // Two staff members enrol passkeys, and one signs in twice.
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');

  // Code 4 first, while the session is live: signing out deletes it.
  const fourth = await startViewAs(staff, tenant.userId, clientIp);
  expect(await handoffRows({ actorId: staff.account.userId })).toHaveLength(1);
  await page.goto(adminUrl('/'));
  const loggedOut = page.waitForResponse((response) => response.url().endsWith('/api/staff/auth/session/logout'));
  await page.getByRole('button', { name: 'Sign out' }).click();
  expect((await loggedOut).status()).toBe(204);
  await expect.poll(async () => (await handoffRows({ actorId: staff.account.userId })).length).toBe(0);
  const r4 = await exchange(codeFromViewAsUrl(fourth.url), clientIp);
  expect([r4.status, r4.json?.message]).toEqual([400, LINK_INVALID]);
  expect(await exchangeAudit(tenant.userId)).toEqual([]);

  // Signed in again: codes 1 and 2 from the new session.
  const token = await staffPasskeySignIn(page);
  const again: Staff = { ...staff, token, sessionId: String(jwtClaims(token).sid) };
  expect(again.sessionId).not.toBe(staff.sessionId);
  const first = await startViewAs(again, tenant.userId, clientIp);
  const second = await startViewAs(again, tenant.userId, clientIp);
  const [row1, row2] = await handoffRows({ actorId: staff.account.userId });

  // 1: the staff session ended without the sweep of unused codes.
  await sql(`UPDATE staff_sessions SET revoked_at = now() WHERE id = $1`, [again.sessionId]);
  const r1 = await exchange(codeFromViewAsUrl(first.url), clientIp);
  expect([r1.status, r1.json?.message]).toEqual([400, LINK_INVALID]);

  // 2: the staff member's session version moved on.
  await sql(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [staff.account.userId]);
  const r2 = await exchange(codeFromViewAsUrl(second.url), clientIp);
  expect([r2.status, r2.json?.message]).toEqual([400, LINK_INVALID]);

  // 3: a second staff member, suspended after making the code.
  const person = await newPersonContext(browser, baseURL);
  let row3!: { id: string };
  let suspendedStaff!: Staff;
  try {
    suspendedStaff = await signedInStaff(await person.context.newPage(), person.ip, 'Sue Second');
    const third = await startViewAs(suspendedStaff, tenant.userId, person.ip);
    [row3] = await handoffRows({ actorId: suspendedStaff.account.userId });
    await sql(`UPDATE users SET suspended_at = now() WHERE id = $1`, [suspendedStaff.account.userId]);
    const r3 = await exchange(codeFromViewAsUrl(third.url), clientIp);
    expect([r3.status, r3.json?.message]).toEqual([400, LINK_INVALID]);
  } finally {
    await person.context.close();
  }

  const refused = await auditRows({ action: 'tenant.impersonation_refused', targetId: tenant.userId });
  expect(refused.map((entry) => ({ actor: entry.actor_id, ...entry.metadata }))).toEqual([
    { actor: staff.account.userId, handoffId: row1.id, reason: 'staff_session_ended' },
    { actor: staff.account.userId, handoffId: row2.id, reason: 'actor_session_version' },
    { actor: suspendedStaff.account.userId, handoffId: row3.id, reason: 'actor_suspended' },
  ]);
  expect(await auditRows({ action: 'tenant.impersonation_exchanged', targetId: tenant.userId })).toEqual([]);
});

test('ADMTEN-180 the recheck: tenant suspended or made staff after the code was made', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');

  const first = await startViewAs(staff, tenant.userId, clientIp);
  await sql(`UPDATE users SET suspended_at = now(), suspended_reason = 'E2E: suspended after the code' WHERE id = $1`, [
    tenant.userId,
  ]);
  const r1 = await exchange(codeFromViewAsUrl(first.url), clientIp);
  expect([r1.status, r1.json?.message]).toEqual([400, LINK_INVALID]);

  await sql(`UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1`, [tenant.userId]);
  const second = await startViewAs(staff, tenant.userId, clientIp);
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [tenant.userId]);
  const r2 = await exchange(codeFromViewAsUrl(second.url), clientIp);
  expect([r2.status, r2.json?.message]).toEqual([400, LINK_INVALID]);

  const [row1, row2] = await handoffRows({ targetId: tenant.userId });
  const refused = await auditRows({ action: 'tenant.impersonation_refused', targetId: tenant.userId });
  expect(refused.map((entry) => entry.metadata)).toEqual([
    { handoffId: row1.id, reason: 'tenant_suspended' },
    { handoffId: row2.id, reason: 'tenant_super_admin' },
  ]);
  expect(refused.every((entry) => entry.actor_id === staff.account.userId && entry.ip_address === clientIp)).toBe(true);
  expect(await auditRows({ action: 'tenant.impersonation_exchanged', targetId: tenant.userId })).toEqual([]);
});

// ---- K. The view-as session in the customer app

test('ADMTEN-185 Exit ends view-as and returns to the tenant in the admin app', async ({ page, context, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const viewAs = await openViewAsTab(page, tenant);
  await expect(viewAs.getByText(project.name)).toBeVisible();
  const logouts: string[] = [];
  context.on('request', (request) => {
    if (/\/api\/auth\/logout/.test(request.url())) logouts.push(request.url());
  });

  const leaving = leavingFor(viewAs, tenant.userId);
  await viewAsBanner(viewAs).getByRole('button', { name: 'Exit' }).click();
  await leaving;
  // The admin app keeps its signed-in note per tab, so this new tab asks for a staff
  // sign-in; the staff session itself is untouched (checked in the admin tab below).
  await expect(viewAs).toHaveURL(new RegExp(`^${escapeRegExp(adminUrl('/sign-in'))}`));
  expect(logouts).toEqual([]);

  // The customer app in that tab no longer opens as the tenant.
  await viewAs.goto('/projects');
  expect(await storedViewAs(viewAs)).toBeNull();
  await expect(viewAs).toHaveURL(/\/login/);
  await expect(viewAsBanner(viewAs)).toHaveCount(0);
  await expect(viewAs.getByText(project.name)).toHaveCount(0);

  // And the admin tab is still signed in.
  await page.bringToFront();
  await page.reload();
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'View as tenant' })).toBeVisible();
});

test('ADMTEN-186 writes are refused with a read-only toast', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const link = await api<{ id: string }>(
    'POST',
    `/api/projects/${project.id}/links`,
    { longUrl: 'https://example.com/kept-in-view-as', title: 'Kept in view-as' },
    { token: tenant.accessToken, ip: clientIp },
  );
  const viewAs = await openViewAsTab(page, tenant);
  await viewAs.goto(`/projects/${project.id}/links/${link.id}`);
  await expect(viewAs.getByText('Kept in view-as').first()).toBeVisible();

  await linkActionsButton(viewAs).click();
  await viewAs.getByRole('menuitem', { name: 'Delete Link' }).click();
  const dialog = viewAs.getByRole('dialog', { name: 'Delete Link' });
  const [response] = await Promise.all([
    viewAs.waitForResponse((r) => r.url().endsWith(`/api/links/${link.id}`) && r.request().method() === 'DELETE'),
    dialog.getByRole('button', { name: 'Delete', exact: true }).click(),
  ]);
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { message: string }).message).toBe(READ_ONLY);
  await expect(customerToast(viewAs, 'Read-only session')).toContainText(READ_ONLY);

  // Nothing changed, and the session carries on where it was.
  expect(await sql(`SELECT id FROM links WHERE id = $1`, [link.id])).toHaveLength(1);
  await expect(viewAs).toHaveURL(new RegExp(`/projects/${project.id}/links/${link.id}$`));
  await expect(viewAsBanner(viewAs)).toBeVisible();
  expect(await storedViewAs(viewAs)).not.toBeNull();
});

test('ADMTEN-187 every non-GET method is refused for a view-as token', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const link = await api<{ id: string }>(
    'POST',
    `/api/projects/${project.id}/links`,
    { longUrl: 'https://example.com/kept-for-187' },
    { token: tenant.accessToken, ip: clientIp },
  );
  const token = await exchangeViewAs((await startViewAs(staff, tenant.userId, clientIp)).url, clientIp);
  const countOf = async (query: string, id: string) =>
    Number((await sql<{ n: string }>(query, [id]))[0].n);
  const before = {
    projects: await countOf(`SELECT count(*)::text AS n FROM projects WHERE owner_id = $1`, tenant.userId),
    links: await countOf(`SELECT count(*)::text AS n FROM links WHERE project_id = $1`, project.id),
    billing: await countOf(`SELECT count(*)::text AS n FROM billing_accounts WHERE user_id = $1`, tenant.userId),
  };

  const writes: [string, string, unknown][] = [
    ['POST', '/api/projects', { name: 'Made in view-as', domain: 'view-as.e2e.example.test' }],
    ['PATCH', `/api/projects/${project.id}`, { name: 'Renamed in view-as' }],
    ['DELETE', `/api/links/${link.id}`, undefined],
    ['POST', `/api/projects/${project.id}/links`, { longUrl: 'https://example.com/made-in-view-as' }],
    // An empty body: the refusal comes before validation, let alone the handler.
    ['PUT', '/api/billing/details', {}],
  ];
  for (const [method, path, body] of writes) {
    const response = await customerRequest(method, path, { token, ip: clientIp, body });
    expect.soft([response.status, response.json?.message], `${method} ${path}`).toEqual([403, READ_ONLY]);
  }

  expect((await sql<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [project.id]))[0].name).toBe(project.name);
  expect({
    projects: await countOf(`SELECT count(*)::text AS n FROM projects WHERE owner_id = $1`, tenant.userId),
    links: await countOf(`SELECT count(*)::text AS n FROM links WHERE project_id = $1`, project.id),
    billing: await countOf(`SELECT count(*)::text AS n FROM billing_accounts WHERE user_id = $1`, tenant.userId),
  }).toEqual(before);

  const read = await customerRequest('GET', '/api/projects', { token, ip: clientIp });
  expect(read.status).toBe(200);
  expect(read.text).toContain(project.id);
  const head = await customerRequest('HEAD', '/api/projects', { token, ip: clientIp });
  expect(head.status).toBe(200);
  const options = await customerRequest('OPTIONS', '/api/projects', { token, ip: clientIp });
  expect(options.status).not.toBe(403);
  expect(options.text).not.toContain(READ_ONLY);
});

test('ADMTEN-189 view-as is per tab', async ({ page, context, baseURL, clientIp }) => {
  test.slow();
  // The staff member signs in to the customer app as themselves first, with a password,
  // as anyone with no staff passkey yet can.
  const account = await createAccount(clientIp, 'staff', 'Sam Staff');
  const own = await createProject(account, clientIp, `Staff own ${hex()}`);
  const tabA = page;
  await signIn(tabA, account);
  await expect(tabA.getByText(own.name)).toBeVisible();

  await makeSuperAdmin(account.userId);
  const admin = await context.newPage();
  await enrolAndSignInStaff(admin, account);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const theirs = await createProject(tenant, clientIp, `Tenant project ${hex()}`);

  const ownView = async () => {
    await tabA.bringToFront();
    await tabA.goto('/projects');
    await expect(tabA.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(tabA.getByText(own.name)).toBeVisible();
    await expect(tabA.getByText(theirs.name)).toHaveCount(0);
    await expect(viewAsBanner(tabA)).toHaveCount(0);
    expect(await storedViewAs(tabA)).toBeNull();
  };
  await ownView();

  const viewAs = await openViewAsTab(admin, tenant);
  await expect(viewAs.getByText(theirs.name)).toBeVisible();
  await expect(viewAs.getByText(own.name)).toHaveCount(0);
  await ownView();

  await viewAs.bringToFront();
  await viewAsBanner(viewAs).getByRole('button', { name: 'Exit' }).click();
  await expect(viewAs).toHaveURL(adminUrl(`/tenants/${tenant.userId}`));
  await ownView();

  const cookies = await context.cookies();
  expect(cookies.filter((cookie) => CUSTOMER_REFRESH_COOKIE.test(cookie.name))).toHaveLength(1);
  expect(await tabA.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBe('1');
});

test('ADMTEN-191 expiry after 30 minutes returns to the admin app', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const viewAs = await openViewAsTab(page, tenant);
  await expect(viewAs.getByText(project.name)).toBeVisible();

  // The banner checks once a second, so the tab leaves within about a second.
  const leaving = leavingFor(viewAs, tenant.userId, 3_000);
  await viewAs.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem('chumbaq_impersonation') as string) as { expiresAt: string };
    session.expiresAt = new Date(Date.now() - 1_000).toISOString();
    sessionStorage.setItem('chumbaq_impersonation', JSON.stringify(session));
  });
  await leaving;
  await expect(viewAs).toHaveURL(new RegExp(`^${escapeRegExp(adminUrl(''))}/`));
  await expect(viewAs.getByText(project.name)).toHaveCount(0);

  await viewAs.goto('/projects');
  expect(await storedViewAs(viewAs)).toBeNull();
  await expect(viewAs).toHaveURL(/\/login/);
  await expect(viewAsBanner(viewAs)).toHaveCount(0);
});

test('ADMTEN-192 signing out of the admin app ends view-as', async ({ page, baseURL, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const viewAs = await openViewAsTab(page, tenant);
  await expect(viewAs.getByText(project.name)).toBeVisible();

  await page.bringToFront();
  const loggedOut = page.waitForResponse((response) => response.url().endsWith('/api/staff/auth/session/logout'));
  await page.getByRole('button', { name: 'Sign out' }).click();
  expect((await loggedOut).status()).toBe(204);

  await viewAs.bringToFront();
  const refusals = await recordRefusals(viewAs);
  const leaving = leavingFor(viewAs, tenant.userId);
  await viewAs.getByText(project.name).click();
  await leaving;
  const customer = refusals.filter((refusal) => refusal.url.startsWith(`${baseURL}/api/`));
  expect(customer[0]).toMatchObject({ status: 401, message: NO_LONGER_VALID });
  // The admin app then asks for a staff sign-in.
  await expect(viewAs).toHaveURL(new RegExp(`^${escapeRegExp(adminUrl('/sign-in'))}`));
  await viewAs.unroute('**/api/**');
  await viewAs.goto('/projects');
  expect(await storedViewAs(viewAs)).toBeNull();
  await expect(viewAsBanner(viewAs)).toHaveCount(0);
});

test('ADMTEN-193 revoking the staff member ends a live view-as token', async ({ page, clientIp }) => {
  test.slow(); // The revoke runs the CLI through ts-node.
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const token = await exchangeViewAs((await startViewAs(staff, tenant.userId, clientIp)).url, clientIp);
  expect((await customerRequest('GET', '/api/projects', { token, ip: clientIp })).status).toBe(200);

  await revokeSuperAdminCli(staff.account.email);
  expect((await userRow(staff.account.userId)).is_super_admin).toBe(false);

  const refused = await customerRequest('GET', '/api/projects', { token, ip: clientIp });
  expect([refused.status, refused.json?.message]).toEqual([401, NO_LONGER_VALID]);
});

// ---- L. Second factor reset (staff side)

test.skip('ADMTEN-204 starting a reset is refused without account email', async () => {
  // Account email is configured in the e2e stack, so this refusal cannot be produced locally.
});

test('ADMTEN-214 staff cancel a pending reset', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await enrolTotp({ ip: newClientIp() }, tenant);
  const resetId = await seedPendingFactorReset({
    userId: tenant.userId,
    requestedBy: { userId: staff.account.userId, email: staff.account.email },
  });
  // Cancelling keeps things as they are, so it needs no recent sign-in.
  await makeStaffSignInStale(staff.account.userId);
  await openTenantPage(page, tenant);

  const card = secondFactorsCard(page);
  await expect(card).toContainText('Reset scheduled for');
  await expect(card).toContainText(`Requested by ${staff.account.email} on`);
  let held = false;
  await page.route('**/factor-reset', async (route) => {
    if (route.request().method() === 'DELETE' && !held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await route.continue();
  });
  await card.getByRole('button', { name: 'Cancel reset' }).click();
  await expect(card.getByRole('button', { name: 'Cancelling...' })).toBeDisabled();
  await expect(adminToast(page, 'Reset cancelled')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);

  // Back to the state with no reset: the tenant has a factor and account email works.
  await expect(card).toContainText(
    'If the owner has lost every passkey, authenticator and recovery code, their factors can be removed after a waiting period. Be sure who is asking first.',
  );
  await expect(card.getByRole('button', { name: 'Reset second factors' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cancel reset' })).toHaveCount(0);

  const rows = await factorResetRows(tenant.userId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: resetId, status: 'cancelled', cancelled_by: 'staff' });
  expect(rows[0].cancelled_at).not.toBeNull();
  const audit = await auditRows({ action: 'account.factors_reset_cancelled', targetId: tenant.userId });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_id: staff.account.userId,
    actor_email: staff.account.email,
    metadata: { resetId, cancelledBy: 'staff' },
  });
  await expect(page.getByText('Second factor reset cancelled', { exact: true })).toBeVisible();
});

test('ADMTEN-216 request refusals from the API', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const superAdmin = await createAccount(newClientIp(), 'staff', 'Ona Admin');
  await makeSuperAdmin(superAdmin.userId);
  const noFactors = await createAccount(newClientIp(), 'tenant', 'Nia Nofactor');
  const waiting = await createAccount(newClientIp(), 'tenant', 'Wes Waiting');
  await enrolTotp({ ip: newClientIp() }, waiting);
  await seedPendingFactorReset({ userId: waiting.userId, requestedBy: { userId: staff.account.userId, email: staff.account.email } });
  const recent = await createAccount(newClientIp(), 'tenant', 'Rae Recent');
  await enrolTotp({ ip: newClientIp() }, recent);
  const [{ password_reset_at: resetAt }] = await sql<{ password_reset_at: Date }>(
    `UPDATE users SET password_reset_at = now() - interval '2 days' WHERE id = $1 RETURNING password_reset_at`,
    [recent.userId],
  );
  const body = {
    reason: 'Owner lost every factor (E2E)',
    verificationMethod: 'video_call',
    verificationNotes: 'Saw them on a video call, ID matched',
  };

  const cases: [string, number, string][] = [
    [superAdmin.userId, 409, 'A super admin cannot be reset here. Use the CLI.'],
    [noFactors.userId, 409, 'This account has no second factors to reset.'],
    [waiting.userId, 409, 'A reset is already waiting for this account.'],
    [
      recent.userId,
      409,
      `This account's password was reset on ${new Date(resetAt).toISOString()}. Whoever did that controls its mailbox ` +
        'and may not be the owner, and with the factors gone they would own the account. Confirm who is asking some ' +
        'other way, then give a separate justification for going ahead.',
    ],
    [randomUUID(), 404, 'Tenant not found'],
  ];
  for (const [target, status, message] of cases) {
    const response = await adminRequest('POST', `/api/admin/tenants/${target}/factor-reset`, { token: staff.token, ip: clientIp, body });
    expect.soft([response.status, response.json?.message], message.slice(0, 40)).toEqual([status, message]);
  }

  expect(await factorResetRows(superAdmin.userId)).toEqual([]);
  expect(await factorResetRows(noFactors.userId)).toEqual([]);
  expect((await factorResetRows(waiting.userId)).map((row) => row.status)).toEqual(['pending']);
  expect(await factorResetRows(recent.userId)).toEqual([]);
  expect(await auditRows({ action: 'account.factors_reset_requested', actorId: staff.account.userId })).toEqual([]);
});

test('ADMTEN-218 a request needs a recent staff sign-in; cancel does not', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const waiting = await createAccount(newClientIp(), 'tenant', 'Wes Waiting');
  await enrolTotp({ ip: newClientIp() }, waiting);
  const resetId = await seedPendingFactorReset({
    userId: waiting.userId,
    requestedBy: { userId: staff.account.userId, email: staff.account.email },
  });
  const other = await createAccount(newClientIp(), 'tenant', 'Uma Other');
  await enrolTotp({ ip: newClientIp() }, other);

  await makeStaffSignInStale(staff.account.userId);
  const stale = await refreshStaffToken(page);
  expect(Number(jwtClaims(stale).auth_time) * 1000).toBeLessThan(Date.now() - 15 * 60_000);
  const body = {
    reason: 'Owner lost every factor (E2E)',
    verificationMethod: 'video_call',
    verificationNotes: 'Saw them on a video call, ID matched',
  };

  const requested = await adminRequest('POST', `/api/admin/tenants/${other.userId}/factor-reset`, { token: stale, ip: clientIp, body });
  expect([requested.status, requested.json?.message]).toEqual([403, REAUTH]);
  // Before any other check: an unknown tenant and an empty body get the same answer.
  const unknown = await adminRequest('POST', `/api/admin/tenants/${randomUUID()}/factor-reset`, { token: stale, ip: clientIp, body: {} });
  expect([unknown.status, unknown.json?.message]).toEqual([403, REAUTH]);
  expect(await factorResetRows(other.userId)).toEqual([]);

  const cancelled = await adminRequest('DELETE', `/api/admin/tenants/${waiting.userId}/factor-reset`, { token: stale, ip: clientIp });
  expect(cancelled.status).toBe(200);
  expect((cancelled.json?.data as { pending: unknown }).pending).toBeNull();
  expect(await factorResetRows(waiting.userId)).toMatchObject([{ id: resetId, status: 'cancelled', cancelled_by: 'staff' }]);
});

// ---- M. Coverage review additions

test('ADMTEN-245 a tenant session version change ends a live view-as', async ({ page, baseURL, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const viewAs = await openViewAsTab(page, tenant);
  await expect(viewAs.getByText(project.name)).toBeVisible();
  const versionBefore = (await userRow(tenant.userId)).session_version;

  // The tenant, signed in elsewhere, signs out everywhere.
  const signedOut = await customerRequest('POST', '/api/auth/logout-all', { token: tenant.accessToken, ip: newClientIp() });
  expect(signedOut.status).toBe(204);
  expect((await userRow(tenant.userId)).session_version).toBe(versionBefore + 1);

  const refusals = await recordRefusals(viewAs);
  const leaving = leavingFor(viewAs, tenant.userId);
  await viewAs.getByText(project.name).click();
  await leaving;
  const customer = refusals.filter((refusal) => refusal.url.startsWith(`${baseURL}/api/`));
  expect(customer[0]).toMatchObject({ status: 401, message: 'Session has been revoked' });
  // The staff session is untouched: the admin tab still opens the tenant's page.
  expect((await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp })).status).toBe(200);
  await page.bringToFront();
  await page.reload();
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'View as tenant' })).toBeVisible();

  await viewAs.bringToFront();
  await viewAs.unroute('**/api/**');
  await viewAs.goto('/projects');
  expect(await storedViewAs(viewAs)).toBeNull();
  await expect(viewAsBanner(viewAs)).toHaveCount(0);
});

test('ADMTEN-246 suspending the staff member ends their live view-as', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const token = await exchangeViewAs((await startViewAs(staff, tenant.userId, clientIp)).url, clientIp);
  expect((await customerRequest('GET', '/api/projects', { token, ip: clientIp })).status).toBe(200);
  expect((await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp })).status).toBe(200);

  await sql(`UPDATE users SET suspended_at = now(), suspended_reason = 'E2E: staff suspended' WHERE id = $1`, [staff.account.userId]);

  const refused = await customerRequest('GET', '/api/projects', { token, ip: clientIp });
  expect([refused.status, refused.json?.message]).toEqual([401, NO_LONGER_VALID]);
  const own = await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp });
  expect([own.status, own.json?.message]).toEqual([401, STAFF_ENDED]);
});

test('ADMTEN-247 a staff session version change ends their live view-as', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const token = await exchangeViewAs((await startViewAs(staff, tenant.userId, clientIp)).url, clientIp);
  expect((await customerRequest('GET', '/api/projects', { token, ip: clientIp })).status).toBe(200);
  expect((await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp })).status).toBe(200);

  await sql(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [staff.account.userId]);

  const refused = await customerRequest('GET', '/api/projects', { token, ip: clientIp });
  expect([refused.status, refused.json?.message]).toEqual([401, NO_LONGER_VALID]);
  // The tenant's own side is unchanged: the refusal is about the staff member.
  expect((await userRow(tenant.userId)).suspended_at).toBeNull();
  const own = await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp });
  expect([own.status, own.json?.message]).toEqual([401, STAFF_ENDED]);
});

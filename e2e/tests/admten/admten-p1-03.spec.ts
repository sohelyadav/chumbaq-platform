import { randomBytes, randomUUID } from 'crypto';
import type { Page, Request } from '@playwright/test';
import { adminApi, adminUrl, enrolAndSignInStaff } from '../../support/admin';
import { apiUrl, createAccount, createProject, newClientIp, type Account } from '../../support/api';
import { enrolTotp } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { failStub } from '../../support/provider-stub';
import {
  COUNTED_STATE,
  FIRST_MONTH_STATE,
  adminDate,
  adminRequest,
  auditCountFromIp,
  auditRows,
  cardTitled,
  codeFromViewAsUrl,
  customerRequest,
  factorResetRows,
  handoffRows,
  insertTenants,
  jwtClaims,
  listedEmails,
  makeSuperAdmin,
  openOverview,
  openTenantPage,
  openViewAsTab,
  parseCsv,
  recordAuthorizations,
  secondFactorsCard,
  seedPendingFactorReset,
  seedUsage,
  setRollupState,
  signCustomerJwt,
  signedInStaff,
  sql,
  stableOverview,
  startViewAs,
  statCaption,
  statValue,
  storedViewAs,
  tenantRows,
  usageDay,
  usageShortDay,
  usageSums,
  userRow,
  utcDay,
  viewAsBanner,
  writeStoredViewAs,
  type RollupStateSeed,
  type Staff,
  type UsageSeed,
} from '../../support/areas/admten';

/**
 * Admin tenant cases, third P1 chunk: starting view-as from the tenant page, the
 * exchange and the /impersonate page, the view-as session in the customer app and what
 * ends it, the staff side of a second factor reset, and the coverage review additions
 * (search, usage on the overview and tenants list, refusals after the page loaded,
 * stored view-as records). Tests that set the usage roll-up state hold its lock and put
 * it back.
 */

test.describe.configure({ mode: 'parallel' });

const LINK_INVALID = 'This view-as link has expired or was already used.';
const NO_LONGER_VALID = 'Impersonation session is no longer valid';
const STAFF_ENDED = 'Your staff session has ended. Sign in again.';
const EXCHANGE = '/api/auth/impersonation/exchange';
const RESET_INTRO =
  'If the owner has lost every passkey, authenticator and recovery code, their factors can be removed after a waiting period. Be sure who is asking first.';
const RESET_DIALOG = "Reset this tenant's second factors?";

const hex = () => randomBytes(2).toString('hex');
const term = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;
const fmt = (n: number) => n.toLocaleString('en-US');
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const randomCode = () => randomBytes(32).toString('base64url');

function exchange(code: string, ip: string) {
  return customerRequest('POST', EXCHANGE, { ip, body: { code } });
}

function messagesOf(json: { message?: unknown } | null): unknown[] {
  const message = json?.message;
  return Array.isArray(message) ? message : [message];
}

function adminToast(page: Page, title: string) {
  return page.getByText(title, { exact: true }).first();
}

/** A navigation of `page` to the tenant's page in the admin app. */
function leavingFor(page: Page, tenantId: string, timeout?: number) {
  return page.waitForRequest(
    (request) => request.isNavigationRequest() && request.url() === adminUrl(`/tenants/${tenantId}`),
    timeout ? { timeout } : undefined,
  );
}

/** Sets the roll-up state and seeds usage rows for `work`, then puts both back. */
async function withUsage<T>(state: RollupStateSeed | null, rows: UsageSeed[], work: () => Promise<T>): Promise<T> {
  const restoreState = await setRollupState(state);
  const removeUsage = await seedUsage(rows);
  try {
    return await work();
  } finally {
    await removeUsage();
    await restoreState();
  }
}

/** The row of the tenants table showing `email`. */
function rowOf(page: Page, email: string) {
  return tenantRows(page).filter({ has: page.getByRole('link', { name: email, exact: true }) });
}

function urlParams(page: Page): Record<string, string> {
  return Object.fromEntries(new URL(page.url()).searchParams);
}

/** A tenant holding an authenticator app, so the factor reset card offers a reset. */
async function tenantWithFactor(label = 'tenant', name = 'Tess Tenant'): Promise<Account> {
  const tenant = await createAccount(newClientIp(), label, name);
  await enrolTotp({ ip: newClientIp() }, tenant);
  return tenant;
}

async function openResetDialog(page: Page, tenant: Account) {
  await openTenantPage(page, tenant);
  await secondFactorsCard(page).getByRole('button', { name: 'Reset second factors' }).click();
  const dialog = page.getByRole('dialog', { name: RESET_DIALOG });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseMethod(page: Page, label: string): Promise<void> {
  await page.getByRole('combobox', { name: 'How you verified who is asking' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

const RESET_BODY = {
  reason: 'Owner lost every factor (E2E)',
  verificationMethod: 'video_call',
  verificationNotes: 'Saw them on a video call, ID matched',
};

// ---- I. Starting view-as in the admin app

test('ADMTEN-156 view-as dialog content and reason rules', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);

  await page.getByRole('button', { name: 'View as tenant' }).click();
  const dialog = page.getByRole('dialog', { name: 'View as this tenant?' });
  await expect(dialog).toContainText(
    'View as opens the customer app in a new tab, read-only, for 30 minutes. It is recorded in the audit log with your reason, and ends if you sign out here.',
  );
  const reason = dialog.getByLabel('Reason');
  await expect(reason).toBeVisible();
  await expect(dialog.getByText('0/500 characters, at least 10. Recorded in the audit log.', { exact: true })).toBeVisible();
  // No confirmation field: only the reason.
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await expect(dialog.getByText(/to confirm$/)).toHaveCount(0);
  const start = dialog.getByRole('button', { name: 'Start read-only session' });
  await expect(start).toBeDisabled();

  // Padding does not count: nine characters once trimmed.
  await reason.fill('   123456789   ');
  await expect(dialog.getByText('9/500 characters, at least 10. Recorded in the audit log.', { exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
  await reason.fill('   1234567890   ');
  await expect(dialog.getByText('10/500 characters, at least 10. Recorded in the audit log.', { exact: true })).toBeVisible();
  await expect(start).toBeEnabled();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await handoffRows({ targetId: tenant.userId })).toHaveLength(0);
});

test('ADMTEN-158 the view-as link is an anchor opened by the click', async ({ page, context, baseURL, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'View as tenant' }).click();
  const start = page.getByRole('dialog', { name: 'View as this tenant?' });
  await start.getByLabel('Reason').fill('Ticket 158: checking the link');
  const answered = page.waitForResponse((response) => response.url().endsWith('/impersonate') && response.request().method() === 'POST');
  await start.getByRole('button', { name: 'Start read-only session' }).click();
  const { data } = (await (await answered).json()) as { data: { url: string } };

  const ready = page.getByRole('dialog', { name: `View as ${tenant.email}` });
  const link = ready.getByRole('link', { name: 'Open view-as' });
  await expect(link).toHaveAttribute('href', data.url);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  const [viewAs] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await expect(ready).toBeHidden();
  await expect(viewAs).toHaveURL(`${baseURL}/projects`);
  await expect(viewAsBanner(viewAs)).toBeVisible();
  // noopener: the new tab holds no reference back to the admin tab.
  expect(await viewAs.evaluate(() => window.opener === null)).toBe(true);
});

test('ADMTEN-163 view-as reason validation (API)', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const path = `/api/admin/tenants/${tenant.userId}/impersonate`;
  const cases: { body: unknown; expected: string[] }[] = [
    { body: {}, expected: ['reason must be longer than or equal to 10 characters', 'reason must be a string'] },
    { body: { reason: '   123456789   ' }, expected: ['reason must be longer than or equal to 10 characters'] },
    { body: { reason: 'r'.repeat(501) }, expected: ['reason must be shorter than or equal to 500 characters'] },
    { body: { reason: ['a long enough reason'] }, expected: ['reason must be a string'] },
    { body: { reason: 'E2E: null\u0000character' }, expected: ['reason must not contain null characters'] },
  ];
  for (const { body, expected } of cases) {
    const response = await adminRequest('POST', path, { token: staff.token, ip: clientIp, body });
    const label = JSON.stringify(body).slice(0, 60);
    expect.soft(response.status, label).toBe(400);
    expect.soft(messagesOf(response.json), label).toEqual(expect.arrayContaining(expected));
  }
  expect(await handoffRows({ targetId: tenant.userId })).toHaveLength(0);
  expect(await auditRows({ action: 'tenant.impersonated', targetId: tenant.userId })).toHaveLength(0);

  // The same route with a valid reason does make a code (from another address: the
  // refusals above count towards this one's limit of 5 a minute).
  await startViewAs(staff, tenant.userId, newClientIp());
  expect(await handoffRows({ targetId: tenant.userId })).toHaveLength(1);
});

test('ADMTEN-165 a signed-out staff session cannot mint a code', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  expect((await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp })).status).toBe(200);

  const loggedOut = page.waitForResponse((response) => response.url().endsWith('/api/staff/auth/session/logout'));
  await page.getByRole('button', { name: 'Sign out' }).click();
  expect((await loggedOut).status()).toBe(204);

  // The access token from before is still inside its ten minutes.
  expect(Number(jwtClaims(staff.token).exp) * 1000).toBeGreaterThan(Date.now());
  const response = await adminRequest('POST', `/api/admin/tenants/${tenant.userId}/impersonate`, {
    token: staff.token,
    ip: clientIp,
    body: { reason: 'E2E: after signing out' },
  });
  expect([response.status, response.json?.message]).toEqual([401, STAFF_ENDED]);
  expect(await handoffRows({ actorId: staff.account.userId })).toHaveLength(0);
  expect(await auditRows({ action: 'tenant.impersonated', targetId: tenant.userId })).toHaveLength(0);
});

// ---- J. The exchange and the /impersonate page

test('ADMTEN-169 the exchange carries no customer bearer token', async ({ page, context, clientIp }) => {
  test.slow();
  // The staff member is signed in to the customer app as themselves in this browser.
  const account = await createAccount(clientIp, 'staff', 'Sam Staff');
  const own = await createProject(account, clientIp, `Staff own ${hex()}`);
  await signIn(page, account);
  await expect(page.getByText(own.name)).toBeVisible();
  await makeSuperAdmin(account.userId);
  const admin = await context.newPage();
  const token = await enrolAndSignInStaff(admin, account);
  const staff: Staff = { account, token, sessionId: String(jwtClaims(token).sid) };
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const theirs = await createProject(tenant, clientIp, `Tenant project ${hex()}`);

  // Positive control: this browser's own customer requests do carry a bearer.
  await page.bringToFront();
  const [ownRequest] = await Promise.all([
    page.waitForRequest((request) => new URL(request.url()).pathname === '/api/projects'),
    page.reload(),
  ]);
  expect((await ownRequest.allHeaders())['authorization']).toMatch(/^Bearer /);

  const handoff = await startViewAs(staff, tenant.userId, clientIp);
  const tab = await context.newPage();
  const exchanges: Request[] = [];
  tab.on('request', (request) => {
    if (new URL(request.url()).pathname === EXCHANGE) exchanges.push(request);
  });
  await tab.goto(handoff.url);
  await expect(viewAsBanner(tab)).toBeVisible();
  await expect(tab.getByText(theirs.name)).toBeVisible();
  await expect(tab.getByText(own.name)).toHaveCount(0);

  expect(exchanges).toHaveLength(1);
  const headers = await exchanges[0].allHeaders();
  expect(headers['authorization']).toBeUndefined();
  expect(headers['x-chumbaq-client']).toBe('web');
});

test('ADMTEN-172 two simultaneous exchanges of one code', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const code = codeFromViewAsUrl((await startViewAs(staff, tenant.userId, clientIp)).url);

  const results = await Promise.all([exchange(code, clientIp), exchange(code, clientIp)]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
  expect(results.find((result) => result.status === 400)?.json?.message).toBe(LINK_INVALID);
  expect(await auditRows({ action: 'tenant.impersonation_exchanged', targetId: tenant.userId })).toHaveLength(1);
  expect(await auditRows({ action: 'tenant.impersonation_refused', targetId: tenant.userId })).toHaveLength(0);
});

test('ADMTEN-174 missing or malformed fragment', async ({ page, context, baseURL, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const handoff = await startViewAs(staff, tenant.userId, clientIp);
  const code = codeFromViewAsUrl(handoff.url);

  const visits = ['/impersonate', '/impersonate#code=short', `/impersonate#code=${code}&x=1`, `/impersonate?code=${code}`];
  for (const visit of visits) {
    const tab = await context.newPage();
    const exchanges: string[] = [];
    tab.on('request', (request) => {
      if (new URL(request.url()).pathname === EXCHANGE) exchanges.push(request.url());
    });
    await tab.goto(visit);
    await expect.soft(tab.getByRole('alert'), visit).toContainText(LINK_INVALID);
    await expect.soft(tab.getByRole('link', { name: 'Back to the admin app' }), visit).toBeVisible();
    await expect.soft(tab, visit).toHaveURL(`${baseURL}/impersonate`);
    expect.soft(exchanges, visit).toEqual([]);
    await tab.close();
  }

  // The real code was in two of those addresses and is still unspent.
  const [row] = await handoffRows({ targetId: tenant.userId });
  expect(row.used_at).toBeNull();
  expect((await exchange(code, clientIp)).status).toBe(200);
});

test('ADMTEN-175 exchange API validation and client header', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const code = codeFromViewAsUrl((await startViewAs(staff, tenant.userId, clientIp)).url);

  const noHeader = await fetch(apiUrl(EXCHANGE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp },
    body: JSON.stringify({ code }),
  });
  expect(noHeader.status).toBe(403);
  expect(((await noHeader.json()) as { message: string }).message).toBe('Missing client header');

  const cases: { body: unknown; expected: string[] }[] = [
    { body: {}, expected: ['code must be a string'] },
    { body: { code: 'abc' }, expected: ['code is not a view-as code'] },
    { body: { code: `${code}A` }, expected: ['code is not a view-as code'] },
    { body: { code: `${code.slice(0, 42)}+` }, expected: ['code is not a view-as code'] },
    { body: { code, extra: 1 }, expected: ['property extra should not exist'] },
  ];
  for (const { body, expected } of cases) {
    const response = await customerRequest('POST', EXCHANGE, { ip: clientIp, body });
    const label = JSON.stringify(body);
    expect.soft(response.status, label).toBe(400);
    expect.soft(messagesOf(response.json), label).toEqual(expect.arrayContaining(expected));
  }

  // Nothing above spent the code: it still works once.
  const [row] = await handoffRows({ targetId: tenant.userId });
  expect(row.used_at).toBeNull();
  expect((await exchange(code, clientIp)).status).toBe(200);
});

test('ADMTEN-176 a random well-formed code is refused the same way', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const spent = codeFromViewAsUrl((await startViewAs(staff, tenant.userId, clientIp)).url);
  expect((await exchange(spent, clientIp)).status).toBe(200);
  // The exchange route records this test's address, so counting by it would see a row.
  const exchanged = await auditRows({ action: 'tenant.impersonation_exchanged', targetId: tenant.userId });
  expect(exchanged.map((row) => row.ip_address)).toEqual([clientIp]);
  const auditBefore = await auditCountFromIp(clientIp);

  const timed = async (code: string) => {
    const started = performance.now();
    const response = await exchange(code, clientIp);
    return { response, ms: performance.now() - started };
  };
  const randoms = [await timed(randomCode()), await timed(randomCode()), await timed(randomCode())];
  const spents = [await timed(spent), await timed(spent), await timed(spent)];
  for (const { response } of [...randoms, ...spents]) {
    expect([response.status, response.json?.message]).toEqual([400, LINK_INVALID]);
  }
  // Neither an unknown nor a spent code writes anything.
  expect(await auditCountFromIp(clientIp)).toBe(auditBefore);
  // Answered in about the same time: both are one lookup that finds nothing to spend.
  const average = (runs: { ms: number }[]) => runs.reduce((sum, run) => sum + run.ms, 0) / runs.length;
  expect(Math.abs(average(randoms) - average(spents))).toBeLessThan(500);
});

// ---- K. The view-as session in the customer app

test('ADMTEN-183 the banner is pinned above every page and counts down', async ({ page, context, baseURL, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const handoff = await startViewAs(staff, tenant.userId, clientIp);

  const viewAs = await context.newPage();
  await viewAs.clock.install();
  await viewAs.goto(handoff.url);
  await expect(viewAs).toHaveURL(`${baseURL}/projects`);
  const banner = viewAsBanner(viewAs);
  const text = new RegExp(`^Viewing ${escapeRegExp(tenant.email)} as Super Admin · read-only · ends in (\\d+) min\\s*Exit$`);

  for (const path of ['/projects', `/projects/${project.id}`, '/settings']) {
    await viewAs.goto(path);
    await expect.soft(banner, path).toHaveText(text);
    await expect.soft(banner.getByRole('button', { name: 'Exit' }), path).toBeVisible();
    expect.soft(await banner.evaluate((el) => getComputedStyle(el).position), path).toBe('fixed');
    const box = await banner.boundingBox();
    expect.soft(box?.y, path).toBe(0);
    expect.soft(box?.height, path).toBe(40);
    // The page is moved down by the banner's height.
    expect.soft(await viewAs.evaluate(() => getComputedStyle(document.body).paddingTop), path).toBe('40px');
    if (path !== '/projects' && path !== '/settings') {
      const sidebar = viewAs.locator('[data-slot="sidebar-container"]');
      expect.soft(await sidebar.evaluate((el) => getComputedStyle(el).top), path).toBe('40px');
    }
  }
  await expect(banner).toHaveText(/ends in 30 min/);

  await viewAs.clock.fastForward('10:00');
  await expect(banner).toHaveText(/ends in (19|20) min/);
  await expect(banner.getByRole('button', { name: 'Exit' })).toBeVisible();
});

test('ADMTEN-188 reload keeps the view-as session without refreshing', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const viewAs = await openViewAsTab(page, tenant);
  await expect(viewAs.getByText(project.name)).toBeVisible();
  const refreshes: string[] = [];
  const projectReads: string[] = [];
  viewAs.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/refresh') refreshes.push(request.url());
    if (path === '/api/projects') projectReads.push(request.headers()['authorization'] ?? '');
  });

  await viewAs.reload();
  await expect(viewAsBanner(viewAs)).toBeVisible();
  await expect(viewAs.getByText(project.name)).toBeVisible();
  // The reload did read the tenant's projects again, with the view-as token.
  expect(projectReads.length).toBeGreaterThan(0);
  const stored = await storedViewAs(viewAs);
  expect(projectReads).toContain(`Bearer ${String(stored?.accessToken)}`);
  expect(refreshes).toEqual([]);
});

test('ADMTEN-194 a tenant made super admin cannot be viewed through a live token', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const { url } = await startViewAs(staff, tenant.userId, clientIp);
  const token = (await exchange(codeFromViewAsUrl(url), clientIp)).json?.data as { accessToken: string };
  expect((await customerRequest('GET', '/api/projects', { token: token.accessToken, ip: clientIp })).status).toBe(200);

  await makeSuperAdmin(tenant.userId);
  try {
    const refused = await customerRequest('GET', '/api/projects', { token: token.accessToken, ip: clientIp });
    expect([refused.status, refused.json?.message]).toEqual([401, NO_LONGER_VALID]);
  } finally {
    await sql(`UPDATE users SET is_super_admin = false WHERE id = $1`, [tenant.userId]);
  }
});

test('ADMTEN-195 a view-as token stops when its 30 minutes are over on the server too', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const { url } = await startViewAs(staff, tenant.userId, clientIp);
  const exchanged = await exchange(codeFromViewAsUrl(url), clientIp);
  expect(exchanged.status).toBe(200);
  const session = exchanged.json?.data as Record<string, unknown>;
  // No refresh token of any kind: not in the body, not as a cookie.
  expect(Object.keys(session).sort()).toEqual(['accessToken', 'expiresAt', 'tenant']);
  expect(exchanged.headers.get('set-cookie')).toBeNull();

  const token = String(session.accessToken);
  const claims = jwtClaims(token);
  expect(Number(claims.exp) - Number(claims.iat)).toBe(30 * 60);
  expect(claims).toMatchObject({
    sub: tenant.userId,
    type: 'access',
    imp: staff.account.userId,
    impSid: staff.sessionId,
    impSv: (await userRow(staff.account.userId)).session_version,
  });

  // A copy signed the same way is accepted while inside its time...
  const copy = signCustomerJwt(claims);
  expect((await customerRequest('GET', '/api/projects', { token: copy, ip: clientIp })).status).toBe(200);
  // ...and refused once its 30 minutes are over.
  const now = Math.floor(Date.now() / 1000);
  const expired = signCustomerJwt({ ...claims, iat: now - 31 * 60, exp: now - 60 });
  expect((await customerRequest('GET', '/api/projects', { token: expired, ip: clientIp })).status).toBe(401);
});

test('ADMTEN-196 a token without the staff session claim is refused', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const { url } = await startViewAs(staff, tenant.userId, clientIp);
  const token = String((((await exchange(codeFromViewAsUrl(url), clientIp)).json?.data) as { accessToken: string }).accessToken);
  const claims = jwtClaims(token);

  // With the claim, the forged copy is accepted, so the signing is right.
  expect((await customerRequest('GET', '/api/projects', { token: signCustomerJwt(claims), ip: clientIp })).status).toBe(200);

  const { impSid: _dropped, ...preSplit } = claims;
  expect(Object.keys(preSplit)).toEqual(expect.arrayContaining(['sub', 'email', 'type', 'imp', 'sv', 'impSv']));
  const refused = await customerRequest('GET', '/api/projects', { token: signCustomerJwt(preSplit), ip: clientIp });
  expect([refused.status, refused.json?.message]).toEqual([401, NO_LONGER_VALID]);
});

test('ADMTEN-197 logging out from the account menu in view-as ends only view-as', async ({ page, context, clientIp }) => {
  test.slow();
  const account = await createAccount(clientIp, 'staff', 'Sam Staff');
  const own = await createProject(account, clientIp, `Staff own ${hex()}`);
  const tabA = page;
  await signIn(tabA, account);
  await makeSuperAdmin(account.userId);
  const admin = await context.newPage();
  await enrolAndSignInStaff(admin, account);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const theirs = await createProject(tenant, clientIp, `Tenant project ${hex()}`);
  const viewAs = await openViewAsTab(admin, tenant);
  await expect(viewAs.getByText(theirs.name)).toBeVisible();

  const logouts: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/auth/logout')) logouts.push(request.url());
  });
  const toLogin = viewAs.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === '/login');
  await viewAs.getByRole('button', { name: tenant.name }).click();
  await viewAs.getByRole('menuitem', { name: 'Log out' }).click();
  await toLogin;
  // On to the staff member's own projects: they are signed in to the customer app here.
  await expect(viewAs).toHaveURL(/\/projects$/);
  await expect(viewAs.getByText(own.name)).toBeVisible();
  await expect(viewAs.getByText(theirs.name)).toHaveCount(0);
  await expect(viewAsBanner(viewAs)).toHaveCount(0);
  expect(await storedViewAs(viewAs)).toBeNull();
  expect(logouts).toEqual([]);

  await tabA.bringToFront();
  await tabA.reload();
  await expect(tabA.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(tabA.getByText(own.name)).toBeVisible();
});

test('ADMTEN-198 view-as hides account-only surfaces', async ({ page, browser, baseURL, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await createProject(tenant, clientIp, `Viewed project ${hex()}`);

  // Positive control: the tenant's own session shows both.
  const own = await newPersonContext(browser, baseURL);
  try {
    const ownPage = await own.context.newPage();
    await signIn(ownPage, tenant);
    await expect(ownPage.getByRole('link', { name: 'See plans' })).toBeVisible();
    await ownPage.getByRole('button', { name: tenant.name }).click();
    await expect(ownPage.getByRole('menuitem', { name: 'Billing' })).toBeVisible();
  } finally {
    await own.context.close();
  }

  const viewAs = await openViewAsTab(page, tenant);
  await expect(viewAs.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(viewAs.getByRole('link', { name: 'See plans' })).toHaveCount(0);
  await viewAs.getByRole('button', { name: tenant.name }).click();
  await expect(viewAs.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
  await expect(viewAs.getByRole('menuitem', { name: 'Billing' })).toHaveCount(0);
});

// ---- L. Second factor reset (staff side)

test('ADMTEN-203 tenant with factors while account email is off', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  const path = `/api/admin/tenants/${tenant.userId}/factor-reset`;
  // This stack has account email on, so the real state offers a reset.
  const real = await adminApi<{ hasFactors: boolean; emailConfigured: boolean }>('GET', path, undefined, staff.token, clientIp);
  expect(real).toMatchObject({ hasFactors: true, emailConfigured: true });

  // The card is handed the server's own answer with only `emailConfigured` turned off,
  // which is what an install without account email answers.
  let routed = 0;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { data: { emailConfigured: boolean } };
    body.data.emailConfigured = false;
    routed += 1;
    await route.fulfill({ response, json: body });
  });
  await openTenantPage(page, tenant);

  const card = secondFactorsCard(page);
  await expect(card).toContainText('Account email is not set up, so the owner cannot be warned and no reset can be started.');
  expect(routed).toBeGreaterThan(0);
  await expect(card.getByRole('button', { name: 'Reset second factors' })).toHaveCount(0);
  await expect(card).not.toContainText(RESET_INTRO);
  await expect(card).not.toContainText('This account has no second factors');
});

test('ADMTEN-205 reset card with factors and email set up', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  const [{ password_reset_at: resetAt }] = await sql<{ password_reset_at: Date }>(
    `UPDATE users SET password_reset_at = now() - interval '30 days' WHERE id = $1 RETURNING password_reset_at`,
    [tenant.userId],
  );
  await openTenantPage(page, tenant);

  const card = secondFactorsCard(page);
  await expect(card).toContainText(RESET_INTRO);
  const line = card.getByText(`Password last reset ${adminDate(resetAt, true)}.`, { exact: true });
  await expect(line).toBeVisible();
  await expect(line).toHaveClass(/text-muted-foreground/);
  await expect(line).not.toHaveClass(/text-destructive/);
  await expect(card.getByRole('button', { name: 'Reset second factors' })).toBeVisible();
  await expect(card).not.toContainText('Account email is not set up');
});

test('ADMTEN-206 reset dialog content without a recent password reset', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  const state = await adminApi<{ lastPasswordResetAt: string | null }>(
    'GET',
    `/api/admin/tenants/${tenant.userId}/factor-reset`,
    undefined,
    staff.token,
    clientIp,
  );
  expect(state.lastPasswordResetAt).toBeNull();
  const dialog = await openResetDialog(page, tenant);

  for (const text of [
    'Nothing is removed straight away.',
    'The owner is emailed now, with the time it will happen and how to cancel. The wait starts once that email has gone.',
    'It is cancelled if they sign in with a factor, cancel it in their settings, or the password is reset.',
    'Afterwards every passkey, authenticator and recovery code is gone, every device is signed out, and the password alone signs in.',
    'There is no record of a password reset on this account.',
    'Confirm who is asking by some means other than email first. For 14 days afterwards, the password cannot be reset by email or by a team admin.',
  ]) {
    await expect.soft(dialog, text.slice(0, 40)).toContainText(text);
  }
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await expect(dialog.getByLabel('Why they need it')).toBeVisible();
  const method = dialog.getByRole('combobox', { name: 'How you verified who is asking' });
  await expect(method).toHaveText('Choose one');
  await expect(dialog.getByText('Not email: whoever is asking may control the mailbox.', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('What you checked')).toBeVisible();
  await expect(dialog.getByText('0/1000 characters, at least 10. Recorded in the audit log.', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(`Type ${tenant.email} to confirm`)).toBeVisible();
  // No second justification without a recent reset.
  await expect(dialog.getByLabel('Why go ahead despite the recent password reset')).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Schedule reset' })).toBeDisabled();
});

test('ADMTEN-208 reset dialog submit rules', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  const dialog = await openResetDialog(page, tenant);
  const submit = dialog.getByRole('button', { name: 'Schedule reset' });
  const notes = dialog.getByLabel('What you checked');
  const counter = dialog.locator('#admin-action-verification-notes-count');

  // 1. Everything but the method.
  await dialog.getByLabel('Why they need it').fill('Owner lost every factor (E2E)');
  await notes.fill('Saw them on a video call, ID matched');
  await dialog.getByLabel(`Type ${tenant.email} to confirm`).fill(tenant.email);
  await expect(submit).toBeDisabled();

  // 2. A method, notes of nine characters.
  await chooseMethod(page, 'Video call');
  await notes.fill('123456789');
  await expect(submit).toBeDisabled();

  // 3. Notes over 1000 characters: the counter turns red.
  await notes.fill('n'.repeat(1001));
  await expect(counter).toHaveText('1001/1000 characters, at least 10. Recorded in the audit log.');
  await expect(counter).toHaveClass(/text-destructive/);
  await expect(submit).toBeDisabled();

  // 4. Notes valid, the confirmation in the wrong case.
  await notes.fill('Saw them on a video call, ID matched');
  await expect(counter).not.toHaveClass(/text-destructive/);
  await dialog.getByLabel(`Type ${tenant.email} to confirm`).fill(tenant.email.toUpperCase());
  await expect(submit).toBeDisabled();

  // 5. All valid.
  await dialog.getByLabel(`Type ${tenant.email} to confirm`).fill(tenant.email);
  await expect(submit).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await factorResetRows(tenant.userId)).toEqual([]);
});

test('ADMTEN-209 a recent password reset shows the warning and asks a second justification', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  const [{ password_reset_at: resetAt }] = await sql<{ password_reset_at: Date }>(
    `UPDATE users SET password_reset_at = now() - interval '2 days' WHERE id = $1 RETURNING password_reset_at`,
    [tenant.userId],
  );
  await openTenantPage(page, tenant);
  const when = adminDate(resetAt, true);
  const line = secondFactorsCard(page).getByText(`Password last reset ${when}.`, { exact: true });
  await expect(line).toHaveClass(/text-destructive/);

  await secondFactorsCard(page).getByRole('button', { name: 'Reset second factors' }).click();
  const dialog = page.getByRole('dialog', { name: RESET_DIALOG });
  await expect(dialog).toContainText(`The password was last reset ${when}.`);
  await expect(dialog.getByRole('alert')).toHaveText(
    'That was within the last 14 days. Whoever reset it controls the mailbox and may not be the owner: removing the factors as well would hand them the account.',
  );
  const second = dialog.getByLabel('Why go ahead despite the recent password reset');
  await expect(second).toBeVisible();
  await expect(dialog.locator('#admin-action-second-reason-hint')).toHaveText(
    'Recorded in the audit log and shown with the pending reset. 0/500 characters, at least 10.',
  );

  await dialog.getByLabel('Why they need it').fill('Owner lost every factor (E2E)');
  await chooseMethod(page, 'Video call');
  await dialog.getByLabel('What you checked').fill('Saw them on a video call, ID matched');
  await dialog.getByLabel(`Type ${tenant.email} to confirm`).fill(tenant.email);
  const submit = dialog.getByRole('button', { name: 'Schedule reset' });
  await expect(submit).toBeDisabled();
  await second.fill('   123456789   ');
  await expect(submit).toBeDisabled();
  await second.fill('Owner on video again');
  await expect(submit).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await factorResetRows(tenant.userId)).toEqual([]);
});

test('ADMTEN-211 warning email not sent yet', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  // The worker retries unsent warnings; this owner's mail keeps failing, so it stays unsent.
  await failStub('platform-brevo', { status: 500, times: 50, match: tenant.email });
  await seedPendingFactorReset({
    userId: tenant.userId,
    requestedBy: { userId: staff.account.userId, email: staff.account.email },
    reason: 'Owner lost their phone (E2E 211)',
    noticeSent: false,
    verificationNotes: 'Called the number on their invoice',
  });
  await openTenantPage(page, tenant);

  const card = secondFactorsCard(page);
  await expect(card.getByRole('alert')).toHaveText(
    'The warning email to the owner has not gone out yet, so the wait has not started and nothing will be removed. It is retried every few minutes; check account email in platform health.',
  );
  await expect(card).not.toContainText('Reset scheduled for');
  await expect(card).toContainText(`Requested by ${staff.account.email} on`);
  await expect(card).toContainText('Owner lost their phone (E2E 211)');
  await expect(card).toContainText('Identity checked by video call:');
  await expect(card).toContainText('Called the number on their invoice');
  await expect(card.getByRole('button', { name: 'Cancel reset' })).toBeVisible();
});

test('ADMTEN-212 pending reset details render as text', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await seedPendingFactorReset({
    userId: tenant.userId,
    requestedBy: { userId: staff.account.userId, email: staff.account.email },
    reason: '<b>x</b>\nsecond line',
    verificationMethod: 'government_id',
    verificationNotes: '<script>alert(1)</script>',
    passwordResetOverride: 'Owner on video, ID matched',
  });
  await openTenantPage(page, tenant);

  const card = secondFactorsCard(page);
  await expect(card).toContainText('Reset scheduled for');
  const texts = card.locator('p.whitespace-pre-wrap');
  await expect(texts).toHaveCount(3);
  expect(await texts.nth(0).innerText()).toBe('<b>x</b>\nsecond line');
  await expect(card).toContainText('Identity checked by government id:');
  expect(await texts.nth(1).innerText()).toBe('<script>alert(1)</script>');
  await expect(card).toContainText('Started although the password had been reset recently, because:');
  expect(await texts.nth(2).innerText()).toBe('Owner on video, ID matched');
  await expect(card.locator('b')).toHaveCount(0);
  await expect(card.locator('script')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('ADMTEN-215 cancelling when nothing is waiting', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  const resetId = await seedPendingFactorReset({
    userId: tenant.userId,
    requestedBy: { userId: staff.account.userId, email: staff.account.email },
  });
  await openTenantPage(page, tenant);
  const card = secondFactorsCard(page);
  await expect(card.getByRole('button', { name: 'Cancel reset' })).toBeVisible();

  // The owner cancels it after the page loaded.
  await sql(`UPDATE factor_resets SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'owner' WHERE id = $1`, [resetId]);
  await card.getByRole('button', { name: 'Cancel reset' }).click();
  await expect(adminToast(page, 'Could not cancel')).toBeVisible();
  await expect(adminToast(page, 'No reset is waiting for this account.')).toBeVisible();
  // The card is read again and shows there is nothing waiting.
  await expect(card).toContainText(RESET_INTRO);
  await expect(card.getByRole('button', { name: 'Cancel reset' })).toHaveCount(0);
  expect(await factorResetRows(tenant.userId)).toMatchObject([{ id: resetId, status: 'cancelled', cancelled_by: 'owner' }]);

  const none = await adminRequest('DELETE', `/api/admin/tenants/${tenant.userId}/factor-reset`, { token: staff.token, ip: clientIp });
  expect([none.status, none.json?.message]).toEqual([409, 'No reset is waiting for this account.']);
  const missing = await adminRequest('DELETE', `/api/admin/tenants/${randomUUID()}/factor-reset`, { token: staff.token, ip: clientIp });
  expect([missing.status, missing.json?.message]).toEqual([404, 'Tenant not found']);
});

test('ADMTEN-217 request validation', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await tenantWithFactor();
  const path = `/api/admin/tenants/${tenant.userId}/factor-reset`;
  const methods =
    'verificationMethod must be one of the following values: video_call, government_id, phone_call_known_number, billing_record, other';
  const { verificationMethod: _method, ...noMethod } = RESET_BODY;
  const cases: { body: unknown; expected: string }[] = [
    { body: noMethod, expected: methods },
    { body: { ...RESET_BODY, verificationMethod: 'email' }, expected: methods },
    { body: { ...RESET_BODY, verificationNotes: '  123456789  ' }, expected: 'verificationNotes must be longer than or equal to 10 characters' },
    { body: { ...RESET_BODY, verificationNotes: 'n'.repeat(1001) }, expected: 'verificationNotes must be shorter than or equal to 1000 characters' },
    {
      body: { ...RESET_BODY, recentResetJustification: '123456789' },
      expected: 'recentResetJustification must be longer than or equal to 10 characters',
    },
    {
      body: { ...RESET_BODY, recentResetJustification: 'j'.repeat(501) },
      expected: 'recentResetJustification must be shorter than or equal to 500 characters',
    },
    { body: { ...RESET_BODY, reason: 'too short' }, expected: 'reason must be longer than or equal to 10 characters' },
    {
      body: { ...RESET_BODY, verificationNotes: 'Saw them on a\u0000 video call' },
      expected: 'verificationNotes must not contain null characters',
    },
  ];
  for (const { body, expected } of cases) {
    const response = await adminRequest('POST', path, { token: staff.token, ip: clientIp, body });
    expect.soft(response.status, expected).toBe(400);
    expect.soft(messagesOf(response.json), expected).toContain(expected);
  }
  expect(await factorResetRows(tenant.userId)).toEqual([]);
  expect(await auditRows({ action: 'account.factors_reset_requested', targetId: tenant.userId })).toEqual([]);
});

test('ADMTEN-221 staff without a factor of their own cannot start a reset', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const withFactor = await tenantWithFactor();
  const noFactor = await createAccount(newClientIp(), 'tenant', 'Nia Nofactor');
  // Positive control: while the staff member holds a passkey the request reaches the later checks.
  const reached = await adminRequest('POST', `/api/admin/tenants/${noFactor.userId}/factor-reset`, {
    token: staff.token,
    ip: clientIp,
    body: RESET_BODY,
  });
  expect([reached.status, reached.json?.message]).toEqual([409, 'This account has no second factors to reset.']);

  const removed = await sql(`DELETE FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff' RETURNING id`, [staff.account.userId]);
  expect(removed.length).toBeGreaterThan(0);

  for (const target of [withFactor, noFactor]) {
    const response = await adminRequest('POST', `/api/admin/tenants/${target.userId}/factor-reset`, {
      token: staff.token,
      ip: clientIp,
      body: RESET_BODY,
    });
    expect.soft([response.status, response.json?.message], target.email).toEqual([
      403,
      'Add a passkey to your account before starting a factor reset.',
    ]);
  }
  expect(await factorResetRows(withFactor.userId)).toEqual([]);
  expect(await auditRows({ action: 'account.factors_reset_requested', actorId: staff.account.userId })).toEqual([]);
});

// ---- M. Coverage review additions

test('ADMTEN-225 search treats a backslash literally', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const t = randomBytes(4).toString('hex');
  const [slashed, plain] = await insertTenants([
    { label: `bs${t}`, name: `a\\b ${t}` },
    { label: `nb${t}`, name: `ab ${t}` },
  ]);
  const search = async (value: string) => {
    const response = await adminRequest('GET', `/api/admin/tenants?limit=100&search=${encodeURIComponent(value)}`, {
      token: staff.token,
      ip: clientIp,
    });
    expect(response.status).toBe(200);
    return (response.json as { data: { id: string }[] }).data.map((row) => row.id);
  };

  const hits = await search('a\\b');
  expect(hits).toContain(slashed.id);
  expect(hits).not.toContain(plain.id);
  // With the token: exactly one row. Read as a LIKE escape, `a\b <token>` would be `ab <token>`.
  expect(await search(`a\\b ${t}`)).toEqual([slashed.id]);

  await page.goto(adminUrl('/tenants'));
  await page.getByPlaceholder('Search by email or name...').fill(`a\\b ${t}`);
  await expect.poll(() => urlParams(page).search).toBe(`a\\b ${t}`);
  expect(page.url()).toContain('search=a%5Cb');
  await expect.poll(() => listedEmails(page)).toEqual([slashed.email]);
});

test('ADMTEN-227 snapshot-only usage is not "usage" for Last usage, Quiet or Never used', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const t = term('snap');
  const [k, m, f] = await insertTenants([
    { label: `${t}-k`, name: 'Kay Keys' },
    { label: `${t}-m`, name: 'Max Mau' },
    { label: `${t}-f`, name: 'Fay Failed' },
  ]);
  const through = utcDay(-1);
  const failedDay = utcDay(-21);
  const rows: UsageSeed[] = [
    { projectId: randomUUID(), ownerId: k.id, day: through, metric: 'api_keys_active', value: 3 },
    { projectId: randomUUID(), ownerId: m.id, day: through, metric: 'mau_month_to_date', value: 7 },
    { projectId: randomUUID(), ownerId: f.id, day: failedDay, metric: 'messages_failed', value: 5 },
  ];
  await withUsage(FIRST_MONTH_STATE(), rows, async () => {
    await page.goto(adminUrl(`/tenants?search=${t}`));
    await expect.poll(() => listedEmails(page)).toEqual([k.email, m.email, f.email]);
    const cells = (email: string) => rowOf(page, email).getByRole('cell');
    const expectUsage = async (email: string, mau: string, messages: string, last: string) => {
      await expect.soft(cells(email).nth(4), `${email} mau`).toHaveText(mau);
      await expect.soft(cells(email).nth(5), `${email} messages`).toHaveText(messages);
      await expect.soft(cells(email).nth(6), `${email} last usage`).toHaveText(last);
    };
    await expectUsage(k.email, '0', '0', 'None');
    await expectUsage(m.email, '7', '0', 'None');
    await expectUsage(f.email, '0', '0', usageDay(failedDay));

    const chips = page.getByRole('group', { name: 'Filter by activity' });
    await chips.getByRole('button', { name: 'Never used', exact: true }).click();
    await expect.poll(() => listedEmails(page)).toEqual([k.email, m.email]);
    await chips.getByRole('button', { name: 'Quiet', exact: true }).click();
    await expect.poll(() => listedEmails(page)).toEqual([f.email]);

    const exported = await adminRequest('GET', `/api/admin/tenants/export?search=${t}`, { token: staff.token, ip: clientIp });
    expect(exported.status).toBe(200);
    const [header, ...records] = parseCsv(exported.text.replace(/^﻿/, ''));
    const column = (name: string) => header.indexOf(name);
    const record = (id: string) => records.find((cells) => cells[column('tenant_id')] === id) ?? [];
    for (const [tenant, mau] of [
      [k, '0'],
      [m, '7'],
    ] as const) {
      expect.soft(record(tenant.id)[column('last_usage_day')], tenant.email).toBe('');
      expect.soft(record(tenant.id)[column('messages_sent_30d')], tenant.email).toBe('0');
      expect.soft(record(tenant.id)[column('mau_this_month')], tenant.email).toBe(mau);
    }
    expect(record(f.id)[column('last_usage_day')]).toBe(failedDay);
    expect(record(f.id)[column('messages_sent_30d')]).toBe('0');

    const overview = await openOverview(page);
    const top = overview.topTenants.find((tenant) => tenant.id === m.id);
    expect(top).toMatchObject({ mauThisMonth: 7, messagesSent30d: 0 });
    expect(overview.topTenants.map((tenant) => tenant.id)).not.toContain(k.id);
    expect(overview.topTenants.map((tenant) => tenant.id)).not.toContain(f.id);
    expect(overview.quietTenants.tenants.map((tenant) => tenant.id)).toContain(f.id);
    expect(overview.quietTenants.tenants.map((tenant) => tenant.id)).not.toContain(k.id);
    expect(overview.quietTenants.tenants.map((tenant) => tenant.id)).not.toContain(m.id);

    const topCard = cardTitled(page, 'Top tenants');
    await expect(topCard.locator('tbody tr').filter({ hasText: m.email }).getByRole('cell')).toHaveText([`${m.email}${m.name}`, '7', '0']);
    await expect(topCard.getByText(k.email, { exact: true })).toHaveCount(0);
    await expect(topCard.getByText(f.email, { exact: true })).toHaveCount(0);
    const quietCard = cardTitled(page, 'Going quiet');
    await expect(quietCard.locator('tbody tr').filter({ hasText: f.email }).getByRole('cell')).toHaveText([
      `${f.email}${f.name}`,
      `last usage ${usageShortDay(failedDay)}`,
    ]);
    await expect(quietCard.getByText(k.email, { exact: true })).toHaveCount(0);
    await expect(quietCard.getByText(m.email, { exact: true })).toHaveCount(0);
  });
});

test('ADMTEN-229 Top tenants and Going quiet include suspended tenants and super admins', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [x, y, z] = await insertTenants([
    { label: 'susp-x', name: 'Xan Suspended' },
    { label: 'staff-y', name: 'Yas Staff' },
    { label: 'susp-z', name: 'Zed Quiet' },
  ]);
  await sql(`UPDATE users SET suspended_at = now(), suspended_reason = 'E2E: suspended' WHERE id = ANY($1::uuid[])`, [[x.id, z.id]]);
  await makeSuperAdmin(y.id);
  const through = utcDay(-1);
  const quietDay = utcDay(-21);
  const rows: UsageSeed[] = [
    { projectId: randomUUID(), ownerId: x.id, day: through, metric: 'push_sent', value: 100 },
    { projectId: randomUUID(), ownerId: y.id, day: through, metric: 'mau_month_to_date', value: 50 },
    { projectId: randomUUID(), ownerId: z.id, day: quietDay, metric: 'events', value: 10 },
  ];
  await withUsage(COUNTED_STATE(), rows, async () => {
    const body = await openOverview(page);
    expect(body.topTenants.find((tenant) => tenant.id === x.id)).toMatchObject({ messagesSent30d: 100, mauThisMonth: 0 });
    expect(body.topTenants.find((tenant) => tenant.id === y.id)).toMatchObject({ mauThisMonth: 50, messagesSent30d: 0 });
    expect(body.quietTenants.tenants.map((tenant) => tenant.id)).toContain(z.id);
    expect(body.quietTenants.count).toBeGreaterThanOrEqual(body.quietTenants.tenants.length);

    const topCard = cardTitled(page, 'Top tenants');
    const topRow = (tenant: { email: string }) => topCard.locator('tbody tr').filter({ hasText: tenant.email }).getByRole('cell');
    // No status or staff marker beside them.
    await expect(topRow(x)).toHaveText([`${x.email}${x.name}`, '0', '100']);
    await expect(topRow(y)).toHaveText([`${y.email}${y.name}`, '50', '0']);
    const quietCard = cardTitled(page, 'Going quiet');
    await expect(quietCard.locator('tbody tr').filter({ hasText: z.email }).getByRole('cell')).toHaveText([
      `${z.email}${z.name}`,
      `last usage ${usageShortDay(quietDay)}`,
    ]);
    await expect(quietCard.locator('[data-slot="card-description"]')).toHaveText(
      `${body.quietTenants.count} ${body.quietTenants.count === 1 ? 'tenant' : 'tenants'} with no usage in 14 days`,
    );

    await topCard.getByRole('link', { name: x.email, exact: true }).click();
    await expect(page).toHaveURL(adminUrl(`/tenants/${x.id}`));
    await expect(page.getByText('suspended', { exact: true })).toBeVisible();
  });
});

test('ADMTEN-230 overview usage tiles when fewer than 30 days are counted', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [owner] = await insertTenants([{ label: 'five-days', name: 'Five Days' }]);
  const d = utcDay(-1);
  const counted = [-4, -3, -2, -1, 0].map((offset) => utcDay(-1 + offset));
  const project = randomUUID();
  const rows: UsageSeed[] = [
    ...counted.map((day) => ({ projectId: project, ownerId: owner.id, day, metric: 'push_sent', value: 10 })),
    { projectId: project, ownerId: owner.id, day: utcDay(-11), metric: 'push_sent', value: 100 },
  ];
  await withUsage({ startedOn: counted[0], firstDay: counted[0], lastClosedDay: d }, rows, async () => {
    const { body, measured: others } = await stableOverview(
      page,
      () => page.goto(adminUrl('/')),
      () => usageSums(counted[0], d, [owner.id]),
    );
    const expected = 50 + (others.push_sent ?? 0);
    expect(body.usage30d?.push_sent).toBe(expected);
    expect(body.usageTrend.map((point) => point.date)).toEqual(counted);

    await expect(page.getByRole('heading', { name: 'Usage, last 30 days' })).toBeVisible();
    await expect(statValue(page, 'Push sent')).toHaveText(fmt(expected));
    await expect(statCaption(page, 'Push sent')).toHaveText('Last 30 counted days');
    const chart = cardTitled(page, 'Usage per day');
    await chart.getByText('View as table', { exact: true }).click();
    await expect(chart.locator('tbody tr')).toHaveCount(5);
  });
});

test('ADMTEN-241 view-as refused because the tenant was suspended after the page loaded', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await expect(page.getByText('active', { exact: true })).toBeVisible();
  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { reason: 'E2E: suspended behind the page' }, staff.token, clientIp);

  await page.getByRole('button', { name: 'View as tenant' }).click();
  const start = page.getByRole('dialog', { name: 'View as this tenant?' });
  await start.getByLabel('Reason').fill('Ticket 241: checking setup');
  await start.getByRole('button', { name: 'Start read-only session' }).click();
  await expect(start.getByRole('alert')).toHaveText('Suspended tenants cannot be impersonated');
  await expect(page.getByRole('dialog', { name: `View as ${tenant.email}` })).toHaveCount(0);

  await start.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('suspended', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View as tenant' })).toBeDisabled();
  await expect(page.getByText('Suspended tenants cannot be viewed as. Reactivate the account first.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reactivate' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
  expect(await handoffRows({ targetId: tenant.userId })).toHaveLength(0);
  expect(await auditRows({ action: 'tenant.impersonated', targetId: tenant.userId })).toHaveLength(0);
});

test('ADMTEN-242 view-as refused because the tenant was made a super admin after the page loaded', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await expect(secondFactorsCard(page)).toBeVisible();
  await makeSuperAdmin(tenant.userId);
  try {
    await page.getByRole('button', { name: 'View as tenant' }).click();
    const start = page.getByRole('dialog', { name: 'View as this tenant?' });
    await start.getByLabel('Reason').fill('Ticket 242: checking setup');
    await start.getByRole('button', { name: 'Start read-only session' }).click();
    await expect(start.getByRole('alert')).toHaveText('Super admins cannot be impersonated');
    await expect(page.getByRole('dialog', { name: `View as ${tenant.email}` })).toHaveCount(0);

    await start.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Super admin', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View as tenant' })).toBeDisabled();
    await expect(page.getByText('Super admins cannot be viewed as.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Suspend' })).toBeDisabled();
    await expect(page.getByText('Super admins cannot be suspended.', { exact: true })).toBeVisible();
    await expect(secondFactorsCard(page)).toHaveCount(0);
    expect(await handoffRows({ targetId: tenant.userId })).toHaveLength(0);
  } finally {
    await sql(`UPDATE users SET is_super_admin = false WHERE id = $1`, [tenant.userId]);
  }
});

test('ADMTEN-248 a staff session past its absolute end ends view-as', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const { url } = await startViewAs(staff, tenant.userId, clientIp);
  const token = String((((await exchange(codeFromViewAsUrl(url), clientIp)).json?.data) as { accessToken: string }).accessToken);
  expect((await customerRequest('GET', '/api/projects', { token, ip: clientIp })).status).toBe(200);
  const [handoff] = await handoffRows({ targetId: tenant.userId });
  expect(handoff.staff_session_id).toBe(staff.sessionId);

  // Far past any configured maximum session length.
  await sql(`UPDATE staff_sessions SET created_at = now() - interval '30 days' WHERE id = $1`, [handoff.staff_session_id]);
  const refused = await customerRequest('GET', '/api/projects', { token, ip: clientIp });
  expect([refused.status, refused.json?.message]).toEqual([401, NO_LONGER_VALID]);
});

test('ADMTEN-249 staff idleness alone does not end view-as, but the idle sign-out does', async ({ page, baseURL, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${hex()}`);
  const viewAs = await openViewAsTab(page, tenant);
  await expect(viewAs.getByText(project.name)).toBeVisible();
  const token = String((await storedViewAs(viewAs))?.accessToken);
  // The admin tab leaves its page so nothing it sends meanwhile ends the session early.
  await page.goto('about:blank');

  // Idle well past any idle timeout, while still inside the session's absolute end.
  await sql(`UPDATE staff_sessions SET last_active_at = now() - interval '1 day' WHERE id = $1`, [staff.sessionId]);
  const during = await customerRequest('GET', '/api/projects', { token, ip: clientIp });
  expect(during.status).toBe(200);
  await viewAs.reload();
  await expect(viewAs.getByText(project.name)).toBeVisible();
  await expect(viewAsBanner(viewAs)).toBeVisible();

  // The admin app's next load finds the session idle and ends it.
  await page.goto(adminUrl(`/tenants/${tenant.userId}`));
  await expect(page.getByText('Signed out after a period of inactivity.')).toBeVisible();
  const [row] = await sql<{ revoked_at: Date | null }>(`SELECT revoked_at FROM staff_sessions WHERE id = $1`, [staff.sessionId]);
  expect(row.revoked_at).not.toBeNull();

  const after = await customerRequest('GET', '/api/projects', { token, ip: clientIp });
  expect([after.status, after.json?.message]).toEqual([401, NO_LONGER_VALID]);
  await viewAs.bringToFront();
  const leaving = leavingFor(viewAs, tenant.userId);
  await viewAs.getByText(project.name).click();
  await leaving;
  // The staff session is gone, so the admin app asks for a sign-in there.
  await expect(viewAs).toHaveURL(new RegExp(`^${escapeRegExp(adminUrl('/sign-in'))}`));
  await viewAs.goto(`${baseURL}/logo.svg`);
  expect(await viewAs.evaluate(() => sessionStorage.getItem('chumbaq_impersonation'))).toBeNull();
});

test('ADMTEN-250 a corrupt view-as record is dropped silently', async ({ page, browser, baseURL, clientIp }) => {
  const own = await createAccount(clientIp, 'own', 'Owen Own');
  const ownProject = await createProject(own, clientIp, `Own project ${hex()}`);
  const future = new Date(Date.now() + 20 * 60_000).toISOString();
  const records = [
    'not json',
    JSON.stringify({ tenant: { id: randomUUID() }, expiresAt: future }),
    JSON.stringify({ accessToken: 'x', expiresAt: future }),
  ];
  const watch = (tab: Page) => {
    const authorizations = recordAuthorizations(tab);
    const adminVisits: string[] = [];
    tab.on('request', (request) => {
      if (request.isNavigationRequest() && request.url().startsWith(adminUrl(''))) adminVisits.push(request.url());
    });
    return { authorizations, adminVisits };
  };

  // Signed in to the customer app as themselves: they carry on as themselves.
  await signIn(page, own);
  const signedIn = watch(page);
  for (const record of records) {
    await writeStoredViewAs(page, record);
    await page.goto('/projects');
    await expect.soft(page.getByText(ownProject.name), record).toBeVisible();
    await expect.soft(viewAsBanner(page), record).toHaveCount(0);
    expect.soft(await storedViewAs(page).catch(() => 'unreadable'), record).toBeNull();
  }
  expect(signedIn.authorizations.length).toBeGreaterThan(0);
  expect(signedIn.authorizations).not.toContain('Bearer x');
  expect(signedIn.adminVisits).toEqual([]);

  // Signed out: the sign-in page.
  const fresh = await newPersonContext(browser, baseURL);
  try {
    const tab = await fresh.context.newPage();
    const signedOut = watch(tab);
    for (const record of records) {
      await writeStoredViewAs(tab, record);
      await tab.goto('/projects');
      await expect.soft(tab, record).toHaveURL(/\/login/);
      await expect.soft(viewAsBanner(tab), record).toHaveCount(0);
      expect.soft(await tab.evaluate(() => sessionStorage.getItem('chumbaq_impersonation')), record).toBeNull();
    }
    expect(signedOut.authorizations).toEqual([]);
    expect(signedOut.adminVisits).toEqual([]);
  } finally {
    await fresh.context.close();
  }
});

test('ADMTEN-251 a view-as record with an unparseable expiry ends at once', async ({ page, context, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const { url } = await startViewAs(staff, tenant.userId, clientIp);
  const token = String((((await exchange(codeFromViewAsUrl(url), clientIp)).json?.data) as { accessToken: string }).accessToken);

  const runs = [
    { id: tenant.userId, target: adminUrl(`/tenants/${tenant.userId}`) },
    { id: '../../evil?x=1', target: adminUrl('/tenants/..%2F..%2Fevil%3Fx%3D1') },
  ];
  for (const run of runs) {
    const tab = await context.newPage();
    const authorizations = recordAuthorizations(tab);
    await writeStoredViewAs(tab, JSON.stringify({ accessToken: token, tenant: { id: run.id, email: 't@x' }, expiresAt: 'not-a-date' }));
    const leaving = tab.waitForRequest((request) => request.isNavigationRequest() && request.url().startsWith(adminUrl('')));
    await tab.goto('/projects');
    const navigation = await leaving;
    expect.soft(navigation.url(), run.id).toBe(run.target);
    expect.soft(authorizations, run.id).not.toContain(`Bearer ${token}`);
    await tab.goto('/logo.svg');
    expect.soft(await tab.evaluate(() => sessionStorage.getItem('chumbaq_impersonation')), run.id).toBeNull();
    await tab.close();
  }
});

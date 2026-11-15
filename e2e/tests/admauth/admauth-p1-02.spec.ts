import { randomUUID } from 'crypto';
import type { BrowserContext, Page, Response } from '@playwright/test';
import { adminUrl } from '../../support/admin';
import { createAccount } from '../../support/api';
import { addAuthenticator, totpCode } from '../../support/factors';
import { expect, test } from '../../support/fixtures';
import {
  accountTokenUsedAt,
  addPasskeyByApi,
  attestWithKeysAside,
  auditRows,
  auditTrail,
  authEvents,
  authEventsFromIp,
  browserAssertion,
  challengeKey,
  cookieValue,
  enrolmentCodeFromCli,
  enrolPasskeyByApi,
  enrolStaffPasskey,
  enrolStaffTotpOnly,
  forwardPrefixToAdminApi,
  forwardToAdminApi,
  freshTotpCode,
  jwtClaims,
  makeStaff,
  reauthWithPasskey,
  recoveryCodeCount,
  redisDel,
  redisExists,
  seedCustomerPasskeyRow,
  seedRecoveryCodeRow,
  seedSecondFactorAttempts,
  seedStaffPasskeyRow,
  seedStaffResetLink,
  setAsideKeysForRegistration,
  signInAttempts,
  signInStaffInPage,
  sql,
  staffApi,
  staffCookiePair,
  staffHandle,
  staffPasskeySignIn,
  staffSession,
  staffWithPasskeyAndApp,
  startAdminApiWith,
  startPasskeyRequiredAdminApi,
  tokenHash,
  type ExtraAdminApi,
} from '../../support/areas/admauth';

/**
 * Staff on the admin app, second P1 chunk: the router's gate and the layout, the API
 * client's refresh and re-authentication dialog, /account's session summary and sign-in
 * methods, and staff tokens.
 *
 * The lane's admin API runs with passkeys not required for staff. The cases for
 * production's setting, and for a server with billing off, start a second admin API on
 * the same database and send chosen requests of the page there.
 */

const ENDED = 'Your staff session has ended. Sign in again.';
const REAUTH = 'Confirm it is you to continue.';
const LAST_FACTOR = 'Add another sign-in method before removing this one.';
const CODE_REFUSED = 'That code is not right. Please try again.';
const PROMPT_CANCELLED = 'The passkey request was cancelled or timed out. Please try again.';
const NOT_VERIFIED = 'Could not verify that passkey.';
const NOT_RECOGNISED = 'That passkey is not recognised.';
const TOO_SLOW = 'That took too long. Please try again.';
const TOO_MANY = 'Too many failed attempts. Try again in a few minutes.';
const SAME_DEVICE = 'This device already holds a passkey for this account.';
const REFRESH = '/api/staff/auth/session/refresh';
const PROOF = 'staff-factor-change-proof';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pathOf = (url: string) => new URL(url).pathname;
const isStaffCall = (pathname: string, method?: string) => (response: Response) =>
  pathOf(response.url()) === pathname && (!method || response.request().method() === method);

function watchRequests(page: Page, pathname: string, method?: string): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (pathOf(request.url()) === pathname && (!method || request.method() === method)) seen.push(request.url());
  });
  return seen;
}

function watchResponses(page: Page, pathname: string, method?: string): Response[] {
  const seen: Response[] = [];
  page.on('response', (response) => {
    if (pathOf(response.url()) === pathname && (!method || response.request().method() === method)) seen.push(response);
  });
  return seen;
}

async function browserStaffCookie(context: BrowserContext): Promise<string | null> {
  const cookie = (await context.cookies(adminUrl('/'))).find((c) => /^(__Host-)?chumbaq_staff_refresh$/.test(c.name));
  return cookie ? `${cookie.name}=${cookie.value}` : null;
}

async function passwordStep(page: Page, email: string, password: string): Promise<Response> {
  await page.goto(adminUrl('/sign-in'));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/login')),
    page.getByRole('button', { name: 'Continue' }).click(),
  ]);
  return response;
}

/** In-app navigation, as the router's own links make (no page load). */
async function navigateInApp(page: Page, pathname: string): Promise<void> {
  await page.evaluate((target) => {
    history.pushState({}, '', target);
    dispatchEvent(new PopStateEvent('popstate'));
  }, pathname);
}

const sidebarLink = (page: Page, name: string) =>
  page.locator('[data-sidebar="sidebar"]').getByRole('link', { name, exact: true });

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });

const passkeyRow = (page: Page, name: string) => page.locator('li').filter({ has: page.getByText(name, { exact: true }) });

const reauthDialog = (page: Page) => page.getByRole('dialog', { name: 'Confirm it is you' });

const toastText = (page: Page, text: string) => page.getByText(text, { exact: true }).first();

const staffKeyCount = async (userId: string) =>
  Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`, [userId]))[0].n);

const totpRow = async (userId: string) =>
  (await sql<{ confirmed_at: Date | null }>(`SELECT confirmed_at FROM totp_secrets WHERE user_id = $1`, [userId]))[0];

const staffKeyId = async (userId: string, name?: string) =>
  (
    await sql<{ id: string }>(
      `SELECT id FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'${name ? ' AND name = $2' : ''} ORDER BY created_at`,
      name ? [userId, name] : [userId],
    )
  )[0].id;

/** Waits until the current authenticator step has at least `seconds` left, so a typed code stays good. */
async function roomInStep(seconds: number): Promise<void> {
  while (30 - ((Date.now() / 1000) % 30) < seconds) await new Promise((resolve) => setTimeout(resolve, 500));
}

/** Time and day as date-fns 'HH:mm' and 'd MMM' (and the year) in the browser's zone. */
function inZone(iso: string, timeZone: string): { time: string; dayMonth: string; full: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const dayMonth = `${Number(get('day'))} ${MONTHS[Number(get('month')) - 1]}`;
  return { time: `${get('hour')}:${get('minute')}`, dayMonth, full: `${dayMonth} ${get('year')}` };
}

/** The password step and the authenticator code on /sign-in, waiting for Overview. */
async function signInWithCodeInPage(page: Page, staff: { email: string; password: string }, code: string): Promise<void> {
  const login = await passwordStep(page, staff.email, staff.password);
  expect(login.status()).toBe(200);
  await page.getByLabel('Code from your authenticator app').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(adminUrl('/'));
}

/**
 * Holds the first request of each of these paths until all of them have arrived (or 10 s
 * pass), then answers each with `answer`; later requests pass through. Records every
 * request's bearer by path.
 */
async function refuseFirstTogether(
  page: Page,
  paths: string[],
  answer: { status: number; message: string },
): Promise<Record<string, string[]>> {
  const bearers: Record<string, string[]> = Object.fromEntries(paths.map((p) => [p, []]));
  let arrived = 0;
  let allArrived!: () => void;
  const together = new Promise<void>((resolve) => (allArrived = resolve));
  await page.route(
    (url) => paths.includes(url.pathname),
    async (route) => {
      const pathname = pathOf(route.request().url());
      bearers[pathname].push((await route.request().allHeaders())['authorization'] ?? '');
      if (bearers[pathname].length > 1) return route.fallback();
      if (++arrived === paths.length) allArrived();
      await Promise.race([together, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      await route.fulfill({
        status: answer.status,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: answer.status, message: answer.message }),
      });
    },
  );
  return bearers;
}

// ---- Gate and routing

test('ADMAUTH-103 signed-in staff are sent away from /sign-in and /enrol', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();

  await page.goto(adminUrl('/sign-in'));
  await expect(page).toHaveURL(adminUrl('/'));
  await expect(heading(page, 'Overview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);

  await page.goto(adminUrl('/enrol'));
  await expect(page).toHaveURL(adminUrl('/account'));
  await expect(heading(page, 'Your account')).toBeVisible();
  await expect(page.getByLabel('Passkey name')).toHaveCount(0);
});

test('ADMAUTH-104 an enrolment session is held on /enrol', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const login = await passwordStep(page, staff.email, staff.password);
  expect(((await login.json()) as { data: { step: string } }).data.step).toBe('enrol');
  await expect(page).toHaveURL(adminUrl('/enrol'));
  // A page load would drop this marker (and the session's in-memory token with it).
  await page.evaluate(() => ((window as unknown as { __e2eSamePage: number }).__e2eSamePage = 1));

  for (const pathname of ['/', '/account', '/sign-in', '/tenants']) {
    await navigateInApp(page, pathname);
    await expect(page, pathname).toHaveURL(adminUrl('/enrol'));
    await expect(page.getByLabel('Passkey name')).toBeVisible();
  }
  expect(await page.evaluate(() => (window as unknown as { __e2eSamePage?: number }).__e2eSamePage)).toBe(1);

  // A typed address is a page load: the enrolment token is gone.
  await page.goto(adminUrl('/account'));
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
});

test('ADMAUTH-105 unknown paths go to Overview', async ({ page, clientIp }) => {
  await page.goto(adminUrl('/does-not-exist'));
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();

  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  for (const pathname of ['/does-not-exist', '/tenants/x/y/z']) {
    const entries = await page.evaluate(() => history.length);
    await page.goto(adminUrl(pathname));
    await expect(page, pathname).toHaveURL(adminUrl('/'));
    await expect(heading(page, 'Overview')).toBeVisible();
    expect(await page.evaluate(() => history.length), pathname).toBe(entries + 1);
  }
});

test('ADMAUTH-107 unreachable screen when /me fails after a good refresh', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);

  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(adminUrl('/api/staff/auth/me'), async (route) => {
    calls++;
    if (calls === 1) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) });
      return;
    }
    if (calls === 2) await held;
    await route.fallback();
  });
  const refreshes = watchResponses(page, REFRESH);

  await page.reload();
  const alert = page.getByRole('alert');
  await expect(alert.getByText('Could not reach the admin API.', { exact: true })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
  expect(refreshes.map((r) => r.status())).toEqual([200]);

  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.animate-spin')).toBeVisible();
  release();
  await expect(heading(page, 'Overview')).toBeVisible();
  await expect(page).toHaveURL(adminUrl('/'));
  expect(calls).toBe(2);
  // The second restore used the token the first refresh left in memory.
  expect(refreshes).toHaveLength(1);
});

// ---- AdminLayout and sign out

test('ADMAUTH-110 sidebar, header and footer of a full session', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();

  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const home = sidebar.locator('[data-sidebar="header"]').getByRole('link');
  await expect(home).toHaveText(/Chumbaq\s*Super Admin/);
  await expect(home).toHaveAttribute('href', '/');
  const group = sidebar.locator('[data-sidebar="group"]');
  await expect(group.locator('[data-sidebar="group-label"]')).toHaveText('Platform');
  const links = group.getByRole('link');
  await expect(links).toHaveText(['Overview', 'Tenants', 'Billing', 'Plans', 'Audit log', 'Incidents', 'Platform health', 'Your account']);
  const hrefs = await links.evaluateAll((elements) => elements.map((e) => e.getAttribute('href')));
  expect(hrefs).toEqual(['/', '/tenants', '/billing', '/plans', '/audit-log', '/incidents', '/health', '/account']);
  const footer = sidebar.locator('[data-sidebar="footer"]');
  await expect(footer.getByText(staff.email, { exact: true })).toBeVisible();
  await expect(footer.getByRole('button', { name: 'Sign out' })).toBeVisible();

  const header = page.locator('header');
  await expect(header.getByRole('button', { name: 'Toggle Sidebar' })).toBeVisible();
  await expect(header.getByText('Super Admin', { exact: true })).toBeVisible();
  await expect(header.getByRole('navigation', { name: 'breadcrumb' })).toHaveText('Overview');
  await expect(header.getByText('Staff only. Actions here apply across all tenants.', { exact: true })).toBeVisible();
});

test('ADMAUTH-115 sign out works when the API cannot be reached', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  const logouts = watchRequests(page, '/api/staff/auth/session/logout');
  await page.route(adminUrl('/api/staff/auth/session/logout'), (route) => route.abort());
  const refreshes = watchRequests(page, REFRESH);

  await page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  expect(logouts).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.getItem('chumbaq_staff_signed_in'))).toBeNull();

  await page.reload();
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  expect(refreshes).toEqual([]);
  // The server never heard: the session lives on until it idles out.
  expect((await staffSession(signedIn.session.id)).revoked_at).toBeNull();
});

test('ADMAUTH-117 "/me" profile contents', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await seedCustomerPasskeyRow(staff.userId);
  const signedIn = await staffPasskeySignIn(page);

  const me = await staffApi('GET', '/api/staff/auth/me', undefined, { token: signedIn.accessToken, ip: clientIp });
  expect(me.status).toBe(200);
  expect(Object.keys(me.data).sort()).toEqual(['billingEnabled', 'email', 'enrolmentOnly', 'factors', 'id', 'name', 'session']);
  expect(me.data).toMatchObject({
    id: staff.userId,
    email: staff.email,
    name: 'Sam Staff',
    enrolmentOnly: false,
    factors: { passkeys: 1, totp: false },
    billingEnabled: true,
  });
  expect(Object.keys(me.data.factors).sort()).toEqual(['passkeys', 'totp']);
  expect(Object.keys(me.data.session).sort()).toEqual(['accessExpiresAt', 'enrolmentOnly', 'expiresAt', 'id', 'idleTimeoutSeconds']);
  expect(me.data.session).toMatchObject({ id: signedIn.session.id, enrolmentOnly: false, idleTimeoutSeconds: 1800 });
  expect(Date.parse(me.data.session.accessExpiresAt) / 1000).toBe(jwtClaims(signedIn.accessToken).exp);
  const row = await staffSession(signedIn.session.id);
  expect(Math.abs(Date.parse(me.data.session.expiresAt) - row.created_at.getTime() - 8 * 3600_000)).toBeLessThan(1000);
  const text = JSON.stringify(me.body);
  for (const secret of ['password', 'hash', 'secret', 'token', staff.password]) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
});

// ---- API client: one refresh, re-authentication

test('ADMAUTH-119 concurrent 401s share one refresh', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'tenant');
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();
  const usage = `/api/admin/tenants/${tenant.userId}/usage`;
  const factorReset = `/api/admin/tenants/${tenant.userId}/factor-reset`;
  const bearers = await refuseFirstTogether(page, [usage, factorReset], { status: 401, message: 'Unauthorized' });
  const refreshes = watchResponses(page, REFRESH);
  const resent = (pathname: string) => page.waitForResponse((r) => pathOf(r.url()) === pathname && r.status() === 200);
  const usageResent = resent(usage);
  const factorResetResent = resent(factorReset);
  // A token issued in the same second as the sign-in's would be the same token.
  const issuedAt = jwtClaims(signedIn.accessToken).iat as number;
  await expect.poll(() => Math.floor(Date.now() / 1000)).toBeGreaterThan(issuedAt);

  await navigateInApp(page, `/tenants/${tenant.userId}`);
  await usageResent;
  await factorResetResent;
  await expect(page.getByText(tenant.email).first()).toBeVisible();
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0].status()).toBe(200);
  const fresh = ((await refreshes[0].json()) as { data: { accessToken: string } }).data.accessToken;
  for (const pathname of [usage, factorReset]) {
    expect(bearers[pathname], pathname).toHaveLength(2);
    expect(bearers[pathname][0], pathname).toBe(`Bearer ${signedIn.accessToken}`);
    expect(bearers[pathname][1], pathname).toBe(`Bearer ${fresh}`);
  }
  await expect(page).toHaveURL(adminUrl(`/tenants/${tenant.userId}`));
});

test('ADMAUTH-122 cancelling re-authentication shows the refusal', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  await expect(heading(page, 'Your account')).toBeVisible();
  const options = watchResponses(page, '/api/staff/auth/passkeys/options');
  const reauths = watchRequests(page, '/api/staff/auth/reauth/passkey/options');
  const dialog = reauthDialog(page);

  await page.getByLabel('Name', { exact: true }).fill('Laptop');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alert')).toHaveText(REAUTH);

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alert')).toHaveText(REAUTH);

  expect(options.map((r) => r.status())).toEqual([403, 403]);
  expect(reauths).toEqual([]);
  expect(await staffKeyCount(staff.userId)).toBe(1);
});

test('ADMAUTH-123 re-authentication with the authenticator app', async ({ page, clientIp }) => {
  test.slow(); // May wait for a fresh authenticator code.
  const { staff, authenticator, enrolment } = await staffWithPasskeyAndApp(page, clientIp);
  const signedIn = await signInStaffInPage(page);
  const since = new Date();
  await sidebarLink(page, 'Your account').click();
  await expect(heading(page, 'Your account')).toBeVisible();
  const aside = await setAsideKeysForRegistration(page, authenticator);
  const dialog = reauthDialog(page);
  const code = await freshTotpCode(enrolment);
  const reauth = page.waitForResponse(isStaffCall('/api/staff/auth/reauth/totp'));
  const registered = page.waitForResponse(isStaffCall('/api/staff/auth/passkeys', 'POST'));

  await page.getByLabel('Name', { exact: true }).fill('Code-confirmed key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(dialog.getByRole('button', { name: 'Use passkey' })).toBeVisible();
  await dialog.getByLabel('Code from your authenticator app').fill(code);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  expect((await reauth).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect((await registered).status()).toBe(200);
  await expect(toastText(page, 'Passkey added')).toBeVisible();
  await aside.restore();

  expect((await staffSession(signedIn.session.id)).amr).toContain('totp');
  expect((await authEvents({ userId: staff.userId }, since, 'reauth.succeeded')).map((r) => r.reason)).toEqual(['totp']);
  expect(await staffKeyCount(staff.userId)).toBe(2);
});

test('ADMAUTH-124 wrong code or failed passkey in the dialog', async ({ page, clientIp }) => {
  const { staff, authenticator } = await staffWithPasskeyAndApp(page, clientIp);
  const signedIn = await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  await expect(heading(page, 'Your account')).toBeVisible();
  const refreshes = watchRequests(page, REFRESH);
  const verifies = watchRequests(page, '/api/staff/auth/reauth/passkey/verify');
  const dialog = reauthDialog(page);
  const dialogAlert = dialog.getByRole('alert');

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(dialog.getByRole('button', { name: 'Use passkey' })).toBeVisible();

  // 1. A wrong code.
  let since = new Date();
  const wrong = page.waitForResponse(isStaffCall('/api/staff/auth/reauth/totp'));
  await dialog.getByLabel('Code from your authenticator app').fill('000000');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  expect((await wrong).status()).toBe(403);
  await expect(dialogAlert).toHaveText(CODE_REFUSED);
  expect((await authEvents({ userId: staff.userId }, since, 'login.failed')).map((r) => r.reason)).toEqual(['reauth_totp_failed']);
  expect((await auditRows(staff.userId, since, 'staff.sign_in_failed')).map((r) => r.metadata?.reason)).toEqual(['reauth_totp_failed']);

  // 2. The browser's prompt fails: nothing reaches the server.
  await authenticator.setUserVerified(false);
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await expect(dialogAlert).toHaveText(PROMPT_CANCELLED);
  expect(verifies).toEqual([]);
  await authenticator.setUserVerified(true);

  // 3a. An assertion naming a key this account does not hold.
  since = new Date();
  await page.route(adminUrl('/api/staff/auth/reauth/passkey/verify'), async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    const other = Buffer.from(randomUUID()).toString('base64url');
    body.response.id = other;
    body.response.rawId = other;
    await route.fallback({ postData: JSON.stringify(body) });
  });
  const forged = page.waitForResponse(isStaffCall('/api/staff/auth/reauth/passkey/verify'));
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  expect((await forged).status()).toBe(403);
  await expect(dialogAlert).toHaveText(NOT_VERIFIED);
  expect((await authEvents({ userId: staff.userId }, since, 'passkey.failed')).map((r) => r.reason)).toEqual(['staff_reauth']);
  expect((await auditRows(staff.userId, since, 'staff.sign_in_failed')).map((r) => r.metadata?.reason)).toEqual(['reauth_passkey_failed']);
  await page.unroute(adminUrl('/api/staff/auth/reauth/passkey/verify'));

  // 3b. The challenge ran out: refused before any check, so nothing is recorded.
  since = new Date();
  await page.route(adminUrl('/api/staff/auth/reauth/passkey/verify'), async (route) => {
    await redisDel(challengeKey('staff-reauth', signedIn.session.id));
    await route.fallback();
  });
  const late = page.waitForResponse(isStaffCall('/api/staff/auth/reauth/passkey/verify'));
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  expect((await late).status()).toBe(403);
  await expect(dialogAlert).toHaveText(TOO_SLOW);
  expect(await authEvents({ userId: staff.userId }, since, 'passkey.failed')).toEqual([]);
  expect(await auditRows(staff.userId, since)).toEqual([]);

  await expect(dialog).toBeVisible();
  expect(refreshes).toEqual([]);
  await expect(page).toHaveURL(adminUrl('/account'));
});

test('ADMAUTH-125 dialog offers only what this person can use (b: app only)', async ({ page, clientIp }) => {
  test.slow(); // Waits for a fresh authenticator code.
  const staff = await makeStaff(clientIp);
  const enrolment = await enrolStaffTotpOnly(staff);
  await signInWithCodeInPage(page, staff, await freshTotpCode(enrolment));
  await sidebarLink(page, 'Your account').click();
  await expect(page.getByText('No passkeys yet.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  const dialog = reauthDialog(page);
  await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Use passkey' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

// ---- /account

test('ADMAUTH-129 account page shows the session and methods', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  await expect(heading(page, 'Your account')).toBeVisible();

  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const ends = inZone(signedIn.session.expiresAt, zone);
  const sessionCard = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').getByText(staff.email, { exact: true }) });
  await expect(sessionCard).toContainText(`This session ends at ${ends.time}, ${ends.dayMonth}, or after 30 minutes with nothing done.`);

  const methods = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').getByText('Sign-in methods', { exact: true }) });
  await expect(methods).toContainText(
    'Staff sign in with a passkey or an authenticator app. Changing them asks you to confirm it is you, and signs you out everywhere else.',
  );
  await expect(methods.getByRole('heading', { name: 'Passkeys' })).toBeVisible();
  const [key] = await sql<{ created_at: Date; last_used_at: Date }>(
    `SELECT created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`,
    [staff.userId],
  );
  const row = passkeyRow(page, 'E2E staff key');
  await expect(row).toContainText(
    `Added ${inZone(key.created_at.toISOString(), zone).full}, last used ${inZone(key.last_used_at.toISOString(), zone).full} · this device only`,
  );
  const remove = row.getByRole('button', { name: 'Remove' });
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute('title', LAST_FACTOR);
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('placeholder', 'e.g. Work laptop');
  await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeEnabled();
  await expect(methods.getByRole('heading', { name: 'Authenticator app' })).toBeVisible();
  await expect(methods.getByRole('button', { name: 'Use an authenticator app' })).toBeVisible();
});

test('ADMAUTH-130 factors list API contents', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await seedCustomerPasskeyRow(staff.userId);
  const signedIn = await staffPasskeySignIn(page);

  const factors = await staffApi('GET', '/api/staff/auth/factors', undefined, { token: signedIn.accessToken, ip: clientIp });
  expect(factors.status).toBe(200);
  expect(Object.keys(factors.data).sort()).toEqual(['canRemove', 'passkeys', 'totp']);
  expect(factors.data.passkeys).toHaveLength(1);
  const [key] = factors.data.passkeys;
  expect(Object.keys(key).sort()).toEqual(['backedUp', 'createdAt', 'deviceType', 'id', 'lastUsedAt', 'name']);
  expect(key).toMatchObject({ id: await staffKeyId(staff.userId), name: 'E2E staff key', deviceType: 'singleDevice', backedUp: false });
  expect(factors.data.totp).toEqual({ enabled: false, available: true });
  expect(factors.data.canRemove).toBe(false);
});

test('ADMAUTH-132 same device cannot hold two keys for the account', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  await expect(heading(page, 'Your account')).toBeVisible();
  const reauths = watchRequests(page, '/api/staff/auth/reauth/passkey/verify');
  const registrations = watchRequests(page, '/api/staff/auth/passkeys', 'POST');
  const options = watchResponses(page, '/api/staff/auth/passkeys/options');

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await reauthDialog(page).getByRole('button', { name: 'Use passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText(SAME_DEVICE);

  // The add was never posted, so the proof is still there: no second dialog.
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect.poll(() => options.length).toBe(3);
  await expect(page.getByRole('alert')).toHaveText(SAME_DEVICE);
  await expect(reauthDialog(page)).toBeHidden();
  expect(options.map((r) => r.status())).toEqual([403, 200, 200]);
  expect(reauths).toHaveLength(1);
  expect(registrations).toEqual([]);
  expect(await staffKeyCount(staff.userId)).toBe(1);
});

test('ADMAUTH-136 each change needs its own confirmation', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await seedStaffPasskeyRow(staff.userId, 'Spare A');
  await seedStaffPasskeyRow(staff.userId, 'Spare B');
  await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  const dialog = reauthDialog(page);
  const deleted: Response[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'DELETE') deleted.push(r);
  });
  const reauths = watchRequests(page, '/api/staff/auth/reauth/passkey/verify');

  for (const name of ['Spare A', 'Spare B']) {
    await passkeyRow(page, name).getByRole('button', { name: 'Remove' }).click();
    await expect(dialog, name).toBeVisible();
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    await expect(passkeyRow(page, name)).toHaveCount(0);
  }
  expect(reauths).toHaveLength(2);
  expect(deleted.map((r) => r.status())).toEqual([403, 204, 403, 204]);
  expect(await staffKeyCount(staff.userId)).toBe(1);
});

test('ADMAUTH-140 remove needs a recent sign-in as well as the proof', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const backup = await seedStaffPasskeyRow(staff.userId, 'Backup key');
  const signedIn = await staffPasskeySignIn(page, clientIp);
  await reauthWithPasskey(page, signedIn.accessToken, clientIp);
  const proof = challengeKey(PROOF, signedIn.session.id);
  expect(await redisExists(proof)).toBe(1);

  await sql(`UPDATE staff_sessions SET authenticated_at = now() - interval '16 minutes' WHERE id = $1`, [signedIn.session.id]);
  const stale = await staffApi('POST', REFRESH, {}, { cookie: signedIn.cookie, ip: clientIp });
  expect(stale.status).toBe(200);
  expect(jwtClaims(stale.data.accessToken).auth_time).toBeLessThan(Date.now() / 1000 - 15 * 60);

  const refused = await staffApi('DELETE', `/api/staff/auth/passkeys/${backup}`, undefined, { token: stale.data.accessToken, ip: clientIp });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(REAUTH);
  // Refused before the proof was looked at: it is still there.
  expect(await redisExists(proof)).toBe(1);
  expect(await staffKeyCount(staff.userId)).toBe(2);

  // With a recent sign-in the same proof is enough.
  await sql(`UPDATE staff_sessions SET authenticated_at = now() WHERE id = $1`, [signedIn.session.id]);
  const recent = await staffApi('POST', REFRESH, {}, { cookie: staffCookiePair(stale.setCookies), ip: clientIp });
  expect(recent.status).toBe(200);
  const removed = await staffApi('DELETE', `/api/staff/auth/passkeys/${backup}`, undefined, { token: recent.data.accessToken, ip: clientIp });
  expect(removed.status).toBe(204);
  expect(await staffKeyCount(staff.userId)).toBe(1);
});

test('ADMAUTH-142 add an authenticator app in a full session', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  const other = await staffPasskeySignIn(page);
  const since = new Date();
  await sidebarLink(page, 'Your account').click();
  await expect(passkeyRow(page, 'E2E staff key').getByRole('button', { name: 'Remove' })).toBeDisabled();

  await page.getByRole('button', { name: 'Use an authenticator app' }).click();
  await reauthDialog(page).getByRole('button', { name: 'Use passkey' }).click();
  const secretShown = page.locator('code');
  await expect(secretShown).toBeVisible();
  await expect(page.getByText('Scan this with your authenticator app, or enter the key by hand. Then type the code it shows.')).toBeVisible();
  const secret = (await secretShown.innerText()).trim();
  await roomInStep(5);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();

  await expect(toastText(page, 'Authenticator app turned on')).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeEnabled();
  await expect(passkeyRow(page, 'E2E staff key').getByRole('button', { name: 'Remove' })).toBeEnabled();
  expect((await totpRow(staff.userId)).confirmed_at).not.toBeNull();
  expect((await staffSession(signedIn.session.id)).revoked_at).toBeNull();
  expect((await staffSession(other.session.id)).revoked_reason).toBe('factor_changed');
  const [audit] = await auditRows(staff.userId, since, 'staff.factor_added');
  expect(audit.metadata).toEqual({ method: 'totp', sessionId: signedIn.session.id });
  expect(await recoveryCodeCount(staff.userId)).toBe(0);
});

test('ADMAUTH-146 wrong code when turning the app on keeps the proof', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  const reauths = watchRequests(page, '/api/staff/auth/reauth/passkey/verify');
  const confirms = watchResponses(page, '/api/staff/auth/totp/confirm');

  await page.getByRole('button', { name: 'Use an authenticator app' }).click();
  await reauthDialog(page).getByRole('button', { name: 'Use passkey' }).click();
  await expect(page.locator('code')).toBeVisible();
  const secret = (await page.locator('code').innerText()).trim();

  await page.getByLabel('Code from your authenticator app').fill('000000');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('alert')).toHaveText(CODE_REFUSED);
  expect((await totpRow(staff.userId)).confirmed_at).toBeNull();

  await roomInStep(5);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(toastText(page, 'Authenticator app turned on')).toBeVisible();
  await expect(reauthDialog(page)).toBeHidden();
  expect(reauths).toHaveLength(1);
  expect(confirms.map((r) => r.status())).toEqual([400, 200]);
  expect((await totpRow(staff.userId)).confirmed_at).not.toBeNull();
});

test('ADMAUTH-147 turn off the authenticator app', async ({ page, clientIp }) => {
  const { staff } = await staffWithPasskeyAndApp(page, clientIp);
  await seedRecoveryCodeRow(staff.userId);
  const signedIn = await signInStaffInPage(page);
  const other = await staffPasskeySignIn(page);
  const since = new Date();
  await sidebarLink(page, 'Your account').click();
  expect(await recoveryCodeCount(staff.userId)).toBe(1);

  await page.getByRole('button', { name: 'Turn off' }).click();
  await reauthDialog(page).getByRole('button', { name: 'Use passkey' }).click();
  await expect(toastText(page, 'Authenticator app turned off')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use an authenticator app' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off' })).toHaveCount(0);

  expect(await totpRow(staff.userId)).toBeUndefined();
  expect(await recoveryCodeCount(staff.userId)).toBe(0);
  expect((await staffSession(signedIn.session.id)).revoked_at).toBeNull();
  expect((await staffSession(other.session.id)).revoked_reason).toBe('factor_changed');
  expect(await authEvents({ userId: staff.userId }, since, 'totp.disabled')).toHaveLength(1);
  const [audit] = await auditRows(staff.userId, since, 'staff.factor_removed');
  expect(audit.metadata).toEqual({ method: 'totp', sessionId: signedIn.session.id });
});

test('ADMAUTH-148 turning off the app when it is the last factor, or absent', async ({ page, clientIp }) => {
  test.slow(); // Waits for fresh authenticator codes.
  // a. The app is the only factor.
  const appOnly = await makeStaff(clientIp, 'app-only');
  const enrolment = await enrolStaffTotpOnly(appOnly);
  const { handle } = await staffHandle(appOnly, clientIp);
  const signedIn = await staffApi('POST', '/api/staff/auth/login/totp', { handle, code: await freshTotpCode(enrolment) }, { ip: clientIp });
  expect(signedIn.status).toBe(200);
  const reauth = await staffApi('POST', '/api/staff/auth/reauth/totp', { code: await freshTotpCode(enrolment) }, { token: signedIn.data.accessToken, ip: clientIp });
  expect(reauth.status).toBe(200);
  const last = await staffApi('DELETE', '/api/staff/auth/totp', undefined, { token: reauth.data.accessToken, ip: clientIp });
  expect(last.status).toBe(409);
  expect(last.body.message).toBe(LAST_FACTOR);
  expect((await totpRow(appOnly.userId)).confirmed_at).not.toBeNull();

  // b. No app at all.
  const keyOnly = await makeStaff(clientIp, 'key-only');
  await enrolStaffPasskey(page, keyOnly);
  const keySession = await staffPasskeySignIn(page, clientIp);
  const proven = await reauthWithPasskey(page, keySession.accessToken, clientIp);
  const absent = await staffApi('DELETE', '/api/staff/auth/totp', undefined, { token: proven, ip: clientIp });
  expect(absent.status).toBe(404);
  expect(absent.body.message).toBe('No authenticator app is set up.');
});

// ---- Tokens, principals and logging

test('ADMAUTH-155 staff token shape and lifetime', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  // An enrolment session's token first.
  const enrol = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: clientIp });
  expect(enrol.data.step).toBe('enrol');
  const enrolClaims = jwtClaims(enrol.data.accessToken);
  expect(enrolClaims.enr).toBe(true);
  expect(Math.abs(enrolClaims.exp - enrolClaims.iat - 15 * 60)).toBeLessThanOrEqual(1);
  expect(Math.abs(enrolClaims.exp - (Date.now() / 1000 + 15 * 60))).toBeLessThan(60);

  await addAuthenticator(page);
  await page.goto(adminUrl('/sign-in'));
  expect((await enrolPasskeyByApi(page, enrol.data.accessToken, 'E2E staff key', clientIp)).status).toBe(200);
  const signedIn = await staffPasskeySignIn(page, clientIp);
  const [head] = signedIn.accessToken.split('.');
  expect(JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))).toEqual({ alg: 'HS256', typ: 'JWT' });
  const claims = jwtClaims(signedIn.accessToken);
  expect(Object.keys(claims).sort()).toEqual(['amr', 'aud', 'auth_time', 'email', 'exp', 'iat', 'sid', 'sub', 'sv', 'type']);
  expect(claims).toMatchObject({
    sub: staff.userId,
    email: staff.email,
    type: 'staff_access',
    aud: 'chumbaq-admin',
    sid: signedIn.session.id,
    amr: ['webauthn', 'uv'],
  });
  expect(typeof claims.sv).toBe('number');
  expect(Math.abs(claims.auth_time - Date.now() / 1000)).toBeLessThan(60);
  expect(Math.abs(claims.exp - claims.iat - 10 * 60)).toBeLessThanOrEqual(1);
  expect(Math.abs(claims.exp - (Date.now() / 1000 + 10 * 60))).toBeLessThan(60);
  expect(claims.enr).toBeUndefined();
  expect(Date.parse((signedIn.session as unknown as { accessExpiresAt: string }).accessExpiresAt) / 1000).toBe(claims.exp);
});

test('ADMAUTH-158 staff sign-in voids an unused support reset link', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const link = await seedStaffResetLink(staff.userId);
  const since = new Date();

  // The password step alone voids nothing.
  const { methods } = await staffHandle(staff, clientIp);
  expect(methods).toEqual(['webauthn']);
  expect(await accountTokenUsedAt(link)).toBeNull();
  expect(await auditRows(staff.userId, since, 'account.password_reset_link_cancelled')).toEqual([]);

  await staffPasskeySignIn(page, clientIp);
  expect(await accountTokenUsedAt(link)).not.toBeNull();
  const rows = await sql<{ actor_id: string | null; actor_email: string; metadata: Record<string, unknown> }>(
    `SELECT actor_id, actor_email, metadata FROM admin_audit_logs
      WHERE target_id = $1 AND action = 'account.password_reset_link_cancelled' AND created_at >= $2`,
    [staff.userId, since],
  );
  expect(rows).toEqual([{ actor_id: null, actor_email: 'system', metadata: { tokenId: link, reason: 'owner_signed_in', via: 'factor' } }]);
});

test('ADMAUTH-159 audit trail of a full staff day', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await seedCustomerPasskeyRow(staff.userId);
  const since = new Date(Date.now() - 1000);
  const { code } = await enrolmentCodeFromCli(staff.email);
  const ip = clientIp;

  const enrol = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password, enrolmentCode: code }, { ip });
  expect(enrol.data.step).toBe('enrol');
  const authenticator = await addAuthenticator(page);
  await page.goto(adminUrl('/sign-in'));
  expect((await enrolPasskeyByApi(page, enrol.data.accessToken, 'First key', ip)).status).toBe(200);
  const signedIn = await staffPasskeySignIn(page, ip);
  let token = await reauthWithPasskey(page, signedIn.accessToken, ip);
  expect((await addPasskeyByApi(page, authenticator, token, 'Second key', ip)).status).toBe(200);
  token = await reauthWithPasskey(page, token, ip);
  const second = await staffKeyId(staff.userId, 'Second key');
  expect((await staffApi('DELETE', `/api/staff/auth/passkeys/${second}`, undefined, { token, ip })).status).toBe(204);
  expect((await staffApi('POST', '/api/staff/auth/session/logout', {}, { token, ip })).status).toBe(204);

  const rows = await auditTrail(staff.userId, since);
  expect(rows.map((r) => r.action)).toEqual([
    'staff.enrolment_allowed',
    'staff.enrolment_started',
    'staff.factor_added',
    'staff.signed_in',
    'staff.factor_added',
    'staff.factor_removed',
    'staff.signed_out',
  ]);
  expect(rows[0]).toMatchObject({ actor_id: null, actor_email: 'cli', ip_address: null });
  for (const row of rows.slice(1)) expect(row, row.action).toMatchObject({ actor_id: staff.userId, ip_address: ip });
  const text = JSON.stringify(rows);
  const [key] = await sql<{ public_key: Buffer }>(`SELECT public_key FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`, [staff.userId]);
  for (const secret of [staff.password, code, signedIn.accessToken, token, cookieValue(signedIn.cookie), key.public_key.toString('base64'), key.public_key.toString('base64url')]) {
    expect(text).not.toContain(secret);
  }
});

test('ADMAUTH-166 a bare refresh cookie is never read while the cookie is Secure', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  const real = (await browserStaffCookie(context))!;
  expect(real.startsWith('__Host-chumbaq_staff_refresh=')).toBe(true);
  const r1 = cookieValue(real);
  const since = new Date();

  // 1. The valid token under the bare name.
  const bare = await staffApi('POST', REFRESH, {}, { cookie: `chumbaq_staff_refresh=${r1}`, ip: clientIp });
  expect(bare.status).toBe(401);
  expect(bare.body.message).toBe(ENDED);
  expect(bare.setCookies).toEqual([]);
  expect(await authEvents({ userId: staff.userId }, since)).toEqual([]);
  // 2. Nothing rotated or ended, and the same token works under its real name.
  let row = await staffSession(signedIn.session.id);
  expect(row.current_token_hash).toBe(tokenHash(r1));
  expect(row.revoked_at).toBeNull();
  const prefixed = await staffApi('POST', REFRESH, {}, { cookie: real, ip: clientIp });
  expect(prefixed.status).toBe(200);
  const r2 = cookieValue(staffCookiePair(prefixed.setCookies));

  // 3. The browser holds only a bare cookie with the current token.
  await context.clearCookies();
  await context.addCookies([
    { name: 'chumbaq_staff_refresh', value: r2, domain: 'localhost', path: '/api/staff/auth/session', secure: true, httpOnly: true, sameSite: 'Strict' },
  ]);
  const restore = page.waitForResponse(isStaffCall(REFRESH));
  await page.reload();
  expect((await restore).status()).toBe(401);
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('status')).toHaveText(ENDED);
  expect(await page.evaluate(() => sessionStorage.getItem('chumbaq_staff_signed_in'))).toBeNull();
  expect((await context.cookies(adminUrl('/api/staff/auth/session/refresh'))).map((c) => c.name)).toContain('chumbaq_staff_refresh');
  row = await staffSession(signedIn.session.id);
  expect(row.current_token_hash).toBe(tokenHash(r2));
  expect(row.revoked_at).toBeNull();

  // 4. A junk bare cookie beside the real one cannot sign anyone out.
  await context.clearCookies();
  await signInStaffInPage(page);
  await context.addCookies([{ name: 'chumbaq_staff_refresh', value: 'junk', domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  const restored = page.waitForResponse(isStaffCall(REFRESH));
  await page.reload();
  const answer = await restored;
  expect(answer.status()).toBe(200);
  await expect(heading(page, 'Overview')).toBeVisible();
  const setCookies = (await answer.headersArray()).filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
  expect(
    setCookies.some((v) => v.startsWith('chumbaq_staff_refresh=;') && v.includes('Path=/api/staff/auth/session') && v.includes('Expires=Thu, 01 Jan 1970')),
    JSON.stringify(setCookies),
  ).toBe(true);
  // The planted one sits on another path, which that clear does not reach.
  expect((await context.cookies(adminUrl('/'))).find((c) => c.name === 'chumbaq_staff_refresh')?.value).toBe('junk');
});

test('ADMAUTH-168 generic 403 on an admin page: "You do not have access to this area"', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();
  const refreshes = watchRequests(page, REFRESH);

  for (const message of ['Super admin access required', 'Forbidden resource']) {
    let hits = 0;
    await page.route(adminUrl('/api/admin/overview'), async (route) => {
      hits++;
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ statusCode: 403, message }) });
    });
    await page.reload();
    const alert = page.getByRole('alert');
    await expect(alert.getByText('You do not have access to this area', { exact: true })).toBeVisible();
    await expect(alert).toContainText('The server refused this request. Super admin access may have been revoked for this account.');
    await expect(alert.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.getByText('Could not load the overview.')).toHaveCount(0);
    await expect(sidebarLink(page, 'Tenants')).toBeVisible();
    expect(hits, message).toBe(1);
    await page.unroute(adminUrl('/api/admin/overview'));
  }
  // Only the two reloads' restores refreshed: the 403s did not.
  expect(refreshes).toHaveLength(2);

  await page.route(adminUrl('/api/admin/overview'), (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ statusCode: 403, message: 'Forbidden resource' }) }),
  );
  const restoredAgain = page.waitForResponse(isStaffCall(REFRESH));
  await page.reload();
  await restoredAgain;
  const [logout] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/session/logout')),
    page.getByRole('alert').getByRole('button', { name: 'Sign out' }).click(),
  ]);
  expect(logout.status()).toBe(204);
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  expect(await page.evaluate(() => sessionStorage.getItem('chumbaq_staff_signed_in'))).toBeNull();
  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('signed_out');
});

test('ADMAUTH-169 "No passkeys yet." when the authenticator app is the only method left', async ({ page, clientIp }) => {
  const { staff } = await staffWithPasskeyAndApp(page, clientIp);
  await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  const dialog = reauthDialog(page);

  const remove = passkeyRow(page, 'E2E staff key').getByRole('button', { name: 'Remove' });
  await expect(remove).toBeEnabled();
  const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.status() !== 403);
  await remove.click();
  await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
  const listed = page.waitForResponse(isStaffCall('/api/staff/auth/factors', 'GET'));
  const profile = page.waitForResponse(isStaffCall('/api/staff/auth/me', 'GET'));
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  expect((await removed).status()).toBe(204);
  await expect(toastText(page, 'Passkey removed')).toBeVisible();

  await expect(page.getByText('No passkeys yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
  const turnOff = page.getByRole('button', { name: 'Turn off' });
  await expect(turnOff).toBeDisabled();
  await expect(turnOff).toHaveAttribute('title', LAST_FACTOR);
  const factors = ((await (await listed).json()) as { data: { passkeys: unknown[]; canRemove: boolean } }).data;
  expect(factors.passkeys).toEqual([]);
  expect(factors.canRemove).toBe(false);
  expect(((await (await profile).json()) as { data: { factors: unknown } }).data.factors).toEqual({ passkeys: 0, totp: true });

  await page.getByLabel('Name', { exact: true }).fill('Later key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Use passkey' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await staffKeyCount(staff.userId)).toBe(0);
});

test('ADMAUTH-170 signing in with only an authenticator app left', async ({ page, clientIp }) => {
  test.slow(); // Waits for a fresh authenticator code.
  const { staff, enrolment } = await staffWithPasskeyAndApp(page, clientIp);
  const session = await staffPasskeySignIn(page);
  const proven = await reauthWithPasskey(page, session.accessToken);
  expect((await staffApi('DELETE', `/api/staff/auth/passkeys/${await staffKeyId(staff.userId)}`, undefined, { token: proven })).status).toBe(204);
  expect((await staffApi('POST', '/api/staff/auth/session/logout', {}, { token: proven })).status).toBe(204);
  const since = new Date();

  // 1. The tab's authenticator still holds the removed key.
  await page.goto(adminUrl('/sign-in'));
  const [verify] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/passkey/verify')),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  expect(verify.status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(NOT_RECOGNISED);
  // The key is gone, so the event names nobody: it is found by the client's address.
  const failed = (await authEventsFromIp(clientIp, since)).filter((r) => r.type === 'passkey.failed');
  expect(failed.map((r) => [r.reason, r.user_id])).toEqual([['staff_passwordless', null]]);

  // 2. The password step offers only the code.
  const login = await passwordStep(page, staff.email, staff.password);
  expect(((await login.json()) as { data: { step: string; methods: string[] } }).data).toMatchObject({ step: 'second_factor', methods: ['totp'] });
  await expect(page.getByText('Now confirm it is you.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use your passkey' })).toHaveCount(0);

  // 3. The code signs in.
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(enrolment));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(adminUrl('/'));
  await expect(heading(page, 'Overview')).toBeVisible();
});

test('ADMAUTH-177 several refused requests share one dialog and one re-authentication', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'tenant');
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();
  const usage = `/api/admin/tenants/${tenant.userId}/usage`;
  const factorReset = `/api/admin/tenants/${tenant.userId}/factor-reset`;
  const bearers = await refuseFirstTogether(page, [usage, factorReset], { status: 403, message: REAUTH });
  const profiles = watchRequests(page, '/api/staff/auth/me');
  const reauthOptions = watchRequests(page, '/api/staff/auth/reauth/passkey/options');
  const reauthVerify = watchResponses(page, '/api/staff/auth/reauth/passkey/verify');
  const dialogs: number[] = [];
  const resent = (pathname: string) => page.waitForResponse((r) => pathOf(r.url()) === pathname && r.status() === 200);
  const usageResent = resent(usage);
  const factorResetResent = resent(factorReset);

  await navigateInApp(page, `/tenants/${tenant.userId}`);
  const dialog = reauthDialog(page);
  await expect(dialog).toBeVisible();
  await expect.poll(() => profiles.length).toBe(2);
  dialogs.push(await page.getByRole('dialog').count());
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await expect(dialog).toBeHidden();
  await usageResent;
  await factorResetResent;

  expect(dialogs).toEqual([1]);
  expect(reauthOptions).toHaveLength(1);
  expect(reauthVerify).toHaveLength(1);
  const token = ((await reauthVerify[0].json()) as { data: { accessToken: string } }).data.accessToken;
  for (const pathname of [usage, factorReset]) {
    expect(bearers[pathname], pathname).toHaveLength(2);
    expect(bearers[pathname][1], pathname).toBe(`Bearer ${token}`);
  }
  await expect(page.getByText(tenant.email).first()).toBeVisible();
});

test('ADMAUTH-179 proof expired between authenticator setup and confirm', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  const since = new Date();
  await sidebarLink(page, 'Your account').click();
  const dialog = reauthDialog(page);
  const confirms = watchResponses(page, '/api/staff/auth/totp/confirm');

  await page.getByRole('button', { name: 'Use an authenticator app' }).click();
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await expect(page.locator('code')).toBeVisible();
  const secret = (await page.locator('code').innerText()).trim();
  expect(await redisDel(challengeKey(PROOF, signedIn.session.id))).toBe(1);

  await roomInStep(15);
  const refused = page.waitForResponse((r) => isStaffCall('/api/staff/auth/totp/confirm')(r) && r.status() === 403);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  expect(((await (await refused).json()) as { message: string }).message).toBe(REAUTH);
  await expect(dialog).toBeVisible();
  expect((await totpRow(staff.userId)).confirmed_at).toBeNull();

  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await expect(toastText(page, 'Authenticator app turned on')).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
  expect(confirms.map((r) => r.status())).toEqual([403, 200]);
  expect((await totpRow(staff.userId)).confirmed_at).not.toBeNull();
  const [audit] = await auditRows(staff.userId, since, 'staff.factor_added');
  expect(audit.metadata).toMatchObject({ method: 'totp' });
});

test('ADMAUTH-180 proof expired between passkey options and registration', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const authenticator = await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  const other = await staffPasskeySignIn(page);
  await sidebarLink(page, 'Your account').click();
  const aside = await setAsideKeysForRegistration(page, authenticator);
  const dialog = reauthDialog(page);
  const registrations = watchResponses(page, '/api/staff/auth/passkeys', 'POST');
  const bodies: string[] = [];
  await page.route(adminUrl('/api/staff/auth/passkeys'), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    bodies.push(route.request().postData() ?? '');
    if (bodies.length === 1) {
      // The virtual authenticator answers at once, where a person takes a moment to
      // touch the key: let the first dialog finish closing before the refusal opens it
      // again.
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      // The old key back in the authenticator, for the second confirmation.
      await aside.restore();
      expect(await redisDel(challengeKey(PROOF, signedIn.session.id))).toBe(1);
    }
    await route.fallback();
  });

  await page.getByLabel('Name', { exact: true }).fill('Backup key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await expect.poll(() => registrations.length).toBe(1);
  expect(registrations[0].status()).toBe(403);
  expect(((await registrations[0].json()) as { message: string }).message).toBe(REAUTH);
  expect(await redisExists(challengeKey('staff-register', signedIn.session.id))).toBe(1);
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await expect(toastText(page, 'Passkey added')).toBeVisible();
  await expect(passkeyRow(page, 'Backup key')).toBeVisible();
  expect(registrations.map((r) => r.status())).toEqual([403, 200]);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(await staffKeyCount(staff.userId)).toBe(2);
  expect((await staffSession(other.session.id)).revoked_reason).toBe('factor_changed');
});

test('ADMAUTH-181 a refused registration in a full session spends the proof', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const authenticator = await enrolStaffPasskey(page, staff);
  // Both sessions first: a registration refused below leaves its new key in the tab's
  // authenticator, where it would answer a passkey-first sign-in.
  const signedIn = await staffPasskeySignIn(page, clientIp);
  const inPage = await signInStaffInPage(page);
  const ip = clientIp;

  // 1. The registration challenge ran out between options and registration.
  let token = await reauthWithPasskey(page, signedIn.accessToken, ip);
  const options = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token, ip });
  expect(options.status).toBe(200);
  const attestation = await attestWithKeysAside(page, authenticator, options.data.options);
  expect(await redisDel(challengeKey('staff-register', signedIn.session.id))).toBe(1);
  const tooSlow = await staffApi('POST', '/api/staff/auth/passkeys', { response: attestation, name: 'Late key' }, { token, ip });
  expect(tooSlow.status).toBe(400);
  expect(tooSlow.body.message).toBe(TOO_SLOW);

  // 2. A registration that does not verify.
  token = await reauthWithPasskey(page, token, ip);
  expect((await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token, ip })).status).toBe(200);
  const junk = await staffApi('POST', '/api/staff/auth/passkeys', { response: {}, name: 'Junk key' }, { token, ip });
  expect(junk.status).toBe(400);
  expect(junk.body.message).toBe(NOT_VERIFIED);

  // 3. That refusal spent the proof too.
  const after = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token, ip });
  expect(after.status).toBe(403);
  expect(after.body.message).toBe(REAUTH);
  expect(await staffKeyCount(staff.userId)).toBe(1);

  // 4. The same through the card.
  await sidebarLink(page, 'Your account').click();
  await expect(heading(page, 'Your account')).toBeVisible();
  const aside = await setAsideKeysForRegistration(page, authenticator);
  await page.route(adminUrl('/api/staff/auth/passkeys'), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await aside.restore();
    await redisDel(challengeKey('staff-register', inPage.session.id));
    await route.fallback();
  });
  const refused = page.waitForResponse(isStaffCall('/api/staff/auth/passkeys', 'POST'));
  await page.getByLabel('Name', { exact: true }).fill('Card key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await reauthDialog(page).getByRole('button', { name: 'Use passkey' }).click();
  expect((await refused).status()).toBe(400);
  await expect(page.getByRole('alert')).toHaveText(TOO_SLOW);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(reauthDialog(page)).toBeVisible();
  await reauthDialog(page).getByRole('button', { name: 'Cancel' }).click();
  expect(await staffKeyCount(staff.userId)).toBe(1);
});

test('ADMAUTH-182 re-authentication voids an unused support reset link', async ({ page, clientIp }) => {
  test.slow(); // Waits for fresh authenticator codes.
  const { staff, enrolment } = await staffWithPasskeyAndApp(page, clientIp);
  const signedIn = await staffPasskeySignIn(page, clientIp);
  const ip = clientIp;
  const first = await seedStaffResetLink(staff.userId);
  const since = new Date();
  const cancelled = async () =>
    sql<{ actor_id: string | null; actor_email: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, actor_email, metadata FROM admin_audit_logs
        WHERE target_id = $1 AND action = 'account.password_reset_link_cancelled' AND created_at >= $2 ORDER BY created_at`,
      [staff.userId, since],
    );

  // 1. Failed re-authentications void nothing.
  const wrong = await staffApi('POST', '/api/staff/auth/reauth/totp', { code: '000000' }, { token: signedIn.accessToken, ip });
  expect(wrong.status).toBe(403);
  const options = await staffApi('POST', '/api/staff/auth/reauth/passkey/options', {}, { token: signedIn.accessToken, ip });
  const assertion = await browserAssertion(page, options.data.options);
  const other = Buffer.from(randomUUID()).toString('base64url');
  const failed = await staffApi('POST', '/api/staff/auth/reauth/passkey/verify', { response: { ...assertion, id: other, rawId: other } }, { token: signedIn.accessToken, ip });
  expect(failed.status).toBe(403);
  expect(await accountTokenUsedAt(first)).toBeNull();
  expect(await cancelled()).toEqual([]);

  // 2. A passkey re-authentication voids it.
  const token = await reauthWithPasskey(page, signedIn.accessToken, ip);
  expect(await accountTokenUsedAt(first)).not.toBeNull();
  expect(await cancelled()).toEqual([{ actor_id: null, actor_email: 'system', metadata: { tokenId: first, reason: 'owner_signed_in', via: 'factor' } }]);

  // 3. So does one with the app.
  const second = await seedStaffResetLink(staff.userId);
  const byCode = await staffApi('POST', '/api/staff/auth/reauth/totp', { code: await freshTotpCode(enrolment) }, { token, ip });
  expect(byCode.status).toBe(200);
  expect(await accountTokenUsedAt(second)).not.toBeNull();
  expect((await cancelled()).map((r) => r.metadata)).toEqual([
    { tokenId: first, reason: 'owner_signed_in', via: 'factor' },
    { tokenId: second, reason: 'owner_signed_in', via: 'factor' },
  ]);
});

test('ADMAUTH-183 re-authentication with the app shares the second-factor failure limit', async ({ page, clientIp }) => {
  test.slow(); // Waits for fresh authenticator codes.
  const { staff, enrolment } = await staffWithPasskeyAndApp(page, clientIp);
  await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  // Nine failures already in the window (the API's own counter for this address).
  await seedSecondFactorAttempts(staff.email, 9);
  const since = new Date();
  const refreshes = watchRequests(page, REFRESH);
  const dialog = reauthDialog(page);
  const answers = watchResponses(page, '/api/staff/auth/reauth/totp');

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await dialog.getByLabel('Code from your authenticator app').fill('000000');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(CODE_REFUSED);
  await dialog.getByLabel('Code from your authenticator app').fill(await freshTotpCode(enrolment));
  const limitedStep = enrolment.lastStep;
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(TOO_MANY);
  expect(answers.map((r) => r.status())).toEqual([403, 429]);
  // Refused before the code was looked at: its step was never spent.
  const [{ last_used_step }] = await sql<{ last_used_step: string }>(`SELECT last_used_step FROM totp_secrets WHERE user_id = $1`, [staff.userId]);
  expect(Number(last_used_step)).toBeLessThan(limitedStep);
  expect(await authEvents({ email: staff.email }, since, 'login.limited')).toHaveLength(1);
  expect(refreshes).toEqual([]);
  await expect(page).toHaveURL(adminUrl('/account'));
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // The same limit holds the code step of a new sign-in; the password step is not held.
  await page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  const login = await passwordStep(page, staff.email, staff.password);
  expect(((await login.json()) as { data: { step: string } }).data.step).toBe('second_factor');
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(enrolment));
  const [codeStep] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/login/totp')),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  expect(codeStep.status()).toBe(429);
  await expect(page.getByRole('alert')).toHaveText(TOO_MANY);

  // A passwordless passkey sign-in is not held, and clears the window.
  await staffPasskeySignIn(page, clientIp);
  expect(await signInAttempts(staff.email)).toEqual({});
});

// ---- A server with billing off

test.describe('with billing off', () => {
  let billingOff: ExtraAdminApi;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    billingOff = await startAdminApiWith({ BILLING_ENABLED: 'false' }, 'billing-off');
  });

  test.afterAll(async () => {
    await billingOff?.stop();
  });

  test('ADMAUTH-111 billing link only when billing is on', async ({ page, clientIp }) => {
    const staff = await makeStaff(clientIp);
    await enrolStaffPasskey(page, staff);
    await forwardPrefixToAdminApi(page, billingOff.url, '/api/');
    const profile = page.waitForResponse(isStaffCall('/api/staff/auth/me'));
    await signInStaffInPage(page);
    expect(((await (await profile).json()) as { data: { billingEnabled: boolean } }).data.billingEnabled).toBe(false);

    const links = page.locator('[data-sidebar="group"]').getByRole('link');
    await expect(links).toHaveText(['Overview', 'Tenants', 'Plans', 'Audit log', 'Incidents', 'Platform health', 'Your account']);
    await expect(sidebarLink(page, 'Plans')).toBeVisible();

    const summaries = watchRequests(page, '/api/admin/billing/summary');
    await page.goto(adminUrl('/billing'));
    await expect(page).toHaveURL(adminUrl('/billing'));
    await expect(heading(page, 'Billing')).toBeVisible();
    await expect(page.getByText('Billing is off on this server.', { exact: true })).toBeVisible();
    expect(summaries).toEqual([]);
    const { accessToken } = await staffPasskeySignIn(page, clientIp, billingOff.url);
    const direct = await staffApi('GET', '/api/admin/billing/summary', undefined, { token: accessToken, base: billingOff.url, ip: clientIp });
    expect(direct.status).toBe(404);
    // The lane's API, with billing on, answers it.
    expect((await staffApi('GET', '/api/admin/billing/summary', undefined, { token: accessToken, ip: clientIp })).status).toBe(200);
  });
});

// ---- With passkeys required for staff, as in production

test.describe('with passkeys required for staff', () => {
  let required: ExtraAdminApi;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    required = await startPasskeyRequiredAdminApi();
  });

  test.afterAll(async () => {
    await required?.stop();
  });

  test('ADMAUTH-125 dialog offers only what this person can use (a: passkeys required)', async ({ page, clientIp }) => {
    await staffWithPasskeyAndApp(page, clientIp);
    await signInStaffInPage(page);
    await sidebarLink(page, 'Your account').click();
    const dialog = reauthDialog(page);

    // Where passkeys are not required the app is offered too.
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Use passkey' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await forwardToAdminApi(page, required.url, ['/api/staff/auth/me']);
    const profile = page.waitForResponse(isStaffCall('/api/staff/auth/me'));
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    expect(((await (await profile).json()) as { data: { factors: unknown } }).data.factors).toEqual({ passkeys: 1, totp: false });
    await expect(dialog.getByRole('button', { name: 'Use passkey' })).toBeVisible();
    await expect(dialog.getByLabel('Code from your authenticator app')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
});

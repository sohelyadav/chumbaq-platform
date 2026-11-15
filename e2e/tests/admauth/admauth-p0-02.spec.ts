import { randomUUID } from 'crypto';
import type { BrowserContext, Page, Response } from '@playwright/test';
import { adminUrl } from '../../support/admin';
import { createAccount } from '../../support/api';
import { runSecrets } from '../../support/stack';
import { decodeQrOnPage } from '../../support/browser-tools';
import { addAuthenticator, totpCode } from '../../support/factors';
import { expect, newPersonContext, test } from '../../support/fixtures';
import {
  allowance,
  auditRows,
  authEvents,
  cookieValue,
  copyCredentials,
  enrolStaffPasskey,
  enrolStaffTotpInFullSession,
  enrolStaffTotpOnly,
  forwardPrefixToAdminApi,
  forwardToAdminApi,
  freshTotpCode,
  issueEnrolmentCode,
  jwtClaims,
  makeStaff,
  reauthWithPasskey,
  revokeStaffWithCli,
  runStaffKey,
  seedCustomerPasskeyRow,
  seedStaffPasskeyRow,
  setAsideKeysForRegistration,
  signHs256,
  signInStaffInPage,
  sql,
  staffApi,
  staffHandle,
  staffPasskeySignIn,
  staffSession,
  startAdminApiWith,
  startPasskeyRequiredAdminApi,
  tokenHash,
  type ExtraAdminApi,
} from '../../support/areas/admauth';

/**
 * Staff on the admin app after the password: the enrolment-only session and /enrol, the
 * staff session's cookie, refresh and endings, the router's gate, the API client's
 * refresh and re-authentication, /account's sign-in methods, and staff access tokens.
 *
 * The lane's admin API runs with passkeys not required for staff. The cases for
 * production's setting start a second admin API with SUPER_ADMIN_PASSKEY_REQUIRED=true on
 * the same database and send chosen requests of the page there.
 */

const ENDED = 'Your staff session has ended. Sign in again.';
const IDLE = 'Signed out after a period of inactivity.';
const ENROLMENT_ONLY = 'Finish setting up your sign-in methods first.';
const REAUTH = 'Confirm it is you to continue.';
const PASSKEY_NEEDED = 'Staff sign-in needs a passkey. Use your passkey, or ask your operator for an enrolment code.';
const PASSKEY_REQUIRED = 'Staff access needs two passkeys and a passkey sign-in.';
const LAST_FACTOR = 'Add another sign-in method before removing this one.';
const NOT_RECOGNISED = 'That passkey is not recognised.';
const INVALID_LOGIN = 'Invalid email or password';
const SYNCED_REFUSED =
  'Staff accounts need a device-bound key, such as a hardware security key. This one syncs between devices. To allow that, set SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS.';
const REFRESH = '/api/staff/auth/session/refresh';

const pathOf = (url: string) => new URL(url).pathname;
const isStaffCall = (pathname: string, method?: string) => (response: Response) =>
  pathOf(response.url()) === pathname && (!method || response.request().method() === method);

/**
 * Holds a page's requests to one admin API path until the test releases them, so a busy
 * state can be seen for as long as the assertion needs.
 */
async function hold(page: Page, pathname: string): Promise<{ release(): void }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(adminUrl(pathname), async (route) => {
    await released;
    await route.fallback();
  });
  return { release };
}

interface Answer {
  status: number;
  body: any;
}

/**
 * Every answer to one admin API path, body included, read as it passes (a body cannot be
 * read once the page has navigated away, which these flows do at once).
 */
async function recordAnswers(page: Page, pathname: string, method?: string): Promise<Answer[]> {
  const seen: Answer[] = [];
  const origin = new URL(adminUrl('/')).origin;
  await page.route(
    (url) => url.origin === origin && url.pathname === pathname,
    async (route) => {
      if (method && route.request().method() !== method) return route.fallback();
      const response = await route.fetch();
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: keep the text.
      }
      seen.push({ status: response.status(), body });
      await route.fulfill({ response, body: text });
    },
  );
  return seen;
}

function watchResponses(page: Page, pathname: string): Response[] {
  const seen: Response[] = [];
  page.on('response', (response) => {
    if (pathOf(response.url()) === pathname) seen.push(response);
  });
  return seen;
}

/** The staff refresh cookie the browser holds for the admin app, as `name=value`, or null. */
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

const sidebarLink = (page: Page, name: string) =>
  page.locator('[data-sidebar="sidebar"]').getByRole('link', { name, exact: true });

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });

const passkeyRow = (page: Page, name: string) => page.locator('li').filter({ has: page.getByText(name, { exact: true }) });

const staffKeyCount = async (userId: string) =>
  Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`, [userId]))[0].n);

const clearingCookie = (setCookies: string[]) =>
  setCookies.find((value) => /^(__Host-)?chumbaq_staff_refresh=;/.test(value) && value.includes('Expires=Thu, 01 Jan 1970'));

// ---- Enrolment-only session and /enrol

test('ADMAUTH-060 password alone opens enrolment for a staff member with no passkey at all', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const since = new Date();

  const login = await passwordStep(page, staff.email, staff.password);
  expect(login.status()).toBe(200);
  const body = (await login.json()) as { data: { step: string; accessToken: string; session: { id: string; enrolmentOnly: boolean } } };
  expect(body.data.step).toBe('enrol');
  expect(body.data.session.enrolmentOnly).toBe(true);
  expect(login.headers()['set-cookie']).toBeUndefined();

  await expect(page).toHaveURL(adminUrl('/enrol'));
  await expect(page.getByText('Set up a sign-in method', { exact: true })).toBeVisible();
  await expect(
    page.getByText(`${staff.email} needs a passkey or an authenticator app to use the admin app. Add one, then sign in again with it.`),
  ).toBeVisible();
  const name = page.getByLabel('Passkey name');
  await expect(name).toHaveAttribute('placeholder', 'e.g. Work laptop');
  await expect(name).toHaveAttribute('maxlength', '64');
  await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Use an authenticator app' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Overview' })).toHaveCount(0);

  expect(await browserStaffCookie(context)).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('chumbaq_staff_signed_in'))).toBeNull();
  const [started] = await auditRows(staff.userId, since, 'staff.enrolment_started');
  expect(started.metadata).toEqual({ sessionId: body.data.session.id });
});

test('ADMAUTH-061 add the first passkey on /enrol', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  // Another enrolment session of theirs, and an operator's code nobody used.
  const other = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password });
  expect(other.data.step).toBe('enrol');
  const code = await issueEnrolmentCode(staff.userId);
  await addAuthenticator(page);
  const login = await passwordStep(page, staff.email, staff.password);
  const enrolling = ((await login.json()) as { data: { session: { id: string } } }).data.session.id;
  await expect(page).toHaveURL(adminUrl('/enrol'));
  const since = new Date();

  const held = await hold(page, '/api/staff/auth/passkeys/options');
  const optionsResponse = page.waitForResponse(isStaffCall('/api/staff/auth/passkeys/options'));
  const added = await recordAnswers(page, '/api/staff/auth/passkeys', 'POST');
  await page.getByLabel('Passkey name').fill('Work laptop');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('button', { name: 'Waiting for your passkey...' })).toBeDisabled();
  held.release();

  const options = ((await (await optionsResponse).json()) as { data: { options: any } }).data.options;
  expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  expect(options.attestation).toBe('none');
  expect(options.user.name).toBe(staff.email);
  await expect(page).toHaveURL(adminUrl('/sign-in?enrolled=passkey'));
  expect(added).toEqual([{ status: 200, body: { data: { enrolled: true, signInAgain: true } } }]);
  await expect(page.getByRole('status')).toHaveText('Done. Sign in with your new passkey.');

  const keys = await sql<{ name: string; scope: string }>(`SELECT name, scope FROM webauthn_credentials WHERE user_id = $1`, [staff.userId]);
  expect(keys).toEqual([{ name: 'Work laptop', scope: 'staff' }]);
  expect((await staffSession(enrolling)).revoked_reason).toBe('enrolled');
  expect((await staffSession(other.data.session.id)).revoked_reason).toBe('factor_changed');
  expect((await allowance(code.id)).voided_reason).toBe('enrolled');
  expect(await authEvents({ userId: staff.userId }, since, 'passkey.added')).toHaveLength(1);
  const [audit] = await auditRows(staff.userId, since, 'staff.factor_added');
  expect(audit.metadata).toEqual({ method: 'webauthn', name: 'Work laptop', sessionId: enrolling });
});

test('ADMAUTH-065 synced passkey refused for staff', async ({ page, clientIp }) => {
  test.slow(); // Starts two more admin APIs, one with each setting.
  const staff = await makeStaff(clientIp);
  const register = '/api/staff/auth/passkeys';
  // The setting is the admin API's: the registration goes to one started with it off,
  // then to one started with it on, whatever the lane's .env says.
  const refusing = await startAdminApiWith({ SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS: 'false' }, 'synced-refused');
  let allowing: ExtraAdminApi | undefined;
  try {
    const authenticator = await addAuthenticator(page, { synced: true });
    await forwardToAdminApi(page, refusing.url, [register]);
    const login = await passwordStep(page, staff.email, staff.password);
    const enrolling = ((await login.json()) as { data: { session: { id: string } } }).data.session.id;
    await expect(page).toHaveURL(adminUrl('/enrol'));

    const [refused] = await Promise.all([
      page.waitForResponse(isStaffCall(register, 'POST')),
      page.getByRole('button', { name: 'Add a passkey' }).click(),
    ]);
    expect(refused.status()).toBe(400);
    await expect(page.getByRole('alert')).toHaveText(SYNCED_REFUSED);
    await expect(page).toHaveURL(adminUrl('/enrol'));
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeEnabled();
    expect(await staffKeyCount(staff.userId)).toBe(0);
    expect((await staffSession(enrolling)).revoked_at).toBeNull();

    // With SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS=true the same kind of key is taken, and listed as synced.
    allowing = await startAdminApiWith({ SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS: 'true' }, 'synced-allowed');
    await page.unroute(adminUrl(register));
    await forwardToAdminApi(page, allowing.url, [register]);
    await authenticator.clearCredentials(); // The refused key was made on the device all the same.
    await page.getByLabel('Passkey name').fill('Synced key');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page).toHaveURL(adminUrl('/sign-in?enrolled=passkey'));
    const [key] = await sql<{ device_type: string; backed_up: boolean }>(
      `SELECT device_type, backed_up FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`,
      [staff.userId],
    );
    expect(key).toEqual({ device_type: 'multiDevice', backed_up: true });

    await signInStaffInPage(page);
    await sidebarLink(page, 'Your account').click();
    await expect(passkeyRow(page, 'Synced key')).toContainText(' · synced');
  } finally {
    await refusing.stop();
    await allowing?.stop();
  }
});

test('ADMAUTH-069 add an authenticator app on /enrol', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const origin = new URL(adminUrl('/')).origin;
  const elsewhere: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) elsewhere.push(url);
  });
  // Another enrolment session of theirs, which the new factor ends too.
  const other = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password });
  expect(other.data.step).toBe('enrol');
  const login = await passwordStep(page, staff.email, staff.password);
  const enrolling = ((await login.json()) as { data: { session: { id: string } } }).data.session.id;
  await expect(page).toHaveURL(adminUrl('/enrol'));
  const since = new Date();

  const held = await hold(page, '/api/staff/auth/totp/setup');
  await page.getByRole('button', { name: 'Use an authenticator app' }).click();
  await expect(page.getByRole('button', { name: 'Starting...' })).toBeDisabled();
  held.release();
  await expect(page.getByText('Scan this with your authenticator app, or enter the key by hand. Then type the code it shows.')).toBeVisible();
  const secret = (await page.locator('code').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{16,}=*$/);
  const qr = page.locator('svg[width="160"]');
  await expect(qr).toBeVisible();
  expect(await decodeQrOnPage(qr.locator('..'))).toContain(`secret=${secret}`);
  await expect(page.getByRole('button', { name: 'Copy key' })).toBeVisible();

  await page.getByLabel('Code from your authenticator app').fill(totpCode(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page).toHaveURL(adminUrl('/sign-in?enrolled=totp'));
  await expect(page.getByRole('status')).toHaveText('Done. Sign in with your authenticator app.');

  const [secretRow] = await sql<{ confirmed_at: Date | null }>(`SELECT confirmed_at FROM totp_secrets WHERE user_id = $1`, [staff.userId]);
  expect(secretRow.confirmed_at).not.toBeNull();
  expect((await staffSession(enrolling)).revoked_reason).toBe('enrolled');
  expect((await staffSession(other.data.session.id)).revoked_reason).toBe('factor_changed');
  expect(await authEvents({ userId: staff.userId }, since, 'totp.enabled')).toHaveLength(1);
  const [audit] = await auditRows(staff.userId, since, 'staff.factor_added');
  expect(audit.metadata).toEqual({ method: 'totp', sessionId: enrolling });
  expect(await sql(`SELECT id FROM recovery_codes WHERE user_id = $1`, [staff.userId])).toHaveLength(0);
  await expect(page.getByText(/recovery code/i)).toHaveCount(0);

  // The password now leads to the code.
  const next = await passwordStep(page, staff.email, staff.password);
  expect(((await next.json()) as { data: { methods: string[] } }).data.methods).toEqual(['totp']);
  await expect(page.getByLabel('Code from your authenticator app')).toBeVisible();
  expect(elsewhere).toEqual([]);
});

test('ADMAUTH-074 enrolment session reaches only its seven routes', async ({ clientIp }) => {
  const staff = await makeStaff(clientIp);
  const login = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: clientIp });
  expect(login.data.step).toBe('enrol');
  const token: string = login.data.accessToken;
  const as = { token, ip: clientIp };

  const refused: Array<[string, string, unknown?]> = [
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/tenants'],
    ['POST', `/api/admin/tenants/${randomUUID()}/impersonate`, { reason: 'Checking the enrolment session' }],
    ['POST', '/api/staff/auth/reauth/passkey/options', {}],
    ['POST', '/api/staff/auth/reauth/totp', { code: '123456' }],
    ['DELETE', `/api/staff/auth/passkeys/${randomUUID()}`],
    ['DELETE', '/api/staff/auth/totp'],
  ];
  for (const [method, pathname, body] of refused) {
    const answer = await staffApi(method, pathname, body, as);
    expect(answer.status, `${method} ${pathname}`).toBe(403);
    expect(answer.body.message, `${method} ${pathname}`).toBe(ENROLMENT_ONLY);
  }

  const me = await staffApi('GET', '/api/staff/auth/me', undefined, as);
  expect(me.status).toBe(200);
  expect(me.data.enrolmentOnly).toBe(true);
  expect(me.data.email).toBe(staff.email);
  const factors = await staffApi('GET', '/api/staff/auth/factors', undefined, as);
  expect(factors.status).toBe(200);
  expect(factors.data.passkeys).toEqual([]);
  const options = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, as);
  expect(options.status).toBe(200);
  expect(options.data.options.challenge).toBeTruthy();
  expect((await staffApi('POST', '/api/staff/auth/session/logout', {}, as)).status).toBe(204);
  expect((await staffSession(login.data.session.id)).revoked_reason).toBe('signed_out');
});

test('ADMAUTH-080 enrolment after the staff grant is revoked', async ({ clientIp }) => {
  test.slow(); // The revoke runs through the CLI.
  const staff = await makeStaff(clientIp);
  const login = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: clientIp });
  expect(login.data.step).toBe('enrol');
  const as = { token: login.data.accessToken as string, ip: clientIp };
  expect((await staffApi('POST', '/api/staff/auth/passkeys/options', {}, as)).status).toBe(200);

  await revokeStaffWithCli(staff.email);
  const refused = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, as);
  expect(refused.status).toBe(401);
  expect(refused.body.message).toBe(ENDED);
  const totp = await staffApi('POST', '/api/staff/auth/totp/setup', {}, as);
  expect(totp.status).toBe(401);
  expect(await staffKeyCount(staff.userId)).toBe(0);
  expect(await sql(`SELECT user_id FROM totp_secrets WHERE user_id = $1`, [staff.userId])).toHaveLength(0);
});

// ---- Session: cookie, refresh, reload, endings

test('ADMAUTH-081 access token lives in memory only', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();

  const stored = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
    cookie: document.cookie,
  }));
  expect(stored.session).toEqual({ chumbaq_staff_signed_in: '1' });
  const everything = JSON.stringify(stored);
  expect(everything).not.toContain('eyJ');
  expect(everything).not.toContain(signedIn.accessToken);
  expect(everything).not.toContain(signedIn.session.id);
  expect(stored.cookie).not.toContain('chumbaq_staff_refresh');
});

test('ADMAUTH-082 staff refresh cookie attributes', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const [verified] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/passkey/verify')),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  expect(verified.status()).toBe(200);
  const session = ((await verified.json()) as { data: { session: { id: string; expiresAt: string } } }).data.session;
  const setCookies = (await verified.headersArray()).filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);

  const issued = setCookies.find((value) => value.startsWith('__Host-chumbaq_staff_refresh='));
  expect(issued, JSON.stringify(setCookies)).toBeDefined();
  const attributes = issued!.split(';').map((part) => part.trim());
  const value = attributes[0].slice('__Host-chumbaq_staff_refresh='.length);
  expect(value).toMatch(new RegExp(`^${session.id}\\.[A-Za-z0-9_-]{43}$`));
  expect(attributes).toContain('Path=/');
  expect(attributes).toContain('HttpOnly');
  expect(attributes).toContain('Secure');
  expect(attributes).toContain('SameSite=Strict');
  expect(attributes.some((part) => /^Domain=/i.test(part))).toBe(false);
  const maxAge = Number(attributes.find((part) => part.startsWith('Max-Age='))?.split('=')[1]);
  const untilEnd = (new Date(session.expiresAt).getTime() - Date.now()) / 1000;
  expect(Math.abs(maxAge - untilEnd)).toBeLessThan(60);
  expect(maxAge).toBeGreaterThan(60 * 60);

  // The bare name is cleared on its old path alongside.
  const bare = setCookies.find((cookie) => cookie.startsWith('chumbaq_staff_refresh='));
  expect(bare).toBeDefined();
  expect(bare).toMatch(/^chumbaq_staff_refresh=;/);
  expect(bare).toContain('Path=/api/staff/auth/session');
  expect(bare).toContain('Expires=Thu, 01 Jan 1970');

  const [stored] = (await context.cookies(adminUrl('/'))).filter((c) => c.name === '__Host-chumbaq_staff_refresh');
  expect(stored).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/', domain: 'localhost' });
  expect(stored.value).toBe(value);
  expect(tokenHash(value)).toBe((await staffSession(session.id)).current_token_hash);
});

test('ADMAUTH-083 reload keeps the session', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await sidebarLink(page, 'Tenants').click();
  await expect(heading(page, 'Tenants')).toBeVisible();
  const before = await staffSession(signedIn.session.id);
  const oldPair = (await browserStaffCookie(context))!;
  expect(tokenHash(cookieValue(oldPair))).toBe(before.current_token_hash);
  const since = new Date();

  const refreshes = watchResponses(page, REFRESH);
  const order: string[] = [];
  page.on('request', (request) => {
    const pathname = pathOf(request.url());
    if (pathname.startsWith('/api/')) order.push(pathname);
  });
  const held = await hold(page, REFRESH);
  await page.reload();
  await expect(page.locator('.animate-spin')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
  held.release();
  await expect(heading(page, 'Tenants')).toBeVisible();
  await expect(page).toHaveURL(adminUrl('/tenants'));

  expect(refreshes).toHaveLength(1);
  const [refreshed] = refreshes;
  expect(refreshed.status()).toBe(200);
  const body = ((await refreshed.json()) as { data: { accessToken: string; session: { id: string } } }).data;
  expect(body.accessToken).toBeTruthy();
  expect(body.session.id).toBe(signedIn.session.id);
  expect((await refreshed.headerValue('set-cookie')) ?? '').toMatch(/^(__Host-)?chumbaq_staff_refresh=[^;]+/);
  expect(order.slice(0, 2)).toEqual([REFRESH, '/api/staff/auth/me']);

  const newPair = (await browserStaffCookie(context))!;
  expect(newPair).not.toBe(oldPair);
  const after = await staffSession(signedIn.session.id);
  expect(after.revoked_at).toBeNull();
  expect(after.previous_token_hash).toBe(before.current_token_hash);
  expect(after.current_token_hash).toBe(tokenHash(cookieValue(newPair)));
  expect(await authEvents({ userId: staff.userId }, since, 'refresh.succeeded')).toHaveLength(1);

  // A refresh on its own does not count as activity.
  await sql(`UPDATE staff_sessions SET last_active_at = now() - interval '5 minutes' WHERE id = $1`, [signedIn.session.id]);
  const idleSince = (await staffSession(signedIn.session.id)).last_active_at;
  expect((await staffApi('POST', REFRESH, {}, { cookie: newPair })).status).toBe(200);
  expect((await staffSession(signedIn.session.id)).last_active_at).toEqual(idleSince);
});

test('ADMAUTH-088 replayed refresh token ends the session', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  const first = (await browserStaffCookie(context))!;
  await page.reload();
  await expect(heading(page, 'Overview')).toBeVisible();
  const second = (await browserStaffCookie(context))!;
  expect(second).not.toBe(first);
  await sql(`UPDATE staff_sessions SET rotated_at = now() - interval '31 seconds' WHERE id = $1`, [signedIn.session.id]);
  const since = new Date();

  const replay = await staffApi('POST', REFRESH, {}, { cookie: first });
  expect(replay.status).toBe(401);
  expect(replay.body.message).toBe(ENDED);
  expect(clearingCookie(replay.setCookies), JSON.stringify(replay.setCookies)).toBeDefined();
  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('replay');
  expect(await authEvents({ userId: staff.userId }, since, 'refresh.reuse_detected')).toHaveLength(1);
  const [revoked] = await auditRows(staff.userId, since, 'staff.session_revoked');
  expect(revoked.metadata).toEqual({ reason: 'replay', sessionId: signedIn.session.id });

  // The tab holding the newer token is signed out at its next request.
  await sidebarLink(page, 'Tenants').click();
  await expect(page).toHaveURL(adminUrl('/sign-in?reason=ended'));
  await expect(page.getByRole('status')).toHaveText(ENDED);
});

test('ADMAUTH-089 idle timeout signs the tab out', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await sidebarLink(page, 'Tenants').click();
  await expect(heading(page, 'Tenants')).toBeVisible();
  await sql(`UPDATE staff_sessions SET last_active_at = now() - make_interval(secs => $2) WHERE id = $1`, [
    signedIn.session.id,
    signedIn.session.idleTimeoutSeconds + 60,
  ]);
  const since = new Date();
  const refreshes = watchResponses(page, REFRESH);
  const audit = await recordAnswers(page, '/api/admin/audit-logs');

  await sidebarLink(page, 'Audit log').click();
  // `?reason=idle` is what the client makes of the refresh answering the idle message.
  await expect(page).toHaveURL(adminUrl('/sign-in?reason=idle'));
  await expect(page.getByRole('status')).toHaveText(IDLE);

  expect(audit.length).toBeGreaterThanOrEqual(1);
  expect(audit[0].status).toBe(401);
  expect(audit[0].body.message).toBe(IDLE);
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0].status()).toBe(401);
  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('idle');
  expect((await authEvents({ userId: staff.userId }, since, 'refresh.failed')).map((row) => row.reason)).toEqual(['staff_idle']);
  expect(await browserStaffCookie(context)).toBeNull();
});

test('ADMAUTH-093 session ends at its maximum age however active', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const inTab = await signInStaffInPage(page);
  const byApi = await staffPasskeySignIn(page);
  const row = await staffSession(inTab.session.id);
  const maxAgeSeconds = Math.round((new Date(inTab.session.expiresAt).getTime() - row.created_at.getTime()) / 1000);
  for (const id of [inTab.session.id, byApi.session.id]) {
    await sql(`UPDATE staff_sessions SET created_at = now() - make_interval(secs => $2), last_active_at = now() WHERE id = $1`, [
      id,
      maxAgeSeconds + 60,
    ]);
  }
  const since = new Date();

  await sidebarLink(page, 'Tenants').click();
  await expect(page).toHaveURL(adminUrl('/sign-in?reason=ended'));
  await expect(page.getByRole('status')).toHaveText(ENDED);
  expect((await staffSession(inTab.session.id)).revoked_reason).toBe('expired');

  const refused = await staffApi('POST', REFRESH, {}, { cookie: byApi.cookie });
  expect(refused.status).toBe(401);
  expect(refused.body.message).toBe(ENDED);
  expect((await staffSession(byApi.session.id)).revoked_reason).toBe('expired');
  const failed = await sql<{ session_id: string; reason: string }>(
    `SELECT session_id, reason FROM auth_events WHERE user_id = $1 AND type = 'refresh.failed' AND created_at >= $2 ORDER BY created_at`,
    [staff.userId, since],
  );
  expect(failed).toEqual([
    { session_id: inTab.session.id, reason: 'staff_session_expired' },
    { session_id: byApi.session.id, reason: 'staff_session_expired' },
  ]);
});

test('ADMAUTH-095 revoking staff access ends the session at its next request', async ({ page, clientIp }) => {
  test.slow(); // The revoke runs through the CLI.
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();

  await revokeStaffWithCli(staff.email);
  const tenants = await recordAnswers(page, '/api/admin/tenants');
  const refreshes = await recordAnswers(page, REFRESH);
  await sidebarLink(page, 'Tenants').click();
  await expect(page).toHaveURL(adminUrl('/sign-in?reason=ended'));
  await expect(page.getByRole('status')).toHaveText(ENDED);
  expect(tenants.length).toBeGreaterThanOrEqual(1);
  expect(tenants[0].status).toBe(401);
  expect(tenants[0].body.message).toBe(ENDED);
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0].status).toBe(401);
  expect(refreshes[0].body.message).toBe(ENDED);
  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('staff_revoked');

  const [passkey] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/passkey/verify')),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  expect(passkey.status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(NOT_RECOGNISED);

  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password', { exact: true }).fill(staff.password);
  const [password] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/login')),
    page.getByRole('button', { name: 'Continue' }).click(),
  ]);
  expect(password.status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(INVALID_LOGIN);
  await expect(page).toHaveURL(/\/sign-in/);
});

test('ADMAUTH-096 session version bump ends staff sessions', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await staffPasskeySignIn(page);
  expect((await staffApi('GET', '/api/staff/auth/me', undefined, { token: signedIn.accessToken })).status).toBe(200);
  await sql(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [staff.userId]);
  const since = new Date();

  const me = await staffApi('GET', '/api/staff/auth/me', undefined, { token: signedIn.accessToken });
  expect(me.status).toBe(401);
  expect(me.body.message).toBe(ENDED);
  const refreshed = await staffApi('POST', REFRESH, {}, { cookie: signedIn.cookie });
  expect(refreshed.status).toBe(401);
  expect(refreshed.body.message).toBe(ENDED);
  expect(clearingCookie(refreshed.setCookies)).toBeDefined();
  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('session_version');
  expect((await authEvents({ userId: staff.userId }, since, 'refresh.failed')).map((row) => row.reason)).toEqual(['staff_session_version']);
});

// ---- Gate and routing

test('ADMAUTH-102 anonymous deep links go to sign-in, and sign-in goes to Overview', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const adminCalls: string[] = [];
  page.on('request', (request) => {
    if (pathOf(request.url()).startsWith('/api/admin/')) adminCalls.push(request.url());
  });

  for (const pathname of ['/tenants', `/tenants/${randomUUID()}`, '/audit-log', '/account', '/enrol', '/billing']) {
    await page.goto(adminUrl('/sign-in'));
    const entries = await page.evaluate(() => history.length);
    await page.goto(adminUrl(pathname));
    await expect(page, pathname).toHaveURL(adminUrl('/sign-in'));
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
    // The protected page's entry was replaced, so Back cannot return to it.
    expect(await page.evaluate(() => history.length), pathname).toBe(entries + 1);
  }
  expect(adminCalls).toEqual([]);

  await page.goto(adminUrl('/audit-log'));
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await signInStaffInPage(page);
  await expect(page).toHaveURL(adminUrl('/'));
  await expect(heading(page, 'Overview')).toBeVisible();
});

test('ADMAUTH-109 back after sign-out does not show admin data', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'listed-tenant');
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await sidebarLink(page, 'Tenants').click();
  await page.getByPlaceholder('Search by email or name...').fill(tenant.email);
  const tenantCell = page.getByRole('link', { name: tenant.email });
  await expect(tenantCell).toBeVisible();

  const succeeded: string[] = [];
  let signedOut = false;
  page.on('response', (response) => {
    if (signedOut && pathOf(response.url()).startsWith('/api/admin/') && response.ok()) succeeded.push(response.url());
  });
  signedOut = true;
  await page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(adminUrl('/sign-in'));

  await page.goBack();
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(page.getByText(tenant.email)).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('chumbaq_staff_signed_in'))).toBeNull();
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(succeeded).toEqual([]);
});

test('ADMAUTH-114 sign out from the sidebar', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  const cookie = (await browserStaffCookie(context))!;
  const since = new Date();

  const [logout] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/session/logout')),
    page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: 'Sign out' }).click(),
  ]);
  expect(logout.status()).toBe(204);
  const setCookies = (await logout.headersArray()).filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
  expect(clearingCookie(setCookies), JSON.stringify(setCookies)).toBeDefined();
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('chumbaq_staff_signed_in'))).toBeNull();
  expect(await browserStaffCookie(context)).toBeNull();

  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('signed_out');
  const [audit] = await auditRows(staff.userId, since, 'staff.signed_out');
  expect(audit.metadata).toEqual({ sessionId: signedIn.session.id });
  expect(await authEvents({ userId: staff.userId }, since, 'logout')).toHaveLength(1);
  const after = await staffApi('POST', REFRESH, {}, { cookie });
  expect(after.status).toBe(401);
  expect(after.body.message).toBe(ENDED);
});

// ---- API client

test('ADMAUTH-118 an expired access token is refreshed once and the request resent', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();

  const bearers: string[] = [];
  let refusedOnce = false;
  await page.route(
    (url) => url.pathname === '/api/admin/tenants',
    async (route) => {
      bearers.push((await route.request().allHeaders())['authorization'] ?? '');
      if (!refusedOnce) {
        refusedOnce = true;
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Unauthorized' }) });
        return;
      }
      await route.fallback();
    },
  );
  const refreshes = watchResponses(page, REFRESH);
  // A token issued in the same second as the sign-in's would be the same token.
  const issuedAt = jwtClaims(signedIn.accessToken).iat as number;
  await expect.poll(() => Math.floor(Date.now() / 1000)).toBeGreaterThan(issuedAt);

  await sidebarLink(page, 'Tenants').click();
  await expect(heading(page, 'Tenants')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page).toHaveURL(adminUrl('/tenants'));
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0].status()).toBe(200);
  const fresh = ((await refreshes[0].json()) as { data: { accessToken: string } }).data.accessToken;
  expect(bearers).toHaveLength(2);
  expect(bearers[0]).toMatch(/^Bearer /);
  expect(bearers[1]).toBe(`Bearer ${fresh}`);
  expect(bearers[1]).not.toBe(bearers[0]);
});

test('ADMAUTH-121 re-authentication dialog opens on "Confirm it is you to continue." and the action resumes', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const authenticator = await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await sql(`UPDATE staff_sessions SET authenticated_at = now() - interval '5 minutes' WHERE id = $1`, [signedIn.session.id]);
  const before = await staffSession(signedIn.session.id);
  const since = new Date();
  await sidebarLink(page, 'Your account').click();
  await expect(heading(page, 'Your account')).toBeVisible();
  const aside = await setAsideKeysForRegistration(page, authenticator);

  const refused = page.waitForResponse((r) => pathOf(r.url()) === '/api/staff/auth/passkeys/options' && r.status() === 403);
  const reauthOptions = page.waitForResponse(isStaffCall('/api/staff/auth/reauth/passkey/options'));
  const reauthVerify = page.waitForResponse(isStaffCall('/api/staff/auth/reauth/passkey/verify'));
  const resent = page.waitForResponse((r) => pathOf(r.url()) === '/api/staff/auth/passkeys/options' && r.status() === 200);
  const registered = page.waitForResponse(isStaffCall('/api/staff/auth/passkeys', 'POST'));
  await page.getByLabel('Name', { exact: true }).fill('Second key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();

  expect(((await (await refused).json()) as { message: string }).message).toBe(REAUTH);
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('This is a sensitive action, so we need to check it is still you.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Use passkey' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(dialog.getByLabel('Code from your authenticator app')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  expect((await reauthOptions).status()).toBe(200);
  const verified = await reauthVerify;
  expect(verified.status()).toBe(200);
  const reauthToken = ((await verified.json()) as { data: { accessToken: string } }).data.accessToken;
  await expect(dialog).toBeHidden();
  const again = await resent;
  expect((await again.request().allHeaders())['authorization']).toBe(`Bearer ${reauthToken}`);
  expect((await registered).status()).toBe(200);
  await expect(page.getByText('Passkey added', { exact: true }).first()).toBeVisible();
  await aside.restore();

  const after = await staffSession(signedIn.session.id);
  expect(after.authenticated_at!.getTime()).toBeGreaterThan(before.authenticated_at!.getTime());
  expect(after.amr).toContain('webauthn');
  expect((await authEvents({ userId: staff.userId }, since, 'reauth.succeeded')).map((row) => row.reason)).toEqual(['webauthn']);
  expect(await staffKeyCount(staff.userId)).toBe(2);
});

// ---- /account

test('ADMAUTH-131 add a second passkey in a full session', async ({ page, browser, baseURL, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const authenticator = await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);

  // A second staff session, in another browser holding the same key.
  const other = await newPersonContext(browser, baseURL);
  try {
    const otherPage = await other.context.newPage();
    const otherAuthenticator = await addAuthenticator(otherPage);
    await copyCredentials(authenticator, otherAuthenticator);
    await otherPage.goto(adminUrl('/sign-in'));
    const otherSession = await signInStaffInPage(otherPage);
    // Both tabs' copies of the key count from where they were copied: let the next use pass.
    await sql(`UPDATE webauthn_credentials SET counter = 0 WHERE user_id = $1`, [staff.userId]);
    const since = new Date();

    await sidebarLink(page, 'Your account').click();
    await expect(passkeyRow(page, 'E2E staff key')).toBeVisible();
    await expect(passkeyRow(page, 'E2E staff key').getByRole('button', { name: 'Remove' })).toBeDisabled();
    const aside = await setAsideKeysForRegistration(page, authenticator);
    const registered = page.waitForResponse(isStaffCall('/api/staff/auth/passkeys', 'POST'));
    const name = page.getByLabel('Name', { exact: true });
    await name.fill('Backup key');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    const added = await registered;
    expect(added.status()).toBe(200);
    expect(((await added.json()) as { data: unknown }).data).toEqual({ enrolled: true, signInAgain: false });
    await expect(page.getByText('Passkey added', { exact: true }).first()).toBeVisible();
    await aside.restore();

    await expect(passkeyRow(page, 'Backup key')).toBeVisible();
    await expect(passkeyRow(page, 'E2E staff key')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(2);
    for (const remove of await page.getByRole('button', { name: 'Remove' }).all()) await expect(remove).toBeEnabled();
    await expect(name).toHaveValue('');
    await expect(page).toHaveURL(adminUrl('/account'));
    expect((await staffSession(signedIn.session.id)).revoked_at).toBeNull();
    expect((await staffSession(otherSession.session.id)).revoked_reason).toBe('factor_changed');
    const [audit] = await auditRows(staff.userId, since, 'staff.factor_added');
    expect(audit.metadata).toEqual({ method: 'webauthn', name: 'Backup key', sessionId: signedIn.session.id });

    // The proof was spent: another add asks again.
    await name.fill('Third key');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alert')).toHaveText(REAUTH);
    expect(await staffKeyCount(staff.userId)).toBe(2);

    // The other browser's session ended with the change.
    await sidebarLink(otherPage, 'Tenants').click();
    await expect(otherPage).toHaveURL(adminUrl('/sign-in?reason=ended'));
  } finally {
    await other.context.close();
  }
});

test('ADMAUTH-135 remove a passkey after confirming', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await seedStaffPasskeyRow(staff.userId, 'Backup key');
  const signedIn = await signInStaffInPage(page);
  const other = await staffPasskeySignIn(page);
  const since = new Date();

  await sidebarLink(page, 'Your account').click();
  const backup = passkeyRow(page, 'Backup key');
  await expect(backup.getByRole('button', { name: 'Remove' })).toBeEnabled();
  const refused = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.status() === 403);
  const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.status() !== 403);
  await backup.getByRole('button', { name: 'Remove' }).click();
  expect(((await (await refused).json()) as { message: string }).message).toBe(REAUTH);
  await page.getByRole('dialog', { name: 'Confirm it is you' }).getByRole('button', { name: 'Use passkey' }).click();
  expect((await removed).status()).toBe(204);
  await expect(page.getByText('Passkey removed', { exact: true }).first()).toBeVisible();

  await expect(passkeyRow(page, 'Backup key')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(1);
  await expect(passkeyRow(page, 'E2E staff key').getByRole('button', { name: 'Remove' })).toBeDisabled();
  expect(await staffKeyCount(staff.userId)).toBe(1);
  expect((await staffSession(signedIn.session.id)).revoked_at).toBeNull();
  expect((await staffSession(other.session.id)).revoked_reason).toBe('factor_changed');
  expect(await authEvents({ userId: staff.userId }, since, 'passkey.removed')).toHaveLength(1);
  const [audit] = await auditRows(staff.userId, since, 'staff.factor_removed');
  expect(audit.metadata).toEqual({ method: 'webauthn', name: 'Backup key', sessionId: signedIn.session.id });
});

test('ADMAUTH-137 removing the last sign-in method is refused', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await staffPasskeySignIn(page);
  const proven = await reauthWithPasskey(page, signedIn.accessToken);
  const [key] = await sql<{ id: string }>(`SELECT id FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`, [staff.userId]);

  const refused = await staffApi('DELETE', `/api/staff/auth/passkeys/${key.id}`, undefined, { token: proven });
  expect(refused.status).toBe(409);
  expect(refused.body.message).toBe(LAST_FACTOR);
  expect(await staffKeyCount(staff.userId)).toBe(1);

  const again = await staffApi('DELETE', `/api/staff/auth/passkeys/${key.id}`, undefined, { token: proven });
  expect(again.status).toBe(403);
  expect(again.body.message).toBe(REAUTH);
});

test('ADMAUTH-139 remove a passkey that is not yours', async ({ page, clientIp }) => {
  const a = await makeStaff(clientIp, 'staff-a');
  const b = await makeStaff(clientIp, 'staff-b');
  await enrolStaffPasskey(page, a);
  const bKey = await seedStaffPasskeyRow(b.userId, 'B key');
  await seedCustomerPasskeyRow(a.userId);
  const [aCustomerKey] = await sql<{ id: string }>(`SELECT id FROM webauthn_credentials WHERE user_id = $1 AND scope = 'customer'`, [a.userId]);
  const signedIn = await staffPasskeySignIn(page);
  const count = async () => Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM webauthn_credentials WHERE user_id IN ($1, $2)`, [a.userId, b.userId]))[0].n);
  const before = await count();

  let token = await reauthWithPasskey(page, signedIn.accessToken);
  const others = await staffApi('DELETE', `/api/staff/auth/passkeys/${bKey}`, undefined, { token });
  expect(others.status).toBe(404);
  expect(others.body.message).toBe('Passkey not found');
  // The probe spent the proof.
  const spent = await staffApi('DELETE', `/api/staff/auth/passkeys/${aCustomerKey.id}`, undefined, { token });
  expect(spent.status).toBe(403);
  expect(spent.body.message).toBe(REAUTH);

  token = await reauthWithPasskey(page, token);
  const customerKey = await staffApi('DELETE', `/api/staff/auth/passkeys/${aCustomerKey.id}`, undefined, { token });
  expect(customerKey.status).toBe(404);
  expect(customerKey.body.message).toBe('Passkey not found');
  const spentAgain = await staffApi('DELETE', `/api/staff/auth/passkeys/${bKey}`, undefined, { token });
  expect(spentAgain.status).toBe(403);
  expect(spentAgain.body.message).toBe(REAUTH);

  const malformed = await staffApi('DELETE', '/api/staff/auth/passkeys/not-a-uuid', undefined, { token });
  expect(malformed.status).toBe(400);
  expect(malformed.body.message).toBe('Validation failed (uuid is expected)');
  expect(await count()).toBe(before);
});

test('ADMAUTH-141 proof is bound to the session', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const backup = await seedStaffPasskeyRow(staff.userId, 'Backup key');
  const s1 = await staffPasskeySignIn(page);
  const s2 = await staffPasskeySignIn(page);

  const s1Proven = await reauthWithPasskey(page, s1.accessToken);
  const elsewhere = await staffApi('DELETE', `/api/staff/auth/passkeys/${backup}`, undefined, { token: s2.accessToken });
  expect(elsewhere.status).toBe(403);
  expect(elsewhere.body.message).toBe(REAUTH);
  expect(await staffKeyCount(staff.userId)).toBe(2);

  expect((await staffApi('POST', '/api/staff/auth/session/logout', {}, { token: s1Proven })).status).toBe(204);
  const afterSignOut = await staffApi('DELETE', `/api/staff/auth/passkeys/${backup}`, undefined, { token: s1Proven });
  expect(afterSignOut.status).toBe(401);
  expect(afterSignOut.body.message).toBe(ENDED);
  expect(await staffKeyCount(staff.userId)).toBe(2);
});

// ---- Tokens

test('ADMAUTH-156 tampered or mismatched staff tokens are refused', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await staffPasskeySignIn(page);
  const claims = jwtClaims(signedIn.accessToken);
  const me = (token: string) => staffApi('GET', '/api/staff/auth/me', undefined, { token, ip: clientIp });

  // The hand-made token with the claims as issued works, so each refusal below is about its change.
  expect((await me(signHs256(claims, runStaffKey()))).status).toBe(200);

  const [head, body, signature] = signedIn.accessToken.split('.');
  const flipped = body.slice(0, 10) + (body[10] === 'A' ? 'B' : 'A') + body.slice(11);
  const cases: Array<[string, string]> = [
    ['a payload byte changed', `${head}.${flipped}.${signature}`],
    ['signed with the customer key', signHs256(claims, runSecrets().jwtSecret)],
    ['no audience', signHs256({ ...claims, aud: undefined }, runStaffKey())],
    ['expired', signHs256({ ...claims, iat: claims.exp - 700, exp: Math.floor(Date.now() / 1000) - 60 }, runStaffKey())],
  ];
  for (const [label, token] of cases) {
    expect((await me(token)).status, label).toBe(401);
  }
  const enrolmentClaim = await me(signHs256({ ...claims, enr: true }, runStaffKey()));
  expect(enrolmentClaim.status).toBe(401);
  expect(enrolmentClaim.body.message).toBe(ENDED);

  // None of them ended the session itself.
  expect((await me(signedIn.accessToken)).status).toBe(200);
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

  test('ADMAUTH-075 enrolment session cannot remove a factor', async ({ clientIp }) => {
    const staff = await makeStaff(clientIp);
    await enrolStaffTotpOnly(staff);
    const code = await issueEnrolmentCode(staff.userId);
    const login = await staffApi(
      'POST',
      '/api/staff/auth/login',
      { email: staff.email, password: staff.password, enrolmentCode: code.code },
      { base: required.url, ip: clientIp },
    );
    expect(login.status).toBe(200);
    expect(login.data.step).toBe('enrol');

    const refused = await staffApi('DELETE', '/api/staff/auth/totp', undefined, { token: login.data.accessToken, base: required.url });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe(ENROLMENT_ONLY);
    const [app] = await sql<{ confirmed_at: Date | null }>(`SELECT confirmed_at FROM totp_secrets WHERE user_id = $1`, [staff.userId]);
    expect(app.confirmed_at).not.toBeNull();
  });

  test('ADMAUTH-126 authenticator re-authentication refused while passkeys are required', async ({ page, clientIp }) => {
    test.slow(); // May wait for a fresh authenticator code.
    const staff = await makeStaff(clientIp);
    await enrolStaffPasskey(page, staff);
    const signedIn = await staffPasskeySignIn(page);
    const enrolment = await enrolStaffTotpInFullSession(page, signedIn.accessToken);
    const stepOf = async () =>
      (await sql<{ last_used_step: string | null }>(`SELECT last_used_step FROM totp_secrets WHERE user_id = $1`, [staff.userId]))[0].last_used_step;
    const before = await staffSession(signedIn.session.id);
    const stepBefore = await stepOf();

    const refused = await staffApi(
      'POST',
      '/api/staff/auth/reauth/totp',
      { code: await freshTotpCode(enrolment) },
      { token: signedIn.accessToken, base: required.url, ip: clientIp },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe(PASSKEY_NEEDED);
    expect(refused.body.data?.accessToken).toBeUndefined();
    expect((await staffSession(signedIn.session.id)).authenticated_at).toEqual(before.authenticated_at);
    expect(await stepOf()).toBe(stepBefore);

    // No proof was left: a factor change still asks for one.
    const change = await staffApi('DELETE', '/api/staff/auth/totp', undefined, { token: signedIn.accessToken, ip: clientIp });
    expect(change.status).toBe(403);
    expect(change.body.message).toBe(REAUTH);
  });

  test('ADMAUTH-138 two passkeys must stay while passkeys are required', async ({ page, clientIp }) => {
    const staff = await makeStaff(clientIp);
    await enrolStaffPasskey(page, staff);
    await seedStaffPasskeyRow(staff.userId, 'Backup key');
    await forwardPrefixToAdminApi(page, required.url, '/api/staff/auth/passkeys/');
    await signInStaffInPage(page);
    await sidebarLink(page, 'Your account').click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });

    const backup = passkeyRow(page, 'Backup key').getByRole('button', { name: 'Remove' });
    await expect(backup).toBeEnabled();
    const refused = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.status() === 409);
    await backup.click();
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    await refused;
    await expect(page.getByRole('alert')).toHaveText('Staff accounts must keep 2 passkeys. Add another before removing this one.');
    await expect(passkeyRow(page, 'Backup key')).toBeVisible();
    await expect(passkeyRow(page, 'E2E staff key')).toBeVisible();
    expect(await staffKeyCount(staff.userId)).toBe(2);

    // With three, one can go.
    await seedStaffPasskeyRow(staff.userId, 'Spare key');
    await page.reload();
    const spare = passkeyRow(page, 'Spare key').getByRole('button', { name: 'Remove' });
    const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.status() === 204);
    await spare.click();
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    await removed;
    await expect(page.getByText('Passkey removed', { exact: true }).first()).toBeVisible();
    await expect(passkeyRow(page, 'Spare key')).toHaveCount(0);
    expect(await staffKeyCount(staff.userId)).toBe(2);
  });

  test('ADMAUTH-144 adding anything is refused for a session that never showed a passkey', async ({ clientIp }) => {
    test.slow(); // Waits for a fresh authenticator code.
    const staff = await makeStaff(clientIp);
    const enrolment = await enrolStaffTotpOnly(staff);
    const { handle } = await staffHandle(staff);
    const signedIn = await staffApi('POST', '/api/staff/auth/login/totp', { handle, code: await freshTotpCode(enrolment) });
    expect(signedIn.status).toBe(200);
    const token: string = signedIn.data.accessToken;
    expect((await staffSession(signedIn.data.session.id)).amr).toEqual(['pwd', 'totp']);

    for (const pathname of ['/api/staff/auth/passkeys/options', '/api/staff/auth/totp/setup']) {
      const refused = await staffApi('POST', pathname, {}, { token, base: required.url, ip: clientIp });
      expect(refused.status, pathname).toBe(403);
      expect(refused.body.message, pathname).toBe(PASSKEY_NEEDED);
    }
    // Where passkeys are not required, the same session is only asked to confirm.
    const lane = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token, ip: clientIp });
    expect(lane.status).toBe(403);
    expect(lane.body.message).toBe(REAUTH);
    expect(await staffKeyCount(staff.userId)).toBe(0);
  });

  test('ADMAUTH-153 one staff passkey is not enough for admin pages', async ({ page, clientIp }) => {
    const staff = await makeStaff(clientIp);
    const authenticator = await enrolStaffPasskey(page, staff);
    await forwardPrefixToAdminApi(page, required.url, '/api/admin/');
    const overview = page.waitForResponse((r) => pathOf(r.url()) === '/api/admin/overview');
    await signInStaffInPage(page);

    const answer = await overview;
    expect(answer.status()).toBe(403);
    expect(((await answer.json()) as { message: string }).message).toBe(PASSKEY_REQUIRED);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Set up your passkeys to continue');
    await expect(alert).toContainText('Staff access needs two passkeys, and a sign-in that used one.');
    await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();

    await page.getByRole('link', { name: 'Go to your account' }).click();
    await expect(page).toHaveURL(adminUrl('/account'));
    await expect(heading(page, 'Your account')).toBeVisible();
    const aside = await setAsideKeysForRegistration(page, authenticator);
    const registered = page.waitForResponse(isStaffCall('/api/staff/auth/passkeys', 'POST'));
    await page.getByLabel('Name', { exact: true }).fill('Second staff key');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await page.getByRole('dialog', { name: 'Confirm it is you' }).getByRole('button', { name: 'Use passkey' }).click();
    expect((await registered).status()).toBe(200);
    await expect(passkeyRow(page, 'Second staff key')).toBeVisible();
    await aside.restore();
    expect(await staffKeyCount(staff.userId)).toBe(2);

    const loaded = page.waitForResponse((r) => pathOf(r.url()) === '/api/admin/overview' && r.status() === 200);
    await sidebarLink(page, 'Overview').click();
    await loaded;
    await expect(heading(page, 'Overview')).toBeVisible();
    await expect(page.getByText('Set up your passkeys to continue')).toHaveCount(0);
  });

  test('ADMAUTH-154 two passkeys but signed in without one', async ({ page, clientIp }) => {
    test.slow(); // Waits for fresh authenticator codes.
    const staff = await makeStaff(clientIp);
    await enrolStaffPasskey(page, staff);
    const first = await staffPasskeySignIn(page);
    const enrolment = await enrolStaffTotpInFullSession(page, first.accessToken);
    await seedStaffPasskeyRow(staff.userId, 'Backup key');
    const { handle } = await staffHandle(staff);
    const signedIn = await staffApi('POST', '/api/staff/auth/login/totp', { handle, code: await freshTotpCode(enrolment) });
    expect(signedIn.status).toBe(200);
    const sessionId: string = signedIn.data.session.id;
    expect((await staffSession(sessionId)).amr).toEqual(['pwd', 'totp']);
    const overview = (token: string) => staffApi('GET', '/api/admin/overview', undefined, { token, base: required.url, ip: clientIp });

    const refused = await overview(signedIn.data.accessToken);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe(PASSKEY_REQUIRED);

    const proven = await reauthWithPasskey(page, signedIn.data.accessToken, clientIp, required.url);
    expect((await staffSession(sessionId)).amr).toEqual(['pwd', 'totp', 'webauthn']);
    expect(jwtClaims(proven).amr).toEqual(['pwd', 'totp', 'webauthn']);
    expect((await overview(proven)).status).toBe(200);
  });
});


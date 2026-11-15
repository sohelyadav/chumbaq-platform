import { createHash, randomUUID } from 'crypto';
import type { Page, Response } from '@playwright/test';
import { adminUrl } from '../../support/admin';
import { createAccount, newClientIp, uniqueEmail } from '../../support/api';
import { addAuthenticator, totpCode } from '../../support/factors';
import { expect, newPersonContext, test } from '../../support/fixtures';
import {
  auditRows,
  authEvents,
  authEventsFromIp,
  browserAssertion,
  browserAttestation,
  challengeKey,
  enrolPasskeyByApi,
  enrolStaffPasskey,
  enrolStaffTotpOnly,
  forwardToAdminApi,
  issueEnrolmentCode,
  makeStaff,
  newDeviceAlerts,
  preAuthKey,
  redisDel,
  redisExists,
  runApiCli,
  seedCustomerPasskeyRow,
  signInStaffInPage,
  sql,
  staffApi,
  staffCookiePair,
  staffHandle,
  staffPasskeySignIn,
  staffPasskeySignInAs,
  staffSession,
  startAdminApiWith,
  startPasskeyRequiredAdminApi,
  type ExtraAdminApi,
} from '../../support/areas/admauth';

/**
 * Staff sign-in on the admin app, first P1 chunk: which routes the admin API serves, the
 * sign-in page and its notes, the password step and the second factor, passkey-first
 * sign-in, operator enrolment codes, the enrolment-only session and /enrol, and the staff
 * session's refresh, reload and endings.
 *
 * The lane's admin API runs with passkeys not required for staff. Cases for production's
 * setting start a second admin API with SUPER_ADMIN_PASSKEY_REQUIRED=true on the same
 * database and send chosen requests of the page there.
 */

const INVALID_LOGIN = 'Invalid email or password';
const HANDLE_EXPIRED = 'Your sign-in has expired. Please start again.';
const ENROLMENT_BLOCKED = 'Staff sign-in is not set up for this account. Enter the enrolment code from your operator.';
const PASSKEY_NEEDED = 'Staff sign-in needs a passkey. Use your passkey, or ask your operator for an enrolment code.';
const TOO_MANY = 'Too many failed attempts. Try again in a few minutes.';
const NOT_RECOGNISED = 'That passkey is not recognised.';
const CODE_REFUSED = 'That code is not right. Please try again.';
const PROMPT_CANCELLED = 'The passkey request was cancelled or timed out. Please try again.';
const UNREACHABLE_API = 'Could not reach the admin API. Check your connection and try again.';
const GENERIC_FAILURE = 'That did not work. Please try again.';
const ENDED = 'Your staff session has ended. Sign in again.';
const IDLE = 'Signed out after a period of inactivity.';
const TOO_SLOW = 'That took too long. Please try again.';
const NOT_VERIFIED = 'Could not verify that passkey.';
const THROTTLED = 'ThrottlerException: Too Many Requests';
const REFRESH = '/api/staff/auth/session/refresh';

const LINUX_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const WINDOWS_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

const customerApi = () => {
  const base = process.env.E2E_API_URL;
  if (!base) throw new Error('E2E_API_URL is not set');
  return base;
};

const pathOf = (url: string) => new URL(url).pathname;
const isStaffCall = (pathname: string, method?: string) => (response: Response) =>
  pathOf(response.url()) === pathname && (!method || response.request().method() === method);

/** Every request the page sends to one admin API path. */
function watchRequests(page: Page, pathname: string, method?: string): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (pathOf(request.url()) === pathname && (!method || request.method() === method)) seen.push(request.url());
  });
  return seen;
}

/** Fails the test if the page opens any dialog (alert, confirm, prompt). */
function failOnDialog(page: Page): string[] {
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  return dialogs;
}

async function fillPasswordStep(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
}

async function submitPasswordStep(page: Page): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/login')),
    page.getByRole('button', { name: 'Continue' }).click(),
  ]);
  return response;
}

async function passwordStep(page: Page, email: string, password: string): Promise<Response> {
  await page.goto(adminUrl('/sign-in'));
  await fillPasswordStep(page, email, password);
  return submitPasswordStep(page);
}

/** On /enrol with an enrolment-only session (no staff factor and no passkey, passkeys not required). */
async function openEnrol(page: Page, staff: { email: string; password: string }): Promise<string> {
  const login = await passwordStep(page, staff.email, staff.password);
  expect(login.status()).toBe(200);
  await expect(page).toHaveURL(adminUrl('/enrol'));
  return ((await login.json()) as { data: { session: { id: string } } }).data.session.id;
}

const sidebarLink = (page: Page, name: string) =>
  page.locator('[data-sidebar="sidebar"]').getByRole('link', { name, exact: true });

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });

const staffKeyCount = async (userId: string) =>
  Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`, [userId]))[0].n);

const clearingCookies = (setCookies: string[]) =>
  setCookies.filter((value) => /^(__Host-)?chumbaq_staff_refresh=;/.test(value) && value.includes('Expires=Thu, 01 Jan 1970'));

const signedInNote = (page: Page) => page.evaluate(() => sessionStorage.getItem('chumbaq_staff_signed_in'));

/** A login body a validation case sends, from a fresh client address each (the route takes 5 a minute). */
const login = (body: unknown) => staffApi('POST', '/api/staff/auth/login', body, { ip: newClientIp() });

// ---- API split

test('ADMAUTH-003 admin API exposes exactly the 19 staff routes', async () => {
  const routes: Array<[string, string, number[]]> = [
    ['POST', '/api/staff/auth/login', [400]],
    ['POST', '/api/staff/auth/login/totp', [400]],
    ['POST', '/api/staff/auth/login/passkey/options', [400]],
    ['POST', '/api/staff/auth/login/passkey/verify', [400]],
    ['POST', '/api/staff/auth/passkey/options', [200]],
    ['POST', '/api/staff/auth/passkey/verify', [400]],
    ['POST', '/api/staff/auth/session/refresh', [401]],
    ['POST', '/api/staff/auth/session/logout', [401]],
    ['GET', '/api/staff/auth/me', [401]],
    ['POST', '/api/staff/auth/reauth/passkey/options', [401]],
    ['POST', '/api/staff/auth/reauth/passkey/verify', [401]],
    ['POST', '/api/staff/auth/reauth/totp', [401]],
    ['GET', '/api/staff/auth/factors', [401]],
    ['POST', '/api/staff/auth/passkeys/options', [401]],
    ['POST', '/api/staff/auth/passkeys', [401]],
    ['DELETE', `/api/staff/auth/passkeys/${randomUUID()}`, [401]],
    ['POST', '/api/staff/auth/totp/setup', [401]],
    ['POST', '/api/staff/auth/totp/confirm', [401]],
    ['DELETE', '/api/staff/auth/totp', [401]],
  ];
  expect(routes).toHaveLength(19);
  for (const [method, pathname, expected] of routes) {
    const answer = await staffApi(method, pathname, method === 'GET' ? undefined : {}, { ip: newClientIp() });
    expect(answer.status, `${method} ${pathname}`).not.toBe(404);
    expect(expected, `${method} ${pathname} answered ${answer.status}`).toContain(answer.status);
  }

  // The routes that set or read the cookie refuse a request without the client header first.
  for (const pathname of [
    '/api/staff/auth/login',
    '/api/staff/auth/login/totp',
    '/api/staff/auth/login/passkey/verify',
    '/api/staff/auth/passkey/verify',
    '/api/staff/auth/session/refresh',
    '/api/staff/auth/session/logout',
  ]) {
    const answer = await staffApi('POST', pathname, {}, { ip: newClientIp(), client: false });
    expect(answer.status, pathname).toBe(403);
    expect(answer.body.message, pathname).toBe('Missing client header');
  }

  for (const [method, pathname] of [
    ['GET', '/api/staff/auth/sessions'],
    ['POST', '/api/staff/auth/logout'],
    ['POST', '/api/staff/auth/refresh'],
  ]) {
    const answer = await staffApi(method, pathname, method === 'GET' ? undefined : {}, { ip: newClientIp() });
    expect(answer.status, `${method} ${pathname}`).toBe(404);
  }
});

// ---- Sign-in page: layout and notes

test('ADMAUTH-006 sign-in page renders for an anonymous visitor', async ({ page }) => {
  const response = await page.goto(adminUrl('/sign-in'));
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page).toHaveTitle('Chumbaq Admin');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');

  await expect(page.getByText('Chumbaq admin', { exact: true })).toBeVisible();
  await expect(page.getByText('Staff only. Every sign-in is recorded.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
  await expect(page.getByText('or', { exact: true })).toBeVisible();
  const email = page.getByLabel('Email');
  await expect(email).toHaveAttribute('type', 'email');
  await expect(email).toHaveAttribute('autocomplete', 'username');
  const password = page.getByLabel('Password', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await expect(page.getByLabel('Enrolment code from your operator')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('ADMAUTH-010 idle and ended notes from the address bar', async ({ page }) => {
  await page.goto(adminUrl('/sign-in?reason=idle'));
  await expect(page.getByRole('status')).toHaveText(IDLE);
  await page.goto(adminUrl('/sign-in?reason=ended'));
  await expect(page.getByRole('status')).toHaveText(ENDED);
});

test('ADMAUTH-011 enrolled notes from the address bar', async ({ page }) => {
  await page.goto(adminUrl('/sign-in?enrolled=passkey'));
  await expect(page.getByRole('status')).toHaveText('Done. Sign in with your new passkey.');
  await page.goto(adminUrl('/sign-in?enrolled=totp'));
  await expect(page.getByRole('status')).toHaveText('Done. Sign in with your authenticator app.');
});

test('ADMAUTH-012 unknown or hostile query values show nothing', async ({ page }) => {
  const dialogs = failOnDialog(page);
  const cases: Array<[string, string]> = [
    ['reason=hacked', 'hacked'],
    ['reason=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', 'onerror'],
    ['enrolled=webauthn', 'webauthn'],
    ['message=Your%20account%20is%20locked', 'Your account is locked'],
  ];
  for (const [query, text] of cases) {
    await page.goto(adminUrl(`/sign-in?${query}`));
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
    await expect(page.getByRole('status'), query).toHaveCount(0);
    await expect(page.getByRole('alert'), query).toHaveCount(0);
    expect(await page.locator('body').innerText(), query).not.toContain(text);
    expect(await page.locator('#root').innerHTML(), query).not.toContain(text);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  }
  expect(dialogs).toEqual([]);
});

// ---- Password step

test('ADMAUTH-016 login request validation errors', async ({ clientIp }) => {
  const staff = await makeStaff(clientIp);
  const since = new Date();
  const messagesOf = (answer: { body: { message: unknown } }) =>
    Array.isArray(answer.body.message) ? (answer.body.message as string[]) : [String(answer.body.message)];

  const cases: Array<[string, unknown, string | null]> = [
    ['malformed address', { email: 'nope', password: 'x' }, 'Please provide a valid email address'],
    ['empty password', { email: staff.email, password: '' }, 'Password is required'],
    ['long password', { email: staff.email, password: 'p'.repeat(201) }, 'password must be shorter than or equal to 200 characters'],
    ['extra key', { email: staff.email, password: staff.password, remember: true }, 'property remember should not exist'],
    ['long code', { email: staff.email, password: staff.password, enrolmentCode: 'c'.repeat(201) }, 'enrolmentCode must be shorter than or equal to 200 characters'],
  ];
  const refusedFrom: string[] = [];
  for (const [label, body, message] of cases) {
    const ip = newClientIp();
    refusedFrom.push(ip);
    const answer = await staffApi('POST', '/api/staff/auth/login', body, { ip });
    expect(answer.status, label).toBe(400);
    expect(messagesOf(answer), label).toContain(message);
  }
  const emptyIp = newClientIp();
  refusedFrom.push(emptyIp);
  const empty = await staffApi('POST', '/api/staff/auth/login', undefined, { ip: emptyIp });
  expect(empty.status).toBe(400);
  expect(messagesOf(empty)).toEqual(expect.arrayContaining(['Please provide a valid email address', 'Password is required']));

  // A 400 never reaches the password check: nothing recorded from any of those addresses.
  for (const ip of refusedFrom) expect(await authEventsFromIp(ip, since), ip).toEqual([]);
  expect(
    await sql(`SELECT id FROM admin_audit_logs WHERE action = 'staff.sign_in_failed' AND created_at >= $1 AND ip_address = ANY($2)`, [
      since,
      refusedFrom,
    ]),
  ).toEqual([]);
  // The right request after them is the only one recorded for the address.
  const accepted = await login({ email: staff.email, password: staff.password });
  expect(accepted.status).toBe(200);
  expect((await authEvents({ email: staff.email }, since)).map((row) => [row.type, row.reason])).toEqual([
    ['login.password_accepted', 'staff_enrolment'],
  ]);
});

test('ADMAUTH-023 route throttle on the password step', async ({ page, clientIp }) => {
  for (let i = 0; i < 5; i++) {
    const answer = await staffApi('POST', '/api/staff/auth/login', { email: uniqueEmail('nobody'), password: 'any-password-1' }, { ip: clientIp });
    expect(answer.status, `request ${i + 1}`).toBe(401);
  }

  await page.goto(adminUrl('/sign-in'));
  await fillPasswordStep(page, uniqueEmail('nobody'), 'any-password-1');
  const sixth = await submitPasswordStep(page);
  expect(sixth.status()).toBe(429);
  // The framework's own text, shown as the API sent it.
  await expect(page.getByRole('alert')).toHaveText(THROTTLED);

  // Another address is not held by it.
  const elsewhere = await staffApi('POST', '/api/staff/auth/login', { email: uniqueEmail('nobody'), password: 'any-password-1' }, { ip: newClientIp() });
  expect(elsewhere.status).toBe(401);
  expect(elsewhere.body.message).toBe(INVALID_LOGIN);
});

test('ADMAUTH-025 network failure on the password step', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await page.goto(adminUrl('/sign-in'));
  await page.route(adminUrl('/api/staff/auth/login'), (route) => route.abort());
  await fillPasswordStep(page, staff.email, staff.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText(UNREACHABLE_API);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(staff.password);

  await page.unroute(adminUrl('/api/staff/auth/login'));
  await page.route(adminUrl('/api/staff/auth/login'), (route) =>
    route.fulfill({ status: 500, contentType: 'text/html', body: '<html><body>Internal error</body></html>' }),
  );
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText(GENERIC_FAILURE);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(staff.password);
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  expect(await staffSessionsCount(staff.userId)).toBe(0);
});

const staffSessionsCount = async (userId: string) =>
  Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM staff_sessions WHERE user_id = $1`, [userId]))[0].n);

// ---- Second factor after the password

test('ADMAUTH-029 passkey second factor cancelled in the browser', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const authenticator = await enrolStaffPasskey(page, staff);
  await fillPasswordStep(page, staff.email, staff.password);
  expect((await submitPasswordStep(page)).status()).toBe(200);
  await expect(page.getByText('Now confirm it is you.')).toBeVisible();

  await authenticator.setUserVerified(false);
  const verifies = watchRequests(page, '/api/staff/auth/login/passkey/verify');
  const [options] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/login/passkey/options')),
    page.getByRole('button', { name: 'Use your passkey' }).click(),
  ]);
  expect(options.status()).toBe(200);
  await expect(page.getByRole('alert')).toHaveText(PROMPT_CANCELLED);
  await expect(page.getByText('Now confirm it is you.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use your passkey' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start again' })).toBeEnabled();
  expect(verifies).toEqual([]);

  // The step is still good: with the authenticator verifying again, the same button signs in.
  await authenticator.setUserVerified(true);
  await page.getByRole('button', { name: 'Use your passkey' }).click();
  await expect(page).toHaveURL(adminUrl('/'));
});

test('ADMAUTH-031 second-factor handle expires after 5 minutes', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await fillPasswordStep(page, staff.email, staff.password);
  const loginResponse = await submitPasswordStep(page);
  const handle = ((await loginResponse.json()) as { data: { handle: string } }).data.handle;
  await expect(page.getByRole('button', { name: 'Use your passkey' })).toBeVisible();

  expect(await redisDel(preAuthKey(handle))).toBe(1);
  const refreshes = watchRequests(page, REFRESH);
  const [options] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/login/passkey/options')),
    page.getByRole('button', { name: 'Use your passkey' }).click(),
  ]);
  expect(options.status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(HANDLE_EXPIRED);
  expect(refreshes).toEqual([]);

  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByText('Now confirm it is you.')).toHaveCount(0);
});

test('ADMAUTH-039 second-factor failure limit', async ({ clientIp }) => {
  const staff = await makeStaff(clientIp);
  const enrolment = await enrolStaffTotpOnly(staff);
  const { handle, methods } = await staffHandle(staff);
  expect(methods).toEqual(['totp']);
  const since = new Date();
  const right = totpCode(enrolment.secret);
  const wrong = right === '000000' ? '111111' : '000000';

  // Ten wrong codes on one handle, each from its own address (the route takes 5 a minute).
  for (let i = 0; i < 10; i++) {
    const answer = await staffApi('POST', '/api/staff/auth/login/totp', { handle, code: wrong }, { ip: newClientIp() });
    expect(answer.status, `wrong code ${i + 1}`).toBe(401);
    expect(answer.body.message).toBe(CODE_REFUSED);
  }
  const limited = await staffApi('POST', '/api/staff/auth/login/totp', { handle, code: right }, { ip: newClientIp() });
  expect(limited.status).toBe(429);
  expect(limited.body.message).toBe(TOO_MANY);
  expect(limited.setCookies).toEqual([]);
  expect((await authEvents({ email: staff.email }, since, 'login.limited')).length).toBe(1);
  expect((await authEvents({ userId: staff.userId }, since, 'login.failed')).map((row) => row.reason)).toEqual(Array(10).fill('totp_failed'));
  expect(await sql(`SELECT id FROM staff_sessions WHERE user_id = $1 AND enrolment_only = false`, [staff.userId])).toHaveLength(0);
});

// ---- Passkey first (no email)

test('ADMAUTH-043 no staff key on this device', async ({ page }) => {
  const authenticator = await addAuthenticator(page);
  expect(await authenticator.credentials()).toEqual([]);
  // An empty authenticator would leave the browser waiting for the ceremony's timeout; one
  // that cannot verify the user ends it at once, as a dismissed prompt does.
  await authenticator.setUserVerified(false);
  await page.goto(adminUrl('/sign-in'));
  const verifies = watchRequests(page, '/api/staff/auth/passkey/verify');
  const [options] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/passkey/options')),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  expect(options.status()).toBe(200);
  await expect(page.getByRole('alert')).toHaveText(PROMPT_CANCELLED);
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  expect(verifies).toEqual([]);
});

test('ADMAUTH-046 passkey ceremony id expires or is reused', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);

  // Expired: the challenge is gone from Redis before the answer arrives.
  const first = await staffApi('POST', '/api/staff/auth/passkey/options', {}, { ip: clientIp });
  const firstAnswer = await browserAssertion(page, first.data.options);
  const key = challengeKey('staff-passwordless', first.data.ceremonyId);
  expect(await redisExists(key)).toBe(1);
  expect(await redisDel(key)).toBe(1);
  const expired = await staffApi('POST', '/api/staff/auth/passkey/verify', { ceremonyId: first.data.ceremonyId, response: firstAnswer }, { ip: clientIp });
  expect(expired.status).toBe(401);
  expect(expired.body.message).toBe(HANDLE_EXPIRED);
  expect(expired.setCookies).toEqual([]);

  // Reused: a body that signed in once is refused the second time.
  const second = await staffApi('POST', '/api/staff/auth/passkey/options', {}, { ip: clientIp });
  const body = { ceremonyId: second.data.ceremonyId, response: await browserAssertion(page, second.data.options) };
  const signedIn = await staffApi('POST', '/api/staff/auth/passkey/verify', body, { ip: clientIp });
  expect(signedIn.status).toBe(200);
  expect(signedIn.data.step).toBe('signed_in');
  const replay = await staffApi('POST', '/api/staff/auth/passkey/verify', body, { ip: clientIp });
  expect(replay.status).toBe(401);
  expect(replay.body.message).toBe(HANDLE_EXPIRED);
  expect(replay.setCookies).toEqual([]);
  expect(Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM staff_sessions WHERE user_id = $1 AND enrolment_only = false`, [staff.userId]))[0].n)).toBe(1);
});

test('ADMAUTH-049 new-device alarm on staff sign-in', async ({ page, browser, baseURL, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  // The staff member's earlier sessions were all from Chrome on Linux.
  await sql(`UPDATE staff_sessions SET user_agent = $2 WHERE user_id = $1`, [staff.userId, LINUX_CHROME]);
  await staffPasskeySignInAs(page, LINUX_CHROME);
  const seenDevice = await staffPasskeySignInAs(page, LINUX_CHROME);
  expect(seenDevice.accessToken).toBeTruthy();

  // 1. Safari on macOS is new for them.
  const safari = await staffPasskeySignInAs(page, MAC_SAFARI);
  expect(safari.accessToken).toBeTruthy();
  await expect.poll(async () => (await newDeviceAlerts(staff.userId)).length).toBe(1);
  const [alert] = await newDeviceAlerts(staff.userId);
  expect(alert.details.device).toMatch(/Safari/);
  expect(alert.dedupe_key).toBe(`${staff.userId}:${alert.details.device}`);
  expect(alert.details.email).toBe(staff.email);
  expect(alert.count).toBe(1);

  // 2. Safari again raises nothing. A third device afterwards shows the alarms are still checked.
  await staffPasskeySignInAs(page, MAC_SAFARI);
  await staffPasskeySignInAs(page, WINDOWS_FIREFOX);
  await expect.poll(async () => (await newDeviceAlerts(staff.userId)).length).toBe(2);
  const afterRepeat = await newDeviceAlerts(staff.userId);
  expect(afterRepeat.find((row) => row.dedupe_key === alert.dedupe_key)?.count).toBe(1);
  expect(afterRepeat.map((row) => row.details.device)).toEqual([alert.details.device, expect.stringMatching(/Firefox/)]);

  // 3. A brand-new staff member's first sign-in, from the browser they enrolled in, raises nothing.
  const other = await newPersonContext(browser, baseURL);
  const fresh = await makeStaff(newClientIp(), 'fresh-staff');
  const blank = await makeStaff(newClientIp(), 'blank-staff');
  try {
    const pageB = await other.context.newPage();
    await enrolStaffPasskey(pageB, fresh);
    await signInStaffInPage(pageB);
    // Then another device of theirs: its alarm arrives, the first sign-in's never does.
    await staffPasskeySignInAs(pageB, WINDOWS_FIREFOX);
    await expect.poll(async () => (await newDeviceAlerts(fresh.userId)).length).toBe(1);
    expect((await newDeviceAlerts(fresh.userId))[0].details.device).toMatch(/Firefox/);

    // With no earlier staff session at all (the enrolment one pruned) and no earlier
    // sign-in, a first sign-in from a browser never seen raises nothing either.
    const pageC = await other.context.newPage();
    await enrolStaffPasskey(pageC, blank);
    await sql(`DELETE FROM staff_sessions WHERE user_id = $1`, [blank.userId]);
    const first = await staffPasskeySignInAs(pageC, WINDOWS_FIREFOX);
    expect(first.accessToken).toBeTruthy();
    // The next one, from another device, is compared with that first session and raises.
    await staffPasskeySignInAs(pageC, MAC_SAFARI);
    await expect.poll(async () => (await newDeviceAlerts(blank.userId)).length).toBe(1);
    expect((await newDeviceAlerts(blank.userId)).map((row) => row.details.device)).toEqual([expect.stringMatching(/Safari/)]);
  } finally {
    await other.context.close();
  }
});

// ---- Enrolment code

test('ADMAUTH-053 CLI output and refusals for the enrolment code', async ({ clientIp }) => {
  test.slow(); // Three CLI runs through ts-node.
  const staff = await makeStaff(clientIp);
  const customer = await createAccount(clientIp, 'not-staff');
  const unknown = uniqueEmail('nobody');
  const since = new Date();

  const issued = await runApiCli('admin:staff-enrolment', [staff.email]);
  expect(issued.exitCode).toBe(0);
  const lines = issued.stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  const code = lines[lines.length - 1];
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const intro = new RegExp(
    `One-time enrolment code for ${staff.email.replace(/[.+]/g, '\\$&')}, good until (\\S+)\\. It is shown only now and was not emailed\\.`,
  );
  const until = intro.exec(issued.stdout)?.[1];
  expect(until, issued.stdout).toBeDefined();
  const [row] = await sql<{ code_hash: string; expires_at: Date; created_at: Date }>(
    `SELECT code_hash, expires_at, created_at FROM staff_enrolment_allowances WHERE user_id = $1`,
    [staff.userId],
  );
  expect(row.code_hash).toBe(createHash('sha256').update(code).digest('hex'));
  expect(row.expires_at.toISOString()).toBe(until);
  expect(Math.abs(row.expires_at.getTime() - Date.now() - 24 * 3600 * 1000)).toBeLessThan(120_000);
  expect(JSON.stringify(await sql(`SELECT * FROM staff_enrolment_allowances WHERE user_id = $1`, [staff.userId]))).not.toContain(code);

  const notStaff = await runApiCli('admin:staff-enrolment', [customer.email]);
  expect(notStaff.exitCode).not.toBe(0);
  expect(notStaff.stderr).toContain(`${customer.email} is not a super admin, so this does not apply.`);
  const nobody = await runApiCli('admin:staff-enrolment', [unknown]);
  expect(nobody.exitCode).not.toBe(0);
  expect(nobody.stderr).toContain(`No user with email ${unknown}`);

  expect(await sql(`SELECT id FROM staff_enrolment_allowances WHERE user_id = $1`, [customer.userId])).toHaveLength(0);
  const written = await sql<{ target_label: string }>(
    `SELECT target_label FROM admin_audit_logs WHERE action = 'staff.enrolment_allowed' AND created_at >= $1 AND target_label = ANY($2)`,
    [since, [staff.email, customer.email, unknown]],
  );
  expect(written.map((r) => r.target_label)).toEqual([staff.email]);
});

test('ADMAUTH-059 two sign-ins racing on one code', async ({ clientIp }) => {
  const staff = await makeStaff(clientIp);
  // Any passkey on the account makes the code necessary.
  await seedCustomerPasskeyRow(staff.userId);
  const issued = await issueEnrolmentCode(staff.userId);
  const since = new Date();

  const body = { email: staff.email, password: staff.password, enrolmentCode: issued.code };
  const answers = await Promise.all([
    staffApi('POST', '/api/staff/auth/login', body, { ip: newClientIp() }),
    staffApi('POST', '/api/staff/auth/login', body, { ip: newClientIp() }),
  ]);
  const statuses = answers.map((answer) => answer.status).sort();
  expect(statuses).toEqual([200, 403]);
  const won = answers.find((answer) => answer.status === 200)!;
  const lost = answers.find((answer) => answer.status === 403)!;
  expect(won.data.step).toBe('enrol');
  expect(lost.body.message).toBe(ENROLMENT_BLOCKED);
  expect(await auditRows(staff.userId, since, 'staff.enrolment_started')).toHaveLength(1);
  expect(Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM staff_sessions WHERE user_id = $1`, [staff.userId]))[0].n)).toBe(1);
});

// ---- Enrolment-only session and /enrol

test('ADMAUTH-064 passkey name with HTML is shown as text', async ({ page, clientIp }) => {
  const dialogs = failOnDialog(page);
  const name = '<img src=x onerror=alert(1)>';
  const staff = await makeStaff(clientIp);
  const since = new Date();
  await enrolStaffPasskey(page, staff, name);
  const [key] = await sql<{ name: string }>(`SELECT name FROM webauthn_credentials WHERE user_id = $1`, [staff.userId]);
  expect(key.name).toBe(name);

  await signInStaffInPage(page);
  await sidebarLink(page, 'Your account').click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);

  const audit: any[] = [];
  page.on('response', async (response) => {
    if (pathOf(response.url()) === '/api/admin/audit-logs' && response.ok()) audit.push(await response.json());
  });
  await page.goto(adminUrl(`/audit-log?targetId=${staff.userId}&action=staff.factor_added`));
  await expect(page.getByRole('cell', { name: 'Added a sign-in method' })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect.poll(() => audit.length).toBeGreaterThan(0);
  const rows = (audit[audit.length - 1] as { data: Array<{ action: string; metadata: { name?: string } }> }).data;
  expect(rows.map((row) => [row.action, row.metadata.name])).toEqual([['staff.factor_added', name]]);
  expect((await auditRows(staff.userId, since, 'staff.factor_added'))[0].metadata?.name).toBe(name);
  expect(dialogs).toEqual([]);
});

test('ADMAUTH-066 passkey prompt cancelled on /enrol', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const authenticator = await addAuthenticator(page);
  const enrolling = await openEnrol(page, staff);
  await authenticator.setUserVerified(false);
  const adds = watchRequests(page, '/api/staff/auth/passkeys', 'POST');

  const [options] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/passkeys/options')),
    page.getByRole('button', { name: 'Add a passkey' }).click(),
  ]);
  expect(options.status()).toBe(200);
  await expect(page.getByRole('alert')).toHaveText(PROMPT_CANCELLED);
  await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeEnabled();
  await expect(page).toHaveURL(adminUrl('/enrol'));
  expect(adds).toEqual([]);
  expect(await staffKeyCount(staff.userId)).toBe(0);
  expect((await staffSession(enrolling)).revoked_at).toBeNull();
});

test('ADMAUTH-067 registration challenge expired', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await addAuthenticator(page);
  await page.goto(adminUrl('/sign-in'));
  const enrol = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: clientIp });
  expect(enrol.data.step).toBe('enrol');
  const as = { token: enrol.data.accessToken as string, ip: clientIp };

  const options = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, as);
  expect(options.status).toBe(200);
  const response = await browserAttestation(page, options.data.options);
  expect(await redisDel(challengeKey('staff-register', enrol.data.session.id))).toBe(1);
  const late = await staffApi('POST', '/api/staff/auth/passkeys', { response, name: 'Late key' }, as);
  expect(late.status).toBe(400);
  expect(late.body.message).toBe(TOO_SLOW);
  expect(await staffKeyCount(staff.userId)).toBe(0);

  // No options call at all is the same answer.
  const other = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: newClientIp() });
  const unasked = await staffApi('POST', '/api/staff/auth/passkeys', { response, name: 'Unasked key' }, { token: other.data.accessToken });
  expect(unasked.status).toBe(400);
  expect(unasked.body.message).toBe(TOO_SLOW);
  expect(await staffKeyCount(staff.userId)).toBe(0);
});

test('ADMAUTH-068 forged or wrong-origin registration is refused', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const enrol = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: clientIp });
  expect(enrol.data.step).toBe('enrol');
  const as = { token: enrol.data.accessToken as string, ip: clientIp };

  // 1. An empty response.
  expect((await staffApi('POST', '/api/staff/auth/passkeys/options', {}, as)).status).toBe(200);
  const forged = await staffApi('POST', '/api/staff/auth/passkeys', { response: {}, name: 'Forged' }, as);
  expect(forged.status).toBe(400);
  expect(forged.body.message).toBe(NOT_VERIFIED);

  // 2. A real key made on the customer app's origin for the admin's options.
  await addAuthenticator(page);
  await page.goto('/login');
  const options = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, as);
  const response = await browserAttestation(page, options.data.options);
  expect(JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).origin).toBe(new URL(page.url()).origin);
  const wrongOrigin = await staffApi('POST', '/api/staff/auth/passkeys', { response, name: 'Wrong origin' }, as);
  expect(wrongOrigin.status).toBe(400);
  expect(wrongOrigin.body.message).toBe(NOT_VERIFIED);

  expect(await staffKeyCount(staff.userId)).toBe(0);
  const me = await staffApi('GET', '/api/staff/auth/me', undefined, as);
  expect(me.status).toBe(200);
  expect(me.data.enrolmentOnly).toBe(true);

  // The same kind of key made on the admin app's origin is taken by that session.
  await page.goto(adminUrl('/sign-in'));
  const added = await enrolPasskeyByApi(page, as.token, 'Right origin', clientIp);
  expect(added.status).toBe(200);
  expect(await staffKeyCount(staff.userId)).toBe(1);
});

test('ADMAUTH-071 wrong code at authenticator setup', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await openEnrol(page, staff);
  await page.getByRole('button', { name: 'Use an authenticator app' }).click();
  const setupText = page.getByText('Scan this with your authenticator app, or enter the key by hand. Then type the code it shows.');
  await expect(setupText).toBeVisible();
  const secret = ((await page.locator('code').textContent()) ?? '').trim();
  const right = totpCode(secret);
  const wrong = right === '000000' ? '111111' : '000000';

  const field = page.getByLabel('Code from your authenticator app');
  await field.fill(wrong);
  const [refused] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/totp/confirm')),
    page.getByRole('button', { name: 'Turn on' }).click(),
  ]);
  expect(refused.status()).toBe(400);
  await expect(page.getByRole('alert')).toHaveText(CODE_REFUSED);
  await expect(field).toHaveValue('');
  await expect(setupText).toBeVisible();
  const [pending] = await sql<{ confirmed_at: Date | null }>(`SELECT confirmed_at FROM totp_secrets WHERE user_id = $1`, [staff.userId]);
  expect(pending.confirmed_at).toBeNull();

  await field.fill(totpCode(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page).toHaveURL(adminUrl('/sign-in?enrolled=totp'));
  const [confirmed] = await sql<{ confirmed_at: Date | null }>(`SELECT confirmed_at FROM totp_secrets WHERE user_id = $1`, [staff.userId]);
  expect(confirmed.confirmed_at).not.toBeNull();
});

test('ADMAUTH-076 enrolment session has no refresh and does not survive a reload', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await openEnrol(page, staff);
  await expect(page.getByText('Set up a sign-in method', { exact: true })).toBeVisible();
  expect(await signedInNote(page)).toBeNull();
  const refreshes = watchRequests(page, REFRESH);

  await page.reload();
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(refreshes).toEqual([]);
  expect((await context.cookies(adminUrl('/'))).filter((c) => c.name.endsWith('chumbaq_staff_refresh'))).toEqual([]);

  const refreshed = await page.evaluate(async (url) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chumbaq-Client': 'admin' }, body: '{}' });
    return { status: response.status, body: await response.json() };
  }, REFRESH);
  expect(refreshed.status).toBe(401);
  expect(refreshed.body.message).toBe(ENDED);
});

test('ADMAUTH-077 enrolment session ends after 15 minutes', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  // Through the API.
  const enrol = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: clientIp });
  const token: string = enrol.data.accessToken;
  expect((await staffApi('GET', '/api/staff/auth/me', undefined, { token })).status).toBe(200);
  await sql(`UPDATE staff_sessions SET created_at = now() - interval '16 minutes' WHERE id = $1`, [enrol.data.session.id]);
  const me = await staffApi('GET', '/api/staff/auth/me', undefined, { token });
  expect(me.status).toBe(401);
  expect(me.body.message).toBe(ENDED);

  // In the page on /enrol.
  await addAuthenticator(page);
  const enrolling = await openEnrol(page, staff);
  await sql(`UPDATE staff_sessions SET created_at = now() - interval '16 minutes' WHERE id = $1`, [enrolling]);
  const refreshes: number[] = [];
  page.on('response', (response) => {
    if (pathOf(response.url()) === REFRESH) refreshes.push(response.status());
  });
  const [options] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/passkeys/options')),
    page.getByRole('button', { name: 'Add a passkey' }).click(),
  ]);
  expect(options.status()).toBe(401);
  await expect(page).toHaveURL(adminUrl('/sign-in?reason=ended'));
  await expect(page.getByRole('status')).toHaveText(ENDED);
  expect(refreshes).toEqual([401]);
  expect(await staffKeyCount(staff.userId)).toBe(0);
});

test('ADMAUTH-078 sign out from /enrol', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const enrolling = await openEnrol(page, staff);
  const since = new Date();

  const [logout] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/session/logout')),
    page.getByRole('button', { name: 'Sign out' }).click(),
  ]);
  expect(logout.status()).toBe(204);
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);

  expect((await staffSession(enrolling)).revoked_reason).toBe('signed_out');
  const [audit] = await auditRows(staff.userId, since, 'staff.signed_out');
  expect(audit.metadata).toEqual({ sessionId: enrolling });
  const events = await authEvents({ userId: staff.userId }, since, 'logout');
  expect(events.map((row) => row.session_id)).toEqual([enrolling]);
});

test('ADMAUTH-079 two enrolment sessions race to add the first factor', async ({ page, browser, baseURL, clientIp }) => {
  const staff = await makeStaff(clientIp);
  const other = await newPersonContext(browser, baseURL);
  try {
    const pageB = await other.context.newPage();
    await addAuthenticator(page);
    await addAuthenticator(pageB);
    await page.goto(adminUrl('/sign-in'));
    await pageB.goto(adminUrl('/sign-in'));
    const a = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: clientIp });
    const b = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { ip: other.ip });
    expect([a.data.step, b.data.step]).toEqual(['enrol', 'enrol']);

    // B holds a valid ceremony of its own before A enrols.
    const optionsB = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token: b.data.accessToken, ip: other.ip });
    const responseB = await browserAttestation(pageB, optionsB.data.options);

    const addedA = await enrolPasskeyByApi(page, a.data.accessToken, 'Key A', clientIp);
    expect(addedA.status).toBe(200);
    const addedB = await staffApi('POST', '/api/staff/auth/passkeys', { response: responseB, name: 'Key B' }, { token: b.data.accessToken, ip: other.ip });
    expect(addedB.status).toBe(401);
    expect(addedB.body.message).toBe(ENDED);
    expect(await sql(`SELECT name FROM webauthn_credentials WHERE user_id = $1`, [staff.userId])).toEqual([{ name: 'Key A' }]);
    expect((await staffSession(b.data.session.id)).revoked_reason).toBe('factor_changed');

    // At the same moment: the user row lock lets exactly one through.
    const racer = await makeStaff(newClientIp(), 'racer');
    const c = await staffApi('POST', '/api/staff/auth/login', { email: racer.email, password: racer.password });
    const d = await staffApi('POST', '/api/staff/auth/login', { email: racer.email, password: racer.password });
    const optionsC = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token: c.data.accessToken });
    const optionsD = await staffApi('POST', '/api/staff/auth/passkeys/options', {}, { token: d.data.accessToken });
    const responseC = await browserAttestation(page, optionsC.data.options);
    const responseD = await browserAttestation(pageB, optionsD.data.options);
    const raced = await Promise.all([
      staffApi('POST', '/api/staff/auth/passkeys', { response: responseC, name: 'Key C' }, { token: c.data.accessToken }),
      staffApi('POST', '/api/staff/auth/passkeys', { response: responseD, name: 'Key D' }, { token: d.data.accessToken }),
    ]);
    expect(raced.map((answer) => answer.status).sort()).toEqual([200, 401]);
    expect(raced.find((answer) => answer.status === 401)!.body.message).toBe(ENDED);
    expect(await staffKeyCount(racer.userId)).toBe(1);
  } finally {
    await other.context.close();
  }
});

// ---- Session: cookie, refresh, reload, endings

test('ADMAUTH-084 a new tab does not inherit the session', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();
  expect((await context.cookies(adminUrl('/'))).some((c) => c.name.endsWith('chumbaq_staff_refresh'))).toBe(true);

  const tab = await context.newPage();
  const refreshes = watchRequests(tab, REFRESH);
  await tab.goto(adminUrl('/'));
  await expect(tab).toHaveURL(adminUrl('/sign-in'));
  await expect(tab.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(tab.getByRole('status')).toHaveCount(0);
  expect(refreshes).toEqual([]);
  expect(await signedInNote(tab)).toBeNull();

  await sidebarLink(page, 'Tenants').click();
  await expect(heading(page, 'Tenants')).toBeVisible();
  await expect(page).toHaveURL(adminUrl('/tenants'));
});

test('ADMAUTH-086 refresh without a cookie or with a junk cookie', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const live = await staffPasskeySignIn(page);
  const liveValue = live.cookie.slice(live.cookie.indexOf('=') + 1);
  const cookieName = live.cookie.slice(0, live.cookie.indexOf('='));
  expect(cookieName).toBe('__Host-chumbaq_staff_refresh');

  const attempt = async (cookie: string | undefined) => {
    const ip = newClientIp();
    const since = new Date();
    const answer = await staffApi('POST', REFRESH, {}, { ip, cookie });
    return { answer, events: await authEventsFromIp(ip, since) };
  };

  // 1. No cookie, and 4. two of the name: refused before the service, nothing set, nothing recorded.
  for (const [label, cookie] of [
    ['no cookie', undefined],
    ['two cookies', `${cookieName}=${liveValue}; ${cookieName}=${randomUUID()}.junk`],
  ] as const) {
    const { answer, events } = await attempt(cookie);
    expect(answer.status, label).toBe(401);
    expect(answer.body.message, label).toBe(ENDED);
    expect(answer.setCookies, label).toEqual([]);
    expect(events, label).toEqual([]);
  }

  // 2. Garbage, and 3. a well-formed token that matches nothing: refused by the service, cookie cleared.
  for (const [label, value] of [
    ['garbage', 'garbage'],
    ['unknown token', `${randomUUID()}.${'A'.repeat(43)}`],
  ] as const) {
    const { answer, events } = await attempt(`${cookieName}=${value}`);
    expect(answer.status, label).toBe(401);
    expect(answer.body.message, label).toBe(ENDED);
    const cleared = clearingCookies(answer.setCookies);
    expect(cleared.some((value) => value.startsWith('__Host-chumbaq_staff_refresh=;') && value.includes('Path=/;')), label).toBe(true);
    expect(cleared.some((value) => value.startsWith('chumbaq_staff_refresh=;') && value.includes('Path=/api/staff/auth/session')), label).toBe(true);
    expect(events.map((row) => [row.type, row.reason]), label).toEqual([['refresh.failed', 'staff_session_revoked']]);
  }

  // None of it ended the live session: its cookie still refreshes.
  expect((await staffSession(live.session.id)).revoked_at).toBeNull();
  const still = await staffApi('POST', REFRESH, {}, { cookie: live.cookie });
  expect(still.status).toBe(200);
});

test('ADMAUTH-087 refresh grace for a retried request', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await staffPasskeySignIn(page);
  const r1 = signedIn.cookie;

  const first = await staffApi('POST', REFRESH, {}, { cookie: r1 });
  expect(first.status).toBe(200);
  const r2 = staffCookiePair(first.setCookies);
  expect(r2).not.toBe(r1);
  const since = new Date();

  const retried = await staffApi('POST', REFRESH, {}, { cookie: r1 });
  expect(retried.status).toBe(200);
  expect(retried.data.accessToken).toBeTruthy();
  expect(retried.data.session.id).toBe(signedIn.session.id);
  expect(retried.setCookies).toEqual([]);
  expect((await authEvents({ userId: staff.userId }, since, 'refresh.succeeded')).map((row) => row.reason)).toEqual(['retried_within_grace']);
  const row = await staffSession(signedIn.session.id);
  expect(row.revoked_at).toBeNull();

  // R2 stands.
  expect((await staffApi('GET', '/api/staff/auth/me', undefined, { token: retried.data.accessToken })).status).toBe(200);
  expect((await staffApi('POST', REFRESH, {}, { cookie: r2 })).status).toBe(200);
});

test('ADMAUTH-090 idle timeout found on reload', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();
  await sql(`UPDATE staff_sessions SET last_active_at = now() - make_interval(secs => $2) WHERE id = $1`, [
    signedIn.session.id,
    signedIn.session.idleTimeoutSeconds + 60,
  ]);

  const [refresh] = await Promise.all([page.waitForResponse(isStaffCall(REFRESH)), page.reload()]);
  expect(refresh.status()).toBe(401);
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  await expect(page.getByRole('status')).toHaveText(IDLE);
  expect(await signedInNote(page)).toBeNull();
  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('idle');
});

test('ADMAUTH-091 refreshing alone does not keep a session alive', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await staffPasskeySignIn(page);
  const idleSeconds: number = (await staffApi('GET', '/api/staff/auth/me', undefined, { token: signedIn.accessToken })).data.session.idleTimeoutSeconds;

  await sql(`UPDATE staff_sessions SET last_active_at = now() - make_interval(secs => $2) WHERE id = $1`, [signedIn.session.id, idleSeconds - 60]);
  const before = (await staffSession(signedIn.session.id)).last_active_at;
  const refreshed = await staffApi('POST', REFRESH, {}, { cookie: signedIn.cookie });
  expect(refreshed.status).toBe(200);
  expect((await staffSession(signedIn.session.id)).last_active_at).toEqual(before);

  await sql(`UPDATE staff_sessions SET last_active_at = now() - make_interval(secs => $2) WHERE id = $1`, [signedIn.session.id, idleSeconds + 60]);
  const refused = await staffApi('POST', REFRESH, {}, { cookie: staffCookiePair(refreshed.setCookies) });
  expect(refused.status).toBe(401);
  expect(refused.body.message).toBe(IDLE);
  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('idle');
});

test('ADMAUTH-097 suspending a staff account ends their admin session', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await staffPasskeySignIn(page);
  expect((await staffApi('GET', '/api/staff/auth/me', undefined, { token: signedIn.accessToken })).status).toBe(200);
  await sql(`UPDATE users SET suspended_at = now() WHERE id = $1`, [staff.userId]);

  const me = await staffApi('GET', '/api/staff/auth/me', undefined, { token: signedIn.accessToken });
  expect(me.status).toBe(401);
  expect(me.body.message).toBe(ENDED);
  expect((await staffSession(signedIn.session.id)).revoked_at).toBeNull();
  const refreshed = await staffApi('POST', REFRESH, {}, { cookie: signedIn.cookie });
  expect(refreshed.status).toBe(401);
  expect(refreshed.body.message).toBe(ENDED);
  expect(clearingCookies(refreshed.setCookies).length).toBeGreaterThan(0);
  const row = await staffSession(signedIn.session.id);
  expect(row.revoked_at).not.toBeNull();
  expect(row.revoked_reason).toBe('session_version');
});

test('ADMAUTH-098 staff passkeys reset by the CLI ends sessions and forces re-enrolment', async ({ page, clientIp }) => {
  test.slow(); // The reset runs through the CLI.
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();

  const reset = await runApiCli('admin:passkeys-reset', [staff.email]);
  expect(reset.exitCode, reset.stderr).toBe(0);
  expect(await staffKeyCount(staff.userId)).toBe(0);

  await sidebarLink(page, 'Tenants').click();
  await expect(page).toHaveURL(adminUrl('/sign-in?reason=ended'));
  await expect(page.getByRole('status')).toHaveText(ENDED);
  expect((await staffSession(signedIn.session.id)).revoked_at).not.toBeNull();

  // The old key in the authenticator is not recognised.
  const [passkey] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/passkey/verify')),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  expect(passkey.status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(NOT_RECOGNISED);

  // With no passkey left and passkeys not required, the password starts enrolment again.
  await fillPasswordStep(page, staff.email, staff.password);
  const again = await submitPasswordStep(page);
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { data: { step: string } }).data.step).toBe('enrol');
  await expect(page).toHaveURL(adminUrl('/enrol'));
});

test('ADMAUTH-099 refresh throttle and an outage do not sign anyone out', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();

  const failures: Array<[string, (route: import('@playwright/test').Route) => Promise<void>]> = [
    ['429', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: THROTTLED }) })],
    ['502', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' })],
    ['abort', (route) => route.abort()],
  ];
  for (const [label, failure] of failures) {
    await page.route(adminUrl(REFRESH), failure);
    await page.reload();
    const unreachable = page.getByRole('alert').filter({ hasText: 'Could not reach the admin API.' });
    await expect(unreachable, label).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
    expect(await signedInNote(page), label).toBe('1');

    await page.unroute(adminUrl(REFRESH));
    const [refresh] = await Promise.all([
      page.waitForResponse(isStaffCall(REFRESH)),
      page.getByRole('button', { name: 'Try again' }).click(),
    ]);
    expect(refresh.status(), label).toBe(200);
    await expect(heading(page, 'Overview'), label).toBeVisible();
  }
});

test('ADMAUTH-101 signing out in one tab ends the other tab', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await signInStaffInPage(page);
  await expect(heading(page, 'Overview')).toBeVisible();

  // Tab B as a duplicated tab: the per-tab note copied, the cookie shared.
  const tabB = await context.newPage();
  await tabB.addInitScript(() => {
    if (!sessionStorage.getItem('e2e_note_copied')) {
      sessionStorage.setItem('e2e_note_copied', '1');
      sessionStorage.setItem('chumbaq_staff_signed_in', '1');
    }
  });
  await tabB.goto(adminUrl('/'));
  await expect(heading(tabB, 'Overview')).toBeVisible();

  await page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(adminUrl('/sign-in'));
  expect((await staffSession(signedIn.session.id)).revoked_reason).toBe('signed_out');

  await sidebarLink(tabB, 'Tenants').click();
  await expect(tabB).toHaveURL(adminUrl('/sign-in?reason=ended'));
  await expect(tabB.getByRole('status')).toHaveText(ENDED);
  expect((await context.cookies(adminUrl('/'))).filter((c) => c.name.endsWith('chumbaq_staff_refresh'))).toEqual([]);
});

// ---- With passkeys required, as in production

test.describe('with passkeys required for staff', () => {
  let required: ExtraAdminApi;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    required = await startPasskeyRequiredAdminApi();
  });

  test.afterAll(async () => {
    await required?.stop();
  });

  test('ADMAUTH-058 authenticator-only staff member enrols a passkey with a code', async ({ page, clientIp }) => {
    const staff = await makeStaff(clientIp);
    await enrolStaffTotpOnly(staff);
    const issued = await issueEnrolmentCode(staff.userId);
    await addAuthenticator(page);
    await forwardToAdminApi(page, required.url, [
      '/api/staff/auth/login',
      '/api/staff/auth/me',
      '/api/staff/auth/factors',
      '/api/staff/auth/passkeys/options',
      '/api/staff/auth/passkeys',
    ]);

    await page.goto(adminUrl('/sign-in'));
    await fillPasswordStep(page, staff.email, staff.password);
    expect((await submitPasswordStep(page)).status()).toBe(403);
    await expect(page.getByRole('alert')).toHaveText(ENROLMENT_BLOCKED);
    await page.getByLabel('Enrolment code from your operator').fill(issued.code);
    const [factors, loginAnswer] = await Promise.all([
      page.waitForResponse(isStaffCall('/api/staff/auth/factors')),
      submitPasswordStep(page),
    ]);
    expect(loginAnswer.status()).toBe(200);
    await expect(page).toHaveURL(adminUrl('/enrol'));
    const listed = ((await factors.json()) as { data: { totp: { enabled: boolean; available: boolean } } }).data.totp;
    expect(listed).toEqual({ enabled: true, available: false });
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use an authenticator app' })).toHaveCount(0);

    await page.getByLabel('Passkey name').fill('Required key');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page).toHaveURL(adminUrl('/sign-in?enrolled=passkey'));
    await expect(page.getByRole('status')).toHaveText('Done. Sign in with your new passkey.');
    expect(await sql(`SELECT name, scope FROM webauthn_credentials WHERE user_id = $1`, [staff.userId])).toEqual([
      { name: 'Required key', scope: 'staff' },
    ]);
  });

  test('ADMAUTH-072 authenticator setup not offered when unavailable', async ({ page, clientIp }) => {
    test.slow(); // Starts one more admin API, without the authenticator app's key.
    // b. Passkeys required: an enrolment session (from an operator's code) may add only a passkey.
    const staff = await makeStaff(clientIp);
    const issued = await issueEnrolmentCode(staff.userId);
    await forwardToAdminApi(page, required.url, ['/api/staff/auth/login', '/api/staff/auth/me', '/api/staff/auth/factors']);
    await page.goto(adminUrl('/sign-in'));
    await fillPasswordStep(page, staff.email, staff.password);
    expect((await submitPasswordStep(page)).status()).toBe(403);
    await page.getByLabel('Enrolment code from your operator').fill(issued.code);
    const [factors, loginAnswer] = await Promise.all([
      page.waitForResponse(isStaffCall('/api/staff/auth/factors')),
      submitPasswordStep(page),
    ]);
    expect(loginAnswer.status()).toBe(200);
    await expect(page).toHaveURL(adminUrl('/enrol'));
    expect(((await factors.json()) as { data: { totp: { available: boolean } } }).data.totp.available).toBe(false);
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use an authenticator app' })).toHaveCount(0);
    const token = ((await loginAnswer.json()) as { data: { accessToken: string } }).data.accessToken;
    const refusedRequired = await staffApi('POST', '/api/staff/auth/totp/setup', {}, { token, base: required.url });
    expect(refusedRequired.status).toBe(403);
    expect(refusedRequired.body.message).toBe(PASSKEY_NEEDED);
    // The lane's own admin API (passkeys not required) offers it to the same session.
    expect((await staffApi('GET', '/api/staff/auth/factors', undefined, { token })).data.totp.available).toBe(true);

    // a. No authenticator-app key configured.
    const noMfa = await startAdminApiWith({ MFA_ENCRYPTION_KEY: '' }, 'no-mfa');
    try {
      const other = await makeStaff(newClientIp(), 'no-mfa');
      const enrol = await staffApi('POST', '/api/staff/auth/login', { email: other.email, password: other.password }, { base: noMfa.url });
      expect(enrol.data.step).toBe('enrol');
      const listed = await staffApi('GET', '/api/staff/auth/factors', undefined, { token: enrol.data.accessToken, base: noMfa.url });
      expect(listed.data.totp.available).toBe(false);
      const refused = await staffApi('POST', '/api/staff/auth/totp/setup', {}, { token: enrol.data.accessToken, base: noMfa.url });
      expect(refused.status).toBe(403);
      expect(refused.body.message).toBe('Two-factor sign-in is not available right now.');

      const pageB = await page.context().newPage();
      await forwardToAdminApi(pageB, noMfa.url, ['/api/staff/auth/login', '/api/staff/auth/me', '/api/staff/auth/factors']);
      await pageB.goto(adminUrl('/sign-in'));
      await fillPasswordStep(pageB, other.email, other.password);
      const [listedInPage] = await Promise.all([
        pageB.waitForResponse(isStaffCall('/api/staff/auth/factors')),
        submitPasswordStep(pageB),
      ]);
      await expect(pageB).toHaveURL(adminUrl('/enrol'));
      expect(((await listedInPage.json()) as { data: { totp: { available: boolean } } }).data.totp.available).toBe(false);
      await expect(pageB.getByRole('button', { name: 'Add a passkey' })).toBeVisible();
      await expect(pageB.getByRole('button', { name: 'Use an authenticator app' })).toHaveCount(0);
      await pageB.close();
    } finally {
      await noMfa.stop();
    }
  });
});


import { randomBytes } from 'crypto';
import type { Page, Response } from '@playwright/test';
import { adminUrl } from '../../support/admin';
import { api, createAccount, createProject, newClientIp, uniqueEmail } from '../../support/api';
import { addAuthenticator, enrolTenantPasskey, enrolTotp, totpCode } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { extractLink, tokenFromLink, waitForMail } from '../../support/mailbox';
import {
  allowance,
  auditRows,
  authEvents,
  browserAssertion,
  enrolmentCodeFromCli,
  enrolStaffPasskey,
  enrolStaffTotpInFullSession,
  enrolStaffTotpOnly,
  forwardToAdminApi,
  freshTotpCode,
  issueEnrolmentCode,
  makeStaff,
  seedCustomerPasskeyRow,
  signInAttempts,
  sql,
  staffApi,
  staffHandle,
  staffPasskeySignIn,
  staffSessions,
  startPasskeyRequiredAdminApi,
  type ExtraAdminApi,
} from '../../support/areas/admauth';

/**
 * Staff sign-in on the admin app and the admin API: which API serves what, the password
 * step, the second factor after it, passkey-first sign-in, and operator enrolment codes.
 *
 * The lane's admin API runs with passkeys not required for staff (see e2e/README.md).
 * The cases for production's setting start a second admin API with
 * SUPER_ADMIN_PASSKEY_REQUIRED=true on the same database and send the page's requests
 * there.
 */

const INVALID_LOGIN = 'Invalid email or password';
const HANDLE_EXPIRED = 'Your sign-in has expired. Please start again.';
const ENROLMENT_BLOCKED = 'Staff sign-in is not set up for this account. Enter the enrolment code from your operator.';
const PASSKEY_NEEDED = 'Staff sign-in needs a passkey. Use your passkey, or ask your operator for an enrolment code.';
const TOO_MANY = 'Too many failed attempts. Try again in a few minutes.';
const NOT_RECOGNISED = 'That passkey is not recognised.';
const CODE_REFUSED = 'That code is not right. Please try again.';

const customerApi = () => {
  const base = process.env.E2E_API_URL;
  if (!base) throw new Error('E2E_API_URL is not set');
  return base;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds a page's requests to one admin API path for a moment, so a busy label can be seen. */
async function delay(page: Page, pathname: string, ms = 1000): Promise<void> {
  await page.route(adminUrl(pathname), async (route) => {
    await sleep(ms);
    await route.fallback();
  });
}

const isStaffCall = (pathname: string) => (response: Response) => new URL(response.url()).pathname === pathname;

/** Watches for refresh requests from the page. */
function watchRefreshes(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/staff/auth/session/refresh')) seen.push(request.url());
  });
  return seen;
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

const fullSessions = async (userId: string) => (await staffSessions(userId)).filter((row) => !row.enrolment_only);

/**
 * That the staff log holds no sign-in failure for this person since `since` other than a
 * wrong password sent now as a marker. A wrong password's row is written after the
 * answer, so once it is there anything written for the earlier requests is too.
 */
async function expectOnlyMarkerFailure(staff: { email: string; userId: string }, since: Date): Promise<void> {
  expect((await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: 'marker-wrong-password' })).status).toBe(401);
  await expect
    .poll(async () => (await auditRows(staff.userId, since, 'staff.sign_in_failed')).map((row) => row.metadata?.reason))
    .toEqual(['wrong_password']);
}

// ---- API split

test('ADMAUTH-001 customer API answers 404 for every admin and staff path', async ({ clientIp, request }) => {
  const staff = await makeStaff(clientIp);
  const bearer = { Authorization: `Bearer ${staff.accessToken}` };

  for (const pathname of ['/api/admin/overview', '/api/admin/tenants', '/api/staff/auth/me']) {
    expect((await staffApi('GET', pathname, undefined, { base: customerApi(), token: staff.accessToken })).status, pathname).toBe(404);
    expect((await staffApi('GET', pathname, undefined, { base: customerApi() })).status, pathname).toBe(404);
    // Through the customer app's own origin (its dev server's proxy).
    expect((await request.get(pathname, { headers: bearer })).status(), pathname).toBe(404);
    expect((await request.get(pathname)).status(), pathname).toBe(404);
  }

  const credentials = { email: staff.email, password: staff.password };
  const direct = await staffApi('POST', '/api/staff/auth/login', credentials, { base: customerApi() });
  expect(direct.status).toBe(404);
  expect(direct.setCookies).toEqual([]);
  const proxied = await request.post('/api/staff/auth/login', { data: credentials, headers: { 'X-Chumbaq-Client': 'admin' } });
  expect(proxied.status()).toBe(404);
  expect(proxied.headers()['set-cookie']).toBeUndefined();
  expect(await staffSessions(staff.userId)).toHaveLength(0);

  // The token is good: the 404s are about the paths.
  expect((await staffApi('GET', '/api/auth/me', undefined, { base: customerApi(), token: staff.accessToken })).status).toBe(200);
});

test('ADMAUTH-002 admin API answers 404 for customer routes', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'tenant');
  const project = await createProject(tenant, clientIp);
  const shortCode = `e2e-${randomBytes(4).toString('hex')}`;
  await api('POST', `/api/projects/${project.id}/links`, { longUrl: 'https://example.com/landing', shortCode }, { token: tenant.accessToken, ip: clientIp });
  // The customer API serves that code.
  expect((await staffApi('GET', `/${shortCode}`, undefined, { base: customerApi() })).status).toBe(302);

  const staff = await makeStaff(clientIp);
  const enrol = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password });
  expect(enrol.data.step).toBe('enrol');
  const staffToken: string = enrol.data.accessToken;

  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/login', { email: tenant.email, password: tenant.password }],
    ['POST', '/api/auth/impersonation/exchange', { code: 'x'.repeat(43) }],
    ['GET', '/api/users/me'],
    ['GET', '/api/projects'],
    ['GET', `/${shortCode}`],
  ];
  for (const [method, pathname, body] of routes) {
    for (const token of [undefined, staffToken]) {
      const answer = await staffApi(method, pathname, body, { token });
      expect(answer.status, `${method} ${pathname}${token ? ' with a staff token' : ''}`).toBe(404);
      expect(answer.setCookies).toEqual([]);
    }
  }
});

test('ADMAUTH-004 a customer access token is refused by the admin API', async ({ clientIp }) => {
  const staff = await makeStaff(clientIp);
  // A staff session of theirs exists, to show the refused token touches none.
  const enrol = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password });
  expect(enrol.data.step).toBe('enrol');
  const [before] = await staffSessions(staff.userId);

  for (const pathname of ['/api/staff/auth/me', '/api/admin/overview']) {
    expect((await staffApi('GET', pathname, undefined, { token: staff.accessToken })).status, pathname).toBe(401);
  }
  const [after] = await staffSessions(staff.userId);
  expect(after.last_active_at.getTime()).toBe(before.last_active_at.getTime());
  // The customer token itself is live.
  expect((await staffApi('GET', '/api/auth/me', undefined, { base: customerApi(), token: staff.accessToken })).status).toBe(200);
});

// ---- Password step

test('ADMAUTH-015 wrong password, unknown address, non-staff and suspended staff all get one answer', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp, 'staff');
  const customer = await createAccount(clientIp, 'customer');
  const suspended = await makeStaff(clientIp, 'suspended');
  await sql(`UPDATE users SET suspended_at = now() WHERE id = $1`, [suspended.userId]);
  const unknown = uniqueEmail('nobody');
  const since = new Date();
  const refreshes = watchRefreshes(page);

  await page.goto(adminUrl('/sign-in'));
  const attempts: Array<[string, string]> = [
    [staff.email, 'not-the-password-1'],
    [unknown, staff.password],
    [customer.email, customer.password],
    [suspended.email, suspended.password],
  ];
  for (const [email, password] of attempts) {
    await fillPasswordStep(page, email, password);
    const response = await submitPasswordStep(page);
    expect(response.status(), email).toBe(401);
    expect(((await response.json()) as { message: string }).message).toBe(INVALID_LOGIN);
    expect(response.headers()['set-cookie']).toBeUndefined();
    await expect(page.getByRole('alert')).toHaveText(INVALID_LOGIN);
    await expect(page).toHaveURL(adminUrl('/sign-in'));
  }

  for (const account of [staff, customer, suspended]) expect(await staffSessions(account.userId)).toHaveLength(0);
  const reasonOf = async (email: string) => (await authEvents({ email }, since, 'login.failed')).map((row) => row.reason);
  expect(await reasonOf(staff.email)).toEqual(['wrong_password']);
  expect(await reasonOf(unknown)).toEqual(['unknown_email']);
  expect(await reasonOf(customer.email)).toEqual(['not_staff']);
  expect(await reasonOf(suspended.email)).toEqual(['suspended']);

  // The staff log is written after answering, and only for the staff address.
  await expect
    .poll(async () => (await auditRows(staff.userId, since, 'staff.sign_in_failed')).map((row) => row.metadata?.reason))
    .toEqual(['wrong_password']);
  expect(await auditRows(customer.userId, since)).toHaveLength(0);
  expect(await auditRows(suspended.userId, since)).toHaveLength(0);
  const unknownRows = await sql(
    `SELECT id FROM admin_audit_logs WHERE created_at >= $1 AND (lower(actor_email) = lower($2) OR lower(target_label) = lower($2))`,
    [since, unknown],
  );
  expect(unknownRows).toHaveLength(0);
  expect(refreshes).toEqual([]);
});

test('ADMAUTH-018 login without the client header is refused', async ({ clientIp }) => {
  const staff = await makeStaff(clientIp);
  const since = new Date();
  const refused = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password }, { client: false });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe('Missing client header');
  expect(await staffSessions(staff.userId)).toHaveLength(0);

  // With the header the same request is checked (and starts enrolment for this person).
  // Its rows are written before it answers, so they are all there is: the refused
  // request before it wrote none.
  const accepted = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password });
  expect(accepted.status).toBe(200);
  expect(accepted.data.step).toBe('enrol');
  expect((await authEvents({ email: staff.email }, since)).map((row) => [row.type, row.reason])).toEqual([
    ['login.password_accepted', 'staff_enrolment'],
  ]);
  expect(await staffSessions(staff.userId)).toHaveLength(1);
});

test('ADMAUTH-019 client header is required on every route that sets or reads the staff cookie', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const signedIn = await staffPasskeySignIn(page);
  const { handle } = await staffHandle(staff);
  const hashOf = async () => (await staffSessions(staff.userId)).find((row) => row.id === signedIn.session.id)!;
  const before = await hashOf();
  const noHeader = { client: false } as const;

  const refusals: Array<[string, unknown, { token?: string; cookie?: string }]> = [
    ['/api/staff/auth/login/totp', { handle, code: '123456' }, {}],
    ['/api/staff/auth/login/passkey/verify', { handle, response: {} }, {}],
    ['/api/staff/auth/passkey/verify', { ceremonyId: 'x', response: {} }, {}],
    ['/api/staff/auth/session/refresh', {}, { cookie: signedIn.cookie }],
    ['/api/staff/auth/session/logout', {}, { token: signedIn.accessToken }],
  ];
  for (const [pathname, body, auth] of refusals) {
    const answer = await staffApi('POST', pathname, body, { ...noHeader, ...auth });
    expect(answer.status, pathname).toBe(403);
    expect(answer.body.message, pathname).toBe('Missing client header');
  }
  const after = await hashOf();
  expect(after.current_token_hash).toBe(before.current_token_hash);
  expect(after.revoked_at).toBeNull();

  // The two option routes touch no cookie and take no header.
  const options = await staffApi('POST', '/api/staff/auth/login/passkey/options', { handle }, noHeader);
  expect(options.status).toBe(200);
  expect(options.data.options.challenge).toBeTruthy();
  const passwordless = await staffApi('POST', '/api/staff/auth/passkey/options', {}, noHeader);
  expect(passwordless.status).toBe(200);
  expect(passwordless.data.ceremonyId).toBeTruthy();

  // The cookie was a working one: with the header it refreshes and rotates.
  const refreshed = await staffApi('POST', '/api/staff/auth/session/refresh', {}, { cookie: signedIn.cookie });
  expect(refreshed.status).toBe(200);
  expect((await hashOf()).current_token_hash).not.toBe(before.current_token_hash);
});

test('ADMAUTH-020 correct password with a staff passkey asks for the second factor', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  // One wrong guess from this network first: the right password must not add to it.
  expect((await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: 'wrong-password-1' }, { ip: clientIp })).status).toBe(401);
  const attemptsBefore = await signInAttempts(staff.email);
  expect(attemptsBefore).toEqual({ [`net:${clientIp}`]: '1', total: '1' });
  const since = new Date();

  await delay(page, '/api/staff/auth/login');
  await fillPasswordStep(page, staff.email, staff.password);
  const [response] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/login')),
    (async () => {
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('button', { name: 'Checking...' })).toBeDisabled();
    })(),
  ]);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { data: Record<string, unknown> };
  expect(body.data).toEqual({ step: 'second_factor', handle: expect.any(String), methods: ['webauthn'] });
  expect(response.headers()['set-cookie']).toBeUndefined();

  await expect(page.getByText('Now confirm it is you.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use your passkey' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start again' })).toBeVisible();
  await expect(page.getByLabel('Code from your authenticator app')).toHaveCount(0);

  expect((await authEvents({ userId: staff.userId }, since)).map((row) => [row.type, row.reason])).toEqual([['login.password_accepted', null]]);
  expect(await authEvents({ userId: staff.userId }, new Date(0), 'login.succeeded')).toHaveLength(0);
  expect(await signInAttempts(staff.email)).toEqual(attemptsBefore);
});

test('ADMAUTH-021 a password alone never signs in', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const sessionsBefore = (await staffSessions(staff.userId)).length;

  const login = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password });
  expect(login.status).toBe(200);
  expect(Object.keys(login.data).sort()).toEqual(['handle', 'methods', 'step']);
  expect(login.setCookies).toEqual([]);

  for (const pathname of ['/api/staff/auth/me', '/api/admin/overview']) {
    expect((await staffApi('GET', pathname)).status, pathname).toBe(401);
    expect((await staffApi('GET', pathname, undefined, { token: login.data.handle })).status, pathname).toBe(401);
  }
  expect(await staffSessions(staff.userId)).toHaveLength(sessionsBefore);
});

test('ADMAUTH-022 shared sign-in failure limit locks the address after 10 failures', async ({ page, clientIp }) => {
  test.slow(); // Waits out the per-route throttle once.
  const staff = await makeStaff(clientIp);
  const other = await makeStaff(clientIp, 'other-staff');

  // Five on the staff route and five on the customer route, from one network: one limit.
  for (let i = 0; i < 5; i++) {
    expect((await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: `wrong-${i}-password` }, { ip: clientIp })).status).toBe(401);
  }
  const customerStarted = Date.now();
  for (let i = 0; i < 5; i++) {
    const answer = await staffApi('POST', '/api/auth/login', { email: staff.email, password: `wrong-${i}-again` }, { ip: clientIp, base: customerApi() });
    expect(answer.status).toBe(401);
  }
  expect((await signInAttempts(staff.email))[`net:${clientIp}`]).toBe('10');
  // Both routes take 5 a minute from one address; wait that out so the 11th meets the limit itself.
  await sleep(Math.max(0, customerStarted + 61_000 - Date.now()));
  const since = new Date();

  await page.goto(adminUrl('/sign-in'));
  await fillPasswordStep(page, staff.email, staff.password);
  const response = await submitPasswordStep(page);
  expect(response.status()).toBe(429);
  expect(((await response.json()) as { data?: unknown }).data).toBeUndefined();
  await expect(page.getByRole('alert')).toHaveText(TOO_MANY);
  await expect(page.getByText('Now confirm it is you.')).toHaveCount(0);
  expect((await authEvents({ email: staff.email }, since, 'login.limited')).length).toBeGreaterThanOrEqual(1);

  const customer = await staffApi('POST', '/api/auth/login', { email: staff.email, password: staff.password }, { ip: clientIp, base: customerApi() });
  expect(customer.status).toBe(429);
  expect(customer.body.message).toBe(TOO_MANY);

  // Another address from the same network is not held by it.
  const unaffected = await staffApi('POST', '/api/staff/auth/login', { email: other.email, password: other.password }, { ip: clientIp });
  expect(unaffected.status).toBe(200);
  expect(unaffected.data.step).toBe('enrol');
});

// ---- Second factor after the password

test('ADMAUTH-027 passkey second factor signs in', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const keys = await sql<{ credential_id: string }>(`SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`, [staff.userId]);
  expect(keys).toHaveLength(1);
  const since = new Date();

  await fillPasswordStep(page, staff.email, staff.password);
  await submitPasswordStep(page);
  await delay(page, '/api/staff/auth/login/passkey/options');
  const optionsResponse = page.waitForResponse(isStaffCall('/api/staff/auth/login/passkey/options'));
  const verifyResponse = page.waitForResponse(isStaffCall('/api/staff/auth/login/passkey/verify'));
  await page.getByRole('button', { name: 'Use your passkey' }).click();
  await expect(page.getByRole('button', { name: 'Waiting for your passkey...' })).toBeDisabled();

  const options = (await (await optionsResponse).json()) as { data: { options: { allowCredentials: Array<{ id: string }>; userVerification: string } } };
  expect(options.data.options.allowCredentials.map((c) => c.id)).toEqual([keys[0].credential_id]);
  expect(options.data.options.userVerification).toBe('required');

  const verified = await verifyResponse;
  expect(verified.status()).toBe(200);
  const body = (await verified.json()) as { data: { step: string; accessToken: string; session: { id: string; expiresAt: string } } };
  expect(body.data.step).toBe('signed_in');
  expect(body.data.accessToken).toBeTruthy();
  await expect(page).toHaveURL(adminUrl('/'));

  const setCookie = (await verified.headerValue('set-cookie')) ?? '';
  expect(setCookie).toMatch(/^(__Host-)?chumbaq_staff_refresh=/);
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
  const untilEnd = (new Date(body.data.session.expiresAt).getTime() - Date.now()) / 1000;
  expect(Math.abs(maxAge - untilEnd)).toBeLessThan(60);
  const [cookie] = (await context.cookies(adminUrl('/'))).filter((c) => c.name.endsWith('chumbaq_staff_refresh'));
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  if (cookie.name.startsWith('__Host-')) {
    expect(cookie.secure).toBe(true);
    expect(cookie.path).toBe('/');
  }

  const [session] = await fullSessions(staff.userId);
  expect(session.id).toBe(body.data.session.id);
  expect(session.amr).toEqual(['pwd', 'webauthn']);
  expect(session.enrolment_only).toBe(false);
  expect(await authEvents({ userId: staff.userId }, since, 'login.succeeded')).toHaveLength(1);
  const [audit] = await auditRows(staff.userId, since, 'staff.signed_in');
  expect(audit.metadata).toEqual({ amr: ['pwd', 'webauthn'], sessionId: session.id });
});

test('ADMAUTH-030 wrong key at the second factor', async ({ page, browser, baseURL, clientIp }) => {
  const a = await makeStaff(clientIp, 'staff-a');
  const b = await makeStaff(clientIp, 'staff-b');
  await enrolStaffPasskey(page, a);
  const other = await newPersonContext(browser, baseURL);
  const pageB = await other.context.newPage();
  try {
    await enrolStaffPasskey(pageB, b);
    const since = new Date();
    const { handle } = await staffHandle(a);
    const options = await staffApi('POST', '/api/staff/auth/login/passkey/options', { handle });
    expect(options.status).toBe(200);
    // B's key answers A's challenge (B's authenticator holds only B's key).
    const wrongKey = await browserAssertion(pageB, { ...options.data.options, allowCredentials: [] });
    const counted = Number((await signInAttempts(a.email))['second-factor'] ?? 0);

    const refused = await staffApi('POST', '/api/staff/auth/login/passkey/verify', { handle, response: wrongKey });
    expect(refused.status).toBe(401);
    expect(refused.body.message).toBe('Could not verify that passkey.');
    expect(refused.setCookies).toEqual([]);
    expect(Number((await signInAttempts(a.email))['second-factor'])).toBe(counted + 1);
    expect((await authEvents({ userId: a.userId }, since, 'login.failed')).map((row) => row.reason)).toEqual(['passkey_failed']);
    expect((await auditRows(a.userId, since, 'staff.sign_in_failed')).map((row) => row.metadata?.reason)).toEqual(['passkey_failed']);
    expect(await fullSessions(a.userId)).toHaveLength(0);

    // The handle was not spent: A's own key still signs in with it.
    const again = await staffApi('POST', '/api/staff/auth/login/passkey/options', { handle });
    const rightKey = await browserAssertion(page, again.data.options);
    const signedIn = await staffApi('POST', '/api/staff/auth/login/passkey/verify', { handle, response: rightKey });
    expect(signedIn.status).toBe(200);
    expect(signedIn.data.step).toBe('signed_in');
  } finally {
    await other.context.close();
  }
});

test('ADMAUTH-032 second-factor handle works once', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const { handle } = await staffHandle(staff);
  const options = await staffApi('POST', '/api/staff/auth/login/passkey/options', { handle });
  const response = await browserAssertion(page, options.data.options);
  const first = await staffApi('POST', '/api/staff/auth/login/passkey/verify', { handle, response });
  expect(first.status).toBe(200);
  expect(await fullSessions(staff.userId)).toHaveLength(1);

  const replayOptions = await staffApi('POST', '/api/staff/auth/login/passkey/options', { handle });
  expect(replayOptions.status).toBe(401);
  expect(replayOptions.body.message).toBe(HANDLE_EXPIRED);
  const replay = await staffApi('POST', '/api/staff/auth/login/passkey/verify', { handle, response });
  expect(replay.status).toBe(401);
  expect(replay.body.message).toBe(HANDLE_EXPIRED);
  expect(replay.setCookies).toEqual([]);
  expect(await fullSessions(staff.userId)).toHaveLength(1);
});

test('ADMAUTH-033 staff access removed between password and passkey', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const since = new Date();
  const changes: Array<[string, string, string | null]> = [
    ['no longer staff', `UPDATE users SET is_super_admin = false WHERE id = $1`, `UPDATE users SET is_super_admin = true WHERE id = $1`],
    ['suspended', `UPDATE users SET suspended_at = now() WHERE id = $1`, `UPDATE users SET suspended_at = NULL WHERE id = $1`],
    ['signed out everywhere', `UPDATE users SET session_version = session_version + 1 WHERE id = $1`, null],
  ];
  for (const [label, change, restore] of changes) {
    const { handle } = await staffHandle(staff);
    const options = await staffApi('POST', '/api/staff/auth/login/passkey/options', { handle });
    const response = await browserAssertion(page, options.data.options);
    await sql(change, [staff.userId]);
    const refused = await staffApi('POST', '/api/staff/auth/login/passkey/verify', { handle, response });
    expect(refused.status, label).toBe(401);
    expect(refused.body.message, label).toBe(HANDLE_EXPIRED);
    expect(refused.setCookies, label).toEqual([]);
    if (restore) await sql(restore, [staff.userId]);
  }
  expect(await fullSessions(staff.userId)).toHaveLength(0);
  expect(await authEvents({ userId: staff.userId }, since, 'login.succeeded')).toHaveLength(0);
});

test('ADMAUTH-034 a customer-app handle is refused by the staff routes, and the reverse', async ({ clientIp }) => {
  test.slow(); // May wait for a fresh authenticator code.
  const account = await createAccount(clientIp, 'both-apps');
  // An authenticator app from the customer app (before staff); staff routes count it too.
  const enrolment = await enrolTotp({ ip: clientIp }, account);
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [account.userId]);

  const customerLogin = await staffApi('POST', '/api/auth/login', { email: account.email, password: account.password }, { base: customerApi() });
  expect(customerLogin.data.requiresSecondFactor).toBe(true);
  const customerHandle: string = customerLogin.data.handle;
  const { handle: staffSideHandle, methods } = await staffHandle(account);
  expect(methods).toEqual(['totp']);

  // A right code, so only the handle can be what is refused.
  const rightNow = totpCode(enrolment.secret);
  for (const [pathname, body] of [
    ['/api/staff/auth/login/passkey/options', { handle: customerHandle }],
    ['/api/staff/auth/login/totp', { handle: customerHandle, code: rightNow }],
  ] as const) {
    const refused = await staffApi('POST', pathname, body);
    expect(refused.status, pathname).toBe(401);
    expect(refused.body.message, pathname).toBe(HANDLE_EXPIRED);
  }
  const reverse = await staffApi('POST', '/api/auth/login/passkey/options', { handle: staffSideHandle }, { base: customerApi() });
  expect(reverse.status).toBe(401);
  expect(reverse.body.message).toBe(HANDLE_EXPIRED);
  // The same option routes answer each handle in its own app.
  expect((await staffApi('POST', '/api/staff/auth/login/passkey/options', { handle: staffSideHandle })).status).toBe(200);
  expect((await staffApi('POST', '/api/auth/login/passkey/options', { handle: customerHandle }, { base: customerApi() })).status).toBe(200);

  // Each still works in its own app.
  const customerSignedIn = await staffApi(
    'POST',
    '/api/auth/login/totp',
    { handle: customerHandle, code: await freshTotpCode(enrolment) },
    { base: customerApi() },
  );
  expect(customerSignedIn.status).toBe(200);
  const staffSignedIn = await staffApi('POST', '/api/staff/auth/login/totp', { handle: staffSideHandle, code: await freshTotpCode(enrolment) });
  expect(staffSignedIn.status).toBe(200);
  expect(staffSignedIn.data.step).toBe('signed_in');
});

test('ADMAUTH-035 authenticator app second factor signs in', async ({ page, clientIp }) => {
  test.slow();
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const { accessToken } = await staffPasskeySignIn(page);
  const enrolment = await enrolStaffTotpInFullSession(page, accessToken);
  const since = new Date();

  await page.goto(adminUrl('/sign-in'));
  await fillPasswordStep(page, staff.email, staff.password);
  await submitPasswordStep(page);
  await expect(page.getByRole('button', { name: 'Use your passkey' })).toBeVisible();
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(enrolment));
  const [verified] = await Promise.all([
    page.waitForResponse(isStaffCall('/api/staff/auth/login/totp')),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  expect(verified.status()).toBe(200);
  await expect(page).toHaveURL(adminUrl('/'));

  const sessionId = ((await verified.json()) as { data: { session: { id: string } } }).data.session.id;
  const session = (await staffSessions(staff.userId)).find((row) => row.id === sessionId)!;
  expect(session.amr).toEqual(['pwd', 'totp']);
  const [audit] = await auditRows(staff.userId, since, 'staff.signed_in');
  expect(audit.metadata).toEqual({ amr: ['pwd', 'totp'], sessionId });
});

test('ADMAUTH-037 wrong or reused authenticator code', async ({ page, clientIp }) => {
  test.slow();
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const { accessToken } = await staffPasskeySignIn(page);
  const enrolment = await enrolStaffTotpInFullSession(page, accessToken);
  const since = new Date();
  const refreshes = watchRefreshes(page);

  await page.goto(adminUrl('/sign-in'));
  await fillPasswordStep(page, staff.email, staff.password);
  await submitPasswordStep(page);
  const code = page.getByLabel('Code from your authenticator app');
  const signInButton = page.getByRole('button', { name: 'Sign in', exact: true });

  const submit = async (value: string) => {
    await code.fill(value);
    const [response] = await Promise.all([page.waitForResponse(isStaffCall('/api/staff/auth/login/totp')), signInButton.click()]);
    return response;
  };

  // A wrong code.
  expect((await submit('000000')).status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(CODE_REFUSED);
  await expect(code).toHaveValue('');
  await expect(page.getByText('Now confirm it is you.')).toBeVisible();

  // A code already used in its step (by a sign-in elsewhere).
  const used = await freshTotpCode(enrolment);
  const { handle } = await staffHandle(staff);
  expect((await staffApi('POST', '/api/staff/auth/login/totp', { handle, code: used })).status).toBe(200);
  expect((await submit(used)).status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(CODE_REFUSED);
  await expect(code).toHaveValue('');
  expect(refreshes).toEqual([]);

  // The same handle still signs in with a right code.
  expect((await submit(await freshTotpCode(enrolment))).status()).toBe(200);
  await expect(page).toHaveURL(adminUrl('/'));

  expect((await authEvents({ userId: staff.userId }, since, 'login.failed')).map((row) => row.reason)).toEqual(['totp_failed', 'totp_failed']);
  expect((await auditRows(staff.userId, since, 'staff.sign_in_failed')).map((row) => row.metadata?.reason)).toEqual(['totp_failed', 'totp_failed']);
});

// ---- Passkey first

test('ADMAUTH-042 sign in with a passkey from the first screen', async ({ page, context, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const since = new Date();

  await delay(page, '/api/staff/auth/passkey/options');
  const optionsResponse = page.waitForResponse(isStaffCall('/api/staff/auth/passkey/options'));
  const verifyResponse = page.waitForResponse(isStaffCall('/api/staff/auth/passkey/verify'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('button', { name: 'Waiting for your passkey...' })).toBeDisabled();

  const options = (await (await optionsResponse).json()) as { data: { ceremonyId: string; options: { allowCredentials?: unknown[]; userVerification: string } } };
  expect(options.data.ceremonyId).toBeTruthy();
  expect(options.data.options.allowCredentials ?? []).toEqual([]);
  expect(options.data.options.userVerification).toBe('required');
  const verified = await verifyResponse;
  expect(verified.status()).toBe(200);
  const body = (await verified.json()) as { data: { step: string; session: { id: string } } };
  expect(body.data.step).toBe('signed_in');
  await expect(page).toHaveURL(adminUrl('/'));

  expect((await verified.headerValue('set-cookie')) ?? '').toMatch(/^(__Host-)?chumbaq_staff_refresh=.*HttpOnly/);
  expect((await context.cookies(adminUrl('/'))).some((c) => c.name.endsWith('chumbaq_staff_refresh') && c.httpOnly)).toBe(true);
  const [session] = await fullSessions(staff.userId);
  expect(session.id).toBe(body.data.session.id);
  expect(session.amr).toEqual(['webauthn', 'uv']);
  expect(await authEvents({ userId: staff.userId }, since, 'login.succeeded')).toHaveLength(1);
  const [audit] = await auditRows(staff.userId, since, 'staff.signed_in');
  expect(audit.metadata).toEqual({ amr: ['webauthn', 'uv'], sessionId: session.id });
});

test('ADMAUTH-044 passkey of someone who is no longer staff, or suspended', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await enrolStaffPasskey(page, staff);
  const since = new Date();
  const attemptsBefore = await signInAttempts(staff.email);

  const cases: Array<[string, string, string]> = [
    ['no longer staff', `UPDATE users SET is_super_admin = false WHERE id = $1`, `UPDATE users SET is_super_admin = true WHERE id = $1`],
    ['suspended', `UPDATE users SET suspended_at = now() WHERE id = $1`, `UPDATE users SET suspended_at = NULL WHERE id = $1`],
  ];
  for (const [label, change, restore] of cases) {
    await sql(change, [staff.userId]);
    await page.goto(adminUrl('/sign-in'));
    const [verified] = await Promise.all([
      page.waitForResponse(isStaffCall('/api/staff/auth/passkey/verify')),
      page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
    ]);
    expect(verified.status(), label).toBe(401);
    await expect(page.getByRole('alert')).toHaveText(NOT_RECOGNISED);
    await expect(page).toHaveURL(adminUrl('/sign-in'));
    await sql(restore, [staff.userId]);
  }
  expect(await fullSessions(staff.userId)).toHaveLength(0);
  expect((await authEvents({ userId: staff.userId }, since, 'passkey.failed')).map((row) => row.reason)).toEqual([
    'staff_passwordless',
    'staff_passwordless',
  ]);
  expect(await signInAttempts(staff.email)).toEqual(attemptsBefore);

  // Restored, the same key signs in again: the refusals were about the account.
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(adminUrl('/'));
});

test('ADMAUTH-045 customer-scope key cannot sign in to the admin app', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'customer-key');
  await signIn(page, account);
  await addAuthenticator(page);
  await enrolTenantPasskey(page, account, 'Customer key');
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [account.userId]);
  const [customerKey] = await sql<{ credential_id: string; scope: string }>(
    `SELECT credential_id, scope FROM webauthn_credentials WHERE user_id = $1`,
    [account.userId],
  );
  expect(customerKey.scope).toBe('customer');

  // A fresh admin ceremony, answered by the customer key in a customer-app page.
  const started = await staffApi('POST', '/api/staff/auth/passkey/options', {});
  const response = await browserAssertion(page, started.data.options);
  expect(response.id).toBe(customerKey.credential_id);
  const refused = await staffApi('POST', '/api/staff/auth/passkey/verify', { ceremonyId: started.data.ceremonyId, response });
  expect(refused.status).toBe(401);
  expect(refused.body.message).toBe(NOT_RECOGNISED);
  expect(refused.setCookies).toEqual([]);
  expect(await staffSessions(account.userId)).toHaveLength(0);
});

// ---- Enrolment codes (passkeys not required)

test('ADMAUTH-050 a staff member holding any passkey needs a code', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await seedCustomerPasskeyRow(staff.userId);
  const since = new Date();

  await page.goto(adminUrl('/sign-in'));
  await fillPasswordStep(page, staff.email, staff.password);
  const response = await submitPasswordStep(page);
  expect(response.status()).toBe(403);
  expect(response.headers()['set-cookie']).toBeUndefined();
  await expect(page.getByRole('alert')).toHaveText(ENROLMENT_BLOCKED);
  const code = page.getByLabel('Enrolment code from your operator');
  await expect(code).toBeVisible();
  await expect(code).toHaveAttribute('required', '');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(staff.password);
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeDisabled();
  await code.fill('   ');
  await expect(continueButton).toBeDisabled();
  await code.fill('something');
  await expect(continueButton).toBeEnabled();

  expect((await authEvents({ userId: staff.userId }, since)).map((row) => [row.type, row.reason])).toEqual([
    ['login.password_accepted', 'staff_enrolment_blocked'],
  ]);
  expect(await staffSessions(staff.userId)).toHaveLength(0);
  await expectOnlyMarkerFailure(staff, since);
});

test('ADMAUTH-052 right code opens an enrolment session', async ({ page, clientIp }) => {
  test.slow(); // The code comes from the CLI, through ts-node.
  const staff = await makeStaff(clientIp);
  await seedCustomerPasskeyRow(staff.userId);
  const since = new Date();
  const { code, stdout } = await enrolmentCodeFromCli(staff.email);
  expect(stdout).toContain(`One-time enrolment code for ${staff.email}, good until`);
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const [allowed] = await auditRows(staff.userId, since, 'staff.enrolment_allowed');
  expect(allowed.actor_email).toBe('cli');
  const allowanceId = allowed.metadata?.allowanceId as string;

  await page.goto(adminUrl('/sign-in'));
  await fillPasswordStep(page, staff.email, staff.password);
  expect((await submitPasswordStep(page)).status()).toBe(403);
  await page.getByLabel('Enrolment code from your operator').fill(code);
  const response = await submitPasswordStep(page);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(adminUrl('/enrol'));
  const body = (await response.json()) as { data: { step: string; accessToken: string; session: { id: string; enrolmentOnly: boolean; expiresAt: string } } };
  expect(body.data.step).toBe('enrol');
  expect(body.data.accessToken).toBeTruthy();
  expect(body.data.session.enrolmentOnly).toBe(true);
  expect(response.headers()['set-cookie']).toBeUndefined();

  const [row] = await sql<{ id: string; enrolment_only: boolean; current_token_hash: string | null; created_at: Date }>(
    `SELECT id, enrolment_only, current_token_hash, created_at FROM staff_sessions WHERE user_id = $1`,
    [staff.userId],
  );
  expect(row.id).toBe(body.data.session.id);
  expect(row.enrolment_only).toBe(true);
  expect(row.current_token_hash).toBeNull();
  expect(Math.abs(new Date(body.data.session.expiresAt).getTime() - row.created_at.getTime() - 15 * 60 * 1000)).toBeLessThan(2000);

  const spent = await allowance(allowanceId);
  expect(spent.used_at).not.toBeNull();
  expect(spent.used_ip).toBe(clientIp);
  const [started] = await auditRows(staff.userId, since, 'staff.enrolment_started');
  expect(started.metadata).toEqual({ allowanceId, sessionId: row.id });
  expect(
    (await authEvents({ userId: staff.userId }, since, 'login.password_accepted')).map((event) => event.reason),
  ).toEqual(['staff_enrolment_blocked', 'staff_enrolment']);
  await waitForMail(staff.email, { subjectIncludes: 'Staff sign-in setup started on your Chumbaq account' });
});

test('ADMAUTH-054 wrong code keeps the field and counts as a failure', async ({ page, clientIp }) => {
  const staff = await makeStaff(clientIp);
  await seedCustomerPasskeyRow(staff.userId);
  const issued = await issueEnrolmentCode(staff.userId);
  const since = new Date();

  await page.goto(adminUrl('/sign-in'));
  await fillPasswordStep(page, staff.email, staff.password);
  expect((await submitPasswordStep(page)).status()).toBe(403);
  const field = page.getByLabel('Enrolment code from your operator');
  const wrong = `wrong-${randomBytes(8).toString('hex')}`;
  await field.fill(wrong);
  const refused = await submitPasswordStep(page);
  expect(refused.status()).toBe(403);
  await expect(page.getByRole('alert')).toHaveText(ENROLMENT_BLOCKED);
  await expect(field).toHaveValue(wrong);

  expect((await authEvents({ userId: staff.userId }, since, 'login.failed')).map((row) => row.reason)).toEqual(['enrolment_code_refused']);
  expect((await auditRows(staff.userId, since, 'staff.sign_in_failed')).map((row) => row.metadata?.reason)).toEqual(['enrolment_code_refused']);
  expect((await allowance(issued.id)).used_at).toBeNull();

  await field.fill(issued.code);
  expect((await submitPasswordStep(page)).status()).toBe(200);
  await expect(page).toHaveURL(adminUrl('/enrol'));
});

test('ADMAUTH-056 code is never tested without the right password', async ({ clientIp }) => {
  const staff = await makeStaff(clientIp);
  await seedCustomerPasskeyRow(staff.userId);
  const issued = await issueEnrolmentCode(staff.userId);
  const since = new Date();

  const refused = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: 'not-the-password-1', enrolmentCode: issued.code });
  expect(refused.status).toBe(401);
  expect(refused.body.message).toBe(INVALID_LOGIN);
  expect((await allowance(issued.id)).used_at).toBeNull();
  await expect
    .poll(async () => (await auditRows(staff.userId, since, 'staff.sign_in_failed')).map((row) => row.metadata?.reason))
    .toEqual(['wrong_password']);

  const accepted = await staffApi('POST', '/api/staff/auth/login', { email: staff.email, password: staff.password, enrolmentCode: issued.code });
  expect(accepted.status).toBe(200);
  expect(accepted.data.step).toBe('enrol');
  expect((await allowance(issued.id)).used_at).not.toBeNull();
  expect((await auditRows(staff.userId, since, 'staff.sign_in_failed')).map((row) => row.metadata?.reason)).toEqual(['wrong_password']);
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

  test('ADMAUTH-040 authenticator app is not a staff factor while passkeys are required', async ({ page, clientIp }) => {
    test.slow();
    const staff = await makeStaff(clientIp);
    await enrolStaffPasskey(page, staff);
    const { accessToken } = await staffPasskeySignIn(page);
    const enrolment = await enrolStaffTotpInFullSession(page, accessToken);

    // 1. The password step offers the passkey only.
    await forwardToAdminApi(page, required.url, [
      '/api/staff/auth/login',
      '/api/staff/auth/login/passkey/options',
      '/api/staff/auth/login/passkey/verify',
      '/api/staff/auth/me',
    ]);
    await page.goto(adminUrl('/sign-in'));
    await fillPasswordStep(page, staff.email, staff.password);
    const login = await submitPasswordStep(page);
    expect(((await login.json()) as { data: { methods: string[] } }).data.methods).toEqual(['webauthn']);
    await expect(page.getByRole('button', { name: 'Use your passkey' })).toBeVisible();
    await expect(page.getByLabel('Code from your authenticator app')).toHaveCount(0);

    // 2. A right code is refused before it is tried, and the handle is kept.
    const { handle, methods } = await staffHandle(staff, newClientIp(), required.url);
    expect(methods).toEqual(['webauthn']);
    const stepOf = async () =>
      (await sql<{ last_used_step: string }>(`SELECT last_used_step FROM totp_secrets WHERE user_id = $1`, [staff.userId]))[0].last_used_step;
    const stepBefore = await stepOf();
    const code = await freshTotpCode(enrolment);
    const refused = await staffApi('POST', '/api/staff/auth/login/totp', { handle, code }, { base: required.url });
    expect(refused.status).toBe(401);
    expect(refused.body.message).toBe(PASSKEY_NEEDED);
    expect(await stepOf()).toBe(stepBefore);

    // The same code still works in the customer app.
    const customer = await staffApi('POST', '/api/auth/login', { email: staff.email, password: staff.password }, { base: customerApi() });
    expect(customer.data.requiresSecondFactor).toBe(true);
    const customerSignedIn = await staffApi('POST', '/api/auth/login/totp', { handle: customer.data.handle, code }, { base: customerApi() });
    expect(customerSignedIn.status).toBe(200);
    expect(Number(await stepOf())).toBeGreaterThan(Number(stepBefore));

    // And the kept handle still signs in with the passkey.
    const options = await staffApi('POST', '/api/staff/auth/login/passkey/options', { handle }, { base: required.url });
    const response = await browserAssertion(page, options.data.options);
    const signedIn = await staffApi('POST', '/api/staff/auth/login/passkey/verify', { handle, response }, { base: required.url });
    expect(signedIn.status).toBe(200);
    expect(signedIn.data.step).toBe('signed_in');

    // In the page, "Use your passkey" completes its own sign-in.
    await page.getByRole('button', { name: 'Use your passkey' }).click();
    await expect(page).toHaveURL(adminUrl('/'));
  });

  test('ADMAUTH-041 authenticator-only staff member needs an enrolment code', async ({ page, clientIp }) => {
    const staff = await makeStaff(clientIp);
    await enrolStaffTotpOnly(staff);
    // Under the lane's setting the app is their staff factor.
    expect((await staffHandle(staff)).methods).toEqual(['totp']);

    await forwardToAdminApi(page, required.url, ['/api/staff/auth/login']);
    await page.goto(adminUrl('/sign-in'));
    await fillPasswordStep(page, staff.email, staff.password);
    const response = await submitPasswordStep(page);
    expect(response.status()).toBe(403);
    await expect(page.getByRole('alert')).toHaveText(ENROLMENT_BLOCKED);
    await expect(page.getByLabel('Enrolment code from your operator')).toBeVisible();
    await expect(page.getByText('Now confirm it is you.')).toHaveCount(0);
  });

  test('ADMAUTH-051 every staff member needs a code while passkeys are required', async ({ page, clientIp }) => {
    const staff = await makeStaff(clientIp);
    const since = new Date();

    await forwardToAdminApi(page, required.url, ['/api/staff/auth/login']);
    await page.goto(adminUrl('/sign-in'));
    await fillPasswordStep(page, staff.email, staff.password);
    const response = await submitPasswordStep(page);
    expect(response.status()).toBe(403);
    expect(response.headers()['set-cookie']).toBeUndefined();
    await expect(page.getByRole('alert')).toHaveText(ENROLMENT_BLOCKED);
    const code = page.getByLabel('Enrolment code from your operator');
    await expect(code).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(staff.password);
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await code.fill('   ');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

    expect((await authEvents({ userId: staff.userId }, since)).map((row) => [row.type, row.reason])).toEqual([
      ['login.password_accepted', 'staff_enrolment_blocked'],
    ]);
    expect(await staffSessions(staff.userId)).toHaveLength(0);
    await expectOnlyMarkerFailure(staff, since);
  });

  test('ADMAUTH-055 spent, expired, replaced and voided codes all get the same answer', async ({ clientIp }) => {
    const staff = await makeStaff(clientIp);
    await seedCustomerPasskeyRow(staff.userId);
    const login = (password: string, enrolmentCode: string, base?: string) =>
      staffApi('POST', '/api/staff/auth/login', { email: staff.email, password, enrolmentCode }, { base });
    const expectBlocked = async (label: string, answer: Awaited<ReturnType<typeof login>>) => {
      expect(answer.status, label).toBe(403);
      expect(answer.body.message, label).toBe(ENROLMENT_BLOCKED);
    };

    // a. Spent: used once, the enrolment session left without enrolling.
    const spent = await issueEnrolmentCode(staff.userId);
    expect((await login(staff.password, spent.code)).data.step).toBe('enrol');
    await expectBlocked('spent', await login(staff.password, spent.code));

    // b. Expired.
    const expired = await issueEnrolmentCode(staff.userId);
    await sql(`UPDATE staff_enrolment_allowances SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired.id]);
    await expectBlocked('expired', await login(staff.password, expired.code));
    expect((await allowance(expired.id)).used_at).toBeNull();

    // c. Replaced by a second code; the second still works.
    const first = await issueEnrolmentCode(staff.userId);
    const second = await issueEnrolmentCode(staff.userId);
    expect((await allowance(first.id)).voided_reason).toBe('replaced');
    await expectBlocked('replaced', await login(staff.password, first.code));
    expect((await allowance(first.id)).used_at).toBeNull();
    expect((await allowance(second.id)).used_at).toBeNull();
    expect((await login(staff.password, second.code)).data.step).toBe('enrol');

    // e. Voided by a customer password reset.
    const beforeReset = await issueEnrolmentCode(staff.userId);
    await staffApi('POST', '/api/auth/forgot-password', { email: staff.email }, { base: customerApi() });
    const mail = await waitForMail(staff.email, { subjectIncludes: 'Reset your Chumbaq password' });
    const newPassword = 'e2e-Reset-Password-456!';
    const reset = await staffApi(
      'POST',
      '/api/auth/reset-password',
      { token: tokenFromLink(extractLink(mail, '/reset-password')), newPassword },
      { base: customerApi() },
    );
    expect(reset.status).toBe(200);
    const voided = await allowance(beforeReset.id);
    expect(voided.voided_reason).toBe('password_reset');
    expect(voided.voided_at).not.toBeNull();
    await expectBlocked('voided by a password reset', await login(newPassword, beforeReset.code));
    expect((await allowance(beforeReset.id)).used_at).toBeNull();

    // d. Voided by enrolling a factor, for someone who still needs a code: an
    // authenticator app only, while passkeys are required.
    const appOnly = await makeStaff(clientIp, 'app-only');
    const issuedFirst = await issueEnrolmentCode(appOnly.userId);
    await enrolStaffTotpOnly(appOnly);
    expect((await allowance(issuedFirst.id)).voided_reason).toBe('enrolled');
    const refused = await staffApi(
      'POST',
      '/api/staff/auth/login',
      { email: appOnly.email, password: appOnly.password, enrolmentCode: issuedFirst.code },
      { base: required.url },
    );
    await expectBlocked('voided by enrolling', refused);
    expect((await allowance(issuedFirst.id)).used_at).toBeNull();
  });
});

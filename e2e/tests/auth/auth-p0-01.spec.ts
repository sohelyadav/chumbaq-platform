import type { Page, Response } from '@playwright/test';
import { createAccount, createProject, newClientIp, uniqueEmail, type Account } from '../../support/api';
import { adminUrl } from '../../support/admin';
import {
  addAuthenticator,
  blockPasskeyAutofill,
  enrolTenantPasskey,
  enrolTotp,
  type TotpEnrolment,
} from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  assertionInPage,
  authEventsFor,
  customerCredentialIds,
  dbNow,
  enrolTotpConfirmingWithPasskey,
  formMessage,
  freshTotpCode,
  handleFor,
  insertStaffPasskeyRow,
  makeSuperAdmin,
  passwordStep,
  post,
  refreshCookie,
  seedResetToken,
  seedSignInFailures,
  sessionsSince,
  signOutFromMenu,
  sql,
  submitLogin,
  suspendAccount,
  userHandleOf,
  wrongTotpCode,
} from '../../support/areas/auth';

/**
 * Customer sign-in: the route guards and ?next=, the password form, the failure limit,
 * the second step (authenticator app, recovery code, passkey) and passwordless passkey
 * sign-in, through the customer app and its API.
 */

const INVALID = 'Invalid email or password';
const LIMITED = 'Too many failed attempts. Try again in a few minutes.';
const CODE_REFUSED = 'That code is not right. Please try again.';
const FLOW_EXPIRED = 'Your sign-in has expired. Please start again.';
const PASSKEY_REFUSED = 'Could not verify that passkey.';
const STAFF_KEYS_ONLY =
  'Your staff passkeys work only in the admin app. Add an authenticator app there to sign in here.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isApi = (path: string) => (response: Response) => new URL(response.url()).pathname === path;

/** Holds every request to `path` until `release` is called, so a waiting state can be seen. */
async function holdRequests(page: Page, path: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${path}`, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

function withoutTimestamp(text: string): Record<string, unknown> {
  const { timestamp, ...rest } = JSON.parse(text) as Record<string, unknown>;
  expect(typeof timestamp).toBe('string');
  return rest;
}

/** An account with a confirmed authenticator app (through the API) and its recovery codes. */
async function totpAccount(ip: string, label: string): Promise<{ account: Account; totp: TotpEnrolment }> {
  const account = await createAccount(ip, label, `${label} person`);
  const totp = await enrolTotp({ ip }, account);
  return { account, totp };
}

/**
 * An account with a customer passkey on this tab's virtual authenticator, signed out on
 * /login. Autofill is blocked first, or the authenticator would sign straight back in.
 */
async function passkeyAccount(page: Page, ip: string, label: string): Promise<{ account: Account; recoveryCodes: string[] }> {
  await blockPasskeyAutofill(page);
  await addAuthenticator(page);
  const account = await createAccount(ip, label, `${label} person`);
  await signIn(page, account);
  const recoveryCodes = await enrolTenantPasskey(page, account);
  await signOutFromMenu(page, account.name);
  return { account, recoveryCodes };
}

// ---- Routing, guards and redirects

test('AUTH-003 protected pages send an anonymous visitor to /login with no next parameter', async ({ page, clientIp, baseURL }) => {
  const owner = await createAccount(clientIp, 'auth003-owner');
  const project = await createProject(owner, clientIp, `AUTH-003 private ${Date.now()}`);
  const projectCalls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/projects')) projectCalls.push(request.url());
  });

  for (const path of ['/projects', '/settings', `/projects/${project.id}/links`, '/account/billing']) {
    await page.goto(path);
    await expect(page).toHaveURL(`${baseURL}/login`);
    await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
    await expect(page.getByText(project.name)).toHaveCount(0);
  }
  expect(projectCalls).toEqual([]);
});

test('AUTH-008 sign-in returns to the cancel-support-link page through ?next=', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth008');
  await page.goto('/login?next=%2Faccount%2Fcancel-support-link');
  await submitLogin(page, account.email, account.password);
  await expect(page).toHaveURL(/\/account\/cancel-support-link$/);
  await expect(page.getByText('No support link is waiting', { exact: true })).toBeVisible();
});

test('AUTH-009 ?next= is not an open redirect', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth009', 'Nia Next');
  const origin = new URL(baseURL!).origin;
  const nexts = ['https%3A%2F%2Fevil.example', '%2Fsettings', '%2F%2Fevil.example'];
  for (const [i, next] of nexts.entries()) {
    await page.goto(`/login?next=${next}`);
    await submitLogin(page, account.email, account.password);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/projects`);
    expect(new URL(page.url()).origin).toBe(origin);
    if (i < nexts.length - 1) await signOutFromMenu(page, account.name);
  }
});

// ---- Login page and form

test('AUTH-016 a password sign-in on an account with no second factor', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth016');
  const since = await dbNow();
  await page.goto('/login');
  const release = await holdRequests(page, '/api/auth/login');
  await submitLogin(page, account.email, account.password);

  const waiting = page.getByRole('button', { name: 'Signing in...' });
  await expect(waiting).toBeVisible();
  await expect(waiting).toBeDisabled();
  const answered = page.waitForResponse(isApi('/api/auth/login'));
  release();
  const response = await answered;

  expect(response.status()).toBe(200);
  const text = await response.text();
  const body = JSON.parse(text) as { data: { user: { id: string }; tokens: { accessToken: string } } };
  expect(body.data.user.id).toBe(account.userId);
  expect(typeof body.data.tokens.accessToken).toBe('string');
  expect(text).not.toContain('refreshToken');
  const setCookie = (await response.headerValue('set-cookie')) ?? '';
  expect(setCookie).toMatch(/^chumbaq_refresh=[^;]+;/);
  expect(setCookie).toContain('Path=/api/auth');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  const cookie = await refreshCookie(page);
  expect(cookie).toMatchObject({ name: 'chumbaq_refresh', path: '/api/auth', httpOnly: true, sameSite: 'Strict' });

  const sessions = await sessionsSince(account.userId, since);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].amr).toEqual(['pwd']);
  expect(sessions[0].authenticated_at).not.toBeNull();
  const events = await authEventsFor(account.email, since);
  expect(events.map((e) => e.type)).toContain('login.succeeded');

  const stored = await page.evaluate(() => ({
    signedIn: localStorage.getItem('chumbaq_signed_in'),
    limit: localStorage.getItem('chumbaq_session_limit'),
    all: [...Object.values(localStorage), ...Object.values(sessionStorage)],
  }));
  expect(stored.signedIn).toBe('1');
  const limit = JSON.parse(stored.limit ?? 'null') as { endsAt: number; maxAgeSeconds: number };
  expect(limit.maxAgeSeconds).toBe(2_592_000);
  expect(Math.abs(limit.endsAt - (Date.now() + 2_592_000_000))).toBeLessThan(5 * 60_000);
  for (const value of stored.all) expect(value).not.toContain(body.data.tokens.accessToken);
});

test('AUTH-019 a wrong password shows the generic message and stays on the form', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth019');
  const since = await dbNow();
  await page.goto('/login');
  const refreshes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/refresh') refreshes.push(request.url());
  });
  const answered = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, 'not-the-password-1');
  expect((await answered).status()).toBe(401);

  await expect(formMessage(page, INVALID)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  expect(await refreshCookie(page)).toBeUndefined();
  const events = await authEventsFor(account.email, since);
  expect(events).toContainEqual(expect.objectContaining({ type: 'login.failed', reason: 'wrong_password' }));
  await page.waitForTimeout(1000);
  expect(refreshes).toEqual([]);
});

test('AUTH-020 an unknown address gets the same answer as a wrong password', async ({ page, clientIp }, testInfo) => {
  const account = await createAccount(clientIp, 'auth020');
  const nobody = uniqueEmail('nobody');
  const since = await dbNow();

  await page.goto('/login');
  const answered = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, nobody, 'any-password-1');
  expect((await answered).status()).toBe(401);
  await expect(formMessage(page, INVALID)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  const wrong = await passwordStep(account, newClientIp(), 'not-the-password-1');
  const unknown = await post('/api/auth/login', { email: nobody, password: 'not-the-password-1' }, { ip: newClientIp() });
  expect(wrong.status).toBe(401);
  expect(unknown.status).toBe(401);
  expect(withoutTimestamp(unknown.text)).toEqual(withoutTimestamp(wrong.text));
  const events = await authEventsFor(nobody, since);
  expect(events).toContainEqual(expect.objectContaining({ type: 'login.failed', reason: 'unknown_email', user_id: null }));

  // Timing is informational only: a dummy hash comparison runs for unknown addresses.
  const time = async (email: string) => {
    const started = performance.now();
    await post('/api/auth/login', { email, password: 'not-the-password-1' }, { ip: newClientIp() });
    return performance.now() - started;
  };
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const real: number[] = [];
  const fake: number[] = [];
  for (let i = 0; i < 5; i++) {
    real.push(await time(account.email));
    fake.push(await time(nobody));
  }
  testInfo.annotations.push({
    type: 'timing',
    description: `median wrong password ${median(real).toFixed(0)} ms, unknown address ${median(fake).toFixed(0)} ms`,
  });
});

test('AUTH-027 a suspended account with the right password sees "Account suspended" on the form', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth027');
  await suspendAccount(account.userId);
  const since = await dbNow();
  await page.goto('/login');
  const answered = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  expect((await answered).status()).toBe(403);

  await expect(formMessage(page, 'Account suspended')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await refreshCookie(page)).toBeUndefined();
  expect(await sessionsSince(account.userId, since)).toHaveLength(0);
  const events = await authEventsFor(account.email, since);
  expect(events).toContainEqual(expect.objectContaining({ type: 'login.failed', reason: 'suspended' }));
});

test('AUTH-028 a suspended account with a wrong password learns nothing', async ({ clientIp }) => {
  const suspended = await createAccount(clientIp, 'auth028-suspended');
  const active = await createAccount(clientIp, 'auth028-active');
  await suspendAccount(suspended.userId);

  const fromSuspended = await passwordStep(suspended, clientIp, 'not-the-password-1');
  const fromActive = await passwordStep(active, clientIp, 'not-the-password-1');
  expect(fromSuspended.status).toBe(401);
  expect(fromSuspended.body.message).toBe(INVALID);
  expect(withoutTimestamp(fromSuspended.text)).toEqual(withoutTimestamp(fromActive.text));
  expect(fromSuspended.setCookie).toBeNull();
});

test('AUTH-029 an account whose only passkeys are staff keys cannot sign in with a password alone', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth029');
  await insertStaffPasskeyRow(account.userId);
  const since = await dbNow();
  await page.goto('/login');
  const answered = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  const response = await answered;
  expect(response.status()).toBe(403);
  expect(await response.headerValue('set-cookie')).toBeNull();

  await expect(formMessage(page, STAFF_KEYS_ONLY)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await refreshCookie(page)).toBeUndefined();
  expect(await sessionsSince(account.userId, since)).toHaveLength(0);
  const events = await authEventsFor(account.email, since);
  expect(events).toContainEqual(expect.objectContaining({ type: 'login.password_accepted', reason: 'staff_keys_only' }));
});

test('AUTH-031 sign-in routes refuse a request without the client header', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth031');
  const since = await dbNow();
  const login = await post('/api/auth/login', { email: account.email, password: account.password }, { ip: clientIp, clientHeader: false });
  expect(login.status).toBe(403);
  expect(login.body.message).toBe('Missing client header');
  expect(login.setCookie).toBeNull();
  expect(await sessionsSince(account.userId, since)).toHaveLength(0);

  const others: Array<[string, unknown]> = [
    ['/api/auth/register', { email: uniqueEmail('auth031-register'), name: 'Header Less' }],
    ['/api/auth/complete-signup', { token: 'x', password: 'e2e-Password-123!' }],
    ['/api/auth/refresh', {}],
    ['/api/auth/login/passkey/verify', { handle: 'x', response: {} }],
    ['/api/auth/passkey/verify', { flowId: 'x', response: {} }],
    ['/api/auth/login/totp', { handle: 'x', code: '123456' }],
    ['/api/auth/login/recovery-code', { handle: 'x', code: 'abcd-efgh-ijkl-mnop' }],
  ];
  for (const [path, body] of others) {
    const answer = await post(path, body, { ip: newClientIp(), clientHeader: false });
    expect({ path, status: answer.status, message: answer.body?.message }).toEqual({
      path,
      status: 403,
      message: 'Missing client header',
    });
    expect(answer.setCookie).toBeNull();
  }
});

// ---- Sign-in failure limit

test('AUTH-034 ten wrong passwords from one network lock that network out for the address', async ({ page, clientIp }) => {
  test.setTimeout(5 * 60_000);
  const account = await createAccount(clientIp, 'auth034');
  const since = await dbNow();

  // The login route takes five a minute from one client, so the ten come in two batches.
  const statuses: number[] = [];
  for (let batch = 0; batch < 2; batch++) {
    if (batch > 0) await sleep(61_000);
    for (let i = 0; i < 5; i++) statuses.push((await passwordStep(account, clientIp, `wrong-password-${batch}-${i}`)).status);
  }
  expect(statuses).toEqual(Array(10).fill(401));
  await page.goto('/login');
  await sleep(61_000);

  // The eleventh, with the right password, from the same network.
  const answered = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  expect((await answered).status()).toBe(429);
  await expect(formMessage(page, LIMITED)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await sessionsSince(account.userId, since)).toHaveLength(0);
  const events = await authEventsFor(account.email, since);
  expect(events.map((e) => e.type)).toContain('login.limited');
});

test('AUTH-035 the per-network limit does not lock the owner out from another network', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth035');
  const networkA = newClientIp();
  await seedSignInFailures(account.email, networkA, 10);

  const fromA = await passwordStep(account, networkA);
  expect(fromA.status).toBe(429);
  expect(fromA.body.message).toBe(LIMITED);

  const fromB = await passwordStep(account, newClientIp());
  expect(fromB.status).toBe(200);
  expect(typeof fromB.body.tokens?.accessToken).toBe('string');
  expect(fromB.setCookie).toMatch(/^chumbaq_refresh=/);
});

// ---- Second factor at sign-in

test('AUTH-041 a correct password on a TOTP account asks for the second step', async ({ page, clientIp }) => {
  const { account } = await totpAccount(clientIp, 'auth041');
  const since = await dbNow();
  await page.goto('/login');
  const answered = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  const response = await answered;
  expect(response.status()).toBe(200);
  expect(await response.headerValue('set-cookie')).toBeNull();
  const body = (await response.json()) as { data: Record<string, unknown> };
  expect(body.data).toEqual({ requiresSecondFactor: true, handle: expect.any(String), methods: ['totp', 'recovery_code'] });

  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await expect(page.getByText('Your password was correct. This account also needs a second step.')).toBeVisible();
  const code = page.getByLabel('Code from your authenticator app');
  await expect(code).toHaveAttribute('placeholder', '123456');
  await expect(code).toHaveAttribute('inputmode', 'numeric');
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(code).toBeFocused();
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lost your device? Use a recovery code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use passkey' })).toHaveCount(0);
  expect(await refreshCookie(page)).toBeUndefined();

  const types = (await authEventsFor(account.email, since)).map((e) => e.type);
  expect(types).toContain('login.password_accepted');
  expect(types).not.toContain('login.succeeded');
});

test('AUTH-042 a correct TOTP code completes sign-in', async ({ page, clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth042');
  const since = await dbNow();
  await page.goto('/login');
  await submitLogin(page, account.email, account.password);
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(totp));
  const release = await holdRequests(page, '/api/auth/login/totp');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('button', { name: 'Checking...' })).toBeDisabled();
  const answered = page.waitForResponse(isApi('/api/auth/login/totp'));
  release();
  const response = await answered;
  expect(response.status()).toBe(200);
  expect(await response.headerValue('set-cookie')).toMatch(/^chumbaq_refresh=/);

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  const sessions = await sessionsSince(account.userId, since);
  expect(sessions.map((s) => s.amr)).toEqual([['pwd', 'totp']]);
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('login.succeeded');
  const [user] = await sql<{ at: Date | null }>('SELECT last_factor_sign_in_at AS at FROM users WHERE id = $1', [account.userId]);
  expect(user.at).not.toBeNull();
  expect(user.at!.getTime()).toBeGreaterThanOrEqual(since.getTime());
});

test('AUTH-044 a wrong TOTP code is refused and the step stays', async ({ page, clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth044');
  const since = await dbNow();
  await page.goto('/login');
  await submitLogin(page, account.email, account.password);
  const field = page.getByLabel('Code from your authenticator app');
  await field.fill(wrongTotpCode(totp.secret));
  const refused = page.waitForResponse(isApi('/api/auth/login/totp'));
  await page.getByRole('button', { name: 'Confirm' }).click();
  expect((await refused).status()).toBe(401);

  await expect(page.getByRole('alert')).toHaveText(CODE_REFUSED);
  await expect(field).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  const events = await authEventsFor(account.email, since);
  expect(events).toContainEqual(expect.objectContaining({ type: 'login.failed', reason: 'totp_failed' }));

  // The handle was not spent: a right code still signs in.
  await field.fill(await freshTotpCode(totp));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
});

test('AUTH-045 a TOTP code cannot be used twice', async ({ clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth045');
  const code = await freshTotpCode(totp);
  const first = await post('/api/auth/login/totp', { handle: await handleFor(account, clientIp), code }, { ip: clientIp });
  expect(first.status).toBe(200);

  const replay = await post('/api/auth/login/totp', { handle: await handleFor(account, clientIp), code }, { ip: clientIp });
  expect(replay.status).toBe(401);
  expect(replay.body.message).toBe(CODE_REFUSED);
  expect(replay.setCookie).toBeNull();
});

test('AUTH-047 a recovery code at sign-in', async ({ page, clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth047');
  const since = await dbNow();
  await page.goto('/login');
  await submitLogin(page, account.email, account.password);
  await page.getByRole('button', { name: 'Lost your device? Use a recovery code' }).click();

  await expect(page.getByLabel('Code from your authenticator app')).toHaveCount(0);
  const field = page.getByLabel('Recovery code');
  await expect(field).toHaveAttribute('placeholder', 'abcd-efgh-ijkl-mnop');
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
  await field.fill(totp.recoveryCodes[0]);
  await page.getByRole('button', { name: 'Use recovery code' }).click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  const [used] = await sql<{ used: number }>(
    'SELECT count(*)::int AS used FROM recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
    [account.userId],
  );
  expect(used.used).toBe(1);
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('recovery_code.used');
  const sessions = await sessionsSince(account.userId, since);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].amr).toContain('recovery_code');
});

test('AUTH-052 a handle signs in once only', async ({ clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth052');
  const handle = await handleFor(account, clientIp);
  const first = await post('/api/auth/login/totp', { handle, code: await freshTotpCode(totp) }, { ip: clientIp });
  expect(first.status).toBe(200);

  const again = await post('/api/auth/login/recovery-code', { handle, code: totp.recoveryCodes[0] }, { ip: clientIp });
  expect(again.status).toBe(401);
  expect(again.body.message).toBe(FLOW_EXPIRED);
  expect(again.setCookie).toBeNull();
});

test('AUTH-053 a password reset between the two steps voids the handle', async ({ clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth053');
  const handle = await handleFor(account, clientIp);
  const token = await seedResetToken(account.userId);
  const reset = await post('/api/auth/reset-password', { token, newPassword: 'e2e-New-Password-456!' }, { ip: clientIp });
  expect(reset.status).toBeLessThan(300);

  const second = await post('/api/auth/login/totp', { handle, code: await freshTotpCode(totp) }, { ip: clientIp });
  expect(second.status).toBe(401);
  expect(second.body.message).toBe(FLOW_EXPIRED);
  expect(second.setCookie).toBeNull();
});

test('AUTH-054 suspension between the two steps refuses the second step', async ({ clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth054');
  const handle = await handleFor(account, clientIp);
  const since = await dbNow();
  await suspendAccount(account.userId);

  const second = await post('/api/auth/login/totp', { handle, code: await freshTotpCode(totp) }, { ip: clientIp });
  expect(second.status).toBe(403);
  expect(second.body.message).toBe('Account suspended');
  expect(second.setCookie).toBeNull();
  expect(await sessionsSince(account.userId, since)).toHaveLength(0);
});

test('AUTH-055 second-factor failures are limited to ten per account, from any network', async ({ clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth055');
  const wrong = wrongTotpCode(totp.secret);
  // Ten wrong codes over three networks and three handles (each network may send five a minute).
  const answers: Array<[number, string]> = [];
  for (const tries of [4, 3, 3]) {
    const ip = newClientIp();
    const handle = await handleFor(account, ip);
    for (let i = 0; i < tries; i++) {
      const answer = await post('/api/auth/login/totp', { handle, code: wrong }, { ip });
      answers.push([answer.status, answer.body.message]);
    }
  }
  expect(answers).toEqual(Array(10).fill([401, CODE_REFUSED]));

  const ip = newClientIp();
  const right = await post('/api/auth/login/totp', { handle: await handleFor(account, ip), code: await freshTotpCode(totp) }, { ip });
  expect(right.status).toBe(429);
  expect(right.body.message).toBe(LIMITED);
  expect(right.setCookie).toBeNull();
});

test('AUTH-058 a passkey as the second factor', async ({ page, clientIp }) => {
  const { account } = await passkeyAccount(page, clientIp, 'auth058');
  const since = await dbNow();
  const loggedIn = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  const login = (await (await loggedIn).json()) as { data: { methods: string[] } };
  expect(login.data.methods).toEqual(['webauthn', 'recovery_code']);

  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await expect(page.getByLabel('Code from your authenticator app')).toHaveCount(0);
  const usePasskey = page.getByRole('button', { name: 'Use passkey' });
  await expect(usePasskey).toBeVisible();
  const release = await holdRequests(page, '/api/auth/login/passkey/verify');
  const options = page.waitForResponse(isApi('/api/auth/login/passkey/options'));
  await usePasskey.click();
  expect((await options).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Waiting for your passkey...' })).toBeDisabled();
  const verified = page.waitForResponse(isApi('/api/auth/login/passkey/verify'));
  release();
  expect((await verified).status()).toBe(200);

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  expect((await sessionsSince(account.userId, since)).map((s) => s.amr)).toEqual([['pwd', 'webauthn']]);
});

test("AUTH-061 another account's passkey is not this account's second factor", async ({ page, browser, baseURL, clientIp }) => {
  const a = await passkeyAccount(page, clientIp, 'auth061-a');
  const other = await newPersonContext(browser, baseURL);
  try {
    const pageB = await other.context.newPage();
    const b = await passkeyAccount(pageB, other.ip, 'auth061-b');
    const [credentialB] = await customerCredentialIds(b.account.userId);
    const since = await dbNow();

    const handle = await handleFor(a.account, clientIp);
    const options = await post('/api/auth/login/passkey/options', { handle }, { ip: clientIp });
    expect(options.status).toBe(200);
    const signedByB = await assertionInPage(pageB, options.body, credentialB);
    expect(signedByB.id).toBe(credentialB);
    const refused = await post('/api/auth/login/passkey/verify', { handle, response: signedByB }, { ip: clientIp });
    expect(refused.status).toBe(401);
    expect(refused.body.message).toBe(PASSKEY_REFUSED);
    expect(refused.setCookie).toBeNull();
    const events = await authEventsFor(a.account.email, since);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'login.failed', reason: 'passkey_failed', user_id: a.account.userId }),
    );

    // The handle was not spent: A's own passkey, on fresh options, still finishes it.
    const fresh = await post('/api/auth/login/passkey/options', { handle }, { ip: clientIp });
    const signedByA = await assertionInPage(page, fresh.body);
    const accepted = await post<{ user: { id: string } }>('/api/auth/login/passkey/verify', { handle, response: signedByA }, { ip: clientIp });
    expect(accepted.status).toBe(200);
    expect(accepted.body.user.id).toBe(a.account.userId);
  } finally {
    await other.context.close();
  }
});

test('AUTH-064 a super admin with a customer passkey is never offered TOTP or recovery codes here', async ({ page, browser, baseURL, clientIp }) => {
  await blockPasskeyAutofill(page);
  await addAuthenticator(page);
  const account = await createAccount(clientIp, 'auth064', 'auth064 person');
  await signIn(page, account);
  await enrolTenantPasskey(page, account);
  const totp = await enrolTotpConfirmingWithPasskey(page);
  await makeSuperAdmin(account.userId);

  const step = await passwordStep(account, newClientIp());
  expect(step.status).toBe(200);
  expect(step.body.methods).toEqual(['webauthn']);

  // The sign-in page offers only the passkey.
  const other = await newPersonContext(browser, baseURL);
  try {
    const pageB = await other.context.newPage();
    await pageB.goto('/login');
    await submitLogin(pageB, account.email, account.password);
    await expect(pageB.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
    await expect(pageB.getByRole('button', { name: 'Use passkey' })).toBeVisible();
    await expect(pageB.getByLabel('Code from your authenticator app')).toHaveCount(0);
    await expect(pageB.getByRole('button', { name: 'Lost your device? Use a recovery code' })).toHaveCount(0);
  } finally {
    await other.context.close();
  }

  // Through the API: a valid code is refused before it is checked, so it is not spent.
  const lastStep = async () =>
    (await sql<{ step: string }>('SELECT last_used_step AS step FROM totp_secrets WHERE user_id = $1', [account.userId]))[0].step;
  const before = await lastStep();
  const since = await dbNow();
  const ip = newClientIp();
  const handle = await handleFor(account, ip);
  const byCode = await post('/api/auth/login/totp', { handle, code: await freshTotpCode(totp) }, { ip });
  expect(byCode.status).toBe(401);
  expect(byCode.body.message).toBe('Use your passkey to continue.');
  expect(await lastStep()).toBe(before);
  const events = await authEventsFor(account.email, since);
  expect(events).toContainEqual(expect.objectContaining({ type: 'login.failed', reason: 'totp_not_offered' }));

  const byRecovery = await post('/api/auth/login/recovery-code', { handle, code: totp.recoveryCodes[0] }, { ip });
  expect(byRecovery.status).toBe(401);
  expect(byRecovery.body.message).toBe(CODE_REFUSED);
});

// ---- Sign in with a passkey (no password)

test('AUTH-067 passwordless passkey sign-in with the button', async ({ page, clientIp }) => {
  const { account } = await passkeyAccount(page, clientIp, 'auth067');
  const since = await dbNow();
  const release = await holdRequests(page, '/api/auth/passkey/verify');
  const options = page.waitForResponse(isApi('/api/auth/passkey/options'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  const offered = (await (await options).json()) as { data: { flowId: string; options: { userVerification: string } } };
  expect(typeof offered.data.flowId).toBe('string');
  expect(offered.data.options.userVerification).toBe('required');
  await expect(page.getByRole('button', { name: 'Waiting for your passkey...' })).toBeDisabled();
  const verified = page.waitForResponse(isApi('/api/auth/passkey/verify'));
  release();
  const response = await verified;
  expect(response.status()).toBe(200);
  expect(await response.headerValue('set-cookie')).toMatch(/^chumbaq_refresh=/);

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  expect((await sessionsSince(account.userId, since)).map((s) => s.amr)).toEqual([['webauthn', 'uv']]);
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('login.succeeded');
});

test('AUTH-070 the userHandle must match the account', async ({ page, browser, baseURL, clientIp }) => {
  const a = await passkeyAccount(page, clientIp, 'auth070-a');
  const other = await newPersonContext(browser, baseURL);
  try {
    const b = await passkeyAccount(await other.context.newPage(), other.ip, 'auth070-b');

    const flow = await post('/api/auth/passkey/options', undefined, { ip: clientIp });
    const signed = await assertionInPage(page, flow.body.options);
    expect(signed.response.userHandle).toBe(userHandleOf(a.account.userId));
    signed.response.userHandle = userHandleOf(b.account.userId);
    const refused = await post('/api/auth/passkey/verify', { flowId: flow.body.flowId, response: signed }, { ip: clientIp });
    expect(refused.status).toBe(401);
    expect(refused.body.message).toBe(PASSKEY_REFUSED);
    expect(refused.setCookie).toBeNull();

    // The same assertion, untouched, on a fresh flow signs A in.
    const again = await post('/api/auth/passkey/options', undefined, { ip: clientIp });
    const honest = await assertionInPage(page, again.body.options);
    const accepted = await post<{ user: { id: string } }>('/api/auth/passkey/verify', { flowId: again.body.flowId, response: honest }, { ip: clientIp });
    expect(accepted.status).toBe(200);
    expect(accepted.body.user.id).toBe(a.account.userId);
  } finally {
    await other.context.close();
  }
});

test('AUTH-072 passkey sign-in of a suspended account', async ({ page, clientIp }) => {
  const { account } = await passkeyAccount(page, clientIp, 'auth072');
  await suspendAccount(account.userId);
  const since = await dbNow();
  const verified = page.waitForResponse(isApi('/api/auth/passkey/verify'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  const response = await verified;
  expect(response.status()).toBe(403);
  expect(await response.headerValue('set-cookie')).toBeNull();

  await expect(formMessage(page, 'Account suspended')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await sessionsSince(account.userId, since)).toHaveLength(0);
});

test('AUTH-074 a staff-scope passkey does not sign in to the customer app', async ({ page, clientIp }) => {
  await blockPasskeyAutofill(page);
  const authenticator = await addAuthenticator(page);
  const account = await createAccount(clientIp, 'auth074', 'auth074 person');
  await makeSuperAdmin(account.userId);

  // A staff key, made in the admin app's enrolment.
  await page.goto(adminUrl('/sign-in'));
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Passkey name').fill('E2E staff key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('status')).toHaveText('Done. Sign in with your new passkey.');
  const [staffKey] = await sql<{ credential_id: string }>(
    `SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff'`,
    [account.userId],
  );
  expect(staffKey).toBeDefined();
  expect(await customerCredentialIds(account.userId)).toEqual([]);
  expect(await authenticator.credentials()).toHaveLength(1);

  const since = await dbNow();
  await page.goto('/login');
  const sent = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/auth/passkey/verify');
  const verified = page.waitForResponse(isApi('/api/auth/passkey/verify'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  expect(((await sent).postDataJSON() as { response: { id: string } }).response.id).toBe(staffKey.credential_id);
  const response = await verified;
  expect(response.status()).toBe(401);
  expect(await response.headerValue('set-cookie')).toBeNull();
  await expect(formMessage(page, PASSKEY_REFUSED)).toBeVisible();
  expect(await sessionsSince(account.userId, since)).toHaveLength(0);
});

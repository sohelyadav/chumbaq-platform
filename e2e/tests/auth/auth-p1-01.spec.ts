import type { Page, Request, Response } from '@playwright/test';
import { adminUrl, enrolAndSignInStaff } from '../../support/admin';
import { createAccount, newClientIp, uniqueEmail, type Account } from '../../support/api';
import {
  addAuthenticator,
  blockPasskeyAutofill,
  enrolTenantPasskey,
  enrolTotp,
  rejectNextCredentialPrompt,
  signInWithPasskeyAutofill,
  type TotpEnrolment,
} from '../../support/factors';
import { expect, signIn, test } from '../../support/fixtures';
import {
  assertionInPage,
  authEventsFor,
  credentialGets,
  customerCredentialIds,
  dbNow,
  enrolStaffKeyInAdminApp,
  expireChallenge,
  expireHandle,
  factorResetRows,
  forwardToApi,
  formMessage,
  freshTotpCode,
  handleFor,
  makeSuperAdmin,
  passwordStep,
  post,
  recordCredentialGets,
  secondFactorsCard,
  seedPendingFactorReset,
  seedResetToken,
  seedSignInFailures,
  sessionsSince,
  signInAttemptCounts,
  signOutFromMenu,
  sql,
  staffPost,
  startTenantPasskeysOffApi,
  submitLogin,
  withBrokenSignature,
  wrongTotpCode,
} from '../../support/areas/auth';

/**
 * Customer sign-in, P1 cases: the route guards and what sign-in goes to next, the login
 * form's own checks and notices, the failure limit, the second step, passwordless and
 * autofill passkey sign-in, and the register form and route.
 */

const CODE_REFUSED = 'That code is not right. Please try again.';
const FLOW_EXPIRED = 'Your sign-in has expired. Please start again.';
const PASSKEY_REFUSED = 'Could not verify that passkey.';
const CANCELLED = 'The passkey request was cancelled or timed out. Please try again.';
const LIMITED = 'Too many failed attempts. Try again in a few minutes.';
const INVALID = 'Invalid email or password';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isApi = (path: string) => (response: Response) => new URL(response.url()).pathname === path;
const isApiRequest = (path: string) => (request: Request) => new URL(request.url()).pathname === path;

/** Every request the page sends to `path`, as it happens. */
function recordRequests(page: Page, path: string): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path) seen.push(request);
  });
  return seen;
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
async function passkeyAccount(page: Page, ip: string, label: string): Promise<Account> {
  await blockPasskeyAutofill(page);
  await addAuthenticator(page);
  const account = await createAccount(ip, label, `${label} person`);
  await signIn(page, account);
  await enrolTenantPasskey(page, account);
  await signOutFromMenu(page, account.name);
  return account;
}

// ---- Routing, guards and redirects

test('AUTH-001 the root path sends an anonymous visitor to the login page', async ({ page, baseURL }) => {
  await page.goto('/');
  await expect(page).toHaveURL(`${baseURL}/login`);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  // Replaced, not pushed: the tab's history is the blank start page and /login only.
  expect(await page.evaluate(() => window.history.length)).toBe(2);
});

test('AUTH-002 the root path sends a signed-in user to the project selector', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth002');
  await signIn(page, account);
  await page.goto('/');
  await expect(page).toHaveURL(`${baseURL}/projects`);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
});

test('AUTH-006 public pages send a signed-in user to /projects', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth006');
  await signIn(page, account);
  for (const path of ['/login', '/register', '/forgot-password']) {
    await page.goto(path);
    await expect(page).toHaveURL(`${baseURL}/projects`);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  }
});

test('AUTH-007 pages outside both guards stay reachable while signed in', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth007');
  await signIn(page, account);

  await page.goto('/reset-password');
  await expect(page.getByText('Set a new password', { exact: true })).toBeVisible();
  await expect(page.getByText('This link is invalid or has expired. Ask for a new one.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${baseURL}/reset-password`);

  await page.goto('/complete-signup');
  await expect(page.getByText('Choose a password', { exact: true })).toBeVisible();
  await expect(
    page.getByText('This sign-up link has expired or was already used. Sign up again, or sign in.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${baseURL}/complete-signup`);

  await page.goto('/verify-email');
  await expect(page.getByText('Could not confirm your email', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${baseURL}/verify-email`);
});

test('AUTH-010 a signed-in visitor to /login?next=/account/cancel-support-link goes straight there', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth010');
  await signIn(page, account);
  await page.goto('/login?next=%2Faccount%2Fcancel-support-link');
  await expect(page).toHaveURL(`${baseURL}/account/cancel-support-link`);
  await expect(page.getByText('No support link is waiting', { exact: true })).toBeVisible();
});

test('AUTH-011 a pending invite kept in sessionStorage wins after sign-in', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth011');
  await page.goto('/login');
  await page.evaluate(() => {
    sessionStorage.setItem('chumbaq_pending_invite', 'A'.repeat(43));
    sessionStorage.setItem('chumbaq_pending_verification', 'some-verification-token');
  });
  await submitLogin(page, account.email, account.password);
  await expect(page).toHaveURL(`${baseURL}/invite`);
});

test('AUTH-013 a pending verification kept in sessionStorage sends the user to /verify-email after sign-in', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth013');
  await page.goto('/login');
  await page.evaluate(() => sessionStorage.setItem('chumbaq_pending_verification', 'some-verification-token'));
  await submitLogin(page, account.email, account.password);
  await expect(page).toHaveURL(`${baseURL}/verify-email`);
  // The page took the kept token: it offers to confirm rather than calling the link invalid.
  await expect(page.getByText('Could not confirm your email', { exact: true })).toHaveCount(0);
});

// ---- Login page and form

test('AUTH-018 client-side validation on the login form', async ({ page }) => {
  const sent = recordRequests(page, '/api/auth/login');
  await page.goto('/login');
  const email = page.getByLabel('Email');
  const password = page.getByLabel('Password', { exact: true });
  const login = page.getByRole('button', { name: 'Login', exact: true });
  const badEmail = page.getByText('Invalid email address', { exact: true });
  const noPassword = page.getByText('Password is required', { exact: true });

  await login.click();
  await expect(badEmail).toBeVisible();
  await expect(noPassword).toBeVisible();

  await email.fill('not-an-email');
  await expect(badEmail).toBeVisible();
  await login.click();
  expect(await email.evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(true);
  await expect(noPassword).toBeVisible();
  await expect(badEmail).toBeVisible();
  expect(sent).toHaveLength(0);

  await email.fill(uniqueEmail('auth018'));
  await password.fill('any-password-1');
  const request = page.waitForRequest(isApiRequest('/api/auth/login'));
  await login.click();
  await request;
  await expect(badEmail).toHaveCount(0);
  await expect(noPassword).toHaveCount(0);
  expect(sent).toHaveLength(1);
});

test('AUTH-021 the email is matched case-insensitively and trimmed', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth021', 'Ana Case');

  await page.goto('/login');
  await submitLogin(page, account.email.toUpperCase(), account.password);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await signOutFromMenu(page, account.name);

  const email = page.getByLabel('Email');
  await email.fill(`  ${account.email}  `);
  await expect(email).toHaveValue(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  const sent = page.waitForRequest(isApiRequest('/api/auth/login'));
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  expect(((await sent).postDataJSON() as { email: string }).email).toBe(account.email);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

  const spaced = await post<{ user: { id: string } }>(
    '/api/auth/login',
    { email: `  ${account.email.toUpperCase()}  `, password: account.password },
    { ip: newClientIp() },
  );
  expect(spaced.status).toBe(200);
  expect(spaced.body.user.id).toBe(account.userId);
});

test('AUTH-024 the suspended-account notice on /login?suspended=1', async ({ page }) => {
  const notice =
    'This account has been suspended, so you have been signed out. Contact support if you think this is a mistake.';
  await page.goto('/login?suspended=1');
  await expect(page.getByRole('alert').filter({ hasText: 'This account has been suspended' })).toHaveText(notice);

  for (const path of ['/login', '/login?suspended=0']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
    await expect(page.getByText(notice)).toHaveCount(0);
  }
});

test('AUTH-026 the session-limit notice shows only a well-formed label', async ({ page }) => {
  const labelled = (label: string) =>
    `You were signed out because your session reached its ${label} limit. Sign in again to continue.`;
  const generic = 'You were signed out because your session reached its limit. Sign in again to continue.';
  const cases: Array<[string, string]> = [
    ['30-day', labelled('30-day')],
    ['12-hour', labelled('12-hour')],
    ['45-minute', labelled('45-minute')],
    ['1', generic],
    ['0-day', generic],
    ['99999-day', generic],
    [encodeURIComponent('<b>pwned</b>'), generic],
    ['30-day%20and%20call%20+1-555', generic],
  ];
  for (const [value, expected] of cases) {
    await page.goto(`/login?sessionLimit=${value}`);
    const notice = page.getByRole('status').filter({ hasText: 'You were signed out because' });
    await expect(notice).toHaveText(expected);
    await expect(page.locator('b', { hasText: 'pwned' })).toHaveCount(0);
    await expect(page.getByText(/pwned|call|1-555/)).toHaveCount(0);
  }
});

test('AUTH-030 login API validation errors', async () => {
  const email = uniqueEmail('auth030');
  const since = await dbNow();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ email: 'x', password: 'p' }, 'Please provide a valid email address'],
    [{ email }, 'Password is required'],
    [{ email, password: '' }, 'Password is required'],
    [{ email, password: 'p', remember: true }, 'property remember should not exist'],
  ];
  for (const [body, message] of cases) {
    const answer = await post('/api/auth/login', body, { ip: newClientIp() });
    expect({ body, status: answer.status }).toEqual({ body, status: 400 });
    expect(answer.body.message).toEqual(expect.arrayContaining([message]));
    expect(answer.setCookie).toBeNull();
  }
  expect(await authEventsFor(email, since)).toEqual([]);
  expect(await signInAttemptCounts(email)).toEqual({});

  // A number is converted to a string by the validation pipe (implicit conversion), so it
  // is checked as a password: a well-formed attempt, recorded and counted.
  const ip = newClientIp();
  const numeric = await post('/api/auth/login', { email, password: 123 }, { ip });
  expect([numeric.status, numeric.body.message]).toEqual([401, INVALID]);
  expect((await authEventsFor(email, since)).map((e) => e.type)).toEqual(['login.failed']);
  expect(await signInAttemptCounts(email)).toMatchObject({ [`net:${ip}`]: '1', total: '1' });
});

test('AUTH-032 the login route takes five a minute from one client', async ({ page, clientIp }) => {
  test.setTimeout(3 * 60_000);
  const account = await createAccount(clientIp, 'auth032');
  for (let i = 0; i < 5; i++) expect((await passwordStep(account, clientIp, `wrong-password-${i}`)).status).toBe(401);

  await page.goto('/login');
  const throttled = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  expect((await throttled).status()).toBe(429);
  await expect(formMessage(page, 'ThrottlerException: Too Many Requests')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  // Another client is not affected.
  expect((await passwordStep(account, newClientIp())).status).toBe(200);

  await sleep(61_000);
  const answered = page.waitForResponse(isApi('/api/auth/login'));
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  expect((await answered).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
});

// ---- Sign-in failure limit

test('AUTH-036 a complete sign-in clears the failure window', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth036');
  const net = `net:${clientIp}`;

  await seedSignInFailures(account.email, clientIp, 8);
  expect((await passwordStep(account, clientIp, 'wrong-password-1')).status).toBe(401);
  expect((await signInAttemptCounts(account.email))[net]).toBe('9');
  expect((await passwordStep(account, clientIp)).status).toBe(200);
  expect(await signInAttemptCounts(account.email)).toEqual({});

  await seedSignInFailures(account.email, clientIp, 8);
  expect((await passwordStep(account, clientIp, 'wrong-password-2')).status).toBe(401);
  expect((await signInAttemptCounts(account.email))[net]).toBe('9');
  const third = await passwordStep(account, clientIp);
  expect(third.status).toBe(200);
  expect(typeof third.body.tokens?.accessToken).toBe('string');

  // The limit itself still holds: ten failures from this network refuse the right password.
  await seedSignInFailures(account.email, clientIp, 10);
  const limited = await passwordStep(account, clientIp);
  expect([limited.status, limited.body.message]).toEqual([429, LIMITED]);
});

test('AUTH-040 a password reset clears the address sign-in attempts', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth040');
  await seedSignInFailures(account.email, clientIp, 10);
  const limited = await passwordStep(account, clientIp);
  expect([limited.status, limited.body.message]).toEqual([429, LIMITED]);

  const newPassword = 'e2e-New-Password-456!';
  const token = await seedResetToken(account.userId);
  const reset = await post('/api/auth/reset-password', { token, newPassword }, { ip: clientIp });
  expect(reset.status).toBe(200);
  expect(await signInAttemptCounts(account.email)).toEqual({});

  const signedIn = await passwordStep(account, clientIp, newPassword);
  expect(signedIn.status).toBe(200);
  expect(typeof signedIn.body.tokens?.accessToken).toBe('string');
});

// ---- Second factor at sign-in

test('AUTH-048 a recovery code is case-, space- and hyphen-insensitive and single use', async ({ clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth048');
  const [first, second] = totp.recoveryCodes;
  expect(first).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);

  const spaced = first.toUpperCase().replace(/-/g, ' ');
  const signedIn = await post<{ user: { id: string } }>('/api/auth/login/recovery-code', { handle: await handleFor(account, clientIp), code: spaced }, { ip: clientIp });
  expect(signedIn.status).toBe(200);
  expect(signedIn.body.user.id).toBe(account.userId);

  const again = await post('/api/auth/login/recovery-code', { handle: await handleFor(account, clientIp), code: first }, { ip: clientIp });
  expect([again.status, again.body.message]).toEqual([401, CODE_REFUSED]);
  expect(again.setCookie).toBeNull();

  const bare = second.replace(/-/g, '').replace(/^(..)/, (pair) => pair.toUpperCase());
  const third = await post('/api/auth/login/recovery-code', { handle: await handleFor(account, clientIp), code: bare }, { ip: clientIp });
  expect(third.status).toBe(200);
});

test('AUTH-050 Start again returns to the password form', async ({ page, clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth050');
  await page.goto('/login');
  const firstLogin = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  const firstHandle = ((await (await firstLogin).json()) as { data: { handle: string } }).data.handle;
  await page.getByLabel('Code from your authenticator app').fill(wrongTotpCode(totp.secret));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('alert')).toHaveText(CODE_REFUSED);

  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await expect(page.getByText(CODE_REFUSED)).toHaveCount(0);
  await expect(page.getByText(INVALID)).toHaveCount(0);
  await expect(page.getByLabel('Email')).toHaveValue(account.email);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(account.password);

  const secondLogin = page.waitForResponse(isApi('/api/auth/login'));
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const second = (await (await secondLogin).json()) as { data: { handle: string } };
  expect(typeof second.data.handle).toBe('string');
  expect(second.data.handle).not.toBe(firstHandle);
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
});

test('AUTH-051 an expired handle is refused on the step, which Start again recovers', async ({ page, clientIp }) => {
  const { account, totp } = await totpAccount(clientIp, 'auth051');
  const refreshes = recordRequests(page, '/api/auth/refresh');
  await page.goto('/login');
  const login = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  const handle = ((await (await login).json()) as { data: { handle: string } }).data.handle;
  await expireHandle(handle);

  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(totp));
  const refused = page.waitForResponse(isApi('/api/auth/login/totp'));
  await page.getByRole('button', { name: 'Confirm' }).click();
  expect((await refused).status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(FLOW_EXPIRED);
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(refreshes).toHaveLength(0);

  await page.getByRole('button', { name: 'Start again' }).click();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(totp));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
});

test('AUTH-060 a cancelled passkey prompt at the second step', async ({ page, clientIp }) => {
  const account = await passkeyAccount(page, clientIp, 'auth060');
  await submitLogin(page, account.email, account.password);
  const usePasskey = page.getByRole('button', { name: 'Use passkey' });
  await expect(usePasskey).toBeVisible();

  await rejectNextCredentialPrompt(page, 'get');
  await usePasskey.click();
  await expect(page.getByRole('alert')).toHaveText(CANCELLED);
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await expect(usePasskey).toBeEnabled();

  // The handle is still good: the next prompt, answered, signs in.
  await usePasskey.click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
});

test('AUTH-063 a staff handle is not accepted on customer routes', async ({ page, clientIp }) => {
  await addAuthenticator(page);
  const staff = await createAccount(clientIp, 'auth063', 'Sam Staff');
  await makeSuperAdmin(staff.userId);
  await enrolStaffKeyInAdminApp(page, staff);

  const staffIp = newClientIp();
  const login = await staffPost('/api/staff/auth/login', { email: staff.email, password: staff.password }, staffIp);
  expect(login.status).toBe(200);
  expect(login.body).toMatchObject({ step: 'second_factor', handle: expect.any(String) });
  const handle = login.body.handle as string;

  const totp = await post('/api/auth/login/totp', { handle, code: '123456' }, { ip: clientIp });
  expect([totp.status, totp.body.message]).toEqual([401, FLOW_EXPIRED]);
  const options = await post('/api/auth/login/passkey/options', { handle }, { ip: clientIp });
  expect([options.status, options.body.message]).toEqual([401, FLOW_EXPIRED]);
  const recovery = await post('/api/auth/login/recovery-code', { handle, code: 'abcd-efgh-ijkl-mnop' }, { ip: clientIp });
  expect([recovery.status, recovery.body.message]).toEqual([401, FLOW_EXPIRED]);

  // The same handle is live on its own side.
  const staffOptions = await staffPost('/api/staff/auth/login/passkey/options', { handle }, staffIp);
  expect(staffOptions.status).toBe(200);
  expect(typeof staffOptions.body.options.challenge).toBe('string');
});

test('AUTH-066 a factor sign-in cancels a pending staff factor reset', async ({ page, clientIp }) => {
  const staffPage = await page.context().newPage();
  const staff = await createAccount(newClientIp(), 'auth066-staff', 'Sam Staff');
  await makeSuperAdmin(staff.userId);
  await enrolAndSignInStaff(staffPage, staff);

  const { account, totp } = await totpAccount(clientIp, 'auth066');
  const resetId = await seedPendingFactorReset(account.userId, staff);
  await staffPage.goto(adminUrl(`/tenants/${account.userId}`));
  const card = secondFactorsCard(staffPage);
  await expect(card).toContainText('Reset scheduled for');
  await expect(card.getByRole('button', { name: 'Cancel reset' })).toBeVisible();

  const since = await dbNow();
  await page.goto('/login');
  await submitLogin(page, account.email, account.password);
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(totp));
  const signedIn = page.waitForResponse(isApi('/api/auth/login/totp'));
  await page.getByRole('button', { name: 'Confirm' }).click();
  const response = await signedIn;
  expect(response.status()).toBe(200);
  expect(((await response.json()) as { data: { factorResetPending?: boolean } }).data.factorResetPending).toBeFalsy();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

  const rows = await factorResetRows(account.userId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: resetId, status: 'cancelled', cancelled_by: 'sign_in' });
  expect(rows[0].cancelled_at).not.toBeNull();
  const [user] = await sql<{ at: Date | null }>('SELECT last_factor_sign_in_at AS at FROM users WHERE id = $1', [account.userId]);
  expect(user.at!.getTime()).toBeGreaterThanOrEqual(since.getTime());

  await staffPage.reload();
  await expect(card.getByRole('button', { name: 'Reset second factors' })).toBeVisible();
  await expect(card).not.toContainText('Reset scheduled for');
  await expect(card.getByRole('button', { name: 'Cancel reset' })).toHaveCount(0);
});

// ---- Sign in with a passkey (no password)

test('AUTH-068 no passkey available for this site', async ({ page }) => {
  await blockPasskeyAutofill(page);
  const authenticator = await addAuthenticator(page);
  expect(await authenticator.credentials()).toHaveLength(0);
  const verifies = recordRequests(page, '/api/auth/passkey/verify');
  await page.goto('/login');
  const options = page.waitForResponse(isApi('/api/auth/passkey/options'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  expect((await options).status()).toBe(200);

  await expect(formMessage(page, CANCELLED)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
  await expect(page).toHaveURL(/\/login$/);
  expect(verifies).toHaveLength(0);
});

test('AUTH-069 a passkey whose credential was deleted is refused', async ({ page, clientIp }) => {
  const account = await passkeyAccount(page, clientIp, 'auth069');
  await sql(`DELETE FROM webauthn_credentials WHERE user_id = $1 AND scope = 'customer'`, [account.userId]);
  const since = await dbNow();

  const verified = page.waitForResponse(isApi('/api/auth/passkey/verify'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  const response = await verified;
  expect(response.status()).toBe(401);
  expect(await response.headerValue('set-cookie')).toBeNull();
  await expect(formMessage(page, PASSKEY_REFUSED)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  const failed = await sql<{ type: string }>(
    `SELECT type FROM auth_events WHERE type = 'passkey.failed' AND ip_address = $1 AND created_at >= $2`,
    [clientIp, since],
  );
  expect(failed).toHaveLength(1);
  expect(await sessionsSince(account.userId, since)).toHaveLength(0);
});

test('AUTH-071 a passwordless flow id is single use and expires', async ({ page, clientIp }) => {
  const account = await passkeyAccount(page, clientIp, 'auth071');

  const flow = await post('/api/auth/passkey/options', undefined, { ip: clientIp });
  const signed = await assertionInPage(page, flow.body.options);
  const first = await post<{ user: { id: string } }>('/api/auth/passkey/verify', { flowId: flow.body.flowId, response: signed }, { ip: clientIp });
  expect(first.status).toBe(200);
  expect(first.body.user.id).toBe(account.userId);

  const replay = await post('/api/auth/passkey/verify', { flowId: flow.body.flowId, response: signed }, { ip: clientIp });
  expect([replay.status, replay.body.message]).toEqual([401, FLOW_EXPIRED]);
  expect(replay.setCookie).toBeNull();

  const fresh = await post('/api/auth/passkey/options', undefined, { ip: clientIp });
  const signedFresh = await assertionInPage(page, fresh.body.options);
  await expireChallenge('passwordless', fresh.body.flowId);
  const expired = await post('/api/auth/passkey/verify', { flowId: fresh.body.flowId, response: signedFresh }, { ip: clientIp });
  expect([expired.status, expired.body.message]).toEqual([401, FLOW_EXPIRED]);
  expect(expired.setCookie).toBeNull();
});

test('AUTH-073 passwordless failures do not count towards the address limit', async ({ page, clientIp }) => {
  const account = await passkeyAccount(page, clientIp, 'auth073');
  const [credentialId] = await customerCredentialIds(account.userId);
  const since = await dbNow();
  const optionsIp = newClientIp();
  const countsBefore = await signInAttemptCounts(account.email);

  const first = await post('/api/auth/passkey/autofill-options', undefined, { ip: optionsIp });
  const broken = withBrokenSignature(await assertionInPage(page, first.body.options));
  expect(broken.id).toBe(credentialId);
  const answers: Array<[number, string]> = [];
  for (let i = 0; i < 10; i++) {
    const flow = i === 0 ? first : await post('/api/auth/passkey/autofill-options', undefined, { ip: optionsIp });
    const answer = await post('/api/auth/passkey/verify', { flowId: flow.body.flowId, response: broken }, { ip: clientIp });
    answers.push([answer.status, answer.body.message]);
  }
  expect(answers).toEqual(Array(10).fill([401, PASSKEY_REFUSED]));
  // They were attempts on this account's credential, recorded as such.
  const failed = (await authEventsFor(account.email, since)).filter((e) => e.type === 'passkey.failed');
  expect(failed).toHaveLength(10);
  expect(await signInAttemptCounts(account.email)).toEqual(countsBefore);

  // The password is still taken from this network: the passkey answers the second step.
  const signedIn = await passwordStep(account, clientIp);
  expect(signedIn.status).toBe(200);
  expect(signedIn.body).toMatchObject({ requiresSecondFactor: true, handle: expect.any(String) });
});

// ---- Passkey autofill on the email field

test('AUTH-077 autofill is off while tenants cannot have passkeys', async ({ page, clientIp }) => {
  test.slow(); // Starts a second customer API.
  await recordCredentialGets(page);
  await addAuthenticator(page);
  const account = await createAccount(clientIp, 'auth077', 'auth077 person');

  // With tenants' passkeys on (the stack's API), the page arms autofill.
  const armed = page.waitForResponse(isApi('/api/auth/passkey/autofill-options'));
  await page.goto('/login');
  expect(((await (await armed).json()) as { data: { available: boolean } }).data.available).toBe(true);
  await expect.poll(async () => (await credentialGets(page)).filter((c) => c.conditional).length).toBeGreaterThan(0);
  await submitLogin(page, account.email, account.password);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await enrolTenantPasskey(page, account);

  const off = await startTenantPasskeysOffApi();
  try {
    const answer = await post('/api/auth/passkey/autofill-options', undefined, { ip: newClientIp() });
    expect(answer.body.available).toBe(true);
    const response = await fetch(`${off.url}/api/auth/passkey/autofill-options`, {
      method: 'POST',
      headers: { 'X-Forwarded-For': newClientIp() },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown }).data).toEqual({ available: false });

    // The sign-in page against that API: no ceremony starts, and the button still works.
    await forwardToApi(page, off.url, '/api/auth/passkey/');
    const offered = page.waitForResponse(isApi('/api/auth/passkey/autofill-options'));
    await page.getByRole('button', { name: account.name }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    expect(((await (await offered).json()) as { data: unknown }).data).toEqual({ available: false });
    await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
    await sleep(500);
    expect(await credentialGets(page)).toEqual([]);
    await expect(page).toHaveURL(/\/login$/);

    const verified = page.waitForResponse(isApi('/api/auth/passkey/verify'));
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    expect((await verified).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  } finally {
    await off.stop();
  }
});

test('AUTH-078 autofill options when tenants may use passkeys', async ({ clientIp }) => {
  const answer = await post('/api/auth/passkey/autofill-options', undefined, { ip: clientIp });
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({ available: true, flowId: expect.any(String), options: expect.any(Object) });
  expect(answer.body.options.timeout).toBe(300_000);
  expect(answer.body.options.userVerification).toBe('required');
  expect(typeof answer.body.options.challenge).toBe('string');
});

test("AUTH-079 choosing a passkey from the email field's autofill signs in", async ({ page, clientIp }) => {
  await addAuthenticator(page);
  const account = await createAccount(clientIp, 'auth079', 'auth079 person');
  await signIn(page, account);
  await enrolTenantPasskey(page, account);
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());

  const offers: string[] = [];
  page.on('response', async (response) => {
    if (isApi('/api/auth/passkey/autofill-options')(response)) {
      offers.push(((await response.json()) as { data: { flowId: string } }).data.flowId);
    }
  });
  const sent = page.waitForRequest(isApiRequest('/api/auth/passkey/verify'));
  const since = await dbNow();
  await signInWithPasskeyAutofill(page);
  const flowId = ((await sent).postDataJSON() as { flowId: string }).flowId;
  expect(offers).toContain(flowId);
  await expect(page).toHaveURL(/\/projects$/);
  expect((await sessionsSince(account.userId, since)).map((s) => s.amr)).toEqual([['webauthn', 'uv']]);
});

test('AUTH-080 the button stops the waiting autofill request first', async ({ page, clientIp }) => {
  // The autofill request waits, as it does until someone picks from the list, and the
  // browser's one-request-at-a-time rule holds (see recordCredentialGets).
  await recordCredentialGets(page, { holdConditional: true });
  await addAuthenticator(page);
  const account = await createAccount(clientIp, 'auth080', 'auth080 person');
  await signIn(page, account);
  await enrolTenantPasskey(page, account);

  const armed = page.waitForResponse(isApi('/api/auth/passkey/autofill-options'));
  await page.getByRole('button', { name: account.name }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  const autofillFlow = ((await (await armed).json()) as { data: { flowId: string } }).data.flowId;
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await expect.poll(async () => (await credentialGets(page)).map((c) => [c.conditional, c.settled])).toEqual([[true, 'pending']]);

  const since = await dbNow();
  const options = page.waitForResponse(isApi('/api/auth/passkey/options'));
  const sent = page.waitForRequest(isApiRequest('/api/auth/passkey/verify'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  const buttonFlow = ((await (await options).json()) as { data: { flowId: string } }).data.flowId;
  expect(buttonFlow).not.toBe(autofillFlow);
  expect(((await sent).postDataJSON() as { flowId: string }).flowId).toBe(buttonFlow);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page.getByText(/already pending/i)).toHaveCount(0);

  const calls = await credentialGets(page);
  expect(calls[0]).toMatchObject({ conditional: true, aborted: true, settled: 'rejected' });
  expect(calls.slice(1).map((c) => [c.conditional, c.settled])).toEqual([[false, 'resolved']]);
  expect((await sessionsSince(account.userId, since)).map((s) => s.amr)).toEqual([['webauthn', 'uv']]);
});

// ---- Register (step one)

test('AUTH-088 register client validation', async ({ page }) => {
  const sent = recordRequests(page, '/api/auth/register');
  await page.goto('/register');
  const name = page.getByLabel('Name');
  const email = page.getByLabel('Email');
  const proceed = page.getByRole('button', { name: 'Continue' });
  const shortName = page.getByText('Name must be at least 2 characters', { exact: true });
  const badEmail = page.getByText('Invalid email address', { exact: true });

  await proceed.click();
  await expect(shortName).toBeVisible();
  await expect(badEmail).toBeVisible();

  await name.fill('A');
  await email.fill('foo@');
  await proceed.click();
  expect(await email.evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(true);
  await expect(shortName).toBeVisible();
  await expect(badEmail).toBeVisible();

  await email.fill('a@b');
  expect(await email.evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(false);
  await proceed.click();
  await expect(shortName).toBeVisible();
  await expect(badEmail).toBeVisible();
  expect(sent).toHaveLength(0);

  const address = uniqueEmail('auth088');
  await name.fill('Ana');
  await email.fill(address);
  const request = page.waitForRequest(isApiRequest('/api/auth/register'));
  await proceed.click();
  expect((await request).postDataJSON()).toEqual({ email: address, name: 'Ana' });
  await expect(page.getByText('We sent an email to')).toBeVisible();
  expect(sent).toHaveLength(1);
});

test('AUTH-089 register API validation', async () => {
  const cases: Array<[unknown, string[]]> = [
    [{ email: uniqueEmail('auth089-a'), name: '' }, ['Name is required']],
    [{ email: uniqueEmail('auth089-b'), name: 'n'.repeat(256) }, ['name must be shorter than or equal to 255 characters']],
    [{ email: 'bad', name: 'Ana' }, ['Please provide a valid email address']],
    [{ email: uniqueEmail('auth089-d'), name: 'Ana', password: 'e2e-Password-123!' }, ['property password should not exist']],
    [undefined, ['Please provide a valid email address', 'Name is required']],
  ];
  for (const [body, messages] of cases) {
    const answer = await post('/api/auth/register', body, { ip: newClientIp() });
    expect({ body, status: answer.status }).toEqual({ body, status: 400 });
    expect(answer.body.message).toEqual(expect.arrayContaining(messages));
  }

  // One character is enough for the API: the two-character rule is the form's.
  const short = await post('/api/auth/register', { email: uniqueEmail('auth089-f'), name: 'A' }, { ip: newClientIp() });
  expect([short.status, short.body]).toEqual([202, { status: 'check_email' }]);
});

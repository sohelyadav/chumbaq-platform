import { randomBytes } from 'crypto';
import type { Page, Request, Response } from '@playwright/test';
import { createAccount, createProject, newClientIp, PASSWORD, signupLinkToken, uniqueEmail } from '../../support/api';
import { enrolTotp } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  allSessions,
  auditLogsFor,
  authEventsFor,
  call,
  captureResponses,
  dbNow,
  factorResetRows,
  freshTotpCode,
  holdRequests,
  jwtClaimsOf,
  makeSignInStale,
  makeSuperAdmin,
  markUnverified,
  nextBearer,
  passwordStep,
  post,
  reauthDialog,
  refreshCookie,
  resignedAccessToken,
  seedAccountToken,
  seedPendingFactorReset,
  seedStaffLink,
  sessionsSince,
  signOutFromMenu,
  sql,
  staffLinkBanner,
  startCustomerApiWith,
  tokenRow,
  userState,
  usersWithEmail,
  verificationBanner,
  viewAsAccessTokenIn,
  viewAsInBrowser,
} from '../../support/areas/auth';

/**
 * Customer sign-in, P1 cases, part two: completing a sign-up, the session in the browser
 * (restore, renewal, two tabs, signing out), verifying an address and its banner, the
 * reset-password page and route, and the staff-issued reset link's cancel page.
 */

const SIGNUP_INVALID = 'This sign-up link has expired or was already used. Sign up again, or sign in.';
const TOO_SHORT = 'Password must be at least 8 characters';
const TOO_LONG =
  'Password is too long: use at most 72 bytes (about 72 letters or digits; some symbols and non-English letters count as more)';
const NO_MATCH = 'Passwords do not match';
const REFRESH_REFUSED = 'Invalid or expired refresh token';
const RESET_INVALID_PAGE = 'This link is invalid or has expired. Ask for a new one.';
const READ_ONLY = 'Impersonation sessions are read-only';
const REAUTH_REQUIRED = 'Confirm it is you to continue.';
const LINK_CANCELLED = 'account.password_reset_link_cancelled';
const NEW_PASSWORD = 'e2e-New-Password-456!';
const CANCEL_PAGE = '/account/cancel-support-link';

const isApi = (path: string, method = 'POST') => (response: Response) =>
  new URL(response.url()).pathname === path && response.request().method() === method;

/** A card title on the account pages (a styled div, not a heading). */
const title = (page: Page, text: string) => page.locator('[data-slot="card-title"]', { hasText: text });

/** Every request the page sends to `path`, as it happens. */
function recordRequests(page: Page, path: string): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path) seen.push(request);
  });
  return seen;
}

/** Opens an account link in a fresh document (a fragment-only change would not reload the page). */
async function openLink(page: Page, link: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(link);
}

/** A sign-up link's token for a new address nobody has registered. */
function newSignupToken(label: string, name = 'Sign Up Person'): { email: string; name: string; token: string } {
  const email = uniqueEmail(label);
  return { email, name, token: signupLinkToken(email, name) };
}

async function fillSignupPassword(page: Page, password: string, confirm = password): Promise<void> {
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(confirm);
}

async function fillNewPassword(page: Page, password: string, confirm = password): Promise<void> {
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm new password', { exact: true }).fill(confirm);
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---- Complete sign-up (step two)

test('AUTH-096 a sign-up page with no token in the link', async ({ page }) => {
  const sent = recordRequests(page, '/api/auth/complete-signup');
  await page.goto('/complete-signup');
  await expect(title(page, 'Choose a password')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(SIGNUP_INVALID);
  await expect(page.getByRole('link', { name: 'Sign up again' })).toHaveAttribute('href', '/register');
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Sign up again' }).click();
  await expect(page).toHaveURL(/\/register$/);
  expect(sent).toHaveLength(0);
});

test('AUTH-097 a sign-up token in a query string is not read', async ({ page, clientIp }) => {
  const { email, token } = newSignupToken('auth097');
  const sent = recordRequests(page, '/api/auth/complete-signup');
  await page.goto(`/complete-signup?token=${token}`);
  await expect(page.getByRole('alert')).toHaveText(SIGNUP_INVALID);
  await expect(page.getByRole('link', { name: 'Sign up again' })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  expect(sent).toHaveLength(0);
  expect(await usersWithEmail(email)).toEqual([]);

  // The same token in the fragment is a working link: only where it was put was refused.
  await openLink(page, `/complete-signup#token=${token}`);
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const done = await post('/api/auth/complete-signup', { token, password: PASSWORD }, { ip: clientIp });
  expect(done.status).toBe(201);
});

test('AUTH-098 password validation on complete sign-up', async ({ page }) => {
  const { token } = newSignupToken('auth098-a');
  const sent = recordRequests(page, '/api/auth/complete-signup');
  await page.goto(`/complete-signup#token=${token}`);
  const create = page.getByRole('button', { name: 'Create account' });
  const tooShort = page.getByText(TOO_SHORT, { exact: true });
  const tooLong = page.getByText(TOO_LONG, { exact: true });
  const noMatch = page.getByText(NO_MATCH, { exact: true });

  await fillSignupPassword(page, 'short1');
  await create.click();
  await expect(tooShort).toBeVisible();

  await fillSignupPassword(page, 'a'.repeat(73));
  await create.click();
  await expect(tooLong).toBeVisible();
  await expect(tooShort).toHaveCount(0);

  // 37 characters, but 74 bytes in UTF-8.
  await fillSignupPassword(page, 'é'.repeat(37));
  await create.click();
  await expect(tooLong).toBeVisible();

  await fillSignupPassword(page, PASSWORD, `${PASSWORD}x`);
  await create.click();
  await expect(noMatch).toBeVisible();
  await expect(tooLong).toHaveCount(0);
  // The mismatch shows under "Confirm password", the second field's message.
  await expect(page.locator('.space-y-2').filter({ has: page.locator('#confirm') }).getByText(NO_MATCH)).toBeVisible();
  expect(sent).toHaveLength(0);

  // Exactly 72 bytes is accepted, on a link of its own.
  const exact = newSignupToken('auth098-b');
  const password = `${'b'.repeat(70)}1!`;
  expect(Buffer.byteLength(password)).toBe(72);
  await openLink(page, `/complete-signup#token=${exact.token}`);
  await fillSignupPassword(page, password);
  const answered = page.waitForResponse(isApi('/api/auth/complete-signup'));
  await page.getByRole('button', { name: 'Create account' }).click();
  expect((await answered).status()).toBe(201);
  await expect(page).toHaveURL(/\/projects$/);
  expect(sent).toHaveLength(1);
  expect((await passwordStep({ email: exact.email, password }, newClientIp())).status).toBe(200);
});

test('AUTH-099 complete sign-up API password rules', async ({ clientIp }) => {
  const { email, token } = newSignupToken('auth099');
  const cases: Array<[unknown, string]> = [
    ['1234567', TOO_SHORT],
    ['c'.repeat(73), TOO_LONG],
    ['é'.repeat(37), TOO_LONG],
  ];
  for (const [password, message] of cases) {
    const answer = await post('/api/auth/complete-signup', { token, password }, { ip: clientIp });
    expect({ password, status: answer.status }).toEqual({ password, status: 400 });
    expect(answer.body.message).toEqual(expect.arrayContaining([message]));
  }
  // A value that is not a string after conversion (an array) is a type error.
  const notString = await post('/api/auth/complete-signup', { token, password: ['12345678'] }, { ip: clientIp });
  expect(notString.status).toBe(400);
  expect(notString.body.message).toEqual(expect.arrayContaining(['password must be a string']));
  expect(await usersWithEmail(email)).toEqual([]);

  // None of them spent the link.
  const done = await post('/api/auth/complete-signup', { token, password: PASSWORD }, { ip: clientIp });
  expect(done.status).toBe(201);
  expect(await usersWithEmail(email)).toHaveLength(1);

  // A JSON number is not refused: the API's validation pipe converts body values to the
  // declared type (a deliberate leniency for third-party clients), so 12345678 is the
  // password "12345678".
  const numeric = newSignupToken('auth099-number');
  const asNumber = await post('/api/auth/complete-signup', { token: numeric.token, password: 12345678 }, { ip: clientIp });
  expect(asNumber.status).toBe(201);
  expect((await passwordStep({ email: numeric.email, password: '12345678' }, newClientIp())).status).toBe(200);
});

test('AUTH-102 a second sign-up link for an address that has an account meanwhile', async ({ clientIp }) => {
  const email = uniqueEmail('auth102');
  const first = signupLinkToken(email, 'First Name');
  const second = signupLinkToken(email, 'Second Name');

  const one = await post('/api/auth/complete-signup', { token: first, password: PASSWORD }, { ip: clientIp });
  expect(one.status).toBe(201);
  const two = await post('/api/auth/complete-signup', { token: second, password: NEW_PASSWORD }, { ip: clientIp });
  expect(two.status).toBe(400);
  expect(two.body.message).toBe(SIGNUP_INVALID);

  const users = await usersWithEmail(email);
  expect(users).toHaveLength(1);
  expect((await userState(users[0].id)).name).toBe('First Name');
  expect((await passwordStep({ email, password: PASSWORD }, newClientIp())).status).toBe(200);
  expect((await passwordStep({ email, password: NEW_PASSWORD }, newClientIp())).status).toBe(401);
});

test('AUTH-104 completing a sign-up while signed in as another account', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'auth104-a', 'Alma Already');
  const aProject = await createProject(a, clientIp, `AUTH-104 ${Date.now()}`);
  const aSince = await dbNow();
  await signIn(page, a);
  await expect(page.getByText(aProject.name, { exact: true })).toBeVisible();
  const [aSession] = await sessionsSince(a.userId, aSince);

  const b = newSignupToken('auth104-b', 'Bram Brandnew');
  await page.goto(`/complete-signup#token=${b.token}`);
  // Shown, not sent on to /projects: the page sits outside the signed-out-only guard.
  await expect(title(page, 'Choose a password')).toBeVisible();
  await expect(page).toHaveURL(/\/complete-signup$/);
  await fillSignupPassword(page, PASSWORD);
  const answered = page.waitForResponse(isApi('/api/auth/complete-signup'));
  await page.getByRole('button', { name: 'Create account' }).click();
  expect((await answered).status()).toBe(201);

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(page.getByText(aProject.name, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: b.name })).toBeVisible();
  await expect(page.getByRole('button', { name: a.name })).toHaveCount(0);

  const [bUser] = await usersWithEmail(b.email);
  const cookie = await refreshCookie(page);
  expect(jwtClaimsOf(cookie!.value).sub).toBe(bUser.id);
  const aRow = (await allSessions(a.userId)).find((s) => s.id === aSession.id);
  expect(aRow?.revoked_at).toBeNull();
});

test('AUTH-105 HTML in the registered name renders as text', async ({ page }) => {
  const name = '<img src=x onerror=alert(1)>';
  const { token } = newSignupToken('auth105', name);
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto(`/complete-signup#token=${token}`);
  await fillSignupPassword(page, PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  const menu = page.getByRole('button', { name });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole('menu')).toContainText(name);
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(dialogs).toEqual([]);
});

// ---- Session, refresh cookie and restore

test('AUTH-109 a missing cookie on restore signs out cleanly', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth109');
  await signIn(page, account);
  const before = await page.evaluate(() => [localStorage.getItem('chumbaq_signed_in'), localStorage.getItem('chumbaq_session_limit')]);
  expect(before[0]).toBe('1');
  expect(before[1]).not.toBeNull();

  await page.context().clearCookies();
  const refresh = page.waitForResponse(isApi('/api/auth/refresh'));
  await page.reload();
  const response = await refresh;
  expect(response.status()).toBe(401);
  expect(((await response.json()) as { message: string }).message).toBe(REFRESH_REFUSED);

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem('chumbaq_signed_in'), localStorage.getItem('chumbaq_session_limit')])).toEqual([
    null,
    null,
  ]);
  // No notice: neither the suspended, the password-changed nor the session-limit line.
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('AUTH-111 legacy token keys are removed on load', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e_planted')) return;
    sessionStorage.setItem('e2e_planted', '1');
    localStorage.setItem('chumbaq_access_token', 'e2e-legacy-access-value');
    localStorage.setItem('chumbaq_refresh_token', 'e2e-legacy-refresh-value');
  });
  const bearers: string[] = [];
  page.on('request', (request) => {
    const authorization = request.headers()['authorization'];
    if (authorization) bearers.push(authorization);
  });

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => [localStorage.getItem('chumbaq_access_token'), localStorage.getItem('chumbaq_refresh_token')]))
    .toEqual([null, null]);
  // Planted they were: the init script left its mark before the app ran.
  expect(await page.evaluate(() => sessionStorage.getItem('e2e_planted'))).toBe('1');
  expect(bearers.filter((b) => b.includes('e2e-legacy'))).toEqual([]);
});

test('AUTH-113 an expired access token is renewed silently', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth113', 'Eli Expired');
  const bearer = nextBearer(page);
  await signIn(page, account);
  const live = await bearer;
  const now = Math.floor(Date.now() / 1000);
  const expired = resignedAccessToken(live, { iat: now - 3600, exp: now - 60 });
  // The forgery is signed right: the same claims with a future expiry are taken.
  const control = resignedAccessToken(live, { exp: now + 600 });
  expect((await call('GET', '/api/auth/me', undefined, { ip: clientIp, token: control })).status).toBe(200);
  expect((await call('GET', '/api/auth/me', undefined, { ip: clientIp, token: expired })).status).toBe(401);

  // The first request that carries a bearer carries the expired one instead.
  let swapped: string | null = null;
  await page.route('**/api/**', async (route) => {
    const headers = route.request().headers();
    if (!swapped && headers['authorization']) {
      swapped = new URL(route.request().url()).pathname;
      await route.continue({ headers: { ...headers, authorization: `Bearer ${expired}` } });
      return;
    }
    await route.continue();
  });
  const answers: Array<{ path: string; status: number }> = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/')) answers.push({ path, status: response.status() });
  });

  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  expect(swapped).toBe('/api/auth/me');
  const me = answers.filter((a) => a.path === '/api/auth/me').map((a) => a.status);
  expect(me.slice(0, 2)).toEqual([401, 200]);
  // One refresh on load, one more for the refused request.
  expect(answers.filter((a) => a.path === '/api/auth/refresh').map((a) => a.status)).toEqual([200, 200]);
  await expect(page.getByRole('button', { name: account.name })).toBeVisible();
});

test('AUTH-114 simultaneous refreshes in two tabs share one rotation', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth114', 'Tab Twin');
  await signIn(page, account);
  const second = await page.context().newPage();
  await second.goto('/projects');
  await expect(second.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  const [session] = (await allSessions(account.userId)).filter((s) => !s.revoked_at).slice(-1);
  const since = await dbNow();

  // Both reloads' refreshes are held until both have been sent, so both carry the same cookie.
  let arrived = 0;
  let releaseBoth!: () => void;
  const both = new Promise<void>((resolve) => (releaseBoth = resolve));
  const cookies: string[] = [];
  await page.context().route('**/api/auth/refresh', async (route) => {
    cookies.push(route.request().headers()['cookie'] ?? '');
    if (++arrived === 2) releaseBoth();
    await both;
    await route.continue();
  });
  await Promise.all([page.reload(), second.reload()]);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await page.context().unroute('**/api/auth/refresh');
  expect(cookies).toHaveLength(2);
  expect(cookies[0]).toBe(cookies[1]);

  const events = (await authEventsFor(account.email, since)).filter((e) => e.type.startsWith('refresh.'));
  expect(events.map((e) => e.type)).toEqual(['refresh.succeeded', 'refresh.succeeded']);
  expect(events.map((e) => e.reason)).toContain('retried_within_grace');
  expect((await allSessions(account.userId)).find((s) => s.id === session.id)?.revoked_at).toBeNull();

  // Both tabs keep working afterwards, from the one cookie now in the jar.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await second.reload();
  await expect(second.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).not.toContain('refresh.reuse_detected');
});

// ---- Sign out

test('AUTH-126 the back button after logging out', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth126', 'Bo Back');
  const project = await createProject(account, clientIp, `AUTH-126 ${Date.now()}`);
  await signIn(page, account);
  await expect(page.getByText(project.name, { exact: true })).toBeVisible();
  // Logging out turns the page's own entry into /login before loading /login, so a dashboard
  // entry is two steps back: open a project first, so the one before it is the project list.
  await page.getByText(project.name, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));
  await signOutFromMenu(page, account.name);

  const dataAnswers: number[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/projects')) dataAnswers.push(response.status());
  });
  const first = await page.goBack();
  expect(first && new URL(first.url()).pathname).toBe('/login');
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();

  // Back again reaches /projects (within this document, so the app's router handles it), and
  // the guard puts /login in its place without the list being fetched.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { e2eNavigations: string[] }).e2eNavigations = seen;
    const navigation = (window as unknown as { navigation: EventTarget }).navigation;
    navigation.addEventListener('navigate', (event) => {
      const { navigationType, destination } = event as Event & { navigationType: string; destination: { url: string } };
      seen.push(`${navigationType} ${new URL(destination.url).pathname}`);
    });
  });
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  const [arrived, ...after] = await page.evaluate(() => (window as unknown as { e2eNavigations: string[] }).e2eNavigations);
  expect(arrived).toBe('traverse /projects');
  expect(after.length).toBeGreaterThan(0);
  expect(after.filter((navigation) => navigation !== 'replace /login')).toEqual([]);
  expect(dataAnswers.filter((status) => status === 200)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await expect(page.getByText(project.name, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toHaveCount(0);
});

test('AUTH-128 logging out leaves other devices signed in', async ({ page, browser, baseURL, clientIp }) => {
  const account = await createAccount(clientIp, 'auth128', 'Duo Device');
  const project = await createProject(account, clientIp, `AUTH-128 ${Date.now()}`);
  const sinceA = await dbNow();
  await signIn(page, account);
  const [aSession] = await sessionsSince(account.userId, sinceA);

  const b = await newPersonContext(browser, baseURL);
  const other = await b.context.newPage();
  const sinceB = await dbNow();
  await signIn(other, account);
  const [bSession] = await sessionsSince(account.userId, sinceB);

  await signOutFromMenu(page, account.name);
  const rows = await allSessions(account.userId);
  expect(rows.find((s) => s.id === aSession.id)?.revoked_at).not.toBeNull();
  expect(rows.find((s) => s.id === bSession.id)?.revoked_at).toBeNull();

  // B goes on: a project opens, and a reload restores its session.
  await other.getByText(project.name, { exact: true }).click();
  await expect(other).toHaveURL(new RegExp(`/projects/${project.id}`));
  const refresh = other.waitForResponse(isApi('/api/auth/refresh'));
  await other.reload();
  expect((await refresh).status()).toBe(200);
  await expect(other).toHaveURL(new RegExp(`/projects/${project.id}`));
  await b.context.close();
});

// ---- Verify email

test('AUTH-135 an invalid, expired, used or wrong-purpose verify token', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth135', 'Ivy Invalid');
  await markUnverified(account.userId);
  const expired = await seedAccountToken(account.userId, { purpose: 'verify_email', expiresIn: '-1 minute' });
  const used = await seedAccountToken(account.userId, { purpose: 'verify_email' });
  const resetToken = await seedAccountToken(account.userId);
  const spent = await post('/api/auth/verify-email', { token: used }, { ip: newClientIp(), token: account.accessToken });
  expect(spent.status).toBe(200);
  await markUnverified(account.userId);
  await signIn(page, account);

  for (const [label, token] of [
    ['random', randomToken()],
    ['expired', expired],
    ['used', used],
    ['reset_password', resetToken],
  ] as const) {
    await openLink(page, `/verify-email#token=${token}`);
    const answered = page.waitForResponse(isApi('/api/auth/verify-email'));
    await page.getByRole('button', { name: 'Confirm email address' }).click();
    expect((await answered).status(), label).toBe(400);
    await expect(title(page, 'Could not confirm your email'), label).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to your projects' })).toBeVisible();
  }
  expect((await userState(account.userId)).email_verified_at).toBeNull();
  expect((await tokenRow(resetToken)).used_at).toBeNull();
});

test('AUTH-137 a verify token from a query string is not read', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth137');
  await markUnverified(account.userId);
  const token = await seedAccountToken(account.userId, { purpose: 'verify_email' });
  await signIn(page, account);
  const sent = recordRequests(page, '/api/auth/verify-email');

  await page.goto(`/verify-email?token=${token}`);
  await expect(title(page, 'Could not confirm your email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm email address' })).toHaveCount(0);
  expect(sent).toHaveLength(0);
  expect((await tokenRow(token)).used_at).toBeNull();
  expect((await userState(account.userId)).email_verified_at).toBeNull();

  // The same token in the fragment is offered for confirmation.
  await openLink(page, `/verify-email#token=${token}`);
  await expect(page.getByRole('button', { name: 'Confirm email address' })).toBeVisible();
});

// ---- Email verification banner and resend

test('AUTH-142 the verification banner shows for an unverified account on every signed-in layout', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth142', 'Una Unverified');
  const project = await createProject(account, clientIp, `AUTH-142 ${Date.now()}`);
  await markUnverified(account.userId);
  await signIn(page, account);

  for (const path of ['/projects', `/projects/${project.id}`]) {
    if (path !== '/projects') await page.goto(path);
    const banner = verificationBanner(page);
    await expect(banner, path).toBeVisible();
    await expect(banner).toContainText(`Confirm ${account.email} so you can recover this account.`);
    await expect(banner.getByRole('button', { name: 'Resend email' })).toBeEnabled();
    await expect(banner.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  }

  // Verified, the same account sees it on neither.
  await sql('UPDATE users SET email_verified_at = now() WHERE id = $1', [account.userId]);
  for (const path of ['/projects', `/projects/${project.id}`]) {
    await page.goto(path);
    await expect(page.getByRole('button', { name: new RegExp(account.name) }).first()).toBeVisible();
    await expect(verificationBanner(page), path).toHaveCount(0);
  }
});

test.describe('with account email off', () => {
  let emailOff: { url: string; stop(): Promise<void> } | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    emailOff = await startCustomerApiWith('email-off', { PLATFORM_BREVO_API_KEY: '', PLATFORM_EMAIL_FROM: '' });
  });

  test.afterAll(async () => {
    await emailOff?.stop();
  });

  test('AUTH-143 resend when account email is not set up', async ({ page, clientIp }) => {
    const account = await createAccount(clientIp, 'auth143', 'Nell Noemail');
    await markUnverified(account.userId);
    await signIn(page, account);
    const banner = verificationBanner(page);
    await expect(banner).toBeVisible();

    // The resend goes to an API with no account email; everything else to the stack's.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const answers: Array<{ status: number; body: unknown }> = [];
    await page.route('**/api/auth/resend-verification', async (route) => {
      await held;
      const response = await route.fetch({ url: `${emailOff!.url}/api/auth/resend-verification` });
      answers.push({ status: response.status(), body: await response.json() });
      await route.fulfill({ response });
    });
    const since = await dbNow();
    await banner.getByRole('button', { name: 'Resend email' }).click();
    await expect(banner.getByRole('button', { name: 'Sending...' })).toBeDisabled();
    release();

    await expect(banner.getByRole('status')).toHaveText('The email could not be sent right now. Try again later.');
    await expect(banner.getByRole('button', { name: 'Resend email' })).toBeEnabled();
    expect(answers).toEqual([{ status: 200, body: { data: { status: 'unavailable' } } }]);
    const tokens = await sql('SELECT id FROM account_tokens WHERE user_id = $1 AND created_at >= $2', [account.userId, since]);
    expect(tokens).toEqual([]);

    // With account email set up (the stack's API), the same request issues a link.
    const sent = await post('/api/auth/resend-verification', undefined, { ip: newClientIp(), token: account.accessToken });
    expect([sent.status, sent.body]).toEqual([200, { status: 'sent' }]);
    expect(await sql('SELECT id FROM account_tokens WHERE user_id = $1 AND created_at >= $2', [account.userId, since])).toHaveLength(1);
  });
});

test('AUTH-144 resend when the address was confirmed elsewhere meanwhile', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth144', 'Ada Already');
  await markUnverified(account.userId);
  await signIn(page, account);
  const banner = verificationBanner(page);
  await expect(banner).toBeVisible();
  await sql('UPDATE users SET email_verified_at = now() WHERE id = $1', [account.userId]);

  // The user is reloaded after the answer; holding that shows the message first.
  const releaseMe = await holdRequests(page, '/api/auth/me');
  const answered = page.waitForResponse(isApi('/api/auth/resend-verification'));
  await banner.getByRole('button', { name: 'Resend email' }).click();
  const response = await answered;
  expect(((await response.json()) as { data: unknown }).data).toEqual({ status: 'already_verified' });
  await expect(banner.getByRole('status')).toHaveText('This address is already confirmed.');
  releaseMe();
  await expect(banner).toHaveCount(0);
});

test('AUTH-148 the banner is hidden and resend refused in view-as', async ({ page, browser, baseURL, clientIp }) => {
  const tenant = await createAccount(clientIp, 'auth148', 'Vic Viewed');
  await createProject(tenant, clientIp, `AUTH-148 ${Date.now()}`);
  await markUnverified(tenant.userId);
  // The tenant themself sees it.
  await signIn(page, tenant);
  await expect(verificationBanner(page)).toBeVisible();

  const staffSide = await newPersonContext(browser, baseURL);
  const viewing = await staffSide.context.newPage();
  await viewAsInBrowser(viewing, tenant.userId, staffSide.ip);
  await expect(viewing.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(verificationBanner(viewing)).toHaveCount(0);

  const viewAs = await viewAsAccessTokenIn(viewing);
  const refused = await post('/api/auth/resend-verification', undefined, { ip: newClientIp(), token: viewAs });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(READ_ONLY);
  await staffSide.context.close();
});

// ---- Reset password

test('AUTH-156 a reset while signed in on the same browser', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth156', 'Sam Samebrowser');
  await signIn(page, account);
  const token = await seedAccountToken(account.userId);

  await page.goto(`/reset-password#token=${token}`);
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(title(page, 'Set a new password')).toBeVisible();
  await fillNewPassword(page, NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set new password' }).click();

  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBeNull();
  expect((await passwordStep({ email: account.email, password: NEW_PASSWORD }, newClientIp())).status).toBe(200);
});

test('AUTH-157 the reset page without a token', async ({ page }) => {
  const statuses = recordRequests(page, '/api/auth/reset-password/status');
  await page.goto('/reset-password');
  await expect(title(page, 'Set a new password')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(RESET_INVALID_PAGE);
  await expect(page.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute('href', '/forgot-password');
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set new password' })).toHaveCount(0);
  expect(statuses).toHaveLength(0);
});

test('AUTH-159 a reset token in a query string is not read', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth159');
  const token = await seedAccountToken(account.userId);
  const statuses = recordRequests(page, '/api/auth/reset-password/status');

  await page.goto(`/reset-password?token=${token}`);
  await expect(page.getByRole('alert')).toHaveText(RESET_INVALID_PAGE);
  await expect(page.getByRole('link', { name: 'Ask for a new link' })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  expect(statuses).toHaveLength(0);
  expect((await tokenRow(token)).used_at).toBeNull();

  // In the fragment the same token opens the form.
  await openLink(page, `/reset-password#token=${token}`);
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
});

test('AUTH-160 reset password validation', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth160');
  const token = await seedAccountToken(account.userId);
  const resets = recordRequests(page, '/api/auth/reset-password');
  await page.goto(`/reset-password#token=${token}`);
  const submit = page.getByRole('button', { name: 'Set new password' });

  await fillNewPassword(page, '1234567');
  await submit.click();
  await expect(page.getByText(TOO_SHORT, { exact: true })).toBeVisible();

  await fillNewPassword(page, 'd'.repeat(73));
  await submit.click();
  await expect(page.getByText(TOO_LONG, { exact: true })).toBeVisible();

  await fillNewPassword(page, NEW_PASSWORD, `${NEW_PASSWORD}!`);
  await submit.click();
  await expect(page.getByText(NO_MATCH, { exact: true })).toBeVisible();
  expect(resets).toHaveLength(0);
  expect((await tokenRow(token)).used_at).toBeNull();

  await fillNewPassword(page, NEW_PASSWORD);
  await submit.click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
  expect(resets).toHaveLength(1);
  expect((await tokenRow(token)).used_at).not.toBeNull();
});

test('AUTH-164 an emailed reset verifies an unverified address', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth164');
  await markUnverified(account.userId);
  const token = await seedAccountToken(account.userId);
  const since = await dbNow();

  const reset = await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD }, { ip: clientIp });
  expect(reset.status).toBe(200);
  expect((await userState(account.userId)).email_verified_at).not.toBeNull();
  expect(await authEventsFor(account.email, since)).toContainEqual(
    expect.objectContaining({ type: 'email.verified', reason: 'password_reset', user_id: account.userId }),
  );
});

test('AUTH-172 the reset-link status says nothing for other tokens', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth172');
  const emailed = await seedAccountToken(account.userId);
  const expiredStaff = await seedAccountToken(account.userId, { staffIssued: true, usableIn: '-25 hours', expiresIn: '-1 hour' });
  // Past its expiry while its wait has not ended, so only the expiry can make it say nothing.
  const expiredWaiting = await seedAccountToken(account.userId, { staffIssued: true, usableIn: '2 hours', expiresIn: '-1 minute' });
  const waiting = await seedAccountToken(account.userId, { staffIssued: true, usableIn: '2 hours', expiresIn: '26 hours' });
  const path = '/api/auth/reset-password/status';

  const answers = [];
  for (const token of [randomToken(), emailed, expiredStaff, expiredWaiting]) {
    const answer = await post(path, { token }, { ip: clientIp });
    answers.push([answer.status, answer.body]);
  }
  expect(answers).toEqual(Array(4).fill([200, { usableAt: null }]));
  const empty = await post(path, {}, { ip: clientIp });
  expect(empty.status).toBe(400);
  // A waiting staff link is the one thing it names.
  const named = await post(path, { token: waiting }, { ip: clientIp });
  expect(named.status).toBe(200);
  expect(named.body.usableAt).toBe((await tokenRow(waiting)).usable_after!.toISOString());

  for (const token of [emailed, expiredStaff, expiredWaiting, waiting]) expect((await tokenRow(token)).used_at).toBeNull();

  // Six so far from this client; four more are answered, the eleventh is throttled.
  const more = [];
  for (let i = 0; i < 5; i++) more.push((await post(path, { token: randomToken() }, { ip: clientIp })).status);
  expect(more).toEqual([200, 200, 200, 200, 429]);
});

test('AUTH-173 a reset cancels a waiting staff factor reset', async ({ clientIp }) => {
  const staff = await createAccount(newClientIp(), 'auth173-staff', 'Sam Staff');
  await makeSuperAdmin(staff.userId);
  const account = await createAccount(clientIp, 'auth173', 'Flo Factor');
  await enrolTotp({ ip: clientIp }, account);
  const resetId = await seedPendingFactorReset(account.userId, staff);
  expect((await factorResetRows(account.userId)).map((r) => r.status)).toEqual(['pending']);
  const token = await seedAccountToken(account.userId);

  const reset = await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD }, { ip: clientIp });
  expect(reset.status).toBe(200);
  const rows = await factorResetRows(account.userId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: resetId, status: 'cancelled', cancelled_by: 'password_reset' });
  expect(rows[0].cancelled_at).not.toBeNull();
  const [audit] = await auditLogsFor(account.userId, 'account.factors_reset_cancelled');
  expect(audit).toMatchObject({ actor_id: null, actor_email: 'system' });
  expect(audit.metadata).toMatchObject({ resetId, cancelledBy: 'password_reset', via: 'email' });
});

test('AUTH-175 the reset token never leaves the page in a URL or Referer', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth175');
  const token = await seedAccountToken(account.userId);
  const seen: Array<{ url: string; referer: string | undefined }> = [];
  page.on('request', (request) => seen.push({ url: request.url(), referer: request.headers()['referer'] }));

  await page.goto(`/reset-password#token=${token}`);
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(seen.some((r) => new URL(r.url).pathname === '/api/auth/reset-password/status')).toBe(true);
  for (const request of seen) {
    expect(request.url, request.url).not.toContain(token);
    expect(request.referer ?? '', request.url).not.toContain(token);
  }
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'strict-origin');
});

// ---- Staff-issued reset link: banner and cancel page

test('AUTH-181 the staff link banner is not shown on the cancel page or in view-as', async ({ page, browser, baseURL, clientIp }) => {
  const owner = await createAccount(clientIp, 'auth181', 'Ora Owner');
  await signIn(page, owner);
  const token = await seedStaffLink(owner.userId);
  await page.reload();
  await expect(staffLinkBanner(page)).toBeVisible();

  await page.goto(CANCEL_PAGE);
  await expect(title(page, 'Cancel the support link')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel the link' })).toBeVisible();
  await expect(staffLinkBanner(page)).toHaveCount(0);

  const staffSide = await newPersonContext(browser, baseURL);
  const viewing = await staffSide.context.newPage();
  await viewAsInBrowser(viewing, owner.userId, staffSide.ip);
  await expect(viewing.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(staffLinkBanner(viewing)).toHaveCount(0);
  const viewAs = await viewAsAccessTokenIn(viewing);
  const me = await call('GET', '/api/auth/me', undefined, { ip: newClientIp(), token: viewAs });
  expect(me.status).toBe(200);
  expect(me.body).toMatchObject({ id: owner.userId, staffLinkPending: false, billingEnabled: false });
  const own = await call('GET', '/api/auth/me', undefined, { ip: newClientIp(), token: owner.accessToken });
  expect(own.body).toMatchObject({ staffLinkPending: true, billingEnabled: true });
  expect((await tokenRow(token)).used_at).toBeNull();
  await staffSide.context.close();
});

test('AUTH-184 the cancel page when the re-authentication dialog is cancelled', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth184', 'Cy Cancelled');
  await signIn(page, account);
  const token = await seedStaffLink(account.userId);
  await makeSignInStale(account.userId);
  await page.goto(CANCEL_PAGE);
  const cancels = await captureResponses(page, '/api/auth/staff-reset-link/cancel');

  await page.getByRole('button', { name: 'Cancel the link' }).click();
  const dialog = reauthDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByRole('alert')).toHaveText('Could not cancel it. Confirm it is you and try again, or sign in again.');
  await expect(page.getByRole('button', { name: 'Cancel the link' })).toBeEnabled();
  expect(cancels.map((c) => [c.status, c.json?.message])).toEqual([[403, REAUTH_REQUIRED]]);
  expect((await tokenRow(token)).used_at).toBeNull();
  expect(await auditLogsFor(account.userId, LINK_CANCELLED)).toEqual([]);
});

test('AUTH-185 "Not you? Sign in again" on the cancel page', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth185', 'Nia Notme');
  const since = await dbNow();
  await signIn(page, account);
  const [session] = await sessionsSince(account.userId, since);
  await seedStaffLink(account.userId);
  await page.goto(CANCEL_PAGE);
  await expect(page.getByText(`Signed in as ${account.email}.`, { exact: false })).toBeVisible();

  const loggedOut = page.waitForResponse(isApi('/api/auth/logout'));
  await page.getByRole('button', { name: 'Not you? Sign in again' }).click();
  expect((await loggedOut).status()).toBe(204);
  await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Fcancel-support-link$/);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  const [row] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [session.id]);
  expect(row.revoked_at).not.toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBeNull();
});

test('AUTH-190 re-authentication voids staff links', async ({ clientIp }) => {
  // With the password, on an account with no second factor.
  const plain = await createAccount(clientIp, 'auth190-a', 'Rae Reauth');
  const link = await seedStaffLink(plain.userId);
  expect((await tokenRow(link)).used_at).toBeNull();
  const reauth = await post('/api/auth/reauth', { password: plain.password }, { ip: clientIp, token: plain.accessToken });
  expect(reauth.status).toBe(200);
  expect((await tokenRow(link)).used_at).not.toBeNull();
  const audit = await auditLogsFor(plain.userId, LINK_CANCELLED);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor_id: null, actor_email: 'system' });
  expect(audit[0].metadata).toMatchObject({ reason: 'owner_signed_in', via: 'password' });

  // With an authenticator app code, then a recovery code.
  const withTotp = await createAccount(clientIp, 'auth190-b', 'Tad Totp');
  const totp = await enrolTotp({ ip: clientIp }, withTotp);
  const session = { ip: clientIp, token: totp.accessToken };
  const totpLink = await seedStaffLink(withTotp.userId);
  const byCode = await post('/api/auth/reauth/totp', { code: await freshTotpCode(totp) }, session);
  expect(byCode.status).toBe(200);
  expect((await tokenRow(totpLink)).used_at).not.toBeNull();

  const recoveryLink = await seedStaffLink(withTotp.userId);
  const byRecovery = await post('/api/auth/reauth/recovery-code', { code: totp.recoveryCodes[0] }, session);
  expect(byRecovery.status).toBe(200);
  expect((await tokenRow(recoveryLink)).used_at).not.toBeNull();

  const factorAudit = await auditLogsFor(withTotp.userId, LINK_CANCELLED);
  expect(factorAudit).toHaveLength(2);
  for (const row of factorAudit) expect(row.metadata).toMatchObject({ reason: 'owner_signed_in', via: 'factor' });
});

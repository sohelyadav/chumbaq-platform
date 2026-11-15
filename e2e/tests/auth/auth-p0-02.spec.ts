import type { Page, Response } from '@playwright/test';
import { createAccount, createProject, newClientIp, PASSWORD, signupLinkToken, uniqueEmail } from '../../support/api';
import { enrolTotp } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { extractLink, mailsTo, tokenFromLink, waitForMail } from '../../support/mailbox';
import { runSecrets } from '../../support/stack';
import { signSignupToken, signupKey } from '../../../apps/api/src/modules/auth/signup-token';
import {
  allSessions,
  auditLogsFor,
  authEventsFor,
  call,
  clearsRefreshCookie,
  dbNow,
  captureResponses,
  holdRequests,
  mailedSignupLink,
  markUnverified,
  nextBearer,
  passwordStep,
  post,
  refreshCookie,
  refreshTokenIn,
  refreshWith,
  seedAccountToken,
  sessionsSince,
  setFactorsResetAgo,
  sql,
  submitLogin,
  suspendAccount,
  tokenRow,
  userState,
  usersWithEmail,
  viewAsToken,
  waitForAuthEvent,
} from '../../support/areas/auth';

/**
 * Customer sign-up (both steps), the session's life in the browser (restore from the
 * refresh cookie, rotation and replay, suspension, the session limit, signing out),
 * email verification, and forgotten and reset passwords, through the customer app and
 * its API.
 */

const CHECK_EMAIL_LEAD = 'Open the link in it to choose a password and finish creating your account.';
const ALREADY_HAVE = 'If you already have an account, the email says so and links to sign in.';
const SIGNUP_INVALID = 'This sign-up link has expired or was already used. Sign up again, or sign in.';
const REFRESH_REFUSED = 'Invalid or expired refresh token';
const SESSION_LIMIT_MESSAGE = 'Session reached its maximum length';
const VERIFY_INVALID_API = 'This link is invalid or has expired.';
const VERIFY_INVALID_PAGE =
  'This link is invalid, has expired, or is for a different account from the one you are signed in to. ' +
  'If you have already confirmed your address there is nothing more to do. Otherwise, sign in and send a new link from the banner.';
const FORGOT_SENT = 'If that address has an account, a link to reset the password is on its way.';
const RESET_INVALID_PAGE = 'This link is invalid or has expired. Ask for a new one.';
const RESET_BLOCKED = "For your security, this account's password can't be reset by email right now. Contact support.";
const PASSWORD_CHANGED_NOTICE = 'Your password was changed and you were signed out everywhere. Sign in with the new password.';
const NEW_PASSWORD = 'e2e-New-Password-456!';
const JWT = /eyJ[\w-]+\./;

const isApi = (path: string, method = 'POST') => (response: Response) =>
  new URL(response.url()).pathname === path && response.request().method() === method;

/** A card title on the account pages (a styled div, not a heading). */
const title = (page: Page, text: string) => page.locator('[data-slot="card-title"]', { hasText: text });

const newPasswordField = (page: Page) => page.getByLabel('New password', { exact: true });
const confirmNewPasswordField = (page: Page) => page.getByLabel('Confirm new password', { exact: true });
const verifyBanner = (page: Page) => page.getByRole('region', { name: 'Confirm your email address' });

/** Opens an account link in a fresh document (a fragment-only change would not reload the page). */
async function openLink(page: Page, link: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(link);
}

async function fillNewPassword(page: Page, password: string): Promise<void> {
  await newPasswordField(page).fill(password);
  await confirmNewPasswordField(page).fill(password);
}

// ---- Register (step one)

test('AUTH-086 registering a new address asks to check email and makes nothing yet', async ({ page, clientIp }) => {
  const email = uniqueEmail('auth086');
  await page.goto('/register');
  await page.getByLabel('Name').fill('Rita Register');
  await page.getByLabel('Email').fill(email);
  const release = await holdRequests(page, '/api/auth/register');
  await page.getByRole('button', { name: 'Continue' }).click();
  const waiting = page.getByRole('button', { name: 'Sending...' });
  await expect(waiting).toBeVisible();
  await expect(waiting).toBeDisabled();
  const answered = page.waitForResponse(isApi('/api/auth/register'));
  release();
  const response = await answered;

  expect(response.status()).toBe(202);
  expect(((await response.json()) as { data: unknown }).data).toEqual({ status: 'check_email' });
  expect(await response.headerValue('set-cookie')).toBeNull();
  await expect(page.getByText(`We sent an email to ${email}. ${CHECK_EMAIL_LEAD}`)).toBeVisible();
  await expect(page.getByText(ALREADY_HAVE)).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveCount(0);

  expect(await usersWithEmail(email)).toEqual([]);
  expect(await refreshCookie(page)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBeNull();
  const mail = await waitForMail(email, { subjectIncludes: 'Finish creating your Chumbaq account' });
  expect(extractLink(mail, '/complete-signup')).toContain('#token=');
  // Still nothing: only the link makes the account.
  expect(await usersWithEmail(email)).toEqual([]);
});

test('AUTH-087 registering an address that already has an account answers the same', async ({ page, clientIp }) => {
  const existing = await createAccount(clientIp, 'auth087', 'Original Name');
  const before = await userState(existing.userId);
  const since = new Date();

  await page.goto('/register');
  await page.getByLabel('Name').fill('Someone Else');
  await page.getByLabel('Email').fill(existing.email);
  const answered = page.waitForResponse(isApi('/api/auth/register'));
  await page.getByRole('button', { name: 'Continue' }).click();
  const response = await answered;
  expect(response.status()).toBe(202);
  await expect(page.getByText(`We sent an email to ${existing.email}. ${CHECK_EMAIL_LEAD}`)).toBeVisible();
  await expect(page.getByText(ALREADY_HAVE)).toBeVisible();
  await expect(page.getByText(/already exists|already registered/i)).toHaveCount(0);

  const taken = await post('/api/auth/register', { email: existing.email, name: 'Someone Else' }, { ip: newClientIp() });
  const fresh = await post('/api/auth/register', { email: uniqueEmail('auth087-new'), name: 'Someone Else' }, { ip: newClientIp() });
  expect(taken.status).toBe(202);
  expect(fresh.status).toBe(202);
  expect(taken.text).toBe(fresh.text);
  expect(await response.text()).toBe(fresh.text);

  const after = await userState(existing.userId);
  expect(after.name).toBe(before.name);
  expect(after.password_hash).toBe(before.password_hash);
  expect((await passwordStep(existing, newClientIp())).status).toBe(200);
  await waitForMail(existing.email, { subjectIncludes: 'You already have a Chumbaq account', since });
  expect(await mailsTo(existing.email, { subjectIncludes: 'Finish creating your Chumbaq account', since })).toEqual([]);
});

// ---- Complete sign-up (step two)

test('AUTH-095 completing sign-up from the link makes a verified account and signs in', async ({ page, clientIp }) => {
  const { email, name, link } = await mailedSignupLink(clientIp, 'auth095', 'Cora Complete');
  const since = await dbNow();
  await page.goto(link);
  await expect(title(page, 'Choose a password')).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  const release = await holdRequests(page, '/api/auth/complete-signup');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Creating account...' })).toBeDisabled();
  const answered = page.waitForResponse(isApi('/api/auth/complete-signup'));
  release();
  const response = await answered;

  expect(response.status()).toBe(201);
  const body = (await response.json()) as { data: { user: { id: string; email: string; name: string }; tokens: Record<string, unknown> } };
  expect(body.data.user).toMatchObject({ email, name });
  expect(Object.keys(body.data.tokens)).toEqual(['accessToken']);
  expect(await response.headerValue('set-cookie')).toMatch(/^chumbaq_refresh=[^;]+;/);

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(verifyBanner(page)).toHaveCount(0);
  const user = await userState(body.data.user.id);
  expect(user).toMatchObject({ name, email });
  expect(user.email_verified_at).not.toBeNull();
  expect((await authEventsFor(email, since)).map((e) => e.type)).toContain('register.succeeded');
  const sessions = await sessionsSince(body.data.user.id, since);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].amr).toEqual(['pwd']);
});

test('AUTH-100 a forged, tampered or expired sign-up token is refused', async ({ page }) => {
  const key = signupKey(runSecrets().jwtSecret);
  const claim = (label: string) => ({ email: uniqueEmail(`auth100-${label}`), name: 'Forged Person' });
  const tampered = (() => {
    const c = claim('tampered');
    const [payload, signature] = signupLinkToken(c.email, c.name).split('.');
    const first = signature[0] === 'A' ? 'B' : 'A';
    return { c, token: `${payload}.${first}${signature.slice(1)}` };
  })();
  const resigned = (() => {
    const c = claim('resigned');
    return { c, token: signSignupToken(signupKey('a-different-secret-entirely'), c) };
  })();
  const expired = (() => {
    const c = claim('expired');
    return { c, token: signSignupToken(key, c, Date.now() - 25 * 3600_000) };
  })();
  const threeParts = (() => {
    const c = claim('three');
    return { c, token: `${signupLinkToken(c.email, c.name)}.extra` };
  })();
  const cases = [{ c: claim('abc'), token: 'abc' }, tampered, resigned, expired, threeParts];

  for (const { c, token } of cases) {
    await openLink(page, `/complete-signup#token=${token}`);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
    const answered = page.waitForResponse(isApi('/api/auth/complete-signup'));
    await page.getByRole('button', { name: 'Create account' }).click();
    const response = await answered;
    expect(response.status(), `token ${token.slice(0, 12)}`).toBe(400);
    expect(((await response.json()) as { message: string }).message).toBe(SIGNUP_INVALID);
    await expect(page.getByRole('alert')).toHaveText(SIGNUP_INVALID);
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
    await expect(page).toHaveURL(/\/complete-signup$/);
    expect(await usersWithEmail(c.email)).toEqual([]);
  }
});

test('AUTH-101 a sign-up link works once', async ({ page, clientIp }) => {
  const { email, link } = await mailedSignupLink(clientIp, 'auth101', 'Una Once');
  const first = await post('/api/auth/complete-signup', { token: tokenFromLink(link), password: PASSWORD }, { ip: clientIp });
  expect(first.status).toBe(201);
  const userId = (first.body as { user: { id: string } }).user.id;
  const hash = (await userState(userId)).password_hash;

  await page.goto(link);
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(NEW_PASSWORD);
  const answered = page.waitForResponse(isApi('/api/auth/complete-signup'));
  await page.getByRole('button', { name: 'Create account' }).click();
  expect((await answered).status()).toBe(400);
  await expect(page.getByRole('alert')).toHaveText(SIGNUP_INVALID);
  await expect(page).toHaveURL(/\/complete-signup$/);

  expect((await userState(userId)).password_hash).toBe(hash);
  expect(await usersWithEmail(email)).toHaveLength(1);
  expect((await passwordStep({ email, password: PASSWORD }, newClientIp())).status).toBe(200);
  expect((await passwordStep({ email, password: NEW_PASSWORD }, newClientIp())).status).toBe(401);
});

// ---- Session, refresh cookie and restore

test('AUTH-107 a reload keeps the session through the refresh cookie', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth107', 'Rena Reload');
  await signIn(page, account);
  const before = await refreshCookie(page);
  const [session] = (await allSessions(account.userId)).filter((s) => !s.revoked_at).slice(-1);
  const since = await dbNow();

  const refreshed = page.waitForResponse(isApi('/api/auth/refresh'));
  await page.reload();
  const response = await refreshed;
  expect(response.status()).toBe(200);
  expect(response.request().headers()['x-chumbaq-client']).toBe('web');
  expect(JSON.parse(response.request().postData() || '{}')).toEqual({});
  const body = (await response.json()) as { data: Record<string, unknown> };
  expect(Object.keys(body.data)).toEqual(['accessToken']);
  const rotated = refreshTokenIn(await response.headerValue('set-cookie'));
  expect(rotated).not.toBeNull();
  expect(rotated).not.toBe(before?.value);

  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  expect((await refreshCookie(page))?.value).toBe(rotated);
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('refresh.succeeded');
  const after = (await allSessions(account.userId)).find((s) => s.id === session.id);
  expect(after?.current_jti).not.toBe(session.current_jti);
  expect(after?.revoked_at).toBeNull();
});

test('AUTH-112 the access token is kept in memory only', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth112', 'Mona Memory');
  const bearer = nextBearer(page);
  await signIn(page, account);
  const accessToken = await bearer;

  const stored = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    cookie: document.cookie,
  }));
  for (const [key, value] of [...Object.entries(stored.local), ...Object.entries(stored.session)]) {
    expect(value, key).not.toMatch(JWT);
    expect(value, key).not.toContain(accessToken);
  }
  expect(stored.local.chumbaq_signed_in).toBe('1');
  expect(Object.keys(JSON.parse(stored.local.chumbaq_session_limit)).sort()).toEqual(['endsAt', 'maxAgeSeconds']);
  expect(stored.cookie).not.toContain('chumbaq_refresh');
  const cookie = await refreshCookie(page);
  expect(cookie?.httpOnly).toBe(true);
});

test('AUTH-115 replaying a replaced refresh token after the grace window ends the session', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth115', 'Rex Replay');
  await signIn(page, account);
  const r1 = (await refreshCookie(page))!.value;
  const refreshed = page.waitForResponse(isApi('/api/auth/refresh'));
  await page.reload();
  expect((await refreshed).status()).toBe(200);
  const r2 = (await refreshCookie(page))!.value;
  expect(r2).not.toBe(r1);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

  // The 30-second grace for a replaced token, passed without waiting for it.
  await sql(`UPDATE auth_sessions SET rotated_at = rotated_at - interval '31 seconds' WHERE user_id = $1 AND rotated_at IS NOT NULL`, [
    account.userId,
  ]);
  const since = await dbNow();
  const mailSince = new Date();

  const replay = await refreshWith(r1, newClientIp());
  expect(replay.status).toBe(401);
  expect(replay.body.message).toBe(REFRESH_REFUSED);
  expect(clearsRefreshCookie(replay.setCookie)).toBe(true);
  const events = await authEventsFor(account.email, since);
  expect(events.map((e) => e.type)).toContain('refresh.reuse_detected');
  const reused = events.find((e) => e.type === 'refresh.reuse_detected')!;
  const [session] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [reused.session_id]);
  expect(session.revoked_at).not.toBeNull();

  const current = await refreshWith(r2, newClientIp());
  expect(current.status).toBe(401);
  expect(current.body.message).toBe(REFRESH_REFUSED);
  expect(clearsRefreshCookie(current.setCookie)).toBe(true);
  await waitForMail(account.email, { subjectIncludes: 'We ended a Chumbaq session on your account', since: mailSince });

  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
});

test('AUTH-117 refresh ignores a token in the body', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth117');
  const signedIn = await passwordStep(account, clientIp);
  const token = refreshTokenIn(signedIn.setCookie);
  expect(token).not.toBeNull();

  const inBody = await refreshWith(null, newClientIp(), { refreshToken: token });
  expect(inBody.status).toBe(401);
  expect(inBody.body.message).toBe(REFRESH_REFUSED);
  expect(inBody.setCookie).toBeNull();
  // The same token as the cookie still works: the refusal spent nothing.
  expect((await refreshWith(token, newClientIp())).status).toBe(200);
});

test('AUTH-119 suspension while signed in signs the browser out', async ({ page, browser, baseURL, clientIp }) => {
  const account = await createAccount(clientIp, 'auth119', 'Sue Suspend');
  const project = await createProject(account, clientIp, `AUTH-119 ${Date.now()}`);
  await signIn(page, account);
  const other = await newPersonContext(browser, baseURL);
  const reloader = await other.context.newPage();
  await signIn(reloader, account);
  await suspendAccount(account.userId);

  // The response interceptor: an API call from the open page.
  const projectCalls = await captureResponses(page, `/api/projects/${project.id}*`);
  await page.getByText(project.name, { exact: true }).click();
  await expect(page).toHaveURL(/\/login\?suspended=1$/);
  expect(projectCalls.length).toBeGreaterThan(0);
  expect(projectCalls[0]).toMatchObject({ status: 403, json: { message: 'Account suspended' } });
  await expect(page.getByRole('alert')).toHaveText(
    'This account has been suspended, so you have been signed out. Contact support if you think this is a mistake.',
  );
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBeNull();

  // Session restore: a reload in another browser.
  const refreshed = reloader.waitForResponse(isApi('/api/auth/refresh'));
  await reloader.reload();
  const refresh = await refreshed;
  expect(refresh.status()).toBe(403);
  expect(clearsRefreshCookie(await refresh.headerValue('set-cookie'))).toBe(true);
  await expect(reloader).toHaveURL(/\/login\?suspended=1$/);
  expect(await refreshCookie(reloader)).toBeUndefined();
  expect(await reloader.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBeNull();
  await other.context.close();
});

/** Signs in, moves the session's start past the 30-day limit, and reloads. */
async function pastSessionLimit(page: Page, clientIp: string, label: string) {
  const account = await createAccount(clientIp, label, 'Lena Limit');
  const since = await dbNow();
  await signIn(page, account);
  const [session] = await sessionsSince(account.userId, since);
  await sql(`UPDATE auth_sessions SET created_at = now() - interval '31 days' WHERE id = $1`, [session.id]);
  const refreshes = await captureResponses(page, '/api/auth/refresh');
  await page.reload();
  return { account, since, session, refreshes };
}

test('AUTH-120 reaching the 30-day session limit ends the session', async ({ page, clientIp }) => {
  const { account, since, session, refreshes } = await pastSessionLimit(page, clientIp, 'auth120');
  await expect(page).toHaveURL(/\/login\?sessionLimit=/);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]).toMatchObject({ status: 401, json: { message: SESSION_LIMIT_MESSAGE } });
  expect(clearsRefreshCookie(refreshes[0].setCookie)).toBe(true);
  const [row] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [session.id]);
  expect(row.revoked_at).not.toBeNull();
  expect(await authEventsFor(account.email, since)).toContainEqual(
    expect.objectContaining({ type: 'refresh.failed', reason: 'session_expired' }),
  );
  const notes = await page.evaluate(() => [localStorage.getItem('chumbaq_signed_in'), localStorage.getItem('chumbaq_session_limit')]);
  expect(notes).toEqual([null, null]);
  expect(await refreshCookie(page)).toBeUndefined();
});

test('AUTH-120 the sign-in page names the 30-day limit', async ({ page, clientIp }) => {
  test.fail(true, 'AUTH-120');
  test.info().annotations.push({ type: 'issue', description: 'AUTH-120' });
  await pastSessionLimit(page, clientIp, 'auth120-label');
  await expect(page).toHaveURL(/\/login\?sessionLimit=30-day$/);
  await expect(page.getByRole('status')).toHaveText(
    'You were signed out because your session reached its 30-day limit. Sign in again to continue.',
  );
});

// ---- Sign out

test('AUTH-125 log out from the account menu', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth125', 'Leo Logout');
  const project = await createProject(account, clientIp, `AUTH-125 ${Date.now()}`);

  // From the project selector's menu.
  const since = await dbNow();
  const bearer = nextBearer(page);
  await signIn(page, account);
  const accessToken = await bearer;
  const [session] = await sessionsSince(account.userId, since);
  await page.getByRole('button', { name: account.name }).click();
  const loggedOut = page.waitForResponse(isApi('/api/auth/logout'));
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  const response = await loggedOut;
  expect(response.status()).toBe(204);
  expect(clearsRefreshCookie(await response.headerValue('set-cookie'))).toBe(true);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBeNull();
  expect(await refreshCookie(page)).toBeUndefined();
  const [row] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [session.id]);
  expect(row.revoked_at).not.toBeNull();
  expect(await authEventsFor(account.email, since)).toContainEqual(expect.objectContaining({ type: 'logout', session_id: session.id }));
  const replay = await call('GET', '/api/auth/me', undefined, { ip: clientIp, token: accessToken });
  expect(replay.status).toBe(401);
  expect(replay.body.message).toBe('Session has been revoked');

  // From the project sidebar's menu.
  const again = await dbNow();
  await signIn(page, account);
  await page.getByText(project.name, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));
  const [second] = await sessionsSince(account.userId, again);
  await page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: new RegExp(account.email) }).click();
  const sidebarLogout = page.waitForResponse(isApi('/api/auth/logout'));
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  expect((await sidebarLogout).status()).toBe(204);
  await expect(page).toHaveURL(/\/login$/);
  const [secondRow] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [second.id]);
  expect(secondRow.revoked_at).not.toBeNull();
});

test('AUTH-129 logout-all ends every session', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth129', 'Ada All');
  const project = await createProject(account, clientIp, `AUTH-129 ${Date.now()}`);
  await signIn(page, account);
  const ipA = newClientIp();
  const a = await passwordStep(account, ipA);
  const tokenA = (a.body as { tokens: { accessToken: string } }).tokens.accessToken;
  const versionBefore = (await userState(account.userId)).session_version;
  const since = await dbNow();

  const all = await post('/api/auth/logout-all', undefined, { ip: ipA, token: tokenA, cookie: `chumbaq_refresh=${refreshTokenIn(a.setCookie)}` });
  expect(all.status).toBe(204);
  expect(clearsRefreshCookie(all.setCookie)).toBe(true);
  expect((await userState(account.userId)).session_version).toBe(versionBefore + 1);
  const sessions = await allSessions(account.userId);
  expect(sessions.length).toBeGreaterThanOrEqual(3);
  for (const session of sessions) expect(session.revoked_at).not.toBeNull();
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('logout.all');

  // B, the open browser: its next request fails, the refresh too, and it is sent to sign in.
  const projectCalls = await captureResponses(page, `/api/projects/${project.id}*`);
  const refresh = page.waitForResponse(isApi('/api/auth/refresh'));
  await page.getByText(project.name, { exact: true }).click();
  expect((await refresh).status()).toBe(401);
  await expect(page).toHaveURL(/\/login$/);
  expect(projectCalls.length).toBeGreaterThan(0);
  expect(projectCalls[0].status).toBe(401);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
});

// ---- Verify email

test('AUTH-131 a signed-out click on a verify link waits through sign-in', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth131', 'Vera Verify');
  await markUnverified(account.userId);
  const token = await seedAccountToken(account.userId, { purpose: 'verify_email' });

  await page.goto(`/verify-email#token=${token}`);
  await expect(title(page, 'Sign in to confirm your email')).toBeVisible();
  await expect(page.getByText('This keeps anyone else from confirming an address on your behalf.')).toBeVisible();
  await expect(page.getByText('Did not create this account? Ignore the email and nothing will change.')).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('chumbaq_pending_verification'))).toBe(token);

  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await submitLogin(page, account.email, account.password);
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(title(page, 'Confirm your email')).toBeVisible();
  await expect(page.getByText('One click to confirm this address is yours.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('chumbaq_pending_verification'))).toBeNull();

  const since = await dbNow();
  const release = await holdRequests(page, '/api/auth/verify-email');
  await page.getByRole('button', { name: 'Confirm email address' }).click();
  await expect(page.getByRole('button', { name: 'Confirming...' })).toBeDisabled();
  const answered = page.waitForResponse(isApi('/api/auth/verify-email'));
  release();
  expect((await answered).status()).toBe(200);
  await expect(title(page, 'Email confirmed')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Thanks. Your email address is confirmed.');
  await expect(page.getByRole('link', { name: 'Go to your projects' })).toBeVisible();

  expect((await userState(account.userId)).email_verified_at).not.toBeNull();
  expect((await tokenRow(token)).used_at).not.toBeNull();
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('email.verified');
});

test('AUTH-132 verifying while already signed in as the owner', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth132', 'Otto Owner');
  await markUnverified(account.userId);
  const token = await seedAccountToken(account.userId, { purpose: 'verify_email' });
  await signIn(page, account);
  await expect(verifyBanner(page)).toBeVisible();

  await page.goto(`/verify-email#token=${token}`);
  await page.getByRole('button', { name: 'Confirm email address' }).click();
  await expect(title(page, 'Email confirmed')).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email$/);
  await page.getByRole('link', { name: 'Go to your projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(verifyBanner(page)).toHaveCount(0);
  expect((await userState(account.userId)).email_verified_at).not.toBeNull();
});

test('AUTH-133 opening a verify link does not confirm on its own', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth133');
  await markUnverified(account.userId);
  const token = await seedAccountToken(account.userId, { purpose: 'verify_email' });
  await signIn(page, account);
  const verifies: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/verify-email') verifies.push(request.method());
  });

  await page.goto(`/verify-email#token=${token}`);
  await expect(page.getByRole('button', { name: 'Confirm email address' })).toBeVisible();
  // Proving that nothing is sent needs a wait with nothing to poll for: the case's 5 seconds.
  await page.waitForTimeout(5_000);
  expect(verifies).toEqual([]);
  expect((await userState(account.userId)).email_verified_at).toBeNull();
  expect((await tokenRow(token)).used_at).toBeNull();
});

test('AUTH-134 a verify link opened while signed in as a different account', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'auth134-a', 'Alma Owner');
  await markUnverified(owner.userId);
  const token = await seedAccountToken(owner.userId, { purpose: 'verify_email' });
  const other = await createAccount(clientIp, 'auth134-b', 'Bert Other');
  const otherBefore = (await userState(other.userId)).email_verified_at;
  await signIn(page, other);

  await page.goto(`/verify-email#token=${token}`);
  const answered = page.waitForResponse(isApi('/api/auth/verify-email'));
  await page.getByRole('button', { name: 'Confirm email address' }).click();
  const response = await answered;
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { message: string }).message).toBe(VERIFY_INVALID_API);
  await expect(title(page, 'Could not confirm your email')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(VERIFY_INVALID_PAGE);
  await expect(page.getByRole('link', { name: 'Go to your projects' })).toBeVisible();

  expect((await userState(owner.userId)).email_verified_at).toBeNull();
  expect((await userState(other.userId)).email_verified_at).toEqual(otherBefore);
  expect((await tokenRow(token)).used_at).toBeNull();

  // The owner can still use it.
  const ownerSession = await passwordStep(owner, newClientIp());
  const ownerToken = (ownerSession.body as { tokens: { accessToken: string } }).tokens.accessToken;
  const verified = await post('/api/auth/verify-email', { token }, { ip: newClientIp(), token: ownerToken });
  expect(verified.status).toBe(200);
  expect((await userState(owner.userId)).email_verified_at).not.toBeNull();
});

test('AUTH-139 verify needs a session, and view-as cannot verify', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'auth139', 'Tess Tenant');
  await markUnverified(tenant.userId);
  const token = await seedAccountToken(tenant.userId, { purpose: 'verify_email' });

  const anonymous = await post('/api/auth/verify-email', { token }, { ip: newClientIp() });
  expect(anonymous.status).toBe(401);

  const viewAs = await viewAsToken(page, tenant.userId, newClientIp());
  const impersonated = await post('/api/auth/verify-email', { token }, { ip: newClientIp(), token: viewAs });
  expect(impersonated.status).toBe(403);
  expect(impersonated.body.message).toBe('Impersonation sessions are read-only');

  expect((await tokenRow(token)).used_at).toBeNull();
  expect((await userState(tenant.userId)).email_verified_at).toBeNull();
});

// ---- Forgot password

test('AUTH-149 the forgot-password page and request', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth149');
  const since = await dbNow();
  const mailSince = new Date();
  await page.goto('/forgot-password');
  await expect(title(page, 'Forgot password?')).toBeVisible();
  const description = page.getByText('Enter your email and we will send you a link to reset it.');
  await expect(description).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to login' })).toBeVisible();
  await page.getByLabel('Email').fill(account.email);
  const release = await holdRequests(page, '/api/auth/forgot-password');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('button', { name: 'Sending...' })).toBeDisabled();
  const answered = page.waitForResponse(isApi('/api/auth/forgot-password'));
  release();
  const response = await answered;

  expect(response.status()).toBe(200);
  expect(((await response.json()) as { data: unknown }).data).toEqual({ message: FORGOT_SENT });
  await expect(page.getByRole('status')).toHaveText(FORGOT_SENT);
  await expect(description).toHaveCount(0);
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to login' })).toBeVisible();

  // Account email is on in this stack, so the request is sent rather than not configured.
  const event = await waitForAuthEvent(account.email, since, 'password.reset_requested');
  expect(event.reason).toBe('sent');
  const mail = await waitForMail(account.email, { subjectIncludes: 'Reset your Chumbaq password', since: mailSince });
  expect(extractLink(mail, '/reset-password')).toContain('#token=');
});

test('AUTH-150 unknown and suspended addresses get the same answer', async ({ page, clientIp }) => {
  const suspended = await createAccount(clientIp, 'auth150');
  await suspendAccount(suspended.userId);
  const unknown = uniqueEmail('auth150-nobody');
  const since = await dbNow();
  const mailSince = new Date();

  const answers: Array<{ status: number; text: string; screen: string }> = [];
  for (const email of [unknown, suspended.email]) {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    const answered = page.waitForResponse(isApi('/api/auth/forgot-password'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const response = await answered;
    await expect(page.getByRole('status')).toHaveText(FORGOT_SENT);
    answers.push({ status: response.status(), text: await response.text(), screen: await page.locator('[data-slot="card"]').innerText() });
  }
  expect(answers[0]).toEqual(answers[1]);
  expect(answers[0].status).toBe(200);

  expect((await waitForAuthEvent(unknown, since, 'password.reset_requested')).reason).toBe('unknown_email');
  expect((await waitForAuthEvent(suspended.email, since, 'password.reset_requested')).reason).toBe('suspended');
  const tokens = await sql('SELECT id FROM account_tokens WHERE user_id = $1 AND created_at >= $2', [suspended.userId, since]);
  expect(tokens).toEqual([]);
  expect(await mailsTo(unknown, { since: mailSince })).toEqual([]);
  expect(await mailsTo(suspended.email, { since: mailSince })).toEqual([]);
});

// ---- Reset password

test('AUTH-154 a reset with a valid emailed link', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth154', 'Rory Reset');
  const before = await userState(account.userId);
  const mailSince = new Date();
  expect((await post('/api/auth/forgot-password', { email: account.email }, { ip: newClientIp() })).status).toBe(200);
  const link = extractLink(await waitForMail(account.email, { subjectIncludes: 'Reset your Chumbaq password', since: mailSince }), '/reset-password');
  // Another live token of the account's, which the reset must spend too.
  const otherToken = await seedAccountToken(account.userId, { purpose: 'verify_email' });
  const since = await dbNow();

  const status = page.waitForResponse(isApi('/api/auth/reset-password/status'));
  await page.goto(link);
  await expect(title(page, 'Set a new password')).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
  const statusResponse = await status;
  expect(((await statusResponse.json()) as { data: unknown }).data).toEqual({ usableAt: null });
  await fillNewPassword(page, NEW_PASSWORD);
  let release!: () => void;
  const resets = await captureResponses(page, '/api/auth/reset-password', { holdUntil: new Promise<void>((resolve) => (release = resolve)) });
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  release();

  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
  expect(resets).toHaveLength(1);
  expect(resets[0]).toMatchObject({ status: 200, json: { data: { message: 'Password updated.' } } });
  await expect(page.getByRole('status')).toHaveText(PASSWORD_CHANGED_NOTICE);
  expect((await passwordStep(account, newClientIp())).status).toBe(401);
  expect((await passwordStep({ email: account.email, password: NEW_PASSWORD }, newClientIp())).status).toBe(200);

  const after = await userState(account.userId);
  expect(after.password_reset_at).not.toBeNull();
  expect(after.session_version).toBe(before.session_version + 1);
  const sessionsBefore = (await allSessions(account.userId)).filter((s) => s.created_at < since);
  expect(sessionsBefore.length).toBeGreaterThan(0);
  for (const session of sessionsBefore) expect(session.revoked_at).not.toBeNull();
  expect((await tokenRow(tokenFromLink(link))).used_at).not.toBeNull();
  expect((await tokenRow(otherToken)).used_at).not.toBeNull();
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('password.reset');
});

test('AUTH-155 a reset signs out every device', async ({ page, browser, baseURL, clientIp }) => {
  const account = await createAccount(clientIp, 'auth155', 'Dev Devices');
  const b = await newPersonContext(browser, baseURL);
  const other = await b.context.newPage();
  await signIn(other, account);

  const token = await seedAccountToken(account.userId);
  await page.goto(`/reset-password#token=${token}`);
  await fillNewPassword(page, NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);

  const refresh = other.waitForResponse(isApi('/api/auth/refresh'));
  await other.reload();
  expect((await refresh).status()).toBe(401);
  await expect(other).toHaveURL(/\/login$/);
  await expect(other.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await b.context.close();
});

test('AUTH-158 an invalid, used or expired reset token is refused', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth158');
  const used = await seedAccountToken(account.userId);
  const first = await post('/api/auth/reset-password', { token: used, newPassword: NEW_PASSWORD }, { ip: newClientIp() });
  expect(first.status).toBe(200);
  const expired = await seedAccountToken(account.userId, { expiresIn: '-1 minute' });
  const verifyToken = await seedAccountToken(account.userId, { purpose: 'verify_email' });
  const hash = (await userState(account.userId)).password_hash;

  const cases: Array<[string, string]> = [
    ['random', randomToken()],
    ['used', used],
    ['expired', expired],
    ['verify_email', verifyToken],
  ];
  for (const [label, token] of cases) {
    await openLink(page, `/reset-password#token=${token}`);
    await fillNewPassword(page, 'e2e-Third-Password-789!');
    const answered = page.waitForResponse(isApi('/api/auth/reset-password'));
    await page.getByRole('button', { name: 'Set new password' }).click();
    const response = await answered;
    expect(response.status(), label).toBe(400);
    expect(((await response.json()) as { message: string }).message, label).toBe(VERIFY_INVALID_API);
    await expect(page.getByRole('alert')).toHaveText(RESET_INVALID_PAGE);
    await expect(newPasswordField(page)).toBeVisible();
  }
  expect((await userState(account.userId)).password_hash).toBe(hash);
  expect((await passwordStep({ email: account.email, password: NEW_PASSWORD }, newClientIp())).status).toBe(200);
  expect((await tokenRow(verifyToken)).used_at).toBeNull();
});

test('AUTH-163 a reset of a suspended account', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth163');
  await suspendAccount(account.userId);
  const token = await seedAccountToken(account.userId);
  const before = await userState(account.userId);

  const reset = await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD }, { ip: clientIp });
  expect(reset.status).toBe(400);
  expect(reset.body.message).toBe(VERIFY_INVALID_API);
  expect((await tokenRow(token)).used_at).not.toBeNull();
  const after = await userState(account.userId);
  expect(after.password_hash).toBe(before.password_hash);
  expect(after.suspended_at).toEqual(before.suspended_at);
  expect(after.session_version).toBe(before.session_version);
});

test('AUTH-165 a reset never removes a second factor', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth165', 'Fay Factor');
  await enrolTotp({ ip: clientIp }, account);
  const factors = () =>
    Promise.all([
      sql('SELECT secret_ciphertext, confirmed_at FROM totp_secrets WHERE user_id = $1', [account.userId]),
      sql('SELECT code_hash, used_at FROM recovery_codes WHERE user_id = $1 ORDER BY code_hash', [account.userId]),
    ]);
  const before = await factors();
  expect(before[0]).toHaveLength(1);
  expect(before[1]).toHaveLength(10);
  const token = await seedAccountToken(account.userId);

  await page.goto(`/reset-password#token=${token}`);
  await fillNewPassword(page, NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
  const login = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, NEW_PASSWORD);
  const body = (await (await login).json()) as { data: Record<string, unknown> };
  expect(body.data).toMatchObject({ requiresSecondFactor: true, methods: ['totp', 'recovery_code'] });
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await expect(page.getByLabel('Code from your authenticator app')).toBeVisible();
  expect(await factors()).toEqual(before);
});

test('AUTH-166 an emailed reset is refused within 14 days of a factor reset', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth166');
  await setFactorsResetAgo(account.userId, '1 day');
  const token = await seedAccountToken(account.userId);
  const hash = (await userState(account.userId)).password_hash;
  const since = await dbNow();

  await page.goto(`/reset-password#token=${token}`);
  await fillNewPassword(page, NEW_PASSWORD);
  const answered = page.waitForResponse(isApi('/api/auth/reset-password'));
  await page.getByRole('button', { name: 'Set new password' }).click();
  const response = await answered;
  expect(response.status()).toBe(409);
  expect(((await response.json()) as { message: string }).message).toBe(RESET_BLOCKED);
  await expect(page.getByRole('alert')).toHaveText(RESET_BLOCKED);
  await expect(newPasswordField(page)).toHaveCount(0);
  // The page shows nothing more once the reset is refused this way: a new link would be refused too.
  await expect(page.getByRole('link', { name: 'Ask for a new link' })).toHaveCount(0);

  expect((await tokenRow(token)).used_at).not.toBeNull();
  const retry = await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD }, { ip: newClientIp() });
  expect(retry.status).toBe(400);
  expect(retry.body.message).toBe(VERIFY_INVALID_API);
  expect((await userState(account.userId)).password_hash).toBe(hash);
  const [audit] = await auditLogsFor(account.userId, 'account.password_reset_refused');
  expect(audit).toMatchObject({ actor_id: null, actor_email: 'system' });
  expect(audit.metadata).toMatchObject({ via: 'email' });
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('password.reset_refused');
});

test('AUTH-168 a staff-issued link still waiting shows when it becomes usable', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth168');
  const token = await seedAccountToken(account.userId, { staffIssued: true, usableIn: '2 hours', expiresIn: '26 hours' });
  const { usable_after } = await tokenRow(token);

  const status = page.waitForResponse(isApi('/api/auth/reset-password/status'));
  await page.goto(`/reset-password#token=${token}`);
  const body = (await (await status).json()) as { data: { usableAt: string } };
  expect(body.data.usableAt).toBe(usable_after!.toISOString());
  const local = await page.evaluate((iso) => new Date(iso).toLocaleString(), body.data.usableAt);
  await expect(page.getByRole('status')).toHaveText(`This link becomes usable at ${local}. Open the link again then.`);
  await expect(newPasswordField(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Ask for a new link' })).toHaveCount(0);
  expect((await tokenRow(token)).used_at).toBeNull();
});

test('AUTH-169 direct API use of a waiting staff link answers 425 and spends nothing', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth169');
  const token = await seedAccountToken(account.userId, { staffIssued: true, usableIn: '2 hours', expiresIn: '26 hours' });
  const { usable_after } = await tokenRow(token);
  const hash = (await userState(account.userId)).password_hash;

  const reset = await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD }, { ip: clientIp });
  expect(reset.status).toBe(425);
  expect(reset.body.message).toBe(`This link becomes usable at ${usable_after!.toISOString()}.`);
  expect((await tokenRow(token)).used_at).toBeNull();
  expect((await userState(account.userId)).password_hash).toBe(hash);
});

test('AUTH-171 a staff link once usable resets the password, even in the factor-reset window', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth171');
  await setFactorsResetAgo(account.userId, '1 day');
  await markUnverified(account.userId);
  const token = await seedAccountToken(account.userId, { staffIssued: true, usableIn: '-1 minute', expiresIn: '24 hours' });
  const since = await dbNow();

  await page.goto(`/reset-password#token=${token}`);
  await fillNewPassword(page, NEW_PASSWORD);
  const answered = page.waitForResponse(isApi('/api/auth/reset-password'));
  await page.getByRole('button', { name: 'Set new password' }).click();
  expect((await answered).status()).toBe(200);
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
  await expect(page.getByRole('status')).toHaveText(PASSWORD_CHANGED_NOTICE);

  expect(await authEventsFor(account.email, since)).toContainEqual(expect.objectContaining({ type: 'password.reset', reason: 'staff_link' }));
  const after = await userState(account.userId);
  expect(after.email_verified_at).toBeNull();
  expect(after.password_reset_at).not.toBeNull();
  expect((await passwordStep({ email: account.email, password: NEW_PASSWORD }, newClientIp())).status).toBe(200);
});

function randomToken(): string {
  return Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64url');
}

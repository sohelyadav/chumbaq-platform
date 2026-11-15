import { randomBytes } from 'crypto';
import type { Page, Request, Response } from '@playwright/test';
import { createAccount, createProject, newClientIp, signupLinkToken, uniqueEmail, type Account } from '../../support/api';
import { enrolAndSignInStaff } from '../../support/admin';
import { addAuthenticator, blockPasskeyAutofill, enrolTenantPasskey, enrolTotp, totpCode, type TotpEnrolment } from '../../support/factors';
import { expect, signIn, test } from '../../support/fixtures';
import { mailsTo, waitForMail } from '../../support/mailbox';
import {
  assertionInPage,
  authEventsFor,
  blockPasskeyAutofillUnlessAllowed,
  call,
  captureResponses,
  clearSignInAttempts,
  corruptTotpSecret,
  customerCredentialIds,
  customerPasskeyRows,
  dbNow,
  enrolTotpConfirmingWithPasskey,
  freshTotpCode,
  handleFor,
  insertCustomerPasskeyRow,
  insertStaffPasskeyRow,
  jwtClaimsOf,
  makeSignInStale,
  makeSuperAdmin,
  markAllRecoveryCodesUsed,
  nextBearer,
  passwordStep,
  post,
  postWithClientValue,
  reauthDialog,
  refreshCookie,
  refreshTokenIn,
  refreshWith,
  resetTotpStep,
  resignedAccessToken,
  seedStaffLink,
  seedTrapAddress,
  sessionsSince,
  setSignInAge,
  signInAttemptCounts,
  signOutFromMenu,
  sql,
  staffLinkBanner,
  submitLogin,
  suspendAccount,
  toastTitled,
  totpLastUsedStep,
  unusedRecoveryCodes,
  viewAsToken,
  waitForAuthEvent,
  wrongTotpCode,
} from '../../support/areas/auth';

/**
 * Customer sign-in, P1 cases, part three: the re-authentication dialog and its routes
 * (password, authenticator app, recovery codes, passkeys, staff-only keys), /auth/me and
 * the exact shape of sign-in answers, the session lapsing or failing in an open tab, the
 * refresh cookie and client header, the sign-in limit's networks, and ?next= after every
 * way of finishing sign-in.
 */

test.describe.configure({ mode: 'parallel' });

const REAUTH_REQUIRED = 'Confirm it is you to continue.';
const LIMITED = 'Too many failed attempts. Try again in a few minutes.';
const CODE_REFUSED = 'That code is not right. Please try again.';
const PASSKEY_REFUSED = 'Could not verify that passkey.';
const PROMPT_CANCELLED = 'The passkey request was cancelled or timed out. Please try again.';
const NOT_AVAILABLE = 'Two-factor sign-in is not available right now.';
const STAFF_KEYS_ONLY = 'Your staff passkeys work only in the admin app. Add an authenticator app there to sign in here.';
const SESSION_REVOKED = 'Session has been revoked';
const REFRESH_REFUSED = 'Invalid or expired refresh token';
const MISSING_HEADER = 'Missing client header';
const LOST_DEVICE = 'Lost your device? Use a recovery code';
const SUSPENDED_NOTICE =
  'This account has been suspended, so you have been signed out. Contact support if you think this is a mistake.';
const CANCEL_PAGE = '/account/cancel-support-link';
const NEXT_CANCEL = '/login?next=%2Faccount%2Fcancel-support-link';

/** The keys `sanitizeUser` leaves on a user row loaded from the database. */
const USER_KEYS = [
  'createdAt',
  'email',
  'emailVerifiedAt',
  'factorsResetAt',
  'id',
  'isSuperAdmin',
  'managedByTeamId',
  'name',
  'passwordResetAt',
  'projectLimit',
  'seatLimit',
  'suspendedAt',
  'suspendedReason',
  'updatedAt',
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isApi = (path: string, method = 'POST') => (response: Response) =>
  new URL(response.url()).pathname === path && response.request().method() === method;
const pathOf = (request: Request) => new URL(request.url()).pathname;

/** Marks the rest of the test as the known defect `id`: only what follows is expected to fail. */
function knownDefect(id: string): void {
  test.fail(true, id);
  test.info().annotations.push({ type: 'issue', description: id });
}

/** Every request the page sends to `path`, as it happens. */
function recordRequests(page: Page, path: string): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (pathOf(request) === path) seen.push(request);
  });
  return seen;
}

/** Waits, if needed, until at least `ms` of the current 30-second TOTP step are left. */
async function roomInStep(ms: number): Promise<void> {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < ms) await sleep(left + 300);
}

const bannerCancel = (page: Page) => staffLinkBanner(page).getByRole('button', { name: 'Cancel', exact: true });

/** Seeds a live staff link (a sign-in would void it), optionally makes the sign-in stale, reloads. */
async function withStaffLink(page: Page, account: Pick<Account, 'userId'>, { stale = false } = {}): Promise<void> {
  await seedStaffLink(account.userId);
  if (stale) await makeSignInStale(account.userId);
  await page.reload();
  await expect(staffLinkBanner(page)).toBeVisible();
}

/**
 * A tenant with an authenticator app (enrolled through the API), signed in to this page
 * with a recovery code (so no TOTP step is used up), with a live staff link and a stale
 * sign-in, on /projects with the banner showing.
 */
async function totpTenantWithStaleLink(page: Page, ip: string, label: string): Promise<{ account: Account; totp: TotpEnrolment; since: Date }> {
  const account = await createAccount(ip, label, `${label} person`);
  const totp = await enrolTotp({ ip }, account);
  const since = await dbNow();
  await page.goto('/login');
  await submitLogin(page, account.email, account.password);
  await page.getByRole('button', { name: LOST_DEVICE }).click();
  await page.getByLabel('Recovery code').fill(totp.recoveryCodes[0]);
  await page.getByRole('button', { name: 'Use recovery code' }).click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await withStaffLink(page, account, { stale: true });
  return { account, totp, since };
}

/** A tenant with a customer passkey on this tab's authenticator, signed in (session amr ['pwd']). */
async function passkeyTenant(
  page: Page,
  ip: string,
  label: string,
  { userVerification = 'verified' as 'verified' | 'unsupported', block = true } = {},
) {
  if (block) await blockPasskeyAutofill(page);
  const authenticator = await addAuthenticator(page, { userVerification });
  const account = await createAccount(ip, label, `${label} person`);
  const since = await dbNow();
  await signIn(page, account);
  const recoveryCodes = await enrolTenantPasskey(page, account);
  return { account, authenticator, recoveryCodes, since };
}

/** The bearer this page's session sends, read off its next API request after a reload. */
async function pageBearer(page: Page): Promise<string> {
  const bearer = nextBearer(page);
  await page.reload();
  return bearer;
}

// ---- Re-authentication dialog and routes

test('AUTH-194 the re-authentication dialog cancelled, by its button and by Escape', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth194', 'Can Celled');
  await signIn(page, account);
  await withStaffLink(page, account, { stale: true });
  const reauths = recordRequests(page, '/api/auth/reauth');
  const cancels = await captureResponses(page, '/api/auth/staff-reset-link/cancel');
  const dialog = reauthDialog(page);

  for (const [index, close] of (['button', 'Escape'] as const).entries()) {
    await bannerCancel(page).click();
    await expect(dialog).toBeVisible();
    if (close === 'button') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // The refused request fails with its 403, and the banner shows its own error.
    await expect(toastTitled(page, 'Could not cancel')).toHaveCount(index + 1);
    await expect(toastTitled(page, 'Link cancelled')).toHaveCount(0);
  }
  expect(cancels.map((c) => [c.status, c.json?.message])).toEqual([
    [403, REAUTH_REQUIRED],
    [403, REAUTH_REQUIRED],
  ]);
  expect(reauths).toHaveLength(0);
  // The link is still live: nothing was cancelled.
  await expect(staffLinkBanner(page)).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
});

test('AUTH-198 an account whose only passkeys are staff keys cannot re-authenticate with a password', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth198', 'Sta Ffkey');
  // Before the key: the password re-authenticates.
  const before = await post('/api/auth/reauth', { password: account.password }, { ip: newClientIp(), token: account.accessToken });
  expect(before.status).toBe(200);
  await insertStaffPasskeyRow(account.userId);
  const since = await dbNow();
  const answer = await post('/api/auth/reauth', { password: account.password }, { ip: newClientIp(), token: account.accessToken });
  expect(answer.status).toBe(403);
  expect(answer.body.message).toBe(STAFF_KEYS_ONLY);
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).not.toContain('reauth.succeeded');
});

test('AUTH-200 a wrong authenticator code in the dialog', async ({ page, clientIp }) => {
  const { account, totp } = await totpTenantWithStaleLink(page, clientIp, 'auth200');
  const since = await dbNow();
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  const field = dialog.getByLabel('Code from your authenticator app');
  const wrong = totpCode(totp.secret, 0) === '000000' ? wrongTotpCode(totp.secret) : '000000';
  await field.fill(wrong);
  const refused = page.waitForResponse(isApi('/api/auth/reauth/totp'));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  expect((await refused).status()).toBe(403);
  await expect(dialog.getByRole('alert')).toHaveText(CODE_REFUSED);
  await expect(field).toHaveValue('');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  await waitForAuthEvent(account.email, since, 'login.failed').then((event) =>
    expect(event).toMatchObject({ reason: 'reauth_totp_failed', user_id: account.userId }),
  );

  // The right code then goes through, in the same dialog.
  await field.fill(await freshTotpCode(totp));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();
});

test('AUTH-201 re-authenticating with a recovery code', async ({ page, clientIp }) => {
  const { account, totp } = await totpTenantWithStaleLink(page, clientIp, 'auth201');
  expect(await unusedRecoveryCodes(account.userId)).toBe(9);
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  await dialog.getByRole('button', { name: LOST_DEVICE }).click();
  const field = dialog.getByLabel('Recovery code');
  await expect(field).toBeVisible();
  await expect(dialog.getByLabel('Code from your authenticator app')).toHaveCount(0);

  // "Back" returns to the authenticator form, and the link comes back.
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(dialog.getByLabel('Recovery code')).toHaveCount(0);
  await dialog.getByRole('button', { name: LOST_DEVICE }).click();

  // A made-up code, then the code already used to sign in.
  for (const code of ['zzzz-zzzz-zzzz-zzzz', totp.recoveryCodes[0]]) {
    const refused = page.waitForResponse(isApi('/api/auth/reauth/recovery-code'));
    await field.fill(code);
    await dialog.getByRole('button', { name: 'Use recovery code' }).click();
    expect((await refused).status()).toBe(403);
    await expect(dialog.getByRole('alert')).toHaveText(CODE_REFUSED);
    await expect(dialog).toBeVisible();
  }
  expect(await unusedRecoveryCodes(account.userId)).toBe(9);

  const since = await dbNow();
  const accepted = page.waitForResponse(isApi('/api/auth/reauth/recovery-code'));
  await field.fill(totp.recoveryCodes[1]);
  await dialog.getByRole('button', { name: 'Use recovery code' }).click();
  expect((await accepted).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();
  expect(await unusedRecoveryCodes(account.userId)).toBe(8);
  const events = await authEventsFor(account.email, since);
  expect(events.map((e) => e.type)).toContain('recovery_code.used');
  expect(events).toContainEqual(expect.objectContaining({ type: 'reauth.succeeded', reason: 'recovery_code' }));
});

test('AUTH-204 passkey re-authentication refusals', async ({ page, clientIp }) => {
  // 1 and 2: no passkeys.
  const plain = await createAccount(clientIp, 'auth204-plain', 'No Keys');
  const options = await post('/api/auth/reauth/passkey/options', undefined, { ip: newClientIp(), token: plain.accessToken });
  expect([options.status, options.body.message]).toEqual([403, 'This session cannot confirm with a passkey.']);
  const bogus = { id: 'bogus', rawId: 'bogus', type: 'public-key', response: {}, clientExtensionResults: {} };
  const unasked = await post('/api/auth/reauth/passkey/verify', { response: bogus }, { ip: newClientIp(), token: plain.accessToken });
  expect([unasked.status, unasked.body.message]).toEqual([403, 'That took too long. Please try again.']);

  // 3: another account's real passkey, answering this account's challenge.
  const { account: holder } = await passkeyTenant(page, clientIp, 'auth204-holder');
  const [holderCredential] = await customerCredentialIds(holder.userId);
  const asker = await createAccount(clientIp, 'auth204-asker', 'Ask Er');
  await insertCustomerPasskeyRow(asker.userId);
  const since = await dbNow();
  const askerOptions = await post('/api/auth/reauth/passkey/options', undefined, { ip: newClientIp(), token: asker.accessToken });
  expect(askerOptions.status).toBe(200);
  const foreign = await assertionInPage(page, askerOptions.body, holderCredential);
  expect(foreign.id).toBe(holderCredential);
  const refused = await post('/api/auth/reauth/passkey/verify', { response: foreign }, { ip: newClientIp(), token: asker.accessToken });
  expect([refused.status, refused.body.message]).toEqual([403, PASSKEY_REFUSED]);
  expect(await authEventsFor(asker.email, since)).toContainEqual(
    expect.objectContaining({ type: 'passkey.failed', reason: 'reauth', user_id: asker.userId }),
  );

  // The same credential re-authenticates its own account.
  const holderToken = await pageBearer(page);
  const holderOptions = await post('/api/auth/reauth/passkey/options', undefined, { ip: newClientIp(), token: holderToken });
  const own = await assertionInPage(page, holderOptions.body, holderCredential);
  const accepted = await post('/api/auth/reauth/passkey/verify', { response: own }, { ip: newClientIp(), token: holderToken });
  expect(accepted.status).toBe(200);
});

test('AUTH-205 a super admin with a customer passkey cannot re-authenticate with an authenticator app', async ({ page, clientIp }) => {
  const { account } = await passkeyTenant(page, clientIp, 'auth205');
  const totp = await enrolTotpConfirmingWithPasskey(page);
  expect(totp.recoveryCodes).toHaveLength(10);
  await makeSuperAdmin(account.userId);
  const token = await pageBearer(page);
  const stepBefore = await totpLastUsedStep(account.userId);

  const withCode = await post('/api/auth/reauth/totp', { code: await freshTotpCode(totp) }, { ip: newClientIp(), token });
  expect([withCode.status, withCode.body.message]).toEqual([403, 'Use your passkey to continue.']);
  // The code was not spent.
  expect(await totpLastUsedStep(account.userId)).toBe(stepBefore);

  const withRecovery = await post('/api/auth/reauth/recovery-code', { code: totp.recoveryCodes[0] }, { ip: newClientIp(), token });
  expect([withRecovery.status, withRecovery.body.message]).toEqual([403, CODE_REFUSED]);
  expect(await unusedRecoveryCodes(account.userId)).toBe(10);
});

test('AUTH-209 re-authentication needs a live session', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth209', 'Liv Session');
  const live = await post('/api/auth/reauth', { password: account.password }, { ip: newClientIp(), token: account.accessToken });
  expect(live.status).toBe(200);
  // Signing out with the same session (its sid) revokes the row.
  const out = await post('/api/auth/logout', undefined, { ip: newClientIp(), token: account.accessToken });
  expect(out.status).toBe(204);
  const [row] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [
    String(jwtClaimsOf(account.accessToken).sid),
  ]);
  expect(row.revoked_at).not.toBeNull();
  const answer = await post('/api/auth/reauth', { password: account.password }, { ip: newClientIp(), token: account.accessToken });
  expect([answer.status, answer.body.message]).toEqual([401, SESSION_REVOKED]);
});

test('AUTH-212 /auth/me refusals', async ({ page, clientIp }) => {
  const me = (token?: string) => call('GET', '/api/auth/me', undefined, { ip: newClientIp(), token });
  const account = await createAccount(clientIp, 'auth212', 'Me Refused');
  expect((await me(account.accessToken)).status).toBe(200);

  // (a) No bearer.
  expect((await me()).status).toBe(401);
  // (b) Expired.
  const expired = resignedAccessToken(account.accessToken, { exp: Math.floor(Date.now() / 1000) - 60 });
  expect((await me(expired)).status).toBe(401);
  // (c) After signing out everywhere.
  const other = await createAccount(clientIp, 'auth212-all', 'All Out');
  expect((await post('/api/auth/logout-all', undefined, { ip: newClientIp(), token: other.accessToken })).status).toBe(204);
  const afterAll = await me(other.accessToken);
  expect([afterAll.status, afterAll.body.message]).toEqual([401, SESSION_REVOKED]);
  // (d) A staff access token from the admin API.
  const staff = await createAccount(clientIp, 'auth212-staff', 'Sam Staff');
  await makeSuperAdmin(staff.userId);
  const staffToken = await enrolAndSignInStaff(page, staff);
  expect(jwtClaimsOf(staffToken)).toMatchObject({ type: 'staff_access', aud: 'chumbaq-admin' });
  expect((await me(staffToken)).status).toBe(401);
  // (e) A suspended account's live token.
  await suspendAccount(account.userId);
  const suspended = await me(account.accessToken);
  expect([suspended.status, suspended.body.message]).toEqual([403, 'Account suspended']);
});

// ---- Security and miscellany

function withoutTimestamp(text: string): Record<string, unknown> {
  const { timestamp, ...rest } = JSON.parse(text) as Record<string, unknown>;
  return rest;
}

test('AUTH-215 trap addresses answer like any other address', async ({ clientIp }) => {
  const trap = uniqueEmail('auth215-trap');
  await seedTrapAddress(trap, `E2E AUTH-215 ${randomBytes(3).toString('hex')}`);
  const taken = await createAccount(clientIp, 'auth215-taken', 'Ta Ken');
  const unknown = uniqueEmail('auth215-nobody');
  const wrong = 'not-the-password-1';

  const trapLogin = await post('/api/auth/login', { email: trap, password: wrong }, { ip: newClientIp() });
  const unknownLogin = await post('/api/auth/login', { email: unknown, password: wrong }, { ip: newClientIp() });
  const takenLogin = await post('/api/auth/login', { email: taken.email, password: wrong }, { ip: newClientIp() });
  expect([trapLogin.status, unknownLogin.status, takenLogin.status]).toEqual([401, 401, 401]);
  expect(withoutTimestamp(trapLogin.text)).toEqual(withoutTimestamp(unknownLogin.text));
  expect(withoutTimestamp(trapLogin.text)).toEqual(withoutTimestamp(takenLogin.text));

  const trapRegister = await post('/api/auth/register', { email: trap, name: 'Some One' }, { ip: newClientIp() });
  const unknownRegister = await post('/api/auth/register', { email: unknown, name: 'Some One' }, { ip: newClientIp() });
  const takenRegister = await post('/api/auth/register', { email: taken.email, name: 'Some One' }, { ip: newClientIp() });
  expect([trapRegister.status, unknownRegister.status, takenRegister.status]).toEqual([202, 202, 202]);
  expect(trapRegister.text).toBe(unknownRegister.text);
  expect(trapRegister.text).toBe(takenRegister.text);

  const trapForgot = await post('/api/auth/forgot-password', { email: trap }, { ip: newClientIp() });
  const unknownForgot = await post('/api/auth/forgot-password', { email: uniqueEmail('auth215-other') }, { ip: newClientIp() });
  const takenForgot = await post('/api/auth/forgot-password', { email: taken.email }, { ip: newClientIp() });
  expect([trapForgot.status, unknownForgot.status, takenForgot.status]).toEqual([200, 200, 200]);
  expect(trapForgot.text).toBe(unknownForgot.text);
  expect(trapForgot.text).toBe(takenForgot.text);

  // The unknown address's sign-up mail arrives (registered after the trap's); the trap gets none.
  await waitForMail(unknown, { subjectIncludes: 'Finish creating your Chumbaq account' });
  await waitForMail(taken.email, { subjectIncludes: 'already' });
  expect(await mailsTo(trap)).toEqual([]);
});

test('AUTH-217 a mistyped address on the first submit is stopped by the browser, not zod', async ({ page }) => {
  const sent = recordRequests(page, '/api/auth/login');
  const email = page.getByLabel('Email');
  const errors = page.locator('p.text-destructive');
  await page.goto('/login');
  // No noValidate, and a type=email field: the browser validates.
  expect(await page.locator('form').first().evaluate((form) => (form as HTMLFormElement).noValidate)).toBe(false);
  await expect(email).toHaveAttribute('type', 'email');

  for (const [index, value] of ['abc', 'not-an-email', 'foo@'].entries()) {
    if (index < 2) await page.reload();
    await email.fill(value);
    await page.getByLabel('Password', { exact: true }).fill('x');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    expect(await email.evaluate((e) => (e as HTMLInputElement).validity.typeMismatch)).toBe(true);
    expect(await email.evaluate((e) => (e as HTMLInputElement).validationMessage)).not.toBe('');
    await expect(errors).toHaveCount(0);
  }

  // a@b passes the browser (no dot needed) but not zod, which wants a top-level domain.
  await page.reload();
  await email.fill('a@b');
  await page.getByLabel('Password', { exact: true }).fill('x');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  expect(await email.evaluate((e) => (e as HTMLInputElement).validity.valid)).toBe(true);
  await expect(page.getByText('Invalid email address', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(0);
});

test("AUTH-223 a tenant's passkey without user verification works as a second factor and for reauth", async ({ page, clientIp }) => {
  // A security key with no PIN or biometrics: its assertions never carry UV.
  const { account } = await passkeyTenant(page, clientIp, 'auth223', { userVerification: 'unsupported' });
  await signOutFromMenu(page, account.name);
  const since = await dbNow();

  // 1. After the password.
  const offered = page.waitForResponse(isApi('/api/auth/login/passkey/options'));
  await submitLogin(page, account.email, account.password);
  await page.getByRole('button', { name: 'Use passkey' }).click();
  expect(((await (await offered).json()) as { data: { userVerification: string } }).data.userVerification).toBe('preferred');
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  const [session] = await sessionsSince(account.userId, since);
  expect(session.amr).toEqual(['pwd', 'webauthn']);

  // 2. Re-authenticating with it.
  await withStaffLink(page, account, { stale: true });
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  const reauthOptions = page.waitForResponse(isApi('/api/auth/reauth/passkey/options'));
  const reauth = page.waitForResponse(isApi('/api/auth/reauth/passkey/verify'));
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  expect(((await (await reauthOptions).json()) as { data: { userVerification: string } }).data.userVerification).toBe('preferred');
  expect((await reauth).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();

  // 3. Passwordless always requires user verification: not signed in.
  await signOutFromMenu(page, account.name);
  const verifies = recordRequests(page, '/api/auth/passkey/verify');
  const passwordless = page.waitForResponse(isApi('/api/auth/passkey/options'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  expect(((await (await passwordless).json()) as { data: { options: { userVerification: string } } }).data.options.userVerification).toBe(
    'required',
  );
  await expect(page.getByText(PROMPT_CANCELLED, { exact: true }).or(page.getByText(PASSKEY_REFUSED, { exact: true }))).toBeVisible({
    timeout: 75_000,
  });
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  for (const request of verifies) expect((await request.response())?.status()).toBe(401);
});

test('AUTH-225 the recovery-code link disappears once every code is used', async ({ page, browser, baseURL, clientIp }) => {
  // (a) An authenticator-app tenant.
  const account = await createAccount(clientIp, 'auth225-totp', 'Tot Pused');
  const totp = await enrolTotp({ ip: clientIp }, account);
  await markAllRecoveryCodesUsed(account.userId);
  const step = await passwordStep(account, newClientIp());
  expect(step.body.methods).toEqual(['totp']);

  await page.goto('/login');
  await submitLogin(page, account.email, account.password);
  await expect(page.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(page.getByRole('button', { name: LOST_DEVICE })).toHaveCount(0);
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(totp));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

  await withStaffLink(page, account, { stale: true });
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(dialog.getByRole('button', { name: LOST_DEVICE })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  const factors = await call('GET', '/api/auth/factors', undefined, { ip: newClientIp(), token: totp.accessToken });
  expect(factors.status).toBe(200);
  expect(factors.body).toMatchObject({ recoveryCodesRemaining: 0, methods: ['totp'] });
  const used = await post('/api/auth/login/recovery-code', { handle: await handleFor(account, newClientIp()), code: totp.recoveryCodes[0] }, { ip: newClientIp() });
  expect([used.status, used.body.message]).toEqual([401, CODE_REFUSED]);

  // (b) A passkey-only tenant, in a browser of its own.
  const passkeyContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': newClientIp() } });
  const passkeyPage = await passkeyContext.newPage();
  const { account: keyed } = await passkeyTenant(passkeyPage, clientIp, 'auth225-key');
  await markAllRecoveryCodesUsed(keyed.userId);
  await signOutFromMenu(passkeyPage, keyed.name);
  const keyedStep = await passwordStep(keyed, newClientIp());
  expect(keyedStep.body.methods).toEqual(['webauthn']);
  await submitLogin(passkeyPage, keyed.email, keyed.password);
  await expect(passkeyPage.getByRole('button', { name: 'Use passkey' })).toBeVisible();
  await expect(passkeyPage.getByRole('button', { name: LOST_DEVICE })).toHaveCount(0);
  const keyedUsed = await post('/api/auth/login/recovery-code', { handle: keyedStep.body.handle, code: 'abcd-efgh-ijkl-mnop' }, { ip: newClientIp() });
  expect([keyedUsed.status, keyedUsed.body.message]).toEqual([401, CODE_REFUSED]);
  await passkeyContext.close();
});

test('AUTH-227 the authenticator code drift window is one step either side', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth227', 'Dri Ft');
  const { secret, accessToken } = await enrolTotp({ ip: clientIp }, account);
  const since = await dbNow();
  const signInWith = async (offset: number, { reset = true } = {}) => {
    if (reset) await resetTotpStep(account.userId);
    const handle = await handleFor(account, newClientIp());
    return post('/api/auth/login/totp', { handle, code: totpCode(secret, offset) }, { ip: newClientIp() });
  };

  await roomInStep(12_000);
  const previous = await signInWith(-1);
  const twoBack = await signInWith(-2);
  const twoAhead = await signInWith(2);
  expect(previous.status).toBe(200);
  expect([twoBack.status, twoBack.body.message]).toEqual([401, CODE_REFUSED]);
  expect([twoAhead.status, twoAhead.body.message]).toEqual([401, CODE_REFUSED]);

  await roomInStep(12_000);
  const next = await signInWith(1);
  const current = await signInWith(0, { reset: false });
  expect(next.status).toBe(200);
  // After the next step's code, the current step's is spent too.
  expect([current.status, current.body.message]).toEqual([401, CODE_REFUSED]);
  const failures = (await authEventsFor(account.email, since)).filter((e) => e.type === 'login.failed');
  expect(failures.map((e) => e.reason)).toEqual(['totp_failed', 'totp_failed', 'totp_failed']);

  // The same window on /reauth/totp, refused with 403.
  await roomInStep(8_000);
  await resetTotpStep(account.userId);
  const reauthTwoBack = await post('/api/auth/reauth/totp', { code: totpCode(secret, -2) }, { ip: newClientIp(), token: accessToken });
  expect([reauthTwoBack.status, reauthTwoBack.body.message]).toEqual([403, CODE_REFUSED]);
  const reauthPrevious = await post('/api/auth/reauth/totp', { code: totpCode(secret, -1) }, { ip: newClientIp(), token: accessToken });
  expect(reauthPrevious.status).toBe(200);
});

test('AUTH-228 an authenticator secret that cannot be decrypted answers 503, on the step and in the dialog', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth228', 'Cor Rupt');
  const totp = await enrolTotp({ ip: clientIp }, account);
  const restore = await corruptTotpSecret(account.userId);
  try {
    // 1. The step's alert; no failure recorded and the handle not spent.
    const since = await dbNow();
    await page.goto('/login');
    await submitLogin(page, account.email, account.password);
    const unavailable = page.waitForResponse(isApi('/api/auth/login/totp'));
    await page.getByLabel('Code from your authenticator app').fill(totpCode(totp.secret, 0));
    await page.getByRole('button', { name: 'Confirm' }).click();
    expect((await unavailable).status()).toBe(503);
    await expect(page.getByRole('alert')).toHaveText(NOT_AVAILABLE);
    expect((await authEventsFor(account.email, since)).filter((e) => e.type === 'login.failed')).toEqual([]);

    // 2. A recovery code still signs in, with the same handle.
    await page.getByRole('button', { name: LOST_DEVICE }).click();
    await page.getByLabel('Recovery code').fill(totp.recoveryCodes[0]);
    await page.getByRole('button', { name: 'Use recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

    // 3. The dialog says the same and stays open.
    await withStaffLink(page, account, { stale: true });
    await bannerCancel(page).click();
    const dialog = reauthDialog(page);
    const dialogUnavailable = page.waitForResponse(isApi('/api/auth/reauth/totp'));
    await dialog.getByLabel('Code from your authenticator app').fill(totpCode(totp.secret, 0));
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    expect((await dialogUnavailable).status()).toBe(503);
    await expect(dialog.getByRole('alert')).toHaveText(NOT_AVAILABLE);
    await expect(dialog).toBeVisible();

    // 4. Ten more on one handle all answer 503.
    await clearSignInAttempts(account.email);
    const handle = await handleFor(account, newClientIp());
    const answers: number[] = [];
    for (let i = 0; i < 10; i++) {
      answers.push((await post('/api/auth/login/totp', { handle, code: totpCode(totp.secret, 0) }, { ip: newClientIp() })).status);
    }
    expect(answers).toEqual(Array(10).fill(503));
    // Only what follows is expected to fail: an outage should not count against the person.
    knownDefect('AUTH-228');
    const eleventh = await post('/api/auth/login/totp', { handle, code: totpCode(totp.secret, 0) }, { ip: newClientIp() });
    expect([eleventh.status, eleventh.body.message]).toEqual([503, NOT_AVAILABLE]);
  } finally {
    await restore();
  }
});

test('AUTH-232 suspension or a 503 at the second step stays on the step', async ({ page, browser, baseURL, clientIp }) => {
  // An authenticator-app tenant.
  const account = await createAccount(clientIp, 'auth232-totp', 'Sus Pended');
  const totp = await enrolTotp({ ip: clientIp }, account);
  const refreshes = recordRequests(page, '/api/auth/refresh');
  await page.goto('/login');
  await submitLogin(page, account.email, account.password);
  await expect(page.getByLabel('Code from your authenticator app')).toBeVisible();
  const before = refreshes.length;
  await suspendAccount(account.userId);
  const refused = page.waitForResponse(isApi('/api/auth/login/totp'));
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(totp));
  await page.getByRole('button', { name: 'Confirm' }).click();
  expect((await refused).status()).toBe(403);
  await expect(page.getByRole('alert')).toHaveText('Account suspended');
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(refreshes.length).toBe(before);
  expect(await refreshCookie(page)).toBeUndefined();

  // A 503 on the same step, unsuspended.
  await sql('UPDATE users SET suspended_at = NULL WHERE id = $1', [account.userId]);
  const restore = await corruptTotpSecret(account.userId);
  await page.getByRole('button', { name: 'Start again' }).click();
  await submitLogin(page, account.email, account.password);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(totp.secret, 0));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('alert')).toHaveText(NOT_AVAILABLE);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await restore();

  // A passkey tenant, in a browser of its own.
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': newClientIp() } });
  const keyPage = await context.newPage();
  try {
    const { account: keyed } = await passkeyTenant(keyPage, clientIp, 'auth232-key');
    await signOutFromMenu(keyPage, keyed.name);
    const [key] = await customerPasskeyRows(keyed.userId);
    const keyRefreshes = recordRequests(keyPage, '/api/auth/refresh');
    await submitLogin(keyPage, keyed.email, keyed.password);
    await expect(keyPage.getByRole('button', { name: 'Use passkey' })).toBeVisible();
    await suspendAccount(keyed.userId);
    const keyRefused = keyPage.waitForResponse(isApi('/api/auth/login/passkey/verify'));
    await keyPage.getByRole('button', { name: 'Use passkey' }).click();
    expect((await keyRefused).status()).toBe(403);
    await expect(keyPage.getByRole('alert')).toHaveText('Account suspended');
    await expect(keyPage).toHaveURL(/\/login$/);
    expect(keyRefreshes).toHaveLength(0);
    expect(await refreshCookie(keyPage)).toBeUndefined();
    // The assertion was verified first: the counter moved on.
    const [after] = await customerPasskeyRows(keyed.userId);
    expect(Number(after.counter)).toBeGreaterThan(Number(key.counter));
    await keyPage.getByRole('button', { name: 'Start again' }).click();
    await expect(keyPage.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('AUTH-233 successful password re-authentications use up the per-network sign-in allowance', async ({ clientIp }) => {
  test.setTimeout(5 * 60_000);
  const account = await createAccount(clientIp, 'auth233', 'Ree Auth');
  const reauth = () => post('/api/auth/reauth', { password: account.password }, { ip: clientIp, token: account.accessToken });
  try {
    // Ten right passwords from one network, five a minute (the route's throttle).
    const answers: number[] = [];
    for (let batch = 0; batch < 2; batch++) {
      if (batch > 0) await sleep(61_000);
      for (let i = 0; i < 5; i++) answers.push((await reauth()).status);
    }
    expect(answers).toEqual(Array(10).fill(200));
    await sleep(61_000);
    // Only what follows is expected to fail: right passwords are no wrong guesses.
    knownDefect('AUTH-233');
    const eleventh = await reauth();
    expect([eleventh.status, eleventh.body.message]).toEqual([200, undefined]);
    expect((await passwordStep(account, clientIp)).status).toBe(200);
  } finally {
    await clearSignInAttempts(account.email);
  }
});

test("AUTH-234 successful authenticator re-authentications use up the account's second-factor allowance", async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth234', 'Tee Reauth');
  const { secret, accessToken } = await enrolTotp({ ip: clientIp }, account);
  const reauth = async () => {
    await resetTotpStep(account.userId);
    return post('/api/auth/reauth/totp', { code: totpCode(secret, 0) }, { ip: newClientIp(), token: accessToken });
  };
  try {
    const answers: number[] = [];
    for (let i = 0; i < 10; i++) answers.push((await reauth()).status);
    expect(answers).toEqual(Array(10).fill(200));
    // Only what follows is expected to fail: right codes are no wrong guesses.
    knownDefect('AUTH-234');
    expect((await reauth()).status).toBe(200);
    const handle = await handleFor(account, newClientIp());
    await resetTotpStep(account.userId);
    const signIn = await post('/api/auth/login/totp', { handle, code: totpCode(secret, 0) }, { ip: newClientIp() });
    expect(signIn.status).toBe(200);
  } finally {
    await clearSignInAttempts(account.email);
  }
});

// ---- Session lapse, restore and cookies

test('AUTH-239 a suspended refresh mid-session goes to the suspended notice', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth239', 'Mid Suspend');
  const project = await createProject(account, clientIp, `AUTH-239 ${Date.now()}`);
  await signIn(page, account);
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBe('1');
  await suspendAccount(account.userId);
  const refreshes = await captureResponses(page, '/api/auth/refresh');
  let refused = false;
  await page.route(
    (url) => url.pathname.startsWith('/api/projects/'),
    async (route) => {
      if (refused) return route.continue();
      refused = true;
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Unauthorized"}' });
    },
  );

  await page.getByText(project.name, { exact: true }).click();
  await expect(page).toHaveURL(/\/login\?suspended=1$/);
  await expect(page.getByRole('alert').filter({ hasText: SUSPENDED_NOTICE })).toHaveText(SUSPENDED_NOTICE);
  expect(refused).toBe(true);
  expect(refreshes.map((r) => [r.status, r.json?.message])).toEqual([[403, 'Account suspended']]);
  expect(refreshes[0].setCookie).toMatch(/chumbaq_refresh=;/);
  expect(await refreshCookie(page)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBeNull();
});

test('AUTH-240 a throttled refresh during page load does not sign out', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth240', 'Thr Ottled');
  await signIn(page, account);
  const notes = () => page.evaluate(() => [localStorage.getItem('chumbaq_signed_in'), localStorage.getItem('chumbaq_session_limit')]);
  const before = await notes();
  const cookieBefore = await refreshCookie(page);
  expect(before[0]).toBe('1');
  expect(cookieBefore).toBeDefined();

  await page.route('**/api/auth/refresh', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{"message":"Too Many Requests"}' }), {
    times: 1,
  });
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  expect(await notes()).toEqual(before);
  expect((await refreshCookie(page))?.value).toBe(cookieBefore!.value);

  await page.unrouteAll();
  const restored = page.waitForResponse(isApi('/api/auth/refresh'));
  await page.reload();
  expect((await restored).status()).toBe(200);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
});

test('AUTH-241 a refresh that succeeds while /auth/me fails keeps the session on this browser', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth241', 'Me Fails');
  const observed: Array<{ variant: string; note: string | null; refreshes: number; url: string }> = [];
  for (const variant of ['500', 'abort'] as const) {
    const since = await dbNow();
    await signIn(page, account);
    const [session] = await sessionsSince(account.userId, since);
    await page.route(
      '**/api/auth/me',
      (route) => (variant === '500' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Internal server error"}' }) : route.abort()),
      { times: 1 },
    );
    const refreshed = page.waitForResponse(isApi('/api/auth/refresh'));
    await page.reload();
    expect((await refreshed).status()).toBe(200);
    await expect(page).toHaveURL(/\/login$/);
    await page.unrouteAll();

    const refreshes = recordRequests(page, '/api/auth/refresh');
    await page.reload();
    await page.waitForLoadState('networkidle');
    const [row] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [session.id]);
    expect(row.revoked_at).toBeNull();
    observed.push({
      variant,
      note: await page.evaluate(() => localStorage.getItem('chumbaq_signed_in')),
      refreshes: refreshes.length,
      url: new URL(page.url()).pathname,
    });
    // Signed out for the next variant, whatever happened.
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
  }
  // Only what follows is expected to fail: a passing error should not end the session here.
  knownDefect('AUTH-241');
  expect(observed).toEqual([
    { variant: '500', note: '1', refreshes: 1, url: '/projects' },
    { variant: 'abort', note: '1', refreshes: 1, url: '/projects' },
  ]);
});

test('AUTH-242 a session that lapses on the cancel page signs in and comes back to it', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth242', 'Lap Sed');
  const since = await dbNow();
  await signIn(page, account);
  const [session] = await sessionsSince(account.userId, since);
  await seedStaffLink(account.userId);
  await page.goto(CANCEL_PAGE);
  const cancelButton = page.getByRole('button', { name: 'Cancel the link' });
  await expect(cancelButton).toBeVisible();

  // 1. The session row revoked: the cancel's 401, a refused refresh, then sign-in with next.
  await sql('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [session.id]);
  const cancels = await captureResponses(page, '/api/auth/staff-reset-link/cancel');
  const refreshes = await captureResponses(page, '/api/auth/refresh');
  await cancelButton.click();
  await expect(page).toHaveURL(`${baseURL}${NEXT_CANCEL}`);
  expect(cancels.map((c) => [c.status, c.json?.message])).toEqual([[401, SESSION_REVOKED]]);
  expect(refreshes.map((r) => r.status)).toEqual([401]);
  await page.unrouteAll();

  // 3. Signing in comes back, and that sign-in voided the link.
  await submitLogin(page, account.email, account.password);
  await expect(page).toHaveURL(`${baseURL}${CANCEL_PAGE}`);
  await expect(page.getByText('No support link is waiting', { exact: true })).toBeVisible();

  // 2. No sign-in note: the 401 goes there without trying a refresh.
  await seedStaffLink(account.userId);
  await page.reload();
  await expect(cancelButton).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('chumbaq_signed_in'));
  const noRefresh = recordRequests(page, '/api/auth/refresh');
  await page.route(
    '**/api/auth/staff-reset-link/cancel',
    (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Unauthorized"}' }),
    { times: 1 },
  );
  await cancelButton.click();
  await expect(page).toHaveURL(`${baseURL}${NEXT_CANCEL}`);
  expect(noRefresh).toHaveLength(0);
  await page.unrouteAll();
  await submitLogin(page, account.email, account.password);
  await expect(page).toHaveURL(`${baseURL}${CANCEL_PAGE}`);
  await expect(page.getByText('No support link is waiting', { exact: true })).toBeVisible();
});

test('AUTH-244 two refresh cookies of the same name are treated as none', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth244', 'Two Cookies');
  const since = await dbNow();
  const login = await passwordStep(account, newClientIp());
  const token = refreshTokenIn(login.setCookie);
  expect(token).not.toBeNull();
  const sid = String(jwtClaimsOf(login.body.tokens!.accessToken).sid);
  const jti = async () => (await sql<{ current_jti: string }>('SELECT current_jti FROM auth_sessions WHERE id = $1', [sid]))[0].current_jti;
  const jtiBefore = await jti();

  for (const cookie of [`chumbaq_refresh=${token}; chumbaq_refresh=junk`, `chumbaq_refresh=${token}; chumbaq_refresh=${token}`]) {
    const answer = await post('/api/auth/refresh', {}, { ip: newClientIp(), cookie });
    expect([answer.status, answer.body.message]).toEqual([401, REFRESH_REFUSED]);
    expect(answer.setCookie).toBeNull();
  }
  expect(await jti()).toBe(jtiBefore);
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).not.toContain('refresh.failed');
  const anyRefreshFailed = await sql(`SELECT id FROM auth_events WHERE type = 'refresh.failed' AND session_id = $1`, [sid]);
  expect(anyRefreshFailed).toEqual([]);

  const once = await refreshWith(token, newClientIp());
  expect(once.status).toBe(200);
  const rotated = refreshTokenIn(once.setCookie);
  expect(rotated).not.toBeNull();
  expect(rotated).not.toBe(token);
  expect(await jti()).not.toBe(jtiBefore);
});

test("AUTH-246 the client header's value is not checked, only its presence", async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth246', 'Hea Der');
  const login = await passwordStep(account, newClientIp());
  const refreshToken = refreshTokenIn(login.setCookie)!;
  const bogusResponse = { id: 'bogus', rawId: 'bogus', type: 'public-key', response: {}, clientExtensionResults: {} };
  const signup = uniqueEmail('auth246-signup');

  const routes: Array<{ path: string; body: unknown; cookie?: string; status: number; web?: true }> = [
    { path: '/api/auth/login', body: { email: account.email, password: account.password }, status: 200 },
    { path: '/api/auth/refresh', body: {}, cookie: `chumbaq_refresh=${refreshToken}`, status: 200 },
    { path: '/api/auth/register', body: { email: uniqueEmail('auth246-reg'), name: 'Reg Ister' }, status: 202 },
    { path: '/api/auth/complete-signup', body: { token: signupLinkToken(signup, 'Com Plete'), password: account.password }, status: 201 },
    { path: '/api/auth/login/totp', body: { handle: 'h'.repeat(43), code: '123456' }, status: 401, web: true },
    { path: '/api/auth/login/recovery-code', body: { handle: 'h'.repeat(43), code: 'abcd-efgh-ijkl-mnop' }, status: 401, web: true },
    { path: '/api/auth/login/passkey/verify', body: { handle: 'h'.repeat(43), response: bogusResponse }, status: 401, web: true },
    { path: '/api/auth/passkey/verify', body: { flowId: 'f'.repeat(43), response: bogusResponse }, status: 401, web: true },
  ];
  for (const route of routes) {
    const anything = await postWithClientValue(route.path, route.body, { ip: newClientIp(), clientValue: 'anything', cookie: route.cookie });
    expect([route.path, anything.status]).toEqual([route.path, route.status]);
    expect(anything.message).not.toBe(MISSING_HEADER);
    if (route.web) {
      const web = await postWithClientValue(route.path, route.body, { ip: newClientIp(), clientValue: 'web' });
      expect([route.path, anything.status, anything.message]).toEqual([route.path, web.status, web.message]);
    }
  }

  // Empty, blank or absent: refused.
  const body = { email: account.email, password: account.password };
  for (const clientValue of ['', '   ', null]) {
    const answer = await postWithClientValue('/api/auth/login', body, { ip: newClientIp(), clientValue });
    expect([JSON.stringify(clientValue), answer.status, answer.message]).toEqual([JSON.stringify(clientValue), 403, MISSING_HEADER]);
    expect(answer.setCookie).toEqual([]);
  }
});

test('AUTH-248 the recent sign-in boundary: 14 minutes passes, 16 asks', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth248', 'Bou Ndary');
  await signIn(page, account);
  const cancels = await captureResponses(page, '/api/auth/staff-reset-link/cancel');
  const dialog = reauthDialog(page);

  await seedStaffLink(account.userId);
  await setSignInAge(account.userId, 14);
  await page.reload();
  await expect(staffLinkBanner(page)).toBeVisible();
  await bannerCancel(page).click();
  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(cancels.map((c) => c.status)).toEqual([200]);

  await seedStaffLink(account.userId);
  await setSignInAge(account.userId, 16);
  await page.reload();
  await expect(staffLinkBanner(page)).toBeVisible();
  await bannerCancel(page).click();
  await expect(dialog).toBeVisible();
  expect(cancels.map((c) => [c.status, c.json?.message])).toEqual([
    [200, undefined],
    [403, REAUTH_REQUIRED],
  ]);
  await dialog.getByLabel('Password').fill(account.password);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect(staffLinkBanner(page)).toBeHidden();
  expect(cancels.map((c) => c.status)).toEqual([200, 403, 200]);
});

test('AUTH-250 IPv6 clients in one /64 share the sign-in limit and route throttles', async ({ clientIp }) => {
  test.setTimeout(5 * 60_000);
  const account = await createAccount(clientIp, 'auth250', 'Six Four');
  const [g1, g2] = [randomBytes(2).toString('hex').replace(/^0+/, '') || '1', randomBytes(2).toString('hex').replace(/^0+/, '') || '1'];
  const net = `2001:db8:${g1}:${g2}`;
  const otherNet = `2001:db8:${g1}:${(parseInt(g2, 16) ^ 1).toString(16)}`;
  const login = (ip: string, password: string, email = account.email) => post('/api/auth/login', { email, password }, { ip });
  try {
    // 1. Five wrong from ::a, five from ::b, a minute apart (one throttle for the /64).
    const wrongs: number[] = [];
    for (let i = 0; i < 5; i++) wrongs.push((await login(`${net}::a`, `wrong-a-${i}`)).status);
    await sleep(61_000);
    for (let i = 0; i < 5; i++) wrongs.push((await login(`${net}::b`, `wrong-b-${i}`)).status);
    expect(wrongs).toEqual(Array(10).fill(401));
    const counts = await signInAttemptCounts(account.email);
    expect(Object.keys(counts).filter((field) => field.startsWith('net:'))).toEqual([`net:${net}::/64`]);
    expect(counts[`net:${net}::/64`]).toBe('10');
    await sleep(61_000);

    // 2. The right password from ::c of the same /64: limited.
    const limited = await login(`${net}::c`, account.password);
    expect([limited.status, limited.body.message]).toEqual([429, LIMITED]);
    // 3. From another /64: signed in.
    expect((await login(`${otherNet}::a`, account.password)).status).toBe(200);

    // 4. The route throttle keys by /64 too: the sixth in a minute across ::a and ::b.
    const fresh = `2001:db8:${g1}:${(parseInt(g2, 16) ^ 2).toString(16)}`;
    const nobody = uniqueEmail('auth250-nobody');
    const throttled: number[] = [];
    for (let i = 0; i < 6; i++) throttled.push((await login(`${fresh}::${i % 2 ? 'b' : 'a'}`, 'not-it-1', nobody)).status);
    expect(throttled).toEqual([401, 401, 401, 401, 401, 429]);

    // 5. A mapped IPv4 address and the plain one are the same network.
    const other = await createAccount(clientIp, 'auth250-v4', 'Vee Four');
    const v4 = `203.0.113.${1 + randomBytes(1)[0] % 254}`;
    expect((await login(`::ffff:${v4}`, 'wrong-mapped', other.email)).status).toBe(401);
    expect((await login(v4, 'wrong-plain', other.email)).status).toBe(401);
    const v4Counts = await signInAttemptCounts(other.email);
    expect(Object.keys(v4Counts).filter((field) => field.startsWith('net:'))).toEqual([`net:${v4}`]);
    expect(v4Counts[`net:${v4}`]).toBe('2');
  } finally {
    await clearSignInAttempts(account.email);
  }
});

// ---- Response shapes

test('AUTH-253 the exact user key set in sign-in responses', async ({ page, clientIp }) => {
  const keysOf = (user: object) => Object.keys(user).sort();
  // 1. /login with no factor.
  const plain = await createAccount(clientIp, 'auth253-plain', 'Pla In');
  const login = await passwordStep(plain, newClientIp());
  expect(login.status).toBe(200);
  const bodies: Array<[string, any]> = [['/login', login.body]];

  // 2 and 3. /login/totp and /login/recovery-code.
  const totpAccount = await createAccount(clientIp, 'auth253-totp', 'Tot P');
  const totp = await enrolTotp({ ip: clientIp }, totpAccount);
  const byTotp = await post('/api/auth/login/totp', { handle: await handleFor(totpAccount, newClientIp()), code: await freshTotpCode(totp) }, { ip: newClientIp() });
  expect(byTotp.status).toBe(200);
  bodies.push(['/login/totp', byTotp.body]);
  const byCode = await post(
    '/api/auth/login/recovery-code',
    { handle: await handleFor(totpAccount, newClientIp()), code: totp.recoveryCodes[0] },
    { ip: newClientIp() },
  );
  expect(byCode.status).toBe(200);
  bodies.push(['/login/recovery-code', byCode.body]);

  // 4 and 5. A passkey after the password, and passwordless.
  const { account: keyed } = await passkeyTenant(page, clientIp, 'auth253-key');
  const handle = await handleFor(keyed, newClientIp());
  const secondOptions = await post('/api/auth/login/passkey/options', { handle }, { ip: newClientIp() });
  const second = await post(
    '/api/auth/login/passkey/verify',
    { handle, response: await assertionInPage(page, secondOptions.body) },
    { ip: newClientIp() },
  );
  expect(second.status).toBe(200);
  bodies.push(['/login/passkey/verify', second.body]);
  const flow = await post('/api/auth/passkey/options', undefined, { ip: newClientIp() });
  const [credentialId] = await customerCredentialIds(keyed.userId);
  const passwordless = await post(
    '/api/auth/passkey/verify',
    { flowId: flow.body.flowId, response: await assertionInPage(page, flow.body.options, credentialId) },
    { ip: newClientIp() },
  );
  expect(passwordless.status).toBe(200);
  bodies.push(['/passkey/verify', passwordless.body]);

  for (const [route, body] of bodies) {
    expect([route, keysOf(body.user)]).toEqual([route, USER_KEYS]);
    expect([route, Object.keys(body.tokens)]).toEqual([route, ['accessToken']]);
    // The pending flags appear only when true.
    for (const flag of ['factorResetPending', 'staffLinkPending']) {
      if (flag in body) expect([route, flag, body[flag]]).toEqual([route, flag, true]);
    }
    expect([route, Object.keys(body).filter((key) => !['user', 'tokens'].includes(key))]).toEqual([route, []]);
  }

  for (const [, body] of bodies) expect(body.user).not.toHaveProperty('lastFactorSignInAt');

  // 6. /complete-signup: the row as inserted, which also carries the unselected column, as null.
  const email = uniqueEmail('auth253-signup');
  const signup = await post('/api/auth/complete-signup', { token: signupLinkToken(email, 'New Comer'), password: plain.password }, { ip: newClientIp() });
  expect(signup.status).toBe(201);
  expect(keysOf(signup.body.user)).toEqual([...USER_KEYS, 'lastFactorSignInAt'].sort());
  expect(signup.body.user.lastFactorSignInAt).toBeNull();
  expect(Object.keys(signup.body.tokens)).toEqual(['accessToken']);
  expect(Object.keys(signup.body)).toEqual(['user', 'tokens']);
  for (const [, body] of [...bodies, ['/complete-signup', signup.body]] as Array<[string, any]>) {
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.user).not.toHaveProperty('sessionVersion');
  }
});

test('AUTH-254 the exact key set of GET /api/auth/me', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth254', 'Me Keys');
  const me = await call('GET', '/api/auth/me', undefined, { ip: newClientIp(), token: account.accessToken });
  expect(me.status).toBe(200);
  expect(Object.keys(me.body).sort()).toEqual([...USER_KEYS, 'billingEnabled', 'staffLinkPending'].sort());
  expect(me.body).toMatchObject({ staffLinkPending: false, billingEnabled: true });

  const viewAs = await viewAsToken(page, account.userId, newClientIp());
  const seen = await call('GET', '/api/auth/me', undefined, { ip: newClientIp(), token: viewAs });
  expect(seen.status).toBe(200);
  expect(Object.keys(seen.body).sort()).toEqual([...USER_KEYS, 'billingEnabled', 'staffLinkPending'].sort());
  expect(seen.body).toMatchObject({ id: account.userId, staffLinkPending: false, billingEnabled: false });
});

// ---- Redirects

test('AUTH-264 ?next= wins over a pending invite and a pending verification', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth264', 'Nex Twins');
  await page.addInitScript(() => {
    sessionStorage.setItem('chumbaq_pending_invite', 'A'.repeat(43));
    sessionStorage.setItem('chumbaq_pending_verification', 'some-verification-token');
  });
  await page.goto(NEXT_CANCEL);
  await submitLogin(page, account.email, account.password);
  await expect(page).toHaveURL(`${baseURL}${CANCEL_PAGE}`);
  await expect(page.getByText('No support link is waiting', { exact: true })).toBeVisible();
  // Both were still pending: next won, not an empty store.
  expect(await page.evaluate(() => [sessionStorage.getItem('chumbaq_pending_invite'), sessionStorage.getItem('chumbaq_pending_verification')])).toEqual([
    'A'.repeat(43),
    'some-verification-token',
  ]);
});

test('AUTH-265 ?next= is honoured after every way of finishing sign-in', async ({ page, clientIp, baseURL }) => {
  await blockPasskeyAutofillUnlessAllowed(page);
  const landed = `${baseURL}${CANCEL_PAGE}`;

  // 1. Password, then an authenticator code.
  const totpAccount = await createAccount(clientIp, 'auth265-totp', 'Tot Next');
  const totp = await enrolTotp({ ip: clientIp }, totpAccount);
  await page.goto(NEXT_CANCEL);
  await submitLogin(page, totpAccount.email, totpAccount.password);
  await page.getByLabel('Code from your authenticator app').fill(await freshTotpCode(totp));
  await expect(page).toHaveURL(`${baseURL}${NEXT_CANCEL}`);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(landed);
  await page.goto('/projects');
  await signOutFromMenu(page, totpAccount.name);

  // 2. Password, then "Use passkey".
  const { account } = await passkeyTenant(page, clientIp, 'auth265-key', { block: false });
  await page.goto('/projects');
  await signOutFromMenu(page, account.name);
  await page.goto(NEXT_CANCEL);
  await submitLogin(page, account.email, account.password);
  await expect(page.getByRole('button', { name: 'Use passkey' })).toBeVisible();
  await expect(page).toHaveURL(`${baseURL}${NEXT_CANCEL}`);
  await page.getByRole('button', { name: 'Use passkey' }).click();
  await expect(page).toHaveURL(landed);
  await page.goto('/projects');
  await signOutFromMenu(page, account.name);

  // 3. "Sign in with a passkey".
  await page.goto(NEXT_CANCEL);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(landed);
  await page.goto('/projects');
  await signOutFromMenu(page, account.name);

  // 4. The passkey from the email field's autofill (the virtual authenticator answers it at once).
  await page.evaluate(() => localStorage.setItem('e2e_allow_autofill', '1'));
  const verified = page.waitForResponse(isApi('/api/auth/passkey/verify'));
  await page.goto(NEXT_CANCEL);
  expect((await verified).status()).toBe(200);
  await expect(page).toHaveURL(landed);
  await expect(page.getByText('No support link is waiting', { exact: true })).toBeVisible();
});

// ---- Re-authentication dialog: the last two

test('AUTH-272 a staff-keys-only account in the re-authentication dialog', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth272', 'Sta Ffonly');
  await signIn(page, account);
  await insertStaffPasskeyRow(account.userId);
  await withStaffLink(page, account, { stale: true });
  const factors = page.waitForResponse(isApi('/api/auth/factors', 'GET'));
  await bannerCancel(page).click();
  expect(((await (await factors).json()) as { data: { methods: string[] } }).data.methods).toEqual([]);
  const dialog = reauthDialog(page);
  await dialog.getByLabel('Password').fill(account.password);
  const refused = page.waitForResponse(isApi('/api/auth/reauth'));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  expect((await refused).status()).toBe(403);
  await expect(dialog.getByRole('alert')).toHaveText(STAFF_KEYS_ONLY);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBe('1');
});

test('AUTH-273 a session revoked while the re-authentication dialog is open ends at /login', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'auth273', 'Rev Oked');
  const since = await dbNow();
  await signIn(page, account);
  const [session] = await sessionsSince(account.userId, since);
  await withStaffLink(page, account, { stale: true });
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  await expect(dialog.getByLabel('Password')).toBeVisible();

  await sql('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [session.id]);
  const reauths = await captureResponses(page, '/api/auth/reauth');
  const refreshes = await captureResponses(page, '/api/auth/refresh');
  await dialog.getByLabel('Password').fill(account.password);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForURL('**/login');
  await expect(page).toHaveURL(`${baseURL}/login`);
  expect(reauths.map((r) => [r.status, r.json?.message])).toEqual([[401, SESSION_REVOKED]]);
  expect(refreshes.map((r) => r.status)).toEqual([401]);
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_signed_in'))).toBeNull();
});

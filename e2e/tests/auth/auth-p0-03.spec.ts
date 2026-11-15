import { createHash, randomBytes } from 'crypto';
import type { Page, Request, Response } from '@playwright/test';
import { api, createAccount, createProject, newClientIp, uniqueEmail, type Account } from '../../support/api';
import { adminApi, adminUrl, enrolAndSignInStaff } from '../../support/admin';
import {
  addAuthenticator,
  blockPasskeyAutofill,
  confirmWithPassword,
  enrolTenantPasskey,
  enrolTotp,
  rejectNextCredentialPrompt,
  signInWithTenantPasskey,
} from '../../support/factors';
import { expect, signIn, test } from '../../support/fixtures';
import {
  assertionInPage,
  auditLogsFor,
  authEventsFor,
  call,
  captureResponses,
  customerPasskeyRows,
  dbNow,
  formMessage,
  freshTotpCode,
  handleFor,
  holdRequests,
  jwtClaimsOf,
  mailedSignupLink,
  makeSignInStale,
  makeSuperAdmin,
  passwordStep,
  post,
  reauthDialog,
  refreshTokenIn,
  refreshWith,
  rewriteResponses,
  seedAccountToken,
  seedResetToken,
  seedStaffLink,
  sessionsSince,
  signOutFromMenu,
  sql,
  staffLinkBanner,
  staleSession,
  submitLogin,
  toastTitled,
  tokenRow,
  unusedRecoveryCodes,
  userState,
  viewAsInBrowser,
  viewAsToken,
  waitForAuthEvent,
  wrongTotpCode,
  type RawResponse,
} from '../../support/areas/auth';
import { tokenFromLink } from '../../support/mailbox';

/**
 * The staff-issued reset link's banner and cancel page, re-authentication (the dialog
 * and its routes, with a password, an authenticator app or a passkey), /auth/me, and
 * the sign-in routes' security edges, through the customer app and its API.
 */

const REAUTH_REQUIRED = 'Confirm it is you to continue.';
const READ_ONLY = 'Impersonation sessions are read-only';
const LIMITED = 'Too many failed attempts. Try again in a few minutes.';
const PASSKEY_REFUSED = 'Could not verify that passkey.';
const PROMPT_CANCELLED = 'The passkey request was cancelled or timed out. Please try again.';
const FLOW_EXPIRED = 'Your sign-in has expired. Please start again.';
const CODE_REFUSED = 'That code is not right. Please try again.';
const LINK_CANCELLED = 'account.password_reset_link_cancelled';
const NEW_PASSWORD = 'e2e-New-Password-456!';
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isApi = (path: string, method = 'POST') => (response: Response) =>
  new URL(response.url()).pathname === path && response.request().method() === method;
const pathOf = (request: Request) => new URL(request.url()).pathname;

/** A card title on the account pages (a styled div, not a heading). */
const cardTitle = (page: Page, text: string) => page.locator('[data-slot="card-title"]', { hasText: text });

/** A gate the test opens itself, for holding a request while a waiting state is checked. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Signs in on /login, then seeds a live staff link (a sign-in would void it) and reloads. */
async function signedInWithStaffLink(page: Page, account: Account, { stale = false } = {}): Promise<string> {
  await signIn(page, account);
  const token = await seedStaffLink(account.userId);
  if (stale) await makeSignInStale(account.userId);
  await page.reload();
  await expect(staffLinkBanner(page)).toBeVisible();
  return token;
}

/** The banner's Cancel button. */
const bannerCancel = (page: Page) => staffLinkBanner(page).getByRole('button', { name: 'Cancel', exact: true });

function withoutTimestamp(text: string): Record<string, unknown> {
  const { timestamp, ...rest } = JSON.parse(text) as Record<string, unknown>;
  return rest;
}

/** A tenant with a customer passkey on this tab's authenticator, still signed in (session amr ['pwd']). */
async function signedInPasskeyTenant(page: Page, ip: string, label: string) {
  await blockPasskeyAutofill(page);
  const authenticator = await addAuthenticator(page);
  const account = await createAccount(ip, label, `${label} person`);
  const since = await dbNow();
  await signIn(page, account);
  const recoveryCodes = await enrolTenantPasskey(page, account);
  return { account, authenticator, recoveryCodes, since };
}

// ---- Staff-issued reset link: banner and cancel page

test('AUTH-176 the staff link banner shows while a staff link is live', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth176', 'Bea Banner');
  const project = await createProject(account, clientIp, `AUTH-176 ${Date.now()}`);
  await signIn(page, account);
  await expect(staffLinkBanner(page)).toHaveCount(0);

  const token = await seedStaffLink(account.userId);
  const me = page.waitForResponse(isApi('/api/auth/me', 'GET'));
  // A reload is a refresh, not a sign-in, so it leaves the link live.
  await page.reload();
  expect(((await (await me).json()) as { data: { staffLinkPending: boolean } }).data.staffLinkPending).toBe(true);

  for (const path of ['/projects', `/projects/${project.id}/links`]) {
    if (path !== '/projects') await page.goto(path);
    const banner = staffLinkBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Support issued a link to reset your password.');
    await expect(banner).toContainText('If you did not ask for it, cancel it now and contact support.');
    await expect(bannerCancel(page)).toBeEnabled();
  }
  expect((await tokenRow(token)).used_at).toBeNull();
});

test('AUTH-178 cancelling from the banner with a recent sign-in', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth178', 'Cara Cancel');
  const token = await signedInWithStaffLink(page, account);
  const hold = gate();
  const cancels = await captureResponses(page, '/api/auth/staff-reset-link/cancel', { holdUntil: hold.opened });

  await bannerCancel(page).click();
  const waiting = staffLinkBanner(page).getByRole('button', { name: 'Cancelling...' });
  await expect(waiting).toBeVisible();
  await expect(waiting).toBeDisabled();
  hold.open();

  const toast = toastTitled(page, 'Link cancelled');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Your password was not changed.');
  await expect(staffLinkBanner(page)).toHaveCount(0);
  expect(cancels.map((c) => [c.status, c.json?.data])).toEqual([[200, { cancelled: 1 }]]);
  expect((await tokenRow(token)).used_at).not.toBeNull();
  const audit = await auditLogsFor(account.userId, LINK_CANCELLED);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor_id: account.userId, actor_email: account.email });
  expect(audit[0].metadata).toMatchObject({ reason: 'owner_cancelled', via: 'cancel' });
});

test('AUTH-179 cancelling from the banner with a stale sign-in goes through the reauth dialog', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth179', 'Sid Stale');
  const token = await signedInWithStaffLink(page, account, { stale: true });
  const cancels = await captureResponses(page, '/api/auth/staff-reset-link/cancel');

  await bannerCancel(page).click();
  await expect(reauthDialog(page)).toBeVisible();
  await confirmWithPassword(page, account.password);

  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();
  await expect(staffLinkBanner(page)).toHaveCount(0);
  expect(cancels.map((c) => c.status)).toEqual([403, 200]);
  expect(cancels[0].json.message).toBe(REAUTH_REQUIRED);
  // The re-authentication voided the link itself, so the resent cancel found none.
  expect(cancels[1].json.data).toEqual({ cancelled: 0 });
  expect((await tokenRow(token)).used_at).not.toBeNull();
  const audit = await auditLogsFor(account.userId, LINK_CANCELLED);
  expect(audit.map((row) => row.metadata)).toEqual([expect.objectContaining({ reason: 'owner_signed_in', via: 'password' })]);
});

test('AUTH-182 the cancel page signed out goes through sign-in and back', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth182', 'Olga Out');
  const token = await seedStaffLink(account.userId);

  await page.goto('/account/cancel-support-link');
  await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Fcancel-support-link$/);
  await submitLogin(page, account.email, account.password);

  await expect(page).toHaveURL(/\/account\/cancel-support-link$/);
  await expect(cardTitle(page, 'No support link is waiting')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'No password reset link from support works on your account now. Your password was not changed.',
  );
  await expect(page.getByText('If you did not ask support for a link, contact them to report it.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to your projects' })).toHaveAttribute('href', '/projects');
  await expect(page.getByRole('button', { name: 'Cancel the link' })).toHaveCount(0);

  expect((await tokenRow(token)).used_at).not.toBeNull();
  const audit = await auditLogsFor(account.userId, LINK_CANCELLED);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor_id: null, actor_email: 'system' });
  expect(audit[0].metadata).toMatchObject({ reason: 'owner_signed_in', via: 'password' });
});

test('AUTH-183 the cancel page with a live link and a recent sign-in', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth183', 'Pia Page');
  await signIn(page, account);
  const token = await seedStaffLink(account.userId);

  await page.goto('/account/cancel-support-link');
  await expect(cardTitle(page, 'Cancel the support link')).toBeVisible();
  await expect(
    page.getByText('Support issued a link to reset your password. If you did not ask for it, cancel it now.', { exact: true }),
  ).toBeVisible();
  const cancel = page.getByRole('button', { name: 'Cancel the link' });
  await expect(cancel).toHaveClass(/\bbg-destructive\b/);
  await expect(page.getByText('You may be asked to confirm it is you.', { exact: true })).toBeVisible();
  await expect(page.locator('p', { hasText: `Signed in as ${account.email}.` })).toHaveText(
    `Signed in as ${account.email}. Not you? Sign in again`,
  );
  await expect(page.getByRole('button', { name: 'Not you? Sign in again' })).toBeVisible();
  // The page says it itself, so the banner is not shown here.
  await expect(staffLinkBanner(page)).toHaveCount(0);

  const release = await holdRequests(page, '/api/auth/staff-reset-link/cancel');
  await cancel.click();
  await expect(page.getByRole('button', { name: 'Cancelling...' })).toBeDisabled();
  release();
  await expect(cardTitle(page, 'No support link is waiting')).toBeVisible();
  expect((await tokenRow(token)).used_at).not.toBeNull();
});

test('AUTH-187 the cancel page in view-as', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'auth187', 'Vera Viewed');
  const token = await seedStaffLink(tenant.userId);
  await viewAsInBrowser(page, tenant.userId, newClientIp());
  const cancels: string[] = [];
  page.on('request', (request) => {
    if (pathOf(request) === '/api/auth/staff-reset-link/cancel') cancels.push(request.url());
  });

  await page.goto('/account/cancel-support-link');
  await expect(cardTitle(page, 'Not available while viewing as a tenant')).toBeVisible();
  await expect(page.getByText('Only the account owner can cancel a support link.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/account\/cancel-support-link$/);
  await expect(page.getByRole('button', { name: 'Cancel the link' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Not you? Sign in again' })).toHaveCount(0);
  expect(cancels).toEqual([]);
  expect((await tokenRow(token)).used_at).toBeNull();
});

test('AUTH-188 cancel API refusals', async ({ page, clientIp }) => {
  const path = '/api/auth/staff-reset-link/cancel';
  const account = await createAccount(clientIp, 'auth188', 'Rae Refused');
  const token = await seedStaffLink(account.userId);

  const anonymous = await post(path, undefined, { ip: newClientIp() });
  expect(anonymous.status).toBe(401);

  const stale = await staleSession(account, newClientIp());
  // That sign-in voided the link; a new one is what the stale session would cancel.
  const second = await seedStaffLink(account.userId);
  const staleAnswer = await post(path, undefined, { ip: newClientIp(), token: stale.accessToken });
  expect(staleAnswer.status).toBe(403);
  expect(staleAnswer.body.message).toBe(REAUTH_REQUIRED);

  const viewAs = await viewAsToken(page, account.userId, newClientIp());
  const viewAsAnswer = await post(path, undefined, { ip: newClientIp(), token: viewAs });
  expect(viewAsAnswer.status).toBe(403);
  expect(viewAsAnswer.body.message).toBe(READ_ONLY);
  expect((await tokenRow(second)).used_at).toBeNull();
  expect((await tokenRow(token)).used_at).not.toBeNull();

  // A fresh session (its sign-in voided the link): ten cancels find none, the eleventh is throttled.
  const ip = newClientIp();
  const fresh = await passwordStep(account, ip);
  expect(fresh.status).toBe(200);
  const accessToken = fresh.body.tokens!.accessToken;
  const answers: RawResponse[] = [];
  for (let i = 0; i < 11; i++) answers.push(await post(path, undefined, { ip, token: accessToken }));
  expect(answers.slice(0, 10).map((a) => a.status)).toEqual(Array(10).fill(200));
  expect(answers.slice(0, 10).map((a) => a.body)).toEqual(Array(10).fill({ cancelled: 0 }));
  expect(answers[10].status).toBe(429);
});

test('AUTH-189 sign-in voids staff links; the password step alone does not', async ({ clientIp }) => {
  // (a) No second factor: the password sign-in is complete, so it voids the link.
  const plain = await createAccount(clientIp, 'auth189-a', 'Pat Plain');
  const plainLink = await seedStaffLink(plain.userId);
  const signedIn = await passwordStep(plain, newClientIp());
  expect(signedIn.status).toBe(200);
  expect(typeof signedIn.body.tokens?.accessToken).toBe('string');
  expect((await tokenRow(plainLink)).used_at).not.toBeNull();
  const plainAudit = await auditLogsFor(plain.userId, LINK_CANCELLED);
  expect(plainAudit).toHaveLength(1);
  expect(plainAudit[0]).toMatchObject({ actor_id: null, actor_email: 'system' });
  expect(plainAudit[0].metadata).toMatchObject({ reason: 'owner_signed_in', via: 'password' });

  // (b) An authenticator app: the password step alone leaves the link live.
  const withTotp = await createAccount(clientIp, 'auth189-b', 'Tia Totp');
  const totp = await enrolTotp({ ip: clientIp }, withTotp);
  const link = await seedStaffLink(withTotp.userId);
  const ip = newClientIp();
  const handle = await handleFor(withTotp, ip);
  expect((await tokenRow(link)).used_at).toBeNull();
  expect(await auditLogsFor(withTotp.userId, LINK_CANCELLED)).toEqual([]);

  const completed = await post('/api/auth/login/totp', { handle, code: await freshTotpCode(totp) }, { ip });
  expect(completed.status).toBe(200);
  expect((await tokenRow(link)).used_at).not.toBeNull();
  const audit = await auditLogsFor(withTotp.userId, LINK_CANCELLED);
  expect(audit).toHaveLength(1);
  expect(audit[0].metadata).toMatchObject({ reason: 'owner_signed_in', via: 'factor' });
});

// ---- Re-authentication dialog and routes

test('AUTH-192 password re-authentication through the dialog', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth192', 'Rex Reauth');
  const since = await dbNow();
  await signedInWithStaffLink(page, account, { stale: true });
  const [session] = await sessionsSince(account.userId, since);
  const cancelAuth: string[] = [];
  page.on('request', (request) => {
    if (pathOf(request) === '/api/auth/staff-reset-link/cancel') cancelAuth.push(request.headers()['authorization'] ?? '');
  });
  const cancels = await captureResponses(page, '/api/auth/staff-reset-link/cancel');

  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('This is a sensitive action, so we need to check it is still you.', { exact: true })).toBeVisible();
  const password = dialog.getByLabel('Password');
  await expect(password).toBeFocused();
  const confirm = dialog.getByRole('button', { name: 'Confirm' });
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

  await password.fill(account.password);
  await expect(confirm).toBeEnabled();
  const release = await holdRequests(page, '/api/auth/reauth');
  const reauthed = page.waitForResponse(isApi('/api/auth/reauth'));
  await confirm.click();
  await expect(dialog.getByRole('button', { name: 'Checking...' })).toBeDisabled();
  release();
  const reauth = await reauthed;
  expect(reauth.status()).toBe(200);
  const { accessToken } = ((await reauth.json()) as { data: { accessToken: string } }).data;
  expect(accessToken).toMatch(/^eyJ/);

  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();
  expect(cancels.map((c) => c.status)).toEqual([403, 200]);
  // The refused request was sent again, with the new token.
  expect(cancelAuth).toHaveLength(2);
  expect(cancelAuth[1]).toBe(`Bearer ${accessToken}`);
  expect(cancelAuth[0]).not.toBe(cancelAuth[1]);

  const [row] = await sql<{ authenticated_at: Date }>('SELECT authenticated_at FROM auth_sessions WHERE id = $1', [session.id]);
  expect(Date.now() - row.authenticated_at.getTime()).toBeLessThan(60_000);
  expect(await authEventsFor(account.email, since)).toContainEqual(
    expect.objectContaining({ type: 'reauth.succeeded', reason: 'password', session_id: session.id }),
  );
});

test('AUTH-193 a wrong password in the dialog', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth193', 'Wes Wrong');
  await signedInWithStaffLink(page, account, { stale: true });
  const since = await dbNow();

  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  await dialog.getByLabel('Password').fill('not-the-password-1');
  const refused = page.waitForResponse(isApi('/api/auth/reauth'));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  expect((await refused).status()).toBe(403);
  await expect(dialog.getByRole('alert')).toHaveText('Incorrect password');
  await expect(dialog).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
  await waitForAuthEvent(account.email, since, 'login.failed').then((event) =>
    expect(event).toMatchObject({ reason: 'reauth_wrong_password', user_id: account.userId }),
  );

  // Still signed in: the right password then goes through.
  await dialog.getByLabel('Password').fill(account.password);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();
});

test('AUTH-197 an account with a second factor cannot re-authenticate with a password', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth197', 'Fay Factor');
  const totp = await enrolTotp({ ip: clientIp }, account);
  const since = await dbNow();
  const answer = await post('/api/auth/reauth', { password: account.password }, { ip: newClientIp(), token: totp.accessToken });
  expect(answer.status).toBe(403);
  expect(answer.body.message).toBe('Confirm with your second factor instead.');
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).not.toContain('reauth.succeeded');
});

test('AUTH-199 TOTP re-authentication in the dialog', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth199', 'Tom Totp');
  const totp = await enrolTotp({ ip: clientIp }, account);
  const since = await dbNow();
  // Signed in with a recovery code, so the session has not used the app yet.
  await page.goto('/login');
  await submitLogin(page, account.email, account.password);
  await page.getByRole('button', { name: 'Lost your device? Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(totp.recoveryCodes[0]);
  await page.getByRole('button', { name: 'Use recovery code' }).click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  const [session] = await sessionsSince(account.userId, since);
  expect(session.amr).not.toContain('totp');
  await seedStaffLink(account.userId);
  await makeSignInStale(account.userId);
  await page.reload();

  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(dialog.getByLabel('Password')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Lost your device? Use a recovery code' })).toBeVisible();
  await dialog.getByLabel('Code from your authenticator app').fill(await freshTotpCode(totp));
  const reauthed = page.waitForResponse(isApi('/api/auth/reauth/totp'));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  expect((await reauthed).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();
  const [after] = await sql<{ amr: string[] }>('SELECT amr FROM auth_sessions WHERE id = $1', [session.id]);
  expect(after.amr).toEqual([...session.amr, 'totp']);
});

test('AUTH-202 passkey re-authentication', async ({ page, clientIp }) => {
  const { account, since } = await signedInPasskeyTenant(page, clientIp, 'auth202');
  const [session] = await sessionsSince(account.userId, since);
  expect(session.amr).toEqual(['pwd']);
  await seedStaffLink(account.userId);
  await makeSignInStale(account.userId);
  await page.reload();
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  const usePasskey = dialog.getByRole('button', { name: 'Use passkey' });
  await expect(usePasskey).toBeVisible();
  await expect(dialog.getByLabel('Password')).toHaveCount(0);

  // A dismissed browser prompt.
  await rejectNextCredentialPrompt(page, 'get');
  await usePasskey.click();
  await expect(dialog.getByRole('alert')).toHaveText(PROMPT_CANCELLED);
  await expect(dialog).toBeVisible();

  // An assertion the server cannot verify: the options' challenge changed on the way.
  await rewriteResponses(page, '/api/auth/reauth/passkey/options', (options) => {
    options.challenge = Buffer.from('not-the-challenge-the-api-issued').toString('base64url');
  });
  const refused = page.waitForResponse(isApi('/api/auth/reauth/passkey/verify'));
  await usePasskey.click();
  expect((await refused).status()).toBe(403);
  await expect(dialog.getByRole('alert')).toHaveText(PASSKEY_REFUSED);
  await expect(dialog).toBeVisible();
  await page.unroute('**/api/auth/reauth/passkey/options');

  // The real thing.
  const release = await holdRequests(page, '/api/auth/reauth/passkey/verify');
  const options = page.waitForResponse(isApi('/api/auth/reauth/passkey/options'));
  await usePasskey.click();
  expect((await options).status()).toBe(200);
  await expect(dialog.getByRole('button', { name: 'Waiting for your passkey...' })).toBeDisabled();
  const verified = page.waitForResponse(isApi('/api/auth/reauth/passkey/verify'));
  release();
  expect((await verified).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Link cancelled')).toBeVisible();
  const [after] = await sql<{ amr: string[] }>('SELECT amr FROM auth_sessions WHERE id = $1', [session.id]);
  expect(after.amr).toEqual(['pwd', 'webauthn']);
});

test('AUTH-206 re-authentication counts towards the sign-in limit', async ({ page, clientIp }) => {
  test.setTimeout(5 * 60_000);
  const account = await createAccount(clientIp, 'auth206', 'Lim Limit');
  await signedInWithStaffLink(page, account, { stale: true });
  const since = await dbNow();

  // Ten wrong passwords from this network, five a minute (the route's throttle).
  const answers: Array<[number, string]> = [];
  for (let batch = 0; batch < 2; batch++) {
    if (batch > 0) await sleep(61_000);
    for (let i = 0; i < 5; i++) {
      const wrong = await post('/api/auth/reauth', { password: `wrong-${batch}-${i}` }, { ip: clientIp, token: account.accessToken });
      answers.push([wrong.status, wrong.body.message]);
    }
  }
  expect(answers).toEqual(Array(10).fill([403, 'Incorrect password']));
  await sleep(61_000);

  // The right password, in the dialog, from the same network.
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  await dialog.getByLabel('Password').fill(account.password);
  const limited = page.waitForResponse(isApi('/api/auth/reauth'));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  expect((await limited).status()).toBe(429);
  await expect(dialog.getByRole('alert')).toHaveText(LIMITED);
  await expect(dialog).toBeVisible();
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('login.limited');

  // An authenticator app: ten wrong codes from any networks, then the right one.
  const withTotp = await createAccount(clientIp, 'auth206-totp', 'Lim Totp');
  const totp = await enrolTotp({ ip: clientIp }, withTotp);
  const wrongCode = wrongTotpCode(totp.secret);
  const codes: Array<[number, string]> = [];
  for (const tries of [5, 5]) {
    const ip = newClientIp();
    for (let i = 0; i < tries; i++) {
      const wrong = await post('/api/auth/reauth/totp', { code: wrongCode }, { ip, token: totp.accessToken });
      codes.push([wrong.status, wrong.body.message]);
    }
  }
  expect(codes).toEqual(Array(10).fill([403, CODE_REFUSED]));
  const right = await post('/api/auth/reauth/totp', { code: await freshTotpCode(totp) }, { ip: newClientIp(), token: totp.accessToken });
  expect(right.status).toBe(429);
  expect(right.body.message).toBe(LIMITED);
});

test('AUTH-208 re-authentication is refused in view-as', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'auth208', 'Ivy Impersonated');
  const viewAs = await viewAsToken(page, tenant.userId, newClientIp());
  const routes: Array<[string, unknown]> = [
    ['/api/auth/reauth', { password: tenant.password }],
    ['/api/auth/reauth/totp', { code: '123456' }],
    ['/api/auth/reauth/recovery-code', { code: 'abcd-efgh-ijkl-mnop' }],
    ['/api/auth/reauth/passkey/options', undefined],
    ['/api/auth/reauth/passkey/verify', { response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }],
  ];
  const ip = newClientIp();
  for (const [path, body] of routes) {
    const answer = await post(path, body, { ip, token: viewAs });
    expect([path, answer.status, answer.body.message]).toEqual([path, 403, READ_ONLY]);
  }
});

// ---- /auth/me

test('AUTH-211 the profile shape carries no secrets', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'auth211', 'Pro File');
  const me = await call('GET', '/api/auth/me', undefined, { ip: newClientIp(), token: account.accessToken });
  expect(me.status).toBe(200);
  expect(JSON.parse(me.text)).toEqual({ data: expect.any(Object) });
  expect(me.body).toMatchObject({
    id: account.userId,
    email: account.email,
    name: account.name,
    emailVerifiedAt: expect.any(String),
    isSuperAdmin: false,
    staffLinkPending: false,
    billingEnabled: true,
  });
  for (const secret of ['passwordHash', 'sessionVersion', 'lastFactorSignInAt']) expect(me.body).not.toHaveProperty(secret);
  const stored = await userState(account.userId);
  expect(me.text).not.toContain(stored.password_hash);
});

// ---- Security and miscellany

/** A sign-in answer that gives the access token only: no refresh token in the body, only in the cookie. */
function expectAccessTokenOnly(route: string, answer: RawResponse, tokens: unknown, status = 200) {
  expect([route, answer.status]).toEqual([route, status]);
  expect(answer.text).not.toMatch(/refresh_?token/i);
  expect(Object.keys(tokens as object)).toEqual(['accessToken']);
  const inBody = answer.text.match(JWT) ?? [];
  expect(inBody).toHaveLength(1);
  const cookie = refreshTokenIn(answer.setCookie);
  expect(cookie).not.toBeNull();
  expect(answer.setCookie).toMatch(/HttpOnly/i);
  expect(inBody[0]).not.toBe(cookie);
}

test('AUTH-213 sign-in routes never answer with the refresh token', async ({ page, clientIp }) => {
  // /login, on an account with no second factor.
  const plain = await createAccount(clientIp, 'auth213-plain', 'Pl Ain');
  const login = await passwordStep(plain, newClientIp());
  expectAccessTokenOnly('/login', login, login.body.tokens);

  // /refresh, with the cookie /login set.
  const refreshed = await refreshWith(refreshTokenIn(login.setCookie), newClientIp());
  expectAccessTokenOnly('/refresh', refreshed, refreshed.body);

  // /complete-signup.
  const signup = await mailedSignupLink(newClientIp(), 'auth213-signup', 'New Comer');
  const completed = await post('/api/auth/complete-signup', { token: tokenFromLink(signup.link), password: plain.password }, { ip: newClientIp() });
  expectAccessTokenOnly('/complete-signup', completed, completed.body.tokens, 201);

  // /login/totp and /login/recovery-code.
  const withTotp = await createAccount(clientIp, 'auth213-totp', 'To Tp');
  const totp = await enrolTotp({ ip: clientIp }, withTotp);
  let ip = newClientIp();
  const byTotp = await post('/api/auth/login/totp', { handle: await handleFor(withTotp, ip), code: await freshTotpCode(totp) }, { ip });
  expectAccessTokenOnly('/login/totp', byTotp, byTotp.body.tokens);
  ip = newClientIp();
  const byCode = await post('/api/auth/login/recovery-code', { handle: await handleFor(withTotp, ip), code: totp.recoveryCodes[0] }, { ip });
  expectAccessTokenOnly('/login/recovery-code', byCode, byCode.body.tokens);

  // /login/passkey/verify and /passkey/verify, with this tab's authenticator.
  const { account } = await signedInPasskeyTenant(page, clientIp, 'auth213-passkey');
  ip = newClientIp();
  const handle = await handleFor(account, ip);
  const second = await post('/api/auth/login/passkey/options', { handle }, { ip });
  const bySecond = await post('/api/auth/login/passkey/verify', { handle, response: await assertionInPage(page, second.body) }, { ip });
  expectAccessTokenOnly('/login/passkey/verify', bySecond, bySecond.body.tokens);
  const flow = await post('/api/auth/passkey/options', undefined, { ip });
  const byPasskey = await post(
    '/api/auth/passkey/verify',
    { flowId: flow.body.flowId, response: await assertionInPage(page, flow.body.options) },
    { ip },
  );
  expectAccessTokenOnly('/passkey/verify', byPasskey, byPasskey.body.tokens);
  expect(byPasskey.body.user.id).toBe(account.userId);
});

test('AUTH-214 error responses do not reveal whether an account exists', async ({ clientIp }) => {
  const known = await createAccount(clientIp, 'auth214', 'Kno Wn');
  const unknown = uniqueEmail('auth214-nobody');

  const wrong = await post('/api/auth/login', { email: known.email, password: 'not-the-password-1' }, { ip: newClientIp() });
  const nobody = await post('/api/auth/login', { email: unknown, password: 'not-the-password-1' }, { ip: newClientIp() });
  expect([wrong.status, nobody.status]).toEqual([401, 401]);
  expect(wrong.body.message).toBe('Invalid email or password');
  expect(withoutTimestamp(nobody.text)).toEqual(withoutTimestamp(wrong.text));

  const takenRegister = await post('/api/auth/register', { email: known.email, name: 'Some One' }, { ip: newClientIp() });
  const newRegister = await post('/api/auth/register', { email: unknown, name: 'Some One' }, { ip: newClientIp() });
  expect([takenRegister.status, newRegister.status]).toEqual([202, 202]);
  expect(takenRegister.body).toEqual({ status: 'check_email' });
  expect(newRegister.text).toBe(takenRegister.text);

  const knownForgot = await post('/api/auth/forgot-password', { email: known.email }, { ip: newClientIp() });
  const unknownForgot = await post('/api/auth/forgot-password', { email: uniqueEmail('auth214-other') }, { ip: newClientIp() });
  expect([knownForgot.status, unknownForgot.status]).toEqual([200, 200]);
  expect(knownForgot.body.message).toBe('If that address has an account, a link to reset the password is on its way.');
  expect(unknownForgot.text).toBe(knownForgot.text);
});

// ---- Coverage additions: passkey and TOTP edges

test('AUTH-221 the passkey second-factor limit: options refuses at 10, recovery code too', async ({ page, clientIp }) => {
  const { account, recoveryCodes } = await signedInPasskeyTenant(page, clientIp, 'auth221');
  expect(recoveryCodes).toHaveLength(10);
  await signOutFromMenu(page, account.name);
  const since = await dbNow();
  const handle = await handleFor(account, newClientIp());
  const bogus = { id: 'bogus', rawId: 'bogus', type: 'public-key', response: {} };

  // Nine refused assertions, each on fresh options (both routes take ten a minute per client).
  for (let i = 0; i < 9; i++) {
    const ip = newClientIp();
    const options = await post('/api/auth/login/passkey/options', { handle }, { ip });
    expect(options.status).toBe(200);
    const refused = await post('/api/auth/login/passkey/verify', { handle, response: bogus }, { ip });
    expect([refused.status, refused.body.message]).toEqual([401, PASSKEY_REFUSED]);
  }
  // A verify with no options first finds no challenge, but its attempt is counted first.
  const noChallenge = await post('/api/auth/login/passkey/verify', { handle, response: bogus }, { ip: newClientIp() });
  expect([noChallenge.status, noChallenge.body.message]).toEqual([401, FLOW_EXPIRED]);
  const failures = (await authEventsFor(account.email, since)).filter((e) => e.type === 'login.failed');
  expect(failures).toHaveLength(9);
  expect(failures.every((e) => e.reason === 'passkey_failed')).toBe(true);

  const limited = await post('/api/auth/login/passkey/options', { handle }, { ip: newClientIp() });
  expect([limited.status, limited.body.message]).toEqual([429, LIMITED]);
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('login.limited');

  // In the app: the password step still works, then "Use passkey" is refused before any prompt.
  const verifies: string[] = [];
  page.on('request', (request) => {
    if (pathOf(request) === '/api/auth/login/passkey/verify') verifies.push(request.url());
  });
  const step = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  expect((await step).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  const options = page.waitForResponse(isApi('/api/auth/login/passkey/options'));
  await page.getByRole('button', { name: 'Use passkey' }).click();
  expect((await options).status()).toBe(429);
  await expect(page.getByRole('alert')).toHaveText(LIMITED);
  expect(verifies).toEqual([]);

  await page.getByRole('button', { name: 'Lost your device? Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(recoveryCodes[0]);
  const byCode = page.waitForResponse(isApi('/api/auth/login/recovery-code'));
  await page.getByRole('button', { name: 'Use recovery code' }).click();
  expect((await byCode).status()).toBe(429);
  await expect(page.getByRole('alert')).toHaveText(LIMITED);
  expect(await unusedRecoveryCodes(account.userId)).toBe(10);
});

test("AUTH-222 a super admin's customer passkey without user verification is refused", async ({ page, clientIp }) => {
  const { account, authenticator } = await signedInPasskeyTenant(page, clientIp, 'auth222');
  await makeSuperAdmin(account.userId);
  await signOutFromMenu(page, account.name);
  const [before] = await customerPasskeyRows(account.userId);
  await authenticator.setUserVerified(false);
  const since = await dbNow();
  const verifies: string[] = [];
  page.on('request', (request) => {
    if (pathOf(request) === '/api/auth/login/passkey/verify') verifies.push(request.url());
  });

  // Untouched options require user verification, which this authenticator cannot give.
  const step = page.waitForResponse(isApi('/api/auth/login'));
  await submitLogin(page, account.email, account.password);
  expect(((await (await step).json()) as { data: { methods: string[] } }).data.methods).toEqual(['webauthn']);
  const usePasskey = page.getByRole('button', { name: 'Use passkey' });
  const offered = page.waitForResponse(isApi('/api/auth/login/passkey/options'));
  await usePasskey.click();
  expect(((await (await offered).json()) as { data: { userVerification: string } }).data.userVerification).toBe('required');
  await expect(page.getByRole('alert')).toHaveText(PROMPT_CANCELLED);
  expect(verifies).toEqual([]);

  // A client that downgrades the request (to "discouraged": Chromium still tries a
  // capable authenticator's verification on "preferred"): the server still requires it of staff.
  await rewriteResponses(page, '/api/auth/login/passkey/options', (options) => {
    options.userVerification = 'discouraged';
  });
  const refused = page.waitForResponse(isApi('/api/auth/login/passkey/verify'));
  await usePasskey.click();
  const refusedAnswer = await refused;
  expect(refusedAnswer.status()).toBe(401);
  expect(((await refusedAnswer.json()) as { message: string }).message).toBe(PASSKEY_REFUSED);
  await expect(page.getByRole('alert')).toHaveText(PASSKEY_REFUSED);
  expect(await authEventsFor(account.email, since)).toContainEqual(
    expect.objectContaining({ type: 'login.failed', reason: 'passkey_failed' }),
  );
  expect(await customerPasskeyRows(account.userId)).toEqual([before]);
  await page.unroute('**/api/auth/login/passkey/options');

  // Signed in with verification, then the same downgrade on re-authentication.
  await authenticator.setUserVerified(true);
  await usePasskey.click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await seedStaffLink(account.userId);
  await makeSignInStale(account.userId);
  await page.reload();
  const [signedIn] = await customerPasskeyRows(account.userId);
  await authenticator.setUserVerified(false);
  await rewriteResponses(page, '/api/auth/reauth/passkey/options', (options) => {
    options.userVerification = 'discouraged';
  });
  const reauthSince = await dbNow();
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  const reauthRefused = page.waitForResponse(isApi('/api/auth/reauth/passkey/verify'));
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  expect((await reauthRefused).status()).toBe(403);
  await expect(dialog.getByRole('alert')).toHaveText(PASSKEY_REFUSED);
  await expect(dialog).toBeVisible();
  expect(await authEventsFor(account.email, reauthSince)).toContainEqual(
    expect.objectContaining({ type: 'passkey.failed', reason: 'reauth' }),
  );
  expect(await customerPasskeyRows(account.userId)).toEqual([signedIn]);
});

test('AUTH-224 a passkey whose signature counter did not advance is refused everywhere', async ({ page, clientIp }) => {
  const { account, authenticator, recoveryCodes } = await signedInPasskeyTenant(page, clientIp, 'auth224');
  await signOutFromMenu(page, account.name);
  await signInWithTenantPasskey(page);
  await signOutFromMenu(page, account.name);
  const [row] = await customerPasskeyRows(account.userId);
  await sql(`UPDATE webauthn_credentials SET counter = '1000000' WHERE id = $1`, [row.id]);
  const [raised] = await customerPasskeyRows(account.userId);
  expect(raised.counter).toBe('1000000');
  const since = await dbNow();

  // Passwordless.
  const passwordless = page.waitForResponse(isApi('/api/auth/passkey/verify'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  expect((await passwordless).status()).toBe(401);
  await expect(formMessage(page, PASSKEY_REFUSED)).toBeVisible();
  expect((await authEventsFor(account.email, since)).map((e) => e.type)).toContain('passkey.failed');

  // As the second factor.
  await submitLogin(page, account.email, account.password);
  const secondFactor = page.waitForResponse(isApi('/api/auth/login/passkey/verify'));
  await page.getByRole('button', { name: 'Use passkey' }).click();
  expect((await secondFactor).status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(PASSKEY_REFUSED);
  expect(await authEventsFor(account.email, since)).toContainEqual(
    expect.objectContaining({ type: 'login.failed', reason: 'passkey_failed' }),
  );

  // Signed in with a recovery code instead, then re-authenticating with the passkey.
  await page.getByRole('button', { name: 'Lost your device? Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(recoveryCodes[0]);
  await page.getByRole('button', { name: 'Use recovery code' }).click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await seedStaffLink(account.userId);
  await makeSignInStale(account.userId);
  await page.reload();
  const reauthSince = await dbNow();
  await bannerCancel(page).click();
  const dialog = reauthDialog(page);
  const reauth = page.waitForResponse(isApi('/api/auth/reauth/passkey/verify'));
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  expect((await reauth).status()).toBe(403);
  await expect(dialog.getByRole('alert')).toHaveText(PASSKEY_REFUSED);
  expect(await authEventsFor(account.email, reauthSince)).toContainEqual(
    expect.objectContaining({ type: 'passkey.failed', reason: 'reauth' }),
  );
  expect(await customerPasskeyRows(account.userId)).toEqual([raised]);

  // With the stored counter back at 0, the same passkey signs in and the counter moves.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await signOutFromMenu(page, account.name);
  await sql(`UPDATE webauthn_credentials SET counter = '0' WHERE id = $1`, [row.id]);
  await signInWithTenantPasskey(page);
  const [after] = await customerPasskeyRows(account.userId);
  const [held] = await authenticator.credentials();
  expect(after.counter).toBe(String(held.signCount));
  expect(after.last_used_at!.getTime()).toBeGreaterThan(raised.last_used_at!.getTime());
});

// ---- Coverage additions: session lapse

test('AUTH-237 the session limit reached mid-session through the response interceptor', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'auth237', 'Mid Session');
  const project = await createProject(account, clientIp, `AUTH-237 ${Date.now()}`);
  const since = await dbNow();
  await signIn(page, account);
  expect(await page.evaluate(() => localStorage.getItem('chumbaq_session_limit'))).not.toBeNull();
  const [session] = await sessionsSince(account.userId, since);
  await sql(`UPDATE auth_sessions SET created_at = now() - interval '31 days' WHERE id = $1`, [session.id]);
  const refreshes = await captureResponses(page, '/api/auth/refresh');
  // The next project request fails as an expired access token would, once.
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
  await expect(page).toHaveURL(/\/login\?sessionLimit=30-day$/);
  await expect(
    page.getByText('You were signed out because your session reached its 30-day limit. Sign in again to continue.', { exact: true }),
  ).toBeVisible();
  expect(refused).toBe(true);
  expect(refreshes.map((r) => [r.status, r.json?.message])).toEqual([[401, 'Session reached its maximum length']]);
  const [row] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [session.id]);
  expect(row.revoked_at).not.toBeNull();
  expect(await authEventsFor(account.email, since)).toContainEqual(
    expect.objectContaining({ type: 'refresh.failed', reason: 'session_expired' }),
  );
  expect(
    await page.evaluate(() => [localStorage.getItem('chumbaq_signed_in'), localStorage.getItem('chumbaq_session_limit')]),
  ).toEqual([null, null]);
});

// ---- Coverage additions: resets

/** Staff session, view-as codes (one spent, one not) and an operator enrolment code for `staff`. */
async function staffState(staff: Account, staffToken: string, tenant: Account, ip: string) {
  const startViewAs = () =>
    adminApi<{ url: string }>('POST', `/api/admin/tenants/${tenant.userId}/impersonate`, { reason: 'E2E: checking a reset ends view-as' }, staffToken, ip);
  const spent = await startViewAs();
  await api('POST', '/api/auth/impersonation/exchange', { code: new URL(spent.url).hash.replace(/^#code=/, '') }, { ip: newClientIp() });
  await startViewAs();
  await sql(
    `INSERT INTO staff_enrolment_allowances (user_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '24 hours')`,
    [staff.userId, createHash('sha256').update(randomBytes(32)).digest('hex')],
  );
  const handoffs = await sql<{ id: string; used_at: Date | null }>(
    `SELECT id, used_at FROM impersonation_handoffs WHERE staff_session_id = $1 ORDER BY created_at`,
    [String(jwtClaimsOf(staffToken).sid)],
  );
  expect(handoffs.map((h) => h.used_at !== null)).toEqual([true, false]);
  return handoffs;
}

async function expectStaffStateEnded(staff: Account, staffToken: string, handoffs: Array<{ id: string; used_at: Date | null }>, svBefore: number) {
  const sid = String(jwtClaimsOf(staffToken).sid);
  const sessions = await sql<{ revoked_at: Date | null; revoked_reason: string | null }>(
    'SELECT revoked_at, revoked_reason FROM staff_sessions WHERE id = $1',
    [sid],
  );
  expect(sessions).toEqual([{ revoked_at: expect.any(Date), revoked_reason: 'password_reset' }]);
  const left = await sql<{ id: string }>('SELECT id FROM impersonation_handoffs WHERE staff_session_id = $1 ORDER BY created_at', [sid]);
  // The spent code stays as the record; the unused one is gone.
  expect(left.map((h) => h.id)).toEqual([handoffs[0].id]);
  const allowances = await sql<{ voided_at: Date | null; voided_reason: string | null }>(
    'SELECT voided_at, voided_reason FROM staff_enrolment_allowances WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [staff.userId],
  );
  expect(allowances).toEqual([{ voided_at: expect.any(Date), voided_reason: 'password_reset' }]);
  const live = await sql('SELECT id FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL', [staff.userId]);
  expect(live).toEqual([]);
  expect((await userState(staff.userId)).session_version).toBeGreaterThan(svBefore);

  const response = await fetch(`${process.env.E2E_ADMIN_API_URL}/api/admin/tenants`, {
    headers: { Authorization: `Bearer ${staffToken}`, 'X-Forwarded-For': newClientIp() },
  });
  expect(response.status).toBe(401);
}

test("AUTH-255 a super admin's password reset ends staff sessions, view-as codes and enrolment codes", async ({ page, clientIp }) => {
  const staff = await createAccount(clientIp, 'auth255', 'Sam Staff');
  await makeSuperAdmin(staff.userId);
  const tenant = await createAccount(clientIp, 'auth255-tenant', 'Ten Ant');
  const since = await dbNow();

  // An emailed reset link.
  const staffToken = await enrolAndSignInStaff(page, staff);
  const handoffs = await staffState(staff, staffToken, tenant, clientIp);
  const svBefore = (await userState(staff.userId)).session_version;
  const reset = await post('/api/auth/reset-password', { token: await seedResetToken(staff.userId), newPassword: NEW_PASSWORD }, { ip: newClientIp() });
  expect(reset.status).toBe(200);
  await expectStaffStateEnded(staff, staffToken, handoffs, svBefore);

  // A staff-issued link, once usable: the same.
  await page.goto(adminUrl('/sign-in'));
  const [verified] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/staff/auth/passkey/verify')),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  expect(verified.ok()).toBe(true);
  const secondToken = ((await verified.json()) as { data: { accessToken: string } }).data.accessToken;
  const secondHandoffs = await staffState(staff, secondToken, tenant, clientIp);
  const svSecond = (await userState(staff.userId)).session_version;
  const staffLink = await seedAccountToken(staff.userId, { staffIssued: true, usableIn: '-1 minute', expiresIn: '24 hours' });
  const viaLink = await post('/api/auth/reset-password', { token: staffLink, newPassword: `${NEW_PASSWORD}x` }, { ip: newClientIp() });
  expect(viaLink.status).toBe(200);
  await expectStaffStateEnded(staff, secondToken, secondHandoffs, svSecond);
  const resets = (await authEventsFor(staff.email, since)).filter((e) => e.type === 'password.reset');
  expect(resets.map((e) => e.reason)).toEqual([null, 'staff_link']);
});

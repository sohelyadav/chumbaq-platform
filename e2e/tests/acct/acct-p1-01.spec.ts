import type { Page } from '@playwright/test';
import { createAccount, createProject, newClientIp, PASSWORD } from '../../support/api';
import { adminUrl, enrolAndSignInStaff } from '../../support/admin';
import { downloadFrom } from '../../support/browser-tools';
import {
  addAuthenticator,
  confirmIfAsked,
  enrolTenantPasskey,
  enrolTotp,
  nextTotpCode,
  recoveryCodeItems,
  settingsCard,
  totpCode,
  totpSetupKey,
  totpSetupQr,
  type TotpEnrolment,
} from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { waitForMail } from '../../support/mailbox';
import {
  accountTokenUsedAt,
  ageSignIns,
  auditRowsFor,
  authEvents,
  call,
  dbNow,
  freshTotpCode,
  jwtClaims,
  makeSuperAdmin,
  makeTeamManaged,
  managedByTeam,
  pageAccessToken,
  passwordField,
  reauthWithPasskey,
  reauthWithPassword,
  recordBlobTypes,
  recordResponses,
  recoveryCodeRows,
  seedStaffResetLink,
  sql,
  toastTitled,
  totpRow,
  userRow,
} from '../../support/areas/acct';

/**
 * Account settings, P1: the page itself, the profile, change password (form rules, API
 * rules and its side effects), the re-authentication gate, the authenticator app and
 * recovery codes.
 */

const REAUTH = 'Confirm it is you to continue.';
const STAFF_MANAGE = 'Manage staff sign-in in the admin app.';
const CODE_REFUSED = 'That code is not right. Please try again.';
const NEW_PASSWORD = 'New-Passw0rd!';
const TOO_SHORT = 'Password must be at least 8 characters';
const TOO_LONG =
  'Password is too long: use at most 72 bytes (about 72 letters or digits; some symbols and non-English letters count as more)';
const CARD_ORDER = ['Profile Details', 'Change Password', 'Authenticator app', 'Passkeys', "Where you're signed in", 'Recent security activity'];

const confirmDialog = (page: Page) => page.getByRole('dialog', { name: 'Confirm it is you' });
const pathIs = (path: string) => (r: { url(): string }) => new URL(r.url()).pathname === path;

/** Every request the page sends to `method path`, from now on. */
function recordRequests(page: Page, method: string, path: string): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.method() === method && new URL(request.url()).pathname === path) seen.push(request.url());
  });
  return seen;
}

async function fillPasswordForm(page: Page, values: { current: string; next: string; confirm: string }): Promise<void> {
  await passwordField(page, 'currentPassword').fill(values.current);
  await passwordField(page, 'newPassword').fill(values.next);
  await passwordField(page, 'confirmPassword').fill(values.confirm);
}

/** Opens the authenticator setup on /settings, answering "Confirm it is you" with the password if asked. */
async function openTotpSetup(page: Page, password: string): Promise<string> {
  const card = settingsCard(page, 'Authenticator app');
  await card.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await confirmIfAsked(page, password, totpSetupKey(card));
  return ((await totpSetupKey(card).textContent()) ?? '').trim();
}

/** A six-digit code none of the steps the API takes for `secret` right now would accept. */
function wrongCodeFor(secret: string): string {
  const valid = new Set([-1, 0, 1].map((offset) => totpCode(secret, offset)));
  return ['000000', '111111', '222222'].find((code) => !valid.has(code))!;
}

// ---- A. Page access

test('ACCT-001 settings page renders for a tenant', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct001', 'Ada Settings');
  await signIn(page, account);
  const reads = ['/api/auth/factors', '/api/auth/passkeys', '/api/auth/sessions', '/api/auth/activity', '/api/auth/factor-reset'].map(
    (path) => page.waitForResponse((r) => r.request().method() === 'GET' && pathIs(path)(r)),
  );
  await page.goto('/settings');
  for (const response of await Promise.all(reads)) expect(response.status(), new URL(response.url()).pathname).toBe(200);

  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  await expect(page.getByText('Manage your personal profile and security preferences.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="card-title"]')).toHaveText(CARD_ORDER);
  await expect(settingsCard(page, 'Profile Details').locator('[data-slot="card-description"]')).toHaveText('Your personal information');
  await expect(settingsCard(page, 'Change Password').locator('[data-slot="card-description"]')).toHaveText('Update your login password here.');
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'Support will remove' })).toHaveCount(0);

  // MinimalLayout: the logo and the account button in the header, no project sidebar.
  const header = page.locator('header');
  await expect(header.getByText('Chumbaq', { exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: /Ada Settings/ })).toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
});

test('ACCT-003 a reload keeps the settings page', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'acct003');
  await signIn(page, account);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();

  const refreshes = recordResponses(page, 'POST', '/api/auth/refresh');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  await expect(page).toHaveURL(`${baseURL}/settings`);
  expect(refreshes.map((r) => r.status())).toEqual([200]);
  const devices = settingsCard(page, "Where you're signed in").getByRole('listitem');
  await expect(devices.first()).toBeVisible();
  await expect(devices.filter({ hasText: 'This device' })).toHaveCount(1);
});

// ---- B. Profile details

test('ACCT-008 the profile shows name and email read-only', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct008', 'Petra Profile');
  await signIn(page, account);
  await page.goto('/settings');
  const card = settingsCard(page, 'Profile Details');
  const inputs = card.locator('input');
  await expect(inputs).toHaveCount(2);
  await expect(inputs.nth(0)).toHaveValue('Petra Profile');
  await expect(inputs.nth(0)).toBeDisabled();
  await expect(inputs.nth(1)).toHaveValue(account.email);
  await expect(inputs.nth(1)).toBeDisabled();
  await expect(card.getByText('To change your email or name, please contact support.', { exact: true })).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
});

test('ACCT-009 a profile name with markup shows as text', async ({ page, clientIp }) => {
  const name = '<img src=x onerror=alert(1)>';
  const account = await createAccount(clientIp, 'acct009', name);
  const project = await createProject(account, clientIp);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await signIn(page, account);
  await page.goto('/settings');
  await expect(settingsCard(page, 'Profile Details').locator('input').first()).toHaveValue(name);
  const headerButton = page.locator('header').getByRole('button', { name: /onerror/ });
  await expect(headerButton).toContainText(name);
  await expect(headerButton.locator('div').first()).toHaveText('<');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);

  await page.goto(`/projects/${project.id}`);
  const trigger = page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: /onerror/ });
  await expect(trigger).toContainText(name);
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText(name, { exact: true })).toBeVisible();
  await expect(menu.getByText('<', { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// ---- C. Change password

test('ACCT-013 Back after a password change does not restore the session', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'acct013');
  await signIn(page, account);
  await page.goto('/settings');
  await fillPasswordForm(page, { current: PASSWORD, next: NEW_PASSWORD, confirm: NEW_PASSWORD });
  await page.getByRole('button', { name: 'Update Password' }).click();
  await page.waitForURL(`${baseURL}/login?passwordChanged=1`);

  const sessionReads = recordResponses(page, 'GET', '/api/auth/sessions');
  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}/login`);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toHaveCount(0);
  expect(sessionReads.filter((r) => r.ok())).toEqual([]);
  // Whatever cookie the browser still holds is refused.
  const refresh = await page.request.post('/api/auth/refresh', { headers: { 'X-Chumbaq-Client': 'web' }, data: {} });
  expect(refresh.status()).toBe(401);
});

test('ACCT-014 the current password is required', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct014');
  await signIn(page, account);
  await page.goto('/settings');
  const patches = recordRequests(page, 'PATCH', '/api/users/me/password');
  await fillPasswordForm(page, { current: '', next: NEW_PASSWORD, confirm: NEW_PASSWORD });
  await page.getByRole('button', { name: 'Update Password' }).click();
  await expect(settingsCard(page, 'Change Password').getByText('Current password is required', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update Password' })).toBeEnabled();
  expect(patches).toEqual([]);
});

test('ACCT-015 a new password under 8 characters is refused in the form', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct015');
  await signIn(page, account);
  await page.goto('/settings');
  const patches = recordRequests(page, 'PATCH', '/api/users/me/password');
  await fillPasswordForm(page, { current: PASSWORD, next: 'short7!', confirm: 'short7!' });
  await page.getByRole('button', { name: 'Update Password' }).click();
  await expect(settingsCard(page, 'Change Password').getByText(TOO_SHORT, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update Password' })).toBeEnabled();
  expect(patches).toEqual([]);
});

test('ACCT-016 a new password over 72 bytes is refused in the form', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct016');
  await signIn(page, account);
  await page.goto('/settings');
  const patches = recordRequests(page, 'PATCH', '/api/users/me/password');
  const card = settingsCard(page, 'Change Password');
  // 37 characters, 74 bytes; then 19 code points, 76 bytes.
  for (const tooLong of ['é'.repeat(37), '😀'.repeat(19)]) {
    await fillPasswordForm(page, { current: PASSWORD, next: tooLong, confirm: tooLong });
    await page.getByRole('button', { name: 'Update Password' }).click();
    await expect(card.getByText(TOO_LONG, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update Password' })).toBeEnabled();
  }
  expect(patches).toEqual([]);
});

test('ACCT-017 the confirmation is required and must match', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct017');
  await signIn(page, account);
  await page.goto('/settings');
  const patches = recordRequests(page, 'PATCH', '/api/users/me/password');
  const card = settingsCard(page, 'Change Password');

  await fillPasswordForm(page, { current: PASSWORD, next: NEW_PASSWORD, confirm: '' });
  await page.getByRole('button', { name: 'Update Password' }).click();
  await expect(card.getByText('Please confirm your new password', { exact: true })).toBeVisible();

  await passwordField(page, 'confirmPassword').fill('Different-Passw0rd!');
  await page.getByRole('button', { name: 'Update Password' }).click();
  const mismatch = card.getByText("Passwords don't match", { exact: true });
  await expect(mismatch).toBeVisible();
  // Under Confirm New Password: the message follows that field.
  await expect(passwordField(page, 'confirmPassword').locator('xpath=following-sibling::p[1]')).toHaveText("Passwords don't match");
  await expect(card.getByText('Please confirm your new password', { exact: true })).toHaveCount(0);
  expect(patches).toEqual([]);
});

test('ACCT-018 boundary passwords are accepted by the API', async ({ clientIp }) => {
  for (const newPassword of ['Abcdef1!', 'é'.repeat(36)]) {
    const account = await createAccount(clientIp, 'acct018');
    const changed = await call('PATCH', '/api/users/me/password', { currentPassword: PASSWORD, newPassword }, { ip: clientIp, token: account.accessToken });
    expect(changed.status, `${Buffer.byteLength(newPassword)} bytes`).toBe(200);
    expect(changed.body).toEqual({ message: 'Password updated successfully' });
    const login = await call('POST', '/api/auth/login', { email: account.email, password: newPassword }, { ip: newClientIp() });
    expect(login.status).toBe(200);
    const old = await call('POST', '/api/auth/login', { email: account.email, password: PASSWORD }, { ip: newClientIp() });
    expect(old.status).toBe(401);
  }
});

test('ACCT-019 the API refuses invalid new passwords', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct019');
  const before = await userRow(account.userId);
  const since = await dbNow();
  const tooLong = 'a'.repeat(71) + 'é';
  expect(Buffer.byteLength(tooLong)).toBe(73);
  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    { body: { currentPassword: PASSWORD, newPassword: 'short7!' }, message: TOO_SHORT },
    { body: { currentPassword: PASSWORD, newPassword: tooLong }, message: TOO_LONG },
    { body: { currentPassword: PASSWORD }, message: 'newPassword must be a string' },
  ];
  for (const { body, message } of cases) {
    const answer = await call('PATCH', '/api/users/me/password', body, { ip: clientIp, token: account.accessToken });
    expect(answer.status, JSON.stringify(body)).toBe(400);
    expect(answer.message).toContain(message);
  }
  const after = await userRow(account.userId);
  expect(after.password_hash).toBe(before.password_hash);
  expect(after.session_version).toBe(before.session_version);
  expect(await authEvents(account.userId, since, 'password.changed')).toEqual([]);

  // Code wins over the case: the global ValidationPipe converts implicitly, so the JSON
  // number 12345678 arrives as the string "12345678", a valid new password.
  const numeric = await call('PATCH', '/api/users/me/password', { currentPassword: PASSWORD, newPassword: 12345678 }, { ip: clientIp, token: account.accessToken });
  expect(numeric.status).toBe(200);
  const login = await call('POST', '/api/auth/login', { email: account.email, password: '12345678' }, { ip: newClientIp() });
  expect(login.status).toBe(200);
});

test('ACCT-026 a password change clears the team-managed flag', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct026');
  await makeTeamManaged(account.userId);
  const factors = page.waitForResponse(pathIs('/api/auth/factors'));
  await signIn(page, account);
  await page.goto('/settings');
  expect(((await (await factors).json()) as { data: { canEnrolTotp: boolean } }).data.canEnrolTotp).toBe(false);
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  await expect(settingsCard(page, "Where you're signed in")).toBeVisible();
  await expect(settingsCard(page, 'Authenticator app')).toHaveCount(0);
  await expect(settingsCard(page, 'Passkeys')).toHaveCount(0);

  await fillPasswordForm(page, { current: PASSWORD, next: NEW_PASSWORD, confirm: NEW_PASSWORD });
  await page.getByRole('button', { name: 'Update Password' }).click();
  await page.waitForURL('**/login?passwordChanged=1');
  expect(await managedByTeam(account.userId)).toBeNull();

  await signIn(page, { email: account.email, password: NEW_PASSWORD });
  await page.goto('/settings');
  await expect(settingsCard(page, 'Authenticator app').getByRole('button', { name: 'Set up an authenticator app' })).toBeVisible();
  const passkeys = settingsCard(page, 'Passkeys');
  await expect(passkeys.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(passkeys.getByRole('button', { name: 'Add a passkey' })).toBeVisible();
});

test('ACCT-027 a password change voids a pending staff-issued reset link', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct027');
  const linkId = await seedStaffResetLink(account.userId);
  expect(await accountTokenUsedAt(linkId)).toBeNull();
  const since = await dbNow();

  const changed = await call('PATCH', '/api/users/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { ip: clientIp, token: account.accessToken });
  expect(changed.status).toBe(200);
  expect(changed.body).toEqual({ message: 'Password updated successfully' });

  expect(await accountTokenUsedAt(linkId)).not.toBeNull();
  const audits = await auditRowsFor(account.userId, 'account.password_reset_link_cancelled');
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor_id: null,
    actor_email: 'system',
    metadata: { tokenId: linkId, reason: 'owner_signed_in', via: 'password' },
  });
  await waitForMail(account.email, { subjectIncludes: 'The password reset link support issued was cancelled', since });
});

test('ACCT-028 a super admin password change also ends staff sessions', async ({ page, clientIp, browser, baseURL }) => {
  const account = await createAccount(clientIp, 'acct028', 'Sam Staff');
  await makeSuperAdmin(account.userId);
  await signIn(page, account);
  const admin = await newPersonContext(browser, baseURL);
  const adminPage = await admin.context.newPage();
  try {
    await enrolAndSignInStaff(adminPage, account);
    await expect(adminPage.getByRole('link', { name: 'Tenants' })).toBeVisible();

    await page.goto('/settings');
    await fillPasswordForm(page, { current: PASSWORD, next: NEW_PASSWORD, confirm: NEW_PASSWORD });
    await page.getByRole('button', { name: 'Update Password' }).click();
    await page.waitForURL(`${baseURL}/login?passwordChanged=1`);

    await adminPage.getByRole('link', { name: 'Tenants' }).click();
    await adminPage.waitForURL((url) => url.pathname === '/sign-in');
    expect(adminPage.url().startsWith(adminUrl('/sign-in'))).toBe(true);
    await expect(adminPage.getByText('Your staff session has ended. Sign in again.', { exact: true })).toBeVisible();
  } finally {
    await admin.context.close();
  }
});

// ---- D. The re-authentication gate

test('ACCT-030 cancelling the confirmation changes nothing', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct030');
  await signIn(page, account);
  await page.goto('/settings');
  const card = settingsCard(page, 'Authenticator app');
  const setups = recordResponses(page, 'POST', '/api/auth/totp/setup');
  await card.getByRole('button', { name: 'Set up an authenticator app' }).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  const toast = toastTitled(page, 'Nothing was changed');
  await expect(toast).toContainText(REAUTH);
  await expect(toast).toHaveClass(/destructive/);
  await expect(card.getByRole('button', { name: 'Set up an authenticator app' })).toBeVisible();
  await expect(totpSetupKey(card)).toHaveCount(0);
  expect(setups.map((r) => r.status())).toEqual([403]);
  expect(await totpRow(account.userId)).toEqual([]);
});

test('ACCT-034 a sign-in older than 15 minutes is refused before the proof', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct034');
  await signIn(page, account);
  await page.goto('/settings');
  const proven = await reauthWithPassword(await pageAccessToken(page, clientIp), account.password, clientIp);
  // Control: with the proof and a recent sign-in, the options are given.
  expect((await call('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token: proven })).status).toBe(200);

  await ageSignIns(account.userId);
  const stale = await pageAccessToken(page, clientIp);
  expect(Date.now() / 1000 - Number(jwtClaims(stale).auth_time)).toBeGreaterThan(15 * 60);
  const refused = await call('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token: stale });
  expect(refused.status).toBe(403);
  expect(refused.message).toBe(REAUTH);

  // The proof was never touched: bring the sign-in time back and the same session is let through
  // without confirming again.
  await sql(`UPDATE auth_sessions SET authenticated_at = now() WHERE user_id = $1`, [account.userId]);
  const recent = await pageAccessToken(page, clientIp);
  expect((await call('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token: recent })).status).toBe(200);
});

// ---- E. Authenticator app

test('ACCT-037 the authenticator card when it is available', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct037');
  await signIn(page, account);
  const factors = page.waitForResponse(pathIs('/api/auth/factors'));
  await page.goto('/settings');
  expect(((await (await factors).json()) as { data: unknown }).data).toEqual({
    canEnrolTotp: true,
    totpEnabled: false,
    recoveryCodesRemaining: 0,
    canManageRecoveryCodes: false,
    methods: [],
  });
  const card = settingsCard(page, 'Authenticator app');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    'Ask for a code from an app such as 1Password or Google Authenticator each time you sign in, so your password alone is not enough.',
  );
  await expect(card.getByRole('button', { name: 'Set up an authenticator app' })).toBeEnabled();
  await expect(card.getByText('On.', { exact: true })).toHaveCount(0);
});

test('ACCT-042 a wrong code keeps the setup open', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct042');
  await signIn(page, account);
  await page.goto('/settings');
  const secret = await openTotpSetup(page, account.password);
  const card = settingsCard(page, 'Authenticator app');
  const confirms = recordResponses(page, 'POST', '/api/auth/totp/confirm');
  const field = card.getByLabel('Code from your authenticator app');

  await field.fill(wrongCodeFor(secret));
  await card.getByRole('button', { name: 'Turn on' }).click();
  const toast = toastTitled(page, 'Nothing was changed');
  await expect(toast).toContainText(CODE_REFUSED);
  await expect(field).toHaveValue('');
  await expect(totpSetupQr(card)).toBeVisible();
  await expect(totpSetupKey(card)).toHaveText(secret);
  await expect(confirmDialog(page)).toHaveCount(0);

  await field.fill(nextTotpCode({ secret, recoveryCodes: [], lastStep: -1 }));
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(recoveryCodeItems(card)).toHaveCount(10);
  await expect(confirmDialog(page)).toHaveCount(0);
  // No 403 between them: the proof outlived the mistyped code.
  expect(confirms.map((r) => r.status())).toEqual([400, 200]);
  expect((await totpRow(account.userId))[0].confirmed_at).not.toBeNull();
});

test('ACCT-045 starting setup again replaces the key', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct045');
  await signIn(page, account);
  await page.goto('/settings');
  const setups = recordResponses(page, 'POST', '/api/auth/totp/setup');
  const first = await openTotpSetup(page, account.password);
  const card = settingsCard(page, 'Authenticator app');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByRole('button', { name: 'Set up an authenticator app' })).toBeVisible();

  const second = await openTotpSetup(page, account.password);
  expect(second).toMatch(/^[A-Z2-7]{32}$/);
  expect(second).not.toBe(first);
  expect(setups.map((r) => r.status())).toEqual([403, 200, 200]);

  const field = card.getByLabel('Code from your authenticator app');
  const fromFirst = totpCode(first);
  // Not also one the second key would take, by chance.
  test.skip([-1, 0, 1].some((offset) => totpCode(second, offset) === fromFirst), 'the two keys gave the same code this step');
  await field.fill(fromFirst);
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(toastTitled(page, 'Nothing was changed')).toContainText(CODE_REFUSED);
  await expect(totpSetupKey(card)).toHaveText(second);

  await field.fill(nextTotpCode({ secret: second, recoveryCodes: [], lastStep: -1 }));
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(recoveryCodeItems(card)).toHaveCount(10);
  expect((await totpRow(account.userId))[0].confirmed_at).not.toBeNull();
});

test('ACCT-047 setup is refused when an app is already on', async ({ clientIp }) => {
  test.slow();
  const account = await createAccount(clientIp, 'acct047');
  const totp = await enrolTotp({ ip: clientIp }, account);
  const [before] = await totpRow(account.userId);
  const reauthed = await call<{ accessToken: string }>('POST', '/api/auth/reauth/totp', { code: nextTotpCode(totp) }, { ip: clientIp, token: totp.accessToken });
  expect(reauthed.status).toBe(200);

  const setup = await call('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token: reauthed.body.accessToken });
  expect(setup.status).toBe(409);
  expect(setup.message).toBe('This account already has an authenticator app.');
  const [after] = await totpRow(account.userId);
  expect(after.secret_ciphertext).toBe(before.secret_ciphertext);
  expect(after.confirmed_at).toEqual(before.confirmed_at);

  // Sign-in codes from the same app still work.
  const ip = newClientIp();
  const first = await call<{ handle: string }>('POST', '/api/auth/login', { email: account.email, password: account.password }, { ip });
  expect(first.status).toBe(200);
  const signedIn = await call('POST', '/api/auth/login/totp', { handle: first.body.handle, code: await freshTotpCode(totp) }, { ip });
  expect(signedIn.status).toBe(200);
});

test('ACCT-051 remove the authenticator app with a recovery code', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct051');
  await signIn(page, account);
  const totp = await enrolTotp(page, account);
  const since = await dbNow();
  const card = settingsCard(page, 'Authenticator app');
  const deletes = recordResponses(page, 'DELETE', '/api/auth/totp');

  await card.getByRole('button', { name: 'Remove authenticator app' }).click();
  const dialog = confirmDialog(page);
  await dialog.getByRole('button', { name: 'Lost your device? Use a recovery code' }).click();
  await dialog.getByLabel('Recovery code').fill(totp.recoveryCodes[0]);
  await dialog.getByRole('button', { name: 'Use recovery code' }).click();
  await expect(dialog).toBeHidden();

  await expect(toastTitled(page, 'Authenticator app removed')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Set up an authenticator app' })).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);
  expect(deletes.map((r) => r.status())).toEqual([403, 204]);
  expect(await totpRow(account.userId)).toEqual([]);
  expect(await recoveryCodeRows(account.userId)).toEqual([]);
  expect((await authEvents(account.userId, since, 'recovery_code.used')).length).toBe(1);
  expect((await authEvents(account.userId, since, 'totp.disabled')).length).toBe(1);

  await page.reload();
  await expect(settingsCard(page, 'Recent security activity').locator('p', { hasText: 'Recovery code used' })).toHaveCount(1);
});

test('ACCT-052 removing the app keeps recovery codes while a passkey remains', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct052');
  await addAuthenticator(page);
  await signIn(page, account);
  await enrolTenantPasskey(page, account, 'Desk key');

  // The authenticator app, confirmed with the passkey.
  await page.goto('/settings');
  const card = settingsCard(page, 'Authenticator app');
  await card.getByRole('button', { name: 'Set up an authenticator app' }).click();
  const dialog = confirmDialog(page);
  await dialog.or(totpSetupKey(card)).first().waitFor();
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    await expect(dialog).toBeHidden();
  }
  const secret = ((await totpSetupKey(card).textContent()) ?? '').trim();
  await card.getByLabel('Code from your authenticator app').fill(nextTotpCode({ secret, recoveryCodes: [], lastStep: -1 }));
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(recoveryCodeItems(card)).toHaveCount(10);
  await card.getByRole('button', { name: 'I have saved them' }).click();
  // One code used, so "the same count" is not just the full set again.
  await sql(`UPDATE recovery_codes SET used_at = now() WHERE code_hash = (SELECT code_hash FROM recovery_codes WHERE user_id = $1 LIMIT 1)`, [account.userId]);
  await page.reload();
  const codesCard = settingsCard(page, 'Recovery codes');
  await expect(codesCard.getByText('You have 9 codes left.')).toBeVisible();

  const deletes = recordResponses(page, 'DELETE', '/api/auth/totp');
  await card.getByRole('button', { name: 'Remove authenticator app' }).click();
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Authenticator app removed')).toBeVisible();
  expect(deletes.map((r) => r.status())).toEqual([403, 204]);

  await expect(codesCard.getByText('You have 9 codes left.')).toBeVisible();
  const factors = await call<{ methods: string[]; recoveryCodesRemaining: number }>('GET', '/api/auth/factors', undefined, {
    ip: clientIp,
    token: await pageAccessToken(page, clientIp),
  });
  expect(factors.body.methods).toEqual(['webauthn', 'recovery_code']);
  expect(factors.body.recoveryCodesRemaining).toBe(9);
  expect(await totpRow(account.userId)).toEqual([]);
  expect(await recoveryCodeRows(account.userId)).toHaveLength(10);
});

test('ACCT-055 a team-managed account cannot set up an authenticator app', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct055');
  await makeTeamManaged(account.userId);
  const factors = page.waitForResponse(pathIs('/api/auth/factors'));
  await signIn(page, account);
  await page.goto('/settings');
  expect(((await (await factors).json()) as { data: { canEnrolTotp: boolean } }).data.canEnrolTotp).toBe(false);
  await expect(settingsCard(page, 'Change Password')).toBeVisible();
  await expect(settingsCard(page, 'Authenticator app')).toHaveCount(0);

  const token = await reauthWithPassword(account.accessToken, account.password, clientIp);
  const setup = await call('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token });
  expect(setup.status).toBe(403);
  expect(setup.message).toBe('Set your own password before adding two-factor sign-in.');
  expect(await totpRow(account.userId)).toEqual([]);
});

test('ACCT-058 a super admin cannot set up an authenticator app here', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct058', 'Sue Super');
  await addAuthenticator(page);
  await signIn(page, account);
  await enrolTenantPasskey(page, account, 'Customer key');
  await makeSuperAdmin(account.userId);

  const factors = page.waitForResponse(pathIs('/api/auth/factors'));
  await page.reload();
  const status = (await (await factors).json()) as { data: { canEnrolTotp: boolean; totpEnabled: boolean } };
  expect(status.data).toMatchObject({ canEnrolTotp: false, totpEnabled: false });
  await expect(settingsCard(page, 'Passkeys').getByText('Customer key', { exact: true })).toBeVisible();
  await expect(settingsCard(page, 'Authenticator app')).toHaveCount(0);

  // Adding the passkey spent the proof: the proof is checked first.
  const token = await pageAccessToken(page, clientIp);
  const unproven = await call('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token });
  expect(unproven.status).toBe(403);
  expect(unproven.message).toBe(REAUTH);

  const proven = await reauthWithPasskey(page, token, clientIp);
  const refused = await call('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token: proven });
  expect(refused.status).toBe(403);
  expect(refused.message).toBe(STAFF_MANAGE);
  expect(await totpRow(account.userId)).toEqual([]);
});

// ---- F. Recovery codes

test('ACCT-065 download the recovery codes', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct065');
  await signIn(page, account);
  await page.goto('/settings');
  const secret = await openTotpSetup(page, account.password);
  const card = settingsCard(page, 'Authenticator app');
  await card.getByLabel('Code from your authenticator app').fill(nextTotpCode({ secret, recoveryCodes: [], lastStep: -1 } as TotpEnrolment));
  await card.getByRole('button', { name: 'Turn on' }).click();
  const items = recoveryCodeItems(card);
  await expect(items).toHaveCount(10);
  const shown = await items.allTextContents();

  const blobTypes = await recordBlobTypes(page);
  const file = await downloadFrom(page, card.getByRole('button', { name: 'Download', exact: true }));
  expect(file.filename).toBe('chumbaq-recovery-codes.txt');
  expect(file.text).toBe(`${shown.join('\n')}\n`);
  expect(file.lines).toEqual(shown);
  expect(file.lineEndings).toBe('lf');
  expect(file.hasBom).toBe(false);
  expect(await blobTypes()).toEqual(['text/plain']);
  // The codes are still on screen after downloading.
  await expect(items).toHaveText(shown);
});

test('ACCT-070 recovery codes need a second factor', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct070');
  const token = await reauthWithPassword(account.accessToken, account.password, clientIp);
  const regenerate = await call('POST', '/api/auth/recovery-codes', undefined, { ip: clientIp, token });
  expect(regenerate.status).toBe(409);
  expect(regenerate.message).toBe('Add a second factor first.');
  expect(await recoveryCodeRows(account.userId)).toEqual([]);
  // Refused before the proof was spent: the same token can still start a setup.
  expect((await call('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token })).status).toBe(200);

  const factors = page.waitForResponse(pathIs('/api/auth/factors'));
  await signIn(page, account);
  await page.goto('/settings');
  expect(((await (await factors).json()) as { data: { canManageRecoveryCodes: boolean } }).data.canManageRecoveryCodes).toBe(false);
  await expect(settingsCard(page, 'Authenticator app')).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);
});

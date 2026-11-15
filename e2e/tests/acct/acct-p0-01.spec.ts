import { createAccount, newClientIp, PASSWORD } from '../../support/api';
import {
  addAuthenticator,
  confirmIfAsked,
  confirmWithPassword,
  enrolTenantPasskey,
  enrolTotp,
  nextTotpCode,
  recoveryCodeItems,
  settingsCard,
  signInWithTotp,
  totpSetupKey,
  totpSetupQr,
  type TotpEnrolment,
} from '../../support/factors';
import { decodeQrOnPage } from '../../support/browser-tools';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { extractLink, waitForMail } from '../../support/mailbox';
import {
  authEvents,
  authEventsByEmail,
  call,
  dbNow,
  enrolStaffTotp,
  holdRequests,
  makeSuperAdmin,
  markUnverified,
  pageAccessToken,
  passwordField,
  passwordSession,
  reauthWithPassword,
  recordResponses,
  recoveryCodeRows,
  sql,
  toastTitled,
  totpRow,
  userRow,
} from '../../support/areas/acct';

/**
 * Account settings: changing the password, the re-authentication gate on factor
 * changes, the authenticator app, recovery codes and a first passkey, through /settings
 * and the customer API.
 */

const REAUTH = 'Confirm it is you to continue.';
const STAFF_MANAGE = 'Manage staff sign-in in the admin app.';
const LIMITED = 'Too many failed attempts. Try again in a few minutes.';
const CODE_REFUSED = 'That code is not right. Please try again.';
const NEW_PASSWORD = 'New-Passw0rd!';
const RECOVERY_CODE = /^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/;
const SAVE_THESE =
  'Save these now, somewhere other than this device. Each works once if you lose your other sign-in methods, and you will not see them again.';

const confirmDialog = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Confirm it is you' });

/** Opens the authenticator setup on /settings, answering "Confirm it is you" with the password. */
async function openTotpSetup(page: import('@playwright/test').Page, password: string): Promise<string> {
  await page.goto('/settings');
  const card = settingsCard(page, 'Authenticator app');
  await card.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await confirmIfAsked(page, password, totpSetupKey(card));
  return ((await totpSetupKey(card).textContent()) ?? '').trim();
}

// ---- A. Page access

test('ACCT-002 settings sends an anonymous visitor to /login', async ({ page, baseURL }) => {
  const accountCalls: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(auth\/(sessions|activity|factors|passkeys|factor-reset)|users)/.test(path)) accountCalls.push(path);
  });
  await page.goto('/settings');
  await expect(page).toHaveURL(`${baseURL}/login`);
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toHaveCount(0);
  expect(accountCalls).toEqual([]);
});

// ---- C. Change password

test('ACCT-011 change password signs out and the new password works', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'acct011', 'Cleo Change');
  const before = await userRow(account.userId);
  const since = await dbNow();
  await signIn(page, account);
  await page.goto('/settings');

  await passwordField(page, 'currentPassword').fill(PASSWORD);
  await passwordField(page, 'newPassword').fill(NEW_PASSWORD);
  await passwordField(page, 'confirmPassword').fill(NEW_PASSWORD);
  // Held until the pending label is seen, and read here: the page navigates away at once.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const answered = new Promise<{ status: number; body: unknown }>((resolve) => {
    void page.route('**/api/users/me/password', async (route) => {
      await gate;
      const response = await route.fetch();
      resolve({ status: response.status(), body: await response.json() });
      await route.fulfill({ response });
    });
  });
  await page.getByRole('button', { name: 'Update Password' }).click();
  await expect(page.getByRole('button', { name: 'Updating...' })).toBeDisabled();
  release();
  const response = await answered;
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ data: { message: 'Password updated successfully' } });

  await page.waitForURL(`${baseURL}/login?passwordChanged=1`);
  await expect(page.getByRole('status').filter({ hasText: 'Your password was changed' })).toHaveText(
    'Your password was changed and you were signed out everywhere. Sign in with the new password.',
  );

  const otherIp = newClientIp();
  const oldLogin = await call('POST', '/api/auth/login', { email: account.email, password: PASSWORD }, { ip: otherIp });
  expect(oldLogin.status).toBe(401);
  expect(oldLogin.message).toBe('Invalid email or password');
  const newLogin = await call('POST', '/api/auth/login', { email: account.email, password: NEW_PASSWORD }, { ip: otherIp });
  expect(newLogin.status).toBe(200);

  const after = await userRow(account.userId);
  expect(after.session_version).toBe(before.session_version + 1);
  expect(after.password_hash).not.toBe(before.password_hash);
  expect((await authEvents(account.userId, since, 'password.changed')).length).toBe(1);

  const mail = await waitForMail(account.email, { subjectIncludes: 'Your Chumbaq password was changed', since });
  expect(new URL(extractLink(mail, '/forgot-password')).pathname).toBe('/forgot-password');
});

test('ACCT-012 a password change ends every other session', async ({ page, clientIp, browser, baseURL }) => {
  const account = await createAccount(clientIp, 'acct012', 'Otto Other');
  const b = await newPersonContext(browser, baseURL);
  const pageB = await b.context.newPage();
  try {
    await signIn(page, account);
    await signIn(pageB, account);
    await pageB.goto('/settings');
    await expect(pageB.getByRole('heading', { name: 'Account Settings' })).toBeVisible();

    await page.goto('/settings');
    await passwordField(page, 'currentPassword').fill(PASSWORD);
    await passwordField(page, 'newPassword').fill(NEW_PASSWORD);
    await passwordField(page, 'confirmPassword').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Update Password' }).click();
    await page.waitForURL(`${baseURL}/login?passwordChanged=1`);

    // The session the account was created with (through the API) is over too.
    const stale = await call('GET', '/api/auth/me', undefined, { ip: clientIp, token: account.accessToken });
    expect(stale.status).toBe(401);
    expect(stale.message).toBe('Session has been revoked');

    const refreshes = recordResponses(pageB, 'POST', '/api/auth/refresh');
    await pageB.reload();
    await expect(pageB).toHaveURL(`${baseURL}/login`);
    await expect(pageB.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
    expect(refreshes.length).toBeGreaterThan(0);
    expect(refreshes.every((r) => r.status() === 401)).toBe(true);

    await signIn(pageB, { email: account.email, password: NEW_PASSWORD });
    const sessions = await call<Array<{ current: boolean }>>('GET', '/api/auth/sessions', undefined, {
      ip: b.ip,
      token: await pageAccessToken(pageB, b.ip),
    });
    expect(sessions.status).toBe(200);
    expect(sessions.body).toHaveLength(1);
    expect(sessions.body[0].current).toBe(true);
  } finally {
    await b.context.close();
  }
});

test('ACCT-024 a wrong current password is refused and counted twice', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct024', 'Wanda Wrong');
  await signIn(page, account);
  await page.goto('/settings');
  const since = await dbNow();
  const patches = recordResponses(page, 'PATCH', '/api/users/me/password');
  const refreshes = recordResponses(page, 'POST', '/api/auth/refresh');

  await passwordField(page, 'currentPassword').fill('wrong-password-1');
  await passwordField(page, 'newPassword').fill(NEW_PASSWORD);
  await passwordField(page, 'confirmPassword').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Update Password' }).click();

  const toast = toastTitled(page, 'Error');
  await expect(toast).toContainText('Invalid current password');
  await expect(page).toHaveURL(/\/settings$/);
  expect(patches.map((r) => r.status())).toEqual([401, 401]);
  expect(refreshes.map((r) => r.status())).toEqual([200]);

  const failures = await authEvents(account.userId, since, 'login.failed');
  expect(failures).toEqual([
    { type: 'login.failed', reason: 'wrong_password' },
    { type: 'login.failed', reason: 'wrong_password' },
  ]);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  const activity = settingsCard(page, 'Recent security activity');
  await expect(activity.locator('p', { hasText: 'Sign-in attempt failed' })).toHaveCount(2);

  const login = await call('POST', '/api/auth/login', { email: account.email, password: PASSWORD }, { ip: newClientIp() });
  expect(login.status).toBe(200);
});

test('ACCT-025 wrong current passwords count toward the sign-in limit', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct025');
  const since = await dbNow();
  for (let attempt = 1; attempt <= 10; attempt++) {
    const answer = await call(
      'PATCH',
      '/api/users/me/password',
      { currentPassword: `wrong-password-${attempt}`, newPassword: NEW_PASSWORD },
      { ip: clientIp, token: account.accessToken },
    );
    expect(answer.status, `attempt ${attempt}`).toBe(401);
    expect(answer.message).toBe('Invalid current password');
  }

  const eleventh = await call(
    'PATCH',
    '/api/users/me/password',
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    { ip: clientIp, token: account.accessToken },
  );
  expect(eleventh.status).toBe(429);
  expect(eleventh.message).toBe(LIMITED);

  const sameNetwork = await call('POST', '/api/auth/login', { email: account.email, password: PASSWORD }, { ip: clientIp });
  expect(sameNetwork.status).toBe(429);
  expect(sameNetwork.message).toBe(LIMITED);
  expect((await authEventsByEmail(account.email, since, 'login.limited')).length).toBeGreaterThanOrEqual(1);

  // The password did not change: the old one still signs in from another network.
  const elsewhere = await call('POST', '/api/auth/login', { email: account.email, password: PASSWORD }, { ip: newClientIp() });
  expect(elsewhere.status).toBe(200);
});

// ---- D. The re-authentication gate

test('ACCT-029 a fresh sign-in is not enough to change a factor', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct029');
  await signIn(page, account);
  await page.goto('/settings');
  const setups = recordResponses(page, 'POST', '/api/auth/totp/setup');
  const card = settingsCard(page, 'Authenticator app');
  await card.getByRole('button', { name: 'Set up an authenticator app' }).click();

  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('This is a sensitive action, so we need to check it is still you.')).toBeVisible();
  await expect(dialog.getByLabel('Password')).toBeVisible();
  expect(setups.map((r) => r.status())).toEqual([403]);
  expect(((await setups[0].json()) as { message: string }).message).toBe(REAUTH);

  const reauth = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/reauth');
  await confirmWithPassword(page, account.password);
  expect((await reauth).status()).toBe(200);
  await expect(totpSetupQr(card)).toBeVisible();
  expect(setups.map((r) => r.status())).toEqual([403, 200]);
});

test('ACCT-032 the factor-change proof is single use', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct032');
  const totp = await enrolTotp({ ip: clientIp }, account);
  const reauthed = await call<{ accessToken: string }>('POST', '/api/auth/reauth/totp', { code: nextTotpCode(totp) }, {
    ip: clientIp,
    token: totp.accessToken,
  });
  expect(reauthed.status).toBe(200);
  const token = reauthed.body.accessToken;

  const first = await call<{ recoveryCodes: string[] }>('POST', '/api/auth/recovery-codes', undefined, { ip: clientIp, token });
  expect(first.status).toBe(200);
  expect(first.body.recoveryCodes).toHaveLength(10);

  const second = await call('POST', '/api/auth/recovery-codes', undefined, { ip: clientIp, token });
  expect(second.status).toBe(403);
  expect(second.message).toBe(REAUTH);

  // The codes from the first call still work.
  const withCode = await call('POST', '/api/auth/reauth/recovery-code', { code: first.body.recoveryCodes[0] }, { ip: clientIp, token });
  expect(withCode.status).toBe(200);
});

test('ACCT-035 a proof from one session cannot be used by another', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct035');
  const ipB = newClientIp();
  const sessionB = await passwordSession(account, ipB);
  const sessionA = await reauthWithPassword(account.accessToken, account.password, clientIp);

  const fromB = await call('POST', '/api/auth/totp/setup', undefined, { ip: ipB, token: sessionB });
  expect(fromB.status).toBe(403);
  expect(fromB.message).toBe(REAUTH);

  const fromA = await call<{ secret: string }>('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token: sessionA });
  expect(fromA.status).toBe(200);
  expect(fromA.body.secret).toMatch(/^[A-Z2-7]{32}$/);
});

test('ACCT-036 a proof dies with its session', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct036');
  const ipB = newClientIp();
  const sessionB = await passwordSession(account, ipB);
  const sessionA = await reauthWithPassword(account.accessToken, account.password, clientIp);
  const listed = await call<Array<{ id: string; current: boolean }>>('GET', '/api/auth/sessions', undefined, { ip: clientIp, token: sessionA });
  const idA = listed.body.find((session) => session.current)?.id;
  expect(idA).toBeTruthy();

  const ended = await call('DELETE', `/api/auth/sessions/${idA}`, undefined, { ip: ipB, token: sessionB });
  expect(ended.status).toBe(204);

  const late = await call('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token: sessionA });
  expect(late.status).toBe(401);
  expect(late.message).toBe('Session has been revoked');
  expect(await totpRow(account.userId)).toEqual([]);
});

// ---- E. Authenticator app

test('ACCT-038 setup shows the QR code and the key', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct038');
  await signIn(page, account);
  const setups = recordResponses(page, 'POST', '/api/auth/totp/setup');
  const secret = await openTotpSetup(page, account.password);
  const card = settingsCard(page, 'Authenticator app');

  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await expect(totpSetupQr(card)).toBeVisible();
  await expect(card.locator('p', { hasText: 'Scan this with your app' })).toContainText(
    'Scan this with your app, or enter this key by hand:',
  );
  const field = card.getByLabel('Code from your authenticator app');
  await expect(field).toHaveAttribute('placeholder', '123456');
  await expect(field).toHaveAttribute('inputmode', 'numeric');
  await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(field).toBeFocused();
  await expect(card.getByRole('button', { name: 'Turn on' })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();

  const answered = setups.find((r) => r.status() === 200);
  expect(answered).toBeTruthy();
  expect(answered!.headers()['cache-control']).toBe('no-store');
  const { data } = (await answered!.json()) as { data: { secret: string; uri: string } };
  expect(data.secret).toBe(secret);
  expect(data.uri).toBe(
    `otpauth://totp/Chumbaq:${encodeURIComponent(account.email)}?secret=${secret}&issuer=Chumbaq&algorithm=SHA1&digits=6&period=30`,
  );
  expect(await decodeQrOnPage(totpSetupQr(card))).toBe(data.uri);

  const rows = await totpRow(account.userId);
  expect(rows).toHaveLength(1);
  expect(rows[0].confirmed_at).toBeNull();
  expect(rows[0].secret_ciphertext).not.toContain(secret);
});

test('ACCT-039 turning on with a valid code', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct039');
  await signIn(page, account);
  const secret = await openTotpSetup(page, account.password);
  const since = await dbNow();
  const card = settingsCard(page, 'Authenticator app');
  const enrolment: TotpEnrolment = { secret, recoveryCodes: [], lastStep: -1 };

  const release = await holdRequests(page, 'POST', '/api/auth/totp/confirm');
  const confirmed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/totp/confirm');
  await card.getByLabel('Code from your authenticator app').fill(nextTotpCode(enrolment));
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(card.getByRole('button', { name: 'Checking...' })).toBeDisabled();
  release();
  const response = await confirmed;
  expect(response.status()).toBe(200);
  const { data } = (await response.json()) as { data: { recoveryCodes: string[] } };
  expect(data.recoveryCodes).toHaveLength(10);

  await expect(recoveryCodeItems(card)).toHaveText(data.recoveryCodes);
  await card.getByRole('button', { name: 'I have saved them' }).click();
  await expect(card.getByText('On.', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Remove authenticator app' })).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes').getByText('You have 10 codes left.')).toBeVisible();

  const [row] = await totpRow(account.userId);
  expect(row.confirmed_at).not.toBeNull();
  expect(Number(row.last_used_step)).toBe(enrolment.lastStep);
  const codes = await recoveryCodeRows(account.userId);
  expect(codes).toHaveLength(10);
  expect(codes.every((code) => code.used_at === null)).toBe(true);
  expect((await authEvents(account.userId, since, 'totp.enabled')).length).toBe(1);
  await waitForMail(account.email, { subjectIncludes: 'An authenticator app was added on your Chumbaq account', since });
});

test('ACCT-040 turning on the authenticator app signs out other devices', async ({ page, clientIp, browser, baseURL }) => {
  const account = await createAccount(clientIp, 'acct040');
  const b = await newPersonContext(browser, baseURL);
  const pageB = await b.context.newPage();
  try {
    await signIn(page, account);
    await signIn(pageB, account);
    await enrolTotp(page, account);

    await pageB.reload();
    await expect(pageB).toHaveURL(`${baseURL}/login`);
    await expect(pageB.getByRole('heading', { name: 'Login to your account' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
    const devices = settingsCard(page, "Where you're signed in").getByRole('listitem');
    await expect(devices).toHaveCount(1);
    await expect(devices.first()).toContainText('This device');
  } finally {
    await b.context.close();
  }
});

test('ACCT-050 remove the authenticator app', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct050');
  await signIn(page, account);
  const totp = await enrolTotp(page, account);
  const since = await dbNow();
  const card = settingsCard(page, 'Authenticator app');
  await expect(settingsCard(page, 'Recovery codes')).toBeVisible();
  const deletes = recordResponses(page, 'DELETE', '/api/auth/totp');

  await card.getByRole('button', { name: 'Remove authenticator app' }).click();
  const dialog = confirmDialog(page);
  await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Lost your device? Use a recovery code' })).toBeVisible();
  await dialog.getByLabel('Code from your authenticator app').fill(nextTotpCode(totp));
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(toastTitled(page, 'Authenticator app removed')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Set up an authenticator app' })).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);
  expect(deletes.map((r) => r.status())).toEqual([403, 204]);

  expect(await totpRow(account.userId)).toEqual([]);
  expect(await recoveryCodeRows(account.userId)).toEqual([]);
  expect((await authEvents(account.userId, since, 'totp.disabled')).length).toBe(1);
  await waitForMail(account.email, { subjectIncludes: 'An authenticator app was removed on your Chumbaq account', since });
});

test('ACCT-054 an unverified address cannot set up an authenticator app', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct054');
  await markUnverified(account.userId);
  const factors = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/factors');
  await signIn(page, account);
  await page.goto('/settings');
  const status = (await (await factors).json()) as { data: { canEnrolTotp: boolean } };
  expect(status.data.canEnrolTotp).toBe(false);
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  await expect(settingsCard(page, 'Change Password')).toBeVisible();
  await expect(settingsCard(page, 'Authenticator app')).toHaveCount(0);

  const token = await reauthWithPassword(account.accessToken, account.password, clientIp);
  const setup = await call('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token });
  expect(setup.status).toBe(403);
  expect(setup.message).toBe('Verify your email address before adding two-factor sign-in.');
  expect(await totpRow(account.userId)).toEqual([]);
});

test('ACCT-057 a super admin sees their staff authenticator app as read-only', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct057', 'Stella Staff');
  await makeSuperAdmin(account.userId);
  const staffTotp = await enrolStaffTotp(account);
  await signInWithTotp(page, account, staffTotp);
  await page.goto('/settings');

  const card = settingsCard(page, 'Authenticator app');
  await expect(card.getByText('On.', { exact: true })).toBeVisible();
  const deletes = recordResponses(page, 'DELETE', '/api/auth/totp');
  await card.getByRole('button', { name: 'Remove authenticator app' }).click();

  await expect(toastTitled(page, 'Nothing was changed')).toContainText(STAFF_MANAGE);
  await expect(confirmDialog(page)).toHaveCount(0);
  expect(deletes.map((r) => r.status())).toEqual([403]);
  expect(((await deletes[0].json()) as { message: string }).message).toBe(STAFF_MANAGE);
  const rows = await totpRow(account.userId);
  expect(rows).toHaveLength(1);
  expect(rows[0].confirmed_at).not.toBeNull();
});

// ---- F. Recovery codes

test('ACCT-062 a first factor shows the recovery codes block', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct062');
  await signIn(page, account);
  const secret = await openTotpSetup(page, account.password);
  const card = settingsCard(page, 'Authenticator app');
  const confirmed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/totp/confirm');
  await card.getByLabel('Code from your authenticator app').fill(nextTotpCode({ secret, recoveryCodes: [], lastStep: -1 }));
  await card.getByRole('button', { name: 'Turn on' }).click();
  const { data } = (await (await confirmed).json()) as { data: { recoveryCodes: string[] } };

  await expect(card.getByRole('status')).toHaveText(SAVE_THESE);
  const items = recoveryCodeItems(card);
  await expect(items).toHaveCount(10);
  const shown = await items.allTextContents();
  expect(shown).toEqual(data.recoveryCodes);
  for (const code of shown) expect(code).toMatch(RECOVERY_CODE);
  expect(new Set(shown).size).toBe(10);
  for (const name of ['Copy', 'Download', 'I have saved them']) {
    await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
  }
});

test('ACCT-066 recovery codes are shown once', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct066');
  await signIn(page, account);
  const secret = await openTotpSetup(page, account.password);
  const card = settingsCard(page, 'Authenticator app');
  await card.getByLabel('Code from your authenticator app').fill(nextTotpCode({ secret, recoveryCodes: [], lastStep: -1 }));
  await card.getByRole('button', { name: 'Turn on' }).click();
  await expect(recoveryCodeItems(card)).toHaveCount(10);
  const shown = await recoveryCodeItems(card).allTextContents();

  const bodies: string[] = [];
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/')) bodies.push(await response.text().catch(() => ''));
  });
  const factors = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/factors');
  await page.reload();
  const status = (await (await factors).json()) as { data: Record<string, unknown> };
  expect(Object.keys(status.data).sort()).toEqual(['canEnrolTotp', 'canManageRecoveryCodes', 'methods', 'recoveryCodesRemaining', 'totpEnabled']);
  expect(status.data.recoveryCodesRemaining).toBe(10);

  await expect(settingsCard(page, 'Recovery codes').getByText('You have 10 codes left.')).toBeVisible();
  await expect(page.getByText('Save these now', { exact: false })).toHaveCount(0);
  for (const code of shown) await expect(page.getByText(code)).toHaveCount(0);
  for (const body of bodies) for (const code of shown) expect(body).not.toContain(code);

  const stored = await recoveryCodeRows(account.userId);
  expect(stored).toHaveLength(10);
  const plain = new Set(shown.flatMap((code) => [code, code.replace(/-/g, '')]));
  for (const row of stored) expect(plain.has(row.code_hash)).toBe(false);
});

test('ACCT-068 make new recovery codes', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct068');
  await signIn(page, account);
  const totp = await enrolTotp(page, account);
  const first = totp.recoveryCodes;
  const since = await dbNow();
  const card = settingsCard(page, 'Recovery codes');
  await expect(card.getByText('You have 10 codes left.')).toBeVisible();

  const regenerated = recordResponses(page, 'POST', '/api/auth/recovery-codes');
  await card.getByRole('button', { name: 'Make new recovery codes' }).click();
  const dialog = confirmDialog(page);
  await dialog.getByLabel('Code from your authenticator app').fill(nextTotpCode(totp));
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();

  const items = recoveryCodeItems(card);
  await expect(items).toHaveCount(10);
  const second = await items.allTextContents();
  expect(regenerated.map((r) => r.status())).toEqual([403, 200]);
  const answered = regenerated[1];
  expect(answered.headers()['cache-control']).toBe('no-store');
  expect(((await answered.json()) as { data: { recoveryCodes: string[] } }).data.recoveryCodes).toEqual(second);
  expect(second.filter((code) => first.includes(code))).toEqual([]);
  await card.getByRole('button', { name: 'I have saved them' }).click();
  await expect(card.getByText('You have 10 codes left.')).toBeVisible();

  const token = await pageAccessToken(page, clientIp);
  const old = await call('POST', '/api/auth/reauth/recovery-code', { code: first[0] }, { ip: clientIp, token });
  expect(old.status).toBe(403);
  expect(old.message).toBe(CODE_REFUSED);
  const fresh = await call('POST', '/api/auth/reauth/recovery-code', { code: second[0] }, { ip: clientIp, token });
  expect(fresh.status).toBe(200);

  expect((await authEvents(account.userId, since, 'recovery_codes.regenerated')).length).toBe(1);
  await waitForMail(account.email, { subjectIncludes: 'Your Chumbaq recovery codes were replaced', since });
  await page.reload();
  await expect(settingsCard(page, 'Recent security activity').locator('p', { hasText: 'New recovery codes made' })).toHaveCount(1);
});

test('ACCT-071 super admins get no recovery codes in the customer app', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct071', 'Sid Super');
  await addAuthenticator(page);
  await signIn(page, account);
  await enrolTenantPasskey(page, account, 'Customer key');
  await makeSuperAdmin(account.userId);

  const factors = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/factors');
  await page.reload();
  const status = (await (await factors).json()) as { data: { canManageRecoveryCodes: boolean; methods: string[] } };
  expect(status.data.canManageRecoveryCodes).toBe(false);
  expect(status.data.methods).toEqual(['webauthn']);
  await expect(settingsCard(page, 'Passkeys').getByText('Customer key', { exact: true })).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);

  const token = await pageAccessToken(page, clientIp);
  const regenerate = await call('POST', '/api/auth/recovery-codes', undefined, { ip: clientIp, token });
  expect(regenerate.status).toBe(403);
  expect(regenerate.message).toBe(STAFF_MANAGE);
});

// ---- G. Passkeys

test('ACCT-074 add the first passkey', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'acct074', 'Pia Passkey');
  const authenticator = await addAuthenticator(page);
  await signIn(page, account);
  await page.goto('/settings');
  const since = await dbNow();
  const card = settingsCard(page, 'Passkeys');
  await expect(card.getByText('You have no passkeys yet.')).toBeVisible();

  const options = recordResponses(page, 'POST', '/api/auth/passkeys/options');
  const release = await holdRequests(page, 'POST', '/api/auth/passkeys');
  const registered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/passkeys',
  );
  await card.getByLabel('Name', { exact: true }).fill('Work laptop');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithPassword(page, account.password);
  await expect(card.getByRole('button', { name: 'Waiting for your passkey...' })).toBeDisabled();
  release();

  const response = await registered;
  expect(response.status()).toBe(201);
  expect(response.headers()['cache-control']).toBe('no-store');
  const { data } = (await response.json()) as {
    data: { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null; recoveryCodes: string[] };
  };
  expect(data).toMatchObject({ name: 'Work laptop', deviceType: 'singleDevice', backedUp: false, lastUsedAt: null });
  expect(typeof data.id).toBe('string');
  expect(data.recoveryCodes).toHaveLength(10);

  expect(options.map((r) => r.status())).toEqual([403, 200]);
  const { data: optionsJson } = (await options[1].json()) as {
    data: { rp: { id: string }; attestation: string; authenticatorSelection: { residentKey: string; userVerification: string } };
  };
  expect(optionsJson.rp.id).toBe(new URL(baseURL!).hostname);
  expect(optionsJson.authenticatorSelection.residentKey).toBe('required');
  expect(optionsJson.authenticatorSelection.userVerification).toBe('preferred');
  expect(optionsJson.attestation).toBe('none');

  await expect(toastTitled(page, 'Passkey added')).toBeVisible();
  await expect(recoveryCodeItems(card)).toHaveText(data.recoveryCodes);
  const added = await page.evaluate((iso) => new Date(iso).toLocaleDateString(), data.createdAt);
  const row = card.getByRole('listitem').filter({ hasText: 'Work laptop' });
  await expect(row).toContainText(`This device or key only · Added ${added}`);
  await expect(row.getByRole('button', { name: 'Remove Work laptop' })).toBeVisible();
  await expect(card.getByLabel('Name', { exact: true })).toHaveValue('');
  await expect(settingsCard(page, 'Recovery codes').getByText('You have 10 codes left.')).toBeVisible();

  const stored = await sql<{ scope: string; name: string; key_bytes: number }>(
    `SELECT scope, name, octet_length(public_key) AS key_bytes FROM webauthn_credentials WHERE user_id = $1`,
    [account.userId],
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ scope: 'customer', name: 'Work laptop' });
  expect(stored[0].key_bytes).toBeGreaterThan(0);
  expect(await authenticator.credentials()).toHaveLength(1);
  expect((await authEvents(account.userId, since, 'passkey.added')).length).toBe(1);

  // The session the account was created with is signed out.
  const stale = await call('GET', '/api/auth/me', undefined, { ip: clientIp, token: account.accessToken });
  expect(stale.status).toBe(401);
  const mail = await waitForMail(account.email, { subjectIncludes: 'A passkey was added on your Chumbaq account', since });
  expect(mail.text).toContain('Work laptop');
});

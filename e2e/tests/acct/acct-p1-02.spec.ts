import type { Page, Response } from '@playwright/test';
import { enrolAndSignInStaff } from '../../support/admin';
import { createAccount, createProject, newClientIp, PASSWORD } from '../../support/api';
import { fixedLocaleContext } from '../../support/browser-tools';
import {
  addAuthenticator,
  confirmWithPassword,
  enrolTenantPasskey,
  enrolTotp,
  nextTotpCode,
  recoveryCodeItems,
  rejectNextCredentialPrompt,
  settingsCard,
  signInWithTotp,
  totpSetupKey,
  type VirtualAuthenticator,
} from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  AUTH_DATA_FLAGS,
  auditRowsFor,
  authEvents,
  call,
  cardDescription,
  CHROME_ON_MACOS,
  confirmWithPasskey,
  confirmWithTotpCode,
  countCredentialCreates,
  dbNow,
  deviceContext,
  enrolStaffTotp,
  FACTOR_RESET_NOTE,
  factorResetRow,
  FIREFOX_ON_LINUX,
  forwardToApi,
  type ExtraCustomerApi,
  freshTotpCode,
  holdNthRequest,
  insertAuthEvent,
  jwtClaims,
  makeSuperAdmin,
  makeTeamManaged,
  markUnverified,
  pageAccessToken,
  passkeyRows,
  passwordField,
  passwordSignInDetails,
  reauthWithPasskey,
  reauthWithPassword,
  recordResponses,
  recoveryCodeRows,
  seedPasskeyRow,
  seedPendingFactorReset,
  sessionNote,
  setSessionNote,
  softwareRegistration,
  startCustomerApiWith,
  sql,
  STAFF_LINK_NOTE,
  toastTitled,
  totpRow,
  userRow,
} from '../../support/areas/acct';

/**
 * Account settings, P1 second half: passkeys (the card, names, a second key, refusals),
 * super admins in the customer app, devices, the security activity, the factor reset
 * banner, the account menu, and a few cross-cutting checks.
 */

const REAUTH = 'Confirm it is you to continue.';
const NEW_PASSWORD = 'New-Passw0rd!';
const LIMITED = 'Too many failed attempts. Try again in a few minutes.';
const TOO_SHORT = 'Password must be at least 8 characters';
const CANCELLED_PROMPT = 'The passkey request was cancelled or timed out. Please try again.';
const STAFF_KEYS_ONLY = 'Your staff passkeys work only in the admin app. Add an authenticator app there to sign in here.';
const SYNCED_REFUSED =
  'Staff accounts need a device-bound key, such as a hardware security key. This one syncs between devices. To allow that, set SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS.';
const NO_RESET = 'No reset is waiting for this account.';
const RECOVERY_CODE = /^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/;
const LOST_DEVICE = 'Lost your device? Use a recovery code';

const confirmDialog = (page: Page) => page.getByRole('dialog', { name: 'Confirm it is you' });
const pathOf = (response: Response) => new URL(response.url()).pathname;
const isCall = (method: string, path: string) => (response: Response) =>
  response.request().method() === method && pathOf(response) === path;
const resetBanner = (page: Page) => page.getByRole('alert').filter({ hasText: 'Support will remove' });

/** The date format the settings page uses, as this browser writes it. */
function formatInPage(page: Page, iso: string): Promise<string> {
  return page.evaluate((value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), iso);
}

/** Opens the project sidebar's account menu (the button with the person's name and address). */
async function openSidebarAccountMenu(page: Page, email: string) {
  await page.locator('[data-sidebar="sidebar"]').getByRole('button').filter({ hasText: email }).click();
  return page.getByRole('menu');
}

/**
 * Adds a passkey on /settings as if from a second device: "Confirm it is you" is answered
 * with the tab's passkey, and while the resent options request is held the tab's
 * authenticator forgets that key, so the browser makes the new one instead of refusing
 * it as already registered. Answers the registration response's body.
 */
async function addPasskeyFromAnotherDevice(page: Page, authenticator: VirtualAuthenticator, name: string) {
  const card = settingsCard(page, 'Passkeys');
  const held = await holdNthRequest(page, 'POST', '/api/auth/passkeys/options', 2);
  const registered = page.waitForResponse(isCall('POST', '/api/auth/passkeys'));
  await card.getByLabel('Name', { exact: true }).fill(name);
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithPasskey(page);
  await held.arrived;
  await authenticator.clearCredentials();
  held.release();
  const response = await registered;
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { name: string; recoveryCodes?: string[] } }).data;
}

// ---- G. Passkeys

test('ACCT-073 the passkeys card for a tenant with none', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct073');
  await signIn(page, account);
  const listed = page.waitForResponse(isCall('GET', '/api/auth/passkeys'));
  await page.goto('/settings');
  expect(((await (await listed).json()) as { data: unknown }).data).toEqual({ canEnrol: true, passkeys: [] });

  const card = settingsCard(page, 'Passkeys');
  await expect(cardDescription(card)).toHaveText(
    'Sign in with your device or a security key. Once you have one, your password alone is no longer enough to sign in. Add a second in case you lose the first.',
  );
  await expect(card.getByText('You have no passkeys yet.', { exact: true })).toBeVisible();
  await expect(card.getByRole('listitem')).toHaveCount(0);
  const name = card.getByLabel('Name', { exact: true });
  await expect(name).toHaveAttribute('placeholder', 'For example, YubiKey on my keyring');
  await expect(name).toHaveAttribute('maxlength', '64');
  await expect(card.getByRole('button', { name: 'Add a passkey' })).toBeEnabled();
});

test('ACCT-076 a passkey name with markup is shown as text', async ({ page, clientIp }) => {
  const name = '<img src=x onerror=alert(1)>';
  const account = await createAccount(clientIp, 'acct076');
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await addAuthenticator(page);
  await signIn(page, account);
  await enrolTenantPasskey(page, account, name);

  const card = settingsCard(page, 'Passkeys');
  const row = card.getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row.locator('p').first()).toHaveText(name);
  await expect(card.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
  await page.reload();
  await expect(card.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect((await passkeyRows(account.userId)).map((r) => r.name)).toEqual([name]);
  expect(dialogs).toEqual([]);
});

test('ACCT-078 a second passkey brings no new codes', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct078');
  const authenticator = await addAuthenticator(page);
  await signIn(page, account);
  const codes = await enrolTenantPasskey(page, account, 'Laptop');
  expect(codes).toHaveLength(10);
  const card = settingsCard(page, 'Passkeys');
  const options = recordResponses(page, 'POST', '/api/auth/passkeys/options');

  // The dialog, opened by the refused options request, offers the passkey and the codes only.
  const dialog = confirmDialog(page);
  const held = await holdNthRequest(page, 'POST', '/api/auth/passkeys/options', 2);
  const registered = page.waitForResponse(isCall('POST', '/api/auth/passkeys'));
  await card.getByLabel('Name', { exact: true }).fill('Phone');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(dialog.getByRole('button', { name: 'Use passkey' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: LOST_DEVICE })).toBeVisible();
  await expect(dialog.getByLabel('Password')).toHaveCount(0);
  await expect(dialog.getByLabel('Code from your authenticator app')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await expect(dialog).toBeHidden();
  await held.arrived;
  await authenticator.clearCredentials();
  held.release();

  const response = await registered;
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: Record<string, unknown> };
  expect(data.name).toBe('Phone');
  expect('recoveryCodes' in data).toBe(false);
  expect(options.map((r) => r.status())).toEqual([403, 200]);
  await expect(toastTitled(page, 'Passkey added').first()).toBeVisible();
  await expect(card.getByRole('status').filter({ hasText: 'Save these now' })).toHaveCount(0);
  await expect(card.getByRole('listitem').locator('p.font-medium')).toHaveText(['Laptop', 'Phone']);
  await expect(settingsCard(page, 'Recovery codes').getByText('You have 10 codes left.')).toBeVisible();
  expect((await passkeyRows(account.userId)).map((row) => row.name)).toEqual(['Laptop', 'Phone']);
  expect((await recoveryCodeRows(account.userId)).filter((row) => row.used_at === null)).toHaveLength(10);
});

test('ACCT-081 a cancelled browser prompt', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct081');
  await signIn(page, account);
  await page.goto('/settings');
  const card = settingsCard(page, 'Passkeys');
  await expect(card.getByText('You have no passkeys yet.')).toBeVisible();
  await rejectNextCredentialPrompt(page, 'create');
  const registers = recordResponses(page, 'POST', '/api/auth/passkeys');
  const options = recordResponses(page, 'POST', '/api/auth/passkeys/options');

  await card.getByLabel('Name', { exact: true }).fill('Never made');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithPassword(page, PASSWORD);

  const toast = toastTitled(page, 'Passkey not changed');
  await expect(toast).toContainText(CANCELLED_PROMPT);
  await expect(toast).toHaveClass(/destructive/);
  expect(options.map((r) => r.status())).toEqual([403, 200]);
  expect(registers).toEqual([]);
  await expect(card.getByRole('button', { name: 'Add a passkey' })).toBeEnabled();
  await expect(card.getByRole('listitem')).toHaveCount(0);
  await expect(card.getByText('You have no passkeys yet.')).toBeVisible();
  expect(await passkeyRows(account.userId)).toEqual([]);
});

test('ACCT-083 the passkey limit of 10', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct083');
  await signIn(page, account);
  const totp = await enrolTotp(page, account);
  for (let i = 1; i <= 10; i++) await seedPasskeyRow(account.userId, `Key ${i}`);
  await page.reload();
  const card = settingsCard(page, 'Passkeys');
  await expect(card.getByRole('listitem')).toHaveCount(10);
  const creates = await countCredentialCreates(page);
  const options = recordResponses(page, 'POST', '/api/auth/passkeys/options');

  await card.getByLabel('Name', { exact: true }).fill('Eleventh');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithTotpCode(page, await freshTotpCode(totp));

  await expect(toastTitled(page, 'Passkey not changed')).toContainText('This account has as many passkeys as it can hold.');
  expect(options.map((r) => r.status())).toEqual([403, 409]);
  expect(((await options[1].json()) as { message: string }).message).toBe('This account has as many passkeys as it can hold.');
  expect(await creates()).toBe(0);
  await expect(card.getByRole('listitem')).toHaveCount(10);
  expect(await passkeyRows(account.userId)).toHaveLength(10);
});

test('ACCT-095 a team-managed account cannot add a passkey', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct095');
  await makeTeamManaged(account.userId);
  await signIn(page, account);
  const listed = page.waitForResponse(isCall('GET', '/api/auth/passkeys'));
  await page.goto('/settings');
  expect(((await (await listed).json()) as { data: unknown }).data).toEqual({ canEnrol: false, passkeys: [] });
  await expect(settingsCard(page, "Where you're signed in")).toBeVisible();
  await expect(settingsCard(page, 'Passkeys')).toHaveCount(0);

  const token = await reauthWithPassword(account.accessToken, PASSWORD, clientIp);
  const options = await call('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token });
  expect(options.status).toBe(403);
  expect(options.message).toBe('Set your own password before adding a passkey.');
  expect(await passkeyRows(account.userId)).toEqual([]);
});

test('ACCT-097 a factor change that waited on a staff reset is refused', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct097');
  const totp = await enrolTotp({ ip: clientIp }, account);
  // Control: with a proof, new codes are made.
  const first = await call<{ accessToken: string }>('POST', '/api/auth/reauth/totp', { code: nextTotpCode(totp) }, { ip: clientIp, token: totp.accessToken });
  expect(first.status).toBe(200);
  const control = await call<{ recoveryCodes: string[] }>('POST', '/api/auth/recovery-codes', undefined, { ip: clientIp, token: first.body.accessToken });
  expect(control.status).toBe(200);
  expect(control.body.recoveryCodes).toHaveLength(10);

  const second = await call<{ accessToken: string }>(
    'POST',
    '/api/auth/reauth/recovery-code',
    { code: control.body.recoveryCodes[0] },
    { ip: clientIp, token: first.body.accessToken },
  );
  expect(second.status).toBe(200);
  const before = (await recoveryCodeRows(account.userId)).map((row) => row.code_hash).sort();
  const since = await dbNow();
  // A staff reset committing after the proof was checked.
  await sql('UPDATE users SET factors_reset_at = clock_timestamp() WHERE id = $1', [account.userId]);

  const refused = await call('POST', '/api/auth/recovery-codes', undefined, { ip: clientIp, token: second.body.accessToken });
  expect(refused.status).toBe(401);
  expect(refused.message).toBe('Session has been revoked');
  expect((await recoveryCodeRows(account.userId)).map((row) => row.code_hash).sort()).toEqual(before);
  expect(await authEvents(account.userId, since, 'recovery_codes.regenerated')).toEqual([]);
});

// ---- H. Super admin in the customer app

test('ACCT-098 a super admin can add a customer passkey without the tenant rules', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct098', 'Sky Super');
  await makeSuperAdmin(account.userId);
  await markUnverified(account.userId);
  await addAuthenticator(page);
  await signIn(page, account);
  const listed = page.waitForResponse(isCall('GET', '/api/auth/passkeys'));
  await page.goto('/settings');
  expect(((await (await listed).json()) as { data: { canEnrol: boolean } }).data.canEnrol).toBe(true);

  const card = settingsCard(page, 'Passkeys');
  const options = recordResponses(page, 'POST', '/api/auth/passkeys/options');
  const registered = page.waitForResponse(isCall('POST', '/api/auth/passkeys'));
  await card.getByLabel('Name', { exact: true }).fill('Staff laptop');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithPassword(page, PASSWORD);
  const response = await registered;
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: Record<string, unknown> };
  expect('recoveryCodes' in data).toBe(false);
  expect(options.map((r) => r.status())).toEqual([403, 200]);
  const optionsJson = ((await options[1].json()) as { data: { authenticatorSelection: { userVerification: string } } }).data;
  expect(optionsJson.authenticatorSelection.userVerification).toBe('required');

  await expect(toastTitled(page, 'Passkey added').first()).toBeVisible();
  await expect(card.getByRole('button', { name: 'Remove Staff laptop' })).toBeVisible();
  await expect(card.getByRole('status').filter({ hasText: 'Save these now' })).toHaveCount(0);
  await page.reload();
  await expect(card.getByRole('button', { name: 'Remove Staff laptop' })).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);
  expect(await recoveryCodeRows(account.userId)).toEqual([]);
  expect((await passkeyRows(account.userId)).map((row) => row.scope)).toEqual(['customer']);
});

test.describe('ACCT-099 with synced staff keys not allowed', () => {
  let strict: ExtraCustomerApi | undefined;
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    strict = await startCustomerApiWith('synced-off', { SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS: 'false' });
  });
  test.afterAll(async () => {
    await strict?.stop();
  });

  test('ACCT-099 a super admin synced passkey is refused', async ({ page, clientIp }) => {
    const account = await createAccount(clientIp, 'acct099', 'Syd Synced');
    await makeSuperAdmin(account.userId);
    await addAuthenticator(page, { synced: true });
    await signIn(page, account);
    await page.goto('/settings');
    // The passkey routes go to an API where synced staff keys are not allowed.
    await forwardToApi(page, strict!.url, '/api/auth/passkeys');
    const card = settingsCard(page, 'Passkeys');
    const registers = recordResponses(page, 'POST', '/api/auth/passkeys');
    await card.getByLabel('Name', { exact: true }).fill('Cloud key');
    await card.getByRole('button', { name: 'Add a passkey' }).click();
    await confirmWithPassword(page, PASSWORD);

    await expect(toastTitled(page, 'Passkey not changed')).toContainText(SYNCED_REFUSED);
    expect(registers.map((r) => r.status())).toEqual([400]);
    expect(((await registers[0].json()) as { message: string }).message).toBe(SYNCED_REFUSED);
    await expect(card.getByText('You have no passkeys yet.')).toBeVisible();
    expect(await passkeyRows(account.userId)).toEqual([]);
  });
});

test('ACCT-102 a super admin confirmation never offers the authenticator app when a customer key exists', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct102', 'Tess Totp');
  await makeSuperAdmin(account.userId);
  const staffTotp = await enrolStaffTotp(account);
  await addAuthenticator(page);
  await signInWithTotp(page, account, staffTotp);
  await page.goto('/settings');

  // The first customer key, confirmed with the staff app (no customer key yet).
  const card = settingsCard(page, 'Passkeys');
  await card.getByLabel('Name', { exact: true }).fill('Key one');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithTotpCode(page, await freshTotpCode(staffTotp));
  await expect(card.getByRole('button', { name: 'Remove Key one' })).toBeVisible();
  const spare = await seedPasskeyRow(account.userId, 'Key two');

  const factors = page.waitForResponse(isCall('GET', '/api/auth/factors'));
  await page.reload();
  expect(((await (await factors).json()) as { data: { methods: string[] } }).data.methods).toEqual(['webauthn']);
  const removed = recordResponses(page, 'DELETE', `/api/auth/passkeys/${spare}`);
  await card.getByRole('button', { name: 'Remove Key two' }).click();
  const dialog = confirmDialog(page);
  await expect(dialog.getByRole('button', { name: 'Use passkey' })).toBeVisible();
  await expect(dialog.getByLabel('Code from your authenticator app')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: LOST_DEVICE })).toHaveCount(0);
  await expect(dialog.getByLabel('Password')).toHaveCount(0);
  await confirmWithPasskey(page);
  await expect(toastTitled(page, 'Passkey removed')).toBeVisible();
  expect(removed.map((r) => r.status())).toEqual([403, 204]);
  expect((await passkeyRows(account.userId)).map((row) => row.name)).toEqual(['Key one']);
});

// ---- I. Devices

test('ACCT-103 the devices card lists this session', async ({ browser, baseURL }) => {
  const device = await deviceContext(browser, baseURL, CHROME_ON_MACOS);
  try {
    const account = await createAccount(device.ip, 'acct103', 'Dee Device');
    // Only the browser's session: the one sign-up made through the API is ended.
    await sql('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1', [account.userId]);
    const page = await device.context.newPage();
    await signIn(page, account);
    const listed = page.waitForResponse(isCall('GET', '/api/auth/sessions'));
    await page.goto('/settings');
    const sessions = ((await (await listed).json()) as { data: Array<{ signedInAt: string; lastActiveAt: string; current: boolean; device: string }> }).data;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);

    const card = settingsCard(page, "Where you're signed in");
    await expect(cardDescription(card)).toHaveText("If you see a device you don't recognise, sign it out and change your password.");
    const rows = card.getByRole('listitem');
    await expect(rows).toHaveCount(1);
    // ua-parser names the system "Mac OS".
    await expect(rows.locator('p').first()).toHaveText('Chrome on Mac OSThis device');
    await expect(rows.getByText('This device', { exact: true })).toBeVisible();
    const signedIn = await formatInPage(page, sessions[0].signedInAt);
    const lastActive = await formatInPage(page, sessions[0].lastActiveAt);
    await expect(rows.locator('p').nth(1)).toHaveText(`${device.ip} · Signed in ${signedIn} · Last active ${lastActive}`);
    await expect(rows.getByRole('button', { name: /Sign out/ })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Sign out all other devices' })).toHaveCount(0);
  } finally {
    await device.context.close();
  }
});

test('ACCT-110 the current session cannot be ended through the sessions route', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct110');
  const listed = await call<Array<{ id: string; current: boolean }>>('GET', '/api/auth/sessions', undefined, { ip: clientIp, token: account.accessToken });
  const own = listed.body.find((session) => session.current)!;
  expect(own.id).toBe(String(jwtClaims(account.accessToken).sid));

  const refused = await call('DELETE', `/api/auth/sessions/${own.id}`, undefined, { ip: clientIp, token: account.accessToken });
  expect(refused.status).toBe(400);
  expect(refused.message).toBe('To sign out of this device, use Sign out.');
  expect((await call('GET', '/api/auth/me', undefined, { ip: clientIp, token: account.accessToken })).status).toBe(200);
  const [row] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [own.id]);
  expect(row.revoked_at).toBeNull();
});

test('ACCT-113 the sessions list leaves out ended and old sessions', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct113');
  const current = String(jwtClaims(account.accessToken).sid);
  const made: Awaited<ReturnType<typeof passwordSignInDetails>>[] = [];
  for (let i = 0; i < 5; i++) made.push(await passwordSignInDetails(account, clientIp));
  const [revoked, oldVersion, idle, tooOld, live] = made.map((m) => m.sessionId);
  const { refreshLifetimeSeconds, sessionMaxAgeSeconds } = made[0];
  expect(refreshLifetimeSeconds).toBeGreaterThan(0);
  expect(sessionMaxAgeSeconds).toBeGreaterThanOrEqual(refreshLifetimeSeconds);

  await sql(`UPDATE auth_sessions SET last_used_at = now() - interval '2 minutes' WHERE id = $1`, [current]);
  await sql('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [revoked]);
  await sql('UPDATE auth_sessions SET session_version = session_version - 1 WHERE id = $1', [oldVersion]);
  await sql(`UPDATE auth_sessions SET last_used_at = now() - make_interval(secs => $2::int + 3600) WHERE id = $1`, [idle, refreshLifetimeSeconds]);
  await sql(`UPDATE auth_sessions SET created_at = now() - make_interval(secs => $2::int + 3600) WHERE id = $1`, [tooOld, sessionMaxAgeSeconds]);

  const listed = await call<Array<Record<string, unknown>>>('GET', '/api/auth/sessions', undefined, { ip: clientIp, token: account.accessToken });
  expect(listed.status).toBe(200);
  expect(listed.body.map((session) => session.id)).toEqual([live, current]);
  expect(listed.body.map((session) => session.current)).toEqual([false, true]);
  for (const session of listed.body) {
    expect(Object.keys(session).sort()).toEqual(['current', 'device', 'id', 'ipAddress', 'lastActiveAt', 'signedInAt']);
  }
  const [{ user_agent: storedAgent }] = await sql<{ user_agent: string | null }>('SELECT user_agent FROM auth_sessions WHERE id = $1', [live]);
  if (storedAgent) expect(listed.text).not.toContain(storedAgent);
  // Each left-out session still exists, so it was the filter that left it out.
  expect(await sql('SELECT id FROM auth_sessions WHERE id = ANY($1::uuid[])', [[revoked, oldVersion, idle, tooOld]])).toHaveLength(4);
});

test('ACCT-114 a signed-out device is told it ended', async ({ browser, baseURL }) => {
  const a = await deviceContext(browser, baseURL, CHROME_ON_MACOS);
  const b = await deviceContext(browser, baseURL, FIREFOX_ON_LINUX);
  try {
    const account = await createAccount(a.ip, 'acct114');
    const pageA = await a.context.newPage();
    const pageB = await b.context.newPage();
    await signIn(pageA, account);
    await signIn(pageB, account);
    await pageB.goto('/settings');
    await expect(settingsCard(pageB, 'Authenticator app')).toBeVisible();
    const sessionB = String(jwtClaims(await pageAccessToken(pageB, b.ip)).sid);

    const ended = await call('DELETE', `/api/auth/sessions/${sessionB}`, undefined, { ip: a.ip, token: await pageAccessToken(pageA, a.ip) });
    expect(ended.status).toBe(204);

    const setups = recordResponses(pageB, 'POST', '/api/auth/totp/setup');
    const refreshes = recordResponses(pageB, 'POST', '/api/auth/refresh');
    await settingsCard(pageB, 'Authenticator app').getByRole('button', { name: 'Set up an authenticator app' }).click();
    await pageB.waitForURL(`${baseURL}/login`);
    expect(setups.map((r) => r.status())).toEqual([401]);
    expect(refreshes.map((r) => r.status())).toEqual([401]);
    await expect(confirmDialog(pageB)).toHaveCount(0);
    expect(await totpRow(account.userId)).toEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

// ---- J. Security activity

test('ACCT-115 the activity lists recent events with labels', async ({ browser, baseURL }) => {
  const device = await deviceContext(browser, baseURL, CHROME_ON_MACOS);
  try {
    const account = await createAccount(device.ip, 'acct115', 'Ace Activity');
    const page = await device.context.newPage();
    await signIn(page, account);
    const totp = await enrolTotp(page, account);
    const codesCard = settingsCard(page, 'Recovery codes');
    await codesCard.getByRole('button', { name: 'Make new recovery codes' }).click();
    await confirmWithTotpCode(page, await freshTotpCode(totp));
    await expect(recoveryCodeItems(codesCard)).toHaveCount(10);

    const read = page.waitForResponse(isCall('GET', '/api/auth/activity'));
    await page.reload();
    const { data } = (await (await read).json()) as {
      data: { days: number; activity: Array<{ type: string; at: string; current: boolean; device: string | null; ipAddress: string | null }> };
    };
    expect(data.days).toBe(90);
    const types = data.activity.map((entry) => entry.type);
    expect(types.slice(0, 3)).toEqual(['recovery_codes.regenerated', 'totp.enabled', 'login.succeeded']);
    expect(types[types.length - 1]).toBe('register.succeeded');

    const card = settingsCard(page, 'Recent security activity');
    await expect(cardDescription(card)).toHaveText(
      'Sign-ins and changes to how you sign in over the last 90 days. If something here was not you, change your password and sign out other devices.',
    );
    const rows = card.getByRole('listitem');
    await expect(rows).toHaveCount(data.activity.length);
    const labels: Record<string, string> = {
      'recovery_codes.regenerated': 'New recovery codes made',
      'totp.enabled': 'Authenticator app turned on',
      'login.succeeded': 'Signed in',
      'register.succeeded': 'Account created',
      'email.verified': 'Email address confirmed',
    };
    for (const [index, entry] of data.activity.entries()) {
      const row = rows.nth(index);
      const label = labels[entry.type];
      expect(label, entry.type).toBeTruthy();
      await expect(row.locator('p').first()).toHaveText(entry.current ? `${label}This device` : label);
      await expect(row.locator('p').nth(1)).toHaveText(`${entry.device ?? 'Unknown device'} · ${entry.ipAddress ?? 'Unknown address'}`);
      await expect(row.locator('time')).toHaveAttribute('datetime', entry.at);
      await expect(row.locator('time')).toHaveText(await formatInPage(page, entry.at));
    }
    // Made in this browser: its device and "This device"; sign-up was another session.
    for (const index of [0, 1, 2]) {
      expect(data.activity[index]).toMatchObject({ current: true, device: 'Chrome on Mac OS', ipAddress: device.ip });
      await expect(rows.nth(index).getByText('This device', { exact: true })).toBeVisible();
    }
    expect(data.activity[types.length - 1].current).toBe(false);
    await expect(rows.last().getByText('This device', { exact: true })).toHaveCount(0);
  } finally {
    await device.context.close();
  }
});

test('ACCT-117 other event types are not shown', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct117');
  const hidden = ['reauth.succeeded', 'login.limited', 'refresh.failed', 'password.reset_refused'];
  const hiddenIds: string[] = [];
  for (const type of hidden) hiddenIds.push(await insertAuthEvent(account.userId, account.email, type, clientIp));
  // Control: a listed type written the same way does show.
  const shownId = await insertAuthEvent(account.userId, account.email, 'login.failed', clientIp, 'wrong_password');

  const activity = await call<{ days: number; activity: Array<{ id: string; type: string }> }>('GET', '/api/auth/activity', undefined, {
    ip: clientIp,
    token: account.accessToken,
  });
  expect(activity.status).toBe(200);
  expect(activity.body.days).toBe(90);
  expect(activity.body.activity.map((entry) => entry.id)).toContain(shownId);
  for (const type of hidden) expect(activity.body.activity.map((entry) => entry.type)).not.toContain(type);
  expect(activity.body.activity.filter((entry) => hiddenIds.includes(entry.id))).toEqual([]);
});

// ---- K. Factor reset banner

test('ACCT-126 cancel when nothing is waiting any more', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct126');
  const reset = await seedPendingFactorReset(account.userId);
  await signIn(page, account);
  await page.goto('/settings');
  const banner = resetBanner(page);
  await expect(banner).toBeVisible();
  await sql(`UPDATE factor_resets SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [reset.id]);

  const deletes = recordResponses(page, 'DELETE', '/api/auth/factor-reset');
  const reread = page.waitForResponse((r) => isCall('GET', '/api/auth/factor-reset')(r));
  await banner.getByRole('button', { name: 'Cancel' }).click();
  const toast = toastTitled(page, 'Could not cancel');
  await expect(toast).toContainText('Try again, or contact support.');
  await expect(toast).toHaveClass(/destructive/);
  expect(deletes.map((r) => r.status())).toEqual([404]);
  expect(((await deletes[0].json()) as { message: string }).message).toBe(NO_RESET);
  expect(((await (await reread).json()) as { data: unknown }).data).toEqual({ pending: null });
  await expect(banner).toHaveCount(0);
});

test('ACCT-127 no reset waiting', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct127');
  await signIn(page, account);
  const state = page.waitForResponse(isCall('GET', '/api/auth/factor-reset'));
  await page.goto('/settings');
  expect(((await (await state).json()) as { data: unknown }).data).toEqual({ pending: null });
  await expect(settingsCard(page, 'Profile Details')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const cancel = await call('DELETE', '/api/auth/factor-reset', undefined, { ip: clientIp, token: account.accessToken });
  expect(cancel.status).toBe(404);
  expect(cancel.message).toBe(NO_RESET);
});

test('ACCT-130 the banner on every page when sign-in could not cancel', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct130');
  const project = await createProject(account, clientIp);
  await seedPendingFactorReset(account.userId);
  await signIn(page, account);
  await setSessionNote(page, FACTOR_RESET_NOTE);

  await page.goto('/projects');
  const banner = resetBanner(page);
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Cancel' })).toBeVisible();
  const header = await page.locator('header').first().boundingBox();
  expect((await banner.boundingBox())!.y).toBeGreaterThanOrEqual(header!.y + header!.height);

  await page.goto(`/projects/${project.id}`);
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Cancel' })).toBeVisible();
  const main = await page.locator('main main').boundingBox();
  expect((await banner.boundingBox())!.y).toBeLessThan(main!.y);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  await expect(banner).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(1);
  // The page's own banner, inside the settings page rather than above it.
  await expect(page.locator('main').first().getByRole('alert')).toHaveCount(1);
});

test('ACCT-133 cancelling from another page', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct133');
  const reset = await seedPendingFactorReset(account.userId);
  await signIn(page, account);
  await setSessionNote(page, FACTOR_RESET_NOTE);
  await page.goto('/projects');
  const banner = resetBanner(page);
  await expect(banner).toBeVisible();
  expect(await sessionNote(page, FACTOR_RESET_NOTE)).toBe('1');

  const deletes = recordResponses(page, 'DELETE', '/api/auth/factor-reset');
  await banner.getByRole('button', { name: 'Cancel' }).click();
  await expect(toastTitled(page, 'Cancelled')).toContainText('Your second factors stay as they are.');
  await expect(banner).toHaveCount(0);
  expect(deletes.map((r) => r.status())).toEqual([204]);
  await expect.poll(() => sessionNote(page, FACTOR_RESET_NOTE)).toBeNull();
  const row = await factorResetRow(reset.id);
  expect(row.status).toBe('cancelled');
  expect(row.cancelled_by).toBe('owner');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

// ---- L. Account menu

test('ACCT-135 the account menu for a tenant', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct135', 'Mia Menu');
  const project = await createProject(account, clientIp);
  await signIn(page, account);
  const me = page.waitForResponse(isCall('GET', '/api/auth/me'));
  await page.goto(`/projects/${project.id}`);
  expect(((await (await me).json()) as { data: { billingEnabled: boolean } }).data.billingEnabled).toBe(true);
  const menu = await openSidebarAccountMenu(page, account.email);

  await expect(menu.getByText('Mia Menu', { exact: true })).toBeVisible();
  await expect(menu.getByText(account.email, { exact: true })).toBeVisible();
  await expect(menu.getByText('M', { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['LightActive', 'Dark', 'System', 'Billing', 'Account Settings', 'Log out']);
  await expect(menu.getByRole('menuitem', { name: 'Light' })).toContainText('Active');
  await expect(menu.getByText('Accent', { exact: true })).toBeVisible();
  const swatches = menu.locator('button[title]');
  await expect(swatches).toHaveCount(6);
  expect(await swatches.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('title')))).toEqual([
    'Zinc',
    'Blue',
    'Green',
    'Orange',
    'Red',
    'Violet',
  ]);
  await expect(menu.getByRole('menuitem', { name: 'Admin app' })).toHaveCount(0);
});

test('ACCT-136 the Account Settings item', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'acct136');
  const project = await createProject(account, clientIp);
  await signIn(page, account);
  await page.goto(`/projects/${project.id}`);
  await page.evaluate(() => ((window as unknown as { __e2eSameDocument: boolean }).__e2eSameDocument = true));
  const menu = await openSidebarAccountMenu(page, account.email);
  await menu.getByRole('menuitem', { name: 'Account Settings' }).click();
  await expect(page).toHaveURL(`${baseURL}/settings`);
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument)).toBe(true);
});

// ---- M. Cross-cutting

test('ACCT-145 staff tokens are refused on customer account routes', async ({ page, clientIp }) => {
  const staff = await createAccount(clientIp, 'acct145', 'Stan Staff');
  await makeSuperAdmin(staff.userId);
  const staffToken = await enrolAndSignInStaff(page, staff);
  expect(jwtClaims(staffToken).aud).toBe('chumbaq-admin');

  const routes = [
    { method: 'GET', path: '/api/auth/passkeys' },
    { method: 'GET', path: '/api/auth/sessions' },
    { method: 'PATCH', path: '/api/users/me/password', body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } },
  ];
  // Control: the person's own customer token is let through.
  expect((await call('GET', '/api/auth/sessions', undefined, { ip: clientIp, token: staff.accessToken })).status).toBe(200);
  const before = await userRow(staff.userId);
  for (const route of routes) {
    const answer = await call(route.method, route.path, route.body, { ip: clientIp, token: staffToken });
    expect(answer.status, `${route.method} ${route.path}`).toBe(401);
    expect(answer.message, `${route.method} ${route.path}`).toBe('Unauthorized');
  }
  expect((await userRow(staff.userId)).password_hash).toBe(before.password_hash);
});

test('ACCT-147 secrets are not cacheable', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct147');
  await addAuthenticator(page);
  await signIn(page, account);
  await page.goto('/settings');
  const registered = page.waitForResponse(isCall('POST', '/api/auth/passkeys'));
  const card = settingsCard(page, 'Passkeys');
  await card.getByLabel('Name', { exact: true }).fill('Cache key');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithPassword(page, PASSWORD);
  const passkey = await registered;
  expect(passkey.status()).toBe(201);
  expect(passkey.headers()['cache-control']).toBe('no-store');

  let token = await reauthWithPasskey(page, await pageAccessToken(page, clientIp), clientIp);
  const setup = await call<{ secret: string }>('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token });
  expect(setup.status).toBe(200);
  expect(setup.headers.get('cache-control')).toBe('no-store');
  const confirm = await call('POST', '/api/auth/totp/confirm', { code: nextTotpCode({ secret: setup.body.secret, recoveryCodes: [], lastStep: -1 }) }, { ip: clientIp, token });
  expect(confirm.status).toBe(200);
  expect(confirm.headers.get('cache-control')).toBe('no-store');

  token = await reauthWithPasskey(page, token, clientIp);
  const regenerated = await call('POST', '/api/auth/recovery-codes', undefined, { ip: clientIp, token });
  expect(regenerated.status).toBe(200);
  expect(regenerated.headers.get('cache-control')).toBe('no-store');
  // Control: a read of the same account is not marked so.
  const factors = await call('GET', '/api/auth/factors', undefined, { ip: clientIp, token });
  expect(factors.headers.get('cache-control')).not.toBe('no-store');
});

test('ACCT-148 the factor status matches what sign-in asks for', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct148');
  const check = async (token: string, expected: { methods: string[]; canManageRecoveryCodes: boolean; canEnrolTotp: boolean }) => {
    const factors = await call<{ methods: string[]; canManageRecoveryCodes: boolean; canEnrolTotp: boolean }>('GET', '/api/auth/factors', undefined, {
      ip: clientIp,
      token,
    });
    expect(factors.status).toBe(200);
    expect(factors.body).toMatchObject(expected);
    const login = await call<{ requiresSecondFactor?: boolean; methods?: string[]; tokens?: unknown }>(
      'POST',
      '/api/auth/login',
      { email: account.email, password: PASSWORD },
      { ip: clientIp },
    );
    expect(login.status).toBe(200);
    if (expected.methods.length === 0) {
      expect(login.body.requiresSecondFactor).toBeUndefined();
      expect(login.body.tokens).toBeTruthy();
    } else {
      expect(login.body.requiresSecondFactor).toBe(true);
      expect(login.body.methods).toEqual(expected.methods);
    }
  };

  await check(account.accessToken, { methods: [], canManageRecoveryCodes: false, canEnrolTotp: true });
  const totp = await enrolTotp({ ip: clientIp }, account);
  const token = totp.accessToken!;
  await check(token, { methods: ['totp', 'recovery_code'], canManageRecoveryCodes: true, canEnrolTotp: false });
  await seedPasskeyRow(account.userId, 'Desk key');
  await check(token, { methods: ['webauthn', 'totp', 'recovery_code'], canManageRecoveryCodes: true, canEnrolTotp: false });
  await sql('DELETE FROM totp_secrets WHERE user_id = $1', [account.userId]);
  await check(token, { methods: ['webauthn', 'recovery_code'], canManageRecoveryCodes: true, canEnrolTotp: true });
  await sql('UPDATE recovery_codes SET used_at = now() WHERE user_id = $1', [account.userId]);
  await check(token, { methods: ['webauthn'], canManageRecoveryCodes: true, canEnrolTotp: true });
});

// ---- N. Additional

test('ACCT-154 emoji passwords: the client counts code units, the API counts characters', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct154');
  const before = await userRow(account.userId);
  await signIn(page, account);
  const since = await dbNow();
  const card = settingsCard(page, 'Change Password');
  // Asserts today's behaviour as the case is written.
  for (const emoji of ['😀😀😀😀', '❤️❤️❤️❤️']) {
    expect(emoji.length).toBe(8);
    await page.goto('/settings');
    await passwordField(page, 'currentPassword').fill(PASSWORD);
    await passwordField(page, 'newPassword').fill(emoji);
    await passwordField(page, 'confirmPassword').fill(emoji);
    const patched = page.waitForResponse(isCall('PATCH', '/api/users/me/password'));
    await page.getByRole('button', { name: 'Update Password' }).click();
    const response = await patched;
    expect(response.status(), emoji).toBe(400);
    expect(((await response.json()) as { message: unknown }).message).toEqual([TOO_SHORT]);
    const toast = toastTitled(page, 'Error');
    await expect(toast).toContainText(TOO_SHORT);
    await expect(toast).toHaveClass(/destructive/);
    await expect(card.getByText(TOO_SHORT)).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings$/);
  }
  const after = await userRow(account.userId);
  expect(after.password_hash).toBe(before.password_hash);
  expect(after.session_version).toBe(before.session_version);
  expect(await authEvents(account.userId, since, 'password.changed')).toEqual([]);
  expect(await authEvents(account.userId, since, 'login.failed')).toEqual([]);
});

test('ACCT-156 a correct password change uses up a sign-in attempt', async ({ clientIp }) => {
  const wrongTimes = async (account: { accessToken: string }, ip: string) => {
    for (let attempt = 1; attempt <= 9; attempt++) {
      const answer = await call(
        'PATCH',
        '/api/users/me/password',
        { currentPassword: `wrong-password-${attempt}`, newPassword: NEW_PASSWORD },
        { ip, token: account.accessToken },
      );
      expect(answer.status, `attempt ${attempt}`).toBe(401);
      expect(answer.message).toBe('Invalid current password');
    }
  };

  // Control: nine wrong guesses alone leave the tenth sign-in free.
  const controlIp = newClientIp();
  const control = await createAccount(controlIp, 'acct156c');
  await wrongTimes(control, controlIp);
  expect((await call('POST', '/api/auth/login', { email: control.email, password: PASSWORD }, { ip: controlIp })).status).toBe(200);

  const account = await createAccount(clientIp, 'acct156');
  const since = await dbNow();
  await wrongTimes(account, clientIp);
  const changed = await call('PATCH', '/api/users/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { ip: clientIp, token: account.accessToken });
  expect(changed.status).toBe(200);

  // Asserts today's behaviour as the case is written.
  for (let attempt = 0; attempt < 2; attempt++) {
    const sameNetwork = await call('POST', '/api/auth/login', { email: account.email, password: NEW_PASSWORD }, { ip: clientIp });
    expect(sameNetwork.status).toBe(429);
    expect(sameNetwork.message).toBe(LIMITED);
  }
  const [limited] = await sql<{ count: string }>(
    `SELECT count(*) FROM auth_events WHERE lower(email) = lower($1) AND type = 'login.limited' AND created_at >= $2`,
    [account.email, since],
  );
  expect(Number(limited.count)).toBeGreaterThanOrEqual(1);
  const elsewhere = await call('POST', '/api/auth/login', { email: account.email, password: NEW_PASSWORD }, { ip: newClientIp() });
  expect(elsewhere.status).toBe(200);
});

test('ACCT-159 changing your own password does not cancel a pending factor reset', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'acct159', 'Pip Pending');
  await signIn(page, account);
  const totp = await enrolTotp(page, account);
  const reset = await seedPendingFactorReset(account.userId);
  await page.goto('/settings');
  await expect(resetBanner(page)).toBeVisible();
  const since = await dbNow();

  await passwordField(page, 'currentPassword').fill(PASSWORD);
  await passwordField(page, 'newPassword').fill(NEW_PASSWORD);
  await passwordField(page, 'confirmPassword').fill(NEW_PASSWORD);
  await setSessionNote(page, FACTOR_RESET_NOTE);
  await setSessionNote(page, STAFF_LINK_NOTE);
  const patches = recordResponses(page, 'PATCH', '/api/users/me/password');
  await page.getByRole('button', { name: 'Update Password' }).click();
  await page.waitForURL(`${baseURL}/login?passwordChanged=1`);
  expect(patches.map((r) => r.status())).toEqual([200]);
  expect(await sessionNote(page, FACTOR_RESET_NOTE)).toBe('1');
  expect(await sessionNote(page, STAFF_LINK_NOTE)).toBe('1');
  expect((await factorResetRow(reset.id)).status).toBe('pending');
  expect(await authEvents(account.userId, since, 'factors_reset.cancelled')).toEqual([]);

  await signInWithTotp(page, { email: account.email, password: NEW_PASSWORD }, totp);
  const row = await factorResetRow(reset.id);
  expect(row.status).toBe('cancelled');
  expect(row.cancelled_by).toBe('sign_in');
  const audits = await auditRowsFor(account.userId, 'account.factors_reset_cancelled');
  expect(audits).toHaveLength(1);
  expect(audits[0].metadata).toMatchObject({ cancelledBy: 'sign_in', resetId: reset.id });
  await expect.poll(() => sessionNote(page, FACTOR_RESET_NOTE)).toBeNull();
  await expect(resetBanner(page)).toHaveCount(0);
  await page.goto('/settings');
  await expect(settingsCard(page, 'Recent security activity').locator('p', { hasText: 'Removal of your second factors cancelled' })).toHaveCount(1);
  await expect(resetBanner(page)).toHaveCount(0);
});

test('ACCT-161 recovery codes outlive the last passkey after a cancelled authenticator setup', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct161', 'Rex Revive');
  await addAuthenticator(page);
  await signIn(page, account);
  const codes = await enrolTenantPasskey(page, account, 'Only key');
  expect(codes).toHaveLength(10);
  const keyId = (await passkeyRows(account.userId))[0].id;

  // 1. Start an authenticator app setup, confirmed with the passkey, and cancel it.
  const totpCard = settingsCard(page, 'Authenticator app');
  await totpCard.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await confirmWithPasskey(page);
  await expect(totpSetupKey(totpCard)).toBeVisible();
  await totpCard.getByRole('button', { name: 'Cancel' }).click();
  await expect(totpCard.getByRole('button', { name: 'Set up an authenticator app' })).toBeVisible();
  expect((await totpRow(account.userId)).map((row) => row.confirmed_at)).toEqual([null]);

  // 2. Remove the passkey: the proof the setup only checked is spent here, so no dialog.
  const passkeys = settingsCard(page, 'Passkeys');
  const deletes = recordResponses(page, 'DELETE', `/api/auth/passkeys/${keyId}`);
  await passkeys.getByRole('button', { name: 'Remove Only key' }).click();
  await expect(toastTitled(page, 'Passkey removed')).toBeVisible();
  expect(deletes.map((r) => r.status())).toEqual([204]);
  await expect(confirmDialog(page)).toHaveCount(0);
  // Asserts today's behaviour as the case is written: the codes stay.
  expect((await recoveryCodeRows(account.userId)).filter((row) => row.used_at === null)).toHaveLength(10);

  // 3. The account and the page.
  const factors = await call('GET', '/api/auth/factors', undefined, { ip: clientIp, token: await pageAccessToken(page, clientIp) });
  expect(factors.body).toMatchObject({ methods: [], canManageRecoveryCodes: false, recoveryCodesRemaining: 10, totpEnabled: false });
  await expect(passkeys.getByText('You have no passkeys yet.')).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);
  const login = await call<{ requiresSecondFactor?: boolean; tokens?: unknown }>('POST', '/api/auth/login', { email: account.email, password: PASSWORD }, { ip: newClientIp() });
  expect(login.body.requiresSecondFactor).toBeUndefined();
  expect(login.body.tokens).toBeTruthy();

  // 4. A new passkey, confirmed with the password: no new codes, the old ones count again.
  const registered = page.waitForResponse(isCall('POST', '/api/auth/passkeys'));
  await passkeys.getByLabel('Name', { exact: true }).fill('New key');
  await passkeys.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithPassword(page, PASSWORD);
  const response = await registered;
  expect(response.status()).toBe(201);
  expect('recoveryCodes' in ((await response.json()) as { data: Record<string, unknown> }).data).toBe(false);
  await expect(toastTitled(page, 'Passkey added').first()).toBeVisible();
  await expect(passkeys.getByRole('status').filter({ hasText: 'Save these now' })).toHaveCount(0);
  await expect(settingsCard(page, 'Recovery codes').getByText('You have 10 codes left.')).toBeVisible();
  const reauth = await call('POST', '/api/auth/reauth/recovery-code', { code: codes[0] }, { ip: clientIp, token: await pageAccessToken(page, clientIp) });
  expect(reauth.status).toBe(200);
});

test('ACCT-162 adding a passkey when every recovery code is used issues a new set', async ({ browser, baseURL }) => {
  test.slow();

  const expectNewSet = async (page: Page, userId: string, data: { recoveryCodes?: string[] }, before: string[]) => {
    expect(data.recoveryCodes).toHaveLength(10);
    for (const code of data.recoveryCodes!) expect(code).toMatch(RECOVERY_CODE);
    const passkeys = settingsCard(page, 'Passkeys');
    await expect(recoveryCodeItems(passkeys)).toHaveText(data.recoveryCodes!);
    await expect(passkeys.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await expect(passkeys.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await expect(toastTitled(page, 'Passkey added').first()).toBeVisible();
    await passkeys.getByRole('button', { name: 'I have saved them' }).click();
    await expect(settingsCard(page, 'Recovery codes').getByText('You have 10 codes left.')).toBeVisible();
    const rows = await recoveryCodeRows(userId);
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.used_at === null)).toBe(true);
    expect(rows.some((row) => before.includes(row.code_hash))).toBe(false);
    await page.reload();
    const activity = settingsCard(page, 'Recent security activity');
    await expect(activity.locator('p', { hasText: 'Passkey added' }).first()).toBeVisible();
    await expect(activity.locator('p', { hasText: 'New recovery codes made' })).toHaveCount(0);
  };

  // (a) Authenticator app on, every code used, no passkey: a first passkey.
  {
    const person = await newPersonContext(browser, baseURL);
    try {
      const page = await person.context.newPage();
      const account = await createAccount(person.ip, 'acct162a');
      await addAuthenticator(page);
      await signIn(page, account);
      const totp = await enrolTotp(page, account);
      await sql('UPDATE recovery_codes SET used_at = now() WHERE user_id = $1', [account.userId]);
      const before = (await recoveryCodeRows(account.userId)).map((row) => row.code_hash);
      await page.reload();
      await expect(settingsCard(page, 'Recovery codes').getByText('You have 0 codes left.')).toBeVisible();

      const card = settingsCard(page, 'Passkeys');
      const registered = page.waitForResponse(isCall('POST', '/api/auth/passkeys'));
      await card.getByLabel('Name', { exact: true }).fill('First key');
      await card.getByRole('button', { name: 'Add a passkey' }).click();
      const dialog = confirmDialog(page);
      await expect(dialog.getByLabel('Code from your authenticator app')).toBeVisible();
      await expect(dialog.getByRole('button', { name: LOST_DEVICE })).toHaveCount(0);
      await confirmWithTotpCode(page, await freshTotpCode(totp));
      const response = await registered;
      expect(response.status()).toBe(201);
      await expectNewSet(page, account.userId, ((await response.json()) as { data: { recoveryCodes?: string[] } }).data, before);
    } finally {
      await person.context.close();
    }
  }

  // (b) One passkey, every code used; (c) the same with one code left.
  for (const unusedLeft of [0, 1]) {
    const person = await newPersonContext(browser, baseURL);
    try {
      const page = await person.context.newPage();
      const account = await createAccount(person.ip, `acct162${unusedLeft ? 'c' : 'b'}`);
      const authenticator = await addAuthenticator(page);
      await signIn(page, account);
      await enrolTenantPasskey(page, account, 'Laptop');
      await sql(
        `UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash NOT IN
           (SELECT code_hash FROM recovery_codes WHERE user_id = $1 ORDER BY code_hash LIMIT $2)`,
        [account.userId, unusedLeft],
      );
      const before = (await recoveryCodeRows(account.userId)).map((row) => row.code_hash);
      await page.reload();
      const codesCard = settingsCard(page, 'Recovery codes');
      await expect(codesCard.getByText(unusedLeft ? 'You have 1 code left.' : 'You have 0 codes left.')).toBeVisible();

      const dialogOpened = confirmDialog(page).getByRole('button', { name: 'Use passkey' });
      const lostDevice = confirmDialog(page).getByRole('button', { name: LOST_DEVICE });
      const checkDialog = (async () => {
        await dialogOpened.waitFor();
        return lostDevice.count();
      })();
      const data = await addPasskeyFromAnotherDevice(page, authenticator, 'Phone');
      expect(await checkDialog).toBe(unusedLeft ? 1 : 0);
      if (unusedLeft) {
        expect('recoveryCodes' in data).toBe(false);
        await expect(toastTitled(page, 'Passkey added').first()).toBeVisible();
        await expect(settingsCard(page, 'Passkeys').getByRole('status').filter({ hasText: 'Save these now' })).toHaveCount(0);
        await expect(codesCard.getByText('You have 1 code left.')).toBeVisible();
        expect((await recoveryCodeRows(account.userId)).map((row) => row.code_hash).sort()).toEqual([...before].sort());
      } else {
        await expectNewSet(page, account.userId, data, before);
      }
      expect((await passkeyRows(account.userId)).map((row) => row.name)).toEqual(['Laptop', 'Phone']);
    } finally {
      await person.context.close();
    }
  }
});

test('ACCT-163 a super admin whose only passkeys are staff ones, on customer settings', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct163', 'Sol Staff');
  await makeSuperAdmin(account.userId);
  await signIn(page, account);
  await seedPasskeyRow(account.userId, 'Staff key 1', 'staff');
  await seedPasskeyRow(account.userId, 'Staff key 2', 'staff');

  await page.goto('/settings');
  const card = settingsCard(page, 'Passkeys');
  await expect(card.getByText('You have no passkeys yet.')).toBeVisible();
  await expect(card.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(settingsCard(page, 'Authenticator app')).toHaveCount(0);
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);

  const options = recordResponses(page, 'POST', '/api/auth/passkeys/options');
  const reauths = recordResponses(page, 'POST', '/api/auth/reauth');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  const dialog = confirmDialog(page);
  const password = dialog.getByLabel('Password');
  await password.fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(STAFF_KEYS_ONLY);

  const since = await dbNow();
  await password.fill('wrong-password');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => reauths.length).toBe(2);
  await expect(dialog.getByRole('alert')).toHaveText(STAFF_KEYS_ONLY);
  expect(reauths.map((r) => r.status())).toEqual([403, 403]);
  for (const response of reauths) expect(((await response.json()) as { message: string }).message).toBe(STAFF_KEYS_ONLY);
  expect(await authEvents(account.userId, since, 'login.failed')).toEqual([]);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'Passkey not changed')).toContainText(REAUTH);
  expect(options.map((r) => r.status())).toEqual([403]);
  expect((await passkeyRows(account.userId)).filter((row) => row.scope === 'customer')).toEqual([]);
});

test('ACCT-164 a super admin passkey without user verification is refused', async ({ page, clientIp, baseURL, browser }) => {
  test.slow();
  const origin = new URL(baseURL!).origin;
  const noUv = AUTH_DATA_FLAGS.userPresent | AUTH_DATA_FLAGS.attestedCredential;

  // Super admin, in the browser first: the options ask for user verification.
  const admin = await createAccount(clientIp, 'acct164', 'Uma Unverified');
  await makeSuperAdmin(admin.userId);
  await addAuthenticator(page, { userVerification: 'unsupported' });
  await signIn(page, admin);
  await page.goto('/settings');
  const card = settingsCard(page, 'Passkeys');
  const options = recordResponses(page, 'POST', '/api/auth/passkeys/options');
  const registers = recordResponses(page, 'POST', '/api/auth/passkeys');
  await card.getByLabel('Name', { exact: true }).fill('No UV');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmWithPassword(page, PASSWORD);
  const toast = toastTitled(page, 'Passkey not changed');
  await expect(toast).toBeVisible({ timeout: 90_000 });
  // What Chromium does: no authenticator can verify the user, so the ceremony itself fails.
  await expect(toast).toContainText(CANCELLED_PROMPT);
  expect(options.map((r) => r.status())).toEqual([403, 200]);
  expect(((await options[1].json()) as { data: { authenticatorSelection: { userVerification: string } } }).data.authenticatorSelection.userVerification).toBe(
    'required',
  );
  expect(registers).toEqual([]);

  // Then the API, with a response that does not verify the user (the browser's proof is unspent).
  const since = await dbNow();
  let token = await pageAccessToken(page, clientIp);
  const fresh = await call<{ challenge: string; rp: { id: string } }>('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token });
  expect(fresh.status).toBe(200);
  const refused = await call('POST', '/api/auth/passkeys', { response: softwareRegistration(fresh.body, origin, noUv), name: 'No UV' }, { ip: clientIp, token });
  expect(refused.status).toBe(400);
  expect(refused.message).toBe('Could not verify that passkey.');
  expect(await passkeyRows(admin.userId)).toEqual([]);
  expect(await authEvents(admin.userId, since, 'passkey.added')).toEqual([]);
  const spent = await call('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token });
  expect(spent.status).toBe(403);
  expect(spent.message).toBe(REAUTH);

  // Control: the same software key verifying the user is taken.
  token = await reauthWithPassword(token, PASSWORD, clientIp);
  const again = await call<{ challenge: string; rp: { id: string } }>('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token });
  const accepted = await call(
    'POST',
    '/api/auth/passkeys',
    { response: softwareRegistration(again.body, origin, noUv | AUTH_DATA_FLAGS.userVerified), name: 'With UV' },
    { ip: clientIp, token },
  );
  expect(accepted.status).toBe(201);
  expect((await passkeyRows(admin.userId)).map((row) => row.name)).toEqual(['With UV']);

  // A tenant: user verification is only preferred, so both ways are taken.
  const person = await newPersonContext(browser, baseURL);
  try {
    const tenantPage = await person.context.newPage();
    const tenant = await createAccount(person.ip, 'acct164t');
    await addAuthenticator(tenantPage, { userVerification: 'unsupported' });
    await signIn(tenantPage, tenant);
    await tenantPage.goto('/settings');
    const tenantCard = settingsCard(tenantPage, 'Passkeys');
    const tenantOptions = recordResponses(tenantPage, 'POST', '/api/auth/passkeys/options');
    const registered = tenantPage.waitForResponse(isCall('POST', '/api/auth/passkeys'));
    await tenantCard.getByLabel('Name', { exact: true }).fill('Plain key');
    await tenantCard.getByRole('button', { name: 'Add a passkey' }).click();
    await confirmWithPassword(tenantPage, PASSWORD);
    expect((await registered).status()).toBe(201);
    await expect(toastTitled(tenantPage, 'Passkey added')).toBeVisible();
    expect(
      ((await tenantOptions[1].json()) as { data: { authenticatorSelection: { userVerification: string } } }).data.authenticatorSelection.userVerification,
    ).toBe('preferred');

    const tenantToken = await reauthWithPasskey(tenantPage, await pageAccessToken(tenantPage, person.ip), person.ip);
    const tenantFresh = await call<{ challenge: string; rp: { id: string } }>('POST', '/api/auth/passkeys/options', undefined, {
      ip: person.ip,
      token: tenantToken,
    });
    const tenantSoftware = await call(
      'POST',
      '/api/auth/passkeys',
      { response: softwareRegistration(tenantFresh.body, origin, noUv), name: 'Software no UV' },
      { ip: person.ip, token: tenantToken },
    );
    expect(tenantSoftware.status).toBe(201);
    expect((await passkeyRows(tenant.userId)).map((row) => row.name)).toEqual(['Plain key', 'Software no UV']);
  } finally {
    await person.context.close();
  }
});

test('ACCT-170 a failing factor reset state hides the security banner', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct170');
  await signIn(page, account);
  await enrolTotp(page, account);
  await seedPendingFactorReset(account.userId);
  let failed = 0;
  const failState = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'GET') return route.continue();
    failed += 1;
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"statusCode":500,"message":"Internal server error"}' });
  };
  await page.route('**/api/auth/factor-reset', failState);

  // Expected (current code): nothing at all is shown, and the note stays.
  await page.goto('/settings');
  await expect(settingsCard(page, 'Profile Details')).toBeVisible();
  await expect.poll(() => failed).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Support will remove')).toHaveCount(0);

  await setSessionNote(page, FACTOR_RESET_NOTE);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  await expect.poll(() => failed).toBe(4);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await sessionNote(page, FACTOR_RESET_NOTE)).toBe('1');

  // Control: once the state answers, the same page shows the banner.
  await page.unroute('**/api/auth/factor-reset', failState);
  await page.reload();
  await expect(resetBanner(page)).toBeVisible();
});

test('ACCT-171 the factor reset banner date while the owner warning is unsent', async ({ browser, baseURL }) => {
  const timezoneId = 'America/New_York';
  const person = await fixedLocaleContext(browser, { baseURL, locale: 'en-US', timezoneId });
  try {
    const page = await person.context.newPage();
    const account = await createAccount(person.ip, 'acct171');
    await signIn(page, account);
    await enrolTotp(page, account);
    const [seeded] = await sql<{ id: string }>(
      `INSERT INTO factor_resets (user_id, status, requested_by_email, reason, execute_after, notice_sent_at, verification_method, verification_notes)
       VALUES ($1, 'pending', 'staff@example.com', 'Lost phone', now() + interval '72 hours', NULL, 'video_call', 'Checked on a video call')
       RETURNING id`,
      [account.userId],
    );
    const expectedText = (at: Date) =>
      `Support will remove your passkeys, authenticator app and recovery codes on ${at.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezoneId,
      })}.`;

    // Asserts today's behaviour as the case is written: the stored time, as it is.
    for (const shift of ['72 hours', '-1 hour']) {
      const [row] = await sql<{ execute_after: Date }>(
        `UPDATE factor_resets SET execute_after = now() + $2::interval WHERE id = $1 RETURNING execute_after`,
        [seeded.id, shift],
      );
      const state = page.waitForResponse(isCall('GET', '/api/auth/factor-reset'));
      await page.goto('/settings');
      const body = (await (await state).json()) as { data: { pending: { executeAfter: string } | null } };
      expect(body.data.pending?.executeAfter).toBe(row.execute_after.toISOString());
      await expect(resetBanner(page).locator('p').first()).toHaveText(expectedText(row.execute_after));
      if (shift.startsWith('-')) expect(row.execute_after.getTime()).toBeLessThan(Date.now());
    }
    expect((await factorResetRow(seeded.id)).status).toBe('pending');
  } finally {
    await person.context.close();
  }
});

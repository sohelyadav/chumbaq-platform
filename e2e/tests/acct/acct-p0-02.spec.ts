import type { Page, Response } from '@playwright/test';
import { adminUrl, enrolAndSignInStaff } from '../../support/admin';
import { createAccount, createProject, newClientIp, PASSWORD } from '../../support/api';
import { addAuthenticator, enrolTenantPasskey, enrolTotp, nextTotpCode, settingsCard } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { waitForMail } from '../../support/mailbox';
import {
  accountRoutes,
  addProjectMember,
  ageSignIns,
  apiLogMark,
  apiLogSince,
  authEvents,
  call,
  callWithAuthorization,
  CHROME_ON_MACOS,
  confirmWithPasskey,
  confirmWithTotpCode,
  dbNow,
  deviceContext,
  exchangeViewAsUrl,
  factorResetRow,
  factorSnapshot,
  FIREFOX_ON_LINUX,
  freshTotpCode,
  holdRequests,
  jwtClaims,
  makeSuperAdmin,
  markUnverified,
  openViewAs,
  pageAccessToken,
  passkeyRows,
  passwordField,
  reauthWithPassword,
  recordResponses,
  recoveryCodeRows,
  recoveryCodeSession,
  SAFARI_ON_IOS,
  seedPasskeyRow,
  seedPendingFactorReset,
  sessionRows,
  sql,
  toastTitled,
  userRow,
  viewAsHandoffUrl,
} from '../../support/areas/acct';

/**
 * Account settings, second half: removing passkeys and the registration check, devices
 * and the security activity, the factor reset banner and the owner's cancel, the account
 * menu's Admin app link, and what view-as, a missing session and a suspension get.
 */

const REAUTH = 'Confirm it is you to continue.';
const READ_ONLY = 'Impersonation sessions are read-only';
const NEW_PASSWORD = 'New-Passw0rd!';
/** An error body: no data of the account, only the error filter's fields. */
const ERROR_KEYS = ['error', 'message', 'path', 'statusCode', 'timestamp'];
const RESET_LINE_2 =
  'This was requested because your second factors were reported lost. If you did not ask for this, cancel it and contact support.';

const confirmDialog = (page: Page) => page.getByRole('dialog', { name: 'Confirm it is you' });
const pathOf = (response: Response) => new URL(response.url()).pathname;

/** The date format the settings page uses, as this browser writes it. */
function formatInPage(page: Page, iso: string): Promise<string> {
  return page.evaluate((value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), iso);
}

/** Opens the project sidebar's account menu (the button with the person's name and address). */
async function openSidebarAccountMenu(page: Page, email: string) {
  await page.locator('[data-sidebar="sidebar"]').getByRole('button').filter({ hasText: email }).click();
  return page.getByRole('menu');
}

/** Opens the header account menu of the project list (MinimalLayout). */
async function openHeaderAccountMenu(page: Page, name: string) {
  await page.locator('header').getByRole('button', { name }).click();
  return page.getByRole('menu');
}

/** A super admin signed in to the admin app in `page` with a passkey; answers the staff token. */
async function newStaff(page: Page, ip: string): Promise<string> {
  const staff = await createAccount(ip, 'acct-staff', 'Stella Staff');
  await makeSuperAdmin(staff.userId);
  return enrolAndSignInStaff(page, staff);
}

// ---- G. Passkeys

test('ACCT-085 a registration response made for another challenge or origin is refused', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct085', 'Fred Forge');
  await addAuthenticator(page);
  await signIn(page, account);
  await page.goto('/settings');

  // The browser's real registration response, kept from reaching the API.
  let captured: { response: { response: { clientDataJSON: string } } & Record<string, unknown>; name: string } | undefined;
  await page.route('**/api/auth/passkeys', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    captured = route.request().postDataJSON();
    await route.abort();
  });
  const card = settingsCard(page, 'Passkeys');
  await card.getByLabel('Name', { exact: true }).fill('Captured key');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  const dialog = confirmDialog(page);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => captured !== undefined).toBe(true);
  const original = captured!.response;

  // 1. Replayed against a newer challenge.
  let token = await pageAccessToken(page, clientIp);
  const newer = await call<{ challenge: string }>('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token });
  expect(newer.status).toBe(200);
  const mark = apiLogMark();
  const replay = await call('POST', '/api/auth/passkeys', { response: original, name: 'Replayed' }, { ip: clientIp, token });
  expect(replay.status).toBe(400);
  expect(replay.message).toBe('Could not verify that passkey.');
  expect(Object.keys(replay.body).sort()).toEqual(ERROR_KEYS);
  // The proof went with the attempt.
  expect((await call('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token })).message).toBe(REAUTH);

  // 2. The current challenge written in, from another origin.
  const editClientData = (challenge: string, origin: string) => {
    const clientData = JSON.parse(Buffer.from(original.response.clientDataJSON, 'base64url').toString('utf8'));
    const edited = Buffer.from(JSON.stringify({ ...clientData, challenge, origin })).toString('base64url');
    return { ...original, response: { ...original.response, clientDataJSON: edited } };
  };
  const pageOrigin = JSON.parse(Buffer.from(original.response.clientDataJSON, 'base64url').toString('utf8')).origin as string;
  token = await reauthWithPassword(token, PASSWORD, clientIp);
  const current = await call<{ challenge: string }>('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token });
  const forged = await call(
    'POST',
    '/api/auth/passkeys',
    { response: editClientData(current.body.challenge, 'https://elsewhere.example.test'), name: 'Forged' },
    { ip: clientIp, token },
  );
  expect(forged.status).toBe(400);
  expect(forged.message).toBe('Could not verify that passkey.');
  expect(forged.text).not.toContain('elsewhere');
  expect(await passkeyRows(account.userId)).toEqual([]);
  // Each refusal's own reason is in the server log, tied to this test by the challenge and origin it names.
  const refusals = () => apiLogSince(mark).split('\n').filter((line) => line.includes('Passkey registration refused'));
  await expect
    .poll(() => refusals().some((line) => line.includes('registration response challenge') && line.includes(newer.body.challenge)))
    .toBe(true);
  await expect
    .poll(() => refusals().some((line) => line.includes('registration response origin') && line.includes('https://elsewhere.example.test')))
    .toBe(true);

  // Control: the same edit with this app's origin is accepted, so the origin is what refused it.
  token = await reauthWithPassword(token, PASSWORD, clientIp);
  const last = await call<{ challenge: string }>('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token });
  const control = await call('POST', '/api/auth/passkeys', { response: editClientData(last.body.challenge, pageOrigin), name: 'Control' }, { ip: clientIp, token });
  expect(control.status).toBe(201);
  expect((await passkeyRows(account.userId)).map((row) => row.name)).toEqual(['Control']);
});

test('ACCT-087 remove a passkey', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct087', 'Remy Remove');
  await addAuthenticator(page);
  await signIn(page, account);
  const codes = await enrolTenantPasskey(page, account, 'Laptop');
  expect(codes).toHaveLength(10);
  await seedPasskeyRow(account.userId, 'Phone');
  // Another device, signed in with a recovery code (the password alone no longer is enough).
  const otherIp = newClientIp();
  const other = await recoveryCodeSession(account, codes[0], otherIp);
  expect((await call('GET', '/api/auth/me', undefined, { ip: otherIp, token: other })).status).toBe(200);

  await page.goto('/settings');
  const card = settingsCard(page, 'Passkeys');
  await expect(card.getByRole('button', { name: 'Remove Phone' })).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes').getByText('You have 9 codes left.')).toBeVisible();
  const since = await dbNow();
  const deletes = recordResponses(page, 'DELETE', '/api/auth/passkeys/' + (await passkeyRows(account.userId)).find((r) => r.name === 'Phone')!.id);

  await card.getByRole('button', { name: 'Remove Phone' }).click();
  await expect(confirmDialog(page)).toBeVisible();
  await confirmWithPasskey(page);

  await expect(toastTitled(page, 'Passkey removed')).toBeVisible();
  expect(deletes.map((r) => r.status())).toEqual([403, 204]);
  await expect(card.getByRole('button', { name: 'Remove Phone' })).toHaveCount(0);
  await expect(card.getByRole('listitem')).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Remove Laptop' })).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes').getByText('You have 9 codes left.')).toBeVisible();
  expect((await passkeyRows(account.userId)).map((row) => row.name)).toEqual(['Laptop']);
  expect((await recoveryCodeRows(account.userId)).filter((row) => row.used_at === null)).toHaveLength(9);
  expect(await authEvents(account.userId, since, 'passkey.removed')).toHaveLength(1);
  await page.reload();
  await expect(settingsCard(page, 'Recent security activity').locator('p', { hasText: 'Passkey removed' })).toHaveCount(1);

  const stale = await call('GET', '/api/auth/me', undefined, { ip: otherIp, token: other });
  expect(stale.status).toBe(401);
  expect(stale.message).toBe('Session has been revoked');
  const mail = await waitForMail(account.email, { subjectIncludes: 'A passkey was removed on your Chumbaq account', since });
  expect(mail.text).toContain('Phone');
});

test('ACCT-088 removing the last passkey removes the recovery codes', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct088', 'Lana Last');
  await addAuthenticator(page);
  await signIn(page, account);
  await enrolTenantPasskey(page, account, 'Only key');
  expect(await recoveryCodeRows(account.userId)).toHaveLength(10);

  await page.goto('/settings');
  const card = settingsCard(page, 'Passkeys');
  await expect(settingsCard(page, 'Recovery codes')).toBeVisible();
  await card.getByRole('button', { name: 'Remove Only key' }).click();
  await confirmWithPasskey(page);
  await expect(toastTitled(page, 'Passkey removed')).toBeVisible();

  await expect(card.getByText('You have no passkeys yet.')).toBeVisible();
  await expect(settingsCard(page, 'Recovery codes')).toHaveCount(0);
  expect(await recoveryCodeRows(account.userId)).toEqual([]);
  const token = await pageAccessToken(page, clientIp);
  const factors = await call<{ methods: string[]; canManageRecoveryCodes: boolean }>('GET', '/api/auth/factors', undefined, { ip: clientIp, token });
  expect(factors.body.methods).toEqual([]);
  expect(factors.body.canManageRecoveryCodes).toBe(false);
  const login = await call<{ requiresSecondFactor?: boolean; tokens?: unknown }>(
    'POST',
    '/api/auth/login',
    { email: account.email, password: PASSWORD },
    { ip: newClientIp() },
  );
  expect(login.status).toBe(200);
  expect(login.body.requiresSecondFactor).toBeUndefined();
  expect(login.body.tokens).toBeTruthy();
});

test("ACCT-090 another person's or an unknown passkey cannot be removed", async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'acct090a');
  const ipB = newClientIp();
  const b = await createAccount(ipB, 'acct090b');
  const totp = await enrolTotp({ ip: clientIp }, a);
  await seedPasskeyRow(a.userId, 'A key');
  const bKey = await seedPasskeyRow(b.userId, 'B key');
  const listedB = await call<{ passkeys: Array<{ id: string }> }>('GET', '/api/auth/passkeys', undefined, { ip: ipB, token: b.accessToken });
  expect(listedB.body.passkeys.map((key) => key.id)).toEqual([bKey]);

  const reauthTotp = await call<{ accessToken: string }>('POST', '/api/auth/reauth/totp', { code: nextTotpCode(totp) }, { ip: clientIp, token: totp.accessToken });
  expect(reauthTotp.status).toBe(200);
  let token = reauthTotp.body.accessToken;
  const theirs = await call('DELETE', `/api/auth/passkeys/${bKey}`, undefined, { ip: clientIp, token });
  expect(theirs.status).toBe(404);
  expect(theirs.message).toBe('Passkey not found');
  expect((await passkeyRows(b.userId)).map((row) => row.id)).toEqual([bKey]);
  // The proof was spent by the refused attempt.
  const unknownId = '0b6a9a8e-3f0c-4a51-9d0e-6c2f3f9a1b2c';
  expect((await call('DELETE', `/api/auth/passkeys/${unknownId}`, undefined, { ip: clientIp, token })).message).toBe(REAUTH);

  const reauthCode = await call<{ accessToken: string }>('POST', '/api/auth/reauth/recovery-code', { code: totp.recoveryCodes[0] }, { ip: clientIp, token });
  expect(reauthCode.status).toBe(200);
  token = reauthCode.body.accessToken;
  const unknown = await call('DELETE', `/api/auth/passkeys/${unknownId}`, undefined, { ip: clientIp, token });
  expect(unknown.status).toBe(404);
  expect(unknown.message).toBe('Passkey not found');

  const malformed = await call('DELETE', '/api/auth/passkeys/not-a-uuid', undefined, { ip: clientIp, token });
  expect(malformed.status).toBe(400);
  expect(malformed.message).toBe('Validation failed (uuid is expected)');
  expect((await passkeyRows(a.userId)).map((row) => row.name)).toEqual(['A key']);
  expect((await passkeyRows(b.userId)).map((row) => row.id)).toEqual([bKey]);
});

test("ACCT-091 the passkeys list is the caller's customer keys only", async ({ page, clientIp }) => {
  const admin = await createAccount(clientIp, 'acct091', 'Sue Super');
  await makeSuperAdmin(admin.userId);
  await enrolAndSignInStaff(page, admin);
  const customerKey = await seedPasskeyRow(admin.userId, 'Customer key');
  const ipB = newClientIp();
  const b = await createAccount(ipB, 'acct091b');
  await seedPasskeyRow(b.userId, 'B key');
  expect((await passkeyRows(admin.userId)).map((row) => row.scope).sort()).toEqual(['customer', 'staff']);

  const listed = await call<{ canEnrol: boolean; passkeys: Array<Record<string, unknown>> }>('GET', '/api/auth/passkeys', undefined, {
    ip: clientIp,
    token: admin.accessToken,
  });
  expect(listed.status).toBe(200);
  expect(listed.body.passkeys).toHaveLength(1);
  expect(listed.body.passkeys[0]).toMatchObject({ id: customerKey, name: 'Customer key', deviceType: 'singleDevice', backedUp: false, lastUsedAt: null });
  expect(Object.keys(listed.body.passkeys[0]).sort()).toEqual(['backedUp', 'createdAt', 'deviceType', 'id', 'lastUsedAt', 'name']);
  expect(listed.text).not.toContain('B key');
  expect(listed.text).not.toContain('E2E virtual authenticator');
});

test('ACCT-094 an unverified address cannot add a passkey', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct094', 'Una Verified');
  await markUnverified(account.userId);
  await signIn(page, account);
  const listed = page.waitForResponse((r) => pathOf(r) === '/api/auth/passkeys' && r.request().method() === 'GET');
  await page.goto('/settings');
  const body = (await (await listed).json()) as { data: { canEnrol: boolean; passkeys: unknown[] } };
  expect(body.data).toEqual({ canEnrol: false, passkeys: [] });
  await expect(settingsCard(page, 'Change Password')).toBeVisible();
  await expect(settingsCard(page, 'Passkeys')).toHaveCount(0);

  const token = await reauthWithPassword(account.accessToken, PASSWORD, clientIp);
  const options = await call('POST', '/api/auth/passkeys/options', undefined, { ip: clientIp, token });
  expect(options.status).toBe(403);
  expect(options.message).toBe('Verify your email address before adding a passkey.');
});

// ---- H. Super admin

test('ACCT-100 a super admin cannot remove the last customer passkey', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct100', 'Sam Super');
  await addAuthenticator(page);
  await signIn(page, account);
  await enrolTenantPasskey(page, account, 'Only key');
  await makeSuperAdmin(account.userId);
  await page.goto('/settings');
  const card = settingsCard(page, 'Passkeys');
  const onlyId = (await passkeyRows(account.userId))[0].id;
  const refused = recordResponses(page, 'DELETE', `/api/auth/passkeys/${onlyId}`);

  await card.getByRole('button', { name: 'Remove Only key' }).click();
  await confirmWithPasskey(page);
  const toast = toastTitled(page, 'Passkey not changed');
  await expect(toast).toContainText('Staff accounts must keep a second factor here. Add another passkey before removing this one.');
  expect(refused.map((r) => r.status())).toEqual([403, 409]);
  await expect(card.getByRole('button', { name: 'Remove Only key' })).toBeVisible();
  expect((await passkeyRows(account.userId)).map((row) => row.name)).toEqual(['Only key']);

  // With a second key, removing one works.
  const spareId = await seedPasskeyRow(account.userId, 'Spare key');
  await page.reload();
  const removed = recordResponses(page, 'DELETE', `/api/auth/passkeys/${spareId}`);
  await card.getByRole('button', { name: 'Remove Spare key' }).click();
  await confirmWithPasskey(page);
  await expect(toastTitled(page, 'Passkey removed')).toBeVisible();
  expect(removed.map((r) => r.status())).toEqual([403, 204]);
  expect((await passkeyRows(account.userId)).map((row) => row.name)).toEqual(['Only key']);
});

// ---- I. Devices

test('ACCT-106 sign out one other device', async ({ browser, baseURL }) => {
  const a = await deviceContext(browser, baseURL, CHROME_ON_MACOS);
  const b = await deviceContext(browser, baseURL, FIREFOX_ON_LINUX);
  try {
    const account = await createAccount(a.ip, 'acct106', 'Dev Ices');
    const pageA = await a.context.newPage();
    const pageB = await b.context.newPage();
    await signIn(pageA, account);
    await signIn(pageB, account);
    const tokenB = await pageAccessToken(pageB, b.ip);
    const sessionB = String(jwtClaims(tokenB).sid);

    await pageA.goto('/settings');
    const card = settingsCard(pageA, "Where you're signed in");
    const rowB = card.getByRole('listitem').filter({ hasText: 'Firefox on Linux' });
    await expect(rowB).toContainText(b.ip);
    await expect(card.getByRole('listitem').filter({ hasText: 'Chrome on Mac OS' })).toContainText('This device');
    const deleted = recordResponses(pageA, 'DELETE', `/api/auth/sessions/${sessionB}`);
    await card.getByRole('button', { name: 'Sign out Firefox on Linux' }).click();

    await expect(toastTitled(pageA, 'Device signed out')).toBeVisible();
    expect(deleted.map((r) => r.status())).toEqual([204]);
    await expect(rowB).toHaveCount(0);
    const activity = settingsCard(pageA, 'Recent security activity');
    const entry = activity.getByRole('listitem').filter({ hasText: 'Signed out another device' });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('This device');
    const [row] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE id = $1', [sessionB]);
    expect(row.revoked_at).not.toBeNull();

    const late = await call('GET', '/api/auth/me', undefined, { ip: b.ip, token: tokenB });
    expect(late.status).toBe(401);
    expect(late.message).toBe('Session has been revoked');
    const refreshes = recordResponses(pageB, 'POST', '/api/auth/refresh');
    await pageB.reload();
    await expect(pageB).toHaveURL(`${baseURL}/login`);
    expect(refreshes.length).toBeGreaterThan(0);
    expect(refreshes.every((r) => r.status() === 401)).toBe(true);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('ACCT-108 sign out all other devices', async ({ browser, baseURL }) => {
  const a = await deviceContext(browser, baseURL, CHROME_ON_MACOS);
  const b = await deviceContext(browser, baseURL, FIREFOX_ON_LINUX);
  const c = await deviceContext(browser, baseURL, SAFARI_ON_IOS);
  try {
    const account = await createAccount(a.ip, 'acct108', 'Al Others');
    const pageA = await a.context.newPage();
    const pageB = await b.context.newPage();
    const pageC = await c.context.newPage();
    await signIn(pageA, account);
    await signIn(pageB, account);
    await signIn(pageC, account);
    const tokenB = await pageAccessToken(pageB, b.ip);
    const tokenC = await pageAccessToken(pageC, c.ip);
    const since = await dbNow();

    await pageA.goto('/settings');
    const card = settingsCard(pageA, "Where you're signed in");
    // A, B, C and the session the account was created with.
    await expect(card.getByRole('listitem')).toHaveCount(4);
    const release = await holdRequests(pageA, 'DELETE', '/api/auth/sessions');
    const deleted = recordResponses(pageA, 'DELETE', '/api/auth/sessions');
    await card.getByRole('button', { name: 'Sign out all other devices' }).click();
    await expect(card.getByRole('button', { name: 'Signing out...' })).toBeDisabled();
    release();

    await expect(toastTitled(pageA, 'Other devices signed out')).toBeVisible();
    expect(deleted.map((r) => r.status())).toEqual([204]);
    await expect(card.getByRole('listitem')).toHaveCount(1);
    await expect(card.getByRole('listitem')).toContainText('This device');
    await expect(card.getByRole('button', { name: 'Sign out all other devices' })).toHaveCount(0);
    expect(await authEvents(account.userId, since, 'sessions.revoked_others')).toHaveLength(1);
    await expect(settingsCard(pageA, 'Recent security activity').locator('p', { hasText: 'Signed out all other devices' })).toHaveCount(1);

    for (const [ip, token] of [[b.ip, tokenB], [c.ip, tokenC], [a.ip, account.accessToken]]) {
      const late = await call('GET', '/api/auth/me', undefined, { ip, token });
      expect(late.status).toBe(401);
      expect(late.message).toBe('Session has been revoked');
    }
    await pageC.reload();
    await expect(pageC).toHaveURL(`${baseURL}/login`);
    expect((await call('GET', '/api/auth/me', undefined, { ip: a.ip, token: await pageAccessToken(pageA, a.ip) })).status).toBe(200);
  } finally {
    await a.context.close();
    await b.context.close();
    await c.context.close();
  }
});

test("ACCT-111 another account's session cannot be ended", async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'acct111a');
  const ipB = newClientIp();
  const b = await createAccount(ipB, 'acct111b');
  const sessionsB = await call<Array<{ id: string; current: boolean }>>('GET', '/api/auth/sessions', undefined, { ip: ipB, token: b.accessToken });
  const idB = sessionsB.body.find((session) => session.current)!.id;

  const theirs = await call('DELETE', `/api/auth/sessions/${idB}`, undefined, { ip: clientIp, token: a.accessToken });
  expect(theirs.status).toBe(404);
  expect(theirs.message).toBe('That session has already ended.');
  const unknown = await call('DELETE', '/api/auth/sessions/0b6a9a8e-3f0c-4a51-9d0e-6c2f3f9a1b2c', undefined, { ip: clientIp, token: a.accessToken });
  expect(unknown.status).toBe(404);
  expect(unknown.message).toBe(theirs.message);
  expect((await call('GET', '/api/auth/me', undefined, { ip: ipB, token: b.accessToken })).status).toBe(200);
  expect((await sessionRows(b.userId)).every((row) => row.revoked_at === null)).toBe(true);

  const malformed = await call('DELETE', '/api/auth/sessions/abc', undefined, { ip: clientIp, token: a.accessToken });
  expect(malformed.status).toBe(400);
  expect(malformed.message).toBe('Validation failed (uuid is expected)');
});

// ---- J. Security activity

test('ACCT-118 the activity never exposes reasons or addresses of the account', async ({ clientIp }) => {
  const account = await createAccount(clientIp, 'acct118');
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = await call('POST', '/api/auth/login', { email: account.email, password: `wrong-${attempt}` }, { ip: clientIp });
    expect(failed.status).toBe(401);
  }
  const [{ reasons }] = await sql<{ reasons: string[] }>(
    `SELECT array_agg(reason) AS reasons FROM auth_events WHERE user_id = $1 AND type = 'login.failed'`,
    [account.userId],
  );
  expect(reasons).toEqual(['wrong_password', 'wrong_password']);

  const activity = await call<{ days: number; activity: Array<Record<string, unknown>> }>('GET', '/api/auth/activity', undefined, {
    ip: clientIp,
    token: account.accessToken,
  });
  expect(activity.status).toBe(200);
  expect(activity.body.days).toBe(90);
  expect(activity.body.activity.filter((entry) => entry.type === 'login.failed')).toHaveLength(2);
  for (const entry of activity.body.activity) {
    expect(Object.keys(entry).sort()).toEqual(['at', 'current', 'device', 'id', 'ipAddress', 'type']);
  }
  expect(activity.text).not.toContain('wrong_password');
  expect(activity.text).not.toContain(account.email);
  expect(activity.text).not.toContain(account.userId);
});

test('ACCT-120 the activity is per account', async ({ page, clientIp }) => {
  const a = await createAccount(clientIp, 'acct120a');
  const ipB = newClientIp();
  const b = await createAccount(ipB, 'acct120b');
  expect((await call('POST', '/api/auth/login', { email: b.email, password: 'wrong-password' }, { ip: ipB })).status).toBe(401);
  await enrolTotp({ ip: ipB }, b);
  // Someone else fails a sign-in against A's address.
  const strangerIp = newClientIp();
  expect((await call('POST', '/api/auth/login', { email: a.email, password: 'wrong-password' }, { ip: strangerIp })).status).toBe(401);

  const [{ ids: bIds }] = await sql<{ ids: string[] }>('SELECT array_agg(id::text) AS ids FROM auth_events WHERE user_id = $1', [b.userId]);
  expect(bIds.length).toBeGreaterThanOrEqual(3);
  const listed = await call<{ activity: Array<{ id: string; type: string; ipAddress: string | null }> }>('GET', '/api/auth/activity', undefined, {
    ip: clientIp,
    token: a.accessToken,
  });
  expect(listed.status).toBe(200);
  expect(listed.body.activity.some((entry) => bIds.includes(entry.id))).toBe(false);
  expect(listed.body.activity.map((entry) => entry.type)).not.toContain('totp.enabled');
  const failed = listed.body.activity.filter((entry) => entry.type === 'login.failed');
  expect(failed).toHaveLength(1);
  expect(failed[0].ipAddress).toBe(strangerIp);

  // A's settings page names the stranger's attempt, and nothing of B's.
  await signIn(page, a);
  await page.goto('/settings');
  const activity = settingsCard(page, 'Recent security activity');
  const attempt = activity.getByRole('listitem').filter({ hasText: 'Sign-in attempt failed' });
  await expect(attempt).toHaveCount(1);
  await expect(attempt).toContainText(strangerIp);
  await expect(activity.getByRole('listitem').filter({ hasText: ipB })).toHaveCount(0);
});

// ---- K. Factor reset banner

test('ACCT-124 the pending reset banner on settings', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct124', 'Bea Banner');
  await signIn(page, account);
  await enrolTotp(page, account);
  const reset = await seedPendingFactorReset(account.userId);

  const state = page.waitForResponse((r) => pathOf(r) === '/api/auth/factor-reset' && r.request().method() === 'GET');
  await page.goto('/settings');
  const body = (await (await state).json()) as { data: unknown };
  expect(body.data).toEqual({ pending: { requestedAt: reset.requestedAt.toISOString(), executeAfter: reset.executeAfter.toISOString() } });

  const banner = page.getByRole('alert').filter({ hasText: 'Support will remove' });
  const when = await formatInPage(page, reset.executeAfter.toISOString());
  await expect(banner.locator('p').first()).toHaveText(`Support will remove your passkeys, authenticator app and recovery codes on ${when}.`);
  await expect(banner.locator('p').nth(1)).toHaveText(RESET_LINE_2);
  const cancel = banner.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeEnabled();
  await expect(cancel).toHaveClass(/destructive/);
  // Above the cards.
  const bannerBox = await banner.boundingBox();
  const firstCard = await settingsCard(page, 'Profile Details').boundingBox();
  expect(bannerBox!.y).toBeLessThan(firstCard!.y);
  expect(JSON.stringify(body)).not.toMatch(/staff@example\.com|Lost phone|video|Checked/);
});

test('ACCT-125 the owner cancels the reset', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct125', 'Cass Cancel');
  await signIn(page, account);
  await enrolTotp(page, account);
  const before = await factorSnapshot(account.userId);
  const reset = await seedPendingFactorReset(account.userId);
  await ageSignIns(account.userId);
  await page.goto('/settings');
  const token = await pageAccessToken(page, clientIp);
  expect(Date.now() / 1000 - Number(jwtClaims(token).auth_time)).toBeGreaterThan(15 * 60);
  const since = await dbNow();

  const banner = page.getByRole('alert').filter({ hasText: 'Support will remove' });
  const release = await holdRequests(page, 'DELETE', '/api/auth/factor-reset');
  const deleted = recordResponses(page, 'DELETE', '/api/auth/factor-reset');
  await banner.getByRole('button', { name: 'Cancel' }).click();
  await expect(banner.getByRole('button', { name: 'Cancelling...' })).toBeDisabled();
  release();

  await expect(toastTitled(page, 'Cancelled')).toContainText('Your second factors stay as they are.');
  await expect(banner).toHaveCount(0);
  expect(deleted.map((r) => r.status())).toEqual([204]);
  await expect(confirmDialog(page)).toHaveCount(0);
  const row = await factorResetRow(reset.id);
  expect(row.status).toBe('cancelled');
  expect(row.cancelled_by).toBe('owner');
  expect(row.cancelled_at).not.toBeNull();
  const audit = await sql<{ actor_id: string; metadata: Record<string, unknown> }>(
    `SELECT actor_id, metadata FROM admin_audit_logs WHERE action = 'account.factors_reset_cancelled' AND target_id = $1`,
    [account.userId],
  );
  expect(audit).toHaveLength(1);
  expect(audit[0].actor_id).toBe(account.userId);
  expect(audit[0].metadata).toMatchObject({ cancelledBy: 'owner', resetId: reset.id });
  expect(await authEvents(account.userId, since, 'factors_reset.cancelled')).toEqual([{ type: 'factors_reset.cancelled', reason: 'owner' }]);
  await expect(settingsCard(page, 'Recent security activity').locator('p', { hasText: 'Removal of your second factors cancelled' })).toHaveCount(1);
  await waitForMail(account.email, { subjectIncludes: 'The removal of your Chumbaq second factors was cancelled', since });
  const after = await factorSnapshot(account.userId);
  expect(after).toEqual(before);
});

test('ACCT-129 using a factor on the settings page cancels a pending reset', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'acct129', 'Fay Factor');
  await signIn(page, account);
  const totp = await enrolTotp(page, account);
  const reset = await seedPendingFactorReset(account.userId);
  await page.goto('/settings');
  const banner = page.getByRole('alert').filter({ hasText: 'Support will remove' });
  await expect(banner).toBeVisible();
  const since = await dbNow();

  await settingsCard(page, 'Recovery codes').getByRole('button', { name: 'Make new recovery codes' }).click();
  await confirmWithTotpCode(page, await freshTotpCode(totp));
  await expect(page.getByText('Save these now', { exact: false })).toBeVisible();

  const row = await factorResetRow(reset.id);
  expect(row.status).toBe('cancelled');
  expect(row.cancelled_by).toBe('sign_in');
  const [user] = await sql<{ last_factor_sign_in_at: Date | null }>('SELECT last_factor_sign_in_at FROM users WHERE id = $1', [account.userId]);
  expect(user.last_factor_sign_in_at).not.toBeNull();
  expect(user.last_factor_sign_in_at!.getTime()).toBeGreaterThanOrEqual(since.getTime());
  expect(await authEvents(account.userId, since, 'factors_reset.cancelled')).toEqual([{ type: 'factors_reset.cancelled', reason: 'sign_in' }]);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  await expect(settingsCard(page, 'Recent security activity').locator('p', { hasText: 'Removal of your second factors cancelled' })).toHaveCount(1);
  await expect(banner).toHaveCount(0);
});

// ---- L. Account menu

test('ACCT-137 the Admin app link for super admins', async ({ page, clientIp, context }) => {
  const account = await createAccount(clientIp, 'acct137', 'Ada Admin');
  const project = await createProject(account, clientIp);
  await makeSuperAdmin(account.userId);
  await signIn(page, account);
  const adminOrigin = adminUrl('');

  await page.goto(`/projects/${project.id}`);
  let menu = await openSidebarAccountMenu(page, account.email);
  let link = menu.getByRole('menuitem', { name: 'Admin app' });
  await expect(link).toHaveAttribute('href', adminOrigin);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await page.keyboard.press('Escape');

  await page.goto('/projects');
  menu = await openHeaderAccountMenu(page, account.name);
  link = menu.getByRole('menuitem', { name: 'Admin app' });
  await expect(link).toHaveAttribute('href', adminOrigin);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const [adminTab] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await adminTab.waitForURL(`${adminOrigin}/sign-in**`);
  await expect(adminTab.getByText('Chumbaq admin')).toBeVisible();
  await expect(adminTab.getByLabel('Email')).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  await adminTab.close();
});

test('ACCT-138 no Admin app link for anyone else', async ({ page, clientIp, browser, baseURL }) => {
  const owner = await createAccount(clientIp, 'acct138o', 'Ola Owner');
  const project = await createProject(owner, clientIp);
  const adminIp = newClientIp();
  const memberIp = newClientIp();
  const admin = await createAccount(adminIp, 'acct138a', 'Adi Admin');
  const member = await createAccount(memberIp, 'acct138m', 'Mo Member');
  await addProjectMember(project.id, admin.userId, 'admin', owner.userId);
  await addProjectMember(project.id, member.userId, 'member', owner.userId);

  const checkMenus = async (tab: Page, person: { email: string; name: string }) => {
    await tab.goto(`/projects/${project.id}`);
    const sidebarMenu = await openSidebarAccountMenu(tab, person.email);
    await expect(sidebarMenu.getByRole('menuitem', { name: 'Account Settings' })).toBeVisible();
    await expect(sidebarMenu.getByRole('menuitem', { name: 'Admin app' })).toHaveCount(0);
    await tab.keyboard.press('Escape');
    await tab.goto('/projects');
    const headerMenu = await openHeaderAccountMenu(tab, person.name);
    await expect(headerMenu.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
    await expect(headerMenu.getByRole('menuitem', { name: 'Admin app' })).toHaveCount(0);
    await tab.keyboard.press('Escape');
  };

  for (const person of [owner, admin, member]) {
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const tab = await context.newPage();
      await signIn(tab, person);
      await checkMenus(tab, person);
    } finally {
      await context.close();
    }
  }

  // View-as (of the owner, who is no super admin: view-as of one is refused).
  const staffToken = await newStaff(page, newClientIp());
  const viewAs = await newPersonContext(browser, baseURL);
  try {
    const tab = await viewAs.context.newPage();
    await openViewAs(tab, await viewAsHandoffUrl(staffToken, owner.userId, viewAs.ip));
    await checkMenus(tab, owner);
    await expect(tab.getByRole('region', { name: 'Impersonation session' })).toBeVisible();
  } finally {
    await viewAs.context.close();
  }
});

// ---- M. Cross-cutting

test('ACCT-141 settings in view-as is read-only and private', async ({ page, clientIp, browser, baseURL }) => {
  const tenant = await createAccount(clientIp, 'acct141', 'Tia Tenant');
  await enrolTotp({ ip: clientIp }, tenant);
  await seedPasskeyRow(tenant.userId, 'Tenant key');
  await seedPendingFactorReset(tenant.userId);
  const staffToken = await newStaff(page, newClientIp());

  const viewAs = await newPersonContext(browser, baseURL);
  try {
    const tab = await viewAs.context.newPage();
    const private_: string[] = [];
    tab.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (/^\/api\/auth\/(factors|passkeys|sessions|activity|factor-reset)/.test(pathname)) private_.push(`${request.method()} ${pathname}`);
    });
    await openViewAs(tab, await viewAsHandoffUrl(staffToken, tenant.userId, viewAs.ip));
    const me = tab.waitForResponse((r) => pathOf(r) === '/api/auth/me');
    await tab.goto('/settings');
    await me;
    await expect(tab.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
    const profile = settingsCard(tab, 'Profile Details');
    await expect(profile.locator('input').nth(0)).toHaveValue(tenant.name);
    await expect(profile.locator('input').nth(1)).toHaveValue(tenant.email);
    await expect(settingsCard(tab, 'Change Password')).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Update Password' })).toBeVisible();
    for (const title of ['Authenticator app', 'Passkeys', 'Recovery codes', "Where you're signed in", 'Recent security activity']) {
      await expect(settingsCard(tab, title), title).toHaveCount(0);
    }
    await expect(tab.getByText('Support will remove')).toHaveCount(0);
    await expect(tab.getByRole('region', { name: 'Impersonation session' })).toBeVisible();
    expect(private_).toEqual([]);
  } finally {
    await viewAs.context.close();
  }
});

test('ACCT-142 a password change is refused in view-as', async ({ page, clientIp, browser, baseURL }) => {
  const tenant = await createAccount(clientIp, 'acct142', 'Pat Password');
  const before = await userRow(tenant.userId);
  const staffToken = await newStaff(page, newClientIp());
  const viewAs = await newPersonContext(browser, baseURL);
  try {
    const tab = await viewAs.context.newPage();
    await openViewAs(tab, await viewAsHandoffUrl(staffToken, tenant.userId, viewAs.ip));
    await tab.goto('/settings');
    await expect(tab.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
    const since = await dbNow();
    const patches = recordResponses(tab, 'PATCH', '/api/users/me/password');

    await passwordField(tab, 'currentPassword').fill(PASSWORD);
    await passwordField(tab, 'newPassword').fill(NEW_PASSWORD);
    await passwordField(tab, 'confirmPassword').fill(NEW_PASSWORD);
    await tab.getByRole('button', { name: 'Update Password' }).click();

    await expect(toastTitled(tab, 'Read-only session')).toContainText(READ_ONLY);
    await expect(toastTitled(tab, 'Error')).toContainText(READ_ONLY);
    expect(patches.map((r) => r.status())).toEqual([403]);
    expect(((await patches[0].json()) as { message: string }).message).toBe(READ_ONLY);
    await expect(tab).toHaveURL(/\/settings$/);
    await expect(tab.getByRole('region', { name: 'Impersonation session' })).toBeVisible();
    const after = await userRow(tenant.userId);
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.session_version).toBe(before.session_version);
    expect(await authEvents(tenant.userId, since, 'login.failed')).toEqual([]);
    expect(await authEvents(tenant.userId, since, 'password.changed')).toEqual([]);
  } finally {
    await viewAs.context.close();
  }
});

test('ACCT-143 every account route refuses a view-as token', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'acct143', 'Vic Viewed');
  const passkeyId = await seedPasskeyRow(tenant.userId, 'Tenant key');
  const reset = await seedPendingFactorReset(tenant.userId);
  const [session] = await sessionRows(tenant.userId);
  const before = { user: await userRow(tenant.userId), factors: await factorSnapshot(tenant.userId), sessions: await sessionRows(tenant.userId) };
  const staffToken = await newStaff(page, newClientIp());
  const viewIp = newClientIp();
  const token = await exchangeViewAsUrl(await viewAsHandoffUrl(staffToken, tenant.userId, viewIp), viewIp);
  expect(jwtClaims(token).imp).toBeTruthy();

  for (const route of accountRoutes({ sessionId: session.id, passkeyId })) {
    const answer = await call(route.method, route.path, route.body, { ip: viewIp, token });
    expect(answer.status, `${route.method} ${route.path}`).toBe(403);
    expect(answer.message, `${route.method} ${route.path}`).toBe(READ_ONLY);
    expect(Object.keys(answer.body).sort(), `${route.method} ${route.path}`).toEqual(ERROR_KEYS);
  }

  expect(await userRow(tenant.userId)).toEqual(before.user);
  expect(await factorSnapshot(tenant.userId)).toEqual(before.factors);
  expect(await sessionRows(tenant.userId)).toEqual(before.sessions);
  expect((await factorResetRow(reset.id)).status).toBe('pending');
});

test('ACCT-144 every account route needs a session', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'acct144');
  const passkeyId = await seedPasskeyRow(tenant.userId, 'Tenant key');
  const [session] = await sessionRows(tenant.userId);
  const before = { user: await userRow(tenant.userId), factors: await factorSnapshot(tenant.userId), sessions: await sessionRows(tenant.userId) };
  for (const authorization of [undefined, 'Bearer abc']) {
    for (const route of accountRoutes({ sessionId: session.id, passkeyId })) {
      const label = `${route.method} ${route.path} with ${authorization ?? 'no token'}`;
      const answer = await callWithAuthorization(route.method, route.path, route.body, clientIp, authorization);
      expect(answer.status, label).toBe(401);
      expect(answer.body?.data, label).toBeUndefined();
      expect(answer.message, label).toBe('Unauthorized');
    }
  }
  expect(await userRow(tenant.userId)).toEqual(before.user);
  expect(await factorSnapshot(tenant.userId)).toEqual(before.factors);
  expect(await sessionRows(tenant.userId)).toEqual(before.sessions);
});

test('ACCT-146 a suspended account is signed out of settings', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'acct146', 'Sus Pended');
  await signIn(page, account);
  await page.goto('/settings');
  const card = settingsCard(page, "Where you're signed in");
  // The session the account was created with, through the API (no browser name).
  const otherDevice = card.getByRole('button', { name: 'Sign out unknown device' });
  await expect(otherDevice).toBeVisible();
  const before = await sessionRows(account.userId);
  await sql('UPDATE users SET suspended_at = now() WHERE id = $1', [account.userId]);
  // Read on the way through: the page navigates away at once.
  const deletes: Array<{ status: number; message: string }> = [];
  await page.route('**/api/auth/sessions/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    const response = await route.fetch();
    deletes.push({ status: response.status(), message: ((await response.json()) as { message: string }).message });
    await route.fulfill({ response });
  });

  await otherDevice.click();
  // Polled rather than a load event: the sign-out can start a second navigation that
  // aborts the first page load.
  await expect(page).toHaveURL(`${baseURL}/login?suspended=1`);
  await expect(page.getByRole('alert')).toHaveText(
    'This account has been suspended, so you have been signed out. Contact support if you think this is a mistake.',
  );
  expect(deletes).toEqual([{ status: 403, message: 'Account suspended' }]);
  expect(await sessionRows(account.userId)).toEqual(before);
});

// ---- N. Additional

test('ACCT-158 changing the password needs no second factor and keeps the factors', async ({ page, clientIp, baseURL }) => {
  const account = await createAccount(clientIp, 'acct158', 'Kip Keeps');
  await signIn(page, account);
  await enrolTotp(page, account);
  await seedPasskeyRow(account.userId, 'Desk key');
  const before = await factorSnapshot(account.userId);
  expect(before.recoveryCodes).toHaveLength(10);
  expect(before.totp).toHaveLength(1);
  expect(before.passwordResetAt).toBeNull();

  await ageSignIns(account.userId);
  await page.goto('/settings');
  const token = await pageAccessToken(page, clientIp);
  const control = await call('POST', '/api/auth/totp/setup', undefined, { ip: clientIp, token });
  expect(control.status).toBe(403);
  expect(control.message).toBe(REAUTH);

  const patches = recordResponses(page, 'PATCH', '/api/users/me/password');
  await passwordField(page, 'currentPassword').fill(PASSWORD);
  await passwordField(page, 'newPassword').fill(NEW_PASSWORD);
  await passwordField(page, 'confirmPassword').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Update Password' }).click();
  await page.waitForURL(`${baseURL}/login?passwordChanged=1`);
  expect(patches.map((r) => r.status())).toEqual([200]);
  expect(await factorSnapshot(account.userId)).toEqual(before);

  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByLabel('Code from your authenticator app')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use passkey' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toHaveCount(0);
});

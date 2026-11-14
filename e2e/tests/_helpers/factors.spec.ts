import type { Page } from '@playwright/test';
import { api, createAccount } from '../../support/api';
import {
  allowClipboard,
  decodeQrOnPage,
  describeDownload,
  downloadFrom,
  fixedLocaleContext,
  mobileContext,
  readClipboard,
} from '../../support/browser-tools';
import {
  addAuthenticator,
  blockPasskeyAutofill,
  confirmIfAsked,
  enrolTenantPasskey,
  enrolTotp,
  nextTotpCode,
  recoveryCodeItems,
  rejectNextCredentialPrompt,
  settingsCard,
  signInWithPasskeyAutofill,
  signInWithTenantPasskey,
  signInWithTotp,
  totpCode,
  totpSetupKey,
  totpSetupQr,
} from '../../support/factors';
import { expect, signIn, test } from '../../support/fixtures';

/**
 * Proof that the factor and browser helpers (support/factors.ts, support/browser-tools.ts)
 * work against the real stack: an authenticator app enrolled in the customer app and
 * through the API, codes from it accepted and refused as the API's window says, and a
 * tenant passkey added and used, in its variants.
 */

/** The sign-in page's message for a browser prompt that ended without a passkey. */
const CANCELLED = 'The passkey request was cancelled or timed out. Please try again.';

const RECOVERY_CODE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;

async function signOut(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();
}

test.describe('factor helpers', () => {
  test('a tenant turns on an authenticator app in settings and signs in with a code', async ({ page, clientIp }) => {
    const account = await createAccount(clientIp, 'totp-ui', 'Tara Totp');
    await signIn(page, account);

    // The setup QR code holds the same key the screen shows.
    await page.goto('/settings');
    const card = settingsCard(page, 'Authenticator app');
    await card.getByRole('button', { name: 'Set up an authenticator app' }).click();
    await confirmIfAsked(page, account.password, totpSetupKey(card));
    const shownKey = (await totpSetupKey(card).textContent())?.trim();
    const qr = await decodeQrOnPage(totpSetupQr(card));
    expect(qr).toMatch(/^otpauth:\/\/totp\//);
    expect(new URL(qr).searchParams.get('secret')).toBe(shownKey);
    await card.getByRole('button', { name: 'Cancel' }).click();

    // A fresh setup (the cancelled one's key is replaced, and the session's proof is not
    // spent yet, so it is not asked again), confirmed with a code.
    const enrolment = await enrolTotp(page, account);
    expect(enrolment.secret).not.toBe(shownKey);
    expect(enrolment.recoveryCodes).toHaveLength(10);
    for (const code of enrolment.recoveryCodes) expect(code).toMatch(RECOVERY_CODE);
    await expect(card.getByText('On.', { exact: true })).toBeVisible();

    await signOut(page, account.name);

    // A code two steps out is outside the API's window: refused, and the form stays.
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.getByLabel('Code from your authenticator app').fill(totpCode(enrolment.secret, -2));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeHidden();

    // Starting again with the current code signs in.
    await page.getByRole('button', { name: 'Start again' }).click();
    await signInWithTotp(page, account, enrolment);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  });

  test('an authenticator app enrolled through the API signs in through the API', async ({ clientIp }) => {
    const account = await createAccount(clientIp, 'totp-api');
    const enrolment = await enrolTotp({ ip: clientIp }, account);
    expect(enrolment.recoveryCodes).toHaveLength(10);
    expect(enrolment.uri).toContain(`secret=${enrolment.secret}`);

    const first = await api<{ requiresSecondFactor?: boolean; handle: string; methods: string[] }>(
      'POST',
      '/api/auth/login',
      { email: account.email, password: account.password },
      { ip: clientIp },
    );
    expect(first.requiresSecondFactor).toBe(true);
    expect(first.methods).toEqual(expect.arrayContaining(['totp', 'recovery_code']));

    // The step the enrolment used is spent: the same code again is a replay.
    const replay = totpCode(enrolment.secret, 0, enrolment.lastStep * 30_000);
    await expect(api('POST', '/api/auth/login/totp', { handle: first.handle, code: replay }, { ip: clientIp })).rejects.toThrow(/answered 401/);

    const second = await api<{ handle: string }>('POST', '/api/auth/login', { email: account.email, password: account.password }, { ip: clientIp });
    const signedIn = await api<{ user: { id: string }; tokens: { accessToken: string } }>(
      'POST',
      '/api/auth/login/totp',
      { handle: second.handle, code: nextTotpCode(enrolment) },
      { ip: clientIp },
    );
    expect(signedIn.user.id).toBe(account.userId);
  });

  test('a tenant adds a passkey and signs in with it, and a cancelled prompt is reported', async ({ page, clientIp }) => {
    const account = await createAccount(clientIp, 'passkey', 'Pia Passkey');
    await blockPasskeyAutofill(page);
    const authenticator = await addAuthenticator(page);
    await signIn(page, account);

    // The first factor comes with recovery codes, and the key is device bound.
    const codes = await enrolTenantPasskey(page, account, 'Laptop key');
    expect(codes).toHaveLength(10);
    const passkeys = settingsCard(page, 'Passkeys');
    await expect(passkeys.getByText(/This device or key only/)).toBeVisible();
    const [credential] = await authenticator.credentials();
    expect(credential.isResidentCredential).toBe(true);
    expect(credential.rpId).toBe('localhost');

    await signOut(page, account.name);

    // A dismissed prompt: the page says so, and nobody is signed in.
    await rejectNextCredentialPrompt(page, 'get');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByText(CANCELLED)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeHidden();

    // The next one goes through (the rejection was used up).
    await signInWithTenantPasskey(page);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

    // Without the credential on the device, there is nothing to sign in with.
    await signOut(page, account.name);
    await authenticator.removeCredential(credential.credentialId);
    expect(await authenticator.credentials()).toHaveLength(0);
    // The browser reports no usable credential as it does a dismissed prompt.
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByText(CANCELLED)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeHidden();
  });

  test('with a passkey on the device, the sign-in page signs in by autofill', async ({ page, clientIp }) => {
    const account = await createAccount(clientIp, 'autofill', 'Ana Autofill');
    await addAuthenticator(page);
    await signIn(page, account);
    await enrolTenantPasskey(page, account);

    // Signing out lands on /login, whose autofill the virtual authenticator answers.
    const [verified] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/auth/passkey/verify')),
      (async () => {
        await page.getByRole('button', { name: account.name }).click();
        await page.getByRole('menuitem', { name: 'Log out' }).click();
      })(),
    ]);
    expect(verified.ok()).toBe(true);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

    // And from a signed-out start, through the helper.
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    await signInWithPasskeyAutofill(page);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  });

  test('a synced passkey is listed as synced, and failed user verification refuses passwordless sign-in', async ({ page, clientIp }) => {
    const account = await createAccount(clientIp, 'synced', 'Sid Synced');
    await blockPasskeyAutofill(page);
    const authenticator = await addAuthenticator(page, { synced: true });
    await signIn(page, account);
    const codes = await enrolTenantPasskey(page, account, 'Phone keychain');
    expect(codes).toHaveLength(10);
    await expect(settingsCard(page, 'Passkeys').getByText(/Synced/)).toBeVisible();
    const [credential] = await authenticator.credentials();
    expect(credential.backupEligibility).toBe(true);
    expect(credential.backupState).toBe(true);

    // Passwordless sign-in needs user verification; a failed one answers with no sign-in.
    await signOut(page, account.name);
    await authenticator.setUserVerified(false);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByText(CANCELLED)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeHidden();

    await authenticator.setUserVerified(true);
    await signInWithTenantPasskey(page);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  });

  test('phone and fixed-locale contexts are what the page sees', async ({ browser, baseURL }) => {
    const { context: iphone } = await mobileContext(browser, 'ios', { baseURL });
    const { context: pixel } = await mobileContext(browser, 'android', { baseURL });
    const { context: india } = await fixedLocaleContext(browser, { baseURL });
    const { context: newYork } = await fixedLocaleContext(browser, { baseURL, locale: 'en-US', timezoneId: 'America/New_York' });
    try {
      const seen = async (context: typeof iphone) => {
        const page = await context.newPage();
        await page.goto('/login');
        return page.evaluate(() => ({
          ua: navigator.userAgent,
          touch: navigator.maxTouchPoints,
          width: window.innerWidth,
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language: navigator.language,
          // A fixed instant, formatted by the page's own locale and zone.
          shown: new Date(Date.UTC(2026, 0, 31, 20, 0)).toLocaleString(),
        }));
      };
      const ios = await seen(iphone);
      expect(ios.ua).toMatch(/iPhone; CPU iPhone OS/);
      expect(ios.touch).toBeGreaterThan(0);
      expect(ios.width).toBeLessThan(500);
      expect((await seen(pixel)).ua).toMatch(/Android .*Pixel 7/);
      const inIndia = await seen(india);
      // ICU names India's zone by its older id.
      expect(inIndia.zone).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
      expect(inIndia.language).toBe('en-IN');
      expect(inIndia.shown).toBe('1/2/2026, 1:30:00 am');
      const inNewYork = await seen(newYork);
      expect(inNewYork).toMatchObject({ zone: 'America/New_York', language: 'en-US', shown: '1/31/2026, 3:00:00 PM' });
    } finally {
      await Promise.all([iphone.close(), pixel.close(), india.close(), newYork.close()]);
    }
  });

  test('the recovery codes copy and download keep their bytes', async ({ page, clientIp }) => {
    const account = await createAccount(clientIp, 'download', 'Dev Download');
    await signIn(page, account);
    await page.goto('/settings');
    const card = settingsCard(page, 'Authenticator app');
    await card.getByRole('button', { name: 'Set up an authenticator app' }).click();
    await confirmIfAsked(page, account.password, totpSetupKey(card));
    const secret = ((await totpSetupKey(card).textContent()) ?? '').trim();
    await card.getByLabel('Code from your authenticator app').fill(totpCode(secret));
    await card.getByRole('button', { name: 'Turn on' }).click();
    await expect(recoveryCodeItems(card)).toHaveCount(10);
    const shown = await recoveryCodeItems(card).allTextContents();

    await allowClipboard(page);
    await card.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Recovery codes copied')).toBeVisible();
    expect(await readClipboard(page)).toBe(shown.join('\n'));

    const file = await downloadFrom(page, card.getByRole('button', { name: 'Download' }));
    expect(file.filename).toBe('chumbaq-recovery-codes.txt');
    expect(file.hasBom).toBe(false);
    expect(file.lineEndings).toBe('lf');
    expect(file.lines).toEqual(shown);

    // And the reader shows what it is for: a BOM and CRLF made visible.
    const csv = describeDownload('x.csv', Buffer.from('﻿a,b\r\n1,2\r\n', 'utf8'));
    expect(csv).toMatchObject({ hasBom: true, lineEndings: 'crlf', lines: ['a,b', '1,2'] });
    expect(csv.visible).toBe('<BOM>a,b\\r\n1,2\\r\n');
  });
});

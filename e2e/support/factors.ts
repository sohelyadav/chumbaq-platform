import type { CDPSession, Locator, Page } from '@playwright/test';
import { generateSync } from 'otplib';
import { api, type Account } from './api';

/**
 * Second factors for the specs: Chromium's virtual authenticator in its variants, a
 * refused browser prompt, the customer app's passkey screens, and authenticator-app
 * (TOTP) codes.
 *
 * The TOTP codes come from otplib, not from the API's own implementation, so a test of
 * the API's codes is checked against an independent RFC 6238 one.
 */

// ---- Virtual authenticators

export interface AuthenticatorOptions {
  /**
   * How user verification goes: `verified` (the default, like Touch ID answering),
   * `fails` (the authenticator can verify but this time it does not: a wrong
   * fingerprint), or `unsupported` (a plain security key with no PIN or biometrics).
   */
  userVerification?: 'verified' | 'fails' | 'unsupported';
  /**
   * Credentials it makes are backup eligible and backed up (BE and BS set), as a
   * synced passkey in a password manager or cloud keychain is. Default: device bound.
   */
  synced?: boolean;
  /** `internal` (a platform authenticator, the default) or `usb` (a security key). */
  transport?: 'internal' | 'usb';
  /** Holds discoverable credentials, which passwordless sign-in needs. Default true. */
  residentKeys?: boolean;
}

export interface VirtualCredential {
  /** Base64 (standard, not URL-safe), as CDP gives it. */
  credentialId: string;
  rpId?: string;
  isResidentCredential: boolean;
  signCount: number;
  backupEligibility?: boolean;
  backupState?: boolean;
  /** Base64 of the user handle the relying party set. */
  userHandle?: string;
}

export interface VirtualAuthenticator {
  cdp: CDPSession;
  authenticatorId: string;
  /** Every credential it holds. */
  credentials(): Promise<VirtualCredential[]>;
  /** Forgets one credential, as if it were deleted from the device. */
  removeCredential(credentialId: string): Promise<void>;
  /** Forgets every credential. */
  clearCredentials(): Promise<void>;
  /** Makes later verifications succeed or fail. */
  setUserVerified(verified: boolean): Promise<void>;
  /** Changes a stored credential's backup flags (synced or not), for its next assertions. */
  setBackupFlags(credentialId: string, flags: { eligible: boolean; backedUp: boolean }): Promise<void>;
  /** Takes the authenticator away from the tab (its credentials go with it). */
  remove(): Promise<void>;
}

/**
 * A virtual authenticator in this tab, over CDP, answering at once. It keeps its
 * credentials across navigations in the tab, and only the tab it was added to sees it.
 * `addVirtualAuthenticator` in admin.ts is the default variant of this.
 */
export async function addAuthenticator(page: Page, options: AuthenticatorOptions = {}): Promise<VirtualAuthenticator> {
  const uv = options.userVerification ?? 'verified';
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: options.transport ?? 'internal',
      hasResidentKey: options.residentKeys ?? true,
      hasUserVerification: uv !== 'unsupported',
      isUserVerified: uv === 'verified',
      automaticPresenceSimulation: true,
      defaultBackupEligibility: options.synced ?? false,
      defaultBackupState: options.synced ?? false,
    },
  });
  return {
    cdp,
    authenticatorId,
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    removeCredential: async (credentialId) => {
      await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId });
    },
    clearCredentials: async () => {
      await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
    },
    setUserVerified: async (verified) => {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: verified });
    },
    setBackupFlags: async (credentialId, { eligible, backedUp }) => {
      await cdp.send('WebAuthn.setCredentialProperties', {
        authenticatorId,
        credentialId,
        backupEligibility: eligible,
        backupState: backedUp,
      });
    },
    remove: async () => {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    },
  };
}

/**
 * Makes the next `navigator.credentials.create` or `.get` in the current document fail
 * as a dismissed browser prompt does (a `NotAllowedError`), then puts the real one back.
 * Calls with `mediation: 'conditional'` (the sign-in page's passkey autofill, which waits
 * in the background) pass through untouched and do not use it up. Only the current
 * document: a navigation or reload before the call loses it, so call this after the page
 * the prompt belongs to has loaded.
 */
export async function rejectNextCredentialPrompt(page: Page, kind: 'create' | 'get' | 'any' = 'any'): Promise<void> {
  await page.evaluate((which) => {
    const container = navigator.credentials;
    const original = { create: container.create.bind(container), get: container.get.bind(container) };
    let armed = true;
    const wrap = (name: 'create' | 'get') =>
      function (options?: CredentialRequestOptions & CredentialCreationOptions) {
        const conditional = (options as { mediation?: string } | undefined)?.mediation === 'conditional';
        if (armed && !conditional && (which === 'any' || which === name)) {
          armed = false;
          container.create = original.create;
          container.get = original.get;
          return Promise.reject(
            new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'),
          );
        }
        return original[name](options);
      };
    container.create = wrap('create') as typeof container.create;
    container.get = wrap('get') as typeof container.get;
  }, kind);
}

/** A card on the customer app's /settings, by its title. */
export function settingsCard(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]').getByText(title, { exact: true }) });
}

/** The recovery codes on screen (shown once, after a first factor or a regeneration). */
export function recoveryCodeItems(scope: Locator): Locator {
  return scope
    .getByRole('status')
    .filter({ hasText: 'Save these now' })
    .locator('xpath=following-sibling::ul[1]')
    .getByRole('listitem');
}

// ---- Customer app passkeys (tenants; the stack turns PASSKEYS_FOR_TENANTS on)

/**
 * Answers the customer app's "Confirm it is you" dialog with the password, when the
 * account has no second factor yet (with one, the dialog asks for it instead).
 */
export async function confirmWithPassword(page: Page, password: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/**
 * After a click that changes a factor: answers "Confirm it is you" with the password if
 * it opens, and waits for `next` either way. The proof a re-authentication leaves is
 * spent only when a factor is actually added or removed, so a second setup started in
 * the same session (after a Cancel) is not asked again.
 */
export async function confirmIfAsked(page: Page, password: string, next: Locator): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await dialog.or(next).first().waitFor();
  if (await dialog.isVisible()) await confirmWithPassword(page, password);
  await next.waitFor();
}

/**
 * Adds a passkey on /settings with the tab's virtual authenticator (add one first, with
 * `addAuthenticator`), confirming with the password, which adding a factor always asks
 * for. Answers the recovery codes a first factor comes with (empty when none were shown).
 * The page must be signed in.
 */
export async function enrolTenantPasskey(
  page: Page,
  account: Pick<Account, 'password'>,
  name = 'E2E virtual authenticator',
): Promise<string[]> {
  await page.goto('/settings');
  const card = settingsCard(page, 'Passkeys');
  await card.getByLabel('Name', { exact: true }).fill(name);
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmIfAsked(page, account.password, card.getByText(name, { exact: true }));
  const codes = recoveryCodeItems(card);
  if ((await codes.count()) === 0) return [];
  const shown = await codes.allTextContents();
  await card.getByRole('button', { name: 'I have saved them' }).click();
  return shown;
}

/**
 * Turns off the sign-in page's passkey autofill in this page, from its next navigation:
 * the browser then reports no conditional mediation, so the page never starts it.
 *
 * Needed whenever a tab has a virtual authenticator holding a customer passkey and the
 * test means to use the sign-in page itself: Chromium's virtual authenticator answers
 * the autofill's waiting request at once with its credential (nobody picks it from a
 * list), so /login signs straight back in.
 */
export async function blockPasskeyAutofill(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (typeof PublicKeyCredential !== 'undefined') {
      Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', {
        configurable: true,
        value: () => Promise.resolve(false),
      });
    }
  });
}

/**
 * Opens /login and waits for the passkey autofill to sign in on its own (the virtual
 * authenticator answers it, see `blockPasskeyAutofill`), checking the API accepted it.
 * The page must be signed out.
 */
export async function signInWithPasskeyAutofill(page: Page): Promise<void> {
  const [verified] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/auth/passkey/verify')),
    page.goto('/login'),
  ]);
  if (!verified.ok()) throw new Error(`Passkey autofill sign-in answered ${verified.status()}`);
  await page.getByRole('heading', { name: 'Your Projects' }).waitFor();
}

/**
 * Signs in on /login with "Sign in with a passkey" (no address, no password), and waits
 * for the project list. Needs a verifying authenticator holding the account's passkey,
 * and the autofill blocked (`blockPasskeyAutofill`), or it signs in before the click.
 */
export async function signInWithTenantPasskey(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.getByRole('heading', { name: 'Your Projects' }).waitFor();
}

// ---- Authenticator apps (TOTP)

const TOTP_PERIOD_SECONDS = 30;

/** The 30-second step `at` (milliseconds since the epoch) falls in. */
export function totpStep(at = Date.now()): number {
  return Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * The six-digit code for `secret` (base32, as the API shows it) at `offsetSteps` steps
 * from `at`: 0 is now, -1 the previous 30 seconds, 1 the next. The API takes one step
 * either side, so -2 or 2 is a code it must refuse.
 */
export function totpCode(secret: string, offsetSteps = 0, at = Date.now()): string {
  const epoch = (totpStep(at) + offsetSteps) * TOTP_PERIOD_SECONDS;
  return generateSync({ secret, epoch });
}

export interface TotpEnrolment {
  /** Base32, as the API and the setup screen show it. */
  secret: string;
  /** The otpauth:// address the setup QR code holds. */
  uri?: string;
  recoveryCodes: string[];
  /** The last step a code was used for; the API refuses a step again (no replays). */
  lastStep: number;
  /** An access token from the enrolment (API enrolment only; the page keeps its own). */
  accessToken?: string;
}

/**
 * A code the API will take now: the current step's, or the next step's when the current
 * one was already used (the API accepts one step ahead). Records the step it used.
 */
export function nextTotpCode(enrolment: TotpEnrolment, at = Date.now()): string {
  const step = Math.max(totpStep(at), enrolment.lastStep + 1);
  if (step > totpStep(at) + 1) throw new Error('Two codes already used in this 30 seconds; wait for the next step');
  enrolment.lastStep = step;
  return totpCode(enrolment.secret, 0, step * TOTP_PERIOD_SECONDS * 1000);
}

/** The key the authenticator-app setup screen shows (base32), inside its settings card. */
export function totpSetupKey(card: Locator): Locator {
  return card.locator('p', { hasText: 'Scan this with your app' }).locator('code');
}

/** The setup screen's QR code (an <svg> with a <title>), for `decodeQrOnPage`. */
export function totpSetupQr(card: Locator): Locator {
  return card.getByRole('img', { name: 'Setup code for your authenticator app' });
}

/** Where `enrolTotp` does the work: a signed-in page, or the API with this address. */
export type EnrolTarget = Page | { ip: string };

const isPage = (target: EnrolTarget): target is Page => typeof (target as Page).goto === 'function';

/**
 * Turns on an authenticator app for `account`, and answers its secret and recovery codes.
 *
 * - With a page (signed in as the account, no second factor yet): through /settings, as
 *   a person does: "Set up an authenticator app", the password in "Confirm it is you",
 *   the key read off the screen, a code, "Turn on", and the recovery codes read back.
 * - With `{ ip }`: through the API, the same steps without the screens: re-authenticate
 *   with the password (adding a factor needs a fresh proof in the session), set up,
 *   confirm. `account.accessToken` must be a live session of the account.
 */
export async function enrolTotp(target: EnrolTarget, account: Pick<Account, 'password' | 'accessToken'>): Promise<TotpEnrolment> {
  if (isPage(target)) return enrolTotpInPage(target, account.password);
  const { ip } = target;
  const { accessToken } = await api<{ accessToken: string }>('POST', '/api/auth/reauth', { password: account.password }, { token: account.accessToken, ip });
  const { secret, uri } = await api<{ secret: string; uri: string }>('POST', '/api/auth/totp/setup', undefined, { token: accessToken, ip });
  const enrolment: TotpEnrolment = { secret, uri, recoveryCodes: [], lastStep: -1, accessToken };
  const { recoveryCodes } = await api<{ recoveryCodes: string[] }>(
    'POST',
    '/api/auth/totp/confirm',
    { code: nextTotpCode(enrolment) },
    { token: accessToken, ip },
  );
  enrolment.recoveryCodes = recoveryCodes;
  return enrolment;
}

async function enrolTotpInPage(page: Page, password: string): Promise<TotpEnrolment> {
  await page.goto('/settings');
  const card = settingsCard(page, 'Authenticator app');
  await card.getByRole('button', { name: 'Set up an authenticator app' }).click();
  const key = totpSetupKey(card);
  await confirmIfAsked(page, password, key);
  const secret = ((await key.textContent()) ?? '').trim();
  if (!/^[A-Z2-7]{16,}$/.test(secret)) throw new Error(`The setup screen showed no base32 key (got "${secret}")`);
  const enrolment: TotpEnrolment = { secret, recoveryCodes: [], lastStep: -1 };
  await card.getByLabel('Code from your authenticator app').fill(nextTotpCode(enrolment));
  await card.getByRole('button', { name: 'Turn on' }).click();
  const codes = recoveryCodeItems(card);
  await codes.first().waitFor();
  enrolment.recoveryCodes = await codes.allTextContents();
  await card.getByRole('button', { name: 'I have saved them' }).click();
  return enrolment;
}

/**
 * Signs in on /login with the password and then a code from the authenticator app, and
 * waits for the project list.
 */
export async function signInWithTotp(
  page: Page,
  account: Pick<Account, 'email' | 'password'>,
  enrolment: TotpEnrolment,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByLabel('Code from your authenticator app').fill(nextTotpCode(enrolment));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.getByRole('heading', { name: 'Your Projects' }).waitFor();
}

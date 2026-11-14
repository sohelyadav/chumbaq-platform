import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import type { CDPSession, Page } from '@playwright/test';
import { readDotEnv, REPO_ROOT, stackPorts } from './stack';

const run = promisify(execFile);

/** The admin app's origin, from ADMIN_APP_URL in the .env. */
export function adminUrl(pathname: string): string {
  return `https://localhost:${stackPorts(readDotEnv()).admin}${pathname}`;
}

/**
 * Makes someone a super admin the only way there is: the CLI, from apps/api, against
 * the database the .env names (the e2e one; the harness refused any other).
 */
export async function grantSuperAdmin(email: string): Promise<void> {
  await run('npm', ['run', 'admin:grant', '--', email], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env: process.env,
    timeout: 120_000,
  });
}

/**
 * A platform authenticator in this tab (Chromium's virtual authenticator, over CDP):
 * resident keys and user verification, answering at once, like Touch ID would. It keeps
 * its credentials across navigations in the tab.
 */
export async function addVirtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/**
 * A super admin's first staff sign-in, through the admin app: the password opens an
 * enrolment-only session, a passkey is added on /enrol with the tab's virtual
 * authenticator, and the person signs in with it. Answers the staff access token, for
 * setting things up through the admin API (it carries a fresh sign-in, which staff
 * writes need).
 */
export async function enrolAndSignInStaff(page: Page, staff: { email: string; password: string }): Promise<string> {
  await addVirtualAuthenticator(page);
  await page.goto(adminUrl('/sign-in'));
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password', { exact: true }).fill(staff.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Passkey name').fill('E2E virtual authenticator');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.getByText('Done. Sign in with your new passkey.').waitFor();
  const [verified] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/staff/auth/passkey/verify')),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  if (!verified.ok()) throw new Error(`Staff passkey sign-in answered ${verified.status()}`);
  const body = (await verified.json()) as { data: { accessToken: string } };
  return body.data.accessToken;
}

/** A request to the admin API with a staff token; answers the `data` of its envelope. */
export async function adminApi<T = unknown>(method: string, path: string, body: unknown, token: string, ip: string): Promise<T> {
  const base = process.env.E2E_ADMIN_API_URL;
  if (!base) throw new Error('E2E_ADMIN_API_URL is not set: run the specs through playwright.config.ts');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`);
  return (JSON.parse(text) as { data: T }).data;
}

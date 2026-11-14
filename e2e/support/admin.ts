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

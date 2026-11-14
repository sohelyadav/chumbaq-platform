import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { newClientIp, type Account } from './api';

/**
 * `test` with a client address of its own (`clientIp`), sent by the browser as
 * X-Forwarded-For so the API's per-address rate limits treat every test as a separate
 * client. Node-side helpers in api.ts take the same address.
 */
export const test = base.extend<{ clientIp: string }>({
  clientIp: async ({}, use) => {
    await use(newClientIp());
  },
  extraHTTPHeaders: async ({ clientIp }, use) => {
    await use({ 'X-Forwarded-For': clientIp });
  },
});

export { expect };

/** A second, separate browser (another person), with an address of its own. */
export async function newPersonContext(browser: Browser, baseURL: string | undefined): Promise<{ context: BrowserContext; ip: string }> {
  const ip = newClientIp();
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'X-Forwarded-For': ip },
  });
  return { context, ip };
}

/** Signs in through the customer app's login form and waits for the dashboard. */
export async function signIn(page: Page, account: Pick<Account, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
}

/** A link in the project sidebar (not the breadcrumb, which can repeat the name). */
export function sidebarLink(page: Page, name: string) {
  return page.locator('[data-sidebar="sidebar"]').getByRole('link', { name, exact: true });
}

/** Opens a collapsed group of the project sidebar ("Configure", "Engagement", ...). */
export async function openSidebarGroup(page: Page, group: string): Promise<void> {
  const toggle = page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: group, exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

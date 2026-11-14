import { randomBytes } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { apiUrl, createAccount } from '../support/api';
import { expect, sidebarLink, signIn, test } from '../support/fixtures';

/**
 * A new account creates its first project and a short link, the link is opened through
 * the API's root redirect (`GET /<code>`, the way a person tapping it reaches it), and
 * the link's dashboard counts the click. The click is recorded after the redirect has
 * answered, so the count is polled.
 *
 * The destination is a page served by the test itself on 127.0.0.1: Chromium follows a
 * redirect inside its network stack, where Playwright's request routing cannot answer
 * for a host that does not resolve.
 */
let landing: http.Server;
let landingOrigin: string;

test.beforeAll(async () => {
  landing = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Landing</title><h1>Landed from e2e</h1>');
  });
  await new Promise<void>((resolve) => landing.listen(0, '127.0.0.1', () => resolve()));
  landingOrigin = `http://127.0.0.1:${(landing.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => landing.close(resolve));
});

test('create a project and a short link, open it, and see the click counted', async ({ page, context, clientIp }) => {
  const owner = await createAccount(clientIp, 'links', 'Lina Links');
  await signIn(page, owner);

  // First project, from the empty state.
  const projectName = `Links project ${randomBytes(2).toString('hex')}`;
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Create Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await dialog.getByPlaceholder('My App').fill(projectName);
  await dialog.getByPlaceholder('example.com').fill('links.e2e.example.test');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
  const projectId = /\/projects\/([0-9a-f-]{36})\//.exec(page.url())![1];

  // A short link with a code of our own.
  const destination = `${landingOrigin}/welcome?from=e2e`;
  const shortCode = `e2e-${randomBytes(4).toString('hex')}`;
  await sidebarLink(page, 'Links').click();
  await expect(page.getByRole('heading', { name: 'Links', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create Link' }).click();
  await page.getByLabel('Destination URL').fill(destination);
  await page.getByLabel('Custom short link').fill(shortCode);
  await page.getByLabel('Title').fill('E2E welcome link');
  await page.getByRole('button', { name: 'Create Link' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/links/[0-9a-f-]{36}$`));
  const linkDetail = page.url();
  await expect(page.getByText(`/${shortCode}`, { exact: false }).first()).toBeVisible();
  const totalClicks = page.getByText('Total Clicks', { exact: true }).locator('..');
  await expect(totalClicks).toHaveText(/Total Clicks\s*0$/);

  // Open the short link on the API's own port, as a desktop browser: a 302 to the destination.
  const visitor = await context.newPage();
  const redirect = visitor.waitForResponse((response) => response.url() === apiUrl(`/${shortCode}`));
  await visitor.goto(apiUrl(`/${shortCode}`));
  expect((await redirect).status()).toBe(302);
  await expect(visitor).toHaveURL(destination);
  await expect(visitor.getByRole('heading', { name: 'Landed from e2e' })).toBeVisible();
  await visitor.close();

  // The click is written after the redirect answered: reload until the dashboard counts it.
  await expect(async () => {
    await page.goto(linkDetail);
    await expect(totalClicks).toHaveText(/Total Clicks\s*1$/, { timeout: 2000 });
  }).toPass({ timeout: 30_000 });

  // The links list shows it with its click.
  await sidebarLink(page, 'Links').click();
  await expect(page.getByRole('row', { name: new RegExp(shortCode) })).toBeVisible();
});

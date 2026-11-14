import { createAccount, createProject } from '../support/api';
import { addVirtualAuthenticator, adminUrl, grantSuperAdmin } from '../support/admin';
import { expect, test } from '../support/fixtures';

/**
 * Staff sign-in and view-as, across both apps. A super admin is granted by the CLI,
 * enrols a passkey on /enrol (Chromium's virtual authenticator stands in for the
 * device), signs in with it, finds a tenant, starts a read-only view-as with a reason,
 * follows the one-time link into the customer app in a new tab, sees the view-as
 * banner and the tenant's project, and ends it.
 *
 * The e2e .env runs with SUPER_ADMIN_PASSKEY_REQUIRED=false, which lets a super admin
 * with no factor enrol from a password alone; with it on (always in production) the
 * operator's enrolment code is needed too, which this does not cover.
 */
test('staff enrol a passkey, sign in with it, and view a tenant read-only', async ({ page, context, clientIp }) => {
  test.slow(); // The grant runs the CLI through ts-node.

  const tenant = await createAccount(clientIp, 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, 'Tenant project');
  const staff = await createAccount(clientIp, 'staff', 'Sam Staff');
  await grantSuperAdmin(staff.email);

  await addVirtualAuthenticator(page);

  // Password first: with no staff factor yet this is an enrolment-only session.
  await page.goto(adminUrl('/sign-in'));
  await expect(page.getByText('Staff only. Every sign-in is recorded.')).toBeVisible();
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password', { exact: true }).fill(staff.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(adminUrl('/enrol'));
  await expect(page.getByText('Set up a sign-in method')).toBeVisible();
  await page.getByLabel('Passkey name').fill('E2E virtual authenticator');
  await page.getByRole('button', { name: 'Add a passkey' }).click();

  // Enrolling ends that session; sign in with the new passkey.
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('status')).toHaveText('Done. Sign in with your new passkey.');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(adminUrl('/'));

  // Find the tenant.
  await page.getByRole('link', { name: 'Tenants', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tenants', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search tenants' }).fill(tenant.email);
  await page.getByRole('link', { name: tenant.email }).click();
  await expect(page).toHaveURL(adminUrl(`/tenants/${tenant.userId}`));

  // Start view-as with a reason; the link opens the customer app in a new tab.
  await page.getByRole('button', { name: 'View as tenant' }).click();
  const confirm = page.getByRole('dialog', { name: 'View as this tenant?' });
  await confirm.getByLabel('Reason').fill('E2E: checking the read-only view works');
  await confirm.getByRole('button', { name: 'Start read-only session' }).click();
  const ready = page.getByRole('dialog', { name: `View as ${tenant.email}` });
  await expect(ready).toBeVisible();
  const [viewAs] = await Promise.all([
    context.waitForEvent('page'),
    ready.getByRole('link', { name: 'Open view-as' }).click(),
  ]);

  // The customer app, as the tenant, read-only, with the banner.
  await expect(viewAs).toHaveURL(/\/projects$/);
  const banner = viewAs.getByRole('region', { name: 'Impersonation session' });
  await expect(banner).toContainText(`Viewing ${tenant.email} as Super Admin · read-only`);
  await expect(viewAs.getByText(project.name)).toBeVisible();

  // Read-only means the API refuses writes, not just that the banner says so.
  await viewAs.getByRole('button', { name: 'New Project' }).click();
  const create = viewAs.getByRole('dialog', { name: 'New Project' });
  await create.getByPlaceholder('My App').fill('Made while viewing as');
  await create.getByPlaceholder('example.com').fill('view-as.e2e.example.test');
  await create.getByRole('button', { name: 'Create Project' }).click();
  await expect(create.getByRole('alert')).toHaveText('Impersonation sessions are read-only');
  await create.getByRole('button', { name: 'Cancel' }).click();

  // Ending it leaves for the admin app's page for that tenant.
  await banner.getByRole('button', { name: 'Exit' }).click();
  await expect(viewAs).toHaveURL(new RegExp(`^${adminUrl('')}/`));
  await expect(viewAs.getByRole('region', { name: 'Impersonation session' })).toHaveCount(0);
});

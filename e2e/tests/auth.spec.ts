import { PASSWORD, signupLinkToken, uniqueEmail } from '../support/api';
import { expect, test } from '../support/fixtures';
import { extractLink, waitForMail } from '../support/mailbox';

/**
 * Sign up, sign in, sign out, and the wrong-password message, through the customer app.
 *
 * The sign-up link is read from the mail the API sent (the provider stub's mailbox,
 * support/mailbox.ts) and opened as the email's link would be. The used-link case makes
 * its token with the run's signing secret instead (`signupLinkToken`, support/api.ts).
 * That link verifies the address, so the separate verify-email flow is not covered here.
 */
test.describe('auth', () => {
  test('sign up, sign out, sign in again, and a wrong password is refused', async ({ page }) => {
    const email = uniqueEmail('auth');
    const name = 'Asha Auth';

    // Sign up: name and address, then the "check your email" step.
    await page.goto('/register');
    await expect(page.getByText('Create an account')).toBeVisible();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(`We sent an email to ${email}`)).toBeVisible();

    // The emailed link: choose a password, which creates the account and signs in.
    const mail = await waitForMail(email, { subjectIncludes: 'Finish creating your Chumbaq account' });
    await page.goto(extractLink(mail, '/complete-signup'));
    await expect(page.getByText('Choose a password')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();

    // Sign out from the account menu.
    await page.getByRole('button', { name: name }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Login to your account' })).toBeVisible();

    // Signed out means signed out: the dashboard sends us back to the login page.
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/login/);

    // A wrong password gets the generic message and stays on the form.
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('not-the-password-1');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // The right one signs in.
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

    // A reload keeps the session (the refresh cookie restores it).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
  });

  test('a used sign-up link is refused', async ({ page }) => {
    const email = uniqueEmail('auth-reuse');
    const name = 'Ravi Reuse';
    const link = `/complete-signup#token=${signupLinkToken(email, name)}`;

    await page.goto(link);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

    await page.context().clearCookies();
    await page.goto(link);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'This sign-up link has expired or was already used. Sign up again, or sign in.',
    );
  });
});

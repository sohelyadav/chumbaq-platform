import { createAccount, createApiKey, createProject, uniqueEmail } from '../support/api';
import { expect, signIn, test } from '../support/fixtures';
import { connectFakeEmailProvider, identifyPeople } from '../support/seed';

/**
 * An email campaign, as far as it goes without a real provider.
 *
 * People arrive through the SDK's identify route (two opted in to email, one opted out,
 * one with no address). The owner saves the sender in the dashboard, with "only email
 * people who opted in" off: with it on, an opt-in counts only once the person confirms
 * it from an email the project's provider sends, which needs a real provider. With it
 * off, everyone with an address who has not opted out is reached. Connecting a provider
 * makes the API check the key with that provider, so the e2e stack cannot do it: the
 * spec seeds the connection (support/seed.ts), with a fake key that nothing ever uses.
 * The campaign is then composed, its audience counted (the opted-out and address-less
 * people left out), and scheduled a month ahead, which is where it stops: sending would
 * reach the provider.
 */
test('compose an email to everyone, see who it reaches, and schedule it', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'campaigns', 'Cara Campaigns');
  const project = await createProject(owner, clientIp, 'Campaigns project');
  const sdkKey = await createApiKey(owner, project.id, clientIp);
  await identifyPeople(project.id, sdkKey, clientIp, [
    { email: uniqueEmail('reader-a'), emailOptIn: true, firstName: 'Anu' },
    { email: uniqueEmail('reader-b'), emailOptIn: true, firstName: 'Bela' },
    { email: uniqueEmail('reader-c'), emailOptIn: false, firstName: 'Chen' },
    { firstName: 'Dev' },
  ]);

  await signIn(page, owner);
  // By address: the project sidebar has no Email entry (see e2e/README.md, known gaps).
  await page.goto(`/projects/${project.id}/email`);
  await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();

  // Not set up yet: say so, and save the sender under Settings.
  const notSetUp = page.getByText('Email is not set up yet. Add a sender and connect a provider under Settings.');
  await expect(notSetUp).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('From address').fill('news@e2e.example.test');
  await page.getByLabel('From name').fill('E2E News');
  await page.getByLabel('Postal address').fill('E2E Labs, 1 Test Street, Testville 000000');
  const optInOnly = page.getByText('Only email people who opted in').locator('../..').getByRole('switch');
  await expect(optInOnly).toBeChecked();
  await optInOnly.click();
  await expect(optInOnly).not.toBeChecked();
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(page.getByText('Sender saved')).toBeVisible();

  await connectFakeEmailProvider(project.id);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Campaigns' })).toHaveAttribute('aria-selected', 'true');
  await expect(notSetUp).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('tab', { name: /Brevo\s*Active/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Campaigns' }).click();
  await page.getByRole('link', { name: 'New email' }).click();
  await expect(page.getByRole('heading', { name: 'New email' })).toBeVisible();

  // The audience: everyone with an address who has not opted out, so two of the four.
  const subject = `E2E launch news ${Date.now()}`;
  await page.getByLabel('Subject').fill(subject);
  await page.getByLabel('Preview text (optional)').fill('Shown next to the subject');
  await expect(page.getByText('2 recipient(s)', { exact: true })).toBeVisible();

  // A month ahead, at 10:30 local time.
  await page.getByText('Schedule for later').locator('..').getByRole('switch').click();
  await page.getByRole('button', { name: 'Pick date & time' }).click();
  await page.getByRole('button', { name: /next month/i }).click();
  await page.getByRole('gridcell', { name: '15' }).getByRole('button').click();
  await page.locator('input[type="time"]').fill('10:30');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /10:30$/ })).toBeVisible();

  await page.getByRole('button', { name: 'Schedule email' }).click();
  await expect(page.getByText('Email scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('2 recipient(s).', { exact: true })).toBeVisible();

  // Back on the list: scheduled, nothing sent.
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/email$`));
  const row = page.getByRole('row', { name: new RegExp(subject) });
  await expect(row).toContainText('Scheduled');
});

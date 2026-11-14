import { createAccount, createProject } from '../support/api';
import { expect, newPersonContext, openSidebarGroup, sidebarLink, signIn, test } from '../support/fixtures';

/**
 * An owner invites a teammate as a member; the invite link is shown once in the
 * dashboard (account email is off in the e2e stack, so it is not mailed). The teammate
 * opens it signed out, signs in, comes back to it and accepts. As a member they cannot
 * see API keys, invite anyone or open the activity log. The owner then removes them,
 * and the project is gone from their list.
 */
test('owner invites a member, who accepts, sees no owner-only pages, and is removed', async ({
  page,
  browser,
  baseURL,
  clientIp,
}) => {
  const owner = await createAccount(clientIp, 'team-owner', 'Omar Owner');
  const project = await createProject(owner, clientIp, 'Team project');
  const mate = await createAccount(clientIp, 'team-mate', 'Tara Teammate');

  // Owner: invite the teammate as a member.
  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/team`);
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await page.getByLabel('Email address').fill(mate.email);
  await page.getByRole('button', { name: 'Send invite' }).click();
  const linkDialog = page.getByRole('dialog', { name: `Invite link for ${mate.email}` });
  await expect(linkDialog).toBeVisible();
  await expect(linkDialog.getByText('Email not sent — copy the link')).toBeVisible();
  const inviteUrl = (await linkDialog.getByText(/\/invite#token=/).textContent())!.trim();
  expect(inviteUrl).toMatch(/\/invite#token=[A-Za-z0-9_-]{43}$/);
  await linkDialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: new RegExp(mate.email) })).toBeVisible();

  // Teammate, in their own browser: open the link signed out, sign in, accept.
  const { context: mateContext } = await newPersonContext(browser, baseURL);
  const matePage = await mateContext.newPage();
  await matePage.goto(inviteUrl);
  await expect(matePage.getByText('Sign in to accept your invite')).toBeVisible();
  await matePage.getByRole('link', { name: 'Sign in' }).click();
  await matePage.getByLabel('Email').fill(mate.email);
  await matePage.getByLabel('Password', { exact: true }).fill(mate.password);
  await matePage.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(matePage.getByText(`Join ${project.name}`)).toBeVisible();
  await expect(matePage.getByText('Omar Owner invited you to join as a member.')).toBeVisible();
  await matePage.getByRole('button', { name: 'Accept invite' }).click();
  await expect(matePage).toHaveURL(new RegExp(`/projects/${project.id}$`));

  // As a member: no keys, no inviting, no activity log.
  await openSidebarGroup(matePage, 'Configure');
  await expect(sidebarLink(matePage, 'Members')).toBeVisible();
  await expect(sidebarLink(matePage, 'Activity')).toHaveCount(0);
  await sidebarLink(matePage, 'API Keys').click();
  await expect(
    matePage.getByText('Only owners and admins can see and manage API keys. Ask one of them for the key your app needs.'),
  ).toBeVisible();
  await expect(matePage.getByRole('button', { name: 'Create Key' })).toHaveCount(0);
  await sidebarLink(matePage, 'Members').click();
  await expect(matePage.getByRole('row', { name: new RegExp(`${mate.email}`) })).toContainText('Member');
  await expect(matePage.getByRole('button', { name: 'Send invite' })).toHaveCount(0);
  await expect(matePage.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  // Typing the activity URL by hand shows the refusal, not the log.
  await matePage.goto(`/projects/${project.id}/activity`);
  await expect(matePage.getByText('Only owners and admins can see the activity log.')).toBeVisible();
  await expect(matePage.getByRole('button', { name: 'Download CSV' })).toHaveCount(0);

  // Owner: the teammate is a member now; remove them.
  await page.reload();
  const mateRow = page.getByRole('row', { name: new RegExp(mate.email) });
  await expect(mateRow).toContainText('Member');
  await page.getByRole('button', { name: `Remove ${mate.name}` }).click();
  const confirm = page.getByRole('dialog', { name: `Remove ${mate.name}?` });
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Removed from the project')).toBeVisible();
  await expect(mateRow).toHaveCount(0);

  // Teammate: the project is no longer theirs.
  await matePage.goto('/projects');
  await expect(matePage.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await mateContext.close();
});

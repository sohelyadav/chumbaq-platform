import { randomUUID } from 'crypto';
import type { Browser, Page, Response } from '@playwright/test';
import { createProject } from '../../support/api';
import { confirmWithPassword } from '../../support/factors';
import { expect, newPersonContext, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  ADMIN_PERMISSIONS,
  INVITE_GONE,
  MEMBER_PERMISSIONS,
  MOVE_BILLING_FIRST,
  OWNER_PERMISSIONS,
  PROJECT_NOT_FOUND,
  REAUTH_REQUIRED,
  ROLE_REFUSAL,
  ageSignIn,
  call,
  cardTitled,
  chooseRole,
  invitationsOf,
  joinedLabel,
  makeTeam,
  memberRow,
  membersOf,
  membersTable,
  messageOf,
  newPerson,
  openMembers,
  personLabel,
  projectsOf,
  sendInvite,
  teamActivity,
  withDb,
  type Person,
} from '../../support/areas/team';

/**
 * The Members page (who is in a project and as what), changing roles, removing
 * people, and leaving a project, with the API's owner rules behind them.
 */

test.describe.configure({ mode: 'parallel' });

const SEAT_LINE = /^\d+ (of \d+ )?seats?$/;

/** Signs `person` in, in a browser of their own. */
async function personPage(browser: Browser, baseURL: string | undefined, person: Person): Promise<Page> {
  const { context } = await newPersonContext(browser, baseURL);
  const page = await context.newPage();
  await signIn(page, person);
  return page;
}

/** A toast, found by its title, in the notifications region. */
function toastTitled(page: Page, title: string) {
  return page.getByRole('region', { name: /Notifications/ }).locator('li').filter({ hasText: title });
}

/** Signs in, then moves the sign-in back past the recent sign-in window and reloads, so the page's token is stale. */
async function signInStale(page: Page, person: Person): Promise<void> {
  await signIn(page, person);
  await ageSignIn(person);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
}

/** Records the statuses of the requests matching `method` and a URL ending. */
function watchStatuses(page: Page, method: string, urlEnd: string): number[] {
  const statuses: number[] = [];
  page.on('response', (response: Response) => {
    if (response.request().method() === method && new URL(response.url()).pathname.endsWith(urlEnd)) {
      statuses.push(response.status());
    }
  });
  return statuses;
}

// ---- A. Members list

test('TEAM-001 owner opens the Members page', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Coowner'],
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, admin, member } = people;

  await signIn(page, owner);
  await openMembers(page, project.id);
  await expect(page.getByText('People who can open this project, and what their role lets them do.')).toBeVisible();
  await expect(page.getByText(SEAT_LINE)).toHaveText('4 seats');
  await expect(page.getByRole('link', { name: 'See who changed the team' })).toHaveAttribute(
    'href',
    `/projects/${project.id}/activity?group=team`,
  );

  const card = cardTitled(page, 'Members');
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(/^Members\s*\(4\)$/);
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    'Owners can do everything. Admins manage channels, keys and members, but not owners. Members work with links, campaigns and people.',
  );
  await expect(membersTable(page).getByRole('columnheader')).toHaveText(['Person', 'Role', 'Joined', '']);

  // Owners first, then admins, then members, each by join time.
  const rows = membersTable(page).locator('tbody tr');
  await expect(rows).toHaveCount(4);
  for (const [index, person] of [owner, coOwner, admin, member].entries()) {
    await expect(rows.nth(index)).toContainText(person.email);
  }

  const ownerRow = memberRow(page, owner.email);
  await expect(ownerRow.locator('p').first()).toHaveText(/^Omar Owner\s*\(you\)$/);
  await expect(ownerRow.getByText(owner.email, { exact: true })).toBeVisible();
  await expect(ownerRow.getByText('Owner', { exact: true })).toBeVisible();
  await expect(ownerRow.getByText('Billing owner', { exact: true })).toBeVisible();
  await expect(ownerRow.getByRole('combobox')).toHaveCount(0);
  await expect(ownerRow.getByRole('button')).toHaveCount(0);

  for (const [person, role] of [
    [coOwner, 'Owner'],
    [admin, 'Admin'],
    [member, 'Member'],
  ] as const) {
    const row = memberRow(page, person.email);
    await expect(row.getByRole('combobox')).toHaveText(role);
    await expect(row.getByRole('button', { name: `Remove ${person.name}` })).toBeVisible();
  }
  const today = joinedLabel(new Date());
  for (let index = 0; index < 4; index++) await expect(rows.nth(index).locator('td').nth(2)).toHaveText(today);

  await expect(cardTitled(page, 'Pending invites').getByText('No pending invites.')).toBeVisible();
  await expect(cardTitled(page, 'Invite')).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('TEAM-002 members API lists everyone with role, billing flag and offer', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Coowner'],
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const everyone = [owner, people.coOwner, people.admin, people.member];

  const bodies = [];
  for (const reader of everyone) {
    const result = await call('GET', `/api/projects/${project.id}/members`, { as: reader });
    expect(result.status).toBe(200);
    bodies.push(result.body.data);
  }
  for (const body of bodies.slice(1)) expect(body).toEqual(bodies[0]);

  const { members, billingOffer } = bodies[0];
  expect(Object.keys(bodies[0]).sort()).toEqual(['billingOffer', 'members']);
  expect(billingOffer).toBeNull();
  expect(members.map((m: { userId: string }) => m.userId)).toEqual(everyone.map((p) => p.userId));
  expect(members.map((m: { role: string }) => m.role)).toEqual(['owner', 'owner', 'admin', 'member']);
  expect(members.map((m: { isBillingOwner: boolean }) => m.isBillingOwner)).toEqual([true, false, false, false]);
  for (const [index, member] of members.entries()) {
    expect(Object.keys(member).sort()).toEqual(['createdAt', 'email', 'isBillingOwner', 'name', 'role', 'userId']);
    expect(member.email).toBe(everyone[index].email);
    expect(member.name).toBe(everyone[index].name);
    expect(new Date(member.createdAt).toISOString()).toBe(member.createdAt);
  }
});

test('TEAM-003 members API refuses outsiders and anonymous callers', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const outsider = await newPerson('team-outsider', 'Xavi Outsider');
  await createProject(outsider, outsider.ip, 'Outsider project');

  const anonymous = await call('GET', `/api/projects/${project.id}/members`);
  expect(anonymous.status).toBe(401);

  const asOutsider = await call('GET', `/api/projects/${project.id}/members`, { as: outsider });
  expect(asOutsider.status).toBe(404);
  expect(messageOf(asOutsider)).toBe(PROJECT_NOT_FOUND);

  const unknown = await call('GET', `/api/projects/${randomUUID()}/members`, { as: owner });
  expect(unknown.status).toBe(404);
  expect(messageOf(unknown)).toBe(PROJECT_NOT_FOUND);
  // Nothing tells the outsider the project exists (beyond the path and time of the request).
  const { path: _p1, timestamp: _t1, ...outsiderAnswer } = asOutsider.body;
  const { path: _p2, timestamp: _t2, ...unknownAnswer } = unknown.body;
  expect(outsiderAnswer).toEqual(unknownAnswer);
  expect(Object.keys(outsiderAnswer).sort()).toEqual(['error', 'message', 'statusCode']);
});

test('TEAM-004 admin view of the Members page', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Coowner'],
    admin: ['admin', 'Adam Admin'],
    admin2: ['admin', 'Alma Admin'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, admin, admin2, member } = people;

  await signIn(page, admin);
  await openMembers(page, project.id);
  await expect(page.getByText(SEAT_LINE)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See who changed the team' })).toBeVisible();

  for (const person of [owner, coOwner]) {
    const row = memberRow(page, person.email);
    await expect(row.getByText('Owner', { exact: true })).toBeVisible();
    await expect(row.getByRole('combobox')).toHaveCount(0);
    await expect(row.getByRole('button')).toHaveCount(0);
  }

  const myRow = memberRow(page, admin.email);
  await expect(myRow.locator('p').first()).toHaveText(/^Adam Admin\s*\(you\)$/);
  await expect(myRow.getByText('Admin', { exact: true })).toBeVisible();
  await expect(myRow.getByRole('combobox')).toHaveCount(0);
  await expect(myRow.getByRole('button')).toHaveCount(0);

  for (const person of [admin2, member]) {
    const row = memberRow(page, person.email);
    await row.getByRole('combobox').click();
    await expect(page.getByRole('option')).toHaveText(['Admin', 'Member']);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(row.getByRole('button', { name: `Remove ${person.name}` })).toBeVisible();
  }

  await expect(cardTitled(page, 'Pending invites')).toBeVisible();
  await expect(cardTitled(page, 'Invite')).toBeVisible();
  await page.getByLabel('Role').click();
  await expect(page.getByRole('option')).toHaveText(['Admin', 'Member']);
  await page.keyboard.press('Escape');
});

test('TEAM-005 member view of the Members page is read-only', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { admin, member } = people;
  const invitationRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/invitations')) invitationRequests.push(request.url());
  });

  await signIn(page, member);
  await openMembers(page, project.id);
  const today = joinedLabel(new Date());
  for (const [person, role] of [
    [owner, 'Owner'],
    [admin, 'Admin'],
    [member, 'Member'],
  ] as const) {
    const row = memberRow(page, person.email);
    await expect(row).toContainText(person.name);
    await expect(row.getByText(person.email, { exact: true })).toBeVisible();
    await expect(row.getByText(role, { exact: true })).toBeVisible();
    await expect(row).toContainText(today);
  }
  await expect(membersTable(page).getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(membersTable(page).getByRole('columnheader')).toHaveText(['Person', 'Role', 'Joined']);
  await expect(cardTitled(page, 'Pending invites')).toHaveCount(0);
  await expect(cardTitled(page, 'Invite')).toHaveCount(0);
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See who changed the team' })).toHaveCount(0);
  await expect(page.getByText(SEAT_LINE)).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(invitationRequests).toEqual([]);
});

// ---- B. Change role

test('TEAM-009 owner promotes a member to admin', async ({ page, browser, baseURL }) => {
  // Mia joined before Ada, so as an admin she moves ahead of Ada.
  const { owner, project, people } = await makeTeam('Omar Owner', {
    member: ['member', 'Mia Member'],
    admin: ['admin', 'Ada Admin'],
  });
  const { member, admin } = people;

  await signIn(page, owner);
  await openMembers(page, project.id);
  const rows = membersTable(page).locator('tbody tr');
  await expect(rows.nth(1)).toContainText(admin.email);
  await expect(rows.nth(2)).toContainText(member.email);

  const patched = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/projects/${project.id}/members/${member.userId}`),
  );
  await chooseRole(page, member.email, 'Admin');
  const response = await patched;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ role: 'admin' });
  const list = (await response.json()).data.members as Array<{ userId: string; role: string }>;
  expect(list.find((m) => m.userId === member.userId)?.role).toBe('admin');

  const toast = toastTitled(page, 'Role changed');
  await expect(toast).toContainText('Mia Member is now admin.');
  await expect(memberRow(page, member.email).getByRole('combobox')).toHaveText('Admin');
  await expect(rows.nth(1)).toContainText(member.email);
  await expect(rows.nth(2)).toContainText(admin.email);

  const listed = (await projectsOf(member)).find((p) => p.id === project.id);
  expect(listed?.role).toBe('admin');
  expect(listed?.permissions).toEqual(ADMIN_PERMISSIONS);

  const memberPage = await personPage(browser, baseURL, member);
  await memberPage.goto(`/projects/${project.id}/activity`);
  await expect(memberPage.getByRole('button', { name: 'Download CSV' })).toBeVisible();
  await expect(memberPage.getByText('Only owners and admins can see the activity log.')).toHaveCount(0);
  await memberPage.context().close();

  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'member.role_changed');
  expect(entry).toMatchObject({
    actorUserId: owner.userId,
    targetId: member.userId,
    targetLabel: personLabel(member),
    details: { from: 'member', to: 'admin' },
  });
  await page.goto(`/projects/${project.id}/activity`);
  await expect(
    page.getByText(`Omar Owner changed the role of ${personLabel(member)} from member to admin`, { exact: true }),
  ).toBeVisible();
});

test('TEAM-011 granting owner needs a recent sign-in', async ({ page }) => {
  // Alma joined before Ada: as an owner, Ada moves ahead of her.
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin2: ['admin', 'Alma Admin'],
    admin: ['admin', 'Ada Admin'],
  });
  const { admin, admin2 } = people;

  await signInStale(page, owner);
  await openMembers(page, project.id);
  const rows = membersTable(page).locator('tbody tr');
  await expect(rows.nth(1)).toContainText(admin2.email);
  await expect(rows.nth(2)).toContainText(admin.email);

  const statuses = watchStatuses(page, 'PATCH', `/members/${admin.userId}`);
  const refused = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.status() === 403);
  await chooseRole(page, admin.email, 'Owner');
  expect((await (await refused).json()).message).toBe(REAUTH_REQUIRED);
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toBeVisible();
  await confirmWithPassword(page, owner.password);

  await expect(toastTitled(page, 'Role changed')).toContainText('Ada Admin is now owner.');
  expect(statuses).toEqual([403, 200]);
  await expect(rows.nth(1)).toContainText(admin.email);
  await expect(rows.nth(2)).toContainText(admin2.email);
  // Owners manage owners: Ada keeps a picker, now on Owner.
  await expect(memberRow(page, admin.email).getByRole('combobox')).toHaveText('Owner');

  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'member.role_changed');
  expect(entry).toMatchObject({ actorUserId: owner.userId, targetId: admin.userId, details: { from: 'admin', to: 'owner' } });
});

test('TEAM-013 demoting another owner needs a recent sign-in', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const { coOwner } = people;
  expect((await projectsOf(coOwner)).find((p) => p.id === project.id)?.permissions).toEqual(OWNER_PERMISSIONS);

  await signInStale(page, owner);
  await openMembers(page, project.id);
  const statuses = watchStatuses(page, 'PATCH', `/members/${coOwner.userId}`);
  await chooseRole(page, coOwner.email, 'Admin');
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toBeVisible();
  await confirmWithPassword(page, owner.password);
  await expect(toastTitled(page, 'Role changed')).toContainText('Cara Coowner is now admin.');
  expect(statuses).toEqual([403, 200]);
  await expect(memberRow(page, coOwner.email).getByRole('combobox')).toHaveText('Admin');

  const listed = (await projectsOf(coOwner)).find((p) => p.id === project.id);
  expect(listed?.role).toBe('admin');
  expect(listed?.permissions).not.toContain('privacy');
  expect(listed?.permissions).not.toContain('project.admin');
  expect(listed?.permissions).toEqual(ADMIN_PERMISSIONS);

  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'member.role_changed');
  expect(entry).toMatchObject({ actorUserId: owner.userId, targetId: coOwner.userId, details: { from: 'owner', to: 'admin' } });
});

test('TEAM-015 the billing owner cannot be demoted', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const { coOwner } = people;

  const byCoOwner = await call('PATCH', `/api/projects/${project.id}/members/${owner.userId}`, {
    as: coOwner,
    body: { role: 'admin' },
  });
  expect(byCoOwner.status).toBe(409);
  expect(messageOf(byCoOwner)).toBe(MOVE_BILLING_FIRST);

  const bySelf = await call('PATCH', `/api/projects/${project.id}/members/${owner.userId}`, {
    as: owner,
    body: { role: 'admin' },
  });
  expect(bySelf.status).toBe(409);
  expect(messageOf(bySelf)).toBe(MOVE_BILLING_FIRST);

  const { members } = await membersOf(project.id, owner);
  expect(members.find((m) => m.userId === owner.userId)).toMatchObject({ role: 'owner', isBillingOwner: true });

  // Nobody gets a picker for the billing owner, not even another owner.
  await signIn(page, coOwner);
  await openMembers(page, project.id);
  const ownerRow = memberRow(page, owner.email);
  await expect(ownerRow.getByText('Billing owner', { exact: true })).toBeVisible();
  await expect(ownerRow.getByRole('combobox')).toHaveCount(0);
  await expect(ownerRow.getByRole('button')).toHaveCount(0);
});

test('TEAM-016 admin cannot change or create owners', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Coowner'],
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, admin, member } = people;
  const before = await membersOf(project.id, owner);

  const demote = await call('PATCH', `/api/projects/${project.id}/members/${coOwner.userId}`, {
    as: admin,
    body: { role: 'member' },
  });
  const promote = await call('PATCH', `/api/projects/${project.id}/members/${member.userId}`, {
    as: admin,
    body: { role: 'owner' },
  });
  const remove = await call('DELETE', `/api/projects/${project.id}/members/${coOwner.userId}`, { as: admin });
  for (const result of [demote, promote, remove]) {
    expect(result.status).toBe(403);
    expect(messageOf(result)).toBe(ROLE_REFUSAL);
  }

  expect(await membersOf(project.id, owner)).toEqual(before);
  const entries = await teamActivity(project.id, owner);
  expect(entries.filter((e) => e.action === 'member.role_changed' || e.action === 'member.removed')).toEqual([]);
});

test('TEAM-018 member cannot change roles', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { admin, member } = people;

  const demote = await call('PATCH', `/api/projects/${project.id}/members/${admin.userId}`, {
    as: member,
    body: { role: 'member' },
  });
  const promoteSelf = await call('PATCH', `/api/projects/${project.id}/members/${member.userId}`, {
    as: member,
    body: { role: 'admin' },
  });
  for (const result of [demote, promoteSelf]) {
    expect(result.status).toBe(403);
    expect(messageOf(result)).toBe(ROLE_REFUSAL);
  }
  const roles = (await membersOf(project.id, owner)).members.map((m) => m.role);
  expect(roles).toEqual(['owner', 'admin', 'member']);
});

test('TEAM-021 demoting an admin revokes every invite they sent', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;
  const [first, second] = await Promise.all([newPerson('team-i1', 'Ines One'), newPerson('team-i2', 'Ivan Two')]);
  const invites = [
    await sendInvite(project.id, admin, first.email, 'member'),
    await sendInvite(project.id, admin, second.email, 'admin'),
  ];

  await signIn(page, owner);
  await openMembers(page, project.id);
  const pending = cardTitled(page, 'Pending invites');
  await expect(pending.getByText(first.email, { exact: true })).toBeVisible();
  await expect(pending.getByText(second.email, { exact: true })).toBeVisible();

  await chooseRole(page, admin.email, 'Member');
  await expect(toastTitled(page, 'Role changed')).toContainText('Adam Admin is now member.');
  await page.reload();
  await expect(pending.getByText('No pending invites.')).toBeVisible();
  await expect(pending.getByText(first.email, { exact: true })).toHaveCount(0);

  const revoked = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string; revoked: boolean }>(
      `SELECT id, revoked_at IS NOT NULL AS revoked FROM project_invitations WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [invites.map((i) => i.id)],
    );
    return rows;
  });
  expect(revoked).toHaveLength(2);
  expect(revoked.every((row) => row.revoked)).toBe(true);

  for (const [person, invite] of [
    [first, invites[0]],
    [second, invites[1]],
  ] as const) {
    const invitee = await personPage(browser, baseURL, person);
    await invitee.goto(invite.inviteUrl);
    await expect(invitee.getByText('Could not open this invite', { exact: true })).toBeVisible();
    await expect(invitee.getByRole('alert').filter({ hasText: INVITE_GONE })).toBeVisible();
    await invitee.context().close();
  }
});

test('TEAM-022 demoting an owner to admin revokes only their owner invites', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const { coOwner } = people;
  const keeper = await newPerson('team-k', 'Kiran Keeper');
  const ownerInvite = await sendInvite(project.id, coOwner, `team-j-${randomUUID().slice(0, 8)}@e2e.example.test`, 'owner');
  const memberInvite = await sendInvite(project.id, coOwner, keeper.email, 'member');

  const demoted = await call('PATCH', `/api/projects/${project.id}/members/${coOwner.userId}`, {
    as: owner,
    body: { role: 'admin' },
  });
  expect(demoted.status).toBe(200);

  const pendingIds = (await invitationsOf(project.id, owner)).map((i) => i.id);
  expect(pendingIds).toContain(memberInvite.id);
  expect(pendingIds).not.toContain(ownerInvite.id);

  const accepted = await call('POST', '/api/invitations/accept', { as: keeper, body: { token: memberInvite.token } });
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toEqual({ projectId: project.id, role: 'member' });
});

test('TEAM-023 demoting the person offered billing clears the offer', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const { coOwner } = people;
  const offered = await call('POST', `/api/projects/${project.id}/billing-transfer`, {
    as: owner,
    body: { toUserId: coOwner.userId },
  });
  expect(offered.status).toBe(200);
  expect(offered.body.data.billingOffer).toMatchObject({ toUserId: coOwner.userId });

  const demoted = await call('PATCH', `/api/projects/${project.id}/members/${coOwner.userId}`, {
    as: owner,
    body: { role: 'admin' },
  });
  expect(demoted.status).toBe(200);
  expect((await membersOf(project.id, owner)).billingOffer).toBeNull();

  const accept = await call('POST', `/api/projects/${project.id}/billing-transfer/accept`, { as: coOwner });
  expect(accept.status).toBe(403);
  expect(messageOf(accept)).toBe(ROLE_REFUSAL);
  const { members } = await membersOf(project.id, owner);
  expect(members.find((m) => m.isBillingOwner)?.userId).toBe(owner.userId);
});

test('TEAM-024 role change takes effect on the person\'s next request', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { admin, member } = people;

  await signIn(page, admin);
  await openMembers(page, project.id);
  await expect(memberRow(page, member.email).getByRole('combobox')).toBeVisible();
  await openSidebarGroup(page, 'Configure');
  await expect(sidebarLink(page, 'Activity')).toBeVisible();

  const demoted = await call('PATCH', `/api/projects/${project.id}/members/${admin.userId}`, {
    as: owner,
    body: { role: 'member' },
  });
  expect(demoted.status).toBe(200);
  expect((await projectsOf(admin)).find((p) => p.id === project.id)?.permissions).toEqual(MEMBER_PERMISSIONS);

  // The page still shows the form; the server refuses it now.
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/invitations'));
  await page.getByLabel('Email address').fill(`team-new-${randomUUID().slice(0, 8)}@e2e.example.test`);
  await page.getByRole('button', { name: 'Send invite' }).click();
  expect((await posted).status()).toBe(403);
  await expect(page.getByRole('alert').filter({ hasText: ROLE_REFUSAL })).toHaveText(ROLE_REFUSAL);

  await page.reload();
  await expect(memberRow(page, member.email)).toBeVisible();
  await expect(cardTitled(page, 'Invite')).toHaveCount(0);
  await expect(cardTitled(page, 'Pending invites')).toHaveCount(0);
  await expect(membersTable(page).getByRole('combobox')).toHaveCount(0);
  await openSidebarGroup(page, 'Configure');
  await expect(sidebarLink(page, 'Members')).toBeVisible();
  await expect(sidebarLink(page, 'Activity')).toHaveCount(0);
});

// ---- C. Remove a member

test('TEAM-027 owner removes a member', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const { member } = people;
  expect((await projectsOf(member)).map((p) => p.id)).toContain(project.id);

  await signIn(page, owner);
  await openMembers(page, project.id);
  const title = cardTitled(page, 'Members').locator('[data-slot="card-title"]');
  await expect(title).toHaveText(/^Members\s*\(2\)$/);
  await expect(page.getByText(SEAT_LINE)).toHaveText('2 seats');

  await page.getByRole('button', { name: 'Remove Mia Member' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove Mia Member?' });
  await expect(dialog.getByText('They lose access to this project at once. Pending invites they sent are cancelled.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  const deleted = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && r.url().endsWith(`/api/projects/${project.id}/members/${member.userId}`),
  );
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  const response = await deleted;
  expect(response.status()).toBe(200);
  const list = (await response.json()).data.members as Array<{ userId: string }>;
  expect(list.map((m) => m.userId)).toEqual([owner.userId]);

  await expect(toastTitled(page, 'Removed from the project')).toContainText('Mia Member');
  await expect(memberRow(page, member.email)).toHaveCount(0);
  await expect(title).toHaveText(/^Members\s*\(1\)$/);
  await expect(page.getByText(SEAT_LINE)).toHaveText('1 seat');

  expect((await projectsOf(member)).map((p) => p.id)).not.toContain(project.id);
  const gone = await call('GET', `/api/projects/${project.id}`, { as: member });
  expect(gone.status).toBe(404);
  expect(messageOf(gone)).toBe(PROJECT_NOT_FOUND);

  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'member.removed');
  expect(entry).toMatchObject({ actorUserId: owner.userId, targetId: member.userId, targetLabel: personLabel(member) });
  await page.goto(`/projects/${project.id}/activity`);
  await expect(page.getByText(`Omar Owner removed ${personLabel(member)} from the project`, { exact: true })).toBeVisible();
});

test('TEAM-029 removing an owner needs a recent sign-in', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const { coOwner } = people;

  await signInStale(page, owner);
  await openMembers(page, project.id);
  const statuses = watchStatuses(page, 'DELETE', `/members/${coOwner.userId}`);
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  const dialog = page.getByRole('dialog', { name: 'Remove Cara Coowner?' });

  // Cancelling the prompt: nothing happens, and nothing is said.
  await page.getByRole('button', { name: 'Remove Cara Coowner' }).click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toBeHidden();
  await expect(dialog).toBeVisible();
  // The open dialog hides the page from the accessibility tree, so the row is found by CSS.
  await expect(page.locator('tbody tr', { hasText: coOwner.email })).toHaveCount(1);
  await expect(toastTitled(page, 'Not removed')).toHaveCount(0);
  await expect(toastTitled(page, 'Removed from the project')).toHaveCount(0);
  expect(statuses).toEqual([403]);

  // Confirming: the request is sent again and goes through.
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(reauth).toBeVisible();
  await confirmWithPassword(page, owner.password);
  await expect(toastTitled(page, 'Removed from the project')).toContainText('Cara Coowner');
  expect(statuses).toEqual([403, 403, 200]);
  await expect(memberRow(page, coOwner.email)).toHaveCount(0);
  expect((await membersOf(project.id, owner)).members.map((m) => m.userId)).toEqual([owner.userId]);
});

test('TEAM-030 the billing owner cannot be removed', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const result = await call('DELETE', `/api/projects/${project.id}/members/${owner.userId}`, { as: people.coOwner });
  expect(result.status).toBe(409);
  expect(messageOf(result)).toBe(MOVE_BILLING_FIRST);
  const { members } = await membersOf(project.id, owner);
  expect(members.map((m) => [m.userId, m.role, m.isBillingOwner])).toEqual([
    [owner.userId, 'owner', true],
    [people.coOwner.userId, 'owner', false],
  ]);
});

test('TEAM-031 removing someone revokes their invites and clears an offer to them', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const { coOwner } = people;
  const offered = await call('POST', `/api/projects/${project.id}/billing-transfer`, {
    as: owner,
    body: { toUserId: coOwner.userId },
  });
  expect(offered.status).toBe(200);
  const sent = [
    await sendInvite(project.id, coOwner, `team-c1-${randomUUID().slice(0, 8)}@e2e.example.test`, 'member'),
    await sendInvite(project.id, coOwner, `team-c2-${randomUUID().slice(0, 8)}@e2e.example.test`, 'admin'),
  ];
  // An invite the owner sent stays.
  const ownInvite = await sendInvite(project.id, owner, `team-o1-${randomUUID().slice(0, 8)}@e2e.example.test`, 'member');
  expect((await invitationsOf(project.id, owner)).map((i) => i.id).sort()).toEqual(
    [...sent.map((i) => i.id), ownInvite.id].sort(),
  );

  const removed = await call('DELETE', `/api/projects/${project.id}/members/${coOwner.userId}`, { as: owner });
  expect(removed.status).toBe(200);
  const after = await membersOf(project.id, owner);
  expect(after.billingOffer).toBeNull();
  expect(after.members.map((m) => m.userId)).toEqual([owner.userId]);
  expect((await invitationsOf(project.id, owner)).map((i) => i.id)).toEqual([ownInvite.id]);
});

test('TEAM-033 member cannot remove anyone', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    member: ['member', 'Mia Member'],
    member2: ['member', 'Milo Member'],
  });
  const result = await call('DELETE', `/api/projects/${project.id}/members/${people.member2.userId}`, {
    as: people.member,
  });
  expect(result.status).toBe(403);
  expect(messageOf(result)).toBe(ROLE_REFUSAL);
  expect((await membersOf(project.id, owner)).members).toHaveLength(3);
});

test('TEAM-037 removing a member frees a seat and brings the invite form back', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  await withDb((db) => db.query('UPDATE users SET seat_limit = 3 WHERE id = $1', [owner.userId]));

  await signIn(page, owner);
  await openMembers(page, project.id);
  await expect(page.getByText(SEAT_LINE)).toHaveText('3 of 3 seats');
  const full = cardTitled(page, 'Invite').getByRole('status');
  await expect(full).toContainText('Upgrade to invite teammates');
  await expect(full).toContainText('Every seat on this plan is taken. Remove someone or cancel a pending invite to free one.');
  await expect(page.getByLabel('Email address')).toHaveCount(0);

  await page.getByRole('button', { name: 'Remove Mia Member' }).click();
  await page.getByRole('dialog', { name: 'Remove Mia Member?' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(toastTitled(page, 'Removed from the project')).toBeVisible();
  await expect(page.getByText(SEAT_LINE)).toHaveText('2 of 3 seats');
  await expect(full).toHaveCount(0);
  await expect(page.getByLabel('Email address')).toBeVisible();
});

// ---- D. Leave a project

test('TEAM-038 member leaves a project', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] }, 'Team project');
  const { member } = people;

  // A stale sign-in, so a prompt would show if leaving as a member needed one.
  await signInStale(page, member);
  await page.goto(`/projects/${project.id}/settings`);
  const card = cardTitled(page, 'Leave project');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    'You lose access to this project. Pending invites you sent are cancelled.',
  );
  await card.getByRole('button', { name: 'Leave project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Leave Team project?' });
  await expect(dialog.getByText('You lose access at once. To come back, someone has to invite you again.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();

  const left = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/projects/${project.id}/leave`));
  await dialog.getByRole('button', { name: 'Leave project' }).click();
  const response = await left;
  expect(response.status()).toBe(200);
  expect((await response.json()).data).toEqual({ left: true });

  await expect(toastTitled(page, 'You left the project')).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);

  // The settings page was replaced in history: Back does not return to it.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/settings/);
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(page.getByText('Team project')).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/settings/);

  expect((await projectsOf(member)).map((p) => p.id)).not.toContain(project.id);
  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'member.left');
  expect(entry).toMatchObject({ actorUserId: member.userId, targetId: member.userId, targetLabel: personLabel(member) });
});

test('TEAM-039 billing owner cannot leave', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/settings`);
  const card = cardTitled(page, 'Leave project');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    'This project is billed to you, so you cannot leave it. Move billing to another owner first.',
  );
  await expect(card.getByRole('button')).toHaveCount(0);

  const result = await call('POST', `/api/projects/${project.id}/leave`, { as: owner });
  expect(result.status).toBe(409);
  expect(messageOf(result)).toBe(MOVE_BILLING_FIRST);
  expect((await membersOf(project.id, owner)).members.find((m) => m.userId === owner.userId)?.role).toBe('owner');
});

test('TEAM-040 a co-owner leaving needs a recent sign-in', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] }, 'Team project');
  const { coOwner } = people;

  await signInStale(page, coOwner);
  await page.goto(`/projects/${project.id}/settings`);
  const statuses = watchStatuses(page, 'POST', `/api/projects/${project.id}/leave`);
  const card = cardTitled(page, 'Leave project');
  const dialog = page.getByRole('dialog', { name: 'Leave Team project?' });
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });

  // Cancelling the prompt: the dialog closes, nothing is said, and they stay.
  await card.getByRole('button', { name: 'Leave project' }).click();
  await dialog.getByRole('button', { name: 'Leave project' }).click();
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect(toastTitled(page, 'You are still in this project')).toHaveCount(0);
  await expect(toastTitled(page, 'You left the project')).toHaveCount(0);
  expect(statuses).toEqual([403]);
  expect((await membersOf(project.id, owner)).members.map((m) => m.userId)).toContain(coOwner.userId);

  // Confirming: sent again, and they are out.
  await card.getByRole('button', { name: 'Leave project' }).click();
  await dialog.getByRole('button', { name: 'Leave project' }).click();
  await expect(reauth).toBeVisible();
  await confirmWithPassword(page, coOwner.password);
  await expect(toastTitled(page, 'You left the project')).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  expect(statuses).toEqual([403, 403, 200]);
  expect((await membersOf(project.id, owner)).members.map((m) => m.userId)).toEqual([owner.userId]);
});


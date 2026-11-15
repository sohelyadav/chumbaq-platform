import { randomUUID } from 'crypto';
import type { Browser, Page, Request, Response } from '@playwright/test';
import { PASSWORD, createProject, newClientIp, uniqueEmail } from '../../support/api';
import { allowClipboard, readClipboard } from '../../support/browser-tools';
import { confirmWithPassword } from '../../support/factors';
import { expect, newPersonContext, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import { extractLink, waitForMail } from '../../support/mailbox';
import {
  ALREADY_MEMBER,
  BILLING_OFFER_GONE,
  INVITE_GONE,
  MEMBER_NOT_FOUND,
  MOVE_BILLING_FIRST,
  OWNER_PERMISSIONS,
  PROJECT_NOT_FOUND,
  READ_ONLY,
  REAUTH_REQUIRED,
  ROLE_REFUSAL,
  SEAT_LIMIT_MESSAGE,
  acceptInvite,
  activityCount,
  addMember,
  ageBillingOffer,
  ageSignIn,
  billingState,
  call,
  cardTitled,
  chooseRole,
  invitationRecord,
  invitationsOf,
  joinedLabel,
  makeTeam,
  memberRoleIn,
  memberRow,
  membersOf,
  messageOf,
  messagesOf,
  newPerson,
  newStaffMember,
  offerBilling,
  openMembers,
  openSettings,
  openViewAsLink,
  pendingInviteRow,
  previewInvite,
  projectsMetaOf,
  projectsOf,
  reauthenticate,
  renameAccount,
  resendInvite,
  securityAlerts,
  seedTrapAddress,
  sendInvite,
  setInviteExpiry,
  setSeatLimit,
  staleToken,
  teamActivity,
  toastTitled,
  unknownInviteToken,
  viewAsLink,
  viewAsToken,
  type Person,
} from '../../support/areas/team';

/**
 * P1 cases for members and roles, removing and leaving, invitations (create, list,
 * resend, cancel, seats), the /invite page, and billing transfer.
 */

test.describe.configure({ mode: 'parallel' });

const SEAT_LINE = /^\d+ (of \d+ )?seats?$/;
const PENDING_INVITE_KEY = 'chumbaq_pending_invite';

/** Signs `person` in, in a browser of their own. */
async function personPage(browser: Browser, baseURL: string | undefined, person: Person): Promise<Page> {
  const { context } = await newPersonContext(browser, baseURL);
  const page = await context.newPage();
  await signIn(page, person);
  return page;
}

/** Signs in, then moves the sign-in back past the recent sign-in window and reloads, so the page's token is stale. */
async function signInStale(page: Page, person: Person): Promise<void> {
  await signIn(page, person);
  await ageSignIn(person);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
}

/** Records the statuses of the requests matching `method` and a URL path ending. */
function watchStatuses(page: Page, method: string, urlEnd: string): number[] {
  const statuses: number[] = [];
  page.on('response', (response: Response) => {
    if (response.request().method() === method && new URL(response.url()).pathname.endsWith(urlEnd)) {
      statuses.push(response.status());
    }
  });
  return statuses;
}

/** Records the requests matching `method` whose path ends with `urlEnd`. */
function watchRequests(page: Page, method: string, urlEnd: string): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === method && new URL(request.url()).pathname.endsWith(urlEnd)) seen.push(request);
  });
  return seen;
}

/** Fails the test on any alert, confirm or prompt the page opens. */
function noDialogs(page: Page): string[] {
  const opened: string[] = [];
  page.on('dialog', async (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
  return opened;
}

const offerUrl = (projectId: string) => `/api/projects/${projectId}/billing-transfer`;

// ---- A. Members list

test('TEAM-008 names and emails render as text, never HTML', async ({ page }) => {
  const payload = '<img src=x onerror=alert(1)>';
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const member = await renameAccount(people.member, payload);
  const dialogs = noDialogs(page);

  await signIn(page, owner);
  await openMembers(page, project.id);
  const row = memberRow(page, member.email);
  await expect(row.locator('p').first()).toHaveText(payload);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);

  await row.getByRole('button', { name: `Remove ${payload}` }).click();
  const dialog = page.getByRole('dialog', { name: `Remove ${payload}?` });
  await expect(dialog).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await chooseRole(page, member.email, 'Admin');
  await expect(toastTitled(page, 'Role changed')).toContainText(`${payload} is now admin.`);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// ---- B. Change role

test('TEAM-012 cancelling the sign-in prompt leaves the role and shows nothing', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Ada Admin'],
    member: ['member', 'Mia Member'],
  });
  const { admin, member } = people;

  await signInStale(page, owner);
  await openMembers(page, project.id);
  const statuses = watchStatuses(page, 'PATCH', `/members/${admin.userId}`);
  const refused = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.status() === 403);
  await chooseRole(page, admin.email, 'Owner');
  expect((await (await refused).json()).message).toBe(REAUTH_REQUIRED);
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toHaveCount(0);
  await expect(memberRow(page, admin.email).getByRole('combobox')).toHaveText('Admin');

  // A later change that needs no prompt raises a toast of its own; any toast the cancel
  // raised came before it and is still on screen (toasts stay 4 s), so only this one shows.
  await chooseRole(page, member.email, 'Admin');
  const notifications = page.getByRole('region', { name: /Notifications/ }).locator('li');
  await expect(notifications).toHaveCount(1);
  await expect(notifications).toContainText('Mia Member is now admin.');
  await expect(toastTitled(page, 'Role not changed')).toHaveCount(0);
  expect(statuses).toEqual([403]);
  expect(await memberRoleIn(project.id, admin)).toBe('admin');
  const changes = (await teamActivity(project.id, owner)).filter((e) => e.action === 'member.role_changed');
  expect(changes.map((e) => e.targetId)).toEqual([member.userId]);
});

test('TEAM-014 recent sign-in is checked before the owner-count rules', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const path = `/api/projects/${project.id}/members/${owner.userId}`;

  const stale = await call('PATCH', path, { as: await staleToken(owner), body: { role: 'admin' } });
  expect(stale.status).toBe(403);
  expect(messageOf(stale)).toBe(REAUTH_REQUIRED);

  const fresh = await call('PATCH', path, { as: await newSignIn(owner), body: { role: 'admin' } });
  expect(fresh.status).toBe(409);
  expect(messageOf(fresh)).toBe(MOVE_BILLING_FIRST);
  expect(await memberRoleIn(project.id, owner)).toBe('owner');
});

/** A fresh password sign-in through the API (the person's earlier sessions may be aged). */
async function newSignIn(person: Person): Promise<Pick<Person, 'accessToken' | 'ip'>> {
  const result = await call('POST', '/api/auth/login', { ip: person.ip, body: { email: person.email, password: person.password } });
  if (result.status !== 200) throw new Error(`login answered ${result.status}: ${JSON.stringify(result.body)}`);
  return { accessToken: (result.body.data as { tokens: { accessToken: string } }).tokens.accessToken, ip: person.ip };
}

test('TEAM-017 admin manages admins and members', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Ada Admin'],
    admin2: ['admin', 'Alma Admin'],
    member: ['member', 'Mia Member'],
  });
  const { admin, admin2, member } = people;

  // A stale sign-in: a prompt would show if either change needed one.
  await signInStale(page, admin);
  await openMembers(page, project.id);
  const statuses = watchStatuses(page, 'PATCH', '');

  await chooseRole(page, member.email, 'Admin');
  await expect(toastTitled(page, 'Role changed')).toContainText('Mia Member is now admin.');
  await chooseRole(page, admin2.email, 'Member');
  await expect(toastTitled(page, 'Role changed').filter({ hasText: 'Alma Admin is now member.' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);
  expect(statuses).toEqual([200, 200]);
  await expect(memberRow(page, member.email).getByRole('combobox')).toHaveText('Admin');
  await expect(memberRow(page, admin2.email).getByRole('combobox')).toHaveText('Member');

  const changes = (await teamActivity(project.id, owner)).filter((e) => e.action === 'member.role_changed');
  expect(changes).toHaveLength(2);
  for (const entry of changes) expect(entry.actorUserId).toBe(admin.userId);
  expect(changes.map((e) => [e.targetId, e.details]).reverse()).toEqual([
    [member.userId, { from: 'member', to: 'admin' }],
    [admin2.userId, { from: 'admin', to: 'member' }],
  ]);
});

test('TEAM-019 change-role input validation', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const outsider = await newPerson('team-outsider', 'Xavi Outsider');
  const patch = (memberId: string, body: unknown) =>
    call('PATCH', `/api/projects/${project.id}/members/${memberId}`, { as: owner, body });
  const ROLE_LIST = 'role must be one of the following values: owner, admin, member';

  const notUuid = await patch('not-a-uuid', { role: 'admin' });
  expect(notUuid.status).toBe(400);
  expect(messageOf(notUuid)).toBe('Validation failed (uuid is expected)');

  for (const memberId of [randomUUID(), outsider.userId]) {
    const missing = await patch(memberId, { role: 'admin' });
    expect(missing.status).toBe(404);
    expect(messageOf(missing)).toBe(MEMBER_NOT_FOUND);
  }

  for (const body of [{ role: 'superadmin' }, {}]) {
    const bad = await patch(people.member.userId, body);
    expect(bad.status, JSON.stringify(body)).toBe(400);
    expect(messagesOf(bad)).toContain(ROLE_LIST);
  }

  const extra = await patch(people.member.userId, { role: 'admin', extra: 1 });
  expect(extra.status).toBe(400);
  expect(messagesOf(extra)).toContain('property extra should not exist');

  expect(await memberRoleIn(project.id, people.member)).toBe('member');
  expect((await teamActivity(project.id, owner)).filter((e) => e.action === 'member.role_changed')).toEqual([]);
  // The same call with a good body does land.
  expect((await patch(people.member.userId, { role: 'admin' })).status).toBe(200);
});

test('TEAM-025 role change failure shows the server\'s words', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Coowner'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, member } = people;

  await signIn(page, owner);
  await openMembers(page, project.id);
  await expect(memberRow(page, member.email).getByRole('combobox')).toHaveText('Member');
  // Another owner removes Mia after this page loaded.
  expect((await call('DELETE', `/api/projects/${project.id}/members/${member.userId}`, { as: coOwner })).status).toBe(200);

  const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/members/${member.userId}`));
  await chooseRole(page, member.email, 'Admin');
  const response = await patched;
  expect(response.status()).toBe(404);
  expect((await response.json()).message).toBe(MEMBER_NOT_FOUND);
  await expect(toastTitled(page, 'Role not changed')).toContainText(MEMBER_NOT_FOUND);
  await expect(memberRow(page, member.email).getByRole('combobox')).toHaveText('Member');
});

// ---- C. Remove a member

test('TEAM-032 admin removes an admin and a member, not an owner', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Coowner'],
    admin: ['admin', 'Ada Admin'],
    admin2: ['admin', 'Alma Admin'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, admin, admin2, member } = people;

  await signInStale(page, admin);
  await openMembers(page, project.id);
  await expect(memberRow(page, coOwner.email)).toBeVisible();
  await expect(memberRow(page, coOwner.email).getByRole('button')).toHaveCount(0);
  await expect(memberRow(page, coOwner.email).getByRole('combobox')).toHaveCount(0);

  const statuses = watchStatuses(page, 'DELETE', '');
  for (const person of [admin2, member]) {
    await page.getByRole('button', { name: `Remove ${person.name}` }).click();
    await page.getByRole('dialog', { name: `Remove ${person.name}?` }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(toastTitled(page, 'Removed from the project').filter({ hasText: person.name })).toBeVisible();
    await expect(memberRow(page, person.email)).toHaveCount(0);
  }
  expect(statuses).toEqual([200, 200]);
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);

  const refused = await call('DELETE', `/api/projects/${project.id}/members/${coOwner.userId}`, { as: admin });
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe(ROLE_REFUSAL);
  expect((await membersOf(project.id, owner)).members.map((m) => m.userId)).toEqual([owner.userId, coOwner.userId, admin.userId]);
});

test('TEAM-034 remove validation and missing member', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    member: ['member', 'Mia Member'],
    member2: ['member', 'Milo Member'],
  });
  const remove = (memberId: string) =>
    call('DELETE', `/api/projects/${project.id}/members/${memberId}`, { as: { accessToken: owner.accessToken, ip: newClientIp() } });
  const removedEntries = async () => (await teamActivity(project.id, owner)).filter((e) => e.action === 'member.removed');

  const bad = await remove('123');
  expect(bad.status).toBe(400);
  expect(messageOf(bad)).toBe('Validation failed (uuid is expected)');
  const unknown = await remove(randomUUID());
  expect(unknown.status).toBe(404);
  expect(messageOf(unknown)).toBe(MEMBER_NOT_FOUND);

  // One after the other.
  expect((await remove(people.member.userId)).status).toBe(200);
  const again = await remove(people.member.userId);
  expect(again.status).toBe(404);
  expect(messageOf(again)).toBe(MEMBER_NOT_FOUND);
  expect(await removedEntries()).toHaveLength(1);

  // Both at once: one goes through, the racing repeat writes nothing.
  const both = await Promise.all([remove(people.member2.userId), remove(people.member2.userId)]);
  expect(both.map((r) => r.status).sort()).toEqual([200, 404]);
  expect(messageOf(both.find((r) => r.status === 404)!)).toBe(MEMBER_NOT_FOUND);
  const entries = await removedEntries();
  expect(entries).toHaveLength(2);
  expect(entries.map((e) => e.targetId).sort()).toEqual([people.member.userId, people.member2.userId].sort());
});

test('TEAM-036 removed member\'s open tab loses the project', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] }, `Gone ${randomUUID().slice(0, 6)}`);
  const { member } = people;

  await signIn(page, member);
  await page.goto(`/projects/${project.id}/links`);
  await expect(page.getByRole('heading', { name: 'Links', exact: true })).toBeVisible();

  expect((await call('DELETE', `/api/projects/${project.id}/members/${member.userId}`, { as: owner })).status).toBe(200);

  // The next page's requests are refused as if the project did not exist.
  const refused = page.waitForResponse(
    (r) => new URL(r.url()).pathname.startsWith(`/api/projects/${project.id}`) && r.status() === 404,
  );
  await openSidebarGroup(page, 'Main');
  await sidebarLink(page, 'Analytics').click();
  expect((await (await refused).json()).message).toBe(PROJECT_NOT_FOUND);

  await page.reload();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(page.getByText(project.name)).toHaveCount(0);
  expect((await projectsOf(member)).map((p) => p.id)).not.toContain(project.id);
});

// ---- D. Leave a project

test('TEAM-041 admin leaving revokes their invites', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Ada Admin'] });
  const { admin } = people;
  const sent = [
    await sendInvite(project.id, admin, uniqueEmail('team-a1'), 'member'),
    await sendInvite(project.id, admin, uniqueEmail('team-a2'), 'admin'),
  ];
  const ownInvite = await sendInvite(project.id, owner, uniqueEmail('team-o1'), 'member');
  expect((await invitationsOf(project.id, owner)).map((i) => i.id).sort()).toEqual([...sent.map((i) => i.id), ownInvite.id].sort());

  const left = await call('POST', `/api/projects/${project.id}/leave`, { as: admin });
  expect(left.status).toBe(200);
  expect(left.body.data).toEqual({ left: true });
  expect((await invitationsOf(project.id, owner)).map((i) => i.id)).toEqual([ownInvite.id]);
  for (const invite of sent) expect((await invitationRecord(invite.id)).revoked_at).not.toBeNull();

  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'member.left');
  expect(entry).toMatchObject({ actorUserId: admin.userId, targetId: admin.userId });
});

test('TEAM-042 leaving clears a billing offer made to you', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);
  expect((await membersOf(project.id, owner)).billingOffer).toMatchObject({ toUserId: coOwner.userId });

  const left = await call('POST', `/api/projects/${project.id}/leave`, { as: coOwner });
  expect(left.status).toBe(200);
  expect((await membersOf(project.id, owner)).billingOffer).toBeNull();
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: null });

  await signIn(page, owner);
  await openSettings(page, project.id);
  const card = cardTitled(page, 'Billing owner');
  await expect(
    card.getByText('Billing can only move to another owner. Make someone an owner on the Members page first.', { exact: true }),
  ).toBeVisible();
  await expect(card.getByText(/^Offered to/)).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Cancel offer' })).toHaveCount(0);
});

test('TEAM-044 leave by someone not in the project', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const outsider = await newPerson('team-outsider', 'Xavi Outsider');
  expect((await call('POST', `/api/projects/${project.id}/leave`, { as: people.member })).status).toBe(200);
  const before = await activityCount(project.id);

  for (const person of [outsider, people.member]) {
    const result = await call('POST', `/api/projects/${project.id}/leave`, { as: person });
    expect(result.status, person.name).toBe(404);
    expect(messageOf(result)).toBe(PROJECT_NOT_FOUND);
  }
  expect(await activityCount(project.id)).toBe(before);
  expect((await membersOf(project.id, owner)).members.map((m) => m.userId)).toEqual([owner.userId]);
});

// ---- E. Invitations: create, link, list

test('TEAM-047 copy invite link', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invited = uniqueEmail('team-copy');

  await signIn(page, owner);
  await openMembers(page, project.id);
  await allowClipboard(page);
  await page.getByLabel('Email address').fill(invited);
  await page.getByRole('button', { name: 'Send invite' }).click();
  const dialog = page.getByRole('dialog', { name: `Invite link for ${invited}` });
  const shown = (await dialog.locator('code').textContent())!.trim();
  expect(shown).toMatch(/\/invite#token=[A-Za-z0-9_-]{43}$/);

  const copy = dialog.getByRole('button', { name: 'Copy invite link' });
  await expect(copy.locator('svg.lucide-copy')).toHaveCount(1);
  await expect(copy.locator('svg.lucide-check')).toHaveCount(0);
  await copy.click();
  await expect(copy.locator('svg.lucide-check')).toHaveCount(1);
  await expect(copy.locator('svg.lucide-copy')).toHaveCount(0);
  expect(await readClipboard(page)).toBe(shown);
  await expect(toastTitled(page, 'Copy failed')).toHaveCount(0);
});

test('TEAM-049 client-side email check', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  await signIn(page, owner);
  await openMembers(page, project.id);
  const posts = watchRequests(page, 'POST', `/projects/${project.id}/invitations`);
  const field = page.getByLabel('Email address');
  const send = page.getByRole('button', { name: 'Send invite' });
  const alert = cardTitled(page, 'Invite').getByRole('alert');

  // Empty: the browser lets it through (not required), and the handler refuses it.
  await send.click();
  await expect(alert).toHaveText('Enter an email address.');

  // Not an address at all: the browser's own check stops the submit.
  await page.reload();
  await field.fill('not-an-email');
  await send.click();
  expect(await field.evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(true);
  await expect(alert).toHaveCount(0);

  // No dot after the @: the browser accepts it, the handler does not.
  await field.fill('a@b');
  expect(await field.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
  await send.click();
  await expect(alert).toHaveText('Enter an email address.');

  // Positive control: a good address does reach the API.
  expect(posts).toHaveLength(0);
  await field.fill(uniqueEmail('team-check'));
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/invitations'));
  await send.click();
  expect((await posted).status()).toBe(201);
  expect(posts).toHaveLength(1);
});

test('TEAM-050 server-side invite validation', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const ownOther = await createProject(owner, owner.ip, `Other ${randomUUID().slice(0, 6)}`);
  const stranger = await newPerson('team-stranger', 'Sid Stranger');
  const foreign = await createProject(stranger, stranger.ip, `Foreign ${randomUUID().slice(0, 6)}`);
  const invite = (body: unknown) => call('POST', `/api/projects/${project.id}/invitations`, { as: owner, body });
  const email = uniqueEmail('team-valid');
  const ROLE_LIST = 'role must be one of the following values: owner, admin, member';

  const notEmail = await invite({ email: 'x', role: 'member' });
  expect(notEmail.status).toBe(400);
  expect(messagesOf(notEmail)).toContain('email must be an email');

  const long = await invite({ email: `${'a'.repeat(250)}@example.com`, role: 'member' });
  expect(long.status).toBe(400);
  expect(messagesOf(long)).toContain('email must be shorter than or equal to 255 characters');

  for (const body of [{ email, role: 'viewer' }, { email }]) {
    const bad = await invite(body);
    expect(bad.status, JSON.stringify(body)).toBe(400);
    expect(messagesOf(bad)).toContain(ROLE_LIST);
  }

  const elsewhere = await invite({ email, role: 'member', projectId: foreign.id });
  expect(elsewhere.status).toBe(404);
  expect(messageOf(elsewhere)).toBe(PROJECT_NOT_FOUND);
  const ownElsewhere = await invite({ email, role: 'member', projectId: ownOther.id });
  expect(ownElsewhere.status).toBe(400);
  expect(messagesOf(ownElsewhere)).toContain('property projectId should not exist');

  const note = await invite({ email, role: 'member', note: 'hi' });
  expect(note.status).toBe(400);
  expect(messagesOf(note)).toContain('property note should not exist');

  for (const id of [project.id, ownOther.id, foreign.id]) expect(await invitationsOf(id, id === foreign.id ? stranger : owner)).toEqual([]);
  // The same request with only the allowed fields is accepted.
  expect((await invite({ email, role: 'member' })).status).toBe(201);
});

test('TEAM-051 inviting someone already in the project', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const before = await activityCount(project.id);

  await signIn(page, owner);
  await openMembers(page, project.id);
  const alert = cardTitled(page, 'Invite').getByRole('alert');
  for (const address of [people.member.email.toUpperCase(), owner.email]) {
    await page.getByLabel('Email address').fill(address);
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/invitations'));
    await page.getByRole('button', { name: 'Send invite' }).click();
    const response = await posted;
    expect(response.status(), address).toBe(409);
    expect((await response.json()).message).toBe(ALREADY_MEMBER);
    await expect(alert).toHaveText(ALREADY_MEMBER);
  }
  await expect(page.getByRole('dialog', { name: /^Invite link for/ })).toHaveCount(0);
  expect(await invitationsOf(project.id, owner)).toEqual([]);
  expect(await activityCount(project.id)).toBe(before);
});

test('TEAM-057 pending invites list content and order', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Ada Admin'] });
  const { admin } = people;
  const i1 = await sendInvite(project.id, owner, uniqueEmail('team-i1'), 'member');
  const i2 = await sendInvite(project.id, admin, uniqueEmail('team-i2'), 'admin');
  const i3 = await sendInvite(project.id, owner, uniqueEmail('team-i3'), 'owner');
  const i4 = await sendInvite(project.id, owner, uniqueEmail('team-i4'), 'member');
  await setInviteExpiry(i4.id, '-1 minute');
  // An accepted and a revoked invite are not listed.
  const joiner = await newPerson('team-joiner', 'Jade Joiner');
  const accepted = await sendInvite(project.id, owner, joiner.email, 'member');
  expect((await acceptInvite(joiner, accepted.token)).status).toBe(201);
  const revoked = await sendInvite(project.id, owner, uniqueEmail('team-revoked'), 'member');
  expect((await call('DELETE', `/api/projects/${project.id}/invitations/${revoked.id}`, { as: owner })).status).toBe(200);

  const listed = await invitationsOf(project.id, owner);
  expect(listed.map((i) => i.id)).toEqual([i1.id, i2.id, i3.id, i4.id]);
  expect(listed.map((i) => (i as unknown as { expired: boolean }).expired)).toEqual([false, false, false, true]);

  await signIn(page, owner);
  await openMembers(page, project.id);
  const card = cardTitled(page, 'Pending invites');
  await expect(card.getByRole('columnheader')).toHaveText(['Email', 'Role', 'Invited by', 'Expires', '']);
  const rows = card.locator('tbody tr');
  await expect(rows).toHaveCount(4);
  const expires = (iso: string) => joinedLabel(new Date(iso));
  const byId = new Map(listed.map((i) => [i.id, i as unknown as { expiresAt: string }]));
  const expected = [
    [i1.email, 'Member', 'Omar Owner', expires(byId.get(i1.id)!.expiresAt)],
    [i2.email, 'Admin', 'Ada Admin', expires(byId.get(i2.id)!.expiresAt)],
    [i3.email, 'Owner', 'Omar Owner', expires(byId.get(i3.id)!.expiresAt)],
    [i4.email, 'Member', 'Omar Owner', 'Expired'],
  ];
  for (const [index, cells] of expected.entries()) {
    await expect(rows.nth(index).locator('td')).toHaveText([...cells, '']);
    await expect(rows.nth(index).locator('td').nth(1).locator('[data-slot="badge"]')).toHaveText(cells[1]);
  }
  await expect(rows.nth(3).locator('td').nth(3).locator('[data-slot="badge"]')).toHaveText('Expired');
  await expect(card.getByText(joiner.email)).toHaveCount(0);
  await expect(card.getByText(revoked.email)).toHaveCount(0);
});

test('TEAM-059 admin sees no Resend/Cancel on owner invites', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Ada Admin'] });
  const ownerInvite = await sendInvite(project.id, owner, uniqueEmail('team-j'), 'owner');
  const memberInvite = await sendInvite(project.id, owner, uniqueEmail('team-k'), 'member');

  await signIn(page, people.admin);
  await openMembers(page, project.id);
  await expect(pendingInviteRow(page, ownerInvite.email)).toBeVisible();
  await expect(page.getByRole('button', { name: `Resend the invite to ${ownerInvite.email}` })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Cancel the invite to ${ownerInvite.email}` })).toHaveCount(0);
  await expect(pendingInviteRow(page, ownerInvite.email).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Resend the invite to ${memberInvite.email}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Cancel the invite to ${memberInvite.email}` })).toBeVisible();
});

test('TEAM-062 invite to a tripwire address answers like any other', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const trapEmail = uniqueEmail('team-trap');
  const trap = await seedTrapAddress(`e2e team ${randomUUID().slice(0, 8)}`, trapEmail);
  const plainEmail = uniqueEmail('team-plain');

  const shape = (body: { data: Record<string, any> }) => ({
    keys: Object.keys(body.data).sort(),
    invitationKeys: Object.keys(body.data.invitation).sort(),
    emailSent: body.data.emailSent,
    role: body.data.invitation.role,
  });
  const plain = await call('POST', `/api/projects/${project.id}/invitations`, { as: owner, body: { email: plainEmail, role: 'member' } });
  const trapped = await call('POST', `/api/projects/${project.id}/invitations`, { as: owner, body: { email: trapEmail, role: 'member' } });
  expect(plain.status).toBe(201);
  expect(trapped.status).toBe(201);
  expect(shape(trapped.body)).toEqual(shape(plain.body));
  expect(trapped.body.data.invitation.email).toBe(trapEmail);

  // The trap check runs after the answer, and raises its alert then.
  await expect.poll(async () => (await securityAlerts('tripwire.account', `${trap.id}:invite`)).length, { timeout: 15_000 }).toBe(1);
});

// ---- F. Resend and cancel invitations

test('TEAM-064 resending an expired invite revives it, checked like a new seat', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const invitee = uniqueEmail('team-revive');
  const invite = await sendInvite(project.id, owner, invitee, 'member');
  await setInviteExpiry(invite.id, '-1 minute');
  // The owner and Mia take both seats; the expired invite holds none.
  await setSeatLimit(owner, 2);
  expect((await projectsMetaOf(owner)).seats).toEqual({ used: 2, limit: 2 });

  await signIn(page, owner);
  await openMembers(page, project.id);
  const row = pendingInviteRow(page, invitee);
  await expect(row.locator('td').nth(3)).toHaveText('Expired');

  const refused = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/invitations/${invite.id}/resend`));
  await page.getByRole('button', { name: `Resend the invite to ${invitee}` }).click();
  expect((await refused).status()).toBe(403);
  await expect(toastTitled(page, 'Invite not resent')).toContainText(SEAT_LIMIT_MESSAGE);
  await expect(row.locator('td').nth(3)).toHaveText('Expired');

  await setSeatLimit(owner, 3);
  const resent = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/invitations/${invite.id}/resend`));
  await page.getByRole('button', { name: `Resend the invite to ${invitee}` }).click();
  const response = await resent;
  expect(response.status()).toBe(201);
  const created = (await response.json()).data;
  await page.getByRole('dialog', { name: `Invite link for ${invitee}` }).getByRole('button', { name: 'Done' }).click();
  await expect(row.locator('td').nth(3)).toHaveText(joinedLabel(new Date(created.invitation.expiresAt)));
  await expect(row.getByText('Expired', { exact: true })).toHaveCount(0);
});

test('TEAM-065 resending an owner invite needs an owner and a recent sign-in', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Ada Admin'] });
  const invite = await sendInvite(project.id, owner, uniqueEmail('team-owner-invite'), 'owner');
  const resend = (as: Pick<Person, 'accessToken' | 'ip'>) =>
    call('POST', `/api/projects/${project.id}/invitations/${invite.id}/resend`, { as });
  const before = await invitationRecord(invite.id);

  const byAdmin = await resend(people.admin);
  expect(byAdmin.status).toBe(403);
  expect(messageOf(byAdmin)).toBe(ROLE_REFUSAL);

  const stale = await staleToken(owner);
  const byStaleOwner = await resend(stale);
  expect(byStaleOwner.status).toBe(403);
  expect(messageOf(byStaleOwner)).toBe(REAUTH_REQUIRED);
  expect((await invitationRecord(invite.id)).token_hash).toBe(before.token_hash);

  const confirmed = await resend(await reauthenticate(stale, owner.password));
  expect(confirmed.status).toBe(201);
  expect((await invitationRecord(invite.id)).token_hash).not.toBe(before.token_hash);
});

test('TEAM-067 resend and cancel of unknown, foreign or used invitations', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const other = await createProject(owner, owner.ip, `Other ${randomUUID().slice(0, 6)}`);
  const r2 = await sendInvite(other.id, owner, uniqueEmail('team-r2'), 'member');
  const joiner = await newPerson('team-joiner', 'Jade Joiner');
  const r3 = await sendInvite(project.id, owner, joiner.email, 'member');
  expect((await acceptInvite(joiner, r3.token)).status).toBe(201);
  const r4 = await sendInvite(project.id, owner, uniqueEmail('team-r4'), 'member');
  expect((await call('DELETE', `/api/projects/${project.id}/invitations/${r4.id}`, { as: owner })).status).toBe(200);
  const base = `/api/projects/${project.id}/invitations`;
  const as = () => ({ accessToken: owner.accessToken, ip: newClientIp() });

  for (const [kind, id] of Object.entries({ unknown: randomUUID(), foreign: r2.id, accepted: r3.id, revoked: r4.id })) {
    for (const [method, path] of [
      ['POST', `${base}/${id}/resend`],
      ['DELETE', `${base}/${id}`],
    ] as const) {
      const result = await call(method, path, { as: as() });
      expect(result.status, `${method} ${kind}`).toBe(404);
      expect(messageOf(result), `${method} ${kind}`).toBe('Invitation not found');
    }
  }
  const bad = await call('POST', `${base}/not-a-uuid/resend`, { as: as() });
  expect(bad.status).toBe(400);
  expect(messageOf(bad)).toBe('Validation failed (uuid is expected)');

  // The other project's invite is untouched, and still answers through its own project.
  expect((await invitationRecord(r2.id)).revoked_at).toBeNull();
  expect((await invitationsOf(other.id, owner)).map((i) => i.id)).toEqual([r2.id]);
  expect((await resendInvite(other.id, owner, r2.id)).id).toBe(r2.id);
});

// ---- G. Seats

test('TEAM-076 seat line for the billing owner', async ({ page, browser, baseURL }) => {
  const { owner, project } = await makeTeam('Omar Owner', {
    member: ['member', 'Mia Member'],
    admin: ['admin', 'Ada Admin'],
  });
  const seatLine = (p: Page) => p.getByText(SEAT_LINE);

  // No limit: just the count.
  await signIn(page, owner);
  await openMembers(page, project.id);
  await expect(seatLine(page)).toHaveText('3 seats');

  // A live invite counts, an expired one does not.
  await sendInvite(project.id, owner, uniqueEmail('team-live'), 'member');
  const expired = await sendInvite(project.id, owner, uniqueEmail('team-lapsed'), 'member');
  await setInviteExpiry(expired.id, '-1 minute');
  await setSeatLimit(owner, 5);
  await page.reload();
  await expect(seatLine(page)).toHaveText('4 of 5 seats');
  expect((await projectsMetaOf(owner)).seats).toEqual({ used: 4, limit: 5 });
  await expect(page.getByLabel('Email address')).toBeVisible();

  // One person, no limit: singular.
  const solo = await newPerson('team-solo', 'Sol Solo');
  const soloProject = await createProject(solo, solo.ip, `Solo ${randomUUID().slice(0, 6)}`);
  const soloPage = await personPage(browser, baseURL, solo);
  await openMembers(soloPage, soloProject.id);
  await expect(seatLine(soloPage)).toHaveText('1 seat');

  // One person, limit one: full, and the invite form gives way.
  await setSeatLimit(solo, 1);
  await soloPage.reload();
  await expect(seatLine(soloPage)).toHaveText('1 of 1 seat');
  expect((await projectsMetaOf(solo)).seats).toEqual({ used: 1, limit: 1 });
  const full = cardTitled(soloPage, 'Invite').getByRole('status');
  await expect(full).toContainText('Upgrade to invite teammates');
  await expect(full).toContainText('Every seat on this plan is taken. Remove someone or cancel a pending invite to free one.');
  await expect(soloPage.getByLabel('Email address')).toHaveCount(0);
  await soloPage.context().close();
});

test('TEAM-077 seats count one person once across the account\'s projects', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const second = await createProject(owner, owner.ip, `Second ${randomUUID().slice(0, 6)}`);
  await addMember(second.id, people.member, 'member', owner);
  const invitee = uniqueEmail('team-both');
  await sendInvite(project.id, owner, invitee, 'member');
  await sendInvite(second.id, owner, invitee, 'admin');

  // The owner, Mia (in both projects) and the address invited to both.
  expect((await projectsMetaOf(owner)).seats).toEqual({ used: 3, limit: null });

  // Someone counted as a member of one project and invited to the other is still one seat.
  const zed = await newPerson('team-zed', 'Zed Twice');
  await addMember(project.id, zed, 'member', owner);
  expect((await projectsMetaOf(owner)).seats.used).toBe(4);
  await sendInvite(second.id, owner, zed.email, 'member');
  expect((await projectsMetaOf(owner)).seats.used).toBe(4);
});

test('TEAM-080 an admin at the limit is refused even for someone counted elsewhere', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Ada Admin'] });
  const other = await createProject(owner, owner.ip, `Other ${randomUUID().slice(0, 6)}`);
  const zed = await newPerson('team-zed', 'Zed Elsewhere');
  await addMember(other.id, zed, 'member', owner);
  const { used } = (await projectsMetaOf(owner)).seats;
  await setSeatLimit(owner, used);
  const invite = (as: Person) =>
    call('POST', `/api/projects/${project.id}/invitations`, { as, body: { email: zed.email, role: 'member' } });

  const byAdmin = await invite(people.admin);
  expect(byAdmin.status).toBe(403);
  expect(messageOf(byAdmin)).toBe(SEAT_LIMIT_MESSAGE);
  expect(await invitationsOf(project.id, owner)).toEqual([]);

  const byOwner = await invite(owner);
  expect(byOwner.status).toBe(201);
  expect((await projectsMetaOf(owner)).seats).toEqual({ used, limit: used });
});

// ---- H. The /invite page and the accept API

test('TEAM-091 signed out, create an account instead', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const email = uniqueEmail('team-newcomer');
  const invite = await sendInvite(project.id, owner, email, 'member');

  await page.goto(invite.inviteUrl);
  await expect(page.getByText('Sign in to accept your invite', { exact: true })).toBeVisible();
  await expect(page.getByText('Use the email address the invite was sent to. You will come back here afterwards.')).toBeVisible();
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await page.getByLabel('Name').fill('Nia Newcomer');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(`We sent an email to ${email}`)).toBeVisible();

  const mail = await waitForMail(email, { subjectIncludes: 'Finish creating your Chumbaq account' });
  await page.goto(extractLink(mail, '/complete-signup'));
  await expect(page.getByText('Choose a password')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  // Today the sign-up path lands on the project list, not back on the invite.
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_INVITE_KEY)).toBe(invite.token);

  // A tab of its own has no kept token: the link has to be opened again there.
  const otherTab = await page.context().newPage();
  await otherTab.goto('/invite');
  await expect(otherTab.getByText('This invite link is incomplete', { exact: true })).toBeVisible();
  await otherTab.close();

  // The same tab reads the kept token.
  await page.goto('/invite');
  await expect(page.getByText(`Join ${project.name}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Omar Owner invited you to join as a member.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept invite' })).toBeVisible();
});

test('TEAM-095 the invited address matches case-insensitively', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const sam = await newPerson('sam.mixed', 'Sam Mixed');
  expect(sam.email).toBe(sam.email.toLowerCase());
  const mixed = sam.email.replace('sam.mixed', 'Sam.Mixed').replace('@e2e.example.test', '@E2E.example.test');
  expect(mixed).not.toBe(sam.email);
  const invite = await sendInvite(project.id, owner, mixed, 'member');
  expect(invite.email).toBe(sam.email);

  const preview = await previewInvite(sam, invite.token);
  expect(preview.status).toBe(200);
  expect(preview.body.data.matchesAccount).toBe(true);
  const accepted = await acceptInvite(sam, invite.token);
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toEqual({ projectId: project.id, role: 'member' });
});

test('TEAM-097 link with no token', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-invitee', 'Ira Invitee');
  const live = await sendInvite(project.id, owner, invitee.email, 'member');
  const previews = watchRequests(page, 'POST', '/api/invitations/preview');
  const links = ['/invite', '/invite#foo=bar', `/invite?token=${live.token}`];

  const expectIncomplete = async (signedIn: boolean) => {
    for (const link of links) {
      await page.goto('about:blank');
      await page.goto(link);
      await expect(page.getByText('This invite link is incomplete', { exact: true }), link).toBeVisible();
      await expect(page.getByRole('alert'), link).toHaveText(
        'Open the link from the invite email again, or ask whoever invited you for a new one.',
      );
      await expect(page.getByRole('link', { name: 'Go to your projects' }), link).toHaveCount(signedIn ? 1 : 0);
    }
  };
  await expectIncomplete(false);
  await signIn(page, invitee);
  await expectIncomplete(true);
  expect(previews).toHaveLength(0);

  // Positive control: the same token in the fragment is read and previewed.
  await page.goto(live.inviteUrl);
  await expect(page.getByText(`Join ${project.name}`, { exact: true })).toBeVisible();
  expect(previews.length).toBeGreaterThan(0);
  expect((await invitationRecord(live.id)).accepted_at).toBeNull();
});

test('TEAM-099 already a member when accepting', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-already', 'Ira Invitee');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');
  await addMember(project.id, invitee, 'member', owner);

  await signIn(page, invitee);
  await page.goto(invite.inviteUrl);
  await expect(page.getByText(`Join ${project.name}`, { exact: true })).toBeVisible();
  const accepted = page.waitForResponse((r) => r.url().endsWith('/api/invitations/accept'));
  await page.getByRole('button', { name: 'Accept invite' }).click();
  const response = await accepted;
  expect(response.status()).toBe(409);
  expect((await response.json()).message).toBe(ALREADY_MEMBER);
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('You are already a member of this project.');
  await expect(alert).toHaveClass(/text-destructive/);

  expect((await invitationRecord(invite.id)).accepted_at).toBeNull();
  expect((await teamActivity(project.id, owner)).filter((e) => e.action === 'invite.accepted')).toEqual([]);
});

test('TEAM-102 accept answers project and role', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-new-owner', 'Ivo Newowner');
  const invite = await sendInvite(project.id, owner, invitee.email, 'owner');
  expect((await projectsMetaOf(owner)).seats.used).toBe(2);

  // A sign-in older than the recent window is enough to accept an owner invite.
  const accepted = await acceptInvite(await staleToken(invitee), invite.token);
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toEqual({ projectId: project.id, role: 'owner' });

  const listed = (await projectsOf(invitee)).find((p) => p.id === project.id);
  expect(listed).toMatchObject({ role: 'owner', isBillingOwner: false, permissions: OWNER_PERMISSIONS });
  expect((await billingState(project.id)).ownerId).toBe(owner.userId);
  expect((await projectsMetaOf(owner)).seats.used).toBe(2);
  expect((await membersOf(project.id, owner)).members.map((m) => m.userId)).toEqual([owner.userId, invitee.userId]);
});

test('TEAM-103 preview and accept body validation', async () => {
  const person = await newPerson('team-validate', 'Val Validate');
  const preview = (body: unknown) =>
    call('POST', '/api/invitations/preview', { as: { accessToken: person.accessToken, ip: newClientIp() }, body });
  const accept = (body: unknown) =>
    call('POST', '/api/invitations/accept', { as: { accessToken: person.accessToken, ip: newClientIp() }, body });

  const cases: Array<[unknown, string]> = [
    [{}, 'token must be a string'],
    [{ token: '' }, 'token must be longer than or equal to 1 characters'],
    [{ token: 'x'.repeat(129) }, 'token must be shorter than or equal to 128 characters'],
    [{ token: 'abc', extra: 1 }, 'property extra should not exist'],
  ];
  for (const send of [preview, accept]) {
    for (const [body, message] of cases) {
      const result = await send(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(messagesOf(result), JSON.stringify(body)).toContain(message);
    }
    // A number is turned into a string by the pipe's implicit conversion, so it is junk like any other.
    for (const token of ['x'.repeat(128), 5]) {
      const junk = await send({ token });
      expect(junk.status, String(token)).toBe(400);
      expect(messageOf(junk), String(token)).toBe(INVITE_GONE);
    }
  }
});

test('TEAM-108 preview does not reveal the invited address in full', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const sam = uniqueEmail('sam');
  const local = sam.split('@')[0];
  const invite = await sendInvite(project.id, owner, sam, 'member');
  const other = await newPerson('team-other', 'Yan Other');

  const result = await previewInvite(other, invite.token);
  expect(result.status).toBe(200);
  expect(result.body.data).toEqual({
    projectName: project.name,
    role: 'member',
    inviterName: 'Omar Owner',
    invitedEmailMasked: 's***@e2e.example.test',
    matchesAccount: false,
    emailVerificationRequired: false,
  });
  const text = JSON.stringify(result.body);
  expect(text).not.toContain(sam);
  expect(text).not.toContain(local);
});

test('TEAM-112 project and inviter names render as text on the invite page', async ({ page }) => {
  const projectName = '<script>alert(1)</script>';
  const owner = await renameAccount(await newPerson('team-owner', 'Omar Owner'), '<b>Bold</b>');
  const project = await createProject(owner, owner.ip, projectName);
  const invitee = await newPerson('team-invitee', 'Ira Invitee');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');
  const dialogs = noDialogs(page);

  await signIn(page, invitee);
  await page.goto(invite.inviteUrl);
  await expect(page.getByText(`Join ${projectName}`, { exact: true })).toBeVisible();
  await expect(page.getByText('<b>Bold</b> invited you to join as a member.', { exact: true })).toBeVisible();
  await expect(page.locator('b', { hasText: 'Bold' })).toHaveCount(0);
  await expect(page.locator('script', { hasText: 'alert(1)' })).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('TEAM-113 view-as cannot preview or accept', async ({ browser, baseURL }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const tenant = await newPerson('team-tenant', 'Tia Tenant');
  const invite = await sendInvite(project.id, owner, tenant.email, 'member');
  const staff = await newStaffMember(browser);

  const viewAs = await openViewAsLink(browser, baseURL, await viewAsLink(staff, tenant));
  const previewed = viewAs.waitForResponse((r) => r.url().endsWith('/api/invitations/preview'));
  await viewAs.goto(invite.inviteUrl);
  const response = await previewed;
  expect(response.status()).toBe(403);
  expect((await response.json()).message).toBe(READ_ONLY);
  // The invite page sits outside the layouts that mount the toaster, so the page says it itself.
  await expect(viewAs.getByText('Could not open this invite', { exact: true })).toBeVisible();
  await expect(viewAs.getByRole('alert').filter({ hasText: READ_ONLY })).toHaveText(READ_ONLY);
  await viewAs.context().close();

  const token = await viewAsToken(await viewAsLink(staff, tenant));
  const accepted = await acceptInvite(token, invite.token);
  expect(accepted.status).toBe(403);
  expect(messageOf(accepted)).toBe(READ_ONLY);
  expect((await invitationRecord(invite.id)).accepted_at).toBeNull();
  expect(await memberRoleIn(project.id, tenant)).toBeNull();
  // The tenant's own session still can.
  expect((await acceptInvite(tenant, invite.token)).status).toBe(201);
});

// ---- I. Billing transfer

test('TEAM-114 billing owner card with no other owner', async ({ page }) => {
  const { project, owner } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Ada Admin'],
    member: ['member', 'Mia Member'],
  });

  await signIn(page, owner);
  await openSettings(page, project.id);
  const card = cardTitled(page, 'Billing owner');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    'This project is billed to you. You can hand billing to another owner; it moves once they accept.',
  );
  await expect(
    card.getByText('Billing can only move to another owner. Make someone an owner on the Members page first.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Owner to offer billing to' })).toHaveCount(0);
  await expect(card.getByRole('button')).toHaveCount(0);
});

test('TEAM-117 a new offer replaces the earlier one', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    coOwner2: ['owner', 'Dan Dualowner'],
  });
  const { coOwner, coOwner2 } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);
  await ageBillingOffer(project.id, '3 days');

  // While the offer is Cara's, her settings page shows it.
  await signIn(page, coOwner);
  await openSettings(page, project.id);
  await expect(cardTitled(page, 'Take over billing')).toBeVisible();

  const before = Date.now();
  expect((await offerBilling(project.id, owner, coOwner2)).status).toBe(200);
  const offer = (await membersOf(project.id, owner)).billingOffer as { toUserId: string; offeredAt: string; expiresAt: string };
  expect(offer.toUserId).toBe(coOwner2.userId);
  expect(Math.abs(new Date(offer.offeredAt).getTime() - before)).toBeLessThan(60_000);
  expect(new Date(offer.expiresAt).getTime() - new Date(offer.offeredAt).getTime()).toBe(7 * 24 * 60 * 60 * 1000);

  // The card hangs on the members query, so wait for that answer before looking for it.
  const membersLoaded = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/projects/${project.id}/members`,
  );
  await page.reload();
  const seen = (await (await membersLoaded).json()).data.billingOffer as { toUserId: string };
  expect(seen.toUserId).toBe(coOwner2.userId);
  await cardTitled(page, 'Leave project').waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
  await expect(cardTitled(page, 'Take over billing')).toHaveCount(0);
  const late = await call('POST', `${offerUrl(project.id)}/accept`, { as: coOwner });
  expect(late.status).toBe(400);
  expect(messageOf(late)).toBe(BILLING_OFFER_GONE);
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: coOwner2.userId });

  const receiver = await personPage(browser, baseURL, coOwner2);
  await openSettings(receiver, project.id);
  await expect(cardTitled(receiver, 'Take over billing')).toBeVisible();
  await receiver.context().close();
});

test('TEAM-125 accept refused for admins and members by the guard', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Ada Admin'],
    member: ['member', 'Mia Member'],
  });
  for (const person of [people.admin, people.member]) {
    const result = await call('POST', `${offerUrl(project.id)}/accept`, { as: person });
    expect(result.status, person.name).toBe(403);
    expect(messageOf(result)).toBe(ROLE_REFUSAL);
  }
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: null });
});

test('TEAM-128 decline refused to anyone else', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    coOwner2: ['owner', 'Dan Dualowner'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, coOwner2, member } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);
  const decline = (person: Person) => call('POST', `${offerUrl(project.id)}/decline`, { as: person });

  for (const person of [coOwner2, member, owner]) {
    const result = await decline(person);
    expect(result.status, person.name).toBe(400);
    expect(messageOf(result)).toBe(BILLING_OFFER_GONE);
  }
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: coOwner.userId });

  expect((await call('DELETE', offerUrl(project.id), { as: owner })).status).toBe(200);
  const none = await decline(coOwner);
  expect(none.status).toBe(400);
  expect(messageOf(none)).toBe(BILLING_OFFER_GONE);
  expect((await teamActivity(project.id, owner)).filter((e) => e.action === 'billing.transfer_declined')).toEqual([]);
});

test('TEAM-132 billing transfer by view-as is read-only', async ({ browser }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);
  const staff = await newStaffMember(browser);
  const viewAs = await viewAsToken(await viewAsLink(staff, owner));
  const before = await activityCount(project.id);

  const attempts: Array<[string, string, unknown]> = [
    ['POST', offerUrl(project.id), { toUserId: coOwner.userId }],
    ['DELETE', offerUrl(project.id), undefined],
    ['POST', `${offerUrl(project.id)}/accept`, undefined],
    ['POST', `${offerUrl(project.id)}/decline`, undefined],
  ];
  for (const [method, path, body] of attempts) {
    const result = await call(method, path, { as: viewAs, body });
    expect(result.status, `${method} ${path}`).toBe(403);
    expect(messageOf(result), `${method} ${path}`).toBe(READ_ONLY);
  }
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: coOwner.userId });
  // Only the view-as itself was logged.
  expect(await activityCount(project.id)).toBe(before);
  // The owner's own session can cancel.
  expect((await call('DELETE', offerUrl(project.id), { as: owner })).status).toBe(200);
});

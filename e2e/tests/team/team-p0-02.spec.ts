import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import type { Browser, Page, Request } from '@playwright/test';
import { createProject, newClientIp, uniqueEmail } from '../../support/api';
import { adminUrl, enrolAndSignInStaff, grantSuperAdmin } from '../../support/admin';
import { confirmWithPassword } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { LOG_DIR } from '../../support/stack';
import {
  ALREADY_MEMBER,
  INVITATION_VIEW_KEYS,
  INVITES_SUSPENDED,
  INVITE_GONE,
  REAUTH_REQUIRED,
  ROLE_REFUSAL,
  SEAT_LIMIT_MESSAGE,
  acceptInvite,
  ageSignIn,
  call,
  cardTitled,
  expectTeamActivitySentence,
  invitationRecord,
  invitationRowsAsText,
  invitationsOf,
  joinedLabel,
  makeTeam,
  memberRoleIn,
  membersOf,
  messageOf,
  newPerson,
  openMembers,
  pendingInviteRow,
  previewInvite,
  projectsOf,
  reactivateAccount,
  resendInvite,
  sendInvite,
  setInviteExpiry,
  setSeatLimit,
  sha256Hex,
  suspendAccount,
  teamActivity,
  toastTitled,
  unknownInviteToken,
  withDb,
  type Person,
} from '../../support/areas/team';

/**
 * Invitations: creating one and its once-only link, resending and cancelling, the
 * inviter's authority and the seat limit behind them, a suspended billing owner, and
 * the invitee's side (the /invite page and the preview and accept routes).
 */

test.describe.configure({ mode: 'parallel' });

const SEAT_LINE = /^\d+ (of \d+ )?seats?$/;
const INVITE_LINK = /^https:\/\/localhost:\d+\/invite#token=[A-Za-z0-9_-]{43}$/;
const PENDING_INVITE_KEY = 'chumbaq_pending_invite';

/** Signs `person` in, in a browser of their own. */
async function personPage(browser: Browser, baseURL: string | undefined, person: Person): Promise<Page> {
  const { context } = await newPersonContext(browser, baseURL);
  const page = await context.newPage();
  await signIn(page, person);
  return page;
}

/** Fills the customer sign-in form (for a tab that should land somewhere other than the project list). */
async function fillSignIn(page: Page, person: Person): Promise<void> {
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
}

/** Holds requests matching `method` and a URL ending until `release` is called. */
async function holdRequests(page: Page, method: string, urlEnd: string): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname.endsWith(urlEnd),
    async (route) => {
      if (route.request().method() === method) await released;
      await route.continue();
    },
  );
  return release;
}

/** A pending-invite expiry the way the table shows it (`MMM d, yyyy`). */
function expiresLabel(iso: string | Date): string {
  return joinedLabel(new Date(iso));
}

function sessionToken(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_INVITE_KEY);
}

// ---- E. Create, link, list

test('TEAM-045 owner invites a member and gets the link once', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const typed = `Invitee-${uniqueEmail('x').split('@')[0]}@E2E.example.test `;
  const invited = typed.trim().toLowerCase();

  await signIn(page, owner);
  await openMembers(page, project.id);
  await page.getByLabel('Email address').fill(typed);
  await expect(page.getByLabel('Role')).toHaveText('Member');

  const release = await holdRequests(page, 'POST', `/projects/${project.id}/invitations`);
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/projects/${project.id}/invitations`));
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByRole('button', { name: 'Inviting...' })).toBeDisabled();
  release();
  const response = await posted;
  expect(response.status()).toBe(201);
  const created = (await response.json()).data;
  expect(Object.keys(created).sort()).toEqual(['emailSent', 'invitation', 'inviteUrl']);
  // The stack sends account email, so the invite is mailed as well as shown.
  expect(created.emailSent).toBe(true);
  expect(created.invitation).toMatchObject({ email: invited, role: 'member', invitedBy: { id: owner.userId, name: 'Omar Owner' } });
  expect(created.inviteUrl).toMatch(INVITE_LINK);
  const token = new URL(created.inviteUrl).hash.slice('#token='.length);

  const dialog = page.getByRole('dialog', { name: `Invite link for ${invited}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Email sent. You can also share this link yourself.')).toBeVisible();
  await expect(dialog.locator('code')).toHaveText(created.inviteUrl);
  await expect(
    dialog.getByText('This is the only time the link is shown. It works once, for 7 days, and only for that email address.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByLabel('Email address')).toHaveValue('');
  await expect(page.getByLabel('Role')).toHaveText('Member');
  const row = pendingInviteRow(page, invited);
  await expect(row.locator('td')).toHaveText([invited, 'Member', 'Omar Owner', expiresLabel(created.invitation.expiresAt), '']);
  const sevenDays = new Date(created.invitation.expiresAt).getTime() - Date.now();
  expect(Math.abs(sevenDays - 7 * 24 * 3600_000)).toBeLessThan(60_000);

  // Only the token's hash is stored, and the token is in no stored column and no log.
  const record = await invitationRecord(created.invitation.id);
  expect(record.token_hash).toBe(sha256Hex(token));
  for (const text of await invitationRowsAsText(project.id)) expect(text).not.toContain(token);
  for (const file of readdirSync(LOG_DIR)) {
    expect(readFileSync(path.join(LOG_DIR, file), 'utf8'), file).not.toContain(token);
  }

  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'member.invited');
  expect(entry).toMatchObject({
    actorUserId: owner.userId,
    targetId: created.invitation.id,
    targetLabel: invited,
    details: { role: 'member', email: invited },
  });
  await expectTeamActivitySentence(page, project.id, `Omar Owner invited ${invited} as a member`);
});

test('TEAM-046 the invite link is never shown again', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invited = uniqueEmail('team-once');

  await signIn(page, owner);
  await openMembers(page, project.id);
  await page.getByLabel('Email address').fill(invited);
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/invitations'));
  await page.getByRole('button', { name: 'Send invite' }).click();
  const created = (await (await posted).json()).data;
  const token = new URL(created.inviteUrl).hash.slice('#token='.length);
  await page.getByRole('dialog', { name: `Invite link for ${invited}` }).getByRole('button', { name: 'Done' }).click();

  const listed = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith('/invitations'));
  await page.reload();
  const list = await (await listed).json();
  await expect(pendingInviteRow(page, invited)).toBeVisible();
  await expect(pendingInviteRow(page, invited).getByRole('link')).toHaveCount(0);
  await expect(page.getByText(/invite#token=/)).toHaveCount(0);
  expect(await page.content()).not.toContain(token);

  expect(JSON.stringify(list)).not.toContain(token);
  expect(list.data).toHaveLength(1);
  expect(Object.keys(list.data[0]).sort()).toEqual(INVITATION_VIEW_KEYS);
  const viaApi = await invitationsOf(project.id, owner);
  expect(Object.keys(viaApi[0]).sort()).toEqual(INVITATION_VIEW_KEYS);
  expect(viaApi[0]).not.toHaveProperty('token');
  expect(viaApi[0]).not.toHaveProperty('inviteUrl');
});

test('TEAM-052 re-inviting a pending address replaces the invite in place', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-reinvite', 'Ira Invitee');
  const first = await sendInvite(project.id, owner, invitee.email, 'member');
  await setInviteExpiry(first.id, '3 days');

  const again = await call('POST', `/api/projects/${project.id}/invitations`, {
    as: owner,
    body: { email: invitee.email, role: 'admin' },
  });
  expect(again.status).toBe(201);
  const invitation = again.body.data.invitation;
  expect(invitation.id).toBe(first.id);
  expect(invitation.role).toBe('admin');
  expect(Math.abs(new Date(invitation.expiresAt).getTime() - Date.now() - 7 * 24 * 3600_000)).toBeLessThan(60_000);
  const secondToken = new URL(again.body.data.inviteUrl).hash.slice('#token='.length);
  expect(secondToken).not.toBe(first.token);

  const pending = await invitationsOf(project.id, owner);
  expect(pending.filter((i) => i.email === invitee.email)).toHaveLength(1);

  const old = await previewInvite(invitee, first.token);
  expect(old.status).toBe(400);
  expect(messageOf(old)).toBe(INVITE_GONE);
  const fresh = await previewInvite(invitee, secondToken);
  expect(fresh.status).toBe(200);
  expect(fresh.body.data).toMatchObject({ role: 'admin', projectName: project.name, matchesAccount: true });

  const invited = (await teamActivity(project.id, owner)).filter((e) => e.action === 'member.invited' && e.targetId === first.id);
  expect(invited.map((e) => e.details?.role)).toEqual(['admin', 'member']);
});

test('TEAM-053 admin invites admins and members only', async ({ page }) => {
  const { project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;

  await signIn(page, admin);
  await openMembers(page, project.id);
  const line = cardTitled(page, 'Invite').locator('p.text-xs');
  await expect(line).toHaveText('Links, campaigns, audiences and people. Cannot change settings.');
  await page.getByLabel('Role').click();
  await expect(page.getByRole('option')).toHaveText(['Admin', 'Member']);
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  await expect(line).toHaveText('Channels, API keys, webhooks and members. Cannot change owners.');
  await page.getByLabel('Role').click();
  await page.getByRole('option', { name: 'Member', exact: true }).click();
  await expect(line).toHaveText('Links, campaigns, audiences and people. Cannot change settings.');

  const refused = await call('POST', `/api/projects/${project.id}/invitations`, {
    as: admin,
    body: { email: uniqueEmail('team-would-own'), role: 'owner' },
  });
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe(ROLE_REFUSAL);
  expect(await invitationRowsAsText(project.id)).toEqual([]);
});

test('TEAM-054 owner invites an owner with a recent sign-in', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invited = uniqueEmail('team-new-owner');

  await signIn(page, owner);
  await ageSignIn(owner);
  await page.reload();
  await openMembers(page, project.id);
  await page.getByLabel('Role').click();
  await page.getByRole('option', { name: 'Owner', exact: true }).click();
  await expect(cardTitled(page, 'Invite').locator('p.text-xs')).toHaveText(
    'Everything, including privacy requests, project settings and deleting the project.',
  );
  await page.getByLabel('Email address').fill(invited);

  const statuses: number[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().endsWith(`/projects/${project.id}/invitations`)) statuses.push(r.status());
  });
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });

  // Cancelling the prompt: nothing created, nothing said under the form.
  const firstRefusal = page.waitForResponse((r) => r.request().method() === 'POST' && r.status() === 403);
  await page.getByRole('button', { name: 'Send invite' }).click();
  expect((await (await firstRefusal).json()).message).toBe(REAUTH_REQUIRED);
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send invite' })).toBeEnabled();
  await expect(cardTitled(page, 'Invite').getByRole('alert')).toHaveCount(0);
  expect(await invitationsOf(project.id, owner)).toEqual([]);

  // Confirming: the refused request is sent again and goes through.
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(reauth).toBeVisible();
  await confirmWithPassword(page, owner.password);
  const dialog = page.getByRole('dialog', { name: `Invite link for ${invited}` });
  await expect(dialog).toBeVisible();
  expect(statuses).toEqual([403, 403, 201]);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(pendingInviteRow(page, invited).locator('td').nth(1)).toHaveText('Owner');
  expect((await invitationsOf(project.id, owner)).map((i) => [i.email, i.role])).toEqual([[invited, 'owner']]);
});

test('TEAM-055 admin cannot replace a pending owner invite', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;
  const joiner = await newPerson('team-j', 'Jo Joiner');
  const invite = await sendInvite(project.id, owner, joiner.email, 'owner');
  const before = await invitationRecord(invite.id);

  const replaced = await call('POST', `/api/projects/${project.id}/invitations`, {
    as: admin,
    body: { email: joiner.email, role: 'member' },
  });
  expect(replaced.status).toBe(403);
  expect(messageOf(replaced)).toBe(ROLE_REFUSAL);

  const after = await invitationRecord(invite.id);
  expect(after).toEqual(before);
  const preview = await previewInvite(joiner, invite.token);
  expect(preview.status).toBe(200);
  expect(preview.body.data.role).toBe('owner');
});

test('TEAM-056 member cannot list or create invitations', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const { member } = people;
  const invite = await sendInvite(project.id, owner, uniqueEmail('team-pending'), 'member');
  const base = `/api/projects/${project.id}/invitations`;

  const results = [
    await call('GET', base, { as: member }),
    await call('POST', base, { as: member, body: { email: uniqueEmail('team-by-member'), role: 'member' } }),
    await call('POST', `${base}/${invite.id}/resend`, { as: member }),
    await call('DELETE', `${base}/${invite.id}`, { as: member }),
  ];
  for (const result of results) {
    expect(result.status).toBe(403);
    expect(messageOf(result)).toBe(ROLE_REFUSAL);
  }
  expect((await invitationsOf(project.id, owner)).map((i) => i.id)).toEqual([invite.id]);
  expect((await invitationRecord(invite.id)).token_hash).toBe(sha256Hex(invite.token));
});

// ---- F. Resend and cancel

test('TEAM-063 resend makes a new link and kills the old one', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-resend', 'Ira Invitee');
  const first = await sendInvite(project.id, owner, invitee.email, 'member');
  await setInviteExpiry(first.id, '2 days');
  const aged = await invitationRecord(first.id);

  await signIn(page, owner);
  await openMembers(page, project.id);
  const row = pendingInviteRow(page, invitee.email);
  await expect(row.locator('td').nth(3)).toHaveText(expiresLabel(aged.expires_at));

  const resent = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/invitations/${first.id}/resend`));
  await page.getByRole('button', { name: `Resend the invite to ${invitee.email}` }).click();
  const response = await resent;
  expect(response.status()).toBe(201);
  const created = (await response.json()).data;
  const dialog = page.getByRole('dialog', { name: `Invite link for ${invitee.email}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Email sent. You can also share this link yourself.')).toBeVisible();
  await expect(dialog.locator('code')).toHaveText(INVITE_LINK);
  await expect(dialog.locator('code')).toHaveText(created.inviteUrl);
  expect(created.inviteUrl).not.toBe(first.inviteUrl);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(row.locator('td').nth(3)).toHaveText(expiresLabel(created.invitation.expiresAt));
  expect(Math.abs(new Date(created.invitation.expiresAt).getTime() - Date.now() - 7 * 24 * 3600_000)).toBeLessThan(60_000);

  const secondToken = new URL(created.inviteUrl).hash.slice('#token='.length);
  const old = await previewInvite(invitee, first.token);
  expect(old.status).toBe(400);
  expect(messageOf(old)).toBe(INVITE_GONE);
  expect((await previewInvite(invitee, secondToken)).status).toBe(200);

  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'invite.resent');
  expect(entry).toMatchObject({ actorUserId: owner.userId, targetId: first.id, targetLabel: invitee.email });
  await expectTeamActivitySentence(page, project.id, `Omar Owner resent the invite to ${invitee.email}`);
});

test('TEAM-068 cancel an invite', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-cancel', 'Ira Invitee');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');

  await signIn(page, owner);
  await openMembers(page, project.id);
  await expect(page.getByText(SEAT_LINE)).toHaveText('2 seats');
  const deleted = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/invitations/${invite.id}`));
  await page.getByRole('button', { name: `Cancel the invite to ${invitee.email}` }).click();
  const response = await deleted;
  expect(response.status()).toBe(200);
  expect((await response.json()).data).toEqual([]);
  await expect(toastTitled(page, 'Invite cancelled')).toBeVisible();
  await expect(pendingInviteRow(page, invitee.email)).toHaveCount(0);
  await expect(cardTitled(page, 'Pending invites').getByText('No pending invites.')).toBeVisible();
  await expect(page.getByText(SEAT_LINE)).toHaveText('1 seat');

  for (const result of [await previewInvite(invitee, invite.token), await acceptInvite(invitee, invite.token)]) {
    expect(result.status).toBe(400);
    expect(messageOf(result)).toBe(INVITE_GONE);
  }
  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'invite.cancelled');
  expect(entry).toMatchObject({ actorUserId: owner.userId, targetId: invite.id, targetLabel: invitee.email });
  await expectTeamActivitySentence(page, project.id, `Omar Owner cancelled the invite to ${invitee.email}`);
});

test('TEAM-071 admin cannot cancel an owner invite', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;
  const invite = await sendInvite(project.id, owner, uniqueEmail('team-j'), 'owner');

  const refused = await call('DELETE', `/api/projects/${project.id}/invitations/${invite.id}`, { as: admin });
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe(ROLE_REFUSAL);
  expect((await invitationsOf(project.id, owner)).map((i) => [i.id, i.role])).toEqual([[invite.id, 'owner']]);
  expect((await invitationRecord(invite.id)).revoked_at).toBeNull();
});

// ---- G. Inviter authority, seats, suspension

test('TEAM-074 an invite dies with its inviter\'s removal', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;
  const invitee = await newPerson('team-orphan', 'Ira Invitee');
  const invite = await sendInvite(project.id, admin, invitee.email, 'member');

  const removed = await call('DELETE', `/api/projects/${project.id}/members/${admin.userId}`, { as: owner });
  expect(removed.status).toBe(200);

  const accepted = await acceptInvite(invitee, invite.token);
  expect(accepted.status).toBe(400);
  expect(messageOf(accepted)).toBe(INVITE_GONE);
  expect(await memberRoleIn(project.id, invitee)).toBeNull();
  expect((await projectsOf(invitee)).map((p) => p.id)).not.toContain(project.id);
});

test('TEAM-075 accept refuses when the inviter lost the right without a revoke', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    coOwner: ['owner', 'Cara Coowner'],
  });
  const { admin, coOwner } = people;
  const [byDemotedAdmin, byDemotedOwner, byNobody] = await Promise.all([
    newPerson('team-v1', 'Vera One'),
    newPerson('team-v2', 'Vic Two'),
    newPerson('team-v3', 'Val Three'),
  ]);
  const invites = [
    await sendInvite(project.id, admin, byDemotedAdmin.email, 'member'),
    await sendInvite(project.id, coOwner, byDemotedOwner.email, 'owner'),
    await sendInvite(project.id, owner, byNobody.email, 'member'),
  ];
  // Straight in the database, past the service's own revoke.
  await withDb(async (db) => {
    await db.query(`UPDATE project_members SET role = 'member' WHERE project_id = $1 AND user_id = $2`, [project.id, admin.userId]);
    await db.query(`UPDATE project_members SET role = 'admin' WHERE project_id = $1 AND user_id = $2`, [project.id, coOwner.userId]);
    await db.query('UPDATE project_invitations SET invited_by = NULL WHERE id = $1', [invites[2].id]);
  });
  for (const invite of invites) expect((await invitationRecord(invite.id)).revoked_at).toBeNull();

  for (const [person, invite] of [
    [byDemotedAdmin, invites[0]],
    [byDemotedOwner, invites[1]],
    [byNobody, invites[2]],
  ] as const) {
    const accepted = await acceptInvite(person, invite.token);
    expect(accepted.status).toBe(400);
    expect(messageOf(accepted)).toBe(INVITE_GONE);
    expect(await memberRoleIn(project.id, person)).toBeNull();
    const record = await invitationRecord(invite.id);
    expect(record.revoked_at).not.toBeNull();
    expect(record.accepted_at).toBeNull();
    expect(record.accepted_by).toBeNull();
  }
});

test('TEAM-078 seat limit refuses a new invite', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const { member } = people;
  // Someone invited to another of the owner's projects already holds a seat.
  const other = await createProject(owner, owner.ip, `Other ${project.name}`);
  const elsewhere = uniqueEmail('team-elsewhere');
  await sendInvite(other.id, owner, elsewhere, 'member');
  await setSeatLimit(owner, 3);

  await signIn(page, owner);
  await openMembers(page, project.id);
  await expect(page.getByText(SEAT_LINE)).toHaveText('3 of 3 seats');
  const full = cardTitled(page, 'Invite').getByRole('status');
  await expect(full).toContainText('Upgrade to invite teammates');
  await expect(page.getByLabel('Email address')).toHaveCount(0);

  const base = `/api/projects/${project.id}/invitations`;
  const fresh = await call('POST', base, { as: owner, body: { email: uniqueEmail('team-no-seat'), role: 'member' } });
  expect(fresh.status).toBe(403);
  expect(messageOf(fresh)).toBe(SEAT_LIMIT_MESSAGE);
  const again = await call('POST', base, { as: owner, body: { email: member.email, role: 'member' } });
  expect(again.status).toBe(409);
  expect(messageOf(again)).toBe(ALREADY_MEMBER);
  const counted = await call('POST', base, { as: owner, body: { email: elsewhere, role: 'member' } });
  expect(counted.status).toBe(201);
  expect((await invitationsOf(project.id, owner)).map((i) => i.email)).toEqual([elsewhere]);
});

test('TEAM-079 seat refusal shown to an admin of someone else\'s project', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { admin, member } = people;
  const pending = uniqueEmail('team-pending');
  await sendInvite(project.id, owner, pending, 'member');
  await setSeatLimit(owner, 4);

  await signIn(page, admin);
  await openMembers(page, project.id);
  await expect(page.getByText(SEAT_LINE)).toHaveCount(0);
  const refused = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/invitations'));
  await page.getByLabel('Email address').fill(uniqueEmail('team-no-seat'));
  await page.getByRole('button', { name: 'Send invite' }).click();
  const response = await refused;
  expect(response.status()).toBe(403);
  expect((await response.json()).message).toBe(SEAT_LIMIT_MESSAGE);
  const invite = cardTitled(page, 'Invite');
  const full = invite.getByRole('status');
  await expect(full).toContainText('Upgrade to invite teammates');
  await expect(full).toContainText('Every seat on this plan is taken. Remove someone or cancel a pending invite to free one.');
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(invite.getByRole('alert')).toHaveCount(0);

  // The owner frees a seat elsewhere: this page has no seat count, so the refusal stands.
  const removed = await call('DELETE', `/api/projects/${project.id}/members/${member.userId}`, { as: owner });
  expect(removed.status).toBe(200);
  await page.waitForTimeout(1_000);
  await expect(full).toBeVisible();

  // Freeing a seat from this page brings the form back.
  await page.getByRole('button', { name: `Cancel the invite to ${pending}` }).click();
  await expect(toastTitled(page, 'Invite cancelled')).toBeVisible();
  await expect(full).toHaveCount(0);
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('TEAM-081 accepting a counted invite at the limit succeeds; over the limit it is refused', async ({ page }) => {
  // At the limit: the invite already holds its seat.
  const atLimit = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const first = await newPerson('team-counted', 'Ira Invitee');
  const firstInvite = await sendInvite(atLimit.project.id, atLimit.owner, first.email, 'member');
  await setSeatLimit(atLimit.owner, 3);
  const accepted = await acceptInvite(first, firstInvite.token);
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toEqual({ projectId: atLimit.project.id, role: 'member' });

  // Over the limit: refused on the page, and the token still works once there is room.
  const over = await makeTeam('Olga Owner', { member: ['member', 'Max Member'] });
  const second = await newPerson('team-over', 'Ivo Invitee');
  const secondInvite = await sendInvite(over.project.id, over.owner, second.email, 'member');
  await setSeatLimit(over.owner, 2);

  await signIn(page, second);
  await page.goto(secondInvite.inviteUrl);
  await expect(page.getByText(`Join ${over.project.name}`, { exact: true })).toBeVisible();
  const refused = page.waitForResponse((r) => r.url().endsWith('/api/invitations/accept'));
  await page.getByRole('button', { name: 'Accept invite' }).click();
  expect((await refused).status()).toBe(403);
  const alert = page.getByRole('alert').filter({ hasText: SEAT_LIMIT_MESSAGE });
  await expect(alert).toHaveText(SEAT_LIMIT_MESSAGE);
  await expect(alert).toHaveClass(/text-destructive/);
  expect((await invitationRecord(secondInvite.id)).accepted_at).toBeNull();

  await setSeatLimit(over.owner, 3);
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${over.project.id}$`));
  expect(await memberRoleIn(over.project.id, second)).toBe('member');
});

test('TEAM-082 invites are refused while the billing owner is suspended', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Coowner'] });
  const { coOwner } = people;
  const invite = await sendInvite(project.id, coOwner, uniqueEmail('team-held'), 'member');
  const before = await invitationRecord(invite.id);
  await suspendAccount(owner);
  try {
    const base = `/api/projects/${project.id}/invitations`;
    const fresh = uniqueEmail('team-while-suspended');
    const created = await call('POST', base, { as: coOwner, body: { email: fresh, role: 'member' } });
    expect(created.status).toBe(403);
    expect(messageOf(created)).toBe(INVITES_SUSPENDED);
    expect(JSON.stringify(created.body)).not.toContain('/invite#token=');
    const resent = await call('POST', `${base}/${invite.id}/resend`, { as: coOwner });
    expect(resent.status).toBe(403);
    expect(messageOf(resent)).toBe(INVITES_SUSPENDED);
    expect(JSON.stringify(resent.body)).not.toContain('/invite#token=');

    const rows = (await invitationRowsAsText(project.id)).map((text) => JSON.parse(text));
    expect(rows.map((r) => r.email)).toEqual([invite.email]);
    expect(await invitationRecord(invite.id)).toEqual(before);

    const cancelled = await call('DELETE', `${base}/${invite.id}`, { as: coOwner });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toEqual([]);
    expect((await invitationRecord(invite.id)).revoked_at).not.toBeNull();
  } finally {
    await reactivateAccount(owner);
  }
});

test('TEAM-083 accept waits out a suspension with the token unspent', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-wait', 'Ira Invitee');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');
  await suspendAccount(owner);

  const preview = await previewInvite(invitee, invite.token);
  expect(preview.status).toBe(200);
  expect(preview.body.data).toMatchObject({ projectName: project.name, role: 'member', matchesAccount: true });
  const refused = await acceptInvite(invitee, invite.token);
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toBe(INVITE_GONE);
  const held = await invitationRecord(invite.id);
  expect(held.accepted_at).toBeNull();
  expect(held.revoked_at).toBeNull();
  expect(await memberRoleIn(project.id, invitee)).toBeNull();

  await reactivateAccount(owner);
  const accepted = await acceptInvite(invitee, invite.token);
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toEqual({ projectId: project.id, role: 'member' });
  expect(await memberRoleIn(project.id, invitee)).toBe('member');
});

// ---- H. The /invite page and the accept API

test('TEAM-088 signed out, opening an invite link', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invite = await sendInvite(project.id, owner, uniqueEmail('team-anon'), 'member');
  const sent: Request[] = [];
  page.on('request', (request) => sent.push(request));

  await page.goto(invite.inviteUrl);
  await expect(page.getByText('Sign in to accept your invite', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/invite$/);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  await expect(
    page.getByText('Use the email address the invite was sent to. You will come back here afterwards.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login');
  await expect(page.getByRole('link', { name: 'Create account', exact: true })).toHaveAttribute('href', '/register');
  expect(await sessionToken(page)).toBe(invite.token);
  expect(invite.token).toHaveLength(43);

  // The fragment never reaches the network, and no request carries the token.
  for (const request of sent) {
    expect(request.url().split('#')[0]).not.toContain(invite.token);
    expect(request.postData() ?? '').not.toContain(invite.token);
  }
  expect(sent.filter((r) => r.url().includes('/api/invitations/'))).toEqual([]);
});

test('TEAM-089 signed out, sign in, come back, accept', async ({ page, browser, baseURL }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-joiner', 'Jade Joiner');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');
  const previews: Request[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/invitations/preview')) previews.push(r);
  });

  await page.goto(invite.inviteUrl);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await fillSignIn(page, invitee);
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByText(`Join ${project.name}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Omar Owner invited you to join as a member.', { exact: true })).toBeVisible();
  expect(await sessionToken(page)).toBeNull();
  expect(previews.length).toBeGreaterThan(0);
  for (const request of previews) {
    expect(request.method()).toBe('POST');
    expect(request.postDataJSON()).toEqual({ token: invite.token });
  }

  const release = await holdRequests(page, 'POST', '/api/invitations/accept');
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(page.getByRole('button', { name: 'Joining...' })).toBeDisabled();
  release();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  expect((await projectsOf(invitee)).find((p) => p.id === project.id)?.role).toBe('member');
  expect(await invitationsOf(project.id, owner)).toEqual([]);

  const entry = (await teamActivity(project.id, owner)).find((e) => e.action === 'invite.accepted');
  expect(entry).toMatchObject({ actorUserId: invitee.userId, targetId: invite.id });
  const ownerPage = await personPage(browser, baseURL, owner);
  await expectTeamActivitySentence(ownerPage, project.id, 'Jade Joiner accepted an invite and joined the project');
  await openMembers(ownerPage, project.id);
  await expect(pendingInviteRow(ownerPage, invitee.email)).toHaveCount(0);
  await ownerPage.context().close();
});

test('TEAM-092 wrong account', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const sam = uniqueEmail('sam');
  const invite = await sendInvite(project.id, owner, sam, 'member');
  const other = await newPerson('team-other', 'Yan Other');

  await signIn(page, other);
  const previewed = page.waitForResponse((r) => r.url().endsWith('/api/invitations/preview'));
  await page.goto(invite.inviteUrl);
  const preview = await previewed;
  expect(preview.status()).toBe(200);
  expect((await preview.json()).data).toMatchObject({ matchesAccount: false, invitedEmailMasked: 's***@e2e.example.test' });

  await expect(page.getByText('This invite is for another account', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(
    'This invite was sent to s***@e2e.example.test. Sign in with that address to accept it.',
  );
  await expect(page.getByText(`You are signed in as ${other.email}.`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out and use another account' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to your projects' })).toHaveAttribute('href', '/projects');
  await expect(page.getByRole('button', { name: 'Accept invite' })).toHaveCount(0);
});

test('TEAM-093 switching account from the wrong-account page', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const sam = await newPerson('sam', 'Sam Invitee');
  const invite = await sendInvite(project.id, owner, sam.email, 'member');
  const other = await newPerson('team-other', 'Yan Other');

  await signIn(page, other);
  await page.goto(invite.inviteUrl);
  await page.getByRole('button', { name: 'Sign out and use another account' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await sessionToken(page)).toBe(invite.token);

  await fillSignIn(page, sam);
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByText(`Join ${project.name}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  expect(await memberRoleIn(project.id, sam)).toBe('member');
});

test('TEAM-094 accept API refuses the wrong account with a masked address', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const sam = await newPerson('sam', 'Sam Invitee');
  const long = await sendInvite(project.id, owner, sam.email, 'member');
  const short = await sendInvite(project.id, owner, 's@e2e.example.test', 'member');
  const other = await newPerson('team-other', 'Yan Other');

  const first = await acceptInvite(other, long.token);
  expect(first.status).toBe(400);
  expect(messageOf(first)).toBe('This invite was sent to s***@e2e.example.test. Sign in with that address to accept it.');
  const second = await acceptInvite(other, short.token);
  expect(second.status).toBe(400);
  expect(messageOf(second)).toBe('This invite was sent to *@e2e.example.test. Sign in with that address to accept it.');
  for (const invite of [long, short]) expect((await invitationRecord(invite.id)).accepted_at).toBeNull();
  expect(await memberRoleIn(project.id, other)).toBeNull();

  const accepted = await acceptInvite(sam, long.token);
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toEqual({ projectId: project.id, role: 'member' });
});

test('TEAM-096 dead links share one answer', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-dead', 'Ira Invitee');

  const expired = await sendInvite(project.id, owner, uniqueEmail('team-expired'), 'member');
  await setInviteExpiry(expired.id, '-1 minute');
  const revoked = await sendInvite(project.id, owner, uniqueEmail('team-revoked'), 'member');
  expect((await call('DELETE', `/api/projects/${project.id}/invitations/${revoked.id}`, { as: owner })).status).toBe(200);
  const used = await sendInvite(project.id, owner, invitee.email, 'member');
  expect((await acceptInvite(invitee, used.token)).status).toBe(201);
  const replaced = await sendInvite(project.id, owner, uniqueEmail('team-replaced'), 'member');
  await resendInvite(project.id, owner, replaced.id);

  const dead: Record<string, string> = {
    unknown: unknownInviteToken(),
    expired: expired.token,
    revoked: revoked.token,
    accepted: used.token,
    replaced: replaced.token,
  };

  await signIn(page, invitee);
  for (const [kind, token] of Object.entries(dead)) {
    // Each from an address of its own, so the preview throttle never answers instead.
    await page.setExtraHTTPHeaders({ 'X-Forwarded-For': newClientIp() });
    await page.goto('about:blank');
    await page.goto(`/invite#token=${token}`);
    await expect(page.getByText('Could not open this invite', { exact: true }), kind).toBeVisible();
    await expect(page.getByRole('alert'), kind).toHaveText(INVITE_GONE);
    await expect(page.getByRole('link', { name: 'Go to your projects' }), kind).toBeVisible();
  }

  // Every kind gets the same body, the time apart.
  const sameness = ({ timestamp, ...rest }: Record<string, unknown>) => (expect(typeof timestamp).toBe('string'), rest);
  for (const [kind, token] of Object.entries(dead)) {
    const ip = newClientIp();
    const preview = await previewInvite(invitee, token, ip);
    const accept = await acceptInvite(invitee, token, ip);
    for (const [route, result] of [
      ['/api/invitations/preview', preview],
      ['/api/invitations/accept', accept],
    ] as const) {
      expect(result.status, kind).toBe(400);
      expect(sameness(result.body), kind).toEqual({ statusCode: 400, message: INVITE_GONE, error: 'Bad Request', path: route });
    }
  }
});

test('TEAM-098 token travels only in the body', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-body', 'Ira Invitee');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');
  await signIn(page, invitee);

  const seen: Array<{ url: string; referer: string; body: string; path: string }> = [];
  const pending: Promise<void>[] = [];
  page.on('request', (request) => {
    pending.push(
      request.allHeaders().then((headers) => {
        seen.push({
          url: request.url().split('#')[0],
          referer: headers.referer ?? '',
          body: request.postData() ?? '',
          path: new URL(request.url()).pathname,
        });
      }),
    );
  });

  await page.goto(invite.inviteUrl);
  await expect(page.getByText(`Join ${project.name}`, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.location.href)).toMatch(/\/invite$/);
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  await page.waitForLoadState('networkidle');
  await Promise.all(pending);

  expect(seen.length).toBeGreaterThan(0);
  for (const request of seen) {
    expect(request.url).not.toContain(invite.token);
    expect(request.referer).not.toContain(invite.token);
    expect(request.referer).not.toContain('#');
  }
  for (const route of ['/api/invitations/preview', '/api/invitations/accept']) {
    const bodies = seen.filter((r) => r.path === route).map((r) => JSON.parse(r.body));
    expect(bodies.length, route).toBeGreaterThan(0);
    for (const body of bodies) expect(body).toEqual({ token: invite.token });
  }
  expect(seen.filter((r) => r.body.includes(invite.token)).every((r) => r.path.startsWith('/api/invitations/'))).toBe(true);
});

test('TEAM-100 two accepts at once', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-twice', 'Ira Invitee');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');

  const results = await Promise.all([acceptInvite(invitee, invite.token), acceptInvite(invitee, invite.token)]);
  const statuses = results.map((r) => r.status).sort();
  expect(statuses).toEqual([201, 400]);
  expect(results.find((r) => r.status === 201)!.body.data).toEqual({ projectId: project.id, role: 'member' });
  expect(messageOf(results.find((r) => r.status === 400)!)).toBe(INVITE_GONE);

  const memberRows = await withDb(async (db) =>
    (await db.query('SELECT id FROM project_members WHERE project_id = $1 AND user_id = $2', [project.id, invitee.userId])).rows,
  );
  expect(memberRows).toHaveLength(1);
  expect((await teamActivity(project.id, owner)).filter((e) => e.action === 'invite.accepted')).toHaveLength(1);
});

test('TEAM-101 accept after a re-invite with a new role', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-role', 'Ira Invitee');
  const asAdmin = await sendInvite(project.id, owner, invitee.email, 'admin');
  const asMember = await sendInvite(project.id, owner, invitee.email, 'member');
  expect(asMember.id).toBe(asAdmin.id);

  const old = await acceptInvite(invitee, asAdmin.token);
  expect(old.status).toBe(400);
  expect(messageOf(old)).toBe(INVITE_GONE);
  expect(await memberRoleIn(project.id, invitee)).toBeNull();

  const accepted = await acceptInvite(invitee, asMember.token);
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toEqual({ projectId: project.id, role: 'member' });
  expect((await membersOf(project.id, owner)).members.find((m) => m.userId === invitee.userId)?.role).toBe('member');
});

test('TEAM-104 preview and accept need a signed-in account', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const staff = await newPerson('team-staff', 'Stella Staff');
  const invite = await sendInvite(project.id, owner, staff.email, 'member');
  await grantSuperAdmin(staff.email);
  const staffToken = await enrolAndSignInStaff(page, staff);
  await expect(page).toHaveURL(new RegExp(`^${adminUrl('')}`));

  // The staff token is good where it belongs.
  const me = await fetch(`${process.env.E2E_ADMIN_API_URL}/api/staff/auth/me`, {
    headers: { Authorization: `Bearer ${staffToken}`, 'X-Forwarded-For': staff.ip, 'X-Chumbaq-Client': 'admin' },
  });
  expect(me.status).toBe(200);

  for (const route of ['/api/invitations/preview', '/api/invitations/accept']) {
    const anonymous = await call('POST', route, { as: null, body: { token: invite.token } });
    expect(anonymous.status, route).toBe(401);
    const withStaff = await call('POST', route, { as: { accessToken: staffToken, ip: newClientIp() }, body: { token: invite.token } });
    expect(withStaff.status, route).toBe(401);
  }
  const record = await invitationRecord(invite.id);
  expect(record.accepted_at).toBeNull();
  // The same account's customer session reaches the route.
  expect((await previewInvite(staff, invite.token)).status).toBe(200);
});

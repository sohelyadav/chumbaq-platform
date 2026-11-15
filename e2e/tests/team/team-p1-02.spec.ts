import { randomUUID } from 'crypto';
import type { Browser, Page, Request, Response } from '@playwright/test';
import { createProject, newClientIp, uniqueEmail } from '../../support/api';
import { allowClipboard, readDownload } from '../../support/browser-tools';
import { confirmWithPassword } from '../../support/factors';
import { expect, newPersonContext, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  ACTIVITY_CSV_HEADER,
  INVALID_ACTIVITY_FILTER,
  INVITES_SUSPENDED,
  INVITE_GONE,
  ALREADY_MEMBER,
  MOVE_BILLING_FIRST,
  PROJECT_NOT_FOUND,
  READ_ONLY,
  REAUTH_REQUIRED,
  ROLE_REFUSAL,
  SEAT_LIMIT_MESSAGE,
  STAFF_SENTENCE,
  TOO_MANY_TO_EXPORT,
  acceptInvite,
  activityCount,
  activityPage,
  addMember,
  bulkActivity,
  call,
  cardTitled,
  chooseRole,
  createLiteralWebhook,
  exportedCount,
  insertActivity,
  insertActivityAt,
  invitationRecord,
  invitationsOf,
  makeTeam,
  memberRoleIn,
  memberRow,
  membersOf,
  messageOf,
  newPerson,
  newStaffMember,
  offerBilling,
  openActivity,
  openMembers,
  openSettings,
  parseCsv,
  pendingInviteRow,
  personLabel,
  previewInvite,
  projectsMetaOf,
  rawGet,
  reactivateAccount,
  renameAccount,
  resendInvite,
  sendInvite,
  setAccountName,
  setInviteExpiry,
  setSeatLimit,
  staleToken,
  suspendAccount,
  toastTitled,
  utcDay,
  viewAsLink,
  viewAsToken,
  withDb,
  type Person,
} from '../../support/areas/team';

/**
 * P1 cases for the Activity page and its CSV, the role matrix as other pages show it,
 * view-as on team routes, and further members, seats, invitations and billing cases.
 */

test.describe.configure({ mode: 'parallel' });

const EMPTY_LOG =
  'Nothing here yet. Changes to the team, keys, channels and privacy, and every campaign sent, are recorded here and kept for at least 180 days.';
const NO_MATCH = 'No activity matches these filters.';
const SEAT_LINE = /^\d+ (of \d+ )?seats?$/;
const FULL_TITLE = 'Upgrade to invite teammates';
const FULL_TEXT = 'Every seat on this plan is taken. Remove someone or cancel a pending invite to free one.';
const KIND_OPTIONS = ['All kinds', 'Team', 'Project', 'API keys', 'Channels', 'Messaging', 'Privacy', 'Activity log', 'Chumbaq support'];

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
  await withDb((db) =>
    db.query(`UPDATE auth_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1`, [person.userId]),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
}

/** A fresh password sign-in through the API (the person's earlier sessions may be aged). */
async function newSignIn(person: Person): Promise<Pick<Person, 'accessToken' | 'ip'>> {
  const result = await call('POST', '/api/auth/login', { ip: person.ip, body: { email: person.email, password: person.password } });
  if (result.status !== 200) throw new Error(`login answered ${result.status}: ${JSON.stringify(result.body)}`);
  return { accessToken: (result.body.data as { tokens: { accessToken: string } }).tokens.accessToken, ip: person.ip };
}

/** Records the requests matching `method` whose path ends with `urlEnd`. */
function watchRequests(page: Page, method: string, urlEnd: string): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === method && new URL(request.url()).pathname.endsWith(urlEnd)) seen.push(request);
  });
  return seen;
}

/** Holds requests matching `method`, a path ending and `when` until `release` is called. */
async function holdRequests(
  page: Page,
  method: string,
  urlEnd: string,
  when: (url: URL) => boolean = () => true,
): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname.endsWith(urlEnd),
    async (route) => {
      if (route.request().method() === method && when(new URL(route.request().url()))) await released;
      await route.continue();
    },
  );
  return release;
}

/** The next response matching `method` and a path ending. */
function nextResponse(page: Page, method: string, urlEnd: string): Promise<Response> {
  return page.waitForResponse((r) => r.request().method() === method && new URL(r.url()).pathname.endsWith(urlEnd));
}

/** Records every alert, confirm or prompt the page opens (and dismisses it). */
function noDialogs(page: Page): string[] {
  const opened: string[] = [];
  page.on('dialog', async (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
  return opened;
}

/** The activity table's body rows (not the expanded detail rows). */
function activityRowsOnPage(page: Page) {
  return page.getByRole('table').locator('tbody tr[aria-expanded]');
}

/** The What column of every activity row on the page, top to bottom. */
function whatColumn(page: Page) {
  return activityRowsOnPage(page).locator('td:nth-child(4)');
}

/** Chooses an option of a labelled Radix Select (the Activity page's Person and Kind). */
async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByLabel(label).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** The red alert above the Activity card (download refusals). */
function downloadAlert(page: Page) {
  return page.locator('p[role="alert"]');
}

/** The download link's GET, with the URL it was asked for. */
async function clickDownload(page: Page): Promise<Response> {
  const exported = nextResponse(page, 'GET', '/activity/export');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  return exported;
}

const exportPath = (projectId: string, query = '') => `/api/projects/${projectId}/activity/export${query ? `?${query}` : ''}`;

// ---- J. Activity log page

test('TEAM-135 owner opens an empty activity log', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  expect(await activityCount(project.id)).toBe(0);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}`);
  await openSidebarGroup(page, 'Configure');
  await sidebarLink(page, 'Activity').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/activity$`));
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.getByText('Who changed what in this project, when, and from where.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
  const card = cardTitled(page, 'Activity log');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText('Newest first. Dates in the filters are UTC days.');
  await expect(page.getByLabel('Person')).toHaveText('Everyone');
  await expect(page.getByLabel('Kind')).toHaveText('All kinds');
  await expect(page.getByLabel('From')).toHaveValue('');
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await expect(card.getByText(EMPTY_LOG, { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('TEAM-137 sentences for every team action', async ({ page }) => {
  test.slow();
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, member } = people;
  const invitee = await newPerson('team-invitee', 'Ivy Invitee');
  const base = `/api/projects/${project.id}`;
  const ok = async (result: Promise<{ status: number; body: unknown }>, status = 200) => {
    const answered = await result;
    expect(answered.status, JSON.stringify(answered.body)).toBe(status);
  };

  const first = await sendInvite(project.id, owner, invitee.email, 'member');
  await resendInvite(project.id, owner, first.id);
  await ok(call('DELETE', `${base}/invitations/${first.id}`, { as: owner }));
  const second = await sendInvite(project.id, owner, invitee.email, 'member');
  await ok(acceptInvite(invitee, second.token), 201);
  await ok(call('PATCH', `${base}/members/${member.userId}`, { as: owner, body: { role: 'admin' } }));
  await ok(call('DELETE', `${base}/members/${member.userId}`, { as: owner }));
  await ok(call('POST', `${base}/leave`, { as: coOwner }));
  const back = await sendInvite(project.id, owner, coOwner.email, 'owner');
  await ok(acceptInvite(coOwner, back.token), 201);
  await ok(offerBilling(project.id, owner, coOwner));
  await ok(call('DELETE', `${base}/billing-transfer`, { as: owner }));
  await ok(offerBilling(project.id, owner, coOwner));
  await ok(call('POST', `${base}/billing-transfer/decline`, { as: coOwner }));
  await ok(offerBilling(project.id, owner, coOwner));
  await ok(call('POST', `${base}/billing-transfer/accept`, { as: coOwner }));

  const team = (await activityPage(project.id, owner)).entries;
  expect(team).toHaveLength(16);
  expect(new Set(team.map((e) => e.group))).toEqual(new Set(['team']));
  const csv = await rawGet(exportPath(project.id), owner.accessToken, owner.ip);
  expect(csv.status).toBe(200);
  const [exported] = (await activityPage(project.id, owner)).entries;
  expect(exported).toMatchObject({ action: 'activity.exported', group: 'activity' });

  const m = `Mia Member (${member.email})`;
  const c = `Cara Co (${coOwner.email})`;
  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(whatColumn(page)).toHaveText([
    'Omar Owner downloaded the activity log (16 entries)',
    'Cara Co accepted billing for this project',
    `Omar Owner offered billing for this project to ${c}`,
    'Cara Co declined billing for this project',
    `Omar Owner offered billing for this project to ${c}`,
    `Omar Owner cancelled the billing offer to ${c}`,
    `Omar Owner offered billing for this project to ${c}`,
    'Cara Co accepted an invite and joined the project',
    `Omar Owner invited ${coOwner.email} as an owner`,
    'Cara Co left the project',
    `Omar Owner removed ${m} from the project`,
    `Omar Owner changed the role of ${m} from member to admin`,
    'Ivy Invitee accepted an invite and joined the project',
    `Omar Owner invited ${invitee.email} as a member`,
    `Omar Owner cancelled the invite to ${invitee.email}`,
    `Omar Owner resent the invite to ${invitee.email}`,
    `Omar Owner invited ${invitee.email} as a member`,
  ]);
});

test('TEAM-140 privacy-only actors are hidden from admins\' person list', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    admin: ['admin', 'Adam Admin'],
  });
  const { coOwner, admin } = people;
  await sendInvite(project.id, owner, uniqueEmail('team-invitee'), 'member');
  await insertActivity(project.id, [
    { action: 'person.erased', actorUserId: coOwner.userId, actorLabel: personLabel(coOwner) },
    {
      action: 'suppression.added',
      actorUserId: coOwner.userId,
      actorLabel: personLabel(coOwner),
      details: { channel: 'email', address: 'j***@example.com' },
    },
  ]);

  expect((await activityPage(project.id, owner)).actors).toEqual([
    { userId: coOwner.userId, label: personLabel(coOwner) },
    { userId: owner.userId, label: personLabel(owner) },
  ]);
  const asAdmin = await activityPage(project.id, admin);
  expect(asAdmin.actors).toEqual([{ userId: owner.userId, label: personLabel(owner) }]);
  expect(asAdmin.entries.map((e) => e.action)).toEqual(['member.invited']);
});

test('TEAM-141 kind filter options and URL', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  await sendInvite(project.id, owner, uniqueEmail('team-invitee'), 'member');
  const label = personLabel(owner);
  await insertActivity(project.id, [
    { action: 'project.renamed', actorUserId: owner.userId, actorLabel: label, details: { from: 'Old', to: 'New' } },
    { action: 'api_key.created', actorUserId: owner.userId, actorLabel: label, targetType: 'api_key', targetLabel: 'Server' },
  ]);

  await signIn(page, owner);
  await openMembers(page, project.id);
  await openActivity(page, project.id);
  await expect(activityRowsOnPage(page)).toHaveCount(3);
  await page.getByLabel('Kind').click();
  await expect(page.getByRole('option')).toHaveText(KIND_OPTIONS);
  await page.getByRole('option', { name: 'Team', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/activity\\?group=team$`));
  await expect(page.getByLabel('Kind')).toHaveText('Team');
  await expect(whatColumn(page)).toHaveText([/^Omar Owner invited .+ as a member$/]);
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();

  await choose(page, 'Kind', 'All kinds');
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/activity$`));
  await expect(activityRowsOnPage(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);

  // The filters replaced the history entry: Back leaves the page.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/team$`));
});

test('TEAM-142 "See who changed the team" deep link', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const invitee = uniqueEmail('team-invitee');
  await sendInvite(project.id, owner, invitee, 'member');
  await insertActivity(project.id, [
    { action: 'project.renamed', actorUserId: owner.userId, actorLabel: personLabel(owner), details: { from: 'Old', to: 'New' } },
  ]);

  await signIn(page, people.admin);
  await openMembers(page, project.id);
  await page.getByRole('link', { name: 'See who changed the team' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/activity\\?group=team$`));
  await expect(page.getByLabel('Kind')).toHaveText('Team');
  await expect(whatColumn(page)).toHaveText([`Omar Owner invited ${invitee} as a member`]);
});

test('TEAM-143 person filter', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'cara Co'],
    former: ['admin', 'Fay Former'],
  });
  const { coOwner, former } = people;
  await sendInvite(project.id, owner, uniqueEmail('team-by-owner'), 'member');
  await sendInvite(project.id, coOwner, uniqueEmail('team-by-coowner'), 'member');
  const byFormer = uniqueEmail('team-by-former');
  await sendInvite(project.id, former, byFormer, 'member');
  expect((await call('DELETE', `/api/projects/${project.id}/members/${former.userId}`, { as: owner })).status).toBe(200);
  await insertActivity(project.id, [
    { action: 'staff.viewed_as', actorKind: 'staff', actorLabel: 'Chumbaq support' },
    {
      action: 'campaign.sent',
      actorKind: 'api_key',
      actorLabel: 'API key "Server"',
      targetType: 'campaign',
      targetLabel: 'Spring',
      details: { channel: 'push', audienceSize: 3 },
    },
  ]);

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(activityRowsOnPage(page)).toHaveCount(6);
  await page.getByLabel('Person').click();
  await expect(page.getByRole('option')).toHaveText([
    'Everyone',
    personLabel(coOwner),
    personLabel(former),
    personLabel(owner),
  ]);
  const listed = nextResponse(page, 'GET', `/api/projects/${project.id}/activity`);
  await page.getByRole('option', { name: personLabel(former), exact: true }).click();
  expect(new URL((await listed).url()).searchParams.get('actor')).toBe(former.userId);
  await expect(page).toHaveURL(new RegExp(`\\?person=${former.userId}$`));
  await expect(whatColumn(page)).toHaveText([`Fay Former invited ${byFormer} as a member`]);
});

test('TEAM-144 date filters are inclusive UTC days', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const label = personLabel(owner);
  await insertActivityAt(project.id, [
    { at: '2026-11-10T23:59:59.999999Z', action: 'member.removed', actorUserId: owner.userId, actorLabel: label, targetLabel: 'Tenth' },
    { at: '2026-11-11T00:00:00Z', action: 'member.removed', actorUserId: owner.userId, actorLabel: label, targetLabel: 'Eleventh' },
    { at: '2026-11-12T00:00:00Z', action: 'member.removed', actorUserId: owner.userId, actorLabel: label, targetLabel: 'Twelfth' },
  ]);
  const sentence = (who: string) => `Omar Owner removed ${who} from the project`;

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(whatColumn(page)).toHaveText([sentence('Twelfth'), sentence('Eleventh'), sentence('Tenth')]);
  await page.getByLabel('From').fill('2026-11-11');
  await page.getByLabel('To', { exact: true }).fill('2026-11-11');
  await expect(page).toHaveURL(/\?from=2026-11-11&to=2026-11-11$/);
  await expect(whatColumn(page)).toHaveText([sentence('Eleventh')]);

  await page.getByLabel('To', { exact: true }).fill('');
  await page.getByLabel('From').fill('2026-11-12');
  await expect(page).toHaveURL(/\?from=2026-11-12$/);
  await expect(whatColumn(page)).toHaveText([sentence('Twelfth')]);

  await page.getByLabel('From').fill('');
  await page.getByLabel('To', { exact: true }).fill('2026-11-10');
  await expect(page).toHaveURL(/\?to=2026-11-10$/);
  await expect(whatColumn(page)).toHaveText([sentence('Tenth')]);

  // The last microsecond of the 10th is in the 10th, and only there.
  expect((await activityPage(project.id, owner, 'to=2026-11-10')).entries.map((e) => e.targetLabel)).toEqual(['Tenth']);
  expect((await activityPage(project.id, owner, 'from=2026-11-11')).entries.map((e) => e.targetLabel)).toEqual(['Twelfth', 'Eleventh']);
});

test('TEAM-145 backwards date range', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  await sendInvite(project.id, owner, uniqueEmail('team-invitee'), 'member');

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(activityRowsOnPage(page)).toHaveCount(1);
  const lists = watchRequests(page, 'GET', `/api/projects/${project.id}/activity`);
  await page.getByLabel('From').fill('2026-11-12');
  await expect.poll(() => lists.length).toBe(1);
  await page.getByLabel('To', { exact: true }).fill('2026-11-10');
  await expect(page.getByText('The start date is after the end date.', { exact: true })).toBeVisible();
  await expect(page.getByText('The start date is after the end date.', { exact: true })).toHaveClass(/text-destructive/);
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(lists.map((r) => new URL(r.url()).searchParams.get('to'))).toEqual([null]);

  const api = await call('GET', `/api/projects/${project.id}/activity?from=2026-11-12&to=2026-11-10`, { as: owner });
  expect(api.status).toBe(400);
  expect(messageOf(api)).toBe(INVALID_ACTIVITY_FILTER);
});

test('TEAM-148 malformed URL filters', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  await sendInvite(project.id, owner, uniqueEmail('team-invitee'), 'member');

  const adminPage = await personPage(browser, baseURL, people.admin);
  for (const query of ['group=privacy', 'group=nonsense', 'from=11/12/2026']) {
    const listed = nextResponse(adminPage, 'GET', `/api/projects/${project.id}/activity`);
    await openActivity(adminPage, project.id, query);
    const response = await listed;
    expect(response.status(), query).toBe(200);
    expect([...new URL(response.url()).searchParams.keys()], query).toEqual([]);
    await expect(activityRowsOnPage(adminPage)).toHaveCount(1);
    await expect(adminPage.getByLabel('Kind')).toHaveText('All kinds');
    await expect(adminPage.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  }
  await adminPage.context().close();

  await signIn(page, owner);
  for (const query of ['person=not-a-uuid', 'from=2026-13-40']) {
    const listed = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith(`/api/projects/${project.id}/activity`) && r.status() === 400,
    );
    await openActivity(page, project.id, query);
    expect((await (await listed).json()).message, query).toBe(INVALID_ACTIVITY_FILTER);
    const shown = cardTitled(page, 'Activity log').getByText(INVALID_ACTIVITY_FILTER, { exact: true });
    await expect(shown).toBeVisible();
    await expect(shown).toHaveClass(/text-destructive/);
    await expect(page.getByRole('table')).toHaveCount(0);
  }
});

test('TEAM-149 activity list API validation', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const uuid = randomUUID();
  const cursor = (s: string) => Buffer.from(s).toString('base64url');
  const queries = [
    'actor=xyz',
    'group=billing',
    'from=2026-02-30',
    'to=20261101',
    'from=2026-11-12&to=2026-11-10',
    'foo=1',
    'group=team&group=project',
    'cursor=***',
    `cursor=${cursor(`0001-01-01T00:00:00.000000Z|${uuid}`)}`,
    `cursor=${cursor(`2026-13-01T00:00:00.000000Z|${uuid}`)}`,
    `cursor=${cursor('garbage')}`,
    `cursor=${'A'.repeat(201)}`,
  ];
  // A well-formed cursor is taken (the control).
  const control = await call('GET', `/api/projects/${project.id}/activity?cursor=${cursor(`2026-11-01T00:00:00.000000Z|${uuid}`)}`, { as: owner });
  expect(control.status).toBe(200);
  for (const query of queries) {
    const result = await call('GET', `/api/projects/${project.id}/activity?${query}`, { as: owner });
    expect(result.status, query).toBe(400);
    expect(messageOf(result), query).toBe(INVALID_ACTIVITY_FILTER);
  }
});

test('TEAM-150 pagination by 50 with Load more', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  // 120 entries a second apart, the 50th and 51st at the same instant (either side of the first page's end).
  await bulkActivity(project.id, owner, 120, { twinAt: 51 });
  const stored = await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM project_activity WHERE project_id = $1 ORDER BY occurred_at DESC, id DESC',
      [project.id],
    );
    return rows.map((r) => r.id);
  });
  expect(stored).toHaveLength(120);

  const pages = [await activityPage(project.id, owner)];
  pages.push(await activityPage(project.id, owner, `cursor=${pages[0].nextCursor}`));
  pages.push(await activityPage(project.id, owner, `cursor=${pages[1].nextCursor}`));
  expect(pages.map((p) => p.entries.length)).toEqual([50, 50, 20]);
  expect(pages.map((p) => p.nextCursor === null)).toEqual([false, false, true]);
  for (const p of pages) expect(p.actors).toEqual([{ userId: owner.userId, label: personLabel(owner) }]);
  const ids = pages.flatMap((p) => p.entries.map((e) => e.id));
  expect(ids).toEqual(stored);
  expect(pages[0].entries[49].occurredAt).toBe(pages[1].entries[0].occurredAt);

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(activityRowsOnPage(page)).toHaveCount(50);
  const release = await holdRequests(page, 'GET', `/api/projects/${project.id}/activity`, (url) => url.searchParams.has('cursor'));
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('button', { name: 'Loading…' })).toBeDisabled();
  release();
  await expect(activityRowsOnPage(page)).toHaveCount(100);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(activityRowsOnPage(page)).toHaveCount(120);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('TEAM-154 labels and details render as text', async ({ page }) => {
  const payload = '<img src=x onerror=alert(1)>';
  const { owner, project, people } = await makeTeam('Omar Owner', {
    member: ['member', 'Mia Member'],
    admin: ['admin', 'Adam Admin'],
  });
  const member = await renameAccount(people.member, payload);
  const admin = await renameAccount(people.admin, `${payload} admin`);
  const invitee = uniqueEmail('team-invitee');
  await sendInvite(project.id, admin, invitee, 'member');
  expect((await call('DELETE', `/api/projects/${project.id}/members/${member.userId}`, { as: owner })).status).toBe(200);
  const dialogs = noDialogs(page);

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(whatColumn(page)).toHaveText([
    `Omar Owner removed ${payload} (${member.email}) from the project`,
    `${payload} admin invited ${invitee} as a member`,
  ]);
  await expect(activityRowsOnPage(page).nth(1).locator('td:nth-child(3) p')).toHaveText([`${payload} admin`, admin.email]);
  await activityRowsOnPage(page).first().click();
  await expect(page.locator('dl dd').nth(1)).toHaveText(`member: ${payload} (${member.email})`);
  await activityRowsOnPage(page).nth(1).click();
  await expect(page.locator('dl dd').nth(1)).toHaveText(`invitation: ${invitee}`);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// ---- K. Activity download (CSV)

test('TEAM-160 download uses the page\'s filters', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const { coOwner } = people;
  const byCoOwner = uniqueEmail('team-by-coowner');
  await sendInvite(project.id, coOwner, byCoOwner, 'member');
  await sendInvite(project.id, owner, uniqueEmail('team-by-owner'), 'member');
  const from = utcDay(-14);
  const to = utcDay(0);
  await insertActivity(project.id, [
    { action: 'project.renamed', actorUserId: coOwner.userId, actorLabel: personLabel(coOwner), details: { from: 'Old', to: 'New' } },
  ]);
  await insertActivityAt(project.id, [
    { at: `${utcDay(-15)}T12:00:00Z`, action: 'member.left', actorUserId: coOwner.userId, actorLabel: personLabel(coOwner) },
  ]);

  await signIn(page, owner);
  await openActivity(page, project.id, `group=team&from=${from}&to=${to}&person=${coOwner.userId}`);
  await expect(whatColumn(page)).toHaveText([`Cara Co invited ${byCoOwner} as a member`]);
  const download = page.waitForEvent('download');
  const response = await clickDownload(page);
  expect(response.status()).toBe(200);
  const params = new URL(response.url()).searchParams;
  expect(Object.fromEntries(params)).toEqual({ actor: coOwner.userId, group: 'team', from, to });
  const file = await readDownload(await download);
  const rows = parseCsv(file.text).slice(1);
  expect(rows.map((cells) => [cells[1], cells[2], cells[5]])).toEqual([[personLabel(coOwner), 'member.invited', byCoOwner]]);

  const [exported] = (await activityPage(project.id, owner)).entries;
  expect(exported).toMatchObject({
    action: 'activity.exported',
    details: { filters: { actor: coOwner.userId, group: 'team', from, to }, rows: 1 },
  });
});

test('TEAM-161 download refused over 50,000 rows', async ({ page }) => {
  test.slow();
  const { owner, project } = await makeTeam('Omar Owner', {});
  await bulkActivity(project.id, owner, 50_001, { newest: '2025-06-01T00:00:00Z' });
  await sendInvite(project.id, owner, uniqueEmail('team-recent-a'), 'member');
  await sendInvite(project.id, owner, uniqueEmail('team-recent-b'), 'member');
  let downloads = 0;
  page.on('download', () => (downloads += 1));

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(activityRowsOnPage(page)).toHaveCount(50);
  const refused = await clickDownload(page);
  expect(refused.status()).toBe(400);
  await expect(downloadAlert(page)).toHaveText(TOO_MANY_TO_EXPORT);
  await expect(downloadAlert(page)).toHaveClass(/text-destructive/);
  expect(downloads).toBe(0);
  expect(await exportedCount(project.id)).toBe(0);

  await page.getByLabel('From').fill(utcDay(-1));
  await expect(downloadAlert(page)).toHaveCount(0);
  await expect(activityRowsOnPage(page)).toHaveCount(2);
  const download = page.waitForEvent('download');
  expect((await clickDownload(page)).status()).toBe(200);
  const file = await readDownload(await download);
  expect(file.lines[0]).toBe(ACTIVITY_CSV_HEADER);
  expect(parseCsv(file.text).slice(1).map((cells) => cells[2])).toEqual(['member.invited', 'member.invited']);
  expect(await exportedCount(project.id)).toBe(1);
});

test('TEAM-162 export validation', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const control = await rawGet(exportPath(project.id, 'group=team'), owner.accessToken, owner.ip);
  expect(control.status).toBe(200);
  for (const query of ['cursor=abc', 'group=nope', 'from=2026-11-12&to=2026-11-10', 'x=1']) {
    const result = await rawGet(exportPath(project.id, query), owner.accessToken, owner.ip);
    expect(result.status, query).toBe(400);
    expect(result.message, query).toBe(INVALID_ACTIVITY_FILTER);
  }
  expect(await exportedCount(project.id)).toBe(1);
});

// ---- L. Role matrix across the app

test('TEAM-169 role refusal text reaches the UI', async ({ page }) => {
  test.fail();
  test.info().annotations.push({ type: 'issue', description: 'TEAM-169' });
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;

  await signIn(page, admin);
  await page.goto(`/projects/${project.id}/api-keys`);
  await page.getByRole('button', { name: 'Create Key' }).click();
  expect((await call('PATCH', `/api/projects/${project.id}/members/${admin.userId}`, { as: owner, body: { role: 'member' } })).status).toBe(200);
  const dialog = page.getByRole('dialog', { name: 'Create API Key' });
  await dialog.getByPlaceholder('e.g., Production API Key').fill('Demoted key');
  const created = nextResponse(page, 'POST', `/api/projects/${project.id}/api-keys`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(403);
  expect((await response.json()).message).toBe(ROLE_REFUSAL);
  const keys = await call('GET', `/api/projects/${project.id}/api-keys`, { as: owner });
  expect(keys.body.data).toEqual([]);
  const toast = toastTitled(page, 'Failed to create key');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(ROLE_REFUSAL);
});

test('TEAM-171 membership writes re-check the caller\'s role under the lock', async () => {
  for (let round = 0; round < 3; round += 1) {
    const { owner, project, people } = await makeTeam('Omar Owner', {
      cara: ['owner', 'Cara Co'],
      dan: ['owner', 'Dan Duo'],
    });
    const { cara, dan } = people;
    const path = (userId: string) => `/api/projects/${project.id}/members/${userId}`;
    const results = await Promise.all([
      call('PATCH', path(dan.userId), { as: cara, body: { role: 'admin' } }),
      call('PATCH', path(cara.userId), { as: dan, body: { role: 'admin' } }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, `round ${round}`).toEqual([200, 403]);
    expect(messageOf(results.find((r) => r.status === 403)!)).toBe(ROLE_REFUSAL);

    const roles = (await membersOf(project.id, owner)).members.map((m) => m.role).sort();
    expect(roles).toEqual(['admin', 'owner', 'owner']);
    expect((await activityPage(project.id, owner)).entries.filter((e) => e.action === 'member.role_changed')).toHaveLength(1);
  }
});

test('TEAM-173 member-only pages and controls across the app', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  await createLiteralWebhook(owner, project.id);

  await signIn(page, people.member);
  await openMembers(page, project.id);
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(cardTitled(page, 'Invite')).toHaveCount(0);
  await expect(page.getByRole('table').first().getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);

  await openActivity(page, project.id);
  await expect(page.getByText('Only owners and admins can see the activity log.', { exact: true })).toBeVisible();

  await openSettings(page, project.id);
  await expect(cardTitled(page, 'Billing owner')).toHaveCount(0);
  await expect(page.getByText('Danger Zone', { exact: true })).toHaveCount(0);
  await expect(cardTitled(page, 'Leave project').getByRole('button', { name: 'Leave project' })).toBeVisible();

  await page.goto(`/projects/${project.id}/api-keys`);
  await expect(
    page.getByText('Only owners and admins can see and manage API keys. Ask one of them for the key your app needs.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Key' })).toHaveCount(0);

  await page.goto(`/projects/${project.id}/webhooks`);
  await expect(page.getByText('Only owners and admins can see this.', { exact: true })).toBeVisible();
  await expect(page.getByText('1.1.1.1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Webhook' })).toHaveCount(0);
});

// ---- M. View-as on TEAM pages

test('TEAM-175 view-as cannot leave or see projects the tenant only joined', async ({ browser }) => {
  const tenant = await newPerson('team-tenant', 'Omar Owner');
  const billed = await createProject(tenant, tenant.ip, `Team ${randomUUID().slice(0, 6)}`);
  const other = await newPerson('team-other', 'Cara Co');
  const joined = await createProject(other, other.ip, `Team ${randomUUID().slice(0, 6)}`);
  await addMember(joined.id, tenant, 'member', other);
  const staff = await newStaffMember(browser);
  const viewAs = await viewAsToken(await viewAsLink(staff, tenant));

  const ownMembers = await call('GET', `/api/projects/${billed.id}/members`, { as: viewAs });
  expect(ownMembers.status).toBe(200);
  const members = await call('GET', `/api/projects/${joined.id}/members`, { as: viewAs });
  expect(members.status).toBe(404);
  expect(messageOf(members)).toBe(PROJECT_NOT_FOUND);
  const left = await call('POST', `/api/projects/${joined.id}/leave`, { as: viewAs });
  expect(left.status).toBe(403);
  expect(messageOf(left)).toBe(READ_ONLY);
  expect(await memberRoleIn(joined.id, tenant)).toBe('member');
});

// ---- N. Members page: more states

test('TEAM-182 the seat line rises after an invite and holds on a re-invite', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const second = await createProject(owner, owner.ip, `Second ${randomUUID().slice(0, 6)}`);
  const zed = await newPerson('team-zed', 'Zed Second');
  await addMember(second.id, zed, 'member', owner);
  const seatLine = page.getByText(SEAT_LINE);
  const newcomer = uniqueEmail('team-newcomer');

  /** Sends the invite form and waits for the seat count read after it. */
  const invite = async (email: string, role?: 'Admin') => {
    await page.getByLabel('Email address').fill(email);
    if (role) {
      await page.getByLabel('Role').click();
      await page.getByRole('option', { name: role, exact: true }).click();
    }
    const seatsRead = page.waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/projects',
    );
    await page.getByRole('button', { name: 'Send invite' }).click();
    const dialog = page.getByRole('dialog', { name: `Invite link for ${email}` });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    return (await (await seatsRead).json()).meta.seats as { used: number; limit: number | null };
  };

  await signIn(page, owner);
  await openMembers(page, project.id);
  // The owner, Mia, and Zed through the second project.
  await expect(seatLine).toHaveText('3 seats');

  expect(await invite(newcomer)).toEqual({ used: 4, limit: null });
  await expect(seatLine).toHaveText('4 seats');
  expect(await invite(newcomer, 'Admin')).toEqual({ used: 4, limit: null });
  await expect(seatLine).toHaveText('4 seats');
  await expect(pendingInviteRow(page, newcomer)).toContainText('Admin');

  const [pending] = await invitationsOf(project.id, owner);
  await setInviteExpiry(pending.id, '-1 minute');
  await page.reload();
  await expect(seatLine).toHaveText('3 seats');
  expect(await invite(newcomer)).toEqual({ used: 4, limit: null });
  await expect(seatLine).toHaveText('4 seats');

  expect(await invite(zed.email)).toEqual({ used: 4, limit: null });
  await expect(seatLine).toHaveText('4 seats');

  await setSeatLimit(owner, 5);
  await page.reload();
  await expect(seatLine).toHaveText('4 of 5 seats');
});

test('TEAM-183 seat line over the limit and with a limit of 0', async ({ page, browser, baseURL }) => {
  // (a) Three people, a limit of two.
  const a = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'], member: ['member', 'Mia Member'] });
  await setSeatLimit(a.owner, 2);
  await signIn(page, a.owner);
  await openMembers(page, a.project.id);
  await expect(page.getByText(SEAT_LINE)).toHaveText('3 of 2 seats');
  const status = cardTitled(page, 'Invite').getByRole('status');
  await expect(status).toContainText(FULL_TITLE);
  await expect(status).toContainText(FULL_TEXT);
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  for (const person of [a.people.admin, a.people.member]) {
    await expect(memberRow(page, person.email).getByRole('combobox')).toBeVisible();
    await expect(memberRow(page, person.email).getByRole('button', { name: `Remove ${person.name}` })).toBeVisible();
  }
  const refused = await call('POST', `/api/projects/${a.project.id}/invitations`, {
    as: a.owner,
    body: { email: uniqueEmail('team-over'), role: 'member' },
  });
  expect(refused.status).toBe(403);
  expect(messageOf(refused)).toBe(SEAT_LIMIT_MESSAGE);

  // (b) Alone, a limit of zero.
  const b = await makeTeam('Sol Solo', {});
  await setSeatLimit(b.owner, 0);
  const soloPage = await personPage(browser, baseURL, b.owner);
  await openMembers(soloPage, b.project.id);
  await expect(soloPage.getByText(SEAT_LINE)).toHaveText('1 of 0 seats');
  await expect(cardTitled(soloPage, 'Invite').getByRole('status')).toContainText(FULL_TITLE);
  await soloPage.context().close();

  // (c) As (a), with a live invite made before the limit came down.
  const c = await makeTeam('Olga Owner', { admin: ['admin', 'Adam Admin'], member: ['member', 'Mia Member'] });
  const invitee = await newPerson('team-invitee', 'Ivy Invitee');
  const invite = await sendInvite(c.project.id, c.owner, invitee.email, 'member');
  await setSeatLimit(c.owner, 2);
  const cPage = await personPage(browser, baseURL, c.owner);
  await openMembers(cPage, c.project.id);
  await expect(cPage.getByText(SEAT_LINE)).toHaveText('4 of 2 seats');
  await expect(cardTitled(cPage, 'Invite').getByRole('status')).toContainText(FULL_TITLE);
  await cPage.context().close();
  const accepted = await acceptInvite(invitee, invite.token);
  expect(accepted.status).toBe(403);
  expect(messageOf(accepted)).toBe(SEAT_LIMIT_MESSAGE);
  expect((await invitationRecord(invite.id)).accepted_at).toBeNull();
  expect(await memberRoleIn(c.project.id, invitee)).toBeNull();
});

test('TEAM-184 the billing owner\'s own seat refusal from a stale page', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const second = await createProject(owner, owner.ip, `Second ${randomUUID().slice(0, 6)}`);
  const held = uniqueEmail('team-held');
  await sendInvite(project.id, owner, held, 'member');
  await setSeatLimit(owner, 4);
  const seatLine = page.getByText(SEAT_LINE);

  await signIn(page, owner);
  await openMembers(page, project.id);
  await expect(seatLine).toHaveText('3 of 4 seats');

  // Elsewhere, the last seat goes to an invite on the other project.
  const elsewhere = await sendInvite(second.id, owner, uniqueEmail('team-elsewhere'), 'member');
  const typed = uniqueEmail('team-typed');
  await page.getByLabel('Email address').fill(typed);
  const refused = nextResponse(page, 'POST', `/api/projects/${project.id}/invitations`);
  const seatsRead = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/projects');
  await page.getByRole('button', { name: 'Send invite' }).click();
  const answer = await refused;
  expect(answer.status()).toBe(403);
  expect((await answer.json()).message).toBe(SEAT_LIMIT_MESSAGE);
  await seatsRead;
  const status = cardTitled(page, 'Invite').getByRole('status');
  await expect(status).toContainText(FULL_TITLE);
  await expect(status).toContainText(FULL_TEXT);
  await expect(cardTitled(page, 'Invite').getByRole('alert')).toHaveCount(0);
  await expect(seatLine).toHaveText('4 of 4 seats');

  // Coming back to the window refetches nothing.
  const refetches = watchRequests(page, 'GET', '/api/projects');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForLoadState('networkidle');
  expect(refetches).toEqual([]);
  await expect(status).toBeVisible();

  // Seats freed elsewhere, then a cancel here: the form comes back with what was typed.
  expect((await call('DELETE', `/api/projects/${second.id}/invitations/${elsewhere.id}`, { as: owner })).status).toBe(200);
  await page.getByRole('button', { name: `Cancel the invite to ${held}` }).click();
  await expect(toastTitled(page, 'Invite cancelled')).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveValue(typed);
  await expect(seatLine).toHaveText('2 of 4 seats');
  await page.reload();
  await expect(page.getByLabel('Email address')).toHaveValue('');
});

test('TEAM-185 suspension as the Members page shows it', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, member } = people;
  const pending = uniqueEmail('team-pending');
  await sendInvite(project.id, owner, pending, 'member');

  await signIn(page, coOwner);
  await openMembers(page, project.id);
  await suspendAccount(owner);
  try {
    const typed = uniqueEmail('team-typed');
    await page.getByLabel('Email address').fill(typed);
    await page.getByRole('button', { name: 'Send invite' }).click();
    const alert = cardTitled(page, 'Invite').getByRole('alert');
    await expect(alert).toHaveText(INVITES_SUSPENDED);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await invitationsOf(project.id, coOwner)).map((i) => i.email)).toEqual([pending]);

    await page.getByRole('button', { name: `Resend the invite to ${pending}` }).click();
    const notResent = toastTitled(page, 'Invite not resent');
    await expect(notResent).toBeVisible();
    await expect(notResent).toContainText(INVITES_SUSPENDED);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: `Cancel the invite to ${pending}` }).click();
    await expect(toastTitled(page, 'Invite cancelled')).toBeVisible();
    await expect(pendingInviteRow(page, pending)).toHaveCount(0);

    await chooseRole(page, member.email, 'Admin');
    await expect(toastTitled(page, 'Role changed')).toBeVisible();
    await memberRow(page, member.email).getByRole('button', { name: 'Remove Mia Member' }).click();
    await page.getByRole('dialog', { name: 'Remove Mia Member?' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(toastTitled(page, 'Removed from the project')).toBeVisible();
    expect(await memberRoleIn(project.id, member)).toBeNull();
    const actions = (await activityPage(project.id, coOwner)).entries.map((e) => e.action);
    expect(actions.slice(0, 3)).toEqual(['member.removed', 'member.role_changed', 'invite.cancelled']);
  } finally {
    await reactivateAccount(owner);
  }
});

test('TEAM-186 invite-link dialog dismissal and copy state', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const first = uniqueEmail('team-first');
  const second = uniqueEmail('team-second');

  await signIn(page, owner);
  await openMembers(page, project.id);
  await allowClipboard(page);
  await page.getByLabel('Email address').fill(first);
  await page.getByRole('button', { name: 'Send invite' }).click();
  const firstDialog = page.getByRole('dialog', { name: `Invite link for ${first}` });
  const firstLink = (await firstDialog.locator('code').textContent())!.trim();
  const copy = firstDialog.getByRole('button', { name: 'Copy invite link' });
  await copy.click();
  await expect(copy.locator('svg.lucide-check')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(firstDialog).toBeHidden();
  await expect(page.getByText(firstLink)).toHaveCount(0);

  await page.getByLabel('Email address').fill(second);
  await page.getByRole('button', { name: 'Send invite' }).click();
  const secondDialog = page.getByRole('dialog', { name: `Invite link for ${second}` });
  const secondLink = (await secondDialog.locator('code').textContent())!.trim();
  await page.mouse.click(5, 5);
  await expect(secondDialog).toBeHidden();
  await expect(page.getByText(secondLink)).toHaveCount(0);

  await page.reload();
  await pendingInviteRow(page, first).waitFor();
  await expect(page.getByText(firstLink)).toHaveCount(0);
  const listed = JSON.stringify(await invitationsOf(project.id, owner));
  for (const link of [firstLink, secondLink]) expect(listed).not.toContain(new URL(link).hash.slice('#token='.length));

  await page.getByRole('button', { name: `Resend the invite to ${first}` }).click();
  const resent = page.getByRole('dialog', { name: `Invite link for ${first}` });
  const resentLink = (await resent.locator('code').textContent())!.trim();
  expect(resentLink).not.toBe(firstLink);
  const resentCopy = resent.getByRole('button', { name: 'Copy invite link' });
  await expect(resentCopy.locator('svg.lucide-copy')).toHaveCount(1);
  await expect(resentCopy.locator('svg.lucide-check')).toHaveCount(0);

  const invitee = await newPerson('team-invitee', 'Ivy Invitee');
  const old = await previewInvite(invitee, new URL(firstLink).hash.slice('#token='.length));
  expect(old.status).toBe(400);
  expect(messageOf(old)).toBe(INVITE_GONE);
});

// ---- O. Invitations: authority and ordering

test('TEAM-187 resending moves the invite\'s authority to whoever resent it', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;
  const invitee = await newPerson('team-invitee', 'Ivy Invitee');
  const first = await sendInvite(project.id, admin, invitee.email, 'member');
  expect(((await invitationsOf(project.id, owner))[0] as unknown as { invitedBy: unknown }).invitedBy).toEqual({ id: admin.userId, name: 'Adam Admin' });

  const second = await resendInvite(project.id, owner, first.id);
  expect(((await invitationsOf(project.id, owner))[0] as unknown as { invitedBy: unknown }).invitedBy).toEqual({ id: owner.userId, name: 'Omar Owner' });
  await signIn(page, owner);
  await openMembers(page, project.id);
  await expect(pendingInviteRow(page, invitee.email).getByRole('cell').nth(2)).toHaveText('Omar Owner');

  expect((await call('DELETE', `/api/projects/${project.id}/members/${admin.userId}`, { as: owner })).status).toBe(200);
  expect((await invitationRecord(first.id)).revoked_at).toBeNull();

  const accepted = await acceptInvite(invitee, second.token);
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toEqual({ projectId: project.id, role: 'member' });
  const old = await acceptInvite(invitee, first.token);
  expect(old.status).toBe(400);
  expect(messageOf(old)).toBe(INVITE_GONE);
  const resent = (await activityPage(project.id, owner)).entries.find((e) => e.action === 'invite.resent');
  expect(resent).toMatchObject({ actorUserId: owner.userId, targetId: first.id });
});

test('TEAM-190 order of the invite create checks', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, member } = people;
  const invitee = uniqueEmail('team-invitee');
  const pending = await sendInvite(project.id, owner, invitee, 'member');
  const invite = (as: Pick<Person, 'accessToken' | 'ip'>, email: string, role: string) =>
    call('POST', `/api/projects/${project.id}/invitations`, { as, body: { email, role } });

  // 1. Already a member, before the suspension.
  await suspendAccount(owner);
  try {
    const member1 = await invite(coOwner, member.email, 'member');
    expect(member1.status).toBe(409);
    expect(messageOf(member1)).toBe(ALREADY_MEMBER);
  } finally {
    await reactivateAccount(owner);
  }

  // 2. At the limit, a live pending invite takes no new seat; an expired one does.
  const { used } = (await projectsMetaOf(owner)).seats;
  expect(used).toBe(4);
  await setSeatLimit(owner, used);
  const again = await invite(owner, invitee, 'admin');
  expect(again.status).toBe(201);
  expect(again.body.data.invitation).toMatchObject({ id: pending.id, role: 'admin' });
  await setInviteExpiry(pending.id, '-1 minute');
  await setSeatLimit(owner, used - 1);
  const lapsed = await invite(owner, invitee, 'admin');
  expect(lapsed.status).toBe(403);
  expect(messageOf(lapsed)).toBe(SEAT_LIMIT_MESSAGE);

  // 3. A stale sign-in, before already a member.
  const stale = await invite(await staleToken(owner), member.email, 'owner');
  expect(stale.status).toBe(403);
  expect(messageOf(stale)).toBe(REAUTH_REQUIRED);

  // 4. Suspended and full: suspension first.
  await setSeatLimit(owner, 3);
  await suspendAccount(owner);
  try {
    const suspended = await invite(coOwner, uniqueEmail('team-new'), 'member');
    expect(suspended.status).toBe(403);
    expect(messageOf(suspended)).toBe(INVITES_SUSPENDED);
  } finally {
    await reactivateAccount(owner);
  }
  const full = await invite(coOwner, uniqueEmail('team-new'), 'member');
  expect(full.status).toBe(403);
  expect(messageOf(full)).toBe(SEAT_LIMIT_MESSAGE);
});

// ---- P. The /invite page

test('TEAM-191 join page with no inviter name', async ({ page }) => {
  const invitee = await newPerson('team-invitee', 'Ivy Invitee');
  const one = await makeTeam('Omar Owner', {});
  const two = await makeTeam('Nameless Owner', {});
  const gone = await sendInvite(one.project.id, one.owner, invitee.email, 'member');
  const nameless = await sendInvite(two.project.id, two.owner, invitee.email, 'member');
  await withDb((db) => db.query('UPDATE project_invitations SET invited_by = NULL WHERE id = $1', [gone.id]));
  await setAccountName(two.owner, '');

  await signIn(page, invitee);
  await page.goto(gone.inviteUrl);
  await expect(page.getByText(`Join ${one.project.name}`, { exact: true })).toBeVisible();
  await expect(page.getByText('You were invited to join as a member.', { exact: true })).toBeVisible();
  const acceptButton = page.getByRole('button', { name: 'Accept invite' });
  await expect(acceptButton).toBeEnabled();
  const refused = nextResponse(page, 'POST', '/api/invitations/accept');
  await acceptButton.click();
  const answer = await refused;
  expect(answer.status()).toBe(400);
  expect((await answer.json()).message).toBe(INVITE_GONE);
  await expect(page.getByRole('alert')).toHaveText(INVITE_GONE);
  await expect(page.getByRole('alert')).toHaveClass(/text-destructive/);
  const row = await invitationRecord(gone.id);
  expect(row.revoked_at).not.toBeNull();
  expect(row.accepted_at).toBeNull();
  expect(await memberRoleIn(one.project.id, invitee)).toBeNull();

  // A fresh load of the same link (a fragment change alone would not reload the page).
  await page.goto('about:blank');
  await page.goto(gone.inviteUrl);
  await expect(page.getByText('Could not open this invite', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(INVITE_GONE);

  await page.goto('about:blank');
  await page.goto(nameless.inviteUrl);
  await expect(page.getByText(`Join ${two.project.name}`, { exact: true })).toBeVisible();
  await expect(page.getByText('You were invited to join as a member.', { exact: true })).toBeVisible();
  const accepted = nextResponse(page, 'POST', '/api/invitations/accept');
  await page.getByRole('button', { name: 'Accept invite' }).click();
  expect((await accepted).status()).toBe(201);
  await expect(page).toHaveURL(new RegExp(`/projects/${two.project.id}$`));
  expect(await memberRoleIn(two.project.id, invitee)).toBe('member');
});

test('TEAM-194 accept refused after the join page has shown', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('ivy', 'Ivy Invitee');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');

  await signIn(page, invitee);
  const previewed = nextResponse(page, 'POST', '/api/invitations/preview');
  await page.goto(invite.inviteUrl);
  expect((await (await previewed).json()).data.matchesAccount).toBe(true);
  const title = page.getByText(`Join ${project.name}`, { exact: true });
  await expect(title).toBeVisible();
  const acceptButton = page.getByRole('button', { name: 'Accept invite' });

  await suspendAccount(owner);
  try {
    await acceptButton.click();
    await expect(page.getByRole('alert')).toHaveText(INVITE_GONE);
    await expect(acceptButton).toBeEnabled();
    await expect(title).toBeVisible();
    expect((await invitationRecord(invite.id)).accepted_at).toBeNull();
  } finally {
    await reactivateAccount(owner);
  }

  const moved = `other-${randomUUID().slice(0, 8)}@e2e.example.test`;
  await withDb((db) => db.query('UPDATE users SET email = $2 WHERE id = $1', [invitee.userId, moved]));
  const refused = nextResponse(page, 'POST', '/api/invitations/accept');
  await acceptButton.click();
  const answer = await refused;
  expect(answer.status()).toBe(400);
  const masked = `This invite was sent to i***@${invitee.email.split('@')[1]}. Sign in with that address to accept it.`;
  expect((await answer.json()).message).toBe(masked);
  await expect(page.getByText('This invite is for another account', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(masked);
  await expect(page.getByText(`You are signed in as ${invitee.email}.`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out and use another account' })).toBeVisible();
  expect(await memberRoleIn(project.id, invitee)).toBeNull();
});

test('TEAM-195 an invite link after its project is deleted', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const invitee = await newPerson('team-invitee', 'Ivy Invitee');
  const invite = await sendInvite(project.id, owner, invitee.email, 'member');
  expect((await previewInvite(invitee, invite.token)).status).toBe(200);

  expect((await call('DELETE', `/api/projects/${project.id}`, { as: owner })).status).toBe(200);
  const remaining = await withDb(async (db) => {
    const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM project_invitations WHERE id = $1', [invite.id]);
    return Number(rows[0].n);
  });
  expect(remaining).toBe(0);
  for (const result of [await previewInvite(invitee, invite.token), await acceptInvite(invitee, invite.token)]) {
    expect(result.status).toBe(400);
    expect(messageOf(result)).toBe(INVITE_GONE);
  }

  await signIn(page, invitee);
  await page.goto(invite.inviteUrl);
  await expect(page.getByText('Could not open this invite', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(INVITE_GONE);
  await expect(page.getByRole('link', { name: 'Go to your projects' })).toBeVisible();
});

// ---- Q. Billing transfer and leaving

test('TEAM-198 the old billing owner\'s pages after a transfer', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] }, `Team ${randomUUID().slice(0, 6)}`);
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);
  expect((await call('POST', `/api/projects/${project.id}/billing-transfer/accept`, { as: coOwner })).status).toBe(200);

  // The new billing owner's Members page.
  const coPage = await personPage(browser, baseURL, coOwner);
  await openMembers(coPage, project.id);
  await expect(memberRow(coPage, owner.email).getByRole('combobox')).toBeVisible();
  await expect(memberRow(coPage, owner.email).getByRole('button', { name: 'Remove Omar Owner' })).toBeVisible();
  await expect(memberRow(coPage, coOwner.email).getByText('Billing owner', { exact: true })).toBeVisible();
  await expect(memberRow(coPage, coOwner.email).getByRole('combobox')).toHaveCount(0);
  await coPage.context().close();

  // The old one's.
  await signInStale(page, owner);
  await openMembers(page, project.id);
  const coRow = memberRow(page, coOwner.email);
  await expect(coRow.getByText('Owner', { exact: true })).toBeVisible();
  await expect(coRow.getByText('Billing owner', { exact: true })).toBeVisible();
  await expect(coRow.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByText(SEAT_LINE)).toHaveCount(0);

  await openSettings(page, project.id);
  await expect(cardTitled(page, 'Billing owner')).toHaveCount(0);
  await expect(cardTitled(page, 'Take over billing')).toHaveCount(0);
  await expect(page.getByText('Danger Zone', { exact: true })).toBeVisible();
  const leaveCard = cardTitled(page, 'Leave project');
  await expect(leaveCard.locator('[data-slot="card-description"]')).toHaveText(
    'You lose access to this project. Pending invites you sent are cancelled.',
  );
  await leaveCard.getByRole('button', { name: 'Leave project' }).click();
  const refused = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith(`/api/projects/${project.id}/leave`) && r.status() === 403,
  );
  await page.getByRole('dialog', { name: `Leave ${project.name}?` }).getByRole('button', { name: 'Leave project' }).click();
  expect((await (await refused).json()).message).toBe(REAUTH_REQUIRED);
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toBeVisible();
  await confirmWithPassword(page, owner.password);
  await expect(toastTitled(page, 'You left the project')).toBeVisible();
  expect(await memberRoleIn(project.id, owner)).toBeNull();
});

test('TEAM-200 the billing owner removing themselves through the members route', async () => {
  const { owner, project } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const path = `/api/projects/${project.id}/members/${owner.userId}`;
  const before = await activityCount(project.id);

  const stale = await call('DELETE', path, { as: await staleToken(owner) });
  expect(stale.status).toBe(403);
  expect(messageOf(stale)).toBe(REAUTH_REQUIRED);
  const fresh = await call('DELETE', path, { as: await newSignIn(owner) });
  expect(fresh.status).toBe(409);
  expect(messageOf(fresh)).toBe(MOVE_BILLING_FIRST);

  expect(await memberRoleIn(project.id, owner)).toBe('owner');
  expect((await membersOf(project.id, owner)).members.find((m) => m.userId === owner.userId)?.isBillingOwner).toBe(true);
  expect(await activityCount(project.id)).toBe(before);
});

test('TEAM-201 owners demoting themselves, and owner straight to member', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    cara: ['owner', 'Cara Co'],
    dan: ['owner', 'Dan Duo'],
  });
  const { cara, dan } = people;
  const j = await sendInvite(project.id, cara, uniqueEmail('team-j'), 'owner');
  const k = await sendInvite(project.id, cara, uniqueEmail('team-k'), 'member');
  const l = await sendInvite(project.id, dan, uniqueEmail('team-l'), 'owner');
  const n = await sendInvite(project.id, dan, uniqueEmail('team-n'), 'member');
  expect((await offerBilling(project.id, owner, dan)).status).toBe(200);
  const path = (userId: string) => `/api/projects/${project.id}/members/${userId}`;

  const stale = await call('PATCH', path(cara.userId), { as: await staleToken(cara), body: { role: 'admin' } });
  expect(stale.status).toBe(403);
  expect(messageOf(stale)).toBe(REAUTH_REQUIRED);
  expect(await memberRoleIn(project.id, cara)).toBe('owner');

  const self = await call('PATCH', path(cara.userId), { as: await newSignIn(cara), body: { role: 'admin' } });
  expect(self.status).toBe(200);
  expect(await memberRoleIn(project.id, cara)).toBe('admin');
  expect((await invitationRecord(j.id)).revoked_at).not.toBeNull();
  expect((await invitationRecord(k.id)).revoked_at).toBeNull();

  const demoted = await call('PATCH', path(dan.userId), { as: owner, body: { role: 'member' } });
  expect(demoted.status).toBe(200);
  expect(demoted.body.data.billingOffer).toBeNull();
  expect((await invitationRecord(l.id)).revoked_at).not.toBeNull();
  expect((await invitationRecord(n.id)).revoked_at).not.toBeNull();

  const changes = (await activityPage(project.id, owner)).entries.filter((e) => e.action === 'member.role_changed');
  expect(changes.map((e) => [e.actorUserId, e.targetId, e.details])).toEqual([
    [owner.userId, dan.userId, { from: 'owner', to: 'member' }],
    [cara.userId, cara.userId, { from: 'owner', to: 'admin' }],
  ]);
});

// ---- R. Activity log: more cases

test('TEAM-203 who column and sentences for every kind of actor', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    nameless: ['member', 'Soon Nameless'],
    ann: ['admin', 'Ann (Ops)'],
  });
  const { nameless, ann } = people;
  await setAccountName(nameless, '');
  expect((await call('POST', `/api/projects/${project.id}/leave`, { as: nameless })).status).toBe(200);
  const spring = { action: 'campaign.sent', targetType: 'campaign', targetLabel: 'Spring', details: { channel: 'push', audienceSize: 3 } };
  await insertActivity(project.id, [
    { ...spring, actorKind: 'api_key', actorLabel: 'API key "Server"' },
    { ...spring, actorKind: 'system', actorLabel: 'Chumbaq' },
  ]);
  const invitee = uniqueEmail('team-invitee');
  await sendInvite(project.id, ann, invitee, 'member');

  await signIn(page, owner);
  await openActivity(page, project.id);
  const rows = activityRowsOnPage(page);
  await expect(rows).toHaveCount(4);
  const who = (i: number) => rows.nth(i).locator('td:nth-child(3) p');
  await expect(whatColumn(page)).toHaveText([
    `Ann (Ops) invited ${invitee} as a member`,
    'Chumbaq sent the push campaign "Spring" to 3 devices',
    'API key "Server" sent the push campaign "Spring" to 3 devices',
    `${nameless.email} left the project`,
  ]);
  await expect(who(0)).toHaveText(['Ann (Ops)', ann.email]);
  await expect(who(1)).toHaveText(['Chumbaq']);
  await expect(who(2)).toHaveText(['API key "Server"']);
  await expect(who(3)).toHaveText([nameless.email]);
  await expect(who(3).first()).toHaveClass(/font-medium/);
});

test('TEAM-204 unknown actions and missing labels in the log', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const label = personLabel(owner);
  const by = { actorUserId: owner.userId, actorLabel: label };
  const rows = [
    { action: 'team.future_thing', ...by },
    { action: 'member.removed', ...by, targetType: 'member' },
    { action: 'member.role_changed', ...by, targetType: 'member', details: { from: 'member', to: 'admin' } },
    { action: 'invite.resent', ...by, targetType: 'invitation' },
    { action: 'invite.cancelled', ...by, targetType: 'invitation' },
    { action: 'billing.transfer_cancelled', ...by },
    { action: 'billing.transfer_offered', ...by },
    { action: 'member.role_changed', ...by, targetType: 'member', targetLabel: 'Mia Member (mia@e2e.example.test)' },
    { action: 'member.invited', ...by, targetType: 'invitation', details: { role: 'admin' } },
  ];
  // Newest first, in the order listed.
  await insertActivity(project.id, rows.map((row, i) => ({ ...row, ago: `${i + 1} minutes` })));

  const listed = await call('GET', `/api/projects/${project.id}/activity`, { as: owner });
  expect(listed.status).toBe(200);
  const entries = listed.body.data.entries as Array<Record<string, unknown>>;
  expect(entries.map((e) => e.action)).toEqual(rows.map((r) => r.action));
  expect('group' in entries[0]).toBe(false);
  expect(entries[1].group).toBe('team');

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(whatColumn(page)).toHaveText([
    'Omar Owner did team.future_thing',
    'Omar Owner removed a member from the project',
    'Omar Owner changed the role of a member from member to admin',
    'Omar Owner resent an invite',
    'Omar Owner cancelled an invite',
    'Omar Owner cancelled a billing offer',
    'Omar Owner offered billing for this project to another owner',
    'Omar Owner changed the role of Mia Member (mia@e2e.example.test)',
    'Omar Owner invited someone as an admin',
  ]);
  await choose(page, 'Kind', 'Team');
  await expect(activityRowsOnPage(page)).toHaveCount(8);
  await expect(page.getByText('Omar Owner did team.future_thing', { exact: true })).toHaveCount(0);

  const csv = await rawGet(exportPath(project.id), owner.accessToken, owner.ip);
  expect(csv.status).toBe(200);
  expect(parseCsv(csv.text).slice(1).map((cells) => cells[2])).toEqual(rows.map((r) => r.action));
});

test('TEAM-207 download edge cases', async ({ page, browser, baseURL }) => {
  test.slow();
  // 1. Filters that match nothing.
  const one = await makeTeam('Omar Owner', {});
  await sendInvite(one.project.id, one.owner, uniqueEmail('team-invitee'), 'member');
  await signIn(page, one.owner);
  await openActivity(page, one.project.id, 'from=2020-01-01&to=2020-01-01');
  await expect(page.getByText(NO_MATCH, { exact: true })).toBeVisible();
  let download = page.waitForEvent('download');
  expect((await clickDownload(page)).status()).toBe(200);
  let file = await readDownload(await download);
  expect(file.hasBom).toBe(true);
  expect(file.lines).toEqual([ACTIVITY_CSV_HEADER]);
  const [empty] = (await activityPage(one.project.id, one.owner)).entries;
  expect(empty).toMatchObject({ action: 'activity.exported', details: { filters: { from: '2020-01-01', to: '2020-01-01' }, rows: 0 } });
  await openActivity(page, one.project.id);
  await expect(whatColumn(page).first()).toHaveText('Omar Owner downloaded the activity log (0 entries)');

  // 3. A staff entry, downloaded with Kind "Chumbaq support": nothing beyond who, what and when.
  await insertActivity(one.project.id, [{ action: 'staff.viewed_as', actorKind: 'staff', actorLabel: 'Chumbaq support' }]);
  await openActivity(page, one.project.id, 'group=staff');
  await expect(whatColumn(page)).toHaveText([STAFF_SENTENCE]);
  download = page.waitForEvent('download');
  expect((await clickDownload(page)).status()).toBe(200);
  file = await readDownload(await download);
  const [staffRow] = parseCsv(file.text).slice(1);
  expect(staffRow.slice(1, 10)).toEqual(['Chumbaq support', 'staff.viewed_as', '', '', '', '', '', '', '']);

  // 2. Exactly the cap downloads; one more is refused.
  const two = await makeTeam('Olga Owner', {});
  await bulkActivity(two.project.id, two.owner, 50_000);
  const twoPage = await personPage(browser, baseURL, two.owner);
  await openActivity(twoPage, two.project.id);
  await expect(activityRowsOnPage(twoPage)).toHaveCount(50);
  download = twoPage.waitForEvent('download');
  expect((await clickDownload(twoPage)).status()).toBe(200);
  file = await readDownload(await download);
  expect(file.lines).toHaveLength(50_001);
  expect(await exportedCount(two.project.id)).toBe(1);
  // Its own entry makes 50,001.
  expect(await activityCount(two.project.id)).toBe(50_001);
  const refused = await clickDownload(twoPage);
  expect(refused.status()).toBe(400);
  await expect(downloadAlert(twoPage)).toHaveText(TOO_MANY_TO_EXPORT);
  expect(await exportedCount(two.project.id)).toBe(1);
  await twoPage.context().close();
});

test('TEAM-209 download with a malformed URL filter', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  await sendInvite(project.id, owner, uniqueEmail('team-invitee'), 'member');
  let downloads = 0;
  page.on('download', () => (downloads += 1));

  await signIn(page, owner);
  for (const query of ['person=not-a-uuid', 'from=2026-13-40']) {
    await openActivity(page, project.id, query);
    await expect(cardTitled(page, 'Activity log').getByText(INVALID_ACTIVITY_FILTER, { exact: true })).toBeVisible();
    const button = page.getByRole('button', { name: 'Download CSV' });
    await expect(button).toBeEnabled();
    const refused = await clickDownload(page);
    expect(refused.status(), query).toBe(400);
    await expect(downloadAlert(page)).toHaveText(INVALID_ACTIVITY_FILTER);
    await expect(downloadAlert(page)).toHaveClass(/text-destructive/);
  }
  expect(downloads).toBe(0);
  expect(await exportedCount(project.id)).toBe(0);
});

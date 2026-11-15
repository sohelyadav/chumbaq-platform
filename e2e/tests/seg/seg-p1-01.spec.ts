import type { Locator, Page, Request } from '@playwright/test';
import { api } from '../../support/api';
import { expect, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addDevice,
  attribute,
  audienceName,
  behaviour,
  breadcrumb,
  cardTitled,
  choose,
  countCaption,
  countFigure,
  createJourney,
  createSegment,
  eventSelect,
  group,
  groupBoxes,
  insertEvent,
  journeyName,
  previewCount,
  previewResponse,
  problemLine,
  recordRequests,
  rowNamed,
  ruleBin,
  ruleCards,
  ruleCounter,
  segmentRow,
  segProject,
  seedAudiencePeople,
  sortedMembers,
  sql,
  toastTitled,
  uniqueId,
  type SegProject,
} from '../../support/areas/seg';

/**
 * Audiences (the API's segments), P1: the sidebar and deep links, the audiences
 * list (columns, error badge, opening, deleting), and the editor creating one: its
 * defaults, the event picker, the live count and its failure, event rules and their
 * property filters, profile rules per field type, groups, the rule limit, the name,
 * evaluation, refresh interval and status, and a refused save. People arrive through
 * the SDK's identify route; events are written to user_events so they can be
 * back-dated.
 */

test.describe.configure({ mode: 'parallel' });

const SUBTITLE = 'Saved groups of people, built from what they have done and who they are. Target a campaign, a message or a journey with one.';
const DELETE_DESCRIPTION =
  'Anything still targeting this audience — a campaign, an in-app message, a journey trigger or a journey branch — will stop resolving once it is gone. Check those first; this cannot be undone.';
const KNOWN_COUNTRY = group([attribute('country', 'exists')]);
const PROFILE_FIELDS = [
  'Platform', 'App version', 'Country', 'Country code', 'Region', 'City', 'Timezone', 'Locale', 'Language',
  'Total sessions', 'Total revenue', 'First seen', 'Last seen', 'Last event', 'Email opt-in', 'Push opt-in',
  'Do not track', 'User ID', 'Distinct ID', 'Custom field…',
];
const TEXT_OPS = ['is', 'is not', 'contains', 'is one of', 'is known', 'is unknown'];
const ORDERED_OPS = ['is', 'is not', 'is greater than', 'is at least', 'is less than', 'is at most', 'is known', 'is unknown'];
const BOOLEAN_OPS = ['is', 'is known', 'is unknown'];

async function openAudiences(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/segments`);
  await expect(page.getByRole('heading', { name: 'Audiences', exact: true })).toBeVisible();
}

async function openEditor(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/segments/new`);
  await expect(page.getByRole('heading', { name: 'New audience', exact: true })).toBeVisible();
}

/** A project with a person who did `purchase`, so the event picker has an entry. */
async function projectWithPurchase(ip: string, label: string): Promise<SegProject> {
  const p = await segProject(ip, label);
  const device = await addDevice(p, ip, { externalUserId: uniqueId('u-buyer') });
  await insertEvent(p.project.id, device, 'purchase', { amount: 10 }, 2);
  return p;
}

/** Chooses an event on the editor's first event rule and waits for its count. */
async function chooseEvent(page: Page, eventName = 'purchase', scope: Page | Locator = page): Promise<void> {
  const counted = previewResponse(page);
  await choose(eventSelect(scope), eventName);
  await counted;
}

/** The option names of a Radix select, then closes it. */
async function optionsOf(trigger: Locator): Promise<string[]> {
  await trigger.click();
  const page = trigger.page();
  await expect(page.getByRole('option').first()).toBeVisible();
  const names = await page.getByRole('option').allInnerTexts();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);
  return names.map((name) => name.trim());
}

function isSegmentsPost(pid: string) {
  return (request: Request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/projects/${pid}/segments`;
}

function previewBody(response: { request(): Request }): any {
  return response.request().postDataJSON().definition;
}

/** Removes the editor's default event rule, leaving no rules. */
async function removeDefaultRule(page: Page): Promise<void> {
  await ruleBin(ruleCards(page).first()).click();
  await expect(ruleCards(page)).toHaveCount(0);
}

/** Adds a top-level profile rule and answers its card. */
async function addProfileRule(page: Page): Promise<Locator> {
  const before = await ruleCards(page).count();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(ruleCards(page)).toHaveCount(before + 1);
  return ruleCards(page).nth(before);
}

// ---- Navigation and shell

test('SEG-001 sidebar Audiences opens the audiences list', { annotation: { type: 'issue', description: 'SEG-001' } }, async ({ page, clientIp }) => {
  test.fail();
  const p = await segProject(clientIp, 'seg001');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}`);
  await openSidebarGroup(page, 'Engagement');
  // The group itself opens: its other entries are there.
  await expect(sidebarLink(page, 'In-App Messages')).toBeVisible();
  await sidebarLink(page, 'Audiences').click({ timeout: 5000 });

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/segments$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Audiences', exact: true })).toBeVisible();
  await expect(page.getByText(SUBTITLE, { exact: true })).toBeVisible();
  const crumbs = breadcrumb(page).getByRole('listitem');
  await expect(crumbs).toHaveCount(1);
  await expect(crumbs).toHaveText('Audiences');
  await expect(breadcrumb(page)).not.toContainText('Segments');
  await expect(page.getByRole('link', { name: 'New audience' })).toBeVisible();
});

test('SEG-002 sidebar Journeys opens the journeys list', { annotation: { type: 'issue', description: 'SEG-002' } }, async ({ page, clientIp }) => {
  test.fail();
  const p = await segProject(clientIp, 'seg002');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}`);
  await openSidebarGroup(page, 'Engagement');
  // The group itself opens: its other entries are there.
  await expect(sidebarLink(page, 'In-App Messages')).toBeVisible();
  await sidebarLink(page, 'Journeys').click({ timeout: 5000 });

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/journeys$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Journeys', exact: true })).toBeVisible();
  await expect(page.getByText('Multi-step campaigns that move people through waits, messages and branches over time.', { exact: true })).toBeVisible();
  const crumbs = breadcrumb(page).getByRole('listitem');
  await expect(crumbs).toHaveCount(1);
  await expect(crumbs).toHaveText('Journeys');
  const card = cardTitled(page, 'Journeys');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-slot="card-description"]')).toHaveText('Only active journeys enrol new people. Counts update every 30 seconds.');
});

test('SEG-004 deep links to an audience and a journey load after a full page load', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg004');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  const welcome = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  const newAsId = recordRequests(page, 'GET', /^\/api\/.*\/(segments|journeys)\/new$/);

  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/segments/${vip.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'VIP', exact: true })).toBeVisible();
  await expect(audienceName(page)).toHaveValue('VIP');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'VIP', exact: true })).toBeVisible();
  await expect(audienceName(page)).toHaveValue('VIP');

  await page.goto(`/projects/${pid}/journeys/${welcome.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome', exact: true })).toBeVisible();
  await expect(journeyName(page)).toHaveValue('Welcome');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome', exact: true })).toBeVisible();
  await expect(journeyName(page)).toHaveValue('Welcome');

  // The create routes never ask the API for a record called "new".
  await page.goto(`/projects/${pid}/segments/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'New audience', exact: true })).toBeVisible();
  await page.goto(`/projects/${pid}/journeys/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'New journey', exact: true })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(newAsId).toEqual([]);
});

// ---- Audiences list

test('SEG-006 empty audiences list', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg006');
  await signIn(page, p.owner);
  await openAudiences(page, p.project.id);

  const card = cardTitled(page, 'All audiences');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText('0 defined');
  await expect(card.getByText('No audiences yet', { exact: true })).toBeVisible();
  await expect(
    card.getByText(
      'An audience answers “who should get this?” once, and every campaign after it can reuse the answer. Start with something like “bought in the last 30 days”.',
      { exact: true },
    ),
  ).toBeVisible();
  const createOne = card.getByRole('link', { name: 'Create one' });
  await expect(createOne).toHaveAttribute('href', `/projects/${p.project.id}/segments/new`);
  await createOne.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/segments/new$`));
  await expect(page.getByRole('heading', { level: 1, name: 'New audience', exact: true })).toBeVisible();
});

test('SEG-009 table columns for each kind of audience', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg009');
  const pid = p.project.id;
  const make = (body: Record<string, unknown>) => createSegment(p.owner, pid, clientIp, body);
  await make({
    name: 'SEG-009 a',
    description: 'Buyers',
    definition: group([behaviour('purchase')]),
    evaluationMode: 'live',
    status: 'active',
  });
  await make({
    name: 'SEG-009 b',
    definition: group([behaviour('purchase'), behaviour('signup'), attribute('country', 'eq', 'IN')], 'or'),
    evaluationMode: 'materialized',
    refreshIntervalMinutes: 30,
    status: 'draft',
  });
  const c = await make({ name: 'SEG-009 c', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  await sql(`UPDATE segments SET last_member_count = 12345, last_materialized_at = now() WHERE id = $1`, [c.id]);
  await make({ name: 'SEG-009 d', definition: attribute('country', 'exists'), evaluationMode: 'live' });
  await make({ name: 'SEG-009 e', definition: group([group([behaviour('purchase'), behaviour('signup')])]), evaluationMode: 'live' });
  await make({
    name: 'SEG-009 f',
    definition: group([attribute('country', 'eq', 'IN'), attribute('city', 'eq', 'Pune')]),
    evaluationMode: 'live',
  });

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await expect(page.getByRole('columnheader')).toHaveText(['Name', 'Rules', 'Evaluation', 'Members', 'Status', '']);

  const cells = (name: string) => rowNamed(page, name).getByRole('cell');
  const a = cells('SEG-009 a');
  await expect(a.nth(0)).toContainText('Buyers');
  await expect(a.nth(1)).toHaveText('1 event · all');
  await expect(a.nth(2)).toHaveText('Live');
  await expect(a.nth(3)).toHaveText('counted live');
  await expect(a.nth(3).getByTitle('Counted on demand')).toBeVisible();
  await expect(a.nth(4)).toHaveText('Active');

  const b = cells('SEG-009 b');
  await expect(b.nth(1)).toHaveText('2 events + 1 profile · any');
  await expect(b.nth(2)).toHaveText('Every 30m');
  await expect(b.nth(3)).toHaveText('not yet refreshed');
  await expect(b.nth(4)).toHaveText('Draft');

  await expect(cells('SEG-009 c').nth(3)).toHaveText('12,345');
  await expect(cells('SEG-009 d').nth(1)).toHaveText('1 rule');
  await expect(cells('SEG-009 e').nth(1)).toHaveText('2 events · all');
  await expect(cells('SEG-009 f').nth(1)).toHaveText('2 profiles · all');
});

test('SEG-010 an audience in error shows a badge and its stored error in a tooltip', async ({ page, clientIp }) => {
  const ERROR = 'canceling statement due to statement timeout';
  const p = await segProject(clientIp, 'seg010');
  const segment = await createSegment(p.owner, p.project.id, clientIp, {
    name: 'SEG-010 slow',
    definition: KNOWN_COUNTRY,
    evaluationMode: 'materialized',
    status: 'active',
  });
  await createSegment(p.owner, p.project.id, clientIp, { name: 'SEG-010 fine', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  await sql(`UPDATE segments SET status = 'error', error_message = $2 WHERE id = $1`, [segment.id, ERROR]);

  await signIn(page, p.owner);
  await openAudiences(page, p.project.id);
  const row = rowNamed(page, 'SEG-010 slow');
  const badge = row.locator('[data-slot="badge"]');
  await expect(badge).toHaveText('Error');
  await expect(badge).toHaveClass(/text-destructive/);
  // The audience without an error has no warning icon.
  await expect(rowNamed(page, 'SEG-010 fine').locator('svg.text-destructive')).toHaveCount(0);

  await row.locator('svg.text-destructive').hover();
  await expect(page.getByRole('tooltip')).toHaveText(ERROR);
});

test('SEG-012 the name and the pencil open the editor', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg012');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live' });

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await rowNamed(page, 'VIP').getByRole('link', { name: 'VIP', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/${vip.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'VIP', exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments$`));
  const pencil = rowNamed(page, 'VIP').getByRole('cell').last().getByRole('link');
  await expect(pencil).toHaveCount(1);
  await pencil.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/${vip.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'VIP', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments$`));
  await expect(rowNamed(page, 'VIP')).toBeVisible();
});

test('SEG-013 cancelling a delete leaves the audience', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg013');
  const vip = await createSegment(p.owner, p.project.id, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  const deletes = recordRequests(page, 'DELETE', /\/segments\//);

  await signIn(page, p.owner);
  await openAudiences(page, p.project.id);
  const dialog = page.getByRole('dialog');

  await rowNamed(page, 'VIP').getByRole('button').click();
  await expect(dialog.getByRole('heading')).toHaveText('Delete “VIP”?');
  await expect(dialog.getByText(DELETE_DESCRIPTION, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete audience' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await rowNamed(page, 'VIP').getByRole('button').click();
  await expect(dialog.getByRole('heading')).toHaveText('Delete “VIP”?');
  // The dialog listens for Escape once it has taken focus; a key pressed before
  // that is not one a person could press.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await expect(rowNamed(page, 'VIP')).toBeVisible();
  await page.waitForTimeout(500);
  expect(deletes).toEqual([]);
  expect(await segmentRow(vip.id)).toBeDefined();
});

test('SEG-015 a delete from a stale list after another tab deleted it', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg015');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live' });

  await signIn(page, p.owner);
  const stale = await page.context().newPage();
  await openAudiences(page, pid);
  await openAudiences(stale, pid);
  await rowNamed(stale, 'VIP').getByRole('button').click();
  const staleDialog = stale.getByRole('dialog');
  await expect(staleDialog.getByRole('heading')).toHaveText('Delete “VIP”?');

  await rowNamed(page, 'VIP').getByRole('button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete audience' }).click();
  await expect(toastTitled(page, 'Audience deleted')).toBeVisible();

  const [response] = await Promise.all([
    stale.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/segments/${vip.id}`)),
    staleDialog.getByRole('button', { name: 'Delete audience' }).click(),
  ]);
  expect(response.status()).toBe(404);
  const toast = toastTitled(stale, 'Could not delete');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(`Segment ${vip.id} not found`);
  await expect(staleDialog).toBeVisible();

  const rows = await activityRows(pid, 'content.deleted');
  expect(rows.filter((row) => row.target_id === vip.id)).toHaveLength(1);
});

test('SEG-017 deleting an audience a journey uses', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg017');
  const pid = p.project.id;
  const lapsed = await createSegment(p.owner, pid, clientIp, {
    name: 'Lapsed',
    definition: KNOWN_COUNTRY,
    evaluationMode: 'materialized',
    status: 'active',
  });
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Win back',
    trigger: { type: 'segment_entry', segmentId: lapsed.id },
  });
  expect(journey.status).toBe('draft');

  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/journeys`);
  const winBack = rowNamed(page, 'Win back');
  await expect(winBack.getByRole('cell').nth(2)).toHaveText('When someone enters Lapsed');

  await openAudiences(page, pid);
  await rowNamed(page, 'Lapsed').getByRole('button').click();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/segments/${lapsed.id}`)),
    page.getByRole('dialog').getByRole('button', { name: 'Delete audience' }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(toastTitled(page, 'Audience deleted')).toBeVisible();

  await page.goto(`/projects/${pid}/journeys`);
  await expect(winBack.getByRole('cell').nth(2)).toHaveText('When someone enters a segment that no longer exists');
  const gone = winBack.getByTitle('This segment may have been deleted');
  await expect(gone).toHaveText('a segment that no longer exists');
  await expect(gone).toHaveClass(/text-destructive/);
});

// ---- Audience editor: create

test('SEG-019 create page defaults', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg019');
  const pid = p.project.id;
  const previews = recordRequests(page, 'POST', '/segments/preview');

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await page.getByRole('link', { name: 'New audience' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/new$`));
  await expect(page.getByRole('heading', { level: 1, name: 'New audience', exact: true })).toBeVisible();
  await expect(page.getByText('Describe who belongs, from what they have done and who they are.', { exact: true })).toBeVisible();

  await expect(ruleCards(page)).toHaveCount(1);
  const rule = ruleCards(page).first();
  await expect(rule.locator('[data-slot="badge"]')).toHaveText('Did');
  await expect(eventSelect(rule)).toHaveCount(1);
  await expect(rule.getByRole('combobox').nth(1)).toHaveText('at least');
  const numbers = rule.locator('input[type="number"]');
  await expect(numbers.nth(0)).toHaveValue('1');
  await expect(rule.getByText('time', { exact: true })).toBeVisible();
  await expect(rule.getByText('in the last', { exact: true })).toBeVisible();
  await expect(numbers.nth(1)).toHaveValue('30');
  await expect(rule.getByText('days', { exact: true })).toBeVisible();
  await expect(rule.getByRole('button', { name: 'Filter on a property' })).toBeVisible();

  const rules = cardTitled(page, 'Rules');
  const header = rules.locator('[data-slot="card-header"]');
  await expect(header.getByText('Match', { exact: true })).toBeVisible();
  await expect(header.getByRole('combobox')).toHaveText('all of');
  await expect(header.getByText('the following', { exact: true })).toBeVisible();
  await expect(ruleCounter(page)).toHaveText('1 of 50 rules');
  await expect(problemLine(page)).toHaveText('Rule 1: choose an event.');
  await expect(countFigure(page)).toHaveText('—');
  await expect(countCaption(page)).toHaveText('rules unfinished');

  const kept = cardTitled(page, 'How it is kept up to date');
  await expect(kept.getByRole('combobox').nth(0)).toHaveText('Live');
  await expect(kept.getByRole('combobox').nth(1)).toHaveText('Active');
  await expect(kept.getByText('Refresh every')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create audience' })).toBeVisible();

  await page.waitForTimeout(1500);
  expect(previews).toEqual([]);
});

test('SEG-020 the event picker lists this project’s event names, most frequent first', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg020');
  const pid = p.project.id;
  const device = await addDevice(p, clientIp, { externalUserId: uniqueId('u-one') });
  for (let i = 0; i < 2; i += 1) await insertEvent(pid, device, 'signup', null, 1);
  for (let i = 0; i < 6; i += 1) await insertEvent(pid, device, 'purchase', { amount: i }, 1);
  // Another tenant's project with an event more frequent than either.
  const other = await segProject(clientIp, 'seg020-x');
  const otherDevice = await addDevice(other, clientIp, { externalUserId: uniqueId('u-x') });
  for (let i = 0; i < 10; i += 1) await insertEvent(other.project.id, otherDevice, 'other_tenant_event', null, 1);

  await signIn(page, p.owner);
  await openEditor(page, pid);
  expect(await optionsOf(eventSelect(page))).toEqual(['purchase', 'signup']);
});

test('SEG-025 a failed preview shows "could not count"', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg025');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openEditor(page, pid);

  await page.route('**/segments/preview', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) }),
  );
  const failed = previewResponse(page);
  await choose(eventSelect(page), 'purchase');
  expect((await failed).status()).toBe(500);
  await expect(countFigure(page)).toHaveText('—');
  await expect(countCaption(page)).toHaveText('could not count');
  await expect(problemLine(page)).toHaveText('Internal server error');
  await expect(page.getByRole('button', { name: 'Create audience' })).toBeEnabled();

  await page.unroute('**/segments/preview');
  const counted = previewResponse(page, (d) => d.children[0].withinDays === 29);
  await ruleCards(page).first().locator('input[type="number"]').nth(1).fill('29');
  expect((await counted).ok()).toBe(true);
  await expect(countFigure(page)).toHaveText('1');
  await expect(countCaption(page)).toHaveText('people match');
  await expect(problemLine(page)).toHaveCount(0);
});

test('SEG-026 "never" turns the rule into "Did not"', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg026');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await chooseEvent(page);

  const rule = ruleCards(page).first();
  const never = previewResponse(page, (d) => d.children[0].occurrence === 'none');
  await choose(rule.getByRole('combobox').filter({ hasText: 'at least' }), 'never');
  const response = await never;
  expect(previewBody(response).children[0]).toEqual({ type: 'behaviour', eventName: 'purchase', occurrence: 'none', count: 0, withinDays: 30 });
  // Bob (purchase 40 days ago) and the anonymous device; not alice, and not the do-not-track person.
  expect(await response.json()).toEqual({ data: { count: 2 } });
  await expect(rule.locator('[data-slot="badge"]')).toHaveText('Did not');
  await expect(rule.locator('input[type="number"]')).toHaveCount(1);
  await expect(rule.getByText(/^times?$/)).toHaveCount(0);
  await expect(countFigure(page)).toHaveText('2');

  expect(await sortedMembers(p.owner, pid, clientIp, previewBody(response))).toEqual([people.anon, people.bob].sort());
});

test('SEG-028 "at most" and "exactly" counts', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg028');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  const purchases = (occurrence: string, count: number) => group([behaviour('purchase', { occurrence, count, withinDays: 30 })]);

  expect(await previewCount(p.owner, pid, clientIp, purchases('exactly', 3))).toBe(1);
  expect(await sortedMembers(p.owner, pid, clientIp, purchases('exactly', 3))).toEqual([people.alice]);
  // Nobody bought exactly twice in the window: alice three times, bob and the anonymous
  // device not at all, and the do-not-track person's two purchases are not counted.
  expect(await previewCount(p.owner, pid, clientIp, purchases('exactly', 2))).toBe(0);
  expect(await sortedMembers(p.owner, pid, clientIp, purchases('exactly', 2))).toEqual([]);
  expect(await previewCount(p.owner, pid, clientIp, purchases('at_most', 2))).toBe(2);
  expect(await sortedMembers(p.owner, pid, clientIp, purchases('at_most', 2))).toEqual([people.anon, people.bob].sort());
  expect(await previewCount(p.owner, pid, clientIp, purchases('at_least', 3))).toBe(1);
  expect(await sortedMembers(p.owner, pid, clientIp, purchases('at_least', 3))).toEqual([people.alice]);
});

test('SEG-029 the time window must be 1 to 365 whole days', async ({ page, clientIp }) => {
  const WINDOW = 'Rule 1: the time window must be a whole number of days between 1 and 365.';
  const p = await projectWithPurchase(clientIp, 'seg029');
  await signIn(page, p.owner);
  await openEditor(page, p.project.id);
  await chooseEvent(page);
  const days = ruleCards(page).first().locator('input[type="number"]').nth(1);

  const previews = recordRequests(page, 'POST', '/segments/preview');
  for (const bad of ['0', '366', '1.5', '', '-3']) {
    await days.fill(bad);
    await expect(problemLine(page), `days "${bad}"`).toHaveText(WINDOW);
    await expect(countFigure(page)).toHaveText('—');
    await expect(countCaption(page)).toHaveText('rules unfinished');
  }
  await page.waitForTimeout(1200);
  expect(previews).toEqual([]);

  // The one purchase was two days ago: outside a 1-day window, inside a 365-day one.
  for (const [good, people] of [[1, '0'], [365, '1']] as const) {
    const counted = previewResponse(page, (d) => d.children[0].withinDays === good);
    await days.fill(String(good));
    await expect(problemLine(page)).toHaveCount(0);
    expect((await counted).ok()).toBe(true);
    await expect(countFigure(page)).toHaveText(people);
    await expect(countCaption(page)).toHaveText('people match');
  }
});

test('SEG-030 the number of times must be a whole number, zero or more', async ({ page, clientIp }) => {
  const TIMES = 'Rule 1: the number of times must be a whole number, zero or more.';
  const p = await segProject(clientIp, 'seg030');
  await seedAudiencePeople(p, clientIp);
  await signIn(page, p.owner);
  await openEditor(page, p.project.id);
  await chooseEvent(page);
  const count = ruleCards(page).first().locator('input[type="number"]').nth(0);

  for (const bad of ['-1', '1.5']) {
    await count.fill(bad);
    await expect(problemLine(page), `count "${bad}"`).toHaveText(TIMES);
    await expect(countFigure(page)).toHaveText('—');
  }

  const zero = previewResponse(page, (d) => d.children[0].count === 0);
  await count.fill('0');
  await expect(problemLine(page)).toHaveCount(0);
  const zeroResponse = await zero;
  expect(previewBody(zeroResponse).children[0]).toMatchObject({ occurrence: 'at_least', count: 0 });
  // "At least 0 times" holds for everyone whose behaviour is known.
  expect(await zeroResponse.json()).toEqual({ data: { count: 3 } });

  await count.fill('-1');
  await expect(problemLine(page)).toHaveText(TIMES);
  // Asserts today's behaviour as the case is written: a blank count is accepted and
  // sent as 0, which matches the same people as "at least 0".
  const blank = previewResponse(page, (d) => d.children[0].count === 0);
  await count.fill('');
  await expect(problemLine(page)).toHaveCount(0);
  const blankResponse = await blank;
  expect(previewBody(blankResponse).children[0]).toMatchObject({ occurrence: 'at_least', count: 0 });
  expect(await blankResponse.json()).toEqual({ data: { count: 3 } });
});

test('SEG-031 a property filter: add, value, remove', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg031');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await chooseEvent(page);
  const rule = ruleCards(page).first();

  await rule.getByRole('button', { name: 'Filter on a property' }).click();
  await expect(rule.getByText('where', { exact: true })).toBeVisible();
  await expect(rule.getByPlaceholder('property name')).toHaveValue('');
  await expect(rule.getByPlaceholder('value', { exact: true })).toHaveValue('');
  await expect(ruleCounter(page)).toHaveText('2 of 50 rules');

  await rule.getByPlaceholder('property name').fill('amount');
  await choose(rule.getByRole('combobox').filter({ hasText: /^is$/ }), 'is greater than');
  const filtered = previewResponse(page, (d) => d.children[0].where?.[0]?.value === 100);
  await rule.getByPlaceholder('value', { exact: true }).fill('100');
  const response = await filtered;
  const where = previewBody(response).children[0].where;
  expect(where).toEqual([{ property: 'amount', op: 'gt', value: 100 }]);
  expect(typeof where[0].value).toBe('number');
  expect(await response.json()).toEqual({ data: { count: 1 } });
  expect(await sortedMembers(p.owner, pid, clientIp, previewBody(response))).toEqual([people.alice]);

  const unfiltered = previewResponse(page, (d) => !('where' in d.children[0]));
  await rule.locator('div').filter({ has: page.getByText('where', { exact: true }) }).last().getByRole('button').click();
  const after = await unfiltered;
  expect(previewBody(after).children[0]).toEqual({ type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 1, withinDays: 30 });
  await expect(ruleCounter(page)).toHaveText('1 of 50 rules');
  await expect(rule.getByPlaceholder('property name')).toHaveCount(0);
});

test('SEG-033 property filter validation', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg033');
  await signIn(page, p.owner);
  await openEditor(page, p.project.id);
  await chooseEvent(page);
  const rule = ruleCards(page).first();
  await rule.getByRole('button', { name: 'Filter on a property' }).click();
  const property = rule.getByPlaceholder('property name');
  const value = rule.getByPlaceholder('value', { exact: true });

  await property.fill('my amount');
  await value.fill('5');
  await expect(problemLine(page)).toHaveText('Rule 1: "my amount" is not a valid property name.');

  await property.fill('amount');
  await value.fill('');
  await expect(problemLine(page)).toHaveText('Rule 1: give a value for the "amount" filter.');

  // An empty property is ignored and not sent, though it still counts as a rule.
  const ignored = previewResponse(page, (d) => !('where' in d.children[0]));
  await property.fill('');
  await value.fill('5');
  await expect(problemLine(page)).toHaveCount(0);
  expect(previewBody(await ignored).children[0].where).toBeUndefined();
  await expect(ruleCounter(page)).toHaveText('2 of 50 rules');

  const tooLong = 'a'.repeat(65);
  await property.fill(tooLong);
  await expect(problemLine(page)).toHaveText(`Rule 1: "${tooLong}" is not a valid property name.`);

  const longest = 'a'.repeat(64);
  const accepted = previewResponse(page, (d) => d.children[0].where?.[0]?.property === longest);
  await property.fill(longest);
  await expect(problemLine(page)).toHaveCount(0);
  expect((await accepted).ok()).toBe(true);
});

test('SEG-035 a profile rule offers the profile fields', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg035');
  await signIn(page, p.owner);
  await openEditor(page, p.project.id);
  await chooseEvent(page);

  const profile = await addProfileRule(page);
  await expect(profile.locator('[data-slot="badge"]')).toHaveText('Profile');
  await expect(profile.getByRole('combobox').nth(0)).toHaveText('Country');
  await expect(profile.getByRole('combobox').nth(1)).toHaveText('is');
  await expect(profile.getByPlaceholder('value', { exact: true })).toHaveValue('');
  await expect(problemLine(page)).toHaveText('Rule 2: give a value to compare against.');
  expect(await optionsOf(profile.getByRole('combobox').nth(0))).toEqual(PROFILE_FIELDS);
});

test('SEG-036 operators and value inputs per field type', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg036');
  await signIn(page, p.owner);
  await openEditor(page, p.project.id);
  await removeDefaultRule(page);
  const rule = await addProfileRule(page);
  const field = rule.getByRole('combobox').nth(0);
  const op = rule.getByRole('combobox').nth(1);

  // Text.
  expect(await optionsOf(op)).toEqual(TEXT_OPS);
  await expect(rule.locator('input[type="text"]')).toHaveCount(1);
  // "contains" does not exist for numbers, so the operator falls back to the first.
  await choose(op, 'contains');
  await choose(field, 'Total sessions');
  await expect(op).toHaveText('is');
  expect(await optionsOf(op)).toEqual(ORDERED_OPS);
  await expect(rule.locator('input[type="number"]')).toHaveCount(1);

  // An operator both types allow survives the change.
  await choose(op, 'is greater than');
  await choose(field, 'First seen');
  await expect(op).toHaveText('is greater than');
  expect(await optionsOf(op)).toEqual(ORDERED_OPS);
  await expect(rule.locator('input[type="date"]')).toHaveCount(1);

  await choose(field, 'Email opt-in');
  await expect(op).toHaveText('is');
  expect(await optionsOf(op)).toEqual(BOOLEAN_OPS);
  await expect(rule.locator('input')).toHaveCount(0);
  await expect(rule.getByRole('combobox').nth(2)).toHaveText('Yes');
  expect(await optionsOf(rule.getByRole('combobox').nth(2))).toEqual(['Yes', 'No']);

  await choose(field, 'Country');
  await choose(op, 'is not');
  await choose(field, 'Total sessions');
  await expect(op).toHaveText('is not');
});

test('SEG-037 a boolean field shows "Yes" but is unfinished until a value is picked', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg037');
  await signIn(page, p.owner);
  await openEditor(page, p.project.id);
  await removeDefaultRule(page);
  const rule = await addProfileRule(page);
  await choose(rule.getByRole('combobox').nth(0), 'Email opt-in');
  const value = rule.getByRole('combobox').nth(2);

  // Asserts today's behaviour as the case is written: the select shows "Yes" while
  // the rule holds no value.
  await expect(value).toHaveText('Yes');
  await expect(problemLine(page)).toHaveText('Rule 1: give a value to compare against.');
  await expect(countFigure(page)).toHaveText('—');
  await expect(countCaption(page)).toHaveText('rules unfinished');

  const no = previewResponse(page, (d) => d.children[0].value === false);
  await choose(value, 'No');
  expect(previewBody(await no).children[0]).toEqual({ type: 'attribute', field: 'emailOptIn', op: 'eq', value: false });
  await expect(problemLine(page)).toHaveCount(0);

  const yes = previewResponse(page, (d) => d.children[0].value === true);
  await choose(value, 'Yes');
  expect(previewBody(await yes).children[0]).toEqual({ type: 'attribute', field: 'emailOptIn', op: 'eq', value: true });
});

test('SEG-038 "is known" and "is unknown" take no value', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg038');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await removeDefaultRule(page);
  const rule = await addProfileRule(page);
  const op = rule.getByRole('combobox').nth(1);

  const unknown = previewResponse(page, (d) => d.children[0].op === 'not_exists');
  await choose(op, 'is unknown');
  await expect(rule.locator('input')).toHaveCount(0);
  const unknownResponse = await unknown;
  expect(previewBody(unknownResponse).children[0]).toEqual({ type: 'attribute', field: 'country', op: 'not_exists', value: null });
  expect(await unknownResponse.json()).toEqual({ data: { count: 1 } });
  await expect(countFigure(page)).toHaveText('1');
  expect(await sortedMembers(p.owner, pid, clientIp, previewBody(unknownResponse))).toEqual([people.anon]);

  const known = previewResponse(page, (d) => d.children[0].op === 'exists');
  await choose(op, 'is known');
  await expect(rule.locator('input')).toHaveCount(0);
  const knownResponse = await known;
  expect(previewBody(knownResponse).children[0]).toEqual({ type: 'attribute', field: 'country', op: 'exists', value: null });
  expect(await knownResponse.json()).toEqual({ data: { count: 3 } });
  expect(await sortedMembers(p.owner, pid, clientIp, previewBody(knownResponse))).toEqual([people.alice, people.bob, people.dnt].sort());
});

test('SEG-039 "is one of" takes a comma list', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg039');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await removeDefaultRule(page);
  const rule = await addProfileRule(page);
  await choose(rule.getByRole('combobox').nth(1), 'is one of');
  const value = rule.getByPlaceholder('india, nepal, sri lanka');
  await expect(value).toBeVisible();

  const listed = previewResponse(page, (d) => Array.isArray(d.children[0].value) && d.children[0].value.length === 2);
  await value.fill('IN, US');
  const response = await listed;
  expect(previewBody(response).children[0]).toEqual({ type: 'attribute', field: 'country', op: 'in', value: ['IN', 'US'] });
  expect(await response.json()).toEqual({ data: { count: 3 } });
  expect(await sortedMembers(p.owner, pid, clientIp, previewBody(response))).toEqual([people.alice, people.bob, people.dnt].sort());

  await value.fill(', ,');
  await expect(problemLine(page)).toHaveText('Rule 1: list at least one value, separated by commas.');
  await value.fill('');
  await expect(problemLine(page)).toHaveText('Rule 1: give a value to compare against.');
});

test('SEG-040 "is not" includes people with no value', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg040');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  const notUs = group([attribute('country', 'neq', 'US')]);
  expect(await previewCount(p.owner, pid, clientIp, notUs)).toBe(3);
  expect(await sortedMembers(p.owner, pid, clientIp, notUs)).toEqual([people.alice, people.anon, people.dnt].sort());
});

test('SEG-042 a custom field addresses a trait', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg042');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await removeDefaultRule(page);
  const rule = await addProfileRule(page);
  const field = rule.getByRole('combobox').nth(0);

  await choose(field, 'Custom field…');
  await expect(field).toHaveText('Custom field…');
  const key = rule.getByPlaceholder('plan, tier, …');
  await key.fill('plan');
  await expect(rule.getByRole('combobox').nth(1)).toHaveText('is');
  expect(await optionsOf(rule.getByRole('combobox').nth(1))).toEqual(TEXT_OPS);

  const matched = previewResponse(page, (d) => d.children[0].value === 'pro');
  await rule.getByPlaceholder('value', { exact: true }).fill('pro');
  const response = await matched;
  expect(previewBody(response).children[0]).toEqual({ type: 'attribute', field: 'traits.plan', op: 'eq', value: 'pro' });
  expect(await response.json()).toEqual({ data: { count: 1 } });
  expect(await sortedMembers(p.owner, pid, clientIp, previewBody(response))).toEqual([people.alice]);

  await key.fill('first name');
  await expect(problemLine(page)).toHaveText('Rule 1: "first name" is not a valid custom field name.');
  await key.fill('');
  await expect(problemLine(page)).toHaveText('Rule 1: "" is not a valid custom field name.');
  await expect(field).toHaveText('Custom field…');
});

test('SEG-048 the "Do not track" field reads the row flag or an objection', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg048');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  const objected = uniqueId('u-objected');
  await addDevice(p, clientIp, { externalUserId: objected, row: { country: 'IN' } });
  await addDevice(p, clientIp, { externalUserId: objected, row: { country: 'US' } });
  const dntIs = (value: boolean) => group([attribute('doNotTrack', 'eq', value)]);

  // Positive control: before the objection, only the flagged row is do-not-track.
  expect(await sortedMembers(p.owner, pid, clientIp, dntIs(true))).toEqual([people.dnt]);

  await api('POST', `/api/identity/projects/${pid}/tracking-objections`, { externalUserId: objected }, { token: p.owner.accessToken, ip: clientIp });
  const [{ n: flagged }] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM device_identities WHERE project_id = $1 AND external_user_id = $2 AND do_not_track`,
    [pid, objected],
  );
  expect(flagged).toBe(0);

  expect(await previewCount(p.owner, pid, clientIp, dntIs(true))).toBe(2);
  expect(await sortedMembers(p.owner, pid, clientIp, dntIs(true))).toEqual([objected, people.dnt].sort());
  expect(await previewCount(p.owner, pid, clientIp, dntIs(false))).toBe(3);
  expect(await sortedMembers(p.owner, pid, clientIp, dntIs(false))).toEqual([people.alice, people.anon, people.bob].sort());
});

test('SEG-050 groups: add, operator, children, remove', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg050');
  await signIn(page, p.owner);
  await openEditor(page, p.project.id);
  await chooseEvent(page);

  await page.getByRole('button', { name: 'Group', exact: true }).click();
  const box = groupBoxes(page);
  await expect(box).toHaveCount(1);
  await expect(box.getByText('Match', { exact: true })).toBeVisible();
  const operator = box.getByRole('combobox').first();
  await expect(operator).toHaveText('any of');
  await expect(box.getByText('these', { exact: true })).toBeVisible();
  await expect(ruleCards(box)).toHaveCount(1);
  await expect(ruleCounter(page)).toHaveText('2 of 50 rules');
  await expect(problemLine(page)).toHaveText('Rule 2.1: choose an event.');

  const nestedOr = previewResponse(page, (d) => d.children[1]?.type === 'group' && d.children[1].children[0].eventName === 'purchase');
  await choose(eventSelect(box), 'purchase');
  expect(previewBody(await nestedOr).children[1]).toEqual({
    type: 'group',
    operator: 'or',
    children: [{ type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 1, withinDays: 30 }],
  });

  const nestedAnd = previewResponse(page, (d) => d.children[1]?.operator === 'and');
  await choose(operator, 'all of');
  expect(previewBody(await nestedAnd).children[1].operator).toBe('and');

  await box.getByRole('button', { name: 'Event', exact: true }).click();
  await expect(ruleCards(box)).toHaveCount(2);
  await expect(ruleCounter(page)).toHaveText('3 of 50 rules');
  await expect(problemLine(page)).toHaveText('Rule 2.2: choose an event.');
  await box.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(ruleCards(box)).toHaveCount(3);
  await expect(ruleCards(box).nth(2).locator('[data-slot="badge"]')).toHaveText('Profile');
  await expect(ruleCounter(page)).toHaveText('4 of 50 rules');

  for (const left of [2, 1, 0]) {
    await ruleBin(ruleCards(box).last()).click();
    await expect(ruleCards(box)).toHaveCount(left);
  }
  await expect(ruleCounter(page)).toHaveText('1 of 50 rules');
  await expect(operator).toHaveText('all of');
  // The wording says "any of" whatever the group's operator.
  await expect(problemLine(page)).toHaveText('Rule 2: an "any of" group needs at least one rule inside it.');

  await box.getByRole('button', { name: 'Event', exact: true }).click();
  await box.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(ruleCounter(page)).toHaveText('3 of 50 rules');
  await box.locator(':scope > div').first().getByRole('button').click();
  await expect(groupBoxes(page)).toHaveCount(0);
  await expect(ruleCards(page)).toHaveCount(1);
  await expect(ruleCounter(page)).toHaveText('1 of 50 rules');
  await expect(problemLine(page)).toHaveCount(0);
});

test('SEG-051 top-level match all or any', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg051');
  const pid = p.project.id;
  const people = await seedAudiencePeople(p, clientIp);
  await createSegment(p.owner, pid, clientIp, {
    name: 'SEG-051 all',
    definition: group([behaviour('purchase'), attribute('country', 'eq', 'US')]),
    evaluationMode: 'live',
  });
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await audienceName(page).fill('SEG-051 any');
  await chooseEvent(page);
  const profile = await addProfileRule(page);

  const all = previewResponse(page, (d) => d.children[1]?.value === 'US');
  await profile.getByPlaceholder('value', { exact: true }).fill('US');
  const allResponse = await all;
  expect(previewBody(allResponse).operator).toBe('and');
  // Alice bought but is in IN; bob is in US but bought 40 days ago.
  expect(await allResponse.json()).toEqual({ data: { count: 0 } });

  const any = previewResponse(page, (d) => d.operator === 'or');
  await choose(cardTitled(page, 'Rules').locator('[data-slot="card-header"]').getByRole('combobox'), 'any of');
  const anyResponse = await any;
  expect(await anyResponse.json()).toEqual({ data: { count: 2 } });
  await expect(countFigure(page)).toHaveText('2');
  expect(await sortedMembers(p.owner, pid, clientIp, previewBody(anyResponse))).toEqual([people.alice, people.bob].sort());

  await page.getByRole('button', { name: 'Create audience' }).click();
  await expect(toastTitled(page, 'Audience created')).toBeVisible();
  await openAudiences(page, pid);
  await expect(rowNamed(page, 'SEG-051 any').getByRole('cell').nth(1)).toHaveText('1 event + 1 profile · any');
  await expect(rowNamed(page, 'SEG-051 all').getByRole('cell').nth(1)).toHaveText('1 event + 1 profile · all');
});

test('SEG-052 an audience with no rules is not saved', async ({ page, clientIp }) => {
  const NO_RULES = 'Add at least one rule to define who is in this audience.';
  const p = await segProject(clientIp, 'seg052');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openEditor(page, pid);
  const posts = recordRequests(page, 'POST', `/api/projects/${pid}/segments`);
  await audienceName(page).fill('SEG-052 empty');
  await removeDefaultRule(page);

  await expect(page.getByText('No rules yet — this audience would match nobody.', { exact: true })).toBeVisible();
  await expect(problemLine(page)).toHaveText(NO_RULES);
  await expect(ruleCounter(page)).toHaveText('0 of 50 rules');
  await page.getByRole('button', { name: 'Create audience' }).click();
  const toast = toastTitled(page, 'This audience is not ready');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(NO_RULES);
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
  await expect(page).toHaveURL(new RegExp(`/segments/new$`));
});

test('SEG-053 the rule limit of 50', async ({ page, clientIp }) => {
  test.slow();
  const p = await projectWithPurchase(clientIp, 'seg053');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await audienceName(page).fill('SEG-053 fifty');
  await chooseEvent(page);

  const add = page.getByRole('button', { name: 'Profile', exact: true });
  const values = page.getByPlaceholder('value', { exact: true });
  for (let i = 0; i < 49; i += 1) {
    await add.click();
    await values.nth(i).fill('IN');
  }
  await expect(ruleCounter(page)).toHaveText('50 of 50 rules');
  await expect(problemLine(page)).toHaveCount(0);
  await expect(countCaption(page)).toHaveText('people match');

  const LIMIT = 'This audience has 51 rules. The limit is 50 — try splitting it into two audiences.';
  await add.click();
  await expect(ruleCounter(page)).toHaveText('51 of 50 rules');
  await expect(problemLine(page)).toHaveText(LIMIT);
  await expect(countFigure(page)).toHaveText('—');
  await expect(add).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Event', exact: true })).toBeEnabled();

  await ruleBin(ruleCards(page).last()).click();
  await expect(ruleCounter(page)).toHaveText('50 of 50 rules');
  await expect(problemLine(page)).toHaveCount(0);
  const [request] = await Promise.all([page.waitForRequest(isSegmentsPost(pid)), page.getByRole('button', { name: 'Create audience' }).click()]);
  expect(request.postDataJSON().definition.children).toHaveLength(50);
  await expect(toastTitled(page, 'Audience created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/[0-9a-f-]{36}$`));
});

test('SEG-054 a name is required', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg054');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await chooseEvent(page);
  const posts = recordRequests(page, 'POST', `/api/projects/${pid}/segments`);
  const create = page.getByRole('button', { name: 'Create audience' });
  const toast = toastTitled(page, 'Give this audience a name');

  await create.click();
  await expect(toast).toHaveCount(1);
  await audienceName(page).fill('   ');
  await create.click();
  await expect(toast).toHaveCount(2);
  expect(posts).toEqual([]);

  // Positive control: with a name the same form is sent, and it is the only create
  // the page ever sent (a refused click would have sent its own first).
  await audienceName(page).fill('SEG-054 named');
  await Promise.all([page.waitForRequest(isSegmentsPost(pid)), create.click()]);
  await expect(toastTitled(page, 'Audience created')).toBeVisible();
  expect(posts).toHaveLength(1);
});

test('SEG-056 a materialised audience and its refresh interval', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg056');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await audienceName(page).fill('SEG-056 stored');
  await chooseEvent(page);

  const kept = cardTitled(page, 'How it is kept up to date');
  await expect(kept.getByText('Refresh every')).toHaveCount(0);
  await choose(kept.getByRole('combobox').nth(0), 'Materialised');
  await expect(kept.getByText('Refresh every', { exact: true })).toBeVisible();
  const refresh = kept.locator('input[type="number"]');
  await expect(refresh).toHaveValue('60');
  await expect(kept.getByText('minutes', { exact: true })).toBeVisible();
  await expect(
    kept.getByText('A materialised audience has no membership until its first refresh run, so it cannot be read straight away.', { exact: true }),
  ).toBeVisible();

  await refresh.fill('30');
  const [request] = await Promise.all([page.waitForRequest(isSegmentsPost(pid)), page.getByRole('button', { name: 'Create audience' }).click()]);
  expect(request.postDataJSON()).toMatchObject({ evaluationMode: 'materialized', refreshIntervalMinutes: 30 });
  await expect(toastTitled(page, 'Audience created')).toBeVisible();

  await openAudiences(page, pid);
  const cells = rowNamed(page, 'SEG-056 stored').getByRole('cell');
  await expect(cells.nth(2)).toHaveText('Every 30m');
  await expect(cells.nth(3)).toHaveText('not yet refreshed');
});

test('SEG-057 the refresh interval must be 5 to 1440 whole minutes', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg057');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await audienceName(page).fill('SEG-057 interval');
  await chooseEvent(page);
  const kept = cardTitled(page, 'How it is kept up to date');
  await choose(kept.getByRole('combobox').nth(0), 'Materialised');
  const refresh = kept.locator('input[type="number"]');
  const create = page.getByRole('button', { name: 'Create audience' });
  const posts = recordRequests(page, 'POST', `/api/projects/${pid}/segments`);
  const toast = toastTitled(page, 'Check the refresh interval');

  let shown = 0;
  for (const bad of ['4', '1441', '2.5', '']) {
    await refresh.fill(bad);
    await create.click();
    shown += 1;
    await expect(toast, `refresh "${bad}"`).toHaveCount(shown);
  }
  await expect(toast).toHaveText(Array(shown).fill(/It must be a whole number of minutes between 5 and 1440\./));
  expect(posts).toEqual([]);

  await refresh.fill('5');
  const [request] = await Promise.all([page.waitForRequest(isSegmentsPost(pid)), create.click()]);
  expect(request.postDataJSON().refreshIntervalMinutes).toBe(5);
  // The refused clicks sent nothing before this one.
  expect(posts).toHaveLength(1);
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/[0-9a-f-]{36}$`));
  const id = new URL(page.url()).pathname.split('/').pop()!;

  await refresh.fill('1440');
  const [patch] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/segments/${id}`)),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  expect(patch.postDataJSON().refreshIntervalMinutes).toBe(1440);
  await expect(toastTitled(page, 'Audience saved')).toBeVisible();
  expect(await segmentRow(id)).toMatchObject({ refresh_interval_minutes: 1440, evaluation_mode: 'materialized' });
});

test('SEG-059 an audience saved as a draft', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg059');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await audienceName(page).fill('SEG-059 draft');
  await chooseEvent(page);
  await choose(cardTitled(page, 'How it is kept up to date').getByRole('combobox').nth(1), 'Draft');

  const [request] = await Promise.all([page.waitForRequest(isSegmentsPost(pid)), page.getByRole('button', { name: 'Create audience' }).click()]);
  expect(request.postDataJSON().status).toBe('draft');
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/[0-9a-f-]{36}$`));
  const id = new URL(page.url()).pathname.split('/').pop()!;
  expect(await segmentRow(id)).toMatchObject({ status: 'draft' });

  await openAudiences(page, pid);
  await expect(rowNamed(page, 'SEG-059 draft').locator('[data-slot="badge"]')).toHaveText('Draft');
});

test('SEG-061 a server refusal on save is shown', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg061');
  const pid = p.project.id;
  let refusal: unknown = { statusCode: 400, message: ['name must be a string', 'definition must be an object'], error: 'Bad Request' };
  await page.route(
    (url) => url.pathname === `/api/projects/${pid}/segments`,
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify(refusal) });
    },
  );
  await signIn(page, p.owner);
  await openEditor(page, pid);
  await audienceName(page).fill('SEG-061 refused');
  await chooseEvent(page);
  const create = page.getByRole('button', { name: 'Create audience' });

  await create.click();
  const first = toastTitled(page, 'Could not save');
  await expect(first).toHaveCount(1);
  await expect(first).toContainText('name must be a string, definition must be an object');

  refusal = { statusCode: 400, message: 'root.children[0]: behaviour rule requires an eventName', error: 'Bad Request' };
  await create.click();
  await expect(toastTitled(page, 'Could not save')).toHaveCount(2);
  await expect(toastTitled(page, 'Could not save').filter({ hasText: 'root.children[0]: behaviour rule requires an eventName' })).toHaveCount(1);

  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/new$`));
  await expect(audienceName(page)).toHaveValue('SEG-061 refused');
  await expect(eventSelect(page, 'purchase')).toHaveCount(1);
  expect(await sql(`SELECT id FROM segments WHERE project_id = $1`, [pid])).toEqual([]);
});

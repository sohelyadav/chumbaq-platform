import { randomUUID } from 'crypto';
import type { Locator, Page, Request } from '@playwright/test';
import { createAccount, createProject, newClientIp } from '../../support/api';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addDevice,
  addStepButton,
  ageRefresh,
  allActivity,
  attribute,
  audienceDescription,
  audienceName,
  behaviour,
  branchSelects,
  cardTitled,
  choose,
  countCaption,
  createJourney,
  createSegment,
  eventSelect,
  group,
  groupBoxes,
  holdRequests,
  insertEvent,
  insertRun,
  insertRuns,
  journeyActionBar,
  journeyDescription,
  journeyEventName,
  journeyName,
  journeyRow,
  memberRows,
  messageOf,
  previewResponse,
  raw,
  recordRequests,
  refreshThroughScheduler,
  rowNamed,
  ruleCards,
  runsOf,
  segmentRow,
  segProject,
  seedAudiencePeople,
  selectOptions,
  setJourneyStatus,
  sql,
  stepButtons,
  stepCard,
  toastTitled,
  trackEvent,
  uniqueId,
  type Node,
  type SegProject,
} from '../../support/areas/seg';

/**
 * Audiences and journeys, P1 (second chunk): an audience loaded into the editor and
 * saved again, an error cleared by a status change, unknown ids; audience members
 * through the API; the audiences API's defaults, field and definition validation and
 * preview; the worker's refresh of materialised audiences; the journeys list (empty,
 * failed, rows, a refused delete, people counts); and the journey editor (defaults,
 * the action bar, saving twice, a segment trigger, each step type, steps a branch
 * leads to, server refusals, a saved journey loading, editing a paused one, unknown
 * ids). People arrive through the SDK's identify route; events are written to
 * user_events so they can be back-dated.
 */

test.describe.configure({ mode: 'parallel' });

const KNOWN_COUNTRY = group([attribute('country', 'exists')]);
const SAVES_AS_DRAFT = 'Saves as a draft — nobody is enrolled until you activate it.';
const EDIT_DEFAULT = 'People already part-way through will resume against the edited steps.';
const SEGMENT_FOREIGN = 'A segment in this journey does not belong to this project.';
const DELETE_ACTIVE = 'Pause this journey before deleting it — it is live and still enrolling people.';
const JOURNEY_NOT_FOUND = 'Journey not found for this project';

function as(p: SegProject, ip: string) {
  return { ip, token: p.owner.accessToken };
}

/** A fresh client address per request, for the table-driven API cases (100 a minute each). */
function asFresh(p: SegProject) {
  return { ip: newClientIp(), token: p.owner.accessToken };
}

async function openAudiences(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/segments`);
  await expect(page.getByRole('heading', { name: 'Audiences', exact: true })).toBeVisible();
}

async function openJourneys(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/journeys`);
  await expect(page.getByRole('heading', { name: 'Journeys', exact: true })).toBeVisible();
}

async function openJourney(page: Page, projectId: string, journeyId: string, name: string): Promise<void> {
  await page.goto(`/projects/${projectId}/journeys/${journeyId}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

/** The new-journey page with a name and an event trigger, so the action bar is down to the steps. */
async function newJourneyNamed(page: Page, projectId: string, name = 'Steps check'): Promise<void> {
  await page.goto(`/projects/${projectId}/journeys/new`);
  await expect(page.getByRole('heading', { name: 'New journey', exact: true })).toBeVisible();
  await journeyName(page).fill(name);
  await journeyEventName(page).fill('signup');
}

/** A project with a person who did `purchase`, so the event picker has an entry. */
async function projectWithPurchase(ip: string, label: string): Promise<SegProject> {
  const p = await segProject(ip, label);
  const device = await addDevice(p, ip, { externalUserId: uniqueId('u-buyer') });
  await insertEvent(p.project.id, device, 'purchase', { amount: 10 }, 2);
  return p;
}

function isJourneysPost(pid: string) {
  return (request: Request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/projects/${pid}/journeys`;
}

function notMaterialised(id: string, name: string): string {
  return `Segment ${id} ("${name}") has not been materialized yet, so it has no membership to read. Wait for the next refresh run, or switch it to live evaluation.`;
}

/** The journeys list's People cell of a row. */
function peopleCell(page: Page, name: string): Locator {
  return rowNamed(page, name).getByRole('cell').nth(4);
}

// ---- Audience editor: edit

test('SEG-063 a saved audience loads into the editor as saved', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg063');
  const pid = p.project.id;
  // The definition the editor writes for those rules (lib/segment-form.ts toDefinition).
  const definition = group(
    [
      behaviour('purchase', { occurrence: 'at_most', count: 2, withinDays: 14, where: [{ property: 'amount', op: 'gte', value: 10 }] }),
      attribute('country', 'in', ['IN', 'US']),
      group([attribute('emailOptIn', 'eq', false)], 'and'),
    ],
    'or',
  );
  const mixed = await createSegment(p.owner, pid, clientIp, {
    name: 'Mixed',
    description: 'desc',
    definition,
    evaluationMode: 'materialized',
    refreshIntervalMinutes: 15,
    status: 'draft',
  });

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  const counted = previewResponse(page);
  await rowNamed(page, 'Mixed').getByRole('link', { name: 'Mixed', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/${mixed.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Mixed', exact: true })).toBeVisible();
  await expect(audienceName(page)).toHaveValue('Mixed');
  await expect(audienceDescription(page)).toHaveValue('desc');

  const rulesHeader = cardTitled(page, 'Rules').locator('[data-slot="card-header"]');
  await expect(rulesHeader.getByRole('combobox')).toHaveText('any of');
  await expect(ruleCards(page)).toHaveCount(3);

  const event = ruleCards(page).nth(0);
  await expect(event).toContainText('Did');
  await expect(eventSelect(event, 'purchase')).toHaveCount(1);
  await expect(event.getByRole('combobox').nth(1)).toHaveText('at most');
  await expect(event.locator('input[type="number"]').nth(0)).toHaveValue('2');
  await expect(event.getByText('times', { exact: true })).toBeVisible();
  await expect(event.locator('input[type="number"]').nth(1)).toHaveValue('14');
  await expect(event.getByPlaceholder('property name')).toHaveValue('amount');
  await expect(event.getByRole('combobox').nth(2)).toHaveText('is at least');
  await expect(event.getByPlaceholder('value')).toHaveValue('10');

  const country = ruleCards(page).nth(1);
  await expect(country.getByRole('combobox').nth(0)).toHaveText('Country');
  await expect(country.getByRole('combobox').nth(1)).toHaveText('is one of');
  await expect(country.getByRole('textbox')).toHaveValue('IN, US');

  await expect(groupBoxes(page)).toHaveCount(1);
  const box = groupBoxes(page).first();
  await expect(box.getByRole('combobox').first()).toHaveText('all of');
  const optIn = ruleCards(box);
  await expect(optIn).toHaveCount(1);
  await expect(optIn.getByRole('combobox').nth(0)).toHaveText('Email opt-in');
  await expect(optIn.getByRole('combobox').nth(1)).toHaveText('is');
  await expect(optIn.getByRole('combobox').nth(2)).toHaveText('No');

  const kept = cardTitled(page, 'How it is kept up to date');
  await expect(kept.getByRole('combobox').nth(0)).toHaveText('Materialised');
  await expect(kept.locator('input[type="number"]')).toHaveValue('15');
  await expect(kept.getByRole('combobox').nth(1)).toHaveText('Draft');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

  // A count is fetched for exactly the stored definition.
  const response = await counted;
  expect(response.request().postDataJSON().definition).toEqual(definition);
  await expect(countCaption(page)).toHaveText('people match');
});

test('SEG-064 editing and saving an audience', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg064');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, {
    name: 'VIP',
    definition: group([behaviour('purchase')]),
    evaluationMode: 'live',
    status: 'active',
  });

  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/segments/${vip.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'VIP', exact: true })).toBeVisible();
  await audienceName(page).fill('VIP buyers');
  await page.locator('input[type="number"][max="365"]').fill('60');

  const [patch] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/projects/${pid}/segments/${vip.id}`),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  // The whole form, with the empty description left out.
  expect(patch.postDataJSON()).toEqual({
    name: 'VIP buyers',
    definition: { type: 'group', operator: 'and', children: [{ type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 1, withinDays: 60 }] },
    evaluationMode: 'live',
    refreshIntervalMinutes: 60,
    status: 'active',
  });
  await expect(toastTitled(page, 'Audience saved')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/${vip.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'VIP buyers', exact: true })).toBeVisible();
  expect(await segmentRow(vip.id)).toMatchObject({ name: 'VIP buyers', description: null });

  await openAudiences(page, pid);
  await expect(rowNamed(page, 'VIP buyers')).toHaveCount(1);
  await expect(rowNamed(page, 'VIP')).toHaveCount(0);
});

test('SEG-067 a status change clears a stored error', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg067');
  const pid = p.project.id;
  const segment = await createSegment(p.owner, pid, clientIp, {
    name: 'SEG-067 failing',
    definition: KNOWN_COUNTRY,
    evaluationMode: 'materialized',
    status: 'active',
  });
  await sql(`UPDATE segments SET status = 'error', error_message = 'canceling statement due to statement timeout' WHERE id = $1`, [segment.id]);

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await expect(rowNamed(page, 'SEG-067 failing').locator('[data-slot="badge"]')).toHaveText('Error');
  await expect(rowNamed(page, 'SEG-067 failing').locator('svg.text-destructive')).toHaveCount(1);

  const response = await raw('PATCH', `/api/projects/${pid}/segments/${segment.id}`, { status: 'active' }, as(p, clientIp));
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ status: 'active', errorMessage: null });
  expect(await segmentRow(segment.id)).toMatchObject({ status: 'active', error_message: null });

  await page.reload();
  await expect(rowNamed(page, 'SEG-067 failing').locator('[data-slot="badge"]')).toHaveText('Active');
  await expect(rowNamed(page, 'SEG-067 failing').locator('svg.text-destructive')).toHaveCount(0);
});

// Asserts the behaviour the case records for today: the editor has no not-found state.
test('SEG-071 an unknown or another project’s audience id opens a blank editor', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg071');
  const pid = p.project.id;
  const x = await createAccount(clientIp, 'seg071-x');
  const p2 = await createProject(x, clientIp, 'SEG-071 P2');
  const foreign = await createSegment(x, p2.id, clientIp, { name: 'SEG-071 foreign audience', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });

  for (const id of [randomUUID(), foreign.id]) {
    const api = await raw('GET', `/api/projects/${pid}/segments/${id}`, undefined, as(p, clientIp));
    expect(api.status).toBe(404);
    expect(messageOf(api)).toBe(`Segment ${id} not found`);
  }

  await signIn(page, p.owner);
  for (const id of [randomUUID(), foreign.id]) {
    await page.goto(`/projects/${pid}/segments/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Audience', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('No rules yet — this audience would match nobody.', { exact: true })).toBeVisible();
    await expect(audienceName(page)).toHaveValue('');
    await expect(page.getByText('SEG-071 foreign audience')).toHaveCount(0);

    await audienceName(page).fill('SEG-071 typed');
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await ruleCards(page).first().getByPlaceholder('value').fill('IN');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const refused = toastTitled(page, 'Could not save');
    await expect(refused).toBeVisible();
    await expect(refused).toContainText(`Segment ${id} not found`);
    await expect(page.getByText('SEG-071 foreign audience')).toHaveCount(0);
  }
  expect(await segmentRow(foreign.id)).toMatchObject({ name: 'SEG-071 foreign audience', project_id: p2.id });
  expect(await sql(`SELECT id FROM segments WHERE project_id = $1`, [pid])).toEqual([]);
});

// ---- Audience members

test('SEG-075 members of a live audience, paged', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg075');
  const pid = p.project.id;
  const cast = await seedAudiencePeople(p, clientIp);
  const known = await createSegment(p.owner, pid, clientIp, { name: 'Known country', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const expected = [cast.alice, cast.bob, cast.dnt].sort();

  const base = `/api/projects/${pid}/segments/${known.id}/members`;
  const first = await raw('GET', `${base}?limit=2`, undefined, as(p, clientIp));
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ personKeys: expected.slice(0, 2), nextCursor: expected[1] });

  const second = await raw('GET', `${base}?limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor)}`, undefined, as(p, clientIp));
  expect(second.status).toBe(200);
  expect(second.body.data).toEqual({ personKeys: expected.slice(2), nextCursor: null });
  expect(second.body.data.personKeys).not.toContain(cast.anon);
});

test('SEG-078 members of a materialised audience after a refresh', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg078');
  const pid = p.project.id;
  const cast = await seedAudiencePeople(p, clientIp);
  const segment = await createSegment(p.owner, pid, clientIp, {
    name: 'SEG-078 known country',
    definition: KNOWN_COUNTRY,
    evaluationMode: 'materialized',
    refreshIntervalMinutes: 60,
    status: 'active',
  });
  const before = await raw('GET', `/api/projects/${pid}/segments/${segment.id}/members`, undefined, as(p, clientIp));
  expect(before.status).toBe(400);

  await refreshThroughScheduler(segment.id);

  const members = await raw('GET', `/api/projects/${pid}/segments/${segment.id}/members`, undefined, as(p, clientIp));
  expect(members.status).toBe(200);
  expect(members.body.data).toEqual({ personKeys: [cast.alice, cast.bob, cast.dnt].sort(), nextCursor: null });
  const row = await segmentRow(segment.id);
  expect(row).toMatchObject({ status: 'active', last_member_count: 3, materializing_at: null });
  expect(row?.last_materialized_at).not.toBeNull();

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await expect(rowNamed(page, 'SEG-078 known country').getByRole('cell').nth(3)).toHaveText('3');
});

// ---- Audiences API

test('SEG-080 create defaults', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg080');
  const pid = p.project.id;
  const a = await raw('POST', `/api/projects/${pid}/segments`, { name: 'A', definition: KNOWN_COUNTRY }, as(p, clientIp));
  const b = await raw('POST', `/api/projects/${pid}/segments`, { name: 'B', definition: group([behaviour('purchase')]) }, as(p, clientIp));
  const common = {
    refreshIntervalMinutes: 60,
    status: 'draft',
    description: null,
    errorMessage: null,
    lastMemberCount: null,
    lastMaterializedAt: null,
  };
  for (const response of [a, b]) {
    expect(response.status).toBe(201);
    expect(Object.keys(response.body)).toContain('data');
  }
  expect(a.body.data).toMatchObject({ name: 'A', evaluationMode: 'live', ...common });
  expect(b.body.data).toMatchObject({ name: 'B', evaluationMode: 'materialized', ...common });
});

test('SEG-081 list and get audiences', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg081');
  const pid = p.project.id;
  const older = await createSegment(p.owner, pid, clientIp, { name: 'SEG-081 older', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  const newer = await createSegment(p.owner, pid, clientIp, { name: 'SEG-081 newer', definition: group([behaviour('purchase')]), evaluationMode: 'live' });
  const x = await createAccount(clientIp, 'seg081-x');
  const p2 = await createProject(x, clientIp, 'SEG-081 P2');
  await createSegment(x, p2.id, clientIp, { name: 'SEG-081 elsewhere', definition: KNOWN_COUNTRY, evaluationMode: 'live' });

  const list = await raw('GET', `/api/projects/${pid}/segments`, undefined, as(p, clientIp));
  expect(list.status).toBe(200);
  expect(Array.isArray(list.body.data)).toBe(true);
  expect(list.body).not.toHaveProperty('total');
  expect(list.body.meta?.total).toBeUndefined();
  expect(list.body.data.map((s: { name: string }) => s.name)).toEqual(['SEG-081 newer', 'SEG-081 older']);
  expect(list.body.data.every((s: { projectId: string }) => s.projectId === pid)).toBe(true);

  const one = await raw('GET', `/api/projects/${pid}/segments/${older.id}`, undefined, as(p, clientIp));
  expect(one.status).toBe(200);
  expect(one.body.data).toMatchObject({ id: older.id, name: 'SEG-081 older', definition: KNOWN_COUNTRY });
  expect(newer.id).not.toBe(older.id);
});

test('SEG-082 field validation on create and update', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg082');
  const pid = p.project.id;
  const path = `/api/projects/${pid}/segments`;
  const ok = { name: 'SEG-082', definition: KNOWN_COUNTRY };
  const existing = await createSegment(p.owner, pid, clientIp, { name: 'SEG-082 existing', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  const existingBefore = await segmentRow(existing.id);
  const countRows = async () => (await sql(`SELECT id FROM segments WHERE project_id = $1`, [pid])).length;
  const rowsBefore = await countRows();

  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ['no name', { definition: KNOWN_COUNTRY }, ['name must be a string']],
    ['long name', { ...ok, name: 'n'.repeat(256) }, ['name must be shorter than or equal to 255 characters']],
    ['NaN interval', { ...ok, refreshIntervalMinutes: 'abc' }, [
      'refreshIntervalMinutes must be an integer number',
      'refreshIntervalMinutes must not be less than 5',
      'refreshIntervalMinutes must not be greater than 1440',
    ]],
    ['no definition', { name: 'SEG-082' }, ['definition must be an object']],
    ['text definition', { name: 'SEG-082', definition: 'x' }, ['definition must be an object']],
    ['nightly', { ...ok, evaluationMode: 'nightly' }, ['evaluationMode must be one of the following values: live, materialized']],
    ['interval 4', { ...ok, refreshIntervalMinutes: 4 }, ['refreshIntervalMinutes must not be less than 5']],
    ['interval 1441', { ...ok, refreshIntervalMinutes: 1441 }, ['refreshIntervalMinutes must not be greater than 1440']],
    ['interval 2.5', { ...ok, refreshIntervalMinutes: 2.5 }, ['refreshIntervalMinutes must be an integer number']],
    ['status error', { ...ok, status: 'error' }, ['status must be one of the following values: draft, active']],
    ['status archived', { ...ok, status: 'archived' }, ['status must be one of the following values: draft, active']],
    ['projectId in body', { ...ok, projectId: pid }, ['property projectId should not exist']],
    ['unknown key', { ...ok, foo: 1 }, ['property foo should not exist']],
  ];
  for (const [label, body, messages] of cases) {
    const response = await raw('POST', path, body, asFresh(p));
    expect(response.status, `POST ${label}`).toBe(400);
    expect(response.body.message, `POST ${label}`).toEqual(expect.arrayContaining(messages));
  }
  expect(await countRows()).toBe(rowsBefore);

  // The same checks on PATCH, where every field is optional.
  const patchCases = cases.filter(([label]) => !['no name', 'no definition'].includes(label));
  for (const [label, body, messages] of patchCases) {
    const rest = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'name' && key !== 'definition'));
    const patchBody = label === 'long name' ? { name: body.name } : label === 'text definition' ? { definition: 'x' } : rest;
    const response = await raw('PATCH', `${path}/${existing.id}`, patchBody, asFresh(p));
    expect(response.status, `PATCH ${label}`).toBe(400);
    expect(response.body.message, `PATCH ${label}`).toEqual(expect.arrayContaining(messages));
  }
  expect(await segmentRow(existing.id)).toEqual(existingBefore);

  // Coerced to the declared type, not refused.
  const coerced = await raw('POST', path, { name: 123, description: 5, refreshIntervalMinutes: '30', definition: KNOWN_COUNTRY }, asFresh(p));
  expect(coerced.status).toBe(201);
  const read = await raw('GET', `${path}/${coerced.body.data.id}`, undefined, asFresh(p));
  expect(read.body.data).toMatchObject({ name: '123', description: '5', refreshIntervalMinutes: 30 });
  expect(typeof read.body.data.name).toBe('string');
  expect(typeof read.body.data.description).toBe('string');
  expect(typeof read.body.data.refreshIntervalMinutes).toBe('number');

  const patched = await raw('PATCH', `${path}/${existing.id}`, { description: 7, refreshIntervalMinutes: '45' }, asFresh(p));
  expect(patched.status).toBe(200);
  expect(await segmentRow(existing.id)).toMatchObject({ description: '7', refresh_interval_minutes: 45 });
});

/** `levels` groups wrapped around one leaf: the leaf sits at depth `levels`. */
function nested(levels: number, leaf: Node): Node {
  let node = leaf;
  for (let i = 0; i < levels; i += 1) node = group([node]);
  return node;
}

/** Posts `definition` to create and to preview; answers both responses. */
async function createAndPreview(p: SegProject, definition: unknown) {
  const pid = p.project.id;
  const created = await raw('POST', `/api/projects/${pid}/segments`, { name: uniqueId('def'), definition }, asFresh(p));
  const previewed = await raw('POST', `/api/projects/${pid}/segments/preview`, { definition }, asFresh(p));
  return { created, previewed };
}

async function expectRefused(p: SegProject, definition: unknown, message: string): Promise<void> {
  const { created, previewed } = await createAndPreview(p, definition);
  for (const [route, response] of [['create', created], ['preview', previewed]] as const) {
    expect(response.status, `${route}: ${message}`).toBe(400);
    expect(messageOf(response), route).toBe(message);
  }
}

async function expectAccepted(p: SegProject, definition: unknown, label: string): Promise<void> {
  const { created, previewed } = await createAndPreview(p, definition);
  expect(created.status, `create: ${label}`).toBe(201);
  // The preview is a POST without its own status code, so a count answers 201.
  expect(previewed.status, `preview: ${label}`).toBe(201);
  expect(typeof previewed.body.data.count).toBe('number');
}

test('SEG-083 definition validation: groups and limits', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg083');
  const leaf = attribute('country', 'exists');
  const leaves = (n: number) => Array.from({ length: n }, () => attribute('country', 'exists'));

  await expectRefused(p, { type: 'group', operator: 'xor', children: [leaf] }, 'root: group operator must be "and" or "or"');
  await expectRefused(p, { type: 'group', operator: 'and', children: [] }, 'root: group must have at least one child');
  await expectRefused(p, nested(6, leaf), `root${'.children[0]'.repeat(6)}: segment exceeds maximum depth of 5`);
  await expectAccepted(p, nested(5, leaf), 'leaf at depth 5');
  await expectRefused(p, group(leaves(51)), 'root.children[50]: segment exceeds maximum of 50 rules');
  await expectAccepted(p, group(leaves(50)), '50 rules');
  const filtered = behaviour('purchase', {
    where: [
      { property: 'amount', op: 'gt', value: 1 },
      { property: 'currency', op: 'eq', value: 'INR' },
    ],
  });
  await expectRefused(p, group([...leaves(48), filtered]), 'root.children[48].where[1]: segment exceeds maximum of 50 rules');
  await expectRefused(p, { type: 'group', operator: 'and', children: [null] }, 'root.children[0]: node must be an object');
  await expectRefused(p, group([{ type: 'rule' }]), 'root.children[0]: unknown node type "rule"');
});

test('SEG-084 definition validation: attribute rules', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg084');
  const cases: Array<[Node, string]> = [
    [attribute('email', 'eq', 'a@b.test'), 'unknown attribute field "email"'],
    [attribute('traits.first name', 'eq', 'Asha'), 'unknown attribute field "traits.first name"'],
    [attribute('country', 'like', 'IN'), 'unknown operator "like"'],
    [attribute('country', 'in', []), 'op "in" requires a non-empty array value'],
    [attribute('country', 'in', 'IN'), 'op "in" requires a non-empty array value'],
    [attribute('country', 'eq', null), 'op "eq" requires a value'],
    [attribute('country', 'eq', ['IN']), 'op "eq" does not take an array'],
  ];
  for (const [leaf, message] of cases) await expectRefused(p, group([leaf]), `root.children[0]: ${message}`);
  await expectAccepted(p, group([attribute('country', 'exists', 'anything')]), 'exists with a value');
});

test('SEG-085 definition validation: behaviour rules', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg085');
  const cases: Array<[Node, string]> = [
    [behaviour('  '), 'root.children[0]: behaviour rule requires an eventName'],
    [behaviour('purchase', { occurrence: 'sometimes' }), 'root.children[0]: unknown occurrence "sometimes"'],
    [behaviour('purchase', { count: -1 }), 'root.children[0]: count must be a non-negative integer'],
    [behaviour('purchase', { count: 1.5 }), 'root.children[0]: count must be a non-negative integer'],
    [behaviour('purchase', { withinDays: 0 }), 'root.children[0]: withinDays must be between 1 and 365'],
    [behaviour('purchase', { withinDays: 366 }), 'root.children[0]: withinDays must be between 1 and 365'],
    [behaviour('purchase', { withinDays: 1.5 }), 'root.children[0]: withinDays must be between 1 and 365'],
    [behaviour('purchase', { where: [{ property: 'a b', op: 'eq', value: 1 }] }), 'root.children[0].where[0]: unsafe property name "a b"'],
    [behaviour('purchase', { where: [{ property: 'amount', op: 'between', value: 1 }] }), 'root.children[0].where[0]: unknown operator "between"'],
    [behaviour('purchase', { where: [{ property: 'amount', op: 'gt', value: null }] }), 'root.children[0].where[0]: op "gt" requires a value'],
  ];
  for (const [leaf, message] of cases) await expectRefused(p, group([leaf]), message);
  await expectAccepted(p, group([behaviour('purchase', { where: [{ property: 'amount', op: 'gt', value: 1 }] })]), 'a valid filter');
});

test('SEG-087 preview counts an unsaved definition and writes nothing', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg087');
  const pid = p.project.id;
  await addDevice(p, clientIp, { externalUserId: uniqueId('u-in'), row: { country: 'IN' } });
  await addDevice(p, clientIp, { externalUserId: uniqueId('u-us'), row: { country: 'US' } });
  await addDevice(p, clientIp, { row: { country: null } });
  const activityBefore = await allActivity(pid);

  const response = await raw('POST', `/api/projects/${pid}/segments/preview`, { definition: KNOWN_COUNTRY }, as(p, clientIp));
  expect(response.status).toBe(201);
  expect(response.body.data).toEqual({ count: 2 });
  const inIndia = await raw('POST', `/api/projects/${pid}/segments/preview`, { definition: group([attribute('country', 'eq', 'IN')]) }, as(p, clientIp));
  expect(inIndia.body.data).toEqual({ count: 1 });

  expect(await sql(`SELECT id FROM segments WHERE project_id = $1`, [pid])).toEqual([]);
  expect(await allActivity(pid)).toEqual(activityBefore);
});

test('SEG-092 signed out, or an SDK key, cannot read or preview audiences', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg092');
  const pid = p.project.id;
  await createSegment(p.owner, pid, clientIp, { name: 'SEG-092 audience', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  const calls: Array<[string, string, unknown]> = [
    ['GET', `/api/projects/${pid}/segments`, undefined],
    ['POST', `/api/projects/${pid}/segments/preview`, { definition: KNOWN_COUNTRY }],
  ];
  // Positive control: the owner's token reads both.
  for (const [method, path, body] of calls) {
    expect((await raw(method, path, body, as(p, clientIp))).status).toBeLessThan(300);
  }
  for (const [method, path, body] of calls) {
    const anonymous = await raw(method, path, body, { ip: clientIp });
    expect(anonymous.status, `${method} ${path} anonymous`).toBe(401);
    const sdkKey = await raw(method, path, body, { ip: clientIp, apiKey: p.sdkKey });
    expect(sdkKey.status, `${method} ${path} with the SDK key`).toBe(401);
    const sdkKeyAsBearer = await raw(method, path, body, { ip: clientIp, token: p.sdkKey });
    expect(sdkKeyAsBearer.status, `${method} ${path} with the SDK key as a bearer`).toBe(401);
    expect(JSON.stringify(anonymous.body) + JSON.stringify(sdkKey.body)).not.toContain('SEG-092 audience');
  }
});

// ---- Materialisation (worker)

test('SEG-095 the first refresh of an active materialised audience', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg095');
  const pid = p.project.id;
  const cast = await seedAudiencePeople(p, clientIp);
  const buyers = await createSegment(p.owner, pid, clientIp, {
    name: 'Buyers',
    definition: group([behaviour('purchase', { withinDays: 30 })]),
    evaluationMode: 'materialized',
    refreshIntervalMinutes: 5,
    status: 'active',
  });
  expect(await memberRows(buyers.id)).toEqual([]);

  await refreshThroughScheduler(buyers.id);

  const rows = await memberRows(buyers.id);
  expect(rows.map((row) => row.person_key)).toEqual([cast.alice]);
  expect(rows[0].entered_at).toBeInstanceOf(Date);
  expect(rows[0].materialized_at).toBeInstanceOf(Date);
  const row = await segmentRow(buyers.id);
  expect(row).toMatchObject({ status: 'active', last_member_count: 1, materializing_at: null, error_message: null });
  expect(row?.last_materialized_at).not.toBeNull();

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await expect(rowNamed(page, 'Buyers').getByRole('cell').nth(3)).toHaveText('1');
});

test('SEG-096 a later refresh adds joiners and removes leavers without resetting entry times', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg096');
  const pid = p.project.id;
  const cast = await seedAudiencePeople(p, clientIp);
  const buyers = await createSegment(p.owner, pid, clientIp, {
    name: 'SEG-096 buyers',
    definition: group([behaviour('purchase', { withinDays: 30 })]),
    evaluationMode: 'materialized',
    refreshIntervalMinutes: 5,
    status: 'active',
  });
  let at = await refreshThroughScheduler(buyers.id);
  const [aliceFirst] = await memberRows(buyers.id);
  expect(aliceFirst.person_key).toBe(cast.alice);

  // Bob buys again; the next refresh adds him and leaves alice's entry time alone.
  await trackEvent(p, clientIp, cast.devices.bob, 'purchase');
  await ageRefresh(buyers.id, 10);
  at = await refreshThroughScheduler(buyers.id, new Date(at.getTime() - 10 * 60_000));
  let rows = await memberRows(buyers.id);
  expect(rows.map((row) => row.person_key)).toEqual([cast.alice, cast.bob].sort());
  const alice = rows.find((row) => row.person_key === cast.alice)!;
  const bob = rows.find((row) => row.person_key === cast.bob)!;
  expect(alice.entered_at.getTime()).toBe(aliceFirst.entered_at.getTime());
  expect(alice.materialized_at.getTime()).toBeGreaterThan(aliceFirst.materialized_at.getTime());
  expect(bob.entered_at.getTime()).toBeGreaterThan(aliceFirst.entered_at.getTime());
  expect((await segmentRow(buyers.id))?.last_member_count).toBe(2);

  // Alice's purchases go; the next refresh removes her and keeps bob's entry time.
  await sql(`DELETE FROM user_events WHERE device_identity_id = $1 AND event_name = 'purchase'`, [cast.devices.alice]);
  await ageRefresh(buyers.id, 10);
  await refreshThroughScheduler(buyers.id, new Date(at.getTime() - 10 * 60_000));
  rows = await memberRows(buyers.id);
  expect(rows.map((row) => row.person_key)).toEqual([cast.bob]);
  expect(rows[0].entered_at.getTime()).toBe(bob.entered_at.getTime());
  expect((await segmentRow(buyers.id))?.last_member_count).toBe(1);
});

// ---- Journeys list

test('SEG-100 empty journeys list', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg100');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openJourneys(page, pid);

  await expect(page.getByText('No journeys yet', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'A journey starts when someone does something or joins a segment, then runs them through steps over hours or days — wait, send a push, branch on segment membership, exit.',
      { exact: true },
    ),
  ).toBeVisible();
  const first = page.getByRole('link', { name: 'Create your first journey' });
  await expect(first).toHaveAttribute('href', `/projects/${pid}/journeys/new`);
  await first.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys/new$`));
  await expect(page.getByRole('heading', { name: 'New journey', exact: true })).toBeVisible();

  await openJourneys(page, pid);
  const header = page.getByRole('link', { name: 'New journey', exact: true });
  await expect(header).toHaveAttribute('href', `/projects/${pid}/journeys/new`);
  await header.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys/new$`));
  await expect(page.getByRole('heading', { name: 'New journey', exact: true })).toBeVisible();
});

test('SEG-102 a failed journeys list shows an error card after one retry', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg102');
  const pid = p.project.id;
  await createJourney(p.owner, pid, clientIp, { name: 'SEG-102 hidden' });
  let attempts = 0;
  await page.route(
    (url) => url.pathname === `/api/projects/${pid}/journeys`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      attempts += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) });
    },
  );
  await signIn(page, p.owner);
  await openJourneys(page, pid);

  await expect(page.getByText('Could not load journeys. Try refreshing the page.', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(attempts).toBe(2);
  await expect(page.locator('div.border-destructive\\/40').filter({ hasText: 'Could not load journeys.' })).toHaveCount(1);
  await expect(page.getByText('No journeys yet', { exact: true })).toHaveCount(0);
  await expect(page.getByText('SEG-102 hidden')).toHaveCount(0);
});

test('SEG-103 journey row contents', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg103');
  const pid = p.project.id;
  const lapsed = await createSegment(p.owner, pid, clientIp, { name: 'Lapsed', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const description = `Welcomes new people. ${'A long description that runs on. '.repeat(6)}`.slice(0, 200);
  expect(description).toHaveLength(200);
  await createJourney(p.owner, pid, clientIp, { name: 'Welcome', description, steps: [{ type: 'send_push', title: 'Hi' }] });
  await createJourney(p.owner, pid, clientIp, {
    name: 'Win back',
    trigger: { type: 'segment_entry', segmentId: lapsed.id },
    steps: [{ type: 'wait', durationSeconds: 86_400 }, { type: 'send_push', title: 'We miss you' }, { type: 'exit' }],
  });

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await expect(page.getByRole('columnheader')).toHaveText(['Name', 'Status', 'Trigger', 'Steps', 'People', 'Actions']);

  const welcome = rowNamed(page, 'Welcome').getByRole('cell');
  await expect(welcome.nth(0).getByRole('link', { name: 'Welcome', exact: true })).toHaveAttribute('href', /\/journeys\/[0-9a-f-]{36}$/);
  const line = welcome.nth(0).locator('p');
  await expect(line).toHaveText(description.trim());
  await expect(line).toHaveClass(/truncate/);
  // One line: the paragraph is no taller than its own line height.
  const box = await line.boundingBox();
  expect(box!.height).toBeLessThan(24);
  await expect(welcome.nth(1)).toHaveText('Draft');
  await expect(welcome.nth(2)).toHaveText('When someone does signup');
  await expect(welcome.nth(2).locator('span.font-medium')).toHaveText('signup');
  await expect(welcome.nth(3)).toHaveText('1 step');
  await expect(peopleCell(page, 'Welcome').locator('p').nth(0)).toHaveText('0 inside');
  await expect(peopleCell(page, 'Welcome').locator('p').nth(1)).toHaveText('0 completed · 0 exited');

  const winBack = rowNamed(page, 'Win back').getByRole('cell');
  await expect(winBack.nth(2)).toHaveText('When someone enters Lapsed');
  await expect(winBack.nth(3)).toHaveText('3 steps');
});

test('SEG-114 a delete is refused once another tab has activated the journey', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg114');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'paused');

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await expect(rowNamed(page, 'Welcome').locator('[data-slot="badge"]')).toHaveText('Paused');

  // Another tab activates it; this list still shows it paused.
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await rowNamed(page, 'Welcome').getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete "Welcome"?');
  await dialog.getByRole('button', { name: 'Delete journey' }).click();
  const refused = toastTitled(page, 'Could not delete journey');
  await expect(refused).toBeVisible();
  await expect(refused).toContainText(DELETE_ACTIVE);

  expect(await journeyRow(journey.id)).toMatchObject({ status: 'active', name: 'Welcome' });
  expect(await activityRows(pid, 'content.deleted')).toEqual([]);

  const api = await raw('DELETE', `/api/projects/${pid}/journeys/${journey.id}`, undefined, as(p, clientIp));
  expect(api.status).toBe(400);
  expect(messageOf(api)).toBe(DELETE_ACTIVE);
  expect(await journeyRow(journey.id)).toBeDefined();
});

test('SEG-116 people counts and their refresh', async ({ page, clientIp }) => {
  test.slow();
  const p = await segProject(clientIp, 'seg116');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'SEG-116 counted' });
  await insertRuns(pid, journey.id, 'active', 4);
  await insertRuns(pid, journey.id, 'completed', 2);
  await insertRuns(pid, journey.id, 'exited', 1);

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  const people = peopleCell(page, 'SEG-116 counted');
  await expect(people.locator('p').nth(0)).toHaveText('4 inside');
  await expect(people.locator('p').nth(1)).toHaveText('2 completed · 1 exited');
  await expect(people.locator('.text-destructive')).toHaveCount(0);

  await insertRuns(pid, journey.id, 'failed', 3);
  // Without a reload: the stats query refetches every 30 seconds.
  await expect(people.locator('p').nth(1)).toHaveText('2 completed · 1 exited · 3 failed', { timeout: 40_000 });
  await expect(people.locator('span.text-destructive')).toHaveText('· 3 failed');

  const stats = await raw('GET', `/api/projects/${pid}/journeys/${journey.id}/stats`, undefined, as(p, clientIp));
  expect(stats.body.data).toEqual({ active: 4, completed: 2, exited: 1, failed: 3 });
});

// ---- Journey editor: create

test('SEG-119 create page defaults', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg119');
  const pid = p.project.id;
  await createSegment(p.owner, pid, clientIp, { name: 'Lapsed', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  const asNew = recordRequests(page, 'GET', '/journeys/new');

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await page.getByRole('link', { name: 'New journey', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys/new$`));
  await expect(page.getByRole('heading', { level: 1, name: 'New journey', exact: true })).toBeVisible();
  await expect(page.getByText('Choose what puts someone in, then the steps they move through.', { exact: true })).toBeVisible();

  const basics = cardTitled(page, 'Journey');
  await expect(basics.locator('[data-slot="card-description"]')).toHaveText('What this journey is for.');
  await expect(basics.getByText('Name', { exact: true })).toBeVisible();
  await expect(journeyName(page)).toHaveValue('');
  await expect(basics.getByText('Description', { exact: true })).toBeVisible();
  await expect(journeyDescription(page)).toHaveValue('');

  const trigger = cardTitled(page, 'Trigger');
  await expect(trigger.locator('[data-slot="card-description"]')).toHaveText('What puts someone into this journey.');
  await expect(trigger.getByText('Enter when', { exact: true })).toBeVisible();
  await expect(trigger.getByRole('combobox')).toHaveText('They do something');
  await expect(trigger.getByText('Event name', { exact: true })).toBeVisible();
  await expect(journeyEventName(page)).toHaveValue('');
  await expect(trigger.getByText('Anyone who fires this event enters the journey at step 1.', { exact: true })).toBeVisible();
  expect(await selectOptions(trigger.getByRole('combobox'))).toEqual(['They do something', 'They join a segment']);

  const steps = cardTitled(page, 'Steps');
  await expect(steps.locator('[data-slot="card-description"]')).toHaveText(
    'Run top to bottom. A step with nothing after it ends the journey, and a branch sends each path wherever you point it.',
  );
  await expect(steps.getByText('No steps yet. Add the first one below.', { exact: true })).toBeVisible();
  for (const label of ['Wait', 'Send push', 'Send email', 'Send text', 'Send WhatsApp', 'Branch', 'Exit']) {
    await expect(addStepButton(page, label)).toBeEnabled();
  }

  await expect(journeyActionBar(page)).toHaveText('Name this journey.');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await page.waitForTimeout(500);
  expect(asNew).toEqual([]);
});

test('SEG-120 the action bar names the first problem in order', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg120');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/journeys/new`);
  const bar = journeyActionBar(page);
  const save = page.getByRole('button', { name: 'Save draft' });

  await expect(bar).toHaveText('Name this journey.');
  await expect(save).toBeDisabled();
  await journeyName(page).fill('Order of problems');
  await expect(bar).toHaveText('An event trigger needs an event name.');
  await expect(save).toBeDisabled();
  await journeyEventName(page).fill('signup');
  await expect(bar).toHaveText('A journey needs at least one step.');
  await expect(save).toBeDisabled();
  await addStepButton(page, 'Send push').click();
  await expect(bar).toHaveText('Step 1: a push needs a title.');
  await expect(save).toBeDisabled();
  await stepCard(page, 1).getByPlaceholder('Still thinking it over?').fill('Hello');
  await expect(bar).toHaveText(SAVES_AS_DRAFT);
  await expect(save).toBeEnabled();

  // Clearing the name brings the first problem back, ahead of everything else.
  await journeyName(page).fill('  ');
  await expect(bar).toHaveText('Name this journey.');
  await expect(save).toBeDisabled();
});

test('SEG-122 saving twice from the new page updates, never duplicates', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg122');
  const pid = p.project.id;
  const posts = recordRequests(page, 'POST', `/api/projects/${pid}/journeys`);
  await signIn(page, p.owner);
  await newJourneyNamed(page, pid, 'Cart rescue');
  await addStepButton(page, 'Send push').click();
  const title = stepCard(page, 1).getByPlaceholder('Still thinking it over?');
  await title.fill('Still thinking it over?');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys/[0-9a-f-]{36}$`));
  const journeyId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();

  await title.fill('Your cart misses you');
  const [patch] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/projects/${pid}/journeys/${journeyId}`),
    page.getByRole('button', { name: 'Save changes' }).click(),
  ]);
  expect((patch.postDataJSON() as { steps: Node[] }).steps).toEqual([{ type: 'send_push', title: 'Your cart misses you' }]);
  await expect(toastTitled(page, 'Journey updated')).toBeVisible();
  expect(posts).toEqual([`/api/projects/${pid}/journeys`]);
  expect((await journeyRow(journeyId))?.steps).toEqual([{ type: 'send_push', title: 'Your cart misses you' }]);

  await openJourneys(page, pid);
  await expect(rowNamed(page, 'Cart rescue')).toHaveCount(1);
  expect(await sql(`SELECT id FROM journeys WHERE project_id = $1`, [pid])).toHaveLength(1);
});

test('SEG-124 a segment trigger', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg124');
  const pid = p.project.id;
  const lapsed = await createSegment(p.owner, pid, clientIp, { name: 'Lapsed', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });

  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/journeys/new`);
  await journeyName(page).fill('Win back');
  const trigger = cardTitled(page, 'Trigger');
  await choose(trigger.getByRole('combobox').nth(0), 'They join a segment');
  await expect(trigger.getByText('Segment', { exact: true })).toBeVisible();
  await expect(journeyEventName(page)).toHaveCount(0);
  await expect(trigger.getByText('Anyone who becomes a member of this segment enters the journey at step 1.', { exact: true })).toBeVisible();
  const segmentSelect = trigger.getByRole('combobox').nth(1);
  await expect(segmentSelect).toHaveText('Choose a segment');
  await expect(journeyActionBar(page)).toHaveText('A segment trigger needs a segment.');
  expect(await selectOptions(segmentSelect)).toEqual(expect.arrayContaining(['Lapsed', 'VIP']));

  await choose(segmentSelect, 'Lapsed');
  await expect(journeyActionBar(page)).toHaveText('A journey needs at least one step.');
  await addStepButton(page, 'Wait').click();
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);
  const [request] = await Promise.all([page.waitForRequest(isJourneysPost(pid)), page.getByRole('button', { name: 'Save draft' }).click()]);
  expect(request.postDataJSON().trigger).toEqual({ type: 'segment_entry', segmentId: lapsed.id });
  await expect(toastTitled(page, 'Journey saved as a draft')).toBeVisible();

  await openJourneys(page, pid);
  await expect(rowNamed(page, 'Win back').getByRole('cell').nth(2)).toHaveText('When someone enters Lapsed');
});

test('SEG-126 a wait step and its units', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg126');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await newJourneyNamed(page, pid, 'Waits');
  await addStepButton(page, 'Wait').click();
  const wait = stepCard(page, 1);
  const amount = wait.getByRole('textbox');
  const unit = wait.getByRole('combobox');
  const save = page.getByRole('button', { name: 'Save draft' });
  await expect(wait).toContainText('Wait 1 days');
  await expect(amount).toHaveValue('1');
  await expect(unit).toHaveText('days');
  await expect(wait.getByText('Wait for', { exact: true })).toBeVisible();
  await expect(wait.getByText('Unit', { exact: true })).toBeVisible();
  expect(await selectOptions(unit)).toEqual(['minutes', 'hours', 'days']);

  const tooShort: Array<[string, string, string]> = [
    ['0.5', 'minutes', 'Wait 0.5 minutes'],
    ['0', 'minutes', 'Wait 0 minutes'],
    ['abc', 'minutes', 'Wait abc minutes'],
    ['-1', 'days', 'Wait -1 days'],
    ['', 'minutes', 'Wait 0 minutes'],
  ];
  for (const [typed, unitName, header] of tooShort) {
    if ((await unit.innerText()).trim() !== unitName) await choose(unit, unitName);
    await amount.fill(typed);
    await expect(wait, `"${typed}" ${unitName}`).toContainText(header);
    await expect(journeyActionBar(page), `"${typed}" ${unitName}`).toHaveText('Step 1: a wait must be at least 60 seconds.');
    await expect(save).toBeDisabled();
  }

  await amount.fill('1');
  await choose(unit, 'days');
  for (let i = 0; i < 3; i += 1) await addStepButton(page, 'Wait').click();
  const set = async (n: number, value: string, unitName: string, header: string) => {
    await stepCard(page, n).getByRole('textbox').fill(value);
    await choose(stepCard(page, n).getByRole('combobox'), unitName);
    await expect(stepCard(page, n)).toContainText(header);
  };
  await set(2, '0.5', 'hours', 'Wait 0.5 hours');
  await set(3, '90', 'minutes', 'Wait 90 minutes');
  await set(4, '1.5', 'minutes', 'Wait 1.5 minutes');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);

  const [request] = await Promise.all([page.waitForRequest(isJourneysPost(pid)), save.click()]);
  expect((request.postDataJSON() as { steps: Node[] }).steps).toEqual([
    { type: 'wait', durationSeconds: 86_400 },
    { type: 'wait', durationSeconds: 1800 },
    { type: 'wait', durationSeconds: 5400 },
    { type: 'wait', durationSeconds: 90 },
  ]);
  await expect(toastTitled(page, 'Journey saved as a draft')).toBeVisible();
});

test('SEG-127 a send push step', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg127');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await newJourneyNamed(page, pid, 'Pushes');
  await addStepButton(page, 'Send push').click();
  const push = stepCard(page, 1);
  await expect(push).toContainText('Send push (untitled)');
  await expect(journeyActionBar(page)).toHaveText('Step 1: a push needs a title.');
  for (const label of ['Title', 'Body', 'Image URL', 'Deep link']) await expect(push.getByText(label, { exact: true })).toBeVisible();
  const title = push.getByPlaceholder('Still thinking it over?');
  await expect(title).toHaveAttribute('maxlength', '255');
  const optional = push.getByPlaceholder('Optional');
  await expect(optional).toHaveCount(3);
  await expect(push.locator('textarea')).toHaveAttribute('placeholder', 'Optional');

  const long = `${'Back in stock: '.repeat(20)}`.slice(0, 300);
  expect(long).toHaveLength(300);
  await title.fill(long);
  await expect(title).toHaveValue(long.slice(0, 255));
  await expect(push).toContainText(`Send push "${long.slice(0, 255).trim()}"`);
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);
});

test('SEG-128 a send email step', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg128');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await newJourneyNamed(page, pid, 'Emails');
  await addStepButton(page, 'Send email').click();
  const email = stepCard(page, 1);
  const save = page.getByRole('button', { name: 'Save draft' });
  await expect(email).toContainText('Send email (no subject)');
  await expect(journeyActionBar(page)).toHaveText('Step 1: an email needs a subject.');
  await expect(save).toBeDisabled();
  for (const label of ['Subject', 'Preview text', 'HTML']) await expect(email.getByText(label, { exact: true })).toBeVisible();
  const subject = email.getByPlaceholder('Your cart is waiting, {{firstName|there}}');
  await expect(subject).toHaveAttribute('maxlength', '255');
  const preheader = email.getByPlaceholder('Optional');
  await expect(preheader).toHaveAttribute('maxlength', '255');
  const html = email.getByPlaceholder('<p>Hi {{firstName}}, ...</p>');
  await expect(html).toHaveClass(/font-mono/);
  await expect(email).toContainText(
    "Sent only if the person has an address, consent and no unsubscribe. Anyone who can't be emailed moves on to the next step.",
  );

  await subject.fill('Your cart is waiting');
  await expect(email).toContainText('Send email "Your cart is waiting"');
  await expect(journeyActionBar(page)).toHaveText('Step 1: an email needs a body.');
  await expect(save).toBeDisabled();
  const body = '<p>Hi {{firstName}}</p>\n  ';
  await html.fill(body);
  await preheader.fill('  It is still there  ');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);

  const [request] = await Promise.all([page.waitForRequest(isJourneysPost(pid)), save.click()]);
  const expected = { type: 'send_email', subject: 'Your cart is waiting', html: body, preheader: 'It is still there' };
  expect((request.postDataJSON() as { steps: Node[] }).steps).toEqual([expected]);
  await expect(toastTitled(page, 'Journey saved as a draft')).toBeVisible();
  const [stored] = await sql(`SELECT steps FROM journeys WHERE project_id = $1`, [pid]);
  expect(stored.steps).toEqual([expected]);
});

test('SEG-129 a send text step', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg129');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await newJourneyNamed(page, pid, 'Texts');
  await addStepButton(page, 'Send text').click();
  const sms = stepCard(page, 1);
  await expect(sms).toContainText('Send text (empty)');
  await expect(journeyActionBar(page)).toHaveText('Step 1: a text message needs a body.');
  await expect(sms.getByText('Text', { exact: true })).toBeVisible();
  const text = sms.getByPlaceholder('Hi {{firstName|there}}, your order has shipped.');
  await expect(sms).toContainText(
    "Sent only if the person has a number with a country code, SMS consent and no STOP. Anyone who can't be texted moves on to the next step.",
  );
  const counter = sms.getByText(/segment\(s\) before the opt-out line\.$/);
  await expect(counter).toHaveCount(0);

  const gsm = (n: number) => 'Your order has shipped and is on its way to you now. '.repeat(40).slice(0, n);
  await text.fill(gsm(160));
  await expect(counter).toHaveText('1 segment(s) before the opt-out line.');
  await expect(sms).toContainText(`Send text "${gsm(160).slice(0, 39)}…"`);
  await text.fill(gsm(161));
  await expect(counter).toHaveText('2 segment(s) before the opt-out line.');
  // One emoji switches the whole text to UCS-2: 70 to a segment, 67 per part after that.
  await text.fill('😀');
  await expect(counter).toHaveText('1 segment(s) before the opt-out line.');
  await expect(sms).toContainText('Send text "😀"');
  await text.fill(`${'a'.repeat(69)}😀`);
  await expect(counter).toHaveText('2 segment(s) before the opt-out line.');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);

  await text.fill('b'.repeat(2000));
  await expect(text).toHaveValue('b'.repeat(1600));
  await expect(counter).toHaveText('11 segment(s) before the opt-out line.');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);
});

test('SEG-130 a send WhatsApp step', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg130');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await newJourneyNamed(page, pid, 'WhatsApps');
  await addStepButton(page, 'Send WhatsApp').click();
  const wa = stepCard(page, 1);
  const save = page.getByRole('button', { name: 'Save draft' });
  const template = wa.getByPlaceholder('order_shipped');
  const language = wa.getByPlaceholder('en', { exact: true });
  const values = wa.locator('textarea');
  for (const label of ['Template', 'Language', 'Values, one per line']) await expect(wa.getByText(label, { exact: true })).toBeVisible();
  await expect(language).toHaveValue('en');
  await expect(wa).toContainText('Send WhatsApp (no template)');
  await expect(journeyActionBar(page)).toHaveText('Step 1: a WhatsApp message needs a template.');
  await expect(save).toBeDisabled();
  await expect(wa).toContainText(
    "The template's name for Meta and Interakt, its template ID for Gupshup, or its Content SID (HX…) for Twilio.",
  );

  await template.fill('order_shipped');
  await expect(wa).toContainText('Send WhatsApp "order_shipped"');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);
  await language.fill('english');
  await expect(journeyActionBar(page)).toHaveText('Step 1: the template language is a code such as en or en_US.');
  await expect(save).toBeDisabled();
  await language.fill('en_US');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);
  await language.fill('en');
  await values.fill('Asha\n\n#123\n');

  const [request] = await Promise.all([page.waitForRequest(isJourneysPost(pid)), save.click()]);
  const expected = {
    type: 'send_whatsapp',
    content: { template: { id: 'order_shipped', name: 'order_shipped', language: 'en' }, bodyParams: ['Asha', '#123'] },
  };
  expect((request.postDataJSON() as { steps: Node[] }).steps).toEqual([expected]);
  await expect(toastTitled(page, 'Journey saved as a draft')).toBeVisible();
  const [stored] = await sql(`SELECT steps FROM journeys WHERE project_id = $1`, [pid]);
  expect(stored.steps).toEqual([expected]);
});

test('SEG-134 a step a branch leads to cannot be deleted', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg134');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const offers = (ifMember: number, ifNot: number) => [
    { type: 'wait', durationSeconds: 86_400 },
    { type: 'branch', segmentId: vip.id, ifMember, ifNot },
    { type: 'send_push', title: 'VIP offer' },
    { type: 'send_push', title: 'Standard offer' },
    { type: 'exit' },
  ];
  const split = await createJourney(p.owner, pid, clientIp, { name: 'SEG-134 split', steps: offers(2, 3) });
  const both = await createJourney(p.owner, pid, clientIp, { name: 'SEG-134 both', steps: offers(2, 2) });

  await signIn(page, p.owner);
  await openJourney(page, pid, split.id, 'SEG-134 split');
  await stepButtons(stepCard(page, 3)).remove.click();
  const one = toastTitled(page, 'Repoint these branches first');
  await expect(one).toBeVisible();
  await expect(one).toContainText("Step 2's member path leads to this step. Send them somewhere else, then delete it.");
  await expect(stepCard(page, 3)).toContainText('Send push "VIP offer"');
  await expect(stepCard(page, 5)).toContainText('Exit the journey');

  // A step no branch names goes, and the rest are renumbered.
  await stepButtons(stepCard(page, 1)).remove.click();
  await expect(stepCard(page, 5)).toHaveCount(0);
  await expect(stepCard(page, 1)).toContainText('If in "VIP"');
  await expect(stepCard(page, 2)).toContainText('Send push "VIP offer"');
  await expect(stepCard(page, 4)).toContainText('Exit the journey');
  await expect(branchSelects(stepCard(page, 1)).member).toHaveText('2. Send push "VIP offer"');

  await openJourney(page, pid, both.id, 'SEG-134 both');
  await stepButtons(stepCard(page, 3)).remove.click();
  const two = toastTitled(page, 'Repoint these branches first').filter({ hasText: 'non-member' });
  await expect(two).toBeVisible();
  await expect(two).toContainText(
    "Step 2's member path and step 2's non-member path lead to this step. Send them somewhere else, then delete it.",
  );
  await expect(stepCard(page, 3)).toContainText('Send push "VIP offer"');
  await expect(stepCard(page, 5)).toContainText('Exit the journey');
});

test('SEG-138 a server refusal on save is shown', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg138');
  const pid = p.project.id;
  const lapsed = await createSegment(p.owner, pid, clientIp, { name: 'Lapsed', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Win back', trigger: { type: 'segment_entry', segmentId: lapsed.id } });

  await signIn(page, p.owner);
  await openJourney(page, pid, journey.id, 'Win back');
  await expect(cardTitled(page, 'Trigger').getByRole('combobox').nth(1)).toHaveText('Lapsed');
  // Another tab deletes the audience while this editor is open.
  expect((await raw('DELETE', `/api/projects/${pid}/segments/${lapsed.id}`, undefined, as(p, clientIp))).status).toBe(200);

  const save = page.getByRole('button', { name: 'Save changes' });
  await save.click();
  const refused = toastTitled(page, 'Could not save journey');
  await expect(refused).toBeVisible();
  await expect(refused).toContainText(SEGMENT_FOREIGN);
  expect((await journeyRow(journey.id))?.trigger).toEqual({ type: 'segment_entry', segmentId: lapsed.id });

  await page.route(
    (url) => url.pathname === `/api/projects/${pid}/journeys/${journey.id}`,
    async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 400, message: ['name must be a string', 'steps must be an array'], error: 'Bad Request' }),
      });
    },
  );
  await save.click();
  const joined = toastTitled(page, 'Could not save journey').filter({ hasText: 'name must be a string steps must be an array' });
  await expect(joined).toHaveCount(1);
});

// ---- Journey editor: edit

test('SEG-140 a saved journey loads into the editor as saved', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg140');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'SEG-140 everything',
    description: 'Every kind of step',
    trigger: { type: 'event', eventName: 'cart_abandoned' },
    steps: [
      { type: 'wait', durationSeconds: 259_200 },
      { type: 'wait', durationSeconds: 7200 },
      { type: 'wait', durationSeconds: 5400 },
      { type: 'wait', durationSeconds: 90 },
      { type: 'send_push', title: 'Come back', body: 'We kept your cart', imageUrl: 'https://cdn.example.test/cart.png', deepLinkUrl: 'myapp://cart' },
      { type: 'send_email', subject: 'Your cart', html: '<p>Hi {{firstName}}</p>', preheader: 'Still there' },
      { type: 'send_sms', body: 'Your cart is waiting' },
      { type: 'send_whatsapp', content: { template: { id: 'cart_reminder', name: 'cart_reminder', language: 'en_US' }, bodyParams: ['Asha', '#123'] } },
      { type: 'branch', segmentId: vip.id, ifMember: 0, ifNot: 9 },
      { type: 'exit' },
    ],
  });

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await rowNamed(page, 'SEG-140 everything').getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys/${journey.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'SEG-140 everything', exact: true })).toBeVisible();
  await expect(journeyName(page)).toHaveValue('SEG-140 everything');
  await expect(journeyDescription(page)).toHaveValue('Every kind of step');
  await expect(cardTitled(page, 'Trigger').getByRole('combobox')).toHaveText('They do something');
  await expect(journeyEventName(page)).toHaveValue('cart_abandoned');

  const waits: Array<[number, string, string]> = [[1, '3', 'days'], [2, '2', 'hours'], [3, '90', 'minutes'], [4, '1.5', 'minutes']];
  for (const [n, amount, unit] of waits) {
    await expect(stepCard(page, n)).toContainText(`Wait ${amount} ${unit}`);
    await expect(stepCard(page, n).getByRole('textbox')).toHaveValue(amount);
    await expect(stepCard(page, n).getByRole('combobox')).toHaveText(unit);
  }
  const push = stepCard(page, 5);
  await expect(push.getByPlaceholder('Still thinking it over?')).toHaveValue('Come back');
  await expect(push.getByPlaceholder('Optional').nth(0)).toHaveValue('We kept your cart');
  await expect(push.getByPlaceholder('Optional').nth(1)).toHaveValue('https://cdn.example.test/cart.png');
  await expect(push.getByPlaceholder('Optional').nth(2)).toHaveValue('myapp://cart');
  const email = stepCard(page, 6);
  await expect(email.getByPlaceholder('Your cart is waiting, {{firstName|there}}')).toHaveValue('Your cart');
  await expect(email.getByPlaceholder('Optional')).toHaveValue('Still there');
  await expect(email.getByPlaceholder('<p>Hi {{firstName}}, ...</p>')).toHaveValue('<p>Hi {{firstName}}</p>');
  await expect(stepCard(page, 7).locator('textarea')).toHaveValue('Your cart is waiting');
  const wa = stepCard(page, 8);
  await expect(wa.getByPlaceholder('order_shipped')).toHaveValue('cart_reminder');
  await expect(wa.getByPlaceholder('en', { exact: true })).toHaveValue('en_US');
  await expect(wa.locator('textarea')).toHaveValue('Asha\n#123');
  const branch = branchSelects(stepCard(page, 9));
  await expect(stepCard(page, 9)).toContainText('If in "VIP"');
  await expect(branch.segment).toHaveText('VIP');
  await expect(branch.member).toHaveText('1. Wait 3 days');
  await expect(branch.nonMember).toHaveText('10. Exit the journey');
  await expect(stepCard(page, 10)).toContainText('Exit the journey');

  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await expect(journeyActionBar(page)).toHaveText(EDIT_DEFAULT);
});

test('SEG-141 editing a paused journey with people inside', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg141');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'SEG-141 paused' });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'paused');
  const run = await insertRun(pid, journey.id, uniqueId('u-inside'), { stepIndex: 1, dueInSeconds: 3600 });
  const activityBefore = await allActivity(pid);

  await signIn(page, p.owner);
  await openJourney(page, pid, journey.id, 'SEG-141 paused');
  await expect(page.locator('fieldset[disabled]')).toHaveCount(0);
  await stepCard(page, 2).getByPlaceholder('Still thinking it over?').fill('Hi again');
  const [patch] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/projects/${pid}/journeys/${journey.id}`),
    page.getByRole('button', { name: 'Save changes' }).click(),
  ]);
  expect(patch.postDataJSON()).toEqual({
    name: 'SEG-141 paused',
    description: null,
    trigger: { type: 'event', eventName: 'signup' },
    steps: [{ type: 'wait', durationSeconds: 86_400 }, { type: 'send_push', title: 'Hi again' }],
  });
  await expect(toastTitled(page, 'Journey updated')).toBeVisible();

  const stored = await journeyRow(journey.id);
  expect(stored).toMatchObject({ status: 'paused', steps: [{ type: 'wait', durationSeconds: 86_400 }, { type: 'send_push', title: 'Hi again' }] });
  expect(await allActivity(pid)).toEqual(activityBefore);
  const [after] = await runsOf(journey.id);
  expect(after).toMatchObject({ id: run.id, status: 'active', current_step_index: 1 });
});

test('SEG-144 a journey that is not found', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg144');
  const pid = p.project.id;
  const x = await createAccount(clientIp, 'seg144-x');
  const p2 = await createProject(x, clientIp, 'SEG-144 P2');
  const foreign = await createJourney(x, p2.id, clientIp, { name: 'SEG-144 foreign journey' });
  const missing = randomUUID();

  for (const id of [missing, foreign.id]) {
    const response = await raw('GET', `/api/projects/${pid}/journeys/${id}`, undefined, as(p, clientIp));
    expect(response.status).toBe(404);
    expect(messageOf(response)).toBe(JOURNEY_NOT_FOUND);
  }
  // As the case records for today: a malformed id reaches the database and answers 500.
  const malformed = await raw('GET', `/api/projects/${pid}/journeys/not-a-uuid`, undefined, as(p, clientIp));
  expect(malformed.status).toBe(500);
  expect(messageOf(malformed)).toBe('Internal server error');

  await signIn(page, p.owner);
  const release = await holdRequests(page, 'GET', `/api/projects/${pid}/journeys/${missing}`);
  await page.goto(`/projects/${pid}/journeys/${missing}`);
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expect(page.getByText('Journey not found. It may have been deleted.')).toHaveCount(0);
  release();
  for (const id of [missing, foreign.id, 'not-a-uuid']) {
    const gets = recordRequests(page, 'GET', `/api/projects/${pid}/journeys/${id}`);
    if (id !== missing) await page.goto(`/projects/${pid}/journeys/${id}`);
    await expect(page.getByText('Journey not found. It may have been deleted.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to journeys' })).toBeVisible();
    await expect(page.getByText('SEG-144 foreign journey')).toHaveCount(0);
    // No retry.
    await page.waitForTimeout(1500);
    if (id !== missing) expect(gets).toHaveLength(1);
  }
  await page.getByRole('button', { name: 'Back to journeys' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys$`));
  await expect(page.getByRole('heading', { name: 'Journeys', exact: true })).toBeVisible();
});

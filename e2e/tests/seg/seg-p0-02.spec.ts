import { randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { createAccount, createProject } from '../../support/api';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addDevice,
  addStepButton,
  addTeammate,
  allActivity,
  attribute,
  behaviour,
  branchSelects,
  choose,
  clearOfTick,
  createJourney,
  createSegment,
  group,
  holdRequests,
  insertEvent,
  insertRun,
  journeyActionBar,
  journeyDescription,
  journeyEventName,
  journeyName,
  journeyRow,
  materialiseNow,
  messageOf,
  openViewAs,
  raw,
  reactivateTenant,
  rowNamed,
  runsOf,
  segmentRow,
  segProject,
  setJourneyStatus,
  sql,
  staffSession,
  stepButtons,
  stepCard,
  suspendTenant,
  toastTitled,
  trackEvent,
  uniqueId,
  viewAsHandoff,
  viewAsTokenOf,
  waitForTickAfter,
  watermarkOf,
  type Node,
  type SegProject,
} from '../../support/areas/seg';

/**
 * Journeys: the editor creating and editing (steps, branches that follow their
 * targets, loops, read-only while active), the journeys API (what cannot be set,
 * audiences of other projects, status changes and the enrolment watermark, delete,
 * other tenants, every role, view-as), and the worker's journey runtime (event
 * enrolment, branches, pause and resume, a suspended tenant, enrolment from a
 * rebuilt audience). Runtime cases wait on the worker's minute tick.
 */

// The runtime cases each wait on the worker's minute tick, so they run side by side.
test.describe.configure({ mode: 'parallel' });

const PROJECT_NOT_FOUND = 'Project not found';
const JOURNEY_NOT_FOUND = 'Journey not found for this project';
const READ_ONLY = 'Impersonation sessions are read-only';
const SEGMENT_FOREIGN = 'A segment in this journey does not belong to this project.';
const LOOP = 'These steps can loop without waiting, which would run without end. Add a wait inside the loop.';
const EDIT_ACTIVE = 'Pause this journey before editing it — people are partway through the steps as they are.';
const DELETE_ACTIVE = 'Pause this journey before deleting it — it is live and still enrolling people.';
const SAVES_AS_DRAFT = 'Saves as a draft — nobody is enrolled until you activate it.';
const EDIT_DEFAULT = 'People already part-way through will resume against the edited steps.';
const KNOWN_COUNTRY = group([attribute('country', 'exists')]);

async function openJourneys(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/journeys`);
  await expect(page.getByRole('heading', { name: 'Journeys', exact: true })).toBeVisible();
}

async function openJourney(page: Page, projectId: string, journeyId: string, name: string): Promise<void> {
  await page.goto(`/projects/${projectId}/journeys/${journeyId}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

function as(p: SegProject, ip: string) {
  return { ip, token: p.owner.accessToken };
}

async function vipAudience(p: SegProject, ip: string, name = 'VIP') {
  return createSegment(p.owner, p.project.id, ip, {
    name,
    definition: group([attribute('traits.plan', 'eq', 'pro')]),
    evaluationMode: 'live',
    status: 'active',
  });
}

// ---- Journey editor: create

test('SEG-121 saving a new journey as a draft', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg121');
  const pid = p.project.id;
  const activityBefore = await allActivity(pid);

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await page.getByRole('link', { name: 'New journey' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys/new$`));
  await expect(page.getByRole('heading', { name: 'New journey', exact: true })).toBeVisible();

  await journeyName(page).fill('Cart rescue');
  await journeyDescription(page).fill('Nudge abandoned carts');
  await journeyEventName(page).fill('cart_abandoned');
  await addStepButton(page, 'Wait').click();
  await addStepButton(page, 'Send push').click();
  await addStepButton(page, 'Exit').click();

  const wait = stepCard(page, 1);
  await wait.getByRole('textbox').fill('2');
  await choose(wait.getByRole('combobox'), 'hours');
  await expect(wait).toContainText('Wait 2 hours');
  const push = stepCard(page, 2);
  await push.getByPlaceholder('Still thinking it over?').fill('Still thinking it over?');
  await push.getByPlaceholder('Optional').nth(0).fill('Your cart is waiting');
  await push.getByPlaceholder('Optional').nth(2).fill('myapp://cart');
  await expect(stepCard(page, 3)).toContainText('Exit the journey');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/projects/${pid}/journeys`),
    page.getByRole('button', { name: 'Save draft' }).click(),
  ]);
  expect(request.postDataJSON()).toEqual({
    name: 'Cart rescue',
    description: 'Nudge abandoned carts',
    trigger: { type: 'event', eventName: 'cart_abandoned' },
    steps: [
      { type: 'wait', durationSeconds: 7200 },
      { type: 'send_push', title: 'Still thinking it over?', body: 'Your cart is waiting', deepLinkUrl: 'myapp://cart' },
      { type: 'exit' },
    ],
  });
  const toast = toastTitled(page, 'Journey saved as a draft');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Activate it from the journeys list when you want people to enter it.');

  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys/[0-9a-f-]{36}$`));
  const journeyId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: 'Cart rescue', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await expect(journeyActionBar(page)).toHaveText(EDIT_DEFAULT);

  const stored = await journeyRow(journeyId);
  expect(stored).toMatchObject({ project_id: pid, name: 'Cart rescue', status: 'draft', enrolled_through: null });
  expect(await allActivity(pid)).toEqual(activityBefore);

  // The create page was replaced, so Back leaves the editor for the list.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/journeys$`));
  await expect(page.getByRole('heading', { name: 'Journeys', exact: true })).toBeVisible();
});

test('SEG-132 a branch step sends each path to the step chosen', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg132');
  const pid = p.project.id;
  const vip = await vipAudience(p, clientIp);

  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/journeys/new`);
  await journeyName(page).fill('Offers');
  await journeyEventName(page).fill('signup');
  for (const step of ['Wait', 'Branch', 'Send push', 'Send push', 'Exit']) await addStepButton(page, step).click();
  await stepCard(page, 3).getByPlaceholder('Still thinking it over?').fill('VIP offer');
  await stepCard(page, 4).getByPlaceholder('Still thinking it over?').fill('Standard offer');

  const branch = stepCard(page, 2);
  const selects = branchSelects(branch);
  await expect(branch).toContainText('Branch on a segment');
  await expect(journeyActionBar(page)).toHaveText('Step 2: a branch needs a segment.');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await choose(selects.segment, 'VIP');
  await expect(branch).toContainText('If in "VIP"');
  await expect(journeyActionBar(page)).toHaveText('Step 2: choose where the member path goes.');
  await choose(selects.member, '3. Send push "VIP offer"');
  await expect(journeyActionBar(page)).toHaveText('Step 2: choose where the non-member path goes.');
  await choose(selects.nonMember, '4. Send push "Standard offer"');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);
  await expect(branch).toContainText(
    'Each path follows the step you chose, not its number — reordering the list moves the step and the path with it.',
  );

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/projects/${pid}/journeys`),
    page.getByRole('button', { name: 'Save draft' }).click(),
  ]);
  const steps = (request.postDataJSON() as { steps: Node[] }).steps;
  expect(steps[1]).toEqual({ type: 'branch', segmentId: vip.id, ifMember: 2, ifNot: 3 });
  await expect(toastTitled(page, 'Journey saved as a draft')).toBeVisible();
  const [stored] = await sql(`SELECT steps FROM journeys WHERE project_id = $1`, [pid]);
  expect(stored.steps[1]).toEqual({ type: 'branch', segmentId: vip.id, ifMember: 2, ifNot: 3 });
});

test('SEG-133 branch targets follow their steps when the list is reordered', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg133');
  const pid = p.project.id;
  const vip = await vipAudience(p, clientIp);
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Offers',
    steps: [
      { type: 'wait', durationSeconds: 86_400 },
      { type: 'branch', segmentId: vip.id, ifMember: 2, ifNot: 3 },
      { type: 'send_push', title: 'VIP offer' },
      { type: 'send_push', title: 'Standard offer' },
      { type: 'exit' },
    ],
  });

  await signIn(page, p.owner);
  await openJourney(page, pid, journey.id, 'Offers');
  const selects = branchSelects(stepCard(page, 2));
  await expect(selects.member).toHaveText('3. Send push "VIP offer"');
  await expect(selects.nonMember).toHaveText('4. Send push "Standard offer"');
  await expect(stepButtons(stepCard(page, 1)).up).toBeDisabled();
  await expect(stepButtons(stepCard(page, 5)).down).toBeDisabled();
  await expect(stepButtons(stepCard(page, 3)).up).toBeEnabled();

  await stepButtons(stepCard(page, 4)).up.click();
  await expect(stepCard(page, 3)).toContainText('Send push "Standard offer"');
  await expect(stepCard(page, 4)).toContainText('Send push "VIP offer"');
  await expect(selects.member).toHaveText('4. Send push "VIP offer"');
  await expect(selects.nonMember).toHaveText('3. Send push "Standard offer"');

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/journeys/${journey.id}`)),
    page.getByRole('button', { name: 'Save changes' }).click(),
  ]);
  const steps = (request.postDataJSON() as { steps: Node[] }).steps;
  expect(steps.map((step) => step.title ?? step.type)).toEqual(['wait', 'branch', 'Standard offer', 'VIP offer', 'exit']);
  expect(steps[1]).toEqual({ type: 'branch', segmentId: vip.id, ifMember: 3, ifNot: 2 });
  await expect(toastTitled(page, 'Journey updated')).toBeVisible();
  expect((await journeyRow(journey.id))?.steps[1]).toEqual({ type: 'branch', segmentId: vip.id, ifMember: 3, ifNot: 2 });
});

test('SEG-135 loops without a wait are refused', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg135');
  const pid = p.project.id;
  const vip = await vipAudience(p, clientIp);

  // The API refuses the same shapes with the same message.
  for (const steps of [
    [{ type: 'send_push', title: 'Come back' }, { type: 'branch', segmentId: vip.id, ifMember: 0, ifNot: 2 }, { type: 'exit' }],
    [{ type: 'send_push', title: 'Come back' }, { type: 'branch', segmentId: vip.id, ifMember: 1, ifNot: 2 }, { type: 'exit' }],
  ]) {
    const refused = await raw('POST', `/api/projects/${pid}/journeys`, { name: 'Loop', trigger: { type: 'event', eventName: 'signup' }, steps }, as(p, clientIp));
    expect(refused.status).toBe(400);
    expect(messageOf(refused)).toBe(LOOP);
  }

  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/journeys/new`);
  await journeyName(page).fill('Loop');
  await journeyEventName(page).fill('signup');
  for (const step of ['Send push', 'Branch', 'Exit']) await addStepButton(page, step).click();
  await stepCard(page, 1).getByPlaceholder('Still thinking it over?').fill('Come back');
  const save = page.getByRole('button', { name: 'Save draft' });

  // Member path back to step 1, which runs straight into the branch again.
  let selects = branchSelects(stepCard(page, 2));
  await choose(selects.segment, 'VIP');
  await choose(selects.member, '1. Send push "Come back"');
  await choose(selects.nonMember, '3. Exit the journey');
  await expect(journeyActionBar(page)).toHaveText(LOOP);
  await expect(save).toBeDisabled();

  // A branch pointing at itself loops too, and counts as a reference to itself.
  await choose(selects.member, '2. If in "VIP"');
  await expect(journeyActionBar(page)).toHaveText(LOOP);
  await stepButtons(stepCard(page, 2)).remove.click();
  const repoint = toastTitled(page, 'Repoint these branches first');
  await expect(repoint).toBeVisible();
  await expect(repoint).toContainText("Step 2's member path leads to this step. Send them somewhere else, then delete it.");
  await expect(stepCard(page, 2)).toContainText('If in "VIP"');
  await choose(selects.member, '1. Send push "Come back"');
  await expect(journeyActionBar(page)).toHaveText(LOOP);

  // A wait moved to the top, and the member path sent to it: the loop now waits.
  await addStepButton(page, 'Wait').click();
  await stepButtons(stepCard(page, 4)).up.click();
  await stepButtons(stepCard(page, 3)).up.click();
  await stepButtons(stepCard(page, 2)).up.click();
  await expect(stepCard(page, 1)).toContainText('Wait 1 days');
  selects = branchSelects(stepCard(page, 3));
  await expect(selects.member).toHaveText('2. Send push "Come back"');
  await expect(journeyActionBar(page)).toHaveText(LOOP);
  await choose(selects.member, '1. Wait 1 days');
  await expect(journeyActionBar(page)).toHaveText(SAVES_AS_DRAFT);
  await expect(save).toBeEnabled();

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/projects/${pid}/journeys`),
    save.click(),
  ]);
  expect(response.status()).toBe(201);
  expect((response.request().postDataJSON() as { steps: Node[] }).steps).toEqual([
    { type: 'wait', durationSeconds: 86_400 },
    { type: 'send_push', title: 'Come back' },
    { type: 'branch', segmentId: vip.id, ifMember: 0, ifNot: 3 },
    { type: 'exit' },
  ]);
  await expect(toastTitled(page, 'Journey saved as a draft')).toBeVisible();
});

// ---- Journey editor: edit

test('SEG-142 an active journey is read-only until paused from the editor', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg142');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');

  await signIn(page, p.owner);
  await openJourney(page, pid, journey.id, 'Welcome');
  const card = page.locator('div.rounded-xl, div.border-destructive\\/40').filter({ hasText: 'This journey is active' }).first();
  await expect(page.getByText('This journey is active', { exact: true })).toBeVisible();
  await expect(card).toContainText(
    'People are part-way through the steps as they stand, so editing is closed while it runs. Pausing stops anyone new entering and lets everyone already inside finish — then the steps can change.',
  );
  await expect(page.locator('fieldset[disabled]')).toHaveCount(1);
  await expect(journeyName(page)).toBeDisabled();
  await expect(journeyEventName(page)).toBeDisabled();
  await expect(addStepButton(page, 'Wait')).toBeDisabled();
  await expect(stepButtons(stepCard(page, 1)).remove).toBeDisabled();
  await expect(journeyActionBar(page)).toHaveText('This journey is active. Pause it before making changes.');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  const pause = page.getByRole('button', { name: 'Pause to edit' });
  const release = await holdRequests(page, 'POST', `/journeys/${journey.id}/status`);
  const statusRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/journeys/${journey.id}/status`));
  await pause.click();
  expect((await statusRequest).postDataJSON()).toEqual({ status: 'paused' });
  await expect(pause).toBeDisabled();
  await expect(pause.locator('svg.animate-spin')).toHaveCount(1);
  release();

  const toast = toastTitled(page, 'Journey paused');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Nobody new enters it. People already inside will finish.');
  await expect(page.getByText('This journey is active', { exact: true })).toHaveCount(0);
  await expect(page.locator('fieldset[disabled]')).toHaveCount(0);
  await expect(journeyName(page)).toBeEnabled();
  await journeyName(page).fill('Welcome again');
  await expect(journeyActionBar(page)).toHaveText(EDIT_DEFAULT);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();

  expect((await journeyRow(journey.id))?.status).toBe('paused');
  const changes = (await activityRows(pid, 'journey.status_changed')).map((row) => row.details);
  expect(changes).toEqual([
    { from: 'draft', to: 'active' },
    { from: 'active', to: 'paused' },
  ]);
});

// ---- Journeys API

test('SEG-149 a journey cannot be created or edited into a live state', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg149');
  const pid = p.project.id;
  const draft = await createJourney(p.owner, pid, clientIp, { name: 'SEG-149 draft' });
  const body = { name: 'Live at once', trigger: { type: 'event', eventName: 'signup' }, steps: [{ type: 'exit' }] };
  const at = new Date().toISOString();

  for (const [method, path, payload, message] of [
    ['POST', `/api/projects/${pid}/journeys`, { ...body, status: 'active' }, 'property status should not exist'],
    ['POST', `/api/projects/${pid}/journeys`, { ...body, enrolledThrough: at }, 'property enrolledThrough should not exist'],
    ['PATCH', `/api/projects/${pid}/journeys/${draft.id}`, { status: 'active' }, 'property status should not exist'],
    ['PATCH', `/api/projects/${pid}/journeys/${draft.id}`, { name: 'x', enrolledThrough: at }, 'property enrolledThrough should not exist'],
  ] as const) {
    const response = await raw(method, path, payload, as(p, clientIp));
    expect(response.status, `${method} ${JSON.stringify(payload)}`).toBe(400);
    expect(messageOf(response)).toBe(message);
  }

  const rows = await sql(`SELECT id, name, status, enrolled_through FROM journeys WHERE project_id = $1`, [pid]);
  expect(rows).toEqual([{ id: draft.id, name: 'SEG-149 draft', status: 'draft', enrolled_through: null }]);

  // The status route is the only way live.
  const activated = await raw('POST', `/api/projects/${pid}/journeys/${draft.id}/status`, { status: 'active' }, as(p, clientIp));
  expect(activated.status).toBe(201);
  expect(activated.body.data.status).toBe('active');
});

test('SEG-152 audiences named by a journey must be this project’s', async ({ clientIp }) => {
  const p1 = await segProject(clientIp, 'seg152');
  const pid = p1.project.id;
  const s1 = await createSegment(p1.owner, pid, clientIp, { name: 'S1', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  const x = await segProject(clientIp, 'seg152-x');
  const s2 = await createSegment(x.owner, x.project.id, clientIp, { name: 'S2', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  const existing = await createJourney(p1.owner, pid, clientIp, { name: 'SEG-152 existing' });
  const base = `/api/projects/${pid}/journeys`;
  const segmentTrigger = (segmentId: string) => ({
    name: 'Foreign',
    trigger: { type: 'segment_entry', segmentId },
    steps: [{ type: 'wait', durationSeconds: 60 }],
  });
  const branchOn = (segmentId: string) => ({
    name: 'Foreign branch',
    trigger: { type: 'event', eventName: 'signup' },
    steps: [{ type: 'branch', segmentId, ifMember: 1, ifNot: 1 }, { type: 'exit' }],
  });

  for (const [method, path, body] of [
    ['POST', base, segmentTrigger(s2.id)],
    ['POST', base, branchOn(s2.id)],
    ['POST', base, segmentTrigger(randomUUID())],
    ['POST', base, segmentTrigger('not-a-uuid')],
    ['PATCH', `${base}/${existing.id}`, { trigger: { type: 'segment_entry', segmentId: s2.id } }],
  ] as const) {
    const response = await raw(method, path, body, as(p1, clientIp));
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(messageOf(response)).toBe(SEGMENT_FOREIGN);
  }
  expect((await sql(`SELECT count(*)::int AS n FROM journeys WHERE project_id = $1`, [pid]))[0].n).toBe(1);
  expect((await journeyRow(existing.id))?.trigger).toEqual({ type: 'event', eventName: 'signup' });

  const own = await raw('POST', base, segmentTrigger(s1.id), as(p1, clientIp));
  expect(own.status).toBe(201);
  expect(own.body.data.trigger).toEqual({ type: 'segment_entry', segmentId: s1.id });
  const ownBranch = await raw('PATCH', `${base}/${existing.id}`, { steps: branchOn(s1.id).steps }, as(p1, clientIp));
  expect(ownBranch.status).toBe(200);
});

test('SEG-153 editing an active journey is refused', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg153');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  const before = await journeyRow(journey.id);

  for (const body of [{ name: 'x' }, { steps: [{ type: 'exit' }] }]) {
    const response = await raw('PATCH', `/api/projects/${pid}/journeys/${journey.id}`, body, as(p, clientIp));
    expect(response.status).toBe(400);
    expect(messageOf(response)).toBe(EDIT_ACTIVE);
  }
  const after = await journeyRow(journey.id);
  expect(after?.name).toBe('Welcome');
  expect(after?.steps).toEqual(before?.steps);
  expect(after?.status).toBe('active');
});

test('SEG-155 status transitions and the enrolment watermark', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg155');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  const status = async (to: string) => {
    const before = Date.now();
    const response = await raw('POST', `/api/projects/${pid}/journeys/${journey.id}/status`, { status: to }, as(p, clientIp));
    expect(response.status, to).toBe(201);
    expect(response.body.data.status).toBe(to);
    const watermark = await watermarkOf(journey.id);
    expect(new Date(response.body.data.enrolledThrough).getTime()).toBe(watermark?.getTime());
    return { watermark: watermark!.getTime(), before, after: Date.now() };
  };

  // Clear of the worker's minute tick, which moves an active journey's watermark.
  await clearOfTick();
  const first = await status('active');
  expect(first.watermark).toBeGreaterThanOrEqual(first.before - 1000);
  expect(first.watermark).toBeLessThanOrEqual(first.after + 1000);
  const t1 = first.watermark;
  expect((await status('paused')).watermark).toBe(t1);
  expect((await status('active')).watermark).toBe(t1);
  expect((await status('archived')).watermark).toBe(t1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await status('active');
  const t2 = second.watermark;
  expect(t2).toBeGreaterThan(t1);
  expect(t2).toBeGreaterThanOrEqual(second.before - 1000);
  expect((await status('draft')).watermark).toBe(t2);

  const rows = await activityRows(pid, 'journey.status_changed');
  expect(rows.map((row) => row.details)).toEqual([
    { from: 'draft', to: 'active' },
    { from: 'active', to: 'paused' },
    { from: 'paused', to: 'active' },
    { from: 'active', to: 'archived' },
    { from: 'archived', to: 'active' },
    { from: 'active', to: 'draft' },
  ]);
  for (const row of rows) expect(row).toMatchObject({ target_type: 'journey', target_id: journey.id, actor_user_id: p.owner.userId });
});

test('SEG-159 delete rules for active, paused and archived journeys', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg159');
  const pid = p.project.id;
  const active = await createJourney(p.owner, pid, clientIp, { name: 'SEG-159 active' });
  const paused = await createJourney(p.owner, pid, clientIp, { name: 'SEG-159 paused' });
  const archived = await createJourney(p.owner, pid, clientIp, { name: 'SEG-159 archived' });
  await setJourneyStatus(p.owner, pid, clientIp, active.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'paused');
  await setJourneyStatus(p.owner, pid, clientIp, archived.id, 'archived');
  const path = (id: string) => `/api/projects/${pid}/journeys/${id}`;

  const refused = await raw('DELETE', path(active.id), undefined, as(p, clientIp));
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toBe(DELETE_ACTIVE);
  expect((await journeyRow(active.id))?.status).toBe('active');

  for (const journey of [paused, archived]) {
    const deleted = await raw('DELETE', path(journey.id), undefined, as(p, clientIp));
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ data: { deleted: true } });
    expect(await journeyRow(journey.id)).toBeUndefined();
  }
  const again = await raw('DELETE', path(paused.id), undefined, as(p, clientIp));
  expect(again.status).toBe(404);
  expect(messageOf(again)).toBe(JOURNEY_NOT_FOUND);

  const rows = await activityRows(pid, 'content.deleted');
  expect(rows.map((row) => row.target_id).sort()).toEqual([paused.id, archived.id].sort());
  for (const row of rows) expect(row).toMatchObject({ target_type: 'journey', details: { kind: 'journey' } });
});

test('SEG-161 another tenant’s journey id is not found through this project', async ({ clientIp }) => {
  const p1 = await segProject(clientIp, 'seg161');
  const x = await segProject(clientIp, 'seg161-x');
  const j2 = await createJourney(x.owner, x.project.id, clientIp, { name: 'SEG-161 J2' });
  const before = await journeyRow(j2.id);
  const base = `/api/projects/${p1.project.id}/journeys/${j2.id}`;

  for (const [method, path, body] of [
    ['GET', base, undefined],
    ['PATCH', base, { name: 'Taken over' }],
    ['POST', `${base}/status`, { status: 'active' }],
    ['DELETE', base, undefined],
    ['GET', `${base}/stats`, undefined],
  ] as const) {
    const response = await raw(method, path, body, as(p1, clientIp));
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(messageOf(response)).toBe(JOURNEY_NOT_FOUND);
  }
  expect(await journeyRow(j2.id)).toEqual(before);
  for (const pid of [p1.project.id, x.project.id]) {
    const rows = (await allActivity(pid)).filter((row) => ['journey.status_changed', 'content.deleted'].includes(row.action));
    expect(rows).toEqual([]);
  }
});

test('SEG-162 admin and member can create, edit, activate, pause and delete journeys', async ({ browser, baseURL, clientIp }) => {
  test.setTimeout(150_000);
  const p = await segProject(clientIp, 'seg162');
  const pid = p.project.id;
  for (const role of ['admin', 'member'] as const) {
    const teammate = await addTeammate(p.owner, pid, role, clientIp);
    const { context } = await newPersonContext(browser, baseURL);
    const page = await context.newPage();
    const refused: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 403 && response.url().includes(`/api/projects/${pid}/journeys`)) refused.push(response.url());
    });
    try {
      await signIn(page, teammate);
      const name = `SEG-162 ${role}`;
      await openJourneys(page, pid);
      await page.getByRole('link', { name: 'New journey' }).click();
      await journeyName(page).fill(name);
      await journeyEventName(page).fill('signup');
      await addStepButton(page, 'Wait').click();
      await page.getByRole('button', { name: 'Save draft' }).click();
      await expect(toastTitled(page, 'Journey saved as a draft')).toBeVisible();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();

      await journeyName(page).fill(`${name} edited`);
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(toastTitled(page, 'Journey updated')).toBeVisible();

      await openJourneys(page, pid);
      const row = rowNamed(page, `${name} edited`);
      await row.getByRole('button', { name: 'Activate' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Activate journey' }).click();
      await expect(toastTitled(page, 'Journey activated')).toBeVisible();
      await row.getByRole('button', { name: 'Pause' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Pause journey' }).click();
      await expect(toastTitled(page, 'Journey paused')).toBeVisible();
      await expect(row.getByText('Paused', { exact: true })).toBeVisible();
      await row.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete journey' }).click();
      await expect(toastTitled(page, 'Journey deleted')).toBeVisible();
      await expect(rowNamed(page, `${name} edited`)).toHaveCount(0);

      const mine = (await allActivity(pid)).filter((r) => r.target_label === `${name} edited`);
      expect(mine.map((r) => [r.action, r.details])).toEqual([
        ['journey.status_changed', { from: 'draft', to: 'active' }],
        ['journey.status_changed', { from: 'active', to: 'paused' }],
        ['content.deleted', { kind: 'journey' }],
      ]);
      for (const r of mine) expect(r.actor_user_id).toBe(teammate.userId);
      expect(refused).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('SEG-163 non-member, missing or malformed project, signed out and SDK key are refused', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg163');
  const journey = await createJourney(p.owner, p.project.id, clientIp, { name: 'SEG-163 journey' });
  const x = await createAccount(clientIp, 'seg163-x');
  await createProject(x, clientIp, 'SEG-163 X own');
  const body = { name: 'Injected', trigger: { type: 'event', eventName: 'signup' }, steps: [{ type: 'exit' }] };
  const routes = (projectId: string) => {
    const base = `/api/projects/${projectId}/journeys`;
    return [
      ['GET', base, undefined],
      ['GET', `${base}/${journey.id}`, undefined],
      ['GET', `${base}/${journey.id}/stats`, undefined],
      ['POST', base, body],
      ['PATCH', `${base}/${journey.id}`, { name: 'Changed' }],
      ['POST', `${base}/${journey.id}/status`, { status: 'active' }],
      ['DELETE', `${base}/${journey.id}`, undefined],
    ] as const;
  };

  const notFound: Array<[string, string]> = [
    [x.accessToken, p.project.id],
    [p.owner.accessToken, randomUUID()],
    [p.owner.accessToken, p.project.id.toUpperCase()],
    [p.owner.accessToken, 'not-a-uuid'],
  ];
  for (const [token, projectId] of notFound) {
    for (const [method, path, payload] of routes(projectId)) {
      const response = await raw(method, path, payload, { ip: clientIp, token });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(messageOf(response), `${method} ${path}`).toBe(PROJECT_NOT_FOUND);
    }
  }
  for (const credentials of [{}, { apiKey: p.sdkKey }]) {
    for (const [method, path, payload] of routes(p.project.id)) {
      const response = await raw(method, path, payload, { ip: clientIp, ...credentials });
      expect(response.status, `${method} ${path} ${Object.keys(credentials)}`).toBe(401);
    }
  }
  const rows = await sql(`SELECT id, name, status FROM journeys WHERE project_id = $1`, [p.project.id]);
  expect(rows).toEqual([{ id: journey.id, name: 'SEG-163 journey', status: 'draft' }]);
});

test('SEG-164 view-as can read journeys', async ({ page, browser, baseURL, clientIp }) => {
  const p = await segProject(clientIp, 'seg164');
  const pid = p.project.id;
  const draft = await createJourney(p.owner, pid, clientIp, { name: 'SEG-164 draft', description: 'Draft one' });
  const active = await createJourney(p.owner, pid, clientIp, { name: 'SEG-164 active' });
  await setJourneyStatus(p.owner, pid, clientIp, active.id, 'active');

  const refused: string[] = [];
  page.on('response', (response) => {
    if (response.request().method() === 'GET' && response.url().includes(`/api/projects/${pid}`) && response.status() >= 400) {
      refused.push(`${response.status()} ${response.url()}`);
    }
  });
  await openViewAs(page, await viewAsHandoff(browser, baseURL, p.owner));
  await openJourneys(page, pid);
  const draftRow = rowNamed(page, 'SEG-164 draft');
  await expect(draftRow).toContainText('Draft one');
  await expect(draftRow).toContainText('0 inside');
  await expect(rowNamed(page, 'SEG-164 active')).toContainText('0 inside');
  await expect(rowNamed(page, 'SEG-164 active').getByText('Active', { exact: true })).toBeVisible();

  await draftRow.getByRole('link', { name: 'SEG-164 draft', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'SEG-164 draft', exact: true })).toBeVisible();
  await expect(journeyName(page)).toHaveValue('SEG-164 draft');
  await expect(journeyEventName(page)).toHaveValue('signup');
  await expect(stepCard(page, 2)).toContainText('Send push "Hi"');

  await openJourney(page, pid, active.id, 'SEG-164 active');
  await expect(page.getByText('This journey is active', { exact: true })).toBeVisible();
  await expect(stepCard(page, 1)).toContainText('Wait 1 days');
  expect(refused).toEqual([]);
});

test('SEG-165 view-as cannot change journeys', async ({ page, browser, baseURL, clientIp }) => {
  test.setTimeout(150_000);
  const p = await segProject(clientIp, 'seg165');
  const pid = p.project.id;
  const draft = await createJourney(p.owner, pid, clientIp, { name: 'SEG-165 draft' });
  const active = await createJourney(p.owner, pid, clientIp, { name: 'SEG-165 active' });
  await setJourneyStatus(p.owner, pid, clientIp, active.id, 'active');

  await openViewAs(page, await viewAsHandoff(browser, baseURL, p.owner));
  const activityBefore = await allActivity(pid);
  expect(activityBefore.map((row) => row.action)).toContain('staff.viewed_as');
  const journeysBefore = await sql(`SELECT id, name, status, steps, enrolled_through, updated_at FROM journeys WHERE project_id = $1 ORDER BY id`, [pid]);
  const expectRefusal = async (title: string) => {
    const toast = toastTitled(page, title).last();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(READ_ONLY);
    await expect(toastTitled(page, 'Read-only session').last()).toContainText(READ_ONLY);
  };

  await openJourneys(page, pid);
  const dialog = page.getByRole('dialog');
  await rowNamed(page, 'SEG-165 draft').getByRole('button', { name: 'Activate' }).click();
  await dialog.getByRole('button', { name: 'Activate journey' }).click();
  await expectRefusal('Could not activate journey');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await rowNamed(page, 'SEG-165 active').getByRole('button', { name: 'Pause' }).click();
  await dialog.getByRole('button', { name: 'Pause journey' }).click();
  await expectRefusal('Could not pause journey');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await rowNamed(page, 'SEG-165 draft').getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete journey' }).click();
  await expectRefusal('Could not delete journey');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await openJourney(page, pid, draft.id, 'SEG-165 draft');
  await journeyName(page).fill('SEG-165 renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expectRefusal('Could not save journey');

  await openJourney(page, pid, active.id, 'SEG-165 active');
  await page.getByRole('button', { name: 'Pause to edit' }).click();
  await expectRefusal('Could not pause journey');
  await expect(page.getByText('This journey is active', { exact: true })).toBeVisible();

  const token = await viewAsTokenOf(page);
  const base = `/api/projects/${pid}/journeys`;
  for (const [method, path, body] of [
    ['POST', base, { name: 'SEG-165 api', trigger: { type: 'event', eventName: 'signup' }, steps: [{ type: 'exit' }] }],
    ['PATCH', `${base}/${draft.id}`, { name: 'SEG-165 api' }],
    ['POST', `${base}/${draft.id}/status`, { status: 'active' }],
    ['POST', `${base}/${active.id}/status`, { status: 'paused' }],
    ['DELETE', `${base}/${draft.id}`, undefined],
  ] as const) {
    const response = await raw(method, path, body, { ip: clientIp, token });
    expect(response.status, `${method} ${path}`).toBe(403);
    expect(messageOf(response)).toBe(READ_ONLY);
  }

  // The worker's tick moves the active journey's watermark; nothing else may change.
  const strip = (rows: Array<Record<string, any>>) => rows.map(({ enrolled_through, updated_at, ...rest }) => rest);
  const journeysAfter = await sql(`SELECT id, name, status, steps, enrolled_through, updated_at FROM journeys WHERE project_id = $1 ORDER BY id`, [pid]);
  expect(strip(journeysAfter)).toEqual(strip(journeysBefore));
  expect(journeysAfter.find((row) => row.id === draft.id)).toEqual(journeysBefore.find((row) => row.id === draft.id));
  expect(await allActivity(pid)).toEqual(activityBefore);
});

// ---- Journey runtime (the worker's minute tick)

test('SEG-166 an event trigger enrols only people who fire after activation', async ({ page, clientIp }) => {
  test.setTimeout(240_000);
  const p = await segProject(clientIp, 'seg166');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  const carol = uniqueId('u-carol');
  const aliceDevice = await addDevice(p, clientIp, { externalUserId: alice });
  const bobDevice = await addDevice(p, clientIp, { externalUserId: bob });
  const carolDevice = await addDevice(p, clientIp, { externalUserId: carol });
  // A long wait keeps the run inside the journey while the list is read.
  const welcome = await createJourney(p.owner, pid, clientIp, {
    name: 'Welcome',
    steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
  });
  await trackEvent(p, clientIp, aliceDevice, 'signup');
  await new Promise((resolve) => setTimeout(resolve, 50));

  await setJourneyStatus(p.owner, pid, clientIp, welcome.id, 'active');
  const watermark = (await watermarkOf(welcome.id))!;
  // Sent after activation, but stamped before it by the client.
  await trackEvent(p, clientIp, carolDevice, 'signup', new Date(watermark.getTime() - 60_000));
  const bobAt = await trackEvent(p, clientIp, bobDevice, 'signup');
  expect(bobAt.getTime()).toBeGreaterThan(watermark.getTime());

  await expect.poll(async () => (await runsOf(welcome.id)).map((run) => run.person_key), { timeout: 150_000, intervals: [1000] }).toEqual([bob]);
  await waitForTickAfter(welcome.id, bobAt);
  const runs = await runsOf(welcome.id);
  expect(runs.map((run) => [run.person_key, run.status])).toEqual([[bob, 'active']]);

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await expect(rowNamed(page, 'Welcome')).toContainText('1 inside');
});

test('SEG-172 a branch takes the member or the non-member path', async ({ clientIp }) => {
  test.setTimeout(270_000);
  const p = await segProject(clientIp, 'seg172');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  const aliceDevice = await addDevice(p, clientIp, { externalUserId: alice, traits: { plan: 'pro' } });
  const bobDevice = await addDevice(p, clientIp, { externalUserId: bob, traits: { plan: 'free' } });
  const vip = await vipAudience(p, clientIp);
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Branching',
    steps: [
      { type: 'branch', segmentId: vip.id, ifMember: 1, ifNot: 2 },
      { type: 'exit' },
      { type: 'wait', durationSeconds: 60 },
    ],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await trackEvent(p, clientIp, aliceDevice, 'signup');
  await trackEvent(p, clientIp, bobDevice, 'signup');

  const byPerson = async () => Object.fromEntries((await runsOf(journey.id)).map((run) => [run.person_key, run]));
  // First tick: enrolled, and the branch decided.
  await expect
    .poll(async () => {
      const runs = await byPerson();
      return [runs[alice]?.current_step_index ?? null, runs[bob]?.current_step_index ?? null];
    }, { timeout: 150_000, intervals: [1000] })
    .toEqual([1, 2]);
  // Next tick: alice exits at step 2; bob's final wait completes him.
  await expect
    .poll(async () => {
      const runs = await byPerson();
      return [runs[alice]?.status, runs[bob]?.status];
    }, { timeout: 150_000, intervals: [1000] })
    .toEqual(['exited', 'completed']);
  const runs = await byPerson();
  expect(runs[alice]).toMatchObject({ current_step_index: 1, last_error: null });
  expect(runs[bob]).toMatchObject({ current_step_index: 2, last_error: null });
  expect(runs[alice].completed_at).not.toBeNull();
  expect(runs[bob].completed_at).not.toBeNull();
  const stats = await raw('GET', `/api/projects/${pid}/journeys/${journey.id}/stats`, undefined, as(p, clientIp));
  expect(stats.body.data).toEqual({ active: 0, completed: 1, exited: 1, failed: 0 });
});

test('SEG-174 pausing stops enrolment but lets runs already inside finish', async ({ clientIp }) => {
  test.setTimeout(300_000);
  const p = await segProject(clientIp, 'seg174');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  const aliceDevice = await addDevice(p, clientIp, { externalUserId: alice });
  const bobDevice = await addDevice(p, clientIp, { externalUserId: bob });
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Welcome',
    steps: [{ type: 'wait', durationSeconds: 60 }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await trackEvent(p, clientIp, aliceDevice, 'signup');
  // Alice enters and is waiting at step 2.
  await expect
    .poll(async () => (await runsOf(journey.id)).map((run) => [run.person_key, run.status, run.current_step_index]), {
      timeout: 150_000,
      intervals: [1000],
    })
    .toEqual([[alice, 'active', 1]]);

  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'paused');
  const bobAt = await trackEvent(p, clientIp, bobDevice, 'signup');
  await expect
    .poll(async () => (await runsOf(journey.id)).map((run) => [run.person_key, run.status]), { timeout: 180_000, intervals: [1000] })
    .toEqual([[alice, 'exited']]);
  const [run] = await runsOf(journey.id);
  expect(run.completed_at!.getTime()).toBeGreaterThan(bobAt.getTime());
  expect((await journeyRow(journey.id))?.status).toBe('paused');
});

test('SEG-175 resuming enrols the people who fired while it was paused', async ({ clientIp }) => {
  test.setTimeout(240_000);
  const p = await segProject(clientIp, 'seg175');
  const pid = p.project.id;
  const bob = uniqueId('u-bob');
  const carol = uniqueId('u-carol');
  const bobDevice = await addDevice(p, clientIp, { externalUserId: bob });
  const carolDevice = await addDevice(p, clientIp, { externalUserId: carol });
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Welcome',
    steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
  });
  await trackEvent(p, clientIp, carolDevice, 'signup');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'paused');
  const paused = (await watermarkOf(journey.id))!;
  const bobAt = await trackEvent(p, clientIp, bobDevice, 'signup');
  expect(bobAt.getTime()).toBeGreaterThan(paused.getTime());

  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  expect((await watermarkOf(journey.id))?.getTime()).toBe(paused.getTime());
  const resumedAt = new Date();
  await expect.poll(async () => (await runsOf(journey.id)).map((run) => run.person_key), { timeout: 150_000, intervals: [1000] }).toEqual([bob]);
  await waitForTickAfter(journey.id, resumedAt);
  expect((await runsOf(journey.id)).map((run) => run.person_key)).toEqual([bob]);
});

test('SEG-178 a suspended billing owner’s journey neither enrols, advances nor owes a backlog', async ({ browser, baseURL, clientIp }) => {
  test.setTimeout(330_000);
  const p = await segProject(clientIp, 'seg178');
  const pid = p.project.id;
  const bob = uniqueId('u-bob');
  const bobDevice = await addDevice(p, clientIp, { externalUserId: bob });
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Welcome',
    steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  const staff = await staffSession(browser, baseURL);
  await suspendTenant(staff, p.owner);
  const [{ suspended_at: suspendedAt }] = await sql<{ suspended_at: Date }>(`SELECT suspended_at FROM users WHERE id = $1`, [p.owner.userId]);
  expect(suspendedAt).not.toBeNull();

  // One person waiting at step 2, and one whose wait has just run out.
  const waiting = await insertRun(pid, journey.id, uniqueId('u-waiting'), { stepIndex: 1, dueInSeconds: 3600 });
  const due = await insertRun(pid, journey.id, uniqueId('u-due'), { stepIndex: 1, dueInSeconds: -30 });
  const bobAt = await trackEvent(p, clientIp, bobDevice, 'signup');

  // Ticks while suspended: the watermark is held at now, nobody enrols, nothing moves.
  await waitForTickAfter(journey.id, bobAt);
  let runs = await runsOf(journey.id);
  expect(runs.map((run) => run.person_key).sort()).toEqual([waiting.person_key, due.person_key].sort());
  const dueNow = runs.find((run) => run.id === due.id)!;
  expect(dueNow).toMatchObject({ status: 'active', current_step_index: 1 });
  expect(dueNow.next_due_at?.getTime()).toBe(due.next_due_at?.getTime());
  const held = (await watermarkOf(journey.id))!;
  await waitForTickAfter(journey.id, held);

  const reactivatedFrom = Date.now();
  await reactivateTenant(staff, p.owner);
  const reactivatedTo = Date.now();
  const shift = (await runsOf(journey.id)).find((run) => run.id === waiting.id)!.next_due_at!.getTime() - waiting.next_due_at!.getTime();
  expect(shift).toBeGreaterThanOrEqual(reactivatedFrom - suspendedAt.getTime() - 2000);
  expect(shift).toBeLessThanOrEqual(reactivatedTo - suspendedAt.getTime() + 2000);

  // Ticks after reactivation: bob, who fired during the suspension, is not enrolled.
  await waitForTickAfter(journey.id, new Date(reactivatedTo));
  runs = await runsOf(journey.id);
  expect(runs.map((run) => run.person_key)).not.toContain(bob);
  expect(runs).toHaveLength(2);
});

test('SEG-217 another project’s id in the body or query', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg217');
  const pid = p.project.id;
  const p3 = await createProject(p.owner, clientIp, 'SEG-217 P3');
  const x = await segProject(clientIp, 'seg217-x');
  const segment = await createSegment(p.owner, pid, clientIp, { name: 'SEG-217 audience', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'SEG-217 journey' });
  const segmentsBefore = await sql(`SELECT id, name, definition, status FROM segments WHERE project_id = ANY($1::uuid[]) ORDER BY id`, [[pid, p3.id, x.project.id]]);
  const journeysBefore = await sql(`SELECT id, name, status, steps FROM journeys WHERE project_id = ANY($1::uuid[]) ORDER BY id`, [[pid, p3.id, x.project.id]]);
  const segments = `/api/projects/${pid}/segments`;
  const journeys = `/api/projects/${pid}/journeys`;
  const bodies = (projectId: string) =>
    [
      ['POST', segments, { name: 'SEG-217 new', definition: KNOWN_COUNTRY, projectId }],
      ['POST', journeys, { name: 'SEG-217 new', trigger: { type: 'event', eventName: 'signup' }, steps: [{ type: 'exit' }], projectId }],
      ['PATCH', `${segments}/${segment.id}`, { name: 'SEG-217 renamed', projectId }],
      ['PATCH', `${journeys}/${journey.id}`, { name: 'SEG-217 renamed', projectId }],
      ['POST', `${segments}/preview`, { definition: KNOWN_COUNTRY, projectId }],
      ['POST', `${journeys}/${journey.id}/status`, { status: 'archived', projectId }],
    ] as const;
  const lists = (projectId: string) => [`${segments}?projectId=${projectId}`, `${journeys}?projectId=${projectId}`];

  for (const foreign of [x.project.id, 'not-a-uuid']) {
    for (const [method, path, body] of bodies(foreign)) {
      const response = await raw(method, path, body, as(p, clientIp));
      expect(response.status, `${method} ${path} ${foreign}`).toBe(404);
      expect(messageOf(response)).toBe(PROJECT_NOT_FOUND);
    }
    for (const path of lists(foreign)) {
      const response = await raw('GET', path, undefined, as(p, clientIp));
      expect(response.status, path).toBe(404);
      expect(messageOf(response)).toBe(PROJECT_NOT_FOUND);
    }
  }
  for (const [method, path, body] of bodies(p3.id)) {
    const response = await raw(method, path, body, as(p, clientIp));
    expect(response.status, `${method} ${path} P3`).toBe(400);
    expect(messageOf(response)).toBe('property projectId should not exist');
  }
  const [segmentList, journeyList] = await Promise.all(lists(p3.id).map((path) => raw('GET', path, undefined, as(p, clientIp))));
  expect(segmentList.status).toBe(200);
  expect(segmentList.body.data.map((s: { id: string }) => s.id)).toEqual([segment.id]);
  expect(journeyList.status).toBe(200);
  expect(journeyList.body.data.map((j: { id: string }) => j.id)).toEqual([journey.id]);

  expect(await sql(`SELECT id, name, definition, status FROM segments WHERE project_id = ANY($1::uuid[]) ORDER BY id`, [[pid, p3.id, x.project.id]])).toEqual(segmentsBefore);
  expect(await sql(`SELECT id, name, status, steps FROM journeys WHERE project_id = ANY($1::uuid[]) ORDER BY id`, [[pid, p3.id, x.project.id]])).toEqual(journeysBefore);
  expect(await activityRows(pid, 'journey.status_changed')).toEqual([]);
});

// ---- Journey runtime: enrolment from rebuilt membership

/** A project where alice and bob each bought something, and a materialised "Buyers". */
async function buyersProject(ip: string, label: string) {
  const p = await segProject(ip, label);
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  for (const person of [alice, bob]) {
    const device = await addDevice(p, ip, { externalUserId: person, row: { country: 'IN' } });
    await insertEvent(pid, device, 'purchase', { amount: 10 }, 2);
  }
  const definition = group([behaviour('purchase')]);
  const buyers = await createSegment(p.owner, pid, ip, { name: 'Buyers', definition, evaluationMode: 'materialized', status: 'active' });
  return { p, pid, alice, bob, buyers, definition };
}

test('SEG-220 editing a materialised audience does not re-enrol its whole membership', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'SEG-220' });
  test.fail();
  test.setTimeout(240_000);
  const { p, pid, alice, bob, buyers, definition } = await buyersProject(clientIp, 'seg220');
  await materialiseNow(buyers.id, pid);
  expect((await sql(`SELECT person_key FROM segment_members WHERE segment_id = $1 ORDER BY person_key`, [buyers.id])).map((r) => r.person_key)).toEqual(
    [alice, bob].sort(),
  );
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Buyers welcome',
    trigger: { type: 'segment_entry', segmentId: buyers.id },
    steps: [{ type: 'wait', durationSeconds: 60 }, { type: 'send_push', title: 'Hi' }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  // Alice has been through it; bob is waiting inside it.
  await insertRun(pid, journey.id, alice, { status: 'exited', stepIndex: 2 });
  await insertRun(pid, journey.id, bob, { stepIndex: 1, dueInSeconds: 3600 });

  // A save that sends the same definition back, as the editor always does.
  const saved = await raw('PATCH', `/api/projects/${pid}/segments/${buyers.id}`, { definition }, as(p, clientIp));
  expect(saved.status).toBe(200);
  const refreshedAt = await materialiseNow(buyers.id, pid);
  await waitForTickAfter(journey.id, refreshedAt);

  const runs = await runsOf(journey.id);
  expect(runs.filter((run) => run.person_key === alice)).toHaveLength(1);
  expect(runs.filter((run) => run.person_key === bob)).toHaveLength(1);
});

test('SEG-221 a segment journey activated before its audience’s first refresh enrols nobody who already matched', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'SEG-221' });
  test.fail();
  test.setTimeout(240_000);
  const { p, pid, buyers } = await buyersProject(clientIp, 'seg221');
  const knownCountry = await createSegment(p.owner, pid, clientIp, { name: 'Known country', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const switched = await raw('PATCH', `/api/projects/${pid}/segments/${knownCountry.id}`, { evaluationMode: 'materialized' }, as(p, clientIp));
  expect(switched.status).toBe(200);
  const journeys = [];
  for (const segment of [buyers, knownCountry]) {
    journeys.push(
      await createJourney(p.owner, pid, clientIp, {
        name: `Enter ${segment.name}`,
        trigger: { type: 'segment_entry', segmentId: segment.id },
        steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
      }),
    );
  }
  await clearOfTick();
  for (const journey of journeys) await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  for (const segment of [buyers, knownCountry]) expect((await segmentRow(segment.id))?.last_materialized_at).toBeNull();

  let refreshedAt = new Date(0);
  for (const segment of [buyers, knownCountry]) refreshedAt = await materialiseNow(segment.id, pid);
  for (const journey of journeys) await waitForTickAfter(journey.id, refreshedAt);

  // Everyone matched before activation, so nobody should have entered.
  for (const journey of journeys) expect((await runsOf(journey.id)).map((run) => run.person_key)).toEqual([]);
});

import type { Locator, Page } from '@playwright/test';
import { newClientIp } from '../../support/api';
import { seedFcmConfig } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activityCount,
  activityRows,
  addDevice,
  addPushDevice,
  attribute,
  audienceName,
  behaviour,
  branchSelects,
  campaignsOf,
  cardTitled,
  choose,
  clearOfTick,
  countCaption,
  countFigure,
  createJourney,
  createSegment,
  enqueueMaterialise,
  eventSelect,
  group,
  identifyAs,
  insertEvent,
  insertRun,
  insertRuns,
  journeyName,
  journeyRow,
  lockTable,
  makeRunsDue,
  materialiseNow,
  memberRows,
  messageOf,
  previewResponse,
  raw,
  reactivateTenant,
  recordDialogs,
  recordRequests,
  rowNamed,
  ruleCards,
  runsOf,
  segmentRow,
  segProject,
  selectOptions,
  setJourneyStatus,
  sql,
  staffSession,
  stepCard,
  suspendTenant,
  sweepStrandedRunsNow,
  tickNow,
  toastTitled,
  trackEvent,
  uniqueId,
  waitForLockWaiter,
  waitForTickAfter,
  watermarkOf,
  type SegProject,
} from '../../support/areas/seg';

/**
 * Audiences and journeys, P1 (third chunk): the journeys API (create defaults, field and
 * definition validation, partial edits, repeated and racing status changes, activation
 * re-checking what is stored, stats), the worker's journey runtime (one run per person,
 * waits, push steps reached and skipped, branches on missing audiences, segment-entry
 * triggers, re-entry, changed person keys, a deleted trigger audience, stranded runs,
 * fairness between projects, a suspension), and coverage additions (stale tabs, a late
 * count, an audience in error, members paging, markup in names, dashboard saves of
 * WhatsApp steps, races with activation and materialisation, activity rows). Runtime
 * cases run the worker's journey tick on demand, beside the stack's own minute tick.
 */

test.describe.configure({ mode: 'parallel' });

const KNOWN_COUNTRY = group([attribute('country', 'exists')]);
const JOURNEY_NOT_FOUND = 'Journey not found for this project';
const SEGMENT_FOREIGN = 'A segment in this journey does not belong to this project.';
const EDIT_ACTIVE = 'Pause this journey before editing it — people are partway through the steps as they are.';
const LOOP = 'These steps can loop without waiting, which would run without end. Add a wait inside the loop.';
const NOT_CONFIGURED = 'Push notifications not configured for this project. Call configure first.';
const FIRST_ACTIVATION =
  'This journey will start sending real messages to real people. Enrolment begins from this moment and does not reach back over people who matched the trigger earlier.';
const RESUME_COPY =
  'This journey will start sending real messages again. Enrolment picks up where it paused, so anyone who matched the trigger while it was paused will be enrolled now.';
const STATUS_VALUES = 'status must be one of the following values: draft, active, paused, archived';
const MARKUP = '<img src=x onerror=alert(1)>';

function as(p: SegProject, ip: string) {
  return { ip, token: p.owner.accessToken };
}

/** A fresh client address per request, for the table-driven API cases (100 a minute each). */
function asFresh(p: SegProject) {
  return { ip: newClientIp(), token: p.owner.accessToken };
}

function journeysPath(p: SegProject): string {
  return `/api/projects/${p.project.id}/journeys`;
}

async function openJourneys(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/journeys`);
  await expect(page.getByRole('heading', { name: 'Journeys', exact: true })).toBeVisible();
}

async function openJourney(page: Page, projectId: string, journeyId: string, name: string): Promise<void> {
  await page.goto(`/projects/${projectId}/journeys/${journeyId}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function openAudiences(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/segments`);
  await expect(page.getByRole('heading', { name: 'Audiences', exact: true })).toBeVisible();
}

async function openAudienceEditor(page: Page, projectId: string): Promise<void> {
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

/** The journeys list's People cell of a row. */
function peopleCell(page: Page, name: string): Locator {
  return rowNamed(page, name).getByRole('cell').nth(4);
}

async function journeyCount(projectId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM journeys WHERE project_id = $1`, [projectId]);
  return row.n;
}

/** Polls the journey's runs as [person key, status] pairs, sorted. */
async function pollRuns(journeyId: string, expected: Array<[string, string]>, timeout = 120_000): Promise<void> {
  await expect
    .poll(async () => (await runsOf(journeyId)).map((run) => [run.person_key, run.status]).sort(), { timeout, intervals: [1000] })
    .toEqual([...expected].sort());
}

/** Runs the journey tick until `check` holds (the stack's own minute tick may get there first). */
async function tickUntil(check: () => Promise<boolean>, label: string, ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    if (await check()) return;
    await tickNow();
  }
  if (!(await check())) throw new Error(`Still not ${label} after ${ticks} ticks`);
}

function sortIds(ids: string[] | null | undefined): string[] {
  return [...(ids ?? [])].sort();
}

// ---- Journeys API

test('SEG-148 create defaults and response', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg148');
  const pid = p.project.id;
  const trigger = { type: 'event', eventName: 'signup' };
  const steps = [{ type: 'wait', durationSeconds: 3600 }, { type: 'send_push', title: 'Hi' }, { type: 'exit' }];
  const before = Date.now();
  const response = await raw('POST', journeysPath(p), { name: 'Welcome', trigger, steps }, as(p, clientIp));
  expect(response.status).toBe(201);
  const data = response.body.data;
  expect(Object.keys(response.body)).toEqual(['data']);
  expect(data).toMatchObject({ projectId: pid, name: 'Welcome', description: null, status: 'draft', trigger, steps, enrolledThrough: null });
  expect(data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(Object.keys(data).sort()).toEqual(
    ['createdAt', 'description', 'enrolledThrough', 'id', 'name', 'projectId', 'status', 'steps', 'trigger', 'updatedAt'].sort(),
  );
  for (const stamp of [data.createdAt, data.updatedAt]) {
    expect(new Date(stamp).getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(new Date(stamp).getTime()).toBeLessThanOrEqual(Date.now() + 2000);
  }

  const read = await raw('GET', `${journeysPath(p)}/${data.id}`, undefined, as(p, clientIp));
  expect(read.status).toBe(200);
  expect(read.body.data).toEqual(data);
  expect(await journeyRow(data.id)).toMatchObject({ status: 'draft', enrolled_through: null, description: null });
  // Creating a journey is not logged; only status changes and deletes are.
  expect(await activityRows(pid, 'journey.status_changed')).toEqual([]);
});

test('SEG-150 journey field validation', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg150');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const trigger = { type: 'event', eventName: 'signup' };
  const ok = { name: 'SEG-150', trigger, steps: [{ type: 'exit' }] };
  const email = (extra: Record<string, unknown>) => ({ ...ok, steps: [{ type: 'send_email', subject: 'S', html: '<p>Hi</p>', ...extra }] });
  const rowsBefore = await journeyCount(pid);

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['no name', { trigger, steps: ok.steps }, 'name must be a string'],
    ['long name', { ...ok, name: 'n'.repeat(256) }, 'name must be shorter than or equal to 255 characters'],
    ['no trigger', { name: 'SEG-150', steps: ok.steps }, 'trigger must be an object'],
    ['text trigger', { ...ok, trigger: 'x' }, 'trigger must be an object'],
    ['no steps', { name: 'SEG-150', trigger }, 'steps must be an array'],
    // An object is read as one step rather than refused as not a list.
    ['object steps', { ...ok, steps: {} }, 'steps.type must be a string'],
    ['step without a type', { ...ok, steps: [{ durationSeconds: 60 }] }, 'steps.0.type must be a string'],
    [
      'NaN wait',
      { ...ok, steps: [{ type: 'wait', durationSeconds: 'abc' }] },
      'steps.0.durationSeconds must be a number conforming to the specified constraints',
    ],
    [
      'fractional branch target',
      { ...ok, steps: [{ type: 'branch', segmentId: vip.id, ifMember: 1.5, ifNot: 1 }, { type: 'exit' }] },
      'steps.0.ifMember must be an integer number',
    ],
    ['long subject', email({ subject: 's'.repeat(256) }), 'steps.0.subject must be shorter than or equal to 255 characters'],
    ['long preheader', email({ preheader: 'p'.repeat(256) }), 'steps.0.preheader must be shorter than or equal to 255 characters'],
    ['unknown step key', { ...ok, steps: [{ type: 'exit', foo: 1 }] }, 'steps.0.property foo should not exist'],
  ];
  for (const [label, body, message] of cases) {
    const response = await raw('POST', journeysPath(p), body, asFresh(p));
    expect(response.status, label).toBe(400);
    expect(response.body.message, label).toEqual(expect.arrayContaining([message]));
  }

  expect(await journeyCount(pid)).toBe(rowsBefore);

  // The status route takes only the four statuses.
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'SEG-150 status' });
  const stored = await journeyRow(journey.id);
  for (const body of [{ status: 'live' }, {}]) {
    const response = await raw('POST', `${journeysPath(p)}/${journey.id}/status`, body, asFresh(p));
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(response.body.message).toEqual([STATUS_VALUES]);
  }
  expect(await journeyRow(journey.id)).toEqual(stored);
  expect(await activityRows(pid, 'journey.status_changed')).toEqual([]);

  // Coerced to the declared types, not refused.
  const coerced = await raw(
    'POST',
    journeysPath(p),
    {
      name: 123,
      description: 1,
      trigger,
      steps: [
        { type: 'wait', durationSeconds: '60' },
        { type: 'branch', segmentId: vip.id, ifMember: '2', ifNot: 2 },
        { type: 'exit' },
      ],
    },
    asFresh(p),
  );
  expect(coerced.status).toBe(201);
  const read = await raw('GET', `${journeysPath(p)}/${coerced.body.data.id}`, undefined, asFresh(p));
  expect(read.body.data).toMatchObject({ name: '123', description: '1' });
  expect(typeof read.body.data.name).toBe('string');
  expect(typeof read.body.data.description).toBe('string');
  const [wait, branch] = read.body.data.steps;
  expect(wait).toEqual({ type: 'wait', durationSeconds: 60 });
  expect(typeof wait.durationSeconds).toBe('number');
  expect(branch).toEqual({ type: 'branch', segmentId: vip.id, ifMember: 2, ifNot: 2 });
  expect(typeof branch.ifMember).toBe('number');
  // A coerced index is then judged like any other: there is no fourth step.
  const outOfRange = await raw(
    'POST',
    journeysPath(p),
    { ...ok, steps: [{ type: 'branch', segmentId: vip.id, ifMember: '3', ifNot: 1 }, { type: 'exit' }] },
    asFresh(p),
  );
  expect(outOfRange.status).toBe(400);
  expect(messageOf(outOfRange)).toBe('Step 1: the member path points at a step that does not exist.');
  expect(await journeyCount(pid)).toBe(rowsBefore + 2);
});

test('SEG-150 an email step body up to its 500,000-character limit', { annotation: { type: 'issue', description: 'SEG-150' } }, async ({ clientIp }) => {
  test.fail();
  const p = await segProject(clientIp, 'seg150-html');
  const pid = p.project.id;
  const email = (html: string) => ({
    name: 'SEG-150 html',
    trigger: { type: 'event', eventName: 'signup' },
    steps: [{ type: 'send_email', subject: 'S', html }],
  });
  // A body well under the limit is stored, so the size checks below are about size alone.
  const small = await raw('POST', journeysPath(p), email('<p>Hi</p>'), asFresh(p));
  expect(small.status).toBe(201);
  const rowsBefore = await journeyCount(pid);

  // 500,000 characters are allowed, one more is refused with the field's own message.
  const long = await raw('POST', journeysPath(p), email('h'.repeat(150_000)), asFresh(p));
  expect.soft(long.status, 'a 150,000-character email body').toBe(201);
  const huge = await raw('POST', journeysPath(p), email('h'.repeat(500_001)), asFresh(p));
  expect.soft(huge.status, 'a 500,001-character email body').toBe(400);
  expect.soft(huge.body?.message).toEqual(['steps.0.html must be shorter than or equal to 500000 characters']);
  expect.soft(await journeyCount(pid), 'only the allowed body is stored').toBe(rowsBefore + 1);
});

test('SEG-151 journey definition rules', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg151');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const trigger = { type: 'event', eventName: 'signup' };
  const withSteps = (steps: unknown[]) => ({ name: 'SEG-151', trigger, steps });
  const whatsapp = (content: unknown) => withSteps([{ type: 'send_whatsapp', content }]);
  const branch = (ifMember: number, ifNot: number, segmentId: string | null = vip.id) =>
    withSteps([{ type: 'branch', ...(segmentId ? { segmentId } : {}), ifMember, ifNot }, { type: 'exit' }]);
  const rowsBefore = await journeyCount(pid);

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['blank event name', { ...withSteps([{ type: 'exit' }]), trigger: { type: 'event', eventName: ' ' } }, 'An event trigger needs an event name.'],
    ['segment trigger without a segment', { ...withSteps([{ type: 'exit' }]), trigger: { type: 'segment_entry' } }, 'A segment trigger needs a segment.'],
    ['cron trigger', { ...withSteps([{ type: 'exit' }]), trigger: { type: 'cron' } }, 'Unknown trigger type "cron".'],
    ['empty trigger', { ...withSteps([{ type: 'exit' }]), trigger: {} }, 'Unknown trigger type "undefined".'],
    ['no steps', withSteps([]), 'A journey needs at least one step.'],
    ['wait of 59 s', withSteps([{ type: 'wait', durationSeconds: 59 }]), 'Step 1: a wait must be at least 60 seconds.'],
    ['blank push title', withSteps([{ type: 'send_push', title: ' ' }]), 'Step 1: a push needs a title.'],
    ['email without a subject', withSteps([{ type: 'send_email', html: '<p>Hi</p>' }]), 'Step 1: an email needs a subject.'],
    ['email without a body', withSteps([{ type: 'send_email', subject: 'Hello' }]), 'Step 1: an email needs a body.'],
    ['empty text', withSteps([{ type: 'send_sms', body: '' }]), 'Step 1: a text message needs a body.'],
    ['text of 1601', withSteps([{ type: 'send_sms', body: 'x'.repeat(1601) }]), 'Step 1: a text message can be at most 1600 characters.'],
    ['WhatsApp without a template id', whatsapp({ template: { language: 'en' }, bodyParams: [] }), 'Step 1: a WhatsApp message needs a template.'],
    ['WhatsApp without a language', whatsapp({ template: { id: 'order_update' }, bodyParams: [] }), 'Step 1: a WhatsApp message needs a template.'],
    ['WhatsApp with a blank value', whatsapp({ template: { id: 'order_update', language: 'en' }, bodyParams: ['', 'x'] }), 'Step 1: fill in every value the WhatsApp template needs.'],
    ['WhatsApp values not a list', whatsapp({ template: { id: 'order_update', language: 'en' }, bodyParams: 'x' }), 'Step 1: fill in every value the WhatsApp template needs.'],
    ['branch without a segment', branch(1, 1, null), 'Step 1: a branch needs a segment.'],
    ['member path past the end', branch(5, 1), 'Step 1: the member path points at a step that does not exist.'],
    ['negative member path', branch(-1, 1), 'Step 1: the member path points at a step that does not exist.'],
    ['non-member path past the end', branch(1, 9), 'Step 1: the non-member path points at a step that does not exist.'],
    ['unknown step type', withSteps([{ type: 'teleport' }]), 'Step 1: unknown step type "teleport".'],
    ['loop without a wait', branch(0, 1), LOOP],
  ];
  for (const [label, body, message] of cases) {
    const response = await raw('POST', journeysPath(p), body, asFresh(p));
    expect(response.status, label).toBe(400);
    expect(messageOf(response), label).toBe(message);
  }
  expect(await journeyCount(pid)).toBe(rowsBefore);

  // A WhatsApp template with no values to fill is accepted.
  const noValues = await raw('POST', journeysPath(p), whatsapp({ template: { id: 'order_update', language: 'en' }, bodyParams: [] }), asFresh(p));
  expect(noValues.status).toBe(201);

  // A branch back to step 1 through a wait is kept, index 0 included.
  const loop = await raw(
    'POST',
    journeysPath(p),
    withSteps([{ type: 'wait', durationSeconds: 86_400 }, { type: 'branch', segmentId: vip.id, ifMember: 0, ifNot: 2 }, { type: 'exit' }]),
    asFresh(p),
  );
  expect(loop.status).toBe(201);
  const read = await raw('GET', `${journeysPath(p)}/${loop.body.data.id}`, undefined, asFresh(p));
  expect(read.body.data.steps[1]).toEqual({ type: 'branch', segmentId: vip.id, ifMember: 0, ifNot: 2 });

  // An edit that removes the trigger.
  const before = await journeyRow(loop.body.data.id);
  const noTrigger = await raw('PATCH', `${journeysPath(p)}/${loop.body.data.id}`, { trigger: null }, asFresh(p));
  expect(noTrigger.status).toBe(400);
  expect(messageOf(noTrigger)).toBe('A journey needs a trigger.');
  expect(await journeyRow(loop.body.data.id)).toEqual(before);
});

test('SEG-154 a partial edit keeps the other fields and is validated as a whole', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg154');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const trigger = { type: 'event', eventName: 'signup' };
  const steps = [{ type: 'branch', segmentId: vip.id, ifMember: 1, ifNot: 2 }, { type: 'exit' }, { type: 'wait', durationSeconds: 3600 }];
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Welcome', description: 'First week', trigger, steps });
  const path = `${journeysPath(p)}/${journey.id}`;

  const renamed = await raw('PATCH', path, { name: 'Renamed' }, as(p, clientIp));
  expect(renamed.status).toBe(200);
  expect(renamed.body.data).toMatchObject({ name: 'Renamed', description: 'First week', trigger, steps, status: 'draft' });
  expect(await journeyRow(journey.id)).toMatchObject({ name: 'Renamed', description: 'First week', trigger, steps });

  const newSteps = [{ type: 'wait', durationSeconds: 7200 }, { type: 'send_push', title: 'Still there?' }];
  const restepped = await raw('PATCH', path, { steps: newSteps }, as(p, clientIp));
  expect(restepped.status).toBe(200);
  expect(await journeyRow(journey.id)).toMatchObject({ name: 'Renamed', description: 'First week', trigger, steps: newSteps });

  // Steps that leave a branch pointing past the end are refused, and nothing changes.
  const stored = await journeyRow(journey.id);
  const broken = await raw('PATCH', path, { steps: [{ type: 'branch', segmentId: vip.id, ifMember: 1, ifNot: 2 }, { type: 'exit' }] }, as(p, clientIp));
  expect(broken.status).toBe(400);
  expect(messageOf(broken)).toBe('Step 1: the non-member path points at a step that does not exist.');
  // A new trigger is checked against the stored steps, and a rename against the stored
  // trigger and steps: the whole journey is validated, not only the fields sent.
  const blankTrigger = await raw('PATCH', path, { trigger: { type: 'event', eventName: ' ' } }, as(p, clientIp));
  expect(blankTrigger.status).toBe(400);
  expect(messageOf(blankTrigger)).toBe('An event trigger needs an event name.');
  expect(await journeyRow(journey.id)).toEqual(stored);

  await sql(`UPDATE journeys SET steps = $2 WHERE id = $1`, [journey.id, JSON.stringify([{ type: 'wait', durationSeconds: 10 }])]);
  const renameOnly = await raw('PATCH', path, { name: 'Renamed again' }, as(p, clientIp));
  expect(renameOnly.status).toBe(400);
  expect(messageOf(renameOnly)).toBe('Step 1: a wait must be at least 60 seconds.');
  expect((await journeyRow(journey.id))?.name).toBe('Renamed');
});

test('SEG-156 setting paused on a paused journey again', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg156');
  const pid = p.project.id;
  // A paused journey set to paused again: answered, nothing logged, nothing moved.
  const paused = await createJourney(p.owner, pid, clientIp, { name: 'Paused one' });
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'paused');
  const pausedRow = (await journeyRow(paused.id))!;
  expect(pausedRow.enrolled_through).not.toBeNull();
  const again = await raw('POST', `${journeysPath(p)}/${paused.id}/status`, { status: 'paused' }, as(p, clientIp));
  expect(again.status).toBe(201);
  expect(again.body.data).toMatchObject({ id: paused.id, status: 'paused' });
  const { updated_at: _before, ...unchanged } = pausedRow;
  const { updated_at: _after, ...now } = (await journeyRow(paused.id))!;
  expect(now).toEqual(unchanged);
  expect((await activityRows(pid, 'journey.status_changed')).map((row) => row.details)).toEqual([
    { from: 'draft', to: 'active' },
    { from: 'active', to: 'paused' },
  ]);
});

test('SEG-156 setting active on an active journey again', { annotation: { type: 'issue', description: 'SEG-156' } }, async ({ clientIp }) => {
  test.fail();
  const p = await segProject(clientIp, 'seg156-active');
  const pid = p.project.id;
  const status = (id: string, to: string) => raw('POST', `${journeysPath(p)}/${id}/status`, { status: to }, as(p, clientIp));

  // An active journey set to active again, clear of the minute tick that moves its watermark.
  const active = await createJourney(p.owner, pid, clientIp, { name: 'Active one' });
  await setJourneyStatus(p.owner, pid, clientIp, active.id, 'active');
  await clearOfTick();
  const watermark = await watermarkOf(active.id);
  expect(watermark).not.toBeNull();
  const activeAgain = await status(active.id, 'active');
  expect(activeAgain.status).toBe(201);
  expect(activeAgain.body.data).toMatchObject({ id: active.id, status: 'active' });
  expect((await activityRows(pid, 'journey.status_changed')).filter((row) => row.target_id === active.id)).toHaveLength(1);
  // Setting the same status again leaves the enrolment watermark where it was.
  expect((await watermarkOf(active.id))?.getTime()).toBe(watermark!.getTime());
});

test('SEG-157 two activations racing log one change', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg157');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Race' });
  const path = `${journeysPath(p)}/${journey.id}/status`;
  const [first, second] = await Promise.all([
    raw('POST', path, { status: 'active' }, asFresh(p)),
    raw('POST', path, { status: 'active' }, asFresh(p)),
  ]);
  expect([first.status, second.status]).toEqual([201, 201]);
  expect(first.body.data.status).toBe('active');
  expect(second.body.data.status).toBe('active');
  expect((await journeyRow(journey.id))?.status).toBe('active');
  const rows = await activityRows(pid, 'journey.status_changed');
  expect(rows.map((row) => row.details)).toEqual([{ from: 'draft', to: 'active' }]);
});

test('SEG-158 activation re-checks the stored definition', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg158');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Tampered' });
  // Written around the API, which would refuse a wait this short.
  await sql(`UPDATE journeys SET steps = $2 WHERE id = $1`, [journey.id, JSON.stringify([{ type: 'wait', durationSeconds: 10 }, { type: 'exit' }])]);
  const status = (to: string) => raw('POST', `${journeysPath(p)}/${journey.id}/status`, { status: to }, as(p, clientIp));

  const activate = await status('active');
  expect(activate.status).toBe(400);
  expect(messageOf(activate)).toBe('This journey cannot be activated: Step 1: a wait must be at least 60 seconds.');
  expect(await journeyRow(journey.id)).toMatchObject({ status: 'draft', enrolled_through: null });
  expect(await activityRows(pid, 'journey.status_changed')).toEqual([]);

  const pause = await status('paused');
  expect(pause.status).toBe(201);
  expect(pause.body.data.status).toBe('paused');
  const archive = await status('archived');
  expect(archive.status).toBe(201);
  expect((await journeyRow(journey.id))?.status).toBe('archived');
  expect((await activityRows(pid, 'journey.status_changed')).map((row) => row.details)).toEqual([
    { from: 'draft', to: 'paused' },
    { from: 'paused', to: 'archived' },
  ]);
  // Activating from archived is checked the same way.
  const again = await status('active');
  expect(again.status).toBe(400);
  expect(messageOf(again)).toBe('This journey cannot be activated: Step 1: a wait must be at least 60 seconds.');
});

test('SEG-160 journey stats', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg160');
  const pid = p.project.id;
  const empty = await createJourney(p.owner, pid, clientIp, { name: 'Nobody yet' });
  const busy = await createJourney(p.owner, pid, clientIp, { name: 'Busy' });
  await insertRuns(pid, busy.id, 'active', 2);
  await insertRuns(pid, busy.id, 'completed', 3);
  await insertRuns(pid, busy.id, 'exited', 1);
  await insertRuns(pid, busy.id, 'failed', 4);
  const x = await segProject(clientIp, 'seg160-x');
  const foreign = await createJourney(x.owner, x.project.id, clientIp, { name: 'Elsewhere' });
  await insertRuns(x.project.id, foreign.id, 'completed', 1);

  const stats = (project: SegProject, through: string, id: string) =>
    raw('GET', `/api/projects/${through}/journeys/${id}/stats`, undefined, as(project, clientIp));
  const none = await stats(p, pid, empty.id);
  expect(none.status).toBe(200);
  expect(none.body.data).toEqual({ active: 0, completed: 0, exited: 0, failed: 0 });
  const counts = await stats(p, pid, busy.id);
  expect(counts.body.data).toEqual({ active: 2, completed: 3, exited: 1, failed: 4 });

  const crossed = await stats(p, pid, foreign.id);
  expect(crossed.status).toBe(404);
  expect(messageOf(crossed)).toBe(JOURNEY_NOT_FOUND);
  // Its own project answers for it.
  const own = await stats(x, x.project.id, foreign.id);
  expect(own.body.data).toEqual({ active: 0, completed: 1, exited: 0, failed: 0 });
});

// ---- Journey runtime (the worker's tick, run on demand)

test('SEG-167 one active run per person, and a new one after it finishes', async ({ clientIp }) => {
  test.setTimeout(300_000);
  const p = await segProject(clientIp, 'seg167');
  const pid = p.project.id;
  const bob = uniqueId('u-bob');
  const phone = await addDevice(p, clientIp, { externalUserId: bob });
  const laptop = await addDevice(p, clientIp, { externalUserId: bob });
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Welcome',
    steps: [{ type: 'wait', durationSeconds: 60 }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await trackEvent(p, clientIp, phone, 'signup');
  await tickUntil(async () => (await runsOf(journey.id)).some((run) => run.current_step_index === 1), 'enrolled');
  let runs = await runsOf(journey.id);
  expect(runs.map((run) => [run.person_key, run.status, run.current_step_index])).toEqual([[bob, 'active', 1]]);

  // More of the trigger while the run is active, from both devices.
  await trackEvent(p, clientIp, phone, 'signup');
  await trackEvent(p, clientIp, phone, 'signup');
  const lastAt = await trackEvent(p, clientIp, laptop, 'signup');
  await tickNow();
  expect((await watermarkOf(journey.id))!.getTime()).toBeGreaterThan(lastAt.getTime());
  runs = await runsOf(journey.id);
  expect(runs.map((run) => [run.person_key, run.status])).toEqual([[bob, 'active']]);

  // The wait runs out; the run exits.
  await makeRunsDue(journey.id);
  await tickUntil(async () => (await runsOf(journey.id))[0]?.status === 'exited', 'exited');
  expect((await runsOf(journey.id)).map((run) => [run.person_key, run.status])).toEqual([[bob, 'exited']]);

  // Firing again after finishing starts a new run.
  await trackEvent(p, clientIp, laptop, 'signup');
  await tickUntil(async () => (await runsOf(journey.id)).length === 2, 'enrolled again');
  runs = await runsOf(journey.id);
  expect(runs.map((run) => [run.person_key, run.status])).toEqual([
    [bob, 'exited'],
    [bob, 'active'],
  ]);
});

test('SEG-168 a wait, then the next step; a final wait completes at once', async ({ clientIp }) => {
  test.setTimeout(330_000);
  const p = await segProject(clientIp, 'seg168');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const device = await addDevice(p, clientIp, { externalUserId: alice });
  const thenExit = await createJourney(p.owner, pid, clientIp, {
    name: 'Wait then exit',
    steps: [{ type: 'wait', durationSeconds: 60 }, { type: 'exit' }],
  });
  const waitOnly = await createJourney(p.owner, pid, clientIp, { name: 'Wait only', steps: [{ type: 'wait', durationSeconds: 60 }] });
  for (const journey of [thenExit, waitOnly]) await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await trackEvent(p, clientIp, device, 'signup');

  // The first tick enrols and takes the first step of both.
  await tickUntil(async () => (await runsOf(waitOnly.id))[0]?.status === 'completed', 'completed');
  const [finished] = await runsOf(waitOnly.id);
  expect(finished).toMatchObject({ person_key: alice, status: 'completed', current_step_index: 0, last_error: null, next_due_at: null });
  expect(finished.completed_at).not.toBeNull();
  const [waiting] = await sql<{ status: string; current_step_index: number; next_due_at: Date; updated_at: Date }>(
    `SELECT status, current_step_index, next_due_at, updated_at FROM journey_runs WHERE journey_id = $1`,
    [thenExit.id],
  );
  expect(waiting).toMatchObject({ status: 'active', current_step_index: 1 });
  const waitMs = waiting.next_due_at.getTime() - waiting.updated_at.getTime();
  expect(waitMs).toBeGreaterThan(58_000);
  expect(waitMs).toBeLessThanOrEqual(60_500);

  // A minute later the stack's own tick moves it on to the exit.
  await pollRuns(thenExit.id, [[alice, 'exited']], 180_000);
  const [exited] = await runsOf(thenExit.id);
  expect(exited.completed_at!.getTime()).toBeGreaterThanOrEqual(waiting.next_due_at.getTime() - 5000);
  expect(exited.current_step_index).toBe(1);

  const stats = async (id: string) => (await raw('GET', `${journeysPath(p)}/${id}/stats`, undefined, as(p, clientIp))).body.data;
  expect(await stats(thenExit.id)).toEqual({ active: 0, completed: 0, exited: 1, failed: 0 });
  expect(await stats(waitOnly.id)).toEqual({ active: 0, completed: 1, exited: 0, failed: 0 });
});

test('SEG-169 a push step sends to the person’s devices and carries the journey', async ({ clientIp }) => {
  test.setTimeout(300_000);
  const p = await segProject(clientIp, 'seg169');
  const pid = p.project.id;
  await seedFcmConfig(pid);
  const alice = uniqueId('u-alice');
  const phone = await addPushDevice(p, clientIp, { externalUserId: alice });
  const tablet = await addPushDevice(p, clientIp, { externalUserId: alice });
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Say hi', steps: [{ type: 'send_push', title: 'Hi' }, { type: 'exit' }] });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  expect(await campaignsOf(pid)).toEqual([]);
  await trackEvent(p, clientIp, phone.id, 'signup');

  await tickUntil(async () => (await campaignsOf(pid)).length > 0, 'sent');
  await tickUntil(async () => (await runsOf(journey.id))[0]?.status === 'exited', 'exited');
  const [run] = await runsOf(journey.id);
  expect(run).toMatchObject({ person_key: alice, status: 'exited', current_step_index: 1, last_error: null });

  const campaigns = await campaignsOf(pid);
  expect(campaigns).toHaveLength(1);
  expect(campaigns[0]).toMatchObject({ channel: 'push', title: 'Hi', target_type: 'devices' });
  expect(sortIds(campaigns[0].recipients)).toEqual(sortIds([phone.id, tablet.id]));
  expect(campaigns[0].data).toEqual({ journey_id: journey.id, journey_run_id: run.id, journey_step: '0' });
});

test('SEG-170 a push step is skipped for someone who cannot be reached', async ({ clientIp }) => {
  test.setTimeout(300_000);
  const p = await segProject(clientIp, 'seg170');
  const pid = p.project.id;
  await seedFcmConfig(pid);
  const carol = uniqueId('u-carol');
  const dave = uniqueId('u-dave');
  const erin = uniqueId('u-erin');
  const reachable = await addPushDevice(p, clientIp, { externalUserId: carol });
  const noToken = await addPushDevice(p, clientIp, { externalUserId: dave, token: false });
  const optedOut = await addPushDevice(p, clientIp, { externalUserId: erin, pushOptIn: false });
  // Frank has a token but was already sent a push today, at a cap of one a day.
  const frank = uniqueId('u-frank');
  const capped = await addPushDevice(p, clientIp, { externalUserId: frank });
  await sql(`UPDATE push_configs SET frequency_cap_per_day = 1 WHERE project_id = $1`, [pid]);
  const [earlier] = await sql<{ id: string }>(
    `INSERT INTO push_notification_logs (project_id, title, status, total_tokens, success_count, processed_tokens, completed_at)
     VALUES ($1, 'Earlier campaign', 'sent', 1, 1, 1, now()) RETURNING id`,
    [pid],
  );
  await sql(
    `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, platform, occurred_at)
     VALUES ($1, $2, $3, 'sent', 'android', now() - interval '1 hour')`,
    [pid, earlier.id, capped.id],
  );
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Say hi', steps: [{ type: 'send_push', title: 'Hi' }, { type: 'exit' }] });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  for (const device of [reachable, noToken, optedOut, capped]) await trackEvent(p, clientIp, device.id, 'signup');

  const allExited = async () => {
    const runs = await runsOf(journey.id);
    return runs.length === 4 && runs.every((run) => run.status === 'exited');
  };
  await tickUntil(allExited, 'all exited', 4);
  const runs = await runsOf(journey.id);
  expect(runs.map((run) => [run.person_key, run.status, run.last_error]).sort()).toEqual(
    [[carol, 'exited', null], [dave, 'exited', null], [erin, 'exited', null], [frank, 'exited', null]].sort(),
  );
  // Only the reachable person was sent anything.
  const campaigns = (await campaignsOf(pid)).filter((campaign) => campaign.id !== earlier.id);
  expect(campaigns).toHaveLength(1);
  expect(campaigns[0].recipients).toEqual([reachable.id]);
  expect(campaigns[0].data?.journey_id).toBe(journey.id);
  const stats = await raw('GET', `${journeysPath(p)}/${journey.id}/stats`, undefined, as(p, clientIp));
  expect(stats.body.data).toEqual({ active: 0, completed: 0, exited: 4, failed: 0 });
});

test('SEG-173 a branch on a deleted or never refreshed audience fails the run', async ({ page, clientIp }) => {
  test.setTimeout(300_000);
  const p = await segProject(clientIp, 'seg173');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const device = await addDevice(p, clientIp, { externalUserId: alice, row: { country: 'IN' } });
  const gone = await createSegment(p.owner, pid, clientIp, { name: 'Gone', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  // A materialised draft is never refreshed by the scheduler.
  const unrefreshed = await createSegment(p.owner, pid, clientIp, { name: 'Unrefreshed', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'draft' });
  const branchOn = (segmentId: string) => [{ type: 'branch', segmentId, ifMember: 1, ifNot: 1 }, { type: 'exit' }];
  const onGone = await createJourney(p.owner, pid, clientIp, { name: 'Branch on Gone', steps: branchOn(gone.id) });
  const onUnrefreshed = await createJourney(p.owner, pid, clientIp, { name: 'Branch on Unrefreshed', steps: branchOn(unrefreshed.id) });
  const other = await createJourney(p.owner, pid, clientIp, { name: 'Unaffected', steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }] });
  for (const journey of [onGone, onUnrefreshed, other]) await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  const deleted = await raw('DELETE', `/api/projects/${pid}/segments/${gone.id}`, undefined, as(p, clientIp));
  expect(deleted.status).toBe(200);
  await trackEvent(p, clientIp, device, 'signup');

  const settled = async () =>
    (await runsOf(onGone.id))[0]?.status === 'failed' &&
    (await runsOf(onUnrefreshed.id))[0]?.status === 'failed' &&
    (await runsOf(other.id))[0]?.current_step_index === 1;
  await tickUntil(settled, 'settled');
  expect((await runsOf(onGone.id))[0]).toMatchObject({
    person_key: alice,
    status: 'failed',
    last_error: `Branch step points at segment ${gone.id}, which no longer exists.`,
  });
  expect((await runsOf(onGone.id))[0].completed_at).not.toBeNull();
  expect((await runsOf(onUnrefreshed.id))[0]).toMatchObject({
    person_key: alice,
    status: 'failed',
    last_error: `Segment ${unrefreshed.id} ("Unrefreshed") has not been materialized yet, so it has no membership to read. Wait for the next refresh run, or switch it to live evaluation.`,
  });
  // The journey beside them took its step in the same ticks.
  expect((await runsOf(other.id))[0]).toMatchObject({ person_key: alice, status: 'active', current_step_index: 1, last_error: null });
  const stats = await raw('GET', `${journeysPath(p)}/${onGone.id}/stats`, undefined, as(p, clientIp));
  expect(stats.body.data).toEqual({ active: 0, completed: 0, exited: 0, failed: 1 });

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  for (const name of ['Branch on Gone', 'Branch on Unrefreshed']) {
    await expect(peopleCell(page, name)).toHaveText('0 inside0 completed · 0 exited · 1 failed');
    await expect(peopleCell(page, name).locator('span.text-destructive')).toHaveText('· 1 failed');
  }
  await expect(peopleCell(page, 'Unaffected')).toHaveText('1 inside0 completed · 0 exited');
});

/** A project where alice bought something, and a materialised, refreshed "Buyers". */
async function buyersWithAlice(ip: string, label: string) {
  const p = await segProject(ip, label);
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  const aliceDevice = await addDevice(p, ip, { externalUserId: alice, row: { country: 'IN' } });
  const bobDevice = await addDevice(p, ip, { externalUserId: bob, row: { country: 'IN' } });
  await insertEvent(pid, aliceDevice, 'purchase', { amount: 10 }, 2);
  const buyers = await createSegment(p.owner, pid, ip, {
    name: 'Buyers',
    definition: group([behaviour('purchase')]),
    evaluationMode: 'materialized',
    status: 'active',
  });
  await materialiseNow(buyers.id, pid);
  expect((await memberRows(buyers.id)).map((row) => row.person_key)).toEqual([alice]);
  return { p, pid, alice, bob, aliceDevice, bobDevice, buyers };
}

test('SEG-176 a segment-entry trigger enrols people who enter after activation', async ({ clientIp }) => {
  test.setTimeout(240_000);
  const { p, pid, alice, bob, bobDevice, buyers } = await buyersWithAlice(clientIp, 'seg176');
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Buyers welcome',
    trigger: { type: 'segment_entry', segmentId: buyers.id },
    steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  const activatedAt = (await watermarkOf(journey.id))!;

  await insertEvent(pid, bobDevice, 'purchase', { amount: 20 }, 0);
  await materialiseNow(buyers.id, pid);
  const members = Object.fromEntries((await memberRows(buyers.id)).map((row) => [row.person_key, row.entered_at]));
  expect(Object.keys(members).sort()).toEqual([alice, bob].sort());
  expect(members[alice].getTime()).toBeLessThan(activatedAt.getTime());
  expect(members[bob].getTime()).toBeGreaterThan(activatedAt.getTime());

  await tickUntil(async () => (await runsOf(journey.id)).length > 0, 'enrolled');
  await tickNow();
  expect((await watermarkOf(journey.id))!.getTime()).toBeGreaterThanOrEqual(members[bob].getTime());
  expect((await runsOf(journey.id)).map((run) => [run.person_key, run.status])).toEqual([[bob, 'active']]);
});

test('SEG-177 a segment-entry trigger on a live audience enrols people who match', { annotation: { type: 'issue', description: 'SEG-177' } }, async ({ clientIp }) => {
  test.fail();
  test.setTimeout(240_000);
  const p = await segProject(clientIp, 'seg177');
  const pid = p.project.id;
  const knownCountry = await createSegment(p.owner, pid, clientIp, { name: 'Known country', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Known country welcome',
    trigger: { type: 'segment_entry', segmentId: knownCountry.id },
    steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  const newcomer = uniqueId('u-new');
  await addDevice(p, clientIp, { externalUserId: newcomer, row: { country: 'IN' } });
  // They match the audience now.
  const members = await raw('GET', `/api/projects/${pid}/segments/${knownCountry.id}/members`, undefined, as(p, clientIp));
  expect(members.body.data.personKeys).toEqual([newcomer]);

  const before = new Date();
  await tickNow();
  await tickNow();
  expect((await watermarkOf(journey.id))!.getTime()).toBeGreaterThan(before.getTime());
  // Someone who comes to match the trigger audience is enrolled.
  expect((await runsOf(journey.id)).map((run) => run.person_key)).toEqual([newcomer]);
});

// ---- Coverage additions: audience editor and audiences

test('SEG-182 browser Back after creating an audience does not offer it as a new one', { annotation: { type: 'issue', description: 'SEG-182' } }, async ({ page, clientIp }) => {
  test.fail();
  const p = await projectWithPurchase(clientIp, 'seg182');
  const pid = p.project.id;
  await signIn(page, p.owner);
  await openAudienceEditor(page, pid);
  const posts = recordRequests(page, 'POST', `/api/projects/${pid}/segments`);
  await audienceName(page).fill('VIP');
  const counted = previewResponse(page);
  await choose(eventSelect(page), 'purchase');
  await counted;
  await page.getByRole('button', { name: 'Create audience' }).click();
  await expect(toastTitled(page, 'Audience created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', { name: 'VIP', exact: true })).toBeVisible();
  expect(posts).toHaveLength(1);
  await expect(toastTitled(page, 'Audience created')).toHaveCount(0, { timeout: 10_000 });

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/new$`));
  await expect(page.getByRole('heading', { name: 'New audience', exact: true })).toBeVisible();
  // A new-audience form starts empty, not holding the audience just saved.
  await expect.soft(audienceName(page)).toHaveValue('', { timeout: 5000 });
  await page.getByRole('button', { name: 'Create audience' }).click();
  await expect(toastTitled(page, 'Audience created').or(toastTitled(page, 'Give this audience a name')).first()).toBeVisible();
  const list = await raw('GET', `/api/projects/${pid}/segments`, undefined, as(p, clientIp));
  expect(list.body.data.filter((segment: { name: string }) => segment.name === 'VIP')).toHaveLength(1);
});

test('SEG-188 a late count never overwrites a newer one', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg188');
  await signIn(page, p.owner);
  await openAudienceEditor(page, p.project.id);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  await page.route('**/segments/preview', async (route) => {
    calls += 1;
    if (calls === 1) {
      await gate;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { count: 1 } }) });
    } else {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { count: 2 } }) });
    }
  });
  const isPreview = (url: string, method: string) => method === 'POST' && new URL(url).pathname.endsWith('/segments/preview');
  const firstSent = page.waitForRequest((r) => isPreview(r.url(), r.method()) && r.postDataJSON().definition.children[0].withinDays === 30);
  await choose(eventSelect(page), 'purchase');
  await firstSent;
  await expect(countFigure(page)).toHaveText('…');
  await expect(countCaption(page)).toHaveText('counting…');

  const second = page.waitForResponse((r) => isPreview(r.url(), r.request().method()) && r.request().postDataJSON().definition.children[0].withinDays === 31);
  await ruleCards(page).first().locator('input[type="number"]').nth(1).fill('31');
  await second;
  await expect(countFigure(page)).toHaveText('2');
  await expect(countCaption(page)).toHaveText('people match');

  const first = page.waitForResponse((r) => isPreview(r.url(), r.request().method()) && r.request().postDataJSON().definition.children[0].withinDays === 30);
  release();
  expect(await (await first).json()).toEqual({ data: { count: 1 } });
  // Two frames for React to commit anything the late answer would have set.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(countFigure(page)).toHaveText('2');
  await expect(countCaption(page)).toHaveText('people match');
  expect(calls).toBe(2);
});

test('SEG-192 an audience in error keeps its last good count and members', async ({ page, clientIp }) => {
  test.setTimeout(150_000);
  const p = await segProject(clientIp, 'seg192');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  await addDevice(p, clientIp, { externalUserId: alice, row: { country: 'IN' } });
  await addDevice(p, clientIp, { externalUserId: bob, row: { country: 'US' } });
  const segment = await createSegment(p.owner, pid, clientIp, { name: 'Known country', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  await materialiseNow(segment.id, pid);
  expect(await segmentRow(segment.id)).toMatchObject({ status: 'active', last_member_count: 2 });

  // A definition whose query fails (a number column against a text value), written
  // around the API's checks, and a refresh that is due.
  const bad = group([attribute('totalSessions', 'gt', 'abc')]);
  await sql(`UPDATE segments SET definition = $2, last_materialized_at = last_materialized_at - interval '2 hours' WHERE id = $1`, [
    segment.id,
    JSON.stringify(bad),
  ]);
  const lastGood = (await segmentRow(segment.id))!.last_materialized_at as Date;
  await enqueueMaterialise(segment.id, pid);
  await expect.poll(async () => (await segmentRow(segment.id))?.status, { timeout: 60_000, intervals: [500] }).toBe('error');
  const row = (await segmentRow(segment.id))!;
  expect(row.error_message).toContain('invalid input syntax');
  expect(row.last_member_count).toBe(2);
  expect((row.last_materialized_at as Date).getTime()).toBe(lastGood.getTime());

  const members = await raw('GET', `/api/projects/${pid}/segments/${segment.id}/members`, undefined, as(p, clientIp));
  expect(members.status).toBe(200);
  expect(members.body.data).toEqual({ personKeys: (await memberRows(segment.id)).map((m) => m.person_key), nextCursor: null });
  expect([...members.body.data.personKeys].sort()).toEqual([alice, bob].sort());

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  const cells = rowNamed(page, 'Known country').getByRole('cell');
  await expect(cells.nth(4).locator('[data-slot="badge"]')).toHaveText('Error');
  await expect(rowNamed(page, 'Known country').locator('svg.text-destructive')).toBeVisible();
  await expect(cells.nth(3)).toHaveText('2');
});

test('SEG-196 cursor paging on a materialised audience', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg196');
  const pid = p.project.id;
  for (const label of ['u-ann', 'u-ben', 'u-cat']) await addDevice(p, clientIp, { externalUserId: uniqueId(label), row: { country: 'IN' } });
  const segment = await createSegment(p.owner, pid, clientIp, { name: 'Known country', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  await materialiseNow(segment.id, pid);
  const keys = (await memberRows(segment.id)).map((row) => row.person_key);
  expect(keys).toHaveLength(3);
  const path = `/api/projects/${pid}/segments/${segment.id}/members`;

  const first = await raw('GET', `${path}?limit=2`, undefined, as(p, clientIp));
  expect(first.status).toBe(200);
  expect(first.body.data).toEqual({ personKeys: keys.slice(0, 2), nextCursor: keys[1] });
  const second = await raw('GET', `${path}?limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor)}`, undefined, as(p, clientIp));
  expect(second.body.data).toEqual({ personKeys: [keys[2]], nextCursor: null });
  const past = await raw('GET', `${path}?cursor=zzzz`, undefined, as(p, clientIp));
  expect(past.body.data).toEqual({ personKeys: [], nextCursor: null });
});

// ---- Coverage additions: journey editor and list

test('SEG-198 audience names with markup render as text on journey surfaces', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg198');
  const pid = p.project.id;
  const segment = await createSegment(p.owner, pid, clientIp, { name: MARKUP, definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Markup',
    trigger: { type: 'segment_entry', segmentId: segment.id },
    steps: [{ type: 'branch', segmentId: segment.id, ifMember: 1, ifNot: 2 }, { type: 'exit' }, { type: 'wait', durationSeconds: 3600 }],
  });
  const dialogs = recordDialogs(page);
  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await expect(rowNamed(page, 'Markup').getByRole('cell').nth(2)).toHaveText(`When someone enters ${MARKUP}`);

  await openJourney(page, pid, journey.id, 'Markup');
  const triggerSegment = cardTitled(page, 'Trigger').getByRole('combobox').nth(1);
  await expect(triggerSegment).toHaveText(MARKUP);
  expect(await selectOptions(triggerSegment)).toEqual([MARKUP]);
  const branch = stepCard(page, 1);
  await expect(branch).toContainText(`If in "${MARKUP}"`);
  const selects = branchSelects(branch);
  await expect(selects.segment).toHaveText(MARKUP);
  expect(await selectOptions(selects.segment)).toEqual([MARKUP]);
  await expect(selects.member).toHaveText(`2. Exit the journey`);
  expect(await selectOptions(selects.member)).toEqual([`1. If in "${MARKUP}"`, '2. Exit the journey', '3. Wait 1 hours']);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('SEG-199 saving in a tab that missed an activation is refused', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg199');
  const pid = p.project.id;
  const welcome = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  const paused = await createJourney(p.owner, pid, clientIp, { name: 'Welcome back' });
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'paused');
  await signIn(page, p.owner);
  await openJourney(page, pid, welcome.id, 'Welcome');

  // Another tab activates it from the list.
  const other = await page.context().newPage();
  await openJourneys(other, pid);
  await rowNamed(other, 'Welcome').getByRole('button', { name: 'Activate' }).click();
  await other.getByRole('dialog').getByRole('button', { name: 'Activate journey' }).click();
  await expect(toastTitled(other, 'Journey activated')).toBeVisible();
  expect((await journeyRow(welcome.id))?.status).toBe('active');
  await other.close();

  const stale = async (id: string, name: string) => {
    await journeyName(page).fill(`${name} renamed`);
    const save = page.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/journeys/${id}`)),
      save.click(),
    ]);
    expect(response.status()).toBe(400);
    const toast = toastTitled(page, 'Could not save journey');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(EDIT_ACTIVE);
    await expect(journeyName(page)).toHaveValue(`${name} renamed`);
    expect(await journeyRow(id)).toMatchObject({ name, status: 'active' });
    await page.reload();
    await expect(page.getByText('This journey is active', { exact: true })).toBeVisible();
    await expect(journeyName(page)).toHaveValue(name);
  };
  await stale(welcome.id, 'Welcome');

  // A paused journey resumed elsewhere.
  await openJourney(page, pid, paused.id, 'Welcome back');
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'active');
  await stale(paused.id, 'Welcome back');
});

test('SEG-203 a stale Activate on a journey archived elsewhere starts a new watermark', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg203');
  const pid = p.project.id;
  const draft = await createJourney(p.owner, pid, clientIp, { name: 'D' });
  const paused = await createJourney(p.owner, pid, clientIp, { name: 'P' });
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'paused');
  await sql(`UPDATE journeys SET enrolled_through = now() - interval '2 days' WHERE id = $1`, [paused.id]);
  const oldWatermark = (await watermarkOf(paused.id))!;

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  const second = await page.context().newPage();
  await openJourneys(second, pid);
  for (const journey of [draft, paused]) await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'archived');

  const activateFrom = async (tab: Page, journey: { id: string; name: string }, button: string, copy: string) => {
    await rowNamed(tab, journey.name).getByRole('button', { name: button }).click();
    const dialog = tab.getByRole('dialog');
    await expect(dialog).toContainText(copy);
    const before = Date.now();
    await dialog.getByRole('button', { name: 'Activate journey' }).click();
    await expect(toastTitled(tab, 'Journey activated')).toBeVisible();
    const row = await journeyRow(journey.id);
    expect(row?.status).toBe('active');
    const watermark = new Date(row?.enrolled_through).getTime();
    expect(watermark).toBeGreaterThanOrEqual(before - 1000);
    expect(watermark).toBeLessThanOrEqual(Date.now() + 1000);
    const rows = (await activityRows(pid, 'journey.status_changed')).filter((entry) => entry.target_id === journey.id);
    expect(rows.at(-1)?.details).toEqual({ from: 'archived', to: 'active' });
  };
  await activateFrom(page, draft, 'Activate', FIRST_ACTIVATION);
  await activateFrom(second, paused, 'Resume', RESUME_COPY);
  expect((await watermarkOf(paused.id))!.getTime()).toBeGreaterThan(oldWatermark.getTime());
});

test('SEG-206 a dashboard save keeps a WhatsApp step’s template details', { annotation: { type: 'issue', description: 'SEG-206' } }, async ({ page, clientIp }) => {
  test.fail();
  const p = await segProject(clientIp, 'seg206');
  const pid = p.project.id;
  const content = {
    template: { id: 'order_update', name: 'Order update', language: 'en_US', category: 'UTILITY', paramNames: ['first_name'] },
    bodyParams: ['{{firstName|there}}'],
    headerText: 'Hi',
    headerMediaUrl: 'https://example.com/a.png',
    headerMediaType: 'image',
    buttonParams: ['abc'],
    previewText: 'Hello {{1}}',
  };
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Order news', steps: [{ type: 'send_whatsapp', content }] });
  const before = (await journeyRow(journey.id))!.steps;
  expect(before).toEqual([{ type: 'send_whatsapp', content }]);

  await signIn(page, p.owner);
  await openJourney(page, pid, journey.id, 'Order news');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/journeys/${journey.id}`)),
    page.getByRole('button', { name: 'Save changes' }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(toastTitled(page, 'Journey updated')).toBeVisible();
  // Saving without an edit stores the step as it was.
  expect((await journeyRow(journey.id))!.steps).toEqual(before);
});

// ---- Coverage additions: runtime after status changes, races, re-entry

test('SEG-205 runs keep advancing after archiving or moving back to draft', async ({ clientIp }) => {
  test.setTimeout(300_000);
  const p = await segProject(clientIp, 'seg205');
  const pid = p.project.id;
  await seedFcmConfig(pid);
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  const aliceDevice = await addPushDevice(p, clientIp, { externalUserId: alice });
  const bobDevice = await addPushDevice(p, clientIp, { externalUserId: bob });
  const steps = [{ type: 'wait', durationSeconds: 60 }, { type: 'send_push', title: 'Hi' }, { type: 'exit' }];
  const archived = await createJourney(p.owner, pid, clientIp, { name: 'Archived one', steps });
  const drafted = await createJourney(p.owner, pid, clientIp, { name: 'Drafted one', steps });
  for (const journey of [archived, drafted]) {
    await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
    // Alice is waiting on the wait.
    await insertRun(pid, journey.id, alice, { stepIndex: 1, dueInSeconds: 3600 });
  }
  await setJourneyStatus(p.owner, pid, clientIp, archived.id, 'archived');
  await setJourneyStatus(p.owner, pid, clientIp, drafted.id, 'draft');
  // Someone fires the trigger after: neither journey enrols any more.
  await trackEvent(p, clientIp, bobDevice.id, 'signup');

  for (const journey of [archived, drafted]) await makeRunsDue(journey.id);
  const bothExited = async () => {
    for (const journey of [archived, drafted]) {
      if ((await runsOf(journey.id)).some((run) => run.status !== 'exited')) return false;
    }
    return true;
  };
  await tickUntil(bothExited, 'exited', 4);
  const campaigns = await campaignsOf(pid);
  expect(campaigns.map((campaign) => campaign.data?.journey_id).sort()).toEqual([archived.id, drafted.id].sort());
  for (const journey of [archived, drafted]) {
    const runs = await runsOf(journey.id);
    expect(runs.map((run) => [run.person_key, run.status])).toEqual([[alice, 'exited']]);
    const campaign = campaigns.find((c) => c.data?.journey_id === journey.id)!;
    expect(campaign).toMatchObject({ title: 'Hi', recipients: [aliceDevice.id] });
    expect(campaign.data).toEqual({ journey_id: journey.id, journey_run_id: runs[0].id, journey_step: '1' });
  }
  expect((await journeyRow(archived.id))?.status).toBe('archived');
  expect((await journeyRow(drafted.id))?.status).toBe('draft');
});

test('SEG-218 a journey edit racing its activation does not undo the activation', { annotation: { type: 'issue', description: 'SEG-218' } }, async ({ clientIp }) => {
  test.fail();
  const p = await segProject(clientIp, 'seg218');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });
  const race = await createJourney(p.owner, pid, clientIp, { name: 'Race', steps: [{ type: 'wait', durationSeconds: 60 }, { type: 'exit' }] });
  const newSteps = [{ type: 'branch', segmentId: vip.id, ifMember: 1, ifNot: 2 }, { type: 'wait', durationSeconds: 60 }, { type: 'exit' }];

  await clearOfTick();
  const release = await lockTable('segments');
  let edit: Promise<Awaited<ReturnType<typeof raw>>>;
  try {
    // The edit reads the draft, then waits on the audience check.
    edit = raw('PATCH', `${journeysPath(p)}/${race.id}`, { steps: newSteps }, asFresh(p));
    await waitForLockWaiter('segments', '%COUNT(%FROM "segments"%');
    const activation = await raw('POST', `${journeysPath(p)}/${race.id}/status`, { status: 'active' }, asFresh(p));
    expect(activation.status).toBe(201);
    expect(activation.body.data.status).toBe('active');
  } finally {
    await release();
  }
  const edited = await edit!;
  const rows = await activityRows(pid, 'journey.status_changed');
  expect(rows.map((row) => row.details)).toEqual([{ from: 'draft', to: 'active' }]);
  // Either the edit is refused, or it lands without undoing the activation.
  const stored = (await journeyRow(race.id))!;
  expect.soft(stored.status).toBe('active');
  expect.soft(stored.enrolled_through).not.toBeNull();
  if (edited.status === 200) expect.soft(edited.body.data.status).toBe('active');
  else expect.soft(messageOf(edited)).toBe(EDIT_ACTIVE);
});

test('SEG-219 an audience edit racing a materialisation run', { annotation: { type: 'issue', description: 'SEG-219' } }, async ({ clientIp }) => {
  test.fail();
  test.setTimeout(150_000);
  const p = await segProject(clientIp, 'seg219');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  const aliceDevice = await addDevice(p, clientIp, { externalUserId: alice, row: { country: 'IN' } });
  const bobDevice = await addDevice(p, clientIp, { externalUserId: bob, row: { country: 'IN' } });
  await insertEvent(pid, aliceDevice, 'purchase', { amount: 10 }, 2);
  await insertEvent(pid, bobDevice, 'signup', null, 2);
  const purchased = group([behaviour('purchase')]);
  const signedUp = group([behaviour('signup')]);
  const make = (name: string) => createSegment(p.owner, pid, clientIp, { name, definition: purchased, evaluationMode: 'materialized', status: 'active' });
  const buyers = await make('Buyers');
  const drafted = await make('Buyers drafted');
  for (const segment of [buyers, drafted]) await materialiseNow(segment.id, pid);
  for (const segment of [buyers, drafted]) expect((await memberRows(segment.id)).map((row) => row.person_key)).toEqual([alice]);

  /** Starts a refresh that blocks inside its query, sends `patch`, then lets the refresh finish. */
  const raceRefresh = async (segmentId: string, patch: Record<string, unknown>) => {
    await clearOfTick();
    const release = await lockTable('device_identities');
    try {
      await enqueueMaterialise(segmentId, pid);
      await waitForLockWaiter('device_identities', 'SELECT person_key FROM (%');
      const patched = await raw('PATCH', `/api/projects/${pid}/segments/${segmentId}`, patch, asFresh(p));
      expect(patched.status).toBe(200);
    } finally {
      await release();
    }
    await expect.poll(async () => (await segmentRow(segmentId))?.materializing_at, { timeout: 40_000, intervals: [500] }).toBeNull();
  };

  // (a) The rules change while the run holds the old ones.
  await raceRefresh(buyers.id, { definition: signedUp });
  const afterEdit = (await segmentRow(buyers.id))!;
  const members = (await memberRows(buyers.id)).map((row) => row.person_key);
  // Members served as fresh match the stored rules.
  if (afterEdit.last_materialized_at !== null) expect.soft(members).toEqual([bob]);

  // (b) The audience is set to draft while a run is in flight.
  await raceRefresh(drafted.id, { status: 'draft' });
  expect.soft((await segmentRow(drafted.id))?.status).toBe('draft');
});

test('SEG-222 leaving an audience and matching again enrols again', async ({ clientIp }) => {
  test.setTimeout(300_000);
  const { p, pid, bob, bobDevice, buyers } = await buyersWithAlice(clientIp, 'seg222');
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Buyers welcome',
    trigger: { type: 'segment_entry', segmentId: buyers.id },
    steps: [{ type: 'wait', durationSeconds: 60 }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');

  await insertEvent(pid, bobDevice, 'purchase', { amount: 20 }, 0);
  await materialiseNow(buyers.id, pid);
  const firstEntry = (await memberRows(buyers.id)).find((row) => row.person_key === bob)!.entered_at;
  await tickUntil(async () => (await runsOf(journey.id)).length === 1, 'enrolled');
  expect((await runsOf(journey.id)).map((run) => run.person_key)).toEqual([bob]);
  // His run finishes.
  await makeRunsDue(journey.id);
  await tickUntil(async () => (await runsOf(journey.id))[0]?.status !== 'active', 'finished');
  expect((await runsOf(journey.id)).map((run) => [run.person_key, run.status])).toEqual([[bob, 'exited']]);

  // He stops matching, and the refresh removes him.
  await sql(`DELETE FROM user_events WHERE device_identity_id = $1 AND event_name = 'purchase'`, [bobDevice]);
  await materialiseNow(buyers.id, pid);
  expect((await memberRows(buyers.id)).map((row) => row.person_key)).not.toContain(bob);
  // He matches again, with a new entry time.
  await insertEvent(pid, bobDevice, 'purchase', { amount: 30 }, 0);
  await materialiseNow(buyers.id, pid);
  const secondEntry = (await memberRows(buyers.id)).find((row) => row.person_key === bob)!.entered_at;
  expect(secondEntry.getTime()).toBeGreaterThan(firstEntry.getTime());

  await tickUntil(async () => (await runsOf(journey.id)).length === 2, 'enrolled again');
  expect((await runsOf(journey.id)).map((run) => [run.person_key, run.status])).toEqual([
    [bob, 'exited'],
    [bob, 'active'],
  ]);
});

test('SEG-223 a person whose key changes is enrolled again under the new key', async ({ clientIp }) => {
  test.setTimeout(240_000);
  const p = await segProject(clientIp, 'seg223');
  const pid = p.project.id;
  const anonymous = await addDevice(p, clientIp, {});
  const fingerprint = (await sql<{ device_fingerprint: string }>(`SELECT device_fingerprint FROM device_identities WHERE id = $1`, [anonymous]))[0]
    .device_fingerprint;
  const deviceKey = `device:${anonymous}`;
  const hasPlatform = await createSegment(p.owner, pid, clientIp, {
    name: 'Has platform',
    definition: group([attribute('platform', 'exists')]),
    evaluationMode: 'materialized',
    status: 'active',
  });
  await materialiseNow(hasPlatform.id, pid);
  expect((await memberRows(hasPlatform.id)).map((row) => row.person_key)).toEqual([deviceKey]);
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Platform welcome',
    trigger: { type: 'segment_entry', segmentId: hasPlatform.id },
    steps: [{ type: 'wait', durationSeconds: 86_400 }, { type: 'send_push', title: 'Hi' }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  // The device is already inside it, waiting a day.
  const first = await insertRun(pid, journey.id, deviceKey, { stepIndex: 1, dueInSeconds: 86_400 });

  const personId = uniqueId('u-x');
  expect(await identifyAs(p, clientIp, fingerprint, personId)).toBe(anonymous);
  await materialiseNow(hasPlatform.id, pid);
  const members = await memberRows(hasPlatform.id);
  expect(members.map((row) => row.person_key)).toEqual([personId]);
  expect(members[0].entered_at.getTime()).toBeGreaterThan((await watermarkOf(journey.id))!.getTime() - 120_000);

  await tickUntil(async () => (await runsOf(journey.id)).length === 2, 'enrolled again');
  const runs = await runsOf(journey.id);
  expect(runs.map((run) => [run.person_key, run.status]).sort()).toEqual([[deviceKey, 'active'], [personId, 'active']].sort());
  expect(runs.find((run) => run.id === first.id)).toMatchObject({ person_key: deviceKey, status: 'active', current_step_index: 1 });
});

test('SEG-224 an active journey whose trigger audience is deleted', async ({ page, clientIp }) => {
  test.setTimeout(240_000);
  const p = await segProject(clientIp, 'seg224');
  const pid = p.project.id;
  await addDevice(p, clientIp, { externalUserId: uniqueId('u-lapsed'), row: { country: 'IN' } });
  const lapsed = await createSegment(p.owner, pid, clientIp, { name: 'Lapsed', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  const winBack = await createJourney(p.owner, pid, clientIp, {
    name: 'Win back',
    trigger: { type: 'segment_entry', segmentId: lapsed.id },
    steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, winBack.id, 'active');

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await rowNamed(page, 'Lapsed').getByRole('button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete audience' }).click();
  await expect(toastTitled(page, 'Audience deleted')).toBeVisible();
  expect(await segmentRow(lapsed.id)).toBeUndefined();

  // The tick moves the watermark on and enrols nobody, without an error for it.
  const deletedAt = new Date();
  const output = await tickNow();
  expect(output).not.toContain(winBack.id);
  expect((await watermarkOf(winBack.id))!.getTime()).toBeGreaterThan(deletedAt.getTime());
  expect(await runsOf(winBack.id)).toEqual([]);

  await openJourneys(page, pid);
  const row = rowNamed(page, 'Win back');
  await expect(row.getByRole('cell').nth(2)).toHaveText('When someone enters a segment that no longer exists');
  await row.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pause journey' }).click();
  await expect(toastTitled(page, 'Journey paused')).toBeVisible();
  expect((await journeyRow(winBack.id))?.status).toBe('paused');

  await row.getByRole('button', { name: 'Resume' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Activate journey' }).click();
  const refused = toastTitled(page, 'Could not activate journey');
  await expect(refused).toBeVisible();
  await expect(refused).toContainText(SEGMENT_FOREIGN);
  expect((await journeyRow(winBack.id))?.status).toBe('paused');
});

test('SEG-225 a push step with tokens but no active push config fails the run', async ({ page, clientIp }) => {
  test.setTimeout(240_000);
  const p = await segProject(clientIp, 'seg225');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const device = await addPushDevice(p, clientIp, { externalUserId: alice });
  expect(device.token).not.toBeNull();
  expect(await sql(`SELECT id FROM push_configs WHERE project_id = $1 AND is_active`, [pid])).toEqual([]);
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Say hi', steps: [{ type: 'send_push', title: 'Hi' }, { type: 'exit' }] });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  await trackEvent(p, clientIp, device.id, 'signup');

  await tickUntil(async () => (await runsOf(journey.id))[0]?.status === 'failed', 'failed');
  expect((await runsOf(journey.id))[0]).toMatchObject({ person_key: alice, status: 'failed', current_step_index: 0, last_error: NOT_CONFIGURED });
  expect(await campaignsOf(pid)).toEqual([]);

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await expect(peopleCell(page, 'Say hi').locator('span.text-destructive')).toHaveText('· 1 failed');
});

test('SEG-229 stranded runs are returned to the queue', async ({ clientIp }) => {
  test.setTimeout(240_000);
  const p = await segProject(clientIp, 'seg229');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'Welcome', steps: [{ type: 'wait', durationSeconds: 60 }, { type: 'exit' }] });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  const stranded = await insertRun(pid, journey.id, uniqueId('u-stranded'), { stepIndex: 1, dueInSeconds: null });
  const fresh = await insertRun(pid, journey.id, uniqueId('u-fresh'), { stepIndex: 1, dueInSeconds: null });
  // Claimed and never resolved: no due time, last touched 11 minutes ago (the other 5).
  await sql(`UPDATE journey_runs SET next_due_at = NULL, updated_at = now() - interval '11 minutes' WHERE id = $1`, [stranded.id]);
  await sql(`UPDATE journey_runs SET next_due_at = NULL, updated_at = now() - interval '5 minutes' WHERE id = $1`, [fresh.id]);

  await clearOfTick();
  const sweptFrom = Date.now();
  const output = await sweepStrandedRunsNow();
  expect(output).toMatch(/Returned \d+ stranded journey run\(s\) to the queue/);
  const byId = async () => Object.fromEntries((await runsOf(journey.id)).map((run) => [run.id, run]));
  let runs = await byId();
  expect(runs[stranded.id]).toMatchObject({ status: 'active', current_step_index: 1 });
  expect(runs[stranded.id].next_due_at!.getTime()).toBeGreaterThanOrEqual(sweptFrom - 2000);
  expect(runs[stranded.id].next_due_at!.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
  expect(runs[fresh.id]).toMatchObject({ status: 'active', next_due_at: null });

  // The next tick carries out its step again: the exit.
  await tickUntil(async () => (await byId())[stranded.id].status === 'exited', 'exited');
  runs = await byId();
  expect(runs[stranded.id]).toMatchObject({ status: 'exited', current_step_index: 1 });
  expect(runs[fresh.id]).toMatchObject({ status: 'active', next_due_at: null });
});

test('SEG-230 one project’s backlog does not starve another’s runs', async ({ clientIp }) => {
  test.setTimeout(240_000);
  const big = await segProject(clientIp, 'seg230');
  const small = await segProject(clientIp, 'seg230-p3');
  const bigJourney = await createJourney(big.owner, big.project.id, clientIp, { name: 'Backlog', steps: [{ type: 'exit' }] });
  const smallJourney = await createJourney(small.owner, small.project.id, clientIp, { name: 'One run', steps: [{ type: 'exit' }] });
  await setJourneyStatus(big.owner, big.project.id, clientIp, bigJourney.id, 'active');
  await setJourneyStatus(small.owner, small.project.id, clientIp, smallJourney.id, 'active');

  // A backlog several times the 500-run cap of a tick, all due long before the other
  // project's one run: other tests in this file run ticks of their own at the same time,
  // so the backlog has to outlast a few ticks, not one.
  const BACKLOG = 2000;
  await clearOfTick();
  await sql(
    `INSERT INTO journey_runs (project_id, journey_id, person_key, current_step_index, steps_taken, status, next_due_at)
     SELECT $1, $2, 'backlog-' || g, 0, 0, 'active', now() - interval '2 hours' - g * interval '1 second'
       FROM generate_series(1, $3::int) g`,
    [big.project.id, bigJourney.id, BACKLOG],
  );
  const late = await insertRun(small.project.id, smallJourney.id, uniqueId('u-late'), { stepIndex: 0, dueInSeconds: -60 });
  try {
    await tickNow();

    expect((await runsOf(smallJourney.id)).find((run) => run.id === late.id)?.status).toBe('exited');
    const counts = await sql<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM journey_runs WHERE journey_id = $1 GROUP BY status`,
      [bigJourney.id],
    );
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.n]));
    // Some of the backlog moved, but no tick took all of it: plenty is left for later.
    expect(byStatus.exited ?? 0).toBeGreaterThan(0);
    expect(byStatus.active ?? 0).toBeGreaterThanOrEqual(100);
  } finally {
    // The rest would otherwise take the next ticks' slots from other tests.
    await sql(`DELETE FROM journey_runs WHERE journey_id = $1`, [bigJourney.id]);
  }
});

test('SEG-234 people who entered an audience during a suspension are not enrolled afterwards', async ({ browser, baseURL, clientIp }) => {
  test.setTimeout(330_000);
  const { p, pid, bob, bobDevice, buyers } = await buyersWithAlice(clientIp, 'seg234');
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: 'Buyers welcome',
    trigger: { type: 'segment_entry', segmentId: buyers.id },
    steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
  });
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'active');
  const staff = await staffSession(browser, baseURL);
  await suspendTenant(staff, p.owner);

  // Bob enters the audience while the owner is suspended: audiences keep refreshing.
  await insertEvent(pid, bobDevice, 'purchase', { amount: 20 }, 0);
  await materialiseNow(buyers.id, pid);
  const entered = (await memberRows(buyers.id)).find((row) => row.person_key === bob)!.entered_at;
  await tickNow();
  expect((await watermarkOf(journey.id))!.getTime()).toBeGreaterThan(entered.getTime());
  expect(await runsOf(journey.id)).toEqual([]);

  const reactivatedAt = new Date();
  await reactivateTenant(staff, p.owner);
  await tickNow();
  await waitForTickAfter(journey.id, reactivatedAt);
  expect((await runsOf(journey.id)).map((run) => run.person_key)).not.toContain(bob);
  expect(await runsOf(journey.id)).toEqual([]);
  // The journey itself is running again: a newcomer after reactivation is enrolled.
  const carol = uniqueId('u-carol');
  const carolDevice = await addDevice(p, clientIp, { externalUserId: carol, row: { country: 'IN' } });
  await insertEvent(pid, carolDevice, 'purchase', { amount: 5 }, 0);
  await materialiseNow(buyers.id, pid);
  await tickUntil(async () => (await runsOf(journey.id)).length > 0, 'enrolled');
  expect((await runsOf(journey.id)).map((run) => run.person_key)).toEqual([carol]);
});

test('SEG-235 creating, editing and previewing an audience writes no activity', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg235');
  const pid = p.project.id;
  const before = await activityCount(pid);

  const segment = await createSegment(p.owner, pid, clientIp, { name: 'SEG-235', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'draft' });
  for (const patch of [{ name: 'SEG-235 renamed' }, { definition: group([behaviour('purchase')]) }, { status: 'active' }]) {
    const response = await raw('PATCH', `/api/projects/${pid}/segments/${segment.id}`, patch, as(p, clientIp));
    expect(response.status).toBe(200);
  }
  const preview = await raw('POST', `/api/projects/${pid}/segments/preview`, { definition: KNOWN_COUNTRY }, as(p, clientIp));
  expect(preview.status).toBe(201);

  // The same through the editor: create, then edit and save.
  await signIn(page, p.owner);
  await openAudienceEditor(page, pid);
  await audienceName(page).fill('SEG-235 editor');
  const counted = previewResponse(page);
  await choose(eventSelect(page), 'purchase');
  await counted;
  await page.getByRole('button', { name: 'Create audience' }).click();
  await expect(toastTitled(page, 'Audience created')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'SEG-235 editor', exact: true })).toBeVisible();
  await audienceName(page).fill('SEG-235 editor saved');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toastTitled(page, 'Audience saved')).toBeVisible();

  // Journeys likewise: create and edit write nothing.
  const journey = await createJourney(p.owner, pid, clientIp, { name: 'SEG-235 journey' });
  const renamed = await raw('PATCH', `${journeysPath(p)}/${journey.id}`, { name: 'SEG-235 journey renamed' }, as(p, clientIp));
  expect(renamed.status).toBe(200);
  expect(await activityCount(pid)).toBe(before);

  // What is logged is: a status change and a delete each write one row.
  await setJourneyStatus(p.owner, pid, clientIp, journey.id, 'archived');
  expect(await activityCount(pid)).toBe(before + 1);
  const deleted = await raw('DELETE', `/api/projects/${pid}/segments/${segment.id}`, undefined, as(p, clientIp));
  expect(deleted.status).toBe(200);
  expect(await activityCount(pid)).toBe(before + 2);
  const deletedJourney = await raw('DELETE', `${journeysPath(p)}/${journey.id}`, undefined, as(p, clientIp));
  expect(deletedJourney.status).toBe(200);
  expect(await activityCount(pid)).toBe(before + 3);
  expect((await activityRows(pid, 'content.deleted')).map((row) => row.target_label)).toEqual(['SEG-235 renamed', 'SEG-235 journey renamed']);
});

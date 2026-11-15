import { randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { createAccount, createProject } from '../../support/api';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addDevice,
  addTeammate,
  allActivity,
  attribute,
  audienceDescription,
  audienceName,
  behaviour,
  choose,
  countCaption,
  countFigure,
  createJourney,
  createSegment,
  group,
  holdRequests,
  insertEvent,
  insertRuns,
  journeyRow,
  liveMembers,
  markMaterialised,
  memberKeys,
  messageOf,
  openViewAs,
  previewCount,
  previewResponse,
  raw,
  recordDialogs,
  recordRequests,
  rowNamed,
  runCount,
  segmentRow,
  segProject,
  setJourneyStatus,
  sql,
  toastTitled,
  uniqueId,
  viewAsHandoff,
  viewAsTokenOf,
  type Node,
  type SegmentRecord,
  type SegProject,
} from '../../support/areas/seg';

/**
 * Audiences (the API's segments) and journeys: the audiences list and its delete, the
 * editor creating, editing and refusing what it cannot show, the live count and the
 * preview's typing of values, members through the API, access for every role, for
 * other tenants and for view-as, and the journeys list's status changes and delete.
 * People arrive through the SDK's identify route; events are written to user_events
 * directly so they can be back-dated.
 */

const PROJECT_NOT_FOUND = 'Project not found';
const READ_ONLY = 'Impersonation sessions are read-only';
const SEGMENT_FOREIGN = 'A segment in this journey does not belong to this project.';
const EDIT_BLOCKED = 'Pause this journey first. People are partway through its steps, so editing an active journey is not allowed.';
const DELETE_BLOCKED = 'Pause this journey first. An active journey cannot be deleted while people are moving through it.';
const NOT_BUILT_HERE =
  'It nests more deeply, or negates a group, in a way this editor does not offer. Rather than flatten it — which would quietly change who the audience contains — it is shown as stored. Edit it through the API, or create a new audience to replace it.';

function notMaterialised(id: string, name: string): string {
  return (
    `Segment ${id} ("${name}") has not been materialized yet, so it has no membership to read. ` +
    'Wait for the next refresh run, or switch it to live evaluation.'
  );
}

const KNOWN_COUNTRY = group([attribute('country', 'exists')]);

async function openAudiences(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/segments`);
  await expect(page.getByRole('heading', { name: 'Audiences', exact: true })).toBeVisible();
}

async function openJourneys(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/journeys`);
  await expect(page.getByRole('heading', { name: 'Journeys', exact: true })).toBeVisible();
}

/** A project with a person who did `purchase`, so the event picker has an entry. */
async function projectWithPurchase(ip: string, label: string): Promise<SegProject> {
  const p = await segProject(ip, label);
  const device = await addDevice(p, ip, { externalUserId: uniqueId('u-buyer') });
  await insertEvent(p.project.id, device, 'purchase', { amount: 10 }, 2);
  return p;
}

// ---- Project scoping

test('SEG-005 another tenant cannot open a project’s audiences or journeys', async ({ page, clientIp }) => {
  const p1 = await segProject(clientIp, 'seg005-o');
  await createSegment(p1.owner, p1.project.id, clientIp, {
    name: 'SEG-005 private audience',
    definition: KNOWN_COUNTRY,
    evaluationMode: 'live',
    status: 'active',
  });
  await createJourney(p1.owner, p1.project.id, clientIp, { name: 'SEG-005 private journey' });
  const x = await createAccount(clientIp, 'seg005-x');
  await createProject(x, clientIp, 'SEG-005 X own');

  for (const path of [`/api/projects/${p1.project.id}/segments`, `/api/projects/${p1.project.id}/journeys`]) {
    const response = await raw('GET', path, undefined, { ip: clientIp, token: x.accessToken });
    expect(response.status, path).toBe(404);
    expect(messageOf(response)).toBe(PROJECT_NOT_FOUND);
  }

  const leaked: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes(`/api/projects/${p1.project.id}`) && response.ok()) leaked.push(response.url());
  });
  await signIn(page, x);
  for (const path of [`/projects/${p1.project.id}/segments`, `/projects/${p1.project.id}/journeys`]) {
    await page.goto(path);
    // The shell itself sends an inaccessible project back to the selector.
    await expect(page).toHaveURL(/\/projects$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(page.getByText('SEG-005 private audience')).toHaveCount(0);
    await expect(page.getByText('SEG-005 private journey')).toHaveCount(0);
  }
  expect(leaked).toEqual([]);
});

// ---- Audiences list

test('SEG-014 deleting an audience removes it, its members, and logs it', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg014');
  const vip = await createSegment(p.owner, p.project.id, clientIp, {
    name: 'VIP',
    definition: KNOWN_COUNTRY,
    evaluationMode: 'materialized',
    status: 'active',
  });
  await createSegment(p.owner, p.project.id, clientIp, { name: 'Other', definition: KNOWN_COUNTRY, evaluationMode: 'live' });
  await markMaterialised(vip.id, p.project.id, ['u-one', 'u-two']);

  await signIn(page, p.owner);
  await openAudiences(page, p.project.id);
  await expect(page.getByText('2 defined', { exact: true })).toBeVisible();

  await rowNamed(page, 'VIP').getByRole('button').click();
  const dialog = page.getByRole('dialog');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/segments/${vip.id}`)),
    dialog.getByRole('button', { name: 'Delete audience' }).click(),
  ]);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ data: { deleted: true } });

  const toast = toastTitled(page, 'Audience deleted');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('VIP');
  await expect(dialog).toHaveCount(0);
  await expect(rowNamed(page, 'VIP')).toHaveCount(0);
  await expect(page.getByText('1 defined', { exact: true })).toBeVisible();

  expect(await segmentRow(vip.id)).toBeUndefined();
  expect(await memberKeys(vip.id)).toEqual([]);
  const rows = await activityRows(p.project.id, 'content.deleted');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    target_type: 'segment',
    target_id: vip.id,
    target_label: 'VIP',
    details: { kind: 'segment' },
    actor_kind: 'user',
    actor_user_id: p.owner.userId,
  });
});

test('SEG-018 audience names, descriptions and errors render as text', async ({ page, clientIp }) => {
  const NAME = '<img src=x onerror=alert(1)>';
  const DESCRIPTION = '<script>alert(2)</script>';
  const ERROR = '<b>boom</b>';
  const p = await segProject(clientIp, 'seg018');
  const segment = await createSegment(p.owner, p.project.id, clientIp, {
    name: NAME,
    description: DESCRIPTION,
    definition: KNOWN_COUNTRY,
    evaluationMode: 'materialized',
    status: 'active',
  });
  await sql(`UPDATE segments SET status = 'error', error_message = $2 WHERE id = $1`, [segment.id, ERROR]);

  const dialogs = recordDialogs(page);
  await signIn(page, p.owner);
  await openAudiences(page, p.project.id);
  const row = rowNamed(page, NAME);
  await expect(row).toBeVisible();
  await expect(row.getByText(DESCRIPTION, { exact: true })).toBeVisible();
  await expect(row.getByText('Error', { exact: true })).toBeVisible();

  await row.locator('svg.lucide-triangle-alert, svg.lucide-alert-triangle').hover();
  await expect(page.getByRole('tooltip')).toHaveText(ERROR);

  await row.getByRole('button').click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(`Delete “${NAME}”?`);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await row.getByRole('link', { name: NAME, exact: true }).click();
  await expect(page.getByRole('heading', { name: NAME, exact: true })).toBeVisible();
  await expect(audienceName(page)).toHaveValue(NAME);
  await expect(audienceDescription(page)).toHaveValue(DESCRIPTION);

  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('b', { hasText: 'boom' })).toHaveCount(0);
  await expect(page.locator('script', { hasText: 'alert(2)' })).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// ---- Audience editor

test('SEG-022 creating a live event audience counts, saves and opens it', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg022');
  const pid = p.project.id;
  const alice = await addDevice(p, clientIp, { externalUserId: uniqueId('u-alice'), emailOptIn: true, row: { country: 'IN' } });
  const bob = await addDevice(p, clientIp, { externalUserId: uniqueId('u-bob'), emailOptIn: false, row: { country: 'US' } });
  const dnt = await addDevice(p, clientIp, { externalUserId: uniqueId('u-dnt'), row: { country: 'IN', do_not_track: true } });
  for (const amount of [50, 150, 250]) await insertEvent(pid, alice, 'purchase', { amount }, 3);
  await insertEvent(pid, bob, 'purchase', { amount: 75 }, 40);
  await insertEvent(pid, alice, 'signup', null, 5);
  await insertEvent(pid, bob, 'signup', null, 45);
  await insertEvent(pid, dnt, 'purchase', { amount: 10 }, 2);
  await insertEvent(pid, dnt, 'purchase', { amount: 20 }, 2);
  await createSegment(p.owner, pid, clientIp, { name: 'SEG-022 older', definition: KNOWN_COUNTRY, evaluationMode: 'live' });

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await page.getByRole('link', { name: 'New audience' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/new$`));
  await audienceName(page).fill('Recent buyers');
  await audienceDescription(page).fill('Bought in 30 days');

  const counted = previewResponse(page);
  await choose(page.getByRole('combobox').filter({ hasText: 'choose an event' }), 'purchase');
  expect(await (await counted).json()).toEqual({ data: { count: 1 } });
  await expect(countFigure(page)).toHaveText('1');
  await expect(countCaption(page)).toHaveText('people match');

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/projects/${pid}/segments`),
    page.getByRole('button', { name: 'Create audience' }).click(),
  ]);
  expect(request.postDataJSON()).toEqual({
    name: 'Recent buyers',
    description: 'Bought in 30 days',
    definition: {
      type: 'group',
      operator: 'and',
      children: [{ type: 'behaviour', eventName: 'purchase', occurrence: 'at_least', count: 1, withinDays: 30 }],
    },
    evaluationMode: 'live',
    refreshIntervalMinutes: 60,
    status: 'active',
  });
  const toast = toastTitled(page, 'Audience created');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Recent buyers');
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/segments/[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', { name: 'Recent buyers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

  const id = new URL(page.url()).pathname.split('/').pop()!;
  expect(await segmentRow(id)).toMatchObject({ name: 'Recent buyers', status: 'active', evaluation_mode: 'live' });

  await openAudiences(page, pid);
  await expect(page.getByRole('row').nth(1)).toContainText('Recent buyers');
  await expect(page.getByRole('row').nth(2)).toContainText('SEG-022 older');
});

test('SEG-034 property filter values stay text except for ordered numbers', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg034');
  const pid = p.project.id;
  const big = await addDevice(p, clientIp, { externalUserId: uniqueId('u-big') });
  const small = await addDevice(p, clientIp, { externalUserId: uniqueId('u-small') });
  for (const amount of [50, 150, 250]) await insertEvent(pid, big, 'purchase', { amount }, 3);
  await insertEvent(pid, small, 'purchase', { amount: '90' }, 3);

  await signIn(page, p.owner);
  await page.goto(`/projects/${pid}/segments/new`);
  await choose(page.getByRole('combobox').filter({ hasText: 'choose an event' }), 'purchase');
  await page.getByRole('button', { name: 'Filter on a property' }).click();
  await page.getByPlaceholder('property name').fill('amount');
  await choose(page.getByRole('combobox').filter({ hasText: /^is$/ }), 'is greater than');

  const ordered = previewResponse(page, (d) => d.children[0].where?.[0]?.value !== undefined);
  await page.getByPlaceholder('value', { exact: true }).fill('100');
  const orderedResponse = await ordered;
  expect(orderedResponse.request().postDataJSON().definition.children[0].where).toEqual([
    { property: 'amount', op: 'gt', value: 100 },
  ]);
  // "90" is compared as the number 90, so only the person with 150 and 250 is in.
  expect(await orderedResponse.json()).toEqual({ data: { count: 1 } });
  await expect(countFigure(page)).toHaveText('1');

  const equal = previewResponse(page, (d) => d.children[0].where?.[0]?.op === 'eq');
  await choose(page.getByRole('combobox').filter({ hasText: /^is greater than$/ }), 'is');
  await page.getByPlaceholder('value', { exact: true }).fill('150');
  const equalResponse = await equal;
  expect(equalResponse.request().postDataJSON().definition.children[0].where).toEqual([
    { property: 'amount', op: 'eq', value: '150' },
  ]);
  expect(await equalResponse.json()).toEqual({ data: { count: 1 } });

  const withValue = (value: unknown) => group([behaviour('purchase', { where: [{ property: 'amount', op: 'gt', value }] })]);
  // A number compares numerically; the same value as a string compares as text,
  // where "90" and "50" both sort after "100".
  expect(await previewCount(p.owner, pid, clientIp, withValue(100))).toBe(1);
  expect(await previewCount(p.owner, pid, clientIp, withValue('100'))).toBe(2);
});

test('SEG-043 a custom numeric trait compares as a number', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg043');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const bob = uniqueId('u-bob');
  const carol = uniqueId('u-carol');
  await addDevice(p, clientIp, { externalUserId: alice, traits: { plan: 'pro', score: 99 } });
  await addDevice(p, clientIp, { externalUserId: bob, traits: { plan: 'free', score: '100' } });
  await addDevice(p, clientIp, { externalUserId: carol, traits: { score: 'high' } });

  const scoreAbove = (value: unknown) => group([attribute('traits.score', 'gt', value)]);
  // Numeric: bob's "100" is read as 100; carol's "high" matches nothing and errors nothing.
  expect(await previewCount(p.owner, pid, clientIp, scoreAbove(99.5))).toBe(1);
  expect(await liveMembers(p.owner, pid, clientIp, scoreAbove(99.5))).toEqual([bob]);
  // Text: "99" and "100" sort before "99.5", "high" after it.
  expect(await liveMembers(p.owner, pid, clientIp, scoreAbove('99.5'))).toEqual([carol]);
});

test('SEG-047 behavioural profile fields ignore do-not-track people', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg047');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  const dnt = uniqueId('u-dnt');
  await addDevice(p, clientIp, { externalUserId: alice, row: { country: 'IN', total_sessions: 10, last_event_at: null } });
  await addDevice(p, clientIp, { externalUserId: dnt, row: { country: 'IN', total_sessions: 10, last_event_at: null, do_not_track: true } });
  const [row] = await sql(`SELECT last_seen_at FROM device_identities WHERE project_id = $1 AND external_user_id = $2`, [pid, dnt]);
  expect(row.last_seen_at).not.toBeNull();

  expect(await previewCount(p.owner, pid, clientIp, group([attribute('totalSessions', 'gte', 5)]))).toBe(1);
  expect(await liveMembers(p.owner, pid, clientIp, group([attribute('totalSessions', 'gte', 5)]))).toEqual([alice]);
  expect(await liveMembers(p.owner, pid, clientIp, group([attribute('lastSeenAt', 'exists')]))).toEqual([alice]);
  // Unknown in the other direction too: dnt has no last event, and is still not in.
  expect(await liveMembers(p.owner, pid, clientIp, group([attribute('lastEventAt', 'not_exists')]))).toEqual([alice]);
  // A field that is not behaviour still matches the do-not-track person.
  expect((await liveMembers(p.owner, pid, clientIp, group([attribute('country', 'eq', 'IN')]))).sort()).toEqual([alice, dnt].sort());
});

test('SEG-049 one person on several devices is counted once', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg049');
  const pid = p.project.id;
  const alice = uniqueId('u-alice');
  await addDevice(p, clientIp, { externalUserId: alice, platform: 'ios' });
  await addDevice(p, clientIp, { externalUserId: alice, platform: 'web' });
  const anonymous = await addDevice(p, clientIp, { platform: 'android' });

  const platformKnown = group([attribute('platform', 'exists')]);
  expect(await previewCount(p.owner, pid, clientIp, platformKnown)).toBe(2);
  const keys = await liveMembers(p.owner, pid, clientIp, platformKnown);
  expect(keys.filter((key) => key === alice)).toHaveLength(1);
  expect(keys).toEqual([`device:${anonymous}`, alice].sort());
});

test('SEG-065 changing a materialised audience’s rules clears its membership', async ({ page, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg065');
  const pid = p.project.id;
  const segment = await createSegment(p.owner, pid, clientIp, {
    name: 'SEG-065 buyers',
    definition: group([behaviour('purchase')]),
    evaluationMode: 'materialized',
    refreshIntervalMinutes: 60,
    status: 'active',
  });
  await markMaterialised(segment.id, pid, ['u-member']);

  await signIn(page, p.owner);
  await openAudiences(page, pid);
  await expect(rowNamed(page, 'SEG-065 buyers').getByRole('cell').nth(3)).toHaveText('1');
  await page.goto(`/projects/${pid}/segments/${segment.id}`);
  await expect(page.getByRole('heading', { name: 'SEG-065 buyers' })).toBeVisible();
  await page.locator('input[type="number"][max="365"]').fill('14');
  const [patch] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/segments/${segment.id}`)),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  expect(patch.postDataJSON().definition.children[0].withinDays).toBe(14);
  await expect(toastTitled(page, 'Audience saved')).toBeVisible();

  const row = await segmentRow(segment.id);
  expect(row?.last_materialized_at).toBeNull();
  expect(row?.last_member_count).toBeNull();
  expect(await memberKeys(segment.id)).toEqual([]);
  const members = await raw('GET', `/api/projects/${pid}/segments/${segment.id}/members`, undefined, {
    ip: clientIp,
    token: p.owner.accessToken,
  });
  expect(members.status).toBe(400);
  expect(messageOf(members)).toBe(notMaterialised(segment.id, 'SEG-065 buyers'));

  await openAudiences(page, pid);
  await expect(rowNamed(page, 'SEG-065 buyers').getByRole('cell').nth(3)).toHaveText('not yet refreshed');
});

test('SEG-066 saving without a definition change keeps membership', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg066');
  const pid = p.project.id;
  const segment = await createSegment(p.owner, pid, clientIp, {
    name: 'SEG-066 buyers',
    definition: group([behaviour('purchase')]),
    evaluationMode: 'materialized',
    status: 'active',
  });
  await markMaterialised(segment.id, pid, ['u-member']);
  const before = await segmentRow(segment.id);
  const as = { ip: clientIp, token: p.owner.accessToken };

  const renamed = await raw('PATCH', `/api/projects/${pid}/segments/${segment.id}`, { name: 'Renamed' }, as);
  expect(renamed.status).toBe(200);
  const nulled = await raw('PATCH', `/api/projects/${pid}/segments/${segment.id}`, { definition: null }, as);
  expect(nulled.status).toBe(200);

  const after = await segmentRow(segment.id);
  expect(after?.name).toBe('Renamed');
  expect(after?.definition).toEqual(before?.definition);
  expect(after?.last_materialized_at).toEqual(before?.last_materialized_at);
  expect(after?.last_member_count).toBe(1);
  expect(await memberKeys(segment.id)).toEqual(['u-member']);
});

test('SEG-069 definitions the editor cannot show are read-only', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg069');
  const pid = p.project.id;
  const leaf = attribute('country', 'exists');
  const shapes: Array<[string, Node]> = [
    ['SEG-069 nested', group([group([group([leaf], 'or')], 'and')])],
    ['SEG-069 negated root', group([leaf], 'and', { negate: true })],
    ['SEG-069 negated child', group([group([leaf, attribute('city', 'exists')], 'or', { negate: true })])],
  ];
  const created: SegmentRecord[] = [];
  for (const [name, definition] of shapes) {
    created.push(
      await createSegment(p.owner, pid, clientIp, { name, description: `${name} description`, definition, evaluationMode: 'live', status: 'active' }),
    );
  }

  await signIn(page, p.owner);
  const previews = recordRequests(page, 'POST', '/segments/preview');
  const writes = recordRequests(page, 'PATCH', /\/segments\//);
  for (const segment of created) {
    await page.goto(`/projects/${pid}/segments/${segment.id}`);
    await expect(page.getByRole('heading', { name: segment.name, exact: true })).toBeVisible();
    await expect(page.getByText('This definition was not built here')).toBeVisible();
    await expect(page.getByText(NOT_BUILT_HERE)).toBeVisible();
    // Shown as stored: the definition the API reads back, untouched by the editor.
    const stored = await raw('GET', `/api/projects/${pid}/segments/${segment.id}`, undefined, { ip: clientIp, token: p.owner.accessToken });
    expect(stored.body.data.definition).toEqual(segment.definition);
    await expect(page.locator('pre')).toHaveText(JSON.stringify(stored.body.data.definition, null, 2));
    await expect(page.locator('fieldset')).toHaveAttribute('disabled', '');
    await expect(audienceName(page)).toBeDisabled();
    await expect(audienceName(page)).toHaveValue(segment.name);
    await expect(audienceDescription(page)).toHaveValue(`${segment.name} description`);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(countFigure(page)).toHaveText('…');
    await expect(countCaption(page)).toHaveText('counting…');
    // Past the editor's 600 ms debounce: a preview would have gone by now.
    await page.waitForTimeout(1200);
  }
  expect(previews).toEqual([]);
  expect(writes).toEqual([]);
});

// ---- Members

test('SEG-077 members of a materialised audience before its first refresh', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg077');
  const segment = await createSegment(p.owner, p.project.id, clientIp, {
    name: 'Lapsed',
    definition: group([behaviour('purchase', { occurrence: 'none', count: 0 })]),
    evaluationMode: 'materialized',
    status: 'active',
  });
  const response = await raw('GET', `/api/projects/${p.project.id}/segments/${segment.id}/members`, undefined, {
    ip: clientIp,
    token: p.owner.accessToken,
  });
  expect(response.status).toBe(400);
  expect(messageOf(response)).toBe(notMaterialised(segment.id, 'Lapsed'));
});

test('SEG-079 another project’s audience is not found through this project', async ({ clientIp }) => {
  const p1 = await segProject(clientIp, 'seg079-o');
  const x = await createAccount(clientIp, 'seg079-x');
  const p2 = await createProject(x, clientIp, 'SEG-079 P2');
  const s2 = await createSegment(x, p2.id, clientIp, { name: 'SEG-079 S2', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });

  const as = { ip: clientIp, token: p1.owner.accessToken };
  const base = `/api/projects/${p1.project.id}/segments/${s2.id}`;
  for (const [method, path, body] of [
    ['GET', `${base}/members`, undefined],
    ['GET', base, undefined],
    ['PATCH', base, { name: 'taken' }],
    ['DELETE', base, undefined],
  ] as const) {
    const response = await raw(method, path, body, as);
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(messageOf(response)).toBe(`Segment ${s2.id} not found`);
    expect(JSON.stringify(response.body)).not.toContain('SEG-079 S2');
  }
  expect(await segmentRow(s2.id)).toMatchObject({ name: 'SEG-079 S2', project_id: p2.id });
});

// ---- Audiences API

test('SEG-086 keys cannot inject SQL and values are bound', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg086');
  const pid = p.project.id;
  await addDevice(p, clientIp, { externalUserId: uniqueId('u-pune'), row: { country: 'IN', city: 'Pune' } });
  await addDevice(p, clientIp, { externalUserId: uniqueId('u-delhi'), row: { country: 'IN', city: 'Delhi' } });
  await addDevice(p, clientIp, { externalUserId: uniqueId('u-nowhere'), row: { city: null } });
  const as = { ip: clientIp, token: p.owner.accessToken };
  const preview = (definition: Node) => raw('POST', `/api/projects/${pid}/segments/preview`, { definition }, as);

  const field = "traits.x' OR '1'='1";
  const badField = await preview(group([attribute(field, 'eq', 'x')]));
  expect(badField.status).toBe(400);
  expect(messageOf(badField)).toBe(`root.children[0]: unknown attribute field "${field}"`);

  const property = "amount'); DROP TABLE users;--";
  const badProperty = await preview(group([behaviour('purchase', { where: [{ property, op: 'eq', value: '1' }] })]));
  expect(badProperty.status).toBe(400);
  expect(messageOf(badProperty)).toBe(`root.children[0].where[0]: unsafe property name "${property}"`);

  const country = await preview(group([attribute('country', 'eq', "'; DROP TABLE segments; --")]));
  expect(country.status).toBe(201);
  expect(country.body.data).toEqual({ count: 0 });
  const city = await preview(group([attribute('city', 'contains', '%')]));
  expect(city.status).toBe(201);
  expect(city.body.data).toEqual({ count: 2 });

  const list = await raw('GET', `/api/projects/${pid}/segments`, undefined, as);
  expect(list.status).toBe(200);
  const [users] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [p.owner.userId]);
  expect(users.n).toBe(1);
});

test('SEG-090 owner, admin and member can all manage audiences', async ({ browser, baseURL, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg090');
  const pid = p.project.id;
  for (const role of ['admin', 'member'] as const) {
    const teammate = await addTeammate(p.owner, pid, role, clientIp);
    const { context } = await newPersonContext(browser, baseURL);
    const page = await context.newPage();
    const refused: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 403 && response.url().includes(`/api/projects/${pid}/segments`)) refused.push(response.url());
    });
    try {
      await signIn(page, teammate);
      await page.goto(`/projects/${pid}/segments/new`);
      const name = `SEG-090 ${role}`;
      await audienceName(page).fill(name);
      const counted = previewResponse(page);
      await choose(page.getByRole('combobox').filter({ hasText: 'choose an event' }), 'purchase');
      expect((await counted).status()).toBe(201);
      await expect(countCaption(page)).toHaveText('people match');
      await page.getByRole('button', { name: 'Create audience' }).click();
      await expect(toastTitled(page, 'Audience created')).toBeVisible();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();

      await audienceName(page).fill(`${name} edited`);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(toastTitled(page, 'Audience saved')).toBeVisible();

      await openAudiences(page, pid);
      await rowNamed(page, `${name} edited`).getByRole('button').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete audience' }).click();
      await expect(toastTitled(page, 'Audience deleted')).toBeVisible();
      await expect(rowNamed(page, `${name} edited`)).toHaveCount(0);

      const deleted = (await activityRows(pid, 'content.deleted')).filter((row) => row.target_label === `${name} edited`);
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toMatchObject({ actor_user_id: teammate.userId, details: { kind: 'segment' } });
      expect(refused).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('SEG-091 non-member, missing project and malformed project id get the same 404', async ({ clientIp }) => {
  const p = await segProject(clientIp, 'seg091');
  const segment = await createSegment(p.owner, p.project.id, clientIp, {
    name: 'SEG-091 audience',
    definition: KNOWN_COUNTRY,
    evaluationMode: 'live',
    status: 'active',
  });
  const x = await createAccount(clientIp, 'seg091-x');
  await createProject(x, clientIp, 'SEG-091 X own');

  const routes = (projectId: string) => {
    const base = `/api/projects/${projectId}/segments`;
    return [
      ['GET', base, undefined],
      ['POST', base, { name: 'Injected', definition: KNOWN_COUNTRY }],
      ['POST', `${base}/preview`, { definition: KNOWN_COUNTRY }],
      ['GET', `${base}/${segment.id}`, undefined],
      ['GET', `${base}/${segment.id}/members`, undefined],
      ['PATCH', `${base}/${segment.id}`, { name: 'Changed' }],
      ['DELETE', `${base}/${segment.id}`, undefined],
    ] as const;
  };
  const cases: Array<[string, string]> = [
    [x.accessToken, p.project.id],
    [p.owner.accessToken, randomUUID()],
    [p.owner.accessToken, p.project.id.toUpperCase()],
    [p.owner.accessToken, 'not-a-uuid'],
  ];
  for (const [token, projectId] of cases) {
    for (const [method, path, body] of routes(projectId)) {
      const response = await raw(method, path, body, { ip: clientIp, token });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(messageOf(response), `${method} ${path}`).toBe(PROJECT_NOT_FOUND);
    }
  }
  const rows = await sql(`SELECT name FROM segments WHERE project_id = $1`, [p.project.id]);
  expect(rows).toEqual([{ name: 'SEG-091 audience' }]);
});

test('SEG-093 view-as can read audiences', async ({ page, browser, baseURL, clientIp }) => {
  const p = await segProject(clientIp, 'seg093');
  const pid = p.project.id;
  await createSegment(p.owner, pid, clientIp, {
    name: 'VIP',
    description: 'Known countries',
    definition: KNOWN_COUNTRY,
    evaluationMode: 'live',
    status: 'active',
  });

  await openViewAs(page, await viewAsHandoff(browser, baseURL, p.owner));
  await openAudiences(page, pid);
  const row = rowNamed(page, 'VIP');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Known countries');

  const refused = previewResponse(page);
  await row.getByRole('link', { name: 'VIP', exact: true }).click();
  expect((await refused).status()).toBe(403);
  await expect(page.getByRole('heading', { name: 'VIP', exact: true })).toBeVisible();
  await expect(audienceName(page)).toHaveValue('VIP');
  await expect(audienceDescription(page)).toHaveValue('Known countries');
  await expect(countFigure(page)).toHaveText('—');
  await expect(countCaption(page)).toHaveText('could not count');
  await expect(page.locator('p.text-destructive', { hasText: READ_ONLY })).toBeVisible();
  const toast = toastTitled(page, 'Read-only session');
  await expect(toast.first()).toBeVisible();
  await expect(toast.first()).toContainText(READ_ONLY);
});

test('SEG-094 view-as cannot create, edit, preview or delete audiences', async ({ page, browser, baseURL, clientIp }) => {
  const p = await projectWithPurchase(clientIp, 'seg094');
  const pid = p.project.id;
  const vip = await createSegment(p.owner, pid, clientIp, { name: 'VIP', definition: KNOWN_COUNTRY, evaluationMode: 'live', status: 'active' });

  await openViewAs(page, await viewAsHandoff(browser, baseURL, p.owner));
  // Starting view-as logs `staff.viewed_as`; nothing after it may add a row.
  const activityBefore = await allActivity(pid);
  expect(activityBefore.map((row) => row.action)).toContain('staff.viewed_as');

  // Create.
  await page.goto(`/projects/${pid}/segments/new`);
  await audienceName(page).fill('SEG-094 new');
  await choose(page.getByRole('combobox').filter({ hasText: 'choose an event' }), 'purchase');
  await page.getByRole('button', { name: 'Create audience' }).click();
  const couldNotSave = toastTitled(page, 'Could not save');
  await expect(couldNotSave).toBeVisible();
  await expect(couldNotSave).toContainText(READ_ONLY);
  await expect(toastTitled(page, 'Read-only session').first()).toBeVisible();

  // Edit.
  await page.goto(`/projects/${pid}/segments/${vip.id}`);
  await expect(page.getByRole('heading', { name: 'VIP', exact: true })).toBeVisible();
  await audienceName(page).fill('VIP changed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toastTitled(page, 'Could not save').last()).toContainText(READ_ONLY);

  // Delete.
  await openAudiences(page, pid);
  await rowNamed(page, 'VIP').getByRole('button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete audience' }).click();
  const couldNotDelete = toastTitled(page, 'Could not delete');
  await expect(couldNotDelete).toBeVisible();
  await expect(couldNotDelete).toContainText(READ_ONLY);

  const token = await viewAsTokenOf(page);
  const as = { ip: clientIp, token };
  const base = `/api/projects/${pid}/segments`;
  for (const [method, path, body] of [
    ['POST', base, { name: 'SEG-094 api', definition: KNOWN_COUNTRY }],
    ['POST', `${base}/preview`, { definition: KNOWN_COUNTRY }],
    ['PATCH', `${base}/${vip.id}`, { name: 'VIP api' }],
    ['DELETE', `${base}/${vip.id}`, undefined],
  ] as const) {
    const response = await raw(method, path, body, as);
    expect(response.status, `${method} ${path}`).toBe(403);
    expect(messageOf(response)).toBe(READ_ONLY);
  }
  const reads = await raw('GET', base, undefined, as);
  expect(reads.status).toBe(200);

  const rows = await sql(`SELECT id, name FROM segments WHERE project_id = $1`, [pid]);
  expect(rows).toEqual([{ id: vip.id, name: 'VIP' }]);
  expect(await allActivity(pid)).toEqual(activityBefore);
});

// ---- Journeys list

test('SEG-105 status badges and actions per journey status', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg105');
  const pid = p.project.id;
  const draft = await createJourney(p.owner, pid, clientIp, { name: 'SEG-105 draft' });
  const active = await createJourney(p.owner, pid, clientIp, { name: 'SEG-105 active' });
  const paused = await createJourney(p.owner, pid, clientIp, { name: 'SEG-105 paused' });
  const archived = await createJourney(p.owner, pid, clientIp, { name: 'SEG-105 archived' });
  await setJourneyStatus(p.owner, pid, clientIp, active.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, paused.id, 'paused');
  await setJourneyStatus(p.owner, pid, clientIp, archived.id, 'archived');
  expect(draft.status).toBe('draft');

  await signIn(page, p.owner);
  await openJourneys(page, pid);

  const draftRow = rowNamed(page, 'SEG-105 draft');
  await expect(draftRow.getByText('Draft', { exact: true })).toBeVisible();
  await expect(draftRow.getByRole('button', { name: 'Activate' })).toBeEnabled();
  await expect(draftRow.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/projects/${pid}/journeys/${draft.id}`);
  await expect(draftRow.getByRole('button', { name: 'Delete' })).toBeEnabled();

  const activeRow = rowNamed(page, 'SEG-105 active');
  await expect(activeRow.getByText('Active', { exact: true })).toBeVisible();
  await expect(activeRow.getByRole('button', { name: 'Pause' })).toBeEnabled();
  await expect(activeRow.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await expect(activeRow.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await expect(activeRow.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  await expect(activeRow.getByLabel(EDIT_BLOCKED)).toBeVisible();
  await expect(activeRow.getByLabel(DELETE_BLOCKED)).toBeVisible();
  await activeRow.getByLabel(EDIT_BLOCKED).hover();
  await expect(page.getByRole('tooltip')).toHaveText(EDIT_BLOCKED);
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  await page.mouse.move(10, 10);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await activeRow.getByLabel(DELETE_BLOCKED).focus();
  await expect(page.getByRole('tooltip')).toHaveText(DELETE_BLOCKED);

  const pausedRow = rowNamed(page, 'SEG-105 paused');
  const pausedBadge = pausedRow.getByText('Paused', { exact: true });
  await expect(pausedBadge).toBeVisible();
  await expect(pausedBadge).toHaveClass(/text-yellow-600/);
  await expect(pausedRow.getByRole('button', { name: 'Resume' })).toBeEnabled();
  await expect(pausedRow.getByRole('link', { name: 'Edit' })).toBeVisible();
  await expect(pausedRow.getByRole('button', { name: 'Delete' })).toBeEnabled();

  const archivedRow = rowNamed(page, 'SEG-105 archived');
  await expect(archivedRow.getByText('Archived', { exact: true })).toBeVisible();
  for (const action of ['Activate', 'Resume', 'Pause']) {
    await expect(archivedRow.getByRole('button', { name: action })).toHaveCount(0);
  }
  await expect(archivedRow.getByRole('link', { name: 'Edit' })).toBeVisible();
  await expect(archivedRow.getByRole('button', { name: 'Delete' })).toBeEnabled();
});

test('SEG-107 first activation sets the watermark and logs it', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg107');
  const pid = p.project.id;
  const welcome = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  const row = rowNamed(page, 'Welcome');
  await row.getByRole('button', { name: 'Activate' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Activate "Welcome"?');
  await expect(dialog).toContainText(
    'This journey will start sending real messages to real people. Enrolment begins from this moment and does not reach back over people who matched the trigger earlier.',
  );
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  const startedAt = Date.now();
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/journeys/${welcome.id}/status`)),
    dialog.getByRole('button', { name: 'Activate journey' }).click(),
  ]);
  expect(request.postDataJSON()).toEqual({ status: 'active' });
  await expect(toastTitled(page, 'Journey activated')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Delete' })).toBeDisabled();

  const stored = await journeyRow(welcome.id);
  expect(stored?.status).toBe('active');
  const watermark = new Date(stored?.enrolled_through).getTime();
  expect(watermark).toBeGreaterThanOrEqual(startedAt - 1000);
  expect(watermark).toBeLessThanOrEqual(Date.now() + 1000);
  const rows = await activityRows(pid, 'journey.status_changed');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    target_type: 'journey',
    target_id: welcome.id,
    target_label: 'Welcome',
    details: { from: 'draft', to: 'active' },
    actor_user_id: p.owner.userId,
  });
});

test('SEG-108 pausing stops enrolment and leaves the watermark', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg108');
  const pid = p.project.id;
  const welcome = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  await setJourneyStatus(p.owner, pid, clientIp, welcome.id, 'active');

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  const row = rowNamed(page, 'Welcome');
  await row.getByRole('button', { name: 'Pause' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Pause "Welcome"?');
  await expect(dialog).toContainText(
    'No new people will be enrolled. People already inside will keep going and finish their remaining steps, including any messages still to be sent.',
  );

  const before = new Date((await journeyRow(welcome.id))?.enrolled_through).getTime();
  const clickedAt = Date.now();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/journeys/${welcome.id}/status`)),
    dialog.getByRole('button', { name: 'Pause journey' }).click(),
  ]);
  await expect(toastTitled(page, 'Journey paused')).toBeVisible();
  await expect(row.getByText('Paused', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();

  const body = (await response.json()) as { data: { status: string; enrolledThrough: string } };
  expect(body.data.status).toBe('paused');
  // The pause does not stamp the watermark (the worker's minute tick may have moved it
  // on before the click, never after it).
  const after = new Date(body.data.enrolledThrough).getTime();
  expect(after).toBeGreaterThanOrEqual(before);
  expect(after).toBeLessThanOrEqual(clickedAt);
  expect(new Date((await journeyRow(welcome.id))?.enrolled_through).getTime()).toBe(after);

  const changes = (await activityRows(pid, 'journey.status_changed')).map((r) => r.details);
  expect(changes).toEqual([
    { from: 'draft', to: 'active' },
    { from: 'active', to: 'paused' },
  ]);
});

test('SEG-109 resuming keeps the enrolment watermark', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg109');
  const pid = p.project.id;
  const welcome = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  await setJourneyStatus(p.owner, pid, clientIp, welcome.id, 'active');
  await setJourneyStatus(p.owner, pid, clientIp, welcome.id, 'paused');
  const [{ enrolled_through: watermark }] = await sql<{ enrolled_through: Date }>(
    `UPDATE journeys SET enrolled_through = date_trunc('second', now()) - interval '3 hours' WHERE id = $1 RETURNING enrolled_through`,
    [welcome.id],
  );

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  const row = rowNamed(page, 'Welcome');
  await row.getByRole('button', { name: 'Resume' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Activate "Welcome"?');
  await expect(dialog).toContainText(
    'This journey will start sending real messages again. Enrolment picks up where it paused, so anyone who matched the trigger while it was paused will be enrolled now.',
  );
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/journeys/${welcome.id}/status`)),
    dialog.getByRole('button', { name: 'Activate journey' }).click(),
  ]);
  await expect(toastTitled(page, 'Journey activated')).toBeVisible();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();

  const body = (await response.json()) as { data: { status: string; enrolledThrough: string } };
  expect(body.data.status).toBe('active');
  expect(new Date(body.data.enrolledThrough).getTime()).toBe(watermark.getTime());
  const changes = (await activityRows(pid, 'journey.status_changed')).map((r) => r.details);
  expect(changes[changes.length - 1]).toEqual({ from: 'paused', to: 'active' });
});

test('SEG-112 activation is refused when the journey’s audience is gone', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg112');
  const pid = p.project.id;
  const lapsed = await createSegment(p.owner, pid, clientIp, { name: 'Lapsed', definition: KNOWN_COUNTRY, evaluationMode: 'materialized', status: 'active' });
  const winBack = await createJourney(p.owner, pid, clientIp, {
    name: 'Win back',
    trigger: { type: 'segment_entry', segmentId: lapsed.id },
  });
  const branching = await createJourney(p.owner, pid, clientIp, {
    name: 'SEG-112 branch',
    steps: [
      { type: 'branch', segmentId: lapsed.id, ifMember: 1, ifNot: 2 },
      { type: 'send_push', title: 'Member' },
      { type: 'exit' },
    ],
  });
  await raw('DELETE', `/api/projects/${pid}/segments/${lapsed.id}`, undefined, { ip: clientIp, token: p.owner.accessToken });

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  await rowNamed(page, 'Win back').getByRole('button', { name: 'Activate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Activate journey' }).click();
  const toast = toastTitled(page, 'Could not activate journey');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(SEGMENT_FOREIGN);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Activate journey' })).toBeEnabled();

  const viaApi = await raw('POST', `/api/projects/${pid}/journeys/${branching.id}/status`, { status: 'active' }, {
    ip: clientIp,
    token: p.owner.accessToken,
  });
  expect(viaApi.status).toBe(400);
  expect(messageOf(viaApi)).toBe(SEGMENT_FOREIGN);

  expect((await journeyRow(winBack.id))?.status).toBe('draft');
  expect((await journeyRow(branching.id))?.status).toBe('draft');
  expect(await activityRows(pid, 'journey.status_changed')).toEqual([]);
});

test('SEG-113 deleting a journey removes it and its runs, and logs it', async ({ page, clientIp }) => {
  const p = await segProject(clientIp, 'seg113');
  const pid = p.project.id;
  const welcome = await createJourney(p.owner, pid, clientIp, { name: 'Welcome' });
  await insertRuns(pid, welcome.id, 'completed', 2);
  await insertRuns(pid, welcome.id, 'exited', 1);
  expect(await runCount(welcome.id)).toBe(3);

  await signIn(page, p.owner);
  await openJourneys(page, pid);
  const row = rowNamed(page, 'Welcome');
  await expect(row).toContainText('2 completed · 1 exited');
  await row.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Delete "Welcome"?');
  await expect(dialog.getByRole('heading').locator('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).toHaveCount(1);
  await expect(dialog).toContainText('This cannot be undone.');

  const release = await holdRequests(page, 'DELETE', `/journeys/${welcome.id}`);
  await dialog.getByRole('button', { name: 'Delete journey' }).click();
  await expect(dialog.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  release();
  await expect(toastTitled(page, 'Journey deleted')).toBeVisible();
  await expect(rowNamed(page, 'Welcome')).toHaveCount(0);

  expect(await journeyRow(welcome.id)).toBeUndefined();
  expect(await runCount(welcome.id)).toBe(0);
  const rows = await activityRows(pid, 'content.deleted');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    target_type: 'journey',
    target_id: welcome.id,
    target_label: 'Welcome',
    details: { kind: 'journey' },
    actor_user_id: p.owner.userId,
  });
});

test('SEG-118 journey names, descriptions and triggers render as text', async ({ page, clientIp }) => {
  const NAME = '<img src=x onerror=alert(1)>';
  const DESCRIPTION = '<script>alert(1)</script>';
  const EVENT = '"><svg onload=alert(1)>';
  const p = await segProject(clientIp, 'seg118');
  const pid = p.project.id;
  const journey = await createJourney(p.owner, pid, clientIp, {
    name: NAME,
    description: DESCRIPTION,
    trigger: { type: 'event', eventName: EVENT },
  });

  const dialogs = recordDialogs(page);
  await signIn(page, p.owner);
  await openJourneys(page, pid);
  const row = rowNamed(page, NAME);
  await expect(row).toBeVisible();
  await expect(row.getByText(DESCRIPTION, { exact: true })).toBeVisible();
  await expect(row.getByRole('cell').nth(2)).toHaveText(`When someone does ${EVENT}`);

  await row.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(`Activate "${NAME}"?`);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(`Delete "${NAME}"?`);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await row.getByRole('link', { name: NAME, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/journeys/${journey.id}$`));
  await expect(page.getByRole('heading', { name: NAME, exact: true })).toBeVisible();

  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('svg[onload]')).toHaveCount(0);
  await expect(page.locator('script', { hasText: 'alert(1)' })).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

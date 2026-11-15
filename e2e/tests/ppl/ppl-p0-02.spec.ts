import { randomBytes } from 'crypto';
import type { Download, Page, Response } from '@playwright/test';
import { api, createAccount, createProject, type Account } from '../../support/api';
import { readDownload } from '../../support/browser-tools';
import { confirmWithPassword } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addTeammate,
  addressHash,
  ageSignIn,
  apiLogText,
  createKey,
  deviceByFingerprint,
  deviceRow,
  devicesOf,
  fingerprint,
  holdRequests,
  identify,
  messageOf,
  objectionRows,
  peopleProject,
  privacyLogRows,
  raw,
  revokeKey,
  rowsNamingDevices,
  seedEmailEvent,
  seedPushToken,
  seedSegmentMembers,
  seedSuppression,
  seedTouchpoint,
  sql,
  subjectHash,
  toast,
  trackEvent,
  userHash,
  viewAsToken,
  type PeopleProject,
} from '../../support/areas/ppl';

/**
 * Device lookups, person export and erasure from the dashboard, the privacy request
 * log, and the server privacy API. People arrive through the SDK's identify route;
 * what an erasure or export did is read back with SQL and from the documents the API
 * answers.
 */

const READ_ONLY = 'Impersonation sessions are read-only';
const PROJECT_NOT_FOUND = 'Project not found';
const ROLE_REFUSAL = 'Your role in this project does not allow this.';
const SIGNED_IN_DEVICE = 'This device belongs to a signed-in user; erase or export by externalUserId.';
const WITHHELD = '[withheld]';

function uniqueId(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}`;
}

function uniquePhone(): string {
  return `+9198${String(randomBytes(4).readUInt32BE(0) % 100_000_000).padStart(8, '0')}`;
}

/** Asha: one person on an iOS and a web device, sharing a distinct id and an external id. */
async function seedAsha(
  p: PeopleProject,
  ip: string,
  { externalUserId = uniqueId('user-asha'), email = `${uniqueId('asha')}@example.com`, phone = uniquePhone() } = {},
) {
  const common = {
    distinctId: externalUserId,
    externalUserId,
    firstName: 'Asha',
    lastName: 'Rao',
    phone,
    emailOptIn: true,
    traits: { $name: 'Asha Rao', $email: email, plan: 'pro' },
  };
  const ios = await identify(p, ip, { ...common, deviceFingerprint: fingerprint('fp-asha-ios'), platform: 'ios' });
  const web = await identify(p, ip, { ...common, deviceFingerprint: fingerprint('fp-asha-web'), platform: 'web' });
  return { externalUserId, email, phone, ios, web };
}

type Asha = Awaited<ReturnType<typeof seedAsha>>;

/** Asha's history: an event, a push token and a touchpoint on her iOS device. */
async function seedHistory(p: PeopleProject, ip: string, asha: Asha) {
  const event = await trackEvent(p, ip, {
    eventName: 'purchase',
    deviceFingerprint: asha.ios.deviceFingerprint,
    properties: { sku: 'A1', price: 10 },
  });
  expect(event.status).toBe(201);
  const token = await seedPushToken(p.project.id, asha.ios.id);
  const touchpoint = await seedTouchpoint(p.project.id, asha.ios.deviceFingerprint);
  return { token, touchpoint };
}

async function outsiderAccount(ip: string): Promise<Account> {
  const outsider = await createAccount(ip, 'ppl-outsider', 'Olu Outsider');
  await createProject(outsider, ip);
  return outsider;
}

function profilePath(p: PeopleProject, personId: string): string {
  return `/projects/${p.project.id}/users/${personId}`;
}

async function openProfile(page: Page, p: PeopleProject, personId: string): Promise<void> {
  await page.goto(profilePath(p, personId));
  await expect(page.getByRole('heading', { name: 'User Profile' })).toBeVisible();
}

/** Opens "Delete person", types the confirmation and answers the dialog. */
async function confirmDelete(page: Page, confirmation: string) {
  await page.getByRole('button', { name: 'Delete person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this person and their data?' });
  await dialog.getByLabel(`Type ${confirmation} to confirm`).fill(confirmation);
  return dialog;
}

function isDeleteOf(p: PeopleProject, personId: string) {
  return (r: Response) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/api/projects/${p.project.id}/users/${personId}`;
}

function eraseAsOwner(p: PeopleProject, personId: string, ip: string, token = p.owner.accessToken) {
  return raw('DELETE', `/api/projects/${p.project.id}/users/${personId}`, undefined, { ip, token });
}

function exportAsOwner(p: PeopleProject, personId: string, ip: string, token = p.owner.accessToken) {
  return raw('GET', `/api/projects/${p.project.id}/users/${personId}/export`, undefined, { ip, token });
}

function privacyApi(route: 'erasures' | 'exports', body: unknown, key: string | undefined, ip: string, token?: string) {
  return raw('POST', `/api/privacy/${route}`, body, { ip, apiKey: key, token });
}

// ---- Device lookups

test('PPL-120 Device lookups: outsiders, anonymous, view-as', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const outsider = await outsiderAccount(clientIp);
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);
  const devices = `/api/identity/projects/${p.project.id}/devices?userId=${encodeURIComponent(asha.externalUserId)}`;
  const device = `/api/identity/projects/${p.project.id}/device/${encodeURIComponent(asha.ios.deviceFingerprint)}`;

  for (const path of [devices, device]) {
    const anonymous = await raw('GET', path, undefined, { ip: clientIp });
    expect(anonymous.status, path).toBe(401);

    const refused = await raw('GET', path, undefined, { ip: clientIp, token: outsider.accessToken });
    expect(refused.status, path).toBe(404);
    expect(refused.body.message).toBe(PROJECT_NOT_FOUND);
    expect(refused.body.data).toBeUndefined();
    expect(JSON.stringify(refused.body)).not.toContain(asha.ios.id);
  }

  const listed = await raw('GET', devices, undefined, { ip: clientIp, token: viewAs });
  expect(listed.status).toBe(200);
  expect(listed.body.data.map((d: { id: string }) => d.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
  const found = await raw('GET', device, undefined, { ip: clientIp, token: viewAs });
  expect(found.status).toBe(200);
  expect(found.body.data).toMatchObject({ id: asha.ios.id, deviceFingerprint: asha.ios.deviceFingerprint });
});

// ---- Person export

test('PPL-121 Owner exports a person', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  await seedHistory(p, clientIp, asha);

  await signIn(page, p.owner);
  await openProfile(page, p, asha.ios.id);
  const release = await holdRequests(page, 'GET', `/users/${asha.ios.id}/export`);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export data' }).click();
  const pending = page.getByRole('button', { name: 'Exporting...' });
  await expect(pending).toBeVisible();
  await expect(pending).toBeDisabled();
  release();

  const file = await readDownload(await downloaded);
  expect(file.filename).toBe(`person-${asha.ios.id}-export.json`);
  await expect(toast(page, 'Export downloaded')).toHaveText('Export downloaded');
  await expect(page.getByRole('button', { name: 'Export data' })).toBeEnabled();

  const exported = JSON.parse(file.text);
  expect(Date.parse(exported.exportedAt)).not.toBeNaN();
  expect(exported).toMatchObject({
    projectId: p.project.id,
    subject: { type: 'personId', value: asha.ios.id },
    rowCapPerSection: 5000,
    truncated: false,
  });
  expect(exported.notIncluded).toHaveLength(4);
  expect(exported.notIncluded[0]).toMatch(/^Rows recorded under an id that was never linked to this person/);
  for (const name of ['device_identities', 'user_events', 'push_tokens', 'consent_events', 'touchpoints']) {
    expect(exported.sections[name], name).toMatchObject({ truncated: false });
    expect(exported.sections[name].total, name).toBeGreaterThan(0);
    expect(exported.sections[name].rows, name).toHaveLength(exported.sections[name].total);
  }
  expect(exported.sections.device_identities.rows.map((r: { id: string }) => r.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
  expect(exported.sections.user_events.rows.map((r: { eventName: string }) => r.eventName)).toContain('purchase');
  const [{ n: consentRows }] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM consent_events WHERE device_identity_id = ANY($1::uuid[])`,
    [[asha.ios.id, asha.web.id]],
  );
  expect(exported.sections.consent_events.total).toBe(consentRows);
});

test('PPL-122 Export logs the request', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  await seedHistory(p, clientIp, asha);
  const exported = await exportAsOwner(p, asha.ios.id, clientIp);
  expect(exported.status).toBe(200);

  const listed = await raw('GET', `/api/projects/${p.project.id}/privacy-requests`, undefined, { ip: clientIp, token: p.owner.accessToken });
  expect(listed.status).toBe(200);
  const [entry] = listed.body.data;
  expect(Object.keys(entry).sort()).toEqual(['actorId', 'actorType', 'counts', 'createdAt', 'id', 'kind', 'result', 'subjectType']);
  expect(entry).toMatchObject({ kind: 'export', subjectType: 'personId', actorType: 'user', actorId: p.owner.userId, result: 'exported' });
  const totals = Object.fromEntries(
    Object.entries(exported.body.data.sections as Record<string, { total: number }>).map(([name, section]) => [name, section.total]),
  );
  expect(entry.counts).toEqual(totals);
  const text = JSON.stringify(entry);
  for (const identifier of [asha.ios.id, asha.web.id, asha.externalUserId, asha.ios.deviceFingerprint, asha.email]) {
    expect(text).not.toContain(identifier);
  }

  const logged = await activityRows(p.project.id, 'person.exported');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ actor_user_id: p.owner.userId, target_type: 'person', target_id: asha.ios.id, target_label: null });
});

test('PPL-123 Export contains no secrets or other people\'s ids', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const { token } = await seedHistory(p, clientIp, asha);
  // A third device of hers, whose SDK-set distinct id is neither her id nor a fingerprint of hers.
  const legacyId = uniqueId('legacy');
  const legacy = await identify(p, clientIp, {
    deviceFingerprint: fingerprint('fp-asha-legacy'),
    externalUserId: asha.externalUserId,
    distinctId: legacyId,
  });
  // Someone else's device, whose id an alias then claims for her.
  const otherId = uniqueId('anon-other');
  const other = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-other'), distinctId: otherId });
  await api('POST', '/api/identity/merge', { projectId: p.project.id, anonymousId: otherId, identifiedId: asha.externalUserId }, { apiKey: p.sdkKey, ip: clientIp });
  // Address history: an opt-out and an email delivery event.
  await seedSuppression(p.project.id, 'email', asha.email);
  const emailEvent = await seedEmailEvent(p.project.id, asha.ios.id);
  // The same external id in another project.
  const q = await peopleProject(clientIp, 'ppl-outsider');
  const qDevice = await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q-asha'), externalUserId: asha.externalUserId });
  const qToken = await seedPushToken(q.project.id, qDevice.id);

  const exported = await exportAsOwner(p, asha.ios.id, clientIp);
  expect(exported.status).toBe(200);
  const doc = exported.body.data;
  const text = JSON.stringify(doc);

  expect(doc.sections.push_tokens.rows).toEqual([expect.objectContaining({ deviceIdentityId: asha.ios.id, tokenEnding: `…${token.slice(-6)}` })]);
  expect(text).not.toContain(token);
  expect(doc.sections.push_tokens.rows[0]).not.toHaveProperty('token');

  const devices = doc.sections.device_identities.rows as Array<{ id: string; distinctId: string }>;
  expect(devices.map((d) => d.id).sort()).toEqual([asha.ios.id, asha.web.id, legacy.id].sort());
  expect(devices.find((d) => d.id === legacy.id)!.distinctId).toBe(WITHHELD);
  expect(devices.filter((d) => d.id !== legacy.id).map((d) => d.distinctId)).toEqual([asha.externalUserId, asha.externalUserId]);
  expect(doc.sections.identity_aliases.rows).toEqual([expect.objectContaining({ anonymousId: WITHHELD, identifiedId: asha.externalUserId })]);
  for (const foreign of [legacyId, otherId, other.id, other.deviceFingerprint]) expect(text).not.toContain(foreign);

  expect(doc.sections).not.toHaveProperty('channel_suppressions');
  expect(text).not.toContain('unsubscribed');
  expect(doc.sections.push_notification_events).toEqual({ total: 0, truncated: false, rows: [] });
  expect(text).not.toContain(emailEvent);
  expect(await sql(`SELECT id FROM push_notification_events WHERE id = $1`, [emailEvent])).toHaveLength(1);

  for (const foreign of [q.project.id, qDevice.id, qDevice.deviceFingerprint, qToken.slice(-6)]) expect(text).not.toContain(foreign);
});

test('PPL-125 Export failure toast for admin and member', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);

  for (const teammate of [admin, member]) {
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const page = await context.newPage();
      const downloads: Download[] = [];
      page.on('download', (download) => downloads.push(download));
      await signIn(page, teammate);
      await openProfile(page, p, asha.ios.id);
      const [response] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === `/api/projects/${p.project.id}/users/${asha.ios.id}/export`),
        page.getByRole('button', { name: 'Export data' }).click(),
      ]);
      expect(response.status()).toBe(403);
      expect((await response.json()).message).toBe(ROLE_REFUSAL);
      await expect(toast(page, 'Export failed')).toHaveText('Export failed');
      await page.waitForTimeout(3000);
      expect(downloads).toEqual([]);
    } finally {
      await context.close();
    }
  }
  expect(await privacyLogRows(p.project.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'person.exported')).toEqual([]);
});

test('PPL-126 Export refused in view-as (API)', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);

  const refused = await exportAsOwner(p, asha.ios.id, clientIp, viewAs);
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(READ_ONLY);
  expect(JSON.stringify(refused.body)).not.toContain(asha.externalUserId);
  expect(await privacyLogRows(p.project.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'person.exported')).toEqual([]);
});

// ---- Person erasure

test('PPL-133 Owner erases a signed-in person (recent sign-in)', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const { touchpoint } = await seedHistory(p, clientIp, asha);
  await seedSegmentMembers(p.project.id, [asha.externalUserId]);
  // Not signed in as her, though it carries her id as its distinct id.
  const pre = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-pre'), distinctId: asha.externalUserId, firstName: 'Pre', lastName: 'Login' });
  const ids = [asha.ios.id, asha.web.id];
  expect(await rowsNamingDevices('consent_events', ids)).toBeGreaterThan(0);

  await signIn(page, p.owner);
  await openProfile(page, p, asha.ios.id);
  const dialog = await confirmDelete(page, asha.externalUserId);
  const release = await holdRequests(page, 'DELETE', `/users/${asha.ios.id}`);
  const answered = page.waitForResponse(isDeleteOf(p, asha.ios.id));
  await dialog.getByRole('button', { name: 'Delete person' }).click();
  const pending = dialog.getByRole('button', { name: 'Deleting...' });
  await expect(pending).toBeVisible();
  await expect(pending).toBeDisabled();
  release();

  const response = await answered;
  expect(response.status()).toBe(200);
  const result = (await response.json()).data;
  expect(Object.keys(result).sort()).toEqual(['counts', 'notErased', 'requestId', 'result']);
  expect(result.result).toBe('erased');
  expect(result.notErased).toHaveLength(9);
  expect(result.counts).not.toHaveProperty('channel_suppressions');
  expect(result.counts).toMatchObject({ device_identities: 2, user_events: 1, push_tokens: 1, touchpoints: 1, segment_members: 1 });
  const total = Object.values(result.counts as Record<string, number>).reduce((sum, n) => sum + n, 0);

  await expect(toast(page, 'Person deleted')).toContainText(`${total.toLocaleString('en-US')} records deleted or updated. This request is logged.`);
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users$`));
  await expect(page.getByRole('row').filter({ hasText: 'Pre Login' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Asha Rao' })).toHaveCount(0);
  await expect(page.locator('[data-slot="card"]').filter({ hasText: 'Total Users' })).toContainText('1');

  expect(await sql(`SELECT id FROM device_identities WHERE project_id = $1 AND external_user_id = $2`, [p.project.id, asha.externalUserId])).toEqual([]);
  for (const table of ['consent_events', 'push_tokens', 'user_events']) {
    expect(await rowsNamingDevices(table, ids), table).toBe(0);
  }
  expect(await sql(`SELECT id FROM touchpoints WHERE id = $1`, [touchpoint])).toEqual([]);
  expect(await sql(`SELECT id FROM segment_members WHERE project_id = $1`, [p.project.id])).toEqual([]);
  expect(await deviceRow(pre.id)).toMatchObject({ distinct_id: asha.externalUserId, external_user_id: null });
});

test('PPL-134 Erasure is logged with hashes only', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  await seedHistory(p, clientIp, asha);
  await seedSuppression(p.project.id, 'email', asha.email);

  const erased = await eraseAsOwner(p, asha.ios.id, clientIp);
  expect(erased.status).toBe(200);
  const { requestId } = erased.body.data;

  const listed = await raw('GET', `/api/projects/${p.project.id}/privacy-requests`, undefined, { ip: clientIp, token: p.owner.accessToken });
  const [entry] = listed.body.data;
  expect(entry).toMatchObject({ id: requestId, kind: 'erasure', subjectType: 'personId', actorType: 'user', actorId: p.owner.userId, result: 'erased' });
  expect(entry.counts).toMatchObject({ channel_suppressions: 1, erased_suppressions_kept: 1, device_identities: 2 });

  const [stored] = await privacyLogRows(p.project.id);
  expect([...stored.identifier_hashes].sort()).toEqual(
    [subjectHash(p.project.id, 'personId', asha.ios.id), subjectHash(p.project.id, 'externalUserId', asha.externalUserId)].sort(),
  );
  const storedText = JSON.stringify(stored);
  for (const identifier of [asha.externalUserId, asha.ios.id, asha.web.id, asha.ios.deviceFingerprint, asha.email]) {
    expect(storedText).not.toContain(identifier);
  }

  const logged = await activityRows(p.project.id, 'person.erased');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ actor_user_id: p.owner.userId, target_type: 'person', target_id: asha.ios.id, target_label: null });

  await expect.poll(() => apiLogText().includes(`Privacy erasure ${requestId} in project ${p.project.id} by user: erased`)).toBe(true);
  const line = apiLogText().split('\n').find((l) => l.includes(`Privacy erasure ${requestId}`))!;
  expect(line).not.toContain(asha.externalUserId);
  expect(line).not.toContain(asha.ios.id);
  expect(apiLogText()).not.toContain(asha.externalUserId);
});

test('PPL-135 Erasure needs a recent sign-in (re-auth succeeds)', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);

  await signIn(page, p.owner);
  await ageSignIn(p.owner.userId);
  // A fresh page load refreshes the token from the session, whose sign-in is now old.
  await openProfile(page, p, asha.ios.id);
  const deletes: Response[] = [];
  page.on('response', (r) => {
    if (isDeleteOf(p, asha.ios.id)(r)) deletes.push(r);
  });

  const dialog = await confirmDelete(page, asha.externalUserId);
  await dialog.getByRole('button', { name: 'Delete person' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toBeVisible();
  expect(deletes.map((r) => r.status())).toEqual([403]);
  expect((await deletes[0].json()).message).toBe('Confirm it is you to continue.');
  expect(await deviceRow(asha.ios.id)).toBeDefined();

  await confirmWithPassword(page, p.owner.password);
  await expect(toast(page, 'Person deleted')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users$`));
  expect(deletes.map((r) => r.status())).toEqual([403, 200]);
  expect(await deviceRow(asha.ios.id)).toBeUndefined();
  expect(await privacyLogRows(p.project.id)).toHaveLength(1);
});

test('PPL-137 Admin and member cannot erase', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);

  for (const teammate of [admin, member]) {
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const page = await context.newPage();
      await signIn(page, teammate);
      await openProfile(page, p, asha.ios.id);
      const dialog = await confirmDelete(page, asha.externalUserId);
      const [response] = await Promise.all([
        page.waitForResponse(isDeleteOf(p, asha.ios.id)),
        dialog.getByRole('button', { name: 'Delete person' }).click(),
      ]);
      expect(response.status()).toBe(403);
      const refusal = toast(page, 'Could not delete this person');
      await expect(refusal).toContainText(ROLE_REFUSAL);
      await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);
      await expect(dialog).toBeVisible();
    } finally {
      await context.close();
    }
  }
  expect((await devicesOf(p.project.id)).map((d) => d.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
  expect(await privacyLogRows(p.project.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'person.erased')).toEqual([]);
});

test('PPL-138 Erasure refused in view-as (API)', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);

  const refused = await eraseAsOwner(p, asha.ios.id, clientIp, viewAs);
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(READ_ONLY);
  expect((await devicesOf(p.project.id)).map((d) => d.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
  expect(await privacyLogRows(p.project.id)).toEqual([]);
});

test('PPL-140 Erasing one device of an identified user erases the user', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const ravi = uniqueId('user-ravi');
  const android = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-ravi-android'), platform: 'android', externalUserId: ravi, distinctId: ravi });
  const second = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-ravi-web'), externalUserId: ravi, distinctId: ravi });
  const claimed = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-ravi-claim'), distinctId: ravi });

  const erased = await eraseAsOwner(p, android.id, clientIp);
  expect(erased.status).toBe(200);
  expect(erased.body.data).toMatchObject({ result: 'erased', counts: { device_identities: 2 } });
  expect(await deviceRow(android.id)).toBeUndefined();
  expect(await deviceRow(second.id)).toBeUndefined();
  expect(await deviceRow(claimed.id)).toMatchObject({ distinct_id: ravi, external_user_id: null });
});

test('PPL-141 Erasure keeps opt-outs as hashes', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  // Another person in the project also holds her number.
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-shared-phone'), phone: asha.phone });
  await seedSuppression(p.project.id, 'email', asha.email);
  await seedSuppression(p.project.id, 'sms', asha.phone, 'stop');
  const project = p.project.id;

  const erased = await eraseAsOwner(p, asha.ios.id, clientIp);
  expect(erased.status).toBe(200);
  expect(erased.body.data.result).toBe('erased');
  expect(erased.body.data.counts).not.toHaveProperty('channel_suppressions');
  expect(erased.body.data.counts).not.toHaveProperty('erased_suppressions_kept');

  const addresses = await sql<{ channel: string; address_hash: string }>(
    `SELECT channel, address_hash FROM erased_addresses WHERE project_id = $1 ORDER BY channel`,
    [project],
  );
  expect(addresses).toEqual([
    { channel: 'email', address_hash: addressHash(project, 'email', asha.email) },
    { channel: 'sms', address_hash: addressHash(project, 'sms', asha.phone) },
    { channel: 'whatsapp', address_hash: addressHash(project, 'whatsapp', asha.phone) },
  ]);
  expect(await sql(`SELECT channel, address FROM channel_suppressions WHERE project_id = $1`, [project])).toEqual([
    { channel: 'sms', address: asha.phone },
  ]);
  expect(await sql(`SELECT channel, address_hash, reason FROM erased_suppressions WHERE project_id = $1`, [project])).toEqual([
    { channel: 'email', address_hash: addressHash(project, 'email', asha.email), reason: 'unsubscribed' },
  ]);
  const [log] = await privacyLogRows(project);
  expect(log.counts).toMatchObject({ channel_suppressions: 1, erased_suppressions_kept: 1 });

  // The address seen again: the opt-out comes back before it is stored.
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-asha-again'), email: asha.email });
  expect(await sql(`SELECT channel, address, reason, source FROM channel_suppressions WHERE project_id = $1 AND channel = 'email'`, [project])).toEqual([
    { channel: 'email', address: asha.email, reason: 'unsubscribed', source: 'erasure' },
  ]);
  expect(await sql(`SELECT id FROM erased_suppressions WHERE project_id = $1`, [project])).toEqual([]);
});

// ---- Privacy request log

test('PPL-148 Privacy log roles and view-as', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  expect((await exportAsOwner(p, asha.ios.id, clientIp)).status).toBe(200);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);
  const outsider = await outsiderAccount(clientIp);
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);
  const path = `/api/projects/${p.project.id}/privacy-requests`;

  for (const teammate of [admin, member]) {
    const refused = await raw('GET', path, undefined, { ip: clientIp, token: teammate.accessToken });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe(ROLE_REFUSAL);
  }
  const asOutsider = await raw('GET', path, undefined, { ip: clientIp, token: outsider.accessToken });
  expect(asOutsider.status).toBe(404);
  expect(asOutsider.body.message).toBe(PROJECT_NOT_FOUND);

  const asStaff = await raw('GET', path, undefined, { ip: clientIp, token: viewAs });
  expect(asStaff.status).toBe(200);
  expect(asStaff.body.data).toHaveLength(1);
  expect(Object.keys(asStaff.body.data[0]).sort()).toEqual(['actorId', 'actorType', 'counts', 'createdAt', 'id', 'kind', 'result', 'subjectType']);
  expect(asStaff.body.data[0]).toMatchObject({ kind: 'export', result: 'exported' });
  const text = JSON.stringify(asStaff.body);
  for (const identifier of [asha.externalUserId, asha.ios.id, asha.ios.deviceFingerprint]) expect(text).not.toContain(identifier);
});

// ---- Server privacy API

test('PPL-151 Erase by external id with a privacy key', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { name: 'Backend privacy', permissions: ['privacy'] });
  const ravi = uniqueId('user-ravi');
  const android = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-ravi-android'), platform: 'android', externalUserId: ravi, distinctId: ravi });
  const web = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-ravi-web'), externalUserId: ravi, distinctId: ravi });
  expect((await trackEvent(p, clientIp, { eventName: 'on_device', deviceFingerprint: android.deviceFingerprint })).status).toBe(201);
  // An event with his id and no device: an orphan.
  expect((await trackEvent(p, clientIp, { eventName: 'orphan', distinctId: ravi })).status).toBe(201);
  expect(await sql(`SELECT id FROM user_events WHERE project_id = $1 AND device_identity_id IS NULL AND distinct_id = $2`, [p.project.id, ravi])).toHaveLength(1);

  const erased = await privacyApi('erasures', { externalUserId: ravi }, kp.fullKey, clientIp);
  expect(erased.status).toBe(200);
  expect(Object.keys(erased.body.data).sort()).toEqual(['counts', 'notErased', 'requestId', 'result']);
  expect(erased.body.data).toMatchObject({ result: 'erased', counts: { device_identities: 2, user_events: 2 } });
  expect(erased.body.data.notErased).toHaveLength(9);

  expect(await devicesOf(p.project.id)).toEqual([]);
  expect(await sql(`SELECT id FROM user_events WHERE project_id = $1`, [p.project.id])).toEqual([]);

  const [log] = await privacyLogRows(p.project.id);
  expect(log).toMatchObject({ id: erased.body.data.requestId, kind: 'erasure', subject_type: 'externalUserId', actor_type: 'api_key', actor_id: kp.id, result: 'erased' });
  const logged = await activityRows(p.project.id, 'person.erased');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({
    actor_kind: 'api_key',
    actor_user_id: null,
    actor_label: 'API key "Backend privacy"',
    target_type: 'person',
    target_id: [android.id, web.id].sort()[0],
    target_label: null,
  });
});

test('PPL-152 Erase an anonymous device by fingerprint', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  const anon1 = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-anon-1') });
  const anon2 = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-anon-2') });
  for (const device of [anon1, anon2]) {
    expect((await trackEvent(p, clientIp, { eventName: 'seen', deviceFingerprint: device.deviceFingerprint })).status).toBe(201);
  }

  const erased = await privacyApi('erasures', { deviceFingerprint: anon1.deviceFingerprint }, kp.fullKey, clientIp);
  expect(erased.status).toBe(200);
  expect(erased.body.data).toMatchObject({ result: 'erased', counts: { device_identities: 1, user_events: 1 } });
  expect(await deviceRow(anon1.id)).toBeUndefined();
  expect(await rowsNamingDevices('user_events', [anon1.id])).toBe(0);
  expect(await deviceRow(anon2.id)).toBeDefined();
  expect(await rowsNamingDevices('user_events', [anon2.id])).toBe(1);
});

test('PPL-153 Fingerprint of a signed-in device is refused', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  const asha = await seedAsha(p, clientIp);

  for (const route of ['erasures', 'exports'] as const) {
    const refused = await privacyApi(route, { deviceFingerprint: asha.ios.deviceFingerprint }, kp.fullKey, clientIp);
    expect(refused.status, route).toBe(409);
    expect(refused.body.message).toBe(SIGNED_IN_DEVICE);
    expect(JSON.stringify(refused.body)).not.toContain(asha.externalUserId);
  }
  expect((await devicesOf(p.project.id)).map((d) => d.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
  expect(await privacyLogRows(p.project.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'person.erased')).toEqual([]);
  expect(await activityRows(p.project.id, 'person.exported')).toEqual([]);
});

test('PPL-155 Export by external id', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { name: 'Backend exports', permissions: ['privacy'] });
  const asha = await seedAsha(p, clientIp);
  const { token } = await seedHistory(p, clientIp, asha);
  const otherId = uniqueId('anon-other');
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-other'), distinctId: otherId });
  await api('POST', '/api/identity/merge', { projectId: p.project.id, anonymousId: otherId, identifiedId: asha.externalUserId }, { apiKey: p.sdkKey, ip: clientIp });

  const exported = await privacyApi('exports', { externalUserId: asha.externalUserId }, kp.fullKey, clientIp);
  expect(exported.status).toBe(200);
  const doc = exported.body.data;
  expect(doc).toMatchObject({ projectId: p.project.id, subject: { type: 'externalUserId', value: asha.externalUserId }, truncated: false });
  expect(doc.sections.device_identities.rows.map((r: { id: string }) => r.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
  expect(doc.sections.push_tokens.rows).toEqual([expect.objectContaining({ tokenEnding: `…${token.slice(-6)}` })]);
  expect(JSON.stringify(doc)).not.toContain(token);
  expect(doc.sections.identity_aliases.rows).toEqual([expect.objectContaining({ anonymousId: WITHHELD, identifiedId: asha.externalUserId })]);
  expect(JSON.stringify(doc)).not.toContain(otherId);

  const [log] = await privacyLogRows(p.project.id);
  expect(log).toMatchObject({ kind: 'export', subject_type: 'externalUserId', actor_type: 'api_key', actor_id: kp.id, result: 'exported' });
  const logged = await activityRows(p.project.id, 'person.exported');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ actor_kind: 'api_key', actor_label: 'API key "Backend exports"', target_type: 'person', target_id: [asha.ios.id, asha.web.id].sort()[0] });
});

test('PPL-156 Privacy API acts only on the key\'s project', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  const q = await peopleProject(clientIp, 'ppl-outsider');
  const userQ = uniqueId('user-q');
  const qDevice = await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q'), externalUserId: userQ });

  const missed = await privacyApi('erasures', { externalUserId: userQ }, kp.fullKey, clientIp);
  expect(missed.status).toBe(200);
  expect(missed.body.data).toMatchObject({ result: 'nothing_to_erase', counts: {} });
  expect(await deviceRow(qDevice.id)).toMatchObject({ external_user_id: userQ });

  const named = await privacyApi('erasures', { externalUserId: userQ, projectId: q.project.id }, kp.fullKey, clientIp);
  expect(named.status).toBe(400);
  expect(messageOf(named)).toBe('property projectId should not exist');
  expect(await deviceRow(qDevice.id)).toMatchObject({ external_user_id: userQ });
  expect(await privacyLogRows(q.project.id)).toEqual([]);
});

test('PPL-157 Privacy API key checks', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const expired = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'], expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const revoked = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  await revokeKey(p.owner, p.project.id, revoked.id, clientIp);
  const person = uniqueId('user-k');
  const device = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-k'), externalUserId: person });

  const cases: Array<{ label: string; key?: string; token?: string; status: number; message: string }> = [
    { label: 'no key', status: 401, message: 'API key is required' },
    { label: 'random key', key: `chq_${randomBytes(24).toString('hex')}`, status: 401, message: 'Invalid or expired API key' },
    {
      label: 'SDK key',
      key: p.sdkKey,
      status: 403,
      message: 'This API key does not have the "privacy" permission. Create a server-only key with it in the dashboard.',
    },
    { label: 'expired privacy key', key: expired.fullKey, status: 401, message: 'Invalid or expired API key' },
    { label: 'revoked privacy key', key: revoked.fullKey, status: 401, message: 'Invalid or expired API key' },
    { label: 'dashboard JWT', token: p.owner.accessToken, status: 401, message: 'API key is required' },
  ];
  for (const { label, key, token, status, message } of cases) {
    for (const route of ['erasures', 'exports'] as const) {
      const refused = await privacyApi(route, { externalUserId: person }, key, clientIp, token);
      expect(refused.status, `${label} ${route}`).toBe(status);
      expect(refused.body.message, `${label} ${route}`).toBe(message);
    }
  }
  expect(await deviceRow(device.id)).toMatchObject({ external_user_id: person });
  expect(await privacyLogRows(p.project.id)).toEqual([]);
});

test('PPL-161 Trust model: SDK-set links never widen an erasure or export', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  const victimId = uniqueId('user-v');
  const preLoginId = uniqueId('anon-v');
  const attackerId = uniqueId('attacker');
  const victim = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-victim'), externalUserId: victimId, distinctId: victimId });
  expect((await trackEvent(p, clientIp, { eventName: 'victim_event', deviceFingerprint: victim.deviceFingerprint })).status).toBe(201);
  expect((await trackEvent(p, clientIp, { eventName: 'victim_pre_login', deviceFingerprint: victim.deviceFingerprint, distinctId: preLoginId })).status).toBe(201);
  const victimTouchpoint = await seedTouchpoint(p.project.id, victim.deviceFingerprint, victimId);
  // The attacker's anonymous device claims the victim's id and relabels her pre-login id as its own.
  const attacker = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-attacker'), distinctId: victimId });
  await api('POST', '/api/identity/merge', { projectId: p.project.id, anonymousId: preLoginId, identifiedId: attackerId }, { apiKey: p.sdkKey, ip: clientIp });
  const victimSide = [victimId, victim.id, victim.deviceFingerprint, victimTouchpoint, 'victim_event', 'victim_pre_login', preLoginId];

  const attackerExport = await privacyApi('exports', { deviceFingerprint: attacker.deviceFingerprint }, kp.fullKey, clientIp);
  expect(attackerExport.status).toBe(200);
  const attackerDoc = attackerExport.body.data;
  expect(attackerDoc.sections.device_identities.rows).toEqual([expect.objectContaining({ id: attacker.id, distinctId: WITHHELD })]);
  expect(attackerDoc.sections.user_events.total).toBe(0);
  expect(attackerDoc.sections.touchpoints.total).toBe(0);
  for (const value of victimSide) expect(JSON.stringify(attackerDoc), value).not.toContain(value);

  const victimBefore = await privacyApi('exports', { externalUserId: victimId }, kp.fullKey, clientIp);
  expect(victimBefore.status).toBe(200);
  expect(victimBefore.body.data.sections.device_identities.rows.map((r: { id: string }) => r.id)).toEqual([victim.id]);
  for (const value of [attacker.id, attacker.deviceFingerprint, attackerId]) expect(JSON.stringify(victimBefore.body.data), value).not.toContain(value);

  const attackerErasure = await privacyApi('erasures', { deviceFingerprint: attacker.deviceFingerprint }, kp.fullKey, clientIp);
  expect(attackerErasure.status).toBe(200);
  expect(attackerErasure.body.data).toMatchObject({ result: 'erased', counts: { device_identities: 1 } });
  expect(await deviceRow(attacker.id)).toBeUndefined();
  expect(await deviceRow(victim.id)).toMatchObject({ external_user_id: victimId });
  expect(await rowsNamingDevices('user_events', [victim.id])).toBe(2);
  expect(await sql(`SELECT id FROM touchpoints WHERE id = $1`, [victimTouchpoint])).toHaveLength(1);

  const victimAfter = await privacyApi('exports', { externalUserId: victimId }, kp.fullKey, clientIp);
  expect(victimAfter.body.data.sections.device_identities.rows.map((r: { id: string }) => r.id)).toEqual([victim.id]);
  expect(victimAfter.body.data.sections.user_events.total).toBe(2);
  for (const value of [attacker.id, attacker.deviceFingerprint, attackerId]) expect(JSON.stringify(victimAfter.body.data), value).not.toContain(value);
});

test('PPL-166 Erasure deletes the person\'s tracking objection', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const objected = await raw(
    'POST',
    `/api/identity/projects/${p.project.id}/tracking-objections`,
    { externalUserId: asha.externalUserId },
    { ip: clientIp, token: p.owner.accessToken },
  );
  expect(objected.status).toBe(201);
  expect(await objectionRows(p.project.id)).toHaveLength(1);

  const erased = await eraseAsOwner(p, asha.ios.id, clientIp);
  expect(erased.status).toBe(200);
  expect(erased.body.data).toMatchObject({ result: 'erased', counts: { tracking_objections: 1 } });
  expect(JSON.stringify(erased.body.data.notErased)).not.toMatch(/objection/i);
  expect(await objectionRows(p.project.id)).toEqual([]);

  const preview = await raw(
    'GET',
    `/api/identity/projects/${p.project.id}/tracking-objections/preview?externalUserId=${encodeURIComponent(asha.externalUserId)}`,
    undefined,
    { ip: clientIp, token: p.owner.accessToken },
  );
  expect(preview.status).toBe(200);
  expect(preview.body.data).toEqual({
    externalUserId: asha.externalUserId,
    deviceCount: 0,
    objecting: false,
    createdAt: null,
    createdBy: null,
    sourceIdentityId: null,
  });

  const after = fingerprint('fp-asha-after');
  const returned = await raw(
    'POST',
    '/api/identity/identify',
    {
      projectId: p.project.id,
      platform: 'web',
      deviceFingerprint: after,
      externalUserId: asha.externalUserId,
      userHash: userHash(p.secret, asha.externalUserId),
      utmSource: 'google',
      referrer: 'https://r.example/x',
    },
    { ip: clientIp, apiKey: p.sdkKey },
  );
  expect(returned.status).toBe(201);
  expect(await deviceByFingerprint(p.project.id, after)).toMatchObject({
    ip_address: clientIp,
    country: 'India',
    initial_utm_source: 'google',
    initial_referring_domain: 'r.example',
    total_sessions: 1,
    do_not_track: false,
  });
});

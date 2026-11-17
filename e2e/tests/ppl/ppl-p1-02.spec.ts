import { randomBytes, randomUUID } from 'crypto';
import { format } from 'date-fns';
import type { Page, Response } from '@playwright/test';
import { createAccount, createProject, newClientIp, type Account } from '../../support/api';
import { readDownload } from '../../support/browser-tools';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { signUnsubscribeLink } from '../../support/signing';
import {
  activityRows,
  addTeammate,
  ageSignIn,
  consentEvents,
  createKey,
  deviceByFingerprint,
  deviceRow,
  devicesOf,
  fingerprint,
  identify,
  insertActiveDevice,
  insertCampaign,
  insertCampaignEvent,
  insertCampaignWithLists,
  insertInAppImpressions,
  insertJourneyRuns,
  messageOf,
  objectionRows,
  oneClickUnsubscribe,
  peopleProject,
  privacyApi,
  privacyLogRows,
  profileProperties,
  profileSection,
  raw,
  rowsNamingDevices,
  sectionTotals,
  seedPushToken,
  seedSegmentMembers,
  sql,
  staleAccessToken,
  toast,
  trackEvent,
  viewAsToken,
  type PeopleProject,
} from '../../support/areas/ppl';

/**
 * Consent edits that change nothing or carry bad values, person objections (preview,
 * create, provenance), the dashboard's device lookups, person export and erasure from
 * the profile page (dialog, confirmation, re-authentication, repeats, campaign
 * records), the privacy request log and its search, and the server privacy API.
 * People arrive through the SDK's identify route; what a request wrote is read back
 * with SQL and from the documents the API answers.
 */

test.describe.configure({ mode: 'parallel' });

const READ_ONLY = 'Impersonation sessions are read-only';
const PROJECT_NOT_FOUND = 'Project not found';
const PERSON_NOT_FOUND = 'Person not found';
const ROLE_REFUSAL = 'Your role in this project does not allow this.';
const REAUTH_REQUIRED = 'Confirm it is you to continue.';
const ONE_OF = 'Send exactly one of externalUserId or deviceFingerprint';
const UUID_EXPECTED = 'Validation failed (uuid is expected)';
const ERROR_SCREEN = 'Unexpected Application Error!';
const LOG_KEYS = ['actorId', 'actorType', 'counts', 'createdAt', 'id', 'kind', 'result', 'subjectType'];

function uniqueId(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}`;
}

function uniquePhone(): string {
  return `+9198${String(randomBytes(4).readUInt32BE(0) % 100_000_000).padStart(8, '0')}`;
}

/** A local wall-clock time as Postgres `timestamp` text. */
function local(date: Date): string {
  return format(date, 'yyyy-MM-dd HH:mm:ss');
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
    traits: { $name: 'Asha Rao', $email: email, plan: 'pro' },
  };
  const ios = await identify(p, ip, { ...common, deviceFingerprint: fingerprint('fp-asha-ios'), platform: 'ios' });
  const web = await identify(p, ip, { ...common, deviceFingerprint: fingerprint('fp-asha-web'), platform: 'web' });
  return { externalUserId, email, phone, ios, web };
}

async function outsiderAccount(ip: string): Promise<Account> {
  const outsider = await createAccount(ip, 'ppl-outsider', 'Olu Outsider');
  await createProject(outsider, ip);
  return outsider;
}

function consentPath(p: PeopleProject, personId: string): string {
  return `/api/identity/projects/${p.project.id}/users/${personId}/consent`;
}

function objectionsPath(p: PeopleProject, suffix = ''): string {
  return `/api/identity/projects/${p.project.id}/tracking-objections${suffix}`;
}

function previewPath(p: PeopleProject, externalUserId: string): string {
  return objectionsPath(p, `/preview?externalUserId=${encodeURIComponent(externalUserId)}`);
}

function eraseAs(p: PeopleProject, personId: string, ip: string, token = p.owner.accessToken) {
  return raw('DELETE', `/api/projects/${p.project.id}/users/${personId}`, undefined, { ip, token });
}

function exportAs(p: PeopleProject, personId: string, ip: string, token = p.owner.accessToken) {
  return raw('GET', `/api/projects/${p.project.id}/users/${personId}/export`, undefined, { ip, token });
}

function logList(p: PeopleProject, ip: string, token = p.owner.accessToken) {
  return raw('GET', `/api/projects/${p.project.id}/privacy-requests`, undefined, { ip, token });
}

function logSearch(p: PeopleProject, body: unknown, ip: string, token = p.owner.accessToken) {
  return raw('POST', `/api/projects/${p.project.id}/privacy-requests/search`, body, { ip, token });
}

function profilePath(p: PeopleProject, personId: string): string {
  return `/projects/${p.project.id}/users/${personId}`;
}

async function openProfile(page: Page, p: PeopleProject, personId: string): Promise<void> {
  await page.goto(profilePath(p, personId));
  await expect(page.getByRole('heading', { name: 'User Profile' })).toBeVisible();
}

function deleteDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Delete this person and their data?' });
}

/** Opens "Delete person" and types the confirmation. */
async function confirmDelete(page: Page, confirmation: string) {
  await page.getByRole('button', { name: 'Delete person' }).click();
  const dialog = deleteDialog(page);
  await dialog.getByLabel(`Type ${confirmation} to confirm`).fill(confirmation);
  return dialog;
}

function isDeleteOf(p: PeopleProject, personId: string) {
  return (r: Response) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/api/projects/${p.project.id}/users/${personId}`;
}

/** Every section of an export, checked empty. */
function expectEmptySections(doc: { sections: Record<string, unknown> }): void {
  expect(Object.keys(doc.sections).length).toBeGreaterThan(5);
  for (const [name, section] of Object.entries(doc.sections)) {
    expect(section, name).toEqual({ total: 0, truncated: false, rows: [] });
  }
}

// ---- Consent edit

test('PPL-100 Consent edit with no real change writes nothing', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-consent'), emailOptIn: false });
  const before = await consentEvents(person.id);
  expect(before).toEqual([{ channel: 'email', granted: false, source: 'sdk' }]);
  const auth = { ip: clientIp, token: p.owner.accessToken };

  for (const body of [{ emailOptIn: false }, { emailOptIn: null }, {}]) {
    await sql(`UPDATE device_identities SET consent_updated_at = now() - interval '2 days' WHERE id = $1`, [person.id]);
    const stampedAfter = Date.now() - 60_000;
    const answer = await raw('PATCH', consentPath(p, person.id), body, auth);
    expect(answer.status, JSON.stringify(body)).toBe(200);
    expect(answer.body.data).toMatchObject({ id: person.id, emailOptIn: false });
    const row = await deviceRow(person.id);
    expect(row!.email_opt_in).toBe(false);
    // Stamped even though nothing changed, as the case records.
    expect(row!.consent_updated_at.getTime()).toBeGreaterThan(stampedAfter);
  }
  expect(await consentEvents(person.id)).toEqual(before);
  expect(await activityRows(p.project.id, 'person.consent_changed')).toEqual([]);

  // A real change is recorded, once.
  expect((await raw('PATCH', consentPath(p, person.id), { emailOptIn: true }, auth)).status).toBe(200);
  expect(await consentEvents(person.id)).toEqual([...before, { channel: 'email', granted: true, source: 'dashboard' }]);
  expect(await activityRows(p.project.id, 'person.consent_changed')).toHaveLength(1);
});

test('PPL-101 Consent edit validation: unknown fields', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-consent'), emailOptIn: false });

  const refused = await raw('PATCH', consentPath(p, person.id), { foo: true }, { ip: clientIp, token: p.owner.accessToken });
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toBe('property foo should not exist');
  expect(await consentEvents(person.id)).toEqual([{ channel: 'email', granted: false, source: 'sdk' }]);
});

test('PPL-101 Consent edit validation: values that are not booleans', { annotation: { type: 'issue', description: 'PPL-101' } }, async ({ clientIp }) => {
  test.fail();
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-consent'), emailOptIn: false, pushOptIn: false });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ emailOptIn: 'yes' }, 'emailOptIn must be a boolean value'],
    [{ pushOptIn: 1 }, 'pushOptIn must be a boolean value'],
  ];
  for (const [body, message] of cases) {
    const answer = await raw('PATCH', consentPath(p, person.id), body, { ip: clientIp, token: p.owner.accessToken });
    expect(answer.status, JSON.stringify(body)).toBe(400);
    expect(messageOf(answer)).toContain(message);
  }
  expect(await deviceRow(person.id)).toMatchObject({ email_opt_in: false, push_opt_in: false });
});

// ---- Tracking objections

test('PPL-106 Preview shows the exact id and device count', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const nobody = uniqueId('user-nobody');
  const auth = { ip: clientIp, token: p.owner.accessToken };

  const shown = await raw('GET', previewPath(p, asha.externalUserId), undefined, auth);
  expect(shown.status).toBe(200);
  expect(shown.body.data).toEqual({
    externalUserId: asha.externalUserId,
    deviceCount: 2,
    objecting: false,
    createdAt: null,
    createdBy: null,
    sourceIdentityId: null,
  });
  const none = await raw('GET', previewPath(p, nobody), undefined, auth);
  expect(none.status).toBe(200);
  expect(none.body.data).toEqual({ externalUserId: nobody, deviceCount: 0, objecting: false, createdAt: null, createdBy: null, sourceIdentityId: null });

  expect(await objectionRows(p.project.id)).toEqual([]);
  for (const device of [asha.ios, asha.web]) expect(await consentEvents(device.id)).toEqual([]);
  expect(await sql(`SELECT id FROM project_activity WHERE project_id = $1 AND action LIKE 'tracking.%'`, [p.project.id])).toEqual([]);
});

test('PPL-107 Preview validation and roles', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);
  const outsider = await outsiderAccount(clientIp);
  const owner = { ip: clientIp, token: p.owner.accessToken };

  const missing = await raw('GET', objectionsPath(p, '/preview'), undefined, owner);
  expect(missing.status).toBe(400);
  expect(messageOf(missing)).toContain('externalUserId should not be empty');

  const long = await raw('GET', previewPath(p, 'u'.repeat(256)), undefined, owner);
  expect(long.status).toBe(400);
  expect(messageOf(long)).toBe('externalUserId must be shorter than or equal to 255 characters');

  const extra = await raw('GET', `${previewPath(p, asha.externalUserId)}&foo=1`, undefined, owner);
  expect(extra.status).toBe(400);
  expect(messageOf(extra)).toBe('property foo should not exist');

  for (const teammate of [admin, member]) {
    const refused = await raw('GET', previewPath(p, asha.externalUserId), undefined, { ip: clientIp, token: teammate.accessToken });
    expect(refused.status, teammate.email).toBe(403);
    expect(refused.body.message).toBe(ROLE_REFUSAL);
  }
  const asOutsider = await raw('GET', previewPath(p, asha.externalUserId), undefined, { ip: clientIp, token: outsider.accessToken });
  expect(asOutsider.status).toBe(404);
  expect(asOutsider.body.message).toBe(PROJECT_NOT_FOUND);
  expect(JSON.stringify(asOutsider.body)).not.toContain('deviceCount');

  // The owner's valid preview answers.
  const shown = await raw('GET', previewPath(p, asha.externalUserId), undefined, owner);
  expect(shown.status).toBe(200);
  expect(shown.body.data.deviceCount).toBe(2);
});

test('PPL-110 Create objection is idempotent', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const auth = { ip: clientIp, token: p.owner.accessToken };

  const first = await raw('POST', objectionsPath(p), { externalUserId: asha.externalUserId, sourceIdentityId: asha.ios.id }, auth);
  expect(first.status).toBe(201);
  const [stored] = await objectionRows(p.project.id);

  const again = await raw('POST', objectionsPath(p), { externalUserId: asha.externalUserId }, auth);
  expect(again.status).toBe(201);
  expect(again.body.data).toEqual({
    externalUserId: asha.externalUserId,
    deviceCount: 2,
    objecting: true,
    createdAt: first.body.data.createdAt,
    createdBy: p.owner.userId,
    sourceIdentityId: asha.ios.id,
  });
  expect(await objectionRows(p.project.id)).toEqual([stored]);
  for (const device of [asha.ios, asha.web]) {
    expect(await consentEvents(device.id)).toEqual([{ channel: 'tracking', granted: false, source: 'dashboard' }]);
  }
  expect(await activityRows(p.project.id, 'tracking.objection_recorded')).toHaveLength(1);
});

test('PPL-111 Create objection validation and source row checks', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const q = await peopleProject(clientIp, 'ppl-outsider');
  const qDevice = await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q') });
  const auth = { ip: clientIp, token: p.owner.accessToken };
  const post = (body: unknown) => raw('POST', objectionsPath(p), body, auth);

  const cases: Array<[string, unknown, number, string]> = [
    ['empty id', { externalUserId: '' }, 400, 'externalUserId should not be empty'],
    ['malformed source', { externalUserId: 'u', sourceIdentityId: 'abc' }, 400, 'sourceIdentityId must be a UUID'],
    ['unknown source', { externalUserId: asha.externalUserId, sourceIdentityId: randomUUID() }, 404, PERSON_NOT_FOUND],
    ['source in another project', { externalUserId: asha.externalUserId, sourceIdentityId: qDevice.id }, 404, PERSON_NOT_FOUND],
    ['extra field', { externalUserId: asha.externalUserId, projectId: p.project.id }, 400, 'property projectId should not exist'],
  ];
  for (const [label, body, status, message] of cases) {
    const answer = await post(body);
    expect(answer.status, label).toBe(status);
    expect(messageOf(answer), label).toBe(message);
  }
  expect(await objectionRows(p.project.id)).toEqual([]);
  expect(await objectionRows(q.project.id)).toEqual([]);
  for (const device of [asha.ios, asha.web, qDevice]) expect(await consentEvents(device.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'tracking.objection_recorded')).toEqual([]);

  // An id no device claims yet: stored, and it covers a device that arrives later.
  const future = uniqueId('user-future');
  const stored = await post({ externalUserId: future });
  expect(stored.status).toBe(201);
  expect(stored.body.data).toMatchObject({ externalUserId: future, deviceCount: 0, objecting: true, createdBy: p.owner.userId, sourceIdentityId: null });
  expect(await objectionRows(p.project.id)).toEqual([expect.objectContaining({ external_user_id: future })]);
  const later = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-future'), externalUserId: future, utmSource: 'later' });
  expect(await deviceRow(later.id)).toMatchObject({ total_sessions: 0, ip_address: null, initial_utm_source: null });
});

// ---- Device lookups

test('PPL-118 Devices by external id', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  // The web device was seen an hour before the iOS one.
  await sql(`UPDATE device_identities SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, [asha.web.id]);
  const q = await peopleProject(clientIp, 'ppl-outsider');
  const onlyInQ = uniqueId('user-q');
  await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q'), externalUserId: onlyInQ });
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);
  const auth = { ip: clientIp, token: member.accessToken };
  const path = `/api/identity/projects/${p.project.id}/devices`;

  const listed = await raw('GET', `${path}?userId=${encodeURIComponent(asha.externalUserId)}`, undefined, auth);
  expect(listed.status).toBe(200);
  expect(listed.body.data.map((d: { id: string }) => d.id)).toEqual([asha.ios.id, asha.web.id]);
  expect(listed.body.data[0]).toMatchObject({ externalUserId: asha.externalUserId, deviceFingerprint: asha.ios.deviceFingerprint });

  const missing = await raw('GET', path, undefined, auth);
  expect(missing.status).toBe(400);
  expect(missing.body.message).toBe('userId is required');

  const foreign = await raw('GET', `${path}?userId=${encodeURIComponent(onlyInQ)}`, undefined, auth);
  expect(foreign.status).toBe(200);
  expect(foreign.body.data).toEqual([]);
});

test('PPL-119 Device by fingerprint', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const q = await peopleProject(clientIp, 'ppl-outsider');
  const qDevice = await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-only-q') });
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);
  const auth = { ip: clientIp, token: member.accessToken };
  const path = (fp: string) => `/api/identity/projects/${p.project.id}/device/${encodeURIComponent(fp)}`;

  const found = await raw('GET', path(asha.ios.deviceFingerprint), undefined, auth);
  expect(found.status).toBe(200);
  expect(found.body.data).toMatchObject({ id: asha.ios.id, deviceFingerprint: asha.ios.deviceFingerprint, externalUserId: asha.externalUserId, platform: 'ios' });

  for (const fp of [fingerprint('unknown-fp'), qDevice.deviceFingerprint]) {
    const missing = await raw('GET', path(fp), undefined, auth);
    expect(missing.status, fp).toBe(404);
    expect(missing.body.message).toBe('Device not found');
    expect(JSON.stringify(missing.body)).not.toContain(qDevice.id);
  }
});

// ---- Person export

test('PPL-128 Export API: bad ids, outsiders, throttle', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const outsider = await outsiderAccount(clientIp);

  const malformed = await raw('GET', `/api/projects/${p.project.id}/users/abc/export`, undefined, { ip: clientIp, token: p.owner.accessToken });
  expect(malformed.status).toBe(400);
  expect(malformed.body.message).toBe(UUID_EXPECTED);

  const refused = await exportAs(p, asha.ios.id, clientIp, outsider.accessToken);
  expect(refused.status).toBe(404);
  expect(refused.body.message).toBe(PROJECT_NOT_FOUND);
  expect(await privacyLogRows(p.project.id)).toEqual([]);

  // A client of its own, so the requests above do not count.
  const burst = newClientIp();
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await exportAs(p, asha.ios.id, burst)).status);
  expect(statuses).toEqual([...Array(10).fill(200), 429]);
  expect(await privacyLogRows(p.project.id)).toHaveLength(10);
});

test('PPL-167 Export of a person with an objection lists it', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const anon = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-anon-1') });
  const objected = await raw('POST', objectionsPath(p), { externalUserId: asha.externalUserId, sourceIdentityId: asha.ios.id }, { ip: clientIp, token: p.owner.accessToken });
  expect(objected.status).toBe(201);

  const exported = await exportAs(p, asha.ios.id, clientIp);
  expect(exported.status).toBe(200);
  const section = exported.body.data.sections.tracking_objections;
  expect(section).toEqual({ total: 1, truncated: false, rows: [{ externalUserId: asha.externalUserId, createdAt: expect.any(String) }] });
  expect(new Date(section.rows[0].createdAt).toISOString()).toBe(new Date(objected.body.data.createdAt).toISOString());
  expect(JSON.stringify(section)).not.toContain(p.owner.userId);

  const anonExport = await exportAs(p, anon.id, clientIp);
  expect(anonExport.status).toBe(200);
  expect(anonExport.body.data.sections.tracking_objections).toEqual({ total: 0, truncated: false, rows: [] });
});

// ---- Person erasure: the dialog

test('PPL-129 Delete dialog content for a signed-in person', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);

  await signIn(page, p.owner);
  await openProfile(page, p, asha.ios.id);
  await page.getByRole('button', { name: 'Delete person' }).click();
  const dialog = deleteDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('This cannot be undone.', { exact: true })).toBeVisible();
  await expect(dialog.locator('p').filter({ hasText: /^This deletes this device/ })).toHaveText(
    `This deletes this device and every device signed in as ${asha.externalUserId}.`,
  );
  const section = (title: string) => dialog.locator('div').filter({ has: page.getByText(title, { exact: true }) }).last();
  await expect(section('Deleted from Chumbaq').locator('p').nth(1)).toHaveText(
    'Every device linked to this person, their profile, traits and consent, events, clicks, conversions, attribution, push tokens, message delivery records for every channel, in-app impressions, journey progress, segment membership, and Mixpanel cohort membership (which comes back at the next cohort sync unless you delete the person in Mixpanel too).',
  );
  await expect(section('Kept').locator('p').nth(1)).toHaveText(
    'Opt-outs (unsubscribes, bounces, complaints), as one-way hashes, so the person is not messaged again if their address is added later. An opt-out or delivery failure for an address another record in this project also holds, as it is. Campaign totals, as anonymous numbers. A log entry recording that you made this request, with their ids stored only as keyed hashes.',
  );
  const notDeleted = section('Not deleted by Chumbaq').locator('p');
  await expect(notDeleted.nth(1)).toHaveText(
    'Other devices shown on this page that are not signed in as this user, and events recorded under their ids. Events recorded before sign-in that were never linked to this user. History recorded on a shared device before this user signed in goes with the device, not the user. Nothing proves these are theirs, so they are kept.',
  );
  await expect(notDeleted.nth(2)).toHaveText(
    'Database backups until they expire; anything already sent to your providers and tools (FCM, APNs, SES, Resend, Brevo, Twilio, Meta, Gupshup, Interakt, Mixpanel, your webhooks), which you must delete there; server logs. If your app is still running on their device it will send new data: sign them out or reset the SDK too.',
  );
  const field = dialog.getByLabel(`Type ${asha.externalUserId} to confirm`);
  await expect(field).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Delete person' })).toBeDisabled();
});

test('PPL-130 Delete dialog content for an anonymous device', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const anonFp = fingerprint('fp-anon-1');
  const anon = await identify(p, clientIp, { deviceFingerprint: anonFp });
  const distinctId = uniqueId('anon-d');
  const withDistinct = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-anon-2'), distinctId });

  await signIn(page, p.owner);
  for (const [id, confirmation] of [
    [anon.id, anonFp],
    [withDistinct.id, distinctId],
  ]) {
    await openProfile(page, p, id);
    await page.getByRole('button', { name: 'Delete person' }).click();
    const dialog = deleteDialog(page);
    await expect(dialog.locator('p').filter({ hasText: /^This deletes this device/ })).toHaveText('This deletes this device.');
    await expect(dialog.getByLabel(`Type ${confirmation} to confirm`)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete person' })).toBeDisabled();
    await dialog.getByLabel(`Type ${confirmation} to confirm`).fill(confirmation);
    await expect(dialog.getByRole('button', { name: 'Delete person' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  }
  expect(await devicesOf(p.project.id)).toHaveLength(2);
});

test('PPL-131 Confirmation must match exactly', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);

  await signIn(page, p.owner);
  await openProfile(page, p, asha.ios.id);
  await page.getByRole('button', { name: 'Delete person' }).click();
  const dialog = deleteDialog(page);
  const field = dialog.getByLabel(`Type ${asha.externalUserId} to confirm`);
  const submit = dialog.getByRole('button', { name: 'Delete person' });

  for (const typed of [asha.externalUserId.slice(0, -1), asha.externalUserId.toUpperCase(), `${asha.externalUserId}x`]) {
    await field.fill(typed);
    await expect(submit, typed).toBeDisabled();
  }
  await field.fill(`  ${asha.externalUserId}  `);
  await expect(submit).toBeEnabled();
  await field.fill(asha.externalUserId);
  await expect(submit).toBeEnabled();
  expect(await devicesOf(p.project.id)).toHaveLength(2);
});

// ---- Person erasure: re-authentication, repeats and what it removes

test('PPL-136 Erasure re-auth cancelled', async ({ page, clientIp }) => {
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
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toBeHidden();

  await expect(toast(page, 'Could not delete this person')).toContainText(REAUTH_REQUIRED);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete person' })).toBeEnabled();
  expect(deletes.map((r) => r.status())).toEqual([403]);
  expect((await devicesOf(p.project.id)).map((d) => d.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
  expect(await privacyLogRows(p.project.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'person.erased')).toEqual([]);
});

test('PPL-139 Second erasure answers "Nothing left to delete"', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const anonFp = fingerprint('fp-anon-1');
  const anon = await identify(p, clientIp, { deviceFingerprint: anonFp });
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-other') });

  await signIn(page, p.owner);
  await openProfile(page, p, anon.id);
  const tabB = await page.context().newPage();
  await openProfile(tabB, p, anon.id);
  const dialogB = await confirmDelete(tabB, anonFp);

  const dialogA = await confirmDelete(page, anonFp);
  const [first] = await Promise.all([page.waitForResponse(isDeleteOf(p, anon.id)), dialogA.getByRole('button', { name: 'Delete person' }).click()]);
  expect(first.status()).toBe(200);
  expect((await first.json()).data.result).toBe('erased');
  await expect(toast(page, 'Person deleted')).toBeVisible();

  const [second] = await Promise.all([tabB.waitForResponse(isDeleteOf(p, anon.id)), dialogB.getByRole('button', { name: 'Delete person' }).click()]);
  expect(second.status()).toBe(200);
  expect((await second.json()).data).toMatchObject({ result: 'nothing_to_erase', counts: {} });
  await expect(toast(tabB, 'Nothing left to delete')).toHaveText('Nothing left to delete');
  await expect(tabB).toHaveURL(new RegExp(`/projects/${p.project.id}/users$`));

  expect((await privacyLogRows(p.project.id)).map((r) => r.result)).toEqual(['erased', 'nothing_to_erase']);
  expect((await activityRows(p.project.id, 'person.erased')).map((r) => [r.target_type, r.target_id])).toEqual([
    ['person', anon.id],
    ['person', null],
  ]);
  expect(await devicesOf(p.project.id)).toHaveLength(1);
});

test('PPL-142 Erasure removes the person from campaign records', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const bob = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-bob'), firstName: 'Bob' });
  const ashaToken = await seedPushToken(p.project.id, asha.ios.id);
  const bobToken = await seedPushToken(p.project.id, bob.id, 'android');
  const campaign = await insertCampaignWithLists(p.project.id, {
    targets: [asha.ios.id, asha.web.id, bob.id],
    controls: [asha.web.id, bob.id],
    failures: [
      { token: ashaToken, error: 'unregistered' },
      { token: bobToken, error: 'quota' },
    ],
  });
  const [ashaImpression, bobImpression] = await insertInAppImpressions(p.project.id, [asha.ios, bob]);
  const [ashaRun, bobRun] = await insertJourneyRuns(p.project.id, [asha.externalUserId, `device:${bob.id}`]);
  await seedSegmentMembers(p.project.id, [asha.externalUserId, `device:${bob.id}`]);
  for (const id of [asha.ios.id, asha.web.id, bob.id]) await insertActiveDevice(p.project.id, id);

  const erased = await eraseAs(p, asha.ios.id, clientIp);
  expect(erased.status).toBe(200);
  expect(erased.body.data).toMatchObject({
    result: 'erased',
    counts: {
      campaign_recipients: 3,
      push_notification_logs: 1,
      in_app_message_impressions: 1,
      journey_runs: 1,
      segment_members: 1,
      monthly_active_devices: 2,
    },
  });

  expect(await sql(`SELECT role, device_identity_id FROM campaign_recipients WHERE campaign_id = $1 ORDER BY role`, [campaign])).toEqual([
    { role: 'control', device_identity_id: bob.id },
    { role: 'target', device_identity_id: bob.id },
  ]);
  expect(await sql(`SELECT failure_details, success_count, failure_count FROM push_notification_logs WHERE id = $1`, [campaign])).toEqual([
    { failure_details: [{ token: bobToken, error: 'quota' }], success_count: 5, failure_count: 2 },
  ]);
  expect((await sql(`SELECT id FROM in_app_message_impressions WHERE project_id = $1`, [p.project.id])).map((r) => r.id)).toEqual([bobImpression]);
  expect(await sql(`SELECT id FROM in_app_message_impressions WHERE id = $1`, [ashaImpression])).toEqual([]);
  expect((await sql(`SELECT id FROM journey_runs WHERE project_id = $1`, [p.project.id])).map((r) => r.id)).toEqual([bobRun]);
  expect(await sql(`SELECT id FROM journey_runs WHERE id = $1`, [ashaRun])).toEqual([]);
  expect(await sql(`SELECT person_key FROM segment_members WHERE project_id = $1`, [p.project.id])).toEqual([{ person_key: `device:${bob.id}` }]);
  expect(await sql(`SELECT device_identity_id FROM monthly_active_devices WHERE project_id = $1`, [p.project.id])).toEqual([{ device_identity_id: bob.id }]);
});

test('PPL-144 Erasure API: bad ids, outsiders, other project\'s person, throttle', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const outsider = await outsiderAccount(clientIp);
  const q = await peopleProject(clientIp, 'ppl-other', p.owner);
  const qDevice = await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q'), firstName: 'Quinn' });

  // The owner's token is from a sign-in a moment ago.
  const malformed = await raw('DELETE', `/api/projects/${p.project.id}/users/abc`, undefined, { ip: clientIp, token: p.owner.accessToken });
  expect(malformed.status).toBe(400);
  expect(malformed.body.message).toBe(UUID_EXPECTED);

  const refused = await eraseAs(p, asha.ios.id, clientIp, outsider.accessToken);
  expect(refused.status).toBe(404);
  expect(refused.body.message).toBe(PROJECT_NOT_FOUND);
  expect(await deviceRow(asha.ios.id)).toBeDefined();

  const foreign = await eraseAs(p, qDevice.id, clientIp);
  expect(foreign.status).toBe(200);
  expect(foreign.body.data).toMatchObject({ result: 'nothing_to_erase', counts: {} });
  expect(await deviceRow(qDevice.id)).toMatchObject({ first_name: 'Quinn', project_id: q.project.id });
  expect(await privacyLogRows(q.project.id)).toEqual([]);

  const burst = newClientIp();
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await eraseAs(p, randomUUID(), burst)).status);
  expect(statuses).toEqual([...Array(10).fill(200), 429]);
  expect((await devicesOf(p.project.id)).map((d) => d.id).sort()).toEqual([asha.ios.id, asha.web.id].sort());
});

test('PPL-145 Profile of an erased person', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users`);
  await page.getByRole('link', { name: /Asha Rao/ }).first().click();
  await expect(page.getByRole('heading', { name: 'User Profile' })).toBeVisible();
  const personId = new URL(page.url()).pathname.split('/').pop()!;
  const dialog = await confirmDelete(page, asha.externalUserId);
  await dialog.getByRole('button', { name: 'Delete person' }).click();
  await expect(toast(page, 'Person deleted')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users$`));

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users/${personId}$`));
  await expect(page.getByText(PERSON_NOT_FOUND, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Users' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'User Profile' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(PERSON_NOT_FOUND, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Users' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users$`));
});

// ---- Privacy request log

test('PPL-147 List privacy requests', async ({ clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  const q = await peopleProject(clientIp, 'ppl-other', p.owner);
  const kq = await createKey(p.owner, q.project.id, clientIp, { permissions: ['privacy'] });
  let ip = newClientIp();
  for (let i = 0; i < 60; i++) {
    // The route allows 30 a minute per client.
    if (i % 25 === 0) ip = newClientIp();
    expect((await privacyApi('exports', { externalUserId: uniqueId('nobody') }, kp.fullKey, ip)).status).toBe(200);
  }
  for (let i = 0; i < 2; i++) expect((await privacyApi('exports', { externalUserId: uniqueId('nobody') }, kq.fullKey, ip)).status).toBe(200);

  const listed = await logList(p, clientIp);
  expect(listed.status).toBe(200);
  const entries = listed.body.data as Array<Record<string, any>>;
  expect(entries).toHaveLength(50);
  for (const entry of entries) {
    expect(Object.keys(entry).sort()).toEqual(LOG_KEYS);
    expect(entry).toMatchObject({ kind: 'export', subjectType: 'externalUserId', actorType: 'api_key', actorId: kp.id, result: 'nothing_found' });
  }
  const times = entries.map((e) => Date.parse(e.createdAt));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  const newest = await sql<{ id: string }>(`SELECT id FROM privacy_request_logs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`, [p.project.id]);
  expect(entries.map((e) => e.id)).toEqual(newest.map((r) => r.id));
  const qIds = (await privacyLogRows(q.project.id)).map((r) => r.id);
  expect(qIds).toHaveLength(2);
  for (const id of qIds) expect(entries.map((e) => e.id)).not.toContain(id);
});

test('PPL-149 Search the log by external id', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const anonFp = fingerprint('fp-anon-1');
  const anon = await identify(p, clientIp, { deviceFingerprint: anonFp });
  const ashaErasure = await eraseAs(p, asha.ios.id, clientIp);
  expect(ashaErasure.status).toBe(200);
  const anonErasure = await eraseAs(p, anon.id, clientIp);
  expect(anonErasure.status).toBe(200);

  const found = await logSearch(p, { externalUserId: asha.externalUserId }, clientIp);
  expect(found.status).toBe(200);
  expect(found.body.data).toHaveLength(1);
  expect(found.body.data[0]).toMatchObject({ id: ashaErasure.body.data.requestId, kind: 'erasure', subjectType: 'personId', result: 'erased' });

  const all = await logSearch(p, {}, clientIp);
  expect(all.status).toBe(200);
  const listed = await logList(p, clientIp);
  expect(all.body.data).toEqual(listed.body.data);
  expect(all.body.data.map((e: { id: string }) => e.id)).toEqual([anonErasure.body.data.requestId, ashaErasure.body.data.requestId]);

  const one = await logSearch(p, { externalUserId: asha.externalUserId, limit: 1 }, clientIp);
  expect(one.status).toBe(200);
  expect(one.body.data.map((e: { id: string }) => e.id)).toEqual([ashaErasure.body.data.requestId]);
  const firstOfAll = await logSearch(p, { limit: 1 }, clientIp);
  expect(firstOfAll.body.data.map((e: { id: string }) => e.id)).toEqual([anonErasure.body.data.requestId]);

  const byFingerprint = await logSearch(p, { externalUserId: anonFp }, clientIp);
  expect(byFingerprint.status).toBe(200);
  expect(byFingerprint.body.data).toEqual([]);
});

test('PPL-150 Search validation, roles, view-as and throttle', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);

  const cases: Array<[string, unknown, string]> = [
    ['limit 0', { limit: 0 }, 'limit must not be less than 1'],
    ['limit 101', { limit: 101 }, 'limit must not be greater than 100'],
    ['empty id', { externalUserId: '' }, 'externalUserId must be longer than or equal to 1 characters'],
    ['control character', { externalUserId: 'a\nb' }, 'externalUserId must not contain control characters'],
    ['unknown field', { foo: 1 }, 'property foo should not exist'],
  ];
  for (const [label, body, message] of cases) {
    const answer = await logSearch(p, body, clientIp);
    expect(answer.status, label).toBe(400);
    expect(messageOf(answer), label).toContain(message);
  }

  const asAdmin = await logSearch(p, { externalUserId: 'user-a' }, clientIp, admin.accessToken);
  expect(asAdmin.status).toBe(403);
  expect(asAdmin.body.message).toBe(ROLE_REFUSAL);
  const asStaff = await logSearch(p, { externalUserId: 'user-a' }, clientIp, viewAs);
  expect(asStaff.status).toBe(403);
  expect(asStaff.body.message).toBe(READ_ONLY);

  const burst = newClientIp();
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) statuses.push((await logSearch(p, { externalUserId: 'user-a' }, burst)).status);
  expect(statuses).toEqual([...Array(30).fill(200), 429]);
});

// ---- Server privacy API

test('PPL-154 Unknown subject', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  await seedAsha(p, clientIp);
  const nobody = uniqueId('nobody');

  const erased = await privacyApi('erasures', { externalUserId: nobody }, kp.fullKey, clientIp);
  expect(erased.status).toBe(200);
  expect(erased.body.data).toMatchObject({ result: 'nothing_to_erase', counts: {} });
  expect(erased.body.data.notErased).toHaveLength(9);

  const exported = await privacyApi('exports', { externalUserId: nobody }, kp.fullKey, clientIp);
  expect(exported.status).toBe(200);
  expect(exported.body.data).toMatchObject({ projectId: p.project.id, subject: { type: 'externalUserId', value: nobody }, truncated: false });
  expectEmptySections(exported.body.data);

  expect((await privacyLogRows(p.project.id)).map((r) => [r.kind, r.result, r.actor_id])).toEqual([
    ['erasure', 'nothing_to_erase', kp.id],
    ['export', 'nothing_found', kp.id],
  ]);
  expect(await devicesOf(p.project.id)).toHaveLength(2);
});

test('PPL-158 Privacy API body validation', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  const person = uniqueId('user-v');
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-v'), externalUserId: person });

  const cases: Array<[string, unknown, string]> = [
    ['nothing', {}, ONE_OF],
    ['both', { externalUserId: person, deviceFingerprint: 'fp' }, ONE_OF],
    ['empty id', { externalUserId: '' }, 'externalUserId must be longer than or equal to 1 characters'],
    ['256 characters', { externalUserId: 'u'.repeat(256) }, 'externalUserId must be shorter than or equal to 255 characters'],
    ['tab', { deviceFingerprint: 'a\tb' }, 'deviceFingerprint must not contain control characters'],
  ];
  for (const route of ['erasures', 'exports'] as const) {
    for (const [label, body, message] of cases) {
      const answer = await privacyApi(route, body, kp.fullKey, clientIp);
      expect(answer.status, `${route} ${label}`).toBe(400);
      expect(messageOf(answer), `${route} ${label}`).toContain(message);
    }
  }
  expect(await privacyLogRows(p.project.id)).toEqual([]);
  expect(await devicesOf(p.project.id)).toHaveLength(1);

  // A number is converted to its string by the validation pipe, and matches nobody.
  for (const route of ['erasures', 'exports'] as const) {
    const numeric = await privacyApi(route, { externalUserId: 5 }, kp.fullKey, clientIp);
    expect(numeric.status, route).toBe(200);
  }
  expect((await privacyLogRows(p.project.id)).map((r) => r.result)).toEqual(['nothing_to_erase', 'nothing_found']);
});

test('PPL-159 Privacy API status, idempotency and throttle', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  const userX = uniqueId('user-x');
  const device = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-x'), externalUserId: userX });

  const first = await privacyApi('erasures', { externalUserId: userX }, kp.fullKey, clientIp);
  expect(first.status).toBe(200);
  expect(first.body.data.result).toBe('erased');
  expect(await deviceRow(device.id)).toBeUndefined();
  const second = await privacyApi('erasures', { externalUserId: userX }, kp.fullKey, clientIp);
  expect(second.status).toBe(200);
  expect(second.body.data).toMatchObject({ result: 'nothing_to_erase', counts: {} });

  const burst = newClientIp();
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) statuses.push((await privacyApi('erasures', { externalUserId: uniqueId('user-y') }, kp.fullKey, burst)).status);
  expect(statuses).toEqual([...Array(30).fill(200), 429]);
});

test('PPL-170 Server API export of an anonymous device by fingerprint', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { name: 'Backend exports', permissions: ['privacy'] });
  const anonFp = fingerprint('fp-anon-1');
  const anon = await identify(p, clientIp, { deviceFingerprint: anonFp, emailOptIn: true });
  expect((await trackEvent(p, clientIp, { eventName: 'anon_event', deviceFingerprint: anonFp })).status).toBe(201);
  const token = await seedPushToken(p.project.id, anon.id);
  const other = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-anon-2'), smsOptIn: true });
  expect((await trackEvent(p, clientIp, { eventName: 'other_event', deviceFingerprint: other.deviceFingerprint })).status).toBe(201);
  const otherToken = await seedPushToken(p.project.id, other.id, 'android');

  const exported = await privacyApi('exports', { deviceFingerprint: anonFp }, kp.fullKey, clientIp);
  expect(exported.status).toBe(200);
  const doc = exported.body.data;
  expect(doc.subject).toEqual({ type: 'deviceFingerprint', value: anonFp });
  expect(doc.sections.device_identities.rows.map((r: { id: string }) => r.id)).toEqual([anon.id]);
  expect(doc.sections.user_events.rows.map((r: { eventName: string }) => r.eventName)).toEqual(['anon_event']);
  expect(doc.sections.consent_events.rows).toEqual([expect.objectContaining({ channel: 'email', granted: true, source: 'sdk' })]);
  expect(doc.sections.push_tokens.rows).toEqual([expect.objectContaining({ deviceIdentityId: anon.id, tokenEnding: `…${token.slice(-6)}` })]);
  expect(doc.sections.tracking_objections.total).toBe(0);
  const text = JSON.stringify(doc);
  for (const value of [token, other.id, other.deviceFingerprint, 'other_event', otherToken.slice(-6)]) expect(text, value).not.toContain(value);

  const listed = await logList(p, clientIp);
  expect(listed.body.data[0]).toMatchObject({ kind: 'export', subjectType: 'deviceFingerprint', actorType: 'api_key', actorId: kp.id, result: 'exported' });
  expect(listed.body.data[0].counts).toEqual(sectionTotals(doc));
  const logged = await activityRows(p.project.id, 'person.exported');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ actor_kind: 'api_key', actor_label: 'API key "Backend exports"', target_type: 'person', target_id: anon.id });
});

test('PPL-171 A fingerprint that exists only in another project', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });
  const q = await peopleProject(clientIp, 'ppl-other', p.owner);
  const onlyQ = fingerprint('fp-only-q');
  const qDevice = await identify(q, clientIp, { deviceFingerprint: onlyQ, firstName: 'Quinn', emailOptIn: true });
  expect((await trackEvent(q, clientIp, { eventName: 'q_event', deviceFingerprint: onlyQ })).status).toBe(201);
  const qCounts = async () =>
    (
      await sql<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM device_identities WHERE project_id = $1) AS devices,
                (SELECT count(*)::int FROM user_events WHERE project_id = $1) AS events,
                (SELECT count(*)::int FROM consent_events WHERE project_id = $1) AS consent`,
        [q.project.id],
      )
    )[0];
  const before = await qCounts();
  expect(before).toEqual({ devices: 1, events: 1, consent: 1 });

  const erased = await privacyApi('erasures', { deviceFingerprint: onlyQ }, kp.fullKey, clientIp);
  expect(erased.status).toBe(200);
  expect(erased.body.data).toMatchObject({ result: 'nothing_to_erase', counts: {} });
  const exported = await privacyApi('exports', { deviceFingerprint: onlyQ }, kp.fullKey, clientIp);
  expect(exported.status).toBe(200);
  expectEmptySections(exported.body.data);

  expect((await privacyLogRows(p.project.id)).map((r) => r.result)).toEqual(['nothing_to_erase', 'nothing_found']);
  expect(await privacyLogRows(q.project.id)).toEqual([]);
  expect(await qCounts()).toEqual(before);
  expect(await deviceRow(qDevice.id)).toMatchObject({ first_name: 'Quinn' });
});

test('PPL-162 Erasure and identify racing do not resurrect the row', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const kp = await createKey(p.owner, p.project.id, clientIp, { permissions: ['privacy'] });

  for (let round = 0; round < 5; round++) {
    const userR = uniqueId('user-r');
    const fp = fingerprint('fp-r');
    const seeded = await identify(p, clientIp, {
      deviceFingerprint: fp,
      externalUserId: userR,
      email: `${uniqueId('r')}@example.com`,
      firstName: 'Rhea',
      traits: { plan: 'gold' },
    });
    expect((await raw('POST', '/api/identity/revenue', { projectId: p.project.id, deviceFingerprint: fp, amount: 12 }, { ip: clientIp, apiKey: p.sdkKey })).status).toBe(201);

    const [erased, identified] = await Promise.all([
      privacyApi('erasures', { externalUserId: userR }, kp.fullKey, clientIp),
      raw('POST', '/api/identity/identify', { projectId: p.project.id, platform: 'web', deviceFingerprint: fp, traits: { fresh: 'yes' } }, { ip: clientIp, apiKey: p.sdkKey }),
    ]);
    expect(erased.status, `round ${round}`).toBe(200);
    expect(identified.status, `round ${round}`).toBe(201);
    expect(erased.body.data.result).toBe('erased');

    expect(await deviceRow(seeded.id)).toBeUndefined();
    const after = await deviceByFingerprint(p.project.id, fp);
    if (after) {
      // The identify ran after the erasure: a new row made from its own request only.
      expect(after).toMatchObject({ external_user_id: null, email: null, first_name: null, traits: { fresh: 'yes' }, total_sessions: 1 });
      expect(Number(after.total_revenue)).toBe(0);
    }
  }
});

test('PPL-163 A suppression arriving after erasure is stored hashed', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const project = p.project.id;
  const asha = await seedAsha(p, clientIp);
  const shared = `${uniqueId('shared')}@example.com`;
  // Bob holds an address Asha also held.
  await identify(p, clientIp, { deviceFingerprint: asha.ios.deviceFingerprint, email: shared });
  const bob = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-bob'), email: shared });
  const never = `${uniqueId('never')}@example.com`;
  expect((await eraseAs(p, asha.ios.id, clientIp)).body.data.result).toBe('erased');
  const erasedAddresses = (await sql<{ channel: string }>(`SELECT channel FROM erased_addresses WHERE project_id = $1 AND channel = 'email'`, [project])).length;
  expect(erasedAddresses).toBeGreaterThanOrEqual(2);

  expect(await oneClickUnsubscribe(signUnsubscribeLink(project, asha.email), clientIp)).toBe(200);
  expect(await sql(`SELECT id FROM channel_suppressions WHERE project_id = $1 AND address = $2`, [project, asha.email])).toEqual([]);
  expect(await sql(`SELECT channel, reason FROM erased_suppressions WHERE project_id = $1`, [project])).toEqual([{ channel: 'email', reason: 'unsubscribed' }]);

  // Controls: an address never erased, and an erased one that another device still holds, stay clear.
  for (const address of [never, shared]) {
    expect(await oneClickUnsubscribe(signUnsubscribeLink(project, address), clientIp)).toBe(200);
    expect(await sql(`SELECT reason FROM channel_suppressions WHERE project_id = $1 AND address = $2`, [project, address]), address).toEqual([{ reason: 'unsubscribed' }]);
  }
  expect(await sql(`SELECT id FROM erased_suppressions WHERE project_id = $1`, [project])).toHaveLength(1);
  expect(await deviceRow(bob.id)).toMatchObject({ email: shared });

  const again = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-asha-again'), email: asha.email });
  expect(await deviceRow(again.id)).toMatchObject({ email: asha.email });
  expect(await sql(`SELECT channel, reason, source FROM channel_suppressions WHERE project_id = $1 AND address = $2`, [project, asha.email])).toEqual([
    { channel: 'email', reason: 'unsubscribed', source: 'erasure' },
  ]);
  expect(await sql(`SELECT id FROM erased_suppressions WHERE project_id = $1`, [project])).toEqual([]);
});

// ---- Profile with odd traits

test('PPL-164 List shows a number, boolean or object name trait as text', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-n1'), traits: { $name: 123 } });
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-n2'), traits: { $name: true } });
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-n3'), traits: { name: { a: 1 } } });
  const zeroFp = fingerprint('fp-n4');
  const zero = await identify(p, clientIp, { deviceFingerprint: zeroFp, traits: { $name: 0 } });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users`);
  for (const [name, initial] of [
    ['123', '1'],
    ['true', 'T'],
    ['{"a": 1}', '{'],
  ]) {
    const cell = page.locator('[data-slot="table-row"] [data-slot="table-cell"]:first-child').filter({ has: page.getByText(name, { exact: true }) });
    await expect(cell, name).toHaveCount(1);
    await expect(cell.locator('p.font-medium')).toHaveText(name);
    await expect(cell.locator('div.rounded-full')).toHaveText(initial);
  }

  // A falsy name falls back to the device's id and the profile renders.
  await openProfile(page, p, zero.id);
  await expect(page.locator('h1')).toHaveText(zeroFp);
  await expect(page.getByText(ERROR_SCREEN)).toHaveCount(0);
});

test('PPL-164 Profile renders a number, boolean or object name trait as text', { annotation: { type: 'issue', description: 'PPL-164' } }, async ({ page, clientIp }) => {
  test.fail();
  const p = await peopleProject(clientIp);
  const people = [
    await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-n1'), traits: { $name: 123 } }),
    await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-n2'), traits: { $name: true } }),
    await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-n3'), traits: { name: { a: 1 } } }),
  ];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await signIn(page, p.owner);
  for (const person of people) {
    await page.goto(profilePath(p, person.id));
    await expect(page.getByRole('heading', { name: 'User Profile' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(ERROR_SCREEN)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('PPL-165 Profile with a non-string email trait', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const base = { traits: { $name: 'Ok Name' } };
  const number = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-e1'), traits: { ...base.traits, $email: 123 } });
  const boolean = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-e2'), traits: { ...base.traits, $email: true } });
  const array = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-e3'), traits: { ...base.traits, $email: ['x', 'y'] } });
  const object = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-e4'), traits: { ...base.traits, $email: { a: 1 } } });
  for (const person of [number, boolean, array, object]) expect((await deviceRow(person.id))!.email).toBeNull();

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users`);
  const emails = page.locator('[data-slot="table-row"] [data-slot="table-cell"]:first-child p.text-xs');
  await expect(emails).toHaveCount(4);
  expect((await emails.allTextContents()).sort()).toEqual(['123', 'true', '["x", "y"]', '{"a": 1}'].sort());

  // As the case records: the heading shows the trait raw, and nothing at all for true.
  for (const [person, heading, card] of [
    [number, '123', '123'],
    [boolean, '', 'true'],
    [array, 'xy', 'x,y'],
  ] as const) {
    await openProfile(page, p, person.id);
    await expect(page.locator('h1')).toHaveText(heading);
    await expect(profileSection(page, 'Profile Properties')).toBeVisible();
    expect(await profileProperties(page)).toContainEqual(['Email', card]);
  }
});

test('PPL-165 Profile renders an object email trait', { annotation: { type: 'issue', description: 'PPL-165' } }, async ({ page, clientIp }) => {
  test.fail();
  const p = await peopleProject(clientIp);
  const object = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-e4'), traits: { $name: 'Ok Name', $email: { a: 1 } } });

  await signIn(page, p.owner);
  await page.goto(profilePath(p, object.id));
  await expect(page.getByRole('heading', { name: 'User Profile' })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(ERROR_SCREEN)).toHaveCount(0);
});

// ---- A second owner

test('PPL-168 A second owner who is not the billing owner exports and erases', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const owner2 = await addTeammate(p.owner, p.project.id, 'owner', clientIp);
  const raviId = uniqueId('user-ravi');
  const ravi = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-ravi'), platform: 'android', externalUserId: raviId, firstName: 'Ravi' });
  expect((await trackEvent(p, clientIp, { eventName: 'ravi_event', deviceFingerprint: ravi.deviceFingerprint })).status).toBe(201);
  expect(await sql(`SELECT owner_id FROM projects WHERE id = $1`, [p.project.id])).toEqual([{ owner_id: p.owner.userId }]);

  await signIn(page, owner2);
  await openProfile(page, p, ravi.id);
  await expect(page.getByRole('button', { name: 'Export data' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete person' })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export data' }).click();
  const file = await readDownload(await downloaded);
  expect(file.filename).toBe(`person-${ravi.id}-export.json`);
  expect(JSON.parse(file.text).sections.user_events.rows.map((r: { eventName: string }) => r.eventName)).toEqual(['ravi_event']);
  await expect(toast(page, 'Export downloaded')).toHaveText('Export downloaded');

  const dialog = await confirmDelete(page, raviId);
  const [response] = await Promise.all([page.waitForResponse(isDeleteOf(p, ravi.id)), dialog.getByRole('button', { name: 'Delete person' }).click()]);
  expect(response.status()).toBe(200);
  await expect(toast(page, 'Person deleted')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users$`));
  expect(await deviceRow(ravi.id)).toBeUndefined();

  const listed = await logList(p, clientIp);
  expect(listed.body.data.map((e: Record<string, string>) => [e.kind, e.actorType, e.actorId])).toEqual([
    ['erasure', 'user', owner2.userId],
    ['export', 'user', owner2.userId],
  ]);
  for (const action of ['person.exported', 'person.erased']) {
    const logged = await activityRows(p.project.id, action);
    expect(logged, action).toHaveLength(1);
    expect(logged[0], action).toMatchObject({ actor_user_id: owner2.userId, target_id: ravi.id });
  }
});

test('PPL-169 A second owner uses the privacy log and person objections', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const owner2 = await addTeammate(p.owner, p.project.id, 'owner', clientIp);
  const asha = await seedAsha(p, clientIp);
  const auth = { ip: clientIp, token: owner2.accessToken };

  const listed = await logList(p, clientIp, owner2.accessToken);
  expect(listed.status).toBe(200);
  expect(listed.body.data).toEqual([]);
  const searched = await logSearch(p, { externalUserId: uniqueId('user-ravi') }, clientIp, owner2.accessToken);
  expect(searched.status).toBe(200);
  expect(searched.body.data).toEqual([]);

  const preview = await raw('GET', previewPath(p, asha.externalUserId), undefined, auth);
  expect(preview.status).toBe(200);
  expect(preview.body.data).toMatchObject({ deviceCount: 2, objecting: false });
  const created = await raw('POST', objectionsPath(p), { externalUserId: asha.externalUserId }, auth);
  expect(created.status).toBe(201);
  expect(created.body.data).toMatchObject({ objecting: true, createdBy: owner2.userId });
  const lifted = await raw('POST', objectionsPath(p, '/lift'), { externalUserId: asha.externalUserId }, auth);
  expect(lifted.status).toBe(200);
  expect(lifted.body.data).toMatchObject({ objecting: false, createdAt: null });
  for (const action of ['tracking.objection_recorded', 'tracking.objection_lifted']) {
    const logged = await activityRows(p.project.id, action);
    expect(logged, action).toHaveLength(1);
    expect(logged[0].actor_user_id, action).toBe(owner2.userId);
  }

  expect((await raw('POST', objectionsPath(p), { externalUserId: asha.externalUserId }, auth)).status).toBe(201);
  const stale = await staleAccessToken(owner2, clientIp);
  const refused = await raw('POST', objectionsPath(p, '/lift'), { externalUserId: asha.externalUserId }, { ip: clientIp, token: stale });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(REAUTH_REQUIRED);
  expect(await objectionRows(p.project.id)).toEqual([expect.objectContaining({ external_user_id: asha.externalUserId, created_by: owner2.userId })]);
});

// ---- Identify

test('PPL-172 Two first identifies for the same new fingerprint at once', { annotation: { type: 'issue', description: 'PPL-172' } }, async ({ clientIp }) => {
  test.fail();
  const p = await peopleProject(clientIp);
  const statuses: number[] = [];
  for (let round = 0; round < 10; round++) {
    const fp = fingerprint('fp-race');
    const body = { projectId: p.project.id, deviceFingerprint: fp, platform: 'web' };
    const answers = await Promise.all([0, 1].map(() => raw('POST', '/api/identity/identify', body, { ip: clientIp, apiKey: p.sdkKey })));
    statuses.push(...answers.map((a) => a.status));
    expect(await sql(`SELECT id FROM device_identities WHERE project_id = $1 AND device_fingerprint = $2`, [p.project.id, fp])).toHaveLength(1);
  }
  expect(statuses).toEqual(Array(20).fill(201));
});

test('PPL-173 Identify changing the email address resets double opt-in', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-doi');
  const first = `${uniqueId('a')}@example.com`;
  const person = await identify(p, clientIp, { deviceFingerprint: fp, email: first });
  await sql(
    `UPDATE device_identities SET email_confirmed_at = now() - interval '1 day', email_confirm_sent_at = now() - interval '2 days' WHERE id = $1`,
    [person.id],
  );
  const confirmed = await deviceRow(person.id);
  const kept = { email: first, email_confirmed_at: confirmed!.email_confirmed_at, email_confirm_sent_at: confirmed!.email_confirm_sent_at };

  await identify(p, clientIp, { deviceFingerprint: fp, email: `${first.toUpperCase()} ` });
  expect(await deviceRow(person.id)).toMatchObject(kept);

  await identify(p, clientIp, { deviceFingerprint: fp, traits: { email: 'not-an-address' } });
  expect(await deviceRow(person.id)).toMatchObject(kept);

  const second = `${uniqueId('b')}@example.com`;
  await identify(p, clientIp, { deviceFingerprint: fp, email: second });
  expect(await deviceRow(person.id)).toMatchObject({ email: second, email_confirmed_at: null, email_confirm_sent_at: null });

  await sql(`UPDATE device_identities SET email_confirmed_at = now(), email_confirm_sent_at = now() WHERE id = $1`, [person.id]);
  const before = await deviceRow(person.id);
  const edited = await raw('PATCH', `/api/projects/${p.project.id}/users/${person.id}/traits`, { $email: `${uniqueId('c')}@example.com` }, { ip: clientIp, token: p.owner.accessToken });
  expect(edited.status).toBe(200);
  expect(await deviceRow(person.id)).toMatchObject({
    email: second,
    email_confirmed_at: before!.email_confirmed_at,
    email_confirm_sent_at: before!.email_confirm_sent_at,
  });
});

test('PPL-174 Dashboard lifts a do-not-track the SDK set', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-sdkdnt');
  const person = await identify(p, clientIp, { deviceFingerprint: fp, doNotTrack: true });
  expect(await deviceRow(person.id)).toMatchObject({ do_not_track: true, do_not_track_source: 'sdk' });

  await signIn(page, p.owner);
  await openProfile(page, p, person.id);
  await expect(page.getByText('Do Not Track', { exact: true })).toBeVisible();

  const lifted = await raw('PATCH', consentPath(p, person.id), { doNotTrack: false }, { ip: clientIp, token: p.owner.accessToken });
  expect(lifted.status).toBe(200);
  expect(lifted.body.data).toMatchObject({ doNotTrack: false, doNotTrackSource: 'dashboard' });
  expect((await consentEvents(person.id)).filter((e) => e.channel === 'tracking')).toEqual([
    { channel: 'tracking', granted: false, source: 'sdk' },
    { channel: 'tracking', granted: true, source: 'dashboard' },
  ]);
  const logged = await activityRows(p.project.id, 'person.consent_changed');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ target_id: person.id, details: { consents: { doNotTrack: false } } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Profile Properties' })).toBeVisible();
  await expect(page.getByText('Platform', { exact: true })).toBeVisible();
  await expect(page.getByText('Do Not Track', { exact: true })).toHaveCount(0);

  const sessionsBefore = (await deviceRow(person.id))!.total_sessions;
  await identify(p, clientIp, { deviceFingerprint: fp, doNotTrack: true });
  expect(await deviceRow(person.id)).toMatchObject({ do_not_track: true, do_not_track_source: 'sdk', total_sessions: sessionsBefore });
  expect((await consentEvents(person.id)).filter((e) => e.channel === 'tracking').at(-1)).toEqual({ channel: 'tracking', granted: false, source: 'sdk' });

  await identify(p, clientIp, { deviceFingerprint: fp, doNotTrack: false });
  const honoured = await deviceRow(person.id);
  expect(honoured).toMatchObject({ do_not_track: false, do_not_track_source: 'sdk' });
  expect((await consentEvents(person.id)).filter((e) => e.channel === 'tracking').at(-1)).toEqual({ channel: 'tracking', granted: true, source: 'sdk' });
  await identify(p, clientIp, { deviceFingerprint: fp });
  expect((await deviceRow(person.id))!.total_sessions).toBe(honoured!.total_sessions + 1);
});

test('PPL-175 The identify response returns the whole stored row', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const externalUserId = uniqueId('user-asha');
  const email = `${uniqueId('asha')}@example.com`;
  const fp = fingerprint('fp-asha-ios');
  const asha = await identify(p, clientIp, {
    deviceFingerprint: fp,
    platform: 'ios',
    externalUserId,
    distinctId: externalUserId,
    firstName: 'Asha',
    lastName: 'Rao',
    phone: '+919800000001',
    email,
    emailOptIn: true,
    smsOptIn: true,
    pushOptIn: true,
    traits: { $email: email, plan: 'pro' },
  });
  expect((await raw('POST', '/api/identity/revenue', { projectId: p.project.id, deviceFingerprint: fp, amount: 49.5, currency: 'INR' }, { ip: clientIp, apiKey: p.sdkKey })).status).toBe(201);
  await sql(`UPDATE device_identities SET email_confirmed_at = now() WHERE id = $1`, [asha.id]);
  const sessionsBefore = (await deviceRow(asha.id))!.total_sessions;

  // A call naming only the fingerprint, from another client address.
  const caller = newClientIp();
  const answer = await raw('POST', '/api/identity/identify', { projectId: p.project.id, deviceFingerprint: fp, platform: 'ios' }, { ip: caller, apiKey: p.sdkKey });
  expect(answer.status).toBe(201);
  // Asserts the current response shape, as the case is written.
  const data = answer.body.data;
  expect(data).toMatchObject({
    id: asha.id,
    externalUserId,
    email,
    phone: '+919800000001',
    phoneE164: '+919800000001',
    firstName: 'Asha',
    lastName: 'Rao',
    traits: { $email: email, plan: 'pro' },
    currency: 'INR',
    emailOptIn: true,
    smsOptIn: true,
    pushOptIn: true,
    ipAddress: caller,
    country: 'India',
  });
  expect(Number(data.totalRevenue)).toBe(49.5);
  for (const field of ['whatsappOptIn', 'gdprConsent', 'doNotTrack', 'emailConfirmedAt', 'city']) expect(data).toHaveProperty(field);
  expect(data.emailConfirmedAt).not.toBeNull();
  expect(await deviceRow(asha.id)).toMatchObject({ ip_address: caller, total_sessions: sessionsBefore + 1 });
});

// ---- What the profile shows against what an erasure removes

test('PPL-185 Same external id, different distinct ids: no Linked Devices, yet Delete erases both', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const userZ = uniqueId('user-z');
  const z1 = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-z1'), externalUserId: userZ, distinctId: uniqueId('z-a'), platform: 'ios' });
  const z2 = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-z2'), externalUserId: userZ, distinctId: uniqueId('z-b'), platform: 'android' });
  const now = local(new Date());
  for (const [device, title] of [
    [z1, 'Z one campaign'],
    [z2, 'Z two campaign'],
  ] as const) {
    const campaign = await insertCampaign(p.project.id, title, now);
    await insertCampaignEvent(p.project.id, campaign, device.id, 'delivered', now);
  }

  await signIn(page, p.owner);
  await openProfile(page, p, z1.id);
  const push = profileSection(page, 'Push Notifications');
  await expect(push.getByText('Z one campaign')).toBeVisible();
  await expect(push.getByText('Z two campaign')).toHaveCount(0);
  await expect(page.getByText('Devices', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Linked Devices' })).toHaveCount(0);
  await expect(page.getByText(/^Merged across/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Delete person' }).click();
  const dialog = deleteDialog(page);
  await expect(dialog.locator('p').filter({ hasText: /^This deletes this device/ })).toHaveText(`This deletes this device and every device signed in as ${userZ}.`);
  await dialog.getByLabel(`Type ${userZ} to confirm`).fill(userZ);
  const [response] = await Promise.all([page.waitForResponse(isDeleteOf(p, z1.id)), dialog.getByRole('button', { name: 'Delete person' }).click()]);
  expect(response.status()).toBe(200);
  expect((await response.json()).data.counts.device_identities).toBe(2);
  await expect(toast(page, 'Person deleted')).toBeVisible();
  expect(await sql(`SELECT id FROM device_identities WHERE project_id = $1 AND external_user_id = $2`, [p.project.id, userZ])).toEqual([]);
  expect(await rowsNamingDevices('push_notification_events', [z1.id, z2.id])).toBe(0);
});

test('PPL-186 Another person\'s device sharing the distinct id looks linked but is not erased', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const userY = uniqueId('user-y');
  const shared = uniqueId('shared-y');
  const y1 = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-y1'), externalUserId: userY, distinctId: shared, platform: 'ios' });
  const stranger = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-stranger'), distinctId: shared, platform: 'android', firstName: 'Stan' });
  const now = local(new Date());
  for (const [device, title] of [
    [y1, 'Y own campaign'],
    [stranger, 'Stranger campaign'],
  ] as const) {
    const campaign = await insertCampaign(p.project.id, title, now);
    await insertCampaignEvent(p.project.id, campaign, device.id, 'delivered', now);
  }

  await signIn(page, p.owner);
  await openProfile(page, p, y1.id);
  await expect(page.getByText('Devices', { exact: true }).locator('..')).toContainText('2 linked devices');
  const linked = page.getByRole('heading', { name: 'Linked Devices' }).locator('..');
  await expect(linked).toContainText('android');
  await expect(linked).toContainText('ios');
  const push = profileSection(page, 'Push Notifications');
  await expect(push.getByText("Merged across 2 of this person's devices.")).toBeVisible();
  await expect(push.getByText('Y own campaign')).toBeVisible();
  await expect(push.getByText('Stranger campaign')).toBeVisible();

  const dialog = await confirmDelete(page, userY);
  await expect(dialog.getByText('Other devices shown on this page that are not signed in as this user', { exact: false })).toBeVisible();
  const [response] = await Promise.all([page.waitForResponse(isDeleteOf(p, y1.id)), dialog.getByRole('button', { name: 'Delete person' }).click()]);
  expect(response.status()).toBe(200);
  expect((await response.json()).data.counts.device_identities).toBe(1);
  await expect(toast(page, 'Person deleted')).toBeVisible();

  expect(await deviceRow(y1.id)).toBeUndefined();
  expect(await deviceRow(stranger.id)).toMatchObject({ distinct_id: shared, first_name: 'Stan', external_user_id: null });
  expect(await rowsNamingDevices('push_notification_events', [stranger.id])).toBe(1);
});

// ---- Signed out

test('PPL-193 Signed-out deep link to the people pages', async ({ browser, baseURL, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);

  for (const path of [profilePath(p, asha.ios.id), `/projects/${p.project.id}/users`]) {
    const { context } = await newPersonContext(browser, baseURL);
    try {
      const page = await context.newPage();
      const peopleRequests: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith(`/api/projects/${p.project.id}/users`)) peopleRequests.push(url.pathname);
      });
      await page.goto(path);
      // As the case records: the destination is not kept.
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible();
      expect(peopleRequests, path).toEqual([]);

      await page.getByLabel('Email').fill(p.owner.email);
      await page.getByLabel('Password', { exact: true }).fill(p.owner.password);
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
      await expect(page).toHaveURL(/\/projects$/);
      expect(peopleRequests, path).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

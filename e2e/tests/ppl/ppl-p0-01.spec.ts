import { randomBytes } from 'crypto';
import { api, createAccount, createProject } from '../../support/api';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  addTeammate,
  consentEvents,
  deviceByFingerprint,
  deviceRow,
  fingerprint,
  identify,
  messageOf,
  objectionRows,
  openViewAs,
  peopleProject,
  raw,
  sql,
  staleAccessToken,
  trackEvent,
  userHash,
  viewAsHandoff,
  viewAsToken,
  type PeopleProject,
} from '../../support/areas/ppl';

/**
 * People list and profile, trait edit, SDK identify, link-device, consent edit and
 * tracking objections. People arrive through the SDK's identify route with a project
 * key; external ids carry the userHash the tenant's server would make with the
 * project's identity secret. Rows are read back with SQL where the effect is
 * server-side.
 */

const READ_ONLY = 'Impersonation sessions are read-only';
const PROJECT_NOT_FOUND = 'Project not found';
const ROLE_REFUSAL = 'Your role in this project does not allow this.';
const USER_HASH_REQUIRED =
  'externalUserId needs a userHash: HMAC-SHA256 of the id under the project identity secret, made on your server.';

function uniqueId(label: string): string {
  return `${label}-${randomBytes(4).toString('hex')}`;
}

/** Asha: one person on an iOS and a web device, sharing a distinct id and an external id. */
async function seedAsha(p: PeopleProject, ip: string, externalUserId = uniqueId('user-asha')) {
  const common = {
    distinctId: externalUserId,
    externalUserId,
    firstName: 'Asha',
    lastName: 'Rao',
    phone: '+919800000001',
    traits: { $name: 'Asha Rao', $email: 'asha@example.com', plan: 'pro' },
  };
  const ios = await identify(p, ip, { ...common, deviceFingerprint: fingerprint('fp-asha-ios'), platform: 'ios' });
  const web = await identify(p, ip, { ...common, deviceFingerprint: fingerprint('fp-asha-web'), platform: 'web' });
  return { externalUserId, ios, web };
}

async function objectFor(p: PeopleProject, ip: string, externalUserId: string, sourceIdentityId?: string) {
  return raw(
    'POST',
    `/api/identity/projects/${p.project.id}/tracking-objections`,
    { externalUserId, ...(sourceIdentityId ? { sourceIdentityId } : {}) },
    { token: p.owner.accessToken, ip },
  );
}

/** Fails the test if any dialog opens (an injected alert running). */
function failOnDialog(page: import('@playwright/test').Page): string[] {
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  return dialogs;
}

// ---- People list

test('PPL-023 SDK-set avatar URL is never loaded', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, {
    deviceFingerprint: fingerprint('fp-avatar'),
    firstName: 'Avi',
    lastName: 'Kumar',
    avatar: 'https://attacker.example/pixel.png',
  });

  const hosts: string[] = [];
  page.on('request', (request) => hosts.push(new URL(request.url()).hostname));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users`);
  const row = page.getByRole('row').filter({ hasText: 'Avi Kumar' });
  await expect(row).toBeVisible();
  // The initial letter, not an image.
  await expect(row.getByText('A', { exact: true })).toBeVisible();
  await expect(row.locator('img')).toHaveCount(0);

  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users/${person.id}$`));
  await expect(page.getByRole('heading', { name: 'User Profile' })).toBeVisible();
  await expect(page.locator('img[src*="attacker.example"]')).toHaveCount(0);
  await page.waitForLoadState('networkidle');

  expect(hosts).not.toContain('attacker.example');
});

test('PPL-024 HTML in SDK-set values renders as text in the list', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  await identify(p, clientIp, {
    deviceFingerprint: fingerprint('fp-html'),
    traits: { $name: '<img src=x onerror=alert(1)>', $email: '<b>x</b>@e.com' },
    os: '<script>alert(2)</script>',
    utmSource: '<i>src</i>',
  });
  const dialogs = failOnDialog(page);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users`);
  const row = page.getByRole('row').filter({ hasText: '<img src=x onerror=alert(1)>' });
  await expect(row).toBeVisible();
  await expect(row.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(row.getByText('<b>x</b>@e.com', { exact: true })).toBeVisible();
  await expect(row.getByText('<script>alert(2)</script>', { exact: true })).toBeVisible();
  await expect(row.getByText('<i>src</i>', { exact: true })).toBeVisible();
  await expect(row.locator('img, b, script, i')).toHaveCount(0);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('PPL-027 People list API: auth and tenant isolation', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-p') });
  const outsider = await createAccount(clientIp, 'ppl-outsider', 'Olu Outsider');
  await createProject(outsider, clientIp);

  const anonymous = await raw('GET', `/api/projects/${p.project.id}/users`, undefined, { ip: clientIp });
  expect(anonymous.status).toBe(401);

  for (const path of [`/api/projects/${p.project.id}/users`, `/api/projects/${p.project.id}/users/stats`]) {
    const refused = await raw('GET', path, undefined, { ip: clientIp, token: outsider.accessToken });
    expect(refused.status).toBe(404);
    expect(refused.body.message).toBe(PROJECT_NOT_FOUND);
    expect(JSON.stringify(refused.body)).not.toContain('fp-p-');
  }

  const malformed = await raw('GET', '/api/projects/not-a-uuid/users', undefined, { ip: clientIp, token: p.owner.accessToken });
  expect(malformed.status).toBe(404);
  expect(malformed.body.message).toBe(PROJECT_NOT_FOUND);
});

// ---- Person profile

test('PPL-032 Profile loads from the list', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users`);
  const iosRow = page.getByRole('row').filter({ hasText: 'Asha Rao' }).filter({ hasText: 'ios' });
  await expect(iosRow).toHaveCount(1);

  const [detail, history] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}/users/${asha.ios.id}`) && r.request().method() === 'GET'),
    page.waitForResponse((r) => r.url().endsWith(`/api/push-notifications/history/${p.project.id}/${asha.ios.id}`)),
    iosRow.getByRole('link', { name: /Asha Rao/ }).click(),
  ]);
  expect(detail.status()).toBe(200);
  expect(history.status()).toBe(200);

  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/users/${asha.ios.id}$`));
  await expect(page.getByRole('link', { name: 'Users', exact: true }).first()).toBeVisible();
  // The email trait wins over the name.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('asha@example.com');
  await expect(page.getByText('User profile and event timeline')).toBeVisible();
  await expect(page.getByText('1 sessions', { exact: true })).toBeVisible();
  await expect(page.getByText('Last 30 days', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export data' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete person' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'User Profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Push Notifications', exact: true })).toBeVisible();
});

test('PPL-038 Person of another project is not readable', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const q = await peopleProject(clientIp, 'ppl-outsider');
  const qPerson = await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q1'), firstName: 'Quentin' });
  await trackEvent(q, clientIp, { eventName: 'q_only_event', deviceFingerprint: qPerson.deviceFingerprint });
  const auth = { ip: clientIp, token: p.owner.accessToken };

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${qPerson.id}`);
  await expect(page.getByText('Person not found', { exact: true })).toBeVisible();
  await expect(page.getByText('Quentin')).toHaveCount(0);

  const detail = await raw('GET', `/api/projects/${p.project.id}/users/${qPerson.id}`, undefined, auth);
  expect(detail.status).toBe(404);
  expect(detail.body.message).toBe('Person not found');

  const history = await raw('GET', `/api/push-notifications/history/${p.project.id}/${qPerson.id}`, undefined, auth);
  expect(history.status).toBe(404);
  expect(history.body.message).toBe('Person not found for this project');

  const events = await raw('GET', `/api/projects/${p.project.id}/users/${qPerson.id}/events`, undefined, auth);
  expect(events.status).toBe(200);
  expect(events.body.data).toEqual({ data: [], total: 0 });
});

test('PPL-055 HTML in traits, event names and properties renders as text', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-xss');
  const person = await identify(p, clientIp, {
    deviceFingerprint: fp,
    firstName: '<svg onload=alert(2)>',
    traits: { '<b>k</b>': '<img src=x onerror=alert(1)>' },
  });
  const tracked = await trackEvent(p, clientIp, {
    deviceFingerprint: fp,
    eventName: '<script>alert(3)</script>',
    properties: { '<i>p</i>': '<a href=javascript:alert(4)>x</a>' },
  });
  expect(tracked.status).toBe(201);
  const dialogs = failOnDialog(page);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${person.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('<svg onload=alert(2)>');
  await expect(page.getByText('<b>k</b>', { exact: true })).toBeVisible();
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.getByText('<svg onload=alert(2)>', { exact: true }).first()).toBeVisible();

  const eventButton = page.getByRole('button', { name: /<script>alert\(3\)<\/script>/ });
  await eventButton.click();
  await expect(page.getByRole('tab', { name: /All Event Properties/ })).toBeVisible();
  await expect(page.getByText('<i>p</i>', { exact: true })).toBeVisible();
  await expect(page.getByText('<a href=javascript:alert(4)>x</a>', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^Event Properties/ }).click();
  await expect(page.getByText('<a href=javascript:alert(4)>x</a>', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /System Properties/ }).click();
  const system = page.getByRole('tabpanel', { name: /System Properties/ });
  await expect(system).toContainText('Source Type');
  await expect(system).not.toContainText('<i>p</i>');

  await expect(page.locator('main img, aside img, main svg[onload], main b, main i, main script')).toHaveCount(0);
  await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('PPL-063 Profile in view-as hides privacy actions', async ({ page, browser, baseURL, clientIp }) => {
  test.slow(); // The super admin grant runs the CLI through ts-node.
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);

  await openViewAs(page, handoff);
  const [detail, history] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}/users/${asha.ios.id}`)),
    page.waitForResponse((r) => r.url().endsWith(`/api/push-notifications/history/${p.project.id}/${asha.ios.id}`)),
    page.goto(`/projects/${p.project.id}/users/${asha.ios.id}`),
  ]);
  expect(detail.status()).toBe(200);
  expect(history.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('asha@example.com');
  await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
  await expect(page.getByText('No campaigns have reached this person yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export data' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete person' })).toHaveCount(0);
});

// ---- Trait edit

test('PPL-068 Trait edit refused in view-as and to outsiders', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-traits'), traits: { plan: 'free' } });
  const outsider = await createAccount(clientIp, 'ppl-outsider', 'Olu Outsider');
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);
  const path = `/api/projects/${p.project.id}/users/${person.id}/traits`;

  const asStaff = await raw('PATCH', path, { plan: 'hacked' }, { ip: clientIp, token: viewAs });
  expect(asStaff.status).toBe(403);
  expect(asStaff.body.message).toBe(READ_ONLY);

  const asOutsider = await raw('PATCH', path, { plan: 'hacked' }, { ip: clientIp, token: outsider.accessToken });
  expect(asOutsider.status).toBe(404);
  expect(asOutsider.body.message).toBe(PROJECT_NOT_FOUND);

  expect((await deviceRow(person.id))?.traits).toEqual({ plan: 'free' });
});

// ---- SDK identify

test('PPL-071 Anonymous identify creates a device row', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-new');
  const created = await raw(
    'POST',
    '/api/identity/identify',
    { projectId: p.project.id, deviceFingerprint: fp, platform: 'web', traits: { plan: 'free' }, utmSource: 'google', referrer: 'https://news.example.com/a' },
    { ip: clientIp, apiKey: p.sdkKey },
  );
  expect(created.status).toBe(201);
  expect(created.body.data).toMatchObject({ deviceFingerprint: fp, projectId: p.project.id });

  const row = await deviceByFingerprint(p.project.id, fp);
  expect(row).toMatchObject({
    id: created.body.data.id,
    total_sessions: 1,
    initial_utm_source: 'google',
    latest_utm_source: 'google',
    initial_referring_domain: 'news.example.com',
    country: 'India',
    city: 'Mumbai',
    ip_address: clientIp,
    external_user_id: null,
    traits: { plan: 'free' },
  });

  const list = await api<Array<{ id: string }>>('GET', `/api/projects/${p.project.id}/users?search=${fp}`, undefined, {
    token: p.owner.accessToken,
    ip: clientIp,
  });
  expect(list.map((person) => person.id)).toEqual([row!.id]);
});

test('PPL-073 Identify API key failures', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const expired = await api<{ fullKey: string }>(
    'POST',
    `/api/projects/${p.project.id}/api-keys`,
    { name: 'Expired', expiresAt: new Date(Date.now() - 60_000).toISOString() },
    { token: p.owner.accessToken, ip: clientIp },
  );
  const revoked = await api<{ fullKey: string; apiKey: { id: string } }>(
    'POST',
    `/api/projects/${p.project.id}/api-keys`,
    { name: 'Revoked' },
    { token: p.owner.accessToken, ip: clientIp },
  );
  await api('DELETE', `/api/projects/${p.project.id}/api-keys/${revoked.apiKey.id}`, undefined, { token: p.owner.accessToken, ip: clientIp });
  const privacy = await api<{ fullKey: string }>(
    'POST',
    `/api/projects/${p.project.id}/api-keys`,
    { name: 'Privacy', permissions: ['privacy'] },
    { token: p.owner.accessToken, ip: clientIp },
  );

  const fp = fingerprint('fp-keys');
  const body = { projectId: p.project.id, deviceFingerprint: fp, platform: 'web' };
  const cases: Array<{ key?: string; status: number; message: string }> = [
    { key: undefined, status: 401, message: 'API key is required' },
    { key: `chq_${randomBytes(24).toString('hex')}`, status: 401, message: 'Invalid or expired API key' },
    { key: expired.fullKey, status: 401, message: 'Invalid or expired API key' },
    { key: revoked.fullKey, status: 401, message: 'Invalid or expired API key' },
    {
      key: privacy.fullKey,
      status: 403,
      message: 'This is a server-only privacy key and cannot be used by an app or SDK. Use an ordinary API key in your app.',
    },
  ];
  for (const { key, status, message } of cases) {
    const response = await raw('POST', '/api/identity/identify', body, { ip: clientIp, apiKey: key });
    expect(response.status, `key ${key?.slice(0, 8)}`).toBe(status);
    expect(response.body.message).toBe(message);
  }
  expect(await deviceByFingerprint(p.project.id, fp)).toBeUndefined();
});

test('PPL-074 Identify with another project\'s id', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const q = await peopleProject(clientIp, 'ppl-outsider');
  const fp = fingerprint('fp-mismatch');

  const pKeyForQ = await raw('POST', '/api/identity/identify', { projectId: q.project.id, deviceFingerprint: fp, platform: 'web' }, { ip: clientIp, apiKey: p.sdkKey });
  expect(pKeyForQ.status).toBe(403);
  expect(pKeyForQ.body.message).toBe('Project mismatch');

  const qKeyForP = await raw('POST', '/api/identity/identify', { projectId: p.project.id, deviceFingerprint: fp, platform: 'web' }, { ip: clientIp, apiKey: q.sdkKey });
  expect(qKeyForP.status).toBe(403);
  expect(qKeyForP.body.message).toBe('Project mismatch');

  expect(await sql(`SELECT id FROM device_identities WHERE device_fingerprint = $1`, [fp])).toEqual([]);
});

test('PPL-076 Identify refuses a caller-supplied IP and unknown fields', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-ip');
  const base = { projectId: p.project.id, deviceFingerprint: fp, platform: 'web' };

  const withIp = await raw('POST', '/api/identity/identify', { ...base, ipAddress: '8.8.8.8' }, { ip: clientIp, apiKey: p.sdkKey });
  expect(withIp.status).toBe(400);
  expect(messageOf(withIp)).toBe('property ipAddress should not exist');

  const withCountry = await raw('POST', '/api/identity/identify', { ...base, country: 'US' }, { ip: clientIp, apiKey: p.sdkKey });
  expect(withCountry.status).toBe(400);
  expect(messageOf(withCountry)).toBe('property country should not exist');

  expect(await deviceByFingerprint(p.project.id, fp)).toBeUndefined();
});

test('PPL-078 External id needs a valid userHash', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-hash');
  const externalUserId = uniqueId('user-new');
  const body = { projectId: p.project.id, deviceFingerprint: fp, platform: 'web', externalUserId };
  const send = (extra: Record<string, unknown>) => raw('POST', '/api/identity/identify', { ...body, ...extra }, { ip: clientIp, apiKey: p.sdkKey });

  for (const extra of [{}, { userHash: randomBytes(32).toString('hex') }, { userHash: userHash(p.secret, 'user-other') }]) {
    const refused = await send(extra);
    expect(refused.status).toBe(401);
    expect(refused.body.message).toBe(USER_HASH_REQUIRED);
    expect(await deviceByFingerprint(p.project.id, fp)).toBeUndefined();
  }

  const correct = userHash(p.secret, externalUserId);
  const upper = await send({ userHash: correct.toUpperCase() });
  expect(upper.status).toBe(201);
  expect(upper.body.data.externalUserId).toBe(externalUserId);

  const lower = await send({ userHash: correct });
  expect(lower.status).toBe(201);
  const row = await deviceByFingerprint(p.project.id, fp);
  expect(row?.external_user_id).toBe(externalUserId);
  const stored = JSON.stringify(row).toLowerCase();
  expect(stored).not.toContain(correct);
  expect(JSON.stringify(lower.body).toLowerCase()).not.toContain(correct);
});

test('PPL-081 Device handover to a different signed-in user', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-shared');
  const userA = uniqueId('user-a');
  const userB = uniqueId('user-b');
  const before = await identify(p, clientIp, {
    deviceFingerprint: fp,
    externalUserId: userA,
    email: 'a@e2e.example.test',
    phone: '+919800000002',
    firstName: 'A',
    lastName: 'Person',
    avatar: 'https://cdn.example.test/a.png',
    traits: { plan: 'pro' },
    emailOptIn: true,
    smsOptIn: true,
    pushOptIn: true,
  });
  await api('POST', '/api/identity/revenue', { projectId: p.project.id, deviceFingerprint: fp, amount: 10, currency: 'INR' }, { apiKey: p.sdkKey, ip: clientIp });
  await sql(`UPDATE device_identities SET email_confirmed_at = now(), email_confirm_sent_at = now() WHERE id = $1`, [before.id]);
  expect((await trackEvent(p, clientIp, { deviceFingerprint: fp, eventName: 'before_handover' })).status).toBe(201);
  const seeded = await deviceRow(before.id);
  expect(seeded).toMatchObject({ email: 'a@e2e.example.test', phone_e164: '+919800000002', email_opt_in: true, sms_opt_in: true });
  expect(Number(seeded!.total_revenue)).toBe(10);

  await identify(p, clientIp, { deviceFingerprint: fp, externalUserId: userB, firstName: 'B' });

  const row = await deviceRow(before.id);
  expect(row).toMatchObject({
    external_user_id: userB,
    first_name: 'B',
    email: null,
    email_confirmed_at: null,
    email_confirm_sent_at: null,
    phone: null,
    phone_e164: null,
    last_name: null,
    avatar: null,
    traits: null,
    currency: null,
    email_opt_in: null,
    sms_opt_in: null,
    whatsapp_opt_in: null,
    gdpr_consent: null,
    push_opt_in: true,
    do_not_track: false,
  });
  expect(Number(row!.total_revenue)).toBe(0);

  const handover = (await consentEvents(before.id)).filter((e) => e.source === 'device_handover');
  expect(handover.map((e) => [e.channel, e.granted]).sort()).toEqual([
    ['email', false],
    ['sms', false],
  ]);
  const events = await sql(`SELECT device_identity_id FROM user_events WHERE project_id = $1 AND event_name = 'before_handover'`, [p.project.id]);
  expect(events).toEqual([{ device_identity_id: before.id }]);
});

test('PPL-084 SDK do-not-track: nothing behavioural stored', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-dnt');
  const person = await identify(p, clientIp, {
    deviceFingerprint: fp,
    doNotTrack: true,
    utmSource: 'x',
    referrer: 'https://r.example',
    firstName: 'Dana',
    emailOptIn: true,
  });
  const first = await deviceRow(person.id);
  expect(first).toMatchObject({
    do_not_track: true,
    do_not_track_source: 'sdk',
    ip_address: null,
    country: null,
    city: null,
    initial_utm_source: null,
    latest_utm_source: null,
    initial_referrer: null,
    initial_referring_domain: null,
    latest_referrer: null,
    total_sessions: 0,
    first_name: 'Dana',
    email_opt_in: true,
  });

  await identify(p, clientIp, { deviceFingerprint: fp, doNotTrack: true, utmSource: 'y' });
  const second = await deviceRow(person.id);
  expect(second).toMatchObject({ total_sessions: 0, ip_address: null, latest_utm_source: null, initial_utm_source: null, country: null });
  expect(second!.last_seen_at.getTime()).toBe(first!.last_seen_at.getTime());

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/users/${person.id}`);
  const card = page.getByText('Do Not Track', { exact: true }).locator('..');
  await expect(card).toHaveText(/Do Not Track\s*true/);
});

test('PPL-086 SDK cannot lift a do-not-track set from the dashboard', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const fp = fingerprint('fp-x');
  const person = await identify(p, clientIp, { deviceFingerprint: fp });
  await api('PATCH', `/api/identity/projects/${p.project.id}/users/${person.id}/consent`, { doNotTrack: true }, { token: p.owner.accessToken, ip: clientIp });
  const before = await deviceRow(person.id);
  expect(before).toMatchObject({ do_not_track: true, do_not_track_source: 'dashboard', total_sessions: 1 });

  const answer = await raw('POST', '/api/identity/identify', { projectId: p.project.id, deviceFingerprint: fp, platform: 'web', doNotTrack: false }, { ip: clientIp, apiKey: p.sdkKey });
  expect(answer.status).toBe(201);

  expect(await deviceRow(person.id)).toMatchObject({ do_not_track: true, do_not_track_source: 'dashboard', total_sessions: 1 });
  expect((await consentEvents(person.id)).filter((e) => e.channel === 'tracking')).toEqual([
    { channel: 'tracking', granted: false, source: 'dashboard' },
  ]);
});

test('PPL-087 Person objection makes a new device of that user untracked', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  expect((await objectFor(p, clientIp, asha.externalUserId)).status).toBe(201);

  const fp = fingerprint('fp-asha-new');
  const created = await identify(p, clientIp, {
    deviceFingerprint: fp,
    externalUserId: asha.externalUserId,
    utmSource: 'google',
    referrer: 'https://news.example.com/a',
    doNotTrack: false,
    firstName: 'Asha',
  });
  expect(await deviceRow(created.id)).toMatchObject({
    ip_address: null,
    country: null,
    city: null,
    initial_utm_source: null,
    latest_utm_source: null,
    initial_referrer: null,
    latest_referrer: null,
    total_sessions: 0,
    first_name: 'Asha',
    external_user_id: asha.externalUserId,
  });
  // The doNotTrack:false is dropped: no tracking history for the new device at all.
  expect((await consentEvents(created.id)).filter((e) => e.channel === 'tracking')).toEqual([]);
});

test('PPL-089 Identify restores an erased address\'s suppression', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const q = await peopleProject(clientIp, 'ppl-other', p.owner);
  const address = `asha-${randomBytes(4).toString('hex')}@example.com`;
  const asha = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-asha'), email: address, firstName: 'Asha' });
  await sql(
    `INSERT INTO channel_suppressions (project_id, channel, address, reason, source) VALUES ($1, 'email', $2, 'unsubscribed', 'link')`,
    [p.project.id, address],
  );

  const erased = await raw('DELETE', `/api/projects/${p.project.id}/users/${asha.id}`, undefined, { ip: clientIp, token: p.owner.accessToken });
  expect(erased.status).toBe(200);
  expect(await sql(`SELECT id FROM channel_suppressions WHERE project_id = $1 AND address = $2`, [p.project.id, address])).toEqual([]);
  expect(await deviceRow(asha.id)).toBeUndefined();

  await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q'), email: address });
  await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-asha-again'), email: address });

  expect(await sql(`SELECT channel, reason, source FROM channel_suppressions WHERE project_id = $1 AND address = $2`, [p.project.id, address])).toEqual([
    { channel: 'email', reason: 'unsubscribed', source: 'erasure' },
  ]);
  expect(await sql(`SELECT id FROM channel_suppressions WHERE project_id = $1 AND address = $2`, [q.project.id, address])).toEqual([]);
});

test('PPL-098 Revenue dropped for do-not-track', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const dntFp = fingerprint('fp-dnt-rev');
  const dnt = await identify(p, clientIp, { deviceFingerprint: dntFp, doNotTrack: true });
  const asha = await seedAsha(p, clientIp);
  expect((await objectFor(p, clientIp, asha.externalUserId)).status).toBe(201);

  for (const [fp, id] of [
    [dntFp, dnt.id],
    [asha.ios.deviceFingerprint, asha.ios.id],
  ]) {
    const answer = await raw('POST', '/api/identity/revenue', { projectId: p.project.id, deviceFingerprint: fp, amount: 49.5, currency: 'INR' }, { ip: clientIp, apiKey: p.sdkKey });
    expect(answer.status).toBe(201);
    expect(answer.body.data).toEqual({ success: true });
    const row = await deviceRow(id);
    expect(Number(row!.total_revenue)).toBe(0);
    expect(row!.currency).toBeNull();
  }
});

// ---- Consent edit

test('PPL-099 Owner, admin and member can change consent', async ({ page, clientIp }) => {
  const p = await peopleProject(clientIp);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);

  for (const actor of [p.owner, admin, member]) {
    const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-consent'), emailOptIn: true });
    const before = await deviceRow(person.id);
    await sql(`UPDATE device_identities SET last_seen_at = now() - interval '2 days' WHERE id = $1`, [person.id]);
    const lastSeen = (await deviceRow(person.id))!.last_seen_at.getTime();

    const answer = await raw('PATCH', `/api/identity/projects/${p.project.id}/users/${person.id}/consent`, { emailOptIn: false }, { ip: clientIp, token: actor.accessToken });
    expect(answer.status, actor.email).toBe(200);
    expect(answer.body.data).toMatchObject({ id: person.id, emailOptIn: false });

    const row = await deviceRow(person.id);
    expect(row!.email_opt_in).toBe(false);
    expect(row!.consent_updated_at.getTime()).toBeGreaterThan(before!.consent_updated_at.getTime() - 1);
    expect(row!.last_seen_at.getTime()).toBe(lastSeen);
    expect((await consentEvents(person.id)).filter((e) => e.source === 'dashboard')).toEqual([
      { channel: 'email', granted: false, source: 'dashboard' },
    ]);

    const logged = (await activityRows(p.project.id, 'person.consent_changed')).filter((r) => r.target_id === person.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      actor_user_id: actor.userId,
      target_type: 'person',
      target_id: person.id,
      target_label: null,
      details: { consents: { emailOptIn: false } },
    });

    if (actor === p.owner) {
      await signIn(page, p.owner);
      await page.goto(`/projects/${p.project.id}/users/${person.id}`);
      await expect(page.getByRole('heading', { name: 'Profile Properties' })).toBeVisible();
      await expect(page.getByText('Platform', { exact: true })).toBeVisible();
      await expect(page.getByText('Email Opt-in', { exact: true })).toHaveCount(0);
    }
  }
});

test('PPL-102 Consent edit on unknown or other-project person', { annotation: { type: 'issue', description: 'PPL-102' } }, async ({ clientIp }) => {
  test.fail();
  const p = await peopleProject(clientIp);
  const q = await peopleProject(clientIp, 'ppl-outsider');
  const qPerson = await identify(q, clientIp, { deviceFingerprint: fingerprint('fp-q'), emailOptIn: true });
  const auth = { ip: clientIp, token: p.owner.accessToken };
  const patch = (personId: string) => raw('PATCH', `/api/identity/projects/${p.project.id}/users/${personId}/consent`, { emailOptIn: false }, auth);

  const unknown = await patch('6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b');
  expect(unknown.status).toBe(404);
  expect(unknown.body.message).toBe('Person not found');

  const foreign = await patch(qPerson.id);
  expect(foreign.status).toBe(404);
  expect(foreign.body.message).toBe('Person not found');
  expect((await deviceRow(qPerson.id))!.email_opt_in).toBe(true);
  expect(await consentEvents(qPerson.id)).toEqual([{ channel: 'email', granted: true, source: 'sdk' }]);

  const malformed = await patch('abc');
  expect(malformed.status).toBe(404);
});

test('PPL-103 Consent edit refused in view-as and to outsiders', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const person = await identify(p, clientIp, { deviceFingerprint: fingerprint('fp-consent'), emailOptIn: true });
  const outsider = await createAccount(clientIp, 'ppl-outsider', 'Olu Outsider');
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);
  const path = `/api/identity/projects/${p.project.id}/users/${person.id}/consent`;

  const asStaff = await raw('PATCH', path, { emailOptIn: false }, { ip: clientIp, token: viewAs });
  expect(asStaff.status).toBe(403);
  expect(asStaff.body.message).toBe(READ_ONLY);

  const asOutsider = await raw('PATCH', path, { emailOptIn: false }, { ip: clientIp, token: outsider.accessToken });
  expect(asOutsider.status).toBe(404);
  expect(asOutsider.body.message).toBe(PROJECT_NOT_FOUND);

  const anonymous = await raw('PATCH', path, { emailOptIn: false }, { ip: clientIp });
  expect(anonymous.status).toBe(401);

  expect((await deviceRow(person.id))!.email_opt_in).toBe(true);
  expect((await consentEvents(person.id)).filter((e) => e.source === 'dashboard')).toEqual([]);
});

test('PPL-104 Dashboard do-not-track on one device', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);

  const answer = await raw('PATCH', `/api/identity/projects/${p.project.id}/users/${asha.ios.id}/consent`, { doNotTrack: true }, { ip: clientIp, token: p.owner.accessToken });
  expect(answer.status).toBe(200);

  expect(await deviceRow(asha.ios.id)).toMatchObject({ do_not_track: true, do_not_track_source: 'dashboard' });
  expect((await consentEvents(asha.ios.id)).filter((e) => e.channel === 'tracking')).toEqual([
    { channel: 'tracking', granted: false, source: 'dashboard' },
  ]);
  expect(await deviceRow(asha.web.id)).toMatchObject({ do_not_track: false, do_not_track_source: null });
  expect(await consentEvents(asha.web.id)).toEqual([]);
  expect(await objectionRows(p.project.id)).toEqual([]);
  const logged = await activityRows(p.project.id, 'person.consent_changed');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ target_id: asha.ios.id, details: { consents: { doNotTrack: true } } });
});

// ---- Tracking objections

test('PPL-109 Create an objection', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const startedAt = Date.now();

  const created = await objectFor(p, clientIp, asha.externalUserId, asha.ios.id);
  expect(created.status).toBe(201);
  expect(created.body.data).toMatchObject({
    externalUserId: asha.externalUserId,
    deviceCount: 2,
    objecting: true,
    createdBy: p.owner.userId,
    sourceIdentityId: asha.ios.id,
  });
  expect(Math.abs(new Date(created.body.data.createdAt).getTime() - startedAt)).toBeLessThan(60_000);

  expect(await objectionRows(p.project.id)).toEqual([
    expect.objectContaining({ external_user_id: asha.externalUserId, created_by: p.owner.userId, source_identity_id: asha.ios.id }),
  ]);
  for (const device of [asha.ios, asha.web]) {
    expect((await consentEvents(device.id)).filter((e) => e.channel === 'tracking')).toEqual([
      { channel: 'tracking', granted: false, source: 'dashboard' },
    ]);
  }
  const logged = await activityRows(p.project.id, 'tracking.objection_recorded');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ actor_user_id: p.owner.userId, target_type: null, target_id: null, details: null });

  // Behaviour from either device is dropped from now on.
  await identify(p, clientIp, { deviceFingerprint: asha.web.deviceFingerprint, externalUserId: asha.externalUserId, utmSource: 'later' });
  expect(await deviceRow(asha.web.id)).toMatchObject({ total_sessions: 1, latest_utm_source: null });
  await raw('POST', '/api/identity/revenue', { projectId: p.project.id, deviceFingerprint: asha.ios.deviceFingerprint, amount: 5 }, { ip: clientIp, apiKey: p.sdkKey });
  expect(Number((await deviceRow(asha.ios.id))!.total_revenue)).toBe(0);
  const event = await trackEvent(p, clientIp, { deviceFingerprint: asha.ios.deviceFingerprint, eventName: 'after_objection' });
  expect(event.status).toBe(201);
  expect(event.body.data).toEqual({ recorded: false });
});

test('PPL-112 Create objection roles and view-as', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);
  const outsider = await createAccount(clientIp, 'ppl-outsider', 'Olu Outsider');
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);
  const path = `/api/identity/projects/${p.project.id}/tracking-objections`;
  const body = { externalUserId: asha.externalUserId, sourceIdentityId: asha.ios.id };

  for (const teammate of [admin, member]) {
    const refused = await raw('POST', path, body, { ip: clientIp, token: teammate.accessToken });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe(ROLE_REFUSAL);
  }
  const asStaff = await raw('POST', path, body, { ip: clientIp, token: viewAs });
  expect(asStaff.status).toBe(403);
  expect(asStaff.body.message).toBe(READ_ONLY);
  const asOutsider = await raw('POST', path, body, { ip: clientIp, token: outsider.accessToken });
  expect(asOutsider.status).toBe(404);
  expect(asOutsider.body.message).toBe(PROJECT_NOT_FOUND);

  expect(await objectionRows(p.project.id)).toEqual([]);
  expect(await consentEvents(asha.ios.id)).toEqual([]);
  expect(await activityRows(p.project.id, 'tracking.objection_recorded')).toEqual([]);
});

test('PPL-113 Lift an objection needs a recent sign-in', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  expect((await objectFor(p, clientIp, asha.externalUserId)).status).toBe(201);
  const stale = await staleAccessToken(p.owner, clientIp);
  const path = `/api/identity/projects/${p.project.id}/tracking-objections/lift`;

  const refused = await raw('POST', path, { externalUserId: asha.externalUserId }, { ip: clientIp, token: stale });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe('Confirm it is you to continue.');
  expect(await objectionRows(p.project.id)).toHaveLength(1);

  const reauth = await api<{ accessToken: string }>('POST', '/api/auth/reauth', { password: p.owner.password }, { ip: clientIp, token: stale });
  const lifted = await raw('POST', path, { externalUserId: asha.externalUserId }, { ip: clientIp, token: reauth.accessToken });
  expect(lifted.status).toBe(200);
  expect(lifted.body.data).toEqual({
    externalUserId: asha.externalUserId,
    deviceCount: 2,
    objecting: false,
    createdAt: null,
    createdBy: null,
    sourceIdentityId: null,
  });
  expect(await objectionRows(p.project.id)).toEqual([]);
  for (const device of [asha.ios, asha.web]) {
    expect((await consentEvents(device.id)).filter((e) => e.channel === 'tracking')).toEqual([
      { channel: 'tracking', granted: false, source: 'dashboard' },
      { channel: 'tracking', granted: true, source: 'dashboard' },
    ]);
  }
  const logged = await activityRows(p.project.id, 'tracking.objection_lifted');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ actor_user_id: p.owner.userId, target_type: null, target_id: null, details: null });

  // Tracked again.
  await identify(p, clientIp, { deviceFingerprint: asha.web.deviceFingerprint, externalUserId: asha.externalUserId, utmSource: 'back' });
  expect(await deviceRow(asha.web.id)).toMatchObject({ total_sessions: 2, latest_utm_source: 'back' });
  const event = await trackEvent(p, clientIp, { deviceFingerprint: asha.web.deviceFingerprint, eventName: 'after_lift' });
  expect(event.body.data).toMatchObject({ eventName: 'after_lift' });
});

test('PPL-115 Lift roles, view-as and validation', async ({ browser, baseURL, clientIp }) => {
  test.slow();
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  expect((await objectFor(p, clientIp, asha.externalUserId)).status).toBe(201);
  const admin = await addTeammate(p.owner, p.project.id, 'admin', clientIp);
  const member = await addTeammate(p.owner, p.project.id, 'member', clientIp);
  const viewAs = await viewAsToken(browser, baseURL, p.owner, clientIp);
  const path = `/api/identity/projects/${p.project.id}/tracking-objections/lift`;
  const body = { externalUserId: asha.externalUserId };

  for (const teammate of [admin, member]) {
    const refused = await raw('POST', path, body, { ip: clientIp, token: teammate.accessToken });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe(ROLE_REFUSAL);
  }
  const asStaff = await raw('POST', path, body, { ip: clientIp, token: viewAs });
  expect(asStaff.status).toBe(403);
  expect(asStaff.body.message).toBe(READ_ONLY);

  // The owner's token is from a sign-in a moment ago.
  const extra = await raw('POST', path, { externalUserId: 'u', sourceIdentityId: asha.ios.id }, { ip: clientIp, token: p.owner.accessToken });
  expect(extra.status).toBe(400);
  expect(messageOf(extra)).toBe('property sourceIdentityId should not exist');

  expect(await objectionRows(p.project.id)).toHaveLength(1);
});

test('PPL-116 Row-level consent cannot create or lift a person objection', async ({ clientIp }) => {
  const p = await peopleProject(clientIp);
  const asha = await seedAsha(p, clientIp);
  expect((await objectFor(p, clientIp, asha.externalUserId)).status).toBe(201);

  const patched = await raw('PATCH', `/api/identity/projects/${p.project.id}/users/${asha.ios.id}/consent`, { doNotTrack: false }, { ip: clientIp, token: p.owner.accessToken });
  expect(patched.status).toBe(200);
  expect(await deviceRow(asha.ios.id)).toMatchObject({ do_not_track: false, do_not_track_source: 'dashboard' });

  await identify(p, clientIp, { deviceFingerprint: asha.ios.deviceFingerprint, externalUserId: asha.externalUserId, doNotTrack: false });

  expect(await objectionRows(p.project.id)).toEqual([expect.objectContaining({ external_user_id: asha.externalUserId })]);
  const preview = await api<{ objecting: boolean }>(
    'GET',
    `/api/identity/projects/${p.project.id}/tracking-objections/preview?externalUserId=${encodeURIComponent(asha.externalUserId)}`,
    undefined,
    { token: p.owner.accessToken, ip: clientIp },
  );
  expect(preview.objecting).toBe(true);
  expect((await consentEvents(asha.ios.id)).filter((e) => e.channel === 'tracking')).toEqual([
    { channel: 'tracking', granted: false, source: 'dashboard' },
  ]);
  expect(await deviceRow(asha.ios.id)).toMatchObject({ total_sessions: 1 });
});

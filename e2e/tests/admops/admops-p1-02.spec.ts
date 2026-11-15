import { randomUUID } from 'crypto';
import { devices, type Page, type Request } from '@playwright/test';
import { adminApi } from '../../support/admin';
import { createAccount, createApiKey, createProject, newClientIp, uniqueEmail } from '../../support/api';
import { allowClipboard, fixedLocaleContext, readClipboard, readDownload } from '../../support/browser-tools';
import { addAuthenticator } from '../../support/factors';
import { expect, test } from '../../support/fixtures';
import { runJobNow } from '../../support/jobs';
import { mailsTo, waitForMail } from '../../support/mailbox';
import {
  adminRequest,
  adminUrl,
  alarmListRow,
  alarms,
  attemptRolledBack,
  auditRowsWhere,
  auditTableRows,
  cardTitled,
  comparableError,
  copyPasskeys,
  csvRecords,
  customerRequest,
  errorMessages,
  eventually,
  floorMinute,
  hex,
  incidentListRow,
  incidentRow,
  istAndUtc,
  localInputValue,
  openAdminPage,
  postAlarm,
  rawRequest,
  recordIncident,
  seedAlarm,
  seedAuditRows,
  seedTrapAccount,
  seedTrapKey,
  signedInStaff,
  signedInStaffWithKey,
  sleep,
  sql,
  staffPasskeySignIn,
  startCustomerApiWith,
  startExtraAdminApi,
  toastItem,
  useApiKey,
  type AlarmRow,
  type IncidentRow,
} from '../../support/areas/admops';

/**
 * Staff operations, P1: the incident list, alarms and where they come from, the
 * localhost alarm route, traps and their use, the security contact, one incident's
 * page (deadline, report draft, mark reported, notes, close), reminders, incident times
 * across time zones, and the audit log export's filters.
 */

test.describe.configure({ mode: 'parallel' });

const MINUTE = 60_000;
const HOUR = 3600_000;
const INVALID_KEY = 'Invalid or expired API key';
const INVALID_LOGIN = 'Invalid email or password';
const FORGOT_PASSWORD = 'If that address has an account, a link to reset the password is on its way.';
const KIND_ERROR = 'kind must be one of the following values: server.ssh_login, server.ssh_banned, server.files_changed';
const RECORD_HEADING = 'Incidents';

type ReminderRow = IncidentRow & { reminder_4h_at: Date | null; reminder_5h_at: Date | null; reminder_email_failed: boolean };
type FullAlarm = AlarmRow & { last_at: Date; emailed_at: Date | null; email_failed: boolean };

const reminderRow = (id: string) => incidentRow(id) as Promise<ReminderRow>;

/** The banner on an incident's page: the countdown (open) or what happened (reported, closed). */
const deadlineBanner = (page: Page) => page.getByRole('alert').filter({ hasText: 'to report to CERT-In' });
const outcomeBanner = (page: Page) => page.getByRole('status').filter({ hasText: /^(Reported to CERT-In|Closed) / });

/** Holds a page's requests matching `url` for `ms` before letting them through. */
async function delayRequests(page: Page, url: string | RegExp, ms = 1200, method?: string): Promise<void> {
  await page.route(url, async (route) => {
    if (!method || route.request().method() === method) await sleep(ms);
    await route.fallback();
  });
}

/** Closes an incident left overdue by a test, so the platform-wide overdue count is not disturbed. */
async function settle(token: string, ip: string, id: string): Promise<void> {
  await adminRequest('POST', `/api/admin/incidents/${id}/close`, { token, ip, body: { note: 'E2E: done with this one' } });
}

/** A trap address nobody has, its trap row, and the address in mixed case. */
async function trapAddress(caseId: string) {
  const address = `trap-${caseId}-${hex()}@e2e.example.test`;
  const label = `E2E trap account ${caseId} ${hex()}`;
  const { id } = await seedTrapAccount(label, address);
  const mixed = address.replace(/^trap/, 'Trap').replace('@e2e.example.test', '@E2E.Example.Test');
  return { address, label, id, mixed };
}

// ---------------------------------------------------------------- Incident list

test('ADMOPS-089 incident list columns and formats', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const noticedAt = new Date(floorMinute(Date.now()) - 2 * HOUR).toISOString();
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 089 ${hex()}`, types: ['i', 'iii'], noticedAt });
  expect(Date.parse(incident.deadline) - Date.parse(noticedAt)).toBe(6 * HOUR);

  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Report by' }) });
  await expect(table.getByRole('columnheader')).toHaveText(['Incident', 'Noticed', 'Report by', 'Status']);
  const cells = incidentListRow(page, incident.title).locator('td');
  await expect(cells.nth(0).getByRole('link', { name: incident.title, exact: true })).toHaveAttribute('href', `/incidents/${incident.id}`);
  await expect(cells.nth(0)).toHaveText(`${incident.title}Types i, iii`);
  await expect(cells.nth(1)).toHaveText(istAndUtc(noticedAt));
  await expect(cells.nth(1)).toHaveText(/^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} IST \(\d{2}:\d{2} UTC\)$/);
  await expect(cells.nth(2)).toHaveText(istAndUtc(incident.deadline));
  await expect(cells.nth(3)).toHaveText(/^(3 h 59|4 h 0) min left$/);
});

test('ADMOPS-090 countdown text and its movement', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const start = Date.now();
  const soon = await recordIncident(staff.token, clientIp, { title: `E2E incident 090a ${hex()}`, noticedAt: new Date(start - MINUTE).toISOString() });
  const later = await recordIncident(staff.token, clientIp, {
    title: `E2E incident 090b ${hex()}`,
    noticedAt: new Date(start - (5 * 60 + 20) * MINUTE).toISOString(),
  });
  await page.clock.install({ time: start });
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const status = (title: string) => incidentListRow(page, title).locator('td').last();
  await expect(status(soon.title)).toHaveText('5 h 59 min left');
  await expect(status(later.title)).toHaveText('40 min left');

  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  // 50 minutes on: the second one is past its deadline in the page's clock.
  await page.clock.fastForward(50 * MINUTE);
  await expect(status(soon.title)).toHaveText('5 h 9 min left');
  await expect(status(later.title)).toHaveText('Overdue by 10 min');
  await expect(status(later.title).locator('span')).toHaveClass(/text-destructive/);
  await expect(status(soon.title).locator('span')).not.toHaveClass(/text-destructive/);
  await expect(incidentListRow(page, later.title)).toHaveClass(/bg-destructive\/5/);
  expect(navigations).toBe(0);
});

test('ADMOPS-092 reported and closed incidents show their status, not a countdown', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const sevenHoursAgo = new Date(Date.now() - 7 * HOUR).toISOString();
  const reported = await recordIncident(staff.token, clientIp, { title: `E2E incident 092r ${hex()}`, noticedAt: sevenHoursAgo });
  await adminApi('POST', `/api/admin/incidents/${reported.id}/report`, { method: 'email' }, staff.token, clientIp);
  const closed = await recordIncident(staff.token, clientIp, { title: `E2E incident 092c ${hex()}`, noticedAt: sevenHoursAgo });
  await adminApi('POST', `/api/admin/incidents/${closed.id}/close`, { note: 'E2E: not reportable' }, staff.token, clientIp);

  const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/incidents' && r.request().method() === 'GET');
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const list = ((await (await listed).json()) as { data: { id: string; status: string; deadline: string }[] }).data;
  expect(list.find((i) => i.id === reported.id)?.status).toBe('reported');
  expect(list.find((i) => i.id === closed.id)?.status).toBe('closed');

  for (const [incident, text] of [
    [reported, 'Reported'],
    [closed, 'Closed'],
  ] as const) {
    const row = incidentListRow(page, incident.title);
    await expect(row.locator('td').last()).toHaveText(text);
    await expect(row.locator('td').last().locator('span')).toHaveClass(/text-muted-foreground/);
    await expect(row).not.toHaveClass(/bg-destructive/);
  }
  // The alert counts only open incidents past their deadline: neither of these.
  const overdue = list.filter((i) => i.status === 'open' && Date.parse(i.deadline) < Date.now()).length;
  const alert = page.getByRole('alert').filter({ hasText: 'past the 6-hour deadline' });
  if (overdue === 0) await expect(alert).toHaveCount(0);
  else await expect(alert).toHaveText(`${overdue === 1 ? 'One incident is' : `${overdue} incidents are`} past the 6-hour deadline and not marked reported.`);
});

// ---------------------------------------------------------------- Recent alarms

test('ADMOPS-095 alarm list: label, count, email state, details, time, address', async ({ page, clientIp }) => {
  const label = `E2E trap key 095 ${hex()}`;
  const trap = await seedTrapKey(label);
  const caller = newClientIp();
  expect((await useApiKey(trap.key, caller)).status).toBe(401);
  expect((await useApiKey(trap.key, caller)).status).toBe(401);
  // Account email is on in this stack, so the alarm's email goes and the row says so.
  const [alarm] = (await eventually(
    () => alarms({ kind: 'tripwire.api_key', key: trap.id }),
    (rows) => rows[0]?.count === 2 && (rows[0] as FullAlarm).emailed_at !== null,
  )) as FullAlarm[];
  expect(alarm.email_failed).toBe(false);

  await signedInStaff(page, clientIp);
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const card = cardTitled(page, 'Recent alarms');
  await expect(card.getByText('Each alarm is emailed to every staff member, at most once in 15 minutes; repeats are counted.', { exact: true })).toBeVisible();
  const row = alarmListRow(page, `label: ${label}, route: POST /api/events/track`);
  const cells = row.locator('td');
  await expect(cells.nth(0)).toHaveText(`Trap API key used×2label: ${label}, route: POST /api/events/track`);
  await expect(cells.nth(0).locator('svg.lucide-shield-alert')).toHaveCount(1);
  await expect(row.getByText('×2', { exact: true })).toBeVisible();
  await expect(row.getByText('Email not sent')).toHaveCount(0);
  await expect(cells.nth(1)).toHaveText(istAndUtc(alarm.first_at));
  await expect(cells.nth(2)).toHaveText(caller);
  await expect(cells.nth(2)).toHaveClass(/font-mono/);
  await expect(row.getByRole('button', { name: 'Open an incident' })).toBeVisible();
});

test('ADMOPS-101 open an incident from an alarm prefills the form and links the alarm', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const label = `E2E trap key 101 ${hex()}`;
  const trap = await seedTrapKey(label);
  await useApiKey(trap.key, newClientIp());
  const [alarm] = await eventually(() => alarms({ kind: 'tripwire.api_key', key: trap.id }), (rows) => rows.length > 0);

  await openAdminPage(page, '/incidents', RECORD_HEADING);
  await alarmListRow(page, `label: ${label}, route:`).getByRole('button', { name: 'Open an incident' }).click();
  await expect(page.locator('#record')).toBeInViewport();
  const how = `Security alarm: Trap API key used (${trap.id})`;
  await expect(page.getByLabel('When it was noticed (your time)')).toHaveValue(await localInputValue(page, alarm.first_at.getTime()));
  await expect(page.getByLabel('How it came to notice')).toHaveValue(how);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Trap API key used');

  await page.getByRole('checkbox', { name: '(iii) Unauthorised access of IT systems/data' }).check();
  await page.getByRole('button', { name: 'Record incident' }).click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: 'Trap API key used', level: 1 })).toBeVisible();
  await expect(page.locator('p').filter({ hasText: 'How noticed:' })).toHaveText(`How noticed: ${how}`);
  const row = await incidentRow(id);
  expect(row).toMatchObject({ alert_id: alarm.id, how_noticed: how, title: 'Trap API key used' });
  expect(row.noticed_at.getTime()).toBe(floorMinute(alarm.first_at));
});

// ---------------------------------------------------------------- Alarm sources

test('ADMOPS-102 repeats within 15 minutes add to one alarm; later ones start a new one', async ({ page, clientIp }) => {
  const label = `E2E trap key 102 ${hex()}`;
  const trap = await seedTrapKey(label);
  const caller = newClientIp();
  for (let i = 0; i < 3; i++) expect((await useApiKey(trap.key, caller)).status).toBe(401);
  await eventually(() => alarms({ kind: 'tripwire.api_key', key: trap.id }), (rows) => rows[0]?.count === 3);
  const rows = (await alarms({ kind: 'tripwire.api_key', key: trap.id })) as FullAlarm[];
  expect(rows).toHaveLength(1);
  expect(rows[0].last_at.getTime()).toBeGreaterThan(rows[0].first_at.getTime());

  // Another trap whose alarm started 16 minutes ago: a new use opens a new alarm.
  const otherLabel = `E2E trap key 102b ${hex()}`;
  const other = await seedTrapKey(otherLabel);
  const oldId = await seedAlarm({
    kind: 'tripwire.api_key',
    key: other.id,
    details: { label: otherLabel, route: 'POST /api/events/track' },
    ip: caller,
    firstAt: new Date(Date.now() - 16 * MINUTE),
  });
  expect((await useApiKey(other.key, caller)).status).toBe(401);
  const both = await eventually(() => alarms({ kind: 'tripwire.api_key', key: other.id }), (list) => list.length === 2);
  expect(both.map((a) => ({ old: a.id === oldId, count: a.count }))).toEqual([
    { old: true, count: 1 },
    { old: false, count: 1 },
  ]);

  await signedInStaff(page, clientIp);
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  await expect(alarmListRow(page, `label: ${label}, route:`).getByText('×3', { exact: true })).toBeVisible();
  await expect(alarmListRow(page, `label: ${otherLabel}, route:`)).toHaveCount(2);
});

test('ADMOPS-104 a staff sign-in from a new device raises "Staff sign-in from a new device"', async ({ page, clientIp, browser }) => {
  test.slow();
  const staff = await signedInStaffWithKey(page, clientIp);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const deviceAlarms = () => alarms({ kind: 'staff.new_device', keyLike: `${staff.account.userId}:%` });

  // The same browser again (same user agent, the passkey copied into a fresh context).
  const sameIp = newClientIp();
  const same = await browser.newContext({ userAgent, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': sameIp } });
  const phoneIp = newClientIp();
  const phone = await browser.newContext({
    userAgent: devices['iPhone 15'].userAgent,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'X-Forwarded-For': phoneIp },
  });
  try {
    const samePage = await same.newPage();
    const sameKey = await addAuthenticator(samePage);
    await copyPasskeys(staff.authenticator, sameKey);
    await samePage.goto(adminUrl('/sign-in'));
    await staffPasskeySignIn(samePage);
    await eventually(
      () => sql(`SELECT id FROM staff_sessions WHERE user_id = $1`, [staff.account.userId]),
      (rows) => rows.length >= 2,
    );
    await sleep(2500);
    // Neither the first sign-in of the account nor a second from the same browser alarms.
    expect(await deviceAlarms()).toEqual([]);

    const phonePage = await phone.newPage();
    const phoneKey = await addAuthenticator(phonePage);
    await copyPasskeys(sameKey, phoneKey);
    await phonePage.goto(adminUrl('/sign-in'));
    await staffPasskeySignIn(phonePage);
    const [alarm] = await eventually(deviceAlarms, (rows) => rows.length > 0);
    expect(alarm.details).toEqual({ email: staff.account.email, device: expect.stringMatching(/ on iOS$/) });
    expect(alarm.ip_address).toBe(phoneIp);
    expect(alarm.dedupe_key).toBe(`${staff.account.userId}:${alarm.details.device}`);

    await openAdminPage(page, '/incidents', RECORD_HEADING);
    const row = alarmListRow(page, `email: ${staff.account.email}, device: ${alarm.details.device}`);
    await expect(row).toContainText('Staff sign-in from a new device');
    await expect(row.locator('td').nth(2)).toHaveText(phoneIp);
  } finally {
    await same.close();
    await phone.close();
  }
});

test.describe('large exports with BULK_EXPORT_ALERT_ROWS=1 on the customer API', () => {
  test.describe.configure({ mode: 'serial' });
  let variant: { url: string; stop(): Promise<void> };

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    variant = await startCustomerApiWith({ BULK_EXPORT_ALERT_ROWS: '1' }, 'bulk-export-alarm');
  });

  test.afterAll(async () => {
    await variant?.stop();
  });

  test('ADMOPS-105 large exports raise "Large data export"', async ({ page, clientIp }) => {
    const owner = await createAccount(clientIp, 'owner');
    const project = await createProject(owner, clientIp);
    await createApiKey(owner, project.id, clientIp);
    const exportActivity = () =>
      rawRequest(`${variant.url}/api/projects/${project.id}/activity/export`, 'GET', undefined, {
        Authorization: `Bearer ${owner.accessToken}`,
        'X-Forwarded-For': clientIp,
        'X-Chumbaq-Client': 'web',
      });
    const bulk = () => alarms({ kind: 'data.bulk_export', key: owner.userId });

    const first = await exportActivity();
    expect(first.status).toBe(200);
    expect(csvRecords(first.text).length).toBeGreaterThanOrEqual(1);
    const [alarm] = await eventually(bulk, (rows) => rows.length > 0);
    expect(alarm.details).toEqual({ rows: 1, projectId: project.id, route: 'activity export' });

    // A second export in the hour succeeds and raises nothing more.
    const second = await exportActivity();
    expect(second.status).toBe(200);
    await sleep(2000);
    expect((await bulk()).map((a) => a.count)).toEqual([1]);

    await signedInStaff(page, newClientIp());
    await openAdminPage(page, '/incidents', RECORD_HEADING);
    // Details are shown in the order the database keeps them (jsonb: shorter keys first).
    const row = alarmListRow(page, `projectId: ${project.id}`);
    await expect(row).toContainText('Large data export');
    await expect(row.locator('div.break-all')).toHaveText(`rows: 1, route: activity export, projectId: ${project.id}`);
  });
});

test('ADMOPS-108 alarm rows are append-only', async () => {
  const id = await seedAlarm({ kind: 'tripwire.api_key', key: `e2e-108-${hex()}`, details: { label: 'E2E 108' } });
  const ONLY = 'security_alerts is append-only';
  expect(
    await attemptRolledBack(
      [
        `DELETE FROM security_alerts WHERE id = $1`,
        `UPDATE security_alerts SET kind = 'staff.new_device' WHERE id = $1`,
        `UPDATE security_alerts SET first_at = now() - interval '1 day' WHERE id = $1`,
        `TRUNCATE security_alerts`,
        `UPDATE security_alerts SET count = count + 1, last_at = now() WHERE id = $1`,
        `UPDATE security_alerts SET emailed_at = now(), email_failed = true WHERE id = $1`,
      ],
      [id],
    ),
  ).toEqual([ONLY, ONLY, ONLY, ONLY, 'ok', 'ok']);
  // The tally does move for real.
  await sql(`UPDATE security_alerts SET count = count + 1, last_at = now() WHERE id = $1`, [id]);
  const [row] = await sql<{ count: number; kind: string }>(`SELECT count, kind FROM security_alerts WHERE id = $1`, [id]);
  expect(row).toEqual({ count: 2, kind: 'tripwire.api_key' });
});

// ---------------------------------------------------------------- Internal alarm route

test.describe('the internal alarm route with SECURITY_ALERT_TOKEN set (P1)', () => {
  // One worker for both tests, so they share the one extra process this block starts.
  test.describe.configure({ mode: 'serial' });
  let extra: { url: string; stop(): Promise<void> };
  const token = `e2e-alarm-${hex(16)}`;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    extra = await startExtraAdminApi({ SECURITY_ALERT_TOKEN: token }, 'alarm-token-p1');
  });

  test.afterAll(async () => {
    await extra?.stop();
  });

  test('ADMOPS-113 internal route validation', async () => {
    const prefix = `e2e-113-${hex()}`;
    const base = (n: number) => ({ kind: 'server.ssh_login', key: `${prefix}-${n}`, details: { user: 'ubuntu' } });
    const manyDetails = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`d${i}`, 'x']));
    const { key: _omitted, ...noKey } = base(0);
    const cases: [string, unknown, string][] = [
      ['trap kind', { ...base(1), kind: 'tripwire.api_key' }, KIND_ERROR],
      ['staff kind', { ...base(2), kind: 'staff.new_device' }, KIND_ERROR],
      ['no key', noKey, 'key must be a string'],
      ['empty key', { ...base(3), key: '' }, 'key must be longer than or equal to 1 characters'],
      ['201-character key', { ...base(4), key: `${prefix}-`.padEnd(201, 'k') }, 'key must be shorter than or equal to 200 characters'],
      ['21 details', { ...base(5), details: manyDetails }, 'At most 20 details'],
      ['a number detail', { ...base(6), details: { n: 3 } }, 'Details must be text'],
      ['details as text', { ...base(7), details: 'text' }, 'details must be an object'],
      ['65-character ip', { ...base(8), ip: '1'.repeat(65) }, 'ip must be shorter than or equal to 64 characters'],
      ['an extra field', { ...base(9), extra: 1 }, 'property extra should not exist'],
    ];
    for (const [name, body, message] of cases) {
      const response = await postAlarm(extra.url, body, { 'X-Security-Alert-Token': token });
      expect.soft({ name, status: response.status }).toEqual({ name, status: 400 });
      expect.soft(errorMessages(response.json), name).toContain(message);
    }
    expect(await alarms({ keyLike: `${prefix}%` })).toEqual([]);
    // The same body, valid, is accepted (the refusals above were the validation's).
    const accepted = await postAlarm(extra.url, base(10), { 'X-Security-Alert-Token': token });
    expect(accepted.status).toBe(202);
    expect(await alarms({ keyLike: `${prefix}%` })).toHaveLength(1);
  });

  test('ADMOPS-114 long detail values are shortened, never refused', async ({ page, clientIp }) => {
    test.info().annotations.push({ type: 'issue', description: 'ADMOPS-114' });
    test.fail();
    const key = `aide-114-${hex()}`;
    const files = `/etc/e2e-114-${hex()}/${'a'.repeat(2000)}`.slice(0, 2000);
    const response = await postAlarm(extra.url, { kind: 'server.files_changed', key, details: { files } }, { 'X-Security-Alert-Token': token });
    expect({ status: response.status, body: response.json }).toEqual({ status: 202, body: { data: { accepted: true } } });
    const [alarm] = await alarms({ key });
    const stored = String(alarm.details.files);
    expect(stored).toHaveLength(500);
    expect(stored).toBe(`${files.slice(0, 499)}…`);

    await signedInStaff(page, clientIp);
    await openAdminPage(page, '/incidents', RECORD_HEADING);
    const row = alarmListRow(page, `files: ${files.slice(0, 40)}`);
    await expect(row).toContainText('Server files changed');
    const details = row.locator('div.break-all');
    await expect(details).toHaveText(`files: ${stored}`);
    // Wrapped inside the card rather than widening the table.
    const card = await cardTitled(page, 'Recent alarms').boundingBox();
    const box = await details.boundingBox();
    expect(box!.width).toBeLessThan(card!.width);
    expect(box!.height).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------- Traps

test('ADMOPS-123 trap creation validation', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const label = `E2E trap account 123 ${hex()}`;
  await page.getByLabel('Label (where you put it)').fill(label);
  await page.getByLabel('Trap address (for an account trap)').fill('not-an-email');
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/admin/tripwires/account')),
    page.getByRole('button', { name: 'Make a trap account' }).click(),
  ]);
  expect(refused.status()).toBe(400);
  const toast = toastItem(page, 'That did not work');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('email must be an email');

  const call = (path: string, body: unknown) => adminRequest('POST', path, { token: staff.token, ip: clientIp, body });
  const cases: [string, string, unknown, string][] = [
    ['no label', 'api-key', {}, 'label must be a string'],
    ['empty label', 'api-key', { label: '' }, 'label must be longer than or equal to 1 characters'],
    ['101-character label', 'api-key', { label: 'l'.repeat(101) }, 'label must be shorter than or equal to 100 characters'],
    ['an extra field', 'api-key', { label: `E2E 123 ${hex()}`, extra: 1 }, 'property extra should not exist'],
    ['account without email', 'account', { label: `E2E 123 ${hex()}` }, 'email must be an email'],
  ];
  for (const [name, route, body, message] of cases) {
    const response = await call(`/api/admin/tripwires/${route}`, body);
    expect.soft({ name, status: response.status }).toEqual({ name, status: 400 });
    expect.soft(errorMessages(response.json), name).toContain(message);
  }
  expect(await auditRowsWhere({ actorEmail: staff.account.email, action: 'tripwire.created' })).toEqual([]);
  expect(await sql(`SELECT id FROM security_tripwires WHERE label LIKE 'E2E 123 %' OR label = $1`, [label])).toEqual([]);
});

test('ADMOPS-126 revoke route refusals', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const label = `E2E trap key 126 ${hex()}`;
  const { id } = await adminApi<{ id: string }>('POST', '/api/admin/tripwires/api-key', { label }, staff.token, clientIp);
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const item = page.locator('li').filter({ hasText: label });
  await expect(item.getByRole('button', { name: 'Switch off' })).toBeVisible();

  // Switched off behind the page's back: the page's own switch-off is then refused.
  const revoke = (trapId: string) => adminRequest('POST', `/api/admin/tripwires/${trapId}/revoke`, { token: staff.token, ip: clientIp });
  expect((await revoke(id)).status).toBe(201);
  const again = await revoke(id);
  expect({ status: again.status, message: again.json?.message }).toEqual({ status: 404, message: 'No active trap with that id' });
  const random = randomUUID();
  const unknown = await revoke(random);
  expect({ status: unknown.status, message: unknown.json?.message }).toEqual({ status: 404, message: 'No active trap with that id' });
  const malformed = await revoke('not-a-uuid');
  expect({ status: malformed.status, message: malformed.json?.message }).toEqual({ status: 400, message: 'Validation failed (uuid is expected)' });

  expect((await auditRowsWhere({ targetId: id })).map((a) => a.action)).toEqual(['tripwire.revoked', 'tripwire.created']);
  expect(await auditRowsWhere({ targetId: random })).toEqual([]);

  await item.getByRole('button', { name: 'Switch off' }).click();
  const toast = toastItem(page, 'That did not work');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('No active trap with that id');
  expect((await auditRowsWhere({ targetId: id })).filter((a) => a.action === 'tripwire.revoked')).toHaveLength(1);
});

test('ADMOPS-131 a trap key on a server-only route raises with that route', async () => {
  const label = `E2E trap key 131 ${hex()}`;
  const trap = await seedTrapKey(label);
  const caller = newClientIp();
  const response = await useApiKey(trap.key, caller, '/api/privacy/erasures', { externalUserId: 'x' });
  expect({ status: response.status, message: response.json?.message }).toEqual({ status: 401, message: INVALID_KEY });
  const [alarm] = await eventually(() => alarms({ kind: 'tripwire.api_key', key: trap.id }), (rows) => rows.length > 0);
  expect({ details: alarm.details, ip: alarm.ip_address }).toEqual({ details: { label, route: 'POST /api/privacy/erasures' }, ip: caller });
});

test('ADMOPS-136 a trap address invited to a project', async ({ clientIp }) => {
  const trap = await trapAddress('136');
  const owner = await createAccount(clientIp, 'owner');
  const project = await createProject(owner, clientIp);
  const invited = await customerRequest('POST', `/api/projects/${project.id}/invitations`, {
    token: owner.accessToken,
    ip: clientIp,
    body: { email: trap.address, role: 'member' },
  });
  expect(invited.status).toBe(201);
  expect(invited.json.data.inviteUrl).toMatch(/\/invite#token=[A-Za-z0-9_-]{43}$/);
  expect(await sql(`SELECT id FROM project_invitations WHERE project_id = $1`, [project.id])).toHaveLength(1);

  const [alarm] = await eventually(() => alarms({ kind: 'tripwire.account', key: `${trap.id}:invite` }), (rows) => rows.length > 0);
  expect({ details: alarm.details, ip: alarm.ip_address }).toEqual({ details: { label: trap.label, action: 'invite' }, ip: clientIp });
});

test('ADMOPS-137 a trap address on staff sign-in', async () => {
  const trap = await trapAddress('137');
  const ip = newClientIp();
  const trapped = await adminRequest('POST', '/api/staff/auth/login', { ip, body: { email: trap.mixed, password: 'any-password-1!' } });
  const unknown = await adminRequest('POST', '/api/staff/auth/login', {
    ip: newClientIp(),
    body: { email: uniqueEmail('nobody-137'), password: 'any-password-1!' },
  });
  expect(trapped.status).toBe(401);
  expect(comparableError(trapped.json)).toEqual(comparableError(unknown.json));

  const key = `${trap.id}:sign_in`;
  const [alarm] = await eventually(() => alarms({ kind: 'tripwire.account', key }), (rows) => rows.length > 0);
  expect({ details: alarm.details, ip: alarm.ip_address, count: alarm.count }).toEqual({
    details: { label: trap.label, action: 'sign_in' },
    ip,
    count: 1,
  });
  // A customer sign-in with it inside the window adds to the same alarm.
  const customer = await customerRequest('POST', '/api/auth/login', { ip: newClientIp(), body: { email: trap.address, password: 'any-password-1!' } });
  expect({ status: customer.status, message: customer.json?.message }).toEqual({ status: 401, message: INVALID_LOGIN });
  await eventually(() => alarms({ kind: 'tripwire.account', key }), (rows) => rows[0]?.count === 2);
  expect(await alarms({ kind: 'tripwire.account', key })).toHaveLength(1);
});

test('ADMOPS-138 a switched-off trap address raises nothing', async () => {
  const off = await trapAddress('138');
  await sql(`UPDATE security_tripwires SET revoked_at = now() WHERE id = $1`, [off.id]);
  const live = await trapAddress('138-live');
  const ip = newClientIp();

  const signIn = await customerRequest('POST', '/api/auth/login', { ip, body: { email: off.address, password: 'any-password-1!' } });
  expect({ status: signIn.status, message: signIn.json?.message }).toEqual({ status: 401, message: INVALID_LOGIN });
  const forgot = await customerRequest('POST', '/api/auth/forgot-password', { ip, body: { email: off.address } });
  expect({ status: forgot.status, body: forgot.json?.data }).toEqual({ status: 200, body: { message: FORGOT_PASSWORD } });
  const register = await customerRequest('POST', '/api/auth/register', { ip, body: { email: off.address, name: 'Off Trap' } });
  expect({ status: register.status, body: register.json }).toEqual({ status: 202, body: { data: { status: 'check_email' } } });
  // Registration goes ahead as for any address: the sign-up mail is sent (account email is on here).
  await waitForMail(off.address, { subjectIncludes: 'Finish creating your Chumbaq account' });

  // A live trap used afterwards alarms, so the switched-off one's checks have had their turn.
  await customerRequest('POST', '/api/auth/login', { ip: newClientIp(), body: { email: live.address, password: 'any-password-1!' } });
  await eventually(() => alarms({ kind: 'tripwire.account', key: `${live.id}:sign_in` }), (rows) => rows.length > 0);
  await sleep(1000);
  expect(await alarms({ keyLike: `${off.id}:%` })).toEqual([]);
});

// ---------------------------------------------------------------- Security contact (one row for the platform)

test.describe('the security contact', () => {
  test.describe.configure({ mode: 'serial' });

  test('ADMOPS-140 security contact form: fields, save, persistence', async ({ page, clientIp }) => {
    const staff = await signedInStaff(page, clientIp);
    await openAdminPage(page, '/incidents', RECORD_HEADING);
    const card = cardTitled(page, 'Security contact');
    await expect(
      card.getByText('Used to fill the CERT-In report draft. The point of contact is the person CERT-In was told about (Annexure II).', { exact: true }),
    ).toBeVisible();
    const save = card.getByRole('button', { name: 'Save contact' });
    await expect(save).toBeDisabled();

    const id = hex();
    const values: [string, string][] = [
      ['Organisation', `E2E Org 140 ${id}`],
      ['Address', `1 E2E Road ${id}, Bengaluru`],
      ['Sector', 'Software'],
      ['Point of contact', `Pat Contact ${id}`],
      ['Their role', 'Security lead'],
      ['Their email', `poc-${id}@e2e.example.test`],
      ['Their phone', '+91 80 0000 0140'],
    ];
    for (const [label, value] of values) await card.getByLabel(label, { exact: true }).fill(value);
    await expect(save).toBeEnabled();
    await delayRequests(page, /\/api\/admin\/security-contact$/, 1200, 'PUT');
    await save.click();
    await expect(card.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    await expect(toastItem(page, 'Saved')).toBeVisible();
    await expect(save).toBeDisabled();

    await page.reload();
    await page.getByRole('heading', { name: RECORD_HEADING, level: 1 }).waitFor();
    for (const [label, value] of values) await expect(cardTitled(page, 'Security contact').getByLabel(label, { exact: true })).toHaveValue(value);

    const [row] = await sql(`SELECT * FROM security_contact`);
    expect(row).toMatchObject({
      id: 1,
      org_name: values[0][1],
      org_address: values[1][1],
      sector: 'Software',
      poc_name: values[3][1],
      poc_role: 'Security lead',
      poc_email: values[5][1],
      poc_phone: values[6][1],
      updated_by: staff.account.userId,
    });
    const audit = await auditRowsWhere({ actorEmail: staff.account.email, action: 'security_contact.updated' });
    expect(audit.map((a) => ({ type: a.target_type, id: a.target_id, label: a.target_label }))).toEqual([
      { type: 'security_contact', id: null, label: values[0][1] },
    ]);
  });

  test('ADMOPS-154 the draft uses the saved security contact', async ({ page, clientIp }) => {
    const staff = await signedInStaff(page, clientIp);
    const id = hex();
    const saved = {
      orgName: `  E2E Org 154 ${id}  `,
      orgAddress: ` 2 E2E Lane ${id} `,
      sector: '  Software  ',
      pocName: ` Sam Contact ${id} `,
      pocRole: ' CTO ',
      pocEmail: `poc-154-${id}@e2e.example.test`,
      pocPhone: '  +91 80 0000 0154 ',
    };
    await adminApi('PUT', '/api/admin/security-contact', saved, staff.token, clientIp);
    const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 154 ${hex()}` });

    await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
    await page.getByRole('button', { name: 'Draft the report' }).click();
    const report = page.getByRole('textbox', { name: 'Report' });
    await expect(report).toHaveValue(/Organisation: /);
    const body = await report.inputValue();
    const lines = body.split('\n');
    for (const line of [
      `Organisation: E2E Org 154 ${id}`,
      `Address: 2 E2E Lane ${id}`,
      'Sector: Software',
      `Name: Sam Contact ${id}`,
      'Designation: CTO',
      `Email: poc-154-${id}@e2e.example.test`,
      'Phone: +91 80 0000 0154',
    ]) {
      expect(lines, line).toContain(line);
    }
  });
});

test('ADMOPS-142 security contact validation', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const card = cardTitled(page, 'Security contact');
  const puts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().endsWith('/api/admin/security-contact')) puts.push(r.url());
  });
  const email = card.getByLabel('Their email', { exact: true });
  await email.fill('not-an-email');
  await card.getByRole('button', { name: 'Save contact' }).click();
  expect(await email.evaluate((el: HTMLInputElement) => el.validity.typeMismatch)).toBe(true);
  await sleep(500);
  expect(puts).toEqual([]);
  for (const label of ['Organisation', 'Address', 'Sector', 'Point of contact', 'Their role', 'Their email', 'Their phone']) {
    await expect(card.getByLabel(label, { exact: true })).toHaveAttribute('maxlength', '300');
  }

  const before = await sql(`SELECT * FROM security_contact`);
  const put = (body: unknown) => adminRequest('PUT', '/api/admin/security-contact', { token: staff.token, ip: clientIp, body });
  const cases: [string, unknown, string][] = [
    ['email', { pocEmail: 'x' }, 'pocEmail must be an email'],
    ['301-character organisation', { orgName: 'o'.repeat(301) }, 'orgName must be shorter than or equal to 300 characters'],
    ['numeric organisation', { orgName: 5 }, 'orgName must be a string'],
    ['an extra field', { orgName: 'E2E 142', updatedAt: new Date().toISOString() }, 'property updatedAt should not exist'],
  ];
  for (const [name, body, message] of cases) {
    const response = await put(body);
    expect.soft({ name, status: response.status }).toEqual({ name, status: 400 });
    expect.soft(errorMessages(response.json), name).toContain(message);
  }
  expect(await auditRowsWhere({ actorEmail: staff.account.email, action: 'security_contact.updated' })).toEqual([]);
  const after = await sql(`SELECT * FROM security_contact`);
  expect(after.filter((r) => r.updated_by === staff.account.userId)).toEqual([]);
  expect(before.length === 0 || after.length === 1).toBe(true);
});

// ---------------------------------------------------------------- One incident

test('ADMOPS-147 the overdue banner and its movement', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  // Noticed 5 hours ago for real; the page's clock is put 20 seconds before its deadline.
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 147 ${hex()}`, noticedAt: new Date(Date.now() - 5 * HOUR).toISOString() });
  await page.clock.install({ time: Date.parse(incident.deadline) - 20_000 });
  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  const banner = deadlineBanner(page);
  await expect(banner.locator('span').first()).toHaveText(/^[01] min left$/);
  await expect(banner).toHaveClass(/border-amber-500/);

  await page.clock.fastForward(2 * MINUTE);
  await expect(banner.locator('span').first()).toHaveText('Overdue by 2 min');
  await expect(banner).toHaveClass(/border-destructive\/30/);
  await expect(banner).not.toHaveClass(/border-amber-500/);
});

test('ADMOPS-150 unknown and malformed incident ids', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const backLink = page.getByRole('link', { name: 'Incidents' }).filter({ has: page.locator('svg.lucide-arrow-left') });
  for (const id of [randomUUID(), 'not-a-uuid']) {
    await page.goto(adminUrl(`/incidents/${id}`));
    await expect(page.getByText('Could not load this incident.', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(backLink).toHaveAttribute('href', '/incidents');
  }

  const get = (path: string) => adminRequest('GET', path, { token: staff.token, ip: clientIp });
  const random = randomUUID();
  const unknown = await get(`/api/admin/incidents/${random}`);
  const malformed = await get('/api/admin/incidents/not-a-uuid');
  const draft = await get(`/api/admin/incidents/${random}/report-draft`);
  expect([unknown, malformed, draft].map((r) => ({ status: r.status, message: r.json?.message }))).toEqual([
    { status: 404, message: 'Incident not found' },
    { status: 400, message: 'Validation failed (uuid is expected)' },
    { status: 404, message: 'Incident not found' },
  ]);
});

test('ADMOPS-151 incident detail API shape and the log command', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const noticedAt = '2026-11-12T10:20:30.000Z';
  const created = await recordIncident(staff.token, clientIp, { title: `E2E incident 151 ${hex()}`, noticedAt, types: ['iii'] });
  const response = await adminRequest('GET', `/api/admin/incidents/${created.id}`, { token: staff.token, ip: clientIp });
  const asked = Date.now();
  expect(response.status).toBe(200);
  const detail = response.json.data;
  expect(Object.keys(detail).sort()).toEqual(
    [
      'id', 'title', 'types', 'status', 'noticedAt', 'deadline', 'reportedAt', 'closedAt',
      'recordedAt', 'recordedBy', 'howNoticed', 'summary', 'systems', 'tenantIds', 'alertId',
      'reportedBy', 'reportMethod', 'certinReference', 'closedBy', 'reminderEmailFailed', 'notes', 'logCommand',
    ].sort(),
  );
  expect(detail).toMatchObject({
    id: created.id,
    status: 'open',
    noticedAt,
    deadline: '2026-11-12T16:20:30.000Z',
    recordedBy: staff.account.userId,
    tenantIds: [],
    alertId: null,
    notes: [],
  });
  const match = /^sudo \/usr\/local\/sbin\/chumbaq-collect-logs --from (\S+) --to (\S+)$/.exec(detail.logCommand);
  expect(match, detail.logCommand).not.toBeNull();
  expect(match![1]).toBe('2026-11-11T10:20:30Z');
  expect(match![2]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(Math.abs(Date.parse(match![2]) - asked)).toBeLessThan(10_000);
  await settle(staff.token, clientIp, created.id);
});

// ---------------------------------------------------------------- Report draft

test('ADMOPS-155 the draft lists notes and refreshes after a new note', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 155 ${hex()}` });
  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  await page.getByRole('button', { name: 'Draft the report' }).click();
  const report = page.getByRole('textbox', { name: 'Report' });
  await expect(report).toHaveValue(/\nActions taken so far\n\[to fill\]\n/);

  const isDraft = (r: Request) => r.method() === 'GET' && r.url().endsWith(`/api/admin/incidents/${incident.id}/report-draft`);
  const addNote = async (note: string) => {
    await page.getByRole('textbox', { name: 'New note' }).fill(note);
    const posted = page.waitForResponse((r) => r.url().endsWith(`/api/admin/incidents/${incident.id}/notes`));
    const refetched = page.waitForResponse((r) => isDraft(r.request()));
    await page.getByRole('button', { name: 'Add note' }).click();
    expect((await posted).status()).toBe(201);
    await refetched;
  };
  await addNote('Rotated the keys');
  await addNote('Told the customer');

  const notes = (await adminApi<{ notes: { createdAt: string; note: string }[] }>('GET', `/api/admin/incidents/${incident.id}`, undefined, staff.token, clientIp)).notes;
  expect(notes.map((n) => n.note)).toEqual(['Rotated the keys', 'Told the customer']);
  await expect(report).toHaveValue(
    new RegExp(
      `\\nActions taken so far\\n- ${escapeRegExp(istAndUtc(notes[0].createdAt))}: Rotated the keys\\n- ${escapeRegExp(istAndUtc(notes[1].createdAt))}: Told the customer\\n\\nLogs\\n`,
    ),
  );
  expect(await report.inputValue()).not.toContain('Actions taken so far\n[to fill]');
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('ADMOPS-157 copy the draft and open it in email', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, {
    title: `E2E incident 157 ${hex()} R&D? yes`,
    summary: 'Line one of the summary\nLine two of the summary',
  });
  const { subject, body } = await adminApi<{ subject: string; body: string }>('GET', `/api/admin/incidents/${incident.id}/report-draft`, undefined, staff.token, clientIp);
  expect(body).toContain('Line one of the summary\nLine two of the summary');

  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  await allowClipboard(page);
  const card = cardTitled(page, 'Report to CERT-In');
  await expect(card).toContainText('Nothing is sent from here.');
  await page.getByRole('button', { name: 'Draft the report' }).click();
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue(subject);

  await card.getByRole('button', { name: 'Copy' }).click();
  await expect(toastItem(page, 'Copied')).toBeVisible();
  expect(await readClipboard(page)).toBe(`${subject}\n\n${body}`);

  const link = card.getByRole('link', { name: 'Open in email' });
  const href = (await link.getAttribute('href'))!;
  expect(href).toBe(`mailto:incident@cert-in.org.in?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
  expect(href).toContain('R%26D%3F%20yes');
  expect(href).toContain('Line%20one%20of%20the%20summary%0ALine%20two');
  expect(href.split('&')).toHaveLength(2);
});

// ---------------------------------------------------------------- Mark reported

test('ADMOPS-161 mark reported by phone earlier, with a reference', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, {
    title: `E2E incident 161 ${hex()}`,
    noticedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
  });
  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  const how = page.getByLabel('How');
  await expect(how.locator('option')).toHaveText(['Email', 'Phone', 'Fax', 'Portal']);
  await how.selectOption({ label: 'Phone' });
  const hourAgo = floorMinute(Date.now() - HOUR);
  await page.getByLabel('When (your time)').fill(await localInputValue(page, hourAgo));
  await page.getByLabel('CERT-In reference, if given').fill('  CERTIN-123  ');
  await page.getByRole('button', { name: 'Mark reported' }).click();

  await expect(outcomeBanner(page)).toHaveText(`Reported to CERT-In ${istAndUtc(new Date(hourAgo))} by phone, reference CERTIN-123.`);
  const row = await incidentRow(incident.id);
  expect(row).toMatchObject({ status: 'reported', report_method: 'phone', certin_reference: 'CERTIN-123' });
  expect(row.reported_at!.getTime()).toBe(hourAgo);

  // Fax and Portal store their own methods.
  for (const [label, method] of [
    ['Fax', 'fax'],
    ['Portal', 'portal'],
  ] as const) {
    const other = await recordIncident(staff.token, clientIp, { title: `E2E incident 161 ${method} ${hex()}` });
    await openAdminPage(page, `/incidents/${other.id}`, other.title);
    await page.getByLabel('How').selectOption({ label });
    await page.getByRole('button', { name: 'Mark reported' }).click();
    await expect(outcomeBanner(page)).toContainText(`by ${method}.`);
    expect((await incidentRow(other.id)).report_method).toBe(method);
  }
});

test('ADMOPS-162 a reported time in the future is refused; an empty time means now', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 162 ${hex()}` });
  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  const when = page.getByLabel('When (your time)');
  await when.fill(await localInputValue(page, Date.now() + 24 * HOUR));
  const [refused] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/admin/incidents/${incident.id}/report`)),
    page.getByRole('button', { name: 'Mark reported' }).click(),
  ]);
  expect(refused.status()).toBe(400);
  const toast = toastItem(page, 'Could not mark it reported');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('When it was reported cannot be in the future');
  expect((await incidentRow(incident.id)).status).toBe('open');
  await expect(deadlineBanner(page)).toBeVisible();

  await when.fill('');
  const clicked = Date.now();
  await page.getByRole('button', { name: 'Mark reported' }).click();
  await expect(outcomeBanner(page)).toContainText('Reported to CERT-In');
  const row = await incidentRow(incident.id);
  expect(row.status).toBe('reported');
  expect(Math.abs(row.reported_at!.getTime() - clicked)).toBeLessThan(10_000);
});

test('ADMOPS-164 report route validation and state refusals', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 164 ${hex()}` });
  const report = (id: string, body: unknown) => adminRequest('POST', `/api/admin/incidents/${id}/report`, { token: staff.token, ip: clientIp, body });
  const METHOD = 'method must be one of the following values: email, phone, fax, portal';
  const cases: [string, unknown, string][] = [
    ['sms', { method: 'sms' }, METHOD],
    ['no method', {}, METHOD],
    ['101-character reference', { method: 'email', certinReference: 'r'.repeat(101) }, 'certinReference must be shorter than or equal to 100 characters'],
    ['reportedAt soon', { method: 'email', reportedAt: 'soon' }, 'reportedAt must be a valid ISO 8601 date string'],
    ['an extra field', { method: 'email', note: 'x' }, 'property note should not exist'],
  ];
  for (const [name, body, message] of cases) {
    const response = await report(incident.id, body);
    expect.soft({ name, status: response.status }).toEqual({ name, status: 400 });
    expect.soft(errorMessages(response.json), name).toContain(message);
  }
  expect((await incidentRow(incident.id)).status).toBe('open');

  expect((await report(incident.id, { method: 'phone', certinReference: 'FIRST' })).status).toBe(201);
  const first = await incidentRow(incident.id);
  for (let i = 0; i < 2; i++) {
    const again = await report(incident.id, { method: 'email', certinReference: 'SECOND' });
    expect({ status: again.status, message: again.json?.message }).toEqual({ status: 409, message: 'Only an open incident can be marked reported' });
  }
  expect(await incidentRow(incident.id)).toEqual(first);

  const closed = await recordIncident(staff.token, clientIp, { title: `E2E incident 164c ${hex()}` });
  await adminApi('POST', `/api/admin/incidents/${closed.id}/close`, { note: 'E2E: closing' }, staff.token, clientIp);
  const onClosed = await report(closed.id, { method: 'email' });
  expect({ status: onClosed.status, message: onClosed.json?.message }).toEqual({ status: 409, message: 'Only an open incident can be marked reported' });
  const unknown = await report(randomUUID(), { method: 'email' });
  expect({ status: unknown.status, message: unknown.json?.message }).toEqual({ status: 404, message: 'Incident not found' });

  expect((await auditRowsWhere({ action: 'incident.reported', targetId: incident.id })).map((a) => a.metadata)).toEqual([{ method: 'phone' }]);
  expect(await auditRowsWhere({ action: 'incident.reported', targetId: closed.id })).toEqual([]);
});

// ---------------------------------------------------------------- Notes and closing

test('ADMOPS-166 add notes', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 166 ${hex()}` });
  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  const card = cardTitled(page, 'Notes');
  await expect(
    card.getByText('New findings, updates sent to CERT-In, customers told. Notes cannot be edited or deleted; correct with a new one.', { exact: true }),
  ).toBeVisible();
  const box = page.getByRole('textbox', { name: 'New note' });
  const add = page.getByRole('button', { name: 'Add note' });
  await expect(add).toBeDisabled();
  await box.fill('   ');
  await expect(add).toBeDisabled();

  await box.fill('First finding\nSecond line of it');
  await add.click();
  await expect(card.locator('li')).toHaveCount(1);
  await expect(box).toHaveValue('');
  await box.fill('A later note');
  await add.click();
  await expect(card.locator('li')).toHaveCount(2);

  const notes = (await adminApi<{ notes: { createdAt: string; note: string }[] }>('GET', `/api/admin/incidents/${incident.id}`, undefined, staff.token, clientIp)).notes;
  expect(notes.map((n) => n.note)).toEqual(['First finding\nSecond line of it', 'A later note']);
  const items = card.locator('li');
  await expect(items.nth(0).locator('div')).toHaveText(istAndUtc(notes[0].createdAt));
  await expect(items.nth(0).locator('p')).toHaveText('First finding\nSecond line of it');
  expect(await items.nth(0).locator('p').innerText()).toBe('First finding\nSecond line of it');
  await expect(items.nth(1).locator('p')).toHaveText('A later note');

  const audit = await auditRowsWhere({ action: 'incident.note_added', targetId: incident.id });
  expect(audit.map((a) => ({ label: a.target_label, actor: a.actor_email }))).toEqual([
    { label: incident.title, actor: staff.account.email },
    { label: incident.title, actor: staff.account.email },
  ]);
});

test('ADMOPS-170 close after reporting', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 170 ${hex()}` });
  await adminApi('POST', `/api/admin/incidents/${incident.id}/report`, { method: 'portal', certinReference: 'CERTIN-170' }, staff.token, clientIp);
  const reported = await incidentRow(incident.id);

  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  await page.getByRole('textbox', { name: 'New note' }).fill('Closing: CERT-In acknowledged');
  await page.getByRole('button', { name: 'Close with this note' }).click();
  const banner = outcomeBanner(page);
  await expect(banner).toContainText('after reporting');
  const row = await incidentRow(incident.id);
  await expect(banner).toHaveText(`Closed ${istAndUtc(row.closed_at!)} after reporting.`);
  expect(row).toMatchObject({
    status: 'closed',
    closed_by: staff.account.userId,
    reported_at: reported.reported_at,
    reported_by: reported.reported_by,
    report_method: 'portal',
    certin_reference: 'CERTIN-170',
  });
  expect((await auditRowsWhere({ action: 'incident.closed', targetId: incident.id })).map((a) => a.metadata)).toEqual([{ wasReported: true }]);
});

test('ADMOPS-171 closing twice is refused and adds no note', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 171 ${hex()}` });
  await adminApi('POST', `/api/admin/incidents/${incident.id}/close`, { note: 'E2E: first close' }, staff.token, clientIp);
  const notes = () => sql(`SELECT id FROM security_incident_notes WHERE incident_id = $1`, [incident.id]);
  const before = await notes();
  expect(before).toHaveLength(1);

  const close = (id: string) => adminRequest('POST', `/api/admin/incidents/${id}/close`, { token: staff.token, ip: clientIp, body: { note: 'again' } });
  const again = await close(incident.id);
  expect({ status: again.status, message: again.json?.message }).toEqual({ status: 409, message: 'This incident is already closed' });
  expect(await notes()).toEqual(before);
  const unknown = await close(randomUUID());
  expect({ status: unknown.status, message: unknown.json?.message }).toEqual({ status: 404, message: 'Incident not found' });
  expect(await auditRowsWhere({ action: 'incident.closed', targetId: incident.id })).toHaveLength(1);
});

// ---------------------------------------------------------------- Reminders

test('ADMOPS-175 the 4-hour reminder is stamped once while the incident is open', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const noticedAt = Date.now() - 4 * HOUR + 8_000;
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 175 ${hex()}`, noticedAt: new Date(noticedAt).toISOString() });
  expect((await reminderRow(incident.id)).reminder_4h_at).toBeNull();
  await sleep(Math.max(0, noticedAt + 4 * HOUR + 1000 - Date.now()));

  await runJobNow('incident-reminders');
  const stamped = await reminderRow(incident.id);
  expect(stamped.reminder_4h_at).not.toBeNull();
  expect(stamped.reminder_5h_at).toBeNull();
  // Account email is on in this stack, so the reminders reached every staff member.
  expect(stamped.reminder_email_failed).toBe(false);
  const subject = `2 hours left to report: ${incident.title}`;
  const mail = await waitForMail(staff.account.email, { subjectIncludes: subject });
  expect(mail.text).toContain('email incident@cert-in.org.in, phone 1800-11-4949');
  expect(mail.text).toContain(`/incidents/${incident.id}`);

  await runJobNow('incident-reminders');
  const later = await reminderRow(incident.id);
  expect(later.reminder_4h_at!.getTime()).toBe(stamped.reminder_4h_at!.getTime());
  expect(later.reminder_5h_at).toBeNull();
  expect(await mailsTo(staff.account.email, { subjectIncludes: subject })).toHaveLength(1);
});

test('ADMOPS-177 no reminders for reported or late-recorded incidents', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const noticedAt = Date.now() - 4 * HOUR + 8_000;
  const reported = await recordIncident(staff.token, clientIp, { title: `E2E incident 177r ${hex()}`, noticedAt: new Date(noticedAt).toISOString() });
  await adminApi('POST', `/api/admin/incidents/${reported.id}/report`, { method: 'email' }, staff.token, clientIp);
  await sleep(Math.max(0, noticedAt + 4 * HOUR + 1000 - Date.now()));
  // Control: one still open, recorded before its 4-hour mark, is reminded by the same run.
  const control = await recordIncident(staff.token, clientIp, {
    title: `E2E incident 177o ${hex()}`,
    noticedAt: new Date(Date.now() - 4 * HOUR + 3_000).toISOString(),
  });
  const late = await recordIncident(staff.token, clientIp, { title: `E2E incident 177l ${hex()}`, noticedAt: new Date(Date.now() - 7 * HOUR).toISOString() });
  try {
    await sleep(4000);
    await runJobNow('incident-reminders');
    await eventually(() => reminderRow(control.id), (row) => row.reminder_4h_at !== null);
    for (const id of [reported.id, late.id]) {
      const row = await reminderRow(id);
      expect({ id, four: row.reminder_4h_at, five: row.reminder_5h_at }).toEqual({ id, four: null, five: null });
    }
  } finally {
    await settle(staff.token, clientIp, late.id);
    await settle(staff.token, clientIp, control.id);
  }
});

// ---------------------------------------------------------------- Incident times

test('ADMOPS-179 the noticed time defaults to when the page opened, not when "Record incident" is clicked', async ({ page, clientIp }) => {
  test.slow();
  const staff = await signedInStaff(page, clientIp);
  // The page is opened an hour ago (by its clock), at 40 seconds past a minute.
  const opened = floorMinute(Date.now() - HOUR) + 40_000;
  await page.clock.install({ time: opened });
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const field = page.getByLabel('When it was noticed (your time)');
  await expect(field).toHaveValue(await localInputValue(page, opened));
  expect(await field.inputValue()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

  const title = `E2E incident 179 ${hex()}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('checkbox', { name: '(iii) Unauthorised access of IT systems/data' }).check();
  await page.clock.setSystemTime(Date.now());
  const clicked = Date.now();
  await page.getByRole('button', { name: 'Record incident' }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const row = await incidentRow(id);
  expect(row.noticed_at.getTime()).toBe(floorMinute(opened));
  expect(clicked - row.noticed_at.getTime()).toBeGreaterThan(HOUR);
  await expect(deadlineBanner(page).locator('span').first()).toHaveText(/^(4 h 59|5 h 0) min left$/);

  // A page left open overnight: seven hours by its clock.
  await page.clock.setSystemTime(Date.now() - 7 * HOUR);
  await openAdminPage(page, '/incidents', RECORD_HEADING);
  const stale = `E2E incident 179 stale ${hex()}`;
  await page.getByLabel('Title', { exact: true }).fill(stale);
  await page.getByRole('checkbox', { name: '(iii) Unauthorised access of IT systems/data' }).check();
  await page.clock.setSystemTime(Date.now());
  await page.getByRole('button', { name: 'Record incident' }).click();
  await expect(page.getByRole('heading', { name: stale, level: 1 })).toBeVisible();
  const staleId = new URL(page.url()).pathname.split('/').pop()!;
  try {
    const staleRow = await incidentRow(staleId);
    expect(Date.now() - staleRow.noticed_at.getTime()).toBeGreaterThan(7 * HOUR - MINUTE);
    const banner = deadlineBanner(page);
    await expect(banner.locator('span').first()).toHaveText(/^Overdue by 1 h [01] min$/);
    await expect(banner).toHaveClass(/border-destructive\/30/);
    await page.getByRole('link', { name: 'Incidents' }).filter({ has: page.locator('svg.lucide-arrow-left') }).click();
    await expect(incidentListRow(page, stale)).toHaveClass(/bg-destructive\/5/);
    await expect(page.getByRole('alert').filter({ hasText: 'past the 6-hour deadline' })).toBeVisible();
    await runJobNow('incident-reminders');
    const after = (await reminderRow(staleId)) as ReminderRow;
    expect({ four: after.reminder_4h_at, five: after.reminder_5h_at }).toEqual({ four: null, five: null });
  } finally {
    await settle(staff.token, clientIp, staleId);
  }
});

test('ADMOPS-180 "Mark reported" defaults to when the incident page opened', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, {
    title: `E2E incident 180 ${hex()}`,
    noticedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  });
  const opened = floorMinute(Date.now() - 40 * MINUTE) + 5_000;
  await page.clock.install({ time: opened });
  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  await expect(page.getByLabel('When (your time)')).toHaveValue(await localInputValue(page, opened));

  await page.clock.setSystemTime(Date.now());
  await page.getByRole('button', { name: 'Mark reported' }).click();
  await expect(outcomeBanner(page)).toHaveText(`Reported to CERT-In ${istAndUtc(new Date(floorMinute(opened)))} by email.`);
  const row = await incidentRow(incident.id);
  expect(row.reported_at!.getTime()).toBe(floorMinute(opened));
  const [audit] = await auditRowsWhere({ action: 'incident.reported', targetId: incident.id });
  const gap = audit.created_at.getTime() - row.reported_at!.getTime();
  expect(gap).toBeGreaterThan(39 * MINUTE);
  expect(gap).toBeLessThan(43 * MINUTE);
});

test('ADMOPS-181 recording and reporting from a browser outside IST', async ({ browser }) => {
  test.slow();
  const la = await fixedLocaleContext(browser, { locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  const kolkata = await fixedLocaleContext(browser, { timezoneId: 'Asia/Kolkata' });
  const laPage = await la.context.newPage();
  const inPage = await kolkata.context.newPage();
  const ids: string[] = [];
  let laStaff: { token: string } | undefined;
  try {
    laStaff = await signedInStaff(laPage, la.ip, 'Lee Angeles');
    await signedInStaff(inPage, kolkata.ip, 'Kiran Kolkata');
    const NOTICED = '10 Nov 2026, 23:00 IST (17:30 UTC)';
    const BY = '11 Nov 2026, 05:00 IST (23:30 UTC)';
    const REPORTED = 'Reported to CERT-In 10 Nov 2026, 23:45 IST (18:15 UTC) by email.';

    const record = async (page: Page, title: string, noticed: string, reported: string) => {
      await openAdminPage(page, '/incidents', RECORD_HEADING);
      await page.getByLabel('When it was noticed (your time)').fill(noticed);
      await page.getByLabel('Title', { exact: true }).fill(title);
      await page.getByRole('checkbox', { name: '(iii) Unauthorised access of IT systems/data' }).check();
      await page.getByRole('button', { name: 'Record incident' }).click();
      await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      const id = new URL(page.url()).pathname.split('/').pop()!;
      ids.push(id);
      return { id, title, reported };
    };
    const show = async (page: Page, incident: { id: string; title: string }, open: boolean) => {
      await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
      await expect(page.getByText(`Noticed ${NOTICED}`, { exact: true })).toBeVisible();
      if (open) await expect(deadlineBanner(page)).toContainText(`to report to CERT-In, by ${BY}`);
      else await expect(outcomeBanner(page)).toHaveText(REPORTED);
      await expect(page.locator('code').filter({ hasText: 'chumbaq-collect-logs' })).toContainText('--from 2026-11-09T17:30:00Z');
      await openAdminPage(page, '/incidents', RECORD_HEADING);
      const cells = incidentListRow(page, incident.title).locator('td');
      await expect(cells.nth(1)).toHaveText(NOTICED);
      await expect(cells.nth(2)).toHaveText(BY);
    };
    const markReported = async (page: Page, incident: { id: string; title: string; reported: string }) => {
      await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
      await page.getByLabel('When (your time)').fill(incident.reported);
      await page.getByRole('button', { name: 'Mark reported' }).click();
      await expect(outcomeBanner(page)).toHaveText(REPORTED);
    };

    const fromLa = await record(laPage, `E2E incident 181 LA ${hex()}`, '2026-11-10T09:30', '2026-11-10T10:15');
    let row = await incidentRow(fromLa.id);
    expect(row.noticed_at.toISOString()).toBe('2026-11-10T17:30:00.000Z');
    const detail = await adminApi<{ deadline: string }>('GET', `/api/admin/incidents/${fromLa.id}`, undefined, laStaff.token, la.ip);
    expect(detail.deadline).toBe('2026-11-10T23:30:00.000Z');
    await show(laPage, fromLa, true);
    await show(inPage, fromLa, true);

    await markReported(laPage, fromLa);
    row = await incidentRow(fromLa.id);
    expect(row.reported_at!.toISOString()).toBe('2026-11-10T18:15:00.000Z');
    await show(laPage, fromLa, false);
    await show(inPage, fromLa, false);

    const fromIn = await record(inPage, `E2E incident 181 IN ${hex()}`, '2026-11-10T23:00', '2026-11-10T23:45');
    await markReported(inPage, fromIn);
    const second = await incidentRow(fromIn.id);
    expect(second.noticed_at.toISOString()).toBe('2026-11-10T17:30:00.000Z');
    expect(second.reported_at!.toISOString()).toBe('2026-11-10T18:15:00.000Z');
    await show(laPage, fromIn, false);
    await show(inPage, fromIn, false);

    const draft = await adminApi<{ body: string }>('GET', `/api/admin/incidents/${fromLa.id}/report-draft`, undefined, laStaff.token, la.ip);
    expect(draft.body).toContain('Detection date & time (dd/mm/yyyy hh:mm): 10/11/2026 23:00 IST');
    // The form's own fields are the browser's wall clock: a fresh LA page prefills LA time.
    await openAdminPage(laPage, '/incidents', RECORD_HEADING);
    const prefilled = await laPage.getByLabel('When it was noticed (your time)').inputValue();
    const expectedLa = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(new Date())
      .replace(' ', 'T');
    expect(prefilled.slice(0, 13)).toBe(expectedLa.slice(0, 13));
  } finally {
    for (const id of ids) if (laStaff) await settle(laStaff.token, la.ip, id);
    await la.context.close();
    await kolkata.context.close();
  }
});

// ---------------------------------------------------------------- Audit log export

test('ADMOPS-184 export uses the applied filters, not the unapplied draft', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actorA = uniqueEmail('seed-184a');
  const actorB = uniqueEmail('seed-184b');
  await seedAuditRows([1, 2, 3].map((n) => ({ actorEmail: actorA, reason: `E2E 184 A row ${n}` })));
  await seedAuditRows([1, 2].map((n) => ({ actorEmail: actorB, reason: `E2E 184 B row ${n}` })));
  const isExport = (r: Request) => new URL(r.url()).pathname === '/api/admin/audit-logs/export';
  const exports = () => auditRowsWhere({ actorEmail: staff.account.email, action: 'audit_log.exported' });

  await openAdminPage(page, '/audit-log', 'Audit log');
  await page.getByLabel('Actor email').fill(actorA);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(new RegExp(`actorEmail=${encodeURIComponent(actorA).replace(/\./g, '\\.')}`));
  await expect(auditTableRows(page)).toHaveCount(3);
  const urlBefore = page.url();

  await page.getByLabel('Actor email').fill(actorB);
  const [request, download] = await Promise.all([
    page.waitForRequest(isExport),
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(Object.fromEntries(new URL(request.url()).searchParams)).toEqual({ actorEmail: actorA });
  await expect(toastItem(page, 'Exported 3 rows')).toBeVisible();
  const file = await readDownload(download);
  expect(csvRecords(file.text).map((r) => r.actor_email)).toEqual([actorA, actorA, actorA]);
  const [first] = await eventually(exports, (rows) => rows.length === 1);
  expect(first.metadata).toMatchObject({ filters: { actorEmail: actorA }, rowCount: 3 });
  await expect(page.getByLabel('Actor email')).toHaveValue(actorB);
  expect(page.url()).toBe(urlBefore);
  expect(new Set(await auditTableRows(page).evaluateAll((rows) => rows.map((r) => r.querySelectorAll('td')[1]?.textContent?.trim())))).toEqual(
    new Set([actorA]),
  );

  // Nothing applied; an action ticked in the draft only: the export carries no filter.
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page).toHaveURL(/\/audit-log$/);
  await page.getByRole('button', { name: 'Filter by action' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Incident recorded', exact: true }).click();
  await page.keyboard.press('Escape');
  const [unfiltered] = await Promise.all([page.waitForRequest(isExport), page.getByRole('button', { name: 'Export CSV' }).click()]);
  expect([...new URL(unfiltered.url()).searchParams.keys()]).toEqual([]);
  const [second] = await eventually(exports, (rows) => rows.length === 2);
  expect(second.metadata).toMatchObject({ filters: {} });
  await expect(page.getByRole('button', { name: 'Filter by action' })).toHaveText('Incident recorded');
  // A second toast, beside the first export's.
  await expect(page.getByText(/^Exported (the newest )?[\d,]+ rows$/)).toHaveCount(2);
});

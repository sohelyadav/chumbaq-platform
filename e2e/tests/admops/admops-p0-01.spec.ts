import { randomUUID } from 'crypto';
import type { Browser, Page, Request } from '@playwright/test';
import { adminApi } from '../../support/admin';
import { createAccount, newClientIp, uniqueEmail } from '../../support/api';
import { allowClipboard, fixedLocaleContext, readClipboard, readDownload } from '../../support/browser-tools';
import { expect, test } from '../../support/fixtures';
import { mailsTo, waitForMail } from '../../support/mailbox';
import {
  adminApiBase,
  adminRequest,
  admopsRoutes,
  alarms,
  auditRowsWhere,
  auditTableRows,
  comparableError,
  csvRecords,
  customerApiBase,
  customerRequest,
  eventually,
  floorMinute,
  hex,
  incidentByTitle,
  incidentRow,
  istAndUtc,
  makeStaffSignInStale,
  makeSuperAdminAccount,
  openAdminPage,
  postAlarm,
  recordIncident,
  seedAuditRows,
  seedTrapAccount,
  seedTrapKey,
  sha256Hex,
  signedInStaff,
  sleep,
  sql,
  startAlarmTokenAdminApi,
  toastItem,
  viewAsToken,
  withDb,
  writesFor,
  type ExtraAdminApi,
} from '../../support/areas/admops';

/**
 * Staff operations: the audit log (list, filters, export), platform health, incidents,
 * alarms, the localhost alarm route server scripts call, and traps.
 *
 * Tests in this file run one after another in one worker, in the order written. The
 * incident register and the security contact are platform-wide, so the report-draft case
 * (no contact saved) comes before the case that saves one.
 */

const ENROLMENT_ONLY = 'Finish setting up your sign-in methods first.';
const REAUTH = 'Confirm it is you to continue.';
const INVALID_LOGIN = 'Invalid email or password';
const INVALID_KEY = 'Invalid or expired API key';
const FORGOT_PASSWORD = 'If that address has an account, a link to reset the password is on its way.';
const BEFORE_TO = 'from must be before to';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Holds a page's requests matching `test` for `ms` before letting them through. */
async function delayRequests(page: Page, url: string | RegExp, ms = 1200, method?: string): Promise<void> {
  await page.route(url, async (route) => {
    if (!method || route.request().method() === method) await sleep(ms);
    await route.fallback();
  });
}

const isAuditList = (request: Request) => new URL(request.url()).pathname === '/api/admin/audit-logs';

async function applyAuditFilters(page: Page, filters: { actorEmail?: string; from?: string; to?: string; actions?: string[] }): Promise<Request> {
  if (filters.actions?.length) {
    await page.getByRole('button', { name: 'Filter by action' }).click();
    for (const action of filters.actions) {
      await page.getByRole('menuitemcheckbox', { name: action, exact: true }).click();
    }
    await page.keyboard.press('Escape');
  }
  if (filters.actorEmail !== undefined) await page.getByLabel('Actor email').fill(filters.actorEmail);
  if (filters.from !== undefined) await page.getByLabel('From', { exact: true }).fill(filters.from);
  if (filters.to !== undefined) await page.getByLabel('To (inclusive)').fill(filters.to);
  const [request] = await Promise.all([
    page.waitForRequest((r) => isAuditList(r) && new URL(r.url()).searchParams.get('actorEmail') !== null),
    page.getByRole('button', { name: 'Apply filters' }).click(),
  ]);
  return request;
}

/** The text of one column (0-based) of every audit table row. */
async function auditColumn(page: Page, index: number): Promise<string[]> {
  return auditTableRows(page).evaluateAll(
    (rows, i) => rows.map((row) => (row.querySelectorAll('td')[i]?.textContent ?? '').trim()),
    index,
  );
}

async function exportFromPage(page: Page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  return readDownload(download);
}

// ---------------------------------------------------------------- Access

test('ADMOPS-005 every ADMOPS admin route refuses requests without a staff token', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const viewAs = await viewAsToken(staff.token, tenant.userId, newClientIp());
  // Both tokens are good where they belong.
  expect((await customerRequest('GET', '/api/auth/me', { token: tenant.accessToken, ip: newClientIp() })).status).toBe(200);
  expect((await customerRequest('GET', '/api/auth/me', { token: viewAs, ip: newClientIp() })).status).toBe(200);

  const marker = `e2e-005-${hex()}`;
  const callers = [
    { name: 'no token', token: undefined, ip: newClientIp() },
    { name: 'customer token', token: tenant.accessToken, ip: newClientIp() },
    { name: 'view-as token', token: viewAs, ip: newClientIp() },
  ];
  const before = await writesFor(marker, callers.map((c) => c.ip));
  const answers: string[] = [];
  for (const caller of callers) {
    for (const route of admopsRoutes(marker)) {
      const response = await adminRequest(route.method, route.path, { token: caller.token, ip: caller.ip, body: route.body });
      answers.push(`${caller.name} ${route.method} ${route.path.replace(/[0-9a-f-]{36}/, ':id')} ${response.status}`);
    }
  }
  expect(answers.filter((answer) => !answer.endsWith(' 401'))).toEqual([]);
  expect(answers).toHaveLength(3 * 18);
  expect(await writesFor(marker, callers.map((c) => c.ip))).toEqual(before);
  // The staff token itself is let through, so the refusals above are about the token.
  expect((await adminRequest('GET', '/api/admin/incidents', { token: staff.token, ip: clientIp })).status).toBe(200);
});

test('ADMOPS-006 an enrolment-only staff session is refused on the operations routes', async ({ clientIp }) => {
  const staff = await makeSuperAdminAccount(clientIp);
  const login = await adminRequest('POST', '/api/staff/auth/login', { ip: clientIp, body: { email: staff.email, password: staff.password } });
  expect(login.status).toBe(200);
  expect(login.json.data.step).toBe('enrol');
  const token = login.json.data.accessToken as string;
  const marker = `e2e-006-${hex()}`;

  const routes = [
    { method: 'GET', path: '/api/admin/audit-logs' },
    { method: 'GET', path: '/api/admin/health' },
    { method: 'GET', path: '/api/admin/incidents' },
    { method: 'POST', path: '/api/admin/incidents', body: { types: ['iii'], title: marker } },
    { method: 'GET', path: '/api/admin/tripwires' },
  ];
  for (const route of routes) {
    const response = await adminRequest(route.method, route.path, { token, ip: clientIp, body: route.body });
    expect.soft({ route: `${route.method} ${route.path}`, status: response.status, message: response.json?.message }).toEqual({
      route: `${route.method} ${route.path}`,
      status: 403,
      message: ENROLMENT_ONLY,
    });
  }
  expect(await incidentByTitle(marker)).toBeUndefined();
});

test('ADMOPS-009 the audit log has no write routes', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-009');
  const [id] = await seedAuditRows([{ actorEmail: actor, reason: 'E2E: must survive' }]);

  const statuses: Record<string, number> = {};
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    statuses[`${method} /api/admin/audit-logs`] = (await adminRequest(method, '/api/admin/audit-logs', { token: staff.token, ip: clientIp, body: method === 'DELETE' ? undefined : {} })).status;
  }
  statuses['DELETE /api/admin/audit-logs/:id'] = (await adminRequest('DELETE', `/api/admin/audit-logs/${id}`, { token: staff.token, ip: clientIp })).status;
  expect(statuses).toEqual({
    'POST /api/admin/audit-logs': 404,
    'PUT /api/admin/audit-logs': 404,
    'PATCH /api/admin/audit-logs': 404,
    'DELETE /api/admin/audit-logs': 404,
    'DELETE /api/admin/audit-logs/:id': 404,
  });
  expect((await auditRowsWhere({ actorEmail: actor })).map((row) => row.id)).toEqual([id]);
});

// ---------------------------------------------------------------- Audit log page

test('ADMOPS-010 audit log loads newest first with its columns', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-010');
  const now = Date.now();
  const times = [3, 2, 1].map((minutes) => new Date(now - minutes * 60_000).toISOString());
  await seedAuditRows(times.map((createdAt, i) => ({ actorEmail: actor, createdAt, reason: `E2E 010 row ${i + 1}` })));

  await openAdminPage(page, '/audit-log', 'Audit log');
  await applyAuditFilters(page, { actorEmail: actor });
  await expect(auditTableRows(page)).toHaveCount(3);

  await expect(page.getByRole('columnheader')).toHaveText(['Time', 'Actor', 'Action', 'Target', 'Reason', 'IP']);
  expect(await auditColumn(page, 4)).toEqual(['E2E 010 row 3', 'E2E 010 row 2', 'E2E 010 row 1']);
  // MMM d, yyyy HH:mm in the browser's own time zone.
  const expectedTimes = await page.evaluate(
    ([isos, months]) =>
      (isos as string[]).map((iso) => {
        const d = new Date(iso);
        const two = (n: number) => String(n).padStart(2, '0');
        return `${(months as string[])[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
      }),
    [[...times].reverse(), MONTHS],
  );
  expect(await auditColumn(page, 0)).toEqual(expectedTimes);
  expect(await auditColumn(page, 1)).toEqual([actor, actor, actor]);

  await expect(page.getByText('Applied filters, newest first, up to 10,000 rows. Each export is recorded here.', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Dates are in your timezone. A staff member's views of one tenant are recorded at most once every 10 minutes.",
      { exact: true },
    ),
  ).toBeVisible();
});

test('ADMOPS-015 audit text is shown as text, never as markup', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const reason = '<img src=x onerror="window.__xss=1">';
  const label = '<b>bold</b>';
  const actor = `<script>alert(1)</script>-${hex()}@x.test`;
  await seedAuditRows([{ actorEmail: actor, reason, targetLabel: label, targetType: 'user' }]);

  await openAdminPage(page, '/audit-log', 'Audit log');
  await applyAuditFilters(page, { actorEmail: actor });
  await expect(auditTableRows(page)).toHaveCount(1);
  const row = auditTableRows(page).first();
  await expect(row.locator('td').nth(1)).toHaveText(actor);
  await expect(row.locator('td').nth(3)).toHaveText(label);
  await expect(row.locator('td').nth(4)).toHaveText(reason);
  await expect(page.locator('table img')).toHaveCount(0);
  await expect(page.locator('table b')).toHaveCount(0);
  await expect(page.locator('table script')).toHaveCount(0);
  await sleep(500);
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

async function checkDateRange(
  browser: Browser,
  timezoneId: string,
  instants: string[],
  expected: { from: string; to: string },
): Promise<void> {
  const { context, ip } = await fixedLocaleContext(browser, { timezoneId });
  try {
    const page = await context.newPage();
    await signedInStaff(page, ip);
    const actor = uniqueEmail('seed-029');
    await seedAuditRows(instants.map((createdAt) => ({ actorEmail: actor, createdAt, reason: `at ${createdAt}` })));

    await openAdminPage(page, '/audit-log', 'Audit log');
    const request = await applyAuditFilters(page, { actorEmail: actor, from: '2026-11-06', to: '2026-11-06' });
    const pageParams = new URL(page.url()).searchParams;
    expect({ from: pageParams.get('from'), to: pageParams.get('to') }).toEqual({ from: '2026-11-06', to: '2026-11-06' });
    const sent = new URL(request.url()).searchParams;
    expect({ from: sent.get('from'), to: sent.get('to') }).toEqual(expected);
    await expect(auditTableRows(page)).toHaveCount(2);
    expect(await auditColumn(page, 4)).toEqual([`at ${instants[2]}`, `at ${instants[1]}`]);
  } finally {
    await context.close();
  }
}

test('ADMOPS-029 date range From and To (inclusive) are days in the browser timezone', async ({ browser }) => {
  await checkDateRange(
    browser,
    'Asia/Kolkata',
    ['2026-11-05T18:29:59.000Z', '2026-11-05T18:30:00.000Z', '2026-11-06T18:29:59.000Z', '2026-11-06T18:30:00.000Z'],
    { from: '2026-11-05T18:30:00.000Z', to: '2026-11-06T18:30:00.000Z' },
  );
  // Los Angeles is on PST (UTC-8) after 1 November 2026.
  await checkDateRange(
    browser,
    'America/Los_Angeles',
    ['2026-11-06T07:59:59.000Z', '2026-11-06T08:00:00.000Z', '2026-11-07T07:59:59.000Z', '2026-11-07T08:00:00.000Z'],
    { from: '2026-11-06T08:00:00.000Z', to: '2026-11-07T08:00:00.000Z' },
  );
});

test('ADMOPS-042 time window: from inclusive, to exclusive, and from must be before to', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-042');
  const T = '2026-03-04T05:06:07.008Z';
  const T1 = '2026-03-04T05:06:08.008Z';
  const T2 = '2026-03-04T05:06:09.008Z';
  await seedAuditRows([T, T1, T2].map((createdAt) => ({ actorEmail: actor, createdAt, reason: createdAt })));

  const list = (from: string, to: string) =>
    adminRequest('GET', `/api/admin/audit-logs?${new URLSearchParams({ actorEmail: actor, from, to })}`, { token: staff.token, ip: clientIp });

  const window = await list(T, T2);
  expect(window.status).toBe(200);
  expect((window.json.data as { reason: string }[]).map((row) => row.reason)).toEqual([T1, T]);

  for (const [from, to] of [
    [T, T],
    [T2, T],
  ]) {
    const refused = await list(from, to);
    expect({ status: refused.status, message: refused.json?.message }).toEqual({ status: 400, message: BEFORE_TO });
  }
});

test('ADMOPS-045 Export CSV downloads the applied filter rows and says how many', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-045');
  await seedAuditRows([1, 2, 3].map((n) => ({ actorEmail: actor, reason: `E2E 045 row ${n}` })));

  await openAdminPage(page, '/audit-log', 'Audit log');
  await applyAuditFilters(page, { actorEmail: actor });
  await expect(auditTableRows(page)).toHaveCount(3);

  await delayRequests(page, /\/api\/admin\/audit-logs\/export/, 1500);
  const refreshed = page.waitForRequest(
    (r) => isAuditList(r) && new URL(r.url()).searchParams.get('actorEmail') === actor,
    { timeout: 15_000 },
  );
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: 'Export CSV' }).click();
      const busy = page.getByRole('button', { name: 'Exporting...' });
      await expect(busy).toBeVisible();
      await expect(busy).toBeDisabled();
    })(),
  ]);
  const startedAt = Date.now();
  const file = await readDownload(download);
  expect(file.filename).toMatch(/^chumbaq-audit-log-\d{8}-\d{6}\.csv$/);
  const [, d, t] = /^chumbaq-audit-log-(\d{8})-(\d{6})\.csv$/.exec(file.filename)!;
  const stamp = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`);
  expect(Math.abs(stamp - startedAt)).toBeLessThan(120_000);
  expect(csvRecords(file.text)).toHaveLength(3);

  const toast = toastItem(page, 'Exported 3 rows');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText('Exported 3 rows');
  await refreshed;
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
});

test('ADMOPS-046 each export is itself audited, with its filters and count', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-046');
  await seedAuditRows([1, 2, 3].map((n) => ({ actorEmail: actor, reason: `E2E 046 row ${n}` })));

  await openAdminPage(page, '/audit-log', 'Audit log');
  await applyAuditFilters(page, { actorEmail: actor });
  await expect(auditTableRows(page)).toHaveCount(3);
  const file = await exportFromPage(page);
  const records = csvRecords(file.text);
  expect(records.map((r) => r.action)).toEqual(['tenant.suspended', 'tenant.suspended', 'tenant.suspended']);
  await expect(toastItem(page, 'Exported 3 rows')).toBeVisible();

  await page.getByRole('button', { name: 'Clear' }).click();
  await applyAuditFilters(page, { actions: ['Audit log exported'], actorEmail: staff.account.email });
  await expect(auditTableRows(page)).toHaveCount(1);
  const row = auditTableRows(page).first();
  await expect(row.locator('td').nth(1)).toHaveText(staff.account.email);
  await expect(row.locator('td').nth(2)).toHaveText('Audit log exported');
  await expect(row.locator('td').nth(3)).toHaveText('-');
  await expect(row.locator('td').nth(5)).toHaveText(clientIp);

  const [audited] = await auditRowsWhere({ actorEmail: staff.account.email, action: 'audit_log.exported' });
  expect(audited.target_type).toBe('audit_log');
  expect(audited.ip_address).toBe(clientIp);
  expect(audited.metadata).toEqual({ filters: { actorEmail: actor }, rowCount: 3, truncated: false, rowCap: 10000 });
  expect(records.some((r) => r.id === audited.id)).toBe(false);
});

test('ADMOPS-049 export cells starting with = + - @ tab or CR are made inert', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-049');
  const values = ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd', 'safe=text'];
  await seedAuditRows(values.map((value) => ({ actorEmail: actor, reason: value, targetLabel: value })));
  await recordIncident(staff.token, clientIp, { title: '=1+1' });
  const trap = await adminRequest('POST', '/api/admin/tripwires/api-key', { token: staff.token, ip: clientIp, body: { label: '@trap' } });
  expect(trap.status).toBe(201);

  await openAdminPage(page, '/audit-log', 'Audit log');
  await applyAuditFilters(page, { actorEmail: actor });
  await expect(auditTableRows(page)).toHaveCount(values.length);
  const seeded = await exportFromPage(page);
  const inert = (value: string) => (value === 'safe=text' ? value : `'${value}`);
  const byReason = new Map(csvRecords(seeded.text).map((r) => [r.reason, r]));
  for (const value of values) {
    const record = byReason.get(inert(value));
    expect.soft(record, `a row whose reason is ${JSON.stringify(inert(value))}`).toBeDefined();
    expect.soft(record?.target_label).toBe(inert(value));
  }
  // The raw cells: quotes doubled inside quotes, a CR forces quoting, a tab does not.
  expect(seeded.text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  expect(seeded.text).toContain(`"'\rcmd"`);
  expect(seeded.text).toContain(`,'\tcmd,`);
  expect(seeded.text).toContain(',safe=text,');

  await page.getByRole('button', { name: 'Clear' }).click();
  await applyAuditFilters(page, { actorEmail: staff.account.email });
  const own = csvRecords((await exportFromPage(page)).text);
  expect(own.find((r) => r.action === 'incident.recorded')?.target_label).toBe(`'=1+1`);
  expect(own.find((r) => r.action === 'tripwire.created')?.target_label).toBe(`'@trap`);
});

// ---------------------------------------------------------------- Platform health

test('ADMOPS-067 a failed refresh replaces the last good state with unknown', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await openAdminPage(page, '/health', 'Platform health');
  await expect(page.getByText('Operational', { exact: true })).toBeVisible();

  let failed = 0;
  await page.route(/\/api\/admin\/health/, async (route) => {
    failed++;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) });
  });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Could not load platform health, so the current state is unknown.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText('Operational', { exact: true })).toHaveCount(0);
  // One retry before giving up.
  expect(failed).toBe(2);
});

// ---------------------------------------------------------------- Incidents

test('ADMOPS-075 record an incident with only the required fields', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const title = `E2E incident 075 ${hex()}`;
  const opening = floorMinute(Date.now());
  await openAdminPage(page, '/incidents', 'Incidents');
  const opened = floorMinute(Date.now());

  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('checkbox', { name: '(iii) Unauthorised access of IT systems/data' }).check();
  await delayRequests(page, /\/api\/admin\/incidents$/, 1200, 'POST');
  await page.getByRole('button', { name: 'Record incident' }).click();
  await expect(page.getByRole('button', { name: 'Recording...' })).toBeDisabled();

  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();

  const row = await incidentRow(id);
  expect(row).toMatchObject({
    status: 'open',
    types: ['iii'],
    recorded_by: staff.account.userId,
    how_noticed: '',
    summary: '',
    systems: '',
    tenant_ids: [],
    alert_id: null,
    title,
  });
  const noticed = row.noticed_at.getTime();
  expect(noticed % 60_000).toBe(0);
  expect(noticed).toBeGreaterThanOrEqual(opening);
  expect(noticed).toBeLessThanOrEqual(opened);

  const audit = await auditRowsWhere({ action: 'incident.recorded', targetId: id });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_email: staff.account.email,
    target_type: 'incident',
    target_label: title,
    metadata: { types: ['iii'] },
    ip_address: clientIp,
  });
});

test('ADMOPS-091 overdue incidents get a red row and a page alert with the count', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const overdueNow = async () => {
    const list = await adminApi<{ status: string; deadline: string }[]>('GET', '/api/admin/incidents', undefined, staff.token, clientIp);
    return list.filter((i) => i.status === 'open' && Date.parse(i.deadline) < Date.now()).length;
  };
  const sentence = (n: number) => `${n === 1 ? 'One incident is' : `${n} incidents are`} past the 6-hour deadline and not marked reported.`;

  const first = await recordIncident(staff.token, clientIp, {
    title: `E2E incident 091a ${hex()}`,
    noticedAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
  });
  const already = (await overdueNow()) - 1;
  await openAdminPage(page, '/incidents', 'Incidents');
  await expect(page.getByRole('alert').filter({ hasText: 'past the 6-hour deadline' })).toHaveText(sentence(already + 1));
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: first.title, exact: true }) });
  await expect(row).toHaveClass(/bg-destructive\/5/);
  await expect(row.locator('td').last()).toHaveText('Overdue by 1 h 0 min');

  await recordIncident(staff.token, clientIp, {
    title: `E2E incident 091b ${hex()}`,
    noticedAt: new Date(Date.now() - 6.5 * 3600_000).toISOString(),
  });
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'past the 6-hour deadline' })).toHaveText(sentence(already + 2));
});

// ---------------------------------------------------------------- Alarms

test('ADMOPS-103 five failed staff sign-ins raise "Failed staff sign-ins"', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp, 'Vic Viewer');
  const target = await makeSuperAdminAccount(newClientIp(), 'target');
  const attacker = newClientIp();
  const wrong = { email: target.email, password: 'not-the-password-1!' };
  for (let i = 0; i < 5; i++) {
    const refused = await adminRequest('POST', '/api/staff/auth/login', { ip: attacker, body: wrong });
    expect(refused.status).toBe(401);
  }
  const failures = await eventually(
    () => auditRowsWhere({ action: 'staff.sign_in_failed', targetLabel: target.email }),
    (rows) => rows.length >= 5,
  );
  expect(failures).toHaveLength(5);
  const byEmail = await eventually(() => alarms({ kind: 'staff.failed_sign_ins', key: `email:${target.email}` }), (rows) => rows.length > 0);
  const byIp = await eventually(() => alarms({ kind: 'staff.failed_sign_ins', key: `ip:${attacker}` }), (rows) => rows.length > 0);
  expect(byEmail.map((a) => ({ details: a.details, count: a.count }))).toEqual([{ details: { email: target.email, failures: 5 }, count: 1 }]);
  expect(byIp.map((a) => ({ details: a.details, count: a.count, ip: a.ip_address }))).toEqual([
    { details: { ip: attacker, failures: 5 }, count: 1, ip: attacker },
  ]);

  // A sixth (from another address, past the per-address limit) adds to the email's alarm.
  const second = newClientIp();
  expect((await adminRequest('POST', '/api/staff/auth/login', { ip: second, body: wrong })).status).toBe(401);
  await eventually(() => alarms({ kind: 'staff.failed_sign_ins', key: `email:${target.email}` }), (rows) => rows[0]?.count === 2);
  expect(await alarms({ kind: 'staff.failed_sign_ins', key: `email:${target.email}` })).toHaveLength(1);

  await openAdminPage(page, '/incidents', 'Incidents');
  const emailRow = page.getByRole('row').filter({ hasText: `email: ${target.email}, failures: 5` });
  await expect(emailRow).toContainText('Failed staff sign-ins');
  await expect(emailRow).toContainText('×2');
  const ipRow = page.getByRole('row').filter({ hasText: `ip: ${attacker}, failures: 5` });
  await expect(ipRow).toContainText('Failed staff sign-ins');
  await expect(ipRow.locator('td').nth(2)).toHaveText(attacker);

  // Control: a customer account (not staff) failing five times raises nothing.
  const customer = await createAccount(newClientIp(), 'customer');
  const elsewhere = newClientIp();
  for (let i = 0; i < 5; i++) {
    await adminRequest('POST', '/api/staff/auth/login', { ip: elsewhere, body: { email: customer.email, password: 'not-the-password-1!' } });
  }
  await sleep(3000);
  expect(await alarms({ key: `email:${customer.email}` })).toEqual([]);
  expect(await alarms({ key: `ip:${elsewhere}` })).toEqual([]);
  expect(await auditRowsWhere({ targetLabel: customer.email })).toEqual([]);
});

test('ADMOPS-109 without SECURITY_ALERT_TOKEN the internal alarm route does not exist', async () => {
  const key = `ubuntu@${hex()}`;
  const body = { kind: 'server.ssh_login', key, details: { user: 'ubuntu' }, ip: '203.0.113.7' };
  expect((await postAlarm(adminApiBase(), body)).status).toBe(404);
  expect((await postAlarm(adminApiBase(), body, { 'X-Security-Alert-Token': 'anything-at-all' })).status).toBe(404);
  expect(await alarms({ key })).toEqual([]);
});

test.describe('the internal alarm route with SECURITY_ALERT_TOKEN set', () => {
  let extra: ExtraAdminApi;

  test.beforeAll(async () => {
    extra = await startAlarmTokenAdminApi();
  });

  test.afterAll(async () => {
    await extra?.stop();
  });

  test('ADMOPS-110 with the token a server alarm is accepted and shown', async ({ page, clientIp }) => {
    const id = hex();
    const sent = [
      { kind: 'server.ssh_login', key: `ubuntu@${id}`, details: { user: 'ubuntu' }, ip: '203.0.113.7', label: 'Server sign-in (SSH)', text: 'user: ubuntu' },
      { kind: 'server.ssh_banned', key: `ban-${id}`, details: { jail: `sshd-${id}` }, ip: '198.51.100.23', label: 'Failed server sign-ins, address blocked', text: `jail: sshd-${id}` },
      { kind: 'server.files_changed', key: `aide-${id}`, details: { files: `/etc/e2e-${id}` }, ip: undefined, label: 'Server files changed', text: `files: /etc/e2e-${id}` },
    ];
    for (const alarm of sent) {
      const response = await postAlarm(
        extra.url,
        { kind: alarm.kind, key: alarm.key, details: alarm.details, ...(alarm.ip ? { ip: alarm.ip } : {}) },
        { 'X-Security-Alert-Token': extra.token },
      );
      expect({ status: response.status, body: response.json }).toEqual({ status: 202, body: { data: { accepted: true } } });
    }

    await signedInStaff(page, clientIp);
    await openAdminPage(page, '/incidents', 'Incidents');
    for (const alarm of sent) {
      const row = page.getByRole('row').filter({ hasText: alarm.text });
      await expect(row).toContainText(alarm.label);
      await expect(row.locator('td').nth(2)).toHaveText(alarm.ip ?? '-');
    }
  });

  test('ADMOPS-111 a wrong or missing alarm token is refused and records nothing', async ({ clientIp }) => {
    const key = `ubuntu@${hex()}`;
    const body = { kind: 'server.ssh_login', key, details: { user: 'ubuntu' } };
    const staff = await makeSuperAdminAccount(clientIp);
    const login = await adminRequest('POST', '/api/staff/auth/login', { ip: clientIp, body: { email: staff.email, password: staff.password } });
    const staffToken = login.json.data.accessToken as string;

    const variants: Record<string, Record<string, string>> = {
      'no token': {},
      'token plus x': { 'X-Security-Alert-Token': `${extra.token}x` },
      'empty token': { 'X-Security-Alert-Token': '' },
      'staff bearer': { Authorization: `Bearer ${staffToken}` },
    };
    for (const [name, headers] of Object.entries(variants)) {
      const response = await postAlarm(extra.url, body, headers);
      expect.soft({ name, status: response.status, message: response.json?.message }).toEqual({ name, status: 401, message: 'Invalid alarm token' });
    }
    expect(await alarms({ key })).toEqual([]);
  });

  test('ADMOPS-112 anything that came through a proxy is answered 404, even with the token', async () => {
    const key = `ubuntu@${hex()}`;
    const body = { kind: 'server.ssh_login', key, details: { user: 'ubuntu' } };
    const token = { 'X-Security-Alert-Token': extra.token };
    const variants: Record<string, Record<string, string>> = {
      'X-Forwarded-For': { ...token, 'X-Forwarded-For': '127.0.0.1' },
      'X-Real-IP': { ...token, 'X-Real-IP': '127.0.0.1' },
      'empty X-Forwarded-For': { ...token, 'X-Forwarded-For': '' },
    };
    for (const [name, headers] of Object.entries(variants)) {
      expect.soft({ name, status: (await postAlarm(extra.url, body, headers)).status }).toEqual({ name, status: 404 });
    }
    expect(await alarms({ key })).toEqual([]);
  });

  test('ADMOPS-115 the customer API does not serve the internal alarm route', async () => {
    const key = `ubuntu@${hex()}`;
    const response = await postAlarm(customerApiBase(), { kind: 'server.ssh_login', key, details: { user: 'ubuntu' } }, {
      'X-Security-Alert-Token': extra.token,
    });
    expect(response.status).toBe(404);
    expect(await alarms({ key })).toEqual([]);
    // The same request is accepted by the admin API that has the token.
    const accepted = await postAlarm(extra.url, { kind: 'server.ssh_login', key: `${key}-admin`, details: { user: 'ubuntu' } }, {
      'X-Security-Alert-Token': extra.token,
    });
    expect(accepted.status).toBe(202);
  });
});

// ---------------------------------------------------------------- Traps

test('ADMOPS-117 make a trap key: shown once, copy, done', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await openAdminPage(page, '/incidents', 'Incidents');
  await allowClipboard(page);
  const label = `E2E trap key 117 ${hex()}`;

  await page.getByLabel('Label (where you put it)').fill(label);
  await page.getByRole('button', { name: 'Make a trap key' }).click();
  await expect(page.getByText('Copy this key now. It is not shown again.', { exact: true })).toBeVisible();
  const code = page.locator('code').filter({ hasText: /^chumbaq_/ });
  const key = (await code.textContent())!.trim();
  expect(key).toMatch(/^chumbaq_[0-9a-f]{64}$/);
  await expect(page.getByLabel('Label (where you put it)')).toHaveValue('');
  const item = page.locator('li').filter({ hasText: label });
  await expect(item).toContainText(`Key ${label}`);
  await expect(item.getByRole('button', { name: 'Switch off' })).toBeVisible();

  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(toastItem(page, 'Copied')).toBeVisible();
  expect(await readClipboard(page)).toBe(key);

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText('Copy this key now. It is not shown again.', { exact: true })).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(key);
  expect(await page.content()).not.toContain(key);
  await page.reload();
  await expect(page.locator('li').filter({ hasText: label })).toBeVisible();
  expect(await page.content()).not.toContain(key);

  const [row] = await sql<Record<string, unknown>>(`SELECT * FROM security_tripwires WHERE label = $1`, [label]);
  expect(row.value_hash).toBe(sha256Hex(key));
  expect(JSON.stringify(row)).not.toContain(key);
});

test('ADMOPS-119 making a trap key is audited without the key', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const label = `E2E trap key 119 ${hex()}`;
  const created = await adminRequest('POST', '/api/admin/tripwires/api-key', { token: staff.token, ip: clientIp, body: { label } });
  expect(created.status).toBe(201);
  expect(Object.keys(created.json.data).sort()).toEqual(['id', 'key']);
  const { id, key } = created.json.data as { id: string; key: string };

  const audit = await auditRowsWhere({ action: 'tripwire.created', targetId: id });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ target_type: 'tripwire', target_label: label, metadata: { kind: 'api_key' }, actor_email: staff.account.email });
  expect(JSON.stringify(audit[0])).not.toContain(key);
  expect(JSON.stringify(audit[0])).not.toContain(key.slice('chumbaq_'.length));

  const list = await adminRequest('GET', '/api/admin/tripwires', { token: staff.token, ip: clientIp });
  const item = (list.json.data as Record<string, unknown>[]).find((t) => t.id === id);
  expect(item).toEqual({ id, kind: 'api_key', label, createdAt: expect.any(String), revokedAt: null });
  expect(list.text).not.toContain(key);
  expect(list.text).not.toContain(sha256Hex(key));
});

test('ADMOPS-120 make a trap account', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  await openAdminPage(page, '/incidents', 'Incidents');
  const label = `E2E trap account 120 ${hex()}`;
  const address = `Trap-${hex()}@E2E.example.test`;

  await page.getByLabel('Label (where you put it)').fill(label);
  await page.getByLabel('Trap address (for an account trap)').fill(address);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/admin/tripwires/account')),
    page.getByRole('button', { name: 'Make a trap account' }).click(),
  ]);
  expect(response.status()).toBe(201);
  await expect(page.getByLabel('Label (where you put it)')).toHaveValue('');
  await expect(page.getByLabel('Trap address (for an account trap)')).toHaveValue('');
  await expect(page.locator('li').filter({ hasText: label })).toContainText(`Account ${label}`);

  expect(await sql(`SELECT id FROM users WHERE lower(email) = lower($1)`, [address])).toEqual([]);
  const [row] = await sql<{ id: string; kind: string; value_hash: string }>(`SELECT id, kind, value_hash FROM security_tripwires WHERE label = $1`, [label]);
  expect(row).toMatchObject({ kind: 'account', value_hash: sha256Hex(address.toLowerCase()) });
  const [audit] = await auditRowsWhere({ action: 'tripwire.created', targetId: row.id });
  expect(audit).toMatchObject({ metadata: { kind: 'account' }, target_label: label, actor_email: staff.account.email });
  expect(JSON.stringify(audit)).not.toContain(address.toLowerCase());
});

test('ADMOPS-121 a trap address may not belong to an account, in any case', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const existing = await createAccount(newClientIp(), 'existing');
  await openAdminPage(page, '/incidents', 'Incidents');
  const label = `E2E trap account 121 ${hex()}`;

  await page.getByLabel('Label (where you put it)').fill(label);
  await page.getByLabel('Trap address (for an account trap)').fill(existing.email.toUpperCase());
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/admin/tripwires/account')),
    page.getByRole('button', { name: 'Make a trap account' }).click(),
  ]);
  expect(response.status()).toBe(409);
  const toast = toastItem(page, 'That did not work');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('That address belongs to an account; a trap must be an address nobody uses');
  await expect(page.getByLabel('Label (where you put it)')).toHaveValue(label);
  await expect(page.getByLabel('Trap address (for an account trap)')).toHaveValue(existing.email.toUpperCase());
  expect(await sql(`SELECT id FROM security_tripwires WHERE label = $1`, [label])).toEqual([]);
});

test('ADMOPS-125 switch off a trap', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const label = `E2E trap key 125 ${hex()}`;
  const { id } = await adminApi<{ id: string }>('POST', '/api/admin/tripwires/api-key', { label }, staff.token, clientIp);
  await openAdminPage(page, '/incidents', 'Incidents');

  const item = page.locator('li').filter({ hasText: label });
  await item.getByRole('button', { name: 'Switch off' }).click();
  await expect(item).toContainText('(off)');
  await expect(item.getByRole('button', { name: 'Switch off' })).toHaveCount(0);

  const [row] = await sql<{ revoked_at: Date | null }>(`SELECT revoked_at FROM security_tripwires WHERE id = $1`, [id]);
  expect(row.revoked_at).not.toBeNull();
  const audit = await auditRowsWhere({ action: 'tripwire.revoked', targetId: id });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ target_label: label, metadata: { kind: 'api_key' }, actor_email: staff.account.email, ip_address: clientIp });
});

test('ADMOPS-127 trap actions need a recent sign-in', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  const keyCalls: number[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('/api/admin/tripwires/api-key')) keyCalls.push(r.status());
  });
  const label = `E2E trap key 127 ${hex()}`;

  // Make a trap key: refused, cancelled, nothing made; then confirmed and resent.
  await makeStaffSignInStale(staff.account.userId);
  await openAdminPage(page, '/incidents', 'Incidents');
  await page.getByLabel('Label (where you put it)').fill(label);
  const refused = page.waitForResponse((r) => r.url().endsWith('/api/admin/tripwires/api-key'));
  await page.getByRole('button', { name: 'Make a trap key' }).click();
  const first = await refused;
  expect(first.status()).toBe(403);
  expect(((await first.json()) as { message: string }).message).toBe(REAUTH);
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toBeHidden();
  expect(await sql(`SELECT id FROM security_tripwires WHERE label = $1`, [label])).toEqual([]);

  await page.getByRole('button', { name: 'Make a trap key' }).click();
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Use passkey' }).click();
  await expect(page.getByText('Copy this key now. It is not shown again.', { exact: true })).toBeVisible();
  expect(keyCalls).toEqual([403, 403, 201]);
  expect(await sql(`SELECT id FROM security_tripwires WHERE label = $1`, [label])).toHaveLength(1);

  // Make a trap account, the same way.
  const accountLabel = `E2E trap account 127 ${hex()}`;
  await makeStaffSignInStale(staff.account.userId);
  await openAdminPage(page, '/incidents', 'Incidents');
  await page.getByLabel('Label (where you put it)').fill(accountLabel);
  await page.getByLabel('Trap address (for an account trap)').fill(`trap-${hex()}@e2e.example.test`);
  const accountRefused = page.waitForResponse((r) => r.url().endsWith('/api/admin/tripwires/account'));
  await page.getByRole('button', { name: 'Make a trap account' }).click();
  expect((await accountRefused).status()).toBe(403);
  await expect(reauth).toBeVisible();
  const accountMade = page.waitForResponse((r) => r.url().endsWith('/api/admin/tripwires/account') && r.status() === 201);
  await reauth.getByRole('button', { name: 'Use passkey' }).click();
  await accountMade;
  await expect(page.locator('li').filter({ hasText: accountLabel })).toBeVisible();

  // Switch off, the same way.
  await makeStaffSignInStale(staff.account.userId);
  await openAdminPage(page, '/incidents', 'Incidents');
  const item = page.locator('li').filter({ hasText: label });
  const revokeRefused = page.waitForResponse((r) => /\/api\/admin\/tripwires\/[0-9a-f-]+\/revoke$/.test(r.url()));
  await item.getByRole('button', { name: 'Switch off' }).click();
  expect((await revokeRefused).status()).toBe(403);
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Use passkey' }).click();
  await expect(item).toContainText('(off)');
});

test('ADMOPS-130 a trap key gets the same refusal as any wrong key and raises an alarm', async () => {
  const label = `E2E trap key 130 ${hex()}`;
  const trap = await seedTrapKey(label);
  const a = newClientIp();
  const b = newClientIp();
  const body = { projectId: randomUUID(), eventName: 'e2e_event' };

  const trapped = await customerRequest('POST', '/api/events/track', { ip: a, body, headers: { 'X-Api-Key': trap.key } });
  const random = await customerRequest('POST', '/api/events/track', {
    ip: b,
    body,
    headers: { 'X-Api-Key': `chumbaq_${hex(32)}` },
  });
  expect(trapped.status).toBe(401);
  expect(trapped.json.message).toBe(INVALID_KEY);
  expect(comparableError(trapped.json)).toEqual(comparableError(random.json));
  expect(random.status).toBe(401);

  const [alarm] = await eventually(() => alarms({ kind: 'tripwire.api_key', key: trap.id }), (rows) => rows.length > 0);
  expect({ details: alarm.details, ip: alarm.ip_address }).toEqual({ details: { label, route: 'POST /api/events/track' }, ip: a });
  await sleep(1500);
  expect(await sql(`SELECT id FROM security_alerts WHERE ip_address = $1`, [b])).toEqual([]);
});

test('ADMOPS-132 a switched-off trap key raises nothing', async () => {
  const trap = await seedTrapKey(`E2E trap key 132 ${hex()}`, true);
  const response = await customerRequest('POST', '/api/events/track', {
    ip: newClientIp(),
    body: { projectId: randomUUID(), eventName: 'e2e_event' },
    headers: { 'X-Api-Key': trap.key },
  });
  expect({ status: response.status, message: response.json?.message }).toEqual({ status: 401, message: INVALID_KEY });
  await sleep(3000);
  expect(await alarms({ key: trap.id })).toEqual([]);
});

/** A trap address nobody has, its trap row, and the address in mixed case. */
async function trapAddress(caseId: string) {
  const address = `trap-${caseId}-${hex()}@e2e.example.test`;
  const label = `E2E trap account ${caseId} ${hex()}`;
  const { id } = await seedTrapAccount(label, address);
  const mixed = address.replace(/^trap/, 'Trap').replace('@e2e.example.test', '@E2E.Example.Test');
  return { address, label, id, mixed };
}

test('ADMOPS-133 a trap address on customer sign-in', async () => {
  const trap = await trapAddress('133');
  const ip = newClientIp();
  const trapped = await customerRequest('POST', '/api/auth/login', { ip, body: { email: trap.mixed, password: 'any-password-1!' } });
  const unknown = await customerRequest('POST', '/api/auth/login', {
    ip: newClientIp(),
    body: { email: uniqueEmail('nobody'), password: 'any-password-1!' },
  });
  expect({ status: trapped.status, message: trapped.json?.message }).toEqual({ status: 401, message: INVALID_LOGIN });
  expect(comparableError(trapped.json)).toEqual(comparableError(unknown.json));

  const [alarm] = await eventually(() => alarms({ kind: 'tripwire.account', key: `${trap.id}:sign_in` }), (rows) => rows.length > 0);
  expect({ details: alarm.details, ip: alarm.ip_address }).toEqual({ details: { label: trap.label, action: 'sign_in' }, ip });
});

test('ADMOPS-134 a trap address on forgot password', async () => {
  const trap = await trapAddress('134');
  const ip = newClientIp();
  await customerRequest('POST', '/api/auth/login', { ip, body: { email: trap.address, password: 'any-password-1!' } });
  const response = await customerRequest('POST', '/api/auth/forgot-password', { ip, body: { email: trap.address } });
  expect(response.status).toBe(200);
  expect(response.json.data).toEqual({ message: FORGOT_PASSWORD });

  const [reset] = await eventually(() => alarms({ kind: 'tripwire.account', key: `${trap.id}:password_reset` }), (rows) => rows.length > 0);
  expect(reset.details).toEqual({ label: trap.label, action: 'password_reset' });
  await eventually(() => alarms({ kind: 'tripwire.account', keyLike: `${trap.id}:%` }), (rows) => rows.length === 2);
  await sleep(2000);
  expect(await mailsTo(trap.address)).toEqual([]);
  expect(await sql(`SELECT id FROM users WHERE email = $1`, [trap.address])).toEqual([]);
});

test('ADMOPS-135 a trap address on sign-up', async () => {
  const trap = await trapAddress('135');
  const ip = newClientIp();
  const fresh = uniqueEmail('fresh-135');
  const trapped = await customerRequest('POST', '/api/auth/register', { ip, body: { email: trap.address, name: 'Trap Person' } });
  const other = await customerRequest('POST', '/api/auth/register', { ip: newClientIp(), body: { email: fresh, name: 'Fresh Person' } });
  expect({ status: trapped.status, body: trapped.json }).toEqual({ status: 202, body: { data: { status: 'check_email' } } });
  expect({ status: other.status, body: other.json }).toEqual({ status: trapped.status, body: trapped.json });

  const [alarm] = await eventually(() => alarms({ kind: 'tripwire.account', key: `${trap.id}:sign_up` }), (rows) => rows.length > 0);
  expect({ details: alarm.details, ip: alarm.ip_address }).toEqual({ details: { label: trap.label, action: 'sign_up' }, ip });
  // The fresh address gets its sign-up mail; the trap address gets none and no account.
  await waitForMail(fresh, { subjectIncludes: 'Finish creating your Chumbaq account' });
  expect(await mailsTo(trap.address)).toEqual([]);
  expect(await sql(`SELECT id FROM users WHERE email = $1`, [trap.address])).toEqual([]);
});

// ---------------------------------------------------------------- One incident

test('ADMOPS-146 incident page header and deadline banner', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const now = floorMinute(Date.now()) + 15_000;
  const noticedAt = new Date(now - 2 * 3600_000 - 60_000).toISOString();
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 146 ${hex()}`, noticedAt });
  await page.clock.setFixedTime(now);

  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  await expect(page.getByText(`Noticed ${istAndUtc(noticedAt)}`, { exact: true })).toBeVisible();
  const banner = page.getByRole('alert').filter({ hasText: 'to report to CERT-In' });
  await expect(banner.locator('span').first()).toHaveText('3 h 59 min left');
  await expect(banner).toContainText(`to report to CERT-In, by ${istAndUtc(incident.deadline)}`);
  await expect(banner).toHaveClass(/border-amber-500/);
  expect(incident.deadline).toBe(new Date(Date.parse(noticedAt) + 6 * 3600_000).toISOString());
});

test('ADMOPS-153 draft the report with no security contact saved', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant');
  await sql(`DELETE FROM security_contact`);
  const title = `E2E incident 153 ${hex()}`;
  const fixture = {
    title,
    types: ['iii', 'xi'],
    noticedAt: '2026-11-10T08:35:00.000Z',
    howNoticed: 'A customer wrote to support',
    systems: 'Dashboard API',
    summary: 'Someone signed in to an account that was not theirs.',
    tenantIds: [tenant.userId],
  };
  const incident = await recordIncident(staff.token, clientIp, fixture);

  await openAdminPage(page, `/incidents/${incident.id}`, title);
  await delayRequests(page, /\/report-draft$/, 1200);
  await page.getByRole('button', { name: 'Draft the report' }).click();
  await expect(page.locator('[data-slot="skeleton"]')).toBeVisible();

  const body = [
    'To: incident@cert-in.org.in',
    '',
    'I am: the affected entity',
    '',
    'Reporting organisation',
    'Organisation: [to fill]',
    'Address: [to fill]',
    'Sector: [to fill]',
    '',
    'Point of contact',
    'Name: [to fill]',
    'Designation: [to fill]',
    'Email: [to fill]',
    'Phone: [to fill]',
    '',
    'Incident',
    `Title: ${title}`,
    'Type (CERT-In Directions of 28 April 2022, Annexure I):',
    '  (iii) Unauthorised access of IT systems/data',
    '  (xi) Data Breach',
    'Noticed at: 10 Nov 2026, 14:05 IST (08:35 UTC)',
    'How it came to notice: A customer wrote to support',
    'Systems affected: Dashboard API',
    'Customer accounts affected: 1',
    'Occurrence date & time (dd/mm/yyyy hh:mm): [to fill]',
    'Detection date & time (dd/mm/yyyy hh:mm): 10/11/2026 14:05 IST',
    "Is the affected system critical to the organisation's mission? (Yes/No, brief details): [to fill]",
    '',
    'Basic information of affected system',
    'Domain/URL: [to fill]',
    'IP address: [to fill]',
    'Operating system: [to fill]',
    'Make/Model/Cloud details: [to fill]',
    'Affected application details: Dashboard API',
    'Location of affected system (city, region, country): [to fill]',
    'Network and name of ISP: [to fill]',
    '',
    'Description',
    'Someone signed in to an account that was not theirs.',
    '',
    'Actions taken so far',
    '[to fill]',
    '',
    'Logs',
    'Logs covering the period are preserved and will be provided with this report or on request.',
    '',
    'This is an initial report within 6 hours of noticing, as direction (ii) requires; further details will follow.',
  ].join('\n');
  const subject = page.getByRole('textbox', { name: 'Subject' });
  const report = page.getByRole('textbox', { name: 'Report' });
  await expect(subject).toHaveValue(`Cyber security incident report: ${title}`);
  await expect(subject).not.toBeEditable();
  await expect(report).toHaveValue(body);
  await expect(report).not.toBeEditable();

  // Drafting writes nothing: no audit entry beyond the recording, no note, no contact.
  expect((await auditRowsWhere({ targetId: incident.id })).map((r) => r.action)).toEqual(['incident.recorded']);
  expect(await sql(`SELECT id FROM security_incident_notes WHERE incident_id = $1`, [incident.id])).toEqual([]);
  expect(await sql(`SELECT id FROM security_contact`)).toEqual([]);
});

test('ADMOPS-160 mark reported with the defaults', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 160 ${hex()}` });
  const opening = floorMinute(Date.now());
  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);
  const opened = floorMinute(Date.now());
  const description = page.getByText('Once CERT-In has it. This stops the reminders.', { exact: true });
  await expect(description).toBeVisible();
  await expect(page.getByLabel('How')).toHaveValue('email');

  await delayRequests(page, /\/report$/, 1200, 'POST');
  await page.getByRole('button', { name: 'Mark reported' }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeDisabled();

  const banner = page.getByRole('status').filter({ hasText: 'Reported to CERT-In' });
  await expect(banner).toBeVisible();
  const row = await incidentRow(incident.id);
  await expect(banner).toHaveText(`Reported to CERT-In ${istAndUtc(row.reported_at!)} by email.`);
  await expect(description).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark reported' })).toHaveCount(0);

  expect(row).toMatchObject({ status: 'reported', reported_by: staff.account.userId, report_method: 'email', certin_reference: null });
  const reportedAt = row.reported_at!.getTime();
  expect(reportedAt % 60_000).toBe(0);
  expect(reportedAt).toBeGreaterThanOrEqual(opening);
  expect(reportedAt).toBeLessThanOrEqual(opened);
  const audit = await auditRowsWhere({ action: 'incident.reported', targetId: incident.id });
  expect(audit.map((a) => a.metadata)).toEqual([{ method: 'email' }]);

  await openAdminPage(page, '/incidents', 'Incidents');
  const listRow = page.getByRole('row').filter({ has: page.getByRole('link', { name: incident.title, exact: true }) });
  await expect(listRow.locator('td').last()).toHaveText('Reported');
});

test('ADMOPS-169 close without reporting', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 169 ${hex()}` });
  await openAdminPage(page, `/incidents/${incident.id}`, incident.title);

  const closeButton = page.getByRole('button', { name: 'Close with this note' });
  await expect(closeButton).toBeDisabled();
  await page.getByRole('textbox', { name: 'New note' }).fill('Not reportable: test traffic');
  await closeButton.click();

  const banner = page.getByRole('status').filter({ hasText: 'without reporting' });
  await expect(banner).toBeVisible();
  const row = await incidentRow(incident.id);
  await expect(banner).toHaveText(`Closed ${istAndUtc(row.closed_at!)} without reporting.`);
  await expect(page.getByText('Not reportable: test traffic', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New note' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add note' })).toHaveCount(0);
  await expect(closeButton).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark reported' })).toHaveCount(0);

  expect(row).toMatchObject({ status: 'closed', closed_by: staff.account.userId, reported_at: null });
  const audit = await auditRowsWhere({ action: 'incident.closed', targetId: incident.id });
  expect(audit.map((a) => a.metadata)).toEqual([{ wasReported: false }]);
  // Written in the closing transaction: the note's time is the transaction's.
  const notes = await sql<{ note: string; created_at: Date }>(`SELECT note, created_at FROM security_incident_notes WHERE incident_id = $1`, [incident.id]);
  expect(notes.map((n) => n.note)).toEqual(['Not reportable: test traffic']);
  expect(notes[0].created_at.getTime()).toBe(row.closed_at!.getTime());

  await openAdminPage(page, '/incidents', 'Incidents');
  const statuses = await page.locator('table').first().locator('tbody tr').evaluateAll((rows) =>
    rows.map((r) => ({ title: r.querySelector('a')?.textContent ?? '', status: (r.querySelector('td:last-child')?.textContent ?? '').trim() })),
  );
  const mine = statuses.findIndex((s) => s.title === incident.title);
  expect(statuses[mine]?.status).toBe('Closed');
  const open = (s: { status: string }) => / left$|^Overdue by /.test(s.status);
  expect(statuses.slice(mine + 1).filter(open)).toEqual([]);
});

test('ADMOPS-174 incidents and notes cannot be rewritten, deleted or moved back', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 174 ${hex()}` });
  await adminApi('POST', `/api/admin/incidents/${incident.id}/notes`, { note: 'E2E: first finding' }, staff.token, clientIp);
  await adminApi('POST', `/api/admin/incidents/${incident.id}/report`, { method: 'portal', certinReference: 'CERTIN-174' }, staff.token, clientIp);

  /** Runs each statement in a transaction that is always rolled back, answering its error. */
  const attempt = (statements: string[]) =>
    withDb(async (db) => {
      const errors: string[] = [];
      for (const statement of statements) {
        await db.query('BEGIN');
        try {
          await db.query(statement, statement.includes('$1') ? [incident.id] : []);
          errors.push(`no error: ${statement}`);
        } catch (error) {
          errors.push((error as Error).message);
        } finally {
          await db.query('ROLLBACK');
        }
      }
      return errors;
    });

  const snapshot = async () => ({
    incident: await incidentRow(incident.id),
    notes: await sql(`SELECT id, note, created_at FROM security_incident_notes WHERE incident_id = $1 ORDER BY created_at`, [incident.id]),
  });
  const before = await snapshot();
  const ONLY_INCIDENTS = 'security_incidents is append-only';
  const ONLY_NOTES = 'security_incident_notes is append-only';

  expect(
    await attempt([
      `UPDATE security_incidents SET title = 'x' WHERE id = $1`,
      `UPDATE security_incidents SET types = '{i}' WHERE id = $1`,
      `UPDATE security_incidents SET noticed_at = now() WHERE id = $1`,
      `DELETE FROM security_incidents WHERE id = $1`,
      `TRUNCATE security_incidents CASCADE`,
    ]),
  ).toEqual([ONLY_INCIDENTS, ONLY_INCIDENTS, ONLY_INCIDENTS, ONLY_INCIDENTS, ONLY_INCIDENTS]);

  await adminApi('POST', `/api/admin/incidents/${incident.id}/close`, { note: 'E2E: closing' }, staff.token, clientIp);
  const closed = await snapshot();
  expect(
    await attempt([
      `UPDATE security_incidents SET status = 'open' WHERE id = $1`,
      `UPDATE security_incidents SET closed_at = now() WHERE id = $1`,
      `UPDATE security_incidents SET certin_reference = 'changed' WHERE id = $1`,
      `UPDATE security_incident_notes SET note = 'x' WHERE incident_id = $1`,
      `DELETE FROM security_incident_notes WHERE incident_id = $1`,
      `TRUNCATE security_incident_notes`,
    ]),
  ).toEqual([ONLY_INCIDENTS, ONLY_INCIDENTS, ONLY_INCIDENTS, ONLY_NOTES, ONLY_NOTES, ONLY_NOTES]);
  expect(await snapshot()).toEqual(closed);
  expect(closed.incident).toMatchObject({ ...before.incident, status: 'closed', closed_by: staff.account.userId, closed_at: expect.any(Date) });
  expect(closed.notes.slice(0, before.notes.length)).toEqual(before.notes);
});

// ---------------------------------------------------------------- Everything recorded

test('ADMOPS-178 operations writes all appear in the audit log page', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const call = <T = unknown>(method: string, path: string, body?: unknown) => adminApi<T>(method, path, body, staff.token, clientIp);
  const title = `E2E incident 178 ${hex()}`;
  const org = `E2E Org 178 ${hex()}`;
  const trapLabel = `E2E trap key 178 ${hex()}`;

  const incident = await recordIncident(staff.token, clientIp, { title });
  await call('POST', `/api/admin/incidents/${incident.id}/notes`, { note: 'E2E: a finding' });
  await call('POST', `/api/admin/incidents/${incident.id}/report`, { method: 'email' });
  await call('POST', `/api/admin/incidents/${incident.id}/close`, { note: 'E2E: done' });
  await call('PUT', '/api/admin/security-contact', { orgName: org });
  const trap = await call<{ id: string }>('POST', '/api/admin/tripwires/api-key', { label: trapLabel });
  await call('POST', `/api/admin/tripwires/${trap.id}/revoke`);
  const exported = await adminRequest('GET', `/api/admin/audit-logs/export?actorEmail=${encodeURIComponent(staff.account.email)}`, {
    token: staff.token,
    ip: clientIp,
  });
  expect(exported.status).toBe(200);

  await openAdminPage(page, '/audit-log', 'Audit log');
  await applyAuditFilters(page, {
    actions: [
      'Incident recorded',
      'Incident note added',
      'Incident marked reported to CERT-In',
      'Incident closed',
      'Security contact changed',
      'Trap made',
      'Trap switched off',
      'Audit log exported',
    ],
    actorEmail: staff.account.email,
  });
  await expect(auditTableRows(page)).toHaveCount(8);
  expect(await auditColumn(page, 2)).toEqual([
    'Audit log exported',
    'Trap switched off',
    'Trap made',
    'Security contact changed',
    'Incident closed',
    'Incident marked reported to CERT-In',
    'Incident note added',
    'Incident recorded',
  ]);
  expect(await auditColumn(page, 3)).toEqual(['-', trapLabel, trapLabel, org, title, title, title, title]);
  expect(await auditColumn(page, 1)).toEqual(Array(8).fill(staff.account.email));
  expect(await auditColumn(page, 5)).toEqual(Array(8).fill(clientIp));
  await expect(page.locator('table a')).toHaveCount(0);
});


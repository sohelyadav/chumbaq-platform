import { randomBytes, randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { adminApi, adminUrl } from '../../support/admin';
import { api, createAccount, createApiKey, createProject, newClientIp, type Account } from '../../support/api';
import { readDownload } from '../../support/browser-tools';
import { expect, newPersonContext, test } from '../../support/fixtures';
import { waitForMail } from '../../support/mailbox';
import { identifyPeople } from '../../support/seed';
import {
  COUNTED_STATE,
  accountFact,
  addUtcDays,
  adminDate,
  adminRequest,
  auditRows,
  cardTitled,
  clickShortLink,
  compTenant,
  createCompPlan,
  csvLines,
  parseCsv,
  customerRequest,
  factorResetRows,
  identifyKnownPerson,
  insertDraftJourney,
  insertJourneyRun,
  inviteAddress,
  inviteAndAccept,
  makeSuperAdmin,
  openTenantPage,
  runDueAt,
  seedPendingFactorReset,
  seedUsage,
  setRollupState,
  signedInStaff,
  sql,
  tenantState,
  usageDay,
  usageMonth,
  userRow,
  type RollupStateSeed,
  type Staff,
  type UsageSeed,
} from '../../support/areas/admten';

/**
 * Admin tenant routes and pages, second P1 chunk: the export's headers and cap, the
 * tenant page (header, Account and Projects cards, audit trail), the Usage card and the
 * usage API, project and seat limits, and suspension and reactivation. The usage
 * roll-up state is one row for the whole database: tests that set it hold its lock and
 * put it back.
 */

test.describe.configure({ mode: 'parallel' });

const CSV_HEADER =
  'tenant_id,email,name,status,plan,super_admin,signed_up_at,projects,mau_this_month,messages_sent_30d,last_usage_day,counted_through';
const term = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;

function toast(page: Page, title: string) {
  return page.getByText(title, { exact: true }).first();
}

/** Sets the roll-up state and seeds usage rows for `work`, then puts both back. */
async function withUsage<T>(state: RollupStateSeed | null, rows: UsageSeed[], work: () => Promise<T>): Promise<T> {
  const restoreState = await setRollupState(state);
  const removeUsage = await seedUsage(rows);
  try {
    return await work();
  } finally {
    await removeUsage();
    await restoreState();
  }
}

interface Detail {
  projectLimit: number | null;
  effectiveProjectLimit: number;
  seatLimit: number | null;
  effectiveSeatLimit: number | null;
  seatsUsed: number;
  createdAt: string;
  lastSignInAt: string | null;
}

function detailOf(staff: Staff, tenantId: string, ip: string): Promise<Detail> {
  return adminApi<Detail>('GET', `/api/admin/tenants/${tenantId}`, undefined, staff.token, ip);
}

/** The install's default project limit, as the API reports it for an account with no override. */
async function defaultProjectLimit(staff: Staff, tenantId: string, ip: string): Promise<number> {
  const detail = await detailOf(staff, tenantId, ip);
  expect(detail.projectLimit).toBeNull();
  return detail.effectiveProjectLimit;
}

function projectsCard(page: Page) {
  return cardTitled(page, 'Projects');
}

function usageCard(page: Page) {
  return cardTitled(page, 'Usage');
}

/** The bodies the tests send to a validated route, with their expected messages. */
async function expectRefusals(
  staff: Staff,
  ip: string,
  method: string,
  path: string,
  cases: { body: unknown; message: string; status?: number }[],
): Promise<void> {
  for (const { body, message, status } of cases) {
    const response = await adminRequest(method, path, { token: staff.token, ip, body });
    const label = JSON.stringify(body)?.slice(0, 80) ?? 'no body';
    expect.soft(response.status, label).toBe(status ?? 400);
    const messages = response.json?.message;
    expect.soft(Array.isArray(messages) ? messages : [messages], label).toContain(message);
  }
}

// ---- D. Tenants export

test('ADMTEN-082 export response headers', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const response = await adminRequest('GET', '/api/admin/tenants/export', { token: staff.token, ip: clientIp });
  expect(response.status).toBe(200);
  const header = (name: string) => response.headers.get(name);
  expect(header('content-type')).toBe('text/csv; charset=utf-8');
  expect(header('content-disposition')).toMatch(/^attachment; filename="chumbaq-tenants-\d{8}-\d{6}\.csv"$/);
  expect(header('cache-control')).toBe('no-store');
  // Parsed, not split on line breaks: other tests store names holding them.
  const dataRows = parseCsv(response.text.replace(/^﻿/, '')).length - 1;
  expect(dataRows).toBeGreaterThan(0);
  expect(header('x-export-row-count')).toBe(String(dataRows));
  expect(header('x-export-row-cap')).toBe('10000');
  // Another test can hold more than 10,000 accounts in the database for a moment; then the file is cut at the cap.
  expect(header('x-export-truncated')).toEqual(dataRows === 10000 ? expect.stringMatching(/^(true|false)$/) : 'false');
  const exposed = (header('access-control-expose-headers') ?? '').split(',').map((name) => name.trim());
  expect(exposed).toEqual(
    expect.arrayContaining(['Content-Disposition', 'X-Export-Row-Count', 'X-Export-Row-Cap', 'X-Export-Truncated']),
  );
  // A file, not the `{ data }` envelope.
  expect(response.json).toBeNull();
  expect(response.text.replace(/^﻿/, '').startsWith(CSV_HEADER)).toBe(true);
});

test('ADMTEN-083 export is matched before the tenant detail route', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const response = await adminRequest('GET', '/api/admin/tenants/export', { token: staff.token, ip: clientIp });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/csv');
  expect(response.text).not.toContain('uuid is expected');
  expect(response.text).not.toContain('recentAudit');
  expect(csvLines(response.text.replace(/^﻿/, ''))[0]).toBe(CSV_HEADER);
  // The neighbouring detail route still refuses a non-uuid id.
  const detail = await adminRequest('GET', '/api/admin/tenants/exports', { token: staff.token, ip: clientIp });
  expect(detail.status).toBe(400);
  expect(detail.json?.message).toBe('Validation failed (uuid is expected)');
});

test('ADMTEN-087 export cap: 10,000 rows and the truncated toast', async ({ page, clientIp }) => {
  test.slow();
  const staff = await signedInStaff(page, clientIp);
  const search = term('cap');
  // Years old, so they never reach another test's first page or its "new" filter.
  await sql(
    `INSERT INTO users (email, name, password_hash, created_at)
     SELECT $1 || '-' || g || '@e2e.example.test', 'Cap ' || g, 'e2e-no-password',
            now() - interval '5 years' - make_interval(secs => g)
       FROM generate_series(1, 10001) g`,
    [search],
  );
  try {
    await page.goto(adminUrl(`/tenants?search=${search}`));
    await expect(page.getByRole('heading', { name: 'Tenants', exact: true })).toBeVisible();
    await expect(page.getByRole('main').locator('tbody tr')).toHaveCount(25);

    const answered = page.waitForResponse((response) => response.url().includes('/api/admin/tenants/export'));
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const response = await answered;
    expect(response.headers()['x-export-row-count']).toBe('10000');
    expect(response.headers()['x-export-truncated']).toBe('true');
    const file = await readDownload(await downloaded);
    expect(file.lines[0]).toBe(CSV_HEADER);
    expect(file.lines).toHaveLength(10_001);
    await expect(toast(page, 'Exported the first 10,000 of more tenants; narrow the filters')).toBeVisible();

    const audit = await auditRows({ action: 'tenants.exported', actorId: staff.account.userId });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ rowCount: 10000, rowCap: 10000, truncated: true, filters: { search } });
  } finally {
    await sql(`DELETE FROM users WHERE email LIKE $1`, [`${search}-%@e2e.example.test`]);
  }
});

// ---- E. Tenant detail

test('ADMTEN-093 tenant header for an active tenant', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const [{ created }] = await sql<{ created: Date }>(`SELECT created_at AS created FROM users WHERE id = $1`, [tenant.userId]);
  await openTenantPage(page, tenant);

  await expect(page.getByRole('link', { name: 'Tenants', exact: true }).first()).toHaveAttribute('href', '/tenants');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tess Tenant');
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-slot="badge"]').getByText('active', { exact: true })).toBeVisible();
  await expect(page.getByText(`Joined ${adminDate(created)}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View as tenant' })).toBeEnabled();
  const suspend = page.getByRole('button', { name: 'Suspend', exact: true });
  await expect(suspend).toBeEnabled();
  await expect(suspend).toHaveAttribute('data-variant', 'destructive');
  await expect(page.getByText(/^Suspended( on |$)/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
});

test('ADMTEN-097 Account card facts', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp);
  const member = await createAccount(newClientIp(), 'member', 'Mia Member');
  await inviteAndAccept(tenant, project.id, member, 'member', clientIp);
  await inviteAddress(tenant, project.id, clientIp);
  // A complete sign-in records the event the card reads.
  const login = await customerRequest('POST', '/api/auth/login', { ip: clientIp, body: { email: tenant.email, password: tenant.password } });
  expect(login.status).toBe(200);

  const detail = await detailOf(staff, tenant.userId, clientIp);
  expect(detail.lastSignInAt).not.toBeNull();
  expect(Math.abs(Date.now() - new Date(detail.lastSignInAt!).getTime())).toBeLessThan(5 * 60_000);

  await openTenantPage(page, tenant);
  const card = cardTitled(page, 'Account');
  // Billing is on in this stack, so the plan is the Billing card's, not a fact here.
  await expect(card.locator('dt')).toHaveText(['Signed up', 'Last sign-in', 'Owner email', 'People on the account', 'Projects']);
  await expect(accountFact(page, 'Signed up')).toHaveText(adminDate(detail.createdAt, true));
  await expect(accountFact(page, 'Last sign-in')).toHaveText(adminDate(detail.lastSignInAt!, true));
  await expect(accountFact(page, 'Owner email')).toHaveText(tenant.email);
  // Owner, the member and the pending invitee.
  await expect(accountFact(page, 'People on the account')).toHaveText('3');
  await expect(accountFact(page, 'Projects')).toHaveText('1');
});

test('ADMTEN-100 Projects card lists only projects billed to the tenant', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const p1 = await api<{ id: string; name: string; createdAt: string }>(
    'POST',
    '/api/projects',
    { name: `P1 ${randomBytes(2).toString('hex')}`, domain: 'p1.example.test' },
    { token: tenant.accessToken, ip: clientIp },
  );
  const sdkKey = await createApiKey(tenant, p1.id, clientIp);
  const spare = await api<{ apiKey: { id: string } }>('POST', `/api/projects/${p1.id}/api-keys`, { name: 'E2E spare key' }, {
    token: tenant.accessToken,
    ip: clientIp,
  });
  await api('DELETE', `/api/projects/${p1.id}/api-keys/${spare.apiKey.id}`, undefined, { token: tenant.accessToken, ip: clientIp });
  const links: { id: string; shortCode: string }[] = [];
  for (const label of ['a', 'b']) {
    links.push(
      await api<{ id: string; shortCode: string }>(
        'POST',
        `/api/projects/${p1.id}/links`,
        { longUrl: 'https://example.com/landing', shortCode: `adm100${label}${randomBytes(3).toString('hex')}` },
        { token: tenant.accessToken, ip: clientIp },
      ),
    );
  }
  await identifyPeople(p1.id, sdkKey, clientIp, [{}, {}, {}]);
  for (let i = 0; i < 4; i++) expect(await clickShortLink(links[i % 2].shortCode, newClientIp())).toBe(302);
  await expect
    .poll(async () => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM click_events WHERE link_id = ANY($1::uuid[])`, [links.map((l) => l.id)]))[0].n)
    .toBe(4);

  const p2 = await api<{ id: string; name: string; createdAt: string }>(
    'POST',
    '/api/projects',
    { name: `P2 ${randomBytes(2).toString('hex')}` },
    { token: tenant.accessToken, ip: clientIp },
  );
  // A project of another account that the tenant is a member of.
  const other = await createAccount(newClientIp(), 'other', 'Otto Other');
  const px = await createProject(other, clientIp, `PX ${randomBytes(2).toString('hex')}`);
  await inviteAndAccept(other, px.id, tenant, 'member', clientIp);

  await openTenantPage(page, tenant);
  const card = projectsCard(page);
  await expect(card.getByRole('columnheader')).toHaveText([
    'Project',
    'Domain',
    'Links',
    'Identities',
    'Clicks (30d)',
    'Active API keys',
    'Created',
  ]);
  const rows = card.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole('cell')).toHaveText([p2.name, '-', '0', '0', '0', '0', adminDate(p2.createdAt)]);
  await expect(rows.nth(1).getByRole('cell')).toHaveText([p1.name, 'p1.example.test', '2', '3', '4', '1', adminDate(p1.createdAt)]);
  await expect(card.getByText(px.name)).toHaveCount(0);
});

test('ADMTEN-102 recent audit trail lists actions on the tenant, newest first', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const base = `/api/admin/tenants/${tenant.userId}`;
  await adminApi('POST', `${base}/suspend`, { reason: 'R1: abuse report received' }, staff.token, clientIp);
  await adminApi('POST', `${base}/reactivate`, { reason: 'R2: resolved with the owner' }, staff.token, clientIp);
  await adminApi('PATCH', `${base}/project-limit`, { projectLimit: 15, reason: 'R3: larger agency account' }, staff.token, clientIp);

  await openTenantPage(page, tenant);
  // The page's own view is recorded, and left off this list.
  await expect.poll(async () => (await auditRows({ action: 'tenant.viewed', targetId: tenant.userId })).length).toBe(1);
  const card = cardTitled(page, 'Recent audit trail');
  await expect(card.getByRole('columnheader')).toHaveText(['When', 'Action', 'By', 'Reason']);
  const rows = card.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  const expected = [
    ['Project limit changed', 'R3: larger agency account'],
    ['Reactivated', 'R2: resolved with the owner'],
    ['Suspended', 'R1: abuse report received'],
  ];
  for (const [index, [action, reason]] of expected.entries()) {
    const cells = rows.nth(index).getByRole('cell');
    await expect(cells.nth(0)).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2}$/);
    await expect(cells.nth(1)).toHaveText(action);
    await expect(cells.nth(2)).toHaveText(staff.account.email);
    await expect(cells.nth(3)).toHaveText(reason);
  }
  await expect(card.getByText('Viewed by staff')).toHaveCount(0);
});

test('ADMTEN-105 free text in the audit trail and header renders as text', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Placeholder');
  const name = '<img src=x onerror=alert(1)>';
  const reason = '<b>bold</b>\nline two';
  await sql(`UPDATE users SET name = $2 WHERE id = $1`, [tenant.userId, name]);
  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { reason }, staff.token, clientIp);
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });

  await openTenantPage(page, tenant);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const suspendedCard = page.locator('[data-slot="card"]').filter({ hasText: /^Suspended on / });
  const reasonText = suspendedCard.locator('p').nth(1);
  await expect(reasonText).toHaveText(reason, { useInnerText: true });
  const trailReason = cardTitled(page, 'Recent audit trail').locator('tbody tr').filter({ hasText: 'Suspended' }).getByRole('cell').nth(3);
  await expect(trailReason).toHaveText(reason, { useInnerText: true });
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('b').filter({ hasText: 'bold' })).toHaveCount(0);
  expect(dialogs).toBe(0);
});

test('ADMTEN-107 super admin tenant page', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  // An ordinary tenant first: its page has the Second factors card.
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await expect(cardTitled(page, 'Second factors')).toBeVisible();

  const admin = await createAccount(newClientIp(), 'staff2', 'Sue Superadmin');
  await makeSuperAdmin(admin.userId);
  await openTenantPage(page, admin);
  await expect(page.locator('[data-slot="badge"]').getByText('Super admin', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View as tenant' })).toBeDisabled();
  await expect(page.getByText('Super admins cannot be viewed as.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toBeDisabled();
  await expect(page.getByText('Super admins cannot be suspended.', { exact: true })).toBeVisible();
  await expect(cardTitled(page, 'Account')).toBeVisible();
  await expect(cardTitled(page, 'Second factors')).toHaveCount(0);
});

// ---- F. Tenant usage

test('ADMTEN-109 Usage card before the roll-up has counted', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await withUsage(null, [], async () => {
    const usage = page.waitForResponse((response) => response.url().includes(`/tenants/${tenant.userId}/usage`));
    await openTenantPage(page, tenant);
    const url = new URL((await usage).url());
    expect(url.pathname).toBe(`/api/admin/tenants/${tenant.userId}/usage`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ days: '90' });

    const card = usageCard(page);
    await expect(card.locator('[data-slot="card-header"] > p')).toHaveText('Not counted yet');
    await expect(card.getByText('Not counted yet. Usage appears once the daily roll-up has closed its first day.')).toBeVisible();
    await expect(card.getByRole('combobox')).toHaveCount(0);
    await expect(card.getByRole('table')).toHaveCount(0);
  });
});

test('ADMTEN-111 usage chart and month comparison', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp);
  const state = COUNTED_STATE();
  const through = state.lastClosedDay;
  const thisMonth = through.slice(0, 7);
  const lastMonthEnd = addUtcDays(`${thisMonth}-01`, -1);
  const lastMonth = lastMonthEnd.slice(0, 7);
  const row = (day: string, metric: string, value: number): UsageSeed => ({ projectId: project.id, ownerId: tenant.userId, day, metric, value });
  const rows = [
    row(through, 'push_sent', 10),
    row(through, 'email_sent', 5),
    row(through, 'events', 40),
    row(through, 'mau_month_to_date', 8),
    row(lastMonthEnd, 'push_sent', 3),
  ];
  // Partial while the month has days after the last counted one.
  const nextMonthStart = new Date(`${thisMonth}-01T00:00:00Z`);
  nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1);
  const thisMonthEnd = addUtcDays(nextMonthStart.toISOString().slice(0, 10), -1);
  const partial = thisMonthEnd > through;

  await withUsage(state, rows, async () => {
    await openTenantPage(page, tenant);
    const card = usageCard(page);
    await expect(card.locator('[data-slot="card-header"] > p')).toHaveText(`Counted through ${usageDay(through)} (UTC days)`);
    const metric = card.getByRole('combobox', { name: 'Metric shown in the chart' });
    await expect(metric).toHaveText('Monthly active devices');
    await card.getByText('View as table').click();
    const dayRow = card.getByRole('row').filter({ has: page.getByRole('cell', { name: usageDay(through), exact: true }) });
    await expect(dayRow.getByRole('cell').nth(1)).toHaveText('8');
    await metric.click();
    await page.getByRole('option', { name: 'Push sent', exact: true }).click();
    await expect(dayRow.getByRole('cell').nth(1)).toHaveText('10');

    await expect(card.getByRole('heading', { name: 'This month vs last month' })).toBeVisible();
    const months = card.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Metric' }) });
    const heads = months.getByRole('columnheader');
    await expect(heads).toHaveText(['Metric', `${usageMonth(thisMonth)}${partial ? ' (partial)' : ''}`, usageMonth(lastMonth)]);
    await expect(heads.nth(1)).toHaveAttribute('title', `${usageDay(`${thisMonth}-01`)} to ${usageDay(through)}`);
    await expect(heads.nth(2)).toHaveAttribute('title', `${usageDay(`${lastMonth}-01`)} to ${usageDay(lastMonthEnd)}`);
    await expect(months.locator('tbody tr td:first-child')).toHaveText([
      'Push sent',
      'Emails sent',
      'SMS sent',
      'WhatsApp sent',
      'Messages failed',
      'In-app impressions',
      'Link clicks',
      'Events received',
      'New people',
      'Monthly active devices',
      'Messages sent, all channels',
    ]);
    const cells = (label: string) => months.locator('tbody tr').filter({ has: page.getByRole('cell', { name: label, exact: true }) }).getByRole('cell');
    await expect(cells('Messages sent, all channels')).toHaveText(['Messages sent, all channels', '15', '3']);
    await expect(cells('Push sent')).toHaveText(['Push sent', '10', '3']);
    await expect(cells('Events received')).toHaveText(['Events received', '40', '0']);
    await expect(cells('Monthly active devices').nth(1)).toHaveText('8');
    await expect(card.getByText("Monthly active devices is the count on the month's last counted day; the rest are totals.")).toBeVisible();
  });
});

test('ADMTEN-114 by-project table, deleted projects and naming', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const beta = await createProject(tenant, clientIp, 'Beta');
  const alpha = await createProject(tenant, clientIp, 'Alpha');
  const gone = randomUUID();
  const state = COUNTED_STATE();
  const through = state.lastClosedDay;
  const earlier = addUtcDays(through, -5);
  const row = (projectId: string, day: string, metric: string, value: number): UsageSeed => ({
    projectId,
    ownerId: tenant.userId,
    day,
    metric,
    value,
  });
  const rows = [
    row(alpha.id, through, 'mau_month_to_date', 3),
    row(alpha.id, earlier, 'push_sent', 7),
    row(alpha.id, through, 'sms_sent', 2),
    row(alpha.id, earlier, 'events', 11),
    row(alpha.id, through, 'clicks', 5),
    row(beta.id, earlier, 'email_sent', 4),
    row(beta.id, through, 'clicks', 1),
    row(gone, through, 'mau_month_to_date', 1),
    row(gone, earlier, 'whatsapp_sent', 6),
    row(gone, earlier, 'events', 2),
  ];
  await withUsage(state, rows, async () => {
    await openTenantPage(page, tenant);
    const card = usageCard(page);
    await expect(card.getByRole('heading', { name: 'By project, last 90 counted days' })).toBeVisible();
    const table = card.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Project' }) });
    await expect(table.getByRole('columnheader')).toHaveText(['Project', 'Monthly active devices', 'Messages (90d)', 'Events', 'Link clicks']);
    const body = table.locator('tbody tr');
    await expect(body).toHaveCount(3);
    await expect(body.nth(0).getByRole('cell')).toHaveText(['Alpha', '3', '9', '11', '5']);
    await expect(body.nth(1).getByRole('cell')).toHaveText(['Beta', '0', '4', '0', '1']);
    await expect(body.nth(2).getByRole('cell')).toHaveText(['Deleted project', '1', '6', '2', '0']);
    await expect(body.nth(2).getByRole('cell').first().locator('span.italic')).toHaveText('Deleted project');
  });
});

interface UsageBody {
  coverage: unknown;
  days: number;
  series: { date: string; values: Record<string, number | null> }[];
  thisMonth: unknown;
  lastMonth: unknown;
  projects: { projectId: string; name: string | null; values: Record<string, number | null> }[];
}

test('ADMTEN-115 usage stays with the account that was billed', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const before = await createAccount(newClientIp(), 'billed-a', 'Ann Earlier');
  const after = await createAccount(newClientIp(), 'billed-b', 'Ben Later');
  // Billed to B now; its earlier days were written while A was billed.
  const project = await createProject(after, clientIp, `Moved ${randomBytes(2).toString('hex')}`);
  const state = COUNTED_STATE();
  const early = addUtcDays(state.lastClosedDay, -10);
  const late = addUtcDays(state.lastClosedDay, -3);
  const rows: UsageSeed[] = [
    { projectId: project.id, ownerId: before.userId, day: early, metric: 'push_sent', value: 5 },
    { projectId: project.id, ownerId: after.userId, day: late, metric: 'push_sent', value: 7 },
  ];
  await withUsage(state, rows, async () => {
    const read = (id: string) => adminApi<UsageBody>('GET', `/api/admin/tenants/${id}/usage`, undefined, staff.token, clientIp);
    const a = await read(before.userId);
    const b = await read(after.userId);
    const on = (body: UsageBody, day: string) => body.series.find((entry) => entry.date === day)?.values.push_sent;

    expect([on(a, early), on(a, late)]).toEqual([5, 0]);
    expect(a.projects).toEqual([expect.objectContaining({ projectId: project.id, name: project.name })]);
    expect(a.projects[0].values.push_sent).toBe(5);

    expect([on(b, early), on(b, late)]).toEqual([0, 7]);
    expect(b.projects).toEqual([expect.objectContaining({ projectId: project.id, name: project.name })]);
    expect(b.projects[0].values.push_sent).toBe(7);
  });
});

test('ADMTEN-117 usage reads are audited as a tenant view', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const views = () => auditRows({ action: 'tenant.viewed', actorId: staff.account.userId, targetId: tenant.userId });
  expect(await views()).toHaveLength(0);

  const usage = await adminRequest('GET', `/api/admin/tenants/${tenant.userId}/usage`, { token: staff.token, ip: clientIp });
  expect(usage.status).toBe(200);
  const rows = await views();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor_email: staff.account.email, target_label: tenant.email, ip_address: clientIp });

  const detail = await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp });
  expect(detail.status).toBe(200);
  expect(await views()).toHaveLength(1);
});

test('ADMTEN-118 usage carries counts only', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp);
  const sdkKey = await createApiKey(tenant, project.id, clientIp);
  const person = { externalUserId: `ext-${randomBytes(5).toString('hex')}`, email: `person-${randomBytes(4).toString('hex')}@e2e.example.test` };
  await identifyKnownPerson(tenant, project.id, sdkKey, clientIp, person);
  const [device] = await sql<{ id: string; device_fingerprint: string }>(
    `SELECT id, device_fingerprint FROM device_identities WHERE project_id = $1`,
    [project.id],
  );
  expect(device).toBeTruthy();
  const state = COUNTED_STATE();
  const rows: UsageSeed[] = [
    { projectId: project.id, ownerId: tenant.userId, day: state.lastClosedDay, metric: 'mau_month_to_date', value: 1 },
    { projectId: project.id, ownerId: tenant.userId, day: state.lastClosedDay, metric: 'new_people', value: 1 },
  ];
  await withUsage(state, rows, async () => {
    const response = await adminRequest('GET', `/api/admin/tenants/${tenant.userId}/usage`, { token: staff.token, ip: clientIp });
    expect(response.status).toBe(200);
    const body = (response.json as { data: UsageBody }).data;
    expect(Object.keys(body).sort()).toEqual(['coverage', 'days', 'lastMonth', 'projects', 'series', 'thisMonth']);
    expect(body.projects).toHaveLength(1);
    expect(Object.keys(body.projects[0]).sort()).toEqual(['name', 'projectId', 'values']);
    expect(body.projects[0].values.mau_month_to_date).toBe(1);
    for (const value of [person.email, person.externalUserId, device.id, device.device_fingerprint]) {
      expect(response.text).not.toContain(value);
    }
  });
});

// ---- G. Project and seat limits

test('ADMTEN-119 Projects card shows the default limits', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await createProject(tenant, clientIp);
  await createProject(tenant, clientIp);
  const detail = await detailOf(staff, tenant.userId, clientIp);
  expect(detail).toMatchObject({ projectLimit: null, seatLimit: null, seatsUsed: 1 });

  await openTenantPage(page, tenant);
  const card = projectsCard(page);
  await expect(card.getByText(`2 of ${detail.effectiveProjectLimit} projects (default limit)`, { exact: true })).toBeVisible();
  const seats =
    detail.effectiveSeatLimit === null ? 'Seats: 1 used, no limit' : `Seats: 1 of ${detail.effectiveSeatLimit} used (default limit)`;
  await expect(card.getByText(seats, { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Change limit', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Change seat limit' })).toBeVisible();
});

test('ADMTEN-122 clear the project limit back to the default', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await createProject(tenant, clientIp);
  const defaultLimit = await defaultProjectLimit(staff, tenant.userId, clientIp);
  await adminApi('PATCH', `/api/admin/tenants/${tenant.userId}/project-limit`, { projectLimit: 25, reason: 'E2E: annual contract' }, staff.token, clientIp);

  await openTenantPage(page, tenant);
  await expect(page.getByText('1 of 25 projects (limit set by staff)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Change limit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Project limit' });
  await expect(dialog.getByLabel('Limit')).toHaveValue('25');
  await dialog.getByLabel('Limit').fill('');
  await dialog.getByLabel('Reason').fill('Contract ended, back to default');
  const sent = page.waitForRequest((request) => request.url().endsWith('/project-limit') && request.method() === 'PATCH');
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  expect((await sent).postDataJSON()).toEqual({ projectLimit: null, reason: 'Contract ended, back to default' });
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`1 of ${defaultLimit} projects (default limit)`, { exact: true })).toBeVisible();

  expect((await userRow(tenant.userId)).project_limit).toBeNull();
  const audit = await auditRows({ action: 'account.project_limit_changed', targetId: tenant.userId });
  expect(audit.map((row) => row.metadata)).toEqual([
    { before: null, after: 25, defaultLimit },
    { before: 25, after: null, defaultLimit },
  ]);
});

test('ADMTEN-123 lowering below the current count deletes nothing', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  for (let i = 0; i < 3; i++) await createProject(tenant, clientIp);

  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'Change limit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Project limit' });
  await dialog.getByLabel('Limit').fill('1');
  await dialog.getByLabel('Reason').fill('Account under review for abuse');
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog).toBeHidden();
  // The label uses the singular for a limit of one.
  await expect(page.getByText('3 of 1 project (limit set by staff)', { exact: true })).toBeVisible();
  await expect(projectsCard(page).locator('tbody tr')).toHaveCount(3);
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE owner_id = $1`, [tenant.userId]);
  expect(n).toBe(3);

  const list = await customerRequest('GET', '/api/projects', { token: tenant.accessToken, ip: clientIp });
  expect(list.status).toBe(200);
  expect(list.json?.meta).toMatchObject({ projectLimit: 1, billedProjects: 3 });
  const create = await customerRequest('POST', '/api/projects', { token: tenant.accessToken, ip: clientIp, body: { name: 'One too many' } });
  expect(create.status).toBe(403);
  expect((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE owner_id = $1`, [tenant.userId]))[0].n).toBe(3);
});

test('ADMTEN-125 project limit field validation in the dialog', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'Change limit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Project limit' });
  const field = dialog.getByLabel('Limit');
  const save = dialog.getByRole('button', { name: 'Save limit' });
  await dialog.getByLabel('Reason').fill('A valid reason for the change');
  const whole = 'Enter a whole number, or leave it blank for the default.';

  for (const value of ['abc', '10.5', '1e3', '-1']) {
    await field.fill(value);
    await expect.soft(dialog.getByText(whole, { exact: true }), value).toBeVisible();
    await expect.soft(field, value).toHaveAttribute('aria-invalid', 'true');
    await expect.soft(save, value).toBeDisabled();
  }
  await field.fill('1001');
  await expect(dialog.getByText('The most is 1000.', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await field.fill('1000');
  await expect(dialog.getByText(whole)).toHaveCount(0);
  await expect(dialog.getByText('The most is 1000.')).toHaveCount(0);
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await expect(save).toBeEnabled();

  await field.fill(' 12 ');
  await expect(save).toBeEnabled();
  const sent = page.waitForRequest((request) => request.url().endsWith('/project-limit') && request.method() === 'PATCH');
  await save.click();
  expect((await sent).postDataJSON()).toMatchObject({ projectLimit: 12 });
  await expect(dialog).toBeHidden();
  expect((await userRow(tenant.userId)).project_limit).toBe(12);
});

test('ADMTEN-126 project limit reason validation in the dialog', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'Change limit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Project limit' });
  const reason = dialog.getByLabel('Reason');
  const save = dialog.getByRole('button', { name: 'Save limit' });
  await dialog.getByLabel('Limit').fill('20');
  await expect(dialog.getByText('0/500, at least 10 characters.', { exact: true })).toBeVisible();

  await reason.fill('short');
  await expect(dialog.getByText('5/500, at least 10 characters.', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await reason.fill('   abcdefghi    ');
  await expect(dialog.getByText('9/500, at least 10 characters.', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await reason.fill('abcdefghij');
  await expect(dialog.getByText('10/500, at least 10 characters.', { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();

  await reason.fill('');
  await reason.focus();
  await page.keyboard.insertText('x'.repeat(600));
  await expect(reason).toHaveValue('x'.repeat(500));
  await expect(dialog.getByText('500/500, at least 10 characters.', { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();
});

test('ADMTEN-127 project limit API validation', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const before = await tenantState(tenant.userId);
  const reason = 'E2E: checking the validation';
  await expectRefusals(staff, clientIp, 'PATCH', `/api/admin/tenants/${tenant.userId}/project-limit`, [
    { body: { reason }, message: 'projectLimit must be an integer number' },
    { body: { projectLimit: 1.5, reason }, message: 'projectLimit must be an integer number' },
    { body: { projectLimit: -1, reason }, message: 'projectLimit must not be less than 0' },
    { body: { projectLimit: 1001, reason }, message: 'projectLimit must not be greater than 1000' },
    { body: { projectLimit: '5', reason }, message: 'projectLimit must be an integer number' },
    { body: { projectLimit: 5 }, message: 'reason must be a string' },
    { body: { projectLimit: 5, reason: '   short   ' }, message: 'reason must be longer than or equal to 10 characters' },
    { body: { projectLimit: 5, reason: { a: 1 } }, message: 'reason must be a string' },
    { body: { projectLimit: 5, reason: 'E2E: null\u0000character' }, message: 'reason must not contain null characters' },
    { body: { projectLimit: 5, reason: 'r'.repeat(501) }, message: 'reason must be shorter than or equal to 500 characters' },
  ]);
  expect(await tenantState(tenant.userId)).toEqual(before);
  // The same route takes a valid body.
  const ok = await adminRequest('PATCH', `/api/admin/tenants/${tenant.userId}/project-limit`, {
    token: staff.token,
    ip: clientIp,
    body: { projectLimit: 5, reason },
  });
  expect(ok.status).toBe(200);
  expect((await userRow(tenant.userId)).project_limit).toBe(5);
});

test('ADMTEN-130 project limit on a paid plan can only raise', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const plan = await createCompPlan(staff.token, clientIp, 'pro');
  const comped = await createAccount(newClientIp(), 'comped', 'Cora Comped');
  await createProject(comped, clientIp);
  await compTenant(staff.token, clientIp, comped.userId, plan.code);

  const setLimit = async (value: number, reason: string) => {
    await page.getByRole('button', { name: 'Change limit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Project limit' });
    await dialog.getByLabel('Limit').fill(String(value));
    await dialog.getByLabel('Reason').fill(reason);
    await dialog.getByRole('button', { name: 'Save limit' }).click();
    await expect(dialog).toBeHidden();
  };

  await openTenantPage(page, comped);
  await expect(page.getByText('1 of 20 projects (default limit)', { exact: true })).toBeVisible();
  await setLimit(5, 'Trying to lower a comped plan');
  await expect(page.getByText('1 of 20 projects (limit set by staff)', { exact: true })).toBeVisible();
  expect((await userRow(comped.userId)).project_limit).toBe(5);
  await setLimit(50, 'Raising above the comped plan');
  await expect(page.getByText('1 of 50 projects (limit set by staff)', { exact: true })).toBeVisible();

  // On the free plan the same override of 5 lowers it.
  const free = await createAccount(newClientIp(), 'free', 'Fay Free');
  await createProject(free, clientIp);
  await openTenantPage(page, free);
  await setLimit(5, 'Lowering a free account');
  await expect(page.getByText('1 of 5 projects (limit set by staff)', { exact: true })).toBeVisible();
});

test('ADMTEN-133 lowering the seat limit removes nobody', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp);
  await inviteAddress(tenant, project.id, clientIp, 'one');
  await inviteAddress(tenant, project.id, clientIp, 'two');
  const people = async () =>
    (
      await sql<{ members: number; invites: number }>(
        `SELECT (SELECT count(*)::int FROM project_members WHERE project_id = $1) AS members,
                (SELECT count(*)::int FROM project_invitations
                  WHERE project_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL) AS invites`,
        [project.id],
      )
    )[0];
  const before = await people();
  expect(before.invites).toBe(2);
  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'Change seat limit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Seat limit' });
  await dialog.getByLabel('Limit').fill('1');
  await dialog.getByLabel('Reason').fill('Plan downgrade on request');
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Seats: 3 of 1 used (limit set by staff)', { exact: true })).toBeVisible();
  expect(await people()).toEqual(before);

  const refused = await customerRequest('POST', `/api/projects/${project.id}/invitations`, {
    token: tenant.accessToken,
    ip: clientIp,
    body: { email: `four-${randomBytes(3).toString('hex')}@e2e.example.test`, role: 'member' },
  });
  expect(refused.status).toBe(403);
  expect(String(refused.json?.message)).toMatch(/seat/i);
  expect(await people()).toEqual(before);
});

test('ADMTEN-134 seat limit validation (dialog and API)', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'Change seat limit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Seat limit' });
  const field = dialog.getByLabel('Limit');
  const save = dialog.getByRole('button', { name: 'Save limit' });
  await dialog.getByLabel('Reason').fill('A valid reason for the change');
  await field.fill('abc');
  await expect(dialog.getByText('Enter a whole number, or leave it blank for the default.', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await field.fill('1001');
  await expect(dialog.getByText('The most is 1000.', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await field.fill('');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await expect(save).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  const before = await tenantState(tenant.userId);
  const reason = 'E2E: checking the validation';
  await expectRefusals(staff, clientIp, 'PATCH', `/api/admin/tenants/${tenant.userId}/seat-limit`, [
    { body: { reason }, message: 'seatLimit must be an integer number' },
    { body: { seatLimit: -1, reason }, message: 'seatLimit must not be less than 0' },
    { body: { seatLimit: 1001, reason }, message: 'seatLimit must not be greater than 1000' },
    { body: { seatLimit: 2.5, reason }, message: 'seatLimit must be an integer number' },
  ]);
  expect(await tenantState(tenant.userId)).toEqual(before);
});

// ---- H. Suspend and reactivate

test('ADMTEN-137 suspend dialog content', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspend this tenant?' });
  await expect(dialog.getByText('This takes effect immediately and can be reversed by reactivating.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('listitem')).toHaveText([
    'Their dashboard is locked: login fails and live sessions end.',
    'Their short links stop redirecting and show an unavailable page.',
    'All sends stop: push, email, SMS, WhatsApp, journeys and in-app messages.',
    'SDK data keeps being collected, so nothing is lost while suspended.',
  ]);
  await expect(dialog.getByLabel('Reason')).toHaveValue('');
  await expect(dialog.getByText('0/500 characters, at least 10. Recorded in the audit log.', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(`Type ${tenant.email} to confirm`)).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Suspend tenant' })).toBeDisabled();
});

test('ADMTEN-138 suspend needs a reason and the exact email', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenantPage(page, tenant);
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspend this tenant?' });
  const reason = dialog.getByLabel('Reason');
  const confirm = dialog.getByLabel(`Type ${tenant.email} to confirm`);
  const submit = dialog.getByRole('button', { name: 'Suspend tenant' });

  await reason.fill('ninechars');
  await confirm.fill(tenant.email);
  await expect(submit).toBeDisabled();
  await reason.fill('Abuse report #138');
  await confirm.fill(tenant.email.toUpperCase());
  await expect(submit).toBeDisabled();
  await confirm.fill(`  ${tenant.email}  `);
  await expect(submit).toBeEnabled();
  await reason.fill('r'.repeat(501));
  const counter = dialog.getByText('501/500 characters, at least 10. Recorded in the audit log.', { exact: true });
  await expect(counter).toBeVisible();
  await expect(counter).toHaveClass(/text-destructive/);
  await expect(submit).toBeDisabled();
  await reason.fill('Abuse report #138');
  await confirm.fill(tenant.email);
  await expect(dialog.getByText('17/500 characters, at least 10. Recorded in the audit log.', { exact: true })).not.toHaveClass(
    /text-destructive/,
  );
  await expect(submit).toBeEnabled();
  // Nothing was sent while the button was off.
  expect((await userRow(tenant.userId)).suspended_at).toBeNull();
});

test('ADMTEN-141 suspend API refusals', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const suspended = await createAccount(newClientIp(), 'tenant', 'Sal Suspended');
  await adminApi('POST', `/api/admin/tenants/${suspended.userId}/suspend`, { reason: 'E2E: suspended first' }, staff.token, clientIp);
  const admin = await createAccount(newClientIp(), 'staff2', 'Sue Superadmin');
  await makeSuperAdmin(admin.userId);
  const body = { reason: 'E2E: a second suspension' };

  const cases: [Account, string][] = [
    [suspended, 'Tenant is already suspended'],
    [admin, 'A super admin cannot be suspended'],
    [staff.account, 'A super admin cannot be suspended'],
  ];
  for (const [target, message] of cases) {
    const before = await tenantState(target.userId);
    const response = await adminRequest('POST', `/api/admin/tenants/${target.userId}/suspend`, { token: staff.token, ip: clientIp, body });
    expect.soft(response.status, target.email).toBe(409);
    expect.soft(response.json?.message, target.email).toBe(message);
    expect.soft(await tenantState(target.userId), target.email).toEqual(before);
  }
  expect(await auditRows({ action: 'tenant.suspended', targetId: suspended.userId })).toHaveLength(1);
});

test('ADMTEN-142 two staff suspending at once write one suspension', async ({ page, browser, baseURL, clientIp }) => {
  const first = await signedInStaff(page, clientIp);
  const second = await newPersonContext(browser, baseURL);
  try {
    const other = await signedInStaff(await second.context.newPage(), second.ip, 'Ola Other');
    const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
    const before = await userRow(tenant.userId);
    const suspend = (staff: Staff, ip: string) =>
      adminRequest('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { token: staff.token, ip, body: { reason: `E2E: suspended by ${staff.account.name}` } });
    const results = await Promise.all([suspend(first, clientIp), suspend(other, second.ip)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.json?.message).toBe('Tenant is already suspended');
    expect(await auditRows({ action: 'tenant.suspended', targetId: tenant.userId })).toHaveLength(1);
    expect((await userRow(tenant.userId)).session_version).toBe(before.session_version + 1);
  } finally {
    await second.context.close();
  }
});

test('ADMTEN-143 suspend reason validation (API)', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const path = `/api/admin/tenants/${tenant.userId}/suspend`;
  const none = await adminRequest('POST', path, { token: staff.token, ip: clientIp });
  expect(none.status).toBe(400);
  expect(none.json?.message).toEqual(
    expect.arrayContaining(['reason must be longer than or equal to 10 characters', 'reason must be a string']),
  );
  await expectRefusals(staff, clientIp, 'POST', path, [
    { body: { reason: '         a' }, message: 'reason must be longer than or equal to 10 characters' },
    { body: { reason: 'r'.repeat(501) }, message: 'reason must be shorter than or equal to 500 characters' },
    { body: { reason: { text: 'an object reason' } }, message: 'reason must be a string' },
    { body: { reason: 'E2E: null\u0000character' }, message: 'reason must not contain null characters' },
  ]);
  const user = await userRow(tenant.userId);
  expect(user.suspended_at).toBeNull();
  expect(await auditRows({ action: 'tenant.suspended', targetId: tenant.userId })).toHaveLength(0);
});

test('ADMTEN-148 suspending a former staff member cancels the resets they asked for', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const former = await createAccount(newClientIp(), 'former', 'Fred Former');
  await makeSuperAdmin(former.userId);
  const owner = await createAccount(newClientIp(), 'owner', 'Olive Owner');
  const resetId = await seedPendingFactorReset({ userId: owner.userId, requestedBy: { userId: former.userId, email: former.email } });
  // Super admin taken away in SQL, not by the CLI, so the reset is still waiting.
  await sql(`UPDATE users SET is_super_admin = false WHERE id = $1`, [former.userId]);
  expect((await factorResetRows(owner.userId)).map((row) => row.status)).toEqual(['pending']);
  const since = new Date();

  await adminApi('POST', `/api/admin/tenants/${former.userId}/suspend`, { reason: 'E2E: former staff member suspended' }, staff.token, clientIp);

  const [reset] = await factorResetRows(owner.userId);
  expect(reset).toMatchObject({ id: resetId, status: 'cancelled', cancelled_by: 'refused' });
  expect(reset.cancelled_at).not.toBeNull();
  const audit = await auditRows({ action: 'account.factors_reset_cancelled', targetId: owner.userId });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor_id: staff.account.userId, target_label: owner.email });
  expect(audit[0].metadata).toMatchObject({ resetId, cancelledBy: 'refused', refusal: 'requester_suspended', requestedById: former.userId });
  await waitForMail(owner.email, { subjectIncludes: 'The removal of your Chumbaq second factors was cancelled', since });
});

test('ADMTEN-151 reactivate refusals and validation', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const path = `/api/admin/tenants/${tenant.userId}/reactivate`;
  const active = await adminRequest('POST', path, { token: staff.token, ip: clientIp, body: { reason: 'E2E: reactivating an active one' } });
  expect(active.status).toBe(409);
  expect(active.json?.message).toBe('Tenant is not suspended');

  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { reason: 'E2E: suspended for the check' }, staff.token, clientIp);
  const short = await adminRequest('POST', path, { token: staff.token, ip: clientIp, body: { reason: 'short' } });
  expect(short.status).toBe(400);
  expect(short.json?.message).toEqual(['reason must be longer than or equal to 10 characters']);
  expect((await userRow(tenant.userId)).suspended_at).not.toBeNull();
  expect(await auditRows({ action: 'tenant.reactivated', targetId: tenant.userId })).toHaveLength(0);
});

test('ADMTEN-153 reactivation moves journey runs on by the suspension length', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp);
  const journey = await insertDraftJourney(project.id);
  const moved = await insertJourneyRun(project.id, journey, 'active', 3600);
  const completed = await insertJourneyRun(project.id, journey, 'completed', 3600);
  const exited = await insertJourneyRun(project.id, journey, 'exited', 7200);
  const working = await insertJourneyRun(project.id, journey, 'active', null);
  const before = {
    moved: (await runDueAt(moved))!.getTime(),
    completed: (await runDueAt(completed))!.getTime(),
    exited: (await runDueAt(exited))!.getTime(),
  };

  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { reason: 'E2E: suspended for two days' }, staff.token, clientIp);
  await sql(`UPDATE users SET suspended_at = now() - interval '2 days' WHERE id = $1`, [tenant.userId]);

  const reactivate = () =>
    adminRequest('POST', `/api/admin/tenants/${tenant.userId}/reactivate`, {
      token: staff.token,
      ip: clientIp,
      body: { reason: 'E2E: resolved with the owner' },
    });
  const results = await Promise.all([reactivate(), reactivate()]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);

  const shift = (await runDueAt(moved))!.getTime() - before.moved;
  expect(Math.abs(shift - 2 * 86_400_000)).toBeLessThan(5 * 60_000);
  expect((await runDueAt(completed))!.getTime()).toBe(before.completed);
  expect((await runDueAt(exited))!.getTime()).toBe(before.exited);
  expect(await runDueAt(working)).toBeNull();
  expect(await auditRows({ action: 'tenant.reactivated', targetId: tenant.userId })).toHaveLength(1);
});

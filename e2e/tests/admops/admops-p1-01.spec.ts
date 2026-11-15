import { randomUUID } from 'crypto';
import type { Page, Request } from '@playwright/test';
import { ANNEXURE_I } from '../../../apps/api/src/modules/incidents/annexure-i';
import { enrolAndSignInStaff, grantSuperAdmin } from '../../support/admin';
import { createAccount, newClientIp, uniqueEmail } from '../../support/api';
import { fixedLocaleContext, readDownload } from '../../support/browser-tools';
import { expect, test } from '../../support/fixtures';
import {
  adminRequest,
  adminUrl,
  auditRowsWhere,
  auditTableRows,
  breadcrumbSection,
  cardTitled,
  csvRecords,
  forwardAdminPrefix,
  healthBody,
  hex,
  incidentByTitle,
  incidentRow,
  openAdminPage,
  parseCsv,
  rawRequest,
  recordIncident,
  seedAuditRows,
  seedBulkAuditRows,
  serveHealth,
  sidebarItem,
  signedInStaff,
  sql,
  startAdminApiWith,
  toastItem,
} from '../../support/areas/admops';

/**
 * Staff operations, P1: navigation and access, the audit log page (columns, filters,
 * paging, URL state), the audit log API and its export, platform health and recording
 * incidents.
 */

test.describe.configure({ mode: 'parallel' });

const PASSKEY_REQUIRED = 'Staff access needs two passkeys and a passkey sign-in.';
const TENANT_ID_ERROR = 'Tenant ID must be a full ID, as shown in the tenant page address.';
const DATE_FORM_ERROR = 'Dates must be in the form YYYY-MM-DD.';
const DATE_ORDER_ERROR = 'The end date is before the start date.';
const NO_MATCH = 'No audit entries match these filters.';
const CSV_HEADER = 'created_at,actor_email,actor_id,action,target_type,target_id,target_label,reason,ip_address,metadata,id';

const isAuditList = (request: Request) => new URL(request.url()).pathname === '/api/admin/audit-logs';
const isAuditExport = (request: Request) => new URL(request.url()).pathname === '/api/admin/audit-logs/export';

/** Every list request the page sends, from now on. */
function recordAuditListRequests(page: Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (request) => {
    if (isAuditList(request)) seen.push(new URL(request.url()));
  });
  return seen;
}

/** Opens the audit log and waits for its first list answer, so later requests are the test's own. */
async function openAuditLogSettled(page: Page): Promise<void> {
  const first = page.waitForResponse((response) => isAuditList(response.request()));
  await openAdminPage(page, '/audit-log', 'Audit log');
  await first;
}

/** Clicks "Apply filters" and answers the list request it sent. */
async function applyFilters(page: Page): Promise<URL> {
  const [request] = await Promise.all([page.waitForRequest(isAuditList), page.getByRole('button', { name: 'Apply filters' }).click()]);
  return new URL(request.url());
}

async function filterByActor(page: Page, actorEmail: string): Promise<URL> {
  await page.getByLabel('Actor email').fill(actorEmail);
  return applyFilters(page);
}

/** The text of one column (0-based) of every audit table row. */
function auditColumn(page: Page, index: number): Promise<string[]> {
  return auditTableRows(page).evaluateAll(
    (rows, i) => rows.map((row) => (row.querySelectorAll('td')[i]?.textContent ?? '').trim()),
    index,
  );
}

function exportUrl(params: Record<string, string>): string {
  return `/api/admin/audit-logs/export?${new URLSearchParams(params)}`;
}

function listUrl(params: Record<string, string>): string {
  return `/api/admin/audit-logs?${new URLSearchParams(params)}`;
}

function messages(json: any): string[] {
  const message = json?.message;
  return Array.isArray(message) ? message : [message];
}

// ---------------------------------------------------------------- Access and navigation

test('ADMOPS-001 sidebar opens the three operations pages', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await page.goto(adminUrl('/'));
  await expect(sidebarItem(page, 'Overview')).toHaveAttribute('data-active', 'true');

  const pages = [
    { name: 'Audit log', path: '/audit-log' },
    { name: 'Incidents', path: '/incidents' },
    { name: 'Platform health', path: '/health' },
  ];
  for (const target of pages) {
    await sidebarItem(page, target.name).click();
    await expect(page).toHaveURL(adminUrl(target.path));
    await expect(page.getByRole('heading', { name: target.name, level: 1 })).toBeVisible();
    await expect(sidebarItem(page, target.name)).toHaveAttribute('data-active', 'true');
    for (const other of pages.filter((p) => p !== target)) {
      await expect(sidebarItem(page, other.name)).toHaveAttribute('data-active', 'false');
    }
    await expect(sidebarItem(page, 'Overview')).toHaveAttribute('data-active', 'false');
    await expect(breadcrumbSection(page)).toHaveText(target.name);
  }
});

test('ADMOPS-003 reload and deep links keep the operations pages', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const reasons = [`E2E 003 a ${hex()}`, `E2E 003 b ${hex()}`];
  await seedAuditRows(reasons.map((reason) => ({ actorEmail: staff.account.email, reason })));
  const incident = await recordIncident(staff.token, clientIp, { title: `E2E incident 003 ${hex()}` });

  await page.goto(adminUrl(`/audit-log?actorEmail=${encodeURIComponent(staff.account.email)}&page=1`));
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await expect(page.getByRole('cell', { name: reasons[0] })).toBeVisible();
  const before = await auditColumn(page, 4);
  await page.reload();
  await expect(page).toHaveURL(/\/audit-log\?/);
  await expect(page.getByLabel('Actor email')).toHaveValue(staff.account.email);
  await expect(page.getByRole('cell', { name: reasons[0] })).toBeVisible();
  await expect(page.getByRole('cell', { name: reasons[1] })).toBeVisible();
  expect((await auditColumn(page, 4)).slice(0, before.length)).toEqual(before);
  expect(new Set(await auditColumn(page, 1))).toEqual(new Set([staff.account.email]));

  await page.goto(adminUrl(`/incidents/${incident.id}`));
  await expect(page.getByRole('heading', { name: incident.title, level: 1 })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(adminUrl(`/incidents/${incident.id}`));
  await expect(page.getByRole('heading', { name: incident.title, level: 1 })).toBeVisible();

  await page.goto(adminUrl('/health'));
  await expect(page.getByRole('heading', { name: 'Platform health', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(adminUrl('/health'));
  await expect(page.getByRole('heading', { name: 'Platform health', level: 1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Operational' })).toBeVisible();
  await expect(page).not.toHaveURL(/sign-in/);
});

test('ADMOPS-007 passkey requirement on: operations pages show "Set up your passkeys to continue"', async ({ page, clientIp }) => {
  test.slow();
  const staff = await signedInStaff(page, clientIp);
  const strict = await startAdminApiWith({ SUPER_ADMIN_PASSKEY_REQUIRED: 'true' }, 'passkey-required', 70);
  try {
    // The lane's own admin API lets this one-passkey session through; the strict one refuses it.
    expect((await adminRequest('GET', '/api/admin/health', { token: staff.token, ip: clientIp })).status).toBe(200);
    for (const pathname of ['/api/admin/audit-logs', '/api/admin/health', '/api/admin/incidents']) {
      const refused = await rawRequest(`${strict.url}${pathname}`, 'GET', undefined, {
        Authorization: `Bearer ${staff.token}`,
        'X-Forwarded-For': clientIp,
      });
      expect({ pathname, status: refused.status, message: refused.json?.message }).toEqual({ pathname, status: 403, message: PASSKEY_REQUIRED });
    }

    await forwardAdminPrefix(page, strict.url, '/api/admin/');
    const passkeyState = (scope: ReturnType<Page['locator']>) => scope.getByRole('alert').filter({ hasText: 'Set up your passkeys to continue' });
    const checkState = async (scope: ReturnType<Page['locator']>) => {
      const state = passkeyState(scope);
      await expect(state).toBeVisible();
      await expect(state).toContainText('Staff access needs two passkeys, and a sign-in that used one.');
      await expect(state.getByRole('link', { name: 'Go to your account' })).toHaveAttribute('href', '/account');
    };

    const answered: Record<string, number[]> = {};
    page.on('response', (r) => {
      const pathname = new URL(r.url()).pathname;
      (answered[pathname] ??= []).push(r.status());
    });
    await openAdminPage(page, '/audit-log', 'Audit log');
    await checkState(page.locator('main'));
    // A 403 is not retried.
    expect(answered['/api/admin/audit-logs']).toEqual([403]);

    await openAdminPage(page, '/health', 'Platform health');
    await checkState(page.locator('main'));
    expect(answered['/api/admin/health']).toEqual([403]);
    await expect(page.getByText('Operational', { exact: true })).toHaveCount(0);

    await openAdminPage(page, '/incidents', 'Incidents');
    await checkState(cardTitled(page, 'Incidents'));
    await checkState(cardTitled(page, 'Recent alarms'));
    // Only once their own requests were refused does an empty Traps list or a missing contact card mean anything.
    await expect.poll(() => answered['/api/admin/tripwires']?.[0]).toBe(403);
    await expect.poll(() => answered['/api/admin/security-contact']?.[0]).toBe(403);
    await expect(passkeyState(cardTitled(page, 'Traps'))).toHaveCount(0);
    await expect(cardTitled(page, 'Traps').locator('li')).toHaveCount(0);
    await expect(cardTitled(page, 'Security contact')).toHaveCount(0);

    await passkeyState(page.locator('main')).first().getByRole('link', { name: 'Go to your account' }).click();
    await expect(page).toHaveURL(adminUrl('/account'));
  } finally {
    await strict.stop();
  }
});

// ---------------------------------------------------------------- Audit log page: rows

test('ADMOPS-011 actor shows "CLI" for command-line rows and a missing actor email', async ({ page, clientIp }) => {
  const account = await createAccount(clientIp, 'cli-staff', 'Cleo Cli');
  await grantSuperAdmin(account.email);
  await enrolAndSignInStaff(page, account);
  const [granted] = await auditRowsWhere({ action: 'super_admin.granted', targetId: account.userId });
  expect(granted).toMatchObject({ actor_email: 'cli', actor_id: null, target_type: 'user', target_label: account.email });

  await openAdminPage(page, '/audit-log', 'Audit log');
  await page.getByLabel('Actor email').fill('cli');
  await page.getByLabel('Tenant ID').fill(account.userId);
  const request = await applyFilters(page);
  expect(request.searchParams.get('actorEmail')).toBe('cli');
  expect(request.searchParams.get('targetId')).toBe(account.userId);

  await expect(auditTableRows(page)).toHaveCount(1);
  const row = auditTableRows(page).first();
  await expect(row.locator('td').nth(1)).toHaveText('CLI');
  await expect(row.locator('td').nth(1)).toHaveAttribute('title', 'CLI');
  await expect(row.locator('td').nth(2)).toHaveText('Super admin granted');
  await expect(row.locator('td').nth(3)).toHaveText(account.email);
  // A user target, not a tenant one: plain text.
  await expect(row.locator('td').nth(3).getByRole('link')).toHaveCount(0);

  // A row with no actor email (unreachable from the database, where the column is NOT
  // NULL): the API's own answer for this row, with the actor email taken out.
  await page.route(
    (url) => url.pathname === '/api/admin/audit-logs',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const log of body.data) log.actorEmail = null;
      await route.fulfill({ response, json: body });
    },
  );
  await page.reload();
  await expect(auditTableRows(page)).toHaveCount(1);
  await expect(auditTableRows(page).first().locator('td').nth(1)).toHaveText('CLI');
  await expect(auditTableRows(page).first().locator('td').nth(2)).toHaveText('Super admin granted');
});

test('ADMOPS-013 target cell: tenant link, plain text for other targets, dash for none', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-013');
  const tenantId = randomUUID();
  const bareTenantId = randomUUID();
  const incidentId = randomUUID();
  const tenantLabel = `tenant-${hex()}@e2e.example.test`;
  const incidentLabel = `E2E incident label ${hex()}`;
  const now = Date.now();
  await seedAuditRows([
    { actorEmail: actor, reason: 'r1 tenant', targetType: 'tenant', targetId: tenantId, targetLabel: tenantLabel, createdAt: new Date(now - 1000) },
    { actorEmail: actor, reason: 'r2 incident', targetType: 'incident', targetId: incidentId, targetLabel: incidentLabel, createdAt: new Date(now - 2000) },
    { actorEmail: actor, reason: 'r3 bare tenant', targetType: 'tenant', targetId: bareTenantId, targetLabel: null, createdAt: new Date(now - 3000) },
    { actorEmail: actor, reason: 'r4 none', targetType: 'audit_log', targetId: null, targetLabel: null, createdAt: new Date(now - 4000) },
  ]);

  await openAdminPage(page, '/audit-log', 'Audit log');
  await filterByActor(page, actor);
  await expect(auditTableRows(page)).toHaveCount(4);
  const target = (i: number) => auditTableRows(page).nth(i).locator('td').nth(3);

  await expect(target(0).getByRole('link', { name: tenantLabel })).toHaveAttribute('href', `/tenants/${tenantId}`);
  await expect(target(0)).toHaveAttribute('title', tenantLabel);
  await expect(target(0)).toHaveClass(/\btruncate\b/);

  await expect(target(1)).toHaveText(incidentLabel);
  await expect(target(1).getByRole('link')).toHaveCount(0);
  await expect(target(1)).toHaveAttribute('title', incidentLabel);

  await expect(target(2).getByRole('link', { name: bareTenantId })).toHaveAttribute('href', `/tenants/${bareTenantId}`);
  await expect(target(2)).toHaveAttribute('title', bareTenantId);

  await expect(target(3)).toHaveText('-');
  await expect(target(3).getByRole('link')).toHaveCount(0);
  expect(await target(3).getAttribute('title')).toBeNull();

  await target(0).getByRole('link', { name: tenantLabel }).click();
  await expect(page).toHaveURL(adminUrl(`/tenants/${tenantId}`));
});

test('ADMOPS-018 a load failure shows "Could not load the audit log." and Try again recovers', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-018');
  await seedAuditRows([{ actorEmail: actor, reason: 'E2E 018 row' }]);
  let failures = 0;
  let passed = 0;
  await page.route(
    (url) => url.pathname === '/api/admin/audit-logs',
    async (route) => {
      if (failures < 2) {
        failures++;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) });
      } else {
        passed++;
        await route.fallback();
      }
    },
  );

  await page.goto(adminUrl(`/audit-log?actorEmail=${encodeURIComponent(actor)}`));
  const failed = page.getByRole('alert').filter({ hasText: 'Could not load the audit log.' });
  await expect(failed).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
  // One automatic retry before the error shows, and nothing more until asked.
  expect(failures).toBe(2);
  expect(passed).toBe(0);

  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('cell', { name: 'E2E 018 row' })).toBeVisible();
  await expect(failed).toHaveCount(0);
  expect(passed).toBe(1);
});

// ---------------------------------------------------------------- Audit log page: paging

test('ADMOPS-019 paging 20 rows at a time with Previous and Next', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const actor = uniqueEmail('bulk-019');
  await seedBulkAuditRows(actor, 45, { reasonPrefix: 'E2E 019 row' });

  await openAdminPage(page, '/audit-log', 'Audit log');
  await filterByActor(page, actor);
  const previous = page.getByRole('button', { name: 'Previous' });
  const next = page.getByRole('button', { name: 'Next' });
  const showing = page.getByText(/^Showing \d+-\d+ of \d+$/);

  await expect(showing).toHaveText('Showing 1-20 of 45');
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  const page1 = await auditColumn(page, 4);
  expect(page1).toHaveLength(20);
  expect(page1[0]).toBe('E2E 019 row 45');

  await next.click();
  await expect(page).toHaveURL(/[?&]page=2(&|$)/);
  await expect(showing).toHaveText('Showing 21-40 of 45');
  await expect(auditTableRows(page).first()).toContainText('E2E 019 row 25');
  const page2 = await auditColumn(page, 4);

  await next.click();
  await expect(page).toHaveURL(/[?&]page=3(&|$)/);
  await expect(showing).toHaveText('Showing 41-45 of 45');
  await expect(auditTableRows(page)).toHaveCount(5);
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  const page3 = await auditColumn(page, 4);

  await previous.click();
  await expect(page).toHaveURL(/[?&]page=2(&|$)/);
  await expect(showing).toHaveText('Showing 21-40 of 45');
  expect(await auditColumn(page, 4)).toEqual(page2);

  const all = [...page1, ...page2, ...page3];
  expect(new Set(all).size).toBe(45);
  expect(all).toEqual(Array.from({ length: 45 }, (_, i) => `E2E 019 row ${45 - i}`));
});

// ---------------------------------------------------------------- Audit log page: filters

test('ADMOPS-024 action filter: one, several, summary label, menu stays open', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-024');
  await seedAuditRows([
    { actorEmail: actor, action: 'tenant.suspended', reason: 'E2E 024 suspended 1' },
    { actorEmail: actor, action: 'tenant.suspended', reason: 'E2E 024 suspended 2' },
    { actorEmail: actor, action: 'tenant.reactivated', reason: 'E2E 024 reactivated' },
    { actorEmail: actor, action: 'audit_log.exported', reason: 'E2E 024 exported' },
  ]);

  await openAdminPage(page, '/audit-log', 'Audit log');
  // By attribute: while the menu is open the rest of the page is hidden from the accessibility tree.
  const trigger = page.locator('button[aria-label="Filter by action"]');
  await expect(trigger).toHaveText('All actions');
  await trigger.click();
  // Ticked out of the list's order: the URL keeps the list's order.
  await page.getByRole('menuitemcheckbox', { name: 'Tenant reactivated', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Tenant suspended', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Tenant reactivated', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(trigger).toHaveText('Tenant reactivated');
  await page.getByRole('menuitemcheckbox', { name: 'Tenant suspended', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(trigger).toHaveText('2 actions');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  const request = await filterByActor(page, actor);
  expect(new URL(page.url()).searchParams.get('action')).toBe('tenant.suspended,tenant.reactivated');
  expect(request.searchParams.getAll('action')).toEqual(['tenant.suspended,tenant.reactivated']);
  expect([...request.searchParams.keys()].some((key) => key.startsWith('action['))).toBe(false);

  await expect(auditTableRows(page)).toHaveCount(3);
  expect((await auditColumn(page, 2)).sort()).toEqual(['Tenant reactivated', 'Tenant suspended', 'Tenant suspended']);
  await expect(page.getByRole('cell', { name: 'E2E 024 exported' })).toHaveCount(0);
});

test('ADMOPS-026 actor email filter: exact match, trimmed and case-insensitive', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const id = hex();
  const actor = `ops-${id}@e2e.example.test`;
  await seedAuditRows([1, 2].map((n) => ({ actorEmail: actor, reason: `E2E 026 row ${n}` })));

  await openAdminPage(page, '/audit-log', 'Audit log');
  const input = page.getByLabel('Actor email');
  await expect(input).toHaveAttribute('placeholder', 'ops@chumbaq.com, or cli');
  await expect(input).toHaveAttribute('maxlength', '255');

  const sent = await filterByActor(page, `  OPS-${id}@E2E.example.test  `);
  expect(new URL(page.url()).searchParams.get('actorEmail')).toBe(`OPS-${id}@E2E.example.test`);
  expect(sent.searchParams.get('actorEmail')).toBe(`OPS-${id}@E2E.example.test`);
  await expect(auditTableRows(page)).toHaveCount(2);
  expect(await auditColumn(page, 1)).toEqual([actor, actor]);

  await filterByActor(page, `ops-${id}`);
  await expect(page.getByText(NO_MATCH, { exact: true })).toBeVisible();
  await expect(auditTableRows(page)).toHaveCount(0);
});

test('ADMOPS-027 tenant ID filter refuses anything but a full UUID', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const targetId = randomUUID();
  const actor = uniqueEmail('seed-027');
  await seedAuditRows([{ actorEmail: actor, targetType: 'tenant', targetId, targetLabel: `t-${hex()}@e2e.example.test`, reason: 'E2E 027 row' }]);

  await openAuditLogSettled(page);
  const seen = recordAuditListRequests(page);
  const apply = page.getByRole('button', { name: 'Apply filters' });
  await page.getByLabel('Tenant ID').fill('1234');
  await expect(page.getByRole('alert')).toHaveText(TENANT_ID_ERROR);
  await expect(apply).toBeDisabled();
  await page.getByLabel('Tenant ID').press('Enter');

  await page.getByLabel('Tenant ID').fill(targetId);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(apply).toBeEnabled();
  const sent = await applyFilters(page);
  // The apply's request is the only one since the page settled: the refused Enter sent nothing.
  expect(seen.map(String)).toEqual([sent.toString()]);
  expect(sent.searchParams.get('targetId')).toBe(targetId);
  await expect(auditTableRows(page)).toHaveCount(1);
  await expect(auditTableRows(page).first()).toContainText('E2E 027 row');
});

test('ADMOPS-030 end date before start date is refused before sending', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await openAuditLogSettled(page);
  const seen = recordAuditListRequests(page);
  const apply = page.getByRole('button', { name: 'Apply filters' });

  await page.getByLabel('From', { exact: true }).fill('2026-11-10');
  await page.getByLabel('To (inclusive)').fill('2026-11-09');
  await expect(page.getByRole('alert')).toHaveText(DATE_ORDER_ERROR);
  await expect(apply).toBeDisabled();
  await page.getByLabel('To (inclusive)').press('Enter');
  expect(new URL(page.url()).searchParams.get('from')).toBeNull();

  await page.getByLabel('To (inclusive)').fill('2026-11-10');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(apply).toBeEnabled();
  const sent = await applyFilters(page);
  // The apply's request is the only one since the page settled: the refused Enter sent nothing.
  expect(seen.map(String)).toEqual([sent.toString()]);
  expect(new URL(page.url()).searchParams.get('from')).toBe('2026-11-10');
  expect(new URL(page.url()).searchParams.get('to')).toBe('2026-11-10');
  expect(Date.parse(sent.searchParams.get('to')!) - Date.parse(sent.searchParams.get('from')!)).toBe(24 * 3600_000);
});

test('ADMOPS-031 malformed dates in a pasted URL are reported, and export is disabled', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const seen = recordAuditListRequests(page);
  for (const query of ['from=yesterday', 'to=2026/11/06']) {
    seen.length = 0;
    await page.goto(adminUrl(`/audit-log?${query}`));
    await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
    const inTable = page.locator('[data-slot="card-content"] div.text-destructive', { hasText: DATE_FORM_ERROR });
    await expect(inTable).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText(DATE_FORM_ERROR);
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Apply filters' })).toBeDisabled();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      expect.soft({ query, from: url.searchParams.get('from'), to: url.searchParams.get('to') }).toEqual({ query, from: null, to: null });
    }
  }
});

test('ADMOPS-036 Back and Forward restore the applied filters into the form', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const actorA = uniqueEmail('seed-036a');
  const actorB = uniqueEmail('seed-036b');
  await seedAuditRows([
    { actorEmail: actorA, reason: 'E2E 036 row A' },
    { actorEmail: actorB, reason: 'E2E 036 row B' },
  ]);

  await openAdminPage(page, '/audit-log', 'Audit log');
  await filterByActor(page, actorA);
  await expect(page.getByRole('cell', { name: 'E2E 036 row A' })).toBeVisible();
  await filterByActor(page, actorB);
  await expect(page.getByRole('cell', { name: 'E2E 036 row B' })).toBeVisible();

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('actorEmail')).toBe(actorA);
  await expect(page.getByLabel('Actor email')).toHaveValue(actorA);
  await expect(page.getByRole('cell', { name: 'E2E 036 row A' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'E2E 036 row B' })).toHaveCount(0);

  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('actorEmail')).toBe(actorB);
  await expect(page.getByLabel('Actor email')).toHaveValue(actorB);
  await expect(page.getByRole('cell', { name: 'E2E 036 row B' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'E2E 036 row A' })).toHaveCount(0);
});

test("ADMOPS-037 landing from the tenant page's full-history link shows staff views", async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant-037', 'Tia Tenant');
  const viewed = await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp });
  expect(viewed.status).toBe(200);

  await page.goto(adminUrl(`/audit-log?targetId=${tenant.userId}`));
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Tenant ID')).toHaveValue(tenant.userId);
  const row = auditTableRows(page).filter({ hasText: 'Tenant viewed by staff' }).filter({ hasText: staff.account.email });
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(1)).toHaveText(staff.account.email);
  await expect(row.locator('td').nth(3).getByRole('link', { name: tenant.email })).toHaveAttribute('href', `/tenants/${tenant.userId}`);
  await expect(row.locator('td').nth(5)).toHaveText(clientIp);
});

// ---------------------------------------------------------------- Audit log API

test('ADMOPS-038 the list answers its page and meta', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('bulk-038');
  await seedBulkAuditRows(actor, 45, { reasonPrefix: 'E2E 038 row' });
  const get = (params: Record<string, string>) => adminRequest('GET', listUrl({ actorEmail: actor, ...params }), { token: staff.token, ip: clientIp });

  const first = await get({});
  expect(first.status).toBe(200);
  expect(first.json.meta).toEqual({ total: 45, page: 1, limit: 20, totalPages: 3 });
  expect(first.json.data).toHaveLength(20);
  for (const row of first.json.data) {
    expect(Object.keys(row).sort()).toEqual(
      ['action', 'actorEmail', 'actorId', 'createdAt', 'id', 'ipAddress', 'metadata', 'reason', 'targetId', 'targetLabel', 'targetType'].sort(),
    );
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.actorEmail).toBe(actor);
  }
  expect(first.json.data[0].reason).toBe('E2E 038 row 45');

  const third = await get({ page: '3', limit: '20' });
  expect(third.json.meta).toEqual({ total: 45, page: 3, limit: 20, totalPages: 3 });
  expect((third.json.data as { reason: string }[]).map((r) => r.reason)).toEqual([5, 4, 3, 2, 1].map((n) => `E2E 038 row ${n}`));

  const all = await get({ limit: '100' });
  expect(all.json.meta).toEqual({ total: 45, page: 1, limit: 100, totalPages: 1 });
  expect(all.json.data).toHaveLength(45);
});

test('ADMOPS-040 list validation: filters', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const cases: { query: string; message: string | RegExp }[] = [
    { query: 'actorId=abc', message: 'actorId must be a UUID' },
    { query: 'targetId=abc', message: 'targetId must be a UUID' },
    { query: 'from=yesterday', message: 'from must be a valid ISO 8601 date string' },
    { query: 'to=2026-11-06T25:00:00Z', message: 'to must be a valid ISO 8601 date string' },
    { query: 'action=nope', message: /^each value in action must be one of the following values: tripwire\.created, / },
    { query: 'action=', message: /^each value in action must be one of the following values: / },
    { query: `actorEmail=${'a'.repeat(256)}`, message: 'actorEmail must be shorter than or equal to 255 characters' },
    { query: 'actorEmail=%00', message: 'actorEmail must not be empty or contain null characters' },
    { query: 'foo=1', message: 'property foo should not exist' },
  ];
  for (const { query, message } of cases) {
    const response = await adminRequest('GET', `/api/admin/audit-logs?${query}`, { token: staff.token, ip: clientIp });
    expect.soft(response.status, query).toBe(400);
    const got = messages(response.json);
    expect.soft(got.some((m) => (typeof message === 'string' ? m === message : message.test(m))), `${query}: ${JSON.stringify(got)}`).toBe(true);
  }
  // Control: a well-formed set of the same filters is accepted.
  const ok = await adminRequest(
    'GET',
    listUrl({ actorId: randomUUID(), targetId: randomUUID(), from: '2026-11-05T00:00:00Z', to: '2026-11-06T23:00:00Z', action: 'tenant.viewed', actorEmail: 'x@e2e.example.test' }),
    { token: staff.token, ip: clientIp },
  );
  expect(ok.status).toBe(200);
});

// ---------------------------------------------------------------- Audit log export

test('ADMOPS-047 export file format: BOM, header, CRLF, column order, JSON metadata', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-047');
  const targetId = randomUUID();
  const full = '2026-11-01T10:00:00.000Z';
  const bare = '2026-11-01T09:00:00.000Z';
  const [fullRow] = await sql<{ id: string }>(
    `INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_type, target_id, target_label, reason, metadata, ip_address, created_at)
     VALUES ($1, $2, 'tenant.suspended', 'tenant', $3, 'label-047', 'reason 047', '{"a":1}', '203.0.113.47', $4) RETURNING id`,
    [staff.account.userId, actor, targetId, full],
  );
  const [bareId] = await seedAuditRows([{ actorEmail: actor, action: 'tenant.reactivated', targetType: 'user', createdAt: bare }]);

  const response = await adminRequest('GET', exportUrl({ actorEmail: actor }), { token: staff.token, ip: clientIp });
  expect(response.status).toBe(200);
  expect(response.json).toBeNull();
  expect(response.text.startsWith('﻿')).toBe(true);
  expect(Buffer.from(response.text, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  const body = response.text.slice(1);
  expect(body.endsWith('\r\n')).toBe(true);
  expect(body.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  const lines = body.split('\r\n');
  expect(lines.pop()).toBe('');
  expect(lines).toEqual([
    CSV_HEADER,
    `${full},${actor},${staff.account.userId},tenant.suspended,tenant,${targetId},label-047,reason 047,203.0.113.47,"{""a"":1}",${fullRow.id}`,
    `${bare},${actor},,tenant.reactivated,user,,,,,,${bareId}`,
  ]);
});

test('ADMOPS-048 export headers', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-048');
  await seedAuditRows([1, 2].map((n) => ({ actorEmail: actor, reason: `E2E 048 row ${n}` })));
  const startedAt = Date.now();
  const response = await adminRequest('GET', exportUrl({ actorEmail: actor }), { token: staff.token, ip: clientIp });
  expect(response.status).toBe(200);
  const h = (name: string) => response.headers.get(name);
  expect(h('content-type')).toBe('text/csv; charset=utf-8');
  const disposition = h('content-disposition')!;
  const [, d, t] = /^attachment; filename="chumbaq-audit-log-(\d{8})-(\d{6})\.csv"$/.exec(disposition) ?? [];
  expect(disposition).toMatch(/^attachment; filename="chumbaq-audit-log-\d{8}-\d{6}\.csv"$/);
  const stamp = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`);
  expect(Math.abs(stamp - startedAt)).toBeLessThan(60_000);
  expect(h('cache-control')).toBe('no-store');
  expect(h('x-export-row-count')).toBe('2');
  expect(csvRecords(response.text)).toHaveLength(2);
  expect(h('x-export-row-cap')).toBe('10000');
  expect(h('x-export-truncated')).toBe('false');
  expect(h('access-control-expose-headers')).toBe('Content-Disposition, X-Export-Row-Count, X-Export-Row-Cap, X-Export-Truncated');
});

test('ADMOPS-050 export quotes commas, quotes and line breaks', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('seed-050');
  const reason = 'He said "stop", then\nleft';
  await seedAuditRows([{ actorEmail: actor, reason }]);
  const response = await adminRequest('GET', exportUrl({ actorEmail: actor }), { token: staff.token, ip: clientIp });
  expect(response.status).toBe(200);
  expect(response.headers.get('x-export-row-count')).toBe('1');
  expect(response.text).toContain(',"He said ""stop"", then\nleft",');
  const records = csvRecords(response.text);
  expect(records).toHaveLength(1);
  expect(records[0].reason).toBe(reason);
  expect(records[0].actor_email).toBe(actor);
  expect(parseCsv(response.text.slice(1))).toHaveLength(2);
});

test('ADMOPS-052 export over the 10,000-row cap keeps the newest and says so', async ({ page, clientIp }) => {
  test.slow();
  const staff = await signedInStaff(page, clientIp);
  const actor = uniqueEmail('bulk-052');
  await seedBulkAuditRows(actor, 10_001, { reasonPrefix: 'E2E 052 row' });

  await openAdminPage(page, '/audit-log', 'Audit log');
  await filterByActor(page, actor);
  await expect(page.getByText('Showing 1-20 of 10,001', { exact: true })).toBeVisible();

  const [download, response] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.waitForResponse((r) => isAuditExport(r.request()), { timeout: 60_000 }),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(response.headers()['x-export-row-count']).toBe('10000');
  expect(response.headers()['x-export-truncated']).toBe('true');
  const toast = toastItem(page, 'Exported the newest 10,000 rows');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('More entries match than one export holds (10,000). Narrow the dates to export the rest.');

  const file = await readDownload(download);
  const records = csvRecords(file.text);
  expect(records).toHaveLength(10_000);
  expect(records[0].reason).toBe('E2E 052 row 10001');
  expect(records[9_999].reason).toBe('E2E 052 row 2');
  expect(records.some((r) => r.reason === 'E2E 052 row 1')).toBe(false);

  const [audited] = await auditRowsWhere({ actorEmail: staff.account.email, action: 'audit_log.exported' });
  expect(audited.metadata).toEqual({ filters: { actorEmail: actor }, rowCount: 10_000, truncated: true, rowCap: 10_000 });
});

test('ADMOPS-053 export sends the same filters as the list, including dates', async ({ browser }) => {
  const { context, ip } = await fixedLocaleContext(browser, { timezoneId: 'Asia/Kolkata' });
  try {
    const page = await context.newPage();
    const staff = await signedInStaff(page, ip);
    const actor = uniqueEmail('seed-053');
    const instants = ['2026-11-05T18:29:59.000Z', '2026-11-05T18:30:00.000Z', '2026-11-06T18:29:59.000Z', '2026-11-06T18:30:00.000Z'];
    await seedAuditRows(instants.map((createdAt) => ({ actorEmail: actor, createdAt, reason: `at ${createdAt}` })));

    await openAdminPage(page, '/audit-log', 'Audit log');
    await page.getByRole('button', { name: 'Filter by action' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Tenant suspended', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Tenant reactivated', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByLabel('Actor email').fill(actor);
    await page.getByLabel('From', { exact: true }).fill('2026-11-06');
    await page.getByLabel('To (inclusive)').fill('2026-11-06');
    const list = await applyFilters(page);
    await expect(auditTableRows(page)).toHaveCount(2);

    const [exportRequest, download] = await Promise.all([
      page.waitForRequest(isAuditExport),
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const sent = new URL(exportRequest.url()).searchParams;
    const expected = {
      action: 'tenant.suspended,tenant.reactivated',
      actorEmail: actor,
      from: '2026-11-05T18:30:00.000Z',
      to: '2026-11-06T18:30:00.000Z',
    };
    const pick = (params: URLSearchParams) => ({
      action: params.get('action'),
      actorEmail: params.get('actorEmail'),
      from: params.get('from'),
      to: params.get('to'),
    });
    expect(pick(list.searchParams)).toEqual(expected);
    expect(pick(sent)).toEqual(expected);
    expect(sent.has('page')).toBe(false);
    expect(sent.has('limit')).toBe(false);

    const records = csvRecords((await readDownload(download)).text);
    expect(records.map((r) => r.reason)).toEqual([`at ${instants[2]}`, `at ${instants[1]}`]);
    await expect(toastItem(page, 'Exported 2 rows')).toBeVisible();

    const [audited] = await auditRowsWhere({ actorEmail: staff.account.email, action: 'audit_log.exported' });
    expect(audited.metadata).toEqual({
      filters: { actorEmail: actor, action: ['tenant.suspended', 'tenant.reactivated'], from: expected.from, to: expected.to },
      rowCount: 2,
      truncated: false,
      rowCap: 10_000,
    });
  } finally {
    await context.close();
  }
});

test('ADMOPS-054 export refuses what the list refuses, and paging parameters', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const exportsSoFar = async () => (await auditRowsWhere({ actorEmail: staff.account.email, action: 'audit_log.exported' })).length;
  const before = await exportsSoFar();
  const T = '2026-03-04T05:06:07.008Z';
  const cases: { params: Record<string, string>; message: string }[] = [
    { params: { from: T, to: T }, message: 'from must be before to' },
    { params: { targetId: 'abc' }, message: 'targetId must be a UUID' },
    { params: { page: '1' }, message: 'property page should not exist' },
    { params: { limit: '20' }, message: 'property limit should not exist' },
  ];
  for (const { params, message } of cases) {
    const response = await adminRequest('GET', exportUrl(params), { token: staff.token, ip: clientIp });
    expect.soft({ params, status: response.status, messages: messages(response.json) }).toEqual({ params, status: 400, messages: [message] });
  }
  expect(await exportsSoFar()).toBe(before);
  // Control: an accepted export is recorded.
  const accepted = await adminRequest('GET', exportUrl({ actorEmail: uniqueEmail('nobody-054') }), { token: staff.token, ip: clientIp });
  expect(accepted.status).toBe(200);
  expect(await exportsSoFar()).toBe(before + 1);
});

// ---------------------------------------------------------------- Platform health

test('ADMOPS-058 health page on a working stack', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await openAdminPage(page, '/health', 'Platform health');
  const banner = page.getByRole('status').filter({ hasText: 'Operational' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/Checked [A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2}:\d{2}/);
  for (const name of ['Database', 'Redis']) {
    const card = cardTitled(page, name);
    await expect(card.locator('[data-slot="card-content"] div').first()).toHaveText('OK');
    await expect(card).toContainText(/\d+ ms/);
  }
  await expect(cardTitled(page, 'Clock')).toBeVisible();
  await expect(cardTitled(page, 'Account email')).toBeVisible();
  const queues = cardTitled(page, 'Queues');
  await expect(queues.getByRole('columnheader')).toHaveText(['Queue', 'Waiting', 'Active', 'Delayed', 'Failed']);
  const rows = queues.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  const names = await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('td')?.textContent?.trim()));
  expect(names).toEqual(['push-campaign', 'cohort-sync', 'segment-materialize']);
  for (let i = 0; i < 3; i++) {
    const cells = await rows.nth(i).locator('td').allTextContents();
    expect(cells.slice(1).every((cell) => /^\d[\d,]*$/.test(cell.trim()))).toBe(true);
  }
});

test('ADMOPS-059 GET /api/admin/health answers 200 with its shape', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const startedAt = Date.now();
  const response = await adminRequest('GET', '/api/admin/health', { token: staff.token, ip: clientIp });
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  expect(response.status).toBe(200);
  const health = response.json.data;
  expect(Object.keys(response.json)).toEqual(['data']);
  expect(Object.keys(health).sort()).toEqual(['checkedAt', 'clock', 'database', 'platformEmail', 'queues', 'redis', 'status']);
  expect(health.status).toBe('ok');
  expect(Math.abs(Date.parse(health.checkedAt) - Date.now())).toBeLessThan(10_000);
  expect(health.database).toEqual({ ok: true, latencyMs: expect.any(Number) });
  expect(health.redis).toEqual({ ok: true, latencyMs: expect.any(Number) });
  // The e2e stack has account email set up (against the provider stub).
  expect(health.platformEmail).toEqual({ configured: true, from: expect.stringMatching(/@/) });
  expect(Object.keys(health.clock).sort()).toEqual(['offsetMs', 'source', 'state', 'stratum']);
  expect(['ok', 'warn', 'bad', 'unknown']).toContain(health.clock.state);
  expect(health.queues).toHaveLength(3);
  for (const queue of health.queues) {
    expect(queue).toEqual({ name: expect.any(String), waiting: expect.any(Number), active: expect.any(Number), delayed: expect.any(Number), failed: expect.any(Number) });
  }
  const text = response.text.toLowerCase();
  for (const leak of ['localhost', '127.0.0.1', '::1', 'postgres', 'ioredis', 'econn', ':5432', ':6379']) {
    expect.soft(text, leak).not.toContain(leak);
  }
});

test('ADMOPS-061 clock states: ok, warn, bad, no source', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const states = [
    { clock: { state: 'ok', source: 'samay1.nic.in', stratum: 2, offsetMs: 12.5 }, headline: '12.5 ms off', tone: 'text-green-600', icon: 'lucide-circle-check', text: 'Synced to samay1.nic.in, stratum 2. CERT-In asks for NIC or NPL time.' },
    { clock: { state: 'warn', source: 'samay1.nic.in', stratum: 2, offsetMs: 250 }, headline: '250 ms off', tone: 'text-amber-600', icon: 'lucide-triangle-alert', text: 'Synced to samay1.nic.in, stratum 2. CERT-In asks for NIC or NPL time.' },
    { clock: { state: 'bad', source: 'samay1.nic.in', stratum: 2, offsetMs: 1500 }, headline: '1500 ms off', tone: 'text-destructive', icon: 'lucide-triangle-alert', text: 'Synced to samay1.nic.in, stratum 2. CERT-In asks for NIC or NPL time.' },
    { clock: { state: 'bad', source: null, stratum: 0, offsetMs: 0.1 }, headline: 'Not synchronised', tone: 'text-destructive', icon: 'lucide-triangle-alert', text: 'No time source. Check: chronyc sources' },
  ];
  for (const state of states) {
    await serveHealth(page, healthBody({ clock: state.clock }));
    await openAdminPage(page, '/health', 'Platform health');
    const card = cardTitled(page, 'Clock');
    const headline = card.locator('[data-slot="card-content"] > div').first();
    await expect(headline).toHaveText(state.headline);
    await expect(headline).toHaveClass(new RegExp(`\\b${state.tone.replace('-', '\\-')}\\b`));
    const icon = card.locator('[data-slot="card-header"] svg');
    await expect(icon).toHaveClass(new RegExp(state.icon));
    await expect(icon).toHaveClass(new RegExp(state.tone.replace('-', '\\-')));
    await expect(card.locator('[data-slot="card-content"] p')).toHaveText(state.text);
  }
});

test('ADMOPS-063 database unreachable: degraded', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await serveHealth(page, healthBody({ status: 'degraded', database: { ok: false, latencyMs: null } }));
  await openAdminPage(page, '/health', 'Platform health');
  await expect(page.getByRole('status').filter({ hasText: 'Degraded' })).toBeVisible();
  await expect(page.getByText('Operational', { exact: true })).toHaveCount(0);
  const database = cardTitled(page, 'Database');
  await expect(database.locator('[data-slot="card-content"] > div').first()).toHaveText('Unreachable');
  await expect(database).toContainText('No latency reading');
  await expect(cardTitled(page, 'Redis').locator('[data-slot="card-content"] > div').first()).toHaveText('OK');
});

test('ADMOPS-065 failed jobs are counted and highlighted', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const queues = (pushFailed: number, cohortFailed: number) => [
    { name: 'push-campaign', waiting: 2, active: 0, delayed: 0, failed: pushFailed },
    { name: 'cohort-sync', waiting: 0, active: 1, delayed: 0, failed: cohortFailed },
    { name: 'segment-materialize', waiting: 0, active: 0, delayed: 3, failed: 0 },
  ];
  await serveHealth(page, healthBody({ queues: queues(1, 1234) }));
  await openAdminPage(page, '/health', 'Platform health');
  const banner = page.getByRole('status').filter({ hasText: 'Operational' });
  const failedText = banner.locator('span.text-destructive');
  await expect(failedText).toHaveText('1,235 failed jobs');
  const rows = cardTitled(page, 'Queues').locator('tbody tr');
  await expect(rows.nth(0)).toHaveClass(/bg-destructive\/5/);
  await expect(rows.nth(1)).toHaveClass(/bg-destructive\/5/);
  await expect(rows.nth(2)).not.toHaveClass(/bg-destructive\/5/);
  await expect(rows.nth(0).locator('td').last().locator('[data-slot="badge"]')).toHaveText('1');
  await expect(rows.nth(1).locator('td').last().locator('[data-slot="badge"]')).toHaveText('1,234');
  await expect(rows.nth(2).locator('td').last()).toHaveText('0');
  await expect(rows.nth(2).locator('td').last().locator('[data-slot="badge"]')).toHaveCount(0);

  await serveHealth(page, healthBody({ queues: queues(1, 0) }));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(failedText).toHaveText('1 failed job');

  await serveHealth(page, healthBody({ queues: queues(0, 0) }));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rows.nth(0).locator('td').last()).toHaveText('0');
  await expect(failedText).toHaveCount(0);
});

test('ADMOPS-069 account email not configured: explanation and disabled test button', async ({ page, clientIp }) => {
  test.slow();
  const staff = await signedInStaff(page, clientIp);
  // Control: the lane's stack has account email set up (against the provider stub).
  await openAdminPage(page, '/health', 'Platform health');
  const card = cardTitled(page, 'Account email');
  await expect(card.getByText(/^Sending through Brevo from .+@.+\.$/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Send test email' })).toBeEnabled();

  // An admin API with account email off, as a default install runs.
  const off = await startAdminApiWith({ PLATFORM_BREVO_API_KEY: '', PLATFORM_EMAIL_FROM: '' }, 'email-off', 75);
  try {
    const health = await rawRequest(`${off.url}/api/admin/health`, 'GET', undefined, {
      Authorization: `Bearer ${staff.token}`,
      'X-Forwarded-For': clientIp,
    });
    expect(health.status).toBe(200);
    expect(health.json.data.platformEmail).toEqual({ configured: false, from: null });

    await forwardAdminPrefix(page, off.url, '/api/admin/health');
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/health');
    await page.reload();
    expect((await (await answered).json()).data.platformEmail).toEqual({ configured: false, from: null });
    await expect(page.getByRole('heading', { name: 'Platform health', level: 1 })).toBeVisible();
    await expect(card.getByText('Not configured. Set PLATFORM_BREVO_API_KEY and PLATFORM_EMAIL_FROM, then restart the API.', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  } finally {
    await off.stop();
  }
});

// ---------------------------------------------------------------- Recording incidents

test('ADMOPS-076 the Record button needs a title and at least one type', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await openAdminPage(page, '/incidents', 'Incidents');
  const record = page.getByRole('button', { name: 'Record incident' });
  const title = page.getByLabel('Title', { exact: true });
  const type = page.getByRole('checkbox', { name: '(iii) Unauthorised access of IT systems/data' });

  await expect(record).toBeDisabled();
  await title.fill('E2E 076 title only');
  await expect(record).toBeDisabled();
  await title.fill('');
  await type.check();
  await expect(record).toBeDisabled();
  await title.fill('   ');
  await expect(record).toBeDisabled();
  await title.fill('E2E 076 both');
  await expect(record).toBeEnabled();
  await type.uncheck();
  await expect(record).toBeDisabled();
});

test('ADMOPS-077 all 20 Annexure I types are offered, verbatim', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await openAdminPage(page, '/incidents', 'Incidents');
  const fieldset = page.getByRole('group', { name: 'Type (CERT-In Annexure I): pick at least one' });
  const boxes = fieldset.getByRole('checkbox');
  await expect(boxes).toHaveCount(20);
  const labels = await fieldset.locator('label').allTextContents();
  expect(labels.map((l) => l.replace(/\s+/g, ' ').trim())).toEqual(ANNEXURE_I.map((t) => `(${t.id}) ${t.label}`.replace(/\s+/g, ' ')));
  expect(ANNEXURE_I.map((t) => t.id)).toEqual(['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx']);
  for (const name of [
    '(i) Targeted scanning/probing of critical networks/systems',
    '(xi) Data Breach',
    '(xii) Data Leak',
    '(xx) Attacks or malicious/ suspicious activities affecting systems/ servers/software/ applications related to Artificial Intelligence and Machine Learning',
  ]) {
    await expect(fieldset.getByRole('checkbox', { name, exact: true })).toBeVisible();
  }
});

test('ADMOPS-078 record with every optional field and several types', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tag = hex();
  const tenants = [await createAccount(newClientIp(), `affected1-${tag}`, 'Ada One'), await createAccount(newClientIp(), `affected2-${tag}`, 'Ben Two')];
  const title = `E2E incident 078 ${hex()}`;
  await openAdminPage(page, '/incidents', 'Incidents');

  const thirtyAgo = Date.now() - 30 * 60_000;
  const local = await page.evaluate((ms) => {
    const at = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }, thirtyAgo);
  await page.getByLabel('When it was noticed (your time)').fill(local);
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('How it came to notice').fill('E2E: a customer wrote in');
  await page.getByLabel('What happened').fill('Line one\nLine two');
  await page.getByLabel('Systems affected').fill('API, worker');
  for (const id of ['i', 'vii', 'xi']) {
    const type = ANNEXURE_I.find((t) => t.id === id)!;
    await page.getByRole('checkbox', { name: `(${type.id}) ${type.label}`, exact: true }).check();
  }
  const search = page.getByLabel('Customer accounts affected');
  for (const tenant of tenants) {
    await search.fill(tenant.email.split('@')[0]);
    await page.getByRole('button', { name: tenant.email, exact: true }).click();
    await expect(search).toHaveValue('');
  }
  for (const tenant of tenants) {
    await expect(page.locator('[data-slot="badge"]').filter({ hasText: tenant.email })).toBeVisible();
    await expect(page.getByRole('button', { name: `Remove ${tenant.email}` })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Record incident' }).click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const recorded = cardTitled(page, 'What was recorded');
  for (const typeId of ['i', 'vii', 'xi']) {
    const type = ANNEXURE_I.find((t) => t.id === typeId)!;
    await expect(recorded.locator('[data-slot="badge"]').filter({ hasText: `(${type.id}) ${type.label}` })).toBeVisible();
  }
  await expect(recorded.locator('[data-slot="badge"]')).toHaveCount(3);
  await expect(recorded.getByText('How noticed: E2E: a customer wrote in', { exact: true })).toBeVisible();
  const summary = recorded.locator('p.whitespace-pre-wrap');
  await expect(summary).toHaveText('Line one\nLine two');
  expect(await summary.evaluate((p) => (p as HTMLElement).innerText)).toBe('Line one\nLine two');
  await expect(recorded.getByText('Systems: API, worker', { exact: true })).toBeVisible();
  await expect(recorded.getByText('Customer accounts affected: 2', { exact: true })).toBeVisible();

  const row = await incidentRow(id);
  expect(row).toMatchObject({
    types: ['i', 'vii', 'xi'],
    tenant_ids: tenants.map((t) => t.userId),
    how_noticed: 'E2E: a customer wrote in',
    summary: 'Line one\nLine two',
    systems: 'API, worker',
    recorded_by: staff.account.userId,
  });
  expect(row.noticed_at.getTime()).toBe(thirtyAgo - (thirtyAgo % 60_000));
});

test('ADMOPS-080 a noticed time in the future is refused', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const title = `E2E incident 080 ${hex()}`;
  await openAdminPage(page, '/incidents', 'Incidents');
  const ahead = await page.evaluate(() => {
    const at = new Date(Date.now() + 3600_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  });
  await page.getByLabel('When it was noticed (your time)').fill(ahead);
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('checkbox', { name: '(iii) Unauthorised access of IT systems/data' }).check();
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/incidents' && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Record incident' }).click(),
  ]);
  expect(response.status()).toBe(400);
  const toast = toastItem(page, 'Could not record the incident');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('When it was noticed cannot be in the future');
  await expect(page).toHaveURL(adminUrl('/incidents'));
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
  expect(await incidentByTitle(title)).toBeUndefined();

  const slack = `E2E incident 080 slack ${hex()}`;
  const accepted = await adminRequest('POST', '/api/admin/incidents', {
    token: staff.token,
    ip: clientIp,
    body: { types: ['iii'], title: slack, noticedAt: new Date(Date.now() + 30_000).toISOString() },
  });
  expect(accepted.status).toBe(201);
  expect(await incidentByTitle(slack)).toBeDefined();
});

test('ADMOPS-083 POST /api/admin/incidents validation', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const marker = `E2E 083 ${hex()}`;
  const ids = ANNEXURE_I.map((t) => t.id as string);
  const base = { types: ['iii'], title: marker };
  const cases: { name: string; body: Record<string, unknown>; message: string }[] = [
    { name: 'no types', body: { title: marker }, message: 'types must be an array' },
    { name: 'empty types', body: { ...base, types: [] }, message: 'types must contain at least 1 elements' },
    { name: 'unknown type', body: { ...base, types: ['xxi'] }, message: `each value in types must be one of the following values: ${ids.join(', ')}` },
    { name: '21 types', body: { ...base, types: [...ids, 'i'] }, message: 'types must contain no more than 20 elements' },
    { name: 'no title', body: { types: ['iii'] }, message: 'title must be a string' },
    { name: 'empty title', body: { ...base, title: '' }, message: 'title must be longer than or equal to 1 characters' },
    { name: '201-character title', body: { ...base, title: 'x'.repeat(201) }, message: 'title must be shorter than or equal to 200 characters' },
    { name: 'howNoticed 2001', body: { ...base, howNoticed: 'x'.repeat(2001) }, message: 'howNoticed must be shorter than or equal to 2000 characters' },
    { name: 'summary 10001', body: { ...base, summary: 'x'.repeat(10001) }, message: 'summary must be shorter than or equal to 10000 characters' },
    { name: 'systems 2001', body: { ...base, systems: 'x'.repeat(2001) }, message: 'systems must be shorter than or equal to 2000 characters' },
    { name: 'bad tenant id', body: { ...base, tenantIds: ['abc'] }, message: 'each value in tenantIds must be a UUID' },
    { name: '101 tenant ids', body: { ...base, tenantIds: Array.from({ length: 101 }, () => randomUUID()) }, message: 'tenantIds must contain no more than 100 elements' },
    { name: 'bad alert id', body: { ...base, alertId: 'abc' }, message: 'alertId must be a UUID' },
    { name: 'bad noticedAt', body: { ...base, noticedAt: '06/11/2026' }, message: 'noticedAt must be a valid ISO 8601 date string' },
    { name: 'extra field', body: { ...base, status: 'closed' }, message: 'property status should not exist' },
  ];
  for (const { name, body, message } of cases) {
    const response = await adminRequest('POST', '/api/admin/incidents', { token: staff.token, ip: clientIp, body });
    expect.soft(response.status, name).toBe(400);
    const got = messages(response.json);
    expect.soft(got, name).toContain(message);
  }
  const [{ n }] = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM security_incidents WHERE recorded_by = $1`, [staff.account.userId]);
  expect(n).toBe('0');
  // Control: the base body itself is accepted.
  await recordIncident(staff.token, clientIp, base);
  expect(await incidentByTitle(marker)).toBeDefined();
});


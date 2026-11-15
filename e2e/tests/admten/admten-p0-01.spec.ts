import { randomBytes, randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { adminApi, adminUrl } from '../../support/admin';
import { api, createAccount, createApiKey, createProject, newClientIp, PASSWORD, type Account } from '../../support/api';
import { enrolTotp } from '../../support/factors';
import { readDownload } from '../../support/browser-tools';
import { expect, newPersonContext, test } from '../../support/fixtures';
import { identifyPeople } from '../../support/seed';
import {
  admtenRoutes,
  adminRequest,
  auditRows,
  codeFromViewAsUrl,
  csvLines,
  customerRequest,
  exchangeViewAs,
  handoffRows,
  jwtClaims,
  makeStaffSignInStale,
  makeSuperAdmin,
  parseCsv,
  seedRollupThroughYesterday,
  seedUsage,
  sha256Hex,
  signedInStaff,
  sql,
  startViewAs,
  tenantState,
  userRow,
  utcDay,
  type Staff,
} from '../../support/areas/admten';

/**
 * Admin tenant routes: who may call them, the tenants list and its export, the tenant
 * page, limits, suspension and reactivation, and starting view-as.
 */

const CSV_HEADER =
  'tenant_id,email,name,status,plan,super_admin,signed_up_at,projects,mau_this_month,messages_sent_30d,last_usage_day,counted_through';
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REAUTH = 'Confirm it is you to continue.';

const term = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;

/** Opens a tenant's page in the admin app and waits for its header. */
async function openTenant(page: Page, tenant: Pick<Account, 'userId' | 'email'>): Promise<void> {
  await page.goto(adminUrl(`/tenants/${tenant.userId}`));
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
}

function toast(page: Page, title: string) {
  return page.getByText(title, { exact: true }).first();
}

/** Holds the next request to `pattern` for `ms`, so a pending state can be seen. */
async function delayNext(page: Page, pattern: string, ms = 1_500): Promise<void> {
  let held = false;
  await page.route(pattern, async (route) => {
    if (!held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.continue();
  });
}

// ---- A. Access

test('ADMTEN-001 every ADMTEN admin route refuses a request with no token', async ({ clientIp }) => {
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const before = await tenantState(tenant.userId);

  for (const route of admtenRoutes(tenant.userId)) {
    const response = await adminRequest(route.method, route.path, { ip: clientIp, body: route.body });
    expect.soft(response.status, `${route.method} ${route.path}`).toBe(401);
    expect.soft(response.text, `${route.method} ${route.path}`).not.toContain(tenant.email);
    expect.soft(response.json?.message, `${route.method} ${route.path}`).toBe('Unauthorized');
    expect.soft(response.json && 'data' in response.json, `${route.method} ${route.path}`).toBe(false);
  }

  expect(await tenantState(tenant.userId)).toEqual(before);
});

test('ADMTEN-002 a customer access token is refused on every ADMTEN admin route', async ({ clientIp }) => {
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const admin = await createAccount(newClientIp(), 'staff', 'Sam Staff');
  await makeSuperAdmin(admin.userId);
  // Both tokens are live on the customer API, so a refusal is about the admin API.
  for (const account of [tenant, admin]) {
    expect((await customerRequest('GET', '/api/auth/me', { token: account.accessToken, ip: clientIp })).status).toBe(200);
  }
  const before = await tenantState(tenant.userId);

  for (const [who, token] of [
    ['tenant', tenant.accessToken],
    ['super admin', admin.accessToken],
  ] as const) {
    for (const route of admtenRoutes(tenant.userId)) {
      const response = await adminRequest(route.method, route.path, { token, ip: clientIp, body: route.body });
      expect.soft(response.status, `${who}: ${route.method} ${route.path}`).toBe(401);
      expect.soft(response.text, `${who}: ${route.method} ${route.path}`).not.toContain(tenant.email);
    }
  }

  expect(await tenantState(tenant.userId)).toEqual(before);
});

test('ADMTEN-003 a view-as token is refused on every ADMTEN admin route', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const other = await createAccount(newClientIp(), 'tenant', 'Otto Other');
  const viewAs = await exchangeViewAs((await startViewAs(staff, tenant.userId, clientIp)).url, clientIp);
  // The token is live where it belongs.
  const me = await customerRequest('GET', '/api/auth/me', { token: viewAs, ip: clientIp });
  expect(me.status).toBe(200);

  const before = await tenantState(tenant.userId);
  const otherBefore = await tenantState(other.userId);
  for (const route of admtenRoutes(tenant.userId)) {
    const response = await adminRequest(route.method, route.path, { token: viewAs, ip: clientIp, body: route.body });
    expect.soft(response.status, `${route.method} ${route.path}`).toBe(401);
  }
  // View-as cannot be chained into another tenant.
  const chained = await adminRequest('POST', `/api/admin/tenants/${other.userId}/impersonate`, {
    token: viewAs,
    ip: clientIp,
    body: { reason: 'E2E: chaining a view-as session' },
  });
  expect(chained.status).toBe(401);

  expect(await tenantState(tenant.userId)).toEqual(before);
  expect(await tenantState(other.userId)).toEqual(otherBefore);
  expect(await handoffRows({ targetId: other.userId })).toHaveLength(0);
});

// ---- C. Tenants list

test('ADMTEN-076 the tenants list never returns secrets or end-user data', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp);
  const apiKey = await createApiKey(tenant, project.id, clientIp);
  const personEmail = `person-${randomBytes(4).toString('hex')}@people.e2e.example.test`;
  await identifyPeople(project.id, apiKey, clientIp, [{ email: personEmail, firstName: 'Petra' }]);
  const totp = await enrolTotp({ ip: clientIp }, tenant);
  const { password_hash: passwordHash } = await userRow(tenant.userId);
  const [person] = await sql<{ device_fingerprint: string }>(
    `SELECT device_fingerprint FROM device_identities WHERE project_id = $1`,
    [project.id],
  );

  const response = await adminRequest('GET', `/api/admin/tenants?search=${encodeURIComponent(tenant.email)}`, {
    token: staff.token,
    ip: clientIp,
  });
  expect(response.status).toBe(200);
  const items = (response.json as { data: Record<string, unknown>[] }).data;
  expect(items).toHaveLength(1);
  expect(Object.keys(items[0]).sort()).toEqual(
    [
      'id',
      'email',
      'name',
      'status',
      'isSuperAdmin',
      'suspendedAt',
      'suspendedReason',
      'createdAt',
      'projectCount',
      'linkCount',
      'identityCount',
      'clicksLast30d',
      'lastActivityAt',
      'mauThisMonth',
      'messagesSent30d',
      'lastUsageDay',
      'plan',
    ].sort(),
  );
  expect(items[0]).toMatchObject({ id: tenant.userId, email: tenant.email, identityCount: 1, projectCount: 1 });
  for (const secret of [passwordHash, totp.secret, apiKey, personEmail, person.device_fingerprint, 'Petra']) {
    expect(response.text).not.toContain(secret);
  }
});

// ---- D. Tenants export

test('ADMTEN-079 Export CSV downloads the current view and says how many', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const search = term('exp');
  const active: Account[] = [];
  for (const name of ['Ada', 'Bea', 'Cy']) active.push(await createAccount(newClientIp(), `${search}-${name.toLowerCase()}`, name));
  // A fourth match that the status filter leaves out.
  const suspended = await createAccount(newClientIp(), `${search}-sus`, 'Sus');
  await sql(`UPDATE users SET suspended_at = now(), suspended_reason = 'E2E: left out of the view' WHERE id = $1`, [
    suspended.userId,
  ]);

  await page.goto(adminUrl(`/tenants?search=${search}&status=active`));
  await expect(page.getByRole('heading', { name: 'Tenants', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: search })).toHaveCount(3);

  await delayNext(page, '**/api/admin/tenants/export**');
  const exporting = page.waitForRequest((request) => request.url().includes('/api/admin/tenants/export'));
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByRole('button', { name: 'Exporting...' })).toBeDisabled();

  const request = new URL((await exporting).url());
  expect(request.pathname).toBe('/api/admin/tenants/export');
  expect(Object.fromEntries(request.searchParams)).toEqual({
    search,
    status: 'active',
    sort: 'created_at',
    order: 'desc',
  });
  const file = await readDownload(await downloaded);
  expect(file.filename).toMatch(/^chumbaq-tenants-\d{8}-\d{6}\.csv$/);
  expect(file.lines).toHaveLength(4);
  expect(file.lines[0]).toBe(CSV_HEADER);
  // The file is the view: the three active matches, newest first, not the suspended one.
  expect(file.lines.slice(1).map((line) => line.split(',')[0])).toEqual(active.map((account) => account.userId).reverse());
  expect(file.text).not.toContain(suspended.userId);
  await expect(toast(page, 'Exported 3 tenants')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
});

test('ADMTEN-081 CSV columns, order and values', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const search = term('csv');
  const used = await createAccount(newClientIp(), `${search}-u`, 'Una Used');
  const p1 = await createProject(used, clientIp);
  const p2 = await createProject(used, clientIp);
  const blocked = await createAccount(newClientIp(), `${search}-b`, 'Bo Blocked');
  await adminApi('POST', `/api/admin/tenants/${blocked.userId}/suspend`, { reason: 'E2E: a suspended row' }, staff.token, clientIp);
  const admin = await createAccount(newClientIp(), `${search}-s`, 'Sid Staff');
  await makeSuperAdmin(admin.userId);

  const through = utcDay(-1);
  const lastUsage = utcDay(-4);
  const restoreState = await seedRollupThroughYesterday();
  const removeUsage = await seedUsage([
    { projectId: p1.id, ownerId: used.userId, day: through, metric: 'mau_month_to_date', value: 5 },
    { projectId: p2.id, ownerId: used.userId, day: through, metric: 'mau_month_to_date', value: 4 },
    { projectId: p1.id, ownerId: used.userId, day: lastUsage, metric: 'push_sent', value: 100 },
    { projectId: p2.id, ownerId: used.userId, day: utcDay(-6), metric: 'email_sent', value: 20 },
  ]);
  try {
    const response = await adminRequest('GET', `/api/admin/tenants/export?search=${search}`, { token: staff.token, ip: clientIp });
    expect(response.status).toBe(200);
    expect(response.text.startsWith('﻿')).toBe(true);
    const body = response.text.slice(1);
    expect(body).not.toMatch(/(?<!\r)\n/);
    expect(body.endsWith('\r\n')).toBe(true);
    const lines = csvLines(body);
    expect(lines[0]).toBe(CSV_HEADER);

    const rows = parseCsv(body).slice(1);
    // Newest first, as the list: Sid, Bo, Una.
    expect(rows.map((row) => row[0])).toEqual([admin.userId, blocked.userId, used.userId]);
    for (const row of rows) {
      expect(row).toHaveLength(12);
      expect(row[6]).toMatch(ISO_INSTANT);
    }
    const [s, b, u] = rows;
    expect(u).toEqual([used.userId, used.email, 'Una Used', 'active', 'free', 'false', u[6], '2', '9', '120', lastUsage, through]);
    expect(b).toEqual([blocked.userId, blocked.email, 'Bo Blocked', 'suspended', 'free', 'false', b[6], '0', '0', '0', '', through]);
    expect(s).toEqual([admin.userId, admin.email, 'Sid Staff', 'active', 'free', 'true', s[6], '0', '0', '0', '', through]);
    const [{ created }] = await sql<{ created: Date }>(`SELECT created_at AS created FROM users WHERE id = $1`, [used.userId]);
    expect(new Date(u[6]).getTime()).toBe(new Date(created).getTime());
  } finally {
    await removeUsage();
    await restoreState();
  }
});

test('ADMTEN-084 every export is audited with its filters', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const search = term('acme');
  await page.goto(adminUrl(`/tenants?search=${search}&activity=quiet&sort=messages_sent_30d&order=asc&plan=free`));
  await expect(page.getByRole('heading', { name: 'Tenants', exact: true })).toBeVisible();

  const downloaded = page.waitForEvent('download');
  const answered = page.waitForResponse((response) => response.url().includes('/api/admin/tenants/export'));
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await downloaded;
  const sentAt = new Date((await (await answered).headerValue('date')) ?? Date.now());
  await expect(toast(page, 'Exported 0 tenants')).toBeVisible();

  const rows = await auditRows({ action: 'tenants.exported', actorId: staff.account.userId });
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row).toMatchObject({
    actor_email: staff.account.email,
    target_type: 'tenant_list',
    target_id: null,
    ip_address: clientIp,
  });
  // Exact: toMatchObject would accept extra keys in nested objects, and status must be absent.
  expect(row.metadata).toEqual({
    filters: { sort: 'messages_sent_30d', order: 'asc', search, activity: 'quiet', plan: 'free' },
    rowCount: 0,
    rowCap: 10000,
    truncated: false,
  });
  // Recorded before the file was sent (the Date header has whole seconds).
  expect(new Date(row.created_at).getTime()).toBeLessThanOrEqual(sentAt.getTime() + 1_000);

  await page.goto(adminUrl(`/audit-log?actorEmail=${encodeURIComponent(staff.account.email)}&action=tenants.exported`));
  const entry = page.getByRole('row').filter({ hasText: 'Tenants list exported' });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText(staff.account.email);
  await expect(entry).toContainText(clientIp);
});

test('ADMTEN-085 CSV formula injection is neutralised', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const search = term('inj');
  const names = ['=HYPERLINK("http://evil","x")', '+cmd', '-2+3', '@SUM(A1)', '\tTabbed', 'Smith, "Jr"'];
  const ids: string[] = [];
  for (const [index, name] of names.entries()) {
    // Each sign-up from an address of its own: sign-up is throttled per address.
    const account = await createAccount(newClientIp(), `${search}-${index}`, 'Placeholder');
    // Stored as typed: the sign-up form trims names, a stored name need not be.
    await sql(`UPDATE users SET name = $2 WHERE id = $1`, [account.userId, name]);
    ids.push(account.userId);
  }

  const response = await adminRequest('GET', `/api/admin/tenants/export?search=${search}`, { token: staff.token, ip: clientIp });
  expect(response.status).toBe(200);
  const body = response.text.replace(/^﻿/, '');
  const lines = csvLines(body);
  const lineOf = (id: string) => lines.find((line) => line.startsWith(`${id},`)) ?? '';

  expect(lineOf(ids[0])).toContain(`,"'=HYPERLINK(""http://evil"",""x"")",`);
  expect(lineOf(ids[1])).toContain(`,'+cmd,`);
  expect(lineOf(ids[2])).toContain(`,'-2+3,`);
  expect(lineOf(ids[3])).toContain(`,'@SUM(A1),`);
  expect(lineOf(ids[4])).toContain(`,'\tTabbed,`);
  expect(lineOf(ids[5])).toContain(`,"Smith, ""Jr""",`);

  const parsed = new Map(parseCsv(body).map((row) => [row[0], row]));
  const expected = ["'" + names[0], "'+cmd", "'-2+3", "'@SUM(A1)", "'\tTabbed", 'Smith, "Jr"'];
  ids.forEach((id, index) => {
    const row = parsed.get(id);
    expect(row?.[2]).toBe(expected[index]);
    expect(row).toHaveLength(12);
  });
});

test('ADMTEN-092 export with no token or a customer token', async ({ clientIp }) => {
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  for (const token of [undefined, tenant.accessToken]) {
    const response = await adminRequest('GET', '/api/admin/tenants/export', { token, ip: clientIp });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/csv');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(response.text.startsWith('﻿')).toBe(false);
    expect(response.text).not.toContain('tenant_id,email');
  }
});

// ---- E. Tenant detail

test('ADMTEN-095 opening a tenant records one staff view, deduplicated for 10 minutes', async ({ page, browser, baseURL, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const views = (actorId: string) => auditRows({ action: 'tenant.viewed', actorId, targetId: tenant.userId });

  await openTenant(page, tenant);
  await page.reload();
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  // The usage card's request also records a read: wait until it has answered.
  const usageRead = page.waitForResponse((response) => response.url().includes(`/tenants/${tenant.userId}/usage`));
  await page.reload();
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  expect((await usageRead).status()).toBe(200);

  let rows = await views(staff.account.userId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actor_email: staff.account.email,
    target_type: 'tenant',
    target_label: tenant.email,
    ip_address: clientIp,
  });

  await sql(`UPDATE admin_audit_logs SET created_at = created_at - interval '11 minutes' WHERE id = $1`, [rows[0].id]);
  await page.reload();
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await views(staff.account.userId)).length).toBe(2);

  // Another staff member gets a row of their own at once.
  const second = await newPersonContext(browser, baseURL);
  try {
    const otherPage = await second.context.newPage();
    const other = await signedInStaff(otherPage, second.ip, 'Ola Other');
    await openTenant(otherPage, tenant);
    await expect.poll(async () => (await views(other.account.userId)).length).toBe(1);
    expect((await views(other.account.userId))[0].ip_address).toBe(second.ip);
  } finally {
    await second.context.close();
  }
  expect(await views(staff.account.userId)).toHaveLength(2);
});

test('ADMTEN-106 tenant detail never returns secrets', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp);
  const apiKey = await createApiKey(tenant, project.id, clientIp);
  const hookUrl = `https://8.8.8.8/e2e-hook-${randomBytes(6).toString('hex')}`;
  const webhook = await api<{ secret: string }>(
    'POST',
    `/api/projects/${project.id}/webhooks`,
    { url: hookUrl, events: ['link.clicked'] },
    { token: tenant.accessToken, ip: clientIp },
  );
  const totp = await enrolTotp({ ip: clientIp }, tenant);
  const { password_hash: passwordHash } = await userRow(tenant.userId);
  const [{ key_hash: keyHash }] = await sql<{ key_hash: string }>(`SELECT key_hash FROM api_keys WHERE project_id = $1`, [project.id]);
  const [{ secret_sealed: sealed }] = await sql<{ secret_sealed: string }>(
    `SELECT secret AS secret_sealed FROM webhooks WHERE project_id = $1`,
    [project.id],
  );

  const response = await adminRequest('GET', `/api/admin/tenants/${tenant.userId}`, { token: staff.token, ip: clientIp });
  expect(response.status).toBe(200);
  const detail = (response.json as { data: Record<string, unknown> }).data;
  expect(Object.keys(detail).sort()).toEqual(
    [
      'id',
      'email',
      'name',
      'status',
      'isSuperAdmin',
      'suspendedAt',
      'suspendedReason',
      'createdAt',
      'projectCount',
      'linkCount',
      'identityCount',
      'clicksLast30d',
      'lastActivityAt',
      'mauThisMonth',
      'messagesSent30d',
      'lastUsageDay',
      'plan',
      'projectLimit',
      'effectiveProjectLimit',
      'seatLimit',
      'effectiveSeatLimit',
      'seatsUsed',
      'projects',
      'recentAudit',
      'lastSignInAt',
    ].sort(),
  );
  const projects = detail.projects as Record<string, unknown>[];
  expect(projects).toHaveLength(1);
  expect(Object.keys(projects[0]).sort()).toEqual(
    ['id', 'name', 'domain', 'createdAt', 'linkCount', 'identityCount', 'clicksLast30d', 'activeApiKeyCount'].sort(),
  );
  expect(projects[0]).toMatchObject({ id: project.id, activeApiKeyCount: 1 });
  for (const secret of [passwordHash, totp.secret, apiKey, keyHash, webhook.secret, sealed, hookUrl, '8.8.8.8']) {
    expect(response.text).not.toContain(secret);
  }
});

// ---- G. Limits

test('ADMTEN-121 raise the project limit', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await createProject(tenant, clientIp);
  await createProject(tenant, clientIp);
  const before = await adminApi<{ effectiveProjectLimit: number; projectLimit: number | null }>(
    'GET',
    `/api/admin/tenants/${tenant.userId}`,
    undefined,
    staff.token,
    clientIp,
  );
  expect(before.projectLimit).toBeNull();
  // A sign-in older than 15 minutes is enough for limits.
  await makeStaffSignInStale(staff.account.userId);

  // The page load refreshes the token; it must really carry the old sign-in, or this proves nothing.
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/staff/auth/session/refresh'));
  await openTenant(page, tenant);
  const { data: session } = (await (await refreshed).json()) as { data: { accessToken: string } };
  const authTime = Number(jwtClaims(session.accessToken).auth_time);
  expect(Date.now() / 1000 - authTime).toBeGreaterThan(15 * 60);
  await expect(page.getByText(`2 of ${before.effectiveProjectLimit} projects (default limit)`)).toBeVisible();
  await page.getByRole('button', { name: 'Change limit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Project limit' });
  await dialog.getByLabel('Limit').fill('25');
  await dialog.getByLabel('Reason').fill('Customer on annual contract');
  await delayNext(page, '**/project-limit');
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog.getByRole('button', { name: 'Working...' })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);
  await expect(toast(page, 'Project limit saved')).toBeVisible();
  await expect(page.getByText('2 of 25 projects (limit set by staff)')).toBeVisible();

  expect((await userRow(tenant.userId)).project_limit).toBe(25);
  const audit = await auditRows({ action: 'account.project_limit_changed', targetId: tenant.userId });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_id: staff.account.userId,
    target_label: tenant.email,
    reason: 'Customer on annual contract',
    metadata: { before: null, after: 25, defaultLimit: before.effectiveProjectLimit },
  });
  await expect(page.getByRole('row').filter({ hasText: 'Project limit changed' })).toContainText('Customer on annual contract');
});

test('ADMTEN-132 set and clear the seat limit', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp);
  for (const label of ['one', 'two']) {
    await api(
      'POST',
      `/api/projects/${project.id}/invitations`,
      { email: `invitee-${label}-${randomBytes(3).toString('hex')}@e2e.example.test`, role: 'member' },
      { token: tenant.accessToken, ip: clientIp },
    );
  }
  const before = await adminApi<{ seatsUsed: number; effectiveSeatLimit: number | null; seatLimit: number | null }>(
    'GET',
    `/api/admin/tenants/${tenant.userId}`,
    undefined,
    staff.token,
    clientIp,
  );
  expect(before).toMatchObject({ seatsUsed: 3, seatLimit: null });
  const defaultLimit = before.effectiveSeatLimit;
  const defaultLabel = defaultLimit === null ? 'Seats: 3 used, no limit' : `Seats: 3 of ${defaultLimit} used (default limit)`;

  await openTenant(page, tenant);
  await expect(page.getByText(defaultLabel, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Change seat limit' }).click();
  let dialog = page.getByRole('dialog', { name: 'Seat limit' });
  await dialog.getByLabel('Limit').fill('5');
  await dialog.getByLabel('Reason').fill('Agency with a small team');
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog).toBeHidden();
  await expect(toast(page, 'Seat limit saved')).toBeVisible();
  await expect(page.getByText('Seats: 3 of 5 used (limit set by staff)', { exact: true })).toBeVisible();
  expect((await userRow(tenant.userId)).seat_limit).toBe(5);

  await page.getByRole('button', { name: 'Change seat limit' }).click();
  dialog = page.getByRole('dialog', { name: 'Seat limit' });
  await expect(dialog.getByLabel('Limit')).toHaveValue('5');
  await dialog.getByLabel('Limit').fill('');
  await dialog.getByLabel('Reason').fill('Back to the plan default');
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(defaultLabel, { exact: true })).toBeVisible();
  expect((await userRow(tenant.userId)).seat_limit).toBeNull();

  const audit = await auditRows({ action: 'account.seat_limit_changed', targetId: tenant.userId });
  expect(audit.map((row) => row.metadata)).toEqual([
    { before: null, after: 5, defaultLimit },
    { before: 5, after: null, defaultLimit },
  ]);
  expect(audit.map((row) => row.reason)).toEqual(['Agency with a small team', 'Back to the plan default']);
});

// ---- H. Suspend and reactivate

test('ADMTEN-139 suspend a tenant', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const before = await userRow(tenant.userId);

  await openTenant(page, tenant);
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspend this tenant?' });
  await dialog.getByLabel('Reason').fill('Abuse report #123');
  await dialog.getByLabel(`Type ${tenant.email} to confirm`).fill(tenant.email);
  await delayNext(page, '**/suspend');
  await dialog.getByRole('button', { name: 'Suspend tenant' }).click();
  await expect(dialog.getByRole('button', { name: 'Working...' })).toBeDisabled();
  await expect(dialog).toBeHidden();
  await expect(toast(page, 'Tenant suspended')).toBeVisible();

  await expect(page.getByText('suspended', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Suspended on [A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2}$/)).toBeVisible();
  await expect(page.getByText('Abuse report #123', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reactivate' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View as tenant' })).toBeDisabled();
  await expect(page.getByText('Suspended tenants cannot be viewed as. Reactivate the account first.')).toBeVisible();

  const after = await userRow(tenant.userId);
  expect(after.suspended_at).not.toBeNull();
  expect(after.suspended_reason).toBe('Abuse report #123');
  expect(after.session_version).toBe(before.session_version + 1);
  const audit = await auditRows({ action: 'tenant.suspended', targetId: tenant.userId });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_id: staff.account.userId,
    actor_email: staff.account.email,
    reason: 'Abuse report #123',
    ip_address: clientIp,
    target_label: tenant.email,
  });
  await expect(page.getByRole('row').filter({ hasText: 'Abuse report #123' })).toContainText('Suspended');
  // The tenant's live session is refused from now on.
  expect((await customerRequest('GET', '/api/auth/me', { token: tenant.accessToken, ip: clientIp })).status).toBe(403);
});

test('ADMTEN-140 suspending ends the tenant tokens for good', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const me = () => customerRequest('GET', '/api/auth/me', { token: tenant.accessToken, ip: clientIp });
  expect((await me()).status).toBe(200);

  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { reason: 'E2E: suspend for tokens' }, staff.token, clientIp);
  const suspended = await me();
  expect(suspended.status).toBe(403);
  expect(suspended.json?.message).toBe('Account suspended');

  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/reactivate`, { reason: 'E2E: reactivate for tokens' }, staff.token, clientIp);
  const revoked = await me();
  expect(revoked.status).toBe(401);
  expect(revoked.json?.message).toBe('Session has been revoked');
});

test('ADMTEN-146 suspend needs a recent staff sign-in', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await makeStaffSignInStale(staff.account.userId);
  // A page load refreshes the access token, which then carries the old sign-in time.
  await openTenant(page, tenant);

  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspend this tenant?' });
  await dialog.getByLabel('Reason').fill('Abuse report #146');
  await dialog.getByLabel(`Type ${tenant.email} to confirm`).fill(tenant.email);

  // Cancelled: the refusal stays in the dialog and nothing changes.
  const refused = page.waitForResponse((response) => response.url().endsWith('/suspend'));
  await dialog.getByRole('button', { name: 'Suspend tenant' }).click();
  const first = await refused;
  expect(first.status()).toBe(403);
  expect(((await first.json()) as { message: string }).message).toBe(REAUTH);
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toBeHidden();
  await expect(dialog.getByRole('alert')).toHaveText(REAUTH);
  expect((await userRow(tenant.userId)).suspended_at).toBeNull();
  expect(await auditRows({ action: 'tenant.suspended', targetId: tenant.userId })).toHaveLength(0);

  // Confirmed with the passkey: the request is sent again and goes through.
  await dialog.getByRole('button', { name: 'Suspend tenant' }).click();
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Use passkey' }).click();
  await expect(toast(page, 'Tenant suspended')).toBeVisible();
  await expect(dialog).toBeHidden();
  expect((await userRow(tenant.userId)).suspended_reason).toBe('Abuse report #146');
  expect(await auditRows({ action: 'tenant.suspended', targetId: tenant.userId })).toHaveLength(1);
});

test('ADMTEN-149 a suspended tenant cannot be viewed as', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { reason: 'E2E: suspended first' }, staff.token, clientIp);

  const response = await adminRequest('POST', `/api/admin/tenants/${tenant.userId}/impersonate`, {
    token: staff.token,
    ip: clientIp,
    body: { reason: 'E2E: trying to view a suspended tenant' },
  });
  expect(response.status).toBe(409);
  expect(response.json?.message).toBe('Suspended tenants cannot be impersonated');
  expect(await handoffRows({ targetId: tenant.userId })).toHaveLength(0);
  expect(await auditRows({ action: 'tenant.impersonated', targetId: tenant.userId })).toHaveLength(0);
});

test('ADMTEN-150 reactivate dialog and reactivation', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/suspend`, { reason: 'E2E: reason R for suspending' }, staff.token, clientIp);
  const suspended = await userRow(tenant.userId);

  await openTenant(page, tenant);
  await expect(page.getByText('E2E: reason R for suspending').first()).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reactivate this tenant?' });
  await expect(dialog).toContainText('They can log in again, their short links redirect again, and sends and journeys resume.');
  await expect(dialog.getByText(/^Type .* to confirm$/)).toHaveCount(0);
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await dialog.getByLabel('Reason').fill('Resolved with customer');
  await dialog.getByRole('button', { name: 'Reactivate tenant' }).click();
  await expect(dialog).toBeHidden();
  await expect(toast(page, 'Tenant reactivated')).toBeVisible();

  await expect(page.getByText('active', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Suspended on /)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View as tenant' })).toBeEnabled();

  const after = await userRow(tenant.userId);
  expect(after.suspended_at).toBeNull();
  expect(after.suspended_reason).toBeNull();
  expect(after.session_version).toBe(suspended.session_version);
  const audit = await auditRows({ action: 'tenant.reactivated', targetId: tenant.userId });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor_id: staff.account.userId, reason: 'Resolved with customer' });

  const login = await customerRequest('POST', '/api/auth/login', {
    ip: clientIp,
    body: { email: tenant.email, password: PASSWORD },
  });
  expect(login.status).toBe(200);
  expect((login.json?.data as { tokens?: { accessToken?: string } }).tokens?.accessToken).toBeTruthy();
});

/** View-as from the tenant page through to the customer app's new tab. */
async function openViewAs(page: Page, tenant: Account, reason = 'E2E: checking the view-as session'): Promise<Page> {
  await openTenant(page, tenant);
  await page.getByRole('button', { name: 'View as tenant' }).click();
  const start = page.getByRole('dialog', { name: 'View as this tenant?' });
  await start.getByLabel('Reason').fill(reason);
  await start.getByRole('button', { name: 'Start read-only session' }).click();
  const ready = page.getByRole('dialog', { name: `View as ${tenant.email}` });
  const [viewAs] = await Promise.all([
    page.context().waitForEvent('page'),
    ready.getByRole('link', { name: 'Open view-as' }).click(),
  ]);
  await expect(viewAs).toHaveURL(/\/projects$/);
  await expect(viewAs.getByRole('region', { name: 'Impersonation session' })).toBeVisible();
  return viewAs;
}

test('ADMTEN-155 a view-as session ends when the tenant is suspended', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const project = await createProject(tenant, clientIp, `Viewed project ${randomBytes(2).toString('hex')}`);
  const viewAs = await openViewAs(page, tenant);
  await expect(viewAs.getByText(project.name)).toBeVisible();

  await page.bringToFront();
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspend this tenant?' });
  await dialog.getByLabel('Reason').fill('Abuse report during view-as');
  await dialog.getByLabel(`Type ${tenant.email} to confirm`).fill(tenant.email);
  await dialog.getByRole('button', { name: 'Suspend tenant' }).click();
  await expect(toast(page, 'Tenant suspended')).toBeVisible();

  await viewAs.bringToFront();
  // The tab navigates away as soon as the refusal arrives, so its body is read on the way in.
  const refusals: { status: number; message: unknown }[] = [];
  await viewAs.route('**/api/**', async (route) => {
    const response = await route.fetch();
    if (response.status() === 403) {
      refusals.push({ status: 403, message: ((await response.json()) as { message?: unknown }).message });
    }
    await route.fulfill({ response });
  });
  const leaving = viewAs.waitForRequest(
    (request) => request.isNavigationRequest() && request.url() === adminUrl(`/tenants/${tenant.userId}`),
  );
  await viewAs.getByText(project.name).click();
  await leaving;
  expect(refusals[0]).toEqual({ status: 403, message: 'Account suspended' });
  await expect(viewAs).toHaveURL(new RegExp(`^${adminUrl('')}/`));

  // The tab's view-as session is gone: the customer app no longer opens as the tenant.
  await viewAs.unroute('**/api/**');
  await viewAs.goto('/projects');
  await expect(viewAs).toHaveURL(/\/login/);
  expect(await viewAs.evaluate(() => sessionStorage.getItem('chumbaq_impersonation'))).toBeNull();
  await expect(viewAs.getByRole('region', { name: 'Impersonation session' })).toHaveCount(0);
});

// ---- I. Starting view-as

test('ADMTEN-157 starting view-as creates a one-time link and records it', async ({ page, clientIp, baseURL }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await openTenant(page, tenant);

  await page.getByRole('button', { name: 'View as tenant' }).click();
  const start = page.getByRole('dialog', { name: 'View as this tenant?' });
  await start.getByLabel('Reason').fill('Ticket 42: checking campaign setup');
  const answered = page.waitForResponse((response) => response.url().endsWith('/impersonate') && response.request().method() === 'POST');
  await start.getByRole('button', { name: 'Start read-only session' }).click();
  const response = await answered;
  const madeAt = Date.now();

  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  const { data } = (await response.json()) as {
    data: { url: string; expiresAt: string; tenant: Record<string, unknown> };
  };
  expect(data.url).toMatch(new RegExp(`^${baseURL}/impersonate#code=[A-Za-z0-9_-]{43}$`));
  const secondsAhead = (Date.parse(data.expiresAt) - madeAt) / 1000;
  expect(secondsAhead).toBeGreaterThan(50);
  expect(secondsAhead).toBeLessThanOrEqual(61);
  expect(data.tenant).toEqual({ id: tenant.userId, email: tenant.email, name: tenant.name });

  await expect(start).toBeHidden();
  const ready = page.getByRole('dialog', { name: `View as ${tenant.email}` });
  await expect(ready).toContainText(
    /The customer app opens in a new tab, read-only, for 30 minutes\. This link works once, for the next \d+ seconds\./,
  );
  const seconds = Number(/for the next (\d+) seconds/.exec((await ready.textContent()) ?? '')?.[1]);
  expect(seconds).toBeGreaterThanOrEqual(50);
  expect(seconds).toBeLessThanOrEqual(60);
  await expect(ready.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(ready.getByRole('link', { name: 'Open view-as' })).toHaveAttribute('href', data.url);
  // It counts down.
  await expect
    .poll(async () => Number(/for the next (\d+) seconds/.exec((await ready.textContent()) ?? '')?.[1]))
    .toBeLessThan(seconds);

  const code = codeFromViewAsUrl(data.url);
  const handoffs = await handoffRows({ targetId: tenant.userId });
  expect(handoffs).toHaveLength(1);
  const [handoff] = handoffs;
  expect(handoff.code_hash).toBe(sha256Hex(code));
  expect(handoff.code_hash).not.toBe(code);
  expect(handoff).toMatchObject({
    actor_id: staff.account.userId,
    staff_session_id: staff.sessionId,
    reason: 'Ticket 42: checking campaign setup',
    used_at: null,
  });
  expect(new Date(handoff.expires_at).toISOString()).toBe(data.expiresAt);

  const audit = await auditRows({ action: 'tenant.impersonated', targetId: tenant.userId });
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_id: staff.account.userId,
    reason: 'Ticket 42: checking campaign setup',
    ip_address: clientIp,
    metadata: { handoffId: handoff.id, codeExpiresAt: data.expiresAt },
  });
});

test('ADMTEN-161 view-as refusals for special targets', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const otherAdmin = await createAccount(newClientIp(), 'staff', 'Ona Admin');
  await makeSuperAdmin(otherAdmin.userId);
  const suspended = await createAccount(newClientIp(), 'tenant', 'Sue Suspended');
  await adminApi('POST', `/api/admin/tenants/${suspended.userId}/suspend`, { reason: 'E2E: suspended target' }, staff.token, clientIp);
  // No audit row of any kind from the refusals: count everything this staff member has written.
  const auditBefore = (await auditRows({ actorId: staff.account.userId })).length;

  const cases: [string, number, string][] = [
    [staff.account.userId, 409, 'You cannot impersonate yourself'],
    [otherAdmin.userId, 409, 'Super admins cannot be impersonated'],
    [suspended.userId, 409, 'Suspended tenants cannot be impersonated'],
    [randomUUID(), 404, 'Tenant not found'],
  ];
  for (const [target, status, message] of cases) {
    const response = await adminRequest('POST', `/api/admin/tenants/${target}/impersonate`, {
      token: staff.token,
      ip: clientIp,
      body: { reason: 'E2E: a refused view-as target' },
    });
    expect.soft(response.status, message).toBe(status);
    expect.soft(response.json?.message, message).toBe(message);
  }
  expect(await handoffRows({ actorId: staff.account.userId })).toHaveLength(0);
  expect(await auditRows({ actorId: staff.account.userId })).toHaveLength(auditBefore);
  for (const target of [otherAdmin.userId, suspended.userId]) {
    expect(await auditRows({ action: 'tenant.impersonated', targetId: target })).toHaveLength(0);
  }
});

test('ADMTEN-162 view-as needs a recent staff sign-in', async ({ page, clientIp }) => {
  const staff: Staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  await makeStaffSignInStale(staff.account.userId);
  await openTenant(page, tenant);

  await page.getByRole('button', { name: 'View as tenant' }).click();
  const start = page.getByRole('dialog', { name: 'View as this tenant?' });
  await start.getByLabel('Reason').fill('Ticket 162: checking setup');

  const refused = page.waitForResponse((response) => response.url().endsWith('/impersonate'));
  await start.getByRole('button', { name: 'Start read-only session' }).click();
  const first = await refused;
  expect(first.status()).toBe(403);
  expect(((await first.json()) as { message: string }).message).toBe(REAUTH);
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(start.getByRole('alert')).toHaveText(REAUTH);
  expect(await handoffRows({ targetId: tenant.userId })).toHaveLength(0);

  await start.getByRole('button', { name: 'Start read-only session' }).click();
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Use passkey' }).click();
  await expect(page.getByRole('dialog', { name: `View as ${tenant.email}` })).toBeVisible();
  expect(await handoffRows({ targetId: tenant.userId })).toHaveLength(1);
});

import { randomBytes, randomUUID } from 'crypto';
import type { Page, Response } from '@playwright/test';
import { adminUrl } from '../../support/admin';
import { createAccount, createApiKey, createProject, newClientIp } from '../../support/api';
import { expect, test } from '../../support/fixtures';
import {
  COUNTED_STATE,
  FIRST_MONTH_STATE,
  adminRequest,
  admtenRoutes,
  auditRows,
  cardTitled,
  compTenant,
  createCompPlan,
  customerRequest,
  handoffRows,
  identifyKnownPerson,
  insertTenants,
  listedEmails,
  openOverview,
  recordTenantListRequests,
  seedUsage,
  setRollupState,
  signedInStaff,
  sql,
  stableOverview,
  statCaption,
  statValue,
  tenantCounts,
  tenantRows,
  tenantState,
  usageDay,
  usageShortDay,
  usageSums,
  utcDay,
  type OverviewBody,
  type RollupStateSeed,
  type UsageSeed,
} from '../../support/areas/admten';

/**
 * Admin tenant routes (refusals for bad and unknown ids), the overview and its usage
 * section, and the tenants list: filters, search, sorting and paging. The usage roll-up
 * state is one row for the whole database, so the tests that set it restore it, and
 * figures that are platform-wide are compared with what SQL counts at the same moment.
 */

const term = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;
const fmt = (n: number) => n.toLocaleString('en-US');

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

function isTenantList(response: Response): boolean {
  return new URL(response.url()).pathname === '/api/admin/tenants' && response.request().method() === 'GET';
}

/** Opens the tenants list at `query` and answers the body the page received. */
async function openTenants(page: Page, query = ''): Promise<{ data: Record<string, unknown>[]; meta: Record<string, unknown> }> {
  const [response] = await Promise.all([page.waitForResponse(isTenantList), page.goto(adminUrl(`/tenants${query}`))]);
  expect(response.status()).toBe(200);
  return (await response.json()) as { data: Record<string, unknown>[]; meta: Record<string, unknown> };
}

function urlParams(page: Page): Record<string, string> {
  return Object.fromEntries(new URL(page.url()).searchParams);
}

/** The row of the tenants table showing `email`. */
function rowOf(page: Page, email: string) {
  return tenantRows(page).filter({ has: page.getByRole('link', { name: email, exact: true }) });
}

async function chooseOption(page: Page, combobox: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: combobox }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

function usageSubtitle(page: Page) {
  return page.getByRole('heading', { name: 'Usage, last 30 days' }).locator('xpath=following-sibling::p[1]');
}

const USAGE_TILES = ['Push sent', 'Emails sent', 'SMS sent', 'WhatsApp sent', 'Link clicks', 'Events received'] as const;
const TILE_METRIC: Record<(typeof USAGE_TILES)[number], string> = {
  'Push sent': 'push_sent',
  'Emails sent': 'email_sent',
  'SMS sent': 'sms_sent',
  'WhatsApp sent': 'whatsapp_sent',
  'Link clicks': 'clicks',
  'Events received': 'events',
};

// ---- A. Access

test('ADMTEN-004 the customer API does not serve the ADMTEN admin routes', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  // The same token is accepted where these routes live.
  expect((await adminRequest('GET', '/api/admin/tenants', { token: staff.token, ip: clientIp })).status).toBe(200);
  const before = await tenantState(tenant.userId);

  const list = await customerRequest('GET', '/api/admin/tenants', { token: staff.token, ip: clientIp });
  expect(list.status).toBe(404);
  const suspend = await customerRequest('POST', `/api/admin/tenants/${tenant.userId}/suspend`, {
    token: staff.token,
    ip: clientIp,
    body: { reason: 'E2E: suspending on the customer API' },
  });
  expect(suspend.status).toBe(404);
  for (const response of [list, suspend]) expect(response.text).not.toContain(tenant.email);

  expect(await tenantState(tenant.userId)).toEqual(before);
});

test('ADMTEN-005 a malformed tenant id is refused before anything runs', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const countAudit = async () =>
    (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM admin_audit_logs WHERE actor_id = $1`, [staff.account.userId]))[0].n;
  const auditBefore = await countAudit();
  const routes = admtenRoutes('not-a-uuid').filter((route) => route.path.includes('not-a-uuid'));
  expect(routes).toHaveLength(10);

  for (const route of routes) {
    const response = await adminRequest(route.method, route.path, { token: staff.token, ip: clientIp, body: route.body });
    expect.soft(response.status, `${route.method} ${route.path}`).toBe(400);
    expect.soft(response.json?.message, `${route.method} ${route.path}`).toBe('Validation failed (uuid is expected)');
  }
  expect(await countAudit()).toBe(auditBefore);
});

test('ADMTEN-006 an unknown tenant id answers "Tenant not found"', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const missing = randomUUID();
  const routes = admtenRoutes(missing).filter(
    (route) => route.path.includes(missing) && !(route.method === 'POST' && route.path.endsWith('/factor-reset')),
  );
  expect(routes).toHaveLength(9);

  for (const route of routes) {
    const response = await adminRequest(route.method, route.path, { token: staff.token, ip: clientIp, body: route.body });
    expect.soft(response.status, `${route.method} ${route.path}`).toBe(404);
    expect.soft(response.json?.message, `${route.method} ${route.path}`).toBe('Tenant not found');
  }
  expect(await auditRows({ targetId: missing })).toHaveLength(0);
  expect(await handoffRows({ targetId: missing })).toHaveLength(0);
});

// ---- B. Overview

test('ADMTEN-010 Overview is the landing page and the sidebar marks it', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await expect(page).toHaveURL(adminUrl('/'));
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const overview = sidebar.getByRole('link', { name: 'Overview', exact: true });
  const tenants = sidebar.getByRole('link', { name: 'Tenants', exact: true });
  await expect(overview).toHaveAttribute('data-active', 'true');
  await expect(tenants).toHaveAttribute('data-active', 'false');

  await tenants.click();
  await expect(page).toHaveURL(adminUrl('/tenants'));
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();
  await expect(overview).toHaveAttribute('data-active', 'false');
  await expect(tenants).toHaveAttribute('data-active', 'true');

  await sidebar.getByRole('link', { name: /Chumbaq\s*Super Admin/ }).click();
  await expect(page).toHaveURL(adminUrl('/'));
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(overview).toHaveAttribute('data-active', 'true');
  await expect(tenants).toHaveAttribute('data-active', 'false');
});

test('ADMTEN-012 load failure shows "Could not load the overview." and Try again recovers', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  let calls = 0;
  await page.route('**/api/admin/overview', async (route) => {
    calls++;
    if (calls <= 2) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) });
    } else {
      await route.continue();
    }
  });

  await page.goto(adminUrl('/'));
  const failure = page.getByRole('alert').filter({ hasText: 'Could not load the overview.' });
  await expect(failure).toBeVisible();
  // The hook tried once more on its own before giving up.
  expect(calls).toBe(2);
  await expect(page.getByText('Signups per day', { exact: true })).toHaveCount(0);

  await failure.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Signups per day', { exact: true })).toBeVisible();
  await expect(statValue(page, 'Tenants')).toHaveText(/^[\d,]+$/);
  await expect(failure).toHaveCount(0);
  expect(calls).toBe(3);
});

test('ADMTEN-013 headline cards show the platform totals with their captions', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const body = await openOverview(page);
  // The API's own answer has the same shape.
  const direct = await adminRequest('GET', '/api/admin/overview', { token: staff.token, ip: clientIp });
  expect(direct.status).toBe(200);
  expect(Object.keys((direct.json as { data: object }).data).sort()).toEqual(Object.keys(body).sort());

  const cards: [string, string, number][] = [
    ['Tenants', 'All accounts', body.tenants.total],
    ['Active tenants', 'Not suspended', body.tenants.active],
    ['Suspended tenants', 'Currently suspended', body.tenants.suspended],
    ['New tenants', 'Last 30 days', body.tenants.newLast30d],
    ['Projects', 'Across all tenants', body.projects],
    ['Links', 'Across all tenants', body.links],
    ['Identities', 'Across all tenants', body.identities],
    ['Clicks', 'Last 30 days', body.clicksLast30d],
  ];
  for (const [title, caption, value] of cards) {
    await expect.soft(statValue(page, title), title).toHaveText(fmt(value));
    await expect.soft(statCaption(page, title), title).toHaveText(caption);
  }
  // The first eight cards are exactly these, in this order.
  const titles = await page.locator('[data-slot="card-title"]').allInnerTexts();
  expect(titles.slice(0, 8)).toEqual(cards.map(([title]) => title));
});

test('ADMTEN-014 tenant totals add up and count everyone, super admins included', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  // At least one suspended account, and at least one super admin (the staff member).
  const [blocked] = await insertTenants([{ label: 'blocked', name: 'Bo Blocked' }]);
  await sql(`UPDATE users SET suspended_at = now(), suspended_reason = 'E2E: counted as suspended' WHERE id = $1`, [blocked.id]);

  let body: OverviewBody | null = null;
  let counted: (Awaited<ReturnType<typeof tenantCounts>> & { admins: number }) | null = null;
  const measure = async () => ({
    ...(await tenantCounts()),
    admins: (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE is_super_admin`))[0].n,
  });
  for (let attempt = 0; attempt < 8 && !body; attempt++) {
    const before = await measure();
    const response = await adminRequest('GET', '/api/admin/overview', { token: staff.token, ip: clientIp });
    expect(response.status).toBe(200);
    const after = await measure();
    if (JSON.stringify(before) === JSON.stringify(after)) {
      body = (response.json as { data: OverviewBody }).data;
      counted = before;
    }
  }
  expect(body).not.toBeNull();
  const { tenants, signupsByDay } = body!;
  expect(tenants.active + tenants.suspended).toBe(tenants.total);
  expect(tenants.total).toBe(counted!.total);
  expect(tenants.suspended).toBe(counted!.suspended);
  expect(tenants.suspended).toBeGreaterThanOrEqual(1);
  expect(tenants.newLast30d).toBe(signupsByDay.reduce((sum, day) => sum + day.count, 0));
  expect(tenants.newLast30d).toBe(counted!.new30d);
  // Super admins are tenants too (the staff member among them): leaving them out would give a smaller number.
  expect(counted!.admins).toBeGreaterThanOrEqual(1);
  const [{ isAdmin }] = await sql<{ isAdmin: boolean }>(`SELECT is_super_admin AS "isAdmin" FROM users WHERE id = $1`, [staff.account.userId]);
  expect(isAdmin).toBe(true);
});

test('ADMTEN-015 a new sign-up moves Tenants and New tenants by one', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const today = utcDay(0);
  const todayLabel = (() => {
    const [year, month, date] = today.split('-');
    return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month) - 1]} ${Number(date)}, ${year}`;
  })();
  const todayOf = (body: OverviewBody) => body.signupsByDay.find((day) => day.date.slice(0, 10) === today)?.count ?? 0;

  const first = await stableOverview(page, () => page.goto(adminUrl('/')), () => tenantCounts());
  expect(first.body.tenants.total).toBe(first.measured.total);

  const newcomer = await createAccount(newClientIp(), 'newcomer', 'Nia New');
  const second = await stableOverview(page, () => page.reload(), () => tenantCounts([newcomer.userId]));

  // One more than everyone else, whose own number may have moved meanwhile.
  const othersMoved = second.measured.total - first.measured.total;
  expect(second.body.tenants.total - first.body.tenants.total).toBe(1 + othersMoved);
  expect(second.body.tenants.total).toBe(second.measured.total + 1);
  expect(second.body.tenants.newLast30d).toBe(second.measured.new30d + 1);
  expect(todayOf(second.body)).toBe(second.measured.today + 1);

  await expect(statValue(page, 'Tenants')).toHaveText(fmt(second.body.tenants.total));
  await expect(statValue(page, 'New tenants')).toHaveText(fmt(second.body.tenants.newLast30d));
  const signups = cardTitled(page, 'Signups per day');
  await signups.getByText('View as table').click();
  const todayRow = signups.getByRole('row').filter({ has: page.getByRole('cell', { name: todayLabel, exact: true }) });
  await expect(todayRow.getByRole('cell').nth(1)).toHaveText(fmt(todayOf(second.body)));
});

test('ADMTEN-016 suspending and reactivating move the Active and Suspended cards', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'tenant', 'Tess Tenant');
  const others = () => tenantCounts([tenant.userId]);
  const overviewLink = page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Overview', exact: true });
  const expectCards = async (body: OverviewBody) => {
    await expect(statValue(page, 'Tenants')).toHaveText(fmt(body.tenants.total));
    await expect(statValue(page, 'Active tenants')).toHaveText(fmt(body.tenants.active));
    await expect(statValue(page, 'Suspended tenants')).toHaveText(fmt(body.tenants.suspended));
  };

  await page.goto(adminUrl(`/tenants/${tenant.userId}`));
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  const before = await stableOverview(page, () => overviewLink.click(), others);
  expect(before.body.tenants.suspended).toBe(before.measured.suspended);
  expect(before.body.tenants.active).toBe(before.measured.total - before.measured.suspended + 1);
  await expectCards(before.body);

  // Suspend from the tenant's page, reached without reloading.
  await page.goBack();
  await expect(page.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  const suspend = page.getByRole('dialog', { name: 'Suspend this tenant?' });
  await suspend.getByLabel('Reason').fill('E2E: moving the overview cards');
  await suspend.getByLabel(`Type ${tenant.email} to confirm`).fill(tenant.email);
  await suspend.getByRole('button', { name: 'Suspend tenant' }).click();
  await expect(suspend).toBeHidden();
  await expect(page.getByText('Tenant suspended', { exact: true }).first()).toBeVisible();

  // The cached overview was invalidated: clicking Overview fetches it again.
  const suspended = await stableOverview(page, () => overviewLink.click(), others);
  expect(suspended.body.tenants.total).toBe(suspended.measured.total + 1);
  expect(suspended.body.tenants.suspended).toBe(suspended.measured.suspended + 1);
  expect(suspended.body.tenants.active).toBe(suspended.measured.total - suspended.measured.suspended);
  const othersSuspended = suspended.measured.suspended - before.measured.suspended;
  expect(suspended.body.tenants.suspended - before.body.tenants.suspended).toBe(1 + othersSuspended);
  await expectCards(suspended.body);

  await page.goBack();
  await expect(page.getByRole('button', { name: 'Reactivate' })).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate' }).click();
  const reactivate = page.getByRole('dialog', { name: 'Reactivate this tenant?' });
  await reactivate.getByLabel('Reason').fill('E2E: back to the way it was');
  await reactivate.getByRole('button', { name: 'Reactivate tenant' }).click();
  await expect(reactivate).toBeHidden();
  await expect(page.getByText('Tenant reactivated', { exact: true }).first()).toBeVisible();

  const back = await stableOverview(page, () => overviewLink.click(), others);
  expect(back.body.tenants.suspended).toBe(back.measured.suspended);
  expect(back.body.tenants.active).toBe(back.measured.total - back.measured.suspended + 1);
  await expectCards(back.body);
});

test('ADMTEN-022 usage section before the roll-up has run', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await withUsage(null, [], async () => {
    const body = await openOverview(page);
    expect(body.usageCoverage).toBeNull();
    expect(body.usage30d).toBeNull();
    expect(body.usageTrend).toEqual([]);
    expect(body.topTenants).toEqual([]);
    expect(body.quietTenants).toEqual({ count: 0, tenants: [] });

    await expect(usageSubtitle(page)).toHaveText('Not counted yet');
    for (const title of ['Monthly active devices', ...USAGE_TILES]) {
      await expect.soft(statValue(page, title), title).toHaveText('—');
      await expect.soft(statCaption(page, title), title).toHaveText('Not counted yet');
    }
    await expect(cardTitled(page, 'Usage per day')).toContainText('No usage counted yet');
    await expect(cardTitled(page, 'Usage per day').getByRole('combobox')).toHaveCount(0);
    await expect(cardTitled(page, 'Top tenants')).toContainText('No usage counted yet');
    await expect(cardTitled(page, 'Going quiet')).toContainText('No usage counted yet');
    await expect(cardTitled(page, 'Going quiet').locator('[data-slot="card-description"]')).toHaveText(
      '0 tenants with no usage in 14 days',
    );
  });
});

test('ADMTEN-023 usage tiles show the 30 counted days ending on the last closed day', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [one, two] = await insertTenants([
    { label: 'usage-one', name: 'Usage One' },
    { label: 'usage-two', name: 'Usage Two' },
  ]);
  const [p1, p2] = [randomUUID(), randomUUID()];
  const through = utcDay(-1);
  const rows: UsageSeed[] = [
    { projectId: p1, ownerId: one.id, day: through, metric: 'push_sent', value: 100 },
    { projectId: p2, ownerId: two.id, day: utcDay(-40), metric: 'push_sent', value: 50 },
    { projectId: p1, ownerId: one.id, day: utcDay(-3), metric: 'email_sent', value: 7 },
    { projectId: p2, ownerId: two.id, day: utcDay(-5), metric: 'clicks', value: 12 },
    { projectId: p2, ownerId: two.id, day: utcDay(-30), metric: 'events', value: 300 },
    { projectId: p1, ownerId: one.id, day: through, metric: 'mau_month_to_date', value: 9 },
  ];
  await withUsage(COUNTED_STATE(), rows, async () => {
    const { body, measured: others } = await stableOverview(
      page,
      () => page.goto(adminUrl('/')),
      () => usageSums(utcDay(-30), through, [one.id, two.id]),
    );
    const mine: Record<string, number> = { push_sent: 100, email_sent: 7, sms_sent: 0, whatsapp_sent: 0, clicks: 12, events: 300 };
    expect(body.usageCoverage?.countedThrough).toBe(through);

    await expect(usageSubtitle(page)).toHaveText(`Counted through ${usageDay(through)} (UTC days)`);
    for (const title of USAGE_TILES) {
      const metric = TILE_METRIC[title];
      const expected = mine[metric] + (others[metric] ?? 0);
      expect.soft(body.usage30d?.[metric], metric).toBe(expected);
      await expect.soft(statValue(page, title), title).toHaveText(fmt(expected));
      await expect.soft(statCaption(page, title), title).toHaveText('Last 30 counted days');
    }
  });
});

test('ADMTEN-024 Monthly active devices tile is the last counted day snapshot', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [owner] = await insertTenants([{ label: 'mau-owner', name: 'Mau Owner' }]);
  const project = randomUUID();
  const through = utcDay(-1);
  await withUsage(
    COUNTED_STATE(),
    [
      { projectId: project, ownerId: owner.id, day: through, metric: 'mau_month_to_date', value: 9 },
      { projectId: project, ownerId: owner.id, day: utcDay(-2), metric: 'mau_month_to_date', value: 5 },
    ],
    async () => {
      const { body, measured: others } = await stableOverview(
        page,
        () => page.goto(adminUrl('/')),
        () => usageSums(through, through, [owner.id]),
      );
      const expected = 9 + (others.mau_month_to_date ?? 0);
      expect(body.usage30d?.mau_month_to_date).toBe(expected);
      await expect(statValue(page, 'Monthly active devices')).toHaveText(fmt(expected));
      await expect(statCaption(page, 'Monthly active devices')).toHaveText(`This month, counted through ${usageDay(through)}`);
    },
  );
});

test('ADMTEN-027 Usage per day chart defaults to monthly active devices and switches metric', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [owner] = await insertTenants([{ label: 'trend-owner', name: 'Trend Owner' }]);
  const project = randomUUID();
  const days: [string, number][] = [
    [utcDay(-1), 1_111_111],
    [utcDay(-2), 2_222_222],
    [utcDay(-10), 3_333_333],
  ];
  const rows: UsageSeed[] = days.map(([day, value]) => ({ projectId: project, ownerId: owner.id, day, metric: 'events', value }));
  await withUsage(COUNTED_STATE(), rows, async () => {
    const { measured: others } = await stableOverview(
      page,
      () => page.goto(adminUrl('/')),
      async () => {
        const sums: Record<string, number> = {};
        for (const [day] of days) sums[day] = (await usageSums(day, day, [owner.id])).events ?? 0;
        return sums;
      },
    );
    const card = cardTitled(page, 'Usage per day');
    await expect(card.locator('[data-slot="card-description"]')).toHaveText('All tenants, last 90 counted days (UTC)');
    const metric = card.getByRole('combobox', { name: 'Metric shown in the chart' });
    await expect(metric).toHaveText('Monthly active devices');

    await metric.click();
    await expect(page.getByRole('option')).toHaveText([
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
    ]);
    await page.getByRole('option', { name: 'Events received', exact: true }).click();
    await expect(metric).toHaveText('Events received');

    await card.getByText('View as table').click();
    await expect(card.getByRole('columnheader')).toHaveText(['Day', 'Events received']);
    for (const [day, value] of days) {
      const row = card.getByRole('row').filter({ has: page.getByRole('cell', { name: usageDay(day), exact: true }) });
      await expect.soft(row.getByRole('cell').nth(1), day).toHaveText(fmt(value + others[day]));
    }
  });
});

test('ADMTEN-030 today partial counts never reach the overview', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [owner] = await insertTenants([{ label: 'partial', name: 'Pat Partial' }]);
  const project = randomUUID();
  const through = utcDay(-1);
  await withUsage(
    COUNTED_STATE(),
    [
      { projectId: project, ownerId: owner.id, day: through, metric: 'push_sent', value: 1 },
      { projectId: project, ownerId: owner.id, day: utcDay(0), metric: 'push_sent', value: 999 },
    ],
    async () => {
      const { body, measured: others } = await stableOverview(
        page,
        () => page.goto(adminUrl('/')),
        () => usageSums(utcDay(-30), through, [owner.id]),
      );
      expect(body.usage30d?.push_sent).toBe(1 + (others.push_sent ?? 0));
      expect(body.usageTrend.map((day) => day.date)).not.toContain(utcDay(0));
      expect(body.usageTrend.at(-1)?.date).toBe(through);
      expect(body.usageTrend.at(-1)?.values.push_sent).toBeLessThan(999);
    },
  );
});

test('ADMTEN-031 Top tenants lists the busiest, linked to their pages', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [a, b, c] = await insertTenants([
    { label: 'top-a', name: 'Alpha Busy' },
    { label: 'top-b', name: 'Beta Devices' },
    { label: 'top-c', name: 'Gamma Idle' },
  ]);
  const through = utcDay(-1);
  const [pa, pb] = [randomUUID(), randomUUID()];
  // Far above anything else in the database, so these two lead the list.
  const rows: UsageSeed[] = [
    { projectId: pa, ownerId: a.id, day: through, metric: 'push_sent', value: 500_000_000 },
    { projectId: pa, ownerId: a.id, day: through, metric: 'mau_month_to_date', value: 10_000_000 },
    { projectId: pb, ownerId: b.id, day: utcDay(-3), metric: 'email_sent', value: 20_000_000 },
    { projectId: pb, ownerId: b.id, day: through, metric: 'mau_month_to_date', value: 300_000_000 },
  ];
  await withUsage(COUNTED_STATE(), rows, async () => {
    const body = await openOverview(page);
    expect(body.topTenants.slice(0, 2).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(body.topTenants.map((t) => t.id)).not.toContain(c.id);

    const card = cardTitled(page, 'Top tenants');
    await expect(card.locator('[data-slot="card-description"]')).toHaveText('By messages sent in 30 days plus monthly active devices');
    await expect(card.getByRole('columnheader')).toHaveText(['Tenant', 'Monthly active devices', 'Messages (30d)']);
    const bodyRows = card.locator('tbody tr');
    await expect(bodyRows.nth(0).getByRole('cell')).toHaveText([`${a.email}${a.name}`, '10,000,000', '500,000,000']);
    await expect(bodyRows.nth(1).getByRole('cell')).toHaveText([`${b.email}${b.name}`, '300,000,000', '20,000,000']);
    await expect(card.getByText(c.email, { exact: true })).toHaveCount(0);

    await card.getByRole('link', { name: b.email, exact: true }).click();
    await expect(page).toHaveURL(adminUrl(`/tenants/${b.id}`));
    await expect(page.getByText(b.email, { exact: true }).first()).toBeVisible();
  });
});

test('ADMTEN-034 Going quiet lists tenants with no usage in 14 counted days', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [q, r, s, n] = await insertTenants([
    { label: 'quiet-q', name: 'Quinn Quiet' },
    { label: 'quiet-r', name: 'Rae Recent' },
    { label: 'quiet-s', name: 'Sol Still' },
    { label: 'quiet-n', name: 'Nev Never' },
  ]);
  const through = utcDay(-1);
  const day = (beforeThrough: number) => utcDay(-1 - beforeThrough);
  const rows: UsageSeed[] = [
    { projectId: randomUUID(), ownerId: q.id, day: day(20), metric: 'events', value: 4 },
    { projectId: randomUUID(), ownerId: r.id, day: day(14), metric: 'events', value: 4 },
    { projectId: randomUUID(), ownerId: s.id, day: day(13), metric: 'events', value: 4 },
  ];
  await withUsage(COUNTED_STATE(), rows, async () => {
    const body = await openOverview(page);
    expect(body.usageCoverage?.countedThrough).toBe(through);
    expect(body.quietTenants.count).toBe(2);
    expect(body.quietTenants.tenants.map((t) => t.id)).toEqual([r.id, q.id]);

    const card = cardTitled(page, 'Going quiet');
    await expect(card.locator('[data-slot="card-description"]')).toHaveText('2 tenants with no usage in 14 days');
    await expect(card.getByRole('columnheader')).toHaveText(['Tenant', 'Last usage']);
    const bodyRows = card.locator('tbody tr');
    await expect(bodyRows).toHaveCount(2);
    await expect(bodyRows.nth(0).getByRole('cell')).toHaveText([`${r.email}${r.name}`, `last usage ${usageShortDay(day(14))}`]);
    await expect(bodyRows.nth(1).getByRole('cell')).toHaveText([`${q.email}${q.name}`, `last usage ${usageShortDay(day(20))}`]);
    for (const absent of [s, n]) await expect(card.getByText(absent.email, { exact: true })).toHaveCount(0);
    await expect(card.getByRole('link', { name: q.email, exact: true })).toHaveAttribute('href', `/tenants/${q.id}`);
    await expect(card.getByRole('link', { name: r.email, exact: true })).toHaveAttribute('href', `/tenants/${r.id}`);
  });
});

test('ADMTEN-037 tenant names and emails on the overview render as text', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const name = '<img src=x onerror=alert(1)>';
  const tenant = await createAccount(newClientIp(), 'markup', name);
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await withUsage(
    COUNTED_STATE(),
    [{ projectId: randomUUID(), ownerId: tenant.userId, day: utcDay(-1), metric: 'push_sent', value: 900_000_000 }],
    async () => {
      const body = await openOverview(page);
      expect(body.topTenants[0]?.id).toBe(tenant.userId);
      const card = cardTitled(page, 'Top tenants');
      await expect(card.getByText(name, { exact: true })).toBeVisible();
      await expect(card.getByRole('link', { name: tenant.email, exact: true })).toBeVisible();
      await expect(page.locator('img[src="x"]')).toHaveCount(0);
      await expect(card.locator('img')).toHaveCount(0);
      await page.waitForTimeout(500);
      expect(dialogs).toEqual([]);
    },
  );
});

test('ADMTEN-038 overview shows counts only, never end users', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const tenant = await createAccount(newClientIp(), 'people-owner', 'Pia People');
  const project = await createProject(tenant, clientIp);
  const sdkKey = await createApiKey(tenant, project.id, clientIp);
  const people = [1, 2].map((i) => ({
    externalUserId: `ext-${i}-${randomBytes(5).toString('hex')}`,
    email: `person-${i}-${randomBytes(4).toString('hex')}@people.e2e.example.test`,
  }));
  for (const person of people) await identifyKnownPerson(tenant, project.id, sdkKey, clientIp, person);
  const devices = await sql<{ device_fingerprint: string }>(`SELECT device_fingerprint FROM device_identities WHERE project_id = $1`, [
    project.id,
  ]);
  expect(devices).toHaveLength(2);

  await withUsage(
    COUNTED_STATE(),
    [
      { projectId: project.id, ownerId: tenant.userId, day: utcDay(-1), metric: 'mau_month_to_date', value: 950_000_000 },
      { projectId: project.id, ownerId: tenant.userId, day: utcDay(-2), metric: 'push_sent', value: 2 },
    ],
    async () => {
      const response = await adminRequest('GET', '/api/admin/overview', { token: staff.token, ip: clientIp });
      expect(response.status).toBe(200);
      const body = (response.json as { data: OverviewBody }).data;
      expect(body.topTenants.map((t) => t.id)).toContain(tenant.userId);
      for (const secret of [...people.flatMap((p) => [p.email, p.externalUserId]), ...devices.map((d) => d.device_fingerprint)]) {
        expect(response.text).not.toContain(secret);
      }
      const keys = ['email', 'id', 'lastUsageDay', 'mauThisMonth', 'messagesSent30d', 'name'];
      for (const ref of [...body.topTenants, ...body.quietTenants.tenants]) expect(Object.keys(ref).sort()).toEqual(keys);
      expect(Object.keys(body.quietTenants).sort()).toEqual(['count', 'tenants']);
    },
  );
});

// ---- C. Tenants list

test('ADMTEN-039 tenants page header, export hint and columns', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  await insertTenants([{ label: 'header', name: 'Hal Header' }]);
  await page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Tenants', exact: true }).click();
  await expect(page).toHaveURL(adminUrl('/tenants'));

  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();
  await expect(page.getByText('Every account on the platform and what it owns.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
  await expect(
    page.getByText('This search, filter and sort, every page. Each export is recorded in the audit log.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search tenants' })).toHaveAttribute('placeholder', 'Search by email or name...');
  await expect(page.getByRole('combobox', { name: 'Filter by status' })).toHaveText('All statuses');
  await expect(page.getByRole('combobox', { name: 'Filter by plan' })).toHaveText('All plans');
  const chips = page.getByRole('group', { name: 'Filter by activity' }).getByRole('button');
  await expect(chips).toHaveText(['All', 'New', 'Quiet', 'Never used']);
  for (const [index, pressed] of ['true', 'false', 'false', 'false'].entries()) {
    await expect(chips.nth(index)).toHaveAttribute('aria-pressed', pressed);
  }
  await expect(tenantRows(page).first()).toBeVisible();
  await expect(page.getByRole('main').getByRole('columnheader')).toHaveText([
    'Tenant',
    'Status',
    'Plan',
    'Projects',
    'Monthly active devices',
    'Messages (30d)',
    'Last usage',
    'Joined',
  ]);
});

test('ADMTEN-040 default order is newest first, 25 per page', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  if (n < 30) {
    await insertTenants(Array.from({ length: 30 - n }, (_, i) => ({ label: `filler-${i}`, name: `Filler ${i}` })));
  }

  const [request, listBody] = await Promise.all([
    page.waitForRequest((r) => new URL(r.url()).pathname === '/api/admin/tenants'),
    openTenants(page),
  ]);
  expect(Object.fromEntries(new URL(request.url()).searchParams)).toEqual({ page: '1', limit: '25', sort: 'created_at', order: 'desc' });
  await expect(page).toHaveURL(adminUrl('/tenants'));

  const items = listBody.data as { email: string; createdAt: string }[];
  expect(items).toHaveLength(25);
  const times = items.map((item) => new Date(item.createdAt).getTime());
  expect([...times].sort((x, y) => y - x)).toEqual(times);
  await expect(tenantRows(page)).toHaveCount(25);
  expect(await listedEmails(page)).toEqual(items.map((item) => item.email));
  for (const joined of await tenantRows(page).locator('td:nth-child(8)').allInnerTexts()) {
    expect(joined).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
  }
  const meta = listBody.meta as { total: number; totalPages: number };
  expect(meta.total).toBeGreaterThan(25);
  await expect(page.getByText(`Page 1 of ${meta.totalPages} · ${fmt(meta.total)} tenants`, { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Joined' })).toHaveAttribute('aria-sort', 'descending');
});

test('ADMTEN-041 row content: status badge, super admin badge, plan name, project count', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const t = term('rows');
  const active = await createAccount(newClientIp(), `${t}-a`, 'Ada Active');
  await createProject(active, clientIp);
  await createProject(active, clientIp);
  const [blocked, admin, free] = await insertTenants([
    { label: `${t}-b`, name: 'Bo Blocked' },
    { label: `${t}-s`, name: 'Sid Staff' },
    { label: `${t}-f`, name: 'Fay Free' },
  ]);
  await sql(`UPDATE users SET suspended_at = now(), suspended_reason = 'E2E: a suspended row' WHERE id = $1`, [blocked.id]);
  await sql(`UPDATE users SET is_super_admin = true WHERE id = $1`, [admin.id]);
  const plan = await createCompPlan(staff.token, clientIp, 'growth');
  await compTenant(staff.token, clientIp, active.userId, plan.code);
  const [{ name: freeName }] = await sql<{ name: string }>(`SELECT name FROM plans WHERE code = 'free'`);

  await openTenants(page, `?search=${t}`);
  await expect(tenantRows(page)).toHaveCount(4);
  const cells = (email: string) => rowOf(page, email).getByRole('cell');

  await expect(cells(active.email).nth(1)).toHaveText('active');
  await expect(cells(active.email).nth(2)).toHaveText(plan.name);
  await expect(cells(active.email).nth(3)).toHaveText('2');

  const blockedBadge = cells(blocked.email).nth(1).locator('[data-slot="badge"]');
  await expect(blockedBadge).toHaveText(['suspended']);
  await expect(blockedBadge).toHaveAttribute('data-variant', 'destructive');
  await expect(cells(active.email).nth(1).locator('[data-slot="badge"]')).toHaveAttribute('data-variant', 'secondary');

  await expect(cells(admin.email).nth(1).locator('[data-slot="badge"]')).toHaveText(['active', 'Super admin']);
  await expect(cells(free.email).nth(1).locator('[data-slot="badge"]')).toHaveText(['active']);
  await expect(cells(free.email).nth(2)).toHaveText(freeName);
  await expect(cells(free.email).nth(3)).toHaveText('0');
});

test('ADMTEN-042 usage columns before the roll-up show dashes', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = term('dash');
  await insertTenants([
    { label: `${t}-a`, name: 'Dee Dash' },
    { label: `${t}-b`, name: 'Dot Dash' },
  ]);
  await withUsage(null, [], async () => {
    const body = await openTenants(page, `?search=${t}`);
    expect(body.meta.countedThrough).toBeNull();
    expect(body.data.map((row) => row.mauThisMonth)).toEqual([0, 0]);
    await expect(page.getByText('Usage not counted yet.', { exact: true })).toBeVisible();
    await expect(tenantRows(page)).toHaveCount(2);
    for (const row of await tenantRows(page).all()) {
      await expect(row.getByRole('cell').nth(4)).toHaveText('—');
      await expect(row.getByRole('cell').nth(5)).toHaveText('—');
      await expect(row.getByRole('cell').nth(6)).toHaveText('—');
    }
  });
});

test('ADMTEN-043 usage columns once counted', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = term('cnt');
  const [used, idle] = await insertTenants([
    { label: `${t}-u`, name: 'Una Used' },
    { label: `${t}-v`, name: 'Vic Idle' },
  ]);
  const through = utcDay(-1);
  const project = randomUUID();
  const state = FIRST_MONTH_STATE();
  await withUsage(
    state,
    [
      { projectId: project, ownerId: used.id, day: through, metric: 'mau_month_to_date', value: 9 },
      { projectId: project, ownerId: used.id, day: utcDay(-3), metric: 'push_sent', value: 100 },
      { projectId: project, ownerId: used.id, day: utcDay(-6), metric: 'sms_sent', value: 20 },
    ],
    async () => {
      await openTenants(page, `?search=${t}`);
      const firstOfMonth = `${through.slice(0, 7)}-01`;
      await expect(
        page.getByText(
          `Usage counted through ${usageDay(through)} (UTC days). Monthly active devices: first month counted, counted from ${usageDay(firstOfMonth)}. Quiet means no usage in the last 14 counted days.`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(rowOf(page, used.email).getByRole('cell').nth(4)).toHaveText('9');
      await expect(rowOf(page, used.email).getByRole('cell').nth(5)).toHaveText('120');
      await expect(rowOf(page, used.email).getByRole('cell').nth(6)).toHaveText(usageDay(utcDay(-3)));
      await expect(rowOf(page, idle.email).getByRole('cell').nth(4)).toHaveText('0');
      await expect(rowOf(page, idle.email).getByRole('cell').nth(5)).toHaveText('0');
      await expect(rowOf(page, idle.email).getByRole('cell').nth(6)).toHaveText('None');
    },
  );
});

test('ADMTEN-045 search filters by email or name, debounced, in the URL', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = randomBytes(4).toString('hex');
  const [alice, bob] = await insertTenants([
    { label: `alice${t}`, name: 'Alice Example' },
    { label: `person${t}`, name: `Bob-${t}` },
  ]);
  await openTenants(page);
  await expect(tenantRows(page).first()).toBeVisible();
  const requests = recordTenantListRequests(page);
  const historyLength = await page.evaluate(() => history.length);
  const box = page.getByRole('textbox', { name: 'Search tenants' });

  await box.pressSequentially(`alice${t}`, { delay: 40 });
  await expect(page).toHaveURL(adminUrl(`/tenants?search=alice${t}`));
  await expect.poll(() => listedEmails(page)).toEqual([alice.email]);
  expect(requests.map((params) => params.get('search'))).toEqual([`alice${t}`]);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // Clearing and typing again within the debounce sends only the final term, matched by name.
  requests.length = 0;
  await box.fill('');
  const typed = `BOB-${t.toUpperCase()}`;
  await box.pressSequentially(typed, { delay: 40 });
  await expect(page).toHaveURL(adminUrl(`/tenants?search=${typed}`));
  await expect.poll(() => listedEmails(page)).toEqual([bob.email]);
  expect(requests.map((params) => params.get('search'))).toEqual([typed]);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test('ADMTEN-047 search treats % and _ literally', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const t = randomBytes(4).toString('hex');
  const [percent, plain, underscore, lookalike] = await insertTenants([
    { label: `pct${t}`, name: `100% Real ${t}` },
    { label: `plain${t}`, name: `Plain Name ${t}` },
    { label: `a_b${t}`, name: `Under Score ${t}` },
    { label: `axb${t}`, name: `Ex Bee ${t}` },
  ]);
  const search = async (value: string) => {
    const response = await adminRequest('GET', `/api/admin/tenants?limit=100&search=${encodeURIComponent(value)}`, {
      token: staff.token,
      ip: clientIp,
    });
    expect(response.status).toBe(200);
    return response.json as { data: { id: string; email: string; name: string }[]; meta: { total: number } };
  };

  const percentHits = await search('%');
  expect(percentHits.data.map((row) => row.id)).toContain(percent.id);
  expect(percentHits.data.map((row) => row.id)).not.toContain(plain.id);
  for (const row of percentHits.data) expect(`${row.email} ${row.name}`).toContain('%');
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  expect(percentHits.meta.total).toBeLessThan(n);

  const underscoreHits = await search(`a_b${t}`);
  expect(underscoreHits.data.map((row) => row.id)).toEqual([underscore.id]);
  expect(underscoreHits.data.map((row) => row.id)).not.toContain(lookalike.id);
});

test('ADMTEN-049 search with no match shows the filtered empty state', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const body = await openTenants(page, `?search=${term('zz-no-such-tenant-')}`);
  expect(body.data).toEqual([]);
  const empty = page.getByText('No tenants match this view.', { exact: true });
  await expect(empty).toBeVisible();
  await expect(empty.locator('xpath=..').locator('svg')).toHaveCount(1);
  await expect(page.getByText(/^Page \d+ of/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous page' })).toHaveCount(0);
});

test('ADMTEN-050 status filter', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = term('stat');
  const [active, blocked] = await insertTenants([
    { label: `${t}-a`, name: 'Ari Active' },
    { label: `${t}-b`, name: 'Ben Blocked' },
  ]);
  await sql(`UPDATE users SET suspended_at = now(), suspended_reason = 'E2E: for the status filter' WHERE id = $1`, [blocked.id]);
  // Starting past the last page: choosing a status goes back to the first.
  await openTenants(page, `?search=${t}&page=2`);
  await expect(page.getByText('No tenants match this view.', { exact: true })).toBeVisible();

  await chooseOption(page, 'Filter by status', 'Suspended');
  await expect.poll(() => urlParams(page)).toEqual({ search: t, status: 'suspended' });
  await expect.poll(() => listedEmails(page)).toEqual([blocked.email]);

  await chooseOption(page, 'Filter by status', 'Active');
  await expect.poll(() => urlParams(page)).toEqual({ search: t, status: 'active' });
  await expect.poll(() => listedEmails(page)).toEqual([active.email]);

  await chooseOption(page, 'Filter by status', 'All statuses');
  await expect.poll(() => urlParams(page)).toEqual({ search: t });
  await expect.poll(() => listedEmails(page)).toEqual([active.email, blocked.email]);
});

test('ADMTEN-053 plan filter lists the plans by name', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const t = term('plan');
  const [comped, onFree] = await insertTenants([
    { label: `${t}-g`, name: 'Gil Growth' },
    { label: `${t}-f`, name: 'Fen Free' },
  ]);
  const plan = await createCompPlan(staff.token, clientIp, 'growth');
  await compTenant(staff.token, clientIp, comped.id, plan.code);

  const plansResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/plans' && r.request().method() === 'GET');
  await openTenants(page, `?search=${t}`);
  const plans = ((await (await plansResponse).json()) as { data: { code: string; name: string }[] }).data;
  expect(plans.map((p) => p.code)).toEqual(expect.arrayContaining(['free', plan.code]));
  await expect.poll(() => listedEmails(page)).toEqual([comped.email, onFree.email]);

  await page.getByRole('combobox', { name: 'Filter by plan' }).click();
  await expect(page.getByRole('option')).toHaveText(['All plans', ...plans.map((p) => p.name)]);
  const filtered = page.waitForRequest(
    (r) => new URL(r.url()).pathname === '/api/admin/tenants' && new URL(r.url()).searchParams.get('plan') === plan.code,
  );
  await page.getByRole('option', { name: plan.name, exact: true }).click();
  await filtered;
  await expect.poll(() => urlParams(page)).toEqual({ search: t, plan: plan.code });
  await expect.poll(() => listedEmails(page)).toEqual([comped.email]);
  await expect(page.getByRole('combobox', { name: 'Filter by plan' })).toHaveText(plan.name);

  await chooseOption(page, 'Filter by plan', 'All plans');
  await expect.poll(() => urlParams(page)).toEqual({ search: t });
  await expect.poll(() => listedEmails(page)).toEqual([comped.email, onFree.email]);
});

test('ADMTEN-056 activity chip "New"', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = term('new');
  const [fresh, old] = await insertTenants([
    { label: `${t}-n`, name: 'Nell New' },
    { label: `${t}-o`, name: 'Otis Old', ageSeconds: 40 * 86_400 },
  ]);
  await openTenants(page, `?search=${t}`);
  await expect.poll(() => listedEmails(page)).toEqual([fresh.email, old.email]);

  const chips = page.getByRole('group', { name: 'Filter by activity' });
  await chips.getByRole('button', { name: 'New', exact: true }).click();
  await expect(chips.getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => urlParams(page)).toEqual({ search: t, activity: 'new' });
  await expect.poll(() => listedEmails(page)).toEqual([fresh.email]);
});

/** Q gone quiet (last usage 20 counted days back), A active yesterday, N never used. */
async function activityTenants(prefix: string) {
  const t = term(prefix);
  const [quiet, active, never] = await insertTenants([
    { label: `${t}-q`, name: 'Quin Quiet' },
    { label: `${t}-a`, name: 'Abe Active' },
    { label: `${t}-n`, name: 'Ned Never' },
  ]);
  const rows: UsageSeed[] = [
    { projectId: randomUUID(), ownerId: quiet.id, day: utcDay(-21), metric: 'events', value: 3 },
    { projectId: randomUUID(), ownerId: active.id, day: utcDay(-1), metric: 'push_sent', value: 3 },
  ];
  return { t, quiet, active, never, rows };
}

test('ADMTEN-057 activity chip "Quiet"', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const { t, quiet, active, never, rows } = await activityTenants('qt');
  await withUsage(COUNTED_STATE(), rows, async () => {
    await openTenants(page, `?search=${t}`);
    await expect.poll(() => listedEmails(page)).toEqual([quiet.email, active.email, never.email]);
    const chips = page.getByRole('group', { name: 'Filter by activity' });
    await chips.getByRole('button', { name: 'Quiet', exact: true }).click();
    await expect.poll(() => urlParams(page)).toEqual({ search: t, activity: 'quiet' });
    await expect.poll(() => listedEmails(page)).toEqual([quiet.email]);
    await expect(chips.getByRole('button', { name: 'Quiet', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});

test('ADMTEN-058 activity chip "Never used"', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const { t, quiet, active, never, rows } = await activityTenants('nu');
  await withUsage(COUNTED_STATE(), rows, async () => {
    await openTenants(page, `?search=${t}`);
    const chips = page.getByRole('group', { name: 'Filter by activity' });
    await chips.getByRole('button', { name: 'Never used', exact: true }).click();
    await expect.poll(() => urlParams(page)).toEqual({ search: t, activity: 'never_used' });
    await expect.poll(() => listedEmails(page)).toEqual([never.email]);

    await chips.getByRole('button', { name: 'All', exact: true }).click();
    await expect.poll(() => urlParams(page)).toEqual({ search: t });
    await expect.poll(() => listedEmails(page)).toEqual([quiet.email, active.email, never.email]);
    await expect(chips.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});

test('ADMTEN-061 sorting by a usage column, then flipping it', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = term('sort');
  const [five, fifty, zero] = await insertTenants([
    { label: `${t}-5`, name: 'Five' },
    { label: `${t}-50`, name: 'Fifty' },
    { label: `${t}-0`, name: 'Zero' },
  ]);
  const through = utcDay(-1);
  const rows: UsageSeed[] = [
    { projectId: randomUUID(), ownerId: five.id, day: through, metric: 'mau_month_to_date', value: 5 },
    { projectId: randomUUID(), ownerId: fifty.id, day: through, metric: 'mau_month_to_date', value: 50 },
  ];
  await withUsage(COUNTED_STATE(), rows, async () => {
    await openTenants(page, `?search=${t}`);
    await expect.poll(() => listedEmails(page)).toEqual([five.email, fifty.email, zero.email]);
    const header = page.getByRole('columnheader', { name: 'Monthly active devices' });
    await expect(header).toHaveAttribute('aria-sort', 'none');

    await header.getByRole('button', { name: 'Monthly active devices' }).click();
    await expect.poll(() => urlParams(page)).toEqual({ search: t, sort: 'mau_this_month' });
    await expect.poll(() => listedEmails(page)).toEqual([fifty.email, five.email, zero.email]);
    await expect(tenantRows(page).locator('td:nth-child(5)')).toHaveText(['50', '5', '0']);
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await expect(header.locator('svg.lucide-arrow-down')).toHaveCount(1);

    await header.getByRole('button', { name: 'Monthly active devices' }).click();
    await expect.poll(() => urlParams(page)).toEqual({ search: t, sort: 'mau_this_month', order: 'asc' });
    await expect.poll(() => listedEmails(page)).toEqual([zero.email, five.email, fifty.email]);
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await expect(header.locator('svg.lucide-arrow-up')).toHaveCount(1);
  });
});

test('ADMTEN-066 sort and order validation on the API', async ({ page, clientIp }) => {
  const staff = await signedInStaff(page, clientIp);
  const sortMessage = 'sort must be one of the following values: created_at, mau_this_month, messages_sent_30d, last_usage_day';
  for (const sort of ['email', 'created_at;drop table users']) {
    const response = await adminRequest('GET', `/api/admin/tenants?sort=${encodeURIComponent(sort)}`, { token: staff.token, ip: clientIp });
    expect(response.status, sort).toBe(400);
    expect(response.json?.message, sort).toEqual([sortMessage]);
  }
  const order = await adminRequest('GET', '/api/admin/tenants?order=up', { token: staff.token, ip: clientIp });
  expect(order.status).toBe(400);
  expect(order.json?.message).toEqual(['order must be one of the following values: asc, desc']);

  // The table is still there and the list still answers.
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  expect(n).toBeGreaterThan(0);
  expect((await adminRequest('GET', '/api/admin/tenants?sort=created_at', { token: staff.token, ip: clientIp })).status).toBe(200);
});

test('ADMTEN-068 paging forward and back', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = term('page');
  const tenants = await insertTenants(Array.from({ length: 30 }, (_, i) => ({ label: `${t}-${i}`, name: `Pager ${i}` })));
  await openTenants(page, `?search=${t}`);
  await expect(tenantRows(page)).toHaveCount(25);
  expect(await listedEmails(page)).toEqual(tenants.slice(0, 25).map((x) => x.email));
  await expect(page.getByText('Page 1 of 2 · 30 tenants', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();

  // Page 2 is held a moment, so the old rows can be seen dimmed meanwhile.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === '/api/admin/tenants' && url.searchParams.get('page') === '2',
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByRole('main').locator('table')).toHaveClass(/opacity-60/);
  await expect(tenantRows(page)).toHaveCount(25);
  release();

  await expect.poll(() => urlParams(page)).toEqual({ search: t, page: '2' });
  await expect(tenantRows(page)).toHaveCount(5);
  expect(await listedEmails(page)).toEqual(tenants.slice(25).map((x) => x.email));
  await expect(page.getByRole('main').locator('table')).not.toHaveClass(/opacity-60/);
  await expect(page.getByText('Page 2 of 2 · 30 tenants', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();

  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect.poll(() => urlParams(page)).toEqual({ search: t });
  await expect(tenantRows(page)).toHaveCount(25);
  expect(await listedEmails(page)).toEqual(tenants.slice(0, 25).map((x) => x.email));
});

test('ADMTEN-073 a row opens the tenant and Back to Tenants keeps the view', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = term('back');
  const tenants = await insertTenants(Array.from({ length: 30 }, (_, i) => ({ label: `${t}-${i}`, name: `Backer ${i}` })));
  const query = `?search=${t}&status=active&sort=mau_this_month&page=2`;
  await openTenants(page, query);
  await expect(tenantRows(page)).toHaveCount(5);
  const shown = await listedEmails(page);
  expect(shown).toEqual(tenants.slice(25).map((x) => x.email));
  const target = tenants[25];

  // A click on the Joined cell, not the email, opens the tenant.
  const joined = rowOf(page, target.email).getByRole('cell').nth(7);
  const box = await joined.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page).toHaveURL(adminUrl(`/tenants/${target.id}`));
  await expect(page.getByText(target.email, { exact: true }).first()).toBeVisible();

  await page.getByRole('main').locator('a[data-slot="button"]').filter({ hasText: /^Tenants$/ }).click();
  await expect(page).toHaveURL(adminUrl(`/tenants${query}`));
  await expect(tenantRows(page)).toHaveCount(5);
  expect(await listedEmails(page)).toEqual(shown);
});

test('ADMTEN-077 tenant names render as text in the list', async ({ page, clientIp }) => {
  await signedInStaff(page, clientIp);
  const t = term('xss');
  const names = ['<script>alert(1)</script>', '=HYPERLINK("http://evil")'];
  const tenants = [];
  for (const [i, name] of names.entries()) tenants.push(await createAccount(newClientIp(), `${t}-${i}`, name));
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await openTenants(page, `?search=${t}`);
  await expect(tenantRows(page)).toHaveCount(2);
  for (const [i, tenant] of tenants.entries()) {
    await expect(rowOf(page, tenant.email).getByRole('cell').first().locator('p')).toHaveText(names[i]);
  }
  await expect(page.locator('script', { hasText: 'alert(1)' })).toHaveCount(0);
  await expect(page.getByRole('main').locator('a[href="http://evil"]')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(dialogs).toEqual([]);
});

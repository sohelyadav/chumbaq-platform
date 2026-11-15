import type { BrowserContext, Page, Request } from '@playwright/test';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import type { AdminBillingSummary } from '@chumbaq/shared';
import { adminApi, adminUrl, enrolAndSignInStaff, grantSuperAdmin } from '../../support/admin';
import { apiUrl, createAccount, createProject, newClientIp, type Account } from '../../support/api';
import { runSecrets } from '../../support/stack';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activate,
  activeOn,
  adminCard,
  adminPlanCard,
  adminToast,
  ageSignIns,
  auditRows,
  authenticate,
  billingAccountRow,
  billingEvent,
  billingEventsWithBody,
  cancelCalls,
  cancelPlan,
  changePlan,
  compTenant,
  createdAtMock,
  createPlan,
  DAY_SECONDS,
  deactivatePlan,
  fact,
  gbDate,
  gbDateTime,
  halt,
  longDate,
  makeStaffSignInStale,
  makeSuperAdmin,
  mockCalls,
  mockCallsFor,
  mockSubscription,
  nowSeconds,
  openBilling,
  outboxRow,
  overview,
  planCard,
  postWebhook,
  query,
  rawAdmin,
  rawApi,
  registerMockPlan,
  routeApiTo,
  saveDetails,
  seedInvoice,
  seedMau,
  seedPayment,
  seedRollupThroughYesterday,
  seedSubscriptionRow,
  seedUnknownSubscription,
  sendEvent,
  sendInvoiceEvent,
  sendInvoicePaid,
  sendSubscriptionEvent,
  staffPasskeyToken,
  startVariantAdminApi,
  stateCard,
  stubCheckout,
  subscribe,
  subscriptionRow,
  tenantBillingCard,
  type Active,
  type BillingOffApi,
  type Plan,
} from '../../support/areas/bill';

/**
 * The staff side of billing in the admin app (the Billing summary, the Plans page and
 * the tenant page's Billing card) and the cases added in the coverage review: comps,
 * staff cancels, invoices, recovery and change paths on the customer page, the
 * Razorpay customer, taxed amounts and webhook edge cases. States are reached through
 * the real flow against the local Razorpay mock; rows the flow cannot make quickly
 * (old payments, odd invoices, subscription history) are written with SQL.
 */

test.use({ timezoneId: 'UTC' });

let staffContext: BrowserContext;
let staffPage: Page;
let staffIp: string;
let staff: Account;
let staffToken = '';
let staffTokenAt = 0;
let G: Plan; // monthly 499.00, 10,000 MAU, 20 projects, 10 seats, sort 10
let P: Plan; // monthly 1,499.00 and yearly 14,990.00, 50,000 MAU, standard projects, unlimited seats, sort 20
let L: Plan; // monthly 199.00, 1,000 MAU, 2 projects, 2 seats, sort 5
let inactive: Plan; // a price, but no longer sold

const RECEIVED = { data: { received: true } };
const REAUTH = 'Confirm it is you to continue.';

/** A staff token with a sign-in under five minutes old (staff writes need one within 15). */
async function freshStaff(): Promise<string> {
  if (Date.now() - staffTokenAt > 5 * 60_000) {
    staffToken = await staffPasskeyToken(staffPage, adminUrl('/sign-in'));
    staffTokenAt = Date.now();
  }
  return staffToken;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  staffIp = newClientIp();
  staff = await createAccount(staffIp, 'bill-p1c-staff', 'Bina Staff');
  await grantSuperAdmin(staff.email);
  staffContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: 'UTC',
    extraHTTPHeaders: { 'X-Forwarded-For': staffIp },
  });
  staffPage = await staffContext.newPage();
  staffToken = await enrolAndSignInStaff(staffPage, staff);
  staffTokenAt = Date.now();
  G = await createPlan(staffToken, staffIp, { label: 'Growth', sortOrder: 10, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, monthly: 49_900 });
  P = await createPlan(staffToken, staffIp, {
    label: 'Pro',
    sortOrder: 20,
    mauLimit: 50_000,
    projectLimit: null,
    seatLimit: null,
    monthly: 149_900,
    yearly: 1_499_000,
  });
  L = await createPlan(staffToken, staffIp, { label: 'Lite', sortOrder: 5, mauLimit: 1_000, projectLimit: 2, seatLimit: 2, monthly: 19_900 });
  inactive = await createPlan(staffToken, staffIp, { label: 'Retired', sortOrder: 31, mauLimit: 100, projectLimit: 2, seatLimit: 2, monthly: 29_900 });
  await deactivatePlan(staffToken, staffIp, inactive.code);
});

test.afterAll(async () => {
  await staffContext?.close();
});

/** Requests to one API path (exactly, query string aside) made by the page from now on. */
function watch(page: Page, pathname: string, method = 'GET'): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === pathname && request.method() === method) seen.push(request);
  });
  return seen;
}

const isPath = (pathname: string, method?: string) => (r: { url(): string; request(): Request }) =>
  new URL(r.url()).pathname === pathname && (method === undefined || r.request().method() === method);

/** The next request to an API path from this page. */
function nextRequest(page: Page, pathname: string, method = 'POST'): Promise<Request> {
  return page.waitForRequest((r) => new URL(r.url()).pathname === pathname && r.method() === method);
}

/** Opens a tenant's page in the admin app and waits for its Billing card. */
async function openTenant(tenant: Pick<Account, 'userId' | 'email'>): Promise<void> {
  await staffPage.goto(adminUrl(`/tenants/${tenant.userId}`));
  await expect(staffPage.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  await expect(fact(tenantBillingCard(staffPage), 'State')).toBeVisible();
}

/** Opens the admin Billing summary and answers what it was given. */
async function openSummary(): Promise<AdminBillingSummary> {
  await staffPage.goto(adminUrl('/'));
  const shown = staffPage.waitForResponse((r) => isPath('/api/admin/billing/summary', 'GET')(r) && r.ok());
  await staffPage.goto(adminUrl('/billing'));
  const summary = ((await (await shown).json()) as { data: AdminBillingSummary }).data;
  await expect(adminCard(staffPage, 'MRR')).toBeVisible();
  return summary;
}

const summaryOf = async (): Promise<AdminBillingSummary> =>
  adminApi<AdminBillingSummary>('GET', '/api/admin/billing/summary', undefined, await freshStaff(), staffIp);

const button = (page: Page, plan: Plan, label = 'Choose') =>
  planCard(page, plan.name).getByRole('button', { name: label, exact: true });

const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

/**
 * A toast in the customer app, by its title. Found by CSS: while a modal dialog is open
 * the rest of the page, the toast list too, is hidden from the accessibility tree.
 */
const toast = (page: Page, title: string) =>
  page.locator('[aria-label^="Notifications"] li').filter({ has: page.getByText(title, { exact: true }) });

type Checkout = Parameters<typeof activate>[0];

/** The checkout the page's next successful subscribe or change answered. */
function nextCheckout(page: Page, pathname: '/api/billing/subscribe' | '/api/billing/change'): Promise<Checkout> {
  return page
    .waitForResponse((r) => isPath(pathname, 'POST')(r) && r.ok())
    .then(async (r) => ((await r.json()) as { data: Checkout }).data);
}

/** A tenant whose current subscription is past due (Razorpay retrying a renewal). */
async function pendingOn(account: Account, ip: string, plan: Plan): Promise<Active> {
  const active = await activeOn(account, ip, plan);
  await sendSubscriptionEvent('subscription.pending', active.checkout.subscriptionId, { status: 'pending' });
  return active;
}

/** A row of a section of the admin Billing summary, by the tenant's email. */
const summaryRow = (section: string, email: string) => adminCard(staffPage, section).getByRole('row').filter({ hasText: email });

/** An admin action dialog's reason box. */
const reasonBox = (dialog: ReturnType<Page['getByRole']>) => dialog.getByLabel('Reason');

/** The New plan dialog's limits typed in, with a reason. */
async function fillPlanDialog(
  dialog: ReturnType<Page['getByRole']>,
  fields: { code?: string; name?: string; mau?: string; projects?: string; seats?: string; order?: string; reason?: string },
): Promise<void> {
  if (fields.code !== undefined) await dialog.getByLabel('Code').fill(fields.code);
  if (fields.name !== undefined) await dialog.getByLabel('Name').fill(fields.name);
  if (fields.mau !== undefined) await dialog.getByLabel('Monthly active devices').fill(fields.mau);
  if (fields.projects !== undefined) await dialog.getByLabel('Projects').fill(fields.projects);
  if (fields.seats !== undefined) await dialog.getByLabel('Team members').fill(fields.seats);
  if (fields.order !== undefined) await dialog.getByLabel('Order').fill(fields.order);
  if (fields.reason !== undefined) await reasonBox(dialog).fill(fields.reason);
}

// ------------------------------------------------------------------ K. admin /billing summary

test.describe('billing off', () => {
  let off: BillingOffApi;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    off = await startVariantAdminApi('billing-off', { BILLING_ENABLED: 'false' });
  });

  test.afterAll(async () => {
    await off?.stop();
  });

  test('BILL-147 the Billing nav item, and billing off', async () => {
    const token = await freshStaff();
    const nav = staffPage.locator('[data-sidebar="sidebar"]');
    await staffPage.goto(adminUrl('/'));
    await expect(nav.getByRole('link', { name: 'Plans', exact: true })).toBeVisible();
    const summary = staffPage.waitForResponse((r) => isPath('/api/admin/billing/summary', 'GET')(r));
    await nav.getByRole('link', { name: 'Billing', exact: true }).click();
    await expect(staffPage).toHaveURL(/\/billing$/);
    await expect(staffPage.getByRole('heading', { level: 1, name: 'Billing', exact: true })).toBeVisible();
    await expect(
      staffPage.getByText(
        'Paying accounts and money received. Amounts exclude any tax unless they say otherwise. A comp is not revenue, but a comped account that also subscribed is charged, so it counts.',
        { exact: true },
      ),
    ).toBeVisible();
    expect((await summary).status()).toBe(200);

    // The same staff member on a server with billing off.
    await routeApiTo(staffPage, off.url);
    try {
      const seen = watch(staffPage, '/api/admin/billing/summary');
      const me = staffPage.waitForResponse((r) => isPath('/api/staff/auth/me')(r) && r.ok());
      await staffPage.goto(adminUrl('/billing'));
      expect(((await (await me).json()) as { data: { billingEnabled: boolean } }).data.billingEnabled).toBe(false);
      await expect(staffPage.getByText('Billing is off on this server.', { exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'Plans', exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'Billing', exact: true })).toHaveCount(0);
      await expect(staffPage.getByText(/^Paying accounts and money received/)).toHaveCount(0);
      expect(seen).toHaveLength(0);
    } finally {
      await staffPage.unrouteAll({ behavior: 'wait' });
    }
    const refused = await rawAdmin('GET', '/api/admin/billing/summary', { token, ip: staffIp, base: off.url });
    expect([refused.status, refused.body.message]).toEqual([404, 'Not Found']);
    expect((await rawAdmin('GET', '/api/admin/billing/summary', { token, ip: staffIp })).status).toBe(200);
  });

  test('BILL-160 the Plans page with billing off', async ({ clientIp }) => {
    const token = await freshStaff();
    const code = `e2e_off_${randomBytes(3).toString('hex')}`;
    await routeApiTo(staffPage, off.url);
    try {
      const listed = staffPage.waitForResponse((r) => isPath('/api/admin/plans', 'GET')(r) && r.ok());
      await staffPage.goto(adminUrl('/plans'));
      const plans = ((await (await listed).json()) as { data: Array<{ billingEnabled: boolean }> }).data;
      expect(plans.every((plan) => plan.billingEnabled === false)).toBe(true);
      await expect(
        staffPage.getByText('Billing is off on this server. Limits here take effect when it is on.', { exact: true }),
      ).toBeVisible();
      const card = adminPlanCard(staffPage, G.code);
      await expect(card.getByRole('heading', { name: 'Monthly', exact: true })).toBeVisible();
      await expect(card.getByRole('row').filter({ hasText: G.prices.monthly!.razorpayPlanId })).toBeVisible();
      await expect(staffPage.getByRole('button', { name: 'Add price' })).toHaveCount(0);
      await expect(staffPage.getByRole('button', { name: 'Retire' })).toHaveCount(0);

      // New plan and Edit still work.
      await staffPage.getByRole('button', { name: 'New plan' }).click();
      const create = staffPage.getByRole('dialog', { name: 'New plan' });
      await fillPlanDialog(create, { code, name: 'E2E Off plan', mau: '100', projects: '2', seats: '2', order: '50', reason: 'Prepared while off' });
      await create.getByRole('button', { name: 'Create plan' }).click();
      await expect(adminToast(staffPage, `Plan ${code} created`)).toBeVisible();
      await expect(create).toBeHidden();
      await adminPlanCard(staffPage, code).getByRole('button', { name: 'Edit' }).click();
      const edit = staffPage.getByRole('dialog', { name: 'Edit E2E Off plan' });
      await edit.getByLabel('Name').fill('E2E Off plan renamed');
      await reasonBox(edit).fill('Renamed while off');
      await edit.getByRole('button', { name: 'Save' }).click();
      await expect(adminToast(staffPage, `Plan ${code} saved`)).toBeVisible();
      await expect(adminPlanCard(staffPage, code).locator('[data-slot="card-title"]')).toContainText('E2E Off plan renamed');
    } finally {
      await staffPage.unrouteAll({ behavior: 'wait' });
    }
    const [row] = await query<{ name: string }>(`SELECT name FROM plans WHERE code = $1`, [code]);
    expect(row.name).toBe('E2E Off plan renamed');

    // Prices are billing's: refused while it is off, after the staff guards.
    const razorpayPlanId = await registerMockPlan('monthly', 49_900);
    const add = await rawAdmin('POST', `/api/admin/plans/${code}/prices`, {
      token,
      ip: clientIp,
      base: off.url,
      body: { interval: 'monthly', pricePaise: 49_900, razorpayPlanId, reason: 'E2E price while off' },
    });
    expect([add.status, add.body.message]).toEqual([404, 'Not Found']);
    const retire = await rawAdmin('POST', `/api/admin/plans/${G.code}/prices/${G.prices.monthly!.id}/retire`, {
      token,
      ip: clientIp,
      base: off.url,
      body: { reason: 'E2E retire while off' },
    });
    expect([retire.status, retire.body.message]).toEqual([404, 'Not Found']);
    expect(await query(`SELECT 1 FROM plan_prices WHERE plan_code = $1`, [code])).toHaveLength(0);
    expect((await query<{ is_current: boolean }>(`SELECT is_current FROM plan_prices WHERE id = $1`, [G.prices.monthly!.id]))[0].is_current).toBe(true);
    expect((await mockCalls()).some((c) => c.path === `/v1/plans/${razorpayPlanId}`)).toBe(false);
  });
});

test('BILL-151 revenue: the last 30 days and by month', async ({ clientIp }) => {
  const token = await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-151', 'Cara Customer');
  type Revenue = Pick<AdminBillingSummary, 'revenue30d' | 'revenueByMonth'>;
  const read = () => adminApi<Revenue>('GET', '/api/admin/billing/summary', undefined, token, staffIp);
  const month = (d: Date) => d.toISOString().slice(0, 7);
  const thisMonth = month(new Date());
  const oldMonth = month(new Date(Date.now() - 40 * DAY_SECONDS * 1000));
  const net = (r: Revenue, m: string) => r.revenueByMonth.find((x) => x.month === m)!;

  let checked = false;
  for (let attempt = 0; attempt < 4 && !checked; attempt += 1) {
    const startedAt = new Date(Date.now() - 1000);
    const before = await read();
    await seedPayment(tenant.userId, { amount: 49_900, status: 'captured' });
    await seedPayment(tenant.userId, { amount: 49_900, status: 'captured', paidAgoSeconds: 40 * DAY_SECONDS });
    await seedPayment(tenant.userId, { amount: 49_900, status: 'refunded', refunded: 10_000 });
    await seedPayment(tenant.userId, { amount: 49_900, status: 'failed', method: 'card', failureReason: 'payment_failed' });
    const after = await read();
    // Another spec's payment landing between the two reads would move the totals too.
    const [{ others }] = await query<{ others: number }>(
      `SELECT count(*)::int AS others FROM billing_payments WHERE user_id <> $1 AND updated_at >= $2`,
      [tenant.userId, startedAt],
    );
    if (others > 0) continue;

    // The failed payment counts for nothing; the refund comes off; the old one is outside 30 days.
    expect(after.revenue30d.grossPaise - before.revenue30d.grossPaise).toBe(49_900 + 39_900);
    expect(after.revenue30d.netPaise - before.revenue30d.netPaise).toBe(49_900 + 39_900);
    expect(after.revenue30d.taxPaise - before.revenue30d.taxPaise).toBe(0);
    // By UTC month: the old payment in its own month.
    expect(net(after, thisMonth).netPaise - net(before, thisMonth).netPaise).toBe(49_900 + 39_900);
    expect(net(after, oldMonth).netPaise - net(before, oldMonth).netPaise).toBe(49_900);
    for (const m of after.revenueByMonth) {
      if (m.month === thisMonth || m.month === oldMonth) continue;
      expect(m.netPaise, m.month).toBe(net(before, m.month).netPaise);
    }
    checked = true;

    // Twelve UTC months, oldest first, the current one last, zeros included.
    expect(after.revenueByMonth).toHaveLength(12);
    const expected = Array.from({ length: 12 }, (_, i) => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - 11 + i);
      return month(d);
    });
    expect(after.revenueByMonth.map((m) => m.month)).toEqual(expected);
    for (const m of after.revenueByMonth) {
      expect(Object.keys(m).sort()).toEqual(['grossPaise', 'month', 'netPaise', 'taxPaise']);
      expect(m.grossPaise).toBe(m.netPaise + m.taxPaise);
    }
  }
  expect(checked).toBe(true);
});

test('BILL-152 the recent payments and failures tables', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-152', 'Cara Customer');
  const captured = await seedPayment(tenant.userId, { amount: 49_900, status: 'captured', method: 'upi', paidAgoSeconds: 3 });
  const refunded = await seedPayment(tenant.userId, { amount: 49_900, status: 'refunded', refunded: 10_000, method: null, paidAgoSeconds: 2 });
  const failed = await seedPayment(tenant.userId, {
    amount: 49_900,
    status: 'failed',
    method: 'card',
    failureReason: 'Card declined by the bank',
    paidAgoSeconds: 1,
  });
  await freshStaff();
  const summary = await openSummary();
  expect(summary.recentPayments.length).toBeLessThanOrEqual(20);
  expect(summary.recentFailures.length).toBeLessThanOrEqual(20);
  const times = summary.recentPayments.map((p) => Date.parse(p.paidAt));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(summary.recentFailures.every((p) => p.status === 'failed')).toBe(true);
  const paidAt = (id: string) => summary.recentPayments.find((p) => p.id === id)!.paidAt;

  const recent = adminCard(staffPage, 'Recent payments');
  await expect(recent.getByRole('columnheader')).toHaveText(['When', 'Tenant', 'Amount', 'Refunded', /^Kept/, 'Status', 'Method']);
  expect(await recent.getByRole('row').count()).toBeLessThanOrEqual(21);
  const rows = recent.getByRole('row').filter({ hasText: tenant.email });
  await expect(rows).toHaveCount(3);
  // Newest first.
  const [f, r, c] = [rows.nth(0), rows.nth(1), rows.nth(2)];
  await expect(f.getByRole('cell')).toHaveText([gbDateTime(paidAt(failed.id)), tenant.email, '₹499.00', '-', '₹0.00', /^failed/, 'card']);
  await expect(r.getByRole('cell')).toHaveText([gbDateTime(paidAt(refunded.id)), tenant.email, '₹499.00', '₹100.00', '₹399.00', 'refunded', '-']);
  await expect(c.getByRole('cell')).toHaveText([gbDateTime(paidAt(captured.id)), tenant.email, '₹499.00', '-', '₹499.00', 'captured', 'upi']);
  const failedBadge = f.locator('[data-slot="badge"]');
  await expect(failedBadge).toHaveText('failed');
  await expect(failedBadge).toHaveAttribute('data-variant', 'destructive');
  await expect(f.getByText('Card declined by the bank', { exact: true })).toBeVisible();
  await expect(c.locator('[data-slot="badge"]')).toHaveAttribute('data-variant', 'secondary');

  const failures = summaryRow('Recent failed payments', tenant.email);
  await expect(failures).toHaveCount(1);
  await expect(failures.getByText('Card declined by the bank', { exact: true })).toBeVisible();

  const link = c.getByRole('link', { name: tenant.email });
  await expect(link).toHaveAttribute('href', `/tenants/${tenant.userId}`);
  await link.click();
  await expect(staffPage).toHaveURL(new RegExp(`/tenants/${tenant.userId}$`));
  await expect(fact(tenantBillingCard(staffPage), 'State')).toHaveText('No paid plan');
});

test('BILL-153 a failed payment leaves the untaxed copy alone', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'BILL-153' });
  test.fail();
  const tenant = await createAccount(clientIp, 'bill-153', 'Cara Customer');
  await seedPayment(tenant.userId, { amount: 49_900, status: 'failed', method: 'card', failureReason: 'payment_failed' });
  const summary = await summaryOf();
  // Nothing on the page carries tax: the install's rate is 0 and every price is untaxed.
  expect([summary.mrr, summary.arr, summary.revenue30d, ...summary.revenueByMonth].every((m) => m.taxPaise === 0)).toBe(true);
  expect(summary.recentFailures.some((p) => p.tenantId === tenant.userId)).toBe(true);

  await openSummary();
  await expect(summaryRow('Recent failed payments', tenant.email)).toHaveCount(1);
  await expect(adminCard(staffPage, 'MRR').getByText('Monthly recurring revenue.', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(adminCard(staffPage, 'ARR').getByText('Yearly recurring revenue.', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(adminCard(staffPage, 'Recent payments').getByRole('columnheader').nth(4)).toHaveText('Kept', { timeout: 5_000 });
  await expect(adminCard(staffPage, 'Paying accounts by plan').getByRole('columnheader').last()).toHaveText('MRR', { timeout: 5_000 });
  await expect(staffPage.getByText(/excluding tax/)).toHaveCount(0, { timeout: 5_000 });
});

test('BILL-155 the Past due table', async ({ clientIp }) => {
  const a = await createAccount(clientIp, 'bill-155-a', 'Cara Customer');
  const aActive = await pendingOn(a, clientIp, G);
  await query(`UPDATE billing_subscriptions SET status_changed_at = now() - interval '3 days' WHERE provider_subscription_id = $1`, [
    aActive.checkout.subscriptionId,
  ]);
  const ipB = newClientIp();
  const b = await createAccount(ipB, 'bill-155-b', 'Dev Customer');
  const bActive = await activeOn(b, ipB, G);
  await halt(bActive);
  const grace = (await subscriptionRow(bActive.checkout.subscriptionId)).grace_until!;

  await freshStaff();
  const summary = await openSummary();
  const ia = summary.pastDue.findIndex((row) => row.tenantId === a.userId);
  const ib = summary.pastDue.findIndex((row) => row.tenantId === b.userId);
  expect(ia).toBeGreaterThanOrEqual(0);
  expect(ib).toBeGreaterThan(ia);
  expect(summary.pastDue[ia]).toMatchObject({ status: 'pending', daysOverdue: 3, graceUntil: null });
  expect(summary.pastDue[ib]).toMatchObject({ status: 'halted', daysOverdue: 0 });
  const since = summary.pastDue.map((row) => Date.parse(row.since));
  expect(since).toEqual([...since].sort((x, y) => x - y));

  const section = adminCard(staffPage, 'Past due');
  await expect(section.getByText('Payments Razorpay is retrying, and subscriptions it halted.', { exact: true })).toBeVisible();
  await expect(section.getByRole('columnheader')).toHaveText(['Tenant', 'Status', 'Since', 'Days overdue', 'Keeps its plan until']);
  const rowA = summaryRow('Past due', a.email);
  await expect(rowA.getByRole('cell')).toHaveText([a.email, 'Retrying', gbDate(summary.pastDue[ia].since), '3', '-']);
  await expect(rowA.locator('[data-slot="badge"]')).toHaveAttribute('data-variant', 'secondary');
  const rowB = summaryRow('Past due', b.email);
  await expect(rowB.getByRole('cell')).toHaveText([b.email, 'Halted', gbDate(summary.pastDue[ib].since), '0', gbDate(grace)]);
  await expect(rowB.locator('[data-slot="badge"]')).toHaveAttribute('data-variant', 'destructive');
  // Ordered by since: A (three days) above B (now).
  const order = await section.getByRole('row').evaluateAll(
    (rows, emails) => rows.map((row) => emails.findIndex((e) => row.textContent?.includes(e))).filter((i) => i >= 0),
    [a.email, b.email],
  );
  expect(order).toEqual([0, 1]);
});

test('BILL-157 the Complimentary plans section shows reasons as text', async ({ clientIp }) => {
  const token = await freshStaff();
  const reason = '<script>alert(1)</script> pilot\nsecond line';
  const one = await createAccount(clientIp, 'bill-157-a', 'Cara Customer');
  await adminApi('POST', `/api/admin/tenants/${one.userId}/billing/comp`, { planCode: G.code, reason }, token, clientIp);
  const ip2 = newClientIp();
  const two = await createAccount(ip2, 'bill-157-b', 'Dev Customer');
  const until = new Date(Date.now() + 20 * DAY_SECONDS * 1000).toISOString();
  await compTenant(token, clientIp, two.userId, P.code, until);
  await activeOn(two, ip2, G);

  const dialogs: string[] = [];
  const onDialog = async (dialog: import('@playwright/test').Dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  };
  staffPage.on('dialog', onDialog);
  await openSummary();
  const section = adminCard(staffPage, 'Complimentary plans');
  await expect(section.getByRole('columnheader')).toHaveText(['Tenant', 'Plan', 'Until', 'Reason', 'Also paying']);
  const first = summaryRow('Complimentary plans', one.email);
  await expect(first.getByRole('cell')).toHaveText([one.email, G.code, 'Until ended', /^<script>alert\(1\)<\/script> pilot\s+second line$/, 'No']);
  // Literally, with its line break, and no element made of it.
  expect(await first.getByRole('cell').nth(3).innerText()).toBe(reason);
  await expect(section.locator('script')).toHaveCount(0);
  const second = summaryRow('Complimentary plans', two.email);
  await expect(second.getByRole('cell')).toHaveText([two.email, P.code, gbDate(until), 'E2E: a complimentary plan', 'Yes: a subscription charges it']);
  staffPage.off('dialog', onDialog);
  expect(dialogs).toEqual([]);
});

// ------------------------------------------------------------------ L. admin /plans

test('BILL-159 the Plans page lists plans with their limits and the tax line', async () => {
  await freshStaff();
  await staffPage.goto(adminUrl('/'));
  const listed = staffPage.waitForResponse((r) => isPath('/api/admin/plans', 'GET')(r) && r.ok());
  await staffPage.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(staffPage).toHaveURL(/\/plans$/);
  const plans = ((await (await listed).json()) as { data: Array<{ code: string; newPriceTaxRateBps: number }> }).data;
  expect(plans[0].newPriceTaxRateBps).toBe(0);

  await expect(staffPage.getByRole('heading', { level: 1, name: 'Plans', exact: true })).toBeVisible();
  await expect(staffPage.getByText('Limits and prices.', { exact: true })).toBeVisible();
  await expect(
    staffPage.getByText(
      'No tax is added to new prices: the Razorpay plan behind a price must charge exactly the price shown. Earlier prices keep the rate they were added with.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(staffPage.getByRole('button', { name: 'New plan' })).toBeVisible();

  const free = adminPlanCard(staffPage, 'free');
  await expect(free.locator('[data-slot="card-title"]')).toHaveText(/^Free\s*free$/);
  await expect(free.locator('[data-slot="card-description"]')).toHaveText(
    'Unlimited monthly active devices · Default (10) projects · Default (no limit) team members · order 0',
  );
  await expect(free.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(free.getByRole('button', { name: 'Add price' })).toHaveCount(0);
  await expect(free.getByRole('heading', { name: 'Monthly' })).toHaveCount(0);

  const growth = adminPlanCard(staffPage, G.code);
  await expect(growth.locator('[data-slot="card-description"]')).toHaveText(
    '10,000 monthly active devices · 20 projects · 10 team members · order 10',
  );
  await expect(growth.getByRole('heading', { level: 3 })).toHaveText(['Monthly', 'Yearly']);
  await expect(growth.getByRole('button', { name: 'Add price' })).toHaveCount(2);
  await expect(growth.getByText('No yearly price yet.', { exact: true })).toBeVisible();
  await expect(adminPlanCard(staffPage, P.code).getByRole('row').filter({ hasText: P.prices.yearly!.razorpayPlanId })).toBeVisible();

  // In the API's order, which is sort order then code, as the database orders them.
  const shown = await staffPage.locator('[data-slot="card-title"] span.font-mono').allInnerTexts();
  expect(shown).toEqual(plans.map((plan) => plan.code));
  const ordered = await query<{ code: string }>(`SELECT code FROM plans ORDER BY sort_order, code`);
  expect(shown).toEqual(ordered.map((row) => row.code));
  expect(shown[0]).toBe('free');
});

test('BILL-163 the New plan dialog checks its fields', async () => {
  await freshStaff();
  await staffPage.goto(adminUrl('/plans'));
  await staffPage.getByRole('button', { name: 'New plan' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'New plan' });
  const submit = dialog.getByRole('button', { name: 'Create plan' });
  const checks = dialog.locator('ul > li');
  const messages = {
    code: 'Code: 2 to 32 lower-case letters, digits or _, starting with a letter.',
    name: 'Name is required.',
    mau: 'Monthly active devices must be a whole number of at least 1, or blank for unlimited.',
    projects: 'Projects must be 1 to 1000, or blank for the default.',
    seats: 'Team members must be a whole number of at least 1, or blank.',
    order: 'Order must be 0 to 1000.',
  };
  await fillPlanDialog(dialog, { code: 'Pro', name: '', mau: '0', projects: '1001', seats: '2.5', order: '1001', reason: 'A valid reason' });
  await expect(checks).toHaveText(Object.values(messages));
  await expect(submit).toBeDisabled();

  // Fixing each removes its own line.
  const left = { ...messages } as Record<string, string>;
  const fixes: Array<[keyof typeof messages, Parameters<typeof fillPlanDialog>[1]]> = [
    ['code', { code: `e2e_chk_${randomBytes(3).toString('hex')}` }],
    ['name', { name: 'E2E Checked' }],
    ['mau', { mau: '1' }],
    ['projects', { projects: '1000' }],
    ['seats', { seats: '3' }],
    ['order', { order: '1000' }],
  ];
  for (const [field, value] of fixes) {
    await fillPlanDialog(dialog, value);
    delete left[field];
    if (Object.keys(left).length) {
      await expect(checks).toHaveText(Object.values(left));
      await expect(submit).toBeDisabled();
    }
  }
  await expect(checks).toHaveCount(0);
  await expect(submit).toBeEnabled();

  // The reason: at least 3 characters, at most 500.
  const counter = dialog.getByText(/\/500 characters, at least 3\. Recorded in the audit log\.$/);
  await reasonBox(dialog).fill('ab');
  await expect(counter).toHaveText('2/500 characters, at least 3. Recorded in the audit log.');
  await expect(submit).toBeDisabled();
  await reasonBox(dialog).fill('abc');
  await expect(submit).toBeEnabled();
  await expect(counter).not.toHaveClass(/text-destructive/);
  await reasonBox(dialog).fill('x'.repeat(501));
  await expect(counter).toHaveText('501/500 characters, at least 3. Recorded in the audit log.');
  await expect(counter).toHaveClass(/text-destructive/);
  await expect(submit).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('BILL-164 a duplicate plan code is refused in the dialog', async () => {
  await freshStaff();
  await staffPage.goto(adminUrl('/plans'));
  await staffPage.getByRole('button', { name: 'New plan' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'New plan' });
  await fillPlanDialog(dialog, { code: G.code, name: 'E2E Duplicate', mau: '100', projects: '2', seats: '2', order: '10', reason: 'Duplicate code' });
  const reply = staffPage.waitForResponse((r) => isPath('/api/admin/plans', 'POST')(r));
  await dialog.getByRole('button', { name: 'Create plan' }).click();
  expect((await reply).status()).toBe(409);
  await expect(dialog.getByRole('alert')).toHaveText('A plan with that code already exists.');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create plan' })).toBeEnabled();
  expect(await auditRows('billing.plan_created', { targetLabel: G.code })).toHaveLength(1);
  expect((await query<{ name: string }>(`SELECT name FROM plans WHERE code = $1`, [G.code]))[0].name).toBe(G.name);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('BILL-165 create plan API validation', async ({ clientIp }) => {
  const token = await freshStaff();
  const code = `e2e_val_${randomBytes(3).toString('hex')}`;
  const valid = { code, name: 'E2E Valid', mauLimit: 100, projectLimit: 5, seatLimit: 5, sortOrder: 1, reason: 'E2E check' };
  const { mauLimit: _mau, ...withoutMau } = valid;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...valid, code: 'a' }, 'code must be 2 to 32 lower-case letters, digits or _, starting with a letter'],
    [{ ...valid, code: '1abc' }, 'code must be 2 to 32 lower-case letters, digits or _, starting with a letter'],
    [{ ...valid, name: 'n'.repeat(61) }, 'name must be shorter than or equal to 60 characters'],
    [{ ...valid, name: '' }, 'name must be longer than or equal to 1 characters'],
    [withoutMau, 'mauLimit must be an integer number'],
    [{ ...valid, projectLimit: 1001 }, 'projectLimit must not be greater than 1000'],
    [{ ...valid, seatLimit: 0 }, 'seatLimit must not be less than 1'],
    [{ ...valid, sortOrder: -1 }, 'sortOrder must not be less than 0'],
    [{ ...valid, reason: 'ab' }, 'reason must be longer than or equal to 3 characters'],
    [{ ...valid, reason: 'abc\u0000def' }, 'reason must not contain null characters'],
    [{ ...valid, isActive: true }, 'property isActive should not exist'],
  ];
  for (const [body, message] of cases) {
    const reply = await rawAdmin('POST', '/api/admin/plans', { token, ip: clientIp, body });
    expect(reply.status, message).toBe(400);
    expect(reply.body.message, message).toContain(message);
  }
  expect(await query(`SELECT 1 FROM plans WHERE code = $1`, [code])).toHaveLength(0);
  // Nulls are limits too (unlimited, or the default); the valid body goes through.
  const nulls = await rawAdmin('POST', '/api/admin/plans', { token, ip: clientIp, body: { ...valid, mauLimit: null, projectLimit: null, seatLimit: null } });
  expect(nulls.status).toBe(201);
  expect(nulls.body.data).toMatchObject({ code, mauLimit: null, projectLimit: null, seatLimit: null });
  expect(await auditRows('billing.plan_created', { targetLabel: code })).toHaveLength(1);
});

test('BILL-166 editing a plan sends only the changed fields', async ({ clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, clientIp, { label: 'Edited', sortOrder: 32, mauLimit: 10_000, projectLimit: 20, seatLimit: 10 });
  const renamed = `${plan.name} renamed`;
  await staffPage.goto(adminUrl('/plans'));
  const card = adminPlanCard(staffPage, plan.code);
  await card.getByRole('button', { name: 'Edit' }).click();
  let dialog = staffPage.getByRole('dialog', { name: `Edit ${plan.name}` });
  await expect(dialog.getByLabel('Code')).toBeDisabled();
  await expect(dialog.getByLabel('Code')).toHaveValue(plan.code);
  await expect(dialog.getByLabel('Team members')).toHaveValue('10');
  await dialog.getByLabel('Name').fill(renamed);
  await dialog.getByLabel('Team members').fill('');
  await reasonBox(dialog).fill('Rename');
  let request = nextRequest(staffPage, `/api/admin/plans/${plan.code}`, 'PATCH');
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ name: renamed, seatLimit: null, reason: 'Rename' });
  await expect(adminToast(staffPage, `Plan ${plan.code} saved`)).toBeVisible();
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    '10,000 monthly active devices · 20 projects · Unlimited team members · order 32',
  );
  const [audit] = await auditRows('billing.plan_updated', { targetLabel: plan.code });
  expect(audit).toMatchObject({
    reason: 'Rename',
    target_type: 'plan',
    metadata: { before: { name: plan.name, seatLimit: 10 }, after: { name: renamed, seatLimit: null } },
  });

  // Nothing changed: the reason alone, answered 200, and nothing recorded.
  await card.getByRole('button', { name: 'Edit' }).click();
  dialog = staffPage.getByRole('dialog', { name: `Edit ${renamed}` });
  await expect(dialog.getByLabel('Team members')).toHaveValue('');
  await reasonBox(dialog).fill('No-op');
  request = nextRequest(staffPage, `/api/admin/plans/${plan.code}`, 'PATCH');
  const reply = staffPage.waitForResponse((r) => isPath(`/api/admin/plans/${plan.code}`, 'PATCH')(r));
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ reason: 'No-op' });
  expect((await reply).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect(await auditRows('billing.plan_updated', { targetLabel: plan.code })).toHaveLength(1);
});

test('BILL-168 the Free plan cannot be switched off and has no price', async ({ clientIp }) => {
  const token = await freshStaff();
  await staffPage.goto(adminUrl('/plans'));
  // A paid plan's dialog has the switch.
  await adminPlanCard(staffPage, G.code).getByRole('button', { name: 'Edit' }).click();
  const paid = staffPage.getByRole('dialog', { name: `Edit ${G.name}` });
  await expect(paid.getByRole('checkbox', { name: 'Offered to customers' })).toBeChecked();
  await paid.getByRole('button', { name: 'Cancel' }).click();
  await expect(paid).toBeHidden();
  await adminPlanCard(staffPage, 'free').getByRole('button', { name: 'Edit' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Edit Free' });
  await expect(dialog.getByLabel('Code')).toHaveValue('free');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByText('Offered to customers')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  const off = await rawAdmin('PATCH', '/api/admin/plans/free', { token, ip: clientIp, body: { isActive: false, reason: 'test' } });
  expect([off.status, off.body.message]).toEqual([400, 'The Free plan is always available.']);
  const razorpayPlanId = await registerMockPlan('monthly', 49_900);
  const price = await rawAdmin('POST', '/api/admin/plans/free/prices', {
    token,
    ip: clientIp,
    body: { interval: 'monthly', pricePaise: 49_900, razorpayPlanId, reason: 'test' },
  });
  expect([price.status, price.body.message]).toEqual([400, 'The Free plan has no price.']);
  const [free] = await query<{ is_active: boolean }>(`SELECT is_active FROM plans WHERE code = 'free'`);
  expect(free.is_active).toBe(true);
  expect(await query(`SELECT 1 FROM plan_prices WHERE plan_code = 'free'`)).toHaveLength(0);
});

test('BILL-171 rupee input parsing in the Add price dialog', async ({ clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, clientIp, { label: 'Rupees', sortOrder: 33, mauLimit: 100, projectLimit: 2, seatLimit: 2 });
  await staffPage.goto(adminUrl('/plans'));
  await adminPlanCard(staffPage, plan.code).getByRole('button', { name: 'Add price' }).first().click();
  const dialog = staffPage.getByRole('dialog', { name: `Monthly price for ${plan.name}` });
  const amount = dialog.getByLabel(/Price a month/);
  const hint = dialog.locator('[aria-live="polite"]');
  const error = dialog.getByText('Enter rupees with at most two decimals, for example 1,499.50.', { exact: true });
  const submit = dialog.getByRole('button', { name: 'Add price' });
  await dialog.getByLabel('Razorpay plan id').fill(`plan_${randomBytes(7).toString('hex')}`);
  await reasonBox(dialog).fill('Parsing check');

  const accepted: Array<[string, string]> = [
    ['1,499.50', '₹1,499.50'],
    ['₹ 1499', '₹1,499.00'],
    ['0.1', '₹0.10'],
    ['1,49,999', '₹1,49,999.00'],
  ];
  for (const [typed, shown] of accepted) {
    await amount.fill(typed);
    await expect(hint, typed).toHaveText(
      `Razorpay plan must charge exactly ${shown} every 1 month, the price itself, with no tax added, in INR. Create it in Razorpay first, then paste its id.`,
    );
    await expect(error, typed).toHaveCount(0);
    await expect(submit, typed).toBeEnabled();
  }
  for (const typed of ['1499.505', '-5', '1e3', '14,99', 'abc', '1000001']) {
    await amount.fill(typed);
    await expect(error, typed).toBeVisible();
    await expect(hint, typed).toHaveCount(0);
    await expect(submit, typed).toBeDisabled();
  }
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await query(`SELECT 1 FROM plan_prices WHERE plan_code = $1`, [plan.code])).toHaveLength(0);
});

test('BILL-173 add price API validation', async ({ clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, clientIp, { label: 'Validated', sortOrder: 34, mauLimit: 100, projectLimit: 2, seatLimit: 2 });
  const razorpayPlanId = `plan_${randomBytes(7).toString('hex')}`;
  const valid = { interval: 'monthly', pricePaise: 99_900, razorpayPlanId, reason: 'E2E price check' };
  const add = (code: string, body: Record<string, unknown>) =>
    rawAdmin('POST', `/api/admin/plans/${code}/prices`, { token, ip: clientIp, body });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...valid, pricePaise: 0 }, 'pricePaise must not be less than 1'],
    [{ ...valid, pricePaise: 100_000_001 }, 'pricePaise must not be greater than 100000000'],
    [{ ...valid, pricePaise: 49.5 }, 'pricePaise must be an integer number'],
    [{ ...valid, interval: 'weekly' }, 'interval must be one of the following values: monthly, yearly'],
    [{ ...valid, amountPaise: 99_900 }, 'property amountPaise should not exist'],
    [{ ...valid, taxRateBps: 0 }, 'property taxRateBps should not exist'],
  ];
  for (const [body, message] of cases) {
    const reply = await add(plan.code, body);
    expect(reply.status, message).toBe(400);
    expect(reply.body.message, message).toContain(message);
  }
  const unknown = await add(`nosuchplan_${randomBytes(3).toString('hex')}`, valid);
  expect([unknown.status, unknown.body.message]).toEqual([404, 'Plan not found']);
  // Nothing reached Razorpay or the plan.
  expect((await mockCalls()).some((c) => c.path === `/v1/plans/${razorpayPlanId}`)).toBe(false);
  expect(await query(`SELECT 1 FROM plan_prices WHERE plan_code = $1`, [plan.code])).toHaveLength(0);
  // The same body with a plan Razorpay has: accepted.
  await registerMockPlan('monthly', 99_900).then(async (id) => {
    const ok = await add(plan.code, { ...valid, razorpayPlanId: id });
    expect(ok.status).toBe(201);
  });
});

test.describe('taxed', () => {
  let taxed: BillingOffApi;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    taxed = await startVariantAdminApi('taxed', { BILLING_TAX_RATE_BPS: '1800' });
  });

  test.afterAll(async () => {
    await taxed?.stop();
  });

  test('BILL-175 a taxed price added under a tax rate', async ({ clientIp }) => {
    const token = await freshStaff();
    // Not offered, so its taxed price never reaches a customer page of another test.
    const plan = await createPlan(token, clientIp, { label: 'Taxed admin', sortOrder: 35, mauLimit: 5_000, projectLimit: 5, seatLimit: 5 });
    await deactivatePlan(token, clientIp, plan.code);
    const charged = await registerMockPlan('monthly', 117_882);
    const untaxed = await registerMockPlan('monthly', 99_900);
    await routeApiTo(staffPage, taxed.url);
    try {
      await staffPage.goto(adminUrl('/plans'));
      await expect(
        staffPage.getByText(
          'New prices add 18% tax: the Razorpay plan behind a price must charge exactly the price with that tax. Earlier prices keep the rate they were added with.',
          { exact: true },
        ),
      ).toBeVisible();
      const card = adminPlanCard(staffPage, plan.code);
      await card.getByRole('button', { name: 'Add price' }).first().click();
      const dialog = staffPage.getByRole('dialog', { name: `Monthly price for ${plan.name}` });
      await dialog.getByLabel('Price a month, excluding tax (₹)').fill('999');
      await expect(dialog.locator('[aria-live="polite"]')).toHaveText(
        'Razorpay plan must charge exactly ₹1,178.82 every 1 month (₹179.82 tax at 18%), in INR. Create it in Razorpay first, then paste its id.',
      );
      await dialog.getByLabel('Razorpay plan id').fill(untaxed);
      await reasonBox(dialog).fill('Taxed launch price');
      await dialog.getByRole('button', { name: 'Add price' }).click();
      await expect(dialog.getByRole('alert')).toHaveText('That Razorpay plan charges ₹999.00 every 1 month, not ₹1,178.82 a month.');
      expect(await query(`SELECT 1 FROM plan_prices WHERE plan_code = $1`, [plan.code])).toHaveLength(0);

      await dialog.getByLabel('Razorpay plan id').fill(charged);
      await dialog.getByRole('button', { name: 'Add price' }).click();
      await expect(adminToast(staffPage, `Monthly price added to ${plan.name}`)).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(card.getByRole('columnheader')).toHaveText(['Price (excl. tax)', 'Tax', 'Charged', 'Razorpay plan', 'Subscribers', 'Added', '']);
      const row = card.getByRole('row').filter({ hasText: charged });
      await expect(row.getByRole('cell')).toHaveText([
        '₹999.00 Current',
        /^₹179\.82\s*18%$/,
        '₹1,178.82',
        charged,
        '0',
        new Date().toLocaleDateString('en-GB', { timeZone: 'UTC' }),
        'Retire',
      ]);
    } finally {
      await staffPage.unrouteAll({ behavior: 'wait' });
    }
    const [stored] = await query<{ price_paise: number; tax_rate_bps: number; amount_paise: number; is_current: boolean }>(
      `SELECT price_paise, tax_rate_bps, amount_paise, is_current FROM plan_prices WHERE plan_code = $1`,
      [plan.code],
    );
    expect(stored).toStrictEqual({ price_paise: 99_900, tax_rate_bps: 1800, amount_paise: 117_882, is_current: true });
    const [audit] = await auditRows('billing.price_added', { targetLabel: plan.code });
    expect(audit.metadata).toMatchObject({ pricePaise: 99_900, amountPaise: 117_882, taxRateBps: 1800, razorpayPlanId: charged });
  });
});

test('BILL-177 plan writes need a recent staff sign-in, a reason, and are throttled', async ({ page, clientIp }) => {
  test.setTimeout(150_000);
  const second = await createAccount(clientIp, 'bill-177-staff', 'Sia Staff');
  await makeSuperAdmin(second.userId);
  await enrolAndSignInStaff(page, second);
  await makeStaffSignInStale(second.userId);
  // A page load refreshes the access token, which then carries the old sign-in time.
  await page.goto(adminUrl('/plans'));
  const code = `e2e_reauth_${randomBytes(3).toString('hex')}`;
  await page.getByRole('button', { name: 'New plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await fillPlanDialog(dialog, { code, name: 'E2E Reauth', mau: '100', projects: '2', seats: '2', order: '60', reason: 'Old sign-in plan' });
  const sent = watch(page, '/api/admin/plans', 'POST');
  const refused = page.waitForResponse((r) => isPath('/api/admin/plans', 'POST')(r));
  await dialog.getByRole('button', { name: 'Create plan' }).click();
  const first = await refused;
  expect(first.status()).toBe(403);
  expect(((await first.json()) as { message: string }).message).toBe(REAUTH);
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Use passkey' }).click();
  await expect(page.getByText(`Plan ${code} created`, { exact: true }).first()).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(sent).toHaveLength(2);
  const audits = await auditRows('billing.plan_created', { targetLabel: code });
  expect(audits).toHaveLength(1);
  expect(audits[0].actor_id).toBe(second.userId);

  // 21 plan writes in a minute from one address: the 21st is refused.
  const token = await freshStaff();
  const burstIp = newClientIp();
  const statuses: number[] = [];
  for (let i = 0; i < 21; i += 1) {
    statuses.push((await rawAdmin('PATCH', `/api/admin/plans/${code}`, { token, ip: burstIp, body: { reason: 'E2E throttle check' } })).status);
  }
  expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
  expect(statuses[20]).toBe(429);

  // A customer's token is not a staff token; the customer API has no admin routes.
  const customer = await createAccount(newClientIp(), 'bill-177-c', 'Cara Customer');
  expect((await rawAdmin('GET', '/api/admin/plans', { token: customer.accessToken, ip: clientIp })).status).toBe(401);
  expect((await rawApi('GET', '/api/admin/plans', { token: customer.accessToken, ip: clientIp })).status).toBe(404);
  expect((await rawApi('GET', '/api/admin/plans', { token, ip: clientIp })).status).toBe(404);
});

// ------------------------------------------------------------------ M. tenant page Billing card

test('BILL-178 the card\'s facts for an active tenant', async ({ clientIp }) => {
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-178', 'Cara Customer');
  const project = await createProject(tenant, clientIp, 'Counted project');
  const active = await activeOn(tenant, clientIp, G, { gstin: '29ABCDE1234F1Z5' });
  const counted = await seedRollupThroughYesterday();
  await seedMau(project.id, tenant.userId, counted, 1_234);

  const read = staffPage.waitForResponse((r) => isPath(`/api/admin/tenants/${tenant.userId}/billing`, 'GET')(r) && r.ok());
  await openTenant(tenant);
  const body = ((await (await read).json()) as { data: { overview: Record<string, unknown> } }).data;
  expect(body.overview).not.toHaveProperty('plans');
  expect(body.overview).not.toHaveProperty('keyId');

  const card = tenantBillingCard(staffPage);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText('Billing');
  await expect(fact(card, 'Plan')).toHaveText(G.name);
  await expect(fact(card, 'State')).toHaveText('Active');
  await expect(fact(card, 'Interval')).toHaveText('Monthly');
  await expect(fact(card, 'Next charge')).toHaveText(`${gbDate(active.periodEnd)}₹499.00`);
  await expect(fact(card, 'Monthly active devices')).toHaveText('1,234 of 10,000');
  await expect(fact(card, 'Billed to')).toHaveText('Bela Buyer Labs29ABCDE1234F1Z5');
  await expect(card.getByRole('button', { name: 'Comp a plan' })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Cancel subscription' })).toBeEnabled();

  const subscriptions = card.getByRole('table').first();
  await expect(subscriptions.getByRole('columnheader')).toHaveText(['Plan', 'Status', 'Amount', 'Period end', 'Method', 'Razorpay id', 'Created']);
  const row = subscriptions.getByRole('row').filter({ hasText: active.checkout.subscriptionId });
  await expect(row.getByRole('cell')).toHaveText([
    `${G.name}, Monthly`,
    'Active',
    '₹499.00',
    gbDate(active.periodEnd),
    '-',
    active.checkout.subscriptionId,
    gbDate(new Date()),
  ]);
  for (const section of ['Invoices', 'Payments']) {
    const block = card.locator('div.space-y-2').filter({ has: staffPage.getByRole('heading', { name: section, exact: true }) });
    await expect(block.getByText('None.', { exact: true })).toBeVisible();
  }

  // One staff read of the tenant, the tenant page and its billing card together.
  const views = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM admin_audit_logs WHERE action = 'tenant.viewed' AND target_id = $1 AND actor_id = $2`,
    [tenant.userId, staff.userId],
  );
  expect(views[0].n).toBe(1);
});

test('BILL-180 comp with no end', async ({ page, clientIp }) => {
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-180', 'Cara Customer');
  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await card.getByRole('button', { name: 'Comp a plan' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Give a complimentary plan' });
  await dialog.getByLabel('Plan').click();
  await staffPage.getByRole('option', { name: G.name, exact: true }).click();
  await reasonBox(dialog).fill('Pilot customer, open ended');
  const request = nextRequest(staffPage, `/api/admin/tenants/${tenant.userId}/billing/comp`);
  await dialog.getByRole('button', { name: 'Give plan' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ planCode: G.code, reason: 'Pilot customer, open ended' });
  await expect(adminToast(staffPage, 'Complimentary plan given')).toBeVisible();
  await expect(card.getByText(`Complimentary ${G.code}, until ended`, { exact: true })).toBeVisible();
  const [audit] = await auditRows('billing.comp_granted', { targetId: tenant.userId });
  expect(audit.metadata).toStrictEqual({ planCode: G.code, until: null });

  await openSummary();
  await expect(summaryRow('Complimentary plans', tenant.email).getByRole('cell').nth(2)).toHaveText('Until ended');

  await signIn(page, tenant);
  await openBilling(page);
  const state = stateCard(page);
  await expect(state.locator('[data-slot="card-title"]')).toHaveText(G.name);
  await expect(state.getByText('Complimentary.', { exact: true })).toBeVisible();
});

test('BILL-181 comp refusals', async ({ clientIp }) => {
  const token = await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-181', 'Cara Customer');
  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await card.getByRole('button', { name: 'Comp a plan' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Give a complimentary plan' });
  await dialog.getByLabel('Plan').click();
  await staffPage.getByRole('option', { name: G.name, exact: true }).click();
  const yesterday = new Date(Date.now() - DAY_SECONDS * 1000).toISOString().slice(0, 10);
  await dialog.getByLabel('Ends on (optional)').fill(yesterday);
  // The dialog wants 10 characters of reason, as the API does.
  await reasonBox(dialog).fill('123456789');
  await expect(dialog.getByRole('button', { name: 'Give plan' })).toBeDisabled();
  await reasonBox(dialog).fill('Ends yesterday');
  await dialog.getByRole('button', { name: 'Give plan' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('A comp must end in the future, and within five years.');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  const comp = (tenantId: string, body: Record<string, unknown>) =>
    rawAdmin('POST', `/api/admin/tenants/${tenantId}/billing/comp`, { token, ip: clientIp, body });
  const reason = 'E2E: refusal check';
  const sixYears = new Date(Date.now() + 6 * 365 * DAY_SECONDS * 1000).toISOString();
  const cases: Array<[Record<string, unknown>, number, string]> = [
    [{ planCode: G.code, reason, until: sixYears }, 400, 'A comp must end in the future, and within five years.'],
    [{ planCode: G.code, reason, until: '2026-13-01' }, 400, 'until must be a valid ISO 8601 date string'],
    [{ planCode: 'free', reason }, 400, 'That plan does not exist.'],
    [{ planCode: inactive.code, reason }, 400, 'That plan does not exist.'],
    [{ planCode: `nosuchplan_${randomBytes(2).toString('hex')}`, reason }, 400, 'That plan does not exist.'],
    [{ planCode: 'Bad!', reason }, 400, 'planCode must be a plan code'],
    [{ planCode: G.code, reason: 'short' }, 400, 'reason must be longer than or equal to 10 characters'],
  ];
  for (const [body, statusCode, message] of cases) {
    const reply = await comp(tenant.userId, body);
    expect(reply.status, message).toBe(statusCode);
    const said = Array.isArray(reply.body.message) ? reply.body.message : [reply.body.message];
    expect(said, message).toContain(message);
  }
  expect(await auditRows('billing.comp_granted', { targetId: tenant.userId })).toHaveLength(0);
  expect((await overview(tenant, clientIp)).comp).toBeNull();

  // An account with a subscription.
  const ipD = newClientIp();
  const subscriber = await createAccount(ipD, 'bill-181-d', 'Dev Customer');
  await activeOn(subscriber, ipD, G);
  await openTenant(subscriber);
  await expect(tenantBillingCard(staffPage).getByRole('button', { name: 'Comp a plan' })).toBeDisabled();
  const busy = await comp(subscriber.userId, { planCode: P.code, reason });
  expect([busy.status, busy.body.message]).toEqual([409, 'This account has a subscription. Cancel it first.']);

  const unknown = await comp(randomUUID(), { planCode: G.code, reason });
  expect([unknown.status, unknown.body.message]).toEqual([404, 'Tenant not found']);
  const malformed = await comp('abc', { planCode: G.code, reason });
  expect([malformed.status, malformed.body.message]).toEqual([400, 'Validation failed (uuid is expected)']);
});

test('BILL-182 end a comp', async ({ clientIp }) => {
  const token = await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-182', 'Cara Customer');
  await compTenant(token, clientIp, tenant.userId, G.code);
  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await expect(fact(card, 'State')).toHaveText('Complimentary');
  await card.getByRole('button', { name: 'End comp' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'End the complimentary plan' });
  await expect(dialog.getByText('The account goes back to the plan its subscription gives, or the free plan.', { exact: true })).toBeVisible();
  await reasonBox(dialog).fill('Pilot finished');
  await dialog.getByRole('button', { name: 'End comp' }).click();
  await expect(adminToast(staffPage, 'Complimentary plan ended')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(card.getByRole('button', { name: 'Comp a plan' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'End comp' })).toHaveCount(0);
  await expect(fact(card, 'State')).toHaveText('No paid plan');
  await expect(card.getByText(/^Complimentary /)).toHaveCount(0);
  const [audit] = await auditRows('billing.comp_ended', { targetId: tenant.userId });
  expect(audit).toMatchObject({ reason: 'Pilot finished', metadata: { planCode: G.code, until: null } });
  expect((await overview(tenant, clientIp)).effectivePlan.code).toBe('free');

  const again = await rawAdmin('POST', `/api/admin/tenants/${tenant.userId}/billing/comp/end`, {
    token,
    ip: clientIp,
    body: { reason: 'E2E: ending it twice' },
  });
  expect([again.status, again.body.message]).toEqual([409, 'This account has no comp.']);
  expect(await auditRows('billing.comp_ended', { targetId: tenant.userId })).toHaveLength(1);
});

test('BILL-185 staff cancel refusals', async ({ clientIp }) => {
  const token = await freshStaff();
  const cancel = (tenantId: string, body: Record<string, unknown>) =>
    rawAdmin('POST', `/api/admin/tenants/${tenantId}/billing/cancel`, { token, ip: clientIp, body });
  const reason = 'E2E: refusal check';

  const free = await createAccount(clientIp, 'bill-185-a', 'Cara Customer');
  const none = await cancel(free.userId, { atCycleEnd: true, reason });
  expect([none.status, none.body.message]).toEqual([409, 'There is no subscription to cancel.']);

  const ipB = newClientIp();
  const ending = await createAccount(ipB, 'bill-185-b', 'Dev Customer');
  const endingActive = await activeOn(ending, ipB, G);
  await cancelPlan(ending, ipB);
  const already = await cancel(ending.userId, { atCycleEnd: true, reason });
  expect([already.status, already.body.message]).toEqual([409, 'The subscription already ends at the period end.']);

  const ipC = newClientIp();
  const stopping = await createAccount(ipC, 'bill-185-c', 'Eli Customer');
  const stoppingActive = await activeOn(stopping, ipC, G);
  const first = await cancel(stopping.userId, { atCycleEnd: false, reason });
  expect(first.status).toBe(200);
  const twice = await cancel(stopping.userId, { atCycleEnd: false, reason });
  expect([twice.status, twice.body.message]).toEqual([409, 'A cancel for this subscription is already on its way.']);
  expect((await cancelCalls(stoppingActive.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: false }]);

  const ipD = newClientIp();
  const active = await createAccount(ipD, 'bill-185-d', 'Fay Customer');
  const activeSub = await activeOn(active, ipD, G);
  for (const body of [{ atCycleEnd: 'false', reason }, { reason }]) {
    const reply = await cancel(active.userId, body);
    expect(reply.status).toBe(400);
    expect(reply.body.message).toContain('atCycleEnd must be a boolean value');
  }
  expect(await cancelCalls(activeSub.checkout.subscriptionId)).toEqual([]);
  expect(await cancelCalls(endingActive.checkout.subscriptionId)).toHaveLength(1);
  expect(await auditRows('billing.subscription_cancelled', { targetId: active.userId })).toHaveLength(0);
  expect(await auditRows('billing.subscription_cancelled', { targetId: stopping.userId })).toHaveLength(1);
});

test('BILL-186 a staff cancel Razorpay refuses is queued and reported', async ({ clientIp }) => {
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-186', 'Cara Customer');
  const seeded = await seedUnknownSubscription(tenant.userId, G, { current: true });
  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await expect(fact(card, 'State')).toHaveText('Active');
  await card.getByRole('button', { name: 'Cancel subscription' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Cancel the subscription' });
  await expect(dialog.getByLabel('When')).toHaveText('At the period end');
  await reasonBox(dialog).fill('Customer asked by email');
  const reply = staffPage.waitForResponse((r) => isPath(`/api/admin/tenants/${tenant.userId}/billing/cancel`, 'POST')(r));
  await dialog.getByRole('button', { name: 'Cancel subscription' }).click();
  expect((await reply).status()).toBe(502);
  const answeredAt = Date.now();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Razorpay could not cancel the subscription yet. The cancel is recorded and will be retried.',
  );
  await expect(dialog).toBeVisible();

  const [audit] = await auditRows('billing.subscription_cancelled', { targetId: tenant.userId });
  expect(audit.metadata).toStrictEqual({ subscriptionId: seeded.id, atCycleEnd: true });
  const row = await outboxRow(seeded.providerId);
  expect(row.cancel_error).not.toBeNull();
  expect(row.cancel_sent_at).toBeNull();
  // The failed first try replaced the request's two-minute hold with the minute's backoff.
  const retryIn = new Date(row.cancel_retry_at!).getTime() - answeredAt;
  expect(retryIn).toBeGreaterThan(30_000);
  expect(retryIn).toBeLessThan(75_000);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  const summary = await openSummary();
  expect(summary.outboxErrors).toContainEqual(expect.objectContaining({ subscriptionId: seeded.id, tenantId: tenant.userId }));
  const listed = adminCard(staffPage, 'Cancels not yet sent').getByRole('row').filter({ hasText: seeded.id });
  await expect(listed.getByRole('cell').first()).toHaveText(tenant.userId);
});

test('BILL-187 resend an invoice', async ({ clientIp }) => {
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-187', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const sent = await sendInvoicePaid({
    subscriptionId: active.checkout.subscriptionId,
    customerId: active.checkout.customerId!,
    number: 'INV-RESEND-1',
    amount: 49_900,
    billingStart: active.periodStart,
    billingEnd: active.periodEnd,
    shortUrl: 'https://rzp.io/i/resend1',
  });
  expect(sent.body).toStrictEqual(RECEIVED);
  const [invoice] = await query<{ id: string }>(`SELECT id FROM billing_invoices WHERE provider_invoice_id = $1`, [sent.invoiceId]);
  const notify = `/v1/invoices/${sent.invoiceId}/notify_by/email`;

  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await card.getByRole('row').filter({ hasText: 'INV-RESEND-1' }).getByRole('button', { name: 'Resend' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Resend the invoice' });
  await expect(dialog.getByText("Razorpay emails the invoice's link to the customer again.", { exact: true })).toBeVisible();
  await reasonBox(dialog).fill('Customer lost the email');
  const reply = staffPage.waitForResponse((r) => isPath(`/api/admin/tenants/${tenant.userId}/billing/invoices/${invoice.id}/resend`, 'POST')(r));
  await dialog.getByRole('button', { name: 'Resend' }).click();
  expect(((await (await reply).json()) as { data: unknown }).data).toStrictEqual({ resent: true });
  await expect(adminToast(staffPage, 'Invoice sent again')).toBeVisible();
  await expect(dialog).toBeHidden();
  expect((await mockCalls()).filter((c) => c.method === 'POST' && c.path === notify)).toHaveLength(1);
  const audits = await auditRows('billing.invoice_resent', { targetId: tenant.userId });
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ reason: 'Customer lost the email', metadata: { invoiceId: invoice.id } });
});

test('BILL-188 resend refusals', async ({ clientIp }) => {
  const token = await freshStaff();
  const invoiceOf = async (label: string) => {
    const ip = newClientIp();
    const account = await createAccount(ip, `bill-188-${label}`, 'Cara Customer');
    const active = await activeOn(account, ip, G);
    const sent = await sendInvoicePaid({
      subscriptionId: active.checkout.subscriptionId,
      customerId: active.checkout.customerId!,
      number: `INV-188-${label}`,
      amount: 49_900,
      billingStart: active.periodStart,
      billingEnd: active.periodEnd,
      shortUrl: null,
    });
    const [row] = await query<{ id: string }>(`SELECT id FROM billing_invoices WHERE provider_invoice_id = $1`, [sent.invoiceId]);
    return { account, invoiceId: row.id, providerId: sent.invoiceId };
  };
  const c = await invoiceOf('c');
  const d = await invoiceOf('d');
  const resend = (tenantId: string, invoiceId: string, reason = 'E2E: resend check') =>
    rawAdmin('POST', `/api/admin/tenants/${tenantId}/billing/invoices/${invoiceId}/resend`, { token, ip: clientIp, body: { reason } });

  const elsewhere = await resend(c.account.userId, d.invoiceId);
  expect([elsewhere.status, elsewhere.body.message]).toEqual([404, 'Invoice not found']);
  const missing = await resend(c.account.userId, randomUUID());
  expect([missing.status, missing.body.message]).toEqual([404, 'Invoice not found']);
  const malformed = await resend(c.account.userId, 'abc');
  expect([malformed.status, malformed.body.message]).toEqual([400, 'Validation failed (uuid is expected)']);
  const short = await resend(c.account.userId, c.invoiceId, '123456789');
  expect(short.status).toBe(400);
  expect(short.body.message).toContain('reason must be longer than or equal to 10 characters');
  const notifies = async () => (await mockCalls()).filter((call) => call.path.endsWith('/notify_by/email'));
  const sentFor = async (providerId: string) => (await notifies()).filter((call) => call.path.includes(providerId));
  expect(await sentFor(c.providerId)).toHaveLength(0);
  expect(await sentFor(d.providerId)).toHaveLength(0);
  expect(await auditRows('billing.invoice_resent', { targetId: c.account.userId })).toHaveLength(0);

  // The tenant's own invoice with a reason: sent.
  const ok = await resend(c.account.userId, c.invoiceId);
  expect(ok.status).toBe(200);
  expect(await sentFor(c.providerId)).toHaveLength(1);
  expect(await sentFor(d.providerId)).toHaveLength(0);
});

test('BILL-189 the card\'s tables render provider data safely', async ({ clientIp }) => {
  const token = await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-189', 'Cara Customer');
  const price = G.prices.monthly!;
  const labels: Record<string, string> = {
    created: 'Checkout opened',
    authenticated: 'Authorised',
    active: 'Active',
    pending: 'Retrying payment',
    halted: 'Halted',
    cancelled: 'Cancelled',
    completed: 'Completed',
    expired: 'Expired',
  };
  const rows: Record<string, { id: string; providerId: string }> = {};
  for (const subscriptionStatus of Object.keys(labels)) {
    rows[subscriptionStatus] = await seedSubscriptionRow(tenant.userId, price, G.code, { status: subscriptionStatus });
  }
  const replaced = await seedSubscriptionRow(tenant.userId, price, G.code, { status: 'cancelled', supersededBy: rows.active.id });
  await seedPayment(tenant.userId, { amount: 11_100, status: 'captured', subscriptionId: replaced.id, method: 'card' });
  await seedPayment(tenant.userId, { amount: 22_200, status: 'failed', failureReason: 'Bank said <b>no</b>', method: 'upi' });
  await seedPayment(tenant.userId, { amount: 33_300, status: 'refunded', refunded: 10_000, method: 'upi' });
  await seedInvoice(tenant.userId, { number: 'INV-OK', shortUrl: 'https://rzp.io/i/e2eok' });
  await seedInvoice(tenant.userId, { number: 'INV-JS', shortUrl: 'javascript:alert(1)' });
  await seedInvoice(tenant.userId, { number: 'INV-NULL', shortUrl: null });
  const compReason = '<img src=x onerror="alert(1)"> <b>bold</b> pilot';
  await adminApi('POST', `/api/admin/tenants/${tenant.userId}/billing/comp`, { planCode: G.code, reason: compReason }, token, clientIp);

  const dialogs: string[] = [];
  const onDialog = async (dialog: import('@playwright/test').Dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  };
  staffPage.on('dialog', onDialog);
  try {
    await openTenant(tenant);
    const card = tenantBillingCard(staffPage);
    for (const [subscriptionStatus, label] of Object.entries(labels)) {
      const badges = card.getByRole('row').filter({ hasText: rows[subscriptionStatus].providerId }).locator('[data-slot="badge"]');
      await expect(badges, subscriptionStatus).toHaveText([label]);
    }
    await expect(card.getByRole('row').filter({ hasText: replaced.providerId }).locator('[data-slot="badge"]')).toHaveText(['Cancelled', 'Replaced']);

    const ok = card.getByRole('row').filter({ hasText: 'INV-OK' });
    const link = ok.getByRole('link', { name: 'INV-OK' });
    await expect(link).toHaveAttribute('href', 'https://rzp.io/i/e2eok');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    for (const number of ['INV-JS', 'INV-NULL']) {
      const row = card.getByRole('row').filter({ hasText: number });
      await expect(row.getByRole('cell').first()).toHaveText(number);
      await expect(row.getByRole('link')).toHaveCount(0);
      await row.getByRole('cell').first().click();
    }
    await expect(card.locator('a[href^="javascript"]')).toHaveCount(0);
    const invoices = card.locator('div.space-y-2').filter({ has: staffPage.getByRole('heading', { name: 'Invoices', exact: true }) });
    await expect(invoices.getByRole('columnheader')).toHaveText(['Invoice', 'Status', 'Amount', 'Issued', 'Paid', '']);

    const orphan = card.getByRole('row').filter({ hasText: '₹111.00' });
    await expect(orphan.locator('[data-slot="badge"]')).toHaveText(['captured', 'Orphan charge']);
    const failed = card.getByRole('row').filter({ hasText: '₹222.00' });
    await expect(failed.locator('[data-slot="badge"]')).toHaveText(['failed']);
    await expect(failed.locator('[data-slot="badge"]')).toHaveAttribute('data-variant', 'destructive');
    await expect(failed.getByText('Bank said <b>no</b>', { exact: true })).toBeVisible();
    const refunded = card.getByRole('row').filter({ hasText: '₹333.00' });
    await expect(refunded.getByRole('cell').nth(2)).toHaveText('₹100.00');
    await expect(card.getByText(new RegExp(`by ${staff.email.replace(/[.+]/g, '\\$&')}: `))).toHaveText(
      `Given ${gbDate(new Date())} by ${staff.email}: ${compReason}`,
    );
    await expect(card.locator('img, b')).toHaveCount(0);

    // A Tax column once an invoice carries tax.
    await seedInvoice(tenant.userId, { number: 'INV-TAX', tax: 7_612 });
    await openTenant(tenant);
    await expect(invoices.getByRole('columnheader')).toHaveText(['Invoice', 'Status', 'Amount', 'Tax', 'Issued', 'Paid', '']);
    await expect(card.getByRole('row').filter({ hasText: 'INV-TAX' }).getByRole('cell').nth(3)).toHaveText('₹76.12');
    expect(dialogs).toEqual([]);
  } finally {
    staffPage.off('dialog', onDialog);
  }
});

// ------------------------------------------------------------------ N1. tenant card dialogs

test('BILL-194 the staff cancel dialog on a tenant already ending at the period end offers "Now" chosen', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'BILL-194' });
  test.fail();
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-194', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await cancelPlan(tenant, clientIp);
  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await expect(fact(card, 'State')).toHaveText('Ends at the period end');
  await card.getByRole('button', { name: 'Cancel subscription' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Cancel the subscription' });
  const when = dialog.getByRole('combobox', { name: 'When' });
  await when.click();
  await expect(staffPage.getByRole('option')).toHaveText(['Now']);
  await staffPage.keyboard.press('Escape');
  await expect(staffPage.getByRole('option')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  // The one choice there is, shown chosen, and sent as such.
  await expect(when).toHaveText('Now', { timeout: 5_000 });
  await reasonBox(dialog).fill('Customer asked to stop now');
  const request = nextRequest(staffPage, `/api/admin/tenants/${tenant.userId}/billing/cancel`);
  await dialog.getByRole('button', { name: 'Cancel subscription' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ atCycleEnd: false, reason: 'Customer asked to stop now' });
  await expect(adminToast(staffPage, 'Subscription cancelled at Razorpay')).toBeVisible({ timeout: 5_000 });
  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([
    { cancel_at_cycle_end: true },
    { cancel_at_cycle_end: false },
  ]);
});

test('BILL-198 a staff comp while a comp is active replaces it', async ({ page, clientIp }) => {
  const token = await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-198', 'Cara Customer');
  const until = `${new Date(Date.now() + 30 * DAY_SECONDS * 1000).toISOString().slice(0, 10)}T23:59:59.000Z`;
  await compTenant(token, clientIp, tenant.userId, G.code, until);
  const before = await billingAccountRow(tenant.userId);
  expect(before).toMatchObject({ comp_plan_code: G.code });

  const reply = await rawAdmin('POST', `/api/admin/tenants/${tenant.userId}/billing/comp`, {
    token,
    ip: clientIp,
    body: { planCode: P.code, reason: 'Moved the pilot to Pro' },
  });
  expect(reply.status).toBe(200);
  expect(reply.body.data.comp).toMatchObject({ planCode: P.code, until: null, reason: 'Moved the pilot to Pro', byEmail: staff.email });
  expect(reply.body.data.overview).toMatchObject({ state: 'comped', effectivePlan: { code: P.code, source: 'comp' } });
  const after = await billingAccountRow(tenant.userId);
  expect(after).toMatchObject({ comp_plan_code: P.code, comp_until: null, comp_reason: 'Moved the pilot to Pro', comped_by: staff.userId });
  expect(new Date(after.comped_at).getTime()).toBeGreaterThan(new Date(before.comped_at).getTime());
  const granted = await auditRows('billing.comp_granted', { targetId: tenant.userId });
  expect(granted.map((row) => row.metadata)).toEqual([
    { planCode: G.code, until },
    { planCode: P.code, until: null },
  ]);
  expect(await auditRows('billing.comp_ended', { targetId: tenant.userId })).toHaveLength(0);

  await openTenant(tenant);
  await expect(tenantBillingCard(staffPage).getByText(`Complimentary ${P.code}, until ended`, { exact: true })).toBeVisible();
  await signIn(page, tenant);
  await openBilling(page);
  const state = stateCard(page);
  await expect(state.locator('[data-slot="card-title"]')).toHaveText(P.name);
  await expect(state.getByText('Complimentary.', { exact: true })).toBeVisible();
  const o = await overview(tenant, clientIp);
  expect(o.usage.mau.limit).toBe(50_000);
  expect(o.usage.seats.limit).toBeNull();
  expect(o.usage.projects.limit).toBe(10);
  await expect(state.getByText('Team members: 1 of Unlimited', { exact: true })).toBeVisible();
});

test('BILL-200 a comp on a plan later marked "Not offered" keeps applying', async ({ page, clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, clientIp, { label: 'Pilot tier', sortOrder: 36, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, monthly: 49_900 });
  const tenant = await createAccount(clientIp, 'bill-200', 'Cara Customer');
  await compTenant(token, clientIp, tenant.userId, plan.code);
  try {
    await staffPage.goto(adminUrl('/plans'));
    const card = adminPlanCard(staffPage, plan.code);
    await card.getByRole('button', { name: 'Edit' }).click();
    const dialog = staffPage.getByRole('dialog', { name: `Edit ${plan.name}` });
    await dialog.getByRole('checkbox', { name: 'Offered to customers' }).uncheck();
    await reasonBox(dialog).fill('No longer sold');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(adminToast(staffPage, `Plan ${plan.code} saved`)).toBeVisible();
    await expect(card.locator('[data-slot="card-title"] [data-slot="badge"]')).toHaveText('Not offered');

    await signIn(page, tenant);
    await openBilling(page);
    const state = stateCard(page);
    await expect(state.locator('[data-slot="card-title"]')).toHaveText(plan.name);
    await expect(state.locator('[data-slot="badge"]')).toHaveText('Complimentary');
    await expect(state.getByText('Complimentary.', { exact: true })).toBeVisible();
    await expect(planCard(page, G.name)).toBeVisible();
    await expect(planCard(page, plan.name)).toHaveCount(0);
    await expect(page.getByText('Current plan', { exact: true })).toHaveCount(0);
    await expect(state.getByText('Projects: 0 of 20', { exact: true })).toBeVisible();
    const projects = await rawApi('GET', '/api/projects', { token: tenant.accessToken, ip: clientIp });
    expect(projects.body.meta.projectLimit).toBe(20);

    const summary = await openSummary();
    expect(summary.comped).toContainEqual(expect.objectContaining({ tenantId: tenant.userId, planCode: plan.code }));
    await expect(summaryRow('Complimentary plans', tenant.email)).toHaveCount(1);
    await openTenant(tenant);
    await expect(tenantBillingCard(staffPage).getByText(`Complimentary ${plan.code}, until ended`, { exact: true })).toBeVisible();

    // A new comp of it is refused; this one stays until staff end it.
    const otherIp = newClientIp();
    const other = await createAccount(otherIp, 'bill-200-b', 'Dev Customer');
    const refused = await rawAdmin('POST', `/api/admin/tenants/${other.userId}/billing/comp`, {
      token: await freshStaff(),
      ip: clientIp,
      body: { planCode: plan.code, reason: 'E2E: comp a plan no longer sold' },
    });
    expect([refused.status, refused.body.message]).toEqual([400, 'That plan does not exist.']);
    expect((await overview(tenant, clientIp)).effectivePlan).toMatchObject({ code: plan.code, source: 'comp' });
  } finally {
    await adminApi('PATCH', `/api/admin/plans/${plan.code}`, { isActive: true, reason: 'E2E: offered again' }, await freshStaff(), clientIp);
  }
});

// ------------------------------------------------------------------ N2. customer page after recovery, comps

test('BILL-203 recovery after a retried payment (past due to active)', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-203', 'Cara Customer');
  const active = await pendingOn(tenant, clientIp, G);
  const refused = await rawApi('POST', '/api/billing/change', { token: tenant.accessToken, ip: clientIp, body: { plan: P.code, interval: 'monthly' } });
  expect([refused.status, refused.body.message]).toEqual([409, "Your last payment is being retried. Update your payment method from Razorpay's email."]);
  expect((await summaryOf()).pastDue.map((row) => row.tenantId)).toContain(tenant.userId);

  const charged = await sendEvent('subscription.charged', active.checkout.subscriptionId, { status: 'active' }, { createdAt: nowSeconds() + 5 });
  expect(charged.body).toStrictEqual(RECEIVED);
  expect((await billingEvent(charged.eventId))?.outcome).toBe('applied');

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Active');
  await expect(card.getByText(`Next charge ₹499.00 on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  await expect(page.getByText(/Your last payment is being retried/)).toHaveCount(0);
  await expect(planCard(page, G.name).locator('[data-slot="badge"]')).toHaveText('Current plan');
  await expect(button(page, L, 'Switch')).toBeVisible();
  await expect(button(page, P, 'Switch')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your plan/)).toHaveText(
    `Your plan stays until ${longDate(active.periodEnd)}. After that your account moves to Free; nothing is deleted.`,
  );
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();

  const changed = await changePlan(tenant, clientIp, P.code);
  expect(changed.startsAt).toBe(new Date(active.periodEnd * 1000).toISOString());
  expect((await summaryOf()).pastDue.map((row) => row.tenantId)).not.toContain(tenant.userId);
});

test('BILL-205 a comped account that also pays', async ({ page, clientIp }) => {
  const token = await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-205', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await compTenant(token, clientIp, tenant.userId, P.code);
  const active = await activate(await subscribe(tenant, clientIp, G.code));
  const o = await overview(tenant, clientIp);
  expect(o).toMatchObject({ state: 'comped', effectivePlan: { code: P.code, source: 'comp' }, current: { planCode: G.code } });
  expect(o.usage.mau.limit).toBe(50_000);

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(P.name);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Complimentary');
  // The next charge is said before the comp.
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(`Next charge ₹499.00 on ${longDate(active.periodEnd)}.`);
  await expect(card.getByText('Complimentary.', { exact: true })).toHaveCount(0);
  await expect(planCard(page, G.name).locator('[data-slot="badge"]')).toHaveText('Current plan');
  await expect(button(page, P, 'Switch')).toBeVisible();
  await expect(button(page, L, 'Switch')).toBeVisible();
  await expect(planCard(page, 'Free').getByRole('button')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Yearly' }).click();
  await expect(button(page, P, 'Switch')).toBeVisible();
  await expect(planCard(page, G.name).locator('[data-slot="badge"]')).toHaveText('Coming soon');
  await expect(planCard(page, G.name).getByText('Not available for this period yet', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your plan/)).toHaveText(
    `Your plan stays until ${longDate(active.periodEnd)}. After that your account moves to Free; nothing is deleted.`,
  );
  await dialog.getByRole('button', { name: 'Keep it' }).click();
});

// ------------------------------------------------------------------ N3. change and cancel paths

test('BILL-207 changing to a different plan while cancelling', async ({ page, browser, baseURL, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-207', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await cancelPlan(tenant, clientIp);
  const E = longDate(active.periodEnd);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);
  await expect(button(page, G, 'Keep my plan')).toBeVisible();
  await expect(button(page, L, 'Switch')).toBeVisible();
  await expect(button(page, P, 'Switch')).toBeVisible();

  const request = nextRequest(page, '/api/billing/change');
  const checkout = nextCheckout(page, '/api/billing/change');
  await button(page, P, 'Switch').click();
  expect((await request).postDataJSON()).toStrictEqual({ plan: P.code, interval: 'monthly' });
  const successor = await checkout;
  expect(successor.startsAt).toBe(new Date(active.periodEnd * 1000).toISOString());
  expect((await mockSubscription(successor.subscriptionId)).start_at).toBe(active.periodEnd);
  await authenticate(successor);
  await expect(status(page, 'Change authorised. Its limits start once its first charge goes through.')).toBeVisible();
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Upgrade starts at next charge');
  await expect(card.getByText(`Moves to ${P.name} (monthly) on ${E}.`, { exact: true })).toBeVisible();
  // The current one already ends: no second cancel for it.
  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: true }]);
  expect((await overview(tenant, clientIp)).effectivePlan.code).toBe(G.code);

  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your scheduled change/)).toHaveText(
    `Your scheduled change to ${P.name} is dropped and your plan ends on ${E}. After that your account moves to Free; nothing is deleted.`,
  );
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();

  // The same towards a lower plan.
  const ip2 = newClientIp();
  const other = await createAccount(ip2, 'bill-207-b', 'Dev Customer');
  const otherActive = await activeOn(other, ip2, G);
  await cancelPlan(other, ip2);
  await authenticate(await changePlan(other, ip2, L.code));
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, timezoneId: 'UTC', extraHTTPHeaders: { 'X-Forwarded-For': ip2 } });
  try {
    const page2 = await context.newPage();
    await signIn(page2, other);
    await openBilling(page2);
    await expect(stateCard(page2).locator('[data-slot="badge"]')).toHaveText('Plan change scheduled');
    await expect(
      stateCard(page2).getByText(`Moves to ${L.name} (monthly) on ${longDate(otherActive.periodEnd)}.`, { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('BILL-210 a second cancel of a halted plan before the webhook', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-210', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await halt(active);
  await cancelPlan(tenant, clientIp);
  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: false }]);
  const row = await subscriptionRow(active.checkout.subscriptionId);
  expect(row.cancel_sent_at).not.toBeNull();
  expect(row.cancel_at_cycle_end).toBe(false);

  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Payment failed');
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your plan ends now/)).toHaveText(
    'Your plan ends now and the failed payment is not tried again. Your account moves to Free; nothing is deleted.',
  );
  const reply = page.waitForResponse((r) => isPath('/api/billing/cancel', 'POST')(r));
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  expect((await reply).status()).toBe(201);
  await expect(toast(page, 'Your plan is cancelled')).toBeVisible();
  // Nothing more was sent: the immediate cancel already went.
  expect(await cancelCalls(active.checkout.subscriptionId)).toHaveLength(1);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Payment failed');
  await expect(page.getByRole('button', { name: 'Cancel plan' })).toBeVisible();
});

test('BILL-211 a customer cancel that fails keeps the dialog open', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-211', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const seeded = await seedUnknownSubscription(tenant.userId, G, { current: true });
  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Active');

  // Held, so the busy label can be read.
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/billing/cancel',
    async (route) => {
      await released;
      await route.continue();
    },
  );
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  const reply = page.waitForResponse((r) => isPath('/api/billing/cancel', 'POST')(r));
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancelling...' })).toBeDisabled();
  release();
  expect((await reply).status()).toBe(502);
  const failed = toast(page, 'Could not cancel').filter({ hasText: 'Razorpay could not cancel the subscription. Try again later.' });
  await expect(failed).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel plan' })).toBeEnabled();
  const row = await subscriptionRow(seeded.providerId);
  expect(row.cancel_sent_at).toBeNull();
  expect(row.cancel_at_period_end).toBe(false);
  await page.unrouteAll({ behavior: 'wait' });

  // A request that never reaches the API: the fallback message.
  await page.route((url) => url.pathname === '/api/billing/cancel', (route) => route.abort());
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(toast(page, 'Could not cancel').filter({ hasText: 'Try again.' }).filter({ hasNotText: 'Razorpay' })).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();
  expect((await overview(tenant, clientIp)).state).toBe('active');
});

test('BILL-212 change and cancel through the re-authentication dialog', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-212', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await stubCheckout(page);
  await signIn(page, tenant);
  await ageSignIns(tenant.userId);
  // A page load takes a new access token from the session, carrying the old sign-in time.
  await openBilling(page);
  const reauth = page.getByRole('dialog', { name: 'Confirm it is you' });
  const created = await createdAtMock(tenant.userId);

  // 1. Switch, answered with the password: sent once more, and Checkout opens.
  let changes = watch(page, '/api/billing/change', 'POST');
  const refused = page.waitForResponse((r) => isPath('/api/billing/change', 'POST')(r));
  const checkout = nextCheckout(page, '/api/billing/change');
  await button(page, P, 'Switch').click();
  const first = await refused;
  expect([first.status(), ((await first.json()) as { message: string }).message]).toEqual([403, REAUTH]);
  await expect(reauth).toBeVisible();
  await reauth.getByLabel('Password').fill(tenant.password);
  await reauth.getByRole('button', { name: 'Confirm' }).click();
  await checkout;
  await expect(status(page, 'Processing payment...')).toBeVisible();
  expect(changes).toHaveLength(2);
  expect(await createdAtMock(tenant.userId)).toBe(created + 1);

  // 2. Dismissed: neither the switch nor the cancel goes through.
  await ageSignIns(tenant.userId);
  await openBilling(page);
  changes = watch(page, '/api/billing/change', 'POST');
  await button(page, L, 'Switch').click();
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(reauth).toBeHidden();
  await expect(toast(page, 'Could not start the payment').getByText(REAUTH, { exact: true })).toBeVisible();
  expect(changes).toHaveLength(1);
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(reauth).toBeVisible();
  await reauth.getByRole('button', { name: 'Cancel' }).click();
  await expect(toast(page, 'Could not cancel').getByText(REAUTH, { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await createdAtMock(tenant.userId)).toBe(created + 1);
  expect(await cancelCalls(active.checkout.subscriptionId)).toEqual([]);
  await dialog.getByRole('button', { name: 'Keep it' }).click();

  // 3. Cancel, answered with the password: sent once more, and the plan ends at the period end.
  await ageSignIns(tenant.userId);
  await openBilling(page);
  const cancels = watch(page, '/api/billing/cancel', 'POST');
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(reauth).toBeVisible();
  await reauth.getByLabel('Password').fill(tenant.password);
  await reauth.getByRole('button', { name: 'Confirm' }).click();
  await expect(toast(page, 'Your plan will end at the end of this period')).toBeVisible();
  expect(cancels).toHaveLength(2);
  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: true }]);
});

// ------------------------------------------------------------------ N4. details and the Razorpay customer

test('BILL-213 a legal name rename Razorpay refuses', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-213', 'Cara Customer');
  await saveDetails(tenant, clientIp, { gstin: '29ABCDE1234F1Z5' });
  const customerId = `cust_e2eUnk${randomBytes(4).toString('hex')}`;
  await query(`UPDATE billing_accounts SET provider_customer_id = $2 WHERE user_id = $1`, [tenant.userId, customerId]);
  await signIn(page, tenant);
  await openBilling(page);
  const details = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').getByText('Billing details', { exact: true }) });
  await details.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel(/^GSTIN/)).toBeDisabled();
  await page.getByLabel('Legal name').fill('Bela Buyer Renamed');
  const reply = page.waitForResponse((r) => isPath('/api/billing/details', 'PUT')(r));
  await page.getByRole('button', { name: 'Save details' }).click();
  expect((await reply).status()).toBe(502);
  await expect(details.getByRole('alert')).toHaveText('Razorpay could not update your billing name. Try again later.');
  await expect(page.getByRole('button', { name: 'Save details' })).toBeVisible();
  await expect(page.getByLabel('Legal name')).toHaveValue('Bela Buyer Renamed');
  expect((await billingAccountRow(tenant.userId)).legal_name).toBe('Bela Buyer Labs');
  const renames = async () => (await mockCalls()).filter((c) => c.method === 'PUT' && c.path === `/v1/customers/${customerId}`);
  expect((await renames()).map((c) => c.body)).toEqual([{ name: 'Bela Buyer Renamed' }]);

  // The legal name kept, another field changed: saved, and Razorpay is not asked.
  await openBilling(page);
  await details.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Legal name')).toHaveValue('Bela Buyer Labs');
  await page.getByLabel('City').fill('Mysuru');
  const saved = page.waitForResponse((r) => isPath('/api/billing/details', 'PUT')(r));
  await page.getByRole('button', { name: 'Save details' }).click();
  expect((await saved).status()).toBe(200);
  await expect(toast(page, 'Billing details saved')).toBeVisible();
  expect(await renames()).toHaveLength(1);
  const row = await billingAccountRow(tenant.userId);
  expect(row.legal_name).toBe('Bela Buyer Labs');
  expect(row.address.city).toBe('Mysuru');
});

test('BILL-215 the Razorpay customer is created once and reused', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-215', 'Cara Customer');
  await saveDetails(tenant, clientIp, { gstin: '29ABCDE1234F1Z5' });
  const dismissed = await subscribe(tenant, clientIp, G.code);
  const second = await subscribe(tenant, clientIp, G.code);
  await activate(second);
  const changed = await changePlan(tenant, clientIp, P.code);
  const calls = await mockCallsFor(tenant.userId);
  const customers = calls.filter((c) => c.method === 'POST' && c.path === '/v1/customers');
  expect(customers.map((c) => c.body)).toEqual([
    { name: 'Bela Buyer Labs', email: tenant.email, gstin: '29ABCDE1234F1Z5', fail_existing: '0', notes: { account_ref: tenant.userId } },
  ]);
  const customerId = (await billingAccountRow(tenant.userId)).provider_customer_id;
  expect(customerId).toMatch(/^cust_/);
  expect([dismissed.customerId, second.customerId, changed.customerId]).toEqual([customerId, customerId, customerId]);
  const subscriptions = calls.filter((c) => c.method === 'POST' && c.path === '/v1/subscriptions');
  expect(subscriptions).toHaveLength(3);
  for (const call of subscriptions) expect(call.body.notes).toStrictEqual({ account_ref: tenant.userId });

  // With no GSTIN saved, none is sent.
  const ip2 = newClientIp();
  const plain = await createAccount(ip2, 'bill-215-b', 'Dev Customer');
  await saveDetails(plain, ip2);
  await subscribe(plain, ip2, G.code);
  const plainCustomers = (await mockCallsFor(plain.userId)).filter((c) => c.method === 'POST' && c.path === '/v1/customers');
  expect(plainCustomers).toHaveLength(1);
  expect(plainCustomers[0].body).not.toHaveProperty('gstin');
});

// ------------------------------------------------------------------ N5. taxed amounts and invoices

test('BILL-220 a taxed subscription shows the tax-inclusive next charge', async ({ page, clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, clientIp, { label: 'Taxed sub', sortOrder: 37, mauLimit: 5_000, projectLimit: 5, seatLimit: 5 });
  // A taxed price as staff would add one on an install charging 18%. One taxed price on
  // offer switches every account's page to GST copy, so the row is not current (no other
  // page lists it), and only this page is given the plan, in the API's own shape.
  const razorpayPlanId = `plan_${randomBytes(7).toString('hex')}`;
  const [price] = await query<{ id: string }>(
    `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, currency, razorpay_plan_id, is_current)
     VALUES ($1, 'monthly', 99900, 1800, 117882, 'INR', $2, false) RETURNING id`,
    [plan.code, razorpayPlanId],
  );
  const tenant = await createAccount(clientIp, 'bill-220', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const seeded = await seedUnknownSubscription(
    tenant.userId,
    { ...plan, prices: { monthly: { id: price.id, razorpayPlanId, paise: 99_900 } } },
    { current: true },
  );
  try {
    const o = await overview(tenant, clientIp);
    expect(o.current).toMatchObject({ planCode: plan.code, amountPaise: 117_882 });
    const end = o.current!.currentPeriodEnd!;
    const option = {
      code: plan.code,
      name: plan.name,
      sortOrder: 37,
      mauLimit: 5_000,
      projectLimit: 5,
      seatLimit: 5,
      monthly: { id: price.id, interval: 'monthly', pricePaise: 99_900, taxPaise: 17_982, amountPaise: 117_882, taxRateBps: 1800 },
      yearly: null,
    };
    let realKeys: string[] | undefined;
    await page.route(
      (url) => url.pathname === '/api/billing',
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: { plans: Array<Record<string, unknown>> } };
        realKeys = Object.keys(body.data.plans.find((p) => p.code === G.code) ?? {}).sort();
        body.data.plans.push(option);
        await route.fulfill({ response, json: body });
      },
    );
    await signIn(page, tenant);
    await openBilling(page);
    expect(realKeys).toStrictEqual(Object.keys(option).sort());
    await expect(stateCard(page).locator('[data-slot="card-description"]')).toHaveText(`Next charge ₹1,178.82 on ${longDate(end)}.`);
    const card = planCard(page, plan.name);
    await expect(card.getByText('₹999.00 + GST (₹179.82) a month', { exact: true })).toBeVisible();
    await expect(card.getByText('₹1,178.82 charged including GST', { exact: true })).toBeVisible();
    await expect(card.locator('[data-slot="badge"]')).toHaveText('Current plan');

    await openTenant(tenant);
    await expect(fact(tenantBillingCard(staffPage), 'Next charge')).toHaveText(`${gbDate(end)}₹1,178.82`);
  } finally {
    // Out of the recurring revenue again, so the summary stays untaxed for other cases.
    await query(`UPDATE billing_accounts SET current_subscription_id = NULL WHERE user_id = $1`, [tenant.userId]);
    await query(`UPDATE billing_subscriptions SET status = 'cancelled', ended_at = now() WHERE id = $1`, [seeded.id]);
  }
});

test('BILL-221 the invoice.expired webhook', async ({ page, clientIp }) => {
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-221', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const ids = { subscriptionId: active.checkout.subscriptionId, customerId: active.checkout.customerId!, amount: 49_900 };
  const invoiceRow = async (providerId: string) =>
    (await query<{ status: string; paid_at: Date | null }>(`SELECT status, paid_at FROM billing_invoices WHERE provider_invoice_id = $1`, [providerId]))[0];

  const expired = await sendInvoiceEvent('invoice.expired', { ...ids, number: 'INV-EXP-1' });
  expect(expired.body).toStrictEqual(RECEIVED);
  expect((await billingEvent(expired.eventId))?.outcome).toBe('applied');
  expect(await invoiceRow(expired.invoiceId)).toMatchObject({ status: 'expired', paid_at: null });

  const paid = await sendInvoiceEvent('invoice.paid', { ...ids, number: 'INV-PAID-1', shortUrl: 'https://rzp.io/i/paid1' });
  expect(paid.body).toStrictEqual(RECEIVED);
  const paidRow = await invoiceRow(paid.invoiceId);
  expect(paidRow.status).toBe('paid');
  expect(paidRow.paid_at).not.toBeNull();
  const late = await sendInvoiceEvent('invoice.expired', { ...ids, number: 'INV-PAID-1', invoiceId: paid.invoiceId, createdAt: nowSeconds() + 5 });
  expect(late.body).toStrictEqual(RECEIVED);
  expect((await billingEvent(late.eventId))?.outcome).toBe('applied');
  expect(await invoiceRow(paid.invoiceId)).toStrictEqual({ status: 'paid', paid_at: paidRow.paid_at });

  await signIn(page, tenant);
  await openBilling(page);
  const invoices = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').getByText('Invoices', { exact: true }) });
  const expiredBadge = invoices.getByRole('row').filter({ hasText: 'INV-EXP-1' }).locator('[data-slot="badge"]');
  await expect(expiredBadge).toHaveText('expired');
  await expect(expiredBadge).toHaveAttribute('data-variant', 'outline');
  const paidBadge = invoices.getByRole('row').filter({ hasText: 'INV-PAID-1' }).locator('[data-slot="badge"]');
  await expect(paidBadge).toHaveText('paid');
  await expect(paidBadge).toHaveAttribute('data-variant', 'secondary');

  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await expect(card.getByRole('row').filter({ hasText: 'INV-EXP-1' }).locator('[data-slot="badge"]')).toHaveText('expired');
  await expect(card.getByRole('row').filter({ hasText: 'INV-PAID-1' }).locator('[data-slot="badge"]')).toHaveText('paid');
});

// ------------------------------------------------------------------ N6. webhook edge cases

test('BILL-224 webhook transport refusals and the event id boundary', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-224', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const entity = await mockSubscription(active.checkout.subscriptionId);
  const eventBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_e2eMockOnly01',
      event: 'subscription.charged',
      contains: ['subscription'],
      payload: { subscription: { entity } },
      created_at: nowSeconds() + 5,
      ...extra,
    });
  const signed = (body: string) => createHmac('sha256', runSecrets().razorpayWebhookSecret).update(body).digest('hex');
  const post = (body: string, contentType: string, eventId: string) =>
    fetch(apiUrl('/api/billing/webhooks/razorpay'), {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-Razorpay-Signature': signed(body), 'x-razorpay-event-id': eventId, 'X-Forwarded-For': clientIp },
      body,
    });

  // 1. A correctly signed body sent as text: no raw bytes to check.
  const asText = eventBody({ e2e: randomBytes(4).toString('hex') });
  const text = await post(asText, 'text/plain', `evt_e2e${randomBytes(6).toString('hex')}`);
  expect(text.status).toBe(400);
  expect(await text.json()).toStrictEqual({ data: { received: false } });
  expect(await billingEventsWithBody(asText)).toEqual([]);

  // 3. An event id of exactly 64 characters is taken.
  const id64 = `evt_e2e_${randomBytes(28).toString('hex')}`;
  expect(id64).toHaveLength(64);
  const reply = await postWebhook(asText, { eventId: id64, ip: clientIp });
  expect(reply.status).toBe(200);
  expect(reply.body).toStrictEqual(RECEIVED);
  expect(await billingEvent(id64)).toMatchObject({ provider_event_id: id64, outcome: 'applied', type: 'subscription.charged' });
  expect(await billingEventsWithBody(asText)).toHaveLength(1);
});

test('BILL-224 a signed webhook body over 100 kb is refused as too large', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'BILL-224' });
  test.fail();
  const tenant = await createAccount(clientIp, 'bill-224b', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const entity = await mockSubscription(active.checkout.subscriptionId);
  // Padding in a field nothing reads, past the JSON parser's 100 kb.
  const big = JSON.stringify({
    entity: 'event',
    account_id: 'acc_e2eMockOnly01',
    event: 'subscription.charged',
    contains: ['subscription'],
    payload: { subscription: { entity } },
    created_at: nowSeconds() + 5,
    padding: 'x'.repeat(110_000),
  });
  const tooBig = await fetch(apiUrl('/api/billing/webhooks/razorpay'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': createHmac('sha256', runSecrets().razorpayWebhookSecret).update(big).digest('hex'),
      'x-razorpay-event-id': `evt_e2e${randomBytes(6).toString('hex')}`,
      'X-Forwarded-For': clientIp,
    },
    body: big,
  });
  expect(await billingEventsWithBody(big)).toEqual([]);
  expect(tooBig.status).toBe(413);
});

test('BILL-225 an abandoned Checkout ended by a webhook', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-225', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const opened = await subscribe(tenant, clientIp, G.code);
  expect(await overview(tenant, clientIp)).toMatchObject({ state: 'checkout', next: { id: expect.any(String), status: 'created' } });
  const ended = await sendEvent('subscription.cancelled', opened.subscriptionId, { status: 'cancelled', ended_at: nowSeconds() });
  expect(ended.body).toStrictEqual(RECEIVED);
  expect((await billingEvent(ended.eventId))?.outcome).toBe('applied');
  expect((await billingAccountRow(tenant.userId)).next_subscription_id).toBeNull();
  expect(await overview(tenant, clientIp)).toMatchObject({ state: 'free', next: null });
  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('No paid plan');
  await expect(button(page, G, 'Choose')).toBeVisible();

  // A change's abandoned Checkout: the change goes, the plan stays.
  const ip2 = newClientIp();
  const other = await createAccount(ip2, 'bill-225-b', 'Dev Customer');
  await activeOn(other, ip2, G);
  const change = await changePlan(other, ip2, P.code);
  expect((await overview(other, ip2)).next?.status).toBe('created');
  const dropped = await sendEvent('subscription.cancelled', change.subscriptionId, { status: 'cancelled', ended_at: nowSeconds() });
  expect(dropped.body).toStrictEqual(RECEIVED);
  expect((await billingAccountRow(other.userId)).next_subscription_id).toBeNull();
  expect(await overview(other, ip2)).toMatchObject({ state: 'active', next: null, effectivePlan: { code: G.code } });
});

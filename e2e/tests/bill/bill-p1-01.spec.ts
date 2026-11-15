import type { BrowserContext, Page, Request } from '@playwright/test';
import { randomBytes } from 'crypto';
import { createAccount, createProject, newClientIp, type Account } from '../../support/api';
import { adminUrl, enrolAndSignInStaff, grantSuperAdmin } from '../../support/admin';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activeOn,
  authenticate,
  billingAccountRow,
  cancelCalls,
  cancelPlan,
  changePlan,
  chooseState,
  compTenant,
  createPlan,
  deactivatePlan,
  DEFAULT_DETAILS,
  detailsAlert,
  detailsForm,
  exchangeHandoff,
  joinProject,
  longDate,
  mockCalls,
  mockCallsFor,
  mockSubscription,
  openBilling,
  overview,
  planCard,
  plansSection,
  postWebhook,
  query,
  rawApi,
  rollupCoverage,
  routeApiTo,
  saveDetails,
  seedMau,
  seedRollupThroughYesterday,
  startBillingOffApiOnFreePort,
  staffPasskeyToken,
  stateCard,
  stubCheckout,
  subscribe,
  subscriptionRow,
  suspendTenant,
  usageBar,
  utcDay,
  viewAsHandoff,
  type BillingOffApi,
  type Plan,
} from '../../support/areas/bill';

/**
 * The customer billing page beyond the P0 cases: how it is reached, the plan and usage
 * card in more states (cancelling, waiting for payment, comps, active devices against
 * the plan's limit), the plan cards and the interval toggle, and the billing details
 * form with the API's own refusals. States are reached through the real flow (subscribe,
 * then the signed webhooks) against the local Razorpay mock; usage counts and aged rows
 * are written with SQL.
 */

test.use({ timezoneId: 'UTC' });

let staffContext: BrowserContext;
let staffPage: Page;
let staffIp: string;
let staffToken = '';
let staffTokenAt = 0;
let G: Plan; // monthly 499.00, 10,000 MAU, 20 projects, 10 seats, sort 10
let P: Plan; // monthly 1,499.00 and yearly 14,990.00, 50,000 MAU, standard projects, unlimited seats, sort 20
let L: Plan; // monthly 199.00, 1,000 MAU, 2 projects, 2 seats, sort 5
let inactive: Plan; // a price, but no longer sold
let noPrice: Plan; // sold, but no price yet
let T: Plan; // sold, no current price; a taxed price row kept aside for BILL-037

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
  const staff = await createAccount(staffIp, 'bill-p1-staff', 'Bina Staff');
  await grantSuperAdmin(staff.email);
  staffContext = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': staffIp } });
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
  inactive = await createPlan(staffToken, staffIp, { label: 'Gone', sortOrder: 7, mauLimit: 100, projectLimit: 2, seatLimit: 2, monthly: 29_900 });
  await deactivatePlan(staffToken, staffIp, inactive.code);
  noPrice = await createPlan(staffToken, staffIp, { label: 'Unpriced', sortOrder: 8, mauLimit: 100, projectLimit: 2, seatLimit: 2 });
  T = await createPlan(staffToken, staffIp, { label: 'Taxed', sortOrder: 15, mauLimit: 5_000, projectLimit: 5, seatLimit: 5 });
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

/** A response (or request) to one API path, exactly, and optionally one method. */
const isPath =
  (pathname: string, method?: string) =>
  (r: { url(): string; method?: () => string; request?: () => Request }): boolean => {
    const m = r.method ? r.method() : r.request!().method();
    return new URL(r.url()).pathname === pathname && (method === undefined || m === method);
  };

const button = (page: Page, plan: Plan | string, label: string) =>
  planCard(page, typeof plan === 'string' ? plan : plan.name).getByRole('button', { name: label, exact: true });

/** The card titles in the Plans section, in page order. */
async function planTitles(page: Page): Promise<string[]> {
  return plansSection(page).locator('[data-slot="card"] [data-slot="card-title"]').allInnerTexts();
}

/** The billing details card (its title is not a heading, so it is found by its title slot). */
function detailsCard(page: Page) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]').getByText('Billing details', { exact: true }) });
}

async function fillDetails(
  page: Page,
  fields: Partial<{ legalName: string; gstin: string; line1: string; line2: string; city: string; pin: string; state: string | null }> = {},
): Promise<void> {
  await page.getByLabel('Legal name').fill(fields.legalName ?? DEFAULT_DETAILS.legalName);
  if (fields.gstin !== undefined) await page.getByLabel(/^GSTIN/).fill(fields.gstin);
  await page.getByLabel('Address', { exact: true }).fill(fields.line1 ?? DEFAULT_DETAILS.address.line1);
  if (fields.line2 !== undefined) await page.getByLabel('Address line 2 (optional)').fill(fields.line2);
  await page.getByLabel('City').fill(fields.city ?? DEFAULT_DETAILS.address.city);
  await page.getByLabel('PIN code').fill(fields.pin ?? DEFAULT_DETAILS.address.postalCode);
  if (fields.state !== null) await chooseState(page, fields.state ?? 'Karnataka');
}

const saveButton = (page: Page) => detailsForm(page).getByRole('button', { name: 'Save details' });
const savedToast = (page: Page) => page.getByText('Billing details saved', { exact: true }).first();

// ------------------------------------------------------------------ A. access

test('BILL-001 the Billing menu item opens the billing page from the projects screen', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-001', 'Cara Customer');
  const me = page.waitForResponse((r) => isPath('/api/auth/me')(r) && r.ok());
  await signIn(page, tenant);
  expect(((await (await me).json()) as { data: { billingEnabled: boolean } }).data.billingEnabled).toBe(true);

  const overviewReply = page.waitForResponse((r) => isPath('/api/billing', 'GET')(r));
  const invoicesReply = page.waitForResponse((r) => isPath('/api/billing/invoices', 'GET')(r));
  await page.getByRole('button', { name: tenant.name }).click();
  await page.getByRole('menuitem', { name: 'Billing' }).click();

  await expect(page).toHaveURL(/\/account\/billing$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Billing', exact: true })).toBeVisible();
  await expect(page.getByText('Your plan, usage and invoices, for every project billed to you.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to your projects' })).toHaveAttribute('href', '/projects');
  expect((await overviewReply).status()).toBe(200);
  const invoices = await invoicesReply;
  expect(invoices.status()).toBe(200);
  const search = new URL(invoices.url()).searchParams;
  expect([search.get('page'), search.get('limit')]).toEqual(['1', '10']);
});

test.describe('billing off', () => {
  let off: BillingOffApi;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    off = await startBillingOffApiOnFreePort();
  });

  test.afterAll(async () => {
    await off?.stop();
  });

  test('BILL-007 billing off: neither account menu has a Billing item', async ({ page, clientIp }) => {
    const tenant = await createAccount(clientIp, 'bill-007', 'Cara Customer');
    const project = await createProject(tenant, clientIp, 'Billing off menus');
    // The same account on the install with billing on is offered billing.
    expect((await rawApi('GET', '/api/auth/me', { token: tenant.accessToken, ip: clientIp })).body.data.billingEnabled).toBe(true);

    await routeApiTo(page, off.url);
    const me = page.waitForResponse((r) => isPath('/api/auth/me')(r) && r.ok());
    await signIn(page, tenant);
    expect(((await (await me).json()) as { data: { billingEnabled: boolean } }).data.billingEnabled).toBe(false);

    await page.getByRole('button', { name: tenant.name }).click();
    await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Billing' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto(`/projects/${project.id}`);
    await page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: tenant.email }).click();
    await expect(page.getByRole('menuitem', { name: 'Account Settings' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Billing' })).toHaveCount(0);
  });
});

test('BILL-009 billing on: anonymous calls are 401, and an unsigned webhook is 400', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-009', 'Cara Customer');
  expect((await rawApi('GET', '/api/billing', { token: tenant.accessToken, ip: clientIp })).status).toBe(200);

  const anonymous = await rawApi('GET', '/api/billing', { ip: clientIp });
  expect(anonymous.status).toBe(401);

  const webhook = await postWebhook('{}', { signature: null, ip: clientIp });
  expect(webhook.status).toBe(400);
  expect(webhook.body).toStrictEqual({ data: { received: false } });
});

test('BILL-012 /auth/me reports billingEnabled for the install, and false in view-as', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-012', 'Cara Customer');
  const own = await rawApi('GET', '/api/auth/me', { token: tenant.accessToken, ip: clientIp });
  expect(own.status).toBe(200);
  expect(own.body.data.billingEnabled).toBe(true);

  const url = await viewAsHandoff(await freshStaff(), staffIp, tenant.userId);
  const viewAs = await exchangeHandoff(url, clientIp);
  const seen = await rawApi('GET', '/api/auth/me', { token: viewAs, ip: clientIp });
  expect(seen.status).toBe(200);
  expect(seen.body.data.email).toBe(tenant.email);
  expect(seen.body.data.billingEnabled).toBe(false);
});

test('BILL-013 a suspended account cannot reach billing, and its subscription is left running', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-013', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  expect((await rawApi('GET', '/api/billing', { token: tenant.accessToken, ip: clientIp })).status).toBe(200);

  await suspendTenant(await freshStaff(), staffIp, tenant.userId);

  const read = await rawApi('GET', '/api/billing', { token: tenant.accessToken, ip: clientIp });
  expect(read.status).toBe(403);
  expect(read.body.message).toBe('Account suspended');
  const cancel = await rawApi('POST', '/api/billing/cancel', { token: tenant.accessToken, ip: clientIp });
  expect(cancel.status).toBe(403);
  expect(cancel.body.message).toBe('Account suspended');

  expect(await cancelCalls(active.checkout.subscriptionId)).toEqual([]);
  expect((await mockSubscription(active.checkout.subscriptionId)).status).toBe('active');
  const row = await subscriptionRow(active.checkout.subscriptionId);
  expect(row.status).toBe('active');
  expect(row.cancel_at_period_end).toBe(false);
  expect(row.cancel_requested_at).toBeNull();
});

// ------------------------------------------------------------------ B. the plan, state and usage card

test('BILL-016 a new account: Free, "No paid plan", no schedule line', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-016', 'Cara Customer');
  const o = await overview(tenant, clientIp);
  expect(o).toMatchObject({
    state: 'free',
    effectivePlan: { code: 'free', name: 'Free', source: 'free', until: null },
    current: null,
    next: null,
    comp: null,
    details: null,
    keyId: 'rzp_test_E2eMockOnly000',
  });
  expect(o.usage.projects).toEqual({ used: 0, limit: 10 });
  expect(o.usage.seats).toEqual({ used: 1, limit: null });

  const pageOverview = page.waitForResponse((r) => isPath('/api/billing', 'GET')(r) && r.ok());
  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText('Free');
  const badge = card.locator('[data-slot="badge"]');
  await expect(badge).toHaveText('No paid plan');
  await expect(badge).toHaveAttribute('data-variant', 'secondary');
  await expect(card.locator('[data-slot="card-description"]')).toHaveCount(0);
  await expect(card.getByText('Projects: 0 of 10', { exact: true })).toBeVisible();
  await expect(card.getByText('Team members: 1 of Unlimited', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel plan' })).toHaveCount(0);

  // Active devices: "not counted yet" until the usage roll-up has counted a day. The
  // roll-up's state is shared by the whole stack (the worker's hourly tick), so the
  // line is checked against the state the page was given.
  const mau = ((await (await pageOverview).json()) as { data: typeof o }).data.usage.mau;
  const coverage = await rollupCoverage();
  const line = card.locator('p').filter({ hasText: /active devices this month/i });
  if (!coverage?.countedThrough || coverage.countedThrough < coverage.mauFrom) {
    expect(mau).toEqual({ used: null, limit: null, month: null, countedThrough: null });
    await expect(line).toHaveText('Active devices this month: not counted yet.');
    await expect(card.locator('[role="presentation"]')).toHaveCount(0);
  } else {
    expect(mau).toMatchObject({ used: 0, limit: null, countedThrough: coverage.countedThrough });
    await expect(line).toHaveText(`0 active devices this month (no limit) (counted through ${longDate(`${coverage.countedThrough}T00:00:00Z`)})`);
  }
});

test('BILL-018 cancelling: "Ends at the period end" and the end line', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-018', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await cancelPlan(tenant, clientIp);

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('cancelling');
  expect(o.effectivePlan).toMatchObject({ code: G.code, until: new Date(active.periodEnd * 1000).toISOString() });
  expect(o.current?.cancelAtPeriodEnd).toBe(true);

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(G.name);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Ends at the period end');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    `Ends on ${longDate(active.periodEnd)}. After that your account moves to Free.`,
  );
  await expect(button(page, G, 'Keep my plan')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel plan' })).toHaveCount(0);
});

test('BILL-022 Checkout opened but not paid: "Waiting for payment"', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-022', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await stubCheckout(page, ['dismiss']);
  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('No paid plan');

  const subscribed = page.waitForResponse((r) => isPath('/api/billing/subscribe')(r) && r.ok());
  // Closing Checkout asks the server again.
  const refetched = subscribed.then(() => page.waitForResponse((r) => isPath('/api/billing', 'GET')(r) && r.ok()));
  await button(page, G, 'Choose').click();
  await subscribed;
  await refetched;
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Waiting for payment');
  await expect(card.locator('[data-slot="card-title"]')).toHaveText('Free');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByText('Processing payment...')).toHaveCount(0);

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('checkout');
  expect(o.current).toBeNull();
  expect(o.next?.status).toBe('created');
  expect(o.next?.planCode).toBe(G.code);
});

test('BILL-023 a comped account: the "Complimentary" lines', async ({ page, browser, baseURL, clientIp }) => {
  const until = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
  const dated = await createAccount(clientIp, 'bill-023a', 'Cara Customer');
  const open = await createAccount(clientIp, 'bill-023b', 'Cody Customer');
  await compTenant(await freshStaff(), staffIp, dated.userId, P.code, until);
  await compTenant(await freshStaff(), staffIp, open.userId, P.code);

  const a = await overview(dated, clientIp);
  expect(a).toMatchObject({ state: 'comped', effectivePlan: { code: P.code, source: 'comp' }, comp: { planCode: P.code, until } });
  const b = await overview(open, clientIp);
  expect(b).toMatchObject({ state: 'comped', effectivePlan: { code: P.code, source: 'comp', until: null }, comp: { planCode: P.code, until: null } });

  const check = async (p: Page, account: Account, description: string) => {
    await signIn(p, account);
    await openBilling(p);
    const card = stateCard(p);
    await expect(card.locator('[data-slot="card-title"]')).toHaveText(P.name);
    await expect(card.locator('[data-slot="badge"]')).toHaveText('Complimentary');
    await expect(card.locator('[data-slot="card-description"]')).toHaveText(description);
    await expect(planCard(p, P.name).locator('[data-slot="badge"]')).toHaveText('Current plan');
    await expect(planCard(p, P.name).getByRole('button')).toHaveCount(0);
    await expect(button(p, G, 'Choose')).toBeVisible();
    await p.getByRole('radio', { name: 'Yearly' }).click();
    await expect(planCard(p, P.name).getByText('₹14,990.00 / year', { exact: true })).toBeVisible();
    await expect(planCard(p, P.name).locator('[data-slot="badge"]')).toHaveText('Current plan');
    await expect(planCard(p, P.name).getByRole('button')).toHaveCount(0);
  };
  await check(page, dated, `Complimentary until ${longDate(until)}.`);
  const second = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, timezoneId: 'UTC', extraHTTPHeaders: { 'X-Forwarded-For': clientIp } });
  try {
    await check(await second.newPage(), open, 'Complimentary.');
  } finally {
    await second.close();
  }
});

test('BILL-024 a comp that has ended by date falls back to Free', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-024', 'Cara Customer');
  await compTenant(await freshStaff(), staffIp, tenant.userId, P.code, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
  expect((await overview(tenant, clientIp)).state).toBe('comped');

  await query(`UPDATE billing_accounts SET comp_until = now() - interval '1 minute' WHERE user_id = $1`, [tenant.userId]);
  const [{ until }] = await query<{ until: Date }>(`SELECT comp_until AS until FROM billing_accounts WHERE user_id = $1`, [tenant.userId]);

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('free');
  expect(o.effectivePlan).toMatchObject({ code: 'free', source: 'free' });
  expect(o.comp).toStrictEqual({ planCode: P.code, until: until.toISOString() });
  expect(new Date(o.comp!.until!).getTime()).toBeLessThan(Date.now());
  expect(o.usage.mau.limit).toBeNull();
});

/** An account active on G with one project whose active devices for yesterday are `value`. */
async function mauAccount(ip: string, label: string, value: number) {
  const tenant = await createAccount(ip, label, 'Cara Customer');
  await activeOn(tenant, ip, G);
  const project = await createProject(tenant, ip, `MAU ${value}`);
  const day = await seedRollupThroughYesterday();
  await seedMau(project.id, tenant.userId, day, value);
  return { tenant, day };
}

test('BILL-026 usage: active devices under 80% of the plan\'s limit', async ({ page, clientIp }) => {
  const { tenant, day } = await mauAccount(clientIp, 'bill-026', 1_234);
  expect((await overview(tenant, clientIp)).usage.mau).toStrictEqual({
    used: 1_234,
    limit: 10_000,
    month: `${day.slice(0, 7)}-01`,
    countedThrough: day,
  });

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('p').filter({ hasText: 'active devices this month' })).toHaveText(
    `1,234 of 10,000 active devices this month (counted through ${longDate(`${day}T00:00:00Z`)})`,
  );
  await expect(usageBar(page)).toHaveAttribute('style', /width: 12%/);
  await expect(usageBar(page)).toHaveClass(/\bbg-primary\b/);
  await expect(card.getByText(/Nothing is blocked/)).toHaveCount(0);
});

test('BILL-027 usage: near the limit (80% and over, under 100%)', async ({ page, clientIp }) => {
  const { tenant, day } = await mauAccount(clientIp, 'bill-027', 8_000);
  expect((await overview(tenant, clientIp)).usage.mau.used).toBe(8_000);

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('p').filter({ hasText: 'active devices this month' })).toHaveText(
    `8,000 of 10,000 active devices this month (counted through ${longDate(`${day}T00:00:00Z`)})`,
  );
  await expect(usageBar(page)).toHaveAttribute('style', /width: 80%/);
  await expect(usageBar(page)).toHaveClass(/\bbg-amber-500\b/);
  await expect(card.getByText(/Nothing is blocked/)).toHaveText(
    "You're close to this month's limit. Nothing is blocked and messages keep sending.",
  );
});

test('BILL-028 usage: over the limit', async ({ page, clientIp }) => {
  const { tenant, day } = await mauAccount(clientIp, 'bill-028', 12_500);
  expect((await overview(tenant, clientIp)).usage.mau.used).toBe(12_500);

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('p').filter({ hasText: 'active devices this month' })).toHaveText(
    `12,500 of 10,000 active devices this month (counted through ${longDate(`${day}T00:00:00Z`)})`,
  );
  await expect(usageBar(page)).toHaveAttribute('style', /width: 100%/);
  await expect(usageBar(page)).toHaveClass(/\bbg-destructive\b/);
  await expect(card.getByText(/Nothing is blocked/)).toHaveText(
    "You're over this month's limit. Nothing is blocked and messages keep sending.",
  );
});

test('BILL-030 usage: active devices sum the account\'s own projects, on the last counted day only', async ({ clientIp }) => {
  const c = await createAccount(clientIp, 'bill-030-c', 'Cara Customer');
  const d = await createAccount(clientIp, 'bill-030-d', 'Dev Owner');
  const p1 = await createProject(c, clientIp, 'MAU one');
  const p2 = await createProject(c, clientIp, 'MAU two');
  const p3 = await createProject(d, clientIp, 'Billed to D');
  await joinProject(d, c, p3.id, clientIp);
  const day = await seedRollupThroughYesterday();
  await seedMau(p1.id, c.userId, day, 100);
  await seedMau(p2.id, c.userId, day, 50);
  await seedMau(p3.id, d.userId, day, 999);
  await seedMau(p1.id, c.userId, utcDay(-2), 5_000);

  expect((await overview(c, clientIp)).usage.mau).toMatchObject({ used: 150, countedThrough: day });
  // D's project is counted on D's account.
  expect((await overview(d, clientIp)).usage.mau.used).toBe(999);
});

test('BILL-031 usage: projects and team members count the account\'s own', async ({ page, clientIp }) => {
  const c = await createAccount(clientIp, 'bill-031-c', 'Cara Customer');
  const m1 = await createAccount(clientIp, 'bill-031-m1', 'Mina Member');
  const m2 = await createAccount(clientIp, 'bill-031-m2', 'Milo Member');
  const d = await createAccount(clientIp, 'bill-031-d', 'Dev Owner');
  const a = await createProject(c, clientIp, 'Seats A');
  const b = await createProject(c, clientIp, 'Seats B');
  await joinProject(c, m1, a.id, clientIp);
  await joinProject(c, m1, b.id, clientIp); // the same person in two projects: one seat
  await joinProject(c, m2, a.id, clientIp);
  const invited = `bill-031-invitee-${randomBytes(4).toString('hex')}@e2e.example.test`;
  const live = await rawApi('POST', `/api/projects/${b.id}/invitations`, { token: c.accessToken, ip: clientIp, body: { email: invited, role: 'member' } });
  expect(live.status).toBe(201);
  const theirs = await createProject(d, clientIp, 'Billed to D');
  await joinProject(d, c, theirs.id, clientIp);

  const o = await overview(c, clientIp);
  expect(o.usage.projects).toStrictEqual({ used: 2, limit: 10 });
  expect(o.usage.seats).toStrictEqual({ used: 4, limit: null });
  // C is a seat on D's account, not a project or seat of its own.
  expect((await overview(d, clientIp)).usage).toMatchObject({ projects: { used: 1 }, seats: { used: 2 } });

  await signIn(page, c);
  await openBilling(page);
  await expect(stateCard(page).getByText('Projects: 2 of 10', { exact: true })).toBeVisible();
  await expect(stateCard(page).getByText('Team members: 4 of Unlimited', { exact: true })).toBeVisible();
});

// ------------------------------------------------------------------ C. plan cards and the interval toggle

test('BILL-033 the plans list Free first, then active plans with a price, by sort order', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-033', 'Cara Customer');
  const ours = new Set(['free', L.code, G.code, P.code, inactive.code, noPrice.code, T.code]);
  const o = await overview(tenant, clientIp);
  expect(o.plans[0].code).toBe('free');
  expect(o.plans.map((p) => p.code).filter((code) => ours.has(code))).toEqual(['free', L.code, G.code, P.code]);
  const orders = o.plans.slice(1).map((p) => p.sortOrder);
  expect(orders).toEqual([...orders].sort((x, y) => x - y));

  await signIn(page, tenant);
  await openBilling(page);
  const names = new Set(['Free', L.name, G.name, P.name, inactive.name, noPrice.name, T.name]);
  const titles = await planTitles(page);
  expect(titles[0]).toBe('Free');
  expect(titles.filter((t) => names.has(t))).toEqual(['Free', L.name, G.name, P.name]);
  await expect(planCard(page, 'Free').locator('[data-slot="badge"]')).toHaveText('Current plan');
  await expect(planCard(page, 'Free').getByText('₹0.00', { exact: true })).toBeVisible();
  await expect(button(page, L, 'Choose')).toBeVisible();
  await expect(button(page, G, 'Choose')).toBeVisible();
  await expect(planCard(page, inactive.name)).toHaveCount(0);
  await expect(planCard(page, noPrice.name)).toHaveCount(0);
});

test('BILL-036 an untaxed price line', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-036', 'Cara Customer');
  // Saved details, so the form (whose GSTIN field names GST) is closed.
  await saveDetails(tenant, clientIp);
  const g = (await overview(tenant, clientIp)).plans.find((p) => p.code === G.code)!;
  expect(g.monthly).toMatchObject({ pricePaise: 49_900, taxPaise: 0, amountPaise: 49_900, taxRateBps: 0 });

  await signIn(page, tenant);
  await openBilling(page);
  const card = planCard(page, G.name);
  await expect(card.getByText('₹499.00 / month', { exact: true })).toBeVisible();
  await expect(card.getByText(/charged including GST/)).toHaveCount(0);
  await expect(plansSection(page).getByText('Need more than the largest plan? Contact us.', { exact: true })).toBeVisible();
  await expect(detailsCard(page).locator('[data-slot="card-description"]')).toHaveText('Shown on your invoices.');
  await expect(page.getByText(/GST/)).toHaveCount(0);
});

test('BILL-037 a taxed price line and the GST copy', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-037', 'Cara Customer');
  // A taxed price row as staff would add one on an install charging 18% GST. Plans are
  // shared by every test of the run, and one taxed price switches every account's page
  // to GST copy, so the row is stored as not current (no other page lists it), and only
  // this page is given it, in the API's own shape for a current price.
  const razorpayPlanId = `plan_${randomBytes(7).toString('hex')}`;
  // The database holds the amount to the price plus its tax: 99,900 + 18% is 1,17,882.
  await expect(
    query(
      `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, currency, razorpay_plan_id, is_current)
       VALUES ($1, 'monthly', 99900, 1800, 117881, 'INR', $2, false)`,
      [T.code, razorpayPlanId],
    ),
  ).rejects.toThrow(/check constraint/);
  const [row] = await query<{ id: string; price_paise: number; tax_rate_bps: number; amount_paise: number }>(
    `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, currency, razorpay_plan_id, is_current)
     VALUES ($1, 'monthly', 99900, 1800, 117882, 'INR', $2, false)
     RETURNING id, price_paise, tax_rate_bps, amount_paise`,
    [T.code, razorpayPlanId],
  );
  const taxed = {
    code: T.code,
    name: T.name,
    sortOrder: 15,
    mauLimit: 5_000,
    projectLimit: 5,
    seatLimit: 5,
    monthly: {
      id: row.id,
      interval: 'monthly',
      pricePaise: row.price_paise,
      taxPaise: row.amount_paise - row.price_paise,
      amountPaise: row.amount_paise,
      taxRateBps: row.tax_rate_bps,
    },
    yearly: null,
  };
  await page.route(
    (url) => url.pathname === '/api/billing',
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data: { plans: unknown[] } };
      body.data.plans.push(taxed);
      await route.fulfill({ response, json: body });
    },
  );

  await signIn(page, tenant);
  await openBilling(page);
  const card = planCard(page, T.name);
  await expect(card.getByText('₹999.00 + GST (₹179.82) a month', { exact: true })).toBeVisible();
  await expect(card.getByText('₹1,178.82 charged including GST', { exact: true })).toBeVisible();
  // An untaxed price beside it keeps its plain line.
  await expect(planCard(page, G.name).getByText('₹499.00 / month', { exact: true })).toBeVisible();
  await expect(planCard(page, G.name).getByText(/charged including GST/)).toHaveCount(0);
  await expect(
    plansSection(page).getByText('Prices exclude GST, which is added at checkout. Need more than the largest plan? Contact us.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(detailsCard(page).locator('[data-slot="card-description"]')).toHaveText('Printed on your GST invoices.');
});

test('BILL-038 the interval toggle: default, switching, and "Not available for this period yet"', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-038', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);
  const group = page.getByRole('radiogroup', { name: 'Billing period' });
  const monthly = group.getByRole('radio', { name: 'Monthly' });
  const yearly = group.getByRole('radio', { name: 'Yearly' });
  await expect(monthly).toHaveAttribute('aria-checked', 'true');
  await expect(yearly).toHaveAttribute('aria-checked', 'false');
  await expect(planCard(page, P.name).getByText('₹1,499.00 / month', { exact: true })).toBeVisible();

  await yearly.click();
  await expect(yearly).toHaveAttribute('aria-checked', 'true');
  await expect(monthly).toHaveAttribute('aria-checked', 'false');
  await expect(planCard(page, P.name).getByText('₹14,990.00 / year', { exact: true })).toBeVisible();
  await expect(button(page, P, 'Choose')).toBeVisible();
  const g = planCard(page, G.name);
  await expect(g.getByText('Not available for this period yet', { exact: true })).toBeVisible();
  await expect(g.locator('[data-slot="badge"]')).toHaveText('Coming soon');
  await expect(g.getByRole('button')).toHaveCount(0);
  await expect(planCard(page, 'Free').getByText('₹0.00', { exact: true })).toBeVisible();
  await expect(planCard(page, 'Free').locator('[data-slot="badge"]')).toHaveText('Current plan');

  await monthly.click();
  await expect(monthly).toHaveAttribute('aria-checked', 'true');
  await expect(planCard(page, P.name).getByText('₹1,499.00 / month', { exact: true })).toBeVisible();
  await expect(g.getByText('₹499.00 / month', { exact: true })).toBeVisible();
  await expect(button(page, G, 'Choose')).toBeVisible();
});

test('BILL-040 card actions while active', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-040', 'Cara Customer');
  await activeOn(tenant, clientIp, G);
  await signIn(page, tenant);
  await openBilling(page);

  const free = planCard(page, 'Free');
  await expect(free.getByText('₹0.00', { exact: true })).toBeVisible();
  await expect(free.getByRole('button')).toHaveCount(0);
  await expect(free.locator('[data-slot="badge"]')).toHaveCount(0);
  const g = planCard(page, G.name);
  await expect(g.locator('[data-slot="badge"]')).toHaveText('Current plan');
  await expect(g).toHaveClass(/\bborder-primary\b/);
  await expect(g.getByRole('button')).toHaveCount(0);
  for (const plan of [L, P]) {
    await expect(planCard(page, plan.name).getByRole('button')).toHaveCount(1);
    await expect(button(page, plan, 'Switch')).toHaveAttribute('data-variant', 'outline');
    await expect(planCard(page, plan.name)).not.toHaveClass(/\bborder-primary\b/);
  }
});

test('BILL-041 card actions while a change is scheduled', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-041', 'Cara Customer');
  await activeOn(tenant, clientIp, G);
  await authenticate(await changePlan(tenant, clientIp, P.code));
  expect((await overview(tenant, clientIp)).state).toBe('upgrade_pending');

  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Upgrade starts at next charge');
  await expect(planCard(page, G.name).locator('[data-slot="badge"]')).toHaveText('Current plan');
  await expect(planCard(page, L.name)).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Switch|Choose|Keep my plan)$/ })).toHaveCount(0);
  // What is still offered: dropping the change with the plan.
  await expect(page.getByRole('button', { name: 'Cancel plan' })).toBeVisible();
});

// ------------------------------------------------------------------ D. billing details

test('BILL-044 the form is shown when there are no details yet (untaxed copy)', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-044', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);
  const card = detailsCard(page);
  await expect(card.locator('[data-slot="card-description"]')).toHaveText('Shown on your invoices.');
  const form = detailsForm(page);
  await expect(form.getByLabel('Legal name')).toHaveValue('');
  await expect(form.getByText('As it should appear on your invoices.', { exact: true })).toBeVisible();
  await expect(form.getByLabel('GSTIN (optional, for your records)', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Address', { exact: true })).toHaveValue('');
  const line2 = form.getByLabel('Address line 2 (optional)');
  await expect(line2).toHaveValue('');
  await expect(line2).toHaveAttribute('placeholder', 'Line 2 (optional)');
  await expect(form.getByLabel('City')).toHaveValue('');
  await expect(form.getByLabel('PIN code')).toHaveValue('');
  const state = form.getByRole('combobox', { name: 'Your state' });
  await expect(state).toHaveText('Choose your state');
  await expect(form.getByText('Billing is in India only for now.', { exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Save details' })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

test('BILL-046 saving details: the happy path', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-046', 'Cara Customer');
  // Held for a moment, so the busy label can be seen.
  await page.route(
    (url) => url.pathname === '/api/billing/details',
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    },
  );
  await signIn(page, tenant);
  await openBilling(page);
  await fillDetails(page);

  const request = page.waitForRequest((r) => isPath('/api/billing/details', 'PUT')(r));
  const reply = page.waitForResponse((r) => isPath('/api/billing/details', 'PUT')(r));
  await saveButton(page).click();
  await expect(detailsForm(page).getByRole('button', { name: 'Saving...' })).toBeDisabled();
  expect((await request).postDataJSON()).toStrictEqual({
    legalName: 'Bela Buyer Labs',
    address: { line1: '1 Test Street', city: 'Bengaluru', postalCode: '560001', country: 'IN' },
    stateCode: '29',
  });
  const answered = await reply;
  expect(answered.status()).toBe(200);
  expect(((await answered.json()) as { data: unknown }).data).toStrictEqual({
    legalName: 'Bela Buyer Labs',
    gstin: null,
    address: { line1: '1 Test Street', line2: null, city: 'Bengaluru', postalCode: '560001', country: 'IN' },
    stateCode: '29',
    gstinLocked: false,
  });

  await expect(savedToast(page)).toBeVisible();
  const card = detailsCard(page);
  await expect(card.getByText('Bela Buyer Labs', { exact: true })).toBeVisible();
  await expect(card.getByText('1 Test Street, Bengaluru, 560001', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(card.getByText(/^GSTIN/)).toHaveCount(0);

  const row = await billingAccountRow(tenant.userId);
  expect(row).toMatchObject({
    legal_name: 'Bela Buyer Labs',
    gstin: null,
    address: { line1: '1 Test Street', line2: null, city: 'Bengaluru', postalCode: '560001', country: 'IN' },
    state_code: '29',
    provider_customer_id: null,
  });
  expect(await mockCallsFor(tenant.userId)).toEqual([]);
});

test('BILL-047 saving details with a GSTIN and a second address line', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-047', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);
  await fillDetails(page, { line2: 'Floor 2' });
  const gstin = page.getByLabel(/^GSTIN/);
  await expect(gstin).toHaveAttribute('maxlength', '15');
  await gstin.pressSequentially('29abcde1234f1z5');
  await expect(gstin).toHaveValue('29ABCDE1234F1Z5');

  const request = page.waitForRequest((r) => isPath('/api/billing/details', 'PUT')(r));
  await saveButton(page).click();
  expect((await request).postDataJSON()).toMatchObject({ gstin: '29ABCDE1234F1Z5', address: { line2: 'Floor 2' } });
  await expect(savedToast(page)).toBeVisible();
  const card = detailsCard(page);
  const gstinLine = card.getByText('GSTIN 29ABCDE1234F1Z5', { exact: true });
  await expect(gstinLine).toBeVisible();
  await expect(gstinLine).toHaveClass(/\bfont-mono\b/);
  await expect(card.getByText('1 Test Street, Floor 2, Bengaluru, 560001', { exact: true })).toBeVisible();
  expect((await overview(tenant, clientIp)).details).toMatchObject({ gstin: '29ABCDE1234F1Z5', address: { line2: 'Floor 2' } });
});

test('BILL-048 no state chosen', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-048', 'Cara Customer');
  const puts = watch(page, '/api/billing/details', 'PUT');
  await signIn(page, tenant);
  await openBilling(page);
  await fillDetails(page, { state: null });
  await saveButton(page).click();
  await expect(detailsAlert(page)).toHaveText('Choose your state.');
  expect(puts).toHaveLength(0);

  // With a state, the same form is sent.
  await chooseState(page, 'Karnataka');
  await saveButton(page).click();
  await expect(savedToast(page)).toBeVisible();
  expect(puts).toHaveLength(1);
});

test('BILL-049 a legal name too short or empty', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-049', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);
  for (const legalName of ['A', '']) {
    await fillDetails(page, { legalName });
    const reply = page.waitForResponse((r) => isPath('/api/billing/details', 'PUT')(r));
    await saveButton(page).click();
    expect((await reply).status()).toBe(400);
    await expect(detailsAlert(page)).toHaveText('legalName must be longer than or equal to 2 characters');
  }
  expect((await overview(tenant, clientIp)).details).toBeNull();
});

test('BILL-052 address line 1 and city are required', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-052', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);

  await fillDetails(page, { line1: '' });
  await saveButton(page).click();
  await expect(detailsAlert(page)).toHaveText('address.line1 must be longer than or equal to 1 characters');

  // Whitespace alone is trimmed first, and fails the same way.
  await fillDetails(page, { city: '   ' });
  await saveButton(page).click();
  await expect(detailsAlert(page)).toHaveText('address.city must be longer than or equal to 1 characters');
  expect((await overview(tenant, clientIp)).details).toBeNull();
});

test('BILL-053 PIN code rules', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-053', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);
  for (const pin of ['012345', '56001', '56000A']) {
    await fillDetails(page, { pin });
    const reply = page.waitForResponse((r) => isPath('/api/billing/details', 'PUT')(r));
    await saveButton(page).click();
    expect((await reply).status(), pin).toBe(400);
    await expect(detailsAlert(page)).toHaveText('address.postalCode must be a six-digit PIN code');
  }
  expect((await overview(tenant, clientIp)).details).toBeNull();

  // The field takes six characters: a seventh digit cannot be typed.
  const field = page.getByLabel('PIN code');
  await expect(field).toHaveAttribute('maxlength', '6');
  await field.fill('');
  await field.pressSequentially('5600011');
  await expect(field).toHaveValue('560001');
  // The API refuses seven digits the same way, and trims spaces around six.
  const seven = await rawApi('PUT', '/api/billing/details', {
    token: tenant.accessToken,
    ip: clientIp,
    body: { ...DEFAULT_DETAILS, address: { ...DEFAULT_DETAILS.address, postalCode: '5600011' } },
  });
  expect(seven.status).toBe(400);
  expect(seven.body.message).toEqual(['address.postalCode must be a six-digit PIN code']);
  const spaced = await rawApi('PUT', '/api/billing/details', {
    token: tenant.accessToken,
    ip: clientIp,
    body: { ...DEFAULT_DETAILS, address: { ...DEFAULT_DETAILS.address, postalCode: ' 560001 ' } },
  });
  expect(spaced.status).toBe(200);
  expect(spaced.body.data.address.postalCode).toBe('560001');
  expect((await overview(tenant, clientIp)).details?.address.postalCode).toBe('560001');
});

test('BILL-054 a GSTIN in the wrong format is refused', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-054', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);
  await fillDetails(page, { gstin: '29ABCDE1234F1Y5' });
  await saveButton(page).click();
  await expect(detailsAlert(page)).toHaveText('gstin must be a valid GSTIN');
  expect((await overview(tenant, clientIp)).details).toBeNull();

  // A valid GSTIN in lower case with spaces around it is normalised, not refused.
  const normalised = await rawApi('PUT', '/api/billing/details', {
    token: tenant.accessToken,
    ip: clientIp,
    body: { ...DEFAULT_DETAILS, gstin: ' 29abcde1234f1z5 ' },
  });
  expect(normalised.status).toBe(200);
  expect(normalised.body.data.gstin).toBe('29ABCDE1234F1Z5');
});

test('BILL-055 a GSTIN with no such state code', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-055', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);
  await fillDetails(page, { gstin: '39ABCDE1234F1Z5' });
  await saveButton(page).click();
  await expect(detailsAlert(page)).toHaveText('Enter a valid GSTIN, or leave it empty.');
  expect((await overview(tenant, clientIp)).details).toBeNull();
});

test('BILL-058 extra fields are refused, nested ones too', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-058', 'Cara Customer');
  const put = (body: unknown) => rawApi('PUT', '/api/billing/details', { token: tenant.accessToken, ip: clientIp, body });

  const extra = await put({ ...DEFAULT_DETAILS, email: 'billing@e2e.example.test' });
  expect(extra.status).toBe(400);
  expect(extra.body.message).toEqual(['property email should not exist']);

  const nested = await put({ ...DEFAULT_DETAILS, address: { ...DEFAULT_DETAILS.address, zip: '560001' } });
  expect(nested.status).toBe(400);
  expect(nested.body.message).toEqual(['address.property zip should not exist']);

  expect((await overview(tenant, clientIp)).details).toBeNull();
  // The same body without the extras is saved.
  expect((await put(DEFAULT_DETAILS)).status).toBe(200);
});

test('BILL-058 a body with no address is refused', async ({ clientIp }) => {
  test.info().annotations.push({ type: 'issue', description: 'BILL-058' });
  test.fail();
  const tenant = await createAccount(clientIp, 'bill-058b', 'Cara Customer');
  const { address: _address, ...withoutAddress } = DEFAULT_DETAILS;
  const missing = await rawApi('PUT', '/api/billing/details', { token: tenant.accessToken, ip: clientIp, body: withoutAddress });
  expect((await overview(tenant, clientIp)).details).toBeNull();
  expect(missing.status).toBe(400);
  expect(missing.body.message.length).toBeGreaterThan(0);
  for (const message of missing.body.message as string[]) expect(message).toMatch(/\baddress\b/);
});

test('BILL-060 a legal name change before any subscription stays local', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-060', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const renamed = `Bela Buyer Pvt Ltd ${randomBytes(3).toString('hex')}`;
  await signIn(page, tenant);
  await openBilling(page);
  await detailsCard(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Legal name').fill(renamed);
  await saveButton(page).click();
  await expect(savedToast(page)).toBeVisible();
  await expect(detailsCard(page).getByText(renamed, { exact: true })).toBeVisible();

  const o = await overview(tenant, clientIp);
  expect(o.details).toMatchObject({ legalName: renamed, gstinLocked: false });
  expect((await billingAccountRow(tenant.userId)).provider_customer_id).toBeNull();
  const sent = (await mockCalls()).filter((c) => c.method === 'PUT' && c.path.startsWith('/v1/customers/') && c.body?.name === renamed);
  expect(sent).toEqual([]);
  expect(await mockCallsFor(tenant.userId)).toEqual([]);
});

test('BILL-061 after subscribing, a legal name change is sent to Razorpay', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-061', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const checkout = await subscribe(tenant, clientIp, G.code);
  const renamed = `Bela Buyer Pvt Ltd ${randomBytes(3).toString('hex')}`;
  const customerCalls = async () => (await mockCalls()).filter((c) => c.method === 'PUT' && c.path === `/v1/customers/${checkout.customerId}`);
  expect(await customerCalls()).toEqual([]);

  await signIn(page, tenant);
  await openBilling(page);
  await detailsCard(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Legal name').fill(renamed);
  await saveButton(page).click();
  await expect(savedToast(page)).toBeVisible();
  await expect(detailsCard(page).getByText(renamed, { exact: true })).toBeVisible();

  expect((await customerCalls()).map((c) => c.body)).toStrictEqual([{ name: renamed }]);
  const row = await billingAccountRow(tenant.userId);
  expect(row.legal_name).toBe(renamed);
  expect(row.provider_customer_id).toBe(checkout.customerId);
});

test('BILL-065 details are shown as text, not HTML', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-065', 'Cara Customer');
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await signIn(page, tenant);
  await openBilling(page);
  await fillDetails(page, { legalName: '<img src=x onerror=alert(1)>', city: '<b>Pune</b>' });
  await saveButton(page).click();
  await expect(savedToast(page)).toBeVisible();

  const card = detailsCard(page);
  await expect(card.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(card.getByText('1 Test Street, <b>Pune</b>, 560001', { exact: true })).toBeVisible();
  await expect(card.locator('img')).toHaveCount(0);
  await expect(card.locator('b')).toHaveCount(0);
  await page.reload();
  await expect(detailsCard(page).getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
  expect((await overview(tenant, clientIp)).details).toMatchObject({ legalName: '<img src=x onerror=alert(1)>', address: { city: '<b>Pune</b>' } });
});

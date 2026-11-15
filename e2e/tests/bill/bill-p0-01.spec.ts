import type { BrowserContext, Page, Request } from '@playwright/test';
import { api, createAccount, createProject, newClientIp, type Account } from '../../support/api';
import { adminUrl, enrolAndSignInStaff, grantSuperAdmin } from '../../support/admin';
import { tokenFromLink } from '../../support/mailbox';
import { expect, signIn, test } from '../../support/fixtures';
import { runSecrets } from '../../support/stack';
import {
  activate,
  activeOn,
  authenticate,
  cancelCalls,
  cancelPlan,
  changePlan,
  chooseState,
  createPlan,
  DAY_SECONDS,
  deactivatePlan,
  DEFAULT_DETAILS,
  exchangeHandoff,
  fillDetailsForm,
  halt,
  longDate,
  mockCallsFor,
  mockSubscription,
  nowSeconds,
  openBilling,
  overview,
  planCard,
  postSignedWebhook,
  query,
  rawApi,
  recordedCheckouts,
  retirePrice,
  saveDetails,
  sendSubscriptionEvent,
  sha256Hex,
  startBillingOffApi,
  staffPasskeyToken,
  stateCard,
  stubCheckout,
  subscribe,
  subscriptionRow,
  viewAsHandoff,
  waitForCancelCall,
  type BillingOffApi,
  type Plan,
} from '../../support/areas/bill';

/**
 * The customer billing page (/account/billing) and its API: access (billing off,
 * view-as, someone else's project), the plan card in each subscription state, billing
 * details, subscribing through Checkout (a stand-in), cancelling and changing plans.
 * States are reached through the real flow: subscribe, then the signed webhooks
 * Razorpay would send, against the local mock of its API.
 */

test.use({ timezoneId: 'UTC' });

/** Staff, and the plans every case buys from. */
let staffContext: BrowserContext;
let staffPage: Page;
let staffIp: string;
let G: Plan; // monthly 499.00, 10,000 MAU, 20 projects, 10 seats
let P: Plan; // monthly 1,499.00 and yearly 14,990.00, 50,000 MAU, standard projects, unlimited seats
let inactive: Plan;
let retired: Plan;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  staffIp = newClientIp();
  const staff = await createAccount(staffIp, 'bill-staff', 'Bina Staff');
  await grantSuperAdmin(staff.email);
  staffContext = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': staffIp } });
  staffPage = await staffContext.newPage();
  const token = await enrolAndSignInStaff(staffPage, staff);
  G = await createPlan(token, staffIp, { label: 'Growth', sortOrder: 10, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, monthly: 49_900 });
  P = await createPlan(token, staffIp, {
    label: 'Pro',
    sortOrder: 20,
    mauLimit: 50_000,
    projectLimit: null,
    seatLimit: null,
    monthly: 149_900,
    yearly: 1_499_000,
  });
  inactive = await createPlan(token, staffIp, { label: 'Gone', sortOrder: 30, mauLimit: 100, projectLimit: 2, seatLimit: 2, monthly: 29_900 });
  await deactivatePlan(token, staffIp, inactive.code);
  retired = await createPlan(token, staffIp, { label: 'Withdrawn', sortOrder: 40, mauLimit: 100, projectLimit: 2, seatLimit: 2, monthly: 39_900 });
  await retirePrice(token, staffIp, retired.code, retired.prices.monthly!.id);
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

async function projectsMeta(account: Account, ip: string): Promise<{ projectLimit: number }> {
  const reply = await rawApi('GET', '/api/projects', { token: account.accessToken, ip });
  expect(reply.status).toBe(200);
  return reply.body.meta;
}

const choose = (page: Page, plan: Plan, label = 'Choose') =>
  planCard(page, plan.name).getByRole('button', { name: label, exact: true });

// ------------------------------------------------------------------ A. access

test.describe('billing off', () => {
  let off: BillingOffApi;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    off = await startBillingOffApi();
  });

  test.afterAll(async () => {
    await off?.stop();
  });

  test('BILL-006 billing off: the page says "Not found"', async ({ page, clientIp }) => {
    const tenant = await createAccount(clientIp, 'bill-006', 'Cara Customer');
    // Every API call the page makes goes to the install with billing off.
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `${off.url}${url.pathname}${url.search}` });
        await route.fulfill({ response });
      },
    );
    const billingRequests: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/billing')) billingRequests.push(pathname);
    });
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/me' && r.ok());
    await signIn(page, tenant);
    expect(((await (await me).json()) as { data: { billingEnabled: boolean } }).data.billingEnabled).toBe(false);

    await page.goto('/account/billing');
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    await expect(page.getByText('There is no page here.', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to your projects' })).toHaveAttribute('href', '/projects');
    const text = await page.locator('body').innerText();
    for (const word of ['Plans', 'Razorpay', '₹', 'Billing details', 'Invoices']) expect(text).not.toContain(word);
    expect(billingRequests).toEqual([]);
  });

  test('BILL-008 billing off: every customer billing route is a plain 404 before authentication', async ({ clientIp }) => {
    const tenant = await createAccount(clientIp, 'bill-008', 'Cara Customer');
    const routes: Array<[string, string, unknown]> = [
      ['GET', '/api/billing', undefined],
      ['PUT', '/api/billing/details', DEFAULT_DETAILS],
      ['POST', '/api/billing/subscribe', { plan: G.code, interval: 'monthly' }],
      ['POST', '/api/billing/change', { plan: G.code, interval: 'monthly' }],
      ['POST', '/api/billing/cancel', undefined],
      ['GET', '/api/billing/invoices', undefined],
      ['POST', '/api/billing/webhooks/razorpay', { entity: 'event' }],
    ];
    // What any route that does not exist answers on that install.
    const unknown = await rawApi('GET', `/api/no-such-route-${Date.now()}`, { ip: clientIp, base: off.url });
    expect(unknown.status).toBe(404);
    for (const token of [undefined, tenant.accessToken]) {
      for (const [method, path, body] of routes) {
        const reply = await rawApi(method, path, { token, ip: clientIp, body, base: off.url });
        expect(reply.status, `${method} ${path} ${token ? 'with' : 'without'} a token`).toBe(404);
        expect(reply.body).toMatchObject({ statusCode: 404, message: 'Not Found' });
        expect(JSON.stringify([reply.body.message, reply.body.error]).toLowerCase()).not.toContain('billing');
        expect(Object.keys(reply.body).sort()).toEqual(Object.keys(unknown.body).sort());
      }
    }

    // A correctly signed webhook leaves nothing behind while billing is off...
    const offBody = JSON.stringify({ entity: 'event', event: 'subscription.activated', created_at: nowSeconds(), e2e: `off-${Date.now()}` });
    expect((await postSignedWebhook(offBody, off.url)).status).toBe(404);
    // ...where the same kind of body is recorded by the install with billing on.
    const onBody = JSON.stringify({ entity: 'event', event: 'subscription.activated', created_at: nowSeconds(), e2e: `on-${Date.now()}` });
    expect((await postSignedWebhook(onBody)).status).toBe(200);
    const stored = async (body: string) =>
      (await query(`SELECT 1 FROM billing_events WHERE body_sha256 = $1`, [sha256Hex(body)])).length;
    expect(await stored(onBody)).toBe(1);
    expect(await stored(offBody)).toBe(0);
  });
});

test('BILL-010 view-as: the page refuses and shows staff where billing is', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-010', 'Tara Tenant');
  const project = await createProject(tenant, clientIp, 'View-as billing project');
  const url = await viewAsHandoff(await staffPasskeyToken(staffPage, adminUrl('/sign-in')), staffIp, tenant.userId);
  const billingRequests = watch(page, '/api/billing');

  await page.goto(url);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('region', { name: 'Impersonation session' })).toBeVisible();

  // Neither account menu offers Billing.
  await page.getByRole('button', { name: tenant.name }).click();
  await expect(page.getByRole('menuitem', { name: 'Light' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Billing' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto(`/projects/${project.id}`);
  await page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: tenant.email }).click();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Billing' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto('/account/billing');
  await expect(page.getByRole('heading', { name: 'Not available while viewing as a tenant' })).toBeVisible();
  await expect(page.getByText('Billing is shown to staff in the admin app.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plans' })).toHaveCount(0);
  expect(billingRequests).toEqual([]);
});

test('BILL-011 view-as: every customer billing route answers 403, reads included', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-011', 'Tara Tenant');
  // An account with details and a live subscription, so every write would have something to change.
  const active = await activeOn(tenant, clientIp, G);
  const snapshot = async () => ({
    account: await query(`SELECT to_jsonb(b)::text AS row FROM billing_accounts b WHERE user_id = $1`, [tenant.userId]),
    subscriptions: await query(`SELECT to_jsonb(s)::text AS row FROM billing_subscriptions s WHERE user_id = $1 ORDER BY id`, [
      tenant.userId,
    ]),
    calls: await mockCallsFor(tenant.userId),
    cancels: await cancelCalls(active.checkout.subscriptionId),
  });
  const before = await snapshot();
  expect(before.account).toHaveLength(1);
  expect(before.subscriptions).toHaveLength(1);
  const url = await viewAsHandoff(await staffPasskeyToken(staffPage, adminUrl('/sign-in')), staffIp, tenant.userId);
  const token = await exchangeHandoff(url, clientIp);

  const routes: Array<[string, string, unknown]> = [
    ['GET', '/api/billing', undefined],
    ['GET', '/api/billing/invoices', undefined],
    ['PUT', '/api/billing/details', DEFAULT_DETAILS],
    ['POST', '/api/billing/subscribe', { plan: G.code, interval: 'monthly' }],
    ['POST', '/api/billing/change', { plan: G.code, interval: 'monthly' }],
    ['POST', '/api/billing/cancel', undefined],
  ];
  for (const [method, path, body] of routes) {
    const reply = await rawApi(method, path, { token, ip: clientIp, body });
    expect(reply.status, `${method} ${path}`).toBe(403);
    expect(reply.body.message, `${method} ${path}`).toBe('Impersonation sessions are read-only');
  }
  // Nothing changed: the account row, its subscriptions, and no call reached the mock.
  expect(await snapshot()).toEqual(before);
  // The tenant's own session reads the same route (the refusal is the view-as, not the account).
  expect((await rawApi('GET', '/api/billing', { token: tenant.accessToken, ip: clientIp })).status).toBe(200);
});

test('BILL-032 a member of a project billed to someone else sees only their own billing', async ({ page, clientIp }) => {
  const owner = await createAccount(clientIp, 'bill-032-owner', 'Dev Owner');
  const active = await activeOn(owner, clientIp, G, { legalName: 'Dev Owner Private Labs' });
  const project = await createProject(owner, clientIp, 'Billed to the owner');
  const [sub] = await query<{ id: string }>(`SELECT id FROM billing_subscriptions WHERE provider_subscription_id = $1`, [
    active.checkout.subscriptionId,
  ]);
  const invoiceNumber = `E2E-INV-${Date.now()}`;
  await query(
    `INSERT INTO billing_invoices
       (provider_invoice_id, user_id, subscription_id, status, amount_paise, tax_paise, provider_tax_paise, currency,
        period_start, period_end, issued_at, paid_at, number)
     VALUES ($1, $2, $3, 'paid', 49900, 0, 0, 'INR', now(), now() + interval '30 days', now(), now(), $4)`,
    [`inv_e2e${Date.now()}`, owner.userId, sub.id, invoiceNumber],
  );

  const member = await createAccount(clientIp, 'bill-032-member', 'Mina Member');
  const invite = await api<{ inviteUrl: string }>(
    'POST',
    `/api/projects/${project.id}/invitations`,
    { email: member.email, role: 'admin' },
    { token: owner.accessToken, ip: clientIp },
  );
  await api('POST', '/api/invitations/accept', { token: tokenFromLink(invite.inviteUrl) }, { token: member.accessToken, ip: clientIp });

  // The owner's invoice is there for the owner...
  const ownerInvoices = await rawApi('GET', '/api/billing/invoices', { token: owner.accessToken, ip: clientIp });
  expect(ownerInvoices.body.data.map((i: { number: string }) => i.number)).toEqual([invoiceNumber]);
  // ...and nothing of the owner's billing reaches the member.
  const memberInvoices = await rawApi('GET', '/api/billing/invoices', { token: member.accessToken, ip: clientIp });
  expect(memberInvoices.status).toBe(200);
  expect(memberInvoices.body.data).toEqual([]);
  const mine = await overview(member, clientIp);
  expect(mine.state).toBe('free');
  expect(mine.effectivePlan.code).toBe('free');
  expect(mine.current).toBeNull();
  expect(mine.details).toBeNull();
  expect(mine.usage.projects).toEqual({ used: 0, limit: 10 });
  const theirs = await overview(owner, clientIp);
  expect(JSON.stringify(mine)).not.toContain(theirs.current!.id);
  // No billing route takes a project: naming D's project changes nothing, or is refused.
  const pointed = await rawApi('GET', `/api/billing?projectId=${project.id}`, { token: member.accessToken, ip: clientIp });
  expect(pointed.status).toBe(200);
  expect(pointed.body.data).toEqual(mine);
  const pointedInvoices = await rawApi('GET', `/api/billing/invoices?projectId=${project.id}`, {
    token: member.accessToken,
    ip: clientIp,
  });
  expect(pointedInvoices.status).toBe(400);
  expect(pointedInvoices.body.message).toEqual(['property projectId should not exist']);

  await signIn(page, member);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="card-title"]')).toHaveText('Free');
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('No paid plan');
  await expect(page.getByText('Projects: 0 of 10', { exact: true })).toBeVisible();
  await expect(page.getByText('No invoices yet. They appear here after your first payment.', { exact: true })).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('Dev Owner Private Labs');
  expect(text).not.toContain(invoiceNumber);
});

// ------------------------------------------------------------------ B. the plan card

test('BILL-017 active subscription: badge and next charge line', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-017', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('active');
  expect(o.effectivePlan).toMatchObject({ code: G.code, source: 'subscription', until: null });
  expect(o.current).toMatchObject({ status: 'active', amountPaise: 49_900, currentPeriodEnd: new Date(active.periodEnd * 1000).toISOString() });

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(G.name);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Active');
  await expect(card.getByText(`Next charge ₹499.00 on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  const gCard = planCard(page, G.name);
  await expect(gCard.locator('[data-slot="badge"]')).toHaveText('Current plan');
  await expect(gCard.getByRole('button')).toHaveCount(0);
});

test('BILL-019 past due (pending): destructive badge and retry note', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-019', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await sendSubscriptionEvent('subscription.pending', active.checkout.subscriptionId, { status: 'pending' });

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('past_due');
  expect(o.effectivePlan.code).toBe(G.code);

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(G.name);
  const badge = card.locator('[data-slot="badge"]');
  await expect(badge).toHaveText('Payment being retried');
  await expect(badge).toHaveAttribute('data-variant', 'destructive');
  await expect(card.getByText(`Next charge ₹499.00 on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  await expect(
    card.getByText("Your last payment is being retried. Update your payment method from Razorpay's email.", { exact: true }),
  ).toBeVisible();
  await expect(planCard(page, P.name)).toBeVisible();
  await expect(planCard(page, P.name).getByRole('button')).toHaveCount(0);
  await expect(planCard(page, G.name).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel plan' })).toBeVisible();
});

test('BILL-020 halted: "Payment failed" and the grace line', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-020', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const haltedAt = Date.now();
  await halt(active);

  const row = await subscriptionRow(active.checkout.subscriptionId);
  expect(row.status).toBe('halted');
  expect(Math.abs(row.grace_until!.getTime() - (haltedAt + 14 * DAY_SECONDS * 1000))).toBeLessThan(60_000);
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('halted');
  expect(o.effectivePlan.code).toBe(G.code);
  expect(o.current!.graceUntil).toBe(row.grace_until!.toISOString());

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(G.name);
  const badge = card.locator('[data-slot="badge"]');
  await expect(badge).toHaveText('Payment failed');
  await expect(badge).toHaveAttribute('data-variant', 'destructive');
  await expect(
    card.getByText(`Your payment did not go through. Your plan's limits stay until ${longDate(row.grace_until!)}.`, { exact: true }),
  ).toBeVisible();
  await expect(choose(page, G)).toBeVisible();
  await expect(choose(page, P)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel plan' })).toBeVisible();
});

test('BILL-021 halted past its grace: back to Free limits', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-021', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const project = await createProject(tenant, clientIp, 'Kept after the grace');
  await halt(active);
  expect((await overview(tenant, clientIp)).state).toBe('halted');
  await query(`UPDATE billing_subscriptions SET grace_until = now() - interval '1 minute' WHERE provider_subscription_id = $1`, [
    active.checkout.subscriptionId,
  ]);

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('free');
  expect(o.effectivePlan.code).toBe('free');
  expect((await projectsMeta(tenant, clientIp)).projectLimit).toBe(10);
  const projects = await api<Array<{ id: string }>>('GET', '/api/projects', undefined, { token: tenant.accessToken, ip: clientIp });
  expect(projects.map((p) => p.id)).toContain(project.id);

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText('Free');
  await expect(card.locator('[data-slot="badge"]')).toHaveText('No paid plan');
  await expect(card.getByText('Projects: 1 of 10', { exact: true })).toBeVisible();
  await expect(choose(page, G)).toBeVisible();
});

// ------------------------------------------------------------------ D. billing details

test('BILL-056 a GSTIN registered in another state is refused', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-056', 'Cara Customer');
  await signIn(page, tenant);
  await openBilling(page);
  await fillDetailsForm(page, { gstin: '27ABCDE1234F1Z5', state: 'Karnataka' });
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'GSTIN' })).toHaveText(
    'The GSTIN is registered in another state. Check the state or the GSTIN.',
  );
  expect((await overview(tenant, clientIp)).details).toBeNull();

  await chooseState(page, 'Maharashtra');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Billing details saved', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('GSTIN 27ABCDE1234F1Z5', { exact: true })).toBeVisible();
  expect((await overview(tenant, clientIp)).details).toMatchObject({ gstin: '27ABCDE1234F1Z5', stateCode: '27' });
});

test('BILL-062 after subscribing, the GSTIN is locked', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-062', 'Cara Customer');
  await saveDetails(tenant, clientIp, { gstin: '29ABCDE1234F1Z5' });
  await subscribe(tenant, clientIp, G.code);
  expect((await overview(tenant, clientIp)).details!.gstinLocked).toBe(true);

  await signIn(page, tenant);
  await openBilling(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const gstin = page.getByLabel(/^GSTIN/);
  await expect(gstin).toBeDisabled();
  await expect(gstin).toHaveValue('29ABCDE1234F1Z5');
  await expect(gstin).toHaveAttribute('aria-describedby', 'billing-gstin-locked');
  await expect(page.locator('#billing-gstin-locked')).toHaveText(
    "Razorpay keeps the GSTIN you subscribed with, so it can't be changed here. Contact support to change it.",
  );

  const locked = 'Your GSTIN cannot be changed once you have subscribed. Contact support to change it.';
  const other = await rawApi('PUT', '/api/billing/details', {
    token: tenant.accessToken,
    ip: clientIp,
    body: { ...DEFAULT_DETAILS, gstin: '29ABCDE9999F1Z5' },
  });
  expect(other.status).toBe(409);
  expect(other.body.message).toBe(locked);
  const removed = await rawApi('PUT', '/api/billing/details', { token: tenant.accessToken, ip: clientIp, body: DEFAULT_DETAILS });
  expect(removed.status).toBe(409);
  expect(removed.body.message).toBe(locked);
  expect((await overview(tenant, clientIp)).details!.gstin).toBe('29ABCDE1234F1Z5');

  const same = await rawApi('PUT', '/api/billing/details', {
    token: tenant.accessToken,
    ip: clientIp,
    body: { ...DEFAULT_DETAILS, gstin: '29ABCDE1234F1Z5', address: { ...DEFAULT_DETAILS.address, city: 'Mysuru' } },
  });
  expect(same.status).toBe(200);
  expect((await overview(tenant, clientIp)).details).toMatchObject({ gstin: '29ABCDE1234F1Z5', gstinLocked: true, address: { city: 'Mysuru' } });
});

// ------------------------------------------------------------------ E. subscribe through Checkout

test('BILL-067 choosing a plan with no details: the form first, then Checkout', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-067', 'Cara Customer');
  await stubCheckout(page);
  const subscribes = watch(page, '/api/billing/subscribe', 'POST');
  await signIn(page, tenant);
  await openBilling(page);
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save details' }) });
  await expect(form.getByRole('button', { name: 'Cancel' })).toHaveCount(0);

  await choose(page, G).click();
  await expect(form.getByRole('button', { name: 'Cancel' })).toBeVisible();
  expect(subscribes).toHaveLength(0);

  await fillDetailsForm(page);
  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/billing/subscribe');
  await form.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Billing details saved', { exact: true }).first()).toBeVisible();
  expect((await request).postDataJSON()).toStrictEqual({ plan: G.code, interval: 'monthly' });
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();
  expect(await recordedCheckouts(page)).toHaveLength(1);
  expect(subscribes).toHaveLength(1);
});

test('BILL-069 the subscribe response and the Checkout options', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-069', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/billing/subscribe');
  const clickedAt = nowSeconds();
  await choose(page, G).click();
  const response = await answered;
  const responseText = await response.text();
  const checkout = (JSON.parse(responseText) as { data: Record<string, unknown> }).data;
  expect(checkout).toStrictEqual({
    subscriptionId: expect.stringMatching(/^sub_/),
    keyId: 'rzp_test_E2eMockOnly000',
    customerId: expect.stringMatching(/^cust_/),
    prefill: { name: tenant.name, email: tenant.email },
    startsAt: null,
  });
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();

  const [options] = await recordedCheckouts(page);
  expect([...options.keys].sort()).toEqual(['customer_id', 'handler', 'key', 'modal', 'name', 'prefill', 'subscription_id']);
  expect(options.json).toStrictEqual({
    key: 'rzp_test_E2eMockOnly000',
    subscription_id: checkout.subscriptionId,
    customer_id: checkout.customerId,
    name: 'Chumbaq',
    prefill: { name: tenant.name, email: tenant.email },
    modal: {},
  });
  expect(options.handler).toBe('function');
  expect(options.ondismiss).toBe('function');

  const calls = await mockCallsFor(tenant.userId);
  const customer = calls.find((c) => c.method === 'POST' && c.path === '/v1/customers');
  expect(customer?.body).toStrictEqual({
    name: DEFAULT_DETAILS.legalName,
    email: tenant.email,
    fail_existing: '0',
    notes: { account_ref: tenant.userId },
  });
  const created = calls.find((c) => c.method === 'POST' && c.path === '/v1/subscriptions');
  expect(created?.body).toStrictEqual({
    plan_id: G.prices.monthly!.razorpayPlanId,
    total_count: 120,
    quantity: 1,
    customer_notify: true,
    expire_by: expect.any(Number),
    notes: { account_ref: tenant.userId },
  });
  expect(Math.abs((created!.body.expire_by as number) - (clickedAt + DAY_SECONDS))).toBeLessThanOrEqual(60);

  const secret = runSecrets().razorpayKeySecret;
  expect(responseText).not.toContain(secret);
  expect(await page.content()).not.toContain(secret);
});

test('BILL-070 Checkout success alone changes nothing', async ({ page, clientIp }) => {
  test.slow();
  const tenant = await createAccount(clientIp, 'bill-070', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);
  const polls = watch(page, '/api/billing');
  await choose(page, G).click();
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();
  const startedPolling = polls.length;
  await page.waitForTimeout(10_000);
  const pollsIn10s = polls.length - startedPolling;
  expect(pollsIn10s).toBeGreaterThanOrEqual(2);
  expect(pollsIn10s).toBeLessThanOrEqual(4);
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();
  await expect(stateCard(page).locator('[data-slot="card-title"]')).toHaveText('Free');

  await page.reload();
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Waiting for payment');
  await expect(stateCard(page).locator('[data-slot="card-title"]')).toHaveText('Free');
  expect((await overview(tenant, clientIp)).state).toBe('checkout');
  expect((await projectsMeta(tenant, clientIp)).projectLimit).toBe(10);
});

test('BILL-071 the activation webhook confirms the payment', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-071', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/billing/subscribe' && r.ok());
  await choose(page, G).click();
  const checkout = ((await (await answered).json()) as { data: { subscriptionId: string; customerId: string } }).data;
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();

  const active = await activate(checkout as Parameters<typeof activate>[0]);
  await expect(page.getByRole('status').filter({ hasText: 'Payment received. Your plan is updated.' })).toBeVisible({
    timeout: 6_000,
  });
  const card = stateCard(page);
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(G.name);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Active');
  await expect(card.getByText(`Next charge ₹499.00 on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  await expect(planCard(page, G.name).locator('[data-slot="badge"]')).toHaveText('Current plan');
  await expect(card.getByText('Projects: 0 of 20', { exact: true })).toBeVisible();
  await expect(card.getByText('Team members: 1 of 10', { exact: true })).toBeVisible();
  expect((await projectsMeta(tenant, clientIp)).projectLimit).toBe(20);

  // Polling stops once the payment is confirmed.
  const polls = watch(page, '/api/billing');
  await page.waitForTimeout(7_000);
  expect(polls).toHaveLength(0);
});

test('BILL-074 choosing again after a dismissed Checkout replaces the first', async ({ page, clientIp }) => {
  test.setTimeout(200_000);
  const tenant = await createAccount(clientIp, 'bill-074', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await stubCheckout(page, ['dismiss', 'success']);
  await signIn(page, tenant);
  await openBilling(page);
  const subscribed = () =>
    page
      .waitForResponse((r) => new URL(r.url()).pathname === '/api/billing/subscribe' && r.ok())
      .then(async (r) => ((await r.json()) as { data: { subscriptionId: string; customerId: string; keyId: string; prefill: never; startsAt: null } }).data);

  // The first Checkout is closed without paying.
  const first = subscribed();
  await choose(page, G).click();
  const s1 = await first;
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Waiting for payment');
  await expect(page.getByRole('status')).toHaveCount(0);

  // Choosing again makes a second subscription, which pays.
  const second = subscribed();
  await choose(page, P).click();
  const s2 = await second;
  expect(s2.subscriptionId).not.toBe(s1.subscriptionId);
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();
  await activate(s2);
  await expect(page.getByRole('status').filter({ hasText: 'Payment received. Your plan is updated.' })).toBeVisible();
  await expect(stateCard(page).locator('[data-slot="card-title"]')).toHaveText(P.name);

  const row1 = await subscriptionRow(s1.subscriptionId);
  const row2 = await subscriptionRow(s2.subscriptionId);
  expect(row1.superseded_by).toBe(row2.id);
  expect(row1.cancel_requested_at).not.toBeNull();
  expect(row1.cancel_at_cycle_end).toBe(false);
  const o = await overview(tenant, clientIp);
  expect(o.current?.id).toBe(row2.id);
  expect(o.next).toBeNull();

  // The worker's outbox cancels the abandoned one at once.
  expect((await waitForCancelCall(s1.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: false });
  expect(await cancelCalls(s2.subscriptionId)).toEqual([]);
});

test('BILL-079 plans that cannot be bought', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-079', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const picks: Array<[string, string]> = [
    ['free', 'monthly'],
    ['nosuchplan', 'monthly'],
    [inactive.code, 'monthly'],
    [G.code, 'yearly'],
    [retired.code, 'monthly'],
  ];
  for (const [plan, interval] of picks) {
    const reply = await rawApi('POST', '/api/billing/subscribe', { token: tenant.accessToken, ip: clientIp, body: { plan, interval } });
    expect(reply.status, `${plan} ${interval}`).toBe(400);
    expect(reply.body.message, `${plan} ${interval}`).toBe('That plan cannot be bought.');
  }
  expect(await mockCallsFor(tenant.userId)).toEqual([]);
  // The same account can buy a plan that is on sale.
  expect((await rawApi('POST', '/api/billing/subscribe', { token: tenant.accessToken, ip: clientIp, body: { plan: P.code, interval: 'yearly' } })).status).toBe(201);
});

test('BILL-081 subscribing while already subscribed is refused', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-081', 'Cara Customer');
  await activeOn(tenant, clientIp, G);
  const creates = async () =>
    (await mockCallsFor(tenant.userId)).filter((c) => c.method === 'POST' && c.path === '/v1/subscriptions').length;
  expect(await creates()).toBe(1);

  const reply = await rawApi('POST', '/api/billing/subscribe', {
    token: tenant.accessToken,
    ip: clientIp,
    body: { plan: P.code, interval: 'monthly' },
  });
  expect(reply.status).toBe(409);
  expect(reply.body.message).toBe('You already have a subscription. Change your plan instead.');
  expect(await creates()).toBe(1);
});

test('BILL-084 subscribing after a halt replaces the halted subscription', async ({ page, clientIp }) => {
  test.setTimeout(200_000);
  const tenant = await createAccount(clientIp, 'bill-084', 'Cara Customer');
  const halted = await activeOn(tenant, clientIp, G);
  await halt(halted);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Payment failed');

  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/billing/subscribe' && r.ok());
  await choose(page, P).click();
  const checkout = ((await (await answered).json()) as { data: Parameters<typeof activate>[0] }).data;
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();
  // Until the new one charges, the halted one keeps its grace and G's limits.
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Payment failed');
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(G.name);
  await expect(card.getByText('Projects: 0 of 20', { exact: true })).toBeVisible();

  await activate(checkout);
  await expect(page.getByRole('status').filter({ hasText: 'Payment received. Your plan is updated.' })).toBeVisible();
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Active');
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(P.name);

  const old = await subscriptionRow(halted.checkout.subscriptionId);
  const fresh = await subscriptionRow(checkout.subscriptionId);
  expect(old.superseded_by).toBe(fresh.id);
  expect(old.cancel_at_cycle_end).toBe(false);
  expect((await overview(tenant, clientIp)).current?.id).toBe(fresh.id);
  expect((await waitForCancelCall(halted.checkout.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: false });
});

// ------------------------------------------------------------------ F. cancel and change

test('BILL-090 cancelling an active plan at the period end', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-090', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const cancels = watch(page, '/api/billing/cancel', 'POST');
  // Held for a moment, so the button's busy label can be seen.
  await page.route(
    (url) => url.pathname === '/api/billing/cancel',
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    },
  );
  await signIn(page, tenant);
  await openBilling(page);

  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your plan stays until/)).toHaveText(
    `Your plan stays until ${longDate(active.periodEnd)}. After that your account moves to Free; nothing is deleted.`,
  );
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();
  expect(cancels).toHaveLength(0);

  await page.getByRole('button', { name: 'Cancel plan' }).click();
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancelling...' })).toBeDisabled();
  await expect(page.getByText('Your plan will end at the end of this period', { exact: true }).first()).toBeVisible();
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Ends at the period end');
  expect(cancels).toHaveLength(1);

  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: true }]);
  const row = await subscriptionRow(active.checkout.subscriptionId);
  expect(row.cancel_at_period_end).toBe(true);
  expect(row.cancel_sent_at).not.toBeNull();
  expect(row.cancel_requested_by).toBe(tenant.userId);
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('cancelling');
  expect(o.effectivePlan.code).toBe(G.code);
});

test('BILL-091 cancelling a halted plan ends it now', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-091', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await halt(active);
  await signIn(page, tenant);
  await openBilling(page);

  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your plan ends now/)).toHaveText(
    'Your plan ends now and the failed payment is not tried again. Your account moves to Free; nothing is deleted.',
  );
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(page.getByText('Your plan is cancelled', { exact: true }).first()).toBeVisible();
  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: false }]);
  // The plan stays until Razorpay says the subscription ended.
  expect((await overview(tenant, clientIp)).effectivePlan.code).toBe(G.code);

  await sendSubscriptionEvent('subscription.cancelled', active.checkout.subscriptionId, { status: 'cancelled', ended_at: nowSeconds() });
  await page.reload();
  await expect(stateCard(page).locator('[data-slot="card-title"]')).toHaveText('Free');
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('No paid plan');
});

test('BILL-093 cancelling drops a scheduled change', async ({ page, clientIp }) => {
  test.setTimeout(200_000);
  const tenant = await createAccount(clientIp, 'bill-093', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const successor = await changePlan(tenant, clientIp, P.code);
  await authenticate(successor);
  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Upgrade starts at next charge');

  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your scheduled change/)).toHaveText(
    `Your scheduled change to ${P.name} is dropped and your plan ends on ${longDate(active.periodEnd)}. After that your account moves to Free; nothing is deleted.`,
  );
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(page.getByText('Your plan will end at the end of this period', { exact: true }).first()).toBeVisible();
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Ends at the period end');

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('cancelling');
  expect(o.next).toBeNull();
  const next = await subscriptionRow(successor.subscriptionId);
  expect(next.cancel_requested_at).not.toBeNull();
  expect(next.cancel_at_cycle_end).toBe(false);
  expect((await waitForCancelCall(successor.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: false });
  const currentCancels = await cancelCalls(active.checkout.subscriptionId);
  expect(currentCancels.length).toBeGreaterThanOrEqual(1);
  expect(currentCancels.every((c) => c.body.cancel_at_cycle_end === true)).toBe(true);
});

test('BILL-097 switching to a higher plan: upgrade pending', async ({ page, clientIp }) => {
  test.setTimeout(200_000);
  const tenant = await createAccount(clientIp, 'bill-097', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);

  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/billing/change');
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/billing/change' && r.ok());
  const clickedAt = nowSeconds();
  await choose(page, P, 'Switch').click();
  expect((await request).postDataJSON()).toStrictEqual({ plan: P.code, interval: 'monthly' });
  const checkout = ((await (await answered).json()) as { data: Parameters<typeof activate>[0] }).data;
  expect(checkout.startsAt).toBe(new Date(active.periodEnd * 1000).toISOString());
  const atMock = await mockSubscription(checkout.subscriptionId);
  expect(atMock.start_at).toBe(active.periodEnd);
  // min(now + 24 h, period end - 5 min): the period is a month away.
  expect(Math.abs((atMock.expire_by as number) - (clickedAt + DAY_SECONDS))).toBeLessThanOrEqual(60);
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();

  await authenticate(checkout);
  await expect(
    page.getByRole('status').filter({ hasText: 'Change authorised. Its limits start once its first charge goes through.' }),
  ).toBeVisible();
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Upgrade starts at next charge');
  await expect(card.getByText(`Moves to ${P.name} (monthly) on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(G.name);
  await expect(card.getByText('Projects: 0 of 20', { exact: true })).toBeVisible();
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('upgrade_pending');
  expect(o.effectivePlan.code).toBe(G.code);

  // The worker sends the current subscription's cycle-end cancel.
  expect((await waitForCancelCall(active.checkout.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: true });
});

test('BILL-099 the successor starts charging and becomes current', async ({ page, clientIp }) => {
  test.setTimeout(200_000);
  const tenant = await createAccount(clientIp, 'bill-099', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const successor = await changePlan(tenant, clientIp, P.code);
  await authenticate(successor);
  expect((await waitForCancelCall(active.checkout.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: true });

  await activate(successor, active.periodEnd);

  const oldRow = await subscriptionRow(active.checkout.subscriptionId);
  const newRow = await subscriptionRow(successor.subscriptionId);
  expect(newRow.was_current).toBe(true);
  expect(oldRow.superseded_by).toBe(newRow.id);
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('active');
  expect(o.current?.id).toBe(newRow.id);
  expect(o.next).toBeNull();
  expect(o.effectivePlan.code).toBe(P.code);
  // P's limits, not Free's (both have the default project limit and no seat limit; the MAU limit differs).
  expect(o.usage.mau.limit).toBe(50_000);
  expect(o.usage.projects.limit).toBe(10);
  expect(o.usage.seats.limit).toBeNull();
  // No second cancel for the old one: it was already cancelled at its cycle end.
  expect(await cancelCalls(active.checkout.subscriptionId)).toHaveLength(1);
  expect(oldRow.cancel_sent_at).not.toBeNull();
  expect(oldRow.cancel_requested_at!.getTime()).toBeLessThanOrEqual(oldRow.cancel_sent_at!.getTime());

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Active');
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(P.name);
  await expect(card.getByText('Projects: 0 of 10', { exact: true })).toBeVisible();
  await expect(card.getByText('Team members: 1 of Unlimited', { exact: true })).toBeVisible();
});

test('BILL-103 "Keep my plan" after cancelling', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-103', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await cancelPlan(tenant, clientIp);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Ends at the period end');

  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/billing/change');
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/billing/change' && r.ok());
  await choose(page, G, 'Keep my plan').click();
  expect((await request).postDataJSON()).toStrictEqual({ plan: G.code, interval: 'monthly' });
  const checkout = ((await (await answered).json()) as { data: Parameters<typeof activate>[0] }).data;
  expect(checkout.startsAt).toBe(new Date(active.periodEnd * 1000).toISOString());
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();

  await authenticate(checkout);
  await expect(
    page.getByRole('status').filter({ hasText: 'Change authorised. Its limits start once its first charge goes through.' }),
  ).toBeVisible();
  const card = stateCard(page);
  await expect(card.getByText(`Moves to ${G.name} (monthly) on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Plan change scheduled');
});

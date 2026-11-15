import type { BrowserContext, Page, Request } from '@playwright/test';
import { randomBytes } from 'crypto';
import { adminApi, adminUrl, enrolAndSignInStaff, grantSuperAdmin } from '../../support/admin';
import { createAccount, newClientIp, type Account } from '../../support/api';
import { expect, signIn, test } from '../../support/fixtures';
import { extractLink, waitForMail } from '../../support/mailbox';
import {
  activate,
  activeOn,
  adminCard,
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
  endCompOf,
  flushCancel,
  halt,
  mockCallsFor,
  mockSubscription,
  nowSeconds,
  openBilling,
  outboxRow,
  overview,
  paymentEntity,
  paymentRow,
  planCard,
  postWebhook,
  query,
  rawApi,
  recordedCheckouts,
  refundEntity,
  saveDetails,
  seedUnknownPrice,
  seedUnknownSubscription,
  sendEntities,
  sendEvent,
  sendInvoicePaid,
  sendSubscriptionEvent,
  setProjectLimit,
  setSeatLimit,
  staffPasskeyToken,
  staleToken,
  ageSignIns,
  startVariantApi,
  stateCard,
  stubCheckout,
  subscribe,
  subscriptionEntity,
  subscriptionRow,
  longDate,
  type Active,
  type BillingOffApi,
  type Plan,
} from '../../support/areas/bill';

/**
 * Billing beyond the P0 cases, from paying to the provider's side: Checkout's other
 * outcomes (still processing, dismissed, a script that does not load), the API's
 * refusals to subscribe, change and cancel, plan limits as the effective plan sets them
 * (staff overrides, staff plan edits, two install variants), invoices, the Razorpay
 * webhook's ordering and ledger rules, and the cancel outbox failing. States are
 * reached through the real flow against the local Razorpay mock; rows the mock cannot
 * produce (a subscription or price it does not know) are written with SQL.
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
  const staff = await createAccount(staffIp, 'bill-p1b-staff', 'Bina Staff');
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

const button = (page: Page, plan: Plan, label = 'Choose') =>
  planCard(page, plan.name).getByRole('button', { name: label, exact: true });

const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

const toast = (page: Page, title: string) =>
  page
    .getByRole('region', { name: /^Notifications/ })
    .getByRole('listitem')
    .filter({ has: page.getByText(title, { exact: true }) });

type Checkout = Parameters<typeof activate>[0];

/** The checkout the page's next successful subscribe or change answered. */
function nextCheckout(page: Page, pathname: '/api/billing/subscribe' | '/api/billing/change'): Promise<Checkout> {
  return page
    .waitForResponse((r) => isPath(pathname, 'POST')(r) && r.ok())
    .then(async (r) => ((await r.json()) as { data: Checkout }).data);
}

const post = (account: Account, ip: string, path: string, body?: unknown, token = account.accessToken) =>
  rawApi('POST', path, { token, ip, body });

/** A tenant whose current subscription on G is past due (Razorpay retrying a renewal). */
async function pendingOn(account: Account, ip: string, plan: Plan): Promise<Active> {
  const active = await activeOn(account, ip, plan);
  await sendSubscriptionEvent('subscription.pending', active.checkout.subscriptionId, { status: 'pending' });
  return active;
}

const activation = (checkout: { customerId: string | null }, start = nowSeconds(), extra: Record<string, unknown> = {}) => ({
  status: 'active',
  customer_id: checkout.customerId,
  current_start: start,
  current_end: start + 30 * DAY_SECONDS,
  charge_at: start + 30 * DAY_SECONDS,
  paid_count: 1,
  ...extra,
});

// ------------------------------------------------------------------ E. subscribe through Checkout

test('BILL-072 "Still processing" after two minutes without a webhook', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-072', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await page.clock.install();
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);

  await button(page, G).click();
  await expect(status(page, 'Processing payment...')).toBeVisible();
  // Still asking the server while processing.
  await page.waitForResponse((r) => isPath('/api/billing', 'GET')(r));

  await page.clock.fastForward(120_000);
  await expect(status(page, 'Still processing. This page will update when Razorpay confirms.')).toBeVisible();
  await expect(page.getByText('Processing payment...')).toHaveCount(0);

  // Polling has stopped: nothing in well over two 3-second intervals.
  const polls = watch(page, '/api/billing');
  await page.waitForTimeout(7_000);
  expect(polls).toHaveLength(0);
  expect((await overview(tenant, clientIp)).state).toBe('checkout');
});

test('BILL-073 Checkout dismissed', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-073', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await stubCheckout(page, ['dismiss']);
  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('No paid plan');

  const subscribed = page.waitForResponse((r) => isPath('/api/billing/subscribe', 'POST')(r) && r.ok());
  const refetched = subscribed.then(() => page.waitForResponse((r) => isPath('/api/billing', 'GET')(r) && r.ok()));
  await button(page, G).click();
  await subscribed;
  await refetched;
  expect(await recordedCheckouts(page)).toHaveLength(1);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Waiting for payment');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByText('Processing payment...')).toHaveCount(0);
  // "Choose" is offered again, and works.
  await expect(button(page, G)).toBeEnabled();
  expect((await overview(tenant, clientIp)).state).toBe('checkout');
});

test('BILL-075 Checkout script fails to load', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-075', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  let aborted = 0;
  const abort = async (route: { abort(): Promise<void> }) => {
    aborted += 1;
    await route.abort();
  };
  await page.route('https://checkout.razorpay.com/**', abort);
  await signIn(page, tenant);
  await openBilling(page);

  const subscribed = page.waitForResponse((r) => isPath('/api/billing/subscribe', 'POST')(r) && r.ok());
  await button(page, G).click();
  await subscribed;
  const failed = toast(page, 'Could not start the payment');
  await expect(failed).toBeVisible();
  await expect(failed.getByText('Could not load Razorpay Checkout. Check your connection and try again.', { exact: true })).toBeVisible();
  await expect(button(page, G)).toBeEnabled();
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(aborted).toBe(1);
  // The subscription was made on the server before the script was needed.
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('checkout');
  expect(o.next?.planCode).toBe(G.code);

  // A second try loads the script again (here it loads) and opens Checkout.
  await page.unroute('https://checkout.razorpay.com/**', abort);
  await stubCheckout(page);
  const second = nextCheckout(page, '/api/billing/subscribe');
  await button(page, G).click();
  const checkout = await second;
  await expect(status(page, 'Processing payment...')).toBeVisible();
  const [opened] = await recordedCheckouts(page);
  expect(opened.json.subscription_id).toBe(checkout.subscriptionId);

  await page.reload();
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Waiting for payment');
});

test('BILL-078 subscribing without billing details is refused', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-078', 'Cara Customer');
  const reply = await post(tenant, clientIp, '/api/billing/subscribe', { plan: G.code, interval: 'monthly' });
  expect(reply.status).toBe(400);
  expect(reply.body.message).toBe('Add your billing details first.');
  expect(await mockCallsFor(tenant.userId)).toEqual([]);
  // With details, the same request goes through.
  await saveDetails(tenant, clientIp);
  expect((await post(tenant, clientIp, '/api/billing/subscribe', { plan: G.code, interval: 'monthly' })).status).toBe(201);
});

test('BILL-080 ChoosePlanDto validation', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-080', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const cases: Array<[unknown, string[]]> = [
    [{ plan: 'Free!', interval: 'monthly' }, ['plan must be a plan code']],
    [{ plan: G.code, interval: 'weekly' }, ['interval must be one of the following values: monthly, yearly']],
    [{ plan: G.code }, ['interval must be one of the following values: monthly, yearly']],
    [{ plan: G.code, interval: 'monthly', amountPaise: 1 }, ['property amountPaise should not exist']],
    [{ plan: G.code, interval: 'monthly', price: 100 }, ['property price should not exist']],
  ];
  for (const path of ['/api/billing/subscribe', '/api/billing/change']) {
    for (const [body, messages] of cases) {
      const reply = await post(tenant, clientIp, path, body);
      expect(reply.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(reply.body.message, `${path} ${JSON.stringify(body)}`).toEqual(messages);
    }
  }
  expect(await mockCallsFor(tenant.userId)).toEqual([]);
});

test('BILL-082 subscribing or changing while a payment is retrying is refused', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-082', 'Cara Customer');
  await pendingOn(tenant, clientIp, G);
  expect((await overview(tenant, clientIp)).state).toBe('past_due');
  const before = await createdAtMock(tenant.userId);
  for (const path of ['/api/billing/subscribe', '/api/billing/change']) {
    const reply = await post(tenant, clientIp, path, { plan: P.code, interval: 'monthly' });
    expect(reply.status, path).toBe(409);
    expect(reply.body.message, path).toBe("Your last payment is being retried. Update your payment method from Razorpay's email.");
  }
  expect(await createdAtMock(tenant.userId)).toBe(before);
});

test('BILL-083 subscribing while a change is scheduled is refused', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-083', 'Cara Customer');
  await activeOn(tenant, clientIp, G);
  await authenticate(await changePlan(tenant, clientIp, L.code));
  expect((await overview(tenant, clientIp)).state).toBe('change_scheduled');
  const before = await createdAtMock(tenant.userId);

  const reply = await post(tenant, clientIp, '/api/billing/subscribe', { plan: P.code, interval: 'monthly' });
  expect(reply.status).toBe(409);
  // The current subscription is live until its period end, which is checked first.
  expect(reply.body.message).toBe('You already have a subscription. Change your plan instead.');
  expect(await createdAtMock(tenant.userId)).toBe(before);
});

test('BILL-085 subscribing while comped', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-085', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const token = await freshStaff();
  await compTenant(token, staffIp, tenant.userId, P.code);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Complimentary');

  const checkout = nextCheckout(page, '/api/billing/subscribe');
  await button(page, G).click();
  await expect(status(page, 'Processing payment...')).toBeVisible();
  await activate(await checkout);
  await expect(status(page, 'Payment received. Your plan is updated.')).toBeVisible();
  // The comp comes first.
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Complimentary');
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(P.name);
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('comped');
  expect(o.effectivePlan.code).toBe(P.code);
  expect(o.current?.status).toBe('active');
  expect(o.current?.planCode).toBe(G.code);

  // Staff see a comped account that is also paying.
  const summary = await adminApi<{ comped: Array<{ tenantId: string; paying: boolean; planCode: string }> }>(
    'GET',
    '/api/admin/billing/summary',
    undefined,
    token,
    staffIp,
  );
  expect(summary.comped.filter((row) => row.tenantId === tenant.userId)).toEqual([
    expect.objectContaining({ planCode: P.code, paying: true }),
  ]);
  await staffPage.goto(adminUrl('/billing'));
  const row = adminCard(staffPage, 'Complimentary plans').getByRole('row').filter({ hasText: tenant.email });
  await expect(row.getByRole('cell').last()).toHaveText('Yes: a subscription charges it');

  // Once the comp ends, the subscription's plan applies.
  await endCompOf(await freshStaff(), staffIp, tenant.userId);
  const after = await overview(tenant, clientIp);
  expect(after.state).toBe('active');
  expect(after.effectivePlan.code).toBe(G.code);
});

test('BILL-086 subscribing needs a recent sign-in', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-086', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  await stubCheckout(page);
  await signIn(page, tenant);
  await ageSignIns(tenant.userId);
  // A page load takes a new access token from the session, carrying the old sign-in time.
  await openBilling(page);
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });

  // Cancelling the prompt fails the start with the API's message.
  const refused = page.waitForResponse((r) => isPath('/api/billing/subscribe', 'POST')(r));
  await button(page, G).click();
  const first = await refused;
  expect(first.status()).toBe(403);
  expect(((await first.json()) as { message: string }).message).toBe(REAUTH);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  const failed = toast(page, 'Could not start the payment');
  await expect(failed).toBeVisible();
  await expect(failed.getByText(REAUTH, { exact: true })).toBeVisible();
  expect(await createdAtMock(tenant.userId)).toBe(0);

  // Answering it resends the request once, and Checkout opens.
  const sent = watch(page, '/api/billing/subscribe', 'POST');
  const resent = nextCheckout(page, '/api/billing/subscribe');
  await button(page, G).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill(tenant.password);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const checkout = await resent;
  await expect(status(page, 'Processing payment...')).toBeVisible();
  expect(sent).toHaveLength(2);
  const [opened] = await recordedCheckouts(page);
  expect(opened.json.subscription_id).toBe(checkout.subscriptionId);
  expect(await createdAtMock(tenant.userId)).toBe(1);
});

test('BILL-088 the provider refuses the subscription', async ({ clientIp }) => {
  const token = await freshStaff();
  const unknown = await createPlan(token, staffIp, { label: 'Unknown at Razorpay', sortOrder: 90, mauLimit: 100, projectLimit: 2, seatLimit: 2 });
  await seedUnknownPrice(unknown.code, 59_900);
  const tenant = await createAccount(clientIp, 'bill-088', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  try {
    const reply = await post(tenant, clientIp, '/api/billing/subscribe', { plan: unknown.code, interval: 'monthly' });
    expect(reply.status).toBe(502);
    expect(reply.body.message).toBe('Razorpay could not start the payment. Try again later.');
    expect(JSON.stringify(reply.body)).not.toContain('does not exist');
    expect(await query(`SELECT id FROM billing_subscriptions WHERE user_id = $1`, [tenant.userId])).toEqual([]);
    expect((await overview(tenant, clientIp)).state).toBe('free');
    // The request did reach Razorpay, which refused it.
    expect(await createdAtMock(tenant.userId)).toBe(1);
  } finally {
    await deactivatePlan(token, staffIp, unknown.code);
  }
});

// ------------------------------------------------------------------ F. cancel and change

test('BILL-092 cancelling while a payment is retrying ends at the period end', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-092', 'Cara Customer');
  const active = await pendingOn(tenant, clientIp, G);
  const reply = await post(tenant, clientIp, '/api/billing/cancel');
  expect(reply.status).toBe(201);
  expect(reply.body.data.current.cancelAtPeriodEnd).toBe(true);
  expect(reply.body.data.current.status).toBe('pending');
  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: true }]);
});

test('BILL-094 cancelling after "Keep my plan" undoes the keep', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-094', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await cancelPlan(tenant, clientIp);
  const keep = await changePlan(tenant, clientIp, G.code);
  await authenticate(keep);
  expect((await overview(tenant, clientIp)).next?.status).toBe('authenticated');
  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Plan change scheduled');

  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Keeping your plan/)).toHaveText(
    `Keeping your plan is undone and your plan ends on ${longDate(active.periodEnd)}. After that your account moves to Free; nothing is deleted.`,
  );
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(toast(page, 'Your plan will end at the end of this period')).toBeVisible();
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('Ends at the period end');

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('cancelling');
  expect(o.next).toBeNull();
  const row = await subscriptionRow(keep.subscriptionId);
  expect(row.cancel_requested_at).not.toBeNull();
  expect(row.cancel_at_cycle_end).toBe(false);
  expect((await flushCancel(keep.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: false });
  // The current one was already set to end; nothing more was sent for it.
  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: true }]);
});

test('BILL-095 nothing to cancel', async ({ page, browser, baseURL, clientIp }) => {
  const free = await createAccount(clientIp, 'bill-095', 'Cara Customer');
  const ip2 = newClientIp();
  const ending = await createAccount(ip2, 'bill-095-b', 'Dev Customer');
  const active = await activeOn(ending, ip2, G);
  await cancelPlan(ending, ip2);
  expect((await overview(ending, ip2)).state).toBe('cancelling');

  await signIn(page, free);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="badge"]')).toHaveText('No paid plan');
  await expect(page.getByRole('button', { name: 'Cancel plan' })).toHaveCount(0);

  const other = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, timezoneId: 'UTC', extraHTTPHeaders: { 'X-Forwarded-For': ip2 } });
  try {
    const page2 = await other.newPage();
    await signIn(page2, ending);
    await openBilling(page2);
    await expect(stateCard(page2).locator('[data-slot="badge"]')).toHaveText('Ends at the period end');
    await expect(page2.getByRole('button', { name: 'Cancel plan' })).toHaveCount(0);
  } finally {
    await other.close();
  }

  const none = await post(free, clientIp, '/api/billing/cancel');
  expect(none.status).toBe(409);
  expect(none.body.message).toBe('There is no active subscription to cancel.');

  const calls = (await cancelCalls(active.checkout.subscriptionId)).length;
  expect(calls).toBe(1);
  const again = await post(ending, ip2, '/api/billing/cancel');
  expect(again.status).toBe(201);
  expect(again.body.data.state).toBe('cancelling');
  expect(await cancelCalls(active.checkout.subscriptionId)).toHaveLength(calls);
});

test('BILL-096 cancelling needs a recent sign-in, and a provider refusal is a 502', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-096', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const seeded = await seedUnknownSubscription(tenant.userId, G, { current: true });
  expect((await overview(tenant, clientIp)).state).toBe('active');

  const stale = await staleToken(tenant, clientIp);
  const old = await post(tenant, clientIp, '/api/billing/cancel', undefined, stale);
  expect(old.status).toBe(403);
  expect(old.body.message).toBe(REAUTH);
  expect(await cancelCalls(seeded.providerId)).toEqual([]);

  const fresh = await createAccountToken(tenant, clientIp);
  const refused = await post(tenant, clientIp, '/api/billing/cancel', undefined, fresh);
  expect(refused.status).toBe(502);
  expect(refused.body.message).toBe('Razorpay could not cancel the subscription. Try again later.');
  // Razorpay was asked, and refused; nothing is recorded as sent.
  expect(await cancelCalls(seeded.providerId)).toHaveLength(1);
  const row = await subscriptionRow(seeded.providerId);
  expect(row.cancel_sent_at).toBeNull();
  expect(row.cancel_at_period_end).toBe(false);
  expect((await overview(tenant, clientIp)).state).toBe('active');
});

/** A fresh password sign-in's access token (a recent sign-in). */
async function createAccountToken(account: Account, ip: string): Promise<string> {
  const reply = await rawApi('POST', '/api/auth/login', { ip, body: { email: account.email, password: account.password } });
  expect(reply.status).toBe(200);
  return reply.body.data.tokens.accessToken;
}

test('BILL-098 switching to a lower plan: change scheduled', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-098', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);

  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/billing/change');
  const checkout = nextCheckout(page, '/api/billing/change');
  await button(page, L, 'Switch').click();
  expect((await request).postDataJSON()).toStrictEqual({ plan: L.code, interval: 'monthly' });
  await authenticate(await checkout);
  await expect(status(page, 'Change authorised. Its limits start once its first charge goes through.')).toBeVisible();
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Plan change scheduled');
  await expect(card.getByText(`Moves to ${L.name} (monthly) on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  await expect(card.locator('[data-slot="card-title"]')).toHaveText(G.name);
  await expect(card.getByText('Projects: 0 of 20', { exact: true })).toBeVisible();
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('change_scheduled');
  expect(o.effectivePlan.code).toBe(G.code);
});

test('BILL-100 switching interval on the same plan', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-100', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, P);
  await stubCheckout(page);
  await signIn(page, tenant);
  await openBilling(page);
  await expect(planCard(page, P.name).locator('[data-slot="badge"]')).toHaveText('Current plan');

  await page.getByRole('radiogroup', { name: 'Billing period' }).getByRole('radio', { name: 'Yearly' }).click();
  const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/billing/change');
  const answered = nextCheckout(page, '/api/billing/change');
  await button(page, P, 'Switch').click();
  expect((await request).postDataJSON()).toStrictEqual({ plan: P.code, interval: 'yearly' });
  const checkout = await answered;
  const atMock = await mockSubscription(checkout.subscriptionId);
  expect(atMock.total_count).toBe(10);
  expect(atMock.plan_id).toBe(P.prices.yearly!.razorpayPlanId);
  expect(atMock.start_at).toBe(active.periodEnd);

  await authenticate(checkout);
  await expect(status(page, 'Change authorised. Its limits start once its first charge goes through.')).toBeVisible();
  const card = stateCard(page);
  await expect(card.getByText(`Moves to ${P.name} (yearly) on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Plan change scheduled');
  expect((await overview(tenant, clientIp)).state).toBe('change_scheduled');
});

test('BILL-101 change refusals', async ({ clientIp }) => {
  const as = async (label: string) => {
    const ip = newClientIp();
    const account = await createAccount(ip, `bill-101-${label}`, 'Cara Customer');
    return { ip, account };
  };
  const change = (t: { ip: string; account: Account }, plan: Plan) =>
    post(t.account, t.ip, '/api/billing/change', { plan: plan.code, interval: 'monthly' });

  const free = await as('a');
  await saveDetails(free.account, free.ip);
  const active = await as('b');
  await activeOn(active.account, active.ip, G);
  const halted = await as('c');
  await halt(await activeOn(halted.account, halted.ip, G));
  const scheduled = await as('d');
  await activeOn(scheduled.account, scheduled.ip, G);
  await authenticate(await changePlan(scheduled.account, scheduled.ip, P.code));

  const cases: Array<[{ ip: string; account: Account }, Plan, number, string]> = [
    [free, G, 409, 'There is no active subscription to change.'],
    [active, G, 400, 'You are already on this plan.'],
    [halted, P, 409, 'There is no active subscription to change.'],
    [scheduled, L, 409, 'A plan change is already scheduled.'],
  ];
  for (const [tenant, plan, code, message] of cases) {
    const before = await createdAtMock(tenant.account.userId);
    const reply = await change(tenant, plan);
    expect(reply.status, message).toBe(code);
    expect(reply.body.message, message).toBe(message);
    expect(await createdAtMock(tenant.account.userId)).toBe(before);
  }
  // The active account can change to another plan.
  expect((await change(active, P)).status).toBe(201);
});

test('BILL-102 a change too close to the renewal is refused', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-102', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const checkout = await subscribe(tenant, clientIp, G.code);
  const start = nowSeconds();
  const sent = await sendEvent(
    'subscription.activated',
    checkout.subscriptionId,
    activation(checkout, start - 30 * DAY_SECONDS + 9 * 60, { current_end: start + 9 * 60, charge_at: start + 9 * 60 }),
    { createdAt: start },
  );
  expect(sent.body).toStrictEqual(RECEIVED);
  expect((await overview(tenant, clientIp)).state).toBe('active');

  const reply = await post(tenant, clientIp, '/api/billing/change', { plan: P.code, interval: 'monthly' });
  expect(reply.status).toBe(409);
  expect(reply.body.message).toBe('Your renewal is too close to change plans. Try again after it.');
  expect(await createdAtMock(tenant.userId)).toBe(1);

  // Once it has renewed, the change goes through.
  await sendEvent(
    'subscription.charged',
    checkout.subscriptionId,
    activation(checkout, start + 9 * 60, { paid_count: 2 }),
    { createdAt: start + 1 },
  );
  expect((await post(tenant, clientIp, '/api/billing/change', { plan: P.code, interval: 'monthly' })).status).toBe(201);
});

test('BILL-104 a second change before authorising replaces the first', async ({ clientIp }) => {
  test.setTimeout(200_000);
  const tenant = await createAccount(clientIp, 'bill-104', 'Cara Customer');
  await activeOn(tenant, clientIp, G);
  const s1 = await changePlan(tenant, clientIp, P.code);
  expect((await subscriptionRow(s1.subscriptionId)).status).toBe('created');

  const reply = await post(tenant, clientIp, '/api/billing/change', { plan: L.code, interval: 'monthly' });
  expect(reply.status).toBe(201);
  const s2 = reply.body.data as Checkout;
  expect(s2.subscriptionId).not.toBe(s1.subscriptionId);
  const row1 = await subscriptionRow(s1.subscriptionId);
  const row2 = await subscriptionRow(s2.subscriptionId);
  expect(row1.superseded_by).toBe(row2.id);
  expect(row1.cancel_requested_at).not.toBeNull();
  expect(row1.cancel_at_cycle_end).toBe(false);
  expect(row2.cancel_requested_at).toBeNull();
  const o = await overview(tenant, clientIp);
  expect(o.next?.id).toBe(row2.id);
  expect(o.next?.planCode).toBe(L.code);

  expect((await flushCancel(s1.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: false });
  expect(await cancelCalls(s2.subscriptionId)).toEqual([]);
});

test('BILL-105 an authorisation that arrives after the current renewed drops the successor', async ({ clientIp }) => {
  test.setTimeout(200_000);
  const tenant = await createAccount(clientIp, 'bill-105', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const successor = await changePlan(tenant, clientIp, P.code);
  expect(successor.startsAt).toBe(new Date(active.periodEnd * 1000).toISOString());

  // The current renews before the successor is authorised.
  const renewed = await sendEvent(
    'subscription.charged',
    active.checkout.subscriptionId,
    activation(active.checkout, active.periodEnd, { paid_count: 2 }),
    { createdAt: nowSeconds() + 1 },
  );
  expect(renewed.body).toStrictEqual(RECEIVED);

  const late = await sendEvent(
    'subscription.authenticated',
    successor.subscriptionId,
    { status: 'authenticated', customer_id: successor.customerId },
    { createdAt: nowSeconds() + 2 },
  );
  expect(late.body).toStrictEqual(RECEIVED);
  expect(await billingEvent(late.eventId)).toMatchObject({ outcome: 'applied', detail: 'successor after renewal' });

  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('active');
  expect(o.effectivePlan.code).toBe(G.code);
  expect(o.next).toBeNull();
  const dropped = await subscriptionRow(successor.subscriptionId);
  expect(dropped.cancel_requested_at).not.toBeNull();
  expect(dropped.cancel_at_cycle_end).toBe(false);
  expect((await flushCancel(successor.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: false });
  // The renewed current is left running.
  expect((await subscriptionRow(active.checkout.subscriptionId)).cancel_requested_at).toBeNull();
  expect(await cancelCalls(active.checkout.subscriptionId)).toEqual([]);
});

test('BILL-107 a subscription ended by Razorpay', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-107', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const T = nowSeconds();
  const completed = await sendEvent(
    'subscription.completed',
    active.checkout.subscriptionId,
    { status: 'completed', ended_at: T + 5 },
    { createdAt: T + 5 },
  );
  expect(completed.body).toStrictEqual(RECEIVED);
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('free');
  expect(o.effectivePlan.code).toBe('free');

  // A later activation of the same subscription changes nothing.
  const revived = await sendEvent(
    'subscription.activated',
    active.checkout.subscriptionId,
    activation(active.checkout, T + 10, { ended_at: null }),
    { createdAt: T + 10 },
  );
  expect(revived.status).toBe(200);
  expect((await subscriptionRow(active.checkout.subscriptionId)).status).toBe('completed');
  expect((await overview(tenant, clientIp)).state).toBe('free');

  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="card-title"]')).toHaveText('Free');
  await expect(button(page, G)).toBeVisible();
});

// ------------------------------------------------------------------ G. plan limits

test.describe('seat default', () => {
  let seats: BillingOffApi;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    seats = await startVariantApi('seat-default', { MAX_SEATS_PER_ACCOUNT: '3' });
  });

  test.afterAll(async () => {
    await seats?.stop();
  });

  test('BILL-111 the Free plan\'s seat limit is the install default', async ({ clientIp }) => {
    const tenant = await createAccount(clientIp, 'bill-111', 'Cara Customer');
    const read = async () => {
      const reply = await rawApi('GET', '/api/billing', { token: tenant.accessToken, ip: clientIp, base: seats.url });
      expect(reply.status).toBe(200);
      return reply.body.data;
    };
    const onFree = await read();
    expect(onFree.effectivePlan.code).toBe('free');
    expect(onFree.usage.seats).toEqual({ used: 1, limit: 3 });
    // The lane's own API has no seat default.
    expect((await overview(tenant, clientIp)).usage.seats).toEqual({ used: 1, limit: null });

    await activeOn(tenant, clientIp, P);
    const onPro = await read();
    expect(onPro.effectivePlan.code).toBe(P.code);
    expect(onPro.usage.seats).toEqual({ used: 1, limit: null });
  });
});

test('BILL-112 a staff override on Free replaces the plan limit, lower or higher', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-112', 'Cara Customer');
  expect((await overview(tenant, clientIp)).usage.projects.limit).toBe(10);
  const token = await freshStaff();
  await setProjectLimit(token, staffIp, tenant.userId, 1);
  expect((await overview(tenant, clientIp)).usage.projects.limit).toBe(1);
  await setProjectLimit(token, staffIp, tenant.userId, 50);
  expect((await overview(tenant, clientIp)).usage.projects.limit).toBe(50);
});

test('BILL-113 a staff override on a paid plan can only raise', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-113', 'Cara Customer');
  await activeOn(tenant, clientIp, G);
  const limits = async () => {
    const o = await overview(tenant, clientIp);
    return [o.usage.projects.limit, o.usage.seats.limit];
  };
  expect(await limits()).toEqual([20, 10]);
  const token = await freshStaff();
  await setProjectLimit(token, staffIp, tenant.userId, 5);
  await setSeatLimit(token, staffIp, tenant.userId, 2);
  expect(await query(`SELECT project_limit, seat_limit FROM users WHERE id = $1`, [tenant.userId])).toEqual([{ project_limit: 5, seat_limit: 2 }]);
  expect(await limits()).toEqual([20, 10]);
  await setProjectLimit(token, staffIp, tenant.userId, 50);
  await setSeatLimit(token, staffIp, tenant.userId, 30);
  expect(await limits()).toEqual([50, 30]);
});

test('BILL-116 a staff edit of a plan\'s limits applies at once', async ({ clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, staffIp, { label: 'Editable', sortOrder: 12, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, monthly: 49_900 });
  const tenant = await createAccount(clientIp, 'bill-116', 'Cara Customer');
  await activeOn(tenant, clientIp, plan);
  expect((await overview(tenant, clientIp)).usage.projects.limit).toBe(20);
  try {
    await adminApi('PATCH', `/api/admin/plans/${plan.code}`, { projectLimit: 25, reason: 'E2E: more projects on this plan' }, token, staffIp);
    expect((await overview(tenant, clientIp)).usage.projects.limit).toBe(25);
  } finally {
    await deactivatePlan(token, staffIp, plan.code);
  }
});

test.describe('billing off', () => {
  let off: BillingOffApi;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    off = await startVariantApi('billing-off', { BILLING_ENABLED: 'false' });
  });

  test.afterAll(async () => {
    await off?.stop();
  });

  test('BILL-117 billing off: limits ignore plans and subscriptions', async ({ clientIp }) => {
    const tenant = await createAccount(clientIp, 'bill-117', 'Cara Customer');
    const token = await freshStaff();
    await compTenant(token, staffIp, tenant.userId, G.code);
    const projectLimit = async (base?: string) => {
      const reply = await rawApi('GET', '/api/projects', { token: tenant.accessToken, ip: clientIp, base });
      expect(reply.status).toBe(200);
      return reply.body.meta.projectLimit;
    };
    // Billing on: the comp's plan.
    expect(await projectLimit()).toBe(20);
    expect((await billingAccountRow(tenant.userId)).comp_plan_code).toBe(G.code);
    // Billing off: the install default, whatever the comp says.
    expect(await projectLimit(off.url)).toBe(10);
    expect((await rawApi('GET', '/api/billing', { token: tenant.accessToken, ip: clientIp, base: off.url })).status).toBe(404);
    // An account's own limit still applies.
    await setProjectLimit(token, staffIp, tenant.userId, 3);
    expect(await projectLimit(off.url)).toBe(3);
  });
});

// ------------------------------------------------------------------ H. invoices

const shortDay = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

test('BILL-119 an invoice from invoice.paid appears', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-119', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await signIn(page, tenant);
  await openBilling(page);
  await expect(page.getByText('No invoices yet. They appear here after your first payment.', { exact: true })).toBeVisible();

  const sent = await sendInvoicePaid({
    subscriptionId: active.checkout.subscriptionId,
    customerId: active.checkout.customerId!,
    number: 'INV-0001',
    amount: 49_900,
    billingStart: active.periodStart,
    billingEnd: active.periodEnd,
    shortUrl: 'https://rzp.io/i/abc123',
  });
  expect(sent.body).toStrictEqual(RECEIVED);

  await page.reload();
  const invoices = page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]').getByText('Invoices', { exact: true }) });
  const rows = invoices.getByRole('row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByRole('columnheader')).toHaveText(['Invoice', 'Period', 'Amount', 'Status', 'Link']);
  await expect(invoices.getByRole('columnheader', { name: 'GST' })).toHaveCount(0);
  const row = rows.nth(1);
  await expect(row.getByRole('cell')).toHaveText([
    'INV-0001',
    `${shortDay(active.periodStart)} to ${shortDay(active.periodEnd)}`,
    '₹499.00',
    'paid',
    'View',
  ]);
  await expect(row.getByRole('cell').first()).toHaveClass(/\bfont-mono\b/);
  await expect(row.locator('[data-slot="badge"]')).toHaveText('paid');
  const view = row.getByRole('link', { name: 'View' });
  await expect(view).toHaveAttribute('href', 'https://rzp.io/i/abc123');
  await expect(view).toHaveAttribute('target', '_blank');
  await expect(view).toHaveAttribute('rel', 'noopener noreferrer');
});

test('BILL-124 invoices API: pagination validation and isolation', async ({ clientIp }) => {
  const c = await createAccount(clientIp, 'bill-124', 'Cara Customer');
  const dIp = newClientIp();
  const d = await createAccount(dIp, 'bill-124-d', 'Dev Customer');
  const invoiceFor = async (account: Account, ip: string, number: string) => {
    const active = await activeOn(account, ip, G);
    const sent = await sendInvoicePaid({
      subscriptionId: active.checkout.subscriptionId,
      customerId: active.checkout.customerId!,
      number,
      amount: 49_900,
      billingStart: active.periodStart,
      billingEnd: active.periodEnd,
      shortUrl: null,
    });
    expect(sent.body).toStrictEqual(RECEIVED);
  };
  await invoiceFor(c, clientIp, 'INV-C-0001');
  await invoiceFor(d, dIp, 'INV-D-0001');

  const get = (query: string) => rawApi('GET', `/api/billing/invoices${query}`, { token: c.accessToken, ip: clientIp });
  const page0 = await get('?page=0');
  expect(page0.status).toBe(400);
  expect(page0.body.message).toEqual(['page must not be less than 1']);
  const big = await get('?limit=101');
  expect(big.status).toBe(400);
  expect(big.body.message).toEqual(['limit must not be greater than 100']);
  const word = await get('?limit=abc');
  expect(word.status).toBe(400);
  expect(word.body.message).toContain('limit must be an integer number');

  const mine = await get('');
  expect(mine.status).toBe(200);
  expect(mine.body.data.map((i: { number: string }) => i.number)).toEqual(['INV-C-0001']);
  expect(mine.body.meta).toEqual({ total: 1, page: 1, limit: 20 });
  // Nothing in the query names an account.
  const named = await rawApi('GET', `/api/billing/invoices?userId=${d.userId}`, { token: c.accessToken, ip: clientIp });
  expect(named.status).toBe(400);
  expect(named.body.message).toEqual(['property userId should not exist']);
  const theirs = await rawApi('GET', '/api/billing/invoices', { token: d.accessToken, ip: dIp });
  expect(theirs.body.data.map((i: { number: string }) => i.number)).toEqual(['INV-D-0001']);
});

// ------------------------------------------------------------------ I. the webhook

/** A tenant active on G from a signed activation stamped at second `T`. */
async function activeAt(account: Account, ip: string, T: number, extra: Record<string, unknown> = {}) {
  await saveDetails(account, ip);
  const checkout = await subscribe(account, ip, G.code);
  const sent = await sendEvent('subscription.activated', checkout.subscriptionId, activation(checkout, T, extra), { createdAt: T });
  expect(sent.body).toStrictEqual(RECEIVED);
  return checkout;
}

test('BILL-130 same-second events are ordered by rank', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-130', 'Cara Customer');
  const T = nowSeconds();
  const checkout = await activeAt(tenant, clientIp, T);
  expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('active');

  const pending = await sendEvent('subscription.pending', checkout.subscriptionId, { status: 'pending' }, { createdAt: T });
  expect(pending.body).toStrictEqual(RECEIVED);
  expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('pending');

  const charged = await sendEvent('subscription.charged', checkout.subscriptionId, { status: 'active' }, { createdAt: T });
  expect(charged.body).toStrictEqual(RECEIVED);
  expect((await billingEvent(charged.eventId))?.outcome).toBe('applied');
  expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('pending');
  expect((await overview(tenant, clientIp)).state).toBe('past_due');

  // A second later, the same charge applies.
  await sendEvent('subscription.charged', checkout.subscriptionId, { status: 'active', paid_count: 2 }, { createdAt: T + 1 });
  expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('active');
});

test('BILL-131 periods only move forward, and the paid count never down', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-131', 'Cara Customer');
  const T = nowSeconds();
  const checkout = await activeAt(tenant, clientIp, T, { paid_count: 2 });
  const E = T + 30 * DAY_SECONDS;
  const mirror = async () =>
    (
      await query<{ current_end: Date; paid_count: number }>(
        `SELECT current_end, paid_count FROM billing_subscriptions WHERE provider_subscription_id = $1`,
        [checkout.subscriptionId],
      )
    )[0];
  expect(await mirror()).toEqual({ current_end: new Date(E * 1000), paid_count: 2 });

  const older = await sendEvent(
    'subscription.charged',
    checkout.subscriptionId,
    activation(checkout, T - 30 * DAY_SECONDS, { paid_count: 1 }),
    { createdAt: T + 10 },
  );
  expect(older.body).toStrictEqual(RECEIVED);
  expect((await billingEvent(older.eventId))?.outcome).toBe('applied');
  expect(await mirror()).toEqual({ current_end: new Date(E * 1000), paid_count: 2 });

  // A later period does move it.
  await sendEvent('subscription.charged', checkout.subscriptionId, activation(checkout, E, { paid_count: 3 }), { createdAt: T + 20 });
  expect(await mirror()).toEqual({ current_end: new Date((E + 30 * DAY_SECONDS) * 1000), paid_count: 3 });
});

test('BILL-132 events that are not ours are ignored with 200', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-132', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const known = await mockSubscription(active.checkout.subscriptionId);
  const later = nowSeconds() + 5;
  const randomId = (prefix: string) => `${prefix}_NotOurs${randomBytes(5).toString('hex')}`;

  const unknownSub = await sendEntities(
    'subscription.activated',
    { subscription: subscriptionEntity({ id: randomId('sub'), planId: G.prices.monthly!.razorpayPlanId, status: 'active' }) },
    later,
  );
  const unknownPlan = await sendEntities(
    'subscription.halted',
    { subscription: { ...known, status: 'halted', plan_id: randomId('plan') } },
    later,
  );
  const mismatch = await sendEntities(
    'subscription.cancelled',
    { subscription: { ...known, status: 'cancelled', plan_id: P.prices.monthly!.razorpayPlanId, ended_at: later } },
    later,
  );
  const failedPayment = await sendEntities('payment.failed', {
    payment: paymentEntity({ amount: 49_900, status: 'failed', customerId: randomId('cust'), invoiceId: randomId('inv') }),
  });
  const invoice = await sendInvoicePaid({
    subscriptionId: randomId('sub'),
    customerId: randomId('cust'),
    number: 'INV-NOT-OURS',
    amount: 49_900,
    billingStart: active.periodStart,
    billingEnd: active.periodEnd,
    shortUrl: null,
  });
  const unknownPaymentId = randomId('pay');
  const refund = await sendEntities('refund.processed', {
    refund: refundEntity(unknownPaymentId, 10_000),
    payment: { ...paymentEntity({ id: unknownPaymentId, amount: 49_900, status: 'captured' }), amount_refunded: 10_000 },
  });
  const orderPaid = await sendEntities('order.paid', { order: { id: randomId('order'), entity: 'order', amount: 49_900 } });

  const cases: Array<[string, typeof unknownSub, string]> = [
    ['unknown subscription', unknownSub, 'unknown subscription'],
    ['unknown plan', unknownPlan, 'unknown plan'],
    ['another price', mismatch, 'plan mismatch'],
    ['payment', failedPayment, 'not ours'],
    ['invoice', invoice, 'not ours'],
    ['refund', refund, 'not ours'],
    ['order.paid', orderPaid, 'unhandled type'],
  ];
  for (const [label, sent, detail] of cases) {
    expect(sent.status, label).toBe(200);
    expect(sent.body, label).toStrictEqual(RECEIVED);
    expect(await billingEvent(sent.eventId), label).toMatchObject({ outcome: 'ignored', detail });
  }
  // Nothing else changed: the known subscription is still active, and nothing was stored for the strangers.
  expect((await subscriptionRow(active.checkout.subscriptionId)).status).toBe('active');
  expect((await overview(tenant, clientIp)).state).toBe('active');
  expect(await paymentRow(unknownPaymentId)).toBeUndefined();
  expect(await query(`SELECT 1 FROM billing_invoices WHERE number = 'INV-NOT-OURS'`)).toEqual([]);
});

test('BILL-133 a signed JSON body that cannot be read is kept as ignored', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-133', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const entity = await mockSubscription(active.checkout.subscriptionId);
  const T = nowSeconds() + 5;
  const subscriptionBody = (overrides: Record<string, unknown>, createdAt: unknown = T) =>
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_e2eMockOnly01',
      event: 'subscription.halted',
      contains: ['subscription'],
      payload: { subscription: { entity: { ...entity, status: 'halted', ...overrides } } },
      created_at: createdAt,
    });
  const bodies: Array<[string, string]> = [
    ['a negative paid count', subscriptionBody({ paid_count: -1 })],
    ['created_at as text', subscriptionBody({}, String(T))],
  ];
  for (const [label, body] of bodies) {
    const first = await postWebhook(body);
    expect(first.status, label).toBe(200);
    expect(first.body, label).toStrictEqual(RECEIVED);
    const rows = await billingEventsWithBody(body);
    expect(rows, label).toEqual([expect.objectContaining({ type: 'invalid', outcome: 'ignored', detail: 'invalid payload', provider_event_id: first.eventId })]);
    // The same bytes again (a new id) make no second row.
    const again = await postWebhook(body);
    expect(again.status, label).toBe(200);
    expect(await billingEventsWithBody(body), label).toHaveLength(1);
    expect(await billingEvent(again.eventId!), label).toBeUndefined();
  }
  // Nothing was applied: the subscription the bodies name is still active.
  expect((await subscriptionRow(active.checkout.subscriptionId)).status).toBe('active');
  // A readable body of the same shape does apply.
  const valid = await postWebhook(subscriptionBody({}));
  expect(valid.body).toStrictEqual(RECEIVED);
  expect((await subscriptionRow(active.checkout.subscriptionId)).status).toBe('halted');
});

test('BILL-133 a signed body that is not JSON is kept as ignored', async () => {
  test.info().annotations.push({ type: 'issue', description: 'BILL-133' });
  test.fail();
  const body = `{not json ${randomBytes(4).toString('hex')}`;
  const first = await postWebhook(body);
  expect(first.status).toBe(200);
  expect(first.body).toStrictEqual(RECEIVED);
  expect(await billingEventsWithBody(body)).toEqual([
    expect.objectContaining({ type: 'invalid', outcome: 'ignored', detail: 'invalid payload', provider_event_id: first.eventId }),
  ]);
  const again = await postWebhook(body);
  expect(again.status).toBe(200);
  expect(await billingEventsWithBody(body)).toHaveLength(1);
});

test('BILL-135 a failed payment is recorded with its reason', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-135', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const payment = paymentEntity({ amount: 49_900, status: 'failed', customerId: active.checkout.customerId, method: 'upi', errorReason: 'payment_failed' });
  const sent = await sendEntities('payment.failed', { payment });
  expect(sent.body).toStrictEqual(RECEIVED);
  expect(await billingEvent(sent.eventId)).toMatchObject({ outcome: 'applied' });
  expect(await paymentRow(payment.id as string)).toMatchObject({
    user_id: tenant.userId,
    status: 'failed',
    failure_reason: 'payment_failed',
    method: 'upi',
    amount_paise: 49_900,
  });

  const token = await freshStaff();
  const summary = await adminApi<{ recentFailures: Array<{ id: string; tenantId: string; failureReason: string; status: string; method: string }> }>(
    'GET',
    '/api/admin/billing/summary',
    undefined,
    token,
    staffIp,
  );
  expect(summary.recentFailures.filter((p) => p.tenantId === tenant.userId)).toEqual([
    expect.objectContaining({ status: 'failed', failureReason: 'payment_failed', method: 'upi' }),
  ]);
  await staffPage.goto(adminUrl('/billing'));
  const row = adminCard(staffPage, 'Recent failed payments').getByRole('row').filter({ hasText: tenant.email });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('₹499.00');
  await expect(row).toContainText('payment_failed');
});

test('BILL-136 a captured payment never goes back to failed, and refunds only rise', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-136', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const payment = paymentEntity({ amount: 49_900, status: 'captured', customerId: active.checkout.customerId, method: 'card' });
  const payId = payment.id as string;
  const charged = await sendEvent(
    'subscription.charged',
    active.checkout.subscriptionId,
    activation(active.checkout, active.periodStart),
    { payment, createdAt: nowSeconds() + 1 },
  );
  expect(charged.body).toStrictEqual(RECEIVED);
  expect(await paymentRow(payId)).toMatchObject({ status: 'captured', amount_refunded_paise: 0 });

  const failed = await sendEntities('payment.failed', {
    payment: paymentEntity({ id: payId, amount: 49_900, status: 'failed', customerId: active.checkout.customerId }),
  });
  expect((await billingEvent(failed.eventId))?.outcome).toBe('applied');
  expect(await paymentRow(payId)).toMatchObject({ status: 'captured', failure_reason: null });

  const refund = (refunded: number) =>
    sendEntities('refund.processed', {
      refund: refundEntity(payId, refunded),
      payment: { ...payment, amount_refunded: refunded, refund_status: 'partial' },
    });
  expect((await refund(10_000)).body).toStrictEqual(RECEIVED);
  expect(await paymentRow(payId)).toMatchObject({ status: 'captured', amount_refunded_paise: 10_000 });
  expect((await refund(5_000)).body).toStrictEqual(RECEIVED);
  expect(await paymentRow(payId)).toMatchObject({ status: 'captured', amount_refunded_paise: 10_000 });
  expect((await refund(49_900)).body).toStrictEqual(RECEIVED);
  expect(await paymentRow(payId)).toMatchObject({ status: 'refunded', amount_refunded_paise: 49_900 });
});

test('BILL-138 the halted webhook sets the grace period and hands off a notice', async ({ clientIp, baseURL }) => {
  const tenant = await createAccount(clientIp, 'bill-138', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const startedAt = Date.now();
  const sent = await sendEvent('subscription.halted', active.checkout.subscriptionId, { status: 'halted' });
  const took = Date.now() - startedAt;
  expect(sent.body).toStrictEqual(RECEIVED);
  expect(took).toBeLessThan(2_000);

  const row = await subscriptionRow(active.checkout.subscriptionId);
  expect(row.status).toBe('halted');
  const expected = startedAt + 14 * DAY_SECONDS * 1000;
  expect(Math.abs(row.grace_until!.getTime() - expected)).toBeLessThan(60_000);

  // Account email is on in this stack: the notice reaches the owner.
  const mail = await waitForMail(tenant.email, { subjectIncludes: 'Your payment did not go through' });
  expect(mail.text).toContain('We could not collect the payment for your Chumbaq plan');
  expect(mail.text).toContain(`Your plan's limits stay until ${row.grace_until!.toUTCString().replace('GMT', 'UTC')}.`);
  expect(new URL(extractLink(mail, '/account/billing')).port).toBe(new URL(baseURL!).port);
  expect(mail.html).toContain('Open billing');
});

// ------------------------------------------------------------------ J. worker jobs

test('BILL-143 an outbox failure is kept, retried and shown to staff', async ({ clientIp }) => {
  test.setTimeout(150_000);
  const tenant = await createAccount(clientIp, 'bill-143', 'Cara Customer');
  const seeded = await seedUnknownSubscription(tenant.userId, G, { cancelRequested: true });
  const { runJobNow } = await import('../../support/jobs');

  const failedOnce = async () => {
    await expect
      .poll(async () => {
        const row = await outboxRow(seeded.providerId);
        if (row.cancel_attempts === 0) await runJobNow('billing-outbox', { allowErrors: true });
        return (await outboxRow(seeded.providerId)).cancel_error;
      }, { timeout: 90_000, intervals: [1_000] })
      .not.toBeNull();
    return outboxRow(seeded.providerId);
  };
  const first = await failedOnce();
  expect(first.cancel_sent_at).toBeNull();
  expect(first.cancel_attempts).toBe(1);
  expect(first.cancel_error).toContain('400 BAD_REQUEST_ERROR The id provided does not exist');
  // Retried a minute after the first failure.
  const wait1 = first.cancel_retry_at!.getTime() - first.updated_at.getTime();
  expect(Math.abs(wait1 - 60_000)).toBeLessThan(10_000);
  // The mock was asked to cancel, then asked whether it had already ended.
  expect(await cancelCalls(seeded.providerId)).toHaveLength(1);

  // Due again: the next failure waits twice as long, and the cancel is still not given up.
  await query(`UPDATE billing_subscriptions SET cancel_retry_at = now() - interval '1 second' WHERE id = $1`, [seeded.id]);
  await expect
    .poll(async () => {
      const row = await outboxRow(seeded.providerId);
      if (row.cancel_attempts < 2) await runJobNow('billing-outbox', { allowErrors: true });
      return (await outboxRow(seeded.providerId)).cancel_attempts;
    }, { timeout: 90_000, intervals: [1_000] })
    .toBe(2);
  const second = await outboxRow(seeded.providerId);
  expect(second.cancel_sent_at).toBeNull();
  const wait2 = second.cancel_retry_at!.getTime() - second.updated_at.getTime();
  expect(Math.abs(wait2 - 120_000)).toBeLessThan(10_000);

  const token = await freshStaff();
  const summary = await adminApi<{ outboxErrors: Array<{ subscriptionId: string; tenantId: string; attempts: number; error: string }> }>(
    'GET',
    '/api/admin/billing/summary',
    undefined,
    token,
    staffIp,
  );
  expect(summary.outboxErrors.filter((r) => r.tenantId === tenant.userId)).toEqual([
    { subscriptionId: seeded.id, tenantId: tenant.userId, attempts: 2, error: second.cancel_error },
  ]);

  await staffPage.goto(adminUrl('/billing'));
  const section = adminCard(staffPage, 'Cancels not yet sent');
  await expect(section.getByRole('columnheader')).toHaveText(['Tenant', 'Subscription', 'Tries', 'Last error']);
  const row = section.getByRole('row').filter({ hasText: seeded.id });
  await expect(row.getByRole('cell')).toHaveText([tenant.userId, seeded.id, '2', second.cancel_error!]);
  await expect(row.getByRole('link', { name: tenant.userId })).toHaveAttribute('href', `/tenants/${tenant.userId}`);
});

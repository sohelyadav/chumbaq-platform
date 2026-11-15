import type { BrowserContext, Page, Request } from '@playwright/test';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { api, createAccount, createProject, newClientIp, type Account } from '../../support/api';
import { adminApi, adminUrl, enrolAndSignInStaff, grantSuperAdmin } from '../../support/admin';
import { expect, signIn, test } from '../../support/fixtures';
import { runSecrets } from '../../support/stack';
import {
  activate,
  activeOn,
  adminCard,
  adminPlanCard,
  adminToast,
  agedStaffToken,
  auditRows,
  authenticate,
  billingAccountRow,
  billingEvent,
  billingEventsWithBody,
  cancelCalls,
  cancelPlan,
  changePlan,
  compTenant,
  createPlan,
  createProjects,
  DAY_SECONDS,
  deactivatePlan,
  DEFAULT_DETAILS,
  endCompOf,
  fact,
  gbDate,
  halt,
  invite,
  longDate,
  mockCalls,
  nowSeconds,
  openBilling,
  overview,
  paymentEntity,
  planCard,
  postWebhook,
  projectCount,
  query,
  rawAdmin,
  rawApi,
  registerMockPlan,
  rupees,
  saveDetails,
  sendEntities,
  sendEvent,
  sendInvoicePaid,
  sendSubscriptionEvent,
  sha256Hex,
  staffPasskeyToken,
  startBillingOffAdminApi,
  stateCard,
  subscribe,
  subscriptionRow,
  tenantBillingCard,
  tryCreateProject,
  waitForCancelCall,
  type BillingOffApi,
  type Plan,
} from '../../support/areas/bill';

/**
 * Plan limits as an effect of the effective plan, invoices on the customer page, the
 * Razorpay webhook (signatures, replays, ordering, what is stored), the worker's cancel
 * outbox, and the staff side: the billing summary, the Plans page and the tenant page's
 * Billing card. States are reached through the real flow against the local Razorpay
 * mock, with the signed webhooks Razorpay would send.
 */

test.use({ timezoneId: 'UTC' });

let staffContext: BrowserContext;
let staffPage: Page;
let staffIp: string;
let staff: Account;
let staffToken = '';
let staffTokenAt = 0;
let G: Plan; // monthly 499.00, 10,000 MAU, 20 projects, 10 seats
let P: Plan; // monthly 1,499.00 and yearly 14,990.00, 50,000 MAU, standard projects, unlimited seats
let L: Plan; // monthly 199.00, 1,000 MAU, 2 projects, 2 seats
let inactive: Plan;

const PROJECT_LIMIT = (n: number) => `You can have up to ${n} projects on your plan. Upgrade your plan or delete one.`;
const SEAT_LIMIT = 'Your plan has no free seats. Upgrade to invite teammates.';
const REFUSED = { data: { received: false } };
const RECEIVED = { data: { received: true } };
const REPLAY = { data: { received: true, replay: true } };

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
  staff = await createAccount(staffIp, 'bill2-staff', 'Bina Staff');
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
  inactive = await createPlan(staffToken, staffIp, { label: 'Retired tier', sortOrder: 30, mauLimit: 100, projectLimit: 2, seatLimit: 2, monthly: 29_900 });
  await deactivatePlan(staffToken, staffIp, inactive.code);
});

test.afterAll(async () => {
  await staffContext?.close();
});

async function projectsMeta(account: Account, ip: string): Promise<{ projectLimit: number }> {
  const reply = await rawApi('GET', '/api/projects', { token: account.accessToken, ip });
  expect(reply.status).toBe(200);
  return reply.body.meta;
}

const inviteeEmail = (label: string) => `${label}-${randomBytes(4).toString('hex')}@e2e.example.test`;

/** Opens a tenant's page in the admin app and waits for its Billing card. */
async function openTenant(tenant: Pick<Account, 'userId' | 'email'>): Promise<void> {
  await staffPage.goto(adminUrl(`/tenants/${tenant.userId}`));
  await expect(staffPage.getByText(tenant.email, { exact: true }).first()).toBeVisible();
  await expect(fact(tenantBillingCard(staffPage), 'State')).toBeVisible();
}

/** The body of the next request to an API path from this page. */
function nextBody(page: Page, pathname: string, method = 'POST'): Promise<Request> {
  return page.waitForRequest((r) => new URL(r.url()).pathname === pathname && r.method() === method);
}

// ------------------------------------------------------------------ G. plan limits

test('BILL-108 a paid plan raises the project limit', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-108', 'Cara Customer');
  await createProjects(tenant, clientIp, 10);

  const refused = await tryCreateProject(tenant, clientIp);
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(PROJECT_LIMIT(10));
  expect((await projectsMeta(tenant, clientIp)).projectLimit).toBe(10);

  await activeOn(tenant, clientIp, G);
  expect((await projectsMeta(tenant, clientIp)).projectLimit).toBe(20);
  expect((await tryCreateProject(tenant, clientIp)).status).toBe(201);
  const o = await overview(tenant, clientIp);
  expect(o.usage.projects).toEqual({ used: 11, limit: 20 });
});

test('BILL-109 an authorised successor grants nothing before its first charge', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-109', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, L);
  await createProjects(tenant, clientIp, 2);
  const [project] = await api<Array<{ id: string }>>('GET', '/api/projects', undefined, { token: tenant.accessToken, ip: clientIp });
  // The owner and one invitee: both of L's seats.
  expect((await invite(tenant, clientIp, project.id, inviteeEmail('bill-109-a'))).status).toBe(201);

  const successor = await changePlan(tenant, clientIp, P.code);
  await authenticate(successor);
  const pending = await overview(tenant, clientIp);
  expect(pending.state).toBe('upgrade_pending');
  expect(pending.effectivePlan.code).toBe(L.code);
  expect(pending.usage.projects).toEqual({ used: 2, limit: 2 });
  expect(pending.usage.seats).toEqual({ used: 2, limit: 2 });

  const project3 = await tryCreateProject(tenant, clientIp);
  expect(project3.status).toBe(403);
  expect(project3.body.message).toBe(PROJECT_LIMIT(2));
  const seat3 = await invite(tenant, clientIp, project.id, inviteeEmail('bill-109-b'));
  expect(seat3.status).toBe(403);
  expect(seat3.body.message).toBe(SEAT_LIMIT);

  // The successor's first charge makes it current: now P's limits.
  await activate(successor, active.periodEnd);
  expect((await overview(tenant, clientIp)).effectivePlan.code).toBe(P.code);
  expect((await tryCreateProject(tenant, clientIp)).status).toBe(201);
  expect((await invite(tenant, clientIp, project.id, inviteeEmail('bill-109-c'))).status).toBe(201);
});

test('BILL-110 the seat limit comes from the plan', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-110', 'Cara Customer');
  await activeOn(tenant, clientIp, G);
  const project = await createProject(tenant, clientIp, 'Seats project');
  // The owner plus nine invitations: ten seats.
  for (let i = 0; i < 9; i += 1) {
    expect((await invite(tenant, clientIp, project.id, inviteeEmail(`bill-110-${i}`))).status).toBe(201);
  }
  expect((await overview(tenant, clientIp)).usage.seats).toEqual({ used: 10, limit: 10 });

  const eleventh = await invite(tenant, clientIp, project.id, inviteeEmail('bill-110-x'));
  expect(eleventh.status).toBe(403);
  expect(eleventh.body.message).toBe(SEAT_LIMIT);
  expect((await overview(tenant, clientIp)).usage.seats).toEqual({ used: 10, limit: 10 });

  // On P (no seat limit) there is none.
  const proIp = newClientIp();
  const pro = await createAccount(proIp, 'bill-110-pro', 'Pia Pro');
  await activeOn(pro, proIp, P);
  expect((await overview(pro, proIp)).usage.seats).toEqual({ used: 1, limit: null });
});

test('BILL-114 a comp gives the comp plan\'s limits', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-114', 'Cara Customer');
  await createProjects(tenant, clientIp, 10);
  expect((await tryCreateProject(tenant, clientIp)).status).toBe(403);

  const token = await freshStaff();
  await compTenant(token, staffIp, tenant.userId, G.code);
  expect((await overview(tenant, clientIp)).state).toBe('comped');
  expect((await tryCreateProject(tenant, clientIp)).status).toBe(201);

  await endCompOf(token, staffIp, tenant.userId);
  const refused = await tryCreateProject(tenant, clientIp);
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(PROJECT_LIMIT(10));
  // Nothing is removed when the limit falls.
  expect(await projectCount(tenant.userId)).toBe(11);
});

test('BILL-115 a halted plan keeps its limits during the grace period only', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-115', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await createProjects(tenant, clientIp, 15);
  await halt(active);
  expect((await overview(tenant, clientIp)).state).toBe('halted');

  expect((await tryCreateProject(tenant, clientIp)).status).toBe(201);

  await query(`UPDATE billing_subscriptions SET grace_until = now() - interval '1 minute' WHERE provider_subscription_id = $1`, [
    active.checkout.subscriptionId,
  ]);
  const refused = await tryCreateProject(tenant, clientIp);
  expect(refused.status).toBe(403);
  expect(refused.body.message).toBe(PROJECT_LIMIT(10));
  expect(await projectCount(tenant.userId)).toBe(16);
});

// ------------------------------------------------------------------ H. invoices

test('BILL-122 unsafe invoice links are not rendered', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-122', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const urls: Array<[string, string]> = [
    ['INV-E2E-JS', 'javascript:alert(1)'],
    ['INV-E2E-HTTP', 'http://rzp.io/i/x'],
    ['INV-E2E-CRED', 'https://user:pw@rzp.io/i/x'],
    ['INV-E2E-OK', 'https://rzp.io/i/e2eok'],
  ];
  for (const [number, shortUrl] of urls) {
    const sent = await sendInvoicePaid({
      subscriptionId: active.checkout.subscriptionId,
      customerId: active.checkout.customerId!,
      number,
      amount: 49_900,
      billingStart: active.periodStart,
      billingEnd: active.periodEnd,
      shortUrl,
    });
    expect(sent.status).toBe(200);
    expect((await billingEvent(sent.eventId))?.outcome).toBe('applied');
  }
  // Every value reached the account's invoices as sent.
  const stored = await query<{ number: string; short_url: string }>(`SELECT number, short_url FROM billing_invoices WHERE user_id = $1`, [
    tenant.userId,
  ]);
  expect(new Map(stored.map((r) => [r.number, r.short_url]))).toEqual(new Map(urls));

  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await signIn(page, tenant);
  await openBilling(page);
  const ok = page.getByRole('row').filter({ hasText: 'INV-E2E-OK' });
  await expect(ok).toBeVisible();
  const view = page.getByRole('link', { name: 'View' });
  await expect(view).toHaveCount(1);
  await expect(ok.getByRole('link', { name: 'View' })).toHaveAttribute('href', 'https://rzp.io/i/e2eok');
  await expect(view).toHaveAttribute('target', '_blank');
  await expect(view).toHaveAttribute('rel', 'noopener noreferrer');
  for (const [number] of urls.slice(0, 3)) {
    const row = page.getByRole('row').filter({ hasText: number });
    await expect(row).toBeVisible();
    await expect(row.getByRole('link')).toHaveCount(0);
    for (const cell of await row.getByRole('cell').all()) await cell.click();
  }
  await expect(page.locator('a[href^="javascript"], a[href^="http:"], a[href*="@rzp.io"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// ------------------------------------------------------------------ H2. secrets

test('BILL-125 no secret in any customer billing response', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-125', 'Cara Customer');
  const as = { token: tenant.accessToken, ip: clientIp };
  const replies: Array<[string, { status: number; body: unknown }]> = [];
  const record = async (label: string, reply: Promise<{ status: number; body: any }>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await reply;
    replies.push([label, r]);
    return r;
  };

  await record('details', rawApi('PUT', '/api/billing/details', { ...as, body: DEFAULT_DETAILS }));
  const subscribed = await record('subscribe', rawApi('POST', '/api/billing/subscribe', { ...as, body: { plan: G.code, interval: 'monthly' } }));
  await activate(subscribed.body.data);
  const read = await record('overview', rawApi('GET', '/api/billing', as));
  const changed = await record('change', rawApi('POST', '/api/billing/change', { ...as, body: { plan: P.code, interval: 'monthly' } }));
  await record('cancel', rawApi('POST', '/api/billing/cancel', as));
  await record('invoices', rawApi('GET', '/api/billing/invoices', as));
  // A refusal too: subscribing again while subscribed.
  await record('refused subscribe', rawApi('POST', '/api/billing/subscribe', { ...as, body: { plan: G.code, interval: 'monthly' } }));

  const { razorpayKeySecret, razorpayWebhookSecret, razorpayKeyId } = runSecrets();
  const [{ provider_customer_id: customerId }] = await query<{ provider_customer_id: string }>(
    `SELECT provider_customer_id FROM billing_accounts WHERE user_id = $1`,
    [tenant.userId],
  );
  expect(customerId).toMatch(/^cust_/);
  for (const [label, reply] of replies) {
    if (label !== 'refused subscribe') expect(reply.status, label).toBeLessThan(300);
    const text = JSON.stringify(reply.body);
    expect(text.includes(razorpayKeySecret), label).toBe(false);
    expect(text.includes(razorpayWebhookSecret), label).toBe(false);
    // The only customer id anywhere is the account's own.
    for (const id of text.match(/cust_[A-Za-z0-9]+/g) ?? []) expect(id, label).toBe(customerId);
  }
  expect(replies.find(([label]) => label === 'refused subscribe')![1].status).toBe(409);
  expect(read.body.data.keyId).toBe(razorpayKeyId);
  expect(subscribed.body.data.customerId).toBe(customerId);
  expect(changed.body.data.customerId).toBe(customerId);
});

// ------------------------------------------------------------------ I. the webhook

/** An account with billing details and a subscription Razorpay has created (Checkout opened). */
async function created(ip: string, label: string) {
  const tenant = await createAccount(ip, label, 'Cara Customer');
  await saveDetails(tenant, ip);
  const checkout = await subscribe(tenant, ip, G.code);
  return { tenant, checkout };
}

const activation = (checkout: { customerId: string | null }, start = nowSeconds()) => ({
  status: 'active',
  customer_id: checkout.customerId,
  current_start: start,
  current_end: start + 30 * DAY_SECONDS,
  charge_at: start + 30 * DAY_SECONDS,
  paid_count: 1,
});

test('BILL-126 a valid signed event is recorded and applied', async ({ clientIp }) => {
  const { tenant, checkout } = await created(clientIp, 'bill-126');
  expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('created');

  const sent = await sendEvent('subscription.activated', checkout.subscriptionId, activation(checkout));
  expect(sent.status).toBe(200);
  expect(sent.body).toStrictEqual(RECEIVED);
  const row = await billingEvent(sent.eventId);
  expect(row).toMatchObject({
    provider: 'razorpay',
    provider_event_id: sent.eventId,
    type: 'subscription.activated',
    outcome: 'applied',
    body_sha256: sha256Hex(sent.rawBody),
    attempts: 1,
  });
  const sub = await subscriptionRow(checkout.subscriptionId);
  expect(sub.status).toBe('active');
  expect((await billingAccountRow(tenant.userId)).current_subscription_id).toBe(sub.id);
  expect((await overview(tenant, clientIp)).state).toBe('active');
});

test('BILL-127 replays: the same id, and the same body under a new id', async ({ clientIp }) => {
  const { checkout } = await created(clientIp, 'bill-127');
  const sent = await sendEvent('subscription.activated', checkout.subscriptionId, activation(checkout));
  expect(sent.body).toStrictEqual(RECEIVED);
  const snapshot = async () =>
    (await query(`SELECT to_jsonb(s)::text AS row FROM billing_subscriptions s WHERE provider_subscription_id = $1`, [checkout.subscriptionId]))[0];
  const before = await snapshot();

  const again = await postWebhook(sent.rawBody, { eventId: sent.eventId });
  expect(again.status).toBe(200);
  expect(again.body).toStrictEqual(REPLAY);

  const otherId = `evt_e2e${randomBytes(6).toString('hex')}`;
  const renamed = await postWebhook(sent.rawBody, { eventId: otherId });
  expect(renamed.status).toBe(200);
  expect(renamed.body).toStrictEqual(REPLAY);

  expect(await billingEvent(otherId)).toBeUndefined();
  expect(await billingEventsWithBody(sent.rawBody)).toHaveLength(1);
  expect((await billingEvent(sent.eventId))?.attempts).toBe(1);
  expect(await snapshot()).toEqual(before);
});

test('BILL-128 a bad or missing signature, body or event id is refused', async ({ clientIp }) => {
  const { checkout } = await created(clientIp, 'bill-128');
  const entity = await (await fetch(`${process.env.E2E_RAZORPAY_MOCK_URL}/__mock/subscriptions/${checkout.subscriptionId}`)).json();
  Object.assign(entity, activation(checkout));
  const bodyFor = (n: string) =>
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_e2eMockOnly01',
      event: 'subscription.activated',
      contains: ['subscription'],
      payload: { subscription: { entity } },
      created_at: nowSeconds(),
      e2e_case: n,
    });
  const hmac = (raw: string) => createHmac('sha256', runSecrets().razorpayWebhookSecret).update(raw).digest('hex');

  const refusals: Array<[string, string, { eventId?: string | null; signature?: string | null }]> = [];
  const b1 = bodyFor('no signature');
  refusals.push(['no signature', b1, { signature: null }]);
  const b2 = bodyFor('signature of another body');
  refusals.push(['signature of another body', b2, { signature: hmac(bodyFor('something else')) }]);
  const b3 = bodyFor('63 hex');
  refusals.push(['63 hex characters', b3, { signature: hmac(b3).slice(0, 63) }]);
  const b4 = bodyFor('64 non-hex');
  refusals.push(['64 non-hex characters', b4, { signature: 'z'.repeat(64) }]);
  refusals.push(['empty body', '', { signature: hmac('') }]);
  const b5 = bodyFor('no event id');
  refusals.push(['no event id', b5, { eventId: null }]);
  const b6 = bodyFor('dash');
  refusals.push(['event id with a dash', b6, { eventId: 'evt-with-dash' }]);
  const b7 = bodyFor('65');
  refusals.push(['65-character event id', b7, { eventId: `evt_${'a'.repeat(61)}` }]);

  for (const [label, raw, options] of refusals) {
    const reply = await postWebhook(raw, options);
    expect(reply.status, label).toBe(400);
    expect(reply.body, label).toStrictEqual(REFUSED);
    if (raw) expect(await billingEventsWithBody(raw), label).toHaveLength(0);
    if (reply.eventId) expect(await billingEvent(reply.eventId), label).toBeUndefined();
  }
  expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('created');

  // Hex is case-insensitive: the right HMAC in upper case is accepted.
  const upper = bodyFor('upper case');
  const accepted = await postWebhook(upper, { signature: hmac(upper).toUpperCase() });
  expect(accepted.status).toBe(200);
  expect(accepted.body).toStrictEqual(RECEIVED);
  expect((await billingEvent(accepted.eventId!))?.outcome).toBe('applied');
  expect((await subscriptionRow(checkout.subscriptionId)).status).toBe('active');
});

test('BILL-129 a terminal status never revives, and older events do not overwrite newer', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-129', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const T = nowSeconds();

  const cancelled = await sendEvent('subscription.cancelled', active.checkout.subscriptionId, { status: 'cancelled', ended_at: T + 10 }, { createdAt: T + 10 });
  expect(cancelled.body).toStrictEqual(RECEIVED);
  expect((await subscriptionRow(active.checkout.subscriptionId)).status).toBe('cancelled');

  const revived = await sendEvent('subscription.activated', active.checkout.subscriptionId, { status: 'active', ended_at: null }, { createdAt: T + 20 });
  expect(revived.status).toBe(200);
  expect((await billingEvent(revived.eventId))?.outcome).toBe('applied');
  expect((await subscriptionRow(active.checkout.subscriptionId)).status).toBe('cancelled');
  expect((await overview(tenant, clientIp)).state).toBe('free');

  // Another active subscription: a newer pending, then an older charge saying active.
  const otherIp = newClientIp();
  const other = await createAccount(otherIp, 'bill-129-b', 'Dev Customer');
  const second = await activeOn(other, otherIp, G);
  const S = nowSeconds();
  expect((await sendEvent('subscription.pending', second.checkout.subscriptionId, { status: 'pending' }, { createdAt: S + 30 })).status).toBe(200);
  expect((await subscriptionRow(second.checkout.subscriptionId)).status).toBe('pending');
  const older = await sendEvent('subscription.charged', second.checkout.subscriptionId, { status: 'active' }, { createdAt: S + 29 });
  expect(older.status).toBe(200);
  expect((await subscriptionRow(second.checkout.subscriptionId)).status).toBe('pending');
  expect((await overview(other, otherIp)).state).toBe('past_due');
});

/** Every key Razorpay's payment entity may keep once stored (independent of the API's list). */
const KEPT_PAYMENT_KEYS = new Set([
  'id', 'amount', 'currency', 'status', 'method', 'invoice_id', 'order_id', 'customer_id', 'amount_refunded',
  'refund_status', 'captured', 'international', 'error_code', 'error_reason', 'error_source', 'error_step',
  'error_description', 'created_at',
]);

test('BILL-134 the stored payload keeps only allow-listed fields', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-134', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const email = `payer-${randomBytes(4).toString('hex')}@e2e.example.test`;
  const contact = `+9190${randomBytes(4).readUInt32BE(0).toString().padStart(8, '0').slice(0, 8)}`;
  const payment = paymentEntity({ amount: 49_900, status: 'failed', customerId: active.checkout.customerId, email, contact, method: 'upi' });
  const sent = await sendEntities('payment.failed', { payment });
  expect(sent.body).toStrictEqual(RECEIVED);

  const row = await billingEvent(sent.eventId);
  expect(row?.outcome).toBe('applied');
  const stored = row!.payload;
  expect(Object.keys(stored).sort()).toEqual(['account_id', 'contains', 'created_at', 'event', 'payload']);
  expect(Object.keys(stored.payload)).toEqual(['payment']);
  const keys = Object.keys(stored.payload.payment.entity);
  expect(keys.length).toBeGreaterThan(5);
  for (const key of keys) expect(KEPT_PAYMENT_KEYS.has(key), key).toBe(true);
  const storedText = JSON.stringify(stored);
  for (const value of [email, contact, 'bela.buyer@okhdfc', 'HDFC', '1 Test Street', 'Bela Buyer', 'card_E2eCard0000001', '1111']) {
    expect(storedText.includes(value), value).toBe(false);
  }

  const [paid] = await query<{ status: string; failure_reason: string; method: string; row: string }>(
    `SELECT status, failure_reason, method, to_jsonb(p)::text AS row FROM billing_payments p WHERE provider_payment_id = $1`,
    [payment.id],
  );
  expect(paid).toMatchObject({ status: 'failed', failure_reason: 'payment_failed', method: 'upi' });
  for (const value of [email, contact, 'bela.buyer@okhdfc', 'HDFC', 'card_E2eCard0000001']) {
    expect(paid.row.includes(value), value).toBe(false);
  }
});

test('BILL-137 a charge on a superseded subscription is an orphan', async ({ clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-137', 'Cara Customer');
  await saveDetails(tenant, clientIp);
  const first = await subscribe(tenant, clientIp, G.code);
  const second = await subscribe(tenant, clientIp, G.code);
  const s1 = await subscriptionRow(first.subscriptionId);
  const s2 = await subscriptionRow(second.subscriptionId);
  expect(s1.superseded_by).toBe(s2.id);
  expect(s1.was_current).toBe(false);

  const start = nowSeconds();
  const payment = paymentEntity({ amount: 49_900, status: 'captured', customerId: first.customerId, method: 'card' });
  const charged = await sendEvent('subscription.charged', first.subscriptionId, activation(first, start), { payment });
  expect(charged.body).toStrictEqual(RECEIVED);
  expect(await billingEvent(charged.eventId)).toMatchObject({ outcome: 'applied', detail: 'superseded' });

  const account = await billingAccountRow(tenant.userId);
  expect(account.current_subscription_id).toBeNull();
  expect(account.next_subscription_id).toBe(s2.id);
  expect((await overview(tenant, clientIp)).state).toBe('checkout');

  const token = await freshStaff();
  const summary = await adminApi<{ recentPayments: Array<{ tenantId: string; orphan: boolean; amountPaise: number }> }>(
    'GET',
    '/api/admin/billing/summary',
    undefined,
    token,
    staffIp,
  );
  expect(summary.recentPayments.filter((p) => p.tenantId === tenant.userId)).toEqual([
    expect.objectContaining({ orphan: true, amountPaise: 49_900 }),
  ]);

  await staffPage.goto(adminUrl('/billing'));
  const recent = adminCard(staffPage, 'Recent payments');
  const row = recent.getByRole('row').filter({ hasText: tenant.email });
  const badge = row.getByText('Orphan charge', { exact: true });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute(
    'title',
    "Charged on a subscription replaced before it was ever the account's own. Refund it in Razorpay.",
  );

  await openTenant(tenant);
  const payments = tenantBillingCard(staffPage).getByRole('row').filter({ hasText: '₹499.00' }).filter({ hasText: 'captured' });
  await expect(payments.getByText('Orphan charge', { exact: true })).toBeVisible();
});

// ------------------------------------------------------------------ J. worker jobs

test('BILL-142 the outbox sends queued cancels within a minute', async ({ clientIp }) => {
  test.setTimeout(200_000);
  // A cycle-end cancel queued by an authorised change...
  const tenant = await createAccount(clientIp, 'bill-142', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await authenticate(await changePlan(tenant, clientIp, P.code));
  const queued = await subscriptionRow(active.checkout.subscriptionId);
  expect(queued.cancel_requested_at).not.toBeNull();
  expect(queued.cancel_at_cycle_end).toBe(true);
  // ...and an immediate one, for a Checkout replaced by a second one.
  const otherIp = newClientIp();
  const other = await createAccount(otherIp, 'bill-142-b', 'Dev Customer');
  await saveDetails(other, otherIp);
  const replaced = await subscribe(other, otherIp, G.code);
  await subscribe(other, otherIp, G.code);
  const queuedNow = await subscriptionRow(replaced.subscriptionId);
  expect(queuedNow.cancel_requested_at).not.toBeNull();
  expect(queuedNow.cancel_at_cycle_end).toBe(false);

  expect((await waitForCancelCall(active.checkout.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: true });
  expect((await waitForCancelCall(replaced.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: false });
  // Give a second run the chance to send again: it must not.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(await cancelCalls(active.checkout.subscriptionId)).toHaveLength(1);
  expect(await cancelCalls(replaced.subscriptionId)).toHaveLength(1);

  const outbox = async (id: string) =>
    (
      await query<{ cancel_sent_at: Date | null; cancel_attempts: number; cancel_error: string | null; cancel_at_period_end: boolean }>(
        `SELECT cancel_sent_at, cancel_attempts, cancel_error, cancel_at_period_end FROM billing_subscriptions WHERE provider_subscription_id = $1`,
        [id],
      )
    )[0];
  await expect.poll(async () => (await outbox(active.checkout.subscriptionId)).cancel_sent_at).not.toBeNull();
  expect(await outbox(active.checkout.subscriptionId)).toMatchObject({ cancel_attempts: 1, cancel_error: null, cancel_at_period_end: true });
  await expect.poll(async () => (await outbox(replaced.subscriptionId)).cancel_sent_at).not.toBeNull();
  expect(await outbox(replaced.subscriptionId)).toMatchObject({ cancel_attempts: 1, cancel_error: null, cancel_at_period_end: false });
});

// ------------------------------------------------------------------ K. admin summary

test('BILL-149 MRR and ARR come from paying subscriptions', async ({ clientIp }) => {
  test.setTimeout(150_000);
  const token = await freshStaff();
  const G9 = await createPlan(token, staffIp, { label: 'Growth MRR', sortOrder: 11, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, monthly: 49_900 });
  const P9 = await createPlan(token, staffIp, {
    label: 'Pro MRR',
    sortOrder: 21,
    mauLimit: 50_000,
    projectLimit: null,
    seatLimit: null,
    monthly: 149_900,
    yearly: 1_499_000,
  });
  const tenantOn = async (label: string) => {
    const ip = newClientIp();
    return { ip, account: await createAccount(ip, `bill-149-${label}`, `Tenant ${label.toUpperCase()}`) };
  };
  const a = await tenantOn('a');
  await activeOn(a.account, a.ip, G9);
  const b = await tenantOn('b');
  await saveDetails(b.account, b.ip);
  await activate(await subscribe(b.account, b.ip, P9.code, 'yearly'));
  const c = await tenantOn('c');
  const cActive = await activeOn(c.account, c.ip, G9);
  await sendSubscriptionEvent('subscription.pending', cActive.checkout.subscriptionId, { status: 'pending' });
  const d = await tenantOn('d');
  await halt(await activeOn(d.account, d.ip, G9));
  const e = await tenantOn('e');
  await compTenant(token, staffIp, e.account.userId, G9.code);
  const f = await tenantOn('f');
  await compTenant(token, staffIp, f.account.userId, P9.code);
  await activeOn(f.account, f.ip, G9);
  expect((await overview(c.account, c.ip)).state).toBe('past_due');
  expect((await overview(d.account, d.ip)).state).toBe('halted');
  expect((await overview(f.account, f.ip)).state).toBe('comped');

  type Summary = {
    mrr: { netPaise: number };
    arr: { netPaise: number };
    byPlan: Array<{ planCode: string; accounts: number; mrrNetPaise: number }>;
  };
  const summary = await adminApi<Summary>('GET', '/api/admin/billing/summary', undefined, token, staffIp);
  // A (monthly), C (pending, still charging) and F (comped and paying); not D (halted) or E (comp only).
  const g = summary.byPlan.findIndex((row) => row.planCode === G9.code);
  const p = summary.byPlan.findIndex((row) => row.planCode === P9.code);
  expect(summary.byPlan[g]).toMatchObject({ accounts: 3, mrrNetPaise: 149_700 });
  // B yearly: 14,990.00 a year, 1,249.16 a month, rounded down.
  expect(summary.byPlan[p]).toMatchObject({ accounts: 1, mrrNetPaise: 124_916 });
  expect(g).toBeLessThan(p);
  expect(summary.mrr.netPaise).toBe(Math.floor(summary.arr.netPaise / 12));

  // ARR is every paying current subscription's price as a yearly amount (other specs may
  // add some meanwhile, so the read is retried until two summaries agree around it).
  let checked = false;
  for (let attempt = 0; attempt < 5 && !checked; attempt += 1) {
    const before = await adminApi<Summary>('GET', '/api/admin/billing/summary', undefined, token, staffIp);
    const [{ arr }] = await query<{ arr: string }>(
      `SELECT COALESCE(SUM(CASE WHEN pp.interval = 'monthly' THEN pp.price_paise * 12 ELSE pp.price_paise END), 0)::text AS arr
         FROM billing_accounts ba
         JOIN billing_subscriptions cur ON cur.id = ba.current_subscription_id
         JOIN plan_prices pp ON pp.id = cur.price_id
        WHERE cur.status IN ('active', 'pending')`,
    );
    const after = await adminApi<Summary>('GET', '/api/admin/billing/summary', undefined, token, staffIp);
    if (before.arr.netPaise !== after.arr.netPaise) continue;
    expect(after.arr.netPaise).toBe(Number(arr));
    checked = true;
  }
  expect(checked).toBe(true);

  await staffPage.goto(adminUrl('/billing'));
  const shown = staffPage.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/billing/summary' && r.ok());
  await staffPage.reload();
  const page = ((await (await shown).json()) as { data: Summary }).data;
  await expect(adminCard(staffPage, 'MRR').getByText(rupees(page.mrr.netPaise), { exact: true })).toBeVisible();
  await expect(adminCard(staffPage, 'ARR').getByText(rupees(page.arr.netPaise), { exact: true })).toBeVisible();
  const byPlan = adminCard(staffPage, 'Paying accounts by plan');
  const gRow = byPlan.getByRole('row').filter({ hasText: G9.code });
  await expect(gRow.getByRole('cell')).toHaveText([`${G9.name} ${G9.code}`, '3', '₹1,497.00']);
  const pRow = byPlan.getByRole('row').filter({ hasText: P9.code });
  await expect(pRow.getByRole('cell')).toHaveText([`${P9.name} ${P9.code}`, '1', '₹1,249.16']);
});

// ------------------------------------------------------------------ L. plans page

test('BILL-162 create a plan', async ({ clientIp }) => {
  await freshStaff();
  const code = `e2e_team_${randomBytes(3).toString('hex')}`;
  await staffPage.goto(adminUrl('/plans'));
  await staffPage.getByRole('button', { name: 'New plan' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'New plan' });
  await expect(
    dialog.getByText("Limits apply to accounts on this plan while billing is on. Blank means no limit (projects: the server's default).", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByLabel('Code').fill(code);
  await dialog.getByLabel('Name').fill('E2E Team');
  await dialog.getByLabel('Monthly active devices').fill('25,000');
  await dialog.getByLabel('Projects').fill('15');
  await dialog.getByLabel('Team members').fill('5');
  await dialog.getByLabel('Order').fill('30');
  await dialog.getByLabel('Reason').fill('New team tier');
  await expect(dialog.getByText('13/500 characters, at least 3. Recorded in the audit log.', { exact: true })).toBeVisible();

  // Held a moment, so the busy label can be seen.
  await staffPage.route(
    (url) => url.pathname === '/api/admin/plans',
    async (route) => {
      if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    },
  );
  const request = nextBody(staffPage, '/api/admin/plans');
  await dialog.getByRole('button', { name: 'Create plan' }).click();
  expect((await request).postDataJSON()).toStrictEqual({
    code,
    name: 'E2E Team',
    mauLimit: 25_000,
    projectLimit: 15,
    seatLimit: 5,
    sortOrder: 30,
    reason: 'New team tier',
  });
  await expect(dialog.getByRole('button', { name: 'Working...' })).toBeDisabled();
  await expect(adminToast(staffPage, `Plan ${code} created`)).toBeVisible();
  await expect(dialog).toBeHidden();
  await staffPage.unroute((url) => url.pathname === '/api/admin/plans');
  await expect(adminPlanCard(staffPage, code).locator('[data-slot="card-description"]')).toHaveText(
    '25,000 monthly active devices · 15 projects · 5 team members · order 30',
  );

  const [audit] = await auditRows('billing.plan_created', { targetLabel: code });
  expect(audit).toMatchObject({
    target_type: 'plan',
    target_label: code,
    reason: 'New team tier',
    actor_id: staff.userId,
    metadata: { code, limits: { mauLimit: 25_000, projectLimit: 15, seatLimit: 5 }, sortOrder: 30 },
  });
  // Not offered to customers until it has a price.
  const tenant = await createAccount(clientIp, 'bill-162', 'Cara Customer');
  expect((await overview(tenant, clientIp)).plans.map((plan) => plan.code)).not.toContain(code);
});

test('BILL-167 stop offering a plan', async ({ page, clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, staffIp, { label: 'Sunset', sortOrder: 12, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, monthly: 49_900 });
  const subscriberIp = newClientIp();
  const subscriber = await createAccount(subscriberIp, 'bill-167-d', 'Dev Subscriber');
  await activeOn(subscriber, subscriberIp, plan);
  const tenant = await createAccount(clientIp, 'bill-167', 'Cara Customer');
  expect((await overview(tenant, clientIp)).plans.map((p) => p.code)).toContain(plan.code);

  await staffPage.goto(adminUrl('/plans'));
  const card = adminPlanCard(staffPage, plan.code);
  await card.getByRole('button', { name: 'Edit' }).click();
  const dialog = staffPage.getByRole('dialog', { name: `Edit ${plan.name}` });
  const offered = dialog.getByRole('checkbox', { name: 'Offered to customers' });
  await expect(offered).toBeChecked();
  await offered.uncheck();
  await dialog.getByLabel('Reason').fill('No longer sold');
  const request = nextBody(staffPage, `/api/admin/plans/${plan.code}`, 'PATCH');
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ isActive: false, reason: 'No longer sold' });
  await expect(adminToast(staffPage, `Plan ${plan.code} saved`)).toBeVisible();
  await expect(card.locator('[data-slot="card-title"] [data-slot="badge"]')).toHaveText('Not offered');

  // The customer no longer sees it and cannot buy it; staff cannot comp it.
  expect((await overview(tenant, clientIp)).plans.map((p) => p.code)).not.toContain(plan.code);
  await signIn(page, tenant);
  await openBilling(page);
  await expect(planCard(page, G.name)).toBeVisible();
  await expect(planCard(page, plan.name)).toHaveCount(0);
  await saveDetails(tenant, clientIp);
  const refused = await rawApi('POST', '/api/billing/subscribe', {
    token: tenant.accessToken,
    ip: clientIp,
    body: { plan: plan.code, interval: 'monthly' },
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toBe('That plan cannot be bought.');
  const comp = await rawAdmin('POST', `/api/admin/tenants/${tenant.userId}/billing/comp`, {
    token,
    ip: staffIp,
    body: { planCode: plan.code, reason: 'E2E: comp a plan no longer sold' },
  });
  expect(comp.status).toBe(400);
  expect(comp.body.message).toBe('That plan does not exist.');

  // The subscriber keeps it.
  const kept = await overview(subscriber, subscriberIp);
  expect(kept.state).toBe('active');
  expect(kept.effectivePlan.code).toBe(plan.code);
  expect(kept.usage.projects.limit).toBe(20);

  // Offered again, it is back.
  await adminApi('PATCH', `/api/admin/plans/${plan.code}`, { isActive: true, reason: 'E2E: offered again' }, token, staffIp);
  expect((await overview(tenant, clientIp)).plans.map((p) => p.code)).toContain(plan.code);
});

test('BILL-170 add a monthly price', async ({ page, clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, staffIp, { label: 'Launch', sortOrder: 13, mauLimit: 5_000, projectLimit: 5, seatLimit: 5 });
  const razorpayPlanId = await registerMockPlan('monthly', 99_900);
  const tenant = await createAccount(clientIp, 'bill-170', 'Cara Customer');
  expect((await overview(tenant, clientIp)).plans.map((p) => p.code)).not.toContain(plan.code);

  await staffPage.goto(adminUrl('/plans'));
  const card = adminPlanCard(staffPage, plan.code);
  await expect(card.getByText('No monthly price yet.', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Add price' }).first().click();
  const dialog = staffPage.getByRole('dialog', { name: `Monthly price for ${plan.name}` });
  await expect(
    dialog.getByText(
      'The new price replaces the current one for new subscriptions. Accounts already subscribed keep the price they signed up at.',
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByLabel('Price a month (₹)').fill('999');
  await expect(dialog.locator('[aria-live="polite"]')).toHaveText(
    'Razorpay plan must charge exactly ₹999.00 every 1 month, the price itself, with no tax added, in INR. Create it in Razorpay first, then paste its id.',
  );
  await dialog.getByLabel('Razorpay plan id').fill(razorpayPlanId);
  await expect(dialog.getByText('Checked against Razorpay: amount, currency and period must match.', { exact: true })).toBeVisible();
  await dialog.getByLabel('Reason').fill('Launch price');
  const request = nextBody(staffPage, `/api/admin/plans/${plan.code}/prices`);
  await dialog.getByRole('button', { name: 'Add price' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ interval: 'monthly', pricePaise: 99_900, razorpayPlanId, reason: 'Launch price' });
  await expect(adminToast(staffPage, `Monthly price added to ${plan.name}`)).toBeVisible();
  await expect(dialog).toBeHidden();

  const row = card.getByRole('row').filter({ hasText: razorpayPlanId });
  await expect(row.getByRole('cell')).toHaveText(['₹999.00 Current', razorpayPlanId, '0', new Date().toLocaleDateString('en-GB', { timeZone: 'UTC' }), 'Retire']);
  expect((await mockCalls()).some((c) => c.method === 'GET' && c.path === `/v1/plans/${razorpayPlanId}`)).toBe(true);
  const [audit] = await auditRows('billing.price_added', { targetLabel: plan.code });
  expect(audit.metadata).toStrictEqual({
    planCode: plan.code,
    interval: 'monthly',
    pricePaise: 99_900,
    amountPaise: 99_900,
    taxRateBps: 0,
    razorpayPlanId,
    replacedPriceId: null,
  });
  expect(audit.reason).toBe('Launch price');

  // Customers now see it with that price.
  const offered = (await overview(tenant, clientIp)).plans.find((p) => p.code === plan.code);
  expect(offered?.monthly).toMatchObject({ pricePaise: 99_900, amountPaise: 99_900, taxPaise: 0 });
  await signIn(page, tenant);
  await openBilling(page);
  await expect(planCard(page, plan.name).getByText('₹999.00 / month', { exact: true })).toBeVisible();
});

test('BILL-172 Razorpay plan id format and mismatch refusals', async ({ clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, staffIp, { label: 'Checked', sortOrder: 14, mauLimit: 5_000, projectLimit: 5, seatLimit: 5 });
  const planA = await registerMockPlan('monthly', 99_900);
  const unknown = `plan_${randomBytes(7).toString('hex')}`;

  await staffPage.goto(adminUrl('/plans'));
  const card = adminPlanCard(staffPage, plan.code);
  await card.getByRole('button', { name: 'Add price' }).first().click();
  const monthly = staffPage.getByRole('dialog', { name: `Monthly price for ${plan.name}` });
  const submit = monthly.getByRole('button', { name: 'Add price' });
  await monthly.getByLabel('Price a month (₹)').fill('999');
  await monthly.getByLabel('Reason').fill('Checking ids');
  // 1: not plan_ and 14 letters or digits.
  await monthly.getByLabel('Razorpay plan id').fill('plan_short');
  await expect(submit).toBeDisabled();
  // 2: the amount differs.
  await monthly.getByLabel('Price a month (₹)').fill('1,000.00');
  await monthly.getByLabel('Razorpay plan id').fill(planA);
  await submit.click();
  await expect(monthly.getByRole('alert')).toHaveText('That Razorpay plan charges ₹999.00 every 1 month, not ₹1,000.00 a month.');
  // 4: an id Razorpay does not know.
  await monthly.getByLabel('Price a month (₹)').fill('999');
  await monthly.getByLabel('Razorpay plan id').fill(unknown);
  await submit.click();
  await expect(monthly.getByRole('alert')).toHaveText('Razorpay has no plan with that id.');
  // 5: an id that already backs a price.
  await monthly.getByLabel('Razorpay plan id').fill(G.prices.monthly!.razorpayPlanId);
  await submit.click();
  await expect(monthly.getByRole('alert')).toHaveText('That Razorpay plan already backs a price.');
  await expect(monthly).toBeVisible();
  await monthly.getByRole('button', { name: 'Cancel' }).click();

  // 3: a monthly Razorpay plan behind a yearly price.
  await card.getByRole('button', { name: 'Add price' }).nth(1).click();
  const yearly = staffPage.getByRole('dialog', { name: `Yearly price for ${plan.name}` });
  await yearly.getByLabel('Price a year (₹)').fill('999');
  await yearly.getByLabel('Razorpay plan id').fill(planA);
  await yearly.getByLabel('Reason').fill('Checking ids');
  await yearly.getByRole('button', { name: 'Add price' }).click();
  await expect(yearly.getByRole('alert')).toHaveText('That Razorpay plan charges ₹999.00 every 1 month, not ₹999.00 a year.');
  await yearly.getByRole('button', { name: 'Cancel' }).click();

  // The API says the same, and the id format in its own words.
  const add = (body: Record<string, unknown>) =>
    rawAdmin('POST', `/api/admin/plans/${plan.code}/prices`, { token, ip: staffIp, body: { interval: 'monthly', pricePaise: 99_900, reason: 'E2E', ...body } });
  const badId = await add({ razorpayPlanId: 'plan_x' });
  expect(badId.status).toBe(400);
  expect(badId.body.message).toContain('razorpayPlanId must be a Razorpay plan id (plan_ and 14 letters or digits)');
  const used = await add({ razorpayPlanId: G.prices.monthly!.razorpayPlanId });
  expect(used.status).toBe(409);
  expect(used.body.message).toBe('That Razorpay plan already backs a price.');

  // Nothing was stored.
  expect(await query(`SELECT 1 FROM plan_prices WHERE plan_code = $1`, [plan.code])).toHaveLength(0);
  expect(await auditRows('billing.price_added', { targetLabel: plan.code })).toHaveLength(0);
  void clientIp;
});

test('BILL-174 a new price replaces the current one; subscribers keep theirs', async ({ clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, staffIp, { label: 'Reprice', sortOrder: 15, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, monthly: 49_900 });
  const oldPrice = plan.prices.monthly!;
  const subscriberIp = newClientIp();
  const subscriber = await createAccount(subscriberIp, 'bill-174-d', 'Dev Subscriber');
  const active = await activeOn(subscriber, subscriberIp, plan);
  const newPlanId = await registerMockPlan('monthly', 59_900);

  await staffPage.goto(adminUrl('/plans'));
  const card = adminPlanCard(staffPage, plan.code);
  await card.getByRole('button', { name: 'Add price' }).first().click();
  const dialog = staffPage.getByRole('dialog', { name: `Monthly price for ${plan.name}` });
  await dialog.getByLabel('Price a month (₹)').fill('599');
  await dialog.getByLabel('Razorpay plan id').fill(newPlanId);
  await dialog.getByLabel('Reason').fill('New price');
  await dialog.getByRole('button', { name: 'Add price' }).click();
  await expect(adminToast(staffPage, `Monthly price added to ${plan.name}`)).toBeVisible();

  const rows = card.getByRole('row').filter({ has: staffPage.getByRole('cell') });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole('cell').nth(0)).toHaveText('₹599.00 Current');
  await expect(rows.nth(0).getByRole('cell').nth(2)).toHaveText('0');
  await expect(rows.nth(1).getByRole('cell').nth(0)).toHaveText('₹499.00 Earlier');
  await expect(rows.nth(1).getByRole('cell').nth(1)).toHaveText(oldPrice.razorpayPlanId);
  await expect(rows.nth(1).getByRole('cell').nth(2)).toHaveText('1');
  await expect(rows.nth(1).getByRole('button', { name: 'Retire' })).toHaveCount(0);
  const [audit] = await auditRows('billing.price_added', { targetLabel: plan.code }).then((r) => r.slice(-1));
  expect(audit.metadata).toMatchObject({ pricePaise: 59_900, razorpayPlanId: newPlanId, replacedPriceId: oldPrice.id });

  // A new customer sees the new price; the subscriber keeps the old one.
  const tenant = await createAccount(clientIp, 'bill-174', 'Cara Customer');
  expect((await overview(tenant, clientIp)).plans.find((p) => p.code === plan.code)?.monthly?.pricePaise).toBe(59_900);
  const kept = await overview(subscriber, subscriberIp);
  expect(kept.current).toMatchObject({ planCode: plan.code, amountPaise: 49_900 });

  // Its webhooks still resolve through the old Razorpay plan.
  const renewedEnd = active.periodEnd + 30 * DAY_SECONDS;
  const charged = await sendEvent(
    'subscription.charged',
    active.checkout.subscriptionId,
    { status: 'active', current_start: active.periodEnd, current_end: renewedEnd, charge_at: renewedEnd, paid_count: 2 },
    { createdAt: nowSeconds() + 5 },
  );
  expect(charged.body).toStrictEqual(RECEIVED);
  expect(await billingEvent(charged.eventId)).toMatchObject({ outcome: 'applied', detail: null });
  expect((await overview(subscriber, subscriberIp)).current?.currentPeriodEnd).toBe(new Date(renewedEnd * 1000).toISOString());
});

test('BILL-176 retire a price', async ({ clientIp }) => {
  const token = await freshStaff();
  const plan = await createPlan(token, staffIp, { label: 'Withdraw', sortOrder: 16, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, monthly: 49_900 });
  const price = plan.prices.monthly!;
  const subscriberIp = newClientIp();
  const subscriber = await createAccount(subscriberIp, 'bill-176-d', 'Dev Subscriber');
  await activeOn(subscriber, subscriberIp, plan);

  await staffPage.goto(adminUrl('/plans'));
  const card = adminPlanCard(staffPage, plan.code);
  const row = card.getByRole('row').filter({ hasText: price.razorpayPlanId });
  await row.getByRole('button', { name: 'Retire' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Retire this price' });
  await expect(
    dialog.getByText(
      'New customers can no longer subscribe at ₹499.00. The 1 accounts on it keep it. Without a current price this interval cannot be bought.',
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByLabel('Reason').fill('Retiring');
  await dialog.getByRole('button', { name: 'Retire price' }).click();
  await expect(adminToast(staffPage, 'Price retired')).toBeVisible();
  await expect(row.getByRole('cell').first()).toHaveText('₹499.00 Earlier');
  await expect(row.getByRole('button', { name: 'Retire' })).toHaveCount(0);
  const [audit] = await auditRows('billing.price_retired', { targetLabel: plan.code });
  expect(audit).toMatchObject({ reason: 'Retiring', metadata: { planCode: plan.code, priceId: price.id } });

  // With no other price the plan is not offered, and cannot be bought.
  const tenant = await createAccount(clientIp, 'bill-176', 'Cara Customer');
  expect((await overview(tenant, clientIp)).plans.map((p) => p.code)).not.toContain(plan.code);
  await saveDetails(tenant, clientIp);
  const refused = await rawApi('POST', '/api/billing/subscribe', { token: tenant.accessToken, ip: clientIp, body: { plan: plan.code, interval: 'monthly' } });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toBe('That plan cannot be bought.');
  // The subscriber is unaffected.
  expect(await overview(subscriber, subscriberIp)).toMatchObject({ state: 'active', effectivePlan: { code: plan.code } });

  const retire = (code: string, id: string) =>
    rawAdmin('POST', `/api/admin/plans/${code}/prices/${id}/retire`, { token, ip: staffIp, body: { reason: 'E2E retire' } });
  const again = await retire(plan.code, price.id);
  expect([again.status, again.body.message]).toEqual([409, 'That price is not current.']);
  const missing = await retire(plan.code, randomUUID());
  expect([missing.status, missing.body.message]).toEqual([404, 'Price not found']);
  const malformed = await retire(plan.code, 'abc');
  expect([malformed.status, malformed.body.message]).toEqual([400, 'Validation failed (uuid is expected)']);
  const elsewhere = await retire(P.code, price.id);
  expect([elsewhere.status, elsewhere.body.message]).toEqual([404, 'Price not found']);
  expect(await auditRows('billing.price_retired', { targetLabel: plan.code })).toHaveLength(1);
});

// ------------------------------------------------------------------ M. tenant Billing card

test('BILL-179 comp a plan with an end date', async ({ page, clientIp }) => {
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-179', 'Cara Customer');
  const day = new Date(Date.now() + 30 * DAY_SECONDS * 1000).toISOString().slice(0, 10);
  const until = `${day}T23:59:59.000Z`;

  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await expect(fact(card, 'State')).toHaveText('No paid plan');
  await card.getByRole('button', { name: 'Comp a plan' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Give a complimentary plan' });
  await expect(
    dialog.getByText("The account gets the plan's limits with no payment, until the end date or until you end it.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('At the end of that day, your time. Within five years.', { exact: true })).toBeVisible();
  await dialog.getByLabel('Plan').click();
  await expect(staffPage.getByRole('option', { name: G.name, exact: true })).toBeVisible();
  await expect(staffPage.getByRole('option', { name: 'Free', exact: true })).toHaveCount(0);
  await expect(staffPage.getByRole('option', { name: inactive.name, exact: true })).toHaveCount(0);
  await staffPage.getByRole('option', { name: G.name, exact: true }).click();
  await dialog.getByLabel('Ends on (optional)').fill(day);
  await dialog.getByLabel('Reason').fill('Pilot customer, 30 days');
  const request = nextBody(staffPage, `/api/admin/tenants/${tenant.userId}/billing/comp`);
  await dialog.getByRole('button', { name: 'Give plan' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ planCode: G.code, reason: 'Pilot customer, 30 days', until });
  await expect(adminToast(staffPage, 'Complimentary plan given')).toBeVisible();

  await expect(card.getByText(`Complimentary ${G.code}, until ${gbDate(until)}`, { exact: true })).toBeVisible();
  await expect(card.getByText(`Given ${gbDate(new Date())} by ${staff.email}: Pilot customer, 30 days`, { exact: true })).toBeVisible();
  await expect(fact(card, 'State')).toHaveText('Complimentary');
  await expect(fact(card, 'Plan')).toHaveText(G.name);
  await expect(card.getByRole('button', { name: 'End comp' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Comp a plan' })).toHaveCount(0);
  const [audit] = await auditRows('billing.comp_granted', { targetId: tenant.userId });
  expect(audit).toMatchObject({ reason: 'Pilot customer, 30 days', metadata: { planCode: G.code, until } });

  const o = await overview(tenant, clientIp);
  expect(o).toMatchObject({ state: 'comped', effectivePlan: { code: G.code, source: 'comp', until }, comp: { planCode: G.code, until } });
  await signIn(page, tenant);
  await openBilling(page);
  const state = stateCard(page);
  await expect(state.locator('[data-slot="card-title"]')).toHaveText(G.name);
  await expect(state.getByText(`Complimentary until ${longDate(until)}.`, { exact: true })).toBeVisible();
  await expect(state.getByText('Projects: 0 of 20', { exact: true })).toBeVisible();
});

test('BILL-183 staff cancel at the period end', async ({ clientIp }) => {
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-183', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);

  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await expect(fact(card, 'State')).toHaveText('Active');
  await card.getByRole('button', { name: 'Cancel subscription' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Cancel the subscription' });
  await expect(dialog.getByText(/^Cancels it at Razorpay/)).toHaveText(
    `Cancels it at Razorpay. At the period end, the account keeps its plan until ${gbDate(active.periodEnd)}. Now, it moves to the free plan when Razorpay confirms. Refunds are made in Razorpay.`,
  );
  await expect(dialog.getByLabel('When')).toHaveText('At the period end');
  await dialog.getByLabel('Reason').fill('Customer asked by email');
  const request = nextBody(staffPage, `/api/admin/tenants/${tenant.userId}/billing/cancel`);
  await dialog.getByRole('button', { name: 'Cancel subscription' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ atCycleEnd: true, reason: 'Customer asked by email' });
  await expect(adminToast(staffPage, 'Subscription cancelled at Razorpay')).toBeVisible();

  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: true }]);
  await expect(fact(card, 'Ends')).toContainText(gbDate(active.periodEnd));
  await expect(fact(card, 'State')).toHaveText('Ends at the period end');
  await expect(card.getByRole('row').filter({ hasText: active.checkout.subscriptionId }).getByText('Ends at period end', { exact: true })).toBeVisible();
  const row = await subscriptionRow(active.checkout.subscriptionId);
  expect(row.cancel_requested_by).toBe(staff.userId);
  expect(row.cancel_at_period_end).toBe(true);
  const [audit] = await auditRows('billing.subscription_cancelled', { targetId: tenant.userId });
  expect(audit).toMatchObject({ reason: 'Customer asked by email', metadata: { subscriptionId: row.id, atCycleEnd: true } });
  expect((await overview(tenant, clientIp)).effectivePlan.code).toBe(G.code);
});

test('BILL-184 staff cancel now', async ({ page, clientIp }) => {
  await freshStaff();
  const tenant = await createAccount(clientIp, 'bill-184', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  // A change whose Checkout was opened and never finished: it goes with the cancel.
  const successor = await changePlan(tenant, clientIp, P.code);
  const otherIp = newClientIp();
  const other = await createAccount(otherIp, 'bill-184-b', 'Dev Customer');
  const otherActive = await activeOn(other, otherIp, G);
  await cancelPlan(other, otherIp);

  await openTenant(tenant);
  const card = tenantBillingCard(staffPage);
  await card.getByRole('button', { name: 'Cancel subscription' }).click();
  const dialog = staffPage.getByRole('dialog', { name: 'Cancel the subscription' });
  await dialog.getByLabel('When').click();
  await expect(staffPage.getByRole('option')).toHaveText(['At the period end', 'Now']);
  await staffPage.getByRole('option', { name: 'Now' }).click();
  await dialog.getByLabel('Reason').fill('Customer asked to stop now');
  let request = nextBody(staffPage, `/api/admin/tenants/${tenant.userId}/billing/cancel`);
  await dialog.getByRole('button', { name: 'Cancel subscription' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ atCycleEnd: false, reason: 'Customer asked to stop now' });
  await expect(adminToast(staffPage, 'Subscription cancelled at Razorpay')).toBeVisible();
  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: false }]);
  const row = await subscriptionRow(active.checkout.subscriptionId);
  expect((await auditRows('billing.subscription_cancelled', { targetId: tenant.userId }))[0].metadata).toStrictEqual({
    subscriptionId: row.id,
    atCycleEnd: false,
  });
  // The plan stays until Razorpay says it ended; the waiting change is dropped.
  expect((await overview(tenant, clientIp)).effectivePlan.code).toBe(G.code);
  expect((await billingAccountRow(tenant.userId)).next_subscription_id).toBeNull();
  const dropped = await subscriptionRow(successor.subscriptionId);
  expect(dropped.cancel_requested_at).not.toBeNull();
  expect(dropped.cancel_at_cycle_end).toBe(false);

  // Already ending at the period end: only "Now" is offered.
  await openTenant(other);
  const otherCard = tenantBillingCard(staffPage);
  await expect(fact(otherCard, 'State')).toHaveText('Ends at the period end');
  await otherCard.getByRole('button', { name: 'Cancel subscription' }).click();
  await dialog.getByLabel('When').click();
  await expect(staffPage.getByRole('option')).toHaveText(['Now']);
  await staffPage.getByRole('option', { name: 'Now' }).click();
  await dialog.getByLabel('Reason').fill('Customer asked to stop now');
  request = nextBody(staffPage, `/api/admin/tenants/${other.userId}/billing/cancel`);
  await dialog.getByRole('button', { name: 'Cancel subscription' }).click();
  expect((await request).postDataJSON()).toStrictEqual({ atCycleEnd: false, reason: 'Customer asked to stop now' });
  await expect(adminToast(staffPage, 'Subscription cancelled at Razorpay')).toBeVisible();
  expect((await cancelCalls(otherActive.checkout.subscriptionId)).map((c) => c.body)).toEqual([
    { cancel_at_cycle_end: true },
    { cancel_at_cycle_end: false },
  ]);
  const otherRow = await subscriptionRow(otherActive.checkout.subscriptionId);
  expect((await auditRows('billing.subscription_cancelled', { targetId: other.userId }))[0].metadata).toStrictEqual({
    subscriptionId: otherRow.id,
    atCycleEnd: false,
  });

  // Razorpay confirms: both are on Free.
  for (const id of [active.checkout.subscriptionId, otherActive.checkout.subscriptionId]) {
    await sendSubscriptionEvent('subscription.cancelled', id, { status: 'cancelled', ended_at: nowSeconds() });
  }
  expect((await overview(other, otherIp)).state).toBe('free');
  await openTenant(tenant);
  await expect(fact(tenantBillingCard(staffPage), 'State')).toHaveText('No paid plan');
  await signIn(page, tenant);
  await openBilling(page);
  await expect(stateCard(page).locator('[data-slot="card-title"]')).toHaveText('Free');
});

test.describe('admin billing routes', () => {
  let off: BillingOffApi;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    off = await startBillingOffAdminApi();
  });

  test.afterAll(async () => {
    await off?.stop();
  });

  test('BILL-192 admin billing routes: guards, billing off, unknown tenant', async ({ clientIp }) => {
    const token = await freshStaff();
    const customer = await createAccount(clientIp, 'bill-192', 'Cara Customer');
    const missing = randomUUID();
    const routes = (tenantId: string): Array<[string, string, unknown, string]> => [
      ['GET', '/api/admin/billing/summary', undefined, ''],
      ['GET', `/api/admin/tenants/${tenantId}/billing`, undefined, 'Tenant not found'],
      ['POST', `/api/admin/tenants/${tenantId}/billing/comp`, { planCode: G.code, reason: 'E2E: guard check' }, 'Tenant not found'],
      ['POST', `/api/admin/tenants/${tenantId}/billing/comp/end`, { reason: 'E2E: guard check' }, 'Tenant not found'],
      ['POST', `/api/admin/tenants/${tenantId}/billing/cancel`, { atCycleEnd: true, reason: 'E2E: guard check' }, 'Tenant not found'],
      ['POST', `/api/admin/tenants/${tenantId}/billing/invoices/${randomUUID()}/resend`, { reason: 'E2E: guard check' }, 'Invoice not found'],
    ];

    for (const [method, path, body] of routes(missing)) {
      const anonymous = await rawAdmin(method, path, { ip: clientIp, body });
      expect(anonymous.status, `anonymous ${method} ${path}`).toBe(401);
      const asCustomer = await rawAdmin(method, path, { token: customer.accessToken, ip: clientIp, body });
      expect(asCustomer.status, `customer ${method} ${path}`).toBe(401);
      const billingOff = await rawAdmin(method, path, { token, ip: staffIp, body, base: off.url });
      expect(billingOff.status, `billing off ${method} ${path}`).toBe(404);
    }

    for (const [method, path, body, message] of routes(missing)) {
      const reply = await rawAdmin(method, path, { token, ip: staffIp, body });
      if (!message) {
        expect(reply.status).toBe(200);
        continue;
      }
      expect([reply.status, reply.body.message], `${method} ${path}`).toEqual([404, message]);
    }

    // Writes with a sign-in older than 15 minutes.
    const aged = agedStaffToken(token, 20 * 60);
    expect((await rawAdmin('GET', '/api/admin/billing/summary', { token: aged, ip: staffIp })).status).toBe(200);
    for (const [method, path, body] of routes(missing).filter(([m]) => m === 'POST')) {
      const reply = await rawAdmin(method, path, { token: aged, ip: staffIp, body });
      expect([reply.status, reply.body.message], path).toEqual([403, 'Confirm it is you to continue.']);
    }

    // 21 writes in a minute from one address.
    const burstIp = newClientIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      statuses.push((await rawAdmin('POST', `/api/admin/tenants/${missing}/billing/comp/end`, { token, ip: burstIp, body: { reason: 'E2E: throttle check' } })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

// ------------------------------------------------------------------ N2. recovery

test('BILL-202 recovery after a halted payment', async ({ page, clientIp }) => {
  const tenant = await createAccount(clientIp, 'bill-202', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  await halt(active);
  expect((await subscriptionRow(active.checkout.subscriptionId)).grace_until).not.toBeNull();

  const newEnd = active.periodEnd + 30 * DAY_SECONDS;
  const payment = paymentEntity({ amount: 49_900, status: 'captured', customerId: active.checkout.customerId, method: 'card' });
  const charged = await sendEvent(
    'subscription.charged',
    active.checkout.subscriptionId,
    { status: 'active', current_start: active.periodEnd, current_end: newEnd, charge_at: newEnd, paid_count: 2 },
    { createdAt: nowSeconds() + 5, payment },
  );
  expect(charged.body).toStrictEqual(RECEIVED);
  expect((await billingEvent(charged.eventId))?.outcome).toBe('applied');
  const row = await subscriptionRow(active.checkout.subscriptionId);
  expect(row.status).toBe('active');
  expect(row.grace_until).toBeNull();
  const o = await overview(tenant, clientIp);
  expect(o.state).toBe('active');
  expect(o.current?.graceUntil).toBeNull();

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  const badge = card.locator('[data-slot="badge"]');
  await expect(badge).toHaveText('Active');
  await expect(badge).toHaveAttribute('data-variant', 'secondary');
  await expect(card.getByText(`Next charge ₹499.00 on ${longDate(newEnd)}.`, { exact: true })).toBeVisible();
  await expect(card.getByText(/Your payment did not go through/)).toHaveCount(0);
  await expect(planCard(page, G.name).locator('[data-slot="badge"]')).toHaveText('Current plan');
  await expect(planCard(page, L.name).getByRole('button', { name: 'Switch', exact: true })).toBeVisible();
  await expect(planCard(page, P.name).getByRole('button', { name: 'Switch', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your plan/)).toHaveText(
    `Your plan stays until ${longDate(newEnd)}. After that your account moves to Free; nothing is deleted.`,
  );
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();

  const token = await freshStaff();
  const summary = await adminApi<{ pastDue: Array<{ tenantId: string }> }>('GET', '/api/admin/billing/summary', undefined, token, staffIp);
  expect(summary.pastDue.map((r) => r.tenantId)).not.toContain(tenant.userId);
  await openTenant(tenant);
  await expect(fact(tenantBillingCard(staffPage), 'State')).toHaveText('Active');

  // The same with subscription.activated.
  const otherIp = newClientIp();
  const other = await createAccount(otherIp, 'bill-202-b', 'Dev Customer');
  const second = await activeOn(other, otherIp, G);
  await halt(second);
  const activated = await sendEvent('subscription.activated', second.checkout.subscriptionId, { status: 'active' }, { createdAt: nowSeconds() + 5 });
  expect((await billingEvent(activated.eventId))?.outcome).toBe('applied');
  expect(await subscriptionRow(second.checkout.subscriptionId)).toMatchObject({ status: 'active', grace_until: null });
  expect((await overview(other, otherIp)).state).toBe('active');
});

test('BILL-209 cancel while a change\'s Checkout is open but not authorised', async ({ page, clientIp }) => {
  test.setTimeout(200_000);
  const tenant = await createAccount(clientIp, 'bill-209', 'Cara Customer');
  const active = await activeOn(tenant, clientIp, G);
  const successor = await changePlan(tenant, clientIp, P.code);
  expect((await subscriptionRow(successor.subscriptionId)).status).toBe('created');

  await signIn(page, tenant);
  await openBilling(page);
  const card = stateCard(page);
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Active');
  await expect(card.getByText(`Next charge ₹499.00 on ${longDate(active.periodEnd)}.`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await expect(dialog.getByText(/^Your plan/)).toHaveText(
    `Your plan stays until ${longDate(active.periodEnd)}. After that your account moves to Free; nothing is deleted.`,
  );
  await dialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(page.getByText('Your plan will end at the end of this period', { exact: true }).first()).toBeVisible();
  await expect(card.locator('[data-slot="badge"]')).toHaveText('Ends at the period end');

  expect((await cancelCalls(active.checkout.subscriptionId)).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: true }]);
  const dropped = await subscriptionRow(successor.subscriptionId);
  expect(dropped.cancel_requested_at).not.toBeNull();
  expect(dropped.cancel_at_cycle_end).toBe(false);
  expect((await billingAccountRow(tenant.userId)).next_subscription_id).toBeNull();

  // The worker cancels the abandoned Checkout's subscription at once.
  expect((await waitForCancelCall(successor.subscriptionId)).body).toStrictEqual({ cancel_at_cycle_end: false });

  // Its authorisation arriving afterwards changes nothing.
  const late = await sendEvent('subscription.authenticated', successor.subscriptionId, {
    status: 'authenticated',
    customer_id: successor.customerId,
  });
  expect(late.body).toStrictEqual(RECEIVED);
  expect(await billingEvent(late.eventId)).toMatchObject({ outcome: 'applied', detail: 'superseded' });
  const account = await billingAccountRow(tenant.userId);
  expect(account.next_subscription_id).toBeNull();
  expect(account.current_subscription_id).toBe((await subscriptionRow(active.checkout.subscriptionId)).id);
  expect((await overview(tenant, clientIp)).state).toBe('cancelling');
});

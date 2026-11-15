import { createHash, createHmac, hkdfSync, randomBytes } from 'crypto';
import path from 'path';
import { Client } from 'pg';
import { expect, type Locator, type Page } from '@playwright/test';
import type { BillingCheckout, BillingOverview } from '@chumbaq/shared';
import { adminApi } from '../admin';
import { api, apiUrl, type Account } from '../api';
import { DAY_SECONDS, mockSubscription, nowSeconds, sendSubscriptionEvent } from '../billing';
import { run, stopAll, waitForUrl } from '../processes';
import { appEnvironment, assertE2eDatabase, REPO_ROOT, runSecrets, stackEnv, stackPorts } from '../stack';

/**
 * Billing area helpers: plans with any limits and prices, the customer's billing calls,
 * subscription states reached through the real flow (subscribe, then the signed
 * webhooks), the Razorpay mock's call list, a Checkout stand-in that records its
 * options and can be dismissed, database reads, and a second customer API with
 * billing switched off.
 */

// ------------------------------------------------------------------ the mock

function mockUrl(p: string): string {
  const base = process.env.E2E_RAZORPAY_MOCK_URL;
  if (!base) throw new Error('E2E_RAZORPAY_MOCK_URL is not set: run the specs through playwright.config.ts');
  return `${base}${p}`;
}

export interface MockCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export async function mockCalls(): Promise<MockCall[]> {
  const response = await fetch(mockUrl('/__mock/calls'));
  return (await response.json()) as MockCall[];
}

/** Calls whose body names this account (customers and subscriptions carry its id in notes). */
export async function mockCallsFor(userId: string): Promise<MockCall[]> {
  return (await mockCalls()).filter((call) => JSON.stringify(call.body ?? {}).includes(userId));
}

/** Cancel calls the mock received for one subscription. */
export async function cancelCalls(subscriptionId: string): Promise<MockCall[]> {
  return (await mockCalls()).filter(
    (call) => call.method === 'POST' && call.path === `/v1/subscriptions/${subscriptionId}/cancel`,
  );
}

/** Waits for the worker's outbox (every minute) to send a cancel for this subscription. */
export async function waitForCancelCall(subscriptionId: string, timeoutMs = 100_000): Promise<MockCall> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [call] = await cancelCalls(subscriptionId);
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`No cancel for ${subscriptionId} reached the mock within ${timeoutMs / 1000}s`);
}

/** A plan at the mock (as staff would create one in Razorpay first); answers its id. */
export async function registerMockPlan(period: 'monthly' | 'yearly', amount: number): Promise<string> {
  const id = `plan_${randomBytes(7).toString('hex')}`;
  const response = await fetch(mockUrl('/__mock/plans'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, period, amount }),
  });
  if (!response.ok) throw new Error(`mock plan answered ${response.status}`);
  return id;
}

export { mockSubscription };

// ------------------------------------------------------------------ plans

export interface PlanSpec {
  label: string;
  sortOrder: number;
  mauLimit: number | null;
  projectLimit: number | null;
  seatLimit: number | null;
  monthly?: number;
  yearly?: number;
}

export interface Plan {
  code: string;
  name: string;
  prices: { monthly?: { id: string; razorpayPlanId: string; paise: number }; yearly?: { id: string; razorpayPlanId: string; paise: number } };
}

interface AdminPlanReply {
  prices: Array<{ id: string; interval: 'monthly' | 'yearly'; isCurrent: boolean; razorpayPlanId: string }>;
}

/** A plan with the prices asked for, as staff make one (each price checked against its mock plan). */
export async function createPlan(staffToken: string, ip: string, spec: PlanSpec): Promise<Plan> {
  const suffix = randomBytes(3).toString('hex');
  const code = `e2e_${spec.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${suffix}`.slice(0, 32);
  const name = `E2E ${spec.label} ${suffix}`;
  await adminApi(
    'POST',
    '/api/admin/plans',
    {
      code,
      name,
      mauLimit: spec.mauLimit,
      projectLimit: spec.projectLimit,
      seatLimit: spec.seatLimit,
      sortOrder: spec.sortOrder,
      reason: 'E2E: a plan for the billing page',
    },
    staffToken,
    ip,
  );
  const plan: Plan = { code, name, prices: {} };
  for (const interval of ['monthly', 'yearly'] as const) {
    const paise = spec[interval];
    if (paise === undefined) continue;
    const razorpayPlanId = await registerMockPlan(interval, paise);
    const reply = await adminApi<AdminPlanReply>(
      'POST',
      `/api/admin/plans/${code}/prices`,
      { interval, pricePaise: paise, razorpayPlanId, reason: `E2E: its ${interval} price` },
      staffToken,
      ip,
    );
    const price = reply.prices.find((p) => p.isCurrent && p.interval === interval)!;
    plan.prices[interval] = { id: price.id, razorpayPlanId, paise };
  }
  return plan;
}

export async function deactivatePlan(staffToken: string, ip: string, code: string): Promise<void> {
  await adminApi('PATCH', `/api/admin/plans/${code}`, { isActive: false, reason: 'E2E: no longer sold' }, staffToken, ip);
}

export async function retirePrice(staffToken: string, ip: string, code: string, priceId: string): Promise<void> {
  await adminApi('POST', `/api/admin/plans/${code}/prices/${priceId}/retire`, { reason: 'E2E: price withdrawn' }, staffToken, ip);
}

// ------------------------------------------------------------------ customer calls

export interface Raw {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A request that never throws: the status and the parsed body, envelope and all. */
export async function rawApi(
  method: string,
  p: string,
  { token, ip, body, base }: { token?: string; ip: string; body?: unknown; base?: string },
): Promise<Raw> {
  const response = await fetch(base ? `${base}${p}` : apiUrl(p), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body: parsed };
}

export const DEFAULT_DETAILS = {
  legalName: 'Bela Buyer Labs',
  address: { line1: '1 Test Street', city: 'Bengaluru', postalCode: '560001', country: 'IN' as const },
  stateCode: '29',
};

export async function saveDetails(account: Account, ip: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await api('PUT', '/api/billing/details', { ...DEFAULT_DETAILS, ...overrides }, { token: account.accessToken, ip });
}

export function overview(account: Account, ip: string): Promise<BillingOverview> {
  return api<BillingOverview>('GET', '/api/billing', undefined, { token: account.accessToken, ip });
}

export function subscribe(account: Account, ip: string, plan: string, interval: 'monthly' | 'yearly' = 'monthly'): Promise<BillingCheckout> {
  return api<BillingCheckout>('POST', '/api/billing/subscribe', { plan, interval }, { token: account.accessToken, ip });
}

export function changePlan(account: Account, ip: string, plan: string, interval: 'monthly' | 'yearly' = 'monthly'): Promise<BillingCheckout> {
  return api<BillingCheckout>('POST', '/api/billing/change', { plan, interval }, { token: account.accessToken, ip });
}

export function cancelPlan(account: Account, ip: string): Promise<BillingOverview> {
  return api<BillingOverview>('POST', '/api/billing/cancel', undefined, { token: account.accessToken, ip });
}

export interface Active {
  checkout: BillingCheckout;
  periodStart: number;
  periodEnd: number;
}

/** Signed `subscription.activated` for a subscription the API created: it is now charging. */
export async function activate(checkout: BillingCheckout, periodStart = nowSeconds()): Promise<Active> {
  const periodEnd = periodStart + 30 * DAY_SECONDS;
  await sendSubscriptionEvent('subscription.activated', checkout.subscriptionId, {
    status: 'active',
    customer_id: checkout.customerId,
    current_start: periodStart,
    current_end: periodEnd,
    charge_at: periodEnd,
    paid_count: 1,
  });
  return { checkout, periodStart, periodEnd };
}

/** Details, a subscription to `plan`, and its activation: the account is active on it. */
export async function activeOn(account: Account, ip: string, plan: Plan, details: Record<string, unknown> = {}): Promise<Active> {
  await saveDetails(account, ip, details);
  return activate(await subscribe(account, ip, plan.code));
}

/** An active account's renewal failed for good: halted, in its grace period. */
export async function halt(active: Active): Promise<void> {
  await sendSubscriptionEvent('subscription.halted', active.checkout.subscriptionId, { status: 'halted' });
}

export async function authenticate(checkout: BillingCheckout): Promise<void> {
  await sendSubscriptionEvent('subscription.authenticated', checkout.subscriptionId, {
    status: 'authenticated',
    customer_id: checkout.customerId,
  });
}

export { sendSubscriptionEvent, nowSeconds, DAY_SECONDS };

/** The webhook endpoint with exactly these bytes, signed under the run's secret. */
export async function postSignedWebhook(rawBody: string, base?: string): Promise<Raw> {
  const { createHmac } = await import('crypto');
  const signature = createHmac('sha256', runSecrets().razorpayWebhookSecret).update(rawBody).digest('hex');
  const response = await fetch(`${base ?? apiUrl('')}/api/billing/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
      'x-razorpay-event-id': `evt_e2e${randomBytes(6).toString('hex')}`,
    },
    body: rawBody,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { status: response.status, body: parsed };
}

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

// ------------------------------------------------------------------ database

export async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const env = stackEnv();
  const client = new Client({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT || 5432),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: assertE2eDatabase(env),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withDb(async (db) => (await db.query(sql, params)).rows as T[]);
}

export interface SubscriptionRow {
  id: string;
  status: string;
  superseded_by: string | null;
  was_current: boolean;
  cancel_at_period_end: boolean;
  cancel_requested_at: Date | null;
  cancel_at_cycle_end: boolean | null;
  cancel_requested_by: string | null;
  cancel_sent_at: Date | null;
  grace_until: Date | null;
}

export async function subscriptionRow(providerSubscriptionId: string): Promise<SubscriptionRow> {
  const [row] = await query<SubscriptionRow>(`SELECT * FROM billing_subscriptions WHERE provider_subscription_id = $1`, [
    providerSubscriptionId,
  ]);
  if (!row) throw new Error(`No billing_subscriptions row for ${providerSubscriptionId}`);
  return row;
}

// ------------------------------------------------------------------ the page

/** The day as the billing page writes it, in UTC (specs pin the browser's time zone to UTC). */
export function longDate(at: number | string | Date): string {
  const date = typeof at === 'number' ? new Date(at * 1000) : new Date(at);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The first card on the page: the account's plan, state and usage. */
export function stateCard(page: Page): Locator {
  return page.locator('[data-slot="card"]').first();
}

export function plansSection(page: Page): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: 'Plans', exact: true }) });
}

export function planCard(page: Page, planName: string): Locator {
  return plansSection(page)
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]').getByText(planName, { exact: true }) });
}

export type CheckoutOutcome = 'success' | 'dismiss';

export interface RecordedCheckout {
  keys: string[];
  json: Record<string, unknown>;
  handler: string;
  ondismiss: string;
}

/**
 * Razorpay Checkout replaced in this page, as `stubRazorpayCheckout` does, but each
 * `open()` takes the next outcome (success calls the handler, dismiss calls
 * `modal.ondismiss`; success once they run out), and every `new Razorpay(options)` is
 * recorded in `window.__e2eCheckoutOptions` (functions by type only).
 */
export async function stubCheckout(page: Page, outcomes: CheckoutOutcome[] = []): Promise<void> {
  await page.route('https://checkout.razorpay.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.__e2eCheckoutOutcomes = ${JSON.stringify(outcomes)};
        window.__e2eCheckoutOptions = [];
        window.Razorpay = function (options) {
          window.__e2eCheckoutOptions.push({
            keys: Object.keys(options),
            json: JSON.parse(JSON.stringify(options)),
            handler: typeof options.handler,
            ondismiss: typeof (options.modal && options.modal.ondismiss),
          });
          this.open = function () {
            var outcome = window.__e2eCheckoutOutcomes.shift() || 'success';
            setTimeout(function () {
              if (outcome === 'dismiss') {
                options.modal.ondismiss();
              } else {
                options.handler({
                  razorpay_payment_id: 'pay_e2e' + Date.now(),
                  razorpay_subscription_id: options.subscription_id,
                  razorpay_signature: 'e2e',
                });
              }
            }, 50);
          };
        };`,
    }),
  );
}

export function recordedCheckouts(page: Page): Promise<RecordedCheckout[]> {
  return page.evaluate(() => (window as unknown as { __e2eCheckoutOptions?: RecordedCheckout[] }).__e2eCheckoutOptions ?? []);
}

/** Fills the billing details form with the defaults (state chosen from the list). */
export async function fillDetailsForm(page: Page, options: { gstin?: string; state?: string } = {}): Promise<void> {
  await page.getByLabel('Legal name').fill(DEFAULT_DETAILS.legalName);
  if (options.gstin !== undefined) await page.getByLabel(/^GSTIN/).fill(options.gstin);
  await page.getByLabel('Address', { exact: true }).fill(DEFAULT_DETAILS.address.line1);
  await page.getByLabel('City').fill(DEFAULT_DETAILS.address.city);
  await page.getByLabel('PIN code').fill(DEFAULT_DETAILS.address.postalCode);
  await chooseState(page, options.state ?? 'Karnataka');
}

export async function chooseState(page: Page, state: string): Promise<void> {
  await page.getByRole('combobox', { name: /state/i }).click();
  await page.getByRole('option', { name: state, exact: true }).click();
}

/** Opens the billing page and waits for its plans. */
export async function openBilling(page: Page): Promise<void> {
  await page.goto('/account/billing');
  await expect(page.getByRole('heading', { name: 'Plans', exact: true })).toBeVisible();
}

// ------------------------------------------------------------------ view-as

/**
 * A view-as handoff for the tenant: the admin API's one-time link (60 s, one use).
 * The staff token must carry a sign-in within 15 minutes.
 */
export async function viewAsHandoff(staffToken: string, staffIp: string, tenantId: string): Promise<string> {
  const handoff = await adminApi<{ url: string }>(
    'POST',
    `/api/admin/tenants/${tenantId}/impersonate`,
    { reason: 'E2E: checking billing is refused in view-as' },
    staffToken,
    staffIp,
  );
  return handoff.url;
}

/** Spends a handoff link as the customer app does: the view-as access token. */
export async function exchangeHandoff(url: string, ip: string): Promise<string> {
  const code = /#code=([A-Za-z0-9_-]{43})$/.exec(url)?.[1];
  if (!code) throw new Error('The handoff link carries no code');
  const session = await api<{ accessToken: string }>('POST', '/api/auth/impersonation/exchange', { code }, { ip });
  return session.accessToken;
}

/**
 * Signs the staff member in again with the passkey already in that tab (its virtual
 * authenticator), for a fresh staff token with a recent sign-in.
 */
export async function staffPasskeyToken(staffPage: Page, adminSignInUrl: string): Promise<string> {
  // Forget the session the tab holds, so the sign-in page asks again.
  await staffPage.context().clearCookies();
  if (staffPage.url().startsWith(new URL(adminSignInUrl).origin)) await staffPage.evaluate(() => sessionStorage.clear());
  await staffPage.goto(adminSignInUrl);
  await staffPage.getByRole('button', { name: 'Sign in with a passkey' }).waitFor();
  const [verified] = await Promise.all([
    staffPage.waitForResponse((response) => response.url().endsWith('/api/staff/auth/passkey/verify')),
    staffPage.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  if (!verified.ok()) throw new Error(`Staff passkey sign-in answered ${verified.status()}`);
  return ((await verified.json()) as { data: { accessToken: string } }).data.accessToken;
}

// ------------------------------------------------------------------ billing off

export interface BillingOffApi {
  url: string;
  stop(): Promise<void>;
}

/**
 * A second customer API on the same database and secrets as the lane's, with
 * BILLING_ENABLED=false: the install a self-hoster runs without payments. On the API
 * port + 97 (lanes are 100 apart, the mock and the stub take + 90 and + 91).
 */
export async function startBillingOffApi(): Promise<BillingOffApi> {
  const ports = stackPorts();
  const port = ports.api + 97;
  const env = {
    ...process.env,
    ...appEnvironment(runSecrets(), ports),
    BILLING_ENABLED: 'false',
    API_PORT: String(port),
  };
  const started = run('api-billing-off', 'node', ['dist/main'], { cwd: path.join(REPO_ROOT, 'apps/api'), env });
  try {
    await waitForUrl(started, `http://127.0.0.1:${port}/api/health`);
  } catch (error) {
    await stopAll([started]);
    throw error;
  }
  return { url: `http://localhost:${port}`, stop: () => stopAll([started]) };
}

// ------------------------------------------------------------------ webhooks with full control

/** The webhook endpoint with these bytes and headers; the signature defaults to the right one. */
export async function postWebhook(
  rawBody: string,
  options: { eventId?: string | null; signature?: string | null; ip?: string } = {},
): Promise<Raw & { eventId: string | null }> {
  const eventId = options.eventId === undefined ? newEventId() : options.eventId;
  const signature =
    options.signature === undefined
      ? createHmac('sha256', runSecrets().razorpayWebhookSecret).update(rawBody).digest('hex')
      : options.signature;
  const response = await fetch(apiUrl('/api/billing/webhooks/razorpay'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature === null ? {} : { 'X-Razorpay-Signature': signature }),
      ...(eventId === null ? {} : { 'x-razorpay-event-id': eventId }),
      ...(options.ip ? { 'X-Forwarded-For': options.ip } : {}),
    },
    body: rawBody,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { status: response.status, body: parsed, eventId };
}

export const newEventId = () => `evt_e2e${randomBytes(6).toString('hex')}`;

export interface SentEvent extends Raw {
  eventId: string;
  rawBody: string;
}

/**
 * Moves a subscription at the mock and sends its webhook with a chosen `created_at`
 * (default now) and, optionally, a payment entity beside it, as `subscription.charged`
 * carries. Never throws: the caller reads the answer.
 */
export async function sendEvent(
  event: string,
  subscriptionId: string,
  changes: Record<string, unknown>,
  options: { createdAt?: number; payment?: Record<string, unknown> } = {},
): Promise<SentEvent> {
  const entity = await (
    await fetch(mockUrl(`/__mock/subscriptions/${subscriptionId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    })
  ).json();
  const rawBody = JSON.stringify({
    entity: 'event',
    account_id: 'acc_e2eMockOnly01',
    event,
    contains: options.payment ? ['subscription', 'payment'] : ['subscription'],
    payload: { subscription: { entity }, ...(options.payment ? { payment: { entity: options.payment } } : {}) },
    created_at: options.createdAt ?? nowSeconds(),
  });
  const eventId = newEventId();
  const reply = await postWebhook(rawBody, { eventId });
  return { ...reply, eventId, rawBody };
}

/** A Razorpay payment entity in the documented shape, with the fields a person's payment carries. */
export function paymentEntity(fields: {
  id?: string;
  amount: number;
  status: 'captured' | 'failed' | 'refunded';
  customerId?: string | null;
  invoiceId?: string | null;
  method?: string;
  createdAt?: number;
  errorReason?: string | null;
  email?: string;
  contact?: string;
}): Record<string, unknown> {
  return {
    id: fields.id ?? `pay_e2e${randomBytes(6).toString('hex')}`,
    entity: 'payment',
    amount: fields.amount,
    currency: 'INR',
    status: fields.status,
    order_id: null,
    invoice_id: fields.invoiceId ?? null,
    international: false,
    method: fields.method ?? 'upi',
    amount_refunded: 0,
    refund_status: null,
    captured: fields.status === 'captured',
    description: 'E2E payment',
    card_id: 'card_E2eCard0000001',
    card: { id: 'card_E2eCard0000001', entity: 'card', name: 'Bela Buyer', last4: '1111', network: 'Visa' },
    bank: 'HDFC',
    wallet: null,
    vpa: 'bela.buyer@okhdfc',
    email: fields.email ?? 'bela.buyer@e2e.example.test',
    contact: fields.contact ?? '+919000012345',
    customer_id: fields.customerId ?? null,
    notes: { address: '1 Test Street', person: 'Bela Buyer' },
    fee: 0,
    tax: 0,
    error_code: fields.status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
    error_description: fields.status === 'failed' ? 'Payment failed' : null,
    error_source: fields.status === 'failed' ? 'customer' : null,
    error_step: fields.status === 'failed' ? 'payment_authorization' : null,
    error_reason: fields.status === 'failed' ? (fields.errorReason ?? 'payment_failed') : null,
    acquirer_data: { rrn: '000000000000' },
    created_at: fields.createdAt ?? nowSeconds(),
  };
}

/** A signed event of any type carrying exactly these entities. */
export async function sendEntities(
  event: string,
  entities: Record<string, Record<string, unknown>>,
  createdAt = nowSeconds(),
): Promise<SentEvent> {
  const rawBody = JSON.stringify({
    entity: 'event',
    account_id: 'acc_e2eMockOnly01',
    event,
    contains: Object.keys(entities),
    payload: Object.fromEntries(Object.entries(entities).map(([name, entity]) => [name, { entity }])),
    created_at: createdAt,
  });
  const eventId = newEventId();
  return { ...(await postWebhook(rawBody, { eventId })), eventId, rawBody };
}

/**
 * Razorpay's `invoice.paid` fixture (the API's own test copy of the documented body)
 * with the run's ids: the account's subscription and customer, a fresh invoice and
 * payment id, and the given number, amount, period and short URL.
 */
export async function sendInvoicePaid(fields: {
  subscriptionId: string;
  customerId: string;
  number: string;
  amount: number;
  billingStart: number;
  billingEnd: number;
  shortUrl: string | null;
}): Promise<SentEvent & { invoiceId: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixture = JSON.parse(
    JSON.stringify(require(path.join(REPO_ROOT, 'apps/api/src/modules/billing/providers/__fixtures__/razorpay/invoice.paid.json'))),
  );
  const invoiceId = `inv_e2e${randomBytes(6).toString('hex')}`;
  const paymentId = `pay_e2e${randomBytes(6).toString('hex')}`;
  const now = nowSeconds();
  const invoice = fixture.payload.invoice.entity;
  Object.assign(invoice, {
    id: invoiceId,
    subscription_id: fields.subscriptionId,
    customer_id: fields.customerId,
    payment_id: paymentId,
    invoice_number: fields.number,
    amount: fields.amount,
    amount_paid: fields.amount,
    gross_amount: fields.amount,
    taxable_amount: fields.amount,
    tax_amount: 0,
    billing_start: fields.billingStart,
    billing_end: fields.billingEnd,
    issued_at: now,
    paid_at: now,
    short_url: fields.shortUrl,
    status: 'paid',
  });
  Object.assign(fixture.payload.payment.entity, {
    id: paymentId,
    invoice_id: invoiceId,
    order_id: null,
    amount: fields.amount,
    customer_id: fields.customerId,
    created_at: now,
  });
  delete fixture.payload.order;
  fixture.contains = ['payment', 'invoice'];
  fixture.created_at = now;
  const rawBody = JSON.stringify(fixture);
  const eventId = newEventId();
  return { ...(await postWebhook(rawBody, { eventId })), eventId, rawBody, invoiceId };
}

export interface BillingEventRow {
  provider: string;
  provider_event_id: string;
  type: string;
  outcome: string;
  detail: string | null;
  body_sha256: string | null;
  attempts: number;
  payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function billingEvent(eventId: string): Promise<BillingEventRow | undefined> {
  const [row] = await query<BillingEventRow>(`SELECT * FROM billing_events WHERE provider_event_id = $1`, [eventId]);
  return row;
}

export async function billingEventsWithBody(rawBody: string): Promise<BillingEventRow[]> {
  return query<BillingEventRow>(`SELECT * FROM billing_events WHERE body_sha256 = $1`, [sha256Hex(rawBody)]);
}

export async function billingAccountRow(userId: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [row] = await query(`SELECT * FROM billing_accounts WHERE user_id = $1`, [userId]);
  return row;
}

// ------------------------------------------------------------------ limits

/** `n` projects owned by the account, through the real create. */
export async function createProjects(account: Account, ip: string, n: number, label = 'Limit'): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await api('POST', '/api/projects', { name: `${label} ${i + 1} ${randomBytes(2).toString('hex')}`, domain: 'e2e.example.test' }, {
      token: account.accessToken,
      ip,
    });
  }
}

export function tryCreateProject(account: Account, ip: string): Promise<Raw> {
  return rawApi('POST', '/api/projects', {
    token: account.accessToken,
    ip,
    body: { name: `Over the limit ${randomBytes(2).toString('hex')}`, domain: 'e2e.example.test' },
  });
}

export function invite(account: Account, ip: string, projectId: string, email: string, role = 'member'): Promise<Raw> {
  return rawApi('POST', `/api/projects/${projectId}/invitations`, { token: account.accessToken, ip, body: { email, role } });
}

export async function projectCount(userId: string): Promise<number> {
  const [row] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE owner_id = $1`, [userId]);
  return row.n;
}

// ------------------------------------------------------------------ staff

/** A comp through the staff API. */
export function compTenant(staffToken: string, ip: string, tenantId: string, planCode: string, until?: string): Promise<unknown> {
  return adminApi(
    'POST',
    `/api/admin/tenants/${tenantId}/billing/comp`,
    { planCode, reason: 'E2E: a complimentary plan', ...(until ? { until } : {}) },
    staffToken,
    ip,
  );
}

export function endCompOf(staffToken: string, ip: string, tenantId: string): Promise<unknown> {
  return adminApi('POST', `/api/admin/tenants/${tenantId}/billing/comp/end`, { reason: 'E2E: the comp is over' }, staffToken, ip);
}

/** A request to the admin API (or another base) that never throws. */
export async function rawAdmin(
  method: string,
  p: string,
  { token, ip, body, base }: { token?: string; ip: string; body?: unknown; base?: string },
): Promise<Raw> {
  const response = await fetch(`${base ?? process.env.E2E_ADMIN_API_URL}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { status: response.status, body: parsed };
}

/**
 * The same staff access token (same session, version and claims) re-signed with an
 * `auth_time` of `ageSeconds` ago, as the API would have issued it then: the staff key
 * is HKDF-SHA256 of the run's JWT secret, as `staffAccessKey` derives it.
 */
export function agedStaffToken(token: string, ageSeconds: number): string {
  const key = Buffer.from(hkdfSync('sha256', runSecrets().jwtSecret, 'chumbaq-staff-session', 'staff-access-token-v1', 32));
  const [header, payload] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.auth_time = Math.floor(Date.now() / 1000) - ageSeconds;
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export async function auditRows(action: string, where: { targetId?: string; targetLabel?: string }): Promise<Array<Record<string, any>>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (where.targetId) {
    return query(`SELECT * FROM admin_audit_logs WHERE action = $1 AND target_id = $2 ORDER BY created_at`, [action, where.targetId]);
  }
  return query(`SELECT * FROM admin_audit_logs WHERE action = $1 AND target_label = $2 ORDER BY created_at`, [action, where.targetLabel]);
}

/** A second admin API on the lane's database and secrets with BILLING_ENABLED=false, on the API port + 98. */
export async function startBillingOffAdminApi(): Promise<BillingOffApi> {
  const ports = stackPorts();
  const port = ports.api + 98;
  const env = {
    ...process.env,
    ...appEnvironment(runSecrets(), ports),
    BILLING_ENABLED: 'false',
    ADMIN_API_PORT: String(port),
  };
  const started = run('admin-api-billing-off', 'node', ['dist/main-admin'], { cwd: path.join(REPO_ROOT, 'apps/api'), env });
  try {
    await waitForUrl(started, `http://127.0.0.1:${port}/api/health`);
  } catch (error) {
    await stopAll([started]);
    throw error;
  }
  return { url: `http://127.0.0.1:${port}`, stop: () => stopAll([started]) };
}

// ------------------------------------------------------------------ formatting and the admin app

/** Integer paise as the apps print them: Indian grouping, two decimals. */
export function rupees(paise: number): string {
  const digits = String(Math.abs(paise)).padStart(3, '0');
  let whole = digits.slice(0, -2);
  if (whole.length > 3) {
    const last = whole.slice(-3);
    let rest = whole.slice(0, -3);
    const pairs: string[] = [];
    while (rest.length > 2) {
      pairs.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    pairs.unshift(rest);
    whole = `${pairs.join(',')},${last}`;
  }
  return `${paise < 0 ? '-' : ''}₹${whole}.${digits.slice(-2)}`;
}

/** A day as the admin app writes it (en-GB, short month), in UTC (the staff context is pinned to UTC). */
export function gbDate(at: number | string | Date): string {
  const date = typeof at === 'number' ? new Date(at * 1000) : new Date(at);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** A card in the admin app by its exact title. */
export function adminCard(page: Page, title: string | RegExp): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]').getByText(title, { exact: true }) });
}

/** The tenant page's Billing card. */
export function tenantBillingCard(page: Page): Locator {
  return adminCard(page, 'Billing');
}

/** A fact on the Billing card (its <dd>), by its label. */
export function fact(card: Locator, label: string): Locator {
  return card.locator(`dt:text-is("${label}") + dd`);
}

/** A plan's card on the admin Plans page, by its code. */
export function adminPlanCard(page: Page, code: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"] span.font-mono').getByText(code, { exact: true }) });
}

export function adminToast(page: Page, title: string): Locator {
  return page.getByText(title, { exact: true }).first();
}

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
  /** How long the webhook took to answer (set by `sendEvent`: the post alone, not the mock's update). */
  tookMs?: number;
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
  const startedAt = Date.now();
  const reply = await postWebhook(rawBody, { eventId });
  return { ...reply, eventId, rawBody, tookMs: Date.now() - startedAt };
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

// ------------------------------------------------------------------ P1: usage, billing off, suspension, details

/** A UTC day as `YYYY-MM-DD`, `offsetDays` from today. */
export function utcDay(offsetDays = 0): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/**
 * Makes the usage roll-up's state say it has counted through yesterday (UTC), with
 * active devices counted from a month that covers it, so seeded `usage_daily` rows for
 * yesterday are what the billing page reads. Only ever moves the counted range out
 * (earlier start, later last closed day), which is what the worker's own ticks do.
 * Answers the day counted through.
 */
export async function seedRollupThroughYesterday(): Promise<string> {
  const yesterday = utcDay(-1);
  await query(
    `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day, devices_through)
     VALUES (1, $1::date, $2::date, $3::date, now())
     ON CONFLICT (id) DO UPDATE SET
       started_on = LEAST(usage_rollup_state.started_on, EXCLUDED.started_on),
       first_day = LEAST(usage_rollup_state.first_day, EXCLUDED.first_day),
       last_closed_day = GREATEST(usage_rollup_state.last_closed_day, EXCLUDED.last_closed_day)`,
    [utcDay(-60), utcDay(-90), yesterday],
  );
  const [state] = await query<{ last: string }>(`SELECT to_char(last_closed_day, 'YYYY-MM-DD') AS last FROM usage_rollup_state WHERE id = 1`);
  if (state.last !== yesterday) throw new Error(`The roll-up has counted through ${state.last}, not yesterday (${yesterday})`);
  return yesterday;
}

/** The roll-up's coverage as the API reads it (`readUsageCoverage`), or null before it first ran. */
export async function rollupCoverage(): Promise<{ countedThrough: string | null; mauFrom: string } | null> {
  const [state] = await query<{ started_on: string; first_day: string; last_closed_day: string }>(
    `SELECT to_char(started_on, 'YYYY-MM-DD') AS started_on, to_char(first_day, 'YYYY-MM-DD') AS first_day,
            to_char(last_closed_day, 'YYYY-MM-DD') AS last_closed_day
       FROM usage_rollup_state WHERE id = 1`,
  );
  if (!state) return null;
  return {
    countedThrough: state.last_closed_day >= state.first_day ? state.last_closed_day : null,
    mauFrom: `${state.started_on.slice(0, 7)}-01`,
  };
}

/** A project's month-to-date active devices for one day, as the roll-up writes it. */
export async function seedMau(projectId: string, ownerId: string, day: string, value: number): Promise<void> {
  await query(
    `INSERT INTO usage_daily (project_id, day, metric, owner_id, value) VALUES ($1, $2::date, 'mau_month_to_date', $3, $4)
     ON CONFLICT (project_id, day, metric) DO UPDATE SET value = EXCLUDED.value, owner_id = EXCLUDED.owner_id`,
    [projectId, day, ownerId, value],
  );
}

/**
 * Another customer API with BILLING_ENABLED=false, as `startBillingOffApi`, but on the
 * first free port from the API port + 92 to + 96, so it can run beside the one that
 * helper starts on + 97.
 */
export async function startBillingOffApiOnFreePort(): Promise<BillingOffApi> {
  const { portInUse } = await import('../processes');
  const ports = stackPorts();
  let port = 0;
  for (let candidate = ports.api + 92; candidate <= ports.api + 96; candidate++) {
    if (!(await portInUse(candidate))) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error('No free port for a billing-off customer API');
  const env = {
    ...process.env,
    ...appEnvironment(runSecrets(), ports),
    BILLING_ENABLED: 'false',
    API_PORT: String(port),
  };
  const started = run(`api-billing-off-${port}`, 'node', ['dist/main'], { cwd: path.join(REPO_ROOT, 'apps/api'), env });
  try {
    await waitForUrl(started, `http://127.0.0.1:${port}/api/health`);
  } catch (error) {
    await stopAll([started]);
    throw error;
  }
  return { url: `http://localhost:${port}`, stop: () => stopAll([started]) };
}

/** Sends every API request this page makes to another API, as the dev server's proxy would. */
export async function routeApiTo(page: Page, base: string): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${base}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    },
  );
}

/** Staff suspend an account through the admin API (needs a staff sign-in within 15 minutes). */
export function suspendTenant(staffToken: string, ip: string, tenantId: string): Promise<unknown> {
  return adminApi('POST', `/api/admin/tenants/${tenantId}/suspend`, { reason: 'E2E: checking billing while suspended' }, staffToken, ip);
}

/** `member` joins `projectId` through an invitation from `owner`, the way the dashboard does it. */
export async function joinProject(owner: Account, member: Account, projectId: string, ip: string, role = 'member'): Promise<void> {
  const created = await api<{ inviteUrl: string }>(
    'POST',
    `/api/projects/${projectId}/invitations`,
    { email: member.email, role },
    { token: owner.accessToken, ip },
  );
  const token = /#token=([^&]+)$/.exec(created.inviteUrl)?.[1];
  if (!token) throw new Error('The invitation link carries no token');
  await api('POST', '/api/invitations/accept', { token }, { token: member.accessToken, ip });
}

/** The state card's usage bar: its inner, coloured part. */
export function usageBar(page: Page): Locator {
  return stateCard(page).locator('[role="presentation"] > div');
}

/** The billing details form (open while there are no details, or while editing). */
export function detailsForm(page: Page): Locator {
  return page.locator('form').filter({ has: page.getByRole('button', { name: /^(Save details|Saving\.\.\.)$/ }) });
}

/** The alert under the billing details form. */
export function detailsAlert(page: Page): Locator {
  return detailsForm(page).getByRole('alert');
}

// ------------------------------------------------------------------ P1: checkout, changes, webhooks, outbox

/**
 * An access token whose sign-in is 20 minutes old (past the 15-minute recent sign-in
 * window): signs in, moves the session's `authenticated_at` back (where refresh reads
 * `auth_time` from), and refreshes with the session's cookie.
 */
export async function staleToken(account: Account, ip: string): Promise<string> {
  const headers = { 'Content-Type': 'application/json', 'X-Chumbaq-Client': 'web', 'X-Forwarded-For': ip };
  const login = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (!login.ok) throw new Error(`login answered ${login.status}: ${await login.text()}`);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  await ageSignIns(account.userId);
  const refresh = await fetch(apiUrl('/api/auth/refresh'), { method: 'POST', headers: { ...headers, Cookie: cookie } });
  const text = await refresh.text();
  if (!refresh.ok) throw new Error(`refresh answered ${refresh.status}: ${text}`);
  return (JSON.parse(text) as { data: { accessToken: string } }).data.accessToken;
}

/** Moves every one of the account's sign-ins 20 minutes back. The next refresh carries the old time. */
export async function ageSignIns(userId: string): Promise<void> {
  await query(`UPDATE auth_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1`, [userId]);
}

/**
 * Runs the worker's outbox now (as its once-a-minute cron does) until the mock has a
 * cancel for this subscription; the stack's own worker may send it first, which is
 * just as good. Falls back to waiting for the cron.
 */
export async function flushCancel(subscriptionId: string): Promise<MockCall> {
  const { runJobNow } = await import('../jobs');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [call] = await cancelCalls(subscriptionId);
    if (call) return call;
    await runJobNow('billing-outbox', { allowErrors: true });
  }
  return waitForCancelCall(subscriptionId);
}

/** The provider ids of the subscriptions the mock was asked to create for this account. */
export async function createdAtMock(userId: string): Promise<number> {
  return (await mockCallsFor(userId)).filter((c) => c.method === 'POST' && c.path === '/v1/subscriptions').length;
}

/**
 * A subscription row the mock has never heard of (a provider id it does not know), on
 * `priceId`, as a provider-side record that only the database holds would be. With
 * `current`, the account points at it as its current subscription.
 */
export async function seedUnknownSubscription(
  userId: string,
  plan: Plan,
  fields: { current?: boolean; status?: string; cancelRequested?: boolean } = {},
): Promise<{ id: string; providerId: string }> {
  const providerId = `sub_unknown${randomBytes(6).toString('hex')}`;
  const price = plan.prices.monthly!;
  return withDb(async (db) => {
    await db.query(`INSERT INTO billing_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    const { rows } = await db.query(
      `INSERT INTO billing_subscriptions
         (user_id, provider_subscription_id, price_id, plan_code, interval, status, current_start, current_end, charge_at,
          paid_count, was_current, last_event_at, last_event_rank, created_by,
          cancel_requested_at, cancel_at_cycle_end)
       VALUES ($1, $2, $3, $4, 'monthly', $5, now(), now() + interval '30 days', now() + interval '30 days',
          1, $6, now(), 2, $1, $7, $8)
       RETURNING id`,
      [
        userId,
        providerId,
        price.id,
        plan.code,
        fields.status ?? 'active',
        fields.current ?? false,
        fields.cancelRequested ? new Date() : null,
        fields.cancelRequested ? false : null,
      ],
    );
    const id = rows[0].id as string;
    if (fields.current) {
      await db.query(`UPDATE billing_accounts SET current_subscription_id = $2 WHERE user_id = $1`, [userId, id]);
    }
    return { id, providerId };
  });
}

/**
 * A price row naming a Razorpay plan the mock does not know, made current for the
 * plan's monthly interval (staff could only add one the provider confirmed).
 */
export async function seedUnknownPrice(planCode: string, pricePaise: number): Promise<string> {
  const razorpayPlanId = `plan_unknown${randomBytes(4).toString('hex')}`;
  await query(
    `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, currency, razorpay_plan_id, is_current)
     VALUES ($1, 'monthly', $2, 0, $2, 'INR', $3, true)`,
    [planCode, pricePaise, razorpayPlanId],
  );
  return razorpayPlanId;
}

/**
 * Another customer API on the lane's database and secrets with some environment
 * changed (a stack variant), on the first free port from the API port + 96 down to
 * + 92 (the other extra APIs search upwards from + 92).
 */
export async function startVariantApi(label: string, changes: Record<string, string>): Promise<BillingOffApi> {
  const { portInUse } = await import('../processes');
  const ports = stackPorts();
  const taken = new Set(Object.values(ports));
  let port = 0;
  for (let candidate = ports.api + 96; candidate >= ports.api + 92; candidate--) {
    if (!taken.has(candidate) && !(await portInUse(candidate))) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error('No free port for a variant customer API');
  const env = { ...process.env, ...appEnvironment(runSecrets(), ports), ...changes, API_PORT: String(port) };
  const started = run(`api-${label}-${port}`, 'node', ['dist/main'], { cwd: path.join(REPO_ROOT, 'apps/api'), env });
  try {
    await waitForUrl(started, `http://127.0.0.1:${port}/api/health`);
  } catch (error) {
    await stopAll([started]);
    throw error;
  }
  return { url: `http://localhost:${port}`, stop: () => stopAll([started]) };
}

/** Staff set an account's own project limit (null clears it). */
export function setProjectLimit(staffToken: string, ip: string, tenantId: string, projectLimit: number | null): Promise<unknown> {
  return adminApi('PATCH', `/api/admin/tenants/${tenantId}/project-limit`, { projectLimit, reason: 'E2E: limit under a plan' }, staffToken, ip);
}

/** Staff set an account's own seat limit (null clears it). */
export function setSeatLimit(staffToken: string, ip: string, tenantId: string, seatLimit: number | null): Promise<unknown> {
  return adminApi('PATCH', `/api/admin/tenants/${tenantId}/seat-limit`, { seatLimit, reason: 'E2E: limit under a plan' }, staffToken, ip);
}

export interface PaymentRow {
  provider_payment_id: string;
  user_id: string;
  status: string;
  amount_paise: number;
  amount_refunded_paise: number;
  failure_reason: string | null;
  method: string | null;
}

export async function paymentRow(providerPaymentId: string): Promise<PaymentRow | undefined> {
  const [row] = await query<PaymentRow>(`SELECT * FROM billing_payments WHERE provider_payment_id = $1`, [providerPaymentId]);
  return row;
}

/** A Razorpay refund entity in the documented shape. */
export function refundEntity(paymentId: string, amount: number): Record<string, unknown> {
  return {
    id: `rfnd_e2e${randomBytes(6).toString('hex')}`,
    entity: 'refund',
    amount,
    currency: 'INR',
    payment_id: paymentId,
    notes: {},
    receipt: null,
    acquirer_data: { arn: null },
    created_at: nowSeconds(),
    batch_id: null,
    status: 'processed',
    speed_processed: 'normal',
    speed_requested: 'optimum',
  };
}

/** A Razorpay subscription entity in the documented shape, for ids the mock never made. */
export function subscriptionEntity(fields: { id: string; planId: string; status: string; customerId?: string | null }): Record<string, unknown> {
  const now = nowSeconds();
  return {
    id: fields.id,
    entity: 'subscription',
    plan_id: fields.planId,
    customer_id: fields.customerId ?? null,
    status: fields.status,
    current_start: now,
    current_end: now + 30 * DAY_SECONDS,
    ended_at: null,
    quantity: 1,
    notes: [],
    charge_at: now + 30 * DAY_SECONDS,
    start_at: now,
    end_at: null,
    auth_attempts: 0,
    total_count: 120,
    paid_count: 1,
    customer_notify: true,
    created_at: now,
    expire_by: null,
    short_url: null,
    has_scheduled_changes: false,
    change_scheduled_at: null,
    source: 'api',
    remaining_count: 119,
  };
}

/** Outbox columns of one subscription row. */
export async function outboxRow(providerSubscriptionId: string): Promise<{
  id: string;
  cancel_sent_at: Date | null;
  cancel_attempts: number;
  cancel_error: string | null;
  cancel_retry_at: Date | null;
  updated_at: Date;
}> {
  const [row] = await query<{
    id: string;
    cancel_sent_at: Date | null;
    cancel_attempts: number;
    cancel_error: string | null;
    cancel_retry_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT id, cancel_sent_at, cancel_attempts, cancel_error, cancel_retry_at, updated_at
       FROM billing_subscriptions WHERE provider_subscription_id = $1`,
    [providerSubscriptionId],
  );
  return row;
}

// ------------------------------------------------------------------ P1: admin summary, plans and the tenant card

/**
 * Another admin API on the lane's database and secrets with some environment changed
 * (billing off, a tax rate), on the first free port from the admin API port + 70 to + 78,
 * so it can run beside the extra admin API that `startBillingOffAdminApi` starts.
 */
export async function startVariantAdminApi(label: string, changes: Record<string, string>): Promise<BillingOffApi> {
  const { portInUse } = await import('../processes');
  const ports = stackPorts();
  const taken = new Set(Object.values(ports));
  let port = 0;
  for (let candidate = ports.adminApi + 70; candidate <= ports.adminApi + 78; candidate++) {
    if (!taken.has(candidate) && !(await portInUse(candidate))) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error('No free port for a variant admin API');
  const env = { ...process.env, ...appEnvironment(runSecrets(), ports), ...changes, ADMIN_API_PORT: String(port) };
  const started = run(`admin-api-${label}-${port}`, 'node', ['dist/main-admin'], { cwd: path.join(REPO_ROOT, 'apps/api'), env });
  try {
    await waitForUrl(started, `http://127.0.0.1:${port}/api/health`);
  } catch (error) {
    await stopAll([started]);
    throw error;
  }
  return { url: `http://127.0.0.1:${port}`, stop: () => stopAll([started]) };
}

/** Marks an account a super admin (the flag `admin:grant` sets), for a second staff member. */
export async function makeSuperAdmin(userId: string): Promise<void> {
  const rows = await query(`UPDATE users SET is_super_admin = true WHERE id = $1 RETURNING id`, [userId]);
  if (rows.length !== 1) throw new Error(`No users row ${userId}`);
}

/**
 * Moves the staff member's sign-in 20 minutes back, past the 15 minutes a recent sign-in
 * lasts. The next token the admin app refreshes (a page load) carries the old time.
 */
export async function makeStaffSignInStale(userId: string): Promise<void> {
  await query(
    `UPDATE staff_sessions SET authenticated_at = now() - interval '20 minutes' WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

export interface SeededPayment {
  id: string;
  providerId: string;
}

/**
 * A payment row as the webhook would store one (amounts in paise, no card or contact
 * data), for states that need a chosen time or refund: `paidAgoSeconds` back from now.
 */
export async function seedPayment(
  userId: string,
  fields: {
    amount: number;
    status: 'captured' | 'failed' | 'refunded';
    refunded?: number;
    method?: string | null;
    failureReason?: string | null;
    paidAgoSeconds?: number;
    subscriptionId?: string | null;
    taxRateBps?: number;
  },
): Promise<SeededPayment> {
  const providerId = `pay_e2e${randomBytes(6).toString('hex')}`;
  const [row] = await query<{ id: string }>(
    `INSERT INTO billing_payments
       (provider_payment_id, user_id, subscription_id, provider_invoice_id, amount_paise, amount_refunded_paise, tax_rate_bps,
        currency, status, method, failure_reason, paid_at)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, 'INR', $7, $8, $9, now() - make_interval(secs => $10))
     RETURNING id`,
    [
      providerId,
      userId,
      fields.subscriptionId ?? null,
      fields.amount,
      fields.refunded ?? 0,
      fields.taxRateBps ?? 0,
      fields.status,
      fields.method === undefined ? 'upi' : fields.method,
      fields.failureReason ?? null,
      fields.paidAgoSeconds ?? 0,
    ],
  );
  return { id: row.id, providerId };
}

/** An invoice row as the webhook would store one. */
export async function seedInvoice(
  userId: string,
  fields: {
    number?: string | null;
    shortUrl?: string | null;
    status?: string;
    amount?: number;
    tax?: number;
    currency?: string;
    issued?: boolean;
    paid?: boolean;
    subscriptionId?: string | null;
  },
): Promise<{ id: string; providerId: string }> {
  const providerId = `inv_e2e${randomBytes(6).toString('hex')}`;
  const [row] = await query<{ id: string }>(
    `INSERT INTO billing_invoices
       (provider_invoice_id, user_id, subscription_id, status, amount_paise, tax_paise, provider_tax_paise, currency,
        period_start, period_end, issued_at, paid_at, short_url, number)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, now(), now() + interval '30 days',
             CASE WHEN $8 THEN now() END, CASE WHEN $9 THEN now() END, $10, $11)
     RETURNING id`,
    [
      providerId,
      userId,
      fields.subscriptionId ?? null,
      fields.status ?? 'paid',
      fields.amount ?? 49_900,
      fields.tax ?? 0,
      fields.currency ?? 'INR',
      fields.issued ?? true,
      fields.paid ?? true,
      fields.shortUrl ?? null,
      fields.number === undefined ? `INV-E2E-${randomBytes(2).toString('hex')}` : fields.number,
    ],
  );
  return { id: row.id, providerId };
}

/**
 * A subscription row with any status, on a chosen price, that the mock has never heard of:
 * for history the card lists (statuses the flow takes weeks to reach, a replaced one).
 * Never the account's current or next.
 */
export async function seedSubscriptionRow(
  userId: string,
  price: { id: string },
  planCode: string,
  fields: { status: string; supersededBy?: string | null; method?: string | null; cancelAtPeriodEnd?: boolean },
): Promise<{ id: string; providerId: string }> {
  const providerId = `sub_e2eseed${randomBytes(6).toString('hex')}`;
  return withDb(async (db) => {
    await db.query(`INSERT INTO billing_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    const { rows } = await db.query(
      `INSERT INTO billing_subscriptions
         (user_id, provider_subscription_id, price_id, plan_code, interval, status, method, current_start, current_end, charge_at,
          paid_count, was_current, superseded_by, cancel_at_period_end, last_event_at, last_event_rank, created_by)
       VALUES ($1, $2, $3, $4, 'monthly', $5, $6, now(), now() + interval '30 days', now() + interval '30 days',
          1, false, $7, $8, now(), 2, $1)
       RETURNING id`,
      [userId, providerId, price.id, planCode, fields.status, fields.method ?? null, fields.supersededBy ?? null, fields.cancelAtPeriodEnd ?? false],
    );
    return { id: rows[0].id as string, providerId };
  });
}

/**
 * Razorpay's invoice fixture for `event` (`invoice.paid` or `invoice.expired`, the API's own
 * test copies of the documented bodies) with the run's ids, sent signed. `invoiceId`
 * repeats an earlier invoice; `createdAt` orders it.
 */
export async function sendInvoiceEvent(
  event: 'invoice.paid' | 'invoice.expired',
  fields: {
    subscriptionId: string;
    customerId: string;
    number: string;
    amount: number;
    invoiceId?: string;
    shortUrl?: string | null;
    createdAt?: number;
  },
): Promise<SentEvent & { invoiceId: string }> {
  const fixture = JSON.parse(
    JSON.stringify(require(path.join(REPO_ROOT, `apps/api/src/modules/billing/providers/__fixtures__/razorpay/${event}.json`))),
  );
  const invoiceId = fields.invoiceId ?? `inv_e2e${randomBytes(6).toString('hex')}`;
  const createdAt = fields.createdAt ?? nowSeconds();
  const paid = event === 'invoice.paid';
  const paymentId = paid ? `pay_e2e${randomBytes(6).toString('hex')}` : null;
  const invoice = fixture.payload.invoice.entity;
  Object.assign(invoice, {
    id: invoiceId,
    subscription_id: fields.subscriptionId,
    customer_id: fields.customerId,
    order_id: null,
    payment_id: paymentId,
    invoice_number: fields.number,
    amount: fields.amount,
    amount_paid: paid ? fields.amount : 0,
    amount_due: paid ? 0 : fields.amount,
    gross_amount: fields.amount,
    taxable_amount: fields.amount,
    tax_amount: 0,
    billing_start: createdAt,
    billing_end: createdAt + 30 * DAY_SECONDS,
    issued_at: createdAt,
    paid_at: paid ? createdAt : null,
    expired_at: paid ? null : createdAt,
    short_url: fields.shortUrl ?? null,
    status: paid ? 'paid' : 'expired',
  });
  if (paid) {
    Object.assign(fixture.payload.payment.entity, {
      id: paymentId,
      invoice_id: invoiceId,
      order_id: null,
      amount: fields.amount,
      customer_id: fields.customerId,
      created_at: createdAt,
    });
    delete fixture.payload.order;
    fixture.contains = ['payment', 'invoice'];
  } else {
    fixture.contains = ['invoice'];
  }
  fixture.created_at = createdAt;
  const rawBody = JSON.stringify(fixture);
  const eventId = newEventId();
  return { ...(await postWebhook(rawBody, { eventId })), eventId, rawBody, invoiceId };
}

/** The admin app's payment time ("15 Nov 2026, 10:20"), in UTC. */
export function gbDateTime(at: string | Date): string {
  return new Date(at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

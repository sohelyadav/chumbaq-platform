import { createHmac, randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { adminApi } from './admin';
import { apiUrl } from './api';
import { runSecrets } from './stack';

/**
 * Billing against the local Razorpay mock (support/razorpay-mock.ts): plans made through
 * the admin API, Razorpay Checkout replaced in the browser, and the webhooks Razorpay
 * would send, signed with the run's (fake) webhook secret.
 */

function mockUrl(path: string): string {
  const base = process.env.E2E_RAZORPAY_MOCK_URL;
  if (!base) throw new Error('E2E_RAZORPAY_MOCK_URL is not set: run the specs through playwright.config.ts');
  return `${base}${path}`;
}

async function mock<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(mockUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`mock ${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export interface PaidPlan {
  code: string;
  name: string;
  pricePaise: number;
  razorpayPlanId: string;
}

/**
 * A plan with a monthly price, as staff make one: the plan, then the Razorpay plan
 * (here registered with the mock), then the price, which the API checks against it.
 */
export async function createPaidPlan(staffToken: string, ip: string, pricePaise = 49_900): Promise<PaidPlan> {
  const suffix = randomBytes(3).toString('hex');
  const plan = { code: `e2e_growth_${suffix}`, name: `E2E Growth ${suffix}` };
  await adminApi(
    'POST',
    '/api/admin/plans',
    { ...plan, mauLimit: 10_000, projectLimit: 20, seatLimit: 10, sortOrder: 10, reason: 'E2E: a plan to buy' },
    staffToken,
    ip,
  );
  const razorpayPlanId = `plan_${randomBytes(7).toString('hex')}`;
  await mock('POST', '/__mock/plans', { id: razorpayPlanId, period: 'monthly', amount: pricePaise });
  await adminApi(
    'POST',
    `/api/admin/plans/${plan.code}/prices`,
    { interval: 'monthly', pricePaise, razorpayPlanId, reason: 'E2E: its monthly price' },
    staffToken,
    ip,
  );
  return { ...plan, pricePaise, razorpayPlanId };
}

/**
 * Stands in for Razorpay Checkout in this page: `open()` reports success to the
 * dashboard's handler, as a completed payment or mandate would. Nothing is charged and
 * nothing changes on the server: that is the webhook's job.
 */
export async function stubRazorpayCheckout(page: Page): Promise<void> {
  await page.route('https://checkout.razorpay.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.Razorpay = function (options) {
          this.open = function () {
            window.__e2eCheckouts = (window.__e2eCheckouts || []).concat([options.subscription_id]);
            setTimeout(function () {
              options.handler({
                razorpay_payment_id: 'pay_e2e' + Date.now(),
                razorpay_subscription_id: options.subscription_id,
                razorpay_signature: 'e2e',
              });
            }, 50);
          };
        };`,
    }),
  );
}

type Raw = Record<string, unknown>;

/** The mock's copy of a subscription the API created. */
export function mockSubscription(id: string): Promise<Raw> {
  return mock<Raw>('GET', `/__mock/subscriptions/${id}`);
}

/**
 * Moves a subscription at the mock and sends the webhook Razorpay would send for it:
 * HMAC-SHA256 of the raw body under the webhook secret in X-Razorpay-Signature, and a
 * fresh x-razorpay-event-id.
 */
export async function sendSubscriptionEvent(event: string, subscriptionId: string, changes: Raw): Promise<void> {
  const entity = await mock<Raw>('PATCH', `/__mock/subscriptions/${subscriptionId}`, changes);
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_e2eMockOnly01',
    event,
    contains: ['subscription'],
    payload: { subscription: { entity } },
    created_at: Math.floor(Date.now() / 1000),
  });
  const signature = createHmac('sha256', runSecrets().razorpayWebhookSecret).update(body).digest('hex');
  const response = await fetch(apiUrl('/api/billing/webhooks/razorpay'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
      'x-razorpay-event-id': `evt_e2e${randomBytes(6).toString('hex')}`,
    },
    body,
  });
  if (response.status !== 200) throw new Error(`webhook ${event} answered ${response.status}: ${await response.text()}`);
}

export const DAY_SECONDS = 24 * 60 * 60;
export const nowSeconds = () => Math.floor(Date.now() / 1000);

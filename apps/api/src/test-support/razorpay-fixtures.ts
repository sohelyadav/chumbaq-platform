import { readFileSync } from 'fs';
import * as path from 'path';
import type { BillingEvent } from '../modules/billing/providers/billing-provider';
import { parseRazorpayEvent } from '../modules/billing/providers/razorpay-payload';

const FIXTURES = path.join(__dirname, '../modules/billing/providers/__fixtures__/razorpay');

/**
 * The fields a scenario may change in a fixture copied from Razorpay's docs: ids,
 * timestamps, statuses, the plan id and amounts. Everything else stays as Razorpay
 * documented it, so a spec cannot drift into a payload Razorpay never sends.
 */
const OVERRIDABLE = new Set([
  'id',
  'plan_id',
  'customer_id',
  'subscription_id',
  'payment_id',
  'invoice_id',
  'status',
  'created_at',
  'current_start',
  'current_end',
  'start_at',
  'charge_at',
  'ended_at',
  'paid_count',
  'billing_start',
  'billing_end',
  'issued_at',
  'paid_at',
  'amount',
  'amount_refunded',
  'amount_paid',
  'amount_due',
  'gross_amount',
  'tax_amount',
]);

/** A fixture as Razorpay sent it, parsed from its file. */
export function razorpayFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

/**
 * A fixture with some fields changed, by dotted path (`payload.subscription.entity.id`).
 * The last segment must be one of `OVERRIDABLE`, and every segment before it must
 * already exist, so an override can only change a value, never invent a shape.
 */
export function razorpayBody(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = razorpayFixture(name);
  for (const [dotted, value] of Object.entries(overrides)) {
    const parts = dotted.split('.');
    const key = parts.pop() as string;
    if (!OVERRIDABLE.has(key)) throw new Error(`razorpayBody: ${key} may not be overridden`);
    let at: Record<string, unknown> = body;
    for (const part of parts) {
      const next = at[part];
      if (typeof next !== 'object' || next === null) throw new Error(`razorpayBody: ${dotted} is not in ${name}`);
      at = next as Record<string, unknown>;
    }
    at[key] = value;
  }
  return body;
}

/** `razorpayBody`, read by the real parser. */
export function razorpayEvent(name: string, overrides: Record<string, unknown> = {}): BillingEvent {
  return parseRazorpayEvent(razorpayBody(name, overrides));
}

/** Unix seconds of a date, as Razorpay stamps times. */
export function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

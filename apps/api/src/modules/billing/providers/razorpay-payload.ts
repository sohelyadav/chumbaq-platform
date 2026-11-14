import { isSubscriptionStatus } from '../billing-values';
import type {
  BillingEvent,
  ProviderInvoice,
  ProviderPayment,
  ProviderPaymentStatus,
  ProviderPlan,
  ProviderRefund,
  ProviderSubscription,
} from './billing-provider';

/**
 * Reading Razorpay's webhook bodies and API replies into the normalised types, and
 * the copy of a webhook that is kept.
 *
 * Everything is checked for type: an id that is not a Razorpay-shaped string, an
 * amount that is not whole non-negative paise, a timestamp that is not integer Unix
 * seconds, or a status we do not know refuses the whole payload with
 * `InvalidPayloadError`, whose message names the field and never its value.
 *
 * Quirks of Razorpay's own examples that are accepted: `captured` is `"1"` in some
 * and `true` in others (it is not read: `status` says the same), and `notes` is `[]`
 * on payments but an object elsewhere (never read, never kept).
 */
export class InvalidPayloadError extends Error {
  constructor(readonly field: string) {
    super(`Invalid Razorpay payload: ${field}`);
    this.name = 'InvalidPayloadError';
  }
}

/** Razorpay ids (`sub_…`, `pay_…`, `inv_…`) as far as we accept them, also before putting one in a URL path. */
export const RAZORPAY_ID_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

/** The webhook events billing subscribes to. Any other event is kept but carries no entities. */
export const RAZORPAY_EVENTS = [
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.completed',
  'subscription.updated',
  'payment.failed',
  'invoice.paid',
  'invoice.expired',
  'refund.processed',
] as const;
export type RazorpayEventType = (typeof RAZORPAY_EVENTS)[number];

export function isRazorpayEventType(value: string): value is RazorpayEventType {
  return (RAZORPAY_EVENTS as readonly string[]).includes(value);
}

const PAYMENT_STATUSES: Record<ProviderPaymentStatus, true> = {
  created: true,
  authorized: true,
  captured: true,
  refunded: true,
  failed: true,
};

const ERROR_DESCRIPTION_CHARS = 320;

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, field: string): Raw {
  if (!isObject(value)) throw new InvalidPayloadError(field);
  return value;
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !RAZORPAY_ID_PATTERN.test(value)) throw new InvalidPayloadError(field);
  return value;
}

function optionalId(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : id(value, field);
}

function paise(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InvalidPayloadError(field);
  return value;
}

function paiseOrZero(value: unknown, field: string): number {
  return value === null || value === undefined ? 0 : paise(value, field);
}

function seconds(value: unknown, field: string): Date {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InvalidPayloadError(field);
  return new Date(value * 1000);
}

function optionalSeconds(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : seconds(value, field);
}

function text(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) throw new InvalidPayloadError(field);
  return value;
}

function optionalText(value: unknown, field: string, maxChars: number): string | null {
  return value === null || value === undefined ? null : text(value, field, maxChars);
}

export function toProviderSubscription(raw: unknown, at = 'subscription'): ProviderSubscription {
  const s = object(raw, at);
  if (!isSubscriptionStatus(s.status)) throw new InvalidPayloadError(`${at}.status`);
  return {
    id: id(s.id, `${at}.id`),
    planId: id(s.plan_id, `${at}.plan_id`),
    customerId: optionalId(s.customer_id, `${at}.customer_id`),
    status: s.status,
    currentStart: optionalSeconds(s.current_start, `${at}.current_start`),
    currentEnd: optionalSeconds(s.current_end, `${at}.current_end`),
    startAt: optionalSeconds(s.start_at, `${at}.start_at`),
    chargeAt: optionalSeconds(s.charge_at, `${at}.charge_at`),
    endedAt: optionalSeconds(s.ended_at, `${at}.ended_at`),
    paidCount: paiseOrZero(s.paid_count, `${at}.paid_count`),
    shortUrl: optionalText(s.short_url, `${at}.short_url`, 2048),
  };
}

export function toProviderPayment(raw: unknown, at = 'payment'): ProviderPayment {
  const p = object(raw, at);
  const status = p.status;
  if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(PAYMENT_STATUSES, status)) {
    throw new InvalidPayloadError(`${at}.status`);
  }
  const description = p.error_description;
  if (description !== null && description !== undefined && typeof description !== 'string') {
    throw new InvalidPayloadError(`${at}.error_description`);
  }
  return {
    id: id(p.id, `${at}.id`),
    amountPaise: paise(p.amount, `${at}.amount`),
    currency: text(p.currency, `${at}.currency`, 8),
    status: status as ProviderPaymentStatus,
    method: optionalText(p.method, `${at}.method`, 20),
    invoiceId: optionalId(p.invoice_id, `${at}.invoice_id`),
    orderId: optionalId(p.order_id, `${at}.order_id`),
    customerId: optionalId(p.customer_id, `${at}.customer_id`),
    amountRefundedPaise: paiseOrZero(p.amount_refunded, `${at}.amount_refunded`),
    errorReason: optionalText(p.error_reason, `${at}.error_reason`, 64),
    errorDescription: description ? description.slice(0, ERROR_DESCRIPTION_CHARS) : null,
    createdAt: seconds(p.created_at, `${at}.created_at`),
  };
}

export function toProviderInvoice(raw: unknown, at = 'invoice'): ProviderInvoice {
  const i = object(raw, at);
  return {
    id: id(i.id, `${at}.id`),
    subscriptionId: optionalId(i.subscription_id, `${at}.subscription_id`),
    customerId: optionalId(i.customer_id, `${at}.customer_id`),
    paymentId: optionalId(i.payment_id, `${at}.payment_id`),
    status: text(i.status, `${at}.status`, 32),
    amountPaise: paise(i.amount, `${at}.amount`),
    providerTaxPaise: paiseOrZero(i.tax_amount, `${at}.tax_amount`),
    currency: text(i.currency, `${at}.currency`, 8),
    billingStart: optionalSeconds(i.billing_start, `${at}.billing_start`),
    billingEnd: optionalSeconds(i.billing_end, `${at}.billing_end`),
    issuedAt: optionalSeconds(i.issued_at, `${at}.issued_at`),
    paidAt: optionalSeconds(i.paid_at, `${at}.paid_at`),
    shortUrl: optionalText(i.short_url, `${at}.short_url`, 2048),
    number: optionalText(i.invoice_number, `${at}.invoice_number`, 64),
  };
}

export function toProviderRefund(raw: unknown, at = 'refund'): ProviderRefund {
  const r = object(raw, at);
  return {
    id: id(r.id, `${at}.id`),
    paymentId: id(r.payment_id, `${at}.payment_id`),
    amountPaise: paise(r.amount, `${at}.amount`),
    status: text(r.status, `${at}.status`, 32),
    createdAt: seconds(r.created_at, `${at}.created_at`),
  };
}

export function toProviderPlan(raw: unknown, at = 'plan'): ProviderPlan {
  const p = object(raw, at);
  const item = object(p.item, `${at}.item`);
  const interval = p.interval;
  if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1) {
    throw new InvalidPayloadError(`${at}.interval`);
  }
  return {
    id: id(p.id, `${at}.id`),
    period: text(p.period, `${at}.period`, 16),
    interval,
    amountPaise: paise(item.amount, `${at}.item.amount`),
    currency: text(item.currency, `${at}.item.currency`, 8),
  };
}

/** The entity of `payload.<name>.entity`, or null when the event does not carry it. */
function entity(payload: Raw | null, name: string): unknown {
  if (!payload || payload[name] === undefined || payload[name] === null) return null;
  const wrapper = object(payload[name], `payload.${name}`);
  return wrapper.entity === undefined || wrapper.entity === null ? null : wrapper.entity;
}

export function parseRazorpayEvent(body: unknown): BillingEvent {
  const b = object(body, 'body');
  const type = text(b.event, 'event', 64);
  const createdAt = seconds(b.created_at, 'created_at');
  const none: BillingEvent = { type, createdAt, subscription: null, payment: null, invoice: null, refund: null };
  // An event we do not subscribe to (another product on the same Razorpay account,
  // or one added later) is not read further, so a shape we never agreed to cannot fail it.
  if (!isRazorpayEventType(type)) return none;

  const payload = b.payload === undefined || b.payload === null ? null : object(b.payload, 'payload');
  const subscription = entity(payload, 'subscription');
  const payment = entity(payload, 'payment');
  const invoice = entity(payload, 'invoice');
  const refund = entity(payload, 'refund');
  return {
    ...none,
    subscription: subscription === null ? null : toProviderSubscription(subscription),
    payment: payment === null ? null : toProviderPayment(payment),
    invoice: invoice === null ? null : toProviderInvoice(invoice),
    refund: refund === null ? null : toProviderRefund(refund),
  };
}

/**
 * What a stored webhook keeps of each entity. Allow-listed, so a field Razorpay adds
 * later is dropped until someone decides it may be kept: nothing naming a person or
 * their payment instrument (card, bank, VPA, wallet, email, contact, customer details,
 * addresses, GSTIN, notes, acquirer data, token or card ids) is ever stored.
 */
export const STORED_FIELDS = {
  subscription: [
    'id',
    'plan_id',
    'customer_id',
    'status',
    'current_start',
    'current_end',
    'start_at',
    'end_at',
    'charge_at',
    'ended_at',
    'paid_count',
    'remaining_count',
    'total_count',
    'has_scheduled_changes',
    'change_scheduled_at',
    'short_url',
  ],
  payment: [
    'id',
    'amount',
    'currency',
    'status',
    'method',
    'invoice_id',
    'order_id',
    'customer_id',
    'amount_refunded',
    'refund_status',
    'captured',
    'international',
    'error_code',
    'error_reason',
    'error_source',
    'error_step',
    'error_description',
    'created_at',
  ],
  invoice: [
    'id',
    'subscription_id',
    'customer_id',
    'payment_id',
    'status',
    'amount',
    'amount_paid',
    'amount_due',
    'gross_amount',
    'tax_amount',
    'taxable_amount',
    'currency',
    'billing_start',
    'billing_end',
    'issued_at',
    'paid_at',
    'expired_at',
    'cancelled_at',
    'short_url',
    'invoice_number',
    'created_at',
  ],
  refund: ['id', 'payment_id', 'amount', 'currency', 'status', 'created_at'],
} as const;

type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function pick(source: Raw, keys: readonly string[]): Record<string, Scalar> {
  const kept: Record<string, Scalar> = {};
  for (const key of keys) {
    const value = source[key];
    // Scalars only: an object under an allowed name is not a shape we agreed to keep.
    if (Object.prototype.hasOwnProperty.call(source, key) && isScalar(value)) kept[key] = value;
  }
  return kept;
}

/**
 * The copy of a webhook body that is stored, in Razorpay's own shape so that
 * `parseRazorpayEvent` reads it as it read the original. Nothing is parsed or
 * refused here: this runs only on a body whose signature has been verified.
 */
export function storedPayload(body: unknown): Record<string, unknown> {
  if (!isObject(body)) return {};
  const kept: Record<string, unknown> = pick(body, ['event', 'created_at', 'account_id']);
  if (Array.isArray(body.contains)) {
    kept.contains = body.contains.filter((name): name is string => typeof name === 'string');
  }
  if (isObject(body.payload)) {
    const payload: Record<string, unknown> = {};
    for (const name of Object.keys(STORED_FIELDS) as Array<keyof typeof STORED_FIELDS>) {
      const wrapper = body.payload[name];
      if (isObject(wrapper) && isObject(wrapper.entity)) {
        payload[name] = { entity: pick(wrapper.entity, STORED_FIELDS[name]) };
      }
    }
    kept.payload = payload;
  }
  return kept;
}

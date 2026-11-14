import type { BillingInterval, BillingSubscriptionStatus } from '@chumbaq/shared';

/**
 * The payment provider behind paid plans, as the rest of billing sees it. Razorpay
 * is the one implementation (`RazorpayProvider`); `NullBillingProvider` stands in
 * while billing is off, so nothing can reach a provider by accident.
 *
 * There is deliberately no "update subscription": Razorpay refuses plan changes on
 * subscriptions paid by UPI or e-mandate, and on domestic cards allows changing only
 * the offer. Every plan change is a new subscription that starts when the current
 * period ends, with the old one cancelled at the end of its cycle.
 *
 * Amounts are whole paise, read as integers and never through a float.
 */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

export interface ProviderSubscription {
  id: string;
  planId: string;
  customerId: string | null;
  status: BillingSubscriptionStatus;
  currentStart: Date | null;
  currentEnd: Date | null;
  startAt: Date | null;
  chargeAt: Date | null;
  endedAt: Date | null;
  paidCount: number;
  shortUrl: string | null;
}

export type ProviderPaymentStatus = 'captured' | 'failed' | 'authorized' | 'refunded' | 'created';

export interface ProviderPayment {
  id: string;
  amountPaise: number;
  currency: string;
  status: ProviderPaymentStatus;
  method: string | null;
  invoiceId: string | null;
  orderId: string | null;
  customerId: string | null;
  /** Cumulative: it only rises, so the greatest value seen is the truth. */
  amountRefundedPaise: number;
  errorReason: string | null;
  errorDescription: string | null;
  createdAt: Date;
}

export interface ProviderInvoice {
  id: string;
  subscriptionId: string | null;
  customerId: string | null;
  paymentId: string | null;
  status: string;
  /** What the customer pays, the provider's tax included. */
  amountPaise: number;
  /** The tax the provider put on the invoice. Our own GST comes from the price row, never from this. */
  providerTaxPaise: number;
  currency: string;
  billingStart: Date | null;
  billingEnd: Date | null;
  issuedAt: Date | null;
  paidAt: Date | null;
  shortUrl: string | null;
  number: string | null;
}

export interface ProviderRefund {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: string;
  createdAt: Date;
}

export interface ProviderPlan {
  id: string;
  period: string;
  interval: number;
  amountPaise: number;
  currency: string;
}

/** A webhook, normalised. Entities the event does not carry, or that billing does not use, are null. */
export interface BillingEvent {
  type: string;
  createdAt: Date;
  subscription: ProviderSubscription | null;
  payment: ProviderPayment | null;
  invoice: ProviderInvoice | null;
  refund: ProviderRefund | null;
}

/**
 * The provider answered, and not with a 2xx. `description` is the provider's own
 * text, cut short: log it only through `logValue`, and never show it to a customer.
 * The message names the status and code only.
 */
export class BillingProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly description: string | null,
  ) {
    super(`Billing provider answered ${status}${code ? ` ${code}` : ''}`);
    this.name = 'BillingProviderError';
  }
}

export interface BillingProvider {
  readonly enabled: boolean;
  /** Public: Checkout in the browser needs it. Null while billing is off. */
  readonly keyId: string | null;
  createCustomer(input: { name: string; email: string; gstin: string | null; accountRef: string }): Promise<{ id: string }>;
  createSubscription(input: {
    planId: string;
    totalCount: number;
    startAt: Date | null;
    expireBy: Date;
    accountRef: string;
  }): Promise<ProviderSubscription>;
  cancelSubscription(id: string, atCycleEnd: boolean): Promise<ProviderSubscription>;
  fetchSubscription(id: string): Promise<ProviderSubscription>;
  fetchPlan(id: string): Promise<ProviderPlan>;
  listSubscriptionInvoices(subscriptionId: string): Promise<ProviderInvoice[]>;
  notifyInvoiceByEmail(invoiceId: string): Promise<void>;
  /** Over the raw bytes received, before anything is parsed. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
  parseWebhook(body: unknown): BillingEvent;
}

/**
 * Billing cycles a subscription is created for. Razorpay requires a count; these
 * are long enough to mean "until cancelled" (ten years either way).
 */
export const SUBSCRIPTION_TOTAL_COUNT: Record<BillingInterval, number> = { monthly: 120, yearly: 10 };

/** A subscription not authorised within this long expires at the provider, so an abandoned Checkout dies on its own. */
export const CHECKOUT_EXPIRY_MS = 24 * 3600_000;

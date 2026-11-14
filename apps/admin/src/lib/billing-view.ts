import type { BillingAccountState, BillingInterval, BillingSubscriptionStatus } from '@chumbaq/shared';

/** The plan every account has with no subscription or comp. */
export const FREE_PLAN = 'free';

/** The API's plan code rule, so a bad code is said before the request. */
export const PLAN_CODE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
/** Razorpay's plan ids, as the API checks them. */
export const RAZORPAY_PLAN_ID_PATTERN = /^plan_[A-Za-z0-9]{14}$/;

export const BILLING_STATE_LABELS: Record<BillingAccountState, string> = {
  free: 'No paid plan',
  checkout: 'Waiting for payment',
  active: 'Active',
  past_due: 'Payment being retried',
  halted: 'Payment failed',
  cancelling: 'Ends at the period end',
  change_scheduled: 'Plan change scheduled',
  upgrade_pending: 'Upgraded, first charge due',
  comped: 'Complimentary',
};

export const SUBSCRIPTION_STATUS_LABELS: Record<BillingSubscriptionStatus, string> = {
  created: 'Checkout opened',
  authenticated: 'Authorised',
  active: 'Active',
  pending: 'Retrying payment',
  halted: 'Halted',
  cancelled: 'Cancelled',
  completed: 'Completed',
  expired: 'Expired',
};

export function intervalLabel(interval: BillingInterval): string {
  return interval === 'monthly' ? 'Monthly' : 'Yearly';
}

/** "Unlimited" for a null MAU or seat limit. */
export function limitLabel(limit: number | null): string {
  return limit === null ? 'Unlimited' : limit.toLocaleString('en-US');
}

/** A null project limit is the server's default, `MAX_PROJECTS_PER_ACCOUNT`. */
export function projectLimitLabel(limit: number | null, serverDefault?: number): string {
  if (limit !== null) return limit.toLocaleString('en-US');
  return serverDefault === undefined ? 'Default' : `Default (${serverDefault})`;
}

/**
 * A whole number from 1 up to `max`, or null for blank (no limit). Anything else is
 * `undefined`: not a limit, so the form says so instead of sending it.
 */
export function parseLimit(input: string, max = Number.MAX_SAFE_INTEGER): number | null | undefined {
  const text = input.trim().replace(/,/g, '');
  if (text === '') return null;
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
}

/**
 * A provider link (an invoice's page) for an `href`: only an absolute https URL, so a
 * stored value can never become a `javascript:` or other scheme link. Null otherwise.
 */
export function safeProviderUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

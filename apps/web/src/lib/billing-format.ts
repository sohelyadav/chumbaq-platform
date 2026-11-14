import type {
  BillingAccountState,
  BillingInterval,
  BillingPlanOption,
  BillingPrice,
} from '@chumbaq/shared';

/** The plan every account has with no subscription; never bought. */
export const FREE_PLAN = 'free';

/**
 * Integer paise as rupees with Indian digit grouping: 117882 → "₹1,178.82",
 * 1234567800 → "₹1,23,45,678.00". String arithmetic on the integer only, never a
 * division into a float, so every amount prints exactly. Anything but a safe integer
 * throws: a fractional paise is a bug upstream, not something to round away.
 */
export function formatPaise(paise: number): string {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise)) {
    throw new Error(`Not a whole number of paise: ${String(paise)}`);
  }
  const sign = paise < 0 ? '-' : '';
  const digits = String(Math.abs(paise)).padStart(3, '0');
  const rupees = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return `${sign}₹${groupIndian(rupees)}.${fraction}`;
}

/** "1234567" → "12,34,567": the last three digits, then pairs. */
function groupIndian(rupees: string): string {
  if (rupees.length <= 3) return rupees;
  const last = rupees.slice(-3);
  let rest = rupees.slice(0, -3);
  const pairs: string[] = [];
  while (rest.length > 2) {
    pairs.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  pairs.unshift(rest);
  return `${pairs.join(',')},${last}`;
}

export function intervalLabel(interval: BillingInterval): string {
  return interval === 'monthly' ? 'Monthly' : 'Yearly';
}

/** "₹999.00 + GST (₹179.82) a month": the price excluding GST, then the GST on it. */
export function priceLine(price: BillingPrice): string {
  const per = price.interval === 'monthly' ? 'a month' : 'a year';
  return `${formatPaise(price.pricePaise)} + GST (${formatPaise(price.taxPaise)}) ${per}`;
}

export type MauLevel = 'ok' | 'near' | 'over';

/**
 * How full this month's active devices are, for the bar: a whole percent, rounded
 * down so a bar is never full while still under the limit, and capped at 100. Near
 * is from 80%, over from the limit itself, in integer arithmetic. Unknown use or no
 * limit gives no percent.
 */
export function mauShare(
  used: number | null,
  limit: number | null,
): { percent: number | null; level: MauLevel } {
  if (used === null || limit === null) return { percent: null, level: 'ok' };
  if (used >= limit) return { percent: 100, level: used > 0 || limit > 0 ? 'over' : 'ok' };
  const percent = Math.floor((used * 100) / limit);
  return { percent, level: used * 100 >= limit * 80 ? 'near' : 'ok' };
}

/** A paid plan with a current price for the interval. */
export function canBuy(plan: BillingPlanOption, interval: BillingInterval): boolean {
  return plan.code !== FREE_PLAN && plan[interval] !== null;
}

export const BILLING_STATE_LABELS: Record<BillingAccountState, string> = {
  free: 'No paid plan',
  checkout: 'Waiting for payment',
  active: 'Active',
  past_due: 'Payment being retried',
  halted: 'Payment failed',
  cancelling: 'Ends at the period end',
  change_scheduled: 'Plan change scheduled',
  upgrade_pending: 'Upgraded, billed from the next period',
  comped: 'Complimentary',
};

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

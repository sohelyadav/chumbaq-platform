import type { BillingInterval, BillingOverview, BillingPlanOption } from '@chumbaq/shared';
import { FREE_PLAN } from './billing-format';

/**
 * The account billing page. Its first segment, `account`, is a reserved short code in
 * the links module, so no short link can be shadowed by it.
 */
export const BILLING_PATH = '/account/billing';

/** "Processing payment" asks again this often, for this long, before saying it is still waiting. */
export const POLL_INTERVAL_MS = 3000;
export const POLL_LIMIT_MS = 120_000;

/**
 * The Billing menu item: only when the API says this install takes payments, and never
 * while viewing as a tenant (the routes refuse view-as; staff see billing in the admin app).
 */
export function showBillingNav(billingEnabled: boolean | undefined, impersonating: boolean): boolean {
  return billingEnabled === true && !impersonating;
}

/**
 * What a plan card offers, for the interval shown:
 * - `current`: the plan the account is on (no button).
 * - `none`: the free plan while on another (moving to it is cancelling).
 * - `coming_soon`: a paid plan with no price for this interval.
 * - `choose`: a first subscription (also after a failed payment, or on a comp).
 * - `switch`: a change from the active subscription, starting at its period end.
 * - `keep`: the plan just cancelled, kept from its period end.
 * - `unavailable`: a payment is being retried or a change is already scheduled; the
 *   API refuses both, so the card does not offer them.
 */
export type PlanAction = 'current' | 'none' | 'coming_soon' | 'choose' | 'switch' | 'keep' | 'unavailable';

type OverviewState = Pick<BillingOverview, 'state' | 'effectivePlan' | 'current' | 'next'>;

export function planAction(plan: BillingPlanOption, interval: BillingInterval, overview: OverviewState): PlanAction {
  const { current, next } = overview;
  const activeCurrent = current?.status === 'active' ? current : null;
  if (plan.code === FREE_PLAN) return overview.effectivePlan.code === FREE_PLAN ? 'current' : 'none';

  const isCurrent = activeCurrent
    ? activeCurrent.planCode === plan.code && activeCurrent.interval === interval
    : overview.effectivePlan.code === plan.code && overview.effectivePlan.source === 'comp';
  if (isCurrent && activeCurrent?.cancelAtPeriodEnd) return plan[interval] ? 'keep' : 'coming_soon';
  if (isCurrent) return 'current';
  if (!plan[interval]) return 'coming_soon';
  if (current?.status === 'pending' || next?.status === 'authenticated') return 'unavailable';
  return activeCurrent ? 'switch' : 'choose';
}

/**
 * Whether the provider's webhook has confirmed what Checkout just did. Checkout's own
 * success callback proves nothing (anyone can call it), so the page waits for this.
 */
export function paymentConfirmed(op: 'subscribe' | 'change', overview: OverviewState): boolean {
  if (op === 'subscribe') return overview.state !== 'checkout' && overview.state !== 'free';
  return (
    overview.next?.status === 'authenticated' ||
    overview.state === 'change_scheduled' ||
    overview.state === 'upgrade_pending'
  );
}

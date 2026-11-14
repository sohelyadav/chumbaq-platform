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
 * - `current`: the plan the account is on (no button). An authorised upgrade
 *   (`upgrade_pending`) is not that plan until its first charge.
 * - `none`: the free plan while on another (moving to it is cancelling).
 * - `coming_soon`: a paid plan with no price for this interval.
 * - `choose`: a first subscription (also after a failed payment, or on a comp).
 * - `switch`: a change from the active subscription, starting at its period end.
 * - `keep`: the plan just cancelled, kept from its period end.
 * - `unavailable`: a payment is being retried or a change is already scheduled; the
 *   API refuses both, so the card does not offer them. Once a change or "keep my
 *   plan" is authorised the current subscription is set to end, which would read as
 *   a plain cancel: the scheduled change is checked first, so that is not offered.
 */
export type PlanAction = 'current' | 'none' | 'coming_soon' | 'choose' | 'switch' | 'keep' | 'unavailable';

type OverviewState = Pick<BillingOverview, 'state' | 'effectivePlan' | 'current' | 'next'>;

export function planAction(plan: BillingPlanOption, interval: BillingInterval, overview: OverviewState): PlanAction {
  const { current, next } = overview;
  const activeCurrent = current?.status === 'active' ? current : null;
  if (plan.code === FREE_PLAN) return overview.effectivePlan.code === FREE_PLAN ? 'current' : 'none';

  const blocked = current?.status === 'pending' || next?.status === 'authenticated';
  const isCurrent = activeCurrent
    ? activeCurrent.planCode === plan.code && activeCurrent.interval === interval
    : overview.effectivePlan.code === plan.code && overview.effectivePlan.source === 'comp';
  if (isCurrent && !blocked && activeCurrent?.cancelAtPeriodEnd) return plan[interval] ? 'keep' : 'coming_soon';
  if (isCurrent) return 'current';
  if (!plan[interval]) return 'coming_soon';
  if (blocked) return 'unavailable';
  return activeCurrent ? 'switch' : 'choose';
}

/**
 * What "Cancel plan" does, if it is offered:
 * - `cancel`: the current subscription ends at its period end.
 * - `drop_change`: a change or "keep my plan" is authorised to start at the period
 *   end, and cancelling drops it too. The current one is usually already set to end
 *   by then, and the successor is the only thing left that would charge.
 * - `cancel_now`: the payment failed and is being retried (halted): there is no paid
 *   period left to finish, so it ends now and the retries stop.
 * - `none`: nothing to cancel (no live subscription, or it already ends with nothing after it).
 */
export type CancelOffer = 'none' | 'cancel' | 'cancel_now' | 'drop_change';

export function cancelOffer(overview: Pick<BillingOverview, 'current' | 'next'>): CancelOffer {
  const { current, next } = overview;
  if (current?.status === 'halted') return 'cancel_now';
  if (!current || (current.status !== 'active' && current.status !== 'pending')) return 'none';
  if (next?.status === 'authenticated') return 'drop_change';
  return current.cancelAtPeriodEnd ? 'none' : 'cancel';
}

/** The subscriptions the account had when Checkout opened. */
export interface BeforeCheckout {
  currentId: string | null;
  nextId: string | null;
}

export function beforeCheckout(overview: Pick<BillingOverview, 'current' | 'next'> | undefined): BeforeCheckout {
  return { currentId: overview?.current?.id ?? null, nextId: overview?.next?.id ?? null };
}

/**
 * Whether the provider's webhook has confirmed what Checkout just did. Checkout's own
 * success callback proves nothing (anyone can call it), so the page waits for this.
 *
 * It looks at the subscription this Checkout created, never the account's state: a
 * halted account stays `halted` through its grace and a comped one stays `comped`
 * while the new subscription is only created, so the state alone would confirm early.
 * - subscribe: a subscription other than the one current before Checkout is now
 *   current and active.
 * - change: a successor other than the one waiting before Checkout is authorised, or
 *   has already started.
 */
export function paymentConfirmed(
  op: 'subscribe' | 'change',
  overview: Pick<BillingOverview, 'current' | 'next'>,
  before: BeforeCheckout,
): boolean {
  const { current, next } = overview;
  const newCurrentActive = current !== null && current.id !== before.currentId && current.status === 'active';
  if (op === 'subscribe') return newCurrentActive;
  return (next !== null && next.id !== before.nextId && next.status === 'authenticated') || newCurrentActive;
}

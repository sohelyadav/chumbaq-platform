import type {
  BillingAccountState,
  BillingInterval,
  BillingPlanSource,
  BillingSubscriptionStatus,
  PlanLimits,
} from '@chumbaq/shared';

/**
 * An account's plan, derived from its subscriptions and comp rather than stored,
 * so there is one rule and no second copy to fall out of step. The SQL mirror in
 * `effective-plan-sql.ts` is held equal to this by an integration spec.
 *
 * The rules, in order:
 * 1. An active comp (no end, or ending after now) gives its plan.
 * 2. An `authenticated` next subscription with a start, until a day after that
 *    start, gives its plan when the current subscription is live and it outranks
 *    the current plan, or when the current subscription is not live and its start
 *    is at most a day away. An upgrade over a live (paid) current counts from
 *    authorisation; a downgrade or interval switch waits for it to activate.
 *    Authorising is only a mandate, with nothing charged, so with no live current
 *    paying for the time before the start, a successor counts only once it is
 *    about to charge: never for months on a mandate alone.
 * 3. A live current subscription gives its plan, until its period end when it is
 *    cancelling.
 * 4. Otherwise the free plan.
 */

export interface SubscriptionState {
  planCode: string;
  interval: BillingInterval;
  status: BillingSubscriptionStatus;
  currentEnd: Date | null;
  startAt: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface AccountBillingState {
  comp: { planCode: string; until: Date | null } | null;
  current: SubscriptionState | null;
  next: SubscriptionState | null;
}

export interface EffectivePlan {
  planCode: string;
  source: BillingPlanSource;
  until: Date | null;
}

export const FREE_PLAN = 'free';

/** How long past its start an authenticated successor still counts, waiting for its activation webhook. */
export const SUCCESSOR_START_SLACK_MS = 24 * 3600_000;

/**
 * How long before its start an authenticated successor counts when no live current
 * subscription covers the time before it.
 */
export const SUCCESSOR_LEAD_MS = 24 * 3600_000;

/** How long past its period end a cancelling subscription still counts, waiting for its cancelled webhook. */
export const CANCEL_END_SLACK_MS = 24 * 3600_000;

/** Whether a subscription gives its plan now. */
export function isLive(s: SubscriptionState | null, now: Date): boolean {
  if (!s) return false;
  switch (s.status) {
    case 'active':
      return !(s.cancelAtPeriodEnd && s.currentEnd && now.getTime() > s.currentEnd.getTime() + CANCEL_END_SLACK_MS);
    case 'pending':
      return true;
    case 'halted':
      return s.graceUntil !== null && now.getTime() < s.graceUntil.getTime();
    default:
      return false;
  }
}

function compActive(state: AccountBillingState, now: Date): boolean {
  return state.comp !== null && (state.comp.until === null || state.comp.until.getTime() > now.getTime());
}

/** Rank of what the current subscription gives: its plan while live, else free. */
function currentRank(state: AccountBillingState, now: Date, rank: (planCode: string) => number): number {
  return isLive(state.current, now) && state.current ? rank(state.current.planCode) : rank(FREE_PLAN);
}

function successorCounts(state: AccountBillingState, now: Date, rank: (planCode: string) => number): boolean {
  const next = state.next;
  if (!next || next.status !== 'authenticated' || !next.startAt) return false;
  if (now.getTime() >= next.startAt.getTime() + SUCCESSOR_START_SLACK_MS) return false;
  if (isLive(state.current, now)) return rank(next.planCode) > currentRank(state, now, rank);
  return next.startAt.getTime() <= now.getTime() + SUCCESSOR_LEAD_MS;
}

export function effectivePlan(
  state: AccountBillingState,
  now: Date,
  rank: (planCode: string) => number,
): EffectivePlan {
  if (compActive(state, now) && state.comp) {
    return { planCode: state.comp.planCode, source: 'comp', until: state.comp.until };
  }
  if (successorCounts(state, now, rank) && state.next) {
    return { planCode: state.next.planCode, source: 'subscription', until: null };
  }
  if (isLive(state.current, now) && state.current) {
    const current = state.current;
    return {
      planCode: current.planCode,
      source: 'subscription',
      until: current.cancelAtPeriodEnd ? current.currentEnd : null,
    };
  }
  return { planCode: FREE_PLAN, source: 'free', until: null };
}

export function accountState(
  state: AccountBillingState,
  now: Date,
  rank: (planCode: string) => number,
): BillingAccountState {
  if (compActive(state, now)) return 'comped';
  const next = state.next;
  if (next && successorCounts(state, now, rank) && rank(next.planCode) > currentRank(state, now, rank)) {
    return 'upgrade_pending';
  }
  if (next?.status === 'authenticated') return 'change_scheduled';
  const live = isLive(state.current, now);
  if (next?.status === 'created' && !live) return 'checkout';
  const current = state.current;
  if (!current || !live) return 'free';
  switch (current.status) {
    case 'active':
      return current.cancelAtPeriodEnd ? 'cancelling' : 'active';
    case 'pending':
      return 'past_due';
    case 'halted':
      return 'halted';
    default:
      return 'free';
  }
}

/**
 * The limits an account is held to.
 *
 * Billing off (self-hosted installs): exactly what they were before plans, the
 * staff override or the install's default, and no MAU limit.
 *
 * Billing on: the plan's limits, with a null project limit meaning the install's
 * default. A null seat limit means the install's default on the free plan (so
 * switching billing on never lifts the seat limit free accounts had) and unlimited
 * on a paid or comped plan. On the free plan the staff override replaces the
 * plan's limit either way (staff can lower a free account as well as raise it); on
 * a paid or comped plan it can only raise it, and a plan with no seat limit stays
 * unlimited. A plan code with no row (dev before the free row exists) takes the
 * install's defaults.
 */
export function effectiveLimits(input: {
  billingEnabled: boolean;
  override: { projectLimit: number | null; seatLimit: number | null };
  plan: PlanLimits | null;
  source: BillingPlanSource;
  env: { projectLimit: number; seatLimit: number | null };
}): { projectLimit: number; seatLimit: number | null; mauLimit: number | null } {
  const { billingEnabled, override, plan, source, env } = input;
  if (!billingEnabled) {
    return {
      projectLimit: override.projectLimit ?? env.projectLimit,
      seatLimit: override.seatLimit ?? env.seatLimit,
      mauLimit: null,
    };
  }
  const planProject = plan?.projectLimit ?? env.projectLimit;
  const planSeat = plan ? (plan.seatLimit ?? (source === 'free' ? env.seatLimit : null)) : env.seatLimit;
  const mauLimit = plan?.mauLimit ?? null;
  if (source === 'free') {
    return {
      projectLimit: override.projectLimit ?? planProject,
      seatLimit: override.seatLimit ?? planSeat,
      mauLimit,
    };
  }
  return {
    projectLimit: Math.max(override.projectLimit ?? 0, planProject),
    seatLimit: planSeat === null ? null : Math.max(override.seatLimit ?? 0, planSeat),
    mauLimit,
  };
}

import type { BillingAccountState, BillingPlanSource } from '@chumbaq/shared';
import type { AccountBillingState, SubscriptionState } from './effective-plan';

/**
 * The effective plan rule's cases, shared by the unit spec (the TypeScript rule)
 * and the integration spec that holds the SQL mirror equal to it on real rows.
 * Plan codes `a` and `c` rank 1, `b` ranks 2, and `free` and `z` rank 0.
 */
export const now = new Date('2026-12-15T00:00:00Z');
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

export const RANKS: Record<string, number> = { free: 0, a: 1, b: 2, c: 1, z: 0 };
export const rank = (code: string) => RANKS[code] ?? 0;

export function sub(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    planCode: 'a',
    interval: 'monthly',
    status: 'active',
    currentEnd: at(10 * DAY),
    startAt: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

export function state(overrides: Partial<AccountBillingState> = {}): AccountBillingState {
  return { comp: null, current: null, next: null, ...overrides };
}

export type EffectivePlanCase = [
  label: string,
  state: AccountBillingState,
  planCode: string,
  source: BillingPlanSource,
  until: Date | null,
  account: BillingAccountState,
];

export const EFFECTIVE_PLAN_CASES: EffectivePlanCase[] = [
  ['no billing rows', state(), 'free', 'free', null, 'free'],
  // Rule 1: the comp.
  ['comp with no end', state({ comp: { planCode: 'b', until: null } }), 'b', 'comp', null, 'comped'],
  ['comp until tomorrow', state({ comp: { planCode: 'b', until: at(DAY) } }), 'b', 'comp', at(DAY), 'comped'],
  ['comp expired yesterday', state({ comp: { planCode: 'b', until: at(-DAY) } }), 'free', 'free', null, 'free'],
  [
    'comp expired yesterday over a live subscription',
    state({ comp: { planCode: 'b', until: at(-DAY) }, current: sub() }),
    'a',
    'subscription',
    null,
    'active',
  ],
  [
    'comp wins over a live subscription',
    state({ comp: { planCode: 'a', until: null }, current: sub({ planCode: 'b' }) }),
    'a',
    'comp',
    null,
    'comped',
  ],
  // Rule 2: an authenticated successor.
  [
    'authenticated upgrade successor',
    state({ current: sub({ planCode: 'a' }), next: sub({ planCode: 'b', status: 'authenticated', startAt: at(10 * DAY) }) }),
    'b',
    'subscription',
    null,
    'upgrade_pending',
  ],
  [
    'authenticated downgrade successor',
    state({ current: sub({ planCode: 'b' }), next: sub({ planCode: 'a', status: 'authenticated', startAt: at(10 * DAY) }) }),
    'b',
    'subscription',
    null,
    'change_scheduled',
  ],
  [
    'authenticated successor on another plan of the same rank waits',
    state({ current: sub({ planCode: 'a' }), next: sub({ planCode: 'c', status: 'authenticated', startAt: at(10 * DAY) }) }),
    'a',
    'subscription',
    null,
    'change_scheduled',
  ],
  [
    'authenticated same-plan successor (interval switch)',
    state({
      current: sub({ planCode: 'a' }),
      next: sub({ planCode: 'a', interval: 'yearly', status: 'authenticated', startAt: at(10 * DAY) }),
    }),
    'a',
    'subscription',
    null,
    'change_scheduled',
  ],
  // As it really looks: the old subscription is cancelling at cycle end once a
  // successor is scheduled, so the rule that applies shows in `until`.
  [
    'interval switch over a cancelling current keeps the current until its end',
    state({
      current: sub({ planCode: 'a', cancelAtPeriodEnd: true, currentEnd: at(10 * DAY) }),
      next: sub({ planCode: 'a', interval: 'yearly', status: 'authenticated', startAt: at(10 * DAY) }),
    }),
    'a',
    'subscription',
    at(10 * DAY),
    'change_scheduled',
  ],
  [
    'downgrade over a cancelling current keeps the current until its end',
    state({
      current: sub({ planCode: 'b', cancelAtPeriodEnd: true, currentEnd: at(10 * DAY) }),
      next: sub({ planCode: 'a', status: 'authenticated', startAt: at(10 * DAY) }),
    }),
    'b',
    'subscription',
    at(10 * DAY),
    'change_scheduled',
  ],
  [
    'upgrade over a cancelling current counts at once, with no end',
    state({
      current: sub({ planCode: 'a', cancelAtPeriodEnd: true, currentEnd: at(10 * DAY) }),
      next: sub({ planCode: 'b', status: 'authenticated', startAt: at(10 * DAY) }),
    }),
    'b',
    'subscription',
    null,
    'upgrade_pending',
  ],
  [
    'current cancelled, authenticated successor starting in 1 hour',
    state({
      current: sub({ planCode: 'b', status: 'cancelled' }),
      next: sub({ planCode: 'a', status: 'authenticated', startAt: at(HOUR) }),
    }),
    'a',
    'subscription',
    null,
    'upgrade_pending',
  ],
  [
    'current cancelled, authenticated successor whose start passed 2 days ago',
    state({
      current: sub({ planCode: 'b', status: 'cancelled' }),
      next: sub({ planCode: 'a', status: 'authenticated', startAt: at(-2 * DAY) }),
    }),
    'free',
    'free',
    null,
    'change_scheduled',
  ],
  [
    'current cancelled, authenticated successor started 1 hour ago (inside the slack)',
    state({
      current: sub({ planCode: 'b', status: 'cancelled' }),
      next: sub({ planCode: 'a', status: 'authenticated', startAt: at(-HOUR) }),
    }),
    'a',
    'subscription',
    null,
    'upgrade_pending',
  ],
  [
    'current cancelled, successor on a plan ranked with free gives it, but is no upgrade',
    state({
      current: sub({ planCode: 'b', status: 'cancelled' }),
      next: sub({ planCode: 'z', status: 'authenticated', startAt: at(HOUR) }),
    }),
    'z',
    'subscription',
    null,
    'change_scheduled',
  ],
  // With no live current subscription paying for the time before it starts, an
  // authenticated successor (a mandate, no charge yet) counts only once it is
  // about to charge, never for months on a mandate alone.
  [
    'current halted past grace, authenticated successor starting in 300 days',
    state({
      current: sub({ planCode: 'a', interval: 'yearly', status: 'halted', graceUntil: at(-DAY) }),
      next: sub({ planCode: 'b', interval: 'yearly', status: 'authenticated', startAt: at(300 * DAY) }),
    }),
    'free',
    'free',
    null,
    'change_scheduled',
  ],
  [
    'no current, authenticated successor starting in 30 days',
    state({ next: sub({ planCode: 'b', status: 'authenticated', startAt: at(30 * DAY) }) }),
    'free',
    'free',
    null,
    'change_scheduled',
  ],
  [
    'current expired, authenticated successor starting in 2 days',
    state({
      current: sub({ planCode: 'a', status: 'expired' }),
      next: sub({ planCode: 'b', status: 'authenticated', startAt: at(2 * DAY) }),
    }),
    'free',
    'free',
    null,
    'change_scheduled',
  ],
  [
    'no current, authenticated successor starting in 23 hours (inside the lead)',
    state({ next: sub({ planCode: 'b', status: 'authenticated', startAt: at(23 * HOUR) }) }),
    'b',
    'subscription',
    null,
    'upgrade_pending',
  ],
  [
    'authenticated successor with no start does not count',
    state({ next: sub({ planCode: 'b', status: 'authenticated', startAt: null }) }),
    'free',
    'free',
    null,
    'change_scheduled',
  ],
  // Rule 3: the live current subscription.
  ['active', state({ current: sub() }), 'a', 'subscription', null, 'active'],
  [
    'active, cancelling at period end',
    state({ current: sub({ cancelAtPeriodEnd: true, currentEnd: at(5 * DAY) }) }),
    'a',
    'subscription',
    at(5 * DAY),
    'cancelling',
  ],
  [
    'active, cancelling, period ended 1 hour ago',
    state({ current: sub({ cancelAtPeriodEnd: true, currentEnd: at(-HOUR) }) }),
    'a',
    'subscription',
    at(-HOUR),
    'cancelling',
  ],
  [
    'active, cancelling, period ended 2 days ago (webhook lost)',
    state({ current: sub({ cancelAtPeriodEnd: true, currentEnd: at(-2 * DAY) }) }),
    'free',
    'free',
    null,
    'free',
  ],
  ['pending', state({ current: sub({ status: 'pending' }) }), 'a', 'subscription', null, 'past_due'],
  [
    'halted with grace tomorrow',
    state({ current: sub({ status: 'halted', graceUntil: at(DAY) }) }),
    'a',
    'subscription',
    null,
    'halted',
  ],
  [
    'halted with grace yesterday',
    state({ current: sub({ status: 'halted', graceUntil: at(-DAY) }) }),
    'free',
    'free',
    null,
    'free',
  ],
  // Rule 4 and checkout.
  ['created next with no current', state({ next: sub({ status: 'created' }) }), 'free', 'free', null, 'checkout'],
  [
    'created next over a live current',
    state({ current: sub({ planCode: 'b' }), next: sub({ planCode: 'a', status: 'created' }) }),
    'b',
    'subscription',
    null,
    'active',
  ],
  ['cancelled current', state({ current: sub({ status: 'cancelled' }) }), 'free', 'free', null, 'free'],
  ['expired current', state({ current: sub({ status: 'expired' }) }), 'free', 'free', null, 'free'],
];

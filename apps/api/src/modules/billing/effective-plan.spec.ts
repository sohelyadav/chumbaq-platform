import type { BillingAccountState, BillingPlanSource } from '@chumbaq/shared';
import {
  AccountBillingState,
  accountState,
  effectiveLimits,
  effectivePlan,
  isLive,
  SubscriptionState,
} from './effective-plan';

const now = new Date('2026-12-15T00:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

const RANKS: Record<string, number> = { free: 0, a: 1, b: 2 };
const rank = (code: string) => RANKS[code] ?? 0;

function sub(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
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

function state(overrides: Partial<AccountBillingState> = {}): AccountBillingState {
  return { comp: null, current: null, next: null, ...overrides };
}

describe('isLive', () => {
  it.each<[string, SubscriptionState | null, boolean]>([
    ['no subscription', null, false],
    ['active', sub(), true],
    ['active, cancelling, period not over', sub({ cancelAtPeriodEnd: true, currentEnd: at(DAY) }), true],
    ['active, cancelling, period ended 1 hour ago (inside the slack)', sub({ cancelAtPeriodEnd: true, currentEnd: at(-HOUR) }), true],
    ['active, cancelling, period ended 2 days ago (webhook lost)', sub({ cancelAtPeriodEnd: true, currentEnd: at(-2 * DAY) }), false],
    ['active, not cancelling, period ended 2 days ago', sub({ currentEnd: at(-2 * DAY) }), true],
    ['active, cancelling, no period end', sub({ cancelAtPeriodEnd: true, currentEnd: null }), true],
    ['pending', sub({ status: 'pending' }), true],
    ['halted, grace tomorrow', sub({ status: 'halted', graceUntil: at(DAY) }), true],
    ['halted, grace yesterday', sub({ status: 'halted', graceUntil: at(-DAY) }), false],
    ['halted, grace ends now', sub({ status: 'halted', graceUntil: now }), false],
    ['halted, no grace', sub({ status: 'halted', graceUntil: null }), false],
    ['created', sub({ status: 'created' }), false],
    ['authenticated', sub({ status: 'authenticated' }), false],
    ['cancelled', sub({ status: 'cancelled' }), false],
    ['completed', sub({ status: 'completed' }), false],
    ['expired', sub({ status: 'expired' }), false],
  ])('%s', (_label, subscription, live) => {
    expect(isLive(subscription, now)).toBe(live);
  });
});

describe('effectivePlan and accountState', () => {
  const cases: Array<[string, AccountBillingState, string, BillingPlanSource, Date | null, BillingAccountState]> = [
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

  it.each(cases)('%s', (_label, input, code, source, until, account) => {
    expect(effectivePlan(input, now, rank)).toEqual({ planCode: code, source, until });
    expect(accountState(input, now, rank)).toBe(account);
  });
});

describe('effectiveLimits', () => {
  const env = { projectLimit: 10, seatLimit: 25 };
  const plan = (projectLimit: number | null, seatLimit: number | null, mauLimit: number | null = null) => ({
    projectLimit,
    seatLimit,
    mauLimit,
  });

  it.each<[string, Parameters<typeof effectiveLimits>[0], ReturnType<typeof effectiveLimits>]>([
    [
      'billing off ignores the plan',
      { billingEnabled: false, override: { projectLimit: null, seatLimit: null }, plan: plan(1, 1, 100), source: 'free', env },
      { projectLimit: 10, seatLimit: 25, mauLimit: null },
    ],
    [
      'billing off keeps the staff override',
      { billingEnabled: false, override: { projectLimit: 3, seatLimit: 0 }, plan: plan(1, 1), source: 'subscription', env },
      { projectLimit: 3, seatLimit: 0, mauLimit: null },
    ],
    [
      'billing off with no seat default is no seat limit',
      {
        billingEnabled: false,
        override: { projectLimit: null, seatLimit: null },
        plan: null,
        source: 'free',
        env: { projectLimit: 10, seatLimit: null },
      },
      { projectLimit: 10, seatLimit: null, mauLimit: null },
    ],
    [
      'on, free: the override beats the plan, upwards',
      { billingEnabled: true, override: { projectLimit: 3, seatLimit: 4 }, plan: plan(1, 2, 500), source: 'free', env },
      { projectLimit: 3, seatLimit: 4, mauLimit: 500 },
    ],
    [
      'on, free: the override beats the plan, downwards (staff can lower a free account)',
      { billingEnabled: true, override: { projectLimit: 0, seatLimit: 0 }, plan: plan(5, 5), source: 'free', env },
      { projectLimit: 0, seatLimit: 0, mauLimit: null },
    ],
    [
      'on, free: no override takes the plan',
      { billingEnabled: true, override: { projectLimit: null, seatLimit: null }, plan: plan(1, 2), source: 'free', env },
      { projectLimit: 1, seatLimit: 2, mauLimit: null },
    ],
    [
      'on, free: a null plan seat limit is no seat limit',
      { billingEnabled: true, override: { projectLimit: null, seatLimit: null }, plan: plan(1, null), source: 'free', env },
      { projectLimit: 1, seatLimit: null, mauLimit: null },
    ],
    [
      'on, no plan row: the env defaults',
      { billingEnabled: true, override: { projectLimit: null, seatLimit: null }, plan: null, source: 'free', env },
      { projectLimit: 10, seatLimit: 25, mauLimit: null },
    ],
    [
      'on, paid: a lower override does not cut the plan',
      { billingEnabled: true, override: { projectLimit: 2, seatLimit: 2 }, plan: plan(5, 5), source: 'subscription', env },
      { projectLimit: 5, seatLimit: 5, mauLimit: null },
    ],
    [
      'on, paid: a higher override raises it',
      { billingEnabled: true, override: { projectLimit: 8, seatLimit: 9 }, plan: plan(5, 5), source: 'subscription', env },
      { projectLimit: 8, seatLimit: 9, mauLimit: null },
    ],
    [
      'on, paid: a null plan seat limit is unlimited whatever the override',
      { billingEnabled: true, override: { projectLimit: null, seatLimit: 3 }, plan: plan(5, null), source: 'subscription', env },
      { projectLimit: 5, seatLimit: null, mauLimit: null },
    ],
    [
      'on, paid: a null plan project limit is the env default',
      { billingEnabled: true, override: { projectLimit: null, seatLimit: null }, plan: plan(null, 4, 9000), source: 'subscription', env },
      { projectLimit: 10, seatLimit: 4, mauLimit: 9000 },
    ],
    [
      'on, comp counts as paid',
      { billingEnabled: true, override: { projectLimit: 1, seatLimit: null }, plan: plan(5, 5), source: 'comp', env },
      { projectLimit: 5, seatLimit: 5, mauLimit: null },
    ],
  ])('%s', (_label, input, expected) => {
    expect(effectiveLimits(input)).toEqual(expected);
  });
});

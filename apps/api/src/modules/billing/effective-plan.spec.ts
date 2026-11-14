import { accountState, effectiveLimits, effectivePlan, isLive, SubscriptionState } from './effective-plan';
import { at, DAY, EFFECTIVE_PLAN_CASES, HOUR, now, rank, sub } from './effective-plan.cases';

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

  it.each(EFFECTIVE_PLAN_CASES)('%s', (_label, input, code, source, until, account) => {
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

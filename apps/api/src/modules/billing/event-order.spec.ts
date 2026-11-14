import type { BillingSubscriptionStatus } from '@chumbaq/shared';
import { EVENT_RANK, shouldApplyStatus } from './event-order';

const at = (iso: string) => new Date(iso);
const T = '2026-12-01T10:00:00Z';
const BEFORE = '2026-12-01T09:59:59Z';
const AFTER = '2026-12-01T10:00:01Z';

function row(status: BillingSubscriptionStatus, lastEventAt: string | null) {
  return { status, lastEventAt: lastEventAt ? at(lastEventAt) : null, lastEventRank: lastEventAt ? EVENT_RANK[status] : 0 };
}

describe('shouldApplyStatus', () => {
  describe('orders events', () => {
    it.each<[string, BillingSubscriptionStatus, string | null, BillingSubscriptionStatus, string, boolean]>([
      ['a first event always applies', 'created', null, 'authenticated', T, true],
      ['a newer event applies', 'active', T, 'pending', AFTER, true],
      ['an older event is refused', 'pending', T, 'active', BEFORE, false],
      ['the same second with a higher rank applies', 'active', T, 'pending', T, true],
      ['the same second with a lower rank is refused (active after pending)', 'pending', T, 'active', T, false],
      ['the same status in the same second applies (a replay changes nothing)', 'halted', T, 'halted', T, true],
      ['halted then a newer activated applies', 'halted', T, 'active', AFTER, true],
    ])('%s', (_name, status, last, incoming, when, expected) => {
      expect(shouldApplyStatus(row(status, last), { status: incoming, at: at(when) })).toBe(expected);
    });
  });

  it.each<BillingSubscriptionStatus>(['cancelled', 'completed', 'expired'])(
    'nothing leaves %s, not even a newer activated',
    (terminal) => {
      expect(shouldApplyStatus(row(terminal, T), { status: 'active', at: at(AFTER) })).toBe(false);
      expect(shouldApplyStatus(row(terminal, null), { status: 'active', at: at(AFTER) })).toBe(false);
      expect(shouldApplyStatus(row(terminal, T), { status: 'halted', at: at(AFTER) })).toBe(false);
    },
  );

  it('ranks every status, the terminal ones equal and highest', () => {
    expect(EVENT_RANK).toEqual({
      created: 0,
      authenticated: 1,
      active: 2,
      pending: 3,
      halted: 4,
      cancelled: 5,
      completed: 5,
      expired: 5,
    });
  });
});

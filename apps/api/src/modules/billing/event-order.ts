import type { BillingSubscriptionStatus } from '@chumbaq/shared';

/**
 * Ordering webhooks that arrive late, twice or out of order. The provider delivers
 * at least once, in no particular order, and stamps each event with whole seconds,
 * so two events of one subscription can share a second.
 *
 * A status applies when its event is newer than the last one applied; in the same
 * second, only when it ranks at least as high (`pending` after `active` in one
 * second is a failed renewal, never the other way round). Nothing ever leaves a
 * terminal status: the provider cannot revive a cancelled, completed or expired
 * subscription, so a late `activated` must not either.
 */
export const EVENT_RANK: Record<BillingSubscriptionStatus, number> = {
  created: 0,
  authenticated: 1,
  active: 2,
  pending: 3,
  halted: 4,
  cancelled: 5,
  completed: 5,
  expired: 5,
};

export const TERMINAL_RANK = 5;

export function isTerminalStatus(status: BillingSubscriptionStatus): boolean {
  return EVENT_RANK[status] === TERMINAL_RANK;
}

export function shouldApplyStatus(
  row: { status: BillingSubscriptionStatus; lastEventAt: Date | null; lastEventRank: number },
  incoming: { status: BillingSubscriptionStatus; at: Date },
): boolean {
  if (isTerminalStatus(row.status)) return false;
  if (row.lastEventAt === null) return true;
  const last = row.lastEventAt.getTime();
  const at = incoming.at.getTime();
  if (at > last) return true;
  return at === last && EVENT_RANK[incoming.status] >= row.lastEventRank;
}

import type { BillingAccountEntity } from './entities/billing-account.entity';
import type { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import {
  AccountBillingState,
  CANCEL_END_SLACK_MS,
  FREE_PLAN,
  SUCCESSOR_START_SLACK_MS,
  SubscriptionState,
} from './effective-plan';

/**
 * The effective plan rule (`effective-plan.ts`) in SQL, for queries over many
 * accounts at once. `effective-plan-sql.int-spec.ts` runs it on rows built from
 * every case of the TypeScript rule and holds the two equal: change both or neither.
 */

/**
 * Left joins from a `users` row aliased `u`: `ba` its billing account, `cur` and
 * `nxt` its current and next subscriptions, `cp` and `np` their plans, `xp` the
 * comp plan. Every alias is null for an account with no billing row.
 */
export const BILLING_STATE_JOINS = `
  LEFT JOIN billing_accounts ba ON ba.user_id = u.id
  LEFT JOIN billing_subscriptions cur ON cur.id = ba.current_subscription_id
  LEFT JOIN billing_subscriptions nxt ON nxt.id = ba.next_subscription_id
  LEFT JOIN plans cp ON cp.code = cur.plan_code
  LEFT JOIN plans np ON np.code = nxt.plan_code
  LEFT JOIN plans xp ON xp.code = ba.comp_plan_code
`;

const FREE_RANK_SQL = `COALESCE((SELECT fp.sort_order FROM plans fp WHERE fp.code = '${FREE_PLAN}'), 0)`;

/** `isLive` for the subscription aliased `s`; false, never null, when there is none. */
function isLiveSql(s: string, now: string): string {
  return `COALESCE(
    (${s}.status = 'active' AND NOT (
       ${s}.cancel_at_period_end
       AND ${s}.current_end IS NOT NULL
       AND ${now} > ${s}.current_end + interval '${CANCEL_END_SLACK_MS} milliseconds'))
    OR ${s}.status = 'pending'
    OR (${s}.status = 'halted' AND ${s}.grace_until IS NOT NULL AND ${now} < ${s}.grace_until),
    false)`;
}

/**
 * A SQL expression giving the effective plan code of the account aliased `u`,
 * over `BILLING_STATE_JOINS`. `now` is a parameter placeholder such as `$1`.
 */
export function effectivePlanCodeSql(now: string): string {
  const at = `(${now})::timestamptz`;
  const currentLive = isLiveSql('cur', at);
  const currentRank = `(CASE WHEN ${currentLive} THEN cp.sort_order ELSE ${FREE_RANK_SQL} END)`;
  const successorCounts = `(
    nxt.status = 'authenticated'
    AND nxt.start_at IS NOT NULL
    AND ${at} < nxt.start_at + interval '${SUCCESSOR_START_SLACK_MS} milliseconds'
    AND (np.sort_order > ${currentRank} OR NOT ${currentLive}))`;
  return `(CASE
    WHEN ba.comp_plan_code IS NOT NULL AND (ba.comp_until IS NULL OR ba.comp_until > ${at}) THEN ba.comp_plan_code
    WHEN ${successorCounts} THEN nxt.plan_code
    WHEN ${currentLive} THEN cur.plan_code
    ELSE '${FREE_PLAN}'
  END)`;
}

type SubscriptionRow = Pick<
  BillingSubscriptionEntity,
  'planCode' | 'interval' | 'status' | 'currentEnd' | 'startAt' | 'graceUntil' | 'cancelAtPeriodEnd'
>;

function toSubscriptionState(row: SubscriptionRow | null): SubscriptionState | null {
  if (!row) return null;
  return {
    planCode: row.planCode,
    interval: row.interval,
    status: row.status,
    currentEnd: row.currentEnd,
    startAt: row.startAt,
    graceUntil: row.graceUntil,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

/** The rule's input from an account's rows: no account row is no comp and no subscriptions. */
export function toBillingState(
  account: Pick<BillingAccountEntity, 'compPlanCode' | 'compUntil'> | null,
  cur: SubscriptionRow | null,
  nxt: SubscriptionRow | null,
): AccountBillingState {
  return {
    comp: account?.compPlanCode ? { planCode: account.compPlanCode, until: account.compUntil } : null,
    current: toSubscriptionState(cur),
    next: toSubscriptionState(nxt),
  };
}

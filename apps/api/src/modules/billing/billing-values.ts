import type {
  BillingAccountState,
  BillingInterval,
  BillingPlanSource,
  BillingSubscriptionStatus,
} from '@chumbaq/shared';

// Runtime copies of the shared unions. The API must not value-import from
// @chumbaq/shared, and a Record makes a value added there fail compilation here.

export const SUBSCRIPTION_STATUSES: Record<BillingSubscriptionStatus, true> = {
  created: true,
  authenticated: true,
  active: true,
  pending: true,
  halted: true,
  cancelled: true,
  completed: true,
  expired: true,
};

export const BILLING_INTERVALS: Record<BillingInterval, true> = {
  monthly: true,
  yearly: true,
};

export const BILLING_PLAN_SOURCES: Record<BillingPlanSource, true> = {
  free: true,
  subscription: true,
  comp: true,
};

export const BILLING_ACCOUNT_STATES: Record<BillingAccountState, true> = {
  free: true,
  checkout: true,
  active: true,
  past_due: true,
  halted: true,
  cancelling: true,
  change_scheduled: true,
  upgrade_pending: true,
  comped: true,
};

export const SUBSCRIPTION_STATUS_VALUES = Object.keys(SUBSCRIPTION_STATUSES) as BillingSubscriptionStatus[];
export const BILLING_INTERVAL_VALUES = Object.keys(BILLING_INTERVALS) as BillingInterval[];

export function isSubscriptionStatus(value: unknown): value is BillingSubscriptionStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUBSCRIPTION_STATUSES, value);
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BILLING_INTERVALS, value);
}

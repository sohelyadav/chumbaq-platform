/**
 * Bounds on one cohort sync. Every tenant's syncs share the worker's cohort lane, so a
 * sync must end in bounded time whatever the tenant's cohort or device table holds:
 * its members are capped, it has a deadline, and members are resolved and written in
 * batches of indexed set queries rather than one round trip per member.
 */

/** A cohort with more members than this is refused, before its members are fetched where Mixpanel says how many. */
export const COHORT_MEMBER_CAP = 100_000;

/** A sync still running after this long stops, between Mixpanel pages or batches. */
export const COHORT_SYNC_DEADLINE_MS = 10 * 60 * 1000;

/** Members resolved and written per database round trip. */
export const COHORT_RESOLVE_BATCH = 1_000;

/** Longest Mixpanel distinct id kept (the column's length); longer ones are skipped. */
export const MIXPANEL_DISTINCT_ID_MAX = 512;

/**
 * A sync that hit one of the bounds above. Trying again would hit it again, so the
 * queue does not retry it; the cohort shows the message until the next scheduled sync.
 */
export class CohortSyncLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CohortSyncLimitError';
  }
}

export function cohortTooLarge(): CohortSyncLimitError {
  return new CohortSyncLimitError(
    `This cohort has more than ${COHORT_MEMBER_CAP.toLocaleString('en-US')} members, the most Chumbaq syncs.`,
  );
}

export function cohortSyncTooSlow(): CohortSyncLimitError {
  return new CohortSyncLimitError(
    `The sync took longer than ${COHORT_SYNC_DEADLINE_MS / 60_000} minutes and was stopped. It is tried again next hour.`,
  );
}

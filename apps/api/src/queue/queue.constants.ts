export const QUEUE_PUSH_CAMPAIGN = 'push-campaign';
export const QUEUE_COHORT_SYNC = 'cohort-sync';

export const JOB_DISPATCH_CAMPAIGN = 'dispatch-campaign';
export const JOB_SYNC_COHORT = 'sync-cohort';

/** FCM accepts at most 500 messages per batch. */
export const PUSH_BATCH_SIZE = 500;

/**
 * Longest a throttled campaign will pause between pages.
 *
 * A pathologically low rate should slow delivery down, not park a worker
 * holding a job lock long enough for BullMQ to reclaim it as stalled.
 */
export const MAX_THROTTLE_WAIT_MS = 30_000;

/**
 * Cap on per-token failure records persisted to the log row. Without a cap a
 * large campaign with a high failure rate would write an unbounded jsonb blob.
 * Aggregate counts (successCount / failureCount) stay exact regardless.
 */
export const MAX_FAILURE_DETAILS = 100;

export interface PushCampaignJobData {
  logId: string;
  projectId: string;
}

export interface CohortSyncJobData {
  cohortId: string;
}

export const QUEUE_SEGMENT_MATERIALIZE = 'segment-materialize';
export const JOB_MATERIALIZE_SEGMENT = 'materialize-segment';

/** Rows per insert when replacing a segment's membership. */
export const SEGMENT_MEMBER_BATCH_SIZE = 1000;

/**
 * A segment whose materialisation started within this window is treated as
 * still running and is not re-enqueued. Without it the staleness predicate
 * re-enqueues a long-running segment on every tick — the unbounded-backlog
 * residual Phase 0's final review identified on cohort sync.
 */
export const SEGMENT_MATERIALIZE_LOCK_MS = 30 * 60 * 1000;

/**
 * Tolerance on the "is this segment stale?" test.
 *
 * `last_materialized_at` is written when a run completes, which is always
 * strictly after the cron tick that enqueued it. So a segment whose refresh
 * interval equals the cron period is never quite due at the aligned tick that
 * should pick it up — it is short by however long the run took — and waits a
 * whole further period. Measured live: a 5-minute segment materialised at
 * 23:55:00.064 was 64ms short of due at the 00:00:00 tick and refreshed at
 * 00:05 instead, so a segment asking for 5 minutes got 10.
 *
 * The floor on `refreshIntervalMinutes` is 5 and the cron period is 5 minutes,
 * so this is not a tail case: anyone choosing the fastest refresh the UI offers
 * silently gets half of it.
 *
 * 30 seconds is well under the cron period — so this can never make a segment
 * refresh twice in one period — and comfortably over the materialisation time
 * of any segment that keeps to a 5-minute cadence.
 */
export const SEGMENT_REFRESH_GRACE_SECONDS = 30;

export interface SegmentMaterializeJobData {
  segmentId: string;
  projectId: string;
}

/**
 * Every queue the worker process consumes.
 *
 * Here rather than written out in the worker's startup log, which drifted:
 * `segment-materialize` was consumed for months while the log still named only
 * the first two. A log that understates what a worker is doing sends anyone
 * debugging a queue to exactly the wrong place — "the worker says it isn't
 * consuming that" is a convincing dead end.
 */
export const WORKER_QUEUES = [
  QUEUE_PUSH_CAMPAIGN,
  QUEUE_COHORT_SYNC,
  QUEUE_SEGMENT_MATERIALIZE,
] as const;

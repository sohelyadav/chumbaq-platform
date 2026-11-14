import type { DataSource } from 'typeorm';

/**
 * Puts every unsent outbox cancel that does not belong to `userIds` out of the
 * outbox's reach. The integration database keeps rows from earlier runs, whose
 * subscriptions this run's fake provider has never heard of, and the outbox works
 * oldest first in small batches: without this, a spec's own rows could wait behind
 * them. Those leftover rows are never sent by a test again.
 */
export async function parkOtherOutboxRows(ds: DataSource, userIds: Iterable<string>): Promise<void> {
  await ds.query(
    `UPDATE billing_subscriptions SET cancel_retry_at = 'infinity'
      WHERE cancel_requested_at IS NOT NULL AND cancel_sent_at IS NULL
        AND (cancel_retry_at IS NULL OR cancel_retry_at <> 'infinity')
        AND NOT (user_id = ANY($1::uuid[]))`,
    [[...userIds]],
  );
}

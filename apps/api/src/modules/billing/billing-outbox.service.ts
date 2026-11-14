import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { logValue } from '../../common/log-value';
import { isUnreachableError } from '../push-notifications/services/per-recipient-provider';
import { BILLING_PROVIDER, BillingProvider, BillingProviderError } from './providers/billing-provider';

export const OUTBOX_BATCH = 20;
export const OUTBOX_MAX_ATTEMPTS = 10;
/** The session advisory lock key: one outbox run per database at a time. */
export const OUTBOX_LOCK_SQL = `hashtext('billing_outbox')`;

const ERROR_CHARS = 320;

/** The provider's answer to cancelling a subscription that has already ended. */
const ALREADY_ENDED = /\b(cancelled|completed|expired)\b/i;

/**
 * Sends the cancels decided elsewhere (a superseded checkout, the old subscription
 * after a plan change, a cancel queued under a lock): `billing_subscriptions` rows
 * with `cancel_requested_at` set and `cancel_sent_at` not yet.
 *
 * One run per database at a time (a session advisory lock; a second worker skips).
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, counting the attempt in the claim,
 * and the provider is called with no lock held, so a webhook for the same
 * subscription never waits on it. A success stamps `cancel_sent_at`; an "already
 * cancelled" refusal counts as sent; anything else is kept in `cancel_error` and
 * retried next run, up to `OUTBOX_MAX_ATTEMPTS`.
 */
@Injectable()
export class BillingOutboxService {
  private readonly logger = new Logger(BillingOutboxService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  /** How many cancels were sent (or found already done). */
  async runOnce(now: Date = new Date()): Promise<number> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query(`SELECT pg_try_advisory_lock(${OUTBOX_LOCK_SQL}) AS locked`);
      if (!locked) return 0;
      try {
        // An UPDATE ... RETURNING answers [rows, count] through TypeORM's postgres driver.
        const [claimed]: [Array<{ id: string; provider_subscription_id: string; cancel_at_cycle_end: boolean | null }>] =
          await runner.query(
            `UPDATE billing_subscriptions SET cancel_attempts = cancel_attempts + 1, updated_at = now()
              WHERE id IN (
                SELECT id FROM billing_subscriptions
                 WHERE cancel_requested_at IS NOT NULL AND cancel_sent_at IS NULL AND cancel_attempts < $1
                 ORDER BY cancel_requested_at
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED)
              RETURNING id, provider_subscription_id, cancel_at_cycle_end`,
            [OUTBOX_MAX_ATTEMPTS, OUTBOX_BATCH],
          );
        let sent = 0;
        for (const row of claimed) {
          if (await this.send(row.id, row.provider_subscription_id, row.cancel_at_cycle_end === true, now)) sent += 1;
        }
        return sent;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(${OUTBOX_LOCK_SQL})`);
      }
    } finally {
      await runner.release();
    }
  }

  private async send(id: string, providerId: string, atCycleEnd: boolean, now: Date): Promise<boolean> {
    let failure: string | null = null;
    try {
      await this.provider.cancelSubscription(providerId, atCycleEnd);
    } catch (error) {
      if (error instanceof BillingProviderError && error.status === 400 && ALREADY_ENDED.test(error.description ?? '')) {
        failure = null;
      } else if (error instanceof BillingProviderError) {
        failure = logValue(`${error.status} ${error.code ?? ''} ${error.description ?? ''}`.trim());
      } else if (isUnreachableError(error)) {
        failure = logValue('unreachable');
      } else {
        failure = logValue((error as Error).message);
      }
    }
    if (failure !== null) {
      await this.dataSource.query(`UPDATE billing_subscriptions SET cancel_error = $2, updated_at = now() WHERE id = $1`, [
        id,
        failure.slice(0, ERROR_CHARS),
      ]);
      this.logger.warn(`Billing cancel for subscription ${id} failed: ${failure}`);
      return false;
    }
    await this.dataSource.query(
      `UPDATE billing_subscriptions
          SET cancel_sent_at = $2, cancel_error = NULL,
              cancel_at_period_end = CASE WHEN cancel_at_cycle_end THEN true ELSE cancel_at_period_end END,
              updated_at = now()
        WHERE id = $1`,
      [id, now],
    );
    return true;
  }
}

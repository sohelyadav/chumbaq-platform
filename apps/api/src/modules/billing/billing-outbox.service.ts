import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { logValue } from '../../common/log-value';
import { isUnreachableError } from '../push-notifications/services/per-recipient-provider';
import { BILLING_PROVIDER, BillingProvider, BillingProviderError } from './providers/billing-provider';

export const OUTBOX_BATCH = 20;
/** The wait before retrying a failed cancel doubles from this ... */
export const OUTBOX_FIRST_BACKOFF_MS = 60_000;
/** ... up to this, and the cancel is retried at this pace for as long as it fails. */
export const OUTBOX_MAX_BACKOFF_MS = 3600_000;
/** After this many failed tries (about four hours) each further failure is logged as an error. */
export const OUTBOX_ERROR_AFTER_ATTEMPTS = 10;
/**
 * A cancel that a request decided and sends itself is held back from the worker for
 * this long (`cancel_retry_at`), so the two do not send it together. Longer than a
 * provider call and the status check after a refusal; if the request dies before
 * sending, the worker sends it once the hold is over.
 */
export const OUTBOX_REQUEST_HOLD_MS = 2 * 60_000;
/** The session advisory lock key: one outbox run per database at a time. */
export const OUTBOX_LOCK_SQL = `hashtext('billing_outbox')`;

const ERROR_CHARS = 320;

/** Statuses after which a subscription can never charge again. */
const ENDED: ReadonlySet<string> = new Set(['cancelled', 'completed', 'expired']);

/** The wait after the `attempts`-th failed try. */
export function outboxBackoffMs(attempts: number): number {
  const doublings = Math.min(Math.max(attempts, 1) - 1, 30);
  return Math.min(OUTBOX_FIRST_BACKOFF_MS * 2 ** doublings, OUTBOX_MAX_BACKOFF_MS);
}

/**
 * Sends the cancels decided elsewhere (a superseded checkout, the old subscription
 * after a plan change, a cancel queued under a lock): `billing_subscriptions` rows
 * with `cancel_requested_at` set and `cancel_sent_at` not yet.
 *
 * One run per database at a time (a session advisory lock; a second worker skips).
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, counting the attempt in the claim,
 * and the provider is called with no lock held, so a webhook for the same
 * subscription never waits on it. A success stamps `cancel_sent_at`. A refusal
 * counts as sent only when the provider, asked again, says the subscription has
 * ended: the wording of a refusal is never trusted, since a live subscription that
 * is taken for cancelled keeps charging. Anything else is kept in `cancel_error`
 * (which staff see) and retried after a wait that doubles up to an hour.
 *
 * A cancel is never given up on: a dropped cycle-end cancel is a charge at the next
 * renewal that the customer did not want. Past `OUTBOX_ERROR_AFTER_ATTEMPTS` every
 * failure is logged as an error.
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
        const [claimed]: [Claimed[]] = await runner.query(
          `UPDATE billing_subscriptions SET cancel_attempts = cancel_attempts + 1, updated_at = now()
            WHERE id IN (
              SELECT id FROM billing_subscriptions
               WHERE cancel_requested_at IS NOT NULL AND cancel_sent_at IS NULL
                 AND (cancel_retry_at IS NULL OR cancel_retry_at <= $1)
               ORDER BY cancel_requested_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED)
            RETURNING id, provider_subscription_id, cancel_at_cycle_end, cancel_attempts,
                  cancel_requested_at::text AS cancel_requested_at`,
          [now, OUTBOX_BATCH],
        );
        let sent = 0;
        for (const row of claimed) {
          if ((await this.send(row, now)).sent) sent += 1;
        }
        return sent;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(${OUTBOX_LOCK_SQL})`);
      }
    } finally {
      await runner.release();
    }
  }

  /**
   * Sends the cancel queued on one subscription now, from the request that decided
   * it (and committed it) rather than waiting for the worker. Counts as an attempt;
   * a failure is kept and retried by the worker like any other. A cancel already
   * sent (by the worker, or a request before) answers sent.
   */
  async sendQueued(subscriptionId: string, now: Date = new Date()): Promise<SendOutcome> {
    const [claimed]: [Claimed[]] = await this.dataSource.query(
      `UPDATE billing_subscriptions SET cancel_attempts = cancel_attempts + 1, updated_at = now()
        WHERE id = $1 AND cancel_requested_at IS NOT NULL AND cancel_sent_at IS NULL
        RETURNING id, provider_subscription_id, cancel_at_cycle_end, cancel_attempts,
                  cancel_requested_at::text AS cancel_requested_at`,
      [subscriptionId],
    );
    if (claimed.length === 0) return { sent: true };
    return this.send(claimed[0], now);
  }

  /**
   * Both outcomes are written only while the row still holds the request that was
   * sent (`cancel_requested_at` unchanged, not yet sent): a newer decision taken
   * meanwhile (staff turning a cycle-end cancel into an immediate one) is never
   * marked sent by the older call.
   */
  private async send(row: Claimed, now: Date): Promise<SendOutcome> {
    const atCycleEnd = row.cancel_at_cycle_end === true;
    let failure: string | null = null;
    let error: unknown = null;
    try {
      await this.provider.cancelSubscription(row.provider_subscription_id, atCycleEnd);
    } catch (caught) {
      if (!(await this.alreadyEnded(caught, row.provider_subscription_id))) {
        failure = failureOf(caught);
        error = caught;
      }
    }
    if (failure !== null) {
      await this.dataSource.query(
        `UPDATE billing_subscriptions SET cancel_error = $2, cancel_retry_at = $3, updated_at = now()
          WHERE id = $1 AND cancel_requested_at = $4::timestamptz AND cancel_sent_at IS NULL`,
        [
          row.id,
          failure.slice(0, ERROR_CHARS),
          new Date(now.getTime() + outboxBackoffMs(row.cancel_attempts)),
          row.cancel_requested_at,
        ],
      );
      const line = `Billing cancel for subscription ${row.id} failed (attempt ${row.cancel_attempts}): ${failure}`;
      if (row.cancel_attempts >= OUTBOX_ERROR_AFTER_ATTEMPTS) this.logger.error(line);
      else this.logger.warn(line);
      return { sent: false, error };
    }
    await this.dataSource.query(
      `UPDATE billing_subscriptions
          SET cancel_sent_at = $2, cancel_error = NULL, cancel_retry_at = NULL,
              cancel_at_period_end = CASE WHEN cancel_at_cycle_end THEN true ELSE cancel_at_period_end END,
              updated_at = now()
        WHERE id = $1 AND cancel_requested_at = $3::timestamptz AND cancel_sent_at IS NULL`,
      [row.id, now, row.cancel_requested_at],
    );
    return { sent: true };
  }

  /** A provider refusal, checked by asking the provider for the subscription's status. */
  private async alreadyEnded(error: unknown, providerId: string): Promise<boolean> {
    if (!(error instanceof BillingProviderError) || error.status !== 400) return false;
    try {
      return ENDED.has((await this.provider.fetchSubscription(providerId)).status);
    } catch {
      return false;
    }
  }
}

interface Claimed {
  id: string;
  provider_subscription_id: string;
  cancel_at_cycle_end: boolean | null;
  cancel_attempts: number;
  /** As text, to the microsecond: a `Date` keeps milliseconds only and would never match again. */
  cancel_requested_at: string;
}

/** A send that failed carries what the provider call threw, for the caller to answer with. */
export type SendOutcome = { sent: true } | { sent: false; error: unknown };

function failureOf(error: unknown): string {
  if (error instanceof BillingProviderError) {
    return logValue(`${error.status} ${error.code ?? ''} ${error.description ?? ''}`.trim());
  }
  if (isUnreachableError(error)) return logValue('unreachable');
  return logValue((error as Error).message);
}

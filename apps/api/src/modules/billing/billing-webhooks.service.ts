import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { logValue } from '../../common/log-value';
import { BillingNotice, BillingStateService } from './billing-state.service';
import { BILLING_PROVIDER, BillingEvent, BillingProvider } from './providers/billing-provider';
import { InvalidPayloadError, storedPayload } from './providers/razorpay-payload';

/** Razorpay's `x-razorpay-event-id`, as far as it is accepted as a key. */
export const BILLING_EVENT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** Handed the notices an applied event produced, after its transaction commits. Never awaited. */
export const BILLING_NOTICES_HANDLER = Symbol('BILLING_NOTICES_HANDLER');
export interface BillingNoticesHandler {
  send(notices: BillingNotice[]): Promise<void>;
}

export interface WebhookResult {
  status: 200 | 400 | 500;
  body: { received: boolean; replay?: true };
}

const DETAIL_CHARS = 320;

/**
 * Receives the billing provider's webhooks. The order is the guarantee:
 *
 * 1. The signature is checked over the raw bytes before anything is parsed; a
 *    missing body or a bad signature is a 400 that writes and logs nothing of it.
 * 2. The event id (a header, not part of the body) must be a plain token.
 * 3. A body that carried a valid signature but cannot be read is stored as ignored
 *    and answered 200, so the provider stops retrying it.
 * 4. The event is inserted once per id. A settled one (applied or ignored) is a
 *    replay: 200 and nothing else. A pending or failed one is applied again.
 * 5. It is applied in its own transaction, with its outcome, under a lock on the
 *    event row, so two deliveries at once apply it once.
 * 6. If applying throws, the event is marked failed and the answer is 500, so the
 *    provider retries; an event that is not ours is ignored with a 200 instead, since
 *    a webhook that keeps failing gets switched off.
 *
 * Only database work happens before answering (the provider allows a few seconds):
 * no provider calls, and notices are handed off without waiting. No body, header or
 * secret is ever logged.
 */
@Injectable()
export class BillingWebhooksService {
  private readonly logger = new Logger(BillingWebhooksService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly state: BillingStateService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Optional() @Inject(BILLING_NOTICES_HANDLER) private readonly notices?: BillingNoticesHandler,
  ) {}

  async receive(
    raw: Buffer | undefined,
    signature: string | undefined,
    eventId: string | undefined,
    now: Date = new Date(),
  ): Promise<WebhookResult> {
    if (!raw || raw.length === 0 || !this.provider.verifyWebhook(raw, signature)) {
      this.logger.warn('Refused a billing webhook: missing body or signature did not verify');
      return { status: 400, body: { received: false } };
    }
    if (typeof eventId !== 'string' || !BILLING_EVENT_ID_PATTERN.test(eventId)) {
      this.logger.warn('Refused a billing webhook: missing or malformed event id');
      return { status: 400, body: { received: false } };
    }

    let body: unknown;
    let event: BillingEvent;
    try {
      body = JSON.parse(raw.toString('utf8'));
      event = this.provider.parseWebhook(body);
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof InvalidPayloadError)) throw error;
      await this.dataSource.query(
        `INSERT INTO billing_events (provider, provider_event_id, type, event_created_at, payload, outcome, detail)
         VALUES ('razorpay', $1, 'invalid', $2, '{}', 'ignored', 'invalid payload')
         ON CONFLICT (provider_event_id) DO NOTHING`,
        [eventId, now],
      );
      this.logger.warn(`Ignored billing webhook ${eventId}: invalid payload`);
      return { status: 200, body: { received: true } };
    }

    let rowId: string;
    try {
      const inserted = await this.record(eventId, event, storedPayload(body), now);
      if (inserted.settled) return { status: 200, body: { received: true, replay: true } };
      rowId = inserted.id;
    } catch (error) {
      this.logger.error(`Could not record billing webhook ${eventId}: ${logValue((error as Error).message)}`);
      return { status: 500, body: { received: false } };
    }

    let notices: BillingNotice[] = [];
    try {
      const outcome = await this.dataSource.transaction(async (manager) => {
        const [row] = await manager.query(`SELECT outcome FROM billing_events WHERE id = $1 FOR UPDATE`, [rowId]);
        if (row.outcome === 'applied' || row.outcome === 'ignored') return 'replay' as const;
        const result = await this.state.apply(manager, event, now);
        await this.settle(manager, rowId, result.outcome, result.detail, now);
        notices = result.notices;
        return result.outcome;
      });
      if (outcome === 'replay') return { status: 200, body: { received: true, replay: true } };
    } catch (error) {
      const message = logValue((error as Error).message);
      this.logger.error(`Failed to apply billing webhook ${eventId} (${event.type}): ${message}`);
      await this.dataSource
        .query(
          `UPDATE billing_events SET outcome = 'failed', detail = $2, attempts = attempts + 1
            WHERE id = $1 AND outcome IN ('pending', 'failed')`,
          [rowId, message.slice(0, DETAIL_CHARS)],
        )
        .catch((markError: Error) =>
          this.logger.error(`Could not mark billing webhook ${eventId} failed: ${logValue(markError.message)}`),
        );
      return { status: 500, body: { received: false } };
    }

    this.handOff(notices);
    return { status: 200, body: { received: true } };
  }

  /** Inserts the event once; on a repeat, says whether the first copy settled it. */
  private async record(
    eventId: string,
    event: BillingEvent,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<{ id: string; settled: boolean }> {
    const [inserted] = await this.dataSource.query(
      `INSERT INTO billing_events (provider, provider_event_id, type, event_created_at, payload, received_at)
       VALUES ('razorpay', $1, $2, $3, $4, $5)
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING id`,
      [eventId, event.type.slice(0, 64), event.createdAt, payload, now],
    );
    if (inserted) return { id: inserted.id, settled: false };
    const [existing] = await this.dataSource.query(
      `SELECT id, outcome FROM billing_events WHERE provider_event_id = $1`,
      [eventId],
    );
    return { id: existing.id, settled: existing.outcome === 'applied' || existing.outcome === 'ignored' };
  }

  private async settle(
    manager: EntityManager,
    id: string,
    outcome: 'applied' | 'ignored',
    detail: string | null,
    now: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE billing_events
          SET outcome = $2, detail = $3, attempts = attempts + 1, applied_at = $4
        WHERE id = $1`,
      [id, outcome, detail, outcome === 'applied' ? now : null],
    );
  }

  private handOff(notices: BillingNotice[]): void {
    if (notices.length === 0 || !this.notices) return;
    this.notices.send(notices).catch((error: Error) => {
      this.logger.error(`Billing notices failed: ${logValue(error.message)}`);
    });
  }
}

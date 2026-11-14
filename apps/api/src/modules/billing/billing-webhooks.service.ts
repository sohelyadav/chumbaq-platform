import { createHash } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { logValue } from '../../common/log-value';
import { BillingLedgerService } from './billing-ledger.service';
import type { BillingNotice } from './billing-state.service';
import { BILLING_PROVIDER, BillingEvent, BillingProvider } from './providers/billing-provider';
import { InvalidPayloadError, storedPayload } from './providers/razorpay-payload';

/** Razorpay's `x-razorpay-event-id`, as far as it is accepted as a key. */
export const BILLING_EVENT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** At most one "refused" log line per this long; the others are counted into the next. */
export const REFUSAL_LOG_INTERVAL_MS = 60_000;

/** Handed the notices an applied event produced, after its transaction commits. Never awaited. */
export const BILLING_NOTICES_HANDLER = Symbol('BILLING_NOTICES_HANDLER');
export interface BillingNoticesHandler {
  send(notices: BillingNotice[]): Promise<void>;
}

export interface WebhookResult {
  status: 200 | 400 | 500;
  body: { received: boolean; replay?: true };
}

/**
 * Receives the billing provider's webhooks. The order is the guarantee:
 *
 * 1. The signature is checked over the raw bytes before anything is parsed; a
 *    missing body or a bad signature is a 400 that writes and logs nothing of it.
 * 2. The event id (a header, not part of the body) must be a plain token.
 * 3. A body that carried a valid signature but cannot be read is stored as ignored
 *    and answered 200, so the provider stops retrying it.
 * 4. The event is recorded once per id, and once per body (the signature covers the
 *    body and not the id header, so a captured body posted again under new ids is
 *    the same event), and applied (`BillingLedgerService`): a repeat of a settled
 *    event is a replay, 200 and nothing else; a pending or failed one is applied
 *    again.
 * 5. If applying throws, the event is marked failed and the answer is 500, so the
 *    provider retries; an event that is not ours is ignored with a 200 instead,
 *    since a webhook that keeps failing gets switched off.
 *
 * Only database work happens before answering (the provider allows a few seconds):
 * no provider calls, and notices are handed off without waiting. No body, header or
 * secret is ever logged, and refusals are logged at most once a minute, with a count.
 */
@Injectable()
export class BillingWebhooksService {
  private readonly logger = new Logger(BillingWebhooksService.name);
  private refusalLoggedAt = Number.NEGATIVE_INFINITY;
  private refusalsUnlogged = 0;

  constructor(
    private readonly ledger: BillingLedgerService,
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
      this.logRefusal('missing body or signature did not verify', now);
      return { status: 400, body: { received: false } };
    }
    if (typeof eventId !== 'string' || !BILLING_EVENT_ID_PATTERN.test(eventId)) {
      this.logRefusal('missing or malformed event id', now);
      return { status: 400, body: { received: false } };
    }
    const bodySha256 = createHash('sha256').update(raw).digest('hex');

    let body: unknown;
    let event: BillingEvent;
    try {
      body = JSON.parse(raw.toString('utf8'));
      event = this.provider.parseWebhook(body);
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof InvalidPayloadError)) throw error;
      await this.ledger.recordInvalid(eventId, now, bodySha256);
      this.logger.warn(`Ignored billing webhook ${eventId}: invalid payload`);
      return { status: 200, body: { received: true } };
    }

    try {
      const result = await this.ledger.recordAndApply(eventId, event, storedPayload(body), now, bodySha256);
      if (result.status === 'replay') return { status: 200, body: { received: true, replay: true } };
      this.handOff(result.notices);
      return { status: 200, body: { received: true } };
    } catch (error) {
      this.logger.error(
        `Failed to apply billing webhook ${eventId} (${logValue(event.type, 64)}): ${logValue((error as Error).message)}`,
      );
      return { status: 500, body: { received: false } };
    }
  }

  /** Anyone can post refusals, so they are logged at most once a minute, with how many came since. */
  private logRefusal(reason: string, now: Date): void {
    if (now.getTime() - this.refusalLoggedAt < REFUSAL_LOG_INTERVAL_MS) {
      this.refusalsUnlogged += 1;
      return;
    }
    const earlier = this.refusalsUnlogged > 0 ? ` (and ${this.refusalsUnlogged} more refused since the last line)` : '';
    this.logger.warn(`Refused a billing webhook: ${reason}${earlier}`);
    this.refusalLoggedAt = now.getTime();
    this.refusalsUnlogged = 0;
  }

  private handOff(notices: BillingNotice[]): void {
    if (notices.length === 0 || !this.notices) return;
    this.notices.send(notices).catch((error: Error) => {
      this.logger.error(`Billing notices failed: ${logValue(error.message)}`);
    });
  }
}

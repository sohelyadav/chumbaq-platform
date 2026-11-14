import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { logValue } from '../../common/log-value';
import { BillingNotice, BillingStateService } from './billing-state.service';
import type { BillingEvent } from './providers/billing-provider';

export type LedgerResult = { status: 'applied' | 'ignored' | 'replay'; notices: BillingNotice[] };

const DETAIL_CHARS = 320;

/**
 * Records a billing event once per id in `billing_events` and applies it, the same
 * way for a verified webhook and for the worker's reconciliation:
 *
 * - inserted once per provider event id; a repeat of a settled event (applied or
 *   ignored) is a replay and changes nothing, while a pending or failed one is
 *   applied again;
 * - applied in its own transaction, under a lock on the event row (so two copies
 *   arriving together apply it once), with the outcome written in the same
 *   transaction;
 * - if applying throws, the event is marked failed (its message through `logValue`)
 *   and the error rethrown, for the caller to answer or log.
 */
@Injectable()
export class BillingLedgerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly state: BillingStateService,
  ) {}

  /** Inserts a body that carried a valid signature but could not be read, as ignored. */
  async recordInvalid(eventId: string, now: Date): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO billing_events (provider, provider_event_id, type, event_created_at, payload, outcome, detail, received_at)
       VALUES ('razorpay', $1, 'invalid', $2, '{}', 'ignored', 'invalid payload', $2)
       ON CONFLICT (provider_event_id) DO NOTHING`,
      [eventId, now],
    );
  }

  async recordAndApply(
    eventId: string,
    event: BillingEvent,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<LedgerResult> {
    const recorded = await this.record(eventId, event, payload, now);
    if (recorded.settled) return { status: 'replay', notices: [] };

    try {
      return await this.dataSource.transaction(async (manager): Promise<LedgerResult> => {
        const [row] = await manager.query(`SELECT outcome FROM billing_events WHERE id = $1 FOR UPDATE`, [recorded.id]);
        if (row.outcome === 'applied' || row.outcome === 'ignored') return { status: 'replay', notices: [] };
        const result = await this.state.apply(manager, event, now);
        await manager.query(
          `UPDATE billing_events
              SET outcome = $2, detail = $3, attempts = attempts + 1, applied_at = $4
            WHERE id = $1`,
          [recorded.id, result.outcome, result.detail, result.outcome === 'applied' ? now : null],
        );
        return { status: result.outcome, notices: result.notices };
      });
    } catch (error) {
      await this.dataSource
        .query(
          `UPDATE billing_events SET outcome = 'failed', detail = $2, attempts = attempts + 1
            WHERE id = $1 AND outcome IN ('pending', 'failed')`,
          [recorded.id, logValue((error as Error).message).slice(0, DETAIL_CHARS)],
        )
        .catch(() => undefined);
      throw error;
    }
  }

  /** Inserts the event once; on a repeat, says whether an earlier copy settled it. */
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
}

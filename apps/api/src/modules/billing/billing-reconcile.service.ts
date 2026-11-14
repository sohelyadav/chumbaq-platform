import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { logValue } from '../../common/log-value';
import { BillingEmailsService } from './billing-emails.service';
import { BillingLedgerService } from './billing-ledger.service';
import {
  BILLING_PROVIDER,
  BillingEvent,
  BillingProvider,
  ProviderInvoice,
  ProviderSubscription,
} from './providers/billing-provider';

export const RECONCILE_BATCH = 50;
/** A period this long past its end with no renewal or end seen means a webhook was missed. */
export const RECONCILE_STALE_MS = 6 * 3600_000;
/** How far back a payment's missing invoice is still looked for. */
export const RECONCILE_INVOICE_DAYS = 60;

const seconds = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

/**
 * Catches up on webhooks that never arrived (the provider retries for a day, then
 * gives up). Hourly, at most `RECONCILE_BATCH` of each:
 *
 * - subscriptions that should have renewed or started by now (active or pending past
 *   their period end, or authorised past their start) are fetched and applied as a
 *   synthetic `subscription.reconciled` event, stamped now;
 * - payments whose invoice is missing, or has no link yet, get their subscription's
 *   invoices listed and applied as synthetic `invoice.paid` events.
 *
 * Each goes through `billing_events` like a webhook (id `reconcile_<provider id>_<unix
 * seconds>`), so it is recorded and ordered the same way. No lock is held while the
 * provider answers. One failure is logged and the rest carry on.
 */
@Injectable()
export class BillingReconcileService {
  private readonly logger = new Logger(BillingReconcileService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: BillingLedgerService,
    private readonly emails: BillingEmailsService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  /** How many synthetic events were applied. */
  async runOnce(now: Date = new Date()): Promise<number> {
    return (await this.subscriptions(now)) + (await this.invoices(now));
  }

  private async subscriptions(now: Date): Promise<number> {
    const stale: Array<{ provider_subscription_id: string }> = await this.dataSource.query(
      `SELECT provider_subscription_id FROM billing_subscriptions
        WHERE (status IN ('active', 'pending') AND current_end < $1)
           OR (status = 'authenticated' AND start_at < $1)
        ORDER BY last_event_at NULLS FIRST
        LIMIT $2`,
      [new Date(now.getTime() - RECONCILE_STALE_MS), RECONCILE_BATCH],
    );
    let applied = 0;
    for (const { provider_subscription_id: id } of stale) {
      try {
        const subscription = await this.provider.fetchSubscription(id);
        const event: BillingEvent = {
          type: 'subscription.reconciled',
          createdAt: now,
          subscription,
          payment: null,
          invoice: null,
          refund: null,
        };
        const result = await this.ledger.recordAndApply(
          `reconcile_${id}_${seconds(now)}`,
          event,
          { source: 'reconcile', subscription: subscriptionPayload(subscription) },
          now,
        );
        if (result.status !== 'replay') applied += 1;
        if (result.notices.length > 0) await this.emails.send(result.notices);
      } catch (error) {
        this.logger.warn(`Billing reconcile of subscription ${id} failed: ${logValue((error as Error).message)}`);
      }
    }
    return applied;
  }

  private async invoices(now: Date): Promise<number> {
    const missing: Array<{ provider_subscription_id: string; invoice_ids: string[] }> = await this.dataSource.query(
      `SELECT s.provider_subscription_id, array_agg(DISTINCT p.provider_invoice_id) AS invoice_ids
         FROM billing_payments p
         JOIN billing_subscriptions s ON s.id = p.subscription_id
         LEFT JOIN billing_invoices i ON i.provider_invoice_id = p.provider_invoice_id
        WHERE p.provider_invoice_id IS NOT NULL
          AND p.status <> 'failed'
          AND p.paid_at > $1
          AND (i.id IS NULL OR i.short_url IS NULL)
        GROUP BY s.provider_subscription_id
        LIMIT $2`,
      [new Date(now.getTime() - RECONCILE_INVOICE_DAYS * 24 * 3600_000), RECONCILE_BATCH],
    );
    let applied = 0;
    for (const row of missing) {
      try {
        const wanted = new Set(row.invoice_ids);
        const listed = await this.provider.listSubscriptionInvoices(row.provider_subscription_id);
        for (const invoice of listed.filter((i) => wanted.has(i.id))) {
          const event: BillingEvent = {
            type: 'invoice.paid',
            createdAt: now,
            subscription: null,
            payment: null,
            invoice,
            refund: null,
          };
          const result = await this.ledger.recordAndApply(
            `reconcile_${invoice.id}_${seconds(now)}`,
            event,
            { source: 'reconcile', invoice: invoicePayload(invoice) },
            now,
          );
          if (result.status !== 'replay') applied += 1;
        }
      } catch (error) {
        this.logger.warn(
          `Billing reconcile of invoices for ${row.provider_subscription_id} failed: ${logValue((error as Error).message)}`,
        );
      }
    }
    return applied;
  }
}

function subscriptionPayload(s: ProviderSubscription): Record<string, unknown> {
  return {
    id: s.id,
    plan_id: s.planId,
    customer_id: s.customerId,
    status: s.status,
    current_start: seconds(s.currentStart),
    current_end: seconds(s.currentEnd),
    start_at: seconds(s.startAt),
    charge_at: seconds(s.chargeAt),
    ended_at: seconds(s.endedAt),
    paid_count: s.paidCount,
  };
}

function invoicePayload(i: ProviderInvoice): Record<string, unknown> {
  return {
    id: i.id,
    subscription_id: i.subscriptionId,
    customer_id: i.customerId,
    payment_id: i.paymentId,
    status: i.status,
    amount: i.amountPaise,
    tax_amount: i.providerTaxPaise,
    currency: i.currency,
    billing_start: seconds(i.billingStart),
    billing_end: seconds(i.billingEnd),
    issued_at: seconds(i.issuedAt),
    paid_at: seconds(i.paidAt),
    short_url: i.shortUrl,
    invoice_number: i.number,
  };
}

import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { type BillingConfig, DEFAULT_BILLING_GRACE_DAYS } from '../../config/billing.config';
import { isLive } from './effective-plan';
import { toSubscriptionState } from './effective-plan-sql';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import { PlanPriceEntity } from './entities/plan-price.entity';
import { EVENT_RANK, isTerminalStatus, shouldApplyStatus } from './event-order';
import { GST_RATE_BPS, netOfTax } from './money';
import type {
  BillingEvent,
  ProviderInvoice,
  ProviderPayment,
  ProviderSubscription,
} from './providers/billing-provider';

export type BillingNotice = { kind: 'halted'; userId: string; graceUntil: Date };
export type ApplyResult = { outcome: 'applied' | 'ignored'; detail: string | null; notices: BillingNotice[] };

const DAY_MS = 24 * 3600_000;
const FAILURE_REASON_CHARS = 200;

/** A subscription that has started charging: the point a successor replaces the current one. */
const STARTED: ReadonlySet<string> = new Set(['active', 'pending', 'halted']);

const ignored = (detail: string): ApplyResult => ({ outcome: 'ignored', detail, notices: [] });
const applied = (detail: string | null = null, notices: BillingNotice[] = []): ApplyResult => ({
  outcome: 'applied',
  detail,
  notices,
});

type PaymentRow = { user_id: string; subscription_id: string | null; tax_rate_bps: number };

/**
 * Applies one provider event to the subscription mirror, the account it belongs to,
 * and the ledger of invoices and payments. The caller holds the transaction; every
 * write is under the account's `billing_accounts` row lock (FOR UPDATE), taken
 * before anything is changed. Nothing here calls the provider or sends email: the
 * webhook has seconds to answer, so cancels go to the outbox and notices are handed
 * back to the caller.
 *
 * What may change state, and how:
 * - Only the account's current or next subscription moves the account. A superseded
 *   subscription, or one the account no longer points at (a second Checkout tab),
 *   keeps its own mirror up to date and nothing more, so its charge can be listed
 *   for staff but never grants or removes a plan.
 * - Periods only move forward, a terminal status never revives, and two events in
 *   one second are ordered by rank (`event-order.ts`), so late and repeated
 *   deliveries change nothing they should not.
 * - Payments, invoices and refunds are recorded only when they match one of our
 *   accounts (by invoice, subscription or customer); anything else is ignored, since
 *   the same provider account may serve other products.
 */
@Injectable()
export class BillingStateService {
  constructor(@Optional() private readonly config?: ConfigService) {}

  private get graceDays(): number {
    return this.config?.get<BillingConfig>('billing')?.graceDays ?? DEFAULT_BILLING_GRACE_DAYS;
  }

  async apply(manager: EntityManager, event: BillingEvent, now: Date): Promise<ApplyResult> {
    if (event.type.startsWith('subscription.')) {
      return event.subscription ? this.applySubscription(manager, event, event.subscription, now) : ignored('no subscription');
    }
    switch (event.type) {
      case 'payment.failed':
        return event.payment ? this.applyFailedPayment(manager, event.payment) : ignored('no payment');
      case 'invoice.paid':
      case 'invoice.expired':
        return event.invoice ? this.applyInvoice(manager, event.invoice, event.payment) : ignored('no invoice');
      case 'refund.processed':
        return event.refund ? this.applyRefund(manager, event) : ignored('no refund');
      default:
        return ignored('unhandled type');
    }
  }

  // ---------------------------------------------------------------- subscriptions

  private async applySubscription(
    manager: EntityManager,
    event: BillingEvent,
    incoming: ProviderSubscription,
    now: Date,
  ): Promise<ApplyResult> {
    const found = await manager.findOne(BillingSubscriptionEntity, {
      where: { providerSubscriptionId: incoming.id },
      select: { id: true, userId: true },
    });
    if (!found) return ignored('unknown subscription');
    const price = await manager.findOne(PlanPriceEntity, { where: { razorpayPlanId: incoming.planId } });
    if (!price) return ignored('unknown plan');

    const account = await this.lockAccount(manager, found.userId);
    const sub = await manager.findOneOrFail(BillingSubscriptionEntity, {
      where: { id: found.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (price.id !== sub.priceId) return ignored('plan mismatch');

    // The mirror: periods forward only, counts never down, the status in event order.
    const patch: Partial<BillingSubscriptionEntity> = {};
    if (incoming.currentEnd && (!sub.currentEnd || incoming.currentEnd > sub.currentEnd)) {
      patch.currentStart = incoming.currentStart;
      patch.currentEnd = incoming.currentEnd;
      patch.chargeAt = incoming.chargeAt;
    }
    if (incoming.paidCount > sub.paidCount) patch.paidCount = incoming.paidCount;
    if (!sub.startAt && incoming.startAt) patch.startAt = incoming.startAt;
    if (!sub.endedAt && incoming.endedAt) patch.endedAt = incoming.endedAt;

    const wasStatus = sub.status;
    let enteredHalted = false;
    if (shouldApplyStatus(sub, { status: incoming.status, at: event.createdAt })) {
      patch.lastEventAt = event.createdAt;
      patch.lastEventRank = EVENT_RANK[incoming.status];
      if (incoming.status !== wasStatus) {
        patch.status = incoming.status;
        patch.statusChangedAt = now;
        if (incoming.status === 'halted') {
          patch.graceUntil = new Date(now.getTime() + this.graceDays * DAY_MS);
          enteredHalted = true;
        } else if (wasStatus === 'halted') {
          patch.graceUntil = null;
        }
      }
    }
    if (Object.keys(patch).length > 0) await manager.update(BillingSubscriptionEntity, { id: sub.id }, patch);
    const updated: BillingSubscriptionEntity = { ...sub, ...patch } as BillingSubscriptionEntity;

    if (incoming.customerId) await this.adoptCustomer(manager, account.userId, incoming.customerId);
    if (event.payment) await this.recordSubscriptionPayment(manager, updated, price, event.payment, incoming);

    const role =
      updated.supersededBy !== null
        ? 'other'
        : account.currentSubscriptionId === updated.id
          ? 'current'
          : account.nextSubscriptionId === updated.id
            ? 'next'
            : 'other';
    if (role === 'other') return applied('superseded');

    const notices: BillingNotice[] =
      enteredHalted && updated.graceUntil ? [{ kind: 'halted', userId: account.userId, graceUntil: updated.graceUntil }] : [];
    if (role === 'next') await this.advanceNext(manager, account, updated, now);
    return applied(null, notices);
  }

  /**
   * The account's next subscription moved. Authorised with a start date while a live
   * current renews on its own: the current is queued to cancel at the end of its
   * cycle. Started charging: it becomes the current, and the old one is superseded.
   * Ended without starting (an abandoned Checkout expiring): the pointer is cleared.
   */
  private async advanceNext(
    manager: EntityManager,
    account: BillingAccountEntity,
    next: BillingSubscriptionEntity,
    now: Date,
  ): Promise<void> {
    const current = account.currentSubscriptionId
      ? await manager.findOne(BillingSubscriptionEntity, {
          where: { id: account.currentSubscriptionId },
          lock: { mode: 'pessimistic_write' },
        })
      : null;

    if (next.status === 'authenticated') {
      if (next.startAt && current && isLive(toSubscriptionState(current), now) && !current.cancelAtPeriodEnd) {
        await this.requestCancelAtCycleEnd(manager, current.id, now);
      }
      return;
    }

    if (STARTED.has(next.status)) {
      if (current && current.id !== next.id) {
        await manager.update(BillingSubscriptionEntity, { id: current.id }, { supersededBy: next.id });
        if (isLive(toSubscriptionState(current), now)) await this.requestCancelAtCycleEnd(manager, current.id, now);
      }
      await manager.update(BillingSubscriptionEntity, { id: next.id }, { wasCurrent: true });
      await manager.update(
        BillingAccountEntity,
        { userId: account.userId },
        { currentSubscriptionId: next.id, nextSubscriptionId: null },
      );
      return;
    }

    if (isTerminalStatus(next.status)) {
      await manager.update(BillingAccountEntity, { userId: account.userId }, { nextSubscriptionId: null });
    }
  }

  /** Queues a cancel for the worker, unless one is already queued. */
  private async requestCancelAtCycleEnd(manager: EntityManager, subscriptionId: string, now: Date): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(BillingSubscriptionEntity)
      .set({ cancelRequestedAt: now, cancelAtCycleEnd: true, cancelRequestedBy: null })
      .where('id = :id AND cancel_requested_at IS NULL', { id: subscriptionId })
      .execute();
  }

  /** The provider's customer id, kept when the account has none and no other account holds it. */
  private async adoptCustomer(manager: EntityManager, userId: string, customerId: string): Promise<void> {
    await manager.query(
      `UPDATE billing_accounts SET provider_customer_id = $2, updated_at = now()
        WHERE user_id = $1 AND provider_customer_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM billing_accounts other WHERE other.provider_customer_id = $2)`,
      [userId, customerId],
    );
  }

  private async recordSubscriptionPayment(
    manager: EntityManager,
    sub: BillingSubscriptionEntity,
    price: PlanPriceEntity,
    payment: ProviderPayment,
    incoming: ProviderSubscription,
  ): Promise<void> {
    const stored = await this.upsertPayment(manager, payment, {
      userId: sub.userId,
      subscriptionId: sub.id,
      taxRateBps: price.taxRateBps,
    });
    if (!stored) return;
    if (payment.status === 'captured' && payment.method && !sub.method) {
      await manager.query(`UPDATE billing_subscriptions SET method = $2 WHERE id = $1 AND method IS NULL`, [
        sub.id,
        payment.method.slice(0, 20),
      ]);
    }
    // A placeholder until the invoice itself arrives; never overwrites a fuller row.
    if (payment.invoiceId && payment.status === 'captured') {
      await manager.query(
        `INSERT INTO billing_invoices
           (provider_invoice_id, user_id, subscription_id, status, amount_paise, tax_paise, provider_tax_paise,
            currency, period_start, period_end, issued_at, paid_at)
         VALUES ($1, $2, $3, 'paid', $4, $5, 0, $6, $7, $8, $9, $9)
         ON CONFLICT (provider_invoice_id) DO UPDATE SET
           status = 'paid',
           paid_at = COALESCE(billing_invoices.paid_at, EXCLUDED.paid_at),
           updated_at = now()`,
        [
          payment.invoiceId,
          sub.userId,
          sub.id,
          payment.amountPaise,
          payment.amountPaise - netOfTax(payment.amountPaise, price.taxRateBps),
          payment.currency,
          incoming.currentStart,
          incoming.currentEnd,
          payment.createdAt,
        ],
      );
    }
  }

  // -------------------------------------------------------------------- payments

  private async applyFailedPayment(manager: EntityManager, payment: ProviderPayment): Promise<ApplyResult> {
    let owner: { userId: string; subscriptionId: string | null; taxRateBps: number } | null = null;
    if (payment.invoiceId) {
      const [row] = await manager.query(
        `SELECT i.user_id, i.subscription_id, p.tax_rate_bps
           FROM billing_invoices i
           LEFT JOIN billing_subscriptions s ON s.id = i.subscription_id
           LEFT JOIN plan_prices p ON p.id = s.price_id
          WHERE i.provider_invoice_id = $1`,
        [payment.invoiceId],
      );
      if (row) owner = { userId: row.user_id, subscriptionId: row.subscription_id, taxRateBps: row.tax_rate_bps ?? GST_RATE_BPS };
    }
    if (!owner && payment.customerId) {
      const [row] = await manager.query(`SELECT user_id FROM billing_accounts WHERE provider_customer_id = $1`, [
        payment.customerId,
      ]);
      if (row) owner = { userId: row.user_id, subscriptionId: null, taxRateBps: GST_RATE_BPS };
    }
    if (!owner) return ignored('not ours');
    await this.lockAccount(manager, owner.userId);
    const stored = await this.upsertPayment(manager, payment, owner);
    return stored ? applied() : ignored('unrecorded status');
  }

  /**
   * Inserts or updates a payment. Only captured, failed and refunded payments are
   * kept. A captured payment never goes back to failed, refunds only rise (and never
   * above the amount), and the owner of a stored payment never changes.
   */
  private async upsertPayment(
    manager: EntityManager,
    payment: ProviderPayment,
    owner: { userId: string; subscriptionId: string | null; taxRateBps: number },
  ): Promise<boolean> {
    const refunded = Math.min(payment.amountRefundedPaise, payment.amountPaise);
    const status =
      payment.status === 'refunded' || (payment.status === 'captured' && payment.amountPaise > 0 && refunded >= payment.amountPaise)
        ? 'refunded'
        : payment.status === 'captured' || payment.status === 'failed'
          ? payment.status
          : null;
    if (!status) return false;
    const failureReason =
      status === 'failed' ? (payment.errorReason ?? payment.errorDescription)?.slice(0, FAILURE_REASON_CHARS) ?? null : null;
    await manager.query(
      `INSERT INTO billing_payments
         (provider_payment_id, user_id, subscription_id, provider_invoice_id, amount_paise, amount_refunded_paise,
          tax_rate_bps, currency, status, method, failure_reason, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (provider_payment_id) DO UPDATE SET
         subscription_id = COALESCE(billing_payments.subscription_id, EXCLUDED.subscription_id),
         provider_invoice_id = COALESCE(billing_payments.provider_invoice_id, EXCLUDED.provider_invoice_id),
         amount_refunded_paise = GREATEST(billing_payments.amount_refunded_paise, EXCLUDED.amount_refunded_paise),
         status = CASE
           WHEN billing_payments.status = 'refunded' OR EXCLUDED.status = 'refunded' THEN 'refunded'
           WHEN billing_payments.status = 'captured' OR EXCLUDED.status = 'captured' THEN 'captured'
           ELSE 'failed' END,
         method = COALESCE(billing_payments.method, EXCLUDED.method),
         failure_reason = CASE WHEN billing_payments.status = 'failed' AND EXCLUDED.status = 'failed'
           THEN COALESCE(EXCLUDED.failure_reason, billing_payments.failure_reason) ELSE billing_payments.failure_reason END,
         updated_at = now()`,
      [
        payment.id,
        owner.userId,
        owner.subscriptionId,
        payment.invoiceId,
        payment.amountPaise,
        refunded,
        owner.taxRateBps,
        payment.currency,
        status,
        payment.method?.slice(0, 20) ?? null,
        failureReason,
        payment.createdAt,
      ],
    );
    return true;
  }

  // -------------------------------------------------------------------- invoices

  private async applyInvoice(
    manager: EntityManager,
    invoice: ProviderInvoice,
    payment: ProviderPayment | null,
  ): Promise<ApplyResult> {
    let owner: { userId: string; subscriptionId: string | null; taxRateBps: number } | null = null;
    if (invoice.subscriptionId) {
      const [row] = await manager.query(
        `SELECT s.user_id, s.id, p.tax_rate_bps
           FROM billing_subscriptions s JOIN plan_prices p ON p.id = s.price_id
          WHERE s.provider_subscription_id = $1`,
        [invoice.subscriptionId],
      );
      if (row) owner = { userId: row.user_id, subscriptionId: row.id, taxRateBps: row.tax_rate_bps };
    }
    if (!owner && invoice.customerId) {
      const [row] = await manager.query(`SELECT user_id FROM billing_accounts WHERE provider_customer_id = $1`, [
        invoice.customerId,
      ]);
      if (row) owner = { userId: row.user_id, subscriptionId: null, taxRateBps: GST_RATE_BPS };
    }
    if (!owner) return ignored('not ours');
    await this.lockAccount(manager, owner.userId);

    await manager.query(
      `INSERT INTO billing_invoices
         (provider_invoice_id, user_id, subscription_id, status, amount_paise, tax_paise, provider_tax_paise, currency,
          period_start, period_end, issued_at, paid_at, short_url, number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (provider_invoice_id) DO UPDATE SET
         subscription_id = COALESCE(billing_invoices.subscription_id, EXCLUDED.subscription_id),
         status = CASE WHEN billing_invoices.status = 'paid' THEN 'paid' ELSE EXCLUDED.status END,
         amount_paise = EXCLUDED.amount_paise,
         tax_paise = EXCLUDED.tax_paise,
         provider_tax_paise = EXCLUDED.provider_tax_paise,
         currency = EXCLUDED.currency,
         period_start = COALESCE(EXCLUDED.period_start, billing_invoices.period_start),
         period_end = COALESCE(EXCLUDED.period_end, billing_invoices.period_end),
         issued_at = COALESCE(EXCLUDED.issued_at, billing_invoices.issued_at),
         paid_at = COALESCE(billing_invoices.paid_at, EXCLUDED.paid_at),
         short_url = COALESCE(EXCLUDED.short_url, billing_invoices.short_url),
         number = COALESCE(EXCLUDED.number, billing_invoices.number),
         updated_at = now()`,
      [
        invoice.id,
        owner.userId,
        owner.subscriptionId,
        invoice.status.slice(0, 20),
        invoice.amountPaise,
        invoice.amountPaise - netOfTax(invoice.amountPaise, owner.taxRateBps),
        invoice.providerTaxPaise,
        invoice.currency,
        invoice.billingStart,
        invoice.billingEnd,
        invoice.issuedAt,
        invoice.paidAt,
        invoice.shortUrl && invoice.shortUrl.length <= 200 ? invoice.shortUrl : null,
        invoice.number?.slice(0, 40) ?? null,
      ],
    );
    if (payment && payment.invoiceId === invoice.id) await this.upsertPayment(manager, payment, owner);
    return applied();
  }

  // --------------------------------------------------------------------- refunds

  private async applyRefund(manager: EntityManager, event: BillingEvent): Promise<ApplyResult> {
    const refund = event.refund!;
    const [row]: PaymentRow[] = await manager.query(
      `SELECT user_id, subscription_id, tax_rate_bps FROM billing_payments WHERE provider_payment_id = $1`,
      [refund.paymentId],
    );
    if (!row) return ignored('not ours');
    await this.lockAccount(manager, row.user_id);
    // Cumulative on the payment; the refund's own amount is only a floor when the payment is absent.
    const cumulative =
      event.payment && event.payment.id === refund.paymentId ? event.payment.amountRefundedPaise : refund.amountPaise;
    await manager.query(
      `UPDATE billing_payments SET
         amount_refunded_paise = GREATEST(amount_refunded_paise, LEAST($2::int, amount_paise)),
         status = CASE WHEN status <> 'failed' AND GREATEST(amount_refunded_paise, LEAST($2::int, amount_paise)) >= amount_paise
                       THEN 'refunded' ELSE status END,
         updated_at = now()
       WHERE provider_payment_id = $1`,
      [refund.paymentId, cumulative],
    );
    return applied();
  }

  // ------------------------------------------------------------------------ util

  /** The account row, created if missing, locked FOR UPDATE: every write here happens under it. */
  private async lockAccount(manager: EntityManager, userId: string): Promise<BillingAccountEntity> {
    await manager.query(`INSERT INTO billing_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    return manager.findOneOrFail(BillingAccountEntity, { where: { userId }, lock: { mode: 'pessimistic_write' } });
  }
}

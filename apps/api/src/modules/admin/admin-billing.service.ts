import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type {
  AdminBillingPayment,
  AdminBillingSummary,
  AdminTenantBilling,
  BillingInterval,
  MoneySplit,
} from '@chumbaq/shared';
import { logValue } from '../../common/log-value';
import { reachProvider } from '../push-notifications/services/per-recipient-provider';
import { readUsageCoverage } from '../usage/usage-rollup.service';
import { BillingOutboxService, OUTBOX_REQUEST_HOLD_MS } from '../billing/billing-outbox.service';
import { BillingOverviewService, invoiceView } from '../billing/billing-overview.service';
import { FREE_PLAN, isLive } from '../billing/effective-plan';
import { toSubscriptionState } from '../billing/effective-plan-sql';
import { BillingAccountEntity } from '../billing/entities/billing-account.entity';
import { BillingInvoiceEntity } from '../billing/entities/billing-invoice.entity';
import { BillingSubscriptionEntity } from '../billing/entities/billing-subscription.entity';
import { PlanEntity } from '../billing/entities/plan.entity';
import { tenantMauOverLimitSql } from '../billing/mau-notices.service';
import { annualisedPaise, netOfTax } from '../billing/money';
import { BILLING_PROVIDER, BillingProvider, BillingProviderError } from '../billing/providers/billing-provider';
import { AdminAuditService } from './admin-audit.service';
import type { AdminActor } from './admin-tenants.service';
import type { AdminCancelSubscriptionDto, AdminCompDto } from './dto/admin-billing.dto';

export const ADMIN_BILLING_MESSAGES = {
  tenantNotFound: 'Tenant not found',
  invoiceNotFound: 'Invoice not found',
  hasSubscription: 'This account has a subscription. Cancel it first.',
  noSuchPlan: 'That plan does not exist.',
  noComp: 'This account has no comp.',
  compUntil: 'A comp must end in the future, and within five years.',
  nothingToCancel: 'There is no subscription to cancel.',
  alreadyEnding: 'The subscription already ends at the period end.',
  alreadyCancelling: 'A cancel for this subscription is already on its way.',
  cancelQueued: 'Razorpay could not cancel the subscription yet. The cancel is recorded and will be retried.',
  providerRefusedResend: 'Razorpay could not send the invoice. Try again later.',
} as const;

/** How many rows each recent list holds. */
export const RECENT_PAYMENTS = 20;
/** How many of an account's invoices and payments the tenant card shows. */
export const TENANT_HISTORY_ROWS = 50;
const DAY_MS = 24 * 3600_000;
/** The furthest a comp's end may be set: five years of 365.25 days. */
const COMP_MAX_MS = Math.round(5 * 365.25 * DAY_MS);
/** Statuses staff may cancel: anything that can still charge. */
const CANCELLABLE = new Set(['authenticated', 'active', 'pending', 'halted']);

const ZERO: MoneySplit = { netPaise: 0, taxPaise: 0, grossPaise: 0 };

const split = (grossPaise: number, netPaise: number): MoneySplit => ({
  netPaise,
  taxPaise: grossPaise - netPaise,
  grossPaise,
});

export interface RecurringRow {
  planCode: string;
  interval: BillingInterval;
  /** Excluding GST. */
  pricePaise: number;
  /** Including GST. */
  amountPaise: number;
}

/**
 * Recurring revenue from the paying subscriptions: ARR is the sum of each price as a
 * yearly amount, and MRR that sum over twelve, rounded down once. Dividing each row
 * first would lose up to a paisa a row. Excluding GST, with the GST beside it.
 */
export function summariseMoney(rows: RecurringRow[]): {
  mrr: MoneySplit;
  arr: MoneySplit;
  byPlan: Map<string, { accounts: number; mrrNetPaise: number }>;
} {
  let arrNet = 0n;
  let arrGross = 0n;
  const plans = new Map<string, { accounts: number; arrNet: bigint }>();
  for (const row of rows) {
    const net = BigInt(annualisedPaise(row.pricePaise, row.interval));
    arrNet += net;
    arrGross += BigInt(annualisedPaise(row.amountPaise, row.interval));
    const plan = plans.get(row.planCode) ?? { accounts: 0, arrNet: 0n };
    plans.set(row.planCode, { accounts: plan.accounts + 1, arrNet: plan.arrNet + net });
  }
  const byPlan = new Map(
    [...plans].map(([code, p]) => [code, { accounts: p.accounts, mrrNetPaise: Number(p.arrNet / 12n) }]),
  );
  return {
    mrr: rows.length ? split(Number(arrGross / 12n), Number(arrNet / 12n)) : { ...ZERO },
    arr: rows.length ? split(Number(arrGross), Number(arrNet)) : { ...ZERO },
    byPlan,
  };
}

/** What a payment kept: its amount less refunds, and that split by its GST rate. */
export function keptMoney(payment: { amountPaise: number; refundedPaise: number; taxRateBps: number }): MoneySplit {
  const gross = payment.amountPaise - payment.refundedPaise;
  return split(gross, netOfTax(gross, payment.taxRateBps));
}

/**
 * `keptMoney` in SQL over payments aliased `p`: the same `netOfTax` formula, in bigint
 * integer division. Gross and net summed; GST is the difference.
 */
const KEPT_GROSS_SQL = `(p.amount_paise - p.amount_refunded_paise)::bigint`;
const KEPT_NET_SQL = `((${KEPT_GROSS_SQL} * 20000 + (10000 + p.tax_rate_bps)) / (2 * (10000 + p.tax_rate_bps)))`;
const REVENUE_STATUSES = `p.status IN ('captured', 'refunded')`;

/**
 * The account's current subscription charges on its own (`cur` is it): active, or
 * pending while the provider retries a payment. Counted as recurring revenue whatever
 * the comp: a comped account may still subscribe (the comp gives the plan meanwhile),
 * and its charges are revenue like anyone's, so MRR agrees with the money received.
 */
const PAYING_SQL = `cur.status IN ('active', 'pending')`;

/** A comp is in force with no end, or until a time still ahead. */
const COMP_ACTIVE_SQL = (now: string) =>
  `(ba.comp_plan_code IS NOT NULL AND (ba.comp_until IS NULL OR ba.comp_until > ${now}))`;

interface PaymentRow {
  id: string;
  user_id: string;
  email: string;
  amount_paise: number;
  amount_refunded_paise: number;
  tax_rate_bps: number;
  status: 'captured' | 'failed' | 'refunded';
  method: string | null;
  failure_reason: string | null;
  paid_at: Date;
  orphan: boolean;
}

const PAYMENT_SELECT = `
  SELECT p.id, p.user_id, u.email, p.amount_paise, p.amount_refunded_paise, p.tax_rate_bps, p.status,
         p.method, p.failure_reason, p.paid_at,
         COALESCE(s.superseded_by IS NOT NULL AND NOT s.was_current, false) AS orphan
    FROM billing_payments p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN billing_subscriptions s ON s.id = p.subscription_id`;

function paymentView(row: PaymentRow): AdminBillingPayment {
  const kept = row.status === 'failed' ? { ...ZERO } : keptMoney({
    amountPaise: row.amount_paise,
    refundedPaise: row.amount_refunded_paise,
    taxRateBps: row.tax_rate_bps,
  });
  return {
    id: row.id,
    tenantId: row.user_id,
    tenantEmail: row.email,
    amountPaise: row.amount_paise,
    refundedPaise: row.amount_refunded_paise,
    netPaise: kept.netPaise,
    status: row.status,
    method: row.method,
    failureReason: row.failure_reason,
    paidAt: new Date(row.paid_at).toISOString(),
    orphan: row.orphan,
  };
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/**
 * Billing for staff, on the admin API only and only while billing is on: the
 * revenue summary, one account's billing, and staff's actions on it (comp, end comp,
 * cancel, resend an invoice).
 *
 * Every action needs a reason and writes its audit row in the transaction of its
 * change, after the `users` row and then the `billing_accounts` row are locked (the
 * order every billing transaction takes them in). A provider call is made with no
 * lock held, before the transaction; the resend changes nothing of ours, so its audit
 * row is written right after the provider accepted it.
 */
@Injectable()
export class AdminBillingService {
  private readonly logger = new Logger(AdminBillingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    private readonly overviews: BillingOverviewService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly outbox: BillingOutboxService,
  ) {}

  async summary(now: Date = new Date(), manager: EntityManager = this.dataSource.manager): Promise<AdminBillingSummary> {
    const plans = await manager.find(PlanEntity, { order: { sortOrder: 'ASC', code: 'ASC' } });
    const recurring: Array<{
      plan_code: string;
      interval: BillingInterval;
      price_paise: number;
      amount_paise: number;
    }> = await manager.query(
      `SELECT cur.plan_code, pp.interval, pp.price_paise, pp.amount_paise
         FROM billing_accounts ba
         JOIN billing_subscriptions cur ON cur.id = ba.current_subscription_id
         JOIN plan_prices pp ON pp.id = cur.price_id
        WHERE ${PAYING_SQL}`,
    );
    const money = summariseMoney(
      recurring.map((r) => ({
        planCode: r.plan_code,
        interval: r.interval,
        pricePaise: r.price_paise,
        amountPaise: r.amount_paise,
      })),
    );
    const names = new Map(plans.map((p) => [p.code, p.name]));
    const byPlan = [...money.byPlan]
      .map(([planCode, p]) => ({ planCode, planName: names.get(planCode) ?? planCode, ...p }))
      .sort((a, b) => b.mrrNetPaise - a.mrrNetPaise || a.planCode.localeCompare(b.planCode));

    const [window] = await manager.query(
      `SELECT COALESCE(SUM(${KEPT_GROSS_SQL}), 0)::text AS gross, COALESCE(SUM(${KEPT_NET_SQL}), 0)::text AS net
         FROM billing_payments p
        WHERE ${REVENUE_STATUSES} AND p.paid_at > $1::timestamptz - interval '30 days' AND p.paid_at <= $1`,
      [now],
    );
    const months: Array<{ month: string; gross: string; net: string }> = await manager.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') - interval '11 months',
           date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC'),
           interval '1 month') AS m)
       SELECT to_char(m, 'YYYY-MM') AS month,
              COALESCE(SUM(${KEPT_GROSS_SQL}), 0)::text AS gross,
              COALESCE(SUM(${KEPT_NET_SQL}), 0)::text AS net
         FROM months
         LEFT JOIN billing_payments p
           ON ${REVENUE_STATUSES}
          AND (p.paid_at AT TIME ZONE 'UTC') >= m
          AND (p.paid_at AT TIME ZONE 'UTC') < m + interval '1 month'
        GROUP BY m
        ORDER BY m`,
      [now],
    );

    const pastDue: Array<{
      user_id: string;
      email: string;
      status: 'pending' | 'halted';
      status_changed_at: Date;
      grace_until: Date | null;
    }> = await manager.query(
      `SELECT ba.user_id, u.email, cur.status, cur.status_changed_at, cur.grace_until
         FROM billing_accounts ba
         JOIN users u ON u.id = ba.user_id
         JOIN billing_subscriptions cur ON cur.id = ba.current_subscription_id
        WHERE cur.status IN ('pending', 'halted')
        ORDER BY cur.status_changed_at, ba.user_id`,
    );

    const recentPayments: PaymentRow[] = await manager.query(
      `${PAYMENT_SELECT} ORDER BY p.paid_at DESC, p.id LIMIT ${RECENT_PAYMENTS}`,
    );
    const recentFailures: PaymentRow[] = await manager.query(
      `${PAYMENT_SELECT} WHERE p.status = 'failed' ORDER BY p.paid_at DESC, p.id LIMIT ${RECENT_PAYMENTS}`,
    );

    const comped: Array<{
      user_id: string;
      email: string;
      comp_plan_code: string;
      comp_until: Date | null;
      comp_reason: string | null;
      paying: boolean;
    }> =
      await manager.query(
        `SELECT ba.user_id, u.email, ba.comp_plan_code, ba.comp_until, ba.comp_reason,
                (cur.id IS NOT NULL AND ${PAYING_SQL}) AS paying
           FROM billing_accounts ba
           JOIN users u ON u.id = ba.user_id
           LEFT JOIN billing_subscriptions cur ON cur.id = ba.current_subscription_id
          WHERE ${COMP_ACTIVE_SQL('$1')}
          ORDER BY ba.comped_at DESC NULLS LAST, ba.user_id`,
        [now],
      );
    const [{ cancelling }] = await manager.query(
      `SELECT count(*)::int AS cancelling
         FROM billing_accounts ba
         JOIN billing_subscriptions cur ON cur.id = ba.current_subscription_id
        WHERE cur.status = 'active' AND cur.cancel_at_period_end`,
    );
    const outbox: Array<{ id: string; user_id: string; cancel_error: string; cancel_attempts: number }> =
      await manager.query(
        `SELECT id, user_id, cancel_error, cancel_attempts FROM billing_subscriptions
          WHERE cancel_requested_at IS NOT NULL AND cancel_sent_at IS NULL AND cancel_error IS NOT NULL
          ORDER BY cancel_requested_at, id`,
      );

    return {
      mrr: money.mrr,
      arr: money.arr,
      byPlan,
      revenue30d: split(Number(window.gross), Number(window.net)),
      revenueByMonth: months.map((m) => ({ month: m.month, ...split(Number(m.gross), Number(m.net)) })),
      pastDue: pastDue.map((r) => ({
        tenantId: r.user_id,
        email: r.email,
        status: r.status,
        since: new Date(r.status_changed_at).toISOString(),
        daysOverdue: Math.max(0, Math.floor((now.getTime() - new Date(r.status_changed_at).getTime()) / DAY_MS)),
        graceUntil: iso(r.grace_until),
      })),
      recentPayments: recentPayments.map(paymentView),
      recentFailures: recentFailures.map(paymentView),
      overMau: await this.overMau(manager, now),
      comped: comped.map((r) => ({
        tenantId: r.user_id,
        email: r.email,
        planCode: r.comp_plan_code,
        until: iso(r.comp_until),
        reason: r.comp_reason ?? '',
        paying: r.paying,
      })),
      cancelling,
      outboxErrors: outbox.map((r) => ({
        subscriptionId: r.id,
        tenantId: r.user_id,
        error: r.cancel_error,
        attempts: r.cancel_attempts,
      })),
    };
  }

  /** One account's billing, recorded as a staff read of the tenant (deduplicated with the tenant page). */
  async viewTenant(id: string, actor: AdminActor): Promise<AdminTenantBilling> {
    const billing = await this.tenantBilling(id);
    const [user] = await this.dataSource.query(`SELECT email FROM users WHERE id = $1`, [id]);
    await this.audit.recordRead({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: 'tenant.viewed',
      targetType: 'tenant',
      targetId: id,
      targetLabel: user.email,
      ipAddress: actor.ipAddress || null,
    });
    return billing;
  }

  async tenantBilling(id: string, now: Date = new Date()): Promise<AdminTenantBilling> {
    const manager = this.dataSource.manager;
    const [user] = await manager.query(`SELECT id FROM users WHERE id = $1`, [id]);
    if (!user) throw new NotFoundException(ADMIN_BILLING_MESSAGES.tenantNotFound);

    const { plans: _plans, keyId: _keyId, ...overview } = await this.overviews.overview(id, now);
    const [account] = await manager.query(
      `SELECT ba.comp_plan_code, ba.comp_until, ba.comp_reason, ba.comped_at, s.email AS comped_by_email
         FROM billing_accounts ba LEFT JOIN users s ON s.id = ba.comped_by
        WHERE ba.user_id = $1`,
      [id],
    );
    const subscriptions = await manager.find(BillingSubscriptionEntity, {
      where: { userId: id },
      relations: { price: true, plan: true },
      order: { createdAt: 'DESC', id: 'ASC' },
    });
    const invoices = await manager.find(BillingInvoiceEntity, {
      where: { userId: id },
      order: { issuedAt: { direction: 'DESC', nulls: 'LAST' }, createdAt: 'DESC', id: 'ASC' },
      take: TENANT_HISTORY_ROWS,
    });
    const payments: PaymentRow[] = await manager.query(
      `${PAYMENT_SELECT} WHERE p.user_id = $1 ORDER BY p.paid_at DESC, p.id LIMIT ${TENANT_HISTORY_ROWS}`,
      [id],
    );

    return {
      overview,
      comp: account?.comp_plan_code
        ? {
            planCode: account.comp_plan_code,
            until: iso(account.comp_until),
            reason: account.comp_reason ?? '',
            byEmail: account.comped_by_email ?? null,
            at: iso(account.comped_at) ?? '',
          }
        : null,
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        planCode: s.planCode,
        planName: s.plan?.name ?? s.planCode,
        interval: s.interval,
        status: s.status,
        amountPaise: s.price.amountPaise,
        currentPeriodEnd: iso(s.currentEnd),
        startAt: iso(s.startAt),
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        graceUntil: iso(s.graceUntil),
        providerSubscriptionId: s.providerSubscriptionId,
        method: s.method,
        supersededBy: s.supersededBy,
        createdAt: s.createdAt.toISOString(),
      })),
      invoices: invoices.map(invoiceView),
      payments: payments.map(paymentView),
    };
  }

  /** Gives a plan without payment. Refused while the account has a subscription that gives or will give one. */
  async comp(id: string, dto: AdminCompDto, actor: AdminActor, now: Date = new Date()): Promise<AdminTenantBilling> {
    const until = dto.until ? new Date(dto.until) : null;
    if (until && (until.getTime() <= now.getTime() || until.getTime() > now.getTime() + COMP_MAX_MS)) {
      throw new BadRequestException(ADMIN_BILLING_MESSAGES.compUntil);
    }
    await this.dataSource.transaction(async (manager) => {
      const email = await this.lockUser(manager, id);
      const plan = await manager.findOne(PlanEntity, { where: { code: dto.planCode, isActive: true } });
      if (!plan || plan.code === FREE_PLAN) throw new BadRequestException(ADMIN_BILLING_MESSAGES.noSuchPlan);
      const { current, next } = await this.lockAccount(manager, id);
      const holds = (s: BillingSubscriptionEntity | null) =>
        !!s && (s.status === 'authenticated' || isLive(toSubscriptionState(s), now));
      if (holds(current) || holds(next)) throw new ConflictException(ADMIN_BILLING_MESSAGES.hasSubscription);
      await manager.update(
        BillingAccountEntity,
        { userId: id },
        { compPlanCode: plan.code, compUntil: until, compReason: dto.reason, compedBy: actor.userId, compedAt: now },
      );
      await this.audit.record(
        {
          ...this.auditBase(actor, id, email, dto.reason),
          action: 'billing.comp_granted',
          metadata: { planCode: plan.code, until: until ? until.toISOString() : null },
        },
        manager,
      );
    });
    return this.tenantBilling(id, now);
  }

  async endComp(id: string, reason: string, actor: AdminActor): Promise<AdminTenantBilling> {
    await this.dataSource.transaction(async (manager) => {
      const email = await this.lockUser(manager, id);
      const { account } = await this.lockAccount(manager, id);
      if (!account.compPlanCode) throw new ConflictException(ADMIN_BILLING_MESSAGES.noComp);
      await manager.update(
        BillingAccountEntity,
        { userId: id },
        { compPlanCode: null, compUntil: null, compReason: null, compedBy: null, compedAt: null },
      );
      await this.audit.record(
        {
          ...this.auditBase(actor, id, email, reason),
          action: 'billing.comp_ended',
          metadata: { planCode: account.compPlanCode, until: account.compUntil ? account.compUntil.toISOString() : null },
        },
        manager,
      );
    });
    return this.tenantBilling(id);
  }

  /**
   * Cancels the account's current subscription (at the cycle end, or now).
   *
   * The decision comes first: under the locks the subscription is checked, the
   * cancel is queued on it (the outbox columns) and the audit row written, in one
   * transaction. Only once that has committed is the provider called, from this
   * request (`BillingOutboxService.sendQueued`), with the worker held off for
   * `OUTBOX_REQUEST_HOLD_MS`. So the provider never cancels anything that has no
   * record and no audit row, whatever happens to the subscription or the database
   * meanwhile; a call that fails or never happens is sent by the worker, retried
   * like every other cancel, and staff are told so (502). Two staff cancelling at
   * once are serialised by the locks, and the second is refused before any call.
   * An immediate cancel changes the account's plan when the provider's webhook
   * arrives, as every subscription change does.
   */
  async cancel(id: string, dto: AdminCancelSubscriptionDto, actor: AdminActor, now: Date = new Date()): Promise<AdminTenantBilling> {
    const subscriptionId = await this.dataSource.transaction(async (manager) => {
      const email = await this.lockUser(manager, id);
      const { current, next } = await this.lockAccount(manager, id);
      if (!current || !CANCELLABLE.has(current.status)) {
        throw new ConflictException(ADMIN_BILLING_MESSAGES.nothingToCancel);
      }
      // An immediate cancel is queued or sent: nothing is left to decide.
      if (current.cancelRequestedAt && current.cancelAtCycleEnd === false) {
        throw new ConflictException(ADMIN_BILLING_MESSAGES.alreadyCancelling);
      }
      const queued = current.cancelRequestedAt !== null && current.cancelSentAt === null;
      if (dto.atCycleEnd && (current.cancelAtPeriodEnd || queued)) {
        throw new ConflictException(ADMIN_BILLING_MESSAGES.alreadyEnding);
      }
      await manager.update(
        BillingSubscriptionEntity,
        { id: current.id },
        {
          cancelRequestedAt: now,
          cancelAtCycleEnd: dto.atCycleEnd,
          cancelRequestedBy: actor.userId,
          cancelSentAt: null,
          cancelError: null,
          cancelRetryAt: new Date(now.getTime() + OUTBOX_REQUEST_HOLD_MS),
        },
      );
      // A change waiting to start goes with it: queued for the worker to cancel at once.
      if (next && (next.status === 'authenticated' || next.status === 'created')) {
        await manager.query(
          `UPDATE billing_subscriptions
              SET cancel_requested_at = $2, cancel_at_cycle_end = false, cancel_requested_by = $3, updated_at = now()
            WHERE id = $1 AND cancel_requested_at IS NULL`,
          [next.id, now, actor.userId],
        );
        await manager.update(BillingAccountEntity, { userId: id }, { nextSubscriptionId: null });
      }
      await this.audit.record(
        {
          ...this.auditBase(actor, id, email, dto.reason),
          action: 'billing.subscription_cancelled',
          metadata: { subscriptionId: current.id, atCycleEnd: dto.atCycleEnd },
        },
        manager,
      );
      return current.id;
    });

    const outcome = await this.outbox.sendQueued(subscriptionId, now);
    if (!outcome.sent) throw new HttpException(ADMIN_BILLING_MESSAGES.cancelQueued, HttpStatus.BAD_GATEWAY);
    return this.tenantBilling(id, now);
  }

  /** Has the provider email the invoice's link again. The invoice must be this tenant's. */
  async resendInvoice(id: string, invoiceId: string, reason: string, actor: AdminActor): Promise<{ resent: true }> {
    const invoice = await this.dataSource.manager.findOne(BillingInvoiceEntity, { where: { id: invoiceId, userId: id } });
    if (!invoice) throw new NotFoundException(ADMIN_BILLING_MESSAGES.invoiceNotFound);
    const [user] = await this.dataSource.query(`SELECT email FROM users WHERE id = $1`, [id]);
    await this.call(ADMIN_BILLING_MESSAGES.providerRefusedResend, () =>
      this.provider.notifyInvoiceByEmail(invoice.providerInvoiceId),
    );
    await this.audit.record({
      ...this.auditBase(actor, id, user.email, reason),
      action: 'billing.invoice_resent',
      metadata: { invoiceId: invoice.id },
    });
    return { resent: true };
  }

  // ------------------------------------------------------------------ helpers

  private async overMau(manager: EntityManager, now: Date): Promise<AdminBillingSummary['overMau']> {
    const coverage = await readUsageCoverage(manager);
    if (!coverage?.countedThrough || coverage.countedThrough < coverage.mauFrom) return [];
    const rows: Array<{ owner_id: string; email: string; plan_code: string; mau: string; mau_limit: number }> =
      await manager.query(
        `SELECT o.*, u.email FROM (${tenantMauOverLimitSql(100)}) o JOIN users u ON u.id = o.owner_id
          ORDER BY o.mau DESC, o.owner_id`,
        [coverage.countedThrough, now],
      );
    return rows.map((r) => ({
      tenantId: r.owner_id,
      email: r.email,
      planCode: r.plan_code,
      mau: Number(r.mau),
      limit: r.mau_limit,
    }));
  }

  /** The tenant's `users` row, FOR NO KEY UPDATE; first, as every billing transaction takes it. */
  private async lockUser(manager: EntityManager, id: string): Promise<string> {
    const [user] = await manager.query(`SELECT email FROM users WHERE id = $1 FOR NO KEY UPDATE`, [id]);
    if (!user) throw new NotFoundException(ADMIN_BILLING_MESSAGES.tenantNotFound);
    return user.email;
  }

  /** The account's billing row (made if missing) FOR UPDATE, and the subscriptions it points at. */
  private async lockAccount(
    manager: EntityManager,
    id: string,
  ): Promise<{
    account: BillingAccountEntity;
    current: BillingSubscriptionEntity | null;
    next: BillingSubscriptionEntity | null;
  }> {
    await manager.query(`INSERT INTO billing_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [id]);
    const account = await manager.findOneOrFail(BillingAccountEntity, {
      where: { userId: id },
      lock: { mode: 'pessimistic_write' },
    });
    const of = (sid: string | null) =>
      sid ? manager.findOne(BillingSubscriptionEntity, { where: { id: sid, userId: id } }) : Promise.resolve(null);
    const current = await of(account.currentSubscriptionId);
    const next = await of(account.nextSubscriptionId);
    return { account, current, next };
  }

  /** Unreachable is the usual 400; a refusal a 502 with `refused`, the provider's words in the log only. */
  private async call<T>(refused: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await reachProvider('Razorpay', fn);
    } catch (error) {
      if (error instanceof BillingProviderError) {
        this.logger.warn(
          `Razorpay refused a staff billing request: ${error.status} ${logValue(error.code)} ${logValue(error.description)}`,
        );
        throw new HttpException(refused, HttpStatus.BAD_GATEWAY);
      }
      throw error;
    }
  }

  private auditBase(actor: AdminActor, id: string, email: string, reason: string) {
    return {
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: 'tenant',
      targetId: id,
      targetLabel: email,
      reason,
      ipAddress: actor.ipAddress || null,
    };
  }
}

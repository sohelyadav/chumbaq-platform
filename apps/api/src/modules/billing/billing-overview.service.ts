import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type {
  BillingDetails,
  BillingInvoiceView,
  BillingOverview,
  BillingPlanOption,
  BillingPrice,
  BillingSubscriptionView,
  BillingUsage,
} from '@chumbaq/shared';
import { readUsageCoverage } from '../usage/usage-rollup.service';
import { SeatsService } from '../project-access/seats.service';
import { AccountLimitsService } from './account-limits.service';
import { accountState, effectivePlan, FREE_PLAN } from './effective-plan';
import { toBillingState } from './effective-plan-sql';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingInvoiceEntity } from './entities/billing-invoice.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import { PlanPriceEntity } from './entities/plan-price.entity';
import { PlanEntity } from './entities/plan.entity';
import { BILLING_PROVIDER, BillingProvider } from './providers/billing-provider';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * What an account's billing page shows: its state and effective plan, its current
 * and next subscriptions, its usage against its limits, the plans it can buy, and
 * its billing details. Reads only; takes no lock.
 *
 * MAU is the sum of the account's projects' month-to-date count on the last day the
 * roll-up closed, never a sum over days; unknown (null) before the roll-up has
 * counted active devices for that month.
 */
@Injectable()
export class BillingOverviewService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly limits: AccountLimitsService,
    private readonly seats: SeatsService,
  ) {}

  async overview(
    userId: string,
    now: Date = new Date(),
    manager: EntityManager = this.dataSource.manager,
  ): Promise<BillingOverview> {
    const account = await manager.findOne(BillingAccountEntity, { where: { userId } });
    const subscriptionOf = (id: string | null | undefined) =>
      id
        ? manager.findOne(BillingSubscriptionEntity, { where: { id, userId }, relations: { price: true } })
        : Promise.resolve(null);
    // One after another: the manager may be a transaction's single connection.
    const current = await subscriptionOf(account?.currentSubscriptionId);
    const next = await subscriptionOf(account?.nextSubscriptionId);
    const plans = await manager.find(PlanEntity, { order: { sortOrder: 'ASC', code: 'ASC' } });
    const prices = await manager.find(PlanPriceEntity, { where: { isCurrent: true } });
    const limits = await this.limits.limitsFor(manager, userId, now);
    const byCode = new Map(plans.map((plan) => [plan.code, plan]));
    const rank = (code: string) => byCode.get(code)?.sortOrder ?? 0;
    const state = toBillingState(account, current, next);
    const plan = effectivePlan(state, now, rank);

    return {
      state: accountState(state, now, rank),
      effectivePlan: {
        code: plan.planCode,
        name: byCode.get(plan.planCode)?.name ?? plan.planCode,
        source: plan.source,
        until: iso(plan.until),
      },
      current: current ? subscriptionView(current, byCode) : null,
      next: next ? subscriptionView(next, byCode) : null,
      comp: account?.compPlanCode ? { planCode: account.compPlanCode, until: iso(account.compUntil) } : null,
      usage: await this.usage(manager, userId, limits),
      plans: planOptions(plans, prices),
      details: detailsOf(account),
      keyId: this.provider.keyId ?? '',
    };
  }

  /** The account's own invoices, newest first (unissued ones last). */
  async invoices(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ data: BillingInvoiceView[]; meta: { total: number; page: number; limit: number } }> {
    const [rows, total] = await this.dataSource.manager.findAndCount(BillingInvoiceEntity, {
      where: { userId },
      order: { issuedAt: { direction: 'DESC', nulls: 'LAST' }, createdAt: 'DESC', id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data: rows.map(invoiceView), meta: { total, page, limit } };
  }

  private async usage(
    manager: EntityManager,
    userId: string,
    limits: { projectLimit: number; seatLimit: number | null; mauLimit: number | null },
  ): Promise<BillingUsage> {
    const coverage = await readUsageCoverage(manager);
    let mau: BillingUsage['mau'] = { used: null, limit: limits.mauLimit, month: null, countedThrough: null };
    if (coverage?.countedThrough && coverage.countedThrough >= coverage.mauFrom) {
      const [row] = await manager.query(
        `SELECT COALESCE(SUM(value), 0)::bigint AS used FROM usage_daily
          WHERE owner_id = $1 AND day = $2 AND metric = 'mau_month_to_date'`,
        [userId, coverage.countedThrough],
      );
      mau = {
        used: Number(row.used),
        limit: limits.mauLimit,
        month: `${coverage.countedThrough.slice(0, 7)}-01`,
        countedThrough: coverage.countedThrough,
      };
    }
    const [projects] = await manager.query(`SELECT count(*)::int AS n FROM projects WHERE owner_id = $1`, [userId]);
    return {
      mau,
      projects: { used: projects.n, limit: limits.projectLimit },
      seats: { used: await this.seats.count(userId, manager), limit: limits.seatLimit },
    };
  }
}

function priceView(price: PlanPriceEntity): BillingPrice {
  return {
    id: price.id,
    interval: price.interval,
    pricePaise: price.pricePaise,
    taxPaise: price.amountPaise - price.pricePaise,
    amountPaise: price.amountPaise,
    taxRateBps: price.taxRateBps,
  };
}

/** The free plan, then every active plan with a current price, in display order. */
function planOptions(plans: PlanEntity[], prices: PlanPriceEntity[]): BillingPlanOption[] {
  const options: BillingPlanOption[] = [];
  for (const plan of plans) {
    const monthly = prices.find((p) => p.planCode === plan.code && p.interval === 'monthly') ?? null;
    const yearly = prices.find((p) => p.planCode === plan.code && p.interval === 'yearly') ?? null;
    if (plan.code !== FREE_PLAN && (!plan.isActive || (!monthly && !yearly))) continue;
    options.push({
      code: plan.code,
      name: plan.name,
      sortOrder: plan.sortOrder,
      mauLimit: plan.mauLimit,
      projectLimit: plan.projectLimit,
      seatLimit: plan.seatLimit,
      monthly: monthly ? priceView(monthly) : null,
      yearly: yearly ? priceView(yearly) : null,
    });
  }
  return options.sort((a, b) => (a.code === FREE_PLAN ? -1 : b.code === FREE_PLAN ? 1 : a.sortOrder - b.sortOrder));
}

function subscriptionView(s: BillingSubscriptionEntity, plans: Map<string, PlanEntity>): BillingSubscriptionView {
  return {
    id: s.id,
    planCode: s.planCode,
    planName: plans.get(s.planCode)?.name ?? s.planCode,
    interval: s.interval,
    status: s.status,
    amountPaise: s.price.amountPaise,
    currentPeriodEnd: iso(s.currentEnd),
    startAt: iso(s.startAt),
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    graceUntil: iso(s.graceUntil),
  };
}

export function invoiceView(i: BillingInvoiceEntity): BillingInvoiceView {
  return {
    id: i.id,
    number: i.number,
    status: i.status,
    amountPaise: i.amountPaise,
    taxPaise: i.taxPaise,
    currency: i.currency,
    periodStart: iso(i.periodStart),
    periodEnd: iso(i.periodEnd),
    issuedAt: iso(i.issuedAt),
    paidAt: iso(i.paidAt),
    shortUrl: i.shortUrl,
  };
}

export function detailsOf(account: BillingAccountEntity | null): BillingDetails | null {
  if (!account?.legalName || !account.address || !account.stateCode) return null;
  return {
    legalName: account.legalName,
    gstin: account.gstin,
    address: account.address,
    stateCode: account.stateCode,
  };
}

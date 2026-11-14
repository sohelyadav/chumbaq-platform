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
import type { AdminPlan, AdminPlanPrice, BillingInterval } from '@chumbaq/shared';
import { logValue } from '../../common/log-value';
import { reachProvider } from '../push-notifications/services/per-recipient-provider';
import { AccountLimitsService } from '../billing/account-limits.service';
import { FREE_PLAN } from '../billing/effective-plan';
import { PlanPriceEntity } from '../billing/entities/plan-price.entity';
import { PlanEntity } from '../billing/entities/plan.entity';
import { formatRupees, taxInclusive } from '../billing/money';
import { BILLING_PROVIDER, BillingProvider, BillingProviderError, ProviderPlan } from '../billing/providers/billing-provider';
import { AdminAuditService } from './admin-audit.service';
import type { AdminActor } from './admin-tenants.service';
import type { AdminAddPriceDto, AdminCreatePlanDto, AdminUpdatePlanDto } from './dto/admin-plans.dto';

export const ADMIN_PLAN_MESSAGES = {
  notFound: 'Plan not found',
  priceNotFound: 'Price not found',
  exists: 'A plan with that code already exists.',
  freeAlwaysActive: 'The Free plan is always available.',
  freeHasNoPrice: 'The Free plan has no price.',
  noSuchProviderPlan: 'Razorpay has no plan with that id.',
  providerPlanUsed: 'That Razorpay plan already backs a price.',
  providerUnavailable: 'Razorpay could not be asked about that plan. Try again later.',
  notCurrent: 'That price is not current.',
} as const;

/** Statuses of a subscription someone is on, or has authorised. */
const SUBSCRIBED_STATUSES = ['authenticated', 'active', 'pending', 'halted'];

type EditableField = 'name' | 'mauLimit' | 'projectLimit' | 'seatLimit' | 'sortOrder' | 'isActive';
const EDITABLE: EditableField[] = ['name', 'mauLimit', 'projectLimit', 'seatLimit', 'sortOrder', 'isActive'];
const COLUMN: Record<EditableField, string> = {
  name: 'name',
  mauLimit: 'mau_limit',
  projectLimit: 'project_limit',
  seatLimit: 'seat_limit',
  sortOrder: 'sort_order',
  isActive: 'is_active',
};

const PERIOD_UNIT: Record<string, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  quarterly: ['quarter', 'quarters'],
  yearly: ['year', 'years'],
};

/** "₹1,178.81 every 1 month": what a provider's plan charges, in words. */
function describeProviderPlan(plan: ProviderPlan): string {
  const amount = plan.currency === 'INR' ? formatRupees(plan.amountPaise) : `${plan.currency} ${formatRupees(plan.amountPaise).slice(1)}`;
  const unit = PERIOD_UNIT[plan.period];
  const period = unit ? unit[plan.interval === 1 ? 0 : 1] : plan.period;
  return `${amount} every ${plan.interval} ${period}`;
}

/** Razorpay's period for each of our intervals. */
const PROVIDER_PERIOD: Record<BillingInterval, string> = { monthly: 'monthly', yearly: 'yearly' };

/**
 * Plans and their prices, for staff. Plans are data: the code knows only `free`, and
 * staff create every other plan with its limits. This works with billing off, so the
 * limits can be ready before billing is switched on.
 *
 * Prices need billing on, because each is checked against the provider's plan before
 * it is stored: its amount must be the price plus tax at the install's rate
 * (`BILLING_TAX_RATE_BPS`, so with no tax the price itself), in rupees, charged once
 * every month or year as the interval says. The price keeps that rate. A price is never edited; a new one replaces the
 * current one, and subscriptions on the old one keep it.
 *
 * Every change writes its audit row in its own transaction.
 */
@Injectable()
export class AdminPlansService {
  private readonly logger = new Logger(AdminPlansService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    private readonly limits: AccountLimitsService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  async list(manager: EntityManager = this.dataSource.manager): Promise<AdminPlan[]> {
    const plans = await manager.find(PlanEntity, { order: { sortOrder: 'ASC', code: 'ASC' } });
    const prices = await this.prices(manager, null);
    return plans.map((plan) => this.view(plan, prices.get(plan.code) ?? []));
  }

  async findOne(code: string, manager: EntityManager = this.dataSource.manager): Promise<AdminPlan> {
    const plan = await manager.findOne(PlanEntity, { where: { code } });
    if (!plan) throw new NotFoundException(ADMIN_PLAN_MESSAGES.notFound);
    const prices = await this.prices(manager, code);
    return this.view(plan, prices.get(code) ?? []);
  }

  async create(dto: AdminCreatePlanDto, actor: AdminActor): Promise<AdminPlan> {
    await this.dataSource.transaction(async (manager) => {
      const inserted: unknown[] = await manager.query(
        `INSERT INTO plans (code, name, mau_limit, project_limit, seat_limit, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [dto.code, dto.name, dto.mauLimit, dto.projectLimit, dto.seatLimit, dto.sortOrder],
      );
      if (inserted.length === 0) throw new ConflictException(ADMIN_PLAN_MESSAGES.exists);
      await this.audit.record(
        {
          ...this.auditBase(actor, dto.code, dto.reason),
          action: 'billing.plan_created',
          metadata: {
            code: dto.code,
            limits: { mauLimit: dto.mauLimit, projectLimit: dto.projectLimit, seatLimit: dto.seatLimit },
            sortOrder: dto.sortOrder,
          },
        },
        manager,
      );
    });
    return this.findOne(dto.code);
  }

  /** Writes only the fields sent that differ from the row, under its lock; no change records nothing. */
  async update(code: string, dto: AdminUpdatePlanDto, actor: AdminActor): Promise<AdminPlan> {
    if (code === FREE_PLAN && dto.isActive === false) {
      throw new BadRequestException(ADMIN_PLAN_MESSAGES.freeAlwaysActive);
    }
    await this.dataSource.transaction(async (manager) => {
      const plan = await manager.findOne(PlanEntity, { where: { code }, lock: { mode: 'pessimistic_write' } });
      if (!plan) throw new NotFoundException(ADMIN_PLAN_MESSAGES.notFound);
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const field of EDITABLE) {
        const value = dto[field];
        if (value === undefined || value === plan[field]) continue;
        before[field] = plan[field];
        after[field] = value;
      }
      const changed = Object.keys(after) as EditableField[];
      if (changed.length === 0) return;
      const sets = changed.map((field, i) => `${COLUMN[field]} = $${i + 2}`);
      await manager.query(`UPDATE plans SET ${sets.join(', ')}, updated_at = now() WHERE code = $1`, [
        code,
        ...changed.map((field) => after[field]),
      ]);
      await this.audit.record(
        { ...this.auditBase(actor, code, dto.reason), action: 'billing.plan_updated', metadata: { before, after } },
        manager,
      );
    });
    return this.findOne(code);
  }

  /**
   * Checks the provider's plan first, with no lock held, then in one transaction makes
   * the new price the current one for its interval and records it.
   */
  async addPrice(code: string, dto: AdminAddPriceDto, actor: AdminActor): Promise<AdminPlan> {
    if (code === FREE_PLAN) throw new BadRequestException(ADMIN_PLAN_MESSAGES.freeHasNoPrice);
    const plan = await this.dataSource.manager.findOne(PlanEntity, { where: { code } });
    if (!plan) throw new NotFoundException(ADMIN_PLAN_MESSAGES.notFound);
    await this.assertProviderPlanUnused(this.dataSource.manager, dto.razorpayPlanId);

    // The install's rate now, read once, so the check and the row cannot disagree.
    const taxRateBps = this.limits.taxRateBps;
    const amountPaise = taxInclusive(dto.pricePaise, taxRateBps);
    const providerPlan = await this.fetchProviderPlan(dto.razorpayPlanId);
    const expected = PROVIDER_PERIOD[dto.interval];
    if (
      providerPlan.amountPaise !== amountPaise ||
      providerPlan.currency !== 'INR' ||
      providerPlan.interval !== 1 ||
      providerPlan.period !== expected
    ) {
      const per = dto.interval === 'monthly' ? 'a month' : 'a year';
      throw new BadRequestException(
        `That Razorpay plan charges ${describeProviderPlan(providerPlan)}, not ${formatRupees(amountPaise)} ${per}.`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      // Serialises price changes of one plan, so two adds cannot both find no current price.
      const locked = await manager.findOne(PlanEntity, { where: { code }, lock: { mode: 'pessimistic_write' } });
      if (!locked) throw new NotFoundException(ADMIN_PLAN_MESSAGES.notFound);
      await this.assertProviderPlanUnused(manager, dto.razorpayPlanId);
      // An UPDATE answers [rows, affected].
      const [replaced]: [Array<{ id: string }>, number] = await manager.query(
        `UPDATE plan_prices SET is_current = false
          WHERE plan_code = $1 AND interval = $2 AND is_current
          RETURNING id`,
        [code, dto.interval],
      );
      await manager.query(
        `INSERT INTO plan_prices
           (plan_code, interval, price_paise, tax_rate_bps, amount_paise, currency, razorpay_plan_id, is_current, created_by)
         VALUES ($1, $2, $3, $4, $5, 'INR', $6, true, $7)`,
        [code, dto.interval, dto.pricePaise, taxRateBps, amountPaise, dto.razorpayPlanId, actor.userId],
      );
      await this.audit.record(
        {
          ...this.auditBase(actor, code, dto.reason),
          action: 'billing.price_added',
          metadata: {
            planCode: code,
            interval: dto.interval,
            pricePaise: dto.pricePaise,
            amountPaise,
            taxRateBps,
            razorpayPlanId: dto.razorpayPlanId,
            replacedPriceId: replaced[0]?.id ?? null,
          },
        },
        manager,
      );
    });
    return this.findOne(code);
  }

  /** Stops offering a price. Subscriptions on it keep it; a price already retired changes nothing. */
  async retirePrice(code: string, priceId: string, reason: string, actor: AdminActor): Promise<AdminPlan> {
    await this.dataSource.transaction(async (manager) => {
      const [, affected]: [unknown, number] = await manager.query(
        `UPDATE plan_prices SET is_current = false WHERE id = $1 AND plan_code = $2 AND is_current`,
        [priceId, code],
      );
      if (affected === 0) {
        const exists = await manager.findOne(PlanPriceEntity, { where: { id: priceId, planCode: code } });
        if (!exists) throw new NotFoundException(ADMIN_PLAN_MESSAGES.priceNotFound);
        throw new ConflictException(ADMIN_PLAN_MESSAGES.notCurrent);
      }
      await this.audit.record(
        {
          ...this.auditBase(actor, code, reason),
          action: 'billing.price_retired',
          metadata: { planCode: code, priceId },
        },
        manager,
      );
    });
    return this.findOne(code);
  }

  // ------------------------------------------------------------------ helpers

  private async assertProviderPlanUnused(manager: EntityManager, razorpayPlanId: string): Promise<void> {
    const used = await manager.findOne(PlanPriceEntity, { where: { razorpayPlanId } });
    if (used) throw new ConflictException(ADMIN_PLAN_MESSAGES.providerPlanUsed);
  }

  /**
   * Unreachable is the usual 400 "Could not reach Razorpay. Try again."; a 4xx means
   * the id names no plan of this account; anything else is a 502, with the provider's
   * own words in the log only.
   */
  private async fetchProviderPlan(id: string): Promise<ProviderPlan> {
    try {
      return await reachProvider('Razorpay', () => this.provider.fetchPlan(id));
    } catch (error) {
      if (error instanceof BillingProviderError) {
        if (error.status >= 400 && error.status < 500) {
          throw new BadRequestException(ADMIN_PLAN_MESSAGES.noSuchProviderPlan);
        }
        this.logger.warn(
          `Razorpay refused a plan lookup: ${error.status} ${logValue(error.code)} ${logValue(error.description)}`,
        );
        throw new HttpException(ADMIN_PLAN_MESSAGES.providerUnavailable, HttpStatus.BAD_GATEWAY);
      }
      throw error;
    }
  }

  /** Prices with their subscriber counts, by plan code; one plan's, or every plan's. */
  private async prices(manager: EntityManager, code: string | null): Promise<Map<string, AdminPlanPrice[]>> {
    const rows: Array<{
      id: string;
      plan_code: string;
      interval: BillingInterval;
      price_paise: number;
      amount_paise: number;
      tax_rate_bps: number;
      razorpay_plan_id: string;
      is_current: boolean;
      created_at: Date;
      subscribers: number;
    }> = await manager.query(
      `SELECT pp.id, pp.plan_code, pp.interval, pp.price_paise, pp.amount_paise, pp.tax_rate_bps,
              pp.razorpay_plan_id, pp.is_current, pp.created_at,
              (SELECT count(*)::int FROM billing_subscriptions s
                WHERE s.price_id = pp.id AND s.status = ANY($2)) AS subscribers
         FROM plan_prices pp
        WHERE $1::varchar IS NULL OR pp.plan_code = $1
        ORDER BY pp.is_current DESC, pp.created_at DESC, pp.id`,
      [code, SUBSCRIBED_STATUSES],
    );
    const byPlan = new Map<string, AdminPlanPrice[]>();
    for (const row of rows) {
      const list = byPlan.get(row.plan_code) ?? [];
      list.push({
        id: row.id,
        interval: row.interval,
        pricePaise: row.price_paise,
        taxPaise: row.amount_paise - row.price_paise,
        amountPaise: row.amount_paise,
        taxRateBps: row.tax_rate_bps,
        razorpayPlanId: row.razorpay_plan_id,
        isCurrent: row.is_current,
        createdAt: new Date(row.created_at).toISOString(),
        subscribers: row.subscribers,
      });
      byPlan.set(row.plan_code, list);
    }
    return byPlan;
  }

  private view(plan: PlanEntity, prices: AdminPlanPrice[]): AdminPlan {
    return {
      code: plan.code,
      name: plan.name,
      mauLimit: plan.mauLimit,
      projectLimit: plan.projectLimit,
      seatLimit: plan.seatLimit,
      sortOrder: plan.sortOrder,
      isActive: plan.isActive,
      prices,
      billingEnabled: this.limits.billingEnabled,
      newPriceTaxRateBps: this.limits.taxRateBps,
      defaults: this.limits.envLimits(),
    };
  }

  private auditBase(actor: AdminActor, code: string, reason: string) {
    return {
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: 'plan',
      targetId: null,
      targetLabel: code,
      reason,
      ipAddress: actor.ipAddress || null,
    };
  }
}

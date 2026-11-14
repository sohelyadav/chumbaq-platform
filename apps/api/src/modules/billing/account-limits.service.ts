import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import type { BillingConfig } from '../../config/billing.config';
import { DEFAULT_MAX_PROJECTS_PER_ACCOUNT } from '../../config/projects.config';
import { UserEntity } from '../users/entities/user.entity';
import { AccountBillingState, effectiveLimits, EffectivePlan, effectivePlan, FREE_PLAN } from './effective-plan';
import { toBillingState } from './effective-plan-sql';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import { PlanEntity } from './entities/plan.entity';

export interface AccountLimits {
  projectLimit: number;
  /** Null is no seat limit. */
  seatLimit: number | null;
  /** Null is no MAU limit; always null while billing is off. */
  mauLimit: number | null;
  plan: EffectivePlan;
  billingEnabled: boolean;
}

const FREE: EffectivePlan = { planCode: FREE_PLAN, source: 'free', until: null };

/** What the dashboard shows when an account is at its project limit. */
export function projectLimitMessage(limit: number, billingEnabled = false): string {
  return billingEnabled
    ? `You can have up to ${limit} projects on your plan. Upgrade your plan or delete one.`
    : `You can have up to ${limit} projects. Delete one or contact support to raise the limit.`;
}

/**
 * The one place an account's project, seat and MAU limits are decided
 * (`effectiveLimits`). With billing off they are exactly the staff override or the
 * install's default, and no billing table is read. With billing on they come from
 * the account's effective plan.
 *
 * Reads take no lock. Callers that check a limit before adding (project create,
 * invite, billing transfer) hold the account's `users` row; the billing webhook path
 * never takes that row, so a plan change landing meanwhile is simply seen or not.
 */
@Injectable()
export class AccountLimitsService {
  constructor(@Optional() private readonly config?: ConfigService) {}

  get billingEnabled(): boolean {
    return this.config?.get<BillingConfig>('billing')?.enabled === true;
  }

  /** The install's defaults: `MAX_PROJECTS_PER_ACCOUNT` and `MAX_SEATS_PER_ACCOUNT` (null, no limit). */
  envLimits(): { projectLimit: number; seatLimit: number | null } {
    return {
      projectLimit: this.config?.get<number>('projects.maxPerAccount') ?? DEFAULT_MAX_PROJECTS_PER_ACCOUNT,
      seatLimit: this.config?.get<number | null>('projects.maxSeatsPerAccount') ?? null,
    };
  }

  async limitsFor(manager: EntityManager, userId: string, now: Date = new Date()): Promise<AccountLimits> {
    const user = await manager.findOne(UserEntity, {
      where: { id: userId },
      select: { id: true, projectLimit: true, seatLimit: true },
    });
    const override = { projectLimit: user?.projectLimit ?? null, seatLimit: user?.seatLimit ?? null };
    const env = this.envLimits();

    if (!this.billingEnabled) {
      return {
        ...effectiveLimits({ billingEnabled: false, override, plan: null, source: 'free', env }),
        plan: FREE,
        billingEnabled: false,
      };
    }

    // One after another: callers pass a transaction's manager, a single connection.
    const state = await this.billingState(manager, userId);
    const plans = await this.plans(manager);
    const plan = effectivePlan(state, now);
    const row = plans.get(plan.planCode) ?? null;
    return {
      ...effectiveLimits({
        billingEnabled: true,
        override,
        plan: row ? { mauLimit: row.mauLimit, projectLimit: row.projectLimit, seatLimit: row.seatLimit } : null,
        source: plan.source,
        env,
      }),
      plan,
      billingEnabled: true,
    };
  }

  /** The account's comp and the subscriptions it points at; no row is the free plan. */
  async billingState(manager: EntityManager, userId: string): Promise<AccountBillingState> {
    const account = await manager.findOne(BillingAccountEntity, { where: { userId } });
    if (!account) return toBillingState(null, null, null);
    const subscriptionOf = (id: string | null) =>
      id ? manager.findOne(BillingSubscriptionEntity, { where: { id, userId } }) : Promise.resolve(null);
    const current = await subscriptionOf(account.currentSubscriptionId);
    const next = await subscriptionOf(account.nextSubscriptionId);
    return toBillingState(account, current, next);
  }

  /** Plan rank by sort order; a code with no plan ranks 0. */
  async planRanks(manager: EntityManager): Promise<(code: string) => number> {
    return rankOf(await this.plans(manager));
  }

  private async plans(manager: EntityManager): Promise<Map<string, PlanEntity>> {
    const rows = await manager.find(PlanEntity, {});
    return new Map(rows.map((row) => [row.code, row]));
  }
}

function rankOf(plans: Map<string, PlanEntity>): (code: string) => number {
  return (code) => plans.get(code)?.sortOrder ?? 0;
}

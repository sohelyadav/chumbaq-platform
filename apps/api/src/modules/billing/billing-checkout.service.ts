import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { BillingCheckout, BillingDetails, BillingInterval, BillingOverview } from '@chumbaq/shared';
import { logValue } from '../../common/log-value';
import { reachProvider } from '../push-notifications/services/per-recipient-provider';
import { BillingOverviewService, detailsOf } from './billing-overview.service';
import type { BillingDetailsDto, ChoosePlanDto } from './dto/billing.dto';
import { FREE_PLAN, isLive } from './effective-plan';
import { toSubscriptionState } from './effective-plan-sql';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import { PlanPriceEntity } from './entities/plan-price.entity';
import { PlanEntity } from './entities/plan.entity';
import { gstinMatchesState, isValidGstin } from './gstin';
import {
  BILLING_PROVIDER,
  BillingProvider,
  BillingProviderError,
  CHECKOUT_EXPIRY_MS,
  ProviderSubscription,
  SUBSCRIPTION_TOTAL_COUNT,
} from './providers/billing-provider';
import { InvalidCustomerInputError } from './providers/razorpay-customer';

export const BILLING_MESSAGES = {
  detailsFirst: 'Add your billing details first.',
  notBuyable: 'That plan cannot be bought.',
  alreadySubscribed: 'You already have a subscription. Change your plan instead.',
  paymentRetrying: "Your last payment is being retried. Update your payment method from Razorpay's email.",
  noActiveToChange: 'There is no active subscription to change.',
  noActiveToCancel: 'There is no active subscription to cancel.',
  changeScheduled: 'A plan change is already scheduled.',
  changedMeanwhile: 'Your subscription changed meanwhile. Try again.',
  samePlan: 'You are already on this plan.',
  renewalTooClose: 'Your renewal is too close to change plans. Try again after it.',
  providerRefused: 'Razorpay could not start the payment. Try again later.',
  providerRefusedCancel: 'Razorpay could not cancel the subscription. Try again later.',
  gstinState: 'The GSTIN is registered in another state. Check the state or the GSTIN.',
  gstinInvalid: 'Enter a valid GSTIN, or leave it empty.',
} as const;

const PROVIDER_LABEL = 'Razorpay';

/** No plan change this close to a renewal: the successor would start after a renewal it should replace. */
export const CHANGE_RENEWAL_MARGIN_MS = 10 * 60_000;
/**
 * A change's Checkout expires this long before the renewal, so it cannot be
 * authorised once the current subscription is about to renew (and charge for a
 * period the successor would charge for too), and the worker has time to send the
 * current one's cycle-end cancel. Less than `CHANGE_RENEWAL_MARGIN_MS`, so a change
 * that is allowed leaves at least the difference to pay.
 */
export const CHANGE_AUTHORISE_BY_MS = 5 * 60_000;

type Customer = { userId: string; email: string; name: string };

interface Purchase {
  plan: PlanEntity;
  price: PlanPriceEntity;
}

/**
 * The account owner's own billing actions: details, subscribe, change (and "keep my
 * plan"), and cancel.
 *
 * Every plan change is a new subscription (the provider cannot change the plan of
 * most subscriptions): a first subscription starts now; a change starts when the
 * current period ends, and the current one is cancelled at the end of its cycle once
 * the new one is authorised (`BillingStateService`).
 *
 * The provider is called with no lock held. What was checked before the call is
 * checked again afterwards under the `billing_accounts` lock; if it no longer holds,
 * the new subscription is recorded with an immediate cancel for the worker to send
 * (the outbox), and the request is refused. So an account never has two live
 * subscriptions, and an abandoned or losing Checkout is cancelled at the provider.
 *
 * Amounts come only from `plan_prices` rows on the server.
 */
@Injectable()
export class BillingCheckoutService {
  private readonly logger = new Logger(BillingCheckoutService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly overviews: BillingOverviewService,
  ) {}

  /** Writes only the detail columns, creating the account row if needed. */
  async saveDetails(userId: string, dto: BillingDetailsDto): Promise<BillingDetails> {
    const gstin = dto.gstin ?? null;
    if (gstin !== null && !isValidGstin(gstin)) throw new BadRequestException(BILLING_MESSAGES.gstinInvalid);
    if (gstin !== null && !gstinMatchesState(gstin, dto.stateCode)) {
      throw new BadRequestException(BILLING_MESSAGES.gstinState);
    }
    const address = {
      line1: dto.address.line1,
      line2: dto.address.line2 ?? null,
      city: dto.address.city,
      postalCode: dto.address.postalCode,
      country: 'IN' as const,
    };
    await this.dataSource.query(
      `INSERT INTO billing_accounts (user_id, legal_name, gstin, address, state_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         legal_name = EXCLUDED.legal_name, gstin = EXCLUDED.gstin, address = EXCLUDED.address,
         state_code = EXCLUDED.state_code, updated_at = now()`,
      [userId, dto.legalName, gstin, address, dto.stateCode],
    );
    return { legalName: dto.legalName, gstin, address, stateCode: dto.stateCode };
  }

  async subscribe(user: Customer, dto: ChoosePlanDto, now: Date = new Date()): Promise<BillingCheckout> {
    const before = await this.read(this.dataSource.manager, user.userId);
    if (!detailsOf(before.account)) throw new BadRequestException(BILLING_MESSAGES.detailsFirst);
    const purchase = await this.buyable(dto.plan, dto.interval);
    this.assertMaySubscribe(before.current, before.next, now);

    const customerId = await this.customerFor(user, before.account!);
    const created = await this.call(BILLING_MESSAGES.providerRefused, () =>
      this.provider.createSubscription({
        planId: purchase.price.razorpayPlanId,
        totalCount: SUBSCRIPTION_TOTAL_COUNT[dto.interval],
        startAt: null,
        expireBy: new Date(now.getTime() + CHECKOUT_EXPIRY_MS),
        accountRef: user.userId,
      }),
    );

    const refusal = await this.dataSource.transaction(async (manager) => {
      const locked = await this.read(manager, user.userId, true);
      const id = await this.insertSubscription(manager, user.userId, purchase, created, null);
      try {
        this.assertMaySubscribe(locked.current, locked.next, now);
      } catch (error) {
        await this.requestCancel(manager, id, false, user.userId, now);
        return error as HttpException;
      }
      // A halted current keeps its grace until the new one starts (`BillingStateService`).
      await this.pointNext(manager, user.userId, locked.next, id, customerId, now);
      return null;
    });
    if (refusal) throw refusal;
    return this.checkoutOf(created, customerId, user, null);
  }

  async change(user: Customer, dto: ChoosePlanDto, now: Date = new Date()): Promise<BillingCheckout> {
    const before = await this.read(this.dataSource.manager, user.userId);
    if (!detailsOf(before.account)) throw new BadRequestException(BILLING_MESSAGES.detailsFirst);
    const startAt = this.assertMayChange(before.current, before.next, dto, now);
    const purchase = await this.buyable(dto.plan, dto.interval);

    const customerId = await this.customerFor(user, before.account!);
    const created = await this.call(BILLING_MESSAGES.providerRefused, () =>
      this.provider.createSubscription({
        planId: purchase.price.razorpayPlanId,
        totalCount: SUBSCRIPTION_TOTAL_COUNT[dto.interval],
        startAt,
        expireBy: new Date(Math.min(now.getTime() + CHECKOUT_EXPIRY_MS, startAt.getTime() - CHANGE_AUTHORISE_BY_MS)),
        accountRef: user.userId,
      }),
    );

    const refusal = await this.dataSource.transaction(async (manager) => {
      const locked = await this.read(manager, user.userId, true);
      const id = await this.insertSubscription(manager, user.userId, purchase, created, startAt);
      try {
        const lockedStart = this.assertMayChange(locked.current, locked.next, dto, now);
        if (locked.current?.id !== before.current?.id || lockedStart.getTime() !== startAt.getTime()) {
          throw new ConflictException(BILLING_MESSAGES.renewalTooClose);
        }
      } catch (error) {
        await this.requestCancel(manager, id, false, user.userId, now);
        return error as HttpException;
      }
      await this.pointNext(manager, user.userId, locked.next, id, customerId, now);
      return null;
    });
    if (refusal) throw refusal;
    return this.checkoutOf(created, customerId, user, startAt);
  }

  /**
   * Cancels at the end of the period, and drops a change or "keep my plan" waiting to
   * start, whether or not the current one is already ending (once a change is
   * authorised the worker sets the current to end, and the successor is then the only
   * thing left that would charge).
   */
  async cancel(userId: string, now: Date = new Date()): Promise<BillingOverview> {
    const { current } = await this.read(this.dataSource.manager, userId);
    if (!current || (current.status !== 'active' && current.status !== 'pending')) {
      throw new ConflictException(BILLING_MESSAGES.noActiveToCancel);
    }
    if (!current.cancelAtPeriodEnd) {
      await this.call(BILLING_MESSAGES.providerRefusedCancel, () =>
        this.provider.cancelSubscription(current.providerSubscriptionId, true),
      );
    }
    const refusal = await this.dataSource.transaction(async (manager) => {
      const locked = await this.read(manager, userId, true);
      if (locked.current?.id !== current.id) return new ConflictException(BILLING_MESSAGES.changedMeanwhile);
      if (!current.cancelAtPeriodEnd) {
        await manager.update(
          BillingSubscriptionEntity,
          { id: current.id },
          {
            cancelAtPeriodEnd: true,
            cancelRequestedAt: now,
            cancelAtCycleEnd: true,
            cancelRequestedBy: userId,
            cancelSentAt: now,
          },
        );
      }
      // A change waiting to start goes with it, and stops counting at once.
      if (locked.next && (locked.next.status === 'authenticated' || locked.next.status === 'created')) {
        await this.requestCancel(manager, locked.next.id, false, userId, now);
        await manager.update(BillingAccountEntity, { userId }, { nextSubscriptionId: null });
      }
      return null;
    });
    if (refusal) throw refusal;
    return this.overviews.overview(userId, now);
  }

  // ------------------------------------------------------------------ the rules

  private assertMaySubscribe(
    current: BillingSubscriptionEntity | null,
    next: BillingSubscriptionEntity | null,
    now: Date,
  ): void {
    if (current?.status === 'pending') throw new ConflictException(BILLING_MESSAGES.paymentRetrying);
    if (current && current.status !== 'halted' && isLive(toSubscriptionState(current), now)) {
      throw new ConflictException(BILLING_MESSAGES.alreadySubscribed);
    }
    if (next?.status === 'authenticated') throw new ConflictException(BILLING_MESSAGES.changeScheduled);
  }

  /** The start of the successor: the current period's end. */
  private assertMayChange(
    current: BillingSubscriptionEntity | null,
    next: BillingSubscriptionEntity | null,
    dto: { plan: string; interval: BillingInterval },
    now: Date,
  ): Date {
    if (current?.status === 'pending') throw new ConflictException(BILLING_MESSAGES.paymentRetrying);
    if (!current || current.status !== 'active' || !current.currentEnd || !isLive(toSubscriptionState(current), now)) {
      throw new ConflictException(BILLING_MESSAGES.noActiveToChange);
    }
    if (next?.status === 'authenticated') throw new ConflictException(BILLING_MESSAGES.changeScheduled);
    if (!current.cancelAtPeriodEnd && current.planCode === dto.plan && current.interval === dto.interval) {
      throw new BadRequestException(BILLING_MESSAGES.samePlan);
    }
    if (current.currentEnd.getTime() - now.getTime() < CHANGE_RENEWAL_MARGIN_MS) {
      throw new ConflictException(BILLING_MESSAGES.renewalTooClose);
    }
    return current.currentEnd;
  }

  /** An active plan, not free, with a current price for the interval. */
  private async buyable(planCode: string, interval: BillingInterval): Promise<Purchase> {
    if (planCode === FREE_PLAN) throw new BadRequestException(BILLING_MESSAGES.notBuyable);
    const plan = await this.dataSource.manager.findOne(PlanEntity, { where: { code: planCode, isActive: true } });
    const price = plan
      ? await this.dataSource.manager.findOne(PlanPriceEntity, { where: { planCode, interval, isCurrent: true } })
      : null;
    if (!plan || !price) throw new BadRequestException(BILLING_MESSAGES.notBuyable);
    return { plan, price };
  }

  // ------------------------------------------------------------------ the rows

  private async read(
    manager: EntityManager,
    userId: string,
    lock = false,
  ): Promise<{
    account: BillingAccountEntity | null;
    current: BillingSubscriptionEntity | null;
    next: BillingSubscriptionEntity | null;
  }> {
    if (lock) {
      await manager.query(`INSERT INTO billing_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    }
    const account = await manager.findOne(BillingAccountEntity, {
      where: { userId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    const subscriptionOf = (id: string | null | undefined) =>
      id ? manager.findOne(BillingSubscriptionEntity, { where: { id, userId } }) : Promise.resolve(null);
    const current = await subscriptionOf(account?.currentSubscriptionId);
    const next = await subscriptionOf(account?.nextSubscriptionId);
    return { account, current, next };
  }

  private async insertSubscription(
    manager: EntityManager,
    userId: string,
    purchase: Purchase,
    created: ProviderSubscription,
    startAt: Date | null,
  ): Promise<string> {
    const [row] = await manager.query(
      `INSERT INTO billing_subscriptions
         (user_id, provider_subscription_id, price_id, plan_code, interval, status, start_at, charge_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'created', $6, $6, $1)
       RETURNING id`,
      [userId, created.id, purchase.price.id, purchase.plan.code, purchase.price.interval, startAt],
    );
    return row.id;
  }

  /** Makes `id` the account's next subscription; an earlier one is superseded and cancelled. */
  private async pointNext(
    manager: EntityManager,
    userId: string,
    previous: BillingSubscriptionEntity | null,
    id: string,
    customerId: string,
    now: Date,
  ): Promise<void> {
    if (previous) {
      await manager.update(BillingSubscriptionEntity, { id: previous.id }, { supersededBy: id });
      if (previous.status === 'created' || previous.status === 'authenticated') {
        await this.requestCancel(manager, previous.id, false, userId, now);
      }
    }
    await manager.query(
      `UPDATE billing_accounts
          SET next_subscription_id = $2,
              provider_customer_id = COALESCE(provider_customer_id, $3),
              updated_at = now()
        WHERE user_id = $1`,
      [userId, id, customerId],
    );
  }

  /** Queues a cancel for the worker's outbox, unless one is already queued. */
  private async requestCancel(
    manager: EntityManager,
    id: string,
    atCycleEnd: boolean,
    by: string,
    now: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE billing_subscriptions
          SET cancel_requested_at = $2, cancel_at_cycle_end = $3, cancel_requested_by = $4, updated_at = now()
        WHERE id = $1 AND cancel_requested_at IS NULL`,
      [id, now, atCycleEnd, by],
    );
  }

  // ------------------------------------------------------------ the provider

  /** The account's customer at the provider, created once (with no lock held). */
  private async customerFor(user: Customer, account: BillingAccountEntity): Promise<string> {
    if (account.providerCustomerId) return account.providerCustomerId;
    let customer: { id: string };
    try {
      customer = await this.call(BILLING_MESSAGES.providerRefused, () =>
        this.provider.createCustomer({
          name: account.legalName ?? user.name,
          email: user.email,
          gstin: account.gstin,
          accountRef: user.userId,
        }),
      );
    } catch (error) {
      if (error instanceof InvalidCustomerInputError) throw new BadRequestException(error.message);
      throw error;
    }
    // Kept at once, so a second request reuses it; another request's customer, if it won, stays.
    await this.dataSource.query(
      `UPDATE billing_accounts SET provider_customer_id = $2, updated_at = now()
        WHERE user_id = $1 AND provider_customer_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM billing_accounts other WHERE other.provider_customer_id = $2)`,
      [user.userId, customer.id],
    );
    const [row] = await this.dataSource.query(`SELECT provider_customer_id FROM billing_accounts WHERE user_id = $1`, [
      user.userId,
    ]);
    return row?.provider_customer_id ?? customer.id;
  }

  /**
   * A provider call from a customer request: unreachable is the usual 400 "Could not
   * reach Razorpay. Try again."; a refusal is a 502 with `refused`, and the provider's
   * own text goes to the log only.
   */
  private async call<T>(refused: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await reachProvider(PROVIDER_LABEL, fn);
    } catch (error) {
      if (error instanceof BillingProviderError) {
        this.logger.warn(
          `Razorpay refused a billing request: ${error.status} ${logValue(error.code)} ${logValue(error.description)}`,
        );
        throw new HttpException(refused, HttpStatus.BAD_GATEWAY);
      }
      throw error;
    }
  }

  private checkoutOf(
    created: ProviderSubscription,
    customerId: string,
    user: Customer,
    startAt: Date | null,
  ): BillingCheckout {
    return {
      subscriptionId: created.id,
      keyId: this.provider.keyId ?? '',
      customerId,
      prefill: { name: user.name, email: user.email },
      startsAt: startAt ? startAt.toISOString() : null,
    };
  }
}

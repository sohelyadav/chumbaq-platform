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
  gstinLocked: 'Your GSTIN cannot be changed once you have subscribed. Contact support to change it.',
  customerMismatch: 'Your billing account at Razorpay needs a look from support before you can subscribe. Contact support.',
  detailsChangedMeanwhile: 'Your billing details changed meanwhile. Try again.',
  providerRefusedDetails: 'Razorpay could not update your billing name. Try again later.',
} as const;

const PROVIDER_LABEL = 'Razorpay';

/** What the customer can cancel: a subscription that can still charge. */
const CUSTOMER_CANCELLABLE: ReadonlySet<string> = new Set(['active', 'pending', 'halted']);

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

  /**
   * Writes only the detail columns, creating the account row if needed.
   *
   * Once the account has a customer at the provider, the details are on it too: a new
   * legal name is sent there first (no lock held), so later invoices carry it. The
   * GSTIN cannot follow (Razorpay's edit-customer API takes no GSTIN; it is set when
   * the customer is made), so a GSTIN change is refused then, and support changes it.
   * Under the lock it is checked again: a customer made meanwhile by a subscribe in
   * another tab refuses a change it has not seen.
   */
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

    const before = await this.dataSource.manager.findOne(BillingAccountEntity, { where: { userId } });
    let renamed = false;
    if (before?.providerCustomerId) {
      if (gstin !== before.gstin) throw new ConflictException(BILLING_MESSAGES.gstinLocked);
      if (dto.legalName !== before.legalName) {
        await this.customerCall(BILLING_MESSAGES.providerRefusedDetails, () =>
          this.provider.updateCustomerName(before.providerCustomerId!, dto.legalName),
        );
        renamed = true;
      }
    }

    await this.dataSource.transaction(async (manager) => {
      const { account: locked } = await this.read(manager, userId, true);
      if (locked?.providerCustomerId) {
        if (gstin !== locked.gstin) throw new ConflictException(BILLING_MESSAGES.gstinLocked);
        const sentName = renamed && locked.providerCustomerId === before?.providerCustomerId;
        if (dto.legalName !== locked.legalName && !sentName) {
          throw new ConflictException(BILLING_MESSAGES.detailsChangedMeanwhile);
        }
      }
      await manager.query(
        `UPDATE billing_accounts
            SET legal_name = $2, gstin = $3, address = $4, state_code = $5, updated_at = now()
          WHERE user_id = $1`,
        [userId, dto.legalName, gstin, address, dto.stateCode],
      );
    });
    return { legalName: dto.legalName, gstin, address, stateCode: dto.stateCode, gstinLocked: !!before?.providerCustomerId };
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
   * thing left that would charge). A halted subscription has no paid period left to
   * finish, so it is cancelled at once, which also stops the provider retrying it.
   *
   * The provider is called first, with no lock held. What it cancelled is then
   * recorded on that subscription even if another became current meanwhile (the
   * request is then refused, 409), so the record never lags behind the provider.
   */
  async cancel(userId: string, now: Date = new Date()): Promise<BillingOverview> {
    const { current } = await this.read(this.dataSource.manager, userId);
    if (!current || !CUSTOMER_CANCELLABLE.has(current.status)) {
      throw new ConflictException(BILLING_MESSAGES.noActiveToCancel);
    }
    const atCycleEnd = current.status !== 'halted';
    const alreadySent = atCycleEnd
      ? current.cancelAtPeriodEnd
      : current.cancelSentAt !== null && current.cancelAtCycleEnd === false;
    if (!alreadySent) {
      await this.call(BILLING_MESSAGES.providerRefusedCancel, () =>
        this.provider.cancelSubscription(current.providerSubscriptionId, atCycleEnd),
      );
    }
    const refusal = await this.dataSource.transaction(async (manager) => {
      const locked = await this.read(manager, userId, true);
      if (!alreadySent) await this.recordSentCancel(manager, current.id, atCycleEnd, userId, now);
      if (locked.current?.id !== current.id) return new ConflictException(BILLING_MESSAGES.changedMeanwhile);
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

  /**
   * Records a cancel this request has just sent to the provider: as sent, so the
   * worker does not send it again. A cycle-end cancel never marks an immediate one
   * queued meanwhile as sent (a pending or halted subscription replaced by a
   * successor is queued to stop at once); that one stays for the worker.
   */
  private async recordSentCancel(
    manager: EntityManager,
    id: string,
    atCycleEnd: boolean,
    by: string,
    now: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE billing_subscriptions
          SET cancel_at_period_end = cancel_at_period_end OR $2,
              cancel_requested_at = $3, cancel_at_cycle_end = $2, cancel_requested_by = $4, cancel_sent_at = $3,
              cancel_error = NULL, cancel_retry_at = NULL, updated_at = now()
        WHERE id = $1
          AND NOT ($2 AND cancel_requested_at IS NOT NULL AND cancel_sent_at IS NULL AND cancel_at_cycle_end = false)`,
      [id, atCycleEnd, now, by],
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

  /**
   * The account's customer at the provider, created once (with no lock held).
   *
   * Razorpay answers a create for an email it already knows with that customer
   * (`fail_existing: "0"`), which may not be ours: the Razorpay account can serve
   * other products. Only a customer whose notes carry this account's reference is
   * adopted, and only with the GSTIN the account holds (Razorpay cannot change a
   * customer's GSTIN afterwards). Anything else is refused and logged for support,
   * never adopted: payments and invoices are matched to an account by customer.
   */
  private async customerFor(user: Customer, account: BillingAccountEntity): Promise<string> {
    if (account.providerCustomerId) return account.providerCustomerId;
    const customer = await this.customerCall(BILLING_MESSAGES.providerRefused, () =>
      this.provider.createCustomer({
        name: account.legalName ?? user.name,
        email: user.email,
        gstin: account.gstin,
        accountRef: user.userId,
      }),
    );
    if (customer.accountRef !== user.userId) {
      this.logger.warn(
        `Razorpay answered account ${user.userId} with customer ${logValue(customer.id)}, which another reference made`,
      );
      throw new ConflictException(BILLING_MESSAGES.customerMismatch);
    }
    if ((customer.gstin ?? '').toUpperCase() !== (account.gstin ?? '')) {
      this.logger.warn(`Razorpay customer ${logValue(customer.id)} of account ${user.userId} holds another GSTIN`);
      throw new ConflictException(BILLING_MESSAGES.customerMismatch);
    }
    // Kept at once, so a second request reuses it, and only over the details it was
    // made with. Another request's customer, if it won, stays.
    const [, adopted] = await this.dataSource.query(
      `UPDATE billing_accounts SET provider_customer_id = $2, updated_at = now()
        WHERE user_id = $1 AND provider_customer_id IS NULL AND gstin IS NOT DISTINCT FROM $3
          AND NOT EXISTS (SELECT 1 FROM billing_accounts other WHERE other.provider_customer_id = $2)`,
      [user.userId, customer.id, account.gstin],
    );
    if (adopted === 1) return customer.id;
    const [row] = await this.dataSource.query(
      `SELECT provider_customer_id, gstin FROM billing_accounts WHERE user_id = $1`,
      [user.userId],
    );
    if (row?.provider_customer_id) return row.provider_customer_id;
    if (row && row.gstin !== account.gstin) throw new ConflictException(BILLING_MESSAGES.detailsChangedMeanwhile);
    this.logger.warn(`Razorpay customer ${logValue(customer.id)} of account ${user.userId} is held by another account`);
    throw new ConflictException(BILLING_MESSAGES.customerMismatch);
  }

  /** `call`, with a customer detail Razorpay would refuse answered as a 400 naming the field. */
  private async customerCall<T>(refused: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.call(refused, fn);
    } catch (error) {
      if (error instanceof InvalidCustomerInputError) throw new BadRequestException(error.message);
      throw error;
    }
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

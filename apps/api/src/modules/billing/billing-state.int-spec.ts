import { randomBytes, randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { razorpayEvent, unix } from '../../test-support/razorpay-fixtures';
import { AccountLimitsService } from './account-limits.service';
import { BillingStateService } from './billing-state.service';
import { accountState, effectivePlan } from './effective-plan';
import type { BillingEvent } from './providers/billing-provider';

/**
 * Applying provider events to subscriptions and accounts, on real tables. Events
 * are Razorpay's documented payloads with only ids, times, statuses, plan ids and
 * amounts changed (`razorpayEvent`). The int database is shared and kept, so every
 * case builds its own users, plans and prices.
 */
describe('BillingStateService (integration)', () => {
  let ds: DataSource;
  let service: BillingStateService;
  let limits: AccountLimitsService;

  const NOW = new Date('2026-12-15T00:00:00Z');
  const DAY = 24 * 3600_000;
  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
  const hex = (bytes = 6) => randomBytes(bytes).toString('hex');

  beforeAll(async () => {
    ds = await openIntDb();
    const config = {
      get: (key: string) => (key === 'billing' ? { enabled: true, graceDays: 14 } : undefined),
    } as unknown as ConfigService;
    service = new BillingStateService(config);
    limits = new AccountLimitsService(config);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  interface World {
    userId: string;
    customerId: string;
    planA: string;
    planB: string;
    priceA: { id: string; rzp: string };
    priceB: { id: string; rzp: string };
  }

  async function world(): Promise<World> {
    const userId = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'billing')`, [
      userId,
      `state-${userId}@test.local`,
    ]);
    const planA = `plan_scratch_${hex()}`;
    const planB = `plan_scratch_${hex()}`;
    await ds.query(`INSERT INTO plans (code, name, sort_order) VALUES ($1, 'A', 10), ($2, 'B', 20)`, [planA, planB]);
    const price = async (plan: string) => {
      const rzp = `plan_${hex(7)}`;
      const [row] = await ds.query(
        `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
         VALUES ($1, 'monthly', 99900, 1800, 117882, $2, true) RETURNING id`,
        [plan, rzp],
      );
      return { id: row.id as string, rzp };
    };
    return { userId, customerId: `cust_${hex(7)}`, planA, planB, priceA: await price(planA), priceB: await price(planB) };
  }

  /** A subscription as checkout stores it, made the account's next. */
  async function checkout(
    w: World,
    plan: string,
    price: { id: string },
    startAt: Date | null = null,
  ): Promise<{ id: string; providerId: string }> {
    const providerId = `sub_${hex(7)}`;
    customerOf.set(providerId, w.customerId);
    const [row] = await ds.query(
      `INSERT INTO billing_subscriptions (user_id, provider_subscription_id, price_id, plan_code, interval, status, start_at, created_by)
       VALUES ($1, $2, $3, $4, 'monthly', 'created', $5, $1) RETURNING id`,
      [w.userId, providerId, price.id, plan, startAt],
    );
    await ds.query(
      `INSERT INTO billing_accounts (user_id, next_subscription_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET next_subscription_id = EXCLUDED.next_subscription_id`,
      [w.userId, row.id],
    );
    return { id: row.id, providerId };
  }

  /** Each account's provider customer, as the provider would put it on its subscriptions. */
  const customerOf = new Map<string, string>();
  const customer = (s: string) => customerOf.get(s) ?? `cust_${hex(7)}`;

  const apply = (event: BillingEvent, now = NOW) => ds.transaction((m) => service.apply(m, event, now));

  const subscription = async (id: string) => {
    const [row] = await ds.query(`SELECT * FROM billing_subscriptions WHERE id = $1`, [id]);
    return row;
  };
  const account = async (userId: string) => {
    const [row] = await ds.query(`SELECT * FROM billing_accounts WHERE user_id = $1`, [userId]);
    return row;
  };
  const planOf = async (userId: string, now = NOW) => {
    const state = await limits.billingState(ds.manager, userId);
    const rank = await limits.planRanks(ds.manager);
    return { plan: effectivePlan(state, now, rank).planCode, state: accountState(state, now, rank) };
  };

  // Events, from the documented payloads.
  /**
   * Razorpay always sends `start_at` and `charge_at` on an authorised subscription: the
   * start we asked for, or about the authorisation time when we asked for none.
   */
  const authenticated = (s: string, planId: string, eventAt: Date, startAt: Date) =>
    razorpayEvent('subscription.authenticated', {
      created_at: unix(eventAt),
      'payload.subscription.entity.id': s,
      'payload.subscription.entity.plan_id': planId,
      'payload.subscription.entity.customer_id': customer(s),
      'payload.subscription.entity.start_at': unix(startAt),
      'payload.subscription.entity.charge_at': unix(startAt),
    });

  const withPeriod = (
    name: string,
    s: string,
    planId: string,
    eventAt: Date,
    period: [Date, Date],
    extra: Record<string, unknown> = {},
  ) =>
    razorpayEvent(name, {
      created_at: unix(eventAt),
      'payload.subscription.entity.id': s,
      'payload.subscription.entity.plan_id': planId,
      'payload.subscription.entity.customer_id': customer(s),
      'payload.subscription.entity.current_start': unix(period[0]),
      'payload.subscription.entity.current_end': unix(period[1]),
      'payload.subscription.entity.charge_at': unix(period[1]),
      ...extra,
    });

  const charged = (
    s: string,
    planId: string,
    eventAt: Date,
    period: [Date, Date],
    payment: { id?: string; invoiceId?: string; amount?: number } = {},
  ) =>
    withPeriod('subscription.charged', s, planId, eventAt, period, {
      'payload.payment.entity.id': payment.id ?? `pay_${hex(7)}`,
      'payload.payment.entity.invoice_id': payment.invoiceId ?? `inv_${hex(7)}`,
      'payload.payment.entity.amount': payment.amount ?? 117882,
      'payload.payment.entity.created_at': unix(eventAt),
    });

  const activated = (s: string, planId: string, eventAt: Date, period: [Date, Date]) =>
    withPeriod('subscription.activated', s, planId, eventAt, period, {
      'payload.payment.entity.id': `pay_${hex(7)}`,
      'payload.payment.entity.invoice_id': `inv_${hex(7)}`,
      'payload.payment.entity.amount': 117882,
      'payload.payment.entity.created_at': unix(eventAt),
    });

  /** An account whose first subscription on plan A is active for [now-5d, now+25d]. */
  async function activeOnA(): Promise<{ w: World; sub: { id: string; providerId: string }; period: [Date, Date] }> {
    const w = await world();
    const sub = await checkout(w, w.planA, w.priceA);
    const period: [Date, Date] = [at(-5 * DAY), at(25 * DAY)];
    await apply(authenticated(sub.providerId, w.priceA.rzp, at(-5 * DAY - 60_000), at(-5 * DAY - 60_000)));
    await apply(activated(sub.providerId, w.priceA.rzp, at(-5 * DAY), period));
    return { w, sub, period };
  }

  it('first subscribe: authenticated changes nothing, activated and charged promote it with a payment and invoice', async () => {
    const w = await world();
    const sub = await checkout(w, w.planA, w.priceA);

    const auth = await apply(authenticated(sub.providerId, w.priceA.rzp, at(-60_000), at(-60_000)));
    expect(auth).toEqual({ outcome: 'applied', detail: null, notices: [] });
    // The provider's start is not ours: a first subscription has no scheduled start.
    expect(await subscription(sub.id)).toMatchObject({ status: 'authenticated', start_at: null });
    // Authorised is only a mandate: nothing is granted until it activates, even if the first charge then fails.
    expect((await planOf(w.userId)).plan).toBe('free');
    expect((await planOf(w.userId, at(12 * 3600_000))).plan).toBe('free');
    expect((await account(w.userId)).current_subscription_id).toBeNull();

    const period: [Date, Date] = [at(0), at(30 * DAY)];
    await apply(activated(sub.providerId, w.priceA.rzp, at(0), period));
    const promoted = await account(w.userId);
    expect(promoted.current_subscription_id).toBe(sub.id);
    expect(promoted.next_subscription_id).toBeNull();
    expect(promoted.provider_customer_id).toBe(w.customerId);
    const row = await subscription(sub.id);
    expect(row).toMatchObject({ status: 'active', was_current: true, paid_count: 1 });
    expect(row.current_end.getTime()).toBe(period[1].getTime());

    const paymentId = `pay_${hex(7)}`;
    const invoiceId = `inv_${hex(7)}`;
    await apply(charged(sub.providerId, w.priceA.rzp, at(1000), period, { id: paymentId, invoiceId }));
    expect(await planOf(w.userId)).toEqual({ plan: w.planA, state: 'active' });
    const [payment] = await ds.query(`SELECT * FROM billing_payments WHERE provider_payment_id = $1`, [paymentId]);
    expect(payment).toMatchObject({
      user_id: w.userId,
      subscription_id: sub.id,
      provider_invoice_id: invoiceId,
      amount_paise: 117882,
      tax_rate_bps: 1800,
      status: 'captured',
      method: 'card',
    });
    const [invoice] = await ds.query(`SELECT * FROM billing_invoices WHERE provider_invoice_id = $1`, [invoiceId]);
    expect(invoice).toMatchObject({ user_id: w.userId, subscription_id: sub.id, status: 'paid', amount_paise: 117882, tax_paise: 17982 });
    expect((await subscription(sub.id)).method).toBe('card');
  });

  it('never moves the period back: an older charge keeps the periods and still records its payment', async () => {
    const { w, sub, period } = await activeOnA();
    const later: [Date, Date] = [period[1], at(55 * DAY)];
    await apply(charged(sub.providerId, w.priceA.rzp, at(25 * DAY), later), at(25 * DAY));

    const older = await apply(
      charged(sub.providerId, w.priceA.rzp, at(-5 * DAY + 1000), period, { id: 'pay_Late' + hex(4) }),
      at(25 * DAY),
    );
    expect(older.outcome).toBe('applied');
    const row = await subscription(sub.id);
    expect(row.current_start.getTime()).toBe(later[0].getTime());
    expect(row.current_end.getTime()).toBe(later[1].getTime());
    const payments = await ds.query(`SELECT 1 FROM billing_payments WHERE subscription_id = $1`, [sub.id]);
    expect(payments).toHaveLength(3); // activated's, the renewal's and the late one
  });

  it('pending is past due; halted starts the grace with one notice, and a replay sends none', async () => {
    const { w, sub, period } = await activeOnA();
    await apply(withPeriod('subscription.pending', sub.providerId, w.priceA.rzp, at(-DAY), period));
    expect(await planOf(w.userId)).toEqual({ plan: w.planA, state: 'past_due' });

    const halted = withPeriod('subscription.halted', sub.providerId, w.priceA.rzp, at(-60_000), period);
    const first = await apply(halted);
    expect(first.notices).toEqual([{ kind: 'halted', userId: w.userId, graceUntil: at(14 * DAY) }]);
    expect((await subscription(sub.id)).grace_until.getTime()).toBe(at(14 * DAY).getTime());
    expect(await planOf(w.userId)).toEqual({ plan: w.planA, state: 'halted' });
    expect(await planOf(w.userId, at(15 * DAY))).toEqual({ plan: 'free', state: 'free' });

    const replay = await apply(halted, at(60_000));
    expect(replay.notices).toEqual([]);
    expect((await subscription(sub.id)).grace_until.getTime()).toBe(at(14 * DAY).getTime());

    // Recovering clears the grace.
    await apply(charged(sub.providerId, w.priceA.rzp, at(DAY), period), at(DAY));
    expect(await subscription(sub.id)).toMatchObject({ status: 'active', grace_until: null });
  });

  it('cancelled on the current subscription gives free, and nothing revives it', async () => {
    const { w, sub, period } = await activeOnA();
    await apply(withPeriod('subscription.cancelled', sub.providerId, w.priceA.rzp, at(-60_000), period));
    expect(await planOf(w.userId)).toEqual({ plan: 'free', state: 'free' });
    await apply(charged(sub.providerId, w.priceA.rzp, at(60_000), period));
    expect((await subscription(sub.id)).status).toBe('cancelled');
    expect(await planOf(w.userId)).toEqual({ plan: 'free', state: 'free' });
  });

  it('an upgrade successor counts from a day before its start, queues the old cancel, and replaces it on activation', async () => {
    const { w, sub: old, period } = await activeOnA();
    const next = await checkout(w, w.planB, w.priceB, period[1]);

    await apply(authenticated(next.providerId, w.priceB.rzp, at(-60_000), period[1]));
    // A mandate only, nothing charged yet: the current plan until a day before the start.
    expect(await planOf(w.userId)).toEqual({ plan: w.planA, state: 'change_scheduled' });
    expect(await planOf(w.userId, new Date(period[1].getTime() - DAY - 60_000))).toEqual({
      plan: w.planA,
      state: 'change_scheduled',
    });
    expect(await planOf(w.userId, new Date(period[1].getTime() - DAY + 60_000))).toEqual({
      plan: w.planB,
      state: 'upgrade_pending',
    });
    const queued = await subscription(old.id);
    expect(queued.cancel_requested_at.getTime()).toBe(NOW.getTime());
    expect(queued).toMatchObject({ cancel_at_cycle_end: true, cancel_requested_by: null, cancel_sent_at: null });

    const renewal: [Date, Date] = [period[1], at(55 * DAY)];
    await apply(activated(next.providerId, w.priceB.rzp, period[1], renewal), at(25 * DAY));
    const acct = await account(w.userId);
    expect(acct.current_subscription_id).toBe(next.id);
    expect(acct.next_subscription_id).toBeNull();
    expect(await subscription(old.id)).toMatchObject({ superseded_by: next.id });
    expect(await subscription(next.id)).toMatchObject({ status: 'active', was_current: true });
    expect(await planOf(w.userId, at(26 * DAY))).toEqual({ plan: w.planB, state: 'active' });
  });

  it('a successor authorised after the current renewed past its start is cancelled, not scheduled', async () => {
    const { w, sub: old, period } = await activeOnA();
    const next = await checkout(w, w.planB, w.priceB, period[1]);
    // The current renews at its period end before the successor's authorisation lands.
    const renewal: [Date, Date] = [period[1], at(55 * DAY)];
    await apply(charged(old.providerId, w.priceA.rzp, at(25 * DAY), renewal), at(25 * DAY));

    const result = await apply(authenticated(next.providerId, w.priceB.rzp, at(25 * DAY + 60_000), period[1]), at(25 * DAY + 60_000));
    expect(result).toMatchObject({ outcome: 'applied', detail: 'successor after renewal' });
    const cancelled = await subscription(next.id);
    expect(cancelled).toMatchObject({ cancel_at_cycle_end: false, cancel_sent_at: null });
    expect(cancelled.cancel_requested_at).not.toBeNull();
    // The renewed current keeps going: no cancel for it, and it alone counts.
    expect((await subscription(old.id)).cancel_requested_at).toBeNull();
    expect((await account(w.userId)).next_subscription_id).toBeNull();
    expect(await planOf(w.userId, at(26 * DAY))).toEqual({ plan: w.planA, state: 'active' });
  });

  it('a downgrade successor is scheduled, not granted, until it activates', async () => {
    const w = await world();
    const sub = await checkout(w, w.planB, w.priceB);
    const period: [Date, Date] = [at(-5 * DAY), at(25 * DAY)];
    await apply(activated(sub.providerId, w.priceB.rzp, at(-5 * DAY), period));
    const next = await checkout(w, w.planA, w.priceA, period[1]);
    await apply(authenticated(next.providerId, w.priceA.rzp, at(-60_000), period[1]));
    expect(await planOf(w.userId)).toEqual({ plan: w.planB, state: 'change_scheduled' });
  });

  it('events of a superseded or unpointed subscription change that row only, never the account', async () => {
    const w = await world();
    const first = await checkout(w, w.planA, w.priceA);
    const second = await checkout(w, w.planB, w.priceB);
    await ds.query(`UPDATE billing_subscriptions SET superseded_by = $2 WHERE id = $1`, [first.id, second.id]);

    // The first tab's Checkout is paid after all: its subscription activates.
    const period: [Date, Date] = [at(0), at(30 * DAY)];
    const result = await apply(activated(first.providerId, w.priceA.rzp, at(0), period));
    expect(result).toMatchObject({ outcome: 'applied', detail: 'superseded', notices: [] });
    expect(await subscription(first.id)).toMatchObject({ status: 'active', was_current: false });
    const acct = await account(w.userId);
    expect(acct.current_subscription_id).toBeNull();
    expect(acct.next_subscription_id).toBe(second.id);
    expect(await planOf(w.userId)).toEqual({ plan: 'free', state: 'checkout' });

    // Halting it starts no grace notice for the account either.
    const halted = await apply(withPeriod('subscription.halted', first.providerId, w.priceA.rzp, at(DAY), period));
    expect(halted.notices).toEqual([]);
  });

  it('ignores what is not ours: an unknown subscription, an unknown plan, an unmatched failed payment', async () => {
    expect(await apply(authenticated(`sub_${hex(7)}`, `plan_${hex(7)}`, NOW, NOW))).toEqual({
      outcome: 'ignored',
      detail: 'unknown subscription',
      notices: [],
    });

    const w = await world();
    const sub = await checkout(w, w.planA, w.priceA);
    expect(await apply(authenticated(sub.providerId, `plan_${hex(7)}`, NOW, NOW))).toEqual({
      outcome: 'ignored',
      detail: 'unknown plan',
      notices: [],
    });
    expect((await subscription(sub.id)).status).toBe('created');

    const paymentId = `pay_${hex(7)}`;
    const failed = razorpayEvent('payment.failed', { 'payload.payment.entity.id': paymentId });
    expect(await apply(failed)).toEqual({ outcome: 'ignored', detail: 'not ours', notices: [] });
    expect(await ds.query(`SELECT 1 FROM billing_payments WHERE provider_payment_id = $1`, [paymentId])).toHaveLength(0);

    expect(await apply(razorpayEvent('payment.downtime.started'))).toEqual({
      outcome: 'ignored',
      detail: 'unhandled type',
      notices: [],
    });
  });

  it('records a failed payment matched by its invoice, and never turns a captured one into failed', async () => {
    const { w, sub, period } = await activeOnA();
    const invoiceId = `inv_${hex(7)}`;
    const paymentId = `pay_${hex(7)}`;
    await apply(charged(sub.providerId, w.priceA.rzp, at(1000), period, { invoiceId, id: `pay_${hex(7)}` }));

    const failed = razorpayEvent('payment.failed', {
      'payload.payment.entity.id': paymentId,
      'payload.payment.entity.invoice_id': invoiceId,
    });
    expect((await apply(failed)).outcome).toBe('applied');
    const [row] = await ds.query(`SELECT * FROM billing_payments WHERE provider_payment_id = $1`, [paymentId]);
    expect(row).toMatchObject({ user_id: w.userId, subscription_id: sub.id, status: 'failed', failure_reason: 'payment_failed', method: 'netbanking' });

    const capturedId = `pay_${hex(7)}`;
    await apply(charged(sub.providerId, w.priceA.rzp, at(2000), period, { id: capturedId }));
    await apply(
      razorpayEvent('payment.failed', {
        'payload.payment.entity.id': capturedId,
        'payload.payment.entity.invoice_id': invoiceId,
      }),
    );
    const [kept] = await ds.query(`SELECT status FROM billing_payments WHERE provider_payment_id = $1`, [capturedId]);
    expect(kept.status).toBe('captured');
  });

  it('matches invoices by subscription, else by customer, and keeps refunds cumulative', async () => {
    const { w, sub } = await activeOnA();
    const invoiceId = `inv_${hex(7)}`;
    const paid = razorpayEvent('invoice.paid', {
      'payload.invoice.entity.id': invoiceId,
      'payload.invoice.entity.subscription_id': sub.providerId,
      'payload.invoice.entity.amount': 117882,
      'payload.payment.entity.id': `pay_${hex(7)}`,
      'payload.payment.entity.invoice_id': invoiceId,
      'payload.payment.entity.amount': 117882,
    });
    expect((await apply(paid)).outcome).toBe('applied');
    const [invoice] = await ds.query(`SELECT * FROM billing_invoices WHERE provider_invoice_id = $1`, [invoiceId]);
    expect(invoice).toMatchObject({ user_id: w.userId, subscription_id: sub.id, status: 'paid', amount_paise: 117882, tax_paise: 17982, provider_tax_paise: 54030 });

    const byCustomer = `inv_${hex(7)}`;
    const viaCustomer = razorpayEvent('invoice.expired', {
      'payload.invoice.entity.id': byCustomer,
      'payload.invoice.entity.customer_id': w.customerId,
    });
    // The customer id is this account's (set by the activation).
    expect((await apply(viaCustomer)).outcome).toBe('applied');
    const [expired] = await ds.query(`SELECT user_id, status FROM billing_invoices WHERE provider_invoice_id = $1`, [byCustomer]);
    expect(expired).toEqual({ user_id: w.userId, status: 'expired' });

    const stranger = razorpayEvent('invoice.paid', {
      'payload.invoice.entity.id': `inv_${hex(7)}`,
      'payload.invoice.entity.customer_id': `cust_${hex(7)}`,
    });
    expect(await apply(stranger)).toEqual({ outcome: 'ignored', detail: 'not ours', notices: [] });

    // Refunds: a payment of 500000 refunded 190000 (twice reported), then in full.
    const paymentId = `pay_${hex(7)}`;
    await apply(charged(sub.providerId, w.priceA.rzp, at(3000), [at(-5 * DAY), at(25 * DAY)], { id: paymentId, amount: 500000 }));
    const refund = (cumulative: number) =>
      razorpayEvent('refund.processed', {
        'payload.refund.entity.id': `rfnd_${hex(7)}`,
        'payload.refund.entity.payment_id': paymentId,
        'payload.payment.entity.id': paymentId,
        'payload.payment.entity.amount_refunded': cumulative,
      });
    const refunded = async () =>
      (await ds.query(`SELECT amount_refunded_paise, status FROM billing_payments WHERE provider_payment_id = $1`, [paymentId]))[0];
    await apply(refund(190000));
    await apply(refund(190000));
    expect(await refunded()).toEqual({ amount_refunded_paise: 190000, status: 'captured' });
    await apply(refund(100000)); // an older report never lowers it
    expect(await refunded()).toEqual({ amount_refunded_paise: 190000, status: 'captured' });
    await apply(refund(500000));
    expect(await refunded()).toEqual({ amount_refunded_paise: 500000, status: 'refunded' });

    const unknownRefund = razorpayEvent('refund.processed', {
      'payload.refund.entity.payment_id': `pay_${hex(7)}`,
      'payload.payment.entity.id': `pay_${hex(7)}`,
    });
    expect(await apply(unknownRefund)).toEqual({ outcome: 'ignored', detail: 'not ours', notices: [] });
  });
});

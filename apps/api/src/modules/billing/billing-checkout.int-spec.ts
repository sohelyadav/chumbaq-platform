import { randomBytes, randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { parkOtherOutboxRows } from '../../test-support/billing-outbox';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { FakeBillingProvider } from '../../test-support/fake-billing-provider';
import { razorpayEvent, unix } from '../../test-support/razorpay-fixtures';
import { SeatsService } from '../project-access/seats.service';
import { AccountLimitsService } from './account-limits.service';
import { BillingCheckoutService, CHANGE_AUTHORISE_BY_MS } from './billing-checkout.service';
import { BillingOutboxService } from './billing-outbox.service';
import { BillingOverviewService } from './billing-overview.service';
import { BillingStateService } from './billing-state.service';
import type { BillingDetailsDto } from './dto/billing.dto';
import { CHECKOUT_EXPIRY_MS } from './providers/billing-provider';

const KEY_ID = 'rzp_test_AbC123xyz';

/**
 * Subscribe, change, keep and cancel, on real tables with the in-memory provider.
 * The int database is shared and kept, so every case makes its own account and
 * plans.
 */
describe('BillingCheckoutService (integration)', () => {
  let ds: DataSource;
  let fake: FakeBillingProvider;
  let state: BillingStateService;
  let overview: BillingOverviewService;
  let checkout: BillingCheckoutService;
  let outbox: BillingOutboxService;
  const hex = (bytes = 6) => randomBytes(bytes).toString('hex');
  const DAY = 24 * 3600_000;

  beforeAll(async () => {
    ds = await openIntDb();
    fake = new FakeBillingProvider({ keyId: KEY_ID });
    const config = {
      get: (key: string) =>
        key === 'billing'
          ? { enabled: true, graceDays: 14, keyId: KEY_ID }
          : key === 'projects.maxPerAccount'
            ? 10
            : undefined,
    } as unknown as ConfigService;
    const limits = new AccountLimitsService(config);
    state = new BillingStateService(config);
    overview = new BillingOverviewService(ds, fake, limits, new SeatsService(ds, limits));
    checkout = new BillingCheckoutService(ds, fake, overview);
    outbox = new BillingOutboxService(ds, fake);
  });

  /** The worker's outbox run, on this account's rows only. */
  async function runOutbox(userId: string): Promise<void> {
    await parkOtherOutboxRows(ds, [userId]);
    await outbox.runOnce();
  }

  afterAll(async () => {
    await closeIntDb(ds);
  });

  const DETAILS: BillingDetailsDto = {
    legalName: 'Acme Software Private Limited',
    gstin: '27AAPFU0939F1ZV',
    address: { line1: '1 Main Road', city: 'Pune', postalCode: '411001', country: 'IN' },
    stateCode: '27',
  };

  interface World {
    user: { userId: string; email: string; name: string };
    planA: string;
    planB: string;
    rzp: Record<string, string>;
  }

  async function world({ details = true }: { details?: boolean } = {}): Promise<World> {
    const userId = randomUUID();
    const email = `checkout-${userId.slice(0, 8)}@test.local`;
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'Asha Rao')`, [userId, email]);
    const planA = `plan_scratch_${hex()}`;
    const planB = `plan_scratch_${hex()}`;
    await ds.query(`INSERT INTO plans (code, name, sort_order, mau_limit) VALUES ($1, 'A', 10, 1000), ($2, 'B', 20, 5000)`, [
      planA,
      planB,
    ]);
    const rzp: Record<string, string> = {};
    for (const plan of [planA, planB]) {
      for (const interval of ['monthly', 'yearly'] as const) {
        const id = `plan_${hex(7)}`;
        await ds.query(
          `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
           VALUES ($1, $2, 99900, 1800, 117882, $3, true)`,
          [plan, interval, id],
        );
        fake.seedPlan({ id, period: interval, interval: 1, amountPaise: 117882, currency: 'INR' });
        rzp[`${plan}:${interval}`] = id;
      }
    }
    const w = { user: { userId, email, name: 'Asha Rao' }, planA, planB, rzp };
    if (details) await checkout.saveDetails(userId, DETAILS);
    return w;
  }

  const account = async (userId: string) =>
    (await ds.query(`SELECT * FROM billing_accounts WHERE user_id = $1`, [userId]))[0];
  const sub = async (id: string) => (await ds.query(`SELECT * FROM billing_subscriptions WHERE id = $1`, [id]))[0];
  const subByProvider = async (providerId: string) =>
    (await ds.query(`SELECT * FROM billing_subscriptions WHERE provider_subscription_id = $1`, [providerId]))[0];

  /** The provider says the subscription was paid: activated for [now-1d, now+29d]. */
  async function activate(providerId: string, planId: string, now = new Date()) {
    const event = razorpayEvent('subscription.activated', {
      created_at: unix(now),
      'payload.subscription.entity.id': providerId,
      'payload.subscription.entity.plan_id': planId,
      'payload.subscription.entity.customer_id': `cust_${hex(7)}`,
      'payload.subscription.entity.current_start': unix(new Date(now.getTime() - DAY)),
      'payload.subscription.entity.current_end': unix(new Date(now.getTime() + 29 * DAY)),
      'payload.payment.entity.id': `pay_${hex(7)}`,
      'payload.payment.entity.invoice_id': `inv_${hex(7)}`,
    });
    await ds.transaction((m) => state.apply(m, event, now));
  }

  async function authenticate(providerId: string, planId: string, startAt: Date) {
    const event = razorpayEvent('subscription.authenticated', {
      created_at: unix(new Date()),
      'payload.subscription.entity.id': providerId,
      'payload.subscription.entity.plan_id': planId,
      'payload.subscription.entity.start_at': unix(startAt),
    });
    await ds.transaction((m) => state.apply(m, event, new Date()));
  }

  /** An account whose subscription to plan A monthly is active. */
  async function subscribed(): Promise<World & { currentId: string }> {
    const w = await world();
    const started = await checkout.subscribe(w.user, { plan: w.planA, interval: 'monthly' });
    await activate(started.subscriptionId, w.rzp[`${w.planA}:monthly`]);
    return { ...w, currentId: (await account(w.user.userId)).current_subscription_id };
  }

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a refusal');
      },
      (error: { getStatus?: () => number; message: string }) => ({ status: error.getStatus?.(), message: error.message }),
    );

  describe('details', () => {
    it('stores the details and refuses a GSTIN from another state', async () => {
      const w = await world({ details: false });
      expect(await refusal(checkout.saveDetails(w.user.userId, { ...DETAILS, stateCode: '29' }))).toEqual({
        status: 400,
        message: 'The GSTIN is registered in another state. Check the state or the GSTIN.',
      });
      expect(await account(w.user.userId)).toBeUndefined();

      const saved = await checkout.saveDetails(w.user.userId, DETAILS);
      expect(saved).toEqual({ ...DETAILS, address: { ...DETAILS.address, line2: null } });
      const again = await checkout.saveDetails(w.user.userId, { ...DETAILS, gstin: undefined, legalName: 'Acme' });
      expect(again.gstin).toBeNull();
      expect(await account(w.user.userId)).toMatchObject({ legal_name: 'Acme', gstin: null, state_code: '27' });
    });
  });

  describe('subscribe', () => {
    it('needs billing details first', async () => {
      const w = await world({ details: false });
      expect(await refusal(checkout.subscribe(w.user, { plan: w.planA, interval: 'monthly' }))).toEqual({
        status: 400,
        message: 'Add your billing details first.',
      });
      expect(fake.callsOf('createSubscription')).toHaveLength(0);
    });

    it('stores a created subscription as next, makes the customer once, and supersedes an earlier checkout', async () => {
      const w = await world();
      const customersBefore = fake.callsOf('createCustomer').length;
      const first = await checkout.subscribe(w.user, { plan: w.planA, interval: 'monthly' });
      expect(first).toMatchObject({ keyId: KEY_ID, startsAt: null, prefill: { name: 'Asha Rao', email: w.user.email } });
      expect(first.customerId).toMatch(/^cust_/);
      const firstRow = await subByProvider(first.subscriptionId);
      expect(firstRow).toMatchObject({ status: 'created', plan_code: w.planA, interval: 'monthly', created_by: w.user.userId });
      expect(await account(w.user.userId)).toMatchObject({ next_subscription_id: firstRow.id, provider_customer_id: first.customerId });
      const [created] = fake.callsOf('createSubscription').slice(-1) as [[{ planId: string; totalCount: number; startAt: Date | null }]];
      expect(created[0]).toMatchObject({ planId: w.rzp[`${w.planA}:monthly`], totalCount: 120, startAt: null });

      const second = await checkout.subscribe(w.user, { plan: w.planB, interval: 'yearly' });
      const secondRow = await subByProvider(second.subscriptionId);
      expect(await account(w.user.userId)).toMatchObject({ next_subscription_id: secondRow.id });
      const superseded = await sub(firstRow.id);
      expect(superseded).toMatchObject({ superseded_by: secondRow.id, cancel_at_cycle_end: false, cancel_requested_by: w.user.userId });
      expect(superseded.cancel_requested_at).not.toBeNull();
      expect(fake.callsOf('createCustomer').length - customersBefore).toBe(1);
      expect(second.customerId).toBe(first.customerId);
    });

    it('double subscribe: two at once leave one next, the other cancelled; once active, a third is refused', async () => {
      const w = await world();
      const both = await Promise.all([
        checkout.subscribe(w.user, { plan: w.planA, interval: 'monthly' }),
        checkout.subscribe(w.user, { plan: w.planA, interval: 'monthly' }),
      ]);
      const rows = await ds.query(`SELECT * FROM billing_subscriptions WHERE user_id = $1`, [w.user.userId]);
      expect(rows).toHaveLength(2);
      const live = rows.filter((r: { superseded_by: string | null }) => r.superseded_by === null);
      expect(live).toHaveLength(1);
      expect((await account(w.user.userId)).next_subscription_id).toBe(live[0].id);
      const other = rows.find((r: { id: string }) => r.id !== live[0].id);
      expect(other.cancel_requested_at).not.toBeNull();
      expect(both.map((b) => b.subscriptionId)).toContain(live[0].provider_subscription_id);

      await activate(live[0].provider_subscription_id, w.rzp[`${w.planA}:monthly`]);
      expect(await refusal(checkout.subscribe(w.user, { plan: w.planB, interval: 'monthly' }))).toEqual({
        status: 409,
        message: 'You already have a subscription. Change your plan instead.',
      });
    });

    it('re-checks under the lock: a subscription that went live meanwhile refuses, and the new one is cancelled', async () => {
      const w = await world();
      const first = await checkout.subscribe(w.user, { plan: w.planA, interval: 'monthly' });
      const original = fake.createSubscription.bind(fake);
      const spy = jest.spyOn(fake, 'createSubscription').mockImplementationOnce(async (input) => {
        // The first tab's payment lands while the second waits on the provider.
        await activate(first.subscriptionId, w.rzp[`${w.planA}:monthly`]);
        return original(input);
      });
      expect(await refusal(checkout.subscribe(w.user, { plan: w.planB, interval: 'monthly' }))).toEqual({
        status: 409,
        message: 'You already have a subscription. Change your plan instead.',
      });
      spy.mockRestore();
      const rows = await ds.query(
        `SELECT * FROM billing_subscriptions WHERE user_id = $1 AND plan_code = $2`,
        [w.user.userId, w.planB],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ cancel_at_cycle_end: false });
      expect(rows[0].cancel_requested_at).not.toBeNull();
      const acct = await account(w.user.userId);
      expect(acct.current_subscription_id).toBe((await subByProvider(first.subscriptionId)).id);
      expect(acct.next_subscription_id).toBeNull();
    });

    it('refuses a plan that cannot be bought: free, unpriced, inactive, or no price for the interval', async () => {
      const w = await world();
      const unpriced = `plan_scratch_${hex()}`;
      await ds.query(`INSERT INTO plans (code, name, sort_order) VALUES ($1, 'U', 30)`, [unpriced]);
      await ds.query(`UPDATE plans SET is_active = false WHERE code = $1`, [w.planB]);
      await ds.query(`UPDATE plan_prices SET is_current = false WHERE plan_code = $1 AND interval = 'yearly'`, [w.planA]);
      for (const choice of [
        { plan: 'free', interval: 'monthly' as const },
        { plan: unpriced, interval: 'monthly' as const },
        { plan: w.planB, interval: 'monthly' as const },
        { plan: w.planA, interval: 'yearly' as const },
        { plan: 'no_such_plan', interval: 'monthly' as const },
      ]) {
        expect(await refusal(checkout.subscribe(w.user, choice))).toEqual({ status: 400, message: 'That plan cannot be bought.' });
      }
    });

    it('refuses while the last payment is being retried', async () => {
      const w = await subscribed();
      await ds.query(`UPDATE billing_subscriptions SET status = 'pending' WHERE id = $1`, [w.currentId]);
      expect(await refusal(checkout.subscribe(w.user, { plan: w.planB, interval: 'monthly' }))).toEqual({
        status: 409,
        message: "Your last payment is being retried. Update your payment method from Razorpay's email.",
      });
    });
  });

  describe('subscribe while halted', () => {
    it('keeps the halted subscription and its grace through an abandoned Checkout, and cancels it once the new one starts', async () => {
      const w = await subscribed();
      const graceUntil = new Date(Date.now() + 10 * DAY);
      // As the halted webhook leaves it.
      await ds.query(`UPDATE billing_subscriptions SET status = 'halted', grace_until = $2 WHERE id = $1`, [w.currentId, graceUntil]);
      const halted = await sub(w.currentId);
      const again = await checkout.subscribe(w.user, { plan: w.planA, interval: 'monthly' });

      // The customer closes Checkout; the worker runs.
      await runOutbox(w.user.userId);
      expect(await sub(w.currentId)).toMatchObject({ status: 'halted', cancel_requested_at: null, cancel_sent_at: null });
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === halted.provider_subscription_id)).toEqual([]);
      const view = await overview.overview(w.user.userId);
      expect(view.state).toBe('halted');
      expect(view.effectivePlan).toMatchObject({ code: w.planA, source: 'subscription' });

      // Paid after all: the new one replaces it, and the halted one is cancelled at once.
      await activate(again.subscriptionId, w.rzp[`${w.planA}:monthly`]);
      const replaced = await sub(w.currentId);
      const fresh = await subByProvider(again.subscriptionId);
      expect(replaced).toMatchObject({ superseded_by: fresh.id, cancel_at_cycle_end: false });
      expect(replaced.cancel_requested_at).not.toBeNull();
      expect((await account(w.user.userId)).current_subscription_id).toBe(fresh.id);
      await runOutbox(w.user.userId);
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === halted.provider_subscription_id)).toEqual([
        [halted.provider_subscription_id, false],
      ]);
    });
  });

  describe('change', () => {
    it('needs a live subscription, a different plan, and no change already scheduled', async () => {
      const fresh = await world();
      expect(await refusal(checkout.change(fresh.user, { plan: fresh.planB, interval: 'monthly' }))).toEqual({
        status: 409,
        message: 'There is no active subscription to change.',
      });

      const w = await subscribed();
      expect(await refusal(checkout.change(w.user, { plan: w.planA, interval: 'monthly' }))).toEqual({
        status: 400,
        message: 'You are already on this plan.',
      });

      const current = await sub(w.currentId);
      const changed = await checkout.change(w.user, { plan: w.planB, interval: 'monthly' });
      expect(changed.startsAt).toBe(current.current_end.toISOString());
      const next = await subByProvider(changed.subscriptionId);
      expect(next).toMatchObject({ status: 'created', plan_code: w.planB });
      expect(next.start_at.getTime()).toBe(current.current_end.getTime());
      expect((await account(w.user.userId)).next_subscription_id).toBe(next.id);
      const [created] = fake.callsOf('createSubscription').slice(-1) as [[{ startAt: Date | null }]];
      expect(created[0].startAt?.getTime()).toBe(current.current_end.getTime());

      await authenticate(changed.subscriptionId, w.rzp[`${w.planB}:monthly`], current.current_end);
      expect(await refusal(checkout.change(w.user, { plan: w.planA, interval: 'yearly' }))).toEqual({
        status: 409,
        message: 'A plan change is already scheduled.',
      });
    });

    it('refuses a change too close to the renewal', async () => {
      const w = await subscribed();
      const current = await sub(w.currentId);
      const late = new Date(current.current_end.getTime() - 5 * 60_000);
      expect(await refusal(checkout.change(w.user, { plan: w.planB, interval: 'monthly' }, late))).toEqual({
        status: 409,
        message: 'Your renewal is too close to change plans. Try again after it.',
      });
    });

    it('makes the change expire before the renewal, so it cannot be authorised after the current one renews', async () => {
      const w = await subscribed();
      const current = await sub(w.currentId);
      const expiryOf = () => (fake.callsOf('createSubscription').slice(-1)[0] as [{ expireBy: Date }])[0].expireBy.getTime();

      const near = new Date(current.current_end.getTime() - 2 * 3600_000);
      await checkout.change(w.user, { plan: w.planB, interval: 'monthly' }, near);
      expect(expiryOf()).toBe(current.current_end.getTime() - CHANGE_AUTHORISE_BY_MS);

      const far = new Date();
      await checkout.change(w.user, { plan: w.planB, interval: 'yearly' }, far);
      expect(expiryOf()).toBe(far.getTime() + CHECKOUT_EXPIRY_MS);
    });
  });

  describe('cancel and keep my plan', () => {
    it('cancels at the period end once, and lets the same plan be kept after', async () => {
      const w = await subscribed();
      const current = await sub(w.currentId);
      const before = fake.callsOf('cancelSubscription').length;

      const result = await checkout.cancel(w.user.userId);
      expect(fake.callsOf('cancelSubscription').slice(before)).toEqual([[current.provider_subscription_id, true]]);
      expect(await sub(w.currentId)).toMatchObject({
        cancel_at_period_end: true,
        cancel_at_cycle_end: true,
        cancel_requested_by: w.user.userId,
      });
      expect((await sub(w.currentId)).cancel_sent_at).not.toBeNull();
      expect(result.state).toBe('cancelling');

      await checkout.cancel(w.user.userId);
      expect(fake.callsOf('cancelSubscription').length - before).toBe(1);

      const kept = await checkout.change(w.user, { plan: w.planA, interval: 'monthly' });
      expect(kept.startsAt).toBe(current.current_end.toISOString());
    });

    it('cancels a scheduled change with the subscription', async () => {
      const w = await subscribed();
      const current = await sub(w.currentId);
      const changed = await checkout.change(w.user, { plan: w.planB, interval: 'monthly' });
      await authenticate(changed.subscriptionId, w.rzp[`${w.planB}:monthly`], current.current_end);
      await checkout.cancel(w.user.userId);
      const next = await subByProvider(changed.subscriptionId);
      expect(next).toMatchObject({ cancel_at_cycle_end: false, cancel_sent_at: null });
      expect(next.cancel_requested_at).not.toBeNull();
    });

    it('cancels a scheduled change after the worker has already set the current to end', async () => {
      const w = await subscribed();
      const current = await sub(w.currentId);
      const changed = await checkout.change(w.user, { plan: w.planB, interval: 'monthly' });
      await authenticate(changed.subscriptionId, w.rzp[`${w.planB}:monthly`], current.current_end);
      // Within a minute the worker sends the current's cycle-end cancel.
      await runOutbox(w.user.userId);
      expect(await sub(w.currentId)).toMatchObject({ cancel_at_period_end: true, cancel_requested_by: null });
      const before = fake.callsOf('cancelSubscription').length;

      const result = await checkout.cancel(w.user.userId);
      expect(result.state).toBe('cancelling');
      expect(result.next).toBeNull();
      // The current is already ending: no second call for it.
      expect(fake.callsOf('cancelSubscription').length).toBe(before);
      const next = await subByProvider(changed.subscriptionId);
      expect(next).toMatchObject({ cancel_at_cycle_end: false, cancel_sent_at: null, cancel_requested_by: w.user.userId });
      expect(next.cancel_requested_at).not.toBeNull();
      expect((await account(w.user.userId)).next_subscription_id).toBeNull();

      await runOutbox(w.user.userId);
      expect(fake.callsOf('cancelSubscription').slice(before)).toEqual([[changed.subscriptionId, false]]);
      expect((await overview.overview(w.user.userId)).state).toBe('cancelling');
    });

    it('cancels a kept plan the same way', async () => {
      const w = await subscribed();
      const current = await sub(w.currentId);
      await checkout.cancel(w.user.userId);
      const kept = await checkout.change(w.user, { plan: w.planA, interval: 'monthly' });
      await authenticate(kept.subscriptionId, w.rzp[`${w.planA}:monthly`], current.current_end);
      expect((await overview.overview(w.user.userId)).state).toBe('change_scheduled');

      expect((await checkout.cancel(w.user.userId)).state).toBe('cancelling');
      const next = await subByProvider(kept.subscriptionId);
      expect(next).toMatchObject({ cancel_at_cycle_end: false });
      expect(next.cancel_requested_at).not.toBeNull();
    });

    it('refuses when the subscription changed while Razorpay answered, and leaves the new one alone', async () => {
      const w = await subscribed();
      const changed = await checkout.change(w.user, { plan: w.planB, interval: 'monthly' });
      const original = fake.cancelSubscription.bind(fake);
      const spy = jest.spyOn(fake, 'cancelSubscription').mockImplementationOnce(async (id, atCycleEnd) => {
        // The change starts charging while the cancel is on its way.
        await activate(changed.subscriptionId, w.rzp[`${w.planB}:monthly`]);
        return original(id, atCycleEnd);
      });
      expect(await refusal(checkout.cancel(w.user.userId))).toEqual({
        status: 409,
        message: 'Your subscription changed meanwhile. Try again.',
      });
      spy.mockRestore();
      const promoted = await subByProvider(changed.subscriptionId);
      expect((await account(w.user.userId)).current_subscription_id).toBe(promoted.id);
      expect(promoted).toMatchObject({ cancel_at_period_end: false, cancel_requested_at: null });
      // What Razorpay cancelled is on record, so neither the worker nor a retry sends it again.
      const old = await sub(w.currentId);
      expect(old).toMatchObject({ cancel_at_period_end: true, cancel_at_cycle_end: true, cancel_requested_by: w.user.userId });
      expect(old.cancel_sent_at).not.toBeNull();
      const before = fake.callsOf('cancelSubscription').length;
      await runOutbox(w.user.userId);
      expect(fake.callsOf('cancelSubscription').length).toBe(before);
    });

    it('never marks an immediate cancel queued meanwhile as sent by its own cycle-end one', async () => {
      const w = await subscribed();
      const original = fake.cancelSubscription.bind(fake);
      const spy = jest.spyOn(fake, 'cancelSubscription').mockImplementationOnce(async (id, atCycleEnd) => {
        // The subscription goes pending and a successor replaces it: its retries must stop now.
        await ds.query(
          `UPDATE billing_subscriptions SET cancel_requested_at = now(), cancel_at_cycle_end = false WHERE id = $1`,
          [w.currentId],
        );
        await ds.query(`UPDATE billing_accounts SET current_subscription_id = NULL WHERE user_id = $1`, [w.user.userId]);
        return original(id, atCycleEnd);
      });
      expect((await refusal(checkout.cancel(w.user.userId))).status).toBe(409);
      spy.mockRestore();
      expect(await sub(w.currentId)).toMatchObject({ cancel_at_cycle_end: false, cancel_sent_at: null, cancel_requested_by: null });
      await runOutbox(w.user.userId);
      const current = await sub(w.currentId);
      expect(fake.callsOf('cancelSubscription').slice(-1)).toEqual([[current.provider_subscription_id, false]]);
      expect(current.cancel_sent_at).not.toBeNull();
    });

    it('cancels a halted subscription at once, and only once', async () => {
      const w = await subscribed();
      const current = await sub(w.currentId);
      await ds.query(`UPDATE billing_subscriptions SET status = 'halted', grace_until = now() + interval '14 days' WHERE id = $1`, [
        w.currentId,
      ]);
      const before = fake.callsOf('cancelSubscription').length;
      await checkout.cancel(w.user.userId);
      expect(fake.callsOf('cancelSubscription').slice(before)).toEqual([[current.provider_subscription_id, false]]);
      const row = await sub(w.currentId);
      expect(row).toMatchObject({ cancel_at_cycle_end: false, cancel_at_period_end: false, cancel_requested_by: w.user.userId });
      expect(row.cancel_sent_at).not.toBeNull();

      // Until the cancelled webhook lands the row is still halted: a second click calls nobody.
      await checkout.cancel(w.user.userId);
      expect(fake.callsOf('cancelSubscription').length - before).toBe(1);
    });

    it('says Razorpay could not be reached, and changes nothing', async () => {
      const w = await subscribed();
      fake.failNext('cancelSubscription', new TypeError('fetch failed'));
      expect(await refusal(checkout.cancel(w.user.userId))).toEqual({ status: 400, message: 'Could not reach Razorpay. Try again.' });
      expect(await sub(w.currentId)).toMatchObject({ cancel_at_period_end: false, cancel_requested_at: null });
    });

    it('refuses with nothing to cancel', async () => {
      const w = await world();
      expect(await refusal(checkout.cancel(w.user.userId))).toEqual({
        status: 409,
        message: 'There is no active subscription to cancel.',
      });
    });
  });

  describe('overview', () => {
    it('sums the account projects MAU on the last counted day only', async () => {
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        const w = await world();
        const projects = [randomUUID(), randomUUID()];
        for (const id of projects) {
          await qr.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'p', $2)`, [id, w.user.userId]);
        }
        await qr.query(
          `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day) VALUES (1, '2026-11-02', '2026-08-04', '2026-11-13')
           ON CONFLICT (id) DO UPDATE SET started_on = EXCLUDED.started_on, first_day = EXCLUDED.first_day, last_closed_day = EXCLUDED.last_closed_day`,
        );
        const usage = (project: string, day: string, value: number) =>
          qr.query(
            `INSERT INTO usage_daily (project_id, owner_id, day, metric, value) VALUES ($1, $2, $3, 'mau_month_to_date', $4)`,
            [project, w.user.userId, day, value],
          );
        await usage(projects[0], '2026-11-13', 120);
        await usage(projects[1], '2026-11-13', 30);
        await usage(projects[0], '2026-11-12', 999);

        const view = await overview.overview(w.user.userId, new Date('2026-11-14T10:00:00Z'), qr.manager);
        expect(view.usage.mau).toEqual({ used: 150, limit: null, month: '2026-11-01', countedThrough: '2026-11-13' });
        expect(view.usage.projects).toEqual({ used: 2, limit: 10 });
        expect(view.state).toBe('free');
        expect(view.effectivePlan).toEqual({ code: 'free', name: 'Free', source: 'free', until: null });
        expect(view.keyId).toBe(KEY_ID);
        expect(view.details?.gstin).toBe('27AAPFU0939F1ZV');
        const codes = view.plans.map((p) => p.code);
        expect(codes[0]).toBe('free');
        expect(codes).toEqual(expect.arrayContaining([w.planA, w.planB]));
        const a = view.plans.find((p) => p.code === w.planA);
        expect(a?.monthly).toMatchObject({ pricePaise: 99900, taxPaise: 17982, amountPaise: 117882, taxRateBps: 1800 });
        expect(a?.mauLimit).toBe(1000);
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    });

    it('shows the subscription and the plan limit once paid', async () => {
      const w = await subscribed();
      const view = await overview.overview(w.user.userId);
      expect(view.state).toBe('active');
      expect(view.effectivePlan).toMatchObject({ code: w.planA, name: 'A', source: 'subscription' });
      expect(view.current).toMatchObject({ planCode: w.planA, planName: 'A', interval: 'monthly', status: 'active', amountPaise: 117882 });
      expect(view.next).toBeNull();
      expect(view.usage.mau.limit).toBe(1000);
    });
  });
});

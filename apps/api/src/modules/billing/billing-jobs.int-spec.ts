import { randomBytes, randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { parkOtherOutboxRows } from '../../test-support/billing-outbox';
import { FakeBillingProvider } from '../../test-support/fake-billing-provider';
import type { PlatformEmail, PlatformEmailService } from '../platform-email/platform-email.service';
import { AccountLimitsService } from './account-limits.service';
import { BillingEmailsService } from './billing-emails.service';
import { BillingLedgerService } from './billing-ledger.service';
import { BillingOutboxService, OUTBOX_MAX_BACKOFF_MS } from './billing-outbox.service';
import { BillingReconcileService } from './billing-reconcile.service';
import { BillingStateService } from './billing-state.service';
import { accountState, effectivePlan } from './effective-plan';
import { MauNoticesService } from './mau-notices.service';
import { BillingProviderError, ProviderSubscription } from './providers/billing-provider';

const KEY_ID = 'rzp_test_AbC123xyz';

/**
 * The worker's billing jobs on real tables with the in-memory provider: the cancel
 * outbox, reconciliation of missed webhooks, and MAU notices.
 *
 * The outbox and reconciliation read the whole table, and the integration database
 * keeps rows from earlier runs of other specs, whose subscriptions this fake has never
 * heard of. So before each of those cases, leftover rows are put out of the jobs'
 * reach (their outbox retries parked, stale ones and old checkouts ended, missing
 * invoices filled): only rows this spec made are worked on.
 */
describe('billing worker jobs (integration)', () => {
  let ds: DataSource;
  let fake: FakeBillingProvider;
  let outbox: BillingOutboxService;
  let reconcile: BillingReconcileService;
  let limits: AccountLimitsService;
  let emailMode: 'sent' | 'not_configured' = 'sent';
  const emails: PlatformEmail[] = [];
  const hex = (bytes = 6) => randomBytes(bytes).toString('hex');
  const DAY = 24 * 3600_000;
  const mine = new Set<string>();

  const configWith = (enabled: boolean) =>
    ({
      get: (key: string) =>
        key === 'billing'
          ? { enabled, graceDays: 14, keyId: KEY_ID }
          : key === 'app.appUrl'
            ? 'https://app.example'
            : undefined,
    }) as unknown as ConfigService;

  const platformEmail = {
    send: jest.fn(async (email: PlatformEmail) => {
      if (emailMode === 'not_configured') return { sent: false as const, reason: 'not_configured' as const };
      emails.push(email);
      return { sent: true as const };
    }),
  } as unknown as PlatformEmailService;

  let billingEmails: BillingEmailsService;
  const notices = (enabled = true) => new MauNoticesService(ds, configWith(enabled), billingEmails);

  beforeAll(async () => {
    ds = await openIntDb();
    fake = new FakeBillingProvider({ keyId: KEY_ID });
    const config = configWith(true);
    const state = new BillingStateService(config);
    const ledger = new BillingLedgerService(ds, state);
    billingEmails = new BillingEmailsService(ds, platformEmail, config);
    outbox = new BillingOutboxService(ds, fake);
    reconcile = new BillingReconcileService(ds, ledger, billingEmails, fake);
    limits = new AccountLimitsService(config);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  async function user(): Promise<string> {
    const id = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'Asha')`, [
      id,
      `jobs-${id.slice(0, 8)}@test.local`,
    ]);
    mine.add(id);
    return id;
  }

  async function plan(mauLimit: number | null = null): Promise<{ code: string; priceId: string; rzp: string }> {
    const code = `plan_scratch_${hex()}`;
    await ds.query(`INSERT INTO plans (code, name, sort_order, mau_limit) VALUES ($1, 'Jobs', 10, $2)`, [code, mauLimit]);
    const rzp = `plan_${hex(7)}`;
    const [price] = await ds.query(
      `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
       VALUES ($1, 'monthly', 99900, 1800, 117882, $2, true) RETURNING id`,
      [code, rzp],
    );
    return { code, priceId: price.id, rzp };
  }

  /** A subscription row, mirrored at the fake as `atProvider` says. */
  async function subscription(
    userId: string,
    p: { code: string; priceId: string; rzp: string },
    row: Partial<{ status: string; currentEnd: Date; cancelRequested: boolean; atCycleEnd: boolean }>,
    atProvider: Partial<ProviderSubscription> = {},
  ): Promise<{ id: string; providerId: string }> {
    const providerId = `sub_${hex(7)}`;
    const [inserted] = await ds.query(
      `INSERT INTO billing_subscriptions
         (user_id, provider_subscription_id, price_id, plan_code, interval, status, current_start, current_end,
          cancel_requested_at, cancel_at_cycle_end)
       VALUES ($1, $2, $3, $4, 'monthly', $5, $6, $7, $8, $9) RETURNING id`,
      [
        userId,
        providerId,
        p.priceId,
        p.code,
        row.status ?? 'active',
        row.currentEnd ? new Date(row.currentEnd.getTime() - 30 * DAY) : null,
        row.currentEnd ?? null,
        row.cancelRequested ? new Date() : null,
        row.cancelRequested ? (row.atCycleEnd ?? false) : null,
      ],
    );
    fake.setSubscription({
      id: providerId,
      planId: p.rzp,
      customerId: null,
      status: (row.status as ProviderSubscription['status']) ?? 'active',
      currentStart: null,
      currentEnd: row.currentEnd ?? null,
      startAt: null,
      chargeAt: null,
      endedAt: null,
      paidCount: 1,
      shortUrl: null,
      ...atProvider,
    });
    return { id: inserted.id, providerId };
  }

  const sub = async (id: string) => (await ds.query(`SELECT * FROM billing_subscriptions WHERE id = $1`, [id]))[0];

  describe('outbox', () => {
    beforeEach(async () => {
      await parkOtherOutboxRows(ds, mine);
    });

    it('two runs at once send each cancel once, at cycle end or now as asked', async () => {
      const u = await user();
      const p = await plan();
      const now = await subscription(u, p, { status: 'created', cancelRequested: true });
      const atEnd = await subscription(u, p, { status: 'active', currentEnd: new Date(Date.now() + 9 * DAY), cancelRequested: true, atCycleEnd: true });
      const untouched = await subscription(u, p, { status: 'active' });
      const before = fake.callsOf('cancelSubscription').length;

      const [a, b] = await Promise.all([outbox.runOnce(), outbox.runOnce()]);
      expect(a + b).toBe(2);
      const calls = fake.callsOf('cancelSubscription').slice(before);
      expect(calls).toHaveLength(2);
      expect(calls).toEqual(expect.arrayContaining([[now.providerId, false], [atEnd.providerId, true]]));

      expect((await sub(now.id)).cancel_sent_at).not.toBeNull();
      expect(await sub(atEnd.id)).toMatchObject({ cancel_at_period_end: true, cancel_attempts: 1, cancel_error: null });
      expect(await sub(untouched.id)).toMatchObject({ cancel_sent_at: null, cancel_attempts: 0 });

      expect(await outbox.runOnce()).toBe(0);
      expect(fake.callsOf('cancelSubscription').length - before).toBe(2);
    });

    it('counts an "already cancelled" refusal as sent', async () => {
      const u = await user();
      const ended = await subscription(u, await plan(), { status: 'created', cancelRequested: true }, { status: 'cancelled' });
      expect(await outbox.runOnce()).toBe(1);
      expect(await sub(ended.id)).toMatchObject({ cancel_error: null });
      expect((await sub(ended.id)).cancel_sent_at).not.toBeNull();
    });

    it('keeps a 400 that does not say the subscription already ended, and retries it', async () => {
      const u = await user();
      const live = await subscription(u, await plan(), { status: 'active', currentEnd: new Date(Date.now() + 9 * DAY), cancelRequested: true, atCycleEnd: true });
      // A refusal whose wording mentions "cancelled" is not an ended subscription: it is still live and charging.
      fake.failNext(
        'cancelSubscription',
        new BillingProviderError(400, 'BAD_REQUEST_ERROR', 'Subscription cannot be cancelled while a payment is in progress'),
      );
      const now = new Date();
      expect(await outbox.runOnce(now)).toBe(0);
      const kept = await sub(live.id);
      expect(kept).toMatchObject({ cancel_sent_at: null, cancel_at_period_end: false, cancel_attempts: 1 });
      expect(kept.cancel_error).toContain('400 BAD_REQUEST_ERROR Subscription cannot be cancelled');
      expect(await outbox.runOnce(new Date(now.getTime() + 2 * 60_000))).toBe(1);
      expect(await sub(live.id)).toMatchObject({ cancel_at_period_end: true, cancel_error: null });
    });

    it('never marks a newer decision sent: a cycle-end call answered after staff chose "now" leaves "now" to send', async () => {
      const u = await user();
      const live = await subscription(u, await plan(), {
        status: 'active',
        currentEnd: new Date(Date.now() + 9 * DAY),
        cancelRequested: true,
        atCycleEnd: true,
      });
      const spy = jest.spyOn(fake, 'cancelSubscription').mockImplementationOnce(async (id, atCycleEnd) => {
        // Staff turn the queued cycle-end cancel into an immediate one while this call is out.
        await ds.query(
          `UPDATE billing_subscriptions SET cancel_requested_at = now() + interval '1 second', cancel_at_cycle_end = false
            WHERE id = $1`,
          [live.id],
        );
        return FakeBillingProvider.prototype.cancelSubscription.call(fake, id, atCycleEnd);
      });
      try {
        await outbox.runOnce();
      } finally {
        spy.mockRestore();
      }
      expect(await sub(live.id)).toMatchObject({ cancel_sent_at: null, cancel_at_period_end: false, cancel_at_cycle_end: false });
      expect(await outbox.sendQueued(live.id)).toEqual({ sent: true });
      expect(fake.callsOf('cancelSubscription').slice(-1)).toEqual([[live.providerId, false]]);
      expect((await sub(live.id)).cancel_sent_at).not.toBeNull();
    });

    it('backs off after a failure and never gives up on a cancel', async () => {
      const u = await user();
      const p = await plan();
      const flaky = await subscription(u, p, { status: 'created', cancelRequested: true });
      const now = new Date();
      fake.failNext('cancelSubscription', new BillingProviderError(500, 'SERVER_ERROR', 'Something went wrong'));
      expect(await outbox.runOnce(now)).toBe(0);
      expect(await sub(flaky.id)).toMatchObject({ cancel_sent_at: null, cancel_attempts: 1 });
      expect((await sub(flaky.id)).cancel_error).toContain('500 SERVER_ERROR Something went wrong');
      expect((await sub(flaky.id)).cancel_retry_at.getTime()).toBe(now.getTime() + 60_000);
      const calls = fake.callsOf('cancelSubscription').length;
      expect(await outbox.runOnce(new Date(now.getTime() + 30_000))).toBe(0);
      expect(fake.callsOf('cancelSubscription').length).toBe(calls);
      expect(await outbox.runOnce(new Date(now.getTime() + 60_000))).toBe(1);
      expect(await sub(flaky.id)).toMatchObject({ cancel_error: null, cancel_attempts: 2 });

      // Hours of failures: still retried, at most an hour apart.
      const stubborn = await subscription(u, p, { status: 'created', cancelRequested: true });
      await ds.query(`UPDATE billing_subscriptions SET cancel_attempts = 40 WHERE id = $1`, [stubborn.id]);
      fake.failNext('cancelSubscription', new TypeError('fetch failed'));
      expect(await outbox.runOnce(now)).toBe(0);
      const failing = await sub(stubborn.id);
      expect(failing).toMatchObject({ cancel_attempts: 41, cancel_sent_at: null });
      expect(failing.cancel_error).toContain('unreachable');
      expect(failing.cancel_retry_at.getTime()).toBe(now.getTime() + OUTBOX_MAX_BACKOFF_MS);
      expect(await outbox.runOnce(new Date(now.getTime() + OUTBOX_MAX_BACKOFF_MS))).toBe(1);
      expect((await sub(stubborn.id)).cancel_sent_at).not.toBeNull();
    });
  });

  describe('reconciliation', () => {
    beforeEach(async () => {
      await ds.query(
        `UPDATE billing_subscriptions SET status = 'expired'
          WHERE ((status IN ('active', 'pending') AND current_end < now() - interval '6 hours')
             OR (status = 'authenticated' AND COALESCE(start_at, created_at) < now() - interval '6 hours')
             OR (status = 'created' AND created_at < now() - interval '24 hours'))
            AND NOT (user_id = ANY($1::uuid[]))`,
        [[...mine]],
      );
      await ds.query(
        `INSERT INTO billing_invoices (provider_invoice_id, user_id, subscription_id, status, amount_paise, tax_paise, provider_tax_paise, currency, short_url)
         SELECT DISTINCT ON (p.provider_invoice_id) p.provider_invoice_id, p.user_id, p.subscription_id, 'paid', p.amount_paise, 0, 0, p.currency, 'https://example.invalid/i'
           FROM billing_payments p
          WHERE p.provider_invoice_id IS NOT NULL AND NOT (p.user_id = ANY($1::uuid[]))
         ON CONFLICT (provider_invoice_id) DO UPDATE SET short_url = COALESCE(billing_invoices.short_url, EXCLUDED.short_url)`,
        [[...mine]],
      );
    });

    it('applies a missed cancellation of a stale subscription through a recorded event', async () => {
      const u = await user();
      const p = await plan();
      const stale = await subscription(
        u,
        p,
        { status: 'active', currentEnd: new Date(Date.now() - DAY) },
        { status: 'cancelled', endedAt: new Date(Math.floor((Date.now() - DAY) / 1000) * 1000) },
      );
      await ds.query(`INSERT INTO billing_accounts (user_id, current_subscription_id) VALUES ($1, $2)`, [u, stale.id]);
      expect(effectivePlan(await limits.billingState(ds.manager, u), new Date()).planCode).toBe(p.code);

      expect(await reconcile.runOnce()).toBeGreaterThanOrEqual(1);
      expect((await sub(stale.id)).status).toBe('cancelled');
      expect(effectivePlan(await limits.billingState(ds.manager, u), new Date()).planCode).toBe('free');
      const [event] = await ds.query(
        `SELECT type, outcome, payload FROM billing_events WHERE provider_event_id LIKE $1`,
        [`reconcile_${stale.providerId}_%`],
      );
      expect(event).toMatchObject({ type: 'subscription.reconciled', outcome: 'applied' });
      expect(event.payload).toMatchObject({ source: 'reconcile', subscription: { id: stale.providerId, status: 'cancelled' } });
    });

    it('clears an abandoned Checkout once the provider says it expired', async () => {
      const u = await user();
      const p = await plan();
      const abandoned = await subscription(u, p, { status: 'created' }, { status: 'expired', paidCount: 0 });
      await ds.query(`UPDATE billing_subscriptions SET created_at = now() - interval '26 hours' WHERE id = $1`, [abandoned.id]);
      await ds.query(`INSERT INTO billing_accounts (user_id, next_subscription_id) VALUES ($1, $2)`, [u, abandoned.id]);
      // Another account's Checkout, opened a moment ago, is left alone.
      const other = await user();
      const fresh = await subscription(other, p, { status: 'created' }, { status: 'expired', paidCount: 0 });
      await ds.query(`INSERT INTO billing_accounts (user_id, next_subscription_id) VALUES ($1, $2)`, [other, fresh.id]);
      const rank = await limits.planRanks(ds.manager);
      expect(accountState(await limits.billingState(ds.manager, u), new Date(), rank)).toBe('checkout');

      expect(await reconcile.runOnce()).toBeGreaterThanOrEqual(1);
      expect((await sub(abandoned.id)).status).toBe('expired');
      const [account] = await ds.query(`SELECT next_subscription_id FROM billing_accounts WHERE user_id = $1`, [u]);
      expect(account.next_subscription_id).toBeNull();
      expect(accountState(await limits.billingState(ds.manager, u), new Date(), rank)).toBe('free');
      expect((await sub(fresh.id)).status).toBe('created');
      expect(fake.callsOf('fetchSubscription').map(([id]) => id)).not.toContain(fresh.providerId);
    });

    it('fills in an invoice a payment points at but no webhook delivered', async () => {
      const u = await user();
      const p = await plan();
      const live = await subscription(u, p, { status: 'active', currentEnd: new Date(Date.now() + 20 * DAY) });
      const invoiceId = `inv_${hex(7)}`;
      await ds.query(
        `INSERT INTO billing_payments (provider_payment_id, user_id, subscription_id, provider_invoice_id, amount_paise, tax_rate_bps, currency, status, paid_at)
         VALUES ($1, $2, $3, $4, 117882, 1800, 'INR', 'captured', now() - interval '1 day')`,
        [`pay_${hex(7)}`, u, live.id, invoiceId],
      );
      fake.addInvoice({
        id: invoiceId,
        subscriptionId: live.providerId,
        customerId: null,
        paymentId: null,
        status: 'paid',
        amountPaise: 117882,
        providerTaxPaise: 0,
        currency: 'INR',
        billingStart: new Date(Math.floor((Date.now() - 10 * DAY) / 1000) * 1000),
        billingEnd: new Date(Math.floor((Date.now() + 20 * DAY) / 1000) * 1000),
        issuedAt: new Date(Math.floor((Date.now() - DAY) / 1000) * 1000),
        paidAt: new Date(Math.floor((Date.now() - DAY) / 1000) * 1000),
        shortUrl: 'https://rzp.io/i/jobsInv1',
        number: null,
      });

      await reconcile.runOnce();
      const [invoice] = await ds.query(`SELECT * FROM billing_invoices WHERE provider_invoice_id = $1`, [invoiceId]);
      expect(invoice).toMatchObject({ user_id: u, subscription_id: live.id, status: 'paid', short_url: 'https://rzp.io/i/jobsInv1', amount_paise: 117882, tax_paise: 17982 });
    });
  });

  describe('MAU notices', () => {
    /** Inside a transaction rolled back after, so the shared roll-up state is never changed for other specs. */
    async function inTransaction(run: (q: ReturnType<DataSource['createQueryRunner']>) => Promise<void>) {
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await run(qr);
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    }

    // Far in the future, so no other spec's usage rows share the counted day.
    const coverage = (qr: ReturnType<DataSource['createQueryRunner']>, lastClosedDay: string) =>
      qr.query(
        `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day) VALUES (1, '2031-03-02', '2030-12-02', $1)
         ON CONFLICT (id) DO UPDATE SET started_on = EXCLUDED.started_on, first_day = EXCLUDED.first_day, last_closed_day = EXCLUDED.last_closed_day`,
        [lastClosedDay],
      );
    const mau = (qr: ReturnType<DataSource['createQueryRunner']>, owner: string, day: string, value: number) =>
      qr.query(
        `INSERT INTO usage_daily (project_id, owner_id, day, metric, value) VALUES ($1, $2, $3, 'mau_month_to_date', $4)
         ON CONFLICT (project_id, day, metric) DO UPDATE SET value = EXCLUDED.value`,
        [`00000000-0000-4000-8000-${owner.slice(-12)}`, owner, day, value],
      );
    const compedTo = async (code: string) => {
      const u = await user();
      await ds.query(`INSERT INTO billing_accounts (user_id, comp_plan_code) VALUES ($1, $2)`, [u, code]);
      return u;
    };
    const mailedTo = (u: string, from: number) =>
      emails.slice(from).filter((e) => e.to === `jobs-${u.slice(0, 8)}@test.local`);

    beforeEach(() => {
      emailMode = 'sent';
    });

    it('sends 80% once, then 100% once, then again next month; never under 80%', async () => {
      const { code } = await plan(100);
      const u = await compedTo(code);
      const from = emails.length;
      await inTransaction(async (qr) => {
        const run = () => notices().runOnce(new Date('2031-03-14T01:15:00Z'), qr.manager);
        await coverage(qr, '2031-03-13');
        await mau(qr, u, '2031-03-13', 79);
        expect(await run()).toEqual({ sent: 0, skipped: 0 });

        await mau(qr, u, '2031-03-13', 80);
        expect(await run()).toEqual({ sent: 1, skipped: 0 });
        expect(await run()).toEqual({ sent: 0, skipped: 0 });

        await mau(qr, u, '2031-03-13', 100);
        expect(await run()).toEqual({ sent: 1, skipped: 0 });
        expect(await run()).toEqual({ sent: 0, skipped: 0 });

        await coverage(qr, '2031-04-13');
        await mau(qr, u, '2031-04-13', 85);
        expect(await notices().runOnce(new Date('2031-04-14T01:15:00Z'), qr.manager)).toEqual({ sent: 1, skipped: 0 });

        const [account] = await qr.query(
          `SELECT to_char(mau_notice_month, 'YYYY-MM-DD') AS month, mau_notice_level AS level FROM billing_accounts WHERE user_id = $1`,
          [u],
        );
        expect(account).toEqual({ month: '2031-04-01', level: 80 });
      });
      const subjects = mailedTo(u, from).map((e) => e.subject);
      expect(subjects).toEqual([
        "Your apps are at 80% of this month's active devices",
        "Your apps passed this month's active device limit",
        "Your apps are at 80% of this month's active devices",
      ]);
      expect(mailedTo(u, from)[1].text).toContain('https://app.example/account/billing');
    });

    it('jumping straight to 100% sends one email', async () => {
      const { code } = await plan(100);
      const u = await compedTo(code);
      const from = emails.length;
      await inTransaction(async (qr) => {
        await coverage(qr, '2031-03-13');
        await mau(qr, u, '2031-03-13', 140);
        expect(await notices().runOnce(new Date('2031-03-14T01:15:00Z'), qr.manager)).toEqual({ sent: 1, skipped: 0 });
      });
      expect(mailedTo(u, from).map((e) => e.subject)).toEqual(["Your apps passed this month's active device limit"]);
    });

    it('sends nothing on a plan with no MAU limit, or with billing off', async () => {
      const unlimited = await compedTo((await plan(null)).code);
      const limited = await compedTo((await plan(100)).code);
      await inTransaction(async (qr) => {
        await coverage(qr, '2031-03-13');
        await mau(qr, unlimited, '2031-03-13', 5000);
        await mau(qr, limited, '2031-03-13', 5000);
        expect(await notices(false).runOnce(new Date('2031-03-14T01:15:00Z'), qr.manager)).toEqual({ sent: 0, skipped: 0 });
        expect(await notices().runOnce(new Date('2031-03-14T01:15:00Z'), qr.manager)).toEqual({ sent: 1, skipped: 0 });
      });
    });

    it('stamps the notice even when account email is not set up, and counts it skipped', async () => {
      const u = await compedTo((await plan(100)).code);
      emailMode = 'not_configured';
      await inTransaction(async (qr) => {
        await coverage(qr, '2031-03-13');
        await mau(qr, u, '2031-03-13', 90);
        const run = () => notices().runOnce(new Date('2031-03-14T01:15:00Z'), qr.manager);
        expect(await run()).toEqual({ sent: 0, skipped: 1 });
        expect(await run()).toEqual({ sent: 0, skipped: 0 });
        const [account] = await qr.query(`SELECT mau_notice_level FROM billing_accounts WHERE user_id = $1`, [u]);
        expect(account.mau_notice_level).toBe(80);
      });
    });
  });
});

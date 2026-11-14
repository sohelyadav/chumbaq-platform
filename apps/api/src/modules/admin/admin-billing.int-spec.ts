import { randomBytes, randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { AdminBillingSummary, AdminTenantBilling, AdminTenantDetail, AdminTenantSummary } from '@chumbaq/shared';
import { BootedApp, bootIntApp, listRoutes } from '../../test-support/int-apps';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { FakeBillingProvider } from '../../test-support/fake-billing-provider';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { BillingOverviewService } from '../billing/billing-overview.service';
import { netOfTax } from '../billing/money';
import { BillingOutboxService } from '../billing/billing-outbox.service';
import { BILLING_PROVIDER, BillingProviderError } from '../billing/providers/billing-provider';
import { parkOtherOutboxRows } from '../../test-support/billing-outbox';
import { AdminAuditService } from './admin-audit.service';
import { AdminBillingService } from './admin-billing.service';

const KEY_ID = 'rzp_test_BillingAdmin1';
const DOMAIN = '@admin-billing-int.test';
const REASON = 'agreed with the customer by phone';
const DAY = 24 * 3600_000;

/**
 * Staff billing on the booted admin API with fake keys and the in-memory provider.
 *
 * The summary covers every account, and the integration database keeps other specs'
 * billing rows, so its arithmetic is checked in a transaction rolled back after, at a
 * far-future instant: as the difference between the summary before and after this
 * spec's rows, and exactly for this spec's own plan. Everything else goes over HTTP.
 */
describe('admin billing API (integration)', () => {
  let ds: DataSource;
  let on: BootedApp;
  let off: BootedApp;
  let fake: FakeBillingProvider;
  let staff: { id: string; email: string; sessionVersion: number };
  let token: string;
  let staleToken: string;
  const hex = (bytes = 6) => randomBytes(bytes).toString('hex');

  beforeAll(async () => {
    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = 'test_key_secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
    ds = await openIntDb();
    fake = new FakeBillingProvider({ keyId: KEY_ID });
    on = await bootIntApp('admin', { providers: [{ token: BILLING_PROVIDER, useValue: fake }] });
    process.env.RAZORPAY_KEY_ID = '';
    process.env.RAZORPAY_KEY_SECRET = '';
    process.env.RAZORPAY_WEBHOOK_SECRET = '';
    off = await bootIntApp('admin');
    staff = await newStaff();
    token = (await issueStaffSessionForTest(ds, staff)).accessToken;
    staleToken = (await issueStaffSessionForTest(ds, staff, { authTime: new Date(Date.now() - 3600_000) })).accessToken;
  }, 120000);

  afterAll(async () => {
    await on?.app.close();
    await off?.app.close();
    await closeIntDb(ds);
  });

  async function newStaff() {
    const [row] = await ds.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin)
       VALUES ($1, 'x', 'Staff', true) RETURNING id, email, session_version`,
      [`staff-${hex(4)}${DOMAIN}`],
    );
    return { id: row.id as string, email: row.email as string, sessionVersion: row.session_version as number };
  }

  // ------------------------------------------------------------------ fixtures

  type Q = Pick<EntityManager, 'query'>;

  async function user(q: Q = ds, name = 'tenant'): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `${name}-${id.slice(0, 8)}${DOMAIN}`;
    await q.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'Tenant')`, [id, email]);
    return { id, email };
  }

  async function plan(q: Q = ds, mauLimit: number | null = null) {
    const code = `plan_scratch_${hex()}`;
    await q.query(`INSERT INTO plans (code, name, sort_order, mau_limit) VALUES ($1, 'Scratch', 10, $2)`, [code, mauLimit]);
    const [monthly] = await q.query(
      `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
       VALUES ($1, 'monthly', 99900, 1800, 117882, $2, true) RETURNING id`,
      [code, `plan_${hex(7)}`],
    );
    const [yearly] = await q.query(
      `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
       VALUES ($1, 'yearly', 999000, 1800, 1178820, $2, true) RETURNING id`,
      [code, `plan_${hex(7)}`],
    );
    return { code, monthly: monthly.id as string, yearly: yearly.id as string };
  }

  type Plan = Awaited<ReturnType<typeof plan>>;

  async function subscription(
    q: Q,
    userId: string,
    p: Plan,
    over: Partial<{
      interval: 'monthly' | 'yearly';
      status: string;
      currentEnd: Date;
      statusChangedAt: Date;
      graceUntil: Date;
      cancelAtPeriodEnd: boolean;
      supersededBy: string;
      wasCurrent: boolean;
      current: boolean;
    }> = {},
  ): Promise<{ id: string; providerId: string }> {
    const interval = over.interval ?? 'monthly';
    const providerId = `sub_${hex(7)}`;
    const [row] = await q.query(
      `INSERT INTO billing_subscriptions
         (user_id, provider_subscription_id, price_id, plan_code, interval, status, current_end, status_changed_at,
          grace_until, cancel_at_period_end, superseded_by, was_current)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        userId,
        providerId,
        interval === 'monthly' ? p.monthly : p.yearly,
        p.code,
        interval,
        over.status ?? 'active',
        over.currentEnd ?? new Date(Date.now() + 20 * DAY),
        over.statusChangedAt ?? new Date(),
        over.graceUntil ?? null,
        over.cancelAtPeriodEnd ?? false,
        over.supersededBy ?? null,
        over.wasCurrent ?? true,
      ],
    );
    if (over.current !== false) {
      await q.query(
        `INSERT INTO billing_accounts (user_id, current_subscription_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET current_subscription_id = EXCLUDED.current_subscription_id`,
        [userId, row.id],
      );
    }
    return { id: row.id, providerId };
  }

  async function payment(
    q: Q,
    userId: string,
    subscriptionId: string | null,
    over: { amount: number; refunded?: number; status?: string; paidAt: Date },
  ): Promise<string> {
    const [row] = await q.query(
      `INSERT INTO billing_payments
         (provider_payment_id, user_id, subscription_id, amount_paise, amount_refunded_paise, tax_rate_bps, currency,
          status, method, failure_reason, paid_at)
       VALUES ($1, $2, $3, $4, $5, 1800, 'INR', $6, 'upi', $7, $8) RETURNING id`,
      [
        `pay_${hex(7)}`,
        userId,
        subscriptionId,
        over.amount,
        over.refunded ?? 0,
        over.status ?? 'captured',
        over.status === 'failed' ? 'payment_failed' : null,
        over.paidAt,
      ],
    );
    return row.id;
  }

  async function call(app: BootedApp, method: string, path: string, body?: unknown, bearer = token) {
    const res = await fetch(`${app.base}/api/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: { data?: any; meta?: any; message?: unknown } = {};
    try {
      json = JSON.parse(text);
    } catch {
      // CSV or empty
    }
    return { status: res.status, data: json.data, meta: json.meta, text, message: JSON.stringify(json.message ?? '') };
  }

  const auditOf = (action: string, targetId: string) =>
    ds.query(
      `SELECT actor_id, target_type, target_label, reason, metadata FROM admin_audit_logs
        WHERE action = $1 AND target_id = $2 ORDER BY created_at, id`,
      [action, targetId],
    );

  // ------------------------------------------------------------------ summary

  describe('summary', () => {
    const NOW = new Date('2031-06-15T12:00:00Z');

    async function inTransaction(run: (manager: EntityManager) => Promise<void>) {
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await run(qr.manager);
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    }

    const delta = (a: { netPaise: number; grossPaise: number; taxPaise: number }, b: typeof a) => ({
      netPaise: a.netPaise - b.netPaise,
      grossPaise: a.grossPaise - b.grossPaise,
      taxPaise: a.taxPaise - b.taxPaise,
    });

    it('adds up recurring revenue, revenue kept, and lists who is overdue, comped, over MAU and failing', async () => {
      const service = on.app.get(AdminBillingService);
      await inTransaction(async (q) => {
        const before: AdminBillingSummary = await service.summary(NOW, q);
        const p = await plan(q, 100);
        const end = new Date(NOW.getTime() + 10 * DAY);
        const a = await user(q, 'a');
        const subA = await subscription(q, a.id, p, { currentEnd: end });
        const b = await user(q, 'b');
        const subB = await subscription(q, b.id, p, { currentEnd: end, cancelAtPeriodEnd: true });
        const c = await user(q, 'c');
        const subC = await subscription(q, c.id, p, { interval: 'yearly', currentEnd: end });
        // Comped while paying: charged all the same, so counted as recurring revenue, and
        // listed as comped and paying.
        const d = await user(q, 'd');
        await subscription(q, d.id, p, { currentEnd: end });
        await q.query(
          `UPDATE billing_accounts SET comp_plan_code = $2, comp_reason = 'partner', comped_at = $3 WHERE user_id = $1`,
          [d.id, p.code, NOW],
        );
        // Comped over a subscription that ended: not paying.
        const k = await user(q, 'k');
        await subscription(q, k.id, p, { status: 'cancelled', currentEnd: end });
        await q.query(
          `UPDATE billing_accounts SET comp_plan_code = $2, comp_reason = 'trial', comped_at = $3 WHERE user_id = $1`,
          [k.id, p.code, new Date(NOW.getTime() - 60_000)],
        );
        // Halted three days and an hour ago; payment retried since yesterday (still counted).
        const e = await user(q, 'e');
        const graceUntil = new Date(NOW.getTime() + 11 * DAY);
        await subscription(q, e.id, p, {
          status: 'halted',
          statusChangedAt: new Date(NOW.getTime() - 3 * DAY - 3600_000),
          graceUntil,
        });
        const f = await user(q, 'f');
        await subscription(q, f.id, p, { status: 'pending', statusChangedAt: new Date(NOW.getTime() - DAY - 60_000) });
        // A Checkout replaced before it was ever current, which still took money.
        const g = await user(q, 'g');
        const gNew = await subscription(q, g.id, p, { status: 'cancelled', current: false });
        const gOld = await subscription(q, g.id, p, { status: 'active', current: false, supersededBy: gNew.id, wasCurrent: false });
        // A cancel the worker could not send.
        const h = await user(q, 'h');
        const subH = await subscription(q, h.id, p, { status: 'active', current: false });
        await q.query(
          `UPDATE billing_subscriptions SET cancel_requested_at = $2, cancel_attempts = 3, cancel_error = 'Billing provider answered 500'
            WHERE id = $1`,
          [subH.id, NOW],
        );

        await payment(q, a.id, subA.id, { amount: 117882, paidAt: new Date(NOW.getTime() - DAY) });
        await payment(q, b.id, subB.id, { amount: 117882, refunded: 17882, status: 'refunded', paidAt: new Date(NOW.getTime() - 2 * DAY) });
        const failed = await payment(q, c.id, subC.id, { amount: 1178820, status: 'failed', paidAt: new Date(NOW.getTime() - 3 * DAY) });
        const orphan = await payment(q, g.id, gOld.id, { amount: 117882, paidAt: new Date(NOW.getTime() - 3600_000) });
        await payment(q, a.id, subA.id, { amount: 117882, paidAt: new Date(NOW.getTime() - 40 * DAY) });

        // MAU on the last counted day, far from any other spec's.
        await q.query(
          `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day) VALUES (1, '2031-03-02', '2030-12-02', '2031-06-14')
           ON CONFLICT (id) DO UPDATE SET started_on = EXCLUDED.started_on, first_day = EXCLUDED.first_day, last_closed_day = EXCLUDED.last_closed_day`,
        );
        await q.query(
          `INSERT INTO usage_daily (project_id, owner_id, day, metric, value) VALUES ($1, $2, '2031-06-14', 'mau_month_to_date', 150)`,
          [randomUUID(), a.id],
        );

        const after: AdminBillingSummary = await service.summary(NOW, q);

        // Recurring: A, B, D (comped, still charged) and F monthly, C yearly; E halted and K
        // (comped, its subscription ended) are not paying.
        const arrNet = 4 * 99900 * 12 + 999000;
        const arrGross = 4 * 117882 * 12 + 1178820;
        expect(delta(after.arr, before.arr)).toEqual({ netPaise: arrNet, grossPaise: arrGross, taxPaise: arrGross - arrNet });
        expect(after.mrr.netPaise).toBe(Math.floor(after.arr.netPaise / 12));
        expect(after.mrr.grossPaise).toBe(Math.floor(after.arr.grossPaise / 12));
        expect(after.mrr.taxPaise).toBe(after.mrr.grossPaise - after.mrr.netPaise);
        expect(after.byPlan.find((row) => row.planCode === p.code)).toEqual({
          planCode: p.code,
          planName: 'Scratch',
          accounts: 5,
          mrrNetPaise: Math.floor(arrNet / 12),
        });

        // Kept: A's payment, B's less its refund, G's orphan charge; the failure is nothing.
        const keptGross = 117882 + 100000 + 117882;
        const keptNet = 99900 + netOfTax(100000, 1800) + 99900;
        expect(delta(after.revenue30d, before.revenue30d)).toEqual({ netPaise: keptNet, grossPaise: keptGross, taxPaise: keptGross - keptNet });
        expect(after.revenueByMonth.map((m) => m.month)).toEqual([
          '2030-07', '2030-08', '2030-09', '2030-10', '2030-11', '2030-12',
          '2031-01', '2031-02', '2031-03', '2031-04', '2031-05', '2031-06',
        ]);
        const month = (s: AdminBillingSummary, m: string) => s.revenueByMonth.find((row) => row.month === m)!;
        expect(delta(month(after, '2031-06'), month(before, '2031-06'))).toEqual({ netPaise: keptNet, grossPaise: keptGross, taxPaise: keptGross - keptNet });
        expect(delta(month(after, '2031-05'), month(before, '2031-05'))).toEqual({ netPaise: 99900, grossPaise: 117882, taxPaise: 17982 });

        expect(after.pastDue.filter((row) => [e.id, f.id].includes(row.tenantId))).toEqual([
          { tenantId: e.id, email: e.email, status: 'halted', since: new Date(NOW.getTime() - 3 * DAY - 3600_000).toISOString(), daysOverdue: 3, graceUntil: graceUntil.toISOString() },
          { tenantId: f.id, email: f.email, status: 'pending', since: new Date(NOW.getTime() - DAY - 60_000).toISOString(), daysOverdue: 1, graceUntil: null },
        ]);
        expect(after.recentPayments.find((row) => row.id === orphan)).toMatchObject({ tenantId: g.id, orphan: true, netPaise: 99900 });
        expect(after.recentPayments.filter((row) => row.tenantId === a.id).map((row) => row.orphan)).toEqual([false, false]);
        expect(after.recentFailures.find((row) => row.id === failed)).toMatchObject({
          tenantId: c.id,
          status: 'failed',
          failureReason: 'payment_failed',
          netPaise: 0,
        });
        expect(after.recentFailures.every((row) => row.status === 'failed')).toBe(true);
        expect(after.comped.filter((row) => [d.id, k.id].includes(row.tenantId))).toEqual([
          { tenantId: d.id, email: d.email, planCode: p.code, until: null, reason: 'partner', paying: true },
          { tenantId: k.id, email: k.email, planCode: p.code, until: null, reason: 'trial', paying: false },
        ]);
        expect(after.cancelling - before.cancelling).toBe(1);
        expect(after.outboxErrors.find((row) => row.subscriptionId === subH.id)).toEqual({
          subscriptionId: subH.id,
          tenantId: h.id,
          error: 'Billing provider answered 500',
          attempts: 3,
        });
        expect(after.overMau.find((row) => row.tenantId === a.id)).toEqual({ tenantId: a.id, email: a.email, planCode: p.code, mau: 150, limit: 100 });
      });
    });

    it('answers over HTTP with twelve months', async () => {
      const res = await call(on, 'GET', '/billing/summary');
      expect(res.status).toBe(200);
      expect((res.data as AdminBillingSummary).revenueByMonth).toHaveLength(12);
    });
  });

  // ------------------------------------------------------------------ tenant billing and actions

  describe('comp', () => {
    it('gives a plan with its audit row, refuses one over a live subscription, and ends it', async () => {
      const p = await plan();
      const t = await user();
      const res = await call(on, 'POST', `/tenants/${t.id}/billing/comp`, { planCode: p.code, reason: REASON });
      expect(res.status).toBe(200);
      expect((res.data as AdminTenantBilling).comp).toMatchObject({ planCode: p.code, until: null, reason: REASON, byEmail: staff.email });
      expect((res.data as AdminTenantBilling).overview).toMatchObject({ state: 'comped', effectivePlan: { code: p.code, source: 'comp' } });
      expect(await auditOf('billing.comp_granted', t.id)).toEqual([
        { actor_id: staff.id, target_type: 'tenant', target_label: t.email, reason: REASON, metadata: { planCode: p.code, until: null } },
      ]);
      expect(((await call(on, 'GET', `/tenants/${t.id}`)).data as AdminTenantDetail).plan).toBe(p.code);

      const ended = await call(on, 'POST', `/tenants/${t.id}/billing/comp/end`, { reason: REASON });
      expect(ended.status).toBe(200);
      expect((ended.data as AdminTenantBilling).comp).toBeNull();
      expect((await auditOf('billing.comp_ended', t.id)).map((r: { metadata: unknown }) => r.metadata)).toEqual([
        { planCode: p.code, until: null },
      ]);
      expect(((await call(on, 'GET', `/tenants/${t.id}`)).data as AdminTenantDetail).plan).toBe('free');
      const again = await call(on, 'POST', `/tenants/${t.id}/billing/comp/end`, { reason: REASON });
      expect([again.status, again.message]).toEqual([409, JSON.stringify('This account has no comp.')]);
    });

    it('refuses a comp over a live or authorised subscription', async () => {
      const p = await plan();
      const live = await user();
      await subscription(ds, live.id, p);
      const res = await call(on, 'POST', `/tenants/${live.id}/billing/comp`, { planCode: p.code, reason: REASON });
      expect([res.status, res.message]).toEqual([409, JSON.stringify('This account has a subscription. Cancel it first.')]);

      const waiting = await user();
      const next = await subscription(ds, waiting.id, p, { status: 'authenticated', current: false });
      await ds.query(`INSERT INTO billing_accounts (user_id, next_subscription_id) VALUES ($1, $2)`, [waiting.id, next.id]);
      expect((await call(on, 'POST', `/tenants/${waiting.id}/billing/comp`, { planCode: p.code, reason: REASON })).status).toBe(409);
      expect(await auditOf('billing.comp_granted', live.id)).toEqual([]);
      expect(await auditOf('billing.comp_granted', waiting.id)).toEqual([]);
    });

    it('refuses an unknown, inactive or free plan, and an end in the past or past five years', async () => {
      const t = await user();
      const p = await plan();
      const inactive = await plan();
      await ds.query(`UPDATE plans SET is_active = false WHERE code = $1`, [inactive.code]);
      for (const planCode of ['plan_scratch_nothere', inactive.code, 'free']) {
        const res = await call(on, 'POST', `/tenants/${t.id}/billing/comp`, { planCode, reason: REASON });
        expect([planCode, res.status, res.message]).toEqual([planCode, 400, JSON.stringify('That plan does not exist.')]);
      }
      for (const until of [new Date(Date.now() - 60_000), new Date(Date.now() + 6 * 365 * DAY)]) {
        const res = await call(on, 'POST', `/tenants/${t.id}/billing/comp`, { planCode: p.code, until: until.toISOString(), reason: REASON });
        expect(res.status).toBe(400);
      }
      const until = new Date(Date.now() + 30 * DAY);
      const ok = await call(on, 'POST', `/tenants/${t.id}/billing/comp`, { planCode: p.code, until: until.toISOString(), reason: REASON });
      expect((ok.data as AdminTenantBilling).comp?.until).toBe(until.toISOString());
    });

    it('an expired comp is the free plan, with no job to end it', async () => {
      const p = await plan();
      const t = await user();
      await ds.query(
        `INSERT INTO billing_accounts (user_id, comp_plan_code, comp_until, comp_reason) VALUES ($1, $2, $3, 'trial')`,
        [t.id, p.code, new Date(Date.now() - 60_000)],
      );
      expect(((await call(on, 'GET', `/tenants/${t.id}`)).data as AdminTenantDetail).plan).toBe('free');
      expect(((await call(on, 'GET', `/tenants/${t.id}/billing`)).data as AdminTenantBilling).overview.effectivePlan.code).toBe('free');
    });

    it('writes the comp and its audit row in one transaction', async () => {
      const p = await plan();
      const t = await user();
      const failing = new AdminBillingService(
        ds,
        { record: async () => Promise.reject(new Error('audit down')) } as unknown as AdminAuditService,
        on.app.get(BillingOverviewService),
        fake,
        on.app.get(BillingOutboxService),
      );
      await expect(
        failing.comp(t.id, { planCode: p.code, reason: REASON }, { userId: staff.id, email: staff.email, ipAddress: '' }),
      ).rejects.toThrow('audit down');
      const [row] = await ds.query(`SELECT comp_plan_code FROM billing_accounts WHERE user_id = $1`, [t.id]);
      expect(row?.comp_plan_code ?? null).toBeNull();
    });
  });

  describe('cancel', () => {
    it('cancels at the provider once, records it, and refuses again', async () => {
      const p = await plan();
      const t = await user();
      const sub = await subscription(ds, t.id, p);
      fake.setSubscription({
        id: sub.providerId,
        planId: 'plan_x',
        customerId: null,
        status: 'active',
        currentStart: null,
        currentEnd: null,
        startAt: null,
        chargeAt: null,
        endedAt: null,
        paidCount: 1,
        shortUrl: null,
      });
      const res = await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: true, reason: REASON });
      expect(res.status).toBe(200);
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === sub.providerId)).toEqual([[sub.providerId, true]]);
      const [row] = await ds.query(
        `SELECT cancel_at_period_end, cancel_at_cycle_end, cancel_requested_by, cancel_sent_at IS NOT NULL AS sent
           FROM billing_subscriptions WHERE id = $1`,
        [sub.id],
      );
      expect(row).toEqual({ cancel_at_period_end: true, cancel_at_cycle_end: true, cancel_requested_by: staff.id, sent: true });
      expect((await auditOf('billing.subscription_cancelled', t.id)).map((r: { metadata: unknown }) => r.metadata)).toEqual([
        { subscriptionId: sub.id, atCycleEnd: true },
      ]);

      const again = await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: true, reason: REASON });
      expect([again.status, again.message]).toEqual([409, JSON.stringify('The subscription already ends at the period end.')]);
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === sub.providerId)).toHaveLength(1);

      const none = await user();
      const nothing = await call(on, 'POST', `/tenants/${none.id}/billing/cancel`, { atCycleEnd: false, reason: REASON });
      expect([nothing.status, nothing.message]).toEqual([409, JSON.stringify('There is no subscription to cancel.')]);
      expect((await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: 'false', reason: REASON })).status).toBe(400);
    });
  });

  describe('cancel: the other paths', () => {
    const providerSub = (id: string, status: 'active' | 'authenticated' | 'created') =>
      fake.setSubscription({
        id,
        planId: 'plan_x',
        customerId: null,
        status,
        currentStart: null,
        currentEnd: null,
        startAt: null,
        chargeAt: null,
        endedAt: null,
        paidCount: status === 'active' ? 1 : 0,
        shortUrl: null,
      });
    const cancelColumns = (id: string) =>
      ds
        .query(
          `SELECT cancel_at_period_end, cancel_at_cycle_end, cancel_requested_at IS NOT NULL AS requested,
                  cancel_requested_by, cancel_sent_at IS NOT NULL AS sent
             FROM billing_subscriptions WHERE id = $1`,
          [id],
        )
        .then((rows: unknown[]) => rows[0]);
    const pointers = (userId: string) =>
      ds
        .query(`SELECT current_subscription_id, next_subscription_id FROM billing_accounts WHERE user_id = $1`, [userId])
        .then((rows: unknown[]) => rows[0]);
    const untouched = {
      cancel_at_period_end: false,
      cancel_at_cycle_end: null,
      requested: false,
      cancel_requested_by: null,
      sent: false,
    };

    it.each(['authenticated', 'created'] as const)(
      'queues a waiting %s successor for the outbox to cancel at once, and drops it from the account',
      async (nextStatus) => {
        const p = await plan();
        const t = await user();
        const current = await subscription(ds, t.id, p);
        providerSub(current.providerId, 'active');
        const next = await subscription(ds, t.id, p, { status: nextStatus, current: false, wasCurrent: false });
        providerSub(next.providerId, nextStatus);
        await ds.query(`UPDATE billing_accounts SET next_subscription_id = $2 WHERE user_id = $1`, [t.id, next.id]);

        const res = await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: true, reason: REASON });
        expect(res.status).toBe(200);
        // Only the current one is cancelled by the request; the successor goes to the outbox.
        expect(fake.callsOf('cancelSubscription').filter(([id]) => id === next.providerId)).toEqual([]);
        expect(await cancelColumns(next.id)).toEqual({
          cancel_at_period_end: false,
          cancel_at_cycle_end: false,
          requested: true,
          cancel_requested_by: staff.id,
          sent: false,
        });
        expect(await pointers(t.id)).toEqual({ current_subscription_id: current.id, next_subscription_id: null });
        expect((res.data as AdminTenantBilling).overview.next).toBeNull();

        await parkOtherOutboxRows(ds, [t.id]);
        expect(await new BillingOutboxService(ds, fake).runOnce()).toBe(1);
        expect(fake.callsOf('cancelSubscription').filter(([id]) => id === next.providerId)).toEqual([[next.providerId, false]]);
        expect(await cancelColumns(next.id)).toMatchObject({ sent: true, cancel_at_period_end: false });
      },
    );

    it('cancels a live subscription at once without marking it as ending at the period end', async () => {
      const p = await plan();
      const t = await user();
      const sub = await subscription(ds, t.id, p);
      providerSub(sub.providerId, 'active');

      const res = await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: false, reason: REASON });
      expect(res.status).toBe(200);
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === sub.providerId)).toEqual([[sub.providerId, false]]);
      expect(await cancelColumns(sub.id)).toEqual({
        cancel_at_period_end: false,
        cancel_at_cycle_end: false,
        requested: true,
        cancel_requested_by: staff.id,
        sent: true,
      });
      expect((await auditOf('billing.subscription_cancelled', t.id)).map((r: { metadata: unknown }) => r.metadata)).toEqual([
        { subscriptionId: sub.id, atCycleEnd: false },
      ]);
    });

    it('answers 502 when the provider refuses, keeps the decision and its audit row, and the worker sends it', async () => {
      const p = await plan();
      const t = await user();
      const sub = await subscription(ds, t.id, p);
      providerSub(sub.providerId, 'active');
      fake.failNext('cancelSubscription', new BillingProviderError(400, 'BAD_REQUEST_ERROR', 'Something went wrong'));

      const res = await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: true, reason: REASON });
      expect([res.status, res.message]).toEqual([
        502,
        JSON.stringify('Razorpay could not cancel the subscription yet. The cancel is recorded and will be retried.'),
      ]);
      expect(await cancelColumns(sub.id)).toEqual({
        cancel_at_period_end: false,
        cancel_at_cycle_end: true,
        requested: true,
        cancel_requested_by: staff.id,
        sent: false,
      });
      const [{ cancel_error }] = await ds.query(`SELECT cancel_error FROM billing_subscriptions WHERE id = $1`, [sub.id]);
      expect(cancel_error).toContain('400');
      expect((await auditOf('billing.subscription_cancelled', t.id)).map((r: { metadata: unknown }) => r.metadata)).toEqual([
        { subscriptionId: sub.id, atCycleEnd: true },
      ]);

      await parkOtherOutboxRows(ds, [t.id]);
      expect(await new BillingOutboxService(ds, fake).runOnce(new Date(Date.now() + 10 * 60_000))).toBe(1);
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === sub.providerId)).toEqual([
        [sub.providerId, true],
        [sub.providerId, true],
      ]);
      expect(await cancelColumns(sub.id)).toMatchObject({ sent: true, cancel_at_period_end: true });
    });

    it('records the cancel and its audit row before the provider is called, so a change meanwhile loses neither', async () => {
      const p = await plan();
      const t = await user();
      const sub = await subscription(ds, t.id, p);
      providerSub(sub.providerId, 'active');
      const replacement = await subscription(ds, t.id, p, { current: false });
      let seenAtCall: unknown[] = [];
      const spy = jest.spyOn(fake, 'cancelSubscription').mockImplementationOnce(async (id, atCycleEnd) => {
        seenAtCall = await auditOf('billing.subscription_cancelled', t.id);
        // A webhook makes another subscription current while the request is at the provider.
        await ds.query(`UPDATE billing_accounts SET current_subscription_id = $2 WHERE user_id = $1`, [t.id, replacement.id]);
        return FakeBillingProvider.prototype.cancelSubscription.call(fake, id, atCycleEnd);
      });
      try {
        const res = await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: false, reason: REASON });
        expect(res.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
      expect(seenAtCall.map((r) => (r as { metadata: unknown }).metadata)).toEqual([
        { subscriptionId: sub.id, atCycleEnd: false },
      ]);
      expect(await cancelColumns(sub.id)).toEqual({
        cancel_at_period_end: false,
        cancel_at_cycle_end: false,
        requested: true,
        cancel_requested_by: staff.id,
        sent: true,
      });
      expect(await cancelColumns(replacement.id)).toEqual(untouched);
    });

    it('two staff cancelling at once reach the provider once, and the second is refused', async () => {
      const p = await plan();
      const t = await user();
      const sub = await subscription(ds, t.id, p);
      providerSub(sub.providerId, 'active');
      const both = await Promise.all([
        call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: false, reason: REASON }),
        call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: false, reason: REASON }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(both.find((r) => r.status === 409)?.message).toBe(
        JSON.stringify('A cancel for this subscription is already on its way.'),
      );
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === sub.providerId)).toEqual([[sub.providerId, false]]);
      expect(await auditOf('billing.subscription_cancelled', t.id)).toHaveLength(1);
    });

    it('calls no provider when the decision cannot be recorded', async () => {
      const p = await plan();
      const t = await user();
      const sub = await subscription(ds, t.id, p);
      providerSub(sub.providerId, 'active');
      const failing = new AdminBillingService(
        ds,
        { record: async () => Promise.reject(new Error('audit down')) } as unknown as AdminAuditService,
        on.app.get(BillingOverviewService),
        fake,
        on.app.get(BillingOutboxService),
      );
      await expect(
        failing.cancel(t.id, { atCycleEnd: false, reason: REASON }, { userId: staff.id, email: staff.email, ipAddress: '' }),
      ).rejects.toThrow('audit down');
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === sub.providerId)).toEqual([]);
      expect(await cancelColumns(sub.id)).toEqual(untouched);
    });

    it('turns a queued cycle-end cancel into an immediate one, and refuses a second cycle-end', async () => {
      const p = await plan();
      const t = await user();
      const sub = await subscription(ds, t.id, p);
      providerSub(sub.providerId, 'active');
      // The worker's cycle-end cancel after an authorised change, not yet sent.
      await ds.query(
        `UPDATE billing_subscriptions SET cancel_requested_at = now(), cancel_at_cycle_end = true WHERE id = $1`,
        [sub.id],
      );
      const ending = await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: true, reason: REASON });
      expect([ending.status, ending.message]).toEqual([409, JSON.stringify('The subscription already ends at the period end.')]);
      const now = await call(on, 'POST', `/tenants/${t.id}/billing/cancel`, { atCycleEnd: false, reason: REASON });
      expect(now.status).toBe(200);
      expect(fake.callsOf('cancelSubscription').filter(([id]) => id === sub.providerId)).toEqual([[sub.providerId, false]]);
      expect(await cancelColumns(sub.id)).toMatchObject({ cancel_at_cycle_end: false, sent: true });
    });
  });

  describe('resend invoice', () => {
    it("resends the tenant's own invoice, and another tenant's is not found", async () => {
      const owner = await user();
      const other = await user();
      const providerInvoiceId = `inv_${hex(7)}`;
      const [invoice] = await ds.query(
        `INSERT INTO billing_invoices (provider_invoice_id, user_id, status, amount_paise, tax_paise, provider_tax_paise, currency)
         VALUES ($1, $2, 'issued', 117882, 17982, 0, 'INR') RETURNING id`,
        [providerInvoiceId, owner.id],
      );
      fake.addInvoice({
        id: providerInvoiceId,
        subscriptionId: null,
        customerId: null,
        paymentId: null,
        status: 'issued',
        amountPaise: 117882,
        providerTaxPaise: 0,
        currency: 'INR',
        billingStart: null,
        billingEnd: null,
        issuedAt: null,
        paidAt: null,
        shortUrl: null,
        number: null,
      });

      const wrong = await call(on, 'POST', `/tenants/${other.id}/billing/invoices/${invoice.id}/resend`, { reason: REASON });
      expect(wrong.status).toBe(404);
      expect(fake.callsOf('notifyInvoiceByEmail').filter(([id]) => id === providerInvoiceId)).toEqual([]);

      const ok = await call(on, 'POST', `/tenants/${owner.id}/billing/invoices/${invoice.id}/resend`, { reason: REASON });
      expect([ok.status, ok.data]).toEqual([200, { resent: true }]);
      expect(fake.callsOf('notifyInvoiceByEmail').filter(([id]) => id === providerInvoiceId)).toEqual([[providerInvoiceId]]);
      expect((await auditOf('billing.invoice_resent', owner.id)).map((r: { metadata: unknown }) => r.metadata)).toEqual([
        { invoiceId: invoice.id },
      ]);
    });
  });

  it('refuses every write without a recent sign-in', async () => {
    const p = await plan();
    const t = await user();
    const id = randomUUID();
    for (const [path, body] of [
      [`/tenants/${t.id}/billing/comp`, { planCode: p.code, reason: REASON }],
      [`/tenants/${t.id}/billing/comp/end`, { reason: REASON }],
      [`/tenants/${t.id}/billing/cancel`, { atCycleEnd: true, reason: REASON }],
      [`/tenants/${t.id}/billing/invoices/${id}/resend`, { reason: REASON }],
    ] as const) {
      const res = await call(on, 'POST', path, body, staleToken);
      expect([path, res.status, res.message]).toEqual([path, 403, JSON.stringify(REAUTH_REQUIRED_MESSAGE)]);
    }
    expect(await auditOf('billing.comp_granted', t.id)).toEqual([]);
  });

  it('records one tenant view for the tenant page and its billing together', async () => {
    const viewer = await newStaff();
    const viewerToken = (await issueStaffSessionForTest(ds, viewer)).accessToken;
    const t = await user();
    expect((await call(on, 'GET', `/tenants/${t.id}`, undefined, viewerToken)).status).toBe(200);
    const billing = await call(on, 'GET', `/tenants/${t.id}/billing`, undefined, viewerToken);
    expect(billing.status).toBe(200);
    expect(Object.keys((billing.data as AdminTenantBilling).overview)).not.toEqual(expect.arrayContaining(['plans']));
    expect((billing.data as AdminTenantBilling).overview).not.toHaveProperty('keyId');
    expect((await call(on, 'GET', `/tenants/${t.id}/billing`, undefined, viewerToken)).status).toBe(200);
    const views = await ds.query(
      `SELECT count(*)::int AS n FROM admin_audit_logs WHERE action = 'tenant.viewed' AND actor_id = $1 AND target_id = $2`,
      [viewer.id, t.id],
    );
    expect(views[0].n).toBe(1);
    expect((await call(on, 'GET', `/tenants/${randomUUID()}/billing`)).status).toBe(404);
  });

  it('lists and exports tenants by effective plan', async () => {
    const p = await plan();
    const t1 = await user();
    const t2 = await user();
    const t3 = await user();
    for (const t of [t1, t2]) {
      await ds.query(`INSERT INTO billing_accounts (user_id, comp_plan_code, comp_reason) VALUES ($1, $2, 'x')`, [t.id, p.code]);
    }
    await subscription(ds, t3.id, p);
    const list = await call(on, 'GET', `/tenants?plan=${p.code}&limit=100`);
    expect(list.status).toBe(200);
    expect((list.data as AdminTenantSummary[]).map((row) => row.id).sort()).toEqual([t1.id, t2.id, t3.id].sort());
    expect((list.data as AdminTenantSummary[]).every((row) => row.plan === p.code)).toBe(true);
    expect(list.meta.total).toBe(3);
    const free = await call(on, 'GET', `/tenants?search=${encodeURIComponent(t1.email.split('@')[0])}`);
    expect((free.data as AdminTenantSummary[]).map((row) => row.plan)).toEqual([p.code]);
    expect((await call(on, 'GET', '/tenants?plan=Not-A-Code')).status).toBe(400);

    const csv = await call(on, 'GET', `/tenants/export?plan=${p.code}`);
    expect(csv.status).toBe(200);
    const [header, ...rows] = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    const col = header.split(',').indexOf('plan');
    expect(col).toBeGreaterThan(-1);
    expect(rows.map((r) => r.split(',')[col])).toEqual([p.code, p.code, p.code]);
  });

  it('with billing off, every billing route is 404 and every tenant is on the free plan', async () => {
    const p = await plan();
    const t = await user();
    await ds.query(`INSERT INTO billing_accounts (user_id, comp_plan_code, comp_reason) VALUES ($1, $2, 'x')`, [t.id, p.code]);
    const offToken = token;
    const routes = listRoutes(off.app).filter((r) => r.path.startsWith('/api/admin/') && r.path.includes('/billing'));
    expect(routes.map((r) => r.key).sort()).toEqual(
      [
        'GET /api/admin/billing/summary',
        'GET /api/admin/tenants/:id/billing',
        'POST /api/admin/tenants/:id/billing/comp',
        'POST /api/admin/tenants/:id/billing/comp/end',
        'POST /api/admin/tenants/:id/billing/cancel',
        'POST /api/admin/tenants/:id/billing/invoices/:invoiceId/resend',
      ].sort(),
    );
    for (const route of routes) {
      const path = route.path.replace('/api/admin', '').replace(':id', t.id).replace(':invoiceId', randomUUID());
      const res = await call(off, route.method, path, route.method === 'GET' ? undefined : { planCode: p.code, reason: REASON }, offToken);
      expect([route.key, res.status]).toEqual([route.key, 404]);
    }
    const list = await call(off, 'GET', `/tenants?search=${encodeURIComponent(t.email.split('@')[0])}`, undefined, offToken);
    expect((list.data as AdminTenantSummary[]).map((row) => row.plan)).toEqual(['free']);
    expect((await call(off, 'GET', `/tenants?plan=${p.code}`, undefined, offToken)).meta.total).toBe(0);
    expect(((await call(off, 'GET', `/tenants/${t.id}`, undefined, offToken)).data as AdminTenantDetail).plan).toBe('free');
  });
});

import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { AdminPlan } from '@chumbaq/shared';
import type { BillingConfig } from '../../config/billing.config';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { FakeBillingProvider } from '../../test-support/fake-billing-provider';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { AccountLimitsService } from '../billing/account-limits.service';
import { BILLING_PROVIDER } from '../billing/providers/billing-provider';

const KEY_ID = 'rzp_test_PlansAdmin01';
const DOMAIN = '@admin-plans-int.test';
const REASON = 'set up for the launch';

/**
 * The staff plan routes on the booted admin API: real staff sessions, guards and
 * validation, Postgres, and the in-memory provider standing in for Razorpay's plans.
 * A second admin API booted without keys is a self-hosted install: plans still
 * edit, prices do not exist.
 */
describe('admin plans API (integration)', () => {
  let ds: DataSource;
  let on: BootedApp;
  let off: BootedApp;
  let fake: FakeBillingProvider;
  let staff: { id: string; email: string; sessionVersion: number };
  let token: string;
  let staleToken: string;
  const created: string[] = [];
  const hex = (bytes = 6) => randomBytes(bytes).toString('hex');
  const rzpPlanId = () => `plan_${hex(7)}`;

  beforeAll(async () => {
    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = 'test_key_secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
    ds = await openIntDb();
    fake = new FakeBillingProvider({ keyId: KEY_ID });
    on = await bootIntApp('admin', { providers: [{ token: BILLING_PROVIDER, useValue: fake }] });
    expect(on.app.get(ConfigService).get<BillingConfig>('billing')?.enabled).toBe(true);
    process.env.RAZORPAY_KEY_ID = '';
    process.env.RAZORPAY_KEY_SECRET = '';
    process.env.RAZORPAY_WEBHOOK_SECRET = '';
    off = await bootIntApp('admin');
    expect(off.app.get(ConfigService).get<BillingConfig>('billing')?.enabled).toBe(false);

    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    const [row] = await ds.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin)
       VALUES ($1, 'x', 'Staff', true) RETURNING id, email, session_version`,
      [`staff-${hex(3)}${DOMAIN}`],
    );
    staff = { id: row.id, email: row.email, sessionVersion: row.session_version };
    token = (await issueStaffSessionForTest(ds, staff)).accessToken;
    staleToken = (await issueStaffSessionForTest(ds, staff, { authTime: new Date(Date.now() - 3600_000) })).accessToken;
  }, 120000);

  afterAll(async () => {
    await on?.app.close();
    await off?.app.close();
    if (created.length) {
      await ds.query(`DELETE FROM plan_prices WHERE plan_code = ANY($1)`, [created]);
      await ds.query(`DELETE FROM plans WHERE code = ANY($1)`, [created]);
    }
    await ds.query(`DELETE FROM admin_audit_logs WHERE actor_id = $1`, [staff.id]);
    await ds.query(`DELETE FROM staff_sessions WHERE user_id = $1`, [staff.id]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
  });

  async function call(app: BootedApp, method: string, path: string, body?: unknown, bearer = token) {
    const res = await fetch(`${app.base}/api/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: any; message?: unknown };
    return { status: res.status, data: json.data, message: JSON.stringify(json.message ?? '') };
  }

  const auditOf = (action: string, label: string) =>
    ds.query(
      `SELECT target_type, target_id, target_label, reason, metadata FROM admin_audit_logs
        WHERE actor_id = $1 AND action = $2 AND target_label = $3 ORDER BY created_at, id`,
      [staff.id, action, label],
    );

  async function newPlan(over: Record<string, unknown> = {}): Promise<string> {
    const code = `plan_scratch_${hex()}`;
    created.push(code);
    const res = await call(on, 'POST', '/plans', {
      code,
      name: 'Scratch',
      mauLimit: 5000,
      projectLimit: 3,
      seatLimit: null,
      sortOrder: 10,
      reason: REASON,
      ...over,
    });
    expect(res.status).toBe(201);
    return code;
  }

  const priceRows = (code: string) =>
    ds.query(
      `SELECT interval, price_paise, amount_paise, tax_rate_bps, razorpay_plan_id, is_current, created_by
         FROM plan_prices WHERE plan_code = $1 ORDER BY created_at, id`,
      [code],
    );

  it('creates a plan and records its limits', async () => {
    const code = `plan_scratch_${hex()}`;
    created.push(code);
    const res = await call(on, 'POST', '/plans', {
      code,
      name: 'Scratch',
      mauLimit: 5000,
      projectLimit: 3,
      seatLimit: null,
      sortOrder: 10,
      reason: REASON,
    });
    expect(res.status).toBe(201);
    expect(res.data as AdminPlan).toEqual({
      code,
      name: 'Scratch',
      mauLimit: 5000,
      projectLimit: 3,
      seatLimit: null,
      sortOrder: 10,
      isActive: true,
      prices: [],
      billingEnabled: true,
      defaults: on.app.get(AccountLimitsService).envLimits(),
    });
    expect(typeof (res.data as AdminPlan).defaults.projectLimit).toBe('number');
    expect(await auditOf('billing.plan_created', code)).toEqual([
      {
        target_type: 'plan',
        target_id: null,
        target_label: code,
        reason: REASON,
        metadata: { code, limits: { mauLimit: 5000, projectLimit: 3, seatLimit: null }, sortOrder: 10 },
      },
    ]);
    // The same code again is a conflict, and writes nothing more.
    const again = await call(on, 'POST', '/plans', { code, name: 'Other', mauLimit: null, projectLimit: null, seatLimit: null, sortOrder: 1, reason: REASON });
    expect([again.status, again.message]).toEqual([409, JSON.stringify('A plan with that code already exists.')]);
    expect(await auditOf('billing.plan_created', code)).toHaveLength(1);
  });

  it('patches only the fields sent, recording before and after of what changed', async () => {
    const code = await newPlan();
    const res = await call(on, 'PATCH', `/plans/${code}`, { mauLimit: 25000, name: 'Scratch', reason: REASON });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ code, name: 'Scratch', mauLimit: 25000, projectLimit: 3, sortOrder: 10 });
    expect((await auditOf('billing.plan_updated', code)).map((r: { metadata: unknown }) => r.metadata)).toEqual([
      { before: { mauLimit: 5000 }, after: { mauLimit: 25000 } },
    ]);

    // Clearing a limit is null; a body that changes nothing records nothing.
    expect((await call(on, 'PATCH', `/plans/${code}`, { seatLimit: null, reason: REASON })).status).toBe(200);
    expect((await call(on, 'PATCH', `/plans/${code}`, { projectLimit: null, isActive: false, reason: REASON })).data).toMatchObject({
      projectLimit: null,
      isActive: false,
    });
    expect((await auditOf('billing.plan_updated', code)).map((r: { metadata: unknown }) => r.metadata)).toEqual([
      { before: { mauLimit: 5000 }, after: { mauLimit: 25000 } },
      { before: { projectLimit: 3, isActive: true }, after: { projectLimit: null, isActive: false } },
    ]);
  });

  it('refuses bad patches', async () => {
    const code = await newPlan();
    const free = await call(on, 'PATCH', '/plans/free', { isActive: false, reason: REASON });
    expect([free.status, free.message]).toEqual([400, JSON.stringify('The Free plan is always available.')]);
    expect((await call(on, 'PATCH', `/plans/${code}`, { name: null, reason: REASON })).status).toBe(400);
    expect((await call(on, 'PATCH', `/plans/${code}`, { projectLimit: 1001, reason: REASON })).status).toBe(400);
    expect((await call(on, 'PATCH', `/plans/${code}`, { mauLimit: 0, reason: REASON })).status).toBe(400);
    expect((await call(on, 'PATCH', `/plans/${code}`, { mauLimit: 10 })).status).toBe(400);
    expect((await call(on, 'PATCH', `/plans/plan_scratch_missing${hex(2)}`, { mauLimit: 10, reason: REASON })).status).toBe(404);
  });

  it('adds a price only when the Razorpay plan charges exactly the price with GST', async () => {
    const code = await newPlan();
    const offByOne = rzpPlanId();
    fake.seedPlan({ id: offByOne, period: 'monthly', interval: 1, amountPaise: 117881, currency: 'INR' });
    const refused = await call(on, 'POST', `/plans/${code}/prices`, {
      interval: 'monthly',
      pricePaise: 99900,
      razorpayPlanId: offByOne,
      reason: REASON,
    });
    expect(refused.status).toBe(400);
    expect(refused.message).toBe(
      JSON.stringify('That Razorpay plan charges ₹1,178.81 every 1 month, not ₹1,178.82 a month.'),
    );
    expect(await priceRows(code)).toEqual([]);

    const first = rzpPlanId();
    fake.seedPlan({ id: first, period: 'monthly', interval: 1, amountPaise: 117882, currency: 'INR' });
    const ok = await call(on, 'POST', `/plans/${code}/prices`, {
      interval: 'monthly',
      pricePaise: 99900,
      razorpayPlanId: first,
      reason: REASON,
    });
    expect(ok.status).toBe(201);
    const firstPrice = (ok.data as AdminPlan).prices[0];
    expect(firstPrice).toMatchObject({
      interval: 'monthly',
      pricePaise: 99900,
      taxPaise: 17982,
      amountPaise: 117882,
      taxRateBps: 1800,
      razorpayPlanId: first,
      isCurrent: true,
      subscribers: 0,
    });

    // A second price replaces the first as current; the first keeps its Razorpay plan.
    const second = rzpPlanId();
    fake.seedPlan({ id: second, period: 'monthly', interval: 1, amountPaise: 141600, currency: 'INR' });
    const replaced = await call(on, 'POST', `/plans/${code}/prices`, {
      interval: 'monthly',
      pricePaise: 120000,
      razorpayPlanId: second,
      reason: REASON,
    });
    expect(replaced.status).toBe(201);
    expect(await priceRows(code)).toEqual([
      { interval: 'monthly', price_paise: 99900, amount_paise: 117882, tax_rate_bps: 1800, razorpay_plan_id: first, is_current: false, created_by: staff.id },
      { interval: 'monthly', price_paise: 120000, amount_paise: 141600, tax_rate_bps: 1800, razorpay_plan_id: second, is_current: true, created_by: staff.id },
    ]);
    const plan = replaced.data as AdminPlan;
    expect(plan.prices.map((p) => [p.razorpayPlanId, p.isCurrent])).toEqual([
      [second, true],
      [first, false],
    ]);
    expect((await auditOf('billing.price_added', code)).map((r: { metadata: any }) => r.metadata)).toEqual([
      {
        planCode: code,
        interval: 'monthly',
        pricePaise: 99900,
        amountPaise: 117882,
        taxRateBps: 1800,
        razorpayPlanId: first,
        replacedPriceId: null,
      },
      {
        planCode: code,
        interval: 'monthly',
        pricePaise: 120000,
        amountPaise: 141600,
        taxRateBps: 1800,
        razorpayPlanId: second,
        replacedPriceId: firstPrice.id,
      },
    ]);

    // The same Razorpay plan cannot back a second price.
    const reused = await call(on, 'POST', `/plans/${code}/prices`, {
      interval: 'monthly',
      pricePaise: 120000,
      razorpayPlanId: second,
      reason: REASON,
    });
    expect([reused.status, reused.message]).toEqual([409, JSON.stringify('That Razorpay plan already backs a price.')]);
  });

  it('refuses a Razorpay plan of the wrong period, currency or interval count, or one it does not have', async () => {
    const code = await newPlan();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ period: 'monthly', interval: 1 }, 'That Razorpay plan charges ₹11,788.20 every 1 month, not ₹11,788.20 a year.'],
      [{ period: 'yearly', interval: 2 }, 'That Razorpay plan charges ₹11,788.20 every 2 years, not ₹11,788.20 a year.'],
      [{ period: 'yearly', interval: 1, currency: 'USD' }, 'That Razorpay plan charges USD 11,788.20 every 1 year, not ₹11,788.20 a year.'],
    ];
    for (const [over, message] of cases) {
      const id = rzpPlanId();
      fake.seedPlan({ id, period: 'yearly', interval: 1, amountPaise: 1178820, currency: 'INR', ...over });
      const res = await call(on, 'POST', `/plans/${code}/prices`, { interval: 'yearly', pricePaise: 999000, razorpayPlanId: id, reason: REASON });
      expect([res.status, res.message]).toEqual([400, JSON.stringify(message)]);
    }
    const unknown = await call(on, 'POST', `/plans/${code}/prices`, {
      interval: 'yearly',
      pricePaise: 999000,
      razorpayPlanId: rzpPlanId(),
      reason: REASON,
    });
    expect([unknown.status, unknown.message]).toEqual([400, JSON.stringify('Razorpay has no plan with that id.')]);
    expect(await priceRows(code)).toEqual([]);

    const free = await call(on, 'POST', '/plans/free/prices', { interval: 'monthly', pricePaise: 100, razorpayPlanId: rzpPlanId(), reason: REASON });
    expect([free.status, free.message]).toEqual([400, JSON.stringify('The Free plan has no price.')]);
    // The client never names the charged amount.
    const extra = await call(on, 'POST', `/plans/${code}/prices`, {
      interval: 'monthly',
      pricePaise: 99900,
      amountPaise: 117882,
      razorpayPlanId: rzpPlanId(),
      reason: REASON,
    });
    expect(extra.status).toBe(400);
    expect((await call(on, 'POST', `/plans/${code}/prices`, { interval: 'monthly', pricePaise: 99900, razorpayPlanId: 'plan_short', reason: REASON })).status).toBe(400);
  });

  it('retires a current price once', async () => {
    const code = await newPlan();
    const id = rzpPlanId();
    fake.seedPlan({ id, period: 'monthly', interval: 1, amountPaise: 117882, currency: 'INR' });
    const added = await call(on, 'POST', `/plans/${code}/prices`, { interval: 'monthly', pricePaise: 99900, razorpayPlanId: id, reason: REASON });
    const priceId = (added.data as AdminPlan).prices[0].id;

    const retired = await call(on, 'POST', `/plans/${code}/prices/${priceId}/retire`, { reason: REASON });
    expect(retired.status).toBe(200);
    expect((retired.data as AdminPlan).prices).toMatchObject([{ id: priceId, isCurrent: false }]);
    const again = await call(on, 'POST', `/plans/${code}/prices/${priceId}/retire`, { reason: REASON });
    expect([again.status, again.message]).toEqual([409, JSON.stringify('That price is not current.')]);
    expect((await auditOf('billing.price_retired', code)).map((r: { metadata: unknown }) => r.metadata)).toEqual([
      { planCode: code, priceId },
    ]);
    // Another plan's price is not found under this one.
    const other = await newPlan();
    expect((await call(on, 'POST', `/plans/${other}/prices/${priceId}/retire`, { reason: REASON })).status).toBe(404);
  });

  it('refuses every write without a recent sign-in', async () => {
    const code = await newPlan();
    const id = rzpPlanId();
    fake.seedPlan({ id, period: 'monthly', interval: 1, amountPaise: 117882, currency: 'INR' });
    const writes: Array<[string, string, unknown]> = [
      ['POST', '/plans', { code: `plan_scratch_${hex()}`, name: 'X', mauLimit: null, projectLimit: null, seatLimit: null, sortOrder: 1, reason: REASON }],
      ['PATCH', `/plans/${code}`, { mauLimit: 1, reason: REASON }],
      ['POST', `/plans/${code}/prices`, { interval: 'monthly', pricePaise: 99900, razorpayPlanId: id, reason: REASON }],
      ['POST', `/plans/${code}/prices/00000000-0000-4000-8000-000000000000/retire`, { reason: REASON }],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(on, method, path, body, staleToken);
      expect([method, path, res.status, res.message]).toEqual([method, path, 403, JSON.stringify(REAUTH_REQUIRED_MESSAGE)]);
    }
    expect(fake.callsOf('fetchPlan').filter(([planId]) => planId === id)).toEqual([]);
    // Reads need none.
    expect((await call(on, 'GET', '/plans', undefined, staleToken)).status).toBe(200);
  });

  it('with billing off, plans list and edit, and the price routes do not exist', async () => {
    const code = await newPlan();
    const list = await call(off, 'GET', '/plans');
    expect(list.status).toBe(200);
    const plans = list.data as AdminPlan[];
    expect(plans.find((p) => p.code === 'free')).toMatchObject({ code: 'free', isActive: true, billingEnabled: false });
    expect(plans.find((p) => p.code === code)).toMatchObject({ code, billingEnabled: false });
    expect((await call(off, 'PATCH', `/plans/${code}`, { seatLimit: 4, reason: REASON })).data).toMatchObject({ seatLimit: 4 });

    const id = rzpPlanId();
    fake.seedPlan({ id, period: 'monthly', interval: 1, amountPaise: 117882, currency: 'INR' });
    expect((await call(off, 'POST', `/plans/${code}/prices`, { interval: 'monthly', pricePaise: 99900, razorpayPlanId: id, reason: REASON })).status).toBe(404);
    expect((await call(off, 'POST', `/plans/${code}/prices/00000000-0000-4000-8000-000000000000/retire`, { reason: REASON })).status).toBe(404);
    expect(await priceRows(code)).toEqual([]);
  });
});

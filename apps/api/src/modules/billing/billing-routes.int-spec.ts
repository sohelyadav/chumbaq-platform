import { randomBytes, randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { BootedApp, bootIntApp, listRoutes } from '../../test-support/int-apps';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { FakeBillingProvider } from '../../test-support/fake-billing-provider';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { IMPERSONATION_READ_ONLY } from '../project-access/view-as';
import { BILLING_PROVIDER } from './providers/billing-provider';

const KEY_ID = 'rzp_test_AbC123xyz';
const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';
const DOMAIN = '@billing-routes-int.test';

const DETAILS = {
  legalName: 'Acme Software Private Limited',
  gstin: '27AAPFU0939F1ZV',
  address: { line1: '1 Main Road', city: 'Pune', postalCode: '411001', country: 'IN' },
  stateCode: '27',
};

/**
 * The account owner's billing routes on the booted customer API, with fake keys (so
 * billing is on) and the in-memory provider. Tokens are signed with the app's own
 * secret and go through the real JwtStrategy, RecentAuthGuard and ValidationPipe.
 */
describe('billing routes (integration)', () => {
  let ds: DataSource;
  let booted: BootedApp;
  let fake: FakeBillingProvider;
  const hex = (bytes = 6) => randomBytes(bytes).toString('hex');
  const jwt = () => new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '15m' } });

  beforeAll(async () => {
    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    ds = await openIntDb();
    fake = new FakeBillingProvider({ keyId: KEY_ID, webhookSecret: WEBHOOK_SECRET });
    booted = await bootIntApp('customer', { providers: [{ token: BILLING_PROVIDER, useValue: fake }] });
  });

  afterAll(async () => {
    await booted?.app.close();
    await closeIntDb(ds);
    process.env.RAZORPAY_KEY_ID = '';
    process.env.RAZORPAY_KEY_SECRET = '';
    process.env.RAZORPAY_WEBHOOK_SECRET = '';
  });

  async function user(name = 'owner') {
    const id = randomUUID();
    const email = `${name}-${id.slice(0, 8)}${DOMAIN}`;
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'Asha Rao')`, [id, email]);
    return { id, email };
  }

  /** A customer access token; `recent` gives it a sign-in time of now. */
  const tokenFor = (u: { id: string; email: string }, { recent = true }: { recent?: boolean } = {}) =>
    jwt().signAsync({
      sub: u.id,
      email: u.email,
      type: 'access',
      sv: 0,
      amr: ['pwd'],
      ...(recent ? { auth_time: Math.floor(Date.now() / 1000) } : {}),
    });

  async function plan() {
    const code = `plan_scratch_${hex()}`;
    const rzpPlan = `plan_${hex(7)}`;
    await ds.query(`INSERT INTO plans (code, name, sort_order) VALUES ($1, 'Scratch', 10)`, [code]);
    await ds.query(
      `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
       VALUES ($1, 'monthly', 99900, 1800, 117882, $2, true)`,
      [code, rzpPlan],
    );
    fake.seedPlan({ id: rzpPlan, period: 'monthly', interval: 1, amountPaise: 117882, currency: 'INR' });
    return code;
  }

  async function call(method: string, path: string, token: string | null, body?: unknown) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${booted.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: { data?: any; meta?: any; message?: unknown } = {};
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, text, json };
  }

  const messageOf = (r: { json: { message?: unknown } }) => JSON.stringify(r.json.message ?? r.json);

  describe('subscribe takes a plan and an interval only', () => {
    it.each([
      ['amount', { amount: 1 }],
      ['pricePaise', { pricePaise: 100 }],
    ])('refuses a body carrying %s with 400 and calls no provider', async (_name, extra) => {
      const u = await user();
      const token = await tokenFor(u);
      expect((await call('PUT', '/api/billing/details', token, DETAILS)).status).toBe(200);
      const code = await plan();
      const before = fake.calls.length;
      const res = await call('POST', '/api/billing/subscribe', token, { plan: code, interval: 'monthly', ...extra });
      expect(res.status).toBe(400);
      expect(messageOf(res)).toContain(Object.keys(extra)[0]);
      expect(fake.calls.length).toBe(before);
    });

    it('subscribes with only plan and interval once details are saved', async () => {
      const u = await user();
      const token = await tokenFor(u);
      const code = await plan();
      const first = await call('POST', '/api/billing/subscribe', token, { plan: code, interval: 'monthly' });
      expect(first.status).toBe(400);
      expect(messageOf(first)).toContain('Add your billing details first.');

      expect((await call('PUT', '/api/billing/details', token, DETAILS)).status).toBe(200);
      const res = await call('POST', '/api/billing/subscribe', token, { plan: code, interval: 'monthly' });
      expect(res.status).toBe(201);
      expect(res.json.data).toMatchObject({ keyId: KEY_ID, startsAt: null, prefill: { email: u.email, name: 'Asha Rao' } });
      expect(res.json.data.subscriptionId).toMatch(/^sub_/);

      const overview = await call('GET', '/api/billing', token);
      expect(overview.status).toBe(200);
      expect(overview.json.data.state).toBe('checkout');
    });

    it('refuses subscribe without a recent sign-in', async () => {
      const u = await user();
      const token = await tokenFor(u, { recent: false });
      const res = await call('POST', '/api/billing/subscribe', token, { plan: await plan(), interval: 'monthly' });
      expect(res.status).toBe(403);
      expect(messageOf(res)).toContain(REAUTH_REQUIRED_MESSAGE);
    });

    it.each(['change', 'cancel'])('refuses %s without a recent sign-in', async (route) => {
      const u = await user();
      const token = await tokenFor(u, { recent: false });
      const body = route === 'change' ? { plan: await plan(), interval: 'monthly' } : undefined;
      const res = await call('POST', `/api/billing/${route}`, token, body);
      expect(res.status).toBe(403);
      expect(messageOf(res)).toContain(REAUTH_REQUIRED_MESSAGE);
    });
  });

  it('refuses a view-as token on every billing route', async () => {
    const owner = await user();
    const staff = await user('staff');
    await ds.query(`UPDATE users SET is_super_admin = true WHERE id = $1`, [staff.id]);
    const { sessionId } = await issueStaffSessionForTest(ds, { id: staff.id, email: staff.email, sessionVersion: 0 });
    const viewAs = await jwt().signAsync({
      sub: owner.id,
      email: owner.email,
      type: 'access',
      sv: 0,
      imp: staff.id,
      impSv: 0,
      impSid: sessionId,
    });

    const routes = listRoutes(booted.app).filter(
      (r) => r.path.startsWith('/api/billing') && !r.path.startsWith('/api/billing/webhooks'),
    );
    expect(routes.map((r) => r.key).sort()).toEqual(
      [
        'GET /api/billing',
        'GET /api/billing/invoices',
        'POST /api/billing/cancel',
        'POST /api/billing/change',
        'POST /api/billing/subscribe',
        'PUT /api/billing/details',
      ].sort(),
    );
    for (const r of routes) {
      const body = r.method === 'GET' ? undefined : r.path.endsWith('details') ? DETAILS : { plan: 'x_plan', interval: 'monthly' };
      const res = await call(r.method, r.path, viewAs, body);
      expect([r.key, res.status]).toEqual([r.key, 403]);
      expect(messageOf(res)).toContain(IMPERSONATION_READ_ONLY);
    }
    // The owner's own token reads it, so the 403 above is view-as and not the route.
    expect((await call('GET', '/api/billing', await tokenFor(owner))).status).toBe(200);
  });

  it('gives the key id and never a secret', async () => {
    const u = await user();
    const res = await call('GET', '/api/billing', await tokenFor(u));
    expect(res.status).toBe(200);
    expect(res.json.data.keyId).toBe(KEY_ID);
    expect(res.text).not.toContain(KEY_SECRET);
    expect(res.text).not.toContain(WEBHOOK_SECRET);
    expect(res.json.data).toMatchObject({ state: 'free', effectivePlan: { code: 'free' }, details: null });
  });

  it("lists only the caller's invoices, newest first", async () => {
    const mine = await user();
    const theirs = await user('other');
    const insert = (userId: string, issuedAt: string) =>
      ds.query(
        `INSERT INTO billing_invoices
           (provider_invoice_id, user_id, status, amount_paise, tax_paise, provider_tax_paise, currency, issued_at, short_url)
         VALUES ($1, $2, 'paid', 117882, 17982, 0, 'INR', $3, 'https://rzp.io/i/abc') RETURNING id`,
        [`inv_${hex(7)}`, userId, issuedAt],
      );
    const [older] = await insert(mine.id, '2026-09-01T00:00:00Z');
    const [newer] = await insert(mine.id, '2026-10-01T00:00:00Z');
    await insert(theirs.id, '2026-10-15T00:00:00Z');

    const res = await call('GET', '/api/billing/invoices?page=1&limit=10', await tokenFor(mine));
    expect(res.status).toBe(200);
    expect(res.json.data.map((i: { id: string }) => i.id)).toEqual([newer.id, older.id]);
    expect(res.json.meta).toMatchObject({ total: 2, page: 1, limit: 10 });
    expect(res.json.data[0]).toEqual({
      id: newer.id,
      number: null,
      status: 'paid',
      amountPaise: 117882,
      taxPaise: 17982,
      currency: 'INR',
      periodStart: null,
      periodEnd: null,
      issuedAt: '2026-10-01T00:00:00.000Z',
      paidAt: null,
      shortUrl: 'https://rzp.io/i/abc',
    });
  });

  it('says billing is on in /auth/me', async () => {
    const u = await user();
    const res = await call('GET', '/api/auth/me', await tokenFor(u));
    expect(res.status).toBe(200);
    expect(res.json.data.billingEnabled).toBe(true);
  });
});

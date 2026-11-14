import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BillingProviderError } from '../modules/billing/providers/billing-provider';
import { InvalidProviderIdError } from '../modules/billing/providers/razorpay.provider';
import { FAKE_BILLING_WEBHOOK_SECRET, FakeBillingProvider } from './fake-billing-provider';

const PLAN = { id: 'plan_fakeMonthly1', period: 'monthly', interval: 1, amountPaise: 100000, currency: 'INR' };

describe('FakeBillingProvider', () => {
  it('creates subscriptions on seeded plans and records each call', async () => {
    const fake = new FakeBillingProvider();
    fake.seedPlan(PLAN);
    const startAt = new Date('2026-12-01T00:00:00Z');
    const sub = await fake.createSubscription({
      planId: PLAN.id,
      totalCount: 120,
      startAt,
      expireBy: new Date('2026-11-15T00:00:00Z'),
      accountRef: 'acct-1',
    });
    expect(sub).toMatchObject({ planId: PLAN.id, status: 'created', startAt });
    expect(await fake.fetchSubscription(sub.id)).toEqual(sub);
    expect(fake.calls.map((c) => c.method)).toEqual(['createSubscription', 'fetchSubscription']);
  });

  it('answers an unknown id as Razorpay does, and refuses a malformed one', async () => {
    const fake = new FakeBillingProvider();
    await expect(fake.fetchSubscription('sub_unknown0001')).rejects.toBeInstanceOf(BillingProviderError);
    await expect(fake.fetchPlan('plan_../x')).rejects.toBeInstanceOf(InvalidProviderIdError);
  });

  it('cancels now, or keeps the status until the cycle ends', async () => {
    const fake = new FakeBillingProvider();
    fake.setSubscription({
      id: 'sub_fakeActive01',
      planId: PLAN.id,
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
    expect((await fake.cancelSubscription('sub_fakeActive01', true)).status).toBe('active');
    expect((await fake.cancelSubscription('sub_fakeActive01', false)).status).toBe('cancelled');
    await expect(fake.cancelSubscription('sub_fakeActive01', false)).rejects.toMatchObject({ status: 400 });
  });

  it('fails the next call of a method once, when told to', async () => {
    const fake = new FakeBillingProvider();
    fake.seedPlan(PLAN);
    const failure = new TypeError('fetch failed');
    fake.failNext('fetchPlan', failure);
    await expect(fake.fetchPlan(PLAN.id)).rejects.toBe(failure);
    await expect(fake.fetchPlan(PLAN.id)).resolves.toEqual(PLAN);
  });

  it('checks webhook signatures for real and parses with the real parser', () => {
    const fake = new FakeBillingProvider();
    const raw = readFileSync(join(__dirname, '../modules/billing/providers/__fixtures__/razorpay/subscription.halted.json'));
    const good = createHmac('sha256', FAKE_BILLING_WEBHOOK_SECRET).update(raw).digest('hex');
    const bad = createHmac('sha256', 'other').update(raw).digest('hex');
    expect(fake.verifyWebhook(raw, good)).toBe(true);
    expect(fake.verifyWebhook(raw, bad)).toBe(false);
    expect(fake.parseWebhook(JSON.parse(raw.toString('utf8'))).subscription?.status).toBe('halted');
  });
});

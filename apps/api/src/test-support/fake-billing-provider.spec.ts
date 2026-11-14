import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BillingProviderError, ProviderInvoice } from '../modules/billing/providers/billing-provider';
import { InvalidCustomerInputError } from '../modules/billing/providers/razorpay-customer';
import { InvalidProviderIdError } from '../modules/billing/providers/razorpay.provider';
import { FAKE_BILLING_WEBHOOK_SECRET, FakeBillingProvider } from './fake-billing-provider';

const invoice = (n: number, subscriptionId = 'sub_fakeActive01'): ProviderInvoice => ({
  id: `inv_fake${String(n).padStart(10, '0')}`,
  subscriptionId,
  customerId: 'cust_fake00000001',
  paymentId: `pay_fake${String(n).padStart(10, '0')}`,
  status: 'paid',
  amountPaise: 99900,
  providerTaxPaise: 0,
  currency: 'INR',
  billingStart: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000),
  billingEnd: new Date(Date.UTC(2026, 0, 2) + n * 86_400_000),
  issuedAt: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000),
  paidAt: null,
  shortUrl: `https://rzp.io/i/fake${n}`,
  number: null,
});

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

  it('lists every invoice of a subscription past the first page, newest first, through the real provider', async () => {
    const fake = new FakeBillingProvider();
    for (let n = 1; n <= 25; n += 1) fake.addInvoice(invoice(n));
    for (let n = 26; n <= 28; n += 1) fake.addInvoice(invoice(n, 'sub_fakeOther001'));
    const listed = await fake.listSubscriptionInvoices('sub_fakeActive01');
    expect(listed.map((i) => i.id)).toEqual(
      Array.from({ length: 25 }, (_, k) => invoice(25 - k).id),
    );
    expect(listed[0]).toEqual(invoice(25));
    expect(fake.invoiceListRequests).toEqual([
      'https://api.razorpay.com/v1/invoices?subscription_id=sub_fakeActive01&count=100&skip=0',
    ]);
    expect(fake.callsOf('listSubscriptionInvoices')).toEqual([['sub_fakeActive01']]);
    await expect(fake.listSubscriptionInvoices('sub_../x')).rejects.toBeInstanceOf(InvalidProviderIdError);
  });

  it('pages invoices as Razorpay does: 10 unless asked, at most 100, from skip', async () => {
    const fake = new FakeBillingProvider();
    for (let n = 1; n <= 25; n += 1) fake.addInvoice(invoice(n));
    const page = async (query: string) => {
      const response = fake.answerInvoiceList(`https://api.razorpay.com/v1/invoices?subscription_id=sub_fakeActive01${query}`);
      return { status: response.status, body: (await response.json()) as { items: Array<{ id: string }> } };
    };
    expect((await page('')).body.items).toHaveLength(10);
    expect((await page('')).body.items[0].id).toBe(invoice(25).id);
    expect((await page('&count=100&skip=20')).body.items.map((i: { id: string }) => i.id)).toEqual(
      [5, 4, 3, 2, 1].map((n) => invoice(n).id),
    );
    expect((await page('&count=101')).status).toBe(400);
  });

  it("holds customer details to Razorpay's rules", async () => {
    const fake = new FakeBillingProvider();
    const { id } = await fake.createCustomer({
      name: 'Smith & Sons-Co, Ltd.',
      email: 'a@acme.test',
      gstin: null,
      accountRef: 'acct-1',
    });
    expect(fake.customers.get(id)?.name).toBe('Smith and Sons Co Ltd.');
    await expect(
      fake.createCustomer({ name: 'Acme', email: `${'a'.repeat(60)}@acme.test`, gstin: null, accountRef: 'acct-1' }),
    ).rejects.toBeInstanceOf(InvalidCustomerInputError);
  });
});

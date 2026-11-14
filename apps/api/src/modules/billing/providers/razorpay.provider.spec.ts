import { readFileSync } from 'fs';
import { join } from 'path';
import { PROVIDER_REQUEST_TIMEOUT_MS, isUnreachableError } from '../../push-notifications/services/per-recipient-provider';
import { BillingProviderError } from './billing-provider';
import { InvalidPayloadError } from './razorpay-payload';
import { InvalidCustomerInputError } from './razorpay-customer';
import {
  INVOICE_LIST_MAX_PAGES,
  INVOICE_LIST_PAGE_SIZE,
  InvalidProviderIdError,
  InvoiceListTooLongError,
  RazorpayProvider,
} from './razorpay.provider';

const DIR = join(__dirname, '__fixtures__/razorpay');
const fixture = (name: string): any => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

const KEY_ID = 'rzp_test_AbC123xyz';
const KEY_SECRET = 'sk_live_DoNotLeakThisSecret42';
const WEBHOOK_SECRET = 'whsec_DoNotLeakThisEither';
const BASE = 'https://api.razorpay.com/v1';
const AUTH = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: unknown;
}

/**
 * A fetch that answers only the requests it was told to expect, so a request to any
 * other URL (or with another method) fails the test rather than reaching anything.
 */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      signal: init?.signal,
    });
    const answer = routes[`${method} ${url}`];
    if (!answer) throw new Error(`Unexpected request: ${method} ${url}`);
    return answer();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const provider = (fetchImpl: typeof fetch) =>
  new RazorpayProvider({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, fetchImpl);

describe('RazorpayProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is enabled and gives its key id, which Checkout needs', () => {
    const p = provider(stubFetch({}).impl);
    expect(p.enabled).toBe(true);
    expect(p.keyId).toBe(KEY_ID);
  });

  it('sends Basic auth, JSON and a 15 second time limit on every request', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const { impl, calls } = stubFetch({
      [`GET ${BASE}/subscriptions/sub_00000000000001`]: () => json(fixture('subscription.json')),
    });
    await provider(impl).fetchSubscription('sub_00000000000001');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toMatchObject({ Authorization: AUTH, 'Content-Type': 'application/json' });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(PROVIDER_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(timeout).toHaveBeenCalledWith(PROVIDER_REQUEST_TIMEOUT_MS);
  });

  it('creates a customer once, with the account reference in notes and fail_existing "0"', async () => {
    const { impl, calls } = stubFetch({ [`POST ${BASE}/customers`]: () => json(fixture('customer.json')) });
    const result = await provider(impl).createCustomer({
      name: 'Acme Labs',
      email: 'billing@acme.test',
      gstin: '29ABCDE1234F1Z5',
      accountRef: 'acct-1',
    });
    expect(result).toEqual({ id: 'cust_1Aa00000000004' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: {
        name: 'Acme Labs',
        email: 'billing@acme.test',
        gstin: '29ABCDE1234F1Z5',
        fail_existing: '0',
        notes: { account_ref: 'acct-1' },
      },
    });
  });

  it('leaves gstin out of the customer when there is none', async () => {
    const { impl, calls } = stubFetch({ [`POST ${BASE}/customers`]: () => json(fixture('customer.json')) });
    await provider(impl).createCustomer({ name: 'Acme', email: 'a@acme.test', gstin: null, accountRef: 'acct-1' });
    expect(calls[0].body).not.toHaveProperty('gstin');
  });

  const sentName = async (name: string) => {
    const { impl, calls } = stubFetch({ [`POST ${BASE}/customers`]: () => json(fixture('customer.json')) });
    await provider(impl).createCustomer({ name, email: 'a@acme.test', gstin: null, accountRef: 'acct-1' });
    return (calls[0].body as { name: string }).name;
  };

  it('sends a legal name of 51 characters cut to 50, at a word boundary', async () => {
    const name = 'Northern Coastal Software and Analytics Private Ltd';
    expect(name).toHaveLength(51);
    expect(await sentName(name)).toBe('Northern Coastal Software and Analytics Private');
    expect(await sentName('A'.repeat(51))).toBe('A'.repeat(50));
  });

  it("keeps a name Razorpay accepts as it is", async () => {
    const name = "O'Brien (India) Pvt. Ltd. / R@D";
    expect(await sentName(name)).toBe(name);
  });

  it("puts a name with characters Razorpay refuses into ones it accepts", async () => {
    expect(await sentName('Smith & Sons-Co, Ltd.')).toBe('Smith and Sons Co Ltd.');
    expect(await sentName('Café Société')).toBe('Cafe Societe');
    expect(await sentName('  Acme\tLabs\n ')).toBe('Acme Labs');
  });

  it.each([
    ['nothing Razorpay accepts', 'देवनागरी'],
    ['too short', 'Ab-'],
    ['punctuation only', "... ''"],
  ])('refuses a name with %s before any request, naming the field and not the value', async (_why, name) => {
    const { impl } = stubFetch({});
    const error = await provider(impl)
      .createCustomer({ name, email: 'a@acme.test', gstin: null, accountRef: 'acct-1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCustomerInputError);
    expect(error).toMatchObject({ field: 'name' });
    expect((error as Error).message).not.toContain(name);
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses an email longer than 64 characters before any request, and sends one of 64', async () => {
    const long = `${'a'.repeat(54)}@acme.test`;
    expect(long).toHaveLength(64);
    const { impl, calls } = stubFetch({ [`POST ${BASE}/customers`]: () => json(fixture('customer.json')) });
    await provider(impl).createCustomer({ name: 'Acme', email: long, gstin: null, accountRef: 'acct-1' });
    expect(calls[0].body).toMatchObject({ email: long });
    const tooLong = `a${long}`;
    const error = await provider(impl)
      .createCustomer({ name: 'Acme', email: tooLong, gstin: null, accountRef: 'acct-1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCustomerInputError);
    expect(error).toMatchObject({ field: 'email' });
    expect((error as Error).message).not.toContain(tooLong);
    expect(calls).toHaveLength(1);
  });

  it('creates a subscription that starts later, with whole seconds', async () => {
    const { impl, calls } = stubFetch({ [`POST ${BASE}/subscriptions`]: () => json(fixture('subscription.json')) });
    const sub = await provider(impl).createSubscription({
      planId: 'plan_00000000000001',
      totalCount: 120,
      startAt: new Date(1773461489000),
      expireBy: new Date(1773547889000),
      accountRef: 'acct-1',
    });
    expect(calls[0].body).toEqual({
      plan_id: 'plan_00000000000001',
      total_count: 120,
      quantity: 1,
      customer_notify: true,
      expire_by: 1773547889,
      start_at: 1773461489,
      notes: { account_ref: 'acct-1' },
    });
    expect(sub).toEqual({
      id: 'sub_00000000000001',
      planId: 'plan_00000000000001',
      customerId: null,
      status: 'created',
      currentStart: null,
      currentEnd: null,
      startAt: new Date(1773461489000),
      chargeAt: new Date(1773461489000),
      endedAt: null,
      paidCount: 0,
      shortUrl: 'https://rzp.io/rzp/Dqdqx3h',
    });
  });

  it('rounds a start time up, never before the moment asked for', async () => {
    const { impl, calls } = stubFetch({ [`POST ${BASE}/subscriptions`]: () => json(fixture('subscription.json')) });
    await provider(impl).createSubscription({
      planId: 'plan_00000000000001',
      totalCount: 10,
      startAt: new Date(1773461489001),
      expireBy: new Date(1773547889999),
      accountRef: 'acct-1',
    });
    expect(calls[0].body).toMatchObject({ start_at: 1773461490, expire_by: 1773547890 });
  });

  it('leaves start_at out of a subscription that starts now', async () => {
    const { impl, calls } = stubFetch({ [`POST ${BASE}/subscriptions`]: () => json(fixture('subscription.json')) });
    await provider(impl).createSubscription({
      planId: 'plan_00000000000001',
      totalCount: 120,
      startAt: null,
      expireBy: new Date(1773547889000),
      accountRef: 'acct-1',
    });
    expect(calls[0].body).not.toHaveProperty('start_at');
  });

  it.each([true, false])('cancels with cancel_at_cycle_end %s', async (atCycleEnd) => {
    const cancelled = { ...fixture('subscription.json'), status: 'cancelled', ended_at: 1773394999 };
    const { impl, calls } = stubFetch({
      [`POST ${BASE}/subscriptions/sub_00000000000001/cancel`]: () => json(cancelled),
    });
    const sub = await provider(impl).cancelSubscription('sub_00000000000001', atCycleEnd);
    expect(calls[0].body).toEqual({ cancel_at_cycle_end: atCycleEnd });
    expect(sub.status).toBe('cancelled');
    expect(sub.endedAt).toEqual(new Date(1773394999000));
  });

  it('fetches a plan, reading its amount and currency from the item', async () => {
    const { impl } = stubFetch({ [`GET ${BASE}/plans/plan_00000000000001`]: () => json(fixture('plan.json')) });
    expect(await provider(impl).fetchPlan('plan_00000000000001')).toEqual({
      id: 'plan_00000000000001',
      period: 'weekly',
      interval: 1,
      amountPaise: 69900,
      currency: 'INR',
    });
  });

  const invoicesUrl = (skip: number) =>
    `${BASE}/invoices?subscription_id=sub_00000000000001&count=100&skip=${skip}`;

  /** A page of `n` invoices of the subscription, each a copy of the documented one with its own id. */
  const invoicePage = (n: number, from = 0) => {
    const [first] = fixture('invoices.list.json').items;
    const items = Array.from({ length: n }, (_, k) => ({ ...first, id: `inv_page${String(from + k).padStart(10, '0')}` }));
    return { entity: 'collection', count: items.length, items };
  };

  it("lists a subscription's invoices, asking for Razorpay's largest page", async () => {
    const { impl, calls } = stubFetch({ [`GET ${invoicesUrl(0)}`]: () => json(fixture('invoices.list.json')) });
    const invoices = await provider(impl).listSubscriptionInvoices('sub_00000000000001');
    expect(invoices.map((i) => [i.id, i.subscriptionId, i.status, i.amountPaise])).toEqual([
      ['inv_00000000000003', 'sub_00000000000001', 'paid', 99900],
      ['inv_00000000000001', 'sub_00000000000001', 'paid', 129900],
    ]);
    // A page shorter than asked for is the last one.
    expect(calls.map((c) => c.url)).toEqual([invoicesUrl(0)]);
    expect(INVOICE_LIST_PAGE_SIZE).toBe(100);
  });

  it('pages through more invoices than one page holds, by skip', async () => {
    const { impl, calls } = stubFetch({
      [`GET ${invoicesUrl(0)}`]: () => json(invoicePage(100, 0)),
      [`GET ${invoicesUrl(100)}`]: () => json(invoicePage(100, 100)),
      [`GET ${invoicesUrl(200)}`]: () => json(invoicePage(5, 200)),
    });
    const invoices = await provider(impl).listSubscriptionInvoices('sub_00000000000001');
    expect(invoices).toHaveLength(205);
    expect(new Set(invoices.map((i) => i.id)).size).toBe(205);
    expect(calls.map((c) => c.url)).toEqual([invoicesUrl(0), invoicesUrl(100), invoicesUrl(200)]);
  });

  it('asks once more after a full page, and stops at an empty one', async () => {
    const { impl, calls } = stubFetch({
      [`GET ${invoicesUrl(0)}`]: () => json(invoicePage(100, 0)),
      [`GET ${invoicesUrl(100)}`]: () => json(invoicePage(0)),
    });
    expect(await provider(impl).listSubscriptionInvoices('sub_00000000000001')).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it('lists an invoice once when a new one pushed it onto the next page as well', async () => {
    // Newest first: an invoice issued between two requests moves every later one down by one.
    const { impl } = stubFetch({
      [`GET ${invoicesUrl(0)}`]: () => json(invoicePage(100, 0)),
      [`GET ${invoicesUrl(100)}`]: () => json(invoicePage(3, 99)),
    });
    const invoices = await provider(impl).listSubscriptionInvoices('sub_00000000000001');
    expect(invoices.map((i) => i.id)).toEqual(invoicePage(102, 0).items.map((i: { id: string }) => i.id));
  });

  it('refuses, rather than answer with part of the list, after the page cap', async () => {
    const routes: Record<string, () => Response> = {};
    for (let page = 0; page <= INVOICE_LIST_MAX_PAGES; page += 1) {
      routes[`GET ${invoicesUrl(page * 100)}`] = () => json(invoicePage(100, page * 100));
    }
    const { impl, calls } = stubFetch(routes);
    await expect(provider(impl).listSubscriptionInvoices('sub_00000000000001')).rejects.toBeInstanceOf(
      InvoiceListTooLongError,
    );
    expect(INVOICE_LIST_MAX_PAGES).toBe(20);
    expect(calls).toHaveLength(INVOICE_LIST_MAX_PAGES);
  });

  it('refuses an invoice list reply without items', async () => {
    const { impl } = stubFetch({
      [`GET ${invoicesUrl(0)}`]: () => json({ entity: 'collection', count: 0 }),
    });
    await expect(provider(impl).listSubscriptionInvoices('sub_00000000000001')).rejects.toBeInstanceOf(
      InvalidPayloadError,
    );
  });

  it('asks Razorpay to email an invoice', async () => {
    const { impl, calls } = stubFetch({
      [`POST ${BASE}/invoices/inv_00000000000003/notify_by/email`]: () => json({ success: true }),
    });
    await expect(provider(impl).notifyInvoiceByEmail('inv_00000000000003')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("throws Razorpay's error code and description on a 4xx", async () => {
    const { impl } = stubFetch({
      [`POST ${BASE}/subscriptions/sub_00000000000001/cancel`]: () =>
        json(
          {
            error: {
              code: 'BAD_REQUEST_ERROR',
              description: 'Subscriptions cannot be updated when payment mode is UPI',
            },
          },
          400,
        ),
    });
    const error = await provider(impl)
      .cancelSubscription('sub_00000000000001', true)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingProviderError);
    expect(error).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST_ERROR',
      description: 'Subscriptions cannot be updated when payment mode is UPI',
    });
    // The provider's text is kept on the error, not in its message.
    expect((error as Error).message).toBe('Billing provider answered 400 BAD_REQUEST_ERROR');
  });

  it('cuts a long error description to 320 characters', async () => {
    const { impl } = stubFetch({
      [`GET ${BASE}/plans/plan_00000000000001`]: () =>
        json({ error: { code: 'BAD_REQUEST_ERROR', description: 'x'.repeat(5000) } }, 400),
    });
    const error = (await provider(impl)
      .fetchPlan('plan_00000000000001')
      .catch((e: unknown) => e)) as BillingProviderError;
    expect(error.description).toHaveLength(320);
  });

  it('throws a BillingProviderError with no code for a 5xx that is not JSON', async () => {
    const { impl } = stubFetch({
      [`GET ${BASE}/plans/plan_00000000000001`]: () => new Response('<html>Bad gateway</html>', { status: 502 }),
    });
    await expect(provider(impl).fetchPlan('plan_00000000000001')).rejects.toMatchObject({
      name: 'BillingProviderError',
      status: 502,
      code: null,
      description: null,
    });
  });

  it('refuses a 2xx reply that is not JSON', async () => {
    const { impl } = stubFetch({
      [`GET ${BASE}/plans/plan_00000000000001`]: () => new Response('ok', { status: 200 }),
    });
    await expect(provider(impl).fetchPlan('plan_00000000000001')).rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it('lets a network failure through unchanged, so it counts as unreachable', async () => {
    const failure = new TypeError('fetch failed');
    const impl = jest.fn(async () => {
      throw failure;
    }) as unknown as typeof fetch;
    const error = await provider(impl)
      .fetchSubscription('sub_00000000000001')
      .catch((e: unknown) => e);
    expect(error).toBe(failure);
    expect(isUnreachableError(error)).toBe(true);
  });

  it.each([
    ['cancelSubscription', (p: RazorpayProvider) => p.cancelSubscription('sub_../../x', true)],
    ['fetchSubscription', (p: RazorpayProvider) => p.fetchSubscription('sub_1?expand[]=x')],
    ['fetchPlan', (p: RazorpayProvider) => p.fetchPlan('plan_%2Fx')],
    ['listSubscriptionInvoices', (p: RazorpayProvider) => p.listSubscriptionInvoices('sub_1&count=100')],
    ['notifyInvoiceByEmail', (p: RazorpayProvider) => p.notifyInvoiceByEmail('inv_1/notify_by/sms')],
    ['fetchSubscription (empty)', (p: RazorpayProvider) => p.fetchSubscription('')],
    [
      'createSubscription',
      (p: RazorpayProvider) =>
        p.createSubscription({
          planId: 'plan_1", "total_count": 1',
          totalCount: 120,
          startAt: null,
          expireBy: new Date(),
          accountRef: 'acct-1',
        }),
    ],
  ])('%s refuses an id that is not Razorpay-shaped before any request', async (_name, call) => {
    const { impl } = stubFetch({});
    await expect(call(provider(impl))).rejects.toBeInstanceOf(InvalidProviderIdError);
    expect(impl).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a total count of %s before any request', async (totalCount) => {
    const { impl } = stubFetch({});
    await expect(
      provider(impl).createSubscription({
        planId: 'plan_00000000000001',
        totalCount,
        startAt: null,
        expireBy: new Date(),
        accountRef: 'acct-1',
      }),
    ).rejects.toThrow();
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses an invalid date before any request', async () => {
    const { impl } = stubFetch({});
    await expect(
      provider(impl).createSubscription({
        planId: 'plan_00000000000001',
        totalCount: 120,
        startAt: new Date(Number.NaN),
        expireBy: new Date(),
        accountRef: 'acct-1',
      }),
    ).rejects.toThrow();
    expect(impl).not.toHaveBeenCalled();
  });

  it('puts neither secret in any error it throws, nor in the provider when printed', async () => {
    const { impl } = stubFetch({
      [`GET ${BASE}/plans/plan_00000000000001`]: () =>
        json({ error: { code: 'BAD_REQUEST_ERROR', description: 'The api key provided is invalid' } }, 401),
      [`GET ${BASE}/plans/plan_00000000000002`]: () => new Response('<html>', { status: 502 }),
      [`GET ${BASE}/plans/plan_00000000000003`]: () => new Response('nope', { status: 200 }),
    });
    const p = provider(impl);
    const errors = await Promise.all([
      p.fetchPlan('plan_00000000000001').catch((e: unknown) => e),
      p.fetchPlan('plan_00000000000002').catch((e: unknown) => e),
      p.fetchPlan('plan_00000000000003').catch((e: unknown) => e),
      p.fetchPlan('bad/id').catch((e: unknown) => e),
    ]);
    const basic = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
    for (const error of errors) {
      const e = error as Error;
      const seen = [e.message, e.stack, JSON.stringify(e), require('util').inspect(e)].join('\n');
      for (const secret of [KEY_SECRET, WEBHOOK_SECRET, basic]) expect(seen).not.toContain(secret);
    }
    const printed = [JSON.stringify(p), require('util').inspect(p, { depth: 5, showHidden: true })].join('\n');
    for (const secret of [KEY_SECRET, WEBHOOK_SECRET, basic]) expect(printed).not.toContain(secret);
  });

  it('verifies webhooks with the webhook secret and parses them', () => {
    const raw = readFileSync(join(DIR, 'subscription.charged.json'));
    const signature = require('crypto').createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
    const p = provider(stubFetch({}).impl);
    expect(p.verifyWebhook(raw, signature)).toBe(true);
    expect(p.verifyWebhook(raw, undefined)).toBe(false);
    const keySigned = require('crypto').createHmac('sha256', KEY_SECRET).update(raw).digest('hex');
    expect(p.verifyWebhook(raw, keySigned)).toBe(false);
    expect(p.parseWebhook(JSON.parse(raw.toString('utf8'))).subscription?.id).toBe('sub_DEX6xcJ1HSW4CR');
  });
});

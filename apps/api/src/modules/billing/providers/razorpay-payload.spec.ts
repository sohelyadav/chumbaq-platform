import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  InvalidPayloadError,
  parseRazorpayEvent,
  storedPayload,
  toProviderInvoice,
  toProviderPlan,
  toProviderSubscription,
} from './razorpay-payload';

const DIR = join(__dirname, '__fixtures__/razorpay');
const verbatim = (name: string): any => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
/**
 * The fixture as Razorpay would send it. One documented example, `subscription.activated`
 * with a payment, has the event's `created_at` inside `payload` (a slip in the docs:
 * every other example has it at the top), so it is moved up here, as is.
 */
const fixture = (name: string): any => {
  const body = verbatim(name);
  if (body.created_at === undefined && body.payload?.created_at !== undefined) {
    body.created_at = body.payload.created_at;
    delete body.payload.created_at;
  }
  return body;
};
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const WEBHOOKS = FIXTURES.filter((f) => typeof verbatim(f).event === 'string');

describe('parseRazorpayEvent', () => {
  it('reads subscription.charged: the subscription and the payment it carries', () => {
    const event = parseRazorpayEvent(fixture('subscription.charged.json'));
    expect(event.type).toBe('subscription.charged');
    expect(event.createdAt).toEqual(new Date(1567690383000));
    expect(event.subscription).toEqual({
      id: 'sub_DEX6xcJ1HSW4CR',
      planId: 'plan_BvrFKjSxauOH7N',
      customerId: 'cust_C0WlbKhp3aLA7W',
      status: 'active',
      currentStart: new Date(1570213800000),
      currentEnd: new Date(1572892200000),
      startAt: new Date(1570213800000),
      chargeAt: new Date(1572892200000),
      endedAt: null,
      paidCount: 1,
      shortUrl: null,
    });
    expect(event.payment).toMatchObject({
      id: 'pay_DEXFWroJ6LikKT',
      amountPaise: 100000,
      currency: 'INR',
      status: 'captured',
      method: 'card',
      invoiceId: 'inv_DEXFWVuM6rPqlK',
      orderId: 'order_DEXFWXwO24pDxH',
      customerId: 'cust_C0WlbKhp3aLA7W',
      amountRefundedPaise: 0,
      createdAt: new Date(1567690382000),
    });
    expect(event.invoice).toBeNull();
    expect(event.refund).toBeNull();
  });

  it('reads invoice.paid: the amount with tax and the tax Razorpay worked out', () => {
    const event = parseRazorpayEvent(fixture('invoice.paid.json'));
    expect(event.invoice).toMatchObject({
      id: 'inv_DEWHZlfIcdVIXL',
      subscriptionId: null,
      customerId: 'cust_BtQNqzmBlAXyTY',
      paymentId: 'pay_DEWHsM9ByjCjYS',
      status: 'paid',
      amountPaise: 479030,
      providerTaxPaise: 54030,
      currency: 'INR',
      issuedAt: new Date(1567686976000),
      paidAt: new Date(1567686996000),
      number: '15',
    });
    // `captured: true` here, `"1"` in the subscription examples: both are read.
    expect(event.payment?.status).toBe('captured');
  });

  it('reads refund.processed: the refund and the cumulative refunded amount on its payment', () => {
    const event = parseRazorpayEvent(fixture('refund.processed.json'));
    expect(event.refund).toEqual({
      id: 'rfnd_FS8TWyPrCsa0OB',
      paymentId: 'pay_FPoJKWQQ8lK13n',
      amountPaise: 50000,
      status: 'processed',
      createdAt: new Date(1597734071000),
    });
    expect(event.payment?.amountRefundedPaise).toBe(190000);
    expect(event.payment?.amountPaise).toBe(500000);
  });

  it('reads payment.failed with its reason', () => {
    const event = parseRazorpayEvent(fixture('payment.failed.json'));
    expect(event.payment).toMatchObject({
      status: 'failed',
      errorReason: 'payment_failed',
      errorDescription: 'Payment failed',
      invoiceId: null,
    });
  });

  it.each(WEBHOOKS)('parses %s', (name) => {
    const body = fixture(name);
    const event = parseRazorpayEvent(body);
    expect(event.type).toBe(body.event);
    expect(event.createdAt).toEqual(new Date(body.created_at * 1000));
  });

  it('accepts notes as [] (subscription.authenticated) and as an object (subscription.halted)', () => {
    expect(Array.isArray(fixture('subscription.authenticated.json').payload.subscription.entity.notes)).toBe(true);
    expect(parseRazorpayEvent(fixture('subscription.authenticated.json')).subscription?.status).toBe('authenticated');
    expect(parseRazorpayEvent(fixture('subscription.halted.json')).subscription?.status).toBe('halted');
  });

  it('gives an event type it does not use no entities, as payment.downtime.started', () => {
    const event = parseRazorpayEvent(fixture('payment.downtime.started.json'));
    expect(event).toEqual({
      type: 'payment.downtime.started',
      createdAt: new Date(1591935238000),
      subscription: null,
      payment: null,
      invoice: null,
      refund: null,
    });
  });

  it('does not read the entities of an unsubscribed event, so a status it does not know cannot fail it', () => {
    const body = fixture('subscription.halted.json');
    body.event = 'subscription.paused';
    body.payload.subscription.entity.status = 'paused';
    expect(parseRazorpayEvent(body).subscription).toBeNull();
  });

  it('refuses the verbatim subscription.activated example, whose created_at is not at the top', () => {
    expect(() => parseRazorpayEvent(verbatim('subscription.activated.json'))).toThrow(InvalidPayloadError);
    expect(parseRazorpayEvent(fixture('subscription.activated.json')).payment?.invoiceId).toBe('inv_DEXFWVuM6rPqlK');
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['an array', []],
    ['no created_at', { event: 'subscription.charged' }],
    ['a created_at that is not a number', { event: 'subscription.charged', created_at: '1567690383' }],
    ['a fractional created_at', { event: 'subscription.charged', created_at: 1.5 }],
    ['no event', { created_at: 1567690383 }],
  ])('refuses %s', (_label, body) => {
    expect(() => parseRazorpayEvent(body)).toThrow(InvalidPayloadError);
  });

  it('refuses a subscription status it does not know on a subscribed event', () => {
    const body = fixture('subscription.halted.json');
    body.payload.subscription.entity.status = 'paused';
    expect(() => parseRazorpayEvent(body)).toThrow(InvalidPayloadError);
  });

  it('refuses a payment status it does not know', () => {
    const body = fixture('payment.failed.json');
    body.payload.payment.entity.status = 'settled';
    expect(() => parseRazorpayEvent(body)).toThrow(InvalidPayloadError);
  });

  it.each([
    ['a number', 12345],
    ['a path', 'sub_../../x'],
    ['an empty string', ''],
    ['41 characters', 'sub_' + 'a'.repeat(37)],
  ])('refuses a subscription id that is %s', (_label, id) => {
    const body = fixture('subscription.charged.json');
    body.payload.subscription.entity.id = id;
    expect(() => parseRazorpayEvent(body)).toThrow(InvalidPayloadError);
  });

  it('refuses a payment invoice id of the wrong type', () => {
    const body = fixture('subscription.charged.json');
    body.payload.payment.entity.invoice_id = { id: 'inv_x' };
    expect(() => parseRazorpayEvent(body)).toThrow(InvalidPayloadError);
  });

  it.each([
    ['a string', '100000'],
    ['a fraction', 1000.5],
    ['negative', -1],
  ])('refuses an amount that is %s: money is whole paise', (_label, amount) => {
    const body = fixture('subscription.charged.json');
    body.payload.payment.entity.amount = amount;
    expect(() => parseRazorpayEvent(body)).toThrow(InvalidPayloadError);
  });

  it('refuses a timestamp that is a string', () => {
    const body = fixture('subscription.charged.json');
    body.payload.subscription.entity.current_end = '1572892200';
    expect(() => parseRazorpayEvent(body)).toThrow(InvalidPayloadError);
  });

  it('never puts a value from the payload in its error message', () => {
    const body = fixture('subscription.charged.json');
    body.payload.subscription.entity.status = 'gaurav.kumar@example.com';
    expect(() => parseRazorpayEvent(body)).toThrow(/^Invalid Razorpay payload: subscription\.status$/);
  });
});

describe('storedPayload', () => {
  // Keys whose values name a person or a payment instrument, and values from the
  // fixtures that would show one of them survived under another key.
  const FORBIDDEN_KEYS = [
    'card',
    'card_id',
    'last4',
    'vpa',
    'email',
    'contact',
    'bank',
    'wallet',
    'notes',
    'customer_details',
    'acquirer_data',
    'token_id',
    'order',
    'gstin',
    'billing_address',
  ];
  const FORBIDDEN_VALUES = ['gaurav', '9876543210', '9000090000', 'hdfc', 'millennium', '24aabcj1087g1zt', 'mastercard'];

  it.each(WEBHOOKS)('keeps no personal or payment instrument detail of %s', (name) => {
    const stored = JSON.stringify(storedPayload(fixture(name)));
    for (const key of FORBIDDEN_KEYS) expect(stored).not.toContain(`"${key}":`);
    for (const value of FORBIDDEN_VALUES) expect(stored.toLowerCase()).not.toContain(value);
  });

  it('would see those details in the fixtures themselves, so the check above means something', () => {
    const all = WEBHOOKS.map((name) => JSON.stringify(verbatim(name))).join('\n');
    for (const key of ['card', 'vpa', 'email', 'contact', 'bank', 'wallet', 'notes', 'customer_details', 'acquirer_data']) {
      expect(all).toContain(`"${key}":`);
    }
    for (const value of FORBIDDEN_VALUES) expect(all.toLowerCase()).toContain(value);
  });

  it('keeps what the ledger needs, so the stored copy parses to the same event', () => {
    for (const name of WEBHOOKS) {
      const body = fixture(name);
      expect(parseRazorpayEvent(storedPayload(body))).toEqual(parseRazorpayEvent(body));
    }
  });

  it('keeps the allow-listed fields of subscription.charged', () => {
    expect(storedPayload(fixture('subscription.charged.json'))).toEqual({
      event: 'subscription.charged',
      created_at: 1567690383,
      account_id: 'acc_BFQ7uQEaa7j2z7',
      contains: ['subscription', 'payment'],
      payload: {
        subscription: {
          entity: {
            id: 'sub_DEX6xcJ1HSW4CR',
            plan_id: 'plan_BvrFKjSxauOH7N',
            customer_id: 'cust_C0WlbKhp3aLA7W',
            status: 'active',
            current_start: 1570213800,
            current_end: 1572892200,
            start_at: 1570213800,
            end_at: 1599244200,
            charge_at: 1572892200,
            ended_at: null,
            paid_count: 1,
            remaining_count: 11,
            total_count: 12,
            has_scheduled_changes: false,
            change_scheduled_at: null,
            short_url: null,
          },
        },
        payment: {
          entity: {
            id: 'pay_DEXFWroJ6LikKT',
            amount: 100000,
            currency: 'INR',
            status: 'captured',
            method: 'card',
            invoice_id: 'inv_DEXFWVuM6rPqlK',
            order_id: 'order_DEXFWXwO24pDxH',
            customer_id: 'cust_C0WlbKhp3aLA7W',
            amount_refunded: 0,
            refund_status: null,
            captured: '1',
            international: false,
            error_code: null,
            error_description: null,
            created_at: 1567690382,
          },
        },
      },
    });
  });

  it('drops a nested value even under an allowed key', () => {
    const body = fixture('subscription.charged.json');
    body.payload.payment.entity.method = { card: { last4: '5558' } };
    const stored = storedPayload(body) as any;
    expect(stored.payload.payment.entity).not.toHaveProperty('method');
  });

  it('keeps nothing of a body that is not an object', () => {
    expect(storedPayload('{"event":"x"}')).toEqual({});
    expect(storedPayload(null)).toEqual({});
    expect(storedPayload([1, 2])).toEqual({});
  });
});

describe('API reply mapping', () => {
  it('maps the create-subscription reply', () => {
    expect(toProviderSubscription(fixture('subscription.json'))).toEqual({
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

  it('maps the create-plan reply from its item', () => {
    expect(toProviderPlan(fixture('plan.json'))).toEqual({
      id: 'plan_00000000000001',
      period: 'weekly',
      interval: 1,
      amountPaise: 69900,
      currency: 'INR',
    });
  });

  it('maps each invoice in the fetch-invoices reply', () => {
    const invoices = fixture('invoices.list.json').items.map(toProviderInvoice);
    expect(invoices).toHaveLength(2);
    expect(invoices[0]).toMatchObject({
      id: 'inv_00000000000003',
      subscriptionId: 'sub_00000000000001',
      paymentId: 'pay_00000000000002',
      status: 'paid',
      amountPaise: 99900,
      providerTaxPaise: 0,
      billingStart: new Date(1594405800000),
      billingEnd: new Date(1597084200000),
      shortUrl: 'https://rzp.io/i/Ys4feGqEp',
      number: null,
    });
  });
});

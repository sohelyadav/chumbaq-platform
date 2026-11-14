import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { FakeBillingProvider } from '../../test-support/fake-billing-provider';
import { razorpayBody, unix } from '../../test-support/razorpay-fixtures';
import { BillingStateService } from './billing-state.service';
import { BILLING_PROVIDER } from './providers/billing-provider';

const KEY_ID = 'rzp_test_AbC123xyz';
const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';

/**
 * POST /api/billing/webhooks/razorpay on the booted customer API, with Razorpay's
 * documented payloads signed the way Razorpay signs them (hex HMAC-SHA256 of the
 * exact bytes under the webhook secret). The provider is the in-memory fake, which
 * checks signatures with the real code.
 */
describe('billing webhook (integration)', () => {
  let ds: DataSource;
  let booted: BootedApp;
  const logged: string[] = [];
  const hex = (bytes = 6) => randomBytes(bytes).toString('hex');
  const NOW = new Date();

  beforeAll(async () => {
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      const capture = (...args: unknown[]) => {
        logged.push(
          args
            .map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
        );
      };
      jest.spyOn(Logger.prototype, method).mockImplementation(capture);
      jest.spyOn(Logger, method).mockImplementation(capture);
    }
    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    ds = await openIntDb();
    const fake = new FakeBillingProvider({ keyId: KEY_ID, webhookSecret: WEBHOOK_SECRET });
    booted = await bootIntApp('customer', { providers: [{ token: BILLING_PROVIDER, useValue: fake }] });
  });

  afterAll(async () => {
    await booted?.app.close();
    await closeIntDb(ds);
    process.env.RAZORPAY_KEY_ID = '';
    process.env.RAZORPAY_KEY_SECRET = '';
    process.env.RAZORPAY_WEBHOOK_SECRET = '';
    jest.restoreAllMocks();
  });

  const sign = (raw: string, secret = WEBHOOK_SECRET) => createHmac('sha256', secret).update(raw).digest('hex');

  async function post(
    raw: string,
    { signature = sign(raw), eventId = `evt_${hex(7)}` }: { signature?: string | null; eventId?: string | null } = {},
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== null) headers['x-razorpay-signature'] = signature;
    if (eventId !== null) headers['x-razorpay-event-id'] = eventId;
    const res = await fetch(`${booted.base}/api/billing/webhooks/razorpay`, { method: 'POST', headers, body: raw });
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> }, eventId };
  }

  const eventRow = async (eventId: string | null) => {
    const [row] = await ds.query(`SELECT * FROM billing_events WHERE provider_event_id = $1`, [eventId]);
    return row;
  };

  /** An account with a `created` subscription on a scratch plan, as checkout leaves it. */
  async function world() {
    const userId = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'hook')`, [
      userId,
      `hook-${userId}@test.local`,
    ]);
    const plan = `plan_scratch_${hex()}`;
    await ds.query(`INSERT INTO plans (code, name, sort_order) VALUES ($1, 'Hook', 10)`, [plan]);
    const rzpPlan = `plan_${hex(7)}`;
    const [price] = await ds.query(
      `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
       VALUES ($1, 'monthly', 99900, 1800, 117882, $2, true) RETURNING id`,
      [plan, rzpPlan],
    );
    const providerSub = `sub_${hex(7)}`;
    const [sub] = await ds.query(
      `INSERT INTO billing_subscriptions (user_id, provider_subscription_id, price_id, plan_code, interval, status)
       VALUES ($1, $2, $3, $4, 'monthly', 'created') RETURNING id`,
      [userId, providerSub, price.id, plan],
    );
    await ds.query(`INSERT INTO billing_accounts (user_id, next_subscription_id) VALUES ($1, $2)`, [userId, sub.id]);
    return { userId, plan, rzpPlan, providerSub, subId: sub.id as string };
  }

  const charged = (w: { providerSub: string; rzpPlan: string }) =>
    JSON.stringify(
      razorpayBody('subscription.charged', {
        created_at: unix(NOW),
        'payload.subscription.entity.id': w.providerSub,
        'payload.subscription.entity.plan_id': w.rzpPlan,
        'payload.subscription.entity.customer_id': `cust_${hex(7)}`,
        'payload.subscription.entity.current_start': unix(NOW),
        'payload.subscription.entity.current_end': unix(NOW) + 30 * 86400,
        'payload.payment.entity.id': `pay_${hex(7)}`,
        'payload.payment.entity.invoice_id': `inv_${hex(7)}`,
      }),
      null,
      2,
    );

  describe('signatures', () => {
    it('accepts a valid signature and stores the event', async () => {
      const w = await world();
      const sent = await post(charged(w));
      expect(sent.status).toBe(200);
      expect(sent.body.data).toEqual({ received: true });
      expect(await eventRow(sent.eventId)).toMatchObject({ outcome: 'applied', type: 'subscription.charged', attempts: 1 });
    });

    it.each([
      ['an invalid signature', (raw: string) => ({ raw, signature: 'ab'.repeat(32) })],
      ['the wrong secret', (raw: string) => ({ raw, signature: sign(raw, 'another_secret') })],
      ['a body modified after signing', (raw: string) => ({ raw: raw.replace('"active"', '"halted"'), signature: sign(raw) })],
      ['a missing signature header', (raw: string) => ({ raw, signature: null })],
      ['a body re-serialised after signing', (raw: string) => ({ raw: JSON.stringify(JSON.parse(raw)), signature: sign(raw) })],
    ])('refuses %s with 400 and writes nothing', async (_name, tamper) => {
      const w = await world();
      const { raw, signature } = tamper(charged(w));
      const sent = await post(raw, { signature });
      expect(sent.status).toBe(400);
      expect(sent.body.data).toEqual({ received: false });
      expect(await eventRow(sent.eventId)).toBeUndefined();
      const [sub] = await ds.query(`SELECT status FROM billing_subscriptions WHERE id = $1`, [w.subId]);
      expect(sub.status).toBe('created');
    });

    it('refuses a missing or malformed event id with 400', async () => {
      const w = await world();
      expect((await post(charged(w), { eventId: null })).status).toBe(400);
      expect((await post(charged(w), { eventId: 'evt-with-dash' })).status).toBe(400);
      expect((await post(charged(w), { eventId: 'x'.repeat(65) })).status).toBe(400);
    });
  });

  it('replay: the same event id twice applies once', async () => {
    const w = await world();
    const raw = charged(w);
    const first = await post(raw);
    expect(first.status).toBe(200);
    const [before] = await ds.query(`SELECT updated_at FROM billing_subscriptions WHERE id = $1`, [w.subId]);

    const second = await post(raw, { eventId: first.eventId });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ received: true, replay: true });
    expect(await ds.query(`SELECT 1 FROM billing_events WHERE provider_event_id = $1`, [first.eventId])).toHaveLength(1);
    const [after] = await ds.query(`SELECT updated_at FROM billing_subscriptions WHERE id = $1`, [w.subId]);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect((await eventRow(first.eventId)).attempts).toBe(1);
  });

  it('replay: the same signed body under a new event id is the same event, and adds no row', async () => {
    const w = await world();
    const raw = charged(w);
    const first = await post(raw);
    expect(first.body.data).toEqual({ received: true });
    const [{ n: before }] = await ds.query(`SELECT count(*)::int AS n FROM billing_events`);

    // The signature covers the body only: anyone holding one genuine body can post it with any id.
    for (let i = 0; i < 3; i++) {
      const again = await post(raw);
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual({ received: true, replay: true });
      expect(await eventRow(again.eventId)).toBeUndefined();
    }
    const [{ n: after }] = await ds.query(`SELECT count(*)::int AS n FROM billing_events`);
    expect(after).toBe(before);
    expect((await eventRow(first.eventId)).body_sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('replay: a signed body it could not read, posted again under a new id, adds no row', async () => {
    const raw = `{"event": "x", "unreadable": "${hex()}"}`;
    const first = await post(raw);
    expect(first.status).toBe(200);
    const again = await post(raw);
    expect(again.status).toBe(200);
    expect(await eventRow(again.eventId)).toBeUndefined();
  });

  describe('foreign events', () => {
    it.each([
      [
        'an unknown subscription',
        () =>
          razorpayBody('subscription.activated', {
            'payload.subscription.entity.id': `sub_${hex(7)}`,
            'payload.payment.entity.id': `pay_${hex(7)}`,
          }),
        'unknown subscription',
      ],
      ['a payment that matches no account', () => razorpayBody('payment.failed', { 'payload.payment.entity.id': `pay_${hex(7)}` }), 'not ours'],
      ['an event type billing does not use', () => razorpayBody('payment.downtime.started'), 'unhandled type'],
    ])('stores %s as ignored and answers 200', async (_name, build, detail) => {
      const sent = await post(JSON.stringify(build()));
      expect(sent.status).toBe(200);
      expect(await eventRow(sent.eventId)).toMatchObject({ outcome: 'ignored', detail, attempts: 1, applied_at: null });
    });

    it('stores a known subscription on an unknown plan as ignored', async () => {
      const w = await world();
      const sent = await post(charged({ providerSub: w.providerSub, rzpPlan: `plan_${hex(7)}` }));
      expect(sent.status).toBe(200);
      expect(await eventRow(sent.eventId)).toMatchObject({ outcome: 'ignored', detail: 'unknown plan' });
    });

    it('stores a signed body it cannot read as ignored, so the provider stops retrying it', async () => {
      const shapeless = await post(JSON.stringify({ event: 'subscription.charged' }));
      expect(shapeless.status).toBe(200);
      expect(shapeless.body.data).toEqual({ received: true });
      expect(await eventRow(shapeless.eventId)).toMatchObject({
        outcome: 'ignored',
        type: 'invalid',
        detail: 'invalid payload',
        payload: {},
      });
      // Not JSON at all: the JSON body parser refuses it before the route, and nothing is stored.
      const junk = await post('{"event": 42');
      expect(junk.status).toBe(400);
      expect(await eventRow(junk.eventId)).toBeUndefined();
    });
  });

  it('answers 500 when applying fails, and applies the retry of the same event', async () => {
    const w = await world();
    const raw = charged(w);
    const state = booted.app.get(BillingStateService);
    const spy = jest.spyOn(state, 'apply').mockRejectedValueOnce(new Error('database went away'));

    const first = await post(raw);
    expect(first.status).toBe(500);
    expect(await eventRow(first.eventId)).toMatchObject({ outcome: 'failed', attempts: 1, applied_at: null });
    expect((await eventRow(first.eventId)).detail).toContain('database went away');

    const retry = await post(raw, { eventId: first.eventId });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toEqual({ received: true });
    expect(await eventRow(first.eventId)).toMatchObject({ outcome: 'applied', attempts: 2, detail: null });
    const [sub] = await ds.query(`SELECT status FROM billing_subscriptions WHERE id = $1`, [w.subId]);
    expect(sub.status).toBe('active');
    spy.mockRestore();
  });

  it('stores no card or contact details from a charged delivery', async () => {
    const w = await world();
    const sent = await post(charged(w));
    const stored = JSON.stringify((await eventRow(sent.eventId)).payload);
    expect(stored).toContain(w.providerSub);
    // `"method":"card"` is kept: the method's name only, never the card.
    expect(stored).toContain('"method":"card"');
    for (const forbidden of ['"card":', '"card_id"', '"email"', '"contact"', 'gaurav', '9876543210', '"notes"', 'last4']) {
      expect(stored).not.toContain(forbidden);
    }
  });

  it('logs no secret and no part of a body', async () => {
    const w = await world();
    const raw = charged(w);
    await post(raw, { signature: 'ab'.repeat(32) });
    await post(raw);
    await post('{"event": 42');
    const all = logged.join('\n');
    expect(all).not.toContain(WEBHOOK_SECRET);
    expect(all).not.toContain(KEY_SECRET);
    expect(all).not.toContain(w.providerSub);
    expect(all).not.toContain('gaurav');
    expect(all).not.toContain('"event": 42');
  });
});

import { randomBytes } from 'crypto';
import http from 'http';

/**
 * A stand-in for the part of Razorpay's REST API the billing module calls, reached
 * through `RAZORPAY_API_BASE_URL` (allowed only in development and test). It answers
 * in Razorpay's documented shapes, checks the Basic auth pair the API was started
 * with, and keeps everything in memory for one run.
 *
 * State moves only by the test: subscriptions stay as created until a test sends the
 * signed webhook that would have come from Razorpay, which is what the API trusts.
 * Plans are registered by the test (`POST /__mock/plans`) before staff add a price,
 * since the API fetches the plan to check its amount.
 *
 * Control routes under `/__mock` are for the tests only.
 */

interface MockPlan {
  id: string;
  period: 'monthly' | 'yearly';
  amount: number;
}

type Raw = Record<string, unknown>;

export interface RazorpayMock {
  url: string;
  close(): Promise<void>;
}

const id = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

export async function startRazorpayMock(port: number, keyId: string, keySecret: string): Promise<RazorpayMock> {
  const expectedAuth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const plans = new Map<string, MockPlan>();
  const customers = new Map<string, Raw>();
  const subscriptions = new Map<string, Raw>();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const fail = (status: number, description: string) =>
        send(status, { error: { code: 'BAD_REQUEST_ERROR', description } });
      let body: Raw = {};
      try {
        body = raw ? (JSON.parse(raw) as Raw) : {};
      } catch {
        return fail(400, 'invalid JSON');
      }
      const url = new URL(req.url ?? '/', 'http://mock');
      const method = req.method ?? 'GET';
      const p = url.pathname;

      // Test controls.
      if (p === '/__mock/plans' && method === 'POST') {
        const plan = body as unknown as MockPlan;
        plans.set(plan.id, plan);
        return send(200, plan);
      }
      if (p === '/__mock/calls' && method === 'GET') return send(200, calls);
      const subControl = /^\/__mock\/subscriptions\/([^/]+)$/.exec(p);
      if (subControl && method === 'GET') {
        const s = subscriptions.get(subControl[1]);
        return s ? send(200, s) : fail(404, 'no such subscription');
      }
      if (subControl && method === 'PATCH') {
        const s = subscriptions.get(subControl[1]);
        if (!s) return fail(404, 'no such subscription');
        Object.assign(s, body);
        return send(200, s);
      }

      if (!p.startsWith('/v1/')) return fail(404, 'not found');
      if (req.headers.authorization !== expectedAuth) {
        return send(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
      }
      calls.push({ method, path: `${p}${url.search}`, body });

      if (p === '/v1/customers' && method === 'POST') {
        const customer = {
          id: id('cust'),
          entity: 'customer',
          name: body.name,
          email: body.email,
          contact: null,
          gstin: body.gstin ?? null,
          notes: body.notes ?? [],
          created_at: now(),
        };
        customers.set(customer.id, customer);
        return send(200, customer);
      }
      const customer = /^\/v1\/customers\/([^/]+)$/.exec(p);
      if (customer && method === 'PUT') {
        const c = customers.get(customer[1]);
        if (!c) return fail(404, 'The id provided does not exist');
        c.name = body.name;
        return send(200, c);
      }
      const plan = /^\/v1\/plans\/([^/]+)$/.exec(p);
      if (plan && method === 'GET') {
        const found = plans.get(plan[1]);
        if (!found) return fail(400, 'The id provided does not exist');
        return send(200, {
          id: found.id,
          entity: 'plan',
          interval: 1,
          period: found.period,
          item: { id: id('item'), active: true, name: found.id, amount: found.amount, unit_amount: found.amount, currency: 'INR' },
          notes: [],
          created_at: now(),
        });
      }
      if (p === '/v1/subscriptions' && method === 'POST') {
        if (!plans.has(String(body.plan_id))) return fail(400, 'The id provided does not exist');
        const startAt = typeof body.start_at === 'number' ? body.start_at : null;
        const subscription: Raw = {
          id: id('sub'),
          entity: 'subscription',
          plan_id: body.plan_id,
          customer_id: null,
          status: 'created',
          current_start: null,
          current_end: null,
          ended_at: null,
          quantity: 1,
          notes: body.notes ?? [],
          charge_at: startAt ?? now(),
          start_at: startAt ?? now(),
          end_at: null,
          auth_attempts: 0,
          total_count: body.total_count,
          paid_count: 0,
          customer_notify: true,
          created_at: now(),
          expire_by: body.expire_by ?? null,
          short_url: null,
          has_scheduled_changes: false,
          change_scheduled_at: null,
          source: 'api',
          remaining_count: body.total_count,
        };
        subscriptions.set(subscription.id as string, subscription);
        return send(200, subscription);
      }
      const sub = /^\/v1\/subscriptions\/([^/]+)(\/cancel)?$/.exec(p);
      if (sub) {
        const s = subscriptions.get(sub[1]);
        if (!s) return fail(400, 'The id provided does not exist');
        if (!sub[2] && method === 'GET') return send(200, s);
        if (sub[2] && method === 'POST') {
          // At cycle end Razorpay keeps the status and ends it later; now, it ends at once.
          if (body.cancel_at_cycle_end === true) {
            s.has_scheduled_changes = false;
          } else {
            s.status = 'cancelled';
            s.ended_at = now();
          }
          return send(200, s);
        }
      }
      if (p === '/v1/invoices' && method === 'GET') {
        return send(200, { entity: 'collection', count: 0, items: [] });
      }
      const notify = /^\/v1\/invoices\/([^/]+)\/notify_by\/email$/.exec(p);
      if (notify && method === 'POST') return send(200, { success: true });

      return fail(404, `mock has no route for ${method} ${p}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

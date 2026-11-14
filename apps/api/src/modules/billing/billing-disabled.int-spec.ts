import { createHmac, randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { BootedApp, bootIntApp, listRoutes } from '../../test-support/int-apps';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { razorpayBody, unix } from '../../test-support/razorpay-fixtures';
import type { BillingConfig } from '../../config/billing.config';

const DOMAIN = '@billing-disabled-int.test';

/**
 * A self-hosted install: no Razorpay keys at all, as the local .env has. Every billing
 * route answers 404 (the webhook too, writing nothing), the dashboard is told billing
 * is off, and project limits are the install's, whatever the free plan row says.
 */
describe('billing disabled (integration)', () => {
  let ds: DataSource;
  let booted: BootedApp;
  let freeProjectLimit: number | null;
  const jwt = () => new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '15m' } });

  beforeAll(async () => {
    ds = await openIntDb();
    // The point of this file: no key set (int-env.ts blanks any the .env file has).
    for (const name of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
      expect([name, process.env[name] || undefined]).toEqual([name, undefined]);
    }
    booted = await bootIntApp('customer');
    expect(booted.app.get(ConfigService).get<BillingConfig>('billing')?.enabled).toBe(false);
    [{ project_limit: freeProjectLimit }] = await ds.query(`SELECT project_limit FROM plans WHERE code = 'free'`);
  });

  afterAll(async () => {
    await ds?.query(`UPDATE plans SET project_limit = $1 WHERE code = 'free'`, [freeProjectLimit]);
    await booted?.app.close();
    await closeIntDb(ds);
  });

  async function user() {
    const id = randomUUID();
    const email = `owner-${id.slice(0, 8)}${DOMAIN}`;
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'Owner')`, [id, email]);
    const token = await jwt().signAsync({
      sub: id,
      email,
      type: 'access',
      sv: 0,
      amr: ['pwd'],
      auth_time: Math.floor(Date.now() / 1000),
    });
    return { id, email, token };
  }

  it('answers 404 on every billing route, the webhook included, and writes no event', async () => {
    const { token } = await user();
    const routes = listRoutes(booted.app).filter((r) => r.path.startsWith('/api/billing'));
    expect(routes.map((r) => r.key)).toEqual(
      expect.arrayContaining(['GET /api/billing', 'POST /api/billing/subscribe', 'POST /api/billing/webhooks/razorpay']),
    );
    const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const raw = JSON.stringify(razorpayBody('subscription.charged', { created_at: unix(new Date()) }));
    for (const r of routes) {
      const webhook = r.path.includes('/webhooks/');
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (webhook) {
        headers['x-razorpay-signature'] = createHmac('sha256', 'any_secret').update(raw).digest('hex');
        headers['x-razorpay-event-id'] = eventId;
      } else {
        headers.authorization = `Bearer ${token}`;
      }
      const res = await fetch(`${booted.base}${r.path}`, {
        method: r.method,
        headers,
        body: r.method === 'GET' ? undefined : webhook ? raw : JSON.stringify({ plan: 'x_plan', interval: 'monthly' }),
      });
      expect([r.key, res.status]).toEqual([r.key, 404]);
    }
    // And without a token: the 404 comes before authentication, so nothing says billing exists.
    expect((await fetch(`${booted.base}/api/billing`)).status).toBe(404);
    const rows = await ds.query(`SELECT 1 FROM billing_events WHERE provider_event_id = $1`, [eventId]);
    expect(rows).toHaveLength(0);
  });

  it('tells the dashboard billing is off', async () => {
    const { token } = await user();
    const res = await fetch(`${booted.base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { billingEnabled: unknown } }).data.billingEnabled).toBe(false);
  });

  it("keeps the install's project limit, ignoring the free plan's", async () => {
    await ds.query(`UPDATE plans SET project_limit = 1 WHERE code = 'free'`);
    const { token } = await user();
    for (const name of ['first', 'second']) {
      const res = await fetch(`${booted.base}/api/projects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect([name, res.status]).toEqual([name, 201]);
    }
    const list = await fetch(`${booted.base}/api/projects`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await list.json()) as { meta: { projectLimit: number } };
    expect(body.meta.projectLimit).toBe(Number(process.env.MAX_PROJECTS_PER_ACCOUNT ?? 10));
  });
});

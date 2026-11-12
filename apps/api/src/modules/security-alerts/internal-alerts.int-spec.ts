import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';

/**
 * The route server scripts (SSH login, fail2ban, AIDE) call to raise an alarm. The admin
 * API listens on 127.0.0.1 and nginx refuses /api/internal/, so the token is the last
 * line; with no token configured the route does not answer at all.
 */
describe('POST /api/internal/security-alerts', () => {
  let ds: DataSource;
  let admin: BootedApp;
  let customer: BootedApp;
  const TOKEN = `t-${randomUUID()}`;

  const post = (base: string, body: unknown, token?: string) =>
    fetch(`${base}/api/internal/security-alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-security-alert-token': token } : {}) },
      body: JSON.stringify(body),
    });

  const rowsFor = (key: string) => ds.query(`SELECT kind, details, ip_address FROM security_alerts WHERE dedupe_key = $1`, [key]);

  beforeAll(async () => {
    ds = await openIntDb();
    process.env.SECURITY_ALERT_TOKEN = TOKEN;
    admin = await bootIntApp('admin');
    customer = await bootIntApp('customer');
  }, 120000);

  afterAll(async () => {
    delete process.env.SECURITY_ALERT_TOKEN;
    await admin?.app.close();
    await customer?.app.close();
    await closeIntDb(ds);
  });

  afterEach(() => {
    process.env.SECURITY_ALERT_TOKEN = TOKEN;
  });

  it('raises a server alarm with the right token', async () => {
    const key = `ubuntu@${randomUUID()}`;
    const res = await post(admin.base, { kind: 'server.ssh_login', key, details: { user: 'ubuntu' }, ip: '198.51.100.7' }, TOKEN);

    expect(res.status).toBe(202);
    expect(await rowsFor(key)).toEqual([{ kind: 'server.ssh_login', details: { user: 'ubuntu' }, ip_address: '198.51.100.7' }]);
  });

  it('refuses a missing or wrong token and records nothing', async () => {
    const key = randomUUID();
    expect((await post(admin.base, { kind: 'server.ssh_login', key })).status).toBe(401);
    expect((await post(admin.base, { kind: 'server.ssh_login', key }, `${TOKEN}x`)).status).toBe(401);
    expect(await rowsFor(key)).toEqual([]);
  });

  it('does not answer at all when no token is configured', async () => {
    process.env.SECURITY_ALERT_TOKEN = '';
    const key = randomUUID();
    expect((await post(admin.base, { kind: 'server.ssh_login', key }, '')).status).toBe(404);
    expect((await post(admin.base, { kind: 'server.ssh_login', key }, TOKEN)).status).toBe(404);
    expect(await rowsFor(key)).toEqual([]);
  });

  it('accepts only server alarms, with bounded details', async () => {
    const key = randomUUID();
    expect((await post(admin.base, { kind: 'tripwire.api_key', key }, TOKEN)).status).toBe(400);
    expect((await post(admin.base, { kind: 'server.ssh_login', key: 'x'.repeat(201) }, TOKEN)).status).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect((await post(admin.base, { kind: 'server.files_changed', key, details: many }, TOKEN)).status).toBe(400);
    expect((await post(admin.base, { kind: 'server.files_changed', key, details: { path: 'x'.repeat(501) } }, TOKEN)).status).toBe(400);
    expect((await post(admin.base, { kind: 'server.files_changed', key, details: { n: 3 } }, TOKEN)).status).toBe(400);
    expect(await rowsFor(key)).toEqual([]);
  });

  it('does not answer a request that came through a proxy, even with the token', async () => {
    const key = randomUUID();
    for (const header of ['x-forwarded-for', 'x-real-ip']) {
      const res = await fetch(`${admin.base}/api/internal/security-alerts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-security-alert-token': TOKEN, [header]: '203.0.113.5' },
        body: JSON.stringify({ kind: 'server.ssh_login', key }),
      });
      expect({ header, status: res.status }).toEqual({ header, status: 404 });
    }
    expect(await rowsFor(key)).toEqual([]);
  });

  it('is not served by the customer API', async () => {
    expect((await post(customer.base, { kind: 'server.ssh_login', key: 'k' }, TOKEN)).status).toBe(404);
  });
});

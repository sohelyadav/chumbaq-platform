import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';

const DOMAIN = '@staff-auth-throttle-int.test';

/**
 * The per-address throttle on staff sign-in, with the real throttler. In a file of its
 * own: every other spec turns the throttle off, and closing a second app booted in the
 * same file ends the database connection the first one uses.
 */
describe('Staff sign-in throttle (integration)', () => {
  let ds: DataSource;
  let admin: BootedApp;

  beforeAll(async () => {
    ds = await openIntDb();
    admin = await bootIntApp('admin', { throttle: true });
  }, 120000);

  afterAll(async () => {
    await admin?.app.close();
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
  });

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${admin.base}/api/staff/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chumbaq-client': 'admin' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  it('takes five password tries a minute from one address, whatever the account', async () => {
    // A fresh account each time, so the per-account lockout in auth_events cannot be
    // what answers: only the route's own limit sees all six.
    const attempt = () => post('/login', { email: `nobody-${randomUUID()}${DOMAIN}`, password: 'nope' });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);

    // The limit is the route's own, not the app-wide default (100 a minute).
    expect((await post('/passkey/options', {})).status).toBe(200);
  });
});

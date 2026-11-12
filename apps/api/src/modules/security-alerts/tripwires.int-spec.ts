import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';
import { issueStaffSessionForTest } from '../../test-support/staff-session';

const DOMAIN = '@tripwires-int.test';

/**
 * Trap data: a fake API key and a watched email address. Touching either raises an
 * alarm, and the answer is exactly what any wrong key or unknown address gets.
 */
describe('tripwires (integration)', () => {
  let ds: DataSource;
  let customer: BootedApp;
  let admin: BootedApp;
  let staffToken: string;
  let since: Date;

  const adminCall = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${admin.base}/api/admin${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${staffToken}`,
        'x-chumbaq-client': 'admin',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as { data?: any } | null,
    };
  };
  const customerCall = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${customer.base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-chumbaq-client': 'dashboard',
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // Error bodies carry the time they were made; the rest must match exactly.
    if (answer) delete answer.timestamp;
    return { status: res.status, body: answer };
  };

  /** Alarms of this kind raised since the test began; they land just after the answer. */
  const alarms = async (kind: string, expectAtLeast = 1) => {
    let rows: {
      dedupe_key: string;
      details: Record<string, unknown>;
      ip_address: string | null;
    }[] = [];
    for (let i = 0; i < 40; i++) {
      rows = await ds.query(
        `SELECT dedupe_key, details, ip_address FROM security_alerts WHERE kind = $1 AND first_at >= $2 ORDER BY first_at`,
        [kind, since],
      );
      if (rows.length >= expectAtLeast) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return rows;
  };

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    const [staff] = await ds.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin) VALUES ($1, 'x', 'Staff', true)
       RETURNING id, email, session_version`,
      [`staff${DOMAIN}`],
    );
    staffToken = (
      await issueStaffSessionForTest(ds, {
        id: staff.id,
        email: staff.email,
        sessionVersion: staff.session_version,
      })
    ).accessToken;
    customer = await bootIntApp('customer');
    admin = await bootIntApp('admin');
  }, 120000);

  afterAll(async () => {
    await customer?.app.close();
    await admin?.app.close();
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    [{ now: since }] = await ds.query(`SELECT now() AS now`);
  });

  describe('the trap API key', () => {
    it('is shown once, looks like a real key, and is listed without it', async () => {
      const created = await adminCall('POST', '/tripwires/api-key', {
        label: 'fake .env.backup',
      });
      expect(created.status).toBe(201);
      expect(created.body!.data.key).toMatch(/^chumbaq_[0-9a-f]{64}$/);
      const listed = await adminCall('GET', '/tripwires');
      const row = listed.body!.data.find((t: { id: string }) => t.id === created.body!.data.id);
      expect(row).toEqual({
        id: created.body!.data.id,
        kind: 'api_key',
        label: 'fake .env.backup',
        createdAt: expect.any(String),
        revokedAt: null,
      });
      expect(JSON.stringify(listed.body)).not.toContain(created.body!.data.key);
    });

    it('gets the same 401 as any wrong key, and raises tripwire.api_key with the route and address', async () => {
      const { body } = await adminCall('POST', '/tripwires/api-key', {
        label: 'repo note',
      });
      const random = await customerCall('POST', '/conversions', {}, { 'x-api-key': `chumbaq_${'0'.repeat(64)}` });
      const trapped = await customerCall('POST', '/conversions', {}, { 'x-api-key': body!.data.key });

      expect(trapped).toEqual(random);
      expect(trapped.status).toBe(401);
      const rows = await alarms('tripwire.api_key');
      expect(rows).toEqual([
        {
          dedupe_key: body!.data.id,
          details: { label: 'repo note', route: 'POST /api/conversions' },
          ip_address: expect.any(String),
        },
      ]);
    });

    it('raises nothing once revoked', async () => {
      const { body } = await adminCall('POST', '/tripwires/api-key', {
        label: 'old',
      });
      expect((await adminCall('POST', `/tripwires/${body!.data.id}/revoke`)).status).toBe(201);
      await customerCall('POST', '/conversions', {}, { 'x-api-key': body!.data.key });
      await new Promise((r) => setTimeout(r, 300));
      expect(await ds.query(`SELECT 1 FROM security_alerts WHERE dedupe_key = $1`, [body!.data.id])).toEqual([]);
    });
  });

  describe('the trap account', () => {
    let trap: string;
    let trapId: string;

    beforeAll(async () => {
      trap = `canary-${randomUUID().slice(0, 8)}${DOMAIN}`;
      const created = await adminCall('POST', '/tripwires/account', {
        email: trap,
        label: 'canary inbox',
      });
      expect(created.status).toBe(201);
      trapId = created.body!.data.id;
    });

    it('is never a user', async () => {
      expect(await ds.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [trap])).toEqual([]);
    });

    it('a sign-in attempt, in any case, gets the usual refusal and raises sign_in', async () => {
      const unknown = await customerCall('POST', '/auth/login', {
        email: `nobody-${randomUUID().slice(0, 6)}${DOMAIN}`,
        password: 'x'.repeat(12),
      });
      const trapped = await customerCall('POST', '/auth/login', {
        email: trap.toUpperCase(),
        password: 'x'.repeat(12),
      });
      expect(trapped).toEqual(unknown);
      expect((await alarms('tripwire.account')).map((r) => [r.dedupe_key, r.details])).toEqual([
        [`${trapId}:sign_in`, { label: 'canary inbox', action: 'sign_in' }],
      ]);
    });

    it('a password reset gets the usual answer and raises password_reset', async () => {
      const trapped = await customerCall('POST', '/auth/forgot-password', {
        email: trap,
      });
      expect(trapped.status).toBe(200);
      expect((await alarms('tripwire.account')).map((r) => r.details.action)).toEqual(['password_reset']);
    });

    it('a sign-up is refused as for a taken address, creates no user, and raises sign_up', async () => {
      const taken = await customerCall('POST', '/auth/register', {
        email: `staff${DOMAIN}`,
        password: 'Str0ng-passphrase!',
        name: 'X',
      });
      const trapped = await customerCall('POST', '/auth/register', {
        email: trap,
        password: 'Str0ng-passphrase!',
        name: 'X',
      });
      expect(trapped).toEqual(taken);
      expect(trapped.status).toBe(409);
      expect(await ds.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [trap])).toEqual([]);
      expect((await alarms('tripwire.account')).map((r) => r.details.action)).toEqual(['sign_up']);
    });

    it('an invite raises invite', async () => {
      const email = `owner-${randomUUID().slice(0, 8)}${DOMAIN}`;
      const [owner] = await ds.query(
        `INSERT INTO users (email, password_hash, name, email_verified_at) VALUES ($1, 'x', 'O', now()) RETURNING id`,
        [email],
      );
      const [project] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('Trap', $1) RETURNING id`, [
        owner.id,
      ]);
      await addOwnerMember(ds, project.id, owner.id);
      const token = await new JwtService({
        secret: process.env.JWT_SECRET as string,
      }).signAsync(
        {
          sub: owner.id,
          email,
          type: 'access',
          auth_time: Math.floor(Date.now() / 1000),
        },
        { expiresIn: '15m' },
      );
      await customerCall(
        'POST',
        `/projects/${project.id}/invitations`,
        { email: trap, role: 'member' },
        { authorization: `Bearer ${token}` },
      );
      expect((await alarms('tripwire.account')).map((r) => r.details.action)).toEqual(['invite']);
    });
  });

  it('only staff may manage tripwires', async () => {
    const res = await fetch(`${admin.base}/api/admin/tripwires`, {
      headers: { 'x-chumbaq-client': 'admin' },
    });
    expect(res.status).toBe(401);
  });
});

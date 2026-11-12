import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';
import type { SecurityAlertsService } from '../security-alerts/security-alerts.service';
import { StaffAlarmsService } from './staff-alarms.service';

const DOMAIN = '@staff-alarms-int.test';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

/** Staff sign-in alarms: a new device, and repeated failures by email or by address. */
describe('staff sign-in alarms', () => {
  let ds: DataSource;
  let raised: { kind: string; key: string; details: Record<string, unknown>; ip: string | null }[];
  const alerts = {
    raise: jest.fn(async (kind: string, key: string, details: Record<string, unknown>, ip: string | null = null) => {
      raised.push({ kind, key, details, ip });
    }),
  } as unknown as SecurityAlertsService;
  const service = () => new StaffAlarmsService(ds, alerts);

  const staff = async () => {
    const email = `s-${randomUUID().slice(0, 8)}${DOMAIN}`;
    const [row] = await ds.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin) VALUES ($1, 'x', 'S', true) RETURNING id`,
      [email],
    );
    return { id: row.id as string, email };
  };
  const session = async (userId: string, userAgent: string | null) => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO staff_sessions (id, user_id, amr, authenticated_at, session_version, enrolment_only, user_agent)
       VALUES ($1, $2, '["webauthn"]', now(), 0, false, $3)`,
      [id, userId, userAgent],
    );
    return id;
  };
  const failure = (user: { id: string; email: string }, ip: string) =>
    ds.query(
      `INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_type, target_id, target_label, ip_address)
       VALUES ($1, $2, 'staff.sign_in_failed', 'user', $1, $2, $3)`,
      [user.id, user.email, ip],
    );

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
  });

  beforeEach(() => {
    raised = [];
  });

  describe('a new device', () => {
    it('raises nothing on a first-ever staff sign-in', async () => {
      const user = await staff();
      const now = await session(user.id, CHROME_MAC);
      await service().signedIn(user, now, { ipAddress: '203.0.113.1', userAgent: CHROME_MAC });
      expect(raised).toEqual([]);
    });

    it('raises nothing on a device used before', async () => {
      const user = await staff();
      await session(user.id, CHROME_MAC);
      const now = await session(user.id, CHROME_MAC.replace('130.0.0.0', '131.0.0.0'));
      await service().signedIn(user, now, { ipAddress: '203.0.113.1', userAgent: CHROME_MAC });
      expect(raised).toEqual([]);
    });

    it('raises staff.new_device for a device family not seen before', async () => {
      const user = await staff();
      await session(user.id, CHROME_MAC);
      const now = await session(user.id, FIREFOX_WINDOWS);
      await service().signedIn(user, now, { ipAddress: '203.0.113.2', userAgent: FIREFOX_WINDOWS });
      expect(raised).toEqual([
        {
          kind: 'staff.new_device',
          key: `${user.id}:Firefox on Windows`,
          details: { email: user.email, device: 'Firefox on Windows' },
          ip: '203.0.113.2',
        },
      ]);
    });

    it('raises nothing when the device cannot be named', async () => {
      const user = await staff();
      await session(user.id, CHROME_MAC);
      const now = await session(user.id, 'curl/8.4.0');
      await service().signedIn(user, now, { ipAddress: '203.0.113.3', userAgent: 'curl/8.4.0' });
      expect(raised).toEqual([]);
    });
  });

  describe('repeated failures', () => {
    it('raises for 5 failures on one email in 15 minutes, and not for 4', async () => {
      const user = await staff();
      // A fresh range each run: earlier runs' rows are still inside the window.
      const net = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      for (let i = 0; i < 4; i++) await failure(user, `${net}.${i + 10}`);
      await service().failed(user.email, `${net}.13`);
      expect(raised).toEqual([]);

      await failure(user, `${net}.14`);
      await service().failed(user.email, `${net}.14`);
      expect(raised).toEqual([
        {
          kind: 'staff.failed_sign_ins',
          key: `email:${user.email}`,
          details: { email: user.email, failures: 5 },
          ip: `${net}.14`,
        },
      ]);
    });

    it('raises for 5 failures from one address across emails', async () => {
      const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      const users = await Promise.all([staff(), staff(), staff()]);
      for (const [i, u] of [0, 1, 2, 0, 1].entries()) {
        await failure(users[u], ip);
        void i;
      }
      await service().failed(users[1].email, ip);
      expect(raised).toEqual([
        { kind: 'staff.failed_sign_ins', key: `ip:${ip}`, details: { ip, failures: 5 }, ip },
      ]);
    });

    it('ignores failures older than 15 minutes', async () => {
      const user = await staff();
      const oldIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`;
      for (let i = 0; i < 5; i++) {
        await ds.query(
          `INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_type, target_id, target_label, ip_address, created_at)
           VALUES ($1, $2, 'staff.sign_in_failed', 'user', $1, $2, $3, now() - interval '16 minutes')`,
          [user.id, user.email, oldIp],
        );
      }
      await service().failed(user.email, oldIp);
      expect(raised).toEqual([]);
    });
  });

  describe('wired into staff sign-in', () => {
    let admin: BootedApp;

    beforeAll(async () => {
      admin = await bootIntApp('admin');
    }, 120000);

    afterAll(async () => {
      await admin?.app.close();
    });

    it('five wrong passwords for a staff email raise the alarm in security_alerts', async () => {
      const email = `wired-${randomUUID().slice(0, 8)}${DOMAIN}`;
      await ds.query(
        `INSERT INTO users (email, password_hash, name, is_super_admin) VALUES ($1, $2, 'W', true)`,
        [email, await bcrypt.hash('right password', 4)],
      );
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${admin.base}/api/staff/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-chumbaq-client': 'admin' },
          body: JSON.stringify({ email, password: 'wrong password' }),
        });
        expect(res.status).toBe(401);
      }
      // Raised off the request path, so it lands just after the fifth answer.
      let rows: unknown[] = [];
      for (let i = 0; i < 40 && rows.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        rows = await ds.query(`SELECT kind, count FROM security_alerts WHERE dedupe_key = $1`, [`email:${email}`]);
      }
      expect(rows).toEqual([{ kind: 'staff.failed_sign_ins', count: 1 }]);
    });
  });
});

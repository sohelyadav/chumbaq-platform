import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import type { PlatformEmail, PlatformEmailResult, PlatformEmailService } from '../platform-email/platform-email.service';
import { SecurityAlertsService } from './security-alerts.service';

/**
 * Alarms against the real table, because the dedupe window, the lock that keeps two
 * first raises from both inserting, and the append-only trigger all live in Postgres.
 * Rows are never deleted (the trigger refuses), so each test uses its own key.
 */
describe('SecurityAlertsService (integration)', () => {
  let ds: DataSource;
  let sent: PlatformEmail[];
  let answer: PlatformEmailResult;
  const STAFF_A = randomUUID();
  const STAFF_B = randomUUID();
  const SUSPENDED = randomUUID();
  const CUSTOMER = randomUUID();

  const email = {
    send: jest.fn(async (message: PlatformEmail) => {
      sent.push(message);
      return answer;
    }),
  } as unknown as PlatformEmailService;

  const service = () =>
    new SecurityAlertsService(ds, email, new ConfigService({ ADMIN_APP_URL: 'https://admin.example.com' }));

  const rowsFor = (key: string) =>
    ds.query(
      `SELECT kind, dedupe_key, details, ip_address, count, emailed_at, email_failed
         FROM security_alerts WHERE dedupe_key = $1 ORDER BY first_at`,
      [key],
    );

  const sentTo = () => sent.map((m) => m.to);

  beforeAll(async () => {
    ds = await openIntDb();
    const user = (id: string, email: string, admin: boolean, suspended: boolean) =>
      ds.query(
        `INSERT INTO users (id, email, password_hash, name, is_super_admin, suspended_at)
         VALUES ($1, $2, 'x', 'n', $3, ${suspended ? 'now()' : 'NULL'})`,
        [id, email, admin],
      );
    await user(STAFF_A, `alarm-a-${STAFF_A}@staff.test`, true, false);
    await user(STAFF_B, `alarm-b-${STAFF_B}@staff.test`, true, false);
    await user(SUSPENDED, `alarm-s-${SUSPENDED}@staff.test`, true, true);
    await user(CUSTOMER, `alarm-c-${CUSTOMER}@customer.test`, false, false);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [[STAFF_A, STAFF_B, SUSPENDED, CUSTOMER]]);
    await closeIntDb(ds);
  });

  beforeEach(() => {
    sent = [];
    answer = { sent: true };
    jest.clearAllMocks();
  });

  it('records an alarm and emails every active staff member, and no one else', async () => {
    const key = randomUUID();
    await service().raise('tripwire.api_key', key, { label: 'fake env file', route: '/api/events' }, '203.0.113.9');

    expect(await rowsFor(key)).toEqual([
      expect.objectContaining({
        kind: 'tripwire.api_key',
        details: { label: 'fake env file', route: '/api/events' },
        ip_address: '203.0.113.9',
        count: 1,
        emailed_at: expect.any(Date),
        email_failed: false,
      }),
    ]);
    expect(sentTo()).toEqual(
      expect.arrayContaining([`alarm-a-${STAFF_A}@staff.test`, `alarm-b-${STAFF_B}@staff.test`]),
    );
    expect(sentTo()).not.toContain(`alarm-s-${SUSPENDED}@staff.test`);
    expect(sentTo()).not.toContain(`alarm-c-${CUSTOMER}@customer.test`);
    const mine = sent.find((m) => m.to === `alarm-a-${STAFF_A}@staff.test`)!;
    expect(mine.subject).toMatch(/^Chumbaq security alarm: /);
    expect(mine.text).toContain('203.0.113.9');
    expect(mine.text).toContain('IST');
    expect(mine.text).toContain('UTC');
    expect(mine.text).toContain('https://admin.example.com/incidents');
  });

  it('counts a repeat within 15 minutes on the same row and emails nothing more', async () => {
    const key = randomUUID();
    await service().raise('server.ssh_banned', key, { ip: '198.51.100.1' });
    sent = [];
    await service().raise('server.ssh_banned', key, { ip: '198.51.100.1' });

    expect(await rowsFor(key)).toEqual([expect.objectContaining({ count: 2 })]);
    expect(sent).toEqual([]);
  });

  it('starts a new row and emails again once the 15 minutes are over', async () => {
    const key = randomUUID();
    await ds.query(
      `INSERT INTO security_alerts (kind, dedupe_key, details, first_at, last_at, emailed_at)
       VALUES ('server.ssh_login', $1, '{}', now() - interval '16 minutes', now() - interval '16 minutes', now() - interval '16 minutes')`,
      [key],
    );

    await service().raise('server.ssh_login', key, { user: 'ubuntu' });

    expect(await rowsFor(key)).toHaveLength(2);
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the same key for another kind apart', async () => {
    const key = randomUUID();
    await service().raise('staff.new_device', key, {});
    await service().raise('staff.failed_sign_ins', key, {});

    expect((await rowsFor(key)).map((r: { kind: string }) => r.kind).sort()).toEqual([
      'staff.failed_sign_ins',
      'staff.new_device',
    ]);
  });

  it('marks the alarm when its email could not be sent', async () => {
    answer = { sent: false, reason: 'not_configured' };
    const key = randomUUID();

    await service().raise('data.bulk_export', key, { rows: 60000 });

    expect(await rowsFor(key)).toEqual([expect.objectContaining({ email_failed: true, emailed_at: null })]);
  });

  it('records one row for two first raises at the same moment', async () => {
    const key = randomUUID();
    await Promise.all([
      service().raise('tripwire.account', key, { action: 'sign_in' }),
      service().raise('tripwire.account', key, { action: 'sign_in' }),
    ]);

    expect(await rowsFor(key)).toEqual([expect.objectContaining({ count: 2 })]);
  });

  it('never throws, even when the database refuses', async () => {
    const broken = new SecurityAlertsService(
      { transaction: () => Promise.reject(new Error('database is down')) } as unknown as DataSource,
      email,
      new ConfigService({}),
    );

    await expect(broken.raise('server.files_changed', 'k', {})).resolves.toBeUndefined();
  });

  it('lists the newest alarms first', async () => {
    const key = randomUUID();
    await service().raise('data.unusual_reads', key, { requests: 2500 });

    const [newest] = await service().list(5);
    expect(newest).toEqual(
      expect.objectContaining({ kind: 'data.unusual_reads', key, count: 1, emailFailed: false, details: { requests: 2500 } }),
    );
  });

  describe('the table is append-only', () => {
    it('refuses DELETE, TRUNCATE and a change of kind', async () => {
      const key = randomUUID();
      await service().raise('server.ssh_login', key, {});

      await expect(ds.query(`DELETE FROM security_alerts WHERE dedupe_key = $1`, [key])).rejects.toThrow(/append-only/);
      await expect(ds.query(`TRUNCATE security_alerts`)).rejects.toThrow(/append-only/);
      await expect(
        ds.query(`UPDATE security_alerts SET kind = 'staff.new_device' WHERE dedupe_key = $1`, [key]),
      ).rejects.toThrow(/append-only/);
      await expect(
        ds.query(`UPDATE security_alerts SET details = '{"x":1}' WHERE dedupe_key = $1`, [key]),
      ).rejects.toThrow(/append-only/);
    });
  });
});

import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../test-support/int-db';
import { exportSecurityLogs, parseWindow } from './export-security-logs';

/** The database half of the CERT-In log bundle: each log table's rows in the window, as CSV. */
describe('exportSecurityLogs (integration)', () => {
  let ds: DataSource;
  let out: string;
  const marker = `bundle-${randomUUID().slice(0, 8)}@export.test`;

  beforeAll(async () => {
    ds = await openIntDb();
    // One sign-in event inside the window, one before it, one after it.
    for (const [at, reason] of [
      ['2026-11-11T09:00:00Z', 'inside'],
      ['2026-11-11T07:59:59Z', 'before'],
      ['2026-11-11T10:00:00Z', 'after'],
    ]) {
      await ds.query(
        `INSERT INTO auth_events (email, type, reason, created_at) VALUES ($1, 'login.failed', $2, $3)`,
        [marker, reason, at],
      );
    }
    await ds.query(
      `INSERT INTO admin_audit_logs (actor_email, action, target_type, target_label, created_at)
       VALUES ($1, 'tenant.viewed', 'user', '=HYPERLINK("x")', '2026-11-11T09:30:00Z')`,
      [marker],
    );
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(() => {
    out = mkdtempSync(path.join(tmpdir(), 'chumbaq-export-'));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it('writes each log table, only rows in [from, to), formula-safe', async () => {
    const written = await exportSecurityLogs(ds, parseWindow('2026-11-11T08:00:00Z', '2026-11-11T10:00:00Z'), out);

    expect(readdirSync(out).sort()).toEqual([
      'admin_audit_logs.csv',
      'auth_events.csv',
      'project_activity.csv',
      'security_alerts.csv',
    ]);
    const events = readFileSync(path.join(out, 'auth_events.csv'), 'utf8')
      .split('\n')
      .filter((l) => l.includes(marker));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('inside');
    const audit = readFileSync(path.join(out, 'admin_audit_logs.csv'), 'utf8');
    expect(audit).toContain(`"'=HYPERLINK(""x"")"`);
    expect(written.find((w) => w.table === 'auth_events')!.rows).toBeGreaterThanOrEqual(1);
  });

  it('refuses a bad or reversed window', () => {
    expect(() => parseWindow('yesterday', '2026-11-11T10:00:00Z')).toThrow(/--from/);
    expect(() => parseWindow('2026-11-11T10:00:00Z', '2026-11-11T08:00:00Z')).toThrow(/before/);
  });
});

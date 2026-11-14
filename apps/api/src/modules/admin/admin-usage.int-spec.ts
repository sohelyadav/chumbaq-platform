import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AdminAuditService } from './admin-audit.service';
import { AdminUsageService } from './admin-usage.service';
import type { AdminActor } from './admin-tenants.service';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';

/**
 * Staff reads of `usage_daily`. Each test runs in a rolled-back transaction, so
 * the singleton roll-up state and every seeded row vanish after it; assertions
 * are scoped to the test's own fresh owners, since other specs share the table.
 */
describe('AdminUsageService (integration)', () => {
  let ds: DataSource;
  let qr: QueryRunner;
  let service: AdminUsageService;
  let actor: AdminActor;

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(() => closeIntDb(ds));

  beforeEach(async () => {
    qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('REPEATABLE READ');
    const audit = new AdminAuditService(qr.manager.getRepository(AdminAuditLogEntity));
    service = new AdminUsageService(qr.manager, audit);
    const staffId = await user('staff');
    actor = { userId: staffId, email: `staff-${staffId}@usage-admin.test`, ipAddress: '203.0.113.9' };
  });

  afterEach(async () => {
    await qr.rollbackTransaction();
    await qr.release();
  });

  async function user(label: string): Promise<string> {
    const id = randomUUID();
    await qr.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', $3)`, [
      id,
      `${label}-${id}@usage-admin.test`,
      label,
    ]);
    return id;
  }

  async function project(ownerId: string, name: string): Promise<string> {
    const id = randomUUID();
    await qr.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, $2, $3)`, [id, name, ownerId]);
    return id;
  }

  const state = (startedOn: string, firstDay: string, lastClosedDay: string) =>
    qr.query(
      `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET started_on = $1, first_day = $2, last_closed_day = $3`,
      [startedOn, firstDay, lastClosedDay],
    );

  const usage = (projectId: string, ownerId: string, day: string, metric: string, value: number) =>
    qr.query(
      `INSERT INTO usage_daily (project_id, owner_id, day, metric, value) VALUES ($1, $2, $3, $4, $5)`,
      [projectId, ownerId, day, metric, value],
    );

  const COVERAGE = { startedOn: '2026-11-14', countedFrom: '2026-08-16', countedThrough: '2026-11-13', mauFrom: '2026-11-01' };

  it('gives nothing before the roll-up has run', async () => {
    await qr.query(`DELETE FROM usage_rollup_state`);
    const tenant = await user('tenant');

    const result = await service.tenantUsage(tenant, 90, actor);

    expect(result).toEqual({
      coverage: null,
      days: 90,
      series: [],
      thisMonth: null,
      lastMonth: null,
      projects: [],
    });
  });

  it('answers 404 for an unknown tenant and records nothing', async () => {
    await state('2026-11-14', '2026-08-16', '2026-11-13');
    const unknown = randomUUID();
    await expect(service.tenantUsage(unknown, 90, actor)).rejects.toThrow(NotFoundException);
    const rows = await qr.query(`SELECT 1 FROM admin_audit_logs WHERE target_id = $1`, [unknown]);
    expect(rows).toHaveLength(0);
  });

  describe('a daily series', () => {
    it('covers the counted days, reading a missing count as 0 and an uncounted snapshot as null', async () => {
      await state('2026-11-14', '2026-08-16', '2026-11-13');
      const tenant = await user('tenant');
      const p = await project(tenant, 'one');
      await usage(p, tenant, '2026-11-13', 'events', 5);
      await usage(p, tenant, '2026-11-13', 'mau_month_to_date', 7);
      // Today, still being counted: never shown.
      await usage(p, tenant, '2026-11-14', 'events', 50);

      const coverage = await service.coverage();
      expect(coverage).toEqual(COVERAGE);
      const series = await service.series(coverage, tenant, 90);

      expect(series).toHaveLength(90);
      expect(series[0].date).toBe('2026-08-16');
      expect(series[89].date).toBe('2026-11-13');
      expect(series.find((d) => d.date === '2026-11-14')).toBeUndefined();

      const byDate = new Map(series.map((d) => [d.date, d.values]));
      expect(byDate.get('2026-09-01')!.events).toBe(0);
      expect(byDate.get('2026-11-13')!.events).toBe(5);
      expect(byDate.get('2026-11-13')!.mau_month_to_date).toBe(7);
      // Active devices are counted from the month of the first run.
      expect(byDate.get('2026-10-31')!.mau_month_to_date).toBeNull();
      expect(byDate.get('2026-11-01')!.mau_month_to_date).toBe(0);
      // Active keys were never snapshotted for these days.
      expect(series.every((d) => d.values.api_keys_active === null)).toBe(true);
    });

    it('never starts before the first counted day, and is empty with no closed day', async () => {
      await state('2026-11-14', '2026-11-10', '2026-11-13');
      const tenant = await user('tenant');
      const series = await service.series(await service.coverage(), tenant, 90);
      expect(series.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);

      await state('2026-11-14', '2026-11-14', '2026-11-13');
      const coverage = await service.coverage();
      expect(coverage?.countedThrough).toBeNull();
      expect(await service.series(coverage, tenant, 90)).toEqual([]);
    });

    it('shows active keys on a snapshotted day, zeros included, and null on a day without one', async () => {
      await state('2026-11-14', '2026-08-16', '2026-11-13');
      const tenant = await user('tenant');
      const p1 = await project(tenant, 'one');
      const p2 = await project(tenant, 'two');
      await usage(p1, tenant, '2026-11-13', 'api_keys_active', 2);
      await usage(p2, tenant, '2026-11-13', 'api_keys_active', 0);
      const other = await user('other');
      await usage(await project(other, 'x'), other, '2026-11-12', 'api_keys_active', 0);

      const series = await service.series(await service.coverage(), tenant, 7);
      const byDate = new Map(series.map((d) => [d.date, d.values]));
      expect(byDate.get('2026-11-13')!.api_keys_active).toBe(2);
      expect(byDate.get('2026-11-12')!.api_keys_active).toBeNull();
    });
  });

  describe('a tenant', () => {
    it('totals only the rows billed to it, with deleted and moved projects', async () => {
      await state('2026-11-14', '2026-08-16', '2026-11-13');
      const tenant = await user('tenant');
      const other = await user('other');
      // Billed to the tenant until the 10th, then moved to `other`.
      const moved = await project(other, 'moved');
      const kept = await project(tenant, 'kept');
      const idle = await project(tenant, 'idle');
      const deleted = randomUUID();
      await usage(moved, tenant, '2026-11-10', 'events', 4);
      await usage(moved, other, '2026-11-11', 'events', 100);
      await usage(kept, tenant, '2026-11-11', 'events', 6);
      await usage(kept, tenant, '2026-11-11', 'push_sent', 3);
      await usage(kept, tenant, '2026-11-13', 'mau_month_to_date', 8);
      await usage(deleted, tenant, '2026-10-02', 'clicks', 9);

      const result = await service.tenantUsage(tenant, 90, actor);

      const total = (date: string) => result.series.find((d) => d.date === date)!.values;
      expect(total('2026-11-10').events).toBe(4);
      expect(total('2026-11-11').events).toBe(6);
      expect(total('2026-11-11').push_sent).toBe(3);

      const byId = new Map(result.projects.map((p) => [p.projectId, p]));
      expect([...byId.keys()].sort()).toEqual([moved, kept, idle, deleted].sort());
      expect(byId.get(moved)!).toMatchObject({ name: 'moved', values: { events: 4 } });
      expect(byId.get(kept)!).toMatchObject({ name: 'kept', values: { events: 6, push_sent: 3, mau_month_to_date: 8 } });
      expect(byId.get(idle)!).toMatchObject({ name: 'idle', values: { events: 0, mau_month_to_date: 0, api_keys_active: null } });
      expect(byId.get(deleted)!).toMatchObject({ name: null, values: { clicks: 9 } });
    });

    it('compares this month so far with the whole of last month', async () => {
      await state('2026-10-05', '2026-07-07', '2026-11-13');
      const tenant = await user('tenant');
      const p = await project(tenant, 'one');
      await usage(p, tenant, '2026-10-03', 'events', 2);
      await usage(p, tenant, '2026-10-15', 'mau_month_to_date', 4);
      await usage(p, tenant, '2026-10-31', 'events', 3);
      await usage(p, tenant, '2026-10-31', 'mau_month_to_date', 9);
      await usage(p, tenant, '2026-11-02', 'events', 10);
      await usage(p, tenant, '2026-11-13', 'mau_month_to_date', 6);
      // Today: not in this month's total.
      await usage(p, tenant, '2026-11-14', 'events', 1000);

      const result = await service.tenantUsage(tenant, 90, actor);

      expect(result.thisMonth).toMatchObject({
        month: '2026-11',
        from: '2026-11-01',
        through: '2026-11-13',
        partial: true,
        values: { events: 10, mau_month_to_date: 6, push_sent: 0 },
      });
      expect(result.lastMonth).toMatchObject({
        month: '2026-10',
        from: '2026-10-01',
        through: '2026-10-31',
        partial: false,
        values: { events: 5, mau_month_to_date: 9, api_keys_active: null },
      });
    });

    it('records the read once per window', async () => {
      await state('2026-11-14', '2026-08-16', '2026-11-13');
      const tenant = await user('tenant');

      await service.tenantUsage(tenant, 90, actor);
      await service.tenantUsage(tenant, 30, actor);

      const rows = await qr.query(
        `SELECT action, actor_id, target_type, target_label FROM admin_audit_logs WHERE target_id = $1`,
        [tenant],
      );
      expect(rows).toEqual([
        {
          action: 'tenant.viewed',
          actor_id: actor.userId,
          target_type: 'tenant',
          target_label: `tenant-${tenant}@usage-admin.test`,
        },
      ]);
    });
  });
});

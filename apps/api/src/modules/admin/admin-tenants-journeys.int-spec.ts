import { DataSource } from 'typeorm';
import { AdminTenantsService } from './admin-tenants.service';
import { SeatsService } from '../project-access/seats.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';
import { UserEntity } from '../users/entities/user.entity';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AccountLimitsService } from '../billing/account-limits.service';

const DOMAIN = '@journeys-shift-int.test';
const actor = { userId: null as unknown as string, email: `admin${DOMAIN}`, ipAddress: '' };
const DAY_MS = 86_400_000;

/**
 * The date arithmetic and the join to the owning tenant are the whole question,
 * so they are asked of Postgres.
 */
describe('Reactivation moves journey runs past the suspension (integration)', () => {
  let ds: DataSource;
  let service: AdminTenantsService;

  const cleanUp = () => ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);

  const tenantWithRun = async (name: string, dueAt: Date, status = 'active') => {
    const [user] = await ds.query(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [`${name}${DOMAIN}`, name],
    );
    const [project] = await ds.query(
      `INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id`,
      [name, user.id],
    );
    const [journey] = await ds.query(
      `INSERT INTO journeys (project_id, name, trigger, steps) VALUES ($1, $2, '{}', '[]') RETURNING id`,
      [project.id, name],
    );
    const [run] = await ds.query(
      `INSERT INTO journey_runs (project_id, journey_id, person_key, status, next_due_at)
       VALUES ($1, $2, 'person', $3, $4) RETURNING id`,
      [project.id, journey.id, status, dueAt],
    );
    return { userId: user.id as string, runId: run.id as string };
  };

  const suspendedDaysAgo = (userId: string, days: number) =>
    ds.query(
      `UPDATE users SET suspended_at = now() - ($2 || ' days')::interval, suspended_reason = 'test' WHERE id = $1`,
      [userId, days],
    );

  const dueOf = async (runId: string): Promise<number> => {
    const [row] = await ds.query(`SELECT next_due_at FROM journey_runs WHERE id = $1`, [runId]);
    return new Date(row.next_due_at).getTime();
  };

  beforeAll(async () => {
    ds = await openIntDb();
    const audit = ds.getRepository(AdminAuditLogEntity);
    service = new AdminTenantsService(
      ds.getRepository(UserEntity),
      audit,
      new AdminAuditService(audit),
      { factorResetCancelled: () => undefined } as never, new SeatsService(ds, new AccountLimitsService()), new AccountLimitsService()
    );
  });
  afterAll(async () => {
    await cleanUp();
    await closeIntDb(ds);
  });
  beforeEach(cleanUp);

  it('moves a run by the length of the suspension, and only once', async () => {
    const due = new Date(Date.now() - 2 * DAY_MS);
    const { userId, runId } = await tenantWithRun('moved', due);
    await suspendedDaysAgo(userId, 3);

    await service.reactivate(userId, 'resolved with the tenant', actor);

    const shift = (await dueOf(runId)) - due.getTime();
    expect(Math.abs(shift - 3 * DAY_MS)).toBeLessThan(60_000);

    const afterFirst = await dueOf(runId);
    await expect(
      service.reactivate(userId, 'resolved with the tenant', actor),
    ).rejects.toThrow('not suspended');
    expect(await dueOf(runId)).toBe(afterFirst);
  });

  it('suspending ends live sessions, so they stay dead after reactivation', async () => {
    const { userId } = await tenantWithRun('sessions', new Date());
    const versionOf = async () => {
      const [row] = await ds.query(`SELECT session_version FROM users WHERE id = $1`, [userId]);
      return row.session_version as number;
    };
    const before = await versionOf();

    await service.suspend(userId, 'checking session revocation', actor);
    expect(await versionOf()).toBe(before + 1);

    await service.reactivate(userId, 'finished checking revocation', actor);
    expect(await versionOf()).toBe(before + 1);
  });

  it('leaves another tenant and finished runs alone', async () => {
    const due = new Date(Date.now() - DAY_MS);
    const target = await tenantWithRun('target', due);
    const bystander = await tenantWithRun('bystander', due);
    const finished = await tenantWithRun('finished', due, 'completed');
    await suspendedDaysAgo(target.userId, 3);
    await suspendedDaysAgo(finished.userId, 3);

    await service.reactivate(target.userId, 'resolved with the tenant', actor);
    await service.reactivate(finished.userId, 'resolved with the tenant', actor);

    expect(await dueOf(bystander.runId)).toBe(due.getTime());
    expect(await dueOf(finished.runId)).toBe(due.getTime());
    expect(await dueOf(target.runId)).toBeGreaterThan(due.getTime());
  });
});

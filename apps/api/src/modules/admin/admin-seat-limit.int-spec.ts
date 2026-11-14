import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { SeatsService } from '../project-access/seats.service';
import { UserEntity } from '../users/entities/user.entity';
import { AdminAuditService } from './admin-audit.service';
import { AdminActor, AdminTenantsService } from './admin-tenants.service';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';
import { AccountLimitsService } from '../billing/account-limits.service';

const DOMAIN = '@seat-limit-admin-int.test';
const REASON = 'customer on the agency plan';

describe('Per-account seat limit set by staff (integration)', () => {
  let ds: DataSource;
  let tenants: AdminTenantsService;
  let actor: AdminActor;
  const DEFAULT_LIMIT = 5;

  const account = async (localPart: string, isSuperAdmin = false): Promise<string> => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, is_super_admin) VALUES ($1, $2, 'x', 'f', $3)`,
      [id, `${localPart}${DOMAIN}`, isSuperAdmin],
    );
    return id;
  };

  const auditRows = (targetId: string) =>
    ds.getRepository(AdminAuditLogEntity).find({
      where: { targetId, action: 'account.seat_limit_changed' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

  const cleanUp = async () => {
    await ds.query(`DELETE FROM admin_audit_logs WHERE target_label LIKE $1 OR actor_email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    const config = new ConfigService({ projects: { maxPerAccount: 10, maxSeatsPerAccount: DEFAULT_LIMIT } });
    const auditRepository = ds.getRepository(AdminAuditLogEntity);
    tenants = new AdminTenantsService(
      ds.getRepository(UserEntity),
      auditRepository,
      new AdminAuditService(auditRepository),
      { factorResetCancelled: () => undefined } as never,
      new SeatsService(ds, new AccountLimitsService(config)),
      new AccountLimitsService(config),
    );
  });
  afterAll(async () => {
    await cleanUp();
    await closeIntDb(ds);
  });
  beforeEach(async () => {
    await cleanUp();
    const staff = await account('staff', true);
    actor = { userId: staff, email: `staff${DOMAIN}`, ipAddress: '203.0.113.9' };
  });

  it('shows the default limit, no override, and the seats in use', async () => {
    const id = await account('plain');
    const [{ id: projectId }] = await ds.query(
      `INSERT INTO projects (name, owner_id) VALUES ('p', $1) RETURNING id`,
      [id],
    );
    await ds.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [projectId, id]);
    const dev = await account('dev');
    await ds.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')`, [projectId, dev]);

    const detail = await tenants.findOne(id);

    expect(detail.seatLimit).toBeNull();
    expect(detail.effectiveSeatLimit).toBe(DEFAULT_LIMIT);
    expect(detail.seatsUsed).toBe(2);
  });

  it('sets the limit and records before, after and the default in the audit log', async () => {
    const id = await account('raised');

    const detail = await tenants.setSeatLimit(id, 12, REASON, actor);

    expect(detail.seatLimit).toBe(12);
    expect(detail.effectiveSeatLimit).toBe(12);
    const [row] = await auditRows(id);
    expect(row).toMatchObject({
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: 'tenant',
      targetLabel: `raised${DOMAIN}`,
      reason: REASON,
      ipAddress: '203.0.113.9',
      metadata: { before: null, after: 12, defaultLimit: DEFAULT_LIMIT },
    });
    expect(detail.recentAudit.map((entry) => entry.action)).toContain('account.seat_limit_changed');
  });

  it('accepts zero, and clearing returns the account to the default', async () => {
    const id = await account('cleared');
    expect((await tenants.setSeatLimit(id, 0, REASON, actor)).effectiveSeatLimit).toBe(0);

    const detail = await tenants.setSeatLimit(id, null, REASON, actor);

    expect(detail.seatLimit).toBeNull();
    expect(detail.effectiveSeatLimit).toBe(DEFAULT_LIMIT);
    expect((await auditRows(id)).map((row) => row.metadata)).toEqual([
      { before: null, after: 0, defaultLimit: DEFAULT_LIMIT },
      { before: 0, after: null, defaultLimit: DEFAULT_LIMIT },
    ]);
  });

  it('writes the change and its audit row in one transaction', async () => {
    const id = await account('atomic');
    const failing = new AdminTenantsService(
      ds.getRepository(UserEntity),
      ds.getRepository(AdminAuditLogEntity),
      { record: async () => { throw new Error('audit down'); } } as never,
      { factorResetCancelled: () => undefined } as never, new SeatsService(ds, new AccountLimitsService()), new AccountLimitsService()
    );

    await expect(failing.setSeatLimit(id, 7, REASON, actor)).rejects.toThrow('audit down');

    const [{ seat_limit: seatLimit }] = await ds.query(`SELECT seat_limit FROM users WHERE id = $1`, [id]);
    expect(seatLimit).toBeNull();
  });

  it('answers 404 for an account that does not exist, and audits nothing', async () => {
    const missing = randomUUID();
    await expect(tenants.setSeatLimit(missing, 5, REASON, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(await auditRows(missing)).toHaveLength(0);
  });
});

import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SeatsService } from '../project-access/seats.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectActivityEntity } from '../project-activity/entities/project-activity.entity';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { ProjectEntity } from '../projects/entities/project.entity';
import { ProjectsService } from '../projects/projects.service';
import { UserEntity } from '../users/entities/user.entity';
import { AdminAuditService } from './admin-audit.service';
import { AdminActor, AdminTenantsService } from './admin-tenants.service';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';

const DOMAIN = '@project-limit-admin-int.test';
const REASON = 'customer on the agency plan';
const DEFAULT_LIMIT = 10;

describe('Per-account project limit set by staff (integration)', () => {
  let ds: DataSource;
  let tenants: AdminTenantsService;
  let projects: ProjectsService;
  let actor: AdminActor;

  const account = async (localPart: string, isSuperAdmin = false): Promise<string> => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, is_super_admin) VALUES ($1, $2, 'x', 'f', $3)`,
      [id, `${localPart}${DOMAIN}`, isSuperAdmin],
    );
    return id;
  };

  const existing = async (ownerId: string, count: number) => {
    for (let i = 0; i < count; i++) {
      await ds.query(`INSERT INTO projects (name, owner_id) VALUES ($1, $2)`, [`p${i}`, ownerId]);
    }
  };

  const create = (ownerId: string) =>
    projects.create(ownerId, { name: 'app', domain: 'example.com' } as never);

  const auditRows = (targetId: string) =>
    ds.getRepository(AdminAuditLogEntity).find({
      where: { targetId, action: 'account.project_limit_changed' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

  const cleanUp = async () => {
    await ds.query(`DELETE FROM admin_audit_logs WHERE target_label LIKE $1 OR actor_email LIKE $1`, [
      `%${DOMAIN}`,
    ]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    const config = new ConfigService({ projects: { maxPerAccount: DEFAULT_LIMIT } });
    const auditRepository = ds.getRepository(AdminAuditLogEntity);
    tenants = new AdminTenantsService(
      ds.getRepository(UserEntity),
      auditRepository,
      new AdminAuditService(auditRepository),
      { factorResetCancelled: () => undefined } as never,
      new SeatsService(ds, config),
      config,
    );
    projects = new ProjectsService(ds.getRepository(ProjectEntity), config, new ProjectAccessService(null as never, null as never, null as never, null as never), new SeatsService(ds, config), new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})));
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

  it('shows the default limit and no override on a tenant that has none', async () => {
    const id = await account('plain');
    await existing(id, 3);

    const detail = await tenants.findOne(id);

    expect(detail.projectLimit).toBeNull();
    expect(detail.effectiveProjectLimit).toBe(DEFAULT_LIMIT);
    expect(detail.projectCount).toBe(3);
  });

  it('raises the limit, records before and after, and creates then go past the default', async () => {
    const id = await account('raised');
    await existing(id, DEFAULT_LIMIT);
    await expect(create(id)).rejects.toBeInstanceOf(ForbiddenException);

    const detail = await tenants.setProjectLimit(id, 12, REASON, actor);

    expect(detail.projectLimit).toBe(12);
    expect(detail.effectiveProjectLimit).toBe(12);
    await create(id);
    await create(id);
    await expect(create(id)).rejects.toBeInstanceOf(ForbiddenException);

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
    expect(detail.recentAudit.map((entry) => entry.action)).toContain('account.project_limit_changed');
  });

  it('lowers the limit below what the account has without removing a project', async () => {
    const id = await account('lowered');
    await existing(id, 5);

    await tenants.setProjectLimit(id, 2, REASON, actor);

    await expect(create(id)).rejects.toThrow(
      'You can have up to 2 projects. Delete one or contact support to raise the limit.',
    );
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM projects WHERE owner_id = $1`, [id]);
    expect(n).toBe(5);
  });

  it('clearing the override returns the account to the default, audited as before and after', async () => {
    const id = await account('cleared');
    await tenants.setProjectLimit(id, 3, REASON, actor);

    const detail = await tenants.setProjectLimit(id, null, REASON, actor);

    expect(detail.projectLimit).toBeNull();
    expect(detail.effectiveProjectLimit).toBe(DEFAULT_LIMIT);
    const rows = await auditRows(id);
    expect(rows.map((row) => row.metadata)).toEqual([
      { before: null, after: 3, defaultLimit: DEFAULT_LIMIT },
      { before: 3, after: null, defaultLimit: DEFAULT_LIMIT },
    ]);
  });

  it('answers 404 for an account that does not exist, and audits nothing', async () => {
    const missing = randomUUID();
    await expect(tenants.setProjectLimit(missing, 5, REASON, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await auditRows(missing)).toHaveLength(0);
  });
});

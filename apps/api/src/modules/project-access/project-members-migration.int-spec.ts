import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SeatsService } from './seats.service';
import { ProjectAccessService } from './project-access.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectActivityEntity } from '../project-activity/entities/project-activity.entity';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AddProjectMembers1794440000000 } from '../../migrations/1794440000000-AddProjectMembers';
import { ProjectEntity } from '../projects/entities/project.entity';
import { ProjectsService } from '../projects/projects.service';

/**
 * The schema behind team roles, which only Postgres can show holding: the role CHECK,
 * the one-pending-invitation index, the backfill, and a migration that reverses.
 */
describe('project_members and project_invitations (integration)', () => {
  const DOMAIN = '@project-members-int.test';
  let ds: DataSource;
  const owners: string[] = [];

  const user = async (): Promise<string> => {
    const id = randomUUID();
    owners.push(id);
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'member')`,
      [id, `${id}${DOMAIN}`],
    );
    return id;
  };

  const project = async (ownerId: string): Promise<string> =>
    (
      await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('p', $1) RETURNING id`, [ownerId])
    )[0].id;

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error as Error & { constraint?: string; driverError?: { constraint?: string } },
    );

  const invite = (projectId: string, email: string) =>
    ds.query(
      `INSERT INTO project_invitations (project_id, email, role, token_hash, expires_at)
       VALUES ($1, $2, 'member', $3, now() + interval '7 days')`,
      [projectId, email, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')],
    );

  /** Every table, column, constraint and index this migration owns, as the catalogue reports it. */
  const schema = async (): Promise<unknown> => {
    const tables = `('project_members','project_invitations')`;
    return {
      columns: await ds.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE (table_name IN ${tables})
             OR (table_name = 'users' AND column_name = 'seat_limit')
             OR (table_name = 'projects' AND column_name LIKE 'pending_billing%')
          ORDER BY table_name, column_name`,
      ),
      constraints: await ds.query(
        `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid::regclass::text IN ('project_members','project_invitations')
             OR conname IN ('CHK_users_seat_limit_not_negative','FK_04832c91755212691fada66cc2d')
          ORDER BY conname`,
      ),
      indexes: await ds.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename IN ${tables} ORDER BY indexname`,
      ),
    };
  };

  /** A failure between down() and up() must not leave the shared database without the tables. */
  const ensureMigrated = async (
    runner: ReturnType<DataSource['createQueryRunner']>,
    migration: AddProjectMembers1794440000000,
  ) => {
    if (!(await runner.hasTable('project_members'))) await migration.up(runner);
  };

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    if (owners.length) {
      await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [owners]);
    }
    await closeIntDb(ds);
  });

  it('gives a project that exists before the migration exactly one owner row for its owner', async () => {
    const migration = new AddProjectMembers1794440000000();
    const runner = ds.createQueryRunner();
    try {
      const ownerA = await user();
      const ownerB = await user();
      const mine = [await project(ownerA), await project(ownerA), await project(ownerB)];
      // As they were before the migration: projects, and no table for members.
      await migration.down(runner);
      await migration.up(runner);
      const rows = await ds.query(
        `SELECT project_id, user_id, role FROM project_members WHERE project_id = ANY($1) ORDER BY project_id`,
        [mine],
      );
      const expected = [
        { project_id: mine[0], user_id: ownerA, role: 'owner' },
        { project_id: mine[1], user_id: ownerA, role: 'owner' },
        { project_id: mine[2], user_id: ownerB, role: 'owner' },
      ].sort((x, y) => (x.project_id < y.project_id ? -1 : 1));
      expect(rows).toEqual(expected);
    } finally {
      await ensureMigrated(runner, migration);
      await runner.release();
    }
  });

  it('refuses a role that is not owner, admin or member', async () => {
    const owner = await user();
    const p = await project(owner);
    const error = await failure(
      ds.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')`, [p, owner]),
    );
    expect(String(error)).toContain('CHK_project_members_role');
    const invitation = await failure(
      ds.query(
        `INSERT INTO project_invitations (project_id, email, role, token_hash, expires_at)
         VALUES ($1, 'a@x.test', 'viewer', $2, now())`,
        [p, 'h'.repeat(64)],
      ),
    );
    expect(String(invitation)).toContain('CHK_project_invitations_role');
  });

  it('allows one membership per person per project', async () => {
    const owner = await user();
    const p = await project(owner);
    await ds.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [p, owner]);
    const error = await failure(
      ds.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin')`, [p, owner]),
    );
    expect(String(error)).toContain('UQ_project_members_project_user');
  });

  it('allows one pending invitation per project and email, and another once it is revoked', async () => {
    const owner = await user();
    const p = await project(owner);
    const email = `new${DOMAIN}`;
    await invite(p, email);
    const second = await failure(invite(p, email));
    expect(String(second)).toContain('UQ_project_invitations_pending');

    await ds.query(`UPDATE project_invitations SET revoked_at = now() WHERE project_id = $1`, [p]);
    await invite(p, email);
    const third = await failure(invite(p, email));
    expect(String(third)).toContain('UQ_project_invitations_pending');
    await ds.query(`UPDATE project_invitations SET accepted_at = now() WHERE project_id = $1 AND revoked_at IS NULL`, [p]);
    await invite(p, email);
  });

  it('refuses an invitation email that is not lower case, and a negative seat limit', async () => {
    const owner = await user();
    const p = await project(owner);
    expect(String(await failure(invite(p, `Mixed${DOMAIN}`)))).toContain('CHK_project_invitations_email_lower_case');
    expect(
      String(await failure(ds.query(`UPDATE users SET seat_limit = -1 WHERE id = $1`, [owner]))),
    ).toContain('CHK_users_seat_limit_not_negative');
    await ds.query(`UPDATE users SET seat_limit = 0 WHERE id = $1`, [owner]);
  });

  it('removes memberships with the project or the person, and keeps who added them as null', async () => {
    const owner = await user();
    const adder = await user();
    const other = await user();
    const p = await project(owner);
    await ds.query(
      `INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1, $2, 'member', $3)`,
      [p, other, adder],
    );
    await ds.query(`DELETE FROM users WHERE id = $1`, [adder]);
    expect((await ds.query(`SELECT added_by FROM project_members WHERE user_id = $1`, [other]))[0].added_by).toBeNull();
    await ds.query(`DELETE FROM users WHERE id = $1`, [other]);
    expect(await ds.query(`SELECT 1 FROM project_members WHERE user_id = $1`, [other])).toHaveLength(0);
    await ds.query(`DELETE FROM projects WHERE id = $1`, [p]);
    expect(await ds.query(`SELECT 1 FROM project_members WHERE project_id = $1`, [p])).toHaveLength(0);
  });

  it('gives a project made through ProjectsService its owner row', async () => {
    const owner = await user();
    const service = new ProjectsService(
      ds.getRepository(ProjectEntity),
      new ConfigService({ projects: { maxPerAccount: 10 } }),
      new ProjectAccessService(null as never, null as never, null as never, null as never),
      new SeatsService(ds, new ConfigService({})),
      new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})),
    );
    const created = await service.create(owner, { name: 'via service', domain: 'example.com' } as never);
    const rows = await ds.query(`SELECT user_id, role, added_by FROM project_members WHERE project_id = $1`, [created.id]);
    expect(rows).toEqual([{ user_id: owner, role: 'owner', added_by: null }]);
  });

  it('reverses: down() then up() leaves the same schema', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddProjectMembers1794440000000();
    try {
      const before = await schema();
      expect((before as { columns: unknown[] }).columns.length).toBeGreaterThan(10);

      await migration.down(runner);
      const gone = (await schema()) as { columns: unknown[]; constraints: unknown[]; indexes: unknown[] };
      expect(gone.columns).toHaveLength(0);
      expect(gone.constraints).toHaveLength(0);
      expect(gone.indexes).toHaveLength(0);

      await migration.up(runner);
      expect(await schema()).toEqual(before);
    } finally {
      await ensureMigrated(runner, migration);
      await runner.release();
    }
  });
});

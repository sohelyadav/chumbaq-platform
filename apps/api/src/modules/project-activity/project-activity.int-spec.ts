import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AddProjectActivity1794440000002 } from '../../migrations/1794440000002-AddProjectActivity';
import { ProjectActivityEntity } from './entities/project-activity.entity';
import { ProjectActivityService } from './project-activity.service';

/**
 * What only Postgres can show: the time comes from the database, the trigger keeps the
 * table append-only (retention may delete only rows past the 180-day floor, and only
 * with its flag set), and the migration reverses.
 */
describe('project_activity (integration)', () => {
  const DOMAIN = '@project-activity-int.test';
  const APPEND_ONLY = 'project_activity is append-only';
  let ds: DataSource;
  let service: ProjectActivityService;
  const users: string[] = [];

  const user = async (name: string): Promise<string> => {
    const id = randomUUID();
    users.push(id);
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', $3)`, [
      id,
      `${id}${DOMAIN}`,
      name,
    ]);
    return id;
  };

  /** A row as old as `daysAgo`. The trigger guards only UPDATE and DELETE, so this inserts directly. */
  const backdated = async (projectId: string, daysAgo: number): Promise<string> =>
    (
      await ds.query(
        `INSERT INTO project_activity (project_id, actor_kind, actor_label, action, occurred_at)
         VALUES ($1, 'system', 'Chumbaq', 'project.renamed', now() - make_interval(days => $2))
         RETURNING id`,
        [projectId, daysAgo],
      )
    )[0].id;

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error as Error,
    );

  /** Deletes `id` in a transaction that has set the retention flag, as the retention job will. */
  const retentionDelete = (id: string) =>
    ds.transaction(async (manager) => {
      await manager.query(`SET LOCAL chumbaq.activity_retention = 'on'`);
      return manager.query(`DELETE FROM project_activity WHERE id = $1`, [id]);
    });

  const exists = async (id: string): Promise<boolean> =>
    (await ds.query(`SELECT 1 FROM project_activity WHERE id = $1`, [id])).length === 1;

  /** Every column, constraint, index and trigger this migration owns, as the catalogue reports it. */
  const schema = async () => ({
    columns: await ds.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns WHERE table_name = 'project_activity' ORDER BY column_name`,
    ),
    constraints: await ds.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid::regclass::text = 'project_activity' ORDER BY conname`,
    ),
    indexes: await ds.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'project_activity' ORDER BY indexname`,
    ),
    triggers: await ds.query(
      `SELECT tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
        WHERE tgrelid::regclass::text = 'project_activity' AND NOT tgisinternal ORDER BY tgname`,
    ),
    functions: await ds.query(
      `SELECT proname, prosrc FROM pg_proc WHERE proname = 'project_activity_append_only'`,
    ),
  });

  beforeAll(async () => {
    ds = await openIntDb();
    service = new ProjectActivityService(
      ds.getRepository(ProjectActivityEntity),
      new ConfigService({ app: { geoipEnabled: false } }),
    );
  });

  afterAll(async () => {
    if (users.length) await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await closeIntDb(ds);
  });

  it('writes one row, with the time set by the database', async () => {
    const projectId = randomUUID();
    const actor = await user('Priya');

    const [{ dbNow }] = await ds.transaction(async (manager) => {
      await service.record(
        {
          projectId,
          actor: { kind: 'user', userId: actor },
          action: 'project.renamed',
          target: { type: 'project', id: projectId, label: 'Acme' },
          details: { from: 'Old', to: 'Acme' },
        },
        { ipAddress: '203.0.113.9', userAgent: 'jest' },
        manager,
      );
      // now() is the transaction's start, so a row stamped by the database matches it exactly.
      return manager.query(`SELECT now() AS "dbNow"`);
    });

    const rows = await ds.query(`SELECT * FROM project_activity WHERE project_id = $1`, [projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: 'user',
      actor_user_id: actor,
      actor_label: `Priya (${actor}${DOMAIN})`,
      action: 'project.renamed',
      target_type: 'project',
      target_id: projectId,
      target_label: 'Acme',
      details: { from: 'Old', to: 'Acme' },
      ip_address: '203.0.113.9',
      user_agent: 'jest',
      country: null,
    });
    expect((rows[0].occurred_at as Date).toISOString()).toBe((dbNow as Date).toISOString());
  });

  it('writes nothing when the caller’s transaction rolls back', async () => {
    const projectId = randomUUID();
    await failure(
      ds.transaction(async (manager) => {
        await service.record(
          { projectId, actor: { kind: 'system' }, action: 'project.deleted' },
          { ipAddress: null, userAgent: null },
          manager,
        );
        throw new Error('the action failed');
      }),
    );
    expect(await ds.query(`SELECT 1 FROM project_activity WHERE project_id = $1`, [projectId])).toHaveLength(0);
  });

  it('refuses an actor kind outside the list', async () => {
    const error = await failure(
      ds.query(
        `INSERT INTO project_activity (project_id, actor_kind, actor_label, action) VALUES ($1, 'robot', 'x', 'project.renamed')`,
        [randomUUID()],
      ),
    );
    expect(String(error)).toContain('CHK_project_activity_actor_kind');
  });

  it('refuses every UPDATE, even with the retention flag set', async () => {
    const id = await backdated(randomUUID(), 400);

    const plain = await failure(ds.query(`UPDATE project_activity SET actor_label = 'someone else' WHERE id = $1`, [id]));
    expect(plain?.message).toBe(APPEND_ONLY);

    const flagged = await failure(
      ds.transaction(async (manager) => {
        await manager.query(`SET LOCAL chumbaq.activity_retention = 'on'`);
        await manager.query(`UPDATE project_activity SET occurred_at = now() WHERE id = $1`, [id]);
      }),
    );
    expect(flagged?.message).toBe(APPEND_ONLY);
    expect((await ds.query(`SELECT actor_label FROM project_activity WHERE id = $1`, [id]))[0].actor_label).toBe('Chumbaq');
  });

  it('refuses a DELETE without the retention flag, however old the row', async () => {
    const id = await backdated(randomUUID(), 400);
    const error = await failure(ds.query(`DELETE FROM project_activity WHERE id = $1`, [id]));
    expect(error?.message).toBe(APPEND_ONLY);
    expect(await exists(id)).toBe(true);
  });

  it('refuses a DELETE with the flag set to anything but on', async () => {
    const id = await backdated(randomUUID(), 400);
    const error = await failure(
      ds.transaction(async (manager) => {
        await manager.query(`SET LOCAL chumbaq.activity_retention = 'yes'`);
        await manager.query(`DELETE FROM project_activity WHERE id = $1`, [id]);
      }),
    );
    expect(error?.message).toBe(APPEND_ONLY);
    expect(await exists(id)).toBe(true);
  });

  it('with the flag, refuses a row younger than 180 days', async () => {
    const projectId = randomUUID();
    const fresh = await backdated(projectId, 0);
    const young = await backdated(projectId, 179);

    for (const id of [fresh, young]) {
      const error = await failure(retentionDelete(id));
      expect(error?.message).toBe(APPEND_ONLY);
      expect(await exists(id)).toBe(true);
    }
  });

  it('with the flag, deletes a row older than 180 days', async () => {
    const id = await backdated(randomUUID(), 181);
    await retentionDelete(id);
    expect(await exists(id)).toBe(false);
  });

  it('keeps the flag to its own transaction', async () => {
    const id = await backdated(randomUUID(), 400);
    await ds.transaction(async (manager) => {
      await manager.query(`SET LOCAL chumbaq.activity_retention = 'on'`);
    });
    const error = await failure(ds.query(`DELETE FROM project_activity WHERE id = $1`, [id]));
    expect(error?.message).toBe(APPEND_ONLY);
  });

  it('refuses TRUNCATE', async () => {
    const id = await backdated(randomUUID(), 400);
    const runner = ds.createQueryRunner();
    try {
      await runner.startTransaction();
      // Rolled back whatever happens, so a TRUNCATE that slipped through loses nothing.
      const error = await failure(runner.query(`TRUNCATE project_activity`));
      expect(error?.message).toBe(APPEND_ONLY);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    expect(await exists(id)).toBe(true);
  });

  it('reverses: down() then up() leaves the same schema', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddProjectActivity1794440000002();
    try {
      const before = await schema();
      expect(before.columns).toHaveLength(14);
      expect(before.indexes.length).toBeGreaterThanOrEqual(4);
      expect(before.triggers).toHaveLength(2);
      expect(before.functions).toHaveLength(1);

      await migration.down(runner);
      const gone = await schema();
      expect(gone).toEqual({ columns: [], constraints: [], indexes: [], triggers: [], functions: [] });

      await migration.up(runner);
      expect(await schema()).toEqual(before);
    } finally {
      if (!(await runner.hasTable('project_activity'))) await migration.up(runner);
      await runner.release();
    }
  });
});

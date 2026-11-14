import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';

/**
 * The usage tables as the migration builds them: primary keys, the indexes
 * the counting queries rely on, the single state row, and what a project
 * delete keeps (daily counts) and removes (its active-device rows).
 */
describe('usage roll-up schema (integration)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  const primaryKey = async (table: string): Promise<string[]> => {
    const rows: { column_name: string }[] = await ds.query(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      [table],
    );
    return rows.map((r) => r.column_name);
  };

  const indexDef = async (table: string, name: string): Promise<string | null> => {
    const rows: { indexdef: string }[] = await ds.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
      [table, name],
    );
    return rows[0]?.indexdef ?? null;
  };

  it('creates the three tables with their primary keys', async () => {
    expect(await primaryKey('usage_daily')).toEqual(['project_id', 'day', 'metric']);
    expect(await primaryKey('monthly_active_devices')).toEqual(['project_id', 'month', 'device_identity_id']);
    expect(await primaryKey('usage_rollup_state')).toEqual(['id']);
  });

  it.each([
    ['usage_daily', 'IDX_usage_daily_owner_day', '(owner_id, day)'],
    ['usage_daily', 'IDX_usage_daily_day', '(day)'],
    ['monthly_active_devices', 'IDX_mad_month', '(month)'],
    ['push_notification_logs', 'IDX_push_logs_project_completed', '(project_id, completed_at)'],
    ['push_notification_events', 'IDX_push_events_project_created', '(project_id, created_at)'],
    ['in_app_message_impressions', 'IDX_in_app_impressions_project_created', '(project_id, created_at)'],
    ['user_events', 'IDX_user_events_project_created', '(project_id, created_at)'],
    ['device_identities', 'IDX_device_identities_project_first_seen', '(project_id, first_seen_at)'],
  ])('%s has %s on %s', async (table, name, columns) => {
    expect(await indexDef(table, name)).toContain(columns);
  });

  it('keeps a single state row', async () => {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await expect(
        qr.query(
          `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day)
           VALUES (2, '2026-11-14', '2026-08-16', '2026-08-15')`,
        ),
      ).rejects.toThrow(/CHK_usage_rollup_state_single/);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('a deleted project keeps its daily counts and loses its active-device rows', async () => {
    const owner = randomUUID();
    const project = randomUUID();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'usage')`,
      [owner, `usage-${owner}@test.local`],
    );
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'usage', $2)`, [project, owner]);
    await ds.query(
      `INSERT INTO usage_daily (project_id, owner_id, day, metric, value) VALUES ($1, $2, '2026-11-13', 'events', 5)`,
      [project, owner],
    );
    await ds.query(
      `INSERT INTO monthly_active_devices (project_id, month, device_identity_id, first_day)
       VALUES ($1, '2026-11-01', $2, '2026-11-13')`,
      [project, randomUUID()],
    );

    await ds.query(`DELETE FROM projects WHERE id = $1`, [project]);

    const [daily] = await ds.query(`SELECT count(*)::int AS n FROM usage_daily WHERE project_id = $1`, [project]);
    const [devices] = await ds.query(
      `SELECT count(*)::int AS n FROM monthly_active_devices WHERE project_id = $1`,
      [project],
    );
    expect(daily.n).toBe(1);
    expect(devices.n).toBe(0);
    await ds.query(`DELETE FROM usage_daily WHERE project_id = $1`, [project]);
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
  });
});

import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { FreePlanSeeder } from './free-plan-seeder';

/**
 * Dev builds the schema with synchronize, which never runs the migration that seeds
 * `free`; the seeder adds the same row there, so dev and migrated databases give the
 * same limits. Run inside a transaction that is rolled back, with the free-plan
 * trigger off for it alone, so the shared row is never really removed.
 */
describe('FreePlanSeeder (integration)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  const asSynchronized = (query: (sql: string) => Promise<unknown>) =>
    new FreePlanSeeder({ options: { synchronize: true }, query } as unknown as DataSource);

  it('adds the row the migration seeds when it is missing', async () => {
    const seeded = await ds.query(`SELECT code, name, mau_limit, project_limit, seat_limit, sort_order, is_active
                                   FROM plans WHERE code = 'free'`);
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`ALTER TABLE plans DISABLE TRIGGER "TRG_plans_keep_free"`);
      await runner.query(`DELETE FROM plans WHERE code = 'free'`);
      await asSynchronized((sql) => runner.query(sql)).onModuleInit();
      const rows = await runner.query(`SELECT code, name, mau_limit, project_limit, seat_limit, sort_order, is_active
                                       FROM plans WHERE code = 'free'`);
      expect(rows).toEqual([
        { code: 'free', name: 'Free', mau_limit: null, project_limit: null, seat_limit: null, sort_order: 0, is_active: true },
      ]);
      // The row as the migration seeds it, limits aside (another suite may have set them).
      expect(rows[0]).toMatchObject({ code: seeded[0].code, name: seeded[0].name, sort_order: seeded[0].sort_order });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('leaves a free row staff have edited as it is', async () => {
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`UPDATE plans SET seat_limit = 7, project_limit = 3 WHERE code = 'free'`);
      await asSynchronized((sql) => runner.query(sql)).onModuleInit();
      const [row] = await runner.query(`SELECT project_limit, seat_limit FROM plans WHERE code = 'free'`);
      expect(row).toEqual({ project_limit: 3, seat_limit: 7 });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});

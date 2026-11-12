import { DataSource, QueryRunner } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { StaffEnrolmentAllowanceEntity } from './entities/staff-enrolment-allowance.entity';
import { AddStaffEnrolmentAllowances1794450000000 } from '../../migrations/1794450000000-AddStaffEnrolmentAllowances';

const EMAIL = 'enrolment-allowances-migration@int.test';
const TABLE = 'staff_enrolment_allowances';

/**
 * The migration must build exactly what the entity describes, names included: TypeORM
 * compares index, key and constraint names, so a hand-picked name would make the next
 * `migration:generate` drop and recreate them. Run inside a transaction that is rolled
 * back, so the shared database is left as it was.
 *
 * Not in `migrations/`: the data sources load every file there as a migration.
 */
describe('migration 1794450000000 (integration)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openIntDb();
  });
  afterAll(async () => {
    await closeIntDb(ds);
  });

  const inRolledBack = async <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> => {
    const runner = ds.createQueryRunner();
    await runner.startTransaction();
    try {
      return await work(runner);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  };

  const namesIn = async (runner: QueryRunner) => {
    const constraints = (await runner.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype <> 'n' ORDER BY conname`,
      [TABLE],
    )) as { conname: string }[];
    const indexes = (await runner.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
      [TABLE],
    )) as { indexname: string }[];
    return { constraints: constraints.map((r) => r.conname), indexes: indexes.map((r) => r.indexname) };
  };

  it('names every key and index as the entity does, so nothing drifts', async () => {
    const meta = ds.getMetadata(StaffEnrolmentAllowanceEntity);
    const pk = ds.namingStrategy.primaryKeyName(
      meta.tableName,
      meta.primaryColumns.map((c) => c.databaseName),
    );
    const fks = meta.foreignKeys.map((f) => f.name);
    const indexes = meta.indices.map((i) => i.name);
    // Guards the guard: an entity with no keys would make the comparison pass on nothing.
    expect(fks).toHaveLength(1);
    expect(indexes).toHaveLength(2);

    const built = await inRolledBack(async (runner) => {
      await runner.query(`DROP TABLE "${TABLE}"`);
      await new AddStaffEnrolmentAllowances1794450000000().up(runner);
      return namesIn(runner);
    });

    expect(built.constraints).toEqual([pk, ...fks].sort());
    expect(built.indexes).toEqual([pk, ...indexes].sort());
  });

  it('closes every open window of the old allowance, and down removes the table', async () => {
    await inRolledBack(async (runner) => {
      await runner.query(`DROP TABLE "${TABLE}"`);
      const [{ id }] = await runner.query(
        `INSERT INTO users (email, password_hash, name, staff_enrolment_allowed_until)
         VALUES ($1, 'x', 'm', now() + interval '1 hour') RETURNING id`,
        [EMAIL],
      );
      const migration = new AddStaffEnrolmentAllowances1794450000000();
      await migration.up(runner);
      const [row] = await runner.query(`SELECT staff_enrolment_allowed_until FROM users WHERE id = $1`, [id]);
      expect(row.staff_enrolment_allowed_until).toBeNull();

      await migration.down(runner);
      const [{ exists }] = await runner.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [TABLE]);
      expect(exists).toBe(false);
    });
  });
});

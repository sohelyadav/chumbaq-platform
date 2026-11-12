import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb, resetFixtures, INT_PROJECT_ID } from '../../test-support/int-db';
import { IS_DO_NOT_TRACK_SQL, WITHOUT_DO_NOT_TRACK_SQL } from './tracking-consent.service';

/**
 * The do-not-track lookups run on every ingest call, so each must be able to
 * use an index for every table it reads. Two checks:
 *
 * - With sequential scans priced out (`enable_seqscan = off`), no table may
 *   still be scanned whole: if one is, there is no index the query can use.
 * - At a realistic size (50k identities, analysed), the planner's own choice
 *   must not scan `device_identities`. The first version of the lookup (ORs
 *   across columns and IN-subqueries) passes the first check, through bitmap
 *   ORs, and fails this one: at 300k rows it scanned the project's whole
 *   table, 20 ms per ingest call.
 *
 * The seeded rows live in a transaction that is rolled back.
 */
describe('Do-not-track lookups use indexes (integration)', () => {
  let ds: DataSource;

  const plan = async (sql: string, params: unknown[], atScale = false): Promise<string> => {
    const runner = ds.createQueryRunner();
    await runner.startTransaction();
    try {
      if (atScale) {
        await runner.query(
          `INSERT INTO device_identities
             (project_id, device_fingerprint, distinct_id, external_user_id, platform, do_not_track)
           SELECT $1, 'plan-fp-' || g, 'plan-d-' || (g / 2),
                  CASE WHEN g % 3 = 0 THEN 'plan-u-' || (g / 3) END, 'ios', g % 500 = 0
           FROM generate_series(1, 50000) g`,
          [INT_PROJECT_ID],
        );
        await runner.query('ANALYZE device_identities');
      } else {
        await runner.query('SET LOCAL enable_seqscan = off');
      }
      const rows: Array<{ 'QUERY PLAN': string }> = await runner.query(`EXPLAIN ${sql}`, params);
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  };

  beforeAll(async () => {
    ds = await openIntDb();
    // The at-scale plans insert rows into the fixture project, which a fresh
    // database does not have until something creates it.
    await resetFixtures(ds);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  it.each([
    ['every key', ['11111111-1111-4111-8111-111111111111', 'fp', 'distinct', 'external']],
    ['a fingerprint only', [null, 'fp', null, null]],
    ['an external id only', [null, null, null, 'external']],
  ])('isDoNotTrack scans nothing whole, given %s', async (_name, keys) => {
    const text = await plan(IS_DO_NOT_TRACK_SQL, [INT_PROJECT_ID, ...keys]);
    expect(text).not.toMatch(/Seq Scan/);
    expect(text).toMatch(/Index/);
  });

  it('isDoNotTrack does not scan the identities at a realistic size', async () => {
    const text = await plan(IS_DO_NOT_TRACK_SQL, [INT_PROJECT_ID, null, 'plan-fp-1500', 'plan-d-750', 'plan-u-1'], true);
    expect(text).not.toMatch(/Seq Scan on device_identities/);
  });

  it('withoutDoNotTrack does not scan the identities at a realistic size', async () => {
    const text = await plan(
      WITHOUT_DO_NOT_TRACK_SQL,
      [INT_PROJECT_ID, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']],
      true,
    );
    expect(text).not.toMatch(/Seq Scan on device_identities/);
  });

  it('withoutDoNotTrack scans nothing whole', async () => {
    const text = await plan(WITHOUT_DO_NOT_TRACK_SQL, [
      INT_PROJECT_ID,
      ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    ]);
    expect(text).not.toMatch(/Seq Scan/);
  });
});

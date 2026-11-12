import { DataSource } from 'typeorm';
import { SegmentRefreshScheduler } from './segment-refresh.scheduler';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  INT_PROJECT_ID,
} from '../../test-support/int-db';

/**
 * Whether a segment is due is pure SQL interval arithmetic, so it is tested
 * against real Postgres. A mocked query builder can only confirm a string was
 * passed along — it cannot tell you that `NOW() - 5 minutes` excludes a row
 * written 64 milliseconds after the previous tick, which is the entire bug.
 *
 * The scheduler is constructed with a real repository rather than having its
 * query copied into the test, so the predicate under test is the one that runs
 * in production and cannot drift away from it.
 */
describe('segment refresh cadence (integration)', () => {
  let ds: DataSource;
  let scheduler: SegmentRefreshScheduler;
  const enqueued: string[] = [];

  const SEGMENT = 'ffffffff-0000-0000-0000-00000000000b';

  const queue = {
    add: async (_name: string, data: { segmentId: string }) => {
      enqueued.push(data.segmentId);
    },
  };

  /** A materialized, active segment last refreshed `agoMs` ago. */
  const seedSegment = async (refreshMinutes: number, agoMs: number | null) => {
    await ds.query(
      `INSERT INTO segments
         (id, project_id, name, definition, evaluation_mode,
          refresh_interval_minutes, status, last_materialized_at)
       VALUES ($1, $2, 'cadence', $3, 'materialized', $4, 'active',
               CASE WHEN $5::bigint IS NULL THEN NULL
                    ELSE NOW() - ($5::bigint * INTERVAL '1 millisecond') END)`,
      [
        SEGMENT,
        INT_PROJECT_ID,
        JSON.stringify({ type: 'attribute', field: 'platform', op: 'eq', value: 'ios' }),
        refreshMinutes,
        agoMs,
      ],
    );
  };

  beforeAll(async () => {
    ds = await openIntDb();
    scheduler = new SegmentRefreshScheduler(
      ds.getRepository(SegmentEntity),
      queue as never,
    );
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    enqueued.length = 0;
  });

  it('refreshes a segment whose interval equals the cron period', async () => {
    // The live failure, reproduced: a 5-minute segment materialised 64ms after
    // the tick that enqueued it. `last_materialized_at` is written when the run
    // finishes, so it is always a little later than the tick — and the old
    // predicate therefore found it not-quite-stale at the next aligned tick and
    // left it for a whole further period. A segment asking for 5 minutes got 10.
    const fiveMinutes = 5 * 60 * 1000;
    await seedSegment(5, fiveMinutes - 64);

    expect(await scheduler.enqueueDueSegments()).toBe(1);
    expect(enqueued).toEqual([SEGMENT]);
  });

  it('does not refresh one that is genuinely early', async () => {
    // Half an interval in. The grace must buy back the run's own duration, not
    // the interval itself — otherwise it is just a shorter refresh interval
    // than the one the user chose.
    await seedSegment(5, 2.5 * 60 * 1000);

    expect(await scheduler.enqueueDueSegments()).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('holds a segment that is one second outside the grace', async () => {
    // Just beyond the tolerance: 31s short of due, with a 30s grace. Pins the
    // boundary so the grace cannot quietly grow into a cadence change.
    await seedSegment(5, 5 * 60 * 1000 - 31_000);

    expect(await scheduler.enqueueDueSegments()).toBe(0);
  });

  it('refreshes a segment that has never been materialized', async () => {
    await seedSegment(60, null);

    expect(await scheduler.enqueueDueSegments()).toBe(1);
  });

  it('claims the segment so the next tick does not enqueue it again', async () => {
    // The grace widens the window in which a segment reads as due, which makes
    // the in-flight claim matter more, not less: without it the same segment
    // would now be enqueued on consecutive ticks.
    await seedSegment(5, 5 * 60 * 1000 - 64);

    expect(await scheduler.enqueueDueSegments()).toBe(1);
    expect(await scheduler.enqueueDueSegments()).toBe(0);
    expect(enqueued).toEqual([SEGMENT]);
  });

  it('leaves a long-interval segment alone until its own interval has passed', async () => {
    // The default is 60 minutes against a 5-minute cron, where the slip was
    // small and easy to miss. It should still be exactly 60, not 60 ± a tick.
    await seedSegment(60, 30 * 60 * 1000);
    expect(await scheduler.enqueueDueSegments()).toBe(0);

    await ds.query(
      `UPDATE segments SET last_materialized_at = NOW() - INTERVAL '60 minutes' + INTERVAL '64 milliseconds'
       WHERE id = $1`,
      [SEGMENT],
    );
    expect(await scheduler.enqueueDueSegments()).toBe(1);
  });
});

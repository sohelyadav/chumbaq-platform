import { DataSource } from 'typeorm';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  INT_PROJECT_ID,
} from '../../test-support/int-db';

const SEGMENT = 'ffffffff-0000-0000-0000-00000000000a';

/**
 * `entered_at` only means anything if it survives a refresh, and whether it
 * does is a property of the SQL the materialiser runs — an upsert that updates
 * the wrong column looks identical in a mock and destroys the value here.
 * These run the real statements twice and check what a second pass leaves
 * behind.
 */
describe('segment_members.entered_at (integration)', () => {
  let ds: DataSource;

  /** The differential update the materialiser performs, verbatim. */
  const refresh = async (personKeys: string[], runAt: Date) => {
    if (personKeys.length > 0) {
      const values = personKeys
        // Cast per column: the same value feeds a timestamp and a timestamptz,
        // and Postgres will not deduce one type for both.
        .map((_, i) => `($1, $2, $${i + 4}, $3::timestamp, $3::timestamptz)`)
        .join(', ');
      await ds.query(
        `INSERT INTO segment_members
           (segment_id, project_id, person_key, materialized_at, entered_at)
         VALUES ${values}
         ON CONFLICT (segment_id, person_key)
         DO UPDATE SET materialized_at = EXCLUDED.materialized_at`,
        [SEGMENT, INT_PROJECT_ID, runAt, ...personKeys],
      );
    }
    await ds.query(
      'DELETE FROM segment_members WHERE segment_id = $1 AND materialized_at < $2',
      [SEGMENT, runAt],
    );
  };

  const enteredAt = async (personKey: string): Promise<Date | null> => {
    const rows = await ds.query(
      'SELECT entered_at FROM segment_members WHERE segment_id = $1 AND person_key = $2',
      [SEGMENT, personKey],
    );
    return rows[0]?.entered_at ?? null;
  };

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query('TRUNCATE segment_members RESTART IDENTITY CASCADE');
    await ds.query(
      `INSERT INTO segments (id, project_id, name, definition, evaluation_mode)
       VALUES ($1, $2, 'S', '{}', 'materialized')
       ON CONFLICT (id) DO NOTHING`,
      [SEGMENT, INT_PROJECT_ID],
    );
  });

  const first = new Date('2026-06-01T10:00:00Z');
  const second = new Date('2026-06-02T10:00:00Z');

  it('keeps the original entry time across a refresh', async () => {
    await refresh(['stayer'], first);
    await refresh(['stayer'], second);

    // The whole point. If a refresh restamped this, every member would look
    // like they had just joined, every hour.
    expect((await enteredAt('stayer'))?.toISOString()).toBe(first.toISOString());
  });

  it('stamps someone who joined between refreshes with the later time', async () => {
    await refresh(['stayer'], first);
    await refresh(['stayer', 'joiner'], second);

    expect((await enteredAt('joiner'))?.toISOString()).toBe(second.toISOString());
    expect((await enteredAt('stayer'))?.toISOString()).toBe(first.toISOString());
  });

  it('removes somebody who no longer matches', async () => {
    await refresh(['stayer', 'leaver'], first);
    await refresh(['stayer'], second);

    expect(await enteredAt('leaver')).toBeNull();
    expect(await enteredAt('stayer')).not.toBeNull();
  });

  it('treats a rejoin as a new entry, not the old one', async () => {
    await refresh(['boomerang'], first);
    await refresh([], second);
    const third = new Date('2026-06-03T10:00:00Z');
    await refresh(['boomerang'], third);

    // They left and came back, so this really is a fresh entry — which is what
    // lets a journey enrol them a second time.
    expect((await enteredAt('boomerang'))?.toISOString()).toBe(
      third.toISOString(),
    );
  });

  it('empties a segment that now matches nobody', async () => {
    await refresh(['a', 'b'], first);
    await refresh([], second);

    const rows = await ds.query(
      'SELECT count(*)::int AS n FROM segment_members WHERE segment_id = $1',
      [SEGMENT],
    );
    expect(rows[0].n).toBe(0);
  });
});

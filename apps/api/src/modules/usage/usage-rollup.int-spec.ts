import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { readDay } from './usage-counting';
import { USAGE_LOCK_SQL, UsageRollupService } from './usage-rollup.service';

/**
 * The roll-up as the worker runs it, against committed rows: first run and
 * backfill, catch-up after downtime, closed days frozen, today kept fresh, the
 * billing owner per day, and one run at a time per database.
 */
describe('UsageRollupService (integration)', () => {
  let ds: DataSource;
  let rollup: UsageRollupService;
  let owners: string[];
  let projects: string[];

  beforeAll(async () => {
    ds = await openIntDb();
    rollup = new UsageRollupService(ds);
    rollup.pauseMs = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await ds.query(`TRUNCATE usage_daily, monthly_active_devices, usage_rollup_state`);
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await ds.query(`TRUNCATE usage_daily, monthly_active_devices, usage_rollup_state`);
    owners = [];
    projects = [];
  });

  afterEach(async () => {
    await ds.query(`DELETE FROM usage_daily WHERE project_id = ANY($1)`, [projects]);
    await ds.query(`DELETE FROM projects WHERE id = ANY($1)`, [projects]);
    await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [owners]);
  });

  const user = async (): Promise<string> => {
    const id = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'rollup')`, [
      id,
      `rollup-${id}@test.local`,
    ]);
    owners.push(id);
    return id;
  };

  const project = async (ownerId: string): Promise<string> => {
    const id = randomUUID();
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'rollup', $2)`, [id, ownerId]);
    projects.push(id);
    return id;
  };

  const device = async (projectId: string): Promise<string> => {
    const [row] = await ds.query(
      `INSERT INTO device_identities (project_id, device_fingerprint, platform, first_seen_at)
       VALUES ($1, $2, 'ios', '2026-01-01T00:00:00Z'::timestamptz::timestamp) RETURNING id`,
      [projectId, `fp-${randomUUID()}`],
    );
    return row.id;
  };

  const event = (projectId: string, receivedAt: string, deviceId: string | null = null) =>
    ds.query(
      `INSERT INTO user_events (project_id, device_identity_id, event_name, created_at)
       VALUES ($1, $2, 'opened', $3::timestamptz::timestamp)`,
      [projectId, deviceId, receivedAt],
    );

  const state = async (lastClosedDay: string, startedOn = '2026-11-01', firstDay = '2026-08-03') =>
    ds.query(
      `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day) VALUES (1, $1, $2, $3)`,
      [startedOn, firstDay, lastClosedDay],
    );

  const readState = async () =>
    (
      await ds.query(
        `SELECT to_char(started_on, 'YYYY-MM-DD') AS "startedOn", to_char(first_day, 'YYYY-MM-DD') AS "firstDay",
                to_char(last_closed_day, 'YYYY-MM-DD') AS "lastClosedDay"
           FROM usage_rollup_state`,
      )
    )[0];

  const rows = async (projectId: string, metric?: string) =>
    ds.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, value::int AS value, owner_id AS "ownerId"
         FROM usage_daily WHERE project_id = $1 AND ($2::text IS NULL OR metric = $2) ORDER BY day, metric`,
      [projectId, metric ?? null],
    );

  it('first run: backfills from ninety days back, a month of days per tick, with no snapshots before it began', async () => {
    const p = await project(await user());
    await event(p, '2026-08-20T10:00:00Z');
    await ds.query(
      `INSERT INTO api_keys (project_id, name, key_hash, prefix) VALUES ($1, 'k', $2, 'ck_live')`,
      [p, randomUUID()],
    );

    const tick = await rollup.runTick(new Date('2026-11-14T00:31:00Z'));

    expect(tick.status).toBe('ran');
    if (tick.status !== 'ran') return;
    expect(tick.closedDays).toHaveLength(31);
    expect(tick.closedDays[0]).toBe('2026-08-16');
    expect(await readState()).toEqual({ startedOn: '2026-11-14', firstDay: '2026-08-16', lastClosedDay: '2026-09-15' });
    expect(await rows(p, 'events')).toEqual([{ day: '2026-08-20', metric: 'events', value: 1, ownerId: owners[0] }]);
    const snapshots = await ds.query(
      `SELECT count(*)::int AS n FROM usage_daily
        WHERE project_id = $1 AND metric IN ('mau_month_to_date', 'api_keys_active') AND day < '2026-11-01'`,
      [p],
    );
    expect(snapshots[0].n).toBe(0);
    expect(await rollup.readCoverage(ds.manager)).toEqual({
      startedOn: '2026-11-14',
      countedFrom: '2026-08-16',
      countedThrough: '2026-09-15',
      mauFrom: '2026-11-01',
    });
  });

  it('says nothing is counted before the first run', async () => {
    expect(await rollup.readCoverage(ds.manager)).toBeNull();
  });

  it('catch-up: closes exactly the days missed, and counts keys only for yesterday', async () => {
    const p = await project(await user());
    const d = await device(p);
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) await event(p, `${day}T10:00:00Z`, d);
    await ds.query(
      `INSERT INTO api_keys (project_id, name, key_hash, prefix) VALUES ($1, 'k', $2, 'ck_live')`,
      [p, randomUUID()],
    );
    await state('2026-11-10');

    const tick = await rollup.runTick(new Date('2026-11-14T00:31:00Z'));

    expect(tick).toEqual({ status: 'ran', closedDays: ['2026-11-11', '2026-11-12', '2026-11-13'], todayProjects: expect.any(Number) });
    expect((await readState()).lastClosedDay).toBe('2026-11-13');
    const all = await rows(p);
    expect(all.filter((r: { metric: string }) => r.metric === 'events').map((r: { day: string }) => r.day)).toEqual([
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ]);
    expect(all.filter((r: { metric: string }) => r.metric === 'api_keys_active')).toEqual([
      { day: '2026-11-13', metric: 'api_keys_active', value: 1, ownerId: owners[0] },
    ]);
    // One device, active every day: one for every day closed.
    expect(all.filter((r: { metric: string }) => r.metric === 'mau_month_to_date').map((r: { value: number }) => r.value)).toEqual([1, 1, 1]);
  });

  it('catch-up: a day closed without a key snapshot reads as unknown, a snapshot with no keys as 0', async () => {
    const withKeys = await project(await user());
    const keyless = await project(await user());
    await ds.query(
      `INSERT INTO api_keys (project_id, name, key_hash, prefix) VALUES ($1, 'k', $2, 'ck_live')`,
      [withKeys, randomUUID()],
    );
    await state('2026-11-10');

    await rollup.runTick(new Date('2026-11-14T00:31:00Z'));

    // The worker was down on the 11th and 12th: no snapshot was taken.
    for (const day of ['2026-11-11', '2026-11-12']) {
      const values = await readDay(ds.manager, [withKeys, keyless], day);
      expect(values.get(withKeys)?.api_keys_active).toBeUndefined();
      expect(values.get(keyless)?.api_keys_active).toBeUndefined();
    }
    // Yesterday's snapshot was taken: a project with no keys has a stored 0.
    const yesterday = await readDay(ds.manager, [withKeys, keyless], '2026-11-13');
    expect(yesterday.get(withKeys)?.api_keys_active).toBe(1);
    expect(yesterday.get(keyless)?.api_keys_active).toBe(0);
    expect(await rows(keyless, 'api_keys_active')).toEqual([
      { day: '2026-11-13', metric: 'api_keys_active', value: 0, ownerId: owners[1] },
    ]);
  });

  it('a closed day is never written again', async () => {
    const p = await project(await user());
    await event(p, '2026-11-13T10:00:00Z');
    await state('2026-11-12');
    await rollup.runTick(new Date('2026-11-14T00:31:00Z'));
    expect(await rows(p, 'events')).toEqual([{ day: '2026-11-13', metric: 'events', value: 1, ownerId: owners[0] }]);

    // Received on the 13th but committed late, after the day closed.
    await event(p, '2026-11-13T23:00:00Z');
    const tick = await rollup.runTick(new Date('2026-11-14T01:31:00Z'));

    expect(tick).toEqual({ status: 'ran', closedDays: [], todayProjects: expect.any(Number) });
    expect(await rows(p, 'events')).toEqual([{ day: '2026-11-13', metric: 'events', value: 1, ownerId: owners[0] }]);
  });

  it('keeps today fresh without showing it as counted', async () => {
    const p = await project(await user());
    const d = await device(p);
    await event(p, '2026-11-14T09:00:00Z', d);
    await state('2026-11-13');

    const tick = await rollup.runTick(new Date('2026-11-14T10:31:00Z'));

    expect(tick).toEqual({ status: 'ran', closedDays: [], todayProjects: expect.any(Number) });
    if (tick.status === 'ran') expect(tick.todayProjects).toBeGreaterThanOrEqual(1);
    expect(await rows(p, 'events')).toEqual([{ day: '2026-11-14', metric: 'events', value: 1, ownerId: owners[0] }]);
    expect(
      await ds.query(
        `SELECT device_identity_id AS device, to_char(month, 'YYYY-MM-DD') AS month FROM monthly_active_devices WHERE project_id = $1`,
        [p],
      ),
    ).toEqual([{ device: d, month: '2026-11-01' }]);
    expect((await rollup.readCoverage(ds.manager))?.countedThrough).toBe('2026-11-13');

    // The next hour picks up what arrived since.
    await event(p, '2026-11-14T11:00:00Z', d);
    await rollup.runTick(new Date('2026-11-14T11:31:00Z'));
    expect(await rows(p, 'events')).toEqual([{ day: '2026-11-14', metric: 'events', value: 2, ownerId: owners[0] }]);
  });

  it('writes each day under the billing owner of that day', async () => {
    const a = await user();
    const b = await user();
    const p = await project(a);
    await event(p, '2026-11-12T10:00:00Z');
    await event(p, '2026-11-13T10:00:00Z');
    await state('2026-11-11');

    // Closes the 12th, and counts the 13th so far, both under A.
    await rollup.runTick(new Date('2026-11-13T12:31:00Z'));
    expect((await rows(p, 'events')).map((r: { ownerId: string }) => r.ownerId)).toEqual([a, a]);
    // A billing transfer, then the 13th closes under its new owner.
    await ds.query(`UPDATE projects SET owner_id = $1 WHERE id = $2`, [b, p]);
    await rollup.runTick(new Date('2026-11-14T00:31:00Z'));

    expect(await rows(p, 'events')).toEqual([
      { day: '2026-11-12', metric: 'events', value: 1, ownerId: a },
      { day: '2026-11-13', metric: 'events', value: 1, ownerId: b },
    ]);
  });

  it('skips, writing nothing, while another run holds the lock', async () => {
    const p = await project(await user());
    await event(p, '2026-11-13T10:00:00Z');
    const other = ds.createQueryRunner();
    await other.connect();
    try {
      await other.query(`SELECT pg_advisory_lock(${USAGE_LOCK_SQL})`);
      expect(await rollup.runTick(new Date('2026-11-14T00:31:00Z'))).toEqual({ status: 'skipped' });
      expect(await ds.query(`SELECT * FROM usage_rollup_state`)).toEqual([]);
      expect(await rows(p)).toEqual([]);
      await other.query(`SELECT pg_advisory_unlock(${USAGE_LOCK_SQL})`);
    } finally {
      await other.release();
    }
    expect((await rollup.runTick(new Date('2026-11-14T00:31:00Z'))).status).toBe('ran');
  });
});

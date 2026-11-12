import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { DataSource, QueryRunner } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AdminInsightsService } from './admin-insights.service';

const DAY_MS = 86_400_000;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Overview counts are global, and other specs own rows in these tables. So each test
 * runs in a rolled-back REPEATABLE READ transaction and asserts deltas against a
 * baseline from the same snapshot: isolated without truncating anybody's fixtures.
 */
describe('AdminInsightsService against Postgres', () => {
  let ds: DataSource;
  let qr: QueryRunner;
  let service: AdminInsightsService;
  let todayMs: number;
  let windowStartMs: number;

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(() => closeIntDb(ds));

  beforeEach(async () => {
    qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('REPEATABLE READ');
    service = new AdminInsightsService(
      qr.manager,
      {} as Queue,
      {} as Queue,
      {} as Queue,
      { isConfigured: false, sender: null } as never,
    );
    // now() is fixed for the transaction, so this cannot straddle midnight.
    const [{ now }] = await qr.query(`SELECT now() AS now`);
    const nowMs = new Date(now).getTime();
    todayMs = nowMs - (nowMs % DAY_MS);
    windowStartMs = todayMs - 29 * DAY_MS;
  });

  afterEach(async () => {
    await qr.rollbackTransaction();
    await qr.release();
  });

  /** Stores an instant the way a `now()` default does: as session-local wall clock. */
  async function seedUser(at: number, suspended = false): Promise<string> {
    const id = randomUUID();
    await qr.query(
      `INSERT INTO users (id, email, password_hash, name, created_at, suspended_at)
       VALUES ($1, $2, 'x', 'overview', $3::timestamptz::timestamp,
               CASE WHEN $4::boolean THEN now() END)`,
      [id, `${id}@overview.test`, new Date(at).toISOString(), suspended],
    );
    return id;
  }

  async function seedLink(): Promise<string> {
    const ownerId = await seedUser(todayMs - 90 * DAY_MS);
    const projectId = randomUUID();
    await qr.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'p', $2)`, [projectId, ownerId]);
    const linkId = randomUUID();
    await qr.query(
      `INSERT INTO links (id, short_code, long_url, project_id) VALUES ($1, $2, 'https://x.test', $3)`,
      [linkId, linkId.slice(0, 20), projectId],
    );
    return linkId;
  }

  async function seedClick(linkId: string, at: number): Promise<void> {
    await qr.query(
      `INSERT INTO click_events (link_id, clicked_at, platform, device_type, redirect_type)
       VALUES ($1, $2::timestamptz::timestamp, 'ios', 'mobile', 'deep_link')`,
      [linkId, new Date(at).toISOString()],
    );
  }

  const signups = (overview: { signupsByDay: { date: string; count: number }[] }) =>
    new Map(overview.signupsByDay.map((day) => [day.date, day.count]));

  describe('overview', () => {
    it('counts a suspended tenant and keeps active + suspended equal to total', async () => {
      const before = await service.overview();
      await seedUser(todayMs - 90 * DAY_MS);
      await seedUser(todayMs - 90 * DAY_MS, true);
      const superAdmin = await seedUser(todayMs - 90 * DAY_MS);
      await qr.query(`UPDATE users SET is_super_admin = true WHERE id = $1`, [superAdmin]);

      const after = await service.overview();

      expect(after.tenants.total - before.tenants.total).toBe(3);
      expect(after.tenants.suspended - before.tenants.suspended).toBe(1);
      expect(after.tenants.active - before.tenants.active).toBe(2);
      expect(after.tenants.active + after.tenants.suspended).toBe(after.tenants.total);
    });

    it('returns numbers, not bigint strings, for every figure', async () => {
      const overview = await service.overview();

      for (const value of [
        ...Object.values(overview.tenants),
        overview.projects,
        overview.links,
        overview.identities,
        overview.clicksLast30d,
        ...overview.signupsByDay.map((day) => day.count),
      ]) {
        expect(typeof value).toBe('number');
      }
    });

    it('counts projects, links and identities', async () => {
      const before = await service.overview();
      await seedLink();
      const [{ id: projectId }] = await qr.query(`SELECT id FROM projects LIMIT 1`);
      const identityId = randomUUID();
      await qr.query(
        `INSERT INTO device_identities (id, project_id, device_fingerprint, platform, total_revenue, last_seen_at)
         VALUES ($1, $2, $3, 'ios', 0, now())`,
        [identityId, projectId, `fp-${identityId}`],
      );

      const after = await service.overview();

      expect(after.projects - before.projects).toBe(1);
      expect(after.links - before.links).toBe(1);
      expect(after.identities - before.identities).toBe(1);
    });

    // Asia/Kolkata is what dev runs on. These columns hold session-local wall clock,
    // so a query that treats them as UTC puts rows in the wrong bucket on all but UTC.
    describe.each(['UTC', 'Asia/Kolkata', 'America/Los_Angeles'])('in a %s session', (zone) => {
      beforeEach(async () => {
        await qr.query(`SET LOCAL TIME ZONE '${zone}'`);
      });

      it('has one entry for each of 30 UTC days ending today, zero days included', async () => {
        const { signupsByDay } = await service.overview();

        expect(signupsByDay).toHaveLength(30);
        expect(signupsByDay[0].date).toBe(isoDate(windowStartMs));
        expect(signupsByDay[29].date).toBe(isoDate(todayMs));
        signupsByDay.forEach((day, index) => {
          expect(day.date).toBe(isoDate(windowStartMs + index * DAY_MS));
        });
      });

      it('buckets signups by UTC day, splitting at UTC midnight', async () => {
        const before = signups(await service.overview());
        const boundary = todayMs - 10 * DAY_MS;
        await seedUser(boundary - 1);
        await seedUser(boundary);
        await seedUser(boundary);

        const after = signups(await service.overview());

        const dayBefore = isoDate(boundary - DAY_MS);
        const dayOf = isoDate(boundary);
        expect(after.get(dayBefore)! - before.get(dayBefore)!).toBe(1);
        expect(after.get(dayOf)! - before.get(dayOf)!).toBe(2);
      });

      it('includes the first instant of the window and excludes the one before', async () => {
        const before = await service.overview();
        await seedUser(windowStartMs - 1);
        await seedUser(windowStartMs);

        const after = await service.overview();

        expect(signups(after).get(isoDate(windowStartMs))! - signups(before).get(isoDate(windowStartMs))!).toBe(1);
        expect(after.tenants.newLast30d - before.tenants.newLast30d).toBe(1);
        expect(after.tenants.total - before.tenants.total).toBe(2);
      });

      it('counts clicks from the same window boundary', async () => {
        const linkId = await seedLink();
        const before = await service.overview();
        await seedClick(linkId, windowStartMs - 1);
        await seedClick(linkId, windowStartMs);
        await seedClick(linkId, todayMs);

        const after = await service.overview();

        expect(after.clicksLast30d - before.clicksLast30d).toBe(2);
      });
    });

    it('makes newLast30d the sum of signupsByDay', async () => {
      await seedUser(todayMs);
      await seedUser(todayMs - 5 * DAY_MS);

      const overview = await service.overview();

      const sum = overview.signupsByDay.reduce((total, day) => total + day.count, 0);
      expect(overview.tenants.newLast30d).toBe(sum);
    });

    it('counts clicks through the composite index, not a click_events scan', async () => {
      const links: string[] = [];
      for (let i = 0; i < 20; i++) links.push(await seedLink());
      await qr.query(
        `INSERT INTO click_events (link_id, clicked_at, platform, device_type, redirect_type)
         SELECT ($1::uuid[])[1 + (i % 20)], now()::timestamp - (i % 400) * INTERVAL '1 day',
                'ios', 'mobile', 'deep_link'
         FROM generate_series(1, 40000) AS i`,
        [links],
      );
      await qr.query(`ANALYZE click_events`);
      await qr.query(`ANALYZE links`);

      const querySpy = jest.spyOn(qr.manager, 'query');
      await service.overview();
      const totalsSql = querySpy.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes('click_events'));
      querySpy.mockRestore();

      const plan = await qr.query(`EXPLAIN ${totalsSql}`);
      const text = plan.map((row: Record<string, string>) => row['QUERY PLAN']).join('\n');
      // Forbidding a seq scan alone is not enough: a plain range count picks an index
      // scan of the whole composite index, which is the same full scan by another name.
      // The leading column has to be bound for the scan to touch only the window.
      expect(text).not.toMatch(/Seq Scan on click_events/);
      expect(text).toMatch(/Index Cond: \(\(link_id = l\.id\) AND \(clicked_at >=/);
    });
  });
});

/** getJobCounts maps `waiting` to BullMQ's `wait` list internally; pin it against Redis. */
describe('AdminInsightsService.health against Redis', () => {
  it('reads real queue counts, including a waiting job', async () => {
    const connection = {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB ?? 0),
    };
    const prefix = `int-admin-insights-${randomUUID()}`;
    const queues = ['a', 'b', 'c'].map((name) => new Queue(name, { connection, prefix }));
    try {
      await queues[0].add('job', {});
      await queues[0].add('later', {}, { delay: 60_000 });

      const service = new AdminInsightsService(
        { query: async () => [{}] } as never,
        queues[0],
        queues[1],
        queues[2],
        { isConfigured: false, sender: null } as never,
      );
      const health = await service.health();

      expect(health.status).toBe('ok');
      expect(health.redis.ok).toBe(true);
      // Reported, never part of status: chrony is absent on development machines.
      expect(['ok', 'warn', 'bad', 'unknown']).toContain(health.clock.state);
      expect(health.queues[0]).toEqual({ name: 'a', waiting: 1, active: 0, delayed: 1, failed: 0 });
      expect(health.queues[1]).toEqual({ name: 'b', waiting: 0, active: 0, delayed: 0, failed: 0 });
    } finally {
      await Promise.all(queues.map((queue) => queue.obliterate({ force: true })));
      await Promise.all(queues.map((queue) => queue.close()));
    }
  });
});

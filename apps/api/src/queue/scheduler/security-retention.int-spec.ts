import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SecurityRetentionScheduler } from './security-retention.scheduler';
import { closeIntDb, openIntDb } from '../../test-support/int-db';

/**
 * Pruning against real rows, because what is deleted is decided entirely by the
 * WHERE clauses and the batching around them. Each row sits an hour either side of
 * its window's edge, so a cutoff off by a day, or the wrong column, turns one red.
 */
describe('SecurityRetentionScheduler (integration)', () => {
  let ds: DataSource;

  const USER = 'a5100000-0000-4000-8000-000000000001';
  const HOUR = 3600;
  const DAY = 24 * HOUR;
  const REFRESH_LIFETIME_DAYS = 7;
  const EVENT_DAYS = 200;
  const ACTIVITY_DAYS = 200;

  const scheduler = () =>
    new SecurityRetentionScheduler(
      ds,
      new ConfigService({
        retention: { authEventDays: EVENT_DAYS, activityLogDays: ACTIVITY_DAYS },
        jwt: { refreshLifetimeMs: REFRESH_LIFETIME_DAYS * DAY * 1000 },
      }),
    );

  /** A timestamp `seconds` ago by the database's clock, which wrote the rows. */
  const ago = (seconds: number | null) =>
    seconds === null ? 'NULL' : `now() - make_interval(secs => ${seconds})`;

  const seedEvent = async (createdSecondsAgo: number): Promise<string> => {
    const [row] = await ds.query(
      `INSERT INTO auth_events (user_id, email, type, created_at)
       VALUES ($1, 'retention@test.local', 'login.succeeded', ${ago(createdSecondsAgo)})
       RETURNING id`,
      [USER],
    );
    return row.id;
  };

  let sessionCounter = 0;
  const seedSession = async (spec: {
    revokedSecondsAgo: number | null;
    lastUsedSecondsAgo: number;
  }): Promise<string> => {
    sessionCounter += 1;
    const id = `a5100000-0000-4000-8000-${String(sessionCounter).padStart(12, '0')}`;
    await ds.query(
      `INSERT INTO auth_sessions (id, user_id, current_jti, revoked_at, created_at, last_used_at)
       VALUES ($1, $2, gen_random_uuid(), ${ago(spec.revokedSecondsAgo)},
               ${ago(spec.lastUsedSecondsAgo + DAY)}, ${ago(spec.lastUsedSecondsAgo)})`,
      [id, USER],
    );
    return id;
  };

  const seedToken = async (spec: {
    expiresSecondsAgo: number;
    usedSecondsAgo: number | null;
  }): Promise<string> => {
    const [row] = await ds.query(
      `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at, used_at, created_at)
       VALUES ($1, 'reset_password', md5(random()::text) || md5(random()::text),
               ${ago(spec.expiresSecondsAgo)}, ${ago(spec.usedSecondsAgo)},
               ${ago(spec.expiresSecondsAgo + 1800)})
       RETURNING id`,
      [USER],
    );
    return row.id;
  };

  const surviving = async (table: string, ids: string[]): Promise<string[]> => {
    const rows: { id: string }[] = await ds.query(
      `SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.map((row) => row.id).sort();
  };

  const cleanUp = async () => {
    await ds.query(`DELETE FROM auth_events WHERE user_id = $1`, [USER]);
    await ds.query(`DELETE FROM users WHERE id = $1`, [USER]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
  });

  beforeEach(async () => {
    await cleanUp();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name)
       VALUES ($1, 'retention@test.local', 'x', 'retention')`,
      [USER],
    );
    // Whatever earlier suites left past the windows goes now, so the counts below
    // are this file's rows alone.
    await scheduler().prune();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await cleanUp();
    await closeIntDb(ds);
  });

  it('keeps auth events inside the configured window and deletes older ones', async () => {
    const inside = await seedEvent(EVENT_DAYS * DAY - HOUR);
    const outside = await seedEvent(EVENT_DAYS * DAY + HOUR);
    const recent = await seedEvent(60);

    const counts = await scheduler().prune();

    expect(await surviving('auth_events', [inside, outside, recent])).toEqual(
      [inside, recent].sort(),
    );
    expect(counts.authEvents).toBe(1);
  });

  it('deletes sessions revoked, or idle past the refresh lifetime, more than 30 days ago', async () => {
    const idleEdge = (REFRESH_LIFETIME_DAYS + 30) * DAY;
    const live = await seedSession({ revokedSecondsAgo: null, lastUsedSecondsAgo: 60 });
    const revokedInside = await seedSession({
      revokedSecondsAgo: 30 * DAY - HOUR,
      lastUsedSecondsAgo: 30 * DAY - HOUR,
    });
    const revokedOutside = await seedSession({
      revokedSecondsAgo: 30 * DAY + HOUR,
      lastUsedSecondsAgo: 30 * DAY + HOUR,
    });
    const idleInside = await seedSession({
      revokedSecondsAgo: null,
      lastUsedSecondsAgo: idleEdge - HOUR,
    });
    const idleOutside = await seedSession({
      revokedSecondsAgo: null,
      lastUsedSecondsAgo: idleEdge + HOUR,
    });
    // Revoked recently, but its tokens died long before that, so nothing is lost.
    const idleThenRevoked = await seedSession({
      revokedSecondsAgo: DAY,
      lastUsedSecondsAgo: idleEdge + HOUR,
    });

    const counts = await scheduler().prune();

    expect(
      await surviving('auth_sessions', [
        live,
        revokedInside,
        revokedOutside,
        idleInside,
        idleOutside,
        idleThenRevoked,
      ]),
    ).toEqual([live, revokedInside, idleInside].sort());
    expect(counts.authSessions).toBe(3);
  });

  it('deletes account tokens used or expired more than 7 days ago', async () => {
    const unspent = await seedToken({ expiresSecondsAgo: -1800, usedSecondsAgo: null });
    const expiredInside = await seedToken({ expiresSecondsAgo: 7 * DAY - HOUR, usedSecondsAgo: null });
    const expiredOutside = await seedToken({ expiresSecondsAgo: 7 * DAY + HOUR, usedSecondsAgo: null });
    // Spent within its life and expired since, so only `used_at` is past the window.
    const usedOutside = await seedToken({
      expiresSecondsAgo: 7 * DAY - 2 * HOUR,
      usedSecondsAgo: 7 * DAY + HOUR,
    });
    const usedInside = await seedToken({
      expiresSecondsAgo: 7 * DAY - 2 * HOUR,
      usedSecondsAgo: 7 * DAY - 3 * HOUR,
    });

    const counts = await scheduler().prune();

    expect(
      await surviving('account_tokens', [
        unspent,
        expiredInside,
        expiredOutside,
        usedOutside,
        usedInside,
      ]),
    ).toEqual([unspent, expiredInside, usedInside].sort());
    expect(counts.accountTokens).toBe(2);
  });

  it('deletes staff sessions a month after they ended, and view-as codes a week after they expired', async () => {
    const MAX_AGE = 8 * HOUR;
    const seedStaffSession = async (spec: { revokedSecondsAgo: number | null; createdSecondsAgo: number }) => {
      const [row] = await ds.query(
        `INSERT INTO staff_sessions (id, user_id, revoked_at, created_at)
         VALUES (gen_random_uuid(), $1, ${ago(spec.revokedSecondsAgo)}, ${ago(spec.createdSecondsAgo)})
         RETURNING id`,
        [USER],
      );
      return row.id as string;
    };
    const live = await seedStaffSession({ revokedSecondsAgo: null, createdSecondsAgo: HOUR });
    // Begun recently enough that only the revocation can put them past the window.
    const revokedInside = await seedStaffSession({ revokedSecondsAgo: 30 * DAY - HOUR, createdSecondsAgo: 30 * DAY });
    const revokedOutside = await seedStaffSession({ revokedSecondsAgo: 30 * DAY + HOUR, createdSecondsAgo: 30 * DAY + 2 * HOUR });
    // Never revoked: its end is created + 8 h, and the month runs from there.
    const endedInside = await seedStaffSession({ revokedSecondsAgo: null, createdSecondsAgo: MAX_AGE + 30 * DAY - HOUR });
    const endedOutside = await seedStaffSession({ revokedSecondsAgo: null, createdSecondsAgo: MAX_AGE + 30 * DAY + HOUR });

    const seedHandoff = async (expiresSecondsAgo: number) => {
      const [row] = await ds.query(
        `INSERT INTO impersonation_handoffs
           (code_hash, actor_id, actor_session_version, staff_session_id, target_id, reason, expires_at)
         VALUES (md5(random()::text) || md5(random()::text), $1, 0, $2, $1, 'x', ${ago(expiresSecondsAgo)})
         RETURNING id`,
        [USER, live],
      );
      return row.id as string;
    };
    const codeInside = await seedHandoff(7 * DAY - HOUR);
    const codeOutside = await seedHandoff(7 * DAY + HOUR);

    const counts = await new SecurityRetentionScheduler(
      ds,
      new ConfigService({
        retention: { authEventDays: EVENT_DAYS, activityLogDays: ACTIVITY_DAYS },
        jwt: { refreshLifetimeMs: REFRESH_LIFETIME_DAYS * DAY * 1000 },
        staff: { maxAgeMs: MAX_AGE * 1000 },
      }),
    ).prune();

    expect(
      await surviving('staff_sessions', [live, revokedInside, revokedOutside, endedInside, endedOutside]),
    ).toEqual([live, revokedInside, endedInside].sort());
    expect(counts.staffSessions).toBe(2);
    expect(await surviving('impersonation_handoffs', [codeInside, codeOutside])).toEqual([codeInside]);
    expect(counts.impersonationHandoffs).toBe(1);
  });

  it('deletes in bounded batches until nothing is left', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await seedEvent(EVENT_DAYS * DAY + HOUR + i));
    const keep = await seedEvent(60);

    const query = jest.spyOn(ds, 'query');
    let counts;
    let calls: unknown[][];
    try {
      counts = await scheduler().prune(10);
    } finally {
      calls = [...query.mock.calls];
      query.mockRestore();
    }
    const eventDeletes = calls.filter(([sql]) =>
      /DELETE FROM auth_events/.test(sql as string),
    );

    expect(counts.authEvents).toBe(25);
    // 10, 10, then 5: a short batch is the signal there is nothing left.
    expect(eventDeletes).toHaveLength(3);
    expect(await surviving('auth_events', [...ids, keep])).toEqual([keep]);
  });

  it('is safe on two workers at once: every row deleted exactly once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await seedEvent(EVENT_DAYS * DAY + HOUR + i));

    const [a, b] = await Promise.all([scheduler().prune(5), scheduler().prune(5)]);

    expect(a.authEvents + b.authEvents).toBe(40);
    expect(await surviving('auth_events', ids)).toEqual([]);
  });

  it('skips rows another transaction holds instead of waiting for them', async () => {
    const locked = [
      await seedEvent(EVENT_DAYS * DAY + HOUR),
      await seedEvent(EVENT_DAYS * DAY + 2 * HOUR),
    ];
    const free = await seedEvent(EVENT_DAYS * DAY + 3 * HOUR);

    // Stands in for a second worker part-way through a batch. A plain FOR UPDATE
    // would make prune() wait on this lock, so the race below would time out.
    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    let pruning: Promise<unknown> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await holder.query(`SELECT id FROM auth_events WHERE id = ANY($1::uuid[]) FOR UPDATE`, [
        locked,
      ]);

      pruning = scheduler().prune();
      const outcome = await Promise.race([
        pruning.then(() => 'finished'),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('blocked'), 3000);
        }),
      ]);

      expect(outcome).toBe('finished');
      expect(await surviving('auth_events', [...locked, free])).toEqual([...locked].sort());
    } finally {
      clearTimeout(timer);
      await holder.rollbackTransaction();
      await holder.release();
      // If it did block, let it finish now the lock is gone, so it cannot leak into
      // the next test.
      await pruning?.catch(() => undefined);
    }

    // Once released, the next run picks them up.
    const counts = await scheduler().prune();
    expect(counts.authEvents).toBe(2);
    expect(await surviving('auth_events', locked)).toEqual([]);
  });

  describe('project activity', () => {
    const projects: string[] = [];

    /** A fresh project id per test: the table is shared and append-only, so rows are told apart by it. */
    const seedActivity = async (projectId: string, daysAgo: number): Promise<string> => {
      const [row] = await ds.query(
        `INSERT INTO project_activity (project_id, actor_kind, actor_label, action, occurred_at)
         VALUES ($1, 'system', 'Chumbaq', 'project.renamed', now() - make_interval(days => $2))
         RETURNING id`,
        [projectId, daysAgo],
      );
      return row.id;
    };

    const project = () => {
      const id = randomUUID();
      projects.push(id);
      return id;
    };

    it('prunes entries past ACTIVITY_LOG_RETENTION_DAYS and keeps the rest', async () => {
      const projectId = project();
      const at201 = await seedActivity(projectId, 201);
      const at400 = await seedActivity(projectId, 400);
      const at199 = await seedActivity(projectId, 199);
      const at1 = await seedActivity(projectId, 1);

      const counts = await scheduler().prune();

      expect(await surviving('project_activity', [at201, at400, at199, at1])).toEqual(
        [at199, at1].sort(),
      );
      expect(counts.projectActivity).toBe(2);
    });

    it('deletes in bounded batches until nothing is left', async () => {
      const projectId = project();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await seedActivity(projectId, 300 + i));
      const keep = await seedActivity(projectId, 2);

      const transaction = jest.spyOn(ds, 'transaction');
      let counts;
      let batches: number;
      try {
        counts = await scheduler().prune(2);
      } finally {
        batches = transaction.mock.calls.length;
        transaction.mockRestore();
      }

      expect(counts.projectActivity).toBe(5);
      // 2, 2, 1: a short batch is the signal there is nothing left.
      expect(batches).toBe(3);
      expect(await surviving('project_activity', [...ids, keep])).toEqual([keep]);
    });
  });
});

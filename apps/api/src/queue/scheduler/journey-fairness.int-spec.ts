import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { JourneyEntity } from '../../modules/journeys/entities/journey.entity';
import { JourneyRunEntity } from '../../modules/journeys/entities/journey-run.entity';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import { JourneyScheduler } from './journey.scheduler';

/** One tenant's backlog of due journey steps must not fill every tick. */
describe('Journey runs taken in turns across projects (integration)', () => {
  let ds: DataSource;
  let scheduler: JourneyScheduler;
  const owner = randomUUID();
  const projects: string[] = [];

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'j')`, [
      owner,
      `${owner}@journey-fairness-int.test`,
    ]);
    scheduler = new JourneyScheduler(
      ds.getRepository(JourneyEntity),
      ds.getRepository(JourneyRunEntity),
      ds.getRepository(SegmentEntity),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { suspendedProjectIds: async () => new Set<string>() } as never,
    );
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    await closeIntDb(ds);
  });

  const projectWithRuns = async (runs: number, dueMinutesAgo: number) => {
    const [{ id: projectId }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('j', $1) RETURNING id`, [owner]);
    projects.push(projectId);
    const [{ id: journeyId }] = await ds.query(
      `INSERT INTO journeys (project_id, name, trigger, steps) VALUES ($1, 'j', '{}', '[]') RETURNING id`,
      [projectId],
    );
    await ds.query(
      `INSERT INTO journey_runs (project_id, journey_id, person_key, status, next_due_at)
       SELECT $1, $2, 'p-' || g, 'active', now() - make_interval(mins => $3)
         FROM generate_series(1, $4) g`,
      [projectId, journeyId, dueMinutesAgo, runs],
    );
    return projectId;
  };

  it('reaches a small tenant this tick although a big one\'s older backlog alone would fill it', async () => {
    const big = await projectWithRuns(700, 60);
    const small = await projectWithRuns(5, 1);

    const picked = await scheduler.selectDueRuns(new Date(), new Set());

    expect(picked).toHaveLength(500);
    expect(picked.filter((run) => run.projectId === small)).toHaveLength(5);
    // Other suites' due runs may take turns too; the big tenant still gets the rest.
    expect(picked.filter((run) => run.projectId === big).length).toBeGreaterThan(400);
  });

  it('leaves out a suspended tenant\'s runs', async () => {
    const suspended = await projectWithRuns(3, 5);
    const picked = await scheduler.selectDueRuns(new Date(), new Set([suspended]));
    expect(picked.some((run) => run.projectId === suspended)).toBe(false);
  });
});

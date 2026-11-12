import { DataSource } from 'typeorm';
import { JourneyScheduler } from './journey.scheduler';
import { JourneyEntity } from '../../modules/journeys/entities/journey.entity';
import { JourneyRunEntity } from '../../modules/journeys/entities/journey-run.entity';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import { openIntDb, closeIntDb, resetFixtures, INT_PROJECT_ID } from '../../test-support/int-db';

/**
 * segment_members is read by segment id, and journeys saved before segment ids
 * were checked may name another project's segment. Enrolment must never copy
 * another tenant's members into a journey's runs. Real SQL, real scheduler.
 */
describe('journey enrolment stays inside the journey’s project (integration)', () => {
  let ds: DataSource;
  let scheduler: JourneyScheduler;

  const OTHER_OWNER = '22222222-0000-4000-8000-000000000001';
  const OTHER_PROJECT = '22222222-0000-4000-8000-000000000002';
  const OTHER_SEGMENT = '22222222-0000-4000-8000-000000000003';

  beforeAll(async () => {
    ds = await openIntDb();
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
    await ds.query('DELETE FROM journeys WHERE project_id = ANY($1)', [[INT_PROJECT_ID, OTHER_PROJECT]]);
    await ds.query('DELETE FROM projects WHERE id = $1', [OTHER_PROJECT]);
    await ds.query('DELETE FROM users WHERE id = $1', [OTHER_OWNER]);
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM journeys WHERE project_id = ANY($1)', [[INT_PROJECT_ID, OTHER_PROJECT]]);
    await resetFixtures(ds);
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES ($1, 'other@test.local', 'x', 'other')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_OWNER],
    );
    await ds.query(
      `INSERT INTO projects (id, name, owner_id) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING`,
      [OTHER_PROJECT, OTHER_OWNER],
    );
    await ds.query(
      `INSERT INTO segments (id, project_id, name, definition, evaluation_mode, status)
       VALUES ($1, $2, 'theirs', $3, 'materialized', 'active')`,
      [OTHER_SEGMENT, OTHER_PROJECT, JSON.stringify({ type: 'attribute', field: 'platform', op: 'eq', value: 'ios' })],
    );
    await ds.query(
      `INSERT INTO segment_members (segment_id, project_id, person_key, entered_at)
       VALUES ($1, $2, 'their-user', NOW() - INTERVAL '1 minute')`,
      [OTHER_SEGMENT, OTHER_PROJECT],
    );
  });

  const activeJourney = (projectId: string) =>
    ds.query(
      `INSERT INTO journeys (project_id, name, status, trigger, steps, enrolled_through)
       VALUES ($1, 'j', 'active', $2, $3, NOW() - INTERVAL '1 hour') RETURNING id`,
      [
        projectId,
        JSON.stringify({ type: 'segment_entry', segmentId: OTHER_SEGMENT }),
        JSON.stringify([{ type: 'send_push', title: 'Hi' }]),
      ],
    );

  const runsOf = async (projectId: string) =>
    (await ds.query('SELECT person_key FROM journey_runs WHERE project_id = $1', [projectId])) as Array<{
      person_key: string;
    }>;

  it("never enrols another project's segment members, even for a journey saved before ids were checked", async () => {
    await activeJourney(INT_PROJECT_ID);
    await scheduler.enrolNewPeople();
    expect(await runsOf(INT_PROJECT_ID)).toEqual([]);
  });

  it('still enrols the members of the journey’s own segment', async () => {
    await activeJourney(OTHER_PROJECT);
    await scheduler.enrolNewPeople();
    expect(await runsOf(OTHER_PROJECT)).toEqual([{ person_key: 'their-user' }]);
  });
});

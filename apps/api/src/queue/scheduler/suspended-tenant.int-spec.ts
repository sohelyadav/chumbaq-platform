import { DataSource } from 'typeorm';
import { JourneyScheduler } from './journey.scheduler';
import { PushCampaignScheduleScheduler } from './push-campaign-schedule.scheduler';
import { JourneyEntity } from '../../modules/journeys/entities/journey.entity';
import { JourneyRunEntity } from '../../modules/journeys/entities/journey-run.entity';
import { PushConfigEntity } from '../../modules/push-notifications/entities/push-config.entity';
import { PushNotificationLogEntity } from '../../modules/push-notifications/entities/push-notification-log.entity';
import { ProjectEntity } from '../../modules/projects/entities/project.entity';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import {
  CAMPAIGN_MISSED_DURING_SUSPENSION,
  ProjectSuspensionService,
} from '../../modules/projects/project-suspension.service';
import { closeIntDb, openIntDb } from '../../test-support/int-db';

/**
 * The schedulers against real rows, because the claim is the question: whether a
 * row is selected, updated or left alone is decided by the WHERE clause, which a
 * repository stub can only agree with. Queues and senders are the only stubs, so
 * nothing here can send anything.
 */
describe('schedulers and suspended tenants (integration)', () => {
  let ds: DataSource;
  let campaigns: PushCampaignScheduleScheduler;
  let journeys: JourneyScheduler;
  const enqueued: string[] = [];

  const SUSPENDED_OWNER = 'a4100000-0000-4000-8000-000000000001';
  const ACTIVE_OWNER = 'a4100000-0000-4000-8000-000000000002';
  const SUSPENDED = 'a4100000-0000-4000-8000-00000000000a';
  const ACTIVE = 'a4100000-0000-4000-8000-00000000000b';
  const PROJECTS = [SUSPENDED, ACTIVE];

  const HOUR = 60 * 60 * 1000;
  const past = () => new Date(Date.now() - HOUR);

  const cleanUp = async () => {
    await ds.query(`DELETE FROM user_events WHERE project_id = ANY($1::uuid[])`, [PROJECTS]);
    await ds.query(`DELETE FROM device_identities WHERE project_id = ANY($1::uuid[])`, [PROJECTS]);
    await ds.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [PROJECTS]);
    await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [SUSPENDED_OWNER, ACTIVE_OWNER],
    ]);
  };

  const setSuspended = (suspended: boolean) =>
    ds.query(`UPDATE users SET suspended_at = ${suspended ? 'NOW()' : 'NULL'} WHERE id = $1`, [
      SUSPENDED_OWNER,
    ]);

  const seedCampaign = async (
    projectId: string,
    scheduledAt: Date,
    over: {
      recurrence?: object;
      variants?: object[];
      localTime?: boolean;
    } = {},
  ): Promise<string> => {
    const rows = await ds.query(
      `INSERT INTO push_notification_logs
         (project_id, title, status, scheduled_at, recurrence, variants, deliver_in_recipient_timezone)
       VALUES ($1, 'Hello', 'scheduled', $2, $3, $4, $5)
       RETURNING id`,
      [
        projectId,
        scheduledAt,
        over.recurrence ? JSON.stringify(over.recurrence) : null,
        over.variants ? JSON.stringify(over.variants) : null,
        over.localTime ?? false,
      ],
    );
    return rows[0].id;
  };

  const campaign = async (id: string) =>
    (
      await ds.query(
        `SELECT status, error_message, scheduled_at, completed_at, success_count, failure_count
         FROM push_notification_logs WHERE id = $1`,
        [id],
      )
    )[0];

  const seedJourney = async (projectId: string, enrolledThrough: Date): Promise<string> => {
    const rows = await ds.query(
      `INSERT INTO journeys (project_id, name, status, trigger, steps, enrolled_through)
       VALUES ($1, 'j', 'active', $2, $3, $4) RETURNING id`,
      [
        projectId,
        JSON.stringify({ type: 'event', eventName: 'signup' }),
        JSON.stringify([{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }]),
        enrolledThrough,
      ],
    );
    return rows[0].id;
  };

  const seedEvent = async (projectId: string, deviceId: string, at: Date) => {
    await ds.query(
      `INSERT INTO device_identities (id, project_id, device_fingerprint, platform, last_seen_at)
       VALUES ($1, $2, $3, 'ios', NOW()) ON CONFLICT (id) DO NOTHING`,
      [deviceId, projectId, `fp-${deviceId}`],
    );
    await ds.query(
      `INSERT INTO user_events (project_id, device_identity_id, event_name, timestamp)
       VALUES ($1, $2, 'signup', $3)`,
      [projectId, deviceId, at],
    );
  };

  beforeAll(async () => {
    ds = await openIntDb();
    const suspension = new ProjectSuspensionService(ds.getRepository(ProjectEntity));
    const unused = {} as never;
    campaigns = new PushCampaignScheduleScheduler(
      ds.getRepository(PushNotificationLogEntity),
      ds.getRepository(PushConfigEntity),
      {
        add: async (_name: string, data: { logId: string }) => {
          enqueued.push(data.logId);
        },
      } as never,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      suspension,
    );
    journeys = new JourneyScheduler(
      ds.getRepository(JourneyEntity),
      ds.getRepository(JourneyRunEntity),
      ds.getRepository(SegmentEntity),
      unused,
      unused,
      unused,
      unused,
      unused,
      suspension,
    );
  });

  beforeEach(async () => {
    enqueued.length = 0;
    await cleanUp();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, suspended_at)
       VALUES ($1, 'ws4b-suspended@test.local', 'x', 's', NOW()),
              ($2, 'ws4b-active@test.local', 'x', 'a', NULL)`,
      [SUSPENDED_OWNER, ACTIVE_OWNER],
    );
    await ds.query(
      `INSERT INTO projects (id, name, owner_id) VALUES ($1, 's', $3), ($2, 'a', $4)`,
      [SUSPENDED, ACTIVE, SUSPENDED_OWNER, ACTIVE_OWNER],
    );
  });

  afterAll(async () => {
    await cleanUp();
    await closeIntDb(ds);
  });

  describe('scheduled campaigns', () => {
    it('cancels a due one-off with a reason, and still promotes an active tenant\'s', async () => {
      const held = await seedCampaign(SUSPENDED, past());
      const live = await seedCampaign(ACTIVE, past());

      await campaigns.handleTick();

      const row = await campaign(held);
      expect(row.status).toBe('cancelled');
      expect(row.error_message).toBe(CAMPAIGN_MISSED_DURING_SUSPENSION);
      expect(row.completed_at).not.toBeNull();
      expect(row.success_count).toBe(0);
      expect(row.failure_count).toBe(0);

      expect((await campaign(live)).status).toBe('queued');
      expect(enqueued).toEqual([live]);
    });

    it('does not fire a campaign missed during a suspension after reactivation', async () => {
      const missed = await seedCampaign(SUSPENDED, past());
      await campaigns.handleTick();

      await setSuspended(false);
      await campaigns.handleTick();

      expect((await campaign(missed)).status).toBe('cancelled');
      expect(enqueued).toEqual([]);
    });

    it('leaves a campaign due after the suspension alone, so it fires on time', async () => {
      const later = await seedCampaign(SUSPENDED, new Date(Date.now() + HOUR));

      await campaigns.handleTick();
      expect((await campaign(later)).status).toBe('scheduled');

      await setSuspended(false);
      await ds.query(`UPDATE push_notification_logs SET scheduled_at = $1 WHERE id = $2`, [
        past(),
        later,
      ]);
      await campaigns.handleTick();

      expect((await campaign(later)).status).toBe('queued');
      expect(enqueued).toEqual([later]);
    });

    it('cancels experiment and local-time parents rather than splitting them', async () => {
      const experiment = await seedCampaign(SUSPENDED, past(), {
        variants: [{ key: 'a', title: 'A', weight: 100 }],
      });
      const localTime = await seedCampaign(SUSPENDED, past(), { localTime: true });

      await campaigns.handleTick();

      expect((await campaign(experiment)).status).toBe('cancelled');
      expect((await campaign(localTime)).status).toBe('cancelled');
      const children = await ds.query(
        `SELECT id FROM push_notification_logs WHERE parent_campaign_id = ANY($1::uuid[])`,
        [[experiment, localTime]],
      );
      expect(children).toEqual([]);
    });

    it('moves a long-overdue template past now, so nothing spawns in the same tick', async () => {
      const recurrence = { frequency: 'daily', atTime: '09:00', timezone: 'UTC', interval: 1 };
      const template = await seedCampaign(SUSPENDED, new Date(Date.now() - 3 * 24 * HOUR), {
        recurrence,
      });

      await campaigns.handleTick();

      const row = await campaign(template);
      expect(row.status).toBe('scheduled');
      expect(new Date(row.scheduled_at).getTime()).toBeGreaterThan(Date.now());
      expect(
        await ds.query(`SELECT id FROM push_notification_logs WHERE parent_campaign_id = $1`, [template]),
      ).toEqual([]);
    });

    it('moves a recurring template on without sending, and the series resumes', async () => {
      const recurrence = { frequency: 'daily', atTime: '09:00', timezone: 'UTC', interval: 1 };
      const firstDue = past();
      const template = await seedCampaign(SUSPENDED, firstDue, { recurrence });

      await campaigns.handleTick();

      let row = await campaign(template);
      expect(row.status).toBe('scheduled');
      expect(new Date(row.scheduled_at).getTime()).toBeGreaterThan(firstDue.getTime());
      const occurrences = () =>
        ds.query(`SELECT id FROM push_notification_logs WHERE parent_campaign_id = $1`, [template]);
      expect(await occurrences()).toEqual([]);

      await setSuspended(false);
      await ds.query(`UPDATE push_notification_logs SET scheduled_at = $1 WHERE id = $2`, [
        past(),
        template,
      ]);
      await campaigns.handleTick();

      row = await campaign(template);
      expect(row.status).toBe('scheduled');
      expect(await occurrences()).toHaveLength(1);
    });
  });

  describe('journeys', () => {
    const runState = async (journeyId: string) =>
      ds.query(
        `SELECT status, current_step_index, next_due_at, steps_taken
         FROM journey_runs WHERE journey_id = $1`,
        [journeyId],
      );

    it('is not starved by a suspended tenant\'s older backlog, which stays untouched', async () => {
      const heldJourney = await seedJourney(SUSPENDED, past());
      const liveJourney = await seedJourney(ACTIVE, past());
      // More than one tick takes, all older than the active tenant's run. A read
      // that filtered after its LIMIT would return only these.
      await ds.query(
        `INSERT INTO journey_runs
           (project_id, journey_id, person_key, status, next_due_at)
         SELECT $1, $2, 'p-' || n, 'active', NOW() - INTERVAL '1 day'
         FROM generate_series(1, 501) AS n`,
        [SUSPENDED, heldJourney],
      );
      await ds.query(
        `INSERT INTO journey_runs (project_id, journey_id, person_key, status, next_due_at)
         VALUES ($1, $2, 'p-live', 'active', NOW() - INTERVAL '1 minute')`,
        [ACTIVE, liveJourney],
      );

      await expect(journeys.advanceDueRuns()).resolves.toBe(1);

      const [live] = await runState(liveJourney);
      expect(live.current_step_index).toBe(1);

      const held = await runState(heldJourney);
      expect(held).toHaveLength(501);
      expect(held.every((run: { current_step_index: number }) => run.current_step_index === 0)).toBe(true);
      expect(held.every((run: { steps_taken: number }) => run.steps_taken === 0)).toBe(true);
      expect(held.every((run: { next_due_at: Date | null }) => run.next_due_at !== null)).toBe(true);
    });

    it('resumes a paused run where it stopped on reactivation', async () => {
      const journey = await seedJourney(SUSPENDED, past());
      await ds.query(
        `INSERT INTO journey_runs (project_id, journey_id, person_key, status, next_due_at)
         VALUES ($1, $2, 'p-1', 'active', NOW() - INTERVAL '1 day')`,
        [SUSPENDED, journey],
      );
      await expect(journeys.advanceDueRuns()).resolves.toBe(0);

      await setSuspended(false);
      await expect(journeys.advanceDueRuns()).resolves.toBe(1);

      const [run] = await runState(journey);
      expect(run.current_step_index).toBe(1);
    });

    it('enrols nobody during a suspension, and no backlog after it', async () => {
      const journey = await seedJourney(SUSPENDED, new Date(Date.now() - 2 * HOUR));
      const device = 'a4100000-0000-4000-8000-0000000000d1';
      await seedEvent(SUSPENDED, device, past());

      await expect(journeys.enrolNewPeople()).resolves.toBe(0);
      expect(await runState(journey)).toEqual([]);

      await setSuspended(false);
      await expect(journeys.enrolNewPeople()).resolves.toBe(0);
      expect(await runState(journey)).toEqual([]);

      // Somebody who fires the trigger after reactivation is enrolled as normal.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await seedEvent(SUSPENDED, device, new Date());
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(journeys.enrolNewPeople()).resolves.toBe(1);
      expect(await runState(journey)).toHaveLength(1);
    });

    it('enrols an active tenant as normal', async () => {
      const journey = await seedJourney(ACTIVE, new Date(Date.now() - 2 * HOUR));
      await seedEvent(ACTIVE, 'a4100000-0000-4000-8000-0000000000d2', past());

      await expect(journeys.enrolNewPeople()).resolves.toBe(1);
      expect(await runState(journey)).toHaveLength(1);
    });
  });
});

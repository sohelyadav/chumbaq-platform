import { DataSource } from 'typeorm';
import { PushAnalyticsService } from './push-analytics.service';
import { PushNotificationEventEntity } from './entities/push-notification-event.entity';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';

const PHONE = 'dddddddd-0000-0000-0000-000000000001';
const TABLET = 'dddddddd-0000-0000-0000-000000000002';
const STRANGER = 'dddddddd-0000-0000-0000-000000000003';

/**
 * The history is a grouped query with `FILTER` aggregates and a join, written
 * as raw fragments in a query builder. A mocked repository would prove the
 * strings were passed along and nothing about whether Postgres accepts them or
 * collapses a person's devices the way the page claims.
 */
describe('PushAnalyticsService person history (integration)', () => {
  let ds: DataSource;
  let service: PushAnalyticsService;

  const seedCampaign = async (id: string, title: string, daysAgo: number) => {
    await ds.query(
      `INSERT INTO push_notification_logs
         (id, project_id, title, target_type, total_tokens, processed_tokens,
          success_count, failure_count, status, sent_at)
       VALUES ($1, $2, $3, 'project', 1, 1, 1, 0, 'sent',
               NOW() - ($4::int * INTERVAL '1 day'))`,
      [id, INT_PROJECT_ID, title, daysAgo],
    );
  };

  const seedEvent = async (
    campaignId: string,
    deviceIdentityId: string,
    type: string,
  ) => {
    await ds.query(
      `INSERT INTO push_notification_events
         (project_id, campaign_id, device_identity_id, type, occurred_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [INT_PROJECT_ID, campaignId, deviceIdentityId, type],
    );
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new PushAnalyticsService(
      ds.getRepository(PushNotificationEventEntity),
      ds.getRepository(PushNotificationLogEntity),
      null as never,
      null as never,
      null as never,
    );
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query(
      'TRUNCATE push_notification_events, push_notification_logs RESTART IDENTITY CASCADE',
    );
    await seedPerson(ds, { id: PHONE });
    await seedPerson(ds, { id: TABLET });
    await seedPerson(ds, { id: STRANGER });
  });

  const CAMP_A = 'eeeeeeee-0000-0000-0000-00000000000a';
  const CAMP_B = 'eeeeeeee-0000-0000-0000-00000000000b';

  it('collapses one campaign across a person\'s devices into a single row', async () => {
    await seedCampaign(CAMP_A, 'Flash sale', 1);
    await seedEvent(CAMP_A, PHONE, 'delivered');
    await seedEvent(CAMP_A, TABLET, 'delivered');
    await seedEvent(CAMP_A, TABLET, 'click');

    const history = await service.getPersonCampaignHistory(INT_PROJECT_ID, [
      PHONE,
      TABLET,
    ]);

    // One line per campaign, not one per device per interaction — and opened
    // on the tablet means opened, whatever the phone did with it.
    expect(history).toHaveLength(1);
    expect(history[0].title).toBe('Flash sale');
    expect(history[0].clicked).not.toBeNull();
    expect(history[0].delivered).not.toBeNull();
  });

  it('reports an outcome that did not happen as null, not zero', async () => {
    await seedCampaign(CAMP_A, 'Never opened', 1);
    await seedEvent(CAMP_A, PHONE, 'delivered');

    const [row] = await service.getPersonCampaignHistory(INT_PROJECT_ID, [PHONE]);

    // "Delivered but not opened" and "we have no data" are different claims.
    expect(row.delivered).not.toBeNull();
    expect(row.clicked).toBeNull();
    expect(row.dismissed).toBeNull();
  });

  it('never shows another person\'s campaigns', async () => {
    await seedCampaign(CAMP_A, 'Theirs', 1);
    await seedEvent(CAMP_A, STRANGER, 'delivered');

    expect(
      await service.getPersonCampaignHistory(INT_PROJECT_ID, [PHONE, TABLET]),
    ).toEqual([]);
  });

  it('orders newest first, which is the order a support question is asked in', async () => {
    await seedCampaign(CAMP_A, 'Older', 10);
    await seedCampaign(CAMP_B, 'Newer', 1);
    await seedEvent(CAMP_A, PHONE, 'delivered');
    await seedEvent(CAMP_B, PHONE, 'delivered');

    const history = await service.getPersonCampaignHistory(INT_PROJECT_ID, [PHONE]);

    expect(history.map((h) => h.title)).toEqual(['Newer', 'Older']);
  });

  it('returns nothing for a person with no devices rather than querying', async () => {
    // `IN ()` is not valid SQL, so the empty case has to be handled.
    expect(await service.getPersonCampaignHistory(INT_PROJECT_ID, [])).toEqual([]);
  });

  it('is scoped to the project', async () => {
    await seedCampaign(CAMP_A, 'Ours', 1);
    await seedEvent(CAMP_A, PHONE, 'delivered');

    expect(
      await service.getPersonCampaignHistory(
        '99999999-9999-9999-9999-999999999999',
        [PHONE],
      ),
    ).toEqual([]);
  });
});

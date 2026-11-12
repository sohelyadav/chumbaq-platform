import { DataSource } from 'typeorm';
import { closeIntDb, INT_PROJECT_ID, openIntDb, resetFixtures, seedPerson } from '../../test-support/int-db';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { ChannelSuppressionEntity } from '../push-notifications/entities/channel-suppression.entity';
import { PushNotificationEventEntity } from '../push-notifications/entities/push-notification-event.entity';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { EmailEventsService } from './email-events.service';
import { CAMPAIGN_TAG, IDENTITY_TAG } from './email-rendering';
import { parseSesEvent } from './email-webhooks';
import { ConsentEventsService } from '../consent/consent-events.service';
import { ConsentEventEntity } from '../consent/entities/consent-event.entity';

const PERSON = 'eeeeeeee-0000-0000-0000-0000000000a1';
const CAMPAIGN = 'ffffffff-0000-0000-0000-0000000000a1';

/**
 * The SES webhook's in-memory dedupe is only a fast path: it forgets ids under
 * pressure, so the same SNS message can be processed twice. That is safe only
 * because Postgres keeps one event row per (campaign, person, type) and one
 * suppression per address, which is what this asks of Postgres itself.
 */
describe('Ingesting the same SES message twice (integration)', () => {
  let ds: DataSource;
  let events: EmailEventsService;

  // A real SES bounce as SNS delivers it, tagged by Chumbaq's sender.
  const bounce = JSON.stringify({
    eventType: 'Bounce',
    mail: {
      destination: ['gone@example.com'],
      tags: { [CAMPAIGN_TAG]: [CAMPAIGN], [IDENTITY_TAG]: [PERSON] },
    },
    bounce: {
      bounceType: 'Permanent',
      timestamp: '2026-11-06T10:00:00.000Z',
      bouncedRecipients: [{ emailAddress: 'gone@example.com', diagnosticCode: 'smtp; 550 5.1.1' }],
    },
  });

  beforeAll(async () => {
    ds = await openIntDb();
    events = new EmailEventsService(
      ds.getRepository(PushNotificationEventEntity),
      ds.getRepository(PushNotificationLogEntity),
      ds.getRepository(DeviceIdentityEntity),
      new SuppressionsService(
        ds.getRepository(ChannelSuppressionEntity),
        new ConsentEventsService(ds.getRepository(ConsentEventEntity)),
        { record: async () => undefined } as never,
      ),
    );
  });

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE channel_suppressions, push_notification_events, push_notification_logs RESTART IDENTITY CASCADE',
    );
    await resetFixtures(ds);
    await seedPerson(ds, { id: PERSON });
    await ds.query(`UPDATE device_identities SET email = 'gone@example.com' WHERE id = $1`, [PERSON]);
    await ds.query(
      `INSERT INTO push_notification_logs (id, project_id, title, channel) VALUES ($1, $2, 'x', 'email')`,
      [CAMPAIGN, INT_PROJECT_ID],
    );
  });

  afterAll(async () => {
    await ds.query(
      'TRUNCATE channel_suppressions, push_notification_events, push_notification_logs RESTART IDENTITY CASCADE',
    );
    await closeIntDb(ds);
  });

  it('keeps one event and one suppression, whether the copies arrive apart or together', async () => {
    await events.ingest(INT_PROJECT_ID, 'ses', parseSesEvent(bounce));
    await Promise.all([
      events.ingest(INT_PROJECT_ID, 'ses', parseSesEvent(bounce)),
      events.ingest(INT_PROJECT_ID, 'ses', parseSesEvent(bounce)),
    ]);

    const rows = await ds.query(
      `SELECT type FROM push_notification_events WHERE campaign_id = $1 AND device_identity_id = $2`,
      [CAMPAIGN, PERSON],
    );
    expect(rows).toEqual([{ type: 'bounced' }]);
    const suppressions = await ds.query(
      `SELECT address, reason FROM channel_suppressions WHERE project_id = $1`,
      [INT_PROJECT_ID],
    );
    expect(suppressions).toEqual([{ address: 'gone@example.com', reason: 'bounced' }]);
  });

  it('records an unsigned (Brevo) unsubscribe or complaint as unconfirmed, a signed one as confirmed', async () => {
    const at = new Date('2026-11-06T10:00:00.000Z');
    const statement = (type: 'unsubscribed' | 'complained') => ({
      type,
      address: 'gone@example.com',
      campaignId: null,
      identityId: null,
      occurredAt: at,
    });
    await events.ingest(INT_PROJECT_ID, 'brevo', [statement('unsubscribed'), statement('complained')], { signed: false });
    await events.ingest(INT_PROJECT_ID, 'resend', [statement('unsubscribed')], { signed: true });

    const rows: Array<{ source: string; granted: boolean }> = await ds.query(
      `SELECT source, granted FROM consent_events WHERE device_identity_id = $1 ORDER BY source`,
      [PERSON],
    );
    expect(rows).toEqual([
      { source: 'complaint_unsigned', granted: false },
      { source: 'provider_unsubscribe', granted: false },
      { source: 'provider_unsubscribe_unsigned', granted: false },
    ]);
    // Still honoured: the address is suppressed either way.
    const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM channel_suppressions`);
    expect(count).toBe(1);
  });
});

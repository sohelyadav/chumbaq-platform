import { DataSource } from 'typeorm';
import { EmailAudienceService, EmailAudienceScope } from './email-audience.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';

// Ids sort in this order, which the dedupe relies on ("lowest id wins").
const A = 'eeeeeeee-0000-0000-0000-000000000001';
const B = 'eeeeeeee-0000-0000-0000-000000000002';
const C = 'eeeeeeee-0000-0000-0000-000000000003';
const D = 'eeeeeeee-0000-0000-0000-000000000004';
const CAMPAIGN = 'ffffffff-0000-0000-0000-000000000001';
const OTHER_CAMPAIGN = 'ffffffff-0000-0000-0000-000000000002';

/**
 * Recipient selection is three correlated subqueries written as raw SQL —
 * suppression, one-inbox-one-email, and the cross-channel cap. A mocked
 * repository would only prove the strings were passed along; whether
 * Postgres picks the right people is the whole question, so it is asked of
 * Postgres.
 */
describe('EmailAudienceService (integration)', () => {
  let ds: DataSource;
  let service: EmailAudienceService;

  const person = async (
    id: string,
    email: string | null,
    optIn: boolean | null,
    timezone: string | null = null,
  ) => {
    await seedPerson(ds, { id });
    await ds.query(
      `UPDATE device_identities SET email = $2, email_opt_in = $3, timezone = $4 WHERE id = $1`,
      [id, email, optIn, timezone],
    );
  };

  const suppress = (address: string) =>
    ds.query(
      `INSERT INTO channel_suppressions (project_id, channel, address, reason, source)
       VALUES ($1, 'email', $2, 'unsubscribed', 'link')`,
      [INT_PROJECT_ID, address],
    );

  const campaign = (id: string) =>
    ds.query(
      `INSERT INTO push_notification_logs (id, project_id, title, channel)
       VALUES ($1, $2, 'x', 'email')`,
      [id, INT_PROJECT_ID],
    );

  const sent = (deviceIdentityId: string, campaignId: string) =>
    ds.query(
      `INSERT INTO push_notification_events
         (project_id, campaign_id, device_identity_id, type, occurred_at)
       VALUES ($1, $2, $3, 'sent', NOW())`,
      [INT_PROJECT_ID, campaignId, deviceIdentityId],
    );

  const scope = (over: Partial<EmailAudienceScope> = {}): EmailAudienceScope => ({
    projectId: INT_PROJECT_ID,
    deviceIdentityIds: null,
    requireOptIn: true,
    ...over,
  });

  /** Everyone the sender would email, across every page. */
  const deliverAll = async (s: EmailAudienceScope, cap: number | null = null) => {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await service.page(s, cursor, 2, cap, CAMPAIGN);
      if (page.length === 0) break;
      collected.push(...page.map((identity) => identity.email!));
      cursor = page[page.length - 1].id;
    }
    return collected.sort();
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new EmailAudienceService(ds.getRepository(DeviceIdentityEntity));
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE channel_suppressions, push_notification_events, push_notification_logs RESTART IDENTITY CASCADE',
    );
    await resetFixtures(ds);
  });

  it('emails each opted-in address once', async () => {
    await person(A, 'priya@example.com', true);
    await person(B, 'arjun@example.com', true);
    await person(C, 'meera@example.com', true);

    expect(await deliverAll(scope())).toEqual([
      'arjun@example.com',
      'meera@example.com',
      'priya@example.com',
    ]);
    expect(await service.count(scope(), null)).toBe(3);
  });

  it('sends one email to an inbox shared by two identities', async () => {
    await person(A, 'priya@example.com', true);
    await person(B, 'priya@example.com', true);

    expect(await deliverAll(scope())).toEqual(['priya@example.com']);
    expect(await service.listRecipientIds(scope())).toEqual([A]);
  });

  it('never emails a suppressed address', async () => {
    await person(A, 'priya@example.com', true);
    await person(B, 'arjun@example.com', true);
    await suppress('priya@example.com');

    expect(await deliverAll(scope())).toEqual(['arjun@example.com']);
  });

  it('requires explicit opt-in when the project does', async () => {
    await person(A, 'yes@example.com', true);
    await person(B, 'unknown@example.com', null);
    await person(C, 'no@example.com', false);

    expect(await deliverAll(scope({ requireOptIn: true }))).toEqual(['yes@example.com']);
    // Without the requirement, only an explicit opt-out excludes.
    expect(await deliverAll(scope({ requireOptIn: false }))).toEqual([
      'unknown@example.com',
      'yes@example.com',
    ]);
  });

  it('does not let an opted-out twin suppress the one that opted in', async () => {
    // A has the lower id but no consent. If the dedupe ignored consent, A
    // would be "better", be filtered out itself, and the address would get
    // nothing at all.
    await person(A, 'priya@example.com', false);
    await person(B, 'priya@example.com', true);

    expect(await service.listRecipientIds(scope())).toEqual([B]);
  });

  it('does not let a twin outside the audience suppress the one inside it', async () => {
    await person(A, 'priya@example.com', true);
    await person(B, 'priya@example.com', true);

    expect(await service.listRecipientIds(scope({ deviceIdentityIds: [B] }))).toEqual([B]);
  });

  it('reaches nobody for an empty audience list, never the whole project', async () => {
    await person(A, 'priya@example.com', true);

    expect(await deliverAll(scope({ deviceIdentityIds: [] }))).toEqual([]);
    expect(await service.count(scope({ deviceIdentityIds: [] }), null)).toBe(0);
  });

  it('skips people without an address', async () => {
    await person(A, null, true);
    await person(B, 'arjun@example.com', true);

    expect(await deliverAll(scope())).toEqual(['arjun@example.com']);
  });

  it('counts sends on any channel against the frequency cap', async () => {
    await person(A, 'priya@example.com', true);
    await person(B, 'arjun@example.com', true);
    await campaign(CAMPAIGN);
    await campaign(OTHER_CAMPAIGN);
    // A already had one message today — a push, as far as the cap can tell.
    await sent(A, OTHER_CAMPAIGN);

    expect(await deliverAll(scope(), 1)).toEqual(['arjun@example.com']);
    expect(await deliverAll(scope(), 2)).toEqual(['arjun@example.com', 'priya@example.com']);
  });

  it('does not cap a campaign against its own earlier pages', async () => {
    await person(A, 'priya@example.com', true);
    await campaign(CAMPAIGN);
    // Recorded by this campaign before a crash; the resume must not then
    // treat A as capped by the very message it is resending.
    await sent(A, CAMPAIGN);

    expect(await deliverAll(scope(), 1)).toEqual(['priya@example.com']);
  });

  it('groups representatives by timezone, falling back for the unknown', async () => {
    await person(A, 'priya@example.com', true, 'Asia/Kolkata');
    await person(B, 'priya@example.com', true, 'Asia/Kolkata');
    await person(C, 'tom@example.com', true, 'Europe/London');
    await person(D, 'sam@example.com', true, null);

    const grouped = await service.groupByTimezone(scope(), 'UTC');
    expect(Object.fromEntries(grouped)).toEqual({
      'Asia/Kolkata': [A],
      'Europe/London': [C],
      UTC: [D],
    });
  });
});

import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { IdentityAliasEntity } from '../identity/entities/identity-alias.entity';
import { IdentityService } from '../identity/identity.service';
import { PeopleService } from '../people/people.service';
import { AttributionService } from '../attribution/attribution.service';
import { AttributionResultEntity } from '../attribution/entities/attribution-result.entity';
import { TouchpointsService } from '../touchpoints/touchpoints.service';
import { TouchpointEntity } from '../touchpoints/entities/touchpoint.entity';
import { UserEventEntity } from '../events/entities/user-event.entity';
import { PushCampaignStateService } from '../push-notifications/push-campaign-state.service';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { PushNotificationEventEntity } from '../push-notifications/entities/push-notification-event.entity';
import { MAX_FAILURE_DETAILS } from '../../queue/queue.constants';
import {
  INT_PROJECT_ID,
  closeIntDb,
  openIntDb,
  resetFixtures,
} from '../../test-support/int-db';
import { PrivacyRequestLogEntity } from './entities/privacy-request-log.entity';
import { ErasedSuppressionsService } from './erased-suppressions.service';
import { EXPORT_ROW_CAP_PER_SECTION, PersonExportService, WITHHELD_IDENTIFIER } from './person-export.service';
import { PersonErasureService } from './person-erasure.service';
import { MAX_DEVICES_PER_PERSON, NOT_ERASED, SIGNED_IN_DEVICE_MESSAGE } from './person-scope';
import { PrivacyHashService } from './privacy-hash.service';
import { PrivacyRequestsService } from './privacy-requests.service';
import { ConsentEventsService } from '../consent/consent-events.service';
import { ConsentEventEntity } from '../consent/entities/consent-event.entity';
import { TrackingConsentService } from '../consent/tracking-consent.service';

/**
 * Erasure is a set of DELETEs written as raw SQL with typed array parameters,
 * jsonb operators and cross-table subqueries. A mocked manager would prove the
 * strings were passed along and nothing about whether Postgres runs them, or
 * whether they take exactly the person and nothing else. So every table is
 * seeded for the person, for a bystander in the same project, and for the same
 * user id in another project, and the assertions count rows with predicates
 * written here, independently of the inventory under test.
 */
const A = INT_PROJECT_ID;
const B = '33333333-3333-3333-3333-333333333333';
const OWNER = '22222222-2222-2222-2222-222222222222';
const ACTOR = { type: 'user' as const, id: OWNER };
/** The activity log is stubbed here; `project-activity/privacy-activity.int-spec.ts` covers it. */
const CTX = { ipAddress: null, userAgent: null };

// Alice (user-42) has two devices in A, one merged from an anonymous id.
const ALICE_1 = 'a1111111-0000-0000-0000-000000000001';
const ALICE_2 = 'a1111111-0000-0000-0000-000000000002';
// Bob is a bystander in A.
const BOB = 'b2222222-0000-0000-0000-000000000001';
// The same user id, and even the same fingerprint, in project B.
const ALICE_IN_B = 'c3333333-0000-0000-0000-000000000001';

const ALICE_EMAIL = 'alice@example.com';
const ALICE_PHONE = '+919876543210';
const BOB_EMAIL = 'bob@example.com';

const TEST_KEY = 'ab'.repeat(32);

interface Containers {
  link: string;
  segment: string;
  journey: string;
  message: string;
  cohort: string;
  campaign: string;
}

describe('PersonErasureService and PersonExportService (integration)', () => {
  let ds: DataSource;
  let erasure: PersonErasureService;
  let exporter: PersonExportService;
  let requests: PrivacyRequestsService;
  let suppressions: ErasedSuppressionsService;
  let identity: IdentityService;
  const containers: Record<string, Containers> = {};

  beforeAll(async () => {
    ds = await openIntDb();
    const config = { get: (key: string) => (key === 'CREDENTIALS_ENCRYPTION_KEY' ? TEST_KEY : undefined) };
    const hashes = new PrivacyHashService(new CredentialsCryptoService(config as ConfigService));
    suppressions = new ErasedSuppressionsService(ds, hashes);
    requests = new PrivacyRequestsService(ds.getRepository(PrivacyRequestLogEntity), hashes);
    erasure = new PersonErasureService(ds, suppressions, requests, { record: async () => undefined } as never);
    exporter = new PersonExportService(ds, requests, { record: async () => undefined } as never);
    identity = new IdentityService(
      ds.getRepository(DeviceIdentityEntity),
      ds.getRepository(IdentityAliasEntity),
      suppressions,
      new ConsentEventsService(ds.getRepository(ConsentEventEntity)),
      new TrackingConsentService(ds.getRepository(DeviceIdentityEntity)),
      { record: async () => undefined } as never,
    );
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const count = async (sql: string, params: unknown[]): Promise<number> =>
    (await q(`SELECT COUNT(*)::int AS n FROM ${sql}`, params))[0].n;

  const seedIdentity = (
    id: string,
    project: string,
    spec: { externalUserId?: string | null; distinctId?: string | null; fingerprint: string; email?: string | null; phone?: string | null },
  ) =>
    q(
      `INSERT INTO device_identities (id, project_id, external_user_id, distinct_id, device_fingerprint, platform, email, phone_e164, phone, first_name)
       VALUES ($1, $2, $3, $4, $5, 'ios', $6, $7, $7, 'Name')`,
      [id, project, spec.externalUserId ?? null, spec.distinctId ?? null, spec.fingerprint, spec.email ?? null, spec.phone ?? null],
    );

  const seedContainers = async (project: string, tag: string): Promise<Containers> => {
    const [link] = await q(
      `INSERT INTO links (project_id, short_code, long_url) VALUES ($1, $2, 'https://example.com') RETURNING id`,
      [project, `erase-${tag}`],
    );
    const [segment] = await q(
      `INSERT INTO segments (project_id, name, definition) VALUES ($1, 's', '{}') RETURNING id`,
      [project],
    );
    const [journey] = await q(
      `INSERT INTO journeys (project_id, name, trigger, steps) VALUES ($1, 'j', '{}', '[]') RETURNING id`,
      [project],
    );
    const [message] = await q(
      `INSERT INTO in_app_messages (project_id, name, title, message_type) VALUES ($1, 'm', 't', 'modal') RETURNING id`,
      [project],
    );
    const [cohort] = await q(
      `INSERT INTO mixpanel_cohorts ("projectId", "mixpanelCohortId", name) VALUES ($1, 1, 'c') RETURNING id`,
      [project],
    );
    const [campaign] = await q(
      `INSERT INTO push_notification_logs (project_id, title) VALUES ($1, 'campaign') RETURNING id`,
      [project],
    );
    return {
      link: link.id,
      segment: segment.id,
      journey: journey.id,
      message: message.id,
      cohort: cohort.id,
      campaign: campaign.id,
    };
  };

  /** One row in every inventory table for this identity. */
  const seedActivity = async (
    project: string,
    c: Containers,
    p: { id: string; distinctId: string; fingerprint: string; personKey: string; externalUserId: string | null; tag: string },
  ) => {
    await q(
      `INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name, ip_address) VALUES ($1, $2, $3, 'opened', '203.0.113.9')`,
      [project, p.id, p.distinctId],
    );
    // As the redirect and push-click paths write them: no distinct_id.
    const [touchpoint] = await q(
      `INSERT INTO touchpoints (project_id, distinct_id, device_fingerprint, touchpoint_type, utm_source, ip_address)
       VALUES ($1, NULL, $2, 'link_click', $3, '203.0.113.9') RETURNING id`,
      [project, p.fingerprint, `seed-utm-${p.tag}`],
    );
    const [click] = await q(
      `INSERT INTO click_events (link_id, platform, device_type, redirect_type, device_identity_id, distinct_id, ip_address)
       VALUES ($1, 'ios', 'mobile', 'app_deeplink', $2, $3, '203.0.113.9') RETURNING id`,
      [c.link, p.id, p.distinctId],
    );
    // As trackConversion writes it: the link, the latest click, the external
    // id the server sent; never a device id or distinct_id.
    const [conversion] = await q(
      `INSERT INTO conversion_events (link_id, click_event_id, event_type, external_user_id)
       VALUES ($1, $2, 'purchase', $3) RETURNING id`,
      [c.link, click.id, p.externalUserId],
    );
    // As attributeAllModels writes it: distinct_id is the conversion's id, and
    // each split a snapshot of a touchpoint.
    await q(
      `INSERT INTO attribution_results (project_id, conversion_id, distinct_id, model, credit_splits, touchpoint_count)
       VALUES ($1, $2, $3, 'last_touch', $4::jsonb, 1)`,
      [
        project,
        conversion.id,
        p.externalUserId,
        JSON.stringify([
          { touchpointId: touchpoint.id, touchpointType: 'link_click', channel: null, campaign: null, utmSource: `seed-utm-${p.tag}`, utmMedium: null, linkId: c.link, credit: 1, touchedAt: new Date().toISOString() },
        ]),
      ],
    );
    await q(
      `INSERT INTO push_tokens (project_id, device_identity_id, token, platform) VALUES ($1, $2, $3, 'ios')`,
      [project, p.id, `token-secret-${p.tag}-ENDING`],
    );
    await q(
      `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, occurred_at) VALUES ($1, $2, $3, 'sent', NOW())`,
      [project, c.campaign, p.id],
    );
    await q(
      `INSERT INTO in_app_message_impressions (message_id, project_id, device_identity_id, distinct_id, device_fingerprint, event_type)
       VALUES ($1, $2, $3, $4, $5, 'impression')`,
      [c.message, project, p.id, p.distinctId, p.fingerprint],
    );
    await q(
      `INSERT INTO pending_in_app_messages (message_id, project_id, device_fingerprint, distinct_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day')`,
      [c.message, project, p.fingerprint, p.distinctId],
    );
    await q(
      `INSERT INTO journey_runs (project_id, journey_id, person_key, status) VALUES ($1, $2, $3, 'completed')`,
      [project, c.journey, p.personKey],
    );
    await q(
      `INSERT INTO segment_members (segment_id, project_id, person_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [c.segment, project, p.personKey],
    );
    // As the cohort sync writes it: one member per Mixpanel distinct id,
    // resolved onto a device by external user id (or by distinct id when the
    // device is anonymous).
    await q(
      `INSERT INTO mixpanel_cohort_members ("cohortId", "projectId", "mixpanelDistinctId", "deviceIdentityId", "resolvedBy", "isResolved", "mixpanelProfile")
       VALUES ($1, $2, $3, $4, $5, true, '{"$email":"x"}')`,
      [
        c.cohort,
        project,
        p.distinctId,
        p.id,
        p.externalUserId && p.distinctId === p.externalUserId ? 'external_user_id' : 'distinct_id',
      ],
    );
    // Consent history, as identify and the dashboard write it, and a
    // whole-person do-not-track a team member made for their external id.
    await q(
      `INSERT INTO consent_events (project_id, device_identity_id, channel, granted, source)
       VALUES ($1, $2, 'push', false, 'sdk'), ($1, $2, 'tracking', false, 'dashboard')`,
      [project, p.id],
    );
    if (p.externalUserId) {
      await q(
        `INSERT INTO tracking_objections (project_id, external_user_id, source_identity_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [project, p.externalUserId, p.id],
      );
    }
  };

  /** Rows that name this identity, per table, with predicates independent of the inventory. */
  const footprint = async (
    project: string,
    p: { id: string; distinctId: string; fingerprint: string; personKey: string; externalUserId: string | null },
  ) => ({
    consent_events: await count('consent_events WHERE project_id = $1 AND device_identity_id = $2', [project, p.id]),
    tracking_objections: await count('tracking_objections WHERE project_id = $1 AND external_user_id = $2', [project, p.externalUserId]),
    device_identities: await count('device_identities WHERE project_id = $1 AND id = $2', [project, p.id]),
    user_events: await count('user_events WHERE project_id = $1 AND (device_identity_id = $2 OR distinct_id = $3)', [project, p.id, p.distinctId]),
    touchpoints: await count('touchpoints WHERE project_id = $1 AND device_fingerprint = $2', [project, p.fingerprint]),
    click_events: await count('click_events c JOIN links l ON l.id = c.link_id WHERE l.project_id = $1 AND c.device_identity_id = $2', [project, p.id]),
    conversion_events: await count(
      'conversion_events c JOIN links l ON l.id = c.link_id JOIN click_events k ON k.id = c.click_event_id WHERE l.project_id = $1 AND k.device_identity_id = $2',
      [project, p.id],
    ),
    attribution_results: await count(
      `attribution_results a WHERE a.project_id = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.credit_splits) s
         JOIN touchpoints t ON t.id::text = s->>'touchpointId' WHERE t.device_fingerprint = $2)`,
      [project, p.fingerprint],
    ),
    push_tokens: await count('push_tokens WHERE project_id = $1 AND device_identity_id = $2', [project, p.id]),
    push_notification_events: await count('push_notification_events WHERE project_id = $1 AND device_identity_id = $2', [project, p.id]),
    in_app_message_impressions: await count('in_app_message_impressions WHERE project_id = $1 AND device_fingerprint = $2', [project, p.fingerprint]),
    pending_in_app_messages: await count('pending_in_app_messages WHERE project_id = $1 AND device_fingerprint = $2', [project, p.fingerprint]),
    journey_runs: await count('journey_runs WHERE project_id = $1 AND person_key = $2', [project, p.personKey]),
    segment_members: await count('segment_members WHERE project_id = $1 AND person_key = $2', [project, p.personKey]),
    mixpanel_cohort_members: await count('mixpanel_cohort_members WHERE "projectId" = $1 AND "deviceIdentityId" = $2', [project, p.id]),
  });

  const alice1 = { id: ALICE_1, distinctId: 'user-42', fingerprint: 'fp-alice-1', personKey: 'user-42', externalUserId: 'user-42', tag: 'a1' };
  const alice2 = { id: ALICE_2, distinctId: 'anon-2', fingerprint: 'fp-alice-2', personKey: 'user-42', externalUserId: 'user-42', tag: 'a2' };
  const bob = { id: BOB, distinctId: 'user-7', fingerprint: 'fp-bob', personKey: 'user-7', externalUserId: 'user-7', tag: 'b' };
  const aliceInB = { id: ALICE_IN_B, distinctId: 'user-42', fingerprint: 'fp-alice-1', personKey: 'user-42', externalUserId: 'user-42', tag: 'ab' };

  beforeEach(async () => {
    await resetFixtures(ds);
    await q(
      `TRUNCATE links, touchpoints, push_notification_logs, in_app_messages, journeys, mixpanel_cohorts,
                identity_aliases, channel_suppressions, erased_suppressions, privacy_request_logs,
                tracking_objections RESTART IDENTITY CASCADE`,
    );
    await q(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING`, [B, OWNER]);

    await seedIdentity(ALICE_1, A, { externalUserId: 'user-42', distinctId: 'user-42', fingerprint: 'fp-alice-1', email: ALICE_EMAIL, phone: ALICE_PHONE });
    await seedIdentity(ALICE_2, A, { externalUserId: 'user-42', distinctId: 'anon-2', fingerprint: 'fp-alice-2' });
    await seedIdentity(BOB, A, { externalUserId: 'user-7', distinctId: 'user-7', fingerprint: 'fp-bob', email: BOB_EMAIL });
    await seedIdentity(ALICE_IN_B, B, { externalUserId: 'user-42', distinctId: 'user-42', fingerprint: 'fp-alice-1', email: ALICE_EMAIL, phone: ALICE_PHONE });

    containers.A = await seedContainers(A, 'a');
    containers.B = await seedContainers(B, 'b');
    await seedActivity(A, containers.A, alice1);
    await seedActivity(A, containers.A, alice2);
    await seedActivity(A, containers.A, bob);
    await seedActivity(B, containers.B, aliceInB);

    // An anonymous id merged into Alice before she signed in, with events of its own.
    await q(`INSERT INTO identity_aliases (project_id, anonymous_id, identified_id) VALUES ($1, 'anon-0', 'user-42'), ($2, 'anon-0', 'user-42')`, [A, B]);
    await q(`INSERT INTO user_events (project_id, distinct_id, event_name) VALUES ($1, 'anon-0', 'browsed')`, [A]);
    // An event whose identity row was deleted long ago (the FK is SET NULL).
    await q(`INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name) VALUES ($1, NULL, 'user-42', 'orphaned')`, [A]);

    for (const project of [A, B]) {
      await q(
        `INSERT INTO channel_suppressions (project_id, channel, address, reason, source)
         VALUES ($1, 'email', $2, 'unsubscribed', 'link'), ($1, 'sms', $3, 'bounced', 'twilio'), ($1, 'email', $4, 'complained', 'ses')`,
        [project, ALICE_EMAIL, ALICE_PHONE, BOB_EMAIL],
      );
    }

    await q(
      `UPDATE push_notification_logs SET target_type = 'devices', target_device_ids = $2::jsonb, control_device_ids = $3::jsonb WHERE id = $1`,
      [containers.A.campaign, JSON.stringify([ALICE_1, BOB]), JSON.stringify([ALICE_2])],
    );
  });

  const allZero = (fp: Record<string, number>) => Object.values(fp).every((n) => n === 0);
  const allPresent = (fp: Record<string, number>) => Object.values(fp).every((n) => n > 0);

  it('erases every table for the person, and nothing of the bystander or of another project', async () => {
    expect(allPresent(await footprint(A, alice1))).toBe(true);
    const bobBefore = await footprint(A, bob);
    const bBefore = await footprint(B, aliceInB);

    const result = await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);

    expect(result.result).toBe('erased');
    expect(await footprint(A, alice1)).toEqual(Object.fromEntries(Object.keys(bobBefore).map((k) => [k, 0])));
    expect(allZero(await footprint(A, alice2))).toBe(true);
    expect(await footprint(A, bob)).toEqual(bobBefore);
    expect(await footprint(B, aliceInB)).toEqual(bBefore);

    // The orphan under the verified id went; the one under an alias id stayed
    // (an alias is a claim anyone with the key can make). B's alias stayed.
    expect(await count(`user_events WHERE project_id = $1 AND distinct_id = 'user-42' AND event_name = 'orphaned'`, [A])).toBe(0);
    expect(await count(`user_events WHERE project_id = $1 AND distinct_id = 'anon-0'`, [A])).toBe(1);
    expect(await count(`identity_aliases WHERE project_id = $1`, [A])).toBe(0);
    expect(await count(`identity_aliases WHERE project_id = $1`, [B])).toBe(1);

    // Every count the response reports is what was actually deleted.
    expect(result.counts.device_identities).toBe(2);
    expect(result.counts.user_events).toBe(3); // two devices, and the orphan under the verified id
    expect(result.notErased).toEqual(NOT_ERASED);
    expect(result.counts.click_events).toBe(2);
    expect(result.counts.push_notification_logs).toBe(1);
    // Consent history goes with the devices, and is counted; the person's
    // do-not-track objection goes too, Bob's and project B's stay.
    expect(result.counts.consent_events).toBe(4);
    expect(result.counts.tracking_objections).toBe(1);
  });

  it('takes the person out of campaign target and control lists, keeping the campaign and others', async () => {
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    const [campaign] = await q(
      'SELECT target_device_ids, control_device_ids FROM push_notification_logs WHERE id = $1',
      [containers.A.campaign],
    );
    expect(campaign.target_device_ids).toEqual([BOB]);
    expect(campaign.control_device_ids).toEqual([]);
  });

  it('erasing one device of an identified user erases the whole user', async () => {
    const result = await erasure.erase(A, { type: 'personId', value: ALICE_2 }, ACTOR, CTX);
    expect(result.counts.device_identities).toBe(2);
    expect(allZero(await footprint(A, alice1))).toBe(true);
    expect(allPresent(await footprint(A, bob))).toBe(true);
  });

  it('erases an anonymous device by its fingerprint, alone', async () => {
    const ANON = 'd4444444-0000-0000-0000-000000000001';
    const anon = { id: ANON, distinctId: 'fp-anon', fingerprint: 'fp-anon', personKey: `device:${ANON}`, externalUserId: null, tag: 'n' };
    await seedIdentity(ANON, A, { fingerprint: 'fp-anon' });
    await seedActivity(A, containers.A, anon);

    const result = await erasure.erase(A, { type: 'deviceFingerprint', value: 'fp-anon' }, ACTOR, CTX);

    expect(result.counts.device_identities).toBe(1);
    expect(allZero(await footprint(A, anon))).toBe(true);
    expect(allPresent(await footprint(A, alice1))).toBe(true);
    expect(allPresent(await footprint(A, bob))).toBe(true);
  });

  it('is idempotent: a second call is a logged no-op success', async () => {
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    const again = await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    expect(again.result).toBe('nothing_to_erase');
    expect(Object.values(again.counts).every((n) => n === 0)).toBe(true);

    const byPersonId = await erasure.erase(A, { type: 'personId', value: ALICE_1 }, ACTOR, CTX);
    expect(byPersonId.result).toBe('nothing_to_erase');
    expect(await count('privacy_request_logs WHERE project_id = $1', [A])).toBe(3);
  });

  it('keeps suppressions as keyed hashes, and identify brings them back', async () => {
    const result = await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    // Counted only in the owner's request log, never in the response (an oracle).
    expect(result.counts).not.toHaveProperty('channel_suppressions');
    expect(JSON.stringify(result)).not.toMatch(/suppression/i);
    const [log] = await q('SELECT counts FROM privacy_request_logs WHERE id = $1', [result.requestId]);
    expect(log.counts).toMatchObject({ channel_suppressions: 2, erased_suppressions_kept: 2 });

    // No clear trace of Alice's addresses in A; B's and Bob's untouched.
    expect(await count('channel_suppressions WHERE project_id = $1 AND address IN ($2, $3)', [A, ALICE_EMAIL, ALICE_PHONE])).toBe(0);
    expect(await count('channel_suppressions WHERE project_id = $1', [B])).toBe(3);
    expect(await count('channel_suppressions WHERE project_id = $1 AND address = $2', [A, BOB_EMAIL])).toBe(1);
    const hashed = await q('SELECT channel, address_hash, reason FROM erased_suppressions WHERE project_id = $1 ORDER BY channel', [A]);
    expect(hashed.map((r: { channel: string; reason: string }) => [r.channel, r.reason])).toEqual([
      ['email', 'unsubscribed'],
      ['sms', 'bounced'],
    ]);
    expect(JSON.stringify(hashed)).not.toContain('alice');
    expect(JSON.stringify(hashed)).not.toContain('9876543210');

    // The customer re-imports her on a new device: the suppressions come back
    // before her address is stored, as ordinary rows every send path checks.
    await identity.identify({
      projectId: A,
      deviceFingerprint: 'fp-new',
      platform: 'ios',
      email: '  Alice@Example.com ',
      phone: '+91 98765 43210',
    } as never);
    const restored = await q(
      'SELECT channel, address, reason, source FROM channel_suppressions WHERE project_id = $1 AND address IN ($2, $3) ORDER BY channel',
      [A, ALICE_EMAIL, ALICE_PHONE],
    );
    expect(restored).toEqual([
      { channel: 'email', address: ALICE_EMAIL, reason: 'unsubscribed', source: 'erasure' },
      { channel: 'sms', address: ALICE_PHONE, reason: 'bounced', source: 'erasure' },
    ]);
    expect(await count('erased_suppressions WHERE project_id = $1', [A])).toBe(0);
    // Re-identifying an erased user is allowed (lead's default).
    expect(await count('device_identities WHERE project_id = $1 AND device_fingerprint = $2', [A, 'fp-new'])).toBe(1);
  });

  it('keeps the clear suppression while another identity in the project still holds the address', async () => {
    await q(`UPDATE device_identities SET email = $2 WHERE id = $1`, [BOB, ALICE_EMAIL]);
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    expect(await count('channel_suppressions WHERE project_id = $1 AND address = $2', [A, ALICE_EMAIL])).toBe(1);
    expect(await count('channel_suppressions WHERE project_id = $1 AND address = $2', [A, ALICE_PHONE])).toBe(0);
  });

  it('a hash from one project is never restored in another', async () => {
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    await q('DELETE FROM channel_suppressions WHERE project_id = $1', [B]);
    expect(await suppressions.restore(B, { email: ALICE_EMAIL, phoneE164: ALICE_PHONE })).toBe(0);
    expect(await count('channel_suppressions WHERE project_id = $1', [B])).toBe(0);
  });

  it('logs the request with hashes only, findable by user id', async () => {
    const result = await erasure.erase(A, { type: 'personId', value: ALICE_1 }, ACTOR, CTX);
    const [row] = await q('SELECT * FROM privacy_request_logs WHERE id = $1', [result.requestId]);
    expect(row).toMatchObject({ project_id: A, kind: 'erasure', subject_type: 'personId', actor_type: 'user', actor_id: OWNER, result: 'erased' });
    const raw = JSON.stringify(row);
    for (const identifier of ['user-42', ALICE_1, 'fp-alice', ALICE_EMAIL, 'anon-2']) {
      expect(raw).not.toContain(identifier);
    }

    const found = await requests.list(A, { externalUserId: 'user-42' });
    expect(found.map((r) => r.id)).toEqual([result.requestId]);
    expect(await requests.list(B, { externalUserId: 'user-42' })).toEqual([]);
    expect(await requests.list(A, { externalUserId: 'user-7' })).toEqual([]);
  });

  it('a device on a junk id shared by more devices than the cap is still erasable, alone', async () => {
    const values: string[] = [];
    const params: unknown[] = [A];
    for (let i = 0; i <= MAX_DEVICES_PER_PERSON; i++) {
      params.push(`fp-shared-${i}`);
      values.push(`($1, 'null', $${params.length}, 'android')`);
    }
    await q(`INSERT INTO device_identities (project_id, distinct_id, device_fingerprint, platform) VALUES ${values.join(', ')}`, params);
    await q(`INSERT INTO user_events (project_id, distinct_id, event_name) VALUES ($1, 'null', 'junk')`, [A]);

    const doc = await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-shared-0' }, ACTOR, CTX);
    expect(doc.sections.device_identities.total).toBe(1);
    const result = await erasure.erase(A, { type: 'deviceFingerprint', value: 'fp-shared-0' }, ACTOR, CTX);
    expect(result.counts.device_identities).toBe(1);
    expect(await count(`device_identities WHERE project_id = $1 AND distinct_id = 'null'`, [A])).toBe(MAX_DEVICES_PER_PERSON);
    // Events keyed only by the junk id could be anyone's: left alone.
    expect(await count(`user_events WHERE project_id = $1 AND distinct_id = 'null'`, [A])).toBe(1);
  });

  it('refuses a person with more devices than the cap, changing nothing', async () => {
    const values: string[] = [];
    const params: unknown[] = [A];
    for (let i = 0; i < MAX_DEVICES_PER_PERSON; i++) {
      params.push(`fp-many-${i}`);
      values.push(`($1, 'user-42', $${params.length}, 'android')`);
    }
    await q(`INSERT INTO device_identities (project_id, external_user_id, device_fingerprint, platform) VALUES ${values.join(', ')}`, params);

    await expect(erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX)).rejects.toMatchObject({ status: 409 });
    await expect(exporter.export(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX)).rejects.toMatchObject({ status: 409 });
    expect(allPresent(await footprint(A, alice1))).toBe(true);
    expect(await count('privacy_request_logs', [])).toBe(0);
  });

  describe('fails closed on links set from an SDK', () => {
    // The real JS SDK flow for an account switch without reset(): identify()
    // with the new user, then merge(previousDistinctId, newDistinctId), which
    // stores alias A -> B and rewrites every distinct_id A to B in the
    // project, A's other devices included.
    const switchAccounts = async () => {
      // Both of A's devices identified as A: distinct_id is the user id.
      await q(`UPDATE device_identities SET distinct_id = 'user-42' WHERE id = $1`, [ALICE_2]);
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-alice-1', platform: 'ios', externalUserId: 'user-99' } as never);
      await identity.mergeIdentity(A, 'user-42', 'user-99');
      await q(`INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name, properties) VALUES ($1, $2, 'user-99', 'b_private', '{"secret":"b"}')`, [A, ALICE_1]);
    };

    it('erasing A after an account switch leaves B, and A\'s export holds nothing of B', async () => {
      await switchAccounts();
      // ALICE_1 is now B's device; ALICE_2 is still A's, with distinct_id rewritten to B's.
      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      expect(doc.sections.device_identities.rows.map((r) => r.id)).toEqual([ALICE_2]);
      expect(JSON.stringify(doc)).not.toContain('b_private');
      expect(JSON.stringify(doc)).not.toContain(ALICE_1);
      // B's id on A's own device is withheld, and the alias naming B is not exported.
      expect(JSON.stringify(doc)).not.toContain('user-99');
      expect(doc.sections.device_identities.rows[0].distinctId).toBe(WITHHELD_IDENTIFIER);

      await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      expect(await count(`identity_aliases WHERE project_id = $1 AND anonymous_id = 'user-42' AND identified_id = 'user-99'`, [A])).toBe(1);
      expect(await count('device_identities WHERE id = $1', [ALICE_2])).toBe(0);
      expect(await count('device_identities WHERE id = $1 AND external_user_id = $2', [ALICE_1, 'user-99'])).toBe(1);
      expect(await count(`user_events WHERE project_id = $1 AND event_name = 'b_private'`, [A])).toBe(1);
      expect(await count('push_tokens WHERE device_identity_id = $1', [ALICE_1])).toBe(1);
    });

    it('erasing B after the switch leaves A\'s remaining device', async () => {
      await switchAccounts();
      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-99' }, ACTOR, CTX);
      expect(doc.sections.device_identities.rows.map((r) => r.id)).toEqual([ALICE_1]);
      await erasure.erase(A, { type: 'externalUserId', value: 'user-99' }, ACTOR, CTX);
      expect(await count('device_identities WHERE id = $1', [ALICE_2])).toBe(1);
      expect(await count('device_identities WHERE id = $1', [ALICE_1])).toBe(0);
    });

    it('an anonymous device claiming a user\'s distinct_id gets nothing of theirs and erases nothing of theirs', async () => {
      const MALLORY = 'e5555555-0000-0000-0000-000000000001';
      await seedIdentity(MALLORY, A, { distinctId: 'user-42', fingerprint: 'fp-mallory' });

      const doc = await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-mallory' }, ACTOR, CTX);
      expect(doc.sections.device_identities.rows.map((r) => r.id)).toEqual([MALLORY]);
      const raw = JSON.stringify(doc);
      for (const victim of [ALICE_1, ALICE_2, ALICE_EMAIL, 'opened', 'orphaned', 'anon-0']) {
        expect([victim, raw.includes(victim)]).toEqual([victim, false]);
      }

      await erasure.erase(A, { type: 'deviceFingerprint', value: 'fp-mallory' }, ACTOR, CTX);
      expect(allPresent(await footprint(A, alice1))).toBe(true);
      expect(allPresent(await footprint(A, alice2))).toBe(true);
      expect(await count(`user_events WHERE project_id = $1 AND event_name = 'orphaned'`, [A])).toBe(1);
    });

    it('an alias naming another user as "anonymous" is not followed', async () => {
      // A forged claim that Bob was Alice's anonymous id, in the SDK's sequence:
      // merge(user-7, user-42), then the next identify from that device.
      await identity.mergeIdentity(A, 'user-7', 'user-42');
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-bob', platform: 'ios', externalUserId: 'user-7', distinctId: 'user-7' } as never);
      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      expect(JSON.stringify(doc)).not.toContain(BOB);
      expect(JSON.stringify(doc)).not.toContain('fp-bob');
      await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      // Bob's device and everything naming it stay. (His touchpoints carry no
      // distinct_id, as production writes them, so the forged merge could not
      // move them under user-42 either.)
      expect(allPresent(await footprint(A, bob))).toBe(true);
    });

    it('an anonymous id never leads to the user it was merged into', async () => {
      // anon-x was merged into user-500, who has history but no device row
      // left, so nothing else marks user-500 as someone else's id.
      const ANON = 'f7777777-0000-0000-0000-000000000001';
      await seedIdentity(ANON, A, { distinctId: 'anon-x', fingerprint: 'fp-anon-x' });
      await q(`INSERT INTO identity_aliases (project_id, anonymous_id, identified_id) VALUES ($1, 'anon-x', 'user-500')`, [A]);
      await q(`INSERT INTO user_events (project_id, distinct_id, event_name) VALUES ($1, 'user-500', 'user500_private')`, [A]);

      const doc = await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-anon-x' }, ACTOR, CTX);
      expect(JSON.stringify(doc)).not.toContain('user500_private');
      await erasure.erase(A, { type: 'deviceFingerprint', value: 'fp-anon-x' }, ACTOR, CTX);
      expect(await count(`user_events WHERE project_id = $1 AND event_name = 'user500_private'`, [A])).toBe(1);
    });

    it('an alias never adds a device: a user aliased to a victim\'s anonymous id gets nothing of theirs', async () => {
      // Attack (b): Bob (user-7) merges a victim's anonymous distinct_id into himself.
      const VICTIM_ANON = 'f6666666-0000-0000-0000-000000000001';
      await seedIdentity(VICTIM_ANON, A, { distinctId: 'anon-victim', fingerprint: 'fp-victim-anon' });
      await q(`INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name) VALUES ($1, $2, 'anon-victim', 'victim_browsing')`, [A, VICTIM_ANON]);
      await q(`INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name) VALUES ($1, NULL, 'anon-victim', 'victim_orphan')`, [A]);
      // The SDK sequence on Bob's device: merge(previous, new), then its next identify.
      await identity.mergeIdentity(A, 'anon-victim', 'user-7');
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-bob', platform: 'ios', externalUserId: 'user-7', distinctId: 'user-7' } as never);

      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-7' }, ACTOR, CTX);
      const raw = JSON.stringify(doc);
      for (const leak of [VICTIM_ANON, 'victim_browsing', 'victim_orphan', 'fp-victim-anon']) {
        expect([leak, raw.includes(leak)]).toEqual([leak, false]);
      }

      await erasure.erase(A, { type: 'externalUserId', value: 'user-7' }, ACTOR, CTX);
      expect(await count('device_identities WHERE id = $1', [VICTIM_ANON])).toBe(1);
      expect(await count(`user_events WHERE project_id = $1 AND event_name = 'victim_browsing'`, [A])).toBe(1);
      // Documented residual: merge (unauthenticated, outside this PR) moved the
      // victim's orphan under user-7, so erasing user-7 removes it. Deletion
      // only, never disclosure: the export above did not show it.
      expect(await count(`user_events WHERE project_id = $1 AND event_name = 'victim_orphan'`, [A])).toBe(0);
    });

    it('an alias id that some device also holds is neither a key nor a way in', async () => {
      // anon-0 (merged into user-42 in the fixture) has an orphan event and no device.
      const ANON = 'f6666666-0000-0000-0000-000000000002';
      await seedIdentity(ANON, A, { distinctId: 'anon-0', fingerprint: 'fp-pre-login' });
      const result = await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      // A device now holds anon-0, so it is no longer the person's alone: neither it nor the orphan is touched.
      expect(result.counts.device_identities).toBe(2);
      expect(await count('device_identities WHERE id = $1', [ANON])).toBe(1);
      expect(await count(`user_events WHERE project_id = $1 AND distinct_id = 'anon-0'`, [A])).toBe(1);
    });

    // QA round 3 (/tmp/qa47c/r2.mjs), on rows the real write paths produce:
    // identify for devices, merge for re-keying, and orphans as ingest leaves
    // them (no device id) for events recorded before a device was known.
    const victim = async () => {
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-v-main', platform: 'web', externalUserId: 'victim-ext', distinctId: 'old-v', email: 'victim@example.com' } as never);
      await q(`INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name, ip_address) VALUES ($1, NULL, 'old-v', 'v_orphan_evt', '198.51.100.2')`, [A]);
      await q(`INSERT INTO touchpoints (project_id, distinct_id, touchpoint_type, utm_source, ip_address) VALUES ($1, 'old-v', 'page_view', 'qa-v-old', '198.51.100.2')`, [A]);
      await q(`INSERT INTO touchpoints (project_id, distinct_id, touchpoint_type, utm_source) VALUES ($1, 'anon-fp-v-main', 'page_view', 'qa-v-anon')`, [A]);
    };
    const leaksOf = (doc: unknown) => ['v_orphan_evt', '198.51.100.2', 'qa-v-', 'fp-v-main', 'victim@example.com'].filter((v) => JSON.stringify(doc).includes(v));

    for (const withMerge of [false, true]) {
      it(`an id the victim moved off (re-identify${withMerge ? ' + merge' : ''}) gives an attacker who claims it nothing`, async () => {
        await victim();
        await identity.identify({ projectId: A, deviceFingerprint: 'fp-v-main', platform: 'web', externalUserId: 'victim-ext', distinctId: 'new-v' } as never);
        if (withMerge) await identity.mergeIdentity(A, 'old-v', 'new-v');
        await identity.identify({ projectId: A, deviceFingerprint: 'fp-x', platform: 'web', distinctId: 'old-v' } as never);
        if (withMerge) await identity.mergeIdentity(A, 'anon-fp-x', 'old-v');

        expect(leaksOf(await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-x' }, ACTOR, CTX))).toEqual([]);
        await erasure.erase(A, { type: 'deviceFingerprint', value: 'fp-x' }, ACTOR, CTX);
        expect(await count(`user_events WHERE project_id = $1 AND event_name = 'v_orphan_evt'`, [A])).toBe(1);
        expect(await count(`touchpoints WHERE project_id = $1 AND utm_source LIKE 'qa-v-%'`, [A])).toBe(2);
      });
    }

    it('merge(victim pre-login id, attacker) discloses nothing of the victim', async () => {
      await victim();
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-x', platform: 'web', externalUserId: 'mallory', distinctId: 'mallory' } as never);
      await identity.mergeIdentity(A, 'anon-fp-v-main', 'mallory');
      const doc = await exporter.export(A, { type: 'externalUserId', value: 'mallory' }, ACTOR, CTX);
      // The attacker's own alias is listed, but its anonymous id is not one of
      // their devices' fingerprints, so it is withheld like any other.
      expect(doc.sections.identity_aliases.rows.map((r) => r.anonymousId)).toEqual([WITHHELD_IDENTIFIER]);
      doc.sections.identity_aliases.rows = [];
      expect(leaksOf(doc)).toEqual([]);
    });

    it('a pre-planted victim id: after the victim is erased the attacker still sees none of their leftovers', async () => {
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-x', platform: 'web', distinctId: 'victim-ext' } as never);
      await victim();
      await erasure.erase(A, { type: 'externalUserId', value: 'victim-ext' }, ACTOR, CTX);
      // The orphan under the old distinct id (never linked to victim-ext) is a documented leftover...
      expect(await count(`user_events WHERE project_id = $1 AND event_name = 'v_orphan_evt'`, [A])).toBe(1);
      // ...which the attacker's device, holding the victim's id, cannot reach.
      expect(leaksOf(await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-x' }, ACTOR, CTX))).toEqual([]);
    });

    it('claiming a victim\'s email reveals none of its suppressions, before or after the victim is erased', async () => {
      await victim();
      await q(`INSERT INTO channel_suppressions (project_id, channel, address, reason, source) VALUES ($1, 'email', 'victim@example.com', 'complained', 'webhook')`, [A]);
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-x', platform: 'web', email: 'victim@example.com' } as never);
      // Address history is never exported (an address can pass between people).
      let doc = await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-x' }, ACTOR, CTX);
      expect(doc.sections).not.toHaveProperty('channel_suppressions');
      expect(JSON.stringify(doc)).not.toContain('complained');

      // Erase the victim (the attacker still holds the address, so the clear row stays)...
      await erasure.erase(A, { type: 'externalUserId', value: 'victim-ext' }, ACTOR, CTX);
      // ...or, with the attacker gone too, the row becomes a hash, and a later claim restores it.
      await erasure.erase(A, { type: 'deviceFingerprint', value: 'fp-x' }, ACTOR, CTX);
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-x2', platform: 'web', email: 'victim@example.com' } as never);
      expect(await count(`channel_suppressions WHERE project_id = $1 AND address = 'victim@example.com'`, [A])).toBe(1);
      doc = await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-x2' }, ACTOR, CTX);
      expect(JSON.stringify(doc)).not.toContain('complained');
    });

    it('a Mixpanel member is exported only when resolved by the verified external id', async () => {
      const [cohort] = await q(`SELECT id FROM mixpanel_cohorts WHERE "projectId" = $1`, [A]);
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-x', platform: 'web', externalUserId: 'mallory', distinctId: 'mallory', email: 'victim@example.com' } as never);
      const [mallory] = await q(`SELECT id FROM device_identities WHERE device_fingerprint = 'fp-x' AND project_id = $1`, [A]);
      await q(
        `INSERT INTO mixpanel_cohort_members ("cohortId", "projectId", "mixpanelDistinctId", "deviceIdentityId", "resolvedBy", "isResolved", "mixpanelProfile")
         VALUES ($1, $2, 'victim-mp', $3, 'email', true, '{"$email":"victim@example.com","secret":"by-email"}'),
                ($1, $2, 'mallory-alias', $3, 'distinct_id', true, '{"secret":"by-distinct"}'),
                ($1, $2, 'mallory', $3, 'external_user_id', true, '{"own":"profile"}')`,
        [cohort.id, A, mallory.id],
      );
      const doc = await exporter.export(A, { type: 'externalUserId', value: 'mallory' }, ACTOR, CTX);
      // Only the member the sync resolved by mallory's own external id: one
      // resolved onto this device by a claimed email or distinct id is absent.
      expect(doc.sections.mixpanel_cohort_members.rows.map((r) => r.mixpanelDistinctId)).toEqual(['mallory']);
      const raw = JSON.stringify(doc.sections.mixpanel_cohort_members.rows);
      expect(raw).not.toContain('by-email');
      expect(raw).not.toContain('by-distinct');
      expect(raw).toContain('"own":"profile"');
    });

    it('email events for an address another record also holds are not disclosed', async () => {
      await victim();
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-x', platform: 'web', email: 'victim@example.com' } as never);
      const [x] = await q(`SELECT id FROM device_identities WHERE device_fingerprint = 'fp-x' AND project_id = $1`, [A]);
      const [mail] = await q(`INSERT INTO push_notification_logs (project_id, title, channel) VALUES ($1, 'mail', 'email') RETURNING id`, [A]);
      await q(
        `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, occurred_at) VALUES ($1, $2, $3, 'impression', NOW()), ($1, $4, $3, 'click', NOW())`,
        [A, mail.id, x.id, containers.A.campaign],
      );
      const doc = await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-x' }, ACTOR, CTX);
      expect(doc.sections.push_notification_events.rows.map((r) => r.campaignId)).toEqual([containers.A.campaign]);
    });

    it('attribution snapshots of a victim\'s touchpoints are not exported to whoever converted, and are scrubbed when the victim is erased', async () => {
      // Attribution reads touchpoints by distinct_id; this one carries the
      // victim's id (as any touchpoint keyed by distinct_id would).
      const [tp] = await q(
        `INSERT INTO touchpoints (project_id, distinct_id, device_fingerprint, touchpoint_type, utm_source, campaign)
         VALUES ($1, 'user-42', 'fp-alice-1', 'link_click', 'alice-secret-utm', 'alice-private-campaign') RETURNING id`,
        [A],
      );
      // Bob merges Alice's id into his own, then converts.
      await identity.mergeIdentity(A, 'user-42', 'user-7');
      const [conversion] = await q(
        `INSERT INTO conversion_events (link_id, event_type, external_user_id) VALUES ($1, 'purchase', 'user-7') RETURNING id, converted_at`,
        [containers.A.link],
      );
      const attribution = new AttributionService(ds.getRepository(AttributionResultEntity), new TouchpointsService(ds.getRepository(TouchpointEntity)));
      await attribution.attributeAllModels({ projectId: A, conversionId: conversion.id, distinctId: 'user-7', conversionTime: new Date(Date.now() + 1000) });
      expect(await count(`attribution_results WHERE conversion_id = $1 AND credit_splits::text LIKE '%alice-secret-utm%'`, [conversion.id])).toBe(4);

      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-7' }, ACTOR, CTX);
      expect(doc.sections.attribution_results.total).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(doc)).not.toContain('alice-secret-utm');
      expect(JSON.stringify(doc)).not.toContain('alice-private-campaign');

      await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      // Bob's attribution rows stay, without Alice's touchpoint.
      expect(await count(`attribution_results WHERE conversion_id = $1`, [conversion.id])).toBe(4);
      expect(await count(`attribution_results WHERE project_id = $1 AND credit_splits::text LIKE '%' || $2 || '%'`, [A, tp.id])).toBe(0);
    });

    it('withholds every SDK-set id that is not the person\'s own, whether or not anyone holds it', async () => {
      // Bob's own claims: aliases into user-7 naming an existing user id, an
      // existing fingerprint, and an id nobody holds. None may be confirmed.
      await identity.mergeIdentity(A, 'nobody-such-user', 'user-7');
      await q(`INSERT INTO identity_aliases (project_id, anonymous_id, identified_id) VALUES ($1, 'user-42', 'user-7'), ($1, 'fp-alice-2', 'user-7')`, [A]);
      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-7' }, ACTOR, CTX);
      expect(doc.sections.identity_aliases.rows.map((r) => r.anonymousId)).toEqual([WITHHELD_IDENTIFIER, WITHHELD_IDENTIFIER, WITHHELD_IDENTIFIER]);
      // His own device's distinct_id is his external id, so it shows.
      expect(doc.sections.device_identities.rows[0].distinctId).toBe('user-7');
    });

    it('a device that claims a user\'s external id cannot be exported or erased by fingerprint as that user', async () => {
      // Attack (a): a device identifies with the victim's external id.
      await identity.identify({ projectId: A, deviceFingerprint: 'fp-claimer', platform: 'ios', externalUserId: 'user-42' } as never);
      await expect(exporter.export(A, { type: 'deviceFingerprint', value: 'fp-claimer' }, ACTOR, CTX)).rejects.toThrow(SIGNED_IN_DEVICE_MESSAGE);
      await expect(erasure.erase(A, { type: 'deviceFingerprint', value: 'fp-claimer' }, ACTOR, CTX)).rejects.toThrow(SIGNED_IN_DEVICE_MESSAGE);
      expect(allPresent(await footprint(A, alice1))).toBe(true);
      expect(await count('privacy_request_logs', [])).toBe(0);
    });

    it('a victim\'s export holds nothing of an anonymous device claiming their distinct_id', async () => {
      const MALLORY = 'e5555555-0000-0000-0000-000000000002';
      await seedIdentity(MALLORY, A, { distinctId: 'user-42', fingerprint: 'fp-mallory-2', email: 'mallory@example.com' });
      await q(`INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name) VALUES ($1, $2, 'user-42', 'mallory_evt')`, [A, MALLORY]);
      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      const raw = JSON.stringify(doc);
      for (const leak of [MALLORY, 'fp-mallory-2', 'mallory@example.com', 'mallory_evt']) {
        expect([leak, raw.includes(leak)]).toEqual([leak, false]);
      }
      await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      expect(await count('device_identities WHERE id = $1', [MALLORY])).toBe(1);
      expect(await count(`user_events WHERE project_id = $1 AND event_name = 'mallory_evt'`, [A])).toBe(1);
    });

    it('a signed-in user on a junk id shared by strangers below the cap gets none of them', async () => {
      // QA c2: 50 anonymous strangers share distinct_id 'null' with Alice's device.
      await q(`UPDATE device_identities SET distinct_id = 'null' WHERE id = $1`, [ALICE_1]);
      const values: string[] = [];
      const params: unknown[] = [A];
      for (let i = 0; i < 50; i++) {
        params.push(`fp-stranger-${i}`);
        values.push(`($1, 'null', $${params.length}, 'android')`);
      }
      await q(`INSERT INTO device_identities (project_id, distinct_id, device_fingerprint, platform) VALUES ${values.join(', ')}`, params);
      await q(
        `INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name)
         SELECT project_id, id, 'null', 'stranger_evt' FROM device_identities WHERE device_fingerprint LIKE 'fp-stranger-%'`,
      );

      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      expect(doc.sections.device_identities.total).toBe(2);
      expect(JSON.stringify(doc)).not.toContain('stranger');
      expect(doc.sections.device_identities.rows.find((r) => r.id === ALICE_1)?.distinctId).toBe(WITHHELD_IDENTIFIER);

      await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      expect(await count(`device_identities WHERE project_id = $1 AND device_fingerprint LIKE 'fp-stranger-%'`, [A])).toBe(50);
      expect(await count(`user_events WHERE project_id = $1 AND event_name = 'stranger_evt'`, [A])).toBe(50);
    });

      it('an id another device holds in any column is not a key: distinct_id or fingerprint', async () => {
      // A stranger's device uses Alice's fingerprint as its distinct_id, and
      // another's fingerprint is Alice's distinct_id anon-2. Orphan rows keyed
      // by either could be theirs.
      await seedIdentity('e5555555-0000-0000-0000-000000000003', A, { distinctId: 'fp-alice-1', fingerprint: 'fp-copycat' });
      await seedIdentity('e5555555-0000-0000-0000-000000000004', A, { fingerprint: 'anon-2' });
      await q(
        `INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name) VALUES ($1, NULL, 'fp-alice-1', 'fp_orphan'), ($1, NULL, 'anon-2', 'anon2_orphan')`,
        [A],
      );
      const result = await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      expect(await count(`user_events WHERE project_id = $1 AND event_name IN ('fp_orphan', 'anon2_orphan')`, [A])).toBe(2);
    });
  });

  it('removes the person\'s entries from campaign failure records, keeping others\'', async () => {
    await q(
      `UPDATE push_notification_logs SET failure_details = $2::jsonb WHERE id = $1`,
      [
        containers.A.campaign,
        JSON.stringify([
          { token: ALICE_EMAIL, error: 'bounced' },
          { token: BOB_EMAIL, error: 'bounced' },
          { token: 'token-secret-a1-ENDING', error: 'unregistered' },
          { token: ALICE_PHONE, error: 'undeliverable' },
        ]),
      ],
    );
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    const [campaign] = await q('SELECT failure_details FROM push_notification_logs WHERE id = $1', [containers.A.campaign]);
    expect(campaign.failure_details).toEqual([{ token: BOB_EMAIL, error: 'bounced' }]);
  });

  it('scrubs failure records on a campaign that names the person nowhere else', async () => {
    const [other] = await q(
      `INSERT INTO push_notification_logs (project_id, title, failure_details) VALUES ($1, 'mail', $2::jsonb) RETURNING id`,
      [A, JSON.stringify([{ token: ALICE_EMAIL, error: 'x' }])],
    );
    const result = await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    const [row] = await q('SELECT failure_details FROM push_notification_logs WHERE id = $1', [other.id]);
    expect(row.failure_details).toEqual([]);
    expect(result.counts.push_notification_logs).toBe(2);
  });

  it('a kept clear suppression gets no hash, so a resubscribe is not undone later', async () => {
    await q(`UPDATE device_identities SET email = $2 WHERE id = $1`, [BOB, ALICE_EMAIL]);
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    expect(await count(`erased_suppressions WHERE project_id = $1`, [A])).toBe(1); // the phone only
    expect(await count(`erased_suppressions WHERE project_id = $1 AND channel = 'email'`, [A])).toBe(0);

    // The address resubscribes, then shows up again on a new device.
    await q(`DELETE FROM channel_suppressions WHERE project_id = $1 AND address = $2`, [A, ALICE_EMAIL]);
    await identity.identify({ projectId: A, deviceFingerprint: 'fp-again', platform: 'ios', email: ALICE_EMAIL } as never);
    expect(await count('channel_suppressions WHERE project_id = $1 AND address = $2', [A, ALICE_EMAIL])).toBe(0);
  });

  it('serialises erasure with an identify storing the same address (two connections)', async () => {
    // Alice is the only holder of her address. An identify on another device
    // has taken the address lock (its restore ran) but not yet committed.
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await suppressions.restore(A, { email: ALICE_EMAIL }, runner.manager);
      let erased = false;
      const erasing = erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX).then(() => (erased = true));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(erased).toBe(false); // waiting on the address lock

      await runner.query(
        `INSERT INTO device_identities (project_id, device_fingerprint, platform, email) VALUES ($1, 'fp-racer', 'ios', $2)`,
        [A, ALICE_EMAIL],
      );
      await runner.commitTransaction();
      await erasing;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    // The erasure saw the new holder and kept the clear row: never unsuppressed.
    expect(await count('channel_suppressions WHERE project_id = $1 AND address = $2', [A, ALICE_EMAIL])).toBe(1);
  });

  it('a row recorded by another device is that device\'s, whatever distinct_id it claims', async () => {
    // Bob's device sends events, clicks and impressions under Alice's (clean) anon-2.
    await q(`INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name) VALUES ($1, $2, 'anon-2', 'bob_claims')`, [A, BOB]);
    await q(
      `INSERT INTO click_events (link_id, platform, device_type, redirect_type, device_identity_id, distinct_id) VALUES ($1, 'ios', 'mobile', 'app_deeplink', $2, 'anon-2')`,
      [containers.A.link, BOB],
    );
    await q(
      `INSERT INTO in_app_message_impressions (message_id, project_id, device_identity_id, distinct_id, device_fingerprint, event_type) VALUES ($1, $2, $3, 'anon-2', 'fp-bob', 'click')`,
      [containers.A.message, A, BOB],
    );
    const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    expect(JSON.stringify(doc)).not.toContain('bob_claims');
    expect(doc.sections.click_events.total).toBe(2);
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    expect(await count(`user_events WHERE project_id = $1 AND event_name = 'bob_claims'`, [A])).toBe(1);
    expect(await count('click_events WHERE device_identity_id = $1', [BOB])).toBe(2);
    expect(await count('in_app_message_impressions WHERE device_identity_id = $1', [BOB])).toBe(2);
  });

  it('keeps failure entries for an address another identity still holds', async () => {
    await q(`UPDATE device_identities SET email = $2 WHERE id = $1`, [BOB, ALICE_EMAIL]);
    await q(`UPDATE push_notification_logs SET failure_details = $2::jsonb WHERE id = $1`, [
      containers.A.campaign,
      JSON.stringify([{ token: ALICE_EMAIL, error: 'bounced' }, { token: ALICE_PHONE, error: 'x' }]),
    ]);
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    const [campaign] = await q('SELECT failure_details FROM push_notification_logs WHERE id = $1', [containers.A.campaign]);
    expect(campaign.failure_details).toEqual([{ token: ALICE_EMAIL, error: 'bounced' }]);
  });

  it('a dashboard trait edit waiting on an erasure does not bring the row back', async () => {
    const people = new PeopleService(ds.getRepository(DeviceIdentityEntity), ds.getRepository(UserEventEntity));
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let result: unknown;
    try {
      await runner.query('SELECT id FROM device_identities WHERE id = $1 FOR UPDATE', [ALICE_1]);
      const editing = people.updatePersonTraits(A, ALICE_1, { vip: true }).then((r) => (result = r));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await runner.query('DELETE FROM device_identities WHERE id = $1', [ALICE_1]);
      await runner.commitTransaction();
      await editing;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    expect(result).toBeNull();
    expect(await count('device_identities WHERE id = $1', [ALICE_1])).toBe(0);
  });

  it('a campaign batch landing after the scrub cannot write an erased address back', async () => {
    const state = new PushCampaignStateService(
      ds.getRepository(PushNotificationLogEntity),
      ds.getRepository(PushNotificationEventEntity),
    );
    const campaign = containers.A.campaign;
    await q(`UPDATE push_notification_logs SET failure_details = $2::jsonb WHERE id = $1`, [
      campaign,
      JSON.stringify([{ token: ALICE_EMAIL, error: 'bounced' }]),
    ]);
    // Stand-in for the erasure: lock the campaign row, then scrub it.
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query('SELECT id FROM push_notification_logs WHERE id = $1 FOR UPDATE', [campaign]);
      const recording = state.recordBatch(campaign, {
        successCount: 0,
        failureCount: 1,
        failures: [{ token: BOB_EMAIL, error: 'bounced' }],
        lastTokenId: BOB,
        processedInBatch: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await runner.query(`UPDATE push_notification_logs SET failure_details = '[]'::jsonb WHERE id = $1`, [campaign]);
      await runner.commitTransaction();
      await recording;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    const [row] = await q('SELECT failure_details, failure_count FROM push_notification_logs WHERE id = $1', [campaign]);
    expect(row.failure_details).toEqual([{ token: BOB_EMAIL, error: 'bounced' }]);
  });

  it('a failure append racing an erasure waits for it and then drops the erased address (two connections)', async () => {
    const state = new PushCampaignStateService(
      ds.getRepository(PushNotificationLogEntity),
      ds.getRepository(PushNotificationEventEntity),
    );
    const campaign = containers.A.campaign;
    // Stand-in for the erasure, in its order: lock Alice's devices, scrub the
    // campaign, delete the devices; commit only after the append has started.
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query('SELECT id FROM device_identities WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[ALICE_1, ALICE_2]]);
      await runner.query(`UPDATE push_notification_logs SET failure_details = '[]'::jsonb WHERE id = $1`, [campaign]);
      await runner.query('DELETE FROM device_identities WHERE id = ANY($1::uuid[])', [[ALICE_1, ALICE_2]]);
      const appending = state.recordBatch(campaign, {
        successCount: 0,
        failureCount: 3,
        // Alice's email and push token (deleted with her device), and Bob's address.
        failures: [
          { token: ALICE_EMAIL, error: 'bounced' },
          { token: 'token-secret-a1-ENDING', error: 'unregistered' },
          { token: BOB_EMAIL, error: 'bounced' },
        ],
        lastTokenId: BOB,
        processedInBatch: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await runner.commitTransaction();
      await appending;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    const [row] = await q('SELECT failure_details FROM push_notification_logs WHERE id = $1', [campaign]);
    expect(row.failure_details).toEqual([{ token: BOB_EMAIL, error: 'bounced' }]);
  });

  it('a campaign batch holding a push token lock while an erasure runs does not deadlock it (two connections)', async () => {
    const campaign = containers.A.campaign;
    // Counts the erasure's transactions: a deadlock would show as a retry.
    const attempts = jest.spyOn(erasure as unknown as { eraseOnce: () => Promise<unknown> }, 'eraseOnce');
    // The batch's transaction, in the append's order: FOR KEY SHARE on the
    // push token it is about to record, then a write to the campaign row.
    const batch = ds.createQueryRunner();
    await batch.connect();
    await batch.startTransaction();
    let batchError: unknown = null;
    try {
      await batch.query(`SELECT 1 FROM push_tokens WHERE project_id = $1 AND token = $2 FOR KEY SHARE`, [A, 'token-secret-a1-ENDING']);
      // The real erasure starts now: it locks Alice's devices and her tokens
      // before any campaign row, so it waits here for the batch.
      const erasing = erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await batch
        .query(
          `UPDATE push_notification_logs SET failure_details = COALESCE(failure_details, '[]'::jsonb) || $2::jsonb WHERE id = $1`,
          [campaign, JSON.stringify([{ token: 'token-secret-a1-ENDING', error: 'unregistered' }])],
        )
        .catch((error: unknown) => (batchError = error));
      await batch.commitTransaction();
      await erasing;
    } finally {
      if (batch.isTransactionActive) await batch.rollbackTransaction();
      await batch.release();
    }
    expect(batchError).toBeNull();
    expect(attempts).toHaveBeenCalledTimes(1);
    attempts.mockRestore();
    // The erasure ran after the batch, so it scrubbed the token the batch wrote.
    const [row] = await q('SELECT failure_details FROM push_notification_logs WHERE id = $1', [campaign]);
    expect(JSON.stringify(row.failure_details ?? [])).not.toContain('token-secret-a1');
    expect(await count('push_tokens WHERE device_identity_id = $1', [ALICE_1])).toBe(0);
  });

  it('appends campaign failures in SQL, in order, capped', async () => {
    const state = new PushCampaignStateService(
      ds.getRepository(PushNotificationLogEntity),
      ds.getRepository(PushNotificationEventEntity),
    );
    const campaign = containers.A.campaign;
    const existing = Array.from({ length: MAX_FAILURE_DETAILS - 2 }, (_, i) => ({ token: `old-${i}`, error: 'x' }));
    await q(`UPDATE push_notification_logs SET failure_details = $2::jsonb WHERE id = $1`, [campaign, JSON.stringify(existing)]);
    // Real recipients: addresses devices in the project hold.
    for (let i = 0; i < 5; i++) {
      await seedIdentity(`d7777777-0000-0000-0000-00000000000${i}`, A, { fingerprint: `fp-recipient-${i}`, email: `new-${i}@example.com` });
    }
    await state.recordBatch(campaign, {
      successCount: 0,
      failureCount: 5,
      failures: Array.from({ length: 5 }, (_, i) => ({ token: `new-${i}@example.com`, error: 'y' })),
      lastTokenId: BOB,
      processedInBatch: 5,
    });
    const [row] = await q('SELECT failure_details, failure_count FROM push_notification_logs WHERE id = $1', [campaign]);
    expect(row.failure_details).toHaveLength(MAX_FAILURE_DETAILS);
    expect(row.failure_details.slice(-2)).toEqual([
      { token: 'new-0@example.com', error: 'y' },
      { token: 'new-1@example.com', error: 'y' },
    ]);
    expect(row.failure_count).toBe(5);
    // A null column starts empty.
    await q(`UPDATE push_notification_logs SET failure_details = NULL WHERE id = $1`, [campaign]);
    await state.recordBatch(campaign, { successCount: 0, failureCount: 1, failures: [{ token: BOB_EMAIL, error: 'z' }], lastTokenId: BOB, processedInBatch: 1 });
    const [after] = await q('SELECT failure_details FROM push_notification_logs WHERE id = $1', [campaign]);
    expect(after.failure_details).toEqual([{ token: BOB_EMAIL, error: 'z' }]);
  });

  it('a batch in flight cannot write an erased address back: it is no longer held', async () => {
    const state = new PushCampaignStateService(
      ds.getRepository(PushNotificationLogEntity),
      ds.getRepository(PushNotificationEventEntity),
    );
    await erasure.erase(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);
    await state.recordBatch(containers.A.campaign, {
      successCount: 0,
      failureCount: 3,
      failures: [
        { token: ALICE_EMAIL, error: 'bounced' },
        { token: 'token-secret-a1-ENDING', error: 'unregistered' },
        { token: 'token-secret-b-ENDING', error: 'unregistered' },
      ],
      lastTokenId: BOB,
      processedInBatch: 3,
    });
    const [row] = await q('SELECT failure_details, failure_count FROM push_notification_logs WHERE id = $1', [containers.A.campaign]);
    // Alice's address and token are gone from the project; Bob's token is still held.
    expect(row.failure_details).toEqual([{ token: 'token-secret-b-ENDING', error: 'unregistered' }]);
    expect(row.failure_count).toBe(3);
  });

  it('an identify waiting on an erasure does not bring the erased row back', async () => {
    // Stand-in for the erasure: lock Alice's device row, then delete it.
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query('SELECT id FROM device_identities WHERE id = $1 FOR UPDATE', [ALICE_1]);
      const identifying = identity.identify({
        projectId: A,
        deviceFingerprint: 'fp-alice-1',
        platform: 'ios',
        traits: { plan: 'pro' },
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await runner.query('DELETE FROM device_identities WHERE id = $1', [ALICE_1]);
      await runner.commitTransaction();
      await identifying;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    // A new row from the request alone, not the old one written back.
    const rows = await q(`SELECT id, email, first_name, external_user_id FROM device_identities WHERE device_fingerprint = 'fp-alice-1' AND project_id = $1`, [A]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(ALICE_1);
    expect(rows[0]).toMatchObject({ email: null, first_name: null, external_user_id: null });
  });

  describe('export', () => {
    it('returns the person\'s rows from every section and nobody else\'s', async () => {
      const doc = await exporter.export(A, { type: 'externalUserId', value: 'user-42' }, ACTOR, CTX);

      expect(doc.truncated).toBe(false);
      expect(doc.sections.device_identities.rows.map((r) => r.id).sort()).toEqual([ALICE_1, ALICE_2]);
      // Device-linked events only: no orphan is ever disclosed.
      expect(doc.sections.user_events.total).toBe(2);
      expect(JSON.stringify(doc)).not.toContain('orphaned');
      for (const name of [
        'attribution_results', 'conversion_events', 'click_events', 'touchpoints', 'push_notification_events',
        'in_app_message_impressions', 'pending_in_app_messages', 'journey_runs', 'segment_members',
        'mixpanel_cohort_members', 'identity_aliases', 'push_tokens', 'consent_events', 'tracking_objections',
      ]) {
        expect([name, doc.sections[name].total > 0]).toEqual([name, true]);
      }
      expect(doc.sections).not.toHaveProperty('channel_suppressions');
      expect(doc.notIncluded.join(' ')).toContain('Email, SMS and WhatsApp delivery and opt-out history');

      const raw = JSON.stringify(doc);
      expect(raw).not.toContain(BOB);
      expect(raw).not.toContain(BOB_EMAIL);
      expect(raw).not.toContain(ALICE_IN_B);
      // Push tokens are delivery credentials: only their ending is exported.
      expect(raw).not.toContain('token-secret');
      expect(doc.sections.push_tokens.rows[0]).toMatchObject({ tokenEnding: '…ENDING' });
      expect(doc.sections.push_tokens.rows[0]).not.toHaveProperty('token');
      // Every writer of these is per row now (PR #48), so they are the device's own.
      for (const device of doc.sections.device_identities.rows) {
        expect(device).toHaveProperty('lastEventAt');
        expect(device).toHaveProperty('lastSeenAt');
        expect(device).toHaveProperty('doNotTrackSource');
      }
      // Alice's history and objection; nothing of who made it or from where.
      expect(doc.sections.consent_events.rows.map((r) => r.deviceIdentityId).sort()).toEqual(
        [ALICE_1, ALICE_1, ALICE_2, ALICE_2].sort(),
      );
      expect(doc.sections.tracking_objections.rows).toEqual([
        { externalUserId: 'user-42', createdAt: expect.any(Date) },
      ]);
      // Counts every split, including withheld ones.
      for (const result of doc.sections.attribution_results.rows) expect(result).not.toHaveProperty('touchpointCount');
      // Internal diagnostics are not exported.
      expect(doc.sections.journey_runs.rows[0]).not.toHaveProperty('lastError');

      const [log] = await q(`SELECT kind, result FROM privacy_request_logs WHERE project_id = $1`, [A]);
      expect(log).toEqual({ kind: 'export', result: 'exported' });
    });

    it('caps a section and says so', async () => {
      await q(
        `INSERT INTO user_events (project_id, device_identity_id, distinct_id, event_name, timestamp)
         SELECT $1, $2, 'user-42', 'bulk', NOW() - (g * INTERVAL '1 second') FROM generate_series(1, $3::int) g`,
        [A, ALICE_1, EXPORT_ROW_CAP_PER_SECTION],
      );
      const doc = await exporter.export(A, { type: 'personId', value: ALICE_1 }, ACTOR, CTX);
      expect(doc.sections.user_events.total).toBe(EXPORT_ROW_CAP_PER_SECTION + 2);
      expect(doc.sections.user_events.rows).toHaveLength(EXPORT_ROW_CAP_PER_SECTION);
      expect(doc.sections.user_events.truncated).toBe(true);
      expect(doc.truncated).toBe(true);
      expect(doc.sections.device_identities.truncated).toBe(false);
    });

    it('an unknown person exports empty sections, logged as nothing found', async () => {
      const doc = await exporter.export(A, { type: 'deviceFingerprint', value: 'fp-nobody' }, ACTOR, CTX);
      expect(Object.values(doc.sections).every((s) => s.total === 0 && s.rows.length === 0)).toBe(true);
      const [log] = await q(`SELECT result FROM privacy_request_logs WHERE project_id = $1`, [A]);
      expect(log.result).toBe('nothing_found');
    });
  });
});

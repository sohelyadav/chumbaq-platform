import { DataSource } from 'typeorm';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { IdentityAliasEntity } from '../identity/entities/identity-alias.entity';
import { IdentityService } from '../identity/identity.service';
import { ChannelSuppressionEntity } from '../push-notifications/entities/channel-suppression.entity';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { ConsentEventsService } from './consent-events.service';
import { ConsentEventEntity } from './entities/consent-event.entity';
import { TrackingConsentService } from './tracking-consent.service';
import { PersonObjectionsService } from './person-objections.service';
import { TrackingObjectionEntity } from './entities/tracking-objection.entity';
import { EventsService } from '../events/events.service';
import { UserEventEntity } from '../events/entities/user-event.entity';

const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const PHONE = 'ffffffff-0000-0000-0000-000000000001';
const LAPTOP = 'ffffffff-0000-0000-0000-000000000002';
const STRANGER = 'ffffffff-0000-0000-0000-000000000003';
const ANON = 'ffffffff-0000-0000-0000-000000000004';
const ELSEWHERE = 'ffffffff-0000-0000-0000-000000000005';
/** The fixture project's owner (`resetFixtures`). */
const OWNER = '22222222-2222-2222-2222-222222222222';

describe('Consent history and do-not-track (integration)', () => {
  let ds: DataSource;
  let tracking: TrackingConsentService;
  let consentEvents: ConsentEventsService;
  let suppressions: SuppressionsService;
  let identity: IdentityService;
  let events: EventsService;
  let objections: PersonObjectionsService;

  const history = async (deviceIdentityId?: string) =>
    ds.query(
      `SELECT device_identity_id AS "id", channel, granted, source
       FROM consent_events
       ${deviceIdentityId ? 'WHERE device_identity_id = $1' : ''}
       ORDER BY occurred_at, channel, device_identity_id`,
      deviceIdentityId ? [deviceIdentityId] : [],
    );

  beforeAll(async () => {
    ds = await openIntDb();
    tracking = new TrackingConsentService(ds.getRepository(DeviceIdentityEntity));
    consentEvents = new ConsentEventsService(ds.getRepository(ConsentEventEntity));
    suppressions = new SuppressionsService(ds.getRepository(ChannelSuppressionEntity), consentEvents, { record: async () => undefined } as never);
    identity = new IdentityService(
      ds.getRepository(DeviceIdentityEntity),
      ds.getRepository(IdentityAliasEntity),
      // Never reached by these fixtures (no erased person's address arrives);
      // the real one is wired in privacy/person-erasure.int-spec.ts.
      { restore: async () => 0 } as never,
      consentEvents,
      tracking,
      { record: async () => undefined } as never,
    );
    events = new EventsService(ds.getRepository(UserEventEntity), identity, tracking);
    objections = new PersonObjectionsService(
      ds.getRepository(TrackingObjectionEntity),
      ds.getRepository(DeviceIdentityEntity),
      consentEvents,
      { record: async () => undefined } as never,
    );
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES ($1, 'consent-other@test.local', 'x', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_PROJECT],
    );
    await ds.query(
      `INSERT INTO projects (id, name, owner_id) VALUES ($1, 'other', $1) ON CONFLICT (id) DO NOTHING`,
      [OTHER_PROJECT],
    );
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM device_identities WHERE project_id = $1`, [OTHER_PROJECT]);
    await ds.query(`DELETE FROM projects WHERE id = $1`, [OTHER_PROJECT]);
    await ds.query(`DELETE FROM users WHERE id = $1`, [OTHER_PROJECT]);
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query('TRUNCATE channel_suppressions, tracking_objections RESTART IDENTITY CASCADE');
    await ds.query(`DELETE FROM device_identities WHERE project_id = $1`, [OTHER_PROJECT]);
    // One person on two devices, by both distinct and external id.
    await seedPerson(ds, { id: PHONE, externalUserId: 'asha' });
    await seedPerson(ds, { id: LAPTOP, externalUserId: 'asha' });
    await seedPerson(ds, { id: STRANGER, externalUserId: 'ravi' });
    await seedPerson(ds, { id: ANON });
    await ds.query(`UPDATE device_identities SET distinct_id = 'asha-d' WHERE id = ANY($1::uuid[])`, [[PHONE, LAPTOP]]);
    await ds.query(
      `INSERT INTO device_identities (id, project_id, external_user_id, distinct_id, device_fingerprint, platform, do_not_track)
       VALUES ($1, $2, 'asha', 'asha-d', 'fp-elsewhere', 'ios', true)`,
      [ELSEWHERE, OTHER_PROJECT],
    );
    await ds.query(`UPDATE device_identities SET email = 'asha@example.com', phone_e164 = '+919800000001' WHERE id = ANY($1::uuid[])`, [[PHONE, LAPTOP]]);
  });

  const setDnt = (id: string) =>
    ds.query(`UPDATE device_identities SET do_not_track = true WHERE id = $1`, [id]);

  const objection = async (projectId: string, externalUserId: string) =>
    ds.query(
      `INSERT INTO tracking_objections (project_id, external_user_id) VALUES ($1, $2)`,
      [projectId, externalUserId],
    );

  describe('TrackingConsentService.isDoNotTrack', () => {
    it('is false for everyone until someone turns it on, whatever another project says', async () => {
      // ELSEWHERE shares every id with Asha, is do-not-track and has a
      // person-wide objection, but lives in another project.
      await objection(OTHER_PROJECT, 'asha');
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, externalUserId: 'asha' })).toBe(false);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, distinctId: 'asha-d' })).toBe(false);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${PHONE}` })).toBe(false);
    });

    it('applies an SDK-set flag to its own device, by id or fingerprint', async () => {
      await setDnt(LAPTOP);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: LAPTOP })).toBe(true);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${LAPTOP}` })).toBe(true);
    });

    it('never spreads an SDK-set flag through shared distinct or external ids', async () => {
      // The poisoning case: a device that claims Asha's ids and turns
      // do-not-track on must not switch off tracking for Asha's devices.
      const attacker = await identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: 'fp-attacker',
        platform: 'web',
        externalUserId: 'asha',
        distinctId: 'asha-d',
        doNotTrack: true,
      });
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: attacker.id })).toBe(true);
      for (const subject of [
        { deviceIdentityId: PHONE },
        { deviceFingerprint: `fp-${LAPTOP}` },
        { distinctId: 'asha-d' },
        { externalUserId: 'asha' },
      ]) {
        expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, ...subject })).toBe(false);
      }
      expect(await tracking.withoutDoNotTrack(INT_PROJECT_ID, [PHONE, LAPTOP, attacker.id])).toEqual([PHONE, LAPTOP]);
    });

    it('covers the whole person, by any key a request carries, once the dashboard objects for them', async () => {
      await objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER, sourceIdentityId: PHONE }, null);
      for (const subject of [
        { deviceIdentityId: LAPTOP },
        { deviceFingerprint: `fp-${LAPTOP}` },
        { distinctId: 'asha' },
        { externalUserId: 'asha' },
      ]) {
        expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, ...subject })).toBe(true);
      }
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, externalUserId: 'ravi' })).toBe(false);
      expect(await tracking.withoutDoNotTrack(INT_PROJECT_ID, [STRANGER, PHONE, ANON, LAPTOP])).toEqual([
        STRANGER,
        ANON,
      ]);
    });

    it('records who made a person objection, from where, and history for every device it covers', async () => {
      const view = await objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER, sourceIdentityId: PHONE }, null);
      expect(view).toEqual(
        expect.objectContaining({ externalUserId: 'asha', deviceCount: 2, objecting: true, createdBy: OWNER, sourceIdentityId: PHONE }),
      );
      // Repeating it changes nothing and writes no more history.
      await objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER }, null);
      expect((await history()).map((r: { id: string; granted: boolean }) => [r.id, r.granted]).sort()).toEqual(
        [[LAPTOP, false], [PHONE, false]].sort(),
      );

      const lifted = await objections.lift(INT_PROJECT_ID, 'asha', null);
      expect(lifted.objecting).toBe(false);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: LAPTOP })).toBe(false);
      expect((await history(PHONE)).map((r: { granted: boolean; source: string }) => [r.granted, r.source])).toEqual([
        [false, 'dashboard'],
        [true, 'dashboard'],
      ]);
    });

    it('previews the exact id and how many devices claim it, changing nothing', async () => {
      expect(await objections.preview(INT_PROJECT_ID, 'asha')).toEqual(
        expect.objectContaining({ externalUserId: 'asha', deviceCount: 2, objecting: false }),
      );
      expect(await history()).toEqual([]);
    });

    it('never creates a person objection from a row-level consent change', async () => {
      await identity.updateConsent(INT_PROJECT_ID, PHONE, { doNotTrack: true }, null);
      expect(await ds.query(`SELECT count(*)::int AS count FROM tracking_objections`)).toEqual([{ count: 0 }]);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: PHONE })).toBe(true);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: LAPTOP })).toBe(false);
    });

    it('cannot be used to put an objection on a stranger (QA repro c)', async () => {
      // The owner marks the attacker's anonymous device do-not-track; the
      // attacker then identifies it as the victim. Nothing reaches the victim.
      const attacker = await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: 'fp-attacker', platform: 'web' });
      await identity.updateConsent(INT_PROJECT_ID, attacker.id, { doNotTrack: true }, null);
      await identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: 'fp-attacker',
        platform: 'web',
        externalUserId: 'asha',
      });
      expect(await ds.query(`SELECT count(*)::int AS count FROM tracking_objections`)).toEqual([{ count: 0 }]);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, externalUserId: 'asha' })).toBe(false);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: PHONE })).toBe(false);
      // The attacker's own device stays do-not-track: the owner decided that.
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: attacker.id })).toBe(true);
    });

    it('cannot be used to lift a stranger’s objection through a row that claims their id', async () => {
      await objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER }, null);
      const attacker = await identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: 'fp-attacker',
        platform: 'web',
        externalUserId: 'asha',
      });
      await identity.updateConsent(INT_PROJECT_ID, attacker.id, { doNotTrack: false }, null);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: PHONE })).toBe(true);
    });

    it('keeps a person objection when an SDK on one of the devices says otherwise', async () => {
      await objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER }, null);
      await identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: `fp-${PHONE}`,
        platform: 'ios',
        doNotTrack: false,
      });
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: PHONE })).toBe(true);
    });

    it('does not let the SDK clear a do-not-track the dashboard set on a device', async () => {
      await identity.updateConsent(INT_PROJECT_ID, ANON, { doNotTrack: true }, null);
      await identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: `fp-${ANON}`,
        platform: 'ios',
        doNotTrack: false,
      });
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: ANON })).toBe(true);
      // The refused change is not recorded as if it happened.
      expect(await history(ANON)).toEqual([{ id: ANON, channel: 'tracking', granted: false, source: 'dashboard' }]);
      // The dashboard can lift it, and then the SDK may set it again.
      await identity.updateConsent(INT_PROJECT_ID, ANON, { doNotTrack: false }, null);
      await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${ANON}`, platform: 'ios', doNotTrack: true });
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceIdentityId: ANON })).toBe(true);
    });

    it('drops only an SDK doNotTrack:false under an objection, and always keeps a true', async () => {
      await objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER }, null);
      await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${LAPTOP}`, platform: 'ios', doNotTrack: true });
      await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${LAPTOP}`, platform: 'ios', doNotTrack: false });
      const [laptop] = await ds.query(`SELECT do_not_track FROM device_identities WHERE id = $1`, [LAPTOP]);
      expect(laptop.do_not_track).toBe(true);
      expect((await history(LAPTOP)).filter((r: { source: string }) => r.source === 'sdk')).toEqual([
        { id: LAPTOP, channel: 'tracking', granted: false, source: 'sdk' },
      ]);
    });

    it('judges the objection on the id the request now claims (a user switch on a shared device)', async () => {
      // The laptop is Asha's (objected) and its own flag is on. Ravi signs in
      // on it, saying he does not object: judged on "ravi", not on "asha".
      await objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER }, null);
      await setDnt(LAPTOP);
      await identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: `fp-${LAPTOP}`,
        platform: 'ios',
        externalUserId: 'ravi',
        doNotTrack: false,
      });
      const [laptop] = await ds.query(`SELECT do_not_track FROM device_identities WHERE id = $1`, [LAPTOP]);
      expect(laptop.do_not_track).toBe(false);
    });

    it('names a device row by its own fingerprint, never by a distinct id', async () => {
      await setDnt(ANON);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${ANON}` })).toBe(true);
      // A distinct id equal to that fingerprint names nothing: see the next test.
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, distinctId: `fp-${ANON}` })).toBe(false);
    });

    it('stores the victim’s events when an attacker registers a device fingerprinted as their distinct id', async () => {
      // With only the SDK key: a device whose *fingerprint* is Asha's distinct
      // id, turning do-not-track on. Matching distinct ids to fingerprints
      // would have dropped every event Asha sends, from every device.
      await identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: 'asha-d',
        platform: 'web',
        doNotTrack: true,
      });

      const stored = await events.track({
        projectId: INT_PROJECT_ID,
        eventName: 'purchase',
        distinctId: 'asha-d',
        deviceFingerprint: `fp-${PHONE}`,
      });
      expect(stored).not.toBeNull();
      const [{ count }] = await ds.query(
        `SELECT count(*)::int AS count FROM user_events WHERE distinct_id = 'asha-d' AND event_name = 'purchase'`,
      );
      expect(count).toBe(1);

      // And Asha's next new device starts tracked.
      const laptop = await identity.identify(
        { projectId: INT_PROJECT_ID, deviceFingerprint: 'fp-asha-new', platform: 'web', distinctId: 'asha-d' },
        '8.8.8.8',
      );
      expect(laptop.totalSessions).toBe(1);
    });

    it('treats a request naming nobody known as tracked', async () => {
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID })).toBe(false);
      expect(await tracking.isDoNotTrack({ projectId: INT_PROJECT_ID, distinctId: 'unknown' })).toBe(false);
    });
  });

  describe('everything runs inside identify\'s row lock, opening no second transaction', () => {
    // identify, revenue and the consent PATCH hold their row FOR UPDATE in
    // locked()'s transaction. A write through another connection (a nested
    // transaction, or a repository outside the manager) waits on that lock
    // for ever, so each call must finish well inside the timeout.
    const within = <T>(label: string, work: Promise<T>, ms = 5000): Promise<T> =>
      Promise.race([
        work,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish: a nested transaction?`)), ms)),
      ]);

    it('completes an identify with a consent change, a do-not-track identify, a dashboard PATCH, revenue and a person objection', async () => {
      const device = { projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${PHONE}`, platform: 'ios' };
      await within('identify with a consent change', identity.identify({ ...device, pushOptIn: false }, '8.8.8.8'));
      await within('do-not-track identify', identity.identify({ ...device, doNotTrack: true }, '8.8.8.8'));
      await within('identify while do-not-track', identity.identify({ ...device, firstName: 'Asha' }, '8.8.8.8'));
      await within('revenue', identity.trackRevenue({ projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${PHONE}`, amount: 5 }));
      await within('dashboard PATCH', identity.updateConsent(INT_PROJECT_ID, LAPTOP, { doNotTrack: true, smsOptIn: false }, null));
      await within('person objection', objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER }, null));
      await within('identify under an objection', identity.identify({ ...device, doNotTrack: false }));
      await within('lift', objections.lift(INT_PROJECT_ID, 'asha', null));
      expect((await history(PHONE)).length).toBeGreaterThan(0);
    });
  });

  describe('identify for a do-not-track person', () => {
    const row = async (id: string) =>
      (
        await ds.query(
          `SELECT ip_address, total_sessions, latest_utm_source, last_seen_at, push_opt_in
           FROM device_identities WHERE id = $1`,
          [id],
        )
      )[0];

    it('stores no address, session or attribution when they log in on a new device', async () => {
      // The dashboard objected for Asha; she then signs in on a device the
      // SDK first saw anonymously.
      await objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER }, null);
      const device = { projectId: INT_PROJECT_ID, deviceFingerprint: 'fp-new-laptop', platform: 'web' };
      const anon = await identity.identify(device, '8.8.8.8');
      expect(anon.totalSessions).toBe(1);

      await identity.identify({ ...device, externalUserId: 'asha', utmSource: 'ads' }, '1.1.1.1');

      const after = await row(anon.id);
      expect(after.ip_address).toBe('8.8.8.8');
      expect(after.total_sessions).toBe(1);
      expect(after.latest_utm_source).toBeNull();
    });

    it('still tracks a stranger who merely claims a do-not-track device’s external id', async () => {
      await setDnt(LAPTOP); // SDK-set: Asha's laptop only.
      const device = { projectId: INT_PROJECT_ID, deviceFingerprint: 'fp-other', platform: 'web' };
      const created = await identity.identify({ ...device, externalUserId: 'asha' }, '8.8.8.8');
      expect(created.totalSessions).toBe(1);
      expect(created.ipAddress).toBe('8.8.8.8');
    });

    it('leaves last_seen_at where it was', async () => {
      await setDnt(PHONE);
      const before = (await row(PHONE)).last_seen_at as Date;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await identity.identify(
        { projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${PHONE}`, platform: 'ios', firstName: 'Asha' },
        '8.8.8.8',
      );
      expect(((await row(PHONE)).last_seen_at as Date).getTime()).toBe(before.getTime());
    });

    it('leaves last_seen_at alone on the devices a merge relabels', async () => {
      // merge rewrites distinct_id on every row holding it, for any value an
      // SDK key names; it must not stamp those devices as active.
      const before = (await row(LAPTOP)).last_seen_at as Date;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await identity.mergeIdentity(INT_PROJECT_ID, 'asha-d', 'asha-merged');
      const [{ distinct_id }] = await ds.query(`SELECT distinct_id FROM device_identities WHERE id = $1`, [LAPTOP]);
      expect(distinct_id).toBe('asha-merged');
      expect(((await row(LAPTOP)).last_seen_at as Date).getTime()).toBe(before.getTime());
    });

    it('moves last_seen_at for someone who is not do-not-track', async () => {
      const before = (await row(STRANGER)).last_seen_at as Date;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await identity.identify({ projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${STRANGER}`, platform: 'ios' });
      expect(((await row(STRANGER)).last_seen_at as Date).getTime()).toBeGreaterThan(before.getTime());
    });

    it('treats a null consent field as no change, writing no history', async () => {
      const dto = { projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${PHONE}`, platform: 'ios' };
      await identity.identify({ ...dto, pushOptIn: false });
      await identity.identify({ ...dto, pushOptIn: null as unknown as boolean });
      await identity.updateConsent(INT_PROJECT_ID, PHONE, { pushOptIn: null as unknown as boolean }, null);
      expect((await row(PHONE)).push_opt_in).toBe(false);
      expect(await history(PHONE)).toEqual([{ id: PHONE, channel: 'push', granted: false, source: 'sdk' }]);
    });
  });

  describe('identify and the dashboard write history with the flag', () => {
    it('records a change from the SDK, and nothing when it is repeated', async () => {
      const dto = { projectId: INT_PROJECT_ID, deviceFingerprint: `fp-${PHONE}`, platform: 'ios' };
      await identity.identify({ ...dto, pushOptIn: false });
      await identity.identify({ ...dto, pushOptIn: false });
      await identity.identify({ ...dto, doNotTrack: true });

      expect(await history(PHONE)).toEqual([
        { id: PHONE, channel: 'push', granted: false, source: 'sdk' },
        { id: PHONE, channel: 'tracking', granted: false, source: 'sdk' },
      ]);
      const [row] = await ds.query(`SELECT push_opt_in, do_not_track, total_sessions FROM device_identities WHERE id = $1`, [PHONE]);
      // Two sessions counted; the call that turned do-not-track on was not.
      expect(row).toEqual({ push_opt_in: false, do_not_track: true, total_sessions: 2 });
    });

    it('records the consent a brand new device arrives with, against its new row', async () => {
      const created = await identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: 'fp-new',
        platform: 'android',
        emailOptIn: true,
        doNotTrack: true,
      });
      expect(await history(created.id)).toEqual([
        { id: created.id, channel: 'email', granted: true, source: 'sdk' },
        { id: created.id, channel: 'tracking', granted: false, source: 'sdk' },
      ]);
      expect(created.totalSessions).toBe(0);
    });

    it('records the dashboard taking over a device flag the SDK set, without a person objection', async () => {
      await setDnt(PHONE); // set by the SDK first
      await identity.updateConsent(INT_PROJECT_ID, PHONE, { doNotTrack: true }, null);
      // The value did not change, so no history; the SDK can no longer clear it.
      expect(await history(PHONE)).toEqual([]);
      const [row] = await ds.query(`SELECT do_not_track_source FROM device_identities WHERE id = $1`, [PHONE]);
      expect(row.do_not_track_source).toBe('dashboard');
      expect(await ds.query(`SELECT count(*)::int AS count FROM tracking_objections`)).toEqual([{ count: 0 }]);
    });

    it('leaves last_seen_at alone when the dashboard edits consent', async () => {
      const [{ last_seen_at: before }] = await ds.query(`SELECT last_seen_at FROM device_identities WHERE id = $1`, [STRANGER]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await identity.updateConsent(INT_PROJECT_ID, STRANGER, { smsOptIn: true, doNotTrack: true }, null);
      const [{ last_seen_at: after }] = await ds.query(`SELECT last_seen_at FROM device_identities WHERE id = $1`, [STRANGER]);
      expect((after as Date).getTime()).toBe((before as Date).getTime());
    });

    it('stamps last_event_at only on the device an event names, and never on a do-not-track one', async () => {
      // PHONE and LAPTOP share distinct id 'asha-d'; the event comes from PHONE.
      await events.track({ projectId: INT_PROJECT_ID, eventName: 'x', distinctId: 'asha-d', deviceFingerprint: `fp-${PHONE}` });
      await new Promise((resolve) => setTimeout(resolve, 50)); // stamped fire-and-forget
      const rows = await ds.query(
        `SELECT id, last_event_at FROM device_identities WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[PHONE, LAPTOP]],
      );
      expect(rows.find((r: { id: string }) => r.id === PHONE).last_event_at).not.toBeNull();
      expect(rows.find((r: { id: string }) => r.id === LAPTOP).last_event_at).toBeNull();

      await setDnt(ANON);
      await identity.updateLastEventAt(INT_PROJECT_ID, ANON);
      const [anon] = await ds.query(`SELECT last_event_at FROM device_identities WHERE id = $1`, [ANON]);
      expect(anon.last_event_at).toBeNull();
    });

    it('records a dashboard change as the dashboard', async () => {
      await identity.updateConsent(INT_PROJECT_ID, STRANGER, { smsOptIn: false }, null);
      expect(await history(STRANGER)).toEqual([
        { id: STRANGER, channel: 'sms', granted: false, source: 'dashboard' },
      ]);
    });

    it('goes with the identity when it is deleted', async () => {
      await identity.updateConsent(INT_PROJECT_ID, STRANGER, { smsOptIn: false }, null);
      await ds.query(`DELETE FROM device_identities WHERE id = $1`, [STRANGER]);
      expect(await history()).toEqual([]);
    });
  });

  describe('suppressions write history for every identity holding the address', () => {
    it('records an unsubscribe link against both of Asha’s devices', async () => {
      await suppressions.suppress(INT_PROJECT_ID, 'email', [{ address: ' Asha@Example.com ', reason: 'unsubscribed' }], 'link');
      expect(await history()).toEqual([
        { id: PHONE, channel: 'email', granted: false, source: 'unsubscribe_link' },
        { id: LAPTOP, channel: 'email', granted: false, source: 'unsubscribe_link' },
      ].sort((a, b) => a.id.localeCompare(b.id)));
    });

    it('records a STOP reply, and a START that lifts it', async () => {
      await suppressions.suppress(INT_PROJECT_ID, 'sms', [{ address: '+919800000001', reason: 'unsubscribed' }], 'twilio');
      await suppressions.remove(INT_PROJECT_ID, 'sms', '+919800000001', { onlyReason: 'unsubscribed' });
      const rows = await history(PHONE);
      expect(rows).toEqual([
        { id: PHONE, channel: 'sms', granted: false, source: 'stop_reply' },
        { id: PHONE, channel: 'sms', granted: true, source: 'start_reply' },
      ]);
    });

    it('records a STOP from an unsigned webhook as unverified', async () => {
      await suppressions.suppress(
        INT_PROJECT_ID, 'whatsapp', [{ address: '+919800000001', reason: 'unsubscribed' }], 'gupshup', { verified: false },
      );
      expect((await history(PHONE)).map((r: { source: string }) => r.source)).toEqual(['stop_reply_unsigned']);
    });

    it('records nothing for a bounce entered by hand', async () => {
      await suppressions.suppress(INT_PROJECT_ID, 'email', [{ address: 'asha@example.com', reason: 'bounced' }], 'dashboard');
      expect(await history()).toEqual([]);
    });

    it('records a WhatsApp STOP under WhatsApp, never under SMS', async () => {
      await suppressions.suppress(INT_PROJECT_ID, 'whatsapp', [{ address: '+919800000001', reason: 'unsubscribed' }], 'meta');
      expect((await history(PHONE)).map((row: { channel: string }) => row.channel)).toEqual(['whatsapp']);
    });

    it('records a spam complaint, and a suppression added in the dashboard', async () => {
      await suppressions.suppress(INT_PROJECT_ID, 'email', [{ address: 'asha@example.com', reason: 'complained' }], 'ses');
      await suppressions.suppress(INT_PROJECT_ID, 'sms', [{ address: '+919800000001', reason: 'manual' }], 'dashboard');
      expect((await history(PHONE)).map((row: { source: string }) => row.source)).toEqual(['complaint', 'dashboard']);
    });

    it('records nothing for a bounce, or for lifting one: neither is anyone saying anything', async () => {
      await suppressions.suppress(INT_PROJECT_ID, 'email', [{ address: 'asha@example.com', reason: 'bounced' }], 'ses');
      expect(await suppressions.remove(INT_PROJECT_ID, 'email', 'asha@example.com')).toBe(true);
      expect(await history()).toEqual([]);
    });

    it('records nothing for an address nobody in the project holds', async () => {
      await suppressions.suppress(INT_PROJECT_ID, 'email', [{ address: 'nobody@example.com', reason: 'unsubscribed' }], 'link');
      expect(await history()).toEqual([]);
      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM channel_suppressions`);
      expect(count).toBe(1);
    });

    it('records lifting an unsubscribe from the dashboard as consent given back', async () => {
      await suppressions.suppress(INT_PROJECT_ID, 'email', [{ address: 'asha@example.com', reason: 'unsubscribed' }], 'link');
      expect(await suppressions.remove(INT_PROJECT_ID, 'email', 'asha@example.com')).toBe(true);
      expect((await history(PHONE)).map((row: { granted: boolean; source: string }) => [row.granted, row.source])).toEqual([
        [false, 'unsubscribe_link'],
        [true, 'dashboard'],
      ]);
    });

    it('reports a lift that found nothing as false, recording nothing', async () => {
      expect(await suppressions.remove(INT_PROJECT_ID, 'email', 'asha@example.com')).toBe(false);
      expect(await history()).toEqual([]);
    });
  });
});

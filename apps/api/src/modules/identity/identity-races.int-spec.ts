import { DataSource } from 'typeorm';
import { DeviceIdentityEntity } from './entities/device-identity.entity';
import { IdentityAliasEntity } from './entities/identity-alias.entity';
import { IdentityService } from './identity.service';
import { EventsService } from '../events/events.service';
import { UserEventEntity } from '../events/entities/user-event.entity';
import { ConsentEventsService } from '../consent/consent-events.service';
import { ConsentEventEntity } from '../consent/entities/consent-event.entity';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { INT_PROJECT_ID, closeIntDb, openIntDb, resetFixtures } from '../../test-support/int-db';

/**
 * Two ingest races that used to answer 500 (which the SDK queues retry): the first
 * identify of one fingerprint arriving twice at once, and an event for a device that
 * is erased while the event is being recorded. Both run against real Postgres, since
 * the unique key and the foreign key are what refuse the write.
 */
describe('identity and event ingest races (real database)', () => {
  let ds: DataSource;
  let identity: IdentityService;

  beforeAll(async () => {
    ds = await openIntDb();
    identity = new IdentityService(
      ds.getRepository(DeviceIdentityEntity),
      ds.getRepository(IdentityAliasEntity),
      // Runs between the lookup and the INSERT of a new row (when an address is
      // reported), so the delay holds the window open for the other call.
      { restore: () => new Promise((resolve) => setTimeout(resolve, 200)) } as never,
      new ConsentEventsService(ds.getRepository(ConsentEventEntity)),
      new TrackingConsentService(ds.getRepository(DeviceIdentityEntity)),
      { record: async () => undefined } as never,
    );
  });
  afterAll(() => closeIntDb(ds));
  beforeEach(() => resetFixtures(ds));

  it('concurrent first identifies of one fingerprint both succeed and leave one row', async () => {
    const call = () =>
      identity.identify({
        projectId: INT_PROJECT_ID,
        deviceFingerprint: 'fp-race',
        platform: 'ios',
        email: 'race@example.com',
      } as never);

    const results = await Promise.allSettled(Array.from({ length: 4 }, call));

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const rows = await ds.query(
      `SELECT total_sessions FROM device_identities WHERE project_id = $1 AND device_fingerprint = 'fp-race'`,
      [INT_PROJECT_ID],
    );
    expect(rows).toHaveLength(1);
    // Every call counted as a session: one created the row, the rest updated it.
    expect(rows[0].total_sessions).toBe(4);
  });

  it('an event for a device erased between lookup and insert is dropped, not a 500', async () => {
    const [{ id }] = await ds.query(
      `INSERT INTO device_identities (project_id, device_fingerprint, platform)
       VALUES ($1, 'fp-erased', 'ios') RETURNING id`,
      [INT_PROJECT_ID],
    );
    const identities = {
      // Found here, then erased before the event is written: the erasure's commit
      // lands in the gap between the two statements.
      findByFingerprintAndProject: async () => {
        const found = { id, distinctId: null, deviceFingerprint: 'fp-erased' };
        await ds.query('DELETE FROM device_identities WHERE id = $1', [id]);
        return found;
      },
      updateLastSeen: async () => undefined,
      updateLastEventAt: async () => undefined,
    };
    const events = new EventsService(
      ds.getRepository(UserEventEntity),
      identities as never,
      { isDoNotTrack: async () => false, recordDrop: () => undefined } as never,
    );

    const result = await events.track({
      projectId: INT_PROJECT_ID,
      deviceFingerprint: 'fp-erased',
      eventName: 'purchase',
    } as never);

    expect(result).toBeNull();
    const stored = await ds.query('SELECT 1 FROM user_events WHERE project_id = $1', [INT_PROJECT_ID]);
    expect(stored).toHaveLength(0);
  });
});

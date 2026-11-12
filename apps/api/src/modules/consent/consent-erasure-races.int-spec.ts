import { NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { ChannelSuppressionEntity } from '../push-notifications/entities/channel-suppression.entity';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { ConsentEventsService } from './consent-events.service';
import { ConsentEventEntity } from './entities/consent-event.entity';
import { PersonObjectionsService } from './person-objections.service';
import { TrackingObjectionEntity } from './entities/tracking-objection.entity';

// Ids chosen so LOW < HIGH; seeded HIGH first, so a scan without ORDER BY
// meets HIGH before LOW.
const LOW = '0a000000-0000-4000-8000-000000000001';
const HIGH = '0a000000-0000-4000-8000-000000000002';
/** The fixture project's owner (`resetFixtures`). */
const OWNER = '22222222-2222-2222-2222-222222222222';

/**
 * Consent writes racing a person erasure, interleaved deterministically on two
 * connections. The erasure is played by hand on its own connection the way
 * `resolvePersonScope` does it: device rows FOR UPDATE in id order, then
 * deleted. The service under test is started while the erasure holds its
 * first lock, and the test waits until Postgres reports it blocked before
 * letting the erasure go on.
 */
describe('Consent writes racing an erasure (integration)', () => {
  let ds: DataSource;
  let consentEvents: ConsentEventsService;
  let suppressions: SuppressionsService;
  let objections: PersonObjectionsService;
  let erasure: QueryRunner;

  /** Resolves once another backend on this database is waiting on a lock. */
  const untilBlocked = async () => {
    for (let i = 0; i < 200; i++) {
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
      );
      if (n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the call under test never blocked on the erasure');
  };

  /** Settles a promise into its outcome, so a rejection cannot go unobserved. */
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  beforeAll(async () => {
    ds = await openIntDb();
    consentEvents = new ConsentEventsService(ds.getRepository(ConsentEventEntity));
    suppressions = new SuppressionsService(ds.getRepository(ChannelSuppressionEntity), consentEvents, { record: async () => undefined } as never);
    objections = new PersonObjectionsService(
      ds.getRepository(TrackingObjectionEntity),
      ds.getRepository(DeviceIdentityEntity),
      consentEvents,
      { record: async () => undefined } as never,
    );
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query('DELETE FROM tracking_objections WHERE project_id = $1', [INT_PROJECT_ID]);
    await ds.query('DELETE FROM channel_suppressions WHERE project_id = $1', [INT_PROJECT_ID]);
    await seedPerson(ds, { id: HIGH, externalUserId: 'asha' });
    await seedPerson(ds, { id: LOW, externalUserId: 'asha' });
    erasure = ds.createQueryRunner();
    await erasure.connect();
    await erasure.startTransaction();
  });

  afterEach(async () => {
    if (erasure.isTransactionActive) await erasure.rollbackTransaction();
    await erasure.release();
  });

  describe('POST tracking-objections against an erasure of the same person', () => {
    it('answers 404 when the source row is erased under it, not a foreign key 500', async () => {
      await erasure.query('SELECT id FROM device_identities WHERE id = $1 FOR UPDATE', [LOW]);
      await erasure.query('DELETE FROM device_identities WHERE id = $1', [LOW]);

      const outcome = settle(
        objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER, sourceIdentityId: LOW }, null),
      );
      await untilBlocked();
      await erasure.commitTransaction();

      const result = await outcome;
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(NotFoundException);
      expect(await ds.query('SELECT 1 FROM tracking_objections WHERE project_id = $1', [INT_PROJECT_ID])).toEqual([]);
    });

    it('records the objection for the devices left when another of the person\'s devices is erased', async () => {
      await erasure.query('SELECT id FROM device_identities WHERE id = $1 FOR UPDATE', [LOW]);
      await erasure.query('DELETE FROM device_identities WHERE id = $1', [LOW]);

      const outcome = settle(
        objections.object(INT_PROJECT_ID, 'asha', { userId: OWNER, sourceIdentityId: HIGH }, null),
      );
      await untilBlocked();
      await erasure.commitTransaction();

      const result = await outcome;
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toMatchObject({ objecting: true, deviceCount: 1 });
      expect(
        await ds.query(`SELECT device_identity_id AS id FROM consent_events WHERE channel = 'tracking'`),
      ).toEqual([{ id: HIGH }]);
    });
  });

  describe('lock order against an erasure (device rows by id)', () => {
    const lockBoth = async () => {
      // The erasure's one statement, split at the point the race happens:
      // it holds LOW and is about to take HIGH.
      await erasure.query('SELECT id FROM device_identities WHERE id = $1 FOR UPDATE', [LOW]);
    };
    const finishErasure = async () => {
      await erasure.query('SELECT id FROM device_identities WHERE id = $1 FOR UPDATE', [HIGH]);
      await erasure.query('DELETE FROM device_identities WHERE id = ANY($1::uuid[])', [[LOW, HIGH]]);
      await erasure.commitTransaction();
    };

    it('suppress() with two people\'s addresses waits for the erasure instead of deadlocking', async () => {
      await ds.query(`UPDATE device_identities SET email = 'high@example.com' WHERE id = $1`, [HIGH]);
      await ds.query(`UPDATE device_identities SET email = 'low@example.com' WHERE id = $1`, [LOW]);
      await lockBoth();

      // HIGH's address first: one address at a time, history would lock HIGH
      // and then wait for LOW, which the erasure holds while it waits for HIGH.
      const outcome = settle(
        suppressions.suppress(
          INT_PROJECT_ID,
          'email',
          [
            { address: 'high@example.com', reason: 'unsubscribed' },
            { address: 'low@example.com', reason: 'unsubscribed' },
          ],
          'link',
        ),
      );
      await untilBlocked();
      const erased = await settle(finishErasure());

      expect(erased).toEqual({ ok: true, value: undefined });
      expect(await outcome).toEqual({ ok: true, value: undefined });
      // Both suppressions stand; the erased devices get no history.
      expect(
        await ds.query(`SELECT address FROM channel_suppressions WHERE project_id = $1 ORDER BY address`, [
          INT_PROJECT_ID,
        ]),
      ).toEqual([{ address: 'high@example.com' }, { address: 'low@example.com' }]);
      expect(await ds.query('SELECT 1 FROM consent_events')).toEqual([]);
    });

    it('recordForAddress takes its foreign key locks in id order', async () => {
      // One address on both rows, so one INSERT ... SELECT names both.
      // HIGH first, so without ORDER BY the scan meets it first; one UPDATE
      // for both would let Postgres rewrite them in its own order.
      for (const id of [HIGH, LOW]) {
        await ds.query(`UPDATE device_identities SET email = 'shared@example.com' WHERE id = $1`, [id]);
      }
      const [first] = await ds.query(
        `SELECT id FROM device_identities WHERE project_id = $1 AND email = 'shared@example.com'`,
        [INT_PROJECT_ID],
      );
      expect(first.id).toBe(HIGH); // the fixture really would meet HIGH first
      await lockBoth();

      const outcome = settle(
        ds.transaction((manager) =>
          consentEvents.recordForAddress(INT_PROJECT_ID, 'email', 'shared@example.com', false, 'unsubscribe_link', manager),
        ),
      );
      await untilBlocked();
      // The erasure takes HIGH and lets go without deleting, so the history
      // can land: the point is only that taking HIGH does not deadlock.
      const second = await settle(
        erasure.query('SELECT id FROM device_identities WHERE id = $1 FOR UPDATE', [HIGH]),
      );
      await erasure.commitTransaction();

      expect(second.ok).toBe(true);
      expect(await outcome).toEqual({ ok: true, value: 2 });
    });
  });
});

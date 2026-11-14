import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { ErasedSuppressionsService } from '../privacy/erased-suppressions.service';
import { PrivacyRequestLogEntity } from '../privacy/entities/privacy-request-log.entity';
import { PersonErasureService } from '../privacy/person-erasure.service';
import { PrivacyHashService } from '../privacy/privacy-hash.service';
import { PrivacyRequestsService } from '../privacy/privacy-requests.service';
import {
  ProjectOwner,
  countWindow,
  pruneActiveDevices,
  readDay,
  recordActiveDevices,
  writeMauSnapshot,
} from './usage-counting';
import { addDays, dayStart } from './usage-days';

/**
 * Monthly active devices: which records make a device active, that a month is
 * a UTC month, that a device counts once a month, and that erasure removes a
 * person's rows without changing counts already taken.
 */
describe('monthly active devices (integration)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  const range = (from: string, to: string) => [dayStart(from), dayStart(to)] as const;

  describe('recording and counting', () => {
    let qr: QueryRunner;
    let m: EntityManager;
    let owner: string;
    let P: string;
    let Q: string;
    let projects: ProjectOwner[];

    beforeEach(async () => {
      qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction('REPEATABLE READ');
      await qr.query(`SET LOCAL TIME ZONE 'Asia/Kolkata'`);
      m = qr.manager;
      owner = randomUUID();
      P = randomUUID();
      Q = randomUUID();
      await m.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'mad')`, [
        owner,
        `mad-${owner}@test.local`,
      ]);
      await m.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'p', $3), ($2, 'q', $3)`, [P, Q, owner]);
      projects = [
        { id: P, ownerId: owner },
        { id: Q, ownerId: owner },
      ];
    });

    afterEach(async () => {
      await qr.rollbackTransaction();
      await qr.release();
    });

    const device = async (project: string, firstSeenAt: string): Promise<{ id: string; fingerprint: string }> => {
      const fingerprint = `fp-${randomUUID()}`;
      const [row] = await m.query(
        `INSERT INTO device_identities (project_id, device_fingerprint, platform, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'ios', $3::timestamptz::timestamp, $3::timestamptz::timestamp) RETURNING id`,
        [project, fingerprint, firstSeenAt],
      );
      return { id: row.id, fingerprint };
    };

    const event = (project: string, deviceId: string, receivedAt: string) =>
      m.query(
        `INSERT INTO user_events (project_id, device_identity_id, event_name, timestamp, created_at)
         VALUES ($1, $2, 'opened', $3::timestamptz::timestamp, $3::timestamptz::timestamp)`,
        [project, deviceId, receivedAt],
      );

    const pushEvent = async (project: string, deviceId: string, type: string, at: string) => {
      const [campaign] = await m.query(
        `INSERT INTO push_notification_logs (project_id, title, status) VALUES ($1, 't', 'sent') RETURNING id`,
        [project],
      );
      await m.query(
        `INSERT INTO push_notification_events (project_id, campaign_id, device_identity_id, type, occurred_at, created_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz::timestamp, $5::timestamptz::timestamp)`,
        [project, campaign.id, deviceId, type, at],
      );
    };

    const madRows = async (project: string) =>
      m.query(
        `SELECT device_identity_id AS device, to_char(month, 'YYYY-MM-DD') AS month, to_char(first_day, 'YYYY-MM-DD') AS "firstDay"
           FROM monthly_active_devices WHERE project_id = $1 ORDER BY month, device_identity_id`,
        [project],
      );

    const mau = async (project: string, day: string) => {
      await writeMauSnapshot(m, projects, day);
      return (await readDay(m, [project], day)).get(project)?.mau_month_to_date;
    };

    /** Devices seen before November, so only November activity puts them in November. */
    const seedNovember = async () => {
      const d1 = await device(P, '2026-10-01T10:00:00Z');
      for (const day of ['2026-11-03', '2026-11-05', '2026-11-09']) await event(P, d1.id, `${day}T10:00:00Z`);
      // Only sent a message, never opened the app: still active.
      const d2 = await device(P, '2026-10-01T10:00:00Z');
      await pushEvent(P, d2.id, 'sent', '2026-11-10T10:00:00Z');
      // A bounce is not reach.
      const d3 = await device(P, '2026-10-01T10:00:00Z');
      await pushEvent(P, d3.id, 'bounced', '2026-11-10T10:00:00Z');
      // Only edited from the dashboard: moves last_seen_at, means nothing.
      const d4 = await device(P, '2026-10-01T10:00:00Z');
      await m.query(
        `UPDATE device_identities SET traits = '{"plan":"pro"}', last_seen_at = '2026-11-10T10:00:00Z'::timestamptz::timestamp WHERE id = $1`,
        [d4.id],
      );
      // An in-app event naming no device row, only its fingerprint.
      const d5 = await device(P, '2026-10-01T10:00:00Z');
      const [message] = await m.query(
        `INSERT INTO in_app_messages (project_id, name, title, message_type) VALUES ($1, 'm', 't', 'modal') RETURNING id`,
        [P],
      );
      await m.query(
        `INSERT INTO in_app_message_impressions (message_id, project_id, device_identity_id, device_fingerprint, event_type, created_at)
         VALUES ($1, $2, NULL, $3, 'impression', '2026-11-12T10:00:00Z'::timestamptz::timestamp)`,
        [message.id, P, d5.fingerprint],
      );
      return { d1, d2, d3, d4, d5 };
    };

    it('counts a device once a month, from what it did or what reached it', async () => {
      const { d1, d2, d5 } = await seedNovember();
      await recordActiveDevices(m, [P, Q], ...range('2026-11-01', '2026-12-01'));

      expect(await madRows(P)).toEqual(
        [
          { device: d1.id, month: '2026-11-01', firstDay: '2026-11-03' },
          { device: d2.id, month: '2026-11-01', firstDay: '2026-11-10' },
          { device: d5.id, month: '2026-11-01', firstDay: '2026-11-12' },
        ].sort((a, b) => (a.device < b.device ? -1 : 1)),
      );
      expect(await mau(P, '2026-11-02')).toBeUndefined();
      expect(await mau(P, '2026-11-04')).toBe(1);
      expect(await mau(P, '2026-11-30')).toBe(3);
    });

    it('counts a new device in the month it was first seen', async () => {
      const d = await device(P, '2026-11-20T10:00:00Z');
      await recordActiveDevices(m, [P], ...range('2026-11-01', '2026-12-01'));
      expect(await madRows(P)).toEqual([{ device: d.id, month: '2026-11-01', firstDay: '2026-11-20' }]);
    });

    it('splits months in UTC, whatever the session time zone', async () => {
      const d6 = await device(Q, '2026-09-01T10:00:00Z');
      // 05:00 on 1 November in India, still October in UTC.
      await event(Q, d6.id, '2026-10-31T23:30:00Z');
      await event(Q, d6.id, '2026-11-01T00:30:00Z');
      await recordActiveDevices(m, [Q], ...range('2026-10-31', '2026-11-02'));

      expect(await madRows(Q)).toEqual([
        { device: d6.id, month: '2026-10-01', firstDay: '2026-10-31' },
        { device: d6.id, month: '2026-11-01', firstDay: '2026-11-01' },
      ]);
      expect(await mau(Q, '2026-10-31')).toBe(1);
      expect(await mau(Q, '2026-11-01')).toBe(1);
    });

    it('recording a window again changes nothing, and an earlier day wins whatever the order', async () => {
      const { d1 } = await seedNovember();
      expect(await recordActiveDevices(m, [P], ...range('2026-11-09', '2026-11-10'))).toBe(1);
      expect(await recordActiveDevices(m, [P], ...range('2026-11-09', '2026-11-10'))).toBe(0);
      expect(await madRows(P)).toEqual([{ device: d1.id, month: '2026-11-01', firstDay: '2026-11-09' }]);

      expect(await recordActiveDevices(m, [P], ...range('2026-11-03', '2026-11-04'))).toBe(1);
      expect(await recordActiveDevices(m, [P], ...range('2026-11-05', '2026-11-06'))).toBe(0);
      expect(await madRows(P)).toEqual([{ device: d1.id, month: '2026-11-01', firstDay: '2026-11-03' }]);
    });

    it('never records a device row that no longer exists', async () => {
      // Push events have no foreign key to the device: a row naming a deleted
      // device must not bring its id back.
      await pushEvent(P, randomUUID(), 'delivered', '2026-11-10T10:00:00Z');
      expect(await recordActiveDevices(m, [P], ...range('2026-11-01', '2026-12-01'))).toBe(0);
      expect(await madRows(P)).toEqual([]);
    });

    it('records only the projects it is given', async () => {
      const d = await device(Q, '2026-11-20T10:00:00Z');
      await recordActiveDevices(m, [P], ...range('2026-11-01', '2026-12-01'));
      expect(await madRows(Q)).toEqual([]);
      await recordActiveDevices(m, [Q], ...range('2026-11-01', '2026-12-01'));
      expect(await madRows(Q)).toEqual([{ device: d.id, month: '2026-11-01', firstDay: '2026-11-20' }]);
    });

    it('prunes months older than thirteen', async () => {
      const keep = randomUUID();
      const drop = randomUUID();
      await m.query(
        `INSERT INTO monthly_active_devices (project_id, month, device_identity_id, first_day)
         VALUES ($1, '2025-09-01', $2, '2025-09-15'), ($1, '2025-10-01', $3, '2025-10-15')`,
        [P, drop, keep],
      );
      expect(await pruneActiveDevices(m, '2026-11-14')).toBeGreaterThanOrEqual(1);
      expect((await madRows(P)).map((r: { device: string }) => r.device)).toEqual([keep]);
    });
  });

  describe('erasure', () => {
    const TEST_KEY = 'cd'.repeat(32);
    let erasure: PersonErasureService;
    let requests: PrivacyRequestsService;
    let owner: string;
    let P: string;

    beforeAll(() => {
      const config = { get: (key: string) => (key === 'CREDENTIALS_ENCRYPTION_KEY' ? TEST_KEY : undefined) };
      const hashes = new PrivacyHashService(new CredentialsCryptoService(config as ConfigService));
      requests = new PrivacyRequestsService(ds.getRepository(PrivacyRequestLogEntity), hashes);
      erasure = new PersonErasureService(
        ds,
        new ErasedSuppressionsService(ds, hashes),
        requests,
        { record: async () => undefined } as never,
      );
    });

    beforeEach(async () => {
      owner = randomUUID();
      P = randomUUID();
      await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'mad')`, [
        owner,
        `mad-erase-${owner}@test.local`,
      ]);
      await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'p', $2)`, [P, owner]);
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await ds.query(`DELETE FROM usage_daily WHERE project_id = $1`, [P]);
      await ds.query(`DELETE FROM projects WHERE id = $1`, [P]);
      await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    });

    it('removes the person\'s active-device rows and leaves closed counts as they were', async () => {
      const day = '2026-11-10';
      const at = '2026-11-10T12:00:00Z';
      const devices: string[] = [];
      for (const tag of ['gone', 'stays']) {
        const [row] = await ds.query(
          `INSERT INTO device_identities (project_id, device_fingerprint, platform, external_user_id, first_seen_at)
           VALUES ($1, $2, 'ios', $3, $4::timestamptz::timestamp) RETURNING id`,
          [P, `fp-${tag}-${P}`, `user-${tag}`, at],
        );
        devices.push(row.id);
        await ds.query(
          `INSERT INTO user_events (project_id, device_identity_id, event_name, created_at)
           VALUES ($1, $2, 'opened', $3::timestamptz::timestamp)`,
          [P, row.id, at],
        );
      }
      const projects = [{ id: P, ownerId: owner }];
      await ds.transaction(async (m) => {
        await countWindow(m, projects, day, dayStart(day), dayStart(addDays(day, 1)));
        await recordActiveDevices(m, [P], dayStart(day), dayStart(addDays(day, 1)));
        await writeMauSnapshot(m, projects, day);
      });
      const before = await ds.query(
        `SELECT metric, value FROM usage_daily WHERE project_id = $1 ORDER BY metric`,
        [P],
      );
      expect(before).toEqual([
        { metric: 'events', value: '2' },
        { metric: 'mau_month_to_date', value: '2' },
        { metric: 'new_people', value: '2' },
      ]);

      const result = await erasure.erase(
        P,
        { type: 'externalUserId', value: 'user-gone' },
        { type: 'user', id: owner },
        { ipAddress: null, userAgent: null },
      );

      expect(result.counts.monthly_active_devices).toBe(1);
      const left = await ds.query(
        `SELECT device_identity_id FROM monthly_active_devices WHERE project_id = $1`,
        [P],
      );
      expect(left).toEqual([{ device_identity_id: devices[1] }]);
      expect(
        await ds.query(`SELECT metric, value FROM usage_daily WHERE project_id = $1 ORDER BY metric`, [P]),
      ).toEqual(before);
    });

    describe('racing the roll-up', () => {
      const day = '2026-11-10';
      const from = dayStart(day);
      const to = dayStart(addDays(day, 1));

      /** Two devices active on `day`, each with an external id; returns [gone, stays]. */
      const seedTwo = async (): Promise<string[]> => {
        const ids: string[] = [];
        for (const tag of ['gone', 'stays']) {
          const [row] = await ds.query(
            `INSERT INTO device_identities (project_id, device_fingerprint, platform, external_user_id, first_seen_at)
             VALUES ($1, $2, 'ios', $3, '2026-10-01T10:00:00Z'::timestamptz::timestamp) RETURNING id`,
            [P, `fp-race-${tag}-${P}`, `user-${tag}`],
          );
          ids.push(row.id);
          await ds.query(
            `INSERT INTO user_events (project_id, device_identity_id, event_name, created_at)
             VALUES ($1, $2, 'opened', '2026-11-10T12:00:00Z'::timestamptz::timestamp)`,
            [P, row.id],
          );
        }
        return ids;
      };

      const eraseGone = () =>
        erasure.erase(
          P,
          { type: 'externalUserId', value: 'user-gone' },
          { type: 'user', id: owner },
          { ipAddress: null, userAgent: null },
        );

      const activeDevices = async () =>
        (
          await ds.query(`SELECT device_identity_id AS id FROM monthly_active_devices WHERE project_id = $1`, [P])
        ).map((r: { id: string }) => r.id);

      /**
       * Resolves once `work` has finished or some session is waiting for an
       * advisory lock, whichever comes first, so the other side can go on.
       */
      const finishedOrWaiting = async (work: Promise<unknown>): Promise<void> => {
        let done = false;
        work.then(
          () => (done = true),
          () => (done = true),
        );
        for (let i = 0; i < 250 && !done; i++) {
          const [{ n }] = await ds.query(
            `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
          );
          if (n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };

      it('an erasure waiting on an uncommitted roll-up still removes what it wrote', async () => {
        const [, stays] = await seedTwo();
        const rollupTx = ds.createQueryRunner();
        await rollupTx.connect();
        try {
          await rollupTx.startTransaction();
          await recordActiveDevices(rollupTx.manager, [P], from, to);

          const erasing = eraseGone();
          await finishedOrWaiting(erasing);
          await rollupTx.commitTransaction();
          await erasing;
        } finally {
          await rollupTx.release();
        }

        expect(await activeDevices()).toEqual([stays]);
      });

      it('a roll-up that read before the erasure committed does not write the erased device back', async () => {
        const [, stays] = await seedTwo();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let reached!: () => void;
        const atGate = new Promise<void>((resolve) => (reached = resolve));
        const record = requests.record.bind(requests);
        // Holds the erasure open after its deletes, before its commit.
        jest.spyOn(requests, 'record').mockImplementationOnce(async (...args) => {
          reached();
          await gate;
          return record(...args);
        });

        const erasing = eraseGone();
        await atGate;
        const rollupTx = ds.createQueryRunner();
        await rollupTx.connect();
        try {
          await rollupTx.startTransaction();
          const recording = recordActiveDevices(rollupTx.manager, [P], from, to);
          await finishedOrWaiting(recording);
          release();
          await erasing;
          await recording;
          await rollupTx.commitTransaction();
        } finally {
          release();
          if (rollupTx.isTransactionActive) await rollupTx.rollbackTransaction();
          await rollupTx.release();
        }

        expect(await activeDevices()).toEqual([stays]);
      });
    });
  });
});

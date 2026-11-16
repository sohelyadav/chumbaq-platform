import { DataSource } from 'typeorm';
import { PushTokensService } from './push-tokens.service';
import { PushTokenEntity } from './entities/push-token.entity';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';
import { allPushAudienceIds, pushAudienceByTimezone } from '../../test-support/audience-pages';
import { deviceList, storedRecipients } from '../push-notifications/recipients';

const PROJECT_B = '33333333-3333-3333-3333-333333333333';
const OWNER_B = '44444444-4444-4444-4444-444444444444';

const DEVICE_A1 = 'abababab-0000-0000-0000-0000000000a1';
const DEVICE_A2 = 'abababab-0000-0000-0000-0000000000a2';
const DEVICE_B = 'abababab-0000-0000-0000-0000000000b1';

/**
 * A campaign's `targetDeviceIds` is stored. New campaigns keep only their own
 * project's ids at creation, but a scheduled or recurring campaign saved
 * before that check can still name another tenant's devices, and the worker
 * and the scheduler read the stored list back. Every device-id reader must
 * therefore scope by project itself: here a log in project A names a device of
 * project B, and none of B's tokens may be counted, paged, listed or grouped.
 *
 * Against Postgres, because the question is what the WHERE clause matches.
 */
describe('PushTokensService device-id readers stay inside the project (integration)', () => {
  let ds: DataSource;
  let service: PushTokensService;
  let log: PushNotificationLogEntity;

  const seedToken = async (projectId: string, deviceIdentityId: string, token: string) => {
    await ds.query(
      `INSERT INTO push_tokens (project_id, device_identity_id, token, platform, provider, is_active)
       VALUES ($1, $2, $3, 'android', 'fcm', true)`,
      [projectId, deviceIdentityId, token],
    );
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new PushTokensService(ds.getRepository(PushTokenEntity), null as never);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query('DELETE FROM push_notification_logs WHERE project_id IN ($1, $2)', [
        INT_PROJECT_ID,
        PROJECT_B,
      ]);
      await ds.query('DELETE FROM push_tokens WHERE project_id = $1', [PROJECT_B]);
      await ds.query('DELETE FROM device_identities WHERE project_id = $1', [PROJECT_B]);
      await ds.query('DELETE FROM projects WHERE id = $1', [PROJECT_B]);
      await ds.query('DELETE FROM users WHERE id = $1', [OWNER_B]);
    }
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query('DELETE FROM push_notification_logs WHERE project_id IN ($1, $2)', [
      INT_PROJECT_ID,
      PROJECT_B,
    ]);
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name)
       VALUES ($1, 'tenant-b@test.local', 'x', 'b') ON CONFLICT (id) DO NOTHING`,
      [OWNER_B],
    );
    await ds.query(
      `INSERT INTO projects (id, name, owner_id) VALUES ($1, 'b', $2) ON CONFLICT (id) DO NOTHING`,
      [PROJECT_B, OWNER_B],
    );

    await seedPerson(ds, { id: DEVICE_A1, platform: 'android' });
    await seedPerson(ds, { id: DEVICE_A2, platform: 'android' });
    // seedPerson always writes project A; B's device is written by hand.
    await ds.query(
      `INSERT INTO device_identities (id, project_id, device_fingerprint, platform, timezone)
       VALUES ($1, $2, 'fp-b', 'android', 'Asia/Tokyo')`,
      [DEVICE_B, PROJECT_B],
    );
    await seedToken(INT_PROJECT_ID, DEVICE_A1, 'tok-a1');
    await seedToken(INT_PROJECT_ID, DEVICE_A2, 'tok-a2');
    await seedToken(PROJECT_B, DEVICE_B, 'tok-b');

    // A campaign whose stored recipients name another project's device (stored
    // recipients are filtered to the project when written; the readers must not rely on it).
    const [{ id }] = await ds.query(
      `INSERT INTO push_notification_logs (project_id, title, target_type)
       VALUES ($1, 'old scheduled campaign', 'devices') RETURNING id`,
      [INT_PROJECT_ID],
    );
    await ds.query(
      `INSERT INTO campaign_recipients (campaign_id, role, device_identity_id)
       SELECT $1, 'target', unnest($2::uuid[])`,
      [id, [DEVICE_A1, DEVICE_B, DEVICE_A2]],
    );
    log = (await ds.getRepository(PushNotificationLogEntity).findOneByOrFail({ id }))!;
  });

  it('reads the stored recipients back with the foreign device in them', async () => {
    // Guards the fixture: without B's id in the stored rows, every assertion
    // below would pass for the wrong reason.
    const rows: Array<{ device_identity_id: string }> = await ds.query(
      `SELECT device_identity_id FROM campaign_recipients WHERE campaign_id = $1`,
      [log.id],
    );
    expect(rows.map((row) => row.device_identity_id)).toContain(DEVICE_B);
  });

  it('pages only project A\'s tokens (the campaign worker)', async () => {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: PushTokenEntity[] = await service.getTokensByDeviceIdentityIdsPage(
        log.projectId,
        storedRecipients(log.id),
        cursor,
        1,
        null,
        log.id,
      );
      if (page.length === 0) break;
      collected.push(...page.map((t) => t.token));
      cursor = page[page.length - 1].id;
    }
    expect(collected.sort()).toEqual(['tok-a1', 'tok-a2']);
  });

  it('counts only project A\'s tokens (send, preview and journeys)', async () => {
    expect(await service.countTokensByDeviceIdentityIds(log.projectId, storedRecipients(log.id))).toBe(2);
    expect(await service.countTokensByDeviceIdentityIds(log.projectId, [DEVICE_B])).toBe(0);
  });

  it('lists only project A\'s devices (experiment arms)', async () => {
    const ids = await allPushAudienceIds(service, {
      projectId: log.projectId,
      recipients: storedRecipients(log.id),
    });
    expect(ids.sort()).toEqual([DEVICE_A1, DEVICE_A2].sort());
  });

  it('groups only project A\'s devices (timezone waves)', async () => {
    const waves = await pushAudienceByTimezone(
      service,
      { projectId: log.projectId, recipients: storedRecipients(log.id) },
      'UTC',
    );
    expect([...waves.values()].flat().sort()).toEqual([DEVICE_A1, DEVICE_A2].sort());
    expect(waves.has('Asia/Tokyo')).toBe(false);
  });

  it('still reaches project B\'s own device for project B', async () => {
    // The filter scopes, it does not merely drop B's devices everywhere.
    expect(await service.countTokensByDeviceIdentityIds(PROJECT_B, [DEVICE_B])).toBe(1);
    expect(await allPushAudienceIds(service, { projectId: PROJECT_B, recipients: deviceList([DEVICE_B]) })).toEqual([
      DEVICE_B,
    ]);
  });
});

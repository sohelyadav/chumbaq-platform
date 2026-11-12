import { DataSource } from 'typeorm';
import { PushTokensService } from './push-tokens.service';
import { PushTokenEntity } from './entities/push-token.entity';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';

const OPTED_IN = 'eeeeeeee-0000-0000-0000-000000000001';
const NEVER_SAID = 'eeeeeeee-0000-0000-0000-000000000002';
const OPTED_OUT = 'eeeeeeee-0000-0000-0000-000000000003';
// A second device of the person on OPTED_OUT, who left notifications on there.
const SAME_PERSON_TABLET = 'eeeeeeee-0000-0000-0000-000000000004';

/**
 * `push_opt_in = false` across every token reader a send path uses, against
 * Postgres. Which path calls which reader:
 *
 * - campaign worker (`PushCampaignProcessor.nextPage`): `getActiveTokensPage`
 *   for a whole-project send, `getTokensByDeviceIdentityIdsPage` for devices
 *   and segments, which is also what journeys, send-to-user, A/B arms and
 *   timezone waves become once they are child campaigns;
 * - scheduler splitting arms and waves (`PushCampaignScheduleScheduler`):
 *   `listDeviceIdentityIds`, `groupDeviceIdentitiesByTimezone`;
 * - `PushNotificationsService.send`/`previewAudience`/`countReachableDevices`
 *   (journeys skip on zero): `countActiveTokensByProject`,
 *   `countTokensByDeviceIdentityIds`;
 * - the dashboard test send: `isTokenOptedOut`.
 */
describe('PushTokensService and push opt-out (integration)', () => {
  let ds: DataSource;
  let service: PushTokensService;

  const seedToken = async (deviceIdentityId: string, token: string) => {
    await ds.query(
      `INSERT INTO push_tokens (project_id, device_identity_id, token, platform, provider, is_active)
       VALUES ($1, $2, $3, 'android', 'fcm', true)`,
      [INT_PROJECT_ID, deviceIdentityId, token],
    );
  };

  const all = [OPTED_IN, NEVER_SAID, OPTED_OUT, SAME_PERSON_TABLET];
  const reachable = ['tok-in', 'tok-never', 'tok-tablet'];

  beforeAll(async () => {
    ds = await openIntDb();
    service = new PushTokensService(ds.getRepository(PushTokenEntity), null as never);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query('TRUNCATE push_tokens RESTART IDENTITY CASCADE');
    for (const id of all) await seedPerson(ds, { id, platform: 'android' });
    await ds.query(`UPDATE device_identities SET external_user_id = 'person-x' WHERE id = ANY($1::uuid[])`, [
      [OPTED_OUT, SAME_PERSON_TABLET],
    ]);
    await ds.query(`UPDATE device_identities SET push_opt_in = true WHERE id = $1`, [OPTED_IN]);
    await ds.query(`UPDATE device_identities SET push_opt_in = false WHERE id = $1`, [OPTED_OUT]);
    await ds.query(`UPDATE device_identities SET push_opt_in = true WHERE id = $1`, [SAME_PERSON_TABLET]);
    await seedToken(OPTED_IN, 'tok-in');
    await seedToken(NEVER_SAID, 'tok-never');
    await seedToken(OPTED_OUT, 'tok-out');
    await seedToken(SAME_PERSON_TABLET, 'tok-tablet');
  });

  const tokens = (rows: PushTokenEntity[]) => rows.map((t) => t.token).sort();

  it('leaves the opted-out device out of a whole-project page, and nobody else', async () => {
    expect(tokens(await service.getActiveTokensPage(INT_PROJECT_ID, null, 100))).toEqual(reachable);
  });

  it('leaves it out of a targeted page, even when it is named', async () => {
    expect(tokens(await service.getTokensByDeviceIdentityIdsPage(INT_PROJECT_ID, all, null, 100))).toEqual(reachable);
    expect(await service.getTokensByDeviceIdentityIdsPage(INT_PROJECT_ID, [OPTED_OUT], null, 100)).toEqual([]);
  });

  it('leaves it out of the audiences arms and waves are split over', async () => {
    expect((await service.listDeviceIdentityIds({ projectId: INT_PROJECT_ID })).sort()).toEqual(
      [OPTED_IN, NEVER_SAID, SAME_PERSON_TABLET].sort(),
    );
    expect(await service.listDeviceIdentityIds({ projectId: INT_PROJECT_ID, deviceIdentityIds: [OPTED_OUT] })).toEqual([]);

    const waves = await service.groupDeviceIdentitiesByTimezone({ projectId: INT_PROJECT_ID, deviceIdentityIds: all }, 'UTC');
    expect([...waves.values()].flat().sort()).toEqual([OPTED_IN, NEVER_SAID, SAME_PERSON_TABLET].sort());
  });

  it('leaves it out of the counts send, the preview and journeys rely on', async () => {
    expect(await service.countActiveTokensByProject(INT_PROJECT_ID)).toBe(3);
    expect(await service.countTokensByDeviceIdentityIds(INT_PROJECT_ID, all)).toBe(3);
    // A journey aimed at just this device sees nobody to reach, and skips.
    expect(await service.countTokensByDeviceIdentityIds(INT_PROJECT_ID, [OPTED_OUT])).toBe(0);
  });

  it('treats a device that never said either way as reachable', async () => {
    // Null is not consent withdrawn: the OS permission behind the token governs.
    expect(await service.countTokensByDeviceIdentityIds(INT_PROJECT_ID, [NEVER_SAID])).toBe(1);
  });

  it('follows the device the person turns it off on, not their other devices', async () => {
    expect(await service.countTokensByDeviceIdentityIds(INT_PROJECT_ID, [SAME_PERSON_TABLET])).toBe(1);
  });

  it('applies again the moment the device opts back in', async () => {
    await ds.query(`UPDATE device_identities SET push_opt_in = true WHERE id = $1`, [OPTED_OUT]);
    expect(await service.countTokensByDeviceIdentityIds(INT_PROJECT_ID, [OPTED_OUT])).toBe(1);
  });

  it('tells the test send which tokens belong to an opted-out device', async () => {
    expect(await service.isTokenOptedOut(INT_PROJECT_ID, 'tok-out')).toBe(true);
    expect(await service.isTokenOptedOut(INT_PROJECT_ID, 'tok-in')).toBe(false);
    expect(await service.isTokenOptedOut(INT_PROJECT_ID, 'tok-never')).toBe(false);
    // A token the project has never seen: a developer's own phone.
    expect(await service.isTokenOptedOut(INT_PROJECT_ID, 'pasted-token')).toBe(false);
  });
});

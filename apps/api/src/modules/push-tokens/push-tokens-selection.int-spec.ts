import { DataSource } from 'typeorm';
import { PushTokensService } from './push-tokens.service';
import { PushTokenEntity, PushProvider } from './entities/push-token.entity';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';

const DEVICE_A = 'cccccccc-0000-0000-0000-000000000001';
const DEVICE_B = 'cccccccc-0000-0000-0000-000000000002';
const DEVICE_C = 'cccccccc-0000-0000-0000-000000000003';

/**
 * The selection predicate is a correlated NOT EXISTS carrying two CASE
 * expressions, written into a query builder as raw SQL. A mocked repository
 * would prove the string was passed along and nothing about whether Postgres
 * accepts it or picks the right row, which is the entire question.
 */
describe('PushTokensService token selection (integration)', () => {
  let ds: DataSource;
  let service: PushTokensService;

  const seedToken = async (
    deviceIdentityId: string,
    token: string,
    provider: PushProvider,
    isActive = true,
  ) => {
    await ds.query(
      `INSERT INTO push_tokens
         (project_id, device_identity_id, token, platform, provider, is_active)
       VALUES ($1, $2, $3, 'android', $4, $5)`,
      [INT_PROJECT_ID, deviceIdentityId, token, provider, isActive],
    );
  };

  /** Every token the sender would actually deliver to, across all pages. */
  const selectAll = async (
    deviceIds?: string[],
    deliverable?: PushProvider[],
  ): Promise<string[]> => {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: PushTokenEntity[] = deviceIds
        ? await service.getTokensByDeviceIdentityIdsPage(
            INT_PROJECT_ID,
            deviceIds,
            cursor,
            2,
            null,
            null,
            deliverable,
          )
        : await service.getActiveTokensPage(
            INT_PROJECT_ID,
            cursor,
            2,
            null,
            null,
            deliverable,
          );
      if (page.length === 0) break;
      collected.push(...page.map((t) => t.token));
      cursor = page[page.length - 1].id;
    }
    return collected.sort();
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new PushTokensService(
      ds.getRepository(PushTokenEntity),
      null as never,
    );
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query('TRUNCATE push_tokens RESTART IDENTITY CASCADE');
    await seedPerson(ds, { id: DEVICE_A, platform: 'android' });
    await seedPerson(ds, { id: DEVICE_B, platform: 'android' });
    await seedPerson(ds, { id: DEVICE_C, platform: 'android' });
  });

  it('sends once to a device that only has FCM', async () => {
    await seedToken(DEVICE_A, 'fcm-only', 'fcm');

    expect(await selectAll()).toEqual(['fcm-only']);
  });

  it('prefers the vendor channel when a device has both', async () => {
    await seedToken(DEVICE_A, 'fcm-tok', 'fcm');
    await seedToken(DEVICE_A, 'mi-tok', 'mi_push');

    // The whole feature: on a device that has one, the vendor channel is the
    // delivery that actually arrives. And crucially, only one is sent.
    expect(await selectAll()).toEqual(['mi-tok']);
  });

  it('falls back to FCM when the vendor token is dead', async () => {
    await seedToken(DEVICE_A, 'fcm-tok', 'fcm');
    await seedToken(DEVICE_A, 'mi-dead', 'mi_push', false);

    // An inactive token must not shadow a live one, or deactivating the vendor
    // token would silently make the device unreachable.
    expect(await selectAll()).toEqual(['fcm-tok']);
  });

  it('picks exactly one when a device has two tokens on the same channel', async () => {
    await seedToken(DEVICE_A, 'fcm-old', 'fcm');
    await seedToken(DEVICE_A, 'fcm-new', 'fcm');

    // A stale row the provider has not rejected yet. Without the id tiebreak
    // both qualify and the duplicate returns in a narrower form.
    expect(await selectAll()).toHaveLength(1);
  });

  it('keeps devices independent', async () => {
    await seedToken(DEVICE_A, 'a-mi', 'mi_push');
    await seedToken(DEVICE_A, 'a-fcm', 'fcm');
    await seedToken(DEVICE_B, 'b-fcm', 'fcm');
    await seedToken(DEVICE_C, 'c-huawei', 'huawei');

    expect(await selectAll()).toEqual(['a-mi', 'b-fcm', 'c-huawei']);
  });

  it('loses nobody and duplicates nobody across pages', async () => {
    // Pages are size 2 while every device holds two tokens, so a device's
    // pair straddles a page boundary — the case per-page dedup cannot handle.
    for (const device of [DEVICE_A, DEVICE_B, DEVICE_C]) {
      await seedToken(device, `${device}-fcm`, 'fcm');
      await seedToken(device, `${device}-mi`, 'mi_push');
    }

    const selected = await selectAll();

    expect(selected).toHaveLength(3);
    expect(new Set(selected).size).toBe(3);
    expect(selected.every((t) => t.endsWith('-mi'))).toBe(true);
  });

  it('applies the same rule when targeting an explicit device list', async () => {
    await seedToken(DEVICE_A, 'a-fcm', 'fcm');
    await seedToken(DEVICE_A, 'a-mi', 'mi_push');
    await seedToken(DEVICE_B, 'b-fcm', 'fcm');

    // Both paging queries feed real campaigns; fixing one and not the other
    // would leave segment sends correct and device-list sends duplicating.
    expect(await selectAll([DEVICE_A, DEVICE_B])).toEqual(['a-mi', 'b-fcm']);
  });

  it('does not let another project\'s token shadow this one', async () => {
    await seedToken(DEVICE_A, 'ours-fcm', 'fcm');

    // A real second project, because push_tokens.project_id is a foreign key —
    // a made-up id would fail the insert rather than test the predicate.
    const OTHER_PROJECT = '77777777-7777-7777-7777-777777777777';
    await ds.query(
      `INSERT INTO projects (id, name, owner_id)
       SELECT $1, 'other', owner_id FROM projects WHERE id = $2
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_PROJECT, INT_PROJECT_ID],
    );
    await ds.query(
      `INSERT INTO push_tokens
         (project_id, device_identity_id, token, platform, provider, is_active)
       VALUES ($1, $2, 'theirs-mi', 'android', 'mi_push', true)`,
      [OTHER_PROJECT, DEVICE_A],
    );

    // The predicate is scoped by project. Without that, a token registered in
    // another project would suppress this project's only way to reach the
    // device.
    expect(await selectAll()).toEqual(['ours-fcm']);
  });

  describe('channels the project cannot send on', () => {
    it('ignores a token for a channel with no credentials', async () => {
      await seedToken(DEVICE_A, 'apns-tok', 'apns');
      await seedToken(DEVICE_B, 'fcm-tok', 'fcm');

      // The project is set up for FCM only. Selecting the APNs token would not
      // merely skip that device — reading credentials for a channel that has
      // none fails the entire campaign.
      expect(await selectAll(undefined, ['fcm'])).toEqual(['fcm-tok']);
    });

    it('does not let an undeliverable channel suppress one that works', async () => {
      await seedToken(DEVICE_A, 'mi-tok', 'mi_push');
      await seedToken(DEVICE_A, 'fcm-tok', 'fcm');

      // Mi Push outranks FCM, so without restricting the subquery too it would
      // win and leave a reachable device with nothing to send to.
      expect(await selectAll(undefined, ['fcm'])).toEqual(['fcm-tok']);
    });

    it('still prefers the vendor channel once it is configured', async () => {
      await seedToken(DEVICE_A, 'mi-tok', 'mi_push');
      await seedToken(DEVICE_A, 'fcm-tok', 'fcm');

      expect(await selectAll(undefined, ['fcm', 'mi_push'])).toEqual(['mi-tok']);
    });

    it('selects nothing when the project can send on no channel at all', async () => {
      await seedToken(DEVICE_A, 'fcm-tok', 'fcm');

      // `IN ()` is not valid SQL, so an empty list has to be handled rather
      // than interpolated.
      expect(await selectAll(undefined, [])).toEqual([]);
    });

    it('applies the same restriction to an explicit device list', async () => {
      await seedToken(DEVICE_A, 'a-apns', 'apns');
      await seedToken(DEVICE_A, 'a-fcm', 'fcm');

      expect(await selectAll([DEVICE_A], ['fcm'])).toEqual(['a-fcm']);
    });
  });
});

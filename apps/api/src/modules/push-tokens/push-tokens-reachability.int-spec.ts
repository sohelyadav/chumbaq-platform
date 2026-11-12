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

const DEVICE_A = 'bbbbbbbb-0000-0000-0000-000000000001';
const DEVICE_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const DEVICE_C = 'bbbbbbbb-0000-0000-0000-000000000003';

/**
 * Run against a real database because the query is the whole feature: a
 * `COUNT(*) FILTER` and a correlated `NOT EXISTS` written as raw fragments
 * inside the query builder. A mocked repository would assert the strings were
 * passed along, which is not the same as Postgres accepting them or the
 * counts being right.
 */
describe('PushTokensService reachability (integration)', () => {
  let ds: DataSource;
  let service: PushTokensService;

  const seedToken = async (opts: {
    deviceIdentityId: string;
    token: string;
    isActive: boolean;
    reason?: 'provider_rejected' | 'app_requested';
    daysAgo?: number;
  }) => {
    await ds.query(
      `INSERT INTO push_tokens
         (project_id, device_identity_id, token, platform, provider, is_active,
          deactivated_at, deactivation_reason)
       VALUES ($1, $2, $3, 'ios', 'fcm', $4,
               CASE WHEN $5::text IS NULL THEN NULL
                    ELSE NOW() - ($6::int * INTERVAL '1 day') END,
               $5)`,
      [
        INT_PROJECT_ID,
        opts.deviceIdentityId,
        opts.token,
        opts.isActive,
        opts.reason ?? null,
        opts.daysAgo ?? 1,
      ],
    );
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new PushTokensService(
      ds.getRepository(PushTokenEntity),
      // Not exercised by these reads.
      null as never,
    );
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query('TRUNCATE push_tokens RESTART IDENTITY CASCADE');
    await seedPerson(ds, { id: DEVICE_A });
    await seedPerson(ds, { id: DEVICE_B });
    await seedPerson(ds, { id: DEVICE_C });
  });

  it('counts a rejected token with no live sibling as a likely uninstall', async () => {
    await seedToken({
      deviceIdentityId: DEVICE_A,
      token: 'gone',
      isActive: false,
      reason: 'provider_rejected',
    });

    const stats = await service.getReachabilityLosses(INT_PROJECT_ID);

    expect(stats.providerRejected).toBe(1);
    expect(stats.likelyUninstalls).toBe(1);
  });

  it('does not count a rotated token as an uninstall', async () => {
    // The provider rejected the old token, but the same device registered a
    // new one — the app is plainly still installed.
    await seedToken({
      deviceIdentityId: DEVICE_B,
      token: 'old',
      isActive: false,
      reason: 'provider_rejected',
    });
    await seedToken({
      deviceIdentityId: DEVICE_B,
      token: 'new',
      isActive: true,
    });

    const stats = await service.getReachabilityLosses(INT_PROJECT_ID);

    // Still a rejection, but not a lost user. Reporting it as one is the
    // largest known source of false positives in this figure.
    expect(stats.providerRejected).toBe(1);
    expect(stats.likelyUninstalls).toBe(0);
  });

  it('never counts a logout as an uninstall', async () => {
    await seedToken({
      deviceIdentityId: DEVICE_C,
      token: 'signed-out',
      isActive: false,
      reason: 'app_requested',
    });

    const stats = await service.getReachabilityLosses(INT_PROJECT_ID);

    expect(stats.appRequested).toBe(1);
    expect(stats.likelyUninstalls).toBe(0);
    expect(stats.providerRejected).toBe(0);
  });

  it('ignores losses older than the window', async () => {
    await seedToken({
      deviceIdentityId: DEVICE_A,
      token: 'ancient',
      isActive: false,
      reason: 'provider_rejected',
      daysAgo: 90,
    });

    expect(
      (await service.getReachabilityLosses(INT_PROJECT_ID, 30)).likelyUninstalls,
    ).toBe(0);
    expect(
      (await service.getReachabilityLosses(INT_PROJECT_ID, 365)).likelyUninstalls,
    ).toBe(1);
  });

  it('omits tokens deactivated before this was recorded', async () => {
    // Pre-migration rows: inactive, but with no date or reason. They are
    // absent from the figures rather than guessed at.
    await seedToken({ deviceIdentityId: DEVICE_A, token: 'legacy', isActive: false });

    const stats = await service.getReachabilityLosses(INT_PROJECT_ID);

    expect(stats.providerRejected).toBe(0);
    expect(stats.likelyUninstalls).toBe(0);
  });

  it('reports active tokens and a daily series', async () => {
    await seedToken({ deviceIdentityId: DEVICE_A, token: 'live-1', isActive: true });
    await seedToken({ deviceIdentityId: DEVICE_B, token: 'live-2', isActive: true });
    await seedToken({
      deviceIdentityId: DEVICE_C,
      token: 'lost',
      isActive: false,
      reason: 'provider_rejected',
      daysAgo: 2,
    });

    const stats = await service.getReachabilityLosses(INT_PROJECT_ID);

    expect(stats.activeTokens).toBe(2);
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0].likelyUninstalls).toBe(1);
    expect(stats.daily[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is scoped to one project', async () => {
    await seedToken({
      deviceIdentityId: DEVICE_A,
      token: 'ours',
      isActive: false,
      reason: 'provider_rejected',
    });

    const stats = await service.getReachabilityLosses(
      '99999999-9999-9999-9999-999999999999',
    );

    expect(stats.providerRejected).toBe(0);
    expect(stats.activeTokens).toBe(0);
  });
});

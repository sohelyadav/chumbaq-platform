import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb } from '../../test-support/int-db';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { MixpanelProfile } from './mixpanel-api.service';
import { MixpanelCohortSyncService } from './mixpanel-cohort-sync.service';
import { COHORT_RESOLVE_BATCH, COHORT_SYNC_DEADLINE_MS } from './cohort-sync-limits';

/**
 * A cohort member is someone else's pushes and in-app messages, so a Mixpanel profile
 * may resolve only to a device row through something proved about it: a verified
 * external id, or an address confirmed from its own mailbox and held by no other row.
 * The app's key is public, so a distinct id or an unconfirmed email trait is a claim
 * anyone can make.
 */
describe('Mixpanel cohort member resolution (integration)', () => {
  let ds: DataSource;
  const owner = randomUUID();
  let projectId: string;
  let members: MixpanelProfile[];

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'mp')`, [
      owner,
      `${owner}@mixpanel-resolution-int.test`,
    ]);
  });

  beforeEach(async () => {
    [{ id: projectId }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('mp', $1) RETURNING id`, [owner]);
    members = [];
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    await closeIntDb(ds);
  });

  const service = () =>
    new MixpanelCohortSyncService(
      ds.getRepository(MixpanelCohortEntity),
      ds.getRepository(MixpanelCohortMemberEntity),
      ds.getRepository(DeviceIdentityEntity),
      {
        listCohorts: async () => [{ id: 9, name: 'Cohort', count: members.length }],
        getCohortMembers: async () => members,
      } as never,
      { getDecryptedConfig: async () => ({ username: 'u', password: 'p', mixpanelProjectId: '1' }) } as never,
    );

  const device = async (row: {
    externalUserId?: string;
    distinctId?: string;
    email?: string;
    confirmed?: boolean;
    seenAgo?: string;
  }): Promise<string> => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO device_identities
         (id, project_id, external_user_id, distinct_id, device_fingerprint, platform, email, email_confirmed_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, 'ios', $6, CASE WHEN $7 THEN now() END, now() - $8::interval)`,
      [id, projectId, row.externalUserId ?? null, row.distinctId ?? null, `fp-${id}`, row.email ?? null, !!row.confirmed, row.seenAgo ?? '0 minutes'],
    );
    return id;
  };

  const profile = (distinctId: string, email?: string): MixpanelProfile => ({
    $distinct_id: distinctId,
    $properties: email ? { $email: email } : {},
  });

  const sync = async () => {
    const outcome = await service().syncForJob(projectId, 9);
    const rows: Array<{ mixpanelDistinctId: string; deviceIdentityId: string | null; resolvedBy: string | null }> =
      await ds.query(
        `SELECT "mixpanelDistinctId", "deviceIdentityId", "resolvedBy" FROM mixpanel_cohort_members
          WHERE "projectId" = $1 ORDER BY "mixpanelDistinctId"`,
        [projectId],
      );
    const [cohort] = await ds.query(
      `SELECT status, "resolvedCount", "unresolvedCount", "errorMessage" FROM mixpanel_cohorts WHERE "projectId" = $1`,
      [projectId],
    );
    return { outcome, rows, byId: new Map(rows.map((row) => [row.mixpanelDistinctId, row])), cohort };
  };

  it("resolves a member by its verified external id, to that person's most recently seen device", async () => {
    await device({ externalUserId: 'user-1', seenAgo: '2 days' });
    const recent = await device({ externalUserId: 'user-1' });
    members = [profile('user-1')];
    const { byId } = await sync();
    expect(byId.get('user-1')).toMatchObject({ deviceIdentityId: recent, resolvedBy: 'external_user_id' });
  });

  it('never resolves a member through a distinct id the SDK reported', async () => {
    await device({ distinctId: 'user-2' });
    members = [profile('user-2')];
    const { byId } = await sync();
    expect(byId.get('user-2')).toMatchObject({ deviceIdentityId: null, resolvedBy: null });
  });

  it('never resolves a member through an address nobody confirmed from its mailbox', async () => {
    await device({ email: 'victim@example.com' });
    members = [profile('mp-3', 'victim@example.com')];
    const { byId } = await sync();
    expect(byId.get('mp-3')?.deviceIdentityId).toBeNull();
  });

  it('resolves a member by a confirmed address only the one row holds, whatever its case', async () => {
    const owner = await device({ email: 'solo@example.com', confirmed: true });
    members = [profile('mp-4', ' Solo@Example.com ')];
    const { byId } = await sync();
    expect(byId.get('mp-4')).toMatchObject({ deviceIdentityId: owner, resolvedBy: 'email' });
  });

  it('resolves nobody when a second row holds the address, confirmed or not', async () => {
    await device({ email: 'shared@example.com', confirmed: true });
    await device({ email: 'shared@example.com' });
    await device({ email: 'both@example.com', confirmed: true });
    await device({ email: 'both@example.com', confirmed: true });
    members = [profile('mp-5', 'shared@example.com'), profile('mp-6', 'both@example.com')];
    const { byId } = await sync();
    expect(byId.get('mp-5')?.deviceIdentityId).toBeNull();
    expect(byId.get('mp-6')?.deviceIdentityId).toBeNull();
  });

  it('never resolves to a row of another project', async () => {
    const [{ id: other }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('other', $1) RETURNING id`, [owner]);
    await ds.query(
      `INSERT INTO device_identities (id, project_id, external_user_id, device_fingerprint, platform, email, email_confirmed_at)
       VALUES ($1, $2, 'user-7', 'fp-other', 'ios', 'elsewhere@example.com', now())`,
      [randomUUID(), other],
    );
    members = [profile('user-7'), profile('mp-8', 'elsewhere@example.com')];
    const { rows } = await sync();
    expect(rows.every((row) => row.deviceIdentityId === null)).toBe(true);
  });

  it('writes every member of a cohort larger than a batch, updates kept ones and drops departed ones', async () => {
    const known = await device({ externalUserId: 'user-0' });
    members = Array.from({ length: COHORT_RESOLVE_BATCH * 2 + 5 }, (_, i) => profile(`user-${i}`));
    members.push(profile('user-0'), { $distinct_id: 'x'.repeat(513), $properties: {} });
    let result = await sync();
    expect(result.outcome).toEqual({ kind: 'synced' });
    expect(result.rows).toHaveLength(COHORT_RESOLVE_BATCH * 2 + 5);
    expect(result.cohort).toMatchObject({ status: 'synced', resolvedCount: 1, unresolvedCount: COHORT_RESOLVE_BATCH * 2 + 4 });
    expect(result.byId.get('user-0')?.deviceIdentityId).toBe(known);

    const later = await device({ externalUserId: 'user-1' });
    members = [profile('user-1'), profile('user-new')];
    result = await sync();
    expect(result.rows.map((row) => row.mixpanelDistinctId)).toEqual(['user-1', 'user-new']);
    expect(result.byId.get('user-1')?.deviceIdentityId).toBe(later);
  });

  it('stops a sync whose member fetch ran up to its deadline, and says it will not be retried', async () => {
    members = Array.from({ length: COHORT_RESOLVE_BATCH * 3 }, (_, i) => profile(`slow-${i}`));
    const realNow = Date.now;
    const sync = new MixpanelCohortSyncService(
      ds.getRepository(MixpanelCohortEntity),
      ds.getRepository(MixpanelCohortMemberEntity),
      ds.getRepository(DeviceIdentityEntity),
      {
        listCohorts: async () => [{ id: 9, name: 'Cohort', count: members.length }],
        // Mixpanel took the whole allowance: the clock is past the deadline it was given.
        getCohortMembers: async (_creds: unknown, _id: number, limits: { deadline: number }) => {
          expect(limits.deadline - realNow()).toBeGreaterThan(COHORT_SYNC_DEADLINE_MS - 60_000);
          jest.spyOn(Date, 'now').mockReturnValue(limits.deadline + 1);
          return members;
        },
      } as never,
      { getDecryptedConfig: async () => ({ username: 'u', password: 'p', mixpanelProjectId: '1' }) } as never,
    );
    try {
      const outcome = await sync.syncForJob(projectId, 9);
      expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
      const [cohort] = await ds.query(`SELECT status, "errorMessage" FROM mixpanel_cohorts WHERE "projectId" = $1`, [projectId]);
      expect(cohort.status).toBe('error');
      expect(cohort.errorMessage).toMatch(/longer than 10 minutes/);
      const [{ count }] = await ds.query(`SELECT count(*)::int FROM mixpanel_cohort_members WHERE "projectId" = $1`, [projectId]);
      expect(count).toBe(0);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

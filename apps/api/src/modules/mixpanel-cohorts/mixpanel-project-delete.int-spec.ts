import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb } from '../../test-support/int-db';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { MixpanelCohortSyncService } from './mixpanel-cohort-sync.service';

/**
 * Deleting a project must take its Mixpanel credentials, cohorts and members (each a
 * copy of an end user's Mixpanel profile) with it, or the hourly sync keeps using them.
 */
describe('Deleting a project with Mixpanel cohorts (integration)', () => {
  let ds: DataSource;
  const owner = randomUUID();

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'mp')`, [
      owner,
      `${owner}@mixpanel-delete-int.test`,
    ]);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    await closeIntDb(ds);
  });

  it('removes its config, cohorts and members', async () => {
    const [{ id: projectId }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('mp', $1) RETURNING id`, [owner]);
    await ds.query(
      `INSERT INTO mixpanel_configs ("projectId", "serviceAccountUsername", "serviceAccountPasswordEncrypted",
         "encryptionIv", "encryptionTag", "mixpanelProjectId")
       VALUES ($1, 'u', 'p', 'iv', 'tag', '1')`,
      [projectId],
    );
    const [{ id: cohortId }] = await ds.query(
      `INSERT INTO mixpanel_cohorts ("projectId", "mixpanelCohortId", name) VALUES ($1, 1, 'c') RETURNING id`,
      [projectId],
    );
    await ds.query(
      `INSERT INTO mixpanel_cohort_members ("projectId", "cohortId", "mixpanelDistinctId") VALUES ($1, $2, 'd1')`,
      [projectId, cohortId],
    );

    await ds.query(`DELETE FROM projects WHERE id = $1`, [projectId]);

    for (const table of ['mixpanel_configs', 'mixpanel_cohorts', 'mixpanel_cohort_members']) {
      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM ${table} WHERE "projectId" = $1`, [projectId]);
      expect({ table, count }).toEqual({ table, count: 0 });
    }
  });

  // A sync loads the cohort, spends most of its time fetching, then writes its outcome.
  it.each([
    ['succeeds', async () => []],
    ['fails', async () => { throw new Error('Mixpanel unavailable'); }],
  ])('does not bring back a cohort deleted while its sync %s', async (_outcome, after) => {
    const [{ id: projectId }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('mp', $1) RETURNING id`, [owner]);
    const [{ id: cohortId }] = await ds.query(
      `INSERT INTO mixpanel_cohorts ("projectId", "mixpanelCohortId", name, status) VALUES ($1, 7, 'c', 'syncing') RETURNING id`,
      [projectId],
    );
    const loaded = await ds.getRepository(MixpanelCohortEntity).findOneByOrFail({ id: cohortId });
    const api = {
      getCohortMembers: async () => {
        await ds.query(`DELETE FROM mixpanel_cohorts WHERE id = $1`, [cohortId]);
        return after();
      },
    };
    const service = new MixpanelCohortSyncService(
      ds.getRepository(MixpanelCohortEntity),
      ds.getRepository(MixpanelCohortMemberEntity),
      ds.getRepository(DeviceIdentityEntity),
      api as never,
      null as never,
    );

    await (service as unknown as { runSync: (...a: unknown[]) => Promise<void> }).runSync(
      loaded,
      { username: 'u', password: 'p', mixpanelProjectId: '1' },
      projectId,
    );

    const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM mixpanel_cohorts WHERE id = $1`, [cohortId]);
    expect(count).toBe(0);
    await ds.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });
});

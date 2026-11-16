import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb } from '../../test-support/int-db';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { MixpanelCohortSyncService } from './mixpanel-cohort-sync.service';

/** Each sync is a full Mixpanel import in the API process: one at a time per cohort. */
describe('Starting a Mixpanel cohort sync (integration)', () => {
  let ds: DataSource;
  const owner = randomUUID();
  let projectId: string;

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'mp')`, [
      owner,
      `${owner}@mixpanel-claim-int.test`,
    ]);
    [{ id: projectId }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('mp', $1) RETURNING id`, [owner]);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    await closeIntDb(ds);
  });

  const build = () => {
    const api = {
      listCohorts: jest.fn(async () => [{ id: 9, name: 'Renamed', count: 3 }]),
      getCohortMembers: jest.fn(async () => []),
    };
    const service = new MixpanelCohortSyncService(
      ds.getRepository(MixpanelCohortEntity),
      ds.getRepository(MixpanelCohortMemberEntity),
      ds.getRepository(DeviceIdentityEntity),
      api as never,
      { getDecryptedConfig: async () => ({ username: 'u', password: 'p', mixpanelProjectId: '1' }) } as never,
    );
    return { service, api };
  };

  const cohort = async (status: string, updatedAgo = '0 minutes') => {
    await ds.query(`DELETE FROM mixpanel_cohorts WHERE "projectId" = $1`, [projectId]);
    await ds.query(
      `INSERT INTO mixpanel_cohorts ("projectId", "mixpanelCohortId", name, status, "updatedAt")
       VALUES ($1, 9, 'Old', $2, now() - $3::interval)`,
      [projectId, status, updatedAgo],
    );
  };

  it('starts a sync of an idle cohort, renamed and marked syncing', async () => {
    await cohort('synced');
    const { service, api } = build();
    expect(await service.syncForJob(projectId, 9)).toEqual({ kind: 'synced' });
    expect(api.getCohortMembers).toHaveBeenCalledTimes(1);
    const [row] = await ds.query(`SELECT name, status FROM mixpanel_cohorts WHERE "projectId" = $1`, [projectId]);
    expect(row).toMatchObject({ name: 'Renamed', status: 'synced' });
  });

  it('does not start a second sync while one is running', async () => {
    await cohort('syncing');
    const { service, api } = build();
    expect(await service.syncForJob(projectId, 9)).toEqual({ kind: 'busy' });
    expect(api.getCohortMembers).not.toHaveBeenCalled();
  });

  it('takes over a sync left syncing for hours by a process that died', async () => {
    await cohort('syncing', '3 hours');
    const { service, api } = build();
    await service.syncForJob(projectId, 9);
    expect(api.getCohortMembers).toHaveBeenCalledTimes(1);
  });
});

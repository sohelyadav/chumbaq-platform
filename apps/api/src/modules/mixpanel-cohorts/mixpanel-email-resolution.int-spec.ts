import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb, resetFixtures, seedPerson, INT_PROJECT_ID } from '../../test-support/int-db';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { MixpanelCohortSyncService } from './mixpanel-cohort-sync.service';

/**
 * A Mixpanel profile that matches no row by id falls back to the `email` trait, which
 * anyone holding the public SDK key can write. A row naming a stranger's address must
 * not take their place in a cohort.
 */
describe('Mixpanel cohort resolution by email trait (integration)', () => {
  let ds: DataSource;
  let resolve: (projectId: string, email: string) => Promise<DeviceIdentityEntity | null>;

  beforeAll(async () => {
    ds = await openIntDb();
    await resetFixtures(ds);
    const service = new MixpanelCohortSyncService(
      null as never,
      null as never,
      ds.getRepository(DeviceIdentityEntity),
      null as never,
      null as never,
    );
    resolve = (projectId, email) =>
      (service as unknown as { onlyRowWithEmailTrait: typeof resolve }).onlyRowWithEmailTrait(projectId, email);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  it('resolves the only row carrying the address', async () => {
    const id = randomUUID();
    await seedPerson(ds, { id, traits: { email: 'solo@example.com' } });
    expect((await resolve(INT_PROJECT_ID, 'solo@example.com'))?.id).toBe(id);
  });

  it('resolves nobody when a second row claims the same address', async () => {
    await seedPerson(ds, { id: randomUUID(), traits: { email: 'victim@example.com' } });
    await seedPerson(ds, { id: randomUUID(), traits: { email: 'victim@example.com' } });
    expect(await resolve(INT_PROJECT_ID, 'victim@example.com')).toBeNull();
  });
});

import { DataSource } from 'typeorm';
import { ProjectEntity } from './entities/project.entity';
import { ProjectSuspensionService } from './project-suspension.service';
import { closeIntDb, openIntDb } from '../../test-support/int-db';

/**
 * The join through `users` is the whole of this service, and a mocked repository
 * can only confirm a string was passed along.
 */
describe('ProjectSuspensionService (integration)', () => {
  let ds: DataSource;
  let service: ProjectSuspensionService;

  const SUSPENDED_OWNER = 'a4000000-0000-4000-8000-000000000001';
  const ACTIVE_OWNER = 'a4000000-0000-4000-8000-000000000002';
  const SUSPENDED_A = 'a4000000-0000-4000-8000-00000000000a';
  const SUSPENDED_B = 'a4000000-0000-4000-8000-00000000000b';
  const ACTIVE = 'a4000000-0000-4000-8000-00000000000c';

  const cleanUp = async () => {
    await ds.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [
      [SUSPENDED_A, SUSPENDED_B, ACTIVE],
    ]);
    await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [SUSPENDED_OWNER, ACTIVE_OWNER],
    ]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new ProjectSuspensionService(ds.getRepository(ProjectEntity));
  });

  beforeEach(async () => {
    await cleanUp();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, suspended_at, suspended_reason)
       VALUES ($1, 'ws4-suspended@test.local', 'x', 's', NOW(), 'test'),
              ($2, 'ws4-active@test.local', 'x', 'a', NULL, NULL)`,
      [SUSPENDED_OWNER, ACTIVE_OWNER],
    );
    await ds.query(
      `INSERT INTO projects (id, name, owner_id)
       VALUES ($1, 'a', $4), ($2, 'b', $4), ($3, 'c', $5)`,
      [SUSPENDED_A, SUSPENDED_B, ACTIVE, SUSPENDED_OWNER, ACTIVE_OWNER],
    );
  });

  afterAll(async () => {
    await cleanUp();
    await closeIntDb(ds);
  });

  it('is true for every project of a suspended owner', async () => {
    await expect(service.isSuspended(SUSPENDED_A)).resolves.toBe(true);
    await expect(service.isSuspended(SUSPENDED_B)).resolves.toBe(true);
  });

  it('is false for an active owner\'s project and for a project that does not exist', async () => {
    await expect(service.isSuspended(ACTIVE)).resolves.toBe(false);
    await expect(
      service.isSuspended('a4000000-0000-4000-8000-0000000000ff'),
    ).resolves.toBe(false);
  });

  it('takes effect in both directions on the very next call', async () => {
    await ds.query(`UPDATE users SET suspended_at = NULL WHERE id = $1`, [SUSPENDED_OWNER]);
    await expect(service.isSuspended(SUSPENDED_A)).resolves.toBe(false);

    await ds.query(`UPDATE users SET suspended_at = NOW() WHERE id = $1`, [ACTIVE_OWNER]);
    await expect(service.isSuspended(ACTIVE)).resolves.toBe(true);
  });

  it('lists every suspended project in the batch form, and no active one', async () => {
    const ids = await service.suspendedProjectIds();

    expect(ids.has(SUSPENDED_A)).toBe(true);
    expect(ids.has(SUSPENDED_B)).toBe(true);
    expect(ids.has(ACTIVE)).toBe(false);
  });

  it('drops a reactivated tenant from the batch form', async () => {
    await ds.query(`UPDATE users SET suspended_at = NULL WHERE id = $1`, [SUSPENDED_OWNER]);

    const ids = await service.suspendedProjectIds();

    expect(ids.has(SUSPENDED_A)).toBe(false);
    expect(ids.has(SUSPENDED_B)).toBe(false);
  });
});

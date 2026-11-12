import { DataSource, Repository } from 'typeorm';
import { closeIntDb, INT_PROJECT_ID, openIntDb, resetFixtures } from '../../test-support/int-db';
import { ApiKeyEntity } from './entities/api-key.entity';
import { ApiKeysService } from './api-keys.service';

/** The activity log is the activity specs' to test; these runs only need it to accept. */
const noLog = { record: async () => undefined } as never;
const CTX = { ipAddress: null, userAgent: null };
const ACTOR = '00000000-0000-4000-8000-000000000001';

/**
 * Every SDK request validates its API key and stamps last_used_at. A revoke
 * that commits between that lookup and that write must stay revoked: writing
 * the whole row read before it put is_active back to true, so a revoked key
 * started working again.
 */
describe('API key revoke vs. a request using the key (integration)', () => {
  let ds: DataSource;
  let repo: Repository<ApiKeyEntity>;

  beforeAll(async () => {
    ds = await openIntDb();
    await resetFixtures(ds);
    repo = ds.getRepository(ApiKeyEntity);
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM api_keys WHERE project_id = $1`, [INT_PROJECT_ID]);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await ds.query(`DELETE FROM api_keys WHERE project_id = $1`, [INT_PROJECT_ID]);
    await closeIntDb(ds);
  });

  const isActive = async (id: string): Promise<boolean> =>
    (await ds.query(`SELECT is_active FROM api_keys WHERE id = $1`, [id]))[0].is_active;

  it('a revoke landing between the lookup and the last-used write stays revoked', async () => {
    const service = new ApiKeysService(repo, noLog);
    const { apiKey, fullKey } = await service.create(INT_PROJECT_ID, { name: 'sdk' } as never, ACTOR, CTX);

    // The revoke commits right after validateKey has read the key as active.
    const findOne = repo.findOne.bind(repo);
    jest.spyOn(repo, 'findOne').mockImplementationOnce(async (options) => {
      const row = await findOne(options);
      await new ApiKeysService(ds.getRepository(ApiKeyEntity), noLog).revoke(apiKey.id, INT_PROJECT_ID, ACTOR, CTX);
      return row;
    });

    const validated = await service.validateKey(fullKey);

    expect(await isActive(apiKey.id)).toBe(false);
    // Revoked before this request finished, so it is refused too.
    expect(validated).toBeNull();
    // And every later request is refused.
    expect(await service.validateKey(fullKey)).toBeNull();
  });

  it('an active key still validates and records when it was used', async () => {
    const service = new ApiKeysService(repo, noLog);
    const { apiKey, fullKey } = await service.create(INT_PROJECT_ID, { name: 'sdk' } as never, ACTOR, CTX);

    const validated = await service.validateKey(fullKey);

    expect(validated?.id).toBe(apiKey.id);
    const [row] = await ds.query(`SELECT last_used_at, is_active FROM api_keys WHERE id = $1`, [apiKey.id]);
    expect(row.last_used_at).not.toBeNull();
    expect(row.is_active).toBe(true);
  });

  it('revoke touches only is_active and refuses another project', async () => {
    const service = new ApiKeysService(repo, noLog);
    const { apiKey } = await service.create(INT_PROJECT_ID, { name: 'sdk' } as never, ACTOR, CTX);

    await expect(service.revoke(apiKey.id, '99999999-9999-4999-8999-999999999999', ACTOR, CTX)).rejects.toThrow('API key not found');
    expect(await isActive(apiKey.id)).toBe(true);

    await service.revoke(apiKey.id, INT_PROJECT_ID, ACTOR, CTX);
    expect(await isActive(apiKey.id)).toBe(false);
  });
});

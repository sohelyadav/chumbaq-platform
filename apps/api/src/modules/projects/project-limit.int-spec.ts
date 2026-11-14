import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SeatsService } from '../project-access/seats.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectActivityEntity } from '../project-activity/entities/project-activity.entity';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ProjectEntity } from './entities/project.entity';
import { ProjectsService } from './projects.service';
import { AccountLimitsService, projectLimitMessage } from '../billing/account-limits.service';

/**
 * The limit is a count under a lock on the owner's row, which only Postgres can
 * show holding when creates arrive together.
 */
describe('Projects per account (integration)', () => {
  const DEFAULT_LIMIT = 10;
  const DOMAIN = '@project-limit-int.test';
  let ds: DataSource;
  let service: ProjectsService;
  const owners: string[] = [];

  const account = async (projectLimit: number | null = null): Promise<string> => {
    const id = randomUUID();
    owners.push(id);
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, project_limit) VALUES ($1, $2, 'x', 'limit', $3)`,
      [id, `${id}${DOMAIN}`, projectLimit],
    );
    return id;
  };

  /** Straight into the table, as a project made before the limit existed would be. */
  const existing = async (ownerId: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const [{ id }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id`, [
        `old ${i}`,
        ownerId,
      ]);
      await addOwnerMember(ds, id, ownerId);
    }
  };

  const caller = (userId: string) => ({ userId, email: `${userId}${DOMAIN}`, isSuperAdmin: false });

  const countOf = async (ownerId: string): Promise<number> =>
    Number((await ds.query(`SELECT count(*) AS n FROM projects WHERE owner_id = $1`, [ownerId]))[0].n);

  const create = (ownerId: string, name = 'app') =>
    service.create(ownerId, { name, domain: 'example.com' } as never);

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error,
    );

  beforeAll(async () => {
    ds = await openIntDb();
    service = new ProjectsService(
      ds.getRepository(ProjectEntity),
      new AccountLimitsService(new ConfigService({ projects: { maxPerAccount: DEFAULT_LIMIT } })),
      new ProjectAccessService(null as never, null as never, null as never, null as never),
      new SeatsService(ds, new AccountLimitsService(new ConfigService({}))),
      new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})),
    );
  });

  afterAll(async () => {
    if (owners.length) {
      // Projects go with their owner (ON DELETE CASCADE).
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [owners]);
    }
    await closeIntDb(ds);
  });

  it(`refuses the ${DEFAULT_LIMIT + 1}th project with the limit in the message`, async () => {
    const owner = await account();
    for (let i = 0; i < DEFAULT_LIMIT; i++) await create(owner, `p${i}`);

    const error = await refusal(create(owner, 'one too many'));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(projectLimitMessage(DEFAULT_LIMIT));
    expect((error as ForbiddenException).message).toBe(
      'You can have up to 10 projects. Delete one or contact support to raise the limit.',
    );
    expect(await countOf(owner)).toBe(DEFAULT_LIMIT);
  });

  it('frees a place when a project is deleted', async () => {
    const owner = await account();
    await existing(owner, DEFAULT_LIMIT);
    await expect(create(owner)).rejects.toBeInstanceOf(ForbiddenException);

    const [{ id }] = await ds.query(`SELECT id FROM projects WHERE owner_id = $1 LIMIT 1`, [owner]);
    await service.remove(owner, await ds.getRepository(ProjectEntity).findOneByOrFail({ id }), { ipAddress: null, userAgent: null });

    await expect(create(owner)).resolves.toMatchObject({ ownerId: owner });
    expect(await countOf(owner)).toBe(DEFAULT_LIMIT);
  });

  it('lets creates that arrive together make no more than the limit', async () => {
    const owner = await account();
    await existing(owner, DEFAULT_LIMIT - 3);

    // Each create runs in its own transaction on its own pooled connection.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => refusal(create(owner, `race ${i}`))),
    );

    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome instanceof ForbiddenException)).toHaveLength(5);
    expect(await countOf(owner)).toBe(DEFAULT_LIMIT);
  });

  it('counts per account: one at its limit does not hold up another', async () => {
    const full = await account();
    const other = await account();
    await existing(full, DEFAULT_LIMIT);

    await expect(create(full)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(create(other)).resolves.toMatchObject({ ownerId: other });
  });

  it("counts a suspended account's projects too", async () => {
    const owner = await account();
    await ds.query(`UPDATE users SET suspended_at = NOW(), suspended_reason = 'test' WHERE id = $1`, [owner]);
    await existing(owner, DEFAULT_LIMIT);

    await expect(create(owner)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a raised override lets the account go past the default', async () => {
    const owner = await account(DEFAULT_LIMIT + 2);
    await existing(owner, DEFAULT_LIMIT);

    await create(owner);
    await create(owner);
    const error = await refusal(create(owner));

    expect((error as Error).message).toBe(projectLimitMessage(DEFAULT_LIMIT + 2));
    expect(await countOf(owner)).toBe(DEFAULT_LIMIT + 2);
  });

  it('a lowered override refuses below the default', async () => {
    const owner = await account(2);
    await create(owner);
    await create(owner);

    const error = await refusal(create(owner));

    expect((error as Error).message).toBe(projectLimitMessage(2));
  });

  it('an account already over its limit keeps every project and can still use them', async () => {
    const owner = await account();
    await existing(owner, DEFAULT_LIMIT + 4);

    await expect(create(owner)).rejects.toBeInstanceOf(ForbiddenException);

    expect(await countOf(owner)).toBe(DEFAULT_LIMIT + 4);
    const page = Object.assign(new PaginationDto(), { page: 1, limit: 50 });
    const listed = await service.findAllByUser(caller(owner), page);
    expect(listed.data).toHaveLength(DEFAULT_LIMIT + 4);
    expect(listed.meta).toMatchObject({
      total: DEFAULT_LIMIT + 4,
      projectLimit: DEFAULT_LIMIT,
      billedProjects: DEFAULT_LIMIT + 4,
    });
    const [{ id }] = await ds.query(`SELECT id FROM projects WHERE owner_id = $1 LIMIT 1`, [owner]);
    await expect(service.update(owner, await ds.getRepository(ProjectEntity).findOneByOrFail({ id }), { name: 'renamed' } as never, { ipAddress: null, userAgent: null })).resolves.toMatchObject({
      name: 'renamed',
    });
  });

  it('reports the effective limit with the list', async () => {
    const plain = await account();
    const raised = await account(25);
    const page = Object.assign(new PaginationDto(), { page: 1, limit: 20 });

    expect((await service.findAllByUser(caller(plain), page)).meta.projectLimit).toBe(DEFAULT_LIMIT);
    expect((await service.findAllByUser(caller(raised), page)).meta.projectLimit).toBe(25);
  });
});

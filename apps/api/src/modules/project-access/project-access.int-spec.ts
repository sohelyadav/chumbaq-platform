import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { LinkEntity } from '../links/entities/link.entity';
import { BannerCategoryEntity } from '../in-app-banners/entities/banner-category.entity';
import { InAppBannerEntity } from '../in-app-banners/entities/in-app-banner.entity';
import { ProjectMemberEntity } from './entities/project-member.entity';
import { ProjectAccessService } from './project-access.service';
import { PROJECT_NOT_FOUND, ROLE_REFUSAL } from './project-permissions';

/**
 * What the unit fakes cannot show: the real lookup against Postgres, joined to the real
 * project, and the visible-projects subquery as a QueryBuilder runs it.
 */
describe('ProjectAccessService (integration)', () => {
  const DOMAIN = '@project-access-int.test';
  let ds: DataSource;
  let service: ProjectAccessService;
  const users: string[] = [];

  const user = async (): Promise<string> => {
    const id = randomUUID();
    users.push(id);
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'p')`, [
      id,
      `${id}${DOMAIN}`,
    ]);
    return id;
  };

  /** A project as `ProjectsService.create` leaves it: the row and its owner's member row. */
  const project = async (ownerId: string): Promise<string> => {
    const [{ id }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('p', $1) RETURNING id`, [ownerId]);
    await addOwnerMember(ds, id, ownerId);
    return id;
  };

  const caller = (userId: string, impersonatedBy?: string): AuthenticatedUser => ({
    userId,
    email: `${userId}${DOMAIN}`,
    isSuperAdmin: false,
    impersonatedBy,
  });

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error as Error,
    );

  /** Every project the subquery lets this caller see, among `among`. */
  const visible = async (who: AuthenticatedUser, among: string[]): Promise<string[]> => {
    const q = service.memberProjectsQuery(who);
    const rows = await ds
      .createQueryBuilder()
      .select('p.id', 'id')
      .from('projects', 'p')
      .where(`p.id IN (${q.sql})`, q.params)
      .andWhere('p.id = ANY(:among)', { among })
      .orderBy('p.id')
      .getRawMany();
    return rows.map((row: { id: string }) => row.id);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new ProjectAccessService(
      ds.getRepository(ProjectMemberEntity),
      ds.getRepository(LinkEntity),
      ds.getRepository(BannerCategoryEntity),
      ds.getRepository(InAppBannerEntity),
    );
  });

  afterAll(async () => {
    if (users.length) await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await closeIntDb(ds);
  });

  it('finds the caller by their own member row, and nobody else by it', async () => {
    const owner = await user();
    const stranger = await user();
    const member = await user();
    const p = await project(owner);
    await addOwnerMember(ds, p, member, 'member');

    const mine = await service.require(caller(owner), p, 'project.admin');
    expect(mine).toMatchObject({ role: 'owner', isBillingOwner: true, impersonated: false });
    expect(mine.project).toMatchObject({ id: p, ownerId: owner });

    const theirs = await service.require(caller(member), p, 'messaging.write');
    expect(theirs).toMatchObject({ role: 'member', isBillingOwner: false });
    const forbidden = await refusal(service.require(caller(member), p, 'channels.manage'));
    expect(forbidden).toBeInstanceOf(ForbiddenException);
    expect(forbidden?.message).toBe(ROLE_REFUSAL);

    for (const missing of [
      service.require(caller(stranger), p, 'project.read'),
      service.require(caller(owner), randomUUID(), 'project.read'),
    ]) {
      const error = await refusal(missing);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error?.message).toBe(PROJECT_NOT_FOUND);
    }
  });

  it('keeps view-as to projects billed to the person viewed', async () => {
    const billing = await user();
    const viewed = await user();
    const theirs = await project(billing);
    const own = await project(viewed);
    await addOwnerMember(ds, theirs, viewed, 'owner');
    const staff = randomUUID();

    const error = await refusal(service.require(caller(viewed, staff), theirs, 'project.read'));
    expect(error?.message).toBe(PROJECT_NOT_FOUND);
    await expect(service.require(caller(viewed, staff), own, 'project.read')).resolves.toMatchObject({
      impersonated: true,
      isBillingOwner: true,
    });
  });

  it('lists the projects the caller is a member of, and in view-as only those billed to them', async () => {
    const viewed = await user();
    const other = await user();
    const own = await project(viewed);
    const shared = await project(other);
    const notMine = await project(other);
    await addOwnerMember(ds, shared, viewed, 'admin');
    const among = [own, shared, notMine];

    expect(await visible(caller(viewed), among)).toEqual([own, shared].sort());
    expect(await visible(caller(viewed, randomUUID()), among)).toEqual([own]);
    expect(await visible(caller(other), among)).toEqual([shared, notMine].sort());
  });

  it('finds the project of a link, a banner category and a banner', async () => {
    const owner = await user();
    const p = await project(owner);
    const [link] = await ds.query(
      `INSERT INTO links (project_id, short_code, long_url) VALUES ($1, $2, 'https://acme.example') RETURNING id`,
      [p, `pa${randomUUID().slice(0, 8)}`],
    );
    const [category] = await ds.query(
      `INSERT INTO banner_categories (project_id, name) VALUES ($1, 'Home') RETURNING id`,
      [p],
    );
    const [banner] = await ds.query(
      `INSERT INTO in_app_banners (category_id, title) VALUES ($1, 'Sale') RETURNING id`,
      [category.id],
    );
    expect(await service.projectIdOf('link', link.id)).toBe(p);
    expect(await service.projectIdOf('bannerCategory', category.id)).toBe(p);
    expect(await service.projectIdOf('banner', banner.id)).toBe(p);
    expect(await service.projectIdOf('banner', randomUUID())).toBeNull();
  });
});

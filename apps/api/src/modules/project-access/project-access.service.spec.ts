import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { FakeProjectAccessDb } from '../../test-support/fake-project-access-db';
import { ProjectAccessService } from './project-access.service';
import { PROJECT_NOT_FOUND, ROLE_REFUSAL } from './project-permissions';

const person = (userId: string = randomUUID(), extra: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  userId,
  email: `${userId}@acme.example`,
  isSuperAdmin: false,
  ...extra,
});

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe('ProjectAccessService.require', () => {
  let db: FakeProjectAccessDb;
  let service: ProjectAccessService;

  beforeEach(() => {
    db = new FakeProjectAccessDb();
    service = new ProjectAccessService(
      db.members as never,
      db.links as never,
      db.categories as never,
      db.banners as never,
    );
  });

  const expectNotFound = async (promise: Promise<unknown>) => {
    const error = await refusal(promise);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe(PROJECT_NOT_FOUND);
  };

  const expectRoleRefusal = async (promise: Promise<unknown>) => {
    const error = await refusal(promise);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as Error).message).toBe(ROLE_REFUSAL);
  };

  it('answers 404 to someone who is not a member, though other people are', async () => {
    const owner = person();
    const project = db.project(owner.userId);
    db.member(project.id, randomUUID(), 'member');
    await expectNotFound(service.require(person(), project.id, 'project.read'));
  });

  it('answers the same 404 for a project id that does not exist', async () => {
    const me = person();
    db.project(me.userId);
    await expectNotFound(service.require(me, randomUUID(), 'project.read'));
  });

  it.each(['not-a-uuid', '', `${randomUUID()}x`, ' 11111111-1111-1111-1111-111111111111'])(
    'answers 404 for %j without asking the database',
    async (id) => {
      const me = person();
      db.project(me.userId);
      await expectNotFound(service.require(me, id, 'project.read'));
      expect(db.members.calls).toHaveLength(0);
    },
  );

  it('answers 404, not access to every project, when the project id is not a string', async () => {
    const me = person();
    db.project(me.userId);
    for (const id of [undefined, null, 42, ['x'], {}]) {
      await expectNotFound(service.require(me, id as never, 'project.read'));
    }
    expect(db.members.calls).toHaveLength(0);
  });

  it('refuses a caller without a user id rather than matching any member', async () => {
    const project = db.project(randomUUID());
    const error = await refusal(
      service.require({ email: 'x@acme.example', isSuperAdmin: false } as AuthenticatedUser, project.id, 'project.read'),
    );
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(db.members.calls).toHaveLength(0);
  });

  it('does not let membership of one project open another', async () => {
    const me = person();
    const mine = db.project(me.userId);
    const theirs = db.project(randomUUID());
    await expect(service.require(me, mine.id, 'project.read')).resolves.toBeDefined();
    await expectNotFound(service.require(me, theirs.id, 'project.read'));
  });

  it('answers 403 with the role message to a member asking for channels.manage', async () => {
    const project = db.project(randomUUID());
    const me = person();
    db.member(project.id, me.userId, 'member');
    await expectRoleRefusal(service.require(me, project.id, 'channels.manage'));
    const access = await service.require(me, project.id, 'messaging.write');
    expect(access.role).toBe('member');
    expect(access.can('channels.manage')).toBe(false);
  });

  it('answers 403 to an admin asking for privacy', async () => {
    const project = db.project(randomUUID());
    const me = person();
    db.member(project.id, me.userId, 'admin');
    await expectRoleRefusal(service.require(me, project.id, 'privacy'));
    await expectRoleRefusal(service.require(me, project.id, 'project.admin'));
    await expect(service.require(me, project.id, 'channels.manage')).resolves.toMatchObject({ role: 'admin' });
  });

  it('lets an owner use project.admin, and is billing owner only when the project is billed to them', async () => {
    const billing = person();
    const project = db.project(billing.userId);
    const coOwner = person();
    db.member(project.id, coOwner.userId, 'owner');

    const mine = await service.require(billing, project.id, 'project.admin');
    expect(mine).toMatchObject({ role: 'owner', isBillingOwner: true, impersonated: false });
    expect(mine.project.id).toBe(project.id);

    const theirs = await service.require(coOwner, project.id, 'project.admin');
    expect(theirs).toMatchObject({ role: 'owner', isBillingOwner: false, impersonated: false });
  });

  it('hides from view-as a project the person owns but is billed to someone else', async () => {
    const billing = randomUUID();
    const project = db.project(billing);
    const viewed = person(randomUUID(), { impersonatedBy: randomUUID() });
    db.member(project.id, viewed.userId, 'owner');
    await expectNotFound(service.require(viewed, project.id, 'project.read'));
    // The same person signed in themselves still has it.
    await expect(service.require(person(viewed.userId), project.id, 'project.read')).resolves.toMatchObject({
      role: 'owner',
    });
  });

  it('shows view-as the projects billed to the person viewed, marked as impersonated', async () => {
    const viewed = person(randomUUID(), { impersonatedBy: randomUUID() });
    const project = db.project(viewed.userId);
    const access = await service.require(viewed, project.id, 'project.read');
    expect(access).toMatchObject({ role: 'owner', isBillingOwner: true, impersonated: true });
  });
});

describe('ProjectAccessService.projectIdOf', () => {
  let db: FakeProjectAccessDb;
  let service: ProjectAccessService;

  beforeEach(() => {
    db = new FakeProjectAccessDb();
    service = new ProjectAccessService(
      db.members as never,
      db.links as never,
      db.categories as never,
      db.banners as never,
    );
  });

  it('finds the project of a link, a banner category and a banner', async () => {
    const project = db.project(randomUUID());
    const other = db.project(randomUUID());
    db.link(other.id);
    const link = db.link(project.id);
    db.category(other.id);
    const category = db.category(project.id);
    const banner = db.banner(category);
    expect(await service.projectIdOf('link', link)).toBe(project.id);
    expect(await service.projectIdOf('bannerCategory', category)).toBe(project.id);
    expect(await service.projectIdOf('banner', banner)).toBe(project.id);
  });

  it('answers null for a missing resource, and asks nothing for an id that is not a uuid', async () => {
    expect(await service.projectIdOf('link', randomUUID())).toBeNull();
    expect(await service.projectIdOf('bannerCategory', randomUUID())).toBeNull();
    expect(await service.projectIdOf('banner', randomUUID())).toBeNull();
    for (const id of ['abc', undefined, 42, ['x']]) {
      expect(await service.projectIdOf('link', id as never)).toBeNull();
    }
    expect(db.links.calls).toHaveLength(1);
  });
});

describe('ProjectAccessService.memberProjectsQuery', () => {
  const service = new ProjectAccessService({} as never, {} as never, {} as never, {} as never);

  it('selects the member rows of the caller, by a parameter rather than in the text', () => {
    const userId = randomUUID();
    const q = service.memberProjectsQuery(person(userId));
    expect(q.sql).not.toContain(userId);
    expect(Object.values(q.params)).toEqual([userId]);
    expect(q.sql).toMatch(/project_members/);
    expect(q.sql).not.toMatch(/owner_id/);
  });

  it('keeps view-as to projects billed to the person viewed', () => {
    const userId = randomUUID();
    const q = service.memberProjectsQuery(person(userId, { impersonatedBy: randomUUID() }));
    expect(q.sql).toMatch(/owner_id/);
    expect(Object.values(q.params)).toEqual([userId]);
  });

  it('refuses a caller without a user id', () => {
    expect(() => service.memberProjectsQuery({} as AuthenticatedUser)).toThrow(UnauthorizedException);
  });
});

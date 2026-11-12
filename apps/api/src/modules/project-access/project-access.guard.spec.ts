import 'reflect-metadata';
import { randomUUID } from 'crypto';
import {
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { FakeProjectAccessDb } from '../../test-support/fake-project-access-db';
import { ProjectAccessGuard } from './project-access.guard';
import { ProjectAccessService } from './project-access.service';
import { projectAccessFromRequest } from './project-access.decorator';
import { PROJECT_PERMISSION_KEY, RequireProjectPermission } from './require-project-permission.decorator';
import { PROJECT_NOT_FOUND, ROLE_REFUSAL } from './project-permissions';

/** Handlers declared the ways real controllers will declare them. */
class Routes {
  @RequireProjectPermission('project.read')
  byParam() {}

  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  byBody() {}

  @RequireProjectPermission('project.read', { query: 'projectId' })
  byQuery() {}

  @RequireProjectPermission('project.read', { param: 'id' })
  byIdParam() {}

  @RequireProjectPermission('messaging.write', { resource: 'link', param: 'id' })
  byLink() {}

  @RequireProjectPermission('messaging.write', { resource: 'bannerCategory', param: 'categoryId' })
  byCategory() {}

  @RequireProjectPermission('messaging.write', { resource: 'banner', param: 'id' })
  byBanner() {}

  @RequireProjectPermission('channels.manage')
  channels() {}

  undeclared() {}
}

/** The method-level guard order, written as the decorator's comment says and the wrong way round. */
class GuardOrder {
  @RequireProjectPermission('project.read')
  @UseGuards(JwtAuthGuard)
  recommended() {}

  @UseGuards(JwtAuthGuard)
  @RequireProjectPermission('project.read')
  reversed() {}
}

interface FakeRequest {
  user?: AuthenticatedUser;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body?: unknown;
  projectAccess?: unknown;
}

const person = (userId: string = randomUUID()): AuthenticatedUser => ({
  userId,
  email: `${userId}@acme.example`,
  isSuperAdmin: false,
});

describe('ProjectAccessGuard', () => {
  let db: FakeProjectAccessDb;
  let guard: ProjectAccessGuard;
  let me: AuthenticatedUser;
  let mine: { id: string };

  beforeEach(() => {
    db = new FakeProjectAccessDb();
    const service = new ProjectAccessService(
      db.members as never,
      db.links as never,
      db.categories as never,
      db.banners as never,
    );
    guard = new ProjectAccessGuard(new Reflector(), service);
    me = person();
    mine = db.project(me.userId);
  });

  const context = (handler: keyof Routes, req: FakeRequest): ExecutionContext =>
    ({
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  const request = (part: Partial<FakeRequest>): FakeRequest => ({ user: me, params: {}, query: {}, ...part });

  const run = (handler: keyof Routes, req: FakeRequest) =>
    Promise.resolve()
      .then(() => guard.canActivate(context(handler, req)))
      .then(
        (ok) => ({ ok, error: null as unknown }),
        (error: unknown) => ({ ok: false, error }),
      );

  const expectNotFound = async (handler: keyof Routes, req: FakeRequest) => {
    const { error } = await run(handler, req);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe(PROJECT_NOT_FOUND);
    expect(req.projectAccess).toBeUndefined();
  };

  it('declares its metadata and puts itself on the route', () => {
    expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, Routes.prototype.byLink)).toEqual({
      permission: 'messaging.write',
      from: { resource: 'link', param: 'id' },
    });
    expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, Routes.prototype.byParam)).toEqual({
      permission: 'project.read',
      from: { param: 'projectId' },
    });
    expect(Reflect.getMetadata(GUARDS_METADATA, Routes.prototype.byParam)).toEqual([ProjectAccessGuard]);
  });

  it('runs JwtAuthGuard first when it is written below the decorator, and last when above', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, GuardOrder.prototype.recommended)).toEqual([
      JwtAuthGuard,
      ProjectAccessGuard,
    ]);
    // The trap: above the decorator it runs after this guard, so every request is a 401.
    expect(Reflect.getMetadata(GUARDS_METADATA, GuardOrder.prototype.reversed)).toEqual([
      ProjectAccessGuard,
      JwtAuthGuard,
    ]);
  });

  it('lets a member in by the path project id and leaves the access on the request', async () => {
    const req = request({ params: { projectId: mine.id } });
    const { ok, error } = await run('byParam', req);
    expect(error).toBeNull();
    expect(ok).toBe(true);
    expect(req.projectAccess).toMatchObject({ role: 'owner', isBillingOwner: true });
    expect(projectAccessFromRequest(req as never)).toBe(req.projectAccess);
  });

  it('reads the project id from the body, the query or a param of another name', async () => {
    const body = request({ body: { projectId: mine.id, title: 'Hello' } });
    expect((await run('byBody', body)).ok).toBe(true);
    expect(body.projectAccess).toMatchObject({ project: expect.objectContaining({ id: mine.id }) });

    const query = request({ query: { projectId: mine.id } });
    expect((await run('byQuery', query)).ok).toBe(true);

    const byId = request({ params: { id: mine.id } });
    expect((await run('byIdParam', byId)).ok).toBe(true);
  });

  it.each([[['x']], [42], [{}], ['abc'], [null], [true], [[randomUUID()]]])(
    'answers 404, not a TypeError, to a body project id of %j',
    async (projectId) => {
      await expectNotFound('byBody', request({ body: { projectId } }));
    },
  );

  it('answers 404 when the body has no project id or is not an object', async () => {
    for (const body of [undefined, null, {}, 'projectId', [mine.id], 7]) {
      await expectNotFound('byBody', request({ body }));
    }
  });

  it('answers 404 to a query project id given twice', async () => {
    await expectNotFound('byQuery', request({ query: { projectId: [mine.id, mine.id] } }));
  });

  it('checks a body project id that differs from the path one', async () => {
    const theirs = db.project(randomUUID());
    await expectNotFound('byParam', request({ params: { projectId: mine.id }, body: { projectId: theirs.id } }));
    await expectNotFound('byParam', request({ params: { projectId: mine.id }, query: { projectId: theirs.id } }));
    const before = db.members.calls.length;
    await expectNotFound('byParam', request({ params: { projectId: mine.id }, body: { projectId: 'abc' } }));
    // Every id is checked for shape before any of them is looked up.
    expect(db.members.calls).toHaveLength(before);
    // The same id twice is one project, and allowed.
    const same = request({ params: { projectId: mine.id }, body: { projectId: mine.id } });
    expect((await run('byParam', same)).ok).toBe(true);
  });

  it('checks the other project with the same permission', async () => {
    const other = db.project(randomUUID());
    db.member(other.id, me.userId, 'member');
    const { error } = await run('channels', request({ params: { projectId: mine.id }, body: { projectId: other.id } }));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as Error).message).toBe(ROLE_REFUSAL);
  });

  it('checks a path project id next to a resource of another project', async () => {
    const theirs = db.project(randomUUID());
    const link = db.link(mine.id);
    await expectNotFound('byLink', request({ params: { id: link, projectId: theirs.id } }));
  });

  it('answers 401 without a signed-in user, so a guard listed in the wrong order fails loudly', async () => {
    const { error } = await run('byParam', { params: { projectId: mine.id }, query: {} });
    expect(error).toBeInstanceOf(UnauthorizedException);
    // Refused by the guard itself, before any lookup (a resource route would look one up first).
    const link = await run('byLink', { params: { id: db.link(mine.id) }, query: {} });
    expect(link.error).toBeInstanceOf(UnauthorizedException);
    expect(db.links.calls).toHaveLength(0);
    expect(db.members.calls).toHaveLength(0);
  });

  it('resolves a link to its project, and answers 404 for a link that does not exist', async () => {
    const link = db.link(mine.id);
    const req = request({ params: { id: link } });
    expect((await run('byLink', req)).ok).toBe(true);
    expect(req.projectAccess).toMatchObject({ project: expect.objectContaining({ id: mine.id }) });

    await expectNotFound('byLink', request({ params: { id: randomUUID() } }));
    await expectNotFound('byLink', request({ params: { id: 'abc' } }));
  });

  it('answers 404 for a link, category or banner in a project the caller is not in', async () => {
    const theirs = db.project(randomUUID());
    const category = db.category(theirs.id);
    await expectNotFound('byLink', request({ params: { id: db.link(theirs.id) } }));
    await expectNotFound('byCategory', request({ params: { categoryId: category } }));
    await expectNotFound('byBanner', request({ params: { id: db.banner(category) } }));
  });

  it('resolves a banner through its category', async () => {
    const category = db.category(mine.id);
    const req = request({ params: { id: db.banner(category) } });
    expect((await run('byBanner', req)).ok).toBe(true);
    const byCategory = request({ params: { categoryId: category } });
    expect((await run('byCategory', byCategory)).ok).toBe(true);
  });

  it('fails closed on a route that names no permission', async () => {
    const { error } = await run('undeclared', request({ params: { projectId: mine.id } }));
    expect(error).toBeInstanceOf(InternalServerErrorException);
  });
});

describe('projectAccessFromRequest', () => {
  it('is a 500 when the guard did not run', () => {
    expect(() => projectAccessFromRequest({})).toThrow(InternalServerErrorException);
  });
});

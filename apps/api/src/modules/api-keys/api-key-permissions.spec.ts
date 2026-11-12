import 'reflect-metadata';
import { BadRequestException, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { DEFAULT_API_KEY_PERMISSIONS, isServerOnlyKey, permissionsForNewKey } from './api-key-permissions';
import { ApiKeyGuard, SERVER_ONLY_KEY_MESSAGE } from './guards/api-key.guard';
import {
  API_KEY_PERMISSION_METADATA,
  RequireApiKeyPermission,
  ServerApiKeyGuard,
} from './guards/server-api-key.guard';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { ROLE_REFUSAL, roleCan, type ProjectRole } from '../project-access/project-permissions';

/** A request as Express hands it over, for the activity log's address and agent. */
const REQ = { headers: {}, ip: '127.0.0.1' } as never;

/**
 * API keys ship inside client apps, so anything a key without `privacy` can
 * reach, anyone who unpacks an app can reach. These are the rules that keep
 * erase and export out of that set.
 */
describe('API key permissions', () => {
  describe('on create', () => {
    it('never grants privacy by default', () => {
      expect(permissionsForNewKey(undefined)).toEqual(['read', 'write']);
      expect(DEFAULT_API_KEY_PERMISSIONS).not.toContain('privacy');
    });

    it('makes a privacy key only when asked, and only alone', () => {
      expect(permissionsForNewKey(['privacy'])).toEqual(['privacy']);
      expect(() => permissionsForNewKey(['privacy', 'read'])).toThrow(BadRequestException);
      expect(() => permissionsForNewKey(['write', 'privacy'])).toThrow(BadRequestException);
      expect(permissionsForNewKey(['privacy', 'privacy'])).toEqual(['privacy']);
    });

    it('stores what the service computed, not the raw request', async () => {
      const create = jest.fn((entity) => entity);
      const save = jest.fn(async (entity) => ({ id: 'k', ...entity }));
      const repo = { create, save, manager: { transaction: (work: (m: unknown) => unknown) => work({ getRepository: () => repo }) } };
      const service = new ApiKeysService(repo as never, { record: jest.fn() } as never);
      const ctx = { ipAddress: null, userAgent: null };
      await service.create('p', { name: 'server', permissions: ['privacy'] }, 'u', ctx);
      expect(create.mock.calls[0][0].permissions).toEqual(['privacy']);
      await expect(service.create('p', { name: 'mixed', permissions: ['read', 'privacy'] }, 'u', ctx)).rejects.toThrow(
        BadRequestException,
      );
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('refuses an unknown permission in the DTO', async () => {
      const dto = (permissions: unknown) => plainToInstance(CreateApiKeyDto, { name: 'k', permissions });
      expect(await validate(dto(['read', 'write']))).toEqual([]);
      expect(await validate(dto(['privacy']))).toEqual([]);
      const errors = await validate(dto(['admin']));
      expect(errors.map((e) => e.property)).toEqual(['permissions']);
      expect(JSON.stringify(errors[0].constraints)).toContain('privacy');
      expect((await validate(dto(['read', 'write', 'privacy', 'read']))).length).toBe(1);
    });
  });

  const contextFor = (request: Record<string, unknown>, handler: () => void = () => undefined, cls: unknown = class {}) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => cls,
    }) as unknown as ExecutionContext;

  const NO_TRAPS = { checkApiKeyLater: () => undefined } as never;
  const keysReturning = (key: unknown) => ({ validateKey: jest.fn(async () => key) }) as unknown as ApiKeysService;
  const sdkKey = { id: 'k1', projectId: 'p1', permissions: ['read', 'write'] };
  const privacyKey = { id: 'k2', projectId: 'p1', permissions: ['privacy'] };

  describe('SDK routes (ApiKeyGuard)', () => {
    it('accepts an ordinary key and pins the request to its project', async () => {
      const request: Record<string, unknown> = { headers: { 'x-api-key': 'raw' } };
      await expect(new ApiKeyGuard(keysReturning(sdkKey), NO_TRAPS).canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.projectId).toBe('p1');
    });

    it('accepts older keys with no permissions stored', async () => {
      const request = { headers: { 'x-api-key': 'raw' } };
      const legacy = { ...sdkKey, permissions: null };
      await expect(new ApiKeyGuard(keysReturning(legacy), NO_TRAPS).canActivate(contextFor(request))).resolves.toBe(true);
    });

    it('refuses a server-only privacy key, so shipping one in an app fails at once', async () => {
      const request = { headers: { 'x-api-key': 'raw' } };
      const guard = new ApiKeyGuard(keysReturning(privacyKey), NO_TRAPS);
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(SERVER_ONLY_KEY_MESSAGE);
      expect(isServerOnlyKey(['privacy'])).toBe(true);
      expect(isServerOnlyKey(null)).toBe(false);
    });
  });

  describe('server routes (ServerApiKeyGuard)', () => {
    class Routes {
      @RequireApiKeyPermission('privacy')
      erase() {}
      undecorated() {}
    }
    const erase = Routes.prototype.erase;

    const guardFor = (key: unknown) => new ServerApiKeyGuard(keysReturning(key), new Reflector(), NO_TRAPS);

    it('lets a privacy key through and pins the request to its project', async () => {
      const request: Record<string, unknown> = { headers: { 'x-api-key': 'raw' } };
      await expect(guardFor(privacyKey).canActivate(contextFor(request, erase, Routes))).resolves.toBe(true);
      expect(request.projectId).toBe('p1');
      expect((request.apiKey as { id: string }).id).toBe('k2');
    });

    it('refuses the ordinary keys that ship inside apps', async () => {
      for (const key of [sdkKey, { ...sdkKey, permissions: null }, { ...sdkKey, permissions: [] }]) {
        const request = { headers: { 'x-api-key': 'raw' } };
        await expect(guardFor(key).canActivate(contextFor(request, erase, Routes))).rejects.toThrow(
          ForbiddenException,
        );
      }
    });

    it('refuses a missing, unknown or revoked key', async () => {
      await expect(
        guardFor(privacyKey).canActivate(contextFor({ headers: {} }, erase, Routes)),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        guardFor(null).canActivate(contextFor({ headers: { 'x-api-key': 'raw' } }, erase, Routes)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('fails closed on a route that forgot to say which permission it needs', async () => {
      const service = keysReturning(privacyKey);
      const guard = new ServerApiKeyGuard(service, new Reflector(), NO_TRAPS);
      await expect(
        guard.canActivate(contextFor({ headers: { 'x-api-key': 'raw' } }, Routes.prototype.undecorated, Routes)),
      ).rejects.toThrow(ForbiddenException);
      expect(service.validateKey).not.toHaveBeenCalled();
      expect(Reflect.getMetadata(API_KEY_PERMISSION_METADATA, erase)).toBe('privacy');
    });
  });
});

describe('Creating a privacy key', () => {
  const PROJECT = '11111111-1111-1111-1111-111111111111';
  const now = () => Math.floor(Date.now() / 1000);
  const signedIn = (userId: string, authAgoSeconds: number | undefined): AuthenticatedUser =>
    ({
      userId,
      email: `${userId}@x.test`,
      isSuperAdmin: false,
      authTime: authAgoSeconds === undefined ? undefined : now() - authAgoSeconds,
    }) as AuthenticatedUser;
  const owner = (authAgoSeconds: number | undefined) => signedIn('owner-1', authAgoSeconds);
  const access = (role: ProjectRole): ProjectAccess => ({
    project: { id: PROJECT, name: 'Shop', ownerId: 'owner-1' } as never,
    role,
    isBillingOwner: role === 'owner',
    impersonated: false,
    can: (p) => roleCan(role, p),
  });

  function controller() {
    const keys = {
      create: jest.fn(async (_p: string, dto: { name: string }) => ({
        apiKey: { id: 'k', name: dto.name, keyHash: 'h' },
        fullKey: 'chumbaq_x',
      })),
    };
    const background: Array<() => Promise<void>> = [];
    const notices = {
      inBackground: jest.fn((work: () => Promise<void>) => background.push(work)),
      privacyKeyCreated: jest.fn(async (_user: { email: string }, _key: unknown, _project: unknown) => undefined),
    };
    // project_members rows joined to their users, as the repository returns them. Two
    // owner rows, so a notice that went only to owner_id would be caught.
    const rows = [
      { projectId: PROJECT, role: 'owner', user: { id: 'owner-1', email: 'o@x.test', name: 'Owner' } },
      { projectId: PROJECT, role: 'owner', user: { id: 'owner-2', email: 'o2@x.test', name: 'Co-owner' } },
      { projectId: PROJECT, role: 'admin', user: { id: 'admin-1', email: 'a@x.test', name: 'Admin' } },
      { projectId: 'other', role: 'owner', user: { id: 'owner-9', email: 'o9@x.test', name: 'Elsewhere' } },
    ];
    const members = {
      find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v)),
      ),
    };
    const c = new ApiKeysController(keys as never, notices as never, members as never);
    return { c, keys, notices, background, members };
  }

  it('needs a sign-in within 15 minutes, and creates nothing without one', async () => {
    const { c, keys } = controller();
    for (const user of [owner(16 * 60), owner(undefined), { ...owner(10), impersonatedBy: 'staff' }]) {
      await expect(
        c.create(PROJECT, user as AuthenticatedUser, { name: 's', permissions: ['privacy'] }, access('owner'), REQ),
      ).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
    }
    expect(keys.create).not.toHaveBeenCalled();
    await expect(
      c.create(PROJECT, owner(60), { name: 's', permissions: ['privacy'] }, access('owner'), REQ),
    ).resolves.toMatchObject({ fullKey: 'chumbaq_x' });
  });

  it('is refused to an admin, however recent the sign-in', async () => {
    const { c, keys } = controller();
    for (const user of [signedIn('admin-1', 60), signedIn('admin-1', 16 * 60)]) {
      const attempt = c.create(PROJECT, user, { name: 's', permissions: ['privacy'] }, access('admin'), REQ);
      await expect(attempt).rejects.toThrow(ForbiddenException);
      await expect(
        c.create(PROJECT, user, { name: 's', permissions: ['privacy'] }, access('admin'), REQ),
      ).rejects.toThrow(ROLE_REFUSAL);
    }
    expect(keys.create).not.toHaveBeenCalled();
  });

  it('does not ask again for an ordinary key, which an admin may make', async () => {
    const { c, notices } = controller();
    await expect(c.create(PROJECT, owner(undefined), { name: 'app' }, access('owner'), REQ)).resolves.toMatchObject({
      fullKey: 'chumbaq_x',
    });
    await expect(
      c.create(PROJECT, signedIn('admin-1', undefined), { name: 'app' }, access('admin'), REQ),
    ).resolves.toMatchObject({ fullKey: 'chumbaq_x' });
    expect(notices.inBackground).not.toHaveBeenCalled();
  });

  it('emails every owner of the project in the background, without the key', async () => {
    const { c, notices, background, members } = controller();
    const response = await c.create(PROJECT, owner(60), { name: 'server', permissions: ['privacy'] }, access('owner'), REQ);
    expect(response.apiKey).not.toHaveProperty('keyHash');
    expect(background).toHaveLength(1);
    await background[0]();
    expect(members.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: PROJECT, role: 'owner' } }),
    );
    expect(notices.privacyKeyCreated.mock.calls.map(([user]) => user.email).sort()).toEqual([
      'o2@x.test',
      'o@x.test',
    ]);
    for (const call of notices.privacyKeyCreated.mock.calls) {
      expect(call.slice(1)).toEqual([{ name: 'server' }, { id: PROJECT, name: 'Shop' }]);
    }
    expect(JSON.stringify(notices.privacyKeyCreated.mock.calls)).not.toContain('chumbaq_x');
  });
});

describe('ApiKeysController route permissions', () => {
  const param = { param: 'projectId' };
  const table: Array<[string, string, object]> = [
    ['create', 'keys.manage', param],
    ['findAll', 'keys.manage', param],
    ['revoke', 'keys.manage', param],
  ];
  const handlers = Object.getOwnPropertyNames(ApiKeysController.prototype).filter((n) => n !== 'constructor');

  it.each(table)('%s needs %s', (handler, permission, from) => {
    const fn = (ApiKeysController.prototype as unknown as Record<string, object>)[handler];
    expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, fn)).toEqual({ permission, from });
  });

  it('has a row for every handler', () => {
    expect(handlers.sort()).toEqual(table.map(([h]) => h).sort());
  });
});

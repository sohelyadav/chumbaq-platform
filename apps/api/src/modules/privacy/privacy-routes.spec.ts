import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RecentAuthGuard } from '../auth/guards/recent-auth.guard';
import { ProjectAccessGuard } from '../project-access/project-access.guard';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  API_KEY_PERMISSION_METADATA,
  ServerApiKeyGuard,
} from '../api-keys/guards/server-api-key.guard';
import { PrivacyRequestDto, PrivacyRequestSearchDto, subjectFromRequest } from './dto/privacy-request.dto';
import { IMPERSONATION_READ_ONLY, PersonPrivacyController } from './person-privacy.controller';
import { PrivacyApiController } from './privacy-api.controller';

const PROJECT = '11111111-1111-1111-1111-111111111111';
const PERSON = 'a1111111-0000-0000-0000-000000000001';
const owner = { userId: 'owner-1', email: 'o@x.test', isSuperAdmin: false } as AuthenticatedUser;
const staffViewingAs = { ...owner, impersonatedBy: 'staff-1' } as AuthenticatedUser;
/** A request from loopback with a user agent; the activity context comes from it. */
const CTX = { headers: { 'user-agent': 'routes-spec' }, ip: '127.0.0.1', socket: {} } as never;

function dashboard() {
  const erasure = { erase: jest.fn(async () => ({ result: 'erased' })) };
  const exporter = { export: jest.fn(async () => ({ sections: {} })) };
  const requests = { list: jest.fn(async () => []) };
  const controller = new PersonPrivacyController(
    erasure as never,
    exporter as never,
    requests as never,
    { exported: jest.fn() } as never,
  );
  return { controller, erasure, exporter, requests };
}

describe('Dashboard privacy routes', () => {
  it('need a session; erasure also needs a recent sign-in', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PersonPrivacyController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, PersonPrivacyController.prototype.erase)).toEqual([ProjectAccessGuard, RecentAuthGuard]);
  });

  it('erase and export act as the signed-in user', async () => {
    const { controller, erasure, exporter } = dashboard();
    await controller.erase(PROJECT, PERSON, owner, CTX);
    await controller.export(PROJECT, PERSON, owner, CTX);
    const context = { ipAddress: '127.0.0.1', userAgent: 'routes-spec' };
    expect(erasure.erase).toHaveBeenCalledWith(PROJECT, { type: 'personId', value: PERSON }, { type: 'user', id: 'owner-1' }, context);
    expect(exporter.export).toHaveBeenCalledWith(PROJECT, { type: 'personId', value: PERSON }, { type: 'user', id: 'owner-1' }, context);
  });

  it('refuse staff viewing as the tenant, for export as well as erasure', async () => {
    const { controller, erasure, exporter } = dashboard();
    await expect(controller.erase(PROJECT, PERSON, staffViewingAs, CTX)).rejects.toThrow(IMPERSONATION_READ_ONLY);
    await expect(controller.export(PROJECT, PERSON, staffViewingAs, CTX)).rejects.toThrow(IMPERSONATION_READ_ONLY);
    expect(erasure.erase).not.toHaveBeenCalled();
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it('a view-as token never reaches the DELETE handler at all', async () => {
    // JwtStrategy refuses every write made with an impersonation token, the
    // first line before the controller's own check.
    const staff = { id: 'staff-1', isSuperAdmin: true, suspendedAt: null, sessionVersion: 0 };
    const tenant = { id: 'owner-1', isSuperAdmin: false, suspendedAt: null, sessionVersion: 0 };
    const users = { findById: jest.fn(async (id: string) => (id === 'staff-1' ? staff : tenant)) };
    const config = { get: () => 'secret' } as unknown as ConfigService;
    const strategy = new JwtStrategy(config, users as never, { isLive: jest.fn() } as never, {
      isUsable: async () => true,
    } as never);
    const payload = {
      sub: 'owner-1',
      email: 'o@x.test',
      type: 'access' as const,
      imp: 'staff-1',
      sv: 0,
      impSv: 0,
      impSid: 'staff-session-1',
    };
    await expect(strategy.validate({ method: 'DELETE' } as never, payload)).rejects.toThrow(IMPERSONATION_READ_ONLY);
    await expect(strategy.validate({ method: 'GET' } as never, payload)).resolves.toMatchObject({ impersonatedBy: 'staff-1' });
  });

  it('every route needs the privacy permission on the path project', () => {
    for (const handler of ['erase', 'export', 'list', 'search'] as const) {
      expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, PersonPrivacyController.prototype[handler])).toEqual({
        permission: 'privacy',
        from: { param: 'projectId' },
      });
    }
  });

  it('looking a user up is a POST with the id in the body', async () => {
    const { controller, requests } = dashboard();
    await controller.list(PROJECT);
    expect(requests.list).toHaveBeenCalledWith(PROJECT);
    await controller.search(PROJECT, { externalUserId: 'user-42', limit: 20 });
    expect(requests.list).toHaveBeenLastCalledWith(PROJECT, { externalUserId: 'user-42', limit: 20 });
    // No query-string variant exists any more.
    const listArgs = Object.keys(Reflect.getMetadata(ROUTE_ARGS_METADATA, PersonPrivacyController, 'list') ?? {});
    expect(listArgs.length).toBeGreaterThan(0);
    expect(listArgs.filter((key) => key.startsWith(`${RouteParamtypes.QUERY}:`))).toEqual([]);
    expect(Reflect.getMetadata(METHOD_METADATA, PersonPrivacyController.prototype.search)).toBe(RequestMethod.POST);
  });
});

describe('Server privacy API', () => {
  it('is guarded by a key with the privacy permission', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PrivacyApiController)).toEqual([ServerApiKeyGuard]);
    expect(Reflect.getMetadata(API_KEY_PERMISSION_METADATA, PrivacyApiController)).toBe('privacy');
  });

  it('acts on the key\'s own project, whatever the body says', async () => {
    const erasure = { erase: jest.fn(async () => ({})) };
    const exporter = { export: jest.fn(async () => ({ sections: {} })) };
    const controller = new PrivacyApiController(erasure as never, exporter as never, { exported: jest.fn() } as never);
    const request = {
      apiKey: { id: 'key-1', name: 'Backend', projectId: PROJECT },
      headers: { 'user-agent': 'backend/1' },
      ip: '127.0.0.1',
      socket: {},
    } as never;
    await controller.erase({ externalUserId: 'user-42' }, request);
    await controller.export({ deviceFingerprint: 'fp-1' }, request);
    // The key's name is for the activity log's label; the project is still the key's own.
    const key = { type: 'api_key', id: 'key-1', name: 'Backend' };
    const context = { ipAddress: '127.0.0.1', userAgent: 'backend/1' };
    expect(erasure.erase).toHaveBeenCalledWith(PROJECT, { type: 'externalUserId', value: 'user-42' }, key, context);
    expect(exporter.export).toHaveBeenCalledWith(PROJECT, { type: 'deviceFingerprint', value: 'fp-1' }, key, context);
  });

  it('counts a server-key export toward the bulk export alarm, per key', async () => {
    const section = (n: number) => ({ total: n, truncated: false, rows: Array.from({ length: n }, () => ({})) });
    const exporter = { export: jest.fn(async () => ({ sections: { events: section(3), devices: section(1) } })) };
    const volume = { exported: jest.fn() };
    const controller = new PrivacyApiController({} as never, exporter as never, volume as never);
    const request = {
      apiKey: { id: 'key-1', name: 'Backend', projectId: PROJECT },
      headers: {},
      ip: '127.0.0.1',
      socket: {},
    } as never;
    await controller.export({ externalUserId: 'user-42' }, request);
    expect(volume.exported).toHaveBeenCalledWith('api_key:key-1', PROJECT, 4, 'privacy API export');
  });

  it('needs exactly one identifier', () => {
    expect(() => subjectFromRequest({})).toThrow(BadRequestException);
    expect(() => subjectFromRequest({ externalUserId: 'u', deviceFingerprint: 'f' })).toThrow(BadRequestException);
  });

  /** Through the app's own pipe, so the options under test are the ones that run. */
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const refused = async (metatype: new () => object, body: Record<string, unknown>): Promise<string> => {
    try {
      await pipe.transform(body, { type: 'body', metatype });
      return '';
    } catch (error) {
      return JSON.stringify((error as { response?: unknown }).response);
    }
  };

  it('validates each identifier and refuses anything else in the body', async () => {
    expect(await refused(PrivacyRequestDto, { externalUserId: 'user-42' })).toBe('');
    expect(await refused(PrivacyRequestDto, { deviceFingerprint: 'fp-1' })).toBe('');
    for (const field of ['externalUserId', 'deviceFingerprint']) {
      expect(await refused(PrivacyRequestDto, { [field]: '' })).toContain(field);
      expect(await refused(PrivacyRequestDto, { [field]: 'a\nb' })).toContain(`${field} must not contain control characters`);
      // 255 is fine, 256 is not: the length rule itself, not a stricter one.
      expect(await refused(PrivacyRequestDto, { [field]: 'x'.repeat(255) })).toBe('');
      expect(await refused(PrivacyRequestDto, { [field]: 'x'.repeat(256) })).toContain('255');
    }
    // A body cannot name a project: the key decides it.
    expect(await refused(PrivacyRequestDto, { externalUserId: 'user-42', projectId: PROJECT })).toContain(
      'property projectId should not exist',
    );
  });

  it('validates the request-log search body the same way', async () => {
    expect(await refused(PrivacyRequestSearchDto, { externalUserId: 'user-42', limit: 5 })).toBe('');
    expect(await refused(PrivacyRequestSearchDto, { externalUserId: 'a\u0007b' })).toContain('control characters');
    expect(await refused(PrivacyRequestSearchDto, { limit: 101 })).toContain('limit');
  });
});

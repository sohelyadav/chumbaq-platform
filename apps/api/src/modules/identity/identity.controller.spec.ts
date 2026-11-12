import 'reflect-metadata';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IdentityController } from './identity.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RecentAuthGuard } from '../auth/guards/recent-auth.guard';
import { ProjectAccessGuard } from '../project-access/project-access.guard';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import { VIEW_AS_NOT_AVAILABLE } from '../project-access/view-as';

/**
 * Person-level do-not-track: `privacy` permission (owner role), never in view-as, and a recent
 * sign-in to lift. What the actions do is proved in consent.int-spec.ts.
 */
describe('IdentityController person objections', () => {
  const personObjections = {
    preview: jest.fn(async () => ({ objecting: false })),
    object: jest.fn(async () => ({ objecting: true })),
    lift: jest.fn(async () => ({ objecting: false })),
  };
  const controller = new IdentityController({} as never, personObjections as never);
  const owner = { userId: 'u1', email: 'o@x', isSuperAdmin: false, sessionVersion: 0 } as never;
  const viewAs = { userId: 'u1', email: 'o@x', isSuperAdmin: false, sessionVersion: 0, impersonatedBy: 'staff' } as never;

  const REQ = { headers: { 'user-agent': 'identity-spec' }, ip: '127.0.0.1', socket: {} } as never;

  beforeEach(() => jest.clearAllMocks());

  it('objects with the actor and source row as provenance', async () => {
    await controller.createPersonObjection('p1', owner, { externalUserId: 'asha', sourceIdentityId: 'row-1' }, REQ);
    expect(personObjections.object).toHaveBeenCalledWith(
      'p1',
      'asha',
      { userId: 'u1', sourceIdentityId: 'row-1' },
      { userId: 'u1', context: { ipAddress: '127.0.0.1', userAgent: 'identity-spec' } },
    );
  });

  it('refuses a view-as session for both actions', async () => {
    await expect(controller.createPersonObjection('p1', viewAs, { externalUserId: 'asha' }, REQ)).rejects.toThrow(VIEW_AS_NOT_AVAILABLE);
    await expect(controller.liftPersonObjection('p1', viewAs, { externalUserId: 'asha' }, REQ)).rejects.toThrow(VIEW_AS_NOT_AVAILABLE);
    expect(personObjections.object).not.toHaveBeenCalled();
    expect(personObjections.lift).not.toHaveBeenCalled();
  });

  it('needs a recent sign-in to lift, after the JWT guard and the project permission guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, IdentityController.prototype.liftPersonObjection);
    expect(guards).toEqual([JwtAuthGuard, ProjectAccessGuard, RecentAuthGuard]);
  });
});

// The two dashboard lookups once took an optional project (or none), so any
// signed-in account could read another tenant's people. The permission guard
// checks membership; the handlers must still bind the query to the path project.
describe('IdentityController dashboard lookups', () => {
  const identityService = {
    getDevicesByUser: jest.fn(),
    findByFingerprintAndProject: jest.fn(),
  };
  const controller = new IdentityController(identityService as never, {} as never);

  beforeEach(() => jest.clearAllMocks());

  it('reads devices only within the project in the path', async () => {
    identityService.getDevicesByUser.mockResolvedValueOnce([]);
    await controller.getDevices('proj-1', 'ext-1');
    expect(identityService.getDevicesByUser).toHaveBeenCalledWith('ext-1', 'proj-1');
  });

  it('needs a user id to look up', async () => {
    await expect(controller.getDevices('proj-1', '')).rejects.toBeInstanceOf(BadRequestException);
    expect(identityService.getDevicesByUser).not.toHaveBeenCalled();
  });

  it('looks a fingerprint up only within the project in the path, 404 when absent', async () => {
    identityService.findByFingerprintAndProject.mockResolvedValueOnce(null);
    await expect(controller.findByFingerprint('proj-1', 'fp-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(identityService.findByFingerprintAndProject).toHaveBeenCalledWith('fp-1', 'proj-1');
  });

  it('keeps both lookups behind the JWT guard and under a project path', () => {
    for (const name of ['getDevices', 'findByFingerprint'] as const) {
      const handler = IdentityController.prototype[name];
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(JwtAuthGuard);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toMatch(/^projects\/:projectId\//);
    }
  });
});

const PROJECT = { param: 'projectId' };
// handler -> permission, source. Identity's SDK routes (ApiKeyGuard) carry none.
const TABLE: Array<[keyof IdentityController, string]> = [
  ['updateConsent', 'messaging.write'],
  ['previewPersonObjection', 'privacy'],
  ['createPersonObjection', 'privacy'],
  ['liftPersonObjection', 'privacy'],
  ['getDevices', 'people.read'],
  ['findByFingerprint', 'people.read'],
];

describe('IdentityController route permissions', () => {
  it.each(TABLE)('%s needs %s', (handler, permission) => {
    const fn = (IdentityController.prototype as unknown as Record<string, object>)[handler as string];
    expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, fn)).toEqual({ permission, from: PROJECT });
    // JwtAuthGuard must run before ProjectAccessGuard.
    const guards = Reflect.getMetadata(GUARDS_METADATA, fn) as unknown[];
    expect(guards.indexOf(JwtAuthGuard)).toBeGreaterThanOrEqual(0);
    expect(guards.indexOf(JwtAuthGuard)).toBeLessThan(guards.indexOf(ProjectAccessGuard));
  });

  it('leaves the SDK routes to their API key', () => {
    for (const name of ['identify', 'linkDevice', 'mergeIdentity', 'trackRevenue']) {
      const fn = (IdentityController.prototype as unknown as Record<string, object>)[name];
      expect(Reflect.hasMetadata(PROJECT_PERMISSION_KEY, fn)).toBe(false);
    }
  });
});

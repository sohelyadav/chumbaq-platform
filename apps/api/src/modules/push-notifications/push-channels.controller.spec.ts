import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { HIDDEN_DURING_IMPERSONATION } from '../../common/impersonation-redaction';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { roleCan, type ProjectRole } from '../project-access/project-permissions';
import { PushNotificationsController } from './push-notifications.controller';

const PROJECT = '9b0c3c4e-5f1a-4f55-9a43-3d2f0d7e8a11';

const access = (role: ProjectRole, impersonated = false): ProjectAccess => ({
  project: { id: PROJECT } as never,
  role,
  isBillingOwner: role === 'owner',
  impersonated,
  can: (p) => roleCan(role, p),
});

/** Every handler a controller declares, so a new one without a row fails the table. */
const handlersOf = (controller: { prototype: object }) =>
  Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor').sort();

const declared = (controller: { prototype: object }, handler: string) =>
  Reflect.getMetadata(
    PROJECT_PERMISSION_KEY,
    (controller.prototype as Record<string, unknown>)[handler] as object,
  );

describe('PushNotificationsController route permissions', () => {
  const param = { param: 'projectId' };
  const body = { body: 'projectId' };
  const table: Array<[string, string, object]> = [
    ['getExperimentReport', 'project.read', param],
    ['getCampaignReport', 'project.read', param],
    ['configure', 'channels.manage', body],
    ['previewAudience', 'messaging.write', body],
    ['testSend', 'messaging.write', body],
    ['updateSettings', 'channels.manage', body],
    ['getReachabilityLosses', 'project.read', param],
    ['configureChannel', 'channels.manage', body],
    ['listChannels', 'project.read', param],
    ['getPersonHistory', 'people.read', param],
    ['getConfigStatus', 'project.read', param],
    ['send', 'messaging.write', body],
    ['sendToUser', 'messaging.write', body],
    ['cancelScheduled', 'messaging.write', param],
    ['getCampaign', 'project.read', param],
    ['getLogs', 'project.read', param],
  ];

  it.each(table)('%s needs %s', (handler, permission, from) => {
    expect(declared(PushNotificationsController, handler)).toEqual({ permission, from });
  });

  it('has a row for every handler', () => {
    expect(handlersOf(PushNotificationsController)).toEqual(table.map(([h]) => h).sort());
  });
});

/**
 * Covers the generic channel-credential endpoints. The rest of this controller
 * is exercised through the service specs; these two carry decisions of their
 * own worth pinning.
 */
describe('PushNotificationsController — channels', () => {
  const channelCredentials = {
    upsert: jest.fn(),
    configuredPushProviders: jest.fn(),
  };
  const miPushProvider = { validateCredentials: jest.fn() };
  const pushAnalytics = { getPersonCampaignHistory: jest.fn().mockResolvedValue([]) };
  const identityService = { findByIds: jest.fn(), findByDistinctId: jest.fn() };
  const channelRegistry = {
    supports: jest.fn((p: string) => p === 'fcm' || p === 'mi_push'),
    supported: jest.fn(() => ['fcm', 'mi_push']),
    get: jest.fn(() => miPushProvider),
  };

  const pushService = { getConfigStatus: jest.fn(), storeChannelCredentials: jest.fn() };
  const REQ = { headers: {}, ip: '127.0.0.1' } as never;

  const controller = new PushNotificationsController(
    pushService as never,
    pushAnalytics as never,
    {} as never,
    channelRegistry as never,
    channelCredentials as never,
    identityService as never,
  );

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      projectId: PROJECT,
      provider: 'mi_push',
      credentials: JSON.stringify({ appSecret: 's', packageName: 'com.x' }),
      ...over,
    }) as never;

  beforeEach(() => jest.clearAllMocks());

  it('validates with the provider that owns the format before storing', async () => {
    await controller.configureChannel(dto(), 'user-1', REQ);

    // Checked at paste time. A key found unusable later means a campaign that
    // reached nobody.
    expect(miPushProvider.validateCredentials).toHaveBeenCalled();
    expect(pushService.storeChannelCredentials).toHaveBeenCalledWith(
      PROJECT,
      'mi_push',
      expect.any(String),
      'user-1',
      { ipAddress: '127.0.0.1', userAgent: null },
    );
  });

  it('stores nothing when the provider rejects the credentials', async () => {
    miPushProvider.validateCredentials.mockRejectedValueOnce(
      new BadRequestException('missing appSecret'),
    );

    await expect(controller.configureChannel(dto(), 'user-1', REQ)).rejects.toThrow();
    expect(pushService.storeChannelCredentials).not.toHaveBeenCalled();
  });

  it('refuses a channel nothing can deliver on', async () => {
    // Credentials that will never be used look identical to credentials that
    // are simply not working, so they are refused rather than stored inert.
    await expect(
      controller.configureChannel(dto({ provider: 'oppo' }), 'user-1', REQ),
    ).rejects.toThrow(BadRequestException);
    expect(pushService.storeChannelCredentials).not.toHaveBeenCalled();
  });

  it('rejects credentials that are not JSON before touching the provider', async () => {
    await expect(
      controller.configureChannel(dto({ credentials: 'not json' }), 'user-1', REQ),
    ).rejects.toThrow(BadRequestException);
    expect(miPushProvider.validateCredentials).not.toHaveBeenCalled();
  });

  it('reports configured channels against what this build supports', async () => {
    channelCredentials.configuredPushProviders.mockResolvedValueOnce(['fcm']);

    const result = await controller.listChannels(PROJECT);

    // Both halves matter: a channel can be supported but unconfigured, and
    // after a downgrade it can be configured but no longer supported.
    expect(result).toEqual({
      configured: ['fcm'],
      supported: ['fcm', 'mi_push'],
    });
  });

  describe('person push history', () => {
    const identity = {
      id: 'dev-1',
      projectId: PROJECT,
      distinctId: 'user-7',
      deviceFingerprint: 'fp-1',
    };

    it('gathers every device the person owns, not just the one asked for', async () => {
      identityService.findByIds.mockResolvedValueOnce([identity]);
      identityService.findByDistinctId.mockResolvedValueOnce([
        { id: 'dev-1' },
        { id: 'dev-2' },
      ]);

      const result = await controller.getPersonHistory(PROJECT, 'dev-1');

      // A person on a phone and a tablet is two identity rows; a campaign
      // delivered to either reached them.
      expect(pushAnalytics.getPersonCampaignHistory).toHaveBeenCalledWith(
        PROJECT,
        ['dev-1', 'dev-2'],
      );
      expect(result.deviceCount).toBe(2);
    });

    it('still reports a history for a device linked to nothing', async () => {
      identityService.findByIds.mockResolvedValueOnce([
        { ...identity, distinctId: null },
      ]);
      identityService.findByDistinctId.mockResolvedValueOnce([]);

      await controller.getPersonHistory(PROJECT, 'dev-1');

      // An anonymous device is still someone.
      expect(pushAnalytics.getPersonCampaignHistory).toHaveBeenCalledWith(
        PROJECT,
        ['dev-1'],
      );
    });

    it('refuses an identity belonging to another project', async () => {
      identityService.findByIds.mockResolvedValueOnce([
        { ...identity, projectId: 'someone-else' },
      ]);

      // Existing is not the same as yours: without the project check an id
      // from another tenant reads back that tenant's push history.
      await expect(
        controller.getPersonHistory(PROJECT, 'dev-1'),
      ).rejects.toThrow(NotFoundException);
      expect(pushAnalytics.getPersonCampaignHistory).not.toHaveBeenCalled();
    });

    it('refuses an identity that does not exist', async () => {
      identityService.findByIds.mockResolvedValueOnce([]);

      await expect(
        controller.getPersonHistory(PROJECT, 'nope'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('config status', () => {
    // Shaped like a stored FCM service account's status.
    const status = () => ({
      configured: true,
      isActive: true,
      firebaseProjectId: 'acme-shop-prod',
      clientEmail: 'firebase-adminsdk-x1y2z@acme-shop-prod.iam.gserviceaccount.com',
      updatedAt: new Date('2026-11-01T10:00:00Z'),
      frequencyCapPerDay: 3,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      maxSendsPerMinute: null,
    });

    it("hides the service account's address from a member", async () => {
      pushService.getConfigStatus.mockResolvedValueOnce(status());
      const result = await controller.getConfigStatus(PROJECT, access('member'));
      expect(result.clientEmail).toBe(HIDDEN_DURING_IMPERSONATION);
      expect(result).toEqual({ ...status(), clientEmail: HIDDEN_DURING_IMPERSONATION });
    });

    it('shows it to an admin and an owner', async () => {
      for (const role of ['admin', 'owner'] as const) {
        pushService.getConfigStatus.mockResolvedValueOnce(status());
        expect(await controller.getConfigStatus(PROJECT, access(role))).toEqual(status());
      }
    });

    it('still hides it from view-as of the owner', async () => {
      pushService.getConfigStatus.mockResolvedValueOnce(status());
      const result = await controller.getConfigStatus(PROJECT, access('owner', true));
      expect(result.clientEmail).toBe(HIDDEN_DURING_IMPERSONATION);
    });
  });
});

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { PushTokensController } from './push-tokens.controller';
import { PushTokensService } from './push-tokens.service';
import { ChannelProviderRegistry } from '../push-notifications/services/channel-provider.registry';
import { RegisterPushTokenDto } from './dto/register-token.dto';

describe('PushTokensController', () => {
  const pushTokensService = {
    registerToken: jest.fn(),
    unregisterToken: jest.fn(),
  };

  // Mirrors a build with FCM only, which is every build today.
  const registry = {
    supports: jest.fn((p: string) => p === 'fcm'),
    supported: jest.fn(() => ['fcm']),
  };

  const controller = new PushTokensController(
    pushTokensService as unknown as PushTokensService,
    registry as unknown as ChannelProviderRegistry,
  );

  const req = { projectId: 'proj-1' } as unknown as Request;

  const dto = (over: Partial<RegisterPushTokenDto> = {}): RegisterPushTokenDto =>
    ({
      projectId: 'proj-1',
      deviceFingerprint: 'fp-1',
      token: 'tok-abc',
      platform: 'android',
      ...over,
    }) as RegisterPushTokenDto;

  beforeEach(() => jest.clearAllMocks());

  it('registers a token on a channel this build can deliver on', async () => {
    await controller.registerToken(dto({ provider: 'fcm' }), req);

    expect(pushTokensService.registerToken).toHaveBeenCalled();
  });

  it('defaults to fcm when no provider is given', async () => {
    await controller.registerToken(dto(), req);

    expect(registry.supports).toHaveBeenCalledWith('fcm');
    expect(pushTokensService.registerToken).toHaveBeenCalled();
  });

  it('refuses a channel nothing can deliver on', async () => {
    // Storing it would be worse than refusing: a vendor token outranks FCM by
    // design, so the device would select a channel with no provider behind it,
    // the send would fail, and a reachable device would be deactivated and
    // counted toward uninstalls.
    await expect(
      controller.registerToken(dto({ provider: 'mi_push' }), req),
    ).rejects.toThrow(BadRequestException);

    expect(pushTokensService.registerToken).not.toHaveBeenCalled();
  });

  it('names the channels it can deliver on when it refuses', async () => {
    // Tells an operator their vendor build is missing, rather than leaving
    // them to conclude token registration is broken.
    await expect(
      controller.registerToken(dto({ provider: 'huawei' }), req),
    ).rejects.toThrow(/fcm/);
  });

  it('still enforces the project scope before anything else', async () => {
    await expect(
      controller.registerToken(dto({ projectId: 'other-proj' }), req),
    ).rejects.toThrow(ForbiddenException);
  });
});

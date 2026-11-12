import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { ConversionsController } from './conversions.controller';
import { ConversionsService } from './conversions.service';
import { CreateConversionDto } from './dto/create-conversion.dto';

/**
 * `projectId` was not on `CreateConversionDto`, and both native SDKs send it,
 * so `forbidNonWhitelisted` answered every one of their calls with
 * `400 ["property projectId should not exist"]`. Their queues treat a 4xx as
 * terminal and delete the event, so no conversion from a mobile SDK had ever
 * been recorded — the funnel showed web conversions only and nothing errored.
 */
describe('ConversionsController', () => {
  const conversionsService = { trackConversion: jest.fn() };

  const controller = new ConversionsController(
    conversionsService as unknown as ConversionsService,
  );

  const req = { projectId: 'proj-1' } as unknown as Request;

  const dto = (over: Partial<CreateConversionDto> = {}): CreateConversionDto =>
    ({
      eventType: 'purchase',
      shortCode: 'abc123',
      ...over,
    }) as CreateConversionDto;

  beforeEach(() => jest.clearAllMocks());

  it('accepts a projectId that matches the API key', async () => {
    await controller.trackConversion(dto({ projectId: 'proj-1' }), req);

    expect(conversionsService.trackConversion).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
      'proj-1',
    );
  });

  it('rejects a projectId that is not the key’s own', async () => {
    // Accepting it silently would let the body disagree with the credential
    // and never say so; the key's project is what the service scopes to, so
    // the caller's conversion would land somewhere it did not ask for.
    await expect(
      controller.trackConversion(dto({ projectId: 'proj-other' }), req),
    ).rejects.toThrow(ForbiddenException);

    expect(conversionsService.trackConversion).not.toHaveBeenCalled();
  });

  it('accepts a body with no projectId at all', async () => {
    // The JS SDK has never sent one and must keep working.
    await controller.trackConversion(dto(), req);

    expect(conversionsService.trackConversion).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'purchase' }),
      'proj-1',
    );
  });

  it('rejects a projectId when the request carries no key context', async () => {
    // A guard misconfiguration must not turn into "any project you like".
    await expect(
      controller.trackConversion(
        dto({ projectId: 'proj-1' }),
        {} as unknown as Request,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(conversionsService.trackConversion).not.toHaveBeenCalled();
  });

  it('still scopes to the key when no projectId is sent', async () => {
    await controller.trackConversion(dto(), req);

    expect(conversionsService.trackConversion).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
    );
  });
});

import { ValidationPipe, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation-pipe.options';
import { LinkDeviceDto } from './link-device.dto';

/**
 * `link-device` used to declare its body as an inline type, which the pipe
 * has no metatype for and therefore skipped entirely: any shape was
 * accepted, and a caller-supplied `ipAddress` was *silently ignored* where
 * `identify` rejected one. Both were safe — neither honoured the value — but
 * "ignores" is the shape that hides, which is the whole lesson of this round.
 *
 * The fixtures are the literal bodies `IdentityManager.linkDevice` sends on
 * iOS and Android. Both send exactly four keys; neither has ever sent an
 * address.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const meta: ArgumentMetadata = {
  type: 'body',
  metatype: LinkDeviceDto,
  data: '',
};

const base = {
  projectId: 'e8600afc-f4a8-4b79-ade2-64491611c32d',
  deviceFingerprint: 'fp-1',
  externalUserId: 'user-7',
};

describe('LinkDeviceDto through the global pipe', () => {
  it('rejects a caller-supplied ipAddress, as identify does', async () => {
    await expect(
      pipe.transform({ ...base, platform: 'ios', ipAddress: '203.0.113.7' }, meta),
    ).rejects.toThrow(BadRequestException);
  });

  it('names the offending property', async () => {
    let response: unknown;
    try {
      await pipe.transform(
        { ...base, platform: 'ios', ipAddress: '203.0.113.7' },
        meta,
      );
    } catch (err) {
      response = (err as BadRequestException).getResponse();
    }

    expect(JSON.stringify(response)).toContain('ipAddress');
  });

  it.each(['ios', 'android'])(
    'accepts the exact body the %s SDK sends',
    async (platform) => {
      const result = (await pipe.transform(
        { ...base, platform },
        meta,
      )) as LinkDeviceDto;

      expect(result).toEqual({ ...base, platform });
    },
  );

  it('rejects a platform outside the shared PushPlatform set', async () => {
    // The set matches `register-token.dto.ts` and the shared `PushPlatform`
    // type, and is exactly what `device_identities.platform` holds.
    await expect(
      pipe.transform({ ...base, platform: 'tizen' }, meta),
    ).rejects.toThrow(BadRequestException);
  });

  it('names the accepted platforms when it rejects one', async () => {
    let response = '';
    try {
      await pipe.transform({ ...base, platform: 'tizen' }, meta);
    } catch (err) {
      response = JSON.stringify((err as BadRequestException).getResponse());
    }

    // @IsIn names its values, unlike @IsEnum over an array literal.
    expect(response).toContain('ios');
    expect(response).toContain('android');
    expect(response).toContain('web');
  });

  it('accepts web, for a future caller that is not a native SDK', async () => {
    const result = (await pipe.transform(
      { ...base, platform: 'web' },
      meta,
    )) as LinkDeviceDto;

    expect(result.platform).toBe('web');
  });

  it('rejects an empty deviceFingerprint', async () => {
    await expect(
      pipe.transform({ ...base, platform: 'ios', deviceFingerprint: '' }, meta),
    ).rejects.toThrow(BadRequestException);
  });

  it('requires platform, which the column cannot be null for', async () => {
    // Omitting it used to reach the insert and come back as a raw 500:
    // device_identities.platform is NOT NULL.
    await expect(pipe.transform(base, meta)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('requires projectId to be a uuid', async () => {
    await expect(
      pipe.transform({ ...base, platform: 'ios', projectId: 'not-a-uuid' }, meta),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects any other unknown field, which the inline type allowed', async () => {
    await expect(
      pipe.transform({ ...base, platform: 'ios', country: 'GB' }, meta),
    ).rejects.toThrow(BadRequestException);
  });
});

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsSettingsService } from './sms-settings.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { TwilioProvider } from './providers/twilio.provider';

const creds = JSON.stringify({ accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32) });

describe('SmsSettingsService.connect when Twilio cannot be reached', () => {
  let fetchMock: jest.SpyInstance;
  const replace = jest.fn();

  const service = () =>
    new SmsSettingsService(
      {
        findOne: async () => ({ id: 's1', projectId: 'p1', sender: '+14155550100', provider: null }),
        update: async () => ({ affected: 1 }),
      } as never,
      { replace, getPlaintext: async () => null } as never,
      new SmsProviderRegistry(new TwilioProvider()),
      { get: () => 'https://api.example' } as unknown as ConfigService,
     { record: jest.fn() } as never);

  beforeEach(() => {
    replace.mockReset();
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it.each([
    ['a timeout', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['a failed connection', () => new TypeError('fetch failed')],
  ])('%s is a 400 naming Twilio, with nothing stored', async (_name, error) => {
    fetchMock.mockRejectedValue(error());
    const thrown = await service()
      .connect({ projectId: 'p1', provider: 'twilio', credentials: creds }, 'u', { ipAddress: null, userAgent: null })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe('Could not reach Twilio. Try again.');
    expect(replace).not.toHaveBeenCalled();
  });

  // A TypeError is also what a bug of ours throws; only fetch's own
  // 'fetch failed' means Twilio could not be reached.
  it('a TypeError from a bug is not reported as Twilio being unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'sid')"));
    const thrown = await service()
      .connect({ projectId: 'p1', provider: 'twilio', credentials: creds }, 'u', { ipAddress: null, userAgent: null })
      .catch((e: unknown) => e);
    expect(thrown).not.toBeInstanceOf(BadRequestException);
    expect(thrown).toBeInstanceOf(TypeError);
  });

  it("still passes on Twilio's own refusal", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 20003, message: 'Authenticate' }), { status: 401 }));
    await expect(
      service().connect({ projectId: 'p1', provider: 'twilio', credentials: creds }, 'u', { ipAddress: null, userAgent: null }),
    ).rejects.toThrow(/401 20003 Authenticate/);
  });
});

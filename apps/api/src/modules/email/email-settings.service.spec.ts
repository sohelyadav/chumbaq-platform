import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailSettingsService } from './email-settings.service';
import { EmailProviderRegistry } from './email-provider.registry';
import { ResendProvider } from './providers/resend.provider';
import { SesProvider } from './providers/ses.provider';
import { BrevoProvider } from './providers/brevo.provider';

/** What Node's fetch rejects with when the time limit's signal fires. */
const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
/** What Node's fetch rejects with when it cannot connect (DNS, refused, TLS). */
const unreachable = () =>
  Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 10.0.0.7:443') });

class QuickResend extends ResendProvider {
  protected readonly requestTimeoutMs = 50;
}

const credentials = {
  ses: { region: 'ap-south-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
  resend: { apiKey: 're_test_123' },
  brevo: { apiKey: 'xkeysib-abc123' },
} as const;

const CTX = { ipAddress: null, userAgent: null };

describe('EmailSettingsService.connect when the provider cannot be reached', () => {
  let fetchMock: jest.SpyInstance;
  /** The credentials write; nothing may reach it when the provider check fails. */
  const replace = jest.fn();
  const row = { id: 's1', projectId: 'p1', fromEmail: 'a@b.c', postalAddress: '1 Main St', provider: null };

  const service = (resend: ResendProvider = new ResendProvider()) =>
    new EmailSettingsService(
      {
        findOne: async () => ({ ...row }),
        update: async () => ({ affected: 1 }),
      } as never,
      { replace, getPlaintext: async () => null } as never,
      new EmailProviderRegistry(new SesProvider(), resend, new BrevoProvider()),
      { get: () => 'https://api.example' } as unknown as ConfigService,
     { record: jest.fn() } as never);

  beforeEach(() => {
    replace.mockReset();
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  const cases = [
    ['ses', 'Amazon SES'],
    ['resend', 'Resend'],
    ['brevo', 'Brevo'],
  ] as const;

  it.each(cases)('%s: a timeout is a 400 naming the provider, with no raw detail', async (provider, label) => {
    fetchMock.mockRejectedValue(timedOut());
    const error = await service()
      .connect({ projectId: 'p1', provider, credentials: JSON.stringify(credentials[provider]) }, 'u', CTX)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(`Could not reach ${label}. Try again.`);
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(cases)('%s: a failed connection is the same 400', async (provider, label) => {
    fetchMock.mockRejectedValue(unreachable());
    await expect(
      service().connect({ projectId: 'p1', provider, credentials: JSON.stringify(credentials[provider]) }, 'u', CTX),
    ).rejects.toThrow(new BadRequestException(`Could not reach ${label}. Try again.`));
  });

  it('a provider that never answers ends in that 400 once the time limit passes', async () => {
    fetchMock.mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
    );
    await expect(
      service(new QuickResend()).connect({ projectId: 'p1', provider: 'resend', credentials: '{"apiKey":"re_x"}' }, 'u', CTX),
    ).rejects.toThrow('Could not reach Resend. Try again.');
  });

  it("still passes on the provider's own refusal", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ name: 'invalid_api_key', message: 'API key is invalid' }), { status: 401 }),
    );
    await expect(
      service().connect({ projectId: 'p1', provider: 'resend', credentials: '{"apiKey":"re_x"}' }, 'u', CTX),
    ).rejects.toThrow('Resend rejected this API key: API key is invalid');
  });

  // A TypeError is also what a bug of ours throws. Only fetch's own
  // 'fetch failed' means the provider could not be reached.
  it.each(cases)('%s: a TypeError from a bug is not reported as the provider being unreachable', async (provider) => {
    fetchMock.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const error = await service()
      .connect({ projectId: 'p1', provider, credentials: JSON.stringify(credentials[provider]) }, 'u', CTX)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BadRequestException);
    expect(error).toBeInstanceOf(TypeError);
  });

  it('leaves an error of our own alone rather than blaming the provider', async () => {
    fetchMock.mockRejectedValue(new Error('something else broke'));
    await expect(
      service().connect({ projectId: 'p1', provider: 'resend', credentials: '{"apiKey":"re_x"}' }, 'u', CTX),
    ).rejects.toThrow('something else broke');
  });
});

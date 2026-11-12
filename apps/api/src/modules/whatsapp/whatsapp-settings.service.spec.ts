import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppProviderRegistry } from './whatsapp-provider.registry';
import { WhatsAppCampaignsService } from './whatsapp-campaigns.service';
import { MetaWhatsAppProvider } from './providers/meta.provider';
import { TwilioWhatsAppProvider } from './providers/twilio-whatsapp.provider';
import { GupshupProvider } from './providers/gupshup.provider';
import { InteraktProvider } from './providers/interakt.provider';

const credentials = {
  meta: { phoneNumberId: '1059545589544', businessAccountId: '2059545589544', accessToken: 'EAAG-token' },
  twilio_whatsapp: { accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32), sender: '+14155550100' },
  gupshup: { apiKey: 'gs-key', appName: 'myshopapp', appId: 'a1b2c3d4-0000', sourceNumber: '+919000000000' },
  interakt: { apiKey: 'aW50ZXJha3Q6a2V5' },
} as const;

const cases = [
  ['meta', 'Meta'],
  ['twilio_whatsapp', 'Twilio'],
  ['gupshup', 'Gupshup'],
  ['interakt', 'Interakt'],
] as const;

const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

const registry = () =>
  new WhatsAppProviderRegistry(
    new MetaWhatsAppProvider(),
    new TwilioWhatsAppProvider(),
    new GupshupProvider(),
    new InteraktProvider(),
  );

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => fetchMock.mockRestore());

describe('WhatsAppSettingsService.connect when the provider cannot be reached', () => {
  const replace = jest.fn();
  const service = () =>
    new WhatsAppSettingsService(
      {
        findOne: async () => ({ id: 's1', projectId: 'p1', provider: null, requireOptIn: true, webhookToken: 'ab'.repeat(24) }),
        update: async () => ({ affected: 1 }),
      } as never,
      { replace, getPlaintext: async () => null } as never,
      registry(),
      { get: () => 'https://api.example' } as unknown as ConfigService,
     { record: jest.fn() } as never);

  beforeEach(() => replace.mockReset());

  it.each(cases)('%s: a timeout is a 400 naming the provider, with nothing stored', async (provider, label) => {
    fetchMock.mockRejectedValue(timedOut());
    const thrown = await service()
      .connect({ projectId: 'p1', provider, credentials: JSON.stringify(credentials[provider]) }, 'u', { ipAddress: null, userAgent: null })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(`Could not reach ${label}. Try again.`);
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(cases)('%s: a failed connection is the same 400', async (provider, label) => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      service().connect({ projectId: 'p1', provider, credentials: JSON.stringify(credentials[provider]) }, 'u', { ipAddress: null, userAgent: null }),
    ).rejects.toThrow(new BadRequestException(`Could not reach ${label}. Try again.`));
  });

  // A TypeError is also what a bug of ours throws; only fetch's own
  // 'fetch failed' means the provider could not be reached.
  it.each(cases)('%s: a TypeError from a bug is not reported as the provider being unreachable', async (provider) => {
    fetchMock.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const thrown = await service()
      .connect({ projectId: 'p1', provider, credentials: JSON.stringify(credentials[provider]) }, 'u', { ipAddress: null, userAgent: null })
      .catch((e: unknown) => e);
    expect(thrown).not.toBeInstanceOf(BadRequestException);
    expect(thrown).toBeInstanceOf(TypeError);
  });
});

describe('WhatsApp templates when the provider cannot be reached', () => {
  it.each(cases.filter(([provider]) => provider !== 'interakt'))(
    '%s: listing templates is a 400 naming the provider',
    async (provider, label) => {
      fetchMock.mockRejectedValue(timedOut());
      const settings = {
        requireSendable: async () => ({ settings: { provider }, credentials: credentials[provider] }),
      };
      const campaigns = new WhatsAppCampaignsService(
        {} as never, {} as never, {} as never, settings as never, {} as never, {} as never, registry(), {} as never,
      );
      await expect(campaigns.templates('p1', { fresh: true })).rejects.toThrow(
        new BadRequestException(`Could not reach ${label}. Try again.`),
      );
    },
  );
});

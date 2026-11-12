import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { WhatsAppPublicController } from './whatsapp-public.controller';

const TOKEN = 'a'.repeat(48);

function response() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.type = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const request = (body: unknown) =>
  ({
    originalUrl: `/api/whatsapp/webhooks/meta/${TOKEN}`,
    rawBody: Buffer.from(JSON.stringify(body)),
    body,
    query: {},
    header: () => undefined,
  }) as never;

describe('WhatsAppPublicController', () => {
  const settings = {
    findByWebhookToken: jest.fn(),
    credentialsFor: jest.fn(),
    baseUrl: jest.fn(() => 'https://api.example'),
  };
  const events = { ingest: jest.fn().mockResolvedValue(1) };
  const provider = {
    authenticateWebhook: jest.fn(),
    parseWebhook: jest.fn(() => [{ kind: 'inbound' }]),
    suppressingErrors: new Map(),
    reportsCarryCampaign: true,
  };
  const registry = { get: jest.fn(() => provider) };
  let controller: WhatsAppPublicController;

  beforeEach(() => {
    jest.clearAllMocks();
    settings.findByWebhookToken.mockResolvedValue({ projectId: 'proj-1', webhookToken: TOKEN });
    settings.credentialsFor.mockResolvedValue({ appSecret: 's' });
    controller = new WhatsAppPublicController(settings as never, events as never, registry as never);
  });

  it("answers Meta's handshake only with the project's verify token", async () => {
    const res = response();
    await controller.verifyMeta(TOKEN, 'subscribe', TOKEN, '12345', res);
    expect(res.send).toHaveBeenCalledWith('12345');
    await expect(controller.verifyMeta(TOKEN, 'subscribe', 'guess', '1', response())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ingests signed events as signed', async () => {
    provider.authenticateWebhook.mockReturnValueOnce(true);
    await controller.receive('meta', TOKEN, request({}), response());
    expect(events.ingest).toHaveBeenCalledWith('proj-1', 'meta', [{ kind: 'inbound' }], provider.suppressingErrors, {
      signed: true,
      attributeByRecency: false,
    });
  });

  it('ingests unsigned events as unsigned, so they are corroborated', async () => {
    provider.authenticateWebhook.mockReturnValueOnce('unsigned');
    await controller.receive('meta', TOKEN, request({}), response());
    expect(events.ingest.mock.calls[0][4]).toEqual({ signed: false, attributeByRecency: false });
  });

  it('refuses a bad signature, an unknown provider or token, and an unconnected provider', async () => {
    provider.authenticateWebhook.mockReturnValueOnce(false);
    await expect(controller.receive('meta', TOKEN, request({}), response())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.receive('telegram', TOKEN, request({}), response())).rejects.toBeInstanceOf(NotFoundException);
    settings.findByWebhookToken.mockResolvedValueOnce(null);
    await expect(controller.receive('meta', 'x', request({}), response())).rejects.toBeInstanceOf(NotFoundException);
    settings.credentialsFor.mockResolvedValueOnce(null);
    await expect(controller.receive('meta', TOKEN, request({}), response())).rejects.toBeInstanceOf(ForbiddenException);
    expect(events.ingest).not.toHaveBeenCalled();
  });

  it('hands the provider the public URL, which is what Twilio signs', async () => {
    provider.authenticateWebhook.mockReturnValueOnce(true);
    await controller.receive('twilio_whatsapp', TOKEN, request({}), response());
    expect(provider.authenticateWebhook.mock.calls[0][1].url).toBe(`https://api.example/api/whatsapp/webhooks/meta/${TOKEN}`);
  });
});

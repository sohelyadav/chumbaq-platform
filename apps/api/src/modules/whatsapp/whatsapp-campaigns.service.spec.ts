import { BadRequestException } from '@nestjs/common';
import { WhatsAppCampaignsService } from './whatsapp-campaigns.service';

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };
const activity = { record: jest.fn() };

const template = {
  id: 'promo', name: 'promo', language: 'en', category: 'MARKETING', status: 'APPROVED',
  bodyText: 'Hi {{1}}', bodyParamCount: 1, paramNames: null, header: null, buttons: [],
};

describe('WhatsAppCampaignsService', () => {
  const logRepository = {
    save: jest.fn(async (row) => ({ id: 'camp-1', ...row })),
    create: jest.fn((row) => row),
    manager: { transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => logRepository }) },
  };
  const policyRepository = { findOne: jest.fn().mockResolvedValue(null) };
  const queue = { add: jest.fn() };
  const settings = { requireSendable: jest.fn(), find: jest.fn() };
  const audience = { count: jest.fn().mockResolvedValue(3) };
  const push = { segmentDeviceIdentityIds: jest.fn() };
  const provider = { canListTemplates: true, listTemplates: jest.fn(), sendToRecipients: jest.fn() };
  const registry = { get: jest.fn(() => provider) };
  let service: WhatsAppCampaignsService;

  const dto = (over: Record<string, unknown> = {}) => ({
    projectId: 'proj-1',
    content: {
      template: { id: 'promo', name: 'promo', language: 'en' },
      bodyParams: ['{{firstName|there}}'],
      previewText: 'Hi {{1}}',
    },
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    provider.canListTemplates = true;
    provider.listTemplates.mockResolvedValue([template]);
    settings.requireSendable.mockResolvedValue({
      settings: { provider: 'meta', requireOptIn: true }, credentials: {},
    });
    service = new WhatsAppCampaignsService(
      logRepository as never, policyRepository as never, queue as never, settings as never,
      audience as never, push as never, registry as never, activity as never,
    );
  });

  it('queues a campaign whose content matches an approved template', async () => {
    const log = await service.send(dto() as never, REQUESTER);
    expect(log).toMatchObject({
      channel: 'whatsapp', title: 'promo', body: 'Hi {{firstName|there}}', totalTokens: 3, status: 'queued',
      whatsappContent: expect.objectContaining({ template: expect.objectContaining({ id: 'promo' }) }),
    });
    expect(queue.add).toHaveBeenCalled();
  });

  it('refuses content WhatsApp would reject, before queuing anything', async () => {
    await expect(
      service.send(dto({ content: { ...dto().content, bodyParams: ['a', 'b'] } }) as never, REQUESTER),
    ).rejects.toThrow(/1 body value/);
    provider.listTemplates.mockResolvedValueOnce([{ ...template, status: 'REJECTED' }]);
    await expect(service.send(dto() as never, REQUESTER)).rejects.toThrow(/rejected/);
    expect(logRepository.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('takes a hand-entered template on a provider that cannot list them', async () => {
    provider.canListTemplates = false;
    await expect(service.send(dto() as never, REQUESTER)).resolves.toBeDefined();
    expect(provider.listTemplates).not.toHaveBeenCalled();
  });

  it('refuses an audience nobody in which can be messaged', async () => {
    audience.count.mockResolvedValueOnce(0);
    await expect(service.send(dto() as never, REQUESTER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checks every experiment arm against its own template', async () => {
    await expect(
      service.send(dto({
        variants: [
          { key: 'A', title: 'A', weight: 50, content: dto().content },
          { key: 'B', title: 'B', weight: 50, content: { ...dto().content, template: { id: 'gone', name: 'gone', language: 'en' } } },
        ],
      }) as never, REQUESTER),
    ).rejects.toThrow(/"gone".*not found/);
  });
});

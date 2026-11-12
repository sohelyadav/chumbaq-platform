import { CAMPAIGN_STOPPED_BY_SUSPENSION } from '../projects/project-suspension.service';
import { Job, UnrecoverableError } from 'bullmq';
import { WhatsAppDeliveryService, WHATSAPP_BATCH_SIZE } from './whatsapp-delivery.service';

const identity = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  phoneE164: `+9198765000${n}`,
  firstName: `P${n}`,
});

const content = {
  template: { id: 'promo', name: 'promo', language: 'en' },
  bodyParams: ['{{firstName|there}}'],
};

const log = (over: Record<string, unknown> = {}) =>
  ({
    id: 'camp-1', projectId: 'proj-1', channel: 'whatsapp', whatsappContent: content,
    targetType: 'project', targetDeviceIds: null, totalTokens: 2, processedTokens: 0, lastTokenId: null,
    ...over,
  }) as never;

const job = () => ({ updateProgress: jest.fn() }) as unknown as Job;

const ok = (n: number) => ({
  successCount: n, failureCount: 0, failures: [], resolvedCount: n, retryReason: null,
});

describe('WhatsAppDeliveryService', () => {
  const state = {
    markSending: jest.fn(), markFailed: jest.fn(), recordBatch: jest.fn(),
    recordSentRecipients: jest.fn(), finalize: jest.fn().mockResolvedValue('sent'),
  };
  const settings = {
    requireSendable: jest.fn(),
    webhooksReachable: jest.fn(() => true),
    webhookUrl: jest.fn((token: string, provider: string) => `https://api/w/${provider}/${token}`),
  };
  const audience = { page: jest.fn() };
  const provider = {
    provider: 'meta',
    sendToRecipients: jest.fn(),
    suppressingErrors: new Map([['131050', 'unsubscribed'], ['131026', 'bounced']]),
  };
  const registry = { get: jest.fn(() => provider) };
  const suppressions = { suppress: jest.fn() };
  const policy = { findOne: jest.fn().mockResolvedValue(null) };
  let tenantSuspended = false;
  const suspension = { isSuspended: jest.fn(async (_id: string) => tenantSuspended) };
  let service: WhatsAppDeliveryService;

  const sendable = (name: string) => ({
    settings: { provider: name, requireOptIn: true, webhookToken: 't'.repeat(48) },
    credentials: {},
  });

  beforeEach(() => {
    jest.clearAllMocks();
    tenantSuspended = false;
    settings.requireSendable.mockResolvedValue(sendable('meta'));
    service = new WhatsAppDeliveryService(
      policy as never, state as never, settings as never, audience as never, registry as never, suppressions as never,
      suspension as never,
    );
  });

  it('sends each number the template with its values and our ids', async () => {
    audience.page.mockResolvedValueOnce([identity(1)]).mockResolvedValueOnce([]);
    provider.sendToRecipients.mockResolvedValueOnce({
      successCount: 1, failureCount: 0, failures: [], resolvedCount: 1, retryReason: null,
    });

    await service.deliver(job(), log());

    const [, recipients] = provider.sendToRecipients.mock.calls[0];
    expect(recipients[0]).toMatchObject({
      token: '+91987650001',
      message: { bodyParams: ['P1'], campaignId: 'camp-1', identityId: identity(1).id },
    });
    // Only Twilio takes a per-message callback.
    expect(recipients[0].message.statusCallback).toBeUndefined();
    expect(audience.page.mock.calls[0][2]).toBe(WHATSAPP_BATCH_SIZE);
  });

  it('gives Twilio a signed-URL callback naming the campaign and person', async () => {
    settings.requireSendable.mockResolvedValueOnce(sendable('twilio_whatsapp'));
    audience.page.mockResolvedValueOnce([identity(1)]).mockResolvedValueOnce([]);
    provider.sendToRecipients.mockResolvedValueOnce({
      successCount: 1, failureCount: 0, failures: [], resolvedCount: 1, retryReason: null,
    });
    await service.deliver(job(), log());
    const [, recipients] = provider.sendToRecipients.mock.calls[0];
    expect(recipients[0].message.statusCallback).toBe(
      `https://api/w/twilio_whatsapp/${'t'.repeat(48)}?c=camp-1&i=${identity(1).id}`,
    );
  });

  it('suppresses numbers the provider says opted out or are not on WhatsApp', async () => {
    audience.page.mockResolvedValueOnce([identity(1), identity(2)]).mockResolvedValueOnce([]);
    provider.sendToRecipients.mockResolvedValueOnce({
      successCount: 0, failureCount: 2, resolvedCount: 2, retryReason: null,
      failures: [
        { token: '+91987650001', error: 'stopped', errorCode: '131050', retryable: false },
        { token: '+91987650002', error: 'limit', errorCode: '131049', retryable: false },
      ],
    });
    await service.deliver(job(), log());
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'proj-1', 'whatsapp', [{ address: '+91987650001', reason: 'unsubscribed', detail: 'stopped' }], 'meta',
    );
  });

  it('checkpoints only the resolved prefix and fails the attempt to retry the rest', async () => {
    audience.page.mockResolvedValueOnce([identity(1), identity(2)]);
    provider.sendToRecipients.mockResolvedValueOnce({
      successCount: 1, failureCount: 0, failures: [], resolvedCount: 1, retryReason: 'throughput',
    });
    await expect(service.deliver(job(), log())).rejects.toThrow(/throughput/);
    expect(state.recordBatch).toHaveBeenCalledWith('camp-1', expect.objectContaining({ lastTokenId: identity(1).id }));
    expect(state.finalize).not.toHaveBeenCalled();
  });

  it('fails without retrying when the campaign has no template, or WhatsApp is not set up', async () => {
    await expect(service.deliver(job(), log({ whatsappContent: null }))).rejects.toBeInstanceOf(UnrecoverableError);
    settings.requireSendable.mockRejectedValueOnce(new Error('Connect a WhatsApp provider'));
    await expect(service.deliver(job(), log())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(state.markFailed).toHaveBeenLastCalledWith('camp-1', 'Connect a WhatsApp provider');
    expect(provider.sendToRecipients).not.toHaveBeenCalled();
  });

  describe('when the tenant is suspended', () => {
    it('stops at the next page of a running campaign, without retrying or counting anyone else', async () => {
      audience.page
        .mockResolvedValueOnce([identity(1)])
        .mockResolvedValueOnce([identity(2)]);
      // The suspension lands while the first page is out.
      provider.sendToRecipients.mockImplementationOnce(async () => {
        tenantSuspended = true;
        return ok(1);
      });

      // Resolves: a throw would have BullMQ retry a campaign that must not run.
      await expect(service.deliver(job(), log())).resolves.toBeUndefined();

      expect(provider.sendToRecipients).toHaveBeenCalledTimes(1);
      expect(state.recordBatch).toHaveBeenCalledTimes(1);
      expect(state.recordSentRecipients).toHaveBeenCalledTimes(1);
      expect(state.markFailed).toHaveBeenCalledWith('camp-1', CAMPAIGN_STOPPED_BY_SUSPENSION);
      // finalize would report what was never attempted as a clean finish.
      expect(state.finalize).not.toHaveBeenCalled();
    });

    it('finishes normally when the audience ran out before the suspension mattered', async () => {
      audience.page.mockResolvedValueOnce([identity(1)]).mockResolvedValueOnce([]);
      provider.sendToRecipients.mockImplementationOnce(async () => {
        tenantSuspended = true;
        return ok(1);
      });

      await service.deliver(job(), log());

      expect(state.finalize).toHaveBeenCalledWith('camp-1');
      expect(state.markFailed).not.toHaveBeenCalled();
    });

    it('checks the campaign\'s own project before every page of an active tenant', async () => {
      audience.page.mockResolvedValueOnce([identity(1)]).mockResolvedValueOnce([identity(2)]).mockResolvedValueOnce([]);
      provider.sendToRecipients.mockResolvedValueOnce(ok(1)).mockResolvedValueOnce(ok(1));

      await service.deliver(job(), log());

      expect(provider.sendToRecipients).toHaveBeenCalledTimes(2);
      expect(suspension.isSuspended.mock.calls).toEqual([['proj-1'], ['proj-1']]);
      expect(state.finalize).toHaveBeenCalledWith('camp-1');
    });
  });
});

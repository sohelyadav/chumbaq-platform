import { CAMPAIGN_STOPPED_BY_SUSPENSION } from '../projects/project-suspension.service';
import { Job, UnrecoverableError } from 'bullmq';
import { EmailDeliveryService, EMAIL_BATCH_SIZE } from './email-delivery.service';

const identity = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  email: `person${n}@example.com`,
  firstName: `P${n}`,
});

const log = (over: Record<string, unknown> = {}) =>
  ({
    id: 'camp-1',
    projectId: 'proj-1',
    channel: 'email',
    emailContent: { subject: 'Hi {{firstName}}', html: '<p>Hello</p>' },
    targetType: 'project',
    targetDeviceIds: null,
    totalTokens: 3,
    processedTokens: 0,
    lastTokenId: null,
    ...over,
  }) as never;

const job = () => ({ updateProgress: jest.fn() }) as unknown as Job;

const ok = (n: number) => ({
  successCount: n, failureCount: 0, failures: [], resolvedCount: n, retryReason: null,
});

describe('EmailDeliveryService', () => {
  const state = {
    markSending: jest.fn(),
    markFailed: jest.fn(),
    recordBatch: jest.fn(),
    recordSentRecipients: jest.fn(),
    finalize: jest.fn().mockResolvedValue('sent'),
  };
  const settings = {
    requireSendable: jest.fn(),
  };
  const audience = { page: jest.fn() };
  const provider = { provider: 'ses', sendToRecipients: jest.fn() };
  const registry = { get: jest.fn(() => provider) };
  const unsubscribe = { url: jest.fn((p: string, a: string) => `https://u/${p}/${a}`) };
  const policy = { findOne: jest.fn().mockResolvedValue(null) };

  let tenantSuspended = false;
  const suspension = { isSuspended: jest.fn(async (_id: string) => tenantSuspended) };
  let service: EmailDeliveryService;

  beforeEach(() => {
    jest.clearAllMocks();
    tenantSuspended = false;
    settings.requireSendable.mockResolvedValue({
      settings: {
        provider: 'ses',
        fromEmail: 'hi@shop.example',
        fromName: 'Shop',
        replyTo: null,
        postalAddress: '12 MG Road',
        requireOptIn: true,
      },
      credentials: { region: 'ap-south-1' },
    });
    policy.findOne.mockResolvedValue(null);
    service = new EmailDeliveryService(
      policy as never,
      state as never,
      settings as never,
      audience as never,
      registry as never,
      unsubscribe as never,
      suspension as never,
    );
  });

  it('sends each recipient a rendered email with tags and an unsubscribe link', async () => {
    audience.page.mockResolvedValueOnce([identity(1)]).mockResolvedValueOnce([]);
    provider.sendToRecipients.mockResolvedValueOnce({
      successCount: 1, failureCount: 0, failures: [], resolvedCount: 1, retryReason: null,
    });

    await service.deliver(job(), log());

    const [, recipients] = provider.sendToRecipients.mock.calls[0];
    expect(recipients[0].token).toBe('person1@example.com');
    expect(recipients[0].message.subject).toBe('Hi P1');
    expect(recipients[0].message.tags).toEqual({
      chumbaq_campaign_id: 'camp-1',
      chumbaq_identity_id: identity(1).id,
    });
    expect(recipients[0].message.headers['List-Unsubscribe']).toBe(
      '<https://u/proj-1/person1@example.com>',
    );
    expect(state.finalize).toHaveBeenCalledWith('camp-1');
  });

  it('reads the whole project only for a project-wide campaign', async () => {
    audience.page.mockResolvedValue([]);
    await service.deliver(job(), log({ targetType: 'segment', targetDeviceIds: null }));
    // A segment campaign with no stored list reaches nobody, never everybody.
    expect(audience.page.mock.calls[0][0]).toEqual({
      projectId: 'proj-1',
      deviceIdentityIds: [],
      requireOptIn: true,
    });

    await service.deliver(job(), log());
    expect(audience.page.mock.calls[1][0].deviceIdentityIds).toBeNull();
  });

  it('checkpoints only the resolved prefix, then fails the attempt to retry the rest', async () => {
    const page = [identity(1), identity(2), identity(3)];
    audience.page.mockResolvedValueOnce(page);
    provider.sendToRecipients.mockResolvedValueOnce({
      successCount: 1,
      failureCount: 0,
      failures: [],
      resolvedCount: 1,
      retryReason: '429 slow down',
    });

    await expect(service.deliver(job(), log())).rejects.toThrow(/429 slow down/);

    expect(state.recordBatch).toHaveBeenCalledWith(
      'camp-1',
      expect.objectContaining({ lastTokenId: identity(1).id, processedInBatch: 1 }),
    );
    expect(state.finalize).not.toHaveBeenCalled();
  });

  it('records sends for everyone delivered, and failures by address', async () => {
    audience.page.mockResolvedValueOnce([identity(1), identity(2)]).mockResolvedValueOnce([]);
    provider.sendToRecipients.mockResolvedValueOnce({
      successCount: 1,
      failureCount: 1,
      failures: [{ token: 'person2@example.com', error: 'rejected', errorCode: 'MessageRejected', retryable: false }],
      resolvedCount: 2,
      retryReason: null,
    });

    await service.deliver(job(), log());

    expect(state.recordSentRecipients).toHaveBeenCalledWith(expect.anything(), [identity(1).id]);
    expect(state.recordBatch.mock.calls[0][1].failures).toEqual([
      { token: 'person2@example.com', error: 'rejected', errorCode: 'MessageRejected' },
    ]);
  });

  it('resumes from the stored checkpoint', async () => {
    audience.page.mockResolvedValue([]);
    await service.deliver(job(), log({ lastTokenId: 'cursor-id' }));
    expect(audience.page.mock.calls[0][1]).toBe('cursor-id');
    expect(audience.page.mock.calls[0][2]).toBe(EMAIL_BATCH_SIZE);
  });

  it('fails without retrying when email is not set up', async () => {
    settings.requireSendable.mockRejectedValueOnce(new Error('Connect Amazon SES or Resend'));
    await expect(service.deliver(job(), log())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(state.markFailed).toHaveBeenCalledWith('camp-1', 'Connect Amazon SES or Resend');
    expect(provider.sendToRecipients).not.toHaveBeenCalled();
  });

  it('applies the shared frequency cap to the reader', async () => {
    policy.findOne.mockResolvedValueOnce({ frequencyCapPerDay: 2, maxSendsPerMinute: null });
    audience.page.mockResolvedValue([]);
    await service.deliver(job(), log());
    expect(audience.page.mock.calls[0][3]).toBe(2);
    expect(audience.page.mock.calls[0][4]).toBe('camp-1');
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

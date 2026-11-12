import { CAMPAIGN_STOPPED_BY_SUSPENSION } from '../projects/project-suspension.service';
import { Job, UnrecoverableError } from 'bullmq';
import { SmsDeliveryService, SMS_BATCH_SIZE } from './sms-delivery.service';

const identity = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  phoneE164: `+1415555000${n}`,
  firstName: `P${n}`,
});

const log = (over: Record<string, unknown> = {}) =>
  ({
    id: 'camp-1',
    projectId: 'proj-1',
    channel: 'sms',
    body: 'Hi {{firstName}}, sale today',
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

describe('SmsDeliveryService', () => {
  const state = {
    markSending: jest.fn(),
    markFailed: jest.fn(),
    recordBatch: jest.fn(),
    recordSentRecipients: jest.fn(),
    finalize: jest.fn().mockResolvedValue('sent'),
  };
  const settings = {
    requireSendable: jest.fn(),
    statusCallbackUrl: jest.fn(
      (_s: unknown, c: string | null, i: string | null) => `https://api/status?c=${c}&i=${i}`,
    ),
  };
  const audience = { page: jest.fn() };
  const provider = { provider: 'twilio', sendToRecipients: jest.fn() };
  const registry = { get: jest.fn(() => provider) };
  const suppressions = { suppress: jest.fn() };
  const policy = { findOne: jest.fn().mockResolvedValue(null) };

  let tenantSuspended = false;
  const suspension = { isSuspended: jest.fn(async (_id: string) => tenantSuspended) };
  let service: SmsDeliveryService;

  beforeEach(() => {
    jest.clearAllMocks();
    tenantSuspended = false;
    settings.requireSendable.mockResolvedValue({
      settings: {
        provider: 'twilio',
        sender: '+14155550100',
        optOutText: 'Reply STOP to opt out.',
        requireOptIn: true,
        webhookToken: 't'.repeat(48),
      },
      credentials: { accountSid: 'AC1', authToken: 'x' },
    });
    policy.findOne.mockResolvedValue(null);
    service = new SmsDeliveryService(
      policy as never,
      state as never,
      settings as never,
      audience as never,
      registry as never,
      suppressions as never,
      suspension as never,
    );
  });

  it('texts each number its personalised message with a per-person delivery callback', async () => {
    audience.page.mockResolvedValueOnce([identity(1)]).mockResolvedValueOnce([]);
    provider.sendToRecipients.mockResolvedValueOnce(ok(1));

    await service.deliver(job(), log());

    const [, recipients] = provider.sendToRecipients.mock.calls[0];
    expect(recipients[0]).toEqual({
      token: '+14155550001',
      message: {
        from: '+14155550100',
        body: 'Hi P1, sale today\nReply STOP to opt out.',
        statusCallback: `https://api/status?c=camp-1&i=${identity(1).id}`,
      },
    });
    expect(state.recordSentRecipients).toHaveBeenCalledWith(expect.anything(), [identity(1).id]);
    expect(state.finalize).toHaveBeenCalledWith('camp-1');
  });

  it('reads the whole project only for a project-wide campaign', async () => {
    audience.page.mockResolvedValue([]);
    await service.deliver(job(), log({ targetType: 'segment', targetDeviceIds: null }));
    expect(audience.page.mock.calls[0][0]).toEqual({
      projectId: 'proj-1',
      deviceIdentityIds: [],
      requireOptIn: true,
    });
  });

  it('suppresses numbers Twilio says replied STOP or cannot take texts', async () => {
    audience.page
      .mockResolvedValueOnce([identity(1), identity(2), identity(3)])
      .mockResolvedValueOnce([]);
    provider.sendToRecipients.mockResolvedValueOnce({
      successCount: 0,
      failureCount: 3,
      failures: [
        { token: '+14155550001', error: 'unsubscribed', errorCode: '21610', retryable: false },
        { token: '+14155550002', error: 'landline', errorCode: '21614', retryable: false },
        { token: '+14155550003', error: 'queue full', errorCode: '30001', retryable: false },
      ],
      resolvedCount: 3,
      retryReason: null,
    });

    await service.deliver(job(), log());

    expect(suppressions.suppress).toHaveBeenCalledWith(
      'proj-1',
      'sms',
      [
        { address: '+14155550001', reason: 'unsubscribed', detail: 'unsubscribed' },
        { address: '+14155550002', reason: 'bounced', detail: 'landline' },
      ],
      'twilio',
    );
    // Nobody was sent anything, so nobody counts toward the frequency cap.
    expect(state.recordSentRecipients).toHaveBeenCalledWith(expect.anything(), []);
  });

  it('checkpoints only the resolved prefix, then fails the attempt to retry the rest', async () => {
    audience.page.mockResolvedValueOnce([identity(1), identity(2), identity(3)]);
    provider.sendToRecipients.mockResolvedValueOnce({ ...ok(1), retryReason: '429 slow down' });

    await expect(service.deliver(job(), log())).rejects.toThrow(/429 slow down/);

    expect(state.recordBatch).toHaveBeenCalledWith(
      'camp-1',
      expect.objectContaining({ lastTokenId: identity(1).id, processedInBatch: 1 }),
    );
    expect(state.finalize).not.toHaveBeenCalled();
  });

  it('resumes from the stored checkpoint with the SMS page size', async () => {
    audience.page.mockResolvedValue([]);
    await service.deliver(job(), log({ lastTokenId: 'cursor-id' }));
    expect(audience.page.mock.calls[0][1]).toBe('cursor-id');
    expect(audience.page.mock.calls[0][2]).toBe(SMS_BATCH_SIZE);
  });

  it('fails without retrying when SMS is not set up', async () => {
    settings.requireSendable.mockRejectedValueOnce(new Error('Connect Twilio'));
    await expect(service.deliver(job(), log())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(state.markFailed).toHaveBeenCalledWith('camp-1', 'Connect Twilio');
  });

  it('fails a campaign with no text without sending', async () => {
    await expect(service.deliver(job(), log({ body: '  ' }))).rejects.toBeInstanceOf(UnrecoverableError);
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

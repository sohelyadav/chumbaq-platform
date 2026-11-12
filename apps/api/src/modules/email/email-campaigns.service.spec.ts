import { BadRequestException } from '@nestjs/common';
import { EmailCampaignsService } from './email-campaigns.service';

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };
const activity = { record: jest.fn() };

const PROJECT = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';

describe('EmailCampaignsService', () => {
  const logRepository = {
    create: jest.fn((row) => row),
    save: jest.fn(async (row) => ({ id: 'camp-1', ...row })),
    // The row and its activity entry are written in one transaction.
    manager: { transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => logRepository }) },
  };
  const policy = { findOne: jest.fn() };
  const queue = { add: jest.fn() };
  const settings = { requireSendable: jest.fn(), find: jest.fn() };
  const audience = { count: jest.fn() };
  const push = { segmentDeviceIdentityIds: jest.fn() };
  const registry = { get: jest.fn() };
  const unsubscribe = { url: jest.fn(() => 'https://u') };

  let service: EmailCampaignsService;

  beforeEach(() => {
    jest.clearAllMocks();
    policy.findOne.mockResolvedValue({ frequencyCapPerDay: 3 });
    settings.requireSendable.mockResolvedValue({
      settings: { provider: 'resend', requireOptIn: true },
      credentials: {},
    });
    audience.count.mockResolvedValue(40);
    service = new EmailCampaignsService(
      logRepository as never,
      policy as never,
      queue as never,
      settings as never,
      audience as never,
      push as never,
      registry as never,
      unsubscribe as never,
      activity as never,
    );
  });

  const base = { projectId: PROJECT, subject: 'Big sale', html: '<p>Sale</p>' };

  it('queues an immediate email campaign on the shared campaign queue', async () => {
    const log = await service.send(base, REQUESTER);

    expect(logRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        title: 'Big sale',
        emailContent: { subject: 'Big sale', html: '<p>Sale</p>', text: null, preheader: null },
        targetType: 'project',
        targetDeviceIds: null,
        totalTokens: 40,
        status: 'queued',
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'dispatch-campaign',
      { logId: log.id, projectId: PROJECT },
      { jobId: log.id },
    );
    expect(activity.record).toHaveBeenCalledWith(
      {
        projectId: PROJECT,
        actor: { kind: 'user', userId: 'user-1' },
        action: 'campaign.sent',
        target: { type: 'campaign', id: 'camp-1', label: 'Big sale' },
        details: { channel: 'email', audienceSize: 40 },
      },
      REQUESTER.context,
      expect.anything(),
    );
  });

  it('writes no activity entry for a journey step (no requester)', async () => {
    await service.send(base, null);
    expect(logRepository.save).toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('counts the audience under the frequency cap and consent policy', async () => {
    await service.send(base, REQUESTER);
    expect(audience.count).toHaveBeenCalledWith(
      { projectId: PROJECT, deviceIdentityIds: null, requireOptIn: true },
      3,
    );
  });

  it('targets a segment through the same resolution push uses', async () => {
    push.segmentDeviceIdentityIds.mockResolvedValueOnce(['d1', 'd2']);
    await service.send({ ...base, segmentId: '11111111-2222-4333-8444-555555555555' }, REQUESTER);
    expect(logRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'segment', targetDeviceIds: ['d1', 'd2'] }),
    );
  });

  it('refuses an audience nobody in which can be emailed, and says why', async () => {
    audience.count.mockResolvedValueOnce(0);
    await expect(service.send(base, REQUESTER)).rejects.toThrow(/email_opt_in/);
    expect(logRepository.save).not.toHaveBeenCalled();
  });

  it('holds an experiment for the sweep to split, with each arm\'s HTML', async () => {
    await service.send({
      ...base,
      variants: [
        { key: 'A', title: 'Subject A', html: '<p>A</p>', weight: 50 },
        { key: 'B', title: 'Subject B', weight: 50 },
      ],
      controlPercentage: 10,
    }, REQUESTER);

    expect(logRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'scheduled',
        controlPercentage: 10,
        variants: [
          expect.objectContaining({ key: 'A', title: 'Subject A', html: '<p>A</p>' }),
          expect.objectContaining({ key: 'B', html: null }),
        ],
      }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses arms whose weights do not add up', async () => {
    await expect(
      service.send({
        ...base,
        variants: [
          { key: 'A', title: 'A', weight: 50 },
          { key: 'B', title: 'B', weight: 20 },
        ],
      }, REQUESTER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports a person as unreachable when no provider is connected', async () => {
    settings.find.mockResolvedValueOnce({ provider: null, requireOptIn: true });
    await expect(service.countReachable(PROJECT, ['d1'])).resolves.toBe(0);
    expect(audience.count).not.toHaveBeenCalled();
  });
});

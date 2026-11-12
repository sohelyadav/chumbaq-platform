import { SmsEventsService } from './sms-events.service';

const c = '11111111-1111-4111-8111-111111111111';
const i = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-11-01T00:00:00Z');

describe('SmsEventsService', () => {
  const insert = { into: jest.fn(), values: jest.fn(), orIgnore: jest.fn(), execute: jest.fn() };
  const eventRepository = { createQueryBuilder: jest.fn(() => ({ insert: () => insert })) };
  const logRepository = { exists: jest.fn() };
  const suppressions = { suppress: jest.fn(), remove: jest.fn() };
  let service: SmsEventsService;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ['into', 'values', 'orIgnore'] as const) insert[key].mockReturnValue(insert);
    logRepository.exists.mockResolvedValue(true);
    service = new SmsEventsService(eventRepository as never, logRepository as never, suppressions as never);
  });

  it('records a delivery against a campaign the project owns', async () => {
    await expect(
      service.ingest('proj-1', 'twilio', {
        type: 'delivered', address: '+14155550000', campaignId: c, identityId: i, occurredAt: at,
      }),
    ).resolves.toBe(1);

    expect(logRepository.exists).toHaveBeenCalledWith({
      where: { id: c, projectId: 'proj-1', channel: 'sms' },
    });
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: c, deviceIdentityId: i, type: 'delivered', platform: 'sms' }),
    );
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it("does not write to another project's campaign", async () => {
    logRepository.exists.mockResolvedValueOnce(false);
    await expect(
      service.ingest('proj-1', 'twilio', {
        type: 'delivered', address: '+14155550000', campaignId: c, identityId: i, occurredAt: at,
      }),
    ).resolves.toBe(0);
    expect(insert.execute).not.toHaveBeenCalled();
  });

  it('suppresses a permanent bounce and still records it', async () => {
    await service.ingest('proj-1', 'twilio', {
      type: 'bounced', permanent: true, address: '+14155550000', campaignId: c, identityId: i,
      occurredAt: at, detail: 'Twilio error 30005',
    });
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'proj-1', 'sms',
      [{ address: '+14155550000', reason: 'bounced', detail: 'Twilio error 30005' }],
      'twilio',
    );
    expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({ type: 'bounced' }));
  });

  it('records a temporary failure without suppressing the number', async () => {
    await service.ingest('proj-1', 'twilio', {
      type: 'bounced', permanent: false, address: '+14155550000', campaignId: c, identityId: i, occurredAt: at,
    });
    expect(suppressions.suppress).not.toHaveBeenCalled();
    expect(insert.values).toHaveBeenCalled();
  });

  it('suppresses an unsubscribe from a test send that names no campaign', async () => {
    await expect(
      service.ingest('proj-1', 'twilio', {
        type: 'unsubscribed', address: '+14155550000', campaignId: null, identityId: null, occurredAt: at,
      }),
    ).resolves.toBe(0);
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'proj-1', 'sms', [expect.objectContaining({ reason: 'unsubscribed' })], 'twilio',
    );
  });

  it('STOP suppresses; START lifts only the STOP, never a dead or hand-suppressed number', async () => {
    await service.keyword('proj-1', 'twilio', 'opt_out', '+14155550000');
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'proj-1', 'sms', [{ address: '+14155550000', reason: 'unsubscribed', detail: 'Replied STOP' }], 'twilio',
    );

    await service.keyword('proj-1', 'twilio', 'opt_in', '+14155550000');
    expect(suppressions.remove).toHaveBeenCalledWith('proj-1', 'sms', '+14155550000', { onlyReason: 'unsubscribed' });
  });
});

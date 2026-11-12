import { keywordOf, WhatsAppEventsService } from './whatsapp-events.service';

const C = '11111111-1111-4111-8111-111111111111';
const I = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-11-01T00:00:00Z');
const ERRORS = new Map<string, 'unsubscribed' | 'bounced'>([['131050', 'unsubscribed'], ['131026', 'bounced']]);

describe('keywordOf', () => {
  it.each(['STOP', 'stop', ' Stop. ', 'unsubscribe', 'Opt out'])('reads %p as an opt-out', (text) => {
    expect(keywordOf(text)).toBe('opt_out');
  });
  it.each(['START', 'subscribe'])('reads %p as an opt-in', (text) => {
    expect(keywordOf(text)).toBe('opt_in');
  });
  it('ignores a message that only mentions stopping', () => {
    expect(keywordOf('please stop sending these')).toBeNull();
  });
});

describe('WhatsAppEventsService', () => {
  const insert = { into: jest.fn(), values: jest.fn(), orIgnore: jest.fn(), execute: jest.fn() };
  const eventRepository = {
    createQueryBuilder: jest.fn(() => ({ insert: () => insert })),
    query: jest.fn(),
  };
  const logRepository = { find: jest.fn() };
  const identityRepository = { find: jest.fn() };
  const suppressions = { suppress: jest.fn(), remove: jest.fn() };
  let service: WhatsAppEventsService;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ['into', 'values', 'orIgnore'] as const) insert[key].mockReturnValue(insert);
    logRepository.find.mockResolvedValue([{ id: C }]);
    identityRepository.find.mockResolvedValue([{ id: I, phoneE164: '+919876543210' }]);
    service = new WhatsAppEventsService(
      eventRepository as never,
      logRepository as never,
      identityRepository as never,
      suppressions as never,
    );
  });

  const status = (over = {}) => ({
    kind: 'status' as const, status: 'read' as const, address: '+919876543210',
    campaignId: C, identityId: I, occurredAt: at, ...over,
  });

  it('records a read as an impression against an owned WhatsApp campaign', async () => {
    await expect(service.ingest('proj-1', 'meta', [status()], ERRORS, { signed: true })).resolves.toBe(1);
    expect(logRepository.find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: 'proj-1', channel: 'whatsapp' }),
    }));
    expect(insert.values).toHaveBeenCalledWith([expect.objectContaining({ type: 'impression', platform: 'whatsapp' })]);
  });

  it('suppresses a failure whose code means the person opted out, and records it as bounced', async () => {
    await service.ingest('proj-1', 'meta', [status({ status: 'failed', errorCode: '131050' })], ERRORS, { signed: true });
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'proj-1', 'whatsapp', [expect.objectContaining({ address: '+919876543210', reason: 'unsubscribed' })], 'meta',
      { verified: true },
    );
    expect(insert.values).toHaveBeenCalledWith([expect.objectContaining({ type: 'bounced' })]);
  });

  it('does not suppress an ordinary failure', async () => {
    await service.ingest('proj-1', 'meta', [status({ status: 'failed', errorCode: '131049' })], ERRORS, { signed: true });
    expect(suppressions.suppress).not.toHaveBeenCalled();
  });

  it('STOP suppresses; START lifts only a STOP', async () => {
    const reply = (text: string) => ({ kind: 'inbound' as const, address: '+919876543210', text, occurredAt: at });
    await service.ingest('proj-1', 'meta', [reply('STOP')], ERRORS, { signed: true });
    expect(suppressions.suppress).toHaveBeenCalledWith(
      'proj-1', 'whatsapp', [expect.objectContaining({ reason: 'unsubscribed' })], 'meta',
      { verified: true },
    );
    await service.ingest('proj-1', 'meta', [reply('start')], ERRORS, { signed: true });
    expect(suppressions.remove).toHaveBeenCalledWith('proj-1', 'whatsapp', '+919876543210', { onlyReason: 'unsubscribed' });
  });

  describe('unsigned (Gupshup, or no secret stored)', () => {
    it('ignores a STOP for a number nobody in the project has', async () => {
      identityRepository.find.mockResolvedValueOnce([]);
      await service.ingest(
        'proj-1', 'gupshup',
        [{ kind: 'inbound', address: '+10000000000', text: 'STOP', occurredAt: at }],
        ERRORS, { signed: false },
      );
      expect(suppressions.suppress).not.toHaveBeenCalled();
    });

    it('never lifts an opt-out on an unsigned START, even for a real number', async () => {
      await service.ingest(
        'proj-1', 'gupshup',
        [{ kind: 'inbound', address: '+919876543210', text: 'START', occurredAt: at }],
        ERRORS, { signed: false },
      );
      expect(suppressions.remove).not.toHaveBeenCalled();
    });

    it('still honours an unsigned STOP for a real number', async () => {
      await service.ingest(
        'proj-1', 'gupshup',
        [{ kind: 'inbound', address: '+919876543210', text: 'STOP', occurredAt: at }],
        ERRORS, { signed: false },
      );
      expect(suppressions.suppress).toHaveBeenCalledWith(
        'proj-1', 'whatsapp', [expect.objectContaining({ reason: 'unsubscribed' })], 'gupshup',
        // So consent history records it as `stop_reply_unsigned`.
        { verified: false },
      );
    });

    it('drops campaign tags that name a person who does not hold that number', async () => {
      identityRepository.find.mockResolvedValueOnce([{ id: 'someone-else', phoneE164: '+919876543210' }]);
      await expect(
        service.ingest('proj-1', 'interakt', [status()], ERRORS, { signed: false }),
      ).resolves.toBe(0);
      expect(insert.execute).not.toHaveBeenCalled();
    });
  });

  it("credits an untagged report to the number's latest WhatsApp campaign when asked to", async () => {
    eventRepository.query.mockResolvedValueOnce([{ address: '+919876543210', campaign_id: C, identity_id: I }]);
    await expect(
      service.ingest('proj-1', 'gupshup', [status({ campaignId: null, identityId: null, status: 'delivered' })], ERRORS, {
        signed: false,
        attributeByRecency: true,
      }),
    ).resolves.toBe(1);
    expect(eventRepository.query.mock.calls[0][0]).toMatch(/l\.channel = 'whatsapp'/);
    expect(insert.values).toHaveBeenCalledWith([expect.objectContaining({ campaignId: C, deviceIdentityId: I, type: 'delivered' })]);
  });

  it('writes nothing for a campaign this project does not own', async () => {
    logRepository.find.mockResolvedValueOnce([]);
    await expect(service.ingest('proj-1', 'meta', [status()], ERRORS, { signed: true })).resolves.toBe(0);
  });
});

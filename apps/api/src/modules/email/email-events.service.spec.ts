import { EmailEventsService } from './email-events.service';
import { EmailEvent } from './email-webhooks';

const PROJECT = 'proj-1';
const OWN = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const FOREIGN = '99999999-2222-4333-8444-555555555555';
const PERSON = '11111111-2222-4333-8444-555555555555';

const event = (over: Partial<EmailEvent>): EmailEvent => ({
  type: 'delivered',
  address: 'priya@example.com',
  campaignId: OWN,
  identityId: PERSON,
  occurredAt: new Date('2026-11-01T10:00:00Z'),
  ...over,
});

describe('EmailEventsService', () => {
  let inserted: unknown[];
  let suppressed: unknown[];
  let service: EmailEventsService;
  const logRepository = { find: jest.fn() };
  // Behaves like the table: only this project's identities, matched by email.
  const identities = [
    { id: PERSON, projectId: PROJECT, email: 'priya@example.com' },
    { id: '22222222-2222-4333-8444-555555555555', projectId: 'other', email: 'stranger@example.com' },
  ];
  const identityRepository = {
    find: jest.fn(async ({ where }: any) =>
      identities.filter(
        (row) => row.projectId === where.projectId && where.email._value.includes(row.email),
      ),
    ),
  };

  beforeEach(() => {
    inserted = [];
    suppressed = [];
    const qb: any = {
      insert: () => qb,
      into: () => qb,
      values: (rows: unknown[]) => {
        inserted.push(...rows);
        return qb;
      },
      orIgnore: () => qb,
      execute: async () => ({}),
    };
    // Behaves like the database: only campaigns of this project, on the email
    // channel, are found — whatever ids were asked for.
    logRepository.find.mockImplementation(async ({ where }: any) =>
      where.projectId === PROJECT && where.channel === 'email'
        ? [{ id: OWN }].filter((row) => where.id._value.includes(row.id))
        : [],
    );
    service = new EmailEventsService(
      { createQueryBuilder: () => qb } as never,
      logRepository as never,
      identityRepository as never,
      {
        suppress: async (_p: string, _c: string, entries: unknown[]) => {
          suppressed.push(...entries);
        },
      } as never,
    );
  });

  it('records engagement against the campaign and person the tags name', async () => {
    await service.ingest(PROJECT, 'ses', [event({ type: 'click' })]);
    expect(inserted).toEqual([
      expect.objectContaining({
        projectId: PROJECT,
        campaignId: OWN,
        deviceIdentityId: PERSON,
        type: 'click',
        platform: 'email',
      }),
    ]);
  });

  it('refuses to write to a campaign of another project', async () => {
    // The webhook token picks the project; a tag naming someone else's
    // campaign must not move that campaign's numbers.
    const recorded = await service.ingest(PROJECT, 'ses', [event({ campaignId: FOREIGN })]);
    expect(recorded).toBe(0);
    expect(inserted).toEqual([]);
  });

  it('suppresses a hard bounce and a complaint, but not a soft bounce', async () => {
    await service.ingest(PROJECT, 'ses', [
      event({ type: 'bounced', permanent: true, address: 'gone@example.com', detail: '550' }),
      event({ type: 'bounced', permanent: false, address: 'full@example.com' }),
      event({ type: 'complained', address: 'angry@example.com' }),
    ]);
    expect(suppressed).toEqual([
      { address: 'gone@example.com', reason: 'bounced', detail: '550' },
      { address: 'angry@example.com', reason: 'complained', detail: null },
    ]);
  });

  it('suppresses a bounce even when it cannot be tied to a campaign', async () => {
    await service.ingest(PROJECT, 'resend', [
      event({ type: 'bounced', permanent: true, campaignId: null, identityId: null }),
    ]);
    expect(suppressed).toHaveLength(1);
    expect(inserted).toEqual([]);
  });

  it('suppresses a provider-side unsubscribe without recording an event', async () => {
    await service.ingest(PROJECT, 'brevo', [event({ type: 'unsubscribed' })]);
    expect(suppressed).toEqual([
      { address: 'priya@example.com', reason: 'unsubscribed', detail: null },
    ]);
    expect(inserted).toEqual([]);
  });

  describe('unsigned events', () => {
    const unsigned = { signed: false };

    it('records engagement whose tagged person holds that address', async () => {
      await service.ingest(PROJECT, 'brevo', [event({ type: 'click' })], unsigned);
      expect(inserted).toHaveLength(1);
    });

    it('will not suppress an address nobody in the project has', async () => {
      // With a leaked webhook URL this is the attack: suppress arbitrary
      // addresses, or someone else's customers.
      await service.ingest(
        PROJECT,
        'brevo',
        [
          event({ type: 'complained', address: 'random@example.com', campaignId: null, identityId: null }),
          event({ type: 'complained', address: 'stranger@example.com', campaignId: null, identityId: null }),
        ],
        unsigned,
      );
      expect(suppressed).toEqual([]);
    });

    it('keeps the suppression but drops the campaign when tags do not match the address', async () => {
      await service.ingest(
        PROJECT,
        'brevo',
        [
          event({
            type: 'bounced',
            permanent: true,
            // Tags name a real person, but not the one who owns this address.
            identityId: '33333333-2222-4333-8444-555555555555',
          }),
        ],
        unsigned,
      );
      expect(suppressed).toHaveLength(1);
      expect(inserted).toEqual([]);
    });
  });
});

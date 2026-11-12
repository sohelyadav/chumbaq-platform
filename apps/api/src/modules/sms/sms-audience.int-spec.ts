import { DataSource } from 'typeorm';
import { SmsAudienceService } from './sms-audience.service';
import { AddressAudienceScope } from '../push-notifications/services/address-audience';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';

const A = 'dddddddd-0000-0000-0000-000000000001';
const B = 'dddddddd-0000-0000-0000-000000000002';
const C = 'dddddddd-0000-0000-0000-000000000003';
const CAMPAIGN = 'ffffffff-0000-0000-0000-000000000011';

/**
 * The SMS audience is the email audience's SQL with other columns. What is
 * worth asking Postgres is that the columns really were swapped everywhere:
 * an SMS send must dedupe on numbers, honour SMS suppressions and SMS
 * consent, and never be steered by email's.
 */
describe('SmsAudienceService (integration)', () => {
  let ds: DataSource;
  let service: SmsAudienceService;

  const person = async (
    id: string,
    phone: string | null,
    smsOptIn: boolean | null,
    extra: { email?: string; emailOptIn?: boolean } = {},
  ) => {
    await seedPerson(ds, { id });
    await ds.query(
      `UPDATE device_identities
       SET phone_e164 = $2, sms_opt_in = $3, email = $4, email_opt_in = $5
       WHERE id = $1`,
      [id, phone, smsOptIn, extra.email ?? null, extra.emailOptIn ?? null],
    );
  };

  const suppress = (channel: string, address: string) =>
    ds.query(
      `INSERT INTO channel_suppressions (project_id, channel, address, reason, source)
       VALUES ($1, $2, $3, 'unsubscribed', 'twilio')`,
      [INT_PROJECT_ID, channel, address],
    );

  const scope = (over: Partial<AddressAudienceScope> = {}): AddressAudienceScope => ({
    projectId: INT_PROJECT_ID,
    deviceIdentityIds: null,
    requireOptIn: true,
    ...over,
  });

  const numbers = async (s: AddressAudienceScope) =>
    (await service.page(s, null, 100, null, CAMPAIGN)).map((i) => i.phoneE164).sort();

  beforeAll(async () => {
    ds = await openIntDb();
    service = new SmsAudienceService(ds.getRepository(DeviceIdentityEntity));
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE channel_suppressions, push_notification_events, push_notification_logs RESTART IDENTITY CASCADE',
    );
    await resetFixtures(ds);
  });

  it('texts each opted-in number once, however many identities share it', async () => {
    await person(A, '+919876543210', true);
    await person(B, '+919876543210', true);
    await person(C, '+14155550100', true);

    expect(await numbers(scope())).toEqual(['+14155550100', '+919876543210']);
    expect((await service.listRecipientIds(scope())).sort()).toEqual([A, C]); // No order is promised.
  });

  it('follows SMS consent, not email consent', async () => {
    await person(A, '+919876543210', false, { email: 'a@example.com', emailOptIn: true });
    await person(B, '+14155550100', true, { email: 'b@example.com', emailOptIn: false });

    expect(await numbers(scope())).toEqual(['+14155550100']);
  });

  it('honours SMS suppressions and ignores email ones', async () => {
    await person(A, '+919876543210', true, { email: 'a@example.com' });
    await person(B, '+14155550100', true, { email: 'b@example.com' });
    await suppress('sms', '+919876543210');
    // Unsubscribing from email says nothing about texts.
    await suppress('email', 'b@example.com');

    expect(await numbers(scope())).toEqual(['+14155550100']);
  });

  it('skips people with no usable number, and an empty audience reaches nobody', async () => {
    await person(A, null, true, { email: 'a@example.com' });
    await person(B, '+14155550100', true);

    expect(await numbers(scope())).toEqual(['+14155550100']);
    expect(await service.count(scope({ deviceIdentityIds: [] }), null)).toBe(0);
  });

  it('without required opt-in, excludes only an explicit opt-out', async () => {
    await person(A, '+919876543210', null);
    await person(B, '+14155550100', false);

    expect(await numbers(scope({ requireOptIn: false }))).toEqual(['+919876543210']);
  });
});

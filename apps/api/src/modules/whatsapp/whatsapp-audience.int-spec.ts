import { DataSource } from 'typeorm';
import { WhatsAppAudienceService } from './whatsapp-audience.service';
import { AddressAudienceScope } from '../push-notifications/services/address-audience';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  openIntDb,
  closeIntDb,
  resetFixtures,
  seedPerson,
  INT_PROJECT_ID,
} from '../../test-support/int-db';

const A = 'cccccccc-0000-0000-0000-000000000001';
const B = 'cccccccc-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';
const CAMPAIGN = 'ffffffff-0000-0000-0000-000000000021';

/**
 * WhatsApp shares numbers with SMS but nothing else: its own consent, its
 * own suppressions. Asked of Postgres, because the columns are spliced into
 * SQL and a wrong one would still run.
 */
describe('WhatsAppAudienceService (integration)', () => {
  let ds: DataSource;
  let service: WhatsAppAudienceService;

  const person = async (id: string, phone: string | null, whatsapp: boolean | null, sms: boolean | null = null) => {
    await seedPerson(ds, { id });
    await ds.query(
      `UPDATE device_identities SET phone_e164 = $2, whatsapp_opt_in = $3, sms_opt_in = $4 WHERE id = $1`,
      [id, phone, whatsapp, sms],
    );
  };
  const suppress = (channel: string, address: string) =>
    ds.query(
      `INSERT INTO channel_suppressions (project_id, channel, address, reason, source)
       VALUES ($1, $2, $3, 'unsubscribed', 'meta')`,
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
    service = new WhatsAppAudienceService(ds.getRepository(DeviceIdentityEntity));
  });
  afterAll(async () => closeIntDb(ds));
  beforeEach(async () => {
    await ds.query('TRUNCATE channel_suppressions, push_notification_events, push_notification_logs RESTART IDENTITY CASCADE');
    await resetFixtures(ds);
  });

  it('follows WhatsApp consent, not SMS consent', async () => {
    await person(A, '+919876543210', false, true);
    await person(B, '+14155550100', true, false);
    expect(await numbers(scope())).toEqual(['+14155550100']);
  });

  it('honours WhatsApp suppressions and ignores SMS ones', async () => {
    await person(A, '+919876543210', true);
    await person(B, '+14155550100', true);
    await suppress('whatsapp', '+919876543210');
    // Replying STOP to a text says nothing about WhatsApp.
    await suppress('sms', '+14155550100');
    expect(await numbers(scope())).toEqual(['+14155550100']);
  });

  it('sends one message per number however many devices share it', async () => {
    await person(A, '+919876543210', true);
    await person(B, '+919876543210', true);
    await person(C, null, true);
    expect(await service.listRecipientIds(scope())).toEqual([A]);
  });
});

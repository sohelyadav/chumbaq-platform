import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb, resetFixtures, seedPerson, INT_PROJECT_ID } from '../../test-support/int-db';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ConsentEventsService } from '../consent/consent-events.service';
import { ConsentEventEntity } from '../consent/entities/consent-event.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { EmailAudienceService } from './email-audience.service';
import { EmailConfirmationsService } from './email-confirmations.service';

/**
 * Double opt-in, against Postgres: who is mailed a confirmation, once, and what a
 * confirmation from the mailbox does.
 */
describe('Email double opt-in (integration)', () => {
  let ds: DataSource;
  let service: EmailConfirmationsService;
  let audience: EmailAudienceService;
  let sent: Array<{ to: string; text: string }>;

  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'aaaaaaaa-0000-4000-8000-00000000000b';
  const C = 'aaaaaaaa-0000-4000-8000-00000000000c';

  const person = async (id: string, email: string, optIn: boolean | null) => {
    await seedPerson(ds, { id });
    await ds.query(`UPDATE device_identities SET email = $2, email_opt_in = $3 WHERE id = $1`, [id, email, optIn]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    const config = {
      get: (key: string) =>
        key === 'CREDENTIALS_ENCRYPTION_KEY' ? 'ab'.repeat(32) : key === 'app.baseUrl' ? 'https://api.example.test' : undefined,
    };
    const settings = {
      requireSendable: async () => ({
        settings: { provider: 'ses', fromEmail: 'news@acme.test', fromName: 'Acme', replyTo: null, postalAddress: '1 Main St' },
        credentials: {},
      }),
    };
    const registry = {
      get: () => ({
        sendToRecipients: async (_c: unknown, recipients: Array<{ token: string; message: { text: string } }>) => {
          for (const r of recipients) sent.push({ to: r.token, text: r.message.text });
          return { successCount: recipients.length, failures: [] };
        },
      }),
    };
    service = new EmailConfirmationsService(
      ds,
      settings as never,
      registry as never,
      { url: () => 'https://api.example.test/api/email/unsubscribe' } as never,
      new ConsentEventsService(ds.getRepository(ConsentEventEntity)),
      new CredentialsCryptoService(config as unknown as ConfigService),
      config as unknown as ConfigService,
    );
    audience = new EmailAudienceService(ds.getRepository(DeviceIdentityEntity));
  });

  afterAll(() => closeIntDb(ds));

  beforeEach(async () => {
    sent = [];
    await ds.query('TRUNCATE channel_suppressions RESTART IDENTITY CASCADE');
    await resetFixtures(ds);
    await ds.query(`DELETE FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await ds.query(
      `INSERT INTO email_settings (project_id, from_email, postal_address, webhook_token, provider, require_opt_in)
       VALUES ($1, 'news@acme.test', '1 Main St', $2, 'ses', true)`,
      [INT_PROJECT_ID, randomBytes(24).toString('hex')],
    );
  });

  const linkIn = (text: string) => new URL(/https:\/\/\S+\/api\/email\/confirm\?\S+/.exec(text)![0]);

  it('mails each opted-in, unconfirmed address once, and never again within the week', async () => {
    await person(A, 'priya@example.com', true);
    await person(B, 'priya@example.com', true);
    await person(C, 'never@example.com', false);

    expect(await service.sendPending()).toBe(1);
    expect(sent.map((m) => m.to)).toEqual(['priya@example.com']);
    expect(await service.sendPending()).toBe(0);
  });

  it('mails no suppressed address, and none for a project that does not require opt-in', async () => {
    await person(A, 'gone@example.com', true);
    await ds.query(
      `INSERT INTO channel_suppressions (project_id, channel, address, reason, source) VALUES ($1, 'email', 'gone@example.com', 'unsubscribed', 'link')`,
      [INT_PROJECT_ID],
    );
    expect(await service.sendPending()).toBe(0);

    await person(B, 'open@example.com', true);
    await ds.query(`UPDATE email_settings SET require_opt_in = false WHERE project_id = $1`, [INT_PROJECT_ID]);
    expect(await service.sendPending()).toBe(0);
  });

  it('counts the address in only once its holder confirms, over any earlier refusal', async () => {
    await person(A, 'priya@example.com', false);
    await person(B, 'priya@example.com', true);
    const scope = { projectId: INT_PROJECT_ID, deviceIdentityIds: null, requireOptIn: true };
    expect(await audience.listRecipientIds(scope)).toEqual([]);

    await service.sendPending();
    const link = linkIn(sent[0].text);
    const address = service.verify(link.searchParams.get('p'), link.searchParams.get('e'), link.searchParams.get('s'));
    expect(address).toBe('priya@example.com');
    await service.confirm(INT_PROJECT_ID, address as string);

    expect(await audience.listRecipientIds(scope)).toEqual([A]);
    const history = await ds.query(
      `SELECT DISTINCT source, granted FROM consent_events WHERE device_identity_id = ANY($1::uuid[])`,
      [[A, B]],
    );
    expect(history).toEqual([{ source: 'email_confirmation', granted: true }]);
  });

  it('does not take a link for another address or project', async () => {
    await person(A, 'priya@example.com', true);
    await service.sendPending();
    const link = linkIn(sent[0].text);
    const e = Buffer.from('someone-else@example.com').toString('base64url');
    expect(service.verify(link.searchParams.get('p'), e, link.searchParams.get('s'))).toBeNull();
    expect(service.verify('11111111-1111-4111-8111-111111111112', link.searchParams.get('e'), link.searchParams.get('s'))).toBeNull();
  });
});

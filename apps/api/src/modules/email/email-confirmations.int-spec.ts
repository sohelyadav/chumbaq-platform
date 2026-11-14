import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb, resetFixtures, seedPerson, INT_PROJECT_ID } from '../../test-support/int-db';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ConsentEventsService } from '../consent/consent-events.service';
import { ConsentEventEntity } from '../consent/entities/consent-event.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { EmailAudienceService } from './email-audience.service';
import { EmailConfirmationsService, mailboxOf } from './email-confirmations.service';

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
    await ds.query('TRUNCATE channel_suppressions, email_confirmation_sends RESTART IDENTITY CASCADE');
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
    const signed = service.verify(link.searchParams.get('p'), link.searchParams.get('e'), link.searchParams.get('s'));
    expect(signed?.address).toBe('priya@example.com');
    expect(await service.confirm(INT_PROJECT_ID, signed!.address, signed!.sentAt)).toBe(2);

    expect(await audience.listRecipientIds(scope)).toEqual([A]);
    const history = await ds.query(
      `SELECT DISTINCT source, granted FROM consent_events WHERE device_identity_id = ANY($1::uuid[])`,
      [[A, B]],
    );
    expect(history).toEqual([{ source: 'email_confirmation', granted: true }]);
  });

  // Following review: a link is for one send, so an old one cannot undo a later "no".
  it('does not let a confirmation override a refusal made after the link was sent', async () => {
    await person(A, 'priya@example.com', true);
    await service.sendPending();
    const link = linkIn(sent[0].text);
    const signed = service.verify(link.searchParams.get('p'), link.searchParams.get('e'), link.searchParams.get('s'))!;
    await ds.query(`UPDATE device_identities SET email_opt_in = false, consent_updated_at = now() + interval '1 second' WHERE id = $1`, [A]);

    expect(await service.confirm(INT_PROJECT_ID, signed.address, signed.sentAt)).toBe(0);
    const scope = { projectId: INT_PROJECT_ID, deviceIdentityIds: null, requireOptIn: true };
    expect(await audience.listRecipientIds(scope)).toEqual([]);
  });

  it('takes only the latest send\'s link, and none older than a week', async () => {
    await person(A, 'priya@example.com', true);
    await service.sendPending();
    const old = linkIn(sent[0].text);
    const signed = service.verify(old.searchParams.get('p'), old.searchParams.get('e'), old.searchParams.get('s'))!;
    // A later send (a week on) replaces it.
    await ds.query(`UPDATE email_confirmation_sends SET last_sent_at = now() - interval '8 days'`);
    await ds.query(`UPDATE device_identities SET email_confirm_sent_at = now() - interval '8 days' WHERE id = $1`, [A]);
    await service.sendPending();
    expect(await service.confirm(INT_PROJECT_ID, signed.address, signed.sentAt)).toBe(0);

    const stale = service.url(INT_PROJECT_ID, 'priya@example.com', new Date(Date.now() - 8 * 86_400_000));
    const u = new URL(stale);
    expect(service.verify(u.searchParams.get('p'), u.searchParams.get('e'), u.searchParams.get('s'))).toBeNull();
  });

  // Following review: rows are made and changed by anyone with the app's key; the
  // weekly limit is the address's, not the row's.
  it('mails an address at most once a week however its rows change', async () => {
    await person(A, 'victim@example.com', true);
    expect(await service.sendPending()).toBe(1);
    await ds.query(`UPDATE device_identities SET email = 'elsewhere@example.com', email_confirm_sent_at = NULL WHERE id = $1`, [A]);
    await ds.query(`UPDATE device_identities SET email = 'victim@example.com', email_confirm_sent_at = NULL WHERE id = $1`, [A]);
    await person(B, 'victim@example.com', true);
    expect(await service.sendPending()).toBe(0);
    expect(sent.map((m) => m.to)).toEqual(['victim@example.com']);
  });

  it('does not take a link for another address or project', async () => {
    await person(A, 'priya@example.com', true);
    await service.sendPending();
    const link = linkIn(sent[0].text);
    const e = Buffer.from('someone-else@example.com').toString('base64url');
    expect(service.verify(link.searchParams.get('p'), e, link.searchParams.get('s'))).toBeNull();
    expect(service.verify('11111111-1111-4111-8111-111111111112', link.searchParams.get('e'), link.searchParams.get('s'))).toBeNull();
  });

  // Following review: every spelling of one inbox shares its limit.
  it('counts plus-tags and Gmail dots as the same inbox', async () => {
    expect(mailboxOf('Victim+promo@Example.com')).toBe('victim@example.com');
    expect(mailboxOf('v.i.c.t.i.m+1@googlemail.com')).toBe('victim@gmail.com');
    expect(mailboxOf('victim@Gmail.com.')).toBe('victim@gmail.com');
    expect(mailboxOf('who@bücher.example')).toBe('who@xn--bcher-kva.example');
    await person(A, 'victim@gmail.com', true);
    await person(B, 'v.ictim+2@gmail.com', true);
    expect(await service.sendPending()).toBe(1);
    // The refused spelling leaves the due set, so it does not block other work.
    const [row] = await ds.query(`SELECT email_confirm_sent_at FROM device_identities WHERE id = $1`, [B]);
    expect(row.email_confirm_sent_at).not.toBeNull();
    expect(await service.sendPending()).toBe(0);
  });
});

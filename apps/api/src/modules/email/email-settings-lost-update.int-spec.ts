import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { closeIntDb, INT_PROJECT_ID, openIntDb, resetFixtures } from '../../test-support/int-db';
import { EmailSettingsEntity } from './entities/email-settings.entity';
import { EmailSettingsService } from './email-settings.service';
import { SmsSettingsEntity } from '../sms/entities/sms-settings.entity';
import { SmsSettingsService } from '../sms/sms-settings.service';
import { WhatsAppSettingsEntity } from '../whatsapp/entities/whatsapp-settings.entity';
import { WhatsAppSettingsService } from '../whatsapp/whatsapp-settings.service';

const OLD_TOKEN = 'ab'.repeat(24);
const TOPIC = 'arn:aws:sns:ap-south-1:123456789012:events';
const config = { get: (key: string) => (key === 'app.baseUrl' ? 'https://api.example' : undefined) } as unknown as ConfigService;
const credentialStore = {
  upsert: async () => undefined,
  replace: async () => true,
  getPlaintext: async () => null,
};
/** The activity log is the activity specs' to test; these runs only need it to accept. */
const noLog = { record: async () => undefined } as never;
const ACTOR = '00000000-0000-4000-8000-000000000001';
const CTX = { ipAddress: null, userAgent: null };

/**
 * Settings saves wait on the provider (a credentials check can take seconds),
 * and a token rotation, topic pin or opt-in change can land in that wait. The
 * save must write only its own columns, or it puts back what was replaced:
 * a rotated webhook token would start working again.
 */
describe('Messaging settings saves do not undo concurrent changes (integration)', () => {
  let ds: DataSource;
  let emailRepo: Repository<EmailSettingsEntity>;

  /** A registry whose credentials check runs `during` before it answers. */
  const registryRunning = (during: () => Promise<unknown>) => ({
    get: () => ({ validateCredentials: async () => void (await during()) }),
  });

  const emailService = (during: () => Promise<unknown> = async () => undefined) =>
    new EmailSettingsService(emailRepo, credentialStore as never, registryRunning(during) as never, config, noLog);

  const emailRow = async () =>
    (await ds.query(`SELECT * FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]))[0];

  /**
   * Resolves once `work` has finished, or once `count` other sessions are waiting on a
   * row lock on email_settings: whichever comes first. Without the lock the other
   * requests run to the end inside the window; with it they wait, and waiting for them
   * there would deadlock.
   */
  const doneOrWaitingOnLocks = async (work: Promise<unknown>, count: number) => {
    let done = false;
    void work.then(
      () => (done = true),
      () => (done = true),
    );
    const deadline = Date.now() + 10_000;
    while (!done) {
      const [{ waiting }] = await ds.query(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%email_settings%'`,
      );
      if (waiting >= count) return;
      if (Date.now() > deadline) throw new Error('The other requests neither finished nor waited on the row lock');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeAll(async () => {
    ds = await openIntDb();
    await resetFixtures(ds);
    emailRepo = ds.getRepository(EmailSettingsEntity);
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await ds.query(`DELETE FROM sms_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await ds.query(`DELETE FROM whatsapp_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await ds.query(
      `INSERT INTO email_settings (project_id, from_email, postal_address, webhook_token)
       VALUES ($1, 'news@example.com', '1 Main St', $2)`,
      [INT_PROJECT_ID, OLD_TOKEN],
    );
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await ds.query(`DELETE FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await ds.query(`DELETE FROM sms_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await ds.query(`DELETE FROM whatsapp_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await closeIntDb(ds);
  });

  it('email connect: a token rotation during the credentials check survives', async () => {
    let rotated = '';
    const service = emailService(async () => {
      const status = await emailService().rotateWebhookToken(INT_PROJECT_ID, ACTOR, CTX);
      rotated = status.webhookUrls!.ses.split('/').pop()!;
    });

    const result = await service.connect({ projectId: INT_PROJECT_ID, provider: 'resend', credentials: '{"apiKey":"re_x"}' }, ACTOR, CTX);

    expect(rotated).toMatch(/^[0-9a-f]{48}$/);
    expect(rotated).not.toBe(OLD_TOKEN);
    const row = await emailRow();
    expect(row.webhook_token).toBe(rotated);
    expect(row.provider).toBe('resend');
    expect(result.webhookUrls!.resend).toBe(`https://api.example/api/email/webhooks/resend/${rotated}`);
    // The old URL must stay dead.
    expect(await emailService().findByWebhookToken(OLD_TOKEN)).toBeNull();
  });

  it('email connect: a topic switch during the credentials check survives', async () => {
    await ds.query(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [INT_PROJECT_ID, TOPIC]);
    const service = emailService(() => emailService().resetSesTopic(INT_PROJECT_ID, ACTOR, CTX));

    await service.connect({ projectId: INT_PROJECT_ID, provider: 'ses', credentials: '{}' }, ACTOR, CTX);

    const row = await emailRow();
    expect(row.ses_topic_arn).toBeNull();
    expect(row.provider).toBe('ses');
  });

  it('email update: a topic pin and a rotation arriving between its read and its write survive', async () => {
    const { id } = await emailRow();
    // The window is inside the update's transaction: right after it has read the row
    // it compares against, before it writes. Two other requests start there, a topic
    // pin and a token rotation, and are not awaited: the update holds the row lock,
    // so they must wait for its commit and land after it, never under it.
    let others: Promise<[void, string]> | undefined;
    const findOne = Repository.prototype.findOne;
    jest.spyOn(Repository.prototype, 'findOne').mockImplementation(async function (
      this: Repository<EmailSettingsEntity>,
      options,
    ) {
      const found = await findOne.call(this, options);
      if (!others && this.metadata.target === EmailSettingsEntity && this.queryRunner?.isTransactionActive) {
        others = Promise.all([
          emailService().pinSesTopic(id, TOPIC),
          emailService()
            .rotateWebhookToken(INT_PROJECT_ID, ACTOR, CTX)
            .then((status) => status.webhookUrls!.ses.split('/').pop()!),
        ]);
        await doneOrWaitingOnLocks(others, 2);
      }
      return found;
    } as typeof findOne);

    await emailService().update({
      projectId: INT_PROJECT_ID,
      fromEmail: 'Hello@Example.com',
      fromName: 'Shop',
      postalAddress: '2 High St',
      requireOptIn: false,
    }, ACTOR, CTX);

    expect(others).toBeDefined();
    const [, rotated] = await others!;
    expect(rotated).toMatch(/^[0-9a-f]{48}$/);
    expect(rotated).not.toBe(OLD_TOKEN);
    const row = await emailRow();
    expect(row.ses_topic_arn).toBe(TOPIC);
    expect(row.webhook_token).toBe(rotated);
    expect(row).toMatchObject({
      from_email: 'hello@example.com',
      from_name: 'Shop',
      postal_address: '2 High St',
      require_opt_in: false,
    });
  });

  it('email update: creates the row the first time, with a fresh token, and leaves opt-in at its default', async () => {
    await ds.query(`DELETE FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    const results = await Promise.all([
      emailService().update({ projectId: INT_PROJECT_ID, fromEmail: 'a@example.com', postalAddress: '1 Main St' }, ACTOR, CTX),
      emailService().update({ projectId: INT_PROJECT_ID, fromEmail: 'a@example.com', postalAddress: '1 Main St' }, ACTOR, CTX),
    ]);
    expect(results.every((status) => status.configured)).toBe(true);
    const rows = await ds.query(`SELECT * FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].webhook_token).toMatch(/^[0-9a-f]{48}$/);
    expect(rows[0].require_opt_in).toBe(true);
    expect(rows[0].provider).toBeNull();
  });

  it('SMS connect: an opt-in change during the credentials check survives', async () => {
    const repo = ds.getRepository(SmsSettingsEntity);
    const plain = new SmsSettingsService(repo, credentialStore as never, registryRunning(async () => undefined) as never, config, noLog);
    await plain.update({ projectId: INT_PROJECT_ID, sender: '+14155550100' }, ACTOR, CTX);

    const service = new SmsSettingsService(
      repo,
      credentialStore as never,
      registryRunning(() => plain.update({ projectId: INT_PROJECT_ID, sender: '+14155550199', requireOptIn: false }, ACTOR, CTX)) as never,
      config,
     noLog);
    await service.connect({ projectId: INT_PROJECT_ID, provider: 'twilio', credentials: '{}' }, ACTOR, CTX);

    const [row] = await ds.query(`SELECT * FROM sms_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    expect(row).toMatchObject({ provider: 'twilio', sender: '+14155550199', require_opt_in: false });
  });

  it('WhatsApp connect: an opt-in change during the credentials check survives', async () => {
    const repo = ds.getRepository(WhatsAppSettingsEntity);
    const plain = new WhatsAppSettingsService(repo, credentialStore as never, registryRunning(async () => undefined) as never, config, noLog);
    await plain.ensure(INT_PROJECT_ID);

    const service = new WhatsAppSettingsService(
      repo,
      credentialStore as never,
      registryRunning(() => plain.update({ projectId: INT_PROJECT_ID, requireOptIn: false }, ACTOR, CTX)) as never,
      config,
     noLog);
    await service.connect({ projectId: INT_PROJECT_ID, provider: 'meta', credentials: '{}' }, ACTOR, CTX);

    const [row] = await ds.query(`SELECT * FROM whatsapp_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    expect(row).toMatchObject({ provider: 'meta', require_opt_in: false });
  });

  it('WhatsApp: two first uses at once make one row and no error', async () => {
    const repo = ds.getRepository(WhatsAppSettingsEntity);
    const service = new WhatsAppSettingsService(repo, credentialStore as never, registryRunning(async () => undefined) as never, config, noLog);
    const [a, b] = await Promise.all([service.ensure(INT_PROJECT_ID), service.ensure(INT_PROJECT_ID)]);
    expect(a.id).toBe(b.id);
    const rows = await ds.query(`SELECT id FROM whatsapp_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    expect(rows).toHaveLength(1);
  });
});

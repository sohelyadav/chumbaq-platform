import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, INT_PROJECT_ID, openIntDb, resetFixtures } from '../../test-support/int-db';
import { EmailSettingsEntity } from './entities/email-settings.entity';
import { EmailSettingsService } from './email-settings.service';
import { EmailController } from './email.controller';
import { EmailPublicController } from './email-public.controller';

/** The activity log is the activity specs' to test; these runs only need it to accept. */
const noLog = { record: async () => undefined } as never;
const ACTOR = '00000000-0000-4000-8000-000000000001';
const REQ = { headers: {}, ip: '127.0.0.1' } as never;

const OLD_TOKEN = 'ab'.repeat(24);

/**
 * Rotating the webhook token is how a tenant ends a leaked webhook URL, so
 * the proof is the real lookup against Postgres: the old URL finds nothing,
 * the new one finds the project.
 */
describe('Rotating the email webhook token (integration)', () => {
  let ds: DataSource;
  let settings: EmailSettingsService;
  let dashboard: EmailController;
  let webhooks: EmailPublicController;

  const status = (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (error: unknown) => (error instanceof HttpException ? error.getStatus() : 500),
    );

  beforeAll(async () => {
    ds = await openIntDb();
    await resetFixtures(ds);
    settings = new EmailSettingsService(
      ds.getRepository(EmailSettingsEntity),
      { getPlaintext: async () => null } as never,
      {} as never,
      { get: (key: string) => (key === 'app.baseUrl' ? 'https://api.example' : undefined) } as unknown as ConfigService,
     noLog);
    dashboard = new EmailController(
      settings,
      {} as never,
      {} as never,
    );
    webhooks = new EmailPublicController(settings, {} as never, {} as never, { ingest: async () => 0 } as never, {} as never);
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await ds.query(
      `INSERT INTO email_settings (project_id, from_email, postal_address, webhook_token, ses_topic_arn)
       VALUES ($1, 'news@example.com', '1 Main St', $2, 'arn:aws:sns:ap-south-1:123456789012:t')`,
      [INT_PROJECT_ID, OLD_TOKEN],
    );
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    await closeIntDb(ds);
  });

  it('gives new webhook URLs and the old ones stop at once', async () => {
    const before = await status(webhooks.sesWebhook(OLD_TOKEN, { body: '{}' } as never));
    // Found the project (refused only for the body), so the 404 below is the rotation's doing.
    expect(before).toBe(401);

    const rotated = await dashboard.rotateWebhookToken(INT_PROJECT_ID, ACTOR, REQ);
    const newToken = rotated.webhookUrls!.ses.split('/').pop()!;
    expect(newToken).toMatch(/^[0-9a-f]{48}$/);
    expect(newToken).not.toBe(OLD_TOKEN);
    expect(rotated.webhookUrls).toEqual({
      ses: `https://api.example/api/email/webhooks/ses/${newToken}`,
      resend: `https://api.example/api/email/webhooks/resend/${newToken}`,
      brevo: `https://api.example/api/email/webhooks/brevo/${newToken}`,
    });

    expect(await status(webhooks.sesWebhook(OLD_TOKEN, { body: '{}' } as never))).toBe(404);
    expect(await status(webhooks.brevoWebhook(OLD_TOKEN, { body: {} } as never))).toBe(404);
    expect(await status(webhooks.sesWebhook(newToken, { body: '{}' } as never))).toBe(401);
    expect(await status(webhooks.brevoWebhook(newToken, { body: {} } as never))).toBe(200);

    // The confirmed topic stays: SNS re-confirms the same topic at the new URL.
    const [row] = await ds.query(`SELECT ses_topic_arn FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    expect(row.ses_topic_arn).toBe('arn:aws:sns:ap-south-1:123456789012:t');
  });

  // The SES webhook counts certificate fetches per account from this, with no second lookup.
  it("finds the project's owner with the settings", async () => {
    const found = await settings.findByWebhookToken(OLD_TOKEN);
    const [{ owner_id }] = await ds.query(`SELECT owner_id FROM projects WHERE id = $1`, [INT_PROJECT_ID]);
    expect(found?.project.ownerId).toBe(owner_id);
  });

  it('refuses to rotate for a project without email set up', async () => {
    await ds.query(`DELETE FROM email_settings WHERE project_id = $1`, [INT_PROJECT_ID]);
    expect(await status(dashboard.rotateWebhookToken(INT_PROJECT_ID, ACTOR, REQ))).toBe(404);
  });
});

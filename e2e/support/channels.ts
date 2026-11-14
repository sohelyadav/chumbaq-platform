import { createCipheriv, generateKeyPairSync, randomBytes } from 'crypto';
import { Client } from 'pg';
import { assertE2eDatabase, runSecrets, stackEnv } from './stack';

/**
 * Channel connections seeded straight into the e2e database, for the pages and routes
 * that need a connected provider but are not about connecting one. A real connect checks
 * the credentials with the provider first, which an offline run cannot do; everything
 * after that check is reproduced here, column for column:
 *
 * - credentials go in `push_channel_credentials` under the provider's name, sealed with
 *   the run's CREDENTIALS_ENCRYPTION_KEY in the API's envelope (AES-256-GCM, 16-byte IV,
 *   hex parts), holding the JSON the dashboard's connect form sends, `is_active` true,
 *   replacing an earlier row for the same provider (as `ChannelCredentialsService.replace`);
 * - the channel's settings row is created as its first save creates it (random 48-hex
 *   webhook token, the defaults the services use) unless one exists, and its `provider`
 *   column is set, which is all the connect writes to it.
 *
 * Not reproduced: the activity log entry a connect writes (`channel.provider_changed` or
 * `channel.credentials_uploaded`), since no person made this change. Every value is fake
 * and nothing is ever sent with it. Writes go to the e2e database only (its name is
 * checked as in reset.ts).
 */

async function withDatabase<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const env = stackEnv();
  const client = new Client({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT || 5432),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: assertE2eDatabase(env),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** `CredentialsCryptoService.encrypt`, under `keyHex` (the run's key unless given). */
function seal(plaintext: string, keyHex = runSecrets().credentialsKey): Sealed {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return { ciphertext, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

/** Stores a sealed credential for (project, provider), replacing any, switched on. */
async function storeCredential(db: Client, projectId: string, provider: string, sealed: Sealed): Promise<void> {
  await db.query(
    `INSERT INTO push_channel_credentials (project_id, provider, credentials_encrypted, credentials_iv, credentials_tag, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (project_id, provider) DO UPDATE
       SET credentials_encrypted = EXCLUDED.credentials_encrypted,
           credentials_iv = EXCLUDED.credentials_iv,
           credentials_tag = EXCLUDED.credentials_tag,
           is_active = true,
           updated_at = now()`,
    [projectId, provider, sealed.ciphertext, sealed.iv, sealed.tag],
  );
}

/**
 * The API's provider names (`EMAIL_PROVIDERS`, `WHATSAPP_PROVIDERS` in its message-channel.ts),
 * copied: importing that file would type-check the entities behind it, decorators and all.
 */
export type EmailProviderName = 'ses' | 'resend' | 'brevo';
export type WhatsAppProviderName = 'meta' | 'twilio_whatsapp' | 'gupshup' | 'interakt';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const digits = (count: number) => Array.from(randomBytes(count), (byte) => String(byte % 10)).join('').replace(/^0/, '1');
/** A webhook token as every channel's settings row makes one. */
const newWebhookToken = () => randomBytes(24).toString('hex');

// ------------------------------------------------------------------- push ---

export interface FakeServiceAccount {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

/**
 * A Firebase service account key file with every field a real one has and a freshly
 * made RSA key, so anything that only signs with it works. Google never issued it:
 * exchanging it for a token fails.
 */
export function fakeServiceAccount(firebaseProjectId = `e2e-fcm-${hex(3)}`): FakeServiceAccount {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: firebaseProjectId,
    private_key_id: hex(20),
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: `firebase-adminsdk-e2e@${firebaseProjectId}.iam.gserviceaccount.com`,
    client_id: digits(21),
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}

/** The `push_configs` row as the first FCM upload creates it (only `is_active`), or switched back on. */
async function ensurePushConfig(db: Client, projectId: string): Promise<void> {
  await db.query(
    `INSERT INTO push_configs (project_id, is_active) VALUES ($1, true)
     ON CONFLICT (project_id) DO UPDATE SET is_active = true, updated_at = now()`,
    [projectId],
  );
}

/**
 * FCM configured as an upload of a service account would leave it: the key file stored
 * as uploaded (pretty-printed, as downloaded from Firebase) and the project's push config
 * on. Returns the key file, whose `project_id` and `client_email` the settings page shows.
 */
export async function seedFcmConfig(projectId: string, account: FakeServiceAccount = fakeServiceAccount()): Promise<FakeServiceAccount> {
  const sealed = seal(JSON.stringify(account, null, 2));
  await withDatabase(async (db) => {
    await storeCredential(db, projectId, 'fcm', sealed);
    await ensurePushConfig(db, projectId);
  });
  return account;
}

/**
 * FCM configured, but with a stored credential the API cannot use:
 * - `bad-ciphertext`: sealed under a different key (as after the encryption key changed),
 *   so decrypting fails its authentication tag;
 * - `not-json`: decrypts, but is not JSON.
 * The settings page then reports the credentials as unreadable rather than missing.
 */
export async function seedUnreadableFcmConfig(projectId: string, kind: 'bad-ciphertext' | 'not-json'): Promise<void> {
  const sealed =
    kind === 'bad-ciphertext'
      ? seal(JSON.stringify(fakeServiceAccount()), randomBytes(32).toString('hex'))
      : seal('this is not a service account {');
  await withDatabase(async (db) => {
    await storeCredential(db, projectId, 'fcm', sealed);
    await ensurePushConfig(db, projectId);
  });
}

/** Deletes the project's FCM credential row, leaving its push config: configured, credential gone. */
export async function deleteFcmCredentialRow(projectId: string): Promise<void> {
  await withDatabase(async (db) => {
    const deleted = await db.query(`DELETE FROM push_channel_credentials WHERE project_id = $1 AND provider = 'fcm'`, [projectId]);
    if (deleted.rowCount !== 1) throw new Error('The project has no FCM credential row to delete');
  });
}

// ------------------------------------------------------------------ email ---

export interface EmailSender {
  fromEmail: string;
  fromName?: string | null;
  replyTo?: string | null;
  postalAddress: string;
  requireOptIn?: boolean;
}

export const DEFAULT_EMAIL_SENDER: EmailSender = {
  fromEmail: 'news@e2e.example.test',
  fromName: 'E2E News',
  postalAddress: 'E2E Labs, 1 Test Street, Testville 000000',
};

export type SesCredentials = { region: string; accessKeyId: string; secretAccessKey: string; configurationSetName?: string };
export type ResendCredentials = { apiKey: string; webhookSecret?: string };
export type BrevoCredentials = { apiKey: string };
export interface EmailCredentialsByProvider {
  ses: SesCredentials;
  resend: ResendCredentials;
  brevo: BrevoCredentials;
}

/** A Resend (Svix) webhook signing secret: `whsec_` and base64 key bytes. */
export function fakeSvixSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/** Fake credentials in the shape each provider's form sends (and the API's checks accept). */
export function fakeEmailCredentials<P extends EmailProviderName>(provider: P): EmailCredentialsByProvider[P] {
  const byProvider: EmailCredentialsByProvider = {
    ses: {
      region: 'ap-south-1',
      accessKeyId: `AKIAE2E${randomBytes(7).toString('hex').toUpperCase()}`.slice(0, 20),
      secretAccessKey: randomBytes(30).toString('base64').slice(0, 40),
      configurationSetName: 'e2e-events',
    },
    resend: { apiKey: `re_e2e_${hex(12)}`, webhookSecret: fakeSvixSecret() },
    brevo: { apiKey: `xkeysib-e2e-fake-${hex(8)}` },
  };
  return byProvider[provider];
}

export interface SeededEmail<P extends EmailProviderName> {
  provider: P;
  credentials: EmailCredentialsByProvider[P];
  /** The secret path segment of the project's email webhook URLs. */
  webhookToken: string;
}

/**
 * Stores credentials for one email provider, as a successful connect would, and (unless
 * `activate` is false) makes it the provider campaigns use. The sender row is created
 * first if the project has none, as the Settings form's first save would (the real
 * connect refuses without one); an existing sender is left as it is.
 */
export async function seedEmailCredentials<P extends EmailProviderName>(
  projectId: string,
  provider: P,
  options: { credentials?: EmailCredentialsByProvider[P]; activate?: boolean; sender?: EmailSender } = {},
): Promise<SeededEmail<P>> {
  const credentials = options.credentials ?? fakeEmailCredentials(provider);
  const sender = options.sender ?? DEFAULT_EMAIL_SENDER;
  const sealed = seal(JSON.stringify(credentials));
  const webhookToken = await withDatabase(async (db) => {
    await db.query(
      `INSERT INTO email_settings (project_id, provider, from_email, from_name, reply_to, postal_address, require_opt_in, webhook_token, ses_topic_arn)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT (project_id) DO NOTHING`,
      [
        projectId,
        sender.fromEmail.trim().toLowerCase(),
        sender.fromName?.trim() || null,
        sender.replyTo ? sender.replyTo.trim().toLowerCase() : null,
        sender.postalAddress.trim(),
        sender.requireOptIn ?? true,
        newWebhookToken(),
      ],
    );
    await storeCredential(db, projectId, provider, sealed);
    if (options.activate !== false) {
      await db.query(`UPDATE email_settings SET provider = $2, updated_at = now() WHERE project_id = $1`, [projectId, provider]);
    }
    const row = await db.query<{ webhook_token: string }>(`SELECT webhook_token FROM email_settings WHERE project_id = $1`, [projectId]);
    return row.rows[0].webhook_token;
  });
  return { provider, credentials, webhookToken };
}

/** The path of the project's webhook for an email provider (sign and post to it on the API). */
export function emailWebhookPath(provider: EmailProviderName, webhookToken: string): string {
  return `/api/email/webhooks/${provider}/${webhookToken}`;
}

// -------------------------------------------------------------------- sms ---

/** Twilio's shapes: `AC` + 32 hex for the Account SID, 32 hex for the Auth Token. */
export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

export function fakeTwilioCredentials(): TwilioCredentials {
  return { accountSid: `AC${hex(16)}`, authToken: hex(16) };
}

export interface SeededSms {
  credentials: TwilioCredentials;
  sender: string;
  webhookToken: string;
}

/** The opt-out line a new SMS settings row starts with (`DEFAULT_OPT_OUT_TEXT` in the API). */
const SMS_DEFAULT_OPT_OUT_TEXT = 'Reply STOP to opt out.';

/**
 * Twilio connected for SMS: the sender saved (as the Settings form's first save, if the
 * project has no SMS settings yet; an existing row keeps its own), then the credentials
 * stored and Twilio made the provider. Returns what a webhook test needs: the Auth Token
 * (Twilio signs with it) and the webhook token in the URLs.
 */
export async function connectFakeSmsProvider(
  projectId: string,
  options: { credentials?: TwilioCredentials; sender?: string; requireOptIn?: boolean; optOutText?: string | null } = {},
): Promise<SeededSms> {
  const credentials = options.credentials ?? fakeTwilioCredentials();
  const sender = (options.sender ?? '+15005550006').trim();
  const sealed = seal(JSON.stringify(credentials));
  const row = await withDatabase(async (db) => {
    await db.query(
      `INSERT INTO sms_settings (project_id, provider, sender, require_opt_in, opt_out_text, webhook_token)
       VALUES ($1, NULL, $2, $3, $4, $5)
       ON CONFLICT (project_id) DO NOTHING`,
      [
        projectId,
        sender,
        options.requireOptIn ?? true,
        options.optOutText === undefined ? SMS_DEFAULT_OPT_OUT_TEXT : options.optOutText?.trim() || null,
        newWebhookToken(),
      ],
    );
    await storeCredential(db, projectId, 'twilio', sealed);
    await db.query(`UPDATE sms_settings SET provider = 'twilio', updated_at = now() WHERE project_id = $1`, [projectId]);
    const found = await db.query<{ webhook_token: string; sender: string }>(
      `SELECT webhook_token, sender FROM sms_settings WHERE project_id = $1`,
      [projectId],
    );
    return found.rows[0];
  });
  return { credentials, sender: row.sender, webhookToken: row.webhook_token };
}

/**
 * The path of a Twilio SMS webhook. `status` is the delivery report each text names (with
 * the campaign `c` and person `i` the API puts in its query); `inbound` takes replies.
 */
export function smsWebhookPath(
  webhookToken: string,
  kind: 'status' | 'inbound',
  query: { campaignId?: string; identityId?: string } = {},
): string {
  const params = new URLSearchParams();
  if (query.campaignId) params.set('c', query.campaignId);
  if (query.identityId) params.set('i', query.identityId);
  const suffix = params.toString() ? `?${params}` : '';
  return `/api/sms/webhooks/twilio/${webhookToken}/${kind}${suffix}`;
}

// --------------------------------------------------------------- whatsapp ---

export interface WhatsAppCredentialsByProvider {
  meta: { phoneNumberId: string; businessAccountId: string; accessToken: string; appSecret?: string };
  twilio_whatsapp: { accountSid: string; authToken: string; sender: string };
  gupshup: { apiKey: string; appName: string; appId: string; sourceNumber: string };
  interakt: { apiKey: string; webhookSecret?: string };
}

/** `twilio` is accepted for Twilio's WhatsApp provider, stored as `twilio_whatsapp`. */
export type WhatsAppProviderChoice = WhatsAppProviderName | 'twilio';
type Stored<P extends WhatsAppProviderChoice> = P extends 'twilio' ? 'twilio_whatsapp' : P;

/**
 * Fake credentials in the shape each provider's form sends, with the optional signing
 * secret filled in (Meta's app secret, Interakt's webhook secret) unless `signed` is false.
 */
export function fakeWhatsAppCredentials<P extends WhatsAppProviderName>(provider: P, signed = true): WhatsAppCredentialsByProvider[P] {
  const byProvider: WhatsAppCredentialsByProvider = {
    meta: {
      phoneNumberId: digits(15),
      businessAccountId: digits(15),
      accessToken: `EAAE2E${hex(24)}`,
      ...(signed ? { appSecret: hex(16) } : {}),
    },
    twilio_whatsapp: { ...fakeTwilioCredentials(), sender: '+14155550123' },
    gupshup: { apiKey: `e2e${hex(14)}`, appName: `e2eapp${hex(3)}`, appId: `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`, sourceNumber: '+919000000000' },
    interakt: { apiKey: `e2e${hex(16)}`, ...(signed ? { webhookSecret: hex(16) } : {}) },
  };
  return byProvider[provider];
}

export interface SeededWhatsApp<P extends WhatsAppProviderName> {
  provider: P;
  credentials: WhatsAppCredentialsByProvider[P];
  /** In every provider's webhook URL, and Meta's verify token. */
  webhookToken: string;
}

/**
 * A WhatsApp provider connected: the settings row as first use creates it (opt-in
 * required, unless `requireOptIn` says otherwise for a new row), the credentials stored,
 * and the provider made the one campaigns use.
 */
export async function connectFakeWhatsAppProvider<P extends WhatsAppProviderChoice>(
  projectId: string,
  choice: P,
  options: { credentials?: WhatsAppCredentialsByProvider[Stored<P>]; signed?: boolean; requireOptIn?: boolean } = {},
): Promise<SeededWhatsApp<Stored<P>>> {
  const provider = (choice === 'twilio' ? 'twilio_whatsapp' : choice) as Stored<P>;
  const credentials = options.credentials ?? fakeWhatsAppCredentials(provider, options.signed ?? true);
  const sealed = seal(JSON.stringify(credentials));
  const webhookToken = await withDatabase(async (db) => {
    await db.query(
      `INSERT INTO whatsapp_settings (project_id, provider, require_opt_in, webhook_token)
       VALUES ($1, NULL, $2, $3)
       ON CONFLICT (project_id) DO NOTHING`,
      [projectId, options.requireOptIn ?? true, newWebhookToken()],
    );
    await storeCredential(db, projectId, provider, sealed);
    await db.query(`UPDATE whatsapp_settings SET provider = $2, updated_at = now() WHERE project_id = $1`, [projectId, provider]);
    const row = await db.query<{ webhook_token: string }>(`SELECT webhook_token FROM whatsapp_settings WHERE project_id = $1`, [projectId]);
    return row.rows[0].webhook_token;
  });
  return { provider, credentials, webhookToken };
}

/** The path of the project's WhatsApp webhook for a provider. */
export function whatsappWebhookPath(provider: WhatsAppProviderName, webhookToken: string): string {
  return `/api/whatsapp/webhooks/${provider}/${webhookToken}`;
}

import { createCipheriv, randomBytes } from 'crypto';
import { Client } from 'pg';
import { api } from './api';
import { assertE2eDatabase, runSecrets, stackEnv } from './stack';

/**
 * Seeding for what the real API cannot do without a third party. Writes go to the e2e
 * database only (the name is checked as in reset.ts).
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

/** The API's credential envelope (CredentialsCryptoService): AES-256-GCM, hex parts. */
function encryptCredentials(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(runSecrets().credentialsKey, 'hex'), iv);
  const ciphertext = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return { ciphertext, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

/**
 * Marks Brevo as the project's connected email provider, with a fake key, as a
 * successful "Connect" would. The real connect checks the key with Brevo first, which
 * an offline test cannot do. Nothing ever sends with this key: the spec only schedules.
 */
export async function connectFakeEmailProvider(projectId: string): Promise<void> {
  const sealed = encryptCredentials(JSON.stringify({ apiKey: `xkeysib-e2e-fake-${randomBytes(8).toString('hex')}` }));
  await withDatabase(async (db) => {
    await db.query(
      `INSERT INTO push_channel_credentials (project_id, provider, credentials_encrypted, credentials_iv, credentials_tag, is_active)
       VALUES ($1, 'brevo', $2, $3, $4, true)`,
      [projectId, sealed.ciphertext, sealed.iv, sealed.tag],
    );
    const updated = await db.query(`UPDATE email_settings SET provider = 'brevo' WHERE project_id = $1`, [projectId]);
    if (updated.rowCount !== 1) throw new Error('Save the sender first: the project has no email settings row');
  });
}

export interface SeedPerson {
  email?: string;
  emailOptIn?: boolean;
  firstName?: string;
}

/** People as the SDK reports them: one identify per device, through the real SDK route. */
export async function identifyPeople(projectId: string, apiKey: string, ip: string, people: SeedPerson[]): Promise<void> {
  for (const person of people) {
    await api(
      'POST',
      '/api/identity/identify',
      {
        projectId,
        deviceFingerprint: `e2e-device-${randomBytes(8).toString('hex')}`,
        platform: 'web',
        ...person,
      },
      { apiKey, ip },
    );
  }
}

/**
 * A campaign's stored recipients (`campaign_recipients`), sorted: `target` for those it
 * sends to, `control` for an experiment parent's held-back slice. A whole-project
 * campaign has none. These rows replaced the campaign row's device id lists.
 */
export async function campaignRecipients(campaignId: string, role: 'target' | 'control' = 'target'): Promise<string[]> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT device_identity_id AS id FROM campaign_recipients
        WHERE campaign_id = $1 AND role = $2 ORDER BY device_identity_id`,
      [campaignId, role],
    );
    return rows.map((r) => r.id);
  });
}

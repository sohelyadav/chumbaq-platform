import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../test-support/int-db';
import { CredentialsCryptoService } from '../common/credentials-crypto.service';
import {
  isSealedWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
} from '../modules/webhooks/webhook-secret';
import { sealPlaintextWebhookSecrets } from './seal-webhook-secrets';

const DOMAIN = '@seal-webhook-secrets-int.test';
const HOOK_URL = 'https://93.184.215.14/hook';

describe('webhooks:seal-secrets', () => {
  let ds: DataSource;
  let projectId: string;
  const credentialsCrypto = new CredentialsCryptoService({
    get: () => 'e7'.repeat(32),
  } as unknown as ConfigService);

  const insert = async (secret: string, hint: string | null = null) => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO webhooks (id, project_id, url, events, secret, secret_hint) VALUES ($1, $2, $3, 'conversion', $4, $5)`,
      [id, projectId, HOOK_URL, secret, hint],
    );
    return id;
  };
  const row = async (id: string) =>
    (await ds.query(`SELECT secret, secret_hint FROM webhooks WHERE id = $1`, [id]))[0];

  beforeAll(async () => {
    ds = await openIntDb();
  });

  beforeEach(async () => {
    const ownerId = randomUUID();
    projectId = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'int')`, [
      ownerId,
      `${ownerId}${DOMAIN}`,
    ]);
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'hooks', $2)`, [projectId, ownerId]);
  });

  afterEach(async () => {
    await ds.query(`DELETE FROM webhooks WHERE project_id IN (SELECT id FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1))`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  it('encrypts plaintext secrets keeping their value, and leaves sealed ones alone', async () => {
    const legacy = 'a'.repeat(60) + 'f00d';
    const plaintextId = await insert(legacy);
    const alreadySealed = sealWebhookSecret(credentialsCrypto, 'b'.repeat(64));
    const sealedId = await insert(alreadySealed, 'bbbb');

    // Other suites share this database and may leave plaintext rows of their
    // own, so the count is at least ours rather than exactly ours.
    expect(await sealPlaintextWebhookSecrets(ds, credentialsCrypto)).toBeGreaterThanOrEqual(1);

    const converted = await row(plaintextId);
    expect(isSealedWebhookSecret(converted.secret)).toBe(true);
    expect(openWebhookSecret(credentialsCrypto, converted.secret)).toBe(legacy);
    expect(converted.secret_hint).toBe('f00d');
    expect((await row(sealedId)).secret).toBe(alreadySealed);

    // Running it again changes nothing of ours.
    await sealPlaintextWebhookSecrets(ds, credentialsCrypto);
    expect((await row(plaintextId)).secret).toBe(converted.secret);
  });
});

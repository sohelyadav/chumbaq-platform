import { randomUUID, createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb } from '../../test-support/int-db';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import type { ProjectAccess } from '../project-access/project-access.service';
import { roleCan } from '../project-access/project-permissions';
import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { EncryptWebhookSecrets1793950000000 } from '../../migrations/1793950000000-EncryptWebhookSecrets';
import { WebhookEntity } from './entities/webhook.entity';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { isSealedWebhookSecret, openWebhookSecret } from './webhook-secret';

// Delivery is stubbed so nothing leaves the machine; its sockets are tested
// in webhook-delivery.spec.ts.
jest.mock('./webhook-delivery', () => ({ postToVettedTarget: jest.fn() }));
import { postToVettedTarget } from './webhook-delivery';

/** The activity log is the activity specs' to test; these runs only need it to accept. */
const noLog = { record: async () => undefined } as never;
const ACTOR = '00000000-0000-4000-8000-000000000001';
const CTX = { ipAddress: null, userAgent: null };
const REQ = { headers: {}, ip: '127.0.0.1' } as never;

// A public address literal: the SSRF guard accepts it without a DNS query.
const HOOK_URL = 'https://93.184.215.14/hook';
const DOMAIN = '@webhook-secrets-int.test';
// Pinned, so the suite does not depend on the key in whoever's .env runs it.
// The migration reads process.env, as it does when the API runs it at boot.
const TEST_KEY = 'd4'.repeat(32);

describe('Webhook secrets (integration)', () => {
  let ds: DataSource;
  let controller: WebhooksController;
  let service: WebhooksService;
  let credentialsCrypto: CredentialsCryptoService;
  let ownerId: string;
  let projectId: string;
  let deliverMock: jest.Mock;

  let originalKey: string | undefined;

  beforeAll(async () => {
    ds = await openIntDb();
    originalKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.CREDENTIALS_ENCRYPTION_KEY = TEST_KEY;
    credentialsCrypto = new CredentialsCryptoService({
      get: (key: string) => process.env[key],
    } as unknown as ConfigService);
    service = new WebhooksService(
      ds.getRepository(WebhookEntity),
      { isSuspended: async () => false } as unknown as ProjectSuspensionService,
      credentialsCrypto,
     noLog);
    controller = new WebhooksController(service);
  });

  beforeEach(async () => {
    ownerId = randomUUID();
    projectId = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'int')`, [
      ownerId,
      `${ownerId}${DOMAIN}`,
    ]);
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'hooks', $2)`, [
      projectId,
      ownerId,
    ]);
    deliverMock = postToVettedTarget as jest.Mock;
    deliverMock.mockReset();
    deliverMock.mockResolvedValue({ status: 200 });
  });

  afterEach(async () => {
    await ds.query(`DELETE FROM webhooks WHERE project_id IN (SELECT id FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1))`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    else process.env.CREDENTIALS_ENCRYPTION_KEY = originalKey;
    await closeIntDb(ds);
  });

  /** What the guard leaves for the project's owner; the guard itself is project-access's to test. */
  const ownerAccess = (): ProjectAccess => ({
    project: { id: projectId, ownerId } as never,
    role: 'owner',
    isBillingOwner: true,
    impersonated: false,
    can: (p) => roleCan('owner', p),
  });

  const create = () =>
    controller.create(projectId, { url: HOOK_URL, events: ['conversion'] }, ACTOR, REQ);

  /** Fires one event and reports whether `secret` verifies the signature that was sent. */
  const deliveredSignatureVerifiesWith = async (secret: string): Promise<boolean> => {
    deliverMock.mockClear();
    await service.fireWebhook(projectId, 'conversion', { linkId: 'l1' });
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const init = deliverMock.mock.calls[0][1];
    const timestamp = init.headers['X-Chumbaq-Timestamp'];
    const expected = createHmac('sha256', secret).update(`${timestamp}.${init.body}`).digest('hex');
    return init.headers['X-Chumbaq-Signature'] === expected;
  };

  it('returns the secret on create, and stores it encrypted', async () => {
    const created = await create();
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.secretHint).toBe(created.secret.slice(-4));
    expect(created.secretRotatedAt).toBeNull();

    const [row] = await ds.query(`SELECT secret, secret_hint FROM webhooks WHERE id = $1`, [created.id]);
    expect(row.secret).not.toContain(created.secret);
    expect(isSealedWebhookSecret(row.secret)).toBe(true);
    expect(row.secret_hint).toBe(created.secret.slice(-4));
  });

  it('never returns the secret, or its ciphertext, from list, get or update', async () => {
    const created = await create();
    const [row] = await ds.query(`SELECT secret FROM webhooks WHERE id = $1`, [created.id]);

    const list = await controller.findAll(projectId, ownerAccess());
    const responses: unknown[] = [
      list,
      await controller.findOne(projectId, created.id, ownerAccess()),
      await controller.update(projectId, created.id, { isActive: false }, ACTOR, REQ),
    ];
    for (const response of responses) {
      const body = JSON.stringify(response);
      expect(body).not.toContain(created.secret);
      expect(body).not.toContain(row.secret);
      expect(body).toContain(created.secretHint);
    }
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('secret');
  });

  it('signs deliveries with the secret it returned', async () => {
    const created = await create();
    expect(await deliveredSignatureVerifiesWith(created.secret)).toBe(true);
  });

  it('rotates: the new secret verifies, the old one stops', async () => {
    const created = await create();
    const rotated = await controller.rotateSecret(projectId, created.id, ACTOR, REQ);

    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.secretHint).toBe(rotated.secret.slice(-4));
    expect(rotated.secretRotatedAt).toBeInstanceOf(Date);

    expect(await deliveredSignatureVerifiesWith(rotated.secret)).toBe(true);
    expect(await deliveredSignatureVerifiesWith(created.secret)).toBe(false);

    const [listed] = await controller.findAll(projectId, ownerAccess());
    expect(JSON.stringify(listed)).not.toContain(rotated.secret);
    expect(listed.secretHint).toBe(rotated.secret.slice(-4));
    expect(listed.secretRotatedAt).not.toBeNull();
  });

  it('keeps a rotation that commits while an edit is in flight', async () => {
    const created = await create();
    // The edit has read the row (as findOne does) before the rotation commits.
    const readByEdit = await service.findOne(created.id, projectId);
    const rotated = await controller.rotateSecret(projectId, created.id, ACTOR, REQ);
    jest.spyOn(service, 'findOne').mockResolvedValueOnce(readByEdit);
    await controller.update(projectId, created.id, { isActive: false }, ACTOR, REQ);
    jest.restoreAllMocks();

    const [row] = await ds.query(
      `SELECT secret_hint, secret_rotated_at, is_active FROM webhooks WHERE id = $1`,
      [created.id],
    );
    expect(row.is_active).toBe(false);
    expect(row.secret_hint).toBe(rotated.secret.slice(-4));
    expect(row.secret_rotated_at).not.toBeNull();
    await service.update(created.id, projectId, { isActive: true }, ACTOR, CTX);
    expect(await deliveredSignatureVerifiesWith(rotated.secret)).toBe(true);
  });

  it('will not rotate another project\'s webhook', async () => {
    const created = await create();
    await expect(service.rotateSecret(created.id, randomUUID(), ACTOR, CTX)).rejects.toThrow('Webhook not found');
  });

  describe('the migration', () => {
    // Inside a transaction that is always rolled back, so the shared database
    // is left exactly as the migrations made it, whatever happens here.
    it('encrypts existing plaintext secrets, keeping them, and reverts', async () => {
      const migration = new EncryptWebhookSecrets1793950000000();
      const runner = ds.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await migration.down(runner);
        const legacy = 'c'.repeat(60) + 'beef';
        const id = randomUUID();
        await runner.query(
          `INSERT INTO webhooks (id, project_id, url, events, secret) VALUES ($1, $2, $3, 'conversion', $4)`,
          [id, projectId, HOOK_URL, legacy],
        );

        await migration.up(runner);
        const [row] = await runner.query(`SELECT secret, secret_hint, secret_rotated_at FROM webhooks WHERE id = $1`, [id]);
        expect(isSealedWebhookSecret(row.secret)).toBe(true);
        expect(openWebhookSecret(credentialsCrypto, row.secret)).toBe(legacy);
        expect(row.secret_hint).toBe('beef');
        expect(row.secret_rotated_at).toBeNull();

        await migration.down(runner);
        const [reverted] = await runner.query(`SELECT secret FROM webhooks WHERE id = $1`, [id]);
        expect(reverted.secret).toBe(legacy);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });
  });
});

import { randomUUID } from 'crypto';
import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb } from '../../test-support/int-db';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { WebhookEntity } from './entities/webhook.entity';
import { MAX_WEBHOOKS_PER_PROJECT, WebhooksService } from './webhooks.service';
import { sealWebhookSecret } from './webhook-secret';

// Delivery is stubbed so nothing leaves the machine; its sockets are tested
// in webhook-delivery.spec.ts.
jest.mock('./webhook-delivery', () => ({ postToVettedTarget: jest.fn() }));
import { postToVettedTarget } from './webhook-delivery';

/** The activity log is the activity specs' to test; these runs only need it to accept. */
const noLog = { record: async () => undefined } as never;
const ACTOR = '00000000-0000-4000-8000-000000000001';
const CTX = { ipAddress: null, userAgent: null };

// A public address literal: the SSRF guard accepts it without a DNS query.
const HOOK_URL = 'https://93.184.215.14/hook';
const DOMAIN = '@webhooks-limits-int.test';

// The unit spec's repository mock counts and orders whatever it is told to.
// These prove the real queries: that concurrent creates cannot both see room
// for the last webhook, and that a project over the cap sends to its oldest.
describe('Webhooks per project (integration)', () => {
  let ds: DataSource;
  let service: WebhooksService;
  const deliverMock = postToVettedTarget as jest.Mock;
  const credentialsCrypto = new CredentialsCryptoService({
    get: (key: string) => (key === 'CREDENTIALS_ENCRYPTION_KEY' ? 'e6'.repeat(32) : undefined),
  } as unknown as ConfigService);

  const addProject = async () => {
    const ownerId = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'int')`, [
      ownerId,
      `${ownerId}${DOMAIN}`,
    ]);
    const projectId = randomUUID();
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'limits', $2)`, [projectId, ownerId]);
    return projectId;
  };
  const activeCount = async (projectId: string) =>
    ds.getRepository(WebhookEntity).count({ where: { projectId, isActive: true } });

  beforeAll(async () => {
    ds = await openIntDb();
    service = new WebhooksService(
      ds.getRepository(WebhookEntity),
      { isSuspended: async () => false } as unknown as ProjectSuspensionService,
      credentialsCrypto,
     noLog);
  });

  beforeEach(() => {
    deliverMock.mockReset();
    deliverMock.mockResolvedValue({ status: 200 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.query(`DELETE FROM webhooks WHERE project_id IN (SELECT id FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1))`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  it('refuses the webhook past the cap, even when they are all created at once', async () => {
    const projectId = await addProject();
    const results = await Promise.allSettled(
      Array.from({ length: MAX_WEBHOOKS_PER_PROJECT + 3 }, () =>
        service.create(projectId, { url: HOOK_URL, events: ['conversion'] }, ACTOR, CTX),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_WEBHOOKS_PER_PROJECT);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.reason).toBeInstanceOf(BadRequestException);
    expect(await activeCount(projectId)).toBe(MAX_WEBHOOKS_PER_PROJECT);
  });

  it('keeps inactive webhooks out of the count, and refuses turning one on at the cap', async () => {
    const projectId = await addProject();
    for (let i = 0; i < MAX_WEBHOOKS_PER_PROJECT; i++) {
      await service.create(projectId, { url: HOOK_URL, events: ['conversion'] }, ACTOR, CTX);
    }
    const spare = await service.create(projectId, { url: HOOK_URL, events: ['conversion'], isActive: false }, ACTOR, CTX);

    await expect(service.update(spare.id, projectId, { isActive: true }, ACTOR, CTX)).rejects.toThrow(BadRequestException);
    expect((await service.findOne(spare.id, projectId)).isActive).toBe(false);

    // Room again once another is turned off.
    const active = (await service.findAllByProject(projectId)).find((w) => w.isActive)!;
    await service.update(active.id, projectId, { isActive: false }, ACTOR, CTX);
    await expect(service.update(spare.id, projectId, { isActive: true }, ACTOR, CTX)).resolves.toMatchObject({ isActive: true });
    expect(await activeCount(projectId)).toBe(MAX_WEBHOOKS_PER_PROJECT);
  });

  it('sends a project over the cap from before it only to its oldest webhooks', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const projectId = await addProject();
    const repo = ds.getRepository(WebhookEntity);
    const total = MAX_WEBHOOKS_PER_PROJECT + 3;
    // Inserted newest first, so insertion order cannot pass for age order.
    for (let n = total - 1; n >= 0; n--) {
      const saved = await repo.save({
        projectId,
        url: `${HOOK_URL}?n=${n}`,
        events: ['conversion'],
        secretSealed: sealWebhookSecret(credentialsCrypto, 's'.repeat(32)),
        secretHint: 'ssss',
        secretRotatedAt: null,
        isActive: true,
      });
      await ds.query(`UPDATE webhooks SET created_at = $2 WHERE id = $1`, [
        saved.id,
        new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
      ]);
    }

    await service.fireWebhook(projectId, 'conversion', {});

    const sentTo = deliverMock.mock.calls.map(([target]) => Number(target.url.searchParams.get('n'))).sort((a, b) => a - b);
    expect(sentTo).toEqual(Array.from({ length: MAX_WEBHOOKS_PER_PROJECT }, (_, n) => n));
  });
});

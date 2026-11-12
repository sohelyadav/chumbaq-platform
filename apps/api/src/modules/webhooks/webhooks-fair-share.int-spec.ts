import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb } from '../../test-support/int-db';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { WebhookEntity } from './entities/webhook.entity';
import { MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT, MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT, WebhooksService } from './webhooks.service';
import { sealWebhookSecret } from './webhook-secret';

// Delivery is stubbed so nothing leaves the machine; its sockets are tested
// in webhook-delivery.spec.ts.
jest.mock('./webhook-delivery', () => ({ postToVettedTarget: jest.fn() }));
import { postToVettedTarget } from './webhook-delivery';

/** The activity log is the activity specs' to test; these runs only need it to accept. */
const noLog = { record: async () => undefined } as never;

// A public address literal: the SSRF guard accepts it without a DNS query.
const HOOK_URL = 'https://93.184.215.14/hook';
const DOMAIN = '@webhooks-fair-share-int.test';

// The unit spec hands the service rows that already carry their project. This
// proves the real query does: if the owner did not come back with the row,
// each project would count as its own account and the account cap would hold
// nobody.
describe('Webhook in-flight caps per account (integration)', () => {
  let ds: DataSource;
  let service: WebhooksService;
  const deliverMock = postToVettedTarget as jest.Mock;
  const credentialsCrypto = new CredentialsCryptoService({
    get: (key: string) => (key === 'CREDENTIALS_ENCRYPTION_KEY' ? 'e5'.repeat(32) : undefined),
  } as unknown as ConfigService);

  const addOwner = async () => {
    const id = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'int')`, [
      id,
      `${id}${DOMAIN}`,
    ]);
    return id;
  };
  const addProjectWithHook = async (ownerId: string) => {
    const projectId = randomUUID();
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'fair', $2)`, [projectId, ownerId]);
    await ds.getRepository(WebhookEntity).save({
      projectId,
      url: HOOK_URL,
      events: ['conversion'],
      secretSealed: sealWebhookSecret(credentialsCrypto, 's'.repeat(32)),
      secretHint: 'ssss',
      secretRotatedAt: null,
      isActive: true,
    });
    return projectId;
  };
  /** Real queries take a while: waits (up to 2s) for `count` deliveries to reach the transport. */
  const settle = async (count: number) => {
    for (let i = 0; i < 200 && deliverMock.mock.calls.length < count; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new WebhooksService(
      ds.getRepository(WebhookEntity),
      { isSuspended: async () => false } as unknown as ProjectSuspensionService,
      credentialsCrypto,
     noLog);
  });

  afterEach(async () => {
    await ds.query(`DELETE FROM webhooks WHERE project_id IN (SELECT id FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1))`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  it('counts every project of one owner against one account cap, and not other owners', async () => {
    const pending: Array<() => void> = [];
    deliverMock.mockReset();
    deliverMock.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve({ status: 200 }))),
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    const greedy = await addOwner();
    const perProject = MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT / 2;
    const projectCount = MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT / perProject + 1;
    const projects: string[] = [];
    for (let i = 0; i < projectCount; i++) projects.push(await addProjectWithHook(greedy));
    const neighbour = await addProjectWithHook(await addOwner());

    // Every project of the account but the last, each below its own cap.
    const running: Promise<void>[] = [];
    for (const projectId of projects.slice(0, -1)) {
      for (let i = 0; i < perProject; i++) running.push(service.fireWebhook(projectId, 'conversion', {}));
    }
    await settle(running.length);
    expect(deliverMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);

    // The account's last project has nothing in flight, and is still refused.
    await service.fireWebhook(projects[projects.length - 1], 'conversion', {});
    expect(deliverMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);

    // Another owner's delivery goes.
    const other = service.fireWebhook(neighbour, 'conversion', {});
    await settle(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT + 1);
    expect(deliverMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT + 1);

    pending.forEach((finish) => finish());
    await Promise.all([...running, other]);
  });
});

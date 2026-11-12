import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { HIDDEN_DURING_IMPERSONATION } from '../../common/impersonation-redaction';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { SessionsService } from '../auth/sessions.service';
import { AuthSessionEntity } from '../auth/entities/auth-session.entity';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { StaffSessionsService } from '../auth/staff-sessions.service';
import { StaffSessionEntity } from '../auth/entities/staff-session.entity';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { ProjectAccessService } from '../project-access/project-access.service';
import { ProjectMemberEntity } from '../project-access/entities/project-member.entity';
import { LinkEntity } from '../links/entities/link.entity';
import { BannerCategoryEntity } from '../in-app-banners/entities/banner-category.entity';
import { InAppBannerEntity } from '../in-app-banners/entities/in-app-banner.entity';
import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { WebhookEntity } from './entities/webhook.entity';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { sealWebhookSecret } from './webhook-secret';

/** The activity log is the activity specs' to test; these runs only need it to accept. */
const noLog = { record: async () => undefined } as never;

const SECRET = 'test-secret-long-enough-for-the-strategy';
const DOMAIN = '@webhooks-impersonation-int.test';
// Shaped like a real Slack incoming webhook: the path is the credential.
const SLACK_PATH = '/services/T0INTTEST/B0INTTEST/s3cr3tPathToken';
const HOOK_URL = `https://hooks.slack.com${SLACK_PATH}?channel=ops`;
const KEY = 'e5'.repeat(32);

/**
 * Real HTTP, Postgres, JwtStrategy and the project-access guard, so the view-as token is
 * the one staff would hold and a member's role is the one stored in project_members.
 */
describe('Webhooks seen through view-as and by role (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let ownerId: string;
  let adminId: string;
  let memberId: string;
  let outsiderId: string;
  let staffId: string;
  let projectId: string;
  let webhookId: string;
  let staffSessionId: string;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });

  const get = async (path: string, token: string) => {
    const res = await fetch(`${base}/projects/${projectId}/webhooks${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, text: await res.text() };
  };
  const tokenFor = (id: string, name: string) => jwt.signAsync({ sub: id, email: `${name}${DOMAIN}`, type: 'access' });
  const ownerToken = () => tokenFor(ownerId, 'owner');
  const viewAsToken = () =>
    jwt.signAsync({
      sub: ownerId,
      email: `owner${DOMAIN}`,
      type: 'access',
      imp: staffId,
      impSv: 0,
      impSid: staffSessionId,
    });

  const cleanup = async () => {
    await ds.query(
      `DELETE FROM webhooks WHERE project_id IN (SELECT id FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1))`,
      [`%${DOMAIN}`],
    );
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    const config = { get: (key: string) => (key === 'jwt.secret' ? SECRET : key === 'CREDENTIALS_ENCRYPTION_KEY' ? KEY : undefined) };
    const credentialsCrypto = new CredentialsCryptoService(config as unknown as ConfigService);
    const service = new WebhooksService(
      ds.getRepository(WebhookEntity),
      { isSuspended: async () => false } as unknown as ProjectSuspensionService,
      credentialsCrypto,
     noLog);
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [WebhooksController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: config },
        { provide: UsersService, useValue: new UsersService(ds.getRepository(UserEntity)) },
        { provide: SessionsService, useValue: new SessionsService(ds.getRepository(AuthSessionEntity)) },
        {
          provide: StaffSessionsService,
          useValue: new StaffSessionsService(ds.getRepository(StaffSessionEntity), config as unknown as ConfigService),
        },
        { provide: WebhooksService, useValue: service },
        {
          provide: ProjectAccessService,
          useValue: new ProjectAccessService(
            ds.getRepository(ProjectMemberEntity),
            ds.getRepository(LinkEntity),
            ds.getRepository(BannerCategoryEntity),
            ds.getRepository(InAppBannerEntity),
          ),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;

    await cleanup();
    const users = ds.getRepository(UserEntity);
    ownerId = (await users.save({ email: `owner${DOMAIN}`, name: 'Owner', passwordHash: 'x' })).id;
    adminId = (await users.save({ email: `admin${DOMAIN}`, name: 'Admin', passwordHash: 'x' })).id;
    memberId = (await users.save({ email: `member${DOMAIN}`, name: 'Member', passwordHash: 'x' })).id;
    outsiderId = (await users.save({ email: `outsider${DOMAIN}`, name: 'Outsider', passwordHash: 'x' })).id;
    staffId = (await users.save({ email: `staff${DOMAIN}`, name: 'Staff', passwordHash: 'x', isSuperAdmin: true })).id;
    staffSessionId = (await issueStaffSessionForTest(ds, { id: staffId, email: `staff${DOMAIN}`, sessionVersion: 0 })).sessionId;
    projectId = randomUUID();
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'hooks', $2)`, [projectId, ownerId]);
    await addOwnerMember(ds, projectId, ownerId);
    await addOwnerMember(ds, projectId, adminId, 'admin');
    await addOwnerMember(ds, projectId, memberId, 'member');
    // Inserted directly: create() would resolve hooks.slack.com, and this
    // suite is about reads, not the network.
    webhookId = (
      await ds.getRepository(WebhookEntity).save({
        projectId,
        url: HOOK_URL,
        events: ['conversion'],
        secretSealed: sealWebhookSecret(credentialsCrypto, 'f'.repeat(64)),
        secretHint: 'ffff',
        isActive: true,
      })
    ).id;
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
  });

  it('shows the tenant their own URL', async () => {
    const token = await ownerToken();
    const list = await get('', token);
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text)[0].url).toBe(HOOK_URL);
    expect((await get(`/${webhookId}`, token)).text).toContain(SLACK_PATH);
  });

  it.each([
    ['list', ''],
    ['get', '/:id'],
  ])('gives a view-as session no part of the URL from %s', async (_name, path) => {
    const res = await get(path.replace(':id', webhookId), await viewAsToken());
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('T0INTTEST');
    expect(res.text).not.toContain('s3cr3tPathToken');
    expect(res.text).not.toContain('channel=ops');
    expect(res.text).not.toContain('hooks.slack.com');
    expect(res.text).not.toContain('f'.repeat(64));
    expect(res.text).toContain(HIDDEN_DURING_IMPERSONATION);
    // The rest of the row is still there for staff to read.
    expect(res.text).toContain('"secretHint":"ffff"');
    expect(res.text).toContain(webhookId);
  });

  it('shows an admin the URL', async () => {
    const token = await tokenFor(adminId, 'admin');
    expect(JSON.parse((await get('', token)).text)[0].url).toBe(HOOK_URL);
    expect((await get(`/${webhookId}`, token)).text).toContain(SLACK_PATH);
  });

  it.each([
    ['list', ''],
    ['get', '/:id'],
  ])('gives a member the row from %s but no part of the URL', async (_name, path) => {
    const res = await get(path.replace(':id', webhookId), await tokenFor(memberId, 'member'));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('hooks.slack.com');
    expect(res.text).not.toContain('s3cr3tPathToken');
    expect(res.text).toContain(HIDDEN_DURING_IMPERSONATION);
    expect(res.text).toContain('"secretHint":"ffff"');
  });

  it('answers someone outside the project as if it did not exist', async () => {
    const res = await get('', await tokenFor(outsiderId, 'outsider'));
    expect(res.status).toBe(404);
    expect(res.text).toContain('Project not found');
  });
});

import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import {
  ACCOUNT_SCOPED,
  BODIES,
  Fixture,
  Ids,
  NO_OWNER_CONTROL,
  QUERIES,
  RESOURCE_KEYED,
  Route,
  bootDashboardApp,
  callRoute,
  enumerateRoutes,
  insertRow,
  isProjectScoped,
  isResourceKeyed,
  resourceKindOf,
  seedProjectData,
} from '../../test-support/sweep-fixtures';
import { ApiKeyEntity } from '../api-keys/entities/api-key.entity';
import { AttributionResultEntity } from '../attribution/entities/attribution-result.entity';
import { ConversionEventEntity } from '../conversions/entities/conversion-event.entity';
import { EmailSettingsEntity } from '../email/entities/email-settings.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { BannerCategoryEntity } from '../in-app-banners/entities/banner-category.entity';
import { InAppBannerEntity } from '../in-app-banners/entities/in-app-banner.entity';
import { InAppMessageEntity } from '../in-app-messages/entities/in-app-message.entity';
import { JourneyEntity } from '../journeys/entities/journey.entity';
import { LinkVariantEntity } from '../links/entities/link-variant.entity';
import { LinkEntity } from '../links/entities/link.entity';
import { MixpanelCohortEntity } from '../mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { MixpanelConfigEntity } from '../mixpanel-cohorts/entities/mixpanel-config.entity';
import { ProjectInvitationEntity } from '../project-access/entities/project-invitation.entity';
import { PROJECT_NOT_FOUND } from '../project-access/project-permissions';
import { ChannelCredentialsService } from '../push-notifications/channel-credentials.service';
import { ChannelSuppressionEntity } from '../push-notifications/entities/channel-suppression.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { PushTemplateEntity } from '../push-notifications/entities/push-template.entity';
import { SegmentEntity } from '../segments/entities/segment.entity';
import { SmsSettingsEntity } from '../sms/entities/sms-settings.entity';
import { TouchpointEntity } from '../touchpoints/entities/touchpoint.entity';
import { UserEntity } from '../users/entities/user.entity';
import { WebhookEntity } from '../webhooks/entities/webhook.entity';
import { WhatsAppSettingsEntity } from '../whatsapp/entities/whatsapp-settings.entity';
import { ProjectEntity } from './entities/project.entity';

/**
 * Cross-tenant authorisation sweep over every dashboard route.
 *
 * The routes are not listed here: they are read from the running app's
 * controllers (path, method, guard and `@RequireProjectPermission` metadata,
 * plus the handler's argument metadata for a projectId taken from the body or
 * query; see `test-support/sweep-fixtures.ts`). Every route behind
 * JwtAuthGuard that names a project, or any other resource, is then called by
 * account B with account A's project and A's resource ids. A project-scoped or
 * resource-keyed route must answer exactly 404 `Project not found`, the
 * project-access guard's refusal (never 2xx, never 400: validation runs after
 * guards, so a 400 proves nothing; never 403: a non-member is not told the
 * project exists). Account routes with parameters must answer 403 or 404.
 *
 * Fail closed: every project-scoped or resource-keyed route must declare a
 * permission with `@RequireProjectPermission`, whose source is one the route
 * has, behind JwtAuthGuard, once. A route added later is swept without anyone
 * touching this file. One keyed by a resource id with no project in it fails
 * until it is added to RESOURCE_KEYED with a reason, and one with no
 * parameters at all fails until it is added to ACCOUNT_SCOPED.
 *
 * Two checks keep a refusal from passing for the wrong reason: every swept GET
 * is replayed with A's own token and must succeed (so the ids resolve and B's
 * 404 means "not yours", not "no such thing"), and B's 404 must carry the
 * exact project refusal. C, a member of A's project, gets every swept GET that
 * needs only `project.read`, without the channel webhook tokens or webhook
 * URLs, which only `channels.manage` sees.
 *
 * A second pass calls the same routes as B on B's own project with A's
 * resource ids, the shape of the conversion-attribution hole: access checked
 * on the project, then the resource looked up by id alone. Nothing B receives
 * may contain A's data, and A's rows must be unchanged at the end.
 *
 * Last, view-as: staff viewing as A see only the projects billed to A.
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@cross-tenant-sweep-int.test';
/** In every human-readable field of A's data, so a leak shows in any response body. */
const MARKER = 'ZZ-TENANT-A-PRIVATE-7f3c';
/** In A's webhook URL, which only a role with `channels.manage` may see. */
const SECRET_MARKER = 'ZZ-WEBHOOK-PATH-SECRET-91d2';

/** Channel settings and webhook reads: where a secret a member must not see lives. */
const SECRET_BEARING_GET =
  /^GET \/api\/((email|sms|whatsapp)\/settings\/:projectId|projects\/:projectId\/webhooks(\/:id)?|push-notifications\/config-status\/:projectId|projects\/:projectId\/mixpanel\/status)$/;

/** Permissions that only read. A non-GET route declaring one is a write gated as a read. */
const READ_ONLY_PERMISSIONS: string[] = ['project.read', 'people.read'];

/**
 * Non-GET routes gated by a read permission, each with why that is right: reads done
 * over POST, or writes that touch only the caller's own place in the project.
 */
const READ_PERMISSION_ON_WRITE: Record<string, string> = {
  'POST /api/projects/:projectId/billing-transfer/decline':
    'the receiver is an owner; it only clears a billing offer made to the caller, and 400s for anyone else',
  'POST /api/projects/:projectId/leave':
    'removes only the caller\'s own membership; every member may leave (not the billing or last owner)',
};

describe('Cross-tenant authorisation sweep (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let restoreEnv: () => void = () => undefined;
  let routes: Route[];
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });

  let a: Ids = {};
  const b: Ids = {};
  let tokenA: string;
  let tokenB: string;
  /** C: a member of A's project. D: an admin of it. */
  let tokenC: string;
  let tokenD: string;
  /** The webhook tokens of A's email, SMS and WhatsApp settings, by channel. */
  const channelTokens: Record<string, string> = {};
  /** The service account identities of A's FCM key and Mixpanel sync. */
  const pushClientEmail = `sweep-${randomBytes(8).toString('hex')}@a-fcm.iam.gserviceaccount.com`;
  const mixpanelUsername = `sweep-sa.${randomBytes(8).toString('hex')}.mp-service-account`;
  /** A's webhook whose URL path holds SECRET_MARKER. */
  let secretWebhookId: string;
  /** A's rows straight after seeding; nothing B does may change them. */
  let seededA: Record<string, string>;

  const cleanup = async () => {
    if (!ds?.isInitialized) return;
    await ds.query(
      `DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`,
      [`%${DOMAIN}`],
    );
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  const call = (route: Route, token: string, ids: Ids) => callRoute(base, route, token, ids);

  const jwtRoutes = () => routes.filter((r) => r.guards.includes('JwtAuthGuard'));
  /** Routes that must carry a project permission. */
  const needsPermission = (r: Route) => isProjectScoped(r) || isResourceKeyed(r);
  const sweptRoutes = () =>
    jwtRoutes().filter((r) => isProjectScoped(r) || r.pathParams.length > 0);

  /** Whether a body or query fixture carries one of A's resource ids (not just a project). */
  const namesAResource = (fixture?: Fixture) => {
    if (!fixture) return false;
    const json = JSON.stringify(fixture(a));
    return Object.entries(a).some(([k, v]) => k !== 'projectId' && k !== 'userId' && json.includes(v));
  };

  /** A's rows, read back in full, so any change by B shows. */
  const snapshotA = async () => {
    const tables: Array<[Repository<ObjectLiteral>, Record<string, unknown>]> = [
      [ds.getRepository(ProjectEntity), { id: a.projectId }],
      [ds.getRepository(DeviceIdentityEntity), { projectId: a.projectId }],
      [ds.getRepository(LinkEntity), { projectId: a.projectId }],
      [ds.getRepository(LinkVariantEntity), { linkId: a.linkId }],
      [ds.getRepository(ConversionEventEntity), { linkId: a.linkId }],
      [ds.getRepository(AttributionResultEntity), { projectId: a.projectId }],
      [ds.getRepository(TouchpointEntity), { projectId: a.projectId }],
      [ds.getRepository(SegmentEntity), { projectId: a.projectId }],
      [ds.getRepository(JourneyEntity), { projectId: a.projectId }],
      [ds.getRepository(PushNotificationLogEntity), { projectId: a.projectId }],
      [ds.getRepository(PushTemplateEntity), { projectId: a.projectId }],
      [ds.getRepository(WebhookEntity), { projectId: a.projectId }],
      [ds.getRepository(ApiKeyEntity), { projectId: a.projectId }],
      [ds.getRepository(InAppMessageEntity), { projectId: a.projectId }],
      [ds.getRepository(BannerCategoryEntity), { projectId: a.projectId }],
      [ds.getRepository(InAppBannerEntity), { categoryId: a.categoryId }],
      [ds.getRepository(MixpanelCohortEntity), { projectId: a.projectId }],
      [ds.getRepository(ChannelSuppressionEntity), { projectId: a.projectId }],
      [ds.getRepository(EmailSettingsEntity), { projectId: a.projectId }],
      [ds.getRepository(SmsSettingsEntity), { projectId: a.projectId }],
      [ds.getRepository(WhatsAppSettingsEntity), { projectId: a.projectId }],
      [ds.getRepository(ProjectInvitationEntity), { projectId: a.projectId }],
    ];
    const out: Record<string, string> = {};
    for (const [repo, where] of tables) {
      const rows = await repo.find({ where, order: { id: 'ASC' } as never });
      out[repo.metadata.tableName] = JSON.stringify(rows);
    }
    return out;
  };

  beforeAll(async () => {
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
    routes = enumerateRoutes(app);

    // ── Two accounts, each owning one project; C and D work in A's ──
    const users = ds.getRepository(UserEntity);
    const aUserId = (await users.save({ email: `a${DOMAIN}`, name: `A ${MARKER}`, passwordHash: 'x' })).id;
    b.userId = (await users.save({ email: `b${DOMAIN}`, name: 'B', passwordHash: 'x' })).id;
    const cUserId = (await users.save({ email: `c${DOMAIN}`, name: 'C', passwordHash: 'x' })).id;
    const dUserId = (await users.save({ email: `d${DOMAIN}`, name: 'D', passwordHash: 'x' })).id;
    const projects = ds.getRepository(ProjectEntity);
    const aProjectId = (await projects.save({ name: `A ${MARKER}`, ownerId: aUserId })).id;
    b.projectId = (await projects.save({ name: 'B', ownerId: b.userId })).id;
    // As ProjectsService.create leaves them: the billing owner is an owner member.
    await addOwnerMember(ds, aProjectId, aUserId);
    await addOwnerMember(ds, b.projectId, b.userId);
    await addOwnerMember(ds, aProjectId, cUserId, 'member');
    await addOwnerMember(ds, aProjectId, dUserId, 'admin');
    // A fresh sign-in (auth_time now), so routes behind RecentAuthGuard (lifting
    // a person's do-not-track) reach their access check rather than stopping
    // at "Confirm it is you".
    const authTime = Math.floor(Date.now() / 1000);
    const sign = (sub: string, who: string) =>
      jwt.signAsync({ sub, email: `${who}${DOMAIN}`, type: 'access', auth_time: authTime });
    tokenA = await sign(aUserId, 'a');
    tokenB = await sign(b.userId, 'b');
    tokenC = await sign(cUserId, 'c');
    tokenD = await sign(dUserId, 'd');

    // ── A's data: one of each thing a route can name ──
    a = await seedProjectData(ds, aProjectId, MARKER);
    a.userId = aUserId;
    // `:memberId` on the project members routes: C, a member of A's project.
    a.memberUserId = cUserId;
    // Channel settings, each with its webhook token (a credential: it is the path
    // providers post events to), and a webhook whose URL path is a secret.
    for (const [entity, row] of [
      [EmailSettingsEntity, { fromEmail: 'hello@example.com', postalAddress: '1 Main Street' }],
      [SmsSettingsEntity, { sender: '+14155550123' }],
      [WhatsAppSettingsEntity, {}],
    ] as const) {
      const webhookToken = randomBytes(24).toString('hex');
      channelTokens[entity === EmailSettingsEntity ? 'email' : entity === SmsSettingsEntity ? 'sms' : 'whatsapp'] =
        webhookToken;
      await insertRow(ds, entity, { projectId: aProjectId, webhookToken, ...row });
    }
    secretWebhookId = await insertRow(ds, WebhookEntity, {
      projectId: aProjectId,
      url: `https://hooks.example.com/${SECRET_MARKER}`,
      events: ['conversion'],
      secretSealed: 'v1.unused-in-this-suite',
      secretHint: 'yyyy',
      isActive: false,
    });
    // The FCM key's service account and the Mixpanel service account username: shown on
    // the status reads only to those who manage channels. Mixpanel's password is never
    // read back, so placeholder ciphertext does.
    await app.get(ChannelCredentialsService).upsert(
      aProjectId,
      'fcm',
      JSON.stringify({ type: 'service_account', project_id: 'sweep-a', client_email: pushClientEmail }),
    );
    await insertRow(ds, PushConfigEntity, { projectId: aProjectId });
    await insertRow(ds, MixpanelConfigEntity, {
      projectId: aProjectId,
      serviceAccountUsername: mixpanelUsername,
      serviceAccountPasswordEncrypted: 'unused-in-this-suite',
      encryptionIv: '00',
      encryptionTag: '00',
      mixpanelProjectId: '1234567',
      isActive: false,
    });
    // Account credentials: B naming A's must find nothing.
    a.sessionId = randomUUID();
    a.passkeyId = randomUUID();

    // B's own project, for the cross-binding pass: A's ids under B's project.
    Object.assign(b, { ...a, userId: b.userId, projectId: b.projectId });
    seededA = await snapshotA();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
  });

  it('finds the dashboard routes, and every one is accounted for', () => {
    const jwtOnly = jwtRoutes();
    const swept = sweptRoutes();
    const projectScoped = jwtOnly.filter(isProjectScoped);
    // eslint-disable-next-line no-console
    console.log(
      `Cross-tenant sweep: ${routes.length} routes in the app, ${jwtOnly.length} behind JwtAuthGuard, ` +
        `${projectScoped.length} project-scoped, ${jwtOnly.filter(needsPermission).length} needing a permission, ` +
        `${swept.length} swept.`,
    );
    // Well below today's numbers, so a broken enumeration cannot pass vacuously.
    expect(routes.length).toBeGreaterThan(200);
    expect(projectScoped.length).toBeGreaterThan(120);

    const unaccounted = jwtOnly
      .filter((r) => !isProjectScoped(r))
      .filter((r) => !ACCOUNT_SCOPED.some((x) => x.match.test(r.key)))
      .filter((r) => !RESOURCE_KEYED.some((x) => x.match.test(r.key)))
      .map((r) => r.key);
    expect(unaccounted).toEqual([]);

    // A resource-keyed allow-list entry is only for routes that take an id.
    const keyedButParamless = jwtOnly
      .filter((r) => RESOURCE_KEYED.some((x) => x.match.test(r.key)) && r.pathParams.length === 0)
      .map((r) => r.key);
    expect(keyedButParamless).toEqual([]);

    expect(routes.filter((r) => /^\/api\/(admin|staff)\//.test(r.path)).map((r) => r.key)).toEqual([]);
  });

  it('every project-scoped route declares a permission, from a source it has, behind JwtAuthGuard', () => {
    const failures: string[] = [];
    for (const r of routes) {
      const jwtAt = r.guards.indexOf('JwtAuthGuard');
      const accessAt = r.guards.indexOf('ProjectAccessGuard');
      if (!r.permission) {
        if (jwtAt >= 0 && needsPermission(r)) failures.push(`${r.key}: no @RequireProjectPermission`);
        if (accessAt >= 0) failures.push(`${r.key}: ProjectAccessGuard without a permission`);
        continue;
      }
      if (jwtAt < 0) {
        failures.push(`${r.key}: declares ${r.permission.permission} without JwtAuthGuard`);
        continue;
      }
      if (accessAt < 0) failures.push(`${r.key}: declares a permission but ProjectAccessGuard is not in its guards`);
      else if (accessAt < jwtAt) failures.push(`${r.key}: ProjectAccessGuard runs before JwtAuthGuard`);
      const twice = r.guards.filter((g) => g === 'ProjectAccessGuard').length;
      if (twice > 1) failures.push(`${r.key}: ProjectAccessGuard ${twice} times (two @RequireProjectPermission?)`);

      const from = r.permission.from as Record<string, string>;
      if ('resource' in from) {
        if (!r.pathParams.includes(from.param)) failures.push(`${r.key}: resource param :${from.param} not in path`);
        const kind = resourceKindOf(r);
        if (!kind) failures.push(`${r.key}: resource-keyed but not in RESOURCE_KEYED`);
        else if (kind !== from.resource)
          failures.push(`${r.key}: declares resource ${from.resource}, RESOURCE_KEYED says ${kind}`);
      } else if ('param' in from) {
        // Only a project id: `:projectId`, or `:id` on /api/projects/:id itself.
        const isProjectParam =
          from.param === 'projectId' || (from.param === 'id' && /^\/api\/projects\/:id(\/|$)/.test(r.path));
        if (!r.pathParams.includes(from.param)) failures.push(`${r.key}: param :${from.param} not in path`);
        else if (!isProjectParam) failures.push(`${r.key}: param :${from.param} does not name a project`);
      } else if ('body' in from) {
        if (!r.bodyProjectId) failures.push(`${r.key}: from body, but its body has no projectId`);
      } else if ('query' in from) {
        if (!r.queryProjectId) failures.push(`${r.key}: from query, but its query has no projectId`);
      } else {
        failures.push(`${r.key}: unknown source ${JSON.stringify(from)}`);
      }
      // A write needs a write permission. `project.read` and `people.read` are for reads;
      // a read done over POST may be listed in READ_PERMISSION_ON_WRITE, with its reason.
      if (r.method !== 'GET' && READ_ONLY_PERMISSIONS.includes(r.permission.permission) && !READ_PERMISSION_ON_WRITE[r.key]) {
        failures.push(`${r.key}: ${r.method} declares read-only ${r.permission.permission}; use messaging.write or list it`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('refuses B every route that names A\'s project or A\'s resources', async () => {
    const failures: string[] = [];
    const tally: Record<number, number> = {};
    for (const route of sweptRoutes()) {
      const res = await call(route, tokenB, a);
      tally[res.status] = (tally[res.status] ?? 0) + 1;
      if (res.text.includes(MARKER)) failures.push(`leak in refusal: ${res.url}`);
      if (needsPermission(route)) {
        // The project-access guard's refusal, and only that.
        if (res.status !== 404 || !res.text.includes(PROJECT_NOT_FOUND)) {
          failures.push(`${res.status} ${res.url} ${res.text.slice(0, 300)}`);
        }
      } else if (res.status !== 403 && res.status !== 404) {
        failures.push(`${res.status} ${res.url} ${res.text.slice(0, 300)}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Cross-tenant sweep, B → A: statuses ${JSON.stringify(tally)}`);
    expect(failures).toEqual([]);
  }, 120000);

  it('serves A every swept GET, so B\'s refusals are about access', async () => {
    const failures: string[] = [];
    for (const route of sweptRoutes().filter((r) => r.method === 'GET')) {
      if (NO_OWNER_CONTROL[route.key]) continue;
      const res = await call(route, tokenA, a);
      if (res.status < 200 || res.status >= 300) failures.push(`${res.status} ${res.url} ${res.text.slice(0, 300)}`);
    }
    expect(failures).toEqual([]);
  }, 120000);

  it('serves C, a member, every swept GET that needs only project.read', async () => {
    const failures: string[] = [];
    const checked = sweptRoutes().filter(
      (r) => r.method === 'GET' && r.permission?.permission === 'project.read' && !NO_OWNER_CONTROL[r.key],
    );
    for (const route of checked) {
      const res = await call(route, tokenC, a);
      if (res.status < 200 || res.status >= 300) failures.push(`${res.status} ${res.url} ${res.text.slice(0, 300)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`Cross-tenant sweep, member GETs: ${checked.length} routes`);
    expect(checked.length).toBeGreaterThan(40);
    expect(failures).toEqual([]);
  }, 120000);

  it('hides channel webhook tokens, webhook URLs and service account identities from a member, and shows them to the owner', async () => {
    const reads = sweptRoutes().filter((r) => SECRET_BEARING_GET.test(r.key));
    expect(reads.map((r) => r.key).sort()).toEqual([
      'GET /api/email/settings/:projectId',
      'GET /api/projects/:projectId/mixpanel/status',
      'GET /api/projects/:projectId/webhooks',
      'GET /api/projects/:projectId/webhooks/:id',
      'GET /api/push-notifications/config-status/:projectId',
      'GET /api/sms/settings/:projectId',
      'GET /api/whatsapp/settings/:projectId',
    ]);
    // What each read must show the owner and hide from a member. webhooks/:id is
    // called with the secret webhook's id, not the fixture's first one.
    const expected: Record<string, string> = {
      'GET /api/email/settings/:projectId': channelTokens.email,
      'GET /api/sms/settings/:projectId': channelTokens.sms,
      'GET /api/whatsapp/settings/:projectId': channelTokens.whatsapp,
      'GET /api/projects/:projectId/webhooks': SECRET_MARKER,
      'GET /api/projects/:projectId/webhooks/:id': SECRET_MARKER,
      'GET /api/push-notifications/config-status/:projectId': pushClientEmail,
      'GET /api/projects/:projectId/mixpanel/status': mixpanelUsername,
    };
    const secrets = [...new Set(Object.values(expected))];
    const ids = { ...a, webhookId: secretWebhookId };
    const failures: string[] = [];
    for (const route of reads) {
      const member = await call(route, tokenC, ids);
      if (member.status !== 200) failures.push(`member ${member.status} ${member.url}`);
      for (const secret of secrets) {
        if (member.text.includes(secret)) failures.push(`member sees ${secret.slice(0, 12)}… in ${member.url}`);
      }
      // The control, per route: without it a route that never returns the secret
      // would pass for the member too.
      const owner = await call(route, tokenA, ids);
      if (owner.status !== 200) failures.push(`owner ${owner.status} ${owner.url}`);
      if (!owner.text.includes(expected[route.key])) {
        failures.push(`the owner does not see ${expected[route.key].slice(0, 12)}… in ${owner.url}, so the check proves nothing`);
      }
      // An admin has channels.manage, so sees it too.
      const admin = await call(route, tokenD, ids);
      if (!admin.text.includes(expected[route.key])) failures.push(`the admin does not see it in ${admin.url}`);
    }
    expect(failures).toEqual([]);
  }, 60000);

  it('gives B nothing of A\'s through B\'s own project, and changes none of A\'s rows', async () => {
    const failures: string[] = [];
    const crossBinding = sweptRoutes().filter(
      (r) =>
        isProjectScoped(r) &&
        !/^\/api\/projects\/:id(\/|$)/.test(r.path) && // :id is the project itself
        (r.pathParams.some((p) => p !== 'projectId') || namesAResource(BODIES[r.key]) || namesAResource(QUERIES[r.key])),
    );
    // Deletes last, so an unscoped delete cannot hide an unscoped read.
    crossBinding.sort((x, y) => Number(x.method === 'DELETE') - Number(y.method === 'DELETE'));
    for (const route of crossBinding) {
      const res = await call(route, tokenB, b);
      if (res.status >= 500) failures.push(`${res.status} ${res.url} ${res.text.slice(0, 300)}`);
      if (res.text.includes(MARKER)) failures.push(`leak: ${res.status} ${res.url} ${res.text.slice(0, 300)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`Cross-tenant sweep, cross-binding: ${crossBinding.length} routes`);
    // Account-level lists B may call: none may show A's rows.
    for (const route of jwtRoutes().filter((r) => r.method === 'GET' && r.pathParams.length === 0 && !isProjectScoped(r))) {
      const res = await call(route, tokenB, b);
      if (res.text.includes(MARKER)) failures.push(`leak: ${res.status} ${res.url}`);
    }
    expect(failures).toEqual([]);
    expect(await snapshotA()).toEqual(seededA);
  }, 120000);

  it('shows staff viewing as A only the projects billed to A', async () => {
    // A project billed to B in which A is also an owner.
    const shared = (await ds.getRepository(ProjectEntity).save({ name: 'shared, billed to B', ownerId: b.userId })).id;
    await addOwnerMember(ds, shared, b.userId);
    await addOwnerMember(ds, shared, a.userId);
    await ds.getRepository(LinkEntity).save({
      projectId: shared,
      shortCode: `s${randomUUID().slice(0, 8)}`,
      longUrl: 'https://example.com/shared',
    });

    const staff = await ds.getRepository(UserEntity).save({
      email: `staff${DOMAIN}`,
      name: 'Staff',
      passwordHash: 'x',
      isSuperAdmin: true,
    });
    const { sessionId } = await issueStaffSessionForTest(ds, { id: staff.id, email: staff.email, sessionVersion: 0 });
    const viewAs = await jwt.signAsync({
      sub: a.userId,
      email: `a${DOMAIN}`,
      type: 'access',
      imp: staff.id,
      impSv: 0,
      impSid: sessionId,
    });
    const get = async (path: string, token: string) => {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, text: await res.text() };
    };
    const listIds = async (token: string) => {
      const res = await get('/api/projects?limit=100', token);
      expect(res.status).toBe(200);
      return (JSON.parse(res.text).data as Array<{ id: string }>).map((p) => p.id);
    };
    const totalLinks = async (token: string) => {
      const res = await get('/api/dashboard/stats', token);
      expect(res.status).toBe(200);
      return JSON.parse(res.text).data.totalLinks as number;
    };

    // A, signed in themselves, sees both (the control).
    expect((await get(`/api/projects/${shared}`, tokenA)).status).toBe(200);
    expect(await listIds(tokenA)).toEqual(expect.arrayContaining([a.projectId, shared]));

    // Viewing as A: A's billed project, and not B's.
    const own = await get(`/api/projects/${a.projectId}`, viewAs);
    expect(own.status).toBe(200);
    expect(JSON.parse(own.text).data).toMatchObject({ id: a.projectId, role: 'owner', isBillingOwner: true });
    for (const path of [`/api/projects/${shared}`, `/api/projects/${shared}/links`]) {
      const res = await get(path, viewAs);
      expect(res.status).toBe(404);
      expect(res.text).toContain(PROJECT_NOT_FOUND);
    }
    const listed = await listIds(viewAs);
    expect(listed).toContain(a.projectId);
    expect(listed).not.toContain(shared);
    expect(await totalLinks(viewAs)).toBe((await totalLinks(tokenA)) - 1);
  }, 60000);
});

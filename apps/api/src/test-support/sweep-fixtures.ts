import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { getMetadataStorage } from 'class-validator';
import { createHash, randomUUID } from 'crypto';
import { DataSource, DeepPartial, EntityTarget, ObjectLiteral } from 'typeorm';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { ApiKeyEntity } from '../modules/api-keys/entities/api-key.entity';
import { AttributionResultEntity } from '../modules/attribution/entities/attribution-result.entity';
import { ConversionEventEntity } from '../modules/conversions/entities/conversion-event.entity';
import { DeviceIdentityEntity } from '../modules/identity/entities/device-identity.entity';
import { BannerCategoryEntity } from '../modules/in-app-banners/entities/banner-category.entity';
import { InAppBannerEntity } from '../modules/in-app-banners/entities/in-app-banner.entity';
import { InAppMessageEntity } from '../modules/in-app-messages/entities/in-app-message.entity';
import { JourneyEntity } from '../modules/journeys/entities/journey.entity';
import { LinkVariantEntity } from '../modules/links/entities/link-variant.entity';
import { LinkEntity } from '../modules/links/entities/link.entity';
import { MixpanelCohortEntity } from '../modules/mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { ProjectInvitationEntity } from '../modules/project-access/entities/project-invitation.entity';
import {
  PROJECT_PERMISSION_KEY,
  type ProjectPermissionMetadata,
} from '../modules/project-access/project-permission.metadata';
import { ChannelSuppressionEntity } from '../modules/push-notifications/entities/channel-suppression.entity';
import { PushNotificationLogEntity } from '../modules/push-notifications/entities/push-notification-log.entity';
import { PushTemplateEntity } from '../modules/push-notifications/entities/push-template.entity';
import { SegmentEntity } from '../modules/segments/entities/segment.entity';
import { TouchpointEntity } from '../modules/touchpoints/entities/touchpoint.entity';
import { WebhookEntity } from '../modules/webhooks/entities/webhook.entity';
import type { ProjectResource } from '../modules/project-access/project-access.service';
import { INT_DB_NAME } from './int-db';

/**
 * What the dashboard route sweeps share: the route list read from the running app,
 * the bodies and queries that get a request past validation, and one of each thing a
 * route can name. `cross-tenant-sweep.int-spec.ts` and `role-matrix.int-spec.ts` both
 * use these, so a route added to one is covered by the other.
 */

export type Ids = Record<string, string>;
export type Fixture = (ids: Ids) => Record<string, unknown>;

export interface Route {
  method: string;
  /** With the /api prefix, Express-style params. */
  path: string;
  key: string;
  /** Guard class names, class guards first, in the order Nest runs them. */
  guards: string[];
  pathParams: string[];
  bodyProjectId: boolean;
  queryProjectId: boolean;
  /** Send a JSON body: every write, whether or not the handler reads one. */
  hasBody: boolean;
  /** The handler reads `@Body()`. */
  takesBody: boolean;
  /**
   * Its `@Body()` is a class, so the global ValidationPipe checks it and an unknown
   * field is refused (`forbidNonWhitelisted`) before the handler runs.
   */
  bodyIsDto: boolean;
  /** What `@RequireProjectPermission` declared, if anything. */
  permission?: ProjectPermissionMetadata;
}

/**
 * JwtAuthGuard routes with no project anywhere that are legitimately so,
 * because they act on the caller's own account or on platform staff data.
 * They are still swept when they take a parameter (B naming A's session,
 * tenant...), they just do not have to carry a project.
 */
export const ACCOUNT_SCOPED: Array<{ match: RegExp; reason: string }> = [
  { match: /^(GET|POST) \/api\/projects$/, reason: 'lists the caller\'s visible projects, or creates one billed to them' },
  { match: /^GET \/api\/dashboard\/stats$/, reason: 'sums over the projects the caller is a member of (memberProjectsQuery)' },
  { match: /^PATCH \/api\/users\/me\/password$/, reason: 'the caller\'s own password' },
  { match: /^\S+ \/api\/auth\//, reason: 'the caller\'s own sessions, factors and sign-in; covered by the auth int-specs' },
  { match: /^\S+ \/api\/invitations\//, reason: 'the caller\'s own invite, by token' },
  // Staff routes live on the admin API now; admin-app-routes.int-spec.ts holds that
  // this app serves none of them.
];

/**
 * JwtAuthGuard routes keyed by a resource id with no projectId in the path,
 * body or query. `@RequireProjectPermission(..., { resource, param })` resolves the
 * resource's project and checks the caller's role there. Swept like the rest.
 */
export const RESOURCE_KEYED: Array<{ match: RegExp; resource: ProjectResource; reason: string }> = [
  { match: /^\S+ \/api\/links\/:id(\/|$)/, resource: 'link', reason: 'link → its project' },
  {
    match: /^\S+ \/api\/banner-categories\/:(id|categoryId)(\/|$)/,
    resource: 'bannerCategory',
    reason: 'banner category → its project',
  },
  { match: /^\S+ \/api\/in-app-banners\/:id$/, resource: 'banner', reason: 'banner → category → project' },
];

/** The resource kind RESOURCE_KEYED gives a route, if any. */
export const resourceKindOf = (r: Route): ProjectResource | undefined =>
  RESOURCE_KEYED.find((x) => x.match.test(r.key))?.resource;

/** Path parameter → fixture id. `:id` is named by the segment before it. */
export function resolveParam(path: string, name: string, ids: Ids): string {
  if (name === 'projectId') return ids.projectId;
  if (name === 'id') {
    const before = path.split('/:id')[0].split('/').pop() as string;
    const byCollection: Record<string, string> = {
      projects: 'projectId',
      links: 'linkId',
      'banner-categories': 'categoryId',
      'in-app-banners': 'bannerId',
      'in-app-messages': 'messageId',
      journeys: 'journeyId',
      segments: 'segmentId',
      'push-templates': 'templateId',
      webhooks: 'webhookId',
      'api-keys': 'apiKeyId',
      tenants: 'userId',
      sessions: 'sessionId',
      passkeys: 'passkeyId',
    };
    const key = byCollection[before];
    if (!key) throw new Error(`No fixture for :id after "${before}" in ${path}`);
    return ids[key];
  }
  // A project member's user id.
  if (name === 'memberId') {
    if (!ids.memberUserId) throw new Error(`No memberUserId fixture for ${path}`);
    return ids.memberUserId;
  }
  if (name === 'address') {
    if (path.startsWith('/api/email/')) return ids.email;
    return ids.phone;
  }
  const byName: Record<string, string> = {
    conversionId: 'conversionId',
    fingerprint: 'fingerprint',
    distinctId: 'externalUserId',
    personId: 'identityId',
    campaignId: 'campaignId',
    cohortId: 'cohortId',
    categoryId: 'categoryId',
    bannerId: 'bannerId',
    variantId: 'variantId',
    invitationId: 'invitationId',
  };
  const key = byName[name];
  if (!key) throw new Error(`No fixture for :${name} in ${path}`);
  return ids[key];
}

/**
 * Bodies that pass validation, so the request reaches the handler. Keyed by
 * route; projectId is filled in for every route whose DTO has one. A route
 * whose body is not valid fails the sweep with the validation message.
 */
const html = '<p>Hello <a href="https://example.com/offer">offer</a></p>';
export const BODIES: Record<string, Fixture> = {
  // Each references the fixture's own resources wherever the DTO takes one, so the
  // cross-binding pass asks B's project to act on A's.
  'POST /api/projects/:projectId/links': () => ({ longUrl: 'https://example.com/new' }),
  'POST /api/links/:id/variants': () => ({ name: 'v', longUrl: 'https://example.com/v' }),
  'POST /api/projects/:projectId/webhooks': () => ({ url: 'https://example.com/hook', events: ['conversion'] }),
  'POST /api/projects/:projectId/api-keys': () => ({ name: 'k' }),
  // The member's own role again: a no-op for whoever is allowed it, so the sweeps change nothing.
  'PATCH /api/projects/:projectId/members/:memberId': () => ({ role: 'member' }),
  'POST /api/projects/:projectId/billing-transfer': (ids) => ({ toUserId: ids.memberUserId }),
  // Inviting again replaces the pending invite in place, so repeated calls add nothing.
  'POST /api/projects/:projectId/invitations': () => ({ email: 'invitee@sweep-fixture.test', role: 'member' }),
  'POST /api/projects/:projectId/email-links/rewrite': () => ({ html }),
  'POST /api/projects/:projectId/banner-categories': () => ({ name: 'c' }),
  'POST /api/banner-categories/:categoryId/banners': () => ({ title: 't' }),
  'PATCH /api/banner-categories/:categoryId/banners/reorder': (ids) => ({
    items: [{ id: ids.bannerId, sortOrder: 0 }],
  }),
  'POST /api/push-notifications/configure': () => ({ fcmServiceAccountJson: '{}' }),
  'POST /api/push-notifications/test-send': () => ({ token: 'fcm-token', dryRun: true }),
  'POST /api/push-notifications/channels/credentials': () => ({ provider: 'fcm', credentials: '{}' }),
  'POST /api/push-notifications/audience-preview': (ids) => ({
    segmentId: ids.segmentId,
    deviceIdentityIds: [ids.identityId],
  }),
  'POST /api/push-notifications/send': (ids) => ({ title: 't', deviceIdentityIds: [ids.identityId] }),
  'POST /api/push-notifications/send-to-user': (ids) => ({ distinctId: ids.externalUserId, title: 't' }),
  'POST /api/identity/projects/:projectId/tracking-objections': (ids) => ({
    externalUserId: ids.externalUserId,
    sourceIdentityId: ids.identityId,
  }),
  'POST /api/identity/projects/:projectId/tracking-objections/lift': (ids) => ({ externalUserId: ids.externalUserId }),
  'POST /api/projects/:projectId/push-templates': () => ({ name: 'n', title: 't' }),
  'POST /api/projects/:projectId/segments': () => ({
    name: 's',
    definition: { type: 'attribute', field: 'country', op: 'eq', value: 'IN' },
  }),
  'POST /api/projects/:projectId/segments/preview': () => ({
    definition: { type: 'attribute', field: 'country', op: 'eq', value: 'IN' },
  }),
  'POST /api/projects/:projectId/mixpanel/configure': () => ({
    serviceAccountUsername: 'u',
    serviceAccountPassword: 'p',
    mixpanelProjectId: '1',
  }),
  'POST /api/projects/:projectId/mixpanel/cohorts/import': () => ({ mixpanelCohortId: 4242 }),
  'POST /api/projects/:projectId/mixpanel/cohorts/:cohortId/push': () => ({ title: 't' }),
  'POST /api/projects/:projectId/mixpanel/cohorts/:cohortId/iam-trigger': (ids) => ({ messageId: ids.messageId }),
  'POST /api/projects/:projectId/in-app-messages': () => ({ name: 'm', messageType: 'modal', title: 't' }),
  'POST /api/projects/:projectId/in-app-messages/trigger': (ids) => ({
    messageId: ids.messageId,
    targetType: 'users',
    distinctIds: [ids.externalUserId],
  }),
  'POST /api/projects/:projectId/journeys': (ids) => ({
    name: 'j',
    trigger: { type: 'segment_entry', segmentId: ids.segmentId },
    steps: [{ type: 'send_push', title: 't' }],
  }),
  'POST /api/projects/:projectId/journeys/:id/status': () => ({ status: 'paused' }),
  'POST /api/email/settings': () => ({ fromEmail: 'hello@example.com', postalAddress: '1 Main Street' }),
  'POST /api/email/providers': () => ({ provider: 'resend', credentials: '{}' }),
  'POST /api/email/audience-preview': (ids) => ({ segmentId: ids.segmentId, deviceIdentityIds: [ids.identityId] }),
  'POST /api/email/send': (ids) => ({ subject: 's', html, deviceIdentityIds: [ids.identityId] }),
  'POST /api/email/test-send': () => ({ to: 'someone@example.com', subject: 's', html }),
  'POST /api/email/suppressions': () => ({ address: 'someone@example.com' }),
  'POST /api/sms/settings': () => ({ sender: '+14155550123' }),
  'POST /api/sms/providers': () => ({ provider: 'twilio', credentials: '{}' }),
  'POST /api/sms/audience-preview': (ids) => ({ segmentId: ids.segmentId, deviceIdentityIds: [ids.identityId] }),
  'POST /api/sms/send': (ids) => ({ body: 'b', deviceIdentityIds: [ids.identityId] }),
  'POST /api/sms/test-send': () => ({ body: 'b', to: '+14155550123' }),
  'POST /api/sms/suppressions': () => ({ address: '+14155550123' }),
  'POST /api/whatsapp/providers': () => ({ provider: 'meta', credentials: '{}' }),
  'POST /api/whatsapp/audience-preview': (ids) => ({ segmentId: ids.segmentId, deviceIdentityIds: [ids.identityId] }),
  'POST /api/whatsapp/send': (ids) => ({
    content: { template: { id: 't', name: 't', language: 'en' }, bodyParams: [] },
    deviceIdentityIds: [ids.identityId],
  }),
  'POST /api/whatsapp/test-send': () => ({
    to: '+14155550123',
    content: { template: { id: 't', name: 't', language: 'en' }, bodyParams: [] },
  }),
  'POST /api/whatsapp/suppressions': () => ({ address: '+14155550123' }),
};

/** Routes that take a file rather than JSON. */
export const UPLOADS: Record<string, () => FormData> = {
  'POST /api/projects/:projectId/links/bulk': () => {
    const form = new FormData();
    form.append('file', new Blob(['longUrl,title\nhttps://example.com/a,a\n'], { type: 'text/csv' }), 'links.csv');
    return form;
  },
};

/** Query strings a GET needs to succeed for someone allowed it. */
export const QUERIES: Record<string, Fixture> = {
  'GET /api/identity/projects/:projectId/devices': (ids) => ({ userId: ids.externalUserId }),
  'GET /api/identity/projects/:projectId/tracking-objections/preview': (ids) => ({ externalUserId: ids.externalUserId }),
  // Every filter at once, so the sweeps reach the query with each one bound.
  'GET /api/projects/:projectId/activity': () => ({ group: 'team', from: '2026-01-01', to: '2026-12-31' }),
  'GET /api/projects/:projectId/activity/export': () => ({ group: 'team', from: '2026-01-01', to: '2026-12-31' }),
};

/**
 * GETs that cannot succeed even for someone allowed them in a test, so they are swept
 * for refusals but not replayed for success. Each needs a reason.
 */
export const NO_OWNER_CONTROL: Record<string, string> = {
  'GET /api/projects/:projectId/mixpanel/available-cohorts': 'calls Mixpanel with stored credentials',
  'GET /api/whatsapp/templates/:projectId': 'calls the WhatsApp provider with stored credentials',
};

export const isProjectScoped = (r: Route): boolean =>
  r.pathParams.includes('projectId') ||
  r.bodyProjectId ||
  r.queryProjectId ||
  /^\/api\/projects\/:id(\/|$)/.test(r.path);

export const isResourceKeyed = (r: Route): boolean => RESOURCE_KEYED.some((x) => x.match.test(r.key));

/**
 * Boots the customer app on the integration database with the global pipes, filter
 * and interceptor `main.ts` uses, on a random port. Restore the environment with the
 * returned `restoreEnv` after closing the app. `override` may replace providers (a cap a
 * test needs small, say) before the module compiles.
 */
export async function bootDashboardApp(
  opts: { override?: (builder: TestingModuleBuilder) => TestingModuleBuilder } = {},
): Promise<{
  app: INestApplication;
  base: string;
  restoreEnv: () => void;
}> {
  const saved = { name: process.env.DATABASE_NAME, nodeEnv: process.env.NODE_ENV };
  // The app reads its database from config: point it at the integration
  // database, and keep it off `synchronize` (dev/test only), which would
  // reshape the schema other suites share. Migrations instead, as openIntDb.
  process.env.DATABASE_NAME = INT_DB_NAME;
  process.env.NODE_ENV = 'integration';
  const { AppModule } = await import('../app.module');
  const builder = Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
    // Several hundred requests from one address; the global limit is 100 a minute.
    .overrideProvider(ThrottlerStorage)
    .useValue({ increment: async () => ({ totalHits: 1, timeToExpire: 60 }) });
  const moduleRef = await (opts.override ? opts.override(builder) : builder).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return {
    app,
    base,
    restoreEnv: () => {
      process.env.DATABASE_NAME = saved.name;
      process.env.NODE_ENV = saved.nodeEnv;
    },
  };
}

/** A class the ValidationPipe validates: not a built-in such as Object, String or Array. */
function isDtoClass(type: unknown): boolean {
  return (
    typeof type === 'function' &&
    ![Object, String, Number, Boolean, Array].includes(type as never) &&
    getMetadataStorage().getTargetValidationMetadatas(type, '', true, false).length > 0
  );
}

/** Every route, read from the controllers Nest actually registered. */
export function enumerateRoutes(app: INestApplication): Route[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const found: Route[] = [];
  const nameOf = (g: unknown) =>
    typeof g === 'function' ? g.name : (g as object)?.constructor?.name ?? String(g);
  const segs = (p: unknown): string[] => {
    const first = Array.isArray(p) ? p[0] : p;
    return typeof first === 'string' ? first.split('/').filter(Boolean) : [];
  };
  const validated = (dto: unknown): string[] =>
    typeof dto === 'function'
      ? getMetadataStorage()
          .getTargetValidationMetadatas(dto, '', true, false)
          .map((m) => m.propertyName)
      : [];

  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const proto = Object.getPrototypeOf(instance);
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, metatype) ?? [];
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name];
      const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
      const requestMethod: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
      if (methodPath === undefined || requestMethod === undefined) continue;
      const guards = [...classGuards, ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])].map(nameOf);
      const path = '/' + ['api', ...segs(Reflect.getMetadata(PATH_METADATA, metatype)), ...segs(methodPath)].join('/');
      const method = RequestMethod[requestMethod];
      const args: Record<string, { index: number; data?: unknown }> =
        Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, name) ?? {};
      const types: unknown[] = Reflect.getMetadata('design:paramtypes', proto, name) ?? [];
      let bodyProjectId = false;
      let queryProjectId = false;
      let hasBody = false;
      let bodyIsDto = false;
      for (const [k, arg] of Object.entries(args)) {
        const type = Number(k.split(':')[0]);
        if (type === RouteParamtypes.BODY) {
          hasBody = true;
          // A whole-body class (not `@Body('field')`, which validates one value).
          if (arg.data === undefined && isDtoClass(types[arg.index])) bodyIsDto = true;
          if (arg.data === 'projectId' || (arg.data === undefined && validated(types[arg.index]).includes('projectId')))
            bodyProjectId = true;
        }
        if (type === RouteParamtypes.QUERY) {
          if (arg.data === 'projectId' || (arg.data === undefined && validated(types[arg.index]).includes('projectId')))
            queryProjectId = true;
        }
      }
      const pathParams = [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
      // As the guard reads it: the handler's, else the class's.
      const permission: ProjectPermissionMetadata | undefined =
        Reflect.getMetadata(PROJECT_PERMISSION_KEY, handler) ?? Reflect.getMetadata(PROJECT_PERMISSION_KEY, metatype);
      found.push({
        method,
        path,
        key: `${method} ${path}`,
        guards,
        pathParams,
        bodyProjectId,
        queryProjectId,
        hasBody: hasBody || method !== 'GET',
        takesBody: hasBody,
        bodyIsDto,
        permission,
      });
    }
  }
  return found;
}

/**
 * Calls a route with `ids` filled into its path, query and body. `body` replaces the
 * fixture body (the role matrix sends an invalid one to stop at validation).
 */
export async function callRoute(
  base: string,
  route: Route,
  token: string,
  ids: Ids,
  opts: { body?: Record<string, unknown> } = {},
): Promise<{ status: number; text: string; url: string }> {
  let path = route.path;
  for (const p of route.pathParams) {
    path = path.replace(`:${p}`, encodeURIComponent(resolveParam(route.path, p, ids)));
  }
  const query = { ...(QUERIES[route.key]?.(ids) ?? {}) };
  if (route.queryProjectId) query.projectId = ids.projectId;
  const qs = new URLSearchParams(query as Record<string, string>).toString();
  let body: Record<string, unknown> | undefined;
  const upload = opts.body ? undefined : UPLOADS[route.key]?.();
  if (route.hasBody && !upload) {
    body = { ...(opts.body ?? BODIES[route.key]?.(ids) ?? {}) };
    if (route.bodyProjectId) body.projectId = ids.projectId;
  }
  const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, {
    method: route.method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-chumbaq-client': 'web',
      ...(upload ? {} : { 'content-type': 'application/json' }),
    },
    body: upload ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  return { status: res.status, text, url: `${route.method} ${path}${qs ? `?${qs}` : ''}` };
}

/** Saves one row and returns its id. */
export async function insertRow<T extends ObjectLiteral>(
  ds: DataSource,
  entity: EntityTarget<T>,
  row: object,
): Promise<string> {
  const repo = ds.getRepository(entity);
  return (await repo.save(repo.create(row as DeepPartial<T>))).id;
}

/**
 * One of each thing a project route can name, in `projectId`, with `marker` in every
 * human-readable field so a leak shows in any response body. Ids travel in URLs and
 * come back in error bodies, so they carry no marker. Returns the ids, `projectId`
 * included.
 */
export async function seedProjectData(ds: DataSource, projectId: string, marker: string): Promise<Ids> {
  const ids: Ids = { projectId };
  const p = projectId;
  ids.externalUserId = `user-${randomUUID()}`;
  ids.fingerprint = `fp-${randomUUID()}`;
  ids.email = `person-${randomUUID().slice(0, 8)}@example.com`;
  ids.phone = '+919800000001';
  ids.identityId = await insertRow(ds, DeviceIdentityEntity, {
    projectId: p,
    deviceFingerprint: ids.fingerprint,
    externalUserId: ids.externalUserId,
    platform: 'ios',
    email: ids.email,
    traits: { note: marker },
  });

  const link = await ds.getRepository(LinkEntity).save({
    projectId: p,
    shortCode: `x${randomUUID().slice(0, 8)}`,
    longUrl: `https://example.com/${marker}`,
    title: marker,
  });
  ids.linkId = link.id;
  ids.variantId = await insertRow(ds, LinkVariantEntity, {
    linkId: link.id,
    name: marker,
    longUrl: `https://example.com/v/${marker}`,
  });
  ids.conversionId = await insertRow(ds, ConversionEventEntity, {
    linkId: link.id,
    eventType: 'purchase',
    metadata: { note: marker },
  });
  await ds.getRepository(AttributionResultEntity).save({
    projectId: p,
    conversionId: ids.conversionId,
    model: 'first_touch',
    creditSplits: [{ channel: marker, credit: 1 }],
    touchpointCount: 1,
  });
  await insertRow(ds, TouchpointEntity, {
    projectId: p,
    touchpointType: 'utm',
    distinctId: ids.externalUserId,
    utmSource: marker,
  });
  ids.segmentId = await insertRow(ds, SegmentEntity, {
    projectId: p,
    name: marker,
    definition: { type: 'attribute', field: 'country', op: 'eq', value: 'IN' },
  });
  ids.journeyId = await insertRow(ds, JourneyEntity, {
    projectId: p,
    name: marker,
    trigger: { type: 'segment_entry', segmentId: ids.segmentId },
    steps: [{ type: 'send_push', title: marker }],
  });
  ids.campaignId = await insertRow(ds, PushNotificationLogEntity, { projectId: p, title: marker, body: marker });
  ids.templateId = await insertRow(ds, PushTemplateEntity, { projectId: p, name: marker, title: marker });
  ids.webhookId = await insertRow(ds, WebhookEntity, {
    projectId: p,
    url: `https://hooks.example.com/${marker}`,
    events: ['conversion'],
    secretSealed: 'v1.unused-in-this-suite',
    secretHint: 'zzzz',
    isActive: false,
  });
  ids.apiKeyId = await insertRow(ds, ApiKeyEntity, {
    projectId: p,
    name: marker,
    keyHash: randomUUID(),
    prefix: 'ck_zzzz',
  });
  ids.messageId = await insertRow(ds, InAppMessageEntity, {
    projectId: p,
    name: marker,
    messageType: 'modal',
    title: marker,
  });
  ids.categoryId = await insertRow(ds, BannerCategoryEntity, { projectId: p, name: marker });
  ids.bannerId = await insertRow(ds, InAppBannerEntity, { categoryId: ids.categoryId, title: marker });
  ids.cohortId = await insertRow(ds, MixpanelCohortEntity, { projectId: p, mixpanelCohortId: 4242, name: marker });
  // A pending invitation, as InvitationsService writes one (only the token's hash).
  ids.invitationId = await insertRow(ds, ProjectInvitationEntity, {
    projectId: p,
    email: `invitee-${randomUUID().slice(0, 8)}@example.com`,
    role: 'member',
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  for (const [channel, address] of [
    ['email', ids.email],
    ['sms', ids.phone],
    ['whatsapp', ids.phone],
  ]) {
    await insertRow(ds, ChannelSuppressionEntity, {
      projectId: p,
      channel,
      address,
      reason: 'unsubscribed',
      source: 'manual',
    });
  }
  return ids;
}

import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { ALLOW_ENROLMENT_SESSION } from '../modules/staff-auth/allow-enrolment-session.decorator';
import { INT_DB_NAME } from './int-db';

export interface BootedApp {
  app: INestApplication;
  base: string;
}

/**
 * Either API as its entry point builds it (prefix, pipe, filter, interceptor), on the
 * integration database, listening on a free port. Call after `openIntDb`, which has
 * applied the migrations and loaded the .env.
 *
 * The throttle is off unless asked for: these specs make many requests from one address.
 * `providers` replaces providers by token, as `BILLING_PROVIDER` with a
 * `FakeBillingProvider`, so no spec reaches a real provider.
 */
export async function bootIntApp(
  which: 'customer' | 'admin',
  {
    throttle = false,
    providers = [],
  }: { throttle?: boolean; providers?: Array<{ token: unknown; useValue: unknown }> } = {},
): Promise<BootedApp> {
  // Off `synchronize` (dev/test only), which would reshape the schema other suites share.
  process.env.DATABASE_NAME = INT_DB_NAME;
  process.env.NODE_ENV = 'integration';
  const root =
    which === 'customer'
      ? (await import('../app.module')).AppModule
      : (await import('../admin-app.module')).AdminAppModule;
  let builder = Test.createTestingModule({ imports: [root, DiscoveryModule] });
  if (!throttle) {
    builder = builder
      .overrideProvider(ThrottlerStorage)
      .useValue({ increment: async () => ({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }) });
  }
  for (const { token, useValue } of providers) {
    builder = builder.overrideProvider(token as never).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication(which === 'customer' ? { rawBody: true } : {});
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.listen(0, '127.0.0.1');
  return { app, base: (await app.getUrl()).replace('[::1]', '127.0.0.1') };
}

export interface ListedRoute {
  method: string;
  /** With the /api prefix, Express-style params. */
  path: string;
  key: string;
  guards: string[];
  allowsEnrolment: boolean;
}

/** Every route the app's controllers declare, read from their metadata. */
export function listRoutes(app: INestApplication): ListedRoute[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const nameOf = (g: unknown) =>
    typeof g === 'function' ? g.name : ((g as object)?.constructor?.name ?? String(g));
  const segs = (p: unknown): string[] => {
    const first = Array.isArray(p) ? p[0] : p;
    return typeof first === 'string' ? first.split('/').filter(Boolean) : [];
  };
  const found: ListedRoute[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const proto = Object.getPrototypeOf(instance);
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, metatype) ?? [];
    const classAllows = Reflect.getMetadata(ALLOW_ENROLMENT_SESSION, metatype) === true;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name];
      const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
      const requestMethod: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
      if (methodPath === undefined || requestMethod === undefined) continue;
      const guards = [...classGuards, ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])].map(nameOf);
      const path = '/' + ['api', ...segs(Reflect.getMetadata(PATH_METADATA, metatype)), ...segs(methodPath)].join('/');
      const method = RequestMethod[requestMethod];
      found.push({
        method,
        path,
        key: `${method} ${path}`,
        guards,
        allowsEnrolment: classAllows || Reflect.getMetadata(ALLOW_ENROLMENT_SESSION, handler) === true,
      });
    }
  }
  return found;
}

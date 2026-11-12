import { ConfigService } from '@nestjs/config';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { SecondFactorsService } from '../auth/second-factors.service';
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';

/** What StaffJwtStrategy puts on the request for a full staff session. */
const STAFF = { kind: 'staff', enrolmentOnly: false, sessionId: 'staff-session', sessionVersion: 0, amr: ['webauthn', 'uv'] };

const TENANT = '3f2b8c1e-7a4d-4e9b-8c21-5d6f7a8b9c0d';
const ADMIN = { userId: 'a1a1a1a1-0000-4000-8000-000000000001', email: 'staff@chumbaq.test' };
const REASON = { reason: 'repeated abuse reports' };

/**
 * Real HTTP through the real pipe, interceptor and SuperAdminGuard, with only the
 * token check and the service replaced: the service's own behaviour is proved
 * against Postgres in admin-tenants.int-spec.ts.
 */
describe('AdminTenantsController (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let requestUser: Record<string, unknown> | undefined;

  const service = {
    list: jest.fn(),
    view: jest.fn(),
    suspend: jest.fn(),
    reactivate: jest.fn(),
    setProjectLimit: jest.fn(),
    setSeatLimit: jest.fn(),
  };

  const fakeJwtGuard: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().user = requestUser;
      return true;
    },
  };

  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${baseUrl}/admin/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminTenantsController],
      providers: [
        { provide: AdminTenantsService, useValue: service },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: SecondFactorsService, useValue: { passkeyCount: async () => 0 } },
      ],
    })
      .overrideGuard(StaffJwtAuthGuard)
      .useValue(fakeJwtGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: true, authTime: Math.floor(Date.now() / 1000) };
  });

  it.each([
    ['tenants', 'GET', undefined],
    [`tenants/${TENANT}`, 'GET', undefined],
    [`tenants/${TENANT}/suspend`, 'POST', REASON],
    [`tenants/${TENANT}/reactivate`, 'POST', REASON],
    [`tenants/${TENANT}/project-limit`, 'PATCH', { ...REASON, projectLimit: 20 }],
    [`tenants/${TENANT}/seat-limit`, 'PATCH', { ...REASON, seatLimit: 20 }],
  ])('refuses %s (%s) to a normal user and to an impersonation token', async (path, method, body) => {
    requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: false };
    expect((await call(path, method, body)).status).toBe(403);

    requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: true, impersonatedBy: ADMIN.userId };
    expect((await call(path, method, body)).status).toBe(403);

    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('passes the list envelope through unwrapped', async () => {
    const page = { data: [], meta: { total: 0, page: 2, limit: 5, totalPages: 0 } };
    service.list.mockResolvedValue(page);

    const response = await call('tenants?page=2&limit=5&search=priya&status=active');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(service.list.mock.calls[0][0]).toMatchObject({
      page: 2,
      limit: 5,
      search: 'priya',
      status: 'active',
    });
  });

  it('wraps the detail in { data }', async () => {
    service.view.mockResolvedValue({ id: TENANT });
    const response = await call(`tenants/${TENANT}`);
    expect(await response.json()).toEqual({ data: { id: TENANT } });
  });

  // Through `view`, never `findOne`, or a staff read of the tenant goes unrecorded.
  it('reads the detail as a recorded view by the signed-in admin', async () => {
    service.view.mockResolvedValue({ id: TENANT });
    await call(`tenants/${TENANT}`);
    expect(service.view).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ userId: requestUser?.userId, email: requestUser?.email }),
    );
  });

  it.each([
    ['tenants/not-a-uuid', 'GET', undefined],
    ['tenants/not-a-uuid/suspend', 'POST', REASON],
    ['tenants/not-a-uuid/reactivate', 'POST', REASON],
    ['tenants/not-a-uuid/project-limit', 'PATCH', { ...REASON, projectLimit: 20 }],
    ['tenants/not-a-uuid/seat-limit', 'PATCH', { ...REASON, seatLimit: 20 }],
  ])('refuses a malformed id on %s', async (path, method, body) => {
    expect((await call(path, method, body)).status).toBe(400);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ['suspend', 'suspend'],
    ['reactivate', 'reactivate'],
  ] as const)('%s answers 200 and credits the JWT user and socket address', async (route, fn) => {
    service[fn].mockResolvedValue({ id: TENANT });

    const response = await call(`tenants/${TENANT}/${route}`, 'POST', {
      reason: '  repeated abuse reports  ',
    });

    expect(response.status).toBe(200);
    expect(service[fn]).toHaveBeenCalledWith(TENANT, 'repeated abuse reports', {
      userId: ADMIN.userId,
      email: ADMIN.email,
      ipAddress: expect.stringMatching(/127\.0\.0\.1$/),
    });
  });

  it('asks for a recent sign-in before suspending, and does not touch the tenant', async () => {
    requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: true, authTime: Math.floor(Date.now() / 1000) - 3600 };

    const response = await call(`tenants/${TENANT}/suspend`, 'POST', { reason: 'repeated abuse reports' });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toBe(REAUTH_REQUIRED_MESSAGE);
    expect(service.suspend).not.toHaveBeenCalled();
  });

  it.each(['suspend', 'reactivate'])('%s refuses a short reason before the service', async (route) => {
    const response = await call(`tenants/${TENANT}/${route}`, 'POST', { reason: 'short' });
    expect(response.status).toBe(400);
    expect(service.suspend).not.toHaveBeenCalled();
    expect(service.reactivate).not.toHaveBeenCalled();
  });

  it.each(['suspend', 'reactivate'] as const)('%s has its own throttle limit', (handler) => {
    const limit = Reflect.getMetadata(
      `${THROTTLER_LIMIT}default`,
      AdminTenantsController.prototype[handler],
    );
    expect(limit).toBe(20);
  });

  describe('project limit', () => {
    it.each([
      [20, 20],
      [0, 0],
      [null, null],
    ])('sets %p for the signed-in admin, with the reason', async (projectLimit, expected) => {
      service.setProjectLimit.mockResolvedValue({ id: TENANT });

      const response = await call(`tenants/${TENANT}/project-limit`, 'PATCH', { ...REASON, projectLimit });

      expect(response.status).toBe(200);
      expect(service.setProjectLimit).toHaveBeenCalledWith(TENANT, expected, REASON.reason, {
        userId: ADMIN.userId,
        email: ADMIN.email,
        ipAddress: expect.stringMatching(/127\.0\.0\.1$/),
      });
    });

    it.each([
      ['a missing limit', { ...REASON }],
      ['a negative limit', { ...REASON, projectLimit: -1 }],
      ['a fraction', { ...REASON, projectLimit: 2.5 }],
      ['a string', { ...REASON, projectLimit: '20' }],
      ['a limit over 1000', { ...REASON, projectLimit: 1001 }],
      ['no reason', { projectLimit: 20 }],
      ['a short reason', { reason: 'short', projectLimit: 20 }],
    ])('refuses %s before the service', async (_, body) => {
      const response = await call(`tenants/${TENANT}/project-limit`, 'PATCH', body);
      expect(response.status).toBe(400);
      expect(service.setProjectLimit).not.toHaveBeenCalled();
    });
  });

  describe('seat limit', () => {
    it.each([
      [20, 20],
      [0, 0],
      [null, null],
    ])('sets %p for the signed-in admin, with the reason', async (seatLimit, expected) => {
      service.setSeatLimit.mockResolvedValue({ id: TENANT });

      const response = await call(`tenants/${TENANT}/seat-limit`, 'PATCH', { ...REASON, seatLimit });

      expect(response.status).toBe(200);
      expect(service.setSeatLimit).toHaveBeenCalledWith(TENANT, expected, REASON.reason, {
        userId: ADMIN.userId,
        email: ADMIN.email,
        ipAddress: expect.stringMatching(/127\.0\.0\.1$/),
      });
    });

    it.each([
      ['a missing limit', { ...REASON }],
      ['a negative limit', { ...REASON, seatLimit: -1 }],
      ['a fraction', { ...REASON, seatLimit: 2.5 }],
      ['a string', { ...REASON, seatLimit: '5' }],
      ['a limit over 1000', { ...REASON, seatLimit: 1001 }],
      ['no reason', { seatLimit: 20 }],
      ['a short reason', { reason: 'short', seatLimit: 20 }],
    ])('refuses %s before the service', async (_, body) => {
      const response = await call(`tenants/${TENANT}/seat-limit`, 'PATCH', body);
      expect(response.status).toBe(400);
      expect(service.setSeatLimit).not.toHaveBeenCalled();
    });
  });
});

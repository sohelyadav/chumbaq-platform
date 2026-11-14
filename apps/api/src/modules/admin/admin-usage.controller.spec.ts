import { ConfigService } from '@nestjs/config';
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { SecondFactorsService } from '../auth/second-factors.service';
import { VolumeWatchService } from '../security-alerts/volume-watch.service';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { AdminModule } from './admin.module';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminUsageController } from './admin-usage.controller';
import { AdminUsageService } from './admin-usage.service';

/** What StaffJwtStrategy puts on the request for a full staff session. */
const STAFF = { kind: 'staff', enrolmentOnly: false, sessionId: 'staff-session', sessionVersion: 0, amr: ['webauthn', 'uv'] };
const TENANT = '3f2b8c1e-7a4d-4e9b-8c21-5d6f7a8b9c0d';
const ADMIN = { userId: 'a1a1a1a1-0000-4000-8000-000000000001', email: 'staff@chumbaq.test' };

/** The controllers in the order AdminModule declares them, which is what decides route matching. */
const MODULE_CONTROLLERS: unknown[] = Reflect.getMetadata('controllers', AdminModule);
const ORDERED = MODULE_CONTROLLERS.filter(
  (controller) => controller === AdminUsageController || controller === AdminTenantsController,
) as (typeof AdminUsageController | typeof AdminTenantsController)[];

/**
 * Real HTTP through the real pipe, interceptor and SuperAdminGuard, with only the
 * token check and the services replaced. Both controllers are mounted, in the
 * module's order, because `tenants/export` and `tenants/:id` compete for a path.
 */
describe('AdminUsageController (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let requestUser: Record<string, unknown> | undefined;

  const usage = { tenantUsage: jest.fn() };
  const tenants = {
    list: jest.fn(),
    view: jest.fn(),
    exportCsv: jest.fn(),
  };
  const volume = { exported: jest.fn() };

  const fakeJwtGuard: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().user = requestUser;
      return true;
    },
  };

  const call = (path: string) => fetch(`${baseUrl}/admin/${path}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: ORDERED,
      providers: [
        { provide: AdminUsageService, useValue: usage },
        { provide: AdminTenantsService, useValue: tenants },
        { provide: VolumeWatchService, useValue: volume },
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

  it('is declared before the tenants controller in AdminModule', () => {
    expect(ORDERED).toEqual([AdminUsageController, AdminTenantsController]);
  });

  it.each([['tenants/export'], [`tenants/${TENANT}/usage`]])(
    'refuses %s to a normal user and to an impersonation token',
    async (path) => {
      requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: false };
      expect((await call(path)).status).toBe(403);
      requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: true, impersonatedBy: ADMIN.userId };
      expect((await call(path)).status).toBe(403);
      requestUser = undefined;
      expect((await call(path)).status).toBe(403);

      for (const fn of [...Object.values(tenants), ...Object.values(usage)]) expect(fn).not.toHaveBeenCalled();
    },
  );

  describe('GET /admin/tenants/export', () => {
    it('reaches the export with the filters and sends a CSV file', async () => {
      tenants.exportCsv.mockResolvedValueOnce({ csv: 'tenant_id\r\nx\r\n', rowCount: 1, truncated: false });

      const response = await call('tenants/export?activity=quiet&status=active&sort=last_usage_day&order=asc');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('content-disposition')).toMatch(
        /^attachment; filename="chumbaq-tenants-\d{8}-\d{6}\.csv"$/,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-export-row-count')).toBe('1');
      expect(response.headers.get('x-export-row-cap')).toBe('10000');
      expect(response.headers.get('x-export-truncated')).toBe('false');
      expect(response.headers.get('access-control-expose-headers')).toContain('X-Export-Truncated');
      // Not enveloped, and with the byte-order mark Excel needs.
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(bytes.subarray(3).toString('utf8')).toBe('tenant_id\r\nx\r\n');

      const [filters, actor, cap] = tenants.exportCsv.mock.calls[0];
      expect(filters).toMatchObject({ activity: 'quiet', status: 'active', sort: 'last_usage_day', order: 'asc' });
      expect(actor).toMatchObject({ userId: ADMIN.userId, email: ADMIN.email });
      // The cap is the service's own; the route never widens it.
      expect(cap).toBeUndefined();
      expect(tenants.view).not.toHaveBeenCalled();
      expect(volume.exported).toHaveBeenCalledWith(ADMIN.userId, null, 1, 'tenants export');
    });

    it('says when the cap cut rows off', async () => {
      tenants.exportCsv.mockResolvedValueOnce({ csv: 'tenant_id\r\n', rowCount: 10_000, truncated: true });
      const response = await call('tenants/export');
      expect(response.headers.get('x-export-truncated')).toBe('true');
      expect(response.headers.get('x-export-row-count')).toBe('10000');
    });

    it.each([
      ['paging, which an export does not take', 'page=2'],
      ['a limit', 'limit=10'],
      ['an unknown activity', 'activity=dormant'],
      ['an unknown sort', 'sort=email'],
    ])('refuses %s', async (_, query) => {
      expect((await call(`tenants/export?${query}`)).status).toBe(400);
      expect(tenants.exportCsv).not.toHaveBeenCalled();
    });

    it('has its own throttle limit', () => {
      const limit = Reflect.getMetadata(`${THROTTLER_LIMIT}default`, AdminUsageController.prototype.exportTenants);
      expect(limit).toBe(10);
    });
  });

  describe('GET /admin/tenants/:id/usage', () => {
    it('reads 90 days by default, or the days asked for', async () => {
      usage.tenantUsage.mockResolvedValue({ days: 90 });

      expect((await call(`tenants/${TENANT}/usage`)).status).toBe(200);
      expect((await call(`tenants/${TENANT}/usage?days=30`)).status).toBe(200);

      expect(usage.tenantUsage.mock.calls[0].slice(0, 2)).toEqual([TENANT, 90]);
      expect(usage.tenantUsage.mock.calls[1].slice(0, 2)).toEqual([TENANT, 30]);
      expect(usage.tenantUsage.mock.calls[0][2]).toMatchObject({ userId: ADMIN.userId, email: ADMIN.email });
    });

    it.each([
      ['too few days', `tenants/${TENANT}/usage?days=5`],
      ['too many days', `tenants/${TENANT}/usage?days=367`],
      ['days that are not a whole number', `tenants/${TENANT}/usage?days=7.5`],
      ['an id that is not a uuid', 'tenants/not-a-uuid/usage'],
    ])('refuses %s', async (_, path) => {
      expect((await call(path)).status).toBe(400);
      expect(usage.tenantUsage).not.toHaveBeenCalled();
    });
  });
});

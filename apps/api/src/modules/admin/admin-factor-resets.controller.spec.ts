import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { FactorResetController } from '../auth/factor-reset.controller';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { SecondFactorsService } from '../auth/second-factors.service';
import { FactorResetsService } from '../factor-resets/factor-resets.service';
import { AdminFactorResetsController } from './admin-factor-resets.controller';

/** What StaffJwtStrategy puts on the request for a full staff session. */
const STAFF = { kind: 'staff', enrolmentOnly: false, sessionId: 'staff-session', sessionVersion: 0, amr: ['webauthn', 'uv'] };

const TENANT = '3f2b8c1e-7a4d-4e9b-8c21-5d6f7a8b9c0d';
const ADMIN = { userId: 'a1a1a1a1-0000-4000-8000-000000000001', email: 'staff@chumbaq.test' };
const OWNER = { userId: 'b2b2b2b2-0000-4000-8000-000000000002', email: 'owner@chumbaq.test' };
const VERIFIED = { verificationMethod: 'video_call', verificationNotes: 'Matched passport on a video call' };
const REASON = { reason: 'lost phone and recovery codes', ...VERIFIED };

/**
 * Real HTTP through the real pipe and guards, with only the token check and the service
 * replaced: what the service does is proved against Postgres in factor-resets.int-spec.ts.
 */
describe('factor reset controllers (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let requestUser: Record<string, unknown> | undefined;

  const service = {
    adminState: jest.fn(),
    request: jest.fn(),
    cancelByStaff: jest.fn(),
    ownerState: jest.fn(),
    cancelByOwner: jest.fn(),
  };

  const fakeJwtGuard: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().user = requestUser;
      return true;
    },
  };

  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${baseUrl}/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const now = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminFactorResetsController, FactorResetController],
      providers: [
        { provide: FactorResetsService, useValue: service },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: SecondFactorsService, useValue: { passkeyCount: async () => 0 } },
      ],
    })
      // Staff routes on the admin API, the owner's on the customer API.
      .overrideGuard(StaffJwtAuthGuard)
      .useValue(fakeJwtGuard)
      .overrideGuard(JwtAuthGuard)
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
    requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: true, authTime: now() };
  });

  describe('staff', () => {
    const path = `admin/tenants/${TENANT}/factor-reset`;

    it.each([
      ['GET', undefined],
      ['POST', REASON],
      ['DELETE', undefined],
    ])('refuses %s to a tenant and to an impersonation token', async (method, body) => {
      requestUser = { ...OWNER, isSuperAdmin: false, authTime: now() };
      expect((await call(path, method, body)).status).toBe(403);

      requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: true, impersonatedBy: ADMIN.userId, authTime: now() };
      expect((await call(path, method, body)).status).toBe(403);

      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it('starts a reset with the trimmed reason, crediting the staff member', async () => {
      service.request.mockResolvedValue({ hasFactors: true, pending: null });

      const response = await call(path, 'POST', {
        reason: '  lost phone and recovery codes  ',
        verificationMethod: 'government_id',
        verificationNotes: '  Passport shown on camera, name matches  ',
      });

      expect(response.status).toBe(201);
      expect(service.request).toHaveBeenCalledWith(
        TENANT,
        'lost phone and recovery codes',
        { userId: ADMIN.userId, email: ADMIN.email, ipAddress: expect.stringMatching(/127\.0\.0\.1$/) },
        {
          verificationMethod: 'government_id',
          verificationNotes: 'Passport shown on camera, name matches',
          passwordResetOverride: null,
        },
      );
    });

    it('passes a trimmed password reset justification on separately', async () => {
      service.request.mockResolvedValue({ hasFactors: true, pending: null });

      const response = await call(path, 'POST', {
        ...REASON,
        recentResetJustification: '  owner confirmed the reset was theirs  ',
      });

      expect(response.status).toBe(201);
      expect(service.request).toHaveBeenCalledWith(TENANT, REASON.reason, expect.anything(), {
        ...VERIFIED,
        passwordResetOverride: 'owner confirmed the reset was theirs',
      });
    });

    it('asks for a recent sign-in before starting one', async () => {
      requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: true, authTime: now() - 3600 };

      const response = await call(path, 'POST', REASON);

      expect(response.status).toBe(403);
      expect(((await response.json()) as { message: string }).message).toBe(REAUTH_REQUIRED_MESSAGE);
      expect(service.request).not.toHaveBeenCalled();
    });

    it.each([
      [{}],
      [{ ...REASON, reason: 'short' }],
      [{ ...REASON, reason: 'x'.repeat(501) }],
      [{ reason: REASON.reason }],
      [{ ...REASON, verificationMethod: undefined }],
      [{ ...REASON, verificationMethod: 'email' }],
      [{ ...REASON, verificationNotes: undefined }],
      [{ ...REASON, verificationNotes: 'too short' }],
      [{ ...REASON, executeAfter: '2026-01-01' }],
      [{ ...REASON, recentResetJustification: 'short' }],
      [{ ...REASON, recentResetJustification: 'x'.repeat(501) }],
      [{ ...REASON, recentResetJustification: { a: 1 } }],
    ])('refuses %j before the service', async (body) => {
      expect((await call(path, 'POST', body)).status).toBe(400);
      expect(service.request).not.toHaveBeenCalled();
    });

    it('cancels without needing a recent sign-in, since it only keeps things as they are', async () => {
      requestUser = { ...ADMIN, ...STAFF, isSuperAdmin: true, authTime: now() - 3600 };
      service.cancelByStaff.mockResolvedValue({ hasFactors: true, pending: null });

      const response = await call(path, 'DELETE');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: { hasFactors: true, pending: null } });
      expect(service.cancelByStaff).toHaveBeenCalledWith(TENANT, expect.objectContaining({ userId: ADMIN.userId }));
    });

    it('refuses a malformed id', async () => {
      expect((await call('admin/tenants/not-a-uuid/factor-reset')).status).toBe(400);
      expect(service.adminState).not.toHaveBeenCalled();
    });
  });

  describe('the owner', () => {
    beforeEach(() => {
      requestUser = { ...OWNER, isSuperAdmin: false };
    });

    it('reads the state and cancels as themselves', async () => {
      service.ownerState.mockResolvedValue({ pending: null });

      expect(await (await call('auth/factor-reset')).json()).toEqual({ data: { pending: null } });
      expect(service.ownerState).toHaveBeenCalledWith(OWNER.userId);

      const response = await call('auth/factor-reset', 'DELETE');
      expect(response.status).toBe(204);
      expect(service.cancelByOwner).toHaveBeenCalledWith(
        expect.objectContaining({ userId: OWNER.userId }),
        expect.objectContaining({ ipAddress: expect.stringMatching(/127\.0\.0\.1$/) }),
      );
    });

    it.each(['GET', 'DELETE'])('refuses %s to staff looking through the account', async (method) => {
      requestUser = { ...OWNER, isSuperAdmin: false, impersonatedBy: ADMIN.userId };
      expect((await call('auth/factor-reset', method)).status).toBe(403);
      expect(service.ownerState).not.toHaveBeenCalled();
      expect(service.cancelByOwner).not.toHaveBeenCalled();
    });
  });
});

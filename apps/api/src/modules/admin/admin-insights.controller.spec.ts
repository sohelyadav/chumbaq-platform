import { ConfigService } from '@nestjs/config';
import { SecondFactorsService } from '../auth/second-factors.service';
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { AdminInsightsController } from './admin-insights.controller';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import { AdminInsightsService } from './admin-insights.service';

/** What StaffJwtStrategy puts on the request for a full staff session. */
const STAFF = { kind: 'staff', enrolmentOnly: false, sessionId: 'staff-session', sessionVersion: 0, amr: ['webauthn', 'uv'] };

/** Real pipe, interceptor and SuperAdminGuard over HTTP; only JWT parsing is faked. */
describe('AdminInsightsController over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let user: Record<string, unknown> | undefined;
  const platformEmail = { send: jest.fn(), isConfigured: true, sender: { email: 'a@b.com' } };

  const insights = {
    overview: jest.fn(async () => ({ projects: 7 })),
    health: jest.fn(async () => ({ status: 'degraded' })),
  };

  const fakeJwt: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().user = user;
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminInsightsController],
      providers: [
        { provide: AdminInsightsService, useValue: insights },
        { provide: PlatformEmailService, useValue: platformEmail },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: SecondFactorsService, useValue: { passkeyCount: async () => 0 } },
      ],
    })
      .overrideGuard(StaffJwtAuthGuard)
      .useValue(fakeJwt)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/admin`;
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    user = { id: 'admin', ...STAFF, isSuperAdmin: true };
  });

  it('enveloped overview and health, health being 200 even when degraded', async () => {
    const overview = await fetch(`${base}/overview`);
    expect(overview.status).toBe(200);
    expect(await overview.json()).toEqual({ data: { projects: 7 } });

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ data: { status: 'degraded' } });
  });

  it.each([
    ['a non-super-admin', { id: 'tenant', ...STAFF, isSuperAdmin: false }],
    ['an impersonation token', { id: 'tenant', ...STAFF, isSuperAdmin: true, impersonatedBy: 'admin' }],
  ])('refuses %s on every route', async (_who, who) => {
    user = who;

    for (const route of ['overview', 'health']) {
      expect((await fetch(`${base}/${route}`)).status).toBe(403);
    }
    expect(insights.overview).not.toHaveBeenCalled();
  });

  describe('POST /admin/platform-email/test', () => {
    const post = (body: object) =>
      fetch(`${base}/platform-email/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    beforeEach(() => platformEmail.send.mockReset());

    it('sends to the given address and says where', async () => {
      platformEmail.send.mockResolvedValue({ sent: true });

      const response = await post({ to: 'someone@example.com' });

      expect(response.status).toBe(200);
      expect(platformEmail.send.mock.calls[0][0].to).toBe('someone@example.com');
    });

    it('says what to set when nothing is configured', async () => {
      platformEmail.send.mockResolvedValue({ sent: false, reason: 'not_configured' });

      expect((await post({ to: 'someone@example.com' })).status).toBe(409);
    });

    it('reports a provider refusal as a bad gateway', async () => {
      platformEmail.send.mockResolvedValue({ sent: false, reason: 'refused' });

      expect((await post({ to: 'someone@example.com' })).status).toBe(502);
    });

    it('rejects something that is not an address', async () => {
      expect((await post({ to: 'not-an-address' })).status).toBe(400);
      expect(platformEmail.send).not.toHaveBeenCalled();
    });
  });
});

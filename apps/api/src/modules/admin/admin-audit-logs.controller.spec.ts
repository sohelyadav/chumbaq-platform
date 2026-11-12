import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { SecondFactorsService } from '../auth/second-factors.service';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AdminAuditLogsService } from './admin-audit-logs.service';

/** What StaffJwtStrategy puts on the request for a full staff session. */
const STAFF = { kind: 'staff', enrolmentOnly: false, sessionId: 'staff-session', sessionVersion: 0, amr: ['webauthn', 'uv'] };

const TARGET_ID = 'e8600afc-f4a8-4b79-ade2-64491611c32d';
const ACTOR_ID = '3c1d1f0e-2b7a-4c55-8d3e-6a0a5b9c7d21';
const PAGE = { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } };

/** Real pipe, interceptor and SuperAdminGuard over HTTP; only JWT parsing is faked. */
describe('AdminAuditLogsController over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let user: Record<string, unknown> | undefined;

  const auditLogs = {
    list: jest.fn(async () => PAGE),
    export: jest.fn(async () => ({ csv: 'created_at\r\n', rowCount: 0, truncated: false })),
  };

  const fakeJwt: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().user = user;
      return true;
    },
  };

  const listQuery = () => (auditLogs.list.mock.calls[0] as unknown[])[0] as Record<string, unknown>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuditLogsController],
      providers: [
        { provide: AdminAuditLogsService, useValue: auditLogs },
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
    user = { userId: 'admin', email: 'ops@chumbaq.com', ...STAFF, isSuperAdmin: true };
  });

  it('audit logs arrive as a top-level { data, meta }, not double wrapped', async () => {
    const response = await fetch(`${base}/audit-logs`);

    expect(await response.json()).toEqual(PAGE);
  });

  it.each([
    ['a non-super-admin', { userId: 'tenant', ...STAFF, isSuperAdmin: false }],
    ['an impersonation token', { userId: 'tenant', ...STAFF, isSuperAdmin: true, impersonatedBy: 'admin' }],
  ])('refuses %s the list and the export', async (_who, who) => {
    user = who;

    for (const route of ['audit-logs', 'audit-logs/export']) {
      expect((await fetch(`${base}/${route}`)).status).toBe(403);
    }
    expect(auditLogs.list).not.toHaveBeenCalled();
    expect(auditLogs.export).not.toHaveBeenCalled();
  });

  it('has no write route on the audit log', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await fetch(`${base}/audit-logs`, { method })).status).toBe(404);
    }
  });

  it.each([
    'tenant.suspended',
    'tenant.reactivated',
    'tenant.impersonated',
    'tenant.viewed',
    'super_admin.granted',
    'super_admin.revoked',
    'super_admin.passkeys_reset',
    'account.factors_reset',
    'audit_log.exported',
  ])('accepts the action %s, as a one-item list', async (action) => {
    const response = await fetch(`${base}/audit-logs?action=${action}`);

    expect(response.status).toBe(200);
    expect(listQuery().action).toEqual([action]);
  });

  it.each([
    ['repeated', 'action=tenant.viewed&action=tenant.suspended'],
    ['comma-separated', 'action=tenant.viewed,tenant.suspended'],
  ])('takes several actions %s', async (_how, queryString) => {
    await fetch(`${base}/audit-logs?${queryString}`);

    expect(listQuery().action).toEqual(['tenant.viewed', 'tenant.suspended']);
  });

  it('passes paging and every filter through, with a working skip', async () => {
    await fetch(
      `${base}/audit-logs?page=3&limit=10&targetId=${TARGET_ID}&actorId=${ACTOR_ID}` +
        `&actorEmail=%20Ops@Chumbaq.com%20&from=2026-11-01T00:00:00.000Z&to=2026-11-02T00:00:00%2B05:30`,
    );

    expect(listQuery()).toMatchObject({
      page: 3,
      limit: 10,
      skip: 20,
      targetId: TARGET_ID,
      actorId: ACTOR_ID,
      actorEmail: 'ops@chumbaq.com',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00+05:30',
    });
  });

  it.each([
    ['an off-list action', 'action=tenant.deleted'],
    ['an off-list action among good ones', 'action=tenant.viewed,tenant.deleted'],
    ['an empty action', 'action='],
    ['a non-uuid targetId', 'targetId=not-a-uuid'],
    ['a non-uuid actorId', 'actorId=x'],
    ['an empty actorEmail', 'actorEmail=%20'],
    ['an actorEmail over 255 characters', `actorEmail=${'a'.repeat(256)}`],
    ['a from that is not a date', 'from=yesterday'],
    ['an impossible to', 'to=2026-02-30T00:00:00Z'],
    ['a limit over the maximum', 'limit=101'],
    ['a zero page', 'page=0'],
    ['an unknown parameter', 'actor=x'],
  ])('rejects %s with 400', async (_what, queryString) => {
    const response = await fetch(`${base}/audit-logs?${queryString}`);

    expect(response.status).toBe(400);
    expect(auditLogs.list).not.toHaveBeenCalled();
  });

  describe('GET /admin/audit-logs/export', () => {
    it('sends a CSV attachment, not a JSON envelope, and says what it holds', async () => {
      auditLogs.export.mockResolvedValueOnce({ csv: 'a,b\r\n', rowCount: 10_000, truncated: true });

      const response = await fetch(`${base}/audit-logs/export?action=tenant.viewed`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('content-disposition')).toMatch(
        /^attachment; filename="chumbaq-audit-log-\d{8}-\d{6}\.csv"$/,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-export-row-count')).toBe('10000');
      expect(response.headers.get('x-export-row-cap')).toBe('10000');
      expect(response.headers.get('x-export-truncated')).toBe('true');
      expect(response.headers.get('access-control-expose-headers')).toContain('X-Export-Truncated');
      expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('﻿a,b\r\n');
    });

    it('hands the filters and the acting admin to the service', async () => {
      await fetch(`${base}/audit-logs/export?targetId=${TARGET_ID}&action=tenant.viewed`);

      const [filters, actor] = auditLogs.export.mock.calls[0] as unknown as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(filters).toMatchObject({ targetId: TARGET_ID, action: ['tenant.viewed'] });
      expect(actor).toMatchObject({ userId: 'admin', email: 'ops@chumbaq.com' });
    });

    it.each([
      ['paging, which an export does not take', 'page=2'],
      ['an off-list action', 'action=tenant.deleted'],
    ])('rejects %s with 400', async (_what, queryString) => {
      expect((await fetch(`${base}/audit-logs/export?${queryString}`)).status).toBe(400);
      expect(auditLogs.export).not.toHaveBeenCalled();
    });
  });
});

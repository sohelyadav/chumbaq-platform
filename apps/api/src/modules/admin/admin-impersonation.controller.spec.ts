import { APP_GUARD } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { SecondFactorsService } from '../auth/second-factors.service';
import { ImpersonationHandoffsService } from '../impersonation/impersonation-handoffs.service';
import { STAFF_ENROLMENT_ONLY_MESSAGE } from '../staff-auth/staff-messages';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { StaffRecentAuthGuard } from '../staff-auth/staff-recent-auth.guard';
import { UserEntity } from '../users/entities/user.entity';
import {
  FakeStaffSessions,
  signStaffToken,
  STAFF_UNIT_SECRET,
  staffStrategyProviders,
} from '../../test-support/staff-strategy-fakes';
import { JwtService } from '@nestjs/jwt';
import { AdminImpersonationController } from './admin-impersonation.controller';
import { SuperAdminGuard } from './guards/super-admin.guard';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';
const ENROLMENT_SESSION = '55555555-5555-4555-8555-555555555555';
const REASON = 'Customer asked why a campaign did not send';

/**
 * The route over real HTTP through the real staff strategy and guards, with the handoff
 * service replaced: what it does with the database is proved in
 * impersonation-handoffs.int-spec.ts.
 */
describe('POST /admin/tenants/:id/impersonate', () => {
  let app: INestApplication;
  let baseUrl: string;
  let users: Map<string, UserEntity>;
  let sessions: FakeStaffSessions;
  const created: Array<Record<string, any>> = [];
  const staff = { id: ACTOR_ID, email: 'staff@example.com' };

  const handoffs = {
    create: jest.fn(async (input: Record<string, any>) => {
      created.push(input);
      return {
        url: 'https://app.example.com/impersonate#code=' + 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tenant: { id: input.targetId, email: 'tenant@example.com', name: 'Tenant' },
      };
    }),
  };

  const impersonate = async (
    body: unknown,
    { id = TENANT_ID, token }: { id?: string; token?: string | null } = {},
  ) => {
    const bearer = token === undefined ? await signStaffToken(staff, SESSION) : token;
    const response = await fetch(`${baseUrl}/admin/tenants/${id}/impersonate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  beforeEach(async () => {
    created.length = 0;
    handoffs.create.mockClear();
    users = new Map([
      [ACTOR_ID, { id: ACTOR_ID, email: 'staff@example.com', isSuperAdmin: true, sessionVersion: 0, suspendedAt: null } as UserEntity],
      [TENANT_ID, { id: TENANT_ID, email: 'tenant@example.com', isSuperAdmin: false, sessionVersion: 0, suspendedAt: null } as UserEntity],
    ]);
    sessions = new FakeStaffSessions();
    sessions.rows.set(SESSION, { userId: ACTOR_ID, state: 'live', enrolmentOnly: false });
    sessions.rows.set(ENROLMENT_SESSION, { userId: ACTOR_ID, state: 'live', enrolmentOnly: true });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AdminImpersonationController],
      providers: [
        ...staffStrategyProviders(() => users, sessions),
        StaffJwtAuthGuard,
        StaffRecentAuthGuard,
        SuperAdminGuard,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: ImpersonationHandoffsService, useValue: handoffs },
        { provide: SecondFactorsService, useValue: { passkeyCount: async () => 0 } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  afterEach(() => app.close());

  it('answers with the handoff link, never a token', async () => {
    const { status, body } = await impersonate({ reason: REASON });
    expect(status).toBe(200);
    expect(body.url).toMatch(/\/impersonate#code=[A-Za-z0-9_-]{43}$/);
    expect(body.accessToken).toBeUndefined();
  });

  it('binds the code to the staff member, their session, and the address from the socket', async () => {
    await impersonate({ reason: REASON });
    expect(created).toHaveLength(1);
    expect(created[0].actor).toEqual({ userId: ACTOR_ID, email: 'staff@example.com', sessionId: SESSION });
    expect(created[0].targetId).toBe(TENANT_ID);
    expect(created[0].ipAddress).toContain('127.0.0.1');
  });

  it('asks for a recent sign-in first, and makes no code', async () => {
    const stale = await signStaffToken(staff, SESSION, { auth_time: Math.floor(Date.now() / 1000) - 3600 });
    const { status, body } = await impersonate({ reason: REASON }, { token: stale });
    expect(status).toBe(403);
    expect(body.message).toBe(REAUTH_REQUIRED_MESSAGE);
    expect(created).toHaveLength(0);
  });

  describe('who may call it', () => {
    it('401s with no token', async () => {
      expect((await impersonate({ reason: REASON }, { token: null })).status).toBe(401);
    });

    it('401s for the same super admin\'s customer token', async () => {
      const customer = await new JwtService({}).signAsync(
        { sub: ACTOR_ID, email: 'staff@example.com', type: 'access', sv: 0, auth_time: Math.floor(Date.now() / 1000) },
        { secret: STAFF_UNIT_SECRET, expiresIn: '5m' },
      );
      expect((await impersonate({ reason: REASON }, { token: customer })).status).toBe(401);
      expect(created).toEqual([]);
    });

    it('403s for an enrolment-only session', async () => {
      const token = await signStaffToken(staff, ENROLMENT_SESSION, { enr: true, amr: ['pwd'] });
      const { status, body } = await impersonate({ reason: REASON }, { token });
      expect(status).toBe(403);
      expect(body.message).toBe(STAFF_ENROLMENT_ONLY_MESSAGE);
      expect(created).toEqual([]);
    });

    it('401s for someone no longer a super admin', async () => {
      users.set(ACTOR_ID, { ...users.get(ACTOR_ID), isSuperAdmin: false } as UserEntity);
      expect((await impersonate({ reason: REASON })).status).toBe(401);
      expect(created).toEqual([]);
    });
  });

  it('400s for an id that is not a uuid', async () => {
    expect((await impersonate({ reason: REASON }, { id: 'not-a-uuid' })).status).toBe(400);
  });

  describe('reason', () => {
    it.each([
      ['exactly 10 characters', 'a'.repeat(10)],
      ['exactly 500 characters', 'a'.repeat(500)],
    ])('accepts %s', async (_label, reason) => {
      expect((await impersonate({ reason })).status).toBe(200);
    });

    it.each([
      ['missing', {}],
      ['9 characters', { reason: 'a'.repeat(9) }],
      ['501 characters', { reason: 'a'.repeat(501) }],
      ['10 characters only by padding', { reason: `   ${'a'.repeat(9)}   ` }],
      ['nothing but spaces', { reason: ' '.repeat(20) }],
      ['an object', { reason: {} }],
      ['a number', { reason: 1234567890123 }],
      ['a null character', { reason: 'long enough\u0000reason' }],
    ])('400s when %s', async (_label, body) => {
      const { status } = await impersonate(body);
      expect(status).toBe(400);
      expect(created).toEqual([]);
    });

    it('400s on an unknown field', async () => {
      const { status } = await impersonate({ reason: REASON, ipAddress: '6.6.6.6' });
      expect(status).toBe(400);
    });

    it('passes the reason on trimmed', async () => {
      await impersonate({ reason: `   ${REASON}  ` });
      expect(created[0].reason).toBe(REASON);
    });
  });

  it('throttles at 5 a minute, below the global 100', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await impersonate({ reason: REASON })).status).toBe(200);
    }
    expect((await impersonate({ reason: REASON })).status).toBe(429);
  });
});

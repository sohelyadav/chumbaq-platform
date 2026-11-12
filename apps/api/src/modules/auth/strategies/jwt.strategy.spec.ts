import {
  Controller,
  Delete,
  Get,
  HttpCode,
  INestApplication,
  Options,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { UsersService } from '../../users/users.service';
import { SessionsService } from '../sessions.service';
import { StaffSessionsService } from '../staff-sessions.service';
import { staffAccessKey } from '../staff-tokens.service';
import { UserEntity } from '../../users/entities/user.entity';
import { CurrentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthenticatedUser, JwtStrategy } from './jwt.strategy';

const SECRET = 'test-secret';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const GONE_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const STAFF_SESSION_ID = '55555555-5555-4555-8555-555555555555';

/** Every verb goes through the real guard, as a route in any module would. */
@Controller('probe')
@UseGuards(JwtAuthGuard)
class ProbeController {
  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  @Options()
  @HttpCode(200)
  options(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  @Post()
  post() {
    return { reached: true };
  }

  @Patch()
  patch() {
    return { reached: true };
  }

  @Delete()
  delete() {
    return { reached: true };
  }
}

const buildUser = (overrides: Partial<UserEntity>): UserEntity =>
  ({
    id: TENANT_ID,
    email: 'tenant@example.com',
    name: 'Tenant',
    passwordHash: 'stored-hash',
    sessionVersion: 0,
    isSuperAdmin: false,
    suspendedAt: null,
    suspendedReason: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as UserEntity);

describe('JwtStrategy, through the real guard over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  let users: Map<string, UserEntity>;
  const findById = jest.fn();
  const isLive = jest.fn();
  const isUsable = jest.fn();
  let usableStaffSessions = new Set<string>();
  let liveSessions = new Set<string>();
  const jwt = new JwtService({ secret: SECRET });

  const tenantToken = (extra: Record<string, unknown> = {}, secret = SECRET) =>
    jwt.signAsync(
      { sub: TENANT_ID, email: 'tenant@example.com', type: 'access', ...extra },
      { expiresIn: '5m', secret },
    );
  const impersonationToken = () => tenantToken({ imp: ACTOR_ID, impSid: STAFF_SESSION_ID });

  const call = async (method: string, token: string) => {
    const response = await fetch(`${baseUrl}/probe`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeEach(async () => {
    users = new Map([
      [TENANT_ID, buildUser({})],
      [
        ACTOR_ID,
        buildUser({ id: ACTOR_ID, email: 'staff@example.com', isSuperAdmin: true }),
      ],
    ]);
    findById.mockReset();
    isLive.mockReset();
    isLive.mockImplementation(async (sid: string) => liveSessions.has(sid));
    liveSessions = new Set([SESSION_ID]);
    usableStaffSessions = new Set([STAFF_SESSION_ID]);
    isUsable.mockReset();
    isUsable.mockImplementation(async (sid: string, userId: string) =>
      userId === ACTOR_ID && usableStaffSessions.has(sid),
    );
    findById.mockImplementation(async (id: string) => users.get(id) ?? null);

    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        JwtStrategy,
        { provide: UsersService, useValue: { findById } },
        { provide: SessionsService, useValue: { isLive } },
        { provide: StaffSessionsService, useValue: { isUsable } },
        { provide: ConfigService, useValue: { get: () => SECRET } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  afterEach(() => app.close());

  describe('session version', () => {
    it('kills a token that was valid a moment ago, on every verb', async () => {
      const token = await tenantToken();
      expect((await call('GET', token)).status).toBe(200);

      users.set(TENANT_ID, buildUser({ sessionVersion: 1 }));

      expect((await call('GET', token)).status).toBe(401);
      expect((await call('POST', token)).status).toBe(401);
    });

    it('accepts a token from the current version', async () => {
      users.set(TENANT_ID, buildUser({ sessionVersion: 3 }));
      const token = await new JwtService({ secret: SECRET }).signAsync(
        { sub: TENANT_ID, email: 'tenant@example.com', type: 'access', sv: 3 },
        { expiresIn: '5m' },
      );

      const accepted = await call('GET', token);
      expect(accepted.status).toBe(200);
      // Passed on, so adding a factor can compare it with the row it locks.
      expect(accepted.body.sessionVersion).toBe(3);
    });
  });

  describe('session row', () => {
    const sessionToken = () =>
      new JwtService({ secret: SECRET }).signAsync(
        { sub: TENANT_ID, email: 'tenant@example.com', type: 'access', sid: SESSION_ID },
        { expiresIn: '5m' },
      );

    it('ends a token at once when its session is signed out', async () => {
      const token = await sessionToken();
      expect((await call('GET', token)).status).toBe(200);
      expect(isLive).toHaveBeenCalledWith(SESSION_ID, TENANT_ID);

      liveSessions.delete(SESSION_ID);

      expect((await call('GET', token)).status).toBe(401);
      expect((await call('POST', token)).status).toBe(401);
    });

    it('does not look for a row a token never had', async () => {
      expect((await call('GET', await tenantToken())).status).toBe(200);
      expect(isLive).not.toHaveBeenCalled();
    });
  });

  describe('ordinary tokens', () => {
    it('hands on how and when the session proved who it is', async () => {
      const token = await new JwtService({ secret: SECRET }).signAsync(
        {
          sub: TENANT_ID,
          email: 'tenant@example.com',
          type: 'access',
          amr: ['pwd', 'webauthn'],
          auth_time: 1_700_000_000,
        },
        { expiresIn: '5m' },
      );

      const { body } = await call('GET', token);

      expect(body).toMatchObject({ amr: ['pwd', 'webauthn'], authTime: 1_700_000_000 });
    });

    it('authenticates with one lookup and no impersonation field', async () => {
      const { status, body } = await call('GET', await tenantToken());

      expect(status).toBe(200);
      expect(body).toEqual({
        userId: TENANT_ID,
        email: 'tenant@example.com',
        isSuperAdmin: false,
        sessionVersion: 0,
      });
      expect(findById).toHaveBeenCalledTimes(1);
    });

    it('allows every verb, since read-only applies to impersonation alone', async () => {
      const token = await tenantToken();
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        expect((await call(method, token)).status).toBeLessThan(300);
      }
    });

    it('reports the super admin flag from the database, not the token', async () => {
      users.set(TENANT_ID, buildUser({ isSuperAdmin: true }));
      const { body } = await call('GET', await tenantToken({ isSuperAdmin: false }));
      expect(body.isSuperAdmin).toBe(true);

      users.set(TENANT_ID, buildUser({ isSuperAdmin: false }));
      const forged = await call('GET', await tenantToken({ isSuperAdmin: true }));
      expect(forged.body.isSuperAdmin).toBe(false);
    });

    it('refuses a refresh token', async () => {
      const { status } = await call('GET', await tenantToken({ type: 'refresh' }));
      expect(status).toBe(401);
    });

    it('refuses a token for a user who no longer exists', async () => {
      users.delete(TENANT_ID);
      expect((await call('GET', await tenantToken())).status).toBe(401);
    });

    it('refuses a token with an audience, as every staff token has', async () => {
      // Signed with the customer key, so only the claim check can stop it.
      const { status } = await call('GET', await tenantToken({ aud: 'chumbaq-admin' }));
      expect(status).toBe(401);
    });

    it('refuses a staff token, signed with the staff key', async () => {
      const token = await jwt.signAsync(
        {
          sub: ACTOR_ID,
          email: 'staff@example.com',
          type: 'staff_access',
          aud: 'chumbaq-admin',
          sid: STAFF_SESSION_ID,
          sv: 0,
          amr: ['webauthn', 'uv'],
          auth_time: Math.floor(Date.now() / 1000),
        },
        { expiresIn: '5m', secret: staffAccessKey(SECRET) },
      );
      expect((await call('GET', token)).status).toBe(401);
      // Refused on the signature, before any lookup.
      expect(findById).not.toHaveBeenCalled();
    });

    it('refuses a token signed with another secret', async () => {
      const { status } = await call('GET', await tenantToken({}, 'another-secret'));
      expect(status).toBe(401);
      expect(findById).not.toHaveBeenCalled();
    });
  });

  describe('suspension', () => {
    it('kills a token that was valid a moment ago', async () => {
      const token = await tenantToken();
      expect((await call('GET', token)).status).toBe(200);

      users.set(TENANT_ID, buildUser({ suspendedAt: new Date('2026-11-04') }));

      const { status, body } = await call('GET', token);
      expect(status).toBe(403);
      expect(body.message).toBe('Account suspended');
    });

    it('lets the token work again after reactivation', async () => {
      const token = await tenantToken();
      users.set(TENANT_ID, buildUser({ suspendedAt: new Date('2026-11-04') }));
      expect((await call('GET', token)).status).toBe(403);

      users.set(TENANT_ID, buildUser({ suspendedAt: null }));
      expect((await call('GET', token)).status).toBe(200);
    });

    it('refuses an impersonation session on a tenant suspended mid-session', async () => {
      users.set(TENANT_ID, buildUser({ suspendedAt: new Date('2026-11-04') }));
      const { status, body } = await call('GET', await impersonationToken());
      expect(status).toBe(403);
      expect(body.message).toBe('Account suspended');
    });
  });

  describe('impersonation tokens', () => {
    it('allows GET as the tenant and names the actor', async () => {
      const { status, body } = await call('GET', await impersonationToken());

      expect(status).toBe(200);
      expect(body).toEqual({
        userId: TENANT_ID,
        email: 'tenant@example.com',
        isSuperAdmin: false,
        sessionVersion: 0,
        impersonatedBy: ACTOR_ID,
      });
      expect(findById.mock.calls.map(([id]) => id)).toEqual([TENANT_ID, ACTOR_ID]);
    });

    it('allows HEAD', async () => {
      expect((await call('HEAD', await impersonationToken())).status).toBe(200);
    });

    it('allows OPTIONS', async () => {
      const { status, body } = await call('OPTIONS', await impersonationToken());
      expect(status).toBe(200);
      expect(body.impersonatedBy).toBe(ACTOR_ID);
    });

    it.each(['POST', 'PATCH', 'DELETE'])('refuses %s as read-only', async (method) => {
      const { status, body } = await call(method, await impersonationToken());
      expect(status).toBe(403);
      expect(body.message).toBe('Impersonation sessions are read-only');
    });

    it('401s once the actor has had their sessions revoked', async () => {
      const token = await impersonationToken();
      expect((await call('GET', token)).status).toBe(200);

      users.set(
        ACTOR_ID,
        buildUser({ id: ACTOR_ID, isSuperAdmin: true, sessionVersion: 1 }),
      );

      expect((await call('GET', token)).status).toBe(401);
    });

    it('401s once the actor is demoted, even on a method that would 403', async () => {
      const token = await impersonationToken();
      expect((await call('GET', token)).status).toBe(200);

      users.set(ACTOR_ID, buildUser({ id: ACTOR_ID, isSuperAdmin: false }));

      expect((await call('GET', token)).status).toBe(401);
      expect((await call('POST', token)).status).toBe(401);
    });

    it('401s once the actor is suspended', async () => {
      const token = await impersonationToken();
      users.set(
        ACTOR_ID,
        buildUser({
          id: ACTOR_ID,
          isSuperAdmin: true,
          suspendedAt: new Date('2026-11-04'),
        }),
      );
      expect((await call('GET', token)).status).toBe(401);
    });

    it('401s once the actor is deleted', async () => {
      const token = await impersonationToken();
      users.delete(ACTOR_ID);
      expect((await call('GET', token)).status).toBe(401);
    });

    it('401s once the staff session that asked for it has ended', async () => {
      const token = await impersonationToken();
      expect((await call('GET', token)).status).toBe(200);
      expect(isUsable).toHaveBeenCalledWith(STAFF_SESSION_ID, ACTOR_ID);

      usableStaffSessions.delete(STAFF_SESSION_ID);
      expect((await call('GET', token)).status).toBe(401);
    });

    it('401s for a token from before the admin split, which names no staff session', async () => {
      const { status, body } = await call('GET', await tenantToken({ imp: ACTOR_ID }));
      expect(status).toBe(401);
      expect(body.message).toBe('Impersonation session is no longer valid');
    });

    it('401s for an actor id that never existed', async () => {
      const { status } = await call('GET', await tenantToken({ imp: GONE_ID }));
      expect(status).toBe(401);
    });

    it('401s once the target has been promoted to super admin', async () => {
      const token = await impersonationToken();
      expect((await call('GET', token)).status).toBe(200);

      users.set(TENANT_ID, buildUser({ isSuperAdmin: true }));

      const { status, body } = await call('GET', token);
      expect(status).toBe(401);
      expect(body.isSuperAdmin).toBeUndefined();
    });

    it('stops at expiry', async () => {
      const token = await jwt.signAsync(
        { sub: TENANT_ID, email: 'tenant@example.com', type: 'access', imp: ACTOR_ID },
        { expiresIn: -1, secret: SECRET },
      );
      expect((await call('GET', token)).status).toBe(401);
    });
  });
});

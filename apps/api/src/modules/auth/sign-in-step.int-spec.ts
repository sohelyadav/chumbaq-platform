import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import type { AccountRecoveryService } from './account-recovery.service';
import { AuthService, LoginResult, SignedIn } from './auth.service';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { PRE_AUTH_TTL_SECONDS, PreAuthService } from './pre-auth.service';
import { SecondFactorMethod, SecondFactorsService } from './second-factors.service';
import { SessionsService } from './sessions.service';

const SECRET = 'test-secret';
const DOMAIN = '@sign-in-step-int.test';
const EMAIL = `person${DOMAIN}`;
const PASSWORD = 'correct-horse-battery';
const REDIS_DB = 15;

interface Claims {
  sid: string;
  amr?: string[];
  auth_time?: number;
}

/**
 * Real Postgres and real Redis: the guarantees here are a conditional UPDATE and a
 * GETDEL, which a stub could only repeat. The one stand-in is `methodsFor`, because
 * nobody can hold a factor until roadmap 15.
 */
describe('Sign-in step and re-authentication (integration)', () => {
  let ds: DataSource;
  let auth: AuthService;
  let users: UsersService;
  let preAuth: PreAuthService;
  let redis: Redis;
  let methods: SecondFactorMethod[] = [];
  const jwt = new JwtService({ secret: SECRET });

  const claims = (token: string) => jwt.decode<Claims>(token);
  const login = () => auth.login({ email: EMAIL, password: PASSWORD });
  const signIn = () => login() as Promise<SignedIn>;
  const startFactorStep = async (): Promise<string> => {
    methods = ['webauthn'];
    const result = (await login()) as Extract<LoginResult, { requiresSecondFactor: true }>;
    return result.handle;
  };
  const backdate = (sid: string, hours: number) =>
    ds.query(
      `UPDATE auth_sessions SET authenticated_at = now() - make_interval(hours => $2) WHERE id = $1`,
      [sid, hours],
    );
  const account = async () =>
    (await ds.getRepository(UserEntity).findOneByOrFail({ email: EMAIL })) as UserEntity;
  const eventTypes = async () =>
    (
      await ds
        .getRepository(AuthEventEntity)
        .find({ where: { email: EMAIL }, order: { createdAt: 'ASC' } })
    ).map((row) => row.type);
  const principal = (accessToken: string) => ({
    userId: jwt.decode<{ sub: string }>(accessToken).sub,
    email: EMAIL,
    sessionId: claims(accessToken).sid,
  });
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    ds = await openIntDb();
    users = new UsersService(ds.getRepository(UserEntity));
    const redisOptions: Record<string, unknown> = {
      'redis.host': process.env.REDIS_HOST,
      'redis.port': parseInt(process.env.REDIS_PORT as string, 10),
      'redis.password': process.env.REDIS_PASSWORD || undefined,
      'redis.db': REDIS_DB,
      'jwt.secret': SECRET,
      'jwt.refreshSecret': 'test-refresh-secret-not-the-access-one',
    };
    const config = {
      get: (key: string, fallback?: unknown) => redisOptions[key] ?? fallback,
      getOrThrow: (key: string) => redisOptions[key],
    } as unknown as ConfigService;
    preAuth = new PreAuthService(config);
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT as string, 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: REDIS_DB,
    });
    auth = new AuthService(
      users,
      jwt,
      config,
      new SessionsService(ds.getRepository(AuthSessionEntity)),
      new AuthEventsService(ds.getRepository(AuthEventEntity)),
      { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
      preAuth,
      { methodsFor: async () => methods, hasAnyPasskey: async () => false } as unknown as SecondFactorsService,
      { inBackground: () => undefined, sessionReplayed: () => undefined } as never,
      { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await redis.flushdb();
    redis.disconnect();
    await preAuth.onModuleDestroy();
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    methods = [];
    await redis.flushdb();
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await users.create({
      email: EMAIL,
      name: 'Person',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
    });
  });

  describe('with no second factor', () => {
    it('signs straight in, recording a password and the time', async () => {
      const { tokens } = await signIn();
      const access = claims(tokens.accessToken);
      expect(access.amr).toEqual(['pwd']);
      expect(Math.abs(nowSeconds() - (access.auth_time as number))).toBeLessThan(5);
    });
  });

  describe('refreshing', () => {
    it('never moves auth_time or amr', async () => {
      const { tokens } = await signIn();
      const { sid } = claims(tokens.accessToken);
      await backdate(sid, 3);

      const refreshed = await auth.refresh(tokens.refreshToken);
      const access = claims(refreshed.accessToken);

      expect(access.amr).toEqual(['pwd']);
      expect(nowSeconds() - (access.auth_time as number)).toBeGreaterThan(2 * 3600);
    });

    it('does not move them on a retry within the grace window either', async () => {
      const { tokens } = await signIn();
      const { sid } = claims(tokens.accessToken);
      await backdate(sid, 3);

      await auth.refresh(tokens.refreshToken);
      const retried = await auth.refresh(tokens.refreshToken);

      expect(nowSeconds() - (claims(retried.accessToken).auth_time as number)).toBeGreaterThan(
        2 * 3600,
      );
    });

    it('reads the session row, not claims a token carries', async () => {
      const { tokens } = await signIn();
      const { sid } = claims(tokens.accessToken);
      await ds.query(`UPDATE auth_sessions SET amr = '["pwd","webauthn"]' WHERE id = $1`, [sid]);

      const refreshed = await auth.refresh(tokens.refreshToken);

      expect(claims(refreshed.accessToken).amr).toEqual(['pwd', 'webauthn']);
    });

    it('refuses a refresh token that names no session, and starts none', async () => {
      const user = await account();
      const sessionless = await jwt.signAsync(
        { sub: user.id, email: EMAIL, type: 'refresh', sv: user.sessionVersion },
        { secret: 'test-refresh-secret-not-the-access-one', expiresIn: '5m' },
      );

      await expect(auth.refresh(sessionless)).rejects.toThrow(UnauthorizedException);
      expect(await ds.getRepository(AuthSessionEntity).count({ where: { userId: user.id } })).toBe(0);
    });
  });

  describe('with a second factor', () => {
    it('gives a handle and no tokens for a correct password', async () => {
      methods = ['webauthn', 'totp'];
      const result = (await login()) as Record<string, unknown>;

      expect(result.requiresSecondFactor).toBe(true);
      expect(result.methods).toEqual(['webauthn', 'totp']);
      expect(result.tokens).toBeUndefined();
      expect(result.user).toBeUndefined();
      expect(await ds.getRepository(AuthSessionEntity).count({ where: { userId: (await account()).id } })).toBe(0);
    });

    it('refuses a wrong password before any handle exists', async () => {
      methods = ['webauthn'];
      await expect(auth.login({ email: EMAIL, password: 'wrong-password' })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(await redis.dbsize()).toBe(0);
    });

    it('issues something that is not a JWT, so no JWT check can accept it', async () => {
      const handle = await startFactorStep();
      expect(handle.split('.')).toHaveLength(1);
      await expect(jwt.verifyAsync(handle, { secret: SECRET })).rejects.toThrow();
    });

    it('stores only a hash of the handle, for five minutes', async () => {
      const handle = await startFactorStep();
      const [key] = await redis.keys('*');
      expect(key).not.toContain(handle);
      expect(await redis.ttl(key)).toBeGreaterThan(PRE_AUTH_TTL_SECONDS - 5);
      expect(await redis.ttl(key)).toBeLessThanOrEqual(PRE_AUTH_TTL_SECONDS);
    });

    it('signs in once the factor is verified, recording both proofs', async () => {
      const handle = await startFactorStep();
      const { tokens } = await auth.completeSecondFactor(handle, 'webauthn');
      expect(claims(tokens.accessToken).amr).toEqual(['pwd', 'webauthn']);
      expect(await eventTypes()).toEqual(['login.password_accepted', 'login.succeeded']);
    });

    it('lets peek read the handle without spending it', async () => {
      const handle = await startFactorStep();
      expect((await preAuth.peek(handle))?.userId).toBe((await account()).id);
      await expect(auth.completeSecondFactor(handle, 'webauthn')).resolves.toBeDefined();
    });

    it('works once', async () => {
      const handle = await startFactorStep();
      await auth.completeSecondFactor(handle, 'webauthn');
      await expect(auth.completeSecondFactor(handle, 'webauthn')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lets exactly one of many simultaneous uses through', async () => {
      const handle = await startFactorStep();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => auth.completeSecondFactor(handle, 'webauthn')),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('refuses an unknown handle and an expired one alike', async () => {
      const handle = await startFactorStep();
      await redis.flushdb();
      await expect(auth.completeSecondFactor(handle, 'webauthn')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(auth.completeSecondFactor('made-up', 'webauthn')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('dies with a password reset or sign-out everywhere in between', async () => {
      const handle = await startFactorStep();
      await users.revokeAllSessions((await account()).id);
      await expect(auth.completeSecondFactor(handle, 'webauthn')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('stops for a suspension in between', async () => {
      const handle = await startFactorStep();
      await ds.query(`UPDATE users SET suspended_at = now() WHERE email = $1`, [EMAIL]);
      await expect(auth.completeSecondFactor(handle, 'webauthn')).rejects.toThrow(ForbiddenException);
    });

    it('does not lift the failure limit on the password alone', async () => {
      methods = ['webauthn'];
      for (let i = 0; i < 9; i++) {
        await auth.login({ email: EMAIL, password: 'wrong-password' }).catch(() => undefined);
      }
      await login();
      await auth.login({ email: EMAIL, password: 'wrong-password' }).catch(() => undefined);

      await expect(login()).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('re-authenticating', () => {
    it('moves auth_time on a new access token, and a later refresh keeps it', async () => {
      const { tokens } = await signIn();
      const { sid } = claims(tokens.accessToken);
      await backdate(sid, 3);

      const { accessToken } = await auth.reauthenticate(principal(tokens.accessToken), PASSWORD);
      expect(Math.abs(nowSeconds() - (claims(accessToken).auth_time as number))).toBeLessThan(5);
      expect(claims(accessToken).sid).toBe(sid);

      const refreshed = await auth.refresh(tokens.refreshToken);
      expect(Math.abs(nowSeconds() - (claims(refreshed.accessToken).auth_time as number))).toBeLessThan(5);
      expect(await eventTypes()).toContain('reauth.succeeded');
    });

    it('moves nothing for a wrong password, and answers 403 so the client keeps its session', async () => {
      const { tokens } = await signIn();
      const { sid } = claims(tokens.accessToken);
      await backdate(sid, 3);

      await expect(
        auth.reauthenticate(principal(tokens.accessToken), 'wrong-password'),
      ).rejects.toThrow(ForbiddenException);

      const refreshed = await auth.refresh(tokens.refreshToken);
      expect(nowSeconds() - (claims(refreshed.accessToken).auth_time as number)).toBeGreaterThan(
        2 * 3600,
      );
    });

    it('shares the sign-in failure limit, so a stolen session cannot guess here freely', async () => {
      const { tokens } = await signIn();
      for (let i = 0; i < 10; i++) {
        await auth.reauthenticate(principal(tokens.accessToken), 'wrong-password').catch(() => undefined);
      }

      const limited = auth.reauthenticate(principal(tokens.accessToken), PASSWORD);
      await expect(limited).rejects.toThrow(HttpException);
      await expect(limited).rejects.toMatchObject({ status: 429 });
      await expect(login()).rejects.toMatchObject({ status: 429 });
    });

    it('refuses an ended session, even with the right password', async () => {
      const { tokens } = await signIn();
      const who = principal(tokens.accessToken);
      await auth.logout(who);
      await expect(auth.reauthenticate(who, PASSWORD)).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a token with no session', async () => {
      const { tokens } = await signIn();
      const { sessionId: _none, ...who } = principal(tokens.accessToken);
      await expect(auth.reauthenticate(who, PASSWORD)).rejects.toThrow(UnauthorizedException);
    });
  });
});

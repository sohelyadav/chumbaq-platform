import { HttpException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthEventEntity, AuthEventType } from '../auth-events/entities/auth-event.entity';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AccountRecoveryService } from './account-recovery.service';
import { AuthService, SESSION_EXPIRED_MESSAGE, SignedIn } from './auth.service';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { ROTATION_GRACE_MS, SessionsService } from './sessions.service';
import { DEFAULT_SESSION_MAX_AGE_MS } from '../../config/jwt.config';

const SECRET = 'test-secret';
const DOMAIN = '@account-sessions-int.test';
const EMAIL = `person${DOMAIN}`;
const PASSWORD = 'correct-horse-battery';
const MAX_AGE_MS = DEFAULT_SESSION_MAX_AGE_MS;
const DAY_MS = 86_400_000;

/**
 * Real services and a real Postgres: rotation is decided by a conditional UPDATE
 * and the failure limit by a correlated subquery, so a stub could only repeat
 * what the test already assumed.
 */
describe('Account sessions (integration)', () => {
  let ds: DataSource;
  let auth: AuthService;
  let users: UsersService;
  let sessions: SessionsService;
  const jwt = new JwtService({ secret: SECRET });

  const cleanup = async () => {
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  const login = () => auth.login({ email: EMAIL, password: PASSWORD }) as Promise<SignedIn>;

  const eventTypes = async (): Promise<AuthEventType[]> => {
    const rows = await ds
      .getRepository(AuthEventEntity)
      .find({ where: { email: EMAIL }, order: { createdAt: 'ASC' } });
    return rows.map((row) => row.type);
  };

  const sessionId = (token: string) => jwt.decode<{ sid: string }>(token).sid;

  beforeAll(async () => {
    ds = await openIntDb();
    users = new UsersService(ds.getRepository(UserEntity));
    auth = new AuthService(
      users,
      jwt,
      {
        get: (key: string, fallback?: string) => (key === 'jwt.refreshSecret' ? 'test-refresh-secret-not-the-access-one' : key === 'jwt.secret' ? SECRET : fallback),
      } as unknown as ConfigService,
      (sessions = new SessionsService(ds.getRepository(AuthSessionEntity))),
      new AuthEventsService(ds.getRepository(AuthEventEntity)),
      { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
      {} as never,
      { methodsFor: async () => [], hasAnyPasskey: async () => false } as never,
      { inBackground: () => undefined, sessionReplayed: () => undefined } as never,
      { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
  });

  afterAll(async () => {
    await cleanup();
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await cleanup();
    await users.create({
      email: EMAIL,
      name: 'Person',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
    });
  });

  describe('rotation', () => {
    it('replaces the refresh token, and the new one works', async () => {
      const { tokens } = await login();
      const next = await auth.refresh(tokens.refreshToken);

      expect(next.refreshToken).not.toBe(tokens.refreshToken);
      await expect(auth.refresh(next.refreshToken)).resolves.toBeDefined();
    });

    it('treats a replay within the grace window as a retry, not theft', async () => {
      const { tokens } = await login();
      const first = await auth.refresh(tokens.refreshToken);
      const retried = await auth.refresh(tokens.refreshToken);

      // Both clients end up on the same rotation, and it still works.
      expect(jwt.decode<{ jti: string }>(retried.refreshToken).jti).toBe(
        jwt.decode<{ jti: string }>(first.refreshToken).jti,
      );
      await expect(auth.refresh(retried.refreshToken)).resolves.toBeDefined();
    });

    it('lets simultaneous refreshes both succeed on one rotation', async () => {
      const { tokens } = await login();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => auth.refresh(tokens.refreshToken)),
      );
      const jtis = new Set(
        results.map((r) => jwt.decode<{ jti: string }>(r.refreshToken).jti),
      );
      expect(jtis.size).toBe(1);
    });

    it('ends the session when an old token is replayed after the window', async () => {
      const { tokens } = await login();
      const next = await auth.refresh(tokens.refreshToken);
      await ds.query(
        `UPDATE auth_sessions SET rotated_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1`,
        [sessionId(tokens.refreshToken), ROTATION_GRACE_MS + 1000],
      );

      await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);

      // The thief and the victim cannot be told apart, so neither keeps the session.
      await expect(auth.refresh(next.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await eventTypes()).toContain('refresh.reuse_detected');
    });

    it('refuses a jti that was never issued for that session', async () => {
      const { tokens } = await login();
      const { sub, email, sv, sid } = jwt.decode<{ sub: string; email: string; sv: number; sid: string }>(
        tokens.refreshToken,
      );
      const forged = await jwt.signAsync({
        sub,
        email,
        sv,
        sid,
        type: 'refresh',
        jti: '99999999-9999-4999-8999-999999999999',
      });

      await expect(auth.refresh(forged)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("refuses another user's session id", async () => {
      const { tokens } = await login();
      const stranger = await users.create({
        email: `stranger${DOMAIN}`,
        name: 'Stranger',
        passwordHash: 'x',
      });
      const claims = jwt.decode<{ sid: string; jti: string }>(tokens.refreshToken);
      const forged = await jwt.signAsync({
        sub: stranger.id,
        email: stranger.email,
        sv: 0,
        sid: claims.sid,
        jti: claims.jti,
        type: 'refresh',
      });

      await expect(auth.refresh(forged)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(auth.refresh(tokens.refreshToken)).resolves.toBeDefined();
    });

    it('refuses a refresh token that names no session, even under the right key', async () => {
      const user = await users.findByEmail(EMAIL);
      const sessionless = await jwt.signAsync(
        { sub: user!.id, email: EMAIL, type: 'refresh' },
        { secret: 'test-refresh-secret-not-the-access-one' },
      );

      await expect(auth.refresh(sessionless)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await ds.getRepository(AuthSessionEntity).count({ where: { userId: user!.id } })).toBe(0);
    });
  });

  describe('maximum session length', () => {
    /** Moves the session's start back by `ms`, by the database's clock, as rotate reads it. */
    const ageSession = (token: string, ms: number) =>
      ds.query(
        `UPDATE auth_sessions SET created_at = now() - make_interval(secs => $2) WHERE id = $1`,
        [sessionId(token), ms / 1000],
      );
    const sessionRow = (token: string) =>
      ds.getRepository(AuthSessionEntity).findOneByOrFail({ id: sessionId(token) });
    const exp = (token: string) => jwt.decode<{ exp: number }>(token).exp;

    it('still refreshes a session just inside the limit', async () => {
      const { tokens } = await login();
      await ageSession(tokens.refreshToken, MAX_AGE_MS - 60_000);

      await expect(auth.refresh(tokens.refreshToken)).resolves.toBeDefined();
    });

    it('ends a session just past the limit, however recently it was used', async () => {
      const { tokens } = await login();
      const next = await auth.refresh(tokens.refreshToken);
      await ageSession(tokens.refreshToken, MAX_AGE_MS + 1000);

      await expect(auth.refresh(next.refreshToken)).rejects.toThrow(
        new UnauthorizedException(SESSION_EXPIRED_MESSAGE),
      );

      expect((await sessionRow(tokens.refreshToken)).revokedAt).not.toBeNull();
      const failed = await ds
        .getRepository(AuthEventEntity)
        .findOneByOrFail({ email: EMAIL, type: 'refresh.failed' });
      expect(failed.reason).toBe('session_expired');
      // Age is not theft: nobody is told their session was replayed.
      expect(await eventTypes()).not.toContain('refresh.reuse_detected');
    });

    it('refuses the token just replaced, too, though it is within the grace window', async () => {
      const { tokens } = await login();
      await auth.refresh(tokens.refreshToken);
      await ageSession(tokens.refreshToken, MAX_AGE_MS + 1000);

      await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    });

    it('decides the age in the rotating UPDATE, so simultaneous refreshes cannot rotate it', async () => {
      const { tokens } = await login();
      const { sub, sid, jti } = jwt.decode<{ sub: string; sid: string; jti: string }>(
        tokens.refreshToken,
      );
      await ageSession(tokens.refreshToken, MAX_AGE_MS + 1000);

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => sessions.rotate(sid, sub, jti, MAX_AGE_MS)),
      );

      expect(outcomes.map((o) => o.outcome).every((o) => o === 'expired' || o === 'revoked')).toBe(true);
      expect(outcomes.map((o) => o.outcome)).toContain('expired');
      const row = await sessionRow(tokens.refreshToken);
      expect(row.currentJti).toBe(jti);
      expect(row.previousJti).toBeNull();
      expect(row.revokedAt).not.toBeNull();
    });

    it('lets the rotating UPDATE through a moment inside the limit', async () => {
      const { tokens } = await login();
      const { sub, sid, jti } = jwt.decode<{ sub: string; sid: string; jti: string }>(
        tokens.refreshToken,
      );
      await ageSession(tokens.refreshToken, MAX_AGE_MS - 5000);

      await expect(sessions.rotate(sid, sub, jti, MAX_AGE_MS)).resolves.toMatchObject({
        outcome: 'rotated',
      });
    });

    it('gives a new session a refresh token of the full refresh lifetime', async () => {
      const before = Math.floor(Date.now() / 1000);
      const { tokens } = await login();

      expect(exp(tokens.refreshToken) - before).toBeGreaterThanOrEqual(7 * 86_400);
      expect(exp(tokens.refreshToken) - before).toBeLessThanOrEqual(7 * 86_400 + 2);
    });

    it('never issues a refresh token, or its cookie, that outlives the session', async () => {
      const { tokens } = await login();
      await ageSession(tokens.refreshToken, MAX_AGE_MS - 2 * DAY_MS);
      const { createdAt } = await sessionRow(tokens.refreshToken);

      const next = await auth.refresh(tokens.refreshToken);

      const sessionEnd = Math.floor((createdAt.getTime() + MAX_AGE_MS) / 1000);
      expect(exp(next.refreshToken)).toBe(sessionEnd);
      // The dashboard is told when that is, so it can explain the sign-out later.
      expect(jwt.decode<{ session_exp: number; session_max_age: number }>(next.accessToken)).toMatchObject({
        session_exp: sessionEnd,
        session_max_age: MAX_AGE_MS / 1000,
      });
    });
  });

  describe('revocation', () => {
    it('logout ends only this device', async () => {
      const here = await login();
      const there = await login();
      const claims = jwt.decode<{ sub: string; sid: string }>(here.tokens.accessToken);

      await auth.logout({ userId: claims.sub, email: EMAIL, sessionId: claims.sid });

      await expect(auth.refresh(here.tokens.refreshToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(auth.refresh(there.tokens.refreshToken)).resolves.toBeDefined();
    });

    it("cannot end another user's session, even naming its id", async () => {
      const { tokens } = await login();
      const stranger = await users.create({
        email: `stranger${DOMAIN}`,
        name: 'Stranger',
        passwordHash: 'x',
      });

      await auth.logout({
        userId: stranger.id,
        email: stranger.email,
        sessionId: sessionId(tokens.refreshToken),
      });

      await expect(auth.refresh(tokens.refreshToken)).resolves.toBeDefined();
    });

    it('logout-all ends every device', async () => {
      const here = await login();
      const there = await login();
      const { sub } = jwt.decode<{ sub: string }>(here.tokens.accessToken);

      await auth.logoutAll({ userId: sub, email: EMAIL });

      for (const { tokens } of [here, there]) {
        await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
    });

    it.each([
      ['changing their own password', (id: string) => users.changeOwnPassword(id, 'new-hash')],
      ['a team resetting it', (id: string) => ds.transaction((manager) => users.resetPasswordByTeam(id, 'new-hash', manager))],
    ])('%s ends existing sessions', async (_label, change) => {
      const { tokens } = await login();
      const { sub } = jwt.decode<{ sub: string }>(tokens.accessToken);

      await change(sub);

      await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a token from before a suspension stays dead after reactivation', async () => {
      const { tokens } = await login();
      const { sub } = jwt.decode<{ sub: string }>(tokens.accessToken);
      await ds.query(
        `UPDATE users SET suspended_at = now(), session_version = session_version + 1 WHERE id = $1`,
        [sub],
      );
      await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(ForbiddenException);

      await ds.query(`UPDATE users SET suspended_at = NULL WHERE id = $1`, [sub]);

      await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('failed sign-in limit', () => {
    const fail = (email = EMAIL) => auth.login({ email, password: 'wrong-password' });

    const failTimes = async (times: number, email = EMAIL) => {
      for (let i = 0; i < times; i++) {
        await expect(fail(email)).rejects.toBeInstanceOf(UnauthorizedException);
      }
    };

    it('stops even the right password after 10 failures', async () => {
      await failTimes(10);

      await expect(login()).rejects.toMatchObject({ status: 429 });
      expect(await eventTypes()).toContain('login.limited');
    });

    it('allows 9 failures, and a success starts the count again', async () => {
      await failTimes(9);
      await login();
      await failTimes(9);

      await expect(login()).resolves.toBeDefined();
    });

    it('treats an address with no account the same way, revealing nothing', async () => {
      const unknown = `nobody${DOMAIN}`;
      await failTimes(10, unknown);

      await expect(fail(unknown)).rejects.toBeInstanceOf(HttpException);
      await expect(fail(unknown)).rejects.toMatchObject({ status: 429 });
    });

    it('matches any capitalisation of the address', async () => {
      await failTimes(10, EMAIL.toUpperCase());

      await expect(login()).rejects.toMatchObject({ status: 429 });
    });

    it('does not count failures from outside the window', async () => {
      await failTimes(10);
      await ds.query(
        `UPDATE auth_events SET created_at = now() - interval '16 minutes' WHERE email = $1`,
        [EMAIL],
      );

      await expect(login()).resolves.toBeDefined();
    });
  });

  it('records the sign-in history, and never a password or token', async () => {
    await expect(auth.login({ email: EMAIL, password: 'wrong-password' })).rejects.toBeDefined();
    const { tokens } = (await auth.login(
      { email: EMAIL, password: PASSWORD },
      { ipAddress: '203.0.113.9', userAgent: 'Test Browser' },
    )) as SignedIn;
    await auth.refresh(tokens.refreshToken);

    expect(await eventTypes()).toEqual(['login.failed', 'login.succeeded', 'refresh.succeeded']);
    const rows = await ds.getRepository(AuthEventEntity).find({ where: { email: EMAIL } });
    const success = rows.find((row) => row.type === 'login.succeeded');
    expect(success).toMatchObject({ ipAddress: '203.0.113.9', userAgent: 'Test Browser' });
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(rows)).not.toContain('wrong-password');
    expect(JSON.stringify(rows)).not.toContain(tokens.refreshToken);
  });
});

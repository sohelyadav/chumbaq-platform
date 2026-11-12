import { TripwiresService } from '../security-alerts/tripwires.service';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import type { AccountActivityResponse, AccountSession } from '@chumbaq/shared';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AccountRecoveryService } from './account-recovery.service';
import { AccountSessionsController } from './account-sessions.controller';
import { AuthCookiesService } from './auth-cookies.service';
import { AuthController } from './auth.controller';
import { AuthService, SignedIn } from './auth.service';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { PreAuthService } from './pre-auth.service';
import { SecondFactorsService } from './second-factors.service';
import { SessionsService } from './sessions.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { StaffSessionsService } from './staff-sessions.service';
import { StaffSessionEntity } from './entities/staff-session.entity';
import { issueStaffSessionForTest } from '../../test-support/staff-session';

const SECRET = 'test-secret-long-enough-for-the-strategy';
const DOMAIN = '@account-sessions-api-int.test';
const EMAIL = `person${DOMAIN}`;
const OTHER_EMAIL = `other${DOMAIN}`;
const STAFF_EMAIL = `staff${DOMAIN}`;
const PASSWORD = 'correct-horse-battery';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DAY_MS = 86_400_000;

/** Real HTTP, real Postgres, and the real strategy, so "signed out" is tested end to end. */
describe('Account sessions and activity API (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let auth: AuthService;
  let users: UsersService;
  let userId: string;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  const sid = (token: string) => jwt.decode<{ sid: string }>(token).sid;

  const call = (method: string, path: string, token: string) =>
    fetch(`${base}/auth/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-chumbaq-client': 'web' },
    });
  const sessionsOf = async (token: string) =>
    (await (await call('GET', 'sessions', token)).json()) as AccountSession[];
  const activityOf = async (token: string) =>
    (await (await call('GET', 'activity', token)).json()) as AccountActivityResponse;

  const signIn = async (email = EMAIL, userAgent = MAC_CHROME, ipAddress = '203.0.113.7') =>
    ((await auth.login({ email, password: PASSWORD }, { userAgent, ipAddress })) as SignedIn).tokens;

  beforeAll(async () => {
    ds = await openIntDb();
    users = new UsersService(ds.getRepository(UserEntity));
    const sessions = new SessionsService(ds.getRepository(AuthSessionEntity));
    const events = new AuthEventsService(ds.getRepository(AuthEventEntity));
    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'jwt.refreshSecret' ? 'test-refresh-secret-not-the-access-one' : key === 'jwt.secret' ? SECRET : key === 'jwt.refreshLifetimeMs' ? 7 * DAY_MS : fallback,
    };
    auth = new AuthService(
      users,
      jwt,
      config as unknown as ConfigService,
      sessions,
      events,
      { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
      { putChallenge: async () => undefined } as unknown as PreAuthService,
      { methodsFor: async () => [], hasAnyPasskey: async () => false } as unknown as SecondFactorsService,
      { inBackground: () => undefined, sessionReplayed: () => undefined } as never,
      { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AuthController, AccountSessionsController],
      providers: [
        { provide: TripwiresService, useValue: { checkEmailLater: () => undefined } },
        AuthCookiesService,
        JwtStrategy,
        { provide: SessionsService, useValue: sessions },
        {
          provide: StaffSessionsService,
          useValue: new StaffSessionsService(ds.getRepository(StaffSessionEntity), config as unknown as ConfigService),
        },
        { provide: AuthEventsService, useValue: events },
        { provide: ConfigService, useValue: config },
        { provide: JwtService, useValue: jwt },
        { provide: UsersService, useValue: users },
        { provide: AuthService, useValue: auth },
        { provide: AccountRecoveryService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  });

  const cleanup = async () => {
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  afterAll(async () => {
    await app.close();
    await cleanup();
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await cleanup();
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const repo = ds.getRepository(UserEntity);
    userId = (await repo.save({ email: EMAIL, name: 'Person', passwordHash })).id;
    await repo.insert({ email: OTHER_EMAIL, name: 'Other', passwordHash });
    await repo.insert({ email: STAFF_EMAIL, name: 'Staff', passwordHash, isSuperAdmin: true });
  });

  describe('listing', () => {
    it('shows each device, newest first, and marks this one', async () => {
      const laptop = await signIn(EMAIL, MAC_CHROME, '203.0.113.7');
      const phone = await signIn(EMAIL, IPHONE_SAFARI, '198.51.100.2');

      const list = await sessionsOf(phone.accessToken);

      expect(list.map((s) => [s.id, s.device, s.ipAddress, s.current])).toEqual([
        [sid(phone.accessToken), 'Mobile Safari on iOS', '198.51.100.2', true],
        [sid(laptop.accessToken), 'Chrome on Mac OS', '203.0.113.7', false],
      ]);
    });

    it.each([
      ['ended', async (token: string) => void (await call('POST', 'logout', token))],
      [
        'gone idle past the refresh lifetime',
        async (token: string) =>
          void (await ds
            .getRepository(AuthSessionEntity)
            .update(sid(token), { lastUsedAt: new Date(Date.now() - 8 * DAY_MS) })),
      ],
      ['begun before a version change', async () => users.revokeAllSessions(userId)],
      [
        'reached the maximum session length while still in use',
        async (token: string) =>
          void (await ds.query(
            `UPDATE auth_sessions SET created_at = now() - interval '30 days 1 second', last_used_at = now() WHERE id = $1`,
            [sid(token)],
          )),
      ],
    ])('leaves out a session that has %s', async (_case, end) => {
      const old = await signIn();
      await end(old.accessToken);
      const now = await signIn();

      expect((await sessionsOf(now.accessToken)).map((s) => s.id)).toEqual([sid(now.accessToken)]);
    });

    it('still lists a session idle for less than the refresh lifetime', async () => {
      const quiet = await signIn();
      await ds
        .getRepository(AuthSessionEntity)
        .update(sid(quiet.accessToken), { lastUsedAt: new Date(Date.now() - 6 * DAY_MS) });
      const now = await signIn();

      expect(await sessionsOf(now.accessToken)).toHaveLength(2);
    });

    it('still lists a session just short of the maximum session length', async () => {
      const old = await signIn();
      await ds.query(
        `UPDATE auth_sessions SET created_at = now() - interval '29 days 23 hours' WHERE id = $1`,
        [sid(old.accessToken)],
      );
      const now = await signIn();

      expect(await sessionsOf(now.accessToken)).toHaveLength(2);
    });

    it('never shows another account’s sessions', async () => {
      await signIn(OTHER_EMAIL);
      const mine = await signIn();
      expect(await sessionsOf(mine.accessToken)).toHaveLength(1);
    });
  });

  describe('signing a device out', () => {
    it('ends that device’s access token at once, and its refresh token', async () => {
      const laptop = await signIn();
      const phone = await signIn(EMAIL, IPHONE_SAFARI);
      expect((await call('GET', 'sessions', laptop.accessToken)).status).toBe(200);

      const response = await call('DELETE', `sessions/${sid(laptop.accessToken)}`, phone.accessToken);

      expect(response.status).toBe(204);
      expect((await call('GET', 'sessions', laptop.accessToken)).status).toBe(401);
      await expect(auth.refresh(laptop.refreshToken)).rejects.toThrow();
      expect((await call('GET', 'sessions', phone.accessToken)).status).toBe(200);
    });

    it('refuses this device, which signs out the ordinary way', async () => {
      const phone = await signIn();
      const response = await call('DELETE', `sessions/${sid(phone.accessToken)}`, phone.accessToken);
      expect(response.status).toBe(400);
      expect((await call('GET', 'sessions', phone.accessToken)).status).toBe(200);
    });

    it('cannot touch another account’s session, and says only that it is not there', async () => {
      const theirs = await signIn(OTHER_EMAIL);
      const mine = await signIn();

      const response = await call('DELETE', `sessions/${sid(theirs.accessToken)}`, mine.accessToken);

      expect(response.status).toBe(404);
      expect((await call('GET', 'sessions', theirs.accessToken)).status).toBe(200);
    });

    it('refuses an id that is not a uuid', async () => {
      const mine = await signIn();
      expect((await call('DELETE', 'sessions/not-a-uuid', mine.accessToken)).status).toBe(400);
    });

    it('can sign out every other device and keep this one', async () => {
      const a = await signIn();
      const b = await signIn(EMAIL, IPHONE_SAFARI);
      const theirs = await signIn(OTHER_EMAIL);
      const keep = await signIn();

      expect((await call('DELETE', 'sessions', keep.accessToken)).status).toBe(204);

      expect((await call('GET', 'sessions', a.accessToken)).status).toBe(401);
      expect((await call('GET', 'sessions', b.accessToken)).status).toBe(401);
      expect((await call('GET', 'sessions', theirs.accessToken)).status).toBe(200);
      expect((await sessionsOf(keep.accessToken)).map((s) => s.id)).toEqual([sid(keep.accessToken)]);
    });

    it('ends this device’s access token at once on ordinary sign-out too', async () => {
      const mine = await signIn();
      expect((await call('POST', 'logout', mine.accessToken)).status).toBe(204);
      expect((await call('GET', 'sessions', mine.accessToken)).status).toBe(401);
    });
  });

  describe('activity', () => {
    it('lists sign-ins, failures and sign-outs of other devices, and not routine refreshes', async () => {
      await expect(auth.login({ email: EMAIL, password: 'wrong-password' }, {})).rejects.toThrow();
      const laptop = await signIn();
      await auth.refresh(laptop.refreshToken);
      const phone = await signIn(EMAIL, IPHONE_SAFARI);
      await call('DELETE', `sessions/${sid(laptop.accessToken)}`, phone.accessToken);

      const { activity, days } = await activityOf(phone.accessToken);

      expect(days).toBe(90);
      expect(activity.map((a) => [a.type, a.current])).toEqual([
        ['session.revoked', true],
        ['login.succeeded', true],
        ['login.succeeded', false],
        ['login.failed', false],
      ]);
      expect(activity[1].device).toBe('Mobile Safari on iOS');
    });

    it('says nothing about why a sign-in failed, nor carries the address', async () => {
      await expect(auth.login({ email: EMAIL, password: 'wrong-password' }, {})).rejects.toThrow();
      const mine = await signIn();

      const { activity } = await activityOf(mine.accessToken);

      for (const entry of activity) {
        expect(Object.keys(entry).sort()).toEqual(['at', 'current', 'device', 'id', 'ipAddress', 'type']);
      }
    });

    it('never shows another account’s activity, nor anything older than 90 days', async () => {
      await signIn(OTHER_EMAIL);
      const mine = await signIn();
      await ds.query(
        `UPDATE auth_events SET created_at = now() - interval '91 days' WHERE user_id = $1 AND session_id = $2`,
        [userId, sid(mine.accessToken)],
      );
      const now = await signIn();

      const { activity } = await activityOf(now.accessToken);

      expect(activity.map((a) => a.current)).toEqual([true]);
    });
  });

  describe('staff looking through an account', () => {
    it('see neither the devices nor the activity, and cannot sign anything out', async () => {
      const mine = await signIn();
      const staff = await ds.getRepository(UserEntity).findOneByOrFail({ email: STAFF_EMAIL });
      // A view-as names the staff session it came from, which must be live.
      const { sessionId } = await issueStaffSessionForTest(ds, staff);
      const impersonation = await jwt.signAsync({
        sub: userId,
        email: EMAIL,
        type: 'access',
        imp: staff.id,
        impSv: 0,
        impSid: sessionId,
      });
      // The token itself is good: a page it is allowed to read answers.
      expect((await call('GET', 'me', impersonation)).status).toBe(200);

      expect((await call('GET', 'sessions', impersonation)).status).toBe(403);
      expect((await call('GET', 'activity', impersonation)).status).toBe(403);
      expect((await call('DELETE', 'sessions', impersonation)).status).toBe(403);
      expect(
        (await call('DELETE', `sessions/${sid(mine.accessToken)}`, impersonation)).status,
      ).toBe(403);
      expect((await call('GET', 'sessions', mine.accessToken)).status).toBe(200);
    });
  });
});

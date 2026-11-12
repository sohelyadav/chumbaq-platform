import { TripwiresService } from '../security-alerts/tripwires.service';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AccountRecoveryService } from './account-recovery.service';
import { AuthCookiesService } from './auth-cookies.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { PreAuthService } from './pre-auth.service';
import { SecondFactorsService } from './second-factors.service';
import { SessionsService } from './sessions.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { StaffSessionsService } from './staff-sessions.service';

const SECRET = 'test-secret-long-enough-for-the-strategy';
const DOMAIN = '@auth-cookies-int.test';
const EMAIL = `person${DOMAIN}`;
const PASSWORD = 'correct-horse-battery';
const CLIENT = { 'x-chumbaq-client': 'web' };

/** Real HTTP, real Postgres, and what actually goes over the wire. */
describe('Refresh cookie (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let secure: boolean | undefined;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });

  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${base}/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const setCookie = (response: Response) => response.headers.getSetCookie()[0] ?? '';
  const pair = (response: Response) => setCookie(response).split(';')[0];
  const login = () => post('login', { email: EMAIL, password: PASSWORD }, CLIENT);

  beforeAll(async () => {
    ds = await openIntDb();
    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'jwt.refreshSecret' ? 'test-refresh-secret-not-the-access-one' : key === 'jwt.secret' ? SECRET : key === 'app.authCookieSecure' ? secure : fallback,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AuthController],
      providers: [
        { provide: TripwiresService, useValue: { checkEmailLater: () => undefined } },
        AuthCookiesService,
        JwtStrategy,
        { provide: SessionsService, useValue: new SessionsService(ds.getRepository(AuthSessionEntity)) },
        // No view-as tokens here, so the staff session lookup is never reached.
        { provide: StaffSessionsService, useValue: { isUsable: async () => false } },
        { provide: ConfigService, useValue: config },
        { provide: JwtService, useValue: jwt },
        { provide: UsersService, useValue: new UsersService(ds.getRepository(UserEntity)) },
        {
          provide: AuthService,
          useFactory: () =>
            new AuthService(
              new UsersService(ds.getRepository(UserEntity)),
              jwt,
              config as unknown as ConfigService,
              new SessionsService(ds.getRepository(AuthSessionEntity)),
              new AuthEventsService(ds.getRepository(AuthEventEntity)),
              { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
              { putChallenge: async () => undefined } as unknown as PreAuthService,
              { methodsFor: async () => [], hasAnyPasskey: async () => false } as unknown as SecondFactorsService,
              { inBackground: () => undefined, sessionReplayed: () => undefined } as never,
              { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never),
        },
        { provide: AccountRecoveryService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  });

  afterAll(async () => {
    await app.close();
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    secure = true;
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.getRepository(UserEntity).insert({
      email: EMAIL,
      name: 'Person',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
    });
  });

  describe('signing in', () => {
    it.each(['login', 'register'])(
      '%s refuses without the client header, so another site’s form cannot swap the session',
      async (route) => {
        const response = await post(route, { email: `x${DOMAIN}`, password: PASSWORD, name: 'N' });
        expect(response.status).toBe(403);
        expect(setCookie(response)).toBe('');
      },
    );

    it('refuses a form post of the attacker’s real password the same way', async () => {
      const response = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
      });
      expect(response.status).toBe(403);
      expect(setCookie(response)).toBe('');
    });

    it('puts the refresh token in the cookie and nowhere a script could read it', async () => {
      const response = await login();
      const body = (await response.json()) as { tokens: Record<string, string> };

      expect(Object.keys(body.tokens)).toEqual(['accessToken']);
      const cookie = setCookie(response);
      expect(cookie).toMatch(/^chumbaq_refresh=[\w-]+\.[\w-]+\.[\w-]+;/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/api/auth');
    });

    it('expires with the token', async () => {
      const cookie = setCookie(await login());
      const token = cookie.split(';')[0].split('=')[1];
      const { exp } = jwt.decode<{ exp: number }>(token);
      const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
      expect(Math.abs(maxAge - (exp - Date.now() / 1000))).toBeLessThan(5);
    });

    // Set before new passwords were held to bcrypt's 72 bytes: still signs in, so it can be changed.
    it('still signs in with a password longer than a new one may be', async () => {
      const long = 'a long passphrase from before the limit '.repeat(3);
      await ds.getRepository(UserEntity).update({ email: EMAIL }, { passwordHash: await bcrypt.hash(long, 4) });
      expect((await post('login', { email: EMAIL, password: long }, CLIENT)).status).toBe(200);
    });

    it('leaves Secure off only when configured to', async () => {
      secure = false;
      const cookie = setCookie(await login());
      expect(cookie).not.toContain('Secure');
      expect(cookie).toContain('HttpOnly');
    });

    it('is on registering too', async () => {
      jest.spyOn(app.get(AuthService), 'register').mockResolvedValueOnce({
        user: {},
        tokens: {
          accessToken: 'a',
          refreshToken: jwt.sign({ sub: 'x' }, { expiresIn: '7d' }),
        },
      });
      const response = await post('register', { email: `new${DOMAIN}`, password: PASSWORD, name: 'N' }, CLIENT);
      const body = (await response.json()) as { tokens: Record<string, string> };
      expect(Object.keys(body.tokens)).toEqual(['accessToken']);
      expect(setCookie(response)).toContain('HttpOnly');
    });
  });

  describe('refreshing', () => {
    it('refuses a token in the body without the client header, and sets no cookie', async () => {
      const refreshToken = jwt.sign({ sub: 'x' }, { expiresIn: '7d' });
      const response = await post('refresh', { refreshToken });

      expect(response.status).toBe(403);
      expect(setCookie(response)).toBe('');
    });

    it('works with the cookie alone, and rotates it', async () => {
      const cookie = pair(await login());

      const response = await post('refresh', {}, { cookie, ...CLIENT });
      const body = (await response.json()) as Record<string, string>;

      expect(response.status).toBe(200);
      expect(Object.keys(body)).toEqual(['accessToken']);
      expect(pair(response)).not.toBe(cookie);
      expect(setCookie(response)).toContain('HttpOnly');
    });

    it('refuses the cookie without the client header, which a cross-site form cannot send', async () => {
      const cookie = pair(await login());
      const response = await post('refresh', {}, { cookie });
      expect(response.status).toBe(403);
      expect(await post('refresh', {}, { cookie, ...CLIENT })).toMatchObject({ status: 200 });
    });

    it('refuses with neither', async () => {
      expect((await post('refresh', {}, CLIENT)).status).toBe(401);
    });

    // A body token was how localStorage sessions moved to the cookie. Taking one would let
    // anything that can post here name a session, so a real, live token is now ignored.
    it('ignores a token in the body, however valid', async () => {
      const cookie = pair(await login());
      const [, token] = cookie.split('=');

      const response = await post('refresh', { refreshToken: token }, CLIENT);

      expect(response.status).toBe(401);
      expect(setCookie(response)).not.toMatch(/^chumbaq_refresh=[\w-]+\./);
      expect((await post('refresh', {}, { cookie, ...CLIENT })).status).toBe(200);
    });

    it('refuses a refresh token signed with the access key', async () => {
      const user = await ds.getRepository(UserEntity).findOneByOrFail({ email: EMAIL });
      const forged = await jwt.signAsync(
        { sub: user.id, email: EMAIL, type: 'refresh', sv: user.sessionVersion },
        { expiresIn: '5m' },
      );

      const cookie = `chumbaq_refresh=${forged}`;
      expect((await post('refresh', {}, { cookie, ...CLIENT })).status).toBe(401);
    });

    it('clears the cookie when it is refused, as a replay is', async () => {
      const first = pair(await login());
      const second = pair(await post('refresh', {}, { cookie: first, ...CLIENT }));
      await ds.query(`UPDATE auth_sessions SET rotated_at = now() - interval '1 minute'`);

      const replay = await post('refresh', {}, { cookie: first, ...CLIENT });

      expect(replay.status).toBe(401);
      expect(setCookie(replay)).toMatch(/^chumbaq_refresh=;/);
      expect((await post('refresh', {}, { cookie: second, ...CLIENT })).status).toBe(401);
    });

    it('keeps the cookie through an outage', async () => {
      const cookie = pair(await login());
      jest.spyOn(app.get(AuthService), 'refresh').mockRejectedValueOnce(new Error('database away'));

      const response = await post('refresh', {}, { cookie, ...CLIENT });

      expect(response.status).toBe(500);
      expect(setCookie(response)).toBe('');
    });
  });

  describe('signing out', () => {
    const signedIn = async () => {
      const response = await login();
      const { tokens } = (await response.json()) as { tokens: { accessToken: string } };
      return { cookie: pair(response), authorization: `Bearer ${tokens.accessToken}` };
    };

    it.each(['logout', 'logout-all'])('%s clears the cookie and ends the session', async (route) => {
      const { cookie, authorization } = await signedIn();

      const response = await post(route, {}, { authorization });

      expect(response.status).toBe(204);
      expect(setCookie(response)).toMatch(/^chumbaq_refresh=;/);
      expect(setCookie(response)).toContain('Path=/api/auth');
      expect((await post('refresh', {}, { cookie, ...CLIENT })).status).toBe(401);
    });
  });
});

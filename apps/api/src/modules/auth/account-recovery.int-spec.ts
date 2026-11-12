import { TripwiresService } from '../security-alerts/tripwires.service';
import { createHash } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AccountRecoveryService, FORGOT_PASSWORD_MESSAGE, INVALID_TOKEN_MESSAGE } from './account-recovery.service';
import { AccountTokensService, MAX_SENDS_PER_HOUR } from './account-tokens.service';
import { AuthController } from './auth.controller';
import { AuthCookiesService, CLIENT_HEADER } from './auth-cookies.service';
import { AuthService } from './auth.service';
import { AccountTokenEntity } from './entities/account-token.entity';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { SessionsService } from './sessions.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { StaffSessionsService } from './staff-sessions.service';
import { StaffSessionEntity } from './entities/staff-session.entity';
import { issueStaffSessionForTest } from '../../test-support/staff-session';

const SECRET = 'test-secret';
const DOMAIN = '@account-recovery-int.test';
const EMAIL = `person${DOMAIN}`;
const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-brand-new-password';
const APP_URL = 'https://app.chumbaq.test';

interface SentEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The real controller, services, validation pipe, throttler and JWT strategy over real
 * HTTP and a real Postgres. Only `fetch` is stubbed, so what is asserted is the request
 * that would have gone to Brevo, and each token below comes out of an email body the
 * way a person would get it.
 */
describe('Email verification and forgot password (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let baseUrl: { port: number };
  let tokens: AccountTokensService;
  let users: UsersService;
  let auth: AuthService;
  let recovery: AccountRecoveryService;

  let emails: SentEmail[];
  let provider: 'ok' | 'refuses' | 'unreachable';
  let holdSend: Promise<void> | null;
  let logged: string[];
  let env: Record<string, string | undefined>;

  const jwt = new JwtService({ secret: SECRET });

  const config = {
    get: (key: string, fallback?: string) => env[key] ?? fallback,
    getOrThrow: (key: string) => env[key],
  } as unknown as ConfigService;

  const cleanup = async () => {
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  const startApp = async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: TripwiresService, useValue: { checkEmailLater: () => undefined } },
        { provide: AuthService, useValue: auth },
        { provide: AccountRecoveryService, useValue: recovery },
        { provide: AuthCookiesService, useFactory: () => new AuthCookiesService(config, jwt) },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        {
          provide: JwtStrategy,
          useFactory: () =>
            new JwtStrategy(
              config,
              users,
              new SessionsService(ds.getRepository(AuthSessionEntity)),
              new StaffSessionsService(ds.getRepository(StaffSessionEntity), config as unknown as ConfigService),
            ),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.listen(0);
    baseUrl = { port: (app.getHttpServer().address() as AddressInfo).port };
  };

  /** node:http and not fetch, because fetch refuses to send a forged Host. */
  const request = (
    method: string,
    path: string,
    options: { body?: unknown; bearer?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any; setCookie: string[] }> =>
    new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: baseUrl.port,
          method,
          path,
          headers: {
            ...(payload ? { 'content-type': 'application/json' } : {}),
            ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
            [CLIENT_HEADER]: 'web',
            ...options.headers,
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => resolve({ setCookie: res.headers['set-cookie'] ?? [], status: res.statusCode as number, body: JSON.parse(raw || '{}') }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });

  const post = (path: string, body?: unknown, bearer?: string) =>
    request('POST', `/auth/${path}`, { body, bearer });

  const sessionOf = async (email: string) =>
    (await post('login', { email, password: PASSWORD })).body.data.tokens.accessToken as string;

  const createUser = async (email = EMAIL, overrides: Partial<UserEntity> = {}) => {
    const user = await users.create({
      email,
      name: 'Person',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
    });
    if (Object.keys(overrides).length) await ds.getRepository(UserEntity).update(user.id, overrides);
    return (await users.findById(user.id)) as UserEntity;
  };

  const tokenIn = (email: SentEmail): string => {
    const match = /#token=([A-Za-z0-9_-]+)/.exec(email.text);
    if (!match) throw new Error('No token in the email');
    return match[1];
  };

  /** Asks for a reset the way a person does, and reads the link from what was sent. */
  const resetTokenFor = async (email = EMAIL): Promise<string> => {
    const before = emails.length;
    expect((await post('forgot-password', { email })).status).toBe(200);
    await recovery.settled();
    expect(emails).toHaveLength(before + 1);
    return tokenIn(emails[before]);
  };

  const tokenRows = (userId: string) =>
    ds.getRepository(AccountTokenEntity).find({ where: { userId }, order: { createdAt: 'ASC' } });

  const eventsFor = (email = EMAIL) =>
    ds.getRepository(AuthEventEntity).find({ where: { email }, order: { createdAt: 'ASC' } });

  beforeAll(async () => {
    ds = await openIntDb();
    users = new UsersService(ds.getRepository(UserEntity));
    tokens = new AccountTokensService(ds.getRepository(AccountTokenEntity));
    const sessions = new SessionsService(ds.getRepository(AuthSessionEntity));
    const events = new AuthEventsService(ds.getRepository(AuthEventEntity));
    recovery = new AccountRecoveryService(
      users,
      tokens,
      sessions,
      new PlatformEmailService(config),
      events,
      config,
      // Its own suite covers what a password reset does to a waiting factor reset.
      {
        cancelForPasswordReset: async () => null,
        announceCancelled: async () => undefined,
        passwordResetBlockedSince: async () => null,
      } as never,
    );
    auth = new AuthService(users, jwt, config, sessions, events, recovery, { putChallenge: async () => undefined } as never, { methodsFor: async () => [], hasAnyPasskey: async () => false } as never, { inBackground: () => undefined, sessionReplayed: () => undefined } as never, { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
  });

  afterAll(async () => {
    await cleanup();
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await cleanup();
    emails = [];
    provider = 'ok';
    holdSend = null;
    logged = [];
    env = {
      'app.appUrl': APP_URL,
      'jwt.secret': SECRET,
      'jwt.refreshSecret': 'test-refresh-secret-not-the-access-one',
      PLATFORM_BREVO_API_KEY: 'xkeysib-test',
      PLATFORM_EMAIL_FROM: 'Chumbaq <no-reply@chumbaq.test>',
    };
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      if (holdSend) await holdSend;
      if (provider === 'unreachable') throw new TypeError('fetch failed');
      if (provider === 'refuses') {
        return new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), {
          status: 401,
        });
      }
      const body = JSON.parse(init?.body as string);
      emails.push({
        to: body.to[0].email,
        subject: body.subject,
        html: body.htmlContent,
        text: body.textContent,
      });
      return new Response('{}', { status: 201 });
    });
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(capture);
    }
    await startApp();
  });

  afterEach(async () => {
    await recovery.settled();
    await app.close();
    jest.restoreAllMocks();
  });

  describe('tokens', () => {
    it('stores the SHA-256 of a 32-byte token, and never the token', async () => {
      const user = await createUser();
      const token = (await tokens.issue(user.id, 'reset_password')) as string;

      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      const rows = await tokenRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it.each([
      ['reset_password', 30] as const,
      ['verify_email', 24 * 60] as const,
    ])('gives %s a lifetime of %i minutes', async (purpose, minutes) => {
      const user = await createUser();
      await tokens.issue(user.id, purpose);

      const [row] = await tokenRows(user.id);
      const lifetime = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(Math.abs(lifetime - minutes * 60_000)).toBeLessThan(5_000);
    });

    it('works once', async () => {
      const user = await createUser();
      const token = (await tokens.issue(user.id, 'reset_password')) as string;

      await expect(tokens.consume(token, 'reset_password')).resolves.toBe(user.id);
      await expect(tokens.consume(token, 'reset_password')).resolves.toBeNull();
    });

    it('refuses an expired token', async () => {
      const user = await createUser();
      const token = (await tokens.issue(user.id, 'reset_password')) as string;
      await ds.query(`UPDATE account_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [user.id]);

      await expect(tokens.consume(token, 'reset_password')).resolves.toBeNull();
    });

    it('refuses the wrong purpose, and does not spend the token doing so', async () => {
      const user = await createUser();
      const token = (await tokens.issue(user.id, 'verify_email')) as string;

      await expect(tokens.consume(token, 'reset_password')).resolves.toBeNull();
      await expect(tokens.consume(token, 'verify_email')).resolves.toBe(user.id);
    });

    it('lets exactly one of many simultaneous uses succeed', async () => {
      const user = await createUser();
      const token = (await tokens.issue(user.id, 'reset_password')) as string;

      const results = await Promise.all(
        Array.from({ length: 8 }, () => tokens.consume(token, 'reset_password')),
      );

      expect(results.filter(Boolean)).toEqual([user.id]);
    });

    it('invalidates earlier unused tokens of that purpose only', async () => {
      const user = await createUser();
      const verify = (await tokens.issue(user.id, 'verify_email')) as string;
      const first = (await tokens.issue(user.id, 'reset_password')) as string;
      const second = (await tokens.issue(user.id, 'reset_password')) as string;

      await expect(tokens.consume(first, 'reset_password')).resolves.toBeNull();
      await expect(tokens.consume(second, 'reset_password')).resolves.toBe(user.id);
      await expect(tokens.consume(verify, 'verify_email')).resolves.toBe(user.id);
    });

    it('stops at the hourly limit, counting tokens already replaced', async () => {
      const user = await createUser();
      for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) {
        await expect(tokens.issue(user.id, 'reset_password')).resolves.toEqual(expect.any(String));
      }

      await expect(tokens.issue(user.id, 'reset_password')).resolves.toBeNull();
    });

    it('counts only the past hour', async () => {
      const user = await createUser();
      for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) await tokens.issue(user.id, 'reset_password');
      await ds.query(
        `UPDATE account_tokens SET created_at = now() - interval '61 minutes' WHERE user_id = $1`,
        [user.id],
      );

      await expect(tokens.issue(user.id, 'reset_password')).resolves.toEqual(expect.any(String));
    });

    it('holds the limit and leaves one live token under simultaneous requests', async () => {
      const user = await createUser();

      const issued = await Promise.all(
        Array.from({ length: 8 }, () => tokens.issue(user.id, 'reset_password')),
      );

      expect(issued.filter(Boolean)).toHaveLength(MAX_SENDS_PER_HOUR);
      const rows = await tokenRows(user.id);
      expect(rows).toHaveLength(MAX_SENDS_PER_HOUR);
      expect(rows.filter((row) => row.usedAt === null)).toHaveLength(1);
    });

    it('goes with the user', async () => {
      const user = await createUser();
      await tokens.issue(user.id, 'reset_password');

      await ds.getRepository(UserEntity).delete(user.id);

      await expect(tokenRows(user.id)).resolves.toEqual([]);
    });
  });

  describe('email verification', () => {
    const register = (name = 'Person', email = EMAIL) =>
      post('register', { email, name, password: PASSWORD });

    it('sends a link on registration, and the link verifies the address', async () => {
      const { status, body } = await register();
      await recovery.settled();

      expect(status).toBe(201);
      expect(body.data.user.emailVerifiedAt).toBeNull();
      expect(emails).toHaveLength(1);
      expect(emails[0].to).toBe(EMAIL);
      const me = () => request('GET', '/auth/me', { bearer: body.data.tokens.accessToken });
      expect((await me()).body.data.emailVerifiedAt).toBeNull();

      const verified = await post(
        'verify-email',
        { token: tokenIn(emails[0]) },
        body.data.tokens.accessToken,
      );

      expect(verified.status).toBe(200);
      expect((await me()).body.data.emailVerifiedAt).toEqual(expect.any(String));
      expect((await eventsFor()).map((event) => event.type)).toContain('email.verified');
    });

    it('sends both a text and an HTML part, with the link in each', async () => {
      await register();
      await recovery.settled();

      const token = tokenIn(emails[0]);
      const link = `${APP_URL}/verify-email#token=${token}`;
      expect(emails[0].text).toContain(link);
      expect(emails[0].html).toContain(`href="${link}"`);
    });

    it('escapes a name containing a script tag in the HTML part', async () => {
      await register(`<script>alert("x")</script>`);
      await recovery.settled();

      expect(emails[0].html).not.toContain('<script');
      expect(emails[0].html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      // Plain text is not HTML, so entities there would just be noise.
      expect(emails[0].text).toContain('<script>alert("x")</script>');
    });

    it.each([
      ['refuses it', () => { provider = 'refuses'; }],
      ['cannot be reached', () => { provider = 'unreachable'; }],
      ['is not configured', () => { env.PLATFORM_BREVO_API_KEY = undefined; }],
    ])('still registers when the provider %s', async (_label, breakProvider) => {
      breakProvider();

      const { status, body } = await register();
      await recovery.settled();

      expect(status).toBe(201);
      expect(body.data.tokens.accessToken).toEqual(expect.any(String));
      expect(await users.findByEmail(EMAIL)).not.toBeNull();
      expect(emails).toEqual([]);
      expect(logged.join()).toContain('Verification email not sent');
    });

    it('does not wait for the provider to answer before registering', async () => {
      let release!: () => void;
      holdSend = new Promise((resolve) => (release = resolve));

      const { status } = await register();

      expect(status).toBe(201);
      expect(emails).toEqual([]);
      release();
      await recovery.settled();
      expect(emails).toHaveLength(1);
    });

    it('leaves accounts unverified until someone proves the address, without blocking them', async () => {
      const managed = await createUser(`managed${DOMAIN}`, {
        managedByTeamId: '33333333-3333-4333-8333-333333333333',
      });
      expect(managed.emailVerifiedAt).toBeNull();
      expect(emails).toEqual([]);

      const login = await post('login', { email: managed.email, password: PASSWORD });

      expect(login.status).toBe(200);
      expect(login.body.data.user.emailVerifiedAt).toBeNull();
    });

    it('does not release a team-created account: only a password reset does that', async () => {
      const teamId = '33333333-3333-4333-8333-333333333333';
      const managed = await createUser(`managed${DOMAIN}`, { managedByTeamId: teamId });
      const token = (await tokens.issue(managed.id, 'verify_email')) as string;

      expect((await post('verify-email', { token }, await sessionOf(managed.email))).status).toBe(200);

      const after = await users.findById(managed.id);
      expect(after?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(after?.managedByTeamId).toBe(teamId);
    });

    it('refuses a verify link used twice, with the generic error', async () => {
      const user = await createUser();
      const token = (await tokens.issue(user.id, 'verify_email')) as string;
      const bearer = await sessionOf(user.email);
      expect((await post('verify-email', { token }, bearer)).status).toBe(200);

      const again = await post('verify-email', { token }, bearer);

      expect(again.status).toBe(400);
      expect(again.body.message).toBe(INVALID_TOKEN_MESSAGE);
    });

    it('refuses a reset token at the verify endpoint', async () => {
      const user = await createUser();
      const token = (await tokens.issue(user.id, 'reset_password')) as string;

      expect((await post('verify-email', { token }, await sessionOf(user.email))).status).toBe(400);
      expect((await users.findById(user.id))?.emailVerifiedAt).toBeNull();
    });

    it('does not verify a suspended account', async () => {
      const user = await createUser();
      const token = (await tokens.issue(user.id, 'verify_email')) as string;
      const bearer = await sessionOf(user.email);
      await ds.getRepository(UserEntity).update(user.id, { suspendedAt: new Date() });

      expect((await post('verify-email', { token }, bearer)).status).toBeGreaterThanOrEqual(400);
      expect((await users.findById(user.id))?.emailVerifiedAt).toBeNull();
    });

    describe('when whoever clicks is not who registered', () => {
      it('verifies nothing for a click with no session, and the link survives', async () => {
        const user = await createUser();
        const token = (await tokens.issue(user.id, 'verify_email')) as string;

        expect((await post('verify-email', { token })).status).toBe(401);
        expect((await users.findById(user.id))?.emailVerifiedAt).toBeNull();

        expect((await post('verify-email', { token }, await sessionOf(user.email))).status).toBe(200);
      });

      it("verifies nothing for another account's session, and the link survives", async () => {
        const owner = await createUser();
        const other = await createUser(`other${DOMAIN}`);
        const token = (await tokens.issue(owner.id, 'verify_email')) as string;

        const refused = await post('verify-email', { token }, await sessionOf(other.email));

        expect(refused.status).toBe(400);
        expect(refused.body.message).toBe(INVALID_TOKEN_MESSAGE);
        expect((await users.findById(owner.id))?.emailVerifiedAt).toBeNull();
        expect((await users.findById(other.id))?.emailVerifiedAt).toBeNull();
        expect((await post('verify-email', { token }, await sessionOf(owner.email))).status).toBe(200);
      });
    });

    describe('resend', () => {
      const signedIn = async () => {
        const { body } = await post('login', { email: EMAIL, password: PASSWORD });
        return body.data.tokens.accessToken as string;
      };

      it('needs a JWT', async () => {
        expect((await post('resend-verification')).status).toBe(401);
      });

      it('sends a new link, and the earlier one stops working', async () => {
        await createUser();
        const bearer = await signedIn();

        await post('resend-verification', undefined, bearer);
        const { status, body } = await post('resend-verification', undefined, bearer);

        expect(status).toBe(200);
        expect(body.data.status).toBe('sent');
        expect(emails).toHaveLength(2);
        expect((await post('verify-email', { token: tokenIn(emails[0]) }, bearer)).status).toBe(400);
        expect((await post('verify-email', { token: tokenIn(emails[1]) }, bearer)).status).toBe(200);
      });

      it('sends nothing once verified', async () => {
        await createUser(EMAIL, { emailVerifiedAt: new Date() });

        const { body } = await post('resend-verification', undefined, await signedIn());

        expect(body.data.status).toBe('already_verified');
        expect(emails).toEqual([]);
      });

      it('says so when the email could not be sent', async () => {
        await createUser();
        provider = 'refuses';

        const { status, body } = await post('resend-verification', undefined, await signedIn());

        expect(status).toBe(200);
        expect(body.data.status).toBe('unavailable');
      });

      it('creates no token when no sender is configured', async () => {
        const user = await createUser();
        env.PLATFORM_EMAIL_FROM = undefined;

        const { body } = await post('resend-verification', undefined, await signedIn());

        expect(body.data.status).toBe('unavailable');
        await expect(tokenRows(user.id)).resolves.toEqual([]);
      });

      it('shares the hourly limit with other sends to the address', async () => {
        const user = await createUser();
        const bearer = await signedIn();
        for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) await tokens.issue(user.id, 'verify_email');

        expect((await post('resend-verification', undefined, bearer)).status).toBe(429);
        expect(emails).toEqual([]);
      });
    });
  });

  describe('forgot password', () => {
    it('answers identically for a real, unknown and suspended address, and a failed email', async () => {
      await createUser();
      await createUser(`suspended${DOMAIN}`, { suspendedAt: new Date() });
      await createUser(`refused${DOMAIN}`);

      const real = await post('forgot-password', { email: EMAIL });
      const unknown = await post('forgot-password', { email: `nobody${DOMAIN}` });
      const suspended = await post('forgot-password', { email: `suspended${DOMAIN}` });
      await recovery.settled();
      provider = 'refuses';
      const failed = await post('forgot-password', { email: `refused${DOMAIN}` });
      await recovery.settled();

      for (const response of [real, unknown, suspended, failed]) {
        expect(response.status).toBe(200);
        expect(response.body).toEqual(real.body);
      }
      expect(real.body.data.message).toBe(FORGOT_PASSWORD_MESSAGE);
      expect(emails.map((email) => email.to)).toEqual([EMAIL]);
    });

    it('creates no token for a suspended address', async () => {
      const user = await createUser(EMAIL, { suspendedAt: new Date() });

      await post('forgot-password', { email: EMAIL });
      await recovery.settled();

      await expect(tokenRows(user.id)).resolves.toEqual([]);
    });

    it('answers without waiting for the provider, so timing reveals nothing', async () => {
      await createUser();
      let release!: () => void;
      holdSend = new Promise((resolve) => (release = resolve));

      const { status } = await post('forgot-password', { email: EMAIL });

      expect(status).toBe(200);
      expect(emails).toEqual([]);
      release();
      await recovery.settled();
      expect(emails).toHaveLength(1);
    });

    it('sends at most 3 an hour to an address, with the same answer after that', async () => {
      await createUser();
      await createUser(`other${DOMAIN}`);

      const responses = [];
      for (let i = 0; i < 4; i++) {
        responses.push(await post('forgot-password', { email: EMAIL }));
        await recovery.settled();
      }
      expect(emails).toHaveLength(3);
      expect(responses.every((r) => r.status === 200 && r.body.data.message === FORGOT_PASSWORD_MESSAGE)).toBe(true);

      // Per address, not global.
      await post('forgot-password', { email: `other${DOMAIN}` });
      await recovery.settled();
      expect(emails).toHaveLength(4);
      expect(emails[3].to).toBe(`other${DOMAIN}`);
    });

    it('builds the link from APP_URL whatever Host the request claims', async () => {
      await createUser();

      await request('POST', '/auth/forgot-password', {
        body: { email: EMAIL },
        headers: {
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
          origin: 'https://evil.example',
        },
      });
      await recovery.settled();

      expect(emails).toHaveLength(1);
      expect(emails[0].text).toContain(`${APP_URL}/reset-password#token=`);
      expect(emails[0].html).toContain(`href="${APP_URL}/reset-password#token=`);
      expect(emails[0].text + emails[0].html).not.toContain('evil.example');
      expect(emails[0].text + emails[0].html).not.toContain('?token=');
    });

    it('records each request, and why it sent nothing', async () => {
      await createUser(`suspended${DOMAIN}`, { suspendedAt: new Date() });
      await post('forgot-password', { email: `nobody${DOMAIN}` });
      await post('forgot-password', { email: `suspended${DOMAIN}` });
      await recovery.settled();

      const [unknown] = await eventsFor(`nobody${DOMAIN}`);
      const [suspended] = await eventsFor(`suspended${DOMAIN}`);
      expect(unknown).toMatchObject({ type: 'password.reset_requested', reason: 'unknown_email' });
      expect(suspended).toMatchObject({ type: 'password.reset_requested', reason: 'suspended' });
    });
  });

  describe('reset password', () => {
    it('sets the password, ends every session, and tells the owner', async () => {
      const user = await createUser();
      const here = await post('login', { email: EMAIL, password: PASSWORD });
      const there = await post('login', { email: EMAIL, password: PASSWORD });
      const token = await resetTokenFor();

      const { status } = await post('reset-password', { token, newPassword: NEW_PASSWORD });
      await recovery.settled();

      expect(status).toBe(200);

      expect((await post('login', { email: EMAIL, password: PASSWORD })).status).toBe(401);
      expect((await post('login', { email: EMAIL, password: NEW_PASSWORD })).status).toBe(200);

      for (const session of [here, there]) {
        const { accessToken } = session.body.data.tokens;
        expect((await request('GET', '/auth/me', { bearer: accessToken })).status).toBe(401);
        const refused = await request('POST', '/auth/refresh', {
          body: {},
          headers: { cookie: session.setCookie[0].split(';')[0], [CLIENT_HEADER]: 'web' },
        });
        expect(refused.status).toBe(401);
      }
      const rows = await ds.getRepository(AuthSessionEntity).find({ where: { userId: user.id } });
      const earlier = [here, there].map((s) => jwt.decode<{ sid: string }>(s.body.data.tokens.accessToken).sid);
      for (const id of earlier) {
        expect(rows.find((row) => row.id === id)?.revokedAt).toBeInstanceOf(Date);
      }

      const notice = emails[emails.length - 1];
      expect(notice.to).toBe(EMAIL);
      expect(notice.subject).toBe('Your Chumbaq password was changed');
      expect((await eventsFor()).map((event) => event.type)).toContain('password.reset');
    });

    it('marks the address verified, and takes the account back from a team', async () => {
      const user = await createUser(EMAIL, {
        managedByTeamId: '33333333-3333-4333-8333-333333333333',
      });
      const token = await resetTokenFor();

      await post('reset-password', { token, newPassword: NEW_PASSWORD });

      const after = await users.findById(user.id);
      expect(after?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(after?.managedByTeamId).toBeNull();
      expect((await eventsFor()).find((event) => event.type === 'email.verified')?.reason).toBe('password_reset');
    });

    it('keeps the original verification time', async () => {
      const verifiedAt = new Date('2026-01-01T00:00:00.000Z');
      const user = await createUser(EMAIL, { emailVerifiedAt: verifiedAt });
      const token = await resetTokenFor();

      await post('reset-password', { token, newPassword: NEW_PASSWORD });

      expect((await users.findById(user.id))?.emailVerifiedAt).toEqual(verifiedAt);
      expect((await eventsFor()).map((event) => event.type)).not.toContain('email.verified');
    });

    it('invalidates the other tokens outstanding for the user', async () => {
      const user = await createUser();
      const verify = (await tokens.issue(user.id, 'verify_email')) as string;
      const token = await resetTokenFor();

      await post('reset-password', { token, newPassword: NEW_PASSWORD });

      await expect(tokens.consume(verify, 'verify_email')).resolves.toBeNull();
    });

    it('gives one generic refusal for bad, used, expired and wrong-purpose tokens', async () => {
      const user = await createUser();
      const used = await resetTokenFor();
      expect((await post('reset-password', { token: used, newPassword: NEW_PASSWORD })).status).toBe(200);
      const expired = (await tokens.issue(user.id, 'reset_password')) as string;
      await ds.query(`UPDATE account_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [user.id]);
      const wrongPurpose = (await tokens.issue(user.id, 'verify_email')) as string;

      const attempts = await Promise.all(
        ['not-a-real-token', used, expired, wrongPurpose].map((token) =>
          post('reset-password', { token, newPassword: 'another-password' }),
        ),
      );

      for (const attempt of attempts) {
        expect(attempt.status).toBe(400);
        expect(attempt.body.message).toBe(INVALID_TOKEN_MESSAGE);
      }
      expect((await post('login', { email: EMAIL, password: NEW_PASSWORD })).status).toBe(200);
    });

    // What the reset page reads: before the form, and as the answer to sending it early.
    it('answers 425 with the time for a staff link still waiting, and says when at /status', async () => {
      const user = await createUser();
      const { token, usableAt } = await ds.transaction((manager) =>
        tokens.issueByStaff(user.id, manager, 60 * 60 * 1000, 24 * 60 * 60 * 1000),
      );

      const status = await post('reset-password/status', { token });
      expect(status.status).toBe(200);
      expect(status.body.data).toEqual({ usableAt: usableAt.toISOString() });

      const early = await post('reset-password', { token, newPassword: NEW_PASSWORD });
      expect(early.status).toBe(425);
      expect(early.body.message).toBe(`This link becomes usable at ${usableAt.toISOString()}.`);
      expect((await post('login', { email: EMAIL, password: PASSWORD })).status).toBe(200);

      expect((await post('reset-password/status', { token: 'not-a-real-token' })).body.data).toEqual({
        usableAt: null,
      });
      expect((await post('reset-password/status', {})).status).toBe(400);
    });

    it('does not spend a token on a password the rules refuse', async () => {
      await createUser();
      const token = await resetTokenFor();

      expect((await post('reset-password', { token, newPassword: 'x'.repeat(7) })).status).toBe(400);
      expect((await post('reset-password', { token, newPassword: 'x'.repeat(73) })).status).toBe(400);
      // 37 characters but 74 bytes, past what bcrypt reads.
      expect((await post('reset-password', { token, newPassword: 'é'.repeat(37) })).status).toBe(400);

      expect((await post('login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
      expect((await post('reset-password', { token, newPassword: 'x'.repeat(72) })).status).toBe(200);
    });

    it('accepts exactly 8 characters', async () => {
      await createUser();
      const token = await resetTokenFor();

      expect((await post('reset-password', { token, newPassword: 'x'.repeat(8) })).status).toBe(200);
    });

    it('refuses a suspended account, leaving it suspended and its password alone', async () => {
      const user = await createUser();
      const token = await resetTokenFor();
      const suspendedAt = new Date();
      await ds.getRepository(UserEntity).update(user.id, { suspendedAt, suspendedReason: 'abuse' });
      const before = emails.length;

      const { status, body } = await post('reset-password', { token, newPassword: NEW_PASSWORD });
      await recovery.settled();

      expect(status).toBe(400);
      expect(body.message).toBe(INVALID_TOKEN_MESSAGE);
      const after = await users.findById(user.id);
      expect(after?.suspendedAt).toEqual(suspendedAt);
      expect(after?.emailVerifiedAt).toBeNull();
      expect(await bcrypt.compare(PASSWORD, after?.passwordHash as string)).toBe(true);
      expect(emails).toHaveLength(before);
    });

    it('lets exactly one of several simultaneous resets through', async () => {
      await createUser();
      const token = await resetTokenFor();

      const responses = await Promise.all(
        ['first-password', 'second-password', 'third-password'].map((newPassword) =>
          post('reset-password', { token, newPassword }),
        ),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    });

    it('does not deadlock when a reset races a new request for a link', async () => {
      const user = await createUser();

      for (let round = 0; round < 25; round++) {
        await ds.query(`DELETE FROM account_tokens WHERE user_id = $1`, [user.id]);
        const token = (await tokens.issue(user.id, 'reset_password')) as string;

        // Never a 500: a deadlock victim would reject here or log below.
        recovery.requestPasswordReset(EMAIL);
        await recovery.resetPassword(token, NEW_PASSWORD).catch((error) => {
          expect(error.status).toBe(400);
        });
        await recovery.settled();
      }

      expect(logged.join()).not.toContain('deadlock');
    });

    it('lifts the failed sign-in limit, since those guesses were at the old password', async () => {
      await createUser();
      for (let i = 0; i < 10; i++) {
        await expect(auth.login({ email: EMAIL, password: 'wrong-password' })).rejects.toBeDefined();
      }
      await expect(auth.login({ email: EMAIL, password: PASSWORD })).rejects.toMatchObject({ status: 429 });
      const token = await resetTokenFor();

      await post('reset-password', { token, newPassword: NEW_PASSWORD });

      await expect(auth.login({ email: EMAIL, password: NEW_PASSWORD })).resolves.toBeDefined();
    });

    it('never logs or records a token or a link', async () => {
      await createUser();
      const token = await resetTokenFor();
      await post('reset-password', { token, newPassword: NEW_PASSWORD });
      provider = 'refuses';
      await post('forgot-password', { email: EMAIL });
      await recovery.settled();

      const stored = JSON.stringify(await eventsFor());
      for (const text of [logged.join('\n'), stored]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain('token=');
        expect(text).not.toContain(NEW_PASSWORD);
      }
    });
  });

  describe('with an impersonation token', () => {
    const impersonate = async () => {
      const admin = await createUser(`admin${DOMAIN}`, { isSuperAdmin: true });
      const tenant = await createUser();
      // A view-as names the staff session it came from, which must be live.
      const { sessionId } = await issueStaffSessionForTest(ds, admin);
      const bearer = await jwt.signAsync(
        { sub: tenant.id, email: tenant.email, type: 'access', imp: admin.id, sv: 0, impSv: 0, impSid: sessionId },
        { expiresIn: '5m' },
      );
      return { tenant, bearer };
    };

    it('can read emailVerifiedAt but cannot send anything', async () => {
      const { bearer } = await impersonate();

      const me = await request('GET', '/auth/me', { bearer });
      const resend = await post('resend-verification', undefined, bearer);

      expect(me.status).toBe(200);
      expect(me.body.data.emailVerifiedAt).toBeNull();
      expect(resend.status).toBe(403);
      expect(resend.body.message).toBe('Impersonation sessions are read-only');
      expect(emails).toEqual([]);
    });

    it('gains nothing at verify-email, refused as read-only, or at reset-password, which ignores it', async () => {
      const { bearer, tenant } = await impersonate();

      const verify = await post('verify-email', { token: 'not-a-real-token' }, bearer);
      const reset = await post('reset-password', { token: 'not-a-real-token', newPassword: NEW_PASSWORD }, bearer);

      expect(verify.status).toBe(403);
      expect(reset.status).toBe(400);
      expect((await users.findById(tenant.id))?.emailVerifiedAt).toBeNull();
      expect(await bcrypt.compare(PASSWORD, (await users.findById(tenant.id))?.passwordHash as string)).toBe(true);
    });
  });

  describe('throttling', () => {
    it.each([
      ['forgot-password', { email: `nobody${DOMAIN}` }, 5],
      ['verify-email', { token: 'x' }, 10],
      ['reset-password', { token: 'x', newPassword: NEW_PASSWORD }, 5],
    ])('limits %s per IP', async (route, body, limit) => {
      for (let i = 0; i < limit; i++) {
        expect((await post(route, body)).status).not.toBe(429);
      }
      expect((await post(route, body)).status).toBe(429);
    });

    it('limits resend-verification per IP', async () => {
      await createUser(EMAIL, { emailVerifiedAt: new Date() });
      const { body } = await post('login', { email: EMAIL, password: PASSWORD });
      const bearer = body.data.tokens.accessToken;
      for (let i = 0; i < 3; i++) {
        expect((await post('resend-verification', undefined, bearer)).status).toBe(200);
      }
      expect((await post('resend-verification', undefined, bearer)).status).toBe(429);
    });
  });
});

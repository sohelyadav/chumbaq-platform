import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { PlatformEmail, PlatformEmailResult, PlatformEmailService } from '../platform-email/platform-email.service';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import type { AccountRecoveryService } from './account-recovery.service';
import { AuthService, SignedIn } from './auth.service';
import { AuthSessionEntity } from './entities/auth-session.entity';
import type { PreAuthService } from './pre-auth.service';
import type { SecondFactorsService } from './second-factors.service';
import { deviceFamily, SessionsService } from './sessions.service';

const SECRET = 'test-secret';
const DOMAIN = '@security-notices-int.test';
const EMAIL = `person${DOMAIN}`;
const PASSWORD = 'correct-horse-battery';
const APP_URL = 'https://dashboard.test';
// Real browsers' user agents, not invented ones.
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CHROME_MAC_NEWER = CHROME_MAC.replace('Chrome/130', 'Chrome/131');
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Real services, Postgres and templates; only the provider's HTTP call is replaced. */
describe('Security notices (integration)', () => {
  let ds: DataSource;
  let auth: AuthService;
  let users: UsersService;
  let notices: SecurityNoticesService;
  let sent: PlatformEmail[];
  let provider: (email: PlatformEmail) => Promise<PlatformEmailResult>;
  const jwt = new JwtService({ secret: SECRET });

  const signIn = (userAgent?: string, ipAddress = '203.0.113.9') =>
    auth.login({ email: EMAIL, password: PASSWORD }, { userAgent, ipAddress }) as Promise<SignedIn>;
  const subjects = async () => {
    await notices.settled();
    return sent.map((email) => email.subject);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    users = new UsersService(ds.getRepository(UserEntity));
    const config = {
      get: (key: string, fallback?: unknown) => (key === 'jwt.refreshSecret' ? 'test-refresh-secret-not-the-access-one' : key === 'jwt.secret' ? SECRET : fallback),
      getOrThrow: () => APP_URL,
    } as unknown as ConfigService;
    notices = new SecurityNoticesService(
      { send: (email: PlatformEmail) => provider(email) } as unknown as PlatformEmailService,
      config,
    );
    auth = new AuthService(
      users,
      jwt,
      config,
      new SessionsService(ds.getRepository(AuthSessionEntity)),
      new AuthEventsService(ds.getRepository(AuthEventEntity)),
      { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
      {} as PreAuthService,
      { methodsFor: async () => [], hasAnyPasskey: async () => false } as unknown as SecondFactorsService,
      notices,
      { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    sent = [];
    provider = async (email) => {
      sent.push(email);
      return { sent: true } as PlatformEmailResult;
    };
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await users.create({ email: EMAIL, name: 'Person', passwordHash: await bcrypt.hash(PASSWORD, 4) });
  });

  describe('a new device', () => {
    it('is told about, naming the device and address, with links from APP_URL only', async () => {
      await signIn(CHROME_MAC);
      await signIn(SAFARI_IPHONE, '198.51.100.7');

      expect(await subjects()).toEqual(['New sign-in to your Chumbaq account']);
      const [notice] = sent;
      expect(notice.to).toBe(EMAIL);
      expect(notice.text).toContain('Mobile Safari on iOS');
      expect(notice.text).toContain('198.51.100.7');
      expect(notice.text).toContain(`${APP_URL}/forgot-password`);
    });

    it('stays quiet for the same device, even after a browser update or a new address', async () => {
      await signIn(CHROME_MAC, '203.0.113.1');
      await signIn(CHROME_MAC, '203.0.113.2');
      await signIn(CHROME_MAC_NEWER, '203.0.113.3');
      expect(await subjects()).toEqual([]);
    });

    it('stays quiet on an account’s first session, having nothing to compare with', async () => {
      await signIn(SAFARI_IPHONE);
      expect(await subjects()).toEqual([]);
    });

    it('stays quiet when the user agent says nothing it can name', async () => {
      await signIn(CHROME_MAC);
      await signIn('curl/8.7.1');
      await signIn(undefined);
      expect(await subjects()).toEqual([]);
    });

    it('remembers devices whose sessions have ended', async () => {
      const { tokens } = await signIn(CHROME_MAC);
      await auth.logout({
        userId: jwt.decode<{ sub: string }>(tokens.accessToken).sub,
        email: EMAIL,
        sessionId: jwt.decode<{ sid: string }>(tokens.accessToken).sid,
      });
      await signIn(CHROME_MAC);
      expect(await subjects()).toEqual([]);
    });

    it('only compares this account’s own sessions', async () => {
      const other = await users.create({ email: `other${DOMAIN}`, name: 'O', passwordHash: await bcrypt.hash(PASSWORD, 4) });
      await new SessionsService(ds.getRepository(AuthSessionEntity)).create(other.id, { userAgent: SAFARI_IPHONE }, { amr: [], authenticatedAt: null });
      await signIn(CHROME_MAC);
      await signIn(SAFARI_IPHONE);
      expect(await subjects()).toEqual(['New sign-in to your Chumbaq account']);
      // Which sign-in it was about matters: comparing with others' sessions gets this backwards.
      expect(sent[0].text).toContain('Mobile Safari on iOS');
    });

    it('escapes what it was told in the HTML', async () => {
      await signIn(CHROME_MAC);
      await signIn(SAFARI_IPHONE, '<img src=x onerror=alert(1)>');
      await notices.settled();
      expect(sent[0].html).not.toContain('<img');
    });
  });

  describe('never gets in the way', () => {
    it('does not wait for the provider', async () => {
      await signIn(CHROME_MAC);
      let release: (result: PlatformEmailResult) => void = () => undefined;
      provider = () => new Promise((resolve) => (release = resolve));

      await expect(signIn(SAFARI_IPHONE)).resolves.toHaveProperty('tokens');

      await new Promise((resolve) => setTimeout(resolve, 50));
      release({ sent: true } as PlatformEmailResult);
      await notices.settled();
    });

    it('signs in when the provider throws, and when the provider refuses', async () => {
      await signIn(CHROME_MAC);
      provider = async () => {
        throw new Error('provider down');
      };
      await expect(signIn(SAFARI_IPHONE)).resolves.toHaveProperty('tokens');
      await notices.settled();

      provider = async () => ({ sent: false, reason: 'not_configured' }) as PlatformEmailResult;
      await expect(signIn('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).resolves.toHaveProperty('tokens');
      await notices.settled();
    });
  });

  describe('a replayed session', () => {
    it('is told about once, when it is revoked', async () => {
      const { tokens } = await signIn(CHROME_MAC);
      await auth.refresh(tokens.refreshToken);
      await ds.query(`UPDATE auth_sessions SET rotated_at = now() - interval '1 minute'`);

      await expect(auth.refresh(tokens.refreshToken)).rejects.toMatchObject({ status: 401 });
      await expect(auth.refresh(tokens.refreshToken)).rejects.toMatchObject({ status: 401 });

      expect(await subjects()).toEqual(['We ended a Chumbaq session on your account']);
      expect(sent[0].to).toBe(EMAIL);
    });

    it('says nothing for an ordinary refresh or a retry within the grace window', async () => {
      const { tokens } = await signIn(CHROME_MAC);
      await auth.refresh(tokens.refreshToken);
      await auth.refresh(tokens.refreshToken);
      expect(await subjects()).toEqual([]);
    });
  });

  describe('a password', () => {
    const events = { record: async () => undefined } as unknown as AuthEventsService;
    const req = { headers: {}, socket: {} } as never;

    it('changed by its owner is told about', async () => {
      const user = (await users.findByEmail(EMAIL)) as UserEntity;
      await new UsersController(users, events, notices).changePassword(
        user.id,
        { currentPassword: PASSWORD, newPassword: 'another-password' } as never,
        req,
      );
      expect(await subjects()).toEqual(['Your Chumbaq password was changed']);
      expect(sent[0].to).toBe(EMAIL);
    });

    it('is not told about when the current password was wrong', async () => {
      const user = (await users.findByEmail(EMAIL)) as UserEntity;
      await expect(
        new UsersController(users, events, notices).changePassword(
          user.id,
          { currentPassword: 'wrong', newPassword: 'another-password' } as never,
          req,
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(await subjects()).toEqual([]);
    });
  });

  describe('deviceFamily', () => {
    it.each([
      [CHROME_MAC, 'Chrome on Mac OS'],
      [SAFARI_IPHONE, 'Mobile Safari on iOS'],
      ['curl/8.7.1', null],
      [undefined, null],
    ])('%s', (userAgent, expected) => {
      expect(deviceFamily(userAgent)).toBe(expected);
    });
  });
});

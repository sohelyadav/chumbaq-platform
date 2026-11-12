import { ConflictException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { LowerCaseUserEmails1793890000000 } from '../../migrations/1793890000000-LowerCaseUserEmails';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { AccountRecoveryService } from '../auth/account-recovery.service';
import { AuthService, SignedIn } from '../auth/auth.service';
import { ForgotPasswordDto } from '../auth/dto/forgot-password.dto';
import { LoginDto } from '../auth/dto/login.dto';
import { RegisterDto } from '../auth/dto/register.dto';
import { AuthSessionEntity } from '../auth/entities/auth-session.entity';
import { PreAuthService } from '../auth/pre-auth.service';
import { SecondFactorsService } from '../auth/second-factors.service';
import { SessionsService } from '../auth/sessions.service';
import { UserEntity } from './entities/user.entity';
import { UsersService } from './users.service';

const DOMAIN = '@email-case-int.test';
const PASSWORD = 'correct-horse-battery';

/** One account per mailbox, whatever case someone types it in. */
describe('Email addresses are case-insensitive (integration)', () => {
  let ds: DataSource;
  let users: UsersService;
  let auth: AuthService;

  const cleanup = async () => {
    await ds.query(`DELETE FROM auth_events WHERE lower(email) LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE lower(email) LIKE $1`, [`%${DOMAIN}`]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    users = new UsersService(ds.getRepository(UserEntity));
    const jwt = new JwtService({ secret: 'test-secret' });
    auth = new AuthService(
      users,
      jwt,
      { get: (key: string, fallback?: unknown) => (key === 'jwt.refreshSecret' ? 'test-refresh-secret-not-the-access-one' : key === 'jwt.secret' ? 'test-secret' : fallback) } as unknown as ConfigService,
      new SessionsService(ds.getRepository(AuthSessionEntity)),
      new AuthEventsService(ds.getRepository(AuthEventEntity)),
      { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
      { putChallenge: async () => undefined } as unknown as PreAuthService,
      { methodsFor: async () => [], hasAnyPasskey: async () => false } as unknown as SecondFactorsService,
      { inBackground: () => undefined, sessionReplayed: () => undefined } as never,
      { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
  });

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closeIntDb(ds);
  });

  const create = (email: string) =>
    users.create({ email, name: 'Ana', passwordHash: bcrypt.hashSync(PASSWORD, 4) });

  it('stores an address in lower case', async () => {
    const user = await create(` Ana${DOMAIN.toUpperCase()} `);
    expect(user.email).toBe(`ana${DOMAIN}`);
  });

  it('refuses a second account that differs only in case', async () => {
    await create(`ana${DOMAIN}`);
    await expect(create(`ANA${DOMAIN}`)).rejects.toBeInstanceOf(ConflictException);
  });

  it('signs in whatever case the address is typed in', async () => {
    await create(`ana${DOMAIN}`);
    const result = (await auth.login({ email: `Ana${DOMAIN.toUpperCase()}`, password: PASSWORD })) as SignedIn;
    expect(result.tokens.accessToken).toBeTruthy();
  });

  it('counts failed attempts against one address, whatever case each used', async () => {
    await create(`ana${DOMAIN}`);
    for (const email of [`ANA${DOMAIN}`, `ana${DOMAIN}`, `Ana${DOMAIN}`]) {
      await expect(auth.login({ email, password: 'wrong-password' })).rejects.toThrow();
    }
    const events = new AuthEventsService(ds.getRepository(AuthEventEntity));
    expect(await events.recentLoginFailures(`aNa${DOMAIN}`, 15)).toBe(3);
  });

  it('is enforced by the database for a path that forgets', async () => {
    await expect(
      ds.getRepository(UserEntity).insert({ email: `Ana${DOMAIN}`, name: 'Ana', passwordHash: 'x' }),
    ).rejects.toThrow(/CHK_users_email_lower_case/);
  });

  it.each([
    ['login', LoginDto, { password: PASSWORD }],
    ['register', RegisterDto, { password: PASSWORD, name: 'Ana' }],
    ['forgot password', ForgotPasswordDto, {}],
  ])('the %s request arrives lower-cased and trimmed', async (_name, metatype, rest) => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const dto = await pipe.transform(
      { email: `  Ana${DOMAIN.toUpperCase()} `, ...rest },
      { type: 'body', metatype: metatype as never },
    );
    expect(dto.email).toBe(`ana${DOMAIN}`);
  });

  describe('the migration', () => {
    const runUp = async (setup: (run: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>) => {
      const runner = ds.createQueryRunner();
      await runner.startTransaction();
      try {
        await runner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_email_lower_case"`);
        await setup((sql, params) => runner.query(sql, params));
        await new LowerCaseUserEmails1793890000000().up(runner);
        return await runner.query(`SELECT email FROM users WHERE lower(email) LIKE $1 ORDER BY email`, [`%${DOMAIN}`]);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    };
    const insert = (email: string) =>
      [`INSERT INTO users (email, name, password_hash) VALUES ($1, 'A', 'x')`, [email]] as [string, unknown[]];

    it('lower-cases existing addresses and adds the check', async () => {
      const rows = await runUp(async (run) => {
        await run(...insert(`Ana${DOMAIN}`));
        await run(...insert(`bob${DOMAIN}`));
      });
      expect(rows).toEqual([{ email: `ana${DOMAIN}` }, { email: `bob${DOMAIN}` }]);
    });

    it('stops and names the addresses when two accounts would become one', async () => {
      await expect(
        runUp(async (run) => {
          await run(...insert(`Ana${DOMAIN}`));
          await run(...insert(`ana${DOMAIN}`));
        }),
      ).rejects.toThrow(`ana${DOMAIN} (2)`);
      expect(await ds.getRepository(UserEntity).count({ where: { email: `ana${DOMAIN}` } })).toBe(0);
    });
  });
});

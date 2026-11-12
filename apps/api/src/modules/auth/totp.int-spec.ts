import { randomBytes, randomUUID } from 'crypto';
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
import { RecoveryCodeEntity } from './entities/recovery-code.entity';
import { TotpSecretEntity } from './entities/totp-secret.entity';
import { WebauthnCredentialEntity } from './entities/webauthn-credential.entity';
import { REAUTH_REQUIRED_MESSAGE } from './guards/recent-auth.guard';
import { MfaCryptoService } from './mfa-crypto.service';
import { FactorChangeProofService } from './factor-change-proof.service';
import { FACTOR_CHANGE_PROOF, PreAuthService } from './pre-auth.service';
import { RECOVERY_CODE_COUNT, RecoveryCodesService } from './recovery-codes.service';
import { SecondFactorsService } from './second-factors.service';
import { SessionsService } from './sessions.service';
import { hotp, totpStepAt } from './totp';
import { TotpService } from './totp.service';

const SECRET = 'test-secret';
const DOMAIN = '@totp-int.test';
const PASSWORD = 'correct-horse-battery';
const REDIS_DB = 13;

type Handled = Extract<LoginResult, { requiresSecondFactor: true }>;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Written apart from the code under test, as an authenticator app is. */
const decodeBase32 = (text: string) => {
  let bits = '';
  for (const char of text) bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) as string[]).map((byte) => parseInt(byte, 2)));
};

/** Real Postgres and real Redis: the guarantees are conditional UPDATEs and a GETDEL. */
describe('TOTP and recovery codes (integration)', () => {
  let ds: DataSource;
  let auth: AuthService;
  let totp: TotpService;
  let preAuth: PreAuthService;
  let users: UsersService;
  let sessions: SessionsService;
  let redis: Redis;
  let crypto: MfaCryptoService;
  const settings: Record<string, unknown> = {};
  const jwt = new JwtService({ secret: SECRET });
  const sessionIds = new Map<string, string>();
  const notices: string[] = [];

  const makeUser = async (name: string, values: Partial<UserEntity> = {}) => {
    const email = `${name}${DOMAIN}`;
    const user = await users.create({ email, name, passwordHash: await bcrypt.hash(PASSWORD, 4) });
    await ds.getRepository(UserEntity).update(user.id, { emailVerifiedAt: new Date(), ...values });
    const session = await sessions.create(user.id, {}, { amr: ['pwd'], authenticatedAt: new Date() });
    sessionIds.set(user.id, session.sessionId);
    return (await users.findById(user.id)) as UserEntity;
  };
  const principal = (user: UserEntity) => {
    return {
      userId: user.id,
      email: user.email,
      sessionId: sessionIds.get(user.id) as string,
      sessionVersion: user.sessionVersion,
    };
  };
  const proof = async (user: UserEntity) => {
    const who = principal(user);
    await preAuth.putChallenge(FACTOR_CHANGE_PROOF, who.sessionId, '1');
    return who;
  };
  const codeNow = (secret: Buffer, offset = 0) => hotp(secret, totpStepAt(Date.now()) + offset);
  const enrol = async (user: UserEntity) => {
    const { secret } = await totp.setup(await proof(user));
    const raw = decodeBase32(secret);
    // The previous step, so what a test types next is not a replay of this.
    const { recoveryCodes } = await totp.confirm(principal(user), codeNow(raw, -1));
    return { raw, recoveryCodes };
  };
  const passwordStep = async (user: UserEntity) =>
    (await auth.login({ email: user.email, password: PASSWORD })) as Handled;
  const eventsFor = async (email: string) =>
    (await ds.getRepository(AuthEventEntity).find({ where: { email }, order: { createdAt: 'ASC' } })).map(
      (row) => row.type,
    );
  const claims = (signed: SignedIn) =>
    jwt.decode<{ amr: string[]; sid: string; sub: string }>(signed.tokens.accessToken);
  const realSession = async (user: UserEntity) => {
    const { sessionId } = await sessions.create(user.id, {}, { amr: ['pwd'], authenticatedAt: new Date() });
    sessionIds.set(user.id, sessionId);
    return { userId: user.id, email: user.email, sessionId };
  };

  beforeAll(async () => {
    ds = await openIntDb();
    users = new UsersService(ds.getRepository(UserEntity));
    const redisConnection = {
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT as string, 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: REDIS_DB,
    };
    Object.assign(settings, {
      'jwt.secret': SECRET,
      'jwt.refreshSecret': 'test-refresh-secret-not-the-access-one',
      'redis.host': redisConnection.host,
      'redis.port': redisConnection.port,
      'redis.password': redisConnection.password,
      'redis.db': REDIS_DB,
    });
    const config = {
      get: (name: string, fallback?: unknown) => settings[name] ?? fallback,
      getOrThrow: (name: string) => settings[name],
    } as unknown as ConfigService;
    preAuth = new PreAuthService(config);
    redis = new Redis(redisConnection);
    sessions = new SessionsService(ds.getRepository(AuthSessionEntity));
    const events = new AuthEventsService(ds.getRepository(AuthEventEntity));
    crypto = new MfaCryptoService(config);
    const secondFactors = new SecondFactorsService(
      ds.getRepository(WebauthnCredentialEntity),
      ds.getRepository(TotpSecretEntity),
      ds.getRepository(RecoveryCodeEntity),
    );
    auth = new AuthService(
      users,
      jwt,
      config,
      sessions,
      events,
      { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
      preAuth,
      secondFactors,
      { inBackground: () => undefined, sessionReplayed: () => undefined } as never,
      { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
    totp = new TotpService(
      ds.getRepository(TotpSecretEntity),
      new RecoveryCodesService(ds.getRepository(RecoveryCodeEntity), crypto),
      secondFactors,
      crypto,
      users,
      preAuth,
      new FactorChangeProofService(preAuth, sessions, { isUsable: async () => false } as never),
      sessions,
      auth,
      events,
      {
        totpChanged: (_: UserEntity, change: string) => notices.push(`totp ${change}`),
        recoveryCodeUsed: (_: UserEntity, remaining: number) => notices.push(`used, ${remaining} left`),
        recoveryCodesReplaced: () => notices.push('replaced'),
      } as never,
    );
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
    settings['mfa.encryptionKey'] = randomBytes(32).toString('base64');
    notices.length = 0;
    sessionIds.clear();
    await redis.flushdb();
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  });

  describe('setting up', () => {
    it('does not ask for it at sign-in until confirmed', async () => {
      const user = await makeUser('person');
      await totp.setup(await proof(user));

      const result = await auth.login({ email: user.email, password: PASSWORD });
      expect(result).toHaveProperty('tokens');
    });

    it('stores the secret sealed, and gives it out only at setup', async () => {
      const user = await makeUser('person');
      const { secret, uri } = await totp.setup(await proof(user));

      expect(uri).toContain(`secret=${secret}`);
      const [row] = await ds.query(`SELECT secret_ciphertext FROM totp_secrets WHERE user_id = $1`, [user.id]);
      expect(row.secret_ciphertext).toMatch(/^v1\./);
      expect(row.secret_ciphertext).not.toContain(secret);
      expect(JSON.stringify(await totp.status(user.id))).not.toContain(secret);
    });

    it('confirms with a right code, returning codes once and storing only hashes', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user);

      expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
      expect(recoveryCodes[0]).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
      expect(new Set(recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
      const rows = await ds.query(`SELECT code_hash FROM recovery_codes WHERE user_id = $1`, [user.id]);
      expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
      for (const { code_hash: hash } of rows) {
        expect(recoveryCodes.map((code) => code.replace(/-/g, ''))).not.toContain(hash);
      }
      expect(await totp.status(user.id)).toMatchObject({
        totpEnabled: true,
        canEnrolTotp: false,
        recoveryCodesRemaining: RECOVERY_CODE_COUNT,
        methods: ['totp', 'recovery_code'],
      });
      expect(await eventsFor(user.email)).toContain('totp.enabled');
      expect(notices).toEqual(['totp added']);
    });

    it('lets a mistyped code be tried again without confirming again', async () => {
      const user = await makeUser('person');
      const { secret } = await totp.setup(await proof(user));

      await expect(totp.confirm(principal(user), '000000x')).rejects.toThrow('not right');
      expect((await totp.status(user.id)).totpEnabled).toBe(false);

      await totp.confirm(principal(user), codeNow(decodeBase32(secret)));
      expect((await totp.status(user.id)).totpEnabled).toBe(true);
    });

    it('needs a real re-authentication, which a stolen session does not have', async () => {
      const user = await makeUser('person');
      await expect(totp.setup(principal(user))).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);

      const { secret } = await totp.setup(await proof(user));
      await redis.flushdb();
      await expect(totp.confirm(principal(user), codeNow(decodeBase32(secret)))).rejects.toThrow(
        REAUTH_REQUIRED_MESSAGE,
      );
    });

    it('takes no proof from a revoked session, whose access token outlasts it', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const who = await proof(user);
      await sessions.revoke(who.sessionId, user.id);

      await expect(totp.disable(who)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      await expect(totp.regenerateRecoveryCodes(who)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      expect(raw).toHaveLength(20);
      expect((await totp.status(user.id)).totpEnabled).toBe(true);
    });

    it('spends the proof, so one re-authentication changes one thing', async () => {
      const user = await makeUser('person');
      await enrol(user);
      await expect(totp.regenerateRecoveryCodes(principal(user))).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      await expect(totp.disable(principal(user))).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
    });

    it('cannot replace an app already confirmed', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);

      await expect(totp.setup(await proof(user))).rejects.toThrow('already has');
      const signedIn = await totp.verifyTotpSignIn((await passwordStep(user)).handle, codeNow(raw));
      expect(signedIn.tokens.accessToken).toEqual(expect.any(String));
    });

    it('starting again replaces an unconfirmed secret', async () => {
      const user = await makeUser('person');
      const first = await totp.setup(await proof(user));
      const second = await totp.setup(await proof(user));

      await expect(totp.confirm(principal(user), codeNow(decodeBase32(first.secret)))).rejects.toThrow('not right');
      await totp.confirm(principal(user), codeNow(decodeBase32(second.secret)));
    });

    it.each([
      ['an unverified address', { emailVerifiedAt: null }, 'Verify your email'],
      ['a team-managed account', { managedByTeamId: randomUUID() }, 'Set your own password'],
      ['staff, who manage it in the admin app', { isSuperAdmin: true }, 'Manage staff sign-in in the admin app.'],
    ])('is refused for %s', async (_, values, message) => {
      const user = await makeUser('person', values as Partial<UserEntity>);
      await expect(totp.setup(await proof(user))).rejects.toThrow(message);
      expect((await totp.status(user.id)).canEnrolTotp).toBe(false);
    });

    it('is refused with no encryption key, and says it cannot be enrolled', async () => {
      settings['mfa.encryptionKey'] = null;
      const user = await makeUser('person');
      await expect(totp.setup(await proof(user))).rejects.toThrow('not available');
      expect((await totp.status(user.id)).canEnrolTotp).toBe(false);
    });

    it('ends the other sessions when it is added', async () => {
      const user = await makeUser('person');
      const other = await sessions.create(user.id, {}, { amr: ['pwd'], authenticatedAt: new Date() });
      await realSession(user);
      await enrol(user);

      const [row] = await ds.query(`SELECT revoked_at FROM auth_sessions WHERE id = $1`, [other.sessionId]);
      expect(row.revoked_at).toBeInstanceOf(Date);
      const mine = await ds.query(`SELECT revoked_at FROM auth_sessions WHERE id = $1`, [sessionIds.get(user.id)]);
      expect(mine[0].revoked_at).toBeNull();
    });
  });

  /**
   * Confirming and replacing codes check the session under the user-row lock, so a
   * request already past its proof check when staff reset the factors (which ends every
   * session) cannot add a factor after the reset.
   */
  describe('enrolling while the session ends', () => {
    const confirmedFor = async (userId: string) =>
      (await ds.query(`SELECT count(*)::int AS n FROM totp_secrets WHERE user_id = $1 AND confirmed_at IS NOT NULL`, [userId]))[0].n;
    const codesFor = async (userId: string) =>
      (await ds.query(`SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1`, [userId]))[0].n;

    it('refuses to confirm once the session version moved on', async () => {
      const user = await makeUser('person');
      const { secret } = await totp.setup(await proof(user));
      await ds.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [user.id]);

      await expect(totp.confirm(principal(user), codeNow(decodeBase32(secret)))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(await confirmedFor(user.id)).toBe(0);
      expect(await codesFor(user.id)).toBe(0);
    });

    it('refuses to confirm from a session that began before the factors were last reset', async () => {
      const user = await makeUser('person');
      const { secret } = await totp.setup(await proof(user));
      await ds.query(`UPDATE users SET factors_reset_at = now() WHERE id = $1`, [user.id]);

      await expect(totp.confirm(principal(user), codeNow(decodeBase32(secret)))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(await confirmedFor(user.id)).toBe(0);
    });

    it('refuses new recovery codes once the session version moved on', async () => {
      const user = await makeUser('person');
      await enrol(user);
      await proof(user);
      const before = await ds.query(`SELECT code_hash FROM recovery_codes WHERE user_id = $1 ORDER BY code_hash`, [user.id]);
      await ds.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [user.id]);

      await expect(totp.regenerateRecoveryCodes(principal(user))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(
        await ds.query(`SELECT code_hash FROM recovery_codes WHERE user_id = $1 ORDER BY code_hash`, [user.id]),
      ).toEqual(before);
    });
  });

  describe('signing in', () => {
    it('gives no tokens for the password alone', async () => {
      const user = await makeUser('person');
      await enrol(user);

      const step = await passwordStep(user);
      expect(step).not.toHaveProperty('tokens');
      expect(step.methods).toEqual(['totp', 'recovery_code']);
    });

    it('signs in with a right code, and the session records how', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);

      const signedIn = await totp.verifyTotpSignIn((await passwordStep(user)).handle, codeNow(raw));
      expect(claims(signedIn).amr).toEqual(['pwd', 'totp']);
      expect(await eventsFor(user.email)).toContain('login.succeeded');
    });

    it('refuses a wrong code, keeps the handle, and counts it', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const { handle } = await passwordStep(user);

      await expect(totp.verifyTotpSignIn(handle, '000000')).rejects.toThrow(UnauthorizedException);
      const [{ reason }] = await ds.query(
        `SELECT reason FROM auth_events WHERE email = $1 AND type = 'login.failed'`,
        [user.email],
      );
      expect(reason).toBe('totp_failed');

      const signedIn = await totp.verifyTotpSignIn(handle, codeNow(raw));
      expect(signedIn.tokens.accessToken).toEqual(expect.any(String));
    });

    it('takes a code once, even in a second sign-in', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const code = codeNow(raw);

      await totp.verifyTotpSignIn((await passwordStep(user)).handle, code);
      await expect(totp.verifyTotpSignIn((await passwordStep(user)).handle, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('of simultaneous uses of one code, exactly one signs in', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const code = codeNow(raw);
      const handles = await Promise.all([1, 2, 3, 4].map(() => passwordStep(user)));

      const results = await Promise.allSettled(
        handles.map(({ handle }) => totp.verifyTotpSignIn(handle, code)),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('will not accept the code that confirmed the app', async () => {
      const user = await makeUser('person');
      const { secret } = await totp.setup(await proof(user));
      const code = codeNow(decodeBase32(secret));
      await totp.confirm(principal(user), code);

      await expect(totp.verifyTotpSignIn((await passwordStep(user)).handle, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('stops at the limit, for the right code too', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const { handle } = await passwordStep(user);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(totp.verifyTotpSignIn(handle, '000000')).rejects.toThrow(UnauthorizedException);
      }

      await expect(totp.verifyTotpSignIn(handle, codeNow(raw))).rejects.toThrow(HttpException);
      await expect(totp.verifyTotpSignIn(handle, codeNow(raw))).rejects.toMatchObject({ status: 429 });
    });

    it('refuses a code for someone else, and with a handle that has gone', async () => {
      const user = await makeUser('person');
      const other = await makeUser('other');
      const { raw } = await enrol(user);
      await enrol(other);

      await expect(totp.verifyTotpSignIn((await passwordStep(other)).handle, codeNow(raw))).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(totp.verifyTotpSignIn('no-such-handle', codeNow(raw))).rejects.toThrow('expired');
    });

    it('rechecks suspension at the last step', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const { handle } = await passwordStep(user);
      await ds.getRepository(UserEntity).update(user.id, { suspendedAt: new Date() });

      await expect(totp.verifyTotpSignIn(handle, codeNow(raw))).rejects.toThrow(ForbiddenException);
    });

    it('a changed key is an outage, not a wrong code held against the person', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const { handle } = await passwordStep(user);
      settings['mfa.encryptionKey'] = randomBytes(32).toString('base64');

      await expect(totp.verifyTotpSignIn(handle, codeNow(raw))).rejects.toMatchObject({ status: 503 });
      expect(await eventsFor(user.email)).not.toContain('login.failed');
    });

    it('a password change or reset leaves the factor asked for', async () => {
      const user = await makeUser('person');
      await enrol(user);
      await ds.transaction(async (manager) =>
        users.resetPassword(user.id, await bcrypt.hash('another-long-password', 4), manager),
      );

      const step = await auth.login({ email: user.email, password: 'another-long-password' });
      expect(step).toHaveProperty('requiresSecondFactor', true);
    });
  });

  describe('recovery codes', () => {
    it('sign in once each, however the code was copied down, and the owner hears', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user);
      notices.length = 0;

      const signedIn = await totp.verifyRecoverySignIn(
        (await passwordStep(user)).handle,
        ` ${recoveryCodes[0].replace(/-/g, ' ').toUpperCase()} `,
      );
      expect(claims(signedIn).amr).toEqual(['pwd', 'recovery_code']);
      expect(notices).toEqual([`used, ${RECOVERY_CODE_COUNT - 1} left`]);
      expect(await eventsFor(user.email)).toContain('recovery_code.used');

      await expect(
        totp.verifyRecoverySignIn((await passwordStep(user)).handle, recoveryCodes[0]),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('of simultaneous uses of one code, exactly one signs in', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user);
      const handles = await Promise.all([1, 2, 3, 4].map(() => passwordStep(user)));

      const results = await Promise.allSettled(
        handles.map(({ handle }) => totp.verifyRecoverySignIn(handle, recoveryCodes[0])),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it("will not take another account's code, and a wrong one counts", async () => {
      const user = await makeUser('person');
      const other = await makeUser('other');
      await enrol(user);
      const theirs = await enrol(other);

      await expect(
        totp.verifyRecoverySignIn((await passwordStep(user)).handle, theirs.recoveryCodes[0]),
      ).rejects.toThrow(UnauthorizedException);
      expect(await eventsFor(user.email)).toContain('login.failed');
    });

    it('never let staff in, even with codes from before they were staff', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user);
      await ds.getRepository(UserEntity).update(user.id, { isSuperAdmin: true });

      const step = await passwordStep(user);
      expect(step.methods).toEqual(['totp']);
      await expect(totp.verifyRecoverySignIn(step.handle, recoveryCodes[0])).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('stop being offered when the last one is used', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user);
      for (const code of recoveryCodes) {
        await totp.verifyRecoverySignIn((await passwordStep(user)).handle, code);
      }
      expect((await passwordStep(user)).methods).toEqual(['totp']);
    });

    it('regenerating makes the old ones useless, and needs its own proof', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user);
      const fresh = await totp.regenerateRecoveryCodes(await proof(user));

      expect(notices).toContain('replaced');
      await expect(
        totp.verifyRecoverySignIn((await passwordStep(user)).handle, recoveryCodes[0]),
      ).rejects.toThrow(UnauthorizedException);
      await totp.verifyRecoverySignIn((await passwordStep(user)).handle, fresh.recoveryCodes[0]);
    });

    it('cannot be made with no factor to recover', async () => {
      const user = await makeUser('person');
      await expect(totp.regenerateRecoveryCodes(await proof(user))).rejects.toThrow('second factor first');
    });
  });

  describe('a super admin who also holds customer passkeys', () => {
    // The authenticator app is shared with the admin app, where a super admin enrols it.
    // Here their customer passkey is the stronger factor, and a page that asks for a
    // code (phishing) must not be a way round it.
    const addKey = (user: UserEntity, scope: 'customer' | 'staff') =>
      ds.query(
        `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, device_type, backed_up, name, scope)
         VALUES ($1, $2, '\\x00', 'singleDevice', false, 'Key', $3)`,
        [user.id, randomUUID(), scope],
      );
    const staffWithApp = async (name: string) => {
      const user = await makeUser(name);
      const { raw } = await enrol(user);
      await ds.getRepository(UserEntity).update(user.id, { isSuperAdmin: true });
      return { user: (await users.findById(user.id)) as UserEntity, raw };
    };

    it('is offered only the passkey, and a right code does not sign in', async () => {
      const { user, raw } = await staffWithApp('staffkey');
      await addKey(user, 'customer');
      const step = await passwordStep(user);
      expect(step.methods).toEqual(['webauthn']);
      await expect(totp.verifyTotpSignIn(step.handle, codeNow(raw))).rejects.toThrow(UnauthorizedException);
      expect(await eventsFor(user.email)).toContain('login.failed');
      // The handle is still good for the passkey it was meant for.
      expect(await preAuth.peekFor(step.handle, 'customer')).not.toBeNull();
    });

    it('cannot confirm it is them with a code either', async () => {
      const { user, raw } = await staffWithApp('staffreauth');
      await addKey(user, 'customer');
      const who = await realSession(user);
      await expect(totp.reauthWithTotp(who, codeNow(raw))).rejects.toThrow(ForbiddenException);
      expect((await totp.status(user.id)).methods).toEqual(['webauthn']);
    });

    it('keeps the code when their only passkeys are staff ones, which cannot answer here', async () => {
      const { user, raw } = await staffWithApp('staffonlykeys');
      await addKey(user, 'staff');
      const step = await passwordStep(user);
      expect(step.methods).toEqual(['totp']);
      const signed = await totp.verifyTotpSignIn(step.handle, codeNow(raw));
      expect(claims(signed).amr).toEqual(['pwd', 'totp']);
      const who = await realSession(user);
      await expect(totp.reauthWithTotp(who, codeNow(raw, 1))).resolves.toHaveProperty('accessToken');
    });

    it('keeps the code for a tenant with a passkey and an app', async () => {
      const user = await makeUser('tenantboth');
      const { raw } = await enrol(user);
      await addKey(user, 'customer');
      const step = await passwordStep(user);
      expect(step.methods).toEqual(['webauthn', 'totp', 'recovery_code']);
      await expect(totp.verifyTotpSignIn(step.handle, codeNow(raw))).resolves.toHaveProperty('tokens');
    });
  });

  describe('confirming it is you', () => {
    it('refuses a password once there is a factor', async () => {
      const user = await makeUser('person');
      await enrol(user);
      const who = await realSession(user);

      await expect(auth.reauthenticate(who, PASSWORD)).rejects.toThrow('second factor');
    });

    it('takes a code, moves the time, and leaves the proof a change needs', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const who = await realSession(user);

      const { accessToken } = await totp.reauthWithTotp(who, codeNow(raw));
      expect(jwt.decode<{ amr: string[] }>(accessToken).amr).toEqual(['pwd', 'totp']);

      await totp.disable(who);
      expect((await totp.status(user.id)).totpEnabled).toBe(false);
    });

    it('answers a wrong code with 403, and counts it', async () => {
      const user = await makeUser('person');
      await enrol(user);
      const who = await realSession(user);

      await expect(totp.reauthWithTotp(who, '000000')).rejects.toThrow(ForbiddenException);
      expect(await eventsFor(user.email)).toContain('login.failed');
      await expect(totp.disable(who)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
    });

    it('takes a recovery code, so a lost phone can be removed', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user);
      const who = await realSession(user);

      const { accessToken } = await totp.reauthWithRecoveryCode(who, recoveryCodes[0]);
      expect(jwt.decode<{ amr: string[] }>(accessToken).amr).toEqual(['pwd', 'recovery_code']);
      await expect(totp.reauthWithRecoveryCode(who, recoveryCodes[0])).rejects.toThrow(ForbiddenException);

      await totp.disable(who);
      expect(await totp.status(user.id)).toMatchObject({ totpEnabled: false, recoveryCodesRemaining: 0 });
      expect(notices).toContain('totp removed');
      expect(await auth.login({ email: user.email, password: PASSWORD })).toHaveProperty('tokens');
    });

    it('does not take a session that has been revoked', async () => {
      const user = await makeUser('person');
      const { raw } = await enrol(user);
      const who = await realSession(user);
      await sessions.revoke(who.sessionId, user.id);

      await expect(totp.reauthWithTotp(who, codeNow(raw))).rejects.toThrow(UnauthorizedException);
    });
  });
});

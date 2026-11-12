import { randomBytes, randomUUID } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { FakeAuthenticator, FakeAuthenticatorOptions } from '../../test-support/fake-authenticator';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import type { AccountRecoveryService } from './account-recovery.service';
import { AuthService, LoginResult, SignedIn } from './auth.service';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { RecoveryCodeEntity } from './entities/recovery-code.entity';
import { TotpSecretEntity } from './entities/totp-secret.entity';
import { WebauthnCredentialEntity } from './entities/webauthn-credential.entity';
import { MfaCryptoService } from './mfa-crypto.service';
import { MAX_PASSKEYS_PER_USER, PasskeysService } from './passkeys.service';
import { FactorChangeProofService } from './factor-change-proof.service';
import { RECOVERY_CODE_COUNT, RecoveryCodesService } from './recovery-codes.service';
import { TotpService } from './totp.service';
import { FACTOR_CHANGE_PROOF, PRE_AUTH_TTL_SECONDS, PreAuthService } from './pre-auth.service';
import type { SecurityNoticesService } from '../platform-email/security-notices.service';
import { MIN_SUPER_ADMIN_PASSKEYS, SecondFactorsService } from './second-factors.service';
import { REAUTH_REQUIRED_MESSAGE } from './guards/recent-auth.guard';
import { SessionsService } from './sessions.service';
import { resetSuperAdminPasskeys } from '../../scripts/super-admin';
import { STAFF_KEEP_CUSTOMER_FACTOR_MESSAGE, STAFF_KEYS_ONLY_MESSAGE } from '../staff-auth/staff-messages';

const SECRET = 'test-secret';
const DOMAIN = '@passkeys-int.test';
const PASSWORD = 'correct-horse-battery';
const RP_ID = 'dashboard.test';
const ORIGIN = 'https://dashboard.test';
const REDIS_DB = 14;

type Signed = Extract<LoginResult, { tokens: unknown }>;
type Handled = Extract<LoginResult, { requiresSecondFactor: true }>;

/**
 * Real Postgres, real Redis, the real verification library and real signatures from a
 * software authenticator. Nothing about WebAuthn is stubbed.
 */
describe('Passkeys (integration)', () => {
  let ds: DataSource;
  let auth: AuthService;
  let passkeys: PasskeysService;
  let totp: TotpService;
  let preAuth: PreAuthService;
  let sessions: SessionsService;
  let users: UsersService;
  let redis: Redis;
  let settings: Record<string, unknown>;
  const jwt = new JwtService({ secret: SECRET });
  const sessionIds = new Map<string, string>();
  const sent: { to: string; subject: string }[] = [];

  const key = (options: Partial<FakeAuthenticatorOptions> = {}) =>
    new FakeAuthenticator({ rpId: RP_ID, origin: ORIGIN, ...options });
  const claims = (token: string) => jwt.decode<{ amr: string[]; auth_time?: number; sid: string; sub: string }>(token);

  const makeUser = async (name: string, values: Partial<UserEntity> = {}) => {
    const email = `${name}${DOMAIN}`;
    const user = await users.create({ email, name, passwordHash: await bcrypt.hash(PASSWORD, 4) });
    await ds.getRepository(UserEntity).update(user.id, { emailVerifiedAt: new Date(), ...values });
    return (await users.findById(user.id)) as UserEntity;
  };
  const principalOf = (accessToken: string, email: string) => ({
    userId: claims(accessToken).sub,
    email,
    sessionId: claims(accessToken).sid,
  });
  /** A session that has just really re-authenticated, as enrolling and removing need. */
  const proof = async (user: UserEntity) => {
    const sessionId =
      sessionIds.get(user.id) ??
      (await sessions.create(user.id, {}, { amr: ['pwd'], authenticatedAt: new Date() })).sessionId;
    sessionIds.set(user.id, sessionId);
    await preAuth.putChallenge(FACTOR_CHANGE_PROOF, sessionId, '1');
    // As `JwtStrategy` builds it, with the version the session's token carries.
    return { userId: user.id, email: user.email, sessionId, sessionVersion: user.sessionVersion };
  };
  const enrol = async (user: UserEntity, authenticator: FakeAuthenticator) => {
    const options = await passkeys.registrationOptions(await proof(user));
    return passkeys.register(
      await proof(user),
      authenticator.register(options.challenge, options.user.id),
      'My key',
    );
  };
  const passwordStep = async (user: UserEntity) =>
    (await auth.login({ email: user.email, password: PASSWORD })) as Handled;
  const secondFactor = async (user: UserEntity, authenticator: FakeAuthenticator) => {
    const { handle } = await passwordStep(user);
    const options = await passkeys.secondFactorOptions(handle);
    return { handle, options, response: authenticator.assert(options.challenge) };
  };
  const passwordless = async (authenticator: FakeAuthenticator) => {
    const { flowId, options } = await passkeys.passwordlessOptions();
    return { flowId, response: authenticator.assert(options.challenge) };
  };
  const eventsFor = async (email: string) =>
    (await ds.getRepository(AuthEventEntity).find({ where: { email }, order: { createdAt: 'ASC' } })).map(
      (row) => row.type,
    );

  beforeAll(async () => {
    ds = await openIntDb();
    users = new UsersService(ds.getRepository(UserEntity));
    const redisConnection = {
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT as string, 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: REDIS_DB,
    };
    settings = {};
    const config = {
      get: (name: string, fallback?: unknown) => settings[name] ?? fallback,
      getOrThrow: (name: string) => settings[name],
    } as unknown as ConfigService;
    settings = {
      'jwt.secret': SECRET,
      'jwt.refreshSecret': 'test-refresh-secret-not-the-access-one',
      'redis.host': redisConnection.host,
      'redis.port': redisConnection.port,
      'redis.password': redisConnection.password,
      'redis.db': REDIS_DB,
      'app.appUrl': ORIGIN,
      'webauthn.rpId': RP_ID,
      'webauthn.rpName': 'Test',
      'webauthn.origins': [ORIGIN],
    };
    preAuth = new PreAuthService(config);
    redis = new Redis(redisConnection);
    sessions = new SessionsService(ds.getRepository(AuthSessionEntity));
    const events = new AuthEventsService(ds.getRepository(AuthEventEntity));
    const credentials = ds.getRepository(WebauthnCredentialEntity);
    auth = new AuthService(
      users,
      jwt,
      config,
      sessions,
      events,
      { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
      preAuth,
      new SecondFactorsService(
        credentials,
        ds.getRepository(TotpSecretEntity),
        ds.getRepository(RecoveryCodeEntity),
      ),
      { inBackground: () => undefined, sessionReplayed: () => undefined } as never,
      { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
    const proofs = new FactorChangeProofService(preAuth, sessions, { isUsable: async () => false } as never);
    const crypto = new MfaCryptoService(config);
    const recoveryCodes = new RecoveryCodesService(ds.getRepository(RecoveryCodeEntity), crypto);
    const secondFactors = new SecondFactorsService(
      credentials,
      ds.getRepository(TotpSecretEntity),
      ds.getRepository(RecoveryCodeEntity),
    );
    const notices = {
      passkeyChanged: (user: UserEntity, change: string) => {
        sent.push({ to: user.email, subject: `A passkey was ${change} on your Chumbaq account` });
      },
      recoveryCodeUsed: () => undefined,
      recoveryCodesReplaced: () => undefined,
      totpChanged: () => undefined,
    } as unknown as SecurityNoticesService;
    passkeys = new PasskeysService(
      credentials,
      users,
      preAuth,
      proofs,
      sessions,
      auth,
      events,
      config,
      notices,
      recoveryCodes,
      crypto,
    );
    totp = new TotpService(
      ds.getRepository(TotpSecretEntity),
      recoveryCodes,
      secondFactors,
      crypto,
      users,
      preAuth,
      proofs,
      sessions,
      auth,
      events,
      notices,
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
    settings['webauthn.forTenants'] = true;
    settings['mfa.encryptionKey'] = randomBytes(32).toString('base64');
    sent.length = 0;
    settings['webauthn.superAdminAllowSynced'] = false;
    settings['webauthn.superAdminPasskeyRequired'] = false;
    await redis.flushdb();
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  });

  describe('enrolling', () => {
    it('stores the key, its public half only, and records it', async () => {
      const user = await makeUser('person');
      const summary = await enrol(user, key());

      expect(summary).toMatchObject({ name: 'My key', deviceType: 'singleDevice', backedUp: false });
      expect(summary).not.toHaveProperty('publicKey');
      expect(await eventsFor(user.email)).toContain('passkey.added');
    });

    it('is shut for tenants until the flag is on', async () => {
      settings['webauthn.forTenants'] = false;
      const user = await makeUser('person');
      await expect(passkeys.registrationOptions(await proof(user))).rejects.toMatchObject({ status: 403 });
      expect((await passkeys.list(user.id)).canEnrol).toBe(false);
    });

    it('refuses an unverified address, which could be a stranger planting a factor', async () => {
      const user = await makeUser('person', { emailVerifiedAt: null });
      await expect(passkeys.registrationOptions(await proof(user))).rejects.toMatchObject({ status: 403 });
    });

    it('refuses a team-created account, whose team admin knows the password', async () => {
      const user = await makeUser('person');
      Object.assign(user, { managedByTeamId: '77777777-7777-7777-7777-777777777777' });
      jest.spyOn(users, 'findById').mockResolvedValueOnce(user);
      await expect(passkeys.registrationOptions(await proof(user))).rejects.toMatchObject({ status: 403 });
    });

    it('rechecks the rule at the second step, not only the first', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      const options = await passkeys.registrationOptions(await proof(user));
      settings['webauthn.forTenants'] = false;
      await expect(
        passkeys.register(await proof(user), authenticator.register(options.challenge, options.user.id), 'x'),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('lets a super admin enrol with no verified email and no flag', async () => {
      settings['webauthn.forTenants'] = false;
      const admin = await makeUser('admin', { isSuperAdmin: true, emailVerifiedAt: null });
      await expect(enrol(admin, key())).resolves.toBeDefined();
    });

    it('refuses a synced key for a super admin, unless allowed', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      await expect(enrol(admin, key({ synced: true }))).rejects.toMatchObject({ status: 400 });
      settings['webauthn.superAdminAllowSynced'] = true;
      await expect(enrol(admin, key({ synced: true }))).resolves.toMatchObject({ backedUp: true });
    });

    it('accepts a synced key for a tenant', async () => {
      const user = await makeUser('person');
      await expect(enrol(user, key({ synced: true }))).resolves.toMatchObject({ deviceType: 'multiDevice' });
    });

    it('refuses a super admin key that does not verify the user', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      await expect(enrol(admin, key({ verifiesUser: false }))).rejects.toMatchObject({ status: 400 });
    });

    it('refuses another origin, the check that defeats a phishing site', async () => {
      const user = await makeUser('person');
      const options = await passkeys.registrationOptions(await proof(user));
      await expect(
        passkeys.register(
          await proof(user),
          key().register(options.challenge, options.user.id, 'https://evil.test'),
          'x',
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('refuses another site’s RP ID', async () => {
      const user = await makeUser('person');
      const options = await passkeys.registrationOptions(await proof(user));
      await expect(
        passkeys.register(
          await proof(user),
          key({ rpId: 'evil.test' }).register(options.challenge, options.user.id),
          'x',
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('spends the challenge, so a response cannot be replayed', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      const options = await passkeys.registrationOptions(await proof(user));
      const response = authenticator.register(options.challenge, options.user.id);
      await passkeys.register(await proof(user), response, 'x');
      await expect(passkeys.register(await proof(user), response, 'x')).rejects.toMatchObject({ status: 400 });
    });

    it('refuses a made-up challenge', async () => {
      const user = await makeUser('person');
      const options = await passkeys.registrationOptions(await proof(user));
      await expect(
        passkeys.register(await proof(user), key().register('wrong', options.user.id), 'x'),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('stops at the limit', async () => {
      const user = await makeUser('person');
      for (let i = 0; i < MAX_PASSKEYS_PER_USER; i++) await enrol(user, key());
      await expect(passkeys.registrationOptions(await proof(user))).rejects.toMatchObject({ status: 409 });
    });

    it('asks each authenticator not to register twice', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const options = await passkeys.registrationOptions(await proof(user));
      expect(options.excludeCredentials?.map((c) => c.id)).toEqual([authenticator.credentialId]);
    });
  });

  /**
   * Whoever holds a stolen key and a live session can keep sending registration
   * requests. One that passed its session check before `admin:passkeys-reset` committed
   * must not insert a key after it, or the reset is undone.
   */
  describe('enrolling while staff reset the keys', () => {
    const lockWaiters = async (): Promise<number> =>
      (
        await ds.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
      )[0].n;
    const untilWaiters = async (n: number) => {
      for (let i = 0; i < 200 && (await lockWaiters()) < n; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await lockWaiters()).toBeGreaterThanOrEqual(n);
    };
    const keysOf = (userId: string) => ds.getRepository(WebauthnCredentialEntity).countBy({ userId });

    it('refuses a key whose request waited on the user row while the reset committed', async () => {
      const admin = await makeUser('race-admin', { isSuperAdmin: true });
      await enrol(admin, key());
      const principal = await proof(admin);
      const options = await passkeys.registrationOptions(principal);
      const response = key().register(options.challenge, options.user.id);

      const holder = ds.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [admin.id]);
        const reset = resetSuperAdminPasskeys(ds, admin.email, null, () => undefined);
        await untilWaiters(1);
        // Passes its proof and session checks now, while the session is still live.
        // Caught now, so its refusal is not reported as unhandled while the reset is awaited.
        const enrolment = passkeys.register(principal, response, 'Planted').catch((error: unknown) => error);
        await untilWaiters(2);
        await holder.commitTransaction();

        await expect(reset).resolves.toBe(1);
        expect(await enrolment).toBeInstanceOf(UnauthorizedException);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
      }
      expect(await keysOf(admin.id)).toBe(0);
    });

    it('refuses a key when the session ended while the request was on its way', async () => {
      const user = await makeUser('person');
      const principal = await proof(user);
      const options = await passkeys.registrationOptions(principal);
      const response = key().register(options.challenge, options.user.id);
      const revoke = jest
        .spyOn(users, 'findByIdForUpdate')
        .mockImplementationOnce(async (id, manager) => {
          // Signed out on another device between the proof check and the insert.
          await ds.query(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1`, [principal.sessionId]);
          return UsersService.prototype.findByIdForUpdate.call(users, id, manager);
        });

      await expect(passkeys.register(principal, response, 'x')).rejects.toBeInstanceOf(UnauthorizedException);
      revoke.mockRestore();
      expect(await keysOf(user.id)).toBe(0);
    });

    it('refuses a key from a session that began before the factors were last reset', async () => {
      const user = await makeUser('person');
      const principal = await proof(user);
      const options = await passkeys.registrationOptions(principal);
      await ds.query(`UPDATE users SET factors_reset_at = now() WHERE id = $1`, [user.id]);

      await expect(
        passkeys.register(principal, key().register(options.challenge, options.user.id), 'x'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await keysOf(user.id)).toBe(0);
    });
  });

  describe('recovery codes come with a tenant\'s first key', () => {
    const codeCount = async (user: UserEntity) =>
      (await ds.query(`SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1`, [user.id]))[0].n;

    it('gives them once, with the first key and not the second', async () => {
      const user = await makeUser('person');

      const first = await enrol(user, key());
      expect(first.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
      expect(await codeCount(user)).toBe(RECOVERY_CODE_COUNT);

      const second = await enrol(user, key());
      expect(second).not.toHaveProperty('recoveryCodes');
      expect((await passkeys.list(user.id)).passkeys[0]).not.toHaveProperty('recoveryCodes');
    });

    it('offers them at sign-in, and one gets in with the key lost', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user, key());

      const step = await passwordStep(user);
      expect(step.methods).toEqual(['webauthn', 'recovery_code']);

      const signedIn = await totp.verifyRecoverySignIn(step.handle, recoveryCodes?.[0] as string);
      expect(claims(signedIn.tokens.accessToken).amr).toEqual(['pwd', 'recovery_code']);
    });

    it('lets a lost key be removed with a recovery code, ending with a password alone', async () => {
      const user = await makeUser('person');
      const added = await enrol(user, key());
      const { step, sessionId } = await (async () => {
        const first = await passwordStep(user);
        const signedIn = await totp.verifyRecoverySignIn(first.handle, added.recoveryCodes?.[0] as string);
        return { step: first, sessionId: claims(signedIn.tokens.accessToken).sid };
      })();
      expect(step.handle).toEqual(expect.any(String));
      const who = { userId: user.id, email: user.email, sessionId };

      await totp.reauthWithRecoveryCode(who, added.recoveryCodes?.[1] as string);
      await passkeys.remove(who, added.id);

      expect(await codeCount(user)).toBe(0);
      expect(await auth.login({ email: user.email, password: PASSWORD })).toHaveProperty('tokens');
    });

    it('leaves codes alone when removing a key still leaves one', async () => {
      const user = await makeUser('person');
      const first = await enrol(user, key());
      await enrol(user, key());

      await passkeys.remove(await proof(user), first.id);

      expect(await codeCount(user)).toBe(RECOVERY_CODE_COUNT);
    });

    it('does not replace codes someone already saved', async () => {
      const user = await makeUser('person');
      await ds.query(
        `INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, 'kept')`,
        [user.id],
      );

      expect(await enrol(user, key())).not.toHaveProperty('recoveryCodes');
      expect(await codeCount(user)).toBe(1);
    });

    it('makes a new set if every earlier code has been used', async () => {
      const user = await makeUser('person');
      await ds.query(
        `INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES ($1, 'spent', now())`,
        [user.id],
      );

      expect((await enrol(user, key())).recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    });

    it('never gives them to staff', async () => {
      const user = await makeUser('person', { isSuperAdmin: true });
      expect(await enrol(user, key())).not.toHaveProperty('recoveryCodes');
      expect(await codeCount(user)).toBe(0);
      expect((await totp.status(user.id)).canManageRecoveryCodes).toBe(false);
    });

    it('is shut for tenants with no encryption key, since no codes could be made, but not staff', async () => {
      settings['mfa.encryptionKey'] = undefined;
      const tenant = await makeUser('person');
      await expect(enrol(tenant, key())).rejects.toThrow('not available');
      expect((await passkeys.list(tenant.id)).canEnrol).toBe(false);

      await enrol(await makeUser('staff', { isSuperAdmin: true }), key());
    });

    it('leaves no key behind if the codes cannot be made', async () => {
      const user = await makeUser('person');
      const options = await passkeys.registrationOptions(await proof(user));
      const response = key().register(options.challenge, options.user.id);
      const replace = jest
        .spyOn(RecoveryCodesService.prototype, 'replace')
        .mockRejectedValueOnce(new Error('database away'));

      await expect(passkeys.register(await proof(user), response, 'My key')).rejects.toThrow('database away');
      replace.mockRestore();

      expect((await passkeys.list(user.id)).passkeys).toEqual([]);
      expect(await auth.login({ email: user.email, password: PASSWORD })).toHaveProperty('tokens');
    });

    it('lets a passkey-only tenant make new ones', async () => {
      const user = await makeUser('person');
      const { recoveryCodes } = await enrol(user, key());
      expect((await totp.status(user.id)).canManageRecoveryCodes).toBe(true);

      const fresh = await totp.regenerateRecoveryCodes(await proof(user));

      expect(fresh.recoveryCodes).not.toContain(recoveryCodes?.[0]);
      await expect(
        totp.verifyRecoverySignIn((await passwordStep(user)).handle, recoveryCodes?.[0] as string),
      ).rejects.toThrow('not right');
    });
  });

  describe('changing factors needs a real proof, not just a recent sign-in', () => {
    const noProof = (user: UserEntity) => ({ userId: user.id, email: user.email, sessionId: randomUUID() });

    it('refuses a stolen token at every step, however fresh, asking for the prompt', async () => {
      const user = await makeUser('person');
      const { id } = await enrol(user, key());
      const stolen = noProof(user);

      await expect(passkeys.registrationOptions(stolen)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      await expect(passkeys.register(stolen, key().register('x', 'y'), 'n')).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      await expect(passkeys.remove(stolen, id)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      expect((await passkeys.list(user.id)).passkeys).toHaveLength(1);
    });

    it('refuses a token with no session', async () => {
      const user = await makeUser('person');
      await expect(passkeys.registrationOptions({ userId: user.id, email: user.email })).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
    });

    it('is spent by the change it permitted', async () => {
      const user = await makeUser('person');
      const principal = await proof(user);
      const authenticator = key();
      const options = await passkeys.registrationOptions(principal);
      const { id } = await passkeys.register(principal, authenticator.register(options.challenge, options.user.id), 'x');

      await expect(passkeys.remove(principal, id)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
    });

    it('is left by a real password re-authentication, and only by that', async () => {
      const user = await makeUser('person');
      const { tokens } = (await auth.login({ email: user.email, password: PASSWORD })) as SignedIn;
      const principal = principalOf(tokens.accessToken, user.email);

      await expect(passkeys.registrationOptions(principal)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      await expect(auth.reauthenticate(principal, 'wrong-password')).rejects.toMatchObject({ status: 403 });
      await expect(passkeys.registrationOptions(principal)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);

      await auth.reauthenticate(principal, PASSWORD);
      await expect(passkeys.registrationOptions(principal)).resolves.toBeDefined();
    });

    it('dies with its session, whose access token outlasts it', async () => {
      const user = await makeUser('person');
      const principal = await proof(user);
      const authenticator = key();
      const options = await passkeys.registrationOptions(principal);
      await sessions.revoke(principal.sessionId, user.id);

      await expect(passkeys.registrationOptions(principal)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      await expect(
        passkeys.register(principal, authenticator.register(options.challenge, options.user.id), 'x'),
      ).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      expect((await passkeys.list(user.id)).passkeys).toEqual([]);
    });

    it('belongs to one session', async () => {
      const user = await makeUser('person');
      await proof(user);
      await expect(passkeys.registrationOptions(noProof(user))).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
    });

    it('ends the other sessions and tells the owner, when adding and when removing', async () => {
      const user = await makeUser('person');
      const first = (await auth.login({ email: user.email, password: PASSWORD })) as SignedIn;
      const second = (await auth.login({ email: user.email, password: PASSWORD })) as SignedIn;
      const current = principalOf(first.tokens.accessToken, user.email);

      await auth.reauthenticate(current, PASSWORD);
      const options = await passkeys.registrationOptions(current);
      const { id } = await passkeys.register(current, key().register(options.challenge, options.user.id), 'Mine');

      await expect(auth.refresh(second.tokens.refreshToken)).rejects.toMatchObject({ status: 401 });
      const keep = await auth.refresh(first.tokens.refreshToken);
      expect(keep.accessToken).toBeDefined();
      expect(sent.map((email) => [email.to, email.subject])).toEqual([[user.email, 'A passkey was added on your Chumbaq account']]);

      await preAuth.putChallenge(FACTOR_CHANGE_PROOF, current.sessionId, '1');
      await passkeys.remove(current, id);
      expect(sent[1].subject).toBe('A passkey was removed on your Chumbaq account');
    });
  });

  describe('removing', () => {
    it('removes only the owner’s key', async () => {
      const user = await makeUser('person');
      const other = await makeUser('other');
      const { id } = await enrol(user, key());

      await expect(passkeys.remove(await proof(other), id)).rejects.toMatchObject({ status: 404 });
      await passkeys.remove(await proof(user), id);
      expect((await passkeys.list(user.id)).passkeys).toHaveLength(0);
      expect(await eventsFor(user.email)).toContain('passkey.removed');
    });

    // The two-key minimum is for staff keys, kept by the admin app (staff-auth.int-spec.ts).
    // A super admin's customer keys sign in to the customer app only, so they are held only
    // to keeping one factor there.
    it('holds a super admin\'s customer keys to no staff minimum, and never touches staff keys', async () => {
      settings['webauthn.superAdminPasskeyRequired'] = true;
      const admin = await makeUser('admin', { isSuperAdmin: true });
      const first = await enrol(admin, key());
      const second = await enrol(admin, key());
      const third = await enrol(admin, key());
      await ds.query(`UPDATE webauthn_credentials SET scope = 'staff' WHERE id = $1`, [first.id]);

      expect((await passkeys.list(admin.id)).passkeys.map((p) => p.id)).toEqual([second.id, third.id]);
      await expect(passkeys.remove(await proof(admin), first.id)).rejects.toMatchObject({ status: 404 });
      await passkeys.remove(await proof(admin), second.id);
      const [{ left }] = await ds.query(`SELECT count(*)::int AS left FROM webauthn_credentials WHERE user_id = $1`, [admin.id]);
      expect(left).toBe(2);
    });

    it('never leaves a super admin with no factor in the customer app', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      const staffKey = await enrol(admin, key());
      const customerKey = await enrol(admin, key());
      await ds.query(`UPDATE webauthn_credentials SET scope = 'staff' WHERE id = $1`, [staffKey.id]);

      // The staff key does not count: it cannot answer the customer app.
      await expect(passkeys.remove(await proof(admin), customerKey.id)).rejects.toMatchObject({
        status: 409,
        message: STAFF_KEEP_CUSTOMER_FACTOR_MESSAGE,
      });
      expect((await passkeys.list(admin.id)).passkeys).toHaveLength(1);
      expect(await passwordStep(admin)).toMatchObject({ requiresSecondFactor: true, methods: ['webauthn'] });
    });

    it('lets a super admin remove their last key while an authenticator app remains', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      const { id } = await enrol(admin, key());
      await ds.query(
        `INSERT INTO totp_secrets (user_id, secret_ciphertext, confirmed_at) VALUES ($1, 'x', now())`,
        [admin.id],
      );
      await passkeys.remove(await proof(admin), id);
      expect(await passwordStep(admin)).toMatchObject({ requiresSecondFactor: true, methods: ['totp'] });
    });

    it('still lets a tenant remove their last key', async () => {
      const user = await makeUser('person');
      const { id } = await enrol(user, key());
      await expect(passkeys.remove(await proof(user), id)).resolves.toBeUndefined();
    });

    it('waits for the user row, so simultaneous removals cannot each see room', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      await enrol(admin, key());
      const { id } = await enrol(admin, key());
      const principal = await proof(admin);
      // Not FOR UPDATE: that would also block the event row's foreign key check, and so
      // make the removal wait even with no lock of its own.
      const holder = ds.createQueryRunner();
      await holder.startTransaction();
      await holder.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [admin.id]);

      let finished = false;
      const removal = passkeys.remove(principal, id).then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const whileHeld = finished;

      await holder.commitTransaction();
      await holder.release();
      await removal;

      expect(whileHeld).toBe(false);
      expect(finished).toBe(true);
    });

    it('allows it when passkeys are not required and a key remains', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      await enrol(admin, key());
      const { id } = await enrol(admin, key());
      await expect(passkeys.remove(await proof(admin), id)).resolves.toBeUndefined();
    });

    it('puts the account back to a password alone', async () => {
      const user = await makeUser('person');
      const { id } = await enrol(user, key());
      await passkeys.remove(await proof(user), id);
      await expect(auth.login({ email: user.email, password: PASSWORD })).resolves.toHaveProperty('tokens');
    });
  });

  describe('as a second factor', () => {
    it('refuses a password alone when the account\'s only keys are staff ones', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      const { id } = await enrol(admin, key());
      await ds.query(`UPDATE webauthn_credentials SET scope = 'staff' WHERE id = $1`, [id]);

      await expect(auth.login({ email: admin.email, password: PASSWORD })).rejects.toMatchObject({
        status: 403,
        message: STAFF_KEYS_ONLY_MESSAGE,
      });
      expect(await eventsFor(admin.email)).not.toContain('login.succeeded');
      const principal = await proof(admin);
      await expect(auth.reauthenticate(principal, PASSWORD)).rejects.toMatchObject({
        status: 403,
        message: STAFF_KEYS_ONLY_MESSAGE,
      });
    });

    it('asks a super admin with staff keys for the shared authenticator app', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      const { id } = await enrol(admin, key());
      await ds.query(`UPDATE webauthn_credentials SET scope = 'staff' WHERE id = $1`, [id]);
      await ds.query(
        `INSERT INTO totp_secrets (user_id, secret_ciphertext, confirmed_at) VALUES ($1, 'x', now())`,
        [admin.id],
      );
      expect(await passwordStep(admin)).toMatchObject({ requiresSecondFactor: true, methods: ['totp'] });
    });

    it('keeps asking a super admin for keys made before the admin split', async () => {
      // The scope migration made every existing key a customer one, so these still guard
      // the customer app; the admin app asks an operator for admin:staff-enrolment.
      const admin = await makeUser('admin', { isSuperAdmin: true });
      await enrol(admin, key());
      const [{ scope }] = await ds.query(`SELECT scope FROM webauthn_credentials WHERE user_id = $1`, [admin.id]);
      expect(scope).toBe('customer');
      expect(await passwordStep(admin)).toMatchObject({ requiresSecondFactor: true, methods: ['webauthn'] });
    });

    it('makes a correct password ask for the key', async () => {
      const user = await makeUser('person');
      await enrol(user, key());
      const result = await auth.login({ email: user.email, password: PASSWORD });
      expect(result).toMatchObject({
        requiresSecondFactor: true,
        methods: ['webauthn', 'recovery_code'],
      });
      expect(result).not.toHaveProperty('tokens');
    });

    it('signs in, and the session records both proofs', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const { handle, response } = await secondFactor(user, authenticator);

      const { tokens } = await passkeys.verifySecondFactor(handle, response);

      expect(claims(tokens.accessToken).amr).toEqual(['pwd', 'webauthn']);
    });

    it('asks only for this account’s keys', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const other = await makeUser('other');
      await enrol(other, key());
      const { options } = await secondFactor(user, authenticator);
      expect(options.allowCredentials?.map((c) => c.id)).toEqual([authenticator.credentialId]);
    });

    it('refuses someone else’s genuine key, and counts it', async () => {
      const user = await makeUser('person');
      await enrol(user, key());
      const other = await makeUser('other');
      const theirs = key();
      await enrol(other, theirs);
      const { handle, options } = await (async () => {
        const { handle: h } = await passwordStep(user);
        return { handle: h, options: await passkeys.secondFactorOptions(h) };
      })();

      await expect(passkeys.verifySecondFactor(handle, theirs.assert(options.challenge))).rejects.toMatchObject({ status: 401 });
      expect(await eventsFor(user.email)).toContain('login.failed');
    });

    it('accepts a touch alone for a tenant, since the password was the first factor', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      Object.assign((authenticator as unknown as { options: object }).options, { verifiesUser: false });
      const { handle, response } = await secondFactor(user, authenticator);
      await expect(passkeys.verifySecondFactor(handle, response)).resolves.toBeDefined();
    });

    it('requires user verification for a super admin', async () => {
      const admin = await makeUser('admin', { isSuperAdmin: true });
      const authenticator = key();
      await enrol(admin, authenticator);
      Object.assign((authenticator as unknown as { options: object }).options, { verifiesUser: false });
      const { handle, response } = await secondFactor(admin, authenticator);
      await expect(passkeys.verifySecondFactor(handle, response)).rejects.toMatchObject({ status: 401 });
    });

    it('lets someone try again after a failure, with a new challenge', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const { handle, options } = await secondFactor(user, authenticator);
      const stranger = authenticator.assert('not-the-challenge');
      await expect(passkeys.verifySecondFactor(handle, stranger)).rejects.toMatchObject({ status: 401 });

      await expect(passkeys.verifySecondFactor(handle, authenticator.assert(options.challenge))).rejects.toMatchObject({ status: 401 });

      const fresh = await passkeys.secondFactorOptions(handle);
      await expect(passkeys.verifySecondFactor(handle, authenticator.assert(fresh.challenge))).resolves.toBeDefined();
    });

    it('stops at the sign-in limit', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const { handle } = await passwordStep(user);
      for (let i = 0; i < 10; i++) {
        await passkeys.secondFactorOptions(handle);
        await passkeys.verifySecondFactor(handle, authenticator.assert('wrong')).catch(() => undefined);
      }
      await expect(passkeys.secondFactorOptions(handle)).rejects.toMatchObject({ status: 429 });
    });

    it('refuses a counter that goes backwards, the mark of a cloned key', async () => {
      const user = await makeUser('person');
      const authenticator = key({ counting: true });
      await enrol(user, authenticator);
      const first = await secondFactor(user, authenticator);
      await passkeys.verifySecondFactor(first.handle, first.response);

      authenticator.counter = 0;
      const second = await secondFactor(user, authenticator);
      await expect(passkeys.verifySecondFactor(second.handle, second.response)).rejects.toMatchObject({ status: 401 });
    });

    it('lets one of two simultaneous uses of the same count through', async () => {
      const user = await makeUser('person');
      const authenticator = key({ counting: true });
      await enrol(user, authenticator);
      const flows = await Promise.all([passkeys.passwordlessOptions(), passkeys.passwordlessOptions()]);
      const responses = flows.map(({ options }) => {
        authenticator.counter = 4;
        return authenticator.assert(options.challenge);
      });

      const results = await Promise.allSettled(
        flows.map(({ flowId }, i) => passkeys.verifyPasswordless(flowId, responses[i])),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('keeps working with a synced key, whose counter stays at zero', async () => {
      const user = await makeUser('person');
      const authenticator = key({ synced: true });
      await enrol(user, authenticator);
      for (let i = 0; i < 2; i++) {
        const { handle, response } = await secondFactor(user, authenticator);
        await expect(passkeys.verifySecondFactor(handle, response)).resolves.toBeDefined();
      }
    });
  });

  describe('signing in with no password', () => {
    it('records a passkey that verified the user', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const { flowId, response } = await passwordless(authenticator);

      const { tokens } = (await passkeys.verifyPasswordless(flowId, response)) as Signed;

      expect(claims(tokens.accessToken).amr).toEqual(['webauthn', 'uv']);
      expect(claims(tokens.accessToken).auth_time).toBeDefined();
    });

    it('refuses a key that only proved presence, since nothing else was shown', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      Object.assign((authenticator as unknown as { options: object }).options, { verifiesUser: false });
      const { flowId, response } = await passwordless(authenticator);
      await expect(passkeys.verifyPasswordless(flowId, response)).rejects.toMatchObject({ status: 401 });
    });

    it('asks the browser for any key, naming nobody', async () => {
      const { options } = await passkeys.passwordlessOptions();
      expect(options.allowCredentials ?? []).toEqual([]);
      expect(options.userVerification).toBe('required');
    });

    it('refuses a user handle that does not match the key’s owner', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      authenticator.userHandle = Buffer.from('someone-else').toString('base64url');
      const { flowId, response } = await passwordless(authenticator);
      await expect(passkeys.verifyPasswordless(flowId, response)).rejects.toMatchObject({ status: 401 });
    });

    it('refuses an unknown key, a replay and an unknown flow', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);

      const unknown = await passwordless(key());
      await expect(passkeys.verifyPasswordless(unknown.flowId, unknown.response)).rejects.toMatchObject({ status: 401 });

      const { flowId, response } = await passwordless(authenticator);
      await passkeys.verifyPasswordless(flowId, response);
      await expect(passkeys.verifyPasswordless(flowId, response)).rejects.toMatchObject({ status: 401 });
      await expect(passkeys.verifyPasswordless('made-up', response)).rejects.toMatchObject({ status: 401 });
    });

    it('refuses a suspended account, after the proof', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      await ds.getRepository(UserEntity).update(user.id, { suspendedAt: new Date() });
      const { flowId, response } = await passwordless(authenticator);
      await expect(passkeys.verifyPasswordless(flowId, response)).rejects.toMatchObject({ status: 403 });
    });

    it('does not count failures towards the owner’s password limit', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      Object.assign((authenticator as unknown as { options: object }).options, { verifiesUser: false });
      for (let i = 0; i < 10; i++) {
        const { flowId, response } = await passwordless(authenticator);
        await passkeys.verifyPasswordless(flowId, response).catch(() => undefined);
      }
      await expect(passwordStep(user)).resolves.toHaveProperty('handle');
    });
  });

  describe('browser autofill', () => {
    const autofill = async (authenticator: FakeAuthenticator) => {
      const offer = await passkeys.autofillOptions();
      if (!offer.available) throw new Error('autofill was not offered');
      return { flowId: offer.flowId, response: authenticator.assert(offer.options.challenge) };
    };

    it('signs in through the same flow as the button, once per offer', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const { flowId, response } = await autofill(authenticator);

      const { tokens } = (await passkeys.verifyPasswordless(flowId, response)) as Signed;

      expect(claims(tokens.accessToken).amr).toEqual(['webauthn', 'uv']);
      await expect(passkeys.verifyPasswordless(flowId, response)).rejects.toMatchObject({ status: 401 });
    });

    it('asks for any key with the user verified, and gives up when the challenge does', async () => {
      const offer = await passkeys.autofillOptions();
      if (!offer.available) throw new Error('autofill was not offered');
      expect(offer.options.allowCredentials ?? []).toEqual([]);
      expect(offer.options.userVerification).toBe('required');
      expect(offer.options.timeout).toBe(PRE_AUTH_TTL_SECONDS * 1000);
    });

    it('leaves the button’s own timeout alone', async () => {
      const { options } = await passkeys.passwordlessOptions();
      expect(options.timeout).not.toBe(PRE_AUTH_TTL_SECONDS * 1000);
    });

    it('keeps the same rules: a suspended account and a presence-only key are refused', async () => {
      const suspended = await makeUser('suspended');
      const suspendedKey = key();
      await enrol(suspended, suspendedKey);
      await ds.getRepository(UserEntity).update(suspended.id, { suspendedAt: new Date() });
      const first = await autofill(suspendedKey);
      await expect(passkeys.verifyPasswordless(first.flowId, first.response)).rejects.toMatchObject({ status: 403 });

      const user = await makeUser('person');
      const touchOnly = key();
      await enrol(user, touchOnly);
      Object.assign((touchOnly as unknown as { options: object }).options, { verifiesUser: false });
      const second = await autofill(touchOnly);
      await expect(passkeys.verifyPasswordless(second.flowId, second.response)).rejects.toMatchObject({ status: 401 });
      expect(await eventsFor(user.email)).toContain('passkey.failed');
    });

    it.each([
      ['the tenant flag is off', () => (settings['webauthn.forTenants'] = false)],
      ['there is no encryption key', () => (settings['mfa.encryptionKey'] = undefined)],
    ])('is not offered when %s, and leaves no challenge behind', async (_name, close) => {
      close();
      await redis.flushdb();

      expect(await passkeys.autofillOptions()).toEqual({ available: false });
      expect(await redis.dbsize()).toBe(0);
    });
  });

  describe('a password reset', () => {
    it('never removes a key: the next sign-in still asks for it', async () => {
      const user = await makeUser('person');
      await enrol(user, key());
      await users.resetPassword(user.id, await bcrypt.hash('another-password', 4), ds.manager);

      const result = await auth.login({ email: user.email, password: 'another-password' });

      expect(result).toMatchObject({ requiresSecondFactor: true });
    });
  });

  describe('re-authenticating', () => {
    const session = async (user: UserEntity, authenticator: FakeAuthenticator) => {
      const { handle, response } = await secondFactor(user, authenticator);
      const { tokens } = (await passkeys.verifySecondFactor(handle, response)) as SignedIn;
      await ds.query(`UPDATE auth_sessions SET authenticated_at = now() - interval '3 hours' WHERE id = $1`, [claims(tokens.accessToken).sid]);
      return principalOf(tokens.accessToken, user.email);
    };

    it('moves the time with a passkey', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const principal = await session(user, authenticator);

      const options = await passkeys.reauthOptions(principal);
      const { accessToken } = await passkeys.verifyReauth(principal, authenticator.assert(options.challenge));

      expect(Math.floor(Date.now() / 1000) - (claims(accessToken).auth_time as number)).toBeLessThan(5);
      expect(claims(accessToken).amr).toEqual(['pwd', 'webauthn']);
    });

    it('adds a passkey to a session that started with only a password', async () => {
      const user = await makeUser('person');
      const signedIn = (await auth.login({ email: user.email, password: PASSWORD })) as SignedIn;
      const principal = principalOf(signedIn.tokens.accessToken, user.email);
      const authenticator = key();
      sessionIds.set(user.id, principal.sessionId);
      await enrol(user, authenticator);

      const options = await passkeys.reauthOptions(principal);
      const { accessToken } = await passkeys.verifyReauth(principal, authenticator.assert(options.challenge));

      expect(claims(accessToken).amr).toEqual(['pwd', 'webauthn']);
    });

    it('will not take a password once the account has a passkey', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const principal = await session(user, authenticator);

      await expect(auth.reauthenticate(principal, PASSWORD)).rejects.toMatchObject({ status: 403 });
    });

    it('refuses someone else’s key with 403, keeping the session', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const other = await makeUser('other');
      const theirs = key();
      await enrol(other, theirs);
      const principal = await session(user, authenticator);

      const options = await passkeys.reauthOptions(principal);
      await expect(passkeys.verifyReauth(principal, theirs.assert(options.challenge))).rejects.toMatchObject({ status: 403 });
    });

    it('refuses without a fresh challenge', async () => {
      const user = await makeUser('person');
      const authenticator = key();
      await enrol(user, authenticator);
      const principal = await session(user, authenticator);
      await expect(passkeys.verifyReauth(principal, authenticator.assert('anything'))).rejects.toMatchObject({ status: 403 });
    });
  });
});

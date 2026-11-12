import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import {
  issuePasswordResetLink,
  resetAccountFactors,
  resetSuperAdminPasskeys,
  setSuperAdmin,
} from '../../scripts/super-admin';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminTenantsService } from '../admin/admin-tenants.service';
import { SeatsService } from '../project-access/seats.service';
import { AdminAuditLogEntity } from '../admin/entities/admin-audit-log.entity';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { AccountRecoveryService } from '../auth/account-recovery.service';
import { AccountTokensService } from '../auth/account-tokens.service';
import { AccountTokenEntity } from '../auth/entities/account-token.entity';
import { AuthService } from '../auth/auth.service';
import { AuthSessionEntity } from '../auth/entities/auth-session.entity';
import type { PreAuthService } from '../auth/pre-auth.service';
import type { SecondFactorsService } from '../auth/second-factors.service';
import { SessionsService } from '../auth/sessions.service';
import type { SecurityNoticesService } from '../platform-email/security-notices.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { cancelAllRequestedBy, lockResetTargetsOf } from './cancel-requested-by';
import { FactorResetEntity } from './entities/factor-reset.entity';
import { FactorResetActor, FactorResetsService } from './factor-resets.service';

const DOMAIN = '@factor-reset-int.test';
const PASSWORD = 'correct-horse-battery';
const REASON = 'Lost phone and every recovery code';
const VERIFIED = {
  verificationMethod: 'video_call',
  verificationNotes: 'Video call, face matched the passport shown',
} as const;
const CLI_VERIFIED = { method: 'government_id', notes: 'Passport checked in person' } as const;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Real Postgres throughout, because what is being proved is the conditional UPDATEs and
 * the partial unique index: which of two racing requests, workers or cancels wins is
 * decided by the database, and a stub could only agree with whatever the code assumed.
 * Email is the only stub, so the notices sent can be read back.
 */
describe('FactorResetsService (integration)', () => {
  let ds: DataSource;
  let resets: FactorResetsService;
  let auth: AuthService;
  let sessions: SessionsService;
  let tokens: AccountTokensService;
  let recovery: AccountRecoveryService;
  let staff: FactorResetActor;
  /** The stubbed security notices; each one sent is pushed onto `notices`. */
  let fakeNotices: SecurityNoticesService;
  const notices: string[] = [];
  /** Runs while the staff link notice is being sent, as Brevo is awaited. */
  const duringLinkNotice: { run: ((user: UserEntity) => Promise<void>) | null } = { run: null };
  /** The second factors the stubbed `methodsFor` reports for every account. */
  const factorMethods: { list: string[] } = { list: ['totp'] };
  /** What the stubbed account email does: whether it is set up, and whether a send works. */
  const email = { configured: true, delivers: true };
  const settings: Record<string, unknown> = {
    'jwt.secret': 'factor-reset-int-secret',
    'jwt.refreshSecret': 'factor-reset-int-refresh-secret',
    'app.appUrl': 'https://app.chumbaq.test',
  };
  const config = {
    get: (name: string, fallback?: unknown) => settings[name] ?? fallback,
    getOrThrow: (name: string) => settings[name],
  } as unknown as ConfigService;

  const makeUser = async (name: string, values: Partial<UserEntity> = {}): Promise<UserEntity> => {
    const id = randomUUID();
    await ds.getRepository(UserEntity).insert({
      id,
      email: `${name}${DOMAIN}`,
      name,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      ...values,
    });
    return ds.getRepository(UserEntity).findOneByOrFail({ id });
  };
  const addTotp = (userId: string, confirmed = true) =>
    ds.query(
      `INSERT INTO totp_secrets (user_id, secret_ciphertext, confirmed_at) VALUES ($1, 'x', $2)`,
      [userId, confirmed ? new Date() : null],
    );
  const addPasskey = (userId: string) =>
    ds.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, name, device_type, backed_up)
       VALUES ($1, $2, '\\x00', 0, 'key', 'singleDevice', false)`,
      [userId, randomUUID()],
    );
  const addRecoveryCode = (userId: string) =>
    ds.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, randomUUID()]);
  /** Staff who may ask for a reset: a super admin holding a key, as `request` needs. */
  const makeStaff = async (name: string) => {
    const user = await makeUser(name, { isSuperAdmin: true });
    await addPasskey(user.id);
    return user;
  };
  const lockedOut = async (name: string) => {
    const user = await makeUser(name);
    await addTotp(user.id);
    await addPasskey(user.id);
    await addRecoveryCode(user.id);
    return user;
  };
  const countOf = async (table: string, userId: string, extra = '') =>
    (await ds.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1 ${extra}`, [userId]))[0].n;
  const resetsOf = (userId: string) =>
    ds.getRepository(FactorResetEntity).find({ where: { userId }, order: { requestedAt: 'ASC' } });
  const auditOf = async (userId: string) =>
    ds.query(
      `SELECT actor_id, actor_email, action, target_type, reason, metadata, ip_address
         FROM admin_audit_logs WHERE target_id = $1 ORDER BY created_at, id`,
      [userId],
    );
  /**
   * Whether another backend is waiting on a lock the backend `holderPid` holds. Asked on
   * a pool connection, outside the holder's transaction, which would keep reading the
   * statistics snapshot it took the first time.
   */
  const waitingOnLock = async (holderPid: number) =>
    (
      await ds.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))`,
        [holderPid],
      )
    )[0].n > 0;
  const eventsOf = async (userId: string) =>
    (
      await ds.getRepository(AuthEventEntity).find({ where: { userId }, order: { createdAt: 'ASC' } })
    )
      .filter((row) => row.type.startsWith('factors_reset'))
      .map((row) => `${row.type}:${row.reason}`);
  const sessionVersion = async (userId: string) =>
    (await ds.query(`SELECT session_version FROM users WHERE id = $1`, [userId]))[0].session_version;
  /** Moves the confirmed warning back past the whole delay, as if the wait were over. */
  const makeDue = (userId: string) =>
    ds.query(
      `UPDATE factor_resets
          SET notice_sent_at = now() - interval '72 hours 1 minute',
              execute_after = now() - interval '1 minute'
        WHERE user_id = $1 AND status = 'pending'`,
      [userId],
    );

  const cleanUp = async () => {
    await ds.query(
      `DELETE FROM admin_audit_logs WHERE target_label LIKE $1 OR actor_email LIKE $1`,
      [`%${DOMAIN}`],
    );
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  /** The stubbed sign-in step's handles, as `PreAuthService` keeps them in Redis. */
  const handles = new Map<string, unknown>();

  beforeAll(async () => {
    ds = await openIntDb();
    const users = new UsersService(ds.getRepository(UserEntity));
    const events = new AuthEventsService(ds.getRepository(AuthEventEntity));
    sessions = new SessionsService(ds.getRepository(AuthSessionEntity));
    fakeNotices = {
      canSend: () => email.configured,
      sendFactorResetRequested: async (user: UserEntity, at: Date) => {
        notices.push(`requested ${user.email} ${at.toISOString()}`);
        return email.delivers;
      },
      factorResetCancelled: (user: UserEntity) => notices.push(`cancelled ${user.email}`),
      factorsReset: (user: UserEntity) => notices.push(`reset ${user.email}`),
      sendStaffResetLinkIssued: async (user: UserEntity) => {
        notices.push(`link issued ${user.email}`);
        await duringLinkNotice.run?.(user);
        return email.delivers;
      },
      staffResetLinkCancelled: (user: UserEntity) => notices.push(`link cancelled ${user.email}`),
      inBackground: () => undefined,
    } as never;
    resets = new FactorResetsService(
      ds.getRepository(FactorResetEntity),
      events,
      fakeNotices,
      config,
    );
    tokens = new AccountTokensService(ds.getRepository(AccountTokenEntity));
    recovery = new AccountRecoveryService(
      users,
      tokens,
      sessions,
      { send: async () => ({ sent: true }) } as never,
      events,
      config,
      resets,
    );
    auth = new AuthService(
      users,
      new JwtService({ secret: settings['jwt.secret'] as string }),
      config,
      sessions,
      events,
      { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
      {
        create: async (state: unknown) => {
          const handle = randomUUID();
          handles.set(handle, state);
          return handle;
        },
        consume: async (handle: string) => {
          const state = handles.get(handle) ?? null;
          handles.delete(handle);
          return state;
        },
        // Every handle here is a customer one.
        consumeFor: async (handle: string) => {
          const state = handles.get(handle) ?? null;
          handles.delete(handle);
          return state;
        },
        putChallenge: async () => undefined,
      } as unknown as PreAuthService,
      { methodsFor: async () => factorMethods.list, hasAnyPasskey: async () => false } as unknown as SecondFactorsService,
      { inBackground: () => undefined } as never,
      resets, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
  });

  beforeEach(async () => {
    notices.length = 0;
    duringLinkNotice.run = null;
    factorMethods.list = ['totp'];
    email.configured = true;
    email.delivers = true;
    await cleanUp();
    const admin = await makeStaff('staff');
    staff = { userId: admin.id, email: admin.email, ipAddress: '203.0.113.9' };
  });

  // A test that times out never reaches its own `finally`: its spy would stay in place
  // and wrap the next test's, each holding the last, until a failure ran out of memory
  // instead of reporting what broke.
  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await cleanUp();
    await closeIntDb(ds);
  });

  const hashOf = async (userId: string) =>
    (await ds.getRepository(UserEntity).findOneByOrFail({ id: userId })).passwordHash;
  describe('requesting', () => {
    // Email is what a takeover would hold, so staff must say how else they checked.
    it.each([
      ['no verification at all', {}],
      ['no method', { verificationNotes: VERIFIED.verificationNotes }],
      ['email as the method', { ...VERIFIED, verificationMethod: 'email' }],
      ['no notes', { verificationMethod: VERIFIED.verificationMethod }],
      ['notes under 10 characters once trimmed', { ...VERIFIED, verificationNotes: '   on call     ' }],
    ])('refuses %s, writing and sending nothing', async (_, options) => {
      const user = await lockedOut('owner');

      await expect(resets.request(user.id, REASON, staff, options as never)).rejects.toThrow(BadRequestException);
      expect(await resetsOf(user.id)).toEqual([]);
      expect(await auditOf(user.id)).toEqual([]);
      expect(notices).toEqual([]);
    });

    it('waits the default 72 hours, audits, records and emails the owner at once', async () => {
      const user = await lockedOut('owner');

      const before = Date.now();
      const state = await resets.request(user.id, REASON, staff, VERIFIED);

      expect(state.hasFactors).toBe(true);
      const [row] = await resetsOf(user.id);
      expect(row).toMatchObject({ status: 'pending', requestedById: staff.userId, reason: REASON });
      const wait = row.executeAfter.getTime() - before;
      expect(wait).toBeGreaterThan(72 * HOUR_MS - 60_000);
      expect(wait).toBeLessThan(72 * HOUR_MS + 60_000);
      expect(row.noticeSentAt).toBeInstanceOf(Date);
      expect(state.pending).toEqual({
        id: row.id,
        requestedAt: row.requestedAt.toISOString(),
        executeAfter: row.executeAfter.toISOString(),
        requestedByEmail: staff.email,
        reason: REASON,
        noticeSentAt: row.noticeSentAt!.toISOString(),
        passwordResetOverride: null,
        verificationMethod: VERIFIED.verificationMethod,
        verificationNotes: VERIFIED.verificationNotes,
      });
      expect(row).toMatchObject(VERIFIED);

      expect(await auditOf(user.id)).toEqual([
        {
          actor_id: staff.userId,
          actor_email: staff.email,
          action: 'account.factors_reset_requested',
          target_type: 'tenant',
          reason: REASON,
          metadata: {
            resetId: row.id,
            executeAfter: expect.any(String),
            lastPasswordResetAt: null,
            passwordResetOverride: null,
            verificationMethod: VERIFIED.verificationMethod,
            verificationNotes: VERIFIED.verificationNotes,
          },
          ip_address: '203.0.113.9',
        },
      ]);
      expect(await eventsOf(user.id)).toEqual(['factors_reset.requested:staff']);
      expect(notices).toHaveLength(1);
      const [sentTo, promised] = notices[0].replace(/^requested /, '').split(' ');
      expect(sentTo).toBe(user.email);
      // The wait runs from the confirmed send, so the time the owner was promised is
      // never later than when it actually happens.
      const early = row.executeAfter.getTime() - new Date(promised).getTime();
      expect(early).toBeGreaterThanOrEqual(0);
      expect(early).toBeLessThan(5_000);
      // The wait is measured from the confirmed warning.
      expect(row.executeAfter.getTime() - row.noticeSentAt!.getTime()).toBe(72 * HOUR_MS);
      // Nothing is removed yet.
      expect(await countOf('totp_secrets', user.id)).toBe(1);
      expect(await countOf('webauthn_credentials', user.id)).toBe(1);
    });

    it('takes its delay from FACTOR_RESET_DELAY_HOURS', async () => {
      settings.FACTOR_RESET_DELAY_HOURS = '1';
      try {
        const quick = new FactorResetsService(
          ds.getRepository(FactorResetEntity),
          new AuthEventsService(ds.getRepository(AuthEventEntity)),
          { canSend: () => true, sendFactorResetRequested: async () => true } as never,
          config,
        );
        const user = await lockedOut('owner');
        await quick.request(user.id, REASON, staff, VERIFIED);
        const [row] = await resetsOf(user.id);
        const wait = row.executeAfter.getTime() - row.requestedAt.getTime();
        expect(Math.abs(wait - HOUR_MS)).toBeLessThan(5_000);
      } finally {
        delete settings.FACTOR_RESET_DELAY_HOURS;
      }
    });

    it('refuses a super admin and writes nothing', async () => {
      const admin = await makeUser('other-staff', { isSuperAdmin: true });
      await addPasskey(admin.id);

      await expect(resets.request(admin.id, REASON, staff, VERIFIED)).rejects.toThrow(ConflictException);
      expect(await resetsOf(admin.id)).toEqual([]);
      expect(await auditOf(admin.id)).toEqual([]);
      expect(notices).toEqual([]);
    });

    it.each([
      ['nothing at all', async (_: string) => undefined],
      ['an unconfirmed authenticator', (id: string) => addTotp(id, false)],
      ['recovery codes alone', addRecoveryCode],
    ])('refuses an account with %s, since its password already signs in', async (_, seed) => {
      const user = await makeUser('owner');
      await seed(user.id);

      await expect(resets.request(user.id, REASON, staff, VERIFIED)).rejects.toThrow(
        'This account has no second factors to reset.',
      );
      expect(await resetsOf(user.id)).toEqual([]);
      expect((await resets.adminState(user.id)).hasFactors).toBe(false);
    });

    it('accepts a passkey alone as a factor', async () => {
      const user = await makeUser('owner');
      await addPasskey(user.id);
      await expect(resets.request(user.id, REASON, staff, VERIFIED)).resolves.toMatchObject({ hasFactors: true });
    });

    it('404s for an unknown account', async () => {
      await expect(resets.request(randomUUID(), REASON, staff, VERIFIED)).rejects.toThrow(NotFoundException);
      await expect(resets.adminState(randomUUID())).rejects.toThrow(NotFoundException);
    });

    it('allows one pending reset per account, and another once that one is cancelled', async () => {
      const user = await lockedOut('owner');
      await resets.request(user.id, REASON, staff, VERIFIED);

      await expect(resets.request(user.id, REASON, staff, VERIFIED)).rejects.toThrow(
        'A reset is already waiting for this account.',
      );
      await resets.cancelByStaff(user.id, staff);
      await resets.request(user.id, REASON, staff, VERIFIED);

      expect((await resetsOf(user.id)).map((row) => row.status)).toEqual(['cancelled', 'pending']);
    });

    it('lets only one of two simultaneous requests through', async () => {
      const user = await lockedOut('owner');

      const results = await Promise.allSettled([
        resets.request(user.id, REASON, staff, VERIFIED),
        resets.request(user.id, REASON, staff, VERIFIED),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect(await resetsOf(user.id)).toHaveLength(1);
      expect((await auditOf(user.id)).filter((r: { action: string }) => r.action === 'account.factors_reset_requested')).toHaveLength(1);
    });

    it('holds one pending row per user in the database itself', async () => {
      const user = await lockedOut('owner');
      await resets.request(user.id, REASON, staff, VERIFIED);

      await expect(
        ds.query(
          `INSERT INTO factor_resets (user_id, requested_by_email, reason, execute_after)
           VALUES ($1, 'x', 'y', now())`,
          [user.id],
        ),
      ).rejects.toThrow(/UQ_factor_resets_pending_user/);
    });
  });

  describe('cancelling', () => {
    it('by the owner: audited in their name, recorded and emailed', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      notices.length = 0;

      await resets.cancelByOwner({ userId: user.id, email: user.email }, { ipAddress: '198.51.100.4' });

      const [row] = await resetsOf(user.id);
      expect(row).toMatchObject({ status: 'cancelled', cancelledBy: 'owner', completedAt: null });
      expect(row.cancelledAt).toBeInstanceOf(Date);
      expect((await auditOf(user.id))[1]).toEqual({
        actor_id: user.id,
        actor_email: user.email,
        action: 'account.factors_reset_cancelled',
        target_type: 'tenant',
        reason: null,
        metadata: { resetId: pending!.id, cancelledBy: 'owner' },
        ip_address: '198.51.100.4',
      });
      expect(await eventsOf(user.id)).toEqual([
        'factors_reset.requested:staff',
        'factors_reset.cancelled:owner',
      ]);
      expect(notices).toEqual([`cancelled ${user.email}`]);
      expect(await resets.ownerState(user.id)).toEqual({ pending: null });
    });

    it('by the owner with nothing pending is a 404 and changes nothing', async () => {
      const user = await lockedOut('owner');
      await expect(resets.cancelByOwner({ userId: user.id, email: user.email })).rejects.toThrow(
        NotFoundException,
      );
      expect(await auditOf(user.id)).toEqual([]);
      expect(notices).toEqual([]);
    });

    it('by staff, returning the new state', async () => {
      const user = await lockedOut('owner');
      await resets.request(user.id, REASON, staff, VERIFIED);

      await expect(resets.cancelByStaff(user.id, staff)).resolves.toEqual({
        hasFactors: true,
        pending: null,
        lastPasswordResetAt: null,
        emailConfigured: true,
      });
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'staff' });
      expect((await auditOf(user.id))[1]).toMatchObject({
        actor_id: staff.userId,
        action: 'account.factors_reset_cancelled',
      });

      await expect(resets.cancelByStaff(user.id, staff)).rejects.toThrow(ConflictException);
      await expect(resets.cancelByStaff(randomUUID(), staff)).rejects.toThrow(NotFoundException);
    });

    it('shows the owner only when it happens, never who asked or why', async () => {
      const user = await lockedOut('owner');
      await resets.request(user.id, REASON, staff, VERIFIED);

      const state = await resets.ownerState(user.id);
      expect(Object.keys(state.pending!).sort()).toEqual(['executeAfter', 'requestedAt']);
    });
  });

  describe('a sign-in with a second factor during the wait', () => {
    const pendingFor = async (user: UserEntity) => resets.request(user.id, REASON, staff, VERIFIED);

    it('cancels it when signing in with a passkey', async () => {
      const user = await lockedOut('owner');
      await pendingFor(user);

      await auth.signInWithPasskey(user);

      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'sign_in' });
      expect(await eventsOf(user.id)).toContain('factors_reset.cancelled:sign_in');
    });

    it('cancels it when re-authenticating with a factor', async () => {
      const user = await lockedOut('owner');
      const { sessionId } = await sessions.create(user.id, {}, { amr: ['pwd', 'totp'], authenticatedAt: new Date() });
      await pendingFor(user);

      await auth.issueReauthenticatedToken(user, sessionId, 'totp');

      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'sign_in' });
    });

    it('does not cancel it for a password alone', async () => {
      const user = await lockedOut('owner');
      const { sessionId } = await sessions.create(user.id, {}, { amr: ['pwd'], authenticatedAt: new Date() });
      await pendingFor(user);

      // The password step of a sign-in that still needs its factor.
      await expect(auth.login({ email: user.email, password: PASSWORD })).resolves.toMatchObject({
        requiresSecondFactor: true,
      });
      await auth.issueReauthenticatedToken(user, sessionId, undefined);

      expect((await resetsOf(user.id))[0].status).toBe('pending');
    });

    it('with nothing pending writes nothing', async () => {
      const user = await lockedOut('owner');
      await expect(auth.signInWithPasskey(user)).resolves.not.toHaveProperty('factorResetPending');
      expect(await auditOf(user.id)).toEqual([]);
      expect(notices).toEqual([]);
    });

    /** What Postgres throws when it aborts one side of a deadlock. */
    const deadlock = () =>
      new QueryFailedError('UPDATE factor_resets', [], Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    /** Fails the cancel's transaction `times` times (every time if omitted), as a deadlock would. */
    const failCancel = (times?: number) => {
      const spy = jest.spyOn(resets as unknown as { cancelWithin: () => Promise<unknown> }, 'cancelWithin');
      if (times === undefined) spy.mockRejectedValue(deadlock());
      else for (let i = 0; i < times; i += 1) spy.mockRejectedValueOnce(deadlock());
      return spy;
    };

    it('tries again when the cancel is aborted, so the sign-in still stops it', async () => {
      const user = await lockedOut('owner');
      await pendingFor(user);
      const spy = failCancel(2);
      try {
        await expect(auth.signInWithPasskey(user)).resolves.not.toHaveProperty('factorResetPending');
      } finally {
        spy.mockRestore();
      }
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'sign_in' });
    });

    it('when the cancel keeps failing, says so to the client, and the worker refuses the reset later', async () => {
      const user = await lockedOut('owner');
      const { pending } = await pendingFor(user);
      const spy = failCancel();
      try {
        await expect(auth.signInWithPasskey(user)).resolves.toMatchObject({ factorResetPending: true });
        const { sessionId } = await sessions.create(user.id, {}, { amr: ['pwd', 'totp'], authenticatedAt: new Date() });
        await expect(auth.issueReauthenticatedToken(user, sessionId, 'totp')).resolves.toMatchObject({
          factorResetPending: true,
        });
      } finally {
        spy.mockRestore();
      }
      expect((await resetsOf(user.id))[0].status).toBe('pending');
      await makeDue(user.id);
      notices.length = 0;

      await expect(resets.execute(pending!.id)).resolves.toBe(false);

      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'sign_in' });
      expect(await countOf('totp_secrets', user.id)).toBe(1);
      expect((await auditOf(user.id)).at(-1)).toMatchObject({
        action: 'account.factors_reset_cancelled',
        actor_id: null,
        metadata: { resetId: pending!.id, cancelledBy: 'sign_in' },
      });
      expect(await eventsOf(user.id)).toContain('factors_reset.cancelled:sign_in');
      expect(notices).toEqual([`cancelled ${user.email}`]);
    });

    it('does not let a sign-in from before the request stop it', async () => {
      const user = await lockedOut('owner');
      await auth.signInWithPasskey(user);
      const { pending } = await pendingFor(user);
      await makeDue(user.id);

      await expect(resets.execute(pending!.id)).resolves.toBe(true);
    });
  });

  describe('carrying it out', () => {
    it('does nothing before the delay has passed', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);

      await expect(resets.execute(pending!.id)).resolves.toBe(false);
      await expect(resets.executeDue()).resolves.toBe(0);
      expect(await countOf('totp_secrets', user.id)).toBe(1);
      expect((await resetsOf(user.id))[0].status).toBe('pending');
    });

    it('removes every factor and session as the CLI does, audits in the requester\'s name, and emails', async () => {
      const user = await lockedOut('owner');
      await sessions.create(user.id, {}, { amr: ['pwd'], authenticatedAt: new Date() });
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      notices.length = 0;
      const version = await sessionVersion(user.id);

      await expect(resets.executeDue()).resolves.toBe(1);

      expect(await countOf('totp_secrets', user.id)).toBe(0);
      expect(await countOf('webauthn_credentials', user.id)).toBe(0);
      expect(await countOf('recovery_codes', user.id)).toBe(0);
      expect(await countOf('auth_sessions', user.id, 'AND revoked_at IS NULL')).toBe(0);
      expect(await sessionVersion(user.id)).toBe(version + 1);
      const [row] = await resetsOf(user.id);
      expect(row).toMatchObject({ status: 'completed', cancelledBy: null });
      expect(row.completedAt).toBeInstanceOf(Date);
      expect((await auditOf(user.id)).at(-1)).toEqual({
        actor_id: staff.userId,
        actor_email: staff.email,
        action: 'account.factors_reset',
        target_type: 'tenant',
        reason: REASON,
        metadata: { resetId: pending!.id, requestedAt: row.requestedAt.toISOString(), removedPasskeys: 1 },
        ip_address: null,
      });
      expect(await eventsOf(user.id)).toEqual([
        'factors_reset.requested:staff',
        'factors_reset.completed:staff',
      ]);
      expect(notices).toEqual([`reset ${user.email}`]);
    });

    it('is idempotent: a second run changes nothing', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      await resets.execute(pending!.id);
      const version = await sessionVersion(user.id);
      // A factor set up afterwards must survive.
      await addTotp(user.id);

      await expect(resets.execute(pending!.id)).resolves.toBe(false);
      await expect(resets.executeDue()).resolves.toBe(0);
      expect(await sessionVersion(user.id)).toBe(version);
      expect(await countOf('totp_secrets', user.id)).toBe(1);
    });

    it('runs once when two workers race for it', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      const version = await sessionVersion(user.id);

      const results = await Promise.all([
        resets.execute(pending!.id),
        resets.execute(pending!.id),
        resets.executeDue(),
      ]);

      expect(results.filter((r) => r === true || r === 1)).toHaveLength(1);
      expect(await sessionVersion(user.id)).toBe(version + 1);
      expect((await auditOf(user.id)).filter((r: { action: string }) => r.action === 'account.factors_reset')).toHaveLength(1);
      expect(await eventsOf(user.id)).toEqual([
        'factors_reset.requested:staff',
        'factors_reset.completed:staff',
      ]);
    });

    it('either runs or is cancelled when a cancel races it, never both', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);

      const [executed, cancel] = await Promise.allSettled([
        resets.execute(pending!.id),
        resets.cancelByStaff(user.id, staff),
      ]);

      const [row] = await resetsOf(user.id);
      const ran = executed.status === 'fulfilled' && executed.value === true;
      expect(ran).toBe(cancel.status === 'rejected');
      expect(row.status).toBe(ran ? 'completed' : 'cancelled');
      expect(await countOf('totp_secrets', user.id)).toBe(ran ? 0 : 1);
    });

    it('does not run after a cancel', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      await resets.cancelByOwner({ userId: user.id, email: user.email });

      await expect(resets.execute(pending!.id)).resolves.toBe(false);
      expect(await countOf('totp_secrets', user.id)).toBe(1);
    });

    it('refuses an account made a super admin during the wait', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      await ds.query(`UPDATE users SET is_super_admin = true WHERE id = $1`, [user.id]);

      await expect(resets.execute(pending!.id)).resolves.toBe(false);
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
      expect(await countOf('webauthn_credentials', user.id)).toBe(1);
    });

    it('leaves other accounts\' resets alone', async () => {
      const due = await lockedOut('due');
      const waiting = await lockedOut('waiting');
      await resets.request(due.id, REASON, staff, VERIFIED);
      await resets.request(waiting.id, REASON, staff, VERIFIED);
      await makeDue(due.id);

      await expect(resets.executeDue()).resolves.toBe(1);
      expect((await resetsOf(waiting.id))[0].status).toBe('pending');
      expect(await countOf('totp_secrets', waiting.id)).toBe(1);
    });
  });

  it('is superseded by the CLI, so it cannot later remove factors set up since', async () => {
    const user = await lockedOut('owner');
    await resets.request(user.id, REASON, staff, VERIFIED);

    await resetAccountFactors(ds, user.email, CLI_VERIFIED);

    expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'superseded' });
    expect(await countOf('totp_secrets', user.id)).toBe(0);
  });

  // The owner was warned a reset is coming: the history and their inbox must say it
  // stopped, and that their factors were removed, as when the worker runs it.
  it('audits, records and announces the reset the CLI supersedes', async () => {
    const user = await lockedOut('owner');
    const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
    notices.length = 0;

    await resetAccountFactors(ds, user.email, CLI_VERIFIED, () => undefined, fakeNotices);

    expect(await auditOf(user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'account.factors_reset_cancelled',
          actor_id: null,
          actor_email: 'cli',
          metadata: { resetId: pending!.id, cancelledBy: 'superseded' },
        }),
      ]),
    );
    expect(await eventsOf(user.id)).toEqual(['factors_reset.requested:staff', 'factors_reset.cancelled:superseded']);
    expect([...notices].sort()).toEqual([`cancelled ${user.email}`, `reset ${user.email}`]);
  });

  it('tells the owner their factors were removed by the CLI, with nothing waiting to cancel', async () => {
    const user = await lockedOut('owner');

    await resetAccountFactors(ds, user.email, CLI_VERIFIED, () => undefined, fakeNotices);

    expect(notices).toEqual([`reset ${user.email}`]);
    expect(await eventsOf(user.id)).toEqual([]);
  });

  describe('soon after a password reset', () => {
    const OVERRIDE = 'Owner on a video call with ID; the reset was theirs';
    /** Moves the recorded reset back, as if it had happened that many days ago. */
    const passwordResetDaysAgo = (userId: string, daysAgo: number) =>
      ds.query(`UPDATE users SET password_reset_at = now() - make_interval(days => $2) WHERE id = $1`, [
        userId,
        daysAgo,
      ]);
    const resetByEmail = async (user: UserEntity) => {
      const token = (await tokens.issue(user.id, 'reset_password')) as string;
      await recovery.resetPassword(token, 'a-brand-new-password');
    };

    it.each([
      ['by email', resetByEmail],
    ])('is refused within 14 days of a reset %s, saying when, and writes nothing', async (_, reset) => {
      const user = await lockedOut('owner');
      await reset(user);
      await passwordResetDaysAgo(user.id, 13);

      const refusal = resets.request(user.id, REASON, staff, VERIFIED);
      await expect(refusal).rejects.toThrow(ConflictException);
      await expect(refusal).rejects.toThrow(/password was reset/);
      expect(await resetsOf(user.id)).toEqual([]);
      expect((await auditOf(user.id)).filter((row: { action: string }) => row.action.includes('factors'))).toEqual([]);
      expect(notices).toEqual([]);
    });

    it('is allowed once the reset is more than 14 days old', async () => {
      const user = await lockedOut('owner');
      await resetByEmail(user);
      await passwordResetDaysAgo(user.id, 15);
      await expect(resets.request(user.id, REASON, staff, VERIFIED)).resolves.toMatchObject({ hasFactors: true });
    });

    it('is not blocked by the owner changing their own password, which is not a reset', async () => {
      const user = await lockedOut('owner');
      await new UsersService(ds.getRepository(UserEntity)).changeOwnPassword(user.id, 'new-hash');
      await expect(resets.request(user.id, REASON, staff, VERIFIED)).resolves.toMatchObject({ hasFactors: true });
    });

    it('shows staff the latest password reset before they start', async () => {
      const user = await lockedOut('owner');
      await resetByEmail(user);
      const [latest] = await ds.query(`SELECT password_reset_at AS at FROM users WHERE id = $1`, [user.id]);
      expect(latest.at).not.toBeNull();

      const state = await resets.adminState(user.id);
      expect(state.lastPasswordResetAt).toBe(new Date(latest.at).toISOString());
      expect(state.emailConfigured).toBe(true);
    });

    it('goes ahead with a separate justification, kept in the audit entry and the pending state', async () => {
      const user = await lockedOut('owner');
      await resetByEmail(user);
      await passwordResetDaysAgo(user.id, 1);

      const state = await resets.request(user.id, REASON, staff, { ...VERIFIED, passwordResetOverride: OVERRIDE });

      expect(state.lastPasswordResetAt).not.toBeNull();
      expect(state.pending!.passwordResetOverride).toBe(OVERRIDE);
      expect((await resets.adminState(user.id)).pending!.passwordResetOverride).toBe(OVERRIDE);
      const [entry] = await auditOf(user.id);
      expect(entry.reason).toBe(REASON);
      expect(entry.metadata).toMatchObject({
        passwordResetOverride: OVERRIDE,
        lastPasswordResetAt: state.lastPasswordResetAt,
      });
    });

    it('is cancelled by a password reset through the mailbox', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      notices.length = 0;
      const token = (await tokens.issue(user.id, 'reset_password')) as string;

      await recovery.resetPassword(token, 'a-brand-new-password', { ipAddress: '198.51.100.7' });

      expect((await resetsOf(user.id))[0]).toMatchObject({
        status: 'cancelled',
        cancelledBy: 'password_reset',
      });
      expect((await auditOf(user.id)).at(-1)).toMatchObject({
        action: 'account.factors_reset_cancelled',
        actor_id: null,
        metadata: { resetId: pending!.id, cancelledBy: 'password_reset', via: 'email' },
      });
      expect(await eventsOf(user.id)).toContain('factors_reset.cancelled:password_reset');
      expect(notices).toEqual([`cancelled ${user.email}`]);
      expect(await countOf('totp_secrets', user.id)).toBe(1);
    });

  });

  describe('a requester who is no longer active staff', () => {
    it.each([
      [
        'lost super admin',
        'requester_not_staff',
        (id: string) => ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [id]),
      ],
      [
        'was suspended',
        'requester_suspended',
        (id: string) => ds.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [id]),
      ],
      ['was deleted', 'requester_missing', (id: string) => ds.query(`DELETE FROM users WHERE id = $1`, [id])],
    ])('is refused when the requester %s, audited, recorded and told to the owner', async (_, refusal, change) => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      notices.length = 0;
      // Straight in the database, so only the check in execute can catch it.
      await change(staff.userId);

      await expect(resets.execute(pending!.id)).resolves.toBe(false);

      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
      expect(await countOf('totp_secrets', user.id)).toBe(1);
      expect(await countOf('webauthn_credentials', user.id)).toBe(1);
      expect((await auditOf(user.id)).at(-1)).toMatchObject({
        action: 'account.factors_reset_cancelled',
        actor_id: null,
        metadata: { resetId: pending!.id, cancelledBy: 'refused', refusal },
      });
      expect(await eventsOf(user.id)).toEqual([
        'factors_reset.requested:staff',
        'factors_reset.cancelled:refused',
      ]);
      expect(notices).toEqual([`cancelled ${user.email}`]);
    });

    it('revoking super admin through the CLI cancels every reset they asked for, and only those', async () => {
      const first = await lockedOut('first');
      const second = await lockedOut('second');
      const others = await lockedOut('others');
      const colleague = await makeStaff('colleague');
      await resets.request(first.id, REASON, staff, VERIFIED);
      await resets.request(second.id, REASON, staff, VERIFIED);
      await resets.request(others.id, REASON, { userId: colleague.id, email: colleague.email }, VERIFIED);

      notices.length = 0;
      await expect(setSuperAdmin(ds, staff.email, false, fakeNotices)).resolves.toBe('changed');

      for (const target of [first, second]) {
        expect((await resetsOf(target.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
        expect((await auditOf(target.id)).at(-1)).toMatchObject({
          action: 'account.factors_reset_cancelled',
          actor_email: 'cli',
          metadata: { cancelledBy: 'refused', refusal: 'requester_not_staff' },
        });
        expect(await eventsOf(target.id)).toContain('factors_reset.cancelled:refused');
      }
      expect((await resetsOf(others.id))[0].status).toBe('pending');
      // Each owner was warned in the requester's name, so each hears that it stopped.
      expect([...notices].sort()).toEqual([`cancelled ${first.email}`, `cancelled ${second.email}`]);
    });

    it('suspending the requester cancels every reset they asked for', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      // A super admin cannot be suspended, so only someone already revoked can be.
      await ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [staff.userId]);
      const other = await makeUser('other-staff', { isSuperAdmin: true });
      const audit = ds.getRepository(AdminAuditLogEntity);
      const tenants = new AdminTenantsService(
        ds.getRepository(UserEntity),
        audit,
        new AdminAuditService(audit),
        fakeNotices, new SeatsService(ds)
      );
      notices.length = 0;

      await tenants.suspend(staff.userId, 'Left the company, access withdrawn', {
        userId: other.id,
        email: other.email,
        ipAddress: '203.0.113.1',
      });

      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
      expect((await auditOf(user.id)).at(-1)).toMatchObject({
        action: 'account.factors_reset_cancelled',
        actor_id: other.id,
        metadata: { resetId: pending!.id, cancelledBy: 'refused', refusal: 'requester_suspended' },
      });
      expect(notices).toEqual([`cancelled ${user.email}`]);
    });
  });

  describe("the owner's warning", () => {
    it('refuses to start when account email is not set up, since the owner cannot be warned', async () => {
      const user = await lockedOut('owner');
      email.configured = false;

      await expect(resets.request(user.id, REASON, staff, VERIFIED)).rejects.toThrow(
        new ConflictException('Account email is not set up, so the owner cannot be warned'),
      );
      expect(await resetsOf(user.id)).toEqual([]);
      expect(await auditOf(user.id)).toEqual([]);
      expect((await resets.adminState(user.id)).emailConfigured).toBe(false);
    });

    it('never runs while the warning has not gone out, and waits the whole delay from when it does', async () => {
      const user = await lockedOut('owner');
      email.delivers = false;
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      expect(pending!.noticeSentAt).toBeNull();

      // Long past the original time, but the owner was never told.
      await ds.query(
        `UPDATE factor_resets SET execute_after = now() - interval '10 days',
                requested_at = now() - interval '10 days' WHERE id = $1`,
        [pending!.id],
      );
      await expect(resets.execute(pending!.id)).resolves.toBe(false);
      await expect(resets.executeDue()).resolves.toBe(0);
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'pending', noticeSentAt: null });

      // The sweep tries the email again; once it goes, the wait starts from then.
      email.delivers = true;
      notices.length = 0;
      await expect(resets.executeDue()).resolves.toBe(0);
      const [row] = await resetsOf(user.id);
      expect(row.noticeSentAt).toBeInstanceOf(Date);
      expect(row.executeAfter.getTime() - row.noticeSentAt!.getTime()).toBe(72 * HOUR_MS);
      expect(notices).toHaveLength(1);
      expect((await resets.adminState(user.id)).pending!.noticeSentAt).toBe(row.noticeSentAt!.toISOString());
      await expect(resets.execute(pending!.id)).resolves.toBe(false);

      // Moving the displayed time into the past does not shorten it either.
      await ds.query(`UPDATE factor_resets SET execute_after = now() - interval '1 minute' WHERE id = $1`, [
        pending!.id,
      ]);
      await expect(resets.execute(pending!.id)).resolves.toBe(false);
      expect(await countOf('totp_secrets', user.id)).toBe(1);

      await makeDue(user.id);
      await expect(resets.executeDue()).resolves.toBe(1);
      expect(await countOf('totp_secrets', user.id)).toBe(0);
    });

    it('does not send the warning again once it has gone out', async () => {
      const user = await lockedOut('owner');
      await resets.request(user.id, REASON, staff, VERIFIED);
      notices.length = 0;

      await resets.executeDue();
      expect(notices).toEqual([]);
    });
  });

  describe('a cancel racing the worker', () => {
    const lockWaiters = async (): Promise<number> =>
      (
        await ds.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
      )[0].n;

    it('lets a cancel that started first win, without a deadlock', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);

      // Holds the cancel just before its audit insert: the step whose foreign key check
      // on the owner's row used to meet the worker's lock coming the other way.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const record = AdminAuditService.prototype.record;
      const spy = jest
        .spyOn(AdminAuditService.prototype, 'record')
        .mockImplementation(async function (this: AdminAuditService, entry, manager) {
          if (entry.action === 'account.factors_reset_cancelled') {
            reached();
            await gate;
          }
          return record.call(this, entry, manager);
        });
      try {
        const cancel = resets.cancelByOwner({ userId: user.id, email: user.email });
        await paused;
        const execute = resets.execute(pending!.id);
        // Lets the worker go as far as it can, which is to block behind the cancel.
        for (let i = 0; i < 100 && (await lockWaiters()) === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(await lockWaiters()).toBeGreaterThan(0);
        release();

        const [cancelled, executed] = await Promise.allSettled([cancel, execute]);
        expect(cancelled).toEqual({ status: 'fulfilled', value: undefined });
        expect(executed).toEqual({ status: 'fulfilled', value: false });
      } finally {
        release();
        spy.mockRestore();
      }
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'owner' });
      expect(await countOf('totp_secrets', user.id)).toBe(1);
    });

    it('never deadlocks over many simultaneous cancels and runs, and exactly one of each pair wins', async () => {
      for (let round = 0; round < 25; round += 1) {
        const user = await lockedOut(`race${round}`);
        const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
        await makeDue(user.id);

        const [executed, cancelled] = await Promise.allSettled([
          resets.execute(pending!.id),
          resets.cancelByOwner({ userId: user.id, email: user.email }),
        ]);

        for (const result of [executed, cancelled]) {
          if (result.status === 'rejected') expect(String(result.reason)).not.toMatch(/deadlock/i);
        }
        expect(executed.status).toBe('fulfilled');
        const ran = (executed as PromiseFulfilledResult<boolean>).value;
        // The cancel finds nothing exactly when the worker got there first.
        expect(cancelled.status).toBe(ran ? 'rejected' : 'fulfilled');
        if (cancelled.status === 'rejected') expect(cancelled.reason).toBeInstanceOf(NotFoundException);
        const [row] = await resetsOf(user.id);
        expect(row.status).toBe(ran ? 'completed' : 'cancelled');
        expect(await countOf('totp_secrets', user.id)).toBe(ran ? 0 : 1);
      }
    });
  });

  describe('password resets around a staff reset', () => {
    const completedReset = async (name: string) => {
      const user = await lockedOut(name);
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      await expect(resets.execute(pending!.id)).resolves.toBe(true);
      return user;
    };

    /**
     * The reverse of "password reset, then factor reset": someone with only the mailbox
     * asks staff to remove the factors, waits it out, then resets the password by email.
     */
    describe('after a completed factor reset', () => {
      it('refuses a password reset by email, telling the person to contact support', async () => {
        const user = await completedReset('owner');
        const before = await hashOf(user.id);
        const token = (await tokens.issue(user.id, 'reset_password')) as string;

        const refusal = recovery.resetPassword(token, 'attacker-password-1', { ipAddress: '198.51.100.7' });
        await expect(refusal).rejects.toThrow(ConflictException);
        await expect(refusal).rejects.toThrow(/can't be reset by email right now\. Contact support\./);

        expect(await hashOf(user.id)).toBe(before);
        const types = (await ds.getRepository(AuthEventEntity).findBy({ userId: user.id })).map(
          (row) => `${row.type}:${row.reason}`,
        );
        expect(types).toContain('password.reset_refused:factors_reset:email');
        expect(types.filter((type) => type.startsWith('password.reset:'))).toEqual([]);
        expect((await auditOf(user.id)).at(-1)).toMatchObject({
          action: 'account.password_reset_refused',
          actor_id: null,
          actor_email: 'system',
          metadata: { via: 'email' },
        });
      });

      it('refuses an email reset after the CLI removed the factors', async () => {
        const user = await lockedOut('owner');
        await resetAccountFactors(ds, user.email, CLI_VERIFIED);
        const token = (await tokens.issue(user.id, 'reset_password')) as string;

        await expect(recovery.resetPassword(token, 'attacker-password-1')).rejects.toThrow(ConflictException);
      });

      // The documented recovery for staff: the CLI removes the keys, they sign in with
      // the password they still have and enrol new ones. Only a new password is refused.
      it('refuses an email reset after the CLI reset a super admin\'s passkeys, but the old password still signs in', async () => {
        const admin = await makeUser('lost-keys', { isSuperAdmin: true });
        await addPasskey(admin.id);
        await resetSuperAdminPasskeys(ds, admin.email, null, () => undefined);
        const token = (await tokens.issue(admin.id, 'reset_password')) as string;

        await expect(recovery.resetPassword(token, 'attacker-password-1')).rejects.toThrow(ConflictException);
        await expect(auth.login({ email: admin.email, password: PASSWORD })).resolves.toBeDefined();
      });

      /** The token from a link the CLI printed, as the person would paste it. */
      const tokenOf = (link: string) => new URL(link).hash.replace(/^#token=/, '');
      const LINK_JUSTIFIED = 'Lost every factor and the password with the laptop';
      /**
       * A link from `admin:password-reset-link`, issued as an operator must inside the
       * window. Unless `waiting`, moved past its delay, as if the owner had let it run.
       */
      const staffLink = async (user: UserEntity, { waiting = false } = {}) => {
        const { link } = await issuePasswordResetLink(
          ds,
          user.email,
          { ...CLI_VERIFIED, recentFactorResetJustification: LINK_JUSTIFIED, confirmSuperAdmin: user.isSuperAdmin },
          settings['app.appUrl'] as string,
          fakeNotices,
          () => undefined,
        );
        expect(link.startsWith(`${settings['app.appUrl']}/reset-password#token=`)).toBe(true);
        if (!waiting) {
          await ds.query(
            `UPDATE account_tokens SET usable_after = now() - interval '1 minute'
              WHERE user_id = $1 AND staff_issued AND used_at IS NULL`,
            [user.id],
          );
        }
        return tokenOf(link);
      };
      const usedAtOf = async (userId: string) =>
        (await ds.query(`SELECT used_at FROM account_tokens WHERE user_id = $1 AND staff_issued`, [userId]))[0]
          .used_at;

      // A super admin who lost their keys and their password: passkeys-reset arms the
      // block, so only a link staff issue after checking who is asking gets them back in.
      it('lets a link staff issued through the CLI reset the password despite the block, and audits it', async () => {
        const admin = await makeStaff('lost-everything');
        await resetSuperAdminPasskeys(ds, admin.email, null, () => undefined);
        const before = await hashOf(admin.id);

        const token = await staffLink(admin);
        await expect(recovery.resetPassword(token, 'a-brand-new-password')).resolves.toBeUndefined();

        expect(await hashOf(admin.id)).not.toBe(before);
        const issued = (await auditOf(admin.id)).filter(
          (row: { action: string }) => row.action === 'account.password_reset_link_issued',
        );
        expect(issued).toEqual([
          expect.objectContaining({
            actor_id: null,
            actor_email: 'cli',
            metadata: expect.objectContaining({
              verificationMethod: CLI_VERIFIED.method,
              verificationNotes: CLI_VERIFIED.notes,
            }),
          }),
        ]);
        const types = (await ds.getRepository(AuthEventEntity).findBy({ userId: admin.id })).map(
          (row) => `${row.type}:${row.reason}`,
        );
        expect(types).toContain('password.reset:staff_link');
      });

      it('still refuses an ordinary emailed link after staff issued one', async () => {
        const user = await completedReset('owner');
        await staffLink(user);
        const token = (await tokens.issue(user.id, 'reset_password')) as string;
        const before = await hashOf(user.id);

        await expect(recovery.resetPassword(token, 'attacker-password-1')).rejects.toThrow(ConflictException);
        expect(await hashOf(user.id)).toBe(before);
      });

      // Whoever holds the mailbox can ask for emailed links at will; that must neither use
      // up the address's sends nor void the link support handed over.
      it('keeps a staff link working through emailed ones, and does not count it as a send', async () => {
        const user = await completedReset('owner');
        const token = await staffLink(user);

        for (let send = 0; send < 3; send += 1) {
          expect(await tokens.issue(user.id, 'reset_password')).toEqual(expect.any(String));
        }
        expect(await tokens.issue(user.id, 'reset_password')).toBeNull();
        await expect(recovery.resetPassword(token, 'a-brand-new-password')).resolves.toBeUndefined();
      });

      /**
       * A fooled operator could otherwise run passkeys-reset and password-reset-link in
       * one conversation and hand over the account at once. The wait is the real owner's
       * time to see the notice and sign in.
       */
      describe('during the staff link\'s wait', () => {
        it('refuses the link with the time it becomes usable, leaving it unspent', async () => {
          const user = await completedReset('owner');
          const token = await staffLink(user, { waiting: true });
          const [{ usable_after: usableAfter }] = await ds.query(
            `SELECT usable_after FROM account_tokens WHERE user_id = $1 AND staff_issued`,
            [user.id],
          );
          const before = await hashOf(user.id);

          const early = recovery.resetPassword(token, 'a-brand-new-password');
          await expect(early).rejects.toMatchObject({ status: 425 });
          await expect(early).rejects.toThrow(`This link becomes usable at ${usableAfter.toISOString()}`);
          expect(await hashOf(user.id)).toBe(before);
          expect(await usedAtOf(user.id)).toBeNull();
          await expect(recovery.resetLinkStatus(token)).resolves.toEqual({ usableAt: usableAfter.toISOString() });

          await ds.query(`UPDATE account_tokens SET usable_after = now() - interval '1 minute' WHERE user_id = $1`, [
            user.id,
          ]);
          await expect(recovery.resetLinkStatus(token)).resolves.toEqual({ usableAt: null });
          await expect(recovery.resetPassword(token, 'a-brand-new-password')).resolves.toBeUndefined();
          expect(await hashOf(user.id)).not.toBe(before);
        });

        it('says nothing about a link that is not a waiting staff link', async () => {
          const user = await completedReset('owner');
          const emailed = (await tokens.issue(user.id, 'reset_password')) as string;
          await expect(recovery.resetLinkStatus(emailed)).resolves.toEqual({ usableAt: null });
          await expect(recovery.resetLinkStatus('made-up')).resolves.toEqual({ usableAt: null });
        });

        it('stops working 24 hours after it became usable', async () => {
          const user = await completedReset('owner');
          const token = await staffLink(user);
          await ds.query(
            `UPDATE account_tokens SET usable_after = now() - interval '25 hours', expires_at = now() - interval '1 hour'
              WHERE user_id = $1 AND staff_issued`,
            [user.id],
          );
          await expect(recovery.resetPassword(token, 'a-brand-new-password')).rejects.toThrow(BadRequestException);
        });

        const cancelled = async (user: UserEntity) =>
          (await auditOf(user.id)).filter(
            (row: { action: string }) => row.action === 'account.password_reset_link_cancelled',
          );

        /** A complete sign-in with the password and then the account's second factor. */
        const passwordThenFactor = async (user: UserEntity) => {
          factorMethods.list = ['totp'];
          const step = await auth.login({ email: user.email, password: PASSWORD });
          if (!('requiresSecondFactor' in step)) throw new Error('expected a second step');
          return auth.completeSecondFactor(step.handle, 'totp');
        };
        const passwordOnly = (user: UserEntity) => {
          factorMethods.list = [];
          return auth.login({ email: user.email, password: PASSWORD });
        };

        it.each([
          ['their password, on an account with no second factor', passwordOnly, 'password'],
          ['their password and then their second factor', passwordThenFactor, 'factor'],
          ['a passkey', (user: UserEntity) => auth.signInWithPasskey(user), 'factor'],
        ])('is voided when the owner signs in with %s, audited and with a notice', async (_, signIn, via) => {
          const user = await completedReset('owner');
          const token = await staffLink(user, { waiting: true });
          notices.length = 0;

          await signIn(user);

          expect(await usedAtOf(user.id)).not.toBeNull();
          expect(await cancelled(user)).toEqual([
            expect.objectContaining({
              actor_id: null,
              actor_email: 'system',
              metadata: expect.objectContaining({ reason: 'owner_signed_in', via }),
            }),
          ]);
          expect(notices).toEqual([`link cancelled ${user.email}`]);
          await ds.query(`UPDATE account_tokens SET usable_after = now() - interval '1 minute' WHERE user_id = $1`, [
            user.id,
          ]);
          await expect(recovery.resetPassword(token, 'a-brand-new-password')).rejects.toThrow(BadRequestException);
        });

        // Knowing the password is not being the owner when the account has a factor: whoever
        // has only the password could otherwise void the real owner's recovery link at will.
        it('is left alone by the password step of an account with a second factor', async () => {
          const user = await completedReset('owner');
          await staffLink(user, { waiting: true });
          factorMethods.list = ['totp'];

          const step = await auth.login({ email: user.email, password: PASSWORD });

          expect(step).toMatchObject({ requiresSecondFactor: true });
          expect(await usedAtOf(user.id)).toBeNull();
          expect(await cancelled(user)).toEqual([]);
          expect(notices).not.toContain(`link cancelled ${user.email}`);
        });

        it('is voided by a re-authentication with a second factor', async () => {
          const user = await completedReset('owner');
          await staffLink(user, { waiting: true });
          const { sessionId } = await sessions.create(
            user.id,
            {},
            { amr: ['pwd', 'totp'], authenticatedAt: new Date() },
            user.sessionVersion,
          );

          await auth.issueReauthenticatedToken(user, sessionId, 'totp');

          expect(await usedAtOf(user.id)).not.toBeNull();
          expect((await cancelled(user))[0].metadata).toMatchObject({ reason: 'owner_signed_in', via: 'factor' });
        });

        describe('when voiding fails', () => {
          const failVoid = (error: unknown, times = Infinity) => {
            const real = AccountTokensService.prototype.voidStaffLinks;
            let failures = 0;
            return jest
              .spyOn(AccountTokensService.prototype, 'voidStaffLinks')
              .mockImplementation(async function (this: AccountTokensService, ...args) {
                if (failures < times) {
                  failures += 1;
                  throw error;
                }
                return real.apply(this, args);
              });
          };

          // A sign-in must still work, but the failure must not pass unseen: the owner is
          // shown the link and its cancel button, and staff see it on the tenant's page.
          it('still signs in, records it, and tells the client a link may still be live', async () => {
            const user = await completedReset('owner');
            await staffLink(user, { waiting: true });
            failVoid(new Error('the database went away'));

            const result = (await passwordOnly(user)) as unknown as Record<string, unknown>;

            expect(result.tokens).toBeDefined();
            expect(result.staffLinkPending).toBe(true);
            expect(await usedAtOf(user.id)).toBeNull();
            const types = (await ds.getRepository(AuthEventEntity).findBy({ userId: user.id })).map((row) => row.type);
            expect(types).toContain('staff_link.void_failed');
            expect((await auditOf(user.id)).map((row: { action: string }) => row.action)).toContain(
              'account.password_reset_link_void_failed',
            );
          });

          it('retries a transient failure, so a lost deadlock still voids the link', async () => {
            const user = await completedReset('owner');
            await staffLink(user, { waiting: true });
            failVoid(Object.assign(new Error('deadlock detected'), { code: '40P01' }), 2);

            const result = (await passwordOnly(user)) as unknown as Record<string, unknown>;

            expect(result.staffLinkPending).toBeUndefined();
            expect(await usedAtOf(user.id)).not.toBeNull();
          });
        });

        /**
         * Issuing a link and voiding one both lock the user row first. Without that, a
         * sign-in that ran while a link was being issued could not see the uncommitted
         * row, voided nothing, and the link went live after the owner had signed in.
         */
        it('waits for a link still being issued to commit, then voids it', async () => {
          const user = await completedReset('owner');
          const issuing = ds.createQueryRunner();
          await issuing.connect();
          try {
            const [{ pid }] = await issuing.query(`SELECT pg_backend_pid() AS pid`);
            await issuing.startTransaction();
            await issuing.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [user.id]);
            await issuing.query(
              `INSERT INTO account_tokens (user_id, purpose, token_hash, staff_issued, usable_after, expires_at)
               VALUES ($1, 'reset_password', $2, true, now() + interval '1 hour', now() + interval '25 hours')`,
              [user.id, randomUUID()],
            );

            let settled = false;
            const voiding = resets.voidStaffLinksOnSignIn(user, 'password').finally(() => (settled = true));
            // Until the void is either finished or blocked behind the issuing transaction.
            for (let tries = 0; !settled && !(await waitingOnLock(pid)); tries += 1) {
              if (tries > 200) throw new Error('the void neither finished nor waited');
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await issuing.commitTransaction();
            await voiding;
          } finally {
            if (issuing.isTransactionActive) await issuing.rollbackTransaction();
            await issuing.release();
          }

          expect(await usedAtOf(user.id)).not.toBeNull();
          expect(await cancelled(user)).toHaveLength(1);
        });

        // The notice goes out once the link is committed, so a sign-in prompted by it sees
        // the link; the CLI then refuses to print a link the owner has already cancelled.
        it('is voided by a sign-in while the notice is being sent, and the CLI prints nothing', async () => {
          const user = await completedReset('owner');
          factorMethods.list = [];
          duringLinkNotice.run = async (owner) => {
            await auth.login({ email: owner.email, password: PASSWORD });
          };

          await expect(staffLink(user, { waiting: true })).rejects.toThrow(
            `${user.email} signed in while the notice was being sent, which cancelled the link`,
          );

          expect(await usedAtOf(user.id)).not.toBeNull();
          expect(await cancelled(user)).toHaveLength(1);
        });

        /**
         * Whatever spent the link while the notice was going out, the CLI says which, from
         * what was recorded, rather than guessing a sign-in.
         */
        describe('spent while the notice was being sent, the CLI says why', () => {
          it('the owner cancelled it from a session', async () => {
            const user = await completedReset('owner');
            duringLinkNotice.run = async (owner) => {
              await resets.cancelStaffLinksByOwner({ userId: owner.id, email: owner.email });
            };

            await expect(staffLink(user, { waiting: true })).rejects.toThrow(
              `${user.email} cancelled the link from their account while the notice was being sent`,
            );
            expect(await usedAtOf(user.id)).not.toBeNull();
          });

          it('the password was reset, with a link from before', async () => {
            const user = await completedReset('owner');
            const earlier = await staffLink(user);
            duringLinkNotice.run = async () => {
              duringLinkNotice.run = null;
              await recovery.resetPassword(earlier, 'a-brand-new-password');
            };

            const failure = staffLink(user, { waiting: true });
            await expect(failure).rejects.toThrow(
              new RegExp(`password of ${user.email} was reset at \\S+ while the notice was being sent`),
            );
            await expect(failure).rejects.not.toThrow(/signed in/);
          });

          // Possible only when the first run's notice took longer than the few minutes
          // that hold a second run off (`STAFF_LINK_ISSUE_HOLD_MS`).
          it('another run issued a link, which replaced it', async () => {
            const user = await completedReset('owner');
            let other: string | null = null;
            duringLinkNotice.run = async (owner) => {
              duringLinkNotice.run = null;
              // As if this notice had been stuck for longer than the hold.
              await ds.query(
                `UPDATE account_tokens SET created_at = now() - interval '11 minutes' WHERE user_id = $1`,
                [owner.id],
              );
              other = await staffLink(owner, { waiting: true });
            };

            const failure = staffLink(user, { waiting: true });
            await expect(failure).rejects.toThrow(
              new RegExp(`Another link for ${user.email} was issued at \\S+ while this one waited on the notice`),
            );
            await expect(failure).rejects.toThrow(/Use that one/);
            expect(other).not.toBeNull();
            // The other run's link is the one left live.
            const [{ live }] = await ds.query(
              `SELECT count(*)::int AS live FROM account_tokens WHERE user_id = $1 AND staff_issued AND used_at IS NULL`,
              [user.id],
            );
            expect(live).toBe(1);
          });
        });

        it('is left alone by a wrong password', async () => {
          const user = await completedReset('owner');
          await staffLink(user, { waiting: true });

          await expect(auth.login({ email: user.email, password: 'not-the-password' })).rejects.toThrow();

          expect(await usedAtOf(user.id)).toBeNull();
          expect(await cancelled(user)).toEqual([]);
        });

        /**
         * Most owners already have a session when the notice arrives, and a sign-in page
         * would send them straight on to their projects, so they cancel from that session.
         */
        describe('cancelled by the owner from a session', () => {
          it('spends every unused staff link, audited in their name, with a notice', async () => {
            const user = await completedReset('owner');
            const token = await staffLink(user, { waiting: true });
            notices.length = 0;

            await expect(
              resets.cancelStaffLinksByOwner({ userId: user.id, email: user.email }, { ipAddress: '198.51.100.4' }),
            ).resolves.toBe(1);

            expect(await usedAtOf(user.id)).not.toBeNull();
            expect(await cancelled(user)).toEqual([
              expect.objectContaining({
                actor_id: user.id,
                actor_email: user.email,
                ip_address: '198.51.100.4',
                metadata: expect.objectContaining({ reason: 'owner_cancelled' }),
              }),
            ]);
            expect(notices).toEqual([`link cancelled ${user.email}`]);
            await ds.query(`UPDATE account_tokens SET usable_after = now() - interval '1 minute' WHERE user_id = $1`, [
              user.id,
            ]);
            await expect(recovery.resetPassword(token, 'a-brand-new-password')).rejects.toThrow(BadRequestException);
          });

          it('answers 0 when nothing is waiting, telling nobody', async () => {
            const user = await completedReset('owner');
            notices.length = 0;
            await expect(resets.cancelStaffLinksByOwner({ userId: user.id, email: user.email })).resolves.toBe(0);
            expect(notices).toEqual([]);
            expect(await cancelled(user)).toEqual([]);
          });
        });

        describe('the profile flag for the dashboard banner', () => {
          it('is true while a staff link is live, and false once it is cancelled', async () => {
            const user = await completedReset('owner');
            await expect(auth.getProfile(user.id)).resolves.toMatchObject({ staffLinkPending: false });

            await staffLink(user, { waiting: true });
            await expect(auth.getProfile(user.id)).resolves.toMatchObject({ staffLinkPending: true });

            await resets.cancelStaffLinksByOwner({ userId: user.id, email: user.email });
            await expect(auth.getProfile(user.id)).resolves.toMatchObject({ staffLinkPending: false });
          });

          it('is false for a link past its expiry', async () => {
            const user = await completedReset('owner');
            await staffLink(user);
            await ds.query(`UPDATE account_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [
              user.id,
            ]);
            await expect(auth.getProfile(user.id)).resolves.toMatchObject({ staffLinkPending: false });
          });

          it('is never shown to staff looking through the account', async () => {
            const user = await completedReset('owner');
            await staffLink(user, { waiting: true });
            await expect(auth.getProfile(user.id, { impersonated: true })).resolves.toMatchObject({
              staffLinkPending: false,
            });
          });
        });
      });

      it('refuses to issue a link without saying how the person was verified', async () => {
        const user = await completedReset('owner');
        await expect(
          issuePasswordResetLink(
            ds,
            user.email,
            { method: 'email', notes: 'they emailed us' } as never,
            'https://x.test',
            fakeNotices,
          ),
        ).rejects.toThrow(/verified-by/);
        expect((await auditOf(user.id)).map((row: { action: string }) => row.action)).not.toContain(
          'account.password_reset_link_issued',
        );
      });

      it('allows an email reset again once the window has passed', async () => {
        const user = await completedReset('owner');
        await ds.query(
          `UPDATE users SET factors_reset_at = now() - make_interval(days => 14, mins => 1) WHERE id = $1`,
          [user.id],
        );
        const token = (await tokens.issue(user.id, 'reset_password')) as string;
        await expect(recovery.resetPassword(token, 'owner-password-1')).resolves.toBeUndefined();
      });
    });

    /**
     * The guard must not rest on the auth event, which is written after the password
     * commits and never throws: if it is lost, the reset still happened.
     */
    describe('whose auth event was lost', () => {
      const losePasswordResetEvents = () => {
        const record = AuthEventsService.prototype.record;
        return jest
          .spyOn(AuthEventsService.prototype, 'record')
          .mockImplementation(async function (this: AuthEventsService, event) {
            if (event.type.startsWith('password.reset')) return;
            return record.call(this, event);
          });
      };

      it('still blocks a factor reset after an email reset', async () => {
        const user = await lockedOut('owner');
        const token = (await tokens.issue(user.id, 'reset_password')) as string;
        const spy = losePasswordResetEvents();
        try {
          await recovery.resetPassword(token, 'a-brand-new-password');
        } finally {
          spy.mockRestore();
        }
        expect(await ds.getRepository(AuthEventEntity).countBy({ userId: user.id, type: 'password.reset' })).toBe(0);

        await expect(resets.request(user.id, REASON, staff, VERIFIED)).rejects.toThrow(/password was reset/);
        expect(await resetsOf(user.id)).toEqual([]);
        expect((await resets.adminState(user.id)).lastPasswordResetAt).not.toBeNull();
      });
    });
  });

  /**
   * Revoking or suspending a requester cancels resets on other people's accounts, so it
   * touches their rows while their own password reset or CLI reset may be running.
   */
  describe('a requester revoked while a target resets', () => {
    const lockWaiters = async (): Promise<number> =>
      (
        await ds.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
      )[0].n;
    const revokers: [string, (requester: UserEntity) => Promise<unknown>][] = [
      ['the CLI revoke', (requester) => setSuperAdmin(ds, requester.email, false, fakeNotices)],
      [
        'a suspension',
        async (requester) => {
          // Only someone already revoked can be suspended.
          await ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [requester.id]);
          const audit = ds.getRepository(AdminAuditLogEntity);
          return new AdminTenantsService(
            ds.getRepository(UserEntity),
            audit,
            new AdminAuditService(audit),
            fakeNotices, new SeatsService(ds)
          ).suspend(requester.id, 'Left the company, access withdrawn', {
            userId: staff.userId,
            email: staff.email,
            ipAddress: '203.0.113.1',
          });
        },
      ],
    ];
    const targetResets: [string, (target: UserEntity) => Promise<unknown>][] = [
      [
        'a password reset by email',
        async (target) =>
          recovery.resetPassword((await tokens.issue(target.id, 'reset_password')) as string, 'a-brand-new-password'),
      ],
      ['the CLI factors reset', (target) => resetAccountFactors(ds, target.email, CLI_VERIFIED)],
    ];
    const cases = revokers.flatMap(([revokerName, revoke]) =>
      targetResets.map(([targetName, reset]) => [revokerName, targetName, revoke, reset] as const),
    );

    it.each(cases)(
      'does not deadlock %s against %s caught mid-cancel',
      async (_, __, revoke, resetTarget) => {
        const requester = await makeStaff('requester');
        const target = await lockedOut('target');
        await resets.request(target.id, REASON, { userId: requester.id, email: requester.email }, VERIFIED);

        // Holds the revoke between cancelling the reset row and recording it on the
        // target's account: where it once held the reset row and still needed the
        // target's user row, which the target's own reset holds while it waits on that
        // same reset row.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let reached!: () => void;
        const paused = new Promise<void>((resolve) => (reached = resolve));
        const record = AdminAuditService.prototype.record;
        let held = false;
        const spy = jest
          .spyOn(AdminAuditService.prototype, 'record')
          .mockImplementation(async function (this: AdminAuditService, entry, manager) {
            if (!held && entry.action === 'account.factors_reset_cancelled' && entry.metadata?.refusal) {
              held = true;
              reached();
              await gate;
            }
            return record.call(this, entry, manager);
          });
        try {
          const revoking = revoke(requester);
          // A revoke that never reaches the cancel must fail here, not hang to the timeout.
          await Promise.race([paused, revoking.catch(() => undefined)]);
          expect(held).toBe(true);
          const resetting = resetTarget(target);
          for (let i = 0; i < 100 && (await lockWaiters()) === 0; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(await lockWaiters()).toBeGreaterThan(0);
          release();

          const results = await Promise.allSettled([revoking, resetting]);
          expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        } finally {
          release();
          spy.mockRestore();
        }
        expect((await resetsOf(target.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
      },
    );

    // Each of the two tests below holds one half of the fix; either half alone breaks
    // the cycle above, so those tests only fail with both gone.
    it('holds the owners\' rows before it touches their resets', async () => {
      const requester = await makeStaff('requester');
      const target = await lockedOut('target');
      await resets.request(target.id, REASON, { userId: requester.id, email: requester.email }, VERIFIED);
      const runner = ds.createQueryRunner();
      await runner.connect();
      try {
        await runner.startTransaction();
        const targets = await lockResetTargetsOf(runner.manager, requester.id);
        expect(targets.userIds).toEqual([target.id]);
        // Nobody else can take the owner's row while the revoke has it.
        await expect(
          ds.transaction(async (manager) => {
            await manager.query(`SET LOCAL lock_timeout = '100ms'`);
            await manager.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [target.id]);
          }),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });

    /** Inserts what a revoke cancelling this account's reset records; FOR UPDATE would block it. */
    const recordEvent = (user: UserEntity) =>
      ds.transaction(async (manager) => {
        await manager.query(`SET LOCAL lock_timeout = '100ms'`);
        await manager.insert(AuthEventEntity, { type: 'factors_reset.cancelled', userId: user.id, reason: 'refused' });
      });

    it('lets events be recorded on an account while a password reset holds it', async () => {
      const user = await lockedOut('target');
      const runner = ds.createQueryRunner();
      await runner.connect();
      try {
        await runner.startTransaction();
        // The lock `spendToken` takes.
        await new UsersService(ds.getRepository(UserEntity)).findByIdForUpdate(user.id, runner.manager);
        await expect(recordEvent(user)).resolves.toBeUndefined();
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });

    it('lets events be recorded on an account while the CLI factors reset holds it', async () => {
      const user = await lockedOut('target');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const record = AdminAuditService.prototype.record;
      const spy = jest
        .spyOn(AdminAuditService.prototype, 'record')
        .mockImplementation(async function (this: AdminAuditService, entry, manager) {
          if (entry.action === 'account.factors_reset' && entry.actorEmail === 'cli') {
            reached();
            await gate;
          }
          return record.call(this, entry, manager);
        });
      try {
        const cli = resetAccountFactors(ds, user.email, CLI_VERIFIED);
        await paused;
        const recorded = recordEvent(user).then(
          () => 'recorded',
          (error) => String(error),
        );
        await expect(recorded).resolves.toBe('recorded');
        release();
        await cli;
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('never deadlocks over many revokes racing password and CLI resets of their targets', async () => {
      for (let round = 0; round < 15; round += 1) {
        const requester = await makeStaff(`requester${round}`);
        const byEmail = await lockedOut(`by-email${round}`);
        const byCli = await lockedOut(`by-cli${round}`);
        const asked = { userId: requester.id, email: requester.email };
        await resets.request(byEmail.id, REASON, asked, VERIFIED);
        await resets.request(byCli.id, REASON, asked, VERIFIED);
        const token = (await tokens.issue(byEmail.id, 'reset_password')) as string;
        const [, revoke] = revokers[round % 2];

        const results = await Promise.allSettled([
          revoke(requester),
          recovery.resetPassword(token, 'a-brand-new-password'),
          resetAccountFactors(ds, byCli.email, CLI_VERIFIED),
        ]);

        for (const result of results) {
          if (result.status === 'rejected') expect(String(result.reason)).not.toMatch(/deadlock/i);
          expect(result.status).toBe('fulfilled');
        }
        for (const target of [byEmail, byCli]) {
          expect((await resetsOf(target.id))[0].status).toBe('cancelled');
        }
      }
    });
  });
  describe('a requester revoked while they ask for a reset', () => {
    const lockWaiters = async (): Promise<number> =>
      (
        await ds.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
      )[0].n;
    /** Holds the first audit entry for `action` until the returned release is called. */
    const holdAudit = (action: string) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const record = AdminAuditService.prototype.record;
      let held = false;
      const spy = jest
        .spyOn(AdminAuditService.prototype, 'record')
        .mockImplementation(async function (this: AdminAuditService, entry, manager) {
          if (!held && entry.action === action) {
            held = true;
            reached();
            await gate;
          }
          return record.call(this, entry, manager);
        });
      return { paused, release: () => release(), restore: () => spy.mockRestore() };
    };
    /** Resolves once `promise` settles or some transaction is waiting on a lock. */
    const settledOrBlocked = async (promise: Promise<unknown>) => {
      let settled = false;
      promise.then(
        () => (settled = true),
        () => (settled = true),
      );
      for (let i = 0; i < 150 && !settled && (await lockWaiters()) === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    it.each([
      ['lost super admin', { isSuperAdmin: false }],
      ['is suspended', { isSuperAdmin: false, suspendedAt: new Date() }],
    ])('is refused with a 403 when the requester %s, writing and sending nothing', async (_, values) => {
      const user = await lockedOut('owner');
      const former = await makeUser('former-staff', values);

      await expect(
        resets.request(user.id, REASON, { userId: former.id, email: former.email }, VERIFIED),
      ).rejects.toThrow(ForbiddenException);
      expect(await resetsOf(user.id)).toEqual([]);
      expect(await auditOf(user.id)).toEqual([]);
      expect(notices).toEqual([]);
    });

    it('refuses the request when the revoke commits first', async () => {
      const user = await lockedOut('owner');
      const hold = holdAudit('super_admin.revoked');
      try {
        // The revoke holds the requester's row, changed but not yet committed.
        const revoking = setSuperAdmin(ds, staff.email, false, fakeNotices);
        await hold.paused;
        const requesting = resets.request(user.id, REASON, staff, VERIFIED);
        await settledOrBlocked(requesting);
        hold.release();

        const [revoked, requested] = await Promise.allSettled([revoking, requesting]);
        expect(revoked).toEqual({ status: 'fulfilled', value: 'changed' });
        expect(requested.status).toBe('rejected');
        expect((requested as PromiseRejectedResult).reason).toBeInstanceOf(ForbiddenException);
      } finally {
        hold.release();
        hold.restore();
      }
      expect(await resetsOf(user.id)).toEqual([]);
      expect(notices).toEqual([]);
    });

    it('cancels a reset whose request was still in flight when the revoke began', async () => {
      const user = await lockedOut('owner');
      const hold = holdAudit('account.factors_reset_requested');
      let revoking!: Promise<unknown>;
      try {
        // The request has checked the requester and inserted its reset, not yet committed.
        const requesting = resets.request(user.id, REASON, staff, VERIFIED);
        await hold.paused;
        revoking = setSuperAdmin(ds, staff.email, false, fakeNotices);
        await settledOrBlocked(revoking);
        hold.release();

        const results = await Promise.allSettled([requesting, revoking]);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      } finally {
        hold.release();
        hold.restore();
      }
      // Not left pending in the name of someone who is no longer staff. Either the
      // revoke cancels it, or the warning's own check, once the revoke has committed,
      // refuses it before anything is sent.
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
      const [cancel] = (await auditOf(user.id)).filter(
        (row: { action: string }) => row.action === 'account.factors_reset_cancelled',
      );
      expect(cancel).toMatchObject({ metadata: { cancelledBy: 'refused', refusal: 'requester_not_staff' } });
      expect(['cli', 'system']).toContain(cancel.actor_email);
      // Never told it is coming after being told it stopped.
      if (notices.some((line) => line.startsWith('requested'))) {
        expect(notices.at(-1)).toBe(`cancelled ${user.email}`);
      }
    });
  });

  // `execute` holds the owner and reads the requester, and the revoke locks both: unless
  // both take them in id order, half of these (requester's id first) can deadlock.
  it('never deadlocks a revoke against the worker running that requester\'s reset', async () => {
    for (let round = 0; round < 30; round += 1) {
      const requester = await makeStaff(`due-requester${round}`);
      const target = await lockedOut(`due-target${round}`);
      const { pending } = await resets.request(target.id, REASON, { userId: requester.id, email: requester.email }, VERIFIED);
      await makeDue(target.id);

      const results = await Promise.allSettled([
        setSuperAdmin(ds, requester.email, false, fakeNotices),
        resets.execute(pending!.id),
      ]);

      for (const result of results) {
        if (result.status === 'rejected') expect(String(result.reason)).not.toMatch(/deadlock/i);
        expect(result.status).toBe('fulfilled');
      }
      // One or the other, never both or neither.
      const [reset] = await resetsOf(target.id);
      const factorsLeft = await countOf('totp_secrets', target.id);
      expect([reset.status, factorsLeft]).toEqual(reset.status === 'completed' ? ['completed', 0] : ['cancelled', 1]);
    }
  });

  describe('two requesters revoked at once', () => {
    /**
     * Each has a reset waiting on the other, made while the target was a tenant: the
     * case where each revoke must lock the other's row as well as its own.
     */
    const crossed = async (round: number) => {
      const first = await lockedOut(`first${round}`);
      const second = await lockedOut(`second${round}`);
      const setStaff = (user: UserEntity, on: boolean) =>
        ds.query(`UPDATE users SET is_super_admin = $2 WHERE id = $1`, [user.id, on]);
      await setStaff(first, true);
      await resets.request(second.id, REASON, { userId: first.id, email: first.email }, VERIFIED);
      await setStaff(first, false);
      await setStaff(second, true);
      await resets.request(first.id, REASON, { userId: second.id, email: second.email }, VERIFIED);
      await setStaff(first, true);
      return [first, second] as const;
    };
    const suspend = async (user: UserEntity) => {
      await ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [user.id]);
      const audit = ds.getRepository(AdminAuditLogEntity);
      return new AdminTenantsService(
        ds.getRepository(UserEntity),
        audit,
        new AdminAuditService(audit),
        fakeNotices, new SeatsService(ds)
      ).suspend(user.id, 'Left the company, access withdrawn', {
        userId: staff.userId,
        email: staff.email,
        ipAddress: '203.0.113.1',
      });
    };

    it('never deadlocks, and cancels both sets of resets', async () => {
      for (let round = 0; round < 30; round += 1) {
        const [first, second] = await crossed(round);
        const revoke = (user: UserEntity) => setSuperAdmin(ds, user.email, false, fakeNotices);
        // A suspension takes the same locks, so every pairing is tried.
        const [one, two] = [
          [revoke, revoke],
          [revoke, suspend],
          [suspend, revoke],
        ][round % 3];

        const results = await Promise.allSettled([one(first), two(second)]);

        for (const result of results) {
          if (result.status === 'rejected') expect(String(result.reason)).not.toMatch(/deadlock/i);
          expect(result.status).toBe('fulfilled');
        }
        expect((await resetsOf(first.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
        expect((await resetsOf(second.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
      }
    });
  });

  /** How many of this database's sessions are waiting for a lock right now. */
  const lockWaitersNow = async (): Promise<number> =>
    (
      await ds.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )
    )[0].n;
  /** Polls until some session waits for a lock, so the step after it is known to be blocked. */
  const untilBlocked = async () => {
    for (let i = 0; i < 250 && (await lockWaitersNow()) === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await lockWaitersNow()).toBeGreaterThan(0);
  };

  /** Holds the first audit entry for `action` until the returned release is called. */
  const holdFirstAudit = (action: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    const record = AdminAuditService.prototype.record;
    let held = false;
    const spy = jest
      .spyOn(AdminAuditService.prototype, 'record')
      .mockImplementation(async function (this: AdminAuditService, entry, manager) {
        if (!held && entry.action === action) {
          held = true;
          reached();
          await gate;
        }
        return record.call(this, entry, manager);
      });
    return { paused, release: () => release(), restore: () => spy.mockRestore() };
  };

  // Whoever holds a super admin's lost key may have asked for resets with it; once the
  // CLI resets those keys, none of those resets may still run on their word.
  describe('a requester whose keys were reset', () => {
    it('cancels every reset they asked for, audited, recorded and told to each owner', async () => {
      const first = await lockedOut('first');
      const second = await lockedOut('second');
      const others = await lockedOut('others');
      const colleague = await makeStaff('colleague');
      await resets.request(first.id, REASON, staff, VERIFIED);
      await resets.request(second.id, REASON, staff, VERIFIED);
      await resets.request(others.id, REASON, { userId: colleague.id, email: colleague.email }, VERIFIED);
      notices.length = 0;

      await resetSuperAdminPasskeys(ds, staff.email, null, () => undefined, fakeNotices);

      for (const target of [first, second]) {
        expect((await resetsOf(target.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
        expect((await auditOf(target.id)).at(-1)).toMatchObject({
          action: 'account.factors_reset_cancelled',
          actor_email: 'cli',
          metadata: { cancelledBy: 'refused', refusal: 'requester_keys_reset', requestedById: staff.userId },
        });
        expect(await eventsOf(target.id)).toContain('factors_reset.cancelled:refused');
      }
      expect((await resetsOf(others.id))[0].status).toBe('pending');
      expect([...notices].sort()).toEqual([`cancelled ${first.email}`, `cancelled ${second.email}`]);
    });

    it('refuses a request made afterwards on a session that passed the guard before', async () => {
      const user = await lockedOut('owner');
      await resetSuperAdminPasskeys(ds, staff.email, null, () => undefined, fakeNotices);

      await expect(resets.request(user.id, REASON, staff, VERIFIED)).rejects.toThrow(ForbiddenException);
      expect(await resetsOf(user.id)).toEqual([]);
      expect(notices).toEqual([]);
    });

    it('cancels a request still in flight when the keys reset began', async () => {
      const user = await lockedOut('owner');
      const hold = holdFirstAudit('account.factors_reset_requested');
      try {
        const requesting = resets.request(user.id, REASON, staff, VERIFIED);
        await hold.paused;
        const resetting = resetSuperAdminPasskeys(ds, staff.email, null, () => undefined, fakeNotices);
        await new Promise((resolve) => setTimeout(resolve, 200));
        hold.release();
        const results = await Promise.allSettled([requesting, resetting]);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      } finally {
        hold.release();
        hold.restore();
      }
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
    });

    // A request whose transaction began after the keys reset's, but took the admin's row
    // first, is earlier than the reset in every sense but `now()`, the transaction's
    // start. `factors_reset_at` must be later than its `requested_at`, or the cancel's
    // `before_keys_reset` scope and `execute`'s check would both take it for one made
    // with a new key.
    it('cancels a request that took the admin\'s row first, though its transaction began later', async () => {
      const user = await lockedOut('owner');
      const holder = ds.createQueryRunner();
      await holder.connect();
      let resetting!: Promise<unknown>;
      try {
        await holder.startTransaction();
        await holder.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [staff.userId]);
        resetting = resetSuperAdminPasskeys(ds, staff.email, null, () => undefined, fakeNotices);
        await untilBlocked();
        // What `request` writes, at the time it would: after the keys reset began.
        await holder.query(
          `INSERT INTO factor_resets (user_id, requested_by_id, requested_by_email, reason, requested_at, execute_after)
           VALUES ($1, $2, $3, $4, clock_timestamp(), now() + interval '72 hours')`,
          [user.id, staff.userId, staff.email, REASON],
        );
        await holder.commitTransaction();
        await resetting;
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
        await resetting?.catch(() => undefined);
      }
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
      expect((await auditOf(user.id)).at(-1)).toMatchObject({
        metadata: { cancelledBy: 'refused', refusal: 'requester_keys_reset' },
      });
    });

    // In case the cancel after the keys reset never ran: the worker checks too.
    it('is refused by the worker if it was requested before the keys were reset', async () => {
      const user = await lockedOut('owner');
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      // Straight in the database, so only the check in execute can catch it.
      await ds.query(`UPDATE users SET factors_reset_at = clock_timestamp() WHERE id = $1`, [staff.userId]);
      notices.length = 0;

      await expect(resets.execute(pending!.id)).resolves.toBe(false);
      expect(await countOf('totp_secrets', user.id)).toBe(1);
      expect((await auditOf(user.id)).at(-1)).toMatchObject({
        action: 'account.factors_reset_cancelled',
        metadata: { resetId: pending!.id, cancelledBy: 'refused', refusal: 'requester_keys_reset' },
      });
      expect(notices).toEqual([`cancelled ${user.email}`]);
    });

    it('lets them ask again, and the reset run, once they have enrolled a new key', async () => {
      const user = await lockedOut('owner');
      await resetSuperAdminPasskeys(ds, staff.email, null, () => undefined, fakeNotices);
      await addPasskey(staff.userId);

      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      await makeDue(user.id);
      await expect(resets.execute(pending!.id)).resolves.toBe(true);
    });
  });

  // A rogue super admin about to be revoked must not be able to keep the revoke from
  // landing by asking for resets as fast as they can.
  describe('a revoke while its requester keeps asking', () => {
    // The savepoint retry in `lockResetTargetsOf`: a reset that commits after the second
    // step read the pending ones but before it holds their owners. Written straight to
    // the table while an owner's row is held, so the timing is exact; `request` itself
    // can no longer land there, which is why nothing else reaches this path.
    it('takes the locks again, and cancels it too, when a reset lands while it waits for them', async () => {
      const held = await lockedOut('held');
      const late = await lockedOut('late');
      await resets.request(held.id, REASON, staff, VERIFIED);
      await ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [staff.userId]);

      const query = EntityManager.prototype.query;
      let retries = 0;
      const spy = jest
        .spyOn(EntityManager.prototype, 'query')
        .mockImplementation(async function (this: EntityManager, sql: string, parameters?: unknown[]) {
          if (sql === 'ROLLBACK TO SAVEPOINT lock_reset_targets') retries += 1;
          return query.call(this, sql, parameters);
        });
      const holder = ds.createQueryRunner();
      await holder.connect();
      let cancelling!: Promise<unknown>;
      try {
        await holder.startTransaction();
        await holder.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [held.id]);
        cancelling = cancelAllRequestedBy((work) => ds.transaction(work), staff.userId, 'all', 'requester_not_staff', {
          userId: null,
          email: 'cli',
        });
        await untilBlocked();
        await ds.query(
          `INSERT INTO factor_resets (user_id, requested_by_id, requested_by_email, reason, execute_after)
           VALUES ($1, $2, $3, $4, now() + interval '72 hours')`,
          [late.id, staff.userId, staff.email, REASON],
        );
        await holder.commitTransaction();
        await expect(cancelling).resolves.toHaveLength(2);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
        await cancelling?.catch(() => undefined);
        spy.mockRestore();
      }
      expect(retries).toBe(1);
      for (const target of [held, late]) {
        expect((await resetsOf(target.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
        expect((await auditOf(target.id)).at(-1)).toMatchObject({
          action: 'account.factors_reset_cancelled',
          metadata: { refusal: 'requester_not_staff' },
        });
      }
    });

    /**
     * Requests on several connections, each starting the moment the last one ended, so
     * at every instant some request holds the requester's row: most answer 409 (a reset
     * already waits) or 403 (once the change has landed), and each takes its locks before
     * it finds that out. When requests took the row FOR SHARE, each new one could take it
     * alongside those already holding it, ahead of a revoke queued for it, and the revoke
     * waited until the flood stopped. With every taker queueing for one mode, the revoke
     * waits only for the requests that were ahead of it.
     */
    const FLOOD_MS = 6000;
    it.each([
      ['a revoke', 'revoke'],
      ['a keys reset', 'passkeys'],
      ['a suspension', 'suspend'],
    ] as const)('lets %s through while the requester asks without pause', async (_, change) => {
      const requester = await makeStaff('flooder');
      const actor = { userId: requester.id, email: requester.email };
      const targets: UserEntity[] = [];
      for (let i = 0; i < 6; i += 1) targets.push(await lockedOut(`flood-${i}`));
      // Only staff already revoked can be suspended; their requests are refused, still under the lock.
      if (change === 'suspend') await setSuperAdmin(ds, requester.email, false, fakeNotices);
      const audit = ds.getRepository(AdminAuditLogEntity);
      const run = {
        revoke: () => setSuperAdmin(ds, requester.email, false, fakeNotices),
        passkeys: () => resetSuperAdminPasskeys(ds, requester.email, null, () => undefined, fakeNotices),
        suspend: () =>
          new AdminTenantsService(ds.getRepository(UserEntity), audit, new AdminAuditService(audit), fakeNotices, new SeatsService(ds))
            .suspend(requester.id, 'Left the company, access withdrawn', {
              userId: staff.userId,
              email: staff.email,
              ipAddress: '203.0.113.1',
            }),
      }[change];

      let flooding = true;
      const stopFlood = setTimeout(() => (flooding = false), FLOOD_MS);
      const loops = [...targets, ...targets].map(async (target) => {
        while (flooding) await resets.request(target.id, REASON, actor, VERIFIED).catch(() => undefined);
      });
      let landedDuringFlood: boolean;
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await run();
        landedDuringFlood = flooding;
      } finally {
        flooding = false;
        clearTimeout(stopFlood);
        await Promise.all(loops);
      }
      // Landed while the flood still ran, not once it stopped.
      expect(landedDuringFlood).toBe(true);
      for (const target of targets) {
        expect((await resetsOf(target.id)).filter((row) => row.status === 'pending')).toEqual([]);
      }
    }, 30000);
  });

  // A cancel can land between the sweep reading an unsent warning and sending it: the
  // owner must not then be told a reset is coming after being told it stopped.
  describe("the owner's warning racing a cancel", () => {
    const unsentFor = async (user: UserEntity) => {
      email.delivers = false;
      const { pending } = await resets.request(user.id, REASON, staff, VERIFIED);
      email.delivers = true;
      notices.length = 0;
      return pending!;
    };
    /** Runs `between` once the sweep has read the unsent warnings, before it sends any. */
    const afterSweepReads = (between: () => Promise<unknown>) => {
      const repository = (resets as unknown as { resets: Repository<FactorResetEntity> }).resets;
      const find = repository.find.bind(repository);
      return jest.spyOn(repository, 'find').mockImplementationOnce(async (options) => {
        const rows = await find(options);
        await between();
        return rows;
      });
    };

    it('sends nothing when the owner cancels after the sweep read it', async () => {
      const user = await lockedOut('owner');
      await unsentFor(user);
      const spy = afterSweepReads(() => resets.cancelByOwner({ userId: user.id, email: user.email }));
      try {
        await resets.executeDue();
      } finally {
        spy.mockRestore();
      }
      expect(notices).toEqual([`cancelled ${user.email}`]);
    });

    it('sends nothing, and refuses the reset, when the requester stopped being staff after the read', async () => {
      const user = await lockedOut('owner');
      const pending = await unsentFor(user);
      const spy = afterSweepReads(() =>
        ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [staff.userId]),
      );
      try {
        await resets.executeDue();
      } finally {
        spy.mockRestore();
      }
      expect(notices.filter((line) => line.startsWith('requested'))).toEqual([]);
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'refused' });
      expect((await auditOf(user.id)).at(-1)).toMatchObject({
        action: 'account.factors_reset_cancelled',
        metadata: { resetId: pending.id, cancelledBy: 'refused', refusal: 'requester_not_staff' },
      });
    });

    it('tells the owner again that it stopped when the cancel lands during the send', async () => {
      const user = await lockedOut('owner');
      await unsentFor(user);
      const stub = fakeNotices as unknown as {
        sendFactorResetRequested: (owner: UserEntity, at: Date) => Promise<boolean>;
      };
      const send = stub.sendFactorResetRequested;
      // The provider takes the warning only after the cancel's own notice has gone.
      const spy = jest.spyOn(stub, 'sendFactorResetRequested').mockImplementationOnce(async (owner, at) => {
        await resets.cancelByOwner({ userId: user.id, email: user.email });
        return send.call(stub, owner, at);
      });
      try {
        await resets.executeDue();
      } finally {
        spy.mockRestore();
      }
      expect(notices.filter((line) => line.startsWith('requested'))).toHaveLength(1);
      expect(notices.at(-1)).toBe(`cancelled ${user.email}`);
      expect((await resetsOf(user.id))[0]).toMatchObject({ status: 'cancelled', noticeSentAt: null });
    });
  });
});

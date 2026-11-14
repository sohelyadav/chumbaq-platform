import * as bcrypt from 'bcrypt';
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BillingConfig } from '../../config/billing.config';
import { DataSource } from 'typeorm';
import type {
  StaffEnrolmentStarted,
  StaffLoginResult,
  StaffProfile,
  StaffReauthenticated,
  StaffRefreshed,
  StaffSecondFactor,
  StaffSessionInfo,
  StaffSignedIn,
} from '@chumbaq/shared';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AuthEventsService, RequestContext } from '../auth-events/auth-events.service';
import { AuthService, compareWithNobody, INVALID_HANDLE_MESSAGE } from '../auth/auth.service';
import { FactorChangeProofService } from '../auth/factor-change-proof.service';
import { PreAuthService } from '../auth/pre-auth.service';
import { SecondFactorsService } from '../auth/second-factors.service';
import { spendStaffEnrolmentAllowance } from '../auth/staff-enrolment-allowances';
import { StaffSessionsService } from '../auth/staff-sessions.service';
import { StaffAlarmsService } from './staff-alarms.service';
import { STAFF_TOKEN_AUDIENCE, STAFF_TOKEN_TYPE, StaffTokensService } from '../auth/staff-tokens.service';
import { TotpService } from '../auth/totp.service';
import { FactorResetsService } from '../factor-resets/factor-resets.service';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import type { AuthenticatedStaff } from './staff-principal';
import {
  STAFF_ENROLMENT_BLOCKED_MESSAGE,
  STAFF_PASSKEY_NEEDED_MESSAGE,
  STAFF_SESSION_ENDED_MESSAGE,
  STAFF_SESSION_IDLE_MESSAGE,
} from './staff-messages';

const LOGIN_REFUSED = 'Invalid email or password';
const CODE_REFUSED = 'That code is not right. Please try again.';

/** A full sign-in, with the refresh token the controller puts in the cookie. */
export interface StaffSignInResult {
  body: StaffSignedIn;
  refreshToken: string;
  sessionEndsAt: Date;
}

export interface StaffRefreshResult {
  body: StaffRefreshed;
  /** Null for a retry within the grace period, which leaves the cookie as it is. */
  refreshToken: string | null;
  sessionEndsAt: Date;
}

/**
 * Staff sign-in on the admin app. Passkey first; a password is only ever a first step:
 * it leads to a second factor, or, for a staff member with no staff factor yet, to an
 * enrolment-only session that can do nothing but enrol one. A password alone never
 * signs in.
 *
 * Shares the customer app's lockout (`assertUnderLoginLimit`, per address in
 * `auth_events`), so failures on either app count towards one limit. Failures for
 * unknown or non-staff addresses go to `auth_events` only: an unauthenticated route must
 * not be able to fill the append-only staff log, or record customers' addresses in it.
 */
@Injectable()
export class StaffAuthService {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly events: AuthEventsService,
    private readonly preAuth: PreAuthService,
    private readonly secondFactors: SecondFactorsService,
    private readonly sessions: StaffSessionsService,
    private readonly alarms: StaffAlarmsService,
    private readonly tokens: StaffTokensService,
    private readonly totp: TotpService,
    private readonly proofs: FactorChangeProofService,
    private readonly audit: AdminAuditService,
    private readonly notices: SecurityNoticesService,
    private readonly factorResets: FactorResetsService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  private get passkeyRequired(): boolean {
    return this.config.get<boolean>('webauthn.superAdminPasskeyRequired') === true;
  }

  /**
   * The staff factors that may sign in and re-authenticate here. While passkeys are
   * required that is staff passkeys only (`STAFF_PASSKEY_NEEDED_MESSAGE`): an account
   * whose only staff factor is an authenticator app is treated as having none, so it
   * enrols a passkey with an operator's code like anyone else.
   */
  async staffSignInMethods(userId: string): Promise<StaffSecondFactor[]> {
    const methods = await this.secondFactors.staffMethodsFor(userId);
    return this.passkeyRequired ? methods.filter((m) => m !== 'totp') : methods;
  }

  // ---- Session plumbing

  private get limits() {
    return {
      idleMs: this.config.getOrThrow<number>('staff.idleTimeoutMs'),
      maxAgeMs: this.config.getOrThrow<number>('staff.maxAgeMs'),
    };
  }

  /** The session's absolute end: sign-in plus its maximum length, which nothing extends. */
  sessionEnd(createdAt: Date, enrolmentOnly: boolean): Date {
    const lifetime = this.config.getOrThrow<number>(enrolmentOnly ? 'staff.enrolmentTtlMs' : 'staff.maxAgeMs');
    return new Date(new Date(createdAt).getTime() + lifetime);
  }

  sessionInfo(sessionId: string, enrolmentOnly: boolean, accessExpiresAt: Date, createdAt: Date): StaffSessionInfo {
    return {
      id: sessionId,
      enrolmentOnly,
      accessExpiresAt: accessExpiresAt.toISOString(),
      expiresAt: this.sessionEnd(createdAt, enrolmentOnly).toISOString(),
      idleTimeoutSeconds: Math.floor(this.config.getOrThrow<number>('staff.idleTimeoutMs') / 1000),
    };
  }

  /** Never outliving the session, so the last token of a session ends with it. */
  async issueAccess(
    user: Pick<UserEntity, 'id' | 'email' | 'sessionVersion'>,
    sessionId: string,
    auth: { amr: string[]; authenticatedAt: Date | null },
    createdAt: Date,
    enrolmentOnly: boolean,
  ): Promise<{ accessToken: string; session: StaffSessionInfo }> {
    const ttl = this.config.getOrThrow<number>(enrolmentOnly ? 'staff.enrolmentTtlMs' : 'staff.accessTtlMs');
    const untilEnd = this.sessionEnd(createdAt, enrolmentOnly).getTime() - Date.now();
    const { token, expiresAt } = await this.tokens.signAccess(
      {
        sub: user.id,
        email: user.email,
        type: STAFF_TOKEN_TYPE,
        aud: STAFF_TOKEN_AUDIENCE,
        sid: sessionId,
        sv: user.sessionVersion,
        amr: auth.amr,
        // Unknown counts as long ago, which only ever asks for a re-authentication.
        auth_time: auth.authenticatedAt ? Math.floor(new Date(auth.authenticatedAt).getTime() / 1000) : 0,
        ...(enrolmentOnly ? { enr: true as const } : {}),
      },
      Math.min(ttl, untilEnd),
    );
    return { accessToken: token, session: this.sessionInfo(sessionId, enrolmentOnly, expiresAt, createdAt) };
  }

  /** A known staff member's failure, in the staff log as well as in `auth_events`. */
  async auditFailure(user: UserEntity, reason: string, context: RequestContext): Promise<void> {
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'staff.sign_in_failed',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { reason },
      ipAddress: context.ipAddress ?? null,
    });
    // Counted from the audit rows, so the one just written is included. Off the request
    // path: the answer must not wait on the count or on emailing staff, so a staff
    // email's refusal takes no longer than any other.
    this.alarms.failedLater(user.email, context.ipAddress ?? null);
  }

  // ---- Signing in

  async login(
    email: string,
    password: string,
    context: RequestContext = {},
    enrolmentCode?: string,
  ): Promise<StaffLoginResult> {
    await this.auth.assertUnderLoginLimit(email, context);

    const user = await this.users.findByEmail(email);
    const fail = async (reason: string, account: UserEntity | null) => {
      await this.events.record({ type: 'login.failed', userId: account?.id, email, reason, ...context });
      return new UnauthorizedException(LOGIN_REFUSED);
    };
    if (!user) {
      await compareWithNobody(password);
      throw await fail('unknown_email', null);
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      if (user.isSuperAdmin) await this.auditFailure(user, 'wrong_password', context);
      throw await fail('wrong_password', user);
    }
    // After the password, and the same answer as a wrong one, so the admin app tells
    // nobody which addresses are staff.
    if (user.isSuperAdmin !== true || user.suspendedAt) {
      throw await fail(user.suspendedAt ? 'suspended' : 'not_staff', user);
    }

    const methods = await this.staffSignInMethods(user.id);
    if (methods.length > 0) {
      // No `login.succeeded` yet: that lifts the failure limit, and the password alone must not.
      await this.events.record({ type: 'login.password_accepted', userId: user.id, email, ...context });
      const handle = await this.preAuth.create({
        userId: user.id,
        sessionVersion: user.sessionVersion,
        amr: ['pwd'],
        audience: 'staff',
      });
      return { step: 'second_factor', handle, methods };
    }

    // No staff factor. Someone with no passkey at all (the seeded dev admin) can only
    // have been signing in with a password, so enrolling from one weakens nothing,
    // unless passkeys are required, when a password alone was never meant to be enough.
    // Anyone else needs an operator's one-time code (`admin:staff-enrolment`), handed
    // over out of band: a password can be reset by whoever holds the mailbox, so a
    // password alone, even within an operator's allowance, must not plant a staff factor.
    const needsCode = this.passkeyRequired || (await this.secondFactors.hasAnyPasskey(user.id));
    if (!needsCode) return this.startEnrolment(user, context, null);

    // Only reached with the right password, so the code is never tested for anyone who
    // lacks it, and every refusal below is the one answer whatever was wrong.
    const allowanceId = enrolmentCode
      ? await spendStaffEnrolmentAllowance(this.dataSource, user.id, enrolmentCode, context.ipAddress ?? null)
      : null;
    if (!allowanceId) {
      if (enrolmentCode) {
        // Counts towards the shared failure limit, which is what bounds guessing; a
        // missing code is just the first step and counts for nothing.
        await this.events.record({
          type: 'login.failed',
          userId: user.id,
          email,
          reason: 'enrolment_code_refused',
          ...context,
        });
        await this.auditFailure(user, 'enrolment_code_refused', context);
      } else {
        await this.events.record({
          type: 'login.password_accepted',
          userId: user.id,
          email,
          reason: 'staff_enrolment_blocked',
          ...context,
        });
      }
      throw new ForbiddenException(STAFF_ENROLMENT_BLOCKED_MESSAGE);
    }
    return this.startEnrolment(user, context, allowanceId);
  }

  private async startEnrolment(
    user: UserEntity,
    context: RequestContext,
    allowanceId: string | null,
  ): Promise<StaffEnrolmentStarted> {
    const now = new Date();
    const { sessionId, createdAt } = await this.sessions.create(
      user.id,
      context,
      { amr: ['pwd'], authenticatedAt: now },
      user.sessionVersion,
      true,
    );
    await this.events.record({
      type: 'login.password_accepted',
      userId: user.id,
      email: user.email,
      sessionId,
      reason: 'staff_enrolment',
      ...context,
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'staff.enrolment_started',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      // Which operator code let them in, matching that code's `staff.enrolment_allowed`.
      metadata: allowanceId ? { sessionId, allowanceId } : { sessionId },
      ipAddress: context.ipAddress ?? null,
    });
    this.notices.staffEnrolmentStarted(user, context.ipAddress);
    const issued = await this.issueAccess(user, sessionId, { amr: ['pwd'], authenticatedAt: now }, createdAt, true);
    return { step: 'enrol', ...issued };
  }

  /** The second step after a password, with an authenticator app code. */
  async loginWithTotp(handle: string, code: string, context: RequestContext = {}): Promise<StaffSignInResult> {
    const user = await this.pendingUser(handle, context);
    // Never offered while passkeys are required; refused here too, before the code is tried.
    if (this.passkeyRequired) throw new UnauthorizedException(STAFF_PASSKEY_NEEDED_MESSAGE);
    if (!(await this.totp.acceptCode(user.id, code))) {
      await this.events.record({
        type: 'login.failed',
        userId: user.id,
        email: user.email,
        reason: 'totp_failed',
        ...context,
      });
      await this.auditFailure(user, 'totp_failed', context);
      throw new UnauthorizedException(CODE_REFUSED);
    }
    return this.completeSecondFactor(handle, 'totp', context);
  }

  /** Whose handle this is, for a staff handle only; counts against the shared limit. */
  async pendingUser(handle: string, context: RequestContext): Promise<UserEntity> {
    const state = await this.preAuth.peekFor(handle, 'staff');
    if (!state) throw new UnauthorizedException(INVALID_HANDLE_MESSAGE);
    const user = await this.users.findById(state.userId);
    if (!user) throw new UnauthorizedException(INVALID_HANDLE_MESSAGE);
    await this.auth.assertUnderLoginLimit(user.email, context);
    return user;
  }

  /** The caller has verified the factor. Spending the handle makes one factor sign in once. */
  async completeSecondFactor(
    handle: string,
    factor: 'webauthn' | 'totp',
    context: RequestContext,
  ): Promise<StaffSignInResult> {
    const state = await this.preAuth.consumeFor(handle, 'staff');
    if (!state) throw new UnauthorizedException(INVALID_HANDLE_MESSAGE);
    const user = await this.users.findById(state.userId);
    // Everything the password step checked can have changed in the five minutes since.
    if (!user || user.sessionVersion !== state.sessionVersion || user.isSuperAdmin !== true || user.suspendedAt) {
      throw new UnauthorizedException(INVALID_HANDLE_MESSAGE);
    }
    return this.finishSignIn(user, [...state.amr, factor], context);
  }

  /** Every full staff sign-in ends here. */
  async finishSignIn(user: UserEntity, amr: string[], context: RequestContext): Promise<StaffSignInResult> {
    const authenticatedAt = new Date();
    const { sessionId, refreshToken, createdAt } = await this.sessions.create(
      user.id,
      context,
      { amr, authenticatedAt },
      user.sessionVersion,
      false,
    );
    // Lifts the shared failure limit, as a customer sign-in does.
    await this.events.record({ type: 'login.succeeded', userId: user.id, email: user.email, sessionId, ...context });
    // A factor was used, so the account was never locked out: as `AuthService.finishSignIn`.
    await this.factorResets.cancelOnFactorUse(user, context);
    await this.factorResets.voidStaffLinksOnSignIn(user, 'factor', context);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'staff.signed_in',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { amr, sessionId },
      ipAddress: context.ipAddress ?? null,
    });
    this.alarms.signedInLater(user, sessionId, context);
    const issued = await this.issueAccess(user, sessionId, { amr, authenticatedAt }, createdAt, false);
    return {
      body: { step: 'signed_in', ...issued },
      refreshToken: refreshToken as string,
      sessionEndsAt: this.sessionEnd(createdAt, false),
    };
  }

  // ---- The session

  async refresh(refreshToken: string, context: RequestContext = {}): Promise<StaffRefreshResult> {
    const rotation = await this.sessions.rotate(refreshToken, this.limits);
    const refuse = async (reason: string, message = STAFF_SESSION_ENDED_MESSAGE) => {
      await this.events.record({
        type: 'refresh.failed',
        userId: rotation.userId ?? null,
        sessionId: rotation.sessionId ?? null,
        reason,
        ...context,
      });
      return new UnauthorizedException(message);
    };

    if (rotation.outcome === 'reused') {
      const user = await this.users.findById(rotation.userId);
      await this.events.record({
        type: 'refresh.reuse_detected',
        userId: rotation.userId,
        email: user?.email,
        sessionId: rotation.sessionId,
        ...context,
      });
      if (user) {
        await this.audit.record({
          actorId: user.id,
          actorEmail: user.email,
          action: 'staff.session_revoked',
          targetType: 'user',
          targetId: user.id,
          targetLabel: user.email,
          metadata: { reason: 'replay', sessionId: rotation.sessionId },
          ipAddress: context.ipAddress ?? null,
        });
        this.notices.sessionReplayed(user);
      }
      throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
    }
    if (rotation.outcome !== 'rotated' && rotation.outcome !== 'retried') {
      if (rotation.outcome === 'idle') throw await refuse('staff_idle', STAFF_SESSION_IDLE_MESSAGE);
      throw await refuse(rotation.outcome === 'expired' ? 'staff_session_expired' : 'staff_session_revoked');
    }

    const user = await this.users.findById(rotation.userId);
    if (
      !user ||
      user.isSuperAdmin !== true ||
      user.suspendedAt ||
      user.sessionVersion !== rotation.sessionVersion
    ) {
      await this.sessions.revoke(rotation.sessionId, rotation.userId, 'session_version');
      throw await refuse('staff_session_version');
    }
    await this.events.record({
      type: 'refresh.succeeded',
      userId: user.id,
      email: user.email,
      sessionId: rotation.sessionId,
      reason: rotation.outcome === 'retried' ? 'retried_within_grace' : null,
      ...context,
    });
    const body = await this.issueAccess(user, rotation.sessionId, rotation, rotation.createdAt, false);
    return {
      body,
      refreshToken: rotation.refreshToken,
      sessionEndsAt: this.sessionEnd(rotation.createdAt, false),
    };
  }

  async logout(staff: AuthenticatedStaff, context: RequestContext = {}): Promise<void> {
    await this.sessions.revoke(staff.sessionId, staff.userId, 'signed_out');
    await this.events.record({
      type: 'logout',
      userId: staff.userId,
      email: staff.email,
      sessionId: staff.sessionId,
      ...context,
    });
    await this.audit.record({
      actorId: staff.userId,
      actorEmail: staff.email,
      action: 'staff.signed_out',
      targetType: 'user',
      targetId: staff.userId,
      targetLabel: staff.email,
      metadata: { sessionId: staff.sessionId },
      ipAddress: context.ipAddress ?? null,
    });
  }

  async profile(staff: AuthenticatedStaff): Promise<StaffProfile> {
    const [user, row, passkeys, methods] = await Promise.all([
      this.users.findById(staff.userId),
      this.sessions.find(staff.sessionId, staff.userId),
      this.secondFactors.passkeyCount(staff.userId, 'staff'),
      this.staffSignInMethods(staff.userId),
    ]);
    if (!user || !row) throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
    const accessExpiresAt = new Date((staff.accessExp ?? Math.floor(Date.now() / 1000)) * 1000);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      enrolmentOnly: staff.enrolmentOnly,
      factors: { passkeys, totp: methods.includes('totp') },
      session: this.sessionInfo(row.id, row.enrolmentOnly, accessExpiresAt, row.createdAt),
      billingEnabled: this.config.get<BillingConfig>('billing')?.enabled === true,
    };
  }

  // ---- Re-authentication

  async reauthWithTotp(staff: AuthenticatedStaff, code: string, context: RequestContext = {}): Promise<StaffReauthenticated> {
    // 403, not 401, as for a wrong code below.
    if (this.passkeyRequired) throw new ForbiddenException(STAFF_PASSKEY_NEEDED_MESSAGE);
    await this.auth.assertUnderLoginLimit(staff.email, context);
    const user = await this.users.findById(staff.userId);
    if (!user) throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
    if (!(await this.totp.acceptCode(user.id, code))) {
      await this.events.record({
        type: 'login.failed',
        userId: user.id,
        email: user.email,
        sessionId: staff.sessionId,
        reason: 'reauth_totp_failed',
        ...context,
      });
      await this.auditFailure(user, 'reauth_totp_failed', context);
      // 403, not 401: a 401 makes the admin app refresh and retry, then sign the person out.
      throw new ForbiddenException(CODE_REFUSED);
    }
    return this.issueReauthenticated(staff, user, 'totp', context);
  }

  /** The caller has verified the factor. Leaves the single-use proof a factor change spends. */
  async issueReauthenticated(
    staff: AuthenticatedStaff,
    user: UserEntity,
    method: 'webauthn' | 'totp',
    context: RequestContext,
  ): Promise<StaffReauthenticated> {
    const auth = await this.sessions.markAuthenticated(staff.sessionId, user.id, method);
    if (!auth) throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
    await this.proofs.leave({ userId: user.id, sessionId: staff.sessionId, audience: 'staff' });
    await this.events.record({
      type: 'reauth.succeeded',
      userId: user.id,
      email: user.email,
      sessionId: staff.sessionId,
      reason: method,
      ...context,
    });
    await this.factorResets.cancelOnFactorUse(user, context);
    await this.factorResets.voidStaffLinksOnSignIn(user, 'factor', context);
    const { accessToken } = await this.issueAccess(user, staff.sessionId, auth, auth.createdAt, false);
    return { accessToken };
  }
}

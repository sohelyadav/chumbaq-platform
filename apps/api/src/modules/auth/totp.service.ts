import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Not, Repository } from 'typeorm';
import { AuthEventsService, RequestContext } from '../auth-events/auth-events.service';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService, SignedIn } from './auth.service';
import { TotpSecretEntity } from './entities/totp-secret.entity';
import { WebauthnCredentialEntity } from './entities/webauthn-credential.entity';
import { MfaCryptoService } from './mfa-crypto.service';
import { FactorChangeProofService } from './factor-change-proof.service';
import { PreAuthService } from './pre-auth.service';
import { RecoveryCodesService } from './recovery-codes.service';
import { SecondFactorMethod, SecondFactorsService } from './second-factors.service';
import { SessionsService } from './sessions.service';
import { assertSessionStillCurrent } from './session-still-current';
import { base32Encode, generateTotpSecret, matchTotpStep, otpauthUri } from './totp';
import { STAFF_MANAGE_IN_ADMIN_MESSAGE } from '../staff-auth/staff-messages';

const ISSUER = 'Chumbaq';
const CODE_REFUSED = 'That code is not right. Please try again.';
const FLOW_EXPIRED = 'Your sign-in has expired. Please start again.';
/** A super admin with a customer passkey: see `SecondFactorsService.totpUsableByCustomer`. */
export const USE_PASSKEY_MESSAGE = 'Use your passkey to continue.';

export interface FactorStatus {
  canEnrolTotp: boolean;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  /** Has a factor to recover, and is not staff, who never get recovery codes. */
  canManageRecoveryCodes: boolean;
  /** What this account can confirm it is them with, which is also what sign-in asks for. */
  methods: SecondFactorMethod[];
}

interface Principal {
  userId: string;
  email: string;
  sessionId?: string;
  sessionVersion?: number;
}

/** A code is digits however it was typed. Anything else simply will not match. */
const digitsOf = (code: string) => code.replace(/[\s-]/g, '');

/**
 * Authenticator apps and recovery codes. In the customer app they are for tenants: a
 * super admin's authenticator app is a staff factor, enrolled and removed only in the
 * admin app (`StaffFactorsService`, through the `*ForStaff` helpers here), and staff
 * never get or use recovery codes. Recovery codes satisfy a sign-in but never replace a
 * factor outright. A password reset leaves all of this in place.
 */
@Injectable()
export class TotpService {
  constructor(
    @InjectRepository(TotpSecretEntity)
    private readonly secrets: Repository<TotpSecretEntity>,
    private readonly recoveryCodes: RecoveryCodesService,
    private readonly secondFactors: SecondFactorsService,
    private readonly crypto: MfaCryptoService,
    private readonly users: UsersService,
    private readonly preAuth: PreAuthService,
    private readonly proofs: FactorChangeProofService,
    private readonly sessions: SessionsService,
    private readonly auth: AuthService,
    private readonly events: AuthEventsService,
    private readonly notices: SecurityNoticesService,
  ) {}

  private async requireUser(userId: string): Promise<UserEntity> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  /**
   * An unverified address and a team-created account are the two ways to plant a factor
   * on an account that is not really yours. See `PasskeysService.assertMayEnrol`.
   */
  private assertMayEnrol(user: UserEntity): void {
    if (user.isSuperAdmin) {
      throw new ForbiddenException(STAFF_MANAGE_IN_ADMIN_MESSAGE);
    }
    if (user.managedByTeamId) {
      throw new ForbiddenException('Set your own password before adding two-factor sign-in.');
    }
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Verify your email address before adding two-factor sign-in.');
    }
    if (!this.crypto.isConfigured) {
      throw new ForbiddenException('Two-factor sign-in is not available right now.');
    }
  }

  // ---- Managing

  async status(userId: string): Promise<FactorStatus> {
    const user = await this.requireUser(userId);
    const [totpEnabled, recoveryCodesRemaining, methods] = await Promise.all([
      this.secrets.existsBy({ userId, confirmedAt: Not(IsNull()) }),
      this.recoveryCodes.remaining(userId),
      this.secondFactors.methodsFor(user),
    ]);
    let canEnrolTotp = !totpEnabled;
    try {
      this.assertMayEnrol(user);
    } catch {
      canEnrolTotp = false;
    }
    const canManageRecoveryCodes =
      !user.isSuperAdmin && (methods.includes('totp') || methods.includes('webauthn'));
    return { canEnrolTotp, totpEnabled, recoveryCodesRemaining, canManageRecoveryCodes, methods };
  }

  /**
   * The only time the secret leaves here. Starting again replaces an unconfirmed secret,
   * and the conditional upsert means nothing can replace a confirmed one.
   */
  async setup(principal: Principal): Promise<{ secret: string; uri: string }> {
    await this.proofs.assertHeld(principal);
    const user = await this.requireUser(principal.userId);
    this.assertMayEnrol(user);
    return this.startSecret(user);
  }

  /**
   * The insert behind both apps' setup. The caller has checked who may enrol. Starting
   * again replaces an unconfirmed secret; nothing replaces a confirmed one.
   */
  async startSecret(user: UserEntity): Promise<{ secret: string; uri: string }> {
    const secret = generateTotpSecret();
    const rows: unknown[] = await this.secrets.query(
      `INSERT INTO totp_secrets (user_id, secret_ciphertext)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_ciphertext = EXCLUDED.secret_ciphertext, created_at = now()
         WHERE totp_secrets.confirmed_at IS NULL
       RETURNING user_id`,
      [user.id, this.crypto.encrypt(user.id, secret)],
    );
    if (rows.length === 0) {
      throw new ConflictException('This account already has an authenticator app.');
    }
    return { secret: base32Encode(secret), uri: otpauthUri(secret, user.email, ISSUER) };
  }

  /**
   * A mistyped code leaves the proof unspent, because mistyping is ordinary here and
   * the app has only just been set up. Recovery codes come back once, from this call.
   */
  async confirm(
    principal: Principal,
    code: string,
    context: RequestContext = {},
  ): Promise<{ recoveryCodes: string[] }> {
    await this.proofs.assertHeld(principal);
    const user = await this.requireUser(principal.userId);
    this.assertMayEnrol(user);

    const row = await this.secrets.findOneBy({ userId: user.id, confirmedAt: IsNull() });
    if (!row) throw new BadRequestException('That took too long. Please start again.');
    const step = matchTotpStep(
      this.crypto.decrypt(user.id, row.secretCiphertext),
      digitsOf(code),
      Date.now(),
      0,
    );
    if (step === null) throw new BadRequestException(CODE_REFUSED);

    await this.proofs.spend(principal);
    const recoveryCodes = await this.secrets.manager.transaction(async (manager) => {
      // The proof was checked before this lock; a staff reset may have committed since.
      await assertSessionStillCurrent(manager, await this.users.findByIdForUpdate(user.id, manager), principal);
      const confirmed = await manager
        .createQueryBuilder()
        .update(TotpSecretEntity)
        .set({ confirmedAt: () => 'now()', lastUsedStep: String(step) })
        .where('user_id = :userId AND confirmed_at IS NULL', { userId: user.id })
        .execute();
      if (!confirmed.affected) {
        throw new ConflictException('This account already has an authenticator app.');
      }
      return this.recoveryCodes.replace(user.id, manager);
    });

    await this.events.record({
      type: 'totp.enabled',
      userId: user.id,
      email: user.email,
      sessionId: principal.sessionId,
      ...context,
    });
    await this.sessions.revokeOthers(user.id, principal.sessionId as string);
    this.notices.totpChanged(user, 'added');
    return { recoveryCodes };
  }

  /**
   * Recovery codes go with the last factor, since they would have nothing to recover.
   * Refused for staff, whose authenticator app is a staff factor: removing it here would
   * skip the admin app's last-factor rule.
   */
  async disable(principal: Principal, context: RequestContext = {}): Promise<void> {
    await this.refuseStaff(principal.userId);
    await this.proofs.spend(principal);
    const user = await this.secrets.manager.transaction(async (manager) => {
      const owner = await this.users.findByIdForUpdate(principal.userId, manager);
      if (!owner) throw new UnauthorizedException('User not found');
      const removed = await manager.delete(TotpSecretEntity, { userId: owner.id });
      if (!removed.affected) throw new NotFoundException('No authenticator app is set up.');
      const passkeys = await manager.count(WebauthnCredentialEntity, {
        where: { userId: owner.id },
      });
      if (passkeys === 0) await this.recoveryCodes.removeAll(owner.id, manager);
      return owner;
    });

    await this.events.record({
      type: 'totp.disabled',
      userId: user.id,
      email: user.email,
      sessionId: principal.sessionId,
      ...context,
    });
    await this.sessions.revokeOthers(user.id, principal.sessionId as string);
    this.notices.totpChanged(user, 'removed');
  }

  async regenerateRecoveryCodes(
    principal: Principal,
    context: RequestContext = {},
  ): Promise<{ recoveryCodes: string[] }> {
    // Before the proof, so a super admin is told where to go rather than asked to confirm.
    await this.refuseStaff(principal.userId);
    await this.proofs.assertHeld(principal);
    const user = await this.requireUser(principal.userId);
    const methods = await this.secondFactors.methodsFor(user);
    if (!methods.includes('totp') && !methods.includes('webauthn')) {
      throw new ConflictException('Add a second factor first.');
    }

    await this.proofs.spend(principal);
    const recoveryCodes = await this.secrets.manager.transaction(async (manager) => {
      await assertSessionStillCurrent(manager, await this.users.findByIdForUpdate(user.id, manager), principal);
      return this.recoveryCodes.replace(user.id, manager);
    });
    await this.events.record({
      type: 'recovery_codes.regenerated',
      userId: user.id,
      email: user.email,
      sessionId: principal.sessionId,
      ...context,
    });
    await this.sessions.revokeOthers(user.id, principal.sessionId as string);
    this.notices.recoveryCodesReplaced(user);
    return { recoveryCodes };
  }

  private async refuseStaff(userId: string): Promise<void> {
    if ((await this.requireUser(userId)).isSuperAdmin) {
      throw new ForbiddenException(STAFF_MANAGE_IN_ADMIN_MESSAGE);
    }
  }

  // ---- For the admin app

  /** The step a code for the not yet confirmed secret matches, or null. */
  async matchPendingCode(userId: string, code: string): Promise<number | null> {
    const row = await this.secrets.findOneBy({ userId, confirmedAt: IsNull() });
    if (!row) throw new BadRequestException('That took too long. Please start again.');
    return matchTotpStep(this.crypto.decrypt(userId, row.secretCiphertext), digitsOf(code), Date.now(), 0);
  }

  /** Conditional, so of two confirmations one wins. Call with the user row locked. */
  async confirmPending(manager: EntityManager, userId: string, step: number): Promise<boolean> {
    const confirmed = await manager
      .createQueryBuilder()
      .update(TotpSecretEntity)
      .set({ confirmedAt: () => 'now()', lastUsedStep: String(step) })
      .where('user_id = :userId AND confirmed_at IS NULL', { userId })
      .execute();
    return Boolean(confirmed.affected);
  }

  // ---- Using

  /** Conditional on the step moving forward, so a code works once even if two arrive at once. */
  async acceptCode(userId: string, code: string): Promise<boolean> {
    return this.totpAccepted(userId, code);
  }

  private async totpAccepted(userId: string, code: string): Promise<boolean> {
    const row = await this.secrets.findOneBy({ userId, confirmedAt: Not(IsNull()) });
    if (!row) return false;
    const step = matchTotpStep(
      this.crypto.decrypt(userId, row.secretCiphertext),
      digitsOf(code),
      Date.now(),
      Number(row.lastUsedStep),
    );
    if (step === null) return false;

    const moved = await this.secrets
      .createQueryBuilder()
      .update(TotpSecretEntity)
      .set({ lastUsedStep: String(step) })
      .where('user_id = :userId AND last_used_step < :step', { userId, step })
      .execute();
    return Boolean(moved.affected);
  }

  /** Staff are never offered codes, and an account that later became staff cannot use them. */
  private async recoveryCodeAccepted(user: UserEntity, code: string): Promise<boolean> {
    return !user.isSuperAdmin && this.recoveryCodes.consume(user.id, code);
  }

  /** The owner hears at once: this is what someone with a stolen code would do. */
  private async afterRecoveryCode(user: UserEntity, context: RequestContext): Promise<void> {
    const remaining = await this.recoveryCodes.remaining(user.id);
    await this.events.record({
      type: 'recovery_code.used',
      userId: user.id,
      email: user.email,
      ...context,
    });
    this.notices.recoveryCodeUsed(user, remaining);
  }

  private async pendingUser(handle: string, context: RequestContext): Promise<UserEntity> {
    const state = await this.preAuth.peekFor(handle, 'customer');
    if (!state) throw new UnauthorizedException(FLOW_EXPIRED);
    const user = await this.requireUser(state.userId);
    await this.auth.assertUnderLoginLimit(user.email, context);
    return user;
  }

  /** A wrong code leaves the handle unspent and counts towards the sign-in limit. */
  async verifyTotpSignIn(
    handle: string,
    code: string,
    context: RequestContext = {},
  ): Promise<SignedIn> {
    const user = await this.pendingUser(handle, context);
    // Before the code is checked, so a code typed into the wrong page is never spent here.
    if (!(await this.secondFactors.totpUsableByCustomer(user))) {
      await this.recordFailure(user, 'totp_not_offered', context);
      throw new UnauthorizedException(USE_PASSKEY_MESSAGE);
    }
    if (!(await this.totpAccepted(user.id, code))) {
      await this.recordFailure(user, 'totp_failed', context);
      throw new UnauthorizedException(CODE_REFUSED);
    }
    return this.auth.completeSecondFactor(handle, 'totp', context);
  }

  async verifyRecoverySignIn(
    handle: string,
    code: string,
    context: RequestContext = {},
  ): Promise<SignedIn> {
    const user = await this.pendingUser(handle, context);
    if (!(await this.recoveryCodeAccepted(user, code))) {
      await this.recordFailure(user, 'recovery_code_failed', context);
      throw new UnauthorizedException(CODE_REFUSED);
    }
    await this.afterRecoveryCode(user, context);
    return this.auth.completeSecondFactor(handle, 'recovery_code', context);
  }

  private async recordFailure(
    user: UserEntity,
    reason: string,
    context: RequestContext,
    sessionId?: string,
  ): Promise<void> {
    await this.events.record({
      type: 'login.failed',
      userId: user.id,
      email: user.email,
      sessionId,
      reason,
      ...context,
    });
  }

  private async reauthUser(principal: Principal, context: RequestContext): Promise<UserEntity> {
    await this.auth.assertUnderLoginLimit(principal.email, context);
    if (!principal.sessionId) throw new UnauthorizedException('Session has been revoked');
    return this.requireUser(principal.userId);
  }

  /** Answers failure with 403, for the reason `AuthService.reauthenticate` does. */
  async reauthWithTotp(
    principal: Principal,
    code: string,
    context: RequestContext = {},
  ): Promise<{ accessToken: string }> {
    const user = await this.reauthUser(principal, context);
    if (!(await this.secondFactors.totpUsableByCustomer(user))) {
      await this.recordFailure(user, 'reauth_totp_not_offered', context, principal.sessionId);
      throw new ForbiddenException(USE_PASSKEY_MESSAGE);
    }
    if (!(await this.totpAccepted(user.id, code))) {
      await this.recordFailure(user, 'reauth_totp_failed', context, principal.sessionId);
      throw new ForbiddenException(CODE_REFUSED);
    }
    return this.auth.issueReauthenticatedToken(user, principal.sessionId as string, 'totp', context);
  }

  /** How someone who has lost their phone gets far enough to remove the old app. */
  async reauthWithRecoveryCode(
    principal: Principal,
    code: string,
    context: RequestContext = {},
  ): Promise<{ accessToken: string }> {
    const user = await this.reauthUser(principal, context);
    if (!(await this.recoveryCodeAccepted(user, code))) {
      await this.recordFailure(user, 'reauth_recovery_code_failed', context, principal.sessionId);
      throw new ForbiddenException(CODE_REFUSED);
    }
    await this.afterRecoveryCode(user, context);
    return this.auth.issueReauthenticatedToken(
      user,
      principal.sessionId as string,
      'recovery_code',
      context,
    );
  }
}

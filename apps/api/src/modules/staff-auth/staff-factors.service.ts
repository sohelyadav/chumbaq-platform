import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Not, Repository } from 'typeorm';
import type { StaffEnrolled, StaffFactors } from '@chumbaq/shared';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AuthEventsService, RequestContext } from '../auth-events/auth-events.service';
import { TotpSecretEntity } from '../auth/entities/totp-secret.entity';
import { WebauthnCredentialEntity } from '../auth/entities/webauthn-credential.entity';
import { FactorChangeProofService } from '../auth/factor-change-proof.service';
import { assertRecentAuth } from '../auth/guards/recent-auth.guard';
import { MfaCryptoService } from '../auth/mfa-crypto.service';
import { RecoveryCodesService } from '../auth/recovery-codes.service';
import { voidStaffEnrolmentAllowances } from '../auth/staff-enrolment-allowances';
import { StaffSessionsService } from '../auth/staff-sessions.service';
import { TotpService } from '../auth/totp.service';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import type { AuthenticatedStaff } from './staff-principal';
import {
  STAFF_ENROLMENT_ONLY_MESSAGE,
  STAFF_LAST_FACTOR_MESSAGE,
  STAFF_PASSKEY_NEEDED_MESSAGE,
  STAFF_SESSION_ENDED_MESSAGE,
} from './staff-messages';

const CODE_REFUSED = 'That code is not right. Please try again.';

/** Counted under the user-row lock, so two removals at once cannot both see room. */
export async function staffFactorCount(manager: EntityManager, userId: string): Promise<{ passkeys: number; totp: boolean }> {
  const [passkeys, totp] = await Promise.all([
    manager.count(WebauthnCredentialEntity, { where: { userId, scope: 'staff' } }),
    manager.exists(TotpSecretEntity, { where: { userId, confirmedAt: Not(IsNull()) } }),
  ]);
  return { passkeys, totp };
}

/**
 * Staff sign-in methods: listing them, the authenticator app, and the rules every staff
 * factor change shares (`StaffPasskeysService` uses them for keys).
 *
 * A full session changes factors only after a real re-authentication in that session
 * (recent `auth_time` and the single-use proof it leaves), as in the customer app. An
 * enrolment-only session skips both, since it exists only to enrol and lasts 15 minutes,
 * and it may only add, never remove. After it enrols, it ends, and the person signs in
 * with the new factor, as must any other enrolment session of theirs.
 */
@Injectable()
export class StaffFactorsService {
  constructor(
    @InjectRepository(WebauthnCredentialEntity)
    private readonly credentials: Repository<WebauthnCredentialEntity>,
    @InjectRepository(TotpSecretEntity)
    private readonly secrets: Repository<TotpSecretEntity>,
    private readonly users: UsersService,
    private readonly totp: TotpService,
    private readonly crypto: MfaCryptoService,
    private readonly recoveryCodes: RecoveryCodesService,
    private readonly proofs: FactorChangeProofService,
    private readonly sessions: StaffSessionsService,
    private readonly events: AuthEventsService,
    private readonly audit: AdminAuditService,
    private readonly notices: SecurityNoticesService,
    private readonly config: ConfigService,
  ) {}

  private get passkeyRequired(): boolean {
    return this.config.get<boolean>('webauthn.superAdminPasskeyRequired') === true;
  }

  async requireUser(userId: string): Promise<UserEntity> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
    return user;
  }

  /**
   * Before adding: the proof is looked at here and spent by the finishing step.
   *
   * While passkeys are required, only a passkey vouches for a new staff factor: an
   * enrolment session (started with an operator's code) may add a passkey, and a full
   * session may add anything only once it has shown a passkey. Otherwise a password and
   * phished authenticator codes could plant passkeys and then pass `SuperAdminGuard`.
   */
  async assertMayAdd(staff: AuthenticatedStaff, spend: boolean, factor: 'webauthn' | 'totp'): Promise<void> {
    if (this.passkeyRequired) {
      const vouched = staff.enrolmentOnly ? factor === 'webauthn' : staff.amr.includes('webauthn');
      if (!vouched) throw new ForbiddenException(STAFF_PASSKEY_NEEDED_MESSAGE);
    }
    if (staff.enrolmentOnly) return;
    assertRecentAuth(staff);
    const holder = { userId: staff.userId, sessionId: staff.sessionId, audience: 'staff' as const };
    if (spend) await this.proofs.spend(holder);
    else await this.proofs.assertHeld(holder);
  }

  /** Removing is never for an enrolment-only session, whatever a route says. */
  async assertMayRemove(staff: AuthenticatedStaff): Promise<void> {
    if (staff.enrolmentOnly) throw new ForbiddenException(STAFF_ENROLMENT_ONLY_MESSAGE);
    assertRecentAuth(staff);
    await this.proofs.spend({ userId: staff.userId, sessionId: staff.sessionId, audience: 'staff' });
  }

  /**
   * Inside the transaction that adds a factor, after the user row is locked, as
   * `assertSessionStillCurrent` does for customers: a staff factor reset, a revoke or a
   * sign-out may have committed while this request waited for the lock.
   */
  async assertStillCurrent(manager: EntityManager, staff: AuthenticatedStaff): Promise<UserEntity> {
    const ended = () => new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
    const locked = await this.users.findByIdForUpdate(staff.userId, manager);
    if (!locked || locked.isSuperAdmin !== true || locked.suspendedAt) throw ended();
    if (locked.sessionVersion !== staff.sessionVersion) throw ended();
    const [row] = await manager.query(
      `SELECT coalesce(u.factors_reset_at > s.created_at, false) AS before_reset
         FROM staff_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL`,
      [staff.sessionId, staff.userId],
    );
    if (!row || row.before_reset) throw ended();
    // An enrolment session exists to add the first staff factor, nothing more. If another
    // of this person's enrolment sessions got there first (the user row lock orders
    // them), this one is spent too, however it was left alive.
    // While passkeys are required an authenticator app is no staff factor, so a person
    // who has only that enrols a passkey this way.
    if (staff.enrolmentOnly) {
      const { passkeys, totp } = await staffFactorCount(manager, locked.id);
      if (passkeys > 0 || (totp && !this.passkeyRequired)) throw ended();
    }
    return locked;
  }

  /**
   * In the adding transaction, so no other session of this person can act on the old set
   * of factors once the new one is committed. After enrolling, every staff session ends,
   * the enrolling one included: the person signs in with the new factor. After a full
   * session adds, the others end.
   */
  async endSessionsForAdd(manager: EntityManager, staff: AuthenticatedStaff): Promise<void> {
    if (staff.enrolmentOnly) {
      await this.sessions.revoke(staff.sessionId, staff.userId, 'enrolled', manager);
    }
    await this.sessions.revokeOthers(staff.userId, staff.sessionId, 'factor_changed', manager);
  }

  /** The first staff factor voids any operator's code still unspent: it is no longer needed. */
  async clearEnrolmentAllowance(manager: EntityManager, userId: string): Promise<void> {
    await voidStaffEnrolmentAllowances(manager, userId, 'enrolled');
  }

  /** After a factor is added and `endSessionsForAdd` has committed with it. */
  async afterAdded(
    staff: AuthenticatedStaff,
    user: UserEntity,
    method: 'webauthn' | 'totp',
    name: string | null,
    context: RequestContext,
  ): Promise<StaffEnrolled> {
    await this.events.record({
      type: method === 'webauthn' ? 'passkey.added' : 'totp.enabled',
      userId: user.id,
      email: user.email,
      sessionId: staff.sessionId,
      ...context,
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'staff.factor_added',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { method, ...(name ? { name } : {}), sessionId: staff.sessionId },
      ipAddress: context.ipAddress ?? null,
    });
    if (method === 'webauthn') this.notices.passkeyChanged(user, 'added', name ?? 'Passkey');
    else this.notices.totpChanged(user, 'added');
    return { enrolled: true, signInAgain: staff.enrolmentOnly };
  }

  async afterRemoved(
    staff: AuthenticatedStaff,
    user: UserEntity,
    method: 'webauthn' | 'totp',
    name: string | null,
    context: RequestContext,
  ): Promise<void> {
    await this.events.record({
      type: method === 'webauthn' ? 'passkey.removed' : 'totp.disabled',
      userId: user.id,
      email: user.email,
      sessionId: staff.sessionId,
      ...context,
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'staff.factor_removed',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { method, ...(name ? { name } : {}), sessionId: staff.sessionId },
      ipAddress: context.ipAddress ?? null,
    });
    await this.sessions.revokeOthers(user.id, staff.sessionId, 'factor_changed');
    if (method === 'webauthn') this.notices.passkeyChanged(user, 'removed', name ?? 'Passkey');
    else this.notices.totpChanged(user, 'removed');
  }

  async list(staff: AuthenticatedStaff): Promise<StaffFactors> {
    const [rows, totpEnabled] = await Promise.all([
      this.credentials.find({ where: { userId: staff.userId, scope: 'staff' }, order: { createdAt: 'ASC' } }),
      this.secrets.existsBy({ userId: staff.userId, confirmedAt: Not(IsNull()) }),
    ]);
    return {
      passkeys: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
        deviceType: row.deviceType,
        backedUp: row.backedUp,
      })),
      // An enrolment session may not add one while passkeys are required (`assertMayAdd`).
      totp: {
        enabled: totpEnabled,
        available: this.crypto.isConfigured && !(staff.enrolmentOnly && this.passkeyRequired),
      },
      canRemove: rows.length + (totpEnabled ? 1 : 0) > 1,
    };
  }

  // ---- Authenticator app

  /** Staff get no recovery codes and need no verified address: staff are made by CLI. */
  async totpSetup(staff: AuthenticatedStaff): Promise<{ secret: string; uri: string }> {
    await this.assertMayAdd(staff, false, 'totp');
    if (!this.crypto.isConfigured) {
      throw new ForbiddenException('Two-factor sign-in is not available right now.');
    }
    return this.totp.startSecret(await this.requireUser(staff.userId));
  }

  /** A mistyped code leaves the proof unspent: mistyping is ordinary just after setup. */
  async totpConfirm(staff: AuthenticatedStaff, code: string, context: RequestContext = {}): Promise<StaffEnrolled> {
    await this.assertMayAdd(staff, false, 'totp');
    const step = await this.totp.matchPendingCode(staff.userId, code);
    if (step === null) throw new BadRequestException(CODE_REFUSED);
    await this.assertMayAdd(staff, true, 'totp');

    const user = await this.secrets.manager.transaction(async (manager) => {
      const locked = await this.assertStillCurrent(manager, staff);
      if (!(await this.totp.confirmPending(manager, locked.id, step))) {
        throw new ConflictException('This account already has an authenticator app.');
      }
      await this.clearEnrolmentAllowance(manager, locked.id);
      await this.endSessionsForAdd(manager, staff);
      return locked;
    });
    return this.afterAdded(staff, user, 'totp', null, context);
  }

  async totpRemove(staff: AuthenticatedStaff, context: RequestContext = {}): Promise<void> {
    await this.assertMayRemove(staff);
    const user = await this.secrets.manager.transaction(async (manager) => {
      const owner = await this.users.findByIdForUpdate(staff.userId, manager);
      if (!owner) throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
      const { passkeys, totp } = await staffFactorCount(manager, owner.id);
      if (!totp) throw new NotFoundException('No authenticator app is set up.');
      if (passkeys === 0) throw new ConflictException(STAFF_LAST_FACTOR_MESSAGE);
      await manager.delete(TotpSecretEntity, { userId: owner.id });
      // Recovery codes go with the last factor of the customer app, as there.
      const customerKeys = await manager.count(WebauthnCredentialEntity, {
        where: { userId: owner.id, scope: 'customer' },
      });
      if (customerKeys === 0) await this.recoveryCodes.removeAll(owner.id, manager);
      return owner;
    });
    await this.afterRemoved(staff, user, 'totp', null, context);
  }
}

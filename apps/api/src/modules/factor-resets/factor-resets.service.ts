import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Not, QueryFailedError, Repository } from 'typeorm';
import type {
  AccountFactorResetState,
  AdminAuditAction,
  AdminFactorResetState,
  AdminPendingFactorReset,
  FactorResetVerificationMethod,
} from '@chumbaq/shared';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminAuditLogEntity } from '../admin/entities/admin-audit-log.entity';
import { AuthEventsService, RequestContext } from '../auth-events/auth-events.service';
import { AccountTokensService } from '../auth/account-tokens.service';
import { AccountTokenEntity } from '../auth/entities/account-token.entity';
import { TotpSecretEntity } from '../auth/entities/totp-secret.entity';
import { WebauthnCredentialEntity } from '../auth/entities/webauthn-credential.entity';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { UserEntity } from '../users/entities/user.entity';
import { FactorResetRefusal } from './cancel-requested-by';
import {
  FACTOR_RESET_VERIFICATION_METHODS,
  FactorResetCancelledBy,
  FactorResetEntity,
  VERIFICATION_NOTES_MIN,
} from './entities/factor-reset.entity';
import { factorResetDelayMs } from './factor-reset-delay';
import { lockOwnerAndStaff } from './lock-users';
import { lastPasswordReset, PASSWORD_RESET_WINDOW_DAYS, recentFactorReset } from './password-reset-window';
import { markFactorsReset, removeFactors } from './remove-factors';
import { retryTransient } from './retry-transient';
import { logValue } from '../../common/log-value';

export interface FactorResetActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
}

/** Who an audit entry names. Null with `system` when nobody chose to do it. */
interface AuditActor {
  userId: string | null;
  email: string;
  ipAddress?: string | null;
}

export interface FactorResetRequestOptions {
  /**
   * How staff confirmed who is asking, by some means other than email, and what they
   * saw. Always required: the mailbox is exactly what a takeover would have.
   */
  verificationMethod: FactorResetVerificationMethod;
  verificationNotes: string;
  /** Why staff go ahead although the password was reset recently. Needed only then. */
  passwordResetOverride?: string | null;
}

/** A reset cancelled inside someone else's transaction, to announce once it commits. */
export interface CancelledFactorReset {
  resetId: string;
  user: UserEntity;
  by: FactorResetCancelledBy;
}

/** How a password reset reached the account, for the audit entry of what it cancelled. */
export type PasswordResetVia = 'email' | 'team';

export { PASSWORD_RESET_WINDOW_DAYS };

/**
 * Shown on the reset-password page. Only someone holding a valid link sees it, so it
 * tells nobody else that the account exists.
 */
export const EMAIL_RESET_REFUSED_MESSAGE =
  "For your security, this account's password can't be reset by email right now. Contact support.";

export const TEAM_RESET_REFUSED_MESSAGE =
  "For this member's security, their password can't be reset by a team admin right now. " +
  'They need to contact support.';

/** How many due resets, or unsent warnings, one sweep takes on. The rest wait for the next. */
const SWEEP_LIMIT = 100;

const PG_UNIQUE_VIOLATION = '23505';

const SYSTEM: AuditActor = { userId: null, email: 'system' };

/**
 * Staff-assisted removal of a tenant's second factors, for someone who has lost every
 * factor and recovery code. Whoever asks staff for this may not be the owner, so it
 * never happens at once: the owner is emailed, and has the delay to cancel it, either
 * by pressing cancel or by signing in with a factor, which shows they were not locked
 * out. Only then does the worker remove the factors, through the same `removeFactors`
 * as the CLI.
 *
 * The delay runs from the confirmed send of that email (`notice_sent_at`), not from
 * the request: a warning that never arrived gave the owner no time at all.
 *
 * Lock order is user rows and then reset rows, in every path here and in
 * `cancelResetsRequestedBy`, so no two of them can deadlock. A path that takes more
 * than one user row takes them in ascending id order (`lock-users.ts`), whoever is
 * owner and whoever is staff. Owners' rows are taken FOR NO KEY UPDATE, which still
 * lets other transactions' foreign key checks on them (audit and event inserts)
 * through. Each change of state is one conditional UPDATE on the reset row, so of two
 * racing changes only one can match.
 */
@Injectable()
export class FactorResetsService {
  private readonly logger = new Logger(FactorResetsService.name);
  private readonly delayMs: number;

  constructor(
    @InjectRepository(FactorResetEntity)
    private readonly resets: Repository<FactorResetEntity>,
    private readonly events: AuthEventsService,
    private readonly notices: SecurityNoticesService,
    config: ConfigService,
  ) {
    // Read once, so a malformed value stops the process at start rather than at a request.
    this.delayMs = factorResetDelayMs(config.get<string>('FACTOR_RESET_DELAY_HOURS'));
  }

  private get manager(): EntityManager {
    return this.resets.manager;
  }

  /** The delay as SQL, from the database's clock, which is the one the claim uses. */
  private get delaySql(): string {
    return `make_interval(secs => ${this.delayMs / 1000})`;
  }

  async adminState(userId: string): Promise<AdminFactorResetState> {
    if (!(await this.manager.existsBy(UserEntity, { id: userId }))) {
      throw new NotFoundException('Tenant not found');
    }
    const [hasFactors, pending, lastReset] = await Promise.all([
      this.hasFactors(this.manager, userId),
      this.resets.findOneBy({ userId, status: 'pending' }),
      lastPasswordReset(this.manager, userId),
    ]);
    return {
      hasFactors,
      pending: pending ? toAdminPending(pending) : null,
      lastPasswordResetAt: lastReset.at?.toISOString() ?? null,
      emailConfigured: this.notices.canSend(),
    };
  }

  async ownerState(userId: string): Promise<AccountFactorResetState> {
    const pending = await this.resets.findOneBy({ userId, status: 'pending' });
    return {
      pending: pending
        ? {
            requestedAt: pending.requestedAt.toISOString(),
            executeAfter: pending.executeAfter.toISOString(),
          }
        : null,
    };
  }

  async request(
    userId: string,
    reason: string,
    actor: FactorResetActor,
    options: FactorResetRequestOptions,
  ): Promise<AdminFactorResetState> {
    const override = options.passwordResetOverride?.trim() || null;
    // Checked here as well as in the DTO, so no other caller can start one unrecorded.
    const verificationMethod = options.verificationMethod;
    const verificationNotes = typeof options.verificationNotes === 'string' ? options.verificationNotes.trim() : '';
    if (!FACTOR_RESET_VERIFICATION_METHODS.includes(verificationMethod)) {
      throw new BadRequestException('Say how you verified who is asking.');
    }
    if (verificationNotes.length < VERIFICATION_NOTES_MIN) {
      throw new BadRequestException(
        `Describe how you verified who is asking, in at least ${VERIFICATION_NOTES_MIN} characters.`,
      );
    }
    const { user, reset, lastResetAt } = await this.manager
      .transaction(async (manager) => {
        const { owner: user, staff } = await lockOwnerAndStaff(manager, userId, actor.userId);
        // Read again under the lock, not trusted from the session: a revoke or suspension
        // in flight either commits first and is seen here, or waits for this transaction
        // and then cancels the reset it wrote (`lockResetTargetsOf`).
        if (!staff || !staff.isSuperAdmin || staff.suspendedAt) {
          throw new ForbiddenException('Only active staff can start a factor reset.');
        }
        // Also under the lock: `admin:passkeys-reset` removes the keys of staff whose key
        // was lost or stolen, and a request on a session that passed `SuperAdminGuard`
        // just before must not land after it. It holds this row while it removes them,
        // so a request either commits first (and is cancelled by it) or sees none.
        if (!(await this.hasFactors(manager, staff.id))) {
          throw new ForbiddenException('Add a passkey to your account before starting a factor reset.');
        }
        if (!user) throw new NotFoundException('Tenant not found');
        // Staff keys come back only through the CLI, so no panel session can strip one.
        if (user.isSuperAdmin) {
          throw new ConflictException('A super admin cannot be reset here. Use the CLI.');
        }
        // The owner's warning is the whole safeguard, so without a way to send it there
        // is no reset.
        if (!this.notices.canSend()) {
          throw new ConflictException('Account email is not set up, so the owner cannot be warned');
        }
        if (!(await this.hasFactors(manager, userId))) {
          throw new ConflictException('This account has no second factors to reset.');
        }
        if (await manager.existsBy(FactorResetEntity, { userId, status: 'pending' })) {
          throw new ConflictException('A reset is already waiting for this account.');
        }
        const lastReset = await lastPasswordReset(manager, userId);
        if (lastReset.recent && !override) {
          throw new ConflictException(
            `This account's password was reset on ${lastReset.at!.toISOString()}. Whoever did that ` +
              'controls its mailbox and may not be the owner, and with the factors gone they would ' +
              'own the account. Confirm who is asking some other way, then give a separate ' +
              'justification for going ahead.',
          );
        }
        // Only kept when it was needed, so the panel never shows one that justified nothing.
        const passwordResetOverride = lastReset.recent ? override : null;

        const inserted = await manager
          .createQueryBuilder()
          .insert()
          .into(FactorResetEntity)
          .values({
            userId,
            requestedById: actor.userId,
            requestedByEmail: actor.email,
            reason,
            passwordResetOverride,
            verificationMethod,
            verificationNotes,
            // Only a first estimate, for display: `sendWarning` moves it on to the
            // confirmed send plus the delay.
            executeAfter: () => `now() + ${this.delaySql}`,
          })
          .returning(['id'])
          .execute();
        const reset = await manager.findOneByOrFail(FactorResetEntity, {
          id: inserted.raw[0].id,
        });

        const lastResetAt = lastReset.at?.toISOString() ?? null;
        await this.audit(manager, 'account.factors_reset_requested', user, {
          actorId: actor.userId,
          actorEmail: actor.email,
          reason,
          ipAddress: actor.ipAddress,
          metadata: {
            resetId: reset.id,
            executeAfter: reset.executeAfter.toISOString(),
            lastPasswordResetAt: lastResetAt,
            passwordResetOverride,
            verificationMethod,
            verificationNotes,
          },
        });
        return { user, reset, lastResetAt };
      })
      .catch((error: unknown) => {
        // The user-row lock makes this unreachable today; the index is the backstop.
        if (error instanceof QueryFailedError && (error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
          throw new ConflictException('A reset is already waiting for this account.');
        }
        throw error;
      });

    await this.events.record({
      type: 'factors_reset.requested',
      userId: user.id,
      email: user.email,
      reason: 'staff',
    });
    // Waited for, so staff see at once whether the owner was told. If not, the sweep
    // keeps trying and the reset waits.
    await this.sendWarning(reset.id);
    const current = await this.resets.findOneByOrFail({ id: reset.id });
    return {
      hasFactors: true,
      pending: current.status === 'pending' ? toAdminPending(current) : null,
      lastPasswordResetAt: lastResetAt,
      emailConfigured: true,
    };
  }

  async cancelByStaff(userId: string, actor: FactorResetActor): Promise<AdminFactorResetState> {
    if (!(await this.cancel(userId, 'staff', actor))) {
      throw (await this.manager.existsBy(UserEntity, { id: userId }))
        ? new ConflictException('No reset is waiting for this account.')
        : new NotFoundException('Tenant not found');
    }
    return this.adminState(userId);
  }

  async cancelByOwner(
    user: { userId: string; email: string },
    context: RequestContext = {},
  ): Promise<void> {
    const cancelled = await this.cancel(
      user.userId,
      'owner',
      { userId: user.userId, email: user.email, ipAddress: context.ipAddress },
      context,
    );
    if (!cancelled) throw new NotFoundException('No reset is waiting for this account.');
  }

  /**
   * A sign-in or re-authentication that used a second factor: whoever did it still has
   * one, so the account was never locked out. Never throws, because a sign-in that has
   * already been verified must not fail over this.
   *
   * Three layers, so a lost cancel cannot quietly let the reset run. The time is
   * stamped on the user row first, in its own statement, and `execute` refuses any
   * reset requested before it. The cancel is retried while it loses to a deadlock or
   * lock timeout. If it still fails, this returns true and the sign-in response tells
   * the client, which shows the owner the reset and its cancel button.
   *
   * @returns true if a reset may still be waiting.
   */
  async cancelOnFactorUse(
    user: { id: string; email: string },
    context: RequestContext = {},
  ): Promise<boolean> {
    try {
      await retryTransient(() =>
        this.manager.query(`UPDATE users SET last_factor_sign_in_at = now() WHERE id = $1`, [user.id]),
      );
    } catch (error) {
      this.logger.error(`Could not record a factor sign-in for user ${user.id}: ${(error as Error).message}`);
    }
    try {
      await retryTransient(() =>
        this.cancel(
          user.id,
          'sign_in',
          { userId: user.id, email: user.email, ipAddress: context.ipAddress },
          context,
        ),
      );
      return false;
    } catch (error) {
      this.logger.error(`Could not cancel a factor reset for user ${user.id}: ${(error as Error).message}`);
      return true;
    }
  }

  /**
   * After a complete sign-in by the owner: the password on an account with no second
   * factor, the password and then the factor, a passkey, or a re-authentication. Spends
   * every unused password reset link staff issued (`admin:password-reset-link`), audits
   * each and tells the owner. Someone who can sign in was never locked out, so a link
   * support handed over in their name is in someone else's hands. This is what the
   * link's `STAFF_LINK_DELAY_HOURS` wait is for. Not at the password step of an account
   * with a factor: knowing the password alone would then let someone keep voiding the
   * link a real owner who lost their factor is waiting for.
   *
   * Never throws, since a sign-in that has been verified must not fail over this. A
   * transient failure is retried; one that still fails is recorded (an auth event, and
   * an audit row if the database takes one) and this returns true, so the response can
   * tell the client to show the link and its cancel button.
   *
   * @returns true if a staff link may still be live.
   */
  async voidStaffLinksOnSignIn(
    user: UserEntity,
    via: 'password' | 'factor',
    context: RequestContext = {},
  ): Promise<boolean> {
    try {
      await this.voidStaffLinks(user, { reason: 'owner_signed_in', via }, context);
      return false;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Could not void a staff reset link for user ${user.id}: ${logValue(message)}`);
      await this.events.record({
        type: 'staff_link.void_failed',
        userId: user.id,
        email: user.email,
        reason: via,
        ...context,
      });
      try {
        await this.audit(this.manager, 'account.password_reset_link_void_failed', user, {
          actorId: SYSTEM.userId,
          actorEmail: SYSTEM.email,
          ipAddress: context.ipAddress,
          // The code only: a database error's text can repeat values it was given.
          metadata: { via, errorCode: (error as { code?: unknown }).code ?? null },
        });
      } catch (auditError) {
        this.logger.error(
          `Could not audit a failed staff link void for user ${user.id}: ${logValue((auditError as Error).message)}`,
        );
      }
      return true;
    }
  }

  /**
   * The owner cancelling every unused staff link from a signed-in session, for the
   * notice's button and the dashboard banner. The controller requires a recent
   * re-authentication and refuses impersonation. Throws on failure, since the owner is
   * waiting for the answer and can try again.
   */
  async cancelStaffLinksByOwner(
    user: { userId: string; email: string },
    context: RequestContext = {},
  ): Promise<number> {
    const account = await this.manager.findOneBy(UserEntity, { id: user.userId });
    if (!account) throw new NotFoundException('User not found');
    return this.voidStaffLinks(account, { reason: 'owner_cancelled', via: 'cancel' }, context);
  }

  /** For `GET /auth/me`: whether a staff link is still live, so the banner can offer to cancel it. */
  staffLinkPending(userId: string): Promise<boolean> {
    return new AccountTokensService(this.manager.getRepository(AccountTokenEntity)).hasLiveStaffLink(userId);
  }

  /** Retried on transient errors. The tokens service locks the user row first. */
  private async voidStaffLinks(
    user: UserEntity,
    metadata: { reason: 'owner_signed_in' | 'owner_cancelled'; via: string },
    context: RequestContext,
  ): Promise<number> {
    const voided = await retryTransient(() =>
      this.manager.transaction(async (manager) => {
        const ids = await new AccountTokensService(manager.getRepository(AccountTokenEntity)).voidStaffLinks(
          user.id,
          manager,
        );
        for (const tokenId of ids) {
          await this.audit(manager, 'account.password_reset_link_cancelled', user, {
            actorId: metadata.reason === 'owner_cancelled' ? user.id : SYSTEM.userId,
            actorEmail: metadata.reason === 'owner_cancelled' ? user.email : SYSTEM.email,
            ipAddress: context.ipAddress,
            metadata: { tokenId, ...metadata },
          });
        }
        return ids.length;
      }),
    );
    if (voided > 0) {
      this.notices.staffResetLinkCancelled(user, metadata.reason === 'owner_cancelled' ? 'cancelled' : 'signed_in');
    }
    return voided;
  }

  /**
   * For a password reset, inside its transaction, so the new password and the cancel
   * land together. Whoever reset it holds the mailbox, which is not the same as being
   * the owner, so a reset staff were asked for must not go on into theirs. Call
   * `announceCancelled` once the transaction commits.
   */
  cancelForPasswordReset(
    manager: EntityManager,
    userId: string,
    via: PasswordResetVia,
  ): Promise<CancelledFactorReset | null> {
    return this.cancelWithin(manager, userId, 'password_reset', SYSTEM, { via });
  }

  /**
   * Whether a password reset must be refused because staff removed this account's
   * factors within the window: whoever asked staff may hold only the mailbox, and a new
   * password would finish the takeover. Call inside the reset's transaction with the
   * user row already locked, so a factor reset completing at the same moment is either
   * seen here or waits for this transaction.
   */
  passwordResetBlockedSince(manager: EntityManager, userId: string): Promise<Date | null> {
    return recentFactorReset(manager, userId);
  }

  /**
   * The audit entry for a refused password reset, in the caller's transaction, so it
   * commits with whatever else that transaction did (the spent token). Staff see it on
   * the tenant's page: it is either the owner, who needs help, or the takeover.
   */
  async recordPasswordResetRefused(
    manager: EntityManager,
    user: UserEntity,
    via: PasswordResetVia,
    factorsResetAt: Date,
    context: RequestContext = {},
  ): Promise<void> {
    await this.audit(manager, 'account.password_reset_refused', user, {
      actorId: SYSTEM.userId,
      actorEmail: SYSTEM.email,
      ipAddress: context.ipAddress,
      metadata: { via, factorsResetAt: factorsResetAt.toISOString() },
    });
  }

  /** After the refusal's transaction commits. Never throws. */
  async announcePasswordResetRefused(
    user: UserEntity,
    via: PasswordResetVia,
    context: RequestContext = {},
  ): Promise<void> {
    await this.events.record({
      type: 'password.reset_refused',
      userId: user.id,
      email: user.email,
      reason: `factors_reset:${via}`,
      ...context,
    });
  }

  async announceCancelled(cancelled: CancelledFactorReset, context: RequestContext = {}): Promise<void> {
    await this.events.record({
      type: 'factors_reset.cancelled',
      userId: cancelled.user.id,
      email: cancelled.user.email,
      reason: cancelled.by,
      ...context,
    });
    this.notices.factorResetCancelled(cancelled.user);
  }

  /**
   * Retries warnings that have not gone out, then carries out every reset that is due.
   * Safe to run from several workers at once: the claim is a conditional UPDATE, and a
   * warning sent twice by two workers only says the same thing twice.
   */
  async executeDue(): Promise<number> {
    await this.retryWarnings();

    const due: { id: string }[] = await this.manager.query(
      `SELECT id FROM factor_resets
        WHERE status = 'pending' AND ${this.dueSql}
        ORDER BY notice_sent_at ASC
        LIMIT ${SWEEP_LIMIT}`,
    );
    let done = 0;
    for (const { id } of due) {
      try {
        if (await this.execute(id)) done += 1;
      } catch (error) {
        this.logger.error(`Factor reset ${id} failed: ${(error as Error).message}`);
      }
    }
    return done;
  }

  /**
   * Removes the factors if the reset is still pending and due. False if anything else
   * got there first: another worker, a cancel, or nothing being due yet. Refuses, and
   * cancels, a reset whose target became a super admin or whose requester is no longer
   * active staff, since it ran on their word. Cancels one whose owner has signed in
   * with a factor since it was requested, in case that sign-in's own cancel failed.
   */
  async execute(resetId: string): Promise<boolean> {
    const outcome = await this.manager.transaction(async (manager) => {
      const reset = await manager.findOneBy(FactorResetEntity, { id: resetId });
      if (!reset) return null;
      // The requester locked too, so a revoke or suspension in flight finishes first and
      // is seen here, rather than this reading the row from before it.
      const { owner: user, staff: requester } = await lockOwnerAndStaff(
        manager,
        reset.userId,
        reset.requestedById,
      );
      if (!user) return null;

      const refused = await this.refuseIfStale(manager, reset, user, requester);
      if (refused === 'raced') return null;
      if (refused) return { user, ran: false as const, by: refused };

      // The claim. Whichever worker matches this owns the reset; any other matches nothing.
      const claimed = await manager
        .createQueryBuilder()
        .update(FactorResetEntity)
        .set({ status: 'completed', completedAt: () => 'now()' })
        .where(`id = :resetId AND status = 'pending' AND ${this.dueSql}`, { resetId })
        .execute();
      if (!claimed.affected) return null;

      // The claim above already took this reset out of pending, so it supersedes
      // nothing today; if it ever does, `removeFactors` audits and records it.
      const removed = await removeFactors(manager, user, SYSTEM);
      await markFactorsReset(manager, user.id);
      // In the name of whoever asked, so the review afterwards knows who to ask.
      await this.audit(manager, 'account.factors_reset', user, {
        actorId: reset.requestedById,
        actorEmail: reset.requestedByEmail,
        reason: reset.reason,
        metadata: {
          resetId,
          requestedAt: reset.requestedAt.toISOString(),
          removedPasskeys: removed.passkeys,
        },
      });
      return { user, ran: true as const };
    });
    if (!outcome) return false;

    if (!outcome.ran) {
      await this.announceCancelled({ resetId, user: outcome.user, by: outcome.by });
      return false;
    }
    await this.events.record({
      type: 'factors_reset.completed',
      userId: outcome.user.id,
      email: outcome.user.email,
      reason: 'staff',
    });
    this.notices.factorsReset(outcome.user);
    return true;
  }

  /**
   * Due means the whole delay has passed since the owner's warning was confirmed sent,
   * and the time they were given has come. The second matters only if the delay is
   * shortened while a reset waits: the owner was promised a time, and it is never early.
   */
  private get dueSql(): string {
    return `notice_sent_at IS NOT NULL AND notice_sent_at + ${this.delaySql} <= now() AND execute_after <= now()`;
  }

  private async retryWarnings(): Promise<void> {
    const unsent = await this.resets.find({
      select: { id: true, userId: true },
      where: { status: 'pending', noticeSentAt: IsNull() },
      order: { requestedAt: 'ASC' },
      take: SWEEP_LIMIT,
    });
    for (const { id } of unsent) {
      try {
        await this.sendWarning(id);
      } catch (error) {
        this.logger.error(`Factor reset ${id} warning failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Sends the owner's warning and, only if the provider took it, records that and
   * restarts the wait from now. The time in the email is worked out before sending, so
   * it can only be earlier than the real one, never later.
   *
   * What the caller read may be out of date by now: a cancel, a revoke or suspension
   * of the requester, or a keys reset may have landed since, and the owner must not be
   * told a reset is coming after being told it stopped. So it first checks, holding
   * the owner and requester (`lockOwnerAndStaff`, id order) and then the reset row,
   * that the reset is still waiting and would still be allowed to run, and refuses it
   * here, as `execute` would, if not. The send is outside that transaction, so a slow
   * provider holds no rows. A cancel that lands during the send has already told the
   * owner, perhaps before this warning arrives, so they are told again after it.
   */
  private async sendWarning(resetId: string): Promise<boolean> {
    const checked = await this.manager.transaction(async (manager) => {
      const found = await manager.findOneBy(FactorResetEntity, { id: resetId });
      if (!found || found.status !== 'pending' || found.noticeSentAt) return null;
      const { owner, staff } = await lockOwnerAndStaff(manager, found.userId, found.requestedById);
      if (!owner) return null;
      const reset = await manager.findOne(FactorResetEntity, {
        where: { id: resetId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!reset || reset.status !== 'pending' || reset.noticeSentAt) return null;
      const refused = await this.refuseIfStale(manager, reset, owner, staff);
      if (refused === 'raced') return null;
      return { owner, refused };
    });
    if (!checked) return false;
    const { owner } = checked;
    if (checked.refused) {
      // No notice: the owner was never told this reset was coming.
      await this.events.record({
        type: 'factors_reset.cancelled',
        userId: owner.id,
        email: owner.email,
        reason: checked.refused,
      });
      return false;
    }

    const promised = new Date(Date.now() + this.delayMs);
    if (!(await this.notices.sendFactorResetRequested(owner, promised))) return false;
    const marked = await this.manager
      .createQueryBuilder()
      .update(FactorResetEntity)
      .set({ noticeSentAt: () => 'now()', executeAfter: () => `now() + ${this.delaySql}` })
      .where(`id = :resetId AND status = 'pending' AND notice_sent_at IS NULL`, { resetId })
      .execute();
    if (marked.affected) return true;
    const after = await this.resets.findOneBy({ id: resetId });
    if (after?.status === 'cancelled') this.notices.factorResetCancelled(owner);
    return false;
  }

  /**
   * Cancels, in the caller's transaction, a reset that must not run any more: its owner
   * signed in with a factor since it was asked for, or `refusalFor` or a keys reset of
   * its requester refuses it. Call with the owner and requester locked
   * (`lockOwnerAndStaff`). Returns how it was cancelled, `raced` if something else
   * changed it first, or null if it may go on. The caller announces it once committed.
   */
  private async refuseIfStale(
    manager: EntityManager,
    reset: FactorResetEntity,
    user: UserEntity,
    requester: UserEntity | null,
  ): Promise<FactorResetCancelledBy | 'raced' | null> {
    const resetId = reset.id;
    const signedInAt = await this.factorSignInSince(manager, resetId);
    const refusal = signedInAt
      ? null
      : (refusalFor(user, reset, requester) ??
        ((await this.requesterKeysResetSince(manager, resetId)) ? 'requester_keys_reset' : null));
    if (!signedInAt && !refusal) return null;

    const by: FactorResetCancelledBy = signedInAt ? 'sign_in' : 'refused';
    const refused = await manager.update(
      FactorResetEntity,
      { id: resetId, status: 'pending' },
      { status: 'cancelled', cancelledAt: () => 'now()', cancelledBy: by },
    );
    if (!refused.affected) return 'raced';
    await this.audit(manager, 'account.factors_reset_cancelled', user, {
      actorId: SYSTEM.userId,
      actorEmail: SYSTEM.email,
      metadata: signedInAt
        ? { resetId, cancelledBy: by, lastFactorSignInAt: signedInAt }
        : { resetId, cancelledBy: by, refusal, requestedById: reset.requestedById },
    });
    this.logger.warn(`Factor reset ${resetId} refused: ${refusal ?? 'owner signed in with a factor'}`);
    return by;
  }

  /**
   * Whether the requester's keys were reset (`admin:passkeys-reset`) after they asked
   * for this: the request may have been made with the key that was lost. Compared in
   * SQL, at the database's microseconds, as `factorSignInSince`. The reset's own
   * cancel normally catches these first; this is for when it did not run.
   */
  private async requesterKeysResetSince(manager: EntityManager, resetId: string): Promise<boolean> {
    const rows = await manager.query(
      `SELECT 1 FROM factor_resets r JOIN users u ON u.id = r.requested_by_id
        WHERE r.id = $1 AND u.factors_reset_at > r.requested_at`,
      [resetId],
    );
    return rows.length > 0;
  }

  /**
   * When the owner last signed in with a factor, if that was after this reset was
   * asked for. Compared in SQL, at the database's microseconds: both times come from
   * its clock, and rounding them to milliseconds could make a later sign-in look equal.
   */
  private async factorSignInSince(manager: EntityManager, resetId: string): Promise<string | null> {
    const [row] = await manager.query(
      `SELECT u.last_factor_sign_in_at AS at
         FROM factor_resets r JOIN users u ON u.id = r.user_id
        WHERE r.id = $1 AND u.last_factor_sign_in_at > r.requested_at`,
      [resetId],
    );
    return row?.at ? new Date(row.at).toISOString() : null;
  }

  /** True if something was cancelled. */
  private async cancel(
    userId: string,
    by: FactorResetCancelledBy,
    actor: FactorResetActor,
    context: RequestContext = {},
  ): Promise<boolean> {
    const cancelled = await this.manager.transaction((manager) =>
      this.cancelWithin(manager, userId, by, actor),
    );
    if (!cancelled) return false;
    await this.announceCancelled(cancelled, context);
    return true;
  }

  /**
   * The user row first, then the reset row, as everywhere else. Taking the reset row
   * first, as this once did, meets `execute` coming the other way: it holds the user
   * row and wants the reset row, while the audit insert here waits on the user row for
   * its foreign key check. Postgres then aborts one, and if that was the cancel, the
   * reset ran although the cancel started first.
   */
  private async cancelWithin(
    manager: EntityManager,
    userId: string,
    by: FactorResetCancelledBy,
    actor: AuditActor,
    extra: Record<string, unknown> = {},
  ): Promise<CancelledFactorReset | null> {
    const user = await this.lockUser(manager, userId);
    if (!user) return null;
    const result = await manager
      .createQueryBuilder()
      .update(FactorResetEntity)
      .set({ status: 'cancelled', cancelledAt: () => 'now()', cancelledBy: by })
      .where(`user_id = :userId AND status = 'pending'`, { userId })
      .returning(['id'])
      .execute();
    if (!result.affected) return null;

    const resetId: string = result.raw[0].id;
    await this.audit(manager, 'account.factors_reset_cancelled', user, {
      actorId: actor.userId,
      actorEmail: actor.email,
      ipAddress: actor.ipAddress,
      metadata: { resetId, cancelledBy: by, ...extra },
    });
    return { resetId, user, by };
  }

  /** FOR NO KEY UPDATE: see the class comment. */
  private lockUser(manager: EntityManager, userId: string): Promise<UserEntity | null> {
    return manager.findOne(UserEntity, {
      where: { id: userId },
      lock: { mode: 'for_no_key_update' },
    });
  }

  /** Recovery codes alone are not a factor: without one, the password already signs in. */
  private async hasFactors(manager: EntityManager, userId: string): Promise<boolean> {
    const [passkey, totp] = await Promise.all([
      manager.existsBy(WebauthnCredentialEntity, { userId }),
      manager.existsBy(TotpSecretEntity, { userId, confirmedAt: Not(IsNull()) }),
    ]);
    return passkey || totp;
  }

  private audit(
    manager: EntityManager,
    action: AdminAuditAction,
    user: UserEntity,
    entry: {
      actorId: string | null;
      actorEmail: string;
      reason?: string;
      ipAddress?: string | null;
      metadata: Record<string, unknown>;
    },
  ) {
    return new AdminAuditService(manager.getRepository(AdminAuditLogEntity)).record(
      {
        ...entry,
        action,
        targetType: 'tenant',
        targetId: user.id,
        targetLabel: user.email,
        ipAddress: entry.ipAddress || null,
      },
      manager,
    );
  }
}

function toAdminPending(row: FactorResetEntity): AdminPendingFactorReset {
  return {
    id: row.id,
    requestedAt: row.requestedAt.toISOString(),
    executeAfter: row.executeAfter.toISOString(),
    requestedByEmail: row.requestedByEmail,
    reason: row.reason,
    noticeSentAt: row.noticeSentAt?.toISOString() ?? null,
    passwordResetOverride: row.passwordResetOverride,
    verificationMethod: row.verificationMethod,
    verificationNotes: row.verificationNotes,
  };
}

function refusalFor(
  target: UserEntity,
  reset: FactorResetEntity,
  requester: UserEntity | null,
): FactorResetRefusal | null {
  if (target.isSuperAdmin) return 'target_super_admin';
  if (!reset.requestedById || !requester) return 'requester_missing';
  if (requester.suspendedAt) return 'requester_suspended';
  if (!requester.isSuperAdmin) return 'requester_not_staff';
  return null;
}

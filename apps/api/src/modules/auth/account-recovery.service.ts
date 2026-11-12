import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import type { EntityManager } from 'typeorm';
import type { ResendVerificationStatus } from '@chumbaq/shared';
import { AuthEventsService, RequestContext } from '../auth-events/auth-events.service';
import {
  accountLink,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from '../platform-email/account-emails';
import {
  EMAIL_RESET_REFUSED_MESSAGE,
  FactorResetsService,
} from '../factor-resets/factor-resets.service';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AccountTokensService } from './account-tokens.service';
import type { AccountTokenPurpose } from './entities/account-token.entity';
import { SessionsService } from './sessions.service';
import { voidStaffEnrolmentAllowances } from './staff-enrolment-allowances';
import { revokeAllStaffSessions } from './staff-sessions.service';

/** One message for unknown, used, expired and refused alike, so it reveals nothing. */
export const INVALID_TOKEN_MESSAGE = 'This link is invalid or has expired.';

export const FORGOT_PASSWORD_MESSAGE =
  'If that address has an account, a link to reset the password is on its way.';

const invalidToken = () => new BadRequestException(INVALID_TOKEN_MESSAGE);

/** 425 Too Early, which Nest's enum lacks: the link is good, just not yet. */
export const LINK_NOT_YET_USABLE_STATUS = 425;

/** The reset page shows the time from `resetLinkStatus` before the form is sent. */
const linkNotYetUsable = (usableAt: Date) =>
  new HttpException(`This link becomes usable at ${usableAt.toISOString()}.`, LINK_NOT_YET_USABLE_STATUS);

/**
 * Proof of control of the account's mailbox: verifying an address and resetting a
 * password. Verification is recorded here and enforced nowhere yet; that is a later
 * decision.
 */
@Injectable()
export class AccountRecoveryService {
  private readonly logger = new Logger(AccountRecoveryService.name);
  private readonly background = new Set<Promise<void>>();

  constructor(
    private readonly users: UsersService,
    private readonly tokens: AccountTokensService,
    private readonly sessions: SessionsService,
    private readonly email: PlatformEmailService,
    private readonly events: AuthEventsService,
    private readonly config: ConfigService,
    private readonly factorResets: FactorResetsService,
  ) {}

  private link(path: string, token?: string): string {
    return accountLink(this.config.getOrThrow<string>('app.appUrl'), path, token);
  }

  /**
   * Work the caller must not wait for, because a slow provider would otherwise show
   * in its response time. Never rejects.
   */
  private inBackground(work: () => Promise<void>): void {
    const task: Promise<void> = work()
      .catch((error: Error) => this.logger.error(`Account email failed: ${error.message}`))
      .finally(() => this.background.delete(task));
    this.background.add(task);
  }

  /** Resolves once work started so far has finished. */
  async settled(): Promise<void> {
    await Promise.all(this.background);
  }

  /** After registering. Whatever goes wrong here, the new account stands. */
  sendVerificationAfterRegister(user: UserEntity): void {
    this.inBackground(async () => {
      const outcome = await this.sendVerification(user);
      if (outcome !== 'sent') {
        this.logger.warn(`Verification email not sent for user ${user.id}: ${outcome}`);
      }
    });
  }

  /** Reports the outcome, because the caller has signed in and it is their own account. */
  async resendVerification(userId: string): Promise<ResendVerificationStatus> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    if (user.emailVerifiedAt) return 'already_verified';

    const outcome = await this.sendVerification(user);
    if (outcome === 'limited') {
      throw new HttpException(
        'Too many emails sent. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return outcome === 'sent' ? 'sent' : 'unavailable';
  }

  private async sendVerification(user: UserEntity): Promise<string> {
    return this.sendWithToken(user, 'verify_email', (token) =>
      verificationEmail(user, this.link('/verify-email', token)),
    );
  }

  /** No sender means no token: a link nobody can receive should not exist. */
  private async sendWithToken(
    user: UserEntity,
    purpose: AccountTokenPurpose,
    compose: (token: string) => Parameters<PlatformEmailService['send']>[0],
  ): Promise<string> {
    if (!this.email.isConfigured) return 'not_configured';
    const token = await this.tokens.issue(user.id, purpose);
    if (!token) return 'limited';
    const result = await this.email.send(compose(token));
    return result.sent ? 'sent' : result.reason;
  }

  /**
   * The account a valid token belongs to, with the token now spent, or null. A
   * suspended account's token is spent too and changes nothing: suspension stays until
   * staff lift it, and the caller sees the same refusal as for any other bad token.
   *
   * Locks the user before the token, the same order as `AccountTokensService.issue`,
   * so a reset racing a new request for a link cannot deadlock.
   */
  private async spendToken(
    token: string,
    purpose: AccountTokenPurpose,
    manager: EntityManager,
  ): Promise<{ user: UserEntity; staffIssued: boolean } | null> {
    const ownerId = await this.tokens.ownerOf(token, manager);
    if (!ownerId) return null;
    const user = await this.users.findByIdForUpdate(ownerId, manager);
    const spent = await this.tokens.spend(token, purpose, manager);
    return spent && user && !user.suspendedAt ? { user, staffIssued: spent.staffIssued } : null;
  }

  /**
   * Needs the account's own signed-in session. Clicking a link proves control of the
   * mailbox and nothing about who registered: without this, someone could register a
   * stranger's address, wait for the stranger to click, and hold a verified account
   * they can put their own second factor on. Another account's session spends nothing,
   * so the link still works for its owner.
   */
  async verifyEmail(token: string, userId: string, context: RequestContext = {}): Promise<void> {
    const user = await this.tokens.transaction(async (manager) => {
      if ((await this.tokens.ownerOf(token, manager)) !== userId) return null;
      const owner = (await this.spendToken(token, 'verify_email', manager))?.user ?? null;
      if (owner) await this.users.markEmailVerified(owner.id, manager);
      return owner;
    });
    if (!user) throw invalidToken();

    await this.events.record({
      type: 'email.verified',
      userId: user.id,
      email: user.email,
      ...context,
    });
  }

  /**
   * Returns at once with the same result for every address: the lookup, the limit and
   * the send all happen afterwards, so neither the response nor its timing says
   * whether an account exists, is suspended, or whether the email went out.
   */
  requestPasswordReset(email: string, context: RequestContext = {}): void {
    this.inBackground(() => this.processResetRequest(email, context));
  }

  private async processResetRequest(email: string, context: RequestContext): Promise<void> {
    const user = await this.users.findByEmail(email);
    let reason: string;
    if (!user) {
      reason = 'unknown_email';
    } else if (user.suspendedAt) {
      reason = 'suspended';
    } else {
      // To the stored address, never the one typed in the request.
      reason = await this.sendWithToken(user, 'reset_password', (token) =>
        passwordResetEmail(user, this.link('/reset-password', token)),
      );
    }
    await this.events.record({
      type: 'password.reset_requested',
      userId: user?.id,
      email,
      reason,
      ...context,
    });
  }

  /**
   * For the reset page, before anyone types a password: when a staff link waiting out
   * its delay becomes usable. Null for every other token, valid or not, so it tells
   * nothing about one that is not such a link. Spends nothing.
   */
  async resetLinkStatus(token: string): Promise<{ usableAt: string | null }> {
    return { usableAt: (await this.tokens.usableAt(token))?.toISOString() ?? null };
  }

  /**
   * Resetting a password NEVER removes or bypasses a second factor. Email alone must not
   * be enough to take an account protected by one, so the next sign-in still asks for it.
   * See "2FA recovery" in `reports/Super admin panel gaps.md`.
   */
  async resetPassword(
    token: string,
    newPassword: string,
    context: RequestContext = {},
  ): Promise<void> {
    // Outside the transaction, so no row stays locked for the length of a bcrypt hash.
    const passwordHash = await bcrypt.hash(newPassword, 12);

    const done = await this.tokens.transaction(async (manager) => {
      const spent = await this.spendToken(token, 'reset_password', manager);
      if (!spent) return null;
      const { user, staffIssued } = spent;

      // Staff removed the factors recently, perhaps on the word of whoever holds this
      // mailbox, so the mailbox alone must not set the password too. Under the user-row
      // lock `spendToken` took, so a factor reset finishing now cannot slip past. The
      // token stays spent and the refusal is audited with it. A link staff issued
      // through the CLI, after checking who is asking, never went to the mailbox, so it
      // is let through: it is how someone who lost their password as well gets back in.
      const blockedSince = staffIssued
        ? null
        : await this.factorResets.passwordResetBlockedSince(manager, user.id);
      if (blockedSince) {
        await this.factorResets.recordPasswordResetRefused(manager, user, 'email', blockedSince, context);
        return { refused: true as const, user };
      }

      await this.users.resetPassword(user.id, passwordHash, manager);
      await this.sessions.revokeAll(user.id, manager);
      // Staff too, for super admins (a no-op for anyone else). The version bump already
      // stops their staff sessions, but whoever reset this may hold only the mailbox, so
      // the rows end now, with their unused view-as codes, and any operator's enrolment
      // code is voided: the person must ask again, which tells the operator something.
      await revokeAllStaffSessions(manager, user.id, 'password_reset');
      await voidStaffEnrolmentAllowances(manager, user.id, 'password_reset');
      await this.tokens.invalidateAll(user.id, manager);
      // In this transaction, so there is never a moment with the new password and a
      // staff factor reset still waiting: together they hand the account to whoever
      // holds the mailbox. The user row is already locked, as the reset needs.
      const cancelledReset = await this.factorResets.cancelForPasswordReset(manager, user.id, 'email');
      return { refused: false as const, user, cancelledReset, staffIssued };
    });
    if (!done) {
      // A staff link still waiting out its delay was left unspent; say when it will work.
      const usableAt = await this.tokens.usableAt(token);
      if (usableAt) throw linkNotYetUsable(usableAt);
      throw invalidToken();
    }
    if (done.refused) {
      await this.factorResets.announcePasswordResetRefused(done.user, 'email', context);
      // Only someone holding a valid link gets this far, so it tells nobody else that
      // the account exists. `forgot-password` answers the same for every address.
      throw new ConflictException(EMAIL_RESET_REFUSED_MESSAGE);
    }
    const reset = done.user;

    await this.events.record({
      type: 'password.reset',
      userId: reset.id,
      email: reset.email,
      // So the history tells a link staff handed over from one sent to the mailbox.
      ...(done.staffIssued ? { reason: 'staff_link' } : {}),
      ...context,
    });
    if (done.cancelledReset) await this.factorResets.announceCancelled(done.cancelledReset, context);
    if (!reset.emailVerifiedAt) {
      await this.events.record({
        type: 'email.verified',
        userId: reset.id,
        email: reset.email,
        reason: 'password_reset',
        ...context,
      });
    }

    this.inBackground(async () => {
      const result = await this.email.send(
        passwordChangedEmail(reset, this.link('/forgot-password')),
      );
      if (!result.sent) {
        this.logger.warn(`Password change notice not sent for user ${reset.id}: ${result.reason}`);
      }
    });
  }
}

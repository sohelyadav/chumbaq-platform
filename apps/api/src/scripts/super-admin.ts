import { ConfigService } from '@nestjs/config';
import { normaliseEmail } from '../modules/users/email';
import { DataSource, EntityManager } from 'typeorm';
import type { AdminAuditAction } from '@chumbaq/shared';
import dataSource from '../data-source';
import { AdminAuditService } from '../modules/admin/admin-audit.service';
import { AdminAuditLogEntity } from '../modules/admin/entities/admin-audit-log.entity';
import { AccountTokensService } from '../modules/auth/account-tokens.service';
import { AccountTokenEntity } from '../modules/auth/entities/account-token.entity';
import {
  announceRequesterResetsCancelled,
  cancelAllRequestedBy,
} from '../modules/factor-resets/cancel-requested-by';
import {
  lastPasswordReset,
  PASSWORD_RESET_WINDOW_DAYS,
  recentFactorReset,
} from '../modules/factor-resets/password-reset-window';
import { STAFF_LINK_USABLE_FOR_MS, staffLinkDelayMs } from '../modules/factor-resets/staff-link-delay';
import { markFactorsReset, removeFactors } from '../modules/factor-resets/remove-factors';
import { accountLink } from '../modules/platform-email/account-emails';
import { PlatformEmailService } from '../modules/platform-email/platform-email.service';
import { SecurityNoticesService } from '../modules/platform-email/security-notices.service';
import { UserEntity } from '../modules/users/entities/user.entity';
import { revokeAllStaffSessions } from '../modules/auth/staff-sessions.service';
import { issueStaffEnrolmentAllowance } from '../modules/auth/staff-enrolment-allowances';
import { ImpersonationHandoffsService } from '../modules/impersonation/impersonation-handoffs.service';
import {
  FACTORS_RESET_USAGE,
  FactorsResetVerification,
  PASSKEYS_RESET_USAGE,
  PASSWORD_RESET_LINK_USAGE,
  parseFactorsResetArgs,
  parsePasskeysResetArgs,
  parsePasswordResetLinkArgs,
  PasswordResetLinkRequest,
} from './factors-reset-args';

/**
 * The only way to grant or revoke super admin: no API can, so a compromised admin
 * session cannot mint another admin.
 *
 *   npm run admin:grant -- someone@x.com
 *   npm run admin:revoke -- someone@x.com
 *   npm run admin:passkeys-reset -- someone@x.com [--recent-reset-justification "..."]
 *   npm run admin:factors-reset -- someone@x.com --verified-by video_call --notes "..."
 *       [--recent-reset-justification "..."]
 *   npm run admin:password-reset-link -- someone@x.com --verified-by video_call --notes "..."
 *       [--recent-factor-reset-justification "..."] [--confirm-super-admin]
 *   npm run admin:staff-enrolment -- someone@x.com
 *
 * Connects through data-source.ts rather than seed.ts's localhost fallbacks: a
 * privilege change with incomplete config must fail, not land on another database.
 */

export class SuperAdminCliError extends Error {}

export type SuperAdminChange = 'changed' | 'unchanged';

/** Where a CLI command tells the operator what it found before it acts. */
export type Say = (line: string) => void;

/** The notices a CLI command sends once it commits. */
export type CliNotices = Pick<SecurityNoticesService, 'factorResetCancelled' | 'factorsReset'>;

const CLI_ACTOR = { userId: null, email: 'cli' } as const;

/**
 * The panel's recent-password-reset rule, for both CLI resets, so the CLI is never the
 * easier way round it: whoever reset the password by email holds the mailbox, and with
 * the factors gone they would own the account. Shows the last reset either way, so the
 * operator sees it before anything is removed. Call with the user row locked. Returns
 * what the audit entry keeps; the justification only when it was needed.
 */
async function checkRecentPasswordReset(
  manager: EntityManager,
  user: UserEntity,
  justification: string | null | undefined,
  say: Say,
): Promise<{ lastPasswordResetAt: string | null; passwordResetOverride: string | null }> {
  const last = await lastPasswordReset(manager, user.id);
  const at = last.at?.toISOString() ?? null;
  say(
    at
      ? `Last password reset of ${user.email}: ${at}` +
          (last.recent ? `, within the last ${PASSWORD_RESET_WINDOW_DAYS} days.` : '.')
      : `Last password reset of ${user.email}: never.`,
  );
  const override = justification?.trim() || null;
  if (last.recent && !override) {
    throw new SuperAdminCliError(
      `${user.email}'s password was reset on ${at}. Whoever did that controls its mailbox and may ` +
        'not be the owner, and with the factors gone they would own the account. Confirm who is ' +
        'asking some other way, then run this again with --recent-reset-justification "<why>".',
    );
  }
  return { lastPasswordResetAt: at, passwordResetOverride: last.recent ? override : null };
}

/** The user's row FOR NO KEY UPDATE, as every path that holds one: see `lockResetTargetsOf`. */
function lockUserByEmail(manager: EntityManager, email: string): Promise<UserEntity | null> {
  return manager.findOne(UserEntity, { where: { email }, lock: { mode: 'for_no_key_update' } });
}

/**
 * `notices` emails the owners of any resets a revoke cancels. Pass it wherever an owner
 * could have been warned of one, which is anywhere but a test that checks nothing else.
 *
 * A revoke is two transactions, so a super admin about to lose the role cannot hold it
 * off. The first changes only their own row. Its lock queues behind the reset requests
 * already holding that row (`lockOwnerAndStaff`, the same lock mode, so later ones queue
 * behind it), which commit first, and once it commits `request` refuses them. The
 * second cancels every reset they asked for, a set that can now only shrink
 * (`cancelAllRequestedBy`). The second also runs when nothing changed, so a revoke
 * whose second step failed can simply be run again.
 */
export async function setSuperAdmin(
  ds: DataSource,
  email: string,
  grant: boolean,
  notices?: Pick<SecurityNoticesService, 'factorResetCancelled'>,
): Promise<SuperAdminChange> {
  const { change, userId } = await ds.transaction(async (manager) => {
    const user = await lockUserByEmail(manager, email);
    if (!user) {
      throw new SuperAdminCliError(`No user with email ${email}`);
    }
    // Keeps the rule that a super admin is never suspended true from this side too.
    if (grant && user.suspendedAt) {
      throw new SuperAdminCliError(`${email} is suspended. Reactivate the account first.`);
    }
    // Run again on a revoke even when nothing changed, so a staff session or view-as
    // code left by a revoke from before the admin split is ended too.
    if (!grant) await endStaffAccess(manager, user.id);
    if (user.isSuperAdmin === grant) {
      return { change: 'unchanged' as const, userId: user.id };
    }

    await manager.update(UserEntity, user.id, { isSuperAdmin: grant });

    const action: AdminAuditAction = grant ? 'super_admin.granted' : 'super_admin.revoked';
    const audit = new AdminAuditService(manager.getRepository(AdminAuditLogEntity));
    await audit.record(
      {
        actorId: null,
        actorEmail: 'cli',
        action,
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.email,
      },
      manager,
    );
    return { change: 'changed' as const, userId: user.id };
  });
  if (grant) return change;

  // A reset they asked for ran on their word as staff, which they no longer have.
  const cancelled = await cancelAllRequestedBy(
    (work) => ds.transaction(work),
    userId,
    'all',
    'requester_not_staff',
    CLI_ACTOR,
  );
  if (notices) announceRequesterResetsCancelled(notices, cancelled);
  return change;
}

/**
 * Ends the person's staff sessions and deletes their unused view-as codes, in the
 * revoke's transaction. `StaffJwtStrategy` rechecks the flag per request anyway, and the
 * customer API rechecks the actor at exchange; this makes the end visible in the rows,
 * and kills the admin app's refresh cookie at once.
 */
async function endStaffAccess(manager: EntityManager, userId: string): Promise<void> {
  await revokeAllStaffSessions(manager, userId, 'staff_revoked');
  await ImpersonationHandoffsService.deleteUnused(manager, userId);
}

/**
 * For a super admin with no staff factor who needs an operator's say-so to enrol one:
 * anyone holding a passkey (every admin from before the admin split, whose customer
 * keys cannot sign in on the admin app's host), and anyone at all while
 * SUPER_ADMIN_PASSKEY_REQUIRED is on. Makes a one-time code, good for 24 hours, that
 * they type with their password in the admin app to start an enrolment session.
 *
 * The code is what a password alone lacks: a password can be reset by whoever holds the
 * mailbox, so the operator hands the code over themselves, by a channel they trust. Only
 * its sha256 is stored, and the code is returned once, to be printed. A new code
 * replaces an unspent one; the first staff factor, or a password reset, voids it.
 * Audited with the allowance id, which `staff.enrolment_started` repeats when it is used.
 */
export async function staffEnrolment(
  ds: DataSource,
  email: string,
): Promise<{ id: string; code: string; expiresAt: Date }> {
  return ds.transaction(async (manager) => {
    const user = await lockUserByEmail(manager, email);
    if (!user) throw new SuperAdminCliError(`No user with email ${email}`);
    if (!user.isSuperAdmin) {
      throw new SuperAdminCliError(`${email} is not a super admin, so this does not apply.`);
    }
    const issued = await issueStaffEnrolmentAllowance(manager, user.id);
    await new AdminAuditService(manager.getRepository(AdminAuditLogEntity)).record(
      {
        actorId: null,
        actorEmail: 'cli',
        action: 'staff.enrolment_allowed',
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.email,
        metadata: { allowanceId: issued.id, until: issued.expiresAt.toISOString() },
      },
      manager,
    );
    return issued;
  });
}

/**
 * Recovery for a super admin who has lost their keys, and the one way a staff factor
 * can be removed with none in hand. Only someone with database access can run it, and
 * no panel or API can. Ends every session, so whoever held a lost key is signed out,
 * and is audited so the review afterwards has something to read.
 *
 * Whoever held a lost key may have asked for factor resets with it, so every reset the
 * admin asked for before this is cancelled too (`requester_keys_reset`), and each owner
 * told once it commits. As a revoke, in two transactions: the first removes the keys,
 * holding the admin's row, which waits for a request in flight to commit first; from
 * then on `request` refuses them, since they hold no key. The second cancels those
 * resets. `execute` refuses any it missed, by comparing with `factors_reset_at`.
 *
 * Arms the same 14-day block on password resets by email and team as a tenant's factor
 * reset (`markFactorsReset`): an operator talked into this by someone holding the
 * admin's mailbox would otherwise let them reset the password, enrol their own keys
 * (super admins may always enrol) and pass `SuperAdminGuard`. The admin recovers by
 * signing in with the password they still have and enrolling new keys; if they lost
 * that too, staff hand them a link from `admin:password-reset-link`. For the same
 * reason a recent password reset stops it unless justified.
 */
export async function resetSuperAdminPasskeys(
  ds: DataSource,
  email: string,
  recentResetJustification: string | null = null,
  say: Say = console.log,
  notices?: Pick<SecurityNoticesService, 'factorResetCancelled'>,
): Promise<number> {
  const { user, removed } = await ds.transaction(async (manager) => {
    const user = await lockUserByEmail(manager, email);
    if (!user) throw new SuperAdminCliError(`No user with email ${email}`);
    if (!user.isSuperAdmin) {
      throw new SuperAdminCliError(`${email} is not a super admin, so this does not apply.`);
    }
    const recentReset = await checkRecentPasswordReset(manager, user, recentResetJustification, say);

    const removed = await removeFactors(manager, user, CLI_ACTOR);
    await markFactorsReset(manager, user.id);

    const audit = new AdminAuditService(manager.getRepository(AdminAuditLogEntity));
    await audit.record(
      {
        actorId: null,
        actorEmail: 'cli',
        action: 'super_admin.passkeys_reset',
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.email,
        metadata: { removed: removed.passkeys, ...recentReset },
      },
      manager,
    );
    return { user, removed };
  });

  const cancelled = await cancelAllRequestedBy(
    (work) => ds.transaction(work),
    user.id,
    'before_keys_reset',
    'requester_keys_reset',
    CLI_ACTOR,
  );
  if (notices) {
    // Only if they were once a tenant with a reset waiting: one cannot be asked for on staff.
    if (removed.supersededResetIds.length > 0) notices.factorResetCancelled(user);
    announceRequesterResetsCancelled(notices, cancelled);
  }
  return removed.passkeys;
}

/**
 * For a tenant who has lost every factor and every recovery code. Whoever runs this must
 * first be sure who is asking, since it hands the account to anyone with the password.
 * The admin panel has a staff-assisted reset that waits first, so the owner can stop it;
 * this is for when that wait is not acceptable. It cancels any such reset still waiting,
 * audited and recorded as every cancel is. It refuses after a recent password reset
 * unless justified, as the panel does.
 *
 * `notices` tells the owner, once committed, that their factors were removed, and that
 * the reset they were warned of has stopped, as the worker's reset does. Pass it
 * wherever the owner should hear, which is anywhere but a test that checks nothing else.
 */
export async function resetAccountFactors(
  ds: DataSource,
  email: string,
  verification: FactorsResetVerification,
  say: Say = console.log,
  notices?: CliNotices,
): Promise<void> {
  // Checked here too, so no caller can skip saying how the person was verified.
  const checked = parseFactorsResetArgs([
    '--verified-by',
    verification?.method ?? '',
    '--notes',
    verification?.notes ?? '',
    ...(verification?.recentResetJustification != null
      ? ['--recent-reset-justification', verification.recentResetJustification]
      : []),
  ]);
  if ('error' in checked) throw new SuperAdminCliError(checked.error);
  const { user, removed } = await ds.transaction(async (manager) => {
    // FOR NO KEY UPDATE, as every path that holds an owner's row while it changes their
    // reset: a revoke cancelling it records events on this row, and FOR UPDATE would
    // block those foreign key checks.
    const user = await lockUserByEmail(manager, email);
    if (!user) throw new SuperAdminCliError(`No user with email ${email}`);
    if (user.isSuperAdmin) {
      throw new SuperAdminCliError(`${email} is a super admin. Use admin:passkeys-reset.`);
    }
    const recentReset = await checkRecentPasswordReset(
      manager,
      user,
      checked.verification.recentResetJustification,
      say,
    );
    const removed = await removeFactors(manager, user, CLI_ACTOR);
    await markFactorsReset(manager, user.id);
    const audit = new AdminAuditService(manager.getRepository(AdminAuditLogEntity));
    await audit.record(
      {
        actorId: null,
        actorEmail: 'cli',
        action: 'account.factors_reset',
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.email,
        metadata: {
          verificationMethod: checked.verification.method,
          verificationNotes: checked.verification.notes,
          ...recentReset,
        },
      },
      manager,
    );
    return { user, removed };
  });
  if (!notices) return;
  if (removed.supersededResetIds.length > 0) notices.factorResetCancelled(user);
  notices.factorsReset(user);
}

/** What `admin:password-reset-link` needs to tell the owner before it hands anything over. */
export type LinkNotices = Pick<SecurityNoticesService, 'canSend' | 'sendStaffResetLinkIssued'>;

export interface IssuedResetLink {
  link: string;
  usableAt: Date;
  expiresAt: Date;
}

/**
 * How long a staff link counts as still being issued once its row commits without an
 * audit entry: ample time for one run to send its notice. A run that died in between
 * holds the next one off for no longer than this.
 */
export const STAFF_LINK_ISSUE_HOLD_MS = 10 * 60_000;

/**
 * When the unused staff link another run is still issuing (committed in step 1, no
 * issue audited yet) was started, or null. Call with the user row locked.
 */
async function staffLinkBeingIssued(manager: EntityManager, userId: string): Promise<Date | null> {
  const [row] = await manager.query(
    `SELECT t.created_at FROM account_tokens t
      WHERE t.user_id = $1 AND t.purpose = 'reset_password' AND t.staff_issued AND t.used_at IS NULL
        AND t.created_at > now() - make_interval(secs => $2::float8)
        AND NOT EXISTS (
          SELECT 1 FROM admin_audit_logs a
           WHERE a.target_id = t.user_id AND a.action = 'account.password_reset_link_issued'
             AND a.metadata->>'tokenId' = t.id::text)
      ORDER BY t.created_at DESC LIMIT 1`,
    [userId, STAFF_LINK_ISSUE_HOLD_MS / 1000],
  );
  return row ? new Date(row.created_at) : null;
}

type SpentReason =
  | 'unknown'
  | { by: 'owner_signed_in' | 'owner_cancelled' }
  | { by: 'password_reset' | 'replaced'; at: Date };

/**
 * What spent this run's link while its notice was out, from what was recorded, so the
 * operator is told the truth rather than a guess. Call with the user row locked.
 */
async function whySpent(manager: EntityManager, userId: string, tokenId: string, since: Date): Promise<SpentReason> {
  const [cancel] = await manager.query(
    `SELECT metadata->>'reason' AS reason FROM admin_audit_logs
      WHERE target_id = $1 AND action = 'account.password_reset_link_cancelled' AND metadata->>'tokenId' = $2
      LIMIT 1`,
    [userId, tokenId],
  );
  if (cancel?.reason === 'owner_signed_in' || cancel?.reason === 'owner_cancelled') return { by: cancel.reason };
  // A reset spends every token the person has (`invalidateAll`).
  const [reset] = await manager.query(
    `SELECT password_reset_at AS at FROM users WHERE id = $1 AND password_reset_at >= $2`,
    [userId, since],
  );
  if (reset) return { by: 'password_reset', at: new Date(reset.at) };
  // Another run's step 3 spends every other unused reset link (`replaceResetLinks`).
  const [replaced] = await manager.query(
    `SELECT created_at AS at FROM admin_audit_logs
      WHERE target_id = $1 AND action = 'account.password_reset_link_issued'
        AND metadata->>'tokenId' <> $2 AND created_at >= $3
      ORDER BY created_at DESC LIMIT 1`,
    [userId, tokenId, since],
  );
  if (replaced) return { by: 'replaced', at: new Date(replaced.at) };
  return 'unknown';
}

function spentMessage(email: string, reason: SpentReason): string {
  const confirm = 'Nothing was printed. Confirm with the owner before issuing another.';
  if (reason === 'unknown') {
    return `The link for ${email} was cancelled while the notice was being sent. Nothing was printed. Check the audit log for ${email} before issuing another.`;
  }
  switch (reason.by) {
    case 'owner_signed_in':
      return (
        `${email} signed in while the notice was being sent, which cancelled the link. Someone who can ` +
        'sign in was not locked out: confirm with the owner before issuing another.'
      );
    case 'owner_cancelled':
      return `${email} cancelled the link from their account while the notice was being sent. ${confirm}`;
    case 'password_reset':
      return `The password of ${email} was reset at ${reason.at.toISOString()} while the notice was being sent, which cancelled the link. ${confirm}`;
    case 'replaced':
      return `Another link for ${email} was issued at ${reason.at.toISOString()} while this one waited on the notice, and replaced it. Use that one: this one was never printed.`;
  }
}

/**
 * A one-time password reset link, for someone who cannot get one by email: a super
 * admin who lost their keys and their password (after `admin:passkeys-reset`, which
 * blocks emailed links for 14 days), or a tenant in the same window after a factor
 * reset. Printed for the operator to hand over by the channel they verified the person
 * on, never emailed, since the mailbox may be what an attacker holds. Only this link
 * gets past the window; ordinary emailed links are still refused. Replaces any unused
 * one. Audited with how the person was verified.
 *
 * Not an instant handover, since one fooled operator could otherwise run passkeys-reset
 * and this in the same conversation and give the account away, super admins included:
 * - Inside the window after a factor reset, which is the usual case, it needs its own
 *   justification as well (`recentFactorResetJustification`).
 * - For a super admin the operator must say they know it is one (`confirmSuperAdmin`).
 * - The owner's stored address is told at once (never sent the link), and nothing is
 *   issued unless that notice was accepted: the wait below is only worth something if
 *   the real owner hears of it.
 * - The link does nothing for `delayMs` (`STAFF_LINK_DELAY_HOURS`, default 24), then
 *   works for 24 hours. A sign-in by the owner meanwhile voids it
 *   (`voidStaffLinksOnSignIn`), since someone who can sign in was not locked out.
 *
 * In this order, so a sign-in prompted by the notice always sees the link it voids:
 * 1. Under the user-row lock: the checks, then the new token row, still waiting out its
 *    delay. Commit. Nothing is printed yet, so nobody holds the link. Refused while
 *    another run is between here and its audit entry (`STAFF_LINK_ISSUE_HOLD_MS`), so
 *    the owner gets one notice and neither run spends the other's row.
 * 2. Send the notice, holding no lock, so sign-ins do not wait behind Brevo.
 * 3. Under the user-row lock again: if the notice failed, spend the new token, audit
 *    that (`account.password_reset_link_cancelled`, reason `owner_not_notified`) and
 *    refuse. If the token was spent meanwhile, refuse, saying what spent it
 *    (`whySpent`: a sign-in, the owner's cancel, a password reset, or another run's
 *    link). Otherwise spend the other unused reset links and audit the issue. Commit,
 *    then print.
 * Voiding (`voidStaffLinks`) takes the same user-row lock before it reads tokens, so it
 * cannot run between step 1's insert and commit and miss the row. Earlier links are
 * replaced only in step 3, so a failed notice leaves them as they were. If step 3
 * itself fails, the link is never printed, and the raw token exists nowhere else.
 */
export async function issuePasswordResetLink(
  ds: DataSource,
  email: string,
  request: PasswordResetLinkRequest,
  appUrl: string | undefined,
  notices: LinkNotices,
  say: Say = console.log,
  delayMs: number = staffLinkDelayMs(process.env.STAFF_LINK_DELAY_HOURS),
): Promise<IssuedResetLink> {
  // Checked here too, so no caller can skip any of it.
  const checked = parsePasswordResetLinkArgs([
    '--verified-by',
    request?.method ?? '',
    '--notes',
    request?.notes ?? '',
    ...(request?.recentFactorResetJustification != null
      ? ['--recent-factor-reset-justification', request.recentFactorResetJustification]
      : []),
    ...(request?.confirmSuperAdmin ? ['--confirm-super-admin'] : []),
  ]);
  if ('error' in checked) throw new SuperAdminCliError(checked.error);
  if (!appUrl) throw new SuperAdminCliError('APP_URL is not set, so there is no address for the link.');
  if (!notices.canSend()) {
    throw new SuperAdminCliError(
      'Account email is not set up, so the owner cannot be told about the link. Set ' +
        'PLATFORM_BREVO_API_KEY and PLATFORM_EMAIL_FROM first.',
    );
  }
  const verification = checked.verification;
  const tokens = new AccountTokensService(ds.getRepository(AccountTokenEntity));
  // Step 1 (see above).
  const { user, factorsResetAt, issued } = await ds.transaction(async (manager) => {
    // The user row, then their tokens, as `AccountTokensService.issue`.
    const user = await lockUserByEmail(manager, email);
    if (!user) throw new SuperAdminCliError(`No user with email ${email}`);
    // A suspended account's link is refused when used, so do not hand one over.
    if (user.suspendedAt) throw new SuperAdminCliError(`${email} is suspended. Reactivate the account first.`);
    if (user.isSuperAdmin && !verification.confirmSuperAdmin) {
      throw new SuperAdminCliError(
        `${email} is a super admin, so this link would hand over a staff account. If you are sure ` +
          'who is asking, run this again with --confirm-super-admin.',
      );
    }
    const factorsResetAt = await recentFactorReset(manager, user.id);
    say(
      factorsResetAt
        ? `Staff removed the factors of ${email} on ${factorsResetAt.toISOString()}, within the last ` +
            `${PASSWORD_RESET_WINDOW_DAYS} days.`
        : `Staff have not removed the factors of ${email} in the last ${PASSWORD_RESET_WINDOW_DAYS} days.`,
    );
    if (factorsResetAt && !verification.recentFactorResetJustification) {
      throw new SuperAdminCliError(
        `Staff removed the factors of ${email} on ${factorsResetAt.toISOString()}. Whoever asked for ` +
          'that may hold only the mailbox, and this link would finish handing them the account. ' +
          'Confirm who is asking some other way, then run this again with ' +
          '--recent-factor-reset-justification "<why>".',
      );
    }

    // One run at a time per person. Two at once would both email the owner, and the
    // first to reach step 3 would spend the other's row. Under the user lock, so the
    // second run waits for the first's row to commit and then sees it.
    const inFlight = await staffLinkBeingIssued(manager, user.id);
    if (inFlight) {
      throw new SuperAdminCliError(
        `A reset link is already being issued for ${email} (started ${inFlight.toISOString()}). ` +
          'Check with whoever ran it and use their link. If that run stopped, try again after ' +
          `${new Date(inFlight.getTime() + STAFF_LINK_ISSUE_HOLD_MS).toISOString()}.`,
      );
    }

    const link = await tokens.issueByStaff(user.id, manager, delayMs, STAFF_LINK_USABLE_FOR_MS);
    return { user, factorsResetAt, issued: link };
  });

  // Step 2.
  const ownerNotified = await notices.sendStaffResetLinkIssued(user, issued.usableAt);

  // Step 3.
  const outcome = await ds.transaction(async (manager) => {
    await lockUserByEmail(manager, email);
    const audit = new AdminAuditService(manager.getRepository(AdminAuditLogEntity));
    const entry = { actorId: null, actorEmail: 'cli', targetType: 'user', targetId: user.id, targetLabel: user.email };
    if (!ownerNotified) {
      await tokens.spendStaffLink(user.id, issued.id, manager);
      await audit.record(
        {
          ...entry,
          action: 'account.password_reset_link_cancelled',
          metadata: { tokenId: issued.id, reason: 'owner_not_notified' },
        },
        manager,
      );
      return 'not_notified' as const;
    }
    const [row] = await manager.query(`SELECT used_at, created_at FROM account_tokens WHERE id = $1`, [issued.id]);
    if (!row) return { spent: 'unknown' } as const;
    if (row.used_at) return { spent: await whySpent(manager, user.id, issued.id, row.created_at) };

    await tokens.replaceResetLinks(user.id, issued.id, manager);
    await audit.record(
      {
        ...entry,
        action: 'account.password_reset_link_issued',
        metadata: {
          tokenId: issued.id,
          verificationMethod: verification.method,
          verificationNotes: verification.notes,
          superAdmin: user.isSuperAdmin,
          factorsResetAt: factorsResetAt?.toISOString() ?? null,
          recentFactorResetJustification: factorsResetAt ? verification.recentFactorResetJustification : null,
          ownerNotified: true,
          usableAfter: issued.usableAt.toISOString(),
          expiresAt: issued.expiresAt.toISOString(),
        },
      },
      manager,
    );
    return 'issued' as const;
  });
  if (outcome === 'not_notified') {
    throw new SuperAdminCliError(
      `The notice to ${email} was not sent, so no link was issued: the owner must hear of it. Try again.`,
    );
  }
  if (outcome !== 'issued') throw new SuperAdminCliError(spentMessage(email, outcome.spent));
  return {
    link: accountLink(appUrl, '/reset-password', issued.token),
    usableAt: issued.usableAt,
    expiresAt: issued.expiresAt,
  };
}

/**
 * Security notices outside Nest, from the same environment the API reads. Without
 * account email set up they log that nothing was sent, as in the API.
 */
function cliNotices(): SecurityNoticesService {
  const config = new ConfigService({ ...process.env, app: { appUrl: process.env.APP_URL } });
  return new SecurityNoticesService(new PlatformEmailService(config), config);
}

const COMMANDS = ['grant', 'revoke', 'passkeys-reset', 'factors-reset', 'password-reset-link', 'staff-enrolment'];
/** Commands that take flags after the email. */
const WITH_FLAGS = ['factors-reset', 'passkeys-reset', 'password-reset-link'];

async function main(): Promise<void> {
  const [command, rawEmail, ...rest] = process.argv.slice(2);
  const email = rawEmail === undefined ? rawEmail : normaliseEmail(rawEmail);
  const usage =
    'Usage:\n  npm run admin:grant -- <email>\n  npm run admin:revoke -- <email>\n' +
    '  npm run admin:staff-enrolment -- <email>\n' +
    `  ${PASSKEYS_RESET_USAGE}\n  ${FACTORS_RESET_USAGE}\n  ${PASSWORD_RESET_LINK_USAGE}`;
  if (!COMMANDS.includes(command) || !email || (!WITH_FLAGS.includes(command) && rest.length > 0)) {
    throw new SuperAdminCliError(usage);
  }
  let verification: FactorsResetVerification | null = null;
  if (command === 'factors-reset') {
    const parsed = parseFactorsResetArgs(rest);
    if ('error' in parsed) throw new SuperAdminCliError(`${parsed.error}\nUsage: ${FACTORS_RESET_USAGE}`);
    verification = parsed.verification;
  }
  let linkVerification: PasswordResetLinkRequest | null = null;
  if (command === 'password-reset-link') {
    const parsed = parsePasswordResetLinkArgs(rest);
    if ('error' in parsed) throw new SuperAdminCliError(`${parsed.error}\nUsage: ${PASSWORD_RESET_LINK_USAGE}`);
    linkVerification = parsed.verification;
  }
  let recentResetJustification: string | null = null;
  if (command === 'passkeys-reset') {
    const parsed = parsePasskeysResetArgs(rest);
    if ('error' in parsed) throw new SuperAdminCliError(`${parsed.error}\nUsage: ${PASSKEYS_RESET_USAGE}`);
    recentResetJustification = parsed.recentResetJustification;
  }

  await dataSource.initialize();
  const notices = cliNotices();
  try {
    if (command === 'staff-enrolment') {
      const issued = await staffEnrolment(dataSource, email);
      console.log(
        `One-time enrolment code for ${email}, good until ${issued.expiresAt.toISOString()}. ` +
          'It is shown only now and was not emailed. Give it to them yourself, by a channel you ' +
          'trust (not email: whoever holds the mailbox can reset the password). They enter it with ' +
          'their password in the admin app to add a staff passkey or authenticator app. Running this ' +
          'again replaces it.\n' +
          issued.code,
      );
      return;
    }
    if (linkVerification) {
      const issued = await issuePasswordResetLink(
        dataSource,
        email,
        linkVerification,
        process.env.APP_URL,
        notices,
      );
      console.log(
        `One-time password reset link for ${email}. It works once, from ${issued.usableAt.toISOString()} ` +
          `until ${issued.expiresAt.toISOString()}, and was not emailed. The owner was emailed that ` +
          'support issued it, and signing in before then cancels it. Give it to them yourself, by the ' +
          'way you verified them:\n' +
          issued.link,
      );
      return;
    }
    if (verification) {
      await resetAccountFactors(dataSource, email, verification, console.log, notices);
      console.log(
        `Removed every second factor from ${email} and ended its sessions. Password resets by ` +
          `email and team admin are refused for ${PASSWORD_RESET_WINDOW_DAYS} days.`,
      );
      return;
    }
    if (command === 'passkeys-reset') {
      const removed = await resetSuperAdminPasskeys(
        dataSource,
        email,
        recentResetJustification,
        console.log,
        notices,
      );
      console.log(
        `Removed ${removed} passkey(s) from ${email}, ended its sessions and cancelled any factor ` +
          'reset it asked for. They sign in with their password and enrol new keys; password ' +
          `resets by email are refused for ${PASSWORD_RESET_WINDOW_DAYS} days. If they lost the ` +
          'password too: npm run admin:password-reset-link -- ' +
          email,
      );
      return;
    }
    const grant = command === 'grant';
    const told: string[] = [];
    const change = await setSuperAdmin(dataSource, email, grant, {
      factorResetCancelled: (owner) => {
        told.push(owner.email);
        notices.factorResetCancelled(owner);
      },
    });
    if (told.length > 0) {
      console.log(`Cancelled the waiting factor resets ${email} asked for. Emailing: ${told.join(', ')}`);
    }
    const state = grant ? 'a super admin' : 'not a super admin';
    if (grant) {
      const heldKeys = await dataSource.query(
        `SELECT count(*)::int AS keys FROM webauthn_credentials c
           JOIN users u ON u.id = c.user_id WHERE u.email = $1`,
        [email],
      );
      if (heldKeys[0].keys > 0) {
        console.warn(
          `! ${email} already has ${heldKeys[0].keys} passkey(s), enrolled under tenant rules. ` +
            'Staff keys must verify the user and be device-bound, so one that does not may ' +
            'lock this account out. To start again: npm run admin:passkeys-reset -- ' +
            email,
        );
      }
    }
    console.log(change === 'changed' ? `${email} is now ${state}.` : `${email} is already ${state}.`);
  } finally {
    // Before the connection closes and the process exits, or the owners hear nothing.
    await notices.settled();
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
  });
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import type { CreatedInvitation, InvitationPreview, ProjectInvitation } from '@chumbaq/shared';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { assertRecentAuth } from '../auth/guards/recent-auth.guard';
import { accountLink, projectInviteEmail } from '../platform-email/account-emails';
import { PlatformEmailService } from '../platform-email/platform-email.service';
import { ProjectEntity } from '../projects/entities/project.entity';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { UserEntity } from '../users/entities/user.entity';
import { normaliseEmail } from '../users/email';
import { ProjectInvitationEntity } from './entities/project-invitation.entity';
import { actorUnderLock, lockProject, membershipOf } from './project-members.service';
import { ROLE_REFUSAL, roleCan, type ProjectRole } from './project-permissions';
import { SeatsService } from './seats.service';
import { refuseViewAs } from './view-as';

/** Invites last 7 days (global constraints). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Every unusable token gets this one answer: unknown, expired, revoked or already accepted. */
export const INVITE_GONE = 'This invite has expired or was already used.';
export const ALREADY_MEMBER = 'They are already a member of this project.';
export const VERIFY_EMAIL_FIRST = 'Verify your email address first, then open the invite again.';
export const INVITATION_NOT_FOUND = 'Invitation not found';
/** Create and resend while the project's billing owner is suspended. */
export const INVITES_SUSPENDED = "This project's account is suspended.";

/**
 * Invitation emails one billing account may have Chumbaq send per rolling 24 hours,
 * creates and resends together. Past it the invite is still made and its link returned,
 * with no email (`emailSkipped: 'daily_limit'`): platform mail is our sender's
 * reputation, not a channel for tenants.
 */
export const INVITE_EMAILS_PER_DAY = 50;

/** Whether `deliver` attempts the email. `skip_daily_limit`: the account used its allowance. */
type EmailPlan = 'attempt' | 'skip_daily_limit';

/** The page the link opens; also a reserved short code. */
export const INVITE_PATH = '/invite';

/** 32 random bytes, base64url: the same strength as account tokens. Exists only in the link. */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * `sam@example.com` → `s***@example.com`; a one-character local part → `*@example.com`.
 * Enough for the right person to recognise their address, not enough to learn it.
 */
export function maskEmail(email: string): string {
  const address = normaliseEmail(email);
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${local.length <= 1 ? '*' : `${local[0]}***`}@${domain}`;
}

export function wrongAccountMessage(invitedEmail: string): string {
  return `This invite was sent to ${maskEmail(invitedEmail)}. Sign in with that address to accept it.`;
}

interface InvitationRow {
  id: string;
  email: string;
  role: ProjectRole;
  invited_by: string | null;
  inviter_name: string | null;
  expires_at: Date;
  created_at: Date;
  expired: boolean;
}

/** Pending: neither accepted nor revoked. Expired ones are still pending, and flagged. */
const PENDING_SQL = `i.accepted_at IS NULL AND i.revoked_at IS NULL`;

const VIEW_SQL = `
  SELECT i.id, i.email, i.role, i.invited_by, u.name AS inviter_name, i.expires_at, i.created_at,
         i.expires_at <= now() AS expired
    FROM project_invitations i
    LEFT JOIN users u ON u.id = i.invited_by`;

function toView(row: InvitationRow): ProjectInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by ? { id: row.invited_by, name: row.inviter_name ?? '' } : null,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    expired: row.expired,
  };
}

/**
 * Email invitations to a project (team-roles design, "Membership and invites"). The
 * anti-goal is invite takeover, an invite accepted by anyone but the person it was sent
 * to, so:
 *
 * - the token is 32 random bytes, stored only as its sha256. The raw token and the link
 *   exist in the create/resend response and the email, nowhere else: never stored,
 *   never logged, never in an exception message;
 * - accepting needs the token, a signed-in account whose email is the invited address,
 *   and, where platform email exists to verify it, a verified one;
 * - the token is spent by one conditional UPDATE in the transaction that adds the
 *   member, so of two accepts at once exactly one succeeds, and a refusal after it (an
 *   existing member row) rolls the spend back.
 *
 * Lock order (global constraints): the project row (`lockProject`), then the billing
 * owner's `users` row FOR NO KEY UPDATE, then the seat check, which needs both: two
 * invites on two projects of one account then count one after the other.
 */
/** What accept's transaction decided; a refusal that must commit is returned, not thrown. */
type AcceptOutcome = { gone: true } | { gone: false; projectId: string; role: ProjectRole };

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly seats: SeatsService,
    private readonly platformEmail: PlatformEmailService,
    private readonly config: ConfigService,
    private readonly activity: ProjectActivityService,
  ) {}

  /** An invitation's entry, in its transaction. The target is named by the invited address. */
  private async log(
    manager: EntityManager,
    actorId: string,
    projectId: string,
    action: 'member.invited' | 'invite.resent' | 'invite.cancelled' | 'invite.accepted',
    invitation: { id: string; email: string },
    ctx: ActivityContext,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.activity.record(
      {
        projectId,
        actor: { kind: 'user', userId: actorId },
        action,
        target: { type: 'invitation', id: invitation.id, label: invitation.email },
        details,
      },
      ctx,
      manager,
    );
  }

  /** Pending invitations, oldest first, with expired ones flagged. */
  async list(projectId: string, manager: EntityManager = this.dataSource.manager): Promise<ProjectInvitation[]> {
    const rows: InvitationRow[] = await manager.query(
      `${VIEW_SQL} WHERE i.project_id = $1 AND ${PENDING_SQL} ORDER BY i.created_at, i.id`,
      [projectId],
    );
    return rows.map(toView);
  }

  /**
   * Invites `email` (already normalised by the DTO, and again here). An existing pending
   * invite for the address, expired or not, is replaced in place: new token, role,
   * inviter and expiry on the same row (the partial unique index allows only one).
   */
  async create(
    user: AuthenticatedUser,
    projectId: string,
    rawEmail: string,
    role: ProjectRole,
    ctx: ActivityContext,
  ): Promise<CreatedInvitation> {
    const email = normaliseEmail(rawEmail);
    const token = newInviteToken();
    const { id, project, plan } = await this.dataSource.transaction(async (manager) => {
      const project = await lockProject(manager, projectId);
      const actor = await actorUnderLock(manager, project, user.userId, 'members.manage');
      if (role === 'owner') {
        if (actor.role !== 'owner') throw new ForbiddenException(ROLE_REFUSAL);
        assertRecentAuth(user);
      }
      await this.assertNotMember(manager, projectId, email);
      if (await this.lockBillingOwner(manager, project)) throw new ForbiddenException(INVITES_SUSPENDED);
      await this.seats.assertRoomFor(manager, project.ownerId, email);

      const pending = await manager.findOne(ProjectInvitationEntity, {
        where: { projectId, email, acceptedAt: IsNull(), revokedAt: IsNull() },
        select: { id: true, role: true },
      });
      // Replacing kills the pending link and sets a new role: an owner invite is the
      // owners' to replace, as it is theirs to resend or revoke.
      if (pending?.role === 'owner' && actor.role !== 'owner') throw new ForbiddenException(ROLE_REFUSAL);
      const plan = await this.planEmail(manager, project);
      let id: string;
      if (pending) {
        await this.reissue(manager, pending.id, token, user.userId, role);
        id = pending.id;
      } else {
        const [row] = await manager.query(
          `INSERT INTO project_invitations (project_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::float8))
           RETURNING id`,
          [projectId, email, role, hashInviteToken(token), user.userId, INVITE_TTL_MS / 1000],
        );
        id = row.id as string;
      }
      await this.log(manager, user.userId, projectId, 'member.invited', { id, email }, ctx, { role, email });
      return { id, project, plan };
    });
    return this.deliver(project, id, token, plan);
  }

  /** A new token and a new 7-day expiry for a pending invite; the old link stops working. */
  async resend(
    user: AuthenticatedUser,
    projectId: string,
    invitationId: string,
    ctx: ActivityContext,
  ): Promise<CreatedInvitation> {
    const token = newInviteToken();
    const { project, plan } = await this.dataSource.transaction(async (manager) => {
      const project = await lockProject(manager, projectId);
      const actor = await actorUnderLock(manager, project, user.userId, 'members.manage');
      const invitation = await this.pendingIn(manager, projectId, invitationId);
      if (invitation.role === 'owner') {
        if (actor.role !== 'owner') throw new ForbiddenException(ROLE_REFUSAL);
        // A new working link to ownership, as creating one needs.
        assertRecentAuth(user);
      }
      await this.assertNotMember(manager, projectId, invitation.email);
      if (await this.lockBillingOwner(manager, project)) throw new ForbiddenException(INVITES_SUSPENDED);
      // An expired invite holds no seat, so reviving it is checked like a new one.
      await this.seats.assertRoomFor(manager, project.ownerId, invitation.email);
      const plan = await this.planEmail(manager, project);
      await this.reissue(manager, invitation.id, token, user.userId, invitation.role);
      await this.log(manager, user.userId, projectId, 'invite.resent', invitation, ctx);
      return { project, plan };
    });
    return this.deliver(project, invitationId, token, plan);
  }

  /** Revokes a pending invite (its link stops working) and returns those left. */
  async revoke(
    user: AuthenticatedUser,
    projectId: string,
    invitationId: string,
    ctx: ActivityContext,
  ): Promise<ProjectInvitation[]> {
    return this.dataSource.transaction(async (manager) => {
      const project = await lockProject(manager, projectId);
      const actor = await actorUnderLock(manager, project, user.userId, 'members.manage');
      const invitation = await this.pendingIn(manager, projectId, invitationId);
      if (invitation.role === 'owner' && actor.role !== 'owner') throw new ForbiddenException(ROLE_REFUSAL);
      await manager.update(ProjectInvitationEntity, { id: invitation.id }, { revokedAt: () => 'now()' });
      await this.log(manager, user.userId, projectId, 'invite.cancelled', invitation, ctx);
      return this.list(projectId, manager);
    });
  }

  /** What the invite page shows. Spends nothing; the same generic 400 as accept for a dead token. */
  async preview(user: AuthenticatedUser, token: string): Promise<InvitationPreview> {
    refuseViewAs(user);
    const [row] = await this.dataSource.query(
      `SELECT i.email, i.role, p.name AS project_name, u.name AS inviter_name
         FROM project_invitations i
         JOIN projects p ON p.id = i.project_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.token_hash = $1 AND ${PENDING_SQL} AND i.expires_at > now()`,
      [hashInviteToken(token)],
    );
    if (!row) throw new BadRequestException(INVITE_GONE);
    const account = await this.account(this.dataSource.manager, user.userId);
    return {
      projectName: row.project_name,
      role: row.role,
      inviterName: row.inviter_name ?? null,
      invitedEmailMasked: maskEmail(row.email),
      matchesAccount: normaliseEmail(account.email) === row.email,
      emailVerificationRequired: this.platformEmail.isConfigured && !account.emailVerifiedAt,
    };
  }

  /**
   * The signed-in person accepts. Refusals: a dead token (400 `INVITE_GONE`), another
   * account (400, the invited address masked), an unverified address where platform
   * email is set up (400), no free seat (403), already a member (409, token unspent), the
 * project's billing owner suspended (400 `INVITE_GONE`, token unspent).
   */
  async accept(
    user: AuthenticatedUser,
    token: string,
    ctx: ActivityContext,
  ): Promise<{ projectId: string; role: ProjectRole }> {
    refuseViewAs(user);
    const tokenHash = hashInviteToken(token);
    const outcome = await this.dataSource.transaction(async (manager): Promise<AcceptOutcome> => {
      const invitation = await manager.findOne(ProjectInvitationEntity, { where: { tokenHash } });
      if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException(INVITE_GONE);
      }
      const account = await this.account(manager, user.userId);
      if (normaliseEmail(account.email) !== invitation.email) {
        throw new BadRequestException(wrongAccountMessage(invitation.email));
      }
      if (this.platformEmail.isConfigured && !account.emailVerifiedAt) {
        throw new BadRequestException(VERIFY_EMAIL_FIRST);
      }

      const project = await manager.findOne(ProjectEntity, {
        where: { id: invitation.projectId },
        lock: { mode: 'for_no_key_update' },
      });
      if (!project) throw new BadRequestException(INVITE_GONE);
      // A suspended account's project takes no one in. Thrown before the spend, so the
      // token stays usable after reactivation, within its 7 days.
      if (await this.lockBillingOwner(manager, project)) throw new BadRequestException(INVITE_GONE);
      await this.seats.assertRoomFor(manager, project.ownerId, invitation.email, {
        acceptingInvitationId: invitation.id,
      });

      // The spend. The invite was read before the locks, and while this waited for them it
      // may have been accepted, revoked, or replaced (a re-invite or resend: new token,
      // possibly a new role). This is the one check that decides: it matches this token
      // on a still-pending, unexpired row, and the role inserted is the one it returns, so
      // a replaced token spends nothing and never carries the old role in.
      const spent = await manager
        .createQueryBuilder()
        .update(ProjectInvitationEntity)
        .set({ acceptedAt: () => 'now()', acceptedBy: user.userId })
        .where('id = :id AND token_hash = :tokenHash', { id: invitation.id, tokenHash })
        .andWhere('accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()')
        .returning(['id', 'projectId', 'role', 'invitedBy'])
        .execute();
      const [row] = spent.raw as Array<{ project_id: string; role: ProjectRole; invited_by: string | null }>;
      if (!row || row.project_id !== project.id) throw new BadRequestException(INVITE_GONE);
      // The invite carries the inviter's authority, so it ends with it: the inviter must
      // still be here, still allowed to invite, and still an owner for an owner invite.
      // Read under the project lock that their removal or demotion also takes.
      if (!(await this.inviterStillMay(manager, project.id, row.invited_by, row.role))) {
        // A dead invite: end it rather than leave it pending. The spend above is undone
        // and the row marked revoked in the same write; no member is added. The commit
        // keeps this, and the 400 is thrown after it.
        await manager
          .createQueryBuilder()
          .update(ProjectInvitationEntity)
          .set({ acceptedAt: null, acceptedBy: null, revokedAt: () => 'now()' })
          .where('id = :id AND token_hash = :tokenHash AND accepted_by = :userId', {
            id: invitation.id,
            tokenHash,
            userId: user.userId,
          })
          .execute();
        return { gone: true };
      }

      const inserted: unknown[] = await manager.query(
        `INSERT INTO project_members (project_id, user_id, role, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT "UQ_project_members_project_user" DO NOTHING
         RETURNING id`,
        [project.id, user.userId, row.role, row.invited_by],
      );
      // Throwing rolls the spend back: the invite stays usable.
      if (inserted.length === 0) throw new ConflictException(ALREADY_MEMBER);
      // The person accepting is the actor; a failed write rolls the spend and the member back.
      await this.log(manager, user.userId, project.id, 'invite.accepted', invitation, ctx);
      return { gone: false, projectId: project.id, role: row.role };
    });
    if (outcome.gone) throw new BadRequestException(INVITE_GONE);
    return { projectId: outcome.projectId, role: outcome.role };
  }

  /** After the commit: the email (if platform email is set up and allowed) and the once-only link. */
  private async deliver(
    project: ProjectEntity,
    invitationId: string,
    token: string,
    plan: EmailPlan,
  ): Promise<CreatedInvitation> {
    const [row]: InvitationRow[] = await this.dataSource.query(`${VIEW_SQL} WHERE i.id = $1`, [invitationId]);
    const invitation = toView(row);
    const inviteUrl = accountLink(this.config.get<string>('app.appUrl') as string, INVITE_PATH, token);
    if (plan === 'skip_daily_limit') {
      // Ids only: the address and the link stay out of logs.
      this.logger.warn(
        `Invite email not sent: billing account ${project.ownerId} reached ${INVITE_EMAILS_PER_DAY} in 24 hours (project ${project.id})`,
      );
      return { invitation, inviteUrl, emailSent: false, emailSkipped: 'daily_limit' };
    }
    const result = await this.platformEmail.send(
      projectInviteEmail(invitation.email, {
        projectName: project.name,
        inviterName: invitation.invitedBy?.name || 'Someone',
        role: invitation.role,
        link: inviteUrl,
        expiresAt: new Date(invitation.expiresAt),
      }),
    );
    return { invitation, inviteUrl, emailSent: result.sent };
  }

  /**
   * Counts this billing account's invite emails in the past 24 hours and, under the
   * allowance, records one more. Under the billing owner's users row lock the caller
   * holds, so invites arriving together on several of the account's projects count one
   * after the other. A row is written only for an email that will be attempted: none
   * when platform email is not set up. Rows older than 7 days are deleted here (the
   * table's only retention).
   */
  private async planEmail(manager: EntityManager, project: ProjectEntity): Promise<EmailPlan> {
    if (!this.platformEmail.isConfigured) return 'attempt';
    await manager.query(
      `DELETE FROM invitation_email_sends WHERE billing_owner_id = $1 AND created_at < now() - interval '7 days'`,
      [project.ownerId],
    );
    const [{ n }] = await manager.query(
      `SELECT count(*)::int AS n FROM invitation_email_sends
        WHERE billing_owner_id = $1 AND created_at > now() - interval '24 hours'`,
      [project.ownerId],
    );
    if (n >= INVITE_EMAILS_PER_DAY) return 'skip_daily_limit';
    await manager.query(`INSERT INTO invitation_email_sends (billing_owner_id, project_id) VALUES ($1, $2)`, [
      project.ownerId,
      project.id,
    ]);
    return 'attempt';
  }

  private async reissue(
    manager: EntityManager,
    id: string,
    token: string,
    invitedBy: string,
    role: ProjectRole,
  ): Promise<void> {
    await manager.query(
      `UPDATE project_invitations
          SET token_hash = $2, role = $3, invited_by = $4,
              expires_at = now() + make_interval(secs => $5::float8)
        WHERE id = $1`,
      [id, hashInviteToken(token), role, invitedBy, INVITE_TTL_MS / 1000],
    );
  }

  /** A pending invite of this project (never looked up by id alone), else 404. */
  private async pendingIn(
    manager: EntityManager,
    projectId: string,
    invitationId: string,
  ): Promise<ProjectInvitationEntity> {
    const invitation = await manager.findOne(ProjectInvitationEntity, {
      where: { id: invitationId, projectId, acceptedAt: IsNull(), revokedAt: IsNull() },
    });
    if (!invitation) throw new NotFoundException(INVITATION_NOT_FOUND);
    return invitation;
  }

  private async inviterStillMay(
    manager: EntityManager,
    projectId: string,
    invitedBy: string | null,
    role: ProjectRole,
  ): Promise<boolean> {
    if (!invitedBy) return false;
    const inviter = await membershipOf(manager, projectId, invitedBy);
    if (!inviter || !roleCan(inviter.role, 'members.manage')) return false;
    return role !== 'owner' || inviter.role === 'owner';
  }

  private async assertNotMember(manager: EntityManager, projectId: string, email: string): Promise<void> {
    const [row] = await manager.query(
      `SELECT 1 FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 AND u.email = $2 LIMIT 1`,
      [projectId, email],
    );
    if (row) throw new ConflictException(ALREADY_MEMBER);
  }

  /**
   * The second lock, after the project row: what the seat count of this account waits on.
   * Returns whether the billing owner is suspended, read under that lock (a suspension
   * updates the same row, so it is either committed before this or waits for it). Callers
   * refuse then, before any email is planned or counted.
   */
  private async lockBillingOwner(manager: EntityManager, project: ProjectEntity): Promise<boolean> {
    const owner = await manager.findOne(UserEntity, {
      where: { id: project.ownerId },
      select: { id: true, suspendedAt: true },
      lock: { mode: 'for_no_key_update' },
    });
    return Boolean(owner?.suspendedAt);
  }

  private async account(manager: EntityManager, userId: string): Promise<Pick<UserEntity, 'email' | 'emailVerifiedAt'>> {
    const account = await manager.findOne(UserEntity, {
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    // JwtStrategy found the account on this request; gone since, it can accept nothing.
    if (!account) throw new BadRequestException(INVITE_GONE);
    return account;
  }
}

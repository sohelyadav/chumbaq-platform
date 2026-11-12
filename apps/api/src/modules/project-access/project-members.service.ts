import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import type { BillingOffer, ProjectMember, ProjectMembersResponse } from '@chumbaq/shared';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { assertRecentAuth } from '../auth/guards/recent-auth.guard';
import { ProjectEntity } from '../projects/entities/project.entity';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService, memberTarget } from '../project-activity/project-activity.service';
import { ProjectInvitationEntity } from './entities/project-invitation.entity';
import { ProjectMemberEntity } from './entities/project-member.entity';
import {
  PROJECT_NOT_FOUND,
  ROLE_REFUSAL,
  roleCan,
  type ProjectPermission,
  type ProjectRole,
} from './project-permissions';

export const MEMBER_NOT_FOUND = 'Member not found';
export const MOVE_BILLING_FIRST = 'Move billing ownership to another owner first.';
export const LAST_OWNER = 'A project needs at least one owner.';

/**
 * The first step of every membership and billing mutation: the project row, FOR NO KEY
 * UPDATE. Every such mutation takes it, so they run one at a time per project and each
 * sees the memberships the one before it left. Users rows, where a mutation needs them,
 * come after it, in ascending id (`inLockOrder`).
 */
export async function lockProject(manager: EntityManager, projectId: string): Promise<ProjectEntity> {
  const project = await manager.findOne(ProjectEntity, {
    where: { id: projectId },
    lock: { mode: 'for_no_key_update' },
  });
  if (!project) throw new NotFoundException(PROJECT_NOT_FOUND);
  return project;
}

export function membershipOf(
  manager: EntityManager,
  projectId: string,
  userId: string,
): Promise<ProjectMemberEntity | null> {
  return manager.findOne(ProjectMemberEntity, { where: { projectId, userId } });
}

/**
 * The caller's own membership, read again under the project lock: the guard's read came
 * before it, and a concurrent change (another owner demoting this one) may have landed
 * since. Gone: 404 `Project not found`; no longer allowed: 403 `ROLE_REFUSAL`.
 */
export async function actorUnderLock(
  manager: EntityManager,
  project: ProjectEntity,
  userId: string,
  permission: ProjectPermission,
): Promise<ProjectMemberEntity> {
  const actor = await membershipOf(manager, project.id, userId);
  if (!actor) throw new NotFoundException(PROJECT_NOT_FOUND);
  if (!roleCan(actor.role, permission)) throw new ForbiddenException(ROLE_REFUSAL);
  return actor;
}

/**
 * The project's live offer, judged by the database clock: an offer is live while
 * `pending_billing_offered_at` is less than 7 days old by `now()`, never by the API's
 * `Date.now()` (as `SessionsService.rotate` does for session age). `expiresAt` is the
 * value the database computed. Run it inside the transaction that holds the project
 * lock when the answer decides a write.
 */
export const BILLING_OFFER_SQL = `
  SELECT pending_billing_owner_id AS "toUserId",
         pending_billing_offered_at AS "offeredAt",
         pending_billing_offered_at + interval '7 days' AS "expiresAt"
    FROM projects
   WHERE id = $1
     AND pending_billing_owner_id IS NOT NULL
     AND pending_billing_offered_at > now() - interval '7 days'`;

/** The project's pending offer as the dashboard sees it: null once lapsed. */
export async function billingOfferOf(manager: EntityManager, projectId: string): Promise<BillingOffer> {
  const [row] = (await manager.query(BILLING_OFFER_SQL, [projectId])) as Array<{
    toUserId: string;
    offeredAt: Date;
    expiresAt: Date;
  }>;
  if (!row) return null;
  return {
    toUserId: row.toUserId,
    offeredAt: new Date(row.offeredAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

/** Clears the pending offer if it was made to `userId`, who is no longer an owner here. */
export async function clearOfferTo(manager: EntityManager, project: ProjectEntity, userId: string): Promise<void> {
  if (project.pendingBillingOwnerId !== userId) return;
  await manager.update(
    ProjectEntity,
    { id: project.id },
    { pendingBillingOwnerId: null, pendingBillingOfferedAt: null },
  );
  project.pendingBillingOwnerId = null;
  project.pendingBillingOfferedAt = null;
}

/**
 * Revokes the pending invites `userId` sent in this project that their place no longer
 * covers: `'all'` when they lose `members.manage` (removed, leaving, made a member),
 * `'owner'` when they stop being an owner (only owners invite owners). In the caller's
 * transaction, under its project lock, so an invite never outlives the access that made
 * it. Accept checks the inviter again as well (`InvitationsService.accept`).
 */
export async function revokeInvitesSentBy(
  manager: EntityManager,
  projectId: string,
  userId: string,
  which: 'all' | 'owner',
): Promise<void> {
  await manager.update(
    ProjectInvitationEntity,
    {
      projectId,
      invitedBy: userId,
      acceptedAt: IsNull(),
      revokedAt: IsNull(),
      ...(which === 'owner' ? { role: 'owner' as const } : {}),
    },
    { revokedAt: () => 'now()' },
  );
}

const ROLE_ORDER = `CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`;

/**
 * Who is in a project and what they are, and the owners' rules about it (team-roles
 * design, "Owners" and "Membership and invites"):
 *
 * - admins manage admins and members only, and only owners make owners;
 * - the billing owner stays an owner until billing has moved (409 `MOVE_BILLING_FIRST`);
 * - the last owner cannot be demoted, removed or leave (409 `LAST_OWNER`);
 * - granting owner, or demoting or removing an owner (an owner leaving included), needs a
 *   recent sign-in, checked before the 409s so a stale session learns nothing.
 *
 * Every mutation is one transaction that locks the project row first, then re-reads the
 * caller's membership and the target's under it, so the owner count it checks cannot
 * change before it commits: two owners demoting each other at once run one after the
 * other, and the second finds itself no longer an owner.
 *
 * Each mutation writes its activity entry in the same transaction, after the change, so
 * a failed log write rolls the change back. A no-op (the same role) writes none.
 */
@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly activity: ProjectActivityService,
  ) {}

  /** Everyone in the project with their email and name (nothing else of the user), and the pending offer. */
  async list(projectId: string, manager: EntityManager = this.dataSource.manager): Promise<ProjectMembersResponse> {
    const [project, rows, billingOffer] = await Promise.all([
      manager.findOne(ProjectEntity, {
        where: { id: projectId },
        select: { id: true, ownerId: true },
      }),
      manager.query(
        `SELECT m.user_id AS "userId", u.email AS email, u.name AS name, m.role AS role,
                m.created_at AS "createdAt"
           FROM project_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.project_id = $1
          ORDER BY ${ROLE_ORDER}, m.created_at, m.user_id`,
        [projectId],
      ) as Promise<Array<{ userId: string; email: string; name: string; role: ProjectRole; createdAt: Date }>>,
      billingOfferOf(manager, projectId),
    ]);
    if (!project) throw new NotFoundException(PROJECT_NOT_FOUND);
    const members: ProjectMember[] = rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role,
      isBillingOwner: r.userId === project.ownerId,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
    return { members, billingOffer };
  }

  /** Same role: nothing changes (200). */
  async changeRole(
    user: AuthenticatedUser,
    projectId: string,
    targetUserId: string,
    role: ProjectRole,
    ctx: ActivityContext,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const project = await lockProject(manager, projectId);
      const actor = await actorUnderLock(manager, project, user.userId, 'members.manage');
      const target = await membershipOf(manager, projectId, targetUserId);
      if (!target) throw new NotFoundException(MEMBER_NOT_FOUND);
      if (actor.role !== 'owner' && (target.role === 'owner' || role === 'owner')) {
        throw new ForbiddenException(ROLE_REFUSAL);
      }
      if (target.role === role) return;
      // Before the 409s, so a stale session learns nothing about the project's owners.
      if (role === 'owner' || target.role === 'owner') assertRecentAuth(user);
      if (role !== 'owner') await this.assertMayStopBeingOwner(manager, project, target);

      await manager.update(ProjectMemberEntity, { id: target.id }, { role });
      if (role !== 'owner') await clearOfferTo(manager, project, target.userId);
      if (!roleCan(role, 'members.manage')) await revokeInvitesSentBy(manager, projectId, target.userId, 'all');
      else if (target.role === 'owner' && role !== 'owner') {
        await revokeInvitesSentBy(manager, projectId, target.userId, 'owner');
      }
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: user.userId },
          action: 'member.role_changed',
          target: await memberTarget(manager, target.userId),
          details: { from: target.role, to: role },
        },
        ctx,
        manager,
      );
    });
  }

  async remove(user: AuthenticatedUser, projectId: string, targetUserId: string, ctx: ActivityContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const project = await lockProject(manager, projectId);
      const actor = await actorUnderLock(manager, project, user.userId, 'members.manage');
      const target = await membershipOf(manager, projectId, targetUserId);
      if (!target) throw new NotFoundException(MEMBER_NOT_FOUND);
      if (actor.role !== 'owner' && target.role === 'owner') throw new ForbiddenException(ROLE_REFUSAL);
      if (target.role === 'owner') assertRecentAuth(user);
      await this.assertMayStopBeingOwner(manager, project, target);

      await manager.delete(ProjectMemberEntity, { id: target.id });
      await clearOfferTo(manager, project, target.userId);
      await revokeInvitesSentBy(manager, projectId, target.userId, 'all');
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: user.userId },
          action: 'member.removed',
          target: await memberTarget(manager, target.userId),
        },
        ctx,
        manager,
      );
    });
  }

  /** The caller leaves. Any member may, except the billing owner and the last owner. */
  async leave(user: AuthenticatedUser, projectId: string, ctx: ActivityContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const project = await lockProject(manager, projectId);
      const self = await actorUnderLock(manager, project, user.userId, 'project.read');
      // An owner leaving removes an owner, which needs a recent sign-in (the role as read under the lock).
      if (self.role === 'owner') assertRecentAuth(user);
      await this.assertMayStopBeingOwner(manager, project, self);

      await manager.delete(ProjectMemberEntity, { id: self.id });
      await clearOfferTo(manager, project, self.userId);
      await revokeInvitesSentBy(manager, projectId, self.userId, 'all');
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: user.userId },
          action: 'member.left',
          target: await memberTarget(manager, self.userId),
        },
        ctx,
        manager,
      );
    });
  }

  /**
   * Refuses taking `target` out of the owners (demoting, removing, leaving) when they are
   * the billing owner or the last owner. The count is read under the project lock, which
   * every mutation of this project's members takes first.
   */
  private async assertMayStopBeingOwner(
    manager: EntityManager,
    project: ProjectEntity,
    target: ProjectMemberEntity,
  ): Promise<void> {
    if (project.ownerId === target.userId) throw new ConflictException(MOVE_BILLING_FIRST);
    if (target.role !== 'owner') return;
    const owners = await manager.count(ProjectMemberEntity, { where: { projectId: project.id, role: 'owner' } });
    if (owners <= 1) throw new ConflictException(LAST_OWNER);
  }
}

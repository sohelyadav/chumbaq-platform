import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { ProjectActivityAction } from '@chumbaq/shared';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { inLockOrder } from '../factor-resets/lock-users';
import { ProjectEntity } from '../projects/entities/project.entity';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService, memberTarget } from '../project-activity/project-activity.service';
import { effectiveProjectLimit, projectLimitMessage } from '../projects/projects.service';
import { UserEntity } from '../users/entities/user.entity';
import {
  MEMBER_NOT_FOUND,
  actorUnderLock,
  billingOfferOf,
  lockProject,
  membershipOf,
} from './project-members.service';
import { ROLE_REFUSAL } from './project-permissions';
import { SeatsService } from './seats.service';

export const BILLING_TARGET_NOT_OWNER = 'Billing ownership can only move to another owner of this project.';
export const BILLING_OFFER_GONE = 'This billing transfer has expired or was cancelled.';
export const BILLING_SUSPENDED = "Billing can't move while either account is suspended.";

/**
 * Moving a project to another billing account (`projects.owner_id`), in two steps
 * (team-roles design, "Owners"): the billing owner offers it to another owner, and that
 * owner accepts within 7 days. The receiver's limits are checked when they accept,
 * because that is when the project starts to count against them.
 *
 * Lock order: the project row (`lockProject`), then users rows in ascending id
 * (`inLockOrder`), as every membership, invite and project-create transaction takes them.
 */
@Injectable()
export class BillingTransferService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly seats: SeatsService,
    private readonly activity: ProjectActivityService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** The entry for a billing step, in the step's transaction; the target is the offer's receiver. */
  private async log(
    manager: EntityManager,
    user: AuthenticatedUser,
    projectId: string,
    action: ProjectActivityAction,
    toUserId: string,
    ctx: ActivityContext,
  ): Promise<void> {
    await this.activity.record(
      {
        projectId,
        actor: { kind: 'user', userId: user.userId },
        action,
        target: await memberTarget(manager, toUserId),
        details: { toUserId },
      },
      ctx,
      manager,
    );
  }

  /** Replaces any earlier offer. The caller must be the billing owner, the target another owner. */
  async offerBilling(user: AuthenticatedUser, projectId: string, toUserId: string, ctx: ActivityContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const project = await this.lockAsBillingOwner(manager, projectId, user.userId);
      if (toUserId.toLowerCase() === user.userId.toLowerCase()) {
        throw new BadRequestException(BILLING_TARGET_NOT_OWNER);
      }
      const target = await membershipOf(manager, projectId, toUserId);
      if (!target) throw new NotFoundException(MEMBER_NOT_FOUND);
      if (target.role !== 'owner') throw new BadRequestException(BILLING_TARGET_NOT_OWNER);
      await manager.update(
        ProjectEntity,
        { id: projectId },
        { pendingBillingOwnerId: target.userId, pendingBillingOfferedAt: new Date() },
      );
      await this.log(manager, user, projectId, 'billing.transfer_offered', target.userId, ctx);
    });
  }

  /** Clears the offer, if any (a lapsed one too). The caller must be the billing owner. No offer: nothing logged. */
  async cancelBillingOffer(user: AuthenticatedUser, projectId: string, ctx: ActivityContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const project = await this.lockAsBillingOwner(manager, projectId, user.userId);
      const offeredTo = project.pendingBillingOwnerId;
      await manager.update(
        ProjectEntity,
        { id: projectId },
        { pendingBillingOwnerId: null, pendingBillingOfferedAt: null },
      );
      if (offeredTo) await this.log(manager, user, projectId, 'billing.transfer_cancelled', offeredTo, ctx);
    });
  }

  /**
   * The receiver turns the offer down: clears it if it is to them, and nothing else
   * (the billing owner stays). Anyone else, or no offer, gets 400 `BILLING_OFFER_GONE`
   * like accept. An offer past 7 days is still theirs to clear.
   */
  async declineBilling(user: AuthenticatedUser, projectId: string, ctx: ActivityContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const project = await lockProject(manager, projectId);
      const offeredTo = project.pendingBillingOwnerId;
      if (!offeredTo || offeredTo.toLowerCase() !== user.userId.toLowerCase()) {
        throw new BadRequestException(BILLING_OFFER_GONE);
      }
      await manager.update(
        ProjectEntity,
        { id: projectId },
        { pendingBillingOwnerId: null, pendingBillingOfferedAt: null },
      );
      await this.log(manager, user, projectId, 'billing.transfer_declined', offeredTo, ctx);
    });
  }

  /**
   * The receiver takes billing ownership: refused (400 `BILLING_OFFER_GONE`) without a
   * live offer to them or once they are no longer an owner, (409) while either account
   * is suspended, and (403) when the project would take them over their project limit or
   * their seat limit.
   */
  async acceptBilling(user: AuthenticatedUser, projectId: string, ctx: ActivityContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const project = await lockProject(manager, projectId);
      // No offer, another person's, or older than 7 days by the database clock.
      if ((await billingOfferOf(manager, projectId))?.toUserId !== user.userId) throw new BadRequestException(BILLING_OFFER_GONE);
      const receiverMembership = await membershipOf(manager, projectId, user.userId);
      if (receiverMembership?.role !== 'owner') throw new BadRequestException(BILLING_OFFER_GONE);

      const locked = new Map<string, UserEntity | null>();
      for (const id of inLockOrder([project.ownerId, user.userId])) {
        locked.set(
          id,
          await manager.findOne(UserEntity, {
            where: { id },
            select: { id: true, suspendedAt: true, projectLimit: true, seatLimit: true },
            lock: { mode: 'for_no_key_update' },
          }),
        );
      }
      const current = locked.get(project.ownerId.toLowerCase());
      const receiver = locked.get(user.userId.toLowerCase());
      if (!current || !receiver) throw new BadRequestException(BILLING_OFFER_GONE);
      if (current.suspendedAt || receiver.suspendedAt) throw new ConflictException(BILLING_SUSPENDED);

      const limit = effectiveProjectLimit(receiver.projectLimit, this.config);
      const owned = await manager.count(ProjectEntity, { where: { ownerId: receiver.id } });
      if (owned + 1 > limit) throw new ForbiddenException(projectLimitMessage(limit));
      await this.seats.assertRoomForTransfer(manager, receiver.id, projectId);

      await manager.update(
        ProjectEntity,
        { id: projectId },
        { ownerId: receiver.id, pendingBillingOwnerId: null, pendingBillingOfferedAt: null },
      );
      await this.log(manager, user, projectId, 'billing.transfer_accepted', receiver.id, ctx);
    });
  }

  /** The project row locked, with the caller still its billing owner and an owner member. */
  private async lockAsBillingOwner(
    manager: EntityManager,
    projectId: string,
    userId: string,
  ): Promise<ProjectEntity> {
    const project = await lockProject(manager, projectId);
    await actorUnderLock(manager, project, userId, 'project.admin');
    if (project.ownerId !== userId) throw new ForbiddenException(ROLE_REFUSAL);
    return project;
  }
}

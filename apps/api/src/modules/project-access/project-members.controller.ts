import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { ProjectMembersResponse } from '@chumbaq/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RecentAuthGuard } from '../auth/guards/recent-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { activityContext } from '../project-activity/activity-context';
import { BillingTransferService } from './billing-transfer.service';
import { ChangeMemberRoleDto, OfferBillingDto } from './dto/project-members.dto';
import { ProjectAccessContext } from './project-access.decorator';
import type { ProjectAccess } from './project-access.service';
import { ProjectMembersService } from './project-members.service';
import { RequireProjectPermission } from './require-project-permission.decorator';

const WRITE_THROTTLE = { default: { ttl: 60_000, limit: 30 } };

/**
 * A project's members and its billing owner. `:memberId` is the member's user id. The
 * route permission is only the first gate: the service re-reads the caller's role under
 * the project lock and applies the owner rules (admins never touch owners; the billing
 * owner and the last owner stay). View-as is refused every write by JwtStrategy.
 *
 * Guard order where RecentAuthGuard is listed: [JwtAuthGuard, ProjectAccessGuard,
 * RecentAuthGuard], since decorators apply bottom-up.
 */
@Controller('projects/:projectId')
@UseGuards(JwtAuthGuard)
export class ProjectMembersController {
  constructor(
    private readonly members: ProjectMembersService,
    private readonly billing: BillingTransferService,
  ) {}

  /** Every member sees everyone's email and name (lead's call). */
  @RequireProjectPermission('project.read')
  @Get('members')
  list(@ProjectAccessContext() access: ProjectAccess): Promise<ProjectMembersResponse> {
    return this.members.list(access.project.id);
  }

  /** A recent sign-in is needed (checked under the lock) to grant owner or change an owner. */
  @RequireProjectPermission('members.manage')
  @Patch('members/:memberId')
  @Throttle(WRITE_THROTTLE)
  async changeRole(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: ChangeMemberRoleDto,
    @Req() req: Request,
  ): Promise<ProjectMembersResponse> {
    await this.members.changeRole(user, access.project.id, memberId, dto.role, activityContext(req));
    return this.members.list(access.project.id);
  }

  /** A recent sign-in is needed (checked under the lock) to remove an owner. */
  @RequireProjectPermission('members.manage')
  @Delete('members/:memberId')
  @Throttle(WRITE_THROTTLE)
  async remove(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Req() req: Request,
  ): Promise<ProjectMembersResponse> {
    await this.members.remove(user, access.project.id, memberId, activityContext(req));
    return this.members.list(access.project.id);
  }

  /** Any member may leave, except the billing owner and the last owner; an owner needs a recent sign-in. */
  @RequireProjectPermission('project.read')
  @Post('leave')
  @HttpCode(200)
  @Throttle(WRITE_THROTTLE)
  async leave(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ left: true }> {
    await this.members.leave(user, access.project.id, activityContext(req));
    return { left: true };
  }

  /** The billing owner offers billing to another owner, for 7 days. */
  @UseGuards(RecentAuthGuard)
  @RequireProjectPermission('project.admin')
  @Post('billing-transfer')
  @HttpCode(200)
  @Throttle(WRITE_THROTTLE)
  async offerBilling(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OfferBillingDto,
    @Req() req: Request,
  ): Promise<ProjectMembersResponse> {
    await this.billing.offerBilling(user, access.project.id, dto.toUserId, activityContext(req));
    return this.members.list(access.project.id);
  }

  @RequireProjectPermission('project.admin')
  @Delete('billing-transfer')
  @Throttle(WRITE_THROTTLE)
  async cancelBillingOffer(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<ProjectMembersResponse> {
    await this.billing.cancelBillingOffer(user, access.project.id, activityContext(req));
    return this.members.list(access.project.id);
  }

  /** The owner offered billing takes it, with their limits checked now. */
  @UseGuards(RecentAuthGuard)
  @RequireProjectPermission('project.admin')
  @Post('billing-transfer/accept')
  @HttpCode(200)
  @Throttle(WRITE_THROTTLE)
  async acceptBilling(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<ProjectMembersResponse> {
    await this.billing.acceptBilling(user, access.project.id, activityContext(req));
    return this.members.list(access.project.id);
  }

  /**
   * The owner offered billing turns it down. `project.read` is enough: the receiver is an
   * owner, and this only clears an offer made to themselves.
   */
  @RequireProjectPermission('project.read')
  @Post('billing-transfer/decline')
  @HttpCode(200)
  @Throttle(WRITE_THROTTLE)
  async declineBilling(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<ProjectMembersResponse> {
    await this.billing.declineBilling(user, access.project.id, activityContext(req));
    return this.members.list(access.project.id);
  }
}

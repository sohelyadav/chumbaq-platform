import { TripwiresService } from '../security-alerts/tripwires.service';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { CreatedInvitation, ProjectInvitation } from '@chumbaq/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { activityContext } from '../project-activity/activity-context';
import { CreateInvitationDto } from './dto/invitations.dto';
import { InvitationsService } from './invitations.service';
import { ProjectAccessContext } from './project-access.decorator';
import type { ProjectAccess } from './project-access.service';
import { RequireProjectPermission } from './require-project-permission.decorator';

/**
 * A project's pending invitations. The route permission is the first gate; the service
 * re-reads the caller's role under the project lock (only owners invite, resend or
 * revoke owner invites; inviting an owner needs a recent sign-in). View-as is refused
 * every write by JwtStrategy. The invite URL in the create and resend responses is the
 * only copy there will ever be: never log it.
 */
@Controller('projects/:projectId/invitations')
@UseGuards(JwtAuthGuard)
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly tripwires: TripwiresService,
  ) {}

  @RequireProjectPermission('members.manage')
  @Get()
  list(@ProjectAccessContext() access: ProjectAccess): Promise<ProjectInvitation[]> {
    return this.invitations.list(access.project.id);
  }

  @RequireProjectPermission('members.manage')
  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  create(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInvitationDto,
    @Req() req: Request,
  ): Promise<CreatedInvitation> {
    const context = activityContext(req);
    this.tripwires.checkEmailLater(dto.email, 'invite', context.ipAddress ?? null);
    return this.invitations.create(user, access.project.id, dto.email, dto.role, context);
  }

  @RequireProjectPermission('members.manage')
  @Post(':invitationId/resend')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  resend(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @Req() req: Request,
  ): Promise<CreatedInvitation> {
    return this.invitations.resend(user, access.project.id, invitationId, activityContext(req));
  }

  @RequireProjectPermission('members.manage')
  @Delete(':invitationId')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  revoke(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser() user: AuthenticatedUser,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @Req() req: Request,
  ): Promise<ProjectInvitation[]> {
    return this.invitations.revoke(user, access.project.id, invitationId, activityContext(req));
  }
}

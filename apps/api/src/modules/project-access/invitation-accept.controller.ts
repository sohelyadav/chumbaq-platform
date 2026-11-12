import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { InvitationPreview } from '@chumbaq/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { activityContext } from '../project-activity/activity-context';
import { InvitationTokenDto } from './dto/invitations.dto';
import { InvitationsService } from './invitations.service';
import type { ProjectRole } from './project-permissions';

const TOKEN_THROTTLE = { default: { ttl: 60_000, limit: 10 } };

/**
 * The invitee's side, account-scoped: the token names the invite, and the caller's own
 * account must be the invited address. The token travels in the body (the page reads
 * it from the link's fragment), never in a URL. Refused in view-as.
 */
@Controller('invitations')
@UseGuards(JwtAuthGuard)
export class InvitationAcceptController {
  constructor(private readonly invitations: InvitationsService) {}

  /** A read over POST, so the token stays out of URLs and logs. */
  @Post('preview')
  @HttpCode(200)
  @Throttle(TOKEN_THROTTLE)
  preview(@CurrentUser() user: AuthenticatedUser, @Body() dto: InvitationTokenDto): Promise<InvitationPreview> {
    return this.invitations.preview(user, dto.token);
  }

  @Post('accept')
  @Throttle(TOKEN_THROTTLE)
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InvitationTokenDto,
    @Req() req: Request,
  ): Promise<{ projectId: string; role: ProjectRole }> {
    return this.invitations.accept(user, dto.token, activityContext(req));
  }
}

import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { assertRecentAuth } from '../auth/guards/recent-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { refuseViewAs } from '../project-access/view-as';
import { activityContext } from '../project-activity/activity-context';
import { IdentityVerificationService } from './identity-verification.service';

/**
 * The project's identity secret, which the tenant's server uses to make the `userHash`
 * every identify with an external id needs. A server secret like an API key: only
 * roles that manage keys see it, staff viewing as the tenant never do, and rotating it
 * (which stops every userHash made with the old one) needs a recent sign-in.
 */
@Controller('projects/:projectId/identity-secret')
@UseGuards(JwtAuthGuard)
export class IdentitySecretController {
  constructor(private readonly verification: IdentityVerificationService) {}

  @Get()
  @RequireProjectPermission('keys.manage')
  async get(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ secret: string; version: number }> {
    refuseViewAs(user);
    return this.verification.currentSecret(projectId);
  }

  @Post('rotate')
  @HttpCode(200)
  @RequireProjectPermission('keys.manage')
  async rotate(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ secret: string; version: number }> {
    refuseViewAs(user);
    assertRecentAuth(user);
    return this.verification.rotate(projectId, user.userId, activityContext(req));
  }
}

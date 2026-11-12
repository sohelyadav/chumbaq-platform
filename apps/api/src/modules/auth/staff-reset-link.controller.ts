import { Controller, ForbiddenException, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { CancelStaffLinkResponse } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { FactorResetsService } from '../factor-resets/factor-resets.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RecentAuthGuard } from './guards/recent-auth.guard';
import type { AuthenticatedUser } from './strategies/jwt.strategy';

/**
 * The owner cancelling a password reset link support issued (`admin:password-reset-link`),
 * from the notice's button or the dashboard banner. Most owners already have a session,
 * and a sign-in page would only send them on to their projects, so this works from it.
 *
 * Needs a recent re-authentication, because a stolen session is exactly what should not
 * be able to undo the real owner's recovery; the dashboard answers the 403 with its
 * re-authentication dialog and resends. That re-authentication voids the links itself,
 * so this often finds none left, which is still a success.
 */
@Controller('auth/staff-reset-link')
@UseGuards(JwtAuthGuard, RecentAuthGuard)
export class StaffResetLinkController {
  constructor(private readonly resets: FactorResetsService) {}

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async cancel(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<CancelStaffLinkResponse> {
    // RecentAuthGuard already refuses these (no `auth_time`); said again, since staff
    // looking through an account must never stop the owner's recovery.
    if (user.impersonatedBy) throw new ForbiddenException('Impersonation sessions are read-only');
    const cancelled = await this.resets.cancelStaffLinksByOwner(user, {
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    return { cancelled };
  }
}

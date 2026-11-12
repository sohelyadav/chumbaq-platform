import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AccountFactorResetState } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { FactorResetsService } from '../factor-resets/factor-resets.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedUser } from './strategies/jwt.strategy';

/**
 * The owner's view of a staff reset of their factors. Cancelling needs no fresh
 * sign-in: it only keeps the factors the account already has, and anyone signed in
 * could reach the account's settings anyway.
 */
@Controller('auth/factor-reset')
@UseGuards(JwtAuthGuard)
export class FactorResetController {
  constructor(private readonly resets: FactorResetsService) {}

  @Get()
  state(@CurrentUser() user: AuthenticatedUser): Promise<AccountFactorResetState> {
    refuseImpersonation(user);
    return this.resets.ownerState(user.userId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<void> {
    refuseImpersonation(user);
    await this.resets.cancelByOwner(user, {
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
  }
}

/** Staff looking through an account must not stop, or learn of, a reset of it. */
function refuseImpersonation(user: AuthenticatedUser): void {
  if (user.impersonatedBy) throw new ForbiddenException('Impersonation sessions are read-only');
}

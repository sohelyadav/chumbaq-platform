import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { ImpersonationHandoff } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationHandoffsService } from '../impersonation/impersonation-handoffs.service';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import type { AuthenticatedStaff } from '../staff-auth/staff-principal';
import { StaffRecentAuthGuard } from '../staff-auth/staff-recent-auth.guard';
import { AdminImpersonateDto } from './dto/admin-impersonate.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';

/**
 * View-as. Answers with a link to the customer app carrying a one-time code, not a
 * token: the customer app exchanges the code itself (`ImpersonationExchangeController`),
 * since the admin app, on another origin, cannot hand it a token.
 */
@Controller('admin')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminImpersonationController {
  constructor(private readonly handoffs: ImpersonationHandoffsService) {}

  @Post('tenants/:id/impersonate')
  @UseGuards(StaffRecentAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  impersonate(
    @Param('id', ParseUUIDPipe) targetId: string,
    @Body() dto: AdminImpersonateDto,
    @CurrentUser() actor: AuthenticatedStaff,
    @Req() req: Request,
  ): Promise<ImpersonationHandoff> {
    return this.handoffs.create({
      actor: { userId: actor.userId, email: actor.email, sessionId: actor.sessionId },
      targetId,
      reason: dto.reason,
      ipAddress: getClientIp(req),
    });
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AdminFactorResetState } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { StaffRecentAuthGuard } from '../staff-auth/staff-recent-auth.guard';
import { FactorResetsService } from '../factor-resets/factor-resets.service';
import { AdminFactorResetRequestDto } from './dto/admin-tenants.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';

/**
 * Staff-assisted second-factor reset for a tenant who has lost every factor. Starting
 * one hands the account to whoever has the password once the wait is over, so it needs
 * a fresh sign-in and a reason, as suspending does. Cancelling only keeps things as
 * they are, so it needs neither.
 */
@Controller('admin/tenants/:id/factor-reset')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminFactorResetsController {
  constructor(private readonly resets: FactorResetsService) {}

  @Get()
  state(@Param('id', ParseUUIDPipe) id: string): Promise<AdminFactorResetState> {
    return this.resets.adminState(id);
  }

  @Post()
  @UseGuards(StaffRecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  request(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminFactorResetRequestDto,
    @CurrentUser() user: { userId: string; email: string },
    @Req() req: Request,
  ): Promise<AdminFactorResetState> {
    return this.resets.request(
      id,
      dto.reason,
      { userId: user.userId, email: user.email, ipAddress: getClientIp(req) },
      {
        verificationMethod: dto.verificationMethod,
        verificationNotes: dto.verificationNotes,
        passwordResetOverride: dto.recentResetJustification ?? null,
      },
    );
  }

  @Delete()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string; email: string },
    @Req() req: Request,
  ): Promise<AdminFactorResetState> {
    return this.resets.cancelByStaff(id, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(req),
    });
  }
}

import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { AdminTenantUsage } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { AdminUsageService } from './admin-usage.service';
import { AdminUsageDto } from './dto/admin-usage.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';

/** Usage counts from the daily roll-up: counts only, never a tenant's end users. */
@Controller('admin')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminUsageController {
  constructor(private readonly usage: AdminUsageService) {}

  /** Recorded as a `tenant.viewed` read, deduplicated with the tenant page's. */
  @Get('tenants/:id/usage')
  tenantUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminUsageDto,
    @CurrentUser() user: { userId: string; email: string },
    @Req() request: Request,
  ): Promise<AdminTenantUsage> {
    return this.usage.tenantUsage(id, query.days, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(request),
    });
  }
}

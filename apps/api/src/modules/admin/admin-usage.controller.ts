import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AdminTenantUsage } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VolumeWatchService } from '../security-alerts/volume-watch.service';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { EXPORT_HEADERS } from './admin-audit-logs.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminUsageService } from './admin-usage.service';
import { AdminTenantsFilterDto } from './dto/admin-tenants.dto';
import { AdminUsageDto } from './dto/admin-usage.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { TENANT_EXPORT_ROW_CAP } from './tenants-csv';

/**
 * Usage counts from the daily roll-up, and the tenants list as a file: counts
 * only, never a tenant's end users. Declared before `AdminTenantsController`
 * in `AdminModule`, so `tenants/export` is matched before `tenants/:id`.
 */
@Controller('admin')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminUsageController {
  constructor(
    private readonly usage: AdminUsageService,
    private readonly tenants: AdminTenantsService,
    private readonly volume: VolumeWatchService,
  ) {}

  /**
   * The tenants list with its filters and sort, unpaged and capped. Sent through
   * `res` directly, so TransformInterceptor's `{ data }` envelope never wraps a
   * file. Throttled well below the global limit: each export reads up to the cap
   * and writes an audit row.
   */
  @Get('tenants/export')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async exportTenants(
    @Query() filters: AdminTenantsFilterDto,
    @CurrentUser() user: { userId: string; email: string },
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.tenants.exportCsv(filters, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(request),
    });
    // Not awaited: the bulk-export alarm never holds up the file.
    this.volume.exported(user.userId, null, result.rowCount, 'tenants export');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

    response
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="chumbaq-tenants-${stamp}.csv"`,
        'Cache-Control': 'no-store',
        [EXPORT_HEADERS.rowCount]: String(result.rowCount),
        [EXPORT_HEADERS.rowCap]: String(TENANT_EXPORT_ROW_CAP),
        [EXPORT_HEADERS.truncated]: String(result.truncated),
        'Access-Control-Expose-Headers': ['Content-Disposition', ...Object.values(EXPORT_HEADERS)].join(', '),
      })
      // The byte-order mark is how Excel knows the file is UTF-8.
      .send(Buffer.from(`﻿${result.csv}`, 'utf8'));
  }

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

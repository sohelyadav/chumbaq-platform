import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  AUDIT_EXPORT_ROW_CAP,
  AdminAuditLogPage,
  AdminAuditLogsService,
} from './admin-audit-logs.service';
import {
  AdminAuditLogsExportDto,
  AdminAuditLogsQueryDto,
} from './dto/admin-audit-logs-query.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';

/** Says what an export holds, readable by the dashboard across origins. */
export const EXPORT_HEADERS = {
  rowCount: 'X-Export-Row-Count',
  rowCap: 'X-Export-Row-Cap',
  truncated: 'X-Export-Truncated',
} as const;

/** The audit log is append-only and has no write routes. */
@Controller('admin')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminAuditLogsController {
  constructor(private readonly auditLogs: AdminAuditLogsService) {}

  @Get('audit-logs')
  list(@Query() query: AdminAuditLogsQueryDto): Promise<AdminAuditLogPage> {
    return this.auditLogs.list(query);
  }

  /**
   * Sent through `res` directly, so TransformInterceptor's `{ data }` envelope never
   * wraps a file. Throttled well below the global limit: each export reads up to the
   * cap and writes an audit row.
   */
  @Get('audit-logs/export')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async export(
    @Query() filters: AdminAuditLogsExportDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.auditLogs.export(filters, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(request),
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

    response
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="chumbaq-audit-log-${stamp}.csv"`,
        'Cache-Control': 'no-store',
        [EXPORT_HEADERS.rowCount]: String(result.rowCount),
        [EXPORT_HEADERS.rowCap]: String(AUDIT_EXPORT_ROW_CAP),
        [EXPORT_HEADERS.truncated]: String(result.truncated),
        'Access-Control-Expose-Headers': [
          'Content-Disposition',
          ...Object.values(EXPORT_HEADERS),
        ].join(', '),
      })
      // The byte-order mark is how Excel knows the file is UTF-8.
      .send(Buffer.from(`﻿${result.csv}`, 'utf8'));
  }
}

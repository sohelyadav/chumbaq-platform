import { VolumeWatchService, countCsvRows } from '../security-alerts/volume-watch.service';
import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { ProjectActivityPage } from '@chumbaq/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { refuseViewAs } from '../project-access/view-as';
import { activityContext } from './activity-context';
import {
  ActivityFilterDto,
  ActivityQueryDto,
  ActivityQueryPipe,
  type ActivityFilters,
  type ActivityQuery,
} from './dto/activity-query.dto';
import { ProjectActivityQueryService } from './project-activity-query.service';

/**
 * The Activity page: owners and admins (`activity.view`) read and download the project's
 * log. There are no write routes; `ProjectActivityService.record` is the only writer.
 *
 * The queries are typed with interfaces so the global ValidationPipe passes them through
 * and `ActivityQueryPipe` alone validates them, with its one message.
 */
@Controller('projects/:projectId/activity')
@UseGuards(JwtAuthGuard)
export class ProjectActivityController {
  constructor(
    private readonly query: ProjectActivityQueryService,
    private readonly volume: VolumeWatchService,
  ) {}

  /** Staff in view-as may read it, like any other page. */
  @RequireProjectPermission('activity.view')
  @Get()
  list(
    @ProjectAccessContext() access: ProjectAccess,
    @Query(new ActivityQueryPipe(ActivityQueryDto)) q: ActivityQuery,
  ): Promise<ProjectActivityPage> {
    return this.query.list(access, q);
  }

  /**
   * Refused in view-as, as the person export is: taking the file away is not "viewing".
   * Sent through `res` directly, so TransformInterceptor's `{ data }` envelope never
   * wraps a file.
   */
  @RequireProjectPermission('activity.view')
  @Get('export')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async export(
    @ProjectAccessContext() access: ProjectAccess,
    @Query(new ActivityQueryPipe(ActivityFilterDto)) q: ActivityFilters,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    refuseViewAs(user);
    const csv = await this.query.exportCsv(access, q, { kind: 'user', userId: user.userId }, activityContext(req));
    this.volume.exported(user.userId, access.project.id, countCsvRows(csv), 'activity export');
    const day = new Date().toISOString().slice(0, 10);
    res
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="activity-${access.project.id}-${day}.csv"`,
        'Cache-Control': 'no-store',
        'Access-Control-Expose-Headers': 'Content-Disposition',
      })
      // The byte-order mark is how Excel knows the file is UTF-8.
      .send(Buffer.from(`﻿${csv}`, 'utf8'));
  }
}

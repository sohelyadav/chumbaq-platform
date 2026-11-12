import { VolumeWatchService, countPersonExportRows } from '../security-alerts/volume-watch.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { PersonErasureResult, PersonExport, PrivacyRequestLog } from '@chumbaq/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RecentAuthGuard } from '../auth/guards/recent-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { PersonErasureService } from './person-erasure.service';
import { PersonExportService } from './person-export.service';
import { PrivacyRequestsService } from './privacy-requests.service';
import { PrivacyRequestSearchDto } from './dto/privacy-request.dto';
import { activityContext } from '../project-activity/activity-context';

import { IMPERSONATION_READ_ONLY, refuseViewAs } from '../project-access/view-as';

/** Moved to `project-access/view-as.ts`; re-exported so existing imports keep working. */
export { IMPERSONATION_READ_ONLY };

/**
 * Dashboard routes for one person's data. They need the `privacy` permission,
 * which only the owner role holds (`ProjectAccessGuard` checks it per route).
 *
 * Staff viewing as a tenant can do neither: JwtStrategy refuses the DELETE
 * like any write, and the export is refused here, since walking away with a
 * person's full data is not "viewing".
 */
@Controller('projects/:projectId')
@UseGuards(JwtAuthGuard)
export class PersonPrivacyController {
  constructor(
    private readonly erasure: PersonErasureService,
    private readonly exporter: PersonExportService,
    private readonly requests: PrivacyRequestsService,
    private readonly volume: VolumeWatchService,
  ) {}

  /** Irreversible, so it also needs a sign-in within 15 minutes (the dashboard prompts for it). */
  // Guard order [JwtAuthGuard, ProjectAccessGuard, RecentAuthGuard]: decorators apply bottom-up.
  @UseGuards(RecentAuthGuard)
  @RequireProjectPermission('privacy')
  @Delete('users/:personId')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async erase(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('personId', ParseUUIDPipe) personId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<PersonErasureResult> {
    refuseViewAs(user);
    return this.erasure.erase(
      projectId,
      { type: 'personId', value: personId },
      { type: 'user', id: user.userId },
      activityContext(req),
    );
  }

  @RequireProjectPermission('privacy')
  @Get('users/:personId/export')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async export(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('personId', ParseUUIDPipe) personId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<PersonExport> {
    refuseViewAs(user);
    // A download of a person's data, so logged although it is a GET.
    const exported = await this.exporter.export(
      projectId,
      { type: 'personId', value: personId },
      { type: 'user', id: user.userId },
      activityContext(req),
    );
    this.volume.exported(user.userId, projectId, countPersonExportRows(exported), 'person export');
    return exported;
  }

  /** The fiduciary's record, newest first. Hashes and counts only, so view-as may read it. */
  @RequireProjectPermission('privacy')
  @Get('privacy-requests')
  async list(
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<PrivacyRequestLog[]> {
    return this.requests.list(projectId);
  }

  /** "Was this user erased?" The user id travels in the body, never the URL. */
  @RequireProjectPermission('privacy')
  @Post('privacy-requests/search')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async search(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: PrivacyRequestSearchDto,
  ): Promise<PrivacyRequestLog[]> {
    return this.requests.list(projectId, { externalUserId: dto.externalUserId, limit: dto.limit });
  }
}

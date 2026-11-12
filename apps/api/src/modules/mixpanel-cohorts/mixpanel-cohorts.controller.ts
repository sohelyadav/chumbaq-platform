import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { MixpanelCohortsService } from './mixpanel-cohorts.service';
import { MixpanelCohortSyncService } from './mixpanel-cohort-sync.service';
import { MixpanelCampaignService } from './mixpanel-campaign.service';
import { ConfigureMixpanelDto } from './dto/configure-mixpanel.dto';
import { ImportCohortDto } from './dto/import-cohort.dto';
import { PushCohortDto } from './dto/push-cohort.dto';
import { IamCohortTriggerDto } from './dto/iam-cohort-trigger.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { redactSecrets } from '../project-access/redact-secrets';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { activityContext } from '../project-activity/activity-context';
import { requesterOf } from '../project-activity/messaging-activity';

@Controller('projects/:projectId/mixpanel')
@UseGuards(JwtAuthGuard)
export class MixpanelCohortsController {
  constructor(
    private readonly mixpanelCohortsService: MixpanelCohortsService,
    private readonly syncService: MixpanelCohortSyncService,
    private readonly campaignService: MixpanelCampaignService,
  ) {}

  // POST /projects/:projectId/mixpanel/configure
  @Post('configure')
  @RequireProjectPermission('channels.manage')
  async configure(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ConfigureMixpanelDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.mixpanelCohortsService.configure(projectId, dto, userId, activityContext(req));
  }

  // GET /projects/:projectId/mixpanel/status
  @Get('status')
  @RequireProjectPermission('project.read')
  async getStatus(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @ProjectAccessContext() access: ProjectAccess,
  ) {
    // The username half of the service account the project syncs with.
    return redactSecrets(await this.mixpanelCohortsService.getStatus(projectId), access, [
      'serviceAccountUsername',
    ]);
  }

  // GET /projects/:projectId/mixpanel/available-cohorts
  // project.read: members import cohorts, which needs this list to pick from.
  @Get('available-cohorts')
  @RequireProjectPermission('project.read')
  async listAvailableCohorts(
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.mixpanelCohortsService.listAvailableCohorts(projectId);
  }

  // POST /projects/:projectId/mixpanel/cohorts/import
  @Post('cohorts/import')
  @RequireProjectPermission('messaging.write')
  async importCohort(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ImportCohortDto,
  ) {
    // Kicks off async sync and returns cohort entity immediately
    return this.syncService.importCohort(projectId, dto.mixpanelCohortId);
  }

  // GET /projects/:projectId/mixpanel/cohorts
  @Get('cohorts')
  @RequireProjectPermission('project.read')
  async listCohorts(
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.mixpanelCohortsService.listImportedCohorts(projectId);
  }

  // GET /projects/:projectId/mixpanel/cohorts/:cohortId
  @Get('cohorts/:cohortId')
  @RequireProjectPermission('project.read')
  async getCohort(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
  ) {
    return this.mixpanelCohortsService.findImportedCohort(projectId, cohortId);
  }

  // POST /projects/:projectId/mixpanel/cohorts/:cohortId/sync
  @Post('cohorts/:cohortId/sync')
  @RequireProjectPermission('messaging.write')
  async syncCohort(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
  ) {
    const cohort = await this.mixpanelCohortsService.findImportedCohort(projectId, cohortId);
    return this.syncService.importCohort(projectId, cohort.mixpanelCohortId);
  }

  // GET /projects/:projectId/mixpanel/cohorts/:cohortId/members
  @Get('cohorts/:cohortId/members')
  @RequireProjectPermission('project.read')
  async listMembers(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('resolved') resolved?: string,
  ) {
    const resolvedFilter =
      resolved === 'true' ? true : resolved === 'false' ? false : undefined;
    return this.mixpanelCohortsService.listCohortMembers(projectId, cohortId, {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      resolved: resolvedFilter,
    });
  }

  // GET /projects/:projectId/mixpanel/cohorts/:cohortId/push-stats
  @Get('cohorts/:cohortId/push-stats')
  @RequireProjectPermission('project.read')
  async getPushStats(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
  ) {
    return this.campaignService.getPushStats(projectId, cohortId);
  }

  // POST /projects/:projectId/mixpanel/cohorts/:cohortId/push
  @Post('cohorts/:cohortId/push')
  @RequireProjectPermission('messaging.write')
  async sendPush(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Body() dto: PushCohortDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.campaignService.sendPushToCohort(projectId, cohortId, dto, requesterOf(userId, req));
  }

  // GET /projects/:projectId/mixpanel/cohorts/:cohortId/iam-stats
  @Get('cohorts/:cohortId/iam-stats')
  @RequireProjectPermission('project.read')
  async getIamStats(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
  ) {
    return this.campaignService.getIamStats(projectId, cohortId);
  }

  // POST /projects/:projectId/mixpanel/cohorts/:cohortId/iam-trigger
  @Post('cohorts/:cohortId/iam-trigger')
  @RequireProjectPermission('messaging.write')
  async triggerIamForCohort(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Body() dto: IamCohortTriggerDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.campaignService.sendIamToCohort(projectId, cohortId, dto.messageId, requesterOf(userId, req));
  }

  // DELETE /projects/:projectId/mixpanel/cohorts/:cohortId
  @Delete('cohorts/:cohortId')
  @RequireProjectPermission('messaging.write')
  async deleteCohort(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.mixpanelCohortsService.deleteImportedCohort(projectId, cohortId, requesterOf(userId, req));
    return { message: 'Cohort deleted successfully' };
  }
}

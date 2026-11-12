import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { activityContext } from '../project-activity/activity-context';
import { requesterOf } from '../project-activity/messaging-activity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { redactSecrets } from '../project-access/redact-secrets';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { EmailSettingsService } from './email-settings.service';
import { EmailCampaignsService } from './email-campaigns.service';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import {
  AddSuppressionDto,
  ConnectEmailProviderDto,
  EmailAudiencePreviewDto,
  SendEmailCampaignDto,
  TestSendEmailDto,
  UpdateEmailSettingsDto,
} from './dto/email.dto';

/**
 * Dashboard endpoints for the email channel.
 *
 * Campaigns are read back through the push campaign endpoints — they are the
 * same rows — so this controller only covers what is email-specific: setup,
 * creating a campaign, and the suppression list.
 */
@Controller('email')
@UseGuards(JwtAuthGuard)
export class EmailController {
  constructor(
    private readonly settings: EmailSettingsService,
    private readonly campaigns: EmailCampaignsService,
    private readonly suppressions: SuppressionsService,
  ) {}

  @Get('settings/:projectId')
  @RequireProjectPermission('project.read')
  async getSettings(
    @Param('projectId') projectId: string,
    @ProjectAccessContext() access: ProjectAccess,
  ) {
    // The URLs carry the webhook token, which is what lets a caller post delivery events.
    return redactSecrets(await this.settings.status(projectId), access, ['webhookUrls']);
  }

  @Post('settings')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async updateSettings(
    @Body() dto: UpdateEmailSettingsDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.settings.update(dto, userId, activityContext(req));
  }

  @Post('providers')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async connectProvider(
    @Body() dto: ConnectEmailProviderDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.settings.connect(dto, userId, activityContext(req));
  }

  @Post('settings/:projectId/reset-ses-topic')
  @RequireProjectPermission('channels.manage')
  async resetSesTopic(
    @Param('projectId') projectId: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.settings.resetSesTopic(projectId, userId, activityContext(req));
    return this.settings.status(projectId);
  }

  /**
   * A new secret for the provider webhook URLs. Anyone holding the old URL
   * could post to it; this is how a tenant ends that. Impersonation tokens
   * are read-only, so view-as cannot reach it, and members cannot either.
   */
  @Post('settings/:projectId/rotate-webhook-token')
  @RequireProjectPermission('channels.manage')
  async rotateWebhookToken(
    @Param('projectId') projectId: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.settings.rotateWebhookToken(projectId, userId, activityContext(req));
  }

  @Post('audience-preview')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async previewAudience(
    @Body() dto: EmailAudiencePreviewDto,
  ) {
    return this.campaigns.previewAudience(dto);
  }

  @Post('send')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async send(
    @Body() dto: SendEmailCampaignDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.campaigns.send(dto, requesterOf(userId, req));
  }

  @Post('test-send')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async testSend(@Body() dto: TestSendEmailDto) {
    return this.campaigns.testSend(dto);
  }

  @Get('suppressions/:projectId')
  @RequireProjectPermission('project.read')
  async listSuppressions(
    @Param('projectId') projectId: string,
    @Query() pagination: PaginationDto,
  ) {
    const [data, total] = await this.suppressions.list(
      projectId,
      'email',
      pagination.limit,
      pagination.skip,
    );
    return { data, total };
  }

  @Post('suppressions')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async addSuppression(
    @Body() dto: AddSuppressionDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.suppressions.suppress(
      dto.projectId,
      'email',
      [{ address: dto.address, reason: dto.reason ?? 'manual' }],
      'dashboard',
      { requester: requesterOf(userId, req) },
    );
    return { suppressed: true };
  }

  @Delete('suppressions/:projectId/:address')
  @RequireProjectPermission('messaging.write')
  async removeSuppression(
    @Param('projectId') projectId: string,
    @Param('address') address: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    const removed = await this.suppressions.remove(projectId, 'email', address, { requester: requesterOf(userId, req) });
    if (!removed) throw new NotFoundException('That address is not suppressed.');
    return { removed: true };
  }
}

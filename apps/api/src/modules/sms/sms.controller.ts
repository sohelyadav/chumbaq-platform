import {
  BadRequestException,
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
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { normalisePhone } from '../push-notifications/message-channel';
import { SmsSettingsService } from './sms-settings.service';
import { SmsCampaignsService } from './sms-campaigns.service';
import {
  AddSmsSuppressionDto,
  ConnectSmsProviderDto,
  SendSmsCampaignDto,
  SmsAudiencePreviewDto,
  TestSendSmsDto,
  UpdateSmsSettingsDto,
} from './dto/sms.dto';

/**
 * Dashboard endpoints for the SMS channel. Campaigns are read back through
 * the push campaign endpoints — they are the same rows.
 */
@Controller('sms')
@UseGuards(JwtAuthGuard)
export class SmsController {
  constructor(
    private readonly settings: SmsSettingsService,
    private readonly campaigns: SmsCampaignsService,
    private readonly suppressions: SuppressionsService,
  ) {}

  @Get('settings/:projectId')
  @RequireProjectPermission('project.read')
  async getSettings(
    @Param('projectId') projectId: string,
    @ProjectAccessContext() access: ProjectAccess,
  ) {
    const status = await this.settings.status(projectId);
    // The inbound URL carries the webhook token. The account SID is the username half
    // of Twilio's credentials, hidden as Mixpanel's service account username is.
    return redactSecrets(
      {
        ...status,
        providers: status.providers.map((provider) => redactSecrets(provider, access, ['accountSid'])),
      },
      access,
      ['inboundWebhookUrl'],
    );
  }

  @Post('settings')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async updateSettings(
    @Body() dto: UpdateSmsSettingsDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.settings.update(dto, userId, activityContext(req));
  }

  @Post('providers')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async connectProvider(
    @Body() dto: ConnectSmsProviderDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.settings.connect(dto, userId, activityContext(req));
  }

  @Post('audience-preview')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async previewAudience(@Body() dto: SmsAudiencePreviewDto) {
    return this.campaigns.previewAudience(dto);
  }

  @Post('send')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async send(
    @Body() dto: SendSmsCampaignDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.campaigns.send(dto, requesterOf(userId, req));
  }

  @Post('test-send')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async testSend(@Body() dto: TestSendSmsDto) {
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
      'sms',
      pagination.limit,
      pagination.skip,
    );
    return { data, total };
  }

  @Post('suppressions')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async addSuppression(
    @Body() dto: AddSmsSuppressionDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    if (!normalisePhone(dto.address)) {
      throw new BadRequestException('Enter the number in international form, with its country code.');
    }
    await this.suppressions.suppress(
      dto.projectId,
      'sms',
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
    const removed = await this.suppressions.remove(projectId, 'sms', address, { requester: requesterOf(userId, req) });
    if (!removed) throw new NotFoundException('That number is not suppressed.');
    return { removed: true };
  }
}

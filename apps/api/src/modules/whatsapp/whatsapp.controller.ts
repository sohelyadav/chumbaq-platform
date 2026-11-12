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
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppCampaignsService } from './whatsapp-campaigns.service';
import {
  AddWhatsAppSuppressionDto,
  ConnectWhatsAppProviderDto,
  SendWhatsAppCampaignDto,
  TestSendWhatsAppDto,
  UpdateWhatsAppSettingsDto,
  WhatsAppAudiencePreviewDto,
} from './dto/whatsapp.dto';

/** Dashboard endpoints for WhatsApp. Campaigns are read back through the push campaign endpoints. */
@Controller('whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsAppController {
  constructor(
    private readonly settings: WhatsAppSettingsService,
    private readonly campaigns: WhatsAppCampaignsService,
    private readonly suppressions: SuppressionsService,
  ) {}

  @Get('settings/:projectId')
  @RequireProjectPermission('project.read')
  async getSettings(
    @Param('projectId') projectId: string,
    @ProjectAccessContext() access: ProjectAccess,
  ) {
    const status = await this.settings.status(projectId);
    // The URLs and the verify token are the webhook token. A Twilio connection's
    // account SID is the username half of its credentials, hidden as Mixpanel's
    // service account username is; the other identifiers name a number or an app.
    return redactSecrets(
      {
        ...status,
        providers: status.providers.map((provider) => ({
          ...provider,
          identifiers: redactSecrets(provider.identifiers, access, ['accountSid']),
        })),
      },
      access,
      ['webhookUrls', 'verifyToken'],
    );
  }

  @Post('settings')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async updateSettings(
    @Body() dto: UpdateWhatsAppSettingsDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.settings.update(dto, userId, activityContext(req));
  }

  @Post('providers')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async connectProvider(
    @Body() dto: ConnectWhatsAppProviderDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.settings.connect(dto, userId, activityContext(req));
  }

  @Get('templates/:projectId')
  @RequireProjectPermission('project.read')
  async templates(
    @Param('projectId') projectId: string,
    @Query('fresh') fresh: string | undefined,
  ) {
    return this.campaigns.templates(projectId, { fresh: fresh === 'true' });
  }

  @Post('audience-preview')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async previewAudience(@Body() dto: WhatsAppAudiencePreviewDto) {
    return this.campaigns.previewAudience(dto);
  }

  @Post('send')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async send(
    @Body() dto: SendWhatsAppCampaignDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.campaigns.send(dto, requesterOf(userId, req));
  }

  @Post('test-send')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async testSend(@Body() dto: TestSendWhatsAppDto) {
    return this.campaigns.testSend(dto);
  }

  @Get('suppressions/:projectId')
  @RequireProjectPermission('project.read')
  async listSuppressions(
    @Param('projectId') projectId: string,
    @Query() pagination: PaginationDto,
  ) {
    const [data, total] = await this.suppressions.list(projectId, 'whatsapp', pagination.limit, pagination.skip);
    return { data, total };
  }

  @Post('suppressions')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async addSuppression(
    @Body() dto: AddWhatsAppSuppressionDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    if (!normalisePhone(dto.address)) {
      throw new BadRequestException('Enter the number in international form, with its country code.');
    }
    await this.suppressions.suppress(
      dto.projectId,
      'whatsapp',
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
    const removed = await this.suppressions.remove(projectId, 'whatsapp', address, { requester: requesterOf(userId, req) });
    if (!removed) throw new NotFoundException('That number is not suppressed.');
    return { removed: true };
  }
}

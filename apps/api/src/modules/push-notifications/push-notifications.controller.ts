import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  BadRequestException,
  NotFoundException,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PushNotificationsService } from './push-notifications.service';
import {
  ConfigurePushDto,
  SendPushNotificationDto,
  SendToUserDto,
  TestSendPushDto,
  PreviewAudienceDto,
  UpdatePushSettingsDto,
  ConfigureChannelDto,
} from './dto/push-notification.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PushAnalyticsService } from './push-analytics.service';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { redactSecrets } from '../project-access/redact-secrets';
import { IdentityService } from '../identity/identity.service';
import { PushTokensService } from '../push-tokens/push-tokens.service';
import { ChannelProviderRegistry } from './services/channel-provider.registry';
import { ChannelCredentialsService } from './channel-credentials.service';
import { MESSAGE_CHANNELS, MessageChannel } from './message-channel';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { activityContext } from '../project-activity/activity-context';
import { requesterOf } from '../project-activity/messaging-activity';

@Controller('push-notifications')
@UseGuards(JwtAuthGuard)
export class PushNotificationsController {
  constructor(
    private readonly pushNotificationsService: PushNotificationsService,
    private readonly pushAnalyticsService: PushAnalyticsService,
    private readonly pushTokensService: PushTokensService,
    private readonly channelRegistry: ChannelProviderRegistry,
    private readonly channelCredentials: ChannelCredentialsService,
    private readonly identityService: IdentityService,
  ) {}

  @Get('experiment/:projectId/:campaignId')
  @RequireProjectPermission('project.read')
  async getExperimentReport(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.pushAnalyticsService.getExperimentReport(projectId, campaignId);
  }

  @Get('report/:projectId/:campaignId')
  @RequireProjectPermission('project.read')
  async getCampaignReport(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.pushAnalyticsService.getCampaignReport(projectId, campaignId);
  }

  @Post('configure')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async configure(
    @Body() dto: ConfigurePushDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.pushNotificationsService.configure(dto, userId, activityContext(req));
  }

  @Post('audience-preview')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async previewAudience(
    @Body() dto: PreviewAudienceDto,
  ) {
    return this.pushNotificationsService.previewAudience(dto);
  }

  @Post('test-send')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async testSend(
    @Body() dto: TestSendPushDto,
  ) {
    return this.pushNotificationsService.testSend(dto);
  }

  @Post('settings')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async updateSettings(
    @Body() dto: UpdatePushSettingsDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.pushNotificationsService.updateSettings(dto, userId, activityContext(req));
  }

  /**
   * Devices the project has stopped being able to reach.
   *
   * Named for what the data is rather than for uninstalls: a provider returns
   * UNREGISTERED for an uninstall, cleared app storage and a rotated token
   * alike. `likelyUninstalls` is the narrower, defensible figure.
   */
  @Get('reachability/:projectId')
  @RequireProjectPermission('project.read')
  async getReachabilityLosses(
    @Param('projectId') projectId: string,
    @Query('days') days?: string,
  ) {
    const parsed = Number(days);
    // Clamped rather than trusted: the window goes straight into a scan of
    // the token table, and an unbounded one is a free full-table read.
    const sinceDays =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 365) : 30;
    return this.pushTokensService.getReachabilityLosses(projectId, sinceDays);
  }

  /**
   * Stores credentials for one delivery channel.
   *
   * Generic, so adding a vendor needs no new endpoint. `configure` stays as the
   * FCM-specific path the dashboard has always used; this is what every other
   * channel goes through.
   */
  @Post('channels/credentials')
  @RequireProjectPermission('channels.manage', { body: 'projectId' })
  async configureChannel(
    @Body() dto: ConfigureChannelDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    // Refused when nothing can deliver on it, rather than stored and inert:
    // credentials that will never be used look identical to credentials that
    // are simply not working.
    if (!this.channelRegistry.supports(dto.provider)) {
      throw new BadRequestException(
        `This deployment cannot deliver on the "${dto.provider}" channel. ` +
          `Supported: ${this.channelRegistry.supported().join(', ')}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(dto.credentials);
    } catch {
      throw new BadRequestException('Credentials must be valid JSON.');
    }

    // Checked at paste time by the provider that owns the format. A bad key
    // found later means a campaign that reached nobody.
    await this.channelRegistry.get(dto.provider).validateCredentials(parsed);

    await this.pushNotificationsService.storeChannelCredentials(
      dto.projectId,
      dto.provider,
      dto.credentials,
      userId,
      activityContext(req),
    );

    return { provider: dto.provider, configured: true };
  }

  /** Which channels this project can currently send on. */
  @Get('channels/:projectId')
  @RequireProjectPermission('project.read')
  async listChannels(
    @Param('projectId') projectId: string,
  ) {
    const configured = await this.channelCredentials.configuredPushProviders(projectId);
    return {
      configured,
      supported: this.channelRegistry.supported(),
    };
  }

  /**
   * Every campaign that reached one person.
   *
   * Scoped by resolving the person to their device identities first, because a
   * person is not a device: someone on a phone and a tablet is two identity
   * rows sharing a distinct id, and a campaign delivered to either reached
   * them.
   */
  @Get('history/:projectId/:personId')
  @RequireProjectPermission('people.read')
  async getPersonHistory(
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
  ) {
    const [identity] = await this.identityService.findByIds([personId]);
    // Checked against the project as well as existing: an id from another
    // tenant must not read back that tenant's push history.
    if (!identity || identity.projectId !== projectId) {
      throw new NotFoundException('Person not found for this project');
    }

    const distinctId = identity.distinctId || identity.deviceFingerprint;
    const siblings = distinctId
      ? await this.identityService.findByDistinctId(distinctId, projectId)
      : [];
    // Falls back to the one identity when nothing links it to others, so an
    // anonymous device still has a history.
    const deviceIdentityIds = siblings.length > 0
      ? siblings.map((row) => row.id)
      : [identity.id];

    return {
      deviceCount: deviceIdentityIds.length,
      campaigns: await this.pushAnalyticsService.getPersonCampaignHistory(
        projectId,
        deviceIdentityIds,
      ),
    };
  }

  /**
   * `clientEmail` names the FCM service account, the identity half of the key the
   * project sends with, so like Mixpanel's service account username it is shown only to
   * those who manage channels (and never to view-as).
   */
  @Get('config-status/:projectId')
  @RequireProjectPermission('project.read')
  async getConfigStatus(
    @Param('projectId') projectId: string,
    @ProjectAccessContext() access: ProjectAccess,
  ) {
    return redactSecrets(await this.pushNotificationsService.getConfigStatus(projectId), access, [
      'clientEmail',
    ]);
  }

  @Post('send')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async send(
    @Body() dto: SendPushNotificationDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.pushNotificationsService.send(dto, requesterOf(userId, req));
  }

  @Post('send-to-user')
  @RequireProjectPermission('messaging.write', { body: 'projectId' })
  async sendToUser(
    @Body() dto: SendToUserDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.pushNotificationsService.sendToUser(dto, requesterOf(userId, req));
  }

  @Post('cancel/:projectId/:campaignId')
  @RequireProjectPermission('messaging.write')
  async cancelScheduled(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.pushNotificationsService.cancelScheduled(projectId, campaignId, requesterOf(userId, req));
  }

  @Get('campaign/:projectId/:campaignId')
  @RequireProjectPermission('project.read')
  async getCampaign(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.pushNotificationsService.getCampaign(projectId, campaignId);
  }

  @Get('logs/:projectId')
  @RequireProjectPermission('project.read')
  async getLogs(
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('channel') channel?: string,
  ) {
    if (channel !== undefined && !(MESSAGE_CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException(`channel must be one of: ${MESSAGE_CHANNELS.join(', ')}`);
    }
    return this.pushNotificationsService.getLogs(
      projectId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
      channel as MessageChannel | undefined,
    );
  }
}

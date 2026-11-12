import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { WebhooksService, toWebhookView } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { redactSecrets } from '../project-access/redact-secrets';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { activityContext } from '../project-activity/activity-context';

/**
 * The receiver URL is often the credential itself: a Slack incoming webhook
 * (/services/T../B../XXXX), a Zapier catch hook, a Pipedream subdomain. Anyone
 * holding it can post as the tenant's integration, so members (who cannot manage
 * channels) and view-as sessions get none of it, host included. Signing secrets
 * are never in a read at all.
 */
const hideUrlFrom = <T extends { url: string }>(view: T, access: ProjectAccess) =>
  redactSecrets(view, access, ['url']);

@Controller('projects/:projectId/webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  /** The only responses carrying the secret are this one and rotate-secret's. */
  @Post()
  @RequireProjectPermission('channels.manage')
  async create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateWebhookDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.webhooksService.create(projectId, dto, userId, activityContext(req));
  }

  @Get()
  @RequireProjectPermission('project.read')
  async findAll(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @ProjectAccessContext() access: ProjectAccess,
  ) {
    const webhooks = await this.webhooksService.findAllByProject(projectId);
    return webhooks.map((webhook) => hideUrlFrom(toWebhookView(webhook), access));
  }

  @Get(':id')
  @RequireProjectPermission('project.read')
  async findOne(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @ProjectAccessContext() access: ProjectAccess,
  ) {
    return hideUrlFrom(toWebhookView(await this.webhooksService.findOne(id, projectId)), access);
  }

  @Patch(':id')
  @RequireProjectPermission('channels.manage')
  async update(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return toWebhookView(await this.webhooksService.update(id, projectId, dto, userId, activityContext(req)));
  }

  /**
   * Issues a new secret and returns it, once. No recent-auth step, matching
   * the other credential endpoints (channel credentials, API keys); an
   * impersonation token is refused by JwtStrategy, which allows it reads only.
   */
  @Post(':id/rotate-secret')
  @RequireProjectPermission('channels.manage')
  async rotateSecret(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.webhooksService.rotateSecret(id, projectId, userId, activityContext(req));
  }

  @Delete(':id')
  @RequireProjectPermission('channels.manage')
  async remove(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.webhooksService.remove(id, projectId, userId, activityContext(req));
    return { message: 'Webhook deleted successfully' };
  }
}

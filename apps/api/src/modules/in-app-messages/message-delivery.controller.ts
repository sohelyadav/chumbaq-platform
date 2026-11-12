import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  Param,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { MessageDeliveryService } from './message-delivery.service';
import { ServeMessageRequestDto } from './dto/serve-message-request.dto';
import { MessageActionDto } from './dto/message-action.dto';
import { TriggerMessageDto } from './dto/trigger-message.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ApiKeyGuard } from '../api-keys/guards/api-key.guard';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { requesterOf } from '../project-activity/messaging-activity';

function assertProjectScope(req: Request, dtoProjectId: string): void {
  const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
  if (!apiKeyProjectId || dtoProjectId !== apiKeyProjectId) {
    throw new ForbiddenException('Project mismatch');
  }
}

@Controller()
export class MessageDeliveryController {
  constructor(
    private readonly deliveryService: MessageDeliveryService,
  ) {}

  /**
   * SDK endpoint — checks what messages should be shown.
   * Requires a valid project API key (X-API-Key header) that matches dto.projectId.
   */
  @Post('messages/check')
  @UseGuards(ApiKeyGuard)
  async checkMessages(@Body() dto: ServeMessageRequestDto, @Req() req: Request) {
    assertProjectScope(req, dto.projectId);
    return this.deliveryService.checkMessages(dto);
  }

  /**
   * SDK endpoint — reports a message event (impression, click, dismiss, etc.)
   * Requires a valid project API key that matches dto.projectId.
   */
  @Post('messages/event')
  @UseGuards(ApiKeyGuard)
  async recordEvent(
    @Body() dto: MessageActionDto,
    @Req() req: Request,
  ) {
    assertProjectScope(req, dto.projectId);
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    await this.deliveryService.recordEvent(dto, { ipAddress, userAgent });
    return { recorded: true };
  }

  /**
   * Dashboard endpoint — trigger a message for specific users (push-like).
   * Requires JWT auth.
   */
  @Post('projects/:projectId/in-app-messages/trigger')
  @RequireProjectPermission('messaging.write')
  @UseGuards(JwtAuthGuard)
  async triggerMessage(
    @Param('projectId') projectId: string,
    @Body() dto: TriggerMessageDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.deliveryService.triggerMessage(projectId, dto, requesterOf(userId, req));
  }
}

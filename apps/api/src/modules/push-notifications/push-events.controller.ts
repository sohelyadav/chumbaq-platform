import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiKeyGuard } from '../api-keys/guards/api-key.guard';
import { PushAnalyticsService } from './push-analytics.service';
import { RecordPushEventDto } from './dto/push-notification.dto';

/**
 * Engagement reported by a device SDK.
 *
 * Deliberately a separate controller from PushNotificationsController, which
 * carries a class-level JwtAuthGuard. Nest composes class and method guards
 * rather than letting the method override, so an API-key route added there
 * would also demand a JWT — which an app on a handset does not have.
 */
@Controller('push-notifications')
export class PushEventsController {
  constructor(private readonly pushAnalyticsService: PushAnalyticsService) {}

  @Post('events')
  @UseGuards(ApiKeyGuard)
  async recordEvent(@Body() dto: RecordPushEventDto, @Req() req: Request) {
    const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
    if (!apiKeyProjectId || dto.projectId !== apiKeyProjectId) {
      throw new ForbiddenException('Project mismatch');
    }
    return this.pushAnalyticsService.recordEvent(dto);
  }
}

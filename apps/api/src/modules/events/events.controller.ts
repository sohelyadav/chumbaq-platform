import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { EventsService } from './events.service';
import { TrackEventDto } from './dto/track-event.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ApiKeyGuard } from '../api-keys/guards/api-key.guard';

@Controller()
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post('events/track')
  @UseGuards(ApiKeyGuard)
  async track(@Body() dto: TrackEventDto, @Req() req: Request) {
    const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
    if (!apiKeyProjectId || dto.projectId !== apiKeyProjectId) {
      throw new ForbiddenException('Project mismatch');
    }
    // `{ recorded: false }` when the person is do-not-track: still a 2xx.
    return (await this.eventsService.track(dto)) ?? { recorded: false };
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/events')
  @UseGuards(JwtAuthGuard)
  async queryByProject(
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('eventName') eventName?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.eventsService.queryByProject(projectId, {
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      eventName,
      start,
      end,
    });
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/events/names')
  @UseGuards(JwtAuthGuard)
  async getEventNames(
    @Param('projectId') projectId: string,
  ) {
    return this.eventsService.getEventNames(projectId);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/events/volume')
  @UseGuards(JwtAuthGuard)
  async getEventVolume(
    @Param('projectId') projectId: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('granularity') granularity?: 'hour' | 'day' | 'week',
    @Query('eventName') eventName?: string,
  ) {
    return this.eventsService.getEventVolume(projectId, {
      start,
      end,
      granularity,
      eventName,
    });
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/events/breakdown')
  @UseGuards(JwtAuthGuard)
  async getEventBreakdown(
    @Param('projectId') projectId: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.eventsService.getEventBreakdown(projectId, { start, end });
  }
}

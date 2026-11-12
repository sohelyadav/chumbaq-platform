import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MessageAnalyticsService } from './message-analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

@Controller('projects/:projectId/in-app-messages')
@UseGuards(JwtAuthGuard)
export class MessageAnalyticsController {
  constructor(
    private readonly analyticsService: MessageAnalyticsService,
  ) {}

  @Get(':id/analytics')
  @RequireProjectPermission('project.read')
  async getSummary(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.analyticsService.getSummary(id, projectId);
  }

  @Get(':id/analytics/funnel')
  @RequireProjectPermission('project.read')
  async getFunnel(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.analyticsService.getFunnel(id, projectId);
  }

  @Get(':id/analytics/buttons')
  @RequireProjectPermission('project.read')
  async getButtonBreakdown(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.analyticsService.getButtonBreakdown(id, projectId);
  }

  @Get(':id/analytics/timeseries')
  @RequireProjectPermission('project.read')
  async getTimeseries(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('granularity') granularity?: 'hour' | 'day' | 'week',
  ) {
    return this.analyticsService.getTimeseries(id, projectId, { start, end, granularity });
  }

  @Get(':id/analytics/platforms')
  @RequireProjectPermission('project.read')
  async getPlatformBreakdown(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.analyticsService.getPlatformBreakdown(id, projectId);
  }
}

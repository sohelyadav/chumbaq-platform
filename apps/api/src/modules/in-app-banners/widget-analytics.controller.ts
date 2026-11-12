import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ForbiddenException,
} from '@nestjs/common';
import { WidgetAnalyticsService } from './widget-analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class WidgetAnalyticsController {
  constructor(
    private readonly analyticsService: WidgetAnalyticsService,
  ) {}

  @Get('banner-categories/:id/analytics')
  @RequireProjectPermission('project.read', { resource: 'bannerCategory', param: 'id' })
  async getSummary(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.analyticsService.getSummary(id);
  }

  @Get('banner-categories/:id/analytics/timeseries')
  @RequireProjectPermission('project.read', { resource: 'bannerCategory', param: 'id' })
  async getTimeseries(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('granularity') granularity?: 'hour' | 'day' | 'week',
  ) {

    const now = new Date();
    const startDate = start ? new Date(start) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : now;
    const gran = granularity || 'day';

    return this.analyticsService.getTimeseries(id, startDate, endDate, gran);
  }

  @Get('banner-categories/:id/analytics/devices')
  @RequireProjectPermission('project.read', { resource: 'bannerCategory', param: 'id' })
  async getDeviceBreakdown(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.analyticsService.getDeviceBreakdown(id);
  }

  @Get('banner-categories/:id/analytics/geo')
  @RequireProjectPermission('project.read', { resource: 'bannerCategory', param: 'id' })
  async getGeoBreakdown(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.analyticsService.getGeoBreakdown(id);
  }

  @Get('banner-categories/:id/analytics/items')
  @RequireProjectPermission('project.read', { resource: 'bannerCategory', param: 'id' })
  async getItemStats(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.analyticsService.getItemStats(id);
  }
}

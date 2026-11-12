import { VolumeWatchService, countCsvRows } from '../security-alerts/volume-watch.service';
import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly volume: VolumeWatchService,
  ) {}

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id/analytics')
  async getSummary(
    @Param('id') id: string,
  ) {
    return this.analyticsService.getSummary(id);
  }

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id/analytics/timeseries')
  async getTimeseries(
    @Param('id') id: string,
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

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id/analytics/devices')
  async getDeviceBreakdown(
    @Param('id') id: string,
  ) {
    return this.analyticsService.getDeviceBreakdown(id);
  }

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id/analytics/geo')
  async getGeoBreakdown(
    @Param('id') id: string,
  ) {
    return this.analyticsService.getGeoBreakdown(id);
  }

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id/analytics/referrers')
  async getReferrers(
    @Param('id') id: string,
  ) {
    return this.analyticsService.getReferrers(id);
  }

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id/analytics/export')
  async exportCsv(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const startDate = start ? new Date(start) : undefined;
    const endDate = end ? new Date(end) : undefined;
    const csv = await this.analyticsService.exportClicksAsCsv(id, startDate, endDate);
    this.volume.exported(user.userId, null, countCsvRows(csv), 'link clicks export');

    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="analytics-${id}.csv"`,
    });
    res.send(csv);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/analytics/summary')
  async getProjectAnalyticsSummary(
    @Param('projectId') projectId: string,
  ) {
    return this.analyticsService.getProjectAnalyticsSummary(projectId);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/analytics/timeseries')
  async getProjectTimeseries(
    @Param('projectId') projectId: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('granularity') granularity?: 'hour' | 'day' | 'week',
  ) {
    const now = new Date();
    const startDate = start ? new Date(start) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : now;
    const gran = granularity || 'day';

    return this.analyticsService.getProjectTimeseries(projectId, startDate, endDate, gran);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/analytics/devices')
  async getProjectDeviceBreakdown(
    @Param('projectId') projectId: string,
  ) {
    return this.analyticsService.getProjectDeviceBreakdown(projectId);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/analytics/geo')
  async getProjectGeoBreakdown(
    @Param('projectId') projectId: string,
  ) {
    return this.analyticsService.getProjectGeoBreakdown(projectId);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/analytics/referrers')
  async getProjectReferrers(
    @Param('projectId') projectId: string,
  ) {
    return this.analyticsService.getProjectReferrers(projectId);
  }

  @Get('dashboard/stats')
  async getDashboardStats(@CurrentUser() user: AuthenticatedUser) {
    return this.analyticsService.getDashboardStats(user);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/stats')
  async getProjectDashboardStats(
    @Param('projectId') projectId: string,
  ) {
    return this.analyticsService.getProjectDashboardStats(projectId);
  }
}

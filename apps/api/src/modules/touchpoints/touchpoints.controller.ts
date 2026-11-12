import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { TouchpointsService } from './touchpoints.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class TouchpointsController {
  constructor(
    private readonly touchpointsService: TouchpointsService,
  ) {}

  @RequireProjectPermission('people.read')
  @Get('projects/:projectId/touchpoints/journey/:distinctId')
  async getJourney(
    @Param('projectId') projectId: string,
    @Param('distinctId') distinctId: string,
    @Query('lookbackDays') lookbackDays?: string,
  ) {
    const days = lookbackDays ? parseInt(lookbackDays, 10) : 30;
    return this.touchpointsService.getJourney(projectId, distinctId, days);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/touchpoints/channels')
  async getChannelSummary(
    @Param('projectId') projectId: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const startDate = start ? new Date(start) : undefined;
    const endDate = end ? new Date(end) : undefined;
    return this.touchpointsService.getChannelSummary(projectId, startDate, endDate);
  }
}

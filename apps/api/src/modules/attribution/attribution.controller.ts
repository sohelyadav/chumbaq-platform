import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { AttributionService } from './attribution.service';
import { AttributionModel } from './entities/attribution-result.entity';

@Controller()
@UseGuards(JwtAuthGuard)
export class AttributionController {
  constructor(
    private readonly attributionService: AttributionService,
  ) {}

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/attribution/channels')
  async getChannelAttribution(
    @Param('projectId') projectId: string,
    @Query('model') model?: AttributionModel,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.attributionService.getChannelAttribution(
      projectId,
      model || 'linear',
      start ? new Date(start) : undefined,
      end ? new Date(end) : undefined,
    );
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/attribution/campaigns')
  async getCampaignAttribution(
    @Param('projectId') projectId: string,
    @Query('model') model?: AttributionModel,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.attributionService.getCampaignAttribution(
      projectId,
      model || 'linear',
      start ? new Date(start) : undefined,
      end ? new Date(end) : undefined,
    );
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/attribution/compare')
  async getModelComparison(
    @Param('projectId') projectId: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.attributionService.getModelComparison(
      projectId,
      start ? new Date(start) : undefined,
      end ? new Date(end) : undefined,
    );
  }

  // Project-scoped like every project route: the conversion id alone once
  // returned another tenant's attribution to any signed-in account.
  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/conversions/:conversionId/attribution')
  async getConversionAttribution(
    @Param('projectId') projectId: string,
    @Param('conversionId') conversionId: string,
  ) {
    return this.attributionService.getConversionAttribution(projectId, conversionId);
  }
}

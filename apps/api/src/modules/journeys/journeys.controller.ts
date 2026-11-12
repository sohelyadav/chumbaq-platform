import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { requesterOf } from '../project-activity/messaging-activity';
import { JourneysService } from './journeys.service';
import {
  CreateJourneyDto,
  UpdateJourneyDto,
  SetJourneyStatusDto,
} from './dto/journey.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

@Controller('projects/:projectId/journeys')
@UseGuards(JwtAuthGuard)
export class JourneysController {
  constructor(
    private readonly journeysService: JourneysService,
  ) {}

  @Get()
  @RequireProjectPermission('project.read')
  async list(
    @Param('projectId') projectId: string,
  ) {
    return this.journeysService.findAll(projectId);
  }

  @Get(':id')
  @RequireProjectPermission('project.read')
  async get(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.journeysService.findOne(projectId, id);
  }

  @Get(':id/stats')
  @RequireProjectPermission('project.read')
  async stats(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.journeysService.getStats(projectId, id);
  }

  @Post()
  @RequireProjectPermission('messaging.write')
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateJourneyDto,
  ) {
    return this.journeysService.create(projectId, dto);
  }

  @Patch(':id')
  @RequireProjectPermission('messaging.write')
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateJourneyDto,
  ) {
    return this.journeysService.update(projectId, id, dto);
  }

  /**
   * Separate from the edit route on purpose: activating is not a field change,
   * it sets the enrolment watermark and starts sending people real messages.
   */
  @Post(':id/status')
  @RequireProjectPermission('messaging.write')
  async setStatus(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: SetJourneyStatusDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.journeysService.setStatus(projectId, id, dto.status, requesterOf(userId, req));
  }

  @Delete(':id')
  @RequireProjectPermission('messaging.write')
  async remove(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.journeysService.remove(projectId, id, requesterOf(userId, req));
    return { deleted: true };
  }
}

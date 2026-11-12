import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { SegmentsService } from './segments.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { requesterOf } from '../project-activity/messaging-activity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { CreateSegmentDto, UpdateSegmentDto, PreviewSegmentDto } from './dto/segment.dto';

@Controller('projects/:projectId/segments')
@UseGuards(JwtAuthGuard)
export class SegmentsController {
  constructor(
    private readonly segmentsService: SegmentsService,
  ) {}

  @Get()
  @RequireProjectPermission('project.read')
  async list(
    @Param('projectId') projectId: string,
  ) {
    return this.segmentsService.findAll(projectId);
  }

  @Post()
  @RequireProjectPermission('messaging.write')
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateSegmentDto,
  ) {
    return this.segmentsService.create(projectId, dto);
  }

  @Post('preview')
  @RequireProjectPermission('messaging.write')
  async preview(
    @Param('projectId') projectId: string,
    @Body() dto: PreviewSegmentDto,
  ) {
    return this.segmentsService.preview(projectId, dto.definition);
  }

  @Get(':id')
  @RequireProjectPermission('project.read')
  async findOne(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.segmentsService.findOne(projectId, id);
  }

  @Get(':id/members')
  @RequireProjectPermission('project.read')
  async members(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(parseInt(limit ?? '100', 10) || 100, 1000);
    return this.segmentsService.listMembers(projectId, id, cursor ?? null, take);
  }

  @Patch(':id')
  @RequireProjectPermission('messaging.write')
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    return this.segmentsService.update(projectId, id, dto);
  }

  @Delete(':id')
  @RequireProjectPermission('messaging.write')
  async remove(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.segmentsService.remove(projectId, id, requesterOf(userId, req));
    return { deleted: true };
  }
}

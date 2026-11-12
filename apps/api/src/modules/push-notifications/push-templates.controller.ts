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
import { PushTemplatesService } from './push-templates.service';
import {
  CreatePushTemplateDto,
  UpdatePushTemplateDto,
} from './dto/push-notification.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

/**
 * Project-scoped template CRUD. Every route checks the caller's role in the project
 * named in the path, and the service reads templates only within that project.
 */
@Controller('projects/:projectId/push-templates')
@UseGuards(JwtAuthGuard)
export class PushTemplatesController {
  constructor(
    private readonly templatesService: PushTemplatesService,
  ) {}

  @Get()
  @RequireProjectPermission('project.read')
  async list(
    @Param('projectId') projectId: string,
  ) {
    return this.templatesService.findAll(projectId);
  }

  @Post()
  @RequireProjectPermission('messaging.write')
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreatePushTemplateDto,
  ) {
    return this.templatesService.create(projectId, dto);
  }

  @Get(':id')
  @RequireProjectPermission('project.read')
  async findOne(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.templatesService.findOne(projectId, id);
  }

  @Patch(':id')
  @RequireProjectPermission('messaging.write')
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePushTemplateDto,
  ) {
    return this.templatesService.update(projectId, id, dto);
  }

  @Delete(':id')
  @RequireProjectPermission('messaging.write')
  async remove(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.templatesService.remove(projectId, id, requesterOf(userId, req));
    return { deleted: true };
  }
}

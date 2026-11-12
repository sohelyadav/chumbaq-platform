import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { requesterOf } from '../project-activity/messaging-activity';
import { InAppMessagesService } from './in-app-messages.service';
import { CreateInAppMessageDto } from './dto/create-in-app-message.dto';
import { UpdateInAppMessageDto } from './dto/update-in-app-message.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { MessageStatus } from './entities/in-app-message.entity';

@Controller('projects/:projectId/in-app-messages')
@UseGuards(JwtAuthGuard)
export class InAppMessagesController {
  constructor(
    private readonly messagesService: InAppMessagesService,
  ) {}

  @Post()
  @RequireProjectPermission('messaging.write')
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateInAppMessageDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.messagesService.create(projectId, dto, userId);
  }

  @Get()
  @RequireProjectPermission('project.read')
  async findAll(
    @Param('projectId') projectId: string,
    @Query('status') status?: MessageStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.messagesService.findAll(projectId, {
      status,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get(':id')
  @RequireProjectPermission('project.read')
  async findOne(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.messagesService.findOne(id, projectId);
  }

  @Patch(':id')
  @RequireProjectPermission('messaging.write')
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateInAppMessageDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.messagesService.update(id, projectId, dto, requesterOf(userId, req));
  }

  @Delete(':id')
  @RequireProjectPermission('messaging.write')
  async remove(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.messagesService.remove(id, projectId, requesterOf(userId, req));
    return { deleted: true };
  }

  @Post(':id/activate')
  @RequireProjectPermission('messaging.write')
  async activate(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.messagesService.activate(id, projectId, requesterOf(userId, req));
  }

  @Post(':id/pause')
  @RequireProjectPermission('messaging.write')
  async pause(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.messagesService.pause(id, projectId, requesterOf(userId, req));
  }

  @Post(':id/duplicate')
  @RequireProjectPermission('messaging.write')
  async duplicate(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.messagesService.duplicate(id, projectId);
  }
}

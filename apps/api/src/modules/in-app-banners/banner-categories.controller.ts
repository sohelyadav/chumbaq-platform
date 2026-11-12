import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ForbiddenException,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { requesterOf } from '../project-activity/messaging-activity';
import { BannerCategoriesService } from './banner-categories.service';
import { CreateBannerCategoryDto } from './dto/create-banner-category.dto';
import { UpdateBannerCategoryDto } from './dto/update-banner-category.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

@Controller()
export class BannerCategoriesController {
  constructor(
    private readonly categoriesService: BannerCategoriesService,
  ) {}

  @Post('projects/:projectId/banner-categories')
  @RequireProjectPermission('messaging.write')
  @UseGuards(JwtAuthGuard)
  async create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateBannerCategoryDto,
  ) {
    return this.categoriesService.create(projectId, dto);
  }

  @Get('projects/:projectId/banner-categories')
  @RequireProjectPermission('project.read')
  @UseGuards(JwtAuthGuard)
  async findAll(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('layout') layout?: string,
  ) {
    return this.categoriesService.findAllByProject(projectId, layout);
  }

  @Get('banner-categories/:id')
  @RequireProjectPermission('project.read', { resource: 'bannerCategory', param: 'id' })
  @UseGuards(JwtAuthGuard)
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.categoriesService.findOneWithBanners(id);
  }

  @Patch('banner-categories/:id')
  @RequireProjectPermission('messaging.write', { resource: 'bannerCategory', param: 'id' })
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBannerCategoryDto,
  ) {
    return this.categoriesService.update(id, dto);
  }

  @Patch('banner-categories/:id/status')
  @RequireProjectPermission('messaging.write', { resource: 'bannerCategory', param: 'id' })
  @UseGuards(JwtAuthGuard)
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: string,
  ) {
    if (!['draft', 'active', 'paused'].includes(status)) {
      throw new ForbiddenException('Invalid status. Must be draft, active, or paused');
    }
    return this.categoriesService.updateStatus(id, status);
  }

  @Delete('banner-categories/:id')
  @RequireProjectPermission('messaging.write', { resource: 'bannerCategory', param: 'id' })
  @UseGuards(JwtAuthGuard)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.categoriesService.remove(id, access.project.id, requesterOf(userId, req));
    return { message: 'Banner category deleted successfully' };
  }
}

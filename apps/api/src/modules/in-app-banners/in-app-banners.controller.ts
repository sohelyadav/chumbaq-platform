import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { InAppBannersService } from './in-app-banners.service';
import { CreateInAppBannerDto } from './dto/create-in-app-banner.dto';
import { UpdateInAppBannerDto } from './dto/update-in-app-banner.dto';
import { ReorderBannersDto } from './dto/reorder-banners.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ApiKeyGuard } from '../api-keys/guards/api-key.guard';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { requesterOf } from '../project-activity/messaging-activity';

@Controller()
export class InAppBannersController {
  constructor(
    private readonly bannersService: InAppBannersService,
  ) {}

  @Post('banner-categories/:categoryId/banners')
  @RequireProjectPermission('messaging.write', { resource: 'bannerCategory', param: 'categoryId' })
  @UseGuards(JwtAuthGuard)
  async create(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: CreateInAppBannerDto,
  ) {
    return this.bannersService.create(categoryId, dto);
  }

  @Get('banner-categories/:categoryId/banners')
  @RequireProjectPermission('project.read', { resource: 'bannerCategory', param: 'categoryId' })
  @UseGuards(JwtAuthGuard)
  async findAll(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
  ) {
    return this.bannersService.findAllByCategory(categoryId);
  }

  // --- Public endpoints (no auth) — must be before /:id to avoid route shadowing ---

  @Get('in-app-banners/serve/:categoryId')
  @UseGuards(ApiKeyGuard)
  async serve(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Req() req: Request,
  ) {
    const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
    if (!apiKeyProjectId) {
      throw new ForbiddenException('Missing API key context');
    }
    const context = {
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] as string,
      referrer: req.headers['referer'] as string,
    };
    return this.bannersService.serveScoped(categoryId, apiKeyProjectId, context);
  }

  @Get('in-app-banners/:id')
  @RequireProjectPermission('project.read', { resource: 'banner', param: 'id' })
  @UseGuards(JwtAuthGuard)
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const banner = await this.bannersService.findOne(id);
    return banner;
  }

  @Patch('banner-categories/:categoryId/banners/reorder')
  @RequireProjectPermission('messaging.write', { resource: 'bannerCategory', param: 'categoryId' })
  @UseGuards(JwtAuthGuard)
  async reorder(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: ReorderBannersDto,
  ) {
    await this.bannersService.reorder(categoryId, dto.items);
    return { message: 'Banners reordered successfully' };
  }

  @Patch('in-app-banners/:id')
  @RequireProjectPermission('messaging.write', { resource: 'banner', param: 'id' })
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInAppBannerDto,
  ) {
    return this.bannersService.update(id, dto);
  }

  @Delete('in-app-banners/:id')
  @RequireProjectPermission('messaging.write', { resource: 'banner', param: 'id' })
  @UseGuards(JwtAuthGuard)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.bannersService.remove(id, access.project.id, requesterOf(userId, req));
    return { message: 'In-app banner deleted successfully' };
  }

  @Post('in-app-banners/:bannerId/click')
  @UseGuards(ApiKeyGuard)
  async recordClick(
    @Param('bannerId', ParseUUIDPipe) bannerId: string,
    @Req() req: Request,
  ) {
    const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
    if (!apiKeyProjectId) {
      throw new ForbiddenException('Missing API key context');
    }
    const context = {
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] as string,
      referrer: req.headers['referer'] as string,
    };
    await this.bannersService.recordClick(bannerId, context, apiKeyProjectId);
    return { message: 'Click recorded' };
  }
}

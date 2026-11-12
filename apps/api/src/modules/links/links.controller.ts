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
  Res,
  UploadedFile,
  UseInterceptors,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { requesterOf } from '../project-activity/messaging-activity';
import { LinksService } from './links.service';
import { QrCodeService } from './qr-code.service';
import { BulkLinkService } from './bulk-link.service';
import { LinkVariantsService } from './link-variants.service';
import { CreateLinkDto } from './dto/create-link.dto';
import { UpdateLinkDto } from './dto/update-link.dto';
import { CreateLinkVariantDto } from './dto/create-link-variant.dto';
import { UpdateLinkVariantDto } from './dto/update-link-variant.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class LinksController {
  constructor(
    private readonly linksService: LinksService,
    private readonly qrCodeService: QrCodeService,
    private readonly bulkLinkService: BulkLinkService,
    private readonly linkVariantsService: LinkVariantsService,
    private readonly configService: ConfigService,
  ) {}

  @RequireProjectPermission('messaging.write')
  @Post('projects/:projectId/links')
  async create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateLinkDto,
  ) {
    return this.linksService.create(projectId, dto);
  }

  @RequireProjectPermission('project.read')
  @Get('projects/:projectId/links')
  async findAllByProject(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() pagination: PaginationDto,
    @Query('search') search?: string,
    @Query('tags') tags?: string,
  ) {
    return this.linksService.findAllByProject(
      projectId,
      pagination,
      search,
      tags,
    );
  }

  @RequireProjectPermission('messaging.write')
  @Post('projects/:projectId/links/bulk')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5 MB cap
    }),
  )
  async bulkCreate(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new ForbiddenException('Missing file');
    }
    const allowedMime = ['text/csv', 'application/vnd.ms-excel', 'application/csv'];
    if (!allowedMime.includes(file.mimetype)) {
      throw new ForbiddenException('Only CSV files are allowed');
    }
    const dtos = this.bulkLinkService.parseCsv(file.buffer);
    return this.bulkLinkService.bulkCreate(projectId, dtos);
  }

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.linksService.findOne(id);
  }

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id/qr')
  async getQrCode(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('format') format?: 'png' | 'svg',
    @Query('size') size?: string,
  ) {
    const link = await this.linksService.findOne(id);
    const appUrl = this.configService.getOrThrow<string>('app.appUrl');
    const shortUrl = `${appUrl}/${link.shortCode}`;
    const qrData = await this.qrCodeService.generateQrCode(
      shortUrl,
      format || 'png',
      size ? parseInt(size, 10) : 300,
    );
    return { qrCode: qrData, format: format || 'png', shortUrl };
  }

  @RequireProjectPermission('messaging.write', { resource: 'link', param: 'id' })
  @Patch('links/:id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLinkDto,
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.linksService.update(id, dto, access.project.id, requesterOf(userId, req));
  }

  @RequireProjectPermission('messaging.write', { resource: 'link', param: 'id' })
  @Delete('links/:id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.linksService.remove(id, access.project.id, requesterOf(userId, req));
    return { message: 'Link deleted successfully' };
  }

  // A/B Testing variant endpoints
  @RequireProjectPermission('messaging.write', { resource: 'link', param: 'id' })
  @Post('links/:id/variants')
  async createVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateLinkVariantDto,
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.linkVariantsService.create(id, dto, access.project.id, requesterOf(userId, req));
  }

  @RequireProjectPermission('project.read', { resource: 'link', param: 'id' })
  @Get('links/:id/variants')
  async getVariants(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.linkVariantsService.findAllByLink(id);
  }

  @RequireProjectPermission('messaging.write', { resource: 'link', param: 'id' })
  @Patch('links/:id/variants/:variantId')
  async updateVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateLinkVariantDto,
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.linkVariantsService.update(variantId, id, dto, access.project.id, requesterOf(userId, req));
  }

  @RequireProjectPermission('messaging.write', { resource: 'link', param: 'id' })
  @Delete('links/:id/variants/:variantId')
  async removeVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.linkVariantsService.remove(variantId, id, access.project.id, requesterOf(userId, req));
    return { message: 'Variant deleted successfully' };
  }
}

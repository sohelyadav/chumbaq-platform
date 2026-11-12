import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ProjectsService, withCallerAccess } from './projects.service';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RecentAuthGuard } from '../auth/guards/recent-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { activityContext } from '../project-activity/activity-context';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  async create(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectsService.create(userId, dto);
  }

  @Get()
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationDto,
  ) {
    return this.projectsService.findAllByUser(user, pagination);
  }

  @RequireProjectPermission('project.read', { param: 'id' })
  @Get(':id')
  async findOne(@ProjectAccessContext() access: ProjectAccess) {
    return withCallerAccess(access.project, access.role, access.isBillingOwner);
  }

  @RequireProjectPermission('project.admin', { param: 'id' })
  @Patch(':id')
  async update(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateProjectDto,
    @Req() req: Request,
  ) {
    return this.projectsService.update(userId, access.project, dto, activityContext(req));
  }

  /** Irreversible, so it also needs a sign-in within 15 minutes. */
  // Listed above the permission decorator on purpose: decorators apply bottom-up and
  // UseGuards appends, so this gives [JwtAuthGuard, ProjectAccessGuard, RecentAuthGuard].
  @UseGuards(RecentAuthGuard)
  @RequireProjectPermission('project.admin', { param: 'id' })
  @Delete(':id')
  async remove(
    @ProjectAccessContext() access: ProjectAccess,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.projectsService.remove(userId, access.project, activityContext(req));
    return { message: 'Project deleted successfully' };
  }
}

import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { PeopleService } from './people.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

@Controller('projects/:projectId/users')
@UseGuards(JwtAuthGuard)
export class PeopleController {
  constructor(private readonly peopleService: PeopleService) {}

  @RequireProjectPermission('project.read')
  @Get()
  async listPeople(
    @Param('projectId') projectId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: 'active' | 'inactive',
    @Query('pushEnabled') pushEnabled?: string,
    @Query('country') country?: string,
    @Query('platform') platform?: string,
    @Query('hasRevenue') hasRevenue?: string,
  ) {
    return this.peopleService.listPeople(projectId, {
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      status,
      pushEnabled: pushEnabled === 'true' ? true : pushEnabled === 'false' ? false : undefined,
      country,
      platform,
      hasRevenue: hasRevenue === 'true' ? true : undefined,
    });
  }

  @RequireProjectPermission('project.read')
  @Get('stats')
  async getPeopleStats(
    @Param('projectId') projectId: string,
  ) {
    return this.peopleService.getPeopleStats(projectId);
  }

  @RequireProjectPermission('people.read')
  @Get(':personId')
  async getPersonDetail(
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
  ) {
    const person = await this.peopleService.getPersonDetail(projectId, personId);
    if (!person) throw new NotFoundException('Person not found');
    return person;
  }

  @RequireProjectPermission('people.read')
  @Get(':personId/events')
  async getPersonEvents(
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('eventName') eventName?: string,
  ) {
    return this.peopleService.getPersonEvents(projectId, personId, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
      eventName,
    });
  }

  @RequireProjectPermission('messaging.write')
  @Patch(':personId/traits')
  async updatePersonTraits(
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
    @Body() traits: Record<string, unknown>,
  ) {
    const result = await this.peopleService.updatePersonTraits(projectId, personId, traits);
    if (!result) throw new NotFoundException('Person not found');
    return result;
  }
}

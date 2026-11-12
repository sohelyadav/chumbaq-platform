import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  ForbiddenException,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiKeyEntity } from './entities/api-key.entity';
import { assertRecentAuth } from '../auth/guards/recent-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { PRIVACY_PERMISSION } from './api-key-permissions';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { ProjectAccessContext } from '../project-access/project-access.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { ProjectMemberEntity } from '../project-access/entities/project-member.entity';
import { ROLE_REFUSAL } from '../project-access/project-permissions';
import { activityContext } from '../project-activity/activity-context';

/** A hash of the key is what authenticates it at rest, and no client needs it. */
function withoutKeyHash(key: ApiKeyEntity): Omit<ApiKeyEntity, 'keyHash'> {
  const { keyHash: _keyHash, ...rest } = key;
  return rest;
}

@Controller('projects/:projectId/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeysController {
  constructor(
    private readonly apiKeysService: ApiKeysService,
    private readonly notices: SecurityNoticesService,
    @InjectRepository(ProjectMemberEntity)
    private readonly members: Repository<ProjectMemberEntity>,
  ) {}

  /**
   * A privacy key can erase and export anyone in the project, so only a role that may
   * do those itself (`privacy`, the owner) may make one. It is more than a stolen
   * session could do with the dashboard's own erase route (behind `RecentAuthGuard`),
   * so making one needs the same recent sign-in, and every owner of the project is
   * told by email. The notice is sent after responding and cannot fail the request.
   */
  @Post()
  @RequireProjectPermission('keys.manage')
  async create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateApiKeyDto,
    @ProjectAccessContext() access: ProjectAccess,
    @Req() req: Request,
  ) {
    const privacy = dto.permissions?.includes(PRIVACY_PERMISSION) ?? false;
    if (privacy) {
      if (!access.can('privacy')) throw new ForbiddenException(ROLE_REFUSAL);
      assertRecentAuth(user);
    }
    const project = access.project;
    const { apiKey, fullKey } = await this.apiKeysService.create(projectId, dto, user.userId, activityContext(req));
    if (privacy) {
      this.notices.inBackground(async () => {
        const owners = await this.members.find({
          where: { projectId, role: 'owner' },
          relations: { user: true },
        });
        for (const { user: owner } of owners) {
          if (!owner) continue;
          await this.notices.privacyKeyCreated(owner, { name: apiKey.name }, { id: project.id, name: project.name });
        }
      });
    }
    return { apiKey: withoutKeyHash(apiKey), fullKey };
  }

  @Get()
  @RequireProjectPermission('keys.manage')
  async findAll(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const keys = await this.apiKeysService.findAllByProject(projectId);
    return keys.map(withoutKeyHash);
  }

  @Delete(':id')
  @RequireProjectPermission('keys.manage')
  async revoke(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.apiKeysService.revoke(id, projectId, userId, activityContext(req));
    return { message: 'API key revoked successfully' };
  }
}

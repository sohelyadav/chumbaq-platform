import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import type { ProjectListMeta } from '@chumbaq/shared';
import { ProjectEntity } from './entities/project.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ProjectMemberEntity } from '../project-access/entities/project-member.entity';
import { UserEntity } from '../users/entities/user.entity';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { SeatsService } from '../project-access/seats.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { permissionsOf, type ProjectPermission, type ProjectRole } from '../project-access/project-permissions';
import { DEFAULT_MAX_PROJECTS_PER_ACCOUNT } from '../../config/projects.config';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';

/** What the dashboard shows when an account is at its limit. */
export function projectLimitMessage(limit: number): string {
  return `You can have up to ${limit} projects. Delete one or contact support to raise the limit.`;
}

/** Staff's per-account override if set, else `MAX_PROJECTS_PER_ACCOUNT`. */
export function effectiveProjectLimit(
  override: number | null | undefined,
  config: ConfigService | undefined,
): number {
  return (
    override ??
    config?.get<number>('projects.maxPerAccount') ??
    DEFAULT_MAX_PROJECTS_PER_ACCOUNT
  );
}

/**
 * The columns `PATCH /projects/:id` may write. Typed against the DTO so a new field
 * has to be listed here; ownership and pending-offer columns are never among them.
 */
const PROJECT_SETTINGS_COLUMNS: Record<keyof UpdateProjectDto, true> = {
  name: true,
  domain: true,
  iosBundleId: true,
  iosAppStoreUrl: true,
  iosTeamId: true,
  iosAppStoreId: true,
  androidPackageName: true,
  androidPlayStoreUrl: true,
  androidSha256Fingerprints: true,
  webFallbackUrl: true,
};

/** The settings the request actually carries; keys it left out are not touched. */
export function projectSettingsChanges(dto: UpdateProjectDto): Partial<ProjectEntity> {
  const changes: Partial<Record<keyof UpdateProjectDto, unknown>> = {};
  for (const key of Object.keys(PROJECT_SETTINGS_COLUMNS) as (keyof UpdateProjectDto)[]) {
    if (dto[key] !== undefined) changes[key] = dto[key];
  }
  return changes as Partial<ProjectEntity>;
}

/**
 * The settings a request really changes: those it carries whose value differs from the
 * row's. Name first, then the app-link fields in `PROJECT_SETTINGS_COLUMNS` order.
 */
export function changedProjectSettings(current: ProjectEntity, dto: UpdateProjectDto): (keyof UpdateProjectDto)[] {
  const changes = projectSettingsChanges(dto) as Record<string, unknown>;
  return (Object.keys(PROJECT_SETTINGS_COLUMNS) as (keyof UpdateProjectDto)[]).filter(
    (key) => key in changes && changes[key] !== (current as unknown as Record<string, unknown>)[key],
  );
}

/** A project as the caller sees it: their role, whether it is billed to them, what they may do. */
export type ProjectWithAccess = ProjectEntity & {
  role: ProjectRole;
  isBillingOwner: boolean;
  permissions: ProjectPermission[];
};

/** The project with the caller's access added, for `GET /projects` and `GET /projects/:id`. */
export function withCallerAccess(
  project: ProjectEntity,
  role: ProjectRole,
  isBillingOwner: boolean,
): ProjectWithAccess {
  return Object.assign(project, { role, isBillingOwner, permissions: permissionsOf(role) });
}

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    private readonly config: ConfigService,
    private readonly projectAccess: ProjectAccessService,
    private readonly seats: SeatsService,
    private readonly activity: ProjectActivityService,
  ) {}

  /** The project row FOR NO KEY UPDATE, the first lock of every project transaction (`lockProject`). */
  private async lockRow(manager: EntityManager, id: string): Promise<ProjectEntity> {
    const row = await manager.findOne(ProjectEntity, { where: { id }, lock: { mode: 'for_no_key_update' } });
    if (!row) throw new NotFoundException('Project not found');
    return row;
  }

  /**
   * Refused once the account owns its limit of projects. The owner's row is locked
   * before counting, so creates arriving together take turns and cannot each see
   * room for one more. FOR NO KEY UPDATE, as everywhere else that locks a user row
   * (`lock-users.ts`): it still lets the new project's foreign key check through.
   * Every project counts, a suspended account's too; projects have no soft delete.
   * Accounts already past the limit keep what they have; only another is refused.
   * The owner's `project_members` row is written in the same transaction.
   */
  async create(userId: string, dto: CreateProjectDto): Promise<ProjectEntity> {
    return this.projectRepository.manager.transaction(async (manager) => {
      const owner = await manager.findOne(UserEntity, {
        where: { id: userId },
        select: { id: true, projectLimit: true },
        lock: { mode: 'for_no_key_update' },
      });
      if (!owner) throw new NotFoundException('Account not found');

      const limit = effectiveProjectLimit(owner.projectLimit, this.config);
      const owned = await manager.count(ProjectEntity, { where: { ownerId: userId } });
      if (owned >= limit) throw new ForbiddenException(projectLimitMessage(limit));

      const project = await manager.save(manager.create(ProjectEntity, { ...dto, ownerId: userId }));
      await manager.insert(ProjectMemberEntity, {
        projectId: project.id,
        userId,
        role: 'owner',
        addedBy: null,
      });
      return project;
    });
  }

  /**
   * The projects the caller may see (`memberProjectsQuery`: their memberships, or in
   * view-as only those billed to the person viewed), each with the caller's `role`,
   * `isBillingOwner` and `permissions`. `meta.projectLimit` is the caller's own limit and
   * `meta.billedProjects` how many projects are billed to them, which is what that limit
   * counts, so the dashboard can show "N of M projects" however many they belong to.
   * `meta.seats` is the caller's billing account's seats.
   */
  async findAllByUser(
    user: AuthenticatedUser,
    pagination: PaginationDto,
  ): Promise<{ data: ProjectWithAccess[]; meta: ProjectListMeta }> {
    const userId = user.userId;
    const visible = this.projectAccess.memberProjectsQuery(user);
    const [[projects, total], owner, billedProjects, seatsUsed] = await Promise.all([
      this.projectRepository
        .createQueryBuilder('p')
        .where(`p.id IN (${visible.sql})`, visible.params)
        .orderBy('p.createdAt', 'DESC')
        .addOrderBy('p.id', 'DESC')
        .skip(pagination.skip)
        .take(pagination.limit)
        .getManyAndCount(),
      this.projectRepository.manager.findOne(UserEntity, {
        where: { id: userId },
        select: { id: true, projectLimit: true, seatLimit: true },
      }),
      this.projectRepository.count({ where: { ownerId: userId } }),
      this.seats.count(userId, this.projectRepository.manager),
    ]);

    const roles = new Map<string, ProjectRole>();
    if (projects.length > 0) {
      const members = await this.projectRepository.manager.find(ProjectMemberEntity, {
        where: { userId, projectId: In(projects.map((p) => p.id)) },
        select: { id: true, projectId: true, role: true },
      });
      for (const m of members) roles.set(m.projectId, m.role);
    }

    // A membership removed between the two reads leaves its project out rather than
    // showing it with no role.
    const data = projects
      .filter((p) => roles.has(p.id))
      .map((p) => withCallerAccess(p, roles.get(p.id) as ProjectRole, p.ownerId === userId));

    return {
      data,
      meta: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(total / pagination.limit),
        projectLimit: effectiveProjectLimit(owner?.projectLimit, this.config),
        billedProjects,
        seats: { used: seatsUsed, limit: this.seats.limitFor(owner?.seatLimit) },
      },
    };
  }

  /**
   * `project` comes from the access guard, which has already checked the caller may
   * administer it. That row was read without a lock, so it is never `save()`d: save
   * writes every column that differs from the current row, and a stale `ownerId` or
   * pending billing offer would undo a transfer, leave, removal or offer cancel that
   * committed since. Only the settings columns the request carries are written, and
   * the row is read again for the response.
   *
   * The comparison with the stored values is made under the row lock, and only what
   * differs is written and logged: `project.renamed` (old and new name) and
   * `project.app_links_changed` (field names only), in the same transaction. A request
   * that changes nothing writes nothing and logs nothing.
   */
  async update(
    actorId: string,
    project: ProjectEntity,
    dto: UpdateProjectDto,
    ctx: ActivityContext,
  ): Promise<ProjectEntity> {
    const requested = projectSettingsChanges(dto) as Record<string, unknown>;
    if (Object.keys(requested).length > 0) {
      await this.projectRepository.manager.transaction(async (manager) => {
        const before = await this.lockRow(manager, project.id);
        const changed = changedProjectSettings(before, dto);
        if (changed.length === 0) return;
        const write = Object.fromEntries(changed.map((key) => [key, requested[key]])) as Partial<ProjectEntity>;
        await manager.update(ProjectEntity, { id: project.id }, write);

        const name = (write.name ?? before.name) as string;
        const target = { type: 'project', id: project.id, label: name };
        const actor = { kind: 'user' as const, userId: actorId };
        if (changed.includes('name')) {
          await this.activity.record(
            { projectId: project.id, actor, action: 'project.renamed', target, details: { from: before.name, to: name } },
            ctx,
            manager,
          );
        }
        const fields = changed.filter((key) => key !== 'name');
        if (fields.length > 0) {
          await this.activity.record(
            { projectId: project.id, actor, action: 'project.app_links_changed', target, details: { fields } },
            ctx,
            manager,
          );
        }
      });
    }
    const current = await this.projectRepository.findOne({ where: { id: project.id } });
    if (!current) throw new NotFoundException('Project not found');
    return current;
  }

  /**
   * `project.deleted` is written in the delete's transaction, so a failed log write
   * deletes nothing. The entry outlives the row: `project_activity` has no foreign key.
   */
  async remove(actorId: string, project: ProjectEntity, ctx: ActivityContext): Promise<void> {
    await this.projectRepository.manager.transaction(async (manager) => {
      const current = await this.lockRow(manager, project.id);
      await this.activity.record(
        {
          projectId: current.id,
          actor: { kind: 'user', userId: actorId },
          action: 'project.deleted',
          target: { type: 'project', id: current.id, label: current.name },
        },
        ctx,
        manager,
      );
      await manager.remove(current);
    });
  }
}

import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ProjectEntity } from '../projects/entities/project.entity';
import { LinkEntity } from '../links/entities/link.entity';
import { BannerCategoryEntity } from '../in-app-banners/entities/banner-category.entity';
import { InAppBannerEntity } from '../in-app-banners/entities/in-app-banner.entity';
import { ProjectMemberEntity } from './entities/project-member.entity';
import {
  PROJECT_NOT_FOUND,
  ROLE_REFUSAL,
  roleCan,
  type ProjectPermission,
  type ProjectRole,
} from './project-permissions';

/** What `require` found: the project, the caller's place in it, and what that allows. */
export interface ProjectAccess {
  project: ProjectEntity;
  role: ProjectRole;
  /** The project is billed to the caller (`project.ownerId === user.userId`). */
  isBillingOwner: boolean;
  /** The caller is staff viewing as this user. */
  impersonated: boolean;
  can(permission: ProjectPermission): boolean;
}

/** Records whose project a resource-keyed route can be checked through. */
export type ProjectResource = 'link' | 'bannerCategory' | 'banner';

/**
 * "Projects this caller may see", as SQL for `p.id IN (<sql>)` in a TypeORM
 * QueryBuilder: pass `params` to the `.where`/`.andWhere` that holds it. The parameter
 * names start with `projectAccess_`, so they cannot collide with the query's own.
 */
export interface MemberProjectsQuery {
  sql: string;
  params: Record<string, unknown>;
}

// Anything Postgres would accept as a uuid, and nothing it would refuse with a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** A caller with no usable user id is refused before any lookup, which would otherwise match anyone. */
function callerId(user: AuthenticatedUser | undefined): string {
  if (!user || !isUuid(user.userId)) throw new UnauthorizedException();
  return user.userId;
}

/**
 * The one place that decides who may do what in a project. There is deliberately no
 * method that checks membership alone: every check names a permission.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    @InjectRepository(ProjectMemberEntity)
    private readonly members: Repository<ProjectMemberEntity>,
    @InjectRepository(LinkEntity)
    private readonly links: Repository<LinkEntity>,
    @InjectRepository(BannerCategoryEntity)
    private readonly categories: Repository<BannerCategoryEntity>,
    @InjectRepository(InAppBannerEntity)
    private readonly banners: Repository<InAppBannerEntity>,
  ) {}

  /**
   * The caller's access to a project, if their role there holds `permission`.
   *
   * One query: the caller's member row for this project, joined to the project. Not a
   * uuid, no such project, not a member, or staff viewing as someone in a project not
   * billed to them: 404 `Project not found`, all alike. A member whose role lacks the
   * permission: 403 `ROLE_REFUSAL`.
   *
   * View-as gets the same permissions as the person viewed here. Its other refusals are
   * not done by this service: `JwtStrategy` refuses every non-GET, and routes that stay
   * refused in view-as even as reads (privacy, project.admin, recent-auth actions) call
   * `refuseViewAs` themselves.
   */
  async require(
    user: AuthenticatedUser,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<ProjectAccess> {
    const userId = callerId(user);
    if (!isUuid(projectId)) throw new NotFoundException(PROJECT_NOT_FOUND);

    const member = await this.members.findOne({
      where: { projectId, userId },
      relations: { project: true },
    });
    const project = member?.project;
    if (!member || !project) throw new NotFoundException(PROJECT_NOT_FOUND);

    const impersonated = Boolean(user.impersonatedBy);
    // View-as shows only what the person viewed is billed for, so the audit of whose
    // data staff saw stays true.
    if (impersonated && project.ownerId !== userId) throw new NotFoundException(PROJECT_NOT_FOUND);

    const role = member.role;
    if (!roleCan(role, permission)) throw new ForbiddenException(ROLE_REFUSAL);

    return {
      project,
      role,
      isBillingOwner: project.ownerId === userId,
      impersonated,
      can: (p: ProjectPermission) => roleCan(role, p),
    };
  }

  /**
   * The project a resource-keyed route's record belongs to, or null when there is no
   * such record (or the id is not a uuid, which asks nothing). Callers answer null with
   * 404 `Project not found`, the same as a project the caller cannot see.
   */
  async projectIdOf(resource: ProjectResource, id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    switch (resource) {
      case 'link': {
        const link = await this.links.findOne({ where: { id }, select: { id: true, projectId: true } });
        return link?.projectId ?? null;
      }
      case 'bannerCategory': {
        const category = await this.categories.findOne({ where: { id }, select: { id: true, projectId: true } });
        return category?.projectId ?? null;
      }
      case 'banner': {
        const banner = await this.banners.findOne({ where: { id }, select: { id: true, categoryId: true } });
        if (!banner || !isUuid(banner.categoryId)) return null;
        return this.projectIdOf('bannerCategory', banner.categoryId);
      }
      default:
        return null;
    }
  }

  /**
   * The projects the caller is a member of, as a subquery (see `MemberProjectsQuery`).
   * In view-as, only those billed to the person viewed, as `require` decides.
   *
   *   qb.where(`p.id IN (${q.sql})`, q.params)
   */
  memberProjectsQuery(user: AuthenticatedUser): MemberProjectsQuery {
    const userId = callerId(user);
    const sql = user.impersonatedBy
      ? `SELECT projectaccess_m.project_id FROM project_members projectaccess_m
           INNER JOIN projects projectaccess_p ON projectaccess_p.id = projectaccess_m.project_id
          WHERE projectaccess_m.user_id = :projectAccess_userId
            AND projectaccess_p.owner_id = :projectAccess_userId`
      : `SELECT projectaccess_m.project_id FROM project_members projectaccess_m
          WHERE projectaccess_m.user_id = :projectAccess_userId`;
    return { sql, params: { projectAccess_userId: userId } };
  }
}

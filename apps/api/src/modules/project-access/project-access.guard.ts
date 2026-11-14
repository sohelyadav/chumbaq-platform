import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { isUuid, ProjectAccessService, type ProjectAccess } from './project-access.service';
import {
  PROJECT_PERMISSION_KEY,
  type ProjectPermissionMetadata,
  type ProjectSource,
} from './project-permission.metadata';
import { PROJECT_NOT_FOUND } from './project-permissions';

/** The request as this guard sees it. Guards run before pipes: nothing here is validated yet. */
export interface ProjectAccessRequest {
  user?: AuthenticatedUser;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  projectAccess?: ProjectAccess;
}

const ABSENT = Symbol('absent');

/** An own `projectId` of a parsed body or query, or ABSENT. Any other shape has none. */
function ownProjectId(container: unknown): unknown {
  if (typeof container !== 'object' || container === null || Array.isArray(container)) return ABSENT;
  return Object.prototype.hasOwnProperty.call(container, 'projectId')
    ? (container as Record<string, unknown>).projectId
    : ABSENT;
}

function ownParam(params: Record<string, unknown> | undefined, name: string): unknown {
  if (!params || !Object.prototype.hasOwnProperty.call(params, name)) return ABSENT;
  return params[name];
}

/**
 * Checks the permission a route names with `@RequireProjectPermission` in the project it
 * acts on, and leaves the result on `req.projectAccess` for `@ProjectAccessContext()`.
 *
 * Besides the declared source, every other project id the request carries
 * (`params.projectId`, `body.projectId`, `query.projectId`) must be a uuid and pass the
 * same check, so a handler that reads a second one cannot be pointed at someone else's
 * project. Any id that is missing, not a uuid string, or not visible is 404
 * `Project not found`.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ProjectAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<ProjectPermissionMetadata | undefined>(
      PROJECT_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Only `RequireProjectPermission` adds this guard, so no metadata is a wiring mistake.
    if (!metadata?.permission || !metadata.from) {
      throw new InternalServerErrorException('Route names no project permission');
    }

    const req = context.switchToHttp().getRequest<ProjectAccessRequest>();
    const user = req.user;
    if (!user) throw new UnauthorizedException();

    const declared = await this.declaredProjectId(req, metadata.from);
    const others = [ownParam(req.params, 'projectId'), ownProjectId(req.body), ownProjectId(req.query)].filter(
      (value) => value !== ABSENT,
    );
    for (const value of others) {
      if (!isCanonicalId(value)) throw new NotFoundException(PROJECT_NOT_FOUND);
    }

    const projectAccess = await this.access.require(user, declared, metadata.permission);
    const checked = new Set([declared]);
    for (const projectId of others as string[]) {
      if (checked.has(projectId)) continue;
      checked.add(projectId);
      await this.access.require(user, projectId, metadata.permission);
    }

    req.projectAccess = projectAccess;
    return true;
  }

  private async declaredProjectId(req: ProjectAccessRequest, from: ProjectSource): Promise<string> {
    let value: unknown;
    if ('resource' in from) {
      const id = ownParam(req.params, from.param);
      value = isUuid(id) ? await this.access.projectIdOf(from.resource, id) : null;
    } else if ('param' in from) {
      value = ownParam(req.params, from.param);
    } else if ('body' in from) {
      value = ownProjectId(req.body);
    } else if ('query' in from) {
      value = ownProjectId(req.query);
    } else {
      throw new InternalServerErrorException('Unknown project source');
    }
    if (!isCanonicalId(value)) throw new NotFoundException(PROJECT_NOT_FOUND);
    return value;
  }
}

/**
 * A uuid as Postgres writes it, in lower case. Postgres matches a uuid in any case, so
 * `ABC…` would pass the access check and then reach the handler spelled as typed, where
 * anything keyed on the string (the WhatsApp template cache) counts it as another
 * project: one project could add entries without end. Every id the API hands out is
 * lower case, so no client sends another spelling.
 */
function isCanonicalId(value: unknown): value is string {
  return isUuid(value) && value === value.toLowerCase();
}

import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { ProjectAccess } from './project-access.service';

/** `req.projectAccess`, which only `ProjectAccessGuard` sets; its absence is a wiring mistake. */
export function projectAccessFromRequest(req: { projectAccess?: ProjectAccess }): ProjectAccess {
  if (!req?.projectAccess) {
    throw new InternalServerErrorException('Project access was not checked for this route');
  }
  return req.projectAccess;
}

/**
 * The project and the caller's access to it, as checked by `@RequireProjectPermission`.
 * Take the project entity from here rather than loading it again.
 */
export const ProjectAccessContext = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  projectAccessFromRequest(ctx.switchToHttp().getRequest()),
);

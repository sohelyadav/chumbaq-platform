import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ProjectAccessGuard } from './project-access.guard';
import type { ProjectPermission } from './project-permissions';
import {
  PROJECT_PERMISSION_KEY,
  type ProjectPermissionMetadata,
  type ProjectSource,
} from './project-permission.metadata';

export { PROJECT_PERMISSION_KEY };
export type { ProjectPermissionMetadata, ProjectSource };

/**
 * The route needs `permission` in the project named by `from`. There is no default
 * permission: every project-scoped route names one.
 *
 * `JwtAuthGuard` must run first, or there is no signed-in user and this guard answers
 * 401. Put `@UseGuards(JwtAuthGuard)` on the class, or on a method write it BELOW this
 * decorator: method decorators apply bottom-up and `UseGuards` appends, so
 *
 *   @RequireProjectPermission('project.read')
 *   @UseGuards(JwtAuthGuard)        // runs first
 *
 * gives [JwtAuthGuard, ProjectAccessGuard]. Written the other way round the order is
 * reversed and every request is a 401.
 */
export function RequireProjectPermission(
  permission: ProjectPermission,
  from: ProjectSource = { param: 'projectId' },
) {
  const metadata: ProjectPermissionMetadata = { permission, from };
  return applyDecorators(SetMetadata(PROJECT_PERMISSION_KEY, metadata), UseGuards(ProjectAccessGuard));
}

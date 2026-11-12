import type { ProjectPermission } from './project-permissions';

/**
 * Where a route's project id comes from. `resource` routes name a record whose project
 * is looked up: `links.project_id`, `banner_categories.project_id`, or an
 * `in_app_banners` row's category's project.
 */
export type ProjectSource =
  | { param: string }
  | { body: 'projectId' }
  | { query: 'projectId' }
  | { resource: 'link' | 'bannerCategory' | 'banner'; param: string };

export const PROJECT_PERMISSION_KEY = 'chumbaq:project-permission';

export interface ProjectPermissionMetadata {
  permission: ProjectPermission;
  from: ProjectSource;
}

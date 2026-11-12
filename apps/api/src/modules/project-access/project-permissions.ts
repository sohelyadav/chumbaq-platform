import type {
  ProjectPermission as SharedProjectPermission,
  ProjectRole as SharedProjectRole,
} from '@chumbaq/shared';

/** What a person may be in a project. Exactly one owner per project; see the team-roles design. */
export const PROJECT_ROLES = ['owner', 'admin', 'member'] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

/**
 * Everything a role can be allowed in a project, by the names the spec uses
 * (docs/superpowers/specs/2026-11-08-team-roles-design.md, "Roles and permissions").
 */
export const PROJECT_PERMISSIONS = [
  'project.read',
  'messaging.write',
  'people.read',
  'channels.manage',
  'keys.manage',
  'members.manage',
  'activity.view',
  'privacy',
  'project.admin',
] as const;

export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

/** Non-member, or a project that does not exist: the same answer, so ids are not confirmed. */
export const PROJECT_NOT_FOUND = 'Project not found';

/** A member whose role lacks the permission the route names. */
export const ROLE_REFUSAL = 'Your role in this project does not allow this.';

// The API's lists and the shared unions must be the same sets, so a name added on one
// side alone fails compilation here rather than being refused or granted at run time.
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const PERMISSIONS_MATCH_SHARED: SameSet<ProjectPermission, SharedProjectPermission> = true;
const ROLES_MATCH_SHARED: SameSet<ProjectRole, SharedProjectRole> = true;
void PERMISSIONS_MATCH_SHARED;
void ROLES_MATCH_SHARED;

const MEMBER: readonly ProjectPermission[] = ['project.read', 'messaging.write', 'people.read'];
const ADMIN: readonly ProjectPermission[] = [
  ...MEMBER,
  'channels.manage',
  'keys.manage',
  'members.manage',
  'activity.view',
];

/** A Set whose mutators throw, so nothing can widen a role at run time. */
function frozenSet<T>(values: readonly T[]): ReadonlySet<T> {
  const set = new Set(values);
  const refuse = () => {
    throw new TypeError('Role permissions are read-only');
  };
  set.add = refuse;
  set.delete = refuse;
  set.clear = refuse;
  return Object.freeze(set);
}

/**
 * The one map from role to permissions. Owner holds all; admin all but `privacy` and
 * `project.admin`; member reads, messaging and one person's data. (`members.manage` for
 * an admin excludes touching owners; that rule lives with the membership routes.)
 */
export const ROLE_PERMISSIONS: Readonly<Record<ProjectRole, ReadonlySet<ProjectPermission>>> = Object.freeze({
  owner: frozenSet<ProjectPermission>(PROJECT_PERMISSIONS),
  admin: frozenSet(ADMIN),
  member: frozenSet(MEMBER),
});

export function roleCan(role: ProjectRole, permission: ProjectPermission): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role) && ROLE_PERMISSIONS[role].has(permission);
}

/** The role's permissions in the order of `PROJECT_PERMISSIONS`, as a fresh array. */
export function permissionsOf(role: ProjectRole): ProjectPermission[] {
  return PROJECT_PERMISSIONS.filter((permission) => roleCan(role, permission));
}

import type { Project, ProjectPermission, ProjectRole, ProjectSeats } from '@chumbaq/shared';

/**
 * What the dashboard offers for the caller's role in a project. `permissions` comes from
 * the API (`GET /api/projects`, `GET /api/projects/:id`), which maps roles to permissions
 * in one place; nothing here rebuilds that map. The server is still the authority: this
 * only keeps the UI from offering what it would refuse.
 */

/** Fails closed: a project not loaded yet, or without `permissions`, can do nothing. */
export function can(project: Pick<Project, 'permissions'> | undefined, permission: ProjectPermission): boolean {
  return Array.isArray(project?.permissions) && project.permissions.includes(permission);
}

const ALL_ROLES: ProjectRole[] = ['owner', 'admin', 'member'];

/** The roles an actor may give, in an invite or a role change. Only owners make owners. */
export function assignableRoles(actorRole: ProjectRole): ProjectRole[] {
  if (actorRole === 'owner') return [...ALL_ROLES];
  if (actorRole === 'admin') return ['admin', 'member'];
  return [];
}

/** Whether an actor may change or remove someone with `targetRole`. Admins never touch owners. */
export function canManageMember(actorRole: ProjectRole, targetRole: ProjectRole): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole !== 'owner';
  return false;
}

/** "3 of 5 seats", or "3 seats" when the account has no seat limit. */
export function seatLabel(seats: ProjectSeats): string {
  if (seats.limit === null) return `${seats.used} seat${seats.used === 1 ? '' : 's'}`;
  return `${seats.used} of ${seats.limit} seat${seats.limit === 1 ? '' : 's'}`;
}

/** No room for another person. An account staff put below what it uses is full too. */
export function atSeatLimit(seats: ProjectSeats): boolean {
  return seats.limit !== null && seats.used >= seats.limit;
}

const ROLE_LABELS: Record<ProjectRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export function roleLabel(role: ProjectRole): string {
  return ROLE_LABELS[role];
}

/** One line on what each role may do, for the role pickers. */
export const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: 'Everything, including privacy requests, project settings and deleting the project.',
  admin: 'Channels, API keys, webhooks and members. Cannot change owners.',
  member: 'Links, campaigns, audiences and people. Cannot change settings.',
};

/**
 * What a settings page shows in place of a value the API withheld from this role (it
 * sends `hidden while viewing as tenant` to anyone without `channels.manage`). View-as
 * sessions read as the owner, so they keep seeing the API's own words.
 */
export const HIDDEN_FROM_ROLE = 'Only owners and admins can see this.';

/** The API's placeholder for a withheld value (`HIDDEN_DURING_IMPERSONATION`). */
const WITHHELD = 'hidden while viewing as tenant';

/**
 * A settings value as this role should see it: the API's placeholder becomes
 * `HIDDEN_FROM_ROLE` for anyone without `channels.manage`, so a member is not told they
 * are "viewing as tenant". Everything else, and every value for those who manage
 * channels (view-as included), passes through untouched.
 */
export function shownValue<T extends string | null | undefined>(
  value: T,
  project: Pick<Project, 'permissions'> | undefined,
): T | string {
  if (value === WITHHELD && !can(project, 'channels.manage')) return HIDDEN_FROM_ROLE;
  return value;
}

/**
 * Whether a seat-limit refusal from the server (at `refusedAt`, ms) still holds. It holds
 * until seats read after it (`seatsUpdatedAt`) show room: seats read before it are what
 * the page already trusted when the server said no. Without seats data (a project billed
 * to someone else) it holds until the page clears it, on a removal or a cancelled invite.
 */
export function seatRefusalStands(
  refusedAt: number | null,
  seats: ProjectSeats | undefined,
  seatsUpdatedAt: number,
): boolean {
  if (refusedAt === null) return false;
  if (!seats || seatsUpdatedAt <= refusedAt) return true;
  return atSeatLimit(seats);
}

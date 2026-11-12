import {
  PROJECT_PERMISSIONS,
  PROJECT_ROLES,
  ROLE_PERMISSIONS,
  permissionsOf,
  roleCan,
  type ProjectPermission,
  type ProjectRole,
} from './project-permissions';

/**
 * A literal copy of the table the founder approved (docs/superpowers/specs/
 * 2026-11-08-team-roles-design.md, "Roles and permissions"). Change it only with the spec.
 */
const SPEC_TABLE: Record<ProjectPermission, Record<ProjectRole, boolean>> = {
  'project.read': { owner: true, admin: true, member: true },
  'messaging.write': { owner: true, admin: true, member: true },
  'people.read': { owner: true, admin: true, member: true },
  'channels.manage': { owner: true, admin: true, member: false },
  'keys.manage': { owner: true, admin: true, member: false },
  'members.manage': { owner: true, admin: true, member: false },
  'activity.view': { owner: true, admin: true, member: false },
  privacy: { owner: true, admin: false, member: false },
  'project.admin': { owner: true, admin: false, member: false },
};

describe('project permissions', () => {
  it('names exactly the nine permissions of the spec table', () => {
    expect([...PROJECT_PERMISSIONS].sort()).toEqual(Object.keys(SPEC_TABLE).sort());
    expect([...PROJECT_ROLES].sort()).toEqual(['admin', 'member', 'owner']);
  });

  it.each(Object.entries(SPEC_TABLE).flatMap(([p, row]) =>
    (Object.entries(row) as [ProjectRole, boolean][]).map(([role, yes]) => [role, p, yes] as const),
  ))('%s may %s: %s', (role, permission, yes) => {
    expect(roleCan(role, permission as ProjectPermission)).toBe(yes);
    expect(ROLE_PERMISSIONS[role].has(permission as ProjectPermission)).toBe(yes);
  });

  it('grants nothing the table does not list, in either direction', () => {
    for (const role of PROJECT_ROLES) {
      const fromTable = PROJECT_PERMISSIONS.filter((p) => SPEC_TABLE[p][role]).sort();
      expect([...ROLE_PERMISSIONS[role]].sort()).toEqual(fromTable);
      expect([...permissionsOf(role)].sort()).toEqual(fromTable);
    }
  });

  it('gives the owner every permission', () => {
    for (const p of PROJECT_PERMISSIONS) expect(roleCan('owner', p)).toBe(true);
  });

  it('refuses a role or permission that is not on the list', () => {
    expect(roleCan('viewer' as ProjectRole, 'project.read')).toBe(false);
    expect(roleCan('owner', 'everything' as ProjectPermission)).toBe(false);
  });

  it('cannot be widened at run time', () => {
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    const set = ROLE_PERMISSIONS.member as Set<ProjectPermission>;
    expect(() => set.add('privacy')).toThrow();
    expect(roleCan('member', 'privacy')).toBe(false);
    const list = permissionsOf('member');
    list.push('privacy');
    expect(permissionsOf('member')).not.toContain('privacy');
  });
});

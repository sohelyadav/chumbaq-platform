import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import {
  Ids,
  NO_OWNER_CONTROL,
  Route,
  bootDashboardApp,
  callRoute,
  enumerateRoutes,
  seedProjectData,
} from '../../test-support/sweep-fixtures';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { PROJECT_NOT_FOUND, PROJECT_PERMISSIONS, ROLE_REFUSAL, type ProjectPermission } from './project-permissions';

/**
 * Owner, admin, member and non-member against the real app, with the routes read from
 * its controllers' `@RequireProjectPermission` metadata.
 *
 * What each role may do is written out here from the spec ("Roles and permissions"),
 * not read from `ROLE_PERMISSIONS`, so widening a role in the map turns this red.
 *
 * Every route needing `channels.manage`, `keys.manage`, `privacy` or `project.admin` is
 * called by every role; every other permission by one representative route. "Refused"
 * is exactly 404 `Project not found` (non-member) or 403 `ROLE_REFUSAL` (member lacking
 * the permission). "Allowed" is anything else below 500: the guard let the request
 * through. A write the role is allowed gets a body with an unknown field, so it stops
 * at validation (400, after the guard) instead of changing anything. That needs a DTO
 * class as the body: a write without one (no `@Body()`, a field, or a plain type) runs
 * with its fixture body, so those go last, the project's own delete very last.
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@role-matrix-int.test';
const MARKER = 'ZZ-ROLE-MATRIX-1c9e';

type Role = 'owner' | 'admin' | 'member' | 'nonMember';

/** The spec's matrix. */
const MEMBER_CAN: ProjectPermission[] = ['project.read', 'messaging.write', 'people.read'];
const ADMIN_CAN: ProjectPermission[] = [...MEMBER_CAN, 'channels.manage', 'keys.manage', 'members.manage', 'activity.view'];
const CAN: Record<Role, readonly ProjectPermission[]> = {
  owner: PROJECT_PERMISSIONS,
  admin: ADMIN_CAN,
  member: MEMBER_CAN,
  nonMember: [],
};

/** Every route with one of these is checked, not a representative. */
const EVERY_ROUTE: ProjectPermission[] = ['channels.manage', 'keys.manage', 'privacy', 'project.admin'];

/**
 * One route per remaining permission, called with a valid body. A permission no route
 * declares yet needs none; one that a route declares and that is missing here fails.
 */
const REPRESENTATIVE: Partial<Record<ProjectPermission, string>> = {
  'project.read': 'GET /api/projects/:projectId/segments',
  'messaging.write': 'POST /api/projects/:projectId/segments',
  'people.read': 'GET /api/projects/:projectId/users/:personId',
  // The member's own role again (`BODIES`): a no-op 200 for owner and admin.
  'members.manage': 'PATCH /api/projects/:projectId/members/:memberId',
  'activity.view': 'GET /api/projects/:projectId/activity',
};

/** An unknown field: refused by `forbidNonWhitelisted`, after the guard, before the handler. */
const PROBE_BODY = { roleMatrixProbe: true };

describe('Role matrix (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let restoreEnv: () => void = () => undefined;
  let routes: Route[];
  let ids: Ids;
  const tokens = {} as Record<Role, string>;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });

  const cleanup = async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  const declared = (permission: ProjectPermission) => routes.filter((r) => r.permission?.permission === permission);

  /** What `role` got from `route`, against what the matrix says it should get. */
  const verdict = (
    role: Role,
    route: Route,
    res: { status: number; text: string; url: string },
  ): string | null => {
    const permission = route.permission!.permission;
    const where = `${role} ${res.status} ${res.url} (${permission})`;
    if (role === 'nonMember') {
      return res.status === 404 && res.text.includes(PROJECT_NOT_FOUND) ? null : `${where}: expected 404 ${PROJECT_NOT_FOUND}`;
    }
    if (!CAN[role].includes(permission)) {
      return res.status === 403 && res.text.includes(ROLE_REFUSAL) ? null : `${where}: expected 403 ${ROLE_REFUSAL}`;
    }
    const refused =
      (res.status === 403 && res.text.includes(ROLE_REFUSAL)) || (res.status === 404 && res.text.includes(PROJECT_NOT_FOUND));
    if (refused || res.status >= 500) return `${where}: expected allowed, ${res.text.slice(0, 200)}`;
    return null;
  };

  beforeAll(async () => {
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
    routes = enumerateRoutes(app);

    const users = ds.getRepository(UserEntity);
    const authTime = Math.floor(Date.now() / 1000);
    const userIds = {} as Record<Role, string>;
    for (const role of ['owner', 'admin', 'member', 'nonMember'] as Role[]) {
      const email = `${role.toLowerCase()}${DOMAIN}`;
      userIds[role] = (await users.save({ email, name: role, passwordHash: 'x' })).id;
      // A fresh sign-in, so RecentAuthGuard routes come down to the role.
      tokens[role] = await jwt.signAsync({ sub: userIds[role], email, type: 'access', auth_time: authTime });
    }
    const projectId = (await ds.getRepository(ProjectEntity).save({ name: MARKER, ownerId: userIds.owner })).id;
    await addOwnerMember(ds, projectId, userIds.owner);
    await addOwnerMember(ds, projectId, userIds.admin, 'admin');
    await addOwnerMember(ds, projectId, userIds.member, 'member');
    // The non-member has a project of their own, so "not a member" is not "no projects".
    const elsewhere = (await ds.getRepository(ProjectEntity).save({ name: 'elsewhere', ownerId: userIds.nonMember })).id;
    await addOwnerMember(ds, elsewhere, userIds.nonMember);
    ids = await seedProjectData(ds, projectId, MARKER);
    ids.memberUserId = userIds.member;
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
  });

  it('has a representative or a full check for every permission a route declares', () => {
    const counts = Object.fromEntries(PROJECT_PERMISSIONS.map((p) => [p, declared(p).length]));
    // eslint-disable-next-line no-console
    console.log(`Role matrix: routes per permission ${JSON.stringify(counts)}`);
    for (const p of EVERY_ROUTE) expect(declared(p).length).toBeGreaterThan(0);
    const uncovered = PROJECT_PERMISSIONS.filter(
      (p) => declared(p).length > 0 && !EVERY_ROUTE.includes(p) && !REPRESENTATIVE[p],
    );
    expect(uncovered).toEqual([]);
    for (const [p, key] of Object.entries(REPRESENTATIVE)) {
      const route = routes.find((r) => r.key === key);
      expect(route?.permission?.permission).toBe(p);
    }
  });

  it('gives every role what the matrix says on one route per permission', async () => {
    const failures: string[] = [];
    for (const key of Object.values(REPRESENTATIVE)) {
      const route = routes.find((r) => r.key === key)!;
      for (const role of ['nonMember', 'member', 'admin', 'owner'] as Role[]) {
        const res = await callRoute(base, route, tokens[role], ids);
        const wrong = verdict(role, route, res);
        if (wrong) failures.push(wrong);
        // A representative is called with a valid body, so allowed means served.
        else if (CAN[role].includes(route.permission!.permission) && (res.status < 200 || res.status >= 300)) {
          failures.push(`${role} ${res.status} ${res.url}: expected 2xx, ${res.text.slice(0, 200)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60000);

  it('lets owner, admin and member edit one person\'s consent, and shows a non-member 404', async () => {
    // Consent edits are `messaging.write`, not `people.read`.
    const key = 'PATCH /api/identity/projects/:projectId/users/:personId/consent';
    const route = routes.find((r) => r.key === key)!;
    expect(route?.permission?.permission).toBe('messaging.write');
    const failures: string[] = [];
    for (const role of ['nonMember', 'member', 'admin', 'owner'] as Role[]) {
      const res = await callRoute(base, route, tokens[role], ids, { body: { emailOptIn: true } });
      const wrong = verdict(role, route, res);
      if (wrong) failures.push(wrong);
      else if (CAN[role].includes('messaging.write') && (res.status < 200 || res.status >= 300)) {
        failures.push(`${role} ${res.status} ${res.url}: expected 2xx, ${res.text.slice(0, 200)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 30000);

  it('lets owner and admin remove a member, and refuses a member and a non-member', async () => {
    const route = routes.find((r) => r.key === 'DELETE /api/projects/:projectId/members/:memberId')!;
    expect(route?.permission?.permission).toBe('members.manage');
    const failures: string[] = [];
    for (const role of ['nonMember', 'member', 'admin', 'owner'] as Role[]) {
      // Someone to remove, each time.
      const extra = await ds.getRepository(UserEntity).save({ email: `extra-${role.toLowerCase()}${DOMAIN}`, name: 'x', passwordHash: 'x' });
      await addOwnerMember(ds, ids.projectId, extra.id, 'member');
      const res = await callRoute(base, route, tokens[role], { ...ids, memberUserId: extra.id });
      const wrong = verdict(role, route, res);
      if (wrong) failures.push(wrong);
      else if (CAN[role].includes('members.manage') && res.status !== 200) {
        failures.push(`${role} ${res.status} ${res.url}: expected 200, ${res.text.slice(0, 200)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 30000);

  it('lets every member reach the decline route (it only clears an offer to the caller), and shows a non-member 404', async () => {
    const route = routes.find((r) => r.key === 'POST /api/projects/:projectId/billing-transfer/decline')!;
    expect(route?.permission?.permission).toBe('project.read');
    const failures: string[] = [];
    for (const role of ['nonMember', 'member', 'admin', 'owner'] as Role[]) {
      const res = await callRoute(base, route, tokens[role], ids);
      const wrong = verdict(role, route, res);
      if (wrong) failures.push(wrong);
      // No offer is pending to anyone: past the guard, the handler's own 400.
      else if (role !== 'nonMember' && res.status !== 400) failures.push(`${role} ${res.status}: expected 400`);
    }
    expect(failures).toEqual([]);
  }, 30000);

  it('lets owner and admin list, create, resend and revoke invitations, and refuses a member and a non-member', async () => {
    const keys = [
      'GET /api/projects/:projectId/invitations',
      'POST /api/projects/:projectId/invitations',
      'POST /api/projects/:projectId/invitations/:invitationId/resend',
      'DELETE /api/projects/:projectId/invitations/:invitationId',
    ];
    const failures: string[] = [];
    for (const key of keys) {
      const route = routes.find((r) => r.key === key)!;
      expect(route?.permission?.permission).toBe('members.manage');
      for (const role of ['nonMember', 'member', 'admin', 'owner'] as Role[]) {
        // A pending member invite of this project for each call, so a revoke has one to revoke.
        const [{ id: invitationId }] = await ds.query(
          `INSERT INTO project_invitations (project_id, email, role, token_hash, expires_at)
           VALUES ($1, $2, 'member', md5(random()::text) || md5(random()::text), now() + interval '7 days')
           RETURNING id`,
          [ids.projectId, `invitee-${role.toLowerCase()}-${key.length}-${Date.now()}@role-matrix-invitee.test`],
        );
        const res = await callRoute(base, route, tokens[role], { ...ids, invitationId });
        const wrong = verdict(role, route, res);
        if (wrong) failures.push(wrong);
        else if (CAN[role].includes('members.manage') && (res.status < 200 || res.status >= 300)) {
          failures.push(`${role} ${res.status} ${res.url}: expected 2xx, ${res.text.slice(0, 200)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 30000);

  it('refuses members (and admins, for privacy and project.admin) every route of the restricted permissions', async () => {
    const restricted = routes.filter((r) => r.permission && EVERY_ROUTE.includes(r.permission.permission));
    // Writes that run when allowed go last, deleting the project very last.
    // A write without a class body has nothing to refuse an unknown field: the probe
    // body would reach the handler, so it is treated as one that runs.
    const runs = (r: Route) => r.method !== 'GET' && !r.bodyIsDto;
    const rank = (r: Route) => (r.key === 'DELETE /api/projects/:id' ? 3 : r.method === 'DELETE' ? 2 : runs(r) ? 1 : 0);
    restricted.sort((x, y) => rank(x) - rank(y));

    const failures: string[] = [];
    const tally: Record<string, number> = {};
    for (const route of restricted) {
      for (const role of ['nonMember', 'member', 'admin', 'owner'] as Role[]) {
        const allowed = CAN[role].includes(route.permission!.permission);
        // The probe only where a DTO will refuse it; other writes run with their fixture body.
        const probe = allowed && !runs(route);
        if (route.method === 'GET' && allowed && NO_OWNER_CONTROL[route.key]) continue;
        const res = await callRoute(base, route, tokens[role], ids, probe ? { body: PROBE_BODY } : {});
        const wrong = verdict(role, route, res);
        if (wrong) failures.push(wrong);
        else if (route.method === 'GET' && allowed && (res.status < 200 || res.status >= 300)) {
          failures.push(`${role} ${res.status} ${res.url}: expected 2xx, ${res.text.slice(0, 200)}`);
        }
        tally[`${role} ${res.status}`] = (tally[`${role} ${res.status}`] ?? 0) + 1;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Role matrix: ${restricted.length} restricted routes; ${JSON.stringify(tally)}`);
    expect(restricted.length).toBeGreaterThanOrEqual(25);
    expect(failures).toEqual([]);
  }, 120000);
});

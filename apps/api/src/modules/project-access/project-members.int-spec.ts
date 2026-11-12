import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp } from '../../test-support/sweep-fixtures';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { LAST_OWNER, MEMBER_NOT_FOUND, MOVE_BILLING_FIRST } from './project-members.service';
import { PROJECT_NOT_FOUND, ROLE_REFUSAL, type ProjectRole } from './project-permissions';
import { IMPERSONATION_READ_ONLY } from './view-as';

/**
 * Member management over HTTP against the real app and database: the routes' guards,
 * the owner rules, and two owners demoting each other at the same moment on two
 * connections (the app's pool), which the project row lock must serialise.
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@project-members-int.test';

describe('Project members (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let restoreEnv: () => void = () => undefined;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  let seq = 0;

  const cleanup = async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  interface Person {
    id: string;
    email: string;
    token: string;
    /** Signed in an hour ago: past RecentAuthGuard's window. */
    staleToken: string;
  }

  const person = async (label: string): Promise<Person> => {
    const email = `${label}-${++seq}${DOMAIN}`;
    const id = (await ds.getRepository(UserEntity).save({ email, name: `Name ${label}`, passwordHash: 'secret-hash-x' })).id;
    const now = Math.floor(Date.now() / 1000);
    const sign = (authTime: number) => jwt.signAsync({ sub: id, email, type: 'access', auth_time: authTime });
    return { id, email, token: await sign(now), staleToken: await sign(now - 3600) };
  };

  /** A project billed to `billing`, with each of `others` a member in the given role. */
  const project = async (billing: Person, others: Array<[Person, ProjectRole]> = []): Promise<string> => {
    const id = (await ds.getRepository(ProjectEntity).save({ name: 'members', ownerId: billing.id })).id;
    await addOwnerMember(ds, id, billing.id);
    for (const [p, role] of others) await addOwnerMember(ds, id, p.id, role);
    return id;
  };

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };

  const roles = async (projectId: string): Promise<Record<string, ProjectRole>> => {
    const rows: Array<{ user_id: string; role: ProjectRole }> = await ds.query(
      `SELECT user_id, role FROM project_members WHERE project_id = $1`,
      [projectId],
    );
    return Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
  };

  beforeAll(async () => {
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
  });

  it('lists every member with email and name only, and the pending offer, to any member', async () => {
    const [x, a, m] = [await person('x'), await person('a'), await person('m')];
    const p = await project(x, [[a, 'admin'], [m, 'member']]);

    const res = await call('GET', `/projects/${p}/members`, m.token);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('secret-hash-x');
    const { members, billingOffer } = res.json.data;
    expect(billingOffer).toBeNull();
    expect(members.map((r: { userId: string }) => r.userId)).toEqual([x.id, a.id, m.id]);
    expect(members[0]).toEqual({
      userId: x.id,
      email: x.email,
      name: 'Name x',
      role: 'owner',
      isBillingOwner: true,
      createdAt: expect.any(String),
    });
    expect(Object.keys(members[1]).sort()).toEqual(['createdAt', 'email', 'isBillingOwner', 'name', 'role', 'userId']);
    expect(members[1]).toMatchObject({ role: 'admin', isBillingOwner: false });

    const outsider = await person('o');
    const refused = await call('GET', `/projects/${p}/members`, outsider.token);
    expect(refused.status).toBe(404);
    expect(refused.text).toContain(PROJECT_NOT_FOUND);
  });

  it('lets exactly one of two owners demoting each other at once succeed', async () => {
    // Several rounds: without the lock, both requests read two other owners and both win.
    for (let round = 0; round < 6; round++) {
      const [x, a, b] = [await person('x'), await person('a'), await person('b')];
      const p = await project(x, [[a, 'owner'], [b, 'owner']]);
      const [ra, rb] = await Promise.all([
        call('PATCH', `/projects/${p}/members/${b.id}`, a.token, { role: 'admin' }),
        call('PATCH', `/projects/${p}/members/${a.id}`, b.token, { role: 'admin' }),
      ]);
      const statuses = [ra.status, rb.status].sort();
      expect({ round, statuses }).toEqual({ round, statuses: [200, 403] });
      expect([ra, rb].find((r) => r.status === 403)!.text).toContain(ROLE_REFUSAL);
      const after = await roles(p);
      expect(Object.values(after).filter((r) => r === 'owner')).toHaveLength(2);
      expect(after[x.id]).toBe('owner');
    }
  }, 60000);

  it('lets only one of an owner leaving and another owner removing them succeed, when both arrive at once', async () => {
    // Without the lock both read A's row before either deletes it, and both answer 200.
    for (let round = 0; round < 6; round++) {
      const [x, a, b] = [await person('x'), await person('a'), await person('b')];
      const p = await project(x, [[a, 'owner'], [b, 'owner']]);
      const [left, removed] = await Promise.all([
        call('POST', `/projects/${p}/leave`, a.token),
        call('DELETE', `/projects/${p}/members/${a.id}`, b.token),
      ]);
      const statuses = [left.status, removed.status].sort();
      expect({ round, statuses }).toEqual({ round, statuses: [200, 404] });
      // The loser is told what it found: A already gone from the project, or no longer a member.
      const loser = [left, removed].find((r) => r.status === 404)!;
      expect(loser.text).toContain(loser === left ? PROJECT_NOT_FOUND : MEMBER_NOT_FOUND);
      expect(await roles(p)).toEqual({ [x.id]: 'owner', [b.id]: 'owner' });
    }
  }, 60000);

  it('refuses demoting, removing or the leaving of the billing owner', async () => {
    const [x, a] = [await person('x'), await person('a')];
    const p = await project(x, [[a, 'owner']]);
    for (const res of [
      await call('PATCH', `/projects/${p}/members/${x.id}`, a.token, { role: 'admin' }),
      await call('DELETE', `/projects/${p}/members/${x.id}`, a.token),
      await call('POST', `/projects/${p}/leave`, x.token),
      await call('PATCH', `/projects/${p}/members/${x.id}`, x.token, { role: 'member' }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.text).toContain(MOVE_BILLING_FIRST);
    }
    expect((await roles(p))[x.id]).toBe('owner');
  });

  it('refuses the last owner leaving when billing is out of step (count read under the lock)', async () => {
    const [x, a] = [await person('x'), await person('a')];
    const p = await project(x, [[a, 'owner']]);
    // Demote X by hand, as no route can, leaving A the only owner but not the billing owner.
    await ds.query(`UPDATE project_members SET role = 'admin' WHERE project_id = $1 AND user_id = $2`, [p, x.id]);
    await ds.query(`UPDATE projects SET owner_id = $2 WHERE id = $1`, [p, (await person('z')).id]);
    const res = await call('POST', `/projects/${p}/leave`, a.token);
    expect(res.status).toBe(409);
    expect(res.text).toContain(LAST_OWNER);
  });

  it('keeps admins off owners and off granting owner, and lets them manage members', async () => {
    const [x, a, o, m] = [await person('x'), await person('a'), await person('o'), await person('m')];
    const p = await project(x, [[a, 'admin'], [o, 'owner'], [m, 'member']]);
    for (const res of [
      await call('PATCH', `/projects/${p}/members/${o.id}`, a.token, { role: 'member' }),
      await call('DELETE', `/projects/${p}/members/${o.id}`, a.token),
      await call('PATCH', `/projects/${p}/members/${m.id}`, a.token, { role: 'owner' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.text).toContain(ROLE_REFUSAL);
    }
    const promoted = await call('PATCH', `/projects/${p}/members/${m.id}`, a.token, { role: 'admin' });
    expect(promoted.status).toBe(200);
    expect(promoted.json.data.members.find((r: { userId: string }) => r.userId === m.id).role).toBe('admin');
    // The same role again: a no-op.
    expect((await call('PATCH', `/projects/${p}/members/${m.id}`, a.token, { role: 'admin' })).status).toBe(200);
    // A member cannot manage anyone.
    const member = await person('mm');
    await addOwnerMember(ds, p, member.id, 'member');
    const refused = await call('DELETE', `/projects/${p}/members/${m.id}`, member.token);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain(ROLE_REFUSAL);
    // Unknown member and a bad role.
    const unknown = await call('DELETE', `/projects/${p}/members/${(await person('u')).id}`, a.token);
    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain(MEMBER_NOT_FOUND);
    expect((await call('PATCH', `/projects/${p}/members/${m.id}`, a.token, { role: 'boss' })).status).toBe(400);
  });

  it('needs a recent sign-in to grant owner and to demote or remove an owner, not to manage others', async () => {
    const [x, o, m] = [await person('x'), await person('o'), await person('m')];
    const p = await project(x, [[o, 'owner'], [m, 'member']]);
    for (const res of [
      await call('PATCH', `/projects/${p}/members/${m.id}`, x.staleToken, { role: 'owner' }),
      await call('PATCH', `/projects/${p}/members/${o.id}`, x.staleToken, { role: 'admin' }),
      await call('DELETE', `/projects/${p}/members/${o.id}`, x.staleToken),
      // The billing owner, which would be a 409: the stale session is asked to re-auth first.
      await call('DELETE', `/projects/${p}/members/${x.id}`, o.staleToken),
    ]) {
      expect(res.status).toBe(403);
      expect(res.text).toContain(REAUTH_REQUIRED_MESSAGE);
    }
    expect(await roles(p)).toEqual({ [x.id]: 'owner', [o.id]: 'owner', [m.id]: 'member' });
    expect((await call('PATCH', `/projects/${p}/members/${m.id}`, x.staleToken, { role: 'admin' })).status).toBe(200);
    expect((await call('PATCH', `/projects/${p}/members/${m.id}`, x.token, { role: 'owner' })).status).toBe(200);
    // An owner leaving removes an owner: a recent sign-in too, asked before any 409.
    const stale = await call('POST', `/projects/${p}/leave`, m.staleToken);
    expect(stale.status).toBe(403);
    expect(stale.text).toContain(REAUTH_REQUIRED_MESSAGE);
    const staleBilling = await call('POST', `/projects/${p}/leave`, x.staleToken);
    expect(staleBilling.status).toBe(403);
    expect(staleBilling.text).toContain(REAUTH_REQUIRED_MESSAGE);
    expect((await roles(p))[m.id]).toBe('owner');
    expect((await call('POST', `/projects/${p}/leave`, m.token)).status).toBe(200);
    expect((await call('DELETE', `/projects/${p}/members/${o.id}`, x.token)).status).toBe(200);
  });

  it('ends access on the next request once a member is removed or leaves', async () => {
    const [x, m, n] = [await person('x'), await person('m'), await person('n')];
    const p = await project(x, [[m, 'member'], [n, 'admin']]);
    expect((await call('GET', `/projects/${p}`, m.token)).status).toBe(200);
    expect((await call('DELETE', `/projects/${p}/members/${m.id}`, x.token)).status).toBe(200);
    expect((await call('GET', `/projects/${p}`, m.token)).status).toBe(404);

    // A member (here an admin) leaves without a recent sign-in.
    const left = await call('POST', `/projects/${p}/leave`, n.staleToken);
    expect(left.status).toBe(200);
    expect((await call('GET', `/projects/${p}/members`, n.token)).status).toBe(404);
  });

  it('refuses every write here to staff viewing as the billing owner', async () => {
    const [x, o] = [await person('x'), await person('o')];
    const p = await project(x, [[o, 'owner']]);
    const staff = await ds.getRepository(UserEntity).save({
      email: `staff-${++seq}${DOMAIN}`,
      name: 'Staff',
      passwordHash: 'x',
      isSuperAdmin: true,
    });
    const { sessionId } = await issueStaffSessionForTest(ds, { id: staff.id, email: staff.email, sessionVersion: 0 });
    const viewAs = await jwt.signAsync({
      sub: x.id,
      email: x.email,
      type: 'access',
      imp: staff.id,
      impSv: 0,
      impSid: sessionId,
      auth_time: Math.floor(Date.now() / 1000),
    });
    // The read is allowed: view-as sees what the person viewed sees.
    expect((await call('GET', `/projects/${p}/members`, viewAs)).status).toBe(200);
    for (const [method, path, body] of [
      ['PATCH', `/projects/${p}/members/${o.id}`, { role: 'admin' }],
      ['DELETE', `/projects/${p}/members/${o.id}`, undefined],
      ['POST', `/projects/${p}/leave`, undefined],
      ['POST', `/projects/${p}/billing-transfer`, { toUserId: o.id }],
      ['DELETE', `/projects/${p}/billing-transfer`, undefined],
      ['POST', `/projects/${p}/billing-transfer/accept`, undefined],
      ['POST', `/projects/${p}/billing-transfer/decline`, undefined],
    ] as const) {
      const res = await call(method, path, viewAs, body);
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 403 });
      expect(res.text).toContain(IMPERSONATION_READ_ONLY);
    }
    expect(await roles(p)).toEqual({ [x.id]: 'owner', [o.id]: 'owner' });
  });
});

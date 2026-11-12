import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import type { ProjectActivityAction } from '@chumbaq/shared';
import { TRUST_PROXY } from '../../common/client-ip';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp } from '../../test-support/sweep-fixtures';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { LAST_OWNER } from '../project-access/project-members.service';
import { ROLE_REFUSAL, type ProjectRole } from '../project-access/project-permissions';
import { ProjectActivityService } from './project-activity.service';

/**
 * The Team and Project groups of the activity log, written by the real routes against
 * the real database: each action writes exactly one entry with the right actor, target,
 * address and details; a refused action, or one that changes nothing, writes none; and
 * a failed log write takes the action down with it.
 *
 * `project_activity` is append-only and the int database is shared, so every assertion
 * reads only the rows of a project made in that test.
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@team-activity-int.test';
/** Sent as X-Forwarded-For from loopback, which `TRUST_PROXY` believes. */
const IP = '203.0.113.77';
const AGENT = 'team-activity-int/1';

interface Person {
  id: string;
  email: string;
  name: string;
  token: string;
  /** "Name (email)", as the log labels a person. */
  label: string;
}

interface Row {
  action: ProjectActivityAction;
  actor_kind: string;
  actor_user_id: string | null;
  actor_label: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
}

describe('Team and project activity (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let activity: ProjectActivityService;
  let restoreEnv: () => void = () => undefined;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  let seq = 0;
  const savedEnv = { key: process.env.PLATFORM_BREVO_API_KEY, seats: process.env.MAX_SEATS_PER_ACCOUNT };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  const cleanup = async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  const person = async (label: string): Promise<Person> => {
    const email = `${label}-${++seq}${DOMAIN}`;
    const name = `Name ${label}`;
    const id = (
      await ds.getRepository(UserEntity).save({ email, name, passwordHash: 'x', emailVerifiedAt: new Date() })
    ).id;
    const token = await jwt.signAsync({ sub: id, email, type: 'access', auth_time: Math.floor(Date.now() / 1000) });
    return { id, email, name, token, label: `${name} (${email})` };
  };

  const project = async (billing: Person, others: Array<[Person, ProjectRole]> = [], name = 'team'): Promise<string> => {
    const id = (await ds.getRepository(ProjectEntity).save({ name, ownerId: billing.id })).id;
    await addOwnerMember(ds, id, billing.id);
    for (const [p, role] of others) await addOwnerMember(ds, id, p.id, role);
    return id;
  };

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': IP,
        'user-agent': AGENT,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };

  const rows = async (projectId: string): Promise<Row[]> =>
    ds.query(
      `SELECT action, actor_kind, actor_user_id, actor_label, target_type, target_id, target_label, details,
              ip_address, user_agent
         FROM project_activity WHERE project_id = $1 ORDER BY occurred_at, id`,
      [projectId],
    );

  /** The one row the action wrote, after `before` rows. */
  const onlyNew = async (projectId: string, before: number): Promise<Row> => {
    const all = await rows(projectId);
    expect(all.length).toBe(before + 1);
    return all[all.length - 1];
  };

  const byUser = (who: Person) => ({
    actor_kind: 'user',
    actor_user_id: who.id,
    actor_label: who.label,
    ip_address: IP,
    user_agent: AGENT,
  });

  const memberTarget = (who: Person) => ({ target_type: 'member', target_id: who.id, target_label: who.label });

  const invite = async (inviter: Person, projectId: string, email: string, role: ProjectRole = 'member') => {
    const res = await call('POST', `/projects/${projectId}/invitations`, inviter.token, { email, role });
    expect({ status: res.status, text: res.status === 201 ? '' : res.text }).toEqual({ status: 201, text: '' });
    const match = /#token=([A-Za-z0-9_-]{43})$/.exec(res.json.data.inviteUrl as string);
    return { id: res.json.data.invitation.id as string, token: match![1] };
  };

  beforeAll(async () => {
    process.env.MAX_SEATS_PER_ACCOUNT = '';
    process.env.PLATFORM_BREVO_API_KEY = '';
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
    // As main.ts does, so the X-Forwarded-For sent from loopback is the client's address.
    app.getHttpAdapter().getInstance().set('trust proxy', TRUST_PROXY);
    activity = app.get(ProjectActivityService);
  }, 120000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
    restore('PLATFORM_BREVO_API_KEY', savedEnv.key);
    restore('MAX_SEATS_PER_ACCOUNT', savedEnv.seats);
  });

  describe('invitations', () => {
    it('logs an invite, a resend, a cancel and an accept, each once', async () => {
      const [x, a] = [await person('x'), await person('a')];
      const p = await project(x, [[a, 'admin']]);
      const invitee = await person('invitee');

      const sent = await invite(a, p, invitee.email, 'member');
      expect(await onlyNew(p, 0)).toEqual({
        action: 'member.invited',
        ...byUser(a),
        target_type: 'invitation',
        target_id: sent.id,
        target_label: invitee.email,
        details: { role: 'member', email: invitee.email },
      });

      const resent = await call('POST', `/projects/${p}/invitations/${sent.id}/resend`, a.token);
      expect(resent.status).toBe(201);
      const token = /#token=([A-Za-z0-9_-]{43})$/.exec(resent.json.data.inviteUrl as string)![1];
      expect(await onlyNew(p, 1)).toEqual({
        action: 'invite.resent',
        ...byUser(a),
        target_type: 'invitation',
        target_id: sent.id,
        target_label: invitee.email,
        details: null,
      });

      const accepted = await call('POST', '/invitations/accept', invitee.token, { token });
      expect(accepted.status).toBe(201);
      expect(await onlyNew(p, 2)).toEqual({
        action: 'invite.accepted',
        ...byUser(invitee),
        target_type: 'invitation',
        target_id: sent.id,
        target_label: invitee.email,
        details: null,
      });

      const other = await invite(x, p, `other-${++seq}${DOMAIN}`, 'admin');
      expect((await onlyNew(p, 3)).details).toEqual({ role: 'admin', email: expect.stringContaining('other-') });
      const revoked = await call('DELETE', `/projects/${p}/invitations/${other.id}`, x.token);
      expect(revoked.status).toBe(200);
      expect(await onlyNew(p, 4)).toMatchObject({
        action: 'invite.cancelled',
        ...byUser(x),
        target_type: 'invitation',
        target_id: other.id,
        details: null,
      });
    });

    it('logs nothing for a refused invite, resend or cancel', async () => {
      const [x, a, m] = [await person('x'), await person('a'), await person('m')];
      const p = await project(x, [[a, 'admin'], [m, 'member']]);
      const owners = await invite(x, p, `o-${++seq}${DOMAIN}`, 'owner');
      const before = (await rows(p)).length;

      for (const res of [
        await call('POST', `/projects/${p}/invitations`, a.token, { email: `n-${++seq}${DOMAIN}`, role: 'owner' }),
        await call('POST', `/projects/${p}/invitations/${owners.id}/resend`, a.token),
        await call('DELETE', `/projects/${p}/invitations/${owners.id}`, a.token),
      ]) {
        expect(res.status).toBe(403);
        expect(res.text).toContain(ROLE_REFUSAL);
      }
      expect((await call('POST', `/projects/${p}/invitations`, m.token, { email: `n-${++seq}${DOMAIN}` })).status).toBe(
        403,
      );
      expect((await rows(p)).length).toBe(before);
    });

    it('writes no invite and no entry when the log write fails', async () => {
      const x = await person('x');
      const p = await project(x);
      const email = `fail-${++seq}${DOMAIN}`;
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      const res = await call('POST', `/projects/${p}/invitations`, x.token, { email, role: 'member' });
      expect(res.status).toBe(500);
      expect(await ds.query(`SELECT 1 FROM project_invitations WHERE project_id = $1`, [p])).toHaveLength(0);
      expect(await rows(p)).toHaveLength(0);
    });

    it('adds no member when the accept entry fails', async () => {
      const x = await person('x');
      const p = await project(x);
      const invitee = await person('invitee');
      const sent = await invite(x, p, invitee.email);
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      const res = await call('POST', '/invitations/accept', invitee.token, { token: sent.token });
      expect(res.status).toBe(500);
      expect(await ds.query(`SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`, [p, invitee.id])).toHaveLength(0);
      const [inv] = await ds.query(`SELECT accepted_at FROM project_invitations WHERE id = $1`, [sent.id]);
      expect(inv.accepted_at).toBeNull();
      expect((await rows(p)).map((r) => r.action)).toEqual(['member.invited']);
    });
  });

  describe('members', () => {
    it('logs a role change with from and to, and nothing for the same role again', async () => {
      const [x, m] = [await person('x'), await person('m')];
      const p = await project(x, [[m, 'member']]);

      expect((await call('PATCH', `/projects/${p}/members/${m.id}`, x.token, { role: 'admin' })).status).toBe(200);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'member.role_changed',
        ...byUser(x),
        ...memberTarget(m),
        details: { from: 'member', to: 'admin' },
      });

      expect((await call('PATCH', `/projects/${p}/members/${m.id}`, x.token, { role: 'admin' })).status).toBe(200);
      expect(await rows(p)).toHaveLength(1);
    });

    it('logs a removal, and the removed person keeps their label on their earlier entries', async () => {
      const [x, a] = [await person('x'), await person('a')];
      const p = await project(x, [[a, 'admin']]);
      await invite(a, p, `by-a-${++seq}${DOMAIN}`);
      const [earlier] = await rows(p);
      expect(earlier).toMatchObject({ actor_user_id: a.id, actor_label: a.label });

      expect((await call('DELETE', `/projects/${p}/members/${a.id}`, x.token)).status).toBe(200);
      expect(await onlyNew(p, 1)).toEqual({
        action: 'member.removed',
        ...byUser(x),
        ...memberTarget(a),
        details: null,
      });
      // Their account renamed since, too: the entry says who they were then.
      await ds.query(`UPDATE users SET name = 'Renamed later' WHERE id = $1`, [a.id]);
      const after = await rows(p);
      expect(after[0]).toMatchObject({ actor_user_id: a.id, actor_label: a.label });
      expect(after.filter((r) => r.actor_user_id === a.id)).toHaveLength(1);
    });

    it('logs a member leaving, with themselves as actor and target', async () => {
      const [x, m] = [await person('x'), await person('m')];
      const p = await project(x, [[m, 'member']]);
      expect((await call('POST', `/projects/${p}/leave`, m.token)).status).toBe(200);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'member.left',
        ...byUser(m),
        ...memberTarget(m),
        details: null,
      });
    });

    it('logs nothing for a refused change: an admin on an owner (403), the last owner (409)', async () => {
      const [x, a, o] = [await person('x'), await person('a'), await person('o')];
      const p = await project(x, [[a, 'admin'], [o, 'owner']]);
      for (const res of [
        await call('PATCH', `/projects/${p}/members/${o.id}`, a.token, { role: 'member' }),
        await call('DELETE', `/projects/${p}/members/${o.id}`, a.token),
      ]) {
        expect(res.status).toBe(403);
        expect(res.text).toContain(ROLE_REFUSAL);
      }

      // O the only owner, and not the billing owner: leaving and demotion are the last owner's 409.
      await ds.query(`UPDATE project_members SET role = 'admin' WHERE project_id = $1 AND user_id = $2`, [p, x.id]);
      await ds.query(`UPDATE projects SET owner_id = $2 WHERE id = $1`, [p, (await person('z')).id]);
      for (const res of [
        await call('POST', `/projects/${p}/leave`, o.token),
        await call('PATCH', `/projects/${p}/members/${o.id}`, o.token, { role: 'admin' }),
      ]) {
        expect(res.status).toBe(409);
        expect(res.text).toContain(LAST_OWNER);
      }
      expect(await rows(p)).toHaveLength(0);
    });

    it('rolls the role change back when the log write fails', async () => {
      const [x, m] = [await person('x'), await person('m')];
      const p = await project(x, [[m, 'member']]);
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      const res = await call('PATCH', `/projects/${p}/members/${m.id}`, x.token, { role: 'admin' });
      expect(res.status).toBe(500);
      const [row] = await ds.query(`SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`, [p, m.id]);
      expect(row.role).toBe('member');
      expect(await rows(p)).toHaveLength(0);
    });

    it('keeps the member when the removal entry fails', async () => {
      const [x, m] = [await person('x'), await person('m')];
      const p = await project(x, [[m, 'member']]);
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('DELETE', `/projects/${p}/members/${m.id}`, x.token)).status).toBe(500);
      expect(await ds.query(`SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`, [p, m.id])).toHaveLength(1);
      expect(await rows(p)).toHaveLength(0);
    });
  });

  describe('billing transfer', () => {
    it('logs an offer, a cancel, a decline and an accept, with the receiver', async () => {
      const [x, r] = [await person('x'), await person('r')];
      const p = await project(x, [[r, 'owner']]);
      const toR = { ...memberTarget(r), details: { toUserId: r.id } };

      expect((await call('POST', `/projects/${p}/billing-transfer`, x.token, { toUserId: r.id })).status).toBe(200);
      expect(await onlyNew(p, 0)).toEqual({ action: 'billing.transfer_offered', ...byUser(x), ...toR });

      expect((await call('DELETE', `/projects/${p}/billing-transfer`, x.token)).status).toBe(200);
      expect(await onlyNew(p, 1)).toEqual({ action: 'billing.transfer_cancelled', ...byUser(x), ...toR });
      // Nothing left to cancel: nothing changes, nothing is logged.
      expect((await call('DELETE', `/projects/${p}/billing-transfer`, x.token)).status).toBe(200);
      expect(await rows(p)).toHaveLength(2);

      await call('POST', `/projects/${p}/billing-transfer`, x.token, { toUserId: r.id });
      expect((await call('POST', `/projects/${p}/billing-transfer/decline`, r.token)).status).toBe(200);
      expect(await onlyNew(p, 3)).toEqual({ action: 'billing.transfer_declined', ...byUser(r), ...toR });

      await call('POST', `/projects/${p}/billing-transfer`, x.token, { toUserId: r.id });
      expect((await call('POST', `/projects/${p}/billing-transfer/accept`, r.token)).status).toBe(200);
      expect(await onlyNew(p, 5)).toEqual({ action: 'billing.transfer_accepted', ...byUser(r), ...toR });
      expect((await ds.query(`SELECT owner_id FROM projects WHERE id = $1`, [p]))[0].owner_id).toBe(r.id);
    });

    it('logs nothing for a refused offer or accept', async () => {
      const [x, r, a] = [await person('x'), await person('r'), await person('a')];
      const p = await project(x, [[r, 'owner'], [a, 'admin']]);
      expect((await call('POST', `/projects/${p}/billing-transfer`, r.token, { toUserId: x.id })).status).toBe(403);
      expect((await call('POST', `/projects/${p}/billing-transfer/accept`, r.token)).status).toBe(400);
      expect((await call('POST', `/projects/${p}/billing-transfer/decline`, a.token)).status).toBe(400);
      expect(await rows(p)).toHaveLength(0);
    });

    it('keeps the billing owner when the accept entry fails', async () => {
      const [x, r] = [await person('x'), await person('r')];
      const p = await project(x, [[r, 'owner']]);
      await call('POST', `/projects/${p}/billing-transfer`, x.token, { toUserId: r.id });
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('POST', `/projects/${p}/billing-transfer/accept`, r.token)).status).toBe(500);
      const [row] = await ds.query(`SELECT owner_id, pending_billing_owner_id FROM projects WHERE id = $1`, [p]);
      expect(row).toEqual({ owner_id: x.id, pending_billing_owner_id: r.id });
      expect((await rows(p)).map((e) => e.action)).toEqual(['billing.transfer_offered']);
    });
  });

  describe('project', () => {
    it('logs a rename with the old and new name, and nothing for the same name', async () => {
      const x = await person('x');
      const p = await project(x, [], 'Before');
      expect((await call('PATCH', `/projects/${p}`, x.token, { name: 'After' })).status).toBe(200);
      expect(await onlyNew(p, 0)).toEqual({
        action: 'project.renamed',
        ...byUser(x),
        target_type: 'project',
        target_id: p,
        target_label: 'After',
        details: { from: 'Before', to: 'After' },
      });
      expect((await call('PATCH', `/projects/${p}`, x.token, { name: 'After' })).status).toBe(200);
      expect(await rows(p)).toHaveLength(1);
    });

    it('logs changed app-link fields by name only, and nothing when they are the same', async () => {
      const x = await person('x');
      const p = await project(x, [], 'Links');
      const body = { domain: 'links.example.com', iosBundleId: 'com.example.app', webFallbackUrl: 'https://example.com/x' };
      expect((await call('PATCH', `/projects/${p}`, x.token, body)).status).toBe(200);
      const row = await onlyNew(p, 0);
      expect(row).toEqual({
        action: 'project.app_links_changed',
        ...byUser(x),
        target_type: 'project',
        target_id: p,
        target_label: 'Links',
        details: { fields: ['domain', 'iosBundleId', 'webFallbackUrl'] },
      });
      expect(JSON.stringify(row)).not.toContain('links.example.com');

      // The same values again, and the same name: nothing.
      expect((await call('PATCH', `/projects/${p}`, x.token, { ...body, name: 'Links' })).status).toBe(200);
      expect(await rows(p)).toHaveLength(1);

      // A rename and a link change in one request: one entry each. They share the
      // transaction's now(), so their order in the table is the ids' and not asserted.
      expect((await call('PATCH', `/projects/${p}`, x.token, { name: 'Links 2', domain: 'two.example.com' })).status).toBe(
        200,
      );
      expect((await rows(p)).slice(1).map((r) => [r.action, r.details]).sort()).toEqual([
        ['project.app_links_changed', { fields: ['domain'] }],
        ['project.renamed', { from: 'Links', to: 'Links 2' }],
      ]);
    });

    it('logs nothing for a refused update', async () => {
      const [x, a] = [await person('x'), await person('a')];
      const p = await project(x, [[a, 'admin']], 'Mine');
      const res = await call('PATCH', `/projects/${p}`, a.token, { name: 'Theirs' });
      expect(res.status).toBe(403);
      expect(await rows(p)).toHaveLength(0);
    });

    it('keeps the old name when the rename entry fails', async () => {
      const x = await person('x');
      const p = await project(x, [], 'Before');
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('PATCH', `/projects/${p}`, x.token, { name: 'After' })).status).toBe(500);
      expect((await ds.query(`SELECT name FROM projects WHERE id = $1`, [p]))[0].name).toBe('Before');
      expect(await rows(p)).toHaveLength(0);
    });

    it('keeps project.deleted after the project row is gone', async () => {
      const x = await person('x');
      const p = await project(x, [], 'Doomed');
      expect((await call('DELETE', `/projects/${p}`, x.token)).status).toBe(200);
      expect(await ds.query(`SELECT 1 FROM projects WHERE id = $1`, [p])).toHaveLength(0);
      expect(await rows(p)).toEqual([
        {
          action: 'project.deleted',
          ...byUser(x),
          target_type: 'project',
          target_id: p,
          target_label: 'Doomed',
          details: null,
        },
      ]);
    });

    it('does not delete the project when the entry fails', async () => {
      const x = await person('x');
      const p = await project(x, [], 'Kept');
      jest.spyOn(activity, 'record').mockRejectedValueOnce(new Error('log down'));
      expect((await call('DELETE', `/projects/${p}`, x.token)).status).toBe(500);
      expect(await ds.query(`SELECT 1 FROM projects WHERE id = $1`, [p])).toHaveLength(1);
      expect(await rows(p)).toHaveLength(0);
    });
  });
});

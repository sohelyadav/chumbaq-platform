import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp } from '../../test-support/sweep-fixtures';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminTenantsService } from '../admin/admin-tenants.service';
import { AdminAuditLogEntity } from '../admin/entities/admin-audit-log.entity';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import {
  BILLING_OFFER_GONE,
  BILLING_SUSPENDED,
  BILLING_TARGET_NOT_OWNER,
  BillingTransferService,
} from './billing-transfer.service';
import { MOVE_BILLING_FIRST } from './project-members.service';
import { ROLE_REFUSAL, type ProjectRole } from './project-permissions';
import { SEAT_LIMIT_MESSAGE, SeatsService } from './seats.service';

/**
 * The two-step billing transfer over HTTP against the real app and database: offer,
 * accept, cancel, and every refusal at accept (expired, receiver demoted, suspended,
 * project limit, seat limit, no recent sign-in).
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@billing-transfer-int.test';

describe('Billing transfer (integration)', () => {
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
    staleToken: string;
  }

  const person = async (label: string): Promise<Person> => {
    const email = `${label}-${++seq}${DOMAIN}`;
    const id = (await ds.getRepository(UserEntity).save({ email, name: label, passwordHash: 'x' })).id;
    const now = Math.floor(Date.now() / 1000);
    const sign = (authTime: number) => jwt.signAsync({ sub: id, email, type: 'access', auth_time: authTime });
    return { id, email, token: await sign(now), staleToken: await sign(now - 3600) };
  };

  const project = async (billing: Person, others: Array<[Person, ProjectRole]> = []): Promise<string> => {
    const id = (await ds.getRepository(ProjectEntity).save({ name: 'billed', ownerId: billing.id })).id;
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

  const ownerOf = async (projectId: string) =>
    (await ds.getRepository(ProjectEntity).findOneByOrFail({ id: projectId })).ownerId;
  const pendingOf = async (projectId: string) =>
    (await ds.getRepository(ProjectEntity).findOneByOrFail({ id: projectId })).pendingBillingOwnerId;

  /** X bills the project; R is another owner; X offers it to R. */
  const offered = async (extra: Array<[Person, ProjectRole]> = []) => {
    const [x, r] = [await person('x'), await person('r')];
    const p = await project(x, [[r, 'owner'], ...extra]);
    const res = await call('POST', `/projects/${p}/billing-transfer`, x.token, { toUserId: r.id });
    expect(res.status).toBe(200);
    return { x, r, p };
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

  it('moves the project to the receiver\'s account on accept, as the admin tenant view shows', async () => {
    const { x, r, p } = await offered();
    const listed = await call('GET', `/projects/${p}/members`, r.token);
    expect(listed.json.data.billingOffer).toEqual({
      toUserId: r.id,
      offeredAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    const { offeredAt, expiresAt } = listed.json.data.billingOffer;
    expect(Date.parse(expiresAt) - Date.parse(offeredAt)).toBe(7 * 24 * 3600 * 1000);
    // Nothing moves until the receiver accepts.
    expect(await ownerOf(p)).toBe(x.id);

    const accepted = await call('POST', `/projects/${p}/billing-transfer/accept`, r.token);
    expect(accepted.status).toBe(200);
    expect(accepted.json.data.billingOffer).toBeNull();
    expect(accepted.json.data.members.find((m: { userId: string }) => m.userId === r.id).isBillingOwner).toBe(true);
    expect(await ownerOf(p)).toBe(r.id);
    expect(await pendingOf(p)).toBeNull();

    // A tenant is an account and the projects it bills for.
    const config = new ConfigService({ projects: { maxPerAccount: 10 } });
    const audit = ds.getRepository(AdminAuditLogEntity);
    const tenants = new AdminTenantsService(
      ds.getRepository(UserEntity),
      audit,
      new AdminAuditService(audit),
      { factorResetCancelled: () => undefined } as never,
      new SeatsService(ds, config),
      config,
    );
    expect((await tenants.findOne(r.id)).projects.map((pr) => pr.id)).toContain(p);
    expect((await tenants.findOne(x.id)).projects.map((pr) => pr.id)).not.toContain(p);

    // X is still an owner, and now an ordinary one that can be demoted; R cannot leave.
    expect((await call('PATCH', `/projects/${p}/members/${x.id}`, r.token, { role: 'admin' })).status).toBe(200);
    const leave = await call('POST', `/projects/${p}/leave`, r.token);
    expect(leave.status).toBe(409);
    expect(leave.text).toContain(MOVE_BILLING_FIRST);
  });

  it('lets only the billing owner offer or cancel, and only to another owner', async () => {
    const [x, o, a] = [await person('x'), await person('o'), await person('a')];
    const p = await project(x, [[o, 'owner'], [a, 'admin']]);
    const byOwner = await call('POST', `/projects/${p}/billing-transfer`, o.token, { toUserId: x.id });
    expect(byOwner.status).toBe(403);
    expect(byOwner.text).toContain(ROLE_REFUSAL);
    const byAdmin = await call('POST', `/projects/${p}/billing-transfer`, a.token, { toUserId: o.id });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.text).toContain(ROLE_REFUSAL);
    for (const to of [a.id, x.id]) {
      const res = await call('POST', `/projects/${p}/billing-transfer`, x.token, { toUserId: to });
      expect(res.status).toBe(400);
      expect(res.text).toContain(BILLING_TARGET_NOT_OWNER);
    }
    expect(await pendingOf(p)).toBeNull();

    expect((await call('POST', `/projects/${p}/billing-transfer`, x.token, { toUserId: o.id })).status).toBe(200);
    expect((await call('DELETE', `/projects/${p}/billing-transfer`, o.token)).status).toBe(403);
    expect(await pendingOf(p)).toBe(o.id);
    expect((await call('DELETE', `/projects/${p}/billing-transfer`, x.token)).status).toBe(200);
    expect(await pendingOf(p)).toBeNull();
    const gone = await call('POST', `/projects/${p}/billing-transfer/accept`, o.token);
    expect(gone.status).toBe(400);
    expect(gone.text).toContain(BILLING_OFFER_GONE);
  });

  it('needs a recent sign-in to offer and to accept', async () => {
    const [x, r] = [await person('x'), await person('r')];
    const p = await project(x, [[r, 'owner']]);
    const offer = await call('POST', `/projects/${p}/billing-transfer`, x.staleToken, { toUserId: r.id });
    expect(offer.status).toBe(403);
    expect(offer.text).toContain(REAUTH_REQUIRED_MESSAGE);
    await call('POST', `/projects/${p}/billing-transfer`, x.token, { toUserId: r.id });
    const accept = await call('POST', `/projects/${p}/billing-transfer/accept`, r.staleToken);
    expect(accept.status).toBe(403);
    expect(accept.text).toContain(REAUTH_REQUIRED_MESSAGE);
    expect(await ownerOf(p)).toBe(x.id);
  });

  it('judges the 7 days by the database clock: one second past is refused and not listed', async () => {
    const { x, r, p } = await offered();
    await ds.query(
      `UPDATE projects SET pending_billing_offered_at = now() - interval '7 days' - interval '1 second' WHERE id = $1`,
      [p],
    );
    expect((await call('GET', `/projects/${p}/members`, x.token)).json.data.billingOffer).toBeNull();
    const res = await call('POST', `/projects/${p}/billing-transfer/accept`, r.token);
    expect(res.status).toBe(400);
    expect(res.text).toContain(BILLING_OFFER_GONE);
    expect(await ownerOf(p)).toBe(x.id);
  });

  it('accepts an offer 6 days 23 hours old, listing the expiry the database computed', async () => {
    const { x, r, p } = await offered();
    await ds.query(
      `UPDATE projects SET pending_billing_offered_at = now() - interval '6 days 23 hours' WHERE id = $1`,
      [p],
    );
    const listed = (await call('GET', `/projects/${p}/members`, x.token)).json.data.billingOffer;
    expect(listed.toUserId).toBe(r.id);
    expect(Date.parse(listed.expiresAt) - Date.parse(listed.offeredAt)).toBe(7 * 24 * 3600 * 1000);
    const res = await call('POST', `/projects/${p}/billing-transfer/accept`, r.token);
    expect(res.status).toBe(200);
    expect(await ownerOf(p)).toBe(r.id);
  });

  it('lets the receiver decline: the offer goes, the billing owner stays', async () => {
    const { x, r, p } = await offered();
    const res = await call('POST', `/projects/${p}/billing-transfer/decline`, r.token);
    expect(res.status).toBe(200);
    expect(res.json.data.billingOffer).toBeNull();
    expect(await pendingOf(p)).toBeNull();
    expect(await ownerOf(p)).toBe(x.id);
    // Nothing left to decline or accept.
    const again = await call('POST', `/projects/${p}/billing-transfer/decline`, r.token);
    expect(again.status).toBe(400);
    expect(again.text).toContain(BILLING_OFFER_GONE);
    expect((await call('POST', `/projects/${p}/billing-transfer/accept`, r.token)).status).toBe(400);
  });

  it('refuses a decline from anyone but the receiver, and leaves the offer', async () => {
    const o = await person('o');
    const { x, r, p } = await offered([[o, 'owner']]);
    for (const who of [o, x]) {
      const res = await call('POST', `/projects/${p}/billing-transfer/decline`, who.token);
      expect(res.status).toBe(400);
      expect(res.text).toContain(BILLING_OFFER_GONE);
    }
    expect(await pendingOf(p)).toBe(r.id);
    expect(await ownerOf(p)).toBe(x.id);
    const outsider = await person('outsider');
    expect((await call('POST', `/projects/${p}/billing-transfer/decline`, outsider.token)).status).toBe(404);
    expect(await pendingOf(p)).toBe(r.id);
  });

  it('clears the offer when the receiver is demoted, and refuses their accept', async () => {
    const { x, r, p } = await offered();
    expect((await call('PATCH', `/projects/${p}/members/${r.id}`, x.token, { role: 'admin' })).status).toBe(200);
    expect(await pendingOf(p)).toBeNull();
    const res = await call('POST', `/projects/${p}/billing-transfer/accept`, r.token);
    // No longer an owner, so the route's project.admin refuses them first.
    expect(res.status).toBe(403);
    expect(res.text).toContain(ROLE_REFUSAL);
    // Made owner again, the old offer stays gone.
    expect((await call('PATCH', `/projects/${p}/members/${r.id}`, x.token, { role: 'owner' })).status).toBe(200);
    const again = await call('POST', `/projects/${p}/billing-transfer/accept`, r.token);
    expect(again.status).toBe(400);
    expect(again.text).toContain(BILLING_OFFER_GONE);
    expect(await ownerOf(p)).toBe(x.id);
  });

  it('refuses accept while either account is suspended', async () => {
    const { x, r, p } = await offered();
    await ds.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [x.id]);
    const res = await call('POST', `/projects/${p}/billing-transfer/accept`, r.token);
    expect(res.status).toBe(409);
    expect(res.text).toContain(BILLING_SUSPENDED);
    await ds.query(`UPDATE users SET suspended_at = NULL WHERE id = $1`, [x.id]);

    // A suspended receiver cannot sign in at all; the service refuses them anyway.
    await ds.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [r.id]);
    await expect(
      app.get(BillingTransferService).acceptBilling({ userId: r.id, email: r.email, isSuperAdmin: false }, p, { ipAddress: null, userAgent: null }),
    ).rejects.toThrow(BILLING_SUSPENDED);
    expect(await ownerOf(p)).toBe(x.id);
  });

  it('refuses accept when the receiver is at their project limit', async () => {
    const { x, r, p } = await offered();
    await project(r);
    await ds.query(`UPDATE users SET project_limit = 1 WHERE id = $1`, [r.id]);
    const res = await call('POST', `/projects/${p}/billing-transfer/accept`, r.token);
    expect(res.status).toBe(403);
    expect(res.text).toContain('You can have up to 1 projects. Delete one or contact support to raise the limit.');
    expect(await ownerOf(p)).toBe(x.id);

    await ds.query(`UPDATE users SET project_limit = 2 WHERE id = $1`, [r.id]);
    expect((await call('POST', `/projects/${p}/billing-transfer/accept`, r.token)).status).toBe(200);
    expect(await ownerOf(p)).toBe(r.id);
  });

  it('refuses accept when the project\'s people would take the receiver over their seat limit', async () => {
    const [m1, m2] = [await person('m1'), await person('m2')];
    const { x, r, p } = await offered([[m1, 'member'], [m2, 'admin']]);
    // R's account would hold R, X, M1 and M2.
    await ds.query(`UPDATE users SET seat_limit = 3 WHERE id = $1`, [r.id]);
    const res = await call('POST', `/projects/${p}/billing-transfer/accept`, r.token);
    expect(res.status).toBe(403);
    expect(res.text).toContain(SEAT_LIMIT_MESSAGE);
    expect(await ownerOf(p)).toBe(x.id);

    await ds.query(`UPDATE users SET seat_limit = 4 WHERE id = $1`, [r.id]);
    expect((await call('POST', `/projects/${p}/billing-transfer/accept`, r.token)).status).toBe(200);
    expect(await ownerOf(p)).toBe(r.id);
  });

  it('never both moves billing and demotes the receiver when the two race', async () => {
    for (let round = 0; round < 5; round++) {
      const { x, r, p } = await offered();
      const [accept, demote] = await Promise.all([
        call('POST', `/projects/${p}/billing-transfer/accept`, r.token),
        call('PATCH', `/projects/${p}/members/${r.id}`, x.token, { role: 'admin' }),
      ]);
      const owner = await ownerOf(p);
      const role = (
        await ds.query(`SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`, [p, r.id])
      )[0].role;
      // The billing owner is always an owner member, whichever ran first.
      if (owner === r.id) {
        expect({ round, accept: accept.status, demote: demote.status, role }).toEqual({
          round,
          accept: 200,
          demote: 409,
          role: 'owner',
        });
      } else {
        expect(owner).toBe(x.id);
        expect({ round, demote: demote.status, role }).toEqual({ round, demote: 200, role: 'admin' });
        expect([400, 403]).toContain(accept.status);
      }
    }
  }, 60000);
});

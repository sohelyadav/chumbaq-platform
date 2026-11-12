import { createHash, randomUUID } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { setSuperAdmin } from '../../scripts/super-admin';
import { revokeAllStaffSessions, StaffSessionsService } from '../auth/staff-sessions.service';
import { STAFF_SESSION_ENDED_MESSAGE } from '../staff-auth/staff-messages';
import { ImpersonationHandoffsService } from './impersonation-handoffs.service';
import { IMPERSONATION_LINK_INVALID_MESSAGE } from './impersonation-messages';

const DOMAIN = '@impersonation-handoffs-int.test';
const REASON = 'Customer asked why a campaign did not send';

/**
 * View-as across the two APIs over real HTTP: the admin API makes the code, the customer
 * API spends it and issues the read-only token.
 */
describe('Impersonation handoff (integration)', () => {
  let ds: DataSource;
  let customer: BootedApp;
  let admin: BootedApp;

  const send = async (
    base: string,
    method: string,
    path: string,
    { token, body, client = true }: { token?: string; body?: unknown; client?: boolean } = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(client ? { 'x-chumbaq-client': 'web' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const makeUser = async (name: string, { staff = false, suspended = false } = {}) => {
    const [row] = await ds.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin, suspended_at)
       VALUES ($1, 'x', $2, $3, $4) RETURNING id, email, session_version`,
      [`${name}-${randomUUID().slice(0, 8)}${DOMAIN}`, name, staff, suspended ? new Date() : null],
    );
    return { id: row.id as string, email: row.email as string, sessionVersion: row.session_version as number };
  };

  /** A staff member signed in to the admin app, a tenant with a project, and a fresh code. */
  const scene = async () => {
    const staff = await makeUser('staff', { staff: true });
    const session = await issueStaffSessionForTest(ds, staff);
    const tenant = await makeUser('tenant');
    const [project] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('Tenant app', $1) RETURNING id`, [
      tenant.id,
    ]);
    const projectId = project.id as string;
    await addOwnerMember(ds, projectId, tenant.id);
    const created = await send(admin.base, 'POST', `/api/admin/tenants/${tenant.id}/impersonate`, {
      token: session.accessToken,
      body: { reason: REASON },
    });
    expect(created.status).toBe(200);
    const code = /#code=(.*)$/.exec(created.body.data.url)?.[1] as string;
    return { staff, session, tenant, projectId, created: created.body.data, code };
  };

  const exchange = (code: string, opts: { client?: boolean } = {}) =>
    send(customer.base, 'POST', '/api/auth/impersonation/exchange', { body: { code }, ...opts });

  const expectInvalid = (reply: { status: number; body: any }) => {
    expect(reply.status).toBe(400);
    expect(reply.body.message).toBe(IMPERSONATION_LINK_INVALID_MESSAGE);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    customer = await bootIntApp('customer');
    admin = await bootIntApp('admin');
  }, 120000);

  afterAll(async () => {
    await customer?.app.close();
    await admin?.app.close();
    await ds.query(`DELETE FROM admin_audit_logs WHERE target_label LIKE $1 OR actor_email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
  });

  it('makes a one-minute code, kept only as a hash, and links to the customer app with it in the fragment', async () => {
    const { tenant, created, code, staff } = await scene();
    expect(created.url.startsWith(`${new URL('/impersonate', process.env.APP_URL).toString()}#code=`)).toBe(true);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.accessToken).toBeUndefined();
    expect(Math.abs(new Date(created.expiresAt).getTime() - Date.now() - 60_000)).toBeLessThan(2_000);
    expect(created.tenant).toEqual({ id: tenant.id, email: tenant.email, name: 'tenant' });

    const [row] = await ds.query(`SELECT * FROM impersonation_handoffs WHERE target_id = $1`, [tenant.id]);
    expect(row.code_hash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(code);

    const [audit] = await ds.query(
      `SELECT * FROM admin_audit_logs WHERE target_id = $1 AND action = 'tenant.impersonated'`,
      [tenant.id],
    );
    expect(audit).toMatchObject({ actor_id: staff.id, reason: REASON });
    expect(audit.metadata.handoffId).toBe(row.id);
    expect(JSON.stringify(audit)).not.toContain(code);
  });

  it('exchanges once for the read-only 30-minute session', async () => {
    const { tenant, code, staff, projectId } = await scene();
    const reply = await exchange(code);
    expect(reply.status).toBe(200);
    const session = reply.body.data;
    expect(session.tenant).toEqual({ id: tenant.id, email: tenant.email, name: 'tenant' });
    expect(Math.abs(new Date(session.expiresAt).getTime() - Date.now() - 30 * 60_000)).toBeLessThan(5_000);

    const projects = await send(customer.base, 'GET', '/api/projects', { token: session.accessToken });
    expect(projects.status).toBe(200);
    expect(projects.body.data.map((p: { id: string; name: string }) => [p.id, p.name])).toEqual([[projectId, 'Tenant app']]);
    const write = await send(customer.base, 'POST', '/api/projects', { token: session.accessToken, body: { name: 'x' } });
    expect(write.status).toBe(403);
    expect(write.body.message).toBe('Impersonation sessions are read-only');

    const actions = await ds.query(
      `SELECT action, metadata FROM admin_audit_logs WHERE target_id = $1 AND actor_id = $2 ORDER BY created_at`,
      [tenant.id, staff.id],
    );
    expect(actions.map((a: { action: string }) => a.action)).toEqual(['tenant.impersonated', 'tenant.impersonation_exchanged']);

    expectInvalid(await exchange(code));
  });

  it('leaves out a project the user is a member of but another account is billed for', async () => {
    const { tenant, code, projectId } = await scene();
    const other = await makeUser('other-billing');
    const [second] = await ds.query(
      `INSERT INTO projects (name, owner_id) VALUES ('Other account app', $1) RETURNING id`,
      [other.id],
    );
    await addOwnerMember(ds, second.id, other.id);
    await addOwnerMember(ds, second.id, tenant.id, 'admin');

    const reply = await exchange(code);
    expect(reply.status).toBe(200);
    const token = reply.body.data.accessToken;
    const list = await send(customer.base, 'GET', '/api/projects', { token });
    expect(list.status).toBe(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([projectId]);
    const detail = await send(customer.base, 'GET', `/api/projects/${second.id}`, { token });
    expect(detail.status).toBe(404);
    expect(detail.body.message).toBe('Project not found');
  });

  describe("shows the view-as in the tenant's project activity", () => {
    const viewedAs = (projectId: string) =>
      ds.query(`SELECT * FROM project_activity WHERE project_id = $1 AND action = 'staff.viewed_as'`, [projectId]);

    it('once in each project the tenant is billed for, and not in one they are only a member of', async () => {
      const { tenant, code, staff, projectId } = await scene();
      const STAFF_NAME = 'Zephyrine Quillfeather';
      await ds.query(`UPDATE users SET name = $2 WHERE id = $1`, [staff.id, STAFF_NAME]);
      const [second] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('Second app', $1) RETURNING id`, [
        tenant.id,
      ]);
      await addOwnerMember(ds, second.id, tenant.id);
      const other = await makeUser('other-billing');
      const [joined] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('Joined app', $1) RETURNING id`, [
        other.id,
      ]);
      await addOwnerMember(ds, joined.id, other.id);
      await addOwnerMember(ds, joined.id, tenant.id, 'owner');

      expect((await exchange(code)).status).toBe(200);

      for (const id of [projectId, second.id as string]) {
        const rows = await viewedAs(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          actor_kind: 'staff',
          actor_user_id: null,
          actor_label: 'Chumbaq support',
          target_type: null,
          target_id: null,
          target_label: null,
          details: null,
          ip_address: null,
          user_agent: null,
          country: null,
        });
        const text = JSON.stringify(rows[0]);
        for (const secret of [staff.id, staff.email, STAFF_NAME, REASON, code]) expect(text).not.toContain(secret);
      }
      expect(await viewedAs(joined.id)).toEqual([]);
      expect(await ds.query(`SELECT 1 FROM project_activity WHERE project_id = $1`, [joined.id])).toEqual([]);
    });

    it('not again for a replayed code', async () => {
      const { code, projectId } = await scene();
      expect((await exchange(code)).status).toBe(200);
      expectInvalid(await exchange(code));
      expect(await viewedAs(projectId)).toHaveLength(1);
    });

    it.each([
      ['a code past its minute', (s: { tenant: { id: string } }) =>
        ds.query(`UPDATE impersonation_handoffs SET expires_at = now() - interval '1 second' WHERE target_id = $1`, [s.tenant.id])],
      ['a code refused on its recheck (staff revoked)', (s: { staff: { id: string } }) =>
        ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [s.staff.id])],
      ['a code refused on its recheck (tenant suspended)', (s: { tenant: { id: string } }) =>
        ds.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [s.tenant.id])],
    ])('not at all for %s', async (_kind, breakIt) => {
      const s = await scene();
      await (breakIt as (x: typeof s) => Promise<unknown>)(s);
      expectInvalid(await exchange(s.code));
      expect(await viewedAs(s.projectId)).toEqual([]);
    });
  });

  it('gives one of two simultaneous exchanges the session', async () => {
    const { code } = await scene();
    const replies = await Promise.all([exchange(code), exchange(code)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 400]);
    expectInvalid(replies.find((r) => r.status === 400) as { status: number; body: any });
  });

  describe('refuses with the same answer', () => {
    it('a code past its minute', async () => {
      const { code, tenant } = await scene();
      await ds.query(`UPDATE impersonation_handoffs SET expires_at = now() - interval '1 second' WHERE target_id = $1`, [tenant.id]);
      expectInvalid(await exchange(code));
    });

    it('a code whose staff member was revoked in between', async () => {
      const { code, staff } = await scene();
      await setSuperAdmin(ds, staff.email, false);
      expectInvalid(await exchange(code));
    });

    it('a code whose staff member lost the flag without the CLI', async () => {
      const { code, staff } = await scene();
      await ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [staff.id]);
      expectInvalid(await exchange(code));
    });

    it('a code whose staff session was signed out in between', async () => {
      const { code, session } = await scene();
      expect(
        (await send(admin.base, 'POST', '/api/staff/auth/session/logout', { token: session.accessToken })).status,
      ).toBe(204);
      expectInvalid(await exchange(code));
    });

    it('a code whose staff member signed out everywhere in between', async () => {
      // Only the session version moves: the staff session row stays live, so the
      // version comparison at exchange is what refuses it, before any token is minted.
      const { code, staff, tenant } = await scene();
      await ds.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [staff.id]);
      expectInvalid(await exchange(code));
      const exchanged = await ds.query(
        `SELECT 1 FROM admin_audit_logs WHERE target_id = $1 AND action = 'tenant.impersonation_exchanged'`,
        [tenant.id],
      );
      expect(exchanged).toEqual([]);
    });

    it('a code for a tenant suspended in between', async () => {
      const { code, tenant } = await scene();
      await ds.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [tenant.id]);
      expectInvalid(await exchange(code));
    });

    it('a code that was never made', async () => {
      expectInvalid(await exchange('a'.repeat(43)));
    });
  });

  describe('a spent code that fails its recheck', () => {
    const refusals = (tenantId: string) =>
      ds.query(
        `SELECT actor_id, metadata, ip_address FROM admin_audit_logs
          WHERE target_id = $1 AND action = 'tenant.impersonation_refused'`,
        [tenantId],
      );
    const handoffId = async (tenantId: string) =>
      (await ds.query(`SELECT id FROM impersonation_handoffs WHERE target_id = $1`, [tenantId]))[0].id as string;

    it.each([
      ['actor_not_staff', (s: { staff: { id: string } }) =>
        ds.query(`UPDATE users SET is_super_admin = false WHERE id = $1`, [s.staff.id])],
      ['actor_session_version', (s: { staff: { id: string } }) =>
        ds.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [s.staff.id])],
      // Straight in the table, so the code survives to be spent; every service path deletes it.
      ['staff_session_ended', (s: { session: { sessionId: string } }) =>
        ds.query(`UPDATE staff_sessions SET revoked_at = now() WHERE id = $1`, [s.session.sessionId])],
      ['tenant_suspended', (s: { tenant: { id: string } }) =>
        ds.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [s.tenant.id])],
    ])('is audited as refused (%s), with the same answer', async (reason, breakIt) => {
      const s = await scene();
      const id = await handoffId(s.tenant.id);
      await (breakIt as (x: typeof s) => Promise<unknown>)(s);
      expectInvalid(await exchange(s.code));
      const rows = await refusals(s.tenant.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(s.staff.id);
      expect(rows[0].metadata).toEqual({ handoffId: id, reason });
      expect(rows[0].ip_address).toBeTruthy();
      expect(JSON.stringify(rows[0])).not.toContain(s.code);
    });

    it('is not written for a code that spends nothing', async () => {
      const { tenant, code } = await scene();
      expect((await exchange(code)).status).toBe(200);
      expectInvalid(await exchange(code));
      expect(await refusals(tenant.id)).toEqual([]);
    });
  });

  describe('unused codes go with the staff session that made them', () => {
    const unused = (staffId: string) =>
      ds.query(`SELECT staff_session_id FROM impersonation_handoffs WHERE actor_id = $1 AND used_at IS NULL`, [staffId]);

    it('on sign-out, keeping a used one as the record of a view-as that happened', async () => {
      const first = await scene();
      expect((await exchange(first.code)).status).toBe(200);
      const created = await send(admin.base, 'POST', `/api/admin/tenants/${first.tenant.id}/impersonate`, {
        token: first.session.accessToken,
        body: { reason: REASON },
      });
      expect(created.status).toBe(200);
      expect(await unused(first.staff.id)).toHaveLength(1);
      expect(
        (await send(admin.base, 'POST', '/api/staff/auth/session/logout', { token: first.session.accessToken })).status,
      ).toBe(204);
      expect(await unused(first.staff.id)).toEqual([]);
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM impersonation_handoffs WHERE actor_id = $1 AND used_at IS NOT NULL`,
        [first.staff.id],
      );
      expect(n).toBe(1);
    });

    it('on every other way a staff session is revoked', async () => {
      const sessions = customer.app.get(StaffSessionsService);
      const { staff, session } = await scene();
      // A second session of theirs, with its own code, which revoking the first keeps.
      const other = await issueStaffSessionForTest(ds, staff);
      const tenant = await makeUser('tenant2');
      expect(
        (await send(admin.base, 'POST', `/api/admin/tenants/${tenant.id}/impersonate`, {
          token: other.accessToken,
          body: { reason: REASON },
        })).status,
      ).toBe(200);

      await sessions.revoke(session.sessionId, staff.id, 'replay');
      expect((await unused(staff.id)).map((r: { staff_session_id: string }) => r.staff_session_id)).toEqual([
        other.sessionId,
      ]);

      // revokeOthers, as adding a factor does, ends the rest but not the one kept.
      const third = await issueStaffSessionForTest(ds, staff);
      await sessions.revokeOthers(staff.id, third.sessionId, 'factor_changed');
      expect(await unused(staff.id)).toEqual([]);
    });

    it('when all of them are revoked at once', async () => {
      const { staff } = await scene();
      await ds.transaction((manager) => revokeAllStaffSessions(manager, staff.id, 'factors_reset'));
      expect(await unused(staff.id)).toEqual([]);
    });
  });

  describe('a code is only made while its staff session is live', () => {
    const impersonatedAudits = (tenantId: string) =>
      ds.query(`SELECT 1 FROM admin_audit_logs WHERE target_id = $1 AND action = 'tenant.impersonated'`, [tenantId]);
    const unusedOf = (sessionId: string) =>
      ds.query(`SELECT id FROM impersonation_handoffs WHERE staff_session_id = $1 AND used_at IS NULL`, [sessionId]);

    // The guard has already passed when create() runs, so the service must check again
    // itself: each of these sessions ended (or never could) after the guard looked.
    it.each([
      ['a revoked', async (staff: { id: string; email: string; sessionVersion: number }) => {
        const s = await issueStaffSessionForTest(ds, staff);
        await ds.query(`UPDATE staff_sessions SET revoked_at = now() WHERE id = $1`, [s.sessionId]);
        return s.sessionId;
      }],
      // Unrevoked but past STAFF_SESSION_MAX_AGE: nothing revokes a session at its end,
      // so only the created_at condition refuses it.
      ['a past its absolute end', async (staff: { id: string; email: string; sessionVersion: number }) => {
        const s = await issueStaffSessionForTest(ds, staff);
        await ds.query(
          `UPDATE staff_sessions SET created_at = now() - interval '400 days', last_active_at = now() WHERE id = $1`,
          [s.sessionId],
        );
        return s.sessionId;
      }],
      ['an enrolment-only', async (staff: { id: string; email: string; sessionVersion: number }) =>
        (await issueStaffSessionForTest(ds, staff, { enrolmentOnly: true })).sessionId],
      ["someone else's", async () => {
        const other = await makeUser('otherstaff', { staff: true });
        return (await issueStaffSessionForTest(ds, other)).sessionId;
      }],
    ])('refuses on %s session, leaving no code and no audit entry', async (_kind, sessionFor) => {
      const staff = await makeUser('ending', { staff: true });
      const tenant = await makeUser('tenant');
      const sessionId = await sessionFor(staff);
      const attempt = admin.app.get(ImpersonationHandoffsService).create({
        actor: { userId: staff.id, email: staff.email, sessionId },
        targetId: tenant.id,
        reason: REASON,
        ipAddress: '127.0.0.1',
      });
      await expect(attempt).rejects.toThrow(STAFF_SESSION_ENDED_MESSAGE);
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await ds.query(`SELECT 1 FROM impersonation_handoffs WHERE target_id = $1`, [tenant.id])).toEqual([]);
      expect(await impersonatedAudits(tenant.id)).toEqual([]);
    });

    it('waits for a sign-out already under way, then refuses', async () => {
      const staff = await makeUser('midlogout', { staff: true });
      const session = await issueStaffSessionForTest(ds, staff);
      const tenant = await makeUser('tenant');
      // A revoke holding its row lock, not yet committed: create() must not slip past it.
      const runner = ds.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query(`UPDATE staff_sessions SET revoked_at = now(), revoked_reason = 'signed_out' WHERE id = $1`, [
          session.sessionId,
        ]);
        const attempt = admin.app.get(ImpersonationHandoffsService).create({
          actor: { userId: staff.id, email: staff.email, sessionId: session.sessionId },
          targetId: tenant.id,
          reason: REASON,
          ipAddress: '127.0.0.1',
        });
        const settled = attempt.then(
          () => 'made',
          () => 'refused',
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await runner.commitTransaction();
        expect(await settled).toBe('refused');
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
      expect(await ds.query(`SELECT 1 FROM impersonation_handoffs WHERE target_id = $1`, [tenant.id])).toEqual([]);
      expect(await impersonatedAudits(tenant.id)).toEqual([]);
    });

    it('never leaves an unused code on a session signed out at the same moment', async () => {
      const ROUNDS = 15;
      for (let round = 0; round < ROUNDS; round += 1) {
        const staff = await makeUser('race', { staff: true });
        const session = await issueStaffSessionForTest(ds, staff);
        const tenant = await makeUser('tenant');
        const [made, loggedOut] = await Promise.all([
          send(admin.base, 'POST', `/api/admin/tenants/${tenant.id}/impersonate`, {
            token: session.accessToken,
            body: { reason: REASON },
          }),
          send(admin.base, 'POST', '/api/staff/auth/session/logout', { token: session.accessToken }),
        ]);
        expect(loggedOut.status).toBe(204);
        expect([200, 401]).toContain(made.status);
        // Whichever won, the session has ended, so no code of it may still be waiting.
        expect(await unusedOf(session.sessionId)).toEqual([]);
        // A view-as is audited exactly when one was made.
        expect(await impersonatedAudits(tenant.id)).toHaveLength(made.status === 200 ? 1 : 0);
      }
    }, 60000);
  });

  it('ends a view-as when the staff session that started it ends', async () => {
    const { code, session } = await scene();
    const token = (await exchange(code)).body.data.accessToken;
    expect((await send(customer.base, 'GET', '/api/projects', { token })).status).toBe(200);
    await send(admin.base, 'POST', '/api/staff/auth/session/logout', { token: session.accessToken });
    expect((await send(customer.base, 'GET', '/api/projects', { token })).status).toBe(401);
  });

  it('refuses a view-as token that names no staff session, as every one from before has', async () => {
    const { staff, tenant } = await scene();
    const old = await new JwtService({}).signAsync(
      { sub: tenant.id, email: tenant.email, type: 'access', imp: staff.id, sv: 0, impSv: 0 },
      { secret: process.env.JWT_SECRET as string, expiresIn: '30m' },
    );
    expect((await send(customer.base, 'GET', '/api/projects', { token: old })).status).toBe(401);
  });

  it('keeps the old view-as rules for who can be looked at', async () => {
    const staff = await makeUser('rules', { staff: true });
    const { accessToken } = await issueStaffSessionForTest(ds, staff);
    const other = await makeUser('otherstaff', { staff: true });
    const suspended = await makeUser('suspended', { suspended: true });
    const tryOn = (id: string) =>
      send(admin.base, 'POST', `/api/admin/tenants/${id}/impersonate`, { token: accessToken, body: { reason: REASON } });
    expect((await tryOn(staff.id)).status).toBe(409);
    expect((await tryOn(other.id)).status).toBe(409);
    expect((await tryOn(suspended.id)).status).toBe(409);
    expect((await tryOn(randomUUID())).status).toBe(404);
    expect(await ds.query(`SELECT 1 FROM impersonation_handoffs WHERE actor_id = $1`, [staff.id])).toEqual([]);
  });

  it('serves each half on its own API only', async () => {
    const { tenant, code } = await scene();
    const customerToken = await new JwtService({}).signAsync(
      { sub: tenant.id, email: tenant.email, type: 'access', sv: 0, auth_time: Math.floor(Date.now() / 1000) },
      { secret: process.env.JWT_SECRET as string, expiresIn: '5m' },
    );
    expect(
      (await send(customer.base, 'POST', `/api/admin/tenants/${tenant.id}/impersonate`, { token: customerToken, body: { reason: REASON } })).status,
    ).toBe(404);
    expect((await send(admin.base, 'POST', '/api/auth/impersonation/exchange', { body: { code } })).status).toBe(404);
    // Unspent by any of that.
    expect((await exchange(code)).status).toBe(200);
  });

  it('needs the client header, and reads the code from the body only', async () => {
    const { code } = await scene();
    expect((await exchange(code, { client: false })).status).toBe(403);
    const inQuery = await send(customer.base, 'POST', `/api/auth/impersonation/exchange?code=${code}`, { body: {} });
    expect(inQuery.status).toBe(400);
    expect(inQuery.body.message).not.toBe(IMPERSONATION_LINK_INVALID_MESSAGE);
    // Neither spent it.
    expect((await exchange(code)).status).toBe(200);
  });
});

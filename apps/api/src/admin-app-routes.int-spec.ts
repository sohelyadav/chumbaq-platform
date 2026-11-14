import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from './test-support/int-db';
import { BootedApp, bootIntApp, listRoutes, ListedRoute } from './test-support/int-apps';
import { issueStaffSessionForTest } from './test-support/staff-session';
import { STAFF_ENROLMENT_ONLY_MESSAGE } from './modules/staff-auth/staff-messages';

const DOMAIN = '@admin-app-routes-int.test';

/** The staff routes, exactly: the admin app is built against this list. */
const STAFF_ROUTES = [
  'POST /api/staff/auth/login',
  'POST /api/staff/auth/login/totp',
  'POST /api/staff/auth/login/passkey/options',
  'POST /api/staff/auth/login/passkey/verify',
  'POST /api/staff/auth/passkey/options',
  'POST /api/staff/auth/passkey/verify',
  'POST /api/staff/auth/session/refresh',
  'POST /api/staff/auth/session/logout',
  'GET /api/staff/auth/me',
  'GET /api/staff/auth/factors',
  'POST /api/staff/auth/passkeys/options',
  'POST /api/staff/auth/passkeys',
  'DELETE /api/staff/auth/passkeys/:id',
  'POST /api/staff/auth/totp/setup',
  'POST /api/staff/auth/totp/confirm',
  'DELETE /api/staff/auth/totp',
  'POST /api/staff/auth/reauth/passkey/options',
  'POST /api/staff/auth/reauth/passkey/verify',
  'POST /api/staff/auth/reauth/totp',
].sort();

/** Every /api/admin route from before the split, at the same paths. */
const ADMIN_ROUTES = [
  'GET /api/admin/audit-logs',
  'GET /api/admin/audit-logs/export',
  'GET /api/admin/tenants/:id/factor-reset',
  'POST /api/admin/tenants/:id/factor-reset',
  'DELETE /api/admin/tenants/:id/factor-reset',
  'POST /api/admin/platform-email/test',
  'GET /api/admin/overview',
  'GET /api/admin/health',
  'GET /api/admin/tenants',
  'GET /api/admin/tenants/export',
  'GET /api/admin/tenants/:id',
  'GET /api/admin/tenants/:id/usage',
  'POST /api/admin/tenants/:id/suspend',
  'PATCH /api/admin/tenants/:id/project-limit',
  'PATCH /api/admin/tenants/:id/seat-limit',
  'POST /api/admin/tenants/:id/reactivate',
  'POST /api/admin/tenants/:id/impersonate',
  'GET /api/admin/tripwires',
  'POST /api/admin/tripwires/api-key',
  'POST /api/admin/tripwires/account',
  'POST /api/admin/tripwires/:id/revoke',
  'GET /api/admin/incidents',
  'POST /api/admin/incidents',
  'GET /api/admin/incidents/:id',
  'GET /api/admin/incidents/:id/report-draft',
  'POST /api/admin/incidents/:id/report',
  'POST /api/admin/incidents/:id/notes',
  'POST /api/admin/incidents/:id/close',
  'GET /api/admin/security-contact',
  'PUT /api/admin/security-contact',
  'GET /api/admin/security-alerts',
  'GET /api/admin/plans',
  'POST /api/admin/plans',
  'PATCH /api/admin/plans/:code',
  'POST /api/admin/plans/:code/prices',
  'POST /api/admin/plans/:code/prices/:id/retire',
].sort();

/** All an enrolment-only session may reach: say who it is, enrol a factor, sign out. */
const ENROLMENT_ALLOWED = [
  'POST /api/staff/auth/session/logout',
  'GET /api/staff/auth/me',
  'GET /api/staff/auth/factors',
  'POST /api/staff/auth/passkeys/options',
  'POST /api/staff/auth/passkeys',
  'POST /api/staff/auth/totp/setup',
  'POST /api/staff/auth/totp/confirm',
].sort();

/**
 * Which routes each API serves, read from the running apps' controllers, so a module
 * imported into the wrong app, or a staff route added without its guard, fails here.
 */
describe('the two APIs serve their own routes only', () => {
  let ds: DataSource;
  let customer: BootedApp;
  let admin: BootedApp;
  let customerRoutes: ListedRoute[];
  let adminRoutes: ListedRoute[];
  let staff: { id: string; email: string; sessionVersion: number };

  const call = (base: string, method: string, path: string, token?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-chumbaq-client': 'admin',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
    });

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    const [row] = await ds.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin)
       VALUES ($1, 'x', 'Staff', true) RETURNING id, email, session_version`,
      [`staff${DOMAIN}`],
    );
    staff = { id: row.id, email: row.email, sessionVersion: row.session_version };
    customer = await bootIntApp('customer');
    admin = await bootIntApp('admin');
    customerRoutes = listRoutes(customer.app);
    adminRoutes = listRoutes(admin.app);
  }, 120000);

  afterAll(async () => {
    await customer?.app.close();
    await admin?.app.close();
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
  });

  it('the customer API serves nothing under /api/admin or /api/staff', async () => {
    expect(customerRoutes.length).toBeGreaterThan(200);
    expect(customerRoutes.filter((r) => /^\/api\/(admin|staff)(\/|$)/.test(r.path)).map((r) => r.key)).toEqual([]);

    // Over real HTTP, with a valid customer token of a super admin.
    const token = await new JwtService({}).signAsync(
      { sub: staff.id, email: staff.email, type: 'access', sv: staff.sessionVersion, auth_time: Math.floor(Date.now() / 1000) },
      { secret: process.env.JWT_SECRET as string, expiresIn: '5m' },
    );
    expect((await call(customer.base, 'GET', '/api/auth/me', token)).status).toBe(200);
    // The deploy scripts wait on the customer API's own health check after each restart.
    const health = await call(customer.base, 'GET', '/api/health');
    expect([health.status, await health.json()]).toEqual([200, { data: { status: 'ok' } }]);
    for (const path of ['/api/admin/overview', '/api/admin/tenants', '/api/staff/auth/me']) {
      expect({ path, status: (await call(customer.base, 'GET', path, token)).status }).toEqual({ path, status: 404 });
    }
  });

  it('the admin API serves admin, staff sign-in and health, and nothing else', async () => {
    const strays = adminRoutes.filter((r) => !/^\/api\/(admin\/|staff\/auth\/|health$|internal\/security-alerts$)/.test(r.path));
    expect(strays.map((r) => r.key)).toEqual([]);
    expect(adminRoutes.filter((r) => r.path.startsWith('/api/staff/')).map((r) => r.key).sort()).toEqual(STAFF_ROUTES);
    expect(adminRoutes.filter((r) => r.path.startsWith('/api/admin/')).map((r) => r.key).sort()).toEqual(ADMIN_ROUTES);
    expect(adminRoutes.filter((r) => r.path === '/api/health').map((r) => r.key)).toEqual(['GET /api/health']);

    for (const [method, path] of [
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/impersonation/exchange'],
      ['GET', '/api/users/me'],
      ['GET', '/api/projects'],
    ]) {
      expect({ path, status: (await call(admin.base, method, path)).status }).toEqual({ path, status: 404 });
    }
    const health = await call(admin.base, 'GET', '/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ data: { status: 'ok' } });
  });

  it('every /api/admin route is behind StaffJwtAuthGuard then SuperAdminGuard', () => {
    const wrong = adminRoutes
      .filter((r) => r.path.startsWith('/api/admin/'))
      .filter((r) => r.guards[0] !== 'StaffJwtAuthGuard' || r.guards[1] !== 'SuperAdminGuard')
      .map((r) => `${r.key} [${r.guards.join(', ')}]`);
    expect(wrong).toEqual([]);
    // RecentAuthGuard reads the customer principal; only the staff one belongs here.
    expect(adminRoutes.filter((r) => r.guards.includes('RecentAuthGuard') || r.guards.includes('JwtAuthGuard')).map((r) => r.key)).toEqual([]);
  });

  it('an enrolment-only token is refused everywhere it is not allowed', async () => {
    expect(adminRoutes.filter((r) => r.allowsEnrolment).map((r) => r.key).sort()).toEqual(ENROLMENT_ALLOWED);

    const { accessToken } = await issueStaffSessionForTest(ds, staff, { enrolmentOnly: true });
    const authenticated = adminRoutes.filter((r) => r.guards.includes('StaffJwtAuthGuard'));
    // Everything but sign-in, refresh, health and the server scripts' alarm route (its
    // own token, localhost only), which take no bearer.
    expect(authenticated.length).toBe(adminRoutes.length - 9);
    const leaks: string[] = [];
    for (const route of authenticated.filter((r) => !r.allowsEnrolment)) {
      const path = route.path.replace(/:[A-Za-z]+/g, randomUUID());
      const response = await call(admin.base, route.method, path, accessToken);
      const body = (await response.json()) as { message?: string };
      if (response.status !== 403 || body.message !== STAFF_ENROLMENT_ONLY_MESSAGE) {
        leaks.push(`${route.key}: ${response.status} ${body.message}`);
      }
    }
    expect(leaks).toEqual([]);

    // And the token does work where it is allowed, so the refusals above are about it.
    const me = await call(admin.base, 'GET', '/api/staff/auth/me', accessToken);
    expect(me.status).toBe(200);
  });
});

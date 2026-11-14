import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { AdminAuditLog, AdminTenantDetail } from '@chumbaq/shared';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { fakeConfig } from '../../test-support/staff-strategy-fakes';
import { StaffSessionEntity } from '../auth/entities/staff-session.entity';
import { SecondFactorsService } from '../auth/second-factors.service';
import { StaffSessionsService } from '../auth/staff-sessions.service';
import { StaffTokensService } from '../auth/staff-tokens.service';
import { StaffJwtStrategy } from '../staff-auth/staff-jwt.strategy';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AUDIT_EXPORT_ROW_CAP, AdminAuditLogsService } from './admin-audit-logs.service';
import { AdminAuditService, READ_DEDUPE_WINDOW_MINUTES } from './admin-audit.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { SeatsService } from '../project-access/seats.service';
import { AUDIT_CSV_HEADER } from './audit-csv';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';
import { AccountLimitsService } from '../billing/account-limits.service';

/** The real one: staff tokens come from `issueStaffSessionForTest`, which signs with it. */
const SECRET = process.env.JWT_SECRET as string;
// Every fixture carries this domain, and every row a test reads is scoped to one of
// its fixtures, so other int specs' audit rows neither show up nor get deleted.
const DOMAIN = '@audit-logs-int.test';
const STAFF_EMAIL = `staff${DOMAIN}`;
const OTHER_STAFF_EMAIL = `other-staff${DOMAIN}`;
const TENANT_EMAIL = `tenant${DOMAIN}`;

interface Page {
  data: AdminAuditLog[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

/** Real HTTP, Postgres, JwtStrategy and SuperAdminGuard: who may read the log is tested end to end. */
describe('Admin audit log API (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let staffId: string;
  let otherStaffId: string;
  let tenantId: string;
  let staffToken: string;
  let otherStaffToken: string;
  let tenantToken: string;
  let impersonationToken: string;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });

  const sign = (sub: string, email: string, imp?: string) =>
    jwt.sign({ sub, email, type: 'access', sv: 0, ...(imp ? { imp, impSv: 0 } : {}) });

  const get = (path: string, token = staffToken) =>
    fetch(`${base}/admin/${path}`, { headers: { authorization: `Bearer ${token}` } });

  const page = async (query: string, token = staffToken): Promise<Page> => {
    const response = await get(`audit-logs?${query}`, token);
    expect(response.status).toBe(200);
    return (await response.json()) as Page;
  };

  const exportCsv = async (query: string) => {
    const response = await get(`audit-logs/export?${query}`);
    expect(response.status).toBe(200);
    // Not response.text(), which drops the byte-order mark this needs to see.
    return { response, text: Buffer.from(await response.arrayBuffer()).toString('utf8') };
  };

  /** Inserted directly, as the CLI does, with whatever instant the test needs. */
  const seed = async (fields: {
    actorId?: string | null;
    actorEmail?: string;
    action?: string;
    targetId?: string | null;
    targetLabel?: string | null;
    reason?: string | null;
    createdAt?: string;
  }): Promise<string> => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO admin_audit_logs
         (id, actor_id, actor_email, action, target_type, target_id, target_label, reason, created_at)
       VALUES ($1, $2, $3, $4, 'tenant', $5, $6, $7, COALESCE($8::timestamptz, now()))`,
      [
        id,
        fields.actorId === undefined ? staffId : fields.actorId,
        fields.actorEmail ?? STAFF_EMAIL,
        fields.action ?? 'tenant.suspended',
        fields.targetId === undefined ? tenantId : fields.targetId,
        fields.targetLabel ?? TENANT_EMAIL,
        fields.reason ?? null,
        fields.createdAt ?? null,
      ],
    );
    return id;
  };

  const auditRows = (where: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
    ds.query(`SELECT * FROM admin_audit_logs WHERE ${where} ORDER BY created_at, id`, params);

  const viewsOf = (target: string) =>
    auditRows(`target_id = $1 AND action = 'tenant.viewed'`, [target]);

  const exportsBy = (actor: string) =>
    auditRows(`actor_id = $1 AND action = 'audit_log.exported'`, [actor]);

  beforeAll(async () => {
    ds = await openIntDb();
    const auditRepository = ds.getRepository(AdminAuditLogEntity);
    const auditService = new AdminAuditService(auditRepository);
    const users = new UsersService(ds.getRepository(UserEntity));
    const config = fakeConfig({ 'jwt.secret': process.env.JWT_SECRET });

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AdminAuditLogsController, AdminTenantsController],
      providers: [
        StaffJwtStrategy,
        { provide: ConfigService, useValue: config },
        { provide: UsersService, useValue: users },
        { provide: StaffTokensService, useValue: new StaffTokensService(config, new JwtService({})) },
        {
          provide: StaffSessionsService,
          useValue: new StaffSessionsService(ds.getRepository(StaffSessionEntity), config),
        },
        { provide: SecondFactorsService, useValue: { passkeyCount: async () => 0 } },
        {
          provide: AdminAuditLogsService,
          useValue: new AdminAuditLogsService(auditRepository, auditService),
        },
        {
          provide: AdminTenantsService,
          useValue: new AdminTenantsService(
            ds.getRepository(UserEntity),
            auditRepository,
            auditService,
            { factorResetCancelled: () => undefined } as never, new SeatsService(ds, new AccountLimitsService()), new AccountLimitsService()
          ),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}`;
  });

  const cleanUp = async () => {
    await ds.query(
      `DELETE FROM admin_audit_logs WHERE actor_email LIKE $1 OR target_label LIKE $1`,
      [`%${DOMAIN}`],
    );
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  afterAll(async () => {
    await app.close();
    await cleanUp();
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await cleanUp();
    const repo = ds.getRepository(UserEntity);
    const user = async (email: string, isSuperAdmin: boolean) =>
      (await repo.save({ email, name: 'Fixture', passwordHash: 'x', isSuperAdmin })).id;
    staffId = await user(STAFF_EMAIL, true);
    otherStaffId = await user(OTHER_STAFF_EMAIL, true);
    tenantId = await user(TENANT_EMAIL, false);
    staffToken = (await issueStaffSessionForTest(ds, { id: staffId, email: STAFF_EMAIL, sessionVersion: 0 })).accessToken;
    otherStaffToken = (
      await issueStaffSessionForTest(ds, { id: otherStaffId, email: OTHER_STAFF_EMAIL, sessionVersion: 0 })
    ).accessToken;
    tenantToken = sign(tenantId, TENANT_EMAIL);
    impersonationToken = sign(tenantId, TENANT_EMAIL, staffId);
  });

  describe('who may read it', () => {
    it.each([
      ['audit-logs'],
      ['audit-logs/export'],
      ['tenants/TENANT'],
    ])('refuses customer tokens, a tenant\'s and a view-as one, on %s', async (route) => {
      const path = route.replace('TENANT', tenantId);

      // Signed with the customer key, so the staff strategy never accepts them.
      expect((await get(path, tenantToken)).status).toBe(401);
      expect((await get(path, impersonationToken)).status).toBe(401);
      expect((await get(path, sign(staffId, STAFF_EMAIL))).status).toBe(401);
      expect((await get(path, 'not-a-token')).status).toBe(401);
    });

    it('records nothing for a refused export or a refused tenant read', async () => {
      await get('audit-logs/export', tenantToken);
      await get(`tenants/${tenantId}`, impersonationToken);

      expect(await exportsBy(tenantId)).toEqual([]);
      expect(await viewsOf(tenantId)).toEqual([]);
    });
  });

  describe('filters', () => {
    it('by actor id, by actor email (case and spaces ignored), and the CLI as an actor', async () => {
      const mine = await seed({});
      const theirs = await seed({ actorId: otherStaffId, actorEmail: OTHER_STAFF_EMAIL });
      const cli = await seed({ actorId: null, actorEmail: 'cli', action: 'super_admin.granted' });
      const scope = `targetId=${tenantId}`;

      expect((await page(`${scope}&actorId=${staffId}`)).data.map((r) => r.id)).toEqual([mine]);
      expect(
        (await page(`${scope}&actorEmail=${encodeURIComponent(` Other-Staff${DOMAIN} `)}`)).data.map(
          (r) => r.id,
        ),
      ).toEqual([theirs]);
      expect((await page(`${scope}&actorEmail=CLI`)).data.map((r) => r.id)).toEqual([cli]);
    });

    it('by several actions at once, and by target tenant', async () => {
      const otherTenant = randomUUID();
      const suspended = await seed({ action: 'tenant.suspended' });
      const viewed = await seed({ action: 'tenant.viewed' });
      await seed({ action: 'tenant.impersonated' });
      await seed({ action: 'tenant.suspended', targetId: otherTenant });

      const ids = (await page(`targetId=${tenantId}&action=tenant.suspended,tenant.viewed&limit=100`)).data
        .map((r) => r.id)
        .sort();

      expect(ids).toEqual([suspended, viewed].sort());
      expect((await page(`targetId=${otherTenant}`)).meta.total).toBe(1);
    });

    it('by date range, from inclusive and to exclusive, in any offset', async () => {
      const before = await seed({ createdAt: '2026-10-31T23:59:59.999Z' });
      const atFrom = await seed({ createdAt: '2026-11-01T00:00:00.000Z' });
      const inside = await seed({ createdAt: '2026-11-01T12:00:00.000Z' });
      const atTo = await seed({ createdAt: '2026-11-02T00:00:00.000Z' });

      const range = (from: string, to: string) =>
        page(`targetId=${tenantId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

      expect((await range('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')).data.map((r) => r.id)).toEqual([
        inside,
        atFrom,
      ]);
      // The same instants written in IST select the same rows.
      expect(
        (await range('2026-11-01T05:30:00+05:30', '2026-11-02T05:30:00+05:30')).data.map((r) => r.id),
      ).toEqual([inside, atFrom]);
      expect((await page(`targetId=${tenantId}&to=2026-11-01T00:00:00Z`)).data.map((r) => r.id)).toEqual([
        before,
      ]);
      expect((await page(`targetId=${tenantId}&from=2026-11-02T00:00:00Z`)).data.map((r) => r.id)).toEqual([
        atTo,
      ]);
    });

    it('refuses a range that ends before it starts, for the list and the export', async () => {
      const query = 'from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z';

      expect((await get(`audit-logs?${query}`)).status).toBe(400);
      expect((await get(`audit-logs/export?${query}`)).status).toBe(400);
      expect(await exportsBy(staffId)).toEqual([]);
    });
  });

  describe('paging', () => {
    it('pages newest first with the id breaking ties, so no row repeats or goes missing', async () => {
      const createdAt = '2026-11-01T00:00:00Z';
      const tied: string[] = [];
      for (let i = 0; i < 5; i++) tied.push(await seed({ createdAt }));
      const newest = await seed({ createdAt: '2026-11-03T00:00:00Z' });

      const seen: string[] = [];
      for (const n of [1, 2, 3]) {
        const result = await page(`targetId=${tenantId}&limit=2&page=${n}`);
        expect(result.meta).toEqual({ total: 6, page: n, limit: 2, totalPages: 3 });
        seen.push(...result.data.map((r) => r.id));
      }

      expect(seen).toEqual([newest, ...[...tied].sort().reverse()]);
    });
  });

  describe('export', () => {
    const parseCsv = (text: string): string[][] => {
      // A small RFC 4180 reader, so the test checks what a spreadsheet would read
      // rather than the writer's own idea of the format.
      const rows: string[][] = [];
      let row: string[] = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
          if (c === '"' && text[i + 1] === '"') {
            cell += '"';
            i++;
          } else if (c === '"') quoted = false;
          else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') {
          row.push(cell);
          cell = '';
        } else if (c === '\r' && text[i + 1] === '\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
          i++;
        } else cell += c;
      }
      return rows;
    };

    it('escapes quotes, commas and newlines, and defuses formulas', async () => {
      const hostile = [
        `=HYPERLINK("https://evil.test","click")`,
        '+SUM(1,2)',
        '-2+3',
        '@cmd',
        '\t=1',
        '\r=1',
        'plain, with "quotes"\nand a second line',
      ];
      for (const [i, reason] of hostile.entries()) {
        await seed({ reason, createdAt: `2026-11-01T00:00:0${i}Z` });
      }

      const { text } = await exportCsv(`targetId=${tenantId}`);

      expect(text.startsWith('﻿')).toBe(true);
      const [header, ...rows] = parseCsv(text.slice(1));
      expect(header).toEqual([...AUDIT_CSV_HEADER]);
      const reasons = rows.map((row) => row[AUDIT_CSV_HEADER.indexOf('reason')]);
      expect(reasons).toEqual(
        [
          `'=HYPERLINK("https://evil.test","click")`,
          "'+SUM(1,2)",
          "'-2+3",
          "'@cmd",
          "'\t=1",
          "'\r=1",
          'plain, with "quotes"\nand a second line',
        ].reverse(),
      );
      expect(rows.every((row) => row.length === AUDIT_CSV_HEADER.length)).toBe(true);
    });

    it('applies the same filters as the list', async () => {
      const viewed = await seed({ action: 'tenant.viewed' });
      await seed({ action: 'tenant.suspended' });

      const { text, response } = await exportCsv(`targetId=${tenantId}&action=tenant.viewed`);
      const rows = parseCsv(text.slice(1)).slice(1);

      expect(rows.map((row) => row[AUDIT_CSV_HEADER.indexOf('id')])).toEqual([viewed]);
      expect(response.headers.get('x-export-row-count')).toBe('1');
      expect(response.headers.get('x-export-truncated')).toBe('false');
    });

    it('is itself audited, with what was asked for and how much it returned', async () => {
      await seed({});

      await exportCsv(`targetId=${tenantId}&action=tenant.suspended,tenant.viewed`);

      const [row] = await exportsBy(staffId);
      expect(row).toMatchObject({
        actor_email: STAFF_EMAIL,
        target_type: 'audit_log',
        target_id: null,
        metadata: {
          filters: { targetId: tenantId, action: ['tenant.suspended', 'tenant.viewed'] },
          rowCount: 1,
          truncated: false,
          rowCap: AUDIT_EXPORT_ROW_CAP,
        },
      });
      expect(row.ip_address).toBeTruthy();
    });

    it(`stops at ${AUDIT_EXPORT_ROW_CAP} rows, newest first, and says it did`, async () => {
      await ds.query(
        `INSERT INTO admin_audit_logs (actor_id, actor_email, action, target_type, target_id, target_label, created_at)
         SELECT $1, $2, 'tenant.viewed', 'tenant', $3, $4, now() - (n * INTERVAL '1 second')
         FROM generate_series(1, $5::int) AS n`,
        [staffId, STAFF_EMAIL, tenantId, TENANT_EMAIL, AUDIT_EXPORT_ROW_CAP + 1],
      );
      const [{ oldest }] = await ds.query(
        `SELECT id AS oldest FROM admin_audit_logs WHERE target_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [tenantId],
      );

      const { text, response } = await exportCsv(`targetId=${tenantId}`);
      const rows = parseCsv(text.slice(1)).slice(1);

      expect(rows).toHaveLength(AUDIT_EXPORT_ROW_CAP);
      expect(rows.map((row) => row[AUDIT_CSV_HEADER.indexOf('id')])).not.toContain(oldest);
      expect(response.headers.get('x-export-truncated')).toBe('true');
      expect(response.headers.get('x-export-row-cap')).toBe(String(AUDIT_EXPORT_ROW_CAP));
      expect((await exportsBy(staffId))[0].metadata).toMatchObject({
        rowCount: AUDIT_EXPORT_ROW_CAP,
        truncated: true,
      });
    });
  });

  describe('staff reads of a tenant', () => {
    const view = async (token = staffToken) => {
      const response = await get(`tenants/${tenantId}`, token);
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: AdminTenantDetail }).data;
    };

    it('records a view with who, whom and from where', async () => {
      await view();

      const rows = await viewsOf(tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: staffId,
        actor_email: STAFF_EMAIL,
        target_type: 'tenant',
        target_label: TENANT_EMAIL,
      });
      expect(rows[0].ip_address).toBeTruthy();
    });

    it(`records one view per admin and tenant within ${READ_DEDUPE_WINDOW_MINUTES} minutes`, async () => {
      await view();
      await view();
      await view(otherStaffToken);

      const rows = await viewsOf(tenantId);
      expect(rows.map((row) => row.actor_id).sort()).toEqual([staffId, otherStaffId].sort());
    });

    it('records one view when several tabs load the tenant at once', async () => {
      await Promise.all([view(), view(), view(), view(), view()]);

      expect(await viewsOf(tenantId)).toHaveLength(1);
    });

    it('records a new view once the window has passed', async () => {
      await view();
      await ds.query(
        `UPDATE admin_audit_logs SET created_at = now() - make_interval(mins => $2 + 1)
          WHERE target_id = $1 AND action = 'tenant.viewed'`,
        [tenantId, READ_DEDUPE_WINDOW_MINUTES],
      );

      await view();

      expect(await viewsOf(tenantId)).toHaveLength(2);
    });

    it('does not count a different staff action as a recent view', async () => {
      await seed({ action: 'tenant.impersonated' });

      await view();

      expect(await viewsOf(tenantId)).toHaveLength(1);
    });

    it('keeps views off the tenant page’s short history, which is for what was done', async () => {
      const suspended = await seed({ action: 'tenant.suspended' });

      await view();
      const detail = await view();

      expect(detail.recentAudit.map((entry) => entry.id)).toEqual([suspended]);
      expect((await page(`targetId=${tenantId}&action=tenant.viewed`)).meta.total).toBe(1);
    });

    it('records nothing for a tenant that does not exist', async () => {
      const missing = randomUUID();

      expect((await get(`tenants/${missing}`)).status).toBe(404);
      expect(await viewsOf(missing)).toEqual([]);
    });
  });
});

import { randomUUID } from 'crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { openIntDb, closeIntDb } from '../../test-support/int-db';
import { UserEntity } from '../users/entities/user.entity';
import { AdminAuditService } from './admin-audit.service';
import { AdminActor, AdminTenantsService } from './admin-tenants.service';
import { SeatsService } from '../project-access/seats.service';
import { AdminTenantsFilterDto, ListAdminTenantsDto } from './dto/admin-tenants.dto';
import { TENANT_CSV_HEADER } from './tenants-csv';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';

// Every fixture carries this domain and every list query is scoped by it, so
// these tests neither see nor disturb rows owned by other int specs.
const DOMAIN = '@ws2-int.test';
const REASON = 'repeated abuse reports';
const PASSWORD_HASH = '$2b$10$ws2FixtureHashThatMustNeverLeaveTheDatabase';

describe('AdminTenantsService (integration)', () => {
  let ds: DataSource;
  let service: AdminTenantsService;
  let actor: AdminActor;
  let linkSequence = 0;

  const tenant = async (
    localPart: string,
    over: {
      name?: string;
      isSuperAdmin?: boolean;
      suspended?: boolean;
      createdDaysAgo?: number;
    } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, is_super_admin, suspended_at, suspended_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - ($8::int * INTERVAL '1 day'))`,
      [
        id,
        `${localPart}${DOMAIN}`,
        PASSWORD_HASH,
        over.name ?? 'fixture',
        over.isSuperAdmin ?? false,
        over.suspended ? new Date() : null,
        over.suspended ? 'previously suspended' : null,
        over.createdDaysAgo ?? 0,
      ],
    );
    return id;
  };

  const project = async (ownerId: string, name = 'app'): Promise<string> => {
    const id = randomUUID();
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, $2, $3)`, [
      id,
      name,
      ownerId,
    ]);
    return id;
  };

  const link = async (projectId: string): Promise<string> => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO links (id, short_code, long_url, project_id) VALUES ($1, $2, 'https://example.com', $3)`,
      [id, `w${Date.now().toString(36)}${linkSequence++}`, projectId],
    );
    return id;
  };

  /** Omits clicked_at when recent, so the column's real default writes it. */
  const click = async (linkId: string, daysAgo = 0): Promise<void> => {
    if (daysAgo === 0) {
      await ds.query(
        `INSERT INTO click_events (link_id, platform, device_type, redirect_type)
         VALUES ($1, 'ios', 'mobile', 'deep_link')`,
        [linkId],
      );
      return;
    }
    await ds.query(
      `INSERT INTO click_events (link_id, platform, device_type, redirect_type, clicked_at)
       VALUES ($1, 'ios', 'mobile', 'deep_link', NOW() - ($2::int * INTERVAL '1 day'))`,
      [linkId, daysAgo],
    );
  };

  const identity = (projectId: string) =>
    ds.query(
      `INSERT INTO device_identities (project_id, device_fingerprint, platform, last_seen_at)
       VALUES ($1, $2, 'ios', NOW())`,
      [projectId, `fp-${randomUUID()}`],
    );

  const apiKey = (
    projectId: string,
    over: { isActive?: boolean; expiresInDays?: number } = {},
  ) =>
    ds.query(
      `INSERT INTO api_keys (project_id, name, key_hash, prefix, is_active, expires_at)
       VALUES ($1, 'key', $2, 'dl_', $3, CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() + ($4::int * INTERVAL '1 day') END)`,
      [projectId, randomUUID(), over.isActive ?? true, over.expiresInDays ?? null],
    );

  const auditRowsFor = (id: string): Promise<AdminAuditLogEntity[]> =>
    ds.getRepository(AdminAuditLogEntity).find({ where: { targetId: id } });

  const stateOf = async (id: string) => {
    const [row] = await ds.query(
      `SELECT suspended_at, suspended_reason FROM users WHERE id = $1`,
      [id],
    );
    return row;
  };

  const listQuery = (over: Partial<ListAdminTenantsDto> = {}): ListAdminTenantsDto =>
    Object.assign(new ListAdminTenantsDto(), { search: DOMAIN }, over);

  const emails = async (over: Partial<ListAdminTenantsDto>) =>
    (await service.list(listQuery(over))).data.map((row) => row.email);

  const queriesDuring = async (work: () => Promise<unknown>): Promise<string[]> => {
    const spy = jest.spyOn(ds.logger, 'logQuery');
    try {
      await work();
      return spy.mock.calls.map(([sql]) => sql);
    } finally {
      spy.mockRestore();
    }
  };

  const cleanUp = async () => {
    await ds.query(`DELETE FROM admin_audit_logs WHERE target_label LIKE $1 OR actor_email LIKE $1`, [
      `%${DOMAIN}`,
    ]);
    // usage_daily has no foreign keys, so its rows would outlive their owners.
    await ds.query(`DELETE FROM usage_daily WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [
      `%${DOMAIN}`,
    ]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    const auditRepository = ds.getRepository(AdminAuditLogEntity);
    service = new AdminTenantsService(
      ds.getRepository(UserEntity),
      auditRepository,
      new AdminAuditService(auditRepository),
      { factorResetCancelled: () => undefined } as never, new SeatsService(ds)
    );
  });

  afterAll(async () => {
    await cleanUp();
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await cleanUp();
    const actorId = await tenant('staff', { isSuperAdmin: true, createdDaysAgo: 400 });
    actor = { userId: actorId, email: `staff${DOMAIN}`, ipAddress: '203.0.113.7' };
  });

  describe('list search', () => {
    it('matches % literally', async () => {
      await tenant('qz%y');
      await tenant('qzxy');
      expect(await emails({ search: 'qz%y' })).toEqual([`qz%y${DOMAIN}`]);
    });

    it('matches _ literally', async () => {
      await tenant('qz_y');
      await tenant('qzxy');
      expect(await emails({ search: 'qz_y' })).toEqual([`qz_y${DOMAIN}`]);
    });

    it('matches \\ literally', async () => {
      await tenant('qz\\y');
      await tenant('qzy');
      expect(await emails({ search: 'qz\\y' })).toEqual([`qz\\y${DOMAIN}`]);
    });

    it('treats a search of only % as that character, not as everything', async () => {
      await tenant('plain');
      expect(await emails({ search: '%' })).not.toContain(`plain${DOMAIN}`);
    });

    it('is case-insensitive over email and over name', async () => {
      // Addresses are stored lower-cased, so the search term carries the mixed case.
      await tenant('priya.sharma');
      await tenant('other', { name: 'Arjun QZNAME Rao' });
      expect(await emails({ search: 'Priya.SHARMA' })).toEqual([`priya.sharma${DOMAIN}`]);
      expect(await emails({ search: 'qzname' })).toEqual([`other${DOMAIN}`]);
    });
  });

  describe('list filtering and ordering', () => {
    it('filters by status', async () => {
      await tenant('live');
      await tenant('gone', { suspended: true });

      expect(await emails({ status: 'suspended' })).toEqual([`gone${DOMAIN}`]);
      const active = await emails({ status: 'active' });
      expect(active).toContain(`live${DOMAIN}`);
      expect(active).not.toContain(`gone${DOMAIN}`);
      const all = await emails({});
      expect(all).toEqual(expect.arrayContaining([`live${DOMAIN}`, `gone${DOMAIN}`]));
    });

    it('orders newest first and pages through with correct meta', async () => {
      await tenant('oldest', { createdDaysAgo: 30 });
      await tenant('newest', { createdDaysAgo: 1 });
      await tenant('middle', { createdDaysAgo: 10 });

      const first = await service.list(listQuery({ page: 1, limit: 2 }));
      const second = await service.list(listQuery({ page: 2, limit: 2 }));

      expect(first.data.map((row) => row.email)).toEqual([`newest${DOMAIN}`, `middle${DOMAIN}`]);
      // Then the staff fixture, 400 days old, shares the second page.
      expect(second.data.map((row) => row.email)).toEqual([`oldest${DOMAIN}`, `staff${DOMAIN}`]);
      expect(first.meta).toMatchObject({ total: 4, page: 1, limit: 2, totalPages: 2 });
    });
  });

  describe('list counts', () => {
    it('credits each tenant only with its own data', async () => {
      const alice = await tenant('alice');
      const aliceApp = await project(alice);
      const aliceOtherApp = await project(alice);
      const aliceLink = await link(aliceApp);
      await link(aliceOtherApp);
      await identity(aliceApp);
      await identity(aliceOtherApp);
      await identity(aliceOtherApp);
      await click(aliceLink);
      await click(aliceLink);
      await click(aliceLink, 45);

      const bob = await tenant('bob');
      const bobApp = await project(bob);
      const bobLink = await link(bobApp);
      await identity(bobApp);
      await click(bobLink, 3);

      const carol = await tenant('carol');

      const { data } = await service.list(listQuery());
      const row = (id: string) => data.find((tenantRow) => tenantRow.id === id)!;

      expect(row(alice)).toMatchObject({
        projectCount: 2,
        linkCount: 2,
        identityCount: 3,
        clicksLast30d: 2,
      });
      expect(row(bob)).toMatchObject({
        projectCount: 1,
        linkCount: 1,
        identityCount: 1,
        clicksLast30d: 1,
      });
      expect(row(carol)).toMatchObject({
        projectCount: 0,
        linkCount: 0,
        identityCount: 0,
        clicksLast30d: 0,
        lastActivityAt: null,
      });
    });

    it('takes lastActivityAt from the latest click, even one past the 30-day window', async () => {
      const veteran = await tenant('veteran');
      const veteranLink = await link(await project(veteran));
      await click(veteranLink, 90);
      await click(veteranLink, 45);

      const active = await tenant('active');
      const activeLink = await link(await project(active));
      await click(activeLink, 40);
      await click(activeLink);

      const { data } = await service.list(listQuery());
      const row = (id: string) => data.find((tenantRow) => tenantRow.id === id)!;

      expect(row(veteran).clicksLast30d).toBe(0);
      const daysAgo =
        (Date.now() - new Date(row(veteran).lastActivityAt!).getTime()) / 86_400_000;
      expect(daysAgo).toBeCloseTo(45, 0);

      // Written by the column's default and read back as an instant: this fails
      // if the plain timestamp is ever misread in a different timezone.
      const activeLag = Math.abs(Date.now() - new Date(row(active).lastActivityAt!).getTime());
      expect(activeLag).toBeLessThan(60_000);
    });

    it('returns dates as ISO strings', async () => {
      const id = await tenant('dated', { suspended: true });
      await click(await link(await project(id)));

      const { data } = await service.list(listQuery({ search: `dated${DOMAIN}` }));

      const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(data[0].createdAt).toMatch(iso);
      expect(data[0].suspendedAt).toMatch(iso);
      expect(data[0].lastActivityAt).toMatch(iso);
      expect(data[0].status).toBe('suspended');
    });
  });

  describe('list usage: sort, activity filter and columns', () => {
    let savedState: { started_on: string; first_day: string; last_closed_day: string }[];
    let heavy: string;
    let light: string;
    let quiet: string;
    let fresh: string;
    let never: string;

    const usage = async (ownerId: string, day: string, metric: string, value: number) => {
      const [{ id }] = await ds.query(`SELECT id FROM projects WHERE owner_id = $1 LIMIT 1`, [ownerId]);
      await ds.query(
        `INSERT INTO usage_daily (project_id, owner_id, day, metric, value) VALUES ($1, $2, $3, $4, $5)`,
        [id, ownerId, day, metric, value],
      );
    };

    const withUsage = async (localPart: string, over: Parameters<typeof tenant>[1] = {}) => {
      const id = await tenant(localPart, { createdDaysAgo: 60, ...over });
      await project(id);
      return id;
    };

    beforeEach(async () => {
      // The roll-up state is one row; keep whatever was there and put it back after.
      savedState = await ds.query(
        `SELECT to_char(started_on, 'YYYY-MM-DD') AS started_on, to_char(first_day, 'YYYY-MM-DD') AS first_day,
                to_char(last_closed_day, 'YYYY-MM-DD') AS last_closed_day FROM usage_rollup_state`,
      );
      await ds.query(
        `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day)
         VALUES (1, '2026-11-14', '2026-08-16', '2026-11-13')
         ON CONFLICT (id) DO UPDATE SET started_on = '2026-11-14', first_day = '2026-08-16',
                                         last_closed_day = '2026-11-13'`,
      );
      heavy = await withUsage('heavy');
      await usage(heavy, '2026-11-13', 'push_sent', 50);
      await usage(heavy, '2026-11-13', 'mau_month_to_date', 5);
      light = await withUsage('light');
      await usage(light, '2026-11-01', 'email_sent', 10);
      // Outside the 30 days, so not in the messages column.
      await usage(light, '2026-10-01', 'sms_sent', 900);
      // 20 days before the last counted day.
      quiet = await withUsage('quiet');
      await usage(quiet, '2026-10-24', 'events', 3);
      fresh = await tenant('fresh', { createdDaysAgo: 5 });
      never = await tenant('never', { createdDaysAgo: 60 });
    });

    afterEach(async () => {
      await ds.query(`DELETE FROM usage_rollup_state`);
      for (const row of savedState) {
        await ds.query(
          `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day) VALUES (1, $1, $2, $3)`,
          [row.started_on, row.first_day, row.last_closed_day],
        );
      }
    });

    const STAFF = `staff${DOMAIN}`;
    const at = (...parts: string[]) => parts.map((part) => `${part}${DOMAIN}`);

    it('gives each tenant its usage, and 0, 0 and null with none', async () => {
      const { data, meta } = await service.list(listQuery({ limit: 100 }));
      const row = (id: string) => data.find((t) => t.id === id)!;

      expect(row(heavy)).toMatchObject({ mauThisMonth: 5, messagesSent30d: 50, lastUsageDay: '2026-11-13' });
      expect(row(light)).toMatchObject({ mauThisMonth: 0, messagesSent30d: 10, lastUsageDay: '2026-11-01' });
      expect(row(never)).toMatchObject({ mauThisMonth: 0, messagesSent30d: 0, lastUsageDay: null });
      expect(meta.countedThrough).toBe('2026-11-13');
      // Active devices counted from the first run's month, so the list can say this month is the first.
      expect(meta.mauFrom).toBe('2026-11-01');
    });

    it('sorts by messages sent, the zeros last and together', async () => {
      expect(await emails({ sort: 'messages_sent_30d', order: 'desc', limit: 100 })).toEqual([
        ...at('heavy', 'light', 'fresh', 'never', 'quiet'),
        STAFF,
      ]);
    });

    it('sorts a tenant with no usage as the 0 it shows, with the other zeros', async () => {
      // Every 0 together, before 10 and 50, tie-broken newest sign-up first:
      // quiet has a counted 0, fresh, never and staff have no rows at all.
      expect(await emails({ sort: 'messages_sent_30d', order: 'asc', limit: 100 })).toEqual([
        ...at('fresh', 'never', 'quiet'),
        STAFF,
        ...at('light', 'heavy'),
      ]);
      expect(await emails({ sort: 'mau_this_month', order: 'asc', limit: 100 })).toEqual([
        ...at('fresh', 'never', 'quiet', 'light'),
        STAFF,
        ...at('heavy'),
      ]);
    });

    it('sorts by monthly active devices', async () => {
      const sorted = await emails({ sort: 'mau_this_month', order: 'desc', limit: 100 });
      expect(sorted[0]).toBe(`heavy${DOMAIN}`);
    });

    it('puts the never-used last in both directions of last usage', async () => {
      expect(await emails({ sort: 'last_usage_day', order: 'asc', limit: 100 })).toEqual([
        ...at('quiet', 'light', 'heavy', 'fresh', 'never'),
        STAFF,
      ]);
      expect(await emails({ sort: 'last_usage_day', order: 'desc', limit: 100 })).toEqual([
        ...at('heavy', 'light', 'quiet', 'fresh', 'never'),
        STAFF,
      ]);
    });

    it('sorts by sign-up oldest first when asked', async () => {
      const sorted = await emails({ sort: 'created_at', order: 'asc', limit: 100 });
      expect(sorted[0]).toBe(STAFF);
      expect(sorted[sorted.length - 1]).toBe(`fresh${DOMAIN}`);
    });

    it('filters by activity', async () => {
      expect(await emails({ activity: 'never_used' })).toEqual([...at('fresh', 'never'), STAFF]);
      expect(await emails({ activity: 'quiet' })).toEqual(at('quiet'));
      expect(await emails({ activity: 'new' })).toEqual(at('fresh'));
    });

    it('counts a tenant 14 days quiet as quiet, and 13 days as not', async () => {
      const boundary = await withUsage('boundary');
      await usage(boundary, '2026-10-30', 'events', 1);
      const recent = await withUsage('recent');
      await usage(recent, '2026-10-31', 'events', 1);
      expect(await emails({ activity: 'quiet' })).toEqual(at('boundary', 'quiet'));
    });

    it('combines the activity filter with status, and pages the filtered total', async () => {
      const gone = await withUsage('quiet-gone', { suspended: true });
      await usage(gone, '2026-10-20', 'events', 1);
      expect(await emails({ status: 'suspended', activity: 'quiet' })).toEqual(at('quiet-gone'));

      const page = await service.list(listQuery({ activity: 'never_used', limit: 2, page: 2 }));
      expect(page.data.map((t) => t.email)).toEqual([STAFF]);
      expect(page.meta).toMatchObject({ total: 3, page: 2, limit: 2, totalPages: 2 });
    });

    it('still knows the total on a page past the end', async () => {
      const page = await service.list(listQuery({ activity: 'never_used', limit: 2, page: 9 }));
      expect(page.data).toEqual([]);
      expect(page.meta).toMatchObject({ total: 3, totalPages: 2 });
    });

    it('matches a search of LIKE wildcards and backslash literally', async () => {
      await tenant('qa%_\\b');
      await tenant('qaxyzb');
      expect(await emails({ search: '%_\\' })).toEqual([`qa%_\\b${DOMAIN}`]);
    });

    it('shows usage on the detail too, with the last successful sign-in and the plan', async () => {
      await ds.query(
        `INSERT INTO auth_events (user_id, email, type, created_at) VALUES
           ($1, $2, 'login.succeeded', '2026-11-01T10:00:00Z'),
           ($1, $2, 'login.succeeded', '2026-11-05T10:00:00Z'),
           ($1, $2, 'login.failed', '2026-11-09T10:00:00Z')`,
        [heavy, `heavy${DOMAIN}`],
      );
      try {
        const detail = await service.findOne(heavy);
        expect(detail).toMatchObject({
          mauThisMonth: 5,
          messagesSent30d: 50,
          lastUsageDay: '2026-11-13',
          lastSignInAt: '2026-11-05T10:00:00.000Z',
          plan: 'free',
        });
        expect((await service.findOne(never)).lastSignInAt).toBeNull();
      } finally {
        await ds.query(`DELETE FROM auth_events WHERE user_id = $1`, [heavy]);
      }
    });

    it('exports the filtered list up to the cap, audited with what was asked', async () => {
      const filters = Object.assign(new AdminTenantsFilterDto(), { search: DOMAIN, activity: 'never_used' as const });

      const result = await service.exportCsv(filters, actor, 2);

      expect(result.rowCount).toBe(2);
      expect(result.truncated).toBe(true);
      const lines = result.csv.split('\r\n').filter((line) => line.length > 0);
      expect(lines[0]).toBe(TENANT_CSV_HEADER.join(','));
      expect(lines).toHaveLength(3);
      expect(lines[1].split(',').slice(0, 2)).toEqual([fresh, `fresh${DOMAIN}`]);
      expect(lines[2].split(',').slice(0, 2)).toEqual([never, `never${DOMAIN}`]);
      for (const line of lines) expect(line.split(',')).toHaveLength(TENANT_CSV_HEADER.length);

      const [audit] = await ds.query(
        `SELECT action, actor_id, target_type, metadata FROM admin_audit_logs
          WHERE action = 'tenants.exported' AND actor_id = $1`,
        [actor.userId],
      );
      expect(audit).toEqual({
        action: 'tenants.exported',
        actor_id: actor.userId,
        target_type: 'tenant_list',
        metadata: {
          filters: { search: DOMAIN, activity: 'never_used', sort: 'created_at', order: 'desc' },
          rowCount: 2,
          rowCap: 2,
          truncated: true,
        },
      });
    });

    it('exports usage columns sorted as asked, and says when nothing was cut', async () => {
      const filters = Object.assign(new AdminTenantsFilterDto(), {
        search: DOMAIN,
        sort: 'messages_sent_30d' as const,
      });

      const result = await service.exportCsv(filters, actor);

      expect(result.truncated).toBe(false);
      const [, first] = result.csv.split('\r\n');
      const cells = first.split(',');
      const column = (name: (typeof TENANT_CSV_HEADER)[number]) => cells[TENANT_CSV_HEADER.indexOf(name)];
      expect(cells[0]).toBe(heavy);
      expect(column('projects')).toBe('1');
      expect(column('mau_this_month')).toBe('5');
      expect(column('messages_sent_30d')).toBe('50');
      expect(column('last_usage_day')).toBe('2026-11-13');
      expect(column('counted_through')).toBe('2026-11-13');
      expect(column('status')).toBe('active');
      expect(column('signed_up_at')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(result.csv).not.toContain(PASSWORD_HASH);
    });

    it('gives nothing counted before the roll-up has run', async () => {
      await ds.query(`DELETE FROM usage_rollup_state`);
      const { data, meta } = await service.list(listQuery({ limit: 100 }));
      expect(meta.countedThrough).toBeNull();
      expect(meta.mauFrom).toBeNull();
      expect(data.find((t) => t.id === heavy)).toMatchObject({ mauThisMonth: 0, messagesSent30d: 0, lastUsageDay: null });
    });
  });

  describe('list query count', () => {
    it('issues the same bounded number of queries for 1 tenant and for 50', async () => {
      const seedTenant = async (localPart: string) => {
        const id = await tenant(localPart, { createdDaysAgo: 1 });
        const projectId = await project(id);
        await identity(projectId);
        await click(await link(projectId));
      };

      await seedTenant('single-qz');
      const one = await queriesDuring(() =>
        service.list(listQuery({ search: `single-qz${DOMAIN}`, limit: 100 })),
      );

      for (let i = 0; i < 50; i++) await seedTenant(`many-qz${i}`);
      const many = await queriesDuring(() =>
        service.list(listQuery({ search: 'many-qz', limit: 100 })),
      );

      expect(many).toHaveLength(one.length);
      // The page, its total, and five metrics.
      expect(many.length).toBeLessThanOrEqual(7);

      const { data } = await service.list(listQuery({ search: 'many-qz', limit: 100 }));
      expect(data).toHaveLength(50);
      expect(data.every((row) => row.projectCount === 1 && row.clicksLast30d === 1)).toBe(true);
    });
  });

  describe('password hash', () => {
    it('is never selected nor returned, by the list or the detail', async () => {
      const id = await tenant('secretive');

      let listed: unknown;
      let detail: unknown;
      const sql = await queriesDuring(async () => {
        listed = await service.list(listQuery({ search: `secretive${DOMAIN}` }));
        detail = await service.findOne(id);
      });

      expect(sql.join('\n')).not.toMatch(/password_hash/);
      for (const body of [JSON.stringify(listed), JSON.stringify(detail)]) {
        expect(body).toContain(`secretive${DOMAIN}`);
        expect(body).not.toContain(PASSWORD_HASH);
        expect(body).not.toContain('passwordHash');
      }
    });

    it('is not selected by suspend or reactivate either', async () => {
      const id = await tenant('secretive');
      const sql = await queriesDuring(async () => {
        await service.suspend(id, REASON, actor);
        await service.suspend(id, REASON, actor).catch(() => undefined);
        await service.reactivate(id, REASON, actor);
        await service.reactivate(id, REASON, actor).catch(() => undefined);
      });
      expect(sql.join('\n')).not.toMatch(/password_hash/);
    });
  });

  describe('findOne', () => {
    it('returns per-project counts with no bleed between projects or tenants', async () => {
      const owner = await tenant('owner');
      const busy = await project(owner, 'busy');
      const quiet = await project(owner, 'quiet');

      const busyLink = await link(busy);
      await link(busy);
      await identity(busy);
      await click(busyLink);
      await click(busyLink, 45);
      await apiKey(busy);
      await apiKey(busy, { expiresInDays: 30 });
      await apiKey(busy, { isActive: false });
      await apiKey(busy, { expiresInDays: -1 });

      const stranger = await tenant('stranger');
      const strangerApp = await project(stranger, 'stranger-app');
      await click(await link(strangerApp));
      await identity(strangerApp);
      await apiKey(strangerApp);

      const detail = await service.findOne(owner);

      expect(detail).toMatchObject({
        projectCount: 2,
        linkCount: 2,
        identityCount: 1,
        clicksLast30d: 1,
      });
      expect(detail.projects).toHaveLength(2);
      expect(detail.projects.find((p) => p.id === busy)).toMatchObject({
        name: 'busy',
        linkCount: 2,
        identityCount: 1,
        clicksLast30d: 1,
        activeApiKeyCount: 2,
      });
      expect(detail.projects.find((p) => p.id === quiet)).toMatchObject({
        name: 'quiet',
        linkCount: 0,
        identityCount: 0,
        clicksLast30d: 0,
        activeApiKeyCount: 0,
      });
    });

    it('returns the last 20 audit rows for this target only, newest first', async () => {
      const id = await tenant('audited');
      const other = await tenant('other');

      for (let i = 0; i < 23; i++) {
        await ds.query(
          `INSERT INTO admin_audit_logs (actor_email, action, target_type, target_id, target_label, reason, created_at)
           VALUES ($1, 'tenant.suspended', 'tenant', $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
          [actor.email, id, `audited${DOMAIN}`, `entry ${i}`, i],
        );
      }
      await ds.query(
        `INSERT INTO admin_audit_logs (actor_email, action, target_type, target_id, target_label, reason)
         VALUES ($1, 'tenant.suspended', 'tenant', $2, $3, 'not this tenant')`,
        [actor.email, other, `other${DOMAIN}`],
      );

      const { recentAudit } = await service.findOne(id);

      expect(recentAudit).toHaveLength(20);
      expect(recentAudit.map((row) => row.reason)).toEqual(
        Array.from({ length: 20 }, (_, i) => `entry ${i}`),
      );
      expect(typeof recentAudit[0].createdAt).toBe('string');
    });

    it('is 404 for an unknown id', async () => {
      await expect(service.findOne(randomUUID())).rejects.toThrow(NotFoundException);
    });
  });

  describe('suspend', () => {
    it('suspends, audits in full, and returns the new detail', async () => {
      const id = await tenant('target');

      const detail = await service.suspend(id, REASON, actor);

      expect(detail.status).toBe('suspended');
      expect(detail.suspendedReason).toBe(REASON);
      expect(detail.recentAudit).toHaveLength(1);

      const [row] = await auditRowsFor(id);
      expect(row).toMatchObject({
        actorId: actor.userId,
        actorEmail: actor.email,
        action: 'tenant.suspended',
        targetType: 'tenant',
        targetId: id,
        targetLabel: `target${DOMAIN}`,
        reason: REASON,
        ipAddress: '203.0.113.7',
      });
    });

    it('refuses a second suspend with a 409, one audit row, and the first reason kept', async () => {
      const id = await tenant('target');
      await service.suspend(id, REASON, actor);

      await expect(service.suspend(id, 'a different reason', actor)).rejects.toThrow(
        ConflictException,
      );

      expect(await auditRowsFor(id)).toHaveLength(1);
      expect((await stateOf(id)).suspended_reason).toBe(REASON);
    });

    it('lets exactly one of several simultaneous suspends through', async () => {
      const id = await tenant('target');

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => service.suspend(id, REASON, actor)),
      );

      const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(refused).toHaveLength(4);
      for (const { reason } of refused) expect(reason).toBeInstanceOf(ConflictException);
      expect(await auditRowsFor(id)).toHaveLength(1);
    });

    it('refuses a super admin, including the actor, with no audit row', async () => {
      const otherAdmin = await tenant('other-admin', { isSuperAdmin: true });

      for (const id of [otherAdmin, actor.userId]) {
        await expect(service.suspend(id, REASON, actor)).rejects.toThrow(ConflictException);
        expect((await stateOf(id)).suspended_at).toBeNull();
        expect(await auditRowsFor(id)).toHaveLength(0);
      }
    });

    it('is 404 for an unknown id', async () => {
      await expect(service.suspend(randomUUID(), REASON, actor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reactivate', () => {
    it('clears both columns and audits', async () => {
      const id = await tenant('target', { suspended: true });

      const detail = await service.reactivate(id, 'appeal upheld by support', actor);

      expect(detail).toMatchObject({
        status: 'active',
        suspendedAt: null,
        suspendedReason: null,
      });
      expect(await stateOf(id)).toEqual({ suspended_at: null, suspended_reason: null });

      const [row] = await auditRowsFor(id);
      expect(row).toMatchObject({
        action: 'tenant.reactivated',
        targetType: 'tenant',
        targetLabel: `target${DOMAIN}`,
        reason: 'appeal upheld by support',
        actorId: actor.userId,
        ipAddress: '203.0.113.7',
      });
    });

    it('is 409 when not suspended, with no audit row', async () => {
      const id = await tenant('target');
      await expect(service.reactivate(id, REASON, actor)).rejects.toThrow(ConflictException);
      expect(await auditRowsFor(id)).toHaveLength(0);
    });

    it('lets exactly one of several simultaneous reactivations through', async () => {
      const id = await tenant('target', { suspended: true });

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => service.reactivate(id, REASON, actor)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await auditRowsFor(id)).toHaveLength(1);
    });

    it('is 404 for an unknown id', async () => {
      await expect(service.reactivate(randomUUID(), REASON, actor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('state change and audit row commit together', () => {
    // A real Postgres failure, value too long for actor_email, not a thrown mock:
    // only a real transaction undoes the UPDATE that already ran.
    const unauditable = (): AdminActor => ({ ...actor, email: `${'x'.repeat(300)}${DOMAIN}` });

    it('rolls a suspend back when the audit insert fails', async () => {
      const id = await tenant('target');

      await expect(service.suspend(id, REASON, unauditable())).rejects.toThrow(/too long/);

      expect(await stateOf(id)).toEqual({ suspended_at: null, suspended_reason: null });
      expect(await auditRowsFor(id)).toHaveLength(0);
    });

    it('rolls a reactivate back when the audit insert fails', async () => {
      const id = await tenant('target', { suspended: true });

      await expect(service.reactivate(id, REASON, unauditable())).rejects.toThrow(/too long/);

      expect((await stateOf(id)).suspended_reason).toBe('previously suspended');
      expect(await auditRowsFor(id)).toHaveLength(0);
    });

    // The audit insert succeeds and then the work fails: the row only disappears
    // if it was written through the transaction's manager.
    it('rolls back an audit row already written when the work then fails', async () => {
      const id = await tenant('target');
      const auditService = (service as unknown as { auditService: AdminAuditService }).auditService;
      const realRecord = auditService.record.bind(auditService);
      const spy = jest.spyOn(auditService, 'record').mockImplementation(async (...args) => {
        await realRecord(...args);
        throw new Error('failed after the audit insert');
      });

      try {
        await expect(service.suspend(id, REASON, actor)).rejects.toThrow(/after the audit insert/);
      } finally {
        spy.mockRestore();
      }

      expect(await auditRowsFor(id)).toHaveLength(0);
      expect((await stateOf(id)).suspended_at).toBeNull();
    });

    it('writes no audit row when the state change itself fails', async () => {
      const id = await tenant('target');
      const doomed = 'a reason the database rejects';
      await ds.query(
        `ALTER TABLE users ADD CONSTRAINT ws2_int_reject_reason
         CHECK (suspended_reason IS DISTINCT FROM '${doomed}') NOT VALID`,
      );
      try {
        await expect(service.suspend(id, doomed, actor)).rejects.toThrow(/ws2_int_reject_reason/);
      } finally {
        await ds.query(`ALTER TABLE users DROP CONSTRAINT ws2_int_reject_reason`);
      }

      expect(await auditRowsFor(id)).toHaveLength(0);
      expect((await stateOf(id)).suspended_at).toBeNull();
    });
  });
});

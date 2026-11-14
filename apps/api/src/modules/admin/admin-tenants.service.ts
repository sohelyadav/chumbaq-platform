import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Not, Repository } from 'typeorm';
import type {
  AdminAuditAction,
  AdminTenantDetail,
  AdminTenantProject,
  AdminTenantSort,
  AdminTenantSummary,
} from '@chumbaq/shared';
import {
  announceRequesterResetsCancelled,
  cancelAllRequestedBy,
} from '../factor-resets/cancel-requested-by';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { SeatsService } from '../project-access/seats.service';
import { effectiveProjectLimit } from '../projects/projects.service';
import { UserEntity } from '../users/entities/user.entity';
import { AdminAuditService } from './admin-audit.service';
import { toAuditLog } from './admin-audit-logs.service';
import { AdminTenantsFilterDto, ListAdminTenantsDto } from './dto/admin-tenants.dto';
import { QUIET_AFTER_DAYS, TenantUsageAggregate, tenantUsageCte } from './admin-usage.service';
import { readUsageCoverage } from '../usage/usage-rollup.service';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';

export interface AdminActor {
  userId: string;
  email: string;
  ipAddress: string;
}

/** What to total by: a tenant's whole account, or each of its projects. */
type MetricGroup = 'p.owner_id' | 'p.id';

/** Every metric row, whatever the query behind it. */
type MetricRow<T> = { key: string; value: T };

const RECENT_AUDIT_LIMIT = 20;

/** Never include `passwordHash`: this is what makes the list safe to return. */
const TENANT_COLUMNS = [
  'user.id',
  'user.email',
  'user.name',
  'user.isSuperAdmin',
  'user.suspendedAt',
  'user.suspendedReason',
  'user.createdAt',
];

/** A tenant's own columns, as the list query and the entity both give them. */
interface TenantRow {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  createdAt: Date;
}

/** A list row: the tenant, its usage (null when it has none) and the filtered total. */
interface TenantListRow extends TenantRow {
  mau: string | null;
  messages: string | null;
  lastUsageDay: string | null;
  total: string;
}

/** Signed up within this many days counts as new. */
const NEW_TENANT_DAYS = 30;

/**
 * The SQL for each sort, chosen from this fixed map and never from the input.
 * Usage columns are null for a tenant with no usage, which sorts last either way.
 */
const SORT_COLUMNS: Record<AdminTenantSort, string> = {
  created_at: 'u.created_at',
  mau_this_month: 'usage.mau_this_month',
  messages_sent_30d: 'usage.messages_sent_30d',
  last_usage_day: 'usage.last_usage_day',
};

/**
 * The tenants matching `filters`, sorted, with their usage as of `through`
 * (the last counted day, or null before any): one statement and its
 * parameters, `$1` being `through`. The caller appends any LIMIT.
 */
export function filteredTenantsSql(
  filters: AdminTenantsFilterDto,
  through: string | null,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [through];
  const where: string[] = [];
  if (filters.search) {
    params.push(`%${escapeLikePattern(filters.search)}%`);
    const n = params.length;
    where.push(`(u.email ILIKE $${n} ESCAPE '\\' OR u.name ILIKE $${n} ESCAPE '\\')`);
  }
  if (filters.status === 'active') where.push('u.suspended_at IS NULL');
  if (filters.status === 'suspended') where.push('u.suspended_at IS NOT NULL');
  // `created_at` is a plain timestamp in the session's zone; compared with an
  // instant it is read in that same zone, so this is the right 30 days.
  if (filters.activity === 'new') where.push(`u.created_at >= now() - INTERVAL '${NEW_TENANT_DAYS} days'`);
  if (filters.activity === 'quiet') where.push(`usage.last_usage_day <= $1::date - ${QUIET_AFTER_DAYS}`);
  if (filters.activity === 'never_used') where.push('usage.last_usage_day IS NULL');

  const direction = filters.order === 'asc' ? 'ASC' : 'DESC';
  const sql = `
    WITH usage AS (${tenantUsageCte('$1::date')})
    SELECT u.id, u.email, u.name,
           u.is_super_admin AS "isSuperAdmin",
           u.suspended_at AS "suspendedAt",
           u.suspended_reason AS "suspendedReason",
           u.created_at AS "createdAt",
           usage.mau_this_month::text AS mau,
           usage.messages_sent_30d::text AS messages,
           to_char(usage.last_usage_day, 'YYYY-MM-DD') AS "lastUsageDay",
           count(*) OVER ()::text AS total
      FROM users u
      LEFT JOIN usage ON usage.owner_id = u.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${SORT_COLUMNS[filters.sort] ?? SORT_COLUMNS.created_at} ${direction} NULLS LAST,
              u.created_at DESC, u.id DESC`;
  return { sql, params };
}

function usageOfRow(row: Pick<TenantListRow, 'mau' | 'messages' | 'lastUsageDay'>): TenantUsageAggregate {
  return {
    mauThisMonth: Number(row.mau ?? 0),
    messagesSent30d: Number(row.messages ?? 0),
    lastUsageDay: row.lastUsageDay,
  };
}

/** `\` first, or it would re-escape the backslashes added for `%` and `_`. */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function toCountMap(rows: MetricRow<string>[]): Map<string, number> {
  return new Map(rows.map((row) => [row.key, Number(row.value)]));
}

@Injectable()
export class AdminTenantsService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(AdminAuditLogEntity)
    private readonly auditLogRepository: Repository<AdminAuditLogEntity>,
    private readonly auditService: AdminAuditService,
    private readonly notices: SecurityNoticesService,
    private readonly seats: SeatsService,
    // Optional so the many tests that build this by hand need not pass it; the
    // limit shown then is the built-in default.
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * One statement for the page and its total, so sorting and filtering by
   * usage happen in the database; never selects the password hash.
   */
  async list(query: ListAdminTenantsDto): Promise<{
    data: AdminTenantSummary[];
    meta: { total: number; page: number; limit: number; totalPages: number; countedThrough: string | null };
  }> {
    const manager = this.userRepository.manager;
    const coverage = await readUsageCoverage(manager);
    const countedThrough = coverage?.countedThrough ?? null;
    const { sql, params } = filteredTenantsSql(query, countedThrough);
    const rows: TenantListRow[] = await manager.query(
      `${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, query.skip],
    );
    let total = rows.length > 0 ? Number(rows[0].total) : 0;
    if (rows.length === 0 && query.skip > 0) {
      // Past the last page no row carries the total.
      const [{ count }] = await manager.query(`SELECT count(*)::int AS count FROM (${sql}) matched`, params);
      total = count;
    }

    return {
      data: await this.summarise(rows, new Map(rows.map((row) => [row.id, usageOfRow(row)]))),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
        countedThrough,
      },
    };
  }

  /**
   * A staff member opening a tenant: the detail is only returned once the read is
   * recorded, deduplicated per `READ_DEDUPE_WINDOW_MINUTES` so refetches do not
   * flood the log. Suspend and reactivate return `findOne` directly, since they
   * already leave their own row.
   */
  async view(id: string, actor: AdminActor): Promise<AdminTenantDetail> {
    const detail = await this.findOne(id);
    await this.auditService.recordRead({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: 'tenant.viewed',
      targetType: 'tenant',
      targetId: id,
      targetLabel: detail.email,
      ipAddress: actor.ipAddress || null,
    });
    return detail;
  }

  async findOne(id: string): Promise<AdminTenantDetail> {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .select([...TENANT_COLUMNS, 'user.projectLimit', 'user.seatLimit'])
      .where('user.id = :id', { id })
      .getOne();
    if (!user) {
      throw new NotFoundException('Tenant not found');
    }

    const coverage = await readUsageCoverage(this.userRepository.manager);
    const [usage, [summary], projects, recentAudit, seatsUsed, lastSignInAt] = await Promise.all([
      this.usageOf(id, coverage?.countedThrough ?? null),
      this.summarise([user]),
      this.projectsOf(id),
      // Views are left out: a busy tenant's would push its suspensions off this
      // short list. The audit log, filtered to the tenant, shows them.
      this.auditLogRepository.find({
        where: { targetId: id, action: Not('tenant.viewed' as const) },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: RECENT_AUDIT_LIMIT,
      }),
      this.seats.count(id, this.userRepository.manager),
      this.lastSignIn(id),
    ]);

    return {
      ...summary,
      ...usage,
      projectLimit: user.projectLimit,
      effectiveProjectLimit: effectiveProjectLimit(user.projectLimit, this.config),
      seatLimit: user.seatLimit,
      effectiveSeatLimit: this.seats.limitFor(user.seatLimit),
      seatsUsed,
      projects,
      recentAudit: recentAudit.map(toAuditLog),
      lastSignInAt,
      // Every account is on the one plan until there are others.
      plan: 'free',
    };
  }

  /**
   * Sets or clears (null) the account's own project limit. Lowering it removes
   * nothing: the account keeps its projects and only creating another is refused.
   * The UPDATE takes the row lock `ProjectsService.create` counts under, so a create
   * in flight finishes on the old limit and the next one sees the new.
   */
  async setProjectLimit(
    id: string,
    projectLimit: number | null,
    reason: string,
    actor: AdminActor,
  ): Promise<AdminTenantDetail> {
    await this.userRepository.manager.transaction(async (manager) => {
      const before = await manager.findOne(UserEntity, {
        where: { id },
        select: { id: true, email: true, projectLimit: true },
        lock: { mode: 'for_no_key_update' },
      });
      if (!before) throw new NotFoundException('Tenant not found');

      await manager.update(UserEntity, { id }, { projectLimit });
      await this.auditService.record(
        {
          actorId: actor.userId,
          actorEmail: actor.email,
          action: 'account.project_limit_changed',
          targetType: 'tenant',
          targetId: id,
          targetLabel: before.email,
          reason,
          metadata: {
            before: before.projectLimit,
            after: projectLimit,
            defaultLimit: effectiveProjectLimit(null, this.config),
          },
          ipAddress: actor.ipAddress || null,
        },
        manager,
      );
    });

    return this.findOne(id);
  }

  /**
   * Sets or clears (null) the account's own seat limit. Lowering it removes nobody:
   * only new invitations are refused. Locks just the user row, like `setProjectLimit`;
   * the invite and accept paths hold this row before they count.
   */
  async setSeatLimit(
    id: string,
    seatLimit: number | null,
    reason: string,
    actor: AdminActor,
  ): Promise<AdminTenantDetail> {
    await this.userRepository.manager.transaction(async (manager) => {
      const before = await manager.findOne(UserEntity, {
        where: { id },
        select: { id: true, email: true, seatLimit: true },
        lock: { mode: 'for_no_key_update' },
      });
      if (!before) throw new NotFoundException('Tenant not found');

      await manager.update(UserEntity, { id }, { seatLimit });
      await this.auditService.record(
        {
          actorId: actor.userId,
          actorEmail: actor.email,
          action: 'account.seat_limit_changed',
          targetType: 'tenant',
          targetId: id,
          targetLabel: before.email,
          reason,
          metadata: {
            before: before.seatLimit,
            after: seatLimit,
            defaultLimit: this.seats.limitFor(null),
          },
          ipAddress: actor.ipAddress || null,
        },
        manager,
      );
    });

    return this.findOne(id);
  }

  async suspend(id: string, reason: string, actor: AdminActor): Promise<AdminTenantDetail> {
    // Two steps, as a revoke: the suspension first, alone on this one row, so nothing
    // can hold it off; then, with `request` refusing this person from that commit on,
    // the cancel of every reset they asked for (`lockResetTargetsOf`).
    await this.userRepository.manager.transaction(async (manager) => {
      // The condition is the concurrency control: of two simultaneous suspends
      // the second blocks on the row, re-checks after the first commits, and
      // matches nothing, so it never reaches the audit insert.
      const result = await manager
        .createQueryBuilder()
        .update(UserEntity)
        // The version too, so tokens from before the suspension do not come back
        // to life on reactivation.
        .set({
          suspendedAt: () => 'NOW()',
          suspendedReason: reason,
          sessionVersion: () => 'session_version + 1',
        })
        .where('id = :id AND suspended_at IS NULL AND is_super_admin = false', { id })
        .returning('email')
        .execute();

      if (!result.affected) {
        throw await this.suspendRefusal(manager, id);
      }
      await this.recordAudit(manager, 'tenant.suspended', id, result.raw[0].email, reason, actor);
    });
    // Only someone already revoked can be suspended, and revoking cancels these, but a
    // reset left behind must not run on a suspended account's word.
    const cancelled = await cancelAllRequestedBy(
      (work) => this.userRepository.manager.transaction(work),
      id,
      'all',
      'requester_suspended',
      actor,
    );
    // Once committed, as every other cancel: each owner was warned in this person's name.
    announceRequesterResetsCancelled(this.notices, cancelled);

    return this.findOne(id);
  }

  async reactivate(id: string, reason: string, actor: AdminActor): Promise<AdminTenantDetail> {
    await this.userRepository.manager.transaction(async (manager) => {
      // Locked so that concurrent reactivations cannot shift the runs twice.
      await manager.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [id]);
      await this.shiftJourneysPastSuspension(manager, id);

      const result = await manager
        .createQueryBuilder()
        .update(UserEntity)
        .set({ suspendedAt: null, suspendedReason: null })
        .where('id = :id AND suspended_at IS NOT NULL', { id })
        .returning('email')
        .execute();

      if (!result.affected) {
        const exists = await manager.existsBy(UserEntity, { id });
        throw exists
          ? new ConflictException('Tenant is not suspended')
          : new NotFoundException('Tenant not found');
      }
      await this.recordAudit(manager, 'tenant.reactivated', id, result.raw[0].email, reason, actor);
    });

    return this.findOne(id);
  }

  /**
   * Journey runs wait out a suspension, so without this every overdue step would
   * fire at once on reactivation: days-late messages, and a backlog older than
   * anyone else's filling the oldest-first scheduler read. Moving them by the
   * length of the suspension keeps each person's spacing between steps.
   */
  private async shiftJourneysPastSuspension(manager: EntityManager, id: string): Promise<void> {
    await manager.query(
      `UPDATE journey_runs r
          SET next_due_at = r.next_due_at + (now() - u.suspended_at)
         FROM projects p
         JOIN users u ON u.id = p.owner_id
        WHERE r.project_id = p.id
          AND u.id = $1
          AND u.suspended_at IS NOT NULL
          AND r.status = 'active'
          AND r.next_due_at IS NOT NULL`,
      [id],
    );
  }

  /** Says why the conditional UPDATE matched nothing. */
  private async suspendRefusal(manager: EntityManager, id: string): Promise<Error> {
    const target = await manager.findOne(UserEntity, {
      where: { id },
      select: { id: true, isSuperAdmin: true, suspendedAt: true },
    });
    if (!target) return new NotFoundException('Tenant not found');
    if (target.isSuperAdmin) return new ConflictException('A super admin cannot be suspended');
    if (target.suspendedAt) return new ConflictException('Tenant is already suspended');
    // Suspended and reactivated by someone else between the UPDATE and this read.
    return new ConflictException('Tenant changed during the request, try again');
  }

  private recordAudit(
    manager: EntityManager,
    action: AdminAuditAction,
    targetId: string,
    email: string,
    reason: string,
    actor: AdminActor,
  ) {
    return this.auditService.record(
      {
        actorId: actor.userId,
        actorEmail: actor.email,
        action,
        targetType: 'tenant',
        targetId,
        targetLabel: email,
        reason,
        ipAddress: actor.ipAddress || null,
      },
      manager,
    );
  }

  /** One tenant's usage figures: 0, 0 and null when it has none. */
  private async usageOf(ownerId: string, through: string | null): Promise<TenantUsageAggregate> {
    const [row]: TenantListRow[] = await this.userRepository.manager.query(
      `SELECT mau_this_month::text AS mau, messages_sent_30d::text AS messages,
              to_char(last_usage_day, 'YYYY-MM-DD') AS "lastUsageDay"
         FROM (${tenantUsageCte('$1::date')}) usage
        WHERE owner_id = $2`,
      [through, ownerId],
    );
    return row ? usageOfRow(row) : { mauThisMonth: 0, messagesSent30d: 0, lastUsageDay: null };
  }

  /** The latest successful sign-in still in the sign-in history. */
  private async lastSignIn(userId: string): Promise<string | null> {
    const [row]: { at: Date | null }[] = await this.userRepository.manager.query(
      `SELECT max(created_at) AS at FROM auth_events WHERE user_id = $1 AND type = 'login.succeeded'`,
      [userId],
    );
    return row?.at ? new Date(row.at).toISOString() : null;
  }

  /** Issues the same number of queries for one tenant as for a full page. */
  private async summarise(
    users: TenantRow[],
    usage: Map<string, TenantUsageAggregate> = new Map(),
  ): Promise<AdminTenantSummary[]> {
    if (users.length === 0) return [];

    const ownerIds = users.map((user) => user.id);
    const [projects, links, identities, clicks, lastClicks] = await Promise.all([
      this.projectCounts(ownerIds),
      this.linkCounts(ownerIds, 'p.owner_id'),
      this.identityCounts(ownerIds, 'p.owner_id'),
      this.recentClickCounts(ownerIds, 'p.owner_id'),
      this.lastClicks(ownerIds),
    ]);

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.suspendedAt ? 'suspended' : 'active',
      isSuperAdmin: user.isSuperAdmin,
      suspendedAt: user.suspendedAt?.toISOString() ?? null,
      suspendedReason: user.suspendedReason,
      createdAt: user.createdAt.toISOString(),
      projectCount: projects.get(user.id) ?? 0,
      linkCount: links.get(user.id) ?? 0,
      identityCount: identities.get(user.id) ?? 0,
      clicksLast30d: clicks.get(user.id) ?? 0,
      lastActivityAt: lastClicks.get(user.id)?.toISOString() ?? null,
      mauThisMonth: usage.get(user.id)?.mauThisMonth ?? 0,
      messagesSent30d: usage.get(user.id)?.messagesSent30d ?? 0,
      lastUsageDay: usage.get(user.id)?.lastUsageDay ?? null,
    }));
  }

  private async projectsOf(ownerId: string): Promise<AdminTenantProject[]> {
    const ownerIds = [ownerId];
    const [projects, links, identities, clicks, apiKeys] = await Promise.all([
      this.userRepository.manager.query(
        `SELECT id, name, domain, created_at AS "createdAt"
         FROM projects WHERE owner_id = $1
         ORDER BY created_at DESC, id DESC`,
        [ownerId],
      ) as Promise<{ id: string; name: string; domain: string | null; createdAt: Date }[]>,
      this.linkCounts(ownerIds, 'p.id'),
      this.identityCounts(ownerIds, 'p.id'),
      this.recentClickCounts(ownerIds, 'p.id'),
      this.activeApiKeyCounts(ownerIds),
    ]);

    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      domain: project.domain,
      createdAt: project.createdAt.toISOString(),
      linkCount: links.get(project.id) ?? 0,
      identityCount: identities.get(project.id) ?? 0,
      clicksLast30d: clicks.get(project.id) ?? 0,
      activeApiKeyCount: apiKeys.get(project.id) ?? 0,
    }));
  }

  private async counts(sql: string, ownerIds: string[]): Promise<Map<string, number>> {
    return toCountMap(await this.userRepository.manager.query(sql, [ownerIds]));
  }

  private projectCounts(ownerIds: string[]) {
    return this.counts(
      `SELECT p.owner_id AS key, COUNT(*) AS value
       FROM projects p
       WHERE p.owner_id = ANY($1::uuid[])
       GROUP BY p.owner_id`,
      ownerIds,
    );
  }

  private linkCounts(ownerIds: string[], group: MetricGroup) {
    return this.counts(
      `SELECT ${group} AS key, COUNT(*) AS value
       FROM links l
       JOIN projects p ON p.id = l.project_id
       WHERE p.owner_id = ANY($1::uuid[])
       GROUP BY ${group}`,
      ownerIds,
    );
  }

  private identityCounts(ownerIds: string[], group: MetricGroup) {
    return this.counts(
      `SELECT ${group} AS key, COUNT(*) AS value
       FROM device_identities di
       JOIN projects p ON p.id = di.project_id
       WHERE p.owner_id = ANY($1::uuid[])
       GROUP BY ${group}`,
      ownerIds,
    );
  }

  // NOW() rather than a bound Date: `clicked_at` is a plain timestamp written by
  // its NOW() default, so this compares in the same session timezone it was
  // written in.
  private recentClickCounts(ownerIds: string[], group: MetricGroup) {
    return this.counts(
      `SELECT ${group} AS key, COUNT(*) AS value
       FROM click_events c
       JOIN links l ON l.id = c.link_id
       JOIN projects p ON p.id = l.project_id
       WHERE p.owner_id = ANY($1::uuid[])
         AND c.clicked_at >= NOW() - INTERVAL '30 days'
       GROUP BY ${group}`,
      ownerIds,
    );
  }

  private activeApiKeyCounts(ownerIds: string[]) {
    return this.counts(
      `SELECT p.id AS key, COUNT(*) AS value
       FROM api_keys k
       JOIN projects p ON p.id = k.project_id
       WHERE p.owner_id = ANY($1::uuid[])
         AND k.is_active = true
         AND (k.expires_at IS NULL OR k.expires_at > NOW())
       GROUP BY p.id`,
      ownerIds,
    );
  }

  // One index probe per link on (link_id, clicked_at). A plain MAX(clicked_at)
  // grouped by owner would read every click the tenant ever received.
  private async lastClicks(ownerIds: string[]): Promise<Map<string, Date>> {
    const rows: MetricRow<Date>[] = await this.userRepository.manager.query(
      `SELECT p.owner_id AS key, MAX(latest.clicked_at) AS value
       FROM projects p
       JOIN links l ON l.project_id = p.id
       CROSS JOIN LATERAL (
         SELECT c.clicked_at FROM click_events c
         WHERE c.link_id = l.id
         ORDER BY c.clicked_at DESC
         LIMIT 1
       ) latest
       WHERE p.owner_id = ANY($1::uuid[])
       GROUP BY p.owner_id`,
      [ownerIds],
    );
    return new Map(rows.map((row) => [row.key, row.value]));
  }
}

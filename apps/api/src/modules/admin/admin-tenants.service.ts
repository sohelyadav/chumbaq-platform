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
import { ListAdminTenantsDto } from './dto/admin-tenants.dto';
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

  async list(query: ListAdminTenantsDto): Promise<{
    data: AdminTenantSummary[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const qb = this.userRepository
      .createQueryBuilder('user')
      .select(TENANT_COLUMNS)
      // The id breaks ties, so a row cannot repeat or vanish across pages.
      .orderBy('user.createdAt', 'DESC')
      .addOrderBy('user.id', 'DESC')
      .skip(query.skip)
      .take(query.limit);

    if (query.search) {
      qb.andWhere(`(user.email ILIKE :search ESCAPE '\\' OR user.name ILIKE :search ESCAPE '\\')`, {
        search: `%${escapeLikePattern(query.search)}%`,
      });
    }
    if (query.status === 'active') {
      qb.andWhere('user.suspendedAt IS NULL');
    } else if (query.status === 'suspended') {
      qb.andWhere('user.suspendedAt IS NOT NULL');
    }

    const [users, total] = await qb.getManyAndCount();

    return {
      data: await this.summarise(users),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
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

    const [[summary], projects, recentAudit, seatsUsed] = await Promise.all([
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
    ]);

    return {
      ...summary,
      projectLimit: user.projectLimit,
      effectiveProjectLimit: effectiveProjectLimit(user.projectLimit, this.config),
      seatLimit: user.seatLimit,
      effectiveSeatLimit: this.seats.limitFor(user.seatLimit),
      seatsUsed,
      projects,
      recentAudit: recentAudit.map(toAuditLog),
      lastSignInAt: null,
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

  /** Issues the same number of queries for one tenant as for a full page. */
  private async summarise(users: UserEntity[]): Promise<AdminTenantSummary[]> {
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
      mauThisMonth: 0,
      messagesSent30d: 0,
      lastUsageDay: null,
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

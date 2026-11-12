import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { AdminAuditAction } from '@chumbaq/shared';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';

export interface AdminAuditEntry {
  actorId: string | null;
  actorEmail: string;
  action: AdminAuditAction;
  targetType: string;
  targetId?: string | null;
  targetLabel?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/**
 * A staff member's reads of one tenant are recorded once per this window. Ten
 * minutes covers a sitting on the tenant's page (refetches, reloads, a second tab)
 * as one visit, while a return later in the day is still a new row: the log says
 * who looked at whom and roughly when, which is the question it has to answer,
 * without one row per request.
 */
export const READ_DEDUPE_WINDOW_MINUTES = 10;

export interface AdminReadEntry extends AdminAuditEntry {
  actorId: string;
  targetId: string;
}

/** The log is append-only, so this deliberately has no update or delete. */
@Injectable()
export class AdminAuditService {
  constructor(
    @InjectRepository(AdminAuditLogEntity)
    private readonly auditRepository: Repository<AdminAuditLogEntity>,
  ) {}

  /** Pass `manager` to write in the same transaction as the state change. */
  record(entry: AdminAuditEntry, manager?: EntityManager): Promise<AdminAuditLogEntity> {
    const repository = manager
      ? manager.getRepository(AdminAuditLogEntity)
      : this.auditRepository;

    return repository.save(
      repository.create({
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel ?? null,
        reason: entry.reason ?? null,
        metadata: entry.metadata ?? null,
        ipAddress: entry.ipAddress ?? null,
      }),
    );
  }

  /**
   * Records a read unless the same actor's same read of the same target is already
   * in the window. Resolves to whether a row was written.
   */
  recordRead(entry: AdminReadEntry): Promise<boolean> {
    return this.auditRepository.manager.transaction(async (manager) => {
      // Without the lock two tabs loading at once would each find nothing and both
      // write. Scoped to this actor and target, and released at commit.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `admin-read:${entry.actorId}:${entry.targetId}:${entry.action}`,
      ]);
      const recent: unknown[] = await manager.query(
        `SELECT 1 FROM admin_audit_logs
          WHERE actor_id = $1 AND target_id = $2 AND action = $3
            AND created_at > now() - make_interval(mins => $4)
          LIMIT 1`,
        [entry.actorId, entry.targetId, entry.action, READ_DEDUPE_WINDOW_MINUTES],
      );
      if (recent.length > 0) return false;
      await this.record(entry, manager);
      return true;
    });
  }
}

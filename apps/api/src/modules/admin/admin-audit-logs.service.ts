import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import type { AdminAuditLog } from '@chumbaq/shared';
import { AdminAuditService } from './admin-audit.service';
import { toAuditCsv } from './audit-csv';
import {
  AdminAuditLogsExportDto,
  AdminAuditLogsQueryDto,
} from './dto/admin-audit-logs-query.dto';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';

/**
 * Most rows one export holds. Built in memory, so this bounds the response at a few
 * megabytes; a wider history is exported in date ranges. The response says when
 * rows were left out.
 */
export const AUDIT_EXPORT_ROW_CAP = 10_000;

export interface AdminAuditLogPage {
  data: AdminAuditLog[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface AuditExport {
  csv: string;
  rowCount: number;
  truncated: boolean;
}

export interface AuditExportActor {
  userId: string;
  email: string;
  ipAddress: string;
}

const FILTER_KEYS = ['actorId', 'actorEmail', 'action', 'targetId', 'from', 'to'] as const;

export function toAuditLog(row: AdminAuditLogEntity): AdminAuditLog {
  return {
    id: row.id,
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    reason: row.reason,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class AdminAuditLogsService {
  constructor(
    @InjectRepository(AdminAuditLogEntity)
    private readonly auditRepository: Repository<AdminAuditLogEntity>,
    private readonly auditService: AdminAuditService,
  ) {}

  async list(query: AdminAuditLogsQueryDto): Promise<AdminAuditLogPage> {
    const [rows, total] = await this.filtered(query)
      .skip(query.skip)
      .take(query.limit)
      .getManyAndCount();

    return {
      data: rows.map(toAuditLog),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /** Audited before the file leaves, like a view-as session: an export that could not be recorded is not served. */
  async export(filters: AdminAuditLogsExportDto, actor: AuditExportActor): Promise<AuditExport> {
    // One past the cap, to know whether the cap cut anything off.
    const rows = await this.filtered(filters).take(AUDIT_EXPORT_ROW_CAP + 1).getMany();
    const truncated = rows.length > AUDIT_EXPORT_ROW_CAP;
    const kept = truncated ? rows.slice(0, AUDIT_EXPORT_ROW_CAP) : rows;

    await this.auditService.record({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: 'audit_log.exported',
      targetType: 'audit_log',
      metadata: {
        filters: appliedFilters(filters),
        rowCount: kept.length,
        truncated,
        rowCap: AUDIT_EXPORT_ROW_CAP,
      },
      ipAddress: actor.ipAddress || null,
    });

    return { csv: toAuditCsv(kept.map(toAuditLog)), rowCount: kept.length, truncated };
  }

  private filtered(filters: AdminAuditLogsExportDto): SelectQueryBuilder<AdminAuditLogEntity> {
    const from = filters.from ? new Date(filters.from) : undefined;
    const to = filters.to ? new Date(filters.to) : undefined;
    if (from && to && from >= to) {
      throw new BadRequestException('from must be before to');
    }

    const qb = this.auditRepository
      .createQueryBuilder('log')
      // The id breaks ties, so a row cannot repeat or vanish across pages.
      .orderBy('log.createdAt', 'DESC')
      .addOrderBy('log.id', 'DESC');

    if (filters.actorId) qb.andWhere('log.actorId = :actorId', { actorId: filters.actorId });
    if (filters.actorEmail) {
      qb.andWhere('log.actorEmail = :actorEmail', { actorEmail: filters.actorEmail });
    }
    if (filters.action?.length) qb.andWhere('log.action IN (:...actions)', { actions: filters.action });
    if (filters.targetId) qb.andWhere('log.targetId = :targetId', { targetId: filters.targetId });
    if (from) qb.andWhere('log.createdAt >= :from', { from });
    if (to) qb.andWhere('log.createdAt < :to', { to });
    return qb;
  }
}

/** Only what was set, so the export's own audit row reads as what was asked for. */
function appliedFilters(filters: AdminAuditLogsExportDto): Record<string, unknown> {
  const applied: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    if (filters[key] !== undefined) applied[key] = filters[key];
  }
  return applied;
}

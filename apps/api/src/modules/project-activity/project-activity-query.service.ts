import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type {
  ProjectActivityAction,
  ProjectActivityActorKind,
  ProjectActivityEntry,
  ProjectActivityPage,
} from '@chumbaq/shared';
import type { ProjectAccess } from '../project-access/project-access.service';
import { roleCan } from '../project-access/project-permissions';
import { actionsInGroup, groupOf, PRIVACY_ACTIONS } from './activity-groups';
import { toActivityCsv } from './activity-csv';
import type { ActivityContext } from './activity-context';
import {
  encodeActivityCursor,
  INVALID_ACTIVITY_FILTER,
  type ActivityFilters,
  type ActivityQuery,
} from './dto/activity-query.dto';
import { ProjectActivityService, type ActivityActor } from './project-activity.service';

export { INVALID_ACTIVITY_FILTER };

export const ACTIVITY_PAGE_SIZE = 50;

/** At most this many rows in one download. */
export const ACTIVITY_EXPORT_ROW_CAP = 50_000;

/** The provider token for the cap, so a test can make it small. */
export const ACTIVITY_EXPORT_CAP = Symbol('ACTIVITY_EXPORT_CAP');

export const TOO_MANY_TO_EXPORT = 'Too many entries to download. Choose a shorter date range.';

interface ActivityRow {
  id: string;
  /** `occurred_at` to the microsecond, UTC, for the cursor. */
  cursor_at: string;
  occurred_at: Date;
  actor_kind: ProjectActivityActorKind;
  actor_user_id: string | null;
  actor_label: string;
  action: ProjectActivityAction;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  country: string | null;
  user_agent: string | null;
}

const COLUMNS = `id, occurred_at,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
  actor_kind, actor_user_id, actor_label, action, target_type, target_id, target_label,
  details, ip_address, country, user_agent`;

function toEntry(row: ActivityRow): ProjectActivityEntry {
  return {
    id: row.id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label,
    action: row.action,
    group: groupOf(row.action),
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.target_label,
    details: row.details,
    ipAddress: row.ip_address,
    country: row.country,
    userAgent: row.user_agent,
  };
}

/** A WHERE clause and its parameters, built so values only ever travel as parameters. */
class Where {
  readonly params: unknown[] = [];
  private readonly parts: string[] = [];

  value(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }

  push(part: string): void {
    this.parts.push(part);
  }

  toString(): string {
    return this.parts.join(' AND ');
  }
}

/**
 * Reads a project's activity log for the Activity page and its download. Every query is
 * scoped to `access.project.id` (never to anything the request names), and a role
 * without `privacy` never gets a privacy entry: they are left out in SQL, in the page,
 * the person choices and the CSV alike.
 */
@Injectable()
export class ProjectActivityQueryService {
  private readonly exportCap: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activity: ProjectActivityService,
    @Optional() @Inject(ACTIVITY_EXPORT_CAP) exportCap?: number,
  ) {
    this.exportCap = exportCap ?? ACTIVITY_EXPORT_ROW_CAP;
  }

  async list(access: ProjectAccess, q: ActivityQuery): Promise<ProjectActivityPage> {
    const where = this.scope(access);
    this.applyFilters(where, q);
    if (q.cursor) {
      where.push(
        `(occurred_at, id) < (${where.value(q.cursor.occurredAt)}::timestamptz, ${where.value(q.cursor.id)}::uuid)`,
      );
    }
    const rows: ActivityRow[] = await this.dataSource.query(
      `SELECT ${COLUMNS} FROM project_activity WHERE ${where}
       ORDER BY occurred_at DESC, id DESC LIMIT ${ACTIVITY_PAGE_SIZE + 1}`,
      where.params,
    );
    const pageRows = rows.slice(0, ACTIVITY_PAGE_SIZE);
    const last = pageRows[pageRows.length - 1];
    return {
      entries: pageRows.map(toEntry),
      nextCursor:
        rows.length > ACTIVITY_PAGE_SIZE && last ? encodeActivityCursor({ occurredAt: last.cursor_at, id: last.id }) : null,
      actors: await this.actors(access),
    };
  }

  /**
   * The filtered entries as CSV, newest first, refused past the cap. Writes
   * `activity.exported` once the file is ready, and throws if that fails, so no file
   * leaves without its entry.
   */
  async exportCsv(
    access: ProjectAccess,
    q: ActivityFilters,
    actor: ActivityActor,
    ctx: ActivityContext,
  ): Promise<string> {
    const where = this.scope(access);
    this.applyFilters(where, q);
    const rows: ActivityRow[] = await this.dataSource.query(
      `SELECT ${COLUMNS} FROM project_activity WHERE ${where}
       ORDER BY occurred_at DESC, id DESC LIMIT ${this.exportCap + 1}`,
      where.params,
    );
    if (rows.length > this.exportCap) throw new BadRequestException(TOO_MANY_TO_EXPORT);
    const csv = toActivityCsv(rows.map(toEntry));
    await this.activity.record(
      {
        projectId: access.project.id,
        actor,
        action: 'activity.exported',
        details: { filters: q.raw, rows: rows.length },
      },
      ctx,
    );
    return csv;
  }

  /**
   * The people who appear in the log, current and former members alike: one choice per
   * user, with their newest label. Actors with no user (staff, API keys, the system) are
   * not people and are left out. Privacy entries count only for a role that may see them.
   */
  private async actors(access: ProjectAccess): Promise<ProjectActivityPage['actors']> {
    const where = this.scope(access);
    where.push('actor_user_id IS NOT NULL');
    const rows: Array<{ actor_user_id: string; actor_label: string }> = await this.dataSource.query(
      `SELECT actor_user_id, actor_label FROM (
         SELECT DISTINCT ON (actor_user_id) actor_user_id, actor_label
           FROM project_activity
          WHERE ${where}
          ORDER BY actor_user_id, occurred_at DESC, id DESC
       ) AS latest
       ORDER BY lower(actor_label), actor_label, actor_user_id`,
      where.params,
    );
    return rows.map((r) => ({ userId: r.actor_user_id, label: r.actor_label }));
  }

  /** The project, always, and the privacy rule. */
  private scope(access: ProjectAccess): Where {
    const where = new Where();
    where.push(`project_id = ${where.value(access.project.id)}`);
    if (!roleCan(access.role, 'privacy')) {
      where.push(`action <> ALL(${where.value([...PRIVACY_ACTIONS])}::text[])`);
    }
    return where;
  }

  private applyFilters(where: Where, q: ActivityFilters): void {
    if (q.actor) where.push(`actor_user_id = ${where.value(q.actor)}::uuid`);
    if (q.group) where.push(`action = ANY(${where.value(actionsInGroup(q.group))}::text[])`);
    if (q.from) where.push(`occurred_at >= ${where.value(q.from)}`);
    if (q.before) where.push(`occurred_at < ${where.value(q.before)}`);
  }
}

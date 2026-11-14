import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import type {
  AdminTenantUsage,
  AdminTenantUsageRef,
  UsageCoverage,
  UsageDay,
  UsageMonth,
  UsageValues,
} from '@chumbaq/shared';
import { addDays, addMonths, monthEnd } from '../usage/usage-days';
import {
  COUNTED_METRICS,
  MESSAGE_SENT_METRICS,
  USAGE_METRICS,
  UsageMetricName,
} from '../usage/usage-metrics';
import { readUsageCoverage } from '../usage/usage-rollup.service';
import { AdminAuditService } from './admin-audit.service';
import type { AdminActor } from './admin-tenants.service';

/** A tenant with usage before, but none in this many counted days, is going quiet. */
export const QUIET_AFTER_DAYS = 14;
/** The window behind `messagesSent30d` and the overview's totals. */
export const USAGE_WINDOW_DAYS = 30;
/** How many tenants the overview lists as top and as going quiet. */
export const OVERVIEW_TENANT_LIMIT = 10;

export interface TenantUsageAggregate {
  mauThisMonth: number;
  messagesSent30d: number;
  lastUsageDay: string | null;
}

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/**
 * Per billing owner, from closed days only: `mau_this_month` (active devices on
 * the last counted day, summed over the owner's projects), `messages_sent_30d`
 * (the four sent metrics over the 30 days ending then) and `last_usage_day`
 * (the last day any counted metric was above 0). `through` is the SQL for the
 * last counted day, a `date` parameter; when it is null the CTE has no rows.
 * Owners with no usage at all are absent, so readers COALESCE.
 */
export function tenantUsageCte(through: string): string {
  return `
    SELECT owner_id,
           COALESCE(sum(value) FILTER (WHERE metric = 'mau_month_to_date' AND day = ${through}), 0)::bigint
             AS mau_this_month,
           COALESCE(sum(value) FILTER (
             WHERE metric IN (${list(MESSAGE_SENT_METRICS)}) AND day > ${through} - ${USAGE_WINDOW_DAYS}
           ), 0)::bigint AS messages_sent_30d,
           max(day) FILTER (WHERE metric IN (${list(COUNTED_METRICS)}) AND value > 0) AS last_usage_day
      FROM usage_daily
     WHERE day <= ${through}
     GROUP BY owner_id`;
}

/** Sums per key and metric over a range, plus each metric's sum and row count on the range's last day. */
interface RangeRow {
  key: string;
  metric: UsageMetricName;
  total: string;
  onLast: string | null;
  rowsOnLast: string;
}

const COUNTED = new Set<string>(COUNTED_METRICS);

/**
 * Staff reads of the usage roll-up. Everything here reads `usage_daily` and
 * the roll-up state only, never the raw tables, and never a day after the last
 * closed one (today's partial counts are in the table but not final). Rows are
 * matched by the billing owner written with them, so a project moved to
 * another account keeps its earlier days with the account that was billed.
 *
 * Values follow one rule: inside the counted range a missing counted metric is
 * 0; active devices before the month they are counted from, and active API
 * keys on a day with no snapshot, are null (unknown), never 0.
 */
@Injectable()
export class AdminUsageService {
  constructor(
    @InjectEntityManager() private readonly manager: EntityManager,
    private readonly audit: AdminAuditService,
  ) {}

  coverage(): Promise<UsageCoverage | null> {
    return readUsageCoverage(this.manager);
  }

  /** The last `days` counted days (fewer when counting started later); `ownerId` null is every tenant. */
  async series(coverage: UsageCoverage | null, ownerId: string | null, days: number): Promise<UsageDay[]> {
    const through = coverage?.countedThrough;
    if (!coverage || !through) return [];
    const earliest = addDays(through, -(days - 1));
    const from = earliest > coverage.countedFrom ? earliest : coverage.countedFrom;

    const rows: { day: string; metric: UsageMetricName; value: string }[] = await this.manager.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, sum(value)::text AS value
         FROM usage_daily
        WHERE day >= $1::date AND day <= $2::date
          AND ($3::uuid IS NULL OR owner_id = $3::uuid)
        GROUP BY day, metric`,
      [from, through, ownerId],
    );
    const byDay = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (!byDay.has(row.day)) byDay.set(row.day, new Map());
      byDay.get(row.day)!.set(row.metric, Number(row.value));
    }

    const series: UsageDay[] = [];
    for (let day = from; day <= through; day = addDays(day, 1)) {
      const found = byDay.get(day) ?? new Map<string, number>();
      series.push({
        date: day,
        values: valuesOf(
          (metric) => found.get(metric) ?? 0,
          (metric) => found.get(metric) ?? null,
          day >= coverage.mauFrom,
        ),
      });
    }
    return series;
  }

  /**
   * Counted metrics summed over `[from, through]`, snapshots as on `through`,
   * where the range is clipped to the counted days. Null when no counted day
   * falls in it.
   */
  async totals(
    coverage: UsageCoverage | null,
    ownerId: string | null,
    from: string,
    through: string,
  ): Promise<{ from: string; through: string; values: UsageValues } | null> {
    const range = clip(coverage, from, through);
    if (!coverage || !range) return null;
    const rows = await this.range(range.from, range.through, ownerId, 'owner');
    return {
      ...range,
      values: rangeValues(rows, range.through >= coverage.mauFrom),
    };
  }

  /** A calendar month, `YYYY-MM`, of one tenant or (null) all. */
  async month(coverage: UsageCoverage | null, ownerId: string | null, month: string): Promise<UsageMonth | null> {
    if (!coverage?.countedThrough) return null;
    const first = `${month}-01`;
    const last = monthEnd(first);
    const totals = await this.totals(coverage, ownerId, first, last);
    if (!totals) return null;
    return {
      month,
      from: totals.from,
      through: totals.through,
      partial: first < coverage.countedFrom || last > coverage.countedThrough,
      values: totals.values,
    };
  }

  /** Figures per billing owner; owners with no usage are absent. */
  async tenantAggregates(
    coverage: UsageCoverage | null,
    ownerIds: string[] | null,
  ): Promise<Map<string, TenantUsageAggregate>> {
    if (!coverage?.countedThrough) return new Map();
    const rows: { owner_id: string; mau: string; messages: string; last: string | null }[] =
      await this.manager.query(
        `SELECT owner_id, mau_this_month::text AS mau, messages_sent_30d::text AS messages,
                to_char(last_usage_day, 'YYYY-MM-DD') AS last
           FROM (${tenantUsageCte('$1::date')}) usage
          WHERE $2::uuid[] IS NULL OR owner_id = ANY($2::uuid[])`,
        [coverage.countedThrough, ownerIds],
      );
    return new Map(
      rows.map((row) => [
        row.owner_id,
        { mauThisMonth: Number(row.mau), messagesSent30d: Number(row.messages), lastUsageDay: row.last },
      ]),
    );
  }

  /**
   * The busiest tenants: messages sent in 30 days plus monthly active devices,
   * above 0, ties by owner id.
   */
  async topTenants(coverage: UsageCoverage | null): Promise<AdminTenantUsageRef[]> {
    if (!coverage?.countedThrough) return [];
    return this.tenantRefs(
      coverage.countedThrough,
      `usage.messages_sent_30d + usage.mau_this_month > 0`,
      `usage.messages_sent_30d + usage.mau_this_month DESC, u.id`,
    );
  }

  /** Tenants with usage before, but none in the last 14 counted days: the most recently active first. */
  async quietTenants(coverage: UsageCoverage | null): Promise<{ count: number; tenants: AdminTenantUsageRef[] }> {
    if (!coverage?.countedThrough) return { count: 0, tenants: [] };
    const where = `usage.last_usage_day <= $1::date - ${QUIET_AFTER_DAYS}`;
    const [tenants, [{ count }]] = await Promise.all([
      this.tenantRefs(coverage.countedThrough, where, `usage.last_usage_day DESC, u.id`),
      this.manager.query(
        `SELECT count(*)::int AS count
           FROM (${tenantUsageCte('$1::date')}) usage
           JOIN users u ON u.id = usage.owner_id
          WHERE ${where}`,
        [coverage.countedThrough],
      ) as Promise<{ count: number }[]>,
    ]);
    return { count, tenants };
  }

  /**
   * One tenant's usage page. The read is recorded (`tenant.viewed`, deduplicated
   * with the tenant page's) before anything is returned.
   */
  async tenantUsage(id: string, days: number, actor: AdminActor): Promise<AdminTenantUsage> {
    const [tenant]: { email: string }[] = await this.manager.query(`SELECT email FROM users WHERE id = $1`, [id]);
    if (!tenant) throw new NotFoundException('Tenant not found');

    const coverage = await this.coverage();
    const through = coverage?.countedThrough;
    let result: AdminTenantUsage = {
      coverage,
      days,
      series: [],
      thisMonth: null,
      lastMonth: null,
      projects: [],
    };
    if (coverage && through) {
      const thisMonth = through.slice(0, 7);
      const lastMonth = addMonths(through, -1).slice(0, 7);
      const [series, thisMonthUsage, lastMonthUsage, projects] = await Promise.all([
        this.series(coverage, id, days),
        this.month(coverage, id, thisMonth),
        this.month(coverage, id, lastMonth),
        this.projects(coverage, id, days),
      ]);
      result = { ...result, series, thisMonth: thisMonthUsage, lastMonth: lastMonthUsage, projects };
    }

    await this.audit.recordRead({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: 'tenant.viewed',
      targetType: 'tenant',
      targetId: id,
      targetLabel: tenant.email,
      ipAddress: actor.ipAddress || null,
    });
    return result;
  }

  /**
   * Each project with rows billed to the tenant in the series' days, and each
   * project it is billed for now; a deleted project has no name.
   */
  private async projects(
    coverage: UsageCoverage,
    ownerId: string,
    days: number,
  ): Promise<AdminTenantUsage['projects']> {
    const through = coverage.countedThrough!;
    const earliest = addDays(through, -(days - 1));
    const from = earliest > coverage.countedFrom ? earliest : coverage.countedFrom;
    const [rows, current]: [RangeRow[], { id: string; name: string }[]] = await Promise.all([
      this.range(from, through, ownerId, 'project'),
      this.manager.query(`SELECT id, name FROM projects WHERE owner_id = $1`, [ownerId]),
    ]);
    const ids = [...new Set([...current.map((p) => p.id), ...rows.map((row) => row.key)])];
    const names = new Map<string, string>(current.map((p) => [p.id, p.name]));
    const missing = ids.filter((id) => !names.has(id));
    if (missing.length > 0) {
      const others: { id: string; name: string }[] = await this.manager.query(
        `SELECT id, name FROM projects WHERE id = ANY($1::uuid[])`,
        [missing],
      );
      for (const project of others) names.set(project.id, project.name);
    }
    const mau = through >= coverage.mauFrom;
    return ids
      .map((projectId) => ({
        projectId,
        name: names.get(projectId) ?? null,
        values: rangeValues(
          rows.filter((row) => row.key === projectId),
          mau,
        ),
      }))
      .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿') || a.projectId.localeCompare(b.projectId));
  }

  private range(from: string, through: string, ownerId: string | null, by: 'owner' | 'project'): Promise<RangeRow[]> {
    const key = by === 'project' ? 'project_id::text' : `''`;
    return this.manager.query(
      `SELECT ${key} AS key, metric,
              sum(value)::text AS total,
              sum(value) FILTER (WHERE day = $2::date)::text AS "onLast",
              count(*) FILTER (WHERE day = $2::date)::text AS "rowsOnLast"
         FROM usage_daily
        WHERE day >= $1::date AND day <= $2::date
          AND ($3::uuid IS NULL OR owner_id = $3::uuid)
        GROUP BY 1, metric`,
      [from, through, ownerId],
    );
  }

  private tenantRefs(through: string, where: string, orderBy: string): Promise<AdminTenantUsageRef[]> {
    return this.manager
      .query(
        `SELECT u.id, u.email, u.name,
                usage.mau_this_month::text AS mau,
                usage.messages_sent_30d::text AS messages,
                to_char(usage.last_usage_day, 'YYYY-MM-DD') AS last
           FROM (${tenantUsageCte('$1::date')}) usage
           JOIN users u ON u.id = usage.owner_id
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ${OVERVIEW_TENANT_LIMIT}`,
        [through],
      )
      .then((rows: { id: string; email: string; name: string; mau: string; messages: string; last: string | null }[]) =>
        rows.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.name,
          mauThisMonth: Number(row.mau),
          messagesSent30d: Number(row.messages),
          lastUsageDay: row.last,
        })),
      );
  }
}

/** `[from, through]` cut to the counted days, or null when they do not meet. */
function clip(
  coverage: UsageCoverage | null,
  from: string,
  through: string,
): { from: string; through: string } | null {
  if (!coverage?.countedThrough) return null;
  const start = from > coverage.countedFrom ? from : coverage.countedFrom;
  const end = through < coverage.countedThrough ? through : coverage.countedThrough;
  return start <= end ? { from: start, through: end } : null;
}

/**
 * Every metric: counted ones from `counted` (0 when nothing was stored);
 * active devices from `snapshot`, or 0 where counted, null before `mau`;
 * active keys from `snapshot` only, null when none was taken.
 */
function valuesOf(
  counted: (metric: string) => number,
  snapshot: (metric: string) => number | null,
  mau: boolean,
): UsageValues {
  const values = {} as UsageValues;
  for (const metric of USAGE_METRICS) {
    if (COUNTED.has(metric)) values[metric] = counted(metric);
    else if (metric === 'mau_month_to_date') values[metric] = mau ? (snapshot(metric) ?? 0) : null;
    else values[metric] = snapshot(metric);
  }
  return values;
}

function rangeValues(rows: RangeRow[], mau: boolean): UsageValues {
  const byMetric = new Map(rows.map((row) => [row.metric as string, row]));
  return valuesOf(
    (metric) => Number(byMetric.get(metric)?.total ?? 0),
    (metric) => {
      const row = byMetric.get(metric);
      return row && Number(row.rowsOnLast) > 0 ? Number(row.onLast) : null;
    },
    mau,
  );
}

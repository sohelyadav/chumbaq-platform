import { EntityManager } from 'typeorm';
import { monthStart } from './usage-days';
import {
  COUNTED_METRICS,
  COUNTED_METRIC_SQL,
  REACHED_EVENT_TYPES,
  SnapshotMetric,
  UsageMetricName,
  inWindow,
} from './usage-metrics';

/** A project and its billing owner as the roll-up writes them. */
export interface ProjectOwner {
  id: string;
  ownerId: string;
}

/**
 * Writes `metricSql`'s `(project_id, value)` rows into `usage_daily` for one
 * day, with each project's billing owner. Zeros are not stored. The metric
 * query uses `$1` (project ids) to `$<used>`; the next three are the day, the
 * metric and the owners (in project order).
 */
function upsert(metricSql: string, used: number, onConflict: string): string {
  const [day, metric, owners] = [used + 1, used + 2, used + 3].map((n) => `$${n}`);
  return `
    INSERT INTO usage_daily (project_id, owner_id, day, metric, value, computed_at)
    SELECT m.project_id, o.owner_id, ${day}::date, ${metric}, m.value, now()
      FROM (${metricSql}) m
      JOIN unnest($1::uuid[], ${owners}::uuid[]) AS o(project_id, owner_id) ON o.project_id = m.project_id
     WHERE m.value > 0
    ON CONFLICT (project_id, day, metric) DO UPDATE SET ${onConflict}`;
}

/** A recount never lowers a counted value: rows erased or deleted after counting do not take it back. */
const KEEP_HIGHER = `value = GREATEST(usage_daily.value, EXCLUDED.value),
  owner_id = EXCLUDED.owner_id, computed_at = now()`;

/** A snapshot is replaced. */
const REPLACE = `value = EXCLUDED.value, owner_id = EXCLUDED.owner_id, computed_at = now()`;

const split = (projects: ProjectOwner[]) => [projects.map((p) => p.id), projects.map((p) => p.ownerId)];

/**
 * Counts every counted metric for `day` from the rows written in `[from, to)`
 * (the whole day when closing it, the day so far for today). Runs in the
 * caller's transaction and writes only `day`.
 */
export async function countWindow(
  manager: EntityManager,
  projects: ProjectOwner[],
  day: string,
  from: Date,
  to: Date,
): Promise<void> {
  if (projects.length === 0) return;
  const [ids, owners] = split(projects);
  for (const metric of COUNTED_METRICS) {
    await manager.query(upsert(COUNTED_METRIC_SQL[metric], 3, KEEP_HIGHER), [ids, from, to, day, metric, owners]);
  }
}

/**
 * Writes a snapshot metric for `day`, replacing what was there, from a
 * `(project_id, value)` query over `$1::uuid[]` and then `params`.
 */
export async function writeSnapshot(
  manager: EntityManager,
  projects: ProjectOwner[],
  day: string,
  metric: SnapshotMetric,
  metricSql: string,
  params: unknown[],
): Promise<void> {
  if (projects.length === 0) return;
  const [ids, owners] = split(projects);
  await manager.query(upsert(metricSql, 1 + params.length, REPLACE), [ids, ...params, day, metric, owners]);
}

/** Keys that work at `$2` (an instant): active and not expired. */
const ACTIVE_KEYS_SQL = `
  SELECT project_id, count(*)::bigint AS value
    FROM api_keys
   WHERE project_id = ANY($1::uuid[])
     AND is_active
     AND (expires_at IS NULL OR expires_at > $2::timestamptz::timestamp)
   GROUP BY project_id`;

/** `api_keys_active` for `day`: the keys that work at `now`. */
export async function writeApiKeySnapshot(
  manager: EntityManager,
  projects: ProjectOwner[],
  day: string,
  now: Date,
): Promise<void> {
  await writeSnapshot(manager, projects, day, 'api_keys_active', ACTIVE_KEYS_SQL, [now]);
}

/** A plain `timestamp` column's UTC day (the column holds session wall clock). */
const utcDate = (column: string) => `(${column}::timestamptz AT TIME ZONE 'UTC')::date`;

/**
 * Every record that makes a device active, with when it was written (the
 * rules are in `usage-metrics.ts`). `$1` project ids, `$2`/`$3` the window.
 */
const ACTIVITY_SQL = `
  SELECT project_id, device_identity_id AS device, created_at AS at
    FROM user_events
   WHERE project_id = ANY($1::uuid[]) AND device_identity_id IS NOT NULL AND ${inWindow('created_at')}
  UNION ALL
  SELECT project_id, device_identity_id, created_at
    FROM push_notification_events
   WHERE project_id = ANY($1::uuid[])
     AND type IN (${REACHED_EVENT_TYPES.map((t) => `'${t}'`).join(', ')})
     AND ${inWindow('created_at')}
  UNION ALL
  SELECT i.project_id, COALESCE(i.device_identity_id, d.id), i.created_at
    FROM in_app_message_impressions i
    LEFT JOIN device_identities d
      ON i.device_identity_id IS NULL AND d.project_id = i.project_id AND d.device_fingerprint = i.device_fingerprint
   WHERE i.project_id = ANY($1::uuid[]) AND ${inWindow('i.created_at')}
  UNION ALL
  SELECT project_id, id, first_seen_at
    FROM device_identities
   WHERE project_id = ANY($1::uuid[]) AND ${inWindow('first_seen_at')}`;

/**
 * Adds the devices active in `[from, to)` to `monthly_active_devices`, one row
 * per device per UTC month, keeping the earliest day seen. Safe to repeat and
 * to run windows in any order. Returns the rows added or moved earlier.
 */
export async function recordActiveDevices(
  manager: EntityManager,
  projectIds: string[],
  from: Date,
  to: Date,
): Promise<number> {
  if (projectIds.length === 0) return 0;
  const [row] = await manager.query(
    `WITH activity AS (${ACTIVITY_SQL}),
          days AS (
            SELECT project_id, device, ${utcDate('at')} AS day FROM activity WHERE device IS NOT NULL
          ),
          written AS (
            INSERT INTO monthly_active_devices (project_id, month, device_identity_id, first_day)
            SELECT project_id, date_trunc('month', day)::date, device, min(day)
              FROM days
             GROUP BY project_id, date_trunc('month', day)::date, device
            ON CONFLICT (project_id, month, device_identity_id) DO UPDATE SET first_day = EXCLUDED.first_day
              WHERE EXCLUDED.first_day < monthly_active_devices.first_day
            RETURNING 1
          )
     SELECT count(*)::int AS n FROM written`,
    [projectIds, from, to],
  );
  return row.n;
}

/** Devices active in `day`'s month up to and including `day` (`$2` the month, `$3` the day). */
const MONTH_TO_DATE_SQL = `
  SELECT project_id, count(*)::bigint AS value
    FROM monthly_active_devices
   WHERE project_id = ANY($1::uuid[]) AND month = $2::date AND first_day <= $3::date
   GROUP BY project_id`;

/** `mau_month_to_date` for `day`, from the devices recorded so far. */
export async function writeMauSnapshot(
  manager: EntityManager,
  projects: ProjectOwner[],
  day: string,
): Promise<void> {
  await writeSnapshot(manager, projects, day, 'mau_month_to_date', MONTH_TO_DATE_SQL, [monthStart(day), day]);
}

/** Months kept in `monthly_active_devices`; older months live on as `usage_daily` counts. */
export const ACTIVE_DEVICE_MONTHS_KEPT = 13;

/** Deletes active-device months more than thirteen before `today`'s month. Returns rows deleted. */
export async function pruneActiveDevices(manager: EntityManager, today: string): Promise<number> {
  const [row] = await manager.query(
    `WITH gone AS (
       DELETE FROM monthly_active_devices
        WHERE month < $1::date - make_interval(months => $2)
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM gone`,
    [monthStart(today), ACTIVE_DEVICE_MONTHS_KEPT],
  );
  return row.n;
}

/** The stored values of `day` per project; a project with none is absent. */
export async function readDay(
  manager: EntityManager,
  projectIds: string[],
  day: string,
): Promise<Map<string, Partial<Record<UsageMetricName, number>>>> {
  const rows: { project_id: string; metric: UsageMetricName; value: string }[] = await manager.query(
    `SELECT project_id, metric, value FROM usage_daily WHERE project_id = ANY($1::uuid[]) AND day = $2::date`,
    [projectIds, day],
  );
  const out = new Map<string, Partial<Record<UsageMetricName, number>>>();
  for (const row of rows) {
    const values = out.get(row.project_id) ?? {};
    values[row.metric] = Number(row.value);
    out.set(row.project_id, values);
  }
  return out;
}

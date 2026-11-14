import { EntityManager } from 'typeorm';
import { COUNTED_METRICS, COUNTED_METRIC_SQL, SnapshotMetric, UsageMetricName } from './usage-metrics';

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

/**
 * The usage metrics, each defined once, here.
 *
 * Counted per project per UTC day. "In the window" means the row was written
 * in `[from, to)`; plain `timestamp` columns hold the database session's wall
 * clock, so the bounds are converted the same way (`$2::timestamptz::timestamp`)
 * and the column is compared untouched, which keeps the indexes usable.
 *
 * | metric               | from                          | rule                                                                 |
 * |----------------------|-------------------------------|----------------------------------------------------------------------|
 * | `push_sent`          | `push_notification_logs`      | sum of `success_count`, `channel = 'push'`, finished in the window   |
 * | `email_sent`         | same                          | same, `channel = 'email'`                                            |
 * | `sms_sent`           | same                          | same, `channel = 'sms'`                                              |
 * | `whatsapp_sent`      | same                          | same, `channel = 'whatsapp'`                                         |
 * | `messages_failed`    | same                          | sum of `failure_count`, every channel, finished in the window        |
 * | `in_app_impressions` | `in_app_message_impressions`  | rows with `event_type = 'impression'`, received in the window        |
 * | `clicks`             | `click_events` (by its link)  | clicks in the window                                                 |
 * | `events`             | `user_events`                 | rows received in the window (`created_at`, not the client's time)    |
 * | `new_people`         | `device_identities`           | rows created in the window (`first_seen_at`)                         |
 * | `mau_month_to_date`  | `monthly_active_devices`      | snapshot: devices active in the month up to and including the day    |
 * | `api_keys_active`    | `api_keys`                    | snapshot: active, unexpired keys when the day was closed             |
 *
 * **Missing rows.** Zeros are not stored, so inside the counted range a
 * missing row reads as 0, with one exception: `api_keys_active` is taken only
 * when the day closed is yesterday (it cannot be rebuilt for the past), so a
 * day closed late, after downtime, has none. It is stored for every project
 * whenever it is taken, 0 included, so a missing `api_keys_active` is unknown
 * (null), never 0. `mau_month_to_date` is written for every closed day from
 * the coverage's `mauFrom`, so before that it is unknown too.
 *
 * **Finished** is `completed_at` in the window and a finished status (`sent`,
 * `partial`, `failed`). Every parent campaign (an A/B test, a timezone or
 * send-time split, a finished recurring template) ends `expanded` and sends
 * nothing itself; its arms and waves are rows of their own with their own
 * counts. So the status rule counts each recipient once, and `cancelled` or
 * unfinished rows never count. A campaign running over midnight counts on the
 * day it finished.
 *
 * **Events by received time**, so events an offline queue flushes days later
 * still count, and a closed day never changes.
 *
 * **Active devices** (`monthly_active_devices`, the source of
 * `mau_month_to_date`): a device row is active in a UTC month when in that
 * month it sent an SDK event (`user_events` naming it), was reached by a
 * message (`push_notification_events` of a reached type, below), had an
 * in-app message event (by its id, or by its fingerprint when the row names
 * none), or was first seen (its first identify). Each by the time the row was
 * written. Two accepted gaps, both under-counting and never over-counting:
 * push reach is recorded per device only when the project has a frequency cap
 * (that is when `sent` events are written) or when the SDK reports
 * `delivered`, `impression`, `click` or `dismissed`; and an identify on an
 * existing device that sends no event and receives nothing leaves no dated
 * record, so it is not counted. `last_seen_at` is never used: it moves on any
 * save of the row, dashboard edits included.
 */

import type { UsageMetric } from '@chumbaq/shared';

export const USAGE_METRICS = [
  'push_sent',
  'email_sent',
  'sms_sent',
  'whatsapp_sent',
  'messages_failed',
  'in_app_impressions',
  'clicks',
  'events',
  'new_people',
  'mau_month_to_date',
  'api_keys_active',
] as const;

export type UsageMetricName = (typeof USAGE_METRICS)[number];

// Held equal to the shared union, which the admin app reads: a metric added on
// one side only fails compilation here.
type _SameMetrics = [UsageMetric] extends [UsageMetricName]
  ? [UsageMetricName] extends [UsageMetric]
    ? true
    : never
  : never;
const _usageMetricsMatch: _SameMetrics = true;
void _usageMetricsMatch;

/** Counted from the rows written in a window; a recount never lowers them. */
export const COUNTED_METRICS = [
  'push_sent',
  'email_sent',
  'sms_sent',
  'whatsapp_sent',
  'messages_failed',
  'in_app_impressions',
  'clicks',
  'events',
  'new_people',
] as const satisfies readonly UsageMetricName[];

export type CountedMetric = (typeof COUNTED_METRICS)[number];

/** A value at a point in time, replaced when written again. */
export const SNAPSHOT_METRICS = ['mau_month_to_date', 'api_keys_active'] as const satisfies readonly UsageMetricName[];

export type SnapshotMetric = (typeof SNAPSHOT_METRICS)[number];

/**
 * Snapshots not taken every closed day, so stored for every project when they
 * are, zeros included: a missing row means not taken (unknown), never 0.
 */
export const ZERO_STORED_METRICS = ['api_keys_active'] as const satisfies readonly SnapshotMetric[];

/** Messages that reached people, one metric per channel. */
export const MESSAGE_SENT_METRICS = [
  'push_sent',
  'email_sent',
  'sms_sent',
  'whatsapp_sent',
] as const satisfies readonly CountedMetric[];

/** Campaign statuses that mean it finished and its counts are final. */
export const MESSAGE_COUNTED_STATUSES = ['sent', 'partial', 'failed'] as const;

/** Per-recipient events that mean a message reached a device. `bounced` and `complained` do not. */
export const REACHED_EVENT_TYPES = ['sent', 'delivered', 'impression', 'click', 'dismissed'] as const;

/** The in-app event that counts as an impression. */
export const IN_APP_IMPRESSION_TYPE = 'impression';

// Every metric is exactly one of counted or snapshot.
type _Split = Exclude<UsageMetricName, CountedMetric | SnapshotMetric>;
const _everyMetricSplit: [_Split] extends [never] ? true : never = true;
void _everyMetricSplit;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/** `col` in `[$2, $3)`, the bounds converted to session wall clock so the column's index applies. */
export const inWindow = (column: string) =>
  `${column} >= $2::timestamptz::timestamp AND ${column} < $3::timestamptz::timestamp`;

const campaigns = (value: string, channel: string | null) => `
  SELECT project_id, sum(${value})::bigint AS value
    FROM push_notification_logs
   WHERE project_id = ANY($1::uuid[])
     ${channel ? `AND channel = '${channel}'` : ''}
     AND status IN (${list(MESSAGE_COUNTED_STATUSES)})
     AND ${inWindow('completed_at')}
   GROUP BY project_id`;

const rows = (table: string, column: string, extra = '') => `
  SELECT project_id, count(*)::bigint AS value
    FROM ${table}
   WHERE project_id = ANY($1::uuid[])
     ${extra}
     AND ${inWindow(column)}
   GROUP BY project_id`;

/**
 * One query per counted metric: `(project_id, value)` for the projects in
 * `$1::uuid[]` and the window `$2` (inclusive) to `$3` (exclusive), both
 * instants. A project with nothing has no row.
 */
export const COUNTED_METRIC_SQL: Record<CountedMetric, string> = {
  push_sent: campaigns('success_count', 'push'),
  email_sent: campaigns('success_count', 'email'),
  sms_sent: campaigns('success_count', 'sms'),
  whatsapp_sent: campaigns('success_count', 'whatsapp'),
  messages_failed: campaigns('failure_count', null),
  in_app_impressions: rows('in_app_message_impressions', 'created_at', `AND event_type = '${IN_APP_IMPRESSION_TYPE}'`),
  // Per link, so each count is a range read of the (link_id, clicked_at) index.
  clicks: `
  SELECT l.project_id, sum(c.n)::bigint AS value
    FROM links l
    CROSS JOIN LATERAL (
      SELECT count(*) AS n FROM click_events ce
       WHERE ce.link_id = l.id AND ${inWindow('ce.clicked_at')}
    ) c
   WHERE l.project_id = ANY($1::uuid[])
   GROUP BY l.project_id`,
  events: rows('user_events', 'created_at'),
  new_people: rows('device_identities', 'first_seen_at'),
};

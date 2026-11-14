import type {
  AdminSortOrder,
  AdminTenantActivity,
  AdminTenantSort,
  UsageCoverage,
  UsageDay,
  UsageMetric,
  UsageValues,
} from '@chumbaq/shared';

export const USAGE_METRIC_LABELS: Record<UsageMetric, string> = {
  push_sent: 'Push sent',
  email_sent: 'Emails sent',
  sms_sent: 'SMS sent',
  whatsapp_sent: 'WhatsApp sent',
  messages_failed: 'Messages failed',
  in_app_impressions: 'In-app impressions',
  clicks: 'Link clicks',
  events: 'Events received',
  new_people: 'New people',
  mau_month_to_date: 'Monthly active devices',
  api_keys_active: 'Active API keys',
};

/** Everything a trend can show. Active API keys are only counted from the roll-up's first run on. */
export const TREND_METRICS: UsageMetric[] = (Object.keys(USAGE_METRIC_LABELS) as UsageMetric[]).filter(
  (metric) => metric !== 'api_keys_active',
);

const MESSAGE_METRICS: UsageMetric[] = ['push_sent', 'email_sent', 'sms_sent', 'whatsapp_sent'];

/** A count with thousands separators; `—` for one not counted, which is never the same as 0. */
export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-US');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Read from the string itself: usage days are UTC days, and a `Date` made from
 * `'2026-11-13'` is UTC midnight, which shows as the 12th west of Greenwich.
 */
function dayParts(day: string): { year: string; month: string; date: number } {
  const [year, month, date] = day.slice(0, 10).split('-');
  return { year, month: MONTHS[Number(month) - 1] ?? month, date: Number(date) };
}

/** `'2026-11-13'` as "13 Nov 2026". */
export function formatDay(day: string): string {
  const { year, month, date } = dayParts(day);
  return `${date} ${month} ${year}`;
}

/** `'2026-11-13'` as "13 Nov". */
export function formatShortDay(day: string): string {
  const { month, date } = dayParts(day);
  return `${date} ${month}`;
}

/** `'2026-11'` as "Nov 2026". */
export function formatMonth(month: string): string {
  const [year, index] = month.split('-');
  return `${MONTHS[Number(index) - 1] ?? index} ${year}`;
}

export function countedThroughLabel(coverage: UsageCoverage | null): string {
  return coverage?.countedThrough ? `Counted through ${formatDay(coverage.countedThrough)}` : 'Not counted yet';
}

/**
 * "counted from 1 Nov 2026" for the month active devices started being counted in
 * (`month` is `YYYY-MM`, or a day in it), null for any other. That month's count can
 * be low: device activity from before counting started is only partly known.
 */
export function mauCountedFrom(
  coverage: { mauFrom: string | null } | null | undefined,
  month: string | null | undefined,
): string | null {
  const from = coverage?.mauFrom;
  if (!from || !month) return null;
  return from.slice(0, 7) === month.slice(0, 7) ? `counted from ${formatDay(from)}` : null;
}

/** One point per day; a null stays null so the chart leaves a gap rather than drawing a 0. */
export function trendPoints(days: UsageDay[], metric: UsageMetric): { date: string; value: number | null }[] {
  return days.map((day) => ({ date: day.date, value: day.values[metric] ?? null }));
}

/** Messages sent across the four channels, or null when none of them was counted. */
export function messagesSent(values: UsageValues): number | null {
  let total: number | null = null;
  for (const metric of MESSAGE_METRICS) {
    const value = values[metric];
    if (value !== null && value !== undefined) total = (total ?? 0) + value;
  }
  return total;
}

// Records, so a value added to the shared unions fails compilation here.
const TENANT_SORTS: Record<AdminTenantSort, true> = {
  created_at: true,
  mau_this_month: true,
  messages_sent_30d: true,
  last_usage_day: true,
};
const SORT_ORDERS: Record<AdminSortOrder, true> = { asc: true, desc: true };
const TENANT_ACTIVITIES: Record<AdminTenantActivity, true> = { new: true, quiet: true, never_used: true };

const DEFAULT_SORT: AdminTenantSort = 'created_at';
const DEFAULT_ORDER: AdminSortOrder = 'desc';

const isKey = <T extends string>(record: Record<T, true>, value: string | null): value is T =>
  value !== null && Object.prototype.hasOwnProperty.call(record, value);

export interface TenantListParams {
  sort: AdminTenantSort;
  order: AdminSortOrder;
  activity?: AdminTenantActivity;
}

/** The list's sort and activity filter from the URL. Anything unknown is the default, never sent on. */
export function readTenantListParams(params: URLSearchParams): TenantListParams {
  const sort = params.get('sort');
  const order = params.get('order');
  const activity = params.get('activity');
  return {
    sort: isKey(TENANT_SORTS, sort) ? sort : DEFAULT_SORT,
    order: isKey(SORT_ORDERS, order) ? order : DEFAULT_ORDER,
    ...(isKey(TENANT_ACTIVITIES, activity) ? { activity } : {}),
  };
}

/**
 * A new URL with the change applied. Defaults are left out of the URL, `activity: null`
 * clears the filter, anything not named is kept, and the page goes back to the first.
 */
export function writeTenantListParams(
  current: URLSearchParams,
  change: { sort?: AdminTenantSort; order?: AdminSortOrder; activity?: AdminTenantActivity | null },
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete('page');
  if (change.sort !== undefined) {
    if (change.sort === DEFAULT_SORT) next.delete('sort');
    else next.set('sort', change.sort);
  }
  if (change.order !== undefined) {
    if (change.order === DEFAULT_ORDER) next.delete('order');
    else next.set('order', change.order);
  }
  if (change.activity !== undefined) {
    if (change.activity === null) next.delete('activity');
    else next.set('activity', change.activity);
  }
  return next;
}

/** A click on a column header: the same column flips its order, another starts with the highest first. */
export function nextSort(
  current: { sort: AdminTenantSort; order: AdminSortOrder },
  column: AdminTenantSort,
): { sort: AdminTenantSort; order: AdminSortOrder } {
  if (current.sort === column) return { sort: column, order: current.order === 'desc' ? 'asc' : 'desc' };
  return { sort: column, order: 'desc' };
}

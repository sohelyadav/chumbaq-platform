import type { AdminTenantUsage, UsageMetric, UsageMonth } from '@chumbaq/shared';
import { UsageTrendChart } from '@/components/usage-trend-chart';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminErrorMessage, httpStatus, useAdminTenantUsage } from '@/hooks/use-admin-tenants';
import {
  TREND_METRICS,
  USAGE_METRIC_LABELS,
  countedThroughLabel,
  formatCount,
  formatDay,
  formatMonth,
  mauCountedFrom,
  messagesSent,
} from '@/lib/usage-format';

const DAYS = 90;

function monthHeading(month: UsageMonth | null, fallback: string): string {
  if (!month) return fallback;
  return `${formatMonth(month.month)}${month.partial ? ' (partial)' : ''}`;
}

function monthTitle(month: UsageMonth | null): string | undefined {
  return month ? `${formatDay(month.from)} to ${formatDay(month.through)}` : undefined;
}

/** The number, and in the month active devices started being counted a note that it may be low. */
function MonthCell({ value, note }: { value: number | null; note: string | null }) {
  return (
    <TableCell className="text-right text-sm tabular-nums" title={note ?? undefined}>
      {formatCount(value)}
      {note && <span className="block text-xs font-normal text-muted-foreground">First month counted, {note}</span>}
    </TableCell>
  );
}

function MonthsTable({ usage }: { usage: AdminTenantUsage }) {
  const { thisMonth, lastMonth } = usage;
  const noteFor = (key: string, month: UsageMonth | null) =>
    key === 'mau_month_to_date' ? mauCountedFrom(usage.coverage, month?.month) : null;
  const rows: { key: string; label: string; value: (month: UsageMonth | null) => number | null }[] = [
    ...TREND_METRICS.map((metric: UsageMetric) => ({
      key: metric,
      label: USAGE_METRIC_LABELS[metric],
      value: (month: UsageMonth | null) => month?.values[metric] ?? null,
    })),
    {
      key: 'messages',
      label: 'Messages sent, all channels',
      value: (month: UsageMonth | null) => (month ? messagesSent(month.values) : null),
    },
  ];
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">This month vs last month</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Metric</TableHead>
            <TableHead className="text-right" title={monthTitle(thisMonth)}>
              {monthHeading(thisMonth, 'This month')}
            </TableHead>
            <TableHead className="text-right" title={monthTitle(lastMonth)}>
              {monthHeading(lastMonth, 'Last month')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="text-sm">{row.label}</TableCell>
              <MonthCell value={row.value(thisMonth)} note={noteFor(row.key, thisMonth)} />
              <MonthCell value={row.value(lastMonth)} note={noteFor(row.key, lastMonth)} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Monthly active devices is the count on the month&apos;s last counted day; the rest are totals.
      </p>
    </div>
  );
}

function ProjectsTable({ usage }: { usage: AdminTenantUsage }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">By project, last {usage.days} counted days</h3>
      {usage.projects.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No projects billed to this tenant.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead className="text-right">Monthly active devices</TableHead>
              <TableHead className="text-right">Messages ({usage.days}d)</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead className="text-right">Link clicks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.projects.map((project) => (
              <TableRow key={project.projectId}>
                <TableCell className="max-w-[240px] truncate text-sm font-medium">
                  {project.name ?? <span className="italic text-muted-foreground">Deleted project</span>}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatCount(project.values.mau_month_to_date)}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatCount(messagesSent(project.values))}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">{formatCount(project.values.events)}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{formatCount(project.values.clicks)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** A tenant's usage from the daily roll-up: counts only, all of them for days billed to this account. */
export function TenantUsageCard({ tenantId }: { tenantId: string }) {
  const { data: usage, isLoading, isError, error } = useAdminTenantUsage(tenantId, DAYS);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Usage</CardTitle>
        <p className="text-sm text-muted-foreground">
          {!usage
            ? 'Daily counts across this tenant’s projects'
            : usage.coverage?.countedThrough
              ? `${countedThroughLabel(usage.coverage)} (UTC days)`
              : countedThroughLabel(usage.coverage)}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-64" />
            <Skeleton className="h-32" />
          </div>
        ) : isError || !usage ? (
          <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
            {httpStatus(error) === 403
              ? 'You do not have access to this tenant’s usage.'
              : adminErrorMessage(error, 'Usage could not be loaded.')}
          </p>
        ) : !usage.coverage?.countedThrough ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Not counted yet. Usage appears once the daily roll-up has closed its first day.
          </p>
        ) : (
          <>
            <UsageTrendChart days={usage.series} coverage={usage.coverage} />
            <div className="space-y-6">
              <MonthsTable usage={usage} />
              <ProjectsTable usage={usage} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

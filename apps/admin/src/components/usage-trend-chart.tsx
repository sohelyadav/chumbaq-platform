import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import type { UsageCoverage, UsageDay, UsageMetric } from '@chumbaq/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  TREND_METRICS,
  USAGE_METRIC_LABELS,
  formatCount,
  formatDay,
  formatShortDay,
  trendPoints,
} from '@/lib/usage-format';

type Point = { date: string; value: number | null };

function TrendTooltip({ active, payload, metric }: TooltipProps<number, string> & { metric: UsageMetric }) {
  const point = payload?.[0]?.payload as Point | undefined;
  if (!active || !point) return null;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
      <p className="font-semibold tabular-nums">{formatCount(point.value)}</p>
      <p className="text-xs text-muted-foreground">
        {USAGE_METRIC_LABELS[metric]}, {formatDay(point.date)}
      </p>
    </div>
  );
}

/**
 * One usage metric per counted day. A day the roll-up did not count (monthly active
 * devices before they were first counted, say) is a gap in the line, never a 0.
 */
export function UsageTrendChart({
  days,
  coverage,
  initialMetric = 'mau_month_to_date',
}: {
  days: UsageDay[];
  coverage: UsageCoverage | null;
  initialMetric?: UsageMetric;
}) {
  const [metric, setMetric] = useState<UsageMetric>(initialMetric);
  const points = useMemo(() => trendPoints(days, metric), [days, metric]);

  if (!coverage?.countedThrough || days.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No usage counted yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Select value={metric} onValueChange={(value) => setMetric(value as UsageMetric)}>
        <SelectTrigger className="w-[220px]" aria-label="Metric shown in the chart">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TREND_METRICS.map((option) => (
            <SelectItem key={option} value={option}>
              {USAGE_METRIC_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 5, right: 5, bottom: 0, left: -20 }} accessibilityLayer>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="date"
              tickFormatter={formatShortDay}
              interval="preserveStartEnd"
              minTickGap={32}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--border)' }}
              tickMargin={4}
            />
            <YAxis
              allowDecimals={false}
              tickFormatter={(value: number) => value.toLocaleString('en-US')}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip content={<TrendTooltip metric={metric} />} cursor={{ stroke: 'var(--border)' }} />
            {/* chart-2 for the same contrast reason as the signups chart. */}
            <Line
              type="monotone"
              dataKey="value"
              name={USAGE_METRIC_LABELS[metric]}
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View as table</summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">{USAGE_METRIC_LABELS[metric]}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points.map((point) => (
                <TableRow key={point.date}>
                  <TableCell>{formatDay(point.date)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(point.value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </div>
  );
}

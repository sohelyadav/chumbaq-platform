import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import type { AdminOverview } from '@chumbaq/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One entry per calendar day, oldest first. A day with no signups may simply be
 * absent from the response, and on a category axis a missing day would close the
 * gap and misstate the trend. The window starts earlier if the API returned an
 * older day, so the bars always add up to what the API counted.
 */
export function fillSignupDays(
  rows: AdminOverview['signupsByDay'],
  now = Date.now(),
): { date: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.date.slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + row.count);
  }

  const dayOf = (key: string) => Date.parse(`${key}T00:00:00Z`);
  const today = dayOf(dayKey(now));
  let start = today - (WINDOW_DAYS - 1) * DAY_MS;
  let end = today;
  for (const key of counts.keys()) {
    start = Math.min(start, dayOf(key));
    end = Math.max(end, dayOf(key));
  }

  const days: { date: string; count: number }[] = [];
  for (let day = start; day <= end; day += DAY_MS) {
    const key = dayKey(day);
    days.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return days;
}

// parseISO reads a bare date as local midnight. `new Date('2026-11-04')` is UTC
// midnight, which renders as Nov 3 anywhere west of Greenwich.
const shortDay = (date: string) => format(parseISO(date), 'MMM d');
const longDay = (date: string) => format(parseISO(date), 'MMM d, yyyy');

function SignupsTooltip({ active, payload }: TooltipProps<number, string>) {
  const point = payload?.[0]?.payload as { date: string; count: number } | undefined;
  if (!active || !point) return null;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
      <p className="font-semibold tabular-nums">
        {point.count.toLocaleString()} {point.count === 1 ? 'signup' : 'signups'}
      </p>
      <p className="text-xs text-muted-foreground">{longDay(point.date)}</p>
    </div>
  );
}

export function SignupsChart({ rows }: { rows: AdminOverview['signupsByDay'] }) {
  const days = useMemo(() => fillSignupDays(rows), [rows]);

  if (days.every((day) => day.count === 0)) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No signups in the last 30 days
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={days}
            margin={{ top: 5, right: 5, bottom: 0, left: -20 }}
            barCategoryGap={2}
            accessibilityLayer
          >
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="date"
              tickFormatter={shortDay}
              interval="preserveStartEnd"
              minTickGap={32}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--border)' }}
              tickMargin={4}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip content={<SignupsTooltip />} cursor={{ fill: 'var(--muted)' }} />
            {/* The accent setting redefines the chart tokens. chart-2 is the step that
                keeps roughly 3:1 on the card in every accent and both modes: chart-1
                and chart-3 drop to about 2:1 on some (orange light, violet dark). */}
            <Bar
              dataKey="count"
              name="Signups"
              fill="var(--chart-2)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          View as table
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Signups</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((day) => (
                <TableRow key={day.date}>
                  <TableCell>{longDay(day.date)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {day.count.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </div>
  );
}

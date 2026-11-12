import { useState, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { format, subDays } from 'date-fns';
import { Button } from '@/components/ui/button';
import { useLinkTimeseries } from '@/hooks/use-analytics';

interface ClicksChartProps {
  linkId: string;
  hideFilters?: boolean;
  rangeIdx?: number;
  onRangeChange?: (idx: number) => void;
}

export const ranges = [
  { label: '7d', days: 7, granularity: 'day' },
  { label: '30d', days: 30, granularity: 'day' },
  { label: '90d', days: 90, granularity: 'week' },
] as const;

export function ClicksChart({ linkId, hideFilters, rangeIdx: externalIdx, onRangeChange }: ClicksChartProps) {
  const [internalIdx, setInternalIdx] = useState(0);
  const rangeIdx = externalIdx ?? internalIdx;
  const setRangeIdx = onRangeChange ?? setInternalIdx;
  const range = ranges[rangeIdx];

  const { start, end } = useMemo(() => {
    const now = new Date();
    return {
      start: subDays(now, range.days).toISOString(),
      end: now.toISOString(),
    };
  }, [range.days]);

  const { data, isLoading } = useLinkTimeseries(linkId, start, end, range.granularity);

  const chartData = (data || []).map((point) => ({
    ...point,
    label: format(new Date(point.date), 'MMM d'),
  }));

  return (
    <div className="h-full flex flex-col">
      {!hideFilters && (
        <div className="flex gap-2 mb-4 shrink-0">
          {ranges.map((r, i) => (
            <Button
              key={r.label}
              variant={i === rangeIdx ? 'default' : 'outline'}
              size="sm"
              onClick={() => setRangeIdx(i)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-[180px]">
        {isLoading ? (
          <div className="h-full animate-pulse rounded bg-muted" />
        ) : chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            No click data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" className="text-xs" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} tickMargin={4} />
              <YAxis className="text-xs" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={40} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                }}
              />
              <Area
                type="monotone"
                dataKey="clicks"
                stroke="var(--chart-1)"
                fill="var(--chart-1)"
                fillOpacity={0.1}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

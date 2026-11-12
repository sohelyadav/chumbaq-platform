import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { format, subDays } from 'date-fns';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  SelectRoot as Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useProjectEvents, useEventNames, useEventVolume, useEventBreakdown } from '@/hooks/use-events';

const ranges = [
  { label: '7d', days: 7, granularity: 'day' as const },
  { label: '30d', days: 30, granularity: 'day' as const },
  { label: '90d', days: 90, granularity: 'week' as const },
];

const tooltipStyle = {
  backgroundColor: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
};

export default function EventExplorerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [rangeIdx, setRangeIdx] = useState(1);
  const [eventFilter, setEventFilter] = useState('');
  const [page, setPage] = useState(1);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const range = ranges[rangeIdx];

  const { start, end } = useMemo(() => {
    const now = new Date();
    return { start: subDays(now, range.days).toISOString(), end: now.toISOString() };
  }, [range.days]);

  const { data: eventNames } = useEventNames(projectId);
  const { data: volume, isLoading: volumeLoading } = useEventVolume(projectId, {
    start, end, granularity: range.granularity, eventName: eventFilter || undefined,
  });
  const { data: breakdown } = useEventBreakdown(projectId, { start, end });
  const { data: eventsResponse, isLoading: eventsLoading } = useProjectEvents(projectId, {
    page, limit: 30, eventName: eventFilter || undefined, start, end,
  });

  const chartData = (volume || []).map((point) => ({
    ...point,
    label: format(new Date(point.date), 'MMM d'),
  }));

  const breakdownData = (breakdown || []).slice(0, 10);
  const events = eventsResponse?.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Events</h1>
          <p className="text-muted-foreground mt-1">Browse all tracked events across your project.</p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={eventFilter} onValueChange={(v) => { setEventFilter(v === 'all' ? '' : v); setPage(1); }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All events" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {eventNames?.map((en) => (
                <SelectItem key={en.eventName} value={en.eventName}>
                  {en.eventName} ({en.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1">
            {ranges.map((r, i) => (
              <Button
                key={r.label}
                variant={i === rangeIdx ? 'default' : 'outline'}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => { setRangeIdx(i); setPage(1); }}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Volume Chart */}
      <Card className="p-4">
        <p className="text-sm font-semibold mb-3">Event Volume</p>
        <div className="h-[240px]">
          {volumeLoading ? (
            <div className="h-full animate-pulse rounded bg-muted" />
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">No events in this period</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
                <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={40} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey="count" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.1} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top Events</CardTitle>
          </CardHeader>
          <CardContent>
            {breakdownData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No data</p>
            ) : (
              <div className="space-y-2">
                {breakdownData.map((item, i) => {
                  const max = breakdownData[0]?.count || 1;
                  return (
                    <div key={item.eventName}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="font-mono font-medium truncate">{item.eventName}</span>
                        <span className="text-muted-foreground shrink-0 ml-2">{item.count}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${(item.count / max) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Event Log */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Event Log</CardTitle>
            <CardDescription className="text-xs">Raw events with properties</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {eventsLoading ? (
              <div className="p-6 space-y-3">
                {[...Array(5)].map((_, i) => <div key={i} className="h-10 animate-pulse rounded bg-muted" />)}
              </div>
            ) : !events || events.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No events found.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Event</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <>
                      <TableRow
                        key={event.id}
                        className="cursor-pointer"
                        onClick={() => setExpandedRow(expandedRow === event.id ? null : event.id)}
                      >
                        <TableCell className="w-8 pr-0">
                          {event.properties && Object.keys(event.properties).length > 0 ? (
                            expandedRow === event.id ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-xs">{event.eventName}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono truncate max-w-[120px]">
                          {event.distinctId?.slice(0, 12) || '—'}
                        </TableCell>
                        <TableCell className="text-xs">{event.platform || '—'}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {format(new Date(event.timestamp), 'MMM d, HH:mm:ss')}
                        </TableCell>
                      </TableRow>
                      {expandedRow === event.id && event.properties && (
                        <TableRow key={`${event.id}-props`}>
                          <TableCell colSpan={5} className="bg-muted/30 py-2 px-6">
                            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
                              {JSON.stringify(event.properties, null, 2)}
                            </pre>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

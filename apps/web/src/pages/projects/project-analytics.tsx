import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { format, subDays } from 'date-fns';
import {
  MousePointerClick, Users, Store, Smartphone, TrendingUp, Globe, BarChart3,
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  useProjectAnalyticsSummary,
  useProjectTimeseries,
  useProjectDevices,
  useProjectGeo,
  useProjectReferrers,
  useProjectDashboardStats,
} from '@/hooks/use-analytics';

const CONTRAST_COLORS = [
  'var(--chart-1)',
  '#0ea5e9',
  '#16a34a',
  '#f97316',
  '#dc2626',
  '#7c3aed',
];

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

export default function ProjectAnalyticsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [rangeIdx, setRangeIdx] = useState(1);
  const range = ranges[rangeIdx];

  const { start, end } = useMemo(() => {
    const now = new Date();
    return { start: subDays(now, range.days).toISOString(), end: now.toISOString() };
  }, [range.days]);

  const { data: summary, isLoading: summaryLoading } = useProjectAnalyticsSummary(projectId);
  const { data: timeseries, isLoading: tsLoading } = useProjectTimeseries(projectId, start, end, range.granularity);
  const { data: devices, isLoading: devicesLoading } = useProjectDevices(projectId);
  const { data: geo, isLoading: geoLoading } = useProjectGeo(projectId);
  const { data: referrers, isLoading: referrersLoading } = useProjectReferrers(projectId);
  const { data: dashStats } = useProjectDashboardStats(projectId!);

  const chartData = (timeseries || []).map((point) => ({
    ...point,
    label: format(new Date(point.date), 'MMM d'),
  }));

  const statCards = summary ? [
    { label: 'Total Clicks', value: summary.totalClicks, icon: MousePointerClick },
    { label: 'Unique Visitors', value: summary.uniqueVisitors, icon: Users },
    { label: 'Store Redirects', value: summary.storeRedirects, icon: Store },
    { label: 'Installs', value: summary.matchedInstalls, icon: Smartphone },
    { label: 'Conversion Rate', value: `${(summary.conversionRate * 100).toFixed(1)}%`, icon: TrendingUp },
  ] : [];

  const pieData = devices?.deviceTypes?.map((d) => ({ name: d.name || 'Unknown', value: d.count })) || [];
  const referrerTotal = referrers?.reduce((sum, r) => sum + r.count, 0) || 0;
  const geoTotal = geo?.countries?.reduce((sum, c) => sum + c.count, 0) || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="text-muted-foreground mt-1">Project-wide performance metrics across all links.</p>
        </div>
      </div>

      {/* Stat Cards */}
      {summaryLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg border bg-muted" />
          ))}
        </div>
      ) : statCards.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {statCards.map((stat) => (
            <div key={stat.label} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground truncate">{stat.label}</p>
                <p className="text-lg font-bold">
                  {typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}
                </p>
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <stat.icon className="h-4 w-4" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Click Trends */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold">Click Trends</p>
          <div className="flex gap-1">
            {ranges.map((r, i) => (
              <Button
                key={r.label}
                variant={i === rangeIdx ? 'default' : 'outline'}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setRangeIdx(i)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="h-[280px]">
          {tsLoading ? (
            <div className="h-full animate-pulse rounded bg-muted" />
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              No click data for this period
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} tickMargin={4} />
                <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={40} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey="clicks" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.1} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Devices */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Devices & Browsers</CardTitle>
          </CardHeader>
          <CardContent>
            {devicesLoading ? (
              <div className="h-64 animate-pulse rounded bg-muted" />
            ) : !devices || devices.deviceTypes.length === 0 ? (
              <div className="h-40 flex items-center justify-center text-muted-foreground">No device data</div>
            ) : (
              <div className="space-y-6">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={3} dataKey="value">
                      {pieData.map((_, index) => (
                        <Cell
                          key={index}
                          fill={CONTRAST_COLORS[index % CONTRAST_COLORS.length]}
                          stroke="var(--card)"
                          strokeWidth={1}
                        />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: '11px' }} />
                  </PieChart>
                </ResponsiveContainer>
                {/* OS bars */}
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Operating System</h4>
                  <div className="space-y-2">
                    {devices.operatingSystems.map((entry, i) => {
                      const max = Math.max(...devices.operatingSystems.map((e) => e.count));
                      const total = devices.operatingSystems.reduce((s, e) => s + e.count, 0);
                      return (
                        <div key={entry.name || i}>
                          <div className="flex items-center justify-between text-xs mb-0.5">
                            <span className="font-medium truncate">{entry.name || 'Unknown'}</span>
                            <span className="text-muted-foreground">{entry.count.toLocaleString()} ({total > 0 ? ((entry.count / total) * 100).toFixed(0) : 0}%)</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${max > 0 ? (entry.count / max) * 100 : 0}%`,
                                backgroundColor: CONTRAST_COLORS[i % CONTRAST_COLORS.length],
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* Browser bars */}
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Browser</h4>
                  <div className="space-y-2">
                    {devices.browsers.map((entry, i) => {
                      const max = Math.max(...devices.browsers.map((e) => e.count));
                      const total = devices.browsers.reduce((s, e) => s + e.count, 0);
                      return (
                        <div key={entry.name || i}>
                          <div className="flex items-center justify-between text-xs mb-0.5">
                            <span className="font-medium truncate">{entry.name || 'Unknown'}</span>
                            <span className="text-muted-foreground">{entry.count.toLocaleString()} ({total > 0 ? ((entry.count / total) * 100).toFixed(0) : 0}%)</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${max > 0 ? (entry.count / max) * 100 : 0}%`,
                                backgroundColor: CONTRAST_COLORS[i % CONTRAST_COLORS.length],
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Geography */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4" /> Geographic Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            {geoLoading ? (
              <div className="h-64 animate-pulse rounded bg-muted" />
            ) : !geo || geo.countries.length === 0 ? (
              <div className="h-40 flex items-center justify-center text-muted-foreground">No geographic data</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Country</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {geo.countries.slice(0, 10).map((entry) => (
                    <TableRow key={entry.code || entry.name}>
                      <TableCell className="font-medium">
                        {entry.name}
                        {entry.code && <span className="ml-1.5 text-xs text-muted-foreground">{entry.code}</span>}
                      </TableCell>
                      <TableCell className="text-right">{entry.count.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {geoTotal > 0 ? ((entry.count / geoTotal) * 100).toFixed(1) : 0}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Referrers */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top Referrers</CardTitle>
            <CardDescription className="text-xs">Where your traffic is coming from</CardDescription>
          </CardHeader>
          <CardContent>
            {referrersLoading ? (
              <div className="h-48 animate-pulse rounded bg-muted" />
            ) : !referrers || referrers.length === 0 ? (
              <div className="h-40 flex items-center justify-center text-muted-foreground">No referrer data</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Referrer</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {referrers.slice(0, 10).map((entry) => (
                    <TableRow key={entry.referrer}>
                      <TableCell className="font-medium truncate max-w-[200px]">{entry.referrer || 'Direct'}</TableCell>
                      <TableCell className="text-right">{entry.count.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {referrerTotal > 0 ? ((entry.count / referrerTotal) * 100).toFixed(1) : 0}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Top Links */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Top Performing Links</CardTitle>
              <CardDescription className="text-xs">By total clicks</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/projects/${projectId}/links`}>View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {dashStats?.topLinks && dashStats.topLinks.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Link</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashStats.topLinks.map((link) => (
                    <TableRow key={link.id}>
                      <TableCell>
                        <Link to={`/projects/${projectId}/links/${link.id}`} className="font-medium hover:underline text-sm">
                          {link.title || link.shortCode}
                        </Link>
                        <p className="text-xs text-muted-foreground font-mono">{link.shortCode}</p>
                      </TableCell>
                      <TableCell className="text-right font-medium">{link.clicks.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="h-40 flex items-center justify-center text-muted-foreground">No links yet</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

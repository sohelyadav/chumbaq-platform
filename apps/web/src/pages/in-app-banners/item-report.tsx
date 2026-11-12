import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, MousePointer, TrendingUp, Tag } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { InAppBanner, WidgetTimeseriesPoint } from '@/hooks/use-inline-banners';

const RANGES = [
  { label: '7d', days: 7, granularity: 'day' },
  { label: '30d', days: 30, granularity: 'day' },
  { label: '90d', days: 90, granularity: 'week' },
];

function useBannerDetail(bannerId: string | undefined) {
  return useQuery<InAppBanner>({
    queryKey: ['in-app-banner', bannerId],
    queryFn: () => apiGet<InAppBanner>(`/api/in-app-banners/${bannerId}`),
    enabled: !!bannerId,
  });
}

function useBannerTimeseries(
  categoryId: string | undefined,
  start?: string,
  end?: string,
  granularity?: string,
) {
  return useQuery<WidgetTimeseriesPoint[]>({
    queryKey: ['widget-analytics-timeseries', categoryId, start, end, granularity],
    queryFn: () => {
      const params: Record<string, unknown> = {};
      if (start) params.start = start;
      if (end) params.end = end;
      if (granularity) params.granularity = granularity;
      return apiGet<WidgetTimeseriesPoint[]>(
        `/api/banner-categories/${categoryId}/analytics/timeseries`,
        params,
      );
    },
    enabled: !!categoryId,
  });
}

export default function ItemReportPage() {
  const { projectId, type, categoryId, itemId } = useParams<{
    projectId: string;
    type: string;
    categoryId: string;
    itemId: string;
  }>();
  const navigate = useNavigate();
  const [rangeIdx, setRangeIdx] = useState(1);
  const range = RANGES[rangeIdx];

  const { data: banner, isLoading } = useBannerDetail(itemId);

  const start = new Date(Date.now() - range.days * 86400000).toISOString();
  const end = new Date().toISOString();
  const { data: timeseries } = useBannerTimeseries(categoryId, start, end, range.granularity);

  const goBack = () => navigate(`/projects/${projectId}/widgets/${type}/${categoryId}`);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (!banner) {
    return <div className="p-8 text-center text-muted-foreground">Item not found.</div>;
  }

  const ctr = banner.impressions > 0
    ? ((banner.clicks / banner.impressions) * 100).toFixed(1)
    : '0';

  const meta = banner.metadata || {};
  const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const utmEntries = utmKeys
    .filter((k) => meta[k])
    .map((k) => ({ label: k.replace('utm_', ''), value: meta[k] as string }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={goBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold truncate">{banner.title}</h1>
          <p className="text-sm text-muted-foreground truncate">{banner.clickUrl}</p>
        </div>
        <Badge variant={banner.isActive ? 'default' : 'outline'}>
          {banner.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      {/* Image preview */}
      {banner.imageUrl && (
        <div className="h-40 w-full overflow-hidden rounded-lg bg-muted">
          <img src={banner.imageUrl} alt="" className="h-full w-full object-contain" />
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs text-muted-foreground">Impressions</p>
              <p className="text-2xl font-bold">{banner.impressions.toLocaleString()}</p>
            </div>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Eye className="h-4 w-4" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs text-muted-foreground">Clicks</p>
              <p className="text-2xl font-bold">{banner.clicks.toLocaleString()}</p>
            </div>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <MousePointer className="h-4 w-4" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs text-muted-foreground">CTR</p>
              <p className="text-2xl font-bold">{ctr}%</p>
            </div>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <TrendingUp className="h-4 w-4" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Performance chart — shows widget-level traffic (per-item timeseries not yet available) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Widget Performance</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Aggregate traffic for the entire widget</p>
          </div>
          <div className="flex items-center gap-1">
            {RANGES.map((r, i) => (
              <Button
                key={r.label}
                variant={rangeIdx === i ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => setRangeIdx(i)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-56">
            {timeseries && timeseries.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timeseries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(d) => new Date(d).toLocaleDateString()}
                  />
                  <Bar dataKey="impressions" fill="var(--chart-4)" fillOpacity={0.75} radius={[4, 4, 0, 0]} name="Impressions" />
                  <Bar dataKey="clicks" fill="var(--chart-1)" fillOpacity={1} radius={[4, 4, 0, 0]} name="Clicks" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No data available for this period
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* UTM breakdown */}
      {utmEntries.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Tag className="h-4 w-4" /> UTM Parameters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {utmEntries.map((entry) => (
                <div key={entry.label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground capitalize">{entry.label}</p>
                  <p className="mt-0.5 text-sm font-medium truncate">{entry.value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Schedule info */}
      {(banner.startsAt || banner.expiresAt) && (
        <Card>
          <CardContent className="p-4">
            <div className="flex gap-6 text-sm">
              {banner.startsAt && (
                <div>
                  <span className="text-muted-foreground">Starts: </span>
                  <span className="font-medium">{new Date(banner.startsAt).toLocaleString()}</span>
                </div>
              )}
              {banner.expiresAt && (
                <div>
                  <span className="text-muted-foreground">Expires: </span>
                  <span className="font-medium">{new Date(banner.expiresAt).toLocaleString()}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

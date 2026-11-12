import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useLinkAnalytics } from '@/hooks/use-analytics';

interface ConversionFunnelProps {
  linkId: string;
}

export function ConversionFunnel({ linkId }: ConversionFunnelProps) {
  const { data, isLoading } = useLinkAnalytics(linkId);

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded bg-muted" />;
  }

  if (!data || data.totalClicks === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-muted-foreground">
        No conversion data available
      </div>
    );
  }

  const funnelData = [
    { stage: 'Clicks', value: data.totalClicks },
    { stage: 'Store Redirects', value: data.storeRedirects },
    { stage: 'Installs', value: data.matchedInstalls },
    { stage: 'Conversions', value: data.conversionsByType.reduce((sum, c) => sum + c.count, 0) },
  ];

  return (
    <div className="space-y-6">
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={funnelData} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis type="number" tick={{ fill: 'var(--muted-foreground)' }} />
          <YAxis
            type="category"
            dataKey="stage"
            width={120}
            tick={{ fill: 'var(--muted-foreground)' }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '0.5rem',
              fontSize: '0.875rem',
            }}
          />
          <Bar dataKey="value" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>

      {/* Funnel metrics */}
      <div className="grid gap-4 sm:grid-cols-3">
        {data.totalClicks > 0 && (
          <>
            <div className="text-center p-3 rounded-lg bg-muted">
              <p className="text-sm text-muted-foreground">Store Redirect Rate</p>
              <p className="text-lg font-bold">
                {((data.storeRedirects / data.totalClicks) * 100).toFixed(1)}%
              </p>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted">
              <p className="text-sm text-muted-foreground">Install Rate</p>
              <p className="text-lg font-bold">
                {((data.matchedInstalls / data.totalClicks) * 100).toFixed(1)}%
              </p>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted">
              <p className="text-sm text-muted-foreground">Conversion Rate</p>
              <p className="text-lg font-bold">
                {(data.conversionRate * 100).toFixed(1)}%
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

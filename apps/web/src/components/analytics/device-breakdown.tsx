import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { Monitor, Smartphone, Apple, Globe, Laptop } from 'lucide-react';
import { useLinkDevices } from '@/hooks/use-analytics';

interface DeviceBreakdownProps {
  linkId: string;
}

const CONTRAST_COLORS = [
  'var(--chart-1)',
  '#0ea5e9',
  '#16a34a',
  '#f97316',
  '#dc2626',
  '#7c3aed',
];

function getOsIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes('ios') || n.includes('mac')) return Apple;
  if (n.includes('android')) return Smartphone;
  if (n.includes('windows')) return Monitor;
  if (n.includes('linux')) return Laptop;
  if (n.includes('chrome')) return Globe;
  return Globe;
}

function getBrowserIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes('chrome')) return Globe;
  if (n.includes('safari')) return Globe;
  if (n.includes('firefox')) return Globe;
  if (n.includes('edge')) return Globe;
  return Globe;
}

function BarList({ items, getIcon, label }: {
  items: { name: string; count: number }[];
  getIcon: (name: string) => typeof Monitor;
  label: string;
}) {
  const total = items.reduce((sum, i) => sum + i.count, 0);
  const max = Math.max(...items.map((i) => i.count));

  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground bg-muted/60 rounded px-2.5 py-1.5 mb-3 inline-block">{label}</h4>
      <div className="space-y-3">
        {items.map((entry, i) => {
          const Icon = getIcon(entry.name);
          const pct = total > 0 ? (entry.count / total) * 100 : 0;
          const barWidth = max > 0 ? (entry.count / max) * 100 : 0;
          return (
            <div key={entry.name || i}>
              <div className="flex items-center gap-2 mb-1">
                <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs font-medium flex-1 truncate">{entry.name || 'Unknown'}</span>
                <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                  {entry.count.toLocaleString()}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground w-10 text-right shrink-0">
                  {pct.toFixed(0)}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${barWidth}%`, backgroundColor: CONTRAST_COLORS[i % CONTRAST_COLORS.length] }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DeviceBreakdown({ linkId }: DeviceBreakdownProps) {
  const { data, isLoading } = useLinkDevices(linkId);

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded bg-muted" />;
  }

  if (!data || data.deviceTypes.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-muted-foreground">
        No device data available
      </div>
    );
  }

  const pieData = data.deviceTypes.map((d) => ({ name: d.name || 'Unknown', value: d.count }));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Left: Donut + Device type bars */}
      <div className="space-y-6">
        <div>
          <h4 className="text-xs font-medium text-muted-foreground bg-muted/60 rounded px-2.5 py-1.5 mb-3 inline-block">Device Type</h4>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={85}
                paddingAngle={3}
                dataKey="value"
              >
                {pieData.map((_, index) => (
                  <Cell
                    key={index}
                    fill={CONTRAST_COLORS[index % CONTRAST_COLORS.length]}
                    stroke="var(--card)"
                    strokeWidth={1}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: '0.5rem',
                  fontSize: '0.75rem',
                }}
              />
              <Legend iconSize={8} wrapperStyle={{ fontSize: '11px' }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Right: OS + Browser bars */}
      <div className="space-y-6">
        <BarList
          label="Operating System"
          items={data.operatingSystems.map((d) => ({ name: d.name, count: d.count }))}
          getIcon={getOsIcon}
        />
        <BarList
          label="Browser"
          items={data.browsers.map((d) => ({ name: d.name, count: d.count }))}
          getIcon={getBrowserIcon}
        />
      </div>
    </div>
  );
}

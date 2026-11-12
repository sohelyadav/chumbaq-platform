import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Pencil, Play, Pause, Trash2, Send, Copy,
  Eye, MousePointer, TrendingUp, Users, XCircle, Clock,
  MessageSquare,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  SelectRoot as Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useInAppMessage,
  useMessageAnalytics,
  useMessageTimeseries,
  useMessageButtonBreakdown,
  useActivateMessage,
  usePauseMessage,
  useDuplicateMessage,
  useDeleteInAppMessage,
  useTriggerMessage,
} from '@/hooks/use-in-app-messages';
import { toast } from '@/components/ui/use-toast';

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
  scheduled: { label: 'Scheduled', className: 'bg-blue-100 text-blue-800 border-blue-300' },
  active: { label: 'Active', className: 'bg-green-100 text-green-800 border-green-300' },
  paused: { label: 'Paused', className: 'bg-gray-100 text-gray-600 border-gray-300' },
  completed: { label: 'Completed', className: 'bg-purple-100 text-purple-800 border-purple-300' },
  archived: { label: 'Archived', className: 'bg-slate-100 text-slate-600 border-slate-300' },
};

const TYPE_LABELS: Record<string, string> = {
  modal: '💬 Modal',
  bottom_sheet: '📋 Bottom Sheet',
  banner_top: '🔔 Top Banner',
  banner_bottom: '📢 Bottom Banner',
  fullscreen: '📱 Full Screen',
};

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
];

export default function CampaignDetailPage() {
  const { projectId, id } = useParams<{ projectId: string; id: string }>();
  const navigate = useNavigate();
  const [rangeIdx, setRangeIdx] = useState(1);
  const [showTrigger, setShowTrigger] = useState(false);

  const range = RANGES[rangeIdx];
  const start = range.days > 0
    ? new Date(Date.now() - range.days * 86400000).toISOString()
    : undefined;
  const end = range.days > 0 ? new Date().toISOString() : undefined;

  const { data: message, isLoading } = useInAppMessage(projectId, id);
  const { data: analytics } = useMessageAnalytics(projectId, id);
  const { data: timeseries } = useMessageTimeseries(projectId, id, { start, end });
  const { data: buttonBreakdown } = useMessageButtonBreakdown(projectId, id);

  const activateMutation = useActivateMessage(projectId!);
  const pauseMutation = usePauseMessage(projectId!);
  const duplicateMutation = useDuplicateMessage(projectId!);
  const deleteMutation = useDeleteInAppMessage(projectId!);
  const triggerMutation = useTriggerMessage(projectId!);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-48 animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}><CardContent className="p-4"><div className="h-16 animate-pulse rounded bg-muted" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  if (!message) {
    return <div className="p-8 text-center text-muted-foreground">Campaign not found.</div>;
  }

  const statusCfg = STATUS_CONFIG[message.status] || STATUS_CONFIG.draft;
  const ctr = analytics?.clickRate ? (analytics.clickRate * 100).toFixed(1) : '0.0';
  const dismissRate = analytics?.dismissRate ? (analytics.dismissRate * 100).toFixed(1) : '0.0';

  // Funnel data for chart
  const funnelData = analytics ? [
    { name: 'Delivered', value: analytics.totalDelivered, fill: 'var(--chart-3)' },
    { name: 'Impressions', value: analytics.totalImpressions, fill: 'var(--chart-2)' },
    { name: 'Clicks', value: analytics.totalClicks + analytics.totalCtaClicks, fill: 'var(--chart-1)' },
    { name: 'Dismissed', value: analytics.totalDismissals, fill: 'var(--destructive)' },
  ] : [];

  const handleTrigger = async (targetType: 'all' | 'cohort' | 'users') => {
    try {
      const result = await triggerMutation.mutateAsync({
        messageId: message.id,
        targetType,
      });
      toast({ title: `Queued for ${result.queued} devices` });
      setShowTrigger(false);
    } catch {
      toast({ title: 'Failed to trigger', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/projects/${projectId}/in-app-messages`)}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{message.name}</h1>
              <Badge variant="outline" className={statusCfg.className}>{statusCfg.label}</Badge>
            </div>
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              {TYPE_LABELS[message.messageType]} · Created {new Date(message.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowTrigger(true)}>
            <Send className="mr-1 h-4 w-4" /> Trigger Now
          </Button>
          {(message.status === 'draft' || message.status === 'paused') && (
            <Button size="sm" onClick={() => activateMutation.mutateAsync(message.id)}>
              <Play className="mr-1 h-4 w-4" /> Activate
            </Button>
          )}
          {message.status === 'active' && (
            <Button variant="outline" size="sm" onClick={() => pauseMutation.mutateAsync(message.id)}>
              <Pause className="mr-1 h-4 w-4" /> Pause
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => navigate(`/projects/${projectId}/in-app-messages/${id}/edit`)}>
            <Pencil className="mr-1 h-4 w-4" /> Edit
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          { label: 'Delivered', value: analytics?.totalDelivered ?? 0, icon: MessageSquare, color: 'bg-slate-100 text-slate-600' },
          { label: 'Impressions', value: analytics?.totalImpressions ?? 0, icon: Eye, color: 'bg-blue-100 text-blue-600' },
          { label: 'Clicks', value: (analytics?.totalClicks ?? 0) + (analytics?.totalCtaClicks ?? 0), icon: MousePointer, color: 'bg-green-100 text-green-600' },
          { label: 'CTR', value: `${ctr}%`, icon: TrendingUp, color: 'bg-emerald-100 text-emerald-600' },
          { label: 'Dismissed', value: analytics?.totalDismissals ?? 0, icon: XCircle, color: 'bg-red-100 text-red-600' },
          { label: 'Unique Users', value: analytics?.uniqueUsers ?? 0, icon: Users, color: 'bg-purple-100 text-purple-600' },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{stat.label}</p>
                  <p className="text-lg font-bold">
                    {typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}
                  </p>
                </div>
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${stat.color}`}>
                  <stat.icon className="h-4 w-4" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Timeseries Chart */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Performance Over Time</CardTitle>
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
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-64">
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
                      <Bar dataKey="impressions" fill="var(--chart-2)" radius={[4, 4, 0, 0]} name="Impressions" />
                      <Bar dataKey="clicks" fill="var(--chart-1)" radius={[4, 4, 0, 0]} name="Clicks" />
                      <Bar dataKey="dismissals" fill="var(--destructive)" radius={[4, 4, 0, 0]} name="Dismissals" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                    No data available for this period
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Funnel / Button Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conversion Funnel</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              {funnelData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={funnelData} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                    <YAxis
                      dataKey="name"
                      type="category"
                      tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                      width={80}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--card)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {funnelData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                  No analytics data yet
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Button Click Breakdown */}
      {buttonBreakdown && buttonBreakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Button Click Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {buttonBreakdown.map((b) => {
                const total = buttonBreakdown.reduce((sum, x) => sum + x.clicks, 0);
                const pct = total > 0 ? ((b.clicks / total) * 100).toFixed(0) : '0';
                return (
                  <div key={b.buttonId} className="flex items-center justify-between rounded-lg border p-3">
                    <span className="text-sm font-medium">{b.buttonId}</span>
                    <div className="flex items-center gap-3">
                      <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-sm text-muted-foreground w-16 text-right">{b.clicks} ({pct}%)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Message Preview Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Message Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border p-4 space-y-3 max-w-md">
            {message.imageUrl && (
              <img
                src={message.imageUrl}
                alt={message.title}
                className="w-full h-40 object-cover rounded-md"
              />
            )}
            <h3 className="font-bold text-lg">{message.title}</h3>
            {message.body && (
              <p className="text-sm text-muted-foreground">{message.body}</p>
            )}
            {message.buttons && message.buttons.length > 0 && (
              <div className="flex flex-col gap-2">
                {message.buttons.map((btn) => (
                  <div
                    key={btn.id}
                    className={`text-center text-sm py-2 rounded-md ${
                      btn.style === 'primary'
                        ? 'bg-primary text-primary-foreground'
                        : btn.style === 'secondary'
                          ? 'border border-primary text-primary'
                          : 'text-primary underline'
                    }`}
                  >
                    {btn.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Trigger Dialog */}
      <Dialog open={showTrigger} onOpenChange={setShowTrigger}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Trigger Message Now</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Push "{message.name}" to users immediately. Select target:
            </p>
            <div className="space-y-2">
              <Button className="w-full justify-start" variant="outline" onClick={() => handleTrigger('all')}>
                <Users className="mr-2 h-4 w-4" /> All Users
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowTrigger(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

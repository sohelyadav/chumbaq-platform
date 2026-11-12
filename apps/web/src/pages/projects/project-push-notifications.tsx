import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Bell, Send, CheckCircle2, XCircle, AlertTriangle, Clock, Loader2,
  CalendarClock, Ban, Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  usePushConfigStatus,
  usePushLogs,
  NotificationStatus,
} from '@/hooks/use-push-notifications';
import { PushSettingsPanel } from './push-settings-panel';
import { PushTemplatesPanel } from './push-templates-panel';
import { format } from 'date-fns';

const statusConfig = {
  scheduled: { icon: CalendarClock, label: 'Scheduled', variant: 'outline' as const, className: 'text-blue-600' },
  queued: { icon: Clock, label: 'Queued', variant: 'secondary' as const, className: 'text-muted-foreground' },
  sending: { icon: Loader2, label: 'Sending', variant: 'secondary' as const, className: 'text-blue-600 animate-spin' },
  sent: { icon: CheckCircle2, label: 'Sent', variant: 'default' as const, className: 'text-green-600' },
  failed: { icon: XCircle, label: 'Failed', variant: 'destructive' as const, className: 'text-red-600' },
  partial: { icon: AlertTriangle, label: 'Partial', variant: 'outline' as const, className: 'text-yellow-600' },
  expanded: { icon: CalendarClock, label: 'By timezone', variant: 'outline' as const, className: 'text-blue-600' },
  cancelled: { icon: Ban, label: 'Cancelled', variant: 'secondary' as const, className: 'text-muted-foreground' },
};

/** Which statuses each filter tab admits. */
const FILTERS: Record<string, NotificationStatus[] | null> = {
  all: null,
  scheduled: ['scheduled', 'queued'],
  sent: ['sent', 'partial'],
  failed: ['failed', 'cancelled'],
};

const audienceLabel = (targetType?: string) => {
  if (targetType === 'segment') return 'Segment';
  if (targetType === 'devices') return 'Device list';
  return 'Everyone';
};

export default function ProjectPushNotificationsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { data: configStatus, isLoading: configLoading } = usePushConfigStatus(projectId);
  const { data: logsResponse, isLoading: logsLoading } = usePushLogs(projectId);
  const [filter, setFilter] = useState('all');

  const logs = logsResponse?.data ?? [];
  const visible = useMemo(() => {
    const allowed = FILTERS[filter];
    return allowed ? logs.filter((l) => allowed.includes(l.status)) : logs;
  }, [logs, filter]);

  const isConfigured = configStatus?.configured && configStatus?.isActive;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">Push Notifications</h1>
          <p className="text-muted-foreground mt-1">
            Send campaigns to your app users and track how they perform.
          </p>
        </div>
        <Button asChild disabled={!isConfigured}>
          <Link to={`/projects/${projectId}/push-notifications/new`}>
            <Plus className="mr-2 h-4 w-4" /> New campaign
          </Link>
        </Button>
      </div>

      <Tabs defaultValue="campaigns">
        <TabsList>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="space-y-4 pt-4">
          {!configLoading && !isConfigured && (
            <Card className="border-destructive/40">
              <CardContent className="flex items-center gap-2 pt-6 text-sm">
                <XCircle className="h-4 w-4 text-destructive" />
                FCM is not configured, so nothing can be sent. Set it up under
                Settings.
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Campaigns</CardTitle>
              <CardDescription>
                Accepted is what Firebase took from us; Delivered is what a
                handset confirmed. They are different numbers.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={filter} onValueChange={setFilter}>
                <TabsList>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
                  <TabsTrigger value="sent">Sent</TabsTrigger>
                  <TabsTrigger value="failed">Failed</TabsTrigger>
                </TabsList>
              </Tabs>

              {logsLoading ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="h-12 animate-pulse rounded bg-muted" />
                  ))}
                </div>
              ) : visible.length === 0 ? (
                <div className="py-12 text-center">
                  <Bell className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {logs.length === 0
                      ? 'No campaigns yet.'
                      : 'No campaigns match this filter.'}
                  </p>
                  {logs.length === 0 && isConfigured && (
                    <Button asChild variant="outline" className="mt-4">
                      <Link to={`/projects/${projectId}/push-notifications/new`}>
                        <Send className="mr-2 h-4 w-4" /> Create your first campaign
                      </Link>
                    </Button>
                  )}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Audience</TableHead>
                      <TableHead>Accepted</TableHead>
                      <TableHead>Delivered</TableHead>
                      <TableHead>CTR</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((log) => {
                      const config = statusConfig[log.status];
                      const StatusIcon = config.icon;
                      return (
                        <TableRow
                          key={log.id}
                          className="cursor-pointer"
                          onClick={() =>
                            navigate(
                              `/projects/${projectId}/push-notifications/${log.id}`,
                            )
                          }
                        >
                          <TableCell>
                            <p className="text-sm font-medium">{log.title}</p>
                            {log.body && (
                              <p className="max-w-xs truncate text-xs text-muted-foreground">
                                {log.body}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={config.variant}>
                              <StatusIcon className={`mr-1 h-3 w-3 ${config.className}`} />
                              {config.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {audienceLabel(log.targetType)}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {log.status === 'queued' || log.status === 'sending'
                              ? `${log.processedTokens}/${log.totalTokens}`
                              : `${log.successCount}/${log.totalTokens}`}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {log.engagement.delivered || '—'}
                          </TableCell>
                          <TableCell className="text-sm">
                            {log.engagement.clickThroughRate === null ? (
                              // Not 0%: nothing has reported yet, and 0% would
                              // read as a campaign that flopped.
                              <span
                                className="text-muted-foreground"
                                title="No delivery reported yet — the app SDK reports these"
                              >
                                —
                              </span>
                            ) : (
                              <span className="font-medium">
                                {log.engagement.clickThroughRate}%
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {log.status === 'scheduled' && log.scheduledAt ? (
                              <span className="text-blue-600">
                                {format(new Date(log.scheduledAt), 'MMM d, HH:mm')}
                              </span>
                            ) : (
                              format(new Date(log.sentAt), 'MMM d, HH:mm')
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="templates" className="pt-4">
          <PushTemplatesPanel projectId={projectId!} />
        </TabsContent>

        <TabsContent value="settings" className="pt-4">
          <PushSettingsPanel projectId={projectId!} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

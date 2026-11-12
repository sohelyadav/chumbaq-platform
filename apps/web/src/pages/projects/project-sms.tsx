import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, Ban, CalendarClock, CheckCircle2, Clock, Loader2, MessageSquare, Plus,
  Trash2, XCircle,
} from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import { usePushLogs } from '@/hooks/use-push-notifications';
import {
  useAddSmsSuppression,
  useRemoveSmsSuppression,
  useSmsSettings,
  useSmsSuppressions,
} from '@/hooks/use-sms';
import { SmsSettingsPanel } from './sms-settings-panel';

const statusConfig = {
  scheduled: { icon: CalendarClock, label: 'Scheduled', variant: 'outline' as const, className: 'text-blue-600' },
  queued: { icon: Clock, label: 'Queued', variant: 'secondary' as const, className: 'text-muted-foreground' },
  sending: { icon: Loader2, label: 'Sending', variant: 'secondary' as const, className: 'text-blue-600 animate-spin' },
  sent: { icon: CheckCircle2, label: 'Sent', variant: 'default' as const, className: 'text-green-600' },
  failed: { icon: XCircle, label: 'Failed', variant: 'destructive' as const, className: 'text-red-600' },
  partial: { icon: AlertTriangle, label: 'Partial', variant: 'outline' as const, className: 'text-yellow-600' },
  expanded: { icon: CalendarClock, label: 'Split', variant: 'outline' as const, className: 'text-blue-600' },
  cancelled: { icon: Ban, label: 'Cancelled', variant: 'secondary' as const, className: 'text-muted-foreground' },
};

const REASON_LABEL: Record<string, string> = {
  unsubscribed: 'Unsubscribed',
  bounced: 'Number not reachable',
  complained: 'Reported as spam',
  manual: 'Added by hand',
};

function CampaignList({ projectId, ready }: { projectId: string; ready: boolean }) {
  const navigate = useNavigate();
  const { data, isLoading } = usePushLogs(projectId, 'sms');
  const logs = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="py-12 text-center">
        <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm text-muted-foreground">No SMS campaigns yet.</p>
        {ready && (
          <Button asChild variant="outline" className="mt-4">
            <Link to={`/projects/${projectId}/sms/new`}>
              <Plus className="mr-2 h-4 w-4" /> Create your first text
            </Link>
          </Button>
        )}
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Campaign</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Sent</TableHead>
          <TableHead>Delivered</TableHead>
          <TableHead>Undelivered</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((log) => {
          const config = statusConfig[log.status];
          const StatusIcon = config.icon;
          const engagement = log.engagement;
          return (
            <TableRow
              key={log.id}
              className="cursor-pointer"
              onClick={() => navigate(`/projects/${projectId}/push-notifications/${log.id}`)}
            >
              <TableCell className="max-w-xs truncate text-sm font-medium">{log.title}</TableCell>
              <TableCell>
                <Badge variant={config.variant}>
                  <StatusIcon className={`mr-1 h-3 w-3 ${config.className}`} />
                  {config.label}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {log.status === 'queued' || log.status === 'sending'
                  ? `${log.processedTokens}/${log.totalTokens}`
                  : `${log.successCount}/${log.totalTokens}`}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{engagement?.delivered || '—'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{engagement?.bounced || '—'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {log.status === 'scheduled' && log.scheduledAt ? (
                  <span className="text-blue-600">{format(new Date(log.scheduledAt), 'MMM d, HH:mm')}</span>
                ) : (
                  format(new Date(log.sentAt), 'MMM d, HH:mm')
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function SuppressionList({ projectId }: { projectId: string }) {
  const [page, setPage] = useState(1);
  const [address, setAddress] = useState('');
  const { data, isLoading } = useSmsSuppressions(projectId, page);
  const add = useAddSmsSuppression(projectId);
  const remove = useRemoveSmsSuppression(projectId);
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  const addOne = async () => {
    try {
      await add.mutateAsync(address.trim());
      setAddress('');
    } catch {
      toast({
        title: 'That is not a valid number',
        description: 'Use international form with the country code: +14155550123.',
        variant: 'destructive',
      });
    }
  };

  const lift = (value: string) => {
    if (!window.confirm(`Text ${value} again? Only do this if they asked to be resubscribed.`)) return;
    remove.mutate(value);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Suppressed numbers</CardTitle>
        <CardDescription>
          Never texted, whatever the campaign. STOP replies and numbers Twilio
          reports as unreachable are added automatically; a START reply lifts
          a STOP.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input placeholder="+14155550123" value={address} onChange={(e) => setAddress(e.target.value)} />
          <Button variant="outline" onClick={addOne} disabled={!address.trim().startsWith('+') || add.isPending}>
            Suppress
          </Button>
        </div>
        {isLoading ? (
          <div className="h-12 animate-pulse rounded bg-muted" />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nobody is suppressed.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Since</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-sm">{row.address}</TableCell>
                  <TableCell className="text-sm text-muted-foreground" title={row.detail ?? undefined}>
                    {REASON_LABEL[row.reason] ?? row.reason}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(new Date(row.createdAt), 'MMM d, yyyy')}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => lift(row.address)} title="Resubscribe">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {total > 50 && (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="text-muted-foreground">Page {page} of {Math.ceil(total / 50)}</span>
            <Button size="sm" variant="outline" disabled={page * 50 >= total} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ProjectSmsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: status, isLoading } = useSmsSettings(projectId);
  const ready = !!status?.readyToSend;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">SMS</h1>
          <p className="mt-1 text-muted-foreground">
            Text campaigns sent through your own Twilio account, with the same
            audiences, schedules and experiments as push and email.
          </p>
        </div>
        <Button asChild disabled={!ready}>
          <Link to={`/projects/${projectId}/sms/new`}>
            <Plus className="mr-2 h-4 w-4" /> New text
          </Link>
        </Button>
      </div>

      <Tabs defaultValue={ready || isLoading ? 'campaigns' : 'settings'}>
        <TabsList>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="suppressions">Suppressions</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="space-y-4 pt-4">
          {!isLoading && !ready && (
            <Card className="border-destructive/40">
              <CardContent className="flex items-center gap-2 pt-6 text-sm">
                <XCircle className="h-4 w-4 text-destructive" />
                SMS is not set up yet. Add a sender and connect Twilio under Settings.
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Campaigns</CardTitle>
              <CardDescription>
                Sent is what Twilio accepted. Delivered and undelivered come from
                its delivery reports, which need the API to be reachable from the
                internet.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CampaignList projectId={projectId!} ready={ready} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="suppressions" className="pt-4">
          <SuppressionList projectId={projectId!} />
        </TabsContent>

        <TabsContent value="settings" className="pt-4">
          <SmsSettingsPanel projectId={projectId!} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

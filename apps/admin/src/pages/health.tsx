import { format } from 'date-fns';
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import type { AdminHealth } from '@chumbaq/shared';
import { AdminQueryError } from '@/components/admin-query-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAdminHealth, useSendPlatformTestEmail } from '@/hooks/use-admin-insights';
import { toast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils';

function DependencyCard({
  name,
  dependency,
}: {
  name: string;
  dependency: AdminHealth['database'];
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{name}</CardTitle>
        {dependency.ok ? (
          <CheckCircle2 className="h-4 w-4 text-green-600" />
        ) : (
          <XCircle className="h-4 w-4 text-destructive" />
        )}
      </CardHeader>
      <CardContent>
        <div className={cn('text-2xl font-bold', !dependency.ok && 'text-destructive')}>
          {dependency.ok ? 'OK' : 'Unreachable'}
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {dependency.latencyMs === null ? 'No latency reading' : `${dependency.latencyMs} ms`}
        </p>
      </CardContent>
    </Card>
  );
}

function StatusBanner({ health }: { health: AdminHealth }) {
  // Either dependency being down means degraded, whatever the summary field says.
  const ok = health.status === 'ok' && health.database.ok && health.redis.ok;
  const failedJobs = health.queues.reduce((sum, queue) => sum + queue.failed, 0);
  const Icon = ok ? CheckCircle2 : AlertTriangle;

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-4',
        ok ? 'border-green-600/30 bg-green-600/5' : 'border-destructive/30 bg-destructive/5',
      )}
    >
      <Icon className={cn('h-5 w-5 shrink-0', ok ? 'text-green-600' : 'text-destructive')} />
      <span className="font-medium">{ok ? 'Operational' : 'Degraded'}</span>
      {failedJobs > 0 && (
        <span className="text-sm text-destructive tabular-nums">
          {failedJobs.toLocaleString()} failed {failedJobs === 1 ? 'job' : 'jobs'}
        </span>
      )}
      <span className="ml-auto text-xs text-muted-foreground">
        Checked {format(new Date(health.checkedAt), 'MMM d, yyyy HH:mm:ss')}
      </span>
    </div>
  );
}

function PlatformEmailCard({ email }: { email: AdminHealth['platformEmail'] }) {
  const sendTest = useSendPlatformTestEmail();

  const onSend = async () => {
    try {
      const { sentTo } = await sendTest.mutateAsync(undefined);
      toast({ title: 'Test email accepted by Brevo', description: `Check the inbox of ${sentTo}.` });
    } catch (err: any) {
      toast({
        title: 'Test email failed',
        description: err?.response?.data?.message ?? 'The request failed.',
        variant: 'destructive',
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account email</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <p className="min-w-0 break-words text-sm text-muted-foreground">
          {email.configured
            ? `Sending through Brevo from ${email.from}.`
            : 'Not configured. Set PLATFORM_BREVO_API_KEY and PLATFORM_EMAIL_FROM, then restart the API.'}
        </p>
        <Button variant="outline" onClick={onSend} disabled={!email.configured || sendTest.isPending}>
          {sendTest.isPending ? 'Sending...' : 'Send test email'}
        </Button>
      </CardContent>
    </Card>
  );
}

function ClockCard({ clock }: { clock: AdminHealth['clock'] }) {
  const tone =
    clock.state === 'ok' ? 'text-green-600' : clock.state === 'unknown' ? 'text-muted-foreground' : clock.state === 'warn' ? 'text-amber-600' : 'text-destructive';
  const headline =
    clock.state === 'unknown'
      ? 'Unknown'
      : !clock.source
        ? 'Not synchronised'
        : `${clock.offsetMs} ms off`;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Clock</CardTitle>
        {clock.state === 'ok' ? (
          <CheckCircle2 className="h-4 w-4 text-green-600" />
        ) : clock.state === 'unknown' ? null : (
          <AlertTriangle className={cn('h-4 w-4', tone)} />
        )}
      </CardHeader>
      <CardContent>
        <div className={cn('text-2xl font-bold tabular-nums', tone)}>{headline}</div>
        <p className="text-xs text-muted-foreground">
          {clock.state === 'unknown'
            ? 'chrony is not installed here (development), or did not answer.'
            : clock.source
              ? `Synced to ${clock.source}, stratum ${clock.stratum}. CERT-In asks for NIC or NPL time.`
              : 'No time source. Check: chronyc sources'}
        </p>
      </CardContent>
    </Card>
  );
}

function QueuesCard({ health }: { health: AdminHealth }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Queues</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!health.redis.ok && (
          <p className="flex items-center gap-2 border-b px-6 pb-4 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Queues live in Redis, which is unreachable. Counts below may be missing or out of date.
          </p>
        )}
        {health.queues.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No queue counts were reported.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Queue</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Delayed</TableHead>
                <TableHead className="pr-6 text-right">Failed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.queues.map((queue) => (
                <TableRow
                  key={queue.name}
                  className={cn(queue.failed > 0 && 'bg-destructive/5 hover:bg-destructive/10')}
                >
                  <TableCell className="pl-6 font-mono text-sm">{queue.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {queue.waiting.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {queue.active.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {queue.delayed.toLocaleString()}
                  </TableCell>
                  <TableCell className="pr-6 text-right tabular-nums">
                    {queue.failed > 0 ? (
                      <Badge variant="destructive">
                        <AlertTriangle />
                        {queue.failed.toLocaleString()}
                      </Badge>
                    ) : (
                      '0'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminHealthPage() {
  const { data, isLoading, isError, error, isFetching, refetch } = useAdminHealth();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">Platform health</h1>
        <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Checked before `data`: after a failed refetch the query keeps the last
          good response, and showing it would report ok during an outage. */}
      {isError ? (
        <Card>
          <CardContent className="p-0">
            <AdminQueryError
              error={error}
              subject="platform health, so the current state is unknown"
              onRetry={() => refetch()}
            />
          </CardContent>
        </Card>
      ) : isLoading || !data ? (
        <>
          <Skeleton className="h-14" />
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
          <Skeleton className="h-64" />
        </>
      ) : (
        <>
          <StatusBanner health={data} />
          <div className="grid gap-4 md:grid-cols-2">
            <DependencyCard name="Database" dependency={data.database} />
            <DependencyCard name="Redis" dependency={data.redis} />
          </div>
          <ClockCard clock={data.clock} />
          <PlatformEmailCard email={data.platformEmail} />
          <QueuesCard health={data} />
        </>
      )}
    </div>
  );
}

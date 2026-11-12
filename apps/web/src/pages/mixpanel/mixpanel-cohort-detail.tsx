import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  useImportedCohort,
  useCohortMembers,
  useCohortPushStats,
  useSyncCohort,
  useSendPushToCohort,
  MixpanelCohort,
} from '@/hooks/use-mixpanel-cohorts';
import { toast } from '@/components/ui/use-toast';

interface PushForm {
  title: string;
  body: string;
  deepLinkUrl?: string;
  android: boolean;
  ios: boolean;
}

function StatusBadge({ status }: { status: MixpanelCohort['status'] }) {
  const variants: Record<MixpanelCohort['status'], { label: string; className: string }> = {
    synced: { label: 'Synced', className: 'bg-green-500 text-white' },
    syncing: { label: 'Syncing', className: 'bg-yellow-500 text-white' },
    error: { label: 'Error', className: 'bg-red-500 text-white' },
    pending: { label: 'Pending', className: 'bg-gray-400 text-white' },
  };
  const v = variants[status] ?? variants.pending;
  return <Badge className={v.className}>{v.label}</Badge>;
}

type ResolvedFilter = 'all' | 'resolved' | 'unresolved';

export default function MixpanelCohortDetailPage() {
  const { projectId, cohortId } = useParams<{ projectId: string; cohortId: string }>();
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [resolvedFilter, setResolvedFilter] = useState<ResolvedFilter>('all');

  const { data: cohort, isLoading: cohortLoading } = useImportedCohort(projectId, cohortId);
  const { data: pushStats } = useCohortPushStats(projectId, cohortId);
  const syncCohort = useSyncCohort(projectId!, cohortId!);
  const sendPush = useSendPushToCohort(projectId!, cohortId!);

  const resolvedParam =
    resolvedFilter === 'resolved' ? true : resolvedFilter === 'unresolved' ? false : undefined;

  const { data: membersData, isLoading: membersLoading } = useCohortMembers(
    projectId,
    cohortId,
    { page, limit: 50, resolved: resolvedParam },
  );

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PushForm>({
    defaultValues: { android: true, ios: true },
  });

  const handleSync = async () => {
    try {
      await syncCohort.mutateAsync();
      toast({ title: 'Sync started' });
    } catch {
      toast({ title: 'Error', description: 'Failed to sync cohort', variant: 'destructive' });
    }
  };

  const onSendPush = async (data: PushForm) => {
    const platforms: string[] = [];
    if (data.android) platforms.push('android');
    if (data.ios) platforms.push('ios');

    try {
      const result = await sendPush.mutateAsync({
        title: data.title,
        body: data.body,
        deepLinkUrl: data.deepLinkUrl || undefined,
        platforms: platforms.length > 0 ? platforms : undefined,
      });
      toast({
        title: 'Push campaign queued',
        description: `Sending to ${result.devicesTargeted} device(s).`,
      });
      reset();
    } catch {
      toast({ title: 'Error', description: 'Failed to send push', variant: 'destructive' });
    }
  };

  if (cohortLoading) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <Card>
          <CardContent className="p-6">
            <div className="h-40 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!cohort) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Cohort not found</h1>
        <Button variant="outline" onClick={() => navigate(`/projects/${projectId}/mixpanel/cohorts`)}>
          Back to Cohorts
        </Button>
      </div>
    );
  }

  const meta = membersData?.meta;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(`/projects/${projectId}/mixpanel/cohorts`)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{cohort.name}</h1>
            <StatusBadge status={cohort.status} />
          </div>
          {cohort.lastSyncedAt && (
            <p className="text-sm text-muted-foreground mt-1">
              Last synced: {new Date(cohort.lastSyncedAt).toLocaleString()}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={syncCohort.isPending || cohort.status === 'syncing'}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          {syncCohort.isPending ? 'Syncing...' : 'Sync'}
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-2xl font-bold">{cohort.mixpanelUserCount.toLocaleString()}</p>
            <p className="text-sm text-muted-foreground">Mixpanel Count</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-2xl font-bold">{cohort.resolvedCount.toLocaleString()}</p>
            <p className="text-sm text-muted-foreground">Resolved</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-2xl font-bold">{cohort.unresolvedCount.toLocaleString()}</p>
            <p className="text-sm text-muted-foreground">Unresolved</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-2xl font-bold">
              {pushStats ? pushStats.pushEnabled.toLocaleString() : '—'}
            </p>
            <p className="text-sm text-muted-foreground">Push Enabled</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Send Push Campaign</CardTitle>
          <CardDescription>Send a push notification to all push-enabled members.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSendPush)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  placeholder="Notification title"
                  {...register('title', { required: 'Title is required' })}
                />
                {errors.title && (
                  <p className="text-sm text-destructive">{errors.title.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Body</Label>
                <Input
                  placeholder="Notification body"
                  {...register('body', { required: 'Body is required' })}
                />
                {errors.body && (
                  <p className="text-sm text-destructive">{errors.body.message}</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Deep Link URL (optional)</Label>
              <Input placeholder="myapp://screen/path" {...register('deepLinkUrl')} />
            </div>
            <div className="space-y-2">
              <Label>Platforms</Label>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" {...register('android')} className="rounded" />
                  <span className="text-sm">Android</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" {...register('ios')} className="rounded" />
                  <span className="text-sm">iOS</span>
                </label>
              </div>
            </div>
            <Button type="submit" disabled={isSubmitting || sendPush.isPending}>
              {isSubmitting || sendPush.isPending ? 'Sending...' : 'Send Push'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Members</CardTitle>
              <CardDescription>
                {meta ? `${meta.total.toLocaleString()} total members` : 'Loading...'}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {(['all', 'resolved', 'unresolved'] as ResolvedFilter[]).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant={resolvedFilter === f ? 'default' : 'outline'}
                  onClick={() => { setResolvedFilter(f); setPage(1); }}
                  className="capitalize"
                >
                  {f}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {membersLoading ? (
            <div className="p-6">
              <div className="h-40 animate-pulse rounded bg-muted" />
            </div>
          ) : !membersData?.data || membersData.data.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">No members found.</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="py-3 px-4 text-left font-medium">Distinct ID</th>
                      <th className="py-3 px-4 text-left font-medium">Resolved</th>
                      <th className="py-3 px-4 text-left font-medium">Resolved By</th>
                      <th className="py-3 px-4 text-left font-medium">Added At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {membersData.data.map((member) => (
                      <tr key={member.id} className="border-b last:border-0">
                        <td className="py-3 px-4 font-mono text-xs">{member.mixpanelDistinctId}</td>
                        <td className="py-3 px-4">
                          <Badge variant={member.isResolved ? 'default' : 'secondary'}>
                            {member.isResolved ? 'Resolved' : 'Unresolved'}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {member.resolvedBy ?? '—'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground text-xs">
                          {new Date(member.addedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {meta && meta.totalPages > 1 && (
                <div className="flex items-center justify-between p-4 border-t">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {meta.page} of {meta.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= meta.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

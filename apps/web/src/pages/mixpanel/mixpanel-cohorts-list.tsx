import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { RefreshCw, Trash2, Eye, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  SelectRoot as Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useImportedCohorts,
  useAvailableCohorts,
  useImportCohort,
  useSyncCohort,
  useDeleteCohort,
  MixpanelCohort,
} from '@/hooks/use-mixpanel-cohorts';
import { toast } from '@/components/ui/use-toast';

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

function CohortRow({
  cohort,
  projectId,
  onView,
}: {
  cohort: MixpanelCohort;
  projectId: string;
  onView: (id: string) => void;
}) {
  const syncCohort = useSyncCohort(projectId, cohort.id);
  const deleteCohort = useDeleteCohort(projectId);

  const handleSync = async () => {
    try {
      await syncCohort.mutateAsync();
      toast({ title: 'Sync started' });
    } catch {
      toast({ title: 'Error', description: 'Failed to sync cohort', variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete cohort "${cohort.name}"?`)) return;
    try {
      await deleteCohort.mutateAsync(cohort.id);
      toast({ title: 'Cohort deleted' });
    } catch {
      toast({ title: 'Error', description: 'Failed to delete cohort', variant: 'destructive' });
    }
  };

  return (
    <tr className="border-b last:border-0">
      <td className="py-3 px-4 font-medium">{cohort.name}</td>
      <td className="py-3 px-4">
        <StatusBadge status={cohort.status} />
      </td>
      <td className="py-3 px-4 text-muted-foreground">{cohort.mixpanelUserCount.toLocaleString()}</td>
      <td className="py-3 px-4 text-muted-foreground">{cohort.resolvedCount.toLocaleString()}</td>
      <td className="py-3 px-4 text-muted-foreground">{cohort.unresolvedCount.toLocaleString()}</td>
      <td className="py-3 px-4 text-muted-foreground text-sm">
        {cohort.lastSyncedAt ? new Date(cohort.lastSyncedAt).toLocaleString() : '—'}
      </td>
      <td className="py-3 px-4">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleSync}
            disabled={syncCohort.isPending || cohort.status === 'syncing'}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => onView(cohort.id)}>
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDelete}
            disabled={deleteCohort.isPending}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

export default function MixpanelCohortsListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [selectedCohortId, setSelectedCohortId] = useState<string>('');

  const { data: importedCohorts, isLoading: importedLoading } = useImportedCohorts(projectId);
  const { data: availableCohorts, isLoading: availableLoading } = useAvailableCohorts(projectId);
  const importCohort = useImportCohort(projectId!);

  const handleImport = async () => {
    if (!selectedCohortId) return;
    try {
      await importCohort.mutateAsync({ mixpanelCohortId: parseInt(selectedCohortId, 10) });
      toast({ title: 'Cohort imported successfully' });
      setSelectedCohortId('');
    } catch {
      toast({ title: 'Error', description: 'Failed to import cohort', variant: 'destructive' });
    }
  };

  const importedIds = new Set((importedCohorts ?? []).map((c) => String(c.mixpanelCohortId)));
  const filteredAvailable = (availableCohorts ?? []).filter((c) => !importedIds.has(String(c.id)));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Mixpanel Cohorts</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/projects/${projectId}/mixpanel`)}
        >
          <Settings className="h-4 w-4 mr-2" />
          Configure
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Import Cohort</CardTitle>
          <CardDescription>Select a cohort from Mixpanel to import.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Select
              value={selectedCohortId}
              onValueChange={setSelectedCohortId}
              disabled={availableLoading}
            >
              <SelectTrigger className="w-72">
                <SelectValue placeholder={availableLoading ? 'Loading...' : 'Select a cohort'} />
              </SelectTrigger>
              <SelectContent>
                {filteredAvailable.length === 0 && (
                  <SelectItem value="__empty" disabled>
                    No new cohorts available
                  </SelectItem>
                )}
                {filteredAvailable.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name} ({c.count.toLocaleString()} users)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={handleImport}
              disabled={!selectedCohortId || importCohort.isPending}
            >
              {importCohort.isPending ? 'Importing...' : 'Import'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Imported Cohorts</CardTitle>
          <CardDescription>Cohorts synced from your Mixpanel project.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {importedLoading ? (
            <div className="p-6">
              <div className="h-40 animate-pulse rounded bg-muted" />
            </div>
          ) : !importedCohorts || importedCohorts.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              No cohorts imported yet. Use the import panel above to get started.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="py-3 px-4 text-left font-medium">Name</th>
                    <th className="py-3 px-4 text-left font-medium">Status</th>
                    <th className="py-3 px-4 text-left font-medium">Mixpanel Count</th>
                    <th className="py-3 px-4 text-left font-medium">Resolved</th>
                    <th className="py-3 px-4 text-left font-medium">Unresolved</th>
                    <th className="py-3 px-4 text-left font-medium">Last Synced</th>
                    <th className="py-3 px-4 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {importedCohorts.map((cohort) => (
                    <CohortRow
                      key={cohort.id}
                      cohort={cohort}
                      projectId={projectId!}
                      onView={(id) => navigate(`/projects/${projectId}/mixpanel/cohorts/${id}`)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

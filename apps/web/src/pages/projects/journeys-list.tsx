import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import {
  Route, Plus, Pencil, Trash2, Play, Pause, AlertTriangle, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useJourneys,
  useJourneyStats,
  useSetJourneyStatus,
  useDeleteJourney,
  type Journey,
  type JourneyStatus,
  type JourneyTrigger,
} from '@/hooks/use-journeys';
import { useSegments, type Segment } from '@/hooks/use-segments';
import { toast } from '@/components/ui/use-toast';

const statusConfig: Record<
  JourneyStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline'; className?: string }
> = {
  draft: { label: 'Draft', variant: 'secondary' },
  active: { label: 'Active', variant: 'default' },
  paused: { label: 'Paused', variant: 'outline', className: 'text-yellow-600' },
  archived: { label: 'Archived', variant: 'secondary', className: 'text-muted-foreground' },
};

const EDIT_BLOCKED = 'Pause this journey first. People are partway through its steps, so editing an active journey is not allowed.';
const DELETE_BLOCKED = 'Pause this journey first. An active journey cannot be deleted while people are moving through it.';

type StatusAction = 'activate' | 'pause';

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const message = err.response?.data?.message;
    if (typeof message === 'string') return message;
  }
  return 'Unknown error';
}

function pluralise(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function TriggerLabel({
  trigger, segments,
}: { trigger: JourneyTrigger; segments: Segment[] | undefined }) {
  if (trigger.type === 'event') {
    return <>When someone does <span className="font-medium text-foreground">{trigger.eventName}</span></>;
  }
  const segment = segments?.find((s) => s.id === trigger.segmentId);
  // Segments load separately and can be deleted out from under a journey, so
  // "not found" is only a definite answer once the list has arrived.
  if (!segments) return <>When someone enters a segment</>;
  if (!segment) {
    return (
      <>
        When someone enters{' '}
        <span className="text-destructive" title="This segment may have been deleted">
          a segment that no longer exists
        </span>
      </>
    );
  }
  return <>When someone enters <span className="font-medium text-foreground">{segment.name}</span></>;
}

function JourneyCounts({ projectId, journeyId }: { projectId: string; journeyId: string }) {
  const { data: stats, isLoading, isError } = useJourneyStats(projectId, journeyId);

  if (isLoading) return <div className="h-8 w-24 animate-pulse rounded bg-muted" />;
  if (isError || !stats) return <span className="text-sm text-muted-foreground">—</span>;

  return (
    <div>
      <p className="text-sm font-medium">{stats.active} inside</p>
      <p className="text-xs text-muted-foreground">
        {stats.completed} completed · {stats.exited} exited
        {stats.failed > 0 && <span className="text-destructive"> · {stats.failed} failed</span>}
      </p>
    </div>
  );
}

export default function JourneysListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: journeys, isLoading, isError } = useJourneys(projectId);
  const { data: segments } = useSegments(projectId);
  const setStatus = useSetJourneyStatus(projectId!);
  const deleteJourney = useDeleteJourney(projectId!);

  const [pending, setPending] = useState<{ journey: Journey; action: StatusAction } | null>(null);
  const [deleting, setDeleting] = useState<Journey | null>(null);

  const confirmStatusChange = () => {
    if (!pending) return;
    const { journey, action } = pending;
    setStatus.mutate(
      { id: journey.id, status: action === 'activate' ? 'active' : 'paused' },
      {
        onSuccess: () => {
          toast({ title: action === 'activate' ? 'Journey activated' : 'Journey paused' });
          setPending(null);
        },
        onError: (err) => {
          toast({
            title: action === 'activate' ? 'Could not activate journey' : 'Could not pause journey',
            description: errorMessage(err),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const confirmDelete = () => {
    if (!deleting) return;
    deleteJourney.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: 'Journey deleted' });
        setDeleting(null);
      },
      onError: (err) => {
        toast({
          title: 'Could not delete journey',
          description: errorMessage(err),
          variant: 'destructive',
        });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">Journeys</h1>
          <p className="text-muted-foreground mt-1">
            Multi-step campaigns that move people through waits, messages and branches over time.
          </p>
        </div>
        <Button asChild>
          <Link to={`/projects/${projectId}/journeys/new`}>
            <Plus className="mr-2 h-4 w-4" /> New journey
          </Link>
        </Button>
      </div>

      {isError && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-2 pt-6 text-sm">
            <XCircle className="h-4 w-4 text-destructive" />
            Could not load journeys. Try refreshing the page.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Journeys</CardTitle>
          <CardDescription>
            Only active journeys enrol new people. Counts update every 30 seconds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : !journeys || journeys.length === 0 ? (
            !isError && (
              <div className="py-12 text-center">
                <Route className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">No journeys yet</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  A journey starts when someone does something or joins a segment, then
                  runs them through steps over hours or days — wait, send a push, branch
                  on segment membership, exit.
                </p>
                <Button asChild variant="outline" className="mt-4">
                  <Link to={`/projects/${projectId}/journeys/new`}>
                    <Plus className="mr-2 h-4 w-4" /> Create your first journey
                  </Link>
                </Button>
              </div>
            )
          ) : (
            <TooltipProvider>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Steps</TableHead>
                    <TableHead>People</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {journeys.map((journey) => {
                    const config = statusConfig[journey.status];
                    const isActive = journey.status === 'active';
                    return (
                      <TableRow key={journey.id}>
                        <TableCell>
                          <Link
                            to={`/projects/${projectId}/journeys/${journey.id}`}
                            className="text-sm font-medium hover:underline"
                          >
                            {journey.name}
                          </Link>
                          {journey.description && (
                            <p className="max-w-xs truncate text-xs text-muted-foreground">
                              {journey.description}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={config.variant} className={config.className}>
                            {config.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          <TriggerLabel trigger={journey.trigger} segments={segments} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {pluralise(journey.steps.length, 'step')}
                        </TableCell>
                        <TableCell>
                          <JourneyCounts projectId={projectId!} journeyId={journey.id} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {isActive ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPending({ journey, action: 'pause' })}
                              >
                                <Pause className="mr-1 h-4 w-4" /> Pause
                              </Button>
                            ) : journey.status !== 'archived' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPending({ journey, action: 'activate' })}
                              >
                                <Play className="mr-1 h-4 w-4" />
                                {journey.status === 'paused' ? 'Resume' : 'Activate'}
                              </Button>
                            ) : null}

                            {isActive ? (
                              <BlockedButton reason={EDIT_BLOCKED}>
                                <Pencil className="mr-1 h-4 w-4" /> Edit
                              </BlockedButton>
                            ) : (
                              <Button asChild variant="outline" size="sm">
                                <Link to={`/projects/${projectId}/journeys/${journey.id}`}>
                                  <Pencil className="mr-1 h-4 w-4" /> Edit
                                </Link>
                              </Button>
                            )}

                            {isActive ? (
                              <BlockedButton reason={DELETE_BLOCKED} destructive>
                                <Trash2 className="mr-1 h-4 w-4" /> Delete
                              </BlockedButton>
                            ) : (
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => setDeleting(journey)}
                              >
                                <Trash2 className="mr-1 h-4 w-4" /> Delete
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TooltipProvider>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          {pending && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {pending.action === 'activate'
                    ? `Activate "${pending.journey.name}"?`
                    : `Pause "${pending.journey.name}"?`}
                </DialogTitle>
                <DialogDescription>
                  {/* Three messages, not two, because resuming is not
                     activating. A first activation only reaches forward;
                     resuming keeps the watermark where the pause left it, so
                     it picks up the backlog that built while it was off — and
                     someone reaching for Pause to stop a mistake needs to hear
                     that runs already in flight will still finish. */}
                  {pending.action !== 'activate'
                    ? 'No new people will be enrolled. People already inside will keep going and finish their remaining steps, including any messages still to be sent.'
                    : pending.journey.status === 'paused'
                      ? 'This journey will start sending real messages again. Enrolment picks up where it paused, so anyone who matched the trigger while it was paused will be enrolled now.'
                      : 'This journey will start sending real messages to real people. Enrolment begins from this moment and does not reach back over people who matched the trigger earlier.'}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setPending(null)}
                  disabled={setStatus.isPending}
                >
                  Cancel
                </Button>
                <Button onClick={confirmStatusChange} disabled={setStatus.isPending}>
                  {setStatus.isPending
                    ? 'Working…'
                    : pending.action === 'activate'
                      ? 'Activate journey'
                      : 'Pause journey'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          {deleting && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  Delete "{deleting.name}"?
                </DialogTitle>
                <DialogDescription>This cannot be undone.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDeleting(null)}
                  disabled={deleteJourney.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={confirmDelete}
                  disabled={deleteJourney.isPending}
                >
                  {deleteJourney.isPending ? 'Deleting…' : 'Delete journey'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A button that is refused by the API in this state. Disabled buttons swallow
 * pointer events, so the tooltip hangs off a wrapping span to stay hoverable
 * and focusable.
 */
function BlockedButton({
  reason, destructive, children,
}: { reason: string; destructive?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={reason}>
          <Button
            variant={destructive ? 'destructive' : 'outline'}
            size="sm"
            disabled
            className="pointer-events-none"
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}

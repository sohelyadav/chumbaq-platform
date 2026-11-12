import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import {
  Users2, Plus, Pencil, Trash2, AlertTriangle, Zap, Clock,
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
  useSegments, useDeleteSegment, type Segment, type SegmentStatus,
} from '@/hooks/use-segments';
import { toast } from '@/components/ui/use-toast';

const statusConfig: Record<
  SegmentStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline'; className?: string }
> = {
  draft: { label: 'Draft', variant: 'secondary' },
  active: { label: 'Active', variant: 'default' },
  error: { label: 'Error', variant: 'outline', className: 'text-destructive' },
};

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const message = err.response?.data?.message;
    if (typeof message === 'string') return message;
  }
  return 'Unknown error';
}

/** Summarises a definition in one line, without pretending to be the editor. */
function ruleSummary(segment: Segment): string {
  const definition = segment.definition;
  if (!definition) return '—';
  if (definition.type !== 'group') return '1 rule';

  let events = 0;
  let attributes = 0;
  const walk = (node: typeof definition): void => {
    if (node.type === 'group') {
      node.children.forEach((child) => walk(child as typeof definition));
      return;
    }
    if (node.type === 'behaviour') events += 1;
    else attributes += 1;
  };
  walk(definition);

  const parts: string[] = [];
  if (events > 0) parts.push(`${events} event${events === 1 ? '' : 's'}`);
  if (attributes > 0) parts.push(`${attributes} profile${attributes === 1 ? '' : 's'}`);
  const joiner = definition.operator === 'and' ? 'all' : 'any';
  return parts.length > 0 ? `${parts.join(' + ')} · ${joiner}` : 'empty';
}

function MemberCount({ segment }: { segment: Segment }) {
  if (segment.evaluationMode === 'live') {
    // A live segment holds no stored count — reporting the last materialised
    // figure, or a zero, would both be inventions.
    return (
      <span className="text-muted-foreground" title="Counted on demand">
        counted live
      </span>
    );
  }
  if (segment.lastMemberCount === null) {
    return <span className="text-muted-foreground">not yet refreshed</span>;
  }
  return (
    <span className="font-medium tabular-nums">
      {segment.lastMemberCount.toLocaleString()}
    </span>
  );
}

export default function SegmentsListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: segments, isLoading } = useSegments(projectId);
  const deleteSegment = useDeleteSegment(projectId!);
  const [pendingDelete, setPendingDelete] = useState<Segment | null>(null);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteSegment.mutateAsync(pendingDelete.id);
      toast({ title: 'Audience deleted', description: pendingDelete.name });
      setPendingDelete(null);
    } catch (err) {
      toast({
        title: 'Could not delete',
        description: errorMessage(err),
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Audiences</h1>
          <p className="text-muted-foreground mt-1">
            Saved groups of people, built from what they have done and who they
            are. Target a campaign, a message or a journey with one.
          </p>
        </div>
        <Button asChild>
          <Link to={`/projects/${projectId}/segments/new`}>
            <Plus className="mr-2 h-4 w-4" /> New audience
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users2 className="h-5 w-5" /> All audiences
          </CardTitle>
          <CardDescription>
            {segments ? `${segments.length} defined` : 'Loading…'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !segments || segments.length === 0 ? (
            <div className="py-12 text-center">
              <Users2 className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-4 font-medium">No audiences yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                An audience answers &ldquo;who should get this?&rdquo; once, and
                every campaign after it can reuse the answer. Start with
                something like &ldquo;bought in the last 30 days&rdquo;.
              </p>
              <Button asChild className="mt-4">
                <Link to={`/projects/${projectId}/segments/new`}>
                  <Plus className="mr-2 h-4 w-4" /> Create one
                </Link>
              </Button>
            </div>
          ) : (
            <TooltipProvider>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Rules</TableHead>
                    <TableHead>Evaluation</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[100px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {segments.map((segment) => {
                    const status = statusConfig[segment.status];
                    return (
                      <TableRow key={segment.id}>
                        <TableCell>
                          <Link
                            to={`/projects/${projectId}/segments/${segment.id}`}
                            className="font-medium hover:underline"
                          >
                            {segment.name}
                          </Link>
                          {segment.description && (
                            <p className="text-xs text-muted-foreground">
                              {segment.description}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {ruleSummary(segment)}
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5 text-sm">
                            {segment.evaluationMode === 'live' ? (
                              <>
                                <Zap className="h-3.5 w-3.5 text-muted-foreground" /> Live
                              </>
                            ) : (
                              <>
                                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                Every {segment.refreshIntervalMinutes}m
                              </>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm">
                          <MemberCount segment={segment} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge variant={status.variant} className={status.className}>
                              {status.label}
                            </Badge>
                            {segment.errorMessage && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  {segment.errorMessage}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" asChild>
                              <Link to={`/projects/${projectId}/segments/${segment.id}`}>
                                <Pencil className="h-4 w-4" />
                              </Link>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setPendingDelete(segment)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
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

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{pendingDelete?.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              Anything still targeting this audience — a campaign, an in-app
              message, a journey trigger or a journey branch — will stop
              resolving once it is gone. Check those first; this cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteSegment.isPending}
            >
              Delete audience
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

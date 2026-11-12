import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { ChevronDown, ChevronRight, Download, History } from 'lucide-react';
import type { ProjectActivityEntry } from '@chumbaq/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectContent, SelectItem, SelectRoot as Select, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCurrentProject } from '@/contexts/project-context';
import { serverMessage } from '@/hooks/use-project-members';
import { downloadActivityCsv, useProjectActivity } from '@/hooks/use-project-activity';
import { activitySentence, kindOptions, readActivityFilters, type ActivityFilters } from '@/lib/activity-sentence';
import { can } from '@/lib/project-role';

const EMPTY_STATE =
  'Nothing here yet. Changes to the team, keys, channels and privacy, and every campaign sent, are recorded here and kept for at least 180 days.';

/** Radix Select has no empty value, so "no filter" is this. */
const ANY = 'any';

/** The person part of an actor label: "Priya" from "Priya (priya@acme.com)". */
function whoOf(entry: ProjectActivityEntry): { name: string; sub: string | null } {
  if (entry.actorKind === 'staff') return { name: 'Chumbaq support', sub: null };
  const match = /^(.*) \(([^()]+)\)$/.exec(entry.actorLabel);
  if (match && entry.actorKind === 'user') return { name: match[1], sub: match[2] };
  return { name: entry.actorLabel, sub: null };
}

function detailValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(detailValue).join(', ');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${detailValue(v)}`)
      .join(', ');
  }
  return String(value);
}

function EntryDetails({ entry }: { entry: ProjectActivityEntry }) {
  const rows: [string, string][] = [['Time (UTC)', entry.occurredAt]];
  if (entry.targetType) rows.push(['Target', [entry.targetType, entry.targetLabel].filter(Boolean).join(': ')]);
  if (entry.targetId) rows.push(['Target id', entry.targetId]);
  for (const [key, value] of Object.entries(entry.details ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    rows.push([key, detailValue(value)]);
  }
  if (entry.userAgent) rows.push(['Browser', entry.userAgent]);
  rows.push(['Action', entry.action]);
  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="font-mono break-all">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Who did what in the project, when and from where (`activity.view`: owners and admins).
 * Filters live in the URL, so a filtered view can be linked to (the Members page links
 * to `?group=team`). Privacy entries and the Privacy filter are for owners only; the
 * server leaves them out for everyone else as well.
 */
export default function ProjectActivityPage() {
  const { projectId, project } = useCurrentProject();
  const mayView = can(project, 'activity.view');
  const mayPrivacy = can(project, 'privacy');
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readActivityFilters(searchParams, mayPrivacy), [searchParams, mayPrivacy]);
  const rangeBackwards = !!filters.from && !!filters.to && filters.from > filters.to;

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useProjectActivity(
    projectId,
    filters,
    mayView && !rangeBackwards,
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const entries = data?.pages.flatMap((page) => page.entries) ?? [];
  const actors = data?.pages[0]?.actors ?? [];
  const filtered = Object.keys(filters).length > 0;

  const setFilter = (key: 'person' | 'group' | 'from' | 'to', value: string | undefined) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
    setDownloadError(null);
  };

  const handleDownload = async (current: ActivityFilters) => {
    setDownloading(true);
    setDownloadError(null);
    const refusal = await downloadActivityCsv(projectId, current);
    setDownloading(false);
    setDownloadError(refusal);
  };

  if (!mayView) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Activity</h1>
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Only owners and admins can see the activity log.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Activity</h1>
          <p className="text-muted-foreground mt-1">Who changed what in this project, when, and from where.</p>
        </div>
        <Button variant="outline" disabled={downloading || rangeBackwards} onClick={() => void handleDownload(filters)}>
          <Download className="mr-2 h-4 w-4" />
          {downloading ? 'Preparing…' : 'Download CSV'}
        </Button>
      </div>

      {downloadError && (
        <p role="alert" className="text-sm text-destructive">
          {downloadError}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Activity log
          </CardTitle>
          <CardDescription>Newest first. Dates in the filters are UTC days.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="activity-person">Person</Label>
              <Select value={filters.actor ?? ANY} onValueChange={(v) => setFilter('person', v === ANY ? undefined : v)}>
                <SelectTrigger id="activity-person" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Everyone</SelectItem>
                  {actors.map((actor) => (
                    <SelectItem key={actor.userId} value={actor.userId}>
                      {actor.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="activity-kind">Kind</Label>
              <Select value={filters.group ?? ANY} onValueChange={(v) => setFilter('group', v === ANY ? undefined : v)}>
                <SelectTrigger id="activity-kind" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All kinds</SelectItem>
                  {kindOptions(mayPrivacy).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="activity-from">From</Label>
              <Input
                id="activity-from"
                type="date"
                className="w-40"
                value={filters.from ?? ''}
                onChange={(e) => setFilter('from', e.target.value || undefined)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="activity-to">To</Label>
              <Input
                id="activity-to"
                type="date"
                className="w-40"
                value={filters.to ?? ''}
                onChange={(e) => setFilter('to', e.target.value || undefined)}
              />
            </div>
            {filtered && (
              <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
                Clear filters
              </Button>
            )}
          </div>

          {rangeBackwards ? (
            <p className="text-sm text-destructive">The start date is after the end date.</p>
          ) : error ? (
            <p className="text-sm text-destructive">{serverMessage(error) ?? 'The activity log did not load. Try again.'}</p>
          ) : isLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {filtered ? 'No activity matches these filters.' : EMPTY_STATE}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="w-44">When</TableHead>
                    <TableHead className="w-56">Who</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead className="w-40">Where</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const open = expanded === entry.id;
                    const who = whoOf(entry);
                    const when = new Date(entry.occurredAt);
                    return (
                      <Fragment key={entry.id}>
                        <TableRow
                          className="cursor-pointer"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : entry.id)}
                        >
                          <TableCell className="text-muted-foreground">
                            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </TableCell>
                          <TableCell className="text-sm whitespace-nowrap">
                            <time dateTime={entry.occurredAt} title={`${entry.occurredAt.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`}>
                              {format(when, 'MMM d, yyyy HH:mm')}
                            </time>
                          </TableCell>
                          <TableCell>
                            <p className="font-medium text-sm">{who.name}</p>
                            {who.sub && <p className="text-xs text-muted-foreground">{who.sub}</p>}
                          </TableCell>
                          {/* The Who column has the email, so the sentence names them as the spec does: "Priya sent ...". */}
                          <TableCell className="text-sm whitespace-normal">
                            {activitySentence({ ...entry, actorLabel: who.name })}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {entry.ipAddress || entry.country ? (
                              <>
                                <p className="font-mono">{entry.ipAddress ?? ''}</p>
                                {entry.country && <p>{entry.country}</p>}
                              </>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell />
                            <TableCell colSpan={4} className="whitespace-normal">
                              <EntryDetails entry={entry} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
              {hasNextPage && (
                <div className="flex justify-center">
                  <Button variant="outline" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                    {isFetchingNextPage ? 'Loading…' : 'Load more'}
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

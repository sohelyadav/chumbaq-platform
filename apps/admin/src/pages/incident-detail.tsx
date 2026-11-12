import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Copy, Mail } from 'lucide-react';
import { CERT_IN_ANNEXURE_I, type IncidentDetail, type IncidentReportMethod } from '@chumbaq/shared';
import { AdminQueryError } from '@/components/admin-query-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { adminErrorMessage } from '@/hooks/use-admin-tenants';
import {
  useAddIncidentNote,
  useCloseIncident,
  useIncident,
  useReportDraft,
  useReportIncident,
} from '@/hooks/use-incidents';
import { copyText } from '@/lib/clipboard';
import { deadlineOf, formatIstAndUtc, fromLocalInputValue, remaining, toLocalInputValue } from '@/lib/incident-time';
import { cn } from '@/lib/utils';

const label = (id: string) => CERT_IN_ANNEXURE_I.find((t) => t.id === id)?.label ?? id;

async function copy(text: string) {
  const ok = await copyText(text);
  toast(ok ? { title: 'Copied' } : { title: 'Could not copy; select it and copy by hand', variant: 'destructive' });
}

const fail = (title: string) => (error: unknown) =>
  toast({ title, description: adminErrorMessage(error, 'The request failed.'), variant: 'destructive' });

function DeadlineBanner({ incident }: { incident: IncidentDetail }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (incident.status !== 'open') {
    return (
      <div role="status" className="rounded-lg border p-4 text-sm">
        {incident.status === 'reported'
          ? `Reported to CERT-In ${formatIstAndUtc(incident.reportedAt!)} by ${incident.reportMethod}${
              incident.certinReference ? `, reference ${incident.certinReference}` : ''
            }.`
          : `Closed ${formatIstAndUtc(incident.closedAt!)}${incident.reportedAt ? ' after reporting' : ' without reporting'}.`}
      </div>
    );
  }
  const left = remaining(deadlineOf(incident.noticedAt), now);
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-4',
        left.overdue ? 'border-destructive/30 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5',
      )}
    >
      <AlertTriangle className={cn('h-5 w-5', left.overdue ? 'text-destructive' : 'text-amber-600')} />
      <span className="font-medium tabular-nums">{left.text}</span>
      <span className="text-sm text-muted-foreground">to report to CERT-In, by {formatIstAndUtc(incident.deadline)}</span>
    </div>
  );
}

function DraftCard({ incident }: { incident: IncidentDetail }) {
  const [open, setOpen] = useState(false);
  const draft = useReportDraft(incident.id, open);
  const mailto = draft.data
    ? `mailto:incident@cert-in.org.in?subject=${encodeURIComponent(draft.data.subject)}&body=${encodeURIComponent(draft.data.body)}`
    : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Report to CERT-In</CardTitle>
        <CardDescription>
          Email incident@cert-in.org.in, or phone 1800-11-4949 (fax 1800-11-6969). Send what is known now; fill the parts
          marked [to fill] or say they will follow. Attach the log bundle, or say it will follow. Nothing is sent from here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!open ? (
          <Button variant="outline" onClick={() => setOpen(true)}>
            Draft the report
          </Button>
        ) : draft.isError ? (
          <AdminQueryError error={draft.error} subject="the report draft" onRetry={() => draft.refetch()} />
        ) : !draft.data ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            <Input readOnly value={draft.data.subject} aria-label="Subject" />
            <Textarea readOnly rows={18} value={draft.data.body} aria-label="Report" className="font-mono text-xs" />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => copy(`${draft.data!.subject}\n\n${draft.data!.body}`)}>
                <Copy className="mr-1 h-4 w-4" /> Copy
              </Button>
              <Button asChild variant="outline">
                <a href={mailto}>
                  <Mail className="mr-1 h-4 w-4" /> Open in email
                </a>
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MarkReportedCard({ incident }: { incident: IncidentDetail }) {
  const report = useReportIncident(incident.id);
  const [method, setMethod] = useState<IncidentReportMethod>('email');
  const [reportedAt, setReportedAt] = useState(() => toLocalInputValue(new Date()));
  const [reference, setReference] = useState('');
  if (incident.status !== 'open') return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mark reported</CardTitle>
        <CardDescription>Once CERT-In has it. This stops the reminders.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 md:grid-cols-[auto_1fr_1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            report.mutate(
              { method, reportedAt: fromLocalInputValue(reportedAt) ?? undefined, certinReference: reference.trim() || undefined },
              { onError: fail('Could not mark it reported') },
            );
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="method">How</Label>
            <select
              id="method"
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
              value={method}
              onChange={(e) => setMethod(e.target.value as IncidentReportMethod)}
            >
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="fax">Fax</option>
              <option value="portal">Portal</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="reported-at">When (your time)</Label>
            <Input id="reported-at" type="datetime-local" value={reportedAt} onChange={(e) => setReportedAt(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="reference">CERT-In reference, if given</Label>
            <Input id="reference" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <Button type="submit" disabled={report.isPending}>
            {report.isPending ? 'Saving...' : 'Mark reported'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function NotesCard({ incident }: { incident: IncidentDetail }) {
  const add = useAddIncidentNote(incident.id);
  const close = useCloseIncident(incident.id);
  const [note, setNote] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes</CardTitle>
        <CardDescription>
          New findings, updates sent to CERT-In, customers told. Notes cannot be edited or deleted; correct with a new one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {incident.notes.length > 0 && (
          <ol className="space-y-3">
            {incident.notes.map((n) => (
              <li key={n.id} className="rounded-md border p-3 text-sm">
                <div className="text-xs text-muted-foreground">{formatIstAndUtc(n.createdAt)}</div>
                <p className="whitespace-pre-wrap">{n.note}</p>
              </li>
            ))}
          </ol>
        )}
        {incident.status !== 'closed' && (
          <div className="space-y-2">
            <Textarea rows={3} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} aria-label="New note" />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!note.trim() || add.isPending}
                onClick={() => add.mutate(note.trim(), { onSuccess: () => setNote(''), onError: fail('Could not add the note') })}
              >
                Add note
              </Button>
              <Button
                variant="outline"
                disabled={!note.trim() || close.isPending}
                onClick={() => close.mutate(note.trim(), { onSuccess: () => setNote(''), onError: fail('Could not close it') })}
              >
                Close with this note
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function IncidentDetailPage() {
  const { incidentId } = useParams();
  const { data: incident, isLoading, isError, error, refetch } = useIncident(incidentId);

  return (
    <div className="space-y-6">
      <Link to="/incidents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Incidents
      </Link>
      {isError ? (
        <AdminQueryError error={error} subject="this incident" onRetry={() => refetch()} />
      ) : isLoading || !incident ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div>
            <h1 className="text-3xl font-bold">{incident.title}</h1>
            <p className="text-sm text-muted-foreground">Noticed {formatIstAndUtc(incident.noticedAt)}</p>
          </div>
          <DeadlineBanner incident={incident} />
          {incident.reminderEmailFailed && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              Reminder emails could not be sent to every staff member. Do not rely on them; watch the deadline here.
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle>What was recorded</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                {incident.types.map((t) => (
                  <Badge key={t} variant="outline" className="h-auto whitespace-normal text-left">
                    ({t}) {label(t)}
                  </Badge>
                ))}
              </div>
              {incident.howNoticed && <p><span className="font-medium">How noticed:</span> {incident.howNoticed}</p>}
              {incident.summary && <p className="whitespace-pre-wrap">{incident.summary}</p>}
              {incident.systems && <p><span className="font-medium">Systems:</span> {incident.systems}</p>}
              <p><span className="font-medium">Customer accounts affected:</span> {incident.tenantIds.length}</p>
            </CardContent>
          </Card>
          <DraftCard incident={incident} />
          <MarkReportedCard incident={incident} />
          <Card>
            <CardHeader>
              <CardTitle>Log bundle</CardTitle>
              <CardDescription>
                On the server, as root: gathers every log from 24 hours before this was noticed until now into one archive
                readable only by root, with a checksum list. Widen --from or --to if needed.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 text-xs">{incident.logCommand}</code>
              <Button size="sm" variant="outline" onClick={() => copy(incident.logCommand)}>
                <Copy className="mr-1 h-3 w-3" /> Copy
              </Button>
            </CardContent>
          </Card>
          <NotesCard incident={incident} />
        </>
      )}
    </div>
  );
}

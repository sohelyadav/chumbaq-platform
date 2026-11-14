import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { ChevronDown, Download } from 'lucide-react';
import type { AdminAuditAction, AdminAuditLog } from '@chumbaq/shared';
import { AdminQueryError } from '@/components/admin-query-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import { useAdminAuditLogs, useExportAdminAuditLogs } from '@/hooks/use-admin-insights';
import {
  EMPTY_FILTER_FORM,
  filterFormError,
  hasFilters,
  readFilterForm,
  toApiFilters,
  writeFilterForm,
  type AuditFilterForm,
} from '@/lib/admin-audit-filters';

const LIMIT = 20;
/** The API's AUDIT_EXPORT_ROW_CAP, stated before the click; the response confirms it. */
const EXPORT_ROW_CAP = 10_000;

const ACTION_LABELS: Record<AdminAuditAction, string> = {
  'tripwire.created': 'Trap made',
  'tripwire.revoked': 'Trap switched off',
  'incident.recorded': 'Incident recorded',
  'incident.reported': 'Incident marked reported to CERT-In',
  'incident.note_added': 'Incident note added',
  'incident.closed': 'Incident closed',
  'security_contact.updated': 'Security contact changed',
  'tenant.suspended': 'Tenant suspended',
  'tenant.reactivated': 'Tenant reactivated',
  'tenant.impersonated': 'Tenant impersonated',
  'tenant.viewed': 'Tenant viewed by staff',
  'super_admin.granted': 'Super admin granted',
  'super_admin.revoked': 'Super admin revoked',
  'super_admin.passkeys_reset': 'Passkeys reset by CLI',
  'account.factors_reset': 'Second factors reset',
  'audit_log.exported': 'Audit log exported',
  'tenants.exported': 'Tenants list exported',
  'account.factors_reset_requested': 'Second factor reset requested',
  'account.factors_reset_cancelled': 'Second factor reset cancelled',
  'account.password_reset_refused': 'Password reset refused after factor reset',
  'account.password_reset_link_issued': 'Password reset link issued by CLI',
  'account.password_reset_link_cancelled': 'Password reset link cancelled',
  'account.password_reset_link_void_failed': 'Sign-in could not cancel a password reset link',
  'account.project_limit_changed': 'Project limit changed',
  'account.seat_limit_changed': 'Seat limit changed',
  'staff.signed_in': 'Signed in',
  'staff.sign_in_failed': 'Failed sign-in',
  'staff.signed_out': 'Signed out',
  'staff.session_revoked': 'Session ended',
  'staff.enrolment_started': 'Started sign-in setup',
  'staff.enrolment_allowed': 'Enrolment code issued',
  'staff.factor_added': 'Added a sign-in method',
  'staff.factor_removed': 'Removed a sign-in method',
  'tenant.impersonation_exchanged': 'View-as opened',
  'tenant.impersonation_refused': 'View-as link refused',
};

const ACTIONS = Object.keys(ACTION_LABELS) as AdminAuditAction[];

function actorLabel(log: AdminAuditLog): string {
  return !log.actorEmail || log.actorEmail === 'cli' ? 'CLI' : log.actorEmail;
}

function actionsSummary(actions: AdminAuditAction[]): string {
  if (actions.length === 0) return 'All actions';
  if (actions.length === 1) return ACTION_LABELS[actions[0]];
  return `${actions.length} actions`;
}

function AuditTarget({ log }: { log: AdminAuditLog }) {
  const label = log.targetLabel ?? log.targetId;
  if (!label) return <span className="text-muted-foreground">-</span>;
  if (log.targetType === 'tenant' && log.targetId) {
    return (
      <Link to={`/tenants/${log.targetId}`} className="text-primary hover:underline">
        {label}
      </Link>
    );
  }
  return <>{label}</>;
}

export default function AdminAuditLogPage() {
  // The applied filters live in the URL, so a filtered view can be linked to,
  // as the tenant page does for its full history.
  const [searchParams, setSearchParams] = useSearchParams();
  const applied = useMemo(() => readFilterForm(searchParams, ACTIONS), [searchParams]);
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const [draft, setDraft] = useState<AuditFilterForm>(applied);
  // A link or Back changes the URL under the form, which then shows what is applied.
  useEffect(() => setDraft(applied), [applied]);
  const draftError = filterFormError(draft);
  const appliedError = filterFormError(applied);
  const apiFilters = appliedError ? {} : toApiFilters(applied);

  const { data, isLoading, isError, error, isPlaceholderData, refetch } = useAdminAuditLogs({
    page,
    limit: LIMIT,
    ...apiFilters,
  });
  const exportLogs = useExportAdminAuditLogs();

  const totalPages = data?.meta.totalPages ?? 0;
  const filtered = hasFilters(applied);

  const apply = (form: AuditFilterForm, nextPage = 1) => {
    const params = writeFilterForm(form);
    if (nextPage > 1) params.page = String(nextPage);
    setSearchParams(params);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!draftError) apply(draft);
  };

  const clear = () => {
    setDraft(EMPTY_FILTER_FORM);
    apply(EMPTY_FILTER_FORM);
  };

  const toggleAction = (action: AdminAuditAction, on: boolean) =>
    setDraft((current) => ({
      ...current,
      actions: on
        ? ACTIONS.filter((value) => value === action || current.actions.includes(value))
        : current.actions.filter((value) => value !== action),
    }));

  const onExport = () => {
    exportLogs.mutate(apiFilters, {
      onSuccess: (result) => {
        toast({
          title: result.truncated
            ? `Exported the newest ${result.rowCount.toLocaleString()} rows`
            : `Exported ${result.rowCount.toLocaleString()} rows`,
          description: result.truncated
            ? `More entries match than one export holds (${result.rowCap.toLocaleString()}). Narrow the dates to export the rest.`
            : undefined,
        });
      },
      onError: () => {
        toast({ title: 'Could not export the audit log', variant: 'destructive' });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-3xl font-bold">Audit log</h1>
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="outline"
            onClick={onExport}
            disabled={exportLogs.isPending || Boolean(appliedError)}
          >
            <Download className="mr-2 h-4 w-4" />
            {exportLogs.isPending ? 'Exporting...' : 'Export CSV'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Applied filters, newest first, up to {EXPORT_ROW_CAP.toLocaleString()} rows. Each
            export is recorded here.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Action</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between font-normal"
                    aria-label="Filter by action"
                  >
                    <span className="truncate">{actionsSummary(draft.actions)}</span>
                    <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  {ACTIONS.map((value) => (
                    <DropdownMenuCheckboxItem
                      key={value}
                      checked={draft.actions.includes(value)}
                      onCheckedChange={(on) => toggleAction(value, on === true)}
                      // Stays open, so several can be picked in one go.
                      onSelect={(event) => event.preventDefault()}
                    >
                      {ACTION_LABELS[value]}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="audit-actor">Actor email</Label>
              <Input
                id="audit-actor"
                type="text"
                inputMode="email"
                placeholder="ops@chumbaq.com, or cli"
                value={draft.actorEmail}
                maxLength={255}
                onChange={(event) => setDraft({ ...draft, actorEmail: event.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="audit-target">Tenant ID</Label>
              <Input
                id="audit-target"
                placeholder="From the tenant page address"
                value={draft.targetId}
                onChange={(event) => setDraft({ ...draft, targetId: event.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="audit-from">From</Label>
              <Input
                id="audit-from"
                type="date"
                value={draft.fromDate}
                onChange={(event) => setDraft({ ...draft, fromDate: event.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="audit-to">To (inclusive)</Label>
              <Input
                id="audit-to"
                type="date"
                value={draft.toDate}
                onChange={(event) => setDraft({ ...draft, toDate: event.target.value })}
              />
            </div>

            <div className="flex items-end gap-2">
              <Button type="submit" disabled={Boolean(draftError)}>
                Apply filters
              </Button>
              <Button type="button" variant="ghost" onClick={clear} disabled={!filtered && !hasFilters(draft)}>
                Clear
              </Button>
            </div>

            {draftError && (
              <p className="text-sm text-destructive sm:col-span-2 lg:col-span-3" role="alert">
                {draftError}
              </p>
            )}
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            Dates are in your timezone. A staff member's views of one tenant are recorded at most
            once every 10 minutes.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {appliedError ? (
            <div className="p-8 text-center text-destructive">{appliedError}</div>
          ) : isError ? (
            <AdminQueryError error={error} subject="the audit log" onRetry={() => refetch()} />
          ) : isLoading ? (
            <div className="space-y-3 p-4">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : !data || data.data.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {filtered ? 'No audit entries match these filters.' : 'No audit entries yet.'}
            </div>
          ) : (
            <>
              <Table className={isPlaceholderData ? 'opacity-60' : undefined}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>IP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="align-top text-sm text-muted-foreground">
                        {format(new Date(log.createdAt), 'MMM d, yyyy HH:mm')}
                      </TableCell>
                      <TableCell className="max-w-56 truncate align-top" title={actorLabel(log)}>
                        {actorLabel(log)}
                      </TableCell>
                      <TableCell className="align-top">
                        {ACTION_LABELS[log.action] ?? log.action}
                      </TableCell>
                      <TableCell
                        className="max-w-56 truncate align-top"
                        title={log.targetLabel ?? log.targetId ?? undefined}
                      >
                        <AuditTarget log={log} />
                      </TableCell>
                      {/* A reason is up to 500 characters and may hold one
                          unbroken string, so it wraps rather than widening the table. */}
                      <TableCell className="min-w-64 max-w-md whitespace-pre-wrap align-top text-sm [overflow-wrap:anywhere]">
                        {log.reason ?? <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs text-muted-foreground">
                        {log.ipAddress ?? '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t p-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {(data.meta.page - 1) * data.meta.limit + 1}-
                    {Math.min(data.meta.page * data.meta.limit, data.meta.total)} of{' '}
                    {data.meta.total.toLocaleString()}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => apply(applied, page - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages || isPlaceholderData}
                      onClick={() => apply(applied, page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

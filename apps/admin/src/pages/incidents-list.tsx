import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Copy, ShieldAlert } from 'lucide-react';
import {
  CERT_IN_ANNEXURE_I,
  type CertInIncidentType,
  type IncidentSummary,
  type SecurityAlertView,
  type SecurityContact,
} from '@chumbaq/shared';
import { AdminQueryError } from '@/components/admin-query-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { adminErrorMessage, useAdminTenants } from '@/hooks/use-admin-tenants';
import {
  useCreateTripwireAccount,
  useCreateTripwireKey,
  useIncidents,
  useRecordIncident,
  useRevokeTripwire,
  useSaveSecurityContact,
  useSecurityAlerts,
  useSecurityContact,
  useTripwires,
} from '@/hooks/use-incidents';
import { copyText } from '@/lib/clipboard';
import { deadlineOf, formatIstAndUtc, fromLocalInputValue, remaining, toLocalInputValue } from '@/lib/incident-time';
import { cn } from '@/lib/utils';

const ALARM_LABELS: Record<SecurityAlertView['kind'], string> = {
  'server.ssh_login': 'Server sign-in (SSH)',
  'server.ssh_banned': 'Failed server sign-ins, address blocked',
  'server.files_changed': 'Server files changed',
  'staff.new_device': 'Staff sign-in from a new device',
  'staff.failed_sign_ins': 'Failed staff sign-ins',
  'data.bulk_export': 'Large data export',
  'data.unusual_reads': 'Unusually many reads',
  'tripwire.api_key': 'Trap API key used',
  'tripwire.account': 'Trap account used',
};

/** Re-renders every 30 seconds, so countdowns move without refetching. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Deadline({ incident, now }: { incident: IncidentSummary; now: Date }) {
  if (incident.status !== 'open') {
    return <span className="text-sm text-muted-foreground">{incident.status === 'reported' ? 'Reported' : 'Closed'}</span>;
  }
  const left = remaining(deadlineOf(incident.noticedAt), now);
  return (
    <span className={cn('text-sm font-medium tabular-nums', left.overdue ? 'text-destructive' : 'text-foreground')}>
      {left.text}
    </span>
  );
}

function RecordIncidentCard({ fromAlarm, onDone }: { fromAlarm: SecurityAlertView | null; onDone: () => void }) {
  const navigate = useNavigate();
  const record = useRecordIncident();
  const [noticedAt, setNoticedAt] = useState(() => toLocalInputValue(new Date()));
  const [howNoticed, setHowNoticed] = useState('');
  const [types, setTypes] = useState<CertInIncidentType[]>([]);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [systems, setSystems] = useState('');
  const [tenantSearch, setTenantSearch] = useState('');
  const [tenants, setTenants] = useState<{ id: string; email: string }[]>([]);
  const found = useAdminTenants({ page: 1, limit: 5, search: tenantSearch || undefined });

  useEffect(() => {
    if (!fromAlarm) return;
    setNoticedAt(toLocalInputValue(new Date(fromAlarm.firstAt)));
    setHowNoticed(`Security alarm: ${ALARM_LABELS[fromAlarm.kind]} (${fromAlarm.key})`);
    setTitle(ALARM_LABELS[fromAlarm.kind]);
  }, [fromAlarm]);

  const toggle = (id: CertInIncidentType) =>
    setTypes((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const created = await record.mutateAsync({
        noticedAt: fromLocalInputValue(noticedAt) ?? undefined,
        howNoticed: howNoticed.trim() || undefined,
        types,
        title: title.trim(),
        summary: summary.trim() || undefined,
        systems: systems.trim() || undefined,
        tenantIds: tenants.map((t) => t.id),
        alertId: fromAlarm?.id,
      });
      onDone();
      navigate(`/incidents/${created.id}`);
    } catch (error) {
      toast({ title: 'Could not record the incident', description: adminErrorMessage(error, 'The request failed.'), variant: 'destructive' });
    }
  };

  return (
    <Card id="record">
      <CardHeader>
        <CardTitle>Record an incident</CardTitle>
        <CardDescription>
          Do this first. CERT-In must be told within 6 hours of anyone here noticing it, or being told of it.
          Only the time, one type and a title are needed now; add the rest as notes later.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="noticed-at">When it was noticed (your time)</Label>
              <Input id="noticed-at" type="datetime-local" value={noticedAt} onChange={(e) => setNoticedAt(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="how-noticed">How it came to notice</Label>
            <Input id="how-noticed" value={howNoticed} maxLength={2000} onChange={(e) => setHowNoticed(e.target.value)} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Type (CERT-In Annexure I): pick at least one</legend>
            <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
              {CERT_IN_ANNEXURE_I.map((type) => (
                <label key={type.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={types.includes(type.id)}
                    onChange={() => toggle(type.id)}
                  />
                  <span>
                    <span className="text-muted-foreground">({type.id})</span> {type.label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="summary">What happened</Label>
            <Textarea id="summary" rows={4} value={summary} maxLength={10000} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="systems">Systems affected</Label>
            <Input id="systems" value={systems} maxLength={2000} onChange={(e) => setSystems(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tenant-search">Customer accounts affected</Label>
            <Input
              id="tenant-search"
              placeholder="Search by email or name"
              value={tenantSearch}
              onChange={(e) => setTenantSearch(e.target.value)}
            />
            {tenantSearch && (
              <ul className="rounded-md border text-sm">
                {(found.data?.data ?? [])
                  .filter((t) => !tenants.some((chosen) => chosen.id === t.id))
                  .map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-1.5 text-left hover:bg-muted"
                        onClick={() => {
                          setTenants((current) => [...current, { id: t.id, email: t.email }]);
                          setTenantSearch('');
                        }}
                      >
                        {t.email}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
            {tenants.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {tenants.map((t) => (
                  <Badge key={t.id} variant="secondary">
                    {t.email}
                    <button
                      type="button"
                      aria-label={`Remove ${t.email}`}
                      onClick={() => setTenants((current) => current.filter((c) => c.id !== t.id))}
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <Button type="submit" disabled={record.isPending || types.length === 0 || !title.trim()}>
            {record.isPending ? 'Recording...' : 'Record incident'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function IncidentsCard({ now }: { now: Date }) {
  const { data, isLoading, isError, error, refetch } = useIncidents();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Incidents</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isError ? (
          <AdminQueryError error={error} subject="incidents" onRetry={() => refetch()} />
        ) : isLoading || !data ? (
          <Skeleton className="m-6 h-24" />
        ) : data.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">No incidents recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Incident</TableHead>
                <TableHead>Noticed</TableHead>
                <TableHead>Report by</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((incident) => {
                const overdue = incident.status === 'open' && remaining(deadlineOf(incident.noticedAt), now).overdue;
                return (
                  <TableRow key={incident.id} className={cn(overdue && 'bg-destructive/5 hover:bg-destructive/10')}>
                    <TableCell className="pl-6">
                      <Link className="font-medium underline-offset-4 hover:underline" to={`/incidents/${incident.id}`}>
                        {incident.title}
                      </Link>
                      <div className="text-xs text-muted-foreground">Types {incident.types.join(', ')}</div>
                    </TableCell>
                    <TableCell className="text-sm">{formatIstAndUtc(incident.noticedAt)}</TableCell>
                    <TableCell className="text-sm">{formatIstAndUtc(incident.deadline)}</TableCell>
                    <TableCell className="pr-6">
                      <Deadline incident={incident} now={now} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function AlarmsCard({ onOpen }: { onOpen: (alarm: SecurityAlertView) => void }) {
  const { data, isLoading, isError, error, refetch } = useSecurityAlerts();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent alarms</CardTitle>
        <CardDescription>
          Each alarm is emailed to every staff member, at most once in 15 minutes; repeats are counted.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isError ? (
          <AdminQueryError error={error} subject="alarms" onRetry={() => refetch()} />
        ) : isLoading || !data ? (
          <Skeleton className="m-6 h-24" />
        ) : data.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">No alarms.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Alarm</TableHead>
                <TableHead>When</TableHead>
                <TableHead>From</TableHead>
                <TableHead className="pr-6 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((alarm) => (
                <TableRow key={alarm.id}>
                  <TableCell className="pl-6">
                    <div className="flex items-center gap-2 font-medium">
                      <ShieldAlert className="h-4 w-4 text-destructive" />
                      {ALARM_LABELS[alarm.kind]}
                      {alarm.count > 1 && <Badge variant="outline">×{alarm.count}</Badge>}
                      {alarm.emailFailed && <Badge variant="destructive">Email not sent</Badge>}
                    </div>
                    <div className="break-all text-xs text-muted-foreground">
                      {Object.entries(alarm.details)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ')}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{formatIstAndUtc(alarm.firstAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{alarm.ip ?? '-'}</TableCell>
                  <TableCell className="pr-6 text-right">
                    <Button variant="outline" size="sm" onClick={() => onOpen(alarm)}>
                      Open an incident
                    </Button>
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

function TripwiresCard() {
  const { data } = useTripwires();
  const createKey = useCreateTripwireKey();
  const createAccount = useCreateTripwireAccount();
  const revoke = useRevokeTripwire();
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [shownKey, setShownKey] = useState<string | null>(null);

  const fail = (error: unknown) =>
    toast({ title: 'That did not work', description: adminErrorMessage(error, 'The request failed.'), variant: 'destructive' });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Traps</CardTitle>
        <CardDescription>
          A fake API key or an email address nobody uses. Any use of either raises an alarm. Put the key somewhere only an
          intruder would look; use an address you watch, so mail to it means our data has leaked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
          <div className="space-y-2">
            <Label htmlFor="trap-label">Label (where you put it)</Label>
            <Input id="trap-label" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trap-email">Trap address (for an account trap)</Label>
            <Input id="trap-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button
            variant="outline"
            disabled={!label.trim() || createKey.isPending}
            onClick={async () => {
              try {
                const { key } = await createKey.mutateAsync(label.trim());
                setShownKey(key);
                setLabel('');
              } catch (error) {
                fail(error);
              }
            }}
          >
            Make a trap key
          </Button>
          <Button
            variant="outline"
            disabled={!label.trim() || !email.trim() || createAccount.isPending}
            onClick={async () => {
              try {
                await createAccount.mutateAsync({ email: email.trim(), label: label.trim() });
                setEmail('');
                setLabel('');
              } catch (error) {
                fail(error);
              }
            }}
          >
            Make a trap account
          </Button>
        </div>
        {shownKey && (
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="text-sm font-medium">Copy this key now. It is not shown again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-xs">{shownKey}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  const ok = await copyText(shownKey);
                  toast(ok ? { title: 'Copied' } : { title: 'Could not copy; select it and copy by hand', variant: 'destructive' });
                }}
              >
                <Copy className="mr-1 h-3 w-3" /> Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShownKey(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
        {data && data.length > 0 && (
          <ul className="divide-y rounded-md border text-sm">
            {data.map((trap) => (
              <li key={trap.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>
                  <Badge variant="outline">{trap.kind === 'api_key' ? 'Key' : 'Account'}</Badge> {trap.label}
                  {trap.revokedAt && <span className="ml-2 text-muted-foreground">(off)</span>}
                </span>
                {!trap.revokedAt && (
                  <Button size="sm" variant="ghost" onClick={() => revoke.mutate(trap.id, { onError: fail })}>
                    Switch off
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const CONTACT_FIELDS: { key: keyof Omit<SecurityContact, 'updatedAt'>; label: string; type?: string }[] = [
  { key: 'orgName', label: 'Organisation' },
  { key: 'orgAddress', label: 'Address' },
  { key: 'sector', label: 'Sector' },
  { key: 'pocName', label: 'Point of contact' },
  { key: 'pocRole', label: 'Their role' },
  { key: 'pocEmail', label: 'Their email', type: 'email' },
  { key: 'pocPhone', label: 'Their phone' },
];

function SecurityContactCard() {
  const { data } = useSecurityContact();
  const save = useSaveSecurityContact();
  const [form, setForm] = useState<Omit<SecurityContact, 'updatedAt'> | null>(null);
  const values = useMemo(
    () => form ?? (data ? { ...data, updatedAt: undefined } : null),
    [form, data],
  ) as Omit<SecurityContact, 'updatedAt'> | null;
  if (!values) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Security contact</CardTitle>
        <CardDescription>
          Used to fill the CERT-In report draft. The point of contact is the person CERT-In was told about (Annexure II).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await save.mutateAsync(values);
              setForm(null);
              toast({ title: 'Saved' });
            } catch (error) {
              toast({ title: 'Could not save', description: adminErrorMessage(error, 'The request failed.'), variant: 'destructive' });
            }
          }}
        >
          {CONTACT_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`contact-${field.key}`}>{field.label}</Label>
              <Input
                id={`contact-${field.key}`}
                type={field.type ?? 'text'}
                maxLength={300}
                value={values[field.key] ?? ''}
                onChange={(e) => setForm({ ...values, [field.key]: e.target.value })}
              />
            </div>
          ))}
          <div className="md:col-span-2">
            <Button type="submit" variant="outline" disabled={!form || save.isPending}>
              {save.isPending ? 'Saving...' : 'Save contact'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function IncidentsListPage() {
  const now = useNow();
  const [fromAlarm, setFromAlarm] = useState<SecurityAlertView | null>(null);
  const { data } = useIncidents();
  const overdue = (data ?? []).filter((i) => i.status === 'open' && remaining(deadlineOf(i.noticedAt), now).overdue);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Incidents</h1>
        <p className="text-sm text-muted-foreground">
          CERT-In: report the types in Annexure I within 6 hours of noticing them. The draft report and the log bundle are
          on each incident.
        </p>
      </div>
      {overdue.length > 0 && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          {overdue.length === 1 ? 'One incident is' : `${overdue.length} incidents are`} past the 6-hour deadline and not marked
          reported.
        </div>
      )}
      <IncidentsCard now={now} />
      <RecordIncidentCard
        fromAlarm={fromAlarm}
        onDone={() => setFromAlarm(null)}
      />
      <AlarmsCard
        onOpen={(alarm) => {
          setFromAlarm(alarm);
          document.getElementById('record')?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
      <TripwiresCard />
      <SecurityContactCard />
    </div>
  );
}

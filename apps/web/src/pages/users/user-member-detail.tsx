import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, MapPin, Clock, Search, Calendar, Copy, Check,
  ChevronDown, ChevronRight, Smartphone, Eye, Filter,
  Bell, BellOff, Send, MousePointerClick, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useUserMemberDetail } from '@/hooks/use-users';
import { usePersonPushHistory, type PersonCampaign } from '@/hooks/use-push-notifications';
import { PersonPrivacyActions } from '@/components/person-privacy-actions';
import { format, formatDistanceToNow } from 'date-fns';

/* ─── Utility: Copy to clipboard with feedback ─── */
function CopyableId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-start gap-2.5 py-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
        <span className="text-xs font-bold text-muted-foreground">#</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className="mt-0.5 flex items-center gap-1.5">
          <p className="truncate font-mono text-[12px]">{value}</p>
          <button onClick={handleCopy} aria-label={`Copy ${label}`} title={`Copy ${label}`} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Sidebar info row ─── */
function SidebarInfo({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5 py-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-0.5 text-[12px]">{value}</p>
      </div>
    </div>
  );
}

/* ─── Profile property card in sidebar ─── */
function ProfilePropertyCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/50 px-3 py-2">
      <p className="text-[10px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[12px] break-all leading-snug">{value}</p>
    </div>
  );
}

/* ─── Property table row (inside event expansion) ─── */
function PropTableRow({ name, value }: { name: string; value: string }) {
  return (
    <div className="grid grid-cols-[180px_1fr] border-b border-border/40 last:border-b-0">
      <div className="px-3 py-2 text-[12px] font-medium text-muted-foreground">{name}</div>
      <div className="px-3 py-2 text-[12px] font-mono break-all">{value}</div>
    </div>
  );
}

/* ─── Event row with expandable tabbed properties ─── */
function EventRow({ event }: { event: any }) {
  const [expanded, setExpanded] = useState(false);

  // Classify properties
  const systemKeys = [
    'platform', 'country', 'city', 'ipAddress', 'ip_address', 'userAgent', 'user_agent',
    'sourceType', 'source_type', 'sourceId', 'source_id', 'deviceIdentityId', 'device_identity_id',
    'projectId', 'project_id', 'distinctId', 'distinct_id',
  ];

  const allProps: [string, string][] = [];
  const eventProps: [string, string][] = [];
  const sysProps: [string, string][] = [];

  // System-level fields from the event object itself
  const systemFields: Record<string, any> = {};
  if (event.platform) systemFields['Platform'] = event.platform;
  if (event.country) systemFields['Country'] = event.country;
  if (event.city) systemFields['City'] = event.city;
  if (event.ipAddress) systemFields['IP Address'] = event.ipAddress;
  if (event.userAgent) systemFields['User Agent'] = event.userAgent;
  if (event.sourceType) systemFields['Source Type'] = event.sourceType;

  Object.entries(systemFields).forEach(([k, v]) => {
    const val = String(v);
    allProps.push([k, val]);
    sysProps.push([k, val]);
  });

  // Custom properties from event.properties
  if (event.properties && typeof event.properties === 'object') {
    Object.entries(event.properties).forEach(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      allProps.push([k, val]);
      if (systemKeys.includes(k)) {
        sysProps.push([k, val]);
      } else {
        eventProps.push([k, val]);
      }
    });
  }

  return (
    <div className="border-b border-border/40 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <span className="w-[80px] shrink-0 font-mono text-[12px] text-muted-foreground">
          {format(new Date(event.timestamp), 'h:mm:ss a')}
        </span>
        <span className="flex-1 text-[13px] font-medium">{event.eventName}</span>
        {allProps.length > 0 && (
          <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
            {allProps.length} properties
          </span>
        )}
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && allProps.length > 0 && (
        <div className="border-t border-border/40 bg-muted/20 px-4 pb-3 pt-2">
          <Tabs defaultValue="all">
            <TabsList className="h-8 bg-muted/60">
              <TabsTrigger value="all" className="text-[11px] px-2.5 py-1">
                All Event Properties ({allProps.length})
              </TabsTrigger>
              <TabsTrigger value="event" className="text-[11px] px-2.5 py-1">
                Event Properties ({eventProps.length})
              </TabsTrigger>
              <TabsTrigger value="system" className="text-[11px] px-2.5 py-1">
                System Properties ({sysProps.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="all" className="mt-3">
              <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
                {allProps.map(([name, value]) => (
                  <PropTableRow key={name} name={name} value={value} />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="event" className="mt-3">
              <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
                {eventProps.length > 0 ? (
                  eventProps.map(([name, value]) => (
                    <PropTableRow key={name} name={name} value={value} />
                  ))
                ) : (
                  <p className="px-4 py-5 text-center text-[12px] text-muted-foreground">No custom event properties</p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="system" className="mt-3">
              <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
                {sysProps.length > 0 ? (
                  sysProps.map(([name, value]) => (
                    <PropTableRow key={name} name={name} value={value} />
                  ))
                ) : (
                  <p className="px-4 py-5 text-center text-[12px] text-muted-foreground">No system properties</p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

/* ─── One stage of a push's delivery funnel.
   Dimmed + label-only when it hasn't happened, full opacity + timestamp when
   it has — never a bare dash. A dash next to "Delivered" would read as "no
   data", but here it means the device never reported it, most likely because
   the push never arrived. ─── */
function FunnelStep({ icon: Icon, label, at }: { icon: any; label: string; at: string | null }) {
  return (
    <div className={`flex items-center gap-1.5 ${at ? '' : 'opacity-40'}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="whitespace-nowrap">
        {label}
        {at && <span className="ml-1 text-muted-foreground">{format(new Date(at), 'MMM d, h:mm a')}</span>}
      </span>
    </div>
  );
}

/* ─── One campaign that reached this person, and how far it got ─── */
function PushCampaignRow({ campaign }: { campaign: PersonCampaign }) {
  const { title, sentAt, delivered, impression, clicked, dismissed } = campaign;

  // "Never arrived" requires that nothing at all came back, not merely that
  // no delivery receipt did.
  //
  // A delivery receipt is the least reliable event of the four. On iOS it is
  // reported from `willPresent`, which only fires while the app is in the
  // foreground — the ordinary case, a push arriving to a backgrounded app and
  // being tapped, reports a click and no delivery. Treating a missing receipt
  // as proof of non-delivery would tell someone the push never arrived while
  // showing the moment the user opened it, and it would do that most often on
  // exactly the complaint this page exists to settle.
  const nothingReported = !delivered && !impression && !clicked && !dismissed;

  if (nothingReported) {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{title}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {sentAt ? `Sent ${format(new Date(sentAt), 'MMM d, yyyy · h:mm a')}` : 'Sent'}
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 gap-1 text-[11px] font-normal text-muted-foreground">
          <BellOff className="h-3 w-3" /> Never arrived
        </Badge>
      </div>
    );
  }

  // Clicked and dismissed are alternate endings of the same last step, not
  // independent flags — a push is either opened or dismissed, never both.
  const finalStep = clicked
    ? { label: 'Clicked', at: clicked, icon: MousePointerClick }
    : dismissed
    ? { label: 'Dismissed', at: dismissed, icon: XCircle }
    : { label: 'No action yet', at: null, icon: MousePointerClick };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-[13px] font-medium">{title}</p>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {sentAt ? format(new Date(sentAt), 'MMM d, yyyy · h:mm a') : ''}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        {/* Dimmed rather than absent when a later step fired: the receipt is
            missing, which is not the same as the push being. */}
        <FunnelStep icon={Send} label="Delivered" at={delivered} />
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        <FunnelStep icon={Eye} label="Shown" at={impression} />
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        <FunnelStep icon={finalStep.icon} label={finalStep.label} at={finalStep.at} />
      </div>
    </div>
  );
}

/* ─── Main Page ─── */
export default function UserMemberDetailPage() {
  const { projectId, personId } = useParams<{ projectId: string; personId: string }>();
  const { data: person, isLoading } = useUserMemberDetail(projectId, personId);
  const { data: pushHistory, isLoading: pushLoading, isError: pushError } = usePersonPushHistory(projectId, personId);
  const [propSearch, setPropSearch] = useState('');

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-10 w-48 animate-pulse rounded-lg bg-muted" />
        <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="rounded-xl border p-5 space-y-4">
              <div className="mx-auto h-20 w-20 animate-pulse rounded-full bg-muted" />
              <div className="h-5 w-40 mx-auto animate-pulse rounded bg-muted" />
              <div className="h-4 w-56 mx-auto animate-pulse rounded bg-muted" />
              <div className="space-y-2">
                {[...Array(4)].map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />)}
              </div>
            </div>
            <div className="rounded-xl border p-4 space-y-2">
              {[...Array(6)].map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />)}
            </div>
          </div>
          <div className="rounded-xl border p-5 space-y-3">
            <div className="h-7 w-44 animate-pulse rounded bg-muted" />
            {[...Array(6)].map((_, i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />)}
          </div>
        </div>
      </div>
    );
  }

  if (!person) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <p className="text-lg text-muted-foreground">Person not found</p>
        <Button variant="outline" asChild>
          <Link to={`/projects/${projectId}/users`}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Back to Users
          </Link>
        </Button>
      </div>
    );
  }

  // ── Build profile properties ──
  const rawProps: [string, any][] = [];
  const addProp = (label: string, value: any) => {
    if (value !== null && value !== undefined && value !== '' && value !== 0 && value !== false) {
      rawProps.push([label, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)]);
    }
  };

  // Custom traits first
  if (person.traits) {
    Object.entries(person.traits).forEach(([k, v]) => {
      if (!k.startsWith('$')) addProp(k, typeof v === 'object' ? JSON.stringify(v) : v);
    });
  }

  addProp('City', person.city);
  addProp('Country', person.country);
  addProp('Country Code', person.countryCode);
  addProp('Email', person.email);
  addProp('Phone', person.phone);
  addProp('First Name', person.firstName);
  addProp('Last Name', person.lastName);
  addProp('Locale', person.locale);
  addProp('Language', person.language);
  addProp('Region', person.region);
  addProp('Timezone', person.timezone);
  addProp('Operating System', person.os);
  addProp('OS Version', person.osVersion);
  addProp('Browser', person.browser);
  addProp('Browser Version', person.browserVersion);
  addProp('App Version', person.appVersion);
  addProp('App Build Number', person.appBuild);
  addProp('Manufacturer', person.manufacturer);
  addProp('Brand', person.brand);
  addProp('Model', person.model);
  addProp('Screen Width', person.screenWidth);
  addProp('Screen Height', person.screenHeight);
  addProp('Carrier', person.carrier);
  addProp('Platform', person.platform);
  addProp('Total Sessions', person.totalSessions);
  if (person.totalRevenue > 0) addProp('Total Revenue', `${person.currency || '$'}${Number(person.totalRevenue).toFixed(2)}`);
  addProp('Initial Referrer', person.initialReferrer);
  addProp('Initial UTM Source', person.initialUtmSource);
  addProp('Initial UTM Medium', person.initialUtmMedium);
  addProp('Initial UTM Campaign', person.initialUtmCampaign);
  addProp('Initial UTM Content', person.initialUtmContent);
  addProp('Initial UTM Term', person.initialUtmTerm);
  addProp('Install Source', person.installSource);
  addProp('Install Campaign', person.installCampaign);
  addProp('Latest UTM Source', person.latestUtmSource);
  addProp('Latest UTM Medium', person.latestUtmMedium);
  addProp('Latest UTM Campaign', person.latestUtmCampaign);
  if (person.emailOptIn !== null) addProp('Email Opt-in', person.emailOptIn);
  if (person.smsOptIn !== null) addProp('SMS Opt-in', person.smsOptIn);
  if (person.whatsappOptIn != null) addProp('WhatsApp Opt-in', person.whatsappOptIn);
  if (person.pushOptIn !== null) addProp('Push Opt-in', person.pushOptIn);
  if (person.gdprConsent !== null) addProp('GDPR Consent', person.gdprConsent);
  if (person.doNotTrack) addProp('Do Not Track', person.doNotTrack);

  const filteredProps = propSearch
    ? rawProps.filter(([label, val]) =>
        label.toLowerCase().includes(propSearch.toLowerCase()) ||
        String(val).toLowerCase().includes(propSearch.toLowerCase()),
      )
    : rawProps;

  // ── Group events by date ──
  const eventsByDate = new Map<string, any[]>();
  (person.recentEvents || []).forEach((event: any) => {
    const dateKey = format(new Date(event.timestamp), 'EEEE · MMMM d, yyyy');
    if (!eventsByDate.has(dateKey)) eventsByDate.set(dateKey, []);
    eventsByDate.get(dateKey)!.push(event);
  });

  // Newest first. sentAt is nullable in the contract even though a dispatched
  // campaign always has one — treat a missing one as oldest rather than crash.
  const sortedCampaigns = [...(pushHistory?.campaigns || [])].sort(
    (a, b) => (b.sentAt ? new Date(b.sentAt).getTime() : 0) - (a.sentAt ? new Date(a.sentAt).getTime() : 0),
  );

  const displayName = person.email || person.displayName;
  const updatedAgo = formatDistanceToNow(new Date(person.lastSeenAt), { addSuffix: true });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-1 text-muted-foreground hover:text-foreground">
            <Link to={`/projects/${projectId}/users`}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Users
            </Link>
          </Button>
          <h1 className="text-xl font-bold tracking-tight">{displayName}</h1>
          <p className="text-xs text-muted-foreground">User profile and event timeline</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {person.totalSessions > 0 && (
            <Badge variant="secondary" className="text-[11px] font-normal">
              <Eye className="mr-1.5 h-3 w-3" />{person.totalSessions} sessions
            </Badge>
          )}
          {person.totalRevenue > 0 && (
            <Badge variant="secondary" className="text-[11px] font-normal text-green-600">
              {person.currency || '$'}{Number(person.totalRevenue).toFixed(2)} LTV
            </Badge>
          )}
          <Badge variant="secondary" className="text-[11px] font-normal">Last 30 days</Badge>
          <PersonPrivacyActions
            projectId={projectId!}
            personId={person.id}
            confirmationText={person.externalUserId || person.distinctId}
            externalUserId={person.externalUserId}
          />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-3 xl:sticky xl:top-4 self-start">
          <div className="rounded-xl border border-border/60 bg-card p-4">
            <div className="mb-4 text-center">
              {person.avatar ? (
                <img src={person.avatar} alt="" className="mx-auto mb-2.5 h-16 w-16 rounded-full object-cover ring-2 ring-border" />
              ) : (
                <div className="mx-auto mb-2.5 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-2 ring-border">
                  <span className="text-xl font-bold">{(person.displayName || '?').charAt(0).toUpperCase()}</span>
                </div>
              )}
              <h2 className="text-xs font-semibold">User Profile</h2>
              <p className="mt-1 break-all text-xs text-muted-foreground">{displayName}</p>
            </div>

            <div className="divide-y divide-border/40">
              <CopyableId label="Distinct ID" value={person.distinctId} />
              {person.externalUserId && <CopyableId label="External User ID" value={person.externalUserId} />}
              {(person.city || person.country) && (
                <SidebarInfo
                  icon={MapPin}
                  label="Location"
                  value={[person.city, person.region, person.country].filter(Boolean).join(', ')}
                />
              )}
              <SidebarInfo icon={Clock} label="Updated" value={updatedAgo} />
              {person.devices && person.devices.length > 1 && (
                <SidebarInfo icon={Smartphone} label="Devices" value={`${person.devices.length} linked devices`} />
              )}
            </div>

            <Separator className="my-3" />

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-center">
                <p className="text-[10px] text-muted-foreground">Sessions</p>
                <p className="text-[12px] font-semibold">{person.totalSessions}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-center">
                <p className="text-[10px] text-muted-foreground">Events</p>
                <p className="text-[12px] font-semibold">{person.totalEvents}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-center">
                <p className="text-[10px] text-muted-foreground">Revenue</p>
                <p className="text-[12px] font-semibold">{person.totalRevenue > 0 ? `${person.currency || '$'}${Number(person.totalRevenue).toFixed(0)}` : '-'}</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-card p-3.5">
            <h3 className="mb-2.5 text-xs font-semibold">Profile Properties</h3>
            <div className="relative mb-2.5">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search properties"
                value={propSearch}
                onChange={(e) => setPropSearch(e.target.value)}
                className="h-8 bg-background/50 pl-9 text-[12px]"
              />
            </div>
            <div className="max-h-[340px] space-y-1.5 overflow-y-auto pr-1">
              {filteredProps.map(([label, value], idx) => (
                <ProfilePropertyCard key={`${label}-${idx}`} label={label} value={value} />
              ))}
              {filteredProps.length === 0 && (
                <p className="py-6 text-center text-[12px] text-muted-foreground">
                  {propSearch ? 'No matching properties' : 'No properties set'}
                </p>
              )}
            </div>
          </div>

          {person.devices && person.devices.length > 1 && (
            <div className="rounded-xl border border-border/60 bg-card p-3.5">
              <h3 className="mb-2.5 text-xs font-semibold">Linked Devices</h3>
              <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                {person.devices.map((d) => (
                  <div key={d.id} className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-background/40 p-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Smartphone className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-medium">{d.platform}{d.os ? ` · ${d.os}` : ''}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {[d.model, d.browser].filter(Boolean).join(' · ') || 'Unknown device'}
                      </p>
                    </div>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {d.lastSeenAt ? format(new Date(d.lastSeenAt), 'MMM d') : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        <main className="min-w-0 space-y-4">
          <div className="rounded-xl border border-border/60 bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Events</h2>
            </div>

            {person.eventCounts && person.eventCounts.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                {person.eventCounts.map((ec) => (
                  <Badge key={ec.eventName} variant="outline" className="text-[11px] font-mono font-normal">
                    {ec.eventName}
                    <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {ec.count}
                    </span>
                  </Badge>
                ))}
              </div>
            )}

            {eventsByDate.size === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                  <Filter className="h-6 w-6" />
                </div>
                <p className="text-[13px] font-medium">No events recorded yet</p>
                <p className="mt-1 text-[12px]">Events will appear here once the user interacts via the SDK.</p>
              </div>
            ) : (
              <div className="space-y-5">
                {Array.from(eventsByDate.entries()).map(([dateKey, events]) => (
                  <div key={dateKey}>
                    <div className="mb-2.5 flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-[12px] font-semibold text-foreground/60">{dateKey}</h3>
                    </div>
                    <div className="overflow-hidden rounded-lg border border-border/60 bg-background/30">
                      {events.map((event: any) => (
                        <EventRow key={event.id} event={event} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border/60 bg-card p-4">
            <h2 className="text-base font-semibold">Push Notifications</h2>
            {pushHistory && pushHistory.deviceCount > 1 && (
              // This spans every device the person owns, so "Shown" or "Clicked"
              // may have happened on a different device than "Delivered" —
              // worth flagging up front for anyone debugging a complaint.
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Merged across {pushHistory.deviceCount} of this person's devices.
              </p>
            )}

            <div className="mt-3">
              {pushLoading ? (
                <div className="space-y-2">
                  {[...Array(2)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />)}
                </div>
              ) : pushError ? (
                <p className="py-8 text-center text-[12px] text-muted-foreground">Couldn't load push history right now.</p>
              ) : sortedCampaigns.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                    <Bell className="h-6 w-6" />
                  </div>
                  <p className="text-[13px] font-medium">No campaigns have reached this person yet</p>
                  <p className="mt-1 text-[12px]">Push notifications sent to their devices will appear here.</p>
                </div>
              ) : (
                <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-background/30">
                  {sortedCampaigns.map((c) => (
                    <PushCampaignRow key={c.campaignId} campaign={c} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

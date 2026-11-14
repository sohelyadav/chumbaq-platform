import { Link } from 'react-router-dom';
import {
  Activity,
  Building2,
  CheckCircle2,
  Contact,
  FolderOpen,
  Link2,
  Mail,
  MessageCircle,
  MessageSquare,
  MousePointerClick,
  PauseCircle,
  Send,
  Smartphone,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import type { AdminOverview, AdminTenantUsageRef, UsageCoverage, UsageMetric } from '@chumbaq/shared';
import { AdminQueryError } from '@/components/admin-query-error';
import { SignupsChart } from '@/components/signups-chart';
import { UsageTrendChart } from '@/components/usage-trend-chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminOverview } from '@/hooks/use-admin-insights';
import {
  USAGE_METRIC_LABELS,
  countedThroughLabel,
  formatCount,
  formatDay,
  formatShortDay,
} from '@/lib/usage-format';

function StatCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: number | null;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{formatCount(value)}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

const USAGE_TILES: { metric: UsageMetric; icon: LucideIcon }[] = [
  { metric: 'push_sent', icon: Send },
  { metric: 'email_sent', icon: Mail },
  { metric: 'sms_sent', icon: MessageSquare },
  { metric: 'whatsapp_sent', icon: MessageCircle },
  { metric: 'clicks', icon: MousePointerClick },
  { metric: 'events', icon: Activity },
];

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * "This month, counted through 13 Nov 2026", saying when counting started if that
 * was this month: the first month's number leaves out activity from before then.
 */
function activeDevicesDescription(coverage: UsageCoverage | null): string {
  if (!coverage?.countedThrough) return 'Not counted yet';
  const sameMonth = coverage.mauFrom.slice(0, 7) === coverage.countedThrough.slice(0, 7);
  const from = sameMonth ? `, counted from ${formatDay(coverage.mauFrom)}` : '';
  return `This month, ${lowerFirst(countedThroughLabel(coverage))}${from}`;
}

function TenantRefCell({ tenant }: { tenant: AdminTenantUsageRef }) {
  return (
    <TableCell className="max-w-[240px]">
      <Link to={`/tenants/${tenant.id}`} className="block truncate text-sm font-medium hover:underline">
        {tenant.email}
      </Link>
      <p className="truncate text-xs text-muted-foreground">{tenant.name}</p>
    </TableCell>
  );
}

function UsageEmpty({ children }: { children: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function TopTenantsCard({ data }: { data: AdminOverview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top tenants</CardTitle>
        <CardDescription>By messages sent in 30 days plus monthly active devices</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!data.usageCoverage?.countedThrough ? (
          <UsageEmpty>No usage counted yet</UsageEmpty>
        ) : data.topTenants.length === 0 ? (
          <UsageEmpty>No tenant has used anything in the last 30 counted days</UsageEmpty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead className="text-right">Monthly active devices</TableHead>
                <TableHead className="text-right">Messages (30d)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.topTenants.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TenantRefCell tenant={tenant} />
                  <TableCell className="text-right text-sm tabular-nums">{formatCount(tenant.mauThisMonth)}</TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {formatCount(tenant.messagesSent30d)}
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

function QuietTenantsCard({ data }: { data: AdminOverview }) {
  const { count, tenants } = data.quietTenants;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Going quiet</CardTitle>
        <CardDescription>
          {count.toLocaleString('en-US')} {count === 1 ? 'tenant' : 'tenants'} with no usage in 14 days
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!data.usageCoverage?.countedThrough ? (
          <UsageEmpty>No usage counted yet</UsageEmpty>
        ) : tenants.length === 0 ? (
          <UsageEmpty>No tenant has gone quiet</UsageEmpty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead className="text-right">Last usage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TenantRefCell tenant={tenant} />
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {tenant.lastUsageDay ? `last usage ${formatShortDay(tenant.lastUsageDay)}` : 'None'}
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

function UsageSection({ data }: { data: AdminOverview }) {
  const coverage = data.usageCoverage;
  const usage = data.usage30d;
  return (
    <>
      <div>
        <h2 className="text-xl font-semibold">Usage, last 30 days</h2>
        <p className="text-sm text-muted-foreground">{countedThroughLabel(coverage)} (UTC days)</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={USAGE_METRIC_LABELS.mau_month_to_date}
          value={usage?.mau_month_to_date ?? null}
          description={activeDevicesDescription(coverage)}
          icon={Smartphone}
        />
        {USAGE_TILES.map(({ metric, icon }) => (
          <StatCard
            key={metric}
            title={USAGE_METRIC_LABELS[metric]}
            value={usage?.[metric] ?? null}
            description={coverage?.countedThrough ? 'Last 30 counted days' : 'Not counted yet'}
            icon={icon}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Usage per day</CardTitle>
          <CardDescription>All tenants, last 90 counted days (UTC)</CardDescription>
        </CardHeader>
        <CardContent>
          <UsageTrendChart days={data.usageTrend} coverage={coverage} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <TopTenantsCard data={data} />
        <QuietTenantsCard data={data} />
      </div>
    </>
  );
}

export default function AdminOverviewPage() {
  const { data, isLoading, error, refetch } = useAdminOverview();

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Overview</h1>

      {isLoading ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <Card key={i}>
                <CardContent className="p-6">
                  <Skeleton className="h-20" />
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardContent className="p-6">
              <Skeleton className="h-64" />
            </CardContent>
          </Card>
        </>
      ) : error || !data ? (
        <Card>
          <CardContent className="p-0">
            <AdminQueryError error={error} subject="the overview" onRetry={() => refetch()} />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Tenants"
              value={data.tenants.total}
              description="All accounts"
              icon={Building2}
            />
            <StatCard
              title="Active tenants"
              value={data.tenants.active}
              description="Not suspended"
              icon={CheckCircle2}
            />
            <StatCard
              title="Suspended tenants"
              value={data.tenants.suspended}
              description="Currently suspended"
              icon={PauseCircle}
            />
            <StatCard
              title="New tenants"
              value={data.tenants.newLast30d}
              description="Last 30 days"
              icon={UserPlus}
            />
            <StatCard
              title="Projects"
              value={data.projects}
              description="Across all tenants"
              icon={FolderOpen}
            />
            <StatCard
              title="Links"
              value={data.links}
              description="Across all tenants"
              icon={Link2}
            />
            <StatCard
              title="Identities"
              value={data.identities}
              description="Across all tenants"
              icon={Contact}
            />
            <StatCard
              title="Clicks"
              value={data.clicksLast30d}
              description="Last 30 days"
              icon={MousePointerClick}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Signups per day</CardTitle>
              <CardDescription>New tenant accounts, last 30 days (UTC)</CardDescription>
            </CardHeader>
            <CardContent>
              <SignupsChart rows={data.signupsByDay} />
            </CardContent>
          </Card>

          <UsageSection data={data} />
        </>
      )}
    </div>
  );
}

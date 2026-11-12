import {
  Building2,
  CheckCircle2,
  Contact,
  FolderOpen,
  Link2,
  MousePointerClick,
  PauseCircle,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { AdminQueryError } from '@/components/admin-query-error';
import { SignupsChart } from '@/components/signups-chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminOverview } from '@/hooks/use-admin-insights';

function StatCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: number;
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
        <div className="text-2xl font-bold tabular-nums">{value.toLocaleString()}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
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
        </>
      )}
    </div>
  );
}

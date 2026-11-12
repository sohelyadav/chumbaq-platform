import { Link, useParams } from 'react-router-dom';
import { BarChart3, Link2, MousePointerClick, FolderOpen, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useProjectDashboardStats } from '@/hooks/use-analytics';

export default function DashboardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: stats, isLoading, error } = useProjectDashboardStats(projectId!);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="h-20 animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            Failed to load dashboard stats. Make sure the API is running.
          </CardContent>
        </Card>
      </div>
    );
  }

  const statCards = [
    {
      title: 'Total Links',
      value: stats?.totalLinks ?? 0,
      icon: Link2,
      description: 'This project',
    },
    {
      title: 'Clicks (24h)',
      value: stats?.clicks24h ?? 0,
      icon: MousePointerClick,
      description: 'Last 24 hours',
    },
    {
      title: 'Clicks (7d)',
      value: stats?.clicks7d ?? 0,
      icon: BarChart3,
      description: 'Last 7 days',
    },
    {
      title: 'Conversions',
      value: stats?.totalConversions ?? 0,
      icon: FolderOpen,
      description: 'Total conversions',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <Button asChild>
          <Link to={`/projects/${projectId}/links/new`}>Create Link</Link>
        </Button>
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">{stat.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top links */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Top Links</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/projects/${projectId}/links`}>
                View all <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {stats?.topLinks && stats.topLinks.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Short Code</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.topLinks.map((link) => (
                    <TableRow key={link.id}>
                      <TableCell>
                        <Link to={`/projects/${projectId}/links/${link.id}`} className="font-medium hover:underline">
                          {link.title || link.shortCode}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{link.shortCode}</TableCell>
                      <TableCell className="text-right">{link.clicks.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">
                No links yet.{' '}
                <Link to={`/projects/${projectId}/links/new`} className="text-primary hover:underline">
                  Create your first link
                </Link>
              </p>
            )}
          </CardContent>
        </Card>

        {/* Summary */}
        <Card>
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                { label: 'Clicks (30d)', value: stats?.clicks30d ?? 0 },
                { label: 'Clicks (7d)', value: stats?.clicks7d ?? 0 },
                { label: 'Clicks (24h)', value: stats?.clicks24h ?? 0 },
                { label: 'Total Conversions', value: stats?.totalConversions ?? 0 },
              ].map((step) => (
                <div key={step.label} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{step.label}</span>
                    <span className="font-medium">{step.value.toLocaleString()}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${stats?.clicks30d ? Math.max((step.value / stats.clicks30d) * 100, 1) : 1}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

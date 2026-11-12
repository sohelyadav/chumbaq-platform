import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Contact, Users, Bell, BellOff, UserPlus, Search, ChevronLeft, ChevronRight, DollarSign, Globe } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  SelectRoot as Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useUsers, useUserStats } from '@/hooks/use-users';
import { format } from 'date-fns';

export default function UsersListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('');
  const [pushFilter, setPushFilter] = useState<string>('');
  const [platformFilter, setPlatformFilter] = useState<string>('');

  const { data: stats, isLoading: statsLoading } = useUserStats(projectId);
  const { data: response, isLoading } = useUsers(projectId, {
    search: search || undefined,
    page,
    limit: 20,
    status: status || undefined,
    pushEnabled: pushFilter || undefined,
    platform: platformFilter || undefined,
  });

  const members = response?.data;
  const meta = response?.meta;

  const statCards = stats ? [
    { title: 'Total Users', value: stats.total, icon: Users },
    { title: 'Active (30d)', value: stats.active30d, icon: Contact },
    { title: 'Identified', value: stats.identified, icon: UserPlus },
    { title: 'Push-Enabled', value: stats.pushEnabled, icon: Bell },
    { title: 'With Revenue', value: stats.withRevenue, icon: DollarSign },
    { title: 'Total Revenue', value: `$${Number(stats.totalRevenue || 0).toLocaleString()}`, icon: DollarSign },
  ] : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Users</h1>
        <p className="text-muted-foreground mt-1">Users identified in your project via the SDK.</p>
      </div>

      {/* Stats */}
      {statsLoading ? (
        <div className="grid gap-4 md:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="p-6"><div className="h-14 animate-pulse rounded bg-muted" /></CardContent></Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
          {statCards.map((stat) => (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
                <stat.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stat.value.toLocaleString()}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or ID..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v === 'all' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <Select value={pushFilter} onValueChange={(v) => { setPushFilter(v === 'all' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Push status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All push status</SelectItem>
            <SelectItem value="true">Push enabled</SelectItem>
            <SelectItem value="false">Push disabled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={platformFilter} onValueChange={(v) => { setPlatformFilter(v === 'all' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Platform" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All platforms</SelectItem>
            <SelectItem value="web">Web</SelectItem>
            <SelectItem value="ios">iOS</SelectItem>
            <SelectItem value="android">Android</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : !members || members.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Contact className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="text-sm">No users found. Users appear here once they interact via the SDK.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Revenue</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Last Seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id} className="cursor-pointer hover:bg-muted/50">
                    <TableCell>
                      <Link to={`/projects/${projectId}/users/${member.id}`} className="block">
                        <div className="flex items-center gap-3">
                          {member.avatar ? (
                            <img src={member.avatar} alt="" className="size-8 rounded-full object-cover" />
                          ) : (
                            <div className="flex aspect-square size-8 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-medium">
                              {(member.displayName || '?').charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div>
                            <p className="font-medium text-sm hover:underline">{member.displayName}</p>
                            {member.email && <p className="text-xs text-muted-foreground">{member.email}</p>}
                            {member.phone && !member.email && <p className="text-xs text-muted-foreground">{member.phone}</p>}
                            {!member.email && !member.phone && member.distinctId !== member.displayName && (
                              <p className="text-xs text-muted-foreground font-mono">{member.distinctId.slice(0, 16)}...</p>
                            )}
                          </div>
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        <Badge variant="outline" className="text-xs">{member.platform}</Badge>
                        {member.os && <p className="text-[10px] text-muted-foreground">{member.os}</p>}
                      </div>
                    </TableCell>
                    <TableCell>
                      {member.country ? (
                        <div className="text-xs">
                          <p>{member.country}</p>
                          {member.city && <p className="text-muted-foreground">{member.city}</p>}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={member.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                          {member.status}
                        </Badge>
                        {member.pushEnabled && <Bell className="h-3 w-3 text-green-600" />}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{member.totalSessions}</TableCell>
                    <TableCell className="text-sm">{member.totalEvents.toLocaleString()}</TableCell>
                    <TableCell className="text-sm">
                      {member.totalRevenue > 0 ? (
                        <span className="text-green-600 font-medium">${Number(member.totalRevenue).toFixed(2)}</span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {member.initialUtmSource ? (
                        <Badge variant="outline" className="text-[10px]">{member.initialUtmSource}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">organic</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {member.lastSeenAt ? format(new Date(member.lastSeenAt), 'MMM d, yyyy') : 'Never'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {((meta.page - 1) * meta.limit) + 1}–{Math.min(meta.page * meta.limit, meta.total)} of {meta.total}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

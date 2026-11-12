import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { format, formatDistanceToNow } from 'date-fns';
import { Building2, ChevronLeft, ChevronRight, Search, ShieldCheck } from 'lucide-react';
import type { AdminTenantStatus } from '@chumbaq/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  SelectContent,
  SelectItem,
  SelectRoot as Select,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminErrorMessage, httpStatus, useAdminTenants } from '@/hooks/use-admin-tenants';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function parseStatus(value: string | null): AdminTenantStatus | undefined {
  return value === 'active' || value === 'suspended' ? value : undefined;
}

function parsePage(value: string | null): number {
  const page = Number.parseInt(value ?? '', 10);
  return page > 0 ? page : 1;
}

export default function TenantsListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('search') ?? '';
  const status = parseStatus(searchParams.get('status'));
  const page = parsePage(searchParams.get('page'));
  const [searchInput, setSearchInput] = useState(search);

  /** Writes to the URL, which is the page's only state. Changing a filter resets the page. */
  function updateParams(changes: { search?: string; status?: string; page?: number }, replace = false) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('page');
        if (changes.search !== undefined) {
          if (changes.search) next.set('search', changes.search);
          else next.delete('search');
        }
        if (changes.status !== undefined) {
          if (changes.status) next.set('status', changes.status);
          else next.delete('status');
        }
        if (changes.page && changes.page > 1) next.set('page', String(changes.page));
        return next;
      },
      { replace },
    );
  }

  // Follows the URL on back and forward, leaving alone what is mid-typing: a
  // trailing space trims to the same search and must stay in the box.
  useEffect(() => {
    setSearchInput((current) => (current.trim() === search ? current : search));
  }, [search]);

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === search) return;
    const timer = setTimeout(() => updateParams({ search: trimmed }, true), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // Only typing starts the timer; a URL change is handled by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const { data: response, isLoading, isError, error, isPlaceholderData } = useAdminTenants({
    page,
    limit: PAGE_SIZE,
    search: search || undefined,
    status,
  });
  const tenants = response?.data;
  const meta = response?.meta;
  const filtered = !!search || !!status;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Tenants</h1>
        <p className="text-muted-foreground mt-1">Every account on the platform and what it owns.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by email or name..."
            aria-label="Search tenants"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={status ?? 'all'}
          onValueChange={(value) => updateParams({ status: value === 'all' ? '' : value })}
        >
          <SelectTrigger className="w-[160px]" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : isError ? (
            <div role="alert" className="text-center py-16 text-sm text-muted-foreground">
              {httpStatus(error) === 403
                ? 'You do not have access to the tenant list.'
                : adminErrorMessage(error, 'The tenant list could not be loaded.')}
            </div>
          ) : !tenants || tenants.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Building2 className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="text-sm">
                {filtered || page > 1 ? 'No tenants match this view.' : 'No tenants yet.'}
              </p>
            </div>
          ) : (
            <Table className={isPlaceholderData ? 'opacity-60' : undefined}>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Projects</TableHead>
                  <TableHead className="text-right">Links</TableHead>
                  <TableHead className="text-right">Identities</TableHead>
                  <TableHead className="text-right">Clicks (30d)</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((tenant) => (
                  <TableRow key={tenant.id} className="relative hover:bg-muted/50">
                    <TableCell className="max-w-[280px]">
                      {/* The ::after stretches this link over the whole row. */}
                      <Link
                        to={`/tenants/${tenant.id}`}
                        state={{ tenantsSearch: searchParams.toString() }}
                        className="block truncate text-sm font-medium after:absolute after:inset-0 hover:underline"
                      >
                        {tenant.email}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">{tenant.name}</p>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant={tenant.status === 'suspended' ? 'destructive' : 'secondary'}
                          className="text-xs"
                        >
                          {tenant.status}
                        </Badge>
                        {tenant.isSuperAdmin && (
                          <Badge variant="outline" className="text-xs">
                            <ShieldCheck className="h-3 w-3" />
                            Super admin
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm">{tenant.projectCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm">{tenant.linkCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm">{tenant.identityCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm">{tenant.clicksLast30d.toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {tenant.lastActivityAt
                        ? formatDistanceToNow(new Date(tenant.lastActivityAt), { addSuffix: true })
                        : 'None'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(tenant.createdAt), 'MMM d, yyyy')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Also shown past the last page, which a stale URL can land on, as the way back. */}
      {meta && (meta.totalPages > 1 || page > 1) && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {Math.max(meta.totalPages, 1)} · {meta.total.toLocaleString()} tenants
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => updateParams({ page: Math.min(page - 1, Math.max(meta.totalPages, 1)) })}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Next page"
              disabled={page >= meta.totalPages}
              onClick={() => updateParams({ page: page + 1 })}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

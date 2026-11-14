import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Building2,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { AdminTenantActivity, AdminTenantSort, AdminTenantStatus } from '@chumbaq/shared';
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
import { toast } from '@/components/ui/use-toast';
import {
  adminErrorMessage,
  httpStatus,
  useAdminTenants,
  useExportAdminTenants,
} from '@/hooks/use-admin-tenants';
import { useAdminPlans } from '@/hooks/use-admin-billing';
import { PLAN_CODE_PATTERN } from '@/lib/billing-view';
import { cn } from '@/lib/utils';
import {
  formatCount,
  formatDay,
  mauCountedFrom,
  nextSort,
  readTenantListParams,
  writeTenantListParams,
  type TenantListParams,
} from '@/lib/usage-format';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function parseStatus(value: string | null): AdminTenantStatus | undefined {
  return value === 'active' || value === 'suspended' ? value : undefined;
}

const ACTIVITY_CHIPS: { value: AdminTenantActivity | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'quiet', label: 'Quiet' },
  { value: 'never_used', label: 'Never used' },
];

function SortableHead({
  column,
  label,
  list,
  onSort,
  className,
  title,
}: {
  column: AdminTenantSort;
  label: string;
  list: TenantListParams;
  onSort: (column: AdminTenantSort) => void;
  className?: string;
  title?: string;
}) {
  const active = list.sort === column;
  const Icon = !active ? ArrowUpDown : list.order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={className}
      title={title}
      aria-sort={active ? (list.order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon className={cn('h-3.5 w-3.5', !active && 'opacity-40')} aria-hidden="true" />
      </button>
    </TableHead>
  );
}

function parsePage(value: string | null): number {
  const page = Number.parseInt(value ?? '', 10);
  return page > 0 ? page : 1;
}

export default function TenantsListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('search') ?? '';
  const status = parseStatus(searchParams.get('status'));
  // Only a well-formed code goes to the API; anything else in a pasted URL is no filter.
  const planParam = searchParams.get('plan') ?? '';
  const plan = PLAN_CODE_PATTERN.test(planParam) ? planParam : undefined;
  const { data: plans } = useAdminPlans();
  const planName = (code: string) => plans?.find((p) => p.code === code)?.name ?? code;
  const page = parsePage(searchParams.get('page'));
  const list = readTenantListParams(searchParams);
  const [searchInput, setSearchInput] = useState(search);
  const exportTenants = useExportAdminTenants();

  /** Sort and activity changes, through the same URL. */
  function updateList(change: Parameters<typeof writeTenantListParams>[1]) {
    setSearchParams((previous) => writeTenantListParams(previous, change));
  }

  /** Writes to the URL, which is the page's only state. Changing a filter resets the page. */
  function updateParams(changes: { search?: string; status?: string; plan?: string; page?: number }, replace = false) {
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
        if (changes.plan !== undefined) {
          if (changes.plan) next.set('plan', changes.plan);
          else next.delete('plan');
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
    plan,
    ...list,
  });
  const tenants = response?.data;
  const meta = response?.meta;
  const filtered = !!search || !!status || !!plan || !!list.activity;
  // Before the roll-up has closed a day, a tenant's 0 means "not counted", not "none".
  const counted = !!meta?.countedThrough;
  // This month is the first active devices are counted in, so the column may be low.
  const mauFirstMonth = mauCountedFrom(meta, meta?.countedThrough);

  const onSort = (column: AdminTenantSort) => updateList(nextSort(list, column));

  const onExport = () => {
    exportTenants.mutate(
      { search: search || undefined, status, plan, ...list },
      {
        onSuccess: (result) => {
          const count = result.rowCount.toLocaleString('en-US');
          toast({
            title: result.truncated
              ? `Exported the first ${count} of more tenants; narrow the filters`
              : `Exported ${count} ${result.rowCount === 1 ? 'tenant' : 'tenants'}`,
          });
        },
        onError: (exportError) => {
          toast({
            title: 'Could not export the tenants list',
            description: adminErrorMessage(exportError, 'Try again in a moment.'),
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Tenants</h1>
          <p className="text-muted-foreground mt-1">Every account on the platform and what it owns.</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button variant="outline" onClick={onExport} disabled={exportTenants.isPending}>
            <Download className="mr-2 h-4 w-4" />
            {exportTenants.isPending ? 'Exporting...' : 'Export CSV'}
          </Button>
          <p className="text-xs text-muted-foreground">
            This search, filter and sort, every page. Each export is recorded in the audit log.
          </p>
        </div>
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
        <Select value={plan ?? 'all'} onValueChange={(value) => updateParams({ plan: value === 'all' ? '' : value })}>
          <SelectTrigger className="w-[160px]" aria-label="Filter by plan">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plans</SelectItem>
            {plans?.map((p) => (
              <SelectItem key={p.code} value={p.code}>
                {p.name}
              </SelectItem>
            ))}
            {plan && !plans?.some((p) => p.code === plan) && <SelectItem value={plan}>{plan}</SelectItem>}
          </SelectContent>
        </Select>
        <div role="group" aria-label="Filter by activity" className="flex flex-wrap gap-1.5">
          {ACTIVITY_CHIPS.map((chip) => {
            const selected = (list.activity ?? null) === chip.value;
            return (
              <Button
                key={chip.label}
                type="button"
                size="sm"
                variant={selected ? 'secondary' : 'ghost'}
                aria-pressed={selected}
                className={cn('rounded-full', selected && 'ring-1 ring-border')}
                onClick={() => updateList({ activity: chip.value })}
              >
                {chip.label}
              </Button>
            );
          })}
        </div>
      </div>
      {meta && (
        <p className="-mt-3 text-xs text-muted-foreground">
          {meta.countedThrough
            ? `Usage counted through ${formatDay(meta.countedThrough)} (UTC days).${
                mauFirstMonth ? ` Monthly active devices: first month counted, ${mauFirstMonth}.` : ''
              } Quiet means no usage in the last 14 counted days.`
            : 'Usage not counted yet.'}
        </p>
      )}

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
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Projects</TableHead>
                  <SortableHead
                    column="mau_this_month"
                    label="Monthly active devices"
                    title={mauFirstMonth ? `First month counted, ${mauFirstMonth}` : undefined}
                    list={list}
                    onSort={onSort}
                    className="text-right"
                  />
                  <SortableHead
                    column="messages_sent_30d"
                    label="Messages (30d)"
                    list={list}
                    onSort={onSort}
                    className="text-right"
                  />
                  <SortableHead column="last_usage_day" label="Last usage" list={list} onSort={onSort} />
                  <SortableHead column="created_at" label="Joined" list={list} onSort={onSort} />
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
                    <TableCell className="whitespace-nowrap text-sm">{planName(tenant.plan)}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {tenant.projectCount.toLocaleString('en-US')}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatCount(counted ? tenant.mauThisMonth : null)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {formatCount(counted ? tenant.messagesSent30d : null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {!counted ? '—' : tenant.lastUsageDay ? formatDay(tenant.lastUsageDay) : 'None'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(tenant.createdAt), 'd MMM yyyy')}
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

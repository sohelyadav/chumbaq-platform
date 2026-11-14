import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import type { AdminBillingPayment, AdminBillingSummary, MoneySplit } from '@chumbaq/shared';
import { AdminQueryError } from '@/components/admin-query-error';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminBillingSummary } from '@/hooks/use-admin-billing';
import { useStaffAuth } from '@/hooks/use-staff-auth';
import { formatPaise } from '@/lib/money';

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const date = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function MoneyCard({ title, money, note }: { title: string; money: MoneySplit; note: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{formatPaise(money.netPaise)}</div>
        <p className="text-xs text-muted-foreground">
          {note}, excluding GST. GST {formatPaise(money.taxPaise)}; with GST {formatPaise(money.grossPaise)}.
        </p>
      </CardContent>
    </Card>
  );
}

function TenantLink({ id, email }: { id: string; email: string }) {
  return (
    <Link to={`/tenants/${id}`} className="break-all text-primary hover:underline">
      {email}
    </Link>
  );
}

function Section({ title, description, empty, children }: { title: string; description?: string; empty: boolean; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className={empty ? undefined : 'p-0'}>
        {empty ? <p className="text-sm text-muted-foreground">None.</p> : <div className="overflow-x-auto">{children}</div>}
      </CardContent>
    </Card>
  );
}

function RevenueTooltip({ active, payload }: TooltipProps<number, string>) {
  const point = payload?.[0]?.payload as ({ month: string } & MoneySplit) | undefined;
  if (!active || !point) return null;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">
      <p className="font-semibold tabular-nums">{formatPaise(point.netPaise)}</p>
      <p className="text-xs text-muted-foreground">
        {point.month}, excluding GST ({formatPaise(point.taxPaise)} GST)
      </p>
    </div>
  );
}

function RevenueChart({ months }: { months: AdminBillingSummary['revenueByMonth'] }) {
  // Rupees for the axis only; the tooltip and table give exact paise.
  const data = months.map((m) => ({ ...m, rupees: Math.floor(m.netPaise / 100) }));
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
          <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} />
          <YAxis
            tickLine={false}
            axisLine={false}
            fontSize={12}
            width={64}
            tickFormatter={(v: number) => `₹${new Intl.NumberFormat('en-IN', { notation: 'compact' }).format(v)}`}
          />
          <Tooltip content={<RevenueTooltip />} cursor={{ className: 'fill-muted' }} />
          <Bar dataKey="rupees" className="fill-primary" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function PaymentsTable({ payments }: { payments: AdminBillingPayment[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Tenant</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Refunded</TableHead>
          <TableHead className="text-right">Kept, excl. GST</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {payments.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="whitespace-nowrap text-sm">{dateTime(p.paidAt)}</TableCell>
            <TableCell className="text-sm">
              <TenantLink id={p.tenantId} email={p.tenantEmail} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatPaise(p.amountPaise)}</TableCell>
            <TableCell className="text-right tabular-nums">{p.refundedPaise ? formatPaise(p.refundedPaise) : '-'}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPaise(p.netPaise)}</TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1">
                <Badge variant={p.status === 'failed' ? 'destructive' : 'secondary'}>{p.status}</Badge>
                {p.orphan && (
                  <Badge variant="outline" title="Charged on a subscription replaced before it was ever the account's own. Refund it in Razorpay.">
                    Orphan charge
                  </Badge>
                )}
              </div>
              {p.failureReason && <p className="mt-1 text-xs text-muted-foreground">{p.failureReason}</p>}
            </TableCell>
            <TableCell className="text-sm">{p.method ?? '-'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function BillingPage() {
  const { profile } = useStaffAuth();
  const enabled = profile?.billingEnabled === true;
  const { data, isLoading, isError, error, refetch } = useAdminBillingSummary(enabled);

  if (!enabled) {
    return (
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Billing</h1>
        <p className="text-muted-foreground">Billing is off on this server.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Billing</h1>
        <p className="mt-1 text-muted-foreground">
          Paying accounts and money received. Amounts exclude GST unless they say otherwise. A comp is not revenue,
          but a comped account that also subscribed is charged, so it counts.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : isError || !data ? (
        <AdminQueryError error={error} subject="billing" onRetry={() => void refetch()} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <MoneyCard title="MRR" money={data.mrr} note="Monthly recurring revenue" />
            <MoneyCard title="ARR" money={data.arr} note="Yearly recurring revenue" />
            <MoneyCard title="Revenue, last 30 days" money={data.revenue30d} note="Received less refunds" />
          </div>
          {data.cancelling > 0 && (
            <p className="-mt-2 text-sm text-muted-foreground">
              {data.cancelling.toLocaleString('en-US')} {data.cancelling === 1 ? 'account ends' : 'accounts end'} at the
              period end, and still count above until then.
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Revenue by month</CardTitle>
              <CardDescription>Received less refunds, excluding GST, by UTC month.</CardDescription>
            </CardHeader>
            <CardContent>
              <RevenueChart months={data.revenueByMonth} />
            </CardContent>
          </Card>

          <Section title="Paying accounts by plan" empty={data.byPlan.length === 0}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                  <TableHead className="text-right">MRR, excl. GST</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byPlan.map((row) => (
                  <TableRow key={row.planCode}>
                    <TableCell>
                      {row.planName} <span className="font-mono text-xs text-muted-foreground">{row.planCode}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.accounts.toLocaleString('en-US')}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPaise(row.mrrNetPaise)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section title="Past due" description="Payments Razorpay is retrying, and subscriptions it halted." empty={data.pastDue.length === 0}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead className="text-right">Days overdue</TableHead>
                  <TableHead>Keeps its plan until</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.pastDue.map((row) => (
                  <TableRow key={row.tenantId}>
                    <TableCell className="text-sm">
                      <TenantLink id={row.tenantId} email={row.email} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.status === 'halted' ? 'destructive' : 'secondary'}>
                        {row.status === 'halted' ? 'Halted' : 'Retrying'}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{date(row.since)}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.daysOverdue}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{row.graceUntil ? date(row.graceUntil) : '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section title="Recent payments" empty={data.recentPayments.length === 0}>
            <PaymentsTable payments={data.recentPayments} />
          </Section>

          <Section title="Recent failed payments" empty={data.recentFailures.length === 0}>
            <PaymentsTable payments={data.recentFailures} />
          </Section>

          <Section title="Over their monthly active devices" description="Nothing is blocked; the owner is emailed." empty={data.overMau.length === 0}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">This month</TableHead>
                  <TableHead className="text-right">Limit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.overMau.map((row) => (
                  <TableRow key={row.tenantId}>
                    <TableCell className="text-sm">
                      <TenantLink id={row.tenantId} email={row.email} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.planCode}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.mau.toLocaleString('en-US')}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.limit.toLocaleString('en-US')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section title="Complimentary plans" empty={data.comped.length === 0}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Until</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Also paying</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.comped.map((row) => (
                  <TableRow key={row.tenantId}>
                    <TableCell className="text-sm">
                      <TenantLink id={row.tenantId} email={row.email} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.planCode}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{row.until ? date(row.until) : 'Until ended'}</TableCell>
                    <TableCell className="max-w-[360px] whitespace-pre-wrap break-words text-sm">{row.reason}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {row.paying ? 'Yes: a subscription charges it' : 'No'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section
            title="Cancels not yet sent"
            description="The worker retries these. A cancel left unsent is a charge the customer did not want."
            empty={data.outboxErrors.length === 0}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Subscription</TableHead>
                  <TableHead className="text-right">Tries</TableHead>
                  <TableHead>Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.outboxErrors.map((row) => (
                  <TableRow key={row.subscriptionId}>
                    <TableCell className="text-sm">
                      <Link to={`/tenants/${row.tenantId}`} className="font-mono text-xs text-primary hover:underline">
                        {row.tenantId}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.subscriptionId}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.attempts}</TableCell>
                    <TableCell className="max-w-[360px] break-words text-sm">{row.error}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}
    </div>
  );
}

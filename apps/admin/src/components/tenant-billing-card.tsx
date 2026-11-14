import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import type { AdminTenantBilling, BillingInvoiceView } from '@chumbaq/shared';
import { AdminActionDialog } from '@/components/admin-action-dialog';
import { AdminQueryError } from '@/components/admin-query-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import {
  useAdminPlans,
  useAdminTenantBilling,
  useCancelSubscription,
  useCompTenant,
  useEndComp,
  useResendInvoice,
} from '@/hooks/use-admin-billing';
import {
  BILLING_STATE_LABELS,
  FREE_PLAN,
  SUBSCRIPTION_STATUS_LABELS,
  intervalLabel,
  safeProviderUrl,
} from '@/lib/billing-view';
import { formatPaise } from '@/lib/money';

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';

/** States in which the account has a subscription giving, or about to give, a plan. */
const SUBSCRIBED_STATES = new Set(['active', 'past_due', 'halted', 'cancelling', 'change_scheduled', 'upgrade_pending']);

/** Statuses staff can cancel: anything that can still charge. */
const CANCELLABLE = new Set(['authenticated', 'active', 'pending', 'halted']);

/** The end of the chosen day in the browser's timezone, as an instant. */
function endOfLocalDay(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

function CompDialog({ tenantId, open, onOpenChange }: { tenantId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: plans } = useAdminPlans();
  const comp = useCompTenant(tenantId);
  const [planCode, setPlanCode] = useState('');
  const [until, setUntil] = useState('');
  const choices = (plans ?? []).filter((plan) => plan.code !== FREE_PLAN && plan.isActive);
  const untilIso = until ? endOfLocalDay(until) : null;
  return (
    <AdminActionDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setPlanCode('');
          setUntil('');
        }
        onOpenChange(next);
      }}
      title="Give a complimentary plan"
      description={<p>The account gets the plan's limits with no payment, until the end date or until you end it.</p>}
      confirmLabel="Give plan"
      valid={planCode !== '' && (until === '' || untilIso !== null)}
      onSubmit={async (reason) => {
        await comp.mutateAsync({ planCode, reason, ...(untilIso ? { until: untilIso } : {}) });
        toast({ title: 'Complimentary plan given' });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="comp-plan">Plan</Label>
        <Select value={planCode} onValueChange={setPlanCode}>
          <SelectTrigger id="comp-plan">
            <SelectValue placeholder="Choose a plan" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((plan) => (
              <SelectItem key={plan.code} value={plan.code}>
                {plan.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="comp-until">Ends on (optional)</Label>
        <Input id="comp-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        <p className="text-xs text-muted-foreground">At the end of that day, your time. Within five years.</p>
      </div>
    </AdminActionDialog>
  );
}

function CancelDialog({
  tenantId,
  billing,
  open,
  onOpenChange,
}: {
  tenantId: string;
  billing: AdminTenantBilling;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cancel = useCancelSubscription(tenantId);
  const [when, setWhen] = useState<'cycle_end' | 'now'>('cycle_end');
  const current = billing.overview.current;
  return (
    <AdminActionDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setWhen(current?.cancelAtPeriodEnd ? 'now' : 'cycle_end');
        onOpenChange(next);
      }}
      title="Cancel the subscription"
      description={
        <p>
          Cancels it at Razorpay. At the period end, the account keeps its plan until {date(current?.currentPeriodEnd ?? null)}.
          Now, it moves to the free plan when Razorpay confirms. Refunds are made in Razorpay.
        </p>
      }
      confirmLabel="Cancel subscription"
      destructive
      onSubmit={async (reason) => {
        await cancel.mutateAsync({ atCycleEnd: when === 'cycle_end', reason });
        toast({ title: 'Subscription cancelled at Razorpay' });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="cancel-when">When</Label>
        <Select value={when} onValueChange={(v) => setWhen(v as 'cycle_end' | 'now')}>
          <SelectTrigger id="cancel-when">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {!current?.cancelAtPeriodEnd && <SelectItem value="cycle_end">At the period end</SelectItem>}
            <SelectItem value="now">Now</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </AdminActionDialog>
  );
}

function InvoicesTable({ invoices, onResend }: { invoices: BillingInvoiceView[]; onResend: (invoice: BillingInvoiceView) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">GST</TableHead>
          <TableHead>Issued</TableHead>
          <TableHead>Paid</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((invoice) => {
          const url = safeProviderUrl(invoice.shortUrl);
          return (
            <TableRow key={invoice.id}>
              <TableCell className="text-sm">
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {invoice.number ?? 'View'}
                  </a>
                ) : (
                  (invoice.number ?? '-')
                )}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{invoice.status}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {invoice.currency === 'INR' ? formatPaise(invoice.amountPaise) : `${invoice.currency} ${invoice.amountPaise}`}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatPaise(invoice.taxPaise)}</TableCell>
              <TableCell className="whitespace-nowrap text-sm">{date(invoice.issuedAt)}</TableCell>
              <TableCell className="whitespace-nowrap text-sm">{date(invoice.paidAt)}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => onResend(invoice)}>
                  Resend
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The tenant's billing, with staff's actions. Shown only while billing is on. */
export function TenantBillingCard({ tenantId }: { tenantId: string }) {
  const { data, isLoading, isError, error, refetch } = useAdminTenantBilling(tenantId, true);
  const endComp = useEndComp(tenantId);
  const resend = useResendInvoice(tenantId);
  const [dialog, setDialog] = useState<'comp' | 'end_comp' | 'cancel' | null>(null);
  const [resending, setResending] = useState<BillingInvoiceView | null>(null);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <Skeleton className="h-24" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <AdminQueryError error={error} subject="the tenant's billing" onRetry={() => void refetch()} />
      </Card>
    );
  }

  const { overview, comp } = data;
  const current = overview.current;
  const canCancel = !!current && CANCELLABLE.has(current.status);
  // The API refuses a comp over these (409); the button says so first.
  const hasSubscription = SUBSCRIBED_STATES.has(overview.state);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="h-4 w-4" />
          Billing
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          {comp ? (
            <Button variant="outline" size="sm" onClick={() => setDialog('end_comp')}>
              End comp
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={hasSubscription} onClick={() => setDialog('comp')}>
              Comp a plan
            </Button>
          )}
          {canCancel && (
            <Button variant="outline" size="sm" onClick={() => setDialog('cancel')}>
              Cancel subscription
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Plan">{overview.effectivePlan.name}</Fact>
          <Fact label="State">{BILLING_STATE_LABELS[overview.state]}</Fact>
          <Fact label="Interval">{current ? intervalLabel(current.interval) : '-'}</Fact>
          <Fact label={current?.cancelAtPeriodEnd ? 'Ends' : 'Next charge'}>
            {current?.currentPeriodEnd ? date(current.currentPeriodEnd) : '-'}
            {current && current.amountPaise ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">{formatPaise(current.amountPaise)}</span>
            ) : null}
          </Fact>
          {overview.next && (
            <Fact label="Next subscription">
              {overview.next.planName}, {intervalLabel(overview.next.interval)}, from {date(overview.next.startAt)} (
              {SUBSCRIPTION_STATUS_LABELS[overview.next.status]})
            </Fact>
          )}
          <Fact label="Monthly active devices">
            {overview.usage.mau.used === null ? 'Not counted yet' : overview.usage.mau.used.toLocaleString('en-US')}
            {overview.usage.mau.limit !== null && ` of ${overview.usage.mau.limit.toLocaleString('en-US')}`}
          </Fact>
          {overview.details && (
            <Fact label="Billed to">
              {overview.details.legalName}
              {overview.details.gstin && <span className="block font-mono text-xs font-normal">{overview.details.gstin}</span>}
            </Fact>
          )}
        </dl>

        {comp && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">
              Complimentary {comp.planCode}, {comp.until ? `until ${date(comp.until)}` : 'until ended'}
            </p>
            <p className="text-muted-foreground">
              Given {date(comp.at)}
              {comp.byEmail ? ` by ${comp.byEmail}` : ''}: {comp.reason}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Subscriptions</h3>
          {data.subscriptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Period end</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Razorpay id</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.subscriptions.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-sm">
                        {s.planName}, {intervalLabel(s.interval)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="secondary">{SUBSCRIPTION_STATUS_LABELS[s.status]}</Badge>
                          {s.cancelAtPeriodEnd && <Badge variant="outline">Ends at period end</Badge>}
                          {s.supersededBy && <Badge variant="outline">Replaced</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatPaise(s.amountPaise)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{date(s.currentPeriodEnd)}</TableCell>
                      <TableCell className="text-sm">{s.method ?? '-'}</TableCell>
                      <TableCell className="font-mono text-xs">{s.providerSubscriptionId}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{date(s.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Invoices</h3>
          {data.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <div className="overflow-x-auto">
              <InvoicesTable invoices={data.invoices} onResend={setResending} />
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Payments</h3>
          {data.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Refunded</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Method</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap text-sm">{date(p.paidAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPaise(p.amountPaise)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.refundedPaise ? formatPaise(p.refundedPaise) : '-'}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={p.status === 'failed' ? 'destructive' : 'secondary'}>{p.status}</Badge>
                          {p.orphan && <Badge variant="outline">Orphan charge</Badge>}
                        </div>
                        {p.failureReason && <p className="mt-1 text-xs text-muted-foreground">{p.failureReason}</p>}
                      </TableCell>
                      <TableCell className="text-sm">{p.method ?? '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>

      <CompDialog tenantId={tenantId} open={dialog === 'comp'} onOpenChange={(open) => setDialog(open ? 'comp' : null)} />
      <AdminActionDialog
        open={dialog === 'end_comp'}
        onOpenChange={(open) => setDialog(open ? 'end_comp' : null)}
        title="End the complimentary plan"
        description={<p>The account goes back to the plan its subscription gives, or the free plan.</p>}
        confirmLabel="End comp"
        destructive
        onSubmit={async (reason) => {
          await endComp.mutateAsync(reason);
          toast({ title: 'Complimentary plan ended' });
        }}
      />
      <CancelDialog tenantId={tenantId} billing={data} open={dialog === 'cancel'} onOpenChange={(open) => setDialog(open ? 'cancel' : null)} />
      <AdminActionDialog
        open={resending !== null}
        onOpenChange={(open) => !open && setResending(null)}
        title="Resend the invoice"
        description={<p>Razorpay emails the invoice's link to the customer again.</p>}
        confirmLabel="Resend"
        onSubmit={async (reason) => {
          if (!resending) return;
          await resend.mutateAsync({ invoiceId: resending.id, reason });
          toast({ title: 'Invoice sent again' });
        }}
      />
    </Card>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import type { BillingInterval, BillingOverview, BillingPlanOption } from '@chumbaq/shared';
import { BillingDetailsForm, billingErrorMessage } from '@/components/billing/billing-details-form';
import { InvoicesTable } from '@/components/billing/invoices-table';
import { IntervalToggle, PlanCards } from '@/components/billing/plan-cards';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/use-toast';
import { useBilling, useBillingEnabled, useCancelBilling, useChangePlan, useSubscribe } from '@/hooks/use-billing';
import { getImpersonation } from '@/lib/auth';
import { BILLING_STATE_LABELS, formatPaise, mauShare } from '@/lib/billing-format';
import {
  beforeCheckout,
  cancelOffer,
  paymentConfirmed,
  POLL_INTERVAL_MS,
  POLL_LIMIT_MS,
  type BeforeCheckout,
} from '@/lib/billing-route';
import { checkoutOptions, loadRazorpayCheckout } from '@/lib/razorpay-checkout';

const count = new Intl.NumberFormat('en-IN');
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

type PlanPick = { plan: BillingPlanOption; interval: BillingInterval; action: 'choose' | 'switch' | 'keep' };
type Payment = { op: 'subscribe' | 'change'; phase: 'processing' | 'received' | 'still'; before: BeforeCheckout };

/** When the plan renews, ends or changes, in one sentence. */
function scheduleLine(o: BillingOverview): string | null {
  const { current, next, comp } = o;
  if (o.state === 'halted' && current?.graceUntil) {
    return `Your payment did not go through. Your plan's limits stay until ${day(current.graceUntil)}.`;
  }
  if (next && next.startAt && (next.status === 'authenticated' || o.state === 'upgrade_pending')) {
    return `Moves to ${next.planName} (${next.interval}) on ${day(next.startAt)}.`;
  }
  if (current?.currentPeriodEnd && current.cancelAtPeriodEnd) {
    return `Ends on ${day(current.currentPeriodEnd)}. After that your account moves to Free.`;
  }
  if (current?.currentPeriodEnd && (current.status === 'active' || current.status === 'pending')) {
    return `Next charge ${formatPaise(current.amountPaise)} on ${day(current.currentPeriodEnd)}.`;
  }
  if (comp) return comp.until ? `Complimentary until ${day(comp.until)}.` : 'Complimentary.';
  return null;
}

function UsageBar({ percent, level }: { percent: number; level: 'ok' | 'near' | 'over' }) {
  const colour = level === 'over' ? 'bg-destructive' : level === 'near' ? 'bg-amber-500' : 'bg-primary';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
      <div className={`h-full ${colour}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function Usage({ o }: { o: BillingOverview }) {
  const { mau, projects, seats } = o.usage;
  const share = mauShare(mau.used, mau.limit);
  let mauText: string;
  if (mau.used === null) mauText = 'Active devices this month: not counted yet.';
  else if (mau.limit === null) mauText = `${count.format(mau.used)} active devices this month (no limit)`;
  else mauText = `${count.format(mau.used)} of ${count.format(mau.limit)} active devices this month`;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm">
          {mauText}
          {mau.countedThrough && <span className="text-muted-foreground"> (counted through {day(mau.countedThrough)})</span>}
        </p>
        {share.percent !== null && <UsageBar percent={share.percent} level={share.level} />}
        {share.level !== 'ok' && (
          <p className="text-xs text-muted-foreground">
            {share.level === 'over' ? "You're over this month's limit." : "You're close to this month's limit."} Nothing is
            blocked and messages keep sending.
          </p>
        )}
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <p>
          Projects: {count.format(projects.used)} of {count.format(projects.limit)}
        </p>
        <p>
          Team members: {count.format(seats.used)} of {seats.limit === null ? 'Unlimited' : count.format(seats.limit)}
        </p>
      </div>
    </div>
  );
}

/**
 * The account's billing: its plan and state, usage against the plan's limits, the
 * plans it can buy, its billing details, cancelling, and invoices.
 *
 * Paying opens Razorpay Checkout on a subscription the server created. Checkout's
 * success callback only starts "Processing payment"; the page then asks the server
 * until the provider's signed webhook has changed the account, and says so.
 */
export default function BillingPage() {
  const impersonating = Boolean(getImpersonation());
  const { billingEnabled, checked } = useBillingEnabled();
  const [payment, setPayment] = useState<Payment | null>(null);
  const billing = useBilling({
    enabled: billingEnabled === true,
    refetchInterval: payment?.phase === 'processing' ? POLL_INTERVAL_MS : false,
  });
  const subscribe = useSubscribe();
  const change = useChangePlan();
  const cancel = useCancelBilling();
  const [chosenInterval, setChosenInterval] = useState<BillingInterval | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [waitingPick, setWaitingPick] = useState<PlanPick | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const o = billing.data;
  const shownInterval: BillingInterval = chosenInterval ?? o?.current?.interval ?? 'monthly';

  // Done once the webhook has landed; "still processing" after the time limit.
  useEffect(() => {
    if (payment?.phase === 'processing' && o && paymentConfirmed(payment.op, o, payment.before)) {
      setPayment({ ...payment, phase: 'received' });
    }
  }, [o, payment]);
  useEffect(() => {
    if (payment?.phase !== 'processing') return;
    pollTimer.current = setTimeout(
      () => setPayment((p) => (p?.phase === 'processing' ? { ...p, phase: 'still' } : p)),
      POLL_LIMIT_MS,
    );
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [payment?.phase]);

  if (impersonating) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold">Not available while viewing as a tenant</h1>
        <p className="mt-2 text-muted-foreground">Billing is shown to staff in the admin app.</p>
      </div>
    );
  }
  if (!checked) return null;
  if (billingEnabled !== true) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold">Not found</h1>
        <p className="mt-2 text-muted-foreground">There is no page here.</p>
        <Link to="/projects" className="mt-4 inline-block text-sm underline underline-offset-4">
          Go to your projects
        </Link>
      </div>
    );
  }

  const start = async (pick: PlanPick) => {
    setBusyPlan(pick.plan.code);
    const op = pick.action === 'choose' ? 'subscribe' : 'change';
    // Confirmation waits for the subscription this Checkout makes, not the account's state.
    const before = beforeCheckout(o);
    try {
      const body = { plan: pick.plan.code, interval: pick.interval };
      const checkout = await (op === 'subscribe' ? subscribe.mutateAsync(body) : change.mutateAsync(body));
      await loadRazorpayCheckout();
      if (!window.Razorpay) throw new Error('Razorpay Checkout did not load. Try again.');
      const razorpay = new window.Razorpay(
        checkoutOptions(
          checkout,
          () => setPayment({ op, phase: 'processing', before }),
          () => {
            void billing.refetch();
          },
        ),
      );
      razorpay.open();
    } catch (err) {
      toast({
        title: 'Could not start the payment',
        description: billingErrorMessage(err, err instanceof Error ? err.message : 'Try again.'),
        variant: 'destructive',
      });
    } finally {
      setBusyPlan(null);
    }
  };

  const onPick = (plan: BillingPlanOption, action: PlanPick['action']) => {
    const pick = { plan, interval: shownInterval, action };
    if (!o?.details) {
      setWaitingPick(pick);
      setEditingDetails(true);
      return;
    }
    void start(pick);
  };

  const onDetailsSaved = () => {
    setEditingDetails(false);
    toast({ title: 'Billing details saved' });
    const pick = waitingPick;
    setWaitingPick(null);
    if (pick) void start(pick);
  };

  const doCancel = async () => {
    try {
      await cancel.mutateAsync();
      setConfirmCancel(false);
      toast({ title: offer === 'cancel_now' ? 'Your plan is cancelled' : 'Your plan will end at the end of this period' });
    } catch (err) {
      toast({
        title: 'Could not cancel',
        description: billingErrorMessage(err, 'Try again.'),
        variant: 'destructive',
      });
    }
  };

  const offer = o ? cancelOffer(o) : 'none';
  const periodEnd = o?.current?.currentPeriodEnd ? day(o.current.currentPeriodEnd) : null;
  const scheduled = o?.next;
  const keeping =
    scheduled && o?.current && scheduled.planCode === o.current.planCode && scheduled.interval === o.current.interval;

  return (
    <div className="container mx-auto max-w-5xl space-y-8 px-4 py-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/projects" aria-label="Back to your projects">
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
          <p className="text-muted-foreground">Your plan, usage and invoices, for every project billed to you.</p>
        </div>
      </div>

      {billing.isLoading && <div className="h-40 animate-pulse rounded bg-muted" />}
      {billing.isError && (
        <Card>
          <CardContent className="p-6 text-center text-destructive">
            {billingErrorMessage(billing.error, 'Could not load billing.')}
          </CardContent>
        </Card>
      )}

      {payment && (
        <div
          role="status"
          className={`rounded-md border px-4 py-3 text-sm ${payment.phase === 'received' ? 'border-primary' : 'bg-muted/40'}`}
        >
          {payment.phase === 'processing' && 'Processing payment...'}
          {payment.phase === 'received' && 'Payment received. Your plan is updated.'}
          {payment.phase === 'still' && 'Still processing. This page will update when Razorpay confirms.'}
        </div>
      )}

      {o && (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-2xl">{o.effectivePlan.name}</CardTitle>
                <Badge variant={o.state === 'halted' || o.state === 'past_due' ? 'destructive' : 'secondary'}>
                  {BILLING_STATE_LABELS[o.state]}
                </Badge>
              </div>
              {scheduleLine(o) && <CardDescription>{scheduleLine(o)}</CardDescription>}
              {o.state === 'past_due' && (
                <CardDescription>
                  Your last payment is being retried. Update your payment method from Razorpay's email.
                </CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <Usage o={o} />
            </CardContent>
          </Card>

          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-xl font-semibold">Plans</h2>
              <IntervalToggle value={shownInterval} onChange={setChosenInterval} />
            </div>
            <PlanCards overview={o} interval={shownInterval} busyPlan={busyPlan} onPick={onPick} />
            <p className="text-sm text-muted-foreground">
              Prices exclude GST, which is added at checkout. Need more than the largest plan? Contact us.
            </p>
            {offer !== 'none' && (
              <Button variant="outline" onClick={() => setConfirmCancel(true)}>
                Cancel plan
              </Button>
            )}
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Billing details</CardTitle>
              <CardDescription>Printed on your GST invoices.</CardDescription>
            </CardHeader>
            <CardContent>
              {editingDetails || !o.details ? (
                <BillingDetailsForm
                  initial={o.details}
                  onSaved={onDetailsSaved}
                  onCancel={
                    o.details || waitingPick
                      ? () => {
                          setEditingDetails(false);
                          setWaitingPick(null);
                        }
                      : undefined
                  }
                />
              ) : (
                <div className="space-y-1 text-sm">
                  <p className="font-medium">{o.details.legalName}</p>
                  {o.details.gstin && <p className="font-mono text-xs">GSTIN {o.details.gstin}</p>}
                  <p className="text-muted-foreground">
                    {[o.details.address.line1, o.details.address.line2, o.details.address.city, o.details.address.postalCode]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  <Button variant="link" className="h-auto px-0" onClick={() => setEditingDetails(true)}>
                    Edit
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Invoices</CardTitle>
            </CardHeader>
            <CardContent>
              <InvoicesTable />
            </CardContent>
          </Card>

          <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Cancel your plan?</DialogTitle>
                <DialogDescription>
                  {offer === 'cancel_now'
                    ? 'Your plan ends now and the failed payment is not tried again.'
                    : offer === 'drop_change' && scheduled
                    ? `${keeping ? 'Keeping your plan is undone' : `Your scheduled change to ${scheduled.planName} is dropped`} and your plan ends ${periodEnd ? `on ${periodEnd}` : 'at the end of this period'}.`
                    : periodEnd
                      ? `Your plan stays until ${periodEnd}.`
                      : 'Your plan stays until the end of this period.'}{' '}
                  {offer === 'cancel_now' ? 'Your account moves to Free' : 'After that your account moves to Free'}; nothing
                  is deleted.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                  Keep it
                </Button>
                <Button variant="destructive" disabled={cancel.isPending} onClick={() => void doCancel()}>
                  {cancel.isPending ? 'Cancelling...' : 'Cancel plan'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

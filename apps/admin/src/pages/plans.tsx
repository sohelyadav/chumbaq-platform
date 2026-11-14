import { useEffect, useState } from 'react';
import { Info, Pencil, Plus } from 'lucide-react';
import type { AdminPlan, AdminPlanPrice, BillingInterval } from '@chumbaq/shared';
import { AdminActionDialog } from '@/components/admin-action-dialog';
import { AdminQueryError } from '@/components/admin-query-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import { useAddPrice, useAdminPlans, useCreatePlan, useRetirePrice, useUpdatePlan } from '@/hooks/use-admin-billing';
import {
  FREE_PLAN,
  PLAN_CODE_PATTERN,
  RAZORPAY_PLAN_ID_PATTERN,
  intervalLabel,
  limitLabel,
  parseLimit,
  projectLimitLabel,
} from '@/lib/billing-view';
import { formatPaise, parseRupees, priceWithGst } from '@/lib/money';

/** The API's ranges. */
const PROJECT_LIMIT_MAX = 1000;
const SORT_ORDER_MAX = 1000;
const PLAN_REASON_MIN = 3;

function seatLabel(plan: AdminPlan): string {
  // On the free plan a null seat limit is the install's default; elsewhere it is unlimited.
  if (plan.seatLimit === null && plan.code === FREE_PLAN) {
    return plan.defaults.seatLimit === null ? 'Default (no limit)' : `Default (${plan.defaults.seatLimit})`;
  }
  return limitLabel(plan.seatLimit);
}

// ------------------------------------------------------------------ plan form

interface PlanForm {
  code: string;
  name: string;
  mauLimit: string;
  projectLimit: string;
  seatLimit: string;
  sortOrder: string;
  isActive: boolean;
}

const asText = (n: number | null) => (n === null ? '' : String(n));

function formOf(plan: AdminPlan | null): PlanForm {
  return {
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    mauLimit: asText(plan?.mauLimit ?? null),
    projectLimit: asText(plan?.projectLimit ?? null),
    seatLimit: asText(plan?.seatLimit ?? null),
    sortOrder: String(plan?.sortOrder ?? 10),
    isActive: plan?.isActive ?? true,
  };
}

function PlanDialog({
  plan,
  open,
  onOpenChange,
}: {
  /** Null to create one. */
  plan: AdminPlan | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<PlanForm>(formOf(plan));
  const create = useCreatePlan();
  const update = useUpdatePlan(plan?.code ?? '');
  useEffect(() => {
    if (open) setForm(formOf(plan));
  }, [open, plan]);

  const mauLimit = parseLimit(form.mauLimit);
  const projectLimit = parseLimit(form.projectLimit, PROJECT_LIMIT_MAX);
  const seatLimit = parseLimit(form.seatLimit);
  const sortOrder = /^\d+$/.test(form.sortOrder.trim()) ? Number(form.sortOrder.trim()) : NaN;
  const errors = [
    !plan && !PLAN_CODE_PATTERN.test(form.code) && 'Code: 2 to 32 lower-case letters, digits or _, starting with a letter.',
    !form.name.trim() && 'Name is required.',
    mauLimit === undefined && 'Monthly active devices must be a whole number of at least 1, or blank for unlimited.',
    projectLimit === undefined && `Projects must be 1 to ${PROJECT_LIMIT_MAX}, or blank for the default.`,
    seatLimit === undefined && 'Team members must be a whole number of at least 1, or blank.',
    !(sortOrder >= 0 && sortOrder <= SORT_ORDER_MAX) && `Order must be 0 to ${SORT_ORDER_MAX}.`,
  ].filter(Boolean) as string[];
  const set = (field: keyof PlanForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(reason: string) {
    const values = {
      name: form.name.trim(),
      mauLimit: mauLimit ?? null,
      projectLimit: projectLimit ?? null,
      seatLimit: seatLimit ?? null,
      sortOrder,
    };
    if (!plan) {
      await create.mutateAsync({ code: form.code, ...values, reason });
      toast({ title: `Plan ${form.code} created` });
      return;
    }
    // Only what changed: the API records before and after of each field sent.
    const change: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== plan[key as keyof typeof values]) change[key] = value;
    }
    if (form.isActive !== plan.isActive) change.isActive = form.isActive;
    await update.mutateAsync({ ...change, reason });
    toast({ title: `Plan ${plan.code} saved` });
  }

  return (
    <AdminActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={plan ? `Edit ${plan.name}` : 'New plan'}
      description="Limits apply to accounts on this plan while billing is on. Blank means no limit (projects: the server's default)."
      confirmLabel={plan ? 'Save' : 'Create plan'}
      reasonMin={PLAN_REASON_MIN}
      valid={errors.length === 0}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="plan-code">Code</Label>
          <Input id="plan-code" value={form.code} onChange={set('code')} disabled={!!plan} autoComplete="off" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-name">Name</Label>
          <Input id="plan-name" value={form.name} onChange={set('name')} maxLength={60} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-mau">Monthly active devices</Label>
          <Input id="plan-mau" inputMode="numeric" value={form.mauLimit} onChange={set('mauLimit')} placeholder="Unlimited" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-projects">Projects</Label>
          <Input
            id="plan-projects"
            inputMode="numeric"
            value={form.projectLimit}
            onChange={set('projectLimit')}
            placeholder={plan ? projectLimitLabel(null, plan.defaults.projectLimit) : 'Default'}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-seats">Team members</Label>
          <Input id="plan-seats" inputMode="numeric" value={form.seatLimit} onChange={set('seatLimit')} placeholder="Unlimited" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-order">Order</Label>
          <Input id="plan-order" inputMode="numeric" value={form.sortOrder} onChange={set('sortOrder')} />
        </div>
      </div>
      {plan && plan.code !== FREE_PLAN && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
          />
          Offered to customers
        </label>
      )}
      {errors.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </AdminActionDialog>
  );
}

// ------------------------------------------------------------------ prices

function AddPriceDialog({
  plan,
  interval,
  open,
  onOpenChange,
}: {
  plan: AdminPlan;
  interval: BillingInterval;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [price, setPrice] = useState('');
  const [razorpayPlanId, setRazorpayPlanId] = useState('');
  const add = useAddPrice(plan.code);
  useEffect(() => {
    if (open) {
      setPrice('');
      setRazorpayPlanId('');
    }
  }, [open]);

  const pricePaise = parseRupees(price);
  const charged = pricePaise === null ? null : priceWithGst(pricePaise);
  const idValid = RAZORPAY_PLAN_ID_PATTERN.test(razorpayPlanId.trim());
  const per = interval === 'monthly' ? 'month' : 'year';

  return (
    <AdminActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${intervalLabel(interval)} price for ${plan.name}`}
      description={
        <p>
          The new price replaces the current one for new subscriptions. Accounts already subscribed keep the price
          they signed up at.
        </p>
      }
      confirmLabel="Add price"
      reasonMin={PLAN_REASON_MIN}
      valid={pricePaise !== null && pricePaise > 0 && idValid}
      onSubmit={async (reason) => {
        await add.mutateAsync({ interval, pricePaise: pricePaise as number, razorpayPlanId: razorpayPlanId.trim(), reason });
        toast({ title: `${intervalLabel(interval)} price added to ${plan.name}` });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="price-amount">Price a {per}, excluding GST (₹)</Label>
        <Input id="price-amount" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1,499.00" />
        {price.trim() !== '' && pricePaise === null && (
          <p className="text-xs text-destructive">Enter rupees with at most two decimals, for example 1,499.50.</p>
        )}
      </div>
      {charged && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm" aria-live="polite">
          Razorpay plan must charge <span className="font-semibold tabular-nums">{formatPaise(charged.amountPaise)}</span>{' '}
          every 1 {per} ({formatPaise(charged.taxPaise)} GST), in INR. Create it in Razorpay first, then paste its id.
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="price-plan-id">Razorpay plan id</Label>
        <Input
          id="price-plan-id"
          value={razorpayPlanId}
          onChange={(e) => setRazorpayPlanId(e.target.value)}
          placeholder="plan_..."
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">Checked against Razorpay: amount, currency and period must match.</p>
      </div>
    </AdminActionDialog>
  );
}

function PriceRows({ plan, interval, onRetire }: { plan: AdminPlan; interval: BillingInterval; onRetire: (p: AdminPlanPrice) => void }) {
  const prices = plan.prices.filter((p) => p.interval === interval);
  if (prices.length === 0) {
    return <p className="text-sm text-muted-foreground">No {interval} price yet.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Price (excl. GST)</TableHead>
          <TableHead>GST</TableHead>
          <TableHead>Charged</TableHead>
          <TableHead>Razorpay plan</TableHead>
          <TableHead className="text-right">Subscribers</TableHead>
          <TableHead>Added</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {prices.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="tabular-nums">
              {formatPaise(p.pricePaise)}{' '}
              {p.isCurrent ? <Badge variant="secondary">Current</Badge> : <Badge variant="outline">Earlier</Badge>}
            </TableCell>
            <TableCell className="tabular-nums">{formatPaise(p.taxPaise)}</TableCell>
            <TableCell className="tabular-nums">{formatPaise(p.amountPaise)}</TableCell>
            <TableCell className="font-mono text-xs">{p.razorpayPlanId}</TableCell>
            <TableCell className="text-right tabular-nums">{p.subscribers.toLocaleString('en-US')}</TableCell>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
              {new Date(p.createdAt).toLocaleDateString('en-GB')}
            </TableCell>
            <TableCell className="text-right">
              {p.isCurrent && plan.billingEnabled && (
                <Button variant="ghost" size="sm" onClick={() => onRetire(p)}>
                  Retire
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PlanCard({ plan }: { plan: AdminPlan }) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<BillingInterval | null>(null);
  const [retiring, setRetiring] = useState<AdminPlanPrice | null>(null);
  const retire = useRetirePrice(plan.code);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {plan.name}
            <span className="font-mono text-xs font-normal text-muted-foreground">{plan.code}</span>
            {!plan.isActive && <Badge variant="outline">Not offered</Badge>}
          </CardTitle>
          <CardDescription className="mt-1">
            {limitLabel(plan.mauLimit)} monthly active devices · {projectLimitLabel(plan.projectLimit, plan.defaults.projectLimit)}{' '}
            projects · {seatLabel(plan)} team members · order {plan.sortOrder}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
      </CardHeader>
      {plan.code !== FREE_PLAN && (
        <CardContent className="space-y-5">
          {(['monthly', 'yearly'] as const).map((interval) => (
            <div key={interval} className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{intervalLabel(interval)}</h3>
                {plan.billingEnabled && (
                  <Button variant="ghost" size="sm" onClick={() => setAdding(interval)}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add price
                  </Button>
                )}
              </div>
              <div className="overflow-x-auto">
                <PriceRows plan={plan} interval={interval} onRetire={setRetiring} />
              </div>
            </div>
          ))}
        </CardContent>
      )}
      <PlanDialog plan={plan} open={editing} onOpenChange={setEditing} />
      {adding && <AddPriceDialog plan={plan} interval={adding} open onOpenChange={(open) => !open && setAdding(null)} />}
      <AdminActionDialog
        open={retiring !== null}
        onOpenChange={(open) => !open && setRetiring(null)}
        title="Retire this price"
        description={
          <p>
            New customers can no longer subscribe at {retiring ? formatPaise(retiring.pricePaise) : ''}. The{' '}
            {retiring?.subscribers ?? 0} accounts on it keep it. Without a current price this interval cannot be bought.
          </p>
        }
        confirmLabel="Retire price"
        destructive
        reasonMin={PLAN_REASON_MIN}
        onSubmit={async (reason) => {
          if (!retiring) return;
          await retire.mutateAsync({ priceId: retiring.id, reason });
          toast({ title: 'Price retired' });
        }}
      />
    </Card>
  );
}

export default function PlansPage() {
  const { data: plans, isLoading, isError, error, refetch } = useAdminPlans();
  const [creating, setCreating] = useState(false);
  const billingEnabled = plans?.find((plan) => plan.code === FREE_PLAN)?.billingEnabled ?? false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Plans</h1>
          <p className="mt-1 text-muted-foreground">Limits and prices. Prices exclude GST; Razorpay charges them with it.</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New plan
        </Button>
      </div>

      {plans && !billingEnabled && (
        <Card className="border-amber-500/40">
          <CardContent className="flex items-start gap-2 p-4 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p>Billing is off on this server. Limits here take effect when it is on.</p>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : isError ? (
        <AdminQueryError error={error} onRetry={() => void refetch()} subject="the plans" />
      ) : (
        <div className="space-y-4">
          {plans?.map((plan) => (
            <PlanCard key={plan.code} plan={plan} />
          ))}
        </div>
      )}

      <PlanDialog plan={null} open={creating} onOpenChange={setCreating} />
    </div>
  );
}

import type { BillingInterval, BillingOverview, BillingPlanOption } from '@chumbaq/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPaise, hasTax, priceLine } from '@/lib/billing-format';
import { planAction, type PlanAction } from '@/lib/billing-route';

const BUTTON_LABEL: Partial<Record<PlanAction, string>> = {
  choose: 'Choose',
  switch: 'Switch',
  keep: 'Keep my plan',
};

const count = new Intl.NumberFormat('en-IN');

function limitLine(value: number | null, noun: string, unlimited = 'Unlimited'): string {
  return value === null ? `${unlimited} ${noun}` : `${count.format(value)} ${noun}`;
}

/** Monthly or yearly, as two buttons that say which is chosen. */
export function IntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (interval: BillingInterval) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Billing period" className="inline-flex rounded-md border p-0.5">
      {(['monthly', 'yearly'] as const).map((interval) => (
        <button
          key={interval}
          type="button"
          role="radio"
          aria-checked={value === interval}
          onClick={() => onChange(interval)}
          className={`rounded px-3 py-1 text-sm transition-colors ${
            value === interval ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {interval === 'monthly' ? 'Monthly' : 'Yearly'}
        </button>
      ))}
    </div>
  );
}

/**
 * The plans, for the interval shown. What each card offers comes from `planAction`;
 * the price is the server's, shown excluding tax with the tax beside it, or alone
 * when it carries none.
 */
export function PlanCards({
  overview,
  interval,
  busyPlan,
  onPick,
}: {
  overview: BillingOverview;
  interval: BillingInterval;
  /** The plan whose button was pressed, while its request runs. */
  busyPlan: string | null;
  onPick: (plan: BillingPlanOption, action: 'choose' | 'switch' | 'keep') => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {overview.plans.map((plan) => {
        const action = planAction(plan, interval, overview);
        const price = plan[interval];
        const label = BUTTON_LABEL[action];
        return (
          <Card key={plan.code} className={action === 'current' ? 'border-primary' : undefined}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>{plan.name}</CardTitle>
                {action === 'current' && <Badge>Current plan</Badge>}
                {action === 'coming_soon' && <Badge variant="secondary">Coming soon</Badge>}
              </div>
              <CardDescription>
                {price ? (
                  <>
                    <span className="text-base font-semibold text-foreground">{priceLine(price)}</span>
                    {hasTax(price) && (
                      <>
                        <br />
                        <span className="text-xs">{formatPaise(price.amountPaise)} charged including GST</span>
                      </>
                    )}
                  </>
                ) : plan.code === 'free' ? (
                  <span className="text-base font-semibold text-foreground">{formatPaise(0)}</span>
                ) : (
                  'Not available for this period yet'
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm text-muted-foreground">
                <li>{limitLine(plan.mauLimit, 'active devices a month')}</li>
                <li>
                  {plan.projectLimit === null
                    ? 'Projects up to the standard limit'
                    : limitLine(plan.projectLimit, plan.projectLimit === 1 ? 'project' : 'projects')}
                </li>
                <li>
                  {plan.seatLimit === null
                    ? 'Unlimited team members'
                    : limitLine(plan.seatLimit, plan.seatLimit === 1 ? 'team member' : 'team members')}
                </li>
              </ul>
            </CardContent>
            {label && (
              <CardFooter>
                <Button
                  className="w-full"
                  variant={action === 'switch' ? 'outline' : 'default'}
                  disabled={busyPlan !== null}
                  onClick={() => onPick(plan, action as 'choose' | 'switch' | 'keep')}
                >
                  {busyPlan === plan.code ? 'Starting...' : label}
                </Button>
              </CardFooter>
            )}
          </Card>
        );
      })}
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import type { BillingDetails } from '@chumbaq/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectContent, SelectItem, SelectRoot as Select, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSaveBillingDetails } from '@/hooks/use-billing';
import { GST_STATES } from '@/lib/gst-states';

/** The API's own words: one message, or the validation pipe's list. */
export function billingErrorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  if (typeof message === 'string' && message) return message;
  if (Array.isArray(message) && message.length) return message.join('. ');
  return fallback;
}

/**
 * The details shown on invoices: legal name, optional GSTIN, billing address and
 * state (the place of supply when prices carry GST, `taxed`). The server checks everything again, including that a
 * GSTIN belongs to the chosen state, and its message is shown as it is. Once the
 * account has subscribed the GSTIN is shown but not editable (`gstinLocked`).
 */
export function BillingDetailsForm({
  initial,
  taxed,
  onSaved,
  onCancel,
}: {
  initial: BillingDetails | null;
  /** Whether prices on offer carry GST; without it the copy never mentions GST invoices. */
  taxed: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const save = useSaveBillingDetails();
  const [legalName, setLegalName] = useState(initial?.legalName ?? '');
  const [gstin, setGstin] = useState(initial?.gstin ?? '');
  const [line1, setLine1] = useState(initial?.address.line1 ?? '');
  const [line2, setLine2] = useState(initial?.address.line2 ?? '');
  const [city, setCity] = useState(initial?.address.city ?? '');
  const [postalCode, setPostalCode] = useState(initial?.address.postalCode ?? '');
  const [stateCode, setStateCode] = useState(initial?.stateCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const gstinLocked = initial?.gstinLocked === true;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!stateCode) {
      setError('Choose your state.');
      return;
    }
    try {
      await save.mutateAsync({
        legalName,
        ...(gstin.trim() ? { gstin: gstin.trim() } : {}),
        address: {
          line1,
          ...(line2.trim() ? { line2 } : {}),
          city,
          postalCode: postalCode.trim(),
          country: 'IN',
        },
        stateCode,
      });
      onSaved();
    } catch (err) {
      setError(billingErrorMessage(err, 'Could not save your billing details. Try again.'));
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="billing-legal-name">Legal name</Label>
        <Input
          id="billing-legal-name"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          autoComplete="organization"
          required
          maxLength={200}
        />
        <p className="text-xs text-muted-foreground">As it should appear on your invoices.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="billing-gstin">{taxed ? 'GSTIN (optional)' : 'GSTIN (optional, for your records)'}</Label>
        <Input
          id="billing-gstin"
          value={gstin}
          onChange={(e) => setGstin(e.target.value.toUpperCase())}
          maxLength={15}
          spellCheck={false}
          autoCapitalize="characters"
          className="font-mono"
          disabled={gstinLocked}
          aria-describedby={gstinLocked ? 'billing-gstin-locked' : undefined}
        />
        {gstinLocked && (
          <p id="billing-gstin-locked" className="text-xs text-muted-foreground">
            Razorpay keeps the GSTIN you subscribed with, so it can't be changed here. Contact support to change it.
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="billing-line1">Address</Label>
        <Input
          id="billing-line1"
          value={line1}
          onChange={(e) => setLine1(e.target.value)}
          autoComplete="address-line1"
          required
          maxLength={200}
        />
        <Input
          aria-label="Address line 2 (optional)"
          placeholder="Line 2 (optional)"
          value={line2}
          onChange={(e) => setLine2(e.target.value)}
          autoComplete="address-line2"
          maxLength={200}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="billing-city">City</Label>
          <Input
            id="billing-city"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            autoComplete="address-level2"
            required
            maxLength={100}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="billing-pin">PIN code</Label>
          <Input
            id="billing-pin"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            autoComplete="postal-code"
            inputMode="numeric"
            required
            maxLength={6}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="billing-state">{taxed ? 'State' : 'Your state'}</Label>
        <Select value={stateCode} onValueChange={setStateCode}>
          <SelectTrigger id="billing-state" className="w-full">
            <SelectValue placeholder="Choose your state" />
          </SelectTrigger>
          <SelectContent>
            {GST_STATES.map((s) => (
              <SelectItem key={s.code} value={s.code}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {taxed && 'The place of supply for GST. '}Billing is in India only for now.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving...' : 'Save details'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { adminErrorMessage } from '@/hooks/use-admin-tenants';

const REASON_MAX = 500;

/**
 * A staff action with a reason for the audit log: the fields the action needs
 * (`children`), the reason, and the server's refusal shown in place. A 403 asking for
 * a fresh sign-in is answered by the API client's re-authentication dialog before the
 * request is sent again, so it never shows here.
 */
export function AdminActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  reasonMin = 10,
  valid = true,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** The API's minimum: 10 for actions on a tenant, 3 for plans. */
  reasonMin?: number;
  /** Whether the action's own fields are ready. */
  valid?: boolean;
  onSubmit: (reason: string) => Promise<void>;
  children?: ReactNode;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // State only updates on the next render, so two quick clicks would both see `false`.
  const inFlight = useRef(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  const length = reason.trim().length;
  const canSubmit = valid && length >= reasonMin && length <= REASON_MAX && !submitting;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      onOpenChange(false);
    } catch (err) {
      setError(adminErrorMessage(err, 'That did not work. Nothing was changed.'));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && (
              <DialogDescription asChild>
                <div className="space-y-2">{description}</div>
              </DialogDescription>
            )}
          </DialogHeader>

          {children}

          <div className="grid gap-2">
            <Label htmlFor={`${id}-reason`}>Reason</Label>
            <Textarea
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={submitting}
              aria-describedby={`${id}-reason-count`}
            />
            <p
              id={`${id}-reason-count`}
              className={`text-xs ${length > REASON_MAX ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {length}/{REASON_MAX} characters, at least {reasonMin}. Recorded in the audit log.
            </p>
          </div>

          {error && (
            <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={!canSubmit}>
              {submitting ? 'Working...' : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

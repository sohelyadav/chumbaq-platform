import { useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { useCancelStaffLink, useStaffLinkPending } from '@/hooks/use-staff-link';
import { CANCEL_SUPPORT_LINK_PATH } from '@/lib/staff-link';

/**
 * Support issued a password reset link for this account. If the person reading this did
 * not ask for it, someone else may be about to take the account, so it sits on every
 * page with its Cancel button until the link is gone.
 */
export function StaffLinkBanner() {
  const { pathname } = useLocation();
  const { pending } = useStaffLinkPending();
  const cancel = useCancelStaffLink();

  // The cancel page says the same thing with its own button.
  if (!pending || pathname === CANCEL_SUPPORT_LINK_PATH) return null;

  const onCancel = () =>
    cancel.mutate(undefined, {
      onSuccess: () => toast({ title: 'Link cancelled', description: 'Your password was not changed.' }),
      onError: () =>
        toast({ title: 'Could not cancel', description: 'Try again, or contact support.', variant: 'destructive' }),
    });

  return (
    <div className="px-4 pt-4 lg:px-6">
      <div
        role="alert"
        className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="font-medium">Support issued a link to reset your password.</p>
            <p className="text-muted-foreground">
              If you did not ask for it, cancel it now and contact support.
            </p>
          </div>
        </div>
        <Button variant="destructive" disabled={cancel.isPending} onClick={onCancel}>
          {cancel.isPending ? 'Cancelling...' : 'Cancel'}
        </Button>
      </div>
    </div>
  );
}

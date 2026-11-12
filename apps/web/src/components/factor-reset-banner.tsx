import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import type { AccountFactorResetState } from '@chumbaq/shared';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { apiDelete, apiGet } from '@/lib/api';
import { getImpersonation } from '@/lib/auth';
import {
  clearFactorResetPending,
  isFactorResetPending,
  subscribeFactorResetPending,
} from '@/lib/factor-reset-pending';
import { ACTIVITY_QUERY_KEY, formatWhen } from '@/lib/sessions';

const QUERY_KEY = ['factor-reset'];

/**
 * Support has been asked to remove this account's second factors. If the person reading
 * this did not ask, this is where they stop it, so it sits above everything else.
 */
export function FactorResetBanner() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiGet<AccountFactorResetState>('/api/auth/factor-reset'),
    enabled: !getImpersonation(),
  });
  const cancel = useMutation({
    mutationFn: () => apiDelete<void>('/api/auth/factor-reset'),
    onSuccess: () => toast({ title: 'Cancelled', description: 'Your second factors stay as they are.' }),
    onError: () =>
      toast({
        title: 'Could not cancel',
        description: 'Try again, or contact support.',
        variant: 'destructive',
      }),
    // A 404 means it was already cancelled or has happened, so read the state again either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
    },
  });

  const pending = data?.pending;
  // Read from the API, so the note from a sign-in can go once nothing is waiting.
  useEffect(() => {
    if (data && !data.pending) clearFactorResetPending();
  }, [data]);
  if (!pending) return null;

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="space-y-1">
          <p className="font-medium">
            Support will remove your passkeys, authenticator app and recovery codes on{' '}
            {formatWhen(pending.executeAfter)}.
          </p>
          <p className="text-muted-foreground">
            This was requested because your second factors were reported lost. If you did not ask for this,
            cancel it and contact support.
          </p>
        </div>
      </div>
      <Button variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
        {cancel.isPending ? 'Cancelling...' : 'Cancel'}
      </Button>
    </div>
  );
}

/**
 * On every page after a sign-in that could not cancel a waiting reset, until the API
 * says nothing is waiting. Settings shows the banner anyway, so not twice there.
 */
export function FactorResetPendingBanner() {
  const noted = useSyncExternalStore(subscribeFactorResetPending, isFactorResetPending);
  const { pathname } = useLocation();
  if (!noted || pathname === '/settings') return null;
  return (
    <div className="px-4 pt-4 lg:px-6">
      <FactorResetBanner />
    </div>
  );
}

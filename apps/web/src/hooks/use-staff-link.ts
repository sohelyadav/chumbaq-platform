import { useEffect, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CancelStaffLinkResponse, ProfileStaffLink } from '@chumbaq/shared';
import { apiGet, apiPost } from '@/lib/api';
import { getImpersonation } from '@/lib/auth';
import { ACTIVITY_QUERY_KEY } from '@/lib/sessions';
import { clearStaffLinkPending, isStaffLinkPending, subscribeStaffLinkPending } from '@/lib/staff-link';

const QUERY_KEY = ['staff-link-pending'];

/**
 * Whether a password reset link support issued is live for this account. From
 * `/auth/me`, read again when the tab regains focus, since the notice arrives while
 * the dashboard sits open in another tab. A sign-in whose void failed shows it at once.
 * Pass `enabled` false until there is a session to ask with.
 */
export function useStaffLinkPending(enabled = true): { pending: boolean; checked: boolean } {
  const noted = useSyncExternalStore(subscribeStaffLinkPending, isStaffLinkPending);
  const { data, isSuccess } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiGet<ProfileStaffLink>('/api/auth/me'),
    enabled: enabled && !getImpersonation(),
    refetchOnWindowFocus: true,
  });
  // The API is the truth, so the note from a sign-in goes once it says nothing is live.
  useEffect(() => {
    if (data && !data.staffLinkPending) clearStaffLinkPending();
  }, [data]);
  if (getImpersonation()) return { pending: false, checked: true };
  return { pending: Boolean(data?.staffLinkPending) || (!data && noted), checked: isSuccess };
}

/**
 * Needs a recent sign-in: the API answers an older one with 403, and the API client
 * then shows the re-authentication dialog and sends this again.
 */
export function useCancelStaffLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<CancelStaffLinkResponse>('/api/auth/staff-reset-link/cancel'),
    onSuccess: () => clearStaffLinkPending(),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
    },
  });
}

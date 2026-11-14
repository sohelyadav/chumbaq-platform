import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BillingCheckout,
  BillingDetails,
  BillingInvoiceView,
  BillingOverview,
  ProfileBilling,
} from '@chumbaq/shared';
import { apiGet, apiPost, apiPut } from '@/lib/api';
import { getImpersonation } from '@/lib/auth';

export const BILLING_QUERY_KEY = ['billing'];

/**
 * Whether this install takes payments, from `/auth/me`. Not from the signed-in user
 * object, which a sign-in response fills without it. Never asked while viewing as a
 * tenant: the API says false then anyway.
 */
export function useBillingEnabled(enabled = true): { billingEnabled: boolean | undefined; checked: boolean } {
  const impersonating = Boolean(getImpersonation());
  const { data, isSuccess, isError } = useQuery({
    queryKey: ['auth-me', 'billing-enabled'],
    queryFn: () => apiGet<ProfileBilling>('/api/auth/me'),
    enabled: enabled && !impersonating,
    staleTime: 5 * 60_000,
  });
  if (impersonating) return { billingEnabled: false, checked: true };
  return { billingEnabled: data?.billingEnabled, checked: isSuccess || isError };
}

/** The account's billing page data. `refetchInterval` polls while a payment is processing. */
export function useBilling({ enabled = true, refetchInterval }: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  return useQuery<BillingOverview>({
    queryKey: BILLING_QUERY_KEY,
    queryFn: () => apiGet<BillingOverview>('/api/billing'),
    enabled,
    refetchInterval,
  });
}

export interface InvoicesPage {
  data: BillingInvoiceView[];
  meta: { total: number; page: number; limit: number };
}

export const INVOICES_PAGE_SIZE = 10;

export function useInvoices(page: number, enabled = true) {
  return useQuery<InvoicesPage>({
    queryKey: [...BILLING_QUERY_KEY, 'invoices', page],
    queryFn: () => apiGet<InvoicesPage>('/api/billing/invoices', { page, limit: INVOICES_PAGE_SIZE }),
    enabled,
  });
}

/** Billing changes the account's limits, which the project list shows. */
function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: BILLING_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
}

export interface BillingDetailsInput {
  legalName: string;
  gstin?: string;
  address: { line1: string; line2?: string; city: string; postalCode: string; country: 'IN' };
  stateCode: string;
}

export function useSaveBillingDetails() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (input: BillingDetailsInput) => apiPut<BillingDetails>('/api/billing/details', input),
    onSuccess: invalidate,
  });
}

/**
 * Subscribe, change and cancel need a recent sign-in: the API answers an older one with
 * 403, and the API client then shows the re-authentication dialog and sends it again.
 * The body is a plan and an interval only; the price is always the server's.
 */
export function useSubscribe() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (input: { plan: string; interval: 'monthly' | 'yearly' }) =>
      apiPost<BillingCheckout>('/api/billing/subscribe', { plan: input.plan, interval: input.interval }),
    onSuccess: invalidate,
  });
}

export function useChangePlan() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: (input: { plan: string; interval: 'monthly' | 'yearly' }) =>
      apiPost<BillingCheckout>('/api/billing/change', { plan: input.plan, interval: input.interval }),
    onSuccess: invalidate,
  });
}

export function useCancelBilling() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: () => apiPost<BillingOverview>('/api/billing/cancel'),
    onSuccess: invalidate,
  });
}

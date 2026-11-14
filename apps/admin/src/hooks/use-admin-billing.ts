import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminBillingSummary, AdminPlan, AdminTenantBilling, BillingInterval } from '@chumbaq/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api';

/** Plans and their prices. Answers with billing off too, so staff can set limits first. */
export function useAdminPlans() {
  return useQuery<AdminPlan[]>({
    queryKey: ['admin-plans'],
    queryFn: () => apiGet<AdminPlan[]>('/api/admin/plans'),
  });
}

/** Only while billing is on: the API answers 404 otherwise. */
export function useAdminBillingSummary(enabled: boolean) {
  return useQuery<AdminBillingSummary>({
    queryKey: ['admin-billing-summary'],
    queryFn: () => apiGet<AdminBillingSummary>('/api/admin/billing/summary'),
    enabled,
  });
}

/** Recorded as a staff read, deduplicated with the tenant page's own. Only while billing is on. */
export function useAdminTenantBilling(tenantId: string | undefined, enabled: boolean) {
  return useQuery<AdminTenantBilling>({
    queryKey: ['admin-tenant-billing', tenantId],
    queryFn: () => apiGet<AdminTenantBilling>(`/api/admin/tenants/${tenantId}/billing`),
    enabled: enabled && !!tenantId,
  });
}

/** After any billing change: plans, the summary, the tenant's pages and the audit log. */
function useInvalidateAdmin() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith('admin') });
}

export interface PlanInput {
  code: string;
  name: string;
  mauLimit: number | null;
  projectLimit: number | null;
  seatLimit: number | null;
  sortOrder: number;
}

export function useCreatePlan() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (input: PlanInput & { reason: string }) => apiPost<AdminPlan>('/api/admin/plans', input),
    onSettled: invalidate,
  });
}

export function useUpdatePlan(code: string) {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (change: Partial<Omit<PlanInput, 'code'>> & { isActive?: boolean; reason: string }) =>
      apiPatch<AdminPlan>(`/api/admin/plans/${encodeURIComponent(code)}`, change),
    onSettled: invalidate,
  });
}

/** The price excluding any tax only: the server works out the charged amount and checks it against Razorpay. */
export function useAddPrice(code: string) {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (input: { interval: BillingInterval; pricePaise: number; razorpayPlanId: string; reason: string }) =>
      apiPost<AdminPlan>(`/api/admin/plans/${encodeURIComponent(code)}/prices`, input),
    onSettled: invalidate,
  });
}

export function useRetirePrice(code: string) {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: ({ priceId, reason }: { priceId: string; reason: string }) =>
      apiPost<AdminPlan>(`/api/admin/plans/${encodeURIComponent(code)}/prices/${priceId}/retire`, { reason }),
    onSettled: invalidate,
  });
}

export function useCompTenant(tenantId: string) {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (input: { planCode: string; until?: string; reason: string }) =>
      apiPost<AdminTenantBilling>(`/api/admin/tenants/${tenantId}/billing/comp`, input),
    onSettled: invalidate,
  });
}

export function useEndComp(tenantId: string) {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (reason: string) =>
      apiPost<AdminTenantBilling>(`/api/admin/tenants/${tenantId}/billing/comp/end`, { reason }),
    onSettled: invalidate,
  });
}

export function useCancelSubscription(tenantId: string) {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (input: { atCycleEnd: boolean; reason: string }) =>
      apiPost<AdminTenantBilling>(`/api/admin/tenants/${tenantId}/billing/cancel`, input),
    onSettled: invalidate,
  });
}

export function useResendInvoice(tenantId: string) {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: ({ invoiceId, reason }: { invoiceId: string; reason: string }) =>
      apiPost<{ resent: true }>(`/api/admin/tenants/${tenantId}/billing/invoices/${invoiceId}/resend`, { reason }),
    onSettled: invalidate,
  });
}

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminFactorResetState,
  AdminTenantDetail,
  AdminTenantStatus,
  AdminTenantSummary,
  FactorResetVerificationMethod,
  ImpersonationHandoff,
} from '@chumbaq/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

export interface AdminTenantsParams {
  page: number;
  limit: number;
  search?: string;
  status?: AdminTenantStatus;
}

export interface AdminTenantsResponse {
  data: AdminTenantSummary[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export function httpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

/** The server's message, which validation errors send as an array. */
export function adminErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data
    ?.message;
  if (Array.isArray(message)) return message.join(', ');
  return typeof message === 'string' && message ? message : fallback;
}

export function useAdminTenants(params: AdminTenantsParams) {
  return useQuery<AdminTenantsResponse>({
    queryKey: ['admin-tenants', params],
    queryFn: () => apiGet<AdminTenantsResponse>('/api/admin/tenants', { ...params }),
    placeholderData: keepPreviousData,
  });
}

export function useAdminTenant(tenantId: string | undefined) {
  return useQuery<AdminTenantDetail>({
    queryKey: ['admin-tenant', tenantId],
    queryFn: () => apiGet<AdminTenantDetail>(`/api/admin/tenants/${tenantId}`),
    enabled: !!tenantId,
  });
}

function useInvalidateAdminQueries() {
  const queryClient = useQueryClient();
  // Every admin view can show a tenant's status: the list, the detail, the
  // overview counts and the audit log.
  return () =>
    queryClient.invalidateQueries({
      predicate: (query) => String(query.queryKey[0]).startsWith('admin'),
    });
}

function useTenantAction(tenantId: string, action: 'suspend' | 'reactivate') {
  const invalidate = useInvalidateAdminQueries();
  return useMutation({
    mutationFn: (reason: string) =>
      apiPost<AdminTenantDetail>(`/api/admin/tenants/${tenantId}/${action}`, { reason }),
    // On a 409 as well: someone else got there first, and the page is out of date.
    onSettled: invalidate,
  });
}

export function useSuspendTenant(tenantId: string) {
  return useTenantAction(tenantId, 'suspend');
}

export function useReactivateTenant(tenantId: string) {
  return useTenantAction(tenantId, 'reactivate');
}

/** `projectLimit` null returns the account to the default. */
export function useSetProjectLimit(tenantId: string) {
  const invalidate = useInvalidateAdminQueries();
  return useMutation({
    mutationFn: ({ projectLimit, reason }: { projectLimit: number | null; reason: string }) =>
      apiPatch<AdminTenantDetail>(`/api/admin/tenants/${tenantId}/project-limit`, { projectLimit, reason }),
    onSettled: invalidate,
  });
}

/** `seatLimit` null returns the account to the default. */
export function useSetSeatLimit(tenantId: string) {
  const invalidate = useInvalidateAdminQueries();
  return useMutation({
    mutationFn: ({ seatLimit, reason }: { seatLimit: number | null; reason: string }) =>
      apiPatch<AdminTenantDetail>(`/api/admin/tenants/${tenantId}/seat-limit`, { seatLimit, reason }),
    onSettled: invalidate,
  });
}

export function useImpersonateTenant(tenantId: string) {
  const invalidate = useInvalidateAdminQueries();
  return useMutation({
    mutationFn: (reason: string) =>
      apiPost<ImpersonationHandoff>(`/api/admin/tenants/${tenantId}/impersonate`, { reason }),
    // Either way: starting view-as is itself an entry in the tenant's audit trail.
    onSettled: invalidate,
  });
}

export function useAdminFactorReset(tenantId: string) {
  return useQuery<AdminFactorResetState>({
    queryKey: ['admin-factor-reset', tenantId],
    queryFn: () => apiGet<AdminFactorResetState>(`/api/admin/tenants/${tenantId}/factor-reset`),
  });
}

/** How staff checked who is asking for a factor reset, other than by email. */
export interface FactorResetVerificationInput {
  method: FactorResetVerificationMethod;
  notes: string;
}

export function useRequestFactorReset(tenantId: string) {
  const invalidate = useInvalidateAdminQueries();
  return useMutation({
    // The justification only goes when given: the API refuses one that is too short.
    mutationFn: ({
      reason,
      passwordResetOverride,
      verification,
    }: {
      reason: string;
      passwordResetOverride?: string;
      verification: FactorResetVerificationInput;
    }) =>
      apiPost<AdminFactorResetState>(`/api/admin/tenants/${tenantId}/factor-reset`, {
        reason,
        verificationMethod: verification.method,
        verificationNotes: verification.notes,
        ...(passwordResetOverride ? { recentResetJustification: passwordResetOverride } : {}),
      }),
    // On a 409 as well: someone else may have started or cancelled one meanwhile.
    onSettled: invalidate,
  });
}

export function useCancelFactorReset(tenantId: string) {
  const invalidate = useInvalidateAdminQueries();
  return useMutation({
    mutationFn: () => apiDelete<AdminFactorResetState>(`/api/admin/tenants/${tenantId}/factor-reset`),
    onSettled: invalidate,
  });
}

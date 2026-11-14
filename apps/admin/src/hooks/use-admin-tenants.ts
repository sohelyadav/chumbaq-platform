import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminFactorResetState,
  AdminSortOrder,
  AdminTenantActivity,
  AdminTenantDetail,
  AdminTenantSort,
  AdminTenantStatus,
  AdminTenantSummary,
  FactorResetVerificationMethod,
  ImpersonationHandoff,
} from '@chumbaq/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { downloadExport, type ExportResult } from '@/lib/download-export';

/** What the list and the export share. The export takes no page or limit: the API refuses them. */
export interface AdminTenantsFilters {
  search?: string;
  status?: AdminTenantStatus;
  activity?: AdminTenantActivity;
  /** The API's defaults (newest first) when left out. */
  sort?: AdminTenantSort;
  order?: AdminSortOrder;
}

export interface AdminTenantsParams extends AdminTenantsFilters {
  page: number;
  limit: number;
}

export interface AdminTenantsResponse {
  data: AdminTenantSummary[];
  /** `countedThrough`: the last day usage is counted through, null before the first. */
  meta: { page: number; limit: number; total: number; totalPages: number; countedThrough: string | null };
}

/** Only the filters that are set, so axios sends no empty or `undefined` keys. */
function tenantFilterParams(filters: AdminTenantsFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.sort) params.sort = filters.sort;
  if (filters.order) params.order = filters.order;
  if (filters.search) params.search = filters.search;
  if (filters.status) params.status = filters.status;
  if (filters.activity) params.activity = filters.activity;
  return params;
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
    queryFn: () =>
      apiGet<AdminTenantsResponse>('/api/admin/tenants', {
        page: params.page,
        limit: params.limit,
        ...tenantFilterParams(params),
      }),
    placeholderData: keepPreviousData,
  });
}

export function useExportAdminTenants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (filters: AdminTenantsFilters): Promise<ExportResult> =>
      downloadExport('/api/admin/tenants/export', tenantFilterParams(filters), 'chumbaq-tenants.csv'),
    // The export is itself an entry in the audit log.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'audit-logs'] }),
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

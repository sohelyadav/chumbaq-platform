import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import type { AdminAuditLog, AdminHealth, AdminOverview } from '@chumbaq/shared';
import type { AuditApiFilters } from '@/lib/admin-audit-filters';
import api, { apiGet, apiPost } from '@/lib/api';
import { PASSKEY_REQUIRED_MESSAGE } from '@/lib/messages';

export interface AdminAuditLogsResponse {
  data: AdminAuditLog[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export function isForbiddenError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 403;
}

/** SuperAdminGuard's refusal when SUPER_ADMIN_PASSKEY_REQUIRED is on. Matched exactly. */
export function isPasskeyRequiredError(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === 403 &&
    (error.response.data as { message?: unknown } | undefined)?.message === PASSKEY_REQUIRED_MESSAGE
  );
}

/** A 403 will not change on retry, so show the access message straight away. */
function retryUnlessForbidden(failureCount: number, error: unknown): boolean {
  return !isForbiddenError(error) && failureCount < 1;
}

export function useAdminOverview() {
  return useQuery<AdminOverview>({
    queryKey: ['admin', 'overview'],
    queryFn: () => apiGet<AdminOverview>('/api/admin/overview'),
    retry: retryUnlessForbidden,
  });
}

export function useSendPlatformTestEmail() {
  return useMutation({
    mutationFn: (to?: string) =>
      apiPost<{ sentTo: string }>('/api/admin/platform-email/test', to ? { to } : {}),
  });
}

export function useAdminHealth() {
  return useQuery<AdminHealth>({
    queryKey: ['admin', 'health'],
    queryFn: () => apiGet<AdminHealth>('/api/admin/health'),
    retry: retryUnlessForbidden,
    refetchInterval: 30_000,
    // Never paint a remembered "ok" while the current state is unknown.
    staleTime: 0,
    gcTime: 0,
  });
}

type AdminAuditLogFilters = AuditApiFilters;

/** One comma-joined `action`: axios would otherwise send `action[]=`, which the API refuses. */
function filterParams(filters: AdminAuditLogFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.action?.length) params.action = filters.action.join(',');
  if (filters.actorEmail) params.actorEmail = filters.actorEmail;
  if (filters.targetId) params.targetId = filters.targetId;
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  return params;
}

export function useAdminAuditLogs(params: AdminAuditLogFilters & { page: number; limit: number }) {
  const { page, limit, ...filters } = params;
  return useQuery<AdminAuditLogsResponse>({
    queryKey: ['admin', 'audit-logs', params],
    // The body carries `meta`, so apiGet returns the whole envelope.
    queryFn: () =>
      apiGet<AdminAuditLogsResponse>('/api/admin/audit-logs', {
        page,
        limit,
        ...filterParams(filters),
      }),
    retry: retryUnlessForbidden,
    placeholderData: keepPreviousData,
  });
}

export interface AdminAuditExportResult {
  rowCount: number;
  rowCap: number;
  truncated: boolean;
}

/** Downloads through the signed-in client, since a plain link would carry no token. */
export function useExportAdminAuditLogs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (filters: AdminAuditLogFilters): Promise<AdminAuditExportResult> => {
      const response = await api.get<Blob>('/api/admin/audit-logs/export', {
        params: filterParams(filters),
        responseType: 'blob',
      });
      const disposition = String(response.headers['content-disposition'] ?? '');
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'chumbaq-audit-log.csv';
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      // Once the click has started the download, which holds its own reference.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return {
        rowCount: Number(response.headers['x-export-row-count'] ?? 0),
        rowCap: Number(response.headers['x-export-row-cap'] ?? 0),
        truncated: response.headers['x-export-truncated'] === 'true',
      };
    },
    // The export is itself an entry in the log.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'audit-logs'] }),
  });
}

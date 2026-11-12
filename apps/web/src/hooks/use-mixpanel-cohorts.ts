import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '@/lib/api';

export interface MixpanelStatus {
  configured: boolean;
  isActive: boolean;
  lastTestAt: string | null;
  mixpanelProjectId: string | null;
  serviceAccountUsername: string | null;
}

export interface MixpanelCohortInfo {
  id: number;
  name: string;
  count: number;
  description: string | null;
  created: string;
  lastUpdated: string;
}

export interface MixpanelCohort {
  id: string;
  projectId: string;
  mixpanelCohortId: number;
  name: string;
  status: 'pending' | 'syncing' | 'synced' | 'error';
  mixpanelUserCount: number;
  resolvedCount: number;
  unresolvedCount: number;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MixpanelCohortMember {
  id: string;
  cohortId: string;
  mixpanelDistinctId: string;
  isResolved: boolean;
  resolvedBy: string | null;
  addedAt: string;
}

export interface MixpanelPushStats {
  total: number;
  resolved: number;
  pushEnabled: number;
  unresolved: number;
}

export function useMixpanelStatus(projectId: string | undefined) {
  return useQuery<MixpanelStatus>({
    queryKey: ['mixpanel-status', projectId],
    queryFn: () => apiGet<MixpanelStatus>(`/api/projects/${projectId}/mixpanel/status`),
    enabled: !!projectId,
  });
}

export function useAvailableCohorts(projectId: string | undefined) {
  return useQuery<MixpanelCohortInfo[]>({
    queryKey: ['mixpanel-available-cohorts', projectId],
    queryFn: () => apiGet<MixpanelCohortInfo[]>(`/api/projects/${projectId}/mixpanel/available-cohorts`),
    enabled: !!projectId,
  });
}

export function useImportedCohorts(projectId: string | undefined) {
  return useQuery<MixpanelCohort[]>({
    queryKey: ['mixpanel-cohorts', projectId],
    queryFn: () => apiGet<MixpanelCohort[]>(`/api/projects/${projectId}/mixpanel/cohorts`),
    enabled: !!projectId,
  });
}

export function useImportedCohort(projectId: string | undefined, cohortId: string | undefined) {
  return useQuery<MixpanelCohort>({
    queryKey: ['mixpanel-cohort', projectId, cohortId],
    queryFn: () => apiGet<MixpanelCohort>(`/api/projects/${projectId}/mixpanel/cohorts/${cohortId}`),
    enabled: !!projectId && !!cohortId,
  });
}

export function useCohortMembers(
  projectId: string | undefined,
  cohortId: string | undefined,
  opts: { page?: number; limit?: number; resolved?: boolean },
) {
  const params: Record<string, unknown> = {};
  if (opts.page) params.page = opts.page;
  if (opts.limit) params.limit = opts.limit;
  if (opts.resolved !== undefined) params.resolved = opts.resolved;

  return useQuery<{ data: MixpanelCohortMember[]; meta: { page: number; limit: number; total: number; totalPages: number } }>({
    queryKey: ['mixpanel-cohort-members', projectId, cohortId, opts],
    queryFn: () =>
      apiGet(`/api/projects/${projectId}/mixpanel/cohorts/${cohortId}/members`, params),
    enabled: !!projectId && !!cohortId,
  });
}

export function useCohortPushStats(projectId: string | undefined, cohortId: string | undefined) {
  return useQuery<MixpanelPushStats>({
    queryKey: ['mixpanel-cohort-push-stats', projectId, cohortId],
    queryFn: () =>
      apiGet<MixpanelPushStats>(`/api/projects/${projectId}/mixpanel/cohorts/${cohortId}/push-stats`),
    enabled: !!projectId && !!cohortId,
  });
}

export function useConfigureMixpanel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      serviceAccountUsername: string;
      serviceAccountPassword: string;
      mixpanelProjectId: string;
    }) => apiPost(`/api/projects/${projectId}/mixpanel/configure`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mixpanel-status', projectId] });
    },
  });
}

export function useImportCohort(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { mixpanelCohortId: number }) =>
      apiPost(`/api/projects/${projectId}/mixpanel/cohorts/import`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mixpanel-cohorts', projectId] });
    },
  });
}

export function useSyncCohort(projectId: string, cohortId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost(`/api/projects/${projectId}/mixpanel/cohorts/${cohortId}/sync`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mixpanel-cohorts', projectId] });
      queryClient.invalidateQueries({ queryKey: ['mixpanel-cohort', projectId, cohortId] });
      queryClient.invalidateQueries({ queryKey: ['mixpanel-cohort-members', projectId, cohortId] });
    },
  });
}

/**
 * What the API can report at enqueue time. There are no delivery counts here:
 * the campaigns are handed to the worker, and their outcome shows up on the
 * push notification log rows afterwards.
 */
export interface CohortPushQueueResult {
  campaignIds: string[];
  devicesTargeted: number;
  tokensTargeted: number;
}

export function useSendPushToCohort(projectId: string, cohortId: string) {
  return useMutation({
    mutationFn: (data: {
      title: string;
      body: string;
      deepLinkUrl?: string;
      platforms?: string[];
      data?: Record<string, unknown>;
    }) =>
      apiPost<CohortPushQueueResult>(
        `/api/projects/${projectId}/mixpanel/cohorts/${cohortId}/push`,
        data,
      ),
  });
}

export function useDeleteCohort(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cohortId: string) =>
      apiDelete(`/api/projects/${projectId}/mixpanel/cohorts/${cohortId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mixpanel-cohorts', projectId] });
    },
  });
}

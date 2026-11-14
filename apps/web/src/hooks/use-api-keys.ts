import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '@/lib/api';

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface CreateApiKeyResponse {
  apiKey: ApiKey;
  fullKey: string;
}

/** Needs `keys.manage`, so pass `enabled: false` for anyone without it. */
export function useApiKeys(projectId: string | undefined, enabled = true) {
  return useQuery<ApiKey[]>({
    queryKey: ['api-keys', projectId],
    queryFn: () => apiGet<ApiKey[]>(`/api/projects/${projectId}/api-keys`),
    enabled: !!projectId && enabled,
  });
}

export function useCreateApiKey(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; permissions?: string[]; expiresAt?: string }) =>
      apiPost<CreateApiKeyResponse>(`/api/projects/${projectId}/api-keys`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', projectId] });
    },
  });
}

export function useRevokeApiKey(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/projects/${projectId}/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', projectId] });
    },
  });
}

/** The project's identity secret, for the server that makes each identify's userHash. */
export function useIdentitySecret(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['identity-secret', projectId],
    queryFn: () => apiGet<{ secret: string; version: number }>(`/api/projects/${projectId}/identity-secret`),
    enabled: !!projectId && enabled,
  });
}

export function useRotateIdentitySecret(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ secret: string; version: number }>(`/api/projects/${projectId}/identity-secret/rotate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['identity-secret', projectId] }),
  });
}

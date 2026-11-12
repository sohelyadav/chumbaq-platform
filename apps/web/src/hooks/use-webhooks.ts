import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';

export interface Webhook {
  id: string;
  projectId: string;
  url: string;
  events: string[];
  isActive: boolean;
  /** Last four characters of the live secret; null for one stored before encryption. */
  secretHint: string | null;
  secretRotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create and rotate only: the single response that carries the secret. */
export interface WebhookWithSecret extends Webhook {
  secret: string;
}

export function useWebhooks(projectId: string | undefined) {
  return useQuery<Webhook[]>({
    queryKey: ['webhooks', projectId],
    queryFn: () => apiGet<Webhook[]>(`/api/projects/${projectId}/webhooks`),
    enabled: !!projectId,
  });
}

export function useCreateWebhook(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { url: string; events: string[] }) =>
      apiPost<WebhookWithSecret>(`/api/projects/${projectId}/webhooks`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks', projectId] });
    },
  });
}

export function useUpdateWebhook(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; url?: string; events?: string[]; isActive?: boolean }) =>
      apiPatch<Webhook>(`/api/projects/${projectId}/webhooks/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks', projectId] });
    },
  });
}

export function useRotateWebhookSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiPost<WebhookWithSecret>(`/api/projects/${projectId}/webhooks/${id}/rotate-secret`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks', projectId] });
    },
  });
}

export function useDeleteWebhook(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/projects/${projectId}/webhooks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks', projectId] });
    },
  });
}

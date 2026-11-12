import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type {
  PushDeliveryOptions,
  PushTranslations,
  PushAction,
  PushCarouselSlide,
  PushTimer,
} from './use-push-notifications';

/**
 * Saved campaign content, reusable across sends. Content only — no audience
 * and no schedule, mirroring `PushTemplateEntity` on the API.
 */
export interface PushTemplate {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  title: string;
  body: string | null;
  imageUrl: string | null;
  deepLinkUrl: string | null;
  data: Record<string, string> | null;
  silent: boolean;
  deliveryOptions: PushDeliveryOptions | null;
  translations: PushTranslations | null;
  /** Rich content, nullable because a plain template carries none of it. */
  actions: PushAction[] | null;
  iosCategory: string | null;
  carousel: PushCarouselSlide[] | null;
  timer: PushTimer | null;
  /** How many campaigns have been created from this template. */
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the panel's create/edit form sends. It always submits the full set of
 * content fields rather than a partial diff, so a field the user cleared is
 * sent as `null` (clear it) rather than omitted (leave it alone) — omitting
 * it would be indistinguishable from "unchanged" to the API's PATCH handler.
 */
export interface PushTemplateInput {
  name: string;
  description: string | null;
  title: string;
  body: string | null;
  imageUrl: string | null;
  deepLinkUrl: string | null;
  silent: boolean;
  /** Custom key/value pairs delivered with the message. */
  data: Record<string, string> | null;
  /** Transport and per-platform tuning. */
  deliveryOptions: PushDeliveryOptions | null;
  /** Per-language copy, keyed by language tag. */
  translations: PushTranslations | null;
}

/**
 * Templates for a project, ordered most-used first by the API.
 */
export function usePushTemplates(projectId: string | undefined) {
  // The list endpoint returns a bare array: TransformInterceptor supplies the
  // `data` envelope and apiGet strips it, but unlike the paginated endpoints
  // there is no further `{ data, total }` shape inside — see useSegments.
  return useQuery<PushTemplate[]>({
    queryKey: ['push-templates', projectId],
    queryFn: () => apiGet<PushTemplate[]>(`/api/projects/${projectId}/push-templates`),
    enabled: !!projectId,
  });
}

export function useCreatePushTemplate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PushTemplateInput) =>
      apiPost<PushTemplate>(`/api/projects/${projectId}/push-templates`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-templates', projectId] });
    },
  });
}

export function useUpdatePushTemplate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: PushTemplateInput & { id: string }) =>
      apiPatch<PushTemplate>(`/api/projects/${projectId}/push-templates/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-templates', projectId] });
    },
  });
}

export function useDeletePushTemplate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ deleted: true }>(`/api/projects/${projectId}/push-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-templates', projectId] });
    },
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';

// ─── Types ──────────────────────────────────────────

export type MessageType = 'modal' | 'bottom_sheet' | 'banner_top' | 'banner_bottom' | 'fullscreen';
export type MessageStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'archived';
export type TriggerType = 'immediate' | 'on_event' | 'on_screen' | 'on_app_open' | 'scheduled';
export type UserType = 'all' | 'cohort' | 'segment' | 'specific_users';

export interface MessageButton {
  id: string;
  text: string;
  action: 'dismiss' | 'deep_link' | 'url' | 'custom_event';
  actionUrl?: string;
  actionEvent?: string;
  style: 'primary' | 'secondary' | 'text';
}

export interface MessageTheme {
  backgroundColor?: string;
  textColor?: string;
  titleColor?: string;
  buttonPrimaryColor?: string;
  buttonSecondaryColor?: string;
  overlayColor?: string;
  borderRadius?: number;
  animation?: 'fade' | 'slide_up' | 'slide_down' | 'scale' | 'none';
}

export interface InAppMessage {
  id: string;
  projectId: string;
  name: string;
  messageType: MessageType;
  status: MessageStatus;
  title: string;
  body: string | null;
  imageUrl: string | null;
  imagePosition: string;
  buttons: MessageButton[] | null;
  theme: MessageTheme | null;
  dismissOnTapOutside: boolean;
  autoDismissSeconds: number | null;
  triggerType: TriggerType;
  triggerEvent: string | null;
  triggerScreen: string | null;
  triggerDelaySeconds: number;
  userType: UserType;
  mixpanelCohortId: string | null;
  userFilters: Record<string, any> | null;
  startsAt: string | null;
  endsAt: string | null;
  priority: number;
  maxImpressionsPerUser: number | null;
  minIntervalSeconds: number | null;
  maxImpressionsTotal: number | null;
  totalImpressions: number;
  totalClicks: number;
  totalDismissals: number;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAnalyticsSummary {
  messageId: string;
  totalDelivered: number;
  totalImpressions: number;
  totalClicks: number;
  totalCtaClicks: number;
  totalDismissals: number;
  totalAutoDismissals: number;
  uniqueUsers: number;
  clickRate: number;
  dismissRate: number;
}

export interface MessageFunnel {
  delivered: number;
  impressions: number;
  clicks: number;
  ctaClicks: number;
  dismissals: number;
}

// ─── CRUD Hooks ─────────────────────────────────────

export function useInAppMessages(projectId: string | undefined, status?: MessageStatus) {
  return useQuery<{ data: InAppMessage[]; total: number }>({
    queryKey: ['in-app-messages', projectId, status],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const qs = params.toString();
      return apiGet<{ data: InAppMessage[]; total: number }>(
        `/api/projects/${projectId}/in-app-messages${qs ? `?${qs}` : ''}`,
      );
    },
    enabled: !!projectId,
  });
}

export function useInAppMessage(projectId: string | undefined, messageId: string | undefined) {
  return useQuery<InAppMessage>({
    queryKey: ['in-app-message', projectId, messageId],
    queryFn: () => apiGet<InAppMessage>(`/api/projects/${projectId}/in-app-messages/${messageId}`),
    enabled: !!projectId && !!messageId,
  });
}

export function useCreateInAppMessage(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<InAppMessage>) =>
      apiPost<InAppMessage>(`/api/projects/${projectId}/in-app-messages`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-messages', projectId] });
    },
  });
}

export function useUpdateInAppMessage(projectId: string, messageId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<InAppMessage>) =>
      apiPatch<InAppMessage>(`/api/projects/${projectId}/in-app-messages/${messageId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-messages', projectId] });
      queryClient.invalidateQueries({ queryKey: ['in-app-message', projectId, messageId] });
    },
  });
}

export function useDeleteInAppMessage(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      apiDelete(`/api/projects/${projectId}/in-app-messages/${messageId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-messages', projectId] });
    },
  });
}

// ─── Lifecycle Hooks ────────────────────────────────

export function useActivateMessage(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      apiPost<InAppMessage>(`/api/projects/${projectId}/in-app-messages/${messageId}/activate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-messages', projectId] });
    },
  });
}

export function usePauseMessage(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      apiPost<InAppMessage>(`/api/projects/${projectId}/in-app-messages/${messageId}/pause`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-messages', projectId] });
    },
  });
}

export function useDuplicateMessage(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      apiPost<InAppMessage>(`/api/projects/${projectId}/in-app-messages/${messageId}/duplicate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-messages', projectId] });
    },
  });
}

// ─── Trigger Hook ───────────────────────────────────

export function useTriggerMessage(projectId: string) {
  return useMutation({
    mutationFn: (data: {
      messageId: string;
      targetType: 'all' | 'cohort' | 'users';
      cohortId?: string;
      distinctIds?: string[];
      deviceFingerprints?: string[];
    }) => apiPost<{ queued: number }>(`/api/projects/${projectId}/in-app-messages/trigger`, data),
  });
}

// ─── Analytics Hooks ────────────────────────────────

export function useMessageAnalytics(projectId: string | undefined, messageId: string | undefined) {
  return useQuery<MessageAnalyticsSummary>({
    queryKey: ['in-app-message-analytics', projectId, messageId],
    queryFn: () =>
      apiGet<MessageAnalyticsSummary>(
        `/api/projects/${projectId}/in-app-messages/${messageId}/analytics`,
      ),
    enabled: !!projectId && !!messageId,
  });
}

export function useMessageFunnel(projectId: string | undefined, messageId: string | undefined) {
  return useQuery<MessageFunnel>({
    queryKey: ['in-app-message-funnel', projectId, messageId],
    queryFn: () =>
      apiGet<MessageFunnel>(
        `/api/projects/${projectId}/in-app-messages/${messageId}/analytics/funnel`,
      ),
    enabled: !!projectId && !!messageId,
  });
}

export function useMessageTimeseries(
  projectId: string | undefined,
  messageId: string | undefined,
  params?: { start?: string; end?: string; granularity?: string },
) {
  return useQuery<Array<{ date: string; impressions: number; clicks: number; dismissals: number }>>({
    queryKey: ['in-app-message-timeseries', projectId, messageId, params],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params?.start) qs.set('start', params.start);
      if (params?.end) qs.set('end', params.end);
      if (params?.granularity) qs.set('granularity', params.granularity);
      const queryStr = qs.toString();
      return apiGet(
        `/api/projects/${projectId}/in-app-messages/${messageId}/analytics/timeseries${queryStr ? `?${queryStr}` : ''}`,
      );
    },
    enabled: !!projectId && !!messageId,
  });
}

export function useMessageButtonBreakdown(
  projectId: string | undefined,
  messageId: string | undefined,
) {
  return useQuery<Array<{ buttonId: string; clicks: number }>>({
    queryKey: ['in-app-message-buttons', projectId, messageId],
    queryFn: () =>
      apiGet(`/api/projects/${projectId}/in-app-messages/${messageId}/analytics/buttons`),
    enabled: !!projectId && !!messageId,
  });
}

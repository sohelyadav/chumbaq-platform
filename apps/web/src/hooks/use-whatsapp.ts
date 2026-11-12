import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import type { PushNotificationLog } from '@/hooks/use-push-notifications';
import type { Suppression } from '@/hooks/use-email';

export type WhatsAppProviderName = 'meta' | 'twilio_whatsapp' | 'gupshup' | 'interakt';

export const WHATSAPP_PROVIDER_LABEL: Record<WhatsAppProviderName, string> = {
  meta: 'Meta Cloud API',
  twilio_whatsapp: 'Twilio',
  gupshup: 'Gupshup',
  interakt: 'Interakt',
};

export interface WhatsAppSettings {
  id: string;
  projectId: string;
  provider: WhatsAppProviderName | null;
  requireOptIn: boolean;
  updatedAt: string;
}

export interface WhatsAppCredentialSummary {
  provider: WhatsAppProviderName;
  identifiers: Record<string, string>;
  keyHint: string | null;
  webhooksSigned: boolean;
}

export interface WhatsAppSettingsStatus {
  configured: boolean;
  settings: WhatsAppSettings | null;
  providers: WhatsAppCredentialSummary[];
  webhookUrls: Record<WhatsAppProviderName, string> | null;
  verifyToken: string | null;
  webhooksReachable: boolean;
  readyToSend: boolean;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  bodyText: string;
  bodyParamCount: number;
  paramNames: string[] | null;
  header: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION'; text: string | null; paramCount: number } | null;
  buttons: Array<{ type: string; text: string; dynamic: boolean }>;
}

export interface WhatsAppContent {
  template: { id: string; name: string; language: string; category?: string | null; paramNames?: string[] | null };
  bodyParams: string[];
  headerText?: string | null;
  headerMediaUrl?: string | null;
  headerMediaType?: 'image' | 'video' | 'document' | null;
  buttonParams?: string[];
  previewText?: string | null;
}

export interface WhatsAppCampaignInput {
  name?: string;
  content: WhatsAppContent;
  segmentId?: string;
  deviceIdentityIds?: string[];
  scheduledAt?: string;
  deliverInRecipientTimezone?: boolean;
  localSendTime?: string;
  variants?: Array<{ key: string; title: string; content: WhatsAppContent; weight: number }>;
  controlPercentage?: number;
}

export function useWhatsAppSettings(projectId: string | undefined) {
  return useQuery<WhatsAppSettingsStatus>({
    queryKey: ['whatsapp-settings', projectId],
    queryFn: () => apiGet<WhatsAppSettingsStatus>(`/api/whatsapp/settings/${projectId}`),
    enabled: !!projectId,
  });
}

export function useUpdateWhatsAppSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { requireOptIn: boolean }) =>
      apiPost<WhatsAppSettingsStatus>('/api/whatsapp/settings', { projectId, ...input }),
    onSuccess: (status) => queryClient.setQueryData(['whatsapp-settings', projectId], status),
  });
}

export function useConnectWhatsAppProvider(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: WhatsAppProviderName; credentials: Record<string, unknown> }) =>
      apiPost<WhatsAppSettingsStatus>('/api/whatsapp/providers', {
        projectId,
        provider: input.provider,
        credentials: JSON.stringify(input.credentials),
      }),
    onSuccess: (status) => {
      queryClient.setQueryData(['whatsapp-settings', projectId], status);
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', projectId] });
    },
  });
}

export function useWhatsAppTemplates(projectId: string | undefined, enabled: boolean) {
  return useQuery<{ canList: boolean; templates: WhatsAppTemplate[] }>({
    queryKey: ['whatsapp-templates', projectId],
    queryFn: () =>
      apiGet<{ canList: boolean; templates: WhatsAppTemplate[] }>(`/api/whatsapp/templates/${projectId}`),
    enabled: !!projectId && enabled,
    staleTime: 60_000,
  });
}

export function useWhatsAppAudiencePreview(projectId: string) {
  return useMutation({
    mutationFn: (input: { segmentId?: string }) =>
      apiPost<{ targetType: string; recipients: number; requireOptIn: boolean }>(
        '/api/whatsapp/audience-preview',
        { projectId, ...input },
      ),
  });
}

export function useSendWhatsAppCampaign(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WhatsAppCampaignInput) =>
      apiPost<PushNotificationLog>('/api/whatsapp/send', { projectId, ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['push-logs', projectId] }),
  });
}

export function useTestSendWhatsApp(projectId: string) {
  return useMutation({
    mutationFn: (input: { to: string; content: WhatsAppContent }) =>
      apiPost<{ delivered: boolean; error?: string }>('/api/whatsapp/test-send', { projectId, ...input }),
  });
}

export function useWhatsAppSuppressions(projectId: string | undefined, page = 1) {
  return useQuery<{ data: Suppression[]; total: number }>({
    queryKey: ['whatsapp-suppressions', projectId, page],
    queryFn: () =>
      apiGet<{ data: Suppression[]; total: number }>(`/api/whatsapp/suppressions/${projectId}`, { page, limit: 50 }),
    enabled: !!projectId,
  });
}

export function useAddWhatsAppSuppression(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) =>
      apiPost('/api/whatsapp/suppressions', { projectId, address, reason: 'manual' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp-suppressions', projectId] }),
  });
}

export function useRemoveWhatsAppSuppression(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) =>
      apiDelete(`/api/whatsapp/suppressions/${projectId}/${encodeURIComponent(address)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp-suppressions', projectId] }),
  });
}

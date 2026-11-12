import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import type { PushNotificationLog } from '@/hooks/use-push-notifications';
import type { Suppression } from '@/hooks/use-email';

export type SmsProviderName = 'twilio';

export interface SmsSettings {
  id: string;
  projectId: string;
  provider: SmsProviderName | null;
  sender: string;
  requireOptIn: boolean;
  optOutText: string | null;
  updatedAt: string;
}

/** What the API says about stored credentials. Never contains a secret. */
export interface SmsCredentialSummary {
  provider: SmsProviderName;
  accountSid: string | null;
  keyHint: string | null;
}

export interface SmsSettingsStatus {
  configured: boolean;
  settings: SmsSettings | null;
  providers: SmsCredentialSummary[];
  inboundWebhookUrl: string | null;
  webhooksReachable: boolean;
  readyToSend: boolean;
}

export interface SmsVariant {
  key: string;
  /** A label for the arm in reports. */
  title: string;
  body: string;
  weight: number;
}

export interface SmsAudienceInput {
  segmentId?: string;
  deviceIdentityIds?: string[];
}

export interface SmsCampaignInput extends SmsAudienceInput {
  name?: string;
  body: string;
  scheduledAt?: string;
  deliverInRecipientTimezone?: boolean;
  localSendTime?: string;
  variants?: SmsVariant[];
  controlPercentage?: number;
}

export function useSmsSettings(projectId: string | undefined) {
  return useQuery<SmsSettingsStatus>({
    queryKey: ['sms-settings', projectId],
    queryFn: () => apiGet<SmsSettingsStatus>(`/api/sms/settings/${projectId}`),
    enabled: !!projectId,
  });
}

export function useUpdateSmsSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sender: string; requireOptIn: boolean; optOutText: string }) =>
      apiPost<SmsSettingsStatus>('/api/sms/settings', { projectId, ...input }),
    onSuccess: (status) => queryClient.setQueryData(['sms-settings', projectId], status),
  });
}

export function useConnectSmsProvider(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: SmsProviderName; credentials: Record<string, unknown> }) =>
      apiPost<SmsSettingsStatus>('/api/sms/providers', {
        projectId,
        provider: input.provider,
        credentials: JSON.stringify(input.credentials),
      }),
    onSuccess: (status) => queryClient.setQueryData(['sms-settings', projectId], status),
  });
}

export function useSmsAudiencePreview(projectId: string) {
  return useMutation({
    mutationFn: (input: SmsAudienceInput) =>
      apiPost<{ targetType: string; recipients: number; requireOptIn: boolean }>(
        '/api/sms/audience-preview',
        { projectId, ...input },
      ),
  });
}

export function useSendSmsCampaign(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SmsCampaignInput) =>
      apiPost<PushNotificationLog>('/api/sms/send', { projectId, ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-logs', projectId] });
    },
  });
}

export function useTestSendSms(projectId: string) {
  return useMutation({
    mutationFn: (input: { to: string; body: string }) =>
      apiPost<{ delivered: boolean; error?: string }>('/api/sms/test-send', {
        projectId,
        ...input,
      }),
  });
}

export function useSmsSuppressions(projectId: string | undefined, page = 1) {
  return useQuery<{ data: Suppression[]; total: number }>({
    queryKey: ['sms-suppressions', projectId, page],
    queryFn: () =>
      apiGet<{ data: Suppression[]; total: number }>(`/api/sms/suppressions/${projectId}`, {
        page,
        limit: 50,
      }),
    enabled: !!projectId,
  });
}

export function useAddSmsSuppression(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) =>
      apiPost('/api/sms/suppressions', { projectId, address, reason: 'manual' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sms-suppressions', projectId] }),
  });
}

export function useRemoveSmsSuppression(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) =>
      apiDelete(`/api/sms/suppressions/${projectId}/${encodeURIComponent(address)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sms-suppressions', projectId] }),
  });
}

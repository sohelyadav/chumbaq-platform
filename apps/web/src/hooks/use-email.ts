import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import type { PushNotificationLog } from '@/hooks/use-push-notifications';

export type EmailProviderName = 'ses' | 'resend' | 'brevo';

export interface EmailSettings {
  id: string;
  projectId: string;
  provider: EmailProviderName | null;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  postalAddress: string;
  requireOptIn: boolean;
  /** The SNS topic SES events are accepted from, once one has subscribed. */
  sesTopicArn: string | null;
  updatedAt: string;
}

/** What the API says about stored credentials. Never contains a secret. */
export interface EmailCredentialSummary {
  provider: EmailProviderName;
  keyHint: string | null;
  region?: string;
  configurationSetName?: string | null;
  hasWebhookSecret?: boolean;
}

export interface EmailSettingsStatus {
  configured: boolean;
  settings: EmailSettings | null;
  providers: EmailCredentialSummary[];
  webhookUrls: Record<EmailProviderName, string> | null;
  readyToSend: boolean;
}

export interface EmailVariant {
  key: string;
  /** The arm's subject. */
  title: string;
  html?: string;
  preheader?: string;
  /** Plain-text part. */
  body?: string;
  weight: number;
}

export interface EmailAudienceInput {
  segmentId?: string;
  deviceIdentityIds?: string[];
}

export interface EmailCampaignInput extends EmailAudienceInput {
  subject: string;
  html: string;
  text?: string;
  preheader?: string;
  scheduledAt?: string;
  deliverInRecipientTimezone?: boolean;
  localSendTime?: string;
  sendTimeOptimised?: boolean;
  variants?: EmailVariant[];
  controlPercentage?: number;
}

export interface Suppression {
  id: string;
  address: string;
  reason: 'unsubscribed' | 'bounced' | 'complained' | 'manual';
  source: string;
  detail: string | null;
  createdAt: string;
}

export function useEmailSettings(projectId: string | undefined) {
  return useQuery<EmailSettingsStatus>({
    queryKey: ['email-settings', projectId],
    queryFn: () => apiGet<EmailSettingsStatus>(`/api/email/settings/${projectId}`),
    enabled: !!projectId,
  });
}

export function useUpdateEmailSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      fromEmail: string;
      fromName?: string;
      replyTo?: string;
      postalAddress: string;
      requireOptIn: boolean;
    }) => apiPost<EmailSettingsStatus>('/api/email/settings', { projectId, ...input }),
    onSuccess: (status) => queryClient.setQueryData(['email-settings', projectId], status),
  });
}

export function useConnectEmailProvider(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: EmailProviderName; credentials: Record<string, unknown> }) =>
      apiPost<EmailSettingsStatus>('/api/email/providers', {
        projectId,
        provider: input.provider,
        credentials: JSON.stringify(input.credentials),
      }),
    onSuccess: (status) => queryClient.setQueryData(['email-settings', projectId], status),
  });
}

export function useResetSesTopic(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<EmailSettingsStatus>(`/api/email/settings/${projectId}/reset-ses-topic`),
    onSuccess: (status) => queryClient.setQueryData(['email-settings', projectId], status),
  });
}

/** A new secret in the webhook URLs. The old URLs stop working at once. */
export function useRotateEmailWebhookToken(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<EmailSettingsStatus>(`/api/email/settings/${projectId}/rotate-webhook-token`),
    onSuccess: (status) => queryClient.setQueryData(['email-settings', projectId], status),
  });
}

export function useEmailAudiencePreview(projectId: string) {
  return useMutation({
    mutationFn: (input: EmailAudienceInput) =>
      apiPost<{ targetType: string; recipients: number; requireOptIn: boolean }>(
        '/api/email/audience-preview',
        { projectId, ...input },
      ),
  });
}

export function useSendEmailCampaign(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: EmailCampaignInput) =>
      apiPost<PushNotificationLog>('/api/email/send', { projectId, ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-logs', projectId] });
    },
  });
}

export function useTestSendEmail(projectId: string) {
  return useMutation({
    mutationFn: (input: {
      to: string;
      subject: string;
      html: string;
      text?: string;
      preheader?: string;
    }) =>
      apiPost<{ delivered: boolean; error?: string }>('/api/email/test-send', {
        projectId,
        ...input,
      }),
  });
}

export function useSuppressions(projectId: string | undefined, page = 1) {
  return useQuery<{ data: Suppression[]; total: number }>({
    queryKey: ['email-suppressions', projectId, page],
    queryFn: () =>
      apiGet<{ data: Suppression[]; total: number }>(
        `/api/email/suppressions/${projectId}`,
        { page, limit: 50 },
      ),
    enabled: !!projectId,
  });
}

export function useAddSuppression(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) =>
      apiPost('/api/email/suppressions', { projectId, address, reason: 'manual' }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['email-suppressions', projectId] }),
  });
}

export function useRemoveSuppression(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) =>
      apiDelete(`/api/email/suppressions/${projectId}/${encodeURIComponent(address)}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['email-suppressions', projectId] }),
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import type { WhatsAppContent } from '@/hooks/use-whatsapp';

export interface PushConfigStatus {
  configured: boolean;
  isActive: boolean;
  /** Which Firebase project the stored service account belongs to. */
  firebaseProjectId: string | null;
  /** The service account itself, so a key from the wrong account is visible. */
  clientEmail: string | null;
  updatedAt: string | null;
  /** Max campaigns one device may be sent per rolling 24h. Null = uncapped. */
  frequencyCapPerDay: number | null;
  /**
   * Window in which nothing is delivered, both `HH:MM` on the recipient's own
   * clock. Always both or neither — the API rejects a half-open window,
   * because one end alone would silently do nothing.
   */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** Ceiling on send rate, to stay under a provider quota. Null = unthrottled. */
  maxSendsPerMinute: number | null;
}

export type PushTargetType = 'project' | 'segment' | 'devices';

/** Transport and per-platform tuning. Every field is optional — omitting all
 * of them leaves FCM's own defaults in place. */
export interface PushDeliveryOptions {
  priority?: 'high' | 'normal';
  ttlSeconds?: number;
  collapseKey?: string;
  android?: {
    channelId?: string;
    sound?: string;
  };
  ios?: {
    sound?: string;
    badge?: number;
    threadId?: string;
  };
}

export interface AudiencePreview {
  targetType: PushTargetType;
  totalTokens: number;
  deviceCount: number | null;
}

/** One arm of an A/B experiment. Mirrors `PushVariantDto` on the API. */
export interface PushVariant {
  /** Short stable label shown in reports, e.g. `A`. */
  key: string;
  title: string;
  body?: string;
  imageUrl?: string;
  deepLinkUrl?: string;
  /** Share of the treated audience, as a percentage. Weights must total 100. */
  weight: number;
  /**
   * Per-language copy for *this arm*. Campaign-level translations are not
   * applied to an experiment: replacing an arm's copy with a shared
   * translation would overwrite the very thing being compared.
   */
  translations?: PushTranslations;
}

/**
 * A button under the notification. Mirrors `PushAction` on the API.
 *
 * The two platforms diverge: Android builds these locally from the payload,
 * so the definitions travel with the message; iOS can only show buttons from
 * a category the app registered at launch, so there the payload names
 * `iosCategory` and the app owns the buttons.
 */
export interface PushAction {
  /** Reported back with a click event, so a tap can be told from a button. */
  id: string;
  title: string;
  /** Where this button leads. Falls back to the notification's deep link. */
  deepLinkUrl?: string;
}

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** A repeat schedule. Mirrors `PushRecurrence` on the API. */
export interface PushRecurrence {
  frequency: RecurrenceFrequency;
  /** Every N periods. 1 = every day / week / month. */
  interval: number;
  /** `HH:MM` the occurrence should fire at. */
  atTime: string;
  /** 0 = Sunday. Weekly only; empty means the same weekday each time. */
  daysOfWeek?: number[];
  /** Timezone the schedule is expressed in. Defaults to UTC. */
  timezone?: string;
  /** Stop after this instant. Null means it runs until cancelled. */
  endsAt?: string | null;
}

/**
 * Per-language override for `title`/`body`, keyed by a BCP 47 tag (e.g.
 * `pt-BR`). Mirrors `PushTranslations` on the API — see `pickTranslation` in
 * `push-personalisation.ts` for the exact matching rules: full tag before
 * base language, case/separator-insensitive, `language` preferred over
 * `locale`. A language absent here still gets the campaign's own title/body;
 * nobody is skipped for lacking a translation.
 */
export type PushTranslations = Record<string, { title?: string; body?: string }>;

export interface TestSendResult {
  delivered: boolean;
  dryRun: boolean;
  error?: string;
  errorCode?: string;
}

export type NotificationStatus =
  | 'scheduled'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'partial'
  | 'cancelled'
  | 'expanded';

// Drives the list's poll-while-busy behaviour. `scheduled` is excluded on
// purpose: a campaign booked for next week must not make the dashboard poll
// every three seconds until then.
const ACTIVE_STATUSES: NotificationStatus[] = ['queued', 'sending'];

export interface CampaignEngagement {
  campaignId: string;
  /** Devices that confirmed receipt. Distinct from FCM accepting the send. */
  delivered: number;
  impressions: number;
  clicks: number;
  dismissed: number;
  /** Email only: addresses the provider reported as bounced. */
  bounced?: number;
  /** Email only: recipients who marked the email as spam. */
  complained?: number;
  /** Null when nothing has reported yet — not the same claim as 0%. */
  clickThroughRate: number | null;
}

/** The channel a campaign is delivered on. Every channel shares one list. */
export type MessageChannel = 'push' | 'email' | 'sms' | 'whatsapp';

/** An email campaign's content. `title` on the campaign mirrors `subject`. */
export interface EmailContent {
  subject: string;
  html: string;
  text?: string | null;
  preheader?: string | null;
}

export interface PushNotificationLog {
  id: string;
  projectId: string;
  /** Absent on rows written before email existed, which are all push. */
  channel?: MessageChannel;
  emailContent?: EmailContent | null;
  whatsappContent?: WhatsAppContent | null;
  title: string;
  body?: string;
  data?: Record<string, string>;
  imageUrl?: string;
  totalTokens: number;
  processedTokens: number;
  successCount: number;
  failureCount: number;
  status: NotificationStatus;
  /** Per-token failures, capped server-side — see MAX_FAILURE_DETAILS. Each
   * `error` is the raw FCM error code (e.g. `UNREGISTERED`), not a message. */
  failureDetails?: Array<{ token: string; error: string; errorCode?: string }>;
  errorMessage?: string;
  targetType: PushTargetType;
  /** Only set when `targetType` is `devices`. */
  targetDeviceIds?: string[] | null;
  /** Only set when `targetType` is `segment`. */
  segmentId?: string | null;
  /** Where a tap should land. Null/absent means the app's own default. */
  deepLinkUrl?: string | null;
  /** Data-only push: no notification is shown, the app is woken silently. */
  silent?: boolean;
  sentAt: string;
  completedAt?: string;
  scheduledAt?: string | null;
  deliverInRecipientTimezone?: boolean;
  localSendTime?: string | null;
  parentCampaignId?: string | null;
  /**
   * Everything below is stored on the campaign and returned by the API, but is
   * only meaningful after the fact — it is what the campaign was configured to
   * do, which is exactly what the detail page has to be able to show. A
   * campaign whose recurrence or action buttons are invisible once created
   * cannot be audited or reproduced.
   */
  deliveryOptions?: PushDeliveryOptions | null;
  /** Buttons under the notification. Android renders these from the payload. */
  actions?: PushAction[] | null;
  /** APNs category naming the buttons the iOS app registered at launch. */
  iosCategory?: string | null;
  /** Set on a template campaign that spawns one occurrence per period. */
  recurrence?: PushRecurrence | null;
  /** Per-language copy. Never set on an experiment — arms carry their own. */
  translations?: PushTranslations | null;
  /** Experiment arms. Only set on the parent campaign that was split. */
  variants?: PushVariant[] | null;
  /** Percentage held back and sent nothing. Only on an experiment parent. */
  controlPercentage?: number | null;
  /** Which arm this child campaign is. Only set on a variant child. */
  variantKey?: string | null;
  /** Recipient hour chosen from their own click history, not a fixed time. */
  sendTimeOptimised?: boolean;
  carousel?: PushCarouselSlide[] | null;
  timer?: PushTimer | null;
  engagement: CampaignEngagement;
}

export function usePushConfigStatus(projectId: string | undefined) {
  return useQuery<PushConfigStatus>({
    queryKey: ['push-config-status', projectId],
    queryFn: () => apiGet<PushConfigStatus>(`/api/push-notifications/config-status/${projectId}`),
    enabled: !!projectId,
  });
}

export function useConfigurePush(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fcmServiceAccountJson: string) =>
      apiPost<{ id: string; projectId: string }>('/api/push-notifications/configure', {
        projectId,
        fcmServiceAccountJson,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-config-status', projectId] });
    },
  });
}

export function useSendPushNotification(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      body?: string;
      imageUrl?: string;
      data?: Record<string, string>;
      segmentId?: string;
      deviceIdentityIds?: string[];
      scheduledAt?: string;
      /** Where a tap should land. Sent as the `deep_link_url` data key. */
      deepLinkUrl?: string;
      /** Data-only push: wakes the app without showing anything. */
      silent?: boolean;
      deliveryOptions?: PushDeliveryOptions;
      /** Split the send by recipient timezone instead of one instant. */
      deliverInRecipientTimezone?: boolean;
      /** `HH:MM` on the recipient's own clock. */
      localSendTime?: string;
      /** A/B experiment arms. Omit for an ordinary single-message campaign. */
      variants?: PushVariant[];
      /** Percentage of the audience held back and sent nothing, 0–50. */
      controlPercentage?: number;
      /**
       * Per-language copy. Not applied to experiments — a variant child
       * campaign never inherits it, so every recipient of an experiment gets
       * their assigned variant's own copy regardless of language.
       */
      translations?: PushTranslations;
      /** Repeat schedule. Each occurrence is spawned as its own campaign. */
      recurrence?: PushRecurrence;
      /**
       * Pick each recipient's hour from their own past clicks rather than one
       * fixed local time. Implies delivery in the recipient's timezone, so
       * `localSendTime` is ignored when this is set.
       */
      sendTimeOptimised?: boolean;
      /** Buttons under the notification. Android renders these directly. */
      actions?: PushAction[];
      /** APNs category naming the buttons the iOS app registered at launch. */
      iosCategory?: string;
      /** Images the recipient pages through. Rendered by the client SDK. */
      carousel?: PushCarouselSlide[];
      /** Countdown shown in the notification. Rendered by the client SDK. */
      timer?: PushTimer;
      /**
       * Template this content was composed from, recorded so the picker can
       * order by real use. The content itself travels in the fields above —
       * editing the template later cannot rewrite what this campaign said.
       */
      templateId?: string;
    }) =>
      apiPost<PushNotificationLog>('/api/push-notifications/send', {
        projectId,
        ...data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-logs', projectId] });
    },
  });
}

export function usePushLogs(
  projectId: string | undefined,
  /** Campaigns of one channel. The push page asks for push only. */
  channel: MessageChannel = 'push',
) {
  return useQuery<{ data: PushNotificationLog[]; total: number }>({
    queryKey: ['push-logs', projectId, channel],
    queryFn: () =>
      apiGet<{ data: PushNotificationLog[]; total: number }>(
        `/api/push-notifications/logs/${projectId}`,
        { channel },
      ),
    enabled: !!projectId,
    // Campaigns now complete in the worker, so the list has to be pulled until
    // every row reaches a terminal status.
    refetchInterval: (query) =>
      query.state.data?.data.some((log) => ACTIVE_STATUSES.includes(log.status))
        ? 3000
        : false,
  });
}

/**
 * Sends to every device belonging to one identified user.
 *
 * Keyed by `distinctId`, matching `SendToUserDto`. It previously sent
 * `externalUserId`, which the API does not accept — with
 * `forbidNonWhitelisted: true` that request could only ever 400, and nothing
 * in the dashboard called it, so the break went unnoticed.
 */
export function useSendPushToUser(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      distinctId: string;
      title: string;
      body?: string;
      imageUrl?: string;
      data?: Record<string, string>;
    }) =>
      apiPost<PushNotificationLog>('/api/push-notifications/send-to-user', {
        projectId,
        ...data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-logs', projectId] });
    },
  });
}

/**
 * How many devices a campaign would reach, without sending.
 *
 * A mutation rather than a query because the audience is described by a body
 * (a segment id or a device list), and because it must only run when the user
 * actually changes the target — not on every re-render of the dialog.
 */
export function useAudiencePreview(projectId: string) {
  return useMutation({
    mutationFn: (target: { segmentId?: string; deviceIdentityIds?: string[] }) =>
      apiPost<AudiencePreview>('/api/push-notifications/audience-preview', {
        projectId,
        ...target,
      }),
  });
}

/** Sends to a single token and reports the outcome inline. */
export function useTestSendPush(projectId: string) {
  return useMutation({
    mutationFn: (input: {
      token: string;
      title?: string;
      body?: string;
      dryRun?: boolean;
    }) =>
      apiPost<TestSendResult>('/api/push-notifications/test-send', {
        projectId,
        ...input,
      }),
  });
}

/**
 * Full engagement breakdown for one campaign. The list carries delivered,
 * clicks and CTR; impressions and dismissals are only surfaced here.
 */
export function useCampaignReport(
  projectId: string | undefined,
  campaignId: string | null,
) {
  return useQuery<CampaignEngagement>({
    queryKey: ['push-campaign-report', projectId, campaignId],
    queryFn: () =>
      apiGet<CampaignEngagement>(
        `/api/push-notifications/report/${projectId}/${campaignId}`,
      ),
    enabled: !!projectId && !!campaignId,
  });
}

/** Cancels a campaign that has not been dispatched yet. */
export function useCancelScheduledPush(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (campaignId: string) =>
      apiPost<PushNotificationLog>(
        `/api/push-notifications/cancel/${projectId}/${campaignId}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-logs', projectId] });
    },
  });
}

/**
 * One campaign by id.
 *
 * Not derived from `usePushLogs`: that is paginated at 50, so any older
 * campaign rendered as "not found" despite existing, and the detail page held
 * the whole list and inherited its poll-while-active refetch.
 */
export function useCampaign(
  projectId: string | undefined,
  campaignId: string | undefined,
) {
  return useQuery<PushNotificationLog>({
    queryKey: ['push-campaign', projectId, campaignId],
    queryFn: () =>
      apiGet<PushNotificationLog>(
        `/api/push-notifications/campaign/${projectId}/${campaignId}`,
      ),
    enabled: !!projectId && !!campaignId,
    retry: false,
    // Only poll while the campaign is still moving.
    refetchInterval: (query) =>
      query.state.data && ACTIVE_STATUSES.includes(query.state.data.status)
        ? 3000
        : false,
  });
}

export interface ExperimentArm {
  variantKey: string;
  campaignId: string;
  recipients: number;
  accepted: number;
  engagement: CampaignEngagement;
}

export interface ExperimentReport {
  isExperiment: boolean;
  controlSize: number;
  arms: ExperimentArm[];
  /** Null until the evidence supports naming one — do not derive this client-side. */
  leader: string | null;
  /** Human-readable summary, always present, including "not enough data" cases. */
  verdict: string;
}

/**
 * A/B arm comparison for a campaign that was split into variants.
 *
 * `isExperiment` is `false` for an ordinary campaign, so callers can gate the
 * whole section on it without inferring anything from `arms.length`.
 */
export function useExperimentReport(
  projectId: string | undefined,
  campaignId: string | undefined,
) {
  return useQuery<ExperimentReport>({
    queryKey: ['push-experiment-report', projectId, campaignId],
    queryFn: () =>
      apiGet<ExperimentReport>(
        `/api/push-notifications/experiment/${projectId}/${campaignId}`,
      ),
    enabled: !!projectId && !!campaignId,
  });
}

/**
 * Devices the project has stopped being able to reach, over a window.
 *
 * Deliberately not "uninstalls". A provider returns UNREGISTERED for an
 * uninstall, for cleared app storage and for a rotated token alike, and never
 * says which — so `providerRejected` is a signal, not a count of lost users.
 */
export interface ReachabilityLosses {
  activeTokens: number;
  /** Tokens the provider rejected. Includes rotations, so an upper bound. */
  providerRejected: number;
  /**
   * Rejected tokens whose device holds no live token now. A rotation would
   * have left a newer active row, so excluding those removes the largest
   * known source of false positives. A lower bound on churn, not a census.
   */
  likelyUninstalls: number;
  /** Logouts and opt-outs. Never churn — the app is still installed. */
  appRequested: number;
  sinceDays: number;
  daily: Array<{ date: string; likelyUninstalls: number }>;
}

export function useReachabilityLosses(
  projectId: string | undefined,
  days = 30,
) {
  return useQuery<ReachabilityLosses>({
    queryKey: ['push-reachability', projectId, days],
    queryFn: () =>
      apiGet<ReachabilityLosses>(
        `/api/push-notifications/reachability/${projectId}?days=${days}`,
      ),
    enabled: !!projectId,
  });
}

/**
 * One frame of a carousel.
 *
 * Rendered by the client, not the push provider — none of them carry a
 * carousel — so a recipient on an older app build sees an ordinary
 * notification rather than nothing.
 */
export interface PushCarouselSlide {
  imageUrl: string;
  caption?: string;
  /** Falls back to the campaign's own deep link when blank. */
  deepLinkUrl?: string;
}

/**
 * A countdown shown in the notification. Client-rendered.
 *
 * Exactly one of `endsAt` or `durationSeconds`. A fixed end is right for a real
 * deadline everyone shares — a launch, an event. A duration is right for
 * anything that sends more than once, because a recurring occurrence or a
 * later timezone wave would arrive past a fixed instant; it is resolved
 * against each send, so the device still gets one absolute moment.
 */
export interface PushTimer {
  /** ISO 8601. Must be after the campaign is sent, not after it is composed. */
  endsAt?: string;
  /** Measured from whenever each send goes out. */
  durationSeconds?: number;
  expiredTitle?: string;
  expiredBody?: string;
}

/** Shorter than this and the countdown is over before it is read. */
export const MIN_TIMER_DURATION_SECONDS = 60;

export const MIN_CAROUSEL_SLIDES = 2;
export const MAX_CAROUSEL_SLIDES = 10;

/** One campaign that reached a person, with what they did with it. */
export interface PersonCampaign {
  campaignId: string;
  title: string;
  sentAt: string | null;
  /**
   * When each outcome last happened across the person's devices. Null means it
   * did not happen — not zero, and not unknown: these are reported by the
   * device, so a null delivered on a recent campaign usually means the push
   * never arrived.
   */
  delivered: string | null;
  impression: string | null;
  clicked: string | null;
  dismissed: string | null;
}

export interface PersonPushHistory {
  /** How many devices this person's history was gathered from. */
  deviceCount: number;
  campaigns: PersonCampaign[];
}

/**
 * Every campaign that reached one person.
 *
 * Keyed by a device identity, but covers everything that identity's owner
 * holds — a person on a phone and a tablet is two identity rows, and a
 * campaign delivered to either reached them.
 */
export function usePersonPushHistory(
  projectId: string | undefined,
  personId: string | undefined,
) {
  return useQuery<PersonPushHistory>({
    queryKey: ['push-person-history', projectId, personId],
    queryFn: () =>
      apiGet<PersonPushHistory>(
        `/api/push-notifications/history/${projectId}/${personId}`,
      ),
    enabled: !!projectId && !!personId,
  });
}

/** Delivery channels, as the API names them. */
export type PushChannel =
  | 'fcm'
  | 'apns'
  | 'mi_push'
  | 'huawei'
  | 'oppo'
  | 'vivo'
  | 'honor';

/**
 * Which Mi Push host a project's traffic goes to.
 *
 * Not cosmetic: sending Indian traffic to the global host fails for real
 * users, and Xiaomi gives no hint that the region is the reason.
 */
export type MiPushRegion = 'india' | 'global' | 'eea' | 'russia';

export interface MiPushCredentialsInput {
  appSecret: string;
  /** The host app's package name; Xiaomi rejects a send without it. */
  packageName: string;
  region: MiPushRegion;
}

export interface ProjectChannels {
  /** Channels this project has credentials for. */
  configured: PushChannel[];
  /** Channels this deployment can deliver on at all. */
  supported: PushChannel[];
}

/**
 * What a project can send on, and what it is set up to send on.
 *
 * Both halves matter: a channel can be supported but unconfigured, and after a
 * downgrade configured but no longer supported.
 */
export function useProjectChannels(projectId: string | undefined) {
  return useQuery<ProjectChannels>({
    queryKey: ['push-channels', projectId],
    queryFn: () =>
      apiGet<ProjectChannels>(`/api/push-notifications/channels/${projectId}`),
    enabled: !!projectId,
  });
}

/**
 * Stores credentials for one channel.
 *
 * The credentials travel as a JSON string because each channel's shape is its
 * own — FCM a service account, Mi Push a secret and a package name — and the
 * API hands the blob to whichever provider owns that format to validate.
 */
export function useConfigureChannel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      credentials,
    }: {
      provider: PushChannel;
      credentials: Record<string, unknown>;
    }) =>
      apiPost<{ provider: PushChannel; configured: true }>(
        '/api/push-notifications/channels/credentials',
        { projectId, provider, credentials: JSON.stringify(credentials) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-channels', projectId] });
    },
  });
}

/** Project-level delivery guardrails, as the settings form submits them. */
export interface PushSettingsInput {
  frequencyCapPerDay: number | null;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  maxSendsPerMinute: number | null;
}

/**
 * Updates project-level delivery guardrails.
 *
 * Every field is required, not optional: the API assigns each one as
 * `dto.field ?? null`, so this is a whole-object replace. Submitting a
 * partial would read as "leave the rest alone" and in fact clear it —
 * saving a frequency cap would silently switch quiet hours off.
 */
export function useUpdatePushSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: PushSettingsInput) =>
      apiPost<PushSettingsInput>(
        '/api/push-notifications/settings',
        { projectId, ...settings },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['push-config-status', projectId] });
    },
  });
}

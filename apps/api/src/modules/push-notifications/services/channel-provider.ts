import { PushProvider } from '../../push-tokens/entities/push-token.entity';
import { PushCarouselSlide, PushTimer } from '../rich-content';
import {
  PushAction,
  PushDeliveryOptions,
} from '../entities/push-notification-log.entity';

/**
 * What a campaign says, independent of how it is delivered.
 *
 * Every field here is something the marketer chose. Nothing in it is a wire
 * format: FCM's `android`/`apns`/`webpush` blocks, and whatever a vendor
 * channel wants instead, are built by the provider that speaks that protocol.
 * Keeping that translation behind the interface is what stops the campaign
 * worker growing a branch per vendor.
 */
export interface CampaignMessage {
  title: string;
  body?: string;
  data?: Record<string, string>;
  imageUrl?: string;
  /**
   * Travels with the message so a device can report which campaign it is
   * engaging with. Without it a click is an orphan event and no campaign can
   * report a click-through rate.
   */
  campaignId?: string;
  /** Where a tap should land. Every channel carries it as a data key. */
  deepLinkUrl?: string;
  /** Data-only: suppresses the notification block entirely. */
  silent?: boolean;
  options?: PushDeliveryOptions;
  /** Buttons under the notification. Android renders them from the payload. */
  actions?: PushAction[];
  /** APNs category the iOS app registered; the only way iOS shows buttons. */
  iosCategory?: string;
  /** Images the recipient pages through. Rendered by the client. */
  carousel?: PushCarouselSlide[];
  /** Countdown shown in the notification. Rendered by the client. */
  timer?: PushTimer;
}

/**
 * Data keys the client SDKs read. Shared across channels rather than owned by
 * FCM: a vendor channel delivering the same campaign must use the same keys,
 * or the SDK stops recognising its own notifications.
 */
export const ACTIONS_DATA_KEY = 'chumbaq_actions';
export const CAMPAIGN_ID_DATA_KEY = 'chumbaq_campaign_id';
export const DEEP_LINK_DATA_KEY = 'deep_link_url';
/**
 * The campaign's image, for clients that have to attach one themselves.
 *
 * Every channel sends this, FCM included. FCM's `notification.image` renders
 * natively on Android only — Apple has no image field whatever carries the
 * push, so on iOS the picture is attached by the app's Notification Service
 * Extension, which reads this key and is only woken when `mutable-content` is
 * set. Mi Push has no image parameter at all. So the one key plus
 * `mutable-content` is what makes an image appear on iOS, and FCM omitting
 * either is what made rich campaigns land there as plain text.
 */
export const IMAGE_DATA_KEY = 'chumbaq_image_url';
/**
 * Rich content no provider carries natively, so the client renders it.
 *
 * A client that does not know these keys ignores them and shows an ordinary
 * notification, which is why a campaign using them is still worth sending to
 * an older app.
 */
export const CAROUSEL_DATA_KEY = 'chumbaq_carousel';
export const TIMER_DATA_KEY = 'chumbaq_timer';

export interface ChannelFailure {
  token: string;
  error: string;
  /**
   * The channel's own machine-readable code, so callers can branch on it
   * instead of pattern-matching a response body. Which codes mean "this token
   * is dead" is per-channel knowledge and belongs to the provider.
   */
  errorCode?: string;
  /** Always false at the boundary: a retryable failure never reaches callers. */
  retryable: boolean;
}

export interface ChannelSendResult {
  /**
   * Counts and failures cover only the resolved prefix — the leading run of
   * recipients whose outcome is final. Anything after that is deliberately
   * unreported: see `resolvedCount`.
   */
  successCount: number;
  failureCount: number;
  failures: ChannelFailure[];
  /**
   * How many leading recipients reached a final outcome. When this is less
   * than the number passed in, the caller MUST NOT record progress beyond it —
   * a recipient still failing retryably has not been given up on, and skipping
   * it drops them with nothing left to retry.
   *
   * Every provider must honour this. It is what makes a campaign resumable
   * after a crash without either losing or double-sending recipients.
   */
  resolvedCount: number;
  /** Why the resolved run stopped short, or null when everything resolved. */
  retryReason: string | null;
}

/**
 * One recipient and the message it should receive.
 *
 * `token` is whatever address the channel delivers to: a device token for
 * push, an email address for email. Failures are reported against it, so it
 * must be the exact string the provider was handed.
 */
export interface ChannelRecipient<TMessage = CampaignMessage> {
  token: string;
  message: TMessage;
}

export interface ChannelSendOptions {
  /** Ask the channel to validate without delivering, where it supports it. */
  dryRun?: boolean;
}

/**
 * A way to deliver a campaign on some channel.
 *
 * Implementations own their credential format and their wire format, and
 * nothing else may depend on either. The contract that matters is
 * `ChannelSendResult`: a provider that reports a resolved recipient it has not
 * actually finished with will silently drop people from campaigns, which is
 * why every provider — push or email — is held to the same conformance suite.
 *
 * Generic over the message, because what a campaign says differs by channel
 * (a notification has a title and buttons, an email has a subject and HTML),
 * while everything the worker relies on — the resolved prefix, per-recipient
 * failures, paste-time validation — does not.
 */
export interface DeliveryProvider<TMessage, TName extends string = string> {
  readonly provider: TName;

  /**
   * Delivers to a page of recipients, each with its own message — copy is
   * personalised and translated per recipient before it gets here.
   */
  sendToRecipients(
    credentials: unknown,
    recipients: ChannelRecipient<TMessage>[],
    options?: ChannelSendOptions,
  ): Promise<ChannelSendResult>;

  /**
   * Checks stored credentials are usable, so a bad key is rejected when it is
   * pasted rather than discovered by a campaign that reaches nobody.
   */
  validateCredentials(credentials: unknown): Promise<void>;
}

/** A push channel: FCM, APNs, or an OEM vendor service. */
export type ChannelProvider = DeliveryProvider<CampaignMessage, PushProvider>;

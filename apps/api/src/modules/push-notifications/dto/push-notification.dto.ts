import {
  IsString,
  IsUUID,
  IsOptional,
  IsObject,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsDateString,
  Min,
  Max,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CLIENT_REPORTABLE_EVENT_TYPES,
  PushEventType,
} from '../entities/push-notification-event.entity';
import { Type } from 'class-transformer';
import { ValidateNested, IsNumber } from 'class-validator';
import { MAX_CONTROL_PERCENTAGE } from '../variant-assignment';
import { PushRecurrence } from '../recurrence';
import { PushCarouselSlide, PushTimer } from '../rich-content';
import {
  PUSH_PROVIDERS,
  PushProvider,
} from '../../push-tokens/entities/push-token.entity';
import { PushTranslations } from '../push-personalisation';
import { PushAction } from '../entities/push-notification-log.entity';

/**
 * One experiment arm.
 *
 * A declared class, not an inline object type. The global ValidationPipe runs
 * with `whitelist: true`, which strips every property from a nested object it
 * has no type for — an untyped `variants` array arrived as `[{}, {}]` and the
 * arms lost their copy entirely.
 */
/**
 * A notification button, as it arrives over the wire.
 *
 * Declared as its own class for the same reason `PushVariantDto` is: the
 * global pipe runs with `enableImplicitConversion`, which coerces each element
 * of an undeclared object array into an array. Without this, every campaign's
 * action buttons arrived as `[[]]` and were silently dropped.
 */
export class PushActionDto {
  @IsString()
  @MaxLength(64)
  id: string;

  @IsString()
  @MaxLength(64)
  title: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  deepLinkUrl?: string;
}

/** One carousel frame. Typed for the same reason as PushActionDto. */
export class PushCarouselSlideDto {
  @IsString()
  @MaxLength(2048)
  imageUrl: string;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  caption?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  deepLinkUrl?: string;
}

export class PushVariantDto {
  @IsString()
  @MaxLength(16)
  key: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  imageUrl?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  deepLinkUrl?: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  weight: number;

  /** Per-language copy for this arm. Campaign-level translations do not apply. */
  @IsObject()
  @IsOptional()
  translations?: PushTranslations;
}

/**
 * Credentials for one delivery channel.
 *
 * Generic rather than a field per vendor: each channel's credentials are its
 * own shape — FCM takes a service account JSON, Mi Push an app secret and a
 * package name — so the payload is opaque here and validated by the provider
 * that owns the format.
 */
export class ConfigureChannelDto {
  @IsUUID()
  projectId: string;

  @IsIn(PUSH_PROVIDERS as unknown as string[])
  provider: PushProvider;

  /**
   * The channel's credentials, as JSON. Stored encrypted and never returned.
   */
  @IsString()
  credentials: string;
}

export class ConfigurePushDto {
  @IsUUID()
  projectId: string;

  @IsString()
  fcmServiceAccountJson: string;
}

export class SendPushNotificationDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsObject()
  @IsOptional()
  data?: Record<string, string>;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  imageUrl?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  deviceIdentityIds?: string[];

  @IsUUID()
  @IsOptional()
  segmentId?: string;

  /**
   * When to dispatch. Omitted or in the past means immediately.
   */
  @IsDateString()
  @IsOptional()
  scheduledAt?: string;

  /** Where a tap should land. Emitted as the `deep_link_url` data key. */
  @IsString()
  @MaxLength(2048)
  @IsOptional()
  deepLinkUrl?: string;

  /** Data-only push: wakes the app without showing anything. */
  @IsBoolean()
  @IsOptional()
  silent?: boolean;

  @IsObject()
  @IsOptional()
  deliveryOptions?: Record<string, unknown>;

  /**
   * Deliver at `localSendTime` on each recipient's own clock instead of at one
   * instant for everyone. The campaign is split into one send per timezone.
   */
  @IsBoolean()
  @IsOptional()
  deliverInRecipientTimezone?: boolean;

  /** `HH:MM`, 24-hour, on the recipient's wall clock. */
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'localSendTime must be HH:MM in 24-hour form',
  })
  @IsOptional()
  localSendTime?: string;

  /**
   * Experiment arms. Shape and weights are checked in the service by
   * `validateVariants`, which is where the "weights total 100" rule lives —
   * class-validator cannot express a cross-field sum.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushVariantDto)
  @IsOptional()
  variants?: PushVariantDto[];

  /** Percentage held back and sent nothing, for comparison. */
  @IsInt()
  @Min(0)
  @Max(MAX_CONTROL_PERCENTAGE)
  @IsOptional()
  controlPercentage?: number;

  /**
   * Repeat schedule. Shape is checked by `validateRecurrence` in the service,
   * which is where the cross-field rules live.
   */
  @IsObject()
  @IsOptional()
  recurrence?: PushRecurrence;

  /**
   * Per-language copy keyed by language tag, e.g. `{ "hi": { title, body } }`.
   * The campaign's own title and body stay the default.
   */
  @IsObject()
  @IsOptional()
  translations?: PushTranslations;

  /**
   * Pick each recipient's hour from their own past clicks instead of one
   * fixed local time. Implies delivery in the recipient timezone.
   */
  @IsBoolean()
  @IsOptional()
  sendTimeOptimised?: boolean;

  /** Buttons under the notification. Android renders these directly. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushActionDto)
  @IsOptional()
  actions?: PushAction[];

  /** APNs category naming actions the iOS app registered at launch. */
  @IsString()
  @MaxLength(64)
  @IsOptional()
  iosCategory?: string;

  /**
   * Template this campaign was composed from.
   *
   * Recorded so a template can show how often it is actually used, which is
   * what orders the picker. The content itself is sent in the fields above —
   * the server never re-reads the template, so editing one later cannot
   * retroactively change what a campaign said.
   */
  @IsUUID()
  @IsOptional()
  templateId?: string;

  /**
   * Images the recipient can page through. Shape is checked by
   * `validateCarousel` in the service, where the cross-field rules live.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushCarouselSlideDto)
  @IsOptional()
  carousel?: PushCarouselSlide[];

  /** Countdown shown in the notification. Checked by `validateTimer`. */
  @IsObject()
  @IsOptional()
  timer?: PushTimer;
}

export class SendToUserDto {
  @IsUUID()
  projectId: string;

  @IsString()
  distinctId: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsObject()
  @IsOptional()
  data?: Record<string, string>;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  imageUrl?: string;
}

/**
 * Proves a project's FCM setup against one known device before anyone trusts a
 * campaign to it. With `dryRun` FCM validates the message and the credentials
 * without delivering anything, so this is safe to run against a real token.
 */
export class TestSendPushDto {
  @IsUUID()
  projectId: string;

  @IsString()
  token: string;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsBoolean()
  @IsOptional()
  dryRun?: boolean;
}

/** Resolves how many devices a campaign would reach, without sending anything. */
export class PreviewAudienceDto {
  @IsUUID()
  projectId: string;

  @IsUUID()
  @IsOptional()
  segmentId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  deviceIdentityIds?: string[];
}

/** Reported by a client SDK when a notification is received or acted on. */
export class RecordPushEventDto {
  @IsUUID()
  projectId: string;

  @IsUUID()
  campaignId: string;

  @IsString()
  deviceFingerprint: string;

  // Not PUSH_EVENT_TYPES: `sent` is server-written and must not be forgeable
  // by a client, since frequency capping counts it.
  @IsIn(CLIENT_REPORTABLE_EVENT_TYPES)
  type: PushEventType;

  @IsString()
  @IsOptional()
  platform?: string;

  /**
   * When it happened on the device. A click made offline is only reported once
   * connectivity returns, so server receipt time would be wrong.
   */
  @IsDateString()
  @IsOptional()
  occurredAt?: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}

/** Project-level delivery guardrails. */
export class UpdatePushSettingsDto {
  @IsUUID()
  projectId: string;

  /**
   * Most campaigns one device may be sent in a rolling 24 hours. Null clears
   * the cap; the server then also stops recording per-recipient send rows.
   */
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  frequencyCapPerDay?: number | null;

  /** Start of the do-not-disturb window on the recipient's clock, `HH:MM`. */
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'quietHoursStart must be HH:MM in 24-hour form',
  })
  @IsOptional()
  quietHoursStart?: string | null;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'quietHoursEnd must be HH:MM in 24-hour form',
  })
  @IsOptional()
  quietHoursEnd?: string | null;

  /** Ceiling on delivery speed, messages per minute. Null sends at full rate. */
  @IsInt()
  @Min(1)
  @IsOptional()
  maxSendsPerMinute?: number | null;
}

/** Saved campaign content, reusable across sends. */
export class CreatePushTemplateDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  imageUrl?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  deepLinkUrl?: string;

  @IsObject()
  @IsOptional()
  data?: Record<string, string>;

  @IsBoolean()
  @IsOptional()
  silent?: boolean;

  @IsObject()
  @IsOptional()
  deliveryOptions?: Record<string, unknown>;

  @IsObject()
  @IsOptional()
  translations?: PushTranslations;

  /**
   * The same rich content a campaign carries, so a template can reproduce
   * every layout rather than only text and image.
   *
   * `@Type` on both arrays is not optional decoration: the global pipe runs
   * with `enableImplicitConversion`, which coerces each element of an
   * undeclared object array into an array. Without it these arrive as `[[]]`.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushActionDto)
  @IsOptional()
  actions?: PushAction[];

  @IsString()
  @MaxLength(64)
  @IsOptional()
  iosCategory?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushCarouselSlideDto)
  @IsOptional()
  carousel?: PushCarouselSlide[];

  /** Shape is checked by `validateTimer` in the service. */
  @IsObject()
  @IsOptional()
  timer?: PushTimer;
}

/** Every field optional; only what is supplied is changed. */
export class UpdatePushTemplateDto {
  @IsString()
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  imageUrl?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  deepLinkUrl?: string;

  @IsObject()
  @IsOptional()
  data?: Record<string, string>;

  @IsBoolean()
  @IsOptional()
  silent?: boolean;

  @IsObject()
  @IsOptional()
  deliveryOptions?: Record<string, unknown>;

  @IsObject()
  @IsOptional()
  translations?: PushTranslations;

  /**
   * The same rich content a campaign carries, so a template can reproduce
   * every layout rather than only text and image.
   *
   * `@Type` on both arrays is not optional decoration: the global pipe runs
   * with `enableImplicitConversion`, which coerces each element of an
   * undeclared object array into an array. Without it these arrive as `[[]]`.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushActionDto)
  @IsOptional()
  actions?: PushAction[];

  @IsString()
  @MaxLength(64)
  @IsOptional()
  iosCategory?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushCarouselSlideDto)
  @IsOptional()
  carousel?: PushCarouselSlide[];

  /** Shape is checked by `validateTimer` in the service. */
  @IsObject()
  @IsOptional()
  timer?: PushTimer;
}

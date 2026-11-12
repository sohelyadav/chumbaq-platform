import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { PushVariant } from '../variant-assignment';
import { PushRecurrence } from '../recurrence';
import { PushCarouselSlide, PushTimer } from '../rich-content';
import { PushTranslations } from '../push-personalisation';
import { MessageChannel, EmailContent, WhatsAppContent } from '../message-channel';

/**
 * Transport-level options that FCM understands but that do not belong in the
 * message body. Stored as jsonb rather than a column each: they are optional,
 * rarely set, and the set of them tracks whatever FCM supports.
 */
export interface PushDeliveryOptions {
  /** `high` wakes the device promptly; `normal` may be batched to save battery. */
  priority?: 'normal' | 'high';
  /** How long FCM should keep trying before giving up. */
  ttlSeconds?: number;
  /** Messages sharing a key supersede one another while the device is offline. */
  collapseKey?: string;
  android?: {
    /** Required on Android 8+, or the notification is silently dropped. */
    channelId?: string;
    sound?: string;
  };
  ios?: {
    sound?: string;
    badge?: number;
    /** Groups notifications into one thread in the shade. */
    threadId?: string;
  };
  web?: {
    /** Icon shown in the browser notification. */
    icon?: string;
    /** Small monochrome badge, used by some platforms in the status bar. */
    badge?: string;
  };
}

/**
 * A tappable action rendered under the notification.
 *
 * Platforms differ sharply here: Android builds actions locally from data, so
 * the definitions travel in the payload; iOS can only show actions from a
 * category the app registered at launch, so the payload names the category and
 * the app owns the buttons. Both are expressed here, and each platform uses
 * what it can.
 */
export interface PushAction {
  /** Reported back with a click event, so a tap can be told from a button. */
  id: string;
  title: string;
  /** Where this button leads. Falls back to the notification's deep link. */
  deepLinkUrl?: string;
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

/** A campaign in one of these has finished; nothing may write to it again. */
export const TERMINAL_STATUSES: NotificationStatus[] = [
  'sent',
  'failed',
  'partial',
  'cancelled',
  // A parent that was split into per-timezone children. Nothing further
  // happens to the parent row itself, so it is terminal.
  'expanded',
];

/**
 * Campaigns a delivery job is expected to be moving right now.
 *
 * `scheduled` is deliberately NOT here, and the omission is load-bearing.
 * PushCampaignReconciliationScheduler sweeps exactly this list for rows whose
 * `updatedAt` has not moved in 15 minutes and marks them abandoned — so a
 * campaign scheduled for next week would be killed a quarter of an hour after
 * it was created. A scheduled campaign has no job yet by design; it is waiting
 * for its time, not stalled.
 */
export const NON_TERMINAL_STATUSES: NotificationStatus[] = [
  'queued',
  'sending',
];

@Entity('push_notification_logs')
export class PushNotificationLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  /**
   * Which channel this campaign is delivered on. Everything else about a
   * campaign — schedule, recurrence, timezone waves, experiment arms, the
   * resumable cursor — is shared; this decides only where recipients come
   * from and what the message looks like.
   */
  @Column({ type: 'varchar', length: 10, default: 'push' })
  channel: MessageChannel;

  /**
   * The email itself, for `channel = 'email'`. `title` mirrors the subject so
   * every list and report that reads `title` keeps working unchanged, and
   * `body` holds the plain-text part.
   */
  @Column({ type: 'jsonb', nullable: true, name: 'email_content' })
  emailContent: EmailContent | null;

  /**
   * The template and its values, for `channel = 'whatsapp'`. `title` holds a
   * label for lists and `body` the approved template text, so reports that
   * read either keep working.
   */
  @Column({ type: 'jsonb', nullable: true, name: 'whatsapp_content' })
  whatsappContent: WhatsAppContent | null;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  body: string;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, string>;

  @Column({ type: 'int', name: 'total_tokens', default: 0 })
  totalTokens: number;

  @Column({ type: 'int', name: 'success_count', default: 0 })
  successCount: number;

  @Column({ type: 'int', name: 'failure_count', default: 0 })
  failureCount: number;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status: NotificationStatus;

  /**
   * `error` is FCM's raw response body, kept verbatim because it is the only
   * full record of what went wrong. `errorCode` is the machine-readable code
   * pulled out of it at write time — without it every reader has to re-parse
   * an HTTP error envelope to say anything legible about a failure.
   */
  @Column({ type: 'jsonb', nullable: true, name: 'failure_details' })
  failureDetails: Array<{ token: string; error: string; errorCode?: string }>;

  /**
   * Count of recipients already attempted. Advanced once per batch.
   *
   * Push tokens for a push campaign, addresses for an email campaign — the
   * column predates the second channel and keeps its name.
   */
  @Column({ type: 'int', name: 'processed_tokens', default: 0 })
  processedTokens: number;

  /**
   * Keyset cursor — the id of the last push token attempted (or, for an
   * email campaign, of the last identity whose address was attempted). The worker resumes
   * from `id > lastTokenId`, which stays correct even as tokens are marked
   * inactive mid-campaign (an offset would skip rows).
   */
  @Column({ type: 'uuid', nullable: true, name: 'last_token_id' })
  lastTokenId: string | null;

  @Column({ type: 'varchar', length: 20, name: 'target_type', default: 'project' })
  targetType: 'project' | 'devices' | 'segment';

  @Column({ type: 'jsonb', nullable: true, name: 'target_device_ids' })
  targetDeviceIds: string[] | null;

  @Column({ type: 'uuid', nullable: true, name: 'segment_id' })
  segmentId: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'image_url' })
  imageUrl: string | null;

  /**
   * Where a tap should take the user. Emitted into the data payload as
   * `deep_link_url`, which the Android SDK already reads.
   */
  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'deep_link_url' })
  deepLinkUrl: string | null;

  /**
   * Data-only push: no notification is shown and the app is woken to handle
   * the payload itself. Suppressing the `notification` block is the only way
   * to get one — including it makes the OS display something regardless.
   */
  @Column({ type: 'boolean', default: false })
  silent: boolean;

  @Column({ type: 'jsonb', nullable: true, name: 'delivery_options' })
  deliveryOptions: PushDeliveryOptions | null;

  /** Buttons under the notification. Android renders these directly. */
  @Column({ type: 'jsonb', nullable: true })
  actions: PushAction[] | null;

  /**
   * APNs category naming a set of actions the iOS app registered at launch.
   *
   * iOS cannot be told about buttons in a payload, so this is the only way to
   * show them there — and it only works if the app already knows the category.
   */
  @Column({
    type: 'varchar',
    length: 64,
    nullable: true,
    name: 'ios_category',
  })
  iosCategory: string | null;

  /**
   * Rich content the client renders, because no provider carries it natively.
   *
   * Both travel as data keys, so a client that does not know them shows an
   * ordinary notification rather than nothing — which is why a campaign using
   * them is still worth sending to an older app, and why they are validated
   * before the campaign is saved rather than discovered on the device.
   */
  @Column({ type: 'jsonb', nullable: true })
  carousel: PushCarouselSlide[] | null;

  @Column({ type: 'jsonb', nullable: true })
  timer: PushTimer | null;

  /**
   * When this campaign should be dispatched. Null means immediately.
   *
   * The promotion sweep claims rows by `status = 'scheduled' AND scheduled_at
   * <= now()`, so this is the only thing standing between a campaign and its
   * queue job.
   *
   * `timestamptz`, unlike the audit timestamps elsewhere on this table. Those
   * only ever record when something already happened; this one is a promise
   * about a future instant. Stored without a zone it is really a wall-clock
   * reading, so moving the server — or running the API and worker in
   * different zones — would silently shift every pending campaign.
   */
  @Index()
  @Column({ type: 'timestamptz', nullable: true, name: 'scheduled_at' })
  scheduledAt: Date | null;

  /**
   * Deliver at `localSendTime` in each recipient's own timezone rather than at
   * one instant for everybody. The campaign is split into one child per
   * timezone, each with its own `scheduledAt`.
   */
  @Column({
    type: 'boolean',
    default: false,
    name: 'deliver_in_recipient_timezone',
  })
  deliverInRecipientTimezone: boolean;

  /**
   * Pick each recipient's send hour from their own past click times instead
   * of using one fixed `localSendTime`.
   *
   * Implies per-timezone delivery: an hour only means something on a known
   * clock, so this rides the same expansion.
   */
  @Column({
    type: 'boolean',
    default: false,
    name: 'send_time_optimised',
  })
  sendTimeOptimised: boolean;

  /** `HH:MM` on the recipient's wall clock. */
  @Column({
    type: 'varchar',
    length: 5,
    nullable: true,
    name: 'local_send_time',
  })
  localSendTime: string | null;

  /**
   * Set on a child produced by a local-time expansion.
   *
   * Children are ordinary campaigns — own cursor, own resume, own reporting —
   * which is why expansion reuses the whole delivery machinery unchanged
   * instead of teaching the keyset walk about timezones.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true, name: 'parent_campaign_id' })
  parentCampaignId: string | null;

  /**
   * Experiment arms. Null for an ordinary campaign.
   *
   * Set on the parent only; each child carries one arm's copy in its own
   * title/body/image fields, so a variant child is indistinguishable from a
   * normal campaign to everything downstream.
   */
  @Column({ type: 'jsonb', nullable: true })
  variants: PushVariant[] | null;

  /** Percentage of the audience deliberately sent nothing, for comparison. */
  @Column({ type: 'int', nullable: true, name: 'control_percentage' })
  controlPercentage: number | null;

  /**
   * Per-language copy, keyed by language tag.
   *
   * The campaign's own title and body remain the default: a recipient whose
   * language has no translation still receives the campaign rather than
   * nothing.
   */
  @Column({ type: 'jsonb', nullable: true })
  translations: PushTranslations | null;

  /**
   * A repeating schedule. Null for a one-off campaign.
   *
   * A recurring campaign is a template that stays `scheduled` forever: each
   * period it spawns one occurrence child and advances its own `scheduledAt`.
   * The occurrence is an ordinary campaign, so it can itself be split by
   * variant or timezone.
   */
  @Column({ type: 'jsonb', nullable: true })
  recurrence: PushRecurrence | null;

  /** Which arm this child is. Null on a parent and on ordinary campaigns. */
  @Column({ type: 'varchar', length: 16, nullable: true, name: 'variant_key' })
  variantKey: string | null;

  /**
   * The held-back slice, recorded on the parent.
   *
   * No child campaign exists for control — sending nothing is the point — so
   * this is the only record of who was withheld, and the report needs it to
   * measure conversions against.
   */
  @Column({ type: 'jsonb', nullable: true, name: 'control_device_ids' })
  controlDeviceIds: string[] | null;

  @Column({ type: 'timestamp', nullable: true, name: 'completed_at' })
  completedAt: Date | null;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'sent_at' })
  sentAt: Date;

  /**
   * Last time anything about this campaign changed — bumped by every batch
   * checkpoint, not just by the terminal write.
   *
   * `sentAt` records creation and `completedAt` only exists once the campaign
   * ends, so neither can distinguish a long campaign that is still making
   * progress from one whose worker died mid-flight. The reconciliation sweep
   * needs exactly that distinction.
   */
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

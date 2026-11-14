import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { PushNotificationLogEntity } from './push-notification-log.entity';

/**
 * What a device did with a notification.
 *
 * `sent` is written by the server when FCM accepts a message for a device —
 * the only per-recipient record of who a campaign actually went to, and what
 * frequency capping counts. Everything else is reported by the client.
 *
 * `delivered` is a different fact from `sent`: it means a handset received the
 * payload, which FCM accepting it does not guarantee.
 */
export type PushEventType =
  | 'sent'
  | 'delivered'
  | 'impression'
  | 'click'
  | 'dismissed'
  // Email only, reported by the provider rather than a device.
  | 'bounced'
  | 'complained';

export const PUSH_EVENT_TYPES: PushEventType[] = [
  'sent',
  'delivered',
  'impression',
  'click',
  'dismissed',
];

/**
 * What a device SDK is allowed to report.
 *
 * `sent` is excluded deliberately. It is written by the server when FCM
 * accepts a message, and it is what frequency capping counts — so accepting
 * it over the API-key-authenticated ingestion endpoint would let any client
 * forge its own cap history, or another device's.
 */
export const CLIENT_REPORTABLE_EVENT_TYPES: PushEventType[] = [
  'delivered',
  'impression',
  'click',
  'dismissed',
];

@Entity('push_notification_events')
// Usage roll-up: devices reached in a window, per project.
@Index('IDX_push_events_project_created', ['projectId', 'createdAt'])
// Reporting is at-least-once: a client that retries after a dropped response,
// or an OS that re-delivers on app restart, would otherwise inflate CTR. One
// row per device per event type makes ingestion idempotent and keeps the
// denominator honest. The cost is that repeat engagement is not counted —
// unique reach is the number a campaign is judged on, so that is the right
// trade here.
@Index(['campaignId', 'deviceIdentityId', 'type'], { unique: true })
// Serves the per-campaign rollup, which is the only read path that matters.
@Index(['campaignId', 'type'])
// Serves the frequency-cap lookup: "how many campaigns has this device been
// sent in the last day". Without it that is a sequential scan per candidate.
@Index(['deviceIdentityId', 'type', 'occurredAt'])
export class PushNotificationEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'uuid', name: 'campaign_id' })
  campaignId: string;

  @ManyToOne(() => PushNotificationLogEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaign_id' })
  campaign: PushNotificationLogEntity;

  /**
   * Which device reported it. Not a foreign key to push_tokens: a token can be
   * rotated or deactivated after the event, and losing the engagement record
   * when that happens would silently rewrite history.
   */
  @Column({ type: 'uuid', name: 'device_identity_id' })
  deviceIdentityId: string;

  @Column({ type: 'varchar', length: 20 })
  type: PushEventType;

  @Column({ type: 'varchar', length: 10, nullable: true })
  platform: string | null;

  /**
   * When the device says it happened, which can be well before it was
   * reported — a click while offline is only sent once connectivity returns.
   */
  @Column({ type: 'timestamp', name: 'occurred_at' })
  occurredAt: Date;

  /** Action button id, deep link followed, and similar client detail. */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

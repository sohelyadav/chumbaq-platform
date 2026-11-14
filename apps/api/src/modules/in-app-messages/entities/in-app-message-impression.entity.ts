import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { InAppMessageEntity } from './in-app-message.entity';

export type ImpressionEventType =
  | 'delivered'
  | 'impression'
  | 'click'
  | 'dismiss'
  | 'cta_click'
  | 'auto_dismiss'
  | 'expired';

@Entity('in_app_message_impressions')
// Usage roll-up: impressions received in a window, per project.
@Index('IDX_in_app_impressions_project_created', ['projectId', 'createdAt'])
@Index(['messageId', 'deviceFingerprint'])
@Index(['messageId', 'eventType'])
@Index(['projectId', 'deviceFingerprint', 'createdAt'])
export class InAppMessageImpressionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'message_id' })
  messageId: string;

  @ManyToOne(() => InAppMessageEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id' })
  message: InAppMessageEntity;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'uuid', nullable: true, name: 'device_identity_id' })
  deviceIdentityId: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'distinct_id' })
  distinctId: string | null;

  @Column({ type: 'varchar', length: 255, name: 'device_fingerprint' })
  deviceFingerprint: string;

  @Column({ type: 'varchar', length: 30, name: 'event_type' })
  eventType: ImpressionEventType;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'button_id' })
  buttonId: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  platform: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

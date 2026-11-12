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

export type PendingStatus = 'pending' | 'delivered' | 'expired';

@Entity('pending_in_app_messages')
@Index(['projectId', 'deviceFingerprint', 'status'])
@Index(['messageId', 'status'])
@Index(['expiresAt'])
export class PendingMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'message_id' })
  messageId: string;

  @ManyToOne(() => InAppMessageEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id' })
  message: InAppMessageEntity;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 255, name: 'device_fingerprint' })
  deviceFingerprint: string;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'distinct_id' })
  distinctId: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: PendingStatus;

  @Column({ type: 'timestamp', name: 'expires_at' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

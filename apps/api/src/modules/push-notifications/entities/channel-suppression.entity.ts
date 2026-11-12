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
import { MessageChannel } from '../message-channel';

export const SUPPRESSION_REASONS = [
  'unsubscribed',
  'bounced',
  'complained',
  'manual',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * An address that must not be messaged on a channel.
 *
 * Keyed on the address, not on a person: an unsubscribe or a hard bounce is a
 * statement about an inbox, and it has to hold for every identity that later
 * reports the same address — a reinstall, a second device, a new account.
 *
 * Checked inside the SQL that selects recipients, so no send path can forget
 * it. Shared by every addressed channel; SMS suppresses E.164 phone
 * numbers here under `channel = 'sms'`.
 */
@Entity('channel_suppressions')
@Index(['projectId', 'channel', 'address'], { unique: true })
export class ChannelSuppressionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 10 })
  channel: MessageChannel;

  /** Normalised as the channel's recipient column is: `email`, or `phone_e164` for SMS. */
  @Column({ type: 'varchar', length: 320 })
  address: string;

  @Column({ type: 'varchar', length: 20 })
  reason: SuppressionReason;

  /** Where the suppression came from: `link`, `dashboard`, or the provider (`ses`, `twilio`, ...). */
  @Column({ type: 'varchar', length: 20 })
  source: string;

  /** The provider's own description, for a bounce or complaint. */
  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import type { MessageChannel } from '../../push-notifications/message-channel';
import type { SuppressionReason } from '../../push-notifications/entities/channel-suppression.entity';

/**
 * A suppression that outlived the erasure of the person it belonged to.
 *
 * `channel_suppressions` holds addresses in the clear, which is personal data
 * the erasure has to remove; but an address that unsubscribed, bounced or
 * complained must stay unmessageable if the customer later imports it again.
 * So erasure moves each such row here as a keyed hash, which names nobody, and
 * `ErasedSuppressionsService.restore` turns it back into a clear suppression
 * the moment the address reappears in the project (identify is the only
 * writer of `device_identities.email` / `phone_e164`).
 *
 * `address_hash` is HMAC-SHA256 over `projectId \n channel \n address`
 * (`PrivacyHashService.suppressionHash`), so the same address in two projects
 * hashes differently and nothing here can be joined across tenants.
 */
@Entity('erased_suppressions')
@Index(['projectId', 'channel', 'addressHash'], { unique: true })
export class ErasedSuppressionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 10 })
  channel: MessageChannel;

  @Column({ type: 'varchar', length: 64, name: 'address_hash' })
  addressHash: string;

  @Column({ type: 'varchar', length: 20 })
  reason: SuppressionReason;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

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
import { ChannelProviderName } from '../message-channel';

/**
 * One project's credentials for one delivery channel.
 *
 * A row per provider rather than a column trio per provider on `push_configs`:
 * five vendors would be fifteen columns, and every channel added would rewrite
 * the entity and its migration. Project-level delivery settings — frequency
 * cap, quiet hours, rate limit — stay on `push_configs`, because they describe
 * the project's sending policy rather than any one channel.
 */
@Entity('push_channel_credentials')
@Index(['projectId', 'provider'], { unique: true })
export class PushChannelCredentialEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 20 })
  provider: ChannelProviderName;

  /** AES-256-GCM, same scheme as the FCM columns this replaces. */
  @Column({ type: 'text', name: 'credentials_encrypted' })
  credentialsEncrypted: string;

  @Column({ type: 'varchar', length: 32, name: 'credentials_iv' })
  credentialsIv: string;

  @Column({ type: 'varchar', length: 32, name: 'credentials_tag' })
  credentialsTag: string;

  /**
   * Lets a channel be switched off without discarding its credentials, so
   * turning it back on does not mean re-uploading a service account.
   */
  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

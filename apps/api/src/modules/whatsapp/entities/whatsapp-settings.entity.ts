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
import { WhatsAppProviderName } from '../../push-notifications/message-channel';

/**
 * How a project sends WhatsApp: through which of its own provider accounts.
 *
 * The sender (phone number id, source number, app) is part of each
 * provider's credentials rather than a column here, because every provider
 * names it differently and none can be used without the rest. Credentials
 * are encrypted in `push_channel_credentials` like every other channel's.
 */
@Entity('whatsapp_settings')
@Index(['projectId'], { unique: true })
@Index(['webhookToken'], { unique: true })
export class WhatsAppSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  /** The provider campaigns go out through. Null until one is connected. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  provider: WhatsAppProviderName | null;

  /**
   * Only message people whose `whatsapp_opt_in` is true. Defaults to true:
   * Meta's WhatsApp Business Policy requires opt-in before a business
   * messages someone, and accounts that ignore it get their quality rating
   * and messaging limits cut.
   */
  @Column({ type: 'boolean', default: true, name: 'require_opt_in' })
  requireOptIn: boolean;

  /**
   * Unguessable path segment in the webhook URL. Finds the project; it is
   * also the verify token Meta's subscription handshake echoes back.
   */
  @Column({ type: 'varchar', length: 64, name: 'webhook_token' })
  webhookToken: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

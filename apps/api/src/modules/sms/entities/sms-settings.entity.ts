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
import { SmsProviderName } from '../../push-notifications/message-channel';

/**
 * How a project sends SMS: through which of its own provider accounts, and
 * from which sender.
 *
 * Credentials are not here. They sit in `push_channel_credentials` under the
 * provider's name, encrypted like every other channel's.
 */
@Entity('sms_settings')
@Index(['projectId'], { unique: true })
@Index(['webhookToken'], { unique: true })
export class SmsSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  /** The provider campaigns go out through. Null until one is connected. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  provider: SmsProviderName | null;

  /**
   * Who the texts come from: an E.164 number the account owns, an
   * alphanumeric sender ID (where the destination country allows one), or a
   * Twilio Messaging Service SID (`MG...`).
   */
  @Column({ type: 'varchar', length: 40 })
  sender: string;

  /**
   * Only text people whose `sms_opt_in` is true. When false, everyone not
   * explicitly opted out is eligible.
   *
   * Defaults to true, and should almost always stay true: the US TCPA, the
   * UK PECR and India's TRAI rules all require prior consent for marketing
   * texts, with per-message penalties.
   */
  @Column({ type: 'boolean', default: true, name: 'require_opt_in' })
  requireOptIn: boolean;

  /**
   * Appended to every campaign text that does not already contain it. Null
   * sends texts without one — only sensible for a sender whose carrier or
   * regulator adds its own.
   */
  @Column({ type: 'varchar', length: 80, nullable: true, name: 'opt_out_text' })
  optOutText: string | null;

  /**
   * Unguessable path segment in the webhook URLs. It finds the project; the
   * provider's signature, checked with the stored Auth Token, proves the
   * request came from the provider.
   */
  @Column({ type: 'varchar', length: 64, name: 'webhook_token' })
  webhookToken: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

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
import { EmailProviderName } from '../../push-notifications/message-channel';

/**
 * How a project sends email: through which of its own provider accounts, and
 * as whom.
 *
 * Credentials are not here. They sit in `push_channel_credentials` under the
 * provider's name, encrypted like every other channel's.
 */
@Entity('email_settings')
@Index(['projectId'], { unique: true })
@Index(['webhookToken'], { unique: true })
export class EmailSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  /** The provider campaigns go out through. Null until one is connected. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  provider: EmailProviderName | null;

  @Column({ type: 'varchar', length: 320, name: 'from_email' })
  fromEmail: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'from_name' })
  fromName: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true, name: 'reply_to' })
  replyTo: string | null;

  /**
   * Printed in every footer. CAN-SPAM requires a valid physical postal
   * address in commercial email, so a campaign is refused without one.
   */
  @Column({ type: 'text', name: 'postal_address' })
  postalAddress: string;

  /**
   * Only email people whose `email_opt_in` is true. When false, everyone not
   * explicitly opted out is eligible.
   *
   * Defaults to true: in the EU and under India's DPDP Act marketing email
   * needs consent, and the safe default is the one that cannot get a
   * customer fined.
   */
  @Column({ type: 'boolean', default: true, name: 'require_opt_in' })
  requireOptIn: boolean;

  /**
   * Unguessable path segment in the provider webhook URL. It is how an
   * incoming event finds its project, so it is the first check on a webhook,
   * with the provider's own signature as the second.
   */
  @Column({ type: 'varchar', length: 64, name: 'webhook_token' })
  webhookToken: string;

  /**
   * The SNS topic SES events come from, pinned on its first confirmed
   * subscription.
   *
   * A valid SNS signature proves a message came from *some* SNS topic, not
   * from this customer's. Pinning means that someone who learns the webhook
   * URL cannot subscribe a topic in their own AWS account and post signed
   * bounces that suppress real customers. Cleared from the dashboard when the
   * customer deliberately moves to a new topic.
   */
  @Column({ type: 'varchar', length: 256, nullable: true, name: 'ses_topic_arn' })
  sesTopicArn: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

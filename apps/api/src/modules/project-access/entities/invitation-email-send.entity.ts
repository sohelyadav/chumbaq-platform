import { CreateDateColumn, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { UserEntity } from '../../users/entities/user.entity';

/**
 * One invitation email attempted through the platform sender, counted per billing
 * account for the daily cap (`INVITE_EMAILS_PER_DAY`). Holds no address or token.
 */
@Entity('invitation_email_sends')
@Index('IDX_invitation_email_sends_owner_created', ['billingOwnerId', 'createdAt'])
export class InvitationEmailSendEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_invitation_email_sends' })
  id: string;

  @Column({ type: 'uuid', name: 'billing_owner_id' })
  billingOwnerId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'billing_owner_id', foreignKeyConstraintName: 'FK_invitation_email_sends_billing_owner' })
  billingOwner: UserEntity;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'FK_invitation_email_sends_project' })
  project: ProjectEntity;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

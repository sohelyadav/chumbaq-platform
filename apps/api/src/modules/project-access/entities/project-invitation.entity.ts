import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { UserEntity } from '../../users/entities/user.entity';
import type { ProjectRole } from '../project-permissions';

/**
 * An emailed offer to join a project. Only the token's sha256 is stored. At most one
 * invitation per (project, email) is pending, meaning neither accepted nor revoked.
 */
@Entity('project_invitations')
// Every path in lower-cases first (see users/email.ts); this catches one that forgets.
@Check('CHK_project_invitations_email_lower_case', `"email" = lower("email")`)
@Check('CHK_project_invitations_role', `"role" IN ('owner', 'admin', 'member')`)
@Index('UQ_project_invitations_pending', ['projectId', 'email'], {
  unique: true,
  where: `"accepted_at" IS NULL AND "revoked_at" IS NULL`,
})
export class ProjectInvitationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 16 })
  role: ProjectRole;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'token_hash' })
  tokenHash: string;

  @Column({ type: 'uuid', nullable: true, name: 'invited_by' })
  invitedBy: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invited_by' })
  invitedByUser: UserEntity | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'accepted_at' })
  acceptedAt: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'accepted_by' })
  acceptedBy: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'accepted_by' })
  acceptedByUser: UserEntity | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revokedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

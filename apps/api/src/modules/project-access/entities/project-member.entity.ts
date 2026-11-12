import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { UserEntity } from '../../users/entities/user.entity';
import type { ProjectRole } from '../project-permissions';

/**
 * Who can work in a project, and as what. The project's `owner_id` and the one `owner`
 * row here are kept in step by the code that creates and transfers projects.
 */
@Entity('project_members')
@Unique('UQ_project_members_project_user', ['projectId', 'userId'])
@Check('CHK_project_members_role', `"role" IN ('owner', 'admin', 'member')`)
export class ProjectMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 16 })
  role: ProjectRole;

  @Column({ type: 'uuid', nullable: true, name: 'added_by' })
  addedBy: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'added_by' })
  addedByUser: UserEntity | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

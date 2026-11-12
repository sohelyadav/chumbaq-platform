import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';

@Index(['projectId', 'anonymousId'], { unique: true })
@Entity('identity_aliases')
export class IdentityAliasEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Index()
  @Column({ type: 'varchar', length: 255, name: 'anonymous_id' })
  anonymousId: string;

  @Index()
  @Column({ type: 'varchar', length: 255, name: 'identified_id' })
  identifiedId: string;

  @Column({ type: 'timestamp', default: () => 'NOW()', name: 'merged_at' })
  mergedAt: Date;
}

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
import { SegmentNode } from '../segment-ast';

export type SegmentEvaluationMode = 'live' | 'materialized';
export type SegmentStatus = 'draft' | 'active' | 'error';

@Entity('segments')
@Index(['projectId', 'status'])
// The refresh scheduler selects materialized + active segments ordered by
// staleness; without this it sequentially scans every segment every tick.
@Index(['evaluationMode', 'status', 'lastMaterializedAt'])
export class SegmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** The query AST. Validated by validateAst() before it is ever written. */
  @Column({ type: 'jsonb' })
  definition: SegmentNode;

  @Column({ type: 'varchar', length: 20, name: 'evaluation_mode', default: 'live' })
  evaluationMode: SegmentEvaluationMode;

  @Column({ type: 'int', name: 'refresh_interval_minutes', default: 60 })
  refreshIntervalMinutes: number;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: SegmentStatus;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @Column({ type: 'int', nullable: true, name: 'last_member_count' })
  lastMemberCount: number | null;

  @Column({ type: 'timestamp', nullable: true, name: 'last_materialized_at' })
  lastMaterializedAt: Date | null;

  /**
   * Set when a materialisation run claims this segment, cleared when it ends.
   *
   * The refresh scheduler excludes segments claimed within
   * SEGMENT_MATERIALIZE_LOCK_MS. Without it, `last_materialized_at` stays stale
   * for the whole run, so a slow segment is re-enqueued on every tick and the
   * queue grows without bound — the residual Phase 0's final review found on
   * cohort sync after the deterministic-jobId fix.
   */
  @Column({ type: 'timestamp', nullable: true, name: 'materializing_at' })
  materializingAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

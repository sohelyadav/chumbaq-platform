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
import { JourneyStep, JourneyTrigger } from '../journey-definition';

/**
 * A journey only enrols while `active`. `paused` stops enrolment but leaves
 * existing runs to finish, because abandoning someone between a message and
 * its follow-up is worse than letting the journey drain.
 */
export type JourneyStatus = 'draft' | 'active' | 'paused' | 'archived';

@Entity('journeys')
@Index(['projectId', 'status'])
export class JourneyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: JourneyStatus;

  /** Validated on write — the database has no opinion about the shape. */
  @Column({ type: 'jsonb' })
  trigger: JourneyTrigger;

  @Column({ type: 'jsonb' })
  steps: JourneyStep[];

  /**
   * How far enrolment has looked. Only people who crossed the trigger after
   * this are enrolled, so activating a journey does not sweep up everyone who
   * ever matched it.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'enrolled_through' })
  enrolledThrough: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

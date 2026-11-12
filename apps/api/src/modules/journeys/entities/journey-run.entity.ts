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
import { JourneyEntity } from './journey.entity';

export type JourneyRunStatus = 'active' | 'completed' | 'exited' | 'failed';

/**
 * One person's passage through one journey.
 *
 * The partial unique index is what enforces "one run at a time" — a check
 * before insert would race two ticks against each other and enrol somebody
 * twice. Only active runs are covered, so a person who completed a journey can
 * enter it again if the journey allows it.
 */
@Entity('journey_runs')
@Index(['journeyId', 'personKey'], {
  unique: true,
  where: `status = 'active'`,
})
// The tick selects on this: active runs whose time has come.
@Index(['status', 'nextDueAt'])
// Person erasure deletes a person's runs in every state by (project, person).
@Index(['projectId', 'personKey'])
export class JourneyRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'uuid', name: 'journey_id' })
  journeyId: string;

  @ManyToOne(() => JourneyEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'journey_id' })
  journey: JourneyEntity;

  /**
   * Who is in the journey, keyed the way segments key a person — a distinct
   * id where there is one, the device fingerprint otherwise — so a person on
   * several devices runs a journey once rather than once per device.
   */
  @Column({ type: 'varchar', length: 255, name: 'person_key' })
  personKey: string;

  @Column({ type: 'int', default: 0, name: 'current_step_index' })
  currentStepIndex: number;

  /** Counted against the run's step budget, which bounds a loop. */
  @Column({ type: 'int', default: 0, name: 'steps_taken' })
  stepsTaken: number;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: JourneyRunStatus;

  /** When this run is next ready to advance. Null while it is being worked. */
  @Column({ type: 'timestamptz', nullable: true, name: 'next_due_at' })
  nextDueAt: Date | null;

  /** Why it stopped, when it stopped badly. */
  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;
}

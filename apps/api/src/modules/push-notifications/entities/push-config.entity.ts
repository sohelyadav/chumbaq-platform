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

@Entity('push_configs')
@Index(['projectId'], { unique: true })
export class PushConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  /**
   * Whether the project sends at all. Channel credentials live in
   * `push_channel_credentials`, one row per provider — this row now carries
   * only the sending policy that applies across every channel.
   */
  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  /**
   * Most campaigns a single device may be sent in a rolling 24 hours.
   *
   * Null means uncapped, which is also the only state in which the server
   * skips writing a per-recipient `sent` event — so a project that does not
   * want capping pays nothing in storage for it.
   */
  @Column({ type: 'int', nullable: true, name: 'frequency_cap_per_day' })
  frequencyCapPerDay: number | null;

  /**
   * Window during which nobody should be messaged, on the *recipient's* clock.
   *
   * Only applied to campaigns delivered per recipient timezone — that is the
   * only mode where a wave has a single known local clock to test against.
   * Both `HH:MM`; the window may wrap midnight, which is the usual case.
   */
  @Column({ type: 'varchar', length: 5, nullable: true, name: 'quiet_hours_start' })
  quietHoursStart: string | null;

  @Column({ type: 'varchar', length: 5, nullable: true, name: 'quiet_hours_end' })
  quietHoursEnd: string | null;

  /**
   * Ceiling on how fast a campaign is delivered, in messages per minute.
   *
   * Not a provider limit — FCM is far faster than this. It exists so a large
   * campaign does not hand an app's own backend a traffic spike it cannot
   * absorb, which is the failure a marketer never sees and an on-call engineer
   * always does. Null means send as fast as the worker can.
   */
  @Column({ type: 'int', nullable: true, name: 'max_sends_per_minute' })
  maxSendsPerMinute: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

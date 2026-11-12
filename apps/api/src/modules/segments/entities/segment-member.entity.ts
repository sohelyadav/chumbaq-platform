import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { SegmentEntity } from './segment.entity';

/**
 * A materialised segment's membership.
 *
 * The unique (segment_id, person_key) index serves both readers: it is the
 * single lookup isMember() needs, and its ordering is the keyset cursor
 * enumerate() pages on. Membership is a set, not a history — nothing records
 * entry or exit, which is why segment-triggered journeys are a later phase.
 */
@Entity('segment_members')
@Index(['segmentId', 'personKey'], { unique: true })
// Person erasure removes a person from every segment by (project, person).
@Index(['projectId', 'personKey'])
export class SegmentMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'segment_id' })
  segmentId: string;

  @ManyToOne(() => SegmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'segment_id' })
  segment: SegmentEntity;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 255, name: 'person_key' })
  personKey: string;

  /**
   * Refreshed on every materialisation run that still finds this person.
   *
   * It is also how a run finds leavers: everything it touched carries the
   * current run's timestamp, so anything older is someone who has dropped out
   * of the segment since.
   */
  @Column({ type: 'timestamp', name: 'materialized_at', default: () => 'NOW()' })
  materializedAt: Date;

  /**
   * When this person first became a member, and deliberately not touched
   * again while they stay one.
   *
   * Materialisation used to delete the whole segment and re-insert it, which
   * would have reset this every refresh and made it meaningless. It is now a
   * differential update for exactly this reason: a journey triggered by
   * "entered this segment" has nothing else to key on, and without it a
   * segment-triggered journey can only ever run once per person, ever.
   */
  @Column({
    type: 'timestamptz',
    name: 'entered_at',
    default: () => 'NOW()',
  })
  enteredAt: Date;
}

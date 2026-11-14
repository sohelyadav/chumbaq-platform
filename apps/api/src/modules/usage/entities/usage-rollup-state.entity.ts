import { Check, Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Where the usage roll-up has got to. A single row (`id = 1`).
 *
 * - `started_on`: the UTC day of the first run; snapshots that cannot be
 *   rebuilt for the past begin around it.
 * - `first_day`: the first day counted (the first run backfills before it).
 * - `last_closed_day`: every day up to this one is final and never written again.
 * - `devices_through`: how far today's active devices have been recorded.
 */
@Entity('usage_rollup_state')
@Check('CHK_usage_rollup_state_single', `"id" = 1`)
export class UsageRollupStateEntity {
  @PrimaryColumn({ type: 'smallint', default: 1, primaryKeyConstraintName: 'PK_usage_rollup_state' })
  id: number;

  @Column({ type: 'date', name: 'started_on' })
  startedOn: string;

  @Column({ type: 'date', name: 'first_day' })
  firstDay: string;

  @Column({ type: 'date', name: 'last_closed_day' })
  lastClosedDay: string;

  @Column({ type: 'timestamptz', name: 'devices_through', nullable: true })
  devicesThrough: Date | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}

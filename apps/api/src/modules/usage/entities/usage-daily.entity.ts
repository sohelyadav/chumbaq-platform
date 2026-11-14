import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One usage count per project, UTC day and metric.
 *
 * Counts only: no person, address or device is ever stored here, so the rows
 * outlive raw-data retention and erasure. Kept after a project is deleted (no
 * foreign key), so a billing owner's history does not change when a project
 * goes. Only non-zero values are stored: within the counted range a missing
 * row means zero. The exception is `ZERO_STORED_METRICS` (`api_keys_active`),
 * stored for every project, 0 included, on the days its snapshot was taken:
 * a missing row there means not taken, never zero.
 *
 * `owner_id` is the project's billing owner when the row was written, so a
 * billing transfer moves only days written after it.
 */
@Entity('usage_daily')
@Index('IDX_usage_daily_owner_day', ['ownerId', 'day'])
@Index('IDX_usage_daily_day', ['day'])
export class UsageDailyEntity {
  @PrimaryColumn({ type: 'uuid', name: 'project_id', primaryKeyConstraintName: 'PK_usage_daily' })
  projectId: string;

  /** UTC day, `YYYY-MM-DD`. */
  @PrimaryColumn({ type: 'date', primaryKeyConstraintName: 'PK_usage_daily' })
  day: string;

  @PrimaryColumn({ type: 'varchar', length: 40, primaryKeyConstraintName: 'PK_usage_daily' })
  metric: string;

  @Column({ type: 'uuid', name: 'owner_id' })
  ownerId: string;

  /** A bigint, so a string here: read it with `Number()`. */
  @Column({ type: 'bigint' })
  value: string;

  @Column({ type: 'timestamptz', name: 'computed_at', default: () => 'now()' })
  computedAt: Date;
}

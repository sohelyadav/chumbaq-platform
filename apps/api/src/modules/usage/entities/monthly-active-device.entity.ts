import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';

/**
 * A device that was active in a project in a UTC calendar month: it sent
 * something through the SDK or was reached by a message. One row per device
 * per month, however often it was active, so the month's active devices are a
 * row count.
 *
 * Holds an internal device id, so it is in the person inventory and erasure
 * deletes it; the daily counts already taken from it hold no id and stay.
 * No foreign key to the device for the same reason (erasure decides), and old
 * months are pruned by the roll-up.
 */
@Entity('monthly_active_devices')
@Index('IDX_mad_month', ['month'])
export class MonthlyActiveDeviceEntity {
  @PrimaryColumn({ type: 'uuid', name: 'project_id', primaryKeyConstraintName: 'PK_monthly_active_devices' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'FK_monthly_active_devices_project' })
  project: ProjectEntity;

  /** First day of the UTC month, `YYYY-MM-01`. */
  @PrimaryColumn({ type: 'date', primaryKeyConstraintName: 'PK_monthly_active_devices' })
  month: string;

  @PrimaryColumn({ type: 'uuid', name: 'device_identity_id', primaryKeyConstraintName: 'PK_monthly_active_devices' })
  deviceIdentityId: string;

  /** The first UTC day in the month the device was active, so each day's month-to-date count can be told. */
  @Column({ type: 'date', name: 'first_day' })
  firstDay: string;
}

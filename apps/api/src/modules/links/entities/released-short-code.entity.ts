import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Every short code a deleted link held, and the project it belonged to.
 *
 * Short codes are one namespace for all tenants, and a URL that was printed, posted or
 * mailed keeps being clicked after its link is gone, so a released code must never
 * start sending its visitors to someone else. `LinksService` refuses a code released by
 * another project; the project that held it may take it back.
 *
 * Rows are written by the `links_release_short_code` trigger (migration
 * `AddReleasedShortCodes1794490000000`) on every link delete, including the cascade
 * from a project delete. `project_id` has no foreign key, so the row outlives the
 * project and its code stays retired. Dev runs on `synchronize`, which makes the table
 * but not the trigger.
 */
@Entity('released_short_codes')
export class ReleasedShortCodeEntity {
  @PrimaryColumn({ type: 'varchar', length: 30, name: 'short_code' })
  shortCode: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'released_at' })
  releasedAt: Date;
}

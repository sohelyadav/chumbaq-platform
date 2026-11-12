import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type CohortStatus = 'pending' | 'syncing' | 'synced' | 'error';

@Entity('mixpanel_cohorts')
@Index(['projectId', 'mixpanelCohortId'], { unique: true })
export class MixpanelCohortEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  projectId: string;

  @Column({ type: 'integer' })
  mixpanelCohortId: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'integer', default: 0 })
  mixpanelUserCount: number;

  @Column({ type: 'integer', default: 0 })
  resolvedCount: number;

  @Column({ type: 'integer', default: 0 })
  unresolvedCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncedAt: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: CohortStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

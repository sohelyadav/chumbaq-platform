import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { MixpanelCohortEntity } from './mixpanel-cohort.entity';

export type ResolvedBy = 'external_user_id' | 'distinct_id' | 'email' | null;

@Entity('mixpanel_cohort_members')
@Index(['cohortId', 'mixpanelDistinctId'], { unique: true })
@Index(['cohortId', 'isResolved'])
@Index(['deviceIdentityId'])
export class MixpanelCohortMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  cohortId: string;

  @ManyToOne(() => MixpanelCohortEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cohortId' })
  cohort: MixpanelCohortEntity;

  @Index()
  @Column({ type: 'uuid' })
  projectId: string;

  @Column({ type: 'varchar', length: 512 })
  mixpanelDistinctId: string;

  @Column({ type: 'uuid', nullable: true })
  deviceIdentityId: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  resolvedBy: ResolvedBy;

  @Column({ type: 'boolean', default: false })
  isResolved: boolean;

  @Column({ type: 'jsonb', nullable: true })
  mixpanelProfile: Record<string, any> | null;

  @CreateDateColumn()
  addedAt: Date;
}

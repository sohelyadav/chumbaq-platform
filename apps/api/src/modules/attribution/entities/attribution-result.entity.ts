import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { ConversionEventEntity } from '../../conversions/entities/conversion-event.entity';

export type AttributionModel = 'last_touch' | 'first_touch' | 'linear' | 'time_decay';

@Index(['projectId', 'model', 'createdAt'])
@Index(['conversionId', 'model'])
@Entity('attribution_results')
export class AttributionResultEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'uuid', name: 'conversion_id' })
  conversionId: string;

  @ManyToOne(() => ConversionEventEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversion_id' })
  conversion: ConversionEventEntity;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'distinct_id' })
  distinctId: string;

  @Column({ type: 'varchar', length: 50 })
  model: AttributionModel;

  @Column({ type: 'jsonb', name: 'credit_splits' })
  creditSplits: CreditSplit[];

  @Column({ type: 'int', name: 'touchpoint_count' })
  touchpointCount: number;

  @Column({ type: 'int', nullable: true, name: 'lookback_days' })
  lookbackDays: number;

  @Column({ type: 'timestamp', default: () => 'NOW()', name: 'created_at' })
  createdAt: Date;
}

export interface CreditSplit {
  touchpointId: string;
  touchpointType: string;
  channel: string;
  campaign: string;
  utmSource: string;
  utmMedium: string;
  linkId: string;
  credit: number; // 0.0 to 1.0
  touchedAt: string;
}

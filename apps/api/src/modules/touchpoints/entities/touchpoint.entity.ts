import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { LinkEntity } from '../../links/entities/link.entity';

export type TouchpointType =
  | 'link_click'
  | 'email_open'
  | 'banner_view'
  | 'banner_click'
  | 'push_click'
  | 'page_view'
  | 'custom_event';

@Index(['projectId', 'distinctId', 'touchedAt'])
@Index(['projectId', 'channel', 'touchedAt'])
@Entity('touchpoints')
export class TouchpointEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'distinct_id' })
  distinctId: string;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'device_fingerprint' })
  deviceFingerprint: string;

  @Column({ type: 'varchar', length: 50, name: 'touchpoint_type' })
  touchpointType: TouchpointType;

  @Column({ type: 'varchar', length: 100, nullable: true })
  channel: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  campaign: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'utm_source' })
  utmSource: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'utm_medium' })
  utmMedium: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'utm_campaign' })
  utmCampaign: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'utm_term' })
  utmTerm: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'utm_content' })
  utmContent: string;

  @Column({ type: 'uuid', nullable: true, name: 'link_id' })
  linkId: string;

  @ManyToOne(() => LinkEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'link_id' })
  link: LinkEntity;

  @Column({ type: 'uuid', nullable: true, name: 'source_event_id' })
  sourceEventId: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  referrer: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  platform: string;

  @Column({ type: 'varchar', length: 20, nullable: true, name: 'device_type' })
  deviceType: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ipAddress: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'timestamp', default: () => 'NOW()', name: 'touched_at' })
  touchedAt: Date;
}

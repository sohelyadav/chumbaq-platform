import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { LinkEntity } from '../../links/entities/link.entity';
import { ClickEventEntity } from '../../analytics/entities/click-event.entity';

@Index(['linkId', 'eventType'])
@Entity('conversion_events')
export class ConversionEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'link_id' })
  linkId: string;

  @ManyToOne(() => LinkEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'link_id' })
  link: LinkEntity;

  @Column({ type: 'uuid', nullable: true, name: 'click_event_id' })
  clickEventId: string;

  @ManyToOne(() => ClickEventEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'click_event_id' })
  clickEvent: ClickEventEntity;

  @Column({ type: 'varchar', length: 100, name: 'event_type' })
  eventType: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'external_user_id' })
  externalUserId: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'timestamp', default: () => 'NOW()', name: 'converted_at' })
  convertedAt: Date;

  @Index()
  @Column({ type: 'uuid', nullable: true, name: 'device_identity_id' })
  deviceIdentityId: string;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'distinct_id' })
  distinctId: string;
}

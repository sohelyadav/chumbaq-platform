import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { BannerCategoryEntity } from './banner-category.entity';
import { InAppBannerEntity } from './in-app-banner.entity';

@Index(['categoryId', 'createdAt'])
@Entity('widget_events')
export class WidgetEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'banner_id' })
  bannerId: string;

  @ManyToOne(() => InAppBannerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'banner_id' })
  banner: InAppBannerEntity;

  @Index()
  @Column({ type: 'uuid', name: 'category_id' })
  categoryId: string;

  @ManyToOne(() => BannerCategoryEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'category_id' })
  category: BannerCategoryEntity;

  @Column({ type: 'varchar', length: 15, name: 'event_type' })
  eventType: string;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ipAddress: string;

  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  referrer: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  platform: string;

  @Column({ type: 'varchar', length: 20, nullable: true, name: 'device_type' })
  deviceType: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  os: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  browser: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'country_code' })
  countryCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'timestamp', default: () => 'NOW()', name: 'created_at' })
  createdAt: Date;
}

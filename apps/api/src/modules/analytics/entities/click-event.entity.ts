import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { LinkEntity } from '../../links/entities/link.entity';
import { DeviceIdentityEntity } from '../../identity/entities/device-identity.entity';

@Index(['linkId', 'clickedAt'])
@Entity('click_events')
export class ClickEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'link_id' })
  linkId: string;

  @ManyToOne(() => LinkEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'link_id' })
  link: LinkEntity;

  @Column({ type: 'timestamp', default: () => 'NOW()', name: 'clicked_at' })
  clickedAt: Date;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ipAddress: string;

  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  referrer: string;

  @Column({ type: 'varchar', length: 20 })
  platform: string;

  @Column({ type: 'varchar', length: 20, name: 'device_type' })
  deviceType: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  os: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'os_version' })
  osVersion: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  browser: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'browser_version' })
  browserVersion: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'country_code' })
  countryCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  region: string;

  @Column({ type: 'float', nullable: true })
  latitude: number;

  @Column({ type: 'float', nullable: true })
  longitude: number;

  @Column({ type: 'varchar', length: 30, name: 'redirect_type' })
  redirectType: string;

  @Column({ type: 'boolean', default: false, name: 'is_deferred' })
  isDeferred: boolean;

  @Column({ type: 'boolean', default: false })
  matched: boolean;

  @Column({ type: 'uuid', nullable: true, name: 'variant_id' })
  variantId: string;

  @Index()
  @Column({ type: 'uuid', nullable: true, name: 'device_identity_id' })
  deviceIdentityId: string;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'distinct_id' })
  distinctId: string;
}

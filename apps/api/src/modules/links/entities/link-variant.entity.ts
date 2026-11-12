import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { LinkEntity } from './link.entity';

@Entity('link_variants')
export class LinkVariantEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'link_id' })
  linkId: string;

  @ManyToOne(() => LinkEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'link_id' })
  link: LinkEntity;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 2048, name: 'long_url' })
  longUrl: string;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'ios_url' })
  iosUrl: string;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'android_url' })
  androidUrl: string;

  @Column({ type: 'int', default: 50 })
  weight: number;

  @Column({ type: 'int', default: 0 })
  clicks: number;

  @Column({ type: 'int', default: 0 })
  conversions: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

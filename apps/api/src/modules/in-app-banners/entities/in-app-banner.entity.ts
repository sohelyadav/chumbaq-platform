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
import { BannerCategoryEntity } from './banner-category.entity';

@Entity('in_app_banners')
export class InAppBannerEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'category_id' })
  categoryId: string;

  @ManyToOne(() => BannerCategoryEntity, (category) => category.banners, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'category_id' })
  category: BannerCategoryEntity;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'image_url' })
  imageUrl: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'click_url' })
  clickUrl: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'cta_text' })
  ctaText: string;

  @Column({ type: 'int', default: 0, name: 'sort_order' })
  sortOrder: number;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true, name: 'starts_at' })
  startsAt: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'int', default: 0 })
  impressions: number;

  @Column({ type: 'int', default: 0 })
  clicks: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

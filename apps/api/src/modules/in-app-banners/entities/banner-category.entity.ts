import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { InAppBannerEntity } from './in-app-banner.entity';

@Entity('banner_categories')
export class BannerCategoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 20, default: 'carousel' })
  layout: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'aspect_ratio' })
  aspectRatio: string;

  @Column({ type: 'boolean', default: true, name: 'auto_rotate' })
  autoRotate: boolean;

  @Column({ type: 'int', default: 5, name: 'rotation_interval' })
  rotationInterval: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  heading: string;

  /**
   * 32 rather than 20: a spaced `rgba(255, 255, 255, 0.5)` is a valid CSS
   * colour at 24 characters, so the narrower column made the DTO's matching
   * `@MaxLength` refuse real input. Widened by `WidenBannerBackgroundColor`.
   */
  @Column({ type: 'varchar', length: 32, default: '#ffffff', name: 'background_color' })
  backgroundColor: string;

  @Column({ type: 'int', default: 0 })
  padding: number;

  @Column({ type: 'jsonb', nullable: true })
  config: Record<string, any>;

  @Column({ type: 'varchar', length: 10, default: 'draft' })
  status: string;

  @OneToMany(() => InAppBannerEntity, (banner) => banner.category)
  banners: InAppBannerEntity[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

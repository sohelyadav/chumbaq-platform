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
import { ClickEventEntity } from '../../analytics/entities/click-event.entity';

@Entity('links')
export class LinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 30, unique: true, name: 'short_code' })
  shortCode: string;

  @Column({ type: 'varchar', length: 2048, name: 'long_url' })
  longUrl: string;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'ios_url' })
  iosUrl: string;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'android_url' })
  androidUrl: string;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'ios_fallback_url' })
  iosFallbackUrl: string;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'android_fallback_url' })
  androidFallbackUrl: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'og_title' })
  ogTitle: string;

  @Column({ type: 'text', nullable: true, name: 'og_description' })
  ogDescription: string;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'og_image_url' })
  ogImageUrl: string;

  @Column({ type: 'jsonb', nullable: true, name: 'deep_link_params' })
  deepLinkParams: Record<string, any>;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true, name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string;

  @Column({ type: 'simple-array', nullable: true })
  tags: string[];

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, (project) => project.links, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @OneToMany(() => ClickEventEntity, (click) => click.link)
  clickEvents: ClickEventEntity[];

  clickCount?: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

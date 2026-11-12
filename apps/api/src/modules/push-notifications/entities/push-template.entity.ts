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
import { ProjectEntity } from '../../projects/entities/project.entity';
import { PushAction, PushDeliveryOptions } from './push-notification-log.entity';
import { PushCarouselSlide, PushTimer } from '../rich-content';
import { PushTranslations } from '../push-personalisation';

/**
 * Saved campaign content, reusable across sends.
 *
 * Content only — no audience and no schedule. Those are decisions about *this*
 * send, and freezing them into a template is how a saved "weekly promo" ends
 * up quietly targeting a segment that made sense six months ago.
 */
@Entity('push_templates')
@Index(['projectId', 'name'], { unique: true })
export class PushTemplateEntity {
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
  description: string | null;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'image_url' })
  imageUrl: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'deep_link_url' })
  deepLinkUrl: string | null;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, string> | null;

  @Column({ type: 'boolean', default: false })
  silent: boolean;

  @Column({ type: 'jsonb', nullable: true, name: 'delivery_options' })
  deliveryOptions: PushDeliveryOptions | null;

  @Column({ type: 'jsonb', nullable: true })
  translations: PushTranslations | null;

  /**
   * The rich content a template can reproduce, matching what a campaign
   * already sends. Nullable throughout: a plain text template has none of it,
   * and an empty array would read as "this template has no buttons" where the
   * campaign expects the field simply not to be there.
   */
  @Column({ type: 'jsonb', nullable: true })
  actions: PushAction[] | null;

  /** APNs category naming buttons the iOS app registered at launch. */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'ios_category' })
  iosCategory: string | null;

  @Column({ type: 'jsonb', nullable: true })
  carousel: PushCarouselSlide[] | null;

  /**
   * A countdown. Stored as authored — a relative `durationSeconds` stays
   * relative here, because a template that resolved it to a fixed instant
   * would expire and then produce campaigns whose countdown is already over.
   */
  @Column({ type: 'jsonb', nullable: true })
  timer: PushTimer | null;

  /** How many campaigns have been created from this template. */
  @Column({ type: 'int', default: 0, name: 'use_count' })
  useCount: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_used_at' })
  lastUsedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

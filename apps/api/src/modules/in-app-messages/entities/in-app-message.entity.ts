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

export type MessageType = 'modal' | 'bottom_sheet' | 'banner_top' | 'banner_bottom' | 'fullscreen';
export type MessageStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'archived';
export type TriggerType = 'immediate' | 'on_event' | 'on_screen' | 'on_app_open' | 'scheduled';
export type UserType = 'all' | 'cohort' | 'segment' | 'specific_users';
export type ImagePosition = 'top' | 'center' | 'background';
export type ButtonAction = 'dismiss' | 'deep_link' | 'url' | 'custom_event';
export type ButtonStyle = 'primary' | 'secondary' | 'text';
export type AnimationType = 'fade' | 'slide_up' | 'slide_down' | 'scale' | 'none';

export interface MessageButton {
  id: string;
  text: string;
  action: ButtonAction;
  actionUrl?: string;
  actionEvent?: string;
  style: ButtonStyle;
}

export interface MessageTheme {
  backgroundColor?: string;
  textColor?: string;
  titleColor?: string;
  buttonPrimaryColor?: string;
  buttonSecondaryColor?: string;
  overlayColor?: string;
  borderRadius?: number;
  animation?: AnimationType;
}

export interface TriggerCondition {
  operator: 'and' | 'or';
  rules: Array<{
    field: string;
    op: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'not_contains';
    value: string | number | boolean;
  }>;
}

export interface UserFilters {
  platforms?: string[];
  appVersions?: string[];
  countries?: string[];
  languages?: string[];
}

@Entity('in_app_messages')
@Index(['projectId', 'status'])
@Index(['projectId', 'triggerType', 'status'])
export class InAppMessageEntity {
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

  @Column({ type: 'varchar', length: 30, name: 'message_type' })
  messageType: MessageType;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: MessageStatus;

  // ── Content ──

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'image_url' })
  imageUrl: string | null;

  @Column({ type: 'varchar', length: 20, default: 'top', name: 'image_position' })
  imagePosition: ImagePosition;

  // ── CTA Buttons ──

  @Column({ type: 'jsonb', nullable: true })
  buttons: MessageButton[] | null;

  // ── Appearance ──

  @Column({ type: 'jsonb', nullable: true })
  theme: MessageTheme | null;

  @Column({ type: 'boolean', default: true, name: 'dismiss_on_tap_outside' })
  dismissOnTapOutside: boolean;

  @Column({ type: 'int', nullable: true, name: 'auto_dismiss_seconds' })
  autoDismissSeconds: number | null;

  // ── Targeting ──

  @Column({ type: 'varchar', length: 30, default: 'on_app_open', name: 'trigger_type' })
  triggerType: TriggerType;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'trigger_event' })
  triggerEvent: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'trigger_screen' })
  triggerScreen: string | null;

  @Column({ type: 'int', default: 0, name: 'trigger_delay_seconds' })
  triggerDelaySeconds: number;

  @Column({ type: 'jsonb', nullable: true, name: 'trigger_conditions' })
  triggerConditions: TriggerCondition | null;

  // ── Users ──

  @Column({ type: 'varchar', length: 30, default: 'all', name: 'user_type' })
  userType: UserType;

  @Column({ type: 'uuid', nullable: true, name: 'mixpanel_cohort_id' })
  mixpanelCohortId: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'segment_id' })
  segmentId: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'user_filters' })
  userFilters: UserFilters | null;

  // ── Scheduling ──

  @Column({ type: 'timestamp', nullable: true, name: 'starts_at' })
  startsAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'ends_at' })
  endsAt: Date | null;

  // ── Frequency & Priority ──

  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'int', nullable: true, name: 'max_impressions_per_user' })
  maxImpressionsPerUser: number | null;

  @Column({ type: 'int', nullable: true, name: 'min_interval_seconds' })
  minIntervalSeconds: number | null;

  @Column({ type: 'int', nullable: true, name: 'max_impressions_total' })
  maxImpressionsTotal: number | null;

  // ── Stats (denormalized counters) ──

  @Column({ type: 'int', default: 0, name: 'total_impressions' })
  totalImpressions: number;

  @Column({ type: 'int', default: 0, name: 'total_clicks' })
  totalClicks: number;

  @Column({ type: 'int', default: 0, name: 'total_dismissals' })
  totalDismissals: number;

  // ── Metadata ──

  @Column({ type: 'varchar', length: 100, array: true, nullable: true })
  tags: string[] | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

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

@Entity('webhooks')
export class WebhookEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 2048 })
  url: string;

  @Column({ type: 'simple-array' })
  events: string[];

  /**
   * The signing secret, encrypted (see `webhook-secret.ts`). Never returned:
   * the plaintext is shown once, when it is created or rotated.
   */
  @Column({ type: 'varchar', length: 255, name: 'secret' })
  secretSealed: string;

  /** Last four characters of the secret, so the dashboard can show which one is live. */
  @Column({ type: 'varchar', length: 4, nullable: true, name: 'secret_hint' })
  secretHint: string | null;

  /** Null until the secret is first rotated; until then it dates from `createdAt`. */
  @Column({ type: 'timestamptz', nullable: true, name: 'secret_rotated_at' })
  secretRotatedAt: Date | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

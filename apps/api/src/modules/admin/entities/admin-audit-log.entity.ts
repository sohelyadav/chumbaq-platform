import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AdminAuditAction } from '@chumbaq/shared';
import { UserEntity } from '../../users/entities/user.entity';

/**
 * Append-only record of what platform staff did. `AdminAuditService` is the only
 * writer and has no update or delete.
 */
// For the audit log's actor and action filters, newest first, and for the check
// that a staff member's read of a tenant was already recorded.
@Index(['actorId', 'createdAt'])
@Index(['action', 'createdAt'])
@Entity('admin_audit_logs')
export class AdminAuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Null when the action came from the CLI, or the actor was later deleted. */
  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actorId: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_id' })
  actor?: UserEntity | null;

  /** Denormalised so the history still names the actor after their deletion. */
  @Column({ type: 'varchar', length: 255, name: 'actor_email' })
  actorEmail: string;

  @Column({ type: 'varchar', length: 64 })
  action: AdminAuditAction;

  @Column({ type: 'varchar', length: 32, name: 'target_type' })
  targetType: string;

  /** Deliberately not an FK: the record must outlive whatever it points at. */
  @Index()
  @Column({ type: 'uuid', nullable: true, name: 'target_id' })
  targetId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'target_label' })
  targetLabel: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  // timestamptz, unlike the plain `timestamp` audit columns elsewhere: this one
  // is evidence, so it has to name an instant regardless of session timezone.
  @Index()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

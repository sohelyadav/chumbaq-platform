import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

export type AuthEventType =
  | 'register.succeeded'
  | 'login.succeeded'
  | 'login.failed'
  | 'login.limited'
  | 'login.password_accepted'
  | 'reauth.succeeded'
  | 'passkey.added'
  | 'passkey.removed'
  | 'passkey.failed'
  | 'totp.enabled'
  | 'totp.disabled'
  | 'recovery_code.used'
  | 'recovery_codes.regenerated'
  | 'refresh.succeeded'
  | 'refresh.failed'
  | 'refresh.reuse_detected'
  | 'logout'
  | 'logout.all'
  | 'session.revoked'
  | 'sessions.revoked_others'
  | 'password.changed'
  | 'password.reset_by_team'
  | 'password.reset'
  | 'password.reset_requested'
  // By email or a team admin, soon after staff removed the account's factors.
  | 'password.reset_refused'
  | 'email.verified'
  | 'factors_reset.requested'
  | 'factors_reset.cancelled'
  | 'factors_reset.completed'
  // A complete sign-in could not void the owner's staff-issued reset links.
  | 'staff_link.void_failed';

/**
 * Evidence of who signed in, from where, and what failed. It outlives the user
 * on purpose, so an account's deletion cannot erase its own history. Append-only:
 * the service has no update or delete. Only SecurityRetentionScheduler removes rows,
 * once older than AUTH_EVENT_RETENTION_DAYS.
 */
@Entity('auth_events')
@Index(['email', 'createdAt'])
@Index(['userId', 'createdAt'])
export class AuthEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  /** Lower-cased. Kept for failures on addresses that have no account. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 64 })
  type: AuthEventType;

  /** Why it failed, for staff. Never returned to the person signing in. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  reason: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'session_id' })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'user_agent' })
  userAgent: string | null;

  /**
   * timestamptz, because this is evidence of when something happened. Indexed alone
   * for pruning (SecurityRetentionScheduler): the two indexes above lead with other columns.
   */
  @Index()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

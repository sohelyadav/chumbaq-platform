import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

/**
 * One signed-in device. The refresh token names this row and the one `jti` that
 * is currently valid for it, so each token works once and a replay is detectable.
 * Stores no token material: a stolen copy of this table cannot sign anyone in.
 */
@Entity('auth_sessions')
export class AuthSessionEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'uuid', name: 'current_jti' })
  currentJti: string;

  /** The token just replaced, honoured briefly. See SessionsService.rotate. */
  @Column({ type: 'uuid', nullable: true, name: 'previous_jti' })
  previousJti: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'rotated_at' })
  rotatedAt: Date | null;

  /** Indexed, with `last_used_at`, for pruning (SecurityRetentionScheduler). */
  @Index()
  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revokedAt: Date | null;

  /** How this session proved who it is, e.g. `['pwd', 'webauthn']`. Empty if unknown. */
  @Column({ type: 'jsonb', default: [] })
  amr: string[];

  /**
   * When someone last actually proved who they are. Refreshing never moves this, or
   * every re-authentication check would be meaningless. Null means unknown, which
   * counts as not recent.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'authenticated_at' })
  authenticatedAt: Date | null;

  /**
   * `users.session_version` when this session began. Its tokens stop working when that
   * moves, so a row behind it is over even though nothing set `revoked_at`.
   */
  @Column({ type: 'int', name: 'session_version', default: 0 })
  sessionVersion: number;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'user_agent' })
  userAgent: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Index()
  @Column({ type: 'timestamptz', name: 'last_used_at', default: () => 'now()' })
  lastUsedAt: Date;
}

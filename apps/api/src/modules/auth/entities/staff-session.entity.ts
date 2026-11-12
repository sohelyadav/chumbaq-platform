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
 * One staff sign-in on the admin app, apart from `auth_sessions` so neither kind of
 * session can stand in for the other. Holds only hashes of the refresh token: a copy of
 * this table signs nobody in. See `StaffSessionsService`.
 */
@Entity('staff_sessions')
export class StaffSessionEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  /** sha256 hex of the refresh token now valid. Null for an enrolment-only session, which has none. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'current_token_hash' })
  currentTokenHash: string | null;

  /** The token just replaced, honoured for `ROTATION_GRACE_MS`. */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'previous_token_hash' })
  previousTokenHash: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'rotated_at' })
  rotatedAt: Date | null;

  @Column({ type: 'jsonb', default: [] })
  amr: string[];

  /** The last real proof (sign-in or re-authentication). Refreshing never moves it. */
  @Column({ type: 'timestamptz', nullable: true, name: 'authenticated_at' })
  authenticatedAt: Date | null;

  /** `users.session_version` at sign-in, so a bump ends this session at its next refresh. */
  @Column({ type: 'int', name: 'session_version', default: 0 })
  sessionVersion: number;

  /** A session from a password alone, able only to enrol a first staff factor. */
  @Column({ type: 'boolean', name: 'enrolment_only', default: false })
  enrolmentOnly: boolean;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'user_agent' })
  userAgent: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /** The last authenticated request, moved at most once a minute. Refresh does not move it. */
  @Column({ type: 'timestamptz', name: 'last_active_at', default: () => 'now()' })
  lastActiveAt: Date;

  @Index()
  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'revoked_reason' })
  revokedReason: string | null;
}

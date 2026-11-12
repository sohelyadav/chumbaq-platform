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

export type AccountTokenPurpose = 'verify_email' | 'reset_password';

/**
 * A single-use link sent to an account's address. Only the SHA-256 of the token is
 * stored, so a stolen copy of this table cannot reset anyone's password.
 *
 * Rows are kept after use: `used_at` also marks a token replaced or invalidated,
 * and the per-address send limit counts rows by `created_at`, so deleting them
 * would hand back the sends they used up. SecurityRetentionScheduler removes them
 * 7 days after use or expiry, long after the hour that limit looks at.
 */
@Entity('account_tokens')
@Index(['userId', 'purpose', 'createdAt'])
export class AccountTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 32 })
  purpose: AccountTokenPurpose;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'token_hash' })
  tokenHash: string;

  /** Indexed, with `used_at`, for pruning (SecurityRetentionScheduler). */
  @Index()
  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Index()
  @Column({ type: 'timestamptz', nullable: true, name: 'used_at' })
  usedAt: Date | null;

  /**
   * Issued by staff through the CLI (`admin:password-reset-link`) after checking who is
   * asking, never emailed. Only such a link resets a password within the window after
   * a staff factor reset, when the mailbox alone must not be enough.
   */
  @Column({ type: 'boolean', name: 'staff_issued', default: false })
  staffIssued: boolean;

  /**
   * A staff link does nothing before this (`STAFF_LINK_DELAY_HOURS` after issue), so the
   * real owner, told at once, has time to sign in and void it. Null on emailed links,
   * which work at once.
   */
  @Column({ type: 'timestamptz', name: 'usable_after', nullable: true })
  usableAfter: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

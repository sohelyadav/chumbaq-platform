import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { FactorResetVerificationMethod } from '@chumbaq/shared';
import { UserEntity } from '../../users/entities/user.entity';

/** Every way staff may confirm who is asking. Email is not one: it is what may be stolen. */
export const FACTOR_RESET_VERIFICATION_METHODS: readonly FactorResetVerificationMethod[] = [
  'video_call',
  'government_id',
  'phone_call_known_number',
  'billing_record',
  'other',
];

/** The shortest account of what staff saw that is accepted. */
export const VERIFICATION_NOTES_MIN = 10;
export const VERIFICATION_NOTES_MAX = 1000;

export type FactorResetStatus = 'pending' | 'cancelled' | 'completed';

/**
 * `owner` and `staff` pressed cancel; `sign_in` is the owner using a factor during the
 * wait, which shows they still have one; `superseded` is the CLI resetting at once;
 * `refused` is a target that became a super admin, or a requester who stopped being
 * active staff, while it waited (the audit entry says which); `password_reset` is the
 * account's password being reset, since whoever holds the mailbox may not be the owner.
 */
export type FactorResetCancelledBy =
  | 'owner'
  | 'staff'
  | 'sign_in'
  | 'superseded'
  | 'refused'
  | 'password_reset';

/**
 * A staff-assisted removal of every second factor, which waits before it happens so the
 * real owner has time to hear of it and stop it. Rows are kept after they finish, as
 * the record of who asked and what became of it.
 */
@Entity('factor_resets')
// The one-pending-per-user rule, held by the database so two staff cannot both start one.
@Index('UQ_factor_resets_pending_user', ['userId'], { unique: true, where: `"status" = 'pending'` })
@Index('IDX_factor_resets_pending_due', ['executeAfter'], { where: `"status" = 'pending'` })
export class FactorResetEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: FactorResetStatus;

  /** Not a foreign key, as in `admin_audit_logs`: the record outlives the staff account. */
  @Column({ type: 'uuid', nullable: true, name: 'requested_by_id' })
  requestedById: string | null;

  @Column({ type: 'varchar', length: 255, name: 'requested_by_email' })
  requestedByEmail: string;

  @Column({ type: 'text' })
  reason: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'requested_at' })
  requestedAt: Date;

  /**
   * For display: the claim itself is timed from `noticeSentAt`. Set to the request time
   * plus the delay, then moved on to the confirmed warning plus the delay.
   */
  @Column({ type: 'timestamptz', name: 'execute_after' })
  executeAfter: Date;

  /**
   * When the email provider confirmed the owner's warning was sent. Null means it has
   * not been, and then the reset never runs: the scheduler keeps trying the email.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'notice_sent_at' })
  noticeSentAt: Date | null;

  /** Why staff went ahead although the password was reset recently, if it was. */
  @Column({ type: 'text', nullable: true, name: 'password_reset_override' })
  passwordResetOverride: string | null;

  /**
   * How staff confirmed who was asking, by some means other than email, and what they
   * saw. Required for every new request; null only on rows from before it was.
   */
  @Column({ type: 'varchar', length: 32, nullable: true, name: 'verification_method' })
  verificationMethod: FactorResetVerificationMethod | null;

  @Column({ type: 'text', nullable: true, name: 'verification_notes' })
  verificationNotes: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'cancelled_at' })
  cancelledAt: Date | null;

  @Column({ type: 'varchar', length: 16, nullable: true, name: 'cancelled_by' })
  cancelledBy: FactorResetCancelledBy | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;
}

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

/**
 * An operator's one-time code (`admin:staff-enrolment`) that lets a super admin start
 * staff sign-in with a password, to enrol a first staff factor. The code goes to the
 * staff member out of band, so a password alone (or a mailbox, through a reset) is not
 * enough. Only its sha256 is kept. Spent once by a conditional UPDATE; voided when a new
 * one is made, the first staff factor is enrolled, or the password is reset.
 */
@Entity('staff_enrolment_allowances')
export class StaffEnrolmentAllowanceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'code_hash' })
  codeHash: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'used_at' })
  usedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'used_ip' })
  usedIp: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'voided_at' })
  voidedAt: Date | null;

  /** `replaced`, `enrolled` or `password_reset`. */
  @Column({ type: 'varchar', length: 32, nullable: true, name: 'voided_reason' })
  voidedReason: string | null;
}

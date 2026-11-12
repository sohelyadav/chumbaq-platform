import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { StaffSessionEntity } from '../../auth/entities/staff-session.entity';
import { UserEntity } from '../../users/entities/user.entity';

/**
 * A view-as about to start: made by the admin API, spent once by the customer API,
 * which only then issues the impersonation token. The admin app and the customer app are
 * different origins, so the token can no longer be handed over in the browser.
 *
 * Only the code's sha256 is kept, so reading this table yields nothing to exchange.
 */
@Entity('impersonation_handoffs')
export class ImpersonationHandoffEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'code_hash' })
  codeHash: string;

  @Column({ type: 'uuid', name: 'actor_id' })
  actorId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'actor_id' })
  actor: UserEntity;

  /** The staff member's `session_version` when they asked, so a bump in between voids it. */
  @Column({ type: 'int', name: 'actor_session_version' })
  actorSessionVersion: number;

  /** The view-as dies with this session, so signing out of the admin app ends it. */
  @Column({ type: 'uuid', name: 'staff_session_id' })
  staffSessionId: string;

  @ManyToOne(() => StaffSessionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'staff_session_id' })
  staffSession: StaffSessionEntity;

  @Column({ type: 'uuid', name: 'target_id' })
  targetId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'target_id' })
  target: UserEntity;

  @Column({ type: 'text' })
  reason: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Index()
  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'used_at' })
  usedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'used_ip' })
  usedIp: string | null;
}

import {
  Check,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

// Every path in lower-cases first (see users/email.ts); this catches one that forgets.
@Check('CHK_users_email_lower_case', `"email" = lower("email")`)
@Check('CHK_users_project_limit_not_negative', `"project_limit" >= 0`)
@Check('CHK_users_seat_limit_not_negative', `"seat_limit" >= 0`)
@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, name: 'password_hash' })
  passwordHash: string;

  /**
   * Every token carries the value from when it was issued, and one that does not
   * match is refused. Incrementing this ends all of a user's sessions at once.
   */
  @Column({ type: 'int', default: 0, name: 'session_version' })
  sessionVersion: number;

  /**
   * The team that created this account and may reset its password. Null means
   * the account belongs to its owner. Not a foreign key: `teams` already points
   * at `users`, and a deleted team's id simply never matches again.
   */
  @Column({ type: 'uuid', nullable: true, name: 'managed_by_team_id' })
  managedByTeamId: string | null;

  /**
   * Platform staff. Granted only by the `admin:grant` CLI: no API may set this,
   * so a compromised admin session cannot mint another admin.
   */
  @Column({ type: 'boolean', default: false, name: 'is_super_admin' })
  isSuperAdmin: boolean;

  /** Set while the account is suspended. Reversible: no data is deleted. */
  @Column({ type: 'timestamptz', nullable: true, name: 'suspended_at' })
  suspendedAt: Date | null;

  @Column({ type: 'text', nullable: true, name: 'suspended_reason' })
  suspendedReason: string | null;

  /**
   * When the owner of this address proved control of it. Null for accounts from
   * before this existed and for team-created ones until their owner confirms.
   * Nothing is refused on this yet: enforcement is a later decision.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'email_verified_at' })
  emailVerifiedAt: Date | null;

  /**
   * The last time the password was replaced without the old one: by email or by a team
   * admin, not the owner changing it. Written in the same transaction as the new hash,
   * because a staff factor reset soon after one is refused on it, and an auth event
   * written afterwards can be lost.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'password_reset_at' })
  passwordResetAt: Date | null;

  /**
   * The last time staff removed every second factor (the delayed reset or the CLI).
   * Resetting the password by email or by a team admin is refused for a while after
   * it, since whoever asked staff may hold only the mailbox.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'factors_reset_at' })
  factorsResetAt: Date | null;

  /**
   * The last sign-in or re-authentication that used a second factor. A staff factor
   * reset requested before this will not run: whoever signed in still had a factor.
   * Kept here rather than read from `auth_events`, which never throws and so may have
   * nothing. Not selected by default, so it never reaches a response.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'last_factor_sign_in_at', select: false })
  lastFactorSignInAt?: Date | null;

  /**
   * Projects this account may own, set by staff. Null means the default,
   * `MAX_PROJECTS_PER_ACCOUNT`. Lowering it below what the account has removes
   * nothing; it only refuses new projects.
   */
  @Column({ type: 'int', nullable: true, name: 'project_limit' })
  projectLimit: number | null;

  /**
   * Staff's override of `MAX_SEATS_PER_ACCOUNT`: how many other people may be on this
   * account's projects. Null means the default, which may be no limit at all.
   */
  @Column({ type: 'int', nullable: true, name: 'seat_limit' })
  seatLimit: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

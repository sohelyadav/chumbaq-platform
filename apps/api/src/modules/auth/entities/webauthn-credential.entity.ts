import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

export type PasskeyScope = 'customer' | 'staff';

/**
 * One passkey. Holds only the public half, so a stolen copy signs nobody in.
 *
 * `scope` says which app it signs in to. The two have different relying parties (the
 * customer app's host and the admin app's), so a key only ever works for one, and each
 * side's ceremonies, lists and counts look only at their own.
 */
@Entity('webauthn_credentials')
@Index(['userId', 'scope'])
@Check(`"scope" IN ('customer', 'staff')`)
export class WebauthnCredentialEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  /** Base64url, as the browser reports it. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 1024, name: 'credential_id' })
  credentialId: string;

  @Column({ type: 'bytea', name: 'public_key' })
  publicKey: Buffer;

  /** Read through `Number()`: Postgres bigint arrives as a string. */
  @Column({ type: 'bigint', default: 0 })
  counter: string;

  @Column({ type: 'jsonb', default: [] })
  transports: string[];

  /** `multiDevice` means it can sync, so its private key can leave the device. */
  @Column({ type: 'varchar', length: 32, name: 'device_type' })
  deviceType: string;

  @Column({ type: 'boolean', name: 'backed_up' })
  backedUp: boolean;

  @Column({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'varchar', length: 16, default: 'customer' })
  scope: PasskeyScope;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_used_at' })
  lastUsedAt: Date | null;
}

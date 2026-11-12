import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

/** One authenticator app per account. Counts as a factor only once confirmed. */
@Entity('totp_secrets')
export class TotpSecretEntity {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId: string;

  @OneToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  /** Sealed by `MfaCryptoService`, unlike a passkey's public key, as this one can sign in. */
  @Column({ type: 'text', name: 'secret_ciphertext' })
  secretCiphertext: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'confirmed_at' })
  confirmedAt: Date | null;

  /** A code works once. Read through `Number()`: Postgres bigint arrives as a string. */
  @Column({ type: 'bigint', default: 0, name: 'last_used_step' })
  lastUsedStep: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

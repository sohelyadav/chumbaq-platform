import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('mixpanel_configs')
export class MixpanelConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  projectId: string;

  @Column({ type: 'varchar', length: 255 })
  serviceAccountUsername: string;

  @Column({ type: 'text' })
  serviceAccountPasswordEncrypted: string;

  @Column({ type: 'varchar', length: 32 })
  encryptionIv: string;

  @Column({ type: 'varchar', length: 64 })
  encryptionTag: string;

  @Column({ type: 'varchar', length: 50 })
  mixpanelProjectId: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastTestAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

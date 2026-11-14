import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';

@Entity('mixpanel_configs')
export class MixpanelConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  projectId: string;

  /** Deleting the project deletes this with it: credentials and end users' profiles must not outlive it. */
  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project?: ProjectEntity;

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

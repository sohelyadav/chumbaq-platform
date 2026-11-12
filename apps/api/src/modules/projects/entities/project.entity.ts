import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

@Entity('projects')
export class ProjectEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  domain: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'ios_bundle_id' })
  iosBundleId: string;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'ios_app_store_url' })
  iosAppStoreUrl: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'ios_team_id' })
  iosTeamId: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'ios_app_store_id' })
  iosAppStoreId: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'android_package_name' })
  androidPackageName: string;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'android_play_store_url' })
  androidPlayStoreUrl: string;

  @Column({ type: 'text', nullable: true, name: 'android_sha256_fingerprints' })
  androidSha256Fingerprints: string;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'web_fallback_url' })
  webFallbackUrl: string;

  @Column({ type: 'uuid', name: 'owner_id' })
  ownerId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: UserEntity;

  /** Who has been offered billing ownership of this project, until `pendingBillingOfferedAt` + 7 days. */
  @Column({ type: 'uuid', nullable: true, name: 'pending_billing_owner_id' })
  pendingBillingOwnerId: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'pending_billing_owner_id' })
  pendingBillingOwner: UserEntity | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'pending_billing_offered_at' })
  pendingBillingOfferedAt: Date | null;

  @OneToMany('LinkEntity', 'project')
  links: any[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

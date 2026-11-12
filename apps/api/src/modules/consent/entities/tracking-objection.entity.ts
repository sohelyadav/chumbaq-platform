import { Entity, Column, CreateDateColumn, ManyToOne, JoinColumn, PrimaryColumn } from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { UserEntity } from '../../users/entities/user.entity';
import { DeviceIdentityEntity } from '../../identity/entities/device-identity.entity';

/**
 * A do-not-track that covers a whole person: every identity row in the project
 * with this `external_user_id`, on any device, now or later.
 *
 * Only a trusted source writes one: an explicit person-level action in the
 * dashboard (`PersonObjectionsService`), by the project's owner, naming the
 * external id. Never implied by a row-level consent change, because the
 * external id on a row is whatever its SDK last claimed. An SDK call cannot, because the SDK's API
 * key ships inside every app and every identity link it reports
 * (`external_user_id`, `distinct_id`) is an unverified claim: if an SDK-set
 * flag spread through those links, anyone could identify a device as someone
 * else and switch off tracking for them. An SDK-set `do_not_track` therefore
 * stays on the row that set it (`device_identities.do_not_track`).
 *
 * Holds personal data (the external id), so erasure must delete it.
 */
@Entity('tracking_objections')
export class TrackingObjectionEntity {
  @PrimaryColumn({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @PrimaryColumn({ type: 'varchar', length: 255, name: 'external_user_id' })
  externalUserId: string;

  /** The dashboard user who made the objection. Null once that user is deleted. */
  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  creator: UserEntity;

  /** The person-page row it was made from, if any. Null once that row is erased. */
  @Column({ type: 'uuid', nullable: true, name: 'source_identity_id' })
  sourceIdentityId: string | null;

  @ManyToOne(() => DeviceIdentityEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_identity_id' })
  sourceIdentity: DeviceIdentityEntity;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import type { MessageChannel } from '../../push-notifications/message-channel';

/**
 * Every address an erasure took from a project, as a keyed hash per channel (the same
 * `PrivacyHashService.suppressionHash` as `erased_suppressions`, so nothing here names
 * anyone or joins across tenants).
 *
 * What arrives for an address after its person is erased (a late bounce, a STOP to an
 * old text, an old unsubscribe link) must still be honoured, but must not put the
 * address back in clear: `ErasedSuppressionsService.hashUnheld` checks this table and
 * keeps such a suppression as a hash instead, which `restore` turns back into a clear
 * row if the address is ever stored again. An address that was never erased is not
 * here, so a test send's bounce to an unknown address stays visible to the tenant.
 */
@Entity('erased_addresses')
@Index(['projectId', 'channel', 'addressHash'], { unique: true })
export class ErasedAddressEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 20 })
  channel: MessageChannel;

  @Column({ type: 'varchar', length: 64, name: 'address_hash' })
  addressHash: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'erased_at' })
  erasedAt: Date;
}

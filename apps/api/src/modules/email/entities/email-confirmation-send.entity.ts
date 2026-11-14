import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';

/**
 * When a project last mailed a double opt-in confirmation to an address, keyed by a
 * keyed hash of the address (`EmailConfirmationsService`), so nothing here names
 * anyone. Per address, not per device row: rows can be made, and their addresses
 * changed, by anyone holding the app's key, and a per-row limit let them mail one
 * inbox again and again.
 */
@Entity('email_confirmation_sends')
export class EmailConfirmationSendEntity {
  @PrimaryColumn({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project?: ProjectEntity;

  @PrimaryColumn({ type: 'varchar', length: 64, name: 'address_hash' })
  addressHash: string;

  @Column({ type: 'timestamptz', name: 'last_sent_at' })
  lastSentAt: Date;
}

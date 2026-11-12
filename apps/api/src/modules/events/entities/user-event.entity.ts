import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { DeviceIdentityEntity } from '../../identity/entities/device-identity.entity';

@Index(['projectId', 'distinctId', 'timestamp'])
@Index(['projectId', 'eventName', 'timestamp'])
// Every behaviour rule compiles to a join from the already-project-scoped
// person CTE on device_identity_id, filtering event_name and timestamp — with
// no project_id predicate on user_events, so neither index above can serve it.
@Index(['deviceIdentityId', 'eventName', 'timestamp'])
@Entity('user_events')
export class UserEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Index()
  @Column({ type: 'uuid', nullable: true, name: 'device_identity_id' })
  deviceIdentityId: string;

  @ManyToOne(() => DeviceIdentityEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'device_identity_id' })
  deviceIdentity: DeviceIdentityEntity;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'distinct_id' })
  distinctId: string;

  @Column({ type: 'varchar', length: 255, name: 'event_name' })
  eventName: string;

  @Column({ type: 'jsonb', nullable: true })
  properties: Record<string, unknown>;

  @Column({ type: 'varchar', length: 50, name: 'source_type', default: 'sdk' })
  sourceType: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'source_id' })
  sourceId: string;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ipAddress: string;

  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  platform: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'timestamp', default: () => 'NOW()' })
  timestamp: Date;

  @Column({ type: 'timestamp', default: () => 'NOW()', name: 'created_at' })
  createdAt: Date;
}

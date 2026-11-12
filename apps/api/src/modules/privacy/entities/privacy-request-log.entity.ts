import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type {
  PrivacyActorType,
  PrivacyRequestKind,
  PrivacySubjectType,
} from '@chumbaq/shared';
import { ProjectEntity } from '../../projects/entities/project.entity';

/**
 * The fiduciary's record that a person's data was erased or exported: who
 * asked, when, in which project, and how many rows of each table it touched.
 *
 * Append-only (`PrivacyRequestsService.record` is the only writer) and free of
 * the person's identifiers: `identifier_hashes` are keyed hashes
 * (`PrivacyHashService.subjectHash`) of the requested identifier and of each
 * external user id in scope, so "was user X erased?" can be answered by
 * hashing X, while the table itself names nobody.
 *
 * `actor_id` is the dashboard user or the API key, deliberately not a foreign
 * key, so the record outlives a revoked key or a removed account.
 */
@Entity('privacy_request_logs')
@Index(['projectId', 'createdAt'])
export class PrivacyRequestLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'varchar', length: 16 })
  kind: PrivacyRequestKind;

  @Column({ type: 'varchar', length: 24, name: 'subject_type' })
  subjectType: PrivacySubjectType;

  @Column({ type: 'varchar', length: 64, array: true, name: 'identifier_hashes' })
  identifierHashes: string[];

  @Column({ type: 'varchar', length: 16, name: 'actor_type' })
  actorType: PrivacyActorType;

  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actorId: string | null;

  @Column({ type: 'varchar', length: 24 })
  result: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  counts: Record<string, number>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

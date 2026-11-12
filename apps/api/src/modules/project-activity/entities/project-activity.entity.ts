import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { ProjectActivityAction, ProjectActivityActorKind } from '@chumbaq/shared';

/**
 * A project's activity log: who did what, on what, when and from where. Append-only:
 * `ProjectActivityService` is the only writer and has no update or delete, and the
 * `project_activity_append_only` trigger (in the migration; `synchronize` won't create
 * it) refuses UPDATE always and DELETE except by the retention job, past 180 days.
 *
 * No foreign keys on purpose: the record outlives the project, the actor's account and
 * whatever it points at.
 */
// Page (newest first), person filter, retention. The migration orders the first two DESC,
// which the decorator cannot say; a btree scans either way, so dev's `synchronize` is fine.
@Index('IDX_project_activity_page', ['projectId', 'occurredAt', 'id'])
@Index('IDX_project_activity_actor', ['projectId', 'actorUserId', 'occurredAt'])
@Index('IDX_project_activity_occurred_at', ['occurredAt'])
@Check('CHK_project_activity_actor_kind', `"actor_kind" IN ('user', 'staff', 'api_key', 'system', 'app')`)
@Entity('project_activity')
export class ProjectActivityEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  /** Set by the database, never by the request. */
  @CreateDateColumn({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt: Date;

  @Column({ type: 'text', name: 'actor_kind' })
  actorKind: ProjectActivityActorKind;

  @Column({ type: 'uuid', nullable: true, name: 'actor_user_id' })
  actorUserId: string | null;

  /** Name and email at the time, so the entry still names them after they leave. */
  @Column({ type: 'text', name: 'actor_label' })
  actorLabel: string;

  @Column({ type: 'text' })
  action: ProjectActivityAction;

  @Column({ type: 'text', nullable: true, name: 'target_type' })
  targetType: string | null;

  @Column({ type: 'text', nullable: true, name: 'target_id' })
  targetId: string | null;

  @Column({ type: 'text', nullable: true, name: 'target_label' })
  targetLabel: string | null;

  /** Only the keys `ACTIVITY_DETAIL_KEYS` allows for the action. */
  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'user_agent' })
  userAgent: string | null;

  @Column({ type: 'char', length: 2, nullable: true })
  country: string | null;
}

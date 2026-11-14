import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type BillingEventOutcome = 'pending' | 'applied' | 'ignored' | 'failed';

/**
 * Every verified webhook from the billing provider (and every synthetic event the
 * worker's reconciliation applies), once each, keyed by the provider's event id.
 *
 * Append-only in the database: DELETE and TRUNCATE are always refused, and an UPDATE
 * may change only the outcome fields (`outcome`, `detail`, `attempts`, `applied_at`),
 * and only while the outcome is still `pending` or `failed`. What arrived, and when,
 * never changes, and a settled event is never reopened.
 *
 * `payload` keeps allow-listed fields only (`storedPayload`): no card, bank, contact
 * or notes fields are stored.
 */
@Entity('billing_events')
@Check('CHK_billing_events_outcome', `"outcome" IN ('pending', 'applied', 'ignored', 'failed')`)
export class BillingEventEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_billing_events' })
  id: string;

  @Column({ type: 'varchar', length: 16 })
  provider: string;

  @Column({ type: 'varchar', length: 64, name: 'provider_event_id', unique: true })
  providerEventId: string;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'timestamptz', name: 'event_created_at' })
  eventCreatedAt: Date;

  @Column({ type: 'timestamptz', name: 'received_at', default: () => 'now()' })
  receivedAt: Date;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 8, default: 'pending' })
  outcome: BillingEventOutcome;

  @Column({ type: 'varchar', length: 320, nullable: true })
  detail: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', name: 'applied_at', nullable: true })
  appliedAt: Date | null;
}

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';
import { PlanEntity } from './plan.entity';
import { PlanPriceEntity } from './plan-price.entity';
import type { BillingInterval, BillingSubscriptionStatus } from '@chumbaq/shared';

/**
 * A subscription at the billing provider, mirrored. `status` is the provider's
 * own status, changed only by a verified webhook or a provider reply read on the
 * server; `last_event_at` and `last_event_rank` order webhooks that arrive out
 * of order. The account's plan is derived from its current and next pointers in
 * `billing_accounts`, so nothing here stores it twice.
 *
 * `cancel_requested_at` .. `cancel_error` are an outbox: a cancel to send to the
 * provider, written in the transaction that decides it and sent by the worker,
 * so no request waits on the provider while holding a lock.
 *
 * Kept with the account's billing history: deleting a user who has one is refused.
 */
@Entity('billing_subscriptions')
@Check(
  'CHK_billing_subscriptions_status',
  `"status" IN ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired')`,
)
@Check('CHK_billing_subscriptions_interval', `"interval" IN ('monthly', 'yearly')`)
@Index('IDX_billing_subscriptions_user_created', ['userId', 'createdAt'])
@Index('IDX_billing_subscriptions_cancel_outbox', ['cancelRequestedAt'], {
  where: '"cancel_requested_at" IS NOT NULL AND "cancel_sent_at" IS NULL',
})
export class BillingSubscriptionEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_billing_subscriptions' })
  id: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_billing_subscriptions_user' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 16, default: 'razorpay' })
  provider: string;

  @Column({ type: 'varchar', length: 40, name: 'provider_subscription_id', unique: true })
  providerSubscriptionId: string;

  @Column({ type: 'uuid', name: 'price_id' })
  priceId: string;

  @ManyToOne(() => PlanPriceEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'price_id', foreignKeyConstraintName: 'FK_billing_subscriptions_price' })
  price: PlanPriceEntity;

  @Column({ type: 'varchar', length: 32, name: 'plan_code' })
  planCode: string;

  @ManyToOne(() => PlanEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_code', foreignKeyConstraintName: 'FK_billing_subscriptions_plan' })
  plan: PlanEntity;

  @Column({ type: 'varchar', length: 7 })
  interval: BillingInterval;

  @Column({ type: 'varchar', length: 16 })
  status: BillingSubscriptionStatus;

  /** How the customer pays (card, upi, emandate, ...), once the provider says. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  method: string | null;

  @Column({ type: 'timestamptz', name: 'current_start', nullable: true })
  currentStart: Date | null;

  @Column({ type: 'timestamptz', name: 'current_end', nullable: true })
  currentEnd: Date | null;

  @Column({ type: 'timestamptz', name: 'start_at', nullable: true })
  startAt: Date | null;

  @Column({ type: 'timestamptz', name: 'charge_at', nullable: true })
  chargeAt: Date | null;

  @Column({ type: 'timestamptz', name: 'ended_at', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'int', name: 'paid_count', default: 0 })
  paidCount: number;

  @Column({ type: 'boolean', name: 'cancel_at_period_end', default: false })
  cancelAtPeriodEnd: boolean;

  /** While halted, the plan is kept until this time. */
  @Column({ type: 'timestamptz', name: 'grace_until', nullable: true })
  graceUntil: Date | null;

  @Column({ type: 'timestamptz', name: 'status_changed_at', default: () => 'now()' })
  statusChangedAt: Date;

  @Column({ type: 'timestamptz', name: 'last_event_at', nullable: true })
  lastEventAt: Date | null;

  @Column({ type: 'smallint', name: 'last_event_rank', default: 0 })
  lastEventRank: number;

  @Column({ type: 'uuid', name: 'superseded_by', nullable: true })
  supersededBy: string | null;

  @ManyToOne(() => BillingSubscriptionEntity, { nullable: true })
  @JoinColumn({ name: 'superseded_by', foreignKeyConstraintName: 'FK_billing_subscriptions_superseded_by' })
  successor: BillingSubscriptionEntity | null;

  /** Set when it first became its account's current subscription. */
  @Column({ type: 'boolean', name: 'was_current', default: false })
  wasCurrent: boolean;

  @Column({ type: 'timestamptz', name: 'cancel_requested_at', nullable: true })
  cancelRequestedAt: Date | null;

  @Column({ type: 'boolean', name: 'cancel_at_cycle_end', nullable: true })
  cancelAtCycleEnd: boolean | null;

  @Column({ type: 'uuid', name: 'cancel_requested_by', nullable: true })
  cancelRequestedBy: string | null;

  @Column({ type: 'timestamptz', name: 'cancel_sent_at', nullable: true })
  cancelSentAt: Date | null;

  @Column({ type: 'int', name: 'cancel_attempts', default: 0 })
  cancelAttempts: number;

  @Column({ type: 'varchar', length: 320, name: 'cancel_error', nullable: true })
  cancelError: string | null;

  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';
import { BillingSubscriptionEntity } from './billing-subscription.entity';
import { PlanEntity } from './plan.entity';

/**
 * One per account that has touched billing (a tenant is a user). It holds
 * pointers, not a status: the account's plan and state are derived from the
 * current and next subscriptions and the comp (`effective-plan.ts`), so there is
 * no second copy to fall out of step. Also the details for tax invoices and the
 * month and level of the last MAU notice sent.
 *
 * No row means the free plan. The pointer foreign keys are deferrable so one
 * transaction can insert a subscription and point at it in either order.
 */
@Entity('billing_accounts')
@Check('CHK_billing_accounts_mau_notice_level', `"mau_notice_level" IN (80, 100)`)
export class BillingAccountEntity {
  @PrimaryColumn({ type: 'uuid', name: 'user_id', primaryKeyConstraintName: 'PK_billing_accounts' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_billing_accounts_user' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 40, name: 'provider_customer_id', nullable: true, unique: true })
  providerCustomerId: string | null;

  @Column({ type: 'uuid', name: 'current_subscription_id', nullable: true })
  currentSubscriptionId: string | null;

  @ManyToOne(() => BillingSubscriptionEntity, { nullable: true, deferrable: 'INITIALLY IMMEDIATE' })
  @JoinColumn({ name: 'current_subscription_id', foreignKeyConstraintName: 'FK_billing_accounts_current' })
  currentSubscription: BillingSubscriptionEntity | null;

  @Column({ type: 'uuid', name: 'next_subscription_id', nullable: true })
  nextSubscriptionId: string | null;

  @ManyToOne(() => BillingSubscriptionEntity, { nullable: true, deferrable: 'INITIALLY IMMEDIATE' })
  @JoinColumn({ name: 'next_subscription_id', foreignKeyConstraintName: 'FK_billing_accounts_next' })
  nextSubscription: BillingSubscriptionEntity | null;

  /** A plan staff gave without payment, until `comp_until` (null: until removed). */
  @Column({ type: 'varchar', length: 32, name: 'comp_plan_code', nullable: true })
  compPlanCode: string | null;

  @ManyToOne(() => PlanEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'comp_plan_code', foreignKeyConstraintName: 'FK_billing_accounts_comp_plan' })
  compPlan: PlanEntity | null;

  @Column({ type: 'timestamptz', name: 'comp_until', nullable: true })
  compUntil: Date | null;

  @Column({ type: 'varchar', length: 500, name: 'comp_reason', nullable: true })
  compReason: string | null;

  @Column({ type: 'uuid', name: 'comped_by', nullable: true })
  compedBy: string | null;

  @Column({ type: 'timestamptz', name: 'comped_at', nullable: true })
  compedAt: Date | null;

  @Column({ type: 'varchar', length: 200, name: 'legal_name', nullable: true })
  legalName: string | null;

  @Column({ type: 'char', length: 15, nullable: true })
  gstin: string | null;

  @Column({ type: 'jsonb', nullable: true })
  address: Record<string, unknown> | null;

  /** The place of supply, as the two-digit GST state code. */
  @Column({ type: 'char', length: 2, name: 'state_code', nullable: true })
  stateCode: string | null;

  /** First day of the month of the last MAU notice, and its level (80 or 100 percent). */
  @Column({ type: 'date', name: 'mau_notice_month', nullable: true })
  mauNoticeMonth: string | null;

  @Column({ type: 'smallint', name: 'mau_notice_level', nullable: true })
  mauNoticeLevel: 80 | 100 | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}

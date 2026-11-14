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
import { BillingSubscriptionEntity } from './billing-subscription.entity';

export type BillingPaymentStatus = 'captured' | 'failed' | 'refunded';

/**
 * A payment (or failed attempt) on an account, mirrored from the billing provider.
 * Integer paise. `amount_refunded_paise` is cumulative, as the provider reports it,
 * and never above the amount. `tax_rate_bps` is the GST rate of the price the
 * payment was for, so revenue can be split into net and tax without a float.
 * `method` is the method's name only (card, upi, ...), never a number or handle.
 *
 * Kept for tax law: deleting the user it belongs to is refused (RESTRICT).
 */
@Entity('billing_payments')
@Check('CHK_billing_payments_status', `"status" IN ('captured', 'failed', 'refunded')`)
@Check('CHK_billing_payments_refund', `"amount_refunded_paise" BETWEEN 0 AND "amount_paise"`)
@Index('IDX_billing_payments_paid_at', ['paidAt'])
@Index('IDX_billing_payments_user_paid_at', ['userId', 'paidAt'])
export class BillingPaymentEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_billing_payments' })
  id: string;

  @Column({ type: 'varchar', length: 40, name: 'provider_payment_id', unique: true })
  providerPaymentId: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_billing_payments_user' })
  user: UserEntity;

  @Column({ type: 'uuid', name: 'subscription_id', nullable: true })
  subscriptionId: string | null;

  @ManyToOne(() => BillingSubscriptionEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subscription_id', foreignKeyConstraintName: 'FK_billing_payments_subscription' })
  subscription: BillingSubscriptionEntity | null;

  @Column({ type: 'varchar', length: 40, name: 'provider_invoice_id', nullable: true })
  providerInvoiceId: string | null;

  @Column({ type: 'int', name: 'amount_paise' })
  amountPaise: number;

  @Column({ type: 'int', name: 'amount_refunded_paise', default: 0 })
  amountRefundedPaise: number;

  @Column({ type: 'int', name: 'tax_rate_bps' })
  taxRateBps: number;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 10 })
  status: BillingPaymentStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  method: string | null;

  @Column({ type: 'varchar', length: 200, name: 'failure_reason', nullable: true })
  failureReason: string | null;

  /** When the payment was made (the provider's `created_at`), which month its revenue belongs to. */
  @Column({ type: 'timestamptz', name: 'paid_at' })
  paidAt: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}

import {
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

/**
 * An invoice the billing provider issued to an account, mirrored. Money is integer
 * paise: `amount_paise` is what the customer pays, `tax_paise` our GST share of it
 * (from the price row's tax rate), and `provider_tax_paise` whatever tax the provider
 * itself put on the invoice, kept for reference only.
 *
 * Kept for tax law: deleting the user it belongs to is refused (RESTRICT).
 */
@Entity('billing_invoices')
@Index('IDX_billing_invoices_user_issued', ['userId', 'issuedAt'])
export class BillingInvoiceEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_billing_invoices' })
  id: string;

  @Column({ type: 'varchar', length: 40, name: 'provider_invoice_id', unique: true })
  providerInvoiceId: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_billing_invoices_user' })
  user: UserEntity;

  @Column({ type: 'uuid', name: 'subscription_id', nullable: true })
  subscriptionId: string | null;

  @ManyToOne(() => BillingSubscriptionEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subscription_id', foreignKeyConstraintName: 'FK_billing_invoices_subscription' })
  subscription: BillingSubscriptionEntity | null;

  @Column({ type: 'varchar', length: 20 })
  status: string;

  @Column({ type: 'int', name: 'amount_paise' })
  amountPaise: number;

  @Column({ type: 'int', name: 'tax_paise' })
  taxPaise: number;

  @Column({ type: 'int', name: 'provider_tax_paise' })
  providerTaxPaise: number;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'timestamptz', name: 'period_start', nullable: true })
  periodStart: Date | null;

  @Column({ type: 'timestamptz', name: 'period_end', nullable: true })
  periodEnd: Date | null;

  @Column({ type: 'timestamptz', name: 'issued_at', nullable: true })
  issuedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'paid_at', nullable: true })
  paidAt: Date | null;

  @Column({ type: 'varchar', length: 200, name: 'short_url', nullable: true })
  shortUrl: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  number: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}

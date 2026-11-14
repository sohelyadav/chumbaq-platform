import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { PlanEntity } from './plan.entity';

/**
 * A price of a plan for one interval. Versioned: a price is never edited, a new
 * one replaces it as current (at most one current per plan and interval), so a
 * subscription always points at the amount it was sold at.
 *
 * Money is integer paise. `price_paise` excludes GST; `amount_paise` is what the
 * provider charges, `price + roundHalfUp(price * tax_rate_bps / 10000)`, held by a
 * CHECK in bigint (price times basis points overflows int4). The free plan has
 * no price.
 */
@Entity('plan_prices')
@Check('CHK_plan_prices_interval', `"interval" IN ('monthly', 'yearly')`)
@Check('CHK_plan_prices_price_positive', `"price_paise" > 0`)
@Check('CHK_plan_prices_tax_rate', `"tax_rate_bps" BETWEEN 0 AND 10000`)
@Check(
  'CHK_plan_prices_amount',
  `"amount_paise" = "price_paise" + ("price_paise"::bigint * "tax_rate_bps" + 5000) / 10000`,
)
@Check('CHK_plan_prices_currency', `"currency" = 'INR'`)
@Check('CHK_plan_prices_not_free', `"plan_code" <> 'free'`)
@Index('UQ_plan_prices_current', ['planCode', 'interval'], { unique: true, where: '"is_current"' })
export class PlanPriceEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_plan_prices' })
  id: string;

  @Column({ type: 'varchar', length: 32, name: 'plan_code' })
  planCode: string;

  @ManyToOne(() => PlanEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_code', foreignKeyConstraintName: 'FK_plan_prices_plan' })
  plan: PlanEntity;

  @Column({ type: 'varchar', length: 7 })
  interval: 'monthly' | 'yearly';

  /** Excluding GST. */
  @Column({ type: 'int', name: 'price_paise' })
  pricePaise: number;

  @Column({ type: 'int', name: 'tax_rate_bps' })
  taxRateBps: number;

  /** Including GST: what the provider's plan charges. */
  @Column({ type: 'int', name: 'amount_paise' })
  amountPaise: number;

  @Column({ type: 'char', length: 3, default: 'INR' })
  currency: string;

  @Column({ type: 'varchar', length: 40, name: 'razorpay_plan_id', unique: true })
  razorpayPlanId: string;

  @Column({ type: 'boolean', name: 'is_current', default: false })
  isCurrent: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /** The staff member who added it. Not a foreign key: the price outlives them. */
  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy: string | null;
}

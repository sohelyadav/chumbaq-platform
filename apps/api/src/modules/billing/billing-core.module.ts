import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountLimitsService } from './account-limits.service';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import { PlanPriceEntity } from './entities/plan-price.entity';
import { PlanEntity } from './entities/plan.entity';
import { FreePlanSeeder } from './free-plan-seeder';
import type { BillingConfig } from '../../config/billing.config';
import { BILLING_PROVIDER } from './providers/billing-provider';
import { createBillingProvider } from './providers/create-billing-provider';

/**
 * Plans and billing state shared by the customer API, the admin API and the worker.
 * Controller-less, so any app may import it without gaining routes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PlanEntity, PlanPriceEntity, BillingAccountEntity, BillingSubscriptionEntity]),
  ],
  providers: [
    AccountLimitsService,
    FreePlanSeeder,
    {
      // Razorpay when billing is on, the null provider otherwise (`createBillingProvider`).
      provide: BILLING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createBillingProvider(config.get<BillingConfig>('billing')),
    },
  ],
  exports: [TypeOrmModule, AccountLimitsService, BILLING_PROVIDER],
})
export class BillingCoreModule {}

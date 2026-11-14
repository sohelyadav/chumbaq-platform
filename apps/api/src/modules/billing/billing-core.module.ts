import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountLimitsService } from './account-limits.service';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import { PlanPriceEntity } from './entities/plan-price.entity';
import { PlanEntity } from './entities/plan.entity';
import { FreePlanSeeder } from './free-plan-seeder';

/**
 * Plans and billing state shared by the customer API, the admin API and the worker.
 * Controller-less, so any app may import it without gaining routes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PlanEntity, PlanPriceEntity, BillingAccountEntity, BillingSubscriptionEntity]),
  ],
  providers: [AccountLimitsService, FreePlanSeeder],
  exports: [TypeOrmModule, AccountLimitsService],
})
export class BillingCoreModule {}

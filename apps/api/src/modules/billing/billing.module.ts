import { Module } from '@nestjs/common';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingCoreModule } from './billing-core.module';
import { BillingEnabledGuard } from './billing-enabled.guard';
import { BillingOverviewService } from './billing-overview.service';
import { BillingWebhooksController } from './billing-webhooks.controller';
import { BillingWebhooksService } from './billing-webhooks.service';

/**
 * Billing's customer API: the provider webhook and the account owner's own billing
 * actions. Every route answers 404 while billing is off.
 */
@Module({
  imports: [BillingCoreModule, ProjectAccessModule],
  controllers: [BillingWebhooksController],
  providers: [BillingEnabledGuard, BillingWebhooksService, BillingOverviewService, BillingCheckoutService],
})
export class BillingModule {}

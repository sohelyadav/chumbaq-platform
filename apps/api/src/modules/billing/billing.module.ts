import { Module } from '@nestjs/common';
import { BillingCoreModule } from './billing-core.module';
import { BillingEnabledGuard } from './billing-enabled.guard';
import { BillingWebhooksController } from './billing-webhooks.controller';
import { BillingWebhooksService } from './billing-webhooks.service';

/**
 * Billing's customer API routes: the provider webhook (and, later, the customer's
 * own billing page). Every route answers 404 while billing is off.
 */
@Module({
  imports: [BillingCoreModule],
  controllers: [BillingWebhooksController],
  providers: [BillingEnabledGuard, BillingWebhooksService],
})
export class BillingModule {}

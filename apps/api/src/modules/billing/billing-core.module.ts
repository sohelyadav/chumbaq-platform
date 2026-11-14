import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { AccountLimitsService } from './account-limits.service';
import { BillingEmailsService } from './billing-emails.service';
import { BillingLedgerService } from './billing-ledger.service';
import { BillingOutboxService } from './billing-outbox.service';
import { BillingReconcileService } from './billing-reconcile.service';
import { BillingStateService } from './billing-state.service';
import { BILLING_NOTICES_HANDLER } from './billing-webhooks.service';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingEventEntity } from './entities/billing-event.entity';
import { BillingInvoiceEntity } from './entities/billing-invoice.entity';
import { BillingPaymentEntity } from './entities/billing-payment.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import { PlanPriceEntity } from './entities/plan-price.entity';
import { PlanEntity } from './entities/plan.entity';
import { FreePlanSeeder } from './free-plan-seeder';
import { MauNoticesService } from './mau-notices.service';
import type { BillingConfig } from '../../config/billing.config';
import { BILLING_PROVIDER } from './providers/billing-provider';
import { createBillingProvider } from './providers/create-billing-provider';

/**
 * Plans and billing state shared by the customer API, the admin API and the worker:
 * limits, the provider, the event ledger and its applier, billing email, and the
 * worker's jobs (scheduled by `BillingScheduler` in the worker only).
 * Controller-less, so any app may import it without gaining routes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlanEntity,
      PlanPriceEntity,
      BillingAccountEntity,
      BillingSubscriptionEntity,
      BillingEventEntity,
      BillingInvoiceEntity,
      BillingPaymentEntity,
    ]),
    PlatformEmailModule,
  ],
  providers: [
    AccountLimitsService,
    BillingStateService,
    BillingLedgerService,
    BillingEmailsService,
    BillingOutboxService,
    BillingReconcileService,
    MauNoticesService,
    FreePlanSeeder,
    { provide: BILLING_NOTICES_HANDLER, useExisting: BillingEmailsService },
    {
      // Razorpay when billing is on, the null provider otherwise (`createBillingProvider`).
      provide: BILLING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createBillingProvider(config.get<BillingConfig>('billing')),
    },
  ],
  exports: [
    TypeOrmModule,
    AccountLimitsService,
    BillingStateService,
    BillingLedgerService,
    BillingEmailsService,
    BillingOutboxService,
    BillingReconcileService,
    MauNoticesService,
    BILLING_NOTICES_HANDLER,
    BILLING_PROVIDER,
  ],
})
export class BillingCoreModule {}

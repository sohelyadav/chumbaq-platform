import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PushCampaignProcessor } from './push-campaign.processor';
import { CohortSyncProcessor } from './cohort-sync.processor';
import { SegmentMaterializeProcessor } from './segment-materialize.processor';
import { CohortSyncScheduler } from '../scheduler/cohort-sync.scheduler';
import { PushCampaignReconciliationScheduler } from '../scheduler/push-campaign-reconciliation.scheduler';
import { PushCampaignScheduleScheduler } from '../scheduler/push-campaign-schedule.scheduler';
import { SegmentRefreshScheduler } from '../scheduler/segment-refresh.scheduler';
import { JourneyScheduler } from '../scheduler/journey.scheduler';
import { SecurityRetentionScheduler } from '../scheduler/security-retention.scheduler';
import { FactorResetScheduler } from '../scheduler/factor-reset.scheduler';
import { ClockCheckScheduler } from '../scheduler/clock-check.scheduler';
import { UsageRollupScheduler } from '../scheduler/usage-rollup.scheduler';
import { BillingScheduler } from '../scheduler/billing.scheduler';
import {
  QUEUE_COHORT_SYNC,
  QUEUE_PUSH_CAMPAIGN,
  QUEUE_SEGMENT_MATERIALIZE,
} from '../queue.constants';
import { PushNotificationLogEntity } from '../../modules/push-notifications/entities/push-notification-log.entity';
import { PushConfigEntity } from '../../modules/push-notifications/entities/push-config.entity';
import { MixpanelCohortEntity } from '../../modules/mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import { SegmentMemberEntity } from '../../modules/segments/entities/segment-member.entity';
import { JourneyEntity } from '../../modules/journeys/entities/journey.entity';
import { JourneyRunEntity } from '../../modules/journeys/entities/journey-run.entity';
import { PushNotificationsModule } from '../../modules/push-notifications/push-notifications.module';
import { PushTokensModule } from '../../modules/push-tokens/push-tokens.module';
import { MixpanelCohortsModule } from '../../modules/mixpanel-cohorts/mixpanel-cohorts.module';
import { SegmentsModule } from '../../modules/segments/segments.module';
import { IdentityModule } from '../../modules/identity/identity.module';
import { EmailModule } from '../../modules/email/email.module';
import { SmsModule } from '../../modules/sms/sms.module';
import { WhatsAppModule } from '../../modules/whatsapp/whatsapp.module';
import { ProjectSuspensionModule } from '../../modules/projects/project-suspension.module';
import { FactorResetsModule } from '../../modules/factor-resets/factor-resets.module';
import { IncidentsModule } from '../../modules/incidents/incidents.module';
import { UsageModule } from '../../modules/usage/usage.module';
import { BillingCoreModule } from '../../modules/billing/billing-core.module';

/**
 * Worker-only module. Importing this registers BullMQ consumers, so it must be
 * imported by WorkerModule and never by AppModule — otherwise the API process
 * would also drain the queues and the process split would be cosmetic.
 */
@Module({
  imports: [
    // The 4- and 5-hour incident reminders (IncidentRemindersScheduler).
    IncidentsModule,
    TypeOrmModule.forFeature([
      PushNotificationLogEntity,
      PushConfigEntity,
      MixpanelCohortEntity,
      SegmentEntity,
      SegmentMemberEntity,
      JourneyEntity,
      JourneyRunEntity,
    ]),
    // The schedulers inject these queues directly (@InjectQueue), which needs
    // the provider tokens in this module's own graph — QueueModule registering
    // them as a WorkerModule sibling isn't enough, Nest doesn't share across
    // siblings, and PushNotificationsModule does not re-export BullModule.
    // Mirrors push-notifications.module.ts's registration of QUEUE_PUSH_CAMPAIGN.
    // Queues are keyed by name + connection, so this creates no duplicate.
    BullModule.registerQueue(
      { name: QUEUE_COHORT_SYNC },
      { name: QUEUE_PUSH_CAMPAIGN },
      { name: QUEUE_SEGMENT_MATERIALIZE },
    ),
    PushNotificationsModule,
    PushTokensModule,
    MixpanelCohortsModule,
    SegmentsModule,
    IdentityModule,
    EmailModule,
    SmsModule,
    WhatsAppModule,
    ProjectSuspensionModule,
    FactorResetsModule,
    // The hourly usage roll-up (UsageRollupScheduler).
    UsageModule,
    // Billing's outbox, reconciliation and MAU notices (BillingScheduler; off unless billing is on).
    BillingCoreModule,
  ],
  providers: [
    PushCampaignProcessor,
    CohortSyncProcessor,
    SegmentMaterializeProcessor,
    CohortSyncScheduler,
    PushCampaignReconciliationScheduler,
    PushCampaignScheduleScheduler,
    SegmentRefreshScheduler,
    JourneyScheduler,
    SecurityRetentionScheduler,
    FactorResetScheduler,
    ClockCheckScheduler,
    UsageRollupScheduler,
    BillingScheduler,
  ],
})
export class ProcessorsModule {}

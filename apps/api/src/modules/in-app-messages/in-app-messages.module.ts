import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InAppMessageEntity } from './entities/in-app-message.entity';
import { InAppMessageImpressionEntity } from './entities/in-app-message-impression.entity';
import { PendingMessageEntity } from './entities/pending-message.entity';
import { MixpanelCohortMemberEntity } from '../mixpanel-cohorts/entities/mixpanel-cohort-member.entity';
import { InAppMessagesService } from './in-app-messages.service';
import { MessageDeliveryService } from './message-delivery.service';
import { MessageAnalyticsService } from './message-analytics.service';
import { InAppMessagesController } from './in-app-messages.controller';
import { MessageDeliveryController } from './message-delivery.controller';
import { MessageAnalyticsController } from './message-analytics.controller';
import { ProjectSuspensionModule } from '../projects/project-suspension.module';
import { IdentityModule } from '../identity/identity.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { SegmentsModule } from '../segments/segments.module';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InAppMessageEntity,
      InAppMessageImpressionEntity,
      PendingMessageEntity,
      MixpanelCohortMemberEntity,
    ]),
    ProjectSuspensionModule,
    IdentityModule,
    ApiKeysModule,
    SegmentsModule,
    ProjectActivityModule,
  ],
  controllers: [
    InAppMessagesController,
    MessageDeliveryController,
    MessageAnalyticsController,
  ],
  providers: [
    InAppMessagesService,
    MessageDeliveryService,
    MessageAnalyticsService,
  ],
  exports: [
    InAppMessagesService,
    MessageDeliveryService,
    MessageAnalyticsService,
  ],
})
export class InAppMessagesModule {}


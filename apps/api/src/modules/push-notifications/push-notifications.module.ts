import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PushConfigEntity } from './entities/push-config.entity';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import { PushNotificationEventEntity } from './entities/push-notification-event.entity';
import { PushTemplateEntity } from './entities/push-template.entity';
import { PushChannelCredentialEntity } from './entities/push-channel-credential.entity';
import { ChannelSuppressionEntity } from './entities/channel-suppression.entity';
import { SuppressionsService } from './suppressions.service';
import { PushNotificationsService } from './push-notifications.service';
import { PushNotificationsController } from './push-notifications.controller';
import { PushEventsController } from './push-events.controller';
import { PushTemplatesController } from './push-templates.controller';
import { PushTemplatesService } from './push-templates.service';
import { PushAnalyticsService } from './push-analytics.service';
import { ChannelCredentialsService } from './channel-credentials.service';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ChannelsModule } from './channels.module';
import { ProjectActivityModule } from '../project-activity/project-activity.module';
import { PushCampaignStateService } from './push-campaign-state.service';
import { PushTokensModule } from '../push-tokens/push-tokens.module';
import { IdentityModule } from '../identity/identity.module';
import { SegmentsModule } from '../segments/segments.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { TouchpointsModule } from '../touchpoints/touchpoints.module';
import { QUEUE_PUSH_CAMPAIGN } from '../../queue/queue.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PushConfigEntity,
      PushNotificationLogEntity,
      PushNotificationEventEntity,
      PushTemplateEntity,
      PushChannelCredentialEntity,
      ChannelSuppressionEntity,
    ]),
    BullModule.registerQueue({ name: QUEUE_PUSH_CAMPAIGN }),
    PushTokensModule,
    IdentityModule,
    SegmentsModule,
    ApiKeysModule,
    TouchpointsModule,
    ChannelsModule,
    ProjectActivityModule,
  ],
  controllers: [
    PushNotificationsController,
    PushEventsController,
    PushTemplatesController,
  ],
  providers: [
    PushNotificationsService,
    PushAnalyticsService,
    ChannelCredentialsService,
    PushTemplatesService,
    CredentialsCryptoService,
    PushCampaignStateService,
    SuppressionsService,
  ],
  exports: [
    PushNotificationsService,
    PushAnalyticsService,
    ChannelCredentialsService,
    PushTemplatesService,
    PushCampaignStateService,
    CredentialsCryptoService,
    SuppressionsService,
    ChannelsModule,
  ],
})
export class PushNotificationsModule {}

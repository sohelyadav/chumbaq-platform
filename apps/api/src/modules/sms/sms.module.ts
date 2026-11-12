import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_PUSH_CAMPAIGN } from '../../queue/queue.constants';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { PushNotificationEventEntity } from '../push-notifications/entities/push-notification-event.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { PushNotificationsModule } from '../push-notifications/push-notifications.module';
import { ProjectSuspensionModule } from '../projects/project-suspension.module';
import { SmsSettingsEntity } from './entities/sms-settings.entity';
import { TwilioProvider } from './providers/twilio.provider';
import { SmsProviderRegistry } from './sms-provider.registry';
import { SmsSettingsService } from './sms-settings.service';
import { SmsAudienceService } from './sms-audience.service';
import { SmsCampaignsService } from './sms-campaigns.service';
import { SmsDeliveryService } from './sms-delivery.service';
import { SmsEventsService } from './sms-events.service';
import { SmsController } from './sms.controller';
import { SmsPublicController } from './sms-public.controller';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

/**
 * The SMS channel, on top of the shared campaign machinery — laid out as the
 * email module is, and for the same reasons.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SmsSettingsEntity,
      DeviceIdentityEntity,
      PushNotificationLogEntity,
      PushNotificationEventEntity,
      PushConfigEntity,
    ]),
    BullModule.registerQueue({ name: QUEUE_PUSH_CAMPAIGN }),
    PushNotificationsModule,
    ProjectActivityModule,
    ProjectSuspensionModule,
  ],
  controllers: [SmsController, SmsPublicController],
  providers: [
    TwilioProvider,
    SmsProviderRegistry,
    SmsSettingsService,
    SmsAudienceService,
    SmsCampaignsService,
    SmsDeliveryService,
    SmsEventsService,
  ],
  exports: [SmsAudienceService, SmsCampaignsService, SmsDeliveryService, SmsSettingsService],
})
export class SmsModule {}

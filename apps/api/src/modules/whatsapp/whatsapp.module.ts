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
import { WhatsAppSettingsEntity } from './entities/whatsapp-settings.entity';
import { MetaWhatsAppProvider } from './providers/meta.provider';
import { TwilioWhatsAppProvider } from './providers/twilio-whatsapp.provider';
import { GupshupProvider } from './providers/gupshup.provider';
import { InteraktProvider } from './providers/interakt.provider';
import { WhatsAppProviderRegistry } from './whatsapp-provider.registry';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppAudienceService } from './whatsapp-audience.service';
import { WhatsAppCampaignsService } from './whatsapp-campaigns.service';
import { WhatsAppDeliveryService } from './whatsapp-delivery.service';
import { WhatsAppEventsService } from './whatsapp-events.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppPublicController } from './whatsapp-public.controller';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

/** The WhatsApp channel, laid out as the email and SMS modules are. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      WhatsAppSettingsEntity,
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
  controllers: [WhatsAppController, WhatsAppPublicController],
  providers: [
    MetaWhatsAppProvider,
    TwilioWhatsAppProvider,
    GupshupProvider,
    InteraktProvider,
    WhatsAppProviderRegistry,
    WhatsAppSettingsService,
    WhatsAppAudienceService,
    WhatsAppCampaignsService,
    WhatsAppDeliveryService,
    WhatsAppEventsService,
  ],
  exports: [
    WhatsAppAudienceService,
    WhatsAppCampaignsService,
    WhatsAppDeliveryService,
    WhatsAppSettingsService,
  ],
})
export class WhatsAppModule {}

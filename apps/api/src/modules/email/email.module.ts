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
import { EmailSettingsEntity } from './entities/email-settings.entity';
import { SesProvider } from './providers/ses.provider';
import { ResendProvider } from './providers/resend.provider';
import { BrevoProvider } from './providers/brevo.provider';
import { EmailProviderRegistry } from './email-provider.registry';
import { EmailSettingsService } from './email-settings.service';
import { EmailAudienceService } from './email-audience.service';
import { EmailCampaignsService } from './email-campaigns.service';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailEventsService } from './email-events.service';
import { EmailUnsubscribeService } from './email-unsubscribe.service';
import { EmailConfirmationsService } from './email-confirmations.service';
import { ConsentModule } from '../consent/consent.module';
import { EmailController } from './email.controller';
import { EmailPublicController } from './email-public.controller';
import { ProjectActivityModule } from '../project-activity/project-activity.module';
import { EmailConfirmationSendEntity } from './entities/email-confirmation-send.entity';

/**
 * The email channel, on top of the shared campaign machinery.
 *
 * Imports push-notifications rather than the other way round: the campaign
 * row, its state transitions and credential storage live there and are
 * shared, while everything here is specific to email. The scheduler and
 * worker import this module to reach the email audience and delivery.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EmailSettingsEntity,
      EmailConfirmationSendEntity,
      DeviceIdentityEntity,
      PushNotificationLogEntity,
      PushNotificationEventEntity,
      PushConfigEntity,
    ]),
    BullModule.registerQueue({ name: QUEUE_PUSH_CAMPAIGN }),
    PushNotificationsModule,
    ProjectActivityModule,
    ProjectSuspensionModule,
    ConsentModule,
  ],
  controllers: [EmailController, EmailPublicController],
  providers: [
    SesProvider,
    ResendProvider,
    BrevoProvider,
    EmailProviderRegistry,
    EmailSettingsService,
    EmailAudienceService,
    EmailCampaignsService,
    EmailDeliveryService,
    EmailEventsService,
    EmailUnsubscribeService,
    EmailConfirmationsService,
  ],
  exports: [
    EmailConfirmationsService,
    EmailAudienceService,
    EmailCampaignsService,
    EmailDeliveryService,
    EmailSettingsService,
  ],
})
export class EmailModule {}

import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MixpanelConfigEntity } from './entities/mixpanel-config.entity';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { PushTokenEntity } from '../push-tokens/entities/push-token.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { PushNotificationsModule } from '../push-notifications/push-notifications.module';
import { InAppMessagesModule } from '../in-app-messages/in-app-messages.module';
import { IdentityModule } from '../identity/identity.module';
import { MixpanelCohortsController } from './mixpanel-cohorts.controller';
import { MixpanelCohortsService } from './mixpanel-cohorts.service';
import { MixpanelCohortSyncService } from './mixpanel-cohort-sync.service';
import { MixpanelCampaignService } from './mixpanel-campaign.service';
import { MixpanelApiService } from './mixpanel-api.service';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MixpanelConfigEntity,
      MixpanelCohortEntity,
      MixpanelCohortMemberEntity,
      DeviceIdentityEntity,
      PushTokenEntity,
      PushConfigEntity,
    ]),
    PushNotificationsModule,
    ProjectActivityModule,
    InAppMessagesModule,
    IdentityModule,
  ],
  controllers: [MixpanelCohortsController],
  providers: [MixpanelCohortsService, MixpanelCohortSyncService, MixpanelCampaignService, MixpanelApiService],
  exports: [MixpanelCohortsService, MixpanelCampaignService, MixpanelCohortSyncService],
})
export class MixpanelCohortsModule {}

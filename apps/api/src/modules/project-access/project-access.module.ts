import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectMemberEntity } from './entities/project-member.entity';
import { ProjectInvitationEntity } from './entities/project-invitation.entity';
import { InvitationEmailSendEntity } from './entities/invitation-email-send.entity';
import { LinkEntity } from '../links/entities/link.entity';
import { BannerCategoryEntity } from '../in-app-banners/entities/banner-category.entity';
import { InAppBannerEntity } from '../in-app-banners/entities/in-app-banner.entity';
import { ProjectAccessService } from './project-access.service';
import { ProjectAccessGuard } from './project-access.guard';
import { SeatsService } from './seats.service';
import { ProjectMembersService } from './project-members.service';
import { BillingTransferService } from './billing-transfer.service';
import { ProjectMembersController } from './project-members.controller';
import { InvitationsService } from './invitations.service';
import { InvitationsController } from './invitations.controller';
import { InvitationAcceptController } from './invitation-accept.controller';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

/**
 * Global, so any feature module's controller can use `@RequireProjectPermission`
 * without importing this. It takes the entities it reads directly (never their feature
 * modules), so it imports nothing that could import it back. It also serves the
 * member, billing-transfer and invitation routes; only the customer app imports it.
 */
@Global()
@Module({
  imports: [
    SecurityAlertsModule,
    TypeOrmModule.forFeature([
      ProjectMemberEntity,
      ProjectInvitationEntity,
      InvitationEmailSendEntity,
      LinkEntity,
      BannerCategoryEntity,
      InAppBannerEntity,
    ]),
    PlatformEmailModule,
    ProjectActivityModule,
  ],
  controllers: [ProjectMembersController, InvitationsController, InvitationAcceptController],
  providers: [
    ProjectAccessService,
    ProjectAccessGuard,
    SeatsService,
    ProjectMembersService,
    BillingTransferService,
    InvitationsService,
  ],
  exports: [TypeOrmModule, ProjectAccessService, ProjectAccessGuard, SeatsService],
})
export class ProjectAccessModule {}

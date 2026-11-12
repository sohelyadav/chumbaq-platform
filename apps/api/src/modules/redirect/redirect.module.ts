import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LinkEntity } from '../links/entities/link.entity';
import { ProjectEntity } from '../projects/entities/project.entity';
import { ClickEventEntity } from '../analytics/entities/click-event.entity';
import { RedirectController } from './redirect.controller';
import { RedirectService } from './redirect.service';
import { PlatformDetectorService } from './platform-detector.service';
import { DeferredMatchService } from './deferred-match.service';
import { DeferredMatchController } from './deferred-match.controller';
import { LinksModule } from '../links/links.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { TouchpointsModule } from '../touchpoints/touchpoints.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ProjectSuspensionModule } from '../projects/project-suspension.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([LinkEntity, ProjectEntity, ClickEventEntity]),
    LinksModule,
    AnalyticsModule,
    TouchpointsModule,
    ApiKeysModule,
    ProjectSuspensionModule,
    ConsentModule,
  ],
  controllers: [DeferredMatchController, RedirectController],
  providers: [RedirectService, PlatformDetectorService, DeferredMatchService],
  exports: [RedirectService, PlatformDetectorService, DeferredMatchService],
})
export class RedirectModule {}

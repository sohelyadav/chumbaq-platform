import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BannerCategoryEntity } from './entities/banner-category.entity';
import { InAppBannerEntity } from './entities/in-app-banner.entity';
import { WidgetEventEntity } from './entities/widget-event.entity';
import { BannerCategoriesService } from './banner-categories.service';
import { BannerCategoriesController } from './banner-categories.controller';
import { InAppBannersService } from './in-app-banners.service';
import { InAppBannersController } from './in-app-banners.controller';
import { WidgetAnalyticsService } from './widget-analytics.service';
import { WidgetAnalyticsController } from './widget-analytics.controller';
import { ProjectSuspensionModule } from '../projects/project-suspension.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BannerCategoryEntity, InAppBannerEntity, WidgetEventEntity]),
    ProjectSuspensionModule,
    ApiKeysModule,
    ProjectActivityModule,
  ],
  controllers: [BannerCategoriesController, InAppBannersController, WidgetAnalyticsController],
  providers: [BannerCategoriesService, InAppBannersService, WidgetAnalyticsService],
  exports: [BannerCategoriesService, InAppBannersService, WidgetAnalyticsService],
})
export class InAppBannersModule {}

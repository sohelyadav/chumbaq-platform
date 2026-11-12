import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClickEventEntity } from './entities/click-event.entity';
import { ConversionEventEntity } from '../conversions/entities/conversion-event.entity';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { LinksModule } from '../links/links.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [
    SecurityAlertsModule,
    TypeOrmModule.forFeature([ClickEventEntity, ConversionEventEntity]),
    LinksModule,
    WebhooksModule,
    ConsentModule,
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}

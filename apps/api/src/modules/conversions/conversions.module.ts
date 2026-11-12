import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversionEventEntity } from './entities/conversion-event.entity';
import { ClickEventEntity } from '../analytics/entities/click-event.entity';
import { ConversionsService } from './conversions.service';
import { ConversionsController } from './conversions.controller';
import { LinksModule } from '../links/links.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AttributionModule } from '../attribution/attribution.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ConversionEventEntity, ClickEventEntity]),
    LinksModule,
    WebhooksModule,
    AttributionModule,
    ApiKeysModule,
    ConsentModule,
  ],
  controllers: [ConversionsController],
  providers: [ConversionsService],
  exports: [ConversionsService],
})
export class ConversionsModule {}

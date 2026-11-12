import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttributionResultEntity } from './entities/attribution-result.entity';
import { AttributionService } from './attribution.service';
import { AttributionController } from './attribution.controller';
import { TouchpointsModule } from '../touchpoints/touchpoints.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AttributionResultEntity]),
    TouchpointsModule,
  ],
  controllers: [AttributionController],
  providers: [AttributionService],
  exports: [AttributionService],
})
export class AttributionModule {}

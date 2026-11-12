import { SegmentEntity } from '../segments/entities/segment.entity';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JourneyEntity } from './entities/journey.entity';
import { JourneyRunEntity } from './entities/journey-run.entity';
import { JourneysService } from './journeys.service';
import { JourneysController } from './journeys.controller';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([JourneyEntity, JourneyRunEntity, SegmentEntity]),
    ProjectActivityModule,
  ],
  controllers: [JourneysController],
  providers: [JourneysService],
  exports: [JourneysService],
})
export class JourneysModule {}

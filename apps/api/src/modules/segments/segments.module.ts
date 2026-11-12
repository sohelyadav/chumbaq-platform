import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SegmentEntity } from './entities/segment.entity';
import { SegmentMemberEntity } from './entities/segment-member.entity';
import { SegmentsService } from './segments.service';
import { SegmentsController } from './segments.controller';
import { SegmentCompilerService } from './segment-compiler.service';
import { SegmentEvaluationService } from './segment-evaluation.service';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SegmentEntity, SegmentMemberEntity]),
    ProjectActivityModule,
  ],
  controllers: [SegmentsController],
  providers: [SegmentsService, SegmentCompilerService, SegmentEvaluationService],
  // Tasks 7, 8 and 9 consume these. Phase 0's first wiring defect was a
  // provider used outside its module but never exported.
  exports: [SegmentsService, SegmentEvaluationService, SegmentCompilerService],
})
export class SegmentsModule {}

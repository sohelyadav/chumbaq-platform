import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectEntity } from './entities/project.entity';
import { ProjectSuspensionService } from './project-suspension.service';

/**
 * Imported by both the API's modules and the worker's ProcessorsModule. Holds no
 * controller, so it is safe in either process tree.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProjectEntity])],
  providers: [ProjectSuspensionService],
  exports: [ProjectSuspensionService],
})
export class ProjectSuspensionModule {}

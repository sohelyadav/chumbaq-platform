import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectActivityEntity } from './entities/project-activity.entity';
import { ProjectActivityService } from './project-activity.service';

/**
 * The activity log's writer, and nothing else. It declares no controllers, so the
 * impersonation module can import it into both API processes; the customer routes live
 * in a separate module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProjectActivityEntity])],
  providers: [ProjectActivityService],
  exports: [ProjectActivityService],
})
export class ProjectActivityModule {}

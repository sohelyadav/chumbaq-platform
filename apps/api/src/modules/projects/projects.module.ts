import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectEntity } from './entities/project.entity';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { ProjectActivityModule } from '../project-activity/project-activity.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { ProjectDomainsService } from './project-domains.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProjectEntity]), ProjectActivityModule, BillingCoreModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectDomainsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}

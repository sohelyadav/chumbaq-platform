import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { Module } from '@nestjs/common';
import { ProjectActivityController } from './project-activity.controller';
import { ProjectActivityModule } from './project-activity.module';
import { ACTIVITY_EXPORT_CAP, ACTIVITY_EXPORT_ROW_CAP, ProjectActivityQueryService } from './project-activity-query.service';

/**
 * The customer routes for the activity log. Kept apart from `ProjectActivityModule`
 * (the writer), which must stay controller-free so the admin API can import it.
 */
@Module({
  imports: [
    SecurityAlertsModule,ProjectActivityModule],
  controllers: [ProjectActivityController],
  providers: [ProjectActivityQueryService, { provide: ACTIVITY_EXPORT_CAP, useValue: ACTIVITY_EXPORT_ROW_CAP }],
})
export class ProjectActivityApiModule {}

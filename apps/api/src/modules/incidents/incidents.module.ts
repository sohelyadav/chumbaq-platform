import { Module } from '@nestjs/common';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { IncidentRemindersScheduler } from './incident-reminders.scheduler';
import { IncidentsService } from './incidents.service';

/** No controllers (the admin module declares `IncidentsController`), so the worker may import it. */
@Module({
  imports: [PlatformEmailModule, SecurityAlertsModule],
  providers: [IncidentsService, IncidentRemindersScheduler],
  exports: [IncidentsService, IncidentRemindersScheduler],
})
export class IncidentsModule {}

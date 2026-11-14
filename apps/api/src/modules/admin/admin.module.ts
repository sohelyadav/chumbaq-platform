import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../users/entities/user.entity';
import { ProjectEntity } from '../projects/entities/project.entity';
import { LinkEntity } from '../links/entities/link.entity';
import { ClickEventEntity } from '../analytics/entities/click-event.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { ApiKeyEntity } from '../api-keys/entities/api-key.entity';
import { QueueModule } from '../../queue/queue.module';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { AuthCoreModule } from '../auth/auth-core.module';
import { ImpersonationModule } from '../impersonation/impersonation.module';
import { StaffAuthModule } from '../staff-auth/staff-auth.module';
import { SeatsService } from '../project-access/seats.service';
import { AdminAuditModule } from './admin-audit.module';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AdminAuditLogsService } from './admin-audit-logs.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminUsageController } from './admin-usage.controller';
import { AdminUsageService } from './admin-usage.service';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminImpersonationController } from './admin-impersonation.controller';
import { AdminInsightsController } from './admin-insights.controller';
import { AdminInsightsService } from './admin-insights.service';
import { AdminFactorResetsController } from './admin-factor-resets.controller';
import { FactorResetsModule } from '../factor-resets/factor-resets.module';
import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { InternalAlertsController } from '../security-alerts/internal-alerts.controller';
import { AdminTripwiresController } from './admin-tripwires.controller';
import { IncidentsModule } from '../incidents/incidents.module';
import { IncidentsController } from '../incidents/incidents.controller';

/**
 * Every /api/admin route. Imported only by `AdminAppModule` (the admin API), never by
 * the customer API. Everything it imports is controller-less, so it brings no customer
 * routes with it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      ProjectEntity,
      LinkEntity,
      ClickEventEntity,
      DeviceIdentityEntity,
      ApiKeyEntity,
    ]),
    // SecondFactorsService, for SuperAdminGuard.
    AuthCoreModule,
    AdminAuditModule,
    ImpersonationModule,
    // The staff guards' strategy. Its controllers are the staff sign-in routes, which
    // belong on this API anyway.
    StaffAuthModule,
    // Producer-side Queue instances only, for health counts. Workers exist only
    // where a @Processor is registered, which is ProcessorsModule in worker.ts.
    QueueModule,
    PlatformEmailModule,
    FactorResetsModule,
    SecurityAlertsModule,
    IncidentsModule,
  ],
  controllers: [
    // First: its `tenants/export` must be matched before `tenants/:id`, which would
    // otherwise take it and refuse "export" as a uuid.
    AdminUsageController,
    AdminTenantsController,
    AdminImpersonationController,
    AdminInsightsController,
    AdminAuditLogsController,
    AdminFactorResetsController,
    // Server scripts' alarms; localhost only (see the controller).
    InternalAlertsController,
    AdminTripwiresController,
    IncidentsController,
  ],
  providers: [
    SeatsService,
    AdminTenantsService,
    AdminInsightsService,
    AdminAuditLogsService,
    AdminUsageService,
  ],
})
export class AdminModule {}

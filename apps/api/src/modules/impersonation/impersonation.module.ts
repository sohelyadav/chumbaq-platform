import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAuditModule } from '../admin/admin-audit.module';
import { AuthCoreModule } from '../auth/auth-core.module';
import { ProjectActivityModule } from '../project-activity/project-activity.module';
import { UserEntity } from '../users/entities/user.entity';
import { ImpersonationHandoffEntity } from './entities/impersonation-handoff.entity';
import { ImpersonationHandoffsService } from './impersonation-handoffs.service';

/**
 * No controllers: the admin API mounts the create route (in `AdminModule`) and the
 * customer API the exchange route (in `AuthModule`), each in its own app.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ImpersonationHandoffEntity, UserEntity]),
    AuthCoreModule,
    AdminAuditModule,
    // Its writer only: it declares no controllers, so the admin API gains no routes.
    ProjectActivityModule,
  ],
  providers: [ImpersonationHandoffsService],
  exports: [ImpersonationHandoffsService],
})
export class ImpersonationModule {}

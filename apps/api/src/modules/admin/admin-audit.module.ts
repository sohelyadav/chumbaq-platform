import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditLogEntity } from './entities/admin-audit-log.entity';

/**
 * The append-only staff log, with no controllers, so both APIs can write it: the admin
 * API for what staff do, the customer API for a view-as being opened.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AdminAuditLogEntity])],
  providers: [AdminAuditService],
  exports: [AdminAuditService, TypeOrmModule],
})
export class AdminAuditModule {}

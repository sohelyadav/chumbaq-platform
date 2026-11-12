import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ProjectActivityModule } from '../project-activity/project-activity.module';
import { PrivacyRequestLogEntity } from './entities/privacy-request-log.entity';
import { ErasedSuppressionsModule } from './erased-suppressions.module';
import { PersonErasureService } from './person-erasure.service';
import { PersonExportService } from './person-export.service';
import { PersonPrivacyController } from './person-privacy.controller';
import { PrivacyApiController } from './privacy-api.controller';
import { PrivacyRequestsService } from './privacy-requests.service';

/**
 * Person erasure and export (DPDP). Design:
 * docs/superpowers/specs/2026-11-07-person-erasure-export.md.
 */
@Module({
  imports: [
    SecurityAlertsModule,
    TypeOrmModule.forFeature([PrivacyRequestLogEntity]),
    ErasedSuppressionsModule,
    ApiKeysModule,
    ProjectActivityModule,
  ],
  controllers: [PersonPrivacyController, PrivacyApiController],
  providers: [PersonErasureService, PersonExportService, PrivacyRequestsService],
  exports: [PersonErasureService, PersonExportService],
})
export class PrivacyModule {}

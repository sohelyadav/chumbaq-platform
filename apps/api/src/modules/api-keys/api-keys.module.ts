import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeyEntity } from './entities/api-key.entity';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ServerApiKeyGuard } from './guards/server-api-key.guard';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKeyEntity]), PlatformEmailModule, ProjectActivityModule, SecurityAlertsModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyGuard, ServerApiKeyGuard],
  // SecurityAlertsModule too: modules using the guards build them in their own context,
  // and the guards need TripwiresService.
  exports: [ApiKeysService, ApiKeyGuard, ServerApiKeyGuard, SecurityAlertsModule],
})
export class ApiKeysModule {}

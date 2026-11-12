import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceIdentityEntity } from './entities/device-identity.entity';
import { IdentityAliasEntity } from './entities/identity-alias.entity';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ConsentModule } from '../consent/consent.module';
import { ErasedSuppressionsModule } from '../privacy/erased-suppressions.module';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeviceIdentityEntity, IdentityAliasEntity]),
    ApiKeysModule,
    ConsentModule,
    ErasedSuppressionsModule,
    ProjectActivityModule,
  ],
  controllers: [IdentityController],
  providers: [IdentityService],
  // Re-exported: whoever resolves identities usually needs to ask about consent too.
  exports: [IdentityService, ConsentModule],
})
export class IdentityModule {}

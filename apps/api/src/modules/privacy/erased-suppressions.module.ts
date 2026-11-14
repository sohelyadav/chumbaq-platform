import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ErasedSuppressionEntity } from './entities/erased-suppression.entity';
import { ErasedAddressEntity } from './entities/erased-address.entity';
import { ErasedSuppressionsService } from './erased-suppressions.service';
import { PrivacyHashService } from './privacy-hash.service';

/**
 * The hashed suppressions an erasure leaves behind and the hashing itself.
 * Separate from `PrivacyModule` so `IdentityModule` (which calls `restore` on
 * identify, in the API and the worker) does not pull in the privacy routes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ErasedSuppressionEntity, ErasedAddressEntity])],
  providers: [CredentialsCryptoService, PrivacyHashService, ErasedSuppressionsService],
  exports: [PrivacyHashService, ErasedSuppressionsService],
})
export class ErasedSuppressionsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthEventsModule } from '../auth-events/auth-events.module';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { FactorResetEntity } from './entities/factor-reset.entity';
import { FactorResetsService } from './factor-resets.service';

/**
 * Apart from AuthModule and AdminModule, which both use it, and with no controllers,
 * so the worker can import it for the scheduler without pulling in either.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FactorResetEntity]), AuthEventsModule, PlatformEmailModule],
  providers: [FactorResetsService],
  exports: [FactorResetsService],
})
export class FactorResetsModule {}

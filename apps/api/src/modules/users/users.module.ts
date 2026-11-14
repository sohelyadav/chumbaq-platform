import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { AuthEventsModule } from '../auth-events/auth-events.module';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { UsersCoreModule } from './users-core.module';
import { FactorResetsModule } from '../factor-resets/factor-resets.module';
import { AuthCoreModule } from '../auth/auth-core.module';

/** The customer API's users module: `UsersCoreModule` plus its routes. */
@Module({
  imports: [UsersCoreModule, AuthEventsModule, PlatformEmailModule, FactorResetsModule, AuthCoreModule],
  controllers: [UsersController],
  exports: [UsersCoreModule],
})
export class UsersModule {}

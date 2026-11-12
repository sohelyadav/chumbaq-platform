import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AccountSessionsController } from './account-sessions.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PasskeysController } from './passkeys.controller';
import { TotpController } from './totp.controller';
import { FactorResetController } from './factor-reset.controller';
import { StaffResetLinkController } from './staff-reset-link.controller';
import { AuthCoreModule } from './auth-core.module';
import { ImpersonationModule } from '../impersonation/impersonation.module';
import { ImpersonationExchangeController } from '../impersonation/impersonation-exchange.controller';

/**
 * The customer API's sign-in: `AuthCoreModule` plus its routes and the customer
 * `JwtStrategy`. Never imported by the admin API.
 */
@Module({
  imports: [
    SecurityAlertsModule,AuthCoreModule, ImpersonationModule, PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [
    AuthController,
    AccountSessionsController,
    PasskeysController,
    TotpController,
    FactorResetController,
    StaffResetLinkController,
    ImpersonationExchangeController,
  ],
  providers: [JwtStrategy],
  exports: [AuthCoreModule],
})
export class AuthModule {}

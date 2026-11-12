import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { UsersCoreModule } from '../users/users-core.module';
import { AuthEventsModule } from '../auth-events/auth-events.module';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { SessionsService } from './sessions.service';
import { AccountTokenEntity } from './entities/account-token.entity';
import { AccountTokensService } from './account-tokens.service';
import { AccountRecoveryService } from './account-recovery.service';
import { WebauthnCredentialEntity } from './entities/webauthn-credential.entity';
import { AuthCookiesService } from './auth-cookies.service';
import { PasskeysService } from './passkeys.service';
import { FactorChangeProofService } from './factor-change-proof.service';
import { PreAuthService } from './pre-auth.service';
import { SecondFactorsService } from './second-factors.service';
import { TotpSecretEntity } from './entities/totp-secret.entity';
import { RecoveryCodeEntity } from './entities/recovery-code.entity';
import { MfaCryptoService } from './mfa-crypto.service';
import { RecoveryCodesService } from './recovery-codes.service';
import { TotpService } from './totp.service';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { FactorResetsModule } from '../factor-resets/factor-resets.module';
import { StaffSessionEntity } from './entities/staff-session.entity';
import { StaffEnrolmentAllowanceEntity } from './entities/staff-enrolment-allowance.entity';
import { StaffSessionsService } from './staff-sessions.service';
import { StaffTokensService } from './staff-tokens.service';

const SERVICES = [
  AuthService,
  SessionsService,
  AccountTokensService,
  AccountRecoveryService,
  PreAuthService,
  FactorChangeProofService,
  SecondFactorsService,
  PasskeysService,
  MfaCryptoService,
  RecoveryCodesService,
  TotpService,
  AuthCookiesService,
  StaffSessionsService,
  StaffTokensService,
];

/**
 * Sign-in, sessions and factors with no controllers and no passport strategy, shared by
 * both APIs. Each app adds its own routes and its own strategy on top: `AuthModule`
 * (customer, `JwtStrategy`) and `StaffAuthModule` (admin, `StaffJwtStrategy`). A module
 * the admin API imports must not declare customer controllers, since Nest serves every
 * imported module's routes.
 */
@Module({
  imports: [
    SecurityAlertsModule,
    UsersCoreModule,
    AuthEventsModule,
    PlatformEmailModule,
    FactorResetsModule,
    TypeOrmModule.forFeature([
      AuthSessionEntity,
      AccountTokenEntity,
      WebauthnCredentialEntity,
      TotpSecretEntity,
      RecoveryCodeEntity,
      StaffSessionEntity,
      StaffEnrolmentAllowanceEntity,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret', 'default-dev-secret-change-me'),
        signOptions: {
          expiresIn: configService.get<string>('jwt.expiration', '15m'),
        },
      }),
    }),
  ],
  providers: SERVICES,
  exports: [...SERVICES, JwtModule, UsersCoreModule, AuthEventsModule, PlatformEmailModule, FactorResetsModule],
})
export class AuthCoreModule {}

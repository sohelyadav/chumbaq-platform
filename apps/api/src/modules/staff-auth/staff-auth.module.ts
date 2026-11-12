import { SecurityAlertsModule } from '../security-alerts/security-alerts.module';
import { StaffAlarmsService } from './staff-alarms.service';
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAuditModule } from '../admin/admin-audit.module';
import { AuthCoreModule } from '../auth/auth-core.module';
import { TotpSecretEntity } from '../auth/entities/totp-secret.entity';
import { WebauthnCredentialEntity } from '../auth/entities/webauthn-credential.entity';
import { StaffAuthController } from './staff-auth.controller';
import { StaffAuthService } from './staff-auth.service';
import { StaffCookiesService } from './staff-cookies.service';
import { StaffFactorsController } from './staff-factors.controller';
import { StaffFactorsService } from './staff-factors.service';
import { StaffJwtAuthGuard } from './staff-jwt-auth.guard';
import { StaffJwtStrategy } from './staff-jwt.strategy';
import { StaffPasskeysService } from './staff-passkeys.service';
import { StaffRecentAuthGuard } from './staff-recent-auth.guard';

/**
 * The admin API's sign-in. Imported only by `AdminAppModule`: it registers the
 * 'staff-jwt' strategy, and the customer API must never have one.
 */
@Module({
  imports: [
    AuthCoreModule,
    AdminAuditModule,
    PassportModule,
    TypeOrmModule.forFeature([WebauthnCredentialEntity, TotpSecretEntity]),
    SecurityAlertsModule,
  ],
  controllers: [StaffAuthController, StaffFactorsController],
  providers: [
    StaffJwtStrategy,
    StaffAuthService,
    StaffPasskeysService,
    StaffFactorsService,
    StaffCookiesService,
    StaffJwtAuthGuard,
    StaffRecentAuthGuard,
    StaffAlarmsService,
  ],
  exports: [StaffJwtAuthGuard, StaffRecentAuthGuard],
})
export class StaffAuthModule {}

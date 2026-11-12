import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SecurityAlertsModule } from './modules/security-alerts/security-alerts.module';
import { ReadVolumeInterceptor } from './modules/security-alerts/read-volume.interceptor';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ProjectAccessModule } from './modules/project-access/project-access.module';
import { LinksModule } from './modules/links/links.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ConversionsModule } from './modules/conversions/conversions.module';
import { TeamsModule } from './modules/teams/teams.module';
import { RedirectModule } from './modules/redirect/redirect.module';
import { HealthModule } from './modules/health/health.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

import { EmailLinksModule } from './modules/email-links/email-links.module';
import { IdentityModule } from './modules/identity/identity.module';
import { InAppBannersModule } from './modules/in-app-banners/in-app-banners.module';
import { PushTokensModule } from './modules/push-tokens/push-tokens.module';
import { PushNotificationsModule } from './modules/push-notifications/push-notifications.module';
import { EventsModule } from './modules/events/events.module';
import { PeopleModule } from './modules/people/people.module';
import { TouchpointsModule } from './modules/touchpoints/touchpoints.module';
import { AttributionModule } from './modules/attribution/attribution.module';
import { MixpanelCohortsModule } from './modules/mixpanel-cohorts/mixpanel-cohorts.module';
import { InAppMessagesModule } from './modules/in-app-messages/in-app-messages.module';
import { SegmentsModule } from './modules/segments/segments.module';
import { JourneysModule } from './modules/journeys/journeys.module';
import { EmailModule } from './modules/email/email.module';
import { SmsModule } from './modules/sms/sms.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { ProjectActivityModule } from './modules/project-activity/project-activity.module';
import { ProjectActivityApiModule } from './modules/project-activity/project-activity-api.module';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import appConfig from './config/app.config';
import redisConfig from './config/redis.config';
import webauthnConfig from './config/webauthn.config';
import mfaConfig from './config/mfa.config';
import projectsConfig from './config/projects.config';
import staffConfig from './config/staff.config';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    SecurityAlertsModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
      // staffConfig: JwtStrategy ends a view-as whose staff session is past its end.
      load: [databaseConfig, jwtConfig, appConfig, redisConfig, webauthnConfig, mfaConfig, projectsConfig, staffConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const nodeEnv = configService.get<string>('app.nodeEnv');
        // synchronize only in dev/test — never in staging or production. Use
        // real migrations everywhere else.
        const allowSynchronize = nodeEnv === 'development' || nodeEnv === 'test';
        return {
          type: 'postgres' as const,
          host: configService.get<string>('database.host'),
          port: configService.get<number>('database.port'),
          username: configService.get<string>('database.username'),
          password: configService.get<string>('database.password'),
          database: configService.get<string>('database.name'),
          autoLoadEntities: true,
          synchronize: allowSynchronize,
          migrations: [__dirname + '/migrations/*{.ts,.js}'],
          // Dev and test build the schema with synchronize; every other
          // environment applies migrations at boot instead. The API owns this —
          // the worker never runs migrations (see worker.module.ts).
          migrationsRun: !allowSynchronize,
          logging: nodeEnv === 'development',
        };
      },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    QueueModule,
    UsersModule,
    AuthModule,
    ProjectsModule,
    ProjectAccessModule,
    LinksModule,
    AnalyticsModule,
    ConversionsModule,
    TeamsModule,
    ApiKeysModule,
    WebhooksModule,
    EmailLinksModule,
    IdentityModule,
    InAppBannersModule,
    PushTokensModule,
    PushNotificationsModule,
    EventsModule,
    PeopleModule,
    TouchpointsModule,
    AttributionModule,
    MixpanelCohortsModule,
    InAppMessagesModule,
    SegmentsModule,
    JourneysModule,
    EmailModule,
    SmsModule,
    WhatsAppModule,
    PrivacyModule,
    ProjectActivityModule,
    ProjectActivityApiModule,
    // GET /api/health: the deploy scripts wait on it after each (re)start.
    HealthModule,
    // RedirectModule must be last so /:shortCode doesn't intercept /api/* routes
    RedirectModule,
  ],
  providers: [
    // Global rate limiting (uses ThrottlerModule.forRoot config above).
    // Without this binding, the ThrottlerModule was registered but never
    // enforced — login/register/SDK ingestion was wide open.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Counts dashboard reads for the `data.unusual_reads` alarm.
    { provide: APP_INTERCEPTOR, useExisting: ReadVolumeInterceptor },
  ],
})
export class AppModule {}

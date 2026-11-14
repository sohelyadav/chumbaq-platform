import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import appConfig from './config/app.config';
import redisConfig from './config/redis.config';
import webauthnConfig from './config/webauthn.config';
import mfaConfig from './config/mfa.config';
import projectsConfig from './config/projects.config';
import staffConfig from './config/staff.config';
import billingConfig from './config/billing.config';
import { QueueModule } from './queue/queue.module';
import { AdminModule } from './modules/admin/admin.module';
import { StaffAuthModule } from './modules/staff-auth/staff-auth.module';
import { HealthModule } from './modules/health/health.module';

/**
 * The admin API (`main-admin.ts`): /api/admin/*, /api/staff/auth/* and /api/health, and
 * nothing else. Same database and the same services as the customer API, through
 * controller-less core modules, because Nest serves the routes of every module an app
 * imports: nothing here may import a module that declares customer controllers.
 * `admin-app-routes.int-spec.ts` holds the route list.
 *
 * Like the worker, it does no DDL: entities by glob, no synchronize, no migrations. The
 * customer API owns the schema, so deploy it first.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
      load: [
        databaseConfig,
        jwtConfig,
        appConfig,
        redisConfig,
        webauthnConfig,
        mfaConfig,
        projectsConfig,
        staffConfig,
        billingConfig,
      ],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres' as const,
        host: configService.get<string>('database.host'),
        port: configService.get<number>('database.port'),
        username: configService.get<string>('database.username'),
        password: configService.get<string>('database.password'),
        database: configService.get<string>('database.name'),
        // A glob, as in worker.module.ts: relations cross module boundaries, and this
        // module tree is narrower than AppModule's.
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: false,
        migrationsRun: false,
        logging: false,
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    QueueModule,
    AdminModule,
    StaffAuthModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AdminAppModule {}

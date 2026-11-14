import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { QueueModule } from './queue/queue.module';
import { ProcessorsModule } from './queue/processors/processors.module';
import { ProjectAccessModule } from './modules/project-access/project-access.module';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import appConfig from './config/app.config';
import redisConfig from './config/redis.config';
import retentionConfig from './config/retention.config';
import staffConfig from './config/staff.config';
import billingConfig from './config/billing.config';
import projectsConfig from './config/projects.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
      // retentionConfig here only: the worker is what prunes, and it refuses to start
      // on a retention below the legal floor. staffConfig for how long staff sessions last.
      // projectsConfig and billingConfig: AccountLimitsService (through ProjectAccessModule)
      // reads the install's limit defaults and whether billing is on.
      load: [databaseConfig, jwtConfig, appConfig, redisConfig, retentionConfig, staffConfig, projectsConfig, billingConfig],
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
        // Explicit glob instead of autoLoadEntities: TypeORM relations span
        // module boundaries, and this process's module tree is deliberately
        // narrower than AppModule's — autoLoadEntities would only register
        // entities reachable from an imported module, so any entity a
        // relation points at outside that tree fails metadata build at boot.
        // A full glob gives the worker the same complete entity graph the
        // API has without requiring it to import every module that owns a
        // related entity.
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        // The API process owns schema management — both synchronize (dev) and
        // migrations (everywhere else). Two processes doing DDL concurrently
        // race, so the worker does neither and assumes the schema already
        // exists. Deploy ordering matters: migrate before starting the worker.
        synchronize: false,
        logging: false,
      }),
    }),
    ScheduleModule.forRoot(),
    QueueModule,
    // Global in the API, where controllers' @RequireProjectPermission guard needs it. The
    // worker serves no routes, but feature modules it loads (push → touchpoints) declare
    // controllers, and Nest resolves their guards at boot: without this the worker dies.
    ProjectAccessModule,
    ProcessorsModule,
  ],
})
export class WorkerModule {}

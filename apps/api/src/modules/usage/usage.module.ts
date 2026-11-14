import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageDailyEntity } from './entities/usage-daily.entity';
import { MonthlyActiveDeviceEntity } from './entities/monthly-active-device.entity';
import { UsageRollupStateEntity } from './entities/usage-rollup-state.entity';
import { UsageRollupService } from './usage-rollup.service';

/**
 * Daily usage counts per project. No controllers: the worker fills the tables
 * and the admin API reads them, so both apps can import this module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UsageDailyEntity, MonthlyActiveDeviceEntity, UsageRollupStateEntity]),
  ],
  providers: [UsageRollupService],
  exports: [TypeOrmModule, UsageRollupService],
})
export class UsageModule {}

import { Module } from '@nestjs/common';
import { PlatformEmailModule } from '../platform-email/platform-email.module';
import { SecurityAlertsService } from './security-alerts.service';
import { VolumeWatchService } from './volume-watch.service';
import { ReadVolumeInterceptor } from './read-volume.interceptor';
import { TripwiresService } from './tripwires.service';

/** No controllers: safe to import into the customer API, the admin API and the worker. */
@Module({
  imports: [PlatformEmailModule],
  providers: [SecurityAlertsService, VolumeWatchService, ReadVolumeInterceptor, TripwiresService],
  exports: [SecurityAlertsService, VolumeWatchService, ReadVolumeInterceptor, TripwiresService],
})
export class SecurityAlertsModule {}

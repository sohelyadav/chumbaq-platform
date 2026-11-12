import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConsentEventEntity } from './entities/consent-event.entity';
import { TrackingObjectionEntity } from './entities/tracking-objection.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { ConsentEventsService } from './consent-events.service';
import { TrackingConsentService } from './tracking-consent.service';
import { PersonObjectionsService } from './person-objections.service';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

/**
 * Consent history (`consent_events`) and do-not-track decisions.
 *
 * Depends on nothing but its own tables, `device_identities` and the activity log's writer, so any module
 * can import it without a cycle: identity, events, push, the addressed channels, in-app messages.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ConsentEventEntity, TrackingObjectionEntity, DeviceIdentityEntity]),
    // The activity log's writer only: it imports nothing back, so no cycle.
    ProjectActivityModule,
  ],
  providers: [ConsentEventsService, TrackingConsentService, PersonObjectionsService],
  exports: [ConsentEventsService, TrackingConsentService, PersonObjectionsService],
})
export class ConsentModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { UserEventEntity } from '../events/entities/user-event.entity';
import { PeopleService } from './people.service';
import { PeopleController } from './people.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeviceIdentityEntity, UserEventEntity]),
  ],
  controllers: [PeopleController],
  providers: [PeopleService],
  exports: [PeopleService],
})
export class PeopleModule {}

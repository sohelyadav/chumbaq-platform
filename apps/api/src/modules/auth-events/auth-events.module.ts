import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthEventEntity } from './entities/auth-event.entity';
import { AuthEventsService } from './auth-events.service';

/** Separate from AuthModule because UsersModule and TeamsModule record events too. */
@Module({
  imports: [TypeOrmModule.forFeature([AuthEventEntity])],
  providers: [AuthEventsService],
  exports: [AuthEventsService],
})
export class AuthEventsModule {}

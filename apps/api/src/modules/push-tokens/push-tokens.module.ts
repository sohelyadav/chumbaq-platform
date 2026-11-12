import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PushTokenEntity } from './entities/push-token.entity';
import { PushTokensService } from './push-tokens.service';
import { PushTokensController } from './push-tokens.controller';
import { IdentityModule } from '../identity/identity.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ChannelsModule } from '../push-notifications/channels.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PushTokenEntity]),
    IdentityModule,
    ApiKeysModule,
    ChannelsModule,
  ],
  controllers: [PushTokensController],
  providers: [PushTokensService],
  exports: [PushTokensService],
})
export class PushTokensModule {}

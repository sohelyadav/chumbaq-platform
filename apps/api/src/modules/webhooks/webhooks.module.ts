import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookEntity } from './entities/webhook.entity';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { ProjectSuspensionModule } from '../projects/project-suspension.module';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ProjectActivityModule } from '../project-activity/project-activity.module';

@Module({
  imports: [TypeOrmModule.forFeature([WebhookEntity]), ProjectSuspensionModule, ProjectActivityModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, CredentialsCryptoService],
  exports: [WebhooksService],
})
export class WebhooksModule {}

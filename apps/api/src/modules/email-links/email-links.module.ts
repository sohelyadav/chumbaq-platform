import { Module } from '@nestjs/common';
import { EmailLinksService } from './email-links.service';
import { EmailLinksController } from './email-links.controller';
import { LinksModule } from '../links/links.module';

@Module({
  imports: [LinksModule],
  controllers: [EmailLinksController],
  providers: [EmailLinksService],
  exports: [EmailLinksService],
})
export class EmailLinksModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LinkEntity } from './entities/link.entity';
import { LinkVariantEntity } from './entities/link-variant.entity';
import { ReleasedShortCodeEntity } from './entities/released-short-code.entity';
import { LinksService } from './links.service';
import { LinksController } from './links.controller';
import { ProjectActivityModule } from '../project-activity/project-activity.module';
import { QrCodeService } from './qr-code.service';
import { BulkLinkService } from './bulk-link.service';
import { LinkVariantsService } from './link-variants.service';

@Module({
  imports: [TypeOrmModule.forFeature([LinkEntity, LinkVariantEntity, ReleasedShortCodeEntity]), ProjectActivityModule],
  controllers: [LinksController],
  providers: [LinksService, QrCodeService, BulkLinkService, LinkVariantsService],
  exports: [LinksService, LinkVariantsService],
})
export class LinksModule {}

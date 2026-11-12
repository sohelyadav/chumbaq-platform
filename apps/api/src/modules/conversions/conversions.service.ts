import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConversionEventEntity } from './entities/conversion-event.entity';
import { ClickEventEntity } from '../analytics/entities/click-event.entity';
import { LinksService } from '../links/links.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AttributionService } from '../attribution/attribution.service';
import { CreateConversionDto } from './dto/create-conversion.dto';
import { TrackingConsentService } from '../consent/tracking-consent.service';

@Injectable()
export class ConversionsService {
  private readonly logger = new Logger(ConversionsService.name);

  constructor(
    @InjectRepository(ConversionEventEntity)
    private readonly conversionRepository: Repository<ConversionEventEntity>,
    @InjectRepository(ClickEventEntity)
    private readonly clickEventRepository: Repository<ClickEventEntity>,
    private readonly linksService: LinksService,
    private readonly trackingConsent: TrackingConsentService,
    @Optional() @Inject(WebhooksService) private readonly webhooksService?: WebhooksService,
    @Optional() @Inject(AttributionService) private readonly attributionService?: AttributionService,
  ) {}

  /**
   * Records a conversion, or returns null when the person named by
   * `externalUserId` is do-not-track: no row, no webhook, no attribution. A
   * conversion naming nobody is about no one and is recorded as before.
   */
  async trackConversion(
    dto: CreateConversionDto,
    expectedProjectId?: string,
  ): Promise<ConversionEventEntity | null> {
    if (!dto.shortCode && !dto.linkId) {
      throw new BadRequestException(
        'Either shortCode or linkId must be provided',
      );
    }

    let link;
    if (dto.linkId) {
      link = await this.linksService.findOne(dto.linkId);
    } else {
      link = await this.linksService.findByShortCode(dto.shortCode!);
    }

    // Enforce that the API key's project owns this link. Without this check,
    // anyone with any valid API key could record conversions for any link.
    if (expectedProjectId && link.projectId !== expectedProjectId) {
      throw new BadRequestException('Link does not belong to your project');
    }

    // After the link checks, so a bad link still answers as it always has.
    if (
      dto.externalUserId &&
      (await this.trackingConsent.isDoNotTrack({
        projectId: link.projectId,
        externalUserId: dto.externalUserId,
      }))
    ) {
      this.trackingConsent.recordDrop('conversion');
      return null;
    }

    // Find the most recent click event for attribution
    const clickEvent = await this.clickEventRepository.findOne({
      where: { linkId: link.id },
      order: { clickedAt: 'DESC' },
    });

    const conversion = this.conversionRepository.create({
      linkId: link.id,
      clickEventId: clickEvent?.id || null,
      eventType: dto.eventType,
      externalUserId: dto.externalUserId || null,
      metadata: dto.metadata || null,
    } as Partial<ConversionEventEntity>);

    const saved = await this.conversionRepository.save(conversion as ConversionEventEntity);

    // Fire webhook for conversion event
    if (this.webhooksService) {
      this.webhooksService.fireWebhook(link.projectId, 'conversion', {
        linkId: link.id,
        conversionId: saved.id,
        eventType: dto.eventType,
        externalUserId: dto.externalUserId,
      }).catch((err) => this.logger.warn(`Webhook fire failed: ${err}`));
    }

    // Run multi-touch attribution (fire-and-forget)
    if (this.attributionService && (saved.distinctId || dto.externalUserId)) {
      this.attributionService
        .attributeAllModels({
          projectId: link.projectId,
          conversionId: saved.id,
          distinctId: saved.distinctId || dto.externalUserId!,
          conversionTime: saved.convertedAt,
        })
        .catch((err) => this.logger.warn(`Attribution failed: ${err}`));
    }

    return saved;
  }
}

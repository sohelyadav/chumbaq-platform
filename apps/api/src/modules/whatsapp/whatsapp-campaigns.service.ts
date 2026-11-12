import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import {
  campaignEntry,
  heldOrSent,
  type ActivityRequester,
} from '../project-activity/messaging-activity';
import { saveCampaign } from '../push-notifications/save-campaign';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { PushNotificationsService } from '../push-notifications/push-notifications.service';
import { validateVariants, PushVariant } from '../push-notifications/variant-assignment';
import { validateRecurrence, nextOccurrence } from '../push-notifications/recurrence';
import {
  normalisePhone,
  PROVIDER_LABELS,
  WhatsAppContent,
  WhatsAppProviderName,
} from '../push-notifications/message-channel';
import { AddressAudienceScope } from '../push-notifications/services/address-audience';
import { reachProvider } from '../push-notifications/services/per-recipient-provider';
import {
  JOB_DISPATCH_CAMPAIGN,
  PushCampaignJobData,
  QUEUE_PUSH_CAMPAIGN,
} from '../../queue/queue.constants';
import { WhatsAppAudienceService } from './whatsapp-audience.service';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppProviderRegistry } from './whatsapp-provider.registry';
import { previewWhatsApp, renderWhatsApp } from './whatsapp-rendering';
import { WhatsAppTemplate } from './providers/whatsapp-provider';
import { findTemplate, templateProblem } from './whatsapp-templates';
import {
  SendWhatsAppCampaignDto,
  TestSendWhatsAppDto,
  WhatsAppAudiencePreviewDto,
  WhatsAppContentDto,
} from './dto/whatsapp.dto';

/** How long a project's template list is reused before asking the provider again. */
const TEMPLATE_CACHE_MS = 60_000;

/**
 * Creates WhatsApp campaigns — the SMS service's twin, with one addition:
 * the content is checked against the provider's own approved template
 * before anything is queued, because a template WhatsApp will refuse fails
 * every recipient.
 */
@Injectable()
export class WhatsAppCampaignsService {
  private readonly logger = new Logger(WhatsAppCampaignsService.name);
  private readonly templateCache = new Map<
    string,
    { at: number; provider: WhatsAppProviderName; templates: WhatsAppTemplate[] }
  >();

  constructor(
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    @InjectRepository(PushConfigEntity)
    private readonly policyRepository: Repository<PushConfigEntity>,
    @InjectQueue(QUEUE_PUSH_CAMPAIGN)
    private readonly queue: Queue<PushCampaignJobData>,
    private readonly settings: WhatsAppSettingsService,
    private readonly audience: WhatsAppAudienceService,
    private readonly push: PushNotificationsService,
    private readonly registry: WhatsAppProviderRegistry,
    private readonly activity: ProjectActivityService,
  ) {}

  /** The active provider's templates, and whether it can list them at all. */
  async templates(
    projectId: string,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<{ canList: boolean; templates: WhatsAppTemplate[] }> {
    const { settings, credentials } = await this.settings.requireSendable(projectId);
    const provider = this.registry.get(settings.provider);
    if (!provider.canListTemplates) return { canList: false, templates: [] };

    const cached = this.templateCache.get(projectId);
    if (
      !fresh &&
      cached &&
      cached.provider === settings.provider &&
      Date.now() - cached.at < TEMPLATE_CACHE_MS
    ) {
      return { canList: true, templates: cached.templates };
    }
    const templates = await reachProvider(PROVIDER_LABELS[settings.provider], () =>
      provider.listTemplates(credentials),
    );
    this.templateCache.set(projectId, { at: Date.now(), provider: settings.provider, templates });
    return { canList: true, templates };
  }

  /** Throws with a reason the composer can show when content cannot be sent. */
  private async checkContent(projectId: string, content: WhatsAppContent): Promise<void> {
    if (content.bodyParams.some((value) => !value.trim())) {
      throw new BadRequestException('Every template value needs something in it; WhatsApp refuses empty ones.');
    }
    const { canList, templates } = await this.templates(projectId, { fresh: true });
    if (!canList) return;
    const problem = templateProblem(content, findTemplate(templates, content.template));
    if (problem) throw new BadRequestException(problem);
  }

  private async resolveAudience(
    input: { projectId: string; segmentId?: string; deviceIdentityIds?: string[] },
    requireOptIn: boolean,
  ): Promise<{
    targetType: 'project' | 'devices' | 'segment';
    scope: AddressAudienceScope;
    recipients: number;
  }> {
    const policy = await this.policyRepository.findOne({ where: { projectId: input.projectId } });
    const cap = policy?.frequencyCapPerDay ?? null;

    let targetType: 'project' | 'devices' | 'segment' = 'project';
    let deviceIdentityIds: string[] | null = null;
    if (input.segmentId) {
      targetType = 'segment';
      deviceIdentityIds = await this.push.segmentDeviceIdentityIds(input.projectId, input.segmentId);
    } else if (input.deviceIdentityIds && input.deviceIdentityIds.length > 0) {
      targetType = 'devices';
      deviceIdentityIds = input.deviceIdentityIds;
    }

    const scope: AddressAudienceScope = { projectId: input.projectId, deviceIdentityIds, requireOptIn };
    return { targetType, scope, recipients: await this.audience.count(scope, cap) };
  }

  async previewAudience(dto: WhatsAppAudiencePreviewDto): Promise<{
    targetType: 'project' | 'devices' | 'segment';
    recipients: number;
    requireOptIn: boolean;
  }> {
    const settings = await this.settings.find(dto.projectId);
    const requireOptIn = settings?.requireOptIn ?? true;
    const { targetType, recipients } = await this.resolveAudience(dto, requireOptIn);
    return { targetType, recipients, requireOptIn };
  }

  /** How many people a journey's WhatsApp step to these identities would reach. */
  async countReachable(projectId: string, deviceIdentityIds: string[]): Promise<number> {
    if (deviceIdentityIds.length === 0) return 0;
    const settings = await this.settings.find(projectId);
    if (!settings?.provider) return 0;
    const { recipients } = await this.resolveAudience({ projectId, deviceIdentityIds }, settings.requireOptIn);
    return recipients;
  }

  /**
   * A dashboard request (`requester`) writes `campaign.sent` or `campaign.scheduled` in
   * the row's transaction; a journey step passes `null` and writes nothing.
   */
  async send(dto: SendWhatsAppCampaignDto, requester: ActivityRequester | null): Promise<PushNotificationLogEntity> {
    const { settings } = await this.settings.requireSendable(dto.projectId);
    const content = toContent(dto.content);
    await this.checkContent(dto.projectId, content);

    const variants: PushVariant[] | null =
      dto.variants && dto.variants.length > 0
        ? dto.variants.map((variant) => {
            const armContent = toContent(variant.content);
            return {
              key: variant.key,
              title: variant.title,
              body: describe(armContent),
              weight: variant.weight,
              whatsapp: armContent,
            };
          })
        : null;
    if (variants) {
      const problem = validateVariants(variants, dto.controlPercentage ?? 0);
      if (problem) throw new BadRequestException(problem);
      for (const variant of variants) await this.checkContent(dto.projectId, variant.whatsapp!);
    }

    const { targetType, scope, recipients } = await this.resolveAudience(dto, settings.requireOptIn);
    if (recipients === 0) {
      throw new BadRequestException(
        settings.requireOptIn
          ? 'Nobody in this audience can be messaged on WhatsApp. It needs a phone number with a ' +
              'country code and, because this project requires opt-in, whatsapp_opt_in set to true.'
          : 'Nobody in this audience has a phone number with a country code that has not opted out.',
      );
    }

    const isRecurring = !!dto.recurrence;
    if (isRecurring) {
      const problem = validateRecurrence(dto.recurrence!);
      if (problem) throw new BadRequestException(problem);
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    const sendTimeOptimised = dto.sendTimeOptimised === true;
    const deliverInRecipientTimezone = dto.deliverInRecipientTimezone === true || sendTimeOptimised;
    const isScheduled =
      deliverInRecipientTimezone ||
      !!variants ||
      isRecurring ||
      (scheduledAt !== null && scheduledAt.getTime() > Date.now());

    const log = await saveCampaign(
      this.logRepository,
      this.activity,
      this.logRepository.create({
        projectId: dto.projectId,
        channel: 'whatsapp',
        emailContent: null,
        whatsappContent: content,
        title: dto.name?.trim() || content.template.name,
        body: describe(content),
        data: undefined,
        targetType,
        targetDeviceIds: scope.deviceIdentityIds,
        segmentId: dto.segmentId ?? null,
        totalTokens: recipients,
        processedTokens: 0,
        successCount: 0,
        failureCount: 0,
        scheduledAt: isRecurring
          ? (nextOccurrence(dto.recurrence!, scheduledAt ?? new Date()) ?? new Date())
          : deliverInRecipientTimezone || variants
            ? (scheduledAt ?? new Date())
            : isScheduled
              ? scheduledAt
              : null,
        recurrence: isRecurring ? dto.recurrence! : null,
        variants,
        controlPercentage: variants ? (dto.controlPercentage ?? 0) : null,
        deliverInRecipientTimezone,
        sendTimeOptimised,
        localSendTime: deliverInRecipientTimezone ? (dto.localSendTime ?? '10:00') : null,
        status: isScheduled ? 'scheduled' : 'queued',
      } as Partial<PushNotificationLogEntity>) as PushNotificationLogEntity,
      requester && {
        requester,
        entry: (saved) => campaignEntry(saved, heldOrSent(saved)),
      },
    );

    if (isScheduled) {
      this.logger.log(`WhatsApp campaign ${log.id} held for ${log.scheduledAt?.toISOString()}`);
      return log;
    }
    await this.queue.add(
      JOB_DISPATCH_CAMPAIGN,
      { logId: log.id, projectId: dto.projectId },
      { jobId: log.id },
    );
    this.logger.log(`Queued WhatsApp campaign ${log.id} for ${recipients} recipient(s)`);
    return log;
  }

  /**
   * Sends the template to one number. Bypasses consent and suppression —
   * it is the marketer's own phone — but not the template check.
   */
  async testSend(dto: TestSendWhatsAppDto): Promise<{ delivered: boolean; error?: string }> {
    const to = normalisePhone(dto.to);
    if (!to) {
      throw new BadRequestException('Enter the number in international form, with its country code: +919876543210.');
    }
    const { settings, credentials } = await this.settings.requireSendable(dto.projectId);
    const content = toContent(dto.content);
    await this.checkContent(dto.projectId, content);

    const message = renderWhatsApp({ content, identity: null, campaignId: null, identityId: null });
    try {
      const result = await this.registry
        .get(settings.provider)
        .sendToRecipients(credentials, [{ token: to, message }]);
      if (result.successCount === 1) return { delivered: true };
      return {
        delivered: false,
        error: result.failures[0]?.error ?? result.retryReason ?? 'Unknown error',
      };
    } catch (error) {
      return { delivered: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}

function toContent(dto: WhatsAppContentDto): WhatsAppContent {
  return {
    template: {
      id: dto.template.id.trim(),
      name: dto.template.name.trim(),
      language: dto.template.language,
      category: dto.template.category ?? null,
      paramNames: dto.template.paramNames?.length ? dto.template.paramNames : null,
    },
    bodyParams: dto.bodyParams,
    headerText: dto.headerText?.trim() || null,
    headerMediaUrl: dto.headerMediaUrl?.trim() || null,
    headerMediaType: dto.headerMediaUrl ? (dto.headerMediaType ?? null) : null,
    buttonParams: dto.buttonParams ?? [],
    previewText: dto.previewText ?? null,
  };
}

/** What lists and reports show as the message: the approved text with its values, or the template's name. */
function describe(content: WhatsAppContent): string {
  return content.previewText
    ? previewWhatsApp(content.previewText, content.bodyParams)
    : `Template ${content.template.name} (${content.template.language})`;
}
